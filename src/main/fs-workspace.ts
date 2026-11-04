import fs from "fs";
import path from "path";
import os from "os";
import { app } from "electron";
import log from "electron-log";
import type { SearchMatch } from "../shared/electron-api-types";

// M1: workspace rooted at a temp folder with a small seeded sample project so
// the file tree, editor tabs, and private preview are coherent on first launch.
// Real open-folder dialog + user workspace comes next.

export interface FsEntry {
  name: string;
  isDir: boolean;
  path: string;
}

let workspaceRoot: string | null = null;

function defaultRoot(): string {
  return app.isPackaged
    ? path.join(app.getPath("userData"), "workspace")
    : path.join(os.tmpdir(), "myide-workspace");
}

function rootFile(): string {
  return path.join(app.getPath("userData"), "workspace-root.json");
}

// FR-1.1: restore the last opened folder at start-up.
function rememberedRoot(): string | null {
  try {
    const f = rootFile();
    if (!fs.existsSync(f)) return null;
    const parsed = JSON.parse(fs.readFileSync(f, "utf8")) as { root?: string };
    if (parsed.root && fs.existsSync(parsed.root)) return parsed.root;
  } catch {
    /* fall through to the default */
  }
  return null;
}

function rememberRoot(dir: string): void {
  try {
    fs.mkdirSync(path.dirname(rootFile()), { recursive: true });
    fs.writeFileSync(rootFile(), JSON.stringify({ root: dir }), "utf8");
  } catch (e) {
    log.warn("workspace: could not remember the folder", e);
  }
}

export function workspaceRootPath(): string {
  if (!workspaceRoot) {
    const remembered = rememberedRoot();
    if (remembered) {
      workspaceRoot = remembered;
    } else {
      const base = defaultRoot();
      fs.mkdirSync(base, { recursive: true });
      workspaceRoot = base;
      seedIfEmpty(base);
      rememberRoot(base);
    }
  }
  return workspaceRoot;
}

// FR-1.1: switch the workspace to a folder the user picked. The preview protocol
// and the job manager read the path through workspaceRootPath(), so changing it
// here moves everything at once.
export function setWorkspaceRoot(dir: string): string {
  const abs = path.resolve(dir);
  fs.mkdirSync(abs, { recursive: true });
  workspaceRoot = abs;
  rememberRoot(abs);
  log.info(`workspace root set to ${abs}`);
  return abs;
}

export interface WorkspaceInfo {
  path: string;
  created: boolean;
  isDefault: boolean;
}

/** True while we are still on the throw-away start-up folder. */
export function isUsingDefaultRoot(): boolean {
  return path.resolve(workspaceRootPath()) === path.resolve(defaultRoot());
}

/**
 * PART 2 point 5: when no project folder is open, create
 * <Documents>/MyIDE-Projects/<short-name-date>, switch to it and report where it
 * is. When the user already picked a folder we never move them.
 */
export function ensureProjectWorkspace(brief: string): WorkspaceInfo {
  const current = workspaceRootPath();
  if (!isUsingDefaultRoot()) return { path: current, created: false, isDefault: false };

  const dir = path.join(app.getPath("documents"), "MyIDE-Projects", projectFolderName(brief));
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  setWorkspaceRoot(dir);
  log.info(`project workspace ${existed ? "reused" : "created"}: ${dir}`);
  return { path: dir, created: !existed, isDefault: false };
}

