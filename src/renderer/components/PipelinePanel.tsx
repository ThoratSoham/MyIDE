import React from "react";
import type { StageEvent } from "../../shared/electron-api-types";

// FR-12.2: the pipeline view lists each stage with its status, the model that
// served it and a short detail line.

export function PipelinePanel({ stages }: { stages: StageEvent[] }) {
  if (!stages.length) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-[var(--color-muted)]">
        No pipeline has run yet. Start a website build to see the stages.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-2">
      <ol className="space-y-1">
        {stages.map((s, i) => (
          <li
            key={`${s.stage}-${s.label}-${i}`}
            className="rounded border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1.5"
          >
            <div className="flex items-center gap-2 text-xs">
              <span className={`w-3 ${statusColor(s.status)}`}>{statusIcon(s.status)}</span>
              <span className="font-mono text-[10px] text-[var(--color-muted)]">{s.stage}</span>
              <span className="truncate text-[var(--color-text)]">{s.label}</span>
              {s.model && (
                <span className="ml-auto shrink-0 rounded bg-[var(--color-surface-alt)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">
                  {s.model}
                </span>
              )}
            </div>
            {s.detail && (
              <div className="mt-0.5 pl-5 text-[10px] text-[var(--color-muted)]">{s.detail}</div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function statusIcon(s: StageEvent["status"]): string {
  return s === "done" ? "✓" : s === "start" ? "▸" : s === "skip" ? "•" : "✗";
}

function statusColor(s: StageEvent["status"]): string {
  if (s === "done") return "text-[var(--color-positive)]";
  if (s === "fail") return "text-[var(--color-negative)]";
  if (s === "start") return "text-[var(--color-accent-strong)]";
  return "text-[var(--color-muted)]";
}
