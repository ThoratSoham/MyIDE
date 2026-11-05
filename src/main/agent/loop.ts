import fs from "fs";
import path from "path";
import log from "electron-log";
import type { AIService } from "../ai/service";
import type { LaneExhaustedDetail, Message } from "../ai/types";
import type { VisualReviewSummary } from "../../shared/electron-api-types";
import { formatLocalTime } from "../ai/router";
import { estimateTokens } from "../ai/tokenize";
import { parseJsonLoose } from "../quality/json-repair";
import { validateSchema } from "../quality/schema";
import { buildRetrievedContextBlock } from "../context/bm25";
import { assembleTurnMessages } from "../context/budget";
import { buildRepoMap, invalidateRepoMapCache } from "../context/repo-map";
import { compressConversationHistory, createWorkingMemory } from "../context/working-memory";
import { getSettings } from "../store";
import { currentTelemetry } from "../telemetry";
import { runAutoVerifyAfterWrites } from "./auto-verify";
import { applyParsedFileTags, parseFileTags } from "./file-tags";
import { parseSuggestedFiles, type SuggestedFile } from "./suggest";
import {
  clip,
  describeToolCall,
  findTool,
  hashText,
  loadAllowedCommands,
  toolsForPrompt,
  type AgentState,
  type ApprovalDecision,
  type AskUserArgs,
  type AskUserToolResult,
  type PlanStep,
} from "./tools";

export type AgentEvent =
  | { type: "assistant"; text: string; model?: string }
  | { type: "stream-delta"; delta: string }
  | { type: "tool-start"; name: string; args: unknown; summaryLabel: string }
  | { type: "tool"; name: string; args: unknown; ok: boolean; output: string; summaryLabel: string }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "notice"; text: string }
  | { type: "auth-error"; message: string; provider?: string }
  | {
      type: "exhausted";
      reason: string;
      laneDetails: LaneExhaustedDetail[];
      resumeAtMs: number | null;
      options: string[];
    }
  | { type: "paused"; reason: string; options: string[] }
  | { type: "done"; summary: string; model?: string; visualReview?: VisualReviewSummary };

export interface AgentOptions {
  taskMd: string;
  signal: { cancelled: boolean; note?: string };
  abortController?: AbortController;
  onEvent: (e: AgentEvent) => void;
  requestApproval: (command: string, reason: string) => Promise<ApprovalDecision>;
  askUser?: (args: AskUserArgs) => Promise<AskUserToolResult>;
  onPreview?: (rel: string) => void;
  onAgentOutput?: (chunk: string) => void;
  allowTools?: boolean;
  onSuggestedFiles?: (files: SuggestedFile[]) => void;
  maxSteps?: number;
  tokenBudget?: number;
  runId?: string;
}

export type RunStatus = "running" | "paused" | "completed" | "stopped" | "failed";

export interface SavedRun {
  runId: string;
  workspaceRoot: string;
  status: RunStatus;
  startedAt: number;
  updatedAt: number;
  steps: number;
  taskMd?: string;
  pauseReason?: string;
  plan: PlanStep[];
  changedHtml: string[];
  history: Message[];
}

export interface SavedRunSummary {
  runId: string;
  workspaceRoot: string;
  status: RunStatus;
  startedAt: number;
  updatedAt: number;
  steps: number;
  taskMd?: string;
  pauseReason?: string;
}

interface ActiveRunEntry {
  runId: string;
  workspaceRoot: string;
  startedAt: number;
  taskMd: string;
  state: AgentState;
  getSteps: () => number;
  getHistory: () => Message[];
  signal: { cancelled: boolean; note?: string };
  abortController: AbortController;
}

const activeRuns = new Map<string, ActiveRunEntry>();
let lastKnownWorkspaceRoot = "";

const MAX_STEPS = 40;
const MAX_CONSECUTIVE_ERRORS = 4;
const KEEP_RECENT_MESSAGES = 6;
const DEFAULT_TOKEN_BUDGET = 4_800;
const MAX_TOOL_HISTORY_CHARS = 4_000;
const OLD_RESULT_CHARS = 240;
export const MAX_BATCH_ACTIONS = 8;

const READ_ONLY_TOOLS = new Set(["readFile", "listDir", "listTree", "grep", "getSymbols"]);

interface ActionSpec {
  tool: string;
  args?: Record<string, unknown>;
}

interface AgentTurnEnvelope {
  thought?: string;
  tool?: string;
  args?: Record<string, unknown>;
  actions?: ActionSpec[];
  answer?: string;
}

const ACTION_ITEM_SCHEMA = {
  type: "object",
  required: ["tool"],
  properties: {
    tool: { type: "string", minLength: 1 },
    args: { type: "object" },
  },
};

const AGENT_SCHEMA = {
  type: "object",
  required: ["thought"],
  properties: {
    thought: { type: "string" },
    tool: { type: "string" },
    args: { type: "object" },
    actions: {
      type: "array",
      minItems: 1,
      items: ACTION_ITEM_SCHEMA,
    },
    answer: { type: "string" },
  },
};

// Cache static system prompts per (workspaceRoot, allowTools) so we never rebuild
// static context repeatedly and prefix prompt caching remains stable across turns.
const staticSystemPromptCache = new Map<string, string>();

