import React, { useCallback, useEffect, useRef, useState } from "react";
import Editor, { DiffEditor, OnChange, OnMount } from "@monaco-editor/react";
import { ChevronRight, Command, FileCode2, FolderOpen, GitCompare, RotateCcw, Save, Search, X } from "lucide-react";
import { NovaLogoMark } from "../branding/NovaBrand";
import { Kbd } from "../design-system/primitives";
import { useLayoutStore } from "../stores/layoutStore";
import { usePaletteStore } from "../stores/paletteStore";
import type { OpenFileTarget } from "../stores/workspaceStore";

// Tabbed Monaco Code Editor with persisted open tabs, line-jump navigation,
// breadcrumb path bar, and Nova IDE keyboard-first empty state.

interface Tab {
  path: string;
  label: string;
  saved: boolean;
  content: string;
  diffMode?: boolean;
  originalContent?: string;
  diffRunId?: string;
}

interface Props {
  openTarget: OpenFileTarget | null;
  workspaceKey: number;
  theme: "light" | "dark";
  onOpenFolder?: () => void;
}

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".md": "markdown",
  ".svg": "xml",
  ".xml": "xml",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".py": "python",
  ".sh": "shell",
  ".bat": "shell",
  ".ps1": "powershell",
  ".txt": "text",
};

