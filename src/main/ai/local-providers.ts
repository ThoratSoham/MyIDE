import {
  DEFAULT_SETTINGS,
  type LocalModelInfo,
  type LocalModelsState,
  type LocalModelTestResult,
  type LocalProviderId,
  type LocalRecommendedModel,
} from "../../shared/electron-api-types";
import {
  classifyHttpError,
} from "./real-providers";
import {
  headerMap,
  openStream,
  readText,
  sseData,
  StreamCancelledError,
  StreamTimeoutError,
  type Timeouts,
} from "./http";
import {
  TIMEOUT_CHUNK_MS,
  TIMEOUT_FIRST_BYTE_MS,
  type ProviderAdapter,
  type ProviderError,
  type ProviderOutcome,
  type ProviderRequest,
} from "./types";

const DETECT_TIMEOUT_MS = 900;

const LOCAL_STREAM_TIMEOUTS: Timeouts = {
  firstByteMs: TIMEOUT_FIRST_BYTE_MS,
  chunkMs: TIMEOUT_CHUNK_MS,
};

export const RECOMMENDED_LOCAL_CODER_MODELS: LocalRecommendedModel[] = [
  {
    id: "qwen2.5-coder:7b",
    label: "Qwen 2.5 Coder 7B",
    vramHint: "~5 GB VRAM / 8 GB RAM",
    description: "Strong structured JSON & multi-file code edits on consumer GPUs.",
  },
  {
    id: "deepseek-coder-v2:16b-lite-instruct-q4_0",
    label: "DeepSeek Coder V2 Lite",
    vramHint: "~9 GB VRAM / 16 GB RAM",
    description: "Fast MoE coder for TypeScript, React, and repair loops.",
  },
  {
    id: "qwen2.5-coder:3b",
    label: "Qwen 2.5 Coder 3B",
    vramHint: "~2.2 GB VRAM / CPU-friendly",
    description: "Compact coder for simple edits, summaries, and commit messages.",
  },
  {
    id: "llama3.2:3b",
    label: "Llama 3.2 3B Instruct",
    vramHint: "~2.0 GB VRAM / CPU-friendly",
    description: "Fast local lane for intent classification, history compression, and Q&A.",
  },
];

interface OllamaTagDetails {
  family?: string;
  parameter_size?: string;
}

interface OllamaTagModel {
  name?: string;
  model?: string;
  size?: number;
  details?: OllamaTagDetails;
}

interface OllamaTagsResponse {
  models?: OllamaTagModel[];
}

interface OpenAiModelItem {
  id?: string;
  owned_by?: string;
}

interface OpenAiModelsResponse {
  data?: OpenAiModelItem[];
}

interface OpenAiStreamChoice {
  delta?: { content?: string };
  message?: { content?: string };
}

