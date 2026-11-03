import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  ApprovalDecision,
  ElectronApi,
  JobEvent,
  JobMode,
  ProviderKeyId,
  Settings,
} from "../shared/electron-api-types";

// FR-13.1: contextIsolation on, nodeIntegration off, typed IPC only.
// This is the ONLY bridge into the main process. The renderer can never reach
// Node directly.

const api: ElectronApi = {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (s: Partial<Settings>) => ipcRenderer.invoke("settings:set", s),
  },
  workspace: {
    root: () => ipcRenderer.invoke("workspace:root"),
    openFolder: () => ipcRenderer.invoke("workspace:openFolder"),
  },
  preview: {
    open: (path: string) => ipcRenderer.invoke("preview:open", path),
    close: () => ipcRenderer.invoke("preview:close"),
  },
  fs: {
    readFile: (p: string) => ipcRenderer.invoke("fs:readFile", p),
    writeFile: (p: string, c: string) => ipcRenderer.invoke("fs:writeFile", p, c),
    listDir: (p: string) => ipcRenderer.invoke("fs:listDir", p),
    deleteToTrash: (p: string) => ipcRenderer.invoke("fs:deleteToTrash", p),
    createFile: (p: string) => ipcRenderer.invoke("fs:createFile", p),
    createDir: (p: string) => ipcRenderer.invoke("fs:createDir", p),
  },
  quota: {
    get: () => ipcRenderer.invoke("quota:get"),
  },
  keys: {
    status: () => ipcRenderer.invoke("keys:status"),
    set: (provider: ProviderKeyId, key: string) => ipcRenderer.invoke("keys:set", provider, key),
    clear: (provider: ProviderKeyId) => ipcRenderer.invoke("keys:clear", provider),
    test: () => ipcRenderer.invoke("keys:test"),
  },
  ai: {
    status: () => ipcRenderer.invoke("ai:status"),
  },
  jobs: {
    snapshot: () => ipcRenderer.invoke("jobs:snapshot"),
    interrupted: () => ipcRenderer.invoke("jobs:interrupted"),
    startWebsite: (brief: string, mode: JobMode) => ipcRenderer.invoke("jobs:startWebsite", brief, mode),
    startAgent: (task: string, mode?: JobMode) => ipcRenderer.invoke("jobs:startAgent", task, mode),
    note: (text: string) => ipcRenderer.invoke("jobs:note", text),
    cancel: () => ipcRenderer.invoke("jobs:cancel"),
    resume: () => ipcRenderer.invoke("jobs:resume"),
    pendingApprovals: () => ipcRenderer.invoke("jobs:pendingApprovals"),
    respondApproval: (id: string, decision: ApprovalDecision) =>
      ipcRenderer.invoke("jobs:respondApproval", id, decision),
    onEvent: (cb: (e: JobEvent) => void) => {
      const listener = (_e: IpcRendererEvent, payload: JobEvent) => cb(payload);
      ipcRenderer.on("job:event", listener);
      return () => ipcRenderer.removeListener("job:event", listener);
    },
  },
  app: {
    getVersion: () => "0.1.0",
  },
};

contextBridge.exposeInMainWorld("electron", api);
