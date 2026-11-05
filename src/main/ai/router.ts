import type {
  Lane,
  LaneExhaustedDetail,
  LaneHealth,
  ProviderId,
  ProviderOutcome,
  ProviderError,
  ProviderRequest,
  RouterLaneEvent,
  TaskClass,
} from "./types";
import { isLaneUsable } from "./providers";
import { estimateTokens, shrinkPromptToTokens } from "./tokenize";
import { StreamCancelledError } from "./http";
import { fitMessagesToLaneBudget } from "../context/budget";
import { currentTelemetry } from "../telemetry";
import log from "electron-log";

export const DEFAULT_CHAIN_ORDER: Record<TaskClass, ProviderId[]> = {
  reasoning: ["gemini", "groq", "openrouter"],
  general: ["gemini", "groq", "openrouter"],
  autocomplete: ["groq", "gemini", "openrouter"],
};

// PART 1 #2:
// - 404 / 400 "model unavailable": mark permanently dead for session, 0 retries, next lane, surface suggestedModel.
// - 429 / quota: honor Retry-After, exponential backoff + jitter (max 3 retries per lane), set per-lane cooldown, then next lane.
// - 401 / 403: stop immediately and show "check your API key" (do NOT rotate lanes).
// - 5xx / network / timeout: retry ONCE with backoff, then fall to the next lane.

export const MAX_429_RETRIES_PER_LANE = 3;
export const MAX_SERVER_RETRIES_PER_LANE = 1;

type LogEntry = { count: number; last: number };
const logIndex = new Map<string, LogEntry>();

function logEvent(key: string, message: string) {
  const prev = logIndex.get(key);
  const now = Date.now();
  if (prev && now - prev.last < 60_000) {
    prev.count += 1;
    prev.last = now;
    log.warn(`[router] ${message} (repeat x${prev.count})`);
  } else {
    logIndex.set(key, { count: 1, last: now });
    log.warn(`[router] ${message}`);
  }
}

function promptText(messages: ProviderRequest["messages"]): string {
  return messages.map((m) => m.content).join("\n");
}

export type ErrorAction =
  | { kind: "retryRateLimit"; retryAfterMs?: number }
  | { kind: "retryOnceServer"; backoffMs: number }
  | { kind: "modelDeadSession"; reason: string; suggestedModel?: string }
  | { kind: "dayQuotaExhausted"; reason: string; waitUntilMs?: number }
  | { kind: "authStop"; reason: string }
  | { kind: "skipLane"; reason: string }
  | { kind: "shrinkAndRetry"; reason: string }
  | { kind: "cancelled" }
  | { kind: "fallback"; reason: string };

export function classifyError(err: ProviderError): ErrorAction {
  switch (err.kind) {
    case "cancelled":
      return { kind: "cancelled" };
    case "unauthorized":
      return { kind: "authStop", reason: err.message || "Check your API key" };
    case "modelDead":
      return { kind: "modelDeadSession", reason: err.message, suggestedModel: err.suggestedModel };
    case "rateLimitMinute":
      return { kind: "retryRateLimit", retryAfterMs: err.retryAfterMs };
    case "rateLimitDay":
      return { kind: "dayQuotaExhausted", reason: err.message || "Daily quota exhausted", waitUntilMs: err.waitUntilMs };
    case "tooBig":
      return { kind: "shrinkAndRetry", reason: "413 request too large" };
    case "badRequest":
      return { kind: "skipLane", reason: err.message || "400 bad request" };
    case "serverError":
    case "networkError":
    case "timeout":
    case "empty":
      return { kind: "retryOnceServer", backoffMs: err.retryAfterMs ?? 1000 };
    default:
      return { kind: "fallback", reason: err.message || "Unmapped provider error" };
  }
}

export interface SendResult {
  ok: boolean;
  content?: string;
  laneUsed?: Lane;
  error?: ProviderError;
  promptTokens?: number;
  completionTokens?: number;
  authStop?: boolean;
  cancelled?: boolean;
  allExhausted?: boolean;
  laneDetails?: LaneExhaustedDetail[];
  resumeAtMs?: number | null;
}

