import crypto from "crypto";
import log from "electron-log";
import type {
  DroppedModelInfo,
  LaneExhaustedDetail,
  ModelConfigEntry,
  ModelsStateView,
  ProviderKeyId,
} from "../../shared/electron-api-types";
import type {
  Lane,
  ProviderAdapter,
  ProviderId,
  ProviderOutcome,
  ProviderRequest,
  RouterLaneEvent,
  TaskClass,
} from "./types";
import { buildLanes, defaultLaneLimits, PROVIDER_CONFIGS } from "./providers";
import { Ledger, nextResetMs } from "./ledger";
import { Router, abortableSleep, formatLocalTime, type SendResult } from "./router";
import { makeRealProviders, discoverLimitsFromHeaders } from "./real-providers";
import { makeOfflineProvider } from "./offline-provider";
import {
  filterExistingModels,
  loadModelSettings,
  modelsFilePath,
   refreshLiveCatalogs,
  replaceOrAddSuggestedModel,
  saveModelSettings,
} from "./model-settings";
import { ProviderConcurrencyLimiter, RequestDeduplicator } from "./concurrency";
import { StreamCancelledError } from "./http";
import { getLimitOverrides, getProviderKey } from "../store";

const PAUSE_THRESHOLD_MS = 10 * 60_000;
const MAX_WAIT_ROUNDS = 2;

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
  reason?: string;
  suggestedModel?: string;
}

export interface CompleteOptions {
  schema?: object;
  maxTokens?: number;
  expectedOutputTokens?: number;
  signal?: AbortSignal;
  onDelta?: (chunk: string) => void;
  cacheStaticPrefix?: boolean;
}

export interface CompleteResult extends SendResult {
  pause?: boolean;
  resumeAtMs?: number | null;
}

export class AIService {
  lanes: Lane[] = [];
  private configuredEntries: ModelConfigEntry[] = [];
  private activeEntries: ModelConfigEntry[] = [];
  private droppedModels: DroppedModelInfo[] = [];
  private liveCatalogs: Partial<Record<ProviderKeyId, Set<string>>> = {};
  private ledger = new Ledger();
  private adapters = new Map<ProviderId, ProviderAdapter>();
  private router!: Router;
  private retries = new Map<string, number>();
  private realKeysPresent = false;
  // Concurrency limited to 2 in-flight requests per provider; excess queued FIFO.
  private concurrency = new ProviderConcurrencyLimiter(2);
  // Identical concurrent requests share one upstream flight.
  private dedup = new RequestDeduplicator<CompleteResult>();

  lastFailure: {
    kind: string;
    message: string;
    at: number;
    authStop?: boolean;
    laneDetails?: LaneExhaustedDetail[];
    resumeAtMs?: number | null;
  } | null = null;

  onWaiting?: (info: { laneId: string; resumeAtMs: number } | null) => void;
  onLaneEvent?: (event: RouterLaneEvent) => void;

  init(opts?: { skipLiveFetch?: boolean }): void {
    this.configuredEntries = loadModelSettings();
    const filtered = filterExistingModels(this.configuredEntries, this.liveCatalogs);
    this.activeEntries = filtered.active;
    this.droppedModels = filtered.dropped;

    this.rebuildLanes();

    if (!opts?.skipLiveFetch && process.env.MYIDE_SMOKE !== "1") {
      void this.syncLiveModels(false);
    }
  }

  private rebuildLanes(): void {
    this.lanes = buildLanes(this.activeEntries);

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
      !!getProviderKey(p as ProviderKeyId),
    );

