// Pure type declarations shared by the preload (implementation) and the
// renderer (type usage). No Electron runtime imports — safe for both contexts.

export interface Settings {
  theme: "system" | "dark" | "light";
  defaultMode: "fast" | "balanced" | "best";
  chromePath: string;
  autoResumeAtQuotaReset: boolean;
  // PART 2 point 5: ask before creating a project folder on the first Start.
  askWorkspaceEachTime: boolean;
  // PART 4: terminal font size, kept in settings so it survives restarts.
  terminalFontSize: number;
  // PART 3: timeout in seconds for ask_user popup questions (0 = no timeout).
  askQuestionTimeoutSec: number;
  // PHASE 1: allow batched `actions: [{ tool, args }, ...]` (max 8 per turn).
  batchedActions: boolean;
  // PHASE 2: parse `<file path="...">` single-shot emission + auto-verify after edits.
  singleShotFileTags?: boolean;
  autoVerifyAfterEdits?: boolean;
  // PHASE 3: fuzzy editFile cascade (whitespace/indent/line similarity).
  fuzzyEditMatch?: boolean;
  // PHASE 4: repo-map & rolling history summary.
  repoMapEnabled?: boolean;
  rollingSummaryEnabled?: boolean;
  // PHASE 5: free-tier saver mode (single-shot explain, skip plan on small edits).
  freeTierSaver?: boolean;
  // PHASE 6: local Ollama / LM Studio provider lanes.
  localModelsEnabled?: boolean;
  ollamaBaseUrl?: string;
  lmStudioBaseUrl?: string;
  // PHASE 8: optional offscreen BrowserWindow website verification.
  headlessBrowserVerify?: boolean;
  providerOverrides: {
    geminiApiKeyLast4: string;
    openrouterApiKeyLast4: string;
    groqApiKeyLast4: string;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  defaultMode: "balanced",
  chromePath: "",
  autoResumeAtQuotaReset: true,
  askWorkspaceEachTime: false,
  terminalFontSize: 13,
  askQuestionTimeoutSec: 120,
  batchedActions: true,
  singleShotFileTags: true,
  autoVerifyAfterEdits: true,
  fuzzyEditMatch: true,
  repoMapEnabled: true,
  rollingSummaryEnabled: true,
  freeTierSaver: true,
  localModelsEnabled: true,
  ollamaBaseUrl: "http://127.0.0.1:11434",
  lmStudioBaseUrl: "http://127.0.0.1:1234",
  headlessBrowserVerify: false,
  providerOverrides: {
    geminiApiKeyLast4: "",
    openrouterApiKeyLast4: "",
    groqApiKeyLast4: "",
  },
};

export interface FsEntry {
  name: string;
  isDir: boolean;
  path: string;
}

export type ProviderKeyId = "gemini" | "openrouter" | "groq";
export type CostTier = "free" | "low" | "medium" | "high";
export type JobMode = "fast" | "balanced" | "best";
export type JobKind = "website" | "agent";
export type ApprovalDecision = "once" | "always" | "deny";

export interface ModelConfigEntry {
  id: string;
  provider: ProviderKeyId;
  priority: number;
  maxTokens: number;
  costTier: CostTier;
}

export interface DroppedModelInfo {
  id: string;
  provider: ProviderKeyId;
  reason: string;
  suggestedModel?: string;
}

export interface ModelsStateView {
  filePath: string;
  models: ModelConfigEntry[];
  dropped: DroppedModelInfo[];
  deadSession: DroppedModelInfo[];
}

export interface LaneExhaustedDetail {
  laneId: string;
  provider: string;
  model: string;
  status: "dead" | "cooldown" | "quota" | "auth" | "error" | "no_key" | "skipped_size";
  reason: string;
  resumeAtMs: number | null;
  suggestedModel?: string;
}

// PART 2: the intent router's buckets. "auto" means "let the router decide".
export type Intent = "website" | "video" | "3d" | "agent" | "chat";
export type IntentChoice = "auto" | Intent;

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

// PART 3 point 3: one row of the "Files changed" card.
export interface ChangedFile {
  path: string;
  change: "created" | "edited" | "deleted";
  bytes: number;
  addedLines?: number;
  removedLines?: number;
}

export interface RunStats {
  runId: string;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  retries: number;
  retries429: number;
  retries5xx: number;
  retries413: number;
  deadLaneEvents: number;
  malformedJsonRepairs: number;
  failedEditFileAttempts: number;
  toolCallsExecuted: number;
  wallTimeMs: number;
  verificationPassed: boolean | null;
}

// PART 3: popup questions (ask_user tool).
export interface UserQuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestionRequest {
  id: string;
  question: string;
  options: UserQuestionOption[];
  allowMultiple: boolean;
  createdAt: number;
  expiresAtMs: number | null;
}

export interface UserQuestionResponse {
  id: string;
  selectedLabels: string[];
  otherText?: string;
  dismissed?: boolean;
  timedOut?: boolean;
}

export interface UserQuestionAnswerState {
  selectedLabels: string[];
  otherText?: string;
  dismissed?: boolean;
  timedOut?: boolean;
  answeredAt: number;
}

export interface UserQuestionRecord extends UserQuestionRequest {
  response?: UserQuestionAnswerState;
}

// Chat sessions persisted in userData.
export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  workspaceRoot?: string;
  lastModel?: string;
  lastPreview?: string;
  lastStatus?: "idle" | "running" | "waiting" | "done" | "failed";
  lastRunStats?: RunStats;
}

