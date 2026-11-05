import React, { useCallback, useEffect, useState } from "react";
import type {
  CostTier,
  ModelConfigEntry,
  ModelsStateView,
  ProviderKeyId,
} from "../../shared/electron-api-types";

// PART 1 #3 & #4: User-editable model list modal (id, provider, priority,
// maxTokens, costTier) backed by <userData>/models.json.

interface Props {
  onClose: () => void;
}

const PROVIDERS: ProviderKeyId[] = ["gemini", "groq", "openrouter"];
const COST_TIERS: CostTier[] = ["free", "low", "medium", "high"];

export function ModelsModal({ onClose }: Props) {
  const [state, setState] = useState<ModelsStateView | null>(null);
  const [rows, setRows] = useState<ModelConfigEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await window.electron.models.get();
      setState(s);
      setRows(s.models);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const updateRow = (idx: number, patch: Partial<ModelConfigEntry>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    setSavedNotice(null);
  };

  const addRow = () => {
    const nextPriority = rows.length > 0 ? Math.max(...rows.map((r) => r.priority)) + 1 : 1;
    setRows((prev) => [
      ...prev,
      { id: "", provider: "openrouter", priority: nextPriority, maxTokens: 16384, costTier: "low" },
    ]);
  };

  const removeRow = (idx: number) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
    setSavedNotice(null);
  };

  const save = async () => {
    const valid = rows.filter((r) => r.id.trim().length > 0);
    if (valid.length === 0) {
      setError("Keep at least one model entry before saving.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await window.electron.models.save(valid);
      setState(updated);
      setRows(updated.models);
      setSavedNotice("Saved models.json and reloaded router lanes.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const refreshLive = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await window.electron.models.refreshLive();
      setState(updated);
      setRows(updated.models);
      setSavedNotice("Synced against live provider model catalogs (cached for 1 hour).");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applySuggested = async (provider: ProviderKeyId, oldModel: string, newModel: string) => {
    setBusy(true);
    try {
      const updated = await window.electron.models.useSuggested(provider, oldModel, newModel);
      setState(updated);
      setRows(updated.models);
      setSavedNotice(`Switched ${oldModel} → ${newModel}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit models"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
    >
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
          <div>
            <h2 className="text-base font-medium text-[var(--color-text)]">Model Routing Lanes</h2>
            {state?.filePath && (
              <p className="font-mono text-[11px] text-[var(--color-muted)]">{state.filePath}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close models dialog"
            className="rounded px-2 py-1 text-sm text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-auto p-5 text-xs">
          {error && (
            <div className="rounded border border-[var(--color-negative)] bg-[var(--color-negative)]/10 px-3 py-2 text-[var(--color-negative)]">
              {error}
            </div>
          )}
          {savedNotice && (
            <div className="rounded border border-[var(--color-positive)] bg-[var(--color-positive)]/10 px-3 py-2 text-[var(--color-positive)]">
              {savedNotice}
            </div>
          )}

          {(state?.dropped.length ?? 0) > 0 && (
            <div className="rounded border border-[var(--color-warn)] bg-[var(--color-warn)]/10 p-3">
              <div className="mb-1 font-medium text-[var(--color-warn)]">
                Dropped unavailable slugs (not found in provider’s live model list):
              </div>
              <ul className="space-y-1">
                {state!.dropped.map((d) => (
                  <li key={`${d.provider}:${d.id}`} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[var(--color-text)]">
                      {d.provider}:{d.id}
                    </span>
                    <span className="text-[var(--color-muted)]">— {d.reason}</span>
                    {d.suggestedModel && (
                      <button
                        type="button"
                        onClick={() => void applySuggested(d.provider, d.id, d.suggestedModel!)}
                        className="rounded bg-[var(--color-accent)] px-2 py-0.5 text-[11px] text-white"
                      >
                        Use suggested model ({d.suggestedModel})
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(state?.deadSession.length ?? 0) > 0 && (
            <div className="rounded border border-[var(--color-negative)] bg-[var(--color-negative)]/10 p-3">
              <div className="mb-1 font-medium text-[var(--color-negative)]">
                Marked dead for this session (HTTP 404 / 400 unavailable):
              </div>
              <ul className="space-y-1">
                {state!.deadSession.map((d) => (
                  <li key={`${d.provider}:${d.id}`} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[var(--color-text)]">
                      {d.provider}:{d.id}
                    </span>
                    <span className="text-[var(--color-muted)]">— {d.reason}</span>
                    {d.suggestedModel && (
                      <button
                        type="button"
                        onClick={() => void applySuggested(d.provider, d.id, d.suggestedModel!)}
                        className="rounded bg-[var(--color-accent)] px-2 py-0.5 text-[11px] text-white"
                      >
                        Use suggested model ({d.suggestedModel})
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-[11px] text-[var(--color-muted)]">
                  <th className="px-2 py-1.5">Priority</th>
                  <th className="px-2 py-1.5">Provider</th>
                  <th className="px-2 py-1.5">Model Slug (id)</th>
                  <th className="px-2 py-1.5">Context</th>
                  <th className="px-2 py-1.5">Max Output</th>
                  <th className="px-2 py-1.5">Cost Tier</th>
                  <th className="px-2 py-1.5">Capabilities</th>
                  <th className="px-2 py-1.5">Roles</th>
                  <th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {rows.map((row, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        min={1}
                        value={row.priority}
                        onChange={(e) => updateRow(i, { priority: Number(e.target.value) || 1 })}
                        aria-label={`Priority for row ${i + 1}`}
                        className="w-16 rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1 text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <select
                        value={row.provider}
                        onChange={(e) => updateRow(i, { provider: e.target.value as ProviderKeyId })}
                        aria-label={`Provider for row ${i + 1}`}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1 text-xs"
                      >
                        {PROVIDERS.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="text"
                        value={row.id}
                        onChange={(e) => updateRow(i, { id: e.target.value })}
                        placeholder="e.g. meta-llama/llama-3.2-3b-instruct"
                        aria-label={`Model slug for row ${i + 1}`}
                        className="w-full min-w-[230px] rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1 font-mono text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        min={512}
                        step={512}
                        value={row.maxTokens}
                        onChange={(e) => updateRow(i, { maxTokens: Number(e.target.value) || 4096 })}
                        aria-label={`Context/max tokens for row ${i + 1}`}
                        className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1 text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        min={512}
                        step={512}
                        value={row.maxOutputTokens ?? row.maxTokens}
                        onChange={(e) => updateRow(i, { maxOutputTokens: Number(e.target.value) || 4096 })}
                        aria-label={`Max output tokens for row ${i + 1}`}
                        className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1 text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <select
                        value={row.costTier}
                        onChange={(e) => updateRow(i, { costTier: e.target.value as CostTier })}
                        aria-label={`Cost tier for row ${i + 1}`}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1 text-xs"
                      >
                        {COST_TIERS.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2 text-[11px]">
                        <label title="Vision supported" className="flex items-center gap-0.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={Boolean(row.supportsVision)}
                            onChange={(e) => updateRow(i, { supportsVision: e.target.checked })}
                          />
                          <span>👁️</span>
                        </label>
                        <label title="Reasoning model (reserve 30% thinking overhead)" className="flex items-center gap-0.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={Boolean(row.isReasoning)}
                            onChange={(e) => updateRow(i, { isReasoning: e.target.checked })}
                          />
                          <span>🧠</span>
                        </label>
                        <label title="JSON Mode" className="flex items-center gap-0.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={row.supportsJsonMode !== false}
                            onChange={(e) => updateRow(i, { supportsJsonMode: e.target.checked })}
                          />
                          <span>{`{}`}</span>
                        </label>
                      </div>
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="text"
                        value={(row.roleTags ?? []).join(", ")}
                        onChange={(e) =>
                          updateRow(i, {
                            roleTags: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder="e.g. codegen, fast, vision"
                        aria-label={`Role tags for row ${i + 1}`}
                        className="w-28 rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1 text-xs font-mono"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => removeRow(i)}
                        aria-label={`Remove model ${row.id}`}
                        className="rounded px-2 py-1 text-[var(--color-negative)] hover:bg-[var(--color-negative)]/10"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addRow}
              className="rounded border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-alt)]"
            >
              + Add model
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void refreshLive()}
              className="rounded border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-alt)] disabled:opacity-40"
            >
              Refresh live provider catalog
            </button>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-surface-alt)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="rounded bg-[var(--color-accent)] px-4 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save models"}
          </button>
        </div>
      </div>
    </div>
  );
}

