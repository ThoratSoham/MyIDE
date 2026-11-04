import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { JobController } from "../hooks/useJob";
import type {
  ChatAction,
  ChatMessage,
  IntentChoice,
  JobMode,
  LaneExhaustedDetail,
  ProviderKeyId,
  UserQuestionResponse,
} from "../../shared/electron-api-types";
import { estimateRun, INTENT_LABELS, INTENT_OPTIONS, routeIntent } from "../../shared/intent";
import { Markdown } from "./Markdown";
import { PopupQuestionHistoryCard, PopupQuestionModal } from "./PopupQuestionCard";

// PART 2 + PART 3: Docked right-side Chat panel with:
// - Full scrollable conversation history with timestamps
// - Smart auto-scroll + "Jump to latest" button when scrolled up
// - Streaming Markdown with syntax-highlighted code blocks & Copy button
// - Collapsible tool & status items
// - Persisted sessions list in userData (switch / delete / new chat)
// - Virtualized message rendering above 200 messages
// - Popup questions (ask_user modal + inline persistent history card)
// - Accessible aria-live announcements, keyboard handling, visible focus outlines

interface Props {
  job: JobController;
  defaultMode: JobMode;
  onOpenSettings: () => void;
  onOpenModels: () => void;
  onOpenFile: (path: string) => void;
  onOpenWorkspace: () => void;
  onCollapse?: () => void;
}

const MODES: JobMode[] = ["fast", "balanced", "best"];
const VIRTUALIZE_THRESHOLD = 200;
const OVERSCAN = 8;

const EXAMPLES: { label: string; text: string }[] = [
  { label: "Website", text: "Make a website for a coffee shop with a menu and contact section" },
  { label: "Animated website", text: "Make an animated landing page with a moving hero and scroll effects" },
  { label: "Logo video", text: "Make a logo animation video for my brand" },
  { label: "3D explainer", text: "Make a 3D science explainer about the solar system" },
  { label: "Fix a bug", text: "Fix a bug: the build fails with an error in the terminal" },
  { label: "Explain code", text: "Explain this code and what it does" },
];

