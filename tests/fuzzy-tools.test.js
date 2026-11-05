const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installElectronStub, freshWorkspace } = require("./helpers/harness");

installElectronStub();

const { fuzzyReplaceInText, applyMultiEditsAtomically } = require("../dist/main/agent/fuzzy-edit");
const { createAgentState } = require("../dist/main/agent/loop");
const { findTool } = require("../dist/main/agent/tools");

test("fuzzyReplaceInText: cascades cleanly across Tiers 1, 2, 3, and 4 while preserving CRLF and indentation", () => {
  // Tier 1: Exact match
  const t1 = fuzzyReplaceInText("const a = 1;\nconst b = 2;\n", "const b = 2;", "const b = 20;");
  assert.equal(t1.ok, true);
  assert.equal(t1.tier, 1);
  assert.equal(t1.updatedText, "const a = 1;\nconst b = 20;\n");

  // Tier 2: Trailing whitespace + CRLF vs LF
  const crlfFile = "export const x = 1;   \r\nexport const y = 2;\r\n";
  const t2 = fuzzyReplaceInText(crlfFile, "export const x = 1;\nexport const y = 2;", "export const x = 10;\nexport const y = 20;");
  assert.equal(t2.ok, true);
  assert.equal(t2.tier, 2);
  assert.equal(t2.updatedText, "export const x = 10;\r\nexport const y = 20;\r\n");

  // Tier 3: 2-space indent in find/replace applied to 4-space CRLF file -> re-indents to 4 spaces!
  const fourSpaceCrlf = [
    'import type { User } from "./user";',
    "",
    "export function formatUser(u: User): string {",
    "    return u.fullName.trim();",
    "}",
    "",
  ].join("\r\n");
  const t3 = fuzzyReplaceInText(
    fourSpaceCrlf,
    "export function formatUser(u: User): string {\n  return u.fullName.trim();\n}",
    "export function formatUser(u: User): string {\n  return u.name.trim();\n}",
  );
  assert.equal(t3.ok, true);
  assert.equal(t3.tier, 3);
  assert.match(t3.updatedText, /\r\n    return u\.name\.trim\(\);\r\n/);

  // Tier 4: Sliding-window similarity >= 0.90 (minor spacing/comment typo inside long unique block)
  const tier4Source = [
    "export function computeInvoiceSubtotalWithTax(items: ReadonlyArray<{ price: number; qty: number }>, rate: number): number {",
    "  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);",
    "  return Math.round(subtotal * (1 + rate) * 100) / 100;",
    "}",
  ].join("\n");
  const slightlyDriftedFind = [
    "export function computeInvoiceSubtotalWithTax(items: ReadonlyArray<{ price: number; qty: number }>, rate: number): number {",
    "  const subtotal = items.reduce((sum, item) => sum + (item.price * item.qty), 0);",
    "  return Math.round(subtotal * (1 + rate) * 100) / 100;",
    "}",
  ].join("\n");
  const t4 = fuzzyReplaceInText(
    tier4Source,
    slightlyDriftedFind,
    "export function computeInvoiceSubtotalWithTax(items: ReadonlyArray<{ price: number; qty: number }>, rate: number): number {\n  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);\n  return Number((subtotal * (1 + rate)).toFixed(2));\n}",
  );
  assert.equal(t4.ok, true);
  assert.equal(t4.tier, 4);
  assert.match(t4.updatedText, /toFixed\(2\)/);
});

test("fuzzyReplaceInText: rejects ambiguous matches and reports top closest line-numbered snippets on failure", () => {
  const dup = "function ping() {\n  return 1;\n}\nfunction pong() {\n  return 1;\n}\n";
  const amb = fuzzyReplaceInText(dup, "  return 1;", "  return 2;", { filePath: "src/dup.ts" });
  assert.equal(amb.ok, false);
  assert.equal(amb.ambiguous, true);
  assert.match(amb.error, /appears more than once/);

  const miss = fuzzyReplaceInText(dup, "function pinging() {\n  return 999;\n}", "function pinging() {}", {
    filePath: "src/dup.ts",
  });
  assert.equal(miss.ok, false);
  assert.ok(Array.isArray(miss.closestMatches) && miss.closestMatches.length >= 1);
  assert.match(miss.error, /Closest snippets in src\/dup\.ts/);
  assert.match(miss.error, /\d+\| /);
});

