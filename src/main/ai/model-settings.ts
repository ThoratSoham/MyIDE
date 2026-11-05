import fs from "fs";
import path from "path";
import { app } from "electron";
import log from "electron-log";
import type {
  CostTier,
  DroppedModelInfo,
  ModelConfigEntry,
  ProviderKeyId,
} from "../../shared/electron-api-types";
import { getProviderKey } from "../store";
import { fetchProviderModelIds } from "./real-providers";

// PART 1 #3: User-editable model list stored in <userData>/models.json with
// fields: id, provider, priority, maxTokens, costTier. No hard-coded ":free" slugs.
// Live provider model catalogs are fetched on startup, cached for 1 hour, and
// any configured slug that no longer exists in the live catalog is dropped.

export const MODEL_CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour

export const DEFAULT_MODEL_ENTRIES: ModelConfigEntry[] = [
  { id: "gemini-3.8-flash", provider: "gemini", priority: 1, maxTokens: 32768, costTier: "free", supportsJsonMode: true, supportsResponseSchema: true },
  { id: "gemini-2.5-flash", provider: "gemini", priority: 2, maxTokens: 32768, costTier: "free", supportsJsonMode: true, supportsResponseSchema: true },
  { id: "gemini-2.5-flash-lite", provider: "gemini", priority: 3, maxTokens: 32768, costTier: "free", supportsJsonMode: true, supportsResponseSchema: true, taskClasses: ["classify", "summarize", "chat", "autocomplete"] },
  { id: "openai/gpt-oss-120b", provider: "groq", priority: 4, maxTokens: 5500, costTier: "free", supportsJsonMode: true },
  { id: "qwen/qwen3.8-27b", provider: "groq", priority: 5, maxTokens: 5500, costTier: "free", supportsJsonMode: true },
  { id: "openai/gpt-oss-20b", provider: "groq", priority: 6, maxTokens: 5500, costTier: "free", supportsJsonMode: true, taskClasses: ["classify", "summarize", "chat", "autocomplete"] },
  { id: "meta-llama/llama-3.3-70b-instruct", provider: "openrouter", priority: 7, maxTokens: 16384, costTier: "low", supportsJsonMode: true },
  { id: "meta-llama/llama-3.2-3b-instruct", provider: "openrouter", priority: 8, maxTokens: 16384, costTier: "low", taskClasses: ["classify", "summarize", "chat", "autocomplete"] },
  { id: "qwen/qwen-2.5-7b-instruct", provider: "openrouter", priority: 9, maxTokens: 16384, costTier: "low", supportsJsonMode: true },
];

interface ModelsFileShape {
  version: 1;
  models: ModelConfigEntry[];
}

interface CatalogCacheEntry {
  fetchedAt: number;
  models: string[];
}

type CatalogCacheShape = Partial<Record<ProviderKeyId, CatalogCacheEntry>>;

let memoryCatalogCache: CatalogCacheShape | null = null;

export function modelsFilePath(): string {
  return path.join(app.getPath("userData"), "models.json");
}

function catalogCachePath(): string {
  return path.join(app.getPath("userData"), "model-catalog-cache.json");
}

function isValidProvider(p: unknown): p is ProviderKeyId {
  return p === "gemini" || p === "openrouter" || p === "groq";
}

function isValidCostTier(c: unknown): c is CostTier {
  return c === "free" || c === "low" || c === "medium" || c === "high";
}

