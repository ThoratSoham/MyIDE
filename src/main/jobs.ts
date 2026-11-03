import fs from "fs";
import path from "path";
import crypto from "crypto";
import log from "electron-log";
import type { AIService } from "./ai/service";
import { loadLibrary, type Library } from "./skills/library";
import { buildWebsite } from "./quality/website-pipeline";
import { createAgentState, runAgent, type AgentEvent } from "./agent/loop";
import type { AgentState, ApprovalDecision } from "./agent/tools";
import { getSettings } from "./store";
import type {
  ChatMessage,
  InterruptedRun,
  JobEvent,
  JobKind,
  JobMode,
  JobSnapshot,
  PlanStep,
  StageEvent,
} from "../shared/electron-api-types";

// FR-6.6 / FR-12: the job manager owns one run at a time. It wires the AI
// service, the skill library, the website pipeline and the agent loop, turns
// their output into a single stream of events for the window, resolves command
// approvals, and saves enough state to resume after a crash or a quota pause.

export interface JobManagerDeps {
  ai: AIService;
  workspaceRoot: () => string;
  emit: (e: JobEvent) => void;
  onPreview: (workspacePath: string) => void;
  onWorkspaceChanged?: () => void;
}

interface PendingApproval {
  command: string;
  reason: string;
  resolve: (d: ApprovalDecision) => void;
}

const MAX_MESSAGES = 400;

export class JobManager {
  private lib: Library;
  private active: ActiveJob | null = null;
  private approvals = new Map<string, PendingApproval>();
  private autoResumeTimer: NodeJS.Timeout | null = null;

  constructor(private deps: JobManagerDeps) {
    this.lib = loadLibrary();
    // FR-3.5 / FR-12.1: surface the waiting banner while every lane is blocked.
    this.deps.ai.onWaiting = (info) => {
      if (!this.active) return;
      this.active.waiting = info ? { lane: info.laneId, resumeAtMs: info.resumeAtMs } : null;
      this.emitEvent({
        type: "waiting",
        lane: info?.laneId ?? "",
        resumeAtMs: info?.resumeAtMs ?? null,
      });
    };
  }

  library(): Library {
    return this.lib;
  }

  reloadLibrary(): Library {
    this.lib = loadLibrary();
    return this.lib;
  }

  setWorkspaceRoot(root: string): void {
    void root;
    // The agent state is rebuilt per job, so nothing to do here beyond noting it.
  }

  snapshot(): JobSnapshot | null {
    const a = this.active;
    if (!a) return null;
    return {
      id: a.id,
      kind: a.kind,
      mode: a.mode,
      running: a.running,
      brief: a.brief,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      stages: a.stages,
      messages: a.messages,
      plan: a.plan,
      paused: a.paused,
      waiting: a.waiting,
      result: a.result,
    };
  }

  pendingApprovals(): { id: string; command: string; reason: string }[] {
    return [...this.approvals.entries()].map(([id, p]) => ({ id, command: p.command, reason: p.reason }));
  }

