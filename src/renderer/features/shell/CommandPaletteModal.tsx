import React, { useEffect, useMemo, useRef, useState } from "react";
import { Command as CommandIcon, FileCode2, Search } from "lucide-react";
import { Kbd } from "../../design-system/primitives";
import { type CommandItem, fuzzyScore, usePaletteStore } from "../../stores/paletteStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";

interface Props {
  commands: CommandItem[];
  onSelectFile: (filePath: string, line?: number) => void;
}

function HighlightedText({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const posSet = new Set(positions);
  return (
    <>
      {Array.from(text).map((ch, idx) =>
        posSet.has(idx) ? (
          <mark
            key={idx}
            className="bg-transparent font-semibold text-[var(--nova-accent-bright)] underline decoration-[var(--nova-accent-bright)]/50"
          >
            {ch}
          </mark>
        ) : (
          <React.Fragment key={idx}>{ch}</React.Fragment>
        ),
      )}
    </>
  );
}

export function CommandPaletteModal({ commands, onSelectFile }: Props) {
  const { mode, initialQuery, close } = usePaletteStore();
  const { files, refreshFiles } = useWorkspaceStore();

  const [rawInput, setRawInput] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mode) return;
    const prefix = mode === "commands" ? `>${initialQuery}` : initialQuery;
    setRawInput(prefix);
    setSelectedIndex(0);
    if (mode === "files") {
      void refreshFiles();
    }
    requestAnimationFrame(() => inputRef.current?.focus());

    const onWinKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onWinKey);
    return () => window.removeEventListener("keydown", onWinKey);
  }, [close, initialQuery, mode, refreshFiles]);

  const isCommandMode = mode === "commands" || rawInput.startsWith(">");
  const cleanQuery = rawInput.startsWith(">") ? rawInput.slice(1).trimStart() : rawInput;

  // Support `path/to/file.ts:42` line jump in Quick Open
  const [fileQueryPart, linePart] = useMemo(() => {
    if (isCommandMode) return [cleanQuery, undefined] as const;
    const colon = cleanQuery.lastIndexOf(":");
    if (colon > 0) {
      const maybeLine = Number(cleanQuery.slice(colon + 1));
      if (Number.isFinite(maybeLine) && maybeLine > 0) {
        return [cleanQuery.slice(0, colon), Math.floor(maybeLine)] as const;
      }
    }
    return [cleanQuery, undefined] as const;
  }, [cleanQuery, isCommandMode]);

  const commandResults = useMemo(() => {
    if (!isCommandMode) return [];
    const scored: Array<{ cmd: CommandItem; score: number; positions: number[] }> = [];
    for (const cmd of commands) {
      const target = `${cmd.category}: ${cmd.label}`;
      const m = fuzzyScore(cleanQuery, target) ?? (cmd.keywords ? fuzzyScore(cleanQuery, cmd.keywords) : null);
      if (m) {
        const labelMatch = fuzzyScore(cleanQuery, cmd.label);
        scored.push({
          cmd,
          score: m.score + (labelMatch ? 10 : 0),
          positions: labelMatch?.positions ?? [],
        });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 60);
  }, [cleanQuery, commands, isCommandMode]);

  const fileResults = useMemo(() => {
    if (isCommandMode) return [];
    const scored: Array<{ path: string; score: number; positions: number[] }> = [];
    for (const f of files) {
      const m = fuzzyScore(fileQueryPart, f);
      if (m) scored.push({ path: f, score: m.score, positions: m.positions });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 80);
  }, [fileQueryPart, files, isCommandMode]);

  const totalCount = isCommandMode ? commandResults.length : fileResults.length;

  useEffect(() => {
    setSelectedIndex(0);
  }, [cleanQuery, isCommandMode]);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const activeEl = container.querySelector(`[data-palette-idx="${selectedIndex}"]`) as HTMLElement | null;
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!mode) return null;

  const executeIndex = (idx: number) => {
    if (isCommandMode) {
      const entry = commandResults[idx];
      if (!entry) return;
      close();
      entry.cmd.run();
    } else {
      const entry = fileResults[idx];
      if (!entry) return;
      close();
      onSelectFile(entry.path, linePart);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isCommandMode ? "Command Palette" : "Quick Open File"}
      data-command-palette={isCommandMode ? "commands" : "files"}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--nova-bg-overlay)] pt-[10vh] backdrop-blur-[2px]"
    >
      <div className="nova-overlay-enter flex max-h-[68vh] w-[620px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-[var(--nova-border-strong)] bg-[var(--nova-bg-panel)] shadow-[var(--nova-shadow-lg)]">
        {/* Input bar */}
        <div className="flex items-center gap-2.5 border-b border-[var(--nova-border)] bg-[var(--nova-bg-surface)] px-3.5 py-2.5">
          {isCommandMode ? (
            <CommandIcon size={15} className="shrink-0 text-[var(--nova-accent-bright)]" />
          ) : (
            <Search size={15} className="shrink-0 text-[var(--nova-accent-bright)]" />
          )}
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="nova-palette-listbox"
            aria-activedescendant={totalCount > 0 ? `nova-palette-opt-${selectedIndex}` : undefined}
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                if (totalCount > 0) setSelectedIndex((i) => (i + 1) % totalCount);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (totalCount > 0) setSelectedIndex((i) => (i - 1 + totalCount) % totalCount);
              } else if (e.key === "Home") {
                e.preventDefault();
                setSelectedIndex(0);
              } else if (e.key === "End") {
                e.preventDefault();
                if (totalCount > 0) setSelectedIndex(totalCount - 1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                executeIndex(selectedIndex);
              }
            }}
            placeholder={
              isCommandMode
                ? "Type a command to run…"
                : "Type a file name to open (tip: type '>' for commands, or ':line' to jump)…"
            }
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--nova-text-primary)] placeholder-[var(--nova-text-muted)] outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>

        {/* Results list */}
        <div
          id="nova-palette-listbox"
          ref={listRef}
          role="listbox"
          className="min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          {totalCount === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-[var(--nova-text-muted)]">
              {isCommandMode ? "No matching commands." : "No matching files in current workspace."}
            </div>
          ) : isCommandMode ? (
            commandResults.map(({ cmd, positions }, idx) => {
              const active = idx === selectedIndex;
              return (
                <div
                  key={cmd.id}
                  id={`nova-palette-opt-${idx}`}
                  data-palette-idx={idx}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => executeIndex(idx)}
                  className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs ${
                    active
                      ? "bg-[var(--nova-accent-soft)] text-[var(--nova-text-primary)]"
                      : "text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)]"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="rounded bg-[var(--nova-bg-elevated)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--nova-text-muted)]">
                      {cmd.category}
                    </span>
                    <span className="truncate font-medium">
                      <HighlightedText text={cmd.label} positions={positions} />
                    </span>
                  </div>
                  {cmd.shortcut && <Kbd>{cmd.shortcut}</Kbd>}
                </div>
              );
            })
          ) : (
            fileResults.map(({ path: filePath, positions }, idx) => {
              const active = idx === selectedIndex;
              const slash = filePath.lastIndexOf("/");
              const fileName = slash >= 0 ? filePath.slice(slash + 1) : filePath;
              const dirName = slash >= 0 ? filePath.slice(0, slash) : "";
              return (
                <div
                  key={filePath}
                  id={`nova-palette-opt-${idx}`}
                  data-palette-idx={idx}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => executeIndex(idx)}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-xs ${
                    active
                      ? "bg-[var(--nova-accent-soft)] text-[var(--nova-text-primary)]"
                      : "text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)]"
                  }`}
                >
                  <FileCode2 size={14} className="shrink-0 text-[var(--nova-accent-bright)]" />
                  <span className="font-medium text-[var(--nova-text-primary)]">{fileName}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--nova-text-muted)]">
                    <HighlightedText text={filePath} positions={positions} />
                  </span>
                  {dirName && (
                    <span className="shrink-0 text-[10px] text-[var(--nova-text-faint)]">{dirName}</span>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer hints */}
        <div className="flex items-center justify-between border-t border-[var(--nova-border-subtle)] bg-[var(--nova-bg-surface)] px-3 py-1.5 text-[10.5px] text-[var(--nova-text-muted)]">
          <div className="flex items-center gap-3">
            <span>
              <Kbd>↑↓</Kbd> navigate
            </span>
            <span>
              <Kbd>Enter</Kbd> select
            </span>
            <span>
              <Kbd>&gt;</Kbd> commands
            </span>
          </div>
          <span>
            {isCommandMode ? `${commandResults.length} commands` : `${fileResults.length} workspace files`}
          </span>
        </div>
      </div>
    </div>
  );
}