export function normalizeModelEntries(raw: unknown): ModelConfigEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelConfigEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Partial<ModelConfigEntry> | null;
    if (!item || typeof item.id !== "string" || !item.id.trim()) continue;
    if (!isValidProvider(item.provider)) continue;
    const id = item.id.trim();
    const key = `${item.provider}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const priority = Number.isFinite(Number(item.priority)) ? Number(item.priority) : i + 1;
    const defaultMax = item.provider === "groq" ? 5500 : 16384;
    const maxTokens =
      Number.isFinite(Number(item.maxTokens)) && Number(item.maxTokens) > 0
        ? Math.floor(Number(item.maxTokens))
        : defaultMax;
    const costTier: CostTier = isValidCostTier(item.costTier) ? item.costTier : "free";
    out.push({
      id,
      provider: item.provider,
      priority,
      maxTokens,
      costTier,
      ...(typeof item.supportsJsonMode === "boolean" ? { supportsJsonMode: item.supportsJsonMode } : {}),
      ...(typeof item.supportsResponseSchema === "boolean" ? { supportsResponseSchema: item.supportsResponseSchema } : {}),
      ...(typeof item.supportsNativeTools === "boolean" ? { supportsNativeTools: item.supportsNativeTools } : {}),
      ...(Array.isArray(item.taskClasses)
        ? { taskClasses: item.taskClasses.filter((t): t is string => typeof t === "string") }
        : {}),
    });
  }
  return out.sort((a, b) => a.priority - b.priority);
}

export function loadModelSettings(): ModelConfigEntry[] {
  const f = modelsFilePath();
  if (!fs.existsSync(f)) {
    saveModelSettings(DEFAULT_MODEL_ENTRIES);
    return DEFAULT_MODEL_ENTRIES.map((m) => ({ ...m }));
  }
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    const arr = Array.isArray(raw) ? raw : (raw as ModelsFileShape)?.models;
    const normalized = normalizeModelEntries(arr);
    if (normalized.length > 0) return normalized;
  } catch (e) {
    log.warn("model-settings: could not parse models.json, using defaults", e);
  }
  return DEFAULT_MODEL_ENTRIES.map((m) => ({ ...m }));
}

export function saveModelSettings(entries: ModelConfigEntry[]): ModelConfigEntry[] {
  const normalized = normalizeModelEntries(entries);
  const f = modelsFilePath();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    const payload: ModelsFileShape = { version: 1, models: normalized };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmp, f);
  } catch (e) {
    log.warn("model-settings: could not write models.json", e);
  }
  return normalized;
}

export function replaceOrAddSuggestedModel(
  provider: ProviderKeyId,
  oldModel: string,
  newModel: string,
): ModelConfigEntry[] {
  const current = loadModelSettings();
  const cleanNew = newModel.trim();
  if (!cleanNew) return current;
  let replaced = false;
  const updated: ModelConfigEntry[] = [];
  for (const m of current) {
    if (m.provider === provider && m.id === oldModel) {
      replaced = true;
      updated.push({
        ...m,
        id: cleanNew,
        costTier: cleanNew.endsWith(":free") ? "free" : m.costTier === "free" ? "low" : m.costTier,
      });
    } else {
      updated.push(m);
    }
  }
  if (!replaced) {
    const nextPrio = updated.length > 0 ? Math.max(...updated.map((x) => x.priority)) + 1 : 1;
    updated.push({
      id: cleanNew,
      provider,
      priority: nextPrio,
      maxTokens: provider === "groq" ? 5500 : 16384,
      costTier: "low",
    });
  }
  return saveModelSettings(updated);
}

// ---- Live provider catalog cache (1 hour TTL) ---------------------------

function readCatalogCache(): CatalogCacheShape {
  if (memoryCatalogCache) return memoryCatalogCache;
  const f = catalogCachePath();
  if (!fs.existsSync(f)) {
    memoryCatalogCache = {};
    return memoryCatalogCache;
  }
  try {
    memoryCatalogCache = JSON.parse(fs.readFileSync(f, "utf8")) as CatalogCacheShape;
    return memoryCatalogCache ?? {};
  } catch {
    memoryCatalogCache = {};
    return memoryCatalogCache;
  }
}

function writeCatalogCache(cache: CatalogCacheShape): void {
  memoryCatalogCache = cache;
  try {
    const f = catalogCachePath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmp, f);
  } catch (e) {
    log.warn("model-settings: could not save model catalog cache", e);
  }
}

export function getCachedCatalogForProvider(
  provider: ProviderKeyId,
  now = Date.now(),
): string[] | null {
  const entry = readCatalogCache()[provider];
  if (!entry || !Array.isArray(entry.models)) return null;
  if (now - entry.fetchedAt > MODEL_CATALOG_TTL_MS) return null;
  return entry.models;
}

export async function refreshLiveCatalogs(options?: {
  force?: boolean;
  fetcher?: (provider: ProviderKeyId, apiKey: string | null) => Promise<string[] | null>;
}): Promise<Partial<Record<ProviderKeyId, Set<string>>>> {
  const now = Date.now();
  const cache = readCatalogCache();
  const fetcher = options?.fetcher ?? fetchProviderModelIds;
  const out: Partial<Record<ProviderKeyId, Set<string>>> = {};
  let dirty = false;

  const providers: ProviderKeyId[] = ["gemini", "openrouter", "groq"];
  await Promise.all(
    providers.map(async (provider) => {
      const key = getProviderKey(provider);
      // Gemini and Groq require an API key to list models; OpenRouter's /models is public.
      if (!key && provider !== "openrouter") return;

      const existing = cache[provider];
      if (!options?.force && existing && now - existing.fetchedAt <= MODEL_CATALOG_TTL_MS) {
        out[provider] = new Set(existing.models);
        return;
      }

      try {
        const live = await fetcher(provider, key);
        if (live && live.length > 0) {
          cache[provider] = { fetchedAt: now, models: live };
          out[provider] = new Set(live);
          dirty = true;
          log.info(`model-settings: fetched ${live.length} live models for ${provider}`);
        } else if (existing?.models?.length) {
          // Network hiccup: fall back to stale cache if present rather than dropping everything.
          out[provider] = new Set(existing.models);
        }
      } catch (e) {
        log.warn(`model-settings: live model fetch failed for ${provider}`, e);
        if (existing?.models?.length) {
          out[provider] = new Set(existing.models);
        }
      }
    }),
  );

  if (dirty) writeCatalogCache(cache);
  return out;
}

/**
 * Filter configured models against live catalogs, dropping any slug that no
 * longer exists on its provider.
 */
export function filterExistingModels(
  configured: ModelConfigEntry[],
  liveByProvider: Partial<Record<ProviderKeyId, Set<string>>>,
): { active: ModelConfigEntry[]; dropped: DroppedModelInfo[] } {
  const active: ModelConfigEntry[] = [];
  const dropped: DroppedModelInfo[] = [];

  for (const entry of configured) {
    const live = liveByProvider[entry.provider];
    if (live && live.size > 0 && !live.has(entry.id)) {
      const stripped = entry.id.endsWith(":free") ? entry.id.replace(/:free$/, "") : undefined;
      const suggestedModel = stripped && live.has(stripped) ? stripped : undefined;
      const reason = `Slug "${entry.id}" no longer exists in ${entry.provider}'s live model list`;
      log.warn(`[model-settings] dropping dead configured slug ${entry.provider}:${entry.id} — ${reason}`);
      dropped.push({ id: entry.id, provider: entry.provider, reason, suggestedModel });
      continue;
    }
    active.push(entry);
  }

  return { active, dropped };
}

