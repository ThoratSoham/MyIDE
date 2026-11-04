import fs from "fs";
import path from "path";
import { app } from "electron";
import log from "electron-log";
import type { Lane, LaneHealth } from "./types";

// FR-2.3: the quota ledger. Tracks requests used today per lane and tokens in
// the last minute (Groq TPM), persisted to disk across restarts.
// Session-dead models (404 / 400 unavailable) are kept in memory for the
// current session only so they are never conflated with timed quota resets.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

interface LedgerEntry {
  laneId: string;
  dayKey: number;
  requestsToday: number;
  minuteStamps: number[];
  tokenStamps: { t: number; tokens: number }[];
  deadUntil: number | null;
  removedUntil: number | null;
}

interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

export interface SessionDeadInfo {
  laneId: string;
  provider: string;
  model: string;
  reason: string;
  suggestedModel?: string;
  at: number;
}

export interface CooldownInfo {
  until: number;
  reason: string;
}

function ledgerFilePath(): string {
  return path.join(app.getPath("userData"), "ledger.json");
}

export function dayKey(resetHourUtc: number, now = Date.now()): number {
  return Math.floor((now - resetHourUtc * 3600_000) / DAY_MS);
}

export function nextResetMs(resetHourUtc: number, now = Date.now()): number {
  const key = dayKey(resetHourUtc, now);
  return (key + 1) * DAY_MS + resetHourUtc * 3600_000;
}

export class Ledger {
  private entries = new Map<string, LedgerEntry>();
  private sessionDead = new Map<string, SessionDeadInfo>();
  private cooldowns = new Map<string, CooldownInfo>();
  private dirty = false;

  load(lanes: Lane[]): void {
    this.entries.clear();
    const f = ledgerFilePath();
    if (fs.existsSync(f)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(f, "utf8")) as LedgerFile;
        for (const e of parsed.entries ?? []) {
          // Clear legacy 24h deadUntil values that previously masked 404s as quota resets.
          e.deadUntil = null;
          this.entries.set(e.laneId, e);
        }
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
    const cd = this.cooldowns.get(lane.id);
    if (cd && now >= cd.until) {
      this.cooldowns.delete(lane.id);
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

  healthFor(lane: Lane): LaneHealth {
    const e = this.roll(lane);
    const dead = this.sessionDead.get(lane.id);
    const cd = this.cooldowns.get(lane.id);
    return {
      deadSession: !!dead,
      deadReason: dead?.reason,
      suggestedModel: dead?.suggestedModel,
      cooldownUntil: cd ? cd.until : null,
      cooldownReason: cd?.reason,
      deadUntil: null,
      removedUntil: e.removedUntil,
      minuteRequestCount: e.minuteStamps.length,
      minuteTokenCount: e.tokenStamps.reduce((n, s) => n + s.tokens, 0),
    };
  }

  requestsToday(lane: Lane): number {
    return this.roll(lane).requestsToday;
  }

  markDayExhausted(lane: Lane, untilMs?: number): void {
    const e = this.roll(lane);
    e.removedUntil = untilMs ?? nextResetMs(lane.limits.resetHourUtc);
    this.dirty = true;
    log.warn(`ledger: ${lane.id} removed until ${new Date(e.removedUntil).toISOString()} (day quota)`);
  }

  setCooldown(lane: Lane, untilMs: number, reason: string): void {
    this.cooldowns.set(lane.id, { until: untilMs, reason });
    log.warn(`ledger: ${lane.id} cooldown until ${new Date(untilMs).toLocaleTimeString()} — ${reason}`);
  }

  clearTransientCooldowns(): void {
    this.cooldowns.clear();
    for (const e of this.entries.values()) {
      if (e.removedUntil) {
        e.removedUntil = null;
        this.dirty = true;
      }
    }
  }

  markSessionDead(lane: Lane, reason: string, suggestedModel?: string): void {
    this.sessionDead.set(lane.id, {
      laneId: lane.id,
      provider: lane.provider,
      model: lane.model,
      reason,
      suggestedModel,
      at: Date.now(),
    });
    log.warn(
      `ledger: ${lane.id} permanently marked dead for session — ${reason}${
        suggestedModel ? ` (suggested replacement: ${suggestedModel})` : ""
      }`,
    );
  }

  sessionDeadList(): SessionDeadInfo[] {
    return [...this.sessionDead.values()];
  }

  clearSessionDeadForModel(provider: string, model: string): void {
    this.sessionDead.delete(`${provider}:${model}`);
  }

  recordSend(lane: Lane, tokens: number): void {
    const e = this.roll(lane);
    e.requestsToday += 1;
    e.minuteStamps.push(Date.now());
    if (tokens > 0) e.tokenStamps.push({ t: Date.now(), tokens });
    this.dirty = true;
  }

  snapshot(): { laneId: string; requestsToday: number; deadUntil: number | null; removedUntil: number | null }[] {
    return [...this.entries.values()].map((e) => ({
      laneId: e.laneId,
      requestsToday: e.requestsToday,
      deadUntil: this.sessionDead.has(e.laneId) ? Number.MAX_SAFE_INTEGER : null,
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
