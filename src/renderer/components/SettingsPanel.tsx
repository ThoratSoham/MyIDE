import React, { useCallback, useEffect, useState } from "react";
import {
  Check,
  Cpu,
  KeyRound,
  Layout,
  type LucideIcon,
  Monitor,
  Palette,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  X,
} from "lucide-react";
import type {
  AiStatus,
  KeyStatus,
  KeyTestResult,
  ProviderKeyId,
  Settings,
} from "../../shared/electron-api-types";
import { NovaLogoMark } from "../branding/NovaBrand";
import { Badge, Kbd } from "../design-system/primitives";
import { useLayoutStore } from "../stores/layoutStore";

interface Props {
  settings?: Settings;
  onChange: (partial: Partial<Settings>) => void;
  onClose: () => void;
  onOpenModels?: () => void;
}

type SettingsTab = "keys" | "appearance" | "agent" | "terminal" | "quotas";

const FALLBACK: Settings = {
  theme: "system",
  defaultMode: "balanced",
  chromePath: "",
  autoResumeAtQuotaReset: true,
  askWorkspaceEachTime: false,
  terminalFontSize: 13,
  askQuestionTimeoutSec: 120,
  providerOverrides: { geminiApiKeyLast4: "", openrouterApiKeyLast4: "", groqApiKeyLast4: "" },
};

const NAV_TABS: Array<{
  id: SettingsTab;
  label: string;
  Icon: LucideIcon;
}> = [
  { id: "keys", label: "Free-API Keys", Icon: KeyRound },
  { id: "appearance", label: "Appearance & Layout", Icon: Palette },
  { id: "agent", label: "Agent & Workflow", Icon: Sparkles },
  { id: "terminal", label: "Terminal & Browser", Icon: TerminalSquare },
  { id: "quotas", label: "Quotas & Library", Icon: ShieldCheck },
];

