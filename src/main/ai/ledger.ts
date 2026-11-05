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
  isProbation?: boolean;
}

export interface LaneQualitySample {
  ok: boolean;
  validJson?: boolean;
  latencyMs?: number;
}

export interface AffordabilityCheck {
  ok: boolean;
  status?: "dead" | "quota" | "cooldown" | "skipped_size";
  reason?: string;
  resumeAtMs?: number | null;
}

interface RollingQualityState {
  outcomes: boolean[];
  jsonValidity: boolean[];
  latenciesMs: number[];
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
  private quality = new Map<string, RollingQualityState>();
  private dirty = false;
  public probationDurationMs = 90_000;

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

  private roll(lane: Lane, now = Date.now()): LedgerEntry {
    const e = this.ensure(lane);
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
      if (cd.isProbation) {
        // Clear malformed-JSON window after probation expires so the lane gets re-tested cleanly.
        const q = this.quality.get(lane.id);
        if (q) q.jsonValidity = [];
      }
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

  healthFor(lane: Lane, now = Date.now()): LaneHealth {
    const e = this.roll(lane, now);
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

  /**
   * PHASE 5: Proactive token-bucket pre-check (RPM, TPM, RPD, cooldowns, probation)
   * so the router never wastes a doomed HTTP call when local quota math already knows
   * the lane cannot fit `estimatedTotalTokens` right now.
   */
  canAfford(lane: Lane, estimatedTotalTokens: number, now = Date.now()): AffordabilityCheck {
    const e = this.roll(lane, now);
    const dead = this.sessionDead.get(lane.id);
    if (dead) {
      return {
        ok: false,
        status: "dead",
        reason: dead.reason || "Model permanently unavailable for this session",
        resumeAtMs: null,
      };
    }

    if (e.removedUntil && e.removedUntil > now) {
      return {
        ok: false,
        status: "quota",
        reason: `Daily quota exhausted`,
        resumeAtMs: e.removedUntil,
      };
    }

    if (Number.isFinite(lane.limits.rpd) && e.requestsToday >= lane.limits.rpd) {
      const resetMs = nextResetMs(lane.limits.resetHourUtc, now);
      return {
        ok: false,
        status: "quota",
        reason: `Proactive daily cap reached (${e.requestsToday}/${lane.limits.rpd} RPD)`,
        resumeAtMs: resetMs,
      };
    }

    const cd = this.cooldowns.get(lane.id);
    if (cd && cd.until > now) {
      return {
        ok: false,
        status: "cooldown",
        reason: cd.reason || "Cooldown active",
        resumeAtMs: cd.until,
      };
    }

    if (lane.limits.maxTokensPerRequest != null && estimatedTotalTokens > lane.limits.maxTokensPerRequest) {
      return {
        ok: false,
        status: "skipped_size",
        reason: `Estimated ${estimatedTotalTokens} tokens exceeds ${lane.limits.maxTokensPerRequest}-token request cap`,
        resumeAtMs: null,
      };
    }

    if (Number.isFinite(lane.limits.rpm) && e.minuteStamps.length >= lane.limits.rpm) {
      const earliest = e.minuteStamps[0] ?? now;
      return {
        ok: false,
        status: "cooldown",
        reason: `Proactive RPM bucket full (${e.minuteStamps.length}/${lane.limits.rpm} RPM)`,
        resumeAtMs: Math.max(now + 1_000, earliest + MINUTE_MS),
      };
    }

    if (lane.limits.tpm != null && Number.isFinite(lane.limits.tpm)) {
      if (estimatedTotalTokens > lane.limits.tpm) {
        return {
          ok: false,
          status: "skipped_size",
          reason: `Estimated ${estimatedTotalTokens} tokens exceeds ${lane.limits.tpm} TPM bucket capacity`,
          resumeAtMs: null,
        };
      }
      const usedMinuteTokens = e.tokenStamps.reduce((sum, s) => sum + s.tokens, 0);
      if (usedMinuteTokens > 0 && usedMinuteTokens + estimatedTotalTokens > lane.limits.tpm) {
        const earliestTok = e.tokenStamps[0]?.t ?? now;
        return {
          ok: false,
          status: "cooldown",
          reason: `Proactive TPM bucket would overflow (${usedMinuteTokens} + ${estimatedTotalTokens} > ${lane.limits.tpm} TPM)`,
          resumeAtMs: Math.max(now + 1_000, earliestTok + MINUTE_MS),
        };
      }
    }

    return { ok: true };
  }

  recordQualitySample(lane: Lane, sample: LaneQualitySample, now = Date.now()): void {
    let q = this.quality.get(lane.id);
    if (!q) {
      q = { outcomes: [], jsonValidity: [], latenciesMs: [] };
      this.quality.set(lane.id, q);
    }

    q.outcomes.push(sample.ok);
    if (q.outcomes.length > 20) q.outcomes.shift();

    if (typeof sample.latencyMs === "number" && sample.latencyMs >= 0) {
      q.latenciesMs.push(sample.latencyMs);
      if (q.latenciesMs.length > 20) q.latenciesMs.shift();
    }

    if (typeof sample.validJson === "boolean") {
      q.jsonValidity.push(sample.validJson);
      if (q.jsonValidity.length > 20) q.jsonValidity.shift();

      if (q.jsonValidity.length >= 4) {
        const malformed = q.jsonValidity.filter((v) => !v).length;
        const malformedRate = malformed / q.jsonValidity.length;
        if (malformedRate > 0.25) {
          const until = now + this.probationDurationMs;
          this.cooldowns.set(lane.id, {
            until,
            reason: `Probation: ${Math.round(malformedRate * 100)}% malformed JSON rate`,
            isProbation: true,
          });
          log.warn(`ledger: ${lane.id} placed on probation (${Math.round(malformedRate * 100)}% malformed JSON)`);
        }
      }
    }
  }

  /**
   * Lower is better (0 = healthy fast lane). Added to base priority when sorting lanes dynamically.
   */
  qualityScorePenalty(laneId: string): number {
    const q = this.quality.get(laneId);
    if (!q) return 0;
    let penalty = 0;
    if (q.outcomes.length >= 2) {
      const errRate = q.outcomes.filter((ok) => !ok).length / q.outcomes.length;
      penalty += errRate * 6;
    }
    if (q.jsonValidity.length >= 2) {
      const badJsonRate = q.jsonValidity.filter((v) => !v).length / q.jsonValidity.length;
      penalty += badJsonRate * 10;
    }
    if (q.latenciesMs.length >= 2) {
      const avgMs = q.latenciesMs.reduce((a, b) => a + b, 0) / q.latenciesMs.length;
      if (avgMs > 12_000) penalty += 1.5;
    }
    return penalty;
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
