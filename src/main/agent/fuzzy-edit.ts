// PHASE 3: 4-tier fuzzy editFile cascade, atomic multi-edit, closest-window
// failure diagnostics, and fast symbol outline extraction.

export type FuzzyEditMatchTier = 1 | 2 | 3 | 4;

export interface ClosestSnippet {
  startLine: number;
  endLine: number;
  similarity: number;
  numberedText: string;
}

export interface FuzzyEditOptions {
  fuzzyEnabled?: boolean;
  filePath?: string;
}

export interface FuzzyEditResult {
  ok: boolean;
  updatedText?: string;
  tier?: FuzzyEditMatchTier;
  ambiguous?: boolean;
  error?: string;
  closestMatches?: ClosestSnippet[];
}

export interface MultiEditItem {
  find: string;
  replace: string;
}

export interface MultiEditResult extends FuzzyEditResult {
  appliedCount: number;
  failedIndex?: number;
}

export interface ExtractedSymbol {
  kind: "function" | "class" | "interface" | "type" | "const" | "heading" | "rule";
  name: string;
  line: number;
  exported: boolean;
}

interface LineSpan {
  index: number; // 0-based
  text: string; // without CR/LF
  startOffset: number;
  endOffset: number; // exclusive of CR/LF
  fullEndOffset: number; // inclusive of trailing CR/LF
}

export function detectDominantEol(text: string): "\r\n" | "\n" {
  let crlf = 0;
  let lfOnly = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
      else lfOnly++;
    }
  }
  return crlf > lfOnly ? "\r\n" : "\n";
}

function splitLinesWithOffsets(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let lineStart = 0;
  let lineIdx = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      const hasCr = i > 0 && text.charCodeAt(i - 1) === 13;
      const contentEnd = hasCr ? i - 1 : i;
      spans.push({
        index: lineIdx++,
        text: text.slice(lineStart, contentEnd),
        startOffset: lineStart,
        endOffset: contentEnd,
        fullEndOffset: i + 1,
      });
      lineStart = i + 1;
    }
  }
  if (lineStart <= text.length) {
    // Only push trailing empty line if text is empty or didn't end on \n?
    // Actually split(/\r?\n/) always includes trailing "" after final \n; let's match standard line behavior:
    if (lineStart < text.length || text.length === 0) {
      spans.push({
        index: lineIdx++,
        text: text.slice(lineStart),
        startOffset: lineStart,
        endOffset: text.length,
        fullEndOffset: text.length,
      });
    }
  }
  return spans;
}

function splitPatternLines(pattern: string): string[] {
  const normalized = pattern.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  // If pattern ended with a trailing newline, drop the empty tail artifact so line-window length matches
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function indentCols(line: string): number {
  let cols = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch === 32) cols += 1;
    else if (ch === 9) cols += 4;
    else break;
  }
  return cols;
}

function detectIndentUnit(lines: string[], baseCols: number): number {
  let smallestStep = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const rel = indentCols(line) - baseCols;
    if (rel > 0 && (smallestStep === 0 || rel < smallestStep)) {
      smallestStep = rel;
    }
  }
  return smallestStep;
}

function detectUsesTabs(lines: string[]): boolean {
  let tabLines = 0;
  let spaceLines = 0;
  for (const line of lines) {
    if (line.startsWith("\t")) tabLines++;
    else if (line.startsWith(" ")) spaceLines++;
  }
  return tabLines > spaceLines;
}

