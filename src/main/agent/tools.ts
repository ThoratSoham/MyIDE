import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import log from "electron-log";
import { verifyWebsite, type VerifyReport } from "../quality/verifier";
import { currentTelemetry } from "../telemetry";
import type { UserQuestionOption } from "../../shared/electron-api-types";

// FR-5.2: the agent tool set. Every tool runs in the main process. Paths stay
// inside the workspace (FR-5.3), .env files can never be read, deletes go to
// trash and overwrites are backed up (FR-13.3), commands need approval with
// a timeout and a process-tree kill (FR-5.4), and ask_user pauses the loop
// until the user answers or dismisses (PART 3).

export type ApprovalDecision = "once" | "always" | "deny";

export interface AskUserArgs {
  question: string;
  options: UserQuestionOption[];
  allowMultiple: boolean;
}

export interface AskUserToolResult {
  answered: boolean;
  selectedLabels: string[];
  otherText?: string;
  dismissed?: boolean;
  timedOut?: boolean;
}

export interface AgentState {
  workspaceRoot: string;
  myideDir: string;
  allowedCommands: Set<string>;
  changedHtml: Set<string>;
  changedFiles: Map<string, "created" | "edited" | "deleted">;
  verifyPassedSinceChange: boolean;
  lastVerify: VerifyReport | null;
  plan: PlanStep[];
}

export function verifyWrittenFile(abs: string): string | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return "the path is not a file";
    if (st.size <= 0) return "the file is empty (0 bytes)";
    return null;
  } catch (e) {
    return `the file is not on disk (${(e as Error).message})`;
  }
}

export function recordChange(state: AgentState, rel: string, change: "created" | "edited" | "deleted"): void {
  const key = rel.split("\\").join("/");
  if (change === "deleted") state.changedFiles.set(key, "deleted");
  else if (state.changedFiles.get(key) !== "created") state.changedFiles.set(key, change);
}

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "doing" | "done" | "failed";
  note?: string;
}

export interface ToolContext {
  state: AgentState;
  requestApproval: (command: string, reason: string) => Promise<ApprovalDecision>;
  askUser?: (args: AskUserArgs) => Promise<AskUserToolResult>;
  onPreview?: (workspacePath: string) => void;
  onAgentOutput?: (chunk: string) => void;
  signal?: { cancelled: boolean };
  abortSignal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  data?: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  params: Record<string, { type: string; description: string; required?: boolean }>;
  run: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/(?!\S)/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/,
  /\bdel\s+\/[sfq]\b.*\b[a-z]:\\/i,
  /\brd\s+\/s\s+\/q\b/i,
  /\bgit\s+push\s+--force\b/i,
  /\bcurl\b.*\|\s*(ba)?sh/i,
  /\bwget\b.*\|\s*(ba)?sh/i,
];

export function isDangerousCommand(command: string): boolean {
  return BLOCKED_PATTERNS.some((re) => re.test(command));
}

function insideWorkspace(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const normRoot = path.resolve(root);
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) {
    throw new Error(`access denied: ${rel} is outside the workspace`);
  }
  return abs;
}

function isEnvFile(p: string): boolean {
  const name = path.basename(p);
  return name === ".env" || name.startsWith(".env.");
}

// Truncate large tool results while keeping both head and tail context.
const TEXT_LIMIT = 12_000;

export function clip(s: string, limit = TEXT_LIMIT): string {
  if (s.length <= limit) return s;
  const headLen = Math.floor(limit * 0.7);
  const tailLen = Math.max(0, limit - headLen - 80);
  const omitted = s.length - headLen - tailLen;
  return `${s.slice(0, headLen)}\n... [${omitted} characters truncated] ...\n${s.slice(s.length - tailLen)}`;
}