  // FR-12.7: after a crash the last unfinished run is offered as a resume banner.
  interrupted(): InterruptedRun | null {
    try {
      const f = this.currentJobFile();
      if (!fs.existsSync(f)) return null;
      const parsed = JSON.parse(fs.readFileSync(f, "utf8")) as InterruptedRun;
      if (!parsed?.brief) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  startWebsite(brief: string, mode: JobMode): JobSnapshot {
    return this.start({ kind: "website", brief, mode });
  }

  startAgent(task: string, mode: JobMode = "balanced"): JobSnapshot {
    return this.start({ kind: "agent", brief: task, mode });
  }

  note(text: string): void {
    if (!this.active || !text.trim()) return;
    this.active.signal.note = text.trim();
    this.pushMessage({ role: "user", text: text.trim() });
  }

  cancel(): void {
    if (!this.active) return;
    this.active.signal.cancelled = true;
    this.clearAutoResume();
    this.emitEvent({ type: "notice", text: "Stopping after the current step…" });
  }

  // FR-12.7: resume the interrupted or paused run with the same brief.
  async resume(): Promise<void> {
    const a = this.active;
    if (a) {
      if (!a.paused) return;
      a.paused = null;
      this.clearAutoResume();
      await this.run(a);
      return;
    }
    const interrupted = this.interrupted();
    if (!interrupted) return;
    this.start({ kind: interrupted.kind, brief: interrupted.brief, mode: interrupted.mode });
  }

  respondApproval(id: string, decision: ApprovalDecision): void {
    const p = this.approvals.get(id);
    if (!p) return;
    this.approvals.delete(id);
    this.emitEvent({ type: "approval-resolved", id });
    p.resolve(decision);
  }

  dispose(): void {
    this.clearAutoResume();
    for (const [, p] of this.approvals) p.resolve("deny");
    this.approvals.clear();
  }

  // ---- internals ----------------------------------------------------------

  private start(init: { kind: JobKind; brief: string; mode: JobMode }): JobSnapshot {
    if (this.active?.running) {
      throw new Error("A job is already running. Stop it before starting another.");
    }
    const job: ActiveJob = {
      id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
      kind: init.kind,
      mode: init.mode,
      brief: init.brief,
      startedAt: Date.now(),
      finishedAt: null,
      running: true,
      stages: [],
      messages: [],
      plan: [],
      paused: null,
      waiting: null,
      result: null,
      signal: { cancelled: false },
    };
    this.active = job;
    this.pushMessage({ role: "user", text: init.brief });
    this.writeTaskMd(init.brief);
    this.writeCurrentJob();
    void this.run(job);
    return this.snapshot()!;
  }

  private async run(job: ActiveJob): Promise<void> {
    job.running = true;
    job.paused = null;
    job.finishedAt = null;
    try {
      if (job.kind === "website") {
        await this.runWebsite(job);
      } else {
        await this.runAgent(job);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("job failed", e);
      this.pushMessage({ role: "notice", text: `Job failed: ${msg}` });
      this.emitEvent({ type: "error", text: msg });
    } finally {
      job.running = false;
      job.finishedAt = Date.now();
      if (!job.paused) this.clearCurrentJob();
      else this.scheduleAutoResume(job);
    }
  }

  private async runWebsite(job: ActiveJob): Promise<void> {
    const root = this.deps.workspaceRoot();
    const myideDir = path.join(root, ".myide");
    fs.mkdirSync(myideDir, { recursive: true });

    const slug = `site-${crypto.createHash("sha1").update(job.brief).digest("hex").slice(0, 8)}`;
    const outDir = path.join(myideDir, "build", slug);

    this.pushMessage({
      role: "notice",
      text: `Website job (${job.mode} mode). Stages run one at a time; code assembles and checks every file.`,
    });

    const result = await buildWebsite(this.deps.ai, this.lib, {
      brief: job.brief,
      mode: job.mode,
      outDir,
      workspaceRoot: root,
      verifyDir: path.join(myideDir, "verify"),
      cacheDir: path.join(myideDir, "cache"),
      onEvent: (e: StageEvent) => this.onStage(job, e),
      signal: job.signal,
    });

    job.result = { score: result.score, ok: result.ok, files: result.files };

    if (job.signal.cancelled) {
      this.pushMessage({ role: "notice", text: "Stopped by the user." });
      this.emitEvent({ type: "done", summary: "Stopped by the user." });
      return;
    }

    const indexPath = path.join(outDir, "index.html");
    this.deps.onPreview(path.relative(root, indexPath).split(path.sep).join("/"));

    const errors = result.report.issues.filter((i) => i.severity === "error").length;
    const warnings = result.report.issues.filter((i) => i.severity === "warning").length;
    const summary =
      `Built the site with score ${result.score}/10. ` +
      (result.report.verified
        ? `${errors} error(s), ${warnings} warning(s) after ${result.rounds.length} critic round(s).`
        : `Verification could not run: ${result.report.note ?? "no browser found"}.`);

    const fileList = result.files.map((f) => `.myide/build/${slug}/${f}`).join(", ");
    this.pushMessage({ role: "assistant", text: summary });
    this.pushMessage({ role: "notice", text: `Files: ${fileList}` });
    this.pushMessage({ role: "notice", text: "Open Preview to see the page; open a file to edit it." });
    this.emitEvent({ type: "done", summary });
    this.deps.onWorkspaceChanged?.();
  }

  private async runAgent(job: ActiveJob): Promise<void> {
    const root = this.deps.workspaceRoot();
    const state: AgentState = createAgentState(root);
    job.agentState = state;

    const summary = await runAgent(this.deps.ai, state, {
      taskMd: job.brief,
      signal: job.signal,
      onEvent: (e: AgentEvent) => this.onAgentEvent(job, e),
      requestApproval: (command, reason) => this.requestApproval(command, reason),
      onPreview: (rel) => this.deps.onPreview(rel),
    });

    job.plan = state.plan;
    job.result = { ok: true, files: [...state.changedHtml] };
    this.emitEvent({ type: "done", summary });
    this.deps.onWorkspaceChanged?.();
  }

  private onStage(job: ActiveJob, e: StageEvent): void {
    const idx = job.stages.findIndex((s) => s.stage === e.stage && s.label === e.label);
    if (idx >= 0) job.stages[idx] = e;
    else job.stages.push(e);
    this.emitEvent({ type: "stage", event: e });
  }

  private onAgentEvent(job: ActiveJob, e: AgentEvent): void {
    switch (e.type) {
      case "assistant":
        this.pushMessage({ role: "assistant", text: e.text, model: e.model });
        break;
      case "tool":
        this.pushMessage({
          role: "tool",
          ok: e.ok,
          text: `${e.name} ${e.ok ? "✓" : "✗"}\n${e.output}`,
        });
        break;
      case "plan":
        job.plan = e.steps;
        this.emitEvent({ type: "plan", steps: e.steps });
        break;
      case "notice":
        this.pushMessage({ role: "notice", text: e.text });
        break;
      case "paused":
        job.paused = { reason: e.reason, options: e.options };
        this.emitEvent({ type: "paused", reason: e.reason, options: e.options });
        break;
      case "done":
        this.pushMessage({ role: "assistant", text: e.summary });
        break;
    }
  }

  private requestApproval(command: string, reason: string): Promise<ApprovalDecision> {
    const id = crypto.randomBytes(6).toString("hex");
    return new Promise<ApprovalDecision>((resolve) => {
      this.approvals.set(id, { command, reason, resolve });
      this.emitEvent({ type: "approval", request: { id, command, reason } });
    });
  }

  // FR-3.5: when a run pauses on quota, offer a timed auto-resume.
  private scheduleAutoResume(job: ActiveJob): void {
    if (!getSettings().autoResumeAtQuotaReset) return;
    const resumeAt = job.waiting?.resumeAtMs;
    const delay = resumeAt && resumeAt > Date.now() ? resumeAt - Date.now() : 60_000;
    this.clearAutoResume();
    this.autoResumeTimer = setTimeout(() => {
      if (this.active === job && job.paused && !job.signal.cancelled) {
        job.paused = null;
        void this.run(job);
      }
    }, Math.min(delay + 2_000, 6 * 60 * 60_000));
  }

  private clearAutoResume(): void {
    if (this.autoResumeTimer) {
      clearTimeout(this.autoResumeTimer);
      this.autoResumeTimer = null;
    }
  }

  private pushMessage(m: ChatMessage): void {
    if (!this.active) return;
    this.active.messages.push(m);
    if (this.active.messages.length > MAX_MESSAGES) {
      this.active.messages.splice(0, this.active.messages.length - MAX_MESSAGES);
    }
    this.emitEvent({ type: "chat", message: m });
  }

  private emitEvent(e: JobEvent): void {
    this.deps.emit(e);
  }

  private myideDir(): string {
    return path.join(this.deps.workspaceRoot(), ".myide");
  }

  private currentJobFile(): string {
    return path.join(this.myideDir(), "current-job.json");
  }

  private writeTaskMd(brief: string): void {
    try {
      const dir = this.myideDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "task.md"), `# Task\n\n${brief}\n`, "utf8");
    } catch (e) {
      log.warn("jobs: could not write task.md", e);
    }
  }

  private writeCurrentJob(): void {
    const a = this.active;
    if (!a) return;
    try {
      const dir = this.myideDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = this.currentJobFile();
      const tmp = `${file}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({ brief: a.brief, kind: a.kind, mode: a.mode, startedAt: a.startedAt }, null, 2),
        "utf8",
      );
      fs.renameSync(tmp, file);
    } catch (e) {
      log.warn("jobs: could not write current-job.json", e);
    }
  }

  private clearCurrentJob(): void {
    try {
      const f = this.currentJobFile();
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* best effort */
    }
  }
}

interface ActiveJob {
  id: string;
  kind: JobKind;
  mode: JobMode;
  brief: string;
  startedAt: number;
  finishedAt: number | null;
  running: boolean;
  stages: StageEvent[];
  messages: ChatMessage[];
  plan: PlanStep[];
  paused: { reason: string; options: string[] } | null;
  waiting: { lane: string; resumeAtMs: number | null } | null;
  result: { score?: number; ok?: boolean; files?: string[] } | null;
  signal: { cancelled: boolean; note?: string };
  agentState?: AgentState;
}
