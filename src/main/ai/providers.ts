import type { ModelConfigEntry } from "../../shared/electron-api-types";
import type { ProviderId, ProviderConfig, Lane, LaneLimits, LaneHealth } from "./types";
import { GROQ_MAX_REQUEST_TOKENS } from "./types";
import { DEFAULT_MODEL_ENTRIES } from "./model-settings";

// Editable defaults without hard-coded ":free" or deprecated preview slugs.
// User-editable model list lives in <userData>/models.json (model-settings.ts).

export const PROVIDER_CONFIGS: Record<ProviderId, ProviderConfig> = {
  gemini: {
    id: "gemini",
    label: "Google AI Studio (Gemini)",
    models: ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
    fallbackModels: ["gemini-2.5-flash-lite"],
    defaultRole: "general",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    models: [
      "meta-llama/llama-3.3-70b-instruct",
      "meta-llama/llama-3.2-3b-instruct",
      "qwen/qwen-2.5-7b-instruct",
    ],
    fallbackModels: ["meta-llama/llama-3.2-3b-instruct"],
    defaultRole: "general",
  },
  groq: {
    id: "groq",
    label: "Groq",
    models: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"],
    fallbackModels: ["openai/gpt-oss-20b"],
    defaultRole: "general",
  },
  // Only used when no real key is configured.
  offline: {
    id: "offline",
    label: "Offline (library defaults)",
    models: ["library-reasoning", "library-general", "library-autocomplete"],
    fallbackModels: ["library-general"],
    defaultRole: "general",
  },
};

export function defaultLaneLimits(provider: ProviderId, maxTokens?: number): LaneLimits {
  switch (provider) {
    case "gemini": {
      return {
        rpm: 10,
        rpd: 250,
        tpm: null,
        maxTokensPerRequest: maxTokens ?? 32768,
        resetHourUtc: 0,
      };
    }
    case "openrouter": {
      return {
        rpm: 20,
        rpd: 200,
        tpm: null,
        maxTokensPerRequest: maxTokens ?? 16384,
        resetHourUtc: 0,
      };
    }
    case "groq": {
      return {
        rpm: 30,
        rpd: Infinity,
        tpm: 12000,
        maxTokensPerRequest: Math.min(maxTokens ?? GROQ_MAX_REQUEST_TOKENS, GROQ_MAX_REQUEST_TOKENS),
        resetHourUtc: 0,
      };
    }
    case "offline": {
      return {
        rpm: 1000,
        rpd: Infinity,
        tpm: null,
        maxTokensPerRequest: null,
        resetHourUtc: 0,
      };
    }
  }
}

/**
 * Build the ordered lane list from user-editable ModelConfigEntry[] (sorted by priority),
 * plus the offline fallback lanes.
 */
export function buildLanes(entries: ModelConfigEntry[] = DEFAULT_MODEL_ENTRIES): Lane[] {
  const lanes: Lane[] = [];
  const sorted = [...entries].sort((a, b) => a.priority - b.priority);

  for (const entry of sorted) {
    const limits = defaultLaneLimits(entry.provider, entry.maxTokens);
    if (limits.rpm === 0 || (limits.rpd !== Infinity && limits.rpd === 0)) continue;

    const lower = entry.id.toLowerCase();
    const role: Lane["role"] =
      lower.includes("instant") || lower.includes("lite") || lower.includes("3b") || lower.includes("7b")
        ? "general"
        : "reasoning";

    lanes.push({
      id: `${entry.provider}:${entry.id}`,
      provider: entry.provider,
      model: entry.id,
      role,
      priority: entry.priority,
      maxTokens: entry.maxTokens,
      costTier: entry.costTier,
      limits,
    });
  }

  for (const model of PROVIDER_CONFIGS.offline.models) {
    const lower = model.toLowerCase();
    const role: Lane["role"] = lower.endsWith("autocomplete")
      ? "autocomplete"
      : lower.endsWith("reasoning")
      ? "reasoning"
      : "general";
    lanes.push({
      id: `offline:${model}`,
      provider: "offline",
      model,
      role,
      priority: 1000,
      limits: defaultLaneLimits("offline"),
    });
  }

  return lanes;
}

// isLaneUsable checks whether a lane can take a new request given its
// health state and the estimated token size of the request (FR-2.6).
export function isLaneUsable(
  lane: Lane,
  health: LaneHealth,
  estimatedTokens: number,
  now = Date.now(),
): boolean {
  if (health.deadSession) return false;
  if (health.deadUntil && now < health.deadUntil) return false;
  if (health.cooldownUntil && now < health.cooldownUntil) return false;
  if (health.removedUntil && now < health.removedUntil) return false;

  // RPM window (60s rolling).
  if (health.minuteRequestCount >= lane.limits.rpm) return false;

  // Groq TPM.
  if (lane.limits.tpm != null && health.minuteTokenCount >= lane.limits.tpm) return false;

  // Per-request token cap (FR-2.6).
  if (lane.limits.maxTokensPerRequest != null && estimatedTokens > lane.limits.maxTokensPerRequest) {
    return false;
  }

  return true;
}
