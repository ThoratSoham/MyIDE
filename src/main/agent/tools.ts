import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import log from "electron-log";
import { verifyWebsite, type VerifyReport } from "../quality/verifier";
import { runHeadlessBrowserVerify } from "../quality/headless-verify";
import { getSettings } from "../store";
import { currentTelemetry } from "../telemetry";
import { snapshotFileForRun } from "./checkpoints";
import type { UserQuestionOption } from "../../shared/electron-api-types";
import {
  applyMultiEditsAtomically,
  detectDominantEol,
  extractSymbolsFromText,
  formatNumberedLines,
  fuzzyReplaceInText,
  type MultiEditItem,
} from "./fuzzy-edit";

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
  runId?: string;
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

export function insideWorkspace(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const normRoot = path.resolve(root);
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) {
    throw new Error(`access denied: ${rel} is outside the workspace`);
  }
  return abs;
}

export function isEnvFile(p: string): boolean {
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

function backupIfExists(root: string, abs: string, rel: string, runId?: string): void {
  if (runId) {
    try {
      snapshotFileForRun(root, runId, rel);
    } catch {
      /* ignore */
    }
  }
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
    case "replaceLines":
      return `Replacing lines ${args?.startLine ?? ""}-${args?.endLine ?? ""} in ${p || "file"}…`;
    case "grep":
      return `Searching workspace for "${String(args?.pattern ?? "").slice(0, 36)}"…`;
    case "listTree":
      return `Listing workspace tree ${p || "/"}…`;
    case "getSymbols":
      return `Extracting symbols from ${p || "file"}…`;
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

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".myide", "build", "coverage", ".next", ".cache"]);
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
  ".tar", ".exe", ".dll", ".node", ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4",
]);

function loadGitignorePatterns(root: string): RegExp[] {
  const giPath = path.join(root, ".gitignore");
  if (!fs.existsSync(giPath)) return [];
  try {
    const raw = fs.readFileSync(giPath, "utf8");
    const patterns: RegExp[] = [];
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("!")) continue;
      const clean = line.replace(/^\/+/, "").replace(/\/+$/, "");
      if (!clean) continue;
      const escaped = clean
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
      patterns.push(new RegExp(`(?:^|/)${escaped}(?:/|$)`));
    }
    return patterns;
  } catch {
    return [];
  }
}

function globToRegExp(glob: string): RegExp | null {
  const clean = glob.trim().replace(/\\/g, "/");
  if (!clean) return null;
  const escaped = clean
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(clean.includes("/") ? `^${escaped}$` : `(?:^|/)${escaped}$`, "i");
}