export function createAgentState(workspaceRoot: string, runId?: string): AgentState {
  lastKnownWorkspaceRoot = workspaceRoot;
  const myideDir = path.join(workspaceRoot, ".myide");
  fs.mkdirSync(myideDir, { recursive: true });
  for (const d of ["runs", "build", "verify", "cache", "trash", "backups"]) {
    fs.mkdirSync(path.join(myideDir, d), { recursive: true });
  }
  return {
    workspaceRoot,
    myideDir,
    runId,
    allowedCommands: loadAllowedCommands(myideDir),
    changedHtml: new Set(),
    changedFiles: new Map(),
    verifyPassedSinceChange: true,
    lastVerify: null,
    plan: [],
  };
}

// ---------------------------------------------------------------------------
// PART 1 #6: Run management exports (loadRun, getRun, listRuns, interruptedRuns, stopRun)
// ---------------------------------------------------------------------------

function resolveRunsDir(workspaceRoot?: string): string | null {
  const root = workspaceRoot || lastKnownWorkspaceRoot || (globalThis as any).__MYIDE_WORKSPACE_ROOT__ || "";
  if (!root) return null;
  const dir = path.join(root, ".myide", "runs");
  return fs.existsSync(dir) ? dir : null;
}

export function loadRun(workspaceRootOrFile: string, runId?: string): SavedRun | null {
  try {
    let filePath: string;
    if (!runId && workspaceRootOrFile.endsWith(".json") && fs.existsSync(workspaceRootOrFile)) {
      filePath = workspaceRootOrFile;
    } else if (runId) {
      filePath = path.join(workspaceRootOrFile, ".myide", "runs", `${runId}.json`);
    } else {
      const dir = resolveRunsDir();
      if (!dir) return null;
      filePath = path.join(dir, `${workspaceRootOrFile}.json`);
    }
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<SavedRun>;
    if (!raw || typeof raw.runId !== "string") return null;
    return {
      runId: raw.runId,
      workspaceRoot: raw.workspaceRoot ?? (runId ? workspaceRootOrFile : lastKnownWorkspaceRoot),
      status: raw.status ?? "paused",
      startedAt: raw.startedAt ?? raw.updatedAt ?? Date.now(),
      updatedAt: raw.updatedAt ?? Date.now(),
      steps: raw.steps ?? 0,
      taskMd: raw.taskMd,
      pauseReason: raw.pauseReason,
      plan: Array.isArray(raw.plan) ? raw.plan : [],
      changedHtml: Array.isArray(raw.changedHtml) ? raw.changedHtml : [],
      history: Array.isArray(raw.history) ? raw.history : [],
    };
  } catch (e) {
    log.warn("agent: loadRun failed", e);
    return null;
  }
}

export function getRun(runId: string, workspaceRoot?: string): SavedRun | null {
  const active = activeRuns.get(runId);
  if (active) {
    return {
      runId: active.runId,
      workspaceRoot: active.workspaceRoot,
      status: "running",
      startedAt: active.startedAt,
      updatedAt: Date.now(),
      steps: active.getSteps(),
      taskMd: active.taskMd,
      plan: [...active.state.plan],
      changedHtml: [...active.state.changedHtml],
      history: [...active.getHistory()],
    };
  }
  const root = workspaceRoot || lastKnownWorkspaceRoot || (globalThis as any).__MYIDE_WORKSPACE_ROOT__ || "";
  if (!root) return null;
  return loadRun(root, runId);
}

export function listRuns(workspaceRoot?: string): SavedRunSummary[] {
  const byId = new Map<string, SavedRunSummary>();

  for (const active of activeRuns.values()) {
    if (workspaceRoot && path.resolve(active.workspaceRoot) !== path.resolve(workspaceRoot)) continue;
    byId.set(active.runId, {
      runId: active.runId,
      workspaceRoot: active.workspaceRoot,
      status: "running",
      startedAt: active.startedAt,
      updatedAt: Date.now(),
      steps: active.getSteps(),
      taskMd: active.taskMd,
    });
  }

  const dir = resolveRunsDir(workspaceRoot);
  if (dir) {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const loaded = loadRun(path.join(dir, file));
        if (loaded && !byId.has(loaded.runId)) {
          byId.set(loaded.runId, {
            runId: loaded.runId,
            workspaceRoot: loaded.workspaceRoot,
            status: loaded.status,
            startedAt: loaded.startedAt,
            updatedAt: loaded.updatedAt,
            steps: loaded.steps,
            taskMd: loaded.taskMd,
            pauseReason: loaded.pauseReason,
          });
        }
      }
    } catch (e) {
      log.warn("agent: listRuns failed", e);
    }
  }

  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function interruptedRuns(workspaceRoot?: string): SavedRunSummary[] {
  return listRuns(workspaceRoot).filter(
    (r) => !activeRuns.has(r.runId) && (r.status === "running" || r.status === "paused"),
  );
}

export function stopRun(runId?: string): boolean {
  if (runId) {
    const entry = activeRuns.get(runId);
    if (!entry) return false;
    entry.signal.cancelled = true;
    entry.abortController.abort();
    return true;
  }
  if (activeRuns.size === 0) return false;
  for (const entry of activeRuns.values()) {
    entry.signal.cancelled = true;
    entry.abortController.abort();
  }
  return true;
}

