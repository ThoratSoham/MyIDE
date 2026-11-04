import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatEvent,
  ChatMessage,
  ChatSessionMeta,
  DetectedIntent,
  InterruptedRun,
  IntentChoice,
  JobMode,
  JobSnapshot,
  PlanStep,
  ProviderKeyId,
  RunEstimate,
  UserQuestionRequest,
  UserQuestionResponse,
} from "../../shared/electron-api-types";

export interface JobController {
  snapshot: JobSnapshot | null;
  messages: ChatMessage[];
  sessions: ChatSessionMeta[];
  activeSessionId: string;
  approvals: ApprovalRequest[];
  pendingQuestions: UserQuestionRequest[];
  interrupted: InterruptedRun | null;
  running: boolean;
  thinking: boolean;
  statusLabel: string;
  lastActivity: number;
  waiting: { lane: string; resumeAtMs: number | null } | null;
  paused: { reason: string; options: string[] } | null;
  plan: PlanStep[];
  detected: DetectedIntent | null;
  estimate: RunEstimate | null;
  start: (text: string, mode: JobMode, intent: IntentChoice) => Promise<void>;
  answer: (value: string) => Promise<void>;
  saveSuggested: () => Promise<void>;
  newChat: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  useSuggestedModel: (provider: ProviderKeyId, oldModel: string, newModel: string) => Promise<void>;
  note: (text: string) => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  resume: () => Promise<void>;
  respond: (id: string, decision: ApprovalDecision) => Promise<void>;
  respondQuestion: (res: UserQuestionResponse) => Promise<void>;
  dismissInterrupted: () => void;
}

interface Options {
  onPreview: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onWorkspaceChanged?: () => void;
}

function upsert(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const at = list.findIndex((m) => m.id === msg.id);
  if (at === -1) return [...list, msg];
  const next = list.slice();
  next[at] = { ...next[at], ...msg };
  return next;
}

