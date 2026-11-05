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
  extractSuggestedModel,
  headerMap,
  openStream,
  parseRetryAfterMs,
  parseRetryTextMs,
  readText,
  sseData,
  StreamCancelledError,
  StreamTimeoutError,
  type Timeouts,
} from "./http";
import log from "electron-log";

const TIMEOUTS: Timeouts = {
  firstByteMs: TIMEOUT_FIRST_BYTE_MS,
  chunkMs: TIMEOUT_CHUNK_MS,
};

const DAY_MS = 86_400_000;

const MODEL_UNAVAILABLE_RE =
  /\bmodel\b[\s\S]{0,120}\b(unavailable|not\s+found|does\s+not\s+exist|decommission\w*|deprecated|no\s+endpoints|not\s+supported|unknown\s+model|invalid\s+model)\b|no\s+endpoints\s+found\s+for|this\s+model\s+is\s+unavailable|model_not_found|model_decommissioned/i;

// PART 1 #2: classify HTTP errors accurately by status code and body.
export function classifyHttpError(
  status: number,
  body: string,
  headers: Record<string, string>,
): ProviderError {
  const snippet = body.slice(0, 400);

  // 401 / 403 -> Stop and show "check your API key". Do NOT rotate through lanes.
  if (status === 401 || status === 403) {
    return {
      kind: "unauthorized",
      status,
      message: `Authentication failed (HTTP ${status}) — check your API key. ${snippet}`.trim(),
      headers,
      body: snippet,
    };
  }

  // 404 or 400 "model unavailable" -> permanently dead for session, extract suggested slug if any.
  if (status === 404 || (status === 400 && MODEL_UNAVAILABLE_RE.test(body))) {
    const suggestedModel = extractSuggestedModel(body);
    return {
      kind: "modelDead",
      status,
      message: `Model unavailable (HTTP ${status}): ${snippet}`,
      suggestedModel,
      headers,
      body: snippet,
    };
  }

  // 429 / quota -> honor Retry-After header, distinguish daily reset vs retryable cooldown.
  if (status === 429) {
    const waitMs = parseRetryAfterMs(headers) ?? parseRetryTextMs(body);
    const looksDaily = /per\s*day|perday|daily|\brpd\b|requests?\s*per\s*day|quota.*day/i.test(body);
    const veryLong = waitMs != null && waitMs > 5 * 60_000;
    if (looksDaily || veryLong) {
      return {
        kind: "rateLimitDay",
        status,
        message: `Daily quota exhausted (429): ${snippet}`,
        waitUntilMs: Date.now() + (waitMs ?? DAY_MS),
        retryAfterMs: waitMs ?? DAY_MS,
        headers,
        body: snippet,
      };
    }
    return {
      kind: "rateLimitMinute",
      status,
      message: `Rate limited (429): ${snippet}`,
      retryAfterMs: waitMs ?? undefined,
      headers,
      body: snippet,
    };
  }

  if (status === 413) {
    return { kind: "tooBig", status, message: `Request too large (413): ${snippet}`, headers, body: snippet };
  }
  if (status === 400) {
    return { kind: "badRequest", status, message: `Bad request (400): ${snippet}`, headers, body: snippet };
  }
  if (status >= 500) {
    return { kind: "serverError", status, message: `Server error (${status}): ${snippet}`, headers, body: snippet };
  }
  return { kind: "unmapped", status, message: `Unexpected status ${status}: ${snippet}`, headers, body: snippet };
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

  const orLimit = num("x-ratelimit-limit");
  if (orLimit != null && orLimit > 0) {
    out.rpm = orLimit;
    found = true;
  }

  return found ? out : null;
}

