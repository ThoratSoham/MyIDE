// Pure type declarations shared by the preload (implementation) and the
// renderer (type usage). No Electron runtime imports — safe for both contexts.

export interface Settings {
  theme: "system" | "dark" | "light";
  defaultMode: "fast" | "balanced" | "best";
  chromePath: string;
  autoResumeAtQuotaReset: boolean;
  providerOverrides: {
    geminiApiKeyLast4: string;
    openrouterApiKeyLast4: string;
    groqApiKeyLast4: string;
  };
}

export interface FsEntry {
  name: string;
  isDir: boolean;
  path: string;
}

export type ProviderKeyId = "gemini" | "openrouter" | "groq";
export type JobMode = "fast" | "balanced" | "best";
export type JobKind = "website" | "agent";
export type ApprovalDecision = "once" | "always" | "deny";

// FR-12.2: one pipeline stage with status, detail and the model that served it.
export interface StageEvent {
  stage: string;
  label: string;
  status: "start" | "done" | "skip" | "fail";
  detail?: string;
  model?: string;
}

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "doing" | "done" | "failed";
  note?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "notice";
  text: string;
  model?: string;
  ok?: boolean;
}

// FR-12.1 / FR-12.6 / FR-12.7: everything the chat + status bar needs.
export type JobEvent =
  | { type: "chat"; message: ChatMessage }
  | { type: "stage"; event: StageEvent }
  | { type: "assistant"; text: string; model?: string }
  | { type: "tool"; name: string; args: unknown; ok: boolean; output: string }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "notice"; text: string }
  | { type: "paused"; reason: string; options: string[] }
  | { type: "waiting"; lane: string; resumeAtMs: number | null }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "approval-resolved"; id: string }
  | { type: "preview"; path: string }
  | { type: "done"; summary: string }
  | { type: "error"; text: string };

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  mode: JobMode;
  running: boolean;
  brief: string;
  startedAt: number;
  finishedAt: number | null;
  stages: StageEvent[];
  messages: ChatMessage[];
  plan: PlanStep[];
  paused: { reason: string; options: string[] } | null;
  waiting: { lane: string; resumeAtMs: number | null } | null;
  result: { score?: number; ok?: boolean; files?: string[] } | null;
}

export interface ApprovalRequest {
  id: string;
  command: string;
  reason: string;
}

export interface InterruptedRun {
  brief: string;
  kind: JobKind;
  mode: JobMode;
}

// FR-2.9 / FR-12.3: one lane row in the quota panel.
export interface QuotaLaneView {
  laneId: string;
  provider: string;
  providerLabel: string;
  model: string;
  role: string;
  usedToday: number;
  limitToday: number | null;
  usedMinute: number;
  limitMinute: number | null;
  resetAt: string | null;
  status: "ok" | "limited" | "dead" | "offline";
}

export interface KeyStatus {
  provider: ProviderKeyId;
  label: string;
  last4: string;
  configured: boolean;
}

export interface KeyTestResult {
  provider: ProviderKeyId;
  label: string;
  ok: boolean;
  message: string;
}

export interface LibraryPackView {
  id: string;
  name: string;
  version: string;
  ok: boolean;
  problems: string[];
}

export interface AiStatus {
  offline: boolean;
  providerLabels: Record<string, string>;
  keys: KeyStatus[];
  packs: LibraryPackView[];
  version: string;
}

export interface ElectronApi {
  settings: {
    get: () => Promise<Settings>;
    set: (s: Partial<Settings>) => Promise<Settings>;
  };
  workspace: {
    root: () => Promise<string>;
    openFolder: () => Promise<string | null>;
  };
  preview: {
    open: (path: string) => Promise<void>;
    close: () => Promise<void>;
  };
  fs: {
    readFile: (filePath: string) => Promise<string>;
    writeFile: (filePath: string, content: string) => Promise<void>;
    listDir: (dirPath: string) => Promise<FsEntry[]>;
    deleteToTrash: (filePath: string) => Promise<void>;
    createFile: (filePath: string) => Promise<void>;
    createDir: (filePath: string) => Promise<void>;
  };
  quota: {
    get: () => Promise<QuotaLaneView[]>;
  };
  keys: {
    status: () => Promise<KeyStatus[]>;
    set: (provider: ProviderKeyId, key: string) => Promise<KeyStatus[]>;
    clear: (provider: ProviderKeyId) => Promise<KeyStatus[]>;
    test: () => Promise<KeyTestResult[]>;
  };
  ai: {
    status: () => Promise<AiStatus>;
  };
  jobs: {
    snapshot: () => Promise<JobSnapshot | null>;
    interrupted: () => Promise<InterruptedRun | null>;
    startWebsite: (brief: string, mode: JobMode) => Promise<JobSnapshot>;
    startAgent: (task: string, mode?: JobMode) => Promise<JobSnapshot>;
    note: (text: string) => Promise<void>;
    cancel: () => Promise<void>;
    resume: () => Promise<void>;
    pendingApprovals: () => Promise<ApprovalRequest[]>;
    respondApproval: (id: string, decision: ApprovalDecision) => Promise<void>;
    onEvent: (cb: (e: JobEvent) => void) => () => void;
  };
  app: {
    getVersion: () => string;
  };
}
