// PART 3 point 4: when the model answers with code as plain text instead of
// calling a tool, we parse the code fences so the user can save them with one
// click. A fence is recognised by a file name hint either in the info string
// (```html index.html) or on a "File: path" line just before the fence.

export interface SuggestedFile {
  path: string;
  content: string;
}

const LANG_TO_NAME: Record<string, string> = {
  html: "index.html",
  htm: "index.html",
  css: "css/style.css",
  scss: "css/style.css",
  js: "js/main.js",
  javascript: "js/main.js",
  mjs: "js/main.js",
  ts: "src/index.ts",
  typescript: "src/index.ts",
  tsx: "src/App.tsx",
  jsx: "src/App.jsx",
  json: "data.json",
  md: "README.md",
  markdown: "README.md",
  python: "main.py",
  py: "main.py",
  sh: "script.sh",
  bash: "script.sh",
  yml: "config.yml",
  yaml: "config.yml",
  svg: "image.svg",
};

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

function cleanPath(raw: string): string | null {
  const value = raw.trim().replace(/^["'`(]+|["'`)]+$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!value || value.includes("..") || value.startsWith("/")) return null;
  if (!SAFE_PATH.test(value)) return null;
  if (!/\.[A-Za-z0-9]+$/.test(value)) return null;
  return value;
}

/**
 * Pull file candidates out of a plain-text answer. Returns [] when nothing looks
 * like a named file — we never guess a name out of thin air beyond the language.
 */
export function parseSuggestedFiles(text: string): SuggestedFile[] {
  const src = text ?? "";
  if (!src.includes("```")) return [];

  const out: SuggestedFile[] = [];
  const seen = new Set<string>();
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;

  while ((m = fence.exec(src)) !== null) {
    const info = (m[1] ?? "").trim();
    const body = m[2] ?? "";

    // "```html index.html" or "```index.html" or "```html title=index.html"
    let candidate: string | null = null;
    const parts = info.split(/\s+/).filter(Boolean);
    for (const part of parts) {
      const named = /^(?:file|filename|path|title)=(.+)$/i.exec(part);
      if (named) {
        candidate = cleanPath(named[1]);
        if (candidate) break;
      }
      const asPath = cleanPath(part);
      if (asPath && /\//.test(asPath)) {
        candidate = asPath;
        break;
      }
    }
    if (!candidate) {
      for (const part of parts) {
        const asPath = cleanPath(part);
        if (asPath) {
          candidate = asPath;
          break;
        }
      }
    }

    // A "File: path" (or "// path" / "<!-- path -->") line just before the fence.
    if (!candidate) {
      const before = src.slice(0, m.index);
      const lines = before.split("\n").map((l) => l.trim()).filter(Boolean);
      const last = lines[lines.length - 1] ?? "";
      const fileLine = /^(?:file|filename|path)\s*[:=]\s*(.+)$/i.exec(last.replace(/^[/*#<!-]+|[*/#>-]+$/g, "").trim());
      if (fileLine) candidate = cleanPath(fileLine[1]);
    }

    if (!candidate) {
      const lang = parts[0]?.toLowerCase() ?? "";
      candidate = LANG_TO_NAME[lang] ?? null;
    }

    if (!candidate || seen.has(candidate) || !body.trim()) continue;
    seen.add(candidate);
    out.push({ path: candidate, content: body });
  }

  return out;
}
