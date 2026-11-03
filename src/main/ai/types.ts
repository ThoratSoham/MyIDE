// Task class drives chain order (FR-3.1).
export type TaskClass = "reasoning" | "general" | "autocomplete";

// Lane = one provider + one model.
export interface Lane {
  id: string;
  provider: ProviderId;
  model: string;
  role: "reasoning" | "general" | "autocomplete";
  // Defaults from section 5. These are editable defaults; the ledger and
  // headers/error text can override them at runtime (FR-2.4).
  limits: LaneLimits;
}

export interface LaneLimits {
  rpm: number; // requests per minute
  rpd: number; // requests per day (Infinity = no daily cap)
  tpm: number | null; // tokens per minute (Groq enforces this)
  maxTokensPerRequest: number | null; // null = no hard cap from provider
  resetHourUtc: number; // hour of day (UTC) when the daily budget resets, 0-23
}

export type ProviderId = "gemini" | "openrouter" | "groq" | "offline";

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  // Models we actually use. Gemini Pro / customtools excluded (FR-2.2).
  models: string[];
  fallbackModels: string[];
  defaultRole: "reasoning" | "general" | "autocomplete";
}

// FR-2.6: Groq free tier hard cap. A request over this token count must
// never be sent to Groq. We route it elsewhere instead.
export const GROQ_MAX_REQUEST_TOKENS = 5500;

// FR-3.3 timeouts.
export const TIMEOUT_FIRST_BYTE_MS = 75000;
export const TIMEOUT_CHUNK_MS = 90000;

// Health state for a lane (FR-2.3, FR-2.5, FR-2.7). Used by the router to
// decide whether a lane is usable for a given request.
export interface LaneHealth {
  deadUntil: number | null; // epoch ms, 24h from a 403/404 (FR-2.7)
  removedUntil: number | null; // epoch ms, until daily reset (FR-2.5)
  minuteRequestCount: number;
  minuteTokenCount: number; // Groq TPM for the rolling minute
}

// Provider adapter request/response types (shared by real + stub adapters).
export interface ProviderRequest {
  lane: Lane;
  messages: Message[];
  schema?: object;
  temperature?: number;
  maxTokens?: number;
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ProviderOutcome =
  | { ok: true; content: string; usage?: { promptTokens: number; completionTokens: number } }
  | { ok: false; error: ProviderError };

export interface ProviderError {
  kind: "rateLimitMinute" | "rateLimitDay" | "tooBig" | "badRequest" | "unauthorized" | "modelDead" | "serverError" | "empty" | "networkError" | "timeout" | "unmapped";
  message: string;
  retryAfterMs?: number;
  waitUntilMs?: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface ProviderAdapter {
  providerId: ProviderId;
  name: string;
  send: (req: ProviderRequest) => Promise<ProviderOutcome>;
  discoverLimits?: (res: ProviderError) => Partial<LaneLimits> | null;
  configured: () => boolean;
}

// Per-provider usable model list (FR-2.1).
export function usableModels(
  config: { models: string[]; fallbackModels: string[] },
  alive: Set<string>,
): string[] {
  const aliveModels = config.models.filter((m) => alive.has(m));
  if (aliveModels.length > 0) return aliveModels;
  return config.fallbackModels.filter((m) => alive.has(m));
}