export function ChatPanel({
  job,
  defaultMode,
  onOpenSettings,
  onOpenModels,
  onOpenFile,
  onOpenWorkspace,
  onCollapse,
}: Props) {
  const [mode, setMode] = useState<JobMode>(defaultMode);
  const [pinned, setPinned] = useState<IntentChoice>("auto");
  const [text, setText] = useState("");
  const deferredText = useDeferredValue(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [minimizedQuestionIds, setMinimizedQuestionIds] = useState<Set<string>>(new Set());

  // Smart scroll state
  const logRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isAtBottomRef = useRef(true);
  const [showJumpLatest, setShowJumpLatest] = useState(false);

  // Virtualization state (active when messages.length > 200)
  const heightCacheRef = useRef<Map<string, number>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [, setMeasureTick] = useState(0);

  const running = job.running || job.thinking;
  const messages = job.messages;
  const isVirtualized = messages.length > VIRTUALIZE_THRESHOLD;

  useEffect(() => setMode(defaultMode), [defaultMode]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!job.thinking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [job.thinking]);

  // Track viewport resize for virtualization
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight || 600);
    const ro = new ResizeObserver(() => {
      if (logRef.current) setViewportHeight(logRef.current.clientHeight || 600);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom <= 56;
    isAtBottomRef.current = nearBottom;
    if (nearBottom && showJumpLatest) {
      setShowJumpLatest(false);
    }
  }, [showJumpLatest]);

  const jumpToLatest = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    isAtBottomRef.current = true;
    setShowJumpLatest(false);
    el.scrollTop = el.scrollHeight;
  }, []);

  const lastMsgTextLen = messages.length > 0 ? messages[messages.length - 1].text.length : 0;

  // Auto-scroll to bottom on new messages/deltas ONLY if user has NOT scrolled up.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowJumpLatest(false);
    } else if (messages.length > 0) {
      setShowJumpLatest(true);
    }
  }, [messages.length, lastMsgTextLen, job.thinking, job.approvals.length, job.pendingQuestions.length, job.paused]);

  // Pure local regex classification (never triggers any network request).
  const detection = useMemo(() => {
    if (pinned !== "auto") return { intent: pinned, label: INTENT_LABELS[pinned] };
    const r = routeIntent(deferredText);
    return { intent: r.intent, label: r.label };
  }, [pinned, deferredText]);

  const estimate = useMemo(() => estimateRun(detection.intent, mode), [detection.intent, mode]);

  const waitingMs = job.thinking && job.lastActivity ? now - job.lastActivity : 0;
  const lastModel = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].model) return messages[i].model;
    return job.waiting?.lane || "";
  }, [messages, job.waiting]);

  // Accessible polite announcement for screen readers on new non-user messages
  const liveAnnouncement = useMemo(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role === "user") return "";
    if (last.streaming) return "";
    const prefix = last.role === "error" ? "Error: " : last.role === "tool" ? "Tool status: " : "Assistant: ";
    return `${prefix}${(last.summaryLabel || last.text).slice(0, 220)}`;
  }, [messages]);

  // Virtualized window math when messages.length > VIRTUALIZE_THRESHOLD
  const virtualSlice = useMemo(() => {
    if (!isVirtualized) {
      return { startIdx: 0, endIdx: messages.length, topPad: 0, bottomPad: 0 };
    }
    const offsets = new Array<number>(messages.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const fallbackH = m.role === "tool" || m.collapsible ? 38 : 96;
      const h = heightCacheRef.current.get(m.id) ?? fallbackH;
      offsets[i + 1] = offsets[i] + h;
    }
    const total = offsets[messages.length];

    // Binary search first visible row
    let lo = 0;
    let hi = messages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] < scrollTop) lo = mid + 1;
      else hi = mid;
    }
    const startIdx = Math.max(0, lo - OVERSCAN);

    const bottomTarget = scrollTop + viewportHeight;
    let endLo = lo;
    let endHi = messages.length;
    while (endLo < endHi) {
      const mid = (endLo + endHi) >> 1;
      if (offsets[mid] < bottomTarget) endLo = mid + 1;
      else endHi = mid;
    }
    const endIdx = Math.min(messages.length, endLo + OVERSCAN);

    return {
      startIdx,
      endIdx,
      topPad: offsets[startIdx],
      bottomPad: Math.max(0, total - offsets[endIdx]),
    };
  }, [isVirtualized, messages, scrollTop, viewportHeight]);

  const measureRow = useCallback((id: string, el: HTMLDivElement | null) => {
    if (!el) return;
    const h = el.getBoundingClientRect().height + 12; // include vertical gap
    const prev = heightCacheRef.current.get(id);
    if (prev == null || Math.abs(prev - h) > 2) {
      heightCacheRef.current.set(id, h);
      setMeasureTick((n) => n + 1);
    }
  }, []);

  const send = async () => {
    const value = text.trim();
    if (!value || busy || !isOnline) return;
    if (job.running) {
      setText("");
      await job.note(value);
      return;
    }
    setBusy(true);
    setError(null);
    setText("");
    isAtBottomRef.current = true;
    try {
      await job.start(value, mode, pinned);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onAction = async (action: ChatAction, m: ChatMessage) => {
    switch (action.kind) {
      case "settings":
        onOpenSettings();
        return;
      case "edit-models":
        onOpenModels();
        return;
      case "use-model": {
        let provider = action.meta?.provider;
        let oldModel = action.meta?.oldModel;
        let newModel = action.meta?.newModel;
        if ((!provider || !newModel) && action.value) {
          try {
            const parsed = JSON.parse(action.value);
            provider = parsed.provider as ProviderKeyId;
            oldModel = parsed.oldModel;
            newModel = parsed.newModel;
          } catch {
            /* ignore */
          }
        }
        if (provider && newModel) {
          await job.useSuggestedModel(provider, oldModel ?? "", newModel);
          // Re-run last user prompt with the newly selected model if idle
          const lastUser = [...messages].reverse().find((x) => x.role === "user");
          if (lastUser?.text && !job.running) {
            void job.start(lastUser.text, mode, pinned).catch((e) =>
              setError(e instanceof Error ? e.message : String(e)),
            );
          }
        }
        return;
      }
      case "resume":
        void job.resume();
        return;
      case "save-files":
        void job.saveSuggested();
        return;
      case "answer":
        if (action.value) void job.answer(action.value);
        return;
      case "open":
        if (action.value) onOpenFile(action.value);
        return;
      case "retry": {
        const lastUser = [...messages].reverse().find((x) => x.role === "user");
        const value = lastUser?.text ?? text;
        if (value.trim()) {
          setText("");
          void job.start(value, mode, pinned).catch((e) => setError(e instanceof Error ? e.message : String(e)));
        }
        return;
      }
      default:
        void m;
    }
  };

  const activeModalQuestion = job.pendingQuestions.find((q) => !minimizedQuestionIds.has(q.id)) ?? null;

  const handleRespondQuestion = useCallback(
    (res: UserQuestionResponse) => {
      void job.respondQuestion(res);
      setMinimizedQuestionIds((prev) => {
        const next = new Set(prev);
        next.delete(res.id);
        return next;
      });
      textareaRef.current?.focus();
    },
    [job],
  );

  const visibleMessages = isVirtualized
    ? messages.slice(virtualSlice.startIdx, virtualSlice.endIdx)
    : messages;

  return (
    <section aria-label="AI Chat" className="relative flex h-full flex-col">
      {/* Screen-reader live region */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>

      {/* Header: Sessions switcher, Models, New chat, Collapse */}
      <div className="flex flex-none items-center gap-1.5 border-b border-[var(--nova-border)] bg-[var(--nova-bg-panel)] px-3 py-1.5">
        <span className="text-xs font-semibold tracking-tight text-[var(--nova-text-primary)]">Nova Agent</span>
        <button
          type="button"
          aria-expanded={sessionsOpen}
          aria-label="Toggle chat sessions history"
          onClick={() => setSessionsOpen((v) => !v)}
          className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
        >
          Sessions ({job.sessions.length || 1})
        </button>
        <button
          type="button"
          onClick={onOpenModels}
          className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
          title="Configure model routing priority and slugs"
        >
          Models
        </button>
        <button
          type="button"
          onClick={() => {
            setSessionsOpen(false);
            void job.newChat().then(() => textareaRef.current?.focus());
          }}
          className="ml-auto rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
        >
          New chat
        </button>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse chat panel"
            title="Collapse chat panel"
            className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-xs text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
          >
            »
          </button>
        )}
      </div>

      {/* Past sessions drawer */}
      {sessionsOpen && (
        <div
          role="region"
          aria-label="Saved chat sessions"
          className="max-h-56 flex-none overflow-auto border-b border-[var(--color-border)] bg-[var(--color-base)] p-2"
        >
          <div className="mb-1.5 flex items-center justify-between px-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
            <span>Saved conversations</span>
            <button
              type="button"
              onClick={() => setSessionsOpen(false)}
              className="rounded px-1 text-xs hover:text-[var(--color-text)]"
              aria-label="Close sessions list"
            >
              ✕
            </button>
          </div>
          {job.sessions.length === 0 ? (
            <p className="px-1 py-2 text-xs text-[var(--color-muted)]">No saved sessions yet.</p>
          ) : (
            <ul className="space-y-1">
              {job.sessions.map((s) => {
                const isActive = s.id === job.activeSessionId;
                return (
                  <li
                    key={s.id}
                    className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs ${
                      isActive
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                        : "border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-alt)]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSessionsOpen(false);
                        isAtBottomRef.current = true;
                        void job.switchSession(s.id);
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate font-medium text-[var(--color-text)]">{s.title || "New chat"}</div>
                      <div className="text-[10px] text-[var(--color-muted)]">
                        {s.messageCount} msg{s.messageCount === 1 ? "" : "s"} · {formatTimestamp(s.updatedAt)}
                      </div>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete chat session ${s.title}`}
                      title="Delete session"
                      onClick={() => void job.deleteSession(s.id)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-muted)] hover:bg-[var(--color-negative)]/15 hover:text-[var(--color-negative)]"
                    >
                      Delete
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {job.interrupted && !running && (
        <div className="flex items-center gap-2 border-b border-[var(--color-warn)] bg-[var(--color-warn)]/10 px-3 py-2 text-xs text-[var(--color-warn)]">
          <span className="flex-1">An earlier run was interrupted: “{job.interrupted.brief.slice(0, 60)}”</span>
          <button
            type="button"
            className="rounded border border-[var(--color-warn)] px-2 py-0.5"
            onClick={() => void job.resume()}
          >
            Resume
          </button>
          <button
            type="button"
            aria-label="Dismiss interrupted run banner"
            className="rounded px-1 text-[var(--color-muted)]"
            onClick={job.dismissInterrupted}
          >
            ✕
          </button>
        </div>
      )}

      {/* Scrollable message list */}
      <div
        ref={logRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Chat message history"
        data-chat-log
        className="relative flex-1 space-y-2.5 overflow-auto p-3"
      >
        {messages.length === 0 && !job.thinking && (
          <div className="mt-4">
            <p className="mb-3 text-center text-sm text-[var(--color-text)]">What should we build?</p>
            <div className="grid grid-cols-1 gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  type="button"
                  key={ex.label}
                  onClick={() => {
                    setText(ex.text);
                    textareaRef.current?.focus();
                  }}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface-alt)] px-2.5 py-2 text-left text-xs text-[var(--color-text)] hover:border-[var(--color-accent)]"
                >
                  <span className="mr-2 rounded bg-[var(--color-base)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted)]">
                    {ex.label}
                  </span>
                  {ex.text}
                </button>
              ))}
            </div>
          </div>
        )}

        {isVirtualized && virtualSlice.topPad > 0 && (
          <div aria-hidden="true" style={{ height: virtualSlice.topPad }} />
        )}

        {visibleMessages.map((m) => (
          <div
            key={m.id}
            ref={isVirtualized ? (el) => measureRow(m.id, el) : undefined}
          >
            <MessageRow
              m={m}
              onAction={(a, msg) => void onAction(a, msg)}
              onRespondQuestion={handleRespondQuestion}
            />
          </div>
        ))}

        {isVirtualized && virtualSlice.bottomPad > 0 && (
          <div aria-hidden="true" style={{ height: virtualSlice.bottomPad }} />
        )}

        {job.thinking && (
          <div
            data-thinking
            className="mr-6 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-alt)] px-3 py-2 text-xs text-[var(--color-muted)]"
          >
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
            {waitingMs < 20000 ? (
              <span>{job.statusLabel || "Thinking…"}</span>
            ) : (
              <span>
                Still waiting for {lastModel || "the model"}… You can wait, or press Stop to cancel immediately.
              </span>
            )}
          </div>
        )}

        {job.plan.length > 0 && (
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-alt)] p-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">Plan</div>
            <ul className="space-y-0.5">
              {job.plan.map((s) => (
                <li key={s.id} className="flex items-start gap-2 text-xs">
                  <span className="mt-[1px] w-3 text-[var(--color-muted)]">
                    {s.status === "done" ? "✓" : s.status === "doing" ? "▸" : s.status === "failed" ? "✗" : "○"}
                  </span>
                  <span className={s.status === "done" ? "text-[var(--color-muted)] line-through" : ""}>{s.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {job.approvals.map((a) => (
          <div key={a.id} className="rounded border border-[var(--color-warn)] bg-[var(--color-warn)]/10 p-2">
            <div className="mb-1 text-xs text-[var(--color-warn)]">The AI wants to run a command. Allow it?</div>
            <pre className="mb-2 overflow-auto rounded bg-[var(--color-base)] p-2 text-[11px] text-[var(--color-text)]">
              {a.command}
            </pre>
            <div className="text-[10px] text-[var(--color-muted)]">{a.reason}</div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="rounded bg-[var(--color-accent)] px-2 py-1 text-xs text-white"
                onClick={() => void job.respond(a.id, "once")}
              >
                Allow once
              </button>
              <button
                type="button"
                className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
                onClick={() => void job.respond(a.id, "always")}
              >
                Always allow
              </button>
              <button
                type="button"
                className="rounded border border-[var(--color-negative)] px-2 py-1 text-xs text-[var(--color-negative)]"
                onClick={() => void job.respond(a.id, "deny")}
              >
                Deny
              </button>
            </div>
          </div>
        ))}

        {job.waiting && (
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-alt)] p-2 text-xs text-[var(--color-muted)]">
            Cooldown active on <span className="font-mono">{job.waiting.lane === "*" ? "all lanes" : job.waiting.lane}</span>
            {job.waiting.resumeAtMs ? ` — estimated local resume at ${hhmm(job.waiting.resumeAtMs)}` : ""}.
          </div>
        )}
      </div>

      {/* Floating "Jump to latest" button when user scrolled up */}
      {showJumpLatest && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[132px] flex justify-center">
          <button
            type="button"
            onClick={jumpToLatest}
            className="pointer-events-auto rounded-full border border-[var(--color-accent)] bg-[var(--color-surface)] px-3 py-1 text-xs font-medium text-[var(--color-accent-strong)] shadow-lg hover:bg-[var(--color-surface-alt)]"
          >
            ↓ Jump to latest
          </button>
        </div>
      )}

      {!isOnline && (
        <div
          role="status"
          className="border-t border-[var(--color-warn)] bg-[var(--color-warn)]/10 px-3 py-1.5 text-xs text-[var(--color-warn)]"
        >
          You are offline. Reconnect to send new messages.
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="border-t border-[var(--color-negative)] bg-[var(--color-negative)]/10 px-3 py-1.5 text-xs text-[var(--color-negative)]"
        >
          {error}
        </div>
      )}

      {/* Composer */}
      <div className="flex-none border-t border-[var(--color-border)] p-2">
        <textarea
          ref={textareaRef}
          aria-label="Chat message input"
          value={text}
          disabled={!isOnline}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
          placeholder={
            !isOnline
              ? "Offline — reconnect to chat"
              : running
              ? "Type a note for the agent (Enter to send), or press Stop…"
              : "Ask anything or describe a task. Enter to send, Shift+Enter for newline."
          }
          className="w-full resize-none rounded border border-[var(--color-border)] bg-[var(--color-base)] p-2 text-sm text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
        />

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[10px] text-[var(--color-muted)]" title="What MyIDE thinks you asked for">
            Detected:
            <select
              value={pinned}
              onChange={(e) => setPinned(e.target.value as IntentChoice)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-base)] px-1 py-0.5 text-[10px] text-[var(--color-text)]"
            >
              {INTENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value === "auto" ? `Auto (${detection.label})` : o.label}
                </option>
              ))}
            </select>
          </label>

          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as JobMode)}
            disabled={running}
            aria-label="Execution mode"
            className="rounded border border-[var(--color-border)] bg-[var(--color-base)] px-1.5 py-1 text-[10px] capitalize"
            title="Fast = quickest, Balanced = normal, Best = most checks"
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <span className="text-[10px] text-[var(--color-muted)]" title={estimate.note}>
            ~{estimate.requests} req
          </span>

          <div className="ml-auto flex items-center gap-2">
            {running ? (
              <>
                <button
                  type="button"
                  className="rounded border border-[var(--color-border)] px-2.5 py-1 text-xs hover:bg-[var(--color-surface-alt)]"
                  onClick={() => void job.pause()}
                >
                  Pause
                </button>
                <button
                  type="button"
                  data-chat-stop
                  aria-label="Stop streaming and cancel request"
                  className="rounded bg-[var(--color-negative)] px-3 py-1 text-xs font-medium text-white hover:opacity-90"
                  onClick={() => void job.stop()}
                >
                  Stop
                </button>
              </>
            ) : (
              <button
                type="button"
                data-chat-send
                className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
                onClick={() => void send()}
                disabled={!text.trim() || busy || !isOnline}
              >
                Start
              </button>
            )}
          </div>
        </div>

        <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--color-muted)]">
          <button type="button" onClick={onOpenWorkspace} className="hover:text-[var(--color-text)] hover:underline">
            {job.snapshot?.id ? "Project folder" : "Choose project folder"}
          </button>
          <span>·</span>
          <span>
            {!isOnline ? "Offline" : running ? "Streaming…" : "Ready"} · {INTENT_LABELS[detection.intent]}
          </span>
        </div>
      </div>

      {/* PART 3: Active popup question modal */}
      {activeModalQuestion && (
        <PopupQuestionModal
          request={activeModalQuestion}
          onRespond={handleRespondQuestion}
          onMinimize={() =>
            setMinimizedQuestionIds((prev) => new Set(prev).add(activeModalQuestion.id))
          }
        />
      )}
    </section>
  );
}

function MessageRow({
  m,
  onAction,
  onRespondQuestion,
}: {
  m: ChatMessage;
  onAction: (a: ChatAction, m: ChatMessage) => void;
  onRespondQuestion: (res: UserQuestionResponse) => void;
}) {
  if (m.role === "user") {
    return (
      <div data-msg="user" className="ml-6 rounded-lg bg-[var(--color-accent)]/15 px-3 py-2">
        <div className="mb-0.5 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-[var(--color-accent-strong)]">
          <span>You</span>
          <Timestamp ts={m.ts} />
        </div>
        <div className="whitespace-pre-wrap text-sm text-[var(--color-text)]">{m.text}</div>
      </div>
    );
  }

  // Collapsible compact item for tool calls and status/model-switch lines (PART 2)
  if (m.role === "tool" || m.collapsible) {
    const label = m.summaryLabel || (m.role === "tool" ? `${m.toolName || "Tool"} ${m.ok ? "✓" : "✗"}` : m.text.split("\n")[0]);
    return (
      <details
        data-msg={m.role}
        className="group rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2.5 py-1 text-xs"
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)]">
          <span className="text-[10px] transition-transform group-open:rotate-90">▸</span>
          <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
          {m.model && <span className="rounded bg-[var(--color-surface-alt)] px-1 font-mono text-[10px]">{m.model}</span>}
          <Timestamp ts={m.ts} />
        </summary>
        <div className="mt-1.5 border-t border-[var(--color-border)] pt-1.5">
          {m.role === "tool" ? (
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-[var(--color-muted)]">
              {m.text}
            </pre>
          ) : (
            <Markdown text={m.text} />
          )}
          <ActionRow m={m} onAction={onAction} />
        </div>
      </details>
    );
  }

  if (m.role === "notice") {
    return (
      <div data-msg="notice" className="rounded border border-[var(--color-border)]/60 bg-[var(--color-surface-alt)]/40 px-2.5 py-1.5 text-xs text-[var(--color-muted)]">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <Markdown text={m.text} />
          </div>
          <Timestamp ts={m.ts} />
        </div>
        {m.files && m.files.length > 0 && <FilesCard files={m.files} />}
        <ActionRow m={m} onAction={onAction} />
      </div>
    );
  }

  if (m.role === "error") {
    return (
      <div
        role="alert"
        data-msg="error"
        className="mr-4 rounded-lg border border-[var(--color-negative)] bg-[var(--color-negative)]/10 px-3 py-2"
      >
        <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-[var(--color-negative)]">
          <span>Action required</span>
          <Timestamp ts={m.ts} />
        </div>
        <Markdown text={m.text} />
        {m.laneDetails && m.laneDetails.length > 0 && <ExhaustedLanesCard details={m.laneDetails} />}
        <ActionRow m={m} onAction={onAction} />
      </div>
    );
  }

  return (
    <div data-msg="assistant" className="mr-4 rounded-lg bg-[var(--color-surface-alt)] px-3 py-2">
      <div className="mb-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
        <span>Nova Agent</span>
        {m.model && <span className="rounded bg-[var(--color-base)] px-1 font-mono normal-case">{m.model}</span>}
        {m.streaming && <span className="normal-case italic text-[var(--color-accent)]">streaming…</span>}
        <span className="ml-auto">
          <Timestamp ts={m.ts} />
        </span>
      </div>
      <Markdown text={m.text} />
      {m.userQuestion && (
        <PopupQuestionHistoryCard record={m.userQuestion} onRespond={onRespondQuestion} />
      )}
      {m.files && m.files.length > 0 && <FilesCard files={m.files} />}
      <ActionRow m={m} onAction={onAction} />
    </div>
  );
}

function ExhaustedLanesCard({ details }: { details: LaneExhaustedDetail[] }) {
  return (
    <div className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-base)] p-2 text-[11px]">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        Lane status breakdown
      </div>
      <ul className="space-y-1">
        {details.map((d) => (
          <li key={d.laneId} className="flex flex-col rounded bg-[var(--color-surface)] px-2 py-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono font-medium text-[var(--color-text)]">{d.laneId}</span>
              <span className="rounded px-1.5 py-0.5 text-[9px] uppercase text-[var(--color-warn)]">{d.status}</span>
            </div>
            <div className="text-[10.5px] text-[var(--color-muted)]">{d.reason}</div>
            {d.resumeAtMs && (
              <div className="text-[10px] text-[var(--color-accent-strong)]">
                Est. resume (local): {hhmm(d.resumeAtMs)}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActionRow({ m, onAction }: { m: ChatMessage; onAction: (a: ChatAction, m: ChatMessage) => void }) {
  const list = m.actions && m.actions.length > 0 ? m.actions : m.action ? [m.action] : [];
  if (list.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {list.map((a, i) => (
        <ActionButton key={`${a.kind}-${a.label}-${i}`} a={a} m={m} onAction={onAction} />
      ))}
    </div>
  );
}

function ActionButton({
  a,
  m,
  onAction,
}: {
  a: ChatAction;
  m: ChatMessage;
  onAction: (a: ChatAction, m: ChatMessage) => void;
}) {
  const primary =
    a.kind === "use-model" || a.kind === "retry" || a.kind === "resume" || a.kind === "save-files";
  return (
    <button
      type="button"
      onClick={() => onAction(a, m)}
      className={
        primary
          ? "rounded bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90"
          : "rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2.5 py-1 text-[11px] text-[var(--color-text)] hover:bg-[var(--color-surface-alt)]"
      }
    >
      {a.label}
    </button>
  );
}

function FilesCard({ files }: { files: NonNullable<ChatMessage["files"]> }) {
  return (
    <div className="mt-1.5 rounded border border-[var(--color-border)] bg-[var(--color-base)] p-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">Files changed</div>
      <ul className="space-y-0.5">
        {files.map((f) => (
          <li key={f.path} className="flex items-center gap-2 text-[11px]">
            <span className="w-14 shrink-0 text-[var(--color-muted)]">{f.change}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text)]" title={f.path}>
              {f.path}
            </span>
            <span className="shrink-0 text-[var(--color-muted)]">{f.bytes} B</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Timestamp({ ts }: { ts: number }) {
  if (!ts) return null;
  const d = new Date(ts);
  return (
    <time
      dateTime={d.toISOString()}
      title={d.toLocaleString()}
      className="shrink-0 font-mono text-[10px] normal-case text-[var(--color-muted)]"
    >
      {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

function formatTimestamp(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
