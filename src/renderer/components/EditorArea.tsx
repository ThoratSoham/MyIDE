import React, { useCallback, useEffect, useRef, useState } from "react";
import Editor, { OnChange } from "@monaco-editor/react";

// FR-1.3: one Monaco model per open file, tabs across the top. Files are read
// and written through the typed IPC bridge, so everything stays inside the
// workspace and overwrites are backed up in the main process (FR-13.3).

interface Tab {
  path: string;
  label: string;
  saved: boolean;
  content: string;
}

interface Props {
  openTarget: { path: string; nonce: number } | null;
  workspaceKey: number;
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

export function EditorArea({ openTarget, workspaceKey }: Props) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;

  // A new workspace means the old tabs no longer exist.
  useEffect(() => {
    if (workspaceKey === 0) return;
    setTabs([]);
    setActivePath(null);
    setError(null);
  }, [workspaceKey]);

  useEffect(() => {
    if (!openTarget) return;
    const target = openTarget.path;
    let alive = true;

    const run = async () => {
      if (tabsRef.current.some((t) => t.path === target)) {
        setActivePath(target);
        return;
      }
      try {
        const content = await window.electron.fs.readFile(target);
        if (!alive) return;
        setTabs((prev) =>
          prev.some((t) => t.path === target)
            ? prev
            : [...prev, { path: target, label: baseName(target), saved: true, content }],
        );
        setActivePath(target);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };

    void run();
    return () => {
      alive = false;
    };
  }, [openTarget]);

  const save = useCallback(
    async (path: string) => {
      const tab = tabsRef.current.find((t) => t.path === path);
      if (!tab || tab.saved) return;
      try {
        await window.electron.fs.writeFile(path, tab.content);
        setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, saved: true } : t)));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

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

  const active = tabs.find((t) => t.path === activePath) ?? null;
  const lang = active ? EXT_TO_LANG[extOf(active.path)] ?? "plaintext" : "plaintext";

  // FR-1.3: Cmd/Ctrl+S saves the active file.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activePath) void save(activePath);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activePath, save]);

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      {tabs.length > 0 && (
        <div className="flex flex-none items-center overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2">
          {tabs.map((t) => (
            <div
              key={t.path}
              className={`group flex items-center gap-2 border-b-2 px-3 py-1.5 text-sm transition-colors
                ${
                  t.path === activePath
                    ? "border-[var(--color-accent-strong)] text-[var(--color-text)]"
                    : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]"
                }`}
            >
              <button
                onClick={() => setActivePath(t.path)}
                className="max-w-[160px] truncate"
                title={t.path}
              >
                {t.label}
              </button>
              {!t.saved && <span className="text-[10px] text-[var(--color-warn)]">●</span>}
              <button
                onClick={() => closeTab(t.path)}
                className="ml-1 rounded text-xs text-[var(--color-muted)] opacity-0 transition-opacity hover:text-[var(--color-negative)] group-hover:opacity-100"
                title="Close"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden bg-[var(--color-editor-bg)]">
        {active ? (
          <Editor
            height="100%"
            language={lang}
            path={active.path}
            value={active.content}
            onChange={onChange}
            theme={themeFor(dataTheme())}
            options={{
              minimap: { enabled: false },
              lineNumbers: "on",
              roundedSelection: true,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              fontFamily: "ui-monospace, Menlo, Consolas, monospace",
              fontSize: 14,
              tabSize: 2,
              wordWrap: "off",
              padding: { top: 8 },
              renderWhitespace: "selection",
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[var(--color-muted)]">
            <div className="text-center">
              <div className="mb-2 text-4xl opacity-20">⌨</div>
              <div className="text-sm">Open a file from the explorer to start editing</div>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="flex-none border-t border-[var(--color-negative)] bg-[var(--color-negative)]/10 px-3 py-1 text-xs text-[var(--color-negative)]">
          {error}
        </div>
      )}

      {active && (
        <div className="flex flex-none items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-muted)]">
          <button
            onClick={() => void save(active.path)}
            disabled={active.saved}
            className="rounded border border-[var(--color-border)] px-2 py-0.5 hover:bg-[var(--color-surface-alt)] disabled:opacity-40"
          >
            Save
          </button>
          <span className="capitalize">{lang}</span>
          <span className="ml-auto truncate">{active.path}</span>
        </div>
      )}
    </div>
  );
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i).toLowerCase() : "";
}

function dataTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function themeFor(t: "light" | "dark") {
  return t === "dark" ? "vs-dark" : "vs";
}
