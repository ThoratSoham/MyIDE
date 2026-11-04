import fs from "fs";
import path from "path";
import log from "electron-log";
import type { AIService } from "../ai/service";
import type { LaneExhaustedDetail, Message } from "../ai/types";
import { formatLocalTime } from "../ai/router";
import { estimateTokens } from "../ai/tokenize";
import { parseJsonLoose } from "../quality/json-repair";
import { validateSchema } from "../quality/schema";
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
  | { type: "done"; summary: string; model?: string };

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

const AGENT_SCHEMA = {
  type: "object",
  required: ["thought"],
  properties: {
    thought: { type: "string", minLength: 1 },
    tool: { type: "string" },
    args: { type: "object" },
    answer: { type: "string" },
  },
};

// Cache static system prompts per (workspaceRoot, allowTools) so we never rebuild
// static context repeatedly and prefix prompt caching remains stable across turns.
const staticSystemPromptCache = new Map<string, string>();

export function createAgentState(workspaceRoot: string): AgentState {
  lastKnownWorkspaceRoot = workspaceRoot;
  const myideDir = path.join(workspaceRoot, ".myide");
  fs.mkdirSync(myideDir, { recursive: true });
  for (const d of ["runs", "build", "verify", "cache", "trash", "backups"]) {
    fs.mkdirSync(path.join(myideDir, d), { recursive: true });
  }
  return {
    workspaceRoot,
    myideDir,
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
  const startedAt = Date.now();
  const abortController = opts.abortController ?? new AbortController();

  let steps = 0;
  let consecutiveErrors = 0;
  let nudged = false;
  let loopRecovered = false;
  const recent: string[] = [];

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

      const ledger = allowTools ? progressLedger(state) : "";
      const compacted = compactHistoryToBudget(history, tokenBudget - (ledger ? estimateTokens(ledger, 0) : 0));
      // Keep messages[0] strictly as the static system prompt so provider prefix caching hits!
      const messages: Message[] = [...compacted];
      if (ledger) {
        messages.splice(Math.min(2, messages.length), 0, {
          role: "user",
          content: `[System progress ledger]\n${ledger}`,
        });
      }

      let rawStreamed = "";
      let emittedPreviewLen = 0;

      const res = await ai.complete("reasoning", messages, {
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
      let value = schemaOk
        ? (parsed.value as { thought: string; tool?: string; args?: unknown; answer?: string })
        : null;

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
            `{"thought":"...","tool":"...","args":{...}} or {"thought":"...","answer":"..."}.`,
        });
        steps++;
        continue;
      }
      consecutiveErrors = 0;

      if (value.thought) opts.onEvent({ type: "assistant", text: value.thought, model: res.laneUsed?.id });

      if (!value.tool) {
        const reply = (value.answer ?? value.thought ?? "").trim();
        const freshWork = allowTools && state.changedFiles.size === 0;
        const suggested = typedCode.length > 0 ? typedCode : freshWork ? parseSuggestedFiles(reply) : [];

        if (freshWork && !nudged) {
          nudged = true;
          history.push({ role: "assistant", content: JSON.stringify(value).slice(0, 600) });
          history.push({
            role: "user",
            content: suggested.length
              ? "You answered with code as plain text, so NO file was created. Use writeFile now — one call per file — " +
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

      const tool = findTool(value.tool);
      if (!tool) {
        history.push({ role: "assistant", content: JSON.stringify(value).slice(0, 600) });
        history.push({ role: "user", content: `There is no tool called "${value.tool}". Available tools:\n${toolsForPrompt()}` });
        steps++;
        continue;
      }

      const summaryLabel = describeToolCall(tool.name, value.args);
      opts.onEvent({ type: "tool-start", name: tool.name, args: value.args, summaryLabel });

      const result = await tool.run(value.args ?? {}, {
        state,
        requestApproval: opts.requestApproval,
        askUser: opts.askUser,
        onPreview: opts.onPreview,
        onAgentOutput: opts.onAgentOutput,
        signal: opts.signal,
        abortSignal: abortController.signal,
      });

      if (opts.signal.cancelled || abortController.signal.aborted) {
        saveRun(state, runId, history, steps, "stopped", startedAt, opts.taskMd);
        return "Stopped by the user.";
      }

      opts.onEvent({
        type: "tool",
        name: tool.name,
        args: value.args,
        ok: result.ok,
        output: result.output,
        summaryLabel,
      });
      if (state.plan.length) opts.onEvent({ type: "plan", steps: state.plan });

      if (result.data && (result.data as any).complete) {
        saveRun(state, runId, history, steps, "completed", startedAt, opts.taskMd);
        opts.onEvent({ type: "done", summary: result.output, model: res.laneUsed?.id });
        return result.output;
      }

      const key = `${tool.name}|${JSON.stringify(value.args ?? {})}|${hashText(result.output)}`;
      recent.push(key);
      if (recent.length > 3) recent.shift();
      const isLoop = recent.length === 3 && recent.every((k) => k === recent[0]);

      if (isLoop) {
        if (!loopRecovered) {
          loopRecovered = true;
          opts.onEvent({ type: "notice", text: "Same action repeated three times — asking for a different approach." });
          history.push({ role: "assistant", content: JSON.stringify({ tool: tool.name, args: value.args }).slice(0, 600) });
          history.push({
            role: "user",
            content:
              "You have done exactly this three times with the same result. Do not repeat it. " +
              "Diagnose the cause, then either change the arguments, use a different tool, or explain the blocker.",
          });
          recent.length = 0;
          steps++;
          continue;
        }
        return pause(state, runId, history, opts, startedAt, `The same ${tool.name} call kept returning the same result.`);
      }

      // Truncate oversized tool output before adding to conversation history.
      const trimmedToolOut = clip(result.output, MAX_TOOL_HISTORY_CHARS);
      history.push({ role: "assistant", content: JSON.stringify({ tool: tool.name, args: value.args }).slice(0, 1200) });
      history.push({
        role: "user",
        content: `<tool_result name="${tool.name}" ok="${result.ok}">\n${trimmedToolOut}\n</tool_result>`,
      });

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
  const cacheKey = `${state.workspaceRoot}::${allowTools ? "tools" : "chat"}`;
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

function progressLedger(state: AgentState): string {
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