export function SettingsPanel({ settings, onChange, onClose, onOpenModels }: Props) {
  const s = settings ?? FALLBACK;
  const { resetLayout, agentDockSide, toggleAgentDockSide } = useLayoutStore();

  const [tab, setTab] = useState<SettingsTab>("keys");
  const [keys, setKeys] = useState<KeyStatus[]>([]);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<ProviderKeyId, string>>>({});
  const [results, setResults] = useState<KeyTestResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [status, aiStatus] = await Promise.all([
        window.electron.keys.status(),
        window.electron.ai.status(),
      ]);
      setKeys(status);
      setAi(aiStatus);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const saveKey = async (provider: ProviderKeyId) => {
    const value = (drafts[provider] ?? "").trim();
    if (!value) return;
    setBusy(true);
    try {
      setKeys(await window.electron.keys.set(provider, value));
      setDrafts((d) => ({ ...d, [provider]: "" }));
      setResults(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async (provider: ProviderKeyId) => {
    setBusy(true);
    try {
      setKeys(await window.electron.keys.clear(provider));
      setResults(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const testKeys = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await window.electron.keys.test();
      setResults(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const testFor = (p: ProviderKeyId) => results?.find((r) => r.provider === p);
  const configuredCount = keys.filter((k) => k.configured).length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Nova IDE Settings"
      data-settings-modal
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--nova-bg-overlay)] p-4 backdrop-blur-[2px]"
    >
      <div className="nova-overlay-enter flex h-[620px] max-h-[88vh] w-[780px] max-w-[96vw] flex-col overflow-hidden rounded-xl border border-[var(--nova-border-strong)] bg-[var(--nova-bg-panel)] shadow-[var(--nova-shadow-lg)]">
        {/* Top Modal Header */}
        <div className="flex items-center justify-between border-b border-[var(--nova-border)] bg-[var(--nova-bg-surface)] px-4 py-3">
          <div className="flex items-center gap-2.5">
            <NovaLogoMark size={18} />
            <h2 className="text-sm font-semibold text-[var(--nova-text-primary)]">Nova IDE Settings</h2>
            <Badge tone={configuredCount > 0 ? "success" : "warning"}>
              {configuredCount} {configuredCount === 1 ? "key" : "keys"} active
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Kbd>Esc</Kbd>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="rounded-md p-1 text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Left Navigation Rail */}
          <nav
            aria-label="Settings categories"
            className="flex w-52 flex-none flex-col justify-between border-r border-[var(--nova-border)] bg-[var(--nova-bg-app)] p-2.5"
          >
            <div className="space-y-1">
              {NAV_TABS.map(({ id, label, Icon }) => {
                const active = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs ${
                      active
                        ? "bg-[var(--nova-accent-soft)] font-medium text-[var(--nova-accent-bright)]"
                        : "text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
                    }`}
                  >
                    <Icon size={14} />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>

            <div className="space-y-2 border-t border-[var(--nova-border-subtle)] pt-2.5 text-[11px] text-[var(--nova-text-muted)]">
              {onOpenModels && (
                <button
                  type="button"
                  onClick={onOpenModels}
                  className="flex w-full items-center gap-1.5 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-bg-panel)] px-2.5 py-1.5 text-xs text-[var(--nova-text-primary)] hover:bg-[var(--nova-bg-hover)]"
                >
                  <Cpu size={13} className="text-[var(--nova-accent-bright)]" />
                  <span>Edit Model Lanes…</span>
                </button>
              )}
              <div className="px-1 text-[10px] text-[var(--nova-text-faint)]">
                Nova IDE {ai?.version ? `v${ai.version}` : ""}
              </div>
            </div>
          </nav>

          {/* Right Settings Content */}
          <div className="min-h-0 flex-1 overflow-y-auto p-5 text-xs">
            {error && (
              <div className="mb-4 rounded-lg border border-[var(--nova-danger)]/50 bg-[var(--nova-danger-soft)] px-3 py-2 text-xs text-[var(--nova-danger)]">
                {error}
              </div>
            )}

            {tab === "keys" && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--nova-text-primary)]">
                    Encrypted Free-Tier API Keys
                  </h3>
                  <p className="mt-1 leading-relaxed text-[var(--nova-text-muted)]">
                    Keys are encrypted at rest via Electron <code className="font-mono">safeStorage</code> (OS keychain)
                    and never exposed to the renderer. Only the last 4 characters are shown for verification.
                  </p>
                </div>

                <div className="space-y-2.5">
                  {keys.map((k) => (
                    <KeyRow
                      key={k.provider}
                      status={k}
                      draft={drafts[k.provider] ?? ""}
                      onDraft={(v) => setDrafts((d) => ({ ...d, [k.provider]: v }))}
                      onSave={() => void saveKey(k.provider)}
                      onClear={() => void clearKey(k.provider)}
                      busy={busy}
                      test={testFor(k.provider)}
                    />
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void testKeys()}
                    disabled={busy}
                    className="rounded-lg bg-[var(--nova-accent)] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[var(--nova-accent-hover)] disabled:opacity-40"
                  >
                    {busy ? "Testing providers…" : "Test my keys"}
                  </button>
                  {onOpenModels && (
                    <button
                      type="button"
                      onClick={onOpenModels}
                      className="rounded-lg border border-[var(--nova-border)] bg-[var(--nova-bg-surface)] px-3.5 py-1.5 text-xs text-[var(--nova-text-primary)] hover:bg-[var(--nova-bg-hover)]"
                    >
                      Configure Model Priority…
                    </button>
                  )}
                </div>

                {ai?.offline && (
                  <div className="rounded-lg border border-[var(--nova-warning)]/40 bg-[var(--nova-warning-soft)] p-3 text-[11.5px] text-[var(--nova-warning)]">
                    No cloud API key is configured yet. Runs will fall back to the local offline starter pack until you
                    add a free Gemini, Groq, or OpenRouter key (or connect local Ollama in Milestone 3).
                  </div>
                )}
              </div>
            )}

            {tab === "appearance" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--nova-text-primary)]">Theme & Surface</h3>
                  <p className="mt-1 text-[var(--nova-text-muted)]">
                    Nova IDE uses dark-first design tokens with high-contrast focus outlines and reduced-motion support.
                  </p>
                  <div className="mt-3 grid grid-cols-3 gap-2.5">
                    {(["dark", "light", "system"] as const).map((t) => {
                      const active = s.theme === t;
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => onChange({ theme: t })}
                          className={`flex items-center justify-between rounded-lg border px-3 py-2.5 capitalize ${
                            active
                              ? "border-[var(--nova-accent-bright)] bg-[var(--nova-accent-soft)] font-medium text-[var(--nova-text-primary)]"
                              : "border-[var(--nova-border)] bg-[var(--nova-bg-surface)] text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)]"
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <Monitor size={13} />
                            {t}
                          </span>
                          {active && <Check size={13} className="text-[var(--nova-accent-bright)]" />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="border-t border-[var(--nova-border-subtle)] pt-4">
                  <h3 className="text-sm font-semibold text-[var(--nova-text-primary)]">Workspace Panel Docking</h3>
                  <p className="mt-1 text-[var(--nova-text-muted)]">
                    Panel widths, open tabs, and active mode persist automatically across restarts.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={toggleAgentDockSide}
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-bg-surface)] px-3 py-1.5 text-xs text-[var(--nova-text-primary)] hover:bg-[var(--nova-bg-hover)]"
                    >
                      <Layout size={13} />
                      <span>Agent Panel Dock: {agentDockSide === "right" ? "Right (Default)" : "Left"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={resetLayout}
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-bg-surface)] px-3 py-1.5 text-xs text-[var(--nova-text-secondary)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
                    >
                      <RotateCcw size={13} />
                      <span>Reset Layout to Defaults</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {tab === "agent" && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--nova-text-primary)]">Agent Behavior & Defaults</h3>
                  <p className="mt-1 text-[var(--nova-text-muted)]">
                    Tune token/speed mode, quota auto-resume, and interactive question timeouts.
                  </p>
                </div>

                <label className="flex flex-col gap-1.5 text-xs text-[var(--nova-text-secondary)]">
                  <span className="font-medium text-[var(--nova-text-primary)]">Default routing mode</span>
                  <select
                    value={s.defaultMode}
                    onChange={(e) => onChange({ defaultMode: e.target.value as Settings["defaultMode"] })}
                    className="w-56 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-bg-app)] px-2.5 py-1.5 text-xs text-[var(--nova-text-primary)]"
                  >
                    <option value="fast">Fast — lowest latency & quota burn</option>
                    <option value="balanced">Balanced — smart plan + execution</option>
                    <option value="best">Best — highest reasoning lanes first</option>
                  </select>
                </label>

                <label className="flex items-start gap-2.5 rounded-lg border border-[var(--nova-border-subtle)] bg-[var(--nova-bg-surface)] p-3">
                  <input
                    type="checkbox"
                    checked={s.autoResumeAtQuotaReset}
                    onChange={(e) => onChange({ autoResumeAtQuotaReset: e.target.checked })}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="font-medium text-[var(--nova-text-primary)]">
                      Auto-resume when free-tier cooldown expires
                    </div>
                    <div className="text-[11px] text-[var(--nova-text-muted)]">
                      Automatically continues paused runs once the earliest rate-limited lane resets.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-2.5 rounded-lg border border-[var(--nova-border-subtle)] bg-[var(--nova-bg-surface)] p-3">
                  <input
                    type="checkbox"
                    checked={s.askWorkspaceEachTime}
                    onChange={(e) => onChange({ askWorkspaceEachTime: e.target.checked })}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="font-medium text-[var(--nova-text-primary)]">
                      Ask before creating a new project workspace folder
                    </div>
                    <div className="text-[11px] text-[var(--nova-text-muted)]">
                      Prompts for a target directory whenever a scaffold task needs an empty workspace.
                    </div>
                  </div>
                </label>

                <label className="flex flex-col gap-1.5 text-xs text-[var(--nova-text-secondary)]">
                  <span className="font-medium text-[var(--nova-text-primary)]">
                    Popup question timeout (seconds, 0 = wait indefinitely)
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={3600}
                    value={s.askQuestionTimeoutSec ?? 120}
                    onChange={(e) =>
                      onChange({ askQuestionTimeoutSec: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="w-36 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-bg-app)] px-2.5 py-1.5 text-xs text-[var(--nova-text-primary)]"
                  />
                </label>
              </div>
            )}

            {tab === "terminal" && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--nova-text-primary)]">
                    Integrated Terminal & Headless Browser
                  </h3>
                  <p className="mt-1 text-[var(--nova-text-muted)]">
                    Configure xterm.js typography and local Chromium path for preview/screenshot automation.
                  </p>
                </div>

                <label className="flex flex-col gap-1.5 text-xs text-[var(--nova-text-secondary)]">
                  <span className="font-medium text-[var(--nova-text-primary)]">Terminal font size (px)</span>
                  <input
                    type="number"
                    min={9}
                    max={24}
                    value={s.terminalFontSize}
                    onChange={(e) => onChange({ terminalFontSize: Number(e.target.value) || 13 })}
                    className="w-28 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-bg-app)] px-2.5 py-1.5 text-xs text-[var(--nova-text-primary)]"
                  />
                </label>

                <label className="flex flex-col gap-1.5 text-xs text-[var(--nova-text-secondary)]">
                  <span className="font-medium text-[var(--nova-text-primary)]">
                    Chrome / Edge / Brave executable path
                  </span>
                  <input
                    type="text"
                    value={s.chromePath}
                    onChange={(e) => onChange({ chromePath: e.target.value })}
                    placeholder="C:\Program Files\Google\Chrome\Application\chrome.exe"
                    className="w-full rounded-lg border border-[var(--nova-border)] bg-[var(--nova-bg-app)] px-2.5 py-1.5 font-mono text-xs text-[var(--nova-text-primary)]"
                  />
                  <span className="text-[11px] text-[var(--nova-text-muted)]">
                    Used by the Browser Agent and video/screenshot verification tools. Leave blank to auto-detect.
                  </span>
                </label>
              </div>
            )}

            {tab === "quotas" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--nova-text-primary)]">
                    Free-Tier Baseline Rate Limits
                  </h3>
                  <p className="mt-1 text-[var(--nova-text-muted)]">
                    Baseline limits used before live <code className="font-mono">Retry-After</code> and provider
                    rate-limit headers refine per-lane cooldowns.
                  </p>
                  <div className="mt-3 overflow-x-auto rounded-lg border border-[var(--nova-border)]">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead className="bg-[var(--nova-bg-surface)] text-[var(--nova-text-muted)]">
                        <tr>
                          <th className="px-3 py-2">Provider / Tier</th>
                          <th className="px-3 py-2 text-right">RPM</th>
                          <th className="px-3 py-2 text-right">RPD</th>
                          <th className="px-3 py-2 text-right">TPM</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--nova-border-subtle)]">
                        <LimitRow label="Gemini 2.5 Flash (Free)" rpm={5} rpd={20} tpm={null} />
                        <LimitRow label="Gemini 2.5 Flash-Lite (Free)" rpm={10} rpd={500} tpm={null} />
                        <LimitRow label="OpenRouter (:free models)" rpm={20} rpd={50} tpm={null} />
                        <LimitRow label="Groq Cloud (Free per model)" rpm={30} rpd={null} tpm={8000} />
                      </tbody>
                    </table>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-semibold text-[var(--nova-text-primary)]">Offline Starter Packs</h3>
                  {!ai || ai.packs.length === 0 ? (
                    <p className="mt-1 text-[var(--nova-text-muted)]">No offline packs loaded.</p>
                  ) : (
                    <ul className="mt-2 space-y-1.5">
                      {ai.packs.map((p) => (
                        <li
                          key={p.id}
                          className="flex items-center justify-between rounded-lg border border-[var(--nova-border-subtle)] bg-[var(--nova-bg-surface)] px-3 py-2"
                        >
                          <span className="font-medium text-[var(--nova-text-primary)]">{p.name}</span>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] text-[var(--nova-text-muted)]">v{p.version}</span>
                            <Badge tone={p.ok ? "success" : "danger"}>{p.ok ? "Ready" : "Error"}</Badge>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function KeyRow({
  status,
  draft,
  onDraft,
  onSave,
  onClear,
  busy,
  test,
}: {
  status: KeyStatus;
  draft: string;
  onDraft: (v: string) => void;
  onSave: () => void;
  onClear: () => void;
  busy: boolean;
  test?: KeyTestResult;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="rounded-lg border border-[var(--nova-border)] bg-[var(--nova-bg-surface)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-[170px] font-medium text-[var(--nova-text-primary)]">{status.label}</span>
        <Badge tone={status.configured ? "success" : "neutral"}>
          {status.configured ? `•••• ${status.last4}` : "not set"}
        </Badge>
        {test && (
          <span
            className={`max-w-[230px] truncate text-[11px] ${
              test.ok ? "text-[var(--nova-success)]" : "text-[var(--nova-danger)]"
            }`}
            title={test.message}
          >
            {test.ok ? "✓ " : "✗ "}
            {test.message}
          </span>
        )}
        <div className="ml-auto flex gap-1.5">
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded-md border border-[var(--nova-border)] bg-[var(--nova-bg-panel)] px-2.5 py-1 text-xs text-[var(--nova-text-primary)] hover:bg-[var(--nova-bg-hover)]"
          >
            {status.configured ? "Replace" : "Add key"}
          </button>
          {status.configured && (
            <button
              type="button"
              onClick={onClear}
              disabled={busy}
              className="rounded-md border border-[var(--nova-danger)]/50 px-2.5 py-1 text-xs text-[var(--nova-danger)] hover:bg-[var(--nova-danger-soft)] disabled:opacity-40"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-2.5 flex gap-1.5">
          <input
            autoFocus
            type="password"
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onSave();
                setEditing(false);
              }
              if (e.key === "Escape") setEditing(false);
            }}
            placeholder="Paste API key, then click Save"
            className="min-w-0 flex-1 rounded-md border border-[var(--nova-border)] bg-[var(--nova-bg-app)] px-2.5 py-1.5 font-mono text-xs text-[var(--nova-text-primary)] outline-none focus:border-[var(--nova-accent-bright)]"
          />
          <button
            type="button"
            onClick={() => {
              onSave();
              setEditing(false);
            }}
            disabled={!draft.trim() || busy}
            className="rounded-md bg-[var(--nova-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--nova-accent-hover)] disabled:opacity-40"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

function LimitRow({
  label,
  rpm,
  rpd,
  tpm,
}: {
  label: string;
  rpm: number | null;
  rpd: number | null;
  tpm: number | null;
}) {
  const cell = (v: number | null) => (v === null ? "—" : String(v));
  return (
    <tr>
      <td className="px-3 py-2 text-[var(--nova-text-primary)]">{label}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums text-[var(--nova-text-secondary)]">{cell(rpm)}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums text-[var(--nova-text-secondary)]">{cell(rpd)}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums text-[var(--nova-text-secondary)]">{cell(tpm)}</td>
    </tr>
  );
}