// ---------------------------------------------------------------------------
// Agent execution loop
// ---------------------------------------------------------------------------

/**
 * Extract progressively streamed display text from an incremental model output.
 * Handles both structured JSON `{"thought":"...","answer":"..."}` and plain markdown.
 */
export function extractStreamingPreview(raw: string, allowTools: boolean): string {
  const trimmed = raw.trimStart();
  if (!trimmed) return "";
  if (!trimmed.startsWith("{")) return raw;

  // Prefer extracting the incremental "answer" value once it starts streaming.
  const ansMatch = /"answer"\s*:\s*"((?:\\.|[^"\\])*)/.exec(trimmed);
  if (ansMatch) {
    return unescapeJsonFragment(ansMatch[1]);
  }
  // In chat-only mode, don't flash "thought" into the main answer bubble before "answer" arrives.
  if (!allowTools) return "";
  return "";
}

function unescapeJsonFragment(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

export async function runAgent(ai: AIService, state: AgentState, opts: AgentOptions): Promise<string> {
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const allowTools = opts.allowTools !== false;
  const tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const runId = opts.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  state.runId = runId;
  const startedAt = Date.now();
  const abortController = opts.abortController ?? new AbortController();

  let steps = 0;
  let consecutiveErrors = 0;
  let nudged = false;
  let loopRecovered = false;
  let lastTurnHadFailure = false;
  const recent: string[] = [];
  const workingMemory = createWorkingMemory(opts.taskMd || "");

  let history: Message[] = [
    { role: "system", content: systemPrompt(state, allowTools) },
    { role: "user", content: opts.taskMd || "Start the job." },
  ];

  activeRuns.set(runId, {
    runId,
    workspaceRoot: state.workspaceRoot,
    startedAt,
    taskMd: opts.taskMd,
    state,
    getSteps: () => steps,
    getHistory: () => history,
    signal: opts.signal,
    abortController,
  });

  try {
    saveRun(state, runId, history, steps, "running", startedAt, opts.taskMd);

    while (steps < maxSteps) {
      if (opts.signal.cancelled || abortController.signal.aborted) {
        saveRun(state, runId, history, steps, "stopped", startedAt, opts.taskMd);
        return "Stopped by the user.";
      }

      if (opts.signal.note) {
        history.push({ role: "user", content: `Note from the user: ${opts.signal.note}` });
        opts.signal.note = undefined;
      }

      const settings = getSettings();
      const freeSaver = settings.freeTierSaver !== false;
      const ledger = allowTools ? progressLedger(state, freeSaver) : "";
      const repoMapBlock =
        allowTools && settings.repoMapEnabled !== false
          ? buildRepoMap({
              workspaceRoot: state.workspaceRoot,
              query: opts.taskMd,
              changedFiles: [...state.changedFiles.keys()],
              maxTokens: 1_200,
            })
          : "";
      const retrievedContextBlock =
        settings.repoMapEnabled !== false &&
        steps === 0 &&
        state.changedFiles.size === 0 &&
        (allowTools || freeSaver || /@[A-Za-z0-9_./\\-]+/.test(opts.taskMd))
          ? buildRetrievedContextBlock(state.workspaceRoot, opts.taskMd, {
              maxChunks: 6,
              maxTokens: 1_400,
            })
          : "";

      const compressed =
        settings.rollingSummaryEnabled !== false
          ? await compressConversationHistory(history, workingMemory, {
              tokenBudget,
              keepRecentMessages: KEEP_RECENT_MESSAGES,
              rollingSummaryEnabled: true,
            })
          : { messages: compactHistoryToBudget(history, tokenBudget), workingMemoryBlock: "", evictedCount: 0 };

      // Assemble prompt while keeping messages[0] byte-identical for provider prompt-cache hits.
      const messages: Message[] = assembleTurnMessages({
        baseMessages: compressed.messages,
        repoMapBlock,
        retrievedContextBlock,
        progressLedgerBlock: ledger,
        maxInputTokens: tokenBudget + 1_600,
      });

      let rawStreamed = "";
      let emittedPreviewLen = 0;

      const taskClass = !allowTools ? "chat" : lastTurnHadFailure ? "repair" : "codegen";
      const promptChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
      const res = await ai.complete(taskClass, messages, {
        schema: AGENT_SCHEMA,
        expectedOutputTokens: 900,
        signal: abortController.signal,
        cacheStaticPrefix: true,
        onDelta: (chunk) => {
          rawStreamed += chunk;
          const preview = extractStreamingPreview(rawStreamed, allowTools);
          if (preview.length > emittedPreviewLen) {
            const nextSlice = preview.slice(emittedPreviewLen);
            emittedPreviewLen = preview.length;
            opts.onEvent({ type: "stream-delta", delta: nextSlice });
          }
        },
      });

      if (res.ok) {
        const resWithCompletion = res as typeof res & { completionTokens?: number };
        const realInTok =
          res.promptTokens && res.promptTokens > 15 ? res.promptTokens : Math.ceil(promptChars / 3.5);
        const realOutTok =
          resWithCompletion.completionTokens && resWithCompletion.completionTokens > 15
            ? resWithCompletion.completionTokens
            : Math.ceil((res.content ?? "").length / 3.5);
        currentTelemetry()?.recordModelCall({
          inputTokens: realInTok,
          outputTokens: realOutTok,
          promptChars,
          completionChars: (res.content ?? "").length,
        });
      }

      if (res.cancelled || opts.signal.cancelled || abortController.signal.aborted) {
        saveRun(state, runId, history, steps, "stopped", startedAt, opts.taskMd);
        return "Stopped by the user.";
      }

      if (!res.ok) {
        // 401 / 403 -> Stop immediately and show "check your API key" (never loop/retry).
        if (res.authStop || res.error?.kind === "unauthorized") {
          const authMsg = res.error?.message || "Authentication failed — check your API key.";
          opts.onEvent({ type: "auth-error", message: authMsg, provider: res.laneUsed?.provider });
          saveRun(state, runId, history, steps, "failed", startedAt, opts.taskMd, authMsg);
          return `Authentication error: ${authMsg}`;
        }

        // All lanes exhausted -> surface per-lane reasons, local-time resume estimate, and 3 actions.
        if (res.allExhausted || res.pause) {
          const details = res.laneDetails ?? [];
          const resumeMs = res.resumeAtMs ?? null;
          const localTimeText = resumeMs ? formatLocalTime(resumeMs) : "no automatic reset (edit models or add key)";
          const reasonLines = details.length
            ? details.map((d) => `• ${d.laneId}: ${d.reason}`).join("\n")
            : res.error?.message || "All configured lanes are currently unavailable.";
          const fullReason = `All model lanes exhausted. Estimated resume: ${localTimeText}.\n${reasonLines}`;

          opts.onEvent({
            type: "exhausted",
            reason: fullReason,
            laneDetails: details,
            resumeAtMs: resumeMs,
            options: ["Retry now", "Edit models", "Add API key"],
          });
          saveRun(state, runId, history, steps, "paused", startedAt, opts.taskMd, fullReason);
          return `Paused: ${fullReason}`;
        }

        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          return pause(state, runId, history, opts, startedAt, `The model failed ${consecutiveErrors} times in a row.`);
        }
        history.push({ role: "user", content: "That request failed. Try again with a smaller, simpler step." });
        steps++;
        continue;
      }

      const parsed = parseJsonLoose(res.content ?? "");
      const schemaOk = parsed.ok && validateSchema(AGENT_SCHEMA, parsed.value).length === 0;
      let value = schemaOk ? (parsed.value as AgentTurnEnvelope) : null;

      // PHASE 2A: If singleShotFileTags is enabled and the model emitted `<file path="...">` blocks
      // (either directly as raw text or inside `answer`), apply them safely to the workspace.
      const fileTagsEnabled = getSettings().singleShotFileTags !== false;
      const inlineFileTags =
        allowTools && fileTagsEnabled
          ? parseFileTags(!value ? (res.content ?? "") : !value.tool && !value.actions ? (value.answer ?? "") : "")
          : [];

      if (inlineFileTags.length > 0) {
        const writeSummary = await applyParsedFileTags(
          inlineFileTags,
          state,
          {
            requestApproval: opts.requestApproval,
            askUser: opts.askUser,
            onPreview: opts.onPreview,
            onAgentOutput: opts.onAgentOutput,
            signal: opts.signal,
            abortSignal: abortController.signal,
          },
          (info) => {
            currentTelemetry()?.recordToolCall();
            opts.onEvent({
              type: "tool",
              name: "writeFile",
              args: { path: info.path },
              ok: info.ok,
              output: info.output,
              summaryLabel: `Writing ${info.path}`,
            });
          },
        );

        const writtenPaths = writeSummary.written.map((w) => w.path);
        const autoVerifyEnabled = getSettings().autoVerifyAfterEdits !== false;
        const autoRes =
          autoVerifyEnabled && writtenPaths.length > 0
            ? await runAutoVerifyAfterWrites(state, writtenPaths)
            : null;

        if (writeSummary.errors.length > 0 || (autoRes && !autoRes.ok)) {
          const errMsg = [
            ...writeSummary.errors.map((e) => `${e.path}: ${e.error}`),
            ...(autoRes && !autoRes.ok ? [autoRes.formattedFeedback] : []),
          ].join("\n");
          history.push({ role: "assistant", content: `Wrote ${writtenPaths.join(", ")}` });
          history.push({ role: "user", content: `<tool_results>\n${errMsg}\n</tool_results>` });
          steps++;
          continue;
        }

        const doneSummary = `Wrote ${writtenPaths.join(", ")}.`;
        saveRun(state, runId, history, steps, "completed", startedAt, opts.taskMd);
        opts.onEvent({ type: "done", summary: doneSummary, model: res.laneUsed?.id });
        return doneSummary;
      }

      let typedCode: SuggestedFile[] = [];
      if (!value && allowTools && state.changedFiles.size === 0) {
        typedCode = parseSuggestedFiles(res.content ?? "");
        if (typedCode.length > 0) value = { thought: (res.content ?? "").trim(), answer: res.content ?? "" };
      }

      // In chat-only mode, if a model replies in plain markdown instead of JSON, accept it directly.
      if (!value && !allowTools && (res.content ?? "").trim()) {
        const plain = (res.content ?? "").trim();
        value = { thought: "", answer: plain };
      }

      if (!value) {
        consecutiveErrors++;
        history.push({
          role: "assistant",
          content: (res.content ?? "").slice(0, 600),
        });
        history.push({
          role: "user",
          content:
            "That was not valid JSON for the agreed shape. Reply with ONLY minified JSON: " +
            `{"thought":"...","actions":[{"tool":"...","args":{...}}]}, {"thought":"...","tool":"...","args":{...}}, or {"thought":"...","answer":"..."}.`,
        });
        steps++;
        continue;
      }
      consecutiveErrors = 0;

      if (value.thought) opts.onEvent({ type: "assistant", text: value.thought, model: res.laneUsed?.id });

      const batchEnabled = getSettings().batchedActions !== false;
      const rawBatch: ActionSpec[] =
        Array.isArray(value.actions) && value.actions.length > 0
          ? batchEnabled
            ? value.actions
            : [value.actions[0]]
          : value.tool
          ? [{ tool: value.tool, args: value.args }]
          : [];

      if (rawBatch.length === 0) {
        const reply = (value.answer ?? value.thought ?? "").trim();
        const freshWork = allowTools && state.changedFiles.size === 0;
        const suggested = typedCode.length > 0 ? typedCode : freshWork ? parseSuggestedFiles(reply) : [];

        if (freshWork && !nudged) {
          nudged = true;
          history.push({ role: "assistant", content: JSON.stringify(value).slice(0, 600) });
          history.push({
            role: "user",
            content: suggested.length
              ? "You answered with code as plain text, so NO file was created. Use writeFile now (batching all files in actions) " +
                "and do not paste the code in your reply."
              : "You replied with text only. If this job needs files to change, call a tool now (start with listDir). " +
                "If it really is a question, answer it directly with the 'answer' field.",
          });
          steps++;
          continue;
        }

        if (suggested.length) {
          opts.onSuggestedFiles?.(suggested);
          opts.onEvent({
            type: "notice",
            text: `The model answered with code as text, so no file was created. ${suggested.length} file(s) are ready to save.`,
          });
        }

        const summary = value.answer || value.thought || "Done.";
        saveRun(state, runId, history, steps, "completed", startedAt, opts.taskMd);
        opts.onEvent({ type: "done", summary, model: res.laneUsed?.id });
        return summary;
      }

      if (!allowTools) {
        history.push({ role: "assistant", content: JSON.stringify(value).slice(0, 600) });
        history.push({
          role: "user",
          content:
            'This is a chat-only request and tools are disabled. Do not call a tool. Reply with exactly ' +
            '{"thought":"...","answer":"..."}.',
        });
        steps++;
        continue;
      }

      const cappedBatch = rawBatch.slice(0, MAX_BATCH_ACTIONS);
      const overflowCount = Math.max(0, rawBatch.length - cappedBatch.length);
      const isSingleLegacyCall = !Array.isArray(value.actions) && cappedBatch.length === 1;

      interface ExecutedActionRecord {
        tool: string;
        args: Record<string, unknown>;
        ok: boolean;
        output: string;
        complete?: boolean;
      }

      const executed: ExecutedActionRecord[] = [];
      let stoppedAtIndex = -1;
      const toolCtx = {
        state,
        requestApproval: opts.requestApproval,
        askUser: opts.askUser,
        onPreview: opts.onPreview,
        onAgentOutput: opts.onAgentOutput,
        signal: opts.signal,
        abortSignal: abortController.signal,
      };

      let idx = 0;
      while (idx < cappedBatch.length) {
        if (opts.signal.cancelled || abortController.signal.aborted) {
          saveRun(state, runId, history, steps, "stopped", startedAt, opts.taskMd);
          return "Stopped by the user.";
        }

        const current = cappedBatch[idx];
        const firstTool = findTool(current.tool);

        // Contiguous independent read-only actions run in parallel via Promise.all.
        if (firstTool && READ_ONLY_TOOLS.has(current.tool)) {
          const parallelSlice: Array<{ spec: ActionSpec; toolDef: NonNullable<ReturnType<typeof findTool>>; summaryLabel: string }> = [];
          while (idx < cappedBatch.length) {
            const candidate = cappedBatch[idx];
            const td = findTool(candidate.tool);
            if (!td || !READ_ONLY_TOOLS.has(candidate.tool)) break;
            const summaryLabel = describeToolCall(td.name, candidate.args);
            opts.onEvent({ type: "tool-start", name: td.name, args: candidate.args, summaryLabel });
            currentTelemetry()?.recordToolCall();
            parallelSlice.push({ spec: candidate, toolDef: td, summaryLabel });
            idx++;
          }

          const parallelResults = await Promise.all(
            parallelSlice.map((item) => item.toolDef.run(item.spec.args ?? {}, toolCtx)),
          );

          if (opts.signal.cancelled || abortController.signal.aborted) {
            saveRun(state, runId, history, steps, "stopped", startedAt, opts.taskMd);
            return "Stopped by the user.";
          }

          let readFailed = false;
          for (let p = 0; p < parallelSlice.length; p++) {
            const item = parallelSlice[p];
            const r = parallelResults[p];
            opts.onEvent({
              type: "tool",
              name: item.toolDef.name,
              args: item.spec.args,
              ok: r.ok,
              output: r.output,
              summaryLabel: item.summaryLabel,
            });
            executed.push({
              tool: item.toolDef.name,
              args: item.spec.args ?? {},
              ok: r.ok,
              output: r.output,
            });
            if (!r.ok) {
              stoppedAtIndex = executed.length;
              readFailed = true;
              break;
            }
          }
          if (readFailed) break;
          continue;
        }

        // Unknown tool -> fail immediately, stop batch, return prior successes + this error.
        if (!firstTool) {
          const unknownMsg = `There is no tool called "${current.tool}". Available tools:\n${toolsForPrompt()}`;
          executed.push({
            tool: current.tool,
            args: current.args ?? {},
            ok: false,
            output: unknownMsg,
          });
          stoppedAtIndex = executed.length;
          break;
        }

        const summaryLabel = describeToolCall(firstTool.name, current.args);
        opts.onEvent({ type: "tool-start", name: firstTool.name, args: current.args, summaryLabel });
        currentTelemetry()?.recordToolCall();

        const result = await firstTool.run(current.args ?? {}, toolCtx);

        if (opts.signal.cancelled || abortController.signal.aborted) {
          saveRun(state, runId, history, steps, "stopped", startedAt, opts.taskMd);
          return "Stopped by the user.";
        }

        opts.onEvent({
          type: "tool",
          name: firstTool.name,
          args: current.args,
          ok: result.ok,
          output: result.output,
          summaryLabel,
        });
        if (state.plan.length) opts.onEvent({ type: "plan", steps: state.plan });

        const isComplete = Boolean(result.data && (result.data as { complete?: boolean }).complete);
        executed.push({
          tool: firstTool.name,
          args: current.args ?? {},
          ok: result.ok,
          output: result.output,
          complete: isComplete,
        });

        if (isComplete) {
          saveRun(state, runId, history, steps, "completed", startedAt, opts.taskMd);
          opts.onEvent({ type: "done", summary: result.output, model: res.laneUsed?.id });
          return result.output;
        }

        if (!result.ok) {
          stoppedAtIndex = executed.length;
          break;
        }

        idx++;
      }

      // Repeat-call detector: hash the whole requested batch + combined results.
      const normalizedBatch = cappedBatch.map((a) => ({ tool: a.tool, args: a.args ?? {} }));
      const batchHash = hashText(
        JSON.stringify(normalizedBatch) +
          "||" +
          executed.map((r) => `${r.tool}:${r.ok}:${hashText(r.output)}`).join("|"),
      );
      recent.push(batchHash);
      if (recent.length > 3) recent.shift();
      const isLoop = recent.length === 3 && recent.every((k) => k === recent[0]);

      const assistantRecord = isSingleLegacyCall
        ? JSON.stringify({ tool: cappedBatch[0].tool, args: cappedBatch[0].args }).slice(0, 1200)
        : JSON.stringify({ actions: normalizedBatch }).slice(0, 1800);

      if (isLoop) {
        const label = cappedBatch.map((a) => a.tool).join("+");
        if (!loopRecovered) {
          loopRecovered = true;
          opts.onEvent({ type: "notice", text: "Same action batch repeated three times — asking for a different approach." });
          history.push({ role: "assistant", content: assistantRecord.slice(0, 600) });
          history.push({
            role: "user",
            content:
              "You have executed this exact action batch three times with the same result. Do not repeat it. " +
              "Diagnose the cause, then either change the arguments, use a different tool, or explain the blocker.",
          });
          recent.length = 0;
          steps++;
          continue;
        }
        return pause(state, runId, history, opts, startedAt, `The same ${label} call kept returning the same result.`);
      }

      // PHASE 2C: Auto-verify after writes (zero extra planning tokens).
      const WRITE_TOOL_NAMES = new Set(["writeFile", "editFile", "replaceLines"]);
      const writtenThisTurn = executed
        .filter((r) => r.ok && WRITE_TOOL_NAMES.has(r.tool) && typeof r.args?.path === "string")
        .map((r) => String(r.args.path));
      if (writtenThisTurn.length > 0) {
        for (const p of writtenThisTurn) invalidateRepoMapCache(state.workspaceRoot, p);
      }
      const autoVerifyRes =
        writtenThisTurn.length > 0 && getSettings().autoVerifyAfterEdits !== false
          ? await runAutoVerifyAfterWrites(state, writtenThisTurn)
          : null;
      const autoVerifySuffix =
        autoVerifyRes && autoVerifyRes.ran && autoVerifyRes.formattedFeedback
          ? `\n${autoVerifyRes.formattedFeedback}`
          : "";

      // Build combined tool-result message (preserving legacy <tool_result> shape for 1-action legacy turns).
      let combinedToolMessage: string;
      if (isSingleLegacyCall && executed.length === 1 && overflowCount === 0) {
        const only = executed[0];
        const trimmedToolOut = clip(only.output, MAX_TOOL_HISTORY_CHARS);
        combinedToolMessage = `<tool_result name="${only.tool}" ok="${only.ok}">\n${trimmedToolOut}${autoVerifySuffix}\n</tool_result>`;
      } else {
        const perItemBudget = Math.max(800, Math.floor((MAX_TOOL_HISTORY_CHARS * 1.5) / Math.max(1, executed.length)));
        const lines: string[] = [`<tool_results executed="${executed.length}" requested="${rawBatch.length}">`];
        executed.forEach((r, i) => {
          lines.push(
            `<tool_result index="${i + 1}" name="${r.tool}" ok="${r.ok}">\n${clip(r.output, perItemBudget)}\n</tool_result>`,
          );
        });
        if (stoppedAtIndex !== -1 && stoppedAtIndex < cappedBatch.length) {
          const skipped = cappedBatch.length - stoppedAtIndex + overflowCount;
          lines.push(
            `[Batch stopped at action ${stoppedAtIndex}/${rawBatch.length} because it failed or was denied; remaining ${skipped} action(s) were NOT executed.]`,
          );
        } else if (overflowCount > 0) {
          lines.push(
            `[Batch capped at ${MAX_BATCH_ACTIONS} actions; ${overflowCount} trailing action(s) were skipped — emit them next turn.]`,
          );
        }
        if (autoVerifySuffix) {
          lines.push(autoVerifySuffix.trimStart());
        }
        lines.push("</tool_results>");
        combinedToolMessage = lines.join("\n");
      }

      lastTurnHadFailure =
        executed.some((r) => !r.ok) || Boolean(autoVerifyRes && autoVerifyRes.ran && !autoVerifyRes.ok);
      history.push({ role: "assistant", content: assistantRecord });
      history.push({ role: "user", content: combinedToolMessage });

      steps++;
      if (steps % 2 === 0) saveRun(state, runId, history, steps, "running", startedAt, opts.taskMd);

      if (steps >= maxSteps) {
        return pause(state, runId, history, opts, startedAt, `Reached the ${maxSteps}-step safety limit.`);
      }
    }

    return pause(state, runId, history, opts, startedAt, "Reached the step limit.");
  } finally {
    activeRuns.delete(runId);
  }
}