function backupIfExists(root: string, abs: string, rel: string): void {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
  const backupRoot = path.join(root, ".myide", "backups");
  fs.mkdirSync(backupRoot, { recursive: true });
  const dest = path.join(backupRoot, `${rel.replace(/[\\/]/g, "_")}.${Date.now()}.bak`);
  fs.copyFileSync(abs, dest);
}

export function describeToolCall(name: string, args: any): string {
  const p = args?.path ? String(args.path) : "";
  switch (name) {
    case "readFile":
      return `Reading file ${p || ""}…`.trim();
    case "writeFile":
      return `Writing file ${p || ""}…`.trim();
    case "editFile":
      return `Editing file ${p || ""}…`.trim();
    case "listDir":
      return `Listing directory ${p || "/"}…`;
    case "deleteFile":
      return `Moving ${p || "file"} to trash…`;
    case "moveFile":
      return `Moving ${args?.from ?? ""} → ${args?.to ?? ""}…`;
    case "createDir":
      return `Creating folder ${p || ""}…`;
    case "executeCommand":
      return `Running command: ${String(args?.command ?? "").slice(0, 48)}…`;
    case "verifyWebsite":
      return `Verifying website ${p || ""}…`;
    case "openPreview":
      return `Opening preview ${p || ""}…`;
    case "updatePlan":
      return "Updating plan…";
    case "ask_user":
      return `Asking user: ${String(args?.question ?? "").slice(0, 48)}…`;
    case "markComplete":
      return "Completing task…";
    default:
      return `Running ${name}…`;
  }
}