function reindentReplacement(
  matchedFileLines: string[],
  findLines: string[],
  replaceRaw: string,
  eol: "\r\n" | "\n",
): string {
  const replaceNormalized = replaceRaw.replace(/\r\n/g, "\n");
  const hadTrailingNewline = replaceNormalized.endsWith("\n");
  const replaceLines = replaceNormalized.split("\n");
  if (hadTrailingNewline && replaceLines.length > 1 && replaceLines[replaceLines.length - 1] === "") {
    replaceLines.pop();
  }

  const nonEmptyFile = matchedFileLines.filter((l) => l.trim().length > 0);
  const nonEmptyFind = findLines.filter((l) => l.trim().length > 0);
  if (nonEmptyFile.length === 0 || nonEmptyFind.length === 0) {
    return replaceLines.join(eol);
  }

  const fileBaseCols = Math.min(...nonEmptyFile.map(indentCols));
  const findBaseCols = Math.min(...nonEmptyFind.map(indentCols));
  const fileUnit = detectIndentUnit(nonEmptyFile, fileBaseCols);
  const findUnit = detectIndentUnit(nonEmptyFind, findBaseCols);
  const scale = fileUnit > 0 && findUnit > 0 ? fileUnit / findUnit : 1;
  const usesTabs = detectUsesTabs(nonEmptyFile);
  const tabWidth = fileUnit > 0 ? fileUnit : 4;

  const adjusted = replaceLines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.length === 0) return "";
    const rawCols = indentCols(line);
    const relCols = Math.max(0, rawCols - findBaseCols);
    const targetCols = Math.max(0, Math.round(fileBaseCols + relCols * scale));
    if (usesTabs) {
      const tabs = Math.floor(targetCols / tabWidth);
      const remSpaces = targetCols % tabWidth;
      return "\t".repeat(tabs) + " ".repeat(remSpaces) + trimmed;
    }
    return " ".repeat(targetCols) + trimmed;
  });

  return adjusted.join(eol);
}

function applySpanReplacement(
  fullText: string,
  spans: LineSpan[],
  startIdx: number,
  lineCount: number,
  replacementBody: string,
  eol: "\r\n" | "\n",
  findEndedWithNewline: boolean,
): string {
  const firstSpan = spans[startIdx];
  const lastSpan = spans[startIdx + lineCount - 1];
  const prefix = fullText.slice(0, firstSpan.startOffset);
  if (findEndedWithNewline && lastSpan.fullEndOffset > lastSpan.endOffset) {
    const suffix = fullText.slice(lastSpan.fullEndOffset);
    const withEol = replacementBody.endsWith(eol) ? replacementBody : replacementBody + eol;
    return prefix + withEol + suffix;
  }
  const suffix = fullText.slice(lastSpan.endOffset);
  return prefix + replacementBody + suffix;
}

function normalizeForSimilarity(lines: string[]): string {
  return lines
    .map((l) => l.trim().replace(/\s+/g, " "))
    .join("\n");
}

/** Bounded Levenshtein similarity in [0, 1]. Uses O(min(N,M)) memory. */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  if (Math.abs(a.length - b.length) / maxLen > 0.55) {
    // Quick length ratio bound when lengths diverge dramatically
    return Math.max(0, 1 - Math.abs(a.length - b.length) / maxLen);
  }
  // Cap comparison length at 2400 chars so huge blocks never stall the event loop
  const sa = a.length > 2400 ? a.slice(0, 2400) : a;
  const sb = b.length > 2400 ? b.slice(0, 2400) : b;
  const n = sa.length;
  const m = sb.length;
  let prev = new Uint16Array(m + 1);
  let curr = new Uint16Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const ca = sa.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ca === sb.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  const dist = prev[m];
  return Math.max(0, 1 - dist / Math.max(n, m));
}

export function formatNumberedLines(lines: string[], startLine1Based: number): string {
  const maxLineNum = startLine1Based + lines.length - 1;
  const padWidth = Math.max(4, String(maxLineNum).length);
  return lines
    .map((line, i) => `${String(startLine1Based + i).padStart(padWidth, " ")}| ${line}`)
    .join("\n");
}

function findClosestWindows(spans: LineSpan[], findLines: string[], topK = 3): ClosestSnippet[] {
  if (spans.length === 0 || findLines.length === 0) return [];
  const winLen = Math.min(spans.length, Math.max(1, findLines.length));
  const normFind = normalizeForSimilarity(findLines);
  const scored: Array<{ startIdx: number; endIdx: number; sim: number }> = [];

  for (let i = 0; i <= spans.length - winLen; i++) {
    const windowLines = spans.slice(i, i + winLen).map((s) => s.text);
    const normWin = normalizeForSimilarity(windowLines);
    const sim = stringSimilarity(normWin, normFind);
    scored.push({ startIdx: i, endIdx: i + winLen - 1, sim });
  }

  scored.sort((a, b) => b.sim - a.sim);

  const picked: ClosestSnippet[] = [];
  const usedStarts: number[] = [];
  for (const cand of scored) {
    if (picked.length >= topK) break;
    if (cand.sim < 0.20 && picked.length > 0) break;
    // Skip windows that overlap heavily with an already-selected snippet
    if (usedStarts.some((s) => Math.abs(s - cand.startIdx) < Math.max(1, Math.floor(winLen / 2)))) {
      continue;
    }
    usedStarts.push(cand.startIdx);
    const snippetLines = spans.slice(cand.startIdx, cand.endIdx + 1).map((s) => s.text);
    picked.push({
      startLine: cand.startIdx + 1,
      endLine: cand.endIdx + 1,
      similarity: Math.round(cand.sim * 100) / 100,
      numberedText: formatNumberedLines(snippetLines, cand.startIdx + 1),
    });
  }
  return picked;
}

