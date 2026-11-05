import fs from "fs";
import path from "path";
import type { AIService } from "../ai/service";
import type { Message } from "../ai/types";
import { formatLocalTime } from "../ai/router";
import { applyParsedFileTags, parseFileTags } from "../agent/file-tags";
import { parseSuggestedFiles, type SuggestedFile } from "../agent/suggest";
import type { AgentEvent } from "../agent/loop";
import type { AgentState, ApprovalDecision } from "../agent/tools";
import { verifyWebsite, type VerifyIssue, type VerifyReport } from "../quality/verifier";
import { currentTelemetry } from "../telemetry";

// PHASE 2B: Merged single-shot Website pipeline (Brief -> Build all files in 1 call -> Local Verify -> up to 2 targeted snippet repairs).

export const MAX_WEBSITE_REPAIR_ROUNDS = 2;

export interface SingleShotWebsiteOptions {
  runId: string;
  brief: string;
  signal: { cancelled: boolean; note?: string };
  abortController: AbortController;
  onEvent: (e: AgentEvent) => void;
  requestApproval: (command: string, reason: string) => Promise<ApprovalDecision>;
  onPreview?: (rel: string) => void;
  onAgentOutput?: (chunk: string) => void;
  onSuggestedFiles?: (files: SuggestedFile[]) => void;
}

const SINGLE_SHOT_SYSTEM_PROMPT = [
  "You are Nova IDE's single-shot frontend architect.",
  "Emit ALL complete website files in a SINGLE response using <file path=\"...\">...</file> blocks.",
  "Required files: index.html, css/style.css, js/main.js (plus any inline/local SVG assets if referenced).",
  "Format strictly:",
  "<file path=\"index.html\">",
  "<!DOCTYPE html>...",
  "</file>",
  "<file path=\"css/style.css\">",
  "...",
  "</file>",
  "<file path=\"js/main.js\">",
  "...",
  "</file>",
  "Quality & Accessibility Rules (enforced by local verifier):",
  "- Exactly ONE <h1> in the hero; use <h2> inside every <section> (never skip heading levels).",
  "- At least 650 characters of real, domain-specific visible copy (zero lorem/ipsum/TODO/example.com/click here).",
  "- WCAG AA contrast >= 4.5:1 on all text; body font-size >= 16px; tap targets (a, button, input) >= 44x44px.",
  "- Responsive layout with zero horizontal overflow at 390px, 768px, and 1440px viewports.",
  "- Every content block must be visible by default without requiring JS scroll animations.",
  "- Every local href/src referenced in index.html MUST be emitted as a <file path=\"...\"> block.",
  "- Do NOT wrap <file> contents in markdown ``` fences.",
].join("\n");