// ---------------------------------------------------------------------------

function systemPrompt(state: AgentState, allowTools: boolean): string {
  const batchEnabled = getSettings().batchedActions !== false;
  const cacheKey = `${state.workspaceRoot}::${allowTools ? "tools" : "chat"}::batch=${batchEnabled ? 1 : 0}`;
  const hit = staticSystemPromptCache.get(cacheKey);
  if (hit) return hit;

  const built = !allowTools
    ? [
        "You are MyIDE's assistant. The user asked a plain question, so this is a chat-only turn.",
        "Rules:",
        "- Reply with ONE JSON object per turn: {\"thought\":\"...\",\"answer\":\"...\"}.",
        "- Tools are disabled. Never call a tool and never claim you changed a file.",
        "- Answer clearly and completely in the 'answer' field. Markdown is allowed.",
        "",
        `Workspace root: ${state.workspaceRoot}`,
      ].join("\n")
    : batchEnabled
    ? [
        "You are MyIDE's coding agent. You work only inside the user's workspace folder.",
        "Output ONLY one valid JSON object per turn matching one of these shapes:",
        '1) Batched actions (PREFERRED, max 8): {"thought":"...","actions":[{"tool":"name","args":{...}}, ...]}',
        '2) Single action: {"thought":"...","tool":"name","args":{...}}',
        '3) Final text answer (when no tool needed): {"thought":"...","answer":"..."}',
        'Example batched turn: {"thought":"Create module + test and run tests","actions":[{"tool":"writeFile","args":{"path":"src/add.js","content":"export const add=(a,b)=>a+b;\\n"}},{"tool":"writeFile","args":{"path":"src/add.test.js","content":"import assert from \'node:assert\';\\nimport {add} from \'./add.js\';\\nassert.equal(add(1,2),3);\\n"}},{"tool":"executeCommand","args":{"command":"node src/add.test.js","reason":"Verify add()"}}]}',
        "Rules:",
        "- Batch everything you can foresee in a single turn (read all needed files together; create/edit all files then run verify/build/test in the same turn).",
        "- Independent read-only actions (readFile, listDir, listTree, grep, getSymbols) run in parallel; write/command actions run sequentially and stop at the first failure or denial.",
        "- Never paste file contents into 'answer'. Put every file on disk with writeFile/editFile.",
        "- Paths are relative to workspace root. .env files cannot be read or written. Overwrites are backed up; deletes go to .myide/trash.",
        "- Commands not on the allowlist pause for user approval; explain why in 'thought'. Use ask_user (2-4 options) only when a genuine decision is needed.",
        "- After changing any HTML file you MUST call verifyWebsite on it before markComplete.",
        "",
        "Tools:",
        toolsForPrompt(),
        "",
        `Workspace root: ${state.workspaceRoot}`,
      ].join("\n")
    : [
        "You are MyIDE's coding agent. You work only inside the user's workspace folder.",
        "Rules:",
        "- Reply with ONE JSON object per turn: {\"thought\":\"...\",\"tool\":\"name\",\"args\":{...}} or {\"thought\":\"...\",\"answer\":\"...\"}.",
        "- Use a tool whenever files must change. Never describe changes instead of making them.",
        "- Never paste file contents into your reply. Put every file on disk with writeFile.",
        "- Paths are always relative to the workspace root. Never use absolute paths.",
        "- .env files cannot be read or written.",
        "- Deletes go to .myide/trash and overwrites are backed up automatically.",
        "- Commands need the user's approval; explain why a command is needed in your thought.",
        "- When you genuinely need a user decision between options before continuing, call ask_user with 2-4 options.",
        "- After changing any HTML file you MUST call verifyWebsite on it and fix the reported issues before markComplete.",
        "- Keep the plan updated with updatePlan (8 steps maximum).",
        "",
        "Tools:",
        toolsForPrompt(),
        "",
        `Workspace root: ${state.workspaceRoot}`,
      ].join("\n");

  staticSystemPromptCache.set(cacheKey, built);
  return built;
}

