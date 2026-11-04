import fs from "fs";
import path from "path";
import crypto from "crypto";
import { app } from "electron";
import log from "electron-log";
import type { ChatMessage, ChatSessionMeta } from "../shared/electron-api-types";

// PART 2: Persist conversations to disk (JSON per session in userData) and
// reload them on startup, with a sessions list to switch or delete past chats.

export interface StoredChatSession extends ChatSessionMeta {
  version: 1;
  workspaceRoot?: string;
  messages: ChatMessage[];
}

interface SessionIndexFile {
  version: 1;
  activeSessionId: string;
}

function sessionsDir(): string {
  return path.join(app.getPath("userData"), "chat-sessions");
}

function indexFilePath(): string {
  return path.join(sessionsDir(), "index.json");
}

function sessionFilePath(id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(sessionsDir(), `${safeId}.json`);
}

function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

export function deriveSessionTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.text.trim());
  if (!firstUser) return "New chat";
  const line = firstUser.text.trim().split("\n")[0].trim();
  return line.length > 52 ? `${line.slice(0, 52)}…` : line;
}

function summarizeMessages(msgs: ChatMessage[]): {
  lastModel?: string;
  lastPreview?: string;
  lastStatus: ChatSessionMeta["lastStatus"];
} {
  let lastModel: string | undefined;
  let lastPreview: string | undefined;
  let hasPendingQuestion = false;
  let lastError = false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!lastModel && m.model) lastModel = m.model;
    if (!lastPreview && (m.role === "assistant" || m.role === "user" || m.role === "error") && m.text.trim()) {
      const clean = m.text.trim().replace(/\s+/g, " ");
      lastPreview = clean.length > 100 ? `${clean.slice(0, 100)}…` : clean;
    }
    if (m.userQuestion && !m.userQuestion.response) {
      hasPendingQuestion = true;
    }
  }
  const tail = msgs[msgs.length - 1];
  if (tail?.role === "error") lastError = true;
  const lastStatus: ChatSessionMeta["lastStatus"] =
    msgs.length === 0 ? "idle" : hasPendingQuestion ? "waiting" : lastError ? "failed" : "done";
  return { lastModel, lastPreview, lastStatus };
}

export class SessionStore {
  private activeId = "";
  private activeMessages: ChatMessage[] = [];
  private activeCreatedAt = Date.now();
  private activeTitle = "New chat";
  private activeWorkspaceRoot = "";