    this.router = new Router({
      getLanes: (role) => this.lanesForRole(role),
      isProviderConfigured: (providerId) =>
        providerId === "offline" ? true : !!getProviderKey(providerId as ProviderKeyId),
      healthFor: (laneId) => {
        const lane = this.lanes.find((l) => l.id === laneId);
        return lane ? this.ledger.healthFor(lane) : undefined;
      },
      sendVia: (lane, req) =>
        this.concurrency.run(lane.provider, () => this.sendVia(lane, req), req.signal),
      countRetries: (laneId) => this.retries.get(laneId) ?? 0,
      bumpRetries: (laneId) => this.retries.set(laneId, (this.retries.get(laneId) ?? 0) + 1),
      resetRetries: (laneId) => this.retries.set(laneId, 0),
      markSessionDead: (lane, reason, suggestedModel) =>
        this.ledger.markSessionDead(lane, reason, suggestedModel),
      setLaneCooldown: (lane, untilMs, reason) =>
        this.ledger.setCooldown(lane, untilMs, reason),
      onOutcome: (lane, outcome, tokens) => this.applyOutcome(lane, outcome, tokens),
      onLaneEvent: (event) => this.onLaneEvent?.(event),
    });
  }

  private lanesForRole(role: TaskClass): Lane[] {
    if (!this.realKeysPresent) {
      const offlineMatch = this.lanes.filter((l) => l.provider === "offline" && l.role === role);
      return offlineMatch.length > 0 ? offlineMatch : this.lanes.filter((l) => l.provider === "offline");
    }
    const realLanes = this.lanes.filter((l) => l.provider !== "offline");
    if (role === "autocomplete") {
      // Prefer fast/low-latency lanes first for autocomplete, then priority order.
      return [...realLanes].sort((a, b) => {
        const aFast = a.provider === "groq" || a.model.includes("lite") || a.model.includes("instant") ? 0 : 1;
        const bFast = b.provider === "groq" || b.model.includes("lite") || b.model.includes("instant") ? 0 : 1;
        return aFast - bFast || (a.priority ?? 99) - (b.priority ?? 99);
      });
    }
    return realLanes;
  }

  async syncLiveModels(force = false): Promise<ModelsStateView> {
    try {
      this.liveCatalogs = await refreshLiveCatalogs({ force });
      this.configuredEntries = loadModelSettings();
      const filtered = filterExistingModels(this.configuredEntries, this.liveCatalogs);
      this.activeEntries = filtered.active;
      this.droppedModels = filtered.dropped;
      this.rebuildLanes();
    } catch (e) {
      log.warn("ai: could not sync live model catalog", e);
    }
    return this.modelsState();
  }

  modelsState(): ModelsStateView {
    return {
      filePath: modelsFilePath(),
      models: loadModelSettings(),
      dropped: [...this.droppedModels],
      deadSession: this.ledger.sessionDeadList().map((d) => ({
        id: d.model,
        provider: d.provider as ProviderKeyId,
        reason: d.reason,
        suggestedModel: d.suggestedModel,
      })),
    };
  }

  updateModels(models: ModelConfigEntry[]): ModelsStateView {
    const saved = saveModelSettings(models);
    this.configuredEntries = saved;
    const filtered = filterExistingModels(this.configuredEntries, this.liveCatalogs);
    this.activeEntries = filtered.active;
    this.droppedModels = filtered.dropped;
    this.rebuildLanes();
    return this.modelsState();
  }

  useSuggestedModel(provider: ProviderKeyId, oldModel: string, newModel: string): ModelsStateView {
    const saved = replaceOrAddSuggestedModel(provider, oldModel, newModel);
    this.ledger.clearSessionDeadForModel(provider, oldModel);
    this.ledger.clearSessionDeadForModel(provider, newModel);
    this.configuredEntries = saved;
    const filtered = filterExistingModels(this.configuredEntries, this.liveCatalogs);
    this.activeEntries = filtered.active;
    this.droppedModels = filtered.dropped;
    this.rebuildLanes();
    return this.modelsState();
  }

  clearCooldownsForRetry(): void {
    this.ledger.clearTransientCooldowns();
    this.retries.clear();
  }

  private async sendVia(lane: Lane, req: ProviderRequest): Promise<ProviderOutcome> {
    const adapter = this.adapters.get(lane.provider);
    if (!adapter) return { ok: false, error: { kind: "unmapped", message: `no adapter for ${lane.provider}` } };
    return adapter.send(req);
  }

  private applyOutcome(lane: Lane, outcome: ProviderOutcome, tokens: number): void {
    this.ledger.recordSend(lane, tokens);
    if (outcome.ok) {
      this.lastFailure = null;
    } else {
      const err = outcome.error;
      if (err.kind !== "cancelled") {
        this.lastFailure = { kind: err.kind, message: err.message, at: Date.now() };
      }
      if (err.kind === "rateLimitDay") {
        this.ledger.markDayExhausted(lane, err.waitUntilMs);
      } else if (err.kind === "modelDead") {
        this.ledger.markSessionDead(lane, err.message, err.suggestedModel);
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

  providerLabels(): Record<ProviderId, string> {
    return Object.fromEntries(
      (Object.keys(PROVIDER_CONFIGS) as ProviderId[]).map((p) => [p, PROVIDER_CONFIGS[p].label]),
    ) as Record<ProviderId, string>;
  }

  private requestDedupeKey(
    taskClass: TaskClass,
    messages: ProviderRequest["messages"],
    options?: CompleteOptions,
  ): string {
    return crypto
      .createHash("sha256")
      .update(taskClass)
      .update("|")
      .update(JSON.stringify(messages))
      .update("|")
      .update(JSON.stringify(options?.schema ?? null))
      .update("|")
      .update(String(options?.maxTokens ?? ""))
      .digest("hex");
  }

  async complete(
    taskClass: TaskClass,
    messages: ProviderRequest["messages"],
    options?: CompleteOptions,
  ): Promise<CompleteResult> {
    const key = this.requestDedupeKey(taskClass, messages, options);
    try {
      return await this.dedup.run(
        key,
        (sharedSignal, emitDelta) =>
          this.completeInternal(taskClass, messages, {
            ...options,
            signal: sharedSignal,
            onDelta: emitDelta,
          }),
        { signal: options?.signal, onDelta: options?.onDelta },
      );
    } catch (e) {
      if (e instanceof StreamCancelledError || options?.signal?.aborted) {
        return {
          ok: false,
          cancelled: true,
          error: { kind: "cancelled", message: "Cancelled by user" },
        };
      }
      throw e;
    }
  }

  private async completeInternal(
    taskClass: TaskClass,
    messages: ProviderRequest["messages"],
    options?: CompleteOptions,
  ): Promise<CompleteResult> {
    for (let round = 0; round <= MAX_WAIT_ROUNDS; round++) {
      if (options?.signal?.aborted) {
        return {
          ok: false,
          cancelled: true,
          error: { kind: "cancelled", message: "Cancelled by user" },
        };
      }

      const result = await this.router.send(taskClass, messages, options);
      if (result.ok) {
        this.onWaiting?.(null);
        return result;
      }

      // Never wait or loop on user cancellation or 401/403 API key errors.
      if (result.cancelled || result.authStop) {
        this.onWaiting?.(null);
        if (result.authStop) {
          this.lastFailure = {
            kind: "unauthorized",
            message: result.error?.message ?? "Check your API key.",
            at: Date.now(),
            authStop: true,
          };
        }
        return result;
      }

      // Check if ANY lane actually has a timed cooldown/quota reset (NEVER dead models!).
      const resumeAtMs = result.resumeAtMs ?? null;
      const waitMs = resumeAtMs != null ? Math.max(0, resumeAtMs - Date.now()) : null;

      if (waitMs == null || waitMs > PAUSE_THRESHOLD_MS) {
        if (resumeAtMs) this.onWaiting?.({ laneId: "*", resumeAtMs });
        this.lastFailure = {
          kind: "exhausted",
          message: result.error?.message ?? "All lanes exhausted",
          at: Date.now(),
          laneDetails: result.laneDetails,
          resumeAtMs,
        };
        log.warn(
          `ai: all lanes exhausted; local resume estimate: ${
            resumeAtMs ? formatLocalTime(resumeAtMs) : "none (dead/unconfigured)"
          }`,
        );
        return {
          ...result,
          ok: false,
          pause: resumeAtMs != null,
          resumeAtMs: resumeAtMs ?? undefined,
        };
      }

      log.warn(`ai: all lanes in cooldown; waiting ${Math.round(waitMs / 1000)}s until ${formatLocalTime(resumeAtMs!)}`);
      this.onWaiting?.({ laneId: "*", resumeAtMs: resumeAtMs! });
      try {
        await abortableSleep(Math.min(waitMs, PAUSE_THRESHOLD_MS) + 250, options?.signal);
      } catch {
        this.onWaiting?.(null);
        return {
          ok: false,
          cancelled: true,
          error: { kind: "cancelled", message: "Cancelled by user" },
        };
      }
      this.onWaiting?.(null);
    }

    return {
      ok: false,
      allExhausted: true,
      pause: true,
      error: { kind: "unmapped", message: "All lanes remained blocked after waiting for cooldown." },
    };
  }

  quotaSnapshot(): QuotaLaneView[] {
    return this.lanes
      .filter((l) => l.provider !== "offline")
      .map((lane) => {
        const h = this.ledger.healthFor(lane);
        const used = this.ledger.requestsToday(lane);
        const rpd = Number.isFinite(lane.limits.rpd) ? lane.limits.rpd : null;
        const now = Date.now();
        let status: QuotaLaneView["status"] = "ok";
        let reason: string | undefined;
        if (h.deadSession) {
          status = "dead";
          reason = h.deadReason;
        } else if ((h.removedUntil && h.removedUntil > now) || (h.cooldownUntil && h.cooldownUntil > now)) {
          status = "limited";
          reason = h.cooldownReason;
        }
        const resetMs =
          h.removedUntil && h.removedUntil > now
            ? h.removedUntil
            : h.cooldownUntil && h.cooldownUntil > now
            ? h.cooldownUntil
            : nextResetMs(lane.limits.resetHourUtc);
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
          resetAt: formatLocalTime(resetMs),
          status,
          reason,
          suggestedModel: h.suggestedModel,
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

export { defaultLaneLimits };