function toError(e: unknown): ProviderError {
  if (e instanceof StreamCancelledError || (e as Error)?.name === "StreamCancelledError") {
    return { kind: "cancelled", message: "Cancelled by user" };
  }
  if (e instanceof StreamTimeoutError) {
    return { kind: "timeout", message: e.message, retryAfterMs: 2_000 };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { kind: "networkError", message: `Network error: ${msg}` };
}

function ok(content: string, promptTokens = 0, completionTokens = 0): ProviderOutcome {
  if (!content.trim()) return { ok: false, error: { kind: "empty", message: "empty response" } };
  return { ok: true, content, usage: { promptTokens, completionTokens } };
}

/**
 * Format messages for OpenAI-compatible APIs, attaching prompt-caching markers
 * (`cache_control: { type: "ephemeral" }`) on the static system prompt when the
 * provider/model supports explicit prompt caching (e.g., Anthropic/Claude on OpenRouter),
 * while keeping the static prefix at index 0 for automatic prefix caching on Groq/OpenAI.
 */
function formatOpenAiMessages(
  messages: ProviderRequest["messages"],
  provider: "openrouter" | "groq",
  model: string,
  cacheStaticPrefix: boolean,
): Array<{ role: string; content: unknown }> {
  const supportsExplicitCacheControl =
    provider === "openrouter" &&
    cacheStaticPrefix &&
    /^(anthropic|google)\//i.test(model);

  return messages.map((m, idx) => {
    if (supportsExplicitCacheControl && idx === 0 && m.role === "system" && m.content.length >= 256) {
      return {
        role: m.role,
        content: [
          {
            type: "text",
            text: m.content,
            cache_control: { type: "ephemeral" },
          },
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

// ---------------------------------------------------------------------------
// OpenAI-compatible streaming (OpenRouter + Groq share this shape).
// ---------------------------------------------------------------------------

async function streamOpenAiCompatible(
  provider: "openrouter" | "groq",
  url: string,
  apiKey: string,
  model: string,
  req: ProviderRequest,
  extraHeaders: Record<string, string> = {},
): Promise<ProviderOutcome> {
  let res: Response;
  const allowJsonMode = Boolean(req.schema && req.lane.capabilities?.supportsJsonMode !== false);
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
          messages: formatOpenAiMessages(req.messages, provider, model, req.cacheStaticPrefix !== false),
          stream: true,
          temperature: req.temperature ?? 0.7,
          max_tokens: req.maxTokens ?? 2048,
          ...(allowJsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
      },
      TIMEOUTS,
      req.signal,
    );
    res = opened.res;
  } catch (e) {
    return { ok: false, error: toError(e) };
  }

  const headers = headerMap(res);

  if (!res.ok) {
    const body = await readText(res, TIMEOUT_CHUNK_MS, req.signal).catch(() => "");
    // If a free model rejects response_format: json_object with HTTP 400, remember and retry plain once!
    if (res.status === 400 && allowJsonMode && /response_format|json_object/i.test(body)) {
      if (req.lane.capabilities) req.lane.capabilities.supportsJsonMode = false;
      else req.lane.capabilities = { supportsJsonMode: false };
      return streamOpenAiCompatible(provider, url, apiKey, model, req, extraHeaders);
    }
    return { ok: false, error: classifyHttpError(res.status, body, headers) };
  }

  let content = "";
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    for await (const payload of sseData(res, TIMEOUT_CHUNK_MS, req.signal)) {
      if (payload === "[DONE]") break;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        content += delta;
        req.onDelta?.(delta);
      }
      if (json?.usage) {
        promptTokens = json.usage.prompt_tokens ?? promptTokens;
        completionTokens = json.usage.completion_tokens ?? completionTokens;
      }
    }
  } catch (e) {
    const err = toError(e);
    if (err.kind === "cancelled") return { ok: false, error: err };
    if (content.trim()) return { ok: true, content, usage: { promptTokens, completionTokens } };
    return { ok: false, error: err };
  }

  return ok(content, promptTokens, completionTokens);
}

// ---------------------------------------------------------------------------
// Gemini (Google AI Studio)
// ---------------------------------------------------------------------------

function hasClosedObjectProperties(node: unknown): boolean {
  if (!node || typeof node !== "object") return true;
  const rec = node as Record<string, unknown>;
  if (rec.type === "object") {
    const props = rec.properties as Record<string, unknown> | undefined;
    if (!props || Object.keys(props).length === 0) return false;
    return Object.values(props).every(hasClosedObjectProperties);
  }
  if (rec.type === "array" && rec.items) {
    return hasClosedObjectProperties(rec.items);
  }
  return true;
}

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

  const allowJsonMime = Boolean(req.schema && req.lane.capabilities?.supportsJsonMode !== false);
  const attachSchema = Boolean(
    allowJsonMime &&
      req.lane.capabilities?.supportsResponseSchema &&
      hasClosedObjectProperties(req.schema),
  );

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
            ...(allowJsonMime ? { responseMimeType: "application/json" } : {}),
            ...(attachSchema ? { responseSchema: req.schema } : {}),
          },
        }),
      },
      TIMEOUTS,
      req.signal,
    );
    res = opened.res;
  } catch (e) {
    return { ok: false, error: toError(e) };
  }

  const headers = headerMap(res);
  if (!res.ok) {
    const body = await readText(res, TIMEOUT_CHUNK_MS, req.signal).catch(() => "");
    return { ok: false, error: classifyHttpError(res.status, body, headers) };
  }

  let content = "";
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    for await (const payload of sseData(res, TIMEOUT_CHUNK_MS, req.signal)) {
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const parts = json?.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          if (typeof p?.text === "string" && p.text.length > 0) {
            content += p.text;
            req.onDelta?.(p.text);
          }
        }
      }
      const um = json?.usageMetadata;
      if (um) {
        promptTokens = um.promptTokenCount ?? promptTokens;
        completionTokens = um.candidatesTokenCount ?? completionTokens;
      }
    }
  } catch (e) {
    const err = toError(e);
    if (err.kind === "cancelled") return { ok: false, error: err };
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
        return {
          ok: false,
          error: { kind: "unauthorized", message: `No API key configured for ${providerId} — check your API key.` },
        };
      }

      switch (providerId) {
        case "gemini":
          return streamGemini(key, req.lane.model, req);
        case "openrouter":
          return streamOpenAiCompatible(
            "openrouter",
            "https://openrouter.ai/api/v1/chat/completions",
            key,
            req.lane.model,
            req,
            {
              "HTTP-Referer": "https://myide.local",
              "X-Title": "MyIDE",
            },
          );
        case "groq":
          return streamOpenAiCompatible(
            "groq",
            "https://api.groq.com/openai/v1/chat/completions",
            key,
            req.lane.model,
            req,
          );
        default: {
          log.warn(`real-providers: unknown provider ${providerId}`);
          return { ok: false, error: { kind: "unmapped", message: `unknown provider ${providerId}` } };
        }
      }
    },
  };
}

