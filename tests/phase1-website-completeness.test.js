const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { installElectronStub } = require("./helpers/harness");
installElectronStub();

const { validateHtmlDocument, sanitizeHtmlDocument } = require("../dist/main/website/validator");
const { resolveSiteManifest, formatManifestPromptInstruction } = require("../dist/main/website/manifest");
const {
  extractHtmlReferences,
  extractCssReferences,
  checkReferenceClosure,
  inlineOrStubMissingAssetsLocally,
  buildMissingAssetsPrompt,
} = require("../dist/main/website/reference-closure");
const { createAgentState } = require("../dist/main/agent/loop");
const { findTool } = require("../dist/main/agent/tools");
const { getRunFileDiff } = require("../dist/main/agent/checkpoints");

test("Phase 1: HTML Document Validator rejects duplicate root tags and sanitizes clean document", () => {
  const cleanHtml = "<!DOCTYPE html>\n<html><head><title>Test</title></head><body><h1>Hello</h1></body></html>";
  const valid = validateHtmlDocument(cleanHtml);
  assert.equal(valid.ok, true);
  assert.equal(valid.counts.doctype, 1);
  assert.equal(valid.counts.html, 1);
  assert.equal(valid.counts.body, 1);

  // Concatenated duplicate HTML
  const duplicatedHtml = cleanHtml + "\n<!DOCTYPE html>\n<html><head><title>New</title></head><body><h1>World</h1></body></html>";
  const invalid = validateHtmlDocument(duplicatedHtml);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.counts.doctype, 2);
  assert.match(invalid.error, /contains 2 <!DOCTYPE html>/);

  // Sanitizer recovers the final complete document
  const sanitized = sanitizeHtmlDocument(duplicatedHtml);
  const revalidated = validateHtmlDocument(sanitized);
  assert.equal(revalidated.ok, true);
  assert.match(sanitized, /<h1>World<\/h1>/);
});

test("Phase 1: Site Manifest defaults to single self-contained index.html on free tier", () => {
  const defaultManifest = resolveSiteManifest({
    brief: "make a landing page for a bakery",
    laneOutputBudget: 4096,
  });
  assert.equal(defaultManifest.selfContained, true);
  assert.equal(defaultManifest.files.length, 1);
  assert.equal(defaultManifest.files[0].path, "index.html");

  const prompt = formatManifestPromptInstruction(defaultManifest);
  assert.match(prompt, /Exactly 1 self-contained file: `index.html`/);
  assert.match(prompt, /inside a `<style>` block/);

  // Explicit multi-file request
  const multiManifest = resolveSiteManifest({
    brief: "create a site with separate css and js files",
    laneOutputBudget: 16000,
  });
  assert.equal(multiManifest.selfContained, false);
  assert.ok(multiManifest.files.length >= 2);
  assert.ok(multiManifest.files.some((f) => f.path === "css/style.css"));
});

test("Phase 1: Reference Closure Checker detects missing assets and generates local fallbacks", () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <link rel="stylesheet" href="css/style.css">
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
      </head>
      <body>
        <img src="images/hero.png" alt="Hero">
        <img src="https://example.com/logo.svg" alt="External Logo">
        <script src="js/main.js"></script>
      </body>
    </html>
  `;

  const refs = extractHtmlReferences(html, "index.html");
  // External URLs are ignored, only local references are tracked
  assert.equal(refs.length, 3);
  const paths = refs.map((r) => r.normalizedPath);
  assert.ok(paths.includes("css/style.css"));
  assert.ok(paths.includes("images/hero.png"));
  assert.ok(paths.includes("js/main.js"));

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "myide-closure-test-"));
  try {
    const knownFiles = new Map();
    knownFiles.set("index.html", html);

    const closure = checkReferenceClosure(tmpRoot, knownFiles);
    assert.equal(closure.valid, false);
    assert.equal(closure.missing.length, 3);

    const missingPrompt = buildMissingAssetsPrompt(closure.missing);
    assert.match(missingPrompt, /css\/style\.css/);
    assert.match(missingPrompt, /images\/hero\.png/);

    // Fallback: inlines or stubs missing assets locally
    const fallback = inlineOrStubMissingAssetsLocally(html, closure.missing);
    // Missing hero.png is replaced with an accessible inline SVG placeholder
    assert.match(fallback.updatedHtml, /<svg/);
    assert.ok(!fallback.updatedHtml.includes('src="images/hero.png"'));
    assert.ok(fallback.stubsToCreate.length > 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("Phase 1: Overwrite semantics & +N/-0 bug fix (proves rewritten file has no duplicates and diff shows deletions)", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "myide-diff-fix-test-"));
  const runId = "run-website-test-001";

  try {
    const state = createAgentState(tmpRoot, runId);
    const writeTool = findTool("writeFile");
    assert.ok(writeTool);

    const ctx = {
      state,
      requestApproval: async () => "once",
    };

    // 1. Initial starter content exists on disk
    const initialHtml = [
      "<!DOCTYPE html>",
      "<html>",
      "<head><title>Old Starter Template</title></head>",
      "<body>",
      "  <h1>Starter Template</h1>",
      "  <p>Temporary boilerplate text that should be replaced.</p>",
      "  <footer>Old footer</footer>",
      "</body>",
      "</html>",
    ].join("\n");

    const res1 = await writeTool.run({ path: "index.html", content: initialHtml }, ctx);
    assert.equal(res1.ok, true);

    // 2. Model rewrites index.html with completely new site content
    const rewrittenHtml = [
      "<!DOCTYPE html>",
      "<html>",
      "<head><title>Neo Brutalist Coffee</title></head>",
      "<body>",
      "  <header>Brand</header>",
      "  <main>",
      "    <h1>Bold Beans</h1>",
      "    <p>Fresh artisanal roast.</p>",
      "  </main>",
      "</body>",
      "</html>",
    ].join("\n");

    const res2 = await writeTool.run({ path: "index.html", content: rewrittenHtml }, ctx);
    assert.equal(res2.ok, true);

    // Check disk content: must NOT contain duplicate html/doctype/body
    const onDisk = fs.readFileSync(path.join(tmpRoot, "index.html"), "utf8");
    const val = validateHtmlDocument(onDisk);
    assert.equal(val.ok, true);
    assert.equal(val.counts.doctype, 1);
    assert.equal(val.counts.html, 1);
    assert.equal(val.counts.body, 1);
    assert.ok(!onDisk.includes("Old Starter Template")); // Old content completely replaced, not appended

    // 3. Diff calculation must report real added AND removed lines (NO +N/-0 bug!)
    const diff = getRunFileDiff(tmpRoot, runId, "index.html");
    assert.ok(diff.removedLines > 0, `Expected removedLines > 0, got ${diff.removedLines}`);
    assert.ok(diff.addedLines > 0, `Expected addedLines > 0, got ${diff.addedLines}`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