/** "make me a coffee shop website" -> "make-me-a-coffee-shop-20261103-1412" */
export function projectFolderName(brief: string): string {
  const slug = (brief || "project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 5)
    .join("-")
    .slice(0, 40) || "project";
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${slug}-${stamp}`;
}

function seedIfEmpty(dir: string) {
  const marker = path.join(dir, ".myide-seeded");
  if (fs.existsSync(marker)) return;

  const files: Array<{ rel: string; content: string }> = [
    {
      rel: "README.md",
      content: `# MyIDE

Free AI IDE for Windows, Mac and Linux.

Open a folder to begin. The workspace below is a small seeded sample so the
file tree, editor, and private preview are usable immediately.
`,
    },
    {
      rel: "index.html",
      content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MyIDE sample</title>
  <style>
    :root {
      --bg: #0e1014;
      --fg: #e6e8ec;
      --muted: #9aa0ad;
      --accent: #60a5fa;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 48px 24px; }
    header { display: flex; align-items: center; gap: 12px; }
    .logo { font-size: 14px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--accent); }
    h1 { font-size: clamp(32px, 5vw, 56px); line-height: 1.1; margin: 24px 0 16px; font-weight: 700; }
    p.lead { font-size: 20px; line-height: 1.5; color: var(--muted); max-width: 60ch; }
    footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #2b3142; color: var(--muted); font-size: 14px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <span class="logo">MyIDE</span>
    </header>
    <h1>Free models, premium results.</h1>
    <p class="lead">MyIDE turns free AI keys into premium output by splitting every job into small steps, using a hand-built design library, and verifying every result with code before it says done.</p>
    <footer>
      Generated with MyIDE · workspace sample
    </footer>
  </div>
</body>
</html>`,
    },
    {
      rel: "style.css",
      content: `/* Palette token sheet — a tiny sample of the web-core library idea.
   Real packs live in resources/skills and carry their own skill.json. */
:root {
  --bg: #0e1014;
  --surface: #161a22;
  --fg: #e6e8ec;
  --muted: #9aa0ad;
  --accent: #60a5fa;
  --radius: 10px;
}
`,
    },
    {
      rel: "app.js",
      content: `// Tiny behavior sample.
console.log("myide-sample: app ready");
`,
    },
  ];

  for (const { rel, content } of files) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
  }
  fs.writeFileSync(marker, "1", "utf8");
  log.info("myide workspace seeded");
}

export function listDir(dirPath: string): FsEntry[] {
  const root = workspaceRootPath();
  const target = dirPath ? path.join(root, dirPath) : root;

  if (!fs.existsSync(target)) {
    throw new Error(`no such directory: ${dirPath}`);
  }
  if (!fs.statSync(target).isDirectory()) {
    throw new Error(`not a directory: ${dirPath}`);
  }

  const entries = fs
    .readdirSync(target, { withFileTypes: true })
    .map((d) => {
      const name = d.name;
      const rel = dirPath ? `${dirPath}/${name}` : name;
      return {
        name,
        isDir: d.isDirectory(),
        path: rel,
      };
    });
  return entries;
}

export function readFile(filePath: string): string {
  const root = workspaceRootPath();
  const fp = path.join(root, filePath);

  // FR-5.3: all paths stay inside the workspace. Block escapes.
  if (!fp.startsWith(root + path.sep) && fp !== root) {
    throw new Error("access denied: path outside workspace");
  }
  if (!fs.existsSync(fp)) {
    throw new Error(`no such file: ${filePath}`);
  }
  // FR-5.3: .env files cannot be read.
  if (isEnvPath(filePath)) {
    throw new Error("access denied: .env files are not readable");
  }
  return fs.readFileSync(fp, "utf8");
}

export function writeFile(filePath: string, content: string): void {
  const root = workspaceRootPath();
  const fp = path.join(root, filePath);

  if (!fp.startsWith(root + path.sep) && fp !== root) {
    throw new Error("access denied: path outside workspace");
  }
  // FR-13.3: overwritten files are copied to .myide/backups before overwrite.
  const dir = path.dirname(fp);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const backupRoot = path.join(root, ".myide", "backups");
    fs.mkdirSync(backupRoot, { recursive: true });
    const stamp = Date.now();
    const backupPath = path.join(backupRoot, `${filePath.replace(/\//g, "_")}.${stamp}.bak`);
    fs.copyFileSync(fp, backupPath);
    log.info(`backup before overwrite: ${backupPath}`);
  }

  fs.writeFileSync(fp, content, "utf8");
}

// FR-1.2: new file / new folder from the explorer.
export function createFile(filePath: string): void {
  const root = workspaceRootPath();
  const fp = path.join(root, filePath);
  if (!fp.startsWith(root + path.sep) && fp !== root) {
    throw new Error("access denied: path outside workspace");
  }
  if (isEnvPath(filePath)) {
    throw new Error("access denied: .env files are not allowed");
  }
  if (fs.existsSync(fp)) throw new Error(`already exists: ${filePath}`);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, "", "utf8");
}

