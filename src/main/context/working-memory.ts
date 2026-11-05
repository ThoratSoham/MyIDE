import type { Message } from "../ai/types";
import { estimateInputTokens } from "../ai/tokenize";

// PHASE 4C: Rolling Working Memory & 1-Line Tool-Result Stubber.
// Preserves messages[0] (byte-identical static system prompt) and messages[1] (user goal),
// keeps the last 2-3 turns verbatim, converts older tool outputs into 1-line stubs, and
// folds evicted turns into a structured `[Working Memory]` block.

export interface WorkingMemoryState {
  goal: string;
  filesTouched: Set<string>;
  decisionsAndOutcomes: string[];
  openIssues: string[];
  customSummary?: string;
}

export interface CompressHistoryOptions {
  tokenBudget?: number;
  keepRecentMessages?: number;
  rollingSummaryEnabled?: boolean;
  summarizeFn?: (evictedDigest: string) => Promise<string | null>;
}

export interface CompressedHistoryResult {
  messages: Message[];
  workingMemoryBlock: string;
  evictedCount: number;
}

export function createWorkingMemory(goal: string): WorkingMemoryState {
  return {
    goal: goal.slice(0, 360).trim(),
    filesTouched: new Set(),
    decisionsAndOutcomes: [],
    openIssues: [],
  };
}

/**
 * Converts a verbose `<tool_result>` or `<tool_results>` message into a compact 1-line stub
 * (e.g. `readFile src/a.ts: 212 lines, ok`).
 */
export function stubToolResultContent(content: string): string {
  const singleMatch = /^<tool_result\s+name="([^"]+)"\s+ok="([^"]+)">([\s\S]*?)<\/tool_result>\s*$/.exec(
    content.trim(),
  );
  if (singleMatch) {
    const [, toolName, okStr, body] = singleMatch;
    return summarizeSingleToolStub(toolName, okStr === "true", body);
  }

  if (content.trimStart().startsWith("<tool_results")) {
    const itemRe = /<tool_result\s+index="\d+"\s+name="([^"]+)"\s+ok="([^"]+)">([\s\S]*?)<\/tool_result>/g;
    const stubs: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(content)) !== null) {
      stubs.push(summarizeSingleToolStub(m[1], m[2] === "true", m[3]));
    }
    const autoVerifyFailed = /\[Auto-verify FAILED\]/.test(content);
    const suffix = autoVerifyFailed ? " | Auto-verify FAILED" : "";
    if (stubs.length > 0) {
      return `[Tool batch stub] ${stubs.join("; ")}${suffix}`;
    }
  }

  return content.length > 220 ? `${content.slice(0, 217).replace(/\s+/g, " ")}…` : content;
}

function summarizeSingleToolStub(toolName: string, ok: boolean, rawBody: string): string {
  const body = rawBody.trim();
  const status = ok ? "ok" : "FAILED";

  if (toolName === "readFile") {
    const pathMatch = /\[([^:\]]+):\s*lines\s*(\d+-\d+)\s*of\s*(\d+)\]/.exec(body) ?? /Outline for ([^\s(]+)\s*\((\d+) lines\)/.exec(body);
    if (pathMatch) {
      return `readFile ${pathMatch[1]}: ${pathMatch[2]} lines, ${status}`;
    }
    const lineCount = body ? body.split(/\r?\n/).length : 0;
    return `readFile: ${lineCount} lines, ${status}`;
  }

  if (toolName === "writeFile" || toolName === "editFile" || toolName === "replaceLines") {
    const fileMatch = /(?:Wrote|Edited|Replaced lines [0-9-]+ in)\s+([^\s(]+)/.exec(body);
    const target = fileMatch ? ` ${fileMatch[1]}` : "";
    if (!ok) {
      const firstLine = body.split(/\r?\n/)[0]?.slice(0, 90) ?? "failed";
      return `${toolName}${target}: ${status} (${firstLine})`;
    }
    return `${toolName}${target}: ${status}`;
  }

  if (toolName === "grep") {
    const lineCount = body.startsWith("No matches") ? 0 : body.split(/\r?\n/).length;
    return `grep: ${lineCount} match line(s), ${status}`;
  }

  const oneLine = body.split(/\r?\n/)[0]?.slice(0, 80) ?? "";
  return `${toolName}: ${status}${oneLine ? ` (${oneLine})` : ""}`;
}

function absorbEvictedMessageIntoMemory(mem: WorkingMemoryState, msg: Message): void {
  const text = msg.content;
  // Extract file paths mentioned in writeFile/editFile/readFile JSON or stubs
  const pathRe = /"path"\s*:\s*"([^"]+)"|(?:Wrote|Edited|readFile|writeFile|editFile|replaceLines)\s+([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(text)) !== null) {
    const p = (m[1] ?? m[2] ?? "").trim();
    if (p) mem.filesTouched.add(p);
  }

  if (msg.role === "user" && (text.startsWith("<tool_result") || text.startsWith("[Tool batch stub]"))) {
    const stub = stubToolResultContent(text);
    if (mem.decisionsAndOutcomes.length < 10) {
      mem.decisionsAndOutcomes.push(stub.slice(0, 140));
    } else {
      mem.decisionsAndOutcomes.shift();
      mem.decisionsAndOutcomes.push(stub.slice(0, 140));
    }
    if (/ok="false"|FAILED|error/i.test(stub)) {
      if (mem.openIssues.length >= 4) mem.openIssues.shift();
      mem.openIssues.push(stub.slice(0, 140));
    } else if (mem.openIssues.length > 0 && /ok\b/.test(stub)) {
      // Clear resolved issue on subsequent green step
      mem.openIssues.pop();
    }
  }
}

