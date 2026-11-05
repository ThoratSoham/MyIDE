import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";
import log from "electron-log";
import {
  setupIpc,
  type MainApi,
  CHAT_EVENT_CHANNEL,
  TERMINAL_DATA_CHANNEL,
  TERMINAL_EXIT_CHANNEL,
  TERMINAL_AGENT_CHANNEL,
  LOG_LINE_CHANNEL,
  WORKSPACE_CHANGED_CHANNEL,
} from "./ipc";
import { setWorkspaceChangeSink, watchWorkspace, stopWatching } from "./fs-watcher";
import { type Settings } from "./ui/settings";
import { getLayout, setLayout, recordRecentWorkspace } from "./ui/layout-store";
import { workspaceRootPath, setWorkspaceRoot, ensureProjectWorkspace } from "./fs-workspace";
import { registerPreviewProtocol } from "./preview-protocol";
import {
  listDir,
  listWorkspaceFiles,
  searchWorkspaceFiles,
  readFile,
  writeFile,
  deleteToTrash,
  createFile,
  createDir,
} from "./fs-workspace";
import {
  getRunFileDiff,
  revertFileFromRun,
  undoEntireRun,
} from "./agent/checkpoints";
import {
  getProviderKey,
  keyLast4,
  publicSettings,
  setProviderKey,
  setSettings as persistSettings,
} from "./store";
import { AIService } from "./ai/service";
import { PROVIDER_CONFIGS } from "./ai/providers";
import { testProviderKey } from "./ai/real-providers";
import { JobManager } from "./jobs";
import { loadLibrary, type Library } from "./skills/library";
import { TerminalManager } from "./terminal/manager";
import { setTraceSink, traceLines } from "./trace";
import { makeSmokeAI, runSmoke, runUiTour, smokeEnabled, smokeScenario, uiTourOutDir } from "./smoke";
import type {
  AiStatus,
  KeyStatus,
  KeyTestResult,
  ProviderKeyId,
  StartInput,
  TerminalSpawnOptions,
} from "../shared/electron-api-types";

log.transports.file.level = "info";
log.transports.console.level = "debug";
log.info("MyIDE starting");

// The headless chat test runs without a GPU so it behaves the same everywhere.
if (smokeEnabled()) app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | null = null;

const ai = new AIService();
let jobs: JobManager | null = null;
let terminals: TerminalManager | null = null;
// FR-8.1: the skill library is read once and reported in the status.
let libraryCache: Library | null = null;
function libraryInfo(): Library {
  if (!libraryCache) libraryCache = loadLibrary();
  return libraryCache;
}

