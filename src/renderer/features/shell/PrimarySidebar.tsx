import React, { useEffect, useState } from "react";
import {
  Bell,
  CheckCircle2,
  FileCheck2,
  FileCode2,
  GitBranch,
  HelpCircle,
  Search,
  ShieldAlert,
  Sliders,
} from "lucide-react";
import type { SearchMatch } from "../../../shared/electron-api-types";
import type { JobController } from "../../hooks/useJob";
import { Sidebar } from "../../components/Sidebar";
import { Badge } from "../../design-system/primitives";
import { useLayoutStore } from "../../stores/layoutStore";

interface Props {
  workspaceKey: number;
  job: JobController;
  onOpenFile: (path: string, line?: number) => void;
  onOpenSettings: () => void;
}

export function PrimarySidebar({ workspaceKey, job, onOpenFile, onOpenSettings }: Props) {
  const { activeActivity, sidebarWidth } = useLayoutStore();

  return (
    <aside
      aria-label={`Primary Sidebar — ${activeActivity}`}
      style={{ width: sidebarWidth }}
      className="flex h-full flex-none flex-col overflow-hidden bg-[var(--nova-bg-panel)]"
    >
      {activeActivity === "explorer" && (
        <Sidebar workspaceKey={workspaceKey} onOpenFile={(p) => onOpenFile(p)} embedded />
      )}
      {activeActivity === "search" && (
        <WorkspaceSearchView workspaceKey={workspaceKey} onOpenFile={onOpenFile} />
      )}
      {activeActivity === "inbox" && <InboxSidebarView job={job} />}
      {activeActivity === "artifacts" && <ArtifactsPreviewSidebar job={job} onOpenFile={onOpenFile} />}
      {activeActivity === "git" && <GitPreviewSidebar job={job} onOpenFile={onOpenFile} />}
      {activeActivity === "rules" && <RulesPreviewSidebar onOpenSettings={onOpenSettings} />}
    </aside>
  );
}

