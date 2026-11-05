import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  ApprovalDecision,
  ChatEvent,
  ElectronApi,
  LayoutState,
  LocalProviderId,
  ModelConfigEntry,
  ProviderKeyId,
  Settings,
  StartInput,
  TerminalExit,
  TerminalSpawnOptions,
  UserQuestionResponse,
  WorkspaceChanged,
} from "../shared/electron-api-types";

// FR-13.1 / PART 3: contextIsolation on, nodeIntegration off, typed IPC only.
// This is the ONLY bridge into the main process.

const CHAT_EVENT_CHANNEL = "chat:event";
const TERMINAL_DATA_CHANNEL = "terminal:data";
const TERMINAL_EXIT_CHANNEL = "terminal:exit";
const TERMINAL_AGENT_CHANNEL = "terminal:agent";
const LOG_LINE_CHANNEL = "logs:line";
const WORKSPACE_CHANGED_CHANNEL = "workspace:changed";

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: ElectronApi = {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (s: Partial<Settings>) => ipcRenderer.invoke("settings:set", s),
  },
  layout: {
    get: () => ipcRenderer.invoke("layout:get"),
    set: (partial: Partial<LayoutState>) => ipcRenderer.invoke("layout:set", partial),
  },
  models: {
    get: () => ipcRenderer.invoke("models:get"),
    save: (models: ModelConfigEntry[]) => ipcRenderer.invoke("models:save", models),
    useSuggested: (provider: ProviderKeyId, oldModel: string, newModel: string) =>
      ipcRenderer.invoke("models:useSuggested", provider, oldModel, newModel),
    refreshLive: () => ipcRenderer.invoke("models:refreshLive"),
  },
  localModels: {
    get: () => ipcRenderer.invoke("localModels:get"),
    detect: () => ipcRenderer.invoke("localModels:detect"),
    test: (provider: LocalProviderId, model?: string) =>
      ipcRenderer.invoke("localModels:test", provider, model),
  },
  sessions: {
    list: () => ipcRenderer.invoke("sessions:list"),
    switch: (sessionId: string) => ipcRenderer.invoke("sessions:switch", sessionId),
    delete: (sessionId: string) => ipcRenderer.invoke("sessions:delete", sessionId),
    create: () => ipcRenderer.invoke("sessions:create"),
  },
  workspace: {
    root: () => ipcRenderer.invoke("workspace:root"),
    ensure: (brief: string) => ipcRenderer.invoke("workspace:ensure", brief),
    openFolder: () => ipcRenderer.invoke("workspace:openFolder"),
    switchRoot: (dirPath: string) => ipcRenderer.invoke("workspace:switchRoot", dirPath),
    onChanged: (cb) => subscribe<WorkspaceChanged>(WORKSPACE_CHANGED_CHANNEL, cb),
  },
  preview: {
    open: (path: string) => ipcRenderer.invoke("preview:open", path),
    close: () => ipcRenderer.invoke("preview:close"),
  },
  fs: {
    readFile: (p: string) => ipcRenderer.invoke("fs:readFile", p),
    writeFile: (p: string, c: string) => ipcRenderer.invoke("fs:writeFile", p, c),
    listDir: (p: string) => ipcRenderer.invoke("fs:listDir", p),
    listFiles: (maxFiles?: number) => ipcRenderer.invoke("fs:listFiles", maxFiles),
    searchFiles: (query: string, maxResults?: number) =>
      ipcRenderer.invoke("fs:searchFiles", query, maxResults),
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
    start: (input: StartInput) => {
      console.log(`[chat ${input.traceId ?? "----"}] 2 preload: ipc invoke`);
      return ipcRenderer.invoke("jobs:start", input);
    },
    answer: (value: string) => ipcRenderer.invoke("jobs:answer", value),
    saveSuggested: () => ipcRenderer.invoke("jobs:saveSuggested"),
    newChat: () => ipcRenderer.invoke("jobs:newChat"),
    history: () => ipcRenderer.invoke("jobs:history"),
    note: (text: string) => ipcRenderer.invoke("jobs:note", text),
    cancel: () => ipcRenderer.invoke("jobs:cancel"),
    pause: () => ipcRenderer.invoke("jobs:pause"),
    resume: () => ipcRenderer.invoke("jobs:resume"),
    pendingApprovals: () => ipcRenderer.invoke("jobs:pendingApprovals"),
    respondApproval: (id: string, decision: ApprovalDecision) =>
      ipcRenderer.invoke("jobs:respondApproval", id, decision),
    pendingQuestions: () => ipcRenderer.invoke("jobs:pendingQuestions"),
    respondQuestion: (response: UserQuestionResponse) =>
      ipcRenderer.invoke("jobs:respondQuestion", response),
    onEvent: (cb: (e: ChatEvent) => void) => subscribe<ChatEvent>(CHAT_EVENT_CHANNEL, cb),
  },
  terminal: {
    list: () => ipcRenderer.invoke("terminal:list"),
    create: (opts?: TerminalSpawnOptions) => ipcRenderer.invoke("terminal:create", opts),
    write: (id: string, data: string) => ipcRenderer.invoke("terminal:write", id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke("terminal:resize", id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke("terminal:kill", id),
    agentOutput: () => ipcRenderer.invoke("terminal:agentOutput"),
    onData: (cb: (e: { id: string; data: string }) => void) =>
      subscribe<{ id: string; data: string }>(TERMINAL_DATA_CHANNEL, cb),
    onExit: (cb: (e: TerminalExit) => void) => subscribe<TerminalExit>(TERMINAL_EXIT_CHANNEL, cb),
    onAgentData: (cb: (e: { data: string }) => void) => subscribe<{ data: string }>(TERMINAL_AGENT_CHANNEL, cb),
  },
  logs: {
    lines: () => ipcRenderer.invoke("logs:lines"),
    onLine: (cb: (line: string) => void) => subscribe<string>(LOG_LINE_CHANNEL, cb),
  },
  app: {
    getVersion: () => "0.1.0",
  },
};

contextBridge.exposeInMainWorld("electron", api);