export function formatFailedEditDiagnostic(relPath: string, closest: ClosestSnippet[], ambiguous = false): string {
  if (ambiguous) {
    const locs = closest
      .map((c) => `lines ${c.startLine}-${c.endLine}:\n${c.numberedText}`)
      .join("\n---\n");
    return (
      `The text to replace appears more than once in ${relPath}. ` +
      `Include more surrounding context lines or use replaceLines(path, startLine, endLine, content).` +
      (locs ? `\nMatching locations:\n${locs}` : "")
    );
  }
  if (closest.length === 0) {
    return `The text to replace was not found in ${relPath}. Read the file and copy exact lines or use replaceLines.`;
  }
  const blocks = closest
    .map((c, idx) => `Match #${idx + 1} (lines ${c.startLine}-${c.endLine}, similarity ${Math.round(c.similarity * 100)}%):\n${c.numberedText}`)
    .join("\n\n");
  return (
    `The text to replace was not found in ${relPath}.\n` +
    `Closest snippets in ${relPath}:\n${blocks}\n` +
    `Copy exact lines (excluding the '  N| ' prefix) or call replaceLines with startLine/endLine.`
  );
}

/**
 * 4-tier matching cascade:
 *  Tier 1: Exact unique substring match.
 *  Tier 2: Line-by-line match ignoring trailing whitespace and CRLF/LF differences (unique only).
 *  Tier 3: Line-by-line match ignoring leading indentation, re-indenting replacement (unique only).
 *  Tier 4: Sliding-window line similarity >= 0.90 (unique peak only), re-indenting replacement.
 */
