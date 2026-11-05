const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { installElectronStub } = require("./helpers/harness");
installElectronStub();

const { Router } = require("../dist/main/ai/router");
const { runStagedWebsite } = require("../dist/main/website/staged-builder");

test("Phase 4: Staged builder runs all 4 stages for small-output lane and splices all sections", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-staged-test-"));
  const myideDir = path.join(tmpDir, ".myide");
  fs.mkdirSync(myideDir, { recursive: true });

  const state = {
    workspaceRoot: tmpDir,
    myideDir,
    runId: "run-staged-123",
  };

  const lane = {
    id: "groq/gpt-oss-120b",
    provider: "groq",
    model: "gpt-oss-120b",
    priority: 1,
    costTier: "free",
    limits: {
      maxTokensPerRequest: 4000,
      maxRequestsPerMinute: 30,
      maxTokensPerMinute: 40000,
      maxRequestsPerDay: 1000,
    },
    capabilities: {
      maxOutputTokens: 4000,
      contextWindow: 8192,
      supportsVision: false,
      isReasoning: true,
      roleTags: ["classify", "repair"],
    },
  };

  const stageCalls = [];
  const tokenEstimates = [];

  const router = new Router({
    getLanes: () => [lane],
    isProviderConfigured: () => true,
    healthFor: () => ({ deadSession: false, cooldownUntil: 0, minuteRequestCount: 0, minuteTokenCount: 0 }),
    sendVia: async (laneUsed, req) => {
      const userText = req.messages.find((m) => m.role === "user")?.content || "";
      const systemText = req.messages.find((m) => m.role === "system")?.content || "";
      const promptCombined = systemText + " " + userText;

      let responseText = "";

      if (promptCombined.includes("css/style.css") || promptCombined.includes("design system")) {
        stageCalls.push("design-system");
        responseText = `<file path="css/style.css">
:root { --bg: #fff; --ink: #000; --border: 3px solid #000; }
body { background: var(--bg); color: var(--ink); font-family: sans-serif; }
.section { padding: 4rem 1rem; border-bottom: var(--border); }
.container { max-width: 1100px; margin: 0 auto; }
.card { border: var(--border); padding: 1.5rem; }
.btn { border: var(--border); padding: 0.5rem 1rem; font-weight: bold; }
</file>`;
      } else if (promptCombined.includes("skeleton index.html")) {
        stageCalls.push("skeleton");
        responseText = `<file path="index.html">
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Artisan Bakery</title>
  <link rel="stylesheet" href="css/style.css">
  <script defer src="js/main.js"></script>
</head>
<body>
  <header><nav class="container"><h1>Bakery</h1></nav></header>
  <main>
    <!-- SECTION_PLACEHOLDER: hero -->
    <!-- SECTION_PLACEHOLDER: features -->
    <!-- SECTION_PLACEHOLDER: social-proof -->
    <!-- SECTION_PLACEHOLDER: pricing -->
    <!-- SECTION_PLACEHOLDER: faq -->
  </main>
  <footer><p>&copy; 2026 Bakery</p></footer>
</body>
</html>
</file>`;
      } else if (promptCombined.includes("sections:")) {
        stageCalls.push("sections");
        if (promptCombined.includes("hero") || promptCombined.includes("features")) {
          responseText = `<file path="sections.html">
<section id="hero" class="section">
  <div class="container">
    <h2>Fresh Sourdough Daily</h2>
    <p>Baked with natural organic starters.</p>
  </div>
</section>
<section id="features" class="section">
  <div class="container">
    <h2>Our Special Breads</h2>
    <div class="card">Country Loaf</div>
  </div>
</section>
</file>`;
        } else {
          responseText = `<file path="sections.html">
<section id="social-proof" class="section"><div class="container"><p>Rated 5 stars</p></div></section>
<section id="pricing" class="section"><div class="container"><p>$6 a loaf</p></div></section>
<section id="faq" class="section"><div class="container"><p>Q: Gluten free? A: Some items.</p></div></section>
</file>`;
        }
      } else if (promptCombined.includes("js/main.js") || promptCombined.includes("interactive vanilla JavaScript")) {
        stageCalls.push("behavior");
        responseText = `<file path="js/main.js">
document.addEventListener("DOMContentLoaded", () => {
  console.log("Bakery interactions active");
});
</file>`;
      }

      // Check tokens stay well under 3,500
      const approxTokens = Math.ceil((responseText.length + promptCombined.length) / 3.5);
      tokenEstimates.push(approxTokens);

      return {
        ok: true,
        content: responseText,
        usage: {
          promptTokens: Math.ceil(promptCombined.length / 3.5),
          completionTokens: Math.ceil(responseText.length / 3.5),
        },
      };
    },
  });

  const events = [];
  const res = await runStagedWebsite({
    state,
    router,
    brief: "Make a neo brutalist artisan bakery website with sourdough menu and reviews",
    pinnedLane: lane,
    onEvent: (evt) => events.push(evt),
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.stagesCompleted, ["design-system", "skeleton", "sections", "behavior"]);

  // All files exist on disk
  const indexHtml = fs.readFileSync(path.join(tmpDir, "index.html"), "utf8");
  const cssStyle = fs.readFileSync(path.join(tmpDir, "css", "style.css"), "utf8");
  const jsMain = fs.readFileSync(path.join(tmpDir, "js", "main.js"), "utf8");

  assert.ok(indexHtml.length > 200);
  assert.ok(cssStyle.length > 50);
  assert.ok(jsMain.length > 20);

  // All 5 sections spliced with ZERO placeholders left
  assert.equal(indexHtml.includes("SECTION_PLACEHOLDER"), false);
  assert.ok(indexHtml.includes('id="hero"'));
  assert.ok(indexHtml.includes('id="features"'));
  assert.ok(indexHtml.includes('id="social-proof"'));
  assert.ok(indexHtml.includes('id="pricing"'));
  assert.ok(indexHtml.includes('id="faq"'));

  // Tokens per call strictly under 3,500 tokens
  for (const t of tokenEstimates) {
    assert.ok(t < 3500, `Call exceeded 3,500 token limit: ${t}`);
  }

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Phase 4: Auto-continuation recovers truncated output cleanly", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-staged-trunc-"));
  const myideDir = path.join(tmpDir, ".myide");
  fs.mkdirSync(myideDir, { recursive: true });

  const state = {
    workspaceRoot: tmpDir,
    myideDir,
    runId: "run-trunc-456",
  };

  const lane = {
    id: "groq/small",
    provider: "groq",
    model: "groq-small",
    priority: 1,
    costTier: "free",
    limits: {
      maxTokensPerRequest: 4000,
      maxRequestsPerMinute: 30,
      maxTokensPerMinute: 40000,
      maxRequestsPerDay: 1000,
    },
    capabilities: { maxOutputTokens: 4000, contextWindow: 8192, supportsVision: false, isReasoning: false, roleTags: [] },
  };

  let truncatedSent = false;
  let continuedSent = false;

  const router = new Router({
    getLanes: () => [lane],
    isProviderConfigured: () => true,
    healthFor: () => ({ deadSession: false, cooldownUntil: 0, minuteRequestCount: 0, minuteTokenCount: 0 }),
    sendVia: async (laneUsed, req) => {
      const lastUserText = [...req.messages].reverse().find((m) => m.role === "user")?.content || "";

      if (lastUserText.includes("continue exactly from where you stopped")) {
        continuedSent = true;
        return {
          ok: true,
          content: `body { background: #fff; }\n.btn { color: #000; }\n</file>`,
        };
      }

      if (!truncatedSent) {
        truncatedSent = true;
        // Output intentionally cut off without </file>
        return {
          ok: true,
          content: `<file path="css/style.css">\n:root { --bg: #fff; }\n`,
        };
      }

      // Default responses for subsequent stages
      return {
        ok: true,
        content: `<file path="index.html"><!DOCTYPE html><html><head><link rel="stylesheet" href="css/style.css"></head><body><main><!-- SECTION_PLACEHOLDER: hero --></main></body></html></file>`,
      };
    },
  });

  const res = await runStagedWebsite({
    state,
    router,
    brief: "A minimalist cafe",
    pinnedLane: lane,
    onEvent: () => {},
  });

  if (!res.ok) console.log("TEST 2 ERROR:", res.error);
  assert.equal(truncatedSent, true);
  assert.equal(continuedSent, true);
  assert.equal(res.ok, true);

  const cssStyle = fs.readFileSync(path.join(tmpDir, "css", "style.css"), "utf8");
  assert.ok(cssStyle.includes(":root"));
  assert.ok(cssStyle.includes(".btn"));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