function walkWorkspaceFiles(root: string, subDirRel = "", maxFiles = 1500): string[] {
  const startAbs = insideWorkspace(root, subDirRel);
  if (!fs.existsSync(startAbs)) return [];
  const ignorePatterns = loadGitignorePatterns(root);
  const results: string[] = [];

  const visit = (dirAbs: string) => {
    if (results.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (SKIP_DIRS.has(entry.name)) continue;
      const childAbs = path.join(dirAbs, entry.name);
      if (isEnvFile(childAbs)) continue;
      const rel = path.relative(root, childAbs).replace(/\\/g, "/");
      if (ignorePatterns.some((re) => re.test(rel))) continue;
      if (entry.isDirectory()) {
        visit(childAbs);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!BINARY_EXTS.has(ext)) {
          results.push(rel);
        }
      }
    }
  };

  if (fs.statSync(startAbs).isFile()) {
    if (!isEnvFile(startAbs)) {
      results.push(path.relative(root, startAbs).replace(/\\/g, "/"));
    }
  } else {
    visit(startAbs);
  }
  return results;
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
    name: "listTree",
    description: "Return a compact .gitignore-aware directory tree (excludes .env and node_modules).",
    params: {
      path: { type: "string", description: "Optional subdirectory relative to workspace root ('' = root)." },
      depth: { type: "number", description: "Max recursion depth (default 3, max 6)." },
    },
    async run(args, ctx) {
      const rel = String(args?.path ?? "");
      const maxDepth = Math.max(1, Math.min(6, Number(args?.depth ?? 3) || 3));
      const startAbs = insideWorkspace(ctx.state.workspaceRoot, rel);
      if (!fs.existsSync(startAbs)) {
        return { ok: false, output: `No such directory: ${rel || "/"}.` };
      }
      const ignorePatterns = loadGitignorePatterns(ctx.state.workspaceRoot);
      const lines: string[] = [];
      let omitted = 0;
      const MAX_TREE_ENTRIES = 200;

      const walk = (dirAbs: string, depth: number, prefix: string) => {
        if (depth > maxDepth) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dirAbs, { withFileTypes: true });
        } catch {
          return;
        }
        const filtered = entries
          .filter((e) => !SKIP_DIRS.has(e.name) && !isEnvFile(e.name))
          .filter((e) => {
            const entryRel = path.relative(ctx.state.workspaceRoot, path.join(dirAbs, e.name)).replace(/\\/g, "/");
            return !ignorePatterns.some((re) => re.test(entryRel));
          })
          .sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
          });

        for (const entry of filtered) {
          if (lines.length >= MAX_TREE_ENTRIES) {
            omitted++;
            continue;
          }
          const marker = entry.isDirectory() ? "/" : "";
          lines.push(`${prefix}${entry.name}${marker}`);
          if (entry.isDirectory() && depth < maxDepth) {
            walk(path.join(dirAbs, entry.name), depth + 1, prefix + "  ");
          }
        }
      };

      walk(startAbs, 1, "");
      if (omitted > 0) {
        lines.push(`[truncated ${omitted} entries, pass path or smaller depth]`);
      }
      return { ok: true, output: lines.length > 0 ? lines.join("\n") : "(empty workspace)" };
    },
  },
  {
    name: "grep",
    description: "Fast regex/text search across workspace files (.env and node_modules excluded). Returns file:line:text.",
    params: {
      pattern: { type: "string", description: "Regex or literal search string.", required: true },
      glob: { type: "string", description: "Optional file filter glob (e.g. '*.ts' or 'src/**')." },
      maxResults: { type: "number", description: "Max matching lines to return (default 60, max 200)." },
    },
    async run(args, ctx) {
      const pattern = String(args?.pattern ?? "");
      if (!pattern) return { ok: false, output: "grep requires a non-empty 'pattern'." };
      const maxResults = Math.max(1, Math.min(200, Number(args?.maxResults ?? 60) || 60));
      const globRe = args?.glob ? globToRegExp(String(args.glob)) : null;

      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        regex = new RegExp(escaped, "i");
      }

      const files = walkWorkspaceFiles(ctx.state.workspaceRoot, "", 1500);
      const hits: string[] = [];
      let totalMatches = 0;

      for (const rel of files) {
        if (globRe && !globRe.test(rel)) continue;
        const abs = path.join(ctx.state.workspaceRoot, rel);
        let content: string;
        try {
          const st = fs.statSync(abs);
          if (st.size > 512_000) continue;
          content = fs.readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            totalMatches++;
            if (hits.length < maxResults) {
              const snippet = lines[i].length > 180 ? `${lines[i].slice(0, 177)}...` : lines[i];
              hits.push(`${rel}:${i + 1}:${snippet}`);
            }
          }
        }
      }

      if (hits.length === 0) {
        return { ok: true, output: `No matches found for "${pattern}".` };
      }
      if (totalMatches > maxResults) {
        hits.push(`[truncated ${totalMatches - maxResults} additional matches, refine pattern or glob]`);
      }
      return { ok: true, output: hits.join("\n"), data: { count: totalMatches } };
    },
  },
  {
    name: "getSymbols",
    description: "List functions, classes, interfaces, types, and exports in a file with 1-based line numbers.",
    params: {
      path: { type: "string", description: "File path relative to the workspace root.", required: true },
    },
    async run(args, ctx) {
      const rel = String(args?.path ?? "");
      const abs = insideWorkspace(ctx.state.workspaceRoot, rel);
      if (isEnvFile(abs)) return { ok: false, output: "Refused: .env files are never read (FR-5.3)." };
      if (!fs.existsSync(abs)) return { ok: false, output: `No such file: ${rel}.` };
      const text = fs.readFileSync(abs, "utf8");
      const symbols = extractSymbolsFromText(rel, text);
      if (symbols.length === 0) {
        return { ok: true, output: `No top-level symbols detected in ${rel} (${text.split(/\r?\n/).length} lines).` };
      }
      const formatted = symbols
        .slice(0, 120)
        .map((s) => `L${s.line}: ${s.exported ? "export " : ""}${s.kind} ${s.name}`)
        .join("\n");
      return { ok: true, output: formatted, data: { count: symbols.length } };
    },
  },
  {
    name: "readFile",
    description:
      "Read a text file from the workspace with 1-based line numbers. Supports startLine/endLine ranges; large files (>200 lines) show a symbol outline + first 150 lines unless a range is requested.",
    params: {
      path: { type: "string", description: "File path relative to the workspace root.", required: true },
      startLine: { type: "number", description: "Optional 1-based inclusive start line." },
      endLine: { type: "number", description: "Optional 1-based inclusive end line." },
    },
    async run(args, ctx) {
      const rel = String(args?.path ?? "");
      const abs = insideWorkspace(ctx.state.workspaceRoot, rel);
      if (isEnvFile(abs)) return { ok: false, output: "Refused: .env files are never read (FR-5.3)." };
      if (!fs.existsSync(abs)) return { ok: false, output: `No such file: ${rel}. Use listDir or listTree to check the path.` };
      const text = fs.readFileSync(abs, "utf8");
      const lines = text.split(/\r?\n/);
      const totalLines = lines.length;

      const hasRange = args?.startLine !== undefined || args?.endLine !== undefined;
      if (hasRange) {
        const start = Math.max(1, Math.min(totalLines, Number(args?.startLine ?? 1) || 1));
        const end = Math.max(start, Math.min(totalLines, Number(args?.endLine ?? Math.min(totalLines, start + 199)) || totalLines));
        const slice = lines.slice(start - 1, end);
        const header = `[${rel}: lines ${start}-${end} of ${totalLines}]`;
        const body = formatNumberedLines(slice, start);
        const tail = end < totalLines ? `\n[truncated ${totalLines - end} remaining lines, use startLine/endLine]` : "";
        return {
          ok: true,
          output: clip(`${header}\n${body}${tail}`),
          data: { hash: hashText(text), length: text.length, totalLines, startLine: start, endLine: end },
        };
      }

      if (totalLines > 200) {
        const symbols = extractSymbolsFromText(rel, text);
        const outline =
          symbols.length > 0
            ? `[Symbol Outline for ${rel} (${totalLines} lines)]\n` +
              symbols
                .slice(0, 35)
                .map((s) => `  L${s.line}: ${s.exported ? "export " : ""}${s.kind} ${s.name}`)
                .join("\n") +
              "\n\n"
            : `[${rel} (${totalLines} lines)]\n`;
        const headLines = lines.slice(0, 150);
        const omitted = totalLines - headLines.length;
        const output =
          outline +
          formatNumberedLines(headLines, 1) +
          `\n[truncated ${omitted} lines, use startLine/endLine]`;
        return {
          ok: true,
          output: clip(output),
          data: { hash: hashText(text), length: text.length, totalLines, truncatedLines: omitted },
        };
      }

      return {
        ok: true,
        output: clip(formatNumberedLines(lines, 1)),
        data: { hash: hashText(text), length: text.length, totalLines },
      };
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
      backupIfExists(ctx.state.workspaceRoot, abs, rel, ctx.state.runId);
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
    description:
      "Replace text in an existing file using { path, find, replace } or atomic multi-edit { path, edits: [{ find, replace }] }. Tolerates CRLF/LF and indentation differences when unique.",
    params: {
      path: { type: "string", description: "File path relative to the workspace root.", required: true },
      find: { type: "string", description: "Text block to replace (when performing a single edit)." },
      replace: { type: "string", description: "Replacement text (when performing a single edit)." },
      edits: { type: "array", description: "Optional atomic list of [{ find, replace }] edits in the same file." },
    },
    async run(args, ctx) {
      const rel = String(args?.path ?? "");
      if (!rel) return { ok: false, output: "editFile requires a 'path'." };
      const abs = insideWorkspace(ctx.state.workspaceRoot, rel);
      if (isEnvFile(abs)) return { ok: false, output: "Refused: .env files are never edited (FR-5.3)." };
      if (!fs.existsSync(abs)) return { ok: false, output: `No such file: ${rel}. Read it first, then edit.` };

      const text = fs.readFileSync(abs, "utf8");
      const fuzzyEnabled = getSettings().fuzzyEditMatch !== false;

      if (Array.isArray(args?.edits)) {
        const items: MultiEditItem[] = args.edits.map((e: any) => ({
          find: String(e?.find ?? ""),
          replace: String(e?.replace ?? ""),
        }));
        const multiRes = applyMultiEditsAtomically(text, items, { fuzzyEnabled, filePath: rel });
        if (!multiRes.ok || multiRes.updatedText === undefined) {
          currentTelemetry()?.recordFailedEditFile();
          return { ok: false, output: multiRes.error ?? `Multi-edit failed in ${rel}.` };
        }
        backupIfExists(ctx.state.workspaceRoot, abs, rel, ctx.state.runId);
        fs.writeFileSync(abs, multiRes.updatedText, "utf8");
        const problem = verifyWrittenFile(abs);
        if (problem) return { ok: false, output: `The edit did NOT succeed: ${problem}` };
        recordChange(ctx.state, rel, "edited");
        noteWrite(ctx.state, rel);
        return {
          ok: true,
          output: `Edited ${rel} (${multiRes.appliedCount} atomic edits applied, tier ${multiRes.tier ?? 1}, ${fs.statSync(abs).size} bytes).`,
          data: { tier: multiRes.tier ?? 1, editsApplied: multiRes.appliedCount },
        };
      }

      const find = String(args?.find ?? "");
      const replace = String(args?.replace ?? "");
      const res = fuzzyReplaceInText(text, find, replace, { fuzzyEnabled, filePath: rel });
      if (!res.ok || res.updatedText === undefined) {
        currentTelemetry()?.recordFailedEditFile();
        return { ok: false, output: res.error ?? `The text to replace was not found in ${rel}.` };
      }
      backupIfExists(ctx.state.workspaceRoot, abs, rel, ctx.state.runId);
      fs.writeFileSync(abs, res.updatedText, "utf8");
      const problem = verifyWrittenFile(abs);
      if (problem) return { ok: false, output: `The edit did NOT succeed: ${problem}` };
      recordChange(ctx.state, rel, "edited");
      noteWrite(ctx.state, rel);
      const tierNote = res.tier && res.tier > 1 ? `, fuzzy tier ${res.tier}` : "";
      return {
        ok: true,
        output: `Edited ${rel} (${fs.statSync(abs).size} bytes on disk, verified${tierNote}).`,
        data: { tier: res.tier ?? 1 },
      };
    },
  },
  {
    name: "replaceLines",
    description: "Replace 1-based inclusive line range [startLine..endLine] in an existing file with new content.",
    params: {
      path: { type: "string", description: "File path relative to the workspace root.", required: true },
      startLine: { type: "number", description: "1-based start line (inclusive).", required: true },
      endLine: { type: "number", description: "1-based end line (inclusive).", required: true },
      content: { type: "string", description: "Replacement lines (without '  N| ' line-number prefixes).", required: true },
    },
    async run(args, ctx) {
      const rel = String(args?.path ?? "");
      if (!rel) return { ok: false, output: "replaceLines requires a 'path'." };
      const abs = insideWorkspace(ctx.state.workspaceRoot, rel);
      if (isEnvFile(abs)) return { ok: false, output: "Refused: .env files are never edited (FR-5.3)." };
      if (!fs.existsSync(abs)) return { ok: false, output: `No such file: ${rel}.` };

      const text = fs.readFileSync(abs, "utf8");
      const eol = detectDominantEol(text);
      const hadFinalNewline = /\r?\n$/.test(text);
      const rawLines = text.split(/\r?\n/);
      if (hadFinalNewline && rawLines.length > 1 && rawLines[rawLines.length - 1] === "") {
        rawLines.pop();
      }
      const totalLines = rawLines.length;
      const startLine = Number(args?.startLine);
      const endLine = Number(args?.endLine);
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > totalLines) {
        currentTelemetry()?.recordFailedEditFile();
        return {
          ok: false,
          output: `Invalid line range ${startLine}-${endLine} for ${rel} (file has ${totalLines} lines, 1-based inclusive).`,
        };
      }

      const replacementNormalized = String(args?.content ?? "").replace(/\r\n/g, "\n");
      const replacementLines = replacementNormalized === "" ? [] : replacementNormalized.replace(/\n$/, "").split("\n");
      const updatedLines = [
        ...rawLines.slice(0, startLine - 1),
        ...replacementLines,
        ...rawLines.slice(endLine),
      ];
      const updatedText = updatedLines.join(eol) + (hadFinalNewline ? eol : "");

      backupIfExists(ctx.state.workspaceRoot, abs, rel, ctx.state.runId);
      fs.writeFileSync(abs, updatedText, "utf8");
      const problem = verifyWrittenFile(abs);
      if (problem) return { ok: false, output: `replaceLines did NOT succeed: ${problem}` };
      recordChange(ctx.state, rel, "edited");
      noteWrite(ctx.state, rel);
      return {
        ok: true,
        output: `Replaced lines ${startLine}-${endLine} in ${rel} (${fs.statSync(abs).size} bytes, verified).`,
      };
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
      backupIfExists(ctx.state.workspaceRoot, abs, rel, ctx.state.runId);
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
      const report = await runHeadlessBrowserVerify({
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
