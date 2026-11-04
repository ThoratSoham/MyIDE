import React, { useEffect, useState } from "react";
import type { QuotaLaneView } from "../../shared/electron-api-types";

// FR-2.9 / FR-12.3: used and left per lane, reset time, and tokens this minute
// (Groq). The lanes come straight from the ledger in the main process.

export function QuotaPanel({ embedded = false }: { embedded?: boolean }) {
  const [lanes, setLanes] = useState<QuotaLaneView[]>([]);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [rows, status] = await Promise.all([
          window.electron.quota.get(),
          window.electron.ai.status(),
        ]);
        if (!alive) return;
        setLanes(rows);
        setOffline(status.offline);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <aside
      className={
        embedded
          ? "flex h-full w-full flex-col overflow-hidden p-3 text-sm"
          : "flex h-full w-72 flex-shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
      }
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--color-text)]">Quota</h2>
        <span className="text-[10px] text-[var(--color-muted)]">free tiers</span>
      </div>

      {offline && (
        <div className="mb-3 rounded border border-[var(--color-warn)] bg-[var(--color-warn)]/10 px-2 py-1.5 text-[11px] text-[var(--color-warn)]">
          No provider keys yet. Jobs run on the offline library lane and produce library-quality output. Add a free
          key in Settings for real model output.
        </div>
      )}

      {error && (
        <div className="mb-2 rounded border border-[var(--color-negative)] px-2 py-1 text-[11px] text-[var(--color-negative)]">
          {error}
        </div>
      )}

      <p className="mb-3 text-xs text-[var(--color-muted)]">
        Requests today and tokens this minute, per lane. A lane over its daily quota stays out until its reset
        (FR-2.5, FR-2.7).
      </p>

      <ul className="flex-1 space-y-2 overflow-auto">
        {lanes.length === 0 && !error && (
          <li className="text-xs text-[var(--color-muted)]">No lanes reported yet.</li>
        )}
        {lanes.map((lane) => (
          <LaneCard key={lane.laneId} lane={lane} />
        ))}
      </ul>

      <div className="mt-3 border-t border-[var(--color-border)] pt-2 text-[10px] text-[var(--color-muted)]">
        Parallel use adds speed and judging, not quota (section 5).
      </div>
    </aside>
  );
}

function LaneCard({ lane }: { lane: QuotaLaneView }) {
  const dayPct = lane.limitToday != null && lane.limitToday > 0 ? (lane.usedToday / lane.limitToday) * 100 : 0;
  const minutePct =
    lane.limitMinute != null && lane.limitMinute > 0 ? (lane.usedMinute / lane.limitMinute) * 100 : 0;

  const dayColor = barColor(dayPct);
  const minuteColor = barColor(minutePct);

  return (
    <li className="rounded border border-[var(--color-border)] bg-[var(--color-base)] p-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="min-w-0">
          <div className="truncate font-medium text-[var(--color-text)]">{lane.model}</div>
          <div className="truncate text-[var(--color-muted)]">
            {lane.providerLabel} · {lane.role}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ${statusClass(lane.status)}`}>
          {lane.status}
        </span>
      </div>

      <div className="mt-2 space-y-1.5 text-xs">
        <Row label="Today" pct={dayPct} color={dayColor} value={`${lane.usedToday.toLocaleString()} / ${lane.limitToday?.toLocaleString() ?? "∞"}`} />
        {lane.limitMinute != null && (
          <Row
            label="Minute (tokens)"
            pct={minutePct}
            color={minuteColor}
            value={`${lane.usedMinute.toLocaleString()} / ${lane.limitMinute.toLocaleString()}`}
          />
        )}
        <div className="flex items-center gap-2">
          <span className="w-[92px] text-[var(--color-muted)]">Reset</span>
          <span className="text-[var(--color-text)]">{lane.resetAt ?? "—"}</span>
        </div>
      </div>
    </li>
  );
}

function Row({ label, pct, color, value }: { label: string; pct: number; color: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[92px] shrink-0 text-[var(--color-muted)]">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-alt)]">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="shrink-0 text-right tabular-nums text-[var(--color-text)]">{value}</span>
    </div>
  );
}

function barColor(pct: number): string {
  if (pct >= 100) return "bg-[var(--color-negative)]";
  if (pct >= 80) return "bg-[var(--color-warn)]";
  return "bg-[var(--color-positive)]";
}

function statusClass(status: QuotaLaneView["status"]): string {
  if (status === "ok") return "bg-[var(--color-positive)]/20 text-[var(--color-positive)]";
  if (status === "limited") return "bg-[var(--color-warn)]/20 text-[var(--color-warn)]";
  return "bg-[var(--color-negative)]/20 text-[var(--color-negative)]";
}
