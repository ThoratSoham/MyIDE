import log from "electron-log";
import type {
  Lane,
  ProviderAdapter,
  ProviderId,
  ProviderOutcome,
  ProviderRequest,
  TaskClass,
} from "./types";
import { buildLanes, defaultLaneLimits, PROVIDER_CONFIGS } from "./providers";
import { Ledger, nextResetMs } from "./ledger";
import { Router, DEFAULT_CHAIN_ORDER, type SendResult } from "./router";
import { makeRealProviders, discoverLimitsFromHeaders } from "./real-providers";
import { makeOfflineProvider } from "./offline-provider";
import { getLimitOverrides, getProviderKey } from "../store";

// FR-3.5: if every lane is blocked we wait for the shortest REAL reset. If that
// is longer than 10 minutes we pause, save, and surface "Resume at HH:MM".
const PAUSE_THRESHOLD_MS = 10 * 60_000;
const MAX_WAIT_ROUNDS = 4;

export interface QuotaLaneView {
  laneId: string;
  provider: ProviderId;
  providerLabel: string;
  model: string;
  role: TaskClass;
  usedToday: number;
  limitToday: number | null;
  usedMinute: number;
  limitMinute: number | null;
  resetAt: string | null;
  status: "ok" | "limited" | "dead" | "offline";
}

export interface CompleteOptions {
  schema?: object;
  maxTokens?: number;
  expectedOutputTokens?: number;
}

export interface CompleteResult extends SendResult {
  pause?: boolean;
  resumeAtMs?: number;
}

export class AIService {
  lanes: Lane[] = [];
  private ledger = new Ledger();
  private adapters = new Map<ProviderId, ProviderAdapter>();
  private router!: Router;
  private retries = new Map<string, number>();
  private laneByProviderRole = new Map<string, Lane>();
  private realKeysPresent = false;
  onWaiting?: (info: { laneId: string; resumeAtMs: number } | null) => void;

  init(): void {
    this.lanes = buildLanes();

    // FR-2.4 / risk section: apply the user's editable limit overrides.
    const overrides = getLimitOverrides();
    for (const lane of this.lanes) {
      const o = overrides[lane.id];
      if (o) {
        const { laneId: _ignored, ...limits } = o;
        lane.limits = { ...lane.limits, ...limits };
      }
    }

    this.ledger.load(this.lanes);

    this.adapters = makeRealProviders();
    this.adapters.set("offline", makeOfflineProvider());

    this.realKeysPresent = (["gemini", "openrouter", "groq"] as ProviderId[]).some((p) =>
      !!getProviderKey(p as "gemini" | "openrouter" | "groq"),
    );

    this.laneByProviderRole.clear();
    for (const lane of this.lanes) {
      const key = `${lane.provider}:${lane.role}`;
      if (!this.laneByProviderRole.has(key)) this.laneByProviderRole.set(key, lane);
    }

    const chainOrder: Record<TaskClass, ProviderId[]> = {
      reasoning: [...DEFAULT_CHAIN_ORDER.reasoning],
      general: [...DEFAULT_CHAIN_ORDER.general],
      autocomplete: [...DEFAULT_CHAIN_ORDER.autocomplete],
    };
    if (!this.realKeysPresent) {
      for (const cls of Object.keys(chainOrder) as TaskClass[]) chainOrder[cls] = ["offline"];
      log.warn("ai: no provider keys configured; using the offline library lane");
    }

    this.router = new Router({
      chainOrder,
      getLane: (providerId, role) => this.laneByProviderRole.get(`${providerId}:${role}`),
      healthFor: (laneId) => {
        const lane = this.lanes.find((l) => l.id === laneId);
        return lane ? this.ledger.healthFor(lane) : undefined;
      },
      sendVia: (lane, req) => this.sendVia(lane, req),
      countRetries: (laneId) => this.retries.get(laneId) ?? 0,
      bumpRetries: (laneId) => this.retries.set(laneId, (this.retries.get(laneId) ?? 0) + 1),
      resetRetries: (laneId) => this.retries.set(laneId, 0),
      onOutcome: (lane, outcome, tokens) => this.applyOutcome(lane, outcome, tokens),
    });
  }

  private async sendVia(lane: Lane, req: ProviderRequest): Promise<ProviderOutcome> {
    const adapter = this.adapters.get(lane.provider);
    if (!adapter) return { ok: false, error: { kind: "unmapped", message: `no adapter for ${lane.provider}` } };
    return adapter.send(req);
  }

