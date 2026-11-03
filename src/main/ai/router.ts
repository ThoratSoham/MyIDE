import type {
  Lane,
  LaneHealth,
  ProviderId,
  ProviderOutcome,
  ProviderError,
  ProviderRequest,
  TaskClass,
} from "./types";
import { GROQ_MAX_REQUEST_TOKENS } from "./types";
import { isLaneUsable } from "./providers";
import { estimateTokens, shrinkPromptToTokens } from "./tokenize";
import log from "electron-log";

// FR-3.1: chain order depends on task class. Gemini carries big contexts, Groq
// is first for tiny autocomplete work, OpenRouter is the second opinion.
export const DEFAULT_CHAIN_ORDER: Record<TaskClass, ProviderId[]> = {
  reasoning: ["gemini", "openrouter", "groq"],
  general: ["gemini", "openrouter", "groq"],
  autocomplete: ["groq", "gemini", "openrouter"],
};

// FR-3.6: at most 3 retries per request per lane. No endless loops.
const MAX_RETRIES_PER_LANE = 3;

// Same failing (lane, error kind) logged once with a counter, not spammed.
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

// Section 11 / FR-3.2: convert a provider error into a routing action.
export type ErrorAction =
  | { kind: "retrySame"; backoffMs: number }
  | { kind: "nextLane"; reason: string; permanent?: boolean }
  | { kind: "skipLane"; reason: string }
  | { kind: "stopProvider"; reason: string }
  | { kind: "shrinkAndRetry"; reason: string }
  | { kind: "fallback"; reason: string };

export function classifyError(err: ProviderError): ErrorAction {
  switch (err.kind) {
    case "rateLimitMinute":
      return { kind: "retrySame", backoffMs: Math.max(err.retryAfterMs ?? 10_000, 1000) };
    case "rateLimitDay":
      return { kind: "nextLane", reason: "day quota exhausted", permanent: true };
    case "tooBig":
      return { kind: "shrinkAndRetry", reason: "413 too big" };
    case "badRequest":
      return { kind: "skipLane", reason: "400 bad request" };
    case "unauthorized":
      return { kind: "stopProvider", reason: "unauthorized or missing key" };
    case "modelDead":
      return { kind: "nextLane", reason: "model dead for 24h", permanent: true };
    case "serverError":
    case "networkError":
    case "timeout":
      return { kind: "retrySame", backoffMs: 1500 + Math.floor(Math.random() * 1500) };
    case "empty":
      return { kind: "retrySame", backoffMs: 800 + Math.floor(Math.random() * 800) };
    default:
      return { kind: "fallback", reason: "unmapped error" };
  }
}

export interface SendResult {
  ok: boolean;
  content?: string;
  laneUsed?: Lane;
  error?: ProviderError;
  promptTokens?: number;
}

export interface RouterConfig {
  getLane: (providerId: ProviderId, role: TaskClass) => Lane | undefined;
  healthFor: (laneId: string) => LaneHealth | undefined;
  sendVia: (lane: Lane, req: ProviderRequest) => Promise<ProviderOutcome>;
  countRetries: (laneId: string) => number;
  bumpRetries: (laneId: string) => void;
  resetRetries: (laneId: string) => void;
  // Called after every real send attempt so the ledger can apply the error
  // rules (day-exhausted removal, dead model, learned limits).
  onOutcome?: (lane: Lane, outcome: ProviderOutcome, estimatedTokens: number) => void;
  chainOrder?: Record<TaskClass, ProviderId[]>;
}

export class Router {
  constructor(public config: RouterConfig) {}

  async send(
    taskClass: TaskClass,
    messages: ProviderRequest["messages"],
    options?: { schema?: object; maxTokens?: number; expectedOutputTokens?: number }
  ): Promise<SendResult> {
    const chain = this.config.chainOrder?.[taskClass] ?? DEFAULT_CHAIN_ORDER[taskClass];
    const expectedOutputTokens = options?.expectedOutputTokens ?? 512;

    let shrinkTried = false;

    const fullPrompt = promptText(messages);
    const baseEstimate = estimateTokens(fullPrompt, expectedOutputTokens);

    for (const providerId of chain) {
      const lane = this.config.getLane(providerId, taskClass);
      if (!lane) continue;

      const health = this.config.healthFor(lane.id);
      if (!health) continue;

      // FR-2.6: never send a request we know is over the lane's size cap.
      // Groq has a hard 5,500-token limit; over that we skip it (no failed try).
      if (lane.limits.maxTokensPerRequest != null && baseEstimate > lane.limits.maxTokensPerRequest) {
        logEvent(`toobig:${lane.id}`, `lane ${lane.id} skipped: prompt ~${baseEstimate} tokens over cap ${lane.limits.maxTokensPerRequest}`);
        continue;
      }

      if (!isLaneUsable(lane, health, baseEstimate)) {
        logEvent(`unusable:${lane.id}`, `lane ${lane.id} not usable (quota/health)`);
        continue;
      }

      let req: ProviderRequest = {
        lane,
        messages,
        schema: options?.schema,
        maxTokens: options?.maxTokens,
      };

      for (let attempt = 0; attempt < MAX_RETRIES_PER_LANE; attempt++) {
        const estimate = estimateTokens(promptText(req.messages), expectedOutputTokens);
        const outcome = await this.config.sendVia(lane, req);
        this.config.onOutcome?.(lane, outcome, estimate);

        if (outcome.ok) {
          log.info(`[router] success via ${lane.id} (~${estimate} tokens est.)`);
          this.config.resetRetries(lane.id);
          return { ok: true, content: outcome.content, laneUsed: lane, promptTokens: estimate };
        }

        const err = outcome.error!;
        const action = classifyError(err);
        logEvent(`err:${lane.id}:${err.kind}`, `lane ${lane.id} error ${err.kind}: ${err.message}`);

        if (action.kind === "stopProvider" || action.kind === "skipLane" || action.kind === "nextLane") {
          if (action.kind === "stopProvider") {
            // Skip every remaining lane of this provider in this chain.
            log.warn(`[router] provider ${providerId} skipped: ${action.reason}`);
          }
          break; // move to next lane
        }

        if (action.kind === "shrinkAndRetry") {
          if (!shrinkTried) {
            shrinkTried = true;
            const smaller = shrinkPromptToTokens(fullPrompt, Math.floor(estimate * 0.6));
            log.info(`[router] 413 on ${lane.id}; retrying once with a smaller prompt (~${smaller.actualTokens} tokens)`);
            req = { ...req, messages: [{ role: "user", content: smaller.text }] };
            continue;
          }
          break; // already shrunk once -> skip this lane for this request
        }

        if (action.kind === "retrySame") {
          this.config.bumpRetries(lane.id);
          if (this.config.countRetries(lane.id) >= MAX_RETRIES_PER_LANE) {
            log.warn(`[router] lane ${lane.id} exhausted retries`);
            break;
          }
          await sleep(action.backoffMs);
          continue;
        }

        break; // fallback / unmapped -> next lane
      }
    }

    return {
      ok: false,
      error: { kind: "unmapped", message: `all lanes unavailable for task class ${taskClass}` },
    };
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
