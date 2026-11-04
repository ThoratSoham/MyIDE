import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import log from "electron-log";
import { hop } from "../trace";
import { sanitizeTerminalEnv, shellCandidates, type ShellChoice } from "./env";
import type { TerminalExit, TerminalInfo, TerminalSpawnOptions } from "../../shared/electron-api-types";

// PART 4: a real integrated terminal. The main process owns the pseudo terminal
// (node-pty when it loads, a line-based child_process fallback when it does
// not). The renderer only ever sends typed data over the IPC bridge — it can
// never reach Node or the main process.

const MAX_TERMINALS = 8;
const MAX_AGENT_BUFFER = 200_000;

// node-pty is loaded lazily so the app still starts when the native module is
// missing or fails to build. We must not let a native addon break start-up.
function tryRequire(name: string): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const req = eval("require") as (m: string) => unknown;
    return req(name);
  } catch (e) {
    log.warn(`terminal: could not load ${name}: ${(e as Error).message}`);
    return null;
  }
}

export interface TerminalManagerDeps {
  workspaceRoot: () => string;
  emitData: (id: string, data: string) => void;
  emitExit: (e: TerminalExit) => void;
  emitAgentData: (chunk: string) => void;
}

interface Session {
  info: TerminalInfo;
  pty: any | null;
  child: ChildProcessWithoutNullStreams | null;
  shell: ShellChoice;
  line: string;
  closed: boolean;
}

export class TerminalManager {
  private sessions = new Map<string, Session>();
  private order: string[] = [];
  private counter = 0;
  private agentBuffer = "";
  private ptyModule: any | null | undefined;

  constructor(private deps: TerminalManagerDeps) {}

  /** PART 4 point 7: report the backend so the UI can explain a fallback. */
  private loadPty(): any | null {
    if (this.ptyModule !== undefined) return this.ptyModule;
    // Prefer the plain name, then the prebuilt multi-arch package (PART 4 point
    // 1) so Windows users do not need build tools.
    const mod = tryRequire("node-pty") ?? tryRequire("@homebridge/node-pty-prebuilt-multiarch");
    this.ptyModule = mod && typeof mod.spawn === "function" ? mod : null;
    if (!this.ptyModule) log.warn("terminal: node-pty unavailable, using the child_process fallback");
    return this.ptyModule;
  }

  list(): TerminalInfo[] {
    return this.order.map((id) => this.sessions.get(id)!.info);
  }

  create(opts: TerminalSpawnOptions = {}): TerminalInfo {
    if (this.sessions.size >= MAX_TERMINALS) {
      throw new Error(`At most ${MAX_TERMINALS} terminals can be open. Close one first.`);
    }
    const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : this.deps.workspaceRoot();
    const cols = clampInt(opts.cols, 20, 400, 80);
    const rows = clampInt(opts.rows, 5, 200, 24);
    const id = `t${++this.counter}`;

    const candidates = opts.shell
      ? [{ file: opts.shell, args: [], label: opts.shell } as ShellChoice]
      : shellCandidates(process.platform, process.env);
    const pty = this.loadPty();
    const shell = candidates[0];

    let session = pty ? this.startPty(pty, id, shell, cwd, cols, rows) : null;
    if (!session) session = this.startChild(id, shell, cwd);
    if (!session) throw new Error("Could not start a terminal: no shell could be launched.");

    this.sessions.set(id, session);
    this.order.push(id);
    hop("term", id, 1, `terminal started (${session.info.backend}) cwd=${cwd} shell=${shell.label}`);
    return session.info;
  }