export function EditorArea({ openTarget, workspaceKey, theme, onOpenFolder }: Props) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restoredOnceRef = useRef(false);
  const pendingLineRef = useRef<number | undefined>(undefined);
  const editorInstanceRef = useRef<Parameters<OnMount>[0] | null>(null);

  const { hydrated, openTabs, activeTab, syncEditorTabs, setAppMode } = useLayoutStore();
  const { openCommands, openQuickOpen } = usePaletteStore();

  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;

  // Restore persisted tabs from layout.json once on startup
  useEffect(() => {
    if (!hydrated || restoredOnceRef.current) return;
    restoredOnceRef.current = true;
    if (!openTabs || openTabs.length === 0) return;

    let alive = true;
    void (async () => {
      const loaded: Tab[] = [];
      for (const rel of openTabs.slice(0, 15)) {
        try {
          const content = await window.electron.fs.readFile(rel);
          loaded.push({ path: rel, label: baseName(rel), saved: true, content });
        } catch {
          /* skip deleted or moved files */
        }
      }
      if (!alive || loaded.length === 0) return;
      setTabs((prev) => (prev.length > 0 ? prev : loaded));
      setActivePath((cur) => {
        if (cur) return cur;
        if (activeTab && loaded.some((t) => t.path === activeTab)) return activeTab;
        return loaded[0].path;
      });
    })();

    return () => {
      alive = false;
    };
  }, [activeTab, hydrated, openTabs]);

  // Persist tab paths whenever tabs or activePath change
  useEffect(() => {
    if (!restoredOnceRef.current) return;
    syncEditorTabs(
      tabs.map((t) => t.path),
      activePath,
    );
  }, [activePath, syncEditorTabs, tabs]);

  // Refresh saved open tabs when workspace files change on disk
  useEffect(() => {
    if (workspaceKey === 0) return;
    let alive = true;
    void (async () => {
      const next: Tab[] = [];
      for (const t of tabsRef.current) {
        if (!t.saved) {
          next.push(t);
          continue;
        }
        try {
          const diskContent = await window.electron.fs.readFile(t.path);
          next.push({ ...t, content: diskContent, saved: true });
        } catch {
          /* file no longer in new/changed workspace */
        }
      }
      if (!alive) return;
      setTabs(next);
      setActivePath((cur) => (cur && next.some((t) => t.path === cur) ? cur : next[0]?.path ?? null));
    })();
    return () => {
      alive = false;
    };
  }, [workspaceKey]);

  const jumpToLine = useCallback((line?: number) => {
    if (!line || !editorInstanceRef.current) return;
    editorInstanceRef.current.revealLineInCenter(line);
    editorInstanceRef.current.setPosition({ lineNumber: line, column: 1 });
    editorInstanceRef.current.focus();
  }, []);

  useEffect(() => {
    if (!openTarget) return;
    const target = openTarget.path;
    const line = openTarget.line;
    let alive = true;

    const run = async () => {
      if (openTarget.diff) {
        const { runId, original, modified } = openTarget.diff;
        setTabs((prev) => {
          const filtered = prev.filter((t) => t.path !== target);
          return [
            ...filtered,
            {
              path: target,
              label: `${baseName(target)} (Diff)`,
              saved: true,
              content: modified,
              diffMode: true,
              originalContent: original,
              diffRunId: runId,
            },
          ];
        });
        setActivePath(target);
        return;
      }

      if (tabsRef.current.some((t) => t.path === target)) {
        pendingLineRef.current = line;
        setActivePath(target);
        requestAnimationFrame(() => jumpToLine(line));
        return;
      }
      try {
        const content = await window.electron.fs.readFile(target);
        if (!alive) return;
        pendingLineRef.current = line;
        setTabs((prev) =>
          prev.some((t) => t.path === target)
            ? prev
            : [...prev, { path: target, label: baseName(target), saved: true, content }],
        );
        setActivePath(target);
        setError(null);
        setTimeout(() => jumpToLine(line), 40);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };

    void run();
    return () => {
      alive = false;
    };
  }, [jumpToLine, openTarget]);

  const save = useCallback(async (path: string) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || tab.saved) return;
    try {
      await window.electron.fs.writeFile(path, tab.content);
      setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, saved: true } : t)));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const closeTab = useCallback((path: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== path);
      setActivePath((current) => {
        if (current !== path) return current;
        return next.length ? next[next.length - 1].path : null;
      });
      return next;
    });
  }, []);

  const onChange: OnChange = (value) => {
    const path = activePath;
    if (!path) return;
    setTabs((prev) =>
      prev.map((t) => (t.path === path ? { ...t, content: value ?? "", saved: false } : t)),
    );
  };

  const onEditorMount: OnMount = (editor) => {
    editorInstanceRef.current = editor;
    if (pendingLineRef.current) {
      jumpToLine(pendingLineRef.current);
      pendingLineRef.current = undefined;
    }
  };

  const active = tabs.find((t) => t.path === activePath) ?? null;
  const lang = active ? EXT_TO_LANG[extOf(active.path)] ?? "plaintext" : "plaintext";

  // Cmd/Ctrl+S saves active file; Cmd/Ctrl+W closes active tab
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activePath) void save(activePath);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activePath, save]);

  const breadcrumbs = active ? active.path.split("/") : [];

  return (
    <main
      role="main"
      aria-label="Code Editor"
      className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--nova-bg-editor)]"
    >
      {tabs.length > 0 && (
        <>
          <div
            role="tablist"
            aria-label="Open files"
            className="flex h-9 flex-none items-center overflow-x-auto border-b border-[var(--nova-border)] bg-[var(--nova-bg-panel)] px-1.5"
          >
            {tabs.map((t) => {
              const isActive = t.path === activePath;
              return (
                <div
                  key={t.path}
                  role="tab"
                  aria-selected={isActive}
                  className={`group flex h-full items-center gap-1.5 border-b-2 px-2.5 text-xs transition-colors ${
                    isActive
                      ? "border-[var(--nova-accent-bright)] bg-[var(--nova-bg-editor)] text-[var(--nova-text-primary)]"
                      : "border-transparent text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
                  }`}
                >
                  <FileCode2 size={13} className="shrink-0 text-[var(--nova-accent-bright)] opacity-80" />
                  <button
                    type="button"
                    onClick={() => setActivePath(t.path)}
                    className="max-w-[160px] truncate py-1 font-medium"
                    title={t.path}
                  >
                    {t.label}
                  </button>
                  {!t.saved && (
                    <span className="h-2 w-2 rounded-full bg-[var(--nova-warning)]" title="Unsaved changes" />
                  )}
                  <button
                    type="button"
                    onClick={() => closeTab(t.path)}
                    aria-label={`Close ${t.label}`}
                    className="ml-0.5 rounded p-0.5 text-[var(--nova-text-muted)] opacity-0 hover:bg-[var(--nova-bg-active)] hover:text-[var(--nova-danger)] group-hover:opacity-100 focus:opacity-100"
                    title="Close tab"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Breadcrumb + Save bar */}
          <div className="flex h-7 flex-none items-center gap-1 border-b border-[var(--nova-border-subtle)] bg-[var(--nova-bg-editor)] px-3 text-[11px] text-[var(--nova-text-muted)]">
            <div className="flex min-w-0 items-center gap-1 truncate">
              {breadcrumbs.map((seg, idx) => (
                <React.Fragment key={`${seg}-${idx}`}>
                  {idx > 0 && <ChevronRight size={11} className="shrink-0 opacity-50" />}
                  <span
                    className={
                      idx === breadcrumbs.length - 1
                        ? "truncate font-medium text-[var(--nova-text-secondary)]"
                        : "truncate"
                    }
                  >
                    {seg}
                  </span>
                </React.Fragment>
              ))}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {active?.diffMode && active?.diffRunId && (
                <button
                  type="button"
                  onClick={async () => {
                    if (!active?.diffRunId) return;
                    await window.electron.checkpoints.revertFile(active.diffRunId, active.path);
                    closeTab(active.path);
                  }}
                  className="flex items-center gap-1 rounded border border-[var(--nova-danger)]/50 bg-[var(--nova-danger-soft)] px-2 py-0.5 text-[10.5px] text-[var(--nova-danger)] hover:opacity-90"
                >
                  <RotateCcw size={11} />
                  <span>Revert File</span>
                </button>
              )}
              <span className="font-mono text-[10.5px] uppercase opacity-75">{lang}</span>
              <button
                type="button"
                onClick={() => active && void save(active.path)}
                disabled={!active || active.saved || Boolean(active.diffMode)}
                className="flex items-center gap-1 rounded border border-[var(--nova-border)] bg-[var(--nova-bg-panel)] px-2 py-0.5 text-[10.5px] text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)] disabled:opacity-35"
              >
                <Save size={11} />
                <span>Save</span>
              </button>
            </div>
          </div>
        </>
      )}

      <div className="min-h-0 flex-1 overflow-hidden bg-[var(--nova-bg-editor)]">
        {active ? (
          active.diffMode ? (
            <DiffEditor
              height="100%"
              language={lang}
              original={active.originalContent ?? ""}
              modified={active.content}
              theme={theme === "dark" ? "vs-dark" : "vs"}
              options={{
                readOnly: true,
                renderSideBySide: true,
                minimap: { enabled: false },
                automaticLayout: true,
                fontFamily: "var(--nova-font-mono)",
                fontSize: 13,
              }}
            />
          ) : (
            <Editor
              height="100%"
              language={lang}
              path={active.path}
              value={active.content}
              onChange={onChange}
              onMount={onEditorMount}
              theme={theme === "dark" ? "vs-dark" : "vs"}
              options={{
                minimap: { enabled: false },
                lineNumbers: "on",
                roundedSelection: true,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                fontFamily: "var(--nova-font-mono)",
                fontSize: 13.5,
                tabSize: 2,
                wordWrap: "off",
                padding: { top: 10 },
                renderWhitespace: "selection",
                smoothScrolling: true,
                cursorBlinking: "smooth",
              }}
            />
          )
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-[var(--nova-text-muted)]">
            <div className="w-full max-w-md space-y-5 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--nova-border)] bg-[var(--nova-bg-panel)] shadow-[var(--nova-shadow-sm)]">
                <NovaLogoMark size={26} />
              </div>
              <div>
                <h2 className="text-base font-semibold text-[var(--nova-text-primary)]">Nova IDE</h2>
                <p className="mt-1 text-xs text-[var(--nova-text-muted)]">
                  Agent-first development powered by smart free-tier &amp; local model routing.
                </p>
              </div>

              <div className="space-y-1.5 rounded-xl border border-[var(--nova-border)] bg-[var(--nova-bg-panel)] p-3 text-left text-xs">
                <ShortcutRow
                  icon={<Search size={13} />}
                  label="Quick Open File"
                  shortcut="Ctrl+P"
                  onClick={() => openQuickOpen()}
                />
                <ShortcutRow
                  icon={<Command size={13} />}
                  label="Command Palette"
                  shortcut="Ctrl+Shift+P"
                  onClick={() => openCommands()}
                />
                <ShortcutRow
                  icon={<FolderOpen size={13} />}
                  label="Open Workspace Folder"
                  shortcut="Ctrl+O"
                  onClick={() => onOpenFolder?.()}
                />
                <ShortcutRow
                  icon={<FileCode2 size={13} />}
                  label="Agent Manager (Mission Control)"
                  shortcut="Ctrl+Shift+M"
                  onClick={() => setAppMode("manager")}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="flex-none border-t border-[var(--nova-danger)]/40 bg-[var(--nova-danger-soft)] px-3 py-1.5 text-xs text-[var(--nova-danger)]">
          {error}
        </div>
      )}
    </main>
  );
}

function ShortcutRow({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
    >
      <span className="flex items-center gap-2">
        <span className="text-[var(--nova-accent-bright)]">{icon}</span>
        <span>{label}</span>
      </span>
      <Kbd>{shortcut}</Kbd>
    </button>
  );
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i).toLowerCase() : "";
}
