import { findTool, insideWorkspace, isEnvFile, type AgentState, type ToolContext } from "./tools";

// PHASE 2A: Multi-file `<file path="relative/path.ext">...content...</file>` parser
// and safe workspace writer.
// - Tolerates a missing closing `</file>` tag at EOF (stream cut-off).
// - Strips markdown code fences accidentally wrapped immediately inside `<file>` blocks.
// - Writes exclusively through the validated workspace writeFile tool (enforcing
//   insideWorkspace, .env refusal, and .myide/backups).

export interface ParsedFileTag {
  path: string;
  content: string;
  unclosedAtEnd: boolean;
}

export interface FileTagWriteSummary {
  written: Array<{ path: string; bytes: number }>;
  errors: Array<{ path: string; error: string }>;
}

const FILE_OPEN_RE = /<file\s+[^>]*?\bpath\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi;

/**
 * Strip a single outer ```lang ... ``` wrapper if a model put markdown fences
 * directly inside `<file path="...">...</file>`.
 */
export function stripInnerMarkdownFence(raw: string): string {
  const trimmed = raw.replace(/^\r?\n/, "").replace(/\r?\n\s*$/, "");
  const match = /^```[^\r\n`]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed.trim());
  if (match) {
    return match[1] + "\n";
  }
  // Also handle unclosed trailing fence if stream truncated right at EOF
  const openFenceOnly = /^```[^\r\n`]*\r?\n([\s\S]*)$/.exec(trimmed.trim());
  if (openFenceOnly && !openFenceOnly[1].includes("```")) {
    return openFenceOnly[1].replace(/\r?\n```$/, "") + "\n";
  }
  return trimmed.endsWith("\n") ? trimmed : trimmed + "\n";
}

function normalizeRelativeTagPath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/**
 * Extract all `<file path="...">...</file>` blocks from model text.
 * Tolerates a missing closing `</file>` tag on the final file block at end of stream.
 */
export function parseFileTags(text: string): ParsedFileTag[] {
  const src = text ?? "";
  if (!/<file\s+/i.test(src)) return [];

  const results: ParsedFileTag[] = [];
  FILE_OPEN_RE.lastIndex = 0;

  const opens: Array<{ path: string; openStart: number; bodyStart: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = FILE_OPEN_RE.exec(src)) !== null) {
    const rawPath = match[1] ?? match[2] ?? "";
    const clean = normalizeRelativeTagPath(rawPath);
    if (!clean) continue;
    opens.push({
      path: clean,
      openStart: match.index,
      bodyStart: match.index + match[0].length,
    });
  }

  for (let i = 0; i < opens.length; i++) {
    const current = opens[i];
    const nextOpenStart = i + 1 < opens.length ? opens[i + 1].openStart : src.length;
    const slice = src.slice(current.bodyStart, nextOpenStart);
    const closeMatch = /<\/file\s*>/i.exec(slice);

    let rawBody: string;
    let unclosed = false;
    if (closeMatch) {
      rawBody = slice.slice(0, closeMatch.index);
    } else {
      // Tolerate missing closing tag (either before the next <file> or at EOF)
      rawBody = slice;
      unclosed = i === opens.length - 1;
    }

    const content = stripInnerMarkdownFence(rawBody);
    results.push({
      path: current.path,
      content,
      unclosedAtEnd: unclosed,
    });
  }

  // Deduplicate if the model emitted an updated version of the same path later in the same turn
  const byPath = new Map<string, ParsedFileTag>();
  for (const item of results) {
    byPath.set(item.path, item);
  }
  return [...byPath.values()];
}

/**
 * Safely validate and write parsed `<file>` blocks using the real `writeFile` tool,
 * preserving workspace boundary checks, `.env` blocking, and `.myide/backups`.
 */
export async function applyParsedFileTags(
  files: ParsedFileTag[],
  state: AgentState,
  ctx: Omit<ToolContext, "state">,
  onToolEvent?: (info: { path: string; ok: boolean; output: string }) => void,
): Promise<FileTagWriteSummary> {
  const writeTool = findTool("writeFile");
  const written: Array<{ path: string; bytes: number }> = [];
  const errors: Array<{ path: string; error: string }> = [];

  if (!writeTool) {
    return {
      written,
      errors: files.map((f) => ({ path: f.path, error: "writeFile tool unavailable" })),
    };
  }

  const fullCtx: ToolContext = { ...ctx, state };

  for (const f of files) {
    try {
      const abs = insideWorkspace(state.workspaceRoot, f.path);
      if (isEnvFile(abs)) {
        const msg = `Refused: .env files cannot be written (${f.path})`;
        errors.push({ path: f.path, error: msg });
        onToolEvent?.({ path: f.path, ok: false, output: msg });
        continue;
      }

      const res = await writeTool.run({ path: f.path, content: f.content }, fullCtx);
      onToolEvent?.({ path: f.path, ok: res.ok, output: res.output });
      if (res.ok) {
        const data = res.data as { bytes?: number } | undefined;
        written.push({ path: f.path, bytes: data?.bytes ?? Buffer.byteLength(f.content, "utf8") });
      } else {
        errors.push({ path: f.path, error: res.output });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ path: f.path, error: msg });
      onToolEvent?.({ path: f.path, ok: false, output: msg });
    }
  }

  return { written, errors };
}