export function fuzzyReplaceInText(
  text: string,
  find: string,
  replace: string,
  opts: FuzzyEditOptions = {},
): FuzzyEditResult {
  const relPath = opts.filePath ?? "file";
  const fuzzyEnabled = opts.fuzzyEnabled !== false;

  if (!find) {
    return {
      ok: false,
      error: `editFile requires a non-empty 'find' string in ${relPath}.`,
    };
  }

  // ---- Tier 1: Exact substring match ----
  const exactIdx = text.indexOf(find);
  if (exactIdx !== -1) {
    const secondIdx = text.indexOf(find, exactIdx + find.length);
    if (secondIdx !== -1) {
      const spans = splitLinesWithOffsets(text);
      const findLines = splitPatternLines(find);
      const closest = findClosestWindows(spans, findLines, 3);
      return {
        ok: false,
        ambiguous: true,
        closestMatches: closest,
        error: formatFailedEditDiagnostic(relPath, closest, true),
      };
    }
    const updatedText = text.slice(0, exactIdx) + replace + text.slice(exactIdx + find.length);
    return { ok: true, tier: 1, updatedText };
  }

  const spans = splitLinesWithOffsets(text);
  const findLines = splitPatternLines(find);
  const findEndedWithNewline = /\r?\n$/.test(find);
  const eol = detectDominantEol(text);

  if (!fuzzyEnabled || spans.length === 0 || findLines.length === 0 || findLines.length > spans.length) {
    const closest = findClosestWindows(spans, findLines, 3);
    return {
      ok: false,
      closestMatches: closest,
      error: formatFailedEditDiagnostic(relPath, closest, false),
    };
  }

  const winLen = findLines.length;

  // ---- Tier 2: Line-by-line ignoring trailing whitespace & CRLF/LF ----
  const tier2Matches: number[] = [];
  for (let i = 0; i <= spans.length - winLen; i++) {
    let allEqual = true;
    for (let k = 0; k < winLen; k++) {
      if (spans[i + k].text.trimEnd() !== findLines[k].trimEnd()) {
        allEqual = false;
        break;
      }
    }
    if (allEqual) tier2Matches.push(i);
  }

  if (tier2Matches.length > 1) {
    const closest = findClosestWindows(spans, findLines, 3);
    return {
      ok: false,
      ambiguous: true,
      closestMatches: closest,
      error: formatFailedEditDiagnostic(relPath, closest, true),
    };
  }
  if (tier2Matches.length === 1) {
    const startIdx = tier2Matches[0];
    const replaceNormalized = replace.replace(/\r\n/g, "\n").replace(/\n/g, eol);
    const body = findEndedWithNewline ? replaceNormalized.replace(new RegExp(`${eol === "\r\n" ? "\\r\\n" : "\\n"}$`), "") : replaceNormalized;
    const updatedText = applySpanReplacement(text, spans, startIdx, winLen, body, eol, findEndedWithNewline);
    return { ok: true, tier: 2, updatedText };
  }

  // ---- Tier 3: Line-by-line ignoring leading & trailing whitespace, re-indenting replace ----
  const tier3Matches: number[] = [];
  for (let i = 0; i <= spans.length - winLen; i++) {
    let allEqual = true;
    for (let k = 0; k < winLen; k++) {
      if (spans[i + k].text.trim() !== findLines[k].trim()) {
        allEqual = false;
        break;
      }
    }
    if (allEqual) tier3Matches.push(i);
  }

  if (tier3Matches.length > 1) {
    const closest = findClosestWindows(spans, findLines, 3);
    return {
      ok: false,
      ambiguous: true,
      closestMatches: closest,
      error: formatFailedEditDiagnostic(relPath, closest, true),
    };
  }
  if (tier3Matches.length === 1) {
    const startIdx = tier3Matches[0];
    const matchedLines = spans.slice(startIdx, startIdx + winLen).map((s) => s.text);
    const reindented = reindentReplacement(matchedLines, findLines, replace, eol);
    const updatedText = applySpanReplacement(text, spans, startIdx, winLen, reindented, eol, findEndedWithNewline);
    return { ok: true, tier: 3, updatedText };
  }

  // ---- Tier 4: Sliding-window line similarity >= 0.90 (unique peak only) ----
  const normFind = normalizeForSimilarity(findLines);
  // Require meaningful length (>= 12 chars) for similarity matching so tiny tokens don't false-match
  if (normFind.length >= 12) {
    const highWindows: Array<{ startIdx: number; sim: number }> = [];
    for (let i = 0; i <= spans.length - winLen; i++) {
      const winLines = spans.slice(i, i + winLen).map((s) => s.text);
      const sim = stringSimilarity(normalizeForSimilarity(winLines), normFind);
      if (sim >= 0.90) {
        highWindows.push({ startIdx: i, sim });
      }
    }

    // Collapse overlapping windows into distinct non-overlapping peaks
    const peaks: Array<{ startIdx: number; sim: number }> = [];
    for (const hw of highWindows) {
      const prev = peaks[peaks.length - 1];
      if (prev && hw.startIdx < prev.startIdx + winLen) {
        if (hw.sim > prev.sim) {
          peaks[peaks.length - 1] = hw;
        }
      } else {
        peaks.push(hw);
      }
    }

    if (peaks.length > 1) {
      const closest = findClosestWindows(spans, findLines, 3);
      return {
        ok: false,
        ambiguous: true,
        closestMatches: closest,
        error: formatFailedEditDiagnostic(relPath, closest, true),
      };
    }

    if (peaks.length === 1) {
      const startIdx = peaks[0].startIdx;
      const matchedLines = spans.slice(startIdx, startIdx + winLen).map((s) => s.text);
      const reindented = reindentReplacement(matchedLines, findLines, replace, eol);
      const updatedText = applySpanReplacement(text, spans, startIdx, winLen, reindented, eol, findEndedWithNewline);
      return { ok: true, tier: 4, updatedText };
    }
  }

  const closest = findClosestWindows(spans, findLines, 3);
  return {
    ok: false,
    closestMatches: closest,
    error: formatFailedEditDiagnostic(relPath, closest, false),
  };
}

/**
 * Applies an array of `{ find, replace }` edits atomically in memory.
 * If any edit fails or is ambiguous, aborts and returns `ok: false` without mutating disk.
 */
