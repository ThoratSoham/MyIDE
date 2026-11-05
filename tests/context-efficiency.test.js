const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installElectronStub, freshWorkspace } = require("./helpers/harness");

installElectronStub();

const { buildRepoMap, invalidateRepoMapCache } = require("../dist/main/context/repo-map");
const { WorkspaceBM25Retriever, buildRetrievedContextBlock } = require("../dist/main/context/bm25");
const {
  createWorkingMemory,
  stubToolResultContent,
  compressConversationHistory,
} = require("../dist/main/context/working-memory");
const { assembleTurnMessages, fitMessagesToLaneBudget } = require("../dist/main/context/budget");

test("buildRepoMap: extracts symbol outlines, caches in .myide/cache/repo-map.json, excludes .env, and invalidates cleanly", () => {
  const ws = freshWorkspace("repo-map");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".env"), "API_TOKEN=NEVER_SHOW\n", "utf8");
  fs.writeFileSync(
    path.join(ws, "src/auth.ts"),
    "export interface SessionToken { id: string; }\nexport function verifySession(tok: SessionToken): boolean { return Boolean(tok.id); }\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(ws, "src/unrelated.ts"),
    "export function renderFooter(): string { return 'footer'; }\n",
    "utf8",
  );

  const map1 = buildRepoMap({
    workspaceRoot: ws,
    query: "Fix verifySession in src/auth.ts",
    maxTokens: 800,
  });

  assert.match(map1, /\[Workspace Repo Map\]/);
  assert.match(map1, /src\/auth\.ts.*verifySession/);
  assert.doesNotMatch(map1, /\.env|NEVER_SHOW/);
  // Relevant file (src/auth.ts) ranked ahead of unrelated.ts
  assert.ok(map1.indexOf("src/auth.ts") < map1.indexOf("src/unrelated.ts"));
  assert.equal(fs.existsSync(path.join(ws, ".myide/cache/repo-map.json")), true);

  // Modify file + invalidate -> reflects new symbol
  fs.writeFileSync(
    path.join(ws, "src/auth.ts"),
    "export function rotateRefreshToken(): string { return 'ok'; }\n",
    "utf8",
  );
  invalidateRepoMapCache(ws, "src/auth.ts");
  const map2 = buildRepoMap({ workspaceRoot: ws, query: "rotateRefreshToken" });
  assert.match(map2, /rotateRefreshToken/);
});

test("WorkspaceBM25Retriever: resolves @file, @symbol, and identifier queries while skipping .env and noise", () => {
  const ws = freshWorkspace("bm25");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".env"), "APP_TITLE=SECRET_ENV_VALUE\n", "utf8");
  fs.writeFileSync(path.join(ws, "src/constants.ts"), 'export const APP_TITLE = "Nova";\n', "utf8");
  fs.writeFileSync(
    path.join(ws, "src/header.ts"),
    'import { APP_TITLE } from "./constants";\nexport function mountHeader() { return APP_TITLE; }\n',
    "utf8",
  );
  const filler = Array.from({ length: 120 }, (_, i) => `export const noop_${i} = () => ${i};`).join("\n");
  fs.writeFileSync(path.join(ws, "src/noise.ts"), filler + "\n", "utf8");

  const retriever = new WorkspaceBM25Retriever(ws);
  const chunks = retriever.retrieve("Rename APP_TITLE across files", { maxChunks: 4, maxTokens: 1000 });
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.some((c) => c.relPath === "src/constants.ts"));
  assert.ok(chunks.some((c) => c.relPath === "src/header.ts"));
  assert.ok(chunks.every((c) => !c.relPath.includes(".env") && !c.content.includes("SECRET_ENV_VALUE")));

  const mentionBlock = buildRetrievedContextBlock(ws, "Explain @mountHeader in @src/header.ts");
  assert.match(mentionBlock, /\[Retrieved Context\]/);
  assert.match(mentionBlock, /mountHeader/);
});

test("working-memory & budget: stubs old tool outputs, preserves static messages[0], and sheds context in priority order", async () => {
  const staticSys = "STATIC_SYSTEM_PROMPT_DO_NOT_MUTATE_BYTE_FOR_BYTE";
  const history = [
    { role: "system", content: staticSys },
    { role: "user", content: "Refactor billing calculator and add unit tests" },
  ];

  // Add 8 verbose historical turns so compression triggers
  for (let i = 1; i <= 8; i++) {
    history.push({
      role: "assistant",
      content: JSON.stringify({ tool: "writeFile", args: { path: `src/mod${i}.ts` } }),
    });
    history.push({
      role: "user",
      content: `<tool_result name="writeFile" ok="true">\nWrote src/mod${i}.ts (1420 bytes on disk, verified).\n${"extra detail ".repeat(80)}\n</tool_result>`,
    });
  }

  const stub = stubToolResultContent(history[3].content);
  assert.match(stub, /writeFile src\/mod1\.ts: ok/);
  assert.ok(stub.length < 80);

  const mem = createWorkingMemory(history[1].content);
  const compressed = await compressConversationHistory(history, mem, {
    tokenBudget: 450,
    keepRecentMessages: 4,
    rollingSummaryEnabled: true,
  });

  // messages[0] must remain 100% byte-identical
  assert.equal(compressed.messages[0].content, staticSys);
  assert.ok(compressed.evictedCount > 0);
  assert.match(compressed.workingMemoryBlock, /\[Working Memory\]/);
  assert.match(compressed.workingMemoryBlock, /src\/mod1\.ts/);

  // Test priority shedding in fitMessagesToLaneBudget:
  // Priority 6 ([Retrieved Context]) and Priority 5 ([Workspace Repo Map]) shed BEFORE system/working-memory/task!
  const assembled = assembleTurnMessages({
    baseMessages: compressed.messages,
    repoMapBlock: "[Workspace Repo Map]\n" + "- src/file.ts (100L): fn(L1)\n".repeat(60),
    retrievedContextBlock: "[Retrieved Context]\n" + "--- src/file.ts ---\nconst x = 1;\n".repeat(80),
    progressLedgerBlock: "Step 1 done",
  });

  const fitted = fitMessagesToLaneBudget(assembled, 650);
  assert.strictEqual(fitted[0], assembled[0]); // exact same object reference & content!
  assert.equal(fitted[0].content, staticSys);
  const joined = fitted.map((m) => m.content).join("\n");
  assert.match(joined, /Refactor billing calculator/);
  // Huge retrieved context should have been dropped/trimmed to fit 650 tokens
  assert.ok(!joined.includes("--- src/file.ts ---\nconst x = 1;\n".repeat(40)));
});
