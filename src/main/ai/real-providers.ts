import type {
  LaneLimits,
  ProviderAdapter,
  ProviderError,
  ProviderId,
  ProviderOutcome,
  ProviderRequest,
} from "./types";
import { TIMEOUT_CHUNK_MS, TIMEOUT_FIRST_BYTE_MS } from "./types";
import { getProviderKey, type ProviderKeyId } from "../store";
import {
  headerMap,
  openStream,
  parseRetryAfterMs,
  parseRetryTextMs,
  readText,
  sseData,
  StreamTimeoutError,
  type Timeouts,
} from "./http";
import log from "electron-log";

const TIMEOUTS: Timeouts = {
  firstByteMs: TIMEOUT_FIRST_BYTE_MS,
  chunkMs: TIMEOUT_CHUNK_MS,
};

const DAY_MS = 86_400_000;

// Section 11: turn an HTTP status + body into the routing classification.
export function classifyHttpError(
  status: number,
  body: string,
  headers: Record<string, string>,
): ProviderError {
  const snippet = body.slice(0, 400);

  if (status === 429) {
    const waitMs = parseRetryAfterMs(headers) ?? parseRetryTextMs(body);
    const looksDaily = /per\s*day|perday|daily|\brpd\b|requests?\s*per\s*day|quota.*day/i.test(body);
    const veryLong = waitMs != null && waitMs > 5 * 60_000;
    if (looksDaily || veryLong) {
      return {
        kind: "rateLimitDay",
        message: `daily quota exhausted (429): ${snippet}`,
        waitUntilMs: Date.now() + (waitMs ?? DAY_MS),
        headers,
        body: snippet,
      };
    }
    return {
      kind: "rateLimitMinute",
      message: `rate limited (429): ${snippet}`,
      retryAfterMs: waitMs ?? 10_000,
      headers,
      body: snippet,
    };
  }

  if (status === 413) return { kind: "tooBig", message: `request too large (413): ${snippet}`, headers, body: snippet };
  if (status === 400) return { kind: "badRequest", message: `bad request (400): ${snippet}`, headers, body: snippet };
  if (status === 401) return { kind: "unauthorized", message: `unauthorized (401): ${snippet}`, headers, body: snippet };
  if (status === 403 || status === 404) {
    return { kind: "modelDead", message: `model unavailable (${status}): ${snippet}`, headers, body: snippet };
  }
  if (status >= 500) return { kind: "serverError", message: `server error (${status}): ${snippet}`, headers, body: snippet };
  return { kind: "unmapped", message: `unexpected status ${status}: ${snippet}`, headers, body: snippet };
}

// FR-2.4: learn real limits from response headers when a provider tells us.
export function discoverLimitsFromHeaders(headers: Record<string, string>): Partial<LaneLimits> | null {
  const out: Partial<LaneLimits> = {};
  let found = false;

  const num = (k: string) => {
    const v = headers[k];
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // Groq: x-ratelimit-limit-requests / x-ratelimit-limit-tokens (per minute).
  const groqRpm = num("x-ratelimit-limit-requests");
  const groqTpm = num("x-ratelimit-limit-tokens");
  if (groqRpm != null && groqRpm > 0) {
    out.rpm = groqRpm;
    found = true;
  }
  if (groqTpm != null && groqTpm > 0) {
    out.tpm = groqTpm;
    found = true;
  }

  // OpenRouter: x-ratelimit-limit / x-ratelimit-remaining (per minute).
  const orLimit = num("x-ratelimit-limit");
  if (orLimit != null && orLimit > 0) {
    out.rpm = orLimit;
    found = true;
  }

  return found ? out : null;
}

function toError(e: unknown): ProviderError {
  if (e instanceof StreamTimeoutError) {
    return { kind: "timeout", message: e.message, retryAfterMs: 5_000 };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { kind: "networkError", message: `network error: ${msg}` };
}

function ok(content: string, promptTokens = 0, completionTokens = 0): ProviderOutcome {
  if (!content.trim()) return { ok: false, error: { kind: "empty", message: "empty response" } };
  return { ok: true, content, usage: { promptTokens, completionTokens } };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible streaming (OpenRouter + Groq share this shape).
// ---------------------------------------------------------------------------

async function streamOpenAiCompatible(
  url: string,
  apiKey: string,
  model: string,
  req: ProviderRequest,
  extraHeaders: Record<string, string> = {},
): Promise<ProviderOutcome> {
  let res: Response;
  try {
    const opened = await openStream(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...extraHeaders,
        },
        body: JSON.stringify({
          model,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          temperature: req.temperature ?? 0.7,
          max_tokens: req.maxTokens ?? 2048,
          ...(req.schema ? { response_format: { type: "json_object" } } : {}),
        }),
      },
      TIMEOUTS,
    );
    res = opened.res;
  } catch (e) {
    return { ok: false, error: toError(e) };
  }

  const headers = headerMap(res);

  if (!res.ok) {
    const body = await readText(res, TIMEOUT_CHUNK_MS).catch(() => "");
    return { ok: false, error: classifyHttpError(res.status, body, headers) };
  }

  let content = "";
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    for await (const payload of sseData(res, TIMEOUT_CHUNK_MS)) {
      if (payload === "[DONE]") break;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === "string") content += delta;
      if (json?.usage) {
        promptTokens = json.usage.prompt_tokens ?? promptTokens;
        completionTokens = json.usage.completion_tokens ?? completionTokens;
      }
    }
  } catch (e) {
    const err = toError(e);
    if (content.trim()) return { ok: true, content, usage: { promptTokens, completionTokens } };
    return { ok: false, error: err };
  }

  return ok(content, promptTokens, completionTokens);
}

