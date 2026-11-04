import path from "path";

// PART 4 point 6: the terminal must never inherit an API key or a secret, and
// PART 4 point 3: the default shell is chosen from the operating system.
//
// This module is deliberately free of Electron imports so it can be unit tested
// in plain Node (see test/terminal-env.test.ts).

const SECRET_SUFFIXES = ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "APIKEY"];

/** True when a variable name looks like a secret we must strip. */
export function isSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SECRET_SUFFIXES.some((s) => upper.endsWith(s))) return true;
  if (/SECRET|PASSWORD|CREDENTIAL|APIKEY|ACCESS_?TOKEN|PRIVATE_?KEY/.test(upper)) return true;
  return false;
}

/**
 * A copy of the environment with every key-like variable removed. Returns only
 * string values, because that is what node-pty and child_process accept.
 */
export function sanitizeTerminalEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (isSecretName(name)) continue;
    out[name] = value;
  }
  return out;
}

export interface ShellChoice {
  file: string;
  args: string[];
  label: string;
}

/**
 * PART 4 point 3: PowerShell on Windows (cmd fallback), $SHELL on macOS and
 * Linux (zsh or bash fallback). The list is ordered; the caller tries each in
 * turn so a missing first choice never leaves the user without a terminal.
 */
export function shellCandidates(platform: string, env: NodeJS.ProcessEnv): ShellChoice[] {
  if (platform === "win32") {
    const comspec = env.ComSpec || env.COMSPEC || "";
    const cmd: ShellChoice = {
      file: comspec && /cmd\.exe$/i.test(comspec) ? comspec : "cmd.exe",
      args: [],
      label: "cmd",
    };
    return [
      { file: "powershell.exe", args: ["-NoLogo", "-NoProfile"], label: "PowerShell" },
      { file: "pwsh.exe", args: ["-NoLogo", "-NoProfile"], label: "PowerShell 7" },
      cmd,
    ];
  }
  const candidates: ShellChoice[] = [];
  const fromEnv = env.SHELL;
  if (fromEnv) candidates.push({ file: fromEnv, args: ["-l"], label: path.basename(fromEnv) });
  candidates.push({ file: "/bin/zsh", args: ["-l"], label: "zsh" });
  candidates.push({ file: "/bin/bash", args: ["-l"], label: "bash" });
  candidates.push({ file: "/bin/sh", args: [], label: "sh" });
  return candidates;
}

/** The first candidate — used by the fallback backend which cannot probe. */
export function defaultShell(platform: string, env: NodeJS.ProcessEnv): ShellChoice {
  return shellCandidates(platform, env)[0];
}
