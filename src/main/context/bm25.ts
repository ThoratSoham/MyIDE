import fs from "fs";
import path from "path";
import { extractSymbolsFromText, formatNumberedLines } from "../agent/fuzzy-edit";
import { insideWorkspace, isEnvFile } from "../agent/tools";
import { estimateInputTokens } from "../ai/tokenize";

// PHASE 4B: Local BM25 Retriever + @mention Resolver (zero model calls, zero native addons).
// Implements a clean `CodeRetriever` interface over semantic function/class/block chunks
// so embeddings can be plugged in later without changing callers.

export interface RetrievedChunk {
  relPath: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  score: number;
  reason: "mention" | "path" | "identifier" | "bm25";
  content: string;
}

export interface RetrieveOptions {
  maxChunks?: number;
  maxTokens?: number;
  minScore?: number;
}

export interface CodeRetriever {
  retrieve(query: string, opts?: RetrieveOptions): RetrievedChunk[];
}

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".html", ".htm", ".json", ".py", ".md",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".myide", "build", "coverage", ".next", ".cache",
]);

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "across", "all",
  "files", "file", "code", "add", "fix", "create", "build", "make", "update",
  "run", "test", "where", "how", "what", "why", "when", "explain", "debug",
  "trace", "its", "order", "error", "export", "exported", "const", "constant",
  "function", "class", "type", "interface", "return", "string", "number", "then",
]);

interface IndexedChunk {
  relPath: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  rawLines: string[];
  termFreq: Map<string, number>;
  length: number;
  rawText: string;
}

export function tokenizeCodeTerms(text: string): string[] {
  const tokens: string[] = [];
  const rawMatches = text.match(/[A-Za-z_$][A-Za-z0-9_$]*|[0-9]+/g) ?? [];
  for (const raw of rawMatches) {
    const lower = raw.toLowerCase();
    if (lower.length >= 2 && !STOP_WORDS.has(lower)) {
      tokens.push(lower);
    }
    // Also index camelCase / PascalCase / SCREAMING_SNAKE sub-parts
    if (/[A-Z_]/.test(raw)) {
      const parts = raw
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^A-Za-z0-9]+/)
        .map((p) => p.toLowerCase())
        .filter((p) => p.length >= 2 && !STOP_WORDS.has(p));
      if (parts.length > 1) {
        for (const p of parts) tokens.push(p);
      }
    }
  }
  return tokens;
}

function extractDistinctIdentifiers(query: string): string[] {
  const out = new Set<string>();
  const matches = query.match(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g) ?? [];
  for (const tok of matches) {
    // CamelCase, PascalCase, snake_case, or SCREAMING_SNAKE identifiers carry high code signal
    if (/[A-Z]/.test(tok.slice(1)) || tok.includes("_") || /^[A-Z][A-Z0-9_]+$/.test(tok)) {
      out.add(tok);
    }
  }
  return [...out];
}