interface OpenAiStreamChunk {
  choices?: OpenAiStreamChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export function normalizeOllamaRootUrl(raw?: string): string {
  const base = (raw || DEFAULT_SETTINGS.ollamaBaseUrl || "http://127.0.0.1:11434").trim();
  return base.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function normalizeLmStudioV1Url(raw?: string): string {
  const base = (raw || DEFAULT_SETTINGS.lmStudioBaseUrl || "http://127.0.0.1:1234").trim().replace(/\/+$/, "");
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

export function isEmbeddingModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes("embed") ||
    lower.includes("all-minilm") ||
    lower.includes("bge-") ||
    lower.includes("snowflake-arctic-embed")
  );
}

export function isModelCapableForEdits(
  modelId: string,
  parameterSize?: string,
  sizeBytes?: number,
): boolean {
  const lower = modelId.toLowerCase();
  if (isEmbeddingModel(lower)) return false;

  // Tiny sub-2B general models are kept for classify/summarize/chat only
  const isTiny = /(?:^|[:\-_/])(0\.5b|1b|1\.5b)(?:$|[:\-_/.])/i.test(lower);
  const isCoder = /coder|codestral|deepseek|starcoder|devstral/i.test(lower);
  if (isTiny && !isCoder) return false;
  if (isCoder) return true;

  if (parameterSize) {
    const m = /(\d+(?:\.\d+)?)\s*b/i.exec(parameterSize);
    if (m && Number(m[1]) >= 6) return true;
  }
  const sizeFromId = /(?:^|[:\-_/])(\d+(?:\.\d+)?)b(?:$|[:\-_/.])/i.exec(lower);
  if (sizeFromId && Number(sizeFromId[1]) >= 6) return true;
  if (typeof sizeBytes === "number" && sizeBytes >= 3_500_000_000) return true;

  return /qwen2\.5|qwen3|llama-?3\.[13]|gemma-?[23]|phi-?4|mistral/i.test(lower);
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<{ ok: boolean; data?: T }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false };
    const json = (await res.json()) as T;
    return { ok: true, data: json };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function probeOllama(ollamaRootUrl: string, timeoutMs: number): Promise<{ online: boolean; models: LocalModelInfo[] }> {
  const tags = await fetchJsonWithTimeout<OllamaTagsResponse>(`${ollamaRootUrl}/api/tags`, timeoutMs);
  if (tags.ok && tags.data) {
    const rawModels = Array.isArray(tags.data.models) ? tags.data.models : [];
    const models: LocalModelInfo[] = [];
    for (const item of rawModels) {
      const id = (item.name ?? item.model ?? "").trim();
      if (!id || isEmbeddingModel(id)) continue;
      models.push({
        id,
        provider: "ollama",
        sizeBytes: typeof item.size === "number" ? item.size : undefined,
        family: item.details?.family,
        capableForEdits: isModelCapableForEdits(id, item.details?.parameter_size, item.size),
      });
    }
    return { online: true, models };
  }

  // Fallback for OpenAI-compatible Ollama proxies exposing /v1/models only
  const v1 = await fetchJsonWithTimeout<OpenAiModelsResponse>(`${ollamaRootUrl}/v1/models`, timeoutMs);
  if (v1.ok && v1.data) {
    const rawModels = Array.isArray(v1.data.data) ? v1.data.data : [];
    const models: LocalModelInfo[] = [];
    for (const item of rawModels) {
      const id = (item.id ?? "").trim();
      if (!id || isEmbeddingModel(id)) continue;
      models.push({
        id,
        provider: "ollama",
        capableForEdits: isModelCapableForEdits(id),
      });
    }
    return { online: true, models };
  }

  return { online: false, models: [] };
}

async function probeLmStudio(lmStudioV1Url: string, timeoutMs: number): Promise<{ online: boolean; models: LocalModelInfo[] }> {
  const v1 = await fetchJsonWithTimeout<OpenAiModelsResponse>(`${lmStudioV1Url}/models`, timeoutMs);
  if (!v1.ok || !v1.data) {
    return { online: false, models: [] };
  }
  const rawModels = Array.isArray(v1.data.data) ? v1.data.data : [];
  const models: LocalModelInfo[] = [];
  for (const item of rawModels) {
    const id = (item.id ?? "").trim();
    if (!id || isEmbeddingModel(id)) continue;
    models.push({
      id,
      provider: "lmstudio",
      capableForEdits: isModelCapableForEdits(id),
    });
  }
  return { online: true, models };
}

export interface DetectLocalModelsOptions {
  enabled?: boolean;
  ollamaUrl?: string;
  lmStudioUrl?: string;
  selectedModel?: string;
  timeoutMs?: number;
}

export async function detectLocalModels(opts?: DetectLocalModelsOptions): Promise<LocalModelsState> {
  const enabled = opts?.enabled !== false;
  const ollamaRoot = normalizeOllamaRootUrl(opts?.ollamaUrl);
  const lmStudioV1 = normalizeLmStudioV1Url(opts?.lmStudioUrl);
  const timeoutMs = opts?.timeoutMs ?? DETECT_TIMEOUT_MS;

  if (!enabled) {
    return {
      enabled: false,
      ollamaUrl: ollamaRoot,
      ollamaOnline: false,
      lmStudioUrl: lmStudioV1,
      lmStudioOnline: false,
      selectedModel: opts?.selectedModel ?? "",
      models: [],
      recommended: RECOMMENDED_LOCAL_CODER_MODELS,
      checkedAt: Date.now(),
    };
  }

  const [ollamaRes, lmStudioRes] = await Promise.all([
    probeOllama(ollamaRoot, timeoutMs),
    probeLmStudio(lmStudioV1, timeoutMs),
  ]);

  return {
    enabled: true,
    ollamaUrl: ollamaRoot,
    ollamaOnline: ollamaRes.online,
    lmStudioUrl: lmStudioV1,
    lmStudioOnline: lmStudioRes.online,
    selectedModel: opts?.selectedModel ?? "",
    models: [...ollamaRes.models, ...lmStudioRes.models],
    recommended: RECOMMENDED_LOCAL_CODER_MODELS,
    checkedAt: Date.now(),
  };
}

function toProviderError(e: unknown): ProviderError {
  if (e instanceof StreamCancelledError || (e instanceof Error && e.name === "StreamCancelledError")) {
    return { kind: "cancelled", message: "Cancelled by user" };
  }
  if (e instanceof StreamTimeoutError) {
    return { kind: "timeout", message: e.message, retryAfterMs: 2_000 };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { kind: "networkError", message: `Local model error: ${msg}` };
}

export async function streamLocalOpenAiCompatible(
  chatCompletionsUrl: string,
  model: string,
  req: ProviderRequest,
): Promise<ProviderOutcome> {
  let res: Response;
  const allowJsonMode = Boolean(req.schema && req.lane.capabilities?.supportsJsonMode !== false);

  try {
    const opened = await openStream(
      chatCompletionsUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          temperature: req.temperature ?? 0.3,
          max_tokens: req.maxTokens ?? 2048,
          ...(allowJsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
      },
      LOCAL_STREAM_TIMEOUTS,
      req.signal,
    );
    res = opened.res;
  } catch (e) {
    return { ok: false, error: toProviderError(e) };
  }

  const headers = headerMap(res);

  if (!res.ok) {
    const body = await readText(res, TIMEOUT_CHUNK_MS, req.signal).catch(() => "");
    if (res.status === 400 && allowJsonMode && /response_format|json_object|grammar/i.test(body)) {
      if (req.lane.capabilities) req.lane.capabilities.supportsJsonMode = false;
      else req.lane.capabilities = { supportsJsonMode: false };
      return streamLocalOpenAiCompatible(chatCompletionsUrl, model, req);
    }
    return { ok: false, error: classifyHttpError(res.status, body, headers) };
  }

  const contentType = (headers["content-type"] ?? "").toLowerCase();
  if (contentType.includes("application/json") && !contentType.includes("event-stream")) {
    try {
      const rawText = await readText(res, TIMEOUT_CHUNK_MS, req.signal);
      const parsed = JSON.parse(rawText) as OpenAiStreamChunk;
      const text =
        parsed.choices?.[0]?.message?.content ??
        parsed.choices?.[0]?.delta?.content ??
        "";
      if (!text.trim()) {
        return { ok: false, error: { kind: "empty", message: "Empty response from local model" } };
      }
      req.onDelta?.(text);
      return {
        ok: true,
        content: text,
        usage: {
          promptTokens: parsed.usage?.prompt_tokens ?? 0,
          completionTokens: parsed.usage?.completion_tokens ?? 0,
        },
      };
    } catch (e) {
      return { ok: false, error: toProviderError(e) };
    }
  }

  let content = "";
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    for await (const payload of sseData(res, TIMEOUT_CHUNK_MS, req.signal)) {
      if (payload === "[DONE]") break;
      let chunk: OpenAiStreamChunk;
      try {
        chunk = JSON.parse(payload) as OpenAiStreamChunk;
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content;
      if (typeof delta === "string" && delta.length > 0) {
        content += delta;
        req.onDelta?.(delta);
      }
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        completionTokens = chunk.usage.completion_tokens ?? completionTokens;
      }
    }
  } catch (e) {
    const err = toProviderError(e);
    if (err.kind === "cancelled") return { ok: false, error: err };
    if (content.trim()) return { ok: true, content, usage: { promptTokens, completionTokens } };
    return { ok: false, error: err };
  }

  if (!content.trim()) {
    return { ok: false, error: { kind: "empty", message: "Empty response from local model" } };
  }
  return { ok: true, content, usage: { promptTokens, completionTokens } };
}

export interface LocalAdapterConfig {
  getOllamaUrl: () => string;
  getLmStudioUrl: () => string;
  isProviderOnline: (provider: LocalProviderId) => boolean;
}

export function makeLocalProviders(cfg: LocalAdapterConfig): Map<LocalProviderId, ProviderAdapter> {
  const map = new Map<LocalProviderId, ProviderAdapter>();

  map.set("ollama", {
    providerId: "ollama",
    name: "Ollama (Local)",
    configured: () => cfg.isProviderOnline("ollama"),
    send: (req) => {
      const root = normalizeOllamaRootUrl(cfg.getOllamaUrl());
      return streamLocalOpenAiCompatible(`${root}/v1/chat/completions`, req.lane.model, req);
    },
  });

  map.set("lmstudio", {
    providerId: "lmstudio",
    name: "LM Studio (Local)",
    configured: () => cfg.isProviderOnline("lmstudio"),
    send: (req) => {
      const v1 = normalizeLmStudioV1Url(cfg.getLmStudioUrl());
      return streamLocalOpenAiCompatible(`${v1}/chat/completions`, req.lane.model, req);
    },
  });

  return map;
}

export async function testLocalModel(
  provider: LocalProviderId,
  model?: string,
  opts?: { ollamaUrl?: string; lmStudioUrl?: string; timeoutMs?: number },
): Promise<LocalModelTestResult> {
  const startedAt = Date.now();
  const detected = await detectLocalModels({
    enabled: true,
    ollamaUrl: opts?.ollamaUrl,
    lmStudioUrl: opts?.lmStudioUrl,
    timeoutMs: opts?.timeoutMs ?? 1500,
  });

  const isOnline = provider === "ollama" ? detected.ollamaOnline : detected.lmStudioOnline;
  if (!isOnline) {
    return {
      provider,
      model: model ?? "",
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: `${provider === "ollama" ? "Ollama" : "LM Studio"} server is not reachable`,
    };
  }

  const providerModels = detected.models.filter((m) => m.provider === provider);
  const chosenModel =
    (model && providerModels.find((m) => m.id === model)?.id) ??
    model?.trim() ??
    providerModels[0]?.id ??
    "";

  if (!chosenModel) {
    return {
      provider,
      model: "",
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: `Server is online, but no chat models are installed`,
    };
  }

  const chatUrl =
    provider === "ollama"
      ? `${detected.ollamaUrl}/v1/chat/completions`
      : `${detected.lmStudioUrl}/chat/completions`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 12_000);
  try {
    const res = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: chosenModel,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        stream: false,
        max_tokens: 12,
        temperature: 0,
      }),
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return {
        provider,
        model: chosenModel,
        ok: false,
        latencyMs,
        message: `HTTP ${res.status}: ${txt.slice(0, 120) || "request failed"}`,
      };
    }
    const json = (await res.json().catch(() => ({}))) as OpenAiStreamChunk;
    const reply = (json.choices?.[0]?.message?.content ?? "OK").trim().slice(0, 40);
    return {
      provider,
      model: chosenModel,
      ok: true,
      latencyMs,
      message: `${chosenModel} responded ("${reply}") in ${latencyMs}ms`,
    };
  } catch (e) {
    return {
      provider,
      model: chosenModel,
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

