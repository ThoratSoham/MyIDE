import React, { useEffect, useMemo, useRef, useState } from "react";
import type { JobController } from "../hooks/useJob";
import type { ChatMessage, JobMode } from "../../shared/electron-api-types";

// FR-12.1 / FR-12.6: the chat shows the plan, tool steps, approval cards, a
// progress bar and a waiting banner. FR-12.7: an interrupted run is offered for
// resume. Nothing here decides anything — it only shows and forwards.

interface Props {
  job: JobController;
  defaultMode: JobMode;
}

const MODES: JobMode[] = ["fast", "balanced", "best"];

export function ChatPanel({ job, defaultMode }: Props) {
  const [mode, setMode] = useState<JobMode>(defaultMode);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const snap = job.snapshot;
  const running = !!snap?.running;
  const messages = snap?.messages ?? [];

  useEffect(() => setMode(defaultMode), [defaultMode]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, snap?.paused, job.approvals.length]);

  const progress = useMemo(() => {
    const stages = snap?.stages ?? [];
    const done = stages.filter((s) => s.status === "done" || s.status === "skip" || s.status === "fail").length;
    return { done, total: stages.length };
  }, [snap?.stages]);

  const send = async (kind: "website" | "agent") => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    setText("");
    try {
      if (kind === "website") await job.startWebsite(value, mode);
      else await job.startAgent(value, mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sendNote = async () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    await job.note(value);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Resume banner (FR-12.7) */}
      {job.interrupted && !running && (
        <div className="flex items-center gap-2 border-b border-[var(--color-warn)] bg-[var(--color-warn)]/10 px-3 py-2 text-xs text-[var(--color-warn)]">
          <span className="flex-1">
            An earlier run was interrupted: “{job.interrupted.brief.slice(0, 60)}”
          </span>
          <button className="rounded border border-[var(--color-warn)] px-2 py-0.5" onClick={() => void job.resume()}>
            Resume
          </button>
          <button className="rounded px-1 text-[var(--color-muted)]" onClick={job.dismissInterrupted}>
            ✕
          </button>
        </div>
      )}

      {/* Progress bar (FR-12.1) */}
      {progress.total > 0 && (
        <div className="border-b border-[var(--color-border)] px-3 py-2">
          <div className="mb-1 flex items-center gap-2 text-[10px] text-[var(--color-muted)]">
            <span>
              {progress.done}/{progress.total} stages
            </span>
            {snap?.result?.score != null && (
              <span className="ml-auto rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[var(--color-accent-strong)]">
                score {snap.result.score}/10
              </span>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-alt)]">
            <div
              className="h-full rounded-full bg-[var(--color-accent)] transition-all"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Messages */}
      <div ref={logRef} className="flex-1 space-y-3 overflow-auto p-3 text-sm">
        {messages.length === 0 && (
          <div className="mt-6 text-center text-xs text-[var(--color-muted)]">
            <p className="mb-2 text-sm text-[var(--color-text)]">Free models, premium results.</p>
            <p>
              Describe a website and press <b>Build website</b>. Every job is split into small steps, assembled
              from the design library and checked with code before it is called done.
            </p>
          </div>
        )}

        {messages.map((m, i) => (
          <Message key={i} m={m} />
        ))}

        {/* Plan (FR-12.1) */}
        {snap && snap.plan.length > 0 && (
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-alt)] p-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">Plan</div>
            <ul className="space-y-0.5">
              {snap.plan.map((s) => (
                <li key={s.id} className="flex items-start gap-2 text-xs">
                  <span className="mt-[1px] w-3 text-[var(--color-muted)]">
                    {s.status === "done" ? "✓" : s.status === "doing" ? "▸" : s.status === "failed" ? "✗" : "○"}
                  </span>
                  <span className={s.status === "done" ? "text-[var(--color-muted)] line-through" : ""}>
                    {s.title}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Approval cards (FR-12.1 / FR-5.4) */}
        {job.approvals.map((a) => (
          <div key={a.id} className="rounded border border-[var(--color-warn)] bg-[var(--color-warn)]/10 p-2">
            <div className="mb-1 text-xs text-[var(--color-warn)]">Command needs your approval</div>
            <pre className="mb-2 overflow-auto rounded bg-[var(--color-base)] p-2 text-[11px] text-[var(--color-text)]">
              {a.command}
            </pre>
            <div className="text-[10px] text-[var(--color-muted)]">{a.reason}</div>
            <div className="mt-2 flex gap-2">
              <button
                className="rounded bg-[var(--color-accent)] px-2 py-1 text-xs text-white"
                onClick={() => void job.respond(a.id, "once")}
              >
                Allow once
              </button>
              <button
                className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
                onClick={() => void job.respond(a.id, "always")}
              >
                Always allow
              </button>
              <button
                className="rounded border border-[var(--color-negative)] px-2 py-1 text-xs text-[var(--color-negative)]"
                onClick={() => void job.respond(a.id, "deny")}
              >
                Deny
              </button>
            </div>
          </div>
        ))}

        {/* Paused dialog (FR-12.6) */}
        {snap?.paused && (
          <div className="rounded border border-[var(--color-warn)] bg-[var(--color-warn)]/10 p-2 text-xs">
            <div className="mb-1 font-medium text-[var(--color-warn)]">Paused</div>
            <p className="mb-2 text-[var(--color-text)]">{snap.paused.reason}</p>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded bg-[var(--color-accent)] px-2 py-1 text-white"
                onClick={() => void job.resume()}
              >
                Resume
              </button>
              <button
                className="rounded border border-[var(--color-border)] px-2 py-1"
                onClick={() => textareaRef.current?.focus()}
              >
                Tell the AI what to do
              </button>
              <button
                className="rounded border border-[var(--color-border)] px-2 py-1"
                onClick={() => void job.cancel()}
              >
                Stop
              </button>
            </div>
          </div>
        )}

        {snap?.waiting && (
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-alt)] p-2 text-xs text-[var(--color-muted)]">
            Waiting for quota on <span className="font-mono">{snap.waiting.lane}</span>
            {snap.waiting.resumeAtMs ? ` — resuming at ${hhmm(snap.waiting.resumeAtMs)}` : ""}. The run is saved and
            will continue on its own.
          </div>
        )}
      </div>

      {error && (
        <div className="border-t border-[var(--color-negative)] bg-[var(--color-negative)]/10 px-3 py-1.5 text-xs text-[var(--color-negative)]">
          {error}
        </div>
      )}

      {/* Composer */}
      <div className="border-t border-[var(--color-border)] p-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void (running ? sendNote() : send("website"));
          }}
          rows={3}
          placeholder={
            running
              ? "Send a note to the agent (read before its next step)…"
              : "Describe the website or the change you want…"
          }
          className="w-full resize-none rounded border border-[var(--color-border)] bg-[var(--color-base)] p-2 text-sm text-[var(--color-text)] outline-none"
        />
        <div className="mt-2 flex items-center gap-2">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as JobMode)}
            disabled={running}
            className="rounded border border-[var(--color-border)] bg-[var(--color-base)] px-1.5 py-1 text-xs capitalize"
            title="Fast = 1 critic round, Balanced = 2, Best = 3"
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          {running ? (
            <>
              <button
                className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
                onClick={() => void sendNote()}
                disabled={!text.trim()}
              >
                Send note
              </button>
              <button
                className="ml-auto rounded border border-[var(--color-negative)] px-2 py-1 text-xs text-[var(--color-negative)]"
                onClick={() => void job.cancel()}
              >
                Stop
              </button>
            </>
          ) : (
            <>
              <button
                className="rounded bg-[var(--color-accent)] px-2.5 py-1 text-xs text-white disabled:opacity-40"
                onClick={() => void send("website")}
                disabled={!text.trim() || busy}
              >
                Build website
              </button>
              <button
                className="rounded border border-[var(--color-border)] px-2.5 py-1 text-xs disabled:opacity-40"
                onClick={() => void send("agent")}
                disabled={!text.trim() || busy}
              >
                Edit files
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Message({ m }: { m: ChatMessage }) {
  if (m.role === "user") {
    return (
      <div className="ml-6 rounded-lg bg-[var(--color-accent)]/15 px-3 py-2 text-[var(--color-text)]">
        <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[var(--color-accent-strong)]">You</div>
        <div className="whitespace-pre-wrap">{m.text}</div>
      </div>
    );
  }
  if (m.role === "tool") {
    return (
      <div className="rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1.5">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
          Tool {m.ok ? "✓" : "✗"}
        </div>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--color-muted)]">
          {m.text}
        </pre>
      </div>
    );
  }
  if (m.role === "notice") {
    return <div className="text-xs text-[var(--color-muted)]">· {m.text}</div>;
  }
  return (
    <div className="mr-6 rounded-lg bg-[var(--color-surface-alt)] px-3 py-2">
      <div className="mb-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
        <span>MyIDE</span>
        {m.model && <span className="rounded bg-[var(--color-base)] px-1 font-mono normal-case">{m.model}</span>}
      </div>
      <div className="whitespace-pre-wrap text-[var(--color-text)]">{m.text}</div>
    </div>
  );
}

function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