export interface RouterConfig {
  /** Preferred multi-model lane list (already ordered by priority). */
  getLanes?: (role: TaskClass) => Lane[];
  /** Legacy per-provider lane getter (kept for backward compatibility). */
  getLane?: (providerId: ProviderId, role: TaskClass) => Lane | undefined;
  isProviderConfigured?: (providerId: ProviderId) => boolean;
  healthFor: (laneId: string) => LaneHealth | undefined;
  sendVia: (lane: Lane, req: ProviderRequest) => Promise<ProviderOutcome>;
  countRetries?: (laneId: string) => number;
  bumpRetries?: (laneId: string) => void;
  resetRetries?: (laneId: string) => void;
  markSessionDead?: (lane: Lane, reason: string, suggestedModel?: string) => void;
  setLaneCooldown?: (lane: Lane, untilMs: number, reason: string) => void;
  onOutcome?: (lane: Lane, outcome: ProviderOutcome, estimatedTokens: number) => void;
  onLaneEvent?: (event: RouterLaneEvent) => void;
  chainOrder?: Record<TaskClass, ProviderId[]>;
  /** Tunable timing hooks (used by unit tests so backoff math runs in milliseconds). */
  baseBackoffMs?: number;
  serverBackoffMs?: number;
  maxInlineWaitMs?: number;
  maxRetriesPerLane?: number;
  random?: () => number;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function computeExponentialBackoffMs(
  retryIndex: number,
  baseBackoffMs: number,
  retryAfterMs?: number,
  randomFn: () => number = Math.random,
): number {
  const exp = baseBackoffMs * Math.pow(2, retryIndex);
  const floor = Math.max(retryAfterMs ?? 0, exp);
  const jitter = Math.floor(randomFn() * Math.max(1, floor * 0.25));
  return floor + jitter;
}

export class Router {
  constructor(public config: RouterConfig) {}

  private resolveCandidateLanes(taskClass: TaskClass): Lane[] {
    if (this.config.getLanes) {
      return this.config.getLanes(taskClass);
    }
    const chain = this.config.chainOrder?.[taskClass] ?? DEFAULT_CHAIN_ORDER[taskClass];
    const out: Lane[] = [];
    for (const providerId of chain) {
      const lane = this.config.getLane?.(providerId, taskClass);
      if (lane) out.push(lane);
    }
    return out;
  }

  async send(
    taskClass: TaskClass,
    messages: ProviderRequest["messages"],
    options?: {
      schema?: object;
      maxTokens?: number;
      expectedOutputTokens?: number;
      signal?: AbortSignal;
      onDelta?: (chunk: string) => void;
      cacheStaticPrefix?: boolean;
    },
  ): Promise<SendResult> {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        cancelled: true,
        error: { kind: "cancelled", message: "Cancelled by user" },
      };
    }

    const candidates = this.resolveCandidateLanes(taskClass);
    const expectedOutputTokens = options?.expectedOutputTokens ?? 512;
    const baseBackoffMs = this.config.baseBackoffMs ?? 1_000;
    const serverBackoffMs = this.config.serverBackoffMs ?? 800;
    const maxInlineWaitMs = this.config.maxInlineWaitMs ?? 30_000;
    const maxRetries429 = this.config.maxRetriesPerLane ?? MAX_429_RETRIES_PER_LANE;
    const randomFn = this.config.random ?? Math.random;
    const sleepFn = this.config.sleepFn ?? abortableSleep;

    const fullPrompt = promptText(messages);
    const baseEstimate = estimateTokens(fullPrompt, expectedOutputTokens);

    const laneDetails: LaneExhaustedDetail[] = [];
    let prevFailedLane: Lane | undefined;
    let prevFailureReason = "";

