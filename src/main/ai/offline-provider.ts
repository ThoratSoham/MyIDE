import type { ProviderAdapter, ProviderOutcome, ProviderRequest } from "./types";

// Deterministic adapter used only when no real provider key is configured.
// It returns an empty JSON object for structured requests so the stage runner's
// library fallback supplies safe defaults (FR-7.6). It never pretends to be a
// real model: the UI labels it "Offline (library defaults)".
export function makeOfflineProvider(): ProviderAdapter {
  return {
    providerId: "offline",
    name: "offline",
    configured: () => true,
    async send(_req: ProviderRequest): Promise<ProviderOutcome> {
      return { ok: true, content: "{}", usage: { promptTokens: 0, completionTokens: 0 } };
    },
  };
}
