import type { ProviderId, ProviderConfig, Lane, LaneLimits, LaneHealth } from "./types";

// Section 5 editable defaults. These match the PRD table.
// Gemini Pro (limit 0) and any model with limit 0 are never used (FR-2.2).

export const PROVIDER_CONFIGS: Record<ProviderId, ProviderConfig> = {
  gemini: {
    id: "gemini",
    label: "Google AI Studio (Gemini)",
    models: [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-3.5-flash",
      "gemini-3.6-flash",
      "gemini-3.8-flash",
    ],
    fallbackModels: ["gemini-2.5-flash-lite"],
    defaultRole: "general",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter (:free)",
    models: [
      "meta-llama/llama-3.2-3b-instruct:free",
      "meta-llama/llama-3.2-1b-instruct:free",
      "qwen/qwen3-0.6b:free",
    ],
    fallbackModels: ["meta-llama/llama-3.2-1b-instruct:free"],
    defaultRole: "general",
  },
  groq: {
    id: "groq",
    label: "Groq",
    models: [
      "llama-3.1-8b-instant",
      "llama-3.2-1b-preview",
      "llama-3.2-3b-preview",
    ],
    fallbackModels: ["llama-3.1-8b-instant"],
    defaultRole: "autocomplete",
  },
  // Only used when no real key is configured. It produces deterministic output
  // so the pipelines and the library fallback can still assemble a real page
  // (FR-7.6, "dumb model" test) without any provider access.
  offline: {
    id: "offline",
    label: "Offline (library defaults)",
    models: ["library-reasoning", "library-general", "library-autocomplete"],
    fallbackModels: ["library-general"],
    defaultRole: "general",
  },
};

// Default lane limits from section 5 (editable defaults).
export function defaultLaneLimits(provider: ProviderId): LaneLimits {
  switch (provider) {
    case "gemini": {
      // Flash full: ~5/min, ~20/day. Flash-Lite: ~10/min, ~500/day.
      // We treat Flash lanes as reasoning/general (hard steps) and
      // Flash-Lite as default worker.
      return {
        rpm: 5,
        rpd: 20,
        tpm: null,
        maxTokensPerRequest: null,
        resetHourUtc: 0,
      };
    }
    case "openrouter": {
      // 20/min, 50/day (1000/day only after $10 credit — never required).
      return {
        rpm: 20,
        rpd: 50,
        tpm: null,
        maxTokensPerRequest: null,
        resetHourUtc: 0,
      };
    }
    case "groq": {
      // 30/min, 8000 TPM per model, provider cap 8000 tokens/request.
      // MyIDE enforces a stricter 5,500 cap (FR-2.6) so we never send a
      // request near the 413 boundary.
      return {
        rpm: 30,
        rpd: Infinity,
        tpm: 8000,
        maxTokensPerRequest: 5500,
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

// Build the usable lane set from the provider model lists, excluding any
// model whose incoming limits resolve to 0 (FR-2.2).
export function buildLanes(): Lane[] {
  const lanes: Lane[] = [];

  for (const [provider, config] of Object.entries(PROVIDER_CONFIGS)) {
    for (const model of config.models) {
      const limits = defaultLaneLimits(provider as ProviderId);
      if (limits.rpm === 0 || (limits.rpd !== Infinity && limits.rpd === 0))
        continue;

      const lower = model.toLowerCase();
      let role: Lane["role"];
      if (provider === "offline") {
        role = lower.endsWith("autocomplete")
          ? "autocomplete"
          : lower.endsWith("reasoning")
          ? "reasoning"
          : "general";
      } else if (provider === "groq") {
        role = "autocomplete";
      } else {
        role = lower.includes("lite") ? "general" : "reasoning";
      }

      lanes.push({
        id: `${provider}:${model}`,
        provider: provider as ProviderId,
        model,
        role,
        limits,
      });
    }
  }

  return lanes;
}

// isLaneUsable checks whether a lane can take a new request given its
// health state and the estimated token size of the request (FR-2.6).
export function isLaneUsable(
  lane: Lane,
  health: LaneHealth,
  estimatedTokens: number,
): boolean {
  const now = Date.now();

  if (health.deadUntil && now < health.deadUntil) return false;
  if (health.removedUntil && now < health.removedUntil) return false;

  // RPM window (60s rolling).
  if (health.minuteRequestCount >= lane.limits.rpm) return false;

  // Groq TPM.
  if (lane.limits.tpm != null && health.minuteTokenCount >= lane.limits.tpm)
    return false;

  // Groq per-request hard cap (FR-2.6). Never send over the cap.
  if (
    lane.limits.maxTokensPerRequest != null &&
    estimatedTokens > lane.limits.maxTokensPerRequest
  )
    return false;

  return true;
}
