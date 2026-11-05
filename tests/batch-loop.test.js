const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installElectronStub, freshWorkspace, makeFakeAI, okReply } = require("./helpers/harness");

installElectronStub();

const { createAgentState, runAgent } = require("../dist/main/agent/loop");

test("batch loop: executes multi-action batch sequentially and finishes in 2 calls", async () => {
  const ws = freshWorkspace("batch-ok");
  const state = createAgentState(ws);
  const events = [];

  const ai = makeFakeAI([
    () =>
      okReply({
        thought: "Create two files and read them back in one batch",
        actions: [
          { tool: "writeFile", args: { path: "src/a.txt", content: "alpha" } },
          { tool: "writeFile", args: { path: "src/b.txt", content: "beta" } },
          { tool: "readFile", args: { path: "src/a.txt" } },
          { tool: "readFile", args: { path: "src/b.txt" } },
        ],
      }),
    (messages) => {
      const last = messages[messages.length - 1].content;
      assert.match(last, /<tool_results executed="4" requested="4">/);
      assert.match(last, /alpha/);
      assert.match(last, /beta/);
      return okReply({
        thought: "All 4 actions succeeded",
        tool: "markComplete",
        args: { summary: "Created a.txt and b.txt." },
      });
    },
  ]);

  const summary = await runAgent(ai, state, {
    taskMd: "Create src/a.txt and src/b.txt",
    signal: { cancelled: false },
    onEvent: (e) => events.push(e),
    requestApproval: async () => "once",
  });

  assert.equal(summary, "Created a.txt and b.txt.");
  assert.equal(ai.calls.length, 2);
  assert.equal(fs.readFileSync(path.join(ws, "src/a.txt"), "utf8"), "alpha");
  assert.equal(fs.readFileSync(path.join(ws, "src/b.txt"), "utf8"), "beta");
  assert.equal(events.filter((e) => e.type === "tool").length, 5); // 4 in batch + markComplete
});

test("batch loop: stops at first mid-batch failure and returns prior successes + failure in one message", async () => {
  const ws = freshWorkspace("batch-mid-fail");
  const state = createAgentState(ws);

  let combinedFeedback = "";
  const ai = makeFakeAI([
    () =>
      okReply({
        thought: "Write first.txt, fail editFile on missing string, and attempt third.txt",
        actions: [
          { tool: "writeFile", args: { path: "first.txt", content: "hello world" } },
          { tool: "editFile", args: { path: "first.txt", find: "NON_EXISTENT", replace: "bye" } },
          { tool: "writeFile", args: { path: "should-not-exist.txt", content: "nope" } },
        ],
      }),
    (messages) => {
      combinedFeedback = messages[messages.length - 1].content;
      return okReply({
        thought: "Recover and complete",
        tool: "markComplete",
        args: { summary: "Handled mid-batch stop." },
      });
    },
  ]);

  await runAgent(ai, state, {
    taskMd: "Test mid-batch failure",
    signal: { cancelled: false },
    onEvent: () => {},
    requestApproval: async () => "once",
  });

  assert.equal(fs.existsSync(path.join(ws, "first.txt")), true);
  assert.equal(fs.existsSync(path.join(ws, "should-not-exist.txt")), false);
  assert.match(combinedFeedback, /<tool_results executed="2" requested="3">/);
  assert.match(combinedFeedback, /index="1" name="writeFile" ok="true"/);
  assert.match(combinedFeedback, /index="2" name="editFile" ok="false"/);
  assert.match(combinedFeedback, /Batch stopped at action 2\/3/);
});

test("batch loop: pauses for command approval and aborts remaining actions when denied", async () => {
  const ws = freshWorkspace("batch-deny");
  const state = createAgentState(ws);
  const approvalCalls = [];
  let combinedFeedback = "";

  const ai = makeFakeAI([
    () =>
      okReply({
        thought: "Write before.txt, run command that gets denied, then write after.txt",
        actions: [
          { tool: "writeFile", args: { path: "before.txt", content: "ok" } },
          { tool: "executeCommand", args: { command: "echo test-deny", reason: "Check shell" } },
          { tool: "writeFile", args: { path: "after.txt", content: "must not run" } },
        ],
      }),
    (messages) => {
      combinedFeedback = messages[messages.length - 1].content;
      return okReply({
        thought: "User denied command; wrap up",
        answer: "Stopped after command denial.",
      });
    },
  ]);

  const out = await runAgent(ai, state, {
    taskMd: "Run batch with denied command",
    signal: { cancelled: false },
    onEvent: () => {},
    requestApproval: async (cmd) => {
      approvalCalls.push(cmd);
      return "deny";
    },
  });

  assert.equal(approvalCalls.length, 1);
  assert.equal(fs.existsSync(path.join(ws, "before.txt")), true);
  assert.equal(fs.existsSync(path.join(ws, "after.txt")), false);
  assert.match(combinedFeedback, /index="1" name="writeFile" ok="true"/);
  assert.match(combinedFeedback, /index="2" name="executeCommand" ok="false"/);
  assert.match(combinedFeedback, /remaining 1 action\(s\) were NOT executed/);
  assert.match(out, /Stopped after command denial/);
});

test("batch loop: preserves backward compatibility with legacy single-tool envelope", async () => {
  const ws = freshWorkspace("batch-legacy");
  const state = createAgentState(ws);
  let singleToolFeedback = "";

  const ai = makeFakeAI([
    () =>
      okReply({
        thought: "Single legacy writeFile call",
        tool: "writeFile",
        args: { path: "legacy.txt", content: "legacy-ok" },
      }),
    (messages) => {
      singleToolFeedback = messages[messages.length - 1].content;
      return okReply({
        thought: "Finish",
        tool: "markComplete",
        args: { summary: "Legacy envelope works." },
      });
    },
  ]);

  const out = await runAgent(ai, state, {
    taskMd: "Create legacy.txt",
    signal: { cancelled: false },
    onEvent: () => {},
    requestApproval: async () => "once",
  });

  assert.equal(out, "Legacy envelope works.");
  assert.equal(fs.readFileSync(path.join(ws, "legacy.txt"), "utf8"), "legacy-ok");
  assert.match(singleToolFeedback, /^<tool_result name="writeFile" ok="true">/);
});
