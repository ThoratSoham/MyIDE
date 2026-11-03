import fs from "fs";
import path from "path";
import log from "electron-log";
import type { AIService } from "../ai/service";
import type { Message } from "../ai/types";
import { parseJsonLoose } from "../quality/json-repair";
import { validateSchema } from "../quality/schema";
import {
  findTool,
  hashText,
  loadAllowedCommands,
  toolsForPrompt,
  type AgentState,
  type ApprovalDecision,
  type PlanStep,
} from "./tools";

// FR-5: the agent loop runs in the main process and keeps going when the user
// switches tabs. FR-6: loop detection, a code-built progress ledger and history
// compaction keep long runs alive. Safety limits pause a run, they never kill it.

export type AgentEvent =
  | { type: "assistant"; text: string; model?: string }
  | { type: "tool"; name: string; args: unknown; ok: boolean; output: string }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "notice"; text: string }
  | { type: "paused"; reason: string; options: string[] }
  | { type: "done"; summary: string };

export interface AgentOptions {
  taskMd: string;
  signal: { cancelled: boolean; note?: string };
  onEvent: (e: AgentEvent) => void;
  requestApproval: (command: string, reason: string) => Promise<ApprovalDecision>;
  onPreview?: (rel: string) => void;
  maxSteps?: number;
}

const MAX_STEPS = 40;
const MAX_CONSECUTIVE_ERRORS = 4;
const COMPACT_AFTER = 16;
const KEEP_WHOLE = 6;
const OLD_RESULT_CHARS = 300;

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

export function createAgentState(workspaceRoot: string): AgentState {
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
    verifyPassedSinceChange: true,
    lastVerify: null,
    plan: [],
  };
}

export async function runAgent(ai: AIService, state: AgentState, opts: AgentOptions): Promise<string> {
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  let steps = 0;
  let consecutiveErrors = 0;
  let nudged = false;
  let usedTool = false;
  let loopRecovered = false;
  const recent: string[] = [];

  let history: Message[] = [
    { role: "system", content: systemPrompt(state) },
    { role: "user", content: opts.taskMd || "Start the job." },
  ];

  while (steps < maxSteps) {
    if (opts.signal.cancelled) return "Stopped by the user.";

    // FR-5.8: a note sent while the agent works is read before the next step.
    if (opts.signal.note) {
      history.push({ role: "user", content: `Note from the user: ${opts.signal.note}` });
      opts.signal.note = undefined;
    }

    const compacted = compactHistory(history);
    const ledger = progressLedger(state);
    const messages: Message[] = [...compacted];
    if (ledger) messages.splice(1, 0, { role: "system", content: ledger });

    const res = await ai.complete("reasoning", messages, {
      schema: AGENT_SCHEMA,
      expectedOutputTokens: 900,
    });

    if (!res.ok) {
      if (res.pause) {
        opts.onEvent({
          type: "paused",
          reason: `Every lane is out of quota. Resume at ${
            res.resumeAtMs ? new Date(res.resumeAtMs).toISOString().slice(11, 16) + " UTC" : "the reset time"
          }.`,
          options: ["Resume now", "Stop"],
        });
        saveRun(state, runId, history, steps);
        return "Paused: waiting for quota to reset.";
      }
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        return pause(state, runId, history, opts, `The model failed ${consecutiveErrors} times in a row.`);
      }
      history.push({ role: "user", content: "That request failed. Try again with a smaller, simpler step." });
      steps++;
      continue;
    }

    const parsed = parseJsonLoose(res.content ?? "");
    if (!parsed.ok || validateSchema(AGENT_SCHEMA, parsed.value).length > 0) {
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

    const value = parsed.value as { thought: string; tool?: string; args?: unknown; answer?: string };
    if (value.thought) opts.onEvent({ type: "assistant", text: value.thought, model: res.laneUsed?.id });

    // No tool and no answer: a text-only reply.
    if (!value.tool) {
      if (value.answer) {
        saveRun(state, runId, history, steps);
        opts.onEvent({ type: "done", summary: value.answer });
        return value.answer;
      }
      if (!usedTool && !nudged) {
        nudged = true;
        history.push({ role: "assistant", content: JSON.stringify(value).slice(0, 600) });
        history.push({
          role: "user",
          content:
            "You replied with text only. If this job needs files to change, call a tool now (start with listDir). " +
            "If it really is a question, answer it directly with the 'answer' field.",
        });
        steps++;
        continue;
      }
      opts.onEvent({ type: "done", summary: value.thought });
      return value.thought;
    }

    const tool = findTool(value.tool);
    if (!tool) {
      history.push({ role: "assistant", content: JSON.stringify(value).slice(0, 600) });
      history.push({ role: "user", content: `There is no tool called "${value.tool}". Available tools:\n${toolsForPrompt()}` });
      steps++;
      continue;
    }

    usedTool = true;
    const result = await tool.run(value.args ?? {}, {
      state,
      requestApproval: opts.requestApproval,
      onPreview: opts.onPreview,
      signal: opts.signal,
    });

    opts.onEvent({ type: "tool", name: tool.name, args: value.args, ok: result.ok, output: result.output });
    if (state.plan.length) opts.onEvent({ type: "plan", steps: state.plan });

    if (result.data && (result.data as any).complete) {
      saveRun(state, runId, history, steps);
      opts.onEvent({ type: "done", summary: result.output });
      return result.output;
    }

    // FR-6.1: a loop is the same tool, the same arguments and the same result
    // three times in a row. Reads include the file hash, so reading a changed
    // file is never a loop.
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
      return pause(state, runId, history, opts, `The same ${tool.name} call kept returning the same result.`);
    }

    history.push({ role: "assistant", content: JSON.stringify({ tool: tool.name, args: value.args }).slice(0, 1200) });
    history.push({
      role: "user",
      content: `<tool_result name="${tool.name}" ok="${result.ok}">\n${result.output}\n</tool_result>`,
    });

    steps++;
    if (steps % 2 === 0) saveRun(state, runId, history, steps);

    // FR-5.9: safety limit reached — pause, never kill.
    if (steps >= maxSteps) {
      return pause(state, runId, history, opts, `Reached the ${maxSteps}-step safety limit.`);
    }
  }

  return pause(state, runId, history, opts, "Reached the step limit.");
}

