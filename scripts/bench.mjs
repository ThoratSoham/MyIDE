#!/usr/bin/env node
/**
 * Nova IDE (MyIDE) Free-Tier Efficiency Benchmark (`npm run bench`)
 *
 * Runs 5 fixed scripted engineering tasks end-to-end through the real compiled
 * JobManager + Agent Loop + Tools + Telemetry against a deterministic mock
 * provider (zero network). The mock provider inspects ONLY the real prompt
 * schema and context sent by MyIDE (whether batched `actions` are supported,
 * whether `<file path="...">` single-shot emission is requested, whether a
 * `[Workspace Repo Map]` or `[Retrieved Context]` is already present, whether
 * `grep` is available, and whether `autoVerifyAfterEdits` already verified).
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const { installElectronStub, stubModule, freshWorkspace, waitForIdle } = require(
  path.join(ROOT, "tests/helpers/harness.js"),
);

installElectronStub();

// Deterministic local HTML/CSS/JS verifier for the benchmark so `npm run bench`
// runs in ~1s on any machine/CI without launching external Chrome processes,
// while still checking real files, local asset links, headings, and copy length.
const verifierPath = path.join(ROOT, "dist/main/quality/verifier.js");
if (fs.existsSync(verifierPath)) {
  stubModule(verifierPath, {
    VIEWPORTS: [
      { name: "desktop", width: 1440, height: 900 },
      { name: "tablet", width: 768, height: 1024 },
      { name: "mobile", width: 390, height: 844 },
    ],
    findBrowserPath: () => "mock-headless-verifier",
    async verifyWebsite(opts) {
      const issues = [];
      if (!fs.existsSync(opts.pagePath)) {
        return {
          ok: false,
          verified: true,
          issues: [{ id: "missing-page", severity: "error", viewport: "desktop", message: "index.html missing", fixHint: "Create index.html" }],
          screenshots: [],
          textLength: 0,
          pageWeightBytes: 0,
        };
      }
      const html = fs.readFileSync(opts.pagePath, "utf8");
      const baseDir = path.dirname(opts.pagePath);
      const strippedText = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const h1Matches = html.match(/<h1\b/gi) || [];
      if (h1Matches.length !== 1) {
        issues.push({
          id: "h1-count",
          severity: "error",
          viewport: "desktop",
          message: `page has ${h1Matches.length} h1 elements (need exactly 1)`,
          fixHint: "Use one h1.",
        });
      }
      if (strippedText.length < 600) {
        issues.push({
          id: "thin-content",
          severity: "error",
          viewport: "desktop",
          message: `only ${strippedText.length} characters of visible text (need > 600)`,
          fixHint: "Add real copy.",
        });
      }
      const refRe = /(?:href|src)=["']([^"']+)["']/gi;
      let m;
      while ((m = refRe.exec(html)) !== null) {
        const ref = m[1];
        if (/^(https?:|data:|blob:|#|mailto:|tel:)/i.test(ref)) continue;
        const clean = ref.split("?")[0].split("#")[0];
        if (!fs.existsSync(path.resolve(baseDir, clean))) {
          issues.push({
            id: "missing-local-file",
            severity: "error",
            viewport: "desktop",
            message: `missing local file: ${ref}`,
            fixHint: "Create referenced asset.",
          });
        }
      }
      if (/\b(lorem|ipsum|todo|your company|example\.com)\b/i.test(strippedText)) {
        issues.push({
          id: "placeholder-text",
          severity: "error",
          viewport: "desktop",
          message: "placeholder word found",
          fixHint: "Use real copy.",
        });
      }
      return {
        ok: issues.length === 0,
        verified: true,
        issues,
        screenshots: [{ viewport: "desktop", file: path.join(opts.outDir, "desktop.png") }],
        textLength: strippedText.length,
        pageWeightBytes: Buffer.byteLength(html, "utf8"),
      };
    },
  });
}

const { JobManager } = require(path.join(ROOT, "dist/main/jobs.js"));
const { setWorkspaceRoot } = require(path.join(ROOT, "dist/main/fs-workspace.js"));

// ---- Rich content fixtures used by the mock model -------------------------

const AURORA_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Aurora Tea Co — Small-Batch Botanical & Loose-Leaf Teas</title>
  <link rel="stylesheet" href="css/style.css" />
</head>
<body>
  <header class="site-header">
    <nav class="nav" aria-label="Primary">
      <a class="brand" href="#hero">Aurora Tea Co</a>
      <div class="nav-links">
        <a href="#menu">Tea Menu</a>
        <a href="#story">Our Story</a>
        <a href="#contact">Visit & Contact</a>
      </div>
    </nav>
  </header>
  <main>
    <section id="hero" class="hero">
      <h1>Small-Batch Botanical Teas Steeped in Calm</h1>
      <p>Aurora Tea Co sources single-garden loose-leaf harvests from high-elevation farms in Kyoto, Darjeeling, and Nantou. Every tin is blended fresh each week in Seattle with organic flowers, roasted grains, and cold-pressed citrus peel.</p>
      <a class="cta-btn" href="#menu">Explore Seasonal Harvest</a>
    </section>
    <section id="menu" class="menu-section">
      <h2>Seasonal Loose-Leaf Menu</h2>
      <div class="cards">
        <article class="card">
          <h3>Cloud Mist Sencha</h3>
          <p>First-flush steamed green tea from Uji with sweet umami depth, crisp marine aroma, and a lingering velvety finish.</p>
        </article>
        <article class="card">
          <h3> roasted Hojicha & Fig</h3>
          <p>Slow-roasted bancha stems layered with California black mission figs, toasted buckwheat, and warm cedar notes.</p>
        </article>
        <article class="card">
          <h3>Alpine Chamomile Bergamot</h3>
          <p>Caffeine-free whole chamomile blossoms brightened with Calabrian bergamot oil, lemon verbena, and wildflower honeybush.</p>
        </article>
      </div>
    </section>
    <section id="story" class="story-section">
      <h2>Direct-Trade Craft Since 2018</h2>
      <p>We partner directly with family-run tea gardens that harvest by hand at dawn and process leaves within four hours of plucking. Our tasting room pours gongfu flights daily so guests can compare terroir, cultivar, and roast profile side by side.</p>
    </section>
    <section id="contact" class="contact-section">
      <h2>Visit Our Tasting Room</h2>
      <p>Open Tuesday through Sunday, 8:00 AM to 7:00 PM at 418 Pinehurst Way, Seattle, WA. Private tastings and wholesale inquiries welcome by appointment.</p>
    </section>
  </main>
  <script src="js/main.js"></script>
</body>
</html>
`;

const AURORA_CSS = `:root {
  --bg: #0f1715;
  --surface: #182421;
  --text: #f3f6f4;
  --accent: #d4a359;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  background: var(--bg);
  color: var(--text);
}
.nav, main { max-width: 1080px; margin: 0 auto; padding: 1.25rem; }
.nav { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.nav a, .cta-btn {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  min-width: 44px;
  padding: 0.6rem 1rem;
  color: var(--text);
  text-decoration: none;
}
.cta-btn { background: var(--accent); color: #111; font-weight: 700; border-radius: 8px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; }
.card { background: var(--surface); padding: 1.25rem; border-radius: 10px; }
`;

const AURORA_JS = `document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (e) => {
    const id = link.getAttribute("href")?.slice(1);
    const target = id ? document.getElementById(id) : null;
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth" });
    }
  });
});
`;

// ---- Capability-aware mock AI provider per task ---------------------------

function makeBenchAI(responder) {
  let step = 0;
  return {
    onWaiting: null,
    lastFailure: null,
    isOfflineMode: () => false,
    providerLabels: () => ({ gemini: "Google Gemini", groq: "Groq", openrouter: "OpenRouter", offline: "Offline" }),
    quotaSnapshot: () => [],
    clearCooldownsForRetry() {},
    init() {},
    reload() {},
    save() {},
    async complete(taskClass, messages, options) {
      step += 1;
      const fullPrompt = messages.map((m) => m.content || "").join("\n");
      const content = await responder({ taskClass, messages, fullPrompt, step, options });
      const promptTokens = Math.ceil(fullPrompt.length / 3.5);
      const completionTokens = Math.ceil(content.length / 3.5);
      if (options?.onDelta) {
        options.onDelta(content);
      }
      return {
        ok: true,
        content,
        laneUsed: { id: "gemini:gemini-2.5-flash", provider: "gemini", model: "gemini-2.5-flash", role: "reasoning", limits: { rpm: 15, rpd: 500, tpm: null, maxTokensPerRequest: null, resetHourUtc: 0 } },
        promptTokens,
        completionTokens,
      };
    },
  };
}

function detectCapabilities(fullPrompt) {
  return {
    singleShotFileTags: /<file\s+path=/i.test(fullPrompt) && /single\s+(?:response|call|turn)|emit\s+all\s+files/i.test(fullPrompt),
    batchedActions: /"actions"\s*:\s*\[/.test(fullPrompt),
    hasRepoMap: /\[Workspace Repo Map\]/i.test(fullPrompt),
    hasRetrievedContext: /\[Retrieved Context\]/i.test(fullPrompt),
    hasGrepTool: /\bgrep\s*\(/.test(fullPrompt),
    hasAutoVerify: /\[Auto-verify\]/i.test(fullPrompt),
  };
}

// 1. Task: Create a small website
function responderCreateWebsite({ fullPrompt, step }) {
  const caps = detectCapabilities(fullPrompt);
  if (caps.singleShotFileTags) {
    return [
      `<file path="index.html">\n${AURORA_HTML}</file>`,
      `<file path="css/style.css">\n${AURORA_CSS}</file>`,
      `<file path="js/main.js">\n${AURORA_JS}</file>`,
    ].join("\n\n");
  }

  if (caps.batchedActions) {
    if (step === 1) {
      return JSON.stringify({
        thought: "Writing index.html, css/style.css, js/main.js and verifying in one batch.",
        actions: [
          { tool: "writeFile", args: { path: "index.html", content: AURORA_HTML } },
          { tool: "writeFile", args: { path: "css/style.css", content: AURORA_CSS } },
          { tool: "writeFile", args: { path: "js/main.js", content: AURORA_JS } },
          { tool: "verifyWebsite", args: { path: "index.html" } },
        ],
      });
    }
    return JSON.stringify({
      thought: "All website files written and verified.",
      tool: "markComplete",
      args: { summary: "Built and verified the Aurora Tea Co responsive landing page." },
    });
  }

  // Phase 0 baseline: single tool call per turn
  if (step === 1) return JSON.stringify({ thought: "Write index.html", tool: "writeFile", args: { path: "index.html", content: AURORA_HTML } });
  if (step === 2) return JSON.stringify({ thought: "Write css/style.css", tool: "writeFile", args: { path: "css/style.css", content: AURORA_CSS } });
  if (step === 3) return JSON.stringify({ thought: "Write js/main.js", tool: "writeFile", args: { path: "js/main.js", content: AURORA_JS } });
  if (step === 4) return JSON.stringify({ thought: "Verify index.html", tool: "verifyWebsite", args: { path: "index.html" } });
  return JSON.stringify({ thought: "Website verified.", tool: "markComplete", args: { summary: "Built Aurora Tea Co landing page." } });
}

// 2. Task: Fix a TS error (file on disk uses CRLF + 4-space indentation)
function createFixTsResponder() {
  let state = "start";
  return ({ fullPrompt }) => {
    const caps = detectCapabilities(fullPrompt);
    const lastResultFailedEdit = /The text to replace was not found|Closest matches/i.test(
      fullPrompt.slice(-1400),
    );

    if (state === "start") {
      if (caps.hasRepoMap || caps.hasRetrievedContext) {
        if (caps.hasRetrievedContext) {
          // Already sees formatUser body in retrieved context! Edit immediately.
          state = "edited";
          return JSON.stringify({
            thought: "Fix u.fullName -> u.name in src/format.ts.",
            tool: "editFile",
            args: {
              path: "src/format.ts",
              // Deliberate 2-space indent (disk has 4-space + CRLF) to test fuzzyEditMatch
              find: "export function formatUser(u: User): string {\n  return u.fullName.trim();\n}",
              replace: "export function formatUser(u: User): string {\n  return u.name.trim();\n}",
            },
          });
        }
        state = "read";
        if (caps.batchedActions) {
          return JSON.stringify({
            thought: "Read src/user.ts and src/format.ts in parallel.",
            actions: [
              { tool: "readFile", args: { path: "src/user.ts" } },
              { tool: "readFile", args: { path: "src/format.ts" } },
            ],
          });
        }
        return JSON.stringify({ thought: "Read src/user.ts", tool: "readFile", args: { path: "src/user.ts" } });
      }
      state = "listed_root";
      return JSON.stringify({ thought: "List workspace files.", tool: "listDir", args: { path: "." } });
    }

    if (state === "listed_root") {
      if (caps.batchedActions) {
        state = "read";
        return JSON.stringify({
          thought: "Read src directory and TS files.",
          actions: [
            { tool: "readFile", args: { path: "src/user.ts" } },
            { tool: "readFile", args: { path: "src/format.ts" } },
          ],
        });
      }
      state = "listed_src";
      return JSON.stringify({ thought: "List src/", tool: "listDir", args: { path: "src" } });
    }

    if (state === "listed_src") {
      state = "read_user";
      return JSON.stringify({ thought: "Read src/user.ts", tool: "readFile", args: { path: "src/user.ts" } });
    }

    if (state === "read_user") {
      state = "read";
      return JSON.stringify({ thought: "Read src/format.ts", tool: "readFile", args: { path: "src/format.ts" } });
    }

    if (state === "read") {
      state = "edited";
      // Realistic free-tier model behavior: emits LF + 2-space indent against a 4-space CRLF file
      return JSON.stringify({
        thought: "Update u.fullName to u.name in src/format.ts.",
        tool: "editFile",
        args: {
          path: "src/format.ts",
          find: "export function formatUser(u: User): string {\n  return u.fullName.trim();\n}",
          replace: "export function formatUser(u: User): string {\n  return u.name.trim();\n}",
        },
      });
    }

    if (state === "edited" && lastResultFailedEdit) {
      state = "edited_exact";
      return JSON.stringify({
        thought: "Retry editFile with exact 4-space CRLF text.",
        tool: "editFile",
        args: {
          path: "src/format.ts",
          find: "    return u.fullName.trim();",
          replace: "    return u.name.trim();",
        },
      });
    }

    if (state === "edited" || state === "edited_exact") {
      // If Phase 2+ auto-verify is enabled in prompt/system, we don't need an extra manual tsc turn
      if (/auto-verified|Auto-verify enabled/i.test(fullPrompt)) {
        state = "done";
        return JSON.stringify({
          thought: "Typecheck clean via auto-verify.",
          tool: "markComplete",
          args: { summary: "Fixed Property 'fullName' does not exist on type 'User' in src/format.ts." },
        });
      }
      state = "verified";
      return JSON.stringify({
        thought: "Run tsc to verify the fix.",
        tool: "executeCommand",
        args: { command: "node -e \"const fs=require('fs'); if(fs.readFileSync('src/format.ts','utf8').includes('fullName')) process.exit(1);\"", reason: "Check TypeScript fix" },
      });
    }

    return JSON.stringify({
      thought: "Fix verified.",
      tool: "markComplete",
      args: { summary: "Fixed Property 'fullName' does not exist on type 'User' in src/format.ts." },
    });
  };
}

// 3. Task: Add a function plus unit test
function createAddFnResponder() {
  let stage = 0;
  const impl = `export function slugify(input) {\n  return String(input ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\n`;
  const testCode = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "./slugify.js";\n\ntest("slugify normalizes strings", () => {\n  assert.equal(slugify("Hello Nova IDE!"), "hello-nova-ide");\n});\n`;

  return ({ fullPrompt }) => {
    const caps = detectCapabilities(fullPrompt);
    stage += 1;

    if (caps.batchedActions && caps.hasRepoMap) {
      if (stage === 1) {
        return JSON.stringify({
          thought: "Write slugify implementation, unit test, and run node --test in one batch.",
          actions: [
            { tool: "writeFile", args: { path: "src/slugify.js", content: impl } },
            { tool: "writeFile", args: { path: "src/slugify.test.js", content: testCode } },
            { tool: "executeCommand", args: { command: "node --test src/slugify.test.js", reason: "Run unit test" } },
          ],
        });
      }
      return JSON.stringify({
        thought: "Implementation and unit test passed.",
        tool: "markComplete",
        args: { summary: "Added slugify() in src/slugify.js and passing unit test in src/slugify.test.js." },
      });
    }

    if (caps.batchedActions) {
      if (stage === 1) {
        return JSON.stringify({
          thought: "Inspect workspace and existing src/slugify.js.",
          actions: [
            { tool: "listDir", args: { path: "." } },
            { tool: "readFile", args: { path: "src/slugify.js" } },
          ],
        });
      }
      if (stage === 2) {
        return JSON.stringify({
          thought: "Write slugify.js, slugify.test.js, and run test.",
          actions: [
            { tool: "writeFile", args: { path: "src/slugify.js", content: impl } },
            { tool: "writeFile", args: { path: "src/slugify.test.js", content: testCode } },
            { tool: "executeCommand", args: { command: "node --test src/slugify.test.js", reason: "Run unit test" } },
          ],
        });
      }
      return JSON.stringify({
        thought: "Tests green.",
        tool: "markComplete",
        args: { summary: "Added slugify() and unit test." },
      });
    }

    // Phase 0 single-tool baseline
    if (stage === 1) return JSON.stringify({ thought: "List root", tool: "listDir", args: { path: "." } });
    if (stage === 2) return JSON.stringify({ thought: "Read src/slugify.js", tool: "readFile", args: { path: "src/slugify.js" } });
    if (stage === 3) return JSON.stringify({ thought: "Write src/slugify.js", tool: "writeFile", args: { path: "src/slugify.js", content: impl } });
    if (stage === 4) return JSON.stringify({ thought: "Write src/slugify.test.js", tool: "writeFile", args: { path: "src/slugify.test.js", content: testCode } });
    if (stage === 5) return JSON.stringify({ thought: "Run test", tool: "executeCommand", args: { command: "node --test src/slugify.test.js", reason: "Run unit test" } });
    return JSON.stringify({ thought: "Done", tool: "markComplete", args: { summary: "Added slugify() and unit test." } });
  };
}

// 4. Task: Rename symbol across 4 files (with a 250-line unrelated file in src/)
function createRenameResponder() {
  let stage = 0;
  let edited = false;
  const edits = [
    {
      path: "src/constants.ts",
      find: 'export const APP_TITLE = "Nova";',
      replace: 'export const BRAND_NAME = "Nova";',
    },
    {
      path: "src/header.ts",
      find: 'import { APP_TITLE } from "./constants";\nexport const renderHeader = () => `<header>${APP_TITLE}</header>`;',
      replace: 'import { BRAND_NAME } from "./constants";\nexport const renderHeader = () => `<header>${BRAND_NAME}</header>`;',
    },
    {
      path: "src/footer.ts",
      find: 'import { APP_TITLE } from "./constants";\nexport const renderFooter = () => `<footer>© ${APP_TITLE}</footer>`;',
      replace: 'import { BRAND_NAME } from "./constants";\nexport const renderFooter = () => `<footer>© ${BRAND_NAME}</footer>`;',
    },
    {
      path: "src/index.ts",
      find: 'import { APP_TITLE } from "./constants";\nconsole.log(APP_TITLE);',
      replace: 'import { BRAND_NAME } from "./constants";\nconsole.log(BRAND_NAME);',
    },
  ];

  return ({ fullPrompt }) => {
    const caps = detectCapabilities(fullPrompt);
    stage += 1;

    if (edited) {
      return JSON.stringify({
        thought: "Renamed across all 4 files.",
        tool: "markComplete",
        args: { summary: "Renamed APP_TITLE to BRAND_NAME across constants.ts, header.ts, footer.ts, and index.ts." },
      });
    }

    if (caps.batchedActions && caps.hasRetrievedContext) {
      edited = true;
      return JSON.stringify({
        thought: "Retrieved context already shows all 4 APP_TITLE files; batch all 4 edits.",
        actions: edits.map((e) => ({ tool: "editFile", args: e })),
      });
    }

    if (caps.batchedActions && caps.hasGrepTool) {
      if (stage === 1) {
        return JSON.stringify({
          thought: "Use grep to find every occurrence of APP_TITLE.",
          tool: "grep",
          args: { pattern: "APP_TITLE" },
        });
      }
      edited = true;
      return JSON.stringify({
        thought: "Batch editFile across all 4 matching files.",
        actions: edits.map((e) => ({ tool: "editFile", args: e })),
      });
    }

    if (caps.batchedActions) {
      if (stage === 1) return JSON.stringify({ thought: "List src", tool: "listDir", args: { path: "src" } });
      if (stage === 2) {
        return JSON.stringify({
          thought: "Read all files in src",
          actions: [
            { tool: "readFile", args: { path: "src/constants.ts" } },
            { tool: "readFile", args: { path: "src/header.ts" } },
            { tool: "readFile", args: { path: "src/footer.ts" } },
            { tool: "readFile", args: { path: "src/index.ts" } },
            { tool: "readFile", args: { path: "src/legacy-utils.ts" } },
          ],
        });
      }
      if (stage === 3) {
        return JSON.stringify({
          thought: "Edit all 4 matching files",
          actions: edits.map((e) => ({ tool: "editFile", args: e })),
        });
      }
      return JSON.stringify({ thought: "Complete", tool: "markComplete", args: { summary: "Renamed APP_TITLE to BRAND_NAME." } });
    }

    // Phase 0 single-tool baseline: listDir + 5 readFiles + 4 editFiles + markComplete = 11 calls
    if (stage === 1) return JSON.stringify({ thought: "List src", tool: "listDir", args: { path: "src" } });
    if (stage === 2) return JSON.stringify({ thought: "Read constants.ts", tool: "readFile", args: { path: "src/constants.ts" } });
    if (stage === 3) return JSON.stringify({ thought: "Read header.ts", tool: "readFile", args: { path: "src/header.ts" } });
    if (stage === 4) return JSON.stringify({ thought: "Read footer.ts", tool: "readFile", args: { path: "src/footer.ts" } });
    if (stage === 5) return JSON.stringify({ thought: "Read index.ts", tool: "readFile", args: { path: "src/index.ts" } });
    if (stage === 6) return JSON.stringify({ thought: "Read legacy-utils.ts", tool: "readFile", args: { path: "src/legacy-utils.ts" } });
    if (stage >= 7 && stage <= 10) {
      const e = edits[stage - 7];
      return JSON.stringify({ thought: `Edit ${e.path}`, tool: "editFile", args: e });
    }
    return JSON.stringify({ thought: "Done", tool: "markComplete", args: { summary: "Renamed APP_TITLE to BRAND_NAME." } });
  };
}

// 5. Task: Explain a file
function createExplainResponder() {
  let stage = 0;
  const explanation =
    "LruCache maintains recency order using JavaScript's Map insertion order: get() deletes and re-inserts the accessed key at the tail, and set() evicts map.keys().next().value (the oldest entry) when size exceeds capacity.";

  return ({ fullPrompt }) => {
    stage += 1;
    const toolsDisabled = /Do NOT call any tools|chat-only|Single-shot explain/i.test(fullPrompt);
    const alreadyHasCacheCode = /class LruCache/.test(fullPrompt);

    if (toolsDisabled || alreadyHasCacheCode) {
      return JSON.stringify({
        thought: "File context is already present; answering directly.",
        answer: explanation,
      });
    }

    if (stage === 1) {
      return JSON.stringify({
        thought: "Read src/cache.ts to inspect its implementation.",
        tool: "readFile",
        args: { path: "src/cache.ts" },
      });
    }

    return JSON.stringify({
      thought: "Now explain how src/cache.ts works.",
      answer: explanation,
    });
  };
}

// ---- Task definitions & workspace setup -----------------------------------

const TASKS = [
  {
    id: "1-create-website",
    label: "Create a small website",
    prompt: "Build a responsive landing page website for Aurora Tea Co with hero, menu, story, and contact sections",
    intent: "website",
    setup(ws) {
      // Empty fresh workspace
      void ws;
    },
    makeResponder: () => responderCreateWebsite,
  },
  {
    id: "2-fix-ts-error",
    label: "Fix a TS error",
    prompt: "Fix the TypeScript build error in src/format.ts where fullName is referenced",
    intent: "agent",
    setup(ws) {
      fs.mkdirSync(path.join(ws, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(ws, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022" }, include: ["src"] }, null, 2),
      );
      fs.writeFileSync(
        path.join(ws, "src/user.ts"),
        "export interface User {\r\n    id: string;\r\n    name: string;\r\n}\r\n",
      );
      fs.writeFileSync(
        path.join(ws, "src/format.ts"),
        'import type { User } from "./user";\r\n\r\nexport function formatUser(u: User): string {\r\n    return u.fullName.trim();\r\n}\r\n',
      );
    },
    makeResponder: createFixTsResponder,
  },
  {
    id: "3-add-fn-plus-test",
    label: "Add function + test",
    prompt: "Add slugify(input) in src/slugify.js and a unit test in src/slugify.test.js, then run the test",
    intent: "agent",
    setup(ws) {
      fs.mkdirSync(path.join(ws, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(ws, "package.json"),
        JSON.stringify({ name: "slug-pkg", type: "module", scripts: { test: "node --test" } }, null, 2),
      );
      fs.writeFileSync(path.join(ws, "src/slugify.js"), "// Placeholder module\nexport {};\n");
    },
    makeResponder: createAddFnResponder,
  },
  {
    id: "4-rename-across-files",
    label: "Rename across files",
    prompt: "Rename the exported constant APP_TITLE to BRAND_NAME across all files in src/",
    intent: "agent",
    setup(ws) {
      fs.mkdirSync(path.join(ws, "src"), { recursive: true });
      fs.writeFileSync(path.join(ws, "src/constants.ts"), 'export const APP_TITLE = "Nova";\n');
      fs.writeFileSync(path.join(ws, "src/header.ts"), 'import { APP_TITLE } from "./constants";\nexport const renderHeader = () => `<header>${APP_TITLE}</header>`;\n');
      fs.writeFileSync(path.join(ws, "src/footer.ts"), 'import { APP_TITLE } from "./constants";\nexport const renderFooter = () => `<footer>© ${APP_TITLE}</footer>`;\n');
      fs.writeFileSync(path.join(ws, "src/index.ts"), 'import { APP_TITLE } from "./constants";\nconsole.log(APP_TITLE);\n');
      const fillerLines = Array.from({ length: 240 }, (_, i) => `export const helper_${i} = (x: number) => x + ${i};`).join("\n");
      fs.writeFileSync(path.join(ws, "src/legacy-utils.ts"), fillerLines + "\n");
    },
    makeResponder: createRenameResponder,
  },
  {
    id: "5-explain-file",
    label: "Explain a file",
    prompt: "Explain how @src/cache.ts works and debug/trace its eviction order",
    intent: "auto",
    setup(ws) {
      fs.mkdirSync(path.join(ws, "src"), { recursive: true });
      const extraComments = Array.from({ length: 180 }, (_, i) => `// Detailed implementation note line ${i + 1}: bucket invariant check`).join("\n");
      fs.writeFileSync(
        path.join(ws, "src/cache.ts"),
        `export class LruCache<K, V> {\n  private map = new Map<K, V>();\n  constructor(private readonly capacity: number) {}\n  get(key: K): V | undefined {\n    if (!this.map.has(key)) return undefined;\n    const val = this.map.get(key)!;\n    this.map.delete(key);\n    this.map.set(key, val);\n    return val;\n  }\n  set(key: K, val: V): void {\n    if (this.map.has(key)) this.map.delete(key);\n    else if (this.map.size >= this.capacity) {\n      const oldest = this.map.keys().next().value;\n      if (oldest !== undefined) this.map.delete(oldest);\n    }\n    this.map.set(key, val);\n  }\n}\n${extraComments}\n`,
      );
    },
    makeResponder: createExplainResponder,
  },
];

async function runSingleBenchmark(task) {
  const ws = freshWorkspace(`bench-${task.id}`);
  task.setup(ws);
  setWorkspaceRoot(ws);

  const ai = makeBenchAI(task.makeResponder());
  let jobsRef = null;
  const jobs = new JobManager({
    ai,
    workspaceRoot: () => ws,
    emit: (e) => {
      if (e.type === "approval" && jobsRef) {
        // Auto-approve safe local test/check commands in non-interactive benchmark
        jobsRef.respondApproval(e.request.id, "once");
      }
    },
    onPreview: () => {},
  });
  jobsRef = jobs;

  jobs.start({ text: task.prompt, mode: "balanced", intent: task.intent });
  const snap = await waitForIdle(jobs, 20_000);
  const stats = snap?.runStats;
  if (!stats) {
    throw new Error(`Benchmark task ${task.id} did not produce RunStats`);
  }

  try {
    fs.rmSync(ws, { recursive: true, force: true });
  } catch {
    /* ignore temp cleanup on Windows */
  }

  return {
    id: task.id,
    label: task.label,
    modelCalls: stats.modelCalls,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    totalTokens: stats.inputTokens + stats.outputTokens,
    toolCalls: stats.toolCallsExecuted,
    failedEdits: stats.failedEditFileAttempts,
    wallTimeMs: stats.wallTimeMs,
  };
}

