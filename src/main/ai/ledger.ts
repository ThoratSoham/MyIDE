import fs from "fs";
import path from "path";
import { app } from "electron";
import log from "electron-log";
import type { Lane, LaneHealth } from "./types";

// FR-2.3: the quota ledger. Tracks requests used today per lane and tokens in
// the last minute (Groq TPM). Saved to disk so a restart does not reset usage
// and re-send requests a lane has no budget for.
//
// FR-2.5: when a daily quota is used up we remove the lane until its reset time
// and never poll it before then. FR-2.7: a 403/404 marks a model dead for 24h.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DEAD_MS = 24 * 60 * 60 * 1000;

interface LedgerEntry {
  laneId: string;
  dayKey: number;
  requestsToday: number;
  minuteStamps: number[]; // request timestamps inside the rolling minute
  tokenStamps: { t: number; tokens: number }[]; // token usage inside the rolling minute
  deadUntil: number | null;
  removedUntil: number | null;
}

interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

function ledgerFilePath(): string {
  return path.join(app.getPath("userData"), "ledger.json");
}

// The "day" a request belongs to, honoring a provider's reset hour (UTC).
export function dayKey(resetHourUtc: number, now = Date.now()): number {
  return Math.floor((now - resetHourUtc * 3600_000) / DAY_MS);
}

export function nextResetMs(resetHourUtc: number, now = Date.now()): number {
  const key = dayKey(resetHourUtc, now);
  return (key + 1) * DAY_MS + resetHourUtc * 3600_000;
}

export class Ledger {
  private entries = new Map<string, LedgerEntry>();
  private dirty = false;

  load(lanes: Lane[]): void {
    this.entries.clear();
    const f = ledgerFilePath();
    if (fs.existsSync(f)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(f, "utf8")) as LedgerFile;
        for (const e of parsed.entries ?? []) this.entries.set(e.laneId, e);
      } catch (err) {
        log.warn("ledger: could not read ledger.json, starting fresh", err);
      }
    }
    for (const lane of lanes) this.ensure(lane);
    this.prune();
  }

  private ensure(lane: Lane): LedgerEntry {
    let e = this.entries.get(lane.id);
    if (!e) {
      e = {
        laneId: lane.id,
        dayKey: dayKey(lane.limits.resetHourUtc),
        requestsToday: 0,
        minuteStamps: [],
        tokenStamps: [],
        deadUntil: null,
        removedUntil: null,
      };
      this.entries.set(lane.id, e);
      this.dirty = true;
    }
    return e;
  }

  // Roll windows forward: clear the rolling minute and reset the daily counter
  // when the day boundary passes.
  private roll(lane: Lane): LedgerEntry {
    const e = this.ensure(lane);
    const now = Date.now();
    const cutoff = now - MINUTE_MS;

    e.minuteStamps = e.minuteStamps.filter((t) => t > cutoff);
    e.tokenStamps = e.tokenStamps.filter((s) => s.t > cutoff);

    const key = dayKey(lane.limits.resetHourUtc, now);
    if (key !== e.dayKey) {
      e.dayKey = key;
      e.requestsToday = 0;
      this.dirty = true;
    }
    if (e.removedUntil && now >= e.removedUntil) {
      e.removedUntil = null;
      this.dirty = true;
    }
    if (e.deadUntil && now >= e.deadUntil) {
      e.deadUntil = null;
      this.dirty = true;
    }
    return e;
  }

  private prune(): void {
    const now = Date.now();
    for (const e of this.entries.values()) {
      const cutoff = now - MINUTE_MS;
      e.minuteStamps = e.minuteStamps.filter((t) => t > cutoff);
      e.tokenStamps = e.tokenStamps.filter((s) => s.t > cutoff);
    }
  }

  // LaneHealth view the router and isLaneUsable consume.
  healthFor(lane: Lane): LaneHealth {
    const e = this.roll(lane);
    return {
      deadUntil: e.deadUntil,
      removedUntil: e.removedUntil,
      minuteRequestCount: e.minuteStamps.length,
      minuteTokenCount: e.tokenStamps.reduce((n, s) => n + s.tokens, 0),
    };
  }

  requestsToday(lane: Lane): number {
    return this.roll(lane).requestsToday;
  }

  // FR-2.5: daily budget used. Remove the lane until reset.
  markDayExhausted(lane: Lane, untilMs?: number): void {
    const e = this.roll(lane);
    e.removedUntil = untilMs ?? nextResetMs(lane.limits.resetHourUtc);
    this.dirty = true;
    log.warn(`ledger: ${lane.id} removed until ${new Date(e.removedUntil).toISOString()} (day quota)`);
  }

  // FR-2.7: 403/404 -> dead for 24h.
  markDead(lane: Lane): void {
    const e = this.roll(lane);
    e.deadUntil = Date.now() + DEAD_MS;
    this.dirty = true;
    log.warn(`ledger: ${lane.id} marked dead for 24h`);
  }

  // FR-2.6: only recorded when a request is actually sent.
  recordSend(lane: Lane, tokens: number): void {
    const e = this.roll(lane);
    e.requestsToday += 1;
    e.minuteStamps.push(Date.now());
    if (tokens > 0) e.tokenStamps.push({ t: Date.now(), tokens });
    this.dirty = true;
  }

  // FR-2.4: learn a real limit from a header/error and pin it for the lane.
  snapshot(): { laneId: string; requestsToday: number; deadUntil: number | null; removedUntil: number | null }[] {
    return [...this.entries.values()].map((e) => ({
      laneId: e.laneId,
      requestsToday: e.requestsToday,
      deadUntil: e.deadUntil,
      removedUntil: e.removedUntil,
    }));
  }

  save(): void {
    if (!this.dirty) return;
    const f = ledgerFilePath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const data: LedgerFile = { version: 1, entries: [...this.entries.values()] };
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, f);
    this.dirty = false;
  }
}