// ---------------------------------------------------------------------------

function systemPrompt(state: AgentState): string {
  return [
    "You are MyIDE's coding agent. You work only inside the user's workspace folder.",
    "Rules:",
    "- Reply with ONE JSON object per turn: {\"thought\":\"...\",\"tool\":\"name\",\"args\":{...}} or {\"thought\":\"...\",\"answer\":\"...\"}.",
    "- Use a tool whenever files must change. Never describe changes instead of making them.",
    "- Paths are always relative to the workspace root. Never use absolute paths.",
    "- .env files cannot be read or written.",
    "- Deletes go to .myide/trash and overwrites are backed up automatically.",
    "- Commands need the user's approval; explain why a command is needed in your thought.",
    "- After changing any HTML file you MUST call verifyWebsite on it and fix the reported issues before markComplete.",
    "- Keep the plan updated with updatePlan (8 steps maximum).",
    "",
    "Tools:",
    toolsForPrompt(),
    "",
    `Workspace root: ${state.workspaceRoot}`,
  ].join("\n");
}

// FR-6.3: a code-built progress block (at most ~400 tokens) is added to every
// request so the model always knows where it is.
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

// FR-6.5: keep the last 6 messages whole, shorten older tool results to 300
// characters, and keep the total comfortably under the Groq 5,500-token cap.
function compactHistory(history: Message[]): Message[] {
  if (history.length <= COMPACT_AFTER) return history;
  const head = history.slice(0, 2);
  const tail = history.slice(-KEEP_WHOLE);
  const middle = history.slice(2, history.length - KEEP_WHOLE);

  const shortened: Message[] = middle.map((m) => {
    if (m.role === "user" && m.content.startsWith("<tool_result")) {
      const name = /name="([^"]+)"/.exec(m.content)?.[1] ?? "tool";
      return { role: "user", content: `<tool_result name="${name}">${m.content.slice(0, OLD_RESULT_CHARS)}…</tool_result>` };
    }
    if (m.role === "assistant") return { role: "assistant", content: m.content.slice(0, OLD_RESULT_CHARS) };
    return m;
  });

  return [...head, ...shortened, ...tail];
}

// FR-6.6: save the run after steps (temp file, then rename).
function saveRun(state: AgentState, runId: string, history: Message[], steps: number): void {
  try {
    const dir = path.join(state.myideDir, "runs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${runId}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ runId, steps, plan: state.plan, changedHtml: [...state.changedHtml], history }, null, 2),
    );
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
  reason: string,
): string {
  saveRun(state, runId, history, history.length);
  opts.onEvent({
    type: "paused",
    reason,
    options: ["Tell the AI what to do", "Skip this step", "Try a stronger model", "Stop"],
  });
  log.warn(`agent: paused — ${reason}`);
  return `Paused: ${reason}`;
}