    for (const lane of candidates) {
      if (options?.signal?.aborted) {
        return {
          ok: false,
          cancelled: true,
          error: { kind: "cancelled", message: "Cancelled by user" },
        };
      }

      if (lane.provider !== "offline" && this.config.isProviderConfigured && !this.config.isProviderConfigured(lane.provider)) {
        laneDetails.push({
          laneId: lane.id,
          provider: lane.provider,
          model: lane.model,
          status: "no_key",
          reason: `No API key configured for ${lane.provider}`,
          resumeAtMs: null,
        });
        continue;
      }

      const health = this.config.healthFor(lane.id);
      if (!health) continue;

      if (health.deadSession) {
        laneDetails.push({
          laneId: lane.id,
          provider: lane.provider,
          model: lane.model,
          status: "dead",
          reason: health.deadReason ?? "Model permanently unavailable for this session",
          resumeAtMs: null,
          suggestedModel: health.suggestedModel,
        });
        continue;
      }

      const laneInputCap =
        lane.limits.maxTokensPerRequest != null
          ? Math.max(250, lane.limits.maxTokensPerRequest - expectedOutputTokens)
          : lane.limits.tpm != null && lane.limits.tpm <= 12_000
          ? Math.max(400, Math.min(5_500, lane.limits.tpm - expectedOutputTokens))
          : null;
      const laneMessages =
        laneInputCap != null ? fitMessagesToLaneBudget(messages, laneInputCap) : messages;
      const laneEstimate =
        laneMessages === messages
          ? baseEstimate
          : estimateTokens(promptText(laneMessages), expectedOutputTokens);

      if (lane.limits.maxTokensPerRequest != null && laneEstimate > lane.limits.maxTokensPerRequest) {
        const reason = `Skipped: prompt (~${laneEstimate} tokens) exceeds ${lane.limits.maxTokensPerRequest}-token cap`;
        logEvent(`toobig:${lane.id}`, `lane ${lane.id} ${reason}`);
        laneDetails.push({
          laneId: lane.id,
          provider: lane.provider,
          model: lane.model,
          status: "skipped_size",
          reason,
          resumeAtMs: null,
        });
        continue;
      }

      const now = Date.now();
      if (!isLaneUsable(lane, health, laneEstimate, now)) {
        const resumeAtMs =
          (health.removedUntil && health.removedUntil > now ? health.removedUntil : null) ??
          (health.cooldownUntil && health.cooldownUntil > now ? health.cooldownUntil : null) ??
          (health.minuteRequestCount >= lane.limits.rpm ||
          (lane.limits.tpm != null && health.minuteTokenCount >= lane.limits.tpm)
            ? now + 60_000
            : null);
        const isQuota = Boolean(health.removedUntil && health.removedUntil > now);
        const reason = isQuota
          ? `Daily quota exhausted until ${formatLocalTime(health.removedUntil!)}`
          : health.cooldownUntil && health.cooldownUntil > now
          ? `Rate-limit cooldown until ${formatLocalTime(health.cooldownUntil)}${
              health.cooldownReason ? ` (${health.cooldownReason.slice(0, 120)})` : ""
            }`
          : `Per-minute rate limit (${lane.limits.rpm} RPM) active`;
        logEvent(`unusable:${lane.id}`, `lane ${lane.id} unusable: ${reason}`);
        laneDetails.push({
          laneId: lane.id,
          provider: lane.provider,
          model: lane.model,
          status: isQuota ? "quota" : "cooldown",
          reason,
          resumeAtMs,
        });
        continue;
      }

      if (prevFailedLane) {
        this.config.onLaneEvent?.({
          type: "switch-lane",
          fromLane: prevFailedLane,
          toLane: lane,
          reason: prevFailureReason,
        });
      }

      let req: ProviderRequest = {
        lane,
        messages: laneMessages,
        schema: options?.schema,
        maxTokens: options?.maxTokens,
        signal: options?.signal,
        onDelta: options?.onDelta,
        cacheStaticPrefix: options?.cacheStaticPrefix,
      };

      let rateLimitRetries = 0;
      let serverRetries = 0;
      let shrinkTried = false;

      for (;;) {
        if (options?.signal?.aborted) {
          return {
            ok: false,
            cancelled: true,
            error: { kind: "cancelled", message: "Cancelled by user" },
          };
        }

        const estimate = estimateTokens(promptText(req.messages), expectedOutputTokens);
        let outcome: ProviderOutcome;
        try {
          outcome = await this.config.sendVia(lane, req);
        } catch (e) {
          if (e instanceof StreamCancelledError || options?.signal?.aborted) {
            return {
              ok: false,
              cancelled: true,
              error: { kind: "cancelled", message: "Cancelled by user" },
            };
          }
          outcome = {
            ok: false,
            error: { kind: "networkError", message: e instanceof Error ? e.message : String(e) },
          };
        }

        if (outcome.ok) {
          this.config.onOutcome?.(lane, outcome, estimate);
          log.info(`[router] success via ${lane.id} (~${estimate} tokens est.)`);
          this.config.resetRetries?.(lane.id);
          const inTok = outcome.usage?.promptTokens && outcome.usage.promptTokens > 0
            ? outcome.usage.promptTokens
            : Math.ceil(promptText(req.messages).length / 3.5);
          const outTok = outcome.usage?.completionTokens && outcome.usage.completionTokens > 0
            ? outcome.usage.completionTokens
            : Math.ceil(outcome.content.length / 3.5);
          return {
            ok: true,
            content: outcome.content,
            laneUsed: lane,
            promptTokens: inTok,
            completionTokens: outTok,
          };
        }

        const err = outcome.error;
        if (err.kind === "cancelled" || options?.signal?.aborted) {
          return {
            ok: false,
            cancelled: true,
            error: { kind: "cancelled", message: "Cancelled by user" },
          };
        }

        this.config.onOutcome?.(lane, outcome, estimate);
        const action = classifyError(err);
        logEvent(`err:${lane.id}:${err.kind}`, `lane ${lane.id} error ${err.kind}: ${err.message}`);

        // 1) 401 / 403 -> STOP immediately and show "check your API key". Do NOT rotate lanes.
        if (action.kind === "authStop") {
          const msg = /check your api key/i.test(action.reason)
            ? action.reason
            : `${action.reason} — check your API key.`;
          log.error(`[router] auth error on ${lane.id}; stopping without rotating lanes: ${msg}`);
          return {
            ok: false,
            authStop: true,
            laneUsed: lane,
            error: { ...err, kind: "unauthorized", message: msg },
          };
        }

        // 2) 404 / 400 "model unavailable" -> permanently dead for session, 0 retries, move to next lane.
        if (action.kind === "modelDeadSession") {
          currentTelemetry()?.recordDeadLane();
          this.config.markSessionDead?.(lane, action.reason, action.suggestedModel);
          this.config.onLaneEvent?.({
            type: "model-dead",
            lane,
            reason: action.reason,
            suggestedModel: action.suggestedModel,
          });
          laneDetails.push({
            laneId: lane.id,
            provider: lane.provider,
            model: lane.model,
            status: "dead",
            reason: action.reason,
            resumeAtMs: null,
            suggestedModel: action.suggestedModel,
          });
          prevFailedLane = lane;
          prevFailureReason = `Model ${lane.model} unavailable`;
          break;
        }

        // 3) Daily quota exhausted -> record reset time and move to next lane.
        if (action.kind === "dayQuotaExhausted") {
          const until = action.waitUntilMs ?? Date.now() + 3_600_000;
          this.config.setLaneCooldown?.(lane, until, action.reason);
          laneDetails.push({
            laneId: lane.id,
            provider: lane.provider,
            model: lane.model,
            status: "quota",
            reason: action.reason,
            resumeAtMs: until,
          });
          prevFailedLane = lane;
          prevFailureReason = `Quota reached on ${lane.model}`;
          break;
        }

        // 4) 429 rate limit -> honor Retry-After, per-lane cooldown with exponential backoff + jitter (max 3 retries).
        if (action.kind === "retryRateLimit") {
          const delayMs = computeExponentialBackoffMs(
            rateLimitRetries,
            baseBackoffMs,
            action.retryAfterMs,
            randomFn,
          );
          const untilMs = Date.now() + delayMs;
          this.config.setLaneCooldown?.(lane, untilMs, err.message);

          if (rateLimitRetries < maxRetries429 && delayMs <= maxInlineWaitMs) {
            rateLimitRetries += 1;
            currentTelemetry()?.recordRetry("429");
            this.config.bumpRetries?.(lane.id);
            this.config.onLaneEvent?.({
              type: "backoff",
              lane,
              delayMs,
              attempt: rateLimitRetries,
              maxRetries: maxRetries429,
              reason: err.message,
            });
            try {
              await sleepFn(delayMs, options?.signal);
            } catch {
              return {
                ok: false,
                cancelled: true,
                error: { kind: "cancelled", message: "Cancelled by user" },
              };
            }
            continue;
          }

          log.warn(`[router] lane ${lane.id} exhausted 429 retries (${rateLimitRetries}/${maxRetries429}); trying next lane`);
          laneDetails.push({
            laneId: lane.id,
            provider: lane.provider,
            model: lane.model,
            status: "cooldown",
            reason: `${err.message} (cooldown until ${formatLocalTime(untilMs)})`,
            resumeAtMs: untilMs,
          });
          prevFailedLane = lane;
          prevFailureReason = `429 rate limit on ${lane.model}`;
          break;
        }

        // 5) 5xx / network / timeout -> retry ONCE with backoff, then fall to next lane.
        if (action.kind === "retryOnceServer") {
          if (serverRetries < MAX_SERVER_RETRIES_PER_LANE) {
            serverRetries += 1;
            currentTelemetry()?.recordRetry("5xx");
            this.config.bumpRetries?.(lane.id);
            const jitter = Math.floor(randomFn() * Math.max(1, serverBackoffMs * 0.3));
            const delayMs = Math.max(serverBackoffMs, Math.min(action.backoffMs, 5_000)) + jitter;
            this.config.onLaneEvent?.({
              type: "backoff",
              lane,
              delayMs,
              attempt: serverRetries,
              maxRetries: MAX_SERVER_RETRIES_PER_LANE,
              reason: err.message,
            });
            try {
              await sleepFn(delayMs, options?.signal);
            } catch {
              return {
                ok: false,
                cancelled: true,
                error: { kind: "cancelled", message: "Cancelled by user" },
              };
            }
            continue;
          }

          laneDetails.push({
            laneId: lane.id,
            provider: lane.provider,
            model: lane.model,
            status: "error",
            reason: `${err.message} (retried once)`,
            resumeAtMs: null,
          });
          prevFailedLane = lane;
          prevFailureReason = `Server/network error on ${lane.model}`;
          break;
        }

        // 6) 413 shrink once and retry on this lane, else next lane.
        if (action.kind === "shrinkAndRetry") {
          if (!shrinkTried) {
            shrinkTried = true;
            currentTelemetry()?.recordRetry("413");
            const smaller = shrinkPromptToTokens(fullPrompt, Math.floor(estimate * 0.6));
            log.info(`[router] 413 on ${lane.id}; retrying once with smaller prompt (~${smaller.actualTokens} tokens)`);
            req = { ...req, messages: [{ role: "user", content: smaller.text }] };
            continue;
          }
          laneDetails.push({
            laneId: lane.id,
            provider: lane.provider,
            model: lane.model,
            status: "skipped_size",
            reason: err.message,
            resumeAtMs: null,
          });
          prevFailedLane = lane;
          prevFailureReason = `Request too large for ${lane.model}`;
          break;
        }

        // 7) 400 badRequest / fallback -> move to next lane immediately.
        const fallbackReason = "reason" in action ? action.reason : err.message;
        laneDetails.push({
          laneId: lane.id,
          provider: lane.provider,
          model: lane.model,
          status: "error",
          reason: fallbackReason,
          resumeAtMs: null,
        });
        prevFailedLane = lane;
        prevFailureReason = fallbackReason;
        break;
      }
    }

    const now = Date.now();
    let earliestResumeMs: number | null = null;
    for (const d of laneDetails) {
      if (d.resumeAtMs != null && d.resumeAtMs > now) {
        if (earliestResumeMs == null || d.resumeAtMs < earliestResumeMs) {
          earliestResumeMs = d.resumeAtMs;
        }
      }
    }

    const summaryLines = laneDetails.map((d) => `- ${d.laneId}: ${d.reason}`);
    const resumeLine = earliestResumeMs
      ? `Estimated local resume time: ${formatLocalTime(earliestResumeMs)}.`
      : "No timed cooldown reset pending — edit models or add an API key.";

    return {
      ok: false,
      allExhausted: true,
      laneDetails,
      resumeAtMs: earliestResumeMs,
      error: {
        kind: "unmapped",
        message: [
          `All ${laneDetails.length || "configured"} lane(s) are unavailable:`,
          ...summaryLines,
          resumeLine,
        ].join("\n"),
      },
    };
  }
}

export function formatLocalTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new StreamCancelledError());
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new StreamCancelledError());
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
  });
}
