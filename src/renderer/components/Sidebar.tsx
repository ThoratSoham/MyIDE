import React, { useCallback, useEffect, useState } from "react";
import type { FsEntry } from "../../shared/electron-api-types";

// FR-1.1 / FR-1.2: the explorer lists the real workspace, expands folders
// lazily, opens files in the editor, and can create a file or folder in the
// selected directory. Deletes go to .myide/trash in the main process
// (FR-13.3), never to nothing.

interface Props {
  workspaceKey: number;
  onOpenFile: (path: string) => void;
}

export function Sidebar({ workspaceKey, onOpenFile }: Props) {
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedDir, setSelectedDir] = useState("");
  const [creating, setCreating] = useState<"file" | "dir" | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (dir: string) => {
    try {
      const entries = await window.electron.fs.listDir(dir);
      setChildren((prev) => ({ ...prev, [dir]: entries }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const reload = useCallback(async () => {
    setChildren({});
    setExpanded(new Set());
    setSelectedDir("");
    setCreating(null);
    setName("");
    await load("");
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload, workspaceKey]);

  const toggle = useCallback(
    async (dir: string) => {
      setSelectedDir(dir);
      if (expanded.has(dir)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(dir);
          return next;
        });
        return;
      }
      if (!children[dir]) await load(dir);
      setExpanded((prev) => new Set(prev).add(dir));
    },
    [children, expanded, load],
  );

  const create = useCallback(async () => {
    const nm = name.trim().replace(/^[/\\]+/, "");
    if (!nm || !creating) return;
    const rel = selectedDir ? `${selectedDir}/${nm}` : nm;
    try {
      if (creating === "file") await window.electron.fs.createFile(rel);
      else await window.electron.fs.createDir(rel);
      setCreating(null);
      setName("");
      await load(selectedDir);
      if (creating === "file") onOpenFile(rel);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [creating, load, name, onOpenFile, selectedDir]);

  const remove = useCallback(
    async (target: string) => {
      try {
        await window.electron.fs.deleteToTrash(target);
        const parent = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
        await load(parent);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [load],
  );

  const rootEntries = children[""] ?? [];
  const canCreateHere = selectedDir === "" || expanded.has(selectedDir) || !!children[selectedDir];

  return (
    <aside className="flex h-full w-60 flex-none flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">Explorer</span>
        <div className="flex gap-1">
          <button
            onClick={() => {
              setCreating("file");
              setName("");
            }}
            disabled={!canCreateHere}
            className="rounded px-1.5 py-0.5 text-xs text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)] disabled:opacity-30"
            title="New file in the selected folder"
          >
            +file
          </button>
          <button
            onClick={() => {
              setCreating("dir");
              setName("");
            }}
            disabled={!canCreateHere}
            className="rounded px-1.5 py-0.5 text-xs text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)] disabled:opacity-30"
            title="New folder in the selected folder"
          >
            +dir
          </button>
          <button
            onClick={() => void reload()}
            className="rounded px-1.5 py-0.5 text-xs text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)]"
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-2 text-sm">
        {rootEntries.length === 0 && !error && (
          <div className="p-2 text-xs text-[var(--color-muted)]">This folder is empty.</div>
        )}
        <ul className="m-0 list-none p-0">
          {sorted(rootEntries).map((entry) => (
            <Node
              key={entry.path}
              entry={entry}
              depth={0}
              children={children}
              expanded={expanded}
              onToggle={(dir) => void toggle(dir)}
              onOpen={onOpenFile}
              onDelete={(p) => void remove(p)}
            />
          ))}
        </ul>
      </div>

      {creating && (
        <div className="border-t border-[var(--color-border)] p-2">
          <div className="mb-1 text-[10px] text-[var(--color-muted)]">
            New {creating === "file" ? "file" : "folder"} in {selectedDir || "workspace root"}
          </div>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
              if (e.key === "Escape") setCreating(null);
            }}
            placeholder={creating === "file" ? "name.html" : "folder-name"}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1 text-xs text-[var(--color-text)] outline-none"
          />
          <div className="mt-1 flex gap-1">
            <button
              onClick={() => void create()}
              disabled={!name.trim()}
              className="rounded bg-[var(--color-accent)] px-2 py-0.5 text-xs text-white disabled:opacity-40"
            >
              Create
            </button>
            <button
              onClick={() => setCreating(null)}
              className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="border-t border-[var(--color-negative)] bg-[var(--color-negative)]/10 px-2 py-1 text-[10px] text-[var(--color-negative)]">
          {error}
        </div>
      )}
    </aside>
  );
}

function Node({
  entry,
  depth,
  children,
  expanded,
  onToggle,
  onOpen,
  onDelete,
}: {
  entry: FsEntry;
  depth: number;
  children: Record<string, FsEntry[]>;
  expanded: Set<string>;
  onToggle: (dir: string) => void;
  onOpen: (path: string) => void;
  onDelete: (path: string) => void;
}) {
  const isOpen = expanded.has(entry.path);
  const subs = children[entry.path];

  return (
    <li className="m-0">
      <div className="group flex items-center">
        <button
          onClick={() => (entry.isDir ? onToggle(entry.path) : onOpen(entry.path))}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-sm text-[var(--color-text)] outline-none hover:bg-[var(--color-surface-alt)]"
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
          title={entry.path}
        >
          <span className="w-3 shrink-0 text-center text-[10px] leading-none opacity-70">
            {entry.isDir ? (isOpen ? "▾" : "▸") : "•"}
          </span>
          <span className="truncate">{entry.name}</span>
        </button>
        <button
          onClick={() => onDelete(entry.path)}
          className="mr-1 rounded px-1 text-xs text-[var(--color-muted)] opacity-0 hover:text-[var(--color-negative)] group-hover:opacity-100"
          title="Move to trash"
        >
          ×
        </button>
      </div>

      {entry.isDir && isOpen && (
        <ul className="m-0 list-none p-0">
          {subs === undefined && (
            <li
              className="py-0.5 text-xs text-[var(--color-muted)]"
              style={{ paddingLeft: `${(depth + 1) * 12 + 6}px` }}
            >
              loading…
            </li>
          )}
          {subs !== undefined && subs.length === 0 && (
            <li
              className="py-0.5 text-xs text-[var(--color-muted)]"
              style={{ paddingLeft: `${(depth + 1) * 12 + 6}px` }}
            >
              empty
            </li>
          )}
          {subs !== undefined &&
            sorted(subs).map((child) => (
              <Node
                key={child.path}
                entry={child}
                depth={depth + 1}
                children={children}
                expanded={expanded}
                onToggle={onToggle}
                onOpen={onOpen}
                onDelete={onDelete}
              />
            ))}
        </ul>
      )}
    </li>
  );
}

function sorted(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