export function extractMentions(query: string): { fileMentions: string[]; symbolMentions: string[] } {
  const fileMentions = new Set<string>();
  const symbolMentions = new Set<string>();

  // Explicit @path/to/file.ext or @symbolName
  const atRe = /(?:^|\s)@([A-Za-z0-9_./\\-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = atRe.exec(query)) !== null) {
    const ref = m[1].replace(/\\/g, "/").replace(/[.,;:!?)]+$/, "");
    if (!ref) continue;
    if (ref.includes("/") || /\.[a-z0-9]{1,5}$/i.test(ref)) {
      fileMentions.add(ref);
    } else {
      symbolMentions.add(ref);
    }
  }

  // Plain relative file references in prompt (e.g. `src/format.ts` or `index.html`)
  const pathRe = /(?:^|[\s"'`(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,5}|[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|css|html|py|json))\b/g;
  while ((m = pathRe.exec(query)) !== null) {
    fileMentions.add(m[1].replace(/\\/g, "/"));
  }

  return {
    fileMentions: [...fileMentions],
    symbolMentions: [...symbolMentions],
  };
}

function chunkFileLines(relPath: string, text: string, maxChunkLines = 45): IndexedChunk[] {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];
  const symbols = extractSymbolsFromText(relPath, text);
  const boundaries: Array<{ line: number; symbolName?: string }> = [];

  if (symbols.length > 0) {
    if (symbols[0].line > 1) {
      boundaries.push({ line: 1, symbolName: "imports/header" });
    }
    for (const s of symbols) {
      boundaries.push({ line: s.line, symbolName: s.name });
    }
  } else {
    for (let start = 1; start <= lines.length; start += maxChunkLines) {
      boundaries.push({ line: start });
    }
  }

  const chunks: IndexedChunk[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const startLine = boundaries[i].line;
    const rawNext = i + 1 < boundaries.length ? boundaries[i + 1].line - 1 : lines.length;
    for (let subStart = startLine; subStart <= rawNext; subStart += maxChunkLines) {
      const subEnd = Math.min(rawNext, subStart + maxChunkLines - 1);
      const slice = lines.slice(subStart - 1, subEnd);
      const rawText = slice.join("\n");
      if (!rawText.trim()) continue;
      const terms = tokenizeCodeTerms(`${relPath} ${boundaries[i].symbolName ?? ""} ${rawText}`);
      const tf = new Map<string, number>();
      for (const t of terms) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }
      chunks.push({
        relPath,
        startLine: subStart,
        endLine: subEnd,
        symbolName: subStart === startLine ? boundaries[i].symbolName : undefined,
        rawLines: slice,
        termFreq: tf,
        length: Math.max(1, terms.length),
        rawText,
      });
    }
  }
  return chunks;
}

function walkIndexableFiles(workspaceRoot: string, maxFiles = 500): string[] {
  if (!fs.existsSync(workspaceRoot)) return [];
  const results: string[] = [];

  const visit = (dirAbs: string) => {
    if (results.length >= maxFiles) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      if (results.length >= maxFiles) break;
      if (SKIP_DIRS.has(d.name)) continue;
      const abs = path.join(dirAbs, d.name);
      if (isEnvFile(abs)) continue;
      if (d.isDirectory()) {
        visit(abs);
      } else if (d.isFile()) {
        const ext = path.extname(d.name).toLowerCase();
        if (CODE_EXTS.has(ext)) {
          results.push(path.relative(workspaceRoot, abs).replace(/\\/g, "/"));
        }
      }
    }
  };

  visit(workspaceRoot);
  return results;
}

export class WorkspaceBM25Retriever implements CodeRetriever {
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  constructor(private readonly workspaceRoot: string) {}