  private startPty(pty: any, id: string, shell: ShellChoice, cwd: string, cols: number, rows: number): Session | null {
    try {
      const proc = pty.spawn(shell.file, shell.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: this.terminalEnv(),
      });
      const info: TerminalInfo = {
        id,
        title: `${shell.label} ${id}`,
        cwd,
        shell: shell.file,
        backend: "pty",
      };
      const session: Session = { info, pty: proc, child: null, shell, line: "", closed: false };
      proc.onData((data: string) => this.deps.emitData(id, data));
      proc.onExit((e: { exitCode: number; signal?: number }) => this.finish(id, e.exitCode, e.signal));
      return session;
    } catch (e) {
      const message = (e as Error).message;
      log.warn(`terminal: node-pty spawn failed, falling back: ${message}`);
      const fallback = this.startChild(id, shell, cwd);
      if (fallback) fallback.info.warning = `node-pty could not start (${message}); using the simple terminal.`;
      return fallback;
    }
  }

  private startChild(id: string, shell: ShellChoice, cwd: string): Session | null {
    for (const candidate of shellCandidates(process.platform, process.env)) {
      try {
        const child = spawn(candidate.file, candidate.args, {
          cwd,
          env: this.terminalEnv(),
          windowsHide: true,
        }) as ChildProcessWithoutNullStreams;
        const info: TerminalInfo = {
          id,
          title: `${candidate.label} ${id} (simple)`,
          cwd,
          shell: candidate.file,
          backend: "child_process",
          warning: "node-pty is not available, so this is a simple line-by-line terminal. Colors and full-screen programs are not supported.",
        };
        const session: Session = { info, pty: null, child, shell: candidate, line: "", closed: false };
        child.stdout.on("data", (d: Buffer) => this.deps.emitData(id, d.toString()));
        child.stderr.on("data", (d: Buffer) => this.deps.emitData(id, d.toString()));
        child.on("error", (e) => {
          this.deps.emitData(id, `\r\n[could not start ${candidate.file}: ${e.message}]\r\n`);
          this.finish(id, -1);
        });
        child.on("close", (code) => this.finish(id, code ?? 0));
        return session;
      } catch {
        /* try the next shell */
      }
    }
    return null;
  }

  // PART 4 point 6: no secret ever reaches the terminal environment.
  private terminalEnv(): Record<string, string> {
    const env = sanitizeTerminalEnv(process.env);
    env.TERM = "xterm-256color";
    env.MYIDE_TERM = "1";
    env.COLORTERM = "truecolor";
    return env;
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s || s.closed) return;
    if (s.pty) {
      s.pty.write(data);
      return;
    }
    // Simple terminal: echo what was typed, then run a whole line at a time.
    if (data === "\r" || data === "\n") {
      this.deps.emitData(id, "\r\n");
      const line = s.line.trim();
      s.line = "";
      if (line) this.runLine(s, line);
      return;
    }
    if (data === "\u0003") {
      // Ctrl+C: drop the pending line.
      s.line = "";
      this.deps.emitData(id, "^C\r\n");
      return;
    }
    if (data === "\u007f" || data === "\b") {
      if (s.line.length) {
        s.line = s.line.slice(0, -1);
        this.deps.emitData(id, "\b \b");
      }
      return;
    }
    s.line += data;
    this.deps.emitData(id, data);
  }

  private runLine(session: Session, line: string): void {
    const child = spawn(session.shell.file, [...session.shell.args, line], {
      cwd: session.info.cwd,
      env: this.terminalEnv(),
      windowsHide: true,
    });
    child.stdout?.on("data", (d: Buffer) => this.deps.emitData(session.info.id, d.toString()));
    child.stderr?.on("data", (d: Buffer) => this.deps.emitData(session.info.id, d.toString()));
    child.on("error", (e) => this.deps.emitData(session.info.id, `[error: ${e.message}]\r\n`));
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s?.pty) return;
    try {
      s.pty.resize(clampInt(cols, 20, 400, 80), clampInt(rows, 5, 200, 24));
    } catch (e) {
      log.warn(`terminal: resize failed for ${id}`, e);
    }
  }

  kill(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      if (s.pty) s.pty.kill();
      else s.child?.kill();
    } catch (e) {
      log.warn(`terminal: kill failed for ${id}`, e);
    }
    this.finish(id, 0);
  }

  private finish(id: string, exitCode: number, signal?: number): void {
    const s = this.sessions.get(id);
    if (!s || s.closed) return;
    s.closed = true;
    this.sessions.delete(id);
    this.order = this.order.filter((x) => x !== id);
    hop("term", id, 2, `terminal exited code=${exitCode}`);
    this.deps.emitExit({ id, exitCode, signal });
  }

  // PART 4 point 5: the AI's approved commands are mirrored to a read-only tab.
  agentWrite(chunk: string): void {
    this.agentBuffer += chunk;
    if (this.agentBuffer.length > MAX_AGENT_BUFFER) {
      this.agentBuffer = this.agentBuffer.slice(this.agentBuffer.length - MAX_AGENT_BUFFER);
    }
    this.deps.emitAgentData(chunk);
  }

  agentOutput(): string {
    return this.agentBuffer;
  }

  /** PART 4 point 4: kill every terminal when the app closes. */
  disposeAll(): void {
    for (const id of [...this.order]) this.kill(id);
    this.sessions.clear();
    this.order = [];
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
