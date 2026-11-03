import React, { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { EditorArea } from "./components/EditorArea";
import { StatusBar } from "./components/StatusBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { QuotaPanel } from "./components/QuotaPanel";
import { ChatPanel } from "./components/ChatPanel";
import { PipelinePanel } from "./components/PipelinePanel";
import { PreviewPanel } from "./components/PreviewPanel";
import { useJob } from "./hooks/useJob";
import type { Settings } from "../shared/electron-api-types";

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quotaOpen, setQuotaOpen] = useState(true);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [root, setRoot] = useState("");

  // FR-1.3 / FR-12.2: one place owns "the file the user clicked" and "the
  // workspace changed", so the explorer and the editor stay in step.
  const [openTarget, setOpenTarget] = useState<{ path: string; nonce: number } | null>(null);
  const [workspaceKey, setWorkspaceKey] = useState(0);

  const openPreview = useCallback((filePath: string) => setPreviewPath(filePath), []);
  const job = useJob({ onPreview: openPreview });

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

  useEffect(() => {
    window.electron.settings.get().then((s) => {
      setSettings(s);
      applyTheme(s.theme);
    });
    window.electron.workspace.root().then(setRoot).catch(() => undefined);
  }, [applyTheme]);

  const onSettingsChange = useCallback(
    (partial: Partial<Settings>) => {
      window.electron.settings.set(partial).then((s) => {
        setSettings(s);
        applyTheme(s.theme);
      });
    },
    [applyTheme],
  );

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (settings?.theme === "system") applyTheme("system");
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [settings?.theme, applyTheme]);

  // FR-1.1: open a folder as the workspace. Everything else follows from here.
  const openFolder = useCallback(async () => {
    const picked = await window.electron.workspace.openFolder();
    if (!picked) return;
    setRoot(picked);
    setOpenTarget(null);
    setPreviewPath(null);
    setWorkspaceKey((k) => k + 1);
  }, []);

  const openFile = useCallback((path: string) => {
    setOpenTarget({ path, nonce: Date.now() });
  }, []);

  const closePreview = useCallback(() => {
    void window.electron.preview.close();
    setPreviewPath(null);
  }, []);

  const stages = job.snapshot?.stages ?? [];
  const defaultMode = settings?.defaultMode ?? "balanced";

  return (
    <div className="flex h-full flex-col" data-theme={theme}>
      <header className="flex h-10 flex-none items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm">
        <span className="font-medium text-[var(--color-text)]">MyIDE</span>
        <span
          className="truncate text-xs text-[var(--color-muted)]"
          title={root}
        >
          {root || "no folder open"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void openFolder()}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
          >
            Open folder…
          </button>
          <button
            onClick={() => setQuotaOpen((o) => !o)}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
          >
            {quotaOpen ? "Hide quota" : "Quota"}
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
          >
            Settings
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar workspaceKey={workspaceKey} onOpenFile={openFile} />

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <EditorArea openTarget={openTarget} workspaceKey={workspaceKey} />
        </div>

        {/* FR-12.1 chat + FR-12.2 pipeline view */}
        <div className="flex w-[420px] flex-none flex-col overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="min-h-0 flex-1 overflow-hidden">
            <ChatPanel job={job} defaultMode={defaultMode} />
          </div>
          <div className="h-56 flex-none border-t border-[var(--color-border)] bg-[var(--color-base)]">
            <div className="border-b border-[var(--color-border)] px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
              Pipeline
            </div>
            <div className="h-[calc(100%-29px)]">
              <PipelinePanel stages={stages} />
            </div>
          </div>
        </div>

        {/* FR-12.3 quota panel — always available, defaults to visible */}
        {quotaOpen && <QuotaPanel />}
      </div>

      {previewPath && <PreviewPanel path={previewPath} onClose={closePreview} />}

      {settingsOpen && (
        <SettingsPanel
          settings={settings ?? undefined}
          onChange={onSettingsChange}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <StatusBar snapshot={job.snapshot} defaultMode={defaultMode} />
    </div>
  );
}
