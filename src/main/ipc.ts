import { IpcMain } from "electron";
import type { Settings } from "./ui/settings";
import type {
  AiStatus,
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  ChatSessionMeta,
  FsEntry,
  InterruptedRun,
  JobSnapshot,
  KeyStatus,
  KeyTestResult,
  LayoutState,
  LocalModelsState,
  LocalModelTestResult,
  LocalProviderId,
  ModelConfigEntry,
  ModelsStateView,
  ProviderKeyId,
  QuotaLaneView,
  SearchMatch,
  StartInput,
  TerminalInfo,
  TerminalSpawnOptions,
  UserQuestionRequest,
  UserQuestionResponse,
  WorkspaceInfo,
} from "../shared/electron-api-types";

// Central, typed IPC surface (FR-13.1 / PART 4 point 6). Every channel is
// declared here so the preload bridge and the renderer share one source of
// truth, and the main process implements exactly this object.

export interface MainApi {
  // settings
  getSettings: () => Settings;
  setSettings: (s: Partial<Settings>) => Settings;

  // layout (persisted Nova IDE shell state)
  getLayout: () => LayoutState;
  setLayout: (partial: Partial<LayoutState>) => LayoutState;

  // models (PART 1 #3 + PHASE 6)
  modelsGet: () => ModelsStateView;
  modelsSave: (models: ModelConfigEntry[]) => ModelsStateView;
  modelsUseSuggested: (provider: ProviderKeyId, oldModel: string, newModel: string) => ModelsStateView;
  modelsRefreshLive: () => Promise<ModelsStateView>;
  localModelsGet: () => LocalModelsState;
  localModelsDetect: () => Promise<LocalModelsState>;
  localModelsTest: (provider: LocalProviderId, model?: string) => Promise<LocalModelTestResult>;

  // sessions (PART 2)
  sessionsList: () => { sessions: ChatSessionMeta[]; activeSessionId: string };
  sessionsSwitch: (sessionId: string) => { session: ChatSessionMeta; messages: ChatMessage[] };
  sessionsDelete: (sessionId: string) => {
    sessions: ChatSessionMeta[];
    activeSessionId: string;
    messages: ChatMessage[];
  };
  sessionsCreate: () => { session: ChatSessionMeta; sessions: ChatSessionMeta[] };

  // workspace + files (FR-1)
  workspaceRoot: () => string;
  ensureWorkspace: (brief: string) => WorkspaceInfo;
  openFolder: () => Promise<string | null>;
  switchWorkspaceRoot: (dirPath: string) => string;
  listDir: (dirPath: string) => FsEntry[];
  listFiles: (maxFiles?: number) => string[];
  searchFiles: (query: string, maxResults?: number) => SearchMatch[];
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, content: string) => void;
  deleteToTrash: (filePath: string) => void;
  createFile: (filePath: string) => void;
  createDir: (dirPath: string) => void;

  // quota + keys + library (FR-2.8, FR-2.9, FR-8.1)
  quota: () => QuotaLaneView[];
  keyStatus: () => KeyStatus[];
  setKey: (provider: ProviderKeyId, key: string) => KeyStatus[];
  clearKey: (provider: ProviderKeyId) => KeyStatus[];
  testKeys: () => Promise<KeyTestResult[]>;
  aiStatus: () => AiStatus;

  // jobs (FR-6.6, FR-12)
  jobSnapshot: () => JobSnapshot | null;
  interrupted: () => InterruptedRun | null;
  jobStart: (input: StartInput) => JobSnapshot | null;
  jobAnswer: (value: string) => JobSnapshot | null;
  jobSaveSuggested: () => void;
  jobNewChat: () => void;
  jobHistory: () => ChatMessage[];
  jobNote: (text: string) => void;
  jobCancel: () => void;
  jobPause: () => void;
  jobResume: () => Promise<void>;
  pendingApprovals: () => ApprovalRequest[];
  respondApproval: (id: string, decision: ApprovalDecision) => void;
  pendingQuestions: () => UserQuestionRequest[];
  respondQuestion: (response: UserQuestionResponse) => void;

  // terminal (PART 4)
  terminalList: () => TerminalInfo[];
  terminalCreate: (opts?: TerminalSpawnOptions) => TerminalInfo;
  terminalWrite: (id: string, data: string) => void;
  terminalResize: (id: string, cols: number, rows: number) => void;
  terminalKill: (id: string) => void;
  terminalAgentOutput: () => string;

  // logs
  traceLines: () => string[];
}