async function main() {
  const results = [];
  for (const task of TASKS) {
    results.push(await runSingleBenchmark(task));
  }

  const totals = results.reduce(
    (acc, r) => ({
      modelCalls: acc.modelCalls + r.modelCalls,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
      toolCalls: acc.toolCalls + r.toolCalls,
      failedEdits: acc.failedEdits + r.failedEdits,
      wallTimeMs: acc.wallTimeMs + r.wallTimeMs,
    }),
    { modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0, failedEdits: 0, wallTimeMs: 0 },
  );

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ tasks: results, totals }, null, 2));
    return;
  }

  console.log("\nNova IDE Free-Tier Benchmark (5 Scripted Tasks — Deterministic Mock Provider)");
  console.log("=".repeat(90));
  console.log(
    pad("Task", 28) +
      padLeft("Calls", 8) +
      padLeft("In Tok", 10) +
      padLeft("Out Tok", 10) +
      padLeft("Total Tok", 12) +
      padLeft("Tools", 8) +
      padLeft("FailEdit", 10),
  );
  console.log("-".repeat(90));
  for (const r of results) {
    console.log(
      pad(r.label, 28) +
        padLeft(String(r.modelCalls), 8) +
        padLeft(String(r.inputTokens), 10) +
        padLeft(String(r.outputTokens), 10) +
        padLeft(String(r.totalTokens), 12) +
        padLeft(String(r.toolCalls), 8) +
        padLeft(String(r.failedEdits), 10),
    );
  }
  console.log("-".repeat(90));
  console.log(
    pad("TOTAL (5 tasks)", 28) +
      padLeft(String(totals.modelCalls), 8) +
      padLeft(String(totals.inputTokens), 10) +
      padLeft(String(totals.outputTokens), 10) +
      padLeft(String(totals.totalTokens), 12) +
      padLeft(String(totals.toolCalls), 8) +
      padLeft(String(totals.failedEdits), 10),
  );
  console.log("=".repeat(90));
}

function pad(s, len) {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}
function padLeft(s, len) {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
