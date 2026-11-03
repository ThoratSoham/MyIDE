import type { Lane, ProviderId, ProviderOutcome, ProviderError, ProviderRequest, ProviderAdapter } from "./types";
import log from "electron-log";

// Deterministic stub providers for development and for exercising the router's
// error rules without live keys. They implement the same ProviderAdapter
// interface a real Gemini / OpenRouter / Groq adapter would.

export type StubScenario = "ok" | "rateLimitMinute" | "rateLimitDay" | "tooBig" | "badRequest" | "unauthorized" | "modelDead" | "serverError" | "empty" | "networkError" | "timeout";

export interface StubConfig {
  // Per (providerId:laneId) mapping to the scenario to return.
  map: Record<string, StubScenario>;
  // Optional body to return on ok.
  okBody?: string;
  // How long fake requests take (ms) when they don't fail fast.
  delayMs?: number;
}

const defaultOkBody = JSON.stringify({ ok: true, note: "stub response" });

export function makeStubProvider(
  providerId: ProviderId,
  config: StubConfig,
): ProviderAdapter {
  const delay = config.delayMs ?? 60;

  return {
    providerId,
    name: `stub-${providerId}`,
    configured: () => true,

    async send(req: ProviderRequest): Promise<ProviderOutcome> {
      const key = `${providerId}:${req.lane.id}`;
      const scenario = config.map[key] ?? config.map[providerId] ?? "ok";

      await sleep(Math.min(delay, 150));

      switch (scenario) {
        case "ok": {
          return ok({
            content: config.okBody ?? defaultOkBody,
            promptTokens: estimate(req.messages),
            completionTokens: 64,
          });
        }
        case "rateLimitMinute":
          return err({
            kind: "rateLimitMinute",
            message: "too many requests (per minute)",
            retryAfterMs: 5_000,
          });
        case "rateLimitDay":
          return err({
            kind: "rateLimitDay",
            message: "daily quota exhausted",
            waitUntilMs: Date.now() + 3600_000,
          });
        case "tooBig":
          return err({
            kind: "tooBig",
            message: "request too large (413)",
          });
        case "badRequest":
          return err({ kind: "badRequest", message: "bad request (400)" });
        case "unauthorized":
          return err({ kind: "unauthorized", message: "unauthorized or missing key (401)" });
        case "modelDead":
          return err({ kind: "modelDead", message: "model unavailable (404)" });
        case "serverError":
          return err({ kind: "serverError", message: "server error (500)", retryAfterMs: 2_000 });
        case "empty":
          return err({ kind: "empty", message: "empty response" });
        case "networkError":
          return err({ kind: "networkError", message: "network error" });
        case "timeout":
          return err({ kind: "timeout", message: "request timed out", retryAfterMs: 5_000 });
        default:
          return err({ kind: "unmapped", message: "unknown stub scenario" });
      }
    },
  };
}

function ok(opts: { content: string; promptTokens: number; completionTokens: number }): ProviderOutcome {
  return { ok: true, content: opts.content, usage: { promptTokens: opts.promptTokens, completionTokens: opts.completionTokens } };
}

function err(e: ProviderError): ProviderOutcome {
  return { ok: false, error: e };
}

function estimate(messages: ProviderRequest["messages"]): number {
  return messages.reduce<number>((n, m) => n + m.content.length, 0);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// A helper to build a realistic multi-provider stub bus for router tests.
export function stubBus(scenarios: Partial<Record<ProviderId, Record<string, StubScenario>>>): Map<ProviderId, ProviderAdapter> {
  const bus = new Map<ProviderId, ProviderAdapter>();
  for (const [providerId, perLane] of Object.entries(scenarios)) {
    bus.set(providerId as ProviderId, makeStubProvider(providerId as ProviderId, { map: perLane ?? {} }));
  }
  return bus;
}