export function setupIpc(main: IpcMain, api: MainApi) {
  const handle = (channel: string, fn: (...args: any[]) => any) => {
    main.handle(channel, (_e, ...args) => fn(...args));
  };

  // settings
  handle("settings:get", () => api.getSettings());
  handle("settings:set", (s: Partial<Settings>) => api.setSettings(s));

  // layout
  handle("layout:get", () => api.getLayout());
  handle("layout:set", (partial: Partial<LayoutState>) => api.setLayout(partial));

  // models
  handle("models:get", () => api.modelsGet());
  handle("models:save", (models: ModelConfigEntry[]) => api.modelsSave(models));
  handle("models:useSuggested", (provider: ProviderKeyId, oldModel: string, newModel: string) =>
    api.modelsUseSuggested(provider, oldModel, newModel),
  );
  handle("models:refreshLive", () => api.modelsRefreshLive());
  handle("localModels:get", () => api.localModelsGet());
  handle("localModels:detect", () => api.localModelsDetect());
  handle("localModels:test", (provider: LocalProviderId, model?: string) =>
    api.localModelsTest(provider, model),
  );

  // sessions
  handle("sessions:list", () => api.sessionsList());
  handle("sessions:switch", (sessionId: string) => api.sessionsSwitch(sessionId));
  handle("sessions:delete", (sessionId: string) => api.sessionsDelete(sessionId));
  handle("sessions:create", () => api.sessionsCreate());

  // workspace + files
  handle("workspace:root", () => api.workspaceRoot());
  handle("workspace:ensure", (brief: string) => api.ensureWorkspace(brief));
  handle("workspace:openFolder", () => api.openFolder());
  handle("workspace:switchRoot", (dirPath: string) => api.switchWorkspaceRoot(dirPath));
  handle("fs:listDir", (p: string) => api.listDir(p));
  handle("fs:listFiles", (maxFiles?: number) => api.listFiles(maxFiles));
  handle("fs:searchFiles", (query: string, maxResults?: number) => api.searchFiles(query, maxResults));
  handle("fs:readFile", (p: string) => api.readFile(p));
  handle("fs:writeFile", (p: string, c: string) => api.writeFile(p, c));
  handle("fs:deleteToTrash", (p: string) => api.deleteToTrash(p));
  handle("fs:createFile", (p: string) => api.createFile(p));
  handle("fs:createDir", (p: string) => api.createDir(p));

  // quota, keys, library
  handle("quota:get", () => api.quota());
  handle("keys:status", () => api.keyStatus());
  handle("keys:set", (provider: ProviderKeyId, key: string) => api.setKey(provider, key));
  handle("keys:clear", (provider: ProviderKeyId) => api.clearKey(provider));
  handle("keys:test", () => api.testKeys());
  handle("ai:status", () => api.aiStatus());

  // jobs
  handle("jobs:snapshot", () => api.jobSnapshot());
  handle("jobs:interrupted", () => api.interrupted());
  handle("jobs:start", (input: StartInput) => api.jobStart(input));
  handle("jobs:answer", (value: string) => api.jobAnswer(value));
  handle("jobs:saveSuggested", () => api.jobSaveSuggested());
  handle("jobs:newChat", () => api.jobNewChat());
  handle("jobs:history", () => api.jobHistory());
  handle("jobs:note", (text: string) => api.jobNote(text));
  handle("jobs:cancel", () => api.jobCancel());
  handle("jobs:pause", () => api.jobPause());
  handle("jobs:resume", () => api.jobResume());
  handle("jobs:pendingApprovals", () => api.pendingApprovals());
  handle("jobs:respondApproval", (id: string, decision: ApprovalDecision) => api.respondApproval(id, decision));
  handle("jobs:pendingQuestions", () => api.pendingQuestions());
  handle("jobs:respondQuestion", (response: UserQuestionResponse) => api.respondQuestion(response));

  // terminal
  handle("terminal:list", () => api.terminalList());
  handle("terminal:create", (opts?: TerminalSpawnOptions) => api.terminalCreate(opts));
  handle("terminal:write", (id: string, data: string) => api.terminalWrite(id, data));
  handle("terminal:resize", (id: string, cols: number, rows: number) => api.terminalResize(id, cols, rows));
  handle("terminal:kill", (id: string) => api.terminalKill(id));
  handle("terminal:agentOutput", () => api.terminalAgentOutput());

  // logs
  handle("logs:lines", () => api.traceLines());

  // preview
  handle("preview:open", () => undefined);
  handle("preview:close", () => undefined);
}

export const CHAT_EVENT_CHANNEL = "chat:event";
export const TERMINAL_DATA_CHANNEL = "terminal:data";
export const TERMINAL_EXIT_CHANNEL = "terminal:exit";
export const TERMINAL_AGENT_CHANNEL = "terminal:agent";
export const LOG_LINE_CHANNEL = "logs:line";
export const WORKSPACE_CHANGED_CHANNEL = "workspace:changed";
