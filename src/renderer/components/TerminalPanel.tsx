import React, { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Gauge,
  type LucideIcon,
  Plus,
  ScrollText,
  TerminalSquare,
  X,
} from "lucide-react";
import type { BottomTabId, TerminalInfo } from "../../shared/electron-api-types";
import { Badge, ResizeSeparator } from "../design-system/primitives";
import { useLayoutStore } from "../stores/layoutStore";
import { QuotaPanel } from "./QuotaPanel";

const MAX_TERMINALS = 8;

interface TerminalPanelProps {
  fontSize: number;
  height: number;
  onResize: (height: number) => void;
  onClose: () => void;
  onOpenFile?: (path: string, line?: number) => void;
}

const BOTTOM_TABS: Array<{
  id: BottomTabId;
  label: string;
  Icon: LucideIcon;
}> = [
  { id: "terminal", label: "Terminal", Icon: TerminalSquare },
  { id: "problems", label: "Problems", Icon: AlertTriangle },
  { id: "output", label: "Output", Icon: ScrollText },
  { id: "quota", label: "Free-Tier Quota", Icon: Gauge },
];

export function TerminalPanel({ fontSize, height, onResize, onClose, onOpenFile }: TerminalPanelProps) {
  const { bottomTab, openBottomTab } = useLayoutStore();
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [active, setActive] = useState<string>("agent");
  const [agentText, setAgentText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handlers = useRef(new Map<string, (data: string) => void>());

  useEffect(() => {
    void window.electron.terminal.list().then(setTerminals).catch(() => undefined);
    void window.electron.terminal.agentOutput().then(setAgentText).catch(() => undefined);
  }, []);

  useEffect(() => {
    const offData = window.electron.terminal.onData((e) => handlers.current.get(e.id)?.(e.data));
    const offAgent = window.electron.terminal.onAgentData((e) =>
      setAgentText((prev) => (prev + e.data).slice(-150_000)),
    );
    const offExit = window.electron.terminal.onExit((e) => {
      setTerminals((prev) => prev.filter((t) => t.id !== e.id));
      setActive((cur) => (cur === e.id ? "agent" : cur));
    });
    return () => {
      offData();
      offAgent();
      offExit();
    };
  }, []);

  const addTerminal = useCallback(async () => {
    if (terminals.length >= MAX_TERMINALS) {
      setError(`At most ${MAX_TERMINALS} terminals can be open. Close one first.`);
      return;
    }
    try {
      const info = await window.electron.terminal.create({});
      setTerminals((prev) => [...prev, info]);
      setActive(info.id);
      setError(null);
      if (info.warning) setError(info.warning);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [terminals.length]);

  const closeTerminal = useCallback(async (id: string) => {
    try {
      await window.electron.terminal.kill(id);
    } catch {
      /* already gone */
    }
    setTerminals((prev) => prev.filter((t) => t.id !== id));
    setActive((cur) => (cur === id ? "agent" : cur));
  }, []);

  return (
    <section
      aria-label="Bottom Panel"
      data-bottom-panel
      className="flex flex-none flex-col bg-[var(--nova-bg-app)]"
      style={{ height }}
    >
      <ResizeSeparator
        orientation="horizontal"
        label="Resize bottom panel"
        value={height}
        min={120}
        max={680}
        invertDelta
        onChange={onResize}
      />

      {/* Tab Strip */}
      <div
        role="tablist"
        aria-label="Bottom Panel Tabs"
        className="flex flex-none items-center gap-1 border-b border-[var(--nova-border)] bg-[var(--nova-bg-panel)] px-2.5 py-1 text-xs"
      >
        {BOTTOM_TABS.map(({ id, label, Icon }) => {
          const isSelected = bottomTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              data-bottom-tab={id}
              onClick={() => openBottomTab(id)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-medium ${
                isSelected
                  ? "bg-[var(--nova-bg-active)] text-[var(--nova-text-primary)]"
                  : "text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
              }`}
            >
              <Icon size={13} className={isSelected ? "text-[var(--nova-accent-bright)]" : ""} />
              <span>{label}</span>
            </button>
          );
        })}

        <div className="ml-auto flex items-center gap-1">
          {bottomTab === "terminal" && (
            <button
              type="button"
              onClick={() => void addTerminal()}
              title="New integrated shell"
              aria-label="New terminal"
              className="flex items-center gap-1 rounded-md border border-[var(--nova-border)] bg-[var(--nova-bg-surface)] px-2 py-0.5 text-[11px] text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
            >
              <Plus size={12} />
              <span>New Shell</span>
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Hide bottom panel (Ctrl+`)"
            aria-label="Hide bottom panel"
            className="rounded-md p-1 text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Terminal View */}
      {bottomTab === "terminal" && (
        <>
          <div className="flex flex-none items-center gap-1 overflow-x-auto border-b border-[var(--nova-border-subtle)] bg-[var(--nova-bg-surface)] px-2.5 py-1">
            {terminals.map((t) => (
              <span
                key={t.id}
                className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] ${
                  active === t.id
                    ? "bg-[var(--nova-accent-soft)] font-medium text-[var(--nova-accent-bright)]"
                    : "text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)]"
                }`}
              >
                <button type="button" onClick={() => setActive(t.id)} title={t.cwd}>
                  {t.title}
                </button>
                <button
                  type="button"
                  onClick={() => void closeTerminal(t.id)}
                  title="Close shell"
                  className="rounded p-0.5 hover:text-[var(--nova-danger)]"
                >
                  <X size={11} />
                </button>
              </span>
            ))}

            <button
              type="button"
              onClick={() => setActive("agent")}
              className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] ${
                active === "agent"
                  ? "bg-[var(--nova-accent-soft)] font-medium text-[var(--nova-accent-bright)]"
                  : "text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)]"
              }`}
              title="Output of commands executed by Nova Agent"
            >
              <Bot size={12} />
              <span>Agent Stream</span>
            </button>

            {terminals.length === 0 && (
              <span className="px-1.5 text-[11px] text-[var(--nova-text-muted)]">
                Click <strong>+ New Shell</strong> to launch an interactive PowerShell / bash session.
              </span>
            )}
          </div>

          {error && <div className="flex-none px-3 py-1 text-[11px] text-[var(--nova-warning)]">{error}</div>}

          <div className="relative min-h-0 flex-1">
            {terminals.map((t) => (
              <TerminalView
                key={t.id}
                id={t.id}
                fontSize={fontSize}
                active={active === t.id}
                register={(fn) => handlers.current.set(t.id, fn)}
                unregister={() => handlers.current.delete(t.id)}
              />
            ))}
            {active === "agent" && (
              <pre className="h-full overflow-auto whitespace-pre-wrap p-3 font-mono text-[11.5px] leading-relaxed text-[var(--nova-text-secondary)]">
                {agentText || "Commands executed by Nova Agent appear here in real time."}
              </pre>
            )}
          </div>
        </>
      )}

      {/* Problems View */}
      {bottomTab === "problems" && <ProblemsView onOpenFile={onOpenFile} />}

      {/* Output / Logs View */}
      {bottomTab === "output" && <LogsView />}

      {/* Quota View */}
      {bottomTab === "quota" && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <QuotaPanel embedded />
        </div>
      )}
    </section>
  );
}

interface MarkerEntry {
  file: string;
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
}

function ProblemsView({ onOpenFile }: { onOpenFile?: (path: string, line?: number) => void }) {
  const [markers, setMarkers] = useState<MarkerEntry[]>([]);

  useEffect(() => {
    const readMarkers = () => {
      const monacoGlobal = (window as unknown as { monaco?: { editor?: { getModelMarkers?: (f: object) => Array<{
        resource?: { path?: string };
        startLineNumber?: number;
        severity?: number;
        message?: string;
      }> } } }).monaco;
      const raw = monacoGlobal?.editor?.getModelMarkers?.({}) ?? [];
      const mapped: MarkerEntry[] = raw.map((m) => {
        const rawPath = (m.resource?.path ?? "").replace(/^\/+/, "");
        const sev: MarkerEntry["severity"] =
          (m.severity ?? 0) >= 8 ? "error" : (m.severity ?? 0) >= 4 ? "warning" : "info";
        return {
          file: rawPath || "editor",
          line: m.startLineNumber ?? 1,
          severity: sev,
          message: m.message ?? "",
        };
      });
      setMarkers(mapped);
    };
    readMarkers();
    const id = setInterval(readMarkers, 1500);
    return () => clearInterval(id);
  }, []);

  if (markers.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-xs text-[var(--nova-text-muted)]">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={15} className="text-[var(--nova-success)]" />
          <span>No diagnostics or syntax problems detected in open editor models.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2 text-xs">
      <ul className="space-y-1">
        {markers.map((m, idx) => (
          <li key={`${m.file}:${m.line}:${idx}`}>
            <button
              type="button"
              onClick={() => onOpenFile?.(m.file, m.line)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-[var(--nova-bg-hover)]"
            >
              <Badge tone={m.severity === "error" ? "danger" : m.severity === "warning" ? "warning" : "info" === m.severity ? "accent" : "neutral"}>
                {m.severity}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-[var(--nova-text-primary)]">{m.message}</span>
              <span className="shrink-0 font-mono text-[11px] text-[var(--nova-text-muted)]">
                {m.file}:{m.line}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TerminalView({
  id,
  fontSize,
  active,
  register,
  unregister,
}: {
  id: string;
  fontSize: number;
  active: boolean;
  register: (fn: (data: string) => void) => void;
  unregister: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const css = getComputedStyle(document.documentElement);
    const term = new Terminal({
      scrollback: 5000,
      convertEol: true,
      cursorBlink: true,
      fontSize,
      fontFamily: "var(--nova-font-mono), Consolas, monospace",
      theme: {
        background: css.getPropertyValue("--nova-bg-app").trim() || "#090b10",
        foreground: css.getPropertyValue("--nova-text-primary").trim() || "#edf0f7",
        cursor: css.getPropertyValue("--nova-accent-bright").trim() || "#6366f1",
        selectionBackground: css.getPropertyValue("--nova-bg-active").trim() || "#22293a",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* host may be zero-sized until shown */
    }
    termRef.current = term;
    fitRef.current = fit;

    const dataSub = term.onData((data) => void window.electron.terminal.write(id, data));
    register((data) => term.write(data));

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        void window.electron.terminal.resize(id, term.cols, term.rows);
      } catch {
        /* ignore */
      }
    });
    ro.observe(host);

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel);
        return false;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v") {
        void navigator.clipboard.readText().then((t) => void window.electron.terminal.write(id, t));
        return false;
      }
      return true;
    });

    void window.electron.terminal.resize(id, term.cols, term.rows);

    return () => {
      ro.disconnect();
      dataSub.dispose();
      unregister();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.fontSize = fontSize;
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
  }, [fontSize]);

  useEffect(() => {
    if (active) {
      try {
        fitRef.current?.fit();
        void window.electron.terminal.resize(id, termRef.current!.cols, termRef.current!.rows);
      } catch {
        /* ignore */
      }
      termRef.current?.focus();
    }
  }, [active, id]);

  return (
    <div
      ref={hostRef}
      style={{ display: active ? "block" : "none" }}
      className="absolute inset-0 overflow-hidden bg-[var(--nova-bg-app)] p-1.5"
    />
  );
}

function LogsView() {
  const [lines, setLines] = useState<string[]>([]);
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    void window.electron.logs.lines().then(setLines).catch(() => undefined);
    const off = window.electron.logs.onLine((line) => setLines((prev) => [...prev.slice(-3000), line]));
    return off;
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <pre
      ref={ref}
      data-logs
      className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-[var(--nova-text-secondary)]"
    >
      {lines.length ? lines.join("\n") : "No trace lines yet. Send an agent prompt to inspect router & tool trace."}
    </pre>
  );
}