/**
 * Fetch the live model IDs from a provider's /models endpoint (with a short 10s timeout).
 */
export async function fetchProviderModelIds(
  provider: ProviderKeyId,
  apiKey: string | null,
): Promise<string[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    if (provider === "gemini") {
      if (!apiKey) return null;
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        { signal: ctrl.signal },
      );
      if (!res.ok) return null;
      const json: any = await res.json();
      return (json.models ?? []).map((m: any) => String(m.name).replace(/^models\//, ""));
    }
    if (provider === "openrouter") {
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch("https://openrouter.ai/api/v1/models", { headers, signal: ctrl.signal });
      if (!res.ok) return null;
      const json: any = await res.json();
      return (json.data ?? []).map((m: any) => String(m.id));
    }
    if (provider === "groq") {
      if (!apiKey) return null;
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const json: any = await res.json();
      return (json.data ?? []).map((m: any) => String(m.id));
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
      if (!res.ok) return { ok: false, message: `HTTP ${res.status} — check your API key` };
      const json: any = await res.json();
      const models = (json.models ?? []).map((m: any) => String(m.name).replace(/^models\//, ""));
      return { ok: true, message: `ok, ${models.length} models`, models };
    }
    if (provider === "openrouter") {
      const res = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status} — check your API key` };
      const json: any = await res.json();
      return { ok: true, message: `ok (${json?.data?.label ?? "key valid"})` };
    }
    if (provider === "groq") {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status} — check your API key` };
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