// ---------------------------------------------------------------------------
// Gemini (Google AI Studio)
// ---------------------------------------------------------------------------

async function streamGemini(apiKey: string, model: string, req: ProviderRequest): Promise<ProviderOutcome> {
  const systemParts = req.messages.filter((m) => m.role === "system").map((m) => ({ text: m.content }));
  const contents = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:streamGenerateContent?alt=sse`;

  let res: Response;
  try {
    const opened = await openStream(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents,
          ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
          generationConfig: {
            temperature: req.temperature ?? 0.7,
            maxOutputTokens: req.maxTokens ?? 2048,
            ...(req.schema ? { responseMimeType: "application/json" } : {}),
          },
        }),
      },
      TIMEOUTS,
    );
    res = opened.res;
  } catch (e) {
    return { ok: false, error: toError(e) };
  }

  const headers = headerMap(res);
  if (!res.ok) {
    const body = await readText(res, TIMEOUT_CHUNK_MS).catch(() => "");
    return { ok: false, error: classifyHttpError(res.status, body, headers) };
  }

  let content = "";
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    for await (const payload of sseData(res, TIMEOUT_CHUNK_MS)) {
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const parts = json?.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) if (typeof p?.text === "string") content += p.text;
      }
      const um = json?.usageMetadata;
      if (um) {
        promptTokens = um.promptTokenCount ?? promptTokens;
        completionTokens = um.candidatesTokenCount ?? completionTokens;
      }
    }
  } catch (e) {
    const err = toError(e);
    if (content.trim()) return { ok: true, content, usage: { promptTokens, completionTokens } };
    return { ok: false, error: err };
  }

  return ok(content, promptTokens, completionTokens);
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function makeAdapter(providerId: ProviderKeyId): ProviderAdapter {
  return {
    providerId,
    name: providerId,
    configured: () => !!getProviderKey(providerId),
    discoverLimits: (err) => (err.headers ? discoverLimitsFromHeaders(err.headers) : null),
    async send(req: ProviderRequest): Promise<ProviderOutcome> {
      const key = getProviderKey(providerId);
      if (!key) {
        return { ok: false, error: { kind: "unauthorized", message: `no key configured for ${providerId}` } };
      }

      switch (providerId) {
        case "gemini":
          return streamGemini(key, req.lane.model, req);
        case "openrouter":
          return streamOpenAiCompatible("https://openrouter.ai/api/v1/chat/completions", key, req.lane.model, req, {
            "HTTP-Referer": "https://myide.local",
            "X-Title": "MyIDE",
          });
        case "groq":
          return streamOpenAiCompatible("https://api.groq.com/openai/v1/chat/completions", key, req.lane.model, req);
        default: {
          log.warn(`real-providers: unknown provider ${providerId}`);
          return { ok: false, error: { kind: "unmapped", message: `unknown provider ${providerId}` } };
        }
      }
    },
  };
}

// FR-2.8: "Test my keys" pings each configured provider's model list.
export async function testProviderKey(
  provider: ProviderKeyId,
  apiKey: string,
): Promise<{ ok: boolean; message: string; models?: string[] }> {
  try {
    if (provider === "gemini") {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      );
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      const json: any = await res.json();
      const models = (json.models ?? []).map((m: any) => String(m.name).replace(/^models\//, ""));
      return { ok: true, message: `ok, ${models.length} models`, models };
    }
    if (provider === "openrouter") {
      const res = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      const json: any = await res.json();
      return { ok: true, message: `ok (${json?.data?.label ?? "key valid"})` };
    }
    if (provider === "groq") {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      const json: any = await res.json();
      const models = (json.data ?? []).map((m: any) => m.id);
      return { ok: true, message: `ok, ${models.length} models`, models };
    }
    return { ok: false, message: "unknown provider" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export function makeRealProviders(): Map<ProviderId, ProviderAdapter> {
  return new Map<ProviderId, ProviderAdapter>([
    ["gemini", makeAdapter("gemini")],
    ["openrouter", makeAdapter("openrouter")],
    ["groq", makeAdapter("groq")],
  ]);
}