  // FR-2.3 / FR-2.4 / section 11: record every real send and react to errors.
  private applyOutcome(lane: Lane, outcome: ProviderOutcome, tokens: number): void {
    this.ledger.recordSend(lane, tokens);
    if (!outcome.ok) {
      const err = outcome.error;
      if (err.kind === "rateLimitDay") {
        this.ledger.markDayExhausted(lane, err.waitUntilMs);
      } else if (err.kind === "modelDead") {
        this.ledger.markDead(lane);
      }
      if (err.headers) {
        const learned = discoverLimitsFromHeaders(err.headers);
        if (learned) {
          lane.limits = { ...lane.limits, ...learned };
          log.info(`ai: learned limits for ${lane.id}:`, learned);
        }
      }
    }
    this.ledger.save();
  }

  isOfflineMode(): boolean {
    return !this.realKeysPresent;
  }

  // FR-2.1: usable models per provider, for the UI.
  providerLabels(): Record<ProviderId, string> {
    return Object.fromEntries(
      (Object.keys(PROVIDER_CONFIGS) as ProviderId[]).map((p) => [p, PROVIDER_CONFIGS[p].label]),
    ) as Record<ProviderId, string>;
  }

  async complete(
    taskClass: TaskClass,
    messages: ProviderRequest["messages"],
    options?: CompleteOptions,
  ): Promise<CompleteResult> {
    for (let round = 0; round <= MAX_WAIT_ROUNDS; round++) {
      const result = await this.router.send(taskClass, messages, options);
      if (result.ok) {
        this.onWaiting?.(null);
        return result;
      }

      // Every lane was blocked. Find the shortest real reset among our lanes.
      const waitMs = this.shortestResetMs();
      if (waitMs == null || waitMs > PAUSE_THRESHOLD_MS) {
        const resumeAtMs = waitMs == null ? undefined : Date.now() + waitMs;
        if (resumeAtMs) this.onWaiting?.({ laneId: "*", resumeAtMs });
        log.warn(`ai: pausing; resume at ${resumeAtMs ? new Date(resumeAtMs).toISOString() : "unknown"}`);
        return { ok: false, error: result.error, pause: true, resumeAtMs };
      }

      log.warn(`ai: all lanes blocked; waiting ${Math.round(waitMs / 1000)}s for the shortest reset`);
      this.onWaiting?.({ laneId: "*", resumeAtMs: Date.now() + waitMs });
      await sleep(Math.min(waitMs, PAUSE_THRESHOLD_MS) + 500);
      this.onWaiting?.(null);
    }

    return { ok: false, error: { kind: "unmapped", message: "all lanes blocked after waiting" }, pause: true };
  }

  private shortestResetMs(): number | null {
    const now = Date.now();
    let min: number | null = null;
    for (const lane of this.lanes) {
      if (lane.provider !== "offline" && !getProviderKey(lane.provider as "gemini" | "openrouter" | "groq")) continue;
      const h = this.ledger.healthFor(lane);
      for (const t of [h.removedUntil, h.deadUntil]) {
        if (t && t > now) {
          const d = t - now;
          if (min == null || d < min) min = d;
        }
      }
    }
    return min;
  }

  // FR-12.3 / FR-2.9: the quota panel reads this.
  quotaSnapshot(): QuotaLaneView[] {
    return this.lanes
      .filter((l) => l.provider !== "offline")
      .map((lane) => {
        const h = this.ledger.healthFor(lane);
        const used = this.ledger.requestsToday(lane);
        const rpd = Number.isFinite(lane.limits.rpd) ? lane.limits.rpd : null;
        let status: QuotaLaneView["status"] = "ok";
        if (h.deadUntil && h.deadUntil > Date.now()) status = "dead";
        else if (h.removedUntil && h.removedUntil > Date.now()) status = "limited";
        const resetMs = h.removedUntil && h.removedUntil > Date.now() ? h.removedUntil : nextResetMs(lane.limits.resetHourUtc);
        return {
          laneId: lane.id,
          provider: lane.provider,
          providerLabel: PROVIDER_CONFIGS[lane.provider].label,
          model: lane.model,
          role: lane.role,
          usedToday: used,
          limitToday: rpd,
          usedMinute: h.minuteTokenCount,
          limitMinute: lane.limits.tpm ?? null,
          resetAt: new Date(resetMs).toISOString().slice(11, 16) + " UTC",
          status,
        };
      });
  }

  save(): void {
    this.ledger.save();
  }

  reload(): void {
    this.init();
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export { defaultLaneLimits };
