import fs from "fs";
import path from "path";
import crypto from "crypto";
import log from "electron-log";
import type { AIService } from "./ai/service";
import type { RouterLaneEvent } from "./ai/types";
import { formatLocalTime } from "./ai/router";
import { createAgentState, runAgent, type AgentEvent } from "./agent/loop";
import {
  findTool,
  type AgentState,
  type ApprovalDecision,
  type AskUserArgs,
  type AskUserToolResult,
  type ToolContext,
} from "./agent/tools";
import type { SuggestedFile } from "./agent/suggest";
import { runSingleShotWebsite } from "./pipeline/website-single-shot";
import { STARTER_FILES } from "./starter";
import { getSettings } from "./store";
import { SessionStore } from "./sessions";
import {
  ensureProjectWorkspace,
  isUsingDefaultRoot,
  workspaceRootPath,
  type WorkspaceInfo,
} from "./fs-workspace";
import { routeIntent, estimateRun, CLARIFY_OPTIONS, INTENT_LABELS } from "../shared/intent";
import { hop, newTraceId, note as traceNote } from "./trace";
import { finishRunTelemetry, startRunTelemetry, withRunTelemetry } from "./telemetry";
import { getRunFileDiff } from "./agent/checkpoints";
import type {
  ChangedFile,
  ChatAction,
  ChatEvent,
  ChatHistoryFile,
  ChatMessage,
  ChatSessionMeta,
  DetectedIntent,
  Intent,
  InterruptedRun,
  JobKind,
  JobMode,
  JobSnapshot,
  PlanStep,
  ProviderKeyId,
  RunEstimate,
  RunStats,
  StartInput,
  StageEvent,
  UserQuestionAnswerState,
  UserQuestionRequest,
  UserQuestionResponse,
} from "../shared/electron-api-types";

export interface JobManagerDeps {
  ai: AIService;
  workspaceRoot: () => string;
  emit: (e: ChatEvent) => void;
  onPreview: (workspacePath: string) => void;
  onOpenFile?: (workspacePath: string) => void;
  onWorkspaceChanged?: () => void;
  onAgentOutput?: (chunk: string) => void;
  onChooseWorkspace?: () => Promise<string | null>;
}

interface PendingApproval {
  command: string;
  reason: string;
  resolve: (d: ApprovalDecision) => void;
}

interface PendingUserQuestion {
  request: UserQuestionRequest;
  msgId: string;
  timer: NodeJS.Timeout | null;
  resolve: (r: AskUserToolResult) => void;
}

interface PendingQuestion {
  kind: "clarify" | "workspace";
  text: string;
  mode: JobMode;
  traceId: string;
}

const MAX_MESSAGES = 800;
// PART 1 #5: batch outgoing SSE deltas every ~50ms to prevent IPC flooding.
const STREAM_BATCH_MS = 50;

type DistributeOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
type ChatEventInput = DistributeOmit<ChatEvent, "runId"> & { runId?: string };

export class JobManager {
  private active: ActiveJob | null = null;
  private approvals = new Map<string, PendingApproval>();
  private userQuestions = new Map<string, PendingUserQuestion>();
  private autoResumeTimer: NodeJS.Timeout | null = null;

  private sessions = new SessionStore();
  private history: ChatMessage[] = [];
  private historyRoot = "";
  private sessionsInitialized = false;
  private pendingQuestion: PendingQuestion | null = null;
  private pendingSuggested: SuggestedFile[] = [];
  private lastTraceId = "----";

  // 50ms IPC streaming delta batcher state
  private streamMsgId: string | null = null;
  private streamBuffer = "";
  private streamFullText = "";
  private streamTimer: NodeJS.Timeout | null = null;

  constructor(private deps: JobManagerDeps) {
    this.deps.ai.onWaiting = (info) => {
      if (!this.active) return;
      this.active.waiting = info ? { lane: info.laneId, resumeAtMs: info.resumeAtMs } : null;
      this.emitEvent({
        type: "waiting",
        lane: info?.laneId ?? "",
        resumeAtMs: info?.resumeAtMs ?? null,
      });
    };

    if ("onLaneEvent" in this.deps.ai) {
      this.deps.ai.onLaneEvent = (ev: RouterLaneEvent) => this.handleRouterLaneEvent(ev);
    }
  }

