const test = require("node:test");
const assert = require("node:assert/strict");

const { routeIntent } = require("../dist/shared/intent");

test("Phase 6: Engineering prompt paste protection routes to agent, never website", () => {
  // Real prompt that previously broke routing because of words like "site" and "page"
  const engineeringPrompt = `You are a senior engineer working on Nova IDE (MyIDE): Electron + Vite + React + TypeScript, with a strict security boundary (contextIsolation: true, nodeIntegration: false, sandbox: true, typed IPC bridge, keys only in the main process via safeStorage). 

GOAL
The website builder produces weak, generic, sometimes broken sites. Fix the root causes below so that a prompt like "make a neo brutalism landing page" gives a good-looking, complete, working site, even on free-tier models. Do not ask me questions. Implement everything end to end, run typecheck/lint/tests/build after each phase, fix errors before moving on, and commit after each phase. Do not weaken the security model (workspace path validation, .env blocking, command approval, backups in .myide/backups, trash in .myide/trash, sanitized terminal env).

ROOT CAUSES OBSERVED IN REAL LOGS
- The build said "Emitting 1 website file(s)" but index.html referenced css/style.css and js/main.js, so assets were missing and verification failed.
- When the best lane hit a 429, the build silently fell through to weaker lanes (gemini-2.5-flash -> flash-lite -> groq gpt-oss-120b). Each repair round used a different model, so the style drifted and the bugs stayed.
- Groq lanes are capped at 5,500 output tokens, which is too small for a single-shot site (reasoning models also burn part of that cap on thinking).
- "Verified" only means the static HTML check passed. Nothing evaluates how the page looks.
- "Apply neo brutalism" was passed as a vague adjective, so the model produced a generic template.
- "continue" re-triggered the clarification chips instead of resuming the failed run.
- Rewritten files were shown as "edited +N/-0" (zero deletions), which suggests either a wrong diff counter or new content being appended to old content (possible duplicate <html> blocks).
- A long pasted engineering prompt was routed to the website pipeline just because of keywords.

==================================================
PHASE 1: COMPLETE FILE SET (no missing assets, no duplicate roots, correct diffs)
==================================================
1. Manifest step before generation:
   - Determine the required file set before prompting.
   - For simple landing pages on free tier: prefer a SINGLE self-contained index.html (inline <style> and <script>, inline SVG graphics or icons, zero external local asset dependencies).
   - If multiple files are truly needed (e.g. user asked for separate CSS/JS, or output token budget allows): the manifest lists every required file with its purpose.
   - In both cases, pass the manifest to the generator prompt: "Emit EXACTLY these files: [list]. Every local href or src in index.html MUST correspond to a file in this list or an inline asset. Do not reference files outside this list."
2. Reference-closure checker (runs after file emission, before verification):
   - Parse all local href=, src=, url(...) references across all emitted files.
   - If index.html references css/style.css or js/main.js and that file was not emitted:
     a) If the content of the missing asset is already present inline in index.html, rewrite the tag to use the inline version (or drop the external reference).
     b) If not present, auto-create a minimal working stub or trigger a targeted repair request for only the missing file before running verification.
3. Duplicate document validator:
   - Reject any file that contains multiple <!DOCTYPE>, <html>, or <body> blocks.
   - If detected, strip out the extra envelope tags or keep only the inner content before saving to disk.
4. Diff bug fix:
   - Fix the diff counter so rewritten files show accurate additions and deletions (e.g. +312/-298), not +N/-0.
   - Ensure the snapshot of the file before the run is captured and compared against the new content.`;

  assert.ok(engineeringPrompt.length > 1500, `Prompt length ${engineeringPrompt.length} should exceed 1500 chars`);

  const routed = routeIntent(engineeringPrompt);

  // Must route to AGENT with high confidence, NOT website!
  assert.equal(routed.intent, "agent");
  assert.equal(routed.confidence, "high");
  assert.match(routed.reason, /engineering prompt/i);
});

test("Phase 6: Short follow-up 'continue' resumes previous run without clarification", () => {
  const lastRun = {
    id: "run-site-999",
    intent: "website",
    userPrompt: "Build a bakery site",
    status: "paused",
    pinnedLane: "gemini/gemini-2.5-flash",
  };

  const routed = routeIntent("continue", lastRun);

  assert.equal(routed.intent, "website");
  assert.equal(routed.confidence, "high");
  assert.match(routed.reason, /resuming previous website run/i);
});

test("Phase 6: Short follow-up 'apply dark neon' routes to incremental website restyle", () => {
  const lastRun = {
    id: "run-site-999",
    intent: "website",
    userPrompt: "Build a bakery site",
    status: "done",
    pinnedLane: "gemini/gemini-2.5-flash",
  };

  const routed = routeIntent("apply dark neon", lastRun);

  assert.equal(routed.intent, "website");
  assert.equal(routed.confidence, "high");
  assert.match(routed.reason, /incremental website edit\/restyle/i);
});

test("Phase 6: 'fix it' follow-up preserves previous run intent with high confidence", () => {
  const lastRun = {
    id: "run-agent-123",
    intent: "agent",
    userPrompt: "Fix build script",
    status: "failed",
    pendingIssues: ["TypeError in build.ts"],
  };

  const routed = routeIntent("fix it", lastRun);

  assert.equal(routed.intent, "agent");
  assert.equal(routed.confidence, "high");
  assert.match(routed.reason, /fixing issues/i);
});

