/* PART 4 point 8: real terminal tests.
 * A pty (or the documented child_process fallback) is started for real, a
 * command is run, the output is read back, resize and kill are exercised, the
 * start folder is the project folder, and no secret reaches the environment. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const { REPO, installElectronStub } = require(path.join(__dirname, "helpers", "harness.js"));

installElectronStub();
const env = require(path.join(REPO, "dist", "main", "terminal", "env.js"));
const { TerminalManager } = require(path.join(REPO, "dist", "main", "terminal", "manager.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start a manager whose workspace is a fresh temp folder, and record output. */
function makeTerminal() {
  const root = fs.mkdtempSync(path.join(require("os").tmpdir(), "myide-term-"));
  const output = { data: "", exits: [], agents: [] };
  let lastEmit = 0;
  const manager = new TerminalManager({
    workspaceRoot: () => root,
    emitData: (_id, data) => {
      output.data += data;
      lastEmit = Date.now();
    },
    emitExit: (e) => output.exits.push(e),
    emitAgentData: (chunk) => output.agents.push(chunk),
  });
  return { manager, root, output, lastEmitAt: () => lastEmit };
}

/** Wait for some text to appear in the terminal output. */
async function waitForText(output, needle, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (output.data.includes(needle)) return true;
    await sleep(100);
  }
  return output.data.includes(needle);
}

test("terminal: starts in the project folder and runs 'echo hello'", async () => {
  const { manager, root, output } = makeTerminal();
  const info = manager.create();

  assert.equal(info.cwd, root, "the terminal must start in the project folder");
  assert.ok(info.backend === "pty" || info.backend === "child_process", "a real backend must be reported");
  if (info.backend === "child_process") {
    assert.ok(info.warning, "the simple fallback must explain itself (PART 4 point 7)");
  }

  manager.write(info.id, "echo hello\r");
  const got = await waitForText(output, "hello");
  assert.ok(got, `the terminal must print hello; got: ${JSON.stringify(output.data.slice(0, 400))}`);

  manager.disposeAll();
});

test("terminal: resize validates sizes instead of throwing", () => {
  const { manager } = makeTerminal();
  const info = manager.create({ cols: 80, rows: 24 });

  assert.doesNotThrow(() => manager.resize(info.id, 120, 40));
  // Out-of-range values must be clamped, never thrown at the shell.
  assert.doesNotThrow(() => manager.resize(info.id, -5, 9999));
  assert.doesNotThrow(() => manager.resize(info.id, Number.NaN, undefined));

  manager.disposeAll();
});

test("terminal: kill removes the session and reports the exit", () => {
  const { manager, output } = makeTerminal();
  const info = manager.create();
  assert.equal(manager.list().length, 1);

  manager.kill(info.id);

  assert.equal(manager.list().length, 0, "the session must be gone after kill");
  assert.ok(output.exits.some((e) => e.id === info.id), "an exit event must be reported");
});

test("terminal: at most 8 terminals can be open", () => {
  const { manager } = makeTerminal();
  for (let i = 0; i < 8; i++) manager.create();
  assert.throws(() => manager.create(), /At most 8/);
  manager.disposeAll();
});

test("terminal: no API key or token reaches the environment", async () => {
  // A secret in the app's own environment must never reach the shell.
  const SECRET = "s3cr3t-value-should-not-appear";
  process.env.MYIDE_TEST_KEY = SECRET;
  process.env.MYIDE_TEST_TOKEN = SECRET;

  const { manager, output } = makeTerminal();
  const info = manager.create();
  manager.write(info.id, "echo $env:MYIDE_TEST_KEY\r");
  await sleep(1200);

  assert.ok(!output.data.includes(SECRET), `the secret must not appear in the terminal: ${output.data.slice(0, 400)}`);

  manager.disposeAll();
  delete process.env.MYIDE_TEST_KEY;
  delete process.env.MYIDE_TEST_TOKEN;
});

test("sanitizeTerminalEnv strips every _KEY and _TOKEN variable", () => {
  const cleaned = env.sanitizeTerminalEnv({
    PATH: "/usr/bin",
    HOME: "/home/me",
    GEMINI_API_KEY: "x",
    OPENROUTER_API_KEY: "x",
    GROQ_API_KEY: "x",
    SOME_TOKEN: "x",
    MY_SECRET: "x",
    DB_PASSWORD: "x",
  });

  assert.equal(cleaned.PATH, "/usr/bin");
  assert.equal(cleaned.HOME, "/home/me");
  for (const name of Object.keys(cleaned)) {
    assert.ok(!/_KEY$/.test(name), `${name} must be stripped`);
    assert.ok(!/_TOKEN$/.test(name), `${name} must be stripped`);
  }
});

test("shellCandidates picks the platform default with a fallback", () => {
  const win = env.shellCandidates("win32", {}).map((c) => c.file);
  assert.equal(win[0], "powershell.exe");
  assert.ok(win.includes("cmd.exe") || win.some((f) => /cmd/i.test(f)), "cmd must be the Windows fallback");

  const mac = env.shellCandidates("darwin", { SHELL: "/bin/zsh" });
  assert.equal(mac[0].file, "/bin/zsh");
  assert.ok(mac.some((c) => c.file === "/bin/bash"), "bash must be a fallback");

  const linux = env.shellCandidates("linux", {});
  assert.equal(linux[0].file, "/bin/zsh");
});