export function useJob({ onPreview, onOpenFile, onWorkspaceChanged }: Options): JobController {
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<UserQuestionRequest[]>([]);
  const [interrupted, setInterrupted] = useState<InterruptedRun | null>(null);
  const [thinking, setThinking] = useState(false);
  const [statusLabel, setStatusLabel] = useState("Thinking…");
  const [lastActivity, setLastActivity] = useState(0);
  const [waiting, setWaiting] = useState<{ lane: string; resumeAtMs: number | null } | null>(null);
  const [plan, setPlan] = useState<PlanStep[]>([]);

  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;
  const traceRef = useRef("----");
  const workspaceChangedRef = useRef(onWorkspaceChanged);
  workspaceChangedRef.current = onWorkspaceChanged;

  const refresh = useCallback(async () => {
    const snap = await window.electron.jobs.snapshot();
    setSnapshot(snap);
    if (!snap?.running && snap?.finishedAt) setInterrupted(null);
  }, []);

  const loadHistoryAndSessions = useCallback(async () => {
    try {
      const [history, sessionInfo] = await Promise.all([
        window.electron.jobs.history(),
        window.electron.sessions.list(),
      ]);
      setMessages(history);
      setSessions(sessionInfo.sessions);
      setActiveSessionId(sessionInfo.activeSessionId);
    } catch {
      setMessages([]);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, 50);
    };

    const off = window.electron.jobs.onEvent((e: ChatEvent) => {
      if (!alive) return;
      setLastActivity(Date.now());
      switch (e.type) {
        case "message": {
          const t = traceRef.current;
          console.log(`[chat ${t}] 7 renderer: event received (${e.msgId})`);
          setMessages((prev) => upsert(prev, { ...e.message, streaming: false }));
          console.log(`[chat ${t}] 8 renderer: state updated (${e.msgId})`);
          requestAnimationFrame(() => console.log(`[chat ${t}] 9 renderer: bubble rendered (${e.msgId})`));
          return;
        }
        case "delta":
          setMessages((prev) =>
            prev.some((m) => m.id === e.msgId)
              ? prev.map((m) =>
                  m.id === e.msgId ? { ...m, text: m.text + e.text, streaming: true, model: e.model ?? m.model } : m,
                )
              : [
                  ...prev,
                  {
                    id: e.msgId,
                    role: "assistant",
                    text: e.text,
                    model: e.model,
                    streaming: true,
                    ts: Date.now(),
                  },
                ],
          );
          return;
        case "tool":
          setMessages((prev) =>
            upsert(prev, {
              id: e.msgId,
              role: "tool",
              ok: e.ok,
              toolName: e.name,
              toolArgs: e.args,
              summaryLabel: e.summaryLabel ?? `${e.name} ${e.ok ? "✓" : "✗"}`,
              collapsible: true,
              text: `${e.name} ${e.ok ? "✓" : "✗"}\n${e.output}`,
              ts: Date.now(),
            }),
          );
          return;
        case "history":
          setMessages(e.messages);
          if (e.sessionId) setActiveSessionId(e.sessionId);
          return;
        case "sessions":
          setSessions(e.sessions);
          setActiveSessionId(e.activeSessionId);
          return;
        case "status":
          setThinking(e.phase === "thinking");
          if (e.label) setStatusLabel(e.label);
          else if (e.phase === "thinking") setStatusLabel("Thinking…");
          return;
        case "plan":
          setPlan(e.steps);
          return;
        case "waiting":
          setWaiting(e.resumeAtMs || e.lane ? { lane: e.lane, resumeAtMs: e.resumeAtMs } : null);
          return;
        case "paused":
          setThinking(false);
          scheduleRefresh();
          return;
        case "approval":
          setApprovals((prev) => (prev.some((a) => a.id === e.request.id) ? prev : [...prev, e.request]));
          return;
        case "approval-resolved":
          setApprovals((prev) => prev.filter((a) => a.id !== e.id));
          return;
        case "user-question":
          setPendingQuestions((prev) => (prev.some((q) => q.id === e.request.id) ? prev : [...prev, e.request]));
          return;
        case "user-question-resolved":
          setPendingQuestions((prev) => prev.filter((q) => q.id !== e.id));
          return;
        case "preview":
          previewRef.current(e.path);
          return;
        case "open-file":
          openFileRef.current?.(e.path);
          return;
        case "workspace":
          workspaceChangedRef.current?.();
          return;
        case "files":
          workspaceChangedRef.current?.();
          return;
        case "done":
          setThinking(false);
          setWaiting(null);
          scheduleRefresh();
          return;
        case "error":
          setThinking(false);
          setWaiting(null);
          scheduleRefresh();
          return;
        default:
          scheduleRefresh();
      }
    });

    void loadHistoryAndSessions();
    void Promise.all([
      refresh(),
      window.electron.jobs.pendingApprovals().then(setApprovals),
      window.electron.jobs.pendingQuestions().then(setPendingQuestions),
    ]);
    void window.electron.jobs.interrupted().then(setInterrupted);

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [refresh, loadHistoryAndSessions]);

  const start = useCallback(
    async (text: string, mode: JobMode, intent: IntentChoice) => {
      const traceId = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
      traceRef.current = traceId;
      console.log(`[chat ${traceId}] 1 renderer: send clicked`);
      setThinking(true);
      setStatusLabel("Thinking…");
      setLastActivity(Date.now());
      setWaiting(null);
      setInterrupted(null);
      try {
        const snap = await window.electron.jobs.start({ text, mode, intent, traceId });
        if (snap) {
          setSnapshot(snap);
          setPlan(snap.plan);
        } else {
          setThinking(false);
          await refresh();
        }
      } catch (e) {
        setThinking(false);
        const message = e instanceof Error ? e.message : String(e);
        setMessages((prev) =>
          upsert(prev, {
            id: `err-${Date.now().toString(36)}`,
            role: "error",
            text: `Could not start: ${message}`,
            ts: Date.now(),
            action: { kind: "retry", label: "Retry now" },
          }),
        );
        throw e;
      }
    },
    [refresh],
  );

  const answer = useCallback(
    async (value: string) => {
      setThinking(true);
      const snap = await window.electron.jobs.answer(value);
      if (snap) {
        setSnapshot(snap);
        setPlan(snap.plan);
      }
      await refresh();
    },
    [refresh],
  );

  const saveSuggested = useCallback(async () => {
    await window.electron.jobs.saveSuggested();
    await refresh();
  }, [refresh]);

  const newChat = useCallback(async () => {
    await window.electron.jobs.newChat();
    setMessages([]);
    setPlan([]);
    setThinking(false);
    const s = await window.electron.sessions.list();
    setSessions(s.sessions);
    setActiveSessionId(s.activeSessionId);
    await refresh();
  }, [refresh]);

  const switchSession = useCallback(
    async (sessionId: string) => {
      const res = await window.electron.sessions.switch(sessionId);
      setMessages(res.messages);
      setActiveSessionId(res.session.id);
      await refresh();
    },
    [refresh],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      const res = await window.electron.sessions.delete(sessionId);
      setSessions(res.sessions);
      setActiveSessionId(res.activeSessionId);
      setMessages(res.messages);
      await refresh();
    },
    [refresh],
  );

  const useSuggestedModel = useCallback(
    async (provider: ProviderKeyId, oldModel: string, newModel: string) => {
      await window.electron.models.useSuggested(provider, oldModel, newModel);
    },
    [],
  );

  const note = useCallback(
    async (text: string) => {
      await window.electron.jobs.note(text);
      await refresh();
    },
    [refresh],
  );

  const pause = useCallback(async () => {
    await window.electron.jobs.pause();
    setThinking(false);
    await refresh();
  }, [refresh]);

  const stop = useCallback(async () => {
    await window.electron.jobs.cancel();
    setThinking(false);
    await refresh();
  }, [refresh]);

  const resume = useCallback(async () => {
    setThinking(true);
    await window.electron.jobs.resume();
    setInterrupted(null);
    await refresh();
  }, [refresh]);

  const respond = useCallback(async (id: string, decision: ApprovalDecision) => {
    await window.electron.jobs.respondApproval(id, decision);
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const respondQuestion = useCallback(async (res: UserQuestionResponse) => {
    await window.electron.jobs.respondQuestion(res);
    setPendingQuestions((prev) => prev.filter((q) => q.id !== res.id));
  }, []);

  const dismissInterrupted = useCallback(() => setInterrupted(null), []);

  return {
    snapshot,
    messages,
    sessions,
    activeSessionId,
    approvals,
    pendingQuestions,
    interrupted,
    running: !!snapshot?.running,
    thinking,
    statusLabel,
    lastActivity,
    waiting,
    paused: snapshot?.paused ?? null,
    plan,
    detected: snapshot?.detected ?? null,
    estimate: snapshot?.estimate ?? null,
    start,
    answer,
    saveSuggested,
    newChat,
    switchSession,
    deleteSession,
    useSuggestedModel,
    note,
    pause,
    stop,
    resume,
    respond,
    respondQuestion,
    dismissInterrupted,
  };
}