function getRendererUrl() {
  if (smokeEnabled()) {
    if (process.env.MYIDE_SMOKE_URL) return process.env.MYIDE_SMOKE_URL;
    return `file://${path.join(__dirname, "../renderer/index.html").replace(/\\/g, "/")}`;
  }
  if (process.env.NODE_ENV === "development" || !app.isPackaged) {
    return `http://localhost:5173`;
  }
  return `file://${path.join(__dirname, "../renderer/index.html")}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: "Nova IDE",
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: "#0b0d12",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !smokeEnabled(),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  mainWindow.once("ready-to-show", () => {
    if (!smokeEnabled()) mainWindow?.show();
  });

  mainWindow.loadURL(getRendererUrl());

  if (!smokeEnabled() && (process.env.NODE_ENV === "development" || !app.isPackaged)) {
    mainWindow.webContents.openDevTools();
  }
  return mainWindow;
}

function send(channel: string, payload: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// FR-12.1 / PART 1 point 3: push every chat event to the window as it happens.
function emitToWindow(event: unknown) {
  send(CHAT_EVENT_CHANNEL, event);
}

function keyStatuses(): KeyStatus[] {
  return (["gemini", "openrouter", "groq"] as ProviderKeyId[]).map((p) => ({
    provider: p,
    label: PROVIDER_CONFIGS[p].label,
    last4: keyLast4(p),
    configured: !!getProviderKey(p),
  }));
}

const api: MainApi = {
  getSettings: () => publicSettings(),
  setSettings: (s: Partial<Settings>) => {
    persistSettings(s);
    ai.onSettingsChanged();
    return publicSettings();
  },

  getLayout: () => getLayout(),
  setLayout: (partial) => setLayout(partial),

  modelsGet: () => ai.modelsState(),
  modelsSave: (models) => ai.updateModels(models),
  modelsUseSuggested: (provider, oldModel, newModel) => ai.useSuggestedModel(provider, oldModel, newModel),
  modelsRefreshLive: () => ai.syncLiveModels(true),
  localModelsGet: () => ai.localModelsState(),
  localModelsDetect: () => ai.detectLocalModels(),
  localModelsTest: (provider, model) => ai.testLocalModel(provider, model),

  checkpointsDiff: (runId: string, relPath: string) =>
    getRunFileDiff(workspaceRootPath(), runId, relPath),
  checkpointsRevertFile: (runId: string, relPath: string) => {
    const res = revertFileFromRun(workspaceRootPath(), runId, relPath, deleteToTrash);
    if (res.ok) {
      send(WORKSPACE_CHANGED_CHANNEL, { path: relPath, kind: "file" });
    }
    return res;
  },
  checkpointsUndoRun: (runId: string) => {
    const res = undoEntireRun(workspaceRootPath(), runId, deleteToTrash);
    if (res.ok) {
      send(WORKSPACE_CHANGED_CHANNEL, { path: workspaceRootPath(), kind: "root" });
    }
    return res;
  },

  sessionsList: () => jobs?.listSessions() ?? { sessions: [], activeSessionId: "" },
  sessionsSwitch: (sessionId) => mustJobs().switchSession(sessionId),
  sessionsDelete: (sessionId) => mustJobs().deleteSession(sessionId),
  sessionsCreate: () => mustJobs().createSession(),

  workspaceRoot: () => workspaceRootPath(),
  ensureWorkspace: (brief) => {
    const info = ensureProjectWorkspace(brief);
    (globalThis as any).__MYIDE_WORKSPACE_ROOT__ = info.path;
    recordRecentWorkspace(info.path);
    // PART 2 point 5 + PART 3 point 6: follow the new folder and tell the
    // renderer to rebuild the tree, tabs and preview.
    watchWorkspace(info.path);
    send(WORKSPACE_CHANGED_CHANNEL, { path: info.path, kind: "root" });
    return info;
  },
  openFolder: async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Open a folder in Nova IDE",
    });
    if (result.canceled || !result.filePaths.length) return null;
    const root = setWorkspaceRoot(result.filePaths[0]);
    // Keep the preview protocol's allow-list in step with the new root (FR-11.1).
    (globalThis as any).__MYIDE_WORKSPACE_ROOT__ = root;
    recordRecentWorkspace(root);
    jobs?.setWorkspaceRoot(root);
    watchWorkspace(root);
    send(WORKSPACE_CHANGED_CHANNEL, { path: root, kind: "root" });
    return root;
  },
  switchWorkspaceRoot: (dirPath: string) => {
    const root = setWorkspaceRoot(dirPath);
    (globalThis as any).__MYIDE_WORKSPACE_ROOT__ = root;
    recordRecentWorkspace(root);
    jobs?.setWorkspaceRoot(root);
    watchWorkspace(root);
    send(WORKSPACE_CHANGED_CHANNEL, { path: root, kind: "root" });
    return root;
  },
  listDir: (p) => listDir(p),
  listFiles: (maxFiles) => listWorkspaceFiles(maxFiles),
  searchFiles: (query, maxResults) => searchWorkspaceFiles(query, maxResults),
  readFile: (p) => readFile(p),
  writeFile: (p, c) => writeFile(p, c),
  deleteToTrash: (p) => deleteToTrash(p),
  createFile: (p) => createFile(p),
  createDir: (p) => createDir(p),

  quota: () => ai.quotaSnapshot(),
  keyStatus: () => keyStatuses(),
  setKey: (provider: ProviderKeyId, key: string) => {
    setProviderKey(provider, key);
    // FR-2.7: a new key means the lanes must be rebuilt and re-checked.
    ai.reload();
    return keyStatuses();
  },
  clearKey: (provider: ProviderKeyId) => {
    setProviderKey(provider, "");
    ai.reload();
    return keyStatuses();
  },
  testKeys: async (): Promise<KeyTestResult[]> => {
    const out: KeyTestResult[] = [];
    for (const p of ["gemini", "openrouter", "groq"] as ProviderKeyId[]) {
      const key = getProviderKey(p);
      const label = PROVIDER_CONFIGS[p].label;
      if (!key) {
        out.push({ provider: p, label, ok: false, message: "no key set" });
        continue;
      }
      const r = await testProviderKey(p, key);
      out.push({ provider: p, label, ok: r.ok, message: r.message });
    }
    return out;
  },
  aiStatus: (): AiStatus => ({
    offline: ai.isOfflineMode(),
    providerLabels: ai.providerLabels(),
    keys: keyStatuses(),
    packs: libraryInfo().packs.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      ok: p.ok,
      problems: p.problems,
    })),
    version: app.getVersion(),
  }),

  jobSnapshot: () => jobs?.snapshot() ?? null,
  interrupted: () => jobs?.interrupted() ?? null,
  jobStart: (input: StartInput) => mustJobs().start(input),
  jobAnswer: (value: string) => jobs?.answer(value) ?? null,
  jobSaveSuggested: () => jobs?.saveSuggested(),
  jobNewChat: () => jobs?.newChat(),
  jobHistory: () => jobs?.historyMessages() ?? [],
  jobNote: (text) => jobs?.note(text),
  jobCancel: () => jobs?.cancel(),
  jobPause: () => jobs?.pause(),
  jobResume: async () => {
    await jobs?.resume();
  },
  pendingApprovals: () => jobs?.pendingApprovals() ?? [],
  respondApproval: (id, decision) => jobs?.respondApproval(id, decision),
  pendingQuestions: () => jobs?.pendingQuestions() ?? [],
  respondQuestion: (response) => jobs?.respondQuestion(response),

  terminalList: () => terminals?.list() ?? [],
  terminalCreate: (opts?: TerminalSpawnOptions) => {
    if (!terminals) throw new Error("the terminal is not ready yet");
    return terminals.create(opts);
  },
  terminalWrite: (id, data) => terminals?.write(id, data),
  terminalResize: (id, cols, rows) => terminals?.resize(id, cols, rows),
  terminalKill: (id) => terminals?.kill(id),
  terminalAgentOutput: () => terminals?.agentOutput() ?? "",

  traceLines: () => traceLines(),
};

function mustJobs(): JobManager {
  if (!jobs) throw new Error("the job manager is not ready yet");
  return jobs;
}

app.on("ready", () => {
  // FR-11.1 / FR-13.4: register the private preview protocol that serves only
  // workspace files. Do this early, before any window loads a preview.
  registerPreviewProtocol();
  const root = workspaceRootPath();
  (globalThis as any).__MYIDE_WORKSPACE_ROOT__ = root;

  // PART 3 point 6: one watcher on the workspace root; changes refresh the UI.
  setWorkspaceChangeSink((e) => send(WORKSPACE_CHANGED_CHANNEL, e));
  watchWorkspace(root);

  // PART 4: the terminal manager owns the pseudo terminals in the main process.
  terminals = new TerminalManager({
    workspaceRoot: () => workspaceRootPath(),
    emitData: (id, data) => send(TERMINAL_DATA_CHANNEL, { id, data }),
    emitExit: (e) => send(TERMINAL_EXIT_CHANNEL, e),
    emitAgentData: (data) => send(TERMINAL_AGENT_CHANNEL, { data }),
  });
  // PART 1 DIAGNOSE: the numbered trace goes to the Logs panel too.
  setTraceSink((line) => send(LOG_LINE_CHANNEL, line));

  // FR-2.3: load the quota ledger, then bring the lanes up.
  ai.init();
  const smoke = smokeEnabled();
  const scenario = smokeScenario();
  jobs = new JobManager({
    ai: smoke ? makeSmokeAI(scenario) : ai,
    workspaceRoot: () => workspaceRootPath(),
    emit: emitToWindow,
    onPreview: (rel) => emitToWindow({ type: "preview", path: rel, runId: "preview" }),
    onOpenFile: (rel) => emitToWindow({ type: "open-file", path: rel, runId: "preview" }),
    onWorkspaceChanged: () => emitToWindow({ type: "workspace", path: workspaceRootPath(), created: false, isDefault: false, runId: "workspace" }),
    onAgentOutput: (chunk) => terminals?.agentWrite(chunk),
    onChooseWorkspace: async () => {
      const picked = await api.openFolder();
      return picked;
    },
  });

  log.info("MyIDE ready");
  const win = createWindow();

  const tourOut = uiTourOutDir();
  if (tourOut) {
    void runUiTour(win, path.resolve(tourOut))
      .catch((e) => log.error("ui tour failed", e))
      .finally(() => app.exit(0));
  } else if (smoke) {
    const outDir = process.env.MYIDE_SMOKE_OUT
      ? path.resolve(process.env.MYIDE_SMOKE_OUT)
      : path.join(process.cwd(), ".diag");
    void runSmoke(win, scenario, outDir)
      .catch((e) => log.error("smoke failed", e))
      .finally(() => app.exit(0));
  }
});

app.on("before-quit", () => {
  ai.save();
  stopWatching();
  jobs?.dispose();
  // PART 4 point 4: kill all terminals when the app closes.
  terminals?.disposeAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// The public IPC surface (FR-13.1): one typed channel table, no ad-hoc handlers.
setupIpc(ipcMain, api);
