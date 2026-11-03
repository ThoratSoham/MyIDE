import { IpcMain } from "electron";
import type { Settings } from "./ui/settings";
import type {
  AiStatus,
  ApprovalDecision,
  ApprovalRequest,
  FsEntry,
  InterruptedRun,
  JobMode,
  JobSnapshot,
  KeyStatus,
  KeyTestResult,
  ProviderKeyId,
  QuotaLaneView,
} from "../shared/electron-api-types";

// Central, typed IPC surface (FR-13.1). Every channel is declared here so the
// preload bridge and the renderer share one source of truth, and the main
// process implements exactly this object.

export interface MainApi {
  // settings
  getSettings: () => Settings;
  setSettings: (s: Partial<Settings>) => Settings;

  // workspace + files (FR-1)
  workspaceRoot: () => string;
  openFolder: () => Promise<string | null>;
  listDir: (dirPath: string) => FsEntry[];
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
  startWebsite: (brief: string, mode: JobMode) => JobSnapshot;
  startAgent: (task: string, mode?: JobMode) => JobSnapshot;
  jobNote: (text: string) => void;
  jobCancel: () => void;
  jobResume: () => Promise<void>;
  pendingApprovals: () => ApprovalRequest[];
  respondApproval: (id: string, decision: ApprovalDecision) => void;
}

export function setupIpc(main: IpcMain, api: MainApi) {
  const handle = (channel: string, fn: (...args: any[]) => any) => {
    main.handle(channel, (_e, ...args) => fn(...args));
  };

  // settings
  handle("settings:get", () => api.getSettings());
  handle("settings:set", (s: Partial<Settings>) => api.setSettings(s));

  // workspace + files
  handle("workspace:root", () => api.workspaceRoot());
  handle("workspace:openFolder", () => api.openFolder());
  handle("fs:listDir", (p: string) => api.listDir(p));
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
  handle("jobs:startWebsite", (brief: string, mode: JobMode) => api.startWebsite(brief, mode));
  handle("jobs:startAgent", (task: string, mode?: JobMode) => api.startAgent(task, mode));
  handle("jobs:note", (text: string) => api.jobNote(text));
  handle("jobs:cancel", () => api.jobCancel());
  handle("jobs:resume", () => api.jobResume());
  handle("jobs:pendingApprovals", () => api.pendingApprovals());
  handle("jobs:respondApproval", (id: string, decision: ApprovalDecision) => api.respondApproval(id, decision));

  // preview: the renderer sets the iframe src itself; these are bookkeeping.
  handle("preview:open", () => undefined);
  handle("preview:close", () => undefined);
}

// The channel the main process pushes job events on (FR-12.1).
export const JOB_EVENT_CHANNEL = "job:event";
