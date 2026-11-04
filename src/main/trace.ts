import log from "electron-log";

// PART 1 DIAGNOSE: one numbered, correlated trace for every hop of the chat
// path and every tool call. It is written to the console (electron-log), kept
// in a small ring buffer for the Logs panel, and pushed to the window so the
// trace is visible while the app runs — never hidden in a file only.

export type TracePhase = "chat" | "tool" | "term";

const MAX_LINES = 3000;
const buffer: string[] = [];
let sink: ((line: string) => void) | null = null;

export function setTraceSink(fn: ((line: string) => void) | null): void {
  sink = fn;
}

export function traceLines(): string[] {
  return [...buffer];
}

let counter = 0;

/** A short, stable correlation id for one run, e.g. "7f2a". */
export function newTraceId(): string {
  counter = (counter + 1) % 0xffff;
  const rnd = Math.floor(Math.random() * 0xffff);
  return ((rnd ^ counter) & 0xffff).toString(16).padStart(4, "0");
}

/**
 * Write one numbered hop. `step` follows the PART 1 contract so a missing hop
 * is obvious at a glance:
 *   1 renderer: send clicked
 *   2 preload: ipc invoke
 *   3 main: handler received
 *   4 main: lane chosen
 *   5 main: first token or error
 *   6 main: event sent to window
 *   7 renderer: event received
 *   8 renderer: state updated
 *   9 renderer: bubble rendered
 */
export function hop(phase: TracePhase, traceId: string, step: number, message: string): void {
  const line = `[${phase} ${traceId}] ${step} ${message}`;
  push(line);
}

/** A free-form note on the same trace (no step number). */
export function note(phase: TracePhase, traceId: string, message: string): void {
  push(`[${phase} ${traceId}]   ${message}`);
}

function push(line: string): void {
  buffer.push(line);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
  log.info(line);
  try {
    sink?.(line);
  } catch {
    /* a broken sink must never break a run */
  }
}
