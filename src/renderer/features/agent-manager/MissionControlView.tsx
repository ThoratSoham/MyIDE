import React, { useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Cpu,
  FolderOpen,
  Layers,
  MessageSquarePlus,
  Play,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { ChatSessionMeta, JobMode } from "../../../shared/electron-api-types";
import type { JobController } from "../../hooks/useJob";
import { MissionOrbitGlyph, NovaSparkGlyph } from "../../branding/NovaBrand";
import { Badge, Kbd, StatusDot } from "../../design-system/primitives";
import { useLayoutStore } from "../../stores/layoutStore";

interface Props {
  job: JobController;
  workspaceRoot: string;
  defaultMode: JobMode;
  onOpenModels: () => void;
  onSwitchWorkspace: (dirPath: string) => void;
}

type StatusFilter = "all" | "running" | "waiting" | "done" | "failed";

export function MissionControlView({
  job,
  workspaceRoot,
  defaultMode,
  onOpenModels,
  onSwitchWorkspace,
}: Props) {
  const { setAppMode, setAgentPanelOpen, recentWorkspaces } = useLayoutStore();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("all");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const activeSessionId = job.activeSessionId;
  const snap = job.snapshot;
  const isActiveRunning = !!snap?.running;
  const isActiveWaiting =
    job.pendingQuestions.length > 0 || job.approvals.length > 0 || !!snap?.paused || !!snap?.waiting;

  // Enrich sessions with live active job state
  const enrichedSessions = useMemo(() => {
    return job.sessions.map((s) => {
      const isCurrent = s.id === activeSessionId;
      let status: "running" | "waiting" | "done" | "failed" | "idle" = s.lastStatus ?? "idle";
      let model = s.lastModel;
      let progressLabel = `${s.messageCount} messages`;

      if (isCurrent) {
        if (isActiveWaiting) {
          status = "waiting";
          progressLabel =
            job.pendingQuestions.length > 0
              ? "Waiting for your answer"
              : job.approvals.length > 0
              ? "Waiting for command approval"
              : snap?.waiting
              ? "Waiting on free-tier cooldown"
              : "Paused";
        } else if (isActiveRunning) {
          status = "running";
          const doingStep = snap?.plan?.find((p) => p.status === "doing");
          progressLabel = doingStep ? doingStep.title : "Agent executing…";
        }
        const latestModel = [...job.messages].reverse().find((m) => m.model)?.model;
        if (latestModel) model = latestModel;
      }

      const ws = s.workspaceRoot || (isCurrent ? workspaceRoot : "");
      return {
        ...s,
        liveStatus: status,
        liveModel: model || "auto-router",
        progressLabel,
        resolvedWorkspace: ws,
        isCurrent,
      };
    });
  }, [
    activeSessionId,
    isActiveRunning,
    isActiveWaiting,
    job.approvals.length,
    job.messages,
    job.pendingQuestions.length,
    job.sessions,
    snap?.paused,
    snap?.plan,
    snap?.waiting,
    workspaceRoot,
  ]);

  const discoveredWorkspaces = useMemo(() => {
    const set = new Set<string>();
    if (workspaceRoot) set.add(workspaceRoot);
    for (const w of recentWorkspaces) if (w) set.add(w);
    for (const s of enrichedSessions) if (s.resolvedWorkspace) set.add(s.resolvedWorkspace);
    return [...set];
  }, [enrichedSessions, recentWorkspaces, workspaceRoot]);

  const filtered = useMemo(() => {
    return enrichedSessions.filter((s) => {
      if (statusFilter !== "all" && s.liveStatus !== statusFilter) return false;
      if (workspaceFilter !== "all" && s.resolvedWorkspace !== workspaceFilter) return false;
      return true;
    });
  }, [enrichedSessions, statusFilter, workspaceFilter]);

  const counts = useMemo(() => {
    return {
      all: enrichedSessions.length,
      running: enrichedSessions.filter((s) => s.liveStatus === "running").length,
      waiting: enrichedSessions.filter((s) => s.liveStatus === "waiting").length,
      done: enrichedSessions.filter((s) => s.liveStatus === "done").length,
      failed: enrichedSessions.filter((s) => s.liveStatus === "failed").length,
    };
  }, [enrichedSessions]);

  const openSessionInEditor = async (s: (typeof enrichedSessions)[number]) => {
    if (s.resolvedWorkspace && s.resolvedWorkspace !== workspaceRoot) {
      onSwitchWorkspace(s.resolvedWorkspace);
    }
    if (s.id !== activeSessionId) {
      await job.switchSession(s.id);
    }
    setAgentPanelOpen(true);
    setAppMode("editor");
  };

  const launchNewAgentTask = async () => {
    const clean = prompt.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      await job.newChat();
      await job.start(clean, defaultMode, "auto");
      setPrompt("");
      setAgentPanelOpen(true);
      setAppMode("editor");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      role="main"
      aria-label="Agent Manager — Mission Control"
      data-mission-control
      className="flex min-h-0 flex-1 overflow-hidden bg-[var(--nova-bg-app)]"
    >
      {/* Left Mission Filter Rail */}
      <aside className="flex w-60 flex-none flex-col border-r border-[var(--nova-border)] bg-[var(--nova-bg-panel)] p-3">
        <div className="mb-3 flex items-center gap-2 px-1">
          <MissionOrbitGlyph size={16} className="text-[var(--nova-accent-bright)]" />
          <span className="text-xs font-semibold tracking-wide text-[var(--nova-text-primary)]">
            Mission Control
          </span>
        </div>

        <button
          type="button"
          onClick={() => {
            void job.newChat().then(() => {
              setAgentPanelOpen(true);
              setAppMode("editor");
            });
          }}
          className="mb-4 flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--nova-accent)] px-3 py-2 text-xs font-medium text-white shadow-sm hover:bg-[var(--nova-accent-hover)]"
        >
          <Plus size={14} />
          <span>New Conversation</span>
        </button>

        <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--nova-text-muted)]">
          Status
        </div>
        <nav aria-label="Task status filters" className="mb-5 space-y-0.5">
          {(
            [
              { id: "all", label: "All Conversations", count: counts.all },
              { id: "running", label: "Running", count: counts.running },
              { id: "waiting", label: "Waiting for Input", count: counts.waiting },
              { id: "done", label: "Completed", count: counts.done },
              { id: "failed", label: "Failed", count: counts.failed },
            ] as const
          ).map((f) => {
            const active = statusFilter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id)}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs ${
                  active
                    ? "bg-[var(--nova-accent-soft)] font-medium text-[var(--nova-accent-bright)]"
                    : "text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)]"
                }`}
              >
                <span className="flex items-center gap-2">
                  {f.id !== "all" && <StatusDot state={f.id} />}
                  <span>{f.label}</span>
                </span>
                <span className="font-mono text-[10.5px] opacity-75">{f.count}</span>
              </button>
            );
          })}
        </nav>

        <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--nova-text-muted)]">
          Workspaces
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          <button
            type="button"
            onClick={() => setWorkspaceFilter("all")}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs ${
              workspaceFilter === "all"
                ? "bg-[var(--nova-bg-active)] font-medium text-[var(--nova-text-primary)]"
                : "text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)]"
            }`}
          >
            <Layers size={13} className="shrink-0 text-[var(--nova-text-muted)]" />
            <span className="truncate">All Workspaces</span>
          </button>
          {discoveredWorkspaces.map((ws) => {
            const name = ws.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || ws;
            const active = workspaceFilter === ws;
            return (
              <button
                key={ws}
                type="button"
                onClick={() => setWorkspaceFilter(ws)}
                title={ws}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs ${
                  active
                    ? "bg-[var(--nova-bg-active)] font-medium text-[var(--nova-text-primary)]"
                    : "text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)]"
                }`}
              >
                <FolderOpen size={13} className="shrink-0 text-[var(--nova-accent-bright)]" />
                <span className="truncate">{name}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 border-t border-[var(--nova-border-subtle)] pt-3 text-[11px] text-[var(--nova-text-muted)]">
          <button
            type="button"
            onClick={onOpenModels}
            className="flex w-full items-center justify-between rounded-md border border-[var(--nova-border)] bg-[var(--nova-bg-surface)] px-2.5 py-1.5 text-xs text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
          >
            <span className="flex items-center gap-1.5">
              <Cpu size={13} className="text-[var(--nova-accent-bright)]" />
              Free-Tier Router
            </span>
            <ArrowUpRight size={12} />
          </button>
        </div>
      </aside>

      {/* Main Mission Control Canvas */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
        <div className="mx-auto w-full max-w-5xl space-y-6">
          {/* Header + Quick Launch Composer */}
          <div className="rounded-xl border border-[var(--nova-border)] bg-[var(--nova-bg-panel)] p-5 shadow-[var(--nova-shadow-sm)]">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h1 className="flex items-center gap-2 text-base font-semibold text-[var(--nova-text-primary)]">
                  <NovaSparkGlyph size={15} className="text-[var(--nova-accent-bright)]" />
                  Agent Mission Control
                </h1>
                <p className="text-xs text-[var(--nova-text-muted)]">
                  Monitor agent tasks across workspaces, respond to pending questions, or dispatch a new free-tier run.
                </p>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-[var(--nova-text-muted)]">
                <span>Switch to Editor</span>
                <Kbd>Ctrl+Shift+M</Kbd>
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-[var(--nova-border-strong)] bg-[var(--nova-bg-app)] px-3 py-2 focus-within:border-[var(--nova-accent-bright)]">
              <Sparkles size={15} className="shrink-0 text-[var(--nova-accent-bright)]" />
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void launchNewAgentTask();
                  }
                }}
                placeholder="Start a new agent task in the active workspace (Enter to launch)…"
                aria-label="Start a new agent task"
                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--nova-text-primary)] placeholder-[var(--nova-text-muted)] outline-none"
              />
              <button
                type="button"
                disabled={!prompt.trim() || busy}
                onClick={() => void launchNewAgentTask()}
                className="flex items-center gap-1.5 rounded-md bg-[var(--nova-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--nova-accent-hover)] disabled:opacity-40"
              >
                <Play size={12} />
                <span>Launch</span>
              </button>
            </div>
          </div>

          {/* KPI Strip */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricTile label="Running Now" value={counts.running} tone="accent" icon={<Play size={14} />} />
            <MetricTile
              label="Waiting on You"
              value={counts.waiting}
              tone={counts.waiting > 0 ? "warning" : "neutral"}
              icon={<Clock size={14} />}
            />
            <MetricTile label="Completed" value={counts.done} tone="success" icon={<CheckCircle2 size={14} />} />
            <MetricTile
              label="Failed / Quota"
              value={counts.failed}
              tone={counts.failed > 0 ? "danger" : "neutral"}
              icon={<AlertCircle size={14} />}
            />
          </div>

          {/* Task List */}
          <div>
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--nova-text-muted)]">
                Agent Conversations & Tasks ({filtered.length})
              </h2>
            </div>

            {filtered.length === 0 ? (
              <div className="rounded-xl border border-[var(--nova-border)] bg-[var(--nova-bg-panel)] p-10 text-center">
                <MessageSquarePlus size={28} className="mx-auto mb-2 text-[var(--nova-text-muted)] opacity-60" />
                <div className="text-sm font-medium text-[var(--nova-text-primary)]">
                  No agent tasks match this filter
                </div>
                <p className="mt-1 text-xs text-[var(--nova-text-muted)]">
                  Launch a task above or switch back to the Editor view to start pair programming.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {filtered.map((s) => (
                  <SessionTaskRow
                    key={s.id}
                    session={s}
                    onOpen={() => void openSessionInEditor(s)}
                    onDelete={() => void job.deleteSession(s.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function MetricTile({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number;
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
  icon: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-[var(--nova-border)] bg-[var(--nova-bg-panel)] px-4 py-3">
      <div>
        <div className="text-[11px] text-[var(--nova-text-muted)]">{label}</div>
        <div className="mt-0.5 text-xl font-semibold tabular-nums text-[var(--nova-text-primary)]">{value}</div>
      </div>
      <Badge tone={tone} className="p-2">
        {icon}
      </Badge>
    </div>
  );
}

function SessionTaskRow({
  session,
  onOpen,
  onDelete,
}: {
  session: ChatSessionMeta & {
    liveStatus: "running" | "waiting" | "done" | "failed" | "idle";
    liveModel: string;
    progressLabel: string;
    resolvedWorkspace: string;
    isCurrent: boolean;
  };
  onOpen: () => void;
  onDelete: () => void;
}) {
  const wsName = session.resolvedWorkspace
    ? session.resolvedWorkspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || session.resolvedWorkspace
    : "Default workspace";

  const statusTone: Record<typeof session.liveStatus, "accent" | "warning" | "success" | "danger" | "neutral"> = {
    running: "accent",
    waiting: "warning",
    done: "success",
    failed: "danger",
    idle: "neutral",
  };

  const statusText: Record<typeof session.liveStatus, string> = {
    running: "Running",
    waiting: "Waiting for input",
    done: "Done",
    failed: "Failed",
    idle: "Idle",
  };

  return (
    <div
      data-mission-card={session.id}
      className={`group flex items-center justify-between gap-4 rounded-xl border p-4 transition-colors ${
        session.isCurrent
          ? "border-[var(--nova-accent-border)] bg-[var(--nova-bg-surface)]"
          : "border-[var(--nova-border)] bg-[var(--nova-bg-panel)] hover:border-[var(--nova-border-strong)] hover:bg-[var(--nova-bg-surface)]"
      }`}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-3 text-left">
        <div className="mt-1">
          <StatusDot state={session.liveStatus} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-[var(--nova-text-primary)]">
              {session.title || "Untitled conversation"}
            </span>
            <Badge tone={statusTone[session.liveStatus]}>{statusText[session.liveStatus]}</Badge>
            {session.isCurrent && <Badge tone="neutral">Active</Badge>}
          </div>

          {session.lastPreview && (
            <p className="mt-1 truncate text-xs text-[var(--nova-text-secondary)]">{session.lastPreview}</p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-[var(--nova-text-muted)]">
            <span className="inline-flex items-center gap-1" title={session.resolvedWorkspace}>
              <FolderOpen size={11} />
              {wsName}
            </span>
            <span className="inline-flex items-center gap-1 font-mono">
              <Cpu size={11} />
              {session.liveModel}
            </span>
            <span>{session.progressLabel}</span>
            <span>{formatRelative(session.updatedAt)}</span>
          </div>
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-1 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-bg-elevated)] px-2.5 py-1.5 text-xs font-medium text-[var(--nova-text-primary)] hover:border-[var(--nova-accent-bright)] hover:bg-[var(--nova-accent-soft)]"
        >
          <span>Open</span>
          <ArrowUpRight size={13} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Delete conversation ${session.title}`}
          title="Delete conversation"
          className="rounded-lg p-1.5 text-[var(--nova-text-muted)] opacity-0 hover:bg-[var(--nova-danger-soft)] hover:text-[var(--nova-danger)] group-hover:opacity-100 focus:opacity-100"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

function formatRelative(ts: number): string {
  if (!ts) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return new Date(ts).toLocaleDateString();
}