test("editFile multi-edit atomic mode: applies all or leaves disk untouched on mid-edit failure", async () => {
  const ws = freshWorkspace("multi-edit");
  const state = createAgentState(ws);
  const ctx = { state, requestApproval: async () => "once" };
  const fileAbs = path.join(ws, "src/app.ts");
  fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
  const original = "export const A = 1;\nexport const B = 2;\nexport const C = 3;\n";
  fs.writeFileSync(fileAbs, original, "utf8");

  const editTool = findTool("editFile");

  // Failing 2nd edit must NOT mutate disk
  const failRes = await editTool.run(
    {
      path: "src/app.ts",
      edits: [
        { find: "export const A = 1;", replace: "export const A = 10;" },
        { find: "export const MISSING = 99;", replace: "export const MISSING = 0;" },
      ],
    },
    ctx,
  );
  assert.equal(failRes.ok, false);
  assert.equal(fs.readFileSync(fileAbs, "utf8"), original);

  // Valid multi-edit succeeds atomically
  const okRes = await editTool.run(
    {
      path: "src/app.ts",
      edits: [
        { find: "export const A = 1;", replace: "export const A = 10;" },
        { find: "export const C = 3;", replace: "export const C = 30;" },
      ],
    },
    ctx,
  );
  assert.equal(okRes.ok, true);
  assert.equal(fs.readFileSync(fileAbs, "utf8"), "export const A = 10;\nexport const B = 2;\nexport const C = 30;\n");
});

test("replaceLines, readFile (>200 outline & ranges), grep (.env safe), listTree (.gitignore aware), and getSymbols", async () => {
  const ws = freshWorkspace("tools-p3");
  const state = createAgentState(ws);
  const ctx = { state, requestApproval: async () => "once" };

  fs.writeFileSync(path.join(ws, ".gitignore"), "ignored-dir/\n*.log\n", "utf8");
  fs.writeFileSync(path.join(ws, ".env"), "SECRET_TOKEN=TOP_SECRET_MARKER\n", "utf8");
  fs.mkdirSync(path.join(ws, "ignored-dir"), { recursive: true });
  fs.writeFileSync(path.join(ws, "ignored-dir/skip.ts"), "export const SKIP = true;\n", "utf8");
  fs.writeFileSync(path.join(ws, "debug.log"), "TOP_SECRET_MARKER\n", "utf8");

  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  const bigLines = [
    "export class BigService {",
    "  runTask(): string {",
    '    return "SEARCH_NEEDLE_ALPHA";',
    "  }",
    "}",
    ...Array.from({ length: 220 }, (_, i) => `export function helperFn_${i}(): number { return ${i}; }`),
  ];
  fs.writeFileSync(path.join(ws, "src/big.ts"), bigLines.join("\n") + "\n", "utf8");

  // listTree respects .gitignore and hides .env
  const treeRes = await findTool("listTree").run({ path: "", depth: 3 }, ctx);
  assert.equal(treeRes.ok, true);
  assert.match(treeRes.output, /src\//);
  assert.doesNotMatch(treeRes.output, /ignored-dir/);
  assert.doesNotMatch(treeRes.output, /\.env/);
  assert.doesNotMatch(treeRes.output, /debug\.log/);

  // grep finds SEARCH_NEEDLE_ALPHA and never leaks .env or gitignored files
  const grepRes = await findTool("grep").run({ pattern: "SEARCH_NEEDLE_ALPHA|TOP_SECRET_MARKER" }, ctx);
  assert.equal(grepRes.ok, true);
  assert.match(grepRes.output, /src\/big\.ts:3:/);
  assert.doesNotMatch(grepRes.output, /TOP_SECRET_MARKER/);

  // getSymbols extracts class & functions with 1-based line numbers
  const symRes = await findTool("getSymbols").run({ path: "src/big.ts" }, ctx);
  assert.equal(symRes.ok, true);
  assert.match(symRes.output, /L1: export class BigService/);
  assert.match(symRes.output, /L6: export function helperFn_0/);

  // readFile on >200 lines returns Symbol Outline + truncated hint; range returns exact requested lines
  const fullRead = await findTool("readFile").run({ path: "src/big.ts" }, ctx);
  assert.equal(fullRead.ok, true);
  assert.match(fullRead.output, /\[Symbol Outline for src\/big\.ts/);
  assert.match(fullRead.output, /\[truncated \d+ lines, use startLine\/endLine\]/);

  const rangeRead = await findTool("readFile").run({ path: "src/big.ts", startLine: 200, endLine: 205 }, ctx);
  assert.equal(rangeRead.ok, true);
  assert.match(rangeRead.output, /lines 200-205/);
  assert.match(rangeRead.output, /200\| /);

  // replaceLines replaces lines 2..4 cleanly
  const replRes = await findTool("replaceLines").run(
    {
      path: "src/big.ts",
      startLine: 2,
      endLine: 4,
      content: '  runTask(): string {\n    return "UPDATED_NEEDLE";\n  }',
    },
    ctx,
  );
  assert.equal(replRes.ok, true);
  assert.match(fs.readFileSync(path.join(ws, "src/big.ts"), "utf8"), /UPDATED_NEEDLE/);
});
