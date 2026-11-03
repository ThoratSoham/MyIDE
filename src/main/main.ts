import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";
import log from "electron-log";
import { setupIpc, JOB_EVENT_CHANNEL, type MainApi } from "./ipc";
import { type Settings } from "./ui/settings";
import { workspaceRootPath, setWorkspaceRoot } from "./fs-workspace";
import { registerPreviewProtocol } from "./preview-protocol";
import {
  listDir,
  readFile,
  writeFile,
  deleteToTrash,
  createFile,
  createDir,
} from "./fs-workspace";
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
import type {
  AiStatus,
  KeyStatus,
  KeyTestResult,
  ProviderKeyId,
} from "../shared/electron-api-types";

log.transports.file.level = "info";
log.transports.console.level = "debug";
log.info("MyIDE starting");

let mainWindow: BrowserWindow | null = null;

const ai = new AIService();
let jobs: JobManager | null = null;

function getRendererUrl() {
  if (process.env.NODE_ENV === "development" || !app.isPackaged) {
    return `http://localhost:5173`;
  }
  return `file://${path.join(__dirname, "../renderer/index.html")}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    backgroundColor: "#111111",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.loadURL(getRendererUrl());

  if (process.env.NODE_ENV === "development" || !app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
}

// FR-12.1: push every job event to the window as it happens.
function emitToWindow(event: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(JOB_EVENT_CHANNEL, event);
  }
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
    return publicSettings();
  },

  workspaceRoot: () => workspaceRootPath(),
  openFolder: async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Open a folder as your workspace",
    });
    if (result.canceled || !result.filePaths.length) return null;
    const root = setWorkspaceRoot(result.filePaths[0]);
    // Keep the preview protocol's allow-list in step with the new root (FR-11.1).
    (globalThis as any).__MYIDE_WORKSPACE_ROOT__ = root;
    jobs?.setWorkspaceRoot(root);
    return root;
  },
  listDir: (p) => listDir(p),
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
    packs: (jobs?.library().packs ?? []).map((p) => ({
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
  startWebsite: (brief, mode) => mustJobs().startWebsite(brief, mode),
  startAgent: (task, mode) => mustJobs().startAgent(task, mode),
  jobNote: (text) => jobs?.note(text),
  jobCancel: () => jobs?.cancel(),
  jobResume: async () => {
    await jobs?.resume();
  },
  pendingApprovals: () => jobs?.pendingApprovals() ?? [],
  respondApproval: (id, decision) => jobs?.respondApproval(id, decision),
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

  // FR-2.3: load the quota ledger, then bring the lanes up.
  ai.init();
  jobs = new JobManager({
    ai,
    workspaceRoot: () => workspaceRootPath(),
    emit: emitToWindow,
    onPreview: (rel) => emitToWindow({ type: "preview", path: rel }),
  });

  log.info("MyIDE ready");
  createWindow();
});

app.on("before-quit", () => {
  ai.save();
  jobs?.dispose();
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
