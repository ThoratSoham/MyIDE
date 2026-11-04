import { StreamCancelledError } from "./http";
import type { ProviderId } from "./types";

// PART 1 #5:
// - Limit concurrency to 1-2 requests per provider and queue the rest.
// - Deduplicate identical in-flight requests.

interface QueueItem {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ProviderConcurrencyLimiter {
  private active = new Map<ProviderId, number>();
  private queues = new Map<ProviderId, QueueItem[]>();

  constructor(private readonly maxConcurrentPerProvider = 2) {}

  activeCount(provider: ProviderId): number {
    return this.active.get(provider) ?? 0;
  }

  queuedCount(provider: ProviderId): number {
    return this.queues.get(provider)?.length ?? 0;
  }

  async acquire(provider: ProviderId, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new StreamCancelledError();
    }
    const current = this.active.get(provider) ?? 0;
    if (current < this.maxConcurrentPerProvider) {
      this.active.set(provider, current + 1);
      return this.makeRelease(provider);
    }

    return new Promise<() => void>((resolve, reject) => {
      const item: QueueItem = { resolve, reject, signal };
      if (signal) {
        const onAbort = () => {
          const q = this.queues.get(provider);
          if (q) {
            const idx = q.indexOf(item);
            if (idx !== -1) q.splice(idx, 1);
          }
          reject(new StreamCancelledError());
        };
        item.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const q = this.queues.get(provider) ?? [];
      q.push(item);
      this.queues.set(provider, q);
    });
  }

  async run<T>(provider: ProviderId, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(provider, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private makeRelease(provider: ProviderId): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const q = this.queues.get(provider);
      while (q && q.length > 0) {
        const next = q.shift()!;
        if (next.signal && next.onAbort) {
          next.signal.removeEventListener("abort", next.onAbort);
        }
        if (next.signal?.aborted) {
          next.reject(new StreamCancelledError());
          continue;
        }
        next.resolve(this.makeRelease(provider));
        return;
      }
      const cur = this.active.get(provider) ?? 1;
      this.active.set(provider, Math.max(0, cur - 1));
    };
  }
}

interface InFlightShared<T> {
  promise: Promise<T>;
  deltaListeners: Set<(chunk: string) => void>;
  subscribers: number;
  sharedAbort: AbortController;
}

/**
 * Deduplicates identical in-flight requests. Multiple callers awaiting the exact
 * same prompt+options share a single upstream request, receive live SSE deltas,
 * and only abort the upstream call if EVERY subscriber aborts.
 */
export class RequestDeduplicator<T> {
  private inflight = new Map<string, InFlightShared<T>>();

  get size(): number {
    return this.inflight.size;
  }

  async run(
    key: string,
    execute: (sharedSignal: AbortSignal, emitDelta: (chunk: string) => void) => Promise<T>,
    opts?: { signal?: AbortSignal; onDelta?: (chunk: string) => void },
  ): Promise<T> {
    if (opts?.signal?.aborted) {
      throw new StreamCancelledError();
    }

    let entry = this.inflight.get(key);
    if (!entry) {
      const sharedAbort = new AbortController();
      const deltaListeners = new Set<(chunk: string) => void>();
      const emitDelta = (chunk: string) => {
        for (const fn of deltaListeners) {
          try {
            fn(chunk);
          } catch {
            /* ignore listener error */
          }
        }
      };
      const promise = execute(sharedAbort.signal, emitDelta).finally(() => {
        this.inflight.delete(key);
      });
      entry = { promise, deltaListeners, subscribers: 0, sharedAbort };
      this.inflight.set(key, entry);
    }

    const shared = entry;
    shared.subscribers += 1;
    if (opts?.onDelta) shared.deltaListeners.add(opts.onDelta);

    if (!opts?.signal) {
      try {
        return await shared.promise;
      } finally {
        if (opts?.onDelta) shared.deltaListeners.delete(opts.onDelta);
      }
    }

    return new Promise<T>((resolve, reject) => {
      let abortedHere = false;
      const onCallerAbort = () => {
        if (abortedHere) return;
        abortedHere = true;
        if (opts.onDelta) shared.deltaListeners.delete(opts.onDelta);
        shared.subscribers = Math.max(0, shared.subscribers - 1);
        if (shared.subscribers === 0) {
          shared.sharedAbort.abort();
        }
        reject(new StreamCancelledError());
      };
      opts.signal!.addEventListener("abort", onCallerAbort, { once: true });

      shared.promise.then(
        (val) => {
          opts.signal!.removeEventListener("abort", onCallerAbort);
          if (opts.onDelta) shared.deltaListeners.delete(opts.onDelta);
          if (!abortedHere) resolve(val);
        },
        (err) => {
          opts.signal!.removeEventListener("abort", onCallerAbort);
          if (opts.onDelta) shared.deltaListeners.delete(opts.onDelta);
          if (!abortedHere) reject(err);
        },
      );
    });
  }
}

