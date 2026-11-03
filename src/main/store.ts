import fs from "fs";
import path from "path";
import { app, safeStorage } from "electron";
import log from "electron-log";
import { getDefaultSettings, type Settings } from "./ui/settings";

// FR-2.8 / FR-13.2: keys are encrypted with the OS (safeStorage) and written to
// settings.enc in the app data folder. The renderer never receives a key; it
// only ever sees the last 4 characters, which we derive here.
//
// FR-2.4 / risk section: the free-tier limits table is editable. We persist the
// user's overrides here so real limits learned at runtime can be pinned.

export type ProviderKeyId = "gemini" | "openrouter" | "groq";

export interface LaneLimitOverride {
  laneId: string;
  rpm?: number;
  rpd?: number;
  tpm?: number | null;
  maxTokensPerRequest?: number | null;
}

interface StoredShape {
  settings: Settings;
  keys: Partial<Record<ProviderKeyId, string>>;
  limitOverrides: Record<string, LaneLimitOverride>;
}

const ENC_PREFIX = "ENC:";
const RAW_PREFIX = "RAW:";

let cache: StoredShape | null = null;

export function storeFilePath(): string {
  return path.join(app.getPath("userData"), "settings.enc");
}

function emptyStore(): StoredShape {
  return { settings: getDefaultSettings(), keys: {}, limitOverrides: {} };
}

function decode(raw: Buffer): StoredShape {
  if (raw.length === 0) return emptyStore();
  const head = raw.subarray(0, 4).toString("utf8");

  let json: string;
  try {
    if (head === ENC_PREFIX) {
      const body = raw.subarray(ENC_PREFIX.length);
      if (!safeStorage.isEncryptionAvailable()) {
        log.warn("store: file is encrypted but OS encryption is unavailable");
        return emptyStore();
      }
      json = safeStorage.decryptString(body);
    } else if (head === RAW_PREFIX) {
      json = raw.subarray(RAW_PREFIX.length).toString("utf8");
    } else {
      // Legacy / unmarked: try to read as plain JSON.
      json = raw.toString("utf8");
    }
    const parsed = JSON.parse(json) as Partial<StoredShape>;
    return {
      settings: { ...getDefaultSettings(), ...(parsed.settings ?? {}) },
      keys: parsed.keys ?? {},
      limitOverrides: parsed.limitOverrides ?? {},
    };
  } catch (e) {
    log.error("store: could not decode settings.enc", e);
    return emptyStore();
  }
}

function encode(shape: StoredShape): Buffer {
  const json = JSON.stringify(shape);
  if (safeStorage.isEncryptionAvailable()) {
    const body = safeStorage.encryptString(json);
    return Buffer.concat([Buffer.from(ENC_PREFIX, "utf8"), body]);
  }
  log.warn("store: OS encryption unavailable; writing settings unencrypted (RAW)");
  return Buffer.concat([Buffer.from(RAW_PREFIX, "utf8"), Buffer.from(json, "utf8")]);
}

export function loadStore(): StoredShape {
  if (cache) return cache;
  const f = storeFilePath();
  if (!fs.existsSync(f)) {
    cache = emptyStore();
    return cache;
  }
  cache = decode(fs.readFileSync(f));
  return cache;
}

export function saveStore(shape: StoredShape): void {
  cache = shape;
  const f = storeFilePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // FR-4.5: write to a temp file, then rename — never leave a half file.
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, encode(shape));
  fs.renameSync(tmp, f);
}

// ---- Settings ----

export function getSettings(): Settings {
  return { ...loadStore().settings };
}

export function setSettings(partial: Partial<Settings>): Settings {
  const shape = loadStore();
  shape.settings = { ...shape.settings, ...partial };
  saveStore(shape);
  log.info("settings updated", Object.keys(partial));
  return { ...shape.settings };
}

// ---- Keys (never leave the main process) ----

export function setProviderKey(provider: ProviderKeyId, key: string): void {
  const shape = loadStore();
  const trimmed = key.trim();
  if (trimmed) shape.keys[provider] = trimmed;
  else delete shape.keys[provider];
  saveStore(shape);
  log.info(`key ${trimmed ? "stored" : "cleared"} for ${provider}`);
}

export function clearProviderKey(provider: ProviderKeyId): void {
  setProviderKey(provider, "");
}

export function getProviderKey(provider: ProviderKeyId): string | null {
  return loadStore().keys[provider] ?? null;
}

export function keyLast4(provider: ProviderKeyId): string {
  const k = getProviderKey(provider);
  return k ? k.slice(-4) : "";
}

// The shape handed to the renderer: last-4 only, never the key (FR-13.2).
export function publicSettings(): Settings {
  const s = getSettings();
  return {
    ...s,
    providerOverrides: {
      geminiApiKeyLast4: keyLast4("gemini"),
      openrouterApiKeyLast4: keyLast4("openrouter"),
      groqApiKeyLast4: keyLast4("groq"),
    },
  };
}

// ---- Editable limits table (FR-2.4) ----

export function getLimitOverrides(): Record<string, LaneLimitOverride> {
  return { ...loadStore().limitOverrides };
}

export function setLimitOverride(o: LaneLimitOverride): void {
  const shape = loadStore();
  shape.limitOverrides[o.laneId] = o;
  saveStore(shape);
}
