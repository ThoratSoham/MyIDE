import { AsyncLocalStorage } from "async_hooks";
import fs from "fs";
import path from "path";
import { app } from "electron";
import log from "electron-log";
import type { RunStats } from "../shared/electron-api-types";

// PHASE 0: Local-only per-run telemetry (strictly zero network requests).
// Tracks model calls, input/output tokens, retries (429/5xx/413), dead-lane events,
// malformed-JSON repairs, failed editFile attempts, tool calls executed, wall time,
// and verification outcome.

const MAX_STORED_RUNS = 200;
const CHAR_TO_TOKEN = 3.5;

export class RunTelemetryTracker {
  readonly runId: string;
  readonly startedAt: number;
  private endedAt: number | null = null;

  modelCalls = 0;
  inputTokens = 0;
  outputTokens = 0;
  retries429 = 0;
  retries5xx = 0;
  retries413 = 0;
  deadLaneEvents = 0;
  malformedJsonRepairs = 0;
  failedEditFileAttempts = 0;
  toolCallsExecuted = 0;
  verificationPassed: boolean | null = null;

  constructor(runId: string, startedAt = Date.now()) {
    this.runId = runId;
    this.startedAt = startedAt;
  }

  recordModelCall(params: {
    inputTokens?: number;
    outputTokens?: number;
    promptChars?: number;
    completionChars?: number;
  }): void {
    this.modelCalls += 1;
    const inTok =
      params.inputTokens && params.inputTokens > 0
        ? params.inputTokens
        : Math.ceil((params.promptChars ?? 0) / CHAR_TO_TOKEN);
    const outTok =
      params.outputTokens && params.outputTokens > 0
        ? params.outputTokens
        : Math.ceil((params.completionChars ?? 0) / CHAR_TO_TOKEN);
    this.inputTokens += inTok;
    this.outputTokens += outTok;
  }

  recordRetry(kind: "429" | "5xx" | "413"): void {
    if (kind === "429") this.retries429 += 1;
    else if (kind === "5xx") this.retries5xx += 1;
    else if (kind === "413") this.retries413 += 1;
  }

  recordDeadLane(): void {
    this.deadLaneEvents += 1;
  }

  recordMalformedJsonRepair(): void {
    this.malformedJsonRepairs += 1;
  }

  recordFailedEditFile(): void {
    this.failedEditFileAttempts += 1;
  }

  recordToolCall(): void {
    this.toolCallsExecuted += 1;
  }

  recordVerification(passed: boolean): void {
    this.verificationPassed = passed;
  }

  finish(now = Date.now()): RunStats {
    if (this.endedAt == null) this.endedAt = now;
    return this.snapshot(this.endedAt);
  }

  snapshot(now = Date.now()): RunStats {
    const end = this.endedAt ?? now;
    const retries = this.retries429 + this.retries5xx + this.retries413;
    return {
      runId: this.runId,
      modelCalls: this.modelCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      retries,
      retries429: this.retries429,
      retries5xx: this.retries5xx,
      retries413: this.retries413,
      deadLaneEvents: this.deadLaneEvents,
      malformedJsonRepairs: this.malformedJsonRepairs,
      failedEditFileAttempts: this.failedEditFileAttempts,
      toolCallsExecuted: this.toolCallsExecuted,
      wallTimeMs: Math.max(0, end - this.startedAt),
      verificationPassed: this.verificationPassed,
    };
  }
}

const telemetryStorage = new AsyncLocalStorage<RunTelemetryTracker>();
const activeByRunId = new Map<string, RunTelemetryTracker>();

export function startRunTelemetry(runId: string): RunTelemetryTracker {
  const tracker = new RunTelemetryTracker(runId);
  activeByRunId.set(runId, tracker);
  return tracker;
}

export function withRunTelemetry<T>(tracker: RunTelemetryTracker, fn: () => Promise<T>): Promise<T> {
  return telemetryStorage.run(tracker, fn);
}

export function currentTelemetry(): RunTelemetryTracker | undefined {
  return telemetryStorage.getStore();
}

export function getRunTelemetry(runId: string): RunTelemetryTracker | undefined {
  return activeByRunId.get(runId);
}

export function finishRunTelemetry(runId: string, persist = true): RunStats | null {
  const tracker = activeByRunId.get(runId) ?? telemetryStorage.getStore();
  if (!tracker) return null;
  const stats = tracker.finish();
  activeByRunId.delete(runId);
  if (persist) {
    persistRunStats(stats);
  }
  return stats;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

export function formatRunStatsLine(stats: RunStats): string {
  const totalTokens = stats.inputTokens + stats.outputTokens;
  const callWord = stats.modelCalls === 1 ? "call" : "calls";
  const retryWord = stats.retries === 1 ? "retry" : "retries";
  const parts = [
    `${stats.modelCalls} ${callWord}`,
    `${formatTokenCount(totalTokens)} tokens (${formatTokenCount(stats.inputTokens)} in / ${formatTokenCount(stats.outputTokens)} out)`,
    `${stats.retries} ${retryWord}`,
  ];
  if (stats.toolCallsExecuted > 0) {
    parts.push(`${stats.toolCallsExecuted} tool${stats.toolCallsExecuted === 1 ? "" : "s"}`);
  }
  if (stats.verificationPassed === true) {
    parts.push("verified ✓");
  } else if (stats.verificationPassed === false) {
    parts.push("verify failed ✗");
  }
  const secs = (stats.wallTimeMs / 1000).toFixed(1);
  parts.push(`${secs}s`);
  return parts.join(", ");
}

function telemetryFilePath(): string {
  return path.join(app.getPath("userData"), "telemetry.json");
}

interface StoredTelemetryFile {
  version: 1;
  runs: Array<RunStats & { recordedAt: number }>;
}

export function persistRunStats(stats: RunStats): void {
  try {
    const file = telemetryFilePath();
    let data: StoredTelemetryFile = { version: 1, runs: [] };
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredTelemetryFile>;
        if (Array.isArray(parsed.runs)) {
          data.runs = parsed.runs;
        }
      } catch {
        data = { version: 1, runs: [] };
      }
    }
    data.runs.push({ ...stats, recordedAt: Date.now() });
    if (data.runs.length > MAX_STORED_RUNS) {
      data.runs = data.runs.slice(-MAX_STORED_RUNS);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    log.warn("telemetry: failed to persist local run stats", e);
  }
}

export function loadStoredTelemetry(): Array<RunStats & { recordedAt: number }> {
  try {
    const file = telemetryFilePath();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredTelemetryFile>;
    return Array.isArray(parsed.runs) ? parsed.runs : [];
  } catch {
    return [];
  }
}

