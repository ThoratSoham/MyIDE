import React, { useEffect, useState } from "react";
import type { JobMode, JobSnapshot } from "../../shared/electron-api-types";

// FR-12.1 / FR-12.6: the status bar shows the mode, the run state, the model
// that served the last message and a live countdown while the run waits on
// quota. It reads the same snapshot as the chat, so it can never disagree.

interface Props {
  snapshot: JobSnapshot | null;
  defaultMode: JobMode;
}

export function StatusBar({ snapshot, defaultMode }: Props) {
  const waiting = snapshot?.waiting ?? null;
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (!waiting?.resumeAtMs) {
      setCountdown(0);
      return;
    }
    const tick = () => setCountdown(Math.max(0, Math.round((waiting.resumeAtMs! - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [waiting?.resumeAtMs]);

  const mode = snapshot?.mode ?? defaultMode;
  const running = !!snapshot?.running;
  const paused = !!snapshot?.paused;
  const lastModel = [...(snapshot?.messages ?? [])].reverse().find((m) => m.model)?.model;
  const score = snapshot?.result?.score;

  const state = paused
    ? { label: "Paused", dot: "bg-[var(--color-warn)]" }
    : waiting
      ? { label: "Waiting for quota", dot: "bg-[var(--color-warn)]" }
      : running
        ? { label: "Running", dot: "bg-[var(--color-accent)] animate-pulse" }
        : { label: "Ready", dot: "bg-[var(--color-positive)]" };

  return (
    <footer className="flex h-7 flex-none items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs text-[var(--color-muted)]">
      <span className="text-[var(--color-muted)]">Mode</span>
      <span className="capitalize text-[var(--color-text)]">{mode}</span>

      {snapshot?.kind && (
        <>
          <span className="opacity-40">·</span>
          <span className="capitalize text-[var(--color-text)]">{snapshot.kind} job</span>
        </>
      )}

      {lastModel && (
        <>
          <span className="opacity-40">·</span>
          <span className="font-mono text-[var(--color-muted)]">{lastModel}</span>
        </>
      )}

      {score != null && (
        <span className="rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-accent-strong)]">
          score {score}/10
        </span>
      )}

      {waiting && (
        <div className="ml-auto flex items-center gap-2 rounded border border-[var(--color-warn)] bg-[var(--color-warn)]/10 px-2 py-0.5 text-[var(--color-warn)]">
          <span className="animate-pulse">waiting</span>
          {waiting.lane && <span className="font-mono">{waiting.lane}</span>}
          {waiting.resumeAtMs && (
            <span className="font-mono">
              {hhmm(waiting.resumeAtMs)} · {mmss(countdown)}
            </span>
          )}
        </div>
      )}

      <span className={`${waiting ? "" : "ml-auto"} flex items-center gap-1.5`}>
        <span className={`inline-block h-2 w-2 rounded-full ${state.dot}`} />
        <span className="text-[var(--color-text)]">{state.label}</span>
      </span>
    </footer>
  );
}

function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