function WorkspaceSearchView({
  workspaceKey,
  onOpenFile,
}: {
  workspaceKey: number;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setMatches([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const res = await window.electron.fs.searchFiles(q, 150);
        if (alive) setMatches(res);
      } catch {
        if (alive) setMatches([]);
      } finally {
        if (alive) setBusy(false);
      }
    }, 180);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, workspaceKey]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--nova-border)] px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--nova-text-muted)]">
          Search
        </span>
        {matches.length > 0 && <Badge tone="accent">{matches.length} hits</Badge>}
      </div>

      <div className="border-b border-[var(--nova-border-subtle)] p-2.5">
        <div className="flex items-center gap-2 rounded-md border border-[var(--nova-border)] bg-[var(--nova-bg-app)] px-2.5 py-1.5">
          <Search size={13} className="shrink-0 text-[var(--nova-text-muted)]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search text across workspace…"
            aria-label="Search workspace files"
            className="min-w-0 flex-1 bg-transparent text-xs text-[var(--nova-text-primary)] placeholder-[var(--nova-text-muted)] outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2 text-xs">
        {busy && <div className="p-2 text-[var(--nova-text-muted)]">Searching…</div>}
        {!busy && query.trim() && matches.length === 0 && (
          <div className="p-2 text-[var(--nova-text-muted)]">No matches found for "{query.trim()}".</div>
        )}
        {!query.trim() && (
          <div className="p-2 text-[var(--nova-text-muted)]">
            Type a symbol, string, or phrase to search across workspace files.
          </div>
        )}
        <ul className="space-y-1">
          {matches.map((m, i) => (
            <li key={`${m.path}:${m.line}:${i}`}>
              <button
                type="button"
                onClick={() => onOpenFile(m.path, m.line)}
                className="flex w-full flex-col gap-0.5 rounded-md border border-transparent px-2 py-1.5 text-left hover:border-[var(--nova-border)] hover:bg-[var(--nova-bg-hover)]"
              >
                <div className="flex items-center gap-1.5">
                  <FileCode2 size={12} className="shrink-0 text-[var(--nova-accent-bright)]" />
                  <span className="truncate font-medium text-[var(--nova-text-primary)]">{m.path}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--nova-text-muted)]">
                    :{m.line}
                  </span>
                </div>
                <span className="truncate font-mono text-[11px] text-[var(--nova-text-secondary)]">
                  {m.preview}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function InboxSidebarView({ job }: { job: JobController }) {
  const { approvals, pendingQuestions, respond, setAgentPanelOpen } = {
    approvals: job.approvals,
    pendingQuestions: job.pendingQuestions,
    respond: job.respond,
    setAgentPanelOpen: useLayoutStore.getState().setAgentPanelOpen,
  };

  const totalPending = approvals.length + pendingQuestions.length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--nova-border)] px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--nova-text-muted)]">
          <Bell size={13} />
          Inbox
        </span>
        <Badge tone={totalPending > 0 ? "warning" : "neutral"}>{totalPending} pending</Badge>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3 text-xs">
        {totalPending === 0 && (
          <div className="rounded-lg border border-[var(--nova-border-subtle)] bg-[var(--nova-bg-surface)] p-3 text-[var(--nova-text-muted)]">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-[var(--nova-text-secondary)]">
              <CheckCircle2 size={14} className="text-[var(--nova-success)]" />
              All caught up
            </div>
            Pending agent questions, command approvals, plan reviews, and task completions appear here.
          </div>
        )}

        {pendingQuestions.map((q) => (
          <div
            key={q.id}
            className="rounded-lg border border-[var(--nova-accent-border)] bg-[var(--nova-accent-soft)] p-2.5"
          >
            <div className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--nova-accent-bright)]">
              <HelpCircle size={12} />
              Agent Question
            </div>
            <p className="mb-2 text-xs text-[var(--nova-text-primary)]">{q.question}</p>
            <button
              type="button"
              onClick={() => setAgentPanelOpen(true)}
              className="rounded bg-[var(--nova-accent)] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[var(--nova-accent-hover)]"
            >
              Answer in Chat
            </button>
          </div>
        ))}

        {approvals.map((a) => (
          <div
            key={a.id}
            className="rounded-lg border border-[var(--nova-warning)]/40 bg-[var(--nova-warning-soft)] p-2.5"
          >
            <div className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--nova-warning)]">
              <ShieldAlert size={12} />
              Command Approval Required
            </div>
            <code className="mb-1.5 block truncate rounded bg-[var(--nova-bg-app)] px-2 py-1 font-mono text-[11px] text-[var(--nova-text-primary)]">
              {a.command}
            </code>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => void respond(a.id, "once")}
                className="rounded bg-[var(--nova-accent)] px-2 py-1 text-[11px] font-medium text-white"
              >
                Allow once
              </button>
              <button
                type="button"
                onClick={() => void respond(a.id, "deny")}
                className="rounded border border-[var(--nova-border)] bg-[var(--nova-bg-panel)] px-2 py-1 text-[11px] text-[var(--nova-text-secondary)]"
              >
                Deny
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ArtifactsPreviewSidebar({
  job,
  onOpenFile,
}: {
  job: JobController;
  onOpenFile: (path: string) => void;
}) {
  const plan = job.snapshot?.plan ?? [];
  const files = job.snapshot?.files ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--nova-border)] px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--nova-text-muted)]">
          <FileCheck2 size={13} />
          Artifacts & Plan
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
        <div>
          <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--nova-text-muted)]">
            Active Task Plan ({plan.length})
          </div>
          {plan.length === 0 ? (
            <p className="text-[var(--nova-text-muted)]">
              No active plan steps yet. Run an agent task to generate reviewable plans and artifacts.
            </p>
          ) : (
            <ul className="space-y-1">
              {plan.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 rounded-md border border-[var(--nova-border-subtle)] bg-[var(--nova-bg-surface)] px-2.5 py-1.5"
                >
                  <span className="font-mono text-[10px] uppercase text-[var(--nova-accent-bright)]">
                    {s.status}
                  </span>
                  <span className="truncate text-[var(--nova-text-primary)]">{s.title}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {files.length > 0 && (
          <div>
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--nova-text-muted)]">
              Changed Files ({files.length})
            </div>
            <ul className="space-y-1">
              {files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    onClick={() => onOpenFile(f.path)}
                    className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left hover:bg-[var(--nova-bg-hover)]"
                  >
                    <span className="truncate text-[var(--nova-text-primary)]">{f.path}</span>
                    <Badge tone={f.change === "created" ? "success" : "accent"}>{f.change}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function GitPreviewSidebar({
  job,
  onOpenFile,
}: {
  job: JobController;
  onOpenFile: (path: string) => void;
}) {
  const files = job.snapshot?.files ?? [];
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--nova-border)] px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--nova-text-muted)]">
          <GitBranch size={13} />
          Source Control
        </span>
        {files.length > 0 && <Badge tone="accent">{files.length}</Badge>}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-xs text-[var(--nova-text-muted)]">
        <p>Recent agent file modifications in this workspace:</p>
        {files.length === 0 ? (
          <p className="text-[11px]">Working tree changes & staging controls will appear here.</p>
        ) : (
          <ul className="space-y-1">
            {files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => onOpenFile(f.path)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[var(--nova-text-primary)] hover:bg-[var(--nova-bg-hover)]"
                >
                  <span className="truncate">{f.path}</span>
                  <span className="font-mono text-[10px] uppercase text-[var(--nova-accent-bright)]">
                    {f.change[0]?.toUpperCase()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RulesPreviewSidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--nova-border)] px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--nova-text-muted)]">
          <Sliders size={13} />
          Rules, Workflows & MCP
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs text-[var(--nova-text-muted)]">
        <div className="rounded-lg border border-[var(--nova-border-subtle)] bg-[var(--nova-bg-surface)] p-3">
          <div className="mb-1 font-medium text-[var(--nova-text-primary)]">Workspace Customizations</div>
          <p className="mb-2 leading-relaxed">
            Place project instructions in <code className="font-mono">.nova/rules/</code> and slash workflows in{" "}
            <code className="font-mono">.nova/workflows/</code>.
          </p>
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded border border-[var(--nova-border)] bg-[var(--nova-bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--nova-text-primary)] hover:bg-[var(--nova-bg-hover)]"
          >
            Open Agent Settings
          </button>
        </div>
      </div>
    </div>
  );
}
