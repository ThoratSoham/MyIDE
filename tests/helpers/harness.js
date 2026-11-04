/* Test helper: run the real, compiled main-process modules in plain Node.
 * Electron and electron-log are replaced in the module cache so nothing needs a
 * display, a GPU or a network. No test ever calls a real provider. */
const path = require("path");
const fs = require("fs");
const os = require("os");

const REPO = path.resolve(__dirname, "..", "..");

/** Replace a module in the require cache with a stub. */
function stubModule(name, exportsObject) {
  const resolved = require.resolve(name, { paths: [REPO] });
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObject,
    children: [],
    paths: [],
  };
}

/** Install the electron + electron-log stubs. Returns the temp folders used. */
function installElectronStub() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "myide-test-"));
  const documents = path.join(home, "Documents");
  const userData = path.join(home, "userData");
  fs.mkdirSync(documents, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });

  const app = {
    getPath: (n) => {
      if (n === "userData") return userData;
      if (n === "documents") return documents;
      return home;
    },
    getAppPath: () => REPO,
    isPackaged: false,
    getName: () => "myide",
    getVersion: () => "0.1.0",
  };

  stubModule("electron", {
    app,
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s) => Buffer.from(s, "utf8"),
      decryptString: (b) => b.toString("utf8"),
    },
    ipcMain: { handle() {} },
    BrowserWindow: class {},
    dialog: {},
    shell: {},
  });

  const logger = { info() {}, warn() {}, error() {}, debug() {}, verbose() {} };
  logger.transports = { file: {}, console: {} };
  stubModule("electron-log", { __esModule: true, default: logger, ...logger });

  return { home, documents, userData };
}

/** Load the compiled JobManager against a fresh workspace held outside the repo. */
function freshWorkspace(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `myide-${label}-`));
  return dir;
}

/** A scripted, deterministic AI service. Never touches the network. */
function makeFakeAI(script) {
  let i = 0;
  const calls = [];
  return {
    onWaiting: null,
    lastFailure: null,
    isOfflineMode: () => false,
    providerLabels: () => ({ offline: "Offline library", fake: "Fake provider" }),
    quotaSnapshot: () => [],
    init() {},
    reload() {},
    save() {},
    calls,
    async complete(task, messages) {
      calls.push({ task, last: messages[messages.length - 1] && messages[messages.length - 1].content });
      const reply = script[Math.min(i, script.length - 1)];
      i += 1;
      return reply(messages, i);
    },
  };
}

/** Wait until the job is no longer running (or the deadline passes). */
async function waitForIdle(jobs, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = jobs.snapshot();
    if (s && !s.running) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  return jobs.snapshot();
}

const okReply = (obj) => ({
  ok: true,
  content: JSON.stringify(obj),
  laneUsed: { id: "fake:provider", provider: "fake", model: "fake-1" },
  promptTokens: 10,
  completionTokens: 10,
});

const textReply = (content) => ({
  ok: true,
  content,
  laneUsed: { id: "fake:provider", provider: "fake", model: "fake-1" },
  promptTokens: 10,
  completionTokens: 10,
});

module.exports = {
  REPO,
  stubModule,
  installElectronStub,
  freshWorkspace,
  makeFakeAI,
  waitForIdle,
  okReply,
  textReply,
};
