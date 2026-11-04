import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Bell,
  ChevronDown,
  Code2,
  Cpu,
  FolderOpen,
  Moon,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Search,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import { MissionOrbitGlyph, NovaLogoMark } from "../../branding/NovaBrand";
import { Kbd } from "../../design-system/primitives";
import { useLayoutStore } from "../../stores/layoutStore";
import { usePaletteStore } from "../../stores/paletteStore";

interface Props {
  workspaceRoot: string;
  theme: "light" | "dark";
  runningCount: number;
  inboxCount: number;
  onOpenFolder: () => void;
  onSwitchWorkspace: (dirPath: string) => void;
  onToggleTheme: () => void;
  onOpenModels: () => void;
  onOpenSettings: () => void;
  onOpenInbox: () => void;
}

export function TopTitleBar({
  workspaceRoot,
  theme,
  runningCount,
  inboxCount,
  onOpenFolder,
  onSwitchWorkspace,
  onToggleTheme,
  onOpenModels,
  onOpenSettings,
  onOpenInbox,
}: Props) {
  const {
    appMode,
    setAppMode,
    sidebarOpen,
    setSidebarOpen,
    agentPanelOpen,
    setAgentPanelOpen,
    agentDockSide,
    toggleAgentDockSide,
    bottomPanelOpen,
    setBottomPanelOpen,
    recentWorkspaces,
  } = useLayoutStore();

  const { openCommands, openQuickOpen } = usePaletteStore();
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const wsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!wsMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (wsMenuRef.current && !wsMenuRef.current.contains(e.target as Node)) {
        setWsMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [wsMenuOpen]);

  const folderName = workspaceRoot
    ? workspaceRoot.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || workspaceRoot
    : "No workspace";

  return (
    <header
      role="banner"
      data-nova-topbar
      className="flex h-10 flex-none select-none items-center gap-2 border-b border-[var(--nova-border)] bg-[var(--nova-bg-rail)] px-3 text-xs"
    >
      {/* Left: Brand + Workspace switcher */}
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex items-center gap-1.5 font-semibold tracking-tight text-[var(--nova-text-primary)]">
          <NovaLogoMark size={18} />
          <span className="text-[13px]">Nova IDE</span>
        </div>

        <span className="h-3.5 w-px bg-[var(--nova-border)]" aria-hidden="true" />

        <div className="relative" ref={wsMenuRef}>
          <button
            type="button"
            onClick={() => setWsMenuOpen((o) => !o)}
            title={workspaceRoot || "Open or switch workspace folder"}
            className="flex max-w-[210px] items-center gap-1.5 rounded-md border border-[var(--nova-border-subtle)] bg-[var(--nova-bg-panel)] px-2 py-1 text-[11.5px] text-[var(--nova-text-secondary)] hover:border-[var(--nova-border-strong)] hover:text-[var(--nova-text-primary)]"
          >
            <FolderOpen size={13} className="shrink-0 text-[var(--nova-accent-bright)]" />
            <span className="truncate font-medium">{folderName}</span>
            <ChevronDown size={12} className="shrink-0 opacity-65" />
          </button>

          {wsMenuOpen && (
            <div
              role="menu"
              className="nova-overlay-enter absolute left-0 top-full z-50 mt-1.5 w-80 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-bg-panel)] p-1.5 shadow-[var(--nova-shadow-lg)]"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setWsMenuOpen(false);
                  onOpenFolder();
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-[var(--nova-text-primary)] hover:bg-[var(--nova-bg-hover)]"
              >
                <FolderOpen size={14} className="text-[var(--nova-accent-bright)]" />
                <span>Open folder…</span>
              </button>

              {recentWorkspaces.length > 0 && (
                <>
                  <div className="my-1 border-t border-[var(--nova-border-subtle)]" />
                  <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--nova-text-muted)]">
                    Recent Workspaces
                  </div>
                  <div className="max-h-52 overflow-auto">
                    {recentWorkspaces.map((ws) => {
                      const active = ws === workspaceRoot;
                      const name = ws.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || ws;
                      return (
                        <button
                          key={ws}
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setWsMenuOpen(false);
                            onSwitchWorkspace(ws);
                          }}
                          className={`flex w-full flex-col rounded-md px-2.5 py-1.5 text-left hover:bg-[var(--nova-bg-hover)] ${
                            active ? "bg-[var(--nova-accent-soft)]" : ""
                          }`}
                        >
                          <span className="truncate text-xs font-medium text-[var(--nova-text-primary)]">
                            {name}
                          </span>
                          <span className="truncate font-mono text-[10px] text-[var(--nova-text-muted)]">
                            {ws}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onOpenFolder}
          className="hidden rounded-md border border-[var(--nova-border-subtle)] px-2 py-1 text-[11px] text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)] xl:inline-flex"
        >
          Open folder…
        </button>
      </div>

      {/* Center: Mode Switcher (Editor vs Agent Manager) + Omnibar */}
      <div className="mx-auto flex items-center gap-2">
        <div
          role="tablist"
          aria-label="Workspace View Mode"
          data-mode-switcher
          className="flex items-center rounded-lg border border-[var(--nova-border)] bg-[var(--nova-bg-panel)] p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={appMode === "editor"}
            data-mode-tab="editor"
            onClick={() => setAppMode("editor")}
            title="Editor View (Ctrl+Shift+M)"
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-medium ${
              appMode === "editor"
                ? "bg-[var(--nova-accent)] text-white shadow-sm"
                : "text-[var(--nova-text-muted)] hover:text-[var(--nova-text-primary)]"
            }`}
          >
            <Code2 size={13} />
            <span>Editor</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={appMode === "manager"}
            data-mode-tab="manager"
            onClick={() => setAppMode("manager")}
            title="Agent Manager — Mission Control (Ctrl+Shift+M)"
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-medium ${
              appMode === "manager"
                ? "bg-[var(--nova-accent)] text-white shadow-sm"
                : "text-[var(--nova-text-muted)] hover:text-[var(--nova-text-primary)]"
            }`}
          >
            <MissionOrbitGlyph size={13} />
            <span>Agent Manager</span>
            {runningCount > 0 && (
              <span className="ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-white/20 px-1 text-[10px] font-semibold">
                {runningCount}
              </span>
            )}
          </button>
        </div>

        <button
          type="button"
          data-omnibar-trigger
          onClick={() => openQuickOpen()}
          onContextMenu={(e) => {
            e.preventDefault();
            openCommands();
          }}
          title="Quick Open files (Ctrl+P) or Command Palette (Ctrl+Shift+P)"
          className="hidden w-64 items-center gap-2 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-bg-panel)] px-2.5 py-1 text-[11.5px] text-[var(--nova-text-muted)] hover:border-[var(--nova-border-strong)] hover:text-[var(--nova-text-secondary)] md:flex lg:w-80"
        >
          <Search size={13} className="shrink-0 opacity-70" />
          <span className="truncate">Search files or commands…</span>
          <span className="ml-auto flex items-center gap-1">
            <Kbd>Ctrl+P</Kbd>
          </span>
        </button>
      </div>

      {/* Right: Layout controls, Inbox, Models, Theme, Settings */}
      <div className="flex items-center gap-1">
        {appMode === "editor" && (
          <div className="mr-1 flex items-center gap-0.5 rounded-md border border-[var(--nova-border-subtle)] bg-[var(--nova-bg-panel)] p-0.5">
            <button
              type="button"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              title="Toggle Primary Sidebar (Ctrl+B)"
              className={`rounded p-1 ${
                sidebarOpen
                  ? "bg-[var(--nova-bg-active)] text-[var(--nova-text-primary)]"
                  : "text-[var(--nova-text-muted)] hover:text-[var(--nova-text-primary)]"
              }`}
            >
              <PanelLeft size={14} />
            </button>
            <button
              type="button"
              onClick={() => setBottomPanelOpen(!bottomPanelOpen)}
              aria-label={bottomPanelOpen ? "Hide terminal" : "Terminal"}
              title="Toggle Bottom Panel — Terminal / Problems / Quota (Ctrl+`)"
              className={`rounded p-1 ${
                bottomPanelOpen
                  ? "bg-[var(--nova-bg-active)] text-[var(--nova-text-primary)]"
                  : "text-[var(--nova-text-muted)] hover:text-[var(--nova-text-primary)]"
              }`}
            >
              <PanelBottom size={14} />
            </button>
            <button
              type="button"
              onClick={() => setAgentPanelOpen(!agentPanelOpen)}
              aria-label={agentPanelOpen ? "Hide chat" : "Chat"}
              title="Toggle Agent Panel (Ctrl+Alt+B)"
              className={`rounded p-1 ${
                agentPanelOpen
                  ? "bg-[var(--nova-bg-active)] text-[var(--nova-text-primary)]"
                  : "text-[var(--nova-text-muted)] hover:text-[var(--nova-text-primary)]"
              }`}
            >
              <PanelRight size={14} />
            </button>
            <button
              type="button"
              onClick={toggleAgentDockSide}
              aria-label={`Dock agent panel on ${agentDockSide === "right" ? "left" : "right"}`}
              title={`Swap Sidebar & Agent Dock (currently Agent on ${agentDockSide})`}
              className="rounded p-1 text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
            >
              <ArrowLeftRight size={13} />
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={onOpenInbox}
          aria-label="Open Inbox"
          title="Agent Inbox (Questions, Approvals & Notifications)"
          className="relative flex items-center gap-1 rounded-md border border-[var(--nova-border-subtle)] bg-[var(--nova-bg-panel)] px-2 py-1 text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
        >
          <Bell size={13} />
          {inboxCount > 0 && (
            <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[var(--nova-warning)] px-1 text-[10px] font-bold text-black">
              {inboxCount}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={onOpenModels}
          title="Configure Free-API Models & Routing Priority"
          className="flex items-center gap-1 rounded-md border border-[var(--nova-border-subtle)] bg-[var(--nova-bg-panel)] px-2 py-1 text-[11.5px] text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
        >
          <Cpu size={13} className="text-[var(--nova-accent-bright)]" />
          <span>Models</span>
        </button>

        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${theme === "dark" ? "Light" : "Dark"} Theme`}
          className="rounded-md border border-[var(--nova-border-subtle)] bg-[var(--nova-bg-panel)] p-1.5 text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
        >
          {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
        </button>

        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings & API Keys (Ctrl+,)"
          className="flex items-center gap-1 rounded-md border border-[var(--nova-border-subtle)] bg-[var(--nova-bg-panel)] px-2 py-1 text-[11.5px] text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
        >
          <SettingsIcon size={13} />
          <span>Settings</span>
        </button>
      </div>
    </header>
  );
}

