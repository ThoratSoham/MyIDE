import React, { useCallback, useEffect, useState } from "react";
import type {
  AiStatus,
  KeyStatus,
  KeyTestResult,
  ProviderKeyId,
  Settings,
} from "../../shared/electron-api-types";

// FR-2.8 / FR-12.8: keys are entered here, stored encrypted by the OS in the
// main process and never sent back to the window — this panel only ever sees
// the last 4 characters. "Test my keys" pings each configured provider and
// reports which are usable, so a dead key is found before a run, not during one.

interface Props {
  settings?: Settings;
  onChange: (partial: Partial<Settings>) => void;
  onClose: () => void;
}

const FALLBACK: Settings = {
  theme: "system",
  defaultMode: "balanced",
  chromePath: "",
  autoResumeAtQuotaReset: true,
  providerOverrides: { geminiApiKeyLast4: "", openrouterApiKeyLast4: "", groqApiKeyLast4: "" },
};

export function SettingsPanel({ settings, onChange, onClose }: Props) {
  const s = settings ?? FALLBACK;

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="max-h-[85vh] w-[620px] overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium text-[var(--color-text)]">Settings</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)]"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded border border-[var(--color-negative)] bg-[var(--color-negative)]/10 px-3 py-1.5 text-xs text-[var(--color-negative)]">
            {error}
          </div>
        )}

        <Section label="Appearance">
          <label className="flex flex-col gap-1 text-sm text-[var(--color-muted)]">
            Theme
            <select
              value={s.theme}
              onChange={(e) => onChange({ theme: e.target.value as Settings["theme"] })}
              className="mt-1 rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1 text-sm"
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
        </Section>

        <Section label="Defaults">
          <label className="flex flex-col gap-1 text-sm text-[var(--color-muted)]">
            Default mode
            <select
              value={s.defaultMode}
              onChange={(e) => onChange({ defaultMode: e.target.value as Settings["defaultMode"] })}
              className="mt-1 rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1 text-sm"
            >
              <option value="fast">Fast</option>
              <option value="balanced">Balanced</option>
              <option value="best">Best</option>
            </select>
          </label>
          <label className="mt-3 flex items-start gap-2 text-sm text-[var(--color-muted)]">
            <input
              type="checkbox"
              checked={s.autoResumeAtQuotaReset}
              onChange={(e) => onChange({ autoResumeAtQuotaReset: e.target.checked })}
              className="mt-0.5"
            />
            <span>Auto-resume when quota resets (FR-3.5, FR-12.7)</span>
          </label>
        </Section>

        <Section label="Preview / render">
          <label className="flex flex-col gap-1 text-sm text-[var(--color-muted)]">
            Chrome / Edge / Brave path (for video render, FR-11.2)
            <input
              type="text"
              value={s.chromePath}
              onChange={(e) => onChange({ chromePath: e.target.value })}
              placeholder="C:\Program Files\Google\Chrome\Application\chrome.exe"
              className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1 text-sm"
            />
          </label>
        </Section>

        <Section label="API keys (free tiers)">
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            Keys are encrypted with the OS keychain and never shown in full. The last 4 characters are shown for
            identification only. Free tiers may use prompts to improve their products.
          </p>

          <div className="space-y-3">
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

          <button
            onClick={() => void testKeys()}
            disabled={busy}
            className="mt-4 w-full rounded border border-[var(--color-accent)] bg-[var(--color-accent)]/10 px-3 py-1.5 text-sm text-[var(--color-accent-strong)] disabled:opacity-40"
          >
            {busy ? "Testing…" : "Test my keys"}
          </button>

          {ai?.offline && (
            <p className="mt-2 text-[11px] text-[var(--color-warn)]">
              No key is configured, so runs use the offline library lane. Output is library-quality, not model-quality.
            </p>
          )}
        </Section>

        <Section label="Design library packs (FR-8.1)">
          {!ai || ai.packs.length === 0 ? (
            <p className="text-xs text-[var(--color-muted)]">No packs loaded yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {ai.packs.map((p) => (
                <li key={p.id} className="flex items-center gap-2">
                  <span className={p.ok ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}>
                    {p.ok ? "✓" : "✗"}
                  </span>
                  <span className="text-[var(--color-text)]">{p.name}</span>
                  <span className="font-mono text-[10px] text-[var(--color-muted)]">v{p.version}</span>
                  {!p.ok && p.problems.length > 0 && (
                    <span className="truncate text-[10px] text-[var(--color-negative)]">{p.problems.join("; ")}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section label="Free-tier limits (editable defaults)">
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            Defaults from the PRD section 5. Real limits are learned from 429 text, Groq headers and OpenRouter key
            info (FR-2.4).
          </p>
          <div className="overflow-x-auto text-sm">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="text-[var(--color-muted)]">
                  <th className="px-2 py-1">Provider / model</th>
                  <th className="px-2 py-1 text-right">RPM</th>
                  <th className="px-2 py-1 text-right">RPD</th>
                  <th className="px-2 py-1 text-right">TPM</th>
                  <th className="px-2 py-1 text-right">Max req/prompt</th>
                </tr>
              </thead>
              <tbody>
                <LimitRow label="Gemini Flash (3.5/3.6/3.8)" rpm={5} rpd={20} tpm={null} maxReq={null} />
                <LimitRow label="Gemini Flash-Lite" rpm={10} rpd={500} tpm={null} maxReq={null} />
                <LimitRow label="Gemini Pro" rpm={0} rpd={0} tpm={null} maxReq={null} disabled />
                <LimitRow label="OpenRouter :free" rpm={20} rpd={50} tpm={null} maxReq={null} />
                <LimitRow label="Groq (per model)" rpm={30} rpd={null} tpm={8000} maxReq={8000} />
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[10px] text-[var(--color-muted)]">
            Gemini Pro has limit 0 on the free tier and is never used (FR-2.2).
          </p>
        </Section>

        <div className="mt-4 text-right text-[10px] text-[var(--color-muted)]">
          MyIDE {ai?.version ?? ""}
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="mb-2 text-sm font-medium text-[var(--color-text)]">{label}</h3>
      {children}
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
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-base)] p-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="min-w-[180px] text-[var(--color-text)]">{status.label}</span>
        <span className="font-mono text-[11px] text-[var(--color-muted)]">
          {status.configured ? `•••• ${status.last4}` : "not set"}
        </span>
        {test && (
          <span
            className={`ml-auto max-w-[240px] truncate text-[10px] ${
              test.ok ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"
            }`}
            title={test.message}
          >
            {test.ok ? "✓ " : "✗ "}
            {test.message}
          </span>
        )}
        <div className={`${test ? "" : "ml-auto"} flex gap-1`}>
          <button
            onClick={() => setEditing((v) => !v)}
            className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs hover:bg-[var(--color-surface-alt)]"
          >
            {status.configured ? "Replace" : "Add key"}
          </button>
          {status.configured && (
            <button
              onClick={onClear}
              disabled={busy}
              className="rounded border border-[var(--color-negative)] px-2 py-0.5 text-xs text-[var(--color-negative)] disabled:opacity-40"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-2 flex gap-1">
          <input
            autoFocus
            type="password"
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSave();
              if (e.key === "Escape") setEditing(false);
            }}
            placeholder="paste the key, then Save"
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text)] outline-none"
          />
          <button
            onClick={onSave}
            disabled={!draft.trim() || busy}
            className="rounded bg-[var(--color-accent)] px-2 py-1 text-xs text-white disabled:opacity-40"
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
  maxReq,
  disabled,
}: {
  label: string;
  rpm: number | null;
  rpd: number | null;
  tpm: number | null;
  maxReq: number | null;
  disabled?: boolean;
}) {
  const cell = (v: number | null, fallback = "—") => (v === null ? fallback : String(v));

  return (
    <tr className={disabled ? "opacity-40" : ""}>
      <td className="px-2 py-1 text-[var(--color-text)]">{label}</td>
      <td className="px-2 py-1 text-right tabular-nums">{cell(rpm)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{cell(rpd)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{cell(tpm)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{cell(maxReq)}</td>
    </tr>
  );
}