  retrieve(query: string, opts: RetrieveOptions = {}): RetrievedChunk[] {
    if (!query.trim() || !fs.existsSync(this.workspaceRoot)) return [];

    const maxChunks = opts.maxChunks ?? 8;
    const maxTokens = opts.maxTokens ?? 1_500;
    const minScore = opts.minScore ?? 2.4;

    const files = walkIndexableFiles(this.workspaceRoot);
    if (files.length === 0) return [];

    const allChunks: IndexedChunk[] = [];
    for (const rel of files) {
      let abs: string;
      try {
        abs = insideWorkspace(this.workspaceRoot, rel);
      } catch {
        continue;
      }
      if (isEnvFile(abs)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
        if (st.size > 300_000) continue;
        const text = fs.readFileSync(abs, "utf8");
        allChunks.push(...chunkFileLines(rel, text));
      } catch {
        continue;
      }
    }

    if (allChunks.length === 0) return [];

    // Compute document frequencies & average chunk length for BM25
    const docCount = allChunks.length;
    const avgLen = allChunks.reduce((acc, c) => acc + c.length, 0) / docCount;
    const docFreq = new Map<string, number>();
    for (const chunk of allChunks) {
      for (const term of chunk.termFreq.keys()) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }

    const queryTerms = [...new Set(tokenizeCodeTerms(query))];
    const distinctIds = extractDistinctIdentifiers(query);
    const { fileMentions, symbolMentions } = extractMentions(query);

    const scored: Array<{ chunk: IndexedChunk; score: number; reason: RetrievedChunk["reason"] }> = [];

    for (const chunk of allChunks) {
      let score = 0;
      let reason: RetrievedChunk["reason"] = "bm25";

      // 1. Explicit @file or path mention boost
      const exactPathHit = fileMentions.some(
        (fm) => chunk.relPath.toLowerCase() === fm.toLowerCase() || chunk.relPath.toLowerCase().endsWith(`/${fm.toLowerCase()}`),
      );
      if (exactPathHit) {
        // Prioritize primary code chunks (first 2 chunks of a mentioned file, or symbol definitions)
        score += chunk.startLine <= 60 ? 50 : 12;
        reason = query.includes(`@${chunk.relPath}`) ? "mention" : "path";
      }

      // 2. Explicit @symbol mention boost
      if (
        symbolMentions.some(
          (sm) =>
            chunk.symbolName?.toLowerCase() === sm.toLowerCase() ||
            chunk.rawText.includes(sm),
        )
      ) {
        score += 45;
        reason = "mention";
      }

      // 3. Exact distinct code identifier boost (e.g. APP_TITLE, fullName, formatUser)
      for (const id of distinctIds) {
        if (chunk.rawText.includes(id)) {
          score += 18;
          if (reason === "bm25") reason = "identifier";
        }
      }

      // 4. Standard Okapi BM25 score across tokenized query terms
      for (const qTerm of queryTerms) {
        const tf = chunk.termFreq.get(qTerm) ?? 0;
        if (tf === 0) continue;
        const df = docFreq.get(qTerm) ?? 0;
        const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
        const denom = tf + this.k1 * (1 - this.b + this.b * (chunk.length / avgLen));
        score += idf * ((tf * (this.k1 + 1)) / denom);
      }

      if (score >= minScore) {
        scored.push({ chunk, score, reason });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.chunk.relPath.localeCompare(b.chunk.relPath) || a.chunk.startLine - b.chunk.startLine);

    // Also pull 1-hop imported type definitions when a top-hit file is tiny (e.g. src/format.ts imports ./user)
    if (scored.length > 0 && scored.length < maxChunks) {
      const topChunk = scored[0].chunk;
      const relImportRe = /from\s+["'](\.[^"']+)["']/g;
      let im: RegExpExecArray | null;
      const baseDir = path.posix.dirname(topChunk.relPath);
      while ((im = relImportRe.exec(topChunk.rawText)) !== null) {
        const targetNoExt = path.posix.normalize(path.posix.join(baseDir === "." ? "" : baseDir, im[1]));
        const importedChunk = allChunks.find(
          (c) => c.startLine === 1 && c.relPath.replace(/\.[a-z0-9]+$/i, "") === targetNoExt,
        );
        if (importedChunk && !scored.some((s) => s.chunk === importedChunk)) {
          scored.push({ chunk: importedChunk, score: minScore + 1, reason: "identifier" });
        }
      }
      scored.sort((a, b) => b.score - a.score);
    }

    const selected: RetrievedChunk[] = [];
    let usedTokens = 0;

    for (const item of scored) {
      if (selected.length >= maxChunks) break;
      const numbered = formatNumberedLines(item.chunk.rawLines, item.chunk.startLine);
      const formatted = `--- ${item.chunk.relPath} (lines ${item.chunk.startLine}-${item.chunk.endLine}) ---\n${numbered}`;
      const chunkTok = estimateInputTokens(formatted);
      if (usedTokens + chunkTok > maxTokens && selected.length > 0) continue;
      usedTokens += chunkTok;
      selected.push({
        relPath: item.chunk.relPath,
        startLine: item.chunk.startLine,
        endLine: item.chunk.endLine,
        symbolName: item.chunk.symbolName,
        score: Math.round(item.score * 100) / 100,
        reason: item.reason,
        content: formatted,
      });
    }

    return selected;
  }
}

export function buildRetrievedContextBlock(
  workspaceRoot: string,
  query: string,
  opts: RetrieveOptions = {},
): string {
  const retriever = new WorkspaceBM25Retriever(workspaceRoot);
  const chunks = retriever.retrieve(query, opts);
  if (chunks.length === 0) return "";
  return `[Retrieved Context]\n${chunks.map((c) => c.content).join("\n\n")}`;
}
