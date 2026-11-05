import fs from "fs";
import path from "path";
import { extractSymbolsFromText, type ExtractedSymbol } from "../agent/fuzzy-edit";
import { isEnvFile } from "../agent/tools";
import { estimateInputTokens } from "../ai/tokenize";

// PHASE 4A: Compact Workspace Repo Map (~1,200 token budget).
// Extracts file symbol outlines + relative import edges across TS/TSX/JS/JSX/CSS/HTML/JSON/Python,
// caches per-file outlines keyed by mtimeMs in `.myide/cache/repo-map.json`, invalidates on
// watcher events, and ranks files by relevance to the user prompt and recently edited files.

const SUPPORTED_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".html", ".htm", ".json", ".py",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".myide", "build", "coverage", ".next", ".cache",
]);

export interface CachedRepoFileEntry {
  relPath: string;
  mtimeMs: number;
  size: number;
  lineCount: number;
  symbols: ExtractedSymbol[];
  imports: string[];
}

interface DiskRepoMapCache {
  version: 1;
  files: Record<string, CachedRepoFileEntry>;
}

export interface BuildRepoMapOptions {
  workspaceRoot: string;
  query?: string;
  changedFiles?: ReadonlySet<string> | ReadonlyArray<string>;
  openFiles?: ReadonlyArray<string>;
  maxTokens?: number;
}

const memoryCaches = new Map<string, DiskRepoMapCache>();
const dirtyRoots = new Set<string>();

export function invalidateRepoMapCache(workspaceRoot?: string, changedRelPath?: string): void {
  if (!workspaceRoot) {
    memoryCaches.clear();
    dirtyRoots.clear();
    return;
  }
  const normRoot = path.resolve(workspaceRoot);
  const cached = memoryCaches.get(normRoot);
  if (cached && changedRelPath) {
    const clean = changedRelPath.replace(/\\/g, "/");
    delete cached.files[clean];
    dirtyRoots.add(normRoot);
    return;
  }
  memoryCaches.delete(normRoot);
  dirtyRoots.add(normRoot);
}

function cacheFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".myide", "cache", "repo-map.json");
}

function loadDiskCache(workspaceRoot: string): DiskRepoMapCache {
  const normRoot = path.resolve(workspaceRoot);
  const inMem = memoryCaches.get(normRoot);
  if (inMem) return inMem;

  const file = cacheFilePath(normRoot);
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<DiskRepoMapCache>;
      if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === "object") {
        const loaded: DiskRepoMapCache = { version: 1, files: { ...parsed.files } };
        memoryCaches.set(normRoot, loaded);
        return loaded;
      }
    } catch {
      /* ignore corrupt cache */
    }
  }

  const fresh: DiskRepoMapCache = { version: 1, files: {} };
  memoryCaches.set(normRoot, fresh);
  return fresh;
}

function saveDiskCache(workspaceRoot: string, cache: DiskRepoMapCache): void {
  try {
    const file = cacheFilePath(workspaceRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache), "utf8");
    fs.renameSync(tmp, file);
    dirtyRoots.delete(path.resolve(workspaceRoot));
  } catch {
    /* non-fatal if workspace is read-only or closing */
  }
}

function loadGitignoreRegexes(root: string): RegExp[] {
  const gi = path.join(root, ".gitignore");
  if (!fs.existsSync(gi)) return [];
  try {
    const out: RegExp[] = [];
    for (const rawLine of fs.readFileSync(gi, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("!")) continue;
      const clean = line.replace(/^\/+/, "").replace(/\/+$/, "");
      if (!clean) continue;
      const esc = clean
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
      out.push(new RegExp(`(?:^|/)${esc}(?:/|$)`));
    }
    return out;
  } catch {
    return [];
  }
}

function extractRelativeImports(relPath: string, text: string): string[] {
  const baseDir = path.posix.dirname(relPath);
  const rawSpecs: string[] = [];
  const importRe = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']|require\(\s*["'](\.[^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(text)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) rawSpecs.push(spec);
  }
  const resolved: string[] = [];
  for (const spec of rawSpecs) {
    const joined = path.posix.normalize(path.posix.join(baseDir === "." ? "" : baseDir, spec));
    resolved.push(joined);
  }
  return resolved;
}

function extractJsonSymbols(text: string): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, 80); i++) {
    const m = /^\s{1,4}"([^"]+)"\s*:/.exec(lines[i]);
    if (m) {
      out.push({ kind: "const", name: m[1], line: i + 1, exported: true });
    }
  }
  return out.slice(0, 12);
}