export function formatWorkingMemoryBlock(mem: WorkingMemoryState): string {
  if (
    !mem.customSummary &&
    mem.filesTouched.size === 0 &&
    mem.decisionsAndOutcomes.length === 0 &&
    mem.openIssues.length === 0
  ) {
    return "";
  }
  const lines: string[] = ["[Working Memory]"];
  if (mem.goal) lines.push(`Goal: ${mem.goal}`);
  if (mem.filesTouched.size > 0) {
    lines.push(`Files touched: ${[...mem.filesTouched].slice(0, 16).join(", ")}`);
  }
  if (mem.customSummary) {
    lines.push(`Summary: ${mem.customSummary}`);
  } else if (mem.decisionsAndOutcomes.length > 0) {
    lines.push(`Completed steps: ${mem.decisionsAndOutcomes.slice(-6).join(" | ")}`);
  }
  if (mem.openIssues.length > 0) {
    lines.push(`Open issues: ${mem.openIssues.join(" | ")}`);
  }
  return lines.join("\n");
}

export async function compressConversationHistory(
  history: Message[],
  mem: WorkingMemoryState,
  opts: CompressHistoryOptions = {},
): Promise<CompressedHistoryResult> {
  const budget = Math.max(250, opts.tokenBudget ?? 4_800);
  const keepRecent = Math.max(2, opts.keepRecentMessages ?? 6);
  const rollingEnabled = opts.rollingSummaryEnabled !== false;

  if (history.length <= 2) {
    return {
      messages: [...history],
      workingMemoryBlock: formatWorkingMemoryBlock(mem),
      evictedCount: 0,
    };
  }

  // Always keep messages[0] (static system prompt) and messages[1] (user goal) untouched!
  const head = [history[0], history[1]];
  const rest = history.slice(2);
  const tailCount = Math.min(keepRecent, rest.length);
  const tail = rest.slice(rest.length - tailCount);
  const older = rest.slice(0, rest.length - tailCount);

  // Convert older tool outputs to 1-line stubs first
  const stubbedOlder: Message[] = older.map((m) => {
    if (m.role === "user" && m.content.trimStart().startsWith("<tool_result")) {
      return { role: "user", content: stubToolResultContent(m.content) };
    }
    if (m.role === "assistant" && m.content.length > 260) {
      return { role: "assistant", content: `${m.content.slice(0, 257)}…` };
    }
    return m;
  });

  let evictedCount = 0;
  const evictedTexts: string[] = [];

  const calcTokens = (mid: Message[], memText: string) => {
    const joined = [
      head[0].content,
      head[1].content,
      memText,
      ...mid.map((x) => x.content),
      ...tail.map((x) => x.content),
    ]
      .filter(Boolean)
      .join("\n");
    return estimateInputTokens(joined);
  };

  while (stubbedOlder.length > 0 && calcTokens(stubbedOlder, formatWorkingMemoryBlock(mem)) > budget) {
    const evicted = stubbedOlder.shift()!;
    evictedCount++;
    evictedTexts.push(`${evicted.role}: ${evicted.content}`);
    if (rollingEnabled) {
      absorbEvictedMessageIntoMemory(mem, evicted);
    }
  }

  if (rollingEnabled && evictedTexts.length >= 4 && opts.summarizeFn) {
    try {
      const llmSummary = await opts.summarizeFn(evictedTexts.join("\n").slice(0, 3000));
      if (llmSummary && llmSummary.trim()) {
        mem.customSummary = llmSummary.trim().slice(0, 500);
      }
    } catch {
      /* keep deterministic working memory */
    }
  }

  const workingMemoryBlock = rollingEnabled ? formatWorkingMemoryBlock(mem) : "";
  const outMessages: Message[] = [...head];
  if (workingMemoryBlock) {
    outMessages.push({ role: "user", content: workingMemoryBlock });
  } else if (evictedCount > 0) {
    outMessages.push({
      role: "user",
      content: `[Context note: ${evictedCount} older step(s) omitted to fit ${budget}-token budget.]`,
    });
  }
  outMessages.push(...stubbedOlder, ...tail);

  return {
    messages: outMessages,
    workingMemoryBlock,
    evictedCount,
  };
}