  private handleRouterLaneEvent(ev: RouterLaneEvent): void {
    if (ev.type === "switch-lane") {
      this.pushMessage({
        role: "notice",
        text: `Switched from ${ev.fromLane?.id ?? "previous model"} to ${ev.toLane.id} (${ev.reason}).`,
        summaryLabel: `Switching to next model (${ev.toLane.model})…`,
        collapsible: true,
      });
    } else if (ev.type === "backoff") {
      this.pushMessage({
        role: "notice",
        text: `Rate limited / retrying ${ev.lane.id} (attempt ${ev.attempt}/${ev.maxRetries}, waiting ${(
          ev.delayMs / 1000
        ).toFixed(1)}s): ${ev.reason}`,
        summaryLabel: `Backing off on ${ev.lane.model} (${(ev.delayMs / 1000).toFixed(1)}s)…`,
        collapsible: true,
      });
    } else if (ev.type === "model-dead") {
      // PART 1 #2: surface suggested replacement slug as a one-click option, never an automatic silent swap.
      const actions: ChatAction[] = [];
      if (ev.suggestedModel && ev.lane.provider !== "offline") {
        actions.push({
          kind: "use-model",
          label: `Use suggested model (${ev.suggestedModel})`,
          value: JSON.stringify({
            provider: ev.lane.provider,
            oldModel: ev.lane.model,
            newModel: ev.suggestedModel,
          }),
          meta: {
            provider: ev.lane.provider as ProviderKeyId,
            oldModel: ev.lane.model,
            newModel: ev.suggestedModel,
          },
        });
      }
      actions.push({ kind: "edit-models", label: "Edit models" });
      this.pushMessage({
        role: "notice",
        text: ev.suggestedModel
          ? `Model \`${ev.lane.model}\` is unavailable for this session. Suggested replacement: \`${ev.suggestedModel}\`.`
          : `Model \`${ev.lane.model}\` is unavailable and marked dead for this session.`,
        summaryLabel: `Model unavailable: ${ev.lane.model} — moving to next lane…`,
        collapsible: !ev.suggestedModel,
        actions,
      });
    }
  }

  setWorkspaceRoot(root: string): void {
    void root;
  }

  // ---- read side ----------------------------------------------------------

  snapshot(): JobSnapshot | null {
    const a = this.active;
    this.ensureHistory();
    if (!a) return null;
    return {
      id: a.id,
      kind: a.kind,
      mode: a.mode,
      running: a.running,
      pausedRun: !!a.paused,
      brief: a.brief,
      intent: a.intent,
      detected: a.detected,
      estimate: a.estimate,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      stages: a.stages,
      messages: this.history,
      files: a.files,
      plan: a.plan,
      paused: a.paused,
      waiting: a.waiting,
      result: a.result,
      runStats: a.runStats ?? null,
    };
  }

  historyMessages(): ChatMessage[] {
    this.ensureHistory();
    return this.history;
  }

  // ---- Sessions API (PART 2) ----------------------------------------------

  listSessions(): { sessions: ChatSessionMeta[]; activeSessionId: string } {
    this.ensureHistory();
    return {
      sessions: this.sessions.list(),
      activeSessionId: this.sessions.activeSessionId(),
    };
  }

  switchSession(sessionId: string): { session: ChatSessionMeta; messages: ChatMessage[] } {
    this.ensureHistory();
    const res = this.sessions.switchSession(sessionId);
    if (!res) {
      return { session: this.sessions.activeMeta(), messages: this.history };
    }
    this.history = res.messages;
    this.saveWorkspaceChatMirror();
    this.emitEvent({ type: "history", messages: this.history, sessionId: res.session.id });
    this.emitSessionsList();
    return res;
  }

  deleteSession(sessionId: string): {
    sessions: ChatSessionMeta[];
    activeSessionId: string;
    messages: ChatMessage[];
  } {
    this.ensureHistory();
    const res = this.sessions.deleteSession(sessionId, this.deps.workspaceRoot());
    this.history = res.messages;
    this.saveWorkspaceChatMirror();
    this.emitEvent({ type: "history", messages: this.history, sessionId: res.activeSessionId });
    this.emitSessionsList();
    return res;
  }

  createSession(): { session: ChatSessionMeta; sessions: ChatSessionMeta[] } {
    this.ensureHistory();
    const session = this.sessions.createNew(this.deps.workspaceRoot(), []);
    this.history = [];
    this.pendingSuggested = [];
    this.pendingQuestion = null;
    this.saveWorkspaceChatMirror();
    this.emitEvent({ type: "history", messages: [], sessionId: session.id });
    const sessions = this.sessions.list();
    this.emitEvent({ type: "sessions", sessions, activeSessionId: session.id });
    return { session, sessions };
  }

  private emitSessionsList(): void {
    this.emitEvent({
      type: "sessions",
      sessions: this.sessions.list(),
      activeSessionId: this.sessions.activeSessionId(),
    });
  }

  pendingApprovals(): { id: string; command: string; reason: string }[] {
    return [...this.approvals.entries()].map(([id, p]) => ({ id, command: p.command, reason: p.reason }));
  }

  pendingQuestions(): UserQuestionRequest[] {
    return [...this.userQuestions.values()].map((q) => q.request);
  }

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

  // ---- commands -----------------------------------------------------------

  start(input: StartInput): JobSnapshot | null {
    if (this.active?.running) {
      throw new Error("A job is already running. Stop it before starting another.");
    }
    const text = (input.text ?? "").trim();
    const traceId = input.traceId || newTraceId();
    this.lastTraceId = traceId;
    this.ensureHistory();

    // Clear transient cooldowns when user explicitly starts/retries a run.
    this.deps.ai.clearCooldownsForRetry?.();

    hop("chat", traceId, 3, `main: handler received (${text.length} chars, mode=${input.mode})`);
    if (!text) throw new Error("Type what you want first.");

    this.pushMessage({ role: "user", text });

    if (!this.prepareWorkspace(text, input.mode, traceId)) {
      return null;
    }

    const detected: DetectedIntent =
      input.intent && input.intent !== "auto"
        ? { intent: input.intent, label: INTENT_LABELS[input.intent], confidence: "high", reason: "you picked it", matched: [] }
        : routeIntent(text);

    const freeSaver = getSettings().freeTierSaver !== false;
    if (input.intent === "auto" && detected.confidence === "low" && (!freeSaver || text.length < 12)) {
      this.pendingQuestion = { kind: "clarify", text, mode: input.mode, traceId };
      hop("chat", traceId, 4, `main: route unclear -> asking one question`);
      this.pushMessage({
        role: "assistant",
        text: `I am not sure what you want me to do with that. Pick one:`,
        actions: CLARIFY_OPTIONS.map((o) => ({ kind: o.kind, label: o.label, value: o.value })),
      });
      return null;
    }

    return this.beginRun(text, input.mode, detected, traceId);
  }

