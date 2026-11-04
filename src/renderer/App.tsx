import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { EditorArea } from "./components/EditorArea";
import { StatusBar } from "./components/StatusBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { ModelsModal } from "./components/ModelsModal";
import { ChatPanel } from "./components/ChatPanel";
import { PipelinePanel } from "./components/PipelinePanel";
import { PreviewPanel } from "./components/PreviewPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { ResizeSeparator } from "./design-system/primitives";
import { MissionControlView } from "./features/agent-manager/MissionControlView";
import { ActivityBar } from "./features/shell/ActivityBar";
import { CommandPaletteModal } from "./features/shell/CommandPaletteModal";
import { PrimarySidebar } from "./features/shell/PrimarySidebar";
import { TopTitleBar } from "./features/shell/TopTitleBar";
import { useJob } from "./hooks/useJob";
import { useLayoutStore } from "./stores/layoutStore";
import { type CommandItem, usePaletteStore } from "./stores/paletteStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import type { Settings } from "../shared/electron-api-types";

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [pipelineOpen, setPipelineOpen] = useState(false);

  const {
    appMode,
    setAppMode,
    toggleAppMode,
    setActiveActivity,
    toggleActivity,
    sidebarOpen,
    setSidebarOpen,
    sidebarWidth,
    setSidebarWidth,
    agentPanelOpen,
    setAgentPanelOpen,
    agentPanelWidth,
    setAgentPanelWidth,
    agentDockSide,
    toggleAgentDockSide,
    bottomPanelOpen,
    setBottomPanelOpen,
    bottomPanelHeight,
    setBottomPanelHeight,
    openBottomTab,
    hydrate,
    resetLayout,
  } = useLayoutStore();

  const { openCommands, openQuickOpen } = usePaletteStore();

  const {
    root,
    setRoot,
    workspaceKey,
    previewNonce,
    previewPath,
    openTarget,
    bumpWorkspace,
    openFile,
    openPreview,
    closePreview,
    refreshFiles,
  } = useWorkspaceStore();

  const job = useJob({
    onPreview: openPreview,
    onOpenFile: (p) => openFile(p),
    onWorkspaceChanged: bumpWorkspace,
  });

  const applyTheme = useCallback((themeSetting: Settings["theme"]) => {
    const resolved =
      themeSetting === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : themeSetting;
    setTheme(resolved);
    document.documentElement.setAttribute("data-theme", resolved);
  }, []);

  // Hydrate persisted layout, settings, and workspace root on boot
  useEffect(() => {
    void hydrate();
    window.electron.settings.get().then((s) => {
      setSettings(s);
      applyTheme(s.theme);
    });
    window.electron.workspace
      .root()
      .then((r) => {
        setRoot(r);
        void refreshFiles();
      })
      .catch(() => undefined);
  }, [applyTheme, hydrate, refreshFiles, setRoot]);

  // Refresh tree, editor models, and preview when files change on disk
  useEffect(() => {
    const off = window.electron.workspace.onChanged(() => {
      bumpWorkspace();
    });
    return off;
  }, [bumpWorkspace]);

  const onSettingsChange = useCallback(
    (partial: Partial<Settings>) => {
      window.electron.settings.set(partial).then((s) => {
        setSettings(s);
        applyTheme(s.theme);
      });
    },
    [applyTheme],
  );

  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    onSettingsChange({ theme: next });
  }, [onSettingsChange, theme]);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (settings?.theme === "system") applyTheme("system");
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [settings?.theme, applyTheme]);

  const openFolder = useCallback(async () => {
    const picked = await window.electron.workspace.openFolder();
    if (!picked) return;
    setRoot(picked);
    closePreview();
    bumpWorkspace();
    void hydrate();
  }, [bumpWorkspace, closePreview, hydrate, setRoot]);

  const switchWorkspace = useCallback(
    async (dirPath: string) => {
      if (!dirPath) return;
      const ok = await window.electron.workspace.switchRoot(dirPath);
      if (!ok) return;
      setRoot(dirPath);
      closePreview();
      bumpWorkspace();
      void hydrate();
    },
    [bumpWorkspace, closePreview, hydrate, setRoot],
  );

  // Global IDE keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (e.key === "F1" || (mod && e.shiftKey && key === "p")) {
        e.preventDefault();
        openCommands();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && key === "p") {
        e.preventDefault();
        openQuickOpen();
        return;
      }
      if (mod && e.shiftKey && key === "m") {
        e.preventDefault();
        toggleAppMode();
        return;
      }
      if (mod && !e.shiftKey && e.altKey && key === "b") {
        e.preventDefault();
        setAgentPanelOpen(!useLayoutStore.getState().agentPanelOpen);
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && key === "b") {
        e.preventDefault();
        setSidebarOpen(!useLayoutStore.getState().sidebarOpen);
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && e.key === "`") {
        e.preventDefault();
        setBottomPanelOpen(!useLayoutStore.getState().bottomPanelOpen);
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (mod && e.shiftKey && !e.altKey) {
        if (key === "e") {
          e.preventDefault();
          toggleActivity("explorer");
        } else if (key === "f") {
          e.preventDefault();
          toggleActivity("search");
        } else if (key === "g") {
          e.preventDefault();
          toggleActivity("git");
        } else if (key === "a") {
          e.preventDefault();
          toggleActivity("artifacts");
        } else if (key === "i") {
          e.preventDefault();
          toggleActivity("inbox");
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    openCommands,
    openQuickOpen,
    setAgentPanelOpen,
    setBottomPanelOpen,
    setSidebarOpen,
    toggleActivity,
    toggleAppMode,
  ]);

  const commands: CommandItem[] = useMemo(
    () => [
      {
        id: "view.toggleMode",
        category: "View",
        label: "Switch between Editor and Agent Manager (Mission Control)",
        shortcut: "Ctrl+Shift+M",
        keywords: "mission control dashboard manager editor mode",
        run: toggleAppMode,
      },
      {
        id: "view.editor",
        category: "View",
        label: "Open Editor View",
        run: () => setAppMode("editor"),
      },
      {
        id: "view.manager",
        category: "View",
        label: "Open Agent Manager (Mission Control)",
        run: () => setAppMode("manager"),
      },
      {
        id: "file.quickOpen",
        category: "File",
        label: "Go to File…",
        shortcut: "Ctrl+P",
        run: () => openQuickOpen(),
      },
      {
        id: "file.openFolder",
        category: "Workspace",
        label: "Open Workspace Folder…",
        run: () => void openFolder(),
      },
      {
        id: "agent.newChat",
        category: "Agent",
        label: "Start New Agent Conversation",
        run: () => {
          setAppMode("editor");
          setAgentPanelOpen(true);
          void job.newChat();
        },
      },
      {
        id: "agent.togglePanel",
        category: "View",
        label: "Toggle Nova Agent Panel",
        shortcut: "Ctrl+Alt+B",
        run: () => setAgentPanelOpen(!agentPanelOpen),
      },
      {
        id: "agent.swapDock",
        category: "Layout",
        label: `Dock Agent Panel on ${agentDockSide === "right" ? "Left" : "Right"}`,
        run: toggleAgentDockSide,
      },
      {
        id: "sidebar.toggle",
        category: "View",
        label: "Toggle Primary Sidebar",
        shortcut: "Ctrl+B",
        run: () => setSidebarOpen(!sidebarOpen),
      },
      {
        id: "sidebar.explorer",
        category: "View",
        label: "Focus File Explorer",
        shortcut: "Ctrl+Shift+E",
        run: () => setActiveActivity("explorer"),
      },
      {
        id: "sidebar.search",
        category: "View",
        label: "Search in Workspace",
        shortcut: "Ctrl+Shift+F",
        run: () => setActiveActivity("search"),
      },
      {
        id: "sidebar.git",
        category: "View",
        label: "Focus Source Control",
        shortcut: "Ctrl+Shift+G",
        run: () => setActiveActivity("git"),
      },
      {
        id: "sidebar.artifacts",
        category: "View",
        label: "Open Artifacts & Plan Sidebar",
        shortcut: "Ctrl+Shift+A",
        run: () => setActiveActivity("artifacts"),
      },
      {
        id: "sidebar.inbox",
        category: "Agent",
        label: "Open Agent Inbox",
        shortcut: "Ctrl+Shift+I",
        run: () => setActiveActivity("inbox"),
      },
      {
        id: "bottom.terminal",
        category: "Terminal",
        label: "Toggle Integrated Terminal",
        shortcut: "Ctrl+`",
        run: () => openBottomTab("terminal"),
      },
      {
        id: "bottom.problems",
        category: "View",
        label: "Show Problems & Diagnostics",
        run: () => openBottomTab("problems"),
      },
      {
        id: "bottom.output",
        category: "View",
        label: "Show Router & Agent Trace Output",
        run: () => openBottomTab("output"),
      },
      {
        id: "bottom.quota",
        category: "Models",
        label: "Inspect Free-Tier Provider Quotas",
        run: () => openBottomTab("quota"),
      },
      {
        id: "models.configure",
        category: "Models",
        label: "Configure Free-API Models & Routing Priority…",
        run: () => setModelsOpen(true),
      },
      {
        id: "settings.open",
        category: "Preferences",
        label: "Open Nova IDE Settings…",
        shortcut: "Ctrl+,",
        run: () => setSettingsOpen(true),
      },
      {
        id: "theme.toggle",
        category: "Preferences",
        label: `Switch to ${theme === "dark" ? "Light" : "Dark"} Theme`,
        run: toggleTheme,
      },
      {
        id: "layout.reset",
        category: "Layout",
        label: "Reset Panel Layout to Defaults",
        run: resetLayout,
      },
    ],
    [
      agentDockSide,
      agentPanelOpen,
      job,
      openBottomTab,
      openFolder,
      openQuickOpen,
      resetLayout,
      setActiveActivity,
      setAgentPanelOpen,
      setAppMode,
      setSidebarOpen,
      sidebarOpen,
      theme,
      toggleAgentDockSide,
      toggleAppMode,
      toggleTheme,
    ],
  );

  const stages = job.snapshot?.stages ?? [];
  const defaultMode = settings?.defaultMode ?? "balanced";
  const fontSize = settings?.terminalFontSize ?? 13;
  const inboxCount = job.pendingQuestions.length + job.approvals.length;
  const changedFilesCount = job.snapshot?.files?.length ?? 0;
  const runningCount = job.running || job.thinking ? 1 : 0;

  // Auto-expand pipeline drawer while multi-stage pipeline is actively running
  const showPipelineBody = pipelineOpen || stages.some((s) => s.status === "start");

  const agentDockElement = agentPanelOpen ? (
    <aside
      aria-label="Nova Agent Dock"
      data-agent-dock={agentDockSide}
      style={{ width: agentPanelWidth }}
      className="flex flex-none flex-col overflow-hidden bg-[var(--nova-bg-panel)]"
    >
      <div className="min-h-0 flex-1 overflow-hidden">
        <ChatPanel
          job={job}
          defaultMode={defaultMode}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenModels={() => setModelsOpen(true)}
          onOpenFile={(p) => openFile(p)}
          onOpenWorkspace={() => void openFolder()}
          onCollapse={() => setAgentPanelOpen(false)}
        />
      </div>

      {stages.length > 0 && (
        <div className="flex-none border-t border-[var(--nova-border)] bg-[var(--nova-bg-app)]">
          <button
            type="button"
            onClick={() => setPipelineOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
          >
            {showPipelineBody ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>Pipeline Stages ({stages.length})</span>
          </button>
          {showPipelineBody && (
            <div className="h-32 border-t border-[var(--nova-border-subtle)]">
              <PipelinePanel stages={stages} />
            </div>
          )}
        </div>
      )}
    </aside>
  ) : (
    <div
      className={`flex w-8 flex-none flex-col items-center bg-[var(--nova-bg-panel)] py-2 ${
        agentDockSide === "right"
          ? "border-l border-[var(--nova-border)]"
          : "border-r border-[var(--nova-border)]"
      }`}
    >
      <button
        type="button"
        onClick={() => setAgentPanelOpen(true)}
        aria-label="Expand chat panel"
        title="Expand Nova Agent Panel (Ctrl+Alt+B)"
        className="rounded-md border border-[var(--nova-border)] p-1.5 text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
      >
        <MessageSquare size={13} />
      </button>
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-[var(--nova-bg-app)] text-[var(--nova-text-primary)]" data-theme={theme}>
      <TopTitleBar
        workspaceRoot={root}
        theme={theme}
        runningCount={runningCount}
        inboxCount={inboxCount}
        onOpenFolder={() => void openFolder()}
        onSwitchWorkspace={(ws) => void switchWorkspace(ws)}
        onToggleTheme={toggleTheme}
        onOpenModels={() => setModelsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenInbox={() => setActiveActivity("inbox")}
      />

      {appMode === "manager" ? (
        <MissionControlView
          job={job}
          workspaceRoot={root}
          defaultMode={defaultMode}
          onOpenModels={() => setModelsOpen(true)}
          onSwitchWorkspace={(ws) => void switchWorkspace(ws)}
        />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ActivityBar
            inboxCount={inboxCount}
            changedFilesCount={changedFilesCount}
            onOpenModels={() => setModelsOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          {/* Optional Left Agent Dock */}
          {agentDockSide === "left" && (
            <>
              {agentDockElement}
              {agentPanelOpen && (
                <ResizeSeparator
                  orientation="vertical"
                  label="Resize agent panel"
                  value={agentPanelWidth}
                  min={300}
                  max={820}
                  onChange={setAgentPanelWidth}
                />
              )}
            </>
          )}

          {/* Primary Sidebar */}
          {sidebarOpen && (
            <>
              <PrimarySidebar
                workspaceKey={workspaceKey}
                job={job}
                onOpenFile={(p, line) => openFile(p, line)}
                onOpenSettings={() => setSettingsOpen(true)}
              />
              <ResizeSeparator
                orientation="vertical"
                label="Resize primary sidebar"
                value={sidebarWidth}
                min={180}
                max={520}
                onChange={setSidebarWidth}
              />
            </>
          )}

          {/* Center Editor + Bottom Dock */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-hidden">
              <EditorArea
                openTarget={openTarget}
                workspaceKey={workspaceKey}
                theme={theme}
                onOpenFolder={() => void openFolder()}
              />
            </div>

            {bottomPanelOpen && (
              <TerminalPanel
                fontSize={fontSize}
                height={bottomPanelHeight}
                onResize={setBottomPanelHeight}
                onClose={() => setBottomPanelOpen(false)}
                onOpenFile={(p, line) => openFile(p, line)}
              />
            )}
          </div>

          {/* Default Right Agent Dock */}
          {agentDockSide === "right" && (
            <>
              {agentPanelOpen && (
                <ResizeSeparator
                  orientation="vertical"
                  label="Resize agent panel"
                  value={agentPanelWidth}
                  min={300}
                  max={820}
                  invertDelta
                  onChange={setAgentPanelWidth}
                />
              )}
              {agentDockElement}
            </>
          )}
        </div>
      )}

      {previewPath && <PreviewPanel key={previewNonce} path={previewPath} onClose={closePreview} />}

      {settingsOpen && (
        <SettingsPanel
          settings={settings ?? undefined}
          onChange={onSettingsChange}
          onClose={() => setSettingsOpen(false)}
          onOpenModels={() => {
            setSettingsOpen(false);
            setModelsOpen(true);
          }}
        />
      )}

      {modelsOpen && <ModelsModal onClose={() => setModelsOpen(false)} />}

      <CommandPaletteModal
        commands={commands}
        onSelectFile={(filePath, line) => {
          setAppMode("editor");
          openFile(filePath, line);
        }}
      />

      <StatusBar
        snapshot={job.snapshot}
        defaultMode={defaultMode}
        inboxCount={inboxCount}
        onOpenModels={() => setModelsOpen(true)}
        onOpenInbox={() => setActiveActivity("inbox")}
      />
    </div>
  );
}