  init(workspaceRoot: string, legacyMessages?: ChatMessage[]): void {
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });

    let targetId = "";
    const idxFile = indexFilePath();
    if (fs.existsSync(idxFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(idxFile, "utf8")) as Partial<SessionIndexFile>;
        if (typeof parsed?.activeSessionId === "string") targetId = parsed.activeSessionId;
      } catch {
        /* ignore corrupt index */
      }
    }

    if (targetId) {
      const loaded = this.readSessionFile(targetId);
      if (loaded) {
        // If switching into a brand-new empty workspace in a separate run and the previous session
        // belonged to a different workspace with messages, create a clean session for this workspace
        // while keeping the previous session in the sessions list.
        if (
          workspaceRoot &&
          loaded.workspaceRoot &&
          path.resolve(loaded.workspaceRoot) !== path.resolve(workspaceRoot) &&
          loaded.messages.length > 0
        ) {
          const matching = this.findLatestForWorkspace(workspaceRoot);
          if (matching) {
            this.activateLoaded(matching);
            return;
          }
          this.createNew(workspaceRoot, legacyMessages);
          return;
        }
        this.activateLoaded(loaded);
        return;
      }
    }

    const existing = this.list();
    if (existing.length > 0) {
      const latest = this.readSessionFile(existing[0].id);
      if (
        latest &&
        (!workspaceRoot || !latest.workspaceRoot || path.resolve(latest.workspaceRoot) === path.resolve(workspaceRoot))
      ) {
        this.activateLoaded(latest);
        return;
      }
    }

    this.createNew(workspaceRoot, legacyMessages);
  }

  private findLatestForWorkspace(workspaceRoot: string): StoredChatSession | null {
    const norm = path.resolve(workspaceRoot);
    for (const meta of this.list()) {
      const full = this.readSessionFile(meta.id);
      if (full?.workspaceRoot && path.resolve(full.workspaceRoot) === norm) {
        return full;
      }
    }
    return null;
  }

  private activateLoaded(s: StoredChatSession): void {
    this.activeId = s.id;
    this.activeMessages = Array.isArray(s.messages) ? s.messages : [];
    this.activeCreatedAt = s.createdAt || Date.now();
    this.activeTitle = s.title || deriveSessionTitle(this.activeMessages);
    this.activeWorkspaceRoot = s.workspaceRoot || "";
    this.writeIndex();
  }

  activeSessionId(): string {
    return this.activeId;
  }

  messages(): ChatMessage[] {
    return this.activeMessages;
  }

  setMessages(messages: ChatMessage[], workspaceRoot?: string): void {
    this.activeMessages = messages;
    if (workspaceRoot) this.activeWorkspaceRoot = workspaceRoot;
    this.activeTitle = deriveSessionTitle(this.activeMessages);
    this.saveActive();
  }

  createNew(workspaceRoot = "", seedMessages: ChatMessage[] = []): ChatSessionMeta {
    const now = Date.now();
    this.activeId = newSessionId();
    this.activeMessages = [...seedMessages];
    this.activeCreatedAt = now;
    this.activeWorkspaceRoot = workspaceRoot;
    this.activeTitle = deriveSessionTitle(this.activeMessages);
    this.saveActive();
    this.writeIndex();
    return this.activeMeta();
  }

  switchSession(sessionId: string): { session: ChatSessionMeta; messages: ChatMessage[] } | null {
    const loaded = this.readSessionFile(sessionId);
    if (!loaded) return null;
    this.activateLoaded(loaded);
    return { session: this.activeMeta(), messages: [...this.activeMessages] };
  }

  deleteSession(sessionId: string, currentWorkspaceRoot = ""): {
    sessions: ChatSessionMeta[];
    activeSessionId: string;
    messages: ChatMessage[];
  } {
    try {
      const f = sessionFilePath(sessionId);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (e) {
      log.warn("sessions: could not delete session file", e);
    }

    if (sessionId === this.activeId) {
      const remaining = this.list();
      if (remaining.length > 0) {
        const next = this.readSessionFile(remaining[0].id);
        if (next) this.activateLoaded(next);
        else this.createNew(currentWorkspaceRoot);
      } else {
        this.createNew(currentWorkspaceRoot);
      }
    }

    return {
      sessions: this.list(),
      activeSessionId: this.activeId,
      messages: [...this.activeMessages],
    };
  }

  activeMeta(): ChatSessionMeta {
    const summary = summarizeMessages(this.activeMessages);
    return {
      id: this.activeId,
      title: this.activeTitle,
      createdAt: this.activeCreatedAt,
      updatedAt: Date.now(),
      messageCount: this.activeMessages.length,
      workspaceRoot: this.activeWorkspaceRoot || undefined,
      ...summary,
    };
  }

  list(): ChatSessionMeta[] {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return [];
    const out: ChatSessionMeta[] = [];
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
      for (const f of files) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Partial<StoredChatSession>;
          if (!parsed || typeof parsed.id !== "string") continue;
          const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
          const summary = summarizeMessages(msgs);
          out.push({
            id: parsed.id,
            title: parsed.title || deriveSessionTitle(msgs),
            createdAt: parsed.createdAt || parsed.updatedAt || 0,
            updatedAt: parsed.updatedAt || 0,
            messageCount: msgs.length,
            workspaceRoot: parsed.workspaceRoot || undefined,
            ...summary,
          });
        } catch {
          /* skip unreadable file */
        }
      }
    } catch (e) {
      log.warn("sessions: could not list sessions", e);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private readSessionFile(id: string): StoredChatSession | null {
    try {
      const f = sessionFilePath(id);
      if (!fs.existsSync(f)) return null;
      const parsed = JSON.parse(fs.readFileSync(f, "utf8")) as StoredChatSession;
      if (!parsed || typeof parsed.id !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private saveActive(): void {
    if (!this.activeId) return;
    try {
      const dir = sessionsDir();
      fs.mkdirSync(dir, { recursive: true });
      const f = sessionFilePath(this.activeId);
      const tmp = `${f}.tmp`;
      const payload: StoredChatSession = {
        version: 1,
        id: this.activeId,
        title: this.activeTitle,
        createdAt: this.activeCreatedAt,
        updatedAt: Date.now(),
        messageCount: this.activeMessages.length,
        workspaceRoot: this.activeWorkspaceRoot || undefined,
        messages: this.activeMessages,
      };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tmp, f);
    } catch (e) {
      log.warn("sessions: could not save session", e);
    }
  }

  private writeIndex(): void {
    try {
      const dir = sessionsDir();
      fs.mkdirSync(dir, { recursive: true });
      const f = indexFilePath();
      const tmp = `${f}.tmp`;
      const idx: SessionIndexFile = { version: 1, activeSessionId: this.activeId };
      fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), "utf8");
      fs.renameSync(tmp, f);
    } catch (e) {
      log.warn("sessions: could not save session index", e);
    }
  }
}