// Nova IDE Shell & Persisted Layout (<userData>/layout.json)
export type AppViewMode = "editor" | "manager";
export type ActivityId = "explorer" | "search" | "git" | "artifacts" | "rules" | "inbox";
export type BottomTabId = "terminal" | "problems" | "output" | "quota";

export interface LayoutState {
  appMode: AppViewMode;
  activeActivity: ActivityId;
  sidebarOpen: boolean;
  sidebarWidth: number;
  agentPanelOpen: boolean;
  agentPanelWidth: number;
  agentDockSide: "left" | "right";
  bottomPanelOpen: boolean;
  bottomPanelHeight: number;
  bottomTab: BottomTabId;
  openTabs: string[];
  activeTab: string | null;
  recentWorkspaces: string[];
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

// PART 1 point 4: an error bubble is never dead text — it always carries a way
// out. The renderer renders one button per action.
export interface ChatAction {
  kind: "settings" | "edit-models" | "use-model" | "retry" | "resume" | "save-files" | "answer" | "open";
  label: string;
  // For kind "answer" (a clarifying question), "open" (a file path), or "use-model" (JSON payload).
  value?: string;
  meta?: {
    provider?: ProviderKeyId;
    oldModel?: string;
    newModel?: string;
  };
}

export interface ChatMessage {
  // Stable identity. The renderer keys messages by this id and always appends
  // or updates — it must never lose an earlier message (PART 1 fix).
  id: string;
  role: "user" | "assistant" | "tool" | "notice" | "error";
  text: string;
  ts: number;
  model?: string;
  ok?: boolean;
  streaming?: boolean;
  // Collapsible status/tool metadata (PART 2).
  toolName?: string;
  toolArgs?: unknown;
  summaryLabel?: string;
  collapsible?: boolean;
  // Per-lane breakdown when all lanes are exhausted (PART 1 #4).
  laneDetails?: LaneExhaustedDetail[];
  resumeAtMs?: number | null;
  // Popup question + chosen answer kept permanently in chat history (PART 3).
  userQuestion?: UserQuestionRecord;
  // A run that changed files attaches the list here (PART 3 point 3).
  files?: ChangedFile[];
  // Per-run telemetry summary persisted in session JSON (PHASE 0).
  runStats?: RunStats;
  action?: ChatAction;
  actions?: ChatAction[];
}

export interface ApprovalRequest {
  id: string;
  command: string;
  reason: string;
}

// PART 2 point 4: the "Detected: Website v" chip.
export interface DetectedIntent {
  intent: Intent;
  label: string;
  confidence: "high" | "low";
  reason: string;
  matched: string[];
}

// PART 2 point 6: mode + how many model requests a run is likely to need.
export interface RunEstimate {
  mode: JobMode;
  requests: number;
  note: string;
}

// ---- The one event contract: chat:event -------------------------------
// Every event carries runId. Message events carry msgId so the renderer can
// append or update by id and never lose history.
export type ChatEvent = { runId: string } & (
  | { type: "status"; phase: "thinking" | "idle"; lane?: string; label?: string }
  | { type: "delta"; msgId: string; text: string; model?: string }
  | { type: "message"; msgId: string; message: ChatMessage }
  | { type: "tool"; msgId: string; name: string; args: unknown; ok: boolean; output: string; summaryLabel?: string }
  | { type: "files"; files: ChangedFile[] }
  | { type: "history"; messages: ChatMessage[]; sessionId?: string }
  | { type: "sessions"; sessions: ChatSessionMeta[]; activeSessionId: string }
  | { type: "stage"; event: StageEvent }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "approval-resolved"; id: string }
  | { type: "user-question"; msgId: string; request: UserQuestionRequest }
  | { type: "user-question-resolved"; id: string; msgId?: string; response: UserQuestionAnswerState }
  | { type: "waiting"; lane: string; resumeAtMs: number | null }
  | { type: "paused"; reason: string; options: string[] }
  | { type: "preview"; path: string }
  | { type: "open-file"; path: string }
  | { type: "workspace"; path: string; created: boolean; isDefault: boolean }
  | { type: "run-stats"; stats: RunStats }
  | { type: "done"; summary: string }
  | { type: "error"; text: string; msgId?: string }
);

