import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Clock,
  Cpu,
  Gauge,
  GitBranch,
  TerminalSquare,
  Zap,
} from "lucide-react";
import type { JobMode, JobSnapshot } from "../../shared/electron-api-types";
import { StatusDot } from "../design-system/primitives";
import { useLayoutStore } from "../stores/layoutStore";

interface Props {
  snapshot: JobSnapshot | null;
  defaultMode: JobMode;
  inboxCount?: number;
  onOpenModels?: () => void;
  onOpenInbox?: () => void;
}

export function StatusBar({
  snapshot,
  defaultMode,
  inboxCount = 0,
  onOpenModels,
  onOpenInbox,
}: Props) {
  const { appMode, toggleAppMode, openBottomTab, bottomPanelOpen, bottomTab, setBottomPanelOpen } =
    useLayoutStore();

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

  const statusState: "running" | "waiting" | "done" | "idle" = paused || waiting
    ? "waiting"
    : running
    ? "running"
    : "done";

  const statusLabel = paused
    ? "Paused"
    : waiting
    ? "Quota Cooldown"
    : running
    ? "Agent Running"
    : "Ready";

  const handleBottomToggle = (tab: "terminal" | "problems" | "quota") => {
    if (appMode === "editor" && bottomPanelOpen && bottomTab === tab) {
      setBottomPanelOpen(false);
    } else {
      openBottomTab(tab);
    }
  };

  return (
    <footer
      role="contentinfo"
      data-nova-statusbar
      className="flex h-6 flex-none select-none items-center gap-2 border-t border-[var(--nova-border)] bg-[var(--nova-bg-rail)] px-2.5 text-[11px] text-[var(--nova-text-muted)]"
    >
      {/* Left: View mode + branch + quick bottom panel toggles */}
      <button
        type="button"
        onClick={toggleAppMode}
        title="Switch between Editor and Agent Manager (Ctrl+Shift+M)"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-[var(--nova-accent-bright)] hover:bg-[var(--nova-bg-hover)]"
      >
        <Zap size={11} />
        <span>{appMode === "manager" ? "Mission Control" : "Editor"}</span>
      </button>

      <span className="h-3 w-px bg-[var(--nova-border)]" aria-hidden="true" />

      <span className="hidden items-center gap-1 text-[var(--nova-text-secondary)] sm:inline-flex">
        <GitBranch size={11} />
        <span className="capitalize">{mode}</span>
      </span>

      <button
        type="button"
        onClick={() => handleBottomToggle("problems")}
        title="Toggle Problems panel"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
      >
        <AlertTriangle size={11} />
        <span className="hidden md:inline">Problems</span>
      </button>

      <button
        type="button"
        onClick={() => handleBottomToggle("terminal")}
        title="Toggle Integrated Terminal (Ctrl+`)"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
      >
        <TerminalSquare size={11} />
        <span className="hidden md:inline">Terminal</span>
      </button>

      <button
        type="button"
        onClick={() => handleBottomToggle("quota")}
        title="Inspect Free-Tier Provider Quotas"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
      >
        <Gauge size={11} />
        <span className="hidden lg:inline">Quotas</span>
      </button>

      {score != null && (
        <span className="rounded bg-[var(--nova-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--nova-accent-bright)]">
          score {score}/10
        </span>
      )}

      {/* Right: Cooldown countdown, Model pill, Inbox, Run state */}
      <div className="ml-auto flex items-center gap-2">
        {waiting && (
          <div className="flex items-center gap-1.5 rounded border border-[var(--nova-warning)]/40 bg-[var(--nova-warning-soft)] px-2 py-0.5 text-[10.5px] text-[var(--nova-warning)]">
            <Clock size={11} className="animate-pulse" />
            {waiting.lane && <span className="font-mono">{waiting.lane}</span>}
            {waiting.resumeAtMs && (
              <span className="font-mono">
                {hhmm(waiting.resumeAtMs)} · {mmss(countdown)}
              </span>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onOpenModels}
          title="Active free-tier lane (click to configure models)"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
        >
          <Cpu size={11} className="text-[var(--nova-accent-bright)]" />
          <span className="max-w-[200px] truncate">{lastModel || "auto-free-router"}</span>
        </button>

        {inboxCount > 0 && (
          <button
            type="button"
            onClick={onOpenInbox}
            className="flex items-center gap-1 rounded bg-[var(--nova-warning-soft)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--nova-warning)]"
          >
            <Bell size={11} />
            <span>{inboxCount}</span>
          </button>
        )}

        <span className="flex items-center gap-1.5 pl-1 text-[var(--nova-text-primary)]">
          <StatusDot state={statusState} />
          <span>{statusLabel}</span>
        </span>
      </div>
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
