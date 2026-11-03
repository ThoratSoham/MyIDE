// Shared HTTP + SSE plumbing for the real provider adapters.
//
// FR-3.3: 75 s for the first byte, 90 s between pieces. Streaming is used so a
// stalled lane is detected early instead of hanging the whole run.

export class StreamTimeoutError extends Error {
  constructor(phase: string) {
    super(`stream timeout during ${phase}`);
    this.name = "StreamTimeoutError";
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
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout();
      reject(new StreamTimeoutError(phase));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// Open a stream, aborting if headers do not arrive within firstByteMs.
export async function openStream(
  url: string,
  init: RequestInit,
  timeouts: Timeouts,
): Promise<{ res: Response; abort: () => void }> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  const timer = setTimeout(() => ctrl.abort(), timeouts.firstByteMs);

  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    clearTimeout(timer);
    return { res, abort: onAbort };
  } catch (e) {
    clearTimeout(timer);
    if ((e as Error).name === "AbortError") {
      throw new StreamTimeoutError("first byte");
    }
    throw e;
  }
}

// Yield SSE `data:` payloads, applying a between-chunk timeout.
export async function* sseData(
  res: Response,
  chunkMs: number,
): AsyncGenerator<string> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const read = await withTimeout(
        reader.read(),
        chunkMs,
        () => {
          reader.cancel().catch(() => {});
        },
        "chunk",
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
    reader.releaseLock?.();
  }
}

// Read a whole response body as text with a between-chunk timeout.
export async function readText(res: Response, chunkMs: number): Promise<string> {
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

export function parseRetryAfterMs(headers: Record<string, string>): number | null {
  const ra = headers["retry-after"];
  if (!ra) return null;
  const asNum = Number(ra);
  if (!Number.isNaN(asNum)) return Math.max(0, asNum * 1000);
  const asDate = Date.parse(ra);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
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