  answer(value: string): JobSnapshot | null {
    const pending = this.pendingQuestion;
    if (!pending) return null;
    this.pendingQuestion = null;

    if (pending.kind === "workspace") {
      if (value === "ws:choose") {
        void this.deps.onChooseWorkspace?.().then((picked) => {
          if (picked) {
            const info: WorkspaceInfo = { path: picked, created: false, isDefault: false };
            this.announceWorkspace(info);
          }
          void this.continueAfterWorkspace(pending);
        });
        return this.snapshot();
      }
      const info = ensureProjectWorkspace(pending.text);
      this.announceWorkspace(info);
      void this.continueAfterWorkspace(pending);
      return this.snapshot();
    }

    const intent = isIntent(value) ? value : "agent";
    const detected: DetectedIntent = {
      intent,
      label: INTENT_LABELS[intent],
      confidence: "high",
      reason: "you picked it",
      matched: [],
    };
    return this.beginRun(pending.text, pending.mode, detected, pending.traceId);
  }

  saveSuggested(): void {
    const files = this.pendingSuggested;
    if (!files.length) return;
    this.pendingSuggested = [];
    const root = this.deps.workspaceRoot();
    const changed: ChangedFile[] = [];
    for (const f of files) {
      try {
        const abs = path.join(root, f.path);
        const existed = fs.existsSync(abs);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, f.content, "utf8");
        const bytes = fs.statSync(abs).size;
        if (bytes <= 0) throw new Error("the file is empty on disk");
        changed.push({ path: f.path, change: existed ? "edited" : "created", bytes });
      } catch (e) {
        this.pushMessage({ role: "error", text: `Could not save ${f.path}: ${(e as Error).message}` });
      }
    }
    if (changed.length) {
      this.pushMessage({ role: "notice", text: `Saved ${changed.length} file(s) from the reply.`, files: changed });
      this.emitEvent({ type: "files", files: changed });
      this.autoOpen(changed);
      this.deps.onWorkspaceChanged?.();
    }
  }

  newChat(): void {
    this.createSession();
  }

  note(text: string): void {
    const value = text.trim();
    if (!value) return;
    this.pushMessage({ role: "user", text: value });
    if (this.active) this.active.signal.note = value;
  }

  // PART 1 #5: Stop immediately cancels in-flight HTTP/SSE/tool requests via AbortController.
  cancel(): void {
    if (!this.active) return;
    this.active.signal.cancelled = true;
    this.active.abortController.abort();
    this.flushStreamDelta(true);
    this.dismissAllUserQuestions("cancelled");
    this.clearAutoResume();
    this.emitEvent({ type: "status", phase: "idle" });
    this.pushMessage({ role: "notice", text: "Stopped." });
  }

  pause(): void {
    if (!this.active?.running) return;
    this.active.pauseRequested = true;
    this.active.signal.cancelled = true;
    this.active.abortController.abort();
    this.flushStreamDelta(true);
    this.clearAutoResume();
    this.pushMessage({ role: "notice", text: "Paused." });
  }

  async resume(): Promise<void> {
    this.deps.ai.clearCooldownsForRetry?.();
    const a = this.active;
    if (a) {
      if (!a.paused) return;
      a.paused = null;
      a.pauseRequested = false;
      a.signal.cancelled = false;
      a.abortController = new AbortController();
      this.clearAutoResume();
      await this.run(a);
      return;
    }
    const interrupted = this.interrupted();
    if (!interrupted) return;
    this.start({ text: interrupted.brief, mode: interrupted.mode, intent: "auto" });
  }

  respondApproval(id: string, decision: ApprovalDecision): void {
    const p = this.approvals.get(id);
    if (!p) return;
    this.approvals.delete(id);
    this.emitEvent({ type: "approval-resolved", id });
    p.resolve(decision);
  }

  // ---- PART 3: Popup questions (ask_user) ---------------------------------

  private askUserFromAgent(args: AskUserArgs, abortSignal: AbortSignal): Promise<AskUserToolResult> {
    const id = `q-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const timeoutSec = Math.max(0, Number(getSettings().askQuestionTimeoutSec ?? 120));
    const now = Date.now();
    const expiresAtMs = timeoutSec > 0 ? now + timeoutSec * 1000 : null;

    const request: UserQuestionRequest = {
      id,
      question: args.question,
      options: args.options,
      allowMultiple: args.allowMultiple,
      createdAt: now,
      expiresAtMs,
    };

    const msgId = this.pushMessage({
      role: "assistant",
      text: args.question,
      userQuestion: { ...request },
    });

    this.emitEvent({ type: "user-question", msgId, request });

    return new Promise<AskUserToolResult>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const onAbort = () => {
        this.finalizeUserQuestion(id, {
          selectedLabels: [],
          dismissed: true,
          answeredAt: Date.now(),
        });
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });

      const wrappedResolve = (res: AskUserToolResult) => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve(res);
      };

      if (expiresAtMs != null) {
        timer = setTimeout(() => {
          this.finalizeUserQuestion(id, {
            selectedLabels: [],
            dismissed: true,
            timedOut: true,
            answeredAt: Date.now(),
          });
        }, Math.max(100, expiresAtMs - Date.now()));
      }

      this.userQuestions.set(id, { request, msgId, timer, resolve: wrappedResolve });
    });
  }

  respondQuestion(response: UserQuestionResponse): void {
    const selectedLabels = Array.isArray(response.selectedLabels)
      ? response.selectedLabels.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const otherText = typeof response.otherText === "string" ? response.otherText.trim() : "";
    const dismissed = Boolean(response.dismissed) || (selectedLabels.length === 0 && !otherText);

    this.finalizeUserQuestion(response.id, {
      selectedLabels,
      otherText: otherText || undefined,
      dismissed,
      timedOut: Boolean(response.timedOut),
      answeredAt: Date.now(),
    });
  }

  private finalizeUserQuestion(id: string, answerState: UserQuestionAnswerState): void {
    const pending = this.userQuestions.get(id);
    if (!pending) return;
    this.userQuestions.delete(id);
    if (pending.timer) clearTimeout(pending.timer);

    // Update the question message in history so the question AND chosen answer stay permanently.
    const idx = this.history.findIndex((m) => m.id === pending.msgId);
    if (idx !== -1) {
      const existing = this.history[idx];
      const updated: ChatMessage = {
        ...existing,
        userQuestion: {
          ...(existing.userQuestion ?? pending.request),
          response: answerState,
        },
      };
      this.history[idx] = updated;
      this.saveHistory();
      this.emitEvent({ type: "message", msgId: updated.id, message: updated });
    }

    this.emitEvent({ type: "user-question-resolved", id, msgId: pending.msgId, response: answerState });

    pending.resolve({
      answered: !answerState.dismissed && !answerState.timedOut,
      selectedLabels: answerState.selectedLabels,
      otherText: answerState.otherText,
      dismissed: answerState.dismissed,
      timedOut: answerState.timedOut,
    });
  }

  private dismissAllUserQuestions(reason: "cancelled" | "dispose"): void {
    void reason;
    for (const id of [...this.userQuestions.keys()]) {
      this.finalizeUserQuestion(id, {
        selectedLabels: [],
        dismissed: true,
        answeredAt: Date.now(),
      });
    }
  }

  dispose(): void {
    this.clearAutoResume();
    this.flushStreamDelta(true);
    for (const [, p] of this.approvals) p.resolve("deny");
    this.approvals.clear();
    this.dismissAllUserQuestions("dispose");
  }

  // ---- Streaming 50ms IPC batcher -----------------------------------------

  private queueStreamDelta(delta: string): void {
    if (!delta) return;
    if (!this.streamMsgId) {
      this.streamMsgId = this.newMessageId();
      this.streamFullText = "";
      this.streamBuffer = "";
    }
    this.streamBuffer += delta;
    this.streamFullText += delta;
    if (!this.streamTimer) {
      this.streamTimer = setTimeout(() => {
        this.streamTimer = null;
        this.flushStreamBufferOnly();
      }, STREAM_BATCH_MS);
    }
  }

  private flushStreamBufferOnly(): void {
    if (!this.streamMsgId || !this.streamBuffer) return;
    const chunk = this.streamBuffer;
    this.streamBuffer = "";
    this.emitEvent({ type: "delta", msgId: this.streamMsgId, text: chunk });
  }

  private flushStreamDelta(discard = false): string | null {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    if (!discard) {
      this.flushStreamBufferOnly();
    }
    const usedId = this.streamMsgId;
    this.streamMsgId = null;
    this.streamBuffer = "";
    this.streamFullText = "";
    return usedId;
  }

  // ---- run ---------------------------------------------------------------

  private beginRun(text: string, mode: JobMode, detected: DetectedIntent, traceId: string): JobSnapshot {
    const intent = detected.intent;
    const kind: JobKind = intent === "website" ? "website" : "agent";
    const estimate = estimateRun(intent, mode);

    const job: ActiveJob = {
      id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
      kind,
      intent,
      detected,
      estimate,
      mode,
      brief: text,
      traceId,
      startedAt: Date.now(),
      finishedAt: null,
      running: true,
      stages: [],
      plan: [],
      files: [],
      paused: null,
      pauseRequested: false,
      waiting: null,
      result: null,
      signal: { cancelled: false },
      abortController: new AbortController(),
    };
    this.active = job;
    hop("chat", traceId, 4, `main: route chosen intent=${intent} pipeline=${kind} mode=${mode} (~${estimate.requests} requests)`);

    this.writeTaskMd(text);
    this.writeCurrentJob();

    if (this.deps.ai.isOfflineMode()) {
      this.pushMessage({
        role: "notice",
        text: "No provider key is set. I will use the built-in offline lane for now — add a key for real model output.",
        action: { kind: "settings", label: "Add an API key" },
      });
    }

    void this.run(job);
    return this.snapshot()!;
  }

  private async run(job: ActiveJob): Promise<void> {
    job.running = true;
    job.finishedAt = null;
    job.emittedTerminalError = false;
    const msgIndexBeforeRun = this.history.length;
    const telemetry = startRunTelemetry(job.id);
    this.emitEvent({ type: "status", phase: "thinking", label: "Thinking…" });
    try {
      await withRunTelemetry(telemetry, async () => {
        if (job.kind === "website") await this.runWebsite(job);
        else await this.runAgentJob(job);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("job failed", e);
      job.emittedTerminalError = true;
      this.pushMessage({
        role: "error",
        text: `The run failed: ${msg}`,
        actions: [
          { kind: "retry", label: "Retry now" },
          { kind: "edit-models", label: "Edit models" },
          { kind: "settings", label: "Add API key" },
        ],
      });
      this.emitEvent({ type: "error", text: msg });
    } finally {
      this.flushStreamDelta(true);
      job.running = false;
      job.finishedAt = Date.now();
      this.emitEvent({ type: "status", phase: "idle" });
      this.reportFiles(job);

      const failed = this.deps.ai.lastFailure;
      if (failed && job.files.length === 0 && !job.signal.cancelled && !job.emittedTerminalError) {
        this.pushMessage({
          role: "error",
          text: `The model failed: ${failed.message}`,
          action: { kind: "retry", label: "Try again" },
          actions: [
            { kind: "retry", label: "Retry now" },
            { kind: "edit-models", label: "Edit models" },
            { kind: "settings", label: "Add API key" },
          ],
        });
        this.emitEvent({ type: "error", text: failed.message });
      }
      if (job.pauseRequested) {
        job.paused = { reason: "Paused by you.", options: ["Resume", "Stop"] };
        this.pushMessage({
          role: "notice",
          text: "Paused. Press Resume to continue where it stopped.",
          action: { kind: "resume", label: "Resume" },
        });
      }

      const stats = finishRunTelemetry(job.id, true);
      if (stats) {
        job.runStats = stats;
        this.attachRunStats(msgIndexBeforeRun, stats);
        this.emitEvent({ type: "run-stats", stats });
      }

      if (!job.paused) this.clearCurrentJob();
      else this.scheduleAutoResume(job);
    }
  }

  private attachRunStats(startIdx: number, stats: RunStats): void {
    // Attach runStats to the final assistant/files-changed/error message of this run so
    // it renders inline at the bottom of the run AND persists in the session JSON.
    for (let i = this.history.length - 1; i >= startIdx; i--) {
      const m = this.history[i];
      if (!m.collapsible && (m.role === "assistant" || m.role === "notice" || m.role === "error")) {
        const updated: ChatMessage = { ...m, runStats: stats };
        this.appendOrUpdateMessage(updated);
        return;
      }
    }
    this.pushMessage({
      role: "notice",
      text: "Run completed.",
      runStats: stats,
    });
  }

  private async runWebsite(job: ActiveJob): Promise<void> {
    const root = this.deps.workspaceRoot();
    const state = createAgentState(root, job.id);
    job.agentState = state;
    hop("chat", job.traceId, 5, "main: writing starter template (index.html, css/style.css, js/main.js)");
    await this.seedStarter(job, state);

    const summary =
      getSettings().singleShotFileTags !== false
        ? await runSingleShotWebsite(this.deps.ai, state, {
            runId: job.id,
            brief: job.brief,
            signal: job.signal,
            abortController: job.abortController,
            onEvent: (e) => this.onAgentEvent(job, e),
            requestApproval: (command, reason) => this.requestApproval(command, reason),
            onPreview: (rel) => this.deps.onPreview(rel),
            onAgentOutput: (chunk) => this.deps.onAgentOutput?.(chunk),
            onSuggestedFiles: (files) => this.offerSuggested(files),
          })
        : await runAgent(this.deps.ai, state, {
            runId: job.id,
            taskMd: websiteBrief(job.brief),
            signal: job.signal,
            abortController: job.abortController,
            onEvent: (e) => this.onAgentEvent(job, e),
            requestApproval: (command, reason) => this.requestApproval(command, reason),
            askUser: (args) => this.askUserFromAgent(args, job.abortController.signal),
            onPreview: (rel) => this.deps.onPreview(rel),
            onAgentOutput: (chunk) => this.deps.onAgentOutput?.(chunk),
            onSuggestedFiles: (files) => this.offerSuggested(files),
          });
    job.plan = state.plan;
    this.emitEvent({ type: "done", summary });
  }

  private async runAgentJob(job: ActiveJob): Promise<void> {
    const root = this.deps.workspaceRoot();
    const state = createAgentState(root, job.id);
    job.agentState = state;
    const freeSaver = getSettings().freeTierSaver !== false;
    const isReadOnlyExplain =
      freeSaver &&
      job.intent !== "website" &&
      /^\s*(?:explain|what\b|why\b|how\b|describe\b|summarize\b|walk\s+me\s+through|help\s+me\s+understand)\b/i.test(
        job.brief,
      ) &&
      !/\b(?:fix|create|write|edit|rename|refactor|implement|add|delete|remove|update|change|modify|install|scaffold|generate)\b/i.test(
        job.brief,
      );
    const allowTools = job.intent !== "chat" && !isReadOnlyExplain;

    const summary = await runAgent(this.deps.ai, state, {
      runId: job.id,
      taskMd: job.brief,
      signal: job.signal,
      abortController: job.abortController,
      allowTools,
      onEvent: (e) => this.onAgentEvent(job, e),
      requestApproval: (command, reason) => this.requestApproval(command, reason),
      askUser: (args) => this.askUserFromAgent(args, job.abortController.signal),
      onPreview: (rel) => this.deps.onPreview(rel),
      onAgentOutput: (chunk) => this.deps.onAgentOutput?.(chunk),
      onSuggestedFiles: (files) => this.offerSuggested(files),
    });
    job.plan = state.plan;
    job.result = { ok: true, files: [...state.changedFiles.keys()] };
    this.emitEvent({ type: "done", summary });
  }

  private async seedStarter(job: ActiveJob, state: AgentState): Promise<void> {
    const tool = findTool("writeFile");
    if (!tool) return;
    const ctx: ToolContext = {
      state,
      requestApproval: (command, reason) => this.requestApproval(command, reason),
      onPreview: (rel) => this.deps.onPreview(rel),
      onAgentOutput: (chunk) => this.deps.onAgentOutput?.(chunk),
      signal: job.signal,
      abortSignal: job.abortController.signal,
    };
    for (const file of STARTER_FILES) {
      const abs = path.join(state.workspaceRoot, file.path);
      if (fs.existsSync(abs)) continue;
      const res = await tool.run({ path: file.path, content: file.content }, ctx);
      if (!res.ok) {
        this.pushMessage({ role: "error", text: `Could not create ${file.path}: ${res.output}` });
      }
    }
  }

  private onAgentEvent(job: ActiveJob, e: AgentEvent): void {
    switch (e.type) {
      case "stream-delta":
        this.queueStreamDelta(e.delta);
        break;
      case "assistant":
        hop("chat", job.traceId, 5, `main: first token (${e.model ?? "unknown lane"})`);
        this.emitEvent({ type: "status", phase: "thinking", lane: e.model, label: "Thinking…" });
        this.pushMessage({
          role: "notice",
          text: e.text,
          summaryLabel: e.text.length > 72 ? `${e.text.slice(0, 72)}…` : e.text,
          collapsible: true,
          model: e.model,
        });
        break;
      case "tool-start":
        this.emitEvent({ type: "status", phase: "thinking", label: e.summaryLabel });
        break;
      case "tool": {
        const msgId = this.newMessageId();
        hop("tool", job.traceId, 5, `tool ${e.name} ${e.ok ? "ok" : "failed"}`);
        const msg: ChatMessage = {
          id: msgId,
          role: "tool",
          ok: e.ok,
          toolName: e.name,
          toolArgs: e.args,
          summaryLabel: e.summaryLabel.replace(/…$/, "") + (e.ok ? " ✓" : " ✗"),
          collapsible: true,
          text: `${e.name} ${e.ok ? "✓" : "✗"}\n${e.output}`,
          ts: Date.now(),
        };
        this.appendMessage(msg);
        this.emitEvent({
          type: "tool",
          msgId,
          name: e.name,
          args: e.args,
          ok: e.ok,
          output: e.output,
          summaryLabel: msg.summaryLabel,
        });
        break;
      }
      case "plan":
        job.plan = e.steps;
        this.emitEvent({ type: "plan", steps: e.steps });
        break;
      case "notice":
        this.pushMessage({ role: "notice", text: e.text });
        break;
      case "auth-error": {
        job.emittedTerminalError = true;
        this.flushStreamDelta(true);
        this.pushMessage({
          role: "error",
          text: e.message,
          action: { kind: "settings", label: "Add API key" },
          actions: [
            { kind: "settings", label: "Check / Add API key" },
            { kind: "edit-models", label: "Edit models" },
          ],
        });
        this.emitEvent({ type: "error", text: e.message });
        break;
      }
      case "exhausted": {
        job.emittedTerminalError = true;
        this.flushStreamDelta(true);
        job.paused = { reason: e.reason, options: e.options };
        this.emitEvent({ type: "paused", reason: e.reason, options: e.options });

        const actions: ChatAction[] = [
          { kind: "retry", label: "Retry now" },
          { kind: "edit-models", label: "Edit models" },
          { kind: "settings", label: "Add API key" },
        ];
        // Also surface one-click "Use suggested model" if any dead lane carried a suggested slug.
        for (const d of e.laneDetails) {
          if (d.suggestedModel && (d.provider === "gemini" || d.provider === "openrouter" || d.provider === "groq")) {
            actions.unshift({
              kind: "use-model",
              label: `Use suggested model (${d.suggestedModel})`,
              value: JSON.stringify({
                provider: d.provider,
                oldModel: d.model,
                newModel: d.suggestedModel,
              }),
              meta: {
                provider: d.provider,
                oldModel: d.model,
                newModel: d.suggestedModel,
              },
            });
            break;
          }
        }

        const resumeLine = e.resumeAtMs
          ? `Estimated local resume time: **${formatLocalTime(e.resumeAtMs)}**`
          : "No automatic cooldown reset pending — check models or API keys.";

        this.pushMessage({
          role: "error",
          text: `All configured model lanes are exhausted.\n${resumeLine}`,
          laneDetails: e.laneDetails,
          resumeAtMs: e.resumeAtMs,
          action: actions[0],
          actions,
        });
        break;
      }
      case "paused":
        job.paused = { reason: e.reason, options: e.options };
        this.emitEvent({ type: "paused", reason: e.reason, options: e.options });
        this.pushMessage({
          role: "notice",
          text: e.reason,
          action: this.active?.waiting?.resumeAtMs
            ? { kind: "resume", label: `Resume at ${formatLocalTime(this.active.waiting.resumeAtMs)}` }
            : { kind: "resume", label: "Resume" },
        });
        break;
      case "done": {
        const streamedId = this.flushStreamDelta(false);
        this.emitEvent({ type: "status", phase: "idle" });
        if (streamedId) {
          const msg: ChatMessage = {
            id: streamedId,
            role: "assistant",
            text: e.summary,
            model: e.model,
            streaming: false,
            ts: Date.now(),
            visualReview: e.visualReview,
          };
          this.appendOrUpdateMessage(msg);
        } else {
          this.pushMessage({ role: "assistant", text: e.summary, model: e.model, visualReview: e.visualReview });
        }
        break;
      }
    }
  }

  private offerSuggested(files: SuggestedFile[]): void {
    this.pendingSuggested = files;
    this.pushMessage({
      role: "assistant",
      text: `The model answered with code as text, so nothing was written to disk yet. ${files.length} file(s) are ready to save.`,
      action: { kind: "save-files", label: `Save these ${files.length} files` },
    });
  }

  private requestApproval(command: string, reason: string): Promise<ApprovalDecision> {
    const id = crypto.randomBytes(6).toString("hex");
    return new Promise<ApprovalDecision>((resolve) => {
      this.approvals.set(id, { command, reason, resolve });
      this.emitEvent({ type: "approval", request: { id, command, reason } });
    });
  }

  // ---- files -------------------------------------------------------------

  private reportFiles(job: ActiveJob): void {
    const state = job.agentState;
    if (!state || state.changedFiles.size === 0) return;
    const files: ChangedFile[] = [];
    for (const [rel, change] of state.changedFiles) {
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(state.workspaceRoot, rel)).size;
      } catch {
        bytes = 0;
      }
      let addedLines: number | undefined;
      let removedLines: number | undefined;
      try {
        const diff = getRunFileDiff(state.workspaceRoot, job.id, rel);
        addedLines = diff.addedLines;
        removedLines = diff.removedLines;
      } catch {
        /* ignore */
      }
      files.push({ path: rel, change, bytes, runId: job.id, addedLines, removedLines });
    }
    job.files = files;
    this.pushMessage({ role: "notice", text: `Files changed (${files.length})`, files });
    this.emitEvent({ type: "files", files });
    this.autoOpen(files);
    this.deps.onWorkspaceChanged?.();
  }

  private autoOpen(files: ChangedFile[]): void {
    const html =
      files.find((f) => /(^|\/)index\.html$/i.test(f.path)) ?? files.find((f) => /\.html?$/i.test(f.path));
    if (!html) return;
    this.deps.onOpenFile?.(html.path);
    this.emitEvent({ type: "open-file", path: html.path });
    this.deps.onPreview(html.path);
    this.emitEvent({ type: "preview", path: html.path });
  }

  // ---- workspace ---------------------------------------------------------

  private prepareWorkspace(text: string, mode: JobMode, traceId: string): boolean {
    if (!isUsingDefaultRoot()) return true;
    if (getSettings().askWorkspaceEachTime) {
      this.pendingQuestion = { kind: "workspace", text, mode, traceId };
      this.pushMessage({
        role: "assistant",
        text: "No project folder is open. Where should I put the files?",
        actions: [
          { kind: "answer", label: "Use Documents/MyIDE-Projects", value: "ws:create" },
          { kind: "answer", label: "Choose a folder…", value: "ws:choose" },
        ],
      });
      return false;
    }
    const info = ensureProjectWorkspace(text);
    this.announceWorkspace(info);
    return true;
  }

  private announceWorkspace(info: WorkspaceInfo): void {
    this.emitEvent({ type: "workspace", path: info.path, created: info.created, isDefault: info.isDefault });
    this.pushMessage({
      role: "notice",
      text: `${info.created ? "Created" : "Using"} your project folder: ${info.path}`,
    });
  }

  // ---- messages ----------------------------------------------------------

  private pushMessage(m: Omit<ChatMessage, "id" | "ts">): string {
    const msg: ChatMessage = { ...m, id: this.newMessageId(), ts: Date.now() };
    this.appendMessage(msg);
    return msg.id;
  }

  private appendOrUpdateMessage(msg: ChatMessage): void {
    const idx = this.history.findIndex((x) => x.id === msg.id);
    if (idx === -1) {
      this.appendMessage(msg);
      return;
    }
    this.history[idx] = msg;
    this.saveHistory();
    hop("chat", this.active?.traceId ?? this.lastTraceId, 6, `main: event sent to window (${msg.role})`);
    this.emitEvent({ type: "message", msgId: msg.id, message: msg });
  }

  private appendMessage(msg: ChatMessage): void {
    this.history.push(msg);
    if (this.history.length > MAX_MESSAGES) {
      this.history.splice(0, this.history.length - MAX_MESSAGES);
    }
    this.saveHistory();
    hop("chat", this.active?.traceId ?? this.lastTraceId, 6, `main: event sent to window (${msg.role})`);
    this.emitEvent({ type: "message", msgId: msg.id, message: msg });
  }

  private newMessageId(): string {
    return `m-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  }

  private emitEvent(e: ChatEventInput): void {
    const runId = e.runId ?? this.active?.id ?? "system";
    this.deps.emit({ ...e, runId } as ChatEvent);
  }

  // ---- history & session storage -----------------------------------------

  private ensureHistory(): void {
    const root = this.deps.workspaceRoot();
    if (this.sessionsInitialized && root === this.historyRoot) return;
    this.historyRoot = root;

    let legacyMessages: ChatMessage[] = [];
    try {
      const f = this.historyFile();
      if (fs.existsSync(f)) {
        const parsed = JSON.parse(fs.readFileSync(f, "utf8")) as ChatHistoryFile;
        if (Array.isArray(parsed?.messages)) legacyMessages = parsed.messages.filter(isMessage);
      }
    } catch (e) {
      log.warn("jobs: could not read legacy workspace chat history", e);
    }

    this.sessions.init(root, legacyMessages);
    this.history = [...this.sessions.messages()];
    this.sessionsInitialized = true;
  }

  private saveHistory(): void {
    this.sessions.setMessages(this.history, this.historyRoot || this.deps.workspaceRoot());
    this.saveWorkspaceChatMirror();
    this.emitSessionsList();
  }

  private saveWorkspaceChatMirror(): void {
    if (!this.historyRoot) return;
    try {
      const dir = this.myideDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = this.historyFile();
      const tmp = `${file}.tmp`;
      const body: ChatHistoryFile = { version: 1, updatedAt: Date.now(), messages: this.history };
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2), "utf8");
      fs.renameSync(tmp, file);
    } catch (e) {
      log.warn("jobs: could not write workspace chat mirror", e);
    }
  }

  private historyFile(): string {
    return path.join(this.myideDir(), "chat.json");
  }

  private myideDir(): string {
    return path.join(this.historyRoot || workspaceRootPath(), ".myide");
  }

  // ---- misc --------------------------------------------------------------

  private scheduleAutoResume(job: ActiveJob): void {
    if (!getSettings().autoResumeAtQuotaReset) return;
    const resumeAt = job.waiting?.resumeAtMs;
    if (!resumeAt) return;
    const delay = resumeAt > Date.now() ? resumeAt - Date.now() : 60_000;
    this.clearAutoResume();
    this.autoResumeTimer = setTimeout(() => {
      if (this.active === job && job.paused && !job.signal.cancelled) {
        job.paused = null;
        job.abortController = new AbortController();
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

  private currentJobFile(): string {
    return path.join(path.join(this.deps.workspaceRoot(), ".myide"), "current-job.json");
  }

  private writeTaskMd(brief: string): void {
    try {
      const dir = path.join(this.deps.workspaceRoot(), ".myide");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "task.md"), `# Task\n\n${brief}\n`, "utf8");
      traceNote("chat", this.active?.traceId ?? "----", `task.md written for "${brief.slice(0, 40)}"`);
    } catch (e) {
      log.warn("jobs: could not write task.md", e);
    }
  }

  private writeCurrentJob(): void {
    const a = this.active;
    if (!a) return;
    try {
      const dir = path.join(this.deps.workspaceRoot(), ".myide");
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

  private async continueAfterWorkspace(pending: PendingQuestion): Promise<void> {
    const detected = routeIntent(pending.text);
    if (detected.confidence === "low") {
      this.pendingQuestion = { ...pending, kind: "clarify" };
      this.pushMessage({
        role: "assistant",
        text: "I am not sure what you want me to do with that. Pick one:",
        actions: CLARIFY_OPTIONS.map((o) => ({ kind: o.kind, label: o.label, value: o.value })),
      });
      return;
    }
    this.beginRun(pending.text, pending.mode, detected, pending.traceId);
  }
}

interface ActiveJob {
  id: string;
  kind: JobKind;
  intent: Intent;
  detected: DetectedIntent;
  estimate: RunEstimate;
  mode: JobMode;
  brief: string;
  traceId: string;
  startedAt: number;
  finishedAt: number | null;
  running: boolean;
  stages: StageEvent[];
  plan: PlanStep[];
  files: ChangedFile[];
  paused: { reason: string; options: string[] } | null;
  pauseRequested: boolean;
  waiting: { lane: string; resumeAtMs: number | null } | null;
  result: { score?: number; ok?: boolean; files?: string[] } | null;
  signal: { cancelled: boolean; note?: string };
  abortController: AbortController;
  agentState?: AgentState;
  emittedTerminalError?: boolean;
  runStats?: RunStats | null;
}

function websiteBrief(brief: string): string {
  return [
    brief,
    "",
    "A starter page is already on disk at index.html, css/style.css and js/main.js.",
    "Improve it to match the request above using the writeFile and editFile tools.",
    "Rules: the page must be responsive and accessible, and every piece of content must be",
    "visible by default (no animation required to read it). Do not paste file contents in your reply.",
    "When you are done, call verifyWebsite on index.html, then markComplete.",
  ].join("\n");
}

function isIntent(value: string): value is Intent {
  return ["website", "video", "3d", "agent", "chat"].includes(value);
}

function isMessage(value: unknown): value is ChatMessage {
  const m = value as ChatMessage;
  return !!m && typeof m.id === "string" && typeof m.text === "string" && typeof m.role === "string";
}