function scanWorkspaceEntries(workspaceRoot: string, maxFiles = 600): CachedRepoFileEntry[] {
  if (!fs.existsSync(workspaceRoot)) return [];
  const cache = loadDiskCache(workspaceRoot);
  const ignoreRes = loadGitignoreRegexes(workspaceRoot);
  const seen = new Set<string>();
  const entries: CachedRepoFileEntry[] = [];
  let cacheMutated = dirtyRoots.has(path.resolve(workspaceRoot));

  const visit = (dirAbs: string) => {
    if (entries.length >= maxFiles) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      if (entries.length >= maxFiles) break;
      if (SKIP_DIRS.has(d.name)) continue;
      const abs = path.join(dirAbs, d.name);
      if (isEnvFile(abs)) continue;
      const rel = path.relative(workspaceRoot, abs).replace(/\\/g, "/");
      if (ignoreRes.some((re) => re.test(rel))) continue;

      if (d.isDirectory()) {
        visit(abs);
      } else if (d.isFile()) {
        const ext = path.extname(d.name).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext)) continue;
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.size > 350_000) continue;

        seen.add(rel);
        const existing = cache.files[rel];
        if (existing && Math.abs(existing.mtimeMs - st.mtimeMs) < 1 && existing.size === st.size) {
          entries.push(existing);
          continue;
        }

        let text: string;
        try {
          text = fs.readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        const lineCount = text.split(/\r?\n/).length;
        const symbols = ext === ".json" ? extractJsonSymbols(text) : extractSymbolsFromText(rel, text);
        const imports = extractRelativeImports(rel, text);
        const entry: CachedRepoFileEntry = {
          relPath: rel,
          mtimeMs: st.mtimeMs,
          size: st.size,
          lineCount,
          symbols: symbols.slice(0, 40),
          imports,
        };
        cache.files[rel] = entry;
        entries.push(entry);
        cacheMutated = true;
      }
    }
  };

  visit(workspaceRoot);

  // Prune deleted files from cache
  for (const key of Object.keys(cache.files)) {
    if (!seen.has(key)) {
      delete cache.files[key];
      cacheMutated = true;
    }
  }

  if (cacheMutated) {
    saveDiskCache(workspaceRoot, cache);
  }

  return entries;
}

function tokenizeQueryTerms(query: string): string[] {
  const out = new Set<string>();
  const rawTokens = query.match(/[A-Za-z0-9_./-]+/g) ?? [];
  for (const tok of rawTokens) {
    const lower = tok.toLowerCase();
    if (lower.length >= 2) out.add(lower);
    // Split camelCase and snake_case
    const subParts = tok
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length >= 3);
    for (const p of subParts) out.add(p);
  }
  return [...out];
}

function stripExt(relPath: string): string {
  return relPath.replace(/\.[a-z0-9]+$/i, "");
}

/**
 * Builds a ranked `[Workspace Repo Map]` string capped at `maxTokens` (default ~1,200).
 * Returns `""` when the workspace has no source files yet.
 */
export function buildRepoMap(opts: BuildRepoMapOptions): string {
  const entries = scanWorkspaceEntries(opts.workspaceRoot);
  if (entries.length === 0) return "";

  const maxTokens = Math.max(250, opts.maxTokens ?? 1_200);
  const query = opts.query ?? "";
  const queryLower = query.toLowerCase();
  const terms = tokenizeQueryTerms(query);

  const changedSet = new Set<string>(
    opts.changedFiles ? [...opts.changedFiles].map((p) => p.replace(/\\/g, "/")) : [],
  );
  const openSet = new Set<string>(
    opts.openFiles ? opts.openFiles.map((p) => p.replace(/\\/g, "/")) : [],
  );

  // Identify primary anchor files (explicitly mentioned, recently edited, or open)
  const anchorStripped = new Set<string>();
  for (const e of entries) {
    const base = path.posix.basename(e.relPath).toLowerCase();
    if (
      changedSet.has(e.relPath) ||
      openSet.has(e.relPath) ||
      (base.length >= 4 && queryLower.includes(base)) ||
      queryLower.includes(e.relPath.toLowerCase())
    ) {
      anchorStripped.add(stripExt(e.relPath));
    }
  }

  // Score every file by relevance
  const scored = entries.map((entry) => {
    let score = 0;
    const relLower = entry.relPath.toLowerCase();
    const baseLower = path.posix.basename(relLower);
    const stripped = stripExt(entry.relPath);

    if (queryLower.includes(relLower)) score += 60;
    else if (baseLower.length >= 4 && queryLower.includes(baseLower)) score += 40;

    if (changedSet.has(entry.relPath)) score += 35;
    if (openSet.has(entry.relPath)) score += 25;

    // 1-hop import graph boost around anchor files
    if (entry.imports.some((imp) => anchorStripped.has(imp))) score += 18;
    for (const anchor of anchorStripped) {
      const anchorEntry = entries.find((x) => stripExt(x.relPath) === anchor);
      if (anchorEntry?.imports.includes(stripped)) {
        score += 18;
        break;
      }
    }

    // Keyword overlap on path & symbol names
    const symLower = entry.symbols.map((s) => s.name.toLowerCase());
    for (const term of terms) {
      if (relLower.includes(term)) score += 8;
      if (symLower.some((s) => s === term)) score += 16;
      else if (symLower.some((s) => s.includes(term))) score += 7;
    }

    if (entry.relPath.startsWith("src/")) score += 3;
    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score || a.entry.relPath.localeCompare(b.entry.relPath));

  const lines: string[] = ["[Workspace Repo Map]"];
  let usedTokens = estimateInputTokens(lines[0]);

  for (const { entry } of scored) {
    const exportedFirst = [...entry.symbols].sort((a, b) => Number(b.exported) - Number(a.exported) || a.line - b.line);
    const symSummary = exportedFirst
      .slice(0, 10)
      .map((s) => `${s.name}(L${s.line})`)
      .join(", ");
    const extraCount = Math.max(0, entry.symbols.length - 10);
    const suffix = extraCount > 0 ? `, +${extraCount} more` : "";
    const line = symSummary
      ? `- ${entry.relPath} (${entry.lineCount}L): ${symSummary}${suffix}`
      : `- ${entry.relPath} (${entry.lineCount}L)`;
    const lineTokens = estimateInputTokens(line) + 1;
    if (usedTokens + lineTokens > maxTokens) {
      lines.push(`- ... (${scored.length - (lines.length - 1)} additional files omitted for token budget)`);
      break;
    }
    lines.push(line);
    usedTokens += lineTokens;
  }

  return lines.join("\n");
}