function progressLedger(state: AgentState, freeSaver = false): string {
  if (freeSaver && state.plan.length === 0 && state.changedHtml.size === 0) {
    return "";
  }
  const files = [...state.changedHtml].slice(0, 12);
  const steps = state.plan.map((s) => `${s.status === "done" ? "[x]" : s.status === "doing" ? "[>]" : "[ ]"} ${s.title}`);
  const lines = [
    "Progress ledger (built by code, do not repeat finished work):",
    steps.length ? steps.join("\n") : "(no plan recorded yet — call updatePlan early)",
    files.length ? `HTML changed this run: ${files.join(", ")}` : "No HTML files changed yet.",
    state.changedHtml.size > 0 && !state.verifyPassedSinceChange
      ? "Verification has NOT passed since the last HTML change."
      : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * PART 1 #5: Trim history to an explicit token budget:
 * - Always preserve the static system prompt (head[0]) and user task (head[1]).
 * - Keep recent messages intact.
 * - Summarize older tool outputs to compact 1-line digests, then drop/collapse
 *   oldest middle messages until total estimated tokens fit within tokenBudget.
 */
export function compactHistoryToBudget(history: Message[], tokenBudget = DEFAULT_TOKEN_BUDGET): Message[] {
  const budget = Math.max(1200, tokenBudget);
  const totalEst = () => estimateTokens(history.map((m) => m.content).join("\n"), 512);
  if (history.length <= KEEP_RECENT_MESSAGES + 2 && totalEst() <= budget) {
    return history;
  }

  const head = history.slice(0, Math.min(2, history.length));
  const tailCount = Math.min(KEEP_RECENT_MESSAGES, Math.max(0, history.length - head.length));
  const tail = tailCount > 0 ? history.slice(-tailCount).map((m) => ({
    role: m.role,
    content: clip(m.content, MAX_TOOL_HISTORY_CHARS),
  })) : [];
  const middle = history.slice(head.length, history.length - tailCount);

  const summarizedMiddle: Message[] = middle.map((m) => {
    if (m.role === "user" && m.content.startsWith("<tool_result")) {
      const name = /name="([^"]+)"/.exec(m.content)?.[1] ?? "tool";
      const okAttr = /ok="([^"]+)"/.exec(m.content)?.[1] ?? "true";
      const inner = m.content.replace(/^<tool_result[^>]*>\n?/, "").replace(/\n?<\/tool_result>$/, "");
      return {
        role: "user",
        content: `<tool_result name="${name}" ok="${okAttr}">[summarized] ${inner.slice(0, OLD_RESULT_CHARS).replace(/\s+/g, " ")}…</tool_result>`,
      };
    }
    if (m.role === "assistant") {
      return { role: "assistant", content: m.content.slice(0, OLD_RESULT_CHARS) };
    }
    return { role: m.role, content: m.content.slice(0, OLD_RESULT_CHARS) };
  });

  let droppedCount = 0;
  while (summarizedMiddle.length > 0) {
    const candidate = [...head, ...summarizedMiddle, ...tail];
    const est = estimateTokens(candidate.map((m) => m.content).join("\n"), 512);
    if (est <= budget) break;
    summarizedMiddle.shift();
    droppedCount += 1;
  }

  const result: Message[] = [...head];
  if (droppedCount > 0) {
    result.push({
      role: "user",
      content: `[Context note: ${droppedCount} older step message(s) omitted to stay within the ${budget}-token budget.]`,
    });
  }
  result.push(...summarizedMiddle, ...tail);
  return result;
}

function saveRun(
  state: AgentState,
  runId: string,
  history: Message[],
  steps: number,
  status: RunStatus,
  startedAt: number,
  taskMd?: string,
  pauseReason?: string,
): void {
  try {
    const dir = path.join(state.myideDir, "runs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${runId}.json`);
    const tmp = `${file}.tmp`;
    const record: SavedRun = {
      runId,
      workspaceRoot: state.workspaceRoot,
      status,
      startedAt,
      updatedAt: Date.now(),
      steps,
      taskMd,
      pauseReason,
      plan: state.plan,
      changedHtml: [...state.changedHtml],
      history,
    };
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    log.warn("agent: could not save the run", e);
  }
}

function pause(
  state: AgentState,
  runId: string,
  history: Message[],
  opts: AgentOptions,
  startedAt: number,
  reason: string,
): string {
  saveRun(state, runId, history, history.length, "paused", startedAt, opts.taskMd, reason);
  opts.onEvent({
    type: "paused",
    reason,
    options: ["Tell the AI what to do", "Skip this step", "Edit models", "Stop"],
  });
  log.warn(`agent: paused — ${reason}`);
  return `Paused: ${reason}`;
}