export function createDir(dirPath: string): void {
  const root = workspaceRootPath();
  const fp = path.join(root, dirPath);
  if (!fp.startsWith(root + path.sep) && fp !== root) {
    throw new Error("access denied: path outside workspace");
  }
  if (fs.existsSync(fp)) throw new Error(`already exists: ${dirPath}`);
  fs.mkdirSync(fp, { recursive: true });
}

export function deleteToTrash(filePath: string): void {
  const root = workspaceRootPath();
  const fp = path.join(root, filePath);

  if (!fp.startsWith(root + path.sep) && fp !== root) {
    throw new Error("access denied: path outside workspace");
  }
  if (!fs.existsSync(fp)) {
    throw new Error(`no such file: ${filePath}`);
  }

  // FR-13.3: deleted files go to .myide/trash.
  const trashRoot = path.join(root, ".myide", "trash");
  fs.mkdirSync(trashRoot, { recursive: true });
  const dest = path.join(trashRoot, `${Date.now()}_${filePath.replace(/\//g, "_")}`);
  if (fs.statSync(fp).isDirectory()) {
    fs.cpSync(fp, dest, { recursive: true });
    fs.rmSync(fp, { recursive: true, force: true });
  } else {
    fs.copyFileSync(fp, dest);
    fs.unlinkSync(fp);
  }
  log.info(`moved to trash: ${dest}`);
}

function isEnvPath(filePath: string): boolean {
  const name = path.basename(filePath);
  return name === ".env" || name.startsWith(".env.");
}

export function resolveWorkspaceFilePath(workspacePath: string): string {
  const root = workspaceRootPath();
  return path.join(root, workspacePath);
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".myide",
  ".novaide",
  ".cache",
  "coverage",
]);

const BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".exe",
  ".dll",
  ".node",
  ".woff",
  ".woff2",
  ".ttf",
  ".mp4",
  ".webm",
]);

/** Fast recursive workspace file list for Quick Open (Ctrl+P) & @-mentions. */
export function listWorkspaceFiles(maxFiles = 2500): string[] {
  const root = workspaceRootPath();
  const out: string[] = [];
  const cap = Math.min(Math.max(50, maxFiles || 2500), 10000);

  const walk = (absDir: string, relPrefix: string) => {
    if (out.length >= cap) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (out.length >= cap) return;
      if (d.isSymbolicLink()) continue;
      const rel = relPrefix ? `${relPrefix}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (IGNORED_DIRS.has(d.name)) continue;
        walk(path.join(absDir, d.name), rel);
      } else if (d.isFile()) {
        if (isEnvPath(d.name)) continue;
        out.push(rel);
      }
    }
  };

  walk(root, "");
  return out;
}

/** Fast workspace text search for the Search sidebar tab. */
export function searchWorkspaceFiles(query: string, maxResults = 150): SearchMatch[] {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const lowerQ = q.toLowerCase();
  const root = workspaceRootPath();
  const files = listWorkspaceFiles(2000);
  const matches: SearchMatch[] = [];
  const cap = Math.min(Math.max(10, maxResults || 150), 500);

  for (const rel of files) {
    if (matches.length >= cap) break;
    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXTS.has(ext)) continue;
    const abs = path.join(root, rel);
    try {
      const stat = fs.statSync(abs);
      if (stat.size > 512_000) continue; // skip >512 KB files
      const text = fs.readFileSync(abs, "utf8");
      if (!text.toLowerCase().includes(lowerQ)) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const idx = lines[i].toLowerCase().indexOf(lowerQ);
        if (idx !== -1) {
          matches.push({
            path: rel,
            line: i + 1,
            column: idx + 1,
            preview: lines[i].trim().slice(0, 180),
          });
          if (matches.length >= cap) break;
        }
      }
    } catch {
      /* ignore unreadable files */
    }
  }
  return matches;
}
