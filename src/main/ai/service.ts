import crypto from "crypto";
import log from "electron-log";
import type {
  DroppedModelInfo,
  LaneExhaustedDetail,
  LocalModelsState,
  LocalModelTestResult,
  LocalProviderId,
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
import { buildLanes, buildLocalLanes, defaultLaneLimits, PROVIDER_CONFIGS } from "./providers";
import { Ledger, nextResetMs } from "./ledger";
import { Router, abortableSleep, formatLocalTime, type SendResult, type RouterSendOptions } from "./router";
import { makeRealProviders, discoverLimitsFromHeaders } from "./real-providers";
import {
  detectLocalModels,
  makeLocalProviders,
  normalizeLmStudioV1Url,
  normalizeOllamaRootUrl,
  RECOMMENDED_LOCAL_CODER_MODELS,
  testLocalModel,
} from "./local-providers";
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
import { getLimitOverrides, getProviderKey, getSettings } from "../store";

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

export interface CompleteOptions extends RouterSendOptions {}

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
  private localState: LocalModelsState = {
    enabled: true,
    ollamaUrl: "http://127.0.0.1:11434",
    ollamaOnline: false,
    lmStudioUrl: "http://127.0.0.1:1234/v1",
    lmStudioOnline: false,
    selectedModel: "",
    models: [],
    recommended: RECOMMENDED_LOCAL_CODER_MODELS,
    checkedAt: 0,
  };
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
    const s = getSettings();
    this.localState = {
      ...this.localState,
      enabled: s.localModelsEnabled !== false,
      ollamaUrl: normalizeOllamaRootUrl(s.ollamaBaseUrl),
      lmStudioUrl: normalizeLmStudioV1Url(s.lmStudioBaseUrl),
      selectedModel: s.selectedLocalModel ?? "",
    };
    this.configuredEntries = loadModelSettings();
    const filtered = filterExistingModels(this.configuredEntries, this.liveCatalogs);
    this.activeEntries = filtered.active;
    this.droppedModels = filtered.dropped;

    this.rebuildLanes();

    if (!opts?.skipLiveFetch && process.env.MYIDE_SMOKE !== "1") {
      void this.syncLiveModels(false);
      void this.detectLocalModels();
    }
  }

  private hasActiveLocalLanes(): boolean {
    return getSettings().localModelsEnabled !== false && this.localState.models.length > 0;
  }

  private rebuildLanes(): void {
    const s = getSettings();
    const baseLanes = buildLanes(this.activeEntries);
    const cloudLanes = baseLanes.filter((l) => l.provider !== "offline");
    const offlineLanes = baseLanes.filter((l) => l.provider === "offline");
    const localLanes =
      s.localModelsEnabled !== false && this.localState.models.length > 0
        ? buildLocalLanes(this.localState.models, s.selectedLocalModel)
        : [];

    this.lanes = [...cloudLanes, ...localLanes, ...offlineLanes];

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
    const localAdapters = makeLocalProviders({
      getOllamaUrl: () => getSettings().ollamaBaseUrl ?? "http://127.0.0.1:11434",
      getLmStudioUrl: () => getSettings().lmStudioBaseUrl ?? "http://127.0.0.1:1234",
      isProviderOnline: (provider) =>
        getSettings().localModelsEnabled !== false &&
        (provider === "ollama" ? this.localState.ollamaOnline : this.localState.lmStudioOnline),
    });
    for (const [k, adapter] of localAdapters.entries()) {
      this.adapters.set(k, adapter);
    }
    this.adapters.set("offline", makeOfflineProvider());

    this.realKeysPresent = (["gemini", "openrouter", "groq"] as ProviderId[]).some((p) =>
      !!getProviderKey(p as ProviderKeyId),
    );

    this.router = new Router({
      getLanes: (role) => this.lanesForRole(role),
      isProviderConfigured: (providerId) => {
        if (providerId === "offline") return true;
        if (providerId === "ollama") {
          return getSettings().localModelsEnabled !== false && this.localState.ollamaOnline;
        }
        if (providerId === "lmstudio") {
          return getSettings().localModelsEnabled !== false && this.localState.lmStudioOnline;
        }
        return !!getProviderKey(providerId as ProviderKeyId);
      },
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
      canAfford: (lane, estimatedTokens, now) =>
        this.ledger.canAfford(lane, estimatedTokens, now),
      recordQualitySample: (lane, sample) =>
        this.ledger.recordQualitySample(lane, sample),
      onOutcome: (lane, outcome, tokens) => this.applyOutcome(lane, outcome, tokens),
      onLaneEvent: (event) => this.onLaneEvent?.(event),
    });
  }

  private lanesForRole(role: TaskClass): Lane[] {
    const mappedOfflineRole =
      role === "autocomplete" || role === "classify"
        ? "autocomplete"
        : role === "chat" || role === "summarize"
        ? "general"
        : "reasoning";
    const offlineFallback = () => {
      const m = this.lanes.filter((l) => l.provider === "offline" && l.role === mappedOfflineRole);
      return m.length > 0 ? m : this.lanes.filter((l) => l.provider === "offline");
    };

    const hasLocal = this.hasActiveLocalLanes();
    if (!this.realKeysPresent && !hasLocal) {
      return offlineFallback();
    }

    const isLocal = (l: Lane) => l.provider === "ollama" || l.provider === "lmstudio";

    // PHASE 6: When no cloud keys exist, detected local models replace the static offline starter pack,
    // keeping the starter pack at the tail ONLY when nothing else works!
    if (!this.realKeysPresent && hasLocal) {
      const localOnly = this.lanes
        .filter(isLocal)
        .sort((a, b) => {
          const aScore = (a.priority ?? 30) + this.ledger.qualityScorePenalty(a.id);
          const bScore = (b.priority ?? 30) + this.ledger.qualityScorePenalty(b.id);
          return aScore - bScore;
        });
      return [...localOnly, ...offlineFallback()];
    }

    const realLanes = this.lanes.filter((l) => l.provider !== "offline");
    const isLightTask =
      role === "autocomplete" || role === "classify" || role === "summarize" || role === "chat";
    const isSimpleEditOrPlan = role === "plan" || role === "general";

    return [...realLanes].sort((a, b) => {
      // PHASE 6: Route classify, summarize, history compression, chat, and capable simple edits to local
      // lanes by default (0 cloud quota cost). Keep cloud lanes primary for hard codegen and repair!
      const localAdjust = (l: Lane): number => {
        if (!isLocal(l)) return 0;
        if (isLightTask) return -45;
        if (isSimpleEditOrPlan) return l.role === "reasoning" ? -25 : 25;
        // Hard codegen / repair / reasoning -> cloud first, local coder as unlimited safety fallback
        return l.role === "reasoning" ? 35 : 80;
      };

      // 1. Explicit taskClasses match in models.json gets a boost for light tasks
      const aExplicit = a.taskClasses?.includes(role) ? -4 : 0;
      const bExplicit = b.taskClasses?.includes(role) ? -4 : 0;

      // 2. For light tasks (classify/summarize/chat/autocomplete), prefer fast/high-RPM models first
      // so scarce daily quota on top codegen lanes is saved for codegen/plan/repair!
      const isFastModel = (l: Lane) =>
        l.provider === "groq" ||
        l.model.includes("lite") ||
        l.model.includes("instant") ||
        l.model.includes("3b") ||
        l.model.includes("7b") ||
        l.model.includes("20b");
      const aTier = isLightTask && !isLocal(a) ? (isFastModel(a) ? -6 : 0) : 0;
      const bTier = isLightTask && !isLocal(b) ? (isFastModel(b) ? -6 : 0) : 0;

      // 3. Combine user priority + local routing policy + dynamic rolling quality penalty
      const aScore =
        (a.priority ?? 50) + localAdjust(a) + aExplicit + aTier + this.ledger.qualityScorePenalty(a.id);
      const bScore =
        (b.priority ?? 50) + localAdjust(b) + bExplicit + bTier + this.ledger.qualityScorePenalty(b.id);
      return aScore - bScore;
    });
  }

  localModelsState(): LocalModelsState {
    const s = getSettings();
    return {
      ...this.localState,
      enabled: s.localModelsEnabled !== false,
      ollamaUrl: normalizeOllamaRootUrl(s.ollamaBaseUrl),
      lmStudioUrl: normalizeLmStudioV1Url(s.lmStudioBaseUrl),
      selectedModel: s.selectedLocalModel ?? "",
      models: [...this.localState.models],
      recommended: RECOMMENDED_LOCAL_CODER_MODELS,
    };
  }

  async detectLocalModels(timeoutMs?: number): Promise<LocalModelsState> {
    const s = getSettings();
    this.localState = await detectLocalModels({
      enabled: s.localModelsEnabled !== false,
      ollamaUrl: s.ollamaBaseUrl,
      lmStudioUrl: s.lmStudioBaseUrl,
      selectedModel: s.selectedLocalModel,
      timeoutMs,
    });
    this.rebuildLanes();
    return this.localModelsState();
  }

  async testLocalModel(provider: LocalProviderId, model?: string): Promise<LocalModelTestResult> {
    const s = getSettings();
    const res = await testLocalModel(provider, model, {
      ollamaUrl: s.ollamaBaseUrl,
      lmStudioUrl: s.lmStudioBaseUrl,
    });
    await this.detectLocalModels();
    return res;
  }

  onSettingsChanged(): void {
    const s = getSettings();
    this.localState = {
      ...this.localState,
      enabled: s.localModelsEnabled !== false,
      ollamaUrl: normalizeOllamaRootUrl(s.ollamaBaseUrl),
      lmStudioUrl: normalizeLmStudioV1Url(s.lmStudioBaseUrl),
      selectedModel: s.selectedLocalModel ?? "",
    };
    this.rebuildLanes();
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
    return !this.realKeysPresent && !this.hasActiveLocalLanes();
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