function extractRelevantSnippets(
  workspaceRoot: string,
  issues: VerifyIssue[],
): Array<{ file: string; snippet: string }> {
  const failingFiles = new Set<string>();
  for (const issue of issues) {
    if (
      issue.id === "low-contrast" ||
      issue.id === "horizontal-scroll" ||
      issue.id === "small-tap-target" ||
      issue.id === "small-body-text" ||
      issue.id === "content-hidden"
    ) {
      failingFiles.add("css/style.css");
      failingFiles.add("index.html");
    } else if (issue.id === "console-error" || issue.id === "uncaught-exception") {
      failingFiles.add("js/main.js");
    } else {
      failingFiles.add("index.html");
    }
  }

  const selectors = issues
    .map((i) => i.selector)
    .filter((s): s is string => Boolean(s))
    .map((s) => s.split(/[.#\s]/).filter(Boolean)[0] ?? s);

  const out: Array<{ file: string; snippet: string }> = [];
  for (const rel of failingFiles) {
    const abs = path.join(workspaceRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);

    if (lines.length <= 50) {
      const numbered = lines.map((l, idx) => `${idx + 1}: ${l}`).join("\n");
      out.push({ file: rel, snippet: numbered });
      continue;
    }

    // Extract +/- 12 lines around matching selectors/keywords, capped at 45 lines per file
    const hitIndices = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase();
      if (selectors.some((sel) => sel && lineLower.includes(sel.toLowerCase()))) {
        for (let k = Math.max(0, i - 10); k <= Math.min(lines.length - 1, i + 10); k++) {
          hitIndices.add(k);
        }
      }
    }
    if (hitIndices.size === 0) {
      // Include head + first 35 lines as compact structural context
      for (let k = 0; k < Math.min(lines.length, 35); k++) hitIndices.add(k);
    }

    const sorted = [...hitIndices].sort((a, b) => a - b).slice(0, 45);
    const snippet = sorted.map((idx) => `${idx + 1}: ${lines[idx]}`).join("\n");
    out.push({ file: rel, snippet });
  }
  return out;
}

export function buildWebsiteRepairPrompt(workspaceRoot: string, report: VerifyReport): string {
  const errors = report.issues.filter((i) => i.severity === "error");
  const dedupedIssues: string[] = [];
  const seen = new Set<string>();
  for (const err of errors) {
    const key = `${err.id}:${err.selector ?? ""}:${err.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedIssues.push(
      `- [${err.viewport}] ${err.id}${err.selector ? ` (${err.selector})` : ""}: ${err.message} -> Fix: ${err.fixHint}`,
    );
  }

  const snippets = extractRelevantSnippets(workspaceRoot, errors);
  const failingFileList = snippets.map((s) => s.file).join(", ") || "index.html";

  const lines: string[] = [
    `Local verification found ${dedupedIssues.length} error(s) in: ${failingFileList}.`,
    "Issues to fix:",
    ...dedupedIssues.slice(0, 20),
    "",
    "Relevant snippets from failing files:",
  ];

  for (const s of snippets) {
    lines.push(`--- ${s.file} ---`, s.snippet, "");
  }

  lines.push(
    "Emit updated <file path=\"...\">...</file> blocks ONLY for the file(s) you need to change to resolve every issue above.",
  );
  return lines.join("\n");
}

async function callSingleShotModel(
  ai: AIService,
  messages: Message[],
  opts: SingleShotWebsiteOptions,
): Promise<{
  ok: boolean;
  content: string;
  modelId?: string;
  stoppedMsg?: string;
}> {
  const promptChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  const res = await ai.complete("reasoning", messages, {
    expectedOutputTokens: 2400,
    signal: opts.abortController.signal,
    cacheStaticPrefix: true,
    onDelta: (chunk) => {
      // Stream non-file-tag brief commentary if any, without dumping raw 300-line HTML into chat bubble
      if (!chunk.includes("<file") && chunk.length < 160) {
        void chunk;
      }
    },
  });

  if (res.cancelled || opts.signal.cancelled || opts.abortController.signal.aborted) {
    return { ok: false, content: "", stoppedMsg: "Stopped by the user." };
  }

  if (!res.ok) {
    if (res.authStop || res.error?.kind === "unauthorized") {
      const authMsg = res.error?.message || "Authentication failed — check your API key.";
      opts.onEvent({ type: "auth-error", message: authMsg, provider: res.laneUsed?.provider });
      return { ok: false, content: "", stoppedMsg: `Authentication error: ${authMsg}` };
    }
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
      return { ok: false, content: "", stoppedMsg: `Paused: ${fullReason}` };
    }
    return { ok: false, content: "", stoppedMsg: res.error?.message || "Model request failed." };
  }

  const content = res.content ?? "";
  const resWithOut = res as typeof res & { completionTokens?: number };
  const realIn = res.promptTokens && res.promptTokens > 15 ? res.promptTokens : Math.ceil(promptChars / 3.5);
  const realOut =
    resWithOut.completionTokens && resWithOut.completionTokens > 15
      ? resWithOut.completionTokens
      : Math.ceil(content.length / 3.5);

  currentTelemetry()?.recordModelCall({
    inputTokens: realIn,
    outputTokens: realOut,
    promptChars,
    completionChars: content.length,
  });

  return { ok: true, content, modelId: res.laneUsed?.id };
}

export async function runSingleShotWebsite(
  ai: AIService,
  state: AgentState,
  opts: SingleShotWebsiteOptions,
): Promise<string> {
  const buildMessages: Message[] = [
    { role: "system", content: SINGLE_SHOT_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Build this website and emit all files in one response using <file path="...">...</file> tags:\n\n${opts.brief}`,
    },
  ];

  const first = await callSingleShotModel(ai, buildMessages, opts);
  if (!first.ok) {
    return first.stoppedMsg ?? "Website build stopped.";
  }

  const parsedTags = parseFileTags(first.content);
  if (parsedTags.length === 0) {
    // Fallback: check if model emitted untagged markdown code blocks (`Save these files`)
    const suggested = parseSuggestedFiles(first.content);
    if (suggested.length > 0) {
      opts.onSuggestedFiles?.(suggested);
      const msg = `The model answered with untagged code blocks; ${suggested.length} file(s) are ready to save.`;
      opts.onEvent({ type: "notice", text: msg });
      opts.onEvent({ type: "done", summary: msg, model: first.modelId });
      return msg;
    }
    // Starter template was already seeded on disk before calling runSingleShotWebsite
    const fallbackMsg = "The model did not emit valid <file> blocks; starter template remains on disk.";
    opts.onEvent({ type: "notice", text: fallbackMsg });
    opts.onEvent({ type: "done", summary: fallbackMsg, model: first.modelId });
    return fallbackMsg;
  }

  opts.onEvent({
    type: "assistant",
    text: `Emitting ${parsedTags.length} website file(s) in single-shot mode…`,
    model: first.modelId,
  });

  const writeSummary = await applyParsedFileTags(
    parsedTags,
    state,
    {
      requestApproval: opts.requestApproval,
      onPreview: opts.onPreview,
      onAgentOutput: opts.onAgentOutput,
      signal: opts.signal,
      abortSignal: opts.abortController.signal,
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

  // Run local verifier on index.html
  const indexAbs = path.join(state.workspaceRoot, "index.html");
  let report = await verifyWebsite({
    pagePath: indexAbs,
    workspaceRoot: state.workspaceRoot,
    outDir: path.join(state.myideDir, "verify"),
  });
  state.lastVerify = report;
  currentTelemetry()?.recordToolCall();
  if (report.verified) {
    currentTelemetry()?.recordVerification(report.ok);
    if (report.ok) state.verifyPassedSinceChange = true;
  }
  opts.onEvent({
    type: "tool",
    name: "verifyWebsite",
    args: { path: "index.html" },
    ok: !report.verified || report.ok,
    output: report.verified
      ? report.ok
        ? "Verified across desktop, tablet, and mobile viewports: 0 errors."
        : `${report.issues.filter((i) => i.severity === "error").length} verification error(s) found.`
      : report.note ?? "Browser verifier unavailable; skipped.",
    summaryLabel: "Verifying index.html",
  });

  // Up to 2 targeted snippet-only repair rounds if verification failed
  let lastModelId = first.modelId;
  let repairRound = 0;
  while (report.verified && !report.ok && repairRound < MAX_WEBSITE_REPAIR_ROUNDS) {
    if (opts.signal.cancelled || opts.abortController.signal.aborted) {
      return "Stopped by the user.";
    }
    repairRound += 1;
    const repairPrompt = buildWebsiteRepairPrompt(state.workspaceRoot, report);
    const repairMessages: Message[] = [
      { role: "system", content: SINGLE_SHOT_SYSTEM_PROMPT },
      { role: "user", content: repairPrompt },
    ];

    const repairRes = await callSingleShotModel(ai, repairMessages, opts);
    if (!repairRes.ok) break;
    lastModelId = repairRes.modelId ?? lastModelId;

    const repairTags = parseFileTags(repairRes.content);
    if (repairTags.length === 0) break;

    await applyParsedFileTags(
      repairTags,
      state,
      {
        requestApproval: opts.requestApproval,
        onPreview: opts.onPreview,
        onAgentOutput: opts.onAgentOutput,
        signal: opts.signal,
        abortSignal: opts.abortController.signal,
      },
      (info) => {
        currentTelemetry()?.recordToolCall();
        opts.onEvent({
          type: "tool",
          name: "writeFile",
          args: { path: info.path },
          ok: info.ok,
          output: info.output,
          summaryLabel: `Repairing ${info.path} (round ${repairRound})`,
        });
      },
    );

    report = await verifyWebsite({
      pagePath: indexAbs,
      workspaceRoot: state.workspaceRoot,
      outDir: path.join(state.myideDir, "verify"),
    });
    state.lastVerify = report;
    currentTelemetry()?.recordToolCall();
    currentTelemetry()?.recordVerification(report.ok);
    if (report.ok) state.verifyPassedSinceChange = true;

    opts.onEvent({
      type: "tool",
      name: "verifyWebsite",
      args: { path: "index.html" },
      ok: report.ok,
      output: report.ok
        ? `Repair round ${repairRound} verified clean (0 errors).`
        : `Repair round ${repairRound}: ${report.issues.filter((i) => i.severity === "error").length} error(s) remain.`,
      summaryLabel: `Re-verifying index.html (round ${repairRound})`,
    });
  }

  const fileNames = writeSummary.written.map((w) => w.path).join(", ");
  const verifyNote = !report.verified
    ? "browser verifier skipped"
    : report.ok
    ? `verified clean${repairRound > 0 ? ` after ${repairRound} repair round(s)` : " on first pass"}`
    : `${report.issues.filter((i) => i.severity === "error").length} issue(s) remain after ${repairRound} repair round(s)`;

  const summary = `Built website (${fileNames || "index.html"}) — ${verifyNote}.`;
  opts.onEvent({ type: "done", summary, model: lastModelId });
  return summary;
}
