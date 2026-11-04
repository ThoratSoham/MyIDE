import React, { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { FsEntry } from "../../shared/electron-api-types";

// Explorer file tree: lazy directory expansion, file/folder creation, and safe
// move-to-trash deletion (.myide/trash), styled with Nova IDE design tokens & Lucide icons.

interface Props {
  workspaceKey: number;
  onOpenFile: (path: string) => void;
  embedded?: boolean;
}

export function Sidebar({ workspaceKey, onOpenFile, embedded = false }: Props) {
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
    <div
      className={
        embedded
          ? "flex h-full w-full flex-col overflow-hidden bg-[var(--nova-bg-panel)]"
          : "flex h-full w-60 flex-none flex-col border-r border-[var(--nova-border)] bg-[var(--nova-bg-panel)]"
      }
    >
      <div className="flex items-center justify-between border-b border-[var(--nova-border)] px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--nova-text-muted)]">
          Explorer
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => {
              setCreating("file");
              setName("");
            }}
            disabled={!canCreateHere}
            aria-label="New file"
            title="New file in selected folder"
            className="rounded p-1 text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)] disabled:opacity-30"
          >
            <FilePlus size={13} />
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating("dir");
              setName("");
            }}
            disabled={!canCreateHere}
            aria-label="New folder"
            title="New folder in selected folder"
            className="rounded p-1 text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)] disabled:opacity-30"
          >
            <FolderPlus size={13} />
          </button>
          <button
            type="button"
            onClick={() => void reload()}
            aria-label="Refresh explorer"
            title="Refresh"
            className="rounded p-1 text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-1.5 text-xs">
        {rootEntries.length === 0 && !error && (
          <div className="p-2.5 text-xs text-[var(--nova-text-muted)]">This folder is empty.</div>
        )}
        <ul role="tree" aria-label="Workspace files" className="m-0 list-none space-y-0.5 p-0">
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
        <div className="border-t border-[var(--nova-border)] bg-[var(--nova-bg-surface)] p-2.5">
          <div className="mb-1 text-[10.5px] text-[var(--nova-text-muted)]">
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
            placeholder={creating === "file" ? "index.ts" : "components"}
            className="w-full rounded-md border border-[var(--nova-border)] bg-[var(--nova-bg-app)] px-2 py-1 text-xs text-[var(--nova-text-primary)] outline-none focus:border-[var(--nova-accent-bright)]"
          />
          <div className="mt-1.5 flex gap-1.5">
            <button
              type="button"
              onClick={() => void create()}
              disabled={!name.trim()}
              className="rounded-md bg-[var(--nova-accent)] px-2.5 py-0.5 text-xs font-medium text-white disabled:opacity-40"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => setCreating(null)}
              className="rounded-md border border-[var(--nova-border)] px-2 py-0.5 text-xs text-[var(--nova-text-secondary)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="border-t border-[var(--nova-danger)]/40 bg-[var(--nova-danger-soft)] px-2.5 py-1.5 text-[11px] text-[var(--nova-danger)]">
          {error}
        </div>
      )}
    </div>
  );
}

function fileIconFor(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".txt")) {
    return <FileText size={13} className="shrink-0 text-[var(--nova-text-muted)]" />;
  }
  return <FileCode2 size={13} className="shrink-0 text-[var(--nova-accent-bright)] opacity-85" />;
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
    <li role="treeitem" aria-expanded={entry.isDir ? isOpen : undefined} className="m-0">
      <div className="group flex items-center rounded-md hover:bg-[var(--nova-bg-hover)]">
        <button
          type="button"
          onClick={() => (entry.isDir ? onToggle(entry.path) : onOpen(entry.path))}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pr-1 text-left text-[12.5px] text-[var(--nova-text-primary)] outline-none"
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
          title={entry.path}
        >
          {entry.isDir ? (
            <>
              {isOpen ? (
                <ChevronDown size={12} className="shrink-0 text-[var(--nova-text-muted)]" />
              ) : (
                <ChevronRight size={12} className="shrink-0 text-[var(--nova-text-muted)]" />
              )}
              {isOpen ? (
                <FolderOpen size={13} className="shrink-0 text-[var(--nova-warning)] opacity-90" />
              ) : (
                <Folder size={13} className="shrink-0 text-[var(--nova-warning)] opacity-80" />
              )}
            </>
          ) : (
            <>
              <span className="w-3 shrink-0" />
              {fileIconFor(entry.name)}
            </>
          )}
          <span className="truncate">{entry.name}</span>
        </button>
        <button
          type="button"
          onClick={() => onDelete(entry.path)}
          aria-label={`Move ${entry.name} to trash`}
          className="mr-1 rounded p-1 text-[var(--nova-text-muted)] opacity-0 hover:text-[var(--nova-danger)] group-hover:opacity-100 focus:opacity-100"
          title="Move to trash"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {entry.isDir && isOpen && (
        <ul role="group" className="m-0 list-none space-y-0.5 p-0">
          {subs === undefined && (
            <li
              className="py-0.5 text-[11px] text-[var(--nova-text-muted)]"
              style={{ paddingLeft: `${(depth + 1) * 12 + 22}px` }}
            >
              loading…
            </li>
          )}
          {subs !== undefined && subs.length === 0 && (
            <li
              className="py-0.5 text-[11px] text-[var(--nova-text-muted)]"
              style={{ paddingLeft: `${(depth + 1) * 12 + 22}px` }}
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
