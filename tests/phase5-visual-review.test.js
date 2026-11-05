const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { installElectronStub } = require("./helpers/harness");
installElectronStub();

const { Router } = require("../dist/main/ai/router");
const { runLocalHeuristicAudit, runVisualReview } = require("../dist/main/website/visual-review");

test("Phase 5: Local heuristics catch horizontal overflow hazards and low contrast without network", () => {
  const badHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Buggy Site</title>
  <style>
    body { margin: 0; }
  </style>
</head>
<body>
  <h1></h1>
  <div style="width: 1400px; color: #ffffff; background-color: #ffffff;">
    Invisible text on white background with 1400px fixed width!
  </div>
  <section></section>
  <img src="#" alt="">
</body>
</html>`;

  const audit = runLocalHeuristicAudit(badHtml);

  // Checks overflow caught
  const overflow = audit.issues.find((i) => i.area === "Responsiveness");
  assert.ok(overflow, "Should detect horizontal overflow hazard");
  assert.equal(overflow.severity, "error");

  // Checks low contrast caught
  const contrast = audit.issues.find((i) => i.area === "Accessibility & Contrast");
  assert.ok(contrast, "Should detect low text-to-background contrast");
  assert.ok(audit.contrastRatioEstimate < 4.5);

  // Empty elements caught
  assert.ok(audit.issues.some((i) => i.area === "Headings"));
  assert.ok(audit.issues.some((i) => i.area === "Layout"));
  assert.ok(audit.issues.some((i) => i.area === "Images"));
});

test("Phase 5: Vision model scores visual layout and surfaces targeted design issues", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-vision-test-"));
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Cafe Landing</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <header><h1>Cafe Latte</h1></header>
  <main><section id="hero"><p>Welcome to our cafe</p></section></main>
</body>
</html>`;

  fs.writeFileSync(path.join(tmpDir, "index.html"), htmlContent, "utf8");
  fs.mkdirSync(path.join(tmpDir, "css"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "css", "style.css"), "body { margin: 0; }", "utf8");

  const visionLane = {
    id: "gemini/gemini-2.5-flash",
    provider: "gemini",
    model: "gemini-2.5-flash",
    priority: 1,
    costTier: "free",
    limits: {
      maxTokensPerRequest: 65000,
      maxRequestsPerMinute: 15,
      maxTokensPerMinute: 1000000,
      maxRequestsPerDay: 1500,
    },
    capabilities: {
      maxOutputTokens: 65000,
      contextWindow: 1048576,
      supportsVision: true,
      isReasoning: false,
      roleTags: ["codegen", "reasoning"],
    },
  };

  let visionPromptReceived = false;

  const router = new Router({
    getLanes: () => [visionLane],
    isProviderConfigured: () => true,
    healthFor: () => ({ deadSession: false, cooldownUntil: 0, minuteRequestCount: 0, minuteTokenCount: 0 }),
    sendVia: async (lane, req) => {
      visionPromptReceived = true;
      return {
        ok: true,
        content: JSON.stringify({
          visualScore: 5.5,
          issues: [
            {
              area: "Hero",
              problem: "Hero headline is cramped against the top header without breathing room.",
              fix: "Add padding: 5rem 1.5rem to #hero container.",
              severity: "error",
            },
          ],
        }),
      };
    },
  });

  const report = await runVisualReview({
    workspaceRoot: tmpDir,
    router,
    visionLane,
  });

  assert.equal(visionPromptReceived, true);
  assert.equal(report.evaluatedWithVision, true);
  assert.equal(report.visualScore, 5.5);
  assert.equal(report.structurePassed, true);
  assert.equal(report.assetsPassed, true);

  const heroIssue = report.issues.find((i) => i.area === "Hero");
  assert.ok(heroIssue);
  assert.match(heroIssue.problem, /Hero headline is cramped/);
  assert.match(heroIssue.fix, /Add padding/);

  // Thumbnails generated
  assert.ok(report.desktopScreenshot && report.desktopScreenshot.startsWith("data:image/svg+xml"));
  assert.ok(report.mobileScreenshot && report.mobileScreenshot.startsWith("data:image/svg+xml"));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