// Back-compat alias: earlier code (and the smoke harness) called this JobEvent.
export type JobEvent = ChatEvent;

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  mode: JobMode;
  running: boolean;
  pausedRun: boolean;
  brief: string;
  intent: Intent;
  detected: DetectedIntent | null;
  estimate: RunEstimate;
  startedAt: number;
  finishedAt: number | null;
  stages: StageEvent[];
  messages: ChatMessage[];
  files: ChangedFile[];
  plan: PlanStep[];
  paused: { reason: string; options: string[] } | null;
  waiting: { lane: string; resumeAtMs: number | null } | null;
  result: { score?: number; ok?: boolean; files?: string[] } | null;
  runStats?: RunStats | null;
}

export interface InterruptedRun {
  brief: string;
  kind: JobKind;
  mode: JobMode;
}

// ---- Workspace (PART 2 point 5) ----
export interface WorkspaceInfo {
  path: string;
  created: boolean;
  isDefault: boolean;
}

// PART 3 point 6: pushed when files change on disk, so the explorer, the open
// tabs and the preview refresh without the user pressing anything.
export interface WorkspaceChanged {
  path: string;
  kind: "file" | "root";
}

// ---- Terminal (PART 4) ----
export interface TerminalSpawnOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  backend: "pty" | "child_process";
  // PART 4 point 7: when node-pty cannot load we fall back and say why.
  warning?: string;
}

