import type { Lane, ProviderId, ProviderOutcome, ProviderError, ProviderRequest, ProviderAdapter, LaneLimits } from "./types";

// The contract every provider (real or stub) implements. This is the seam
// we wire the router to, and the same seam the real-API adapters will
// implement once keys are live.

export { type ProviderRequest, type ProviderOutcome, type ProviderError, type ProviderAdapter, type Lane, type ProviderId } from "./types";

export interface ProviderRequestEx extends ProviderRequest {}

// Minimal default: every provider must expose the list of model ids it knows
// are usable. FR-2.1: find usable models, keep a small fallback list.
export function usableModels(
  config: { models: string[]; fallbackModels: string[] },
  alive: Set<string>,
): string[] {
  const aliveModels = config.models.filter((m) => alive.has(m));
  if (aliveModels.length > 0) return aliveModels;
  return config.fallbackModels.filter((m) => alive.has(m));
}
