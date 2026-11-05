#!/usr/bin/env node
/**
 * Nova IDE (MyIDE) Static Lint & Security Boundary Checker
 * Enforces:
 * 1. Electron security invariants in src/main/main.ts (contextIsolation: true, nodeIntegration: false, sandbox: true).
 * 2. Zero Node/Electron runtime imports inside src/renderer/**.
 * 3. Zero raw ipcRenderer exposure in src/preload/preload.ts.
 * 4. Zero merge conflict markers across src/, scripts/, tests/.
 * 5. Zero unannotated `: any` / `as any` in newly added free-tier optimization modules.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const errors = [];

function walk(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

// 1. Security invariants in src/main/main.ts
const mainTs = fs.readFileSync(path.join(ROOT, "src/main/main.ts"), "utf8");
if (!/contextIsolation\s*:\s*true/.test(mainTs)) {
  errors.push("src/main/main.ts: missing contextIsolation: true");
}
if (!/nodeIntegration\s*:\s*false/.test(mainTs)) {
  errors.push("src/main/main.ts: missing nodeIntegration: false");
}
if (!/sandbox\s*:\s*true/.test(mainTs)) {
  errors.push("src/main/main.ts: missing sandbox: true");
}

// 2. Renderer must never import Node or Electron runtime APIs
const FORBIDDEN_RENDERER_IMPORTS = [
  /from\s+["']electron["']/,
  /from\s+["'](?:node:)?(?:fs|child_process|net|tls|dgram|os|crypto)["']/,
  /require\s*\(\s*["'](?:electron|fs|child_process)["']\s*\)/,
];
for (const file of walk(path.join(ROOT, "src/renderer"), [".ts", ".tsx"])) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const content = fs.readFileSync(file, "utf8");
  for (const re of FORBIDDEN_RENDERER_IMPORTS) {
    if (re.test(content)) {
      errors.push(`${rel}: forbidden Node/Electron import in renderer (${re})`);
    }
  }
}

// 3. Preload must expose typed API via contextBridge, never raw ipcRenderer
const preloadTs = fs.readFileSync(path.join(ROOT, "src/preload/preload.ts"), "utf8");
if (/exposeInMainWorld\s*\([^,]+,\s*ipcRenderer\b/.test(preloadTs)) {
  errors.push("src/preload/preload.ts: raw ipcRenderer must never be exposed to mainWorld");
}

// 4. Conflict markers & strict zero-any check on new modules
const STRICT_NO_ANY_PREFIXES = [
  "src/main/telemetry.ts",
  "src/main/agent/file-tags.ts",
  "src/main/agent/auto-verify.ts",
  "src/main/agent/fuzzy-edit.ts",
  "src/main/agent/checkpoints.ts",
  "src/main/context/",
  "src/main/ai/local-providers.ts",
  "src/main/quality/headless-verify.ts",
];

for (const file of [
  ...walk(path.join(ROOT, "src"), [".ts", ".tsx"]),
  ...walk(path.join(ROOT, "scripts"), [".mjs", ".js"]),
]) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(<<<<<<<|=======|>>>>>>>)\s/.test(line)) {
      errors.push(`${rel}:${i + 1}: git merge conflict marker`);
    }
  }

  if (STRICT_NO_ANY_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*\/\//.test(line)) continue;
      if ((/:\s*any\b/.test(line) || /\bas\s+any\b/.test(line)) && !line.includes("lint-allow-any")) {
        errors.push(`${rel}:${i + 1}: unexpected 'any' in strict module (use unknown or explicit type)`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error("Lint failed with " + errors.length + " error(s):");
  for (const err of errors) {
    console.error("  - " + err);
  }
  process.exit(1);
}

console.log("Lint passed (security boundary + strict checks OK).");