export interface TerminalExit {
  id: string;
  exitCode: number;
  signal?: number;
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
  reason?: string;
  suggestedModel?: string;
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

export interface StartInput {
  text: string;
  mode: JobMode;
  intent: IntentChoice;
  // PART 1 DIAGNOSE: the renderer's correlation id, so hops 1..9 line up.
  traceId?: string;
}

export interface ChatHistoryFile {
  version: 1;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface ElectronApi {
  settings: {
    get: () => Promise<Settings>;
    set: (s: Partial<Settings>) => Promise<Settings>;
  };
  layout: {
    get: () => Promise<LayoutState>;
    set: (partial: Partial<LayoutState>) => Promise<LayoutState>;
  };
  models: {
    get: () => Promise<ModelsStateView>;
    save: (models: ModelConfigEntry[]) => Promise<ModelsStateView>;
    useSuggested: (provider: ProviderKeyId, oldModel: string, newModel: string) => Promise<ModelsStateView>;
    refreshLive: () => Promise<ModelsStateView>;
  };
  sessions: {
    list: () => Promise<{ sessions: ChatSessionMeta[]; activeSessionId: string }>;
    switch: (sessionId: string) => Promise<{ session: ChatSessionMeta; messages: ChatMessage[] }>;
    delete: (sessionId: string) => Promise<{ sessions: ChatSessionMeta[]; activeSessionId: string; messages: ChatMessage[] }>;
    create: () => Promise<{ session: ChatSessionMeta; sessions: ChatSessionMeta[] }>;
  };
  workspace: {
    root: () => Promise<string>;
    openFolder: () => Promise<string | null>;
    switchRoot: (dirPath: string) => Promise<string>;
    // PART 2 point 5: create <Documents>/MyIDE-Projects/<short-name-date>.
    ensure: (brief: string) => Promise<WorkspaceInfo>;
    // PART 3 point 6: subscribe to file changes. Returns an unsubscribe fn.
    onChanged: (cb: (e: WorkspaceChanged) => void) => () => void;
  };
  preview: {
    open: (path: string) => Promise<void>;
    close: () => Promise<void>;
  };
  fs: {
    readFile: (filePath: string) => Promise<string>;
    writeFile: (filePath: string, content: string) => Promise<void>;
    listDir: (dirPath: string) => Promise<FsEntry[]>;
    listFiles: (maxFiles?: number) => Promise<string[]>;
    searchFiles: (query: string, maxResults?: number) => Promise<SearchMatch[]>;
    deleteToTrash: (filePath: string) => Promise<void>;
    createFile: (filePath: string) => Promise<void>;
    createDir: (dirPath: string) => Promise<void>;
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
    // PART 2: one entry point. The router decides the pipeline from the text
    // unless the user pinned an intent in the chip. Null means "I asked a
    // question instead of starting" (unclear text or no workspace yet).
    start: (input: StartInput) => Promise<JobSnapshot | null>;
    // PART 2 point 4: answer the single clarifying question.
    answer: (value: string) => Promise<JobSnapshot | null>;
    // PART 3 point 4: "Save these N files" for a text-only model reply.
    saveSuggested: () => Promise<void>;
    newChat: () => Promise<void>;
    history: () => Promise<ChatMessage[]>;
    note: (text: string) => Promise<void>;
    cancel: () => Promise<void>;
    pause: () => Promise<void>;
    resume: () => Promise<void>;
    pendingApprovals: () => Promise<ApprovalRequest[]>;
    respondApproval: (id: string, decision: ApprovalDecision) => Promise<void>;
    pendingQuestions: () => Promise<UserQuestionRequest[]>;
    respondQuestion: (response: UserQuestionResponse) => Promise<void>;
    onEvent: (cb: (e: ChatEvent) => void) => () => void;
  };
  terminal: {
    list: () => Promise<TerminalInfo[]>;
    create: (opts?: TerminalSpawnOptions) => Promise<TerminalInfo>;
    write: (id: string, data: string) => Promise<void>;
    resize: (id: string, cols: number, rows: number) => Promise<void>;
    kill: (id: string) => Promise<void>;
    // PART 4 point 5: the read-only "Agent" tab stream, separate from the user's
    // own terminals so the AI's approved commands are always visible.
    agentOutput: () => Promise<string>;
    onData: (cb: (e: { id: string; data: string }) => void) => () => void;
    onExit: (cb: (e: TerminalExit) => void) => () => void;
    onAgentData: (cb: (e: { data: string }) => void) => () => void;
  };
  logs: {
    // PART 4 point 2: the Logs panel reads the numbered chat trace.
    lines: () => Promise<string[]>;
    onLine: (cb: (line: string) => void) => () => void;
  };
  app: {
    getVersion: () => string;
  };
}
