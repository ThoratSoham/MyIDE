// Shared HTTP + SSE plumbing for the real provider adapters.
//
// FR-3.3: 75 s for the first byte, 90 s between pieces. Streaming is used so a
// stalled lane is detected early instead of hanging the whole run, and user
// cancellation via AbortController immediately aborts in-flight requests.

export class StreamTimeoutError extends Error {
  constructor(phase: string) {
    super(`stream timeout during ${phase}`);
    this.name = "StreamTimeoutError";
  }
}

export class StreamCancelledError extends Error {
  constructor() {
    super("request cancelled by user");
    this.name = "StreamCancelledError";
  }
}

export interface Timeouts {
  firstByteMs: number;
  chunkMs: number;
}

export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => void,
  phase: string,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (externalSignal?.aborted) {
    onTimeout();
    return Promise.reject(new StreamCancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const onExtAbort = () => {
      clearTimeout(t);
      onTimeout();
      reject(new StreamCancelledError());
    };
    if (externalSignal) {
      externalSignal.addEventListener("abort", onExtAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(t);
      if (externalSignal) externalSignal.removeEventListener("abort", onExtAbort);
    };
    const t = setTimeout(() => {
      if (externalSignal) externalSignal.removeEventListener("abort", onExtAbort);
      onTimeout();
      reject(new StreamTimeoutError(phase));
    }, ms);
    p.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        if (externalSignal?.aborted) reject(new StreamCancelledError());
        else reject(e);
      },
    );
  });
}

// Open a stream, aborting if headers do not arrive within firstByteMs or if externalSignal aborts.
export async function openStream(
  url: string,
  init: RequestInit,
  timeouts: Timeouts,
  externalSignal?: AbortSignal,
): Promise<{ res: Response; abort: () => void }> {
  if (externalSignal?.aborted) {
    throw new StreamCancelledError();
  }
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  const onExtAbort = () => ctrl.abort();
  if (externalSignal) {
    externalSignal.addEventListener("abort", onExtAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeouts.firstByteMs);

  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExtAbort);
    return { res, abort: onAbort };
  } catch (e) {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExtAbort);
    if (externalSignal?.aborted) {
      throw new StreamCancelledError();
    }
    if (timedOut || (e as Error).name === "AbortError") {
      throw new StreamTimeoutError("first byte");
    }
    throw e;
  }
}

// Yield SSE `data:` payloads, applying a between-chunk timeout and external AbortSignal.
export async function* sseData(
  res: Response,
  chunkMs: number,
  externalSignal?: AbortSignal,
): AsyncGenerator<string> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onExtAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      reader.cancel().catch(() => {});
      reader.releaseLock?.();
      throw new StreamCancelledError();
    }
    externalSignal.addEventListener("abort", onExtAbort, { once: true });
  }

  try {
    for (;;) {
      if (externalSignal?.aborted) throw new StreamCancelledError();
      const read = await withTimeout(
        reader.read(),
        chunkMs,
        () => {
          reader.cancel().catch(() => {});
        },
        "chunk",
        externalSignal,
      );
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload) yield payload;
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload) yield payload;
    }
  } finally {
    if (externalSignal) externalSignal.removeEventListener("abort", onExtAbort);
    reader.releaseLock?.();
  }
}

// Read a whole response body as text with a between-chunk timeout.
export async function readText(res: Response, chunkMs: number, externalSignal?: AbortSignal): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const read = await withTimeout(
        reader.read(),
        chunkMs,
        () => {
          reader.cancel().catch(() => {});
        },
        "body",
        externalSignal,
      );
      if (read.done) break;
      out += decoder.decode(read.value, { stream: true });
    }
  } finally {
    reader.releaseLock?.();
  }
  return out;
}

export function headerMap(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export function parseDurationHeaderMs(val: string): number | null {
  const trimmed = val.trim();
  if (!trimmed) return null;
  const asNum = Number(trimmed);
  if (!Number.isNaN(asNum)) return Math.max(0, asNum * 1000);
  // Handle compound durations like "1m30s", "6.5s", "500ms"
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    matched = true;
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    if (u === "ms") total += n;
    else if (u === "h") total += n * 3_600_000;
    else if (u === "m") total += n * 60_000;
    else total += n * 1000;
  }
  if (matched) return Math.max(0, total);
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

export function parseRetryAfterMs(headers: Record<string, string>): number | null {
  const ra = headers["retry-after"] ?? headers["retry-after-ms"];
  if (ra) {
    if (headers["retry-after-ms"] && !headers["retry-after"]) {
      const ms = Number(headers["retry-after-ms"]);
      if (Number.isFinite(ms)) return Math.max(0, ms);
    }
    const parsed = parseDurationHeaderMs(ra);
    if (parsed != null) return parsed;
  }
  // Fallback to x-ratelimit-reset-requests / x-ratelimit-reset-tokens if present
  for (const key of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    if (headers[key]) {
      const parsed = parseDurationHeaderMs(headers[key]);
      if (parsed != null) return parsed;
    }
  }
  return null;
}

// Providers return "Please retry in 34.5s" or "try again in 2m59s" in 429 bodies.
export function parseRetryTextMs(body: string): number | null {
  const m =
    /(?:retry|try again|reset)[^\d]{0,24}(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)/i.exec(
      body,
    );
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "ms") return n;
  if (unit.startsWith("h")) return n * 3600_000;
  if (unit.startsWith("m")) return n * 60_000;
  return n * 1000;
}

/**
 * Extract a suggested replacement model slug from a 404/400 error body, e.g.:
 * "This model is unavailable for free. The paid version is available now - use this slug instead: meta-llama/llama-3.2-3b-instruct"
 */
export function extractSuggestedModel(body: string): string | undefined {
  if (!body) return undefined;
  const patterns = [
    /use\s+this\s+(?:slug|model)\s+instead\s*[:=-]\s*["'`]?([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?(?::[a-zA-Z0-9._-]+)?)/i,
    /(?:suggested|replacement)\s+(?:slug|model)\s*[:=-]\s*["'`]?([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?(?::[a-zA-Z0-9._-]+)?)/i,
    /use\s+["'`]([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)["'`]\s+instead/i,
  ];
  for (const re of patterns) {
    const m = re.exec(body);
    if (m?.[1]) {
      return m[1].replace(/[.,;)"'`]+$/, "");
    }
  }
  try {
    const json = JSON.parse(body);
    const metaSlug =
      json?.error?.metadata?.suggested_model ??
      json?.error?.suggested_model ??
      json?.suggested_model;
    if (typeof metaSlug === "string" && metaSlug.trim()) return metaSlug.trim();
    const errMsg = typeof json?.error?.message === "string" ? json.error.message : "";
    if (errMsg && errMsg !== body) return extractSuggestedModel(errMsg);
  } catch {
    /* plain text body */
  }
  return undefined;
}