export function applyMultiEditsAtomically(
  initialText: string,
  edits: ReadonlyArray<MultiEditItem>,
  opts: FuzzyEditOptions = {},
): MultiEditResult {
  if (edits.length === 0) {
    return {
      ok: false,
      appliedCount: 0,
      error: `editFile 'edits' array must contain at least 1 { find, replace } entry.`,
    };
  }

  let current = initialText;
  let highestTier: FuzzyEditMatchTier = 1;

  for (let i = 0; i < edits.length; i++) {
    const item = edits[i];
    const res = fuzzyReplaceInText(current, item.find, item.replace, opts);
    if (!res.ok || res.updatedText === undefined) {
      return {
        ok: false,
        appliedCount: i,
        failedIndex: i,
        ambiguous: res.ambiguous,
        closestMatches: res.closestMatches,
        error: `Edit #${i + 1}/${edits.length} failed: ${res.error ?? "no match"}`,
      };
    }
    current = res.updatedText;
    if (res.tier && res.tier > highestTier) highestTier = res.tier;
  }

  return {
    ok: true,
    updatedText: current,
    tier: highestTier,
    appliedCount: edits.length,
  };
}

/**
 * Extracts functions, classes, interfaces, types, exported constants, HTML headings,
 * or CSS top-level rules with 1-based line numbers. Shared by `getSymbols`, `readFile`
 * (>200 lines outline), and Phase 4 `repo-map.ts`.
 */
export function extractSymbolsFromText(filePath: string, text: string): ExtractedSymbol[] {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  const lines = text.split(/\r?\n/);
  const out: ExtractedSymbol[] = [];

  if (ext === "html" || ext === "htm") {
    for (let i = 0; i < lines.length; i++) {
      const m = /<(h[1-3]|section|nav|main|footer)\b[^>]*(?:id=["']([^"']+)["'])?[^>]*>/i.exec(lines[i]);
      if (m) {
        const tag = m[1].toLowerCase();
        const idPart = m[2] ? `#${m[2]}` : "";
        out.push({ kind: "heading", name: `<${tag}${idPart}>`, line: i + 1, exported: true });
      }
    }
    return out;
  }

  if (ext === "css") {
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const m = /^([.#a-zA-Z:@][^{;]{0,60})\{/.exec(trimmed);
      if (m) {
        out.push({ kind: "rule", name: m[1].trim(), line: i + 1, exported: true });
      }
    }
    return out;
  }

  if (ext === "py") {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[i]);
      if (m) {
        out.push({
          kind: m[2] === "class" ? "class" : "function",
          name: m[3],
          line: i + 1,
          exported: m[1].length === 0 && !m[3].startsWith("_"),
        });
      }
    }
    return out;
  }

  // Default: TypeScript / JavaScript / TSX / JSX
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const fnMatch = /^(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed);
    if (fnMatch) {
      out.push({ kind: "function", name: fnMatch[2], line: i + 1, exported: Boolean(fnMatch[1]) });
      continue;
    }

    const clsMatch = /^(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed);
    if (clsMatch) {
      out.push({ kind: "class", name: clsMatch[2], line: i + 1, exported: Boolean(clsMatch[1]) });
      continue;
    }

    const ifaceMatch = /^(export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed);
    if (ifaceMatch) {
      out.push({ kind: "interface", name: ifaceMatch[2], line: i + 1, exported: Boolean(ifaceMatch[1]) });
      continue;
    }

    const typeMatch = /^(export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]+>)?\s*=/.exec(trimmed);
    if (typeMatch) {
      out.push({ kind: "type", name: typeMatch[2], line: i + 1, exported: Boolean(typeMatch[1]) });
      continue;
    }

    const constFnOrExportMatch =
      /^(export\s+)?(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/.exec(
        trimmed,
      );
    if (constFnOrExportMatch) {
      out.push({
        kind: "function",
        name: constFnOrExportMatch[2],
        line: i + 1,
        exported: Boolean(constFnOrExportMatch[1]),
      });
      continue;
    }

    const exportedConstMatch = /^export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(trimmed);
    if (exportedConstMatch) {
      out.push({ kind: "const", name: exportedConstMatch[1], line: i + 1, exported: true });
    }
  }

  return out;
}