export const TOOLS: ToolSpec[] = [
  {
    name: "listDir",
    description: "List the files and folders inside a workspace directory.",
    params: { path: { type: "string", description: "Directory path relative to the workspace root ('' = root)." } },
    async run(args, ctx) {
      const rel = String(args?.path ?? "");
      const abs = insideWorkspace(ctx.state.workspaceRoot, rel);
      if (!fs.existsSync(abs)) return { ok: false, output: `No such directory: ${rel || "/"}. Use listDir on '' to see the root.` };
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.name !== "node_modules" && e.name !== ".git")
        .map((e) => `${e.isDirectory() ? "[dir] " : "      "}${e.name}`);
      return { ok: true, output: clip(entries.length ? entries.join("\n") : "(empty directory)") };
    },
  },
  {
    name: "readFile",
    description: "Read a text file from the workspace. .env files cannot be read.",
    params: { path: { type: "string", description: "File path relative to the workspace root.", required: true } },
    async run(args, ctx) {
      const rel = String(args?.path ?? "");
      const abs = insideWorkspace(ctx.state.workspaceRoot, rel);
      if (isEnvFile(abs)) return { ok: false, output: "Refused: .env files are never read (FR-5.3)." };
      if (!fs.existsSync(abs)) return { ok: false, output: `No such file: ${rel}. Use listDir to check the path.` };
      const text = fs.readFileSync(abs, "utf8");
      return { ok: true, output: clip(text), data: { hash: hashText(text), length: text.length } };
    },
  },
  {
    name: "writeFile",
    description: "Create or overwrite a file. A backup of any previous content is kept automatically.",
    params: {
      path: { type: "string", description: "File path relative to the workspace root.", required: true },
      content: { type: "string", description: "Full file content.", required: true },
    },
    async run(args, ctx) {
      const rel = String(args?.path ?? "");
      const content = String(args?.content ?? "");
      if (!rel) return { ok: false, output: "writeFile needs a path." };
      const abs = insideWorkspace(ctx.state.workspaceRoot, rel);
      if (isEnvFile(abs)) return { ok: false, output: "Refused: .env files are never written (FR-5.3)." };
      const existed = fs.existsSync(abs);
      backupIfExists(ctx.state.workspaceRoot, abs, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      const problem = verifyWrittenFile(abs);
      if (problem) return { ok: false, output: `The write did NOT succeed: ${problem}` };
      recordChange(ctx.state, rel, existed ? "edited" : "created");
      noteWrite(ctx.state, rel);
      const bytes = fs.statSync(abs).size;
      return {
        ok: true,
        output: `Wrote ${rel} (${bytes} bytes on disk, verified).`,
        data: { path: rel, bytes, verified: true },
      };
    },
  },
  {
    name: "editFile",
    description: "Replace an exact string inside an existing file. Fails if the search text is missing or ambiguous.",
    params: {
      path: { type: "string", description: "File path relative to the workspace root.", required: true },
      find: { type: "string", description: "Exact text to replace.", required: true },
      replace: { type: "string", description: "Replacement text.", required: true },
    },
    async run(args, ctx) {
      const rel = String(args?.path ?? "");
      const find = String(args?.find ?? "");
      const replace = String(args?.replace ?? "");
      const abs = insideWorkspace(ctx.state.workspaceRoot, rel);
      if (isEnvFile(abs)) return { ok: false, output: "Refused: .env files are never edited (FR-5.3)." };
      if (!fs.existsSync(abs)) return { ok: false, output: `No such file: ${rel}. Read it first, then edit.` };
      const text = fs.readFileSync(abs, "utf8");
      const first = text.indexOf(find);
      if (first === -1) {
        currentTelemetry()?.recordFailedEditFile();
        return { ok: false, output: `The text to replace was not found in ${rel}. Read the file and copy the exact text.` };
      }
      if (text.indexOf(find, first + find.length) !== -1) {
        currentTelemetry()?.recordFailedEditFile();
        return { ok: false, output: `The text to replace appears more than once in ${rel}. Include more surrounding text.` };
      }
      backupIfExists(ctx.state.workspaceRoot, abs, rel);
      fs.writeFileSync(abs, text.replace(find, replace), "utf8");
      const problem = verifyWrittenFile(abs);
      if (problem) return { ok: false, output: `The edit did NOT succeed: ${problem}` };
      recordChange(ctx.state, rel, "edited");
      noteWrite(ctx.state, rel);
      return { ok: true, output: `Edited ${rel} (${fs.statSync(abs).size} bytes on disk, verified).` };
    },
  },
  {
    name: "deleteFile",
    description: "Move a file or folder to .myide/trash. Nothing is deleted permanently.",
    params: { path: { type: "string", description: "Path relative to the workspace root.", required: true } },
    async run(args, ctx) {
      const rel = String(args?.path ?? "");
      const abs = insideWorkspace(ctx.state.workspaceRoot, rel);
      if (isEnvFile(abs)) return { ok: false, output: "Refused: .env files are never touched (FR-5.3)." };
      if (!fs.existsSync(abs)) return { ok: false, output: `Nothing to delete at ${rel}.` };
      const trashRoot = path.join(ctx.state.workspaceRoot, ".myide", "trash");
      fs.mkdirSync(trashRoot, { recursive: true });
      const dest = path.join(trashRoot, `${Date.now()}_${rel.replace(/[\\/]/g, "_")}`);
      if (fs.statSync(abs).isDirectory()) {
        fs.cpSync(abs, dest, { recursive: true });
        fs.rmSync(abs, { recursive: true, force: true });
      } else {
        fs.copyFileSync(abs, dest);
        fs.unlinkSync(abs);
      }
      recordChange(ctx.state, rel, "deleted");
      return { ok: true, output: `Moved ${rel} to .myide/trash (recoverable).` };
    },
  },
  {
    name: "moveFile",
    description: "Move or rename a file or folder inside the workspace.",
    params: {
      from: { type: "string", description: "Current path.", required: true },
      to: { type: "string", description: "New path.", required: true },
    },
    async run(args, ctx) {
      const from = String(args?.from ?? "");
      const to = String(args?.to ?? "");
      const absFrom = insideWorkspace(ctx.state.workspaceRoot, from);
      const absTo = insideWorkspace(ctx.state.workspaceRoot, to);
      if (!fs.existsSync(absFrom)) return { ok: false, output: `Nothing to move at ${from}.` };
      fs.mkdirSync(path.dirname(absTo), { recursive: true });
      fs.renameSync(absFrom, absTo);
      return { ok: true, output: `Moved ${from} to ${to}.` };
    },
  },
  {
    name: "createDir",
    description: "Create a folder inside the workspace.",
    params: { path: { type: "string", description: "Folder path relative to the workspace root.", required: true } },
    async run(args, ctx) {
      const rel = String(args?.path ?? "");
      const abs = insideWorkspace(ctx.state.workspaceRoot, rel);
      fs.mkdirSync(abs, { recursive: true });
      return { ok: true, output: `Created folder ${rel}.` };
    },
  },
  {
    name: "executeCommand",
    description:
      "Run a shell command in the workspace. The user must approve it first. Long output is trimmed. " +
      "Never use this for destructive system commands.",
    params: {
      command: { type: "string", description: "The command line to run.", required: true },
      cwd: { type: "string", description: "Working directory relative to the workspace root (optional)." },
    },
    async run(args, ctx) {
      const command = String(args?.command ?? "").trim();
      if (!command) return { ok: false, output: "executeCommand needs a command." };
      if (isDangerousCommand(command)) {
        return { ok: false, output: `Blocked: this command is on the always-refused list (FR-5.4): ${command}` };
      }
      const cwdRel = String(args?.cwd ?? "");
      const cwd = insideWorkspace(ctx.state.workspaceRoot, cwdRel);

      const alwaysAllowed = ctx.state.allowedCommands.has(command);
      if (!alwaysAllowed) {
        const decision = await ctx.requestApproval(command, `Run in ${cwdRel || "the workspace root"}`);
        if (decision === "deny") return { ok: false, output: "The user denied this command. Try a different approach." };
        if (decision === "always") {
          ctx.state.allowedCommands.add(command);
          persistAllowedCommands(ctx.state);
        }
      }

      return runShell(command, cwd, ctx.onAgentOutput, ctx.abortSignal);
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user a decision question with 2-4 options when you need their input before continuing. " +
      "Pauses execution until the user answers or dismisses.",
    params: {
      question: { type: "string", description: "Clear question to show the user.", required: true },
      options: {
        type: "array",
        description: "2 to 4 options: [{ label: string, description?: string }].",
        required: true,
      },
      allowMultiple: {
        type: "boolean",
        description: "Allow selecting multiple options (default false).",
      },
    },
    async run(args, ctx) {
      const question = String(args?.question ?? "").trim();
      if (!question) {
        return { ok: false, output: "ask_user requires a non-empty 'question' string." };
      }
      const rawOptions = Array.isArray(args?.options) ? args.options : [];
      const normalized: UserQuestionOption[] = rawOptions
        .map((o: any): UserQuestionOption | null => {
          if (typeof o === "string" && o.trim()) return { label: o.trim() };
          if (o && typeof o === "object" && typeof o.label === "string" && o.label.trim()) {
            return {
              label: o.label.trim(),
              description: typeof o.description === "string" && o.description.trim() ? o.description.trim() : undefined,
            };
          }
          return null;
        })
        .filter((x: UserQuestionOption | null): x is UserQuestionOption => x !== null)
        .slice(0, 4);

      if (normalized.length < 2) {
        return {
          ok: false,
          output: "ask_user requires between 2 and 4 options, each with { label, description? }.",
        };
      }

      if (!ctx.askUser) {
        return { ok: true, output: "no answer", data: { answered: false } };
      }

      const allowMultiple = Boolean(args?.allowMultiple);
      const res = await ctx.askUser({ question, options: normalized, allowMultiple });
      if (!res.answered || res.dismissed || res.timedOut) {
        return {
          ok: true,
          output: "no answer",
          data: { answered: false, dismissed: res.dismissed, timedOut: res.timedOut },
        };
      }

      const parts: string[] = [];
      if (res.selectedLabels.length > 0) parts.push(...res.selectedLabels);
      if (res.otherText && res.otherText.trim()) parts.push(`Other: ${res.otherText.trim()}`);
      const answerText = parts.length > 0 ? parts.join(", ") : "no answer";
      return {
        ok: true,
        output: answerText,
        data: { answered: true, selectedLabels: res.selectedLabels, otherText: res.otherText },
      };
    },
  },
  {
    name: "verifyWebsite",
    description:
      "Run the code verifier on a built HTML page (three viewports) and report every problem found. " +
      "This must pass before you may call markComplete after changing HTML.",
    params: { path: { type: "string", description: "Path to the HTML page relative to the workspace root.", required: true } },
    async run(args, ctx) {
      const rel = String(args?.path ?? "");
      const abs = insideWorkspace(ctx.state.workspaceRoot, rel);
      if (!fs.existsSync(abs)) return { ok: false, output: `No such page: ${rel}.` };
      const report = await verifyWebsite({
        pagePath: abs,
        workspaceRoot: ctx.state.workspaceRoot,
        outDir: path.join(ctx.state.myideDir, "verify"),
      });
      ctx.state.lastVerify = report;
      if (report.verified) {
        currentTelemetry()?.recordVerification(report.ok);
      }
      if (report.ok && report.verified) ctx.state.verifyPassedSinceChange = true;
      return {
        ok: report.ok,
        output: summarizeVerify(report),
        data: { ok: report.ok, verified: report.verified, issues: report.issues },
      };
    },
  },
  {
    name: "openPreview",
    description: "Show an HTML file or image in the preview panel.",
    params: { path: { type: "string", description: "Path relative to the workspace root.", required: true } },
    async run(args, ctx) {
      const rel = String(args?.path ?? "");
      insideWorkspace(ctx.state.workspaceRoot, rel);
      ctx.onPreview?.(rel);
      return { ok: true, output: `Opened ${rel} in the preview panel.` };
    },
  },
  {
    name: "updatePlan",
    description: "Record or update the step plan shown to the user. Keep it to 8 steps or fewer.",
    params: {
      steps: {
        type: "array",
        description: "Full list of steps: [{ title, status }] where status is pending|doing|done|failed.",
        required: true,
      },
    },
    async run(args, ctx) {
      const steps = Array.isArray(args?.steps) ? args.steps : [];
      ctx.state.plan = steps.slice(0, 8).map((s: any, i: number) => ({
        id: `s${i + 1}`,
        title: String(s?.title ?? `Step ${i + 1}`),
        status: ["pending", "doing", "done", "failed"].includes(s?.status) ? s.status : "pending",
        note: s?.note ? String(s.note) : undefined,
      }));
      persistPlan(ctx.state);
      return { ok: true, output: `Plan updated (${ctx.state.plan.length} steps).` };
    },
  },
  {
    name: "markComplete",
    description:
      "Finish the job. Refused if an HTML file was changed and verifyWebsite has not passed since that change.",
    params: { summary: { type: "string", description: "One short paragraph for the user.", required: true } },
    async run(args, ctx) {
      if (ctx.state.changedHtml.size > 0 && !ctx.state.verifyPassedSinceChange) {
        const files = [...ctx.state.changedHtml].join(", ");
        return {
          ok: false,
          output:
            `Refused (FR-5.6): you changed ${files} and have not run verifyWebsite on it since. ` +
            `Call verifyWebsite and fix any errors, then call markComplete again.`,
        };
      }
      return { ok: true, output: String(args?.summary ?? "Done."), data: { complete: true } };
    },
  },
];

function noteWrite(state: AgentState, rel: string): void {
  if (/\.html?$/i.test(rel)) {
    state.changedHtml.add(rel);
    state.verifyPassedSinceChange = false;
  }
}

function summarizeVerify(report: VerifyReport): string {
  if (!report.verified) return `Verification could NOT run: ${report.note ?? "no browser available"}`;
  const errors = report.issues.filter((i) => i.severity === "error");
  const warnings = report.issues.filter((i) => i.severity === "warning");
  const head = report.ok
    ? `PASSED (0 errors, ${warnings.length} warnings)`
    : `FAILED (${errors.length} errors, ${warnings.length} warnings)`;
  const lines = report.issues.slice(0, 20).map((i) => `- [${i.severity}] ${i.id} ${i.selector ?? ""}: ${i.message} => ${i.fixHint}`);
  return [head, ...lines].join("\n");
}

function persistAllowedCommands(state: AgentState): void {
  try {
    fs.writeFileSync(
      path.join(state.myideDir, "allowed-commands.json"),
      JSON.stringify([...state.allowedCommands], null, 2),
    );
  } catch (e) {
    log.warn("agent: could not persist allowed commands", e);
  }
}

function persistPlan(state: AgentState): void {
  try {
    fs.mkdirSync(state.myideDir, { recursive: true });
    fs.writeFileSync(path.join(state.myideDir, "progress.json"), JSON.stringify({ steps: state.plan }, null, 2));
  } catch (e) {
    log.warn("agent: could not persist the plan", e);
  }
}

export function loadAllowedCommands(myideDir: string): Set<string> {
  try {
    const f = path.join(myideDir, "allowed-commands.json");
    if (!fs.existsSync(f)) return new Set();
    return new Set(JSON.parse(fs.readFileSync(f, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 10_000;

async function runShell(
  command: string,
  cwd: string,
  onOutput?: (chunk: string) => void,
  abortSignal?: AbortSignal,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve({ ok: false, output: "[cancelled by user]" });
      return;
    }
    const isWin = process.platform === "win32";
    onOutput?.(`$ ${command}\n`);
    const child = spawn(isWin ? "cmd.exe" : "/bin/sh", isWin ? ["/d", "/s", "/c", command] : ["-c", command], {
      cwd,
      windowsHide: true,
      env: { ...process.env },
    });

    let out = "";
    let done = false;
    const killTree = () => {
      try {
        if (isWin && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        else child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };

    const onAbort = () => {
      killTree();
      finish(false, "\n[cancelled by user]");
    };
    if (abortSignal) abortSignal.addEventListener("abort", onAbort, { once: true });

    const finish = (ok: boolean, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      const body = clip((out + extra).trim(), MAX_OUTPUT);
      if (extra) onOutput?.(extra);
      resolve({ ok, output: body || (ok ? "(no output)" : "(command failed with no output)") });
    };

    const timer = setTimeout(() => {
      killTree();
      finish(false, `\n[timed out after ${COMMAND_TIMEOUT_MS / 1000}s and was stopped]`);
    }, COMMAND_TIMEOUT_MS);

    child.stdout?.on("data", (d) => {
      out += d.toString();
      onOutput?.(d.toString());
    });
    child.stderr?.on("data", (d) => {
      out += d.toString();
      onOutput?.(d.toString());
    });
    child.on("error", (e) => finish(false, `\n[could not start: ${e.message}]`));
    child.on("close", (code) => finish(code === 0, code === 0 ? "" : `\n[exit code ${code}]`));
  });
}

export function hashText(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return String(h >>> 0);
}

let cachedToolsCatalogue: string | null = null;

/** A compact tool catalogue for the prompt — cached since the tool specs are static. */
export function toolsForPrompt(): string {
  if (cachedToolsCatalogue) return cachedToolsCatalogue;
  cachedToolsCatalogue = TOOLS.map((t) => {
    const params = Object.entries(t.params)
      .map(([k, v]) => `${k}${v.required ? "" : "?"}: ${v.type}`)
      .join(", ");
    return `- ${t.name}(${params}) — ${t.description}`;
  }).join("\n");
  return cachedToolsCatalogue;
}

export function findTool(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name);
}
