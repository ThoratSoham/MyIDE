const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installElectronStub, stubModule, freshWorkspace, makeFakeAI, textReply } = require("./helpers/harness");

installElectronStub();

// Stub verifier for deterministic repair test
const verifierPath = path.resolve(__dirname, "../dist/main/quality/verifier.js");
stubModule(verifierPath, {
  VIEWPORTS: [{ name: "desktop", width: 1440, height: 900 }],
  findBrowserPath: () => "mock",
  async verifyWebsite(opts) {
    const html = fs.existsSync(opts.pagePath) ? fs.readFileSync(opts.pagePath, "utf8") : "";
    const issues = [];
    if (!/<h1\b/i.test(html)) {
      issues.push({
        id: "h1-count",
        severity: "error",
        viewport: "desktop",
        selector: "header",
        message: "page has 0 h1 elements (need exactly 1)",
        fixHint: "Add one h1.",
      });
    }
    return {
      ok: issues.length === 0,
      verified: true,
      issues,
      screenshots: [],
      textLength: html.length,
      pageWeightBytes: html.length,
    };
  },
});

const { parseFileTags, applyParsedFileTags } = require("../dist/main/agent/file-tags");
const { summarizeVerifyErrors, detectProjectConfig } = require("../dist/main/agent/auto-verify");
const { createAgentState } = require("../dist/main/agent/loop");
const { runSingleShotWebsite } = require("../dist/main/pipeline/website-single-shot");

test("parseFileTags: parses multiple <file> blocks, strips accidental fences, and tolerates missing closing tag at EOF", () => {
  const raw = [
    "Planning layout...",
    '<file path="index.html">',
    "```html",
    "<!doctype html><h1>Hi</h1>",
    "```",
    "</file>",
    "<file path='css/style.css'>",
    "body { margin: 0; }",
    // Intentionally missing </file> at EOF!
  ].join("\n");

  const tags = parseFileTags(raw);
  assert.equal(tags.length, 2);
  assert.equal(tags[0].path, "index.html");
  assert.equal(tags[0].content.trim(), "<!doctype html><h1>Hi</h1>");
  assert.equal(tags[0].unclosedAtEnd, false);

  assert.equal(tags[1].path, "css/style.css");
  assert.equal(tags[1].content.trim(), "body { margin: 0; }");
  assert.equal(tags[1].unclosedAtEnd, true);
});

test("applyParsedFileTags: enforces workspace sandbox, blocks .env, and backs up overwritten files", async () => {
  const ws = freshWorkspace("file-tags-sec");
  const state = createAgentState(ws);
  fs.writeFileSync(path.join(ws, "app.js"), "console.log('old');\n", "utf8");

  const tags = parseFileTags(
    [
      '<file path="app.js">console.log("new");</file>',
      '<file path=".env">SECRET=123</file>',
      '<file path="../outside.txt">escape</file>',
    ].join("\n"),
  );

  const summary = await applyParsedFileTags(tags, state, {
    requestApproval: async () => "once",
    signal: { cancelled: false },
  });

  assert.equal(summary.written.length, 1);
  assert.equal(summary.written[0].path, "app.js");
  assert.equal(summary.errors.length, 2);
  assert.equal(fs.existsSync(path.join(ws, ".env")), false);
  assert.equal(fs.existsSync(path.resolve(ws, "../outside.txt")), false);
  assert.equal(fs.readFileSync(path.join(ws, "app.js"), "utf8").trim(), 'console.log("new");');

  // Verify backup exists in .myide/backups
  const backups = fs.readdirSync(path.join(ws, ".myide/backups"));
  assert.ok(backups.length >= 1, "expected backup in .myide/backups");
});

test("summarizeVerifyErrors & detectProjectConfig: caches .myide/project.json and caps errors to <=40 lines", () => {
  const ws = freshWorkspace("auto-verify-cfg");
  fs.writeFileSync(path.join(ws, "tsconfig.json"), "{}");
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));

  const cfg = detectProjectConfig(ws);
  assert.equal(cfg.hasTypeScript, true);
  assert.equal(cfg.packageManager, "npm");
  assert.equal(fs.existsSync(path.join(ws, ".myide/project.json")), true);

  const noisy = Array.from({ length: 65 }, (_, i) => `src/file.ts(${i + 1},3): error TS2322: Bad type ${i}`);
  noisy.push("src/file.ts(1,3): error TS2322: Bad type 0"); // duplicate
  const capped = summarizeVerifyErrors(noisy, 40);
  assert.equal(capped.length, 40);
  assert.equal(capped[0], "src/file.ts:1:3: TS2322: Bad type 0");
  assert.match(capped[39], /more error lines omitted/);
});

test("runSingleShotWebsite: builds in 1 call when clean, or repairs only failing file with snippet feedback", async () => {
  const ws = freshWorkspace("single-shot-web");
  const state = createAgentState(ws);

  const ai = makeFakeAI([
    // Call 1: emits page WITHOUT <h1> so verifier triggers 1 targeted repair
    () =>
      textReply(
        [
          '<file path="index.html"><header><p>Missing main heading</p></header></file>',
          '<file path="css/style.css">body { color: #fff; background: #111; }</file>',
        ].join("\n"),
      ),
    // Call 2: receives ONLY index.html snippet + h1-count issue (not css/style.css) and fixes index.html
    (messages) => {
      const repairPrompt = messages[messages.length - 1].content;
      assert.match(repairPrompt, /h1-count/);
      assert.doesNotMatch(repairPrompt, /--- css\/style\.css ---/);
      return textReply('<file path="index.html"><header><h1>Fixed Heading</h1></header></file>');
    },
  ]);

  const summary = await runSingleShotWebsite(ai, state, {
    runId: "web-1",
    brief: "Build a tea website",
    signal: { cancelled: false },
    abortController: new AbortController(),
    onEvent: () => {},
    requestApproval: async () => "once",
  });

  assert.equal(ai.calls.length, 2);
  assert.match(summary, /verified clean after 1 repair round/);
  assert.match(fs.readFileSync(path.join(ws, "index.html"), "utf8"), /<h1>Fixed Heading<\/h1>/);
});
