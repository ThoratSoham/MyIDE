import React, { useMemo, useState } from "react";

// PART 2: Streaming-safe Markdown renderer with syntax-highlighted code blocks
// and a Copy button. Never uses dangerouslySetInnerHTML so untrusted model
// text cannot inject markup.

interface Block {
  kind: "code" | "text";
  lang?: string;
  file?: string;
  body: string;
  streaming?: boolean;
}

function parseCodeInfo(infoRaw: string): { lang: string; file?: string } {
  const info = infoRaw.trim();
  const [first, second] = info.split(/\s+/);
  const looksLikeFile = (v?: string) => !!v && /[./\\]|\.\w+$/.test(v);
  let lang = first || "text";
  let file: string | undefined;
  if (looksLikeFile(first) && !looksLikeFile(second)) {
    file = first;
    const ext = first.split(".").pop()?.toLowerCase();
    lang = ext || "text";
  } else if (second) {
    file = second;
  }
  return { lang: lang.toLowerCase(), file };
}

/**
 * Split Markdown into text and code blocks, gracefully handling an unclosed
 * ``` fence at the end while assistant tokens are still streaming.
 */
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let inCode = false;
  let codeLang = "text";
  let codeFile: string | undefined;
  let buf: string[] = [];

  const flushText = () => {
    if (buf.length > 0) {
      blocks.push({ kind: "text", body: buf.join("\n") });
      buf = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!inCode && trimmed.startsWith("```")) {
      flushText();
      const parsed = parseCodeInfo(trimmed.slice(3));
      codeLang = parsed.lang;
      codeFile = parsed.file;
      inCode = true;
    } else if (inCode && trimmed.startsWith("```") && trimmed.slice(3).trim() === "") {
      blocks.push({ kind: "code", lang: codeLang, file: codeFile, body: buf.join("\n") });
      buf = [];
      inCode = false;
    } else {
      buf.push(line);
    }
  }

  if (inCode) {
    blocks.push({ kind: "code", lang: codeLang, file: codeFile, body: buf.join("\n"), streaming: true });
  } else if (buf.length > 0) {
    blocks.push({ kind: "text", body: buf.join("\n") });
  }

  return blocks;
}

// ---- Lightweight React syntax highlighter -------------------------------

const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally",
  "for", "from", "function", "if", "implements", "import", "in", "instanceof", "interface",
  "let", "new", "null", "of", "package", "private", "protected", "public", "readonly",
  "return", "static", "super", "switch", "this", "throw", "true", "try", "type", "typeof",
  "undefined", "var", "void", "while", "with", "yield",
  // Python / Rust / Go / Shell common keywords
  "def", "elif", "except", "fn", "func", "go", "impl", "lambda", "match", "mod", "mut",
  "None", "nonlocal", "pass", "pub", "raise", "Self", "self", "struct", "trait", "True",
  "False", "use", "where", "then", "fi", "esac", "done",
]);

const TOKEN_RE =
  /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(<\/?[A-Za-z][A-Za-z0-9.-]*|\/>)|(\b\d+(?:\.\d+)?\b)|(\b[A-Z][A-Za-z0-9_]*\b)|(\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\())|(\b[a-zA-Z_$][a-zA-Z0-9_$]*\b)/g;

function highlightCode(code: string, lang?: string): React.ReactNode[] {
  if (!code || lang === "text" || lang === "plain") return [code];
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = TOKEN_RE.exec(code)) !== null) {
    if (m.index > last) {
      nodes.push(code.slice(last, m.index));
    }
    const full = m[0];
    if (m[1]) {
      nodes.push(
        <span key={k++} style={{ color: "var(--syn-comment)", fontStyle: "italic" }}>
          {full}
        </span>,
      );
    } else if (m[2]) {
      nodes.push(
        <span key={k++} style={{ color: "var(--syn-string)" }}>
          {full}
        </span>,
      );
    } else if (m[3]) {
      nodes.push(
        <span key={k++} style={{ color: "var(--syn-tag)" }}>
          {full}
        </span>,
      );
    } else if (m[4]) {
      nodes.push(
        <span key={k++} style={{ color: "var(--syn-number)" }}>
          {full}
        </span>,
      );
    } else if (m[5]) {
      nodes.push(
        <span key={k++} style={{ color: KEYWORDS.has(full) ? "var(--syn-keyword)" : "var(--syn-type)" }}>
          {full}
        </span>,
      );
    } else if (m[6]) {
      nodes.push(
        <span key={k++} style={{ color: KEYWORDS.has(full) ? "var(--syn-keyword)" : "var(--syn-fn)" }}>
          {full}
        </span>,
      );
    } else if (m[7] && KEYWORDS.has(full)) {
      nodes.push(
        <span key={k++} style={{ color: "var(--syn-keyword)", fontWeight: 500 }}>
          {full}
        </span>,
      );
    } else {
      nodes.push(full);
    }
    last = m.index + full.length;
  }

  if (last < code.length) nodes.push(code.slice(last));
  return nodes;
}

function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyBase}-${i++}`;
    if (token.startsWith("`")) {
      out.push(
        <code key={key} className="rounded bg-[var(--color-base)] px-1 py-0.5 font-mono text-[12px]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("[")) {
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(token);
      out.push(
        <a key={key} href={link?.[2]} target="_blank" rel="noreferrer" className="text-[var(--color-accent-strong)] underline">
          {link?.[1]}
        </a>,
      );
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function TextBlock({ body, base }: { body: string; base: string }) {
  const nodes: React.ReactNode[] = [];
  const lines = body.split("\n");
  let ulItems: string[] = [];
  let olItems: string[] = [];

  const flushLists = () => {
    if (ulItems.length) {
      const items = ulItems;
      ulItems = [];
      nodes.push(
        <ul key={`ul-${base}-${nodes.length}`} className="my-1 list-disc space-y-0.5 pl-5">
          {items.map((it, i) => (
            <li key={i}>{inline(it, `${base}-li-${i}`)}</li>
          ))}
        </ul>,
      );
    }
    if (olItems.length) {
      const items = olItems;
      olItems = [];
      nodes.push(
        <ol key={`ol-${base}-${nodes.length}`} className="my-1 list-decimal space-y-0.5 pl-5">
          {items.map((it, i) => (
            <li key={i}>{inline(it, `${base}-oli-${i}`)}</li>
          ))}
        </ol>,
      );
    }
  };

  lines.forEach((line, idx) => {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      if (olItems.length) flushLists();
      ulItems.push(bullet[1]);
      return;
    }
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      if (ulItems.length) flushLists();
      olItems.push(numbered[1]);
      return;
    }
    flushLists();
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      nodes.push(
        <blockquote
          key={`q-${base}-${idx}`}
          className="my-1 border-l-2 border-[var(--color-accent)] pl-2.5 text-xs italic text-[var(--color-muted)]"
        >
          {inline(quote[1], `${base}-q-${idx}`)}
        </blockquote>,
      );
      return;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const cls =
        level === 1 ? "mt-2 text-base font-semibold" : level === 2 ? "mt-2 text-sm font-semibold" : "mt-1 text-sm font-medium";
      nodes.push(
        <div key={`h-${base}-${idx}`} className={cls}>
          {inline(heading[2], `${base}-h-${idx}`)}
        </div>,
      );
      return;
    }
    if (!line.trim()) return;
    nodes.push(
      <p key={`p-${base}-${idx}`} className="my-0.5">
        {inline(line, `${base}-p-${idx}`)}
      </p>,
    );
  });
  flushLists();
  return <>{nodes}</>;
}

function CodeBlock({ block }: { block: Block }) {
  const [copied, setCopied] = useState(false);
  const highlighted = useMemo(() => highlightCode(block.body, block.lang), [block.body, block.lang]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard may be blocked in headless environments */
    }
  };

  return (
    <div className="my-2 overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-base)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[10px] text-[var(--color-muted)]">
        <span className="font-mono uppercase">{block.lang || "code"}</span>
        {block.file && <span className="truncate font-mono text-[var(--color-text)]">{block.file}</span>}
        {block.streaming && <span className="italic text-[var(--color-accent)]">streaming…</span>}
        <button
          type="button"
          aria-label="Copy code to clipboard"
          onClick={() => void copy()}
          className="ml-auto rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="max-h-80 overflow-auto p-2.5 text-[11.5px] leading-relaxed">
        <code className="font-mono">{highlighted}</code>
      </pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => splitBlocks(text ?? ""), [text]);
  return (
    <div className="text-sm leading-relaxed text-[var(--color-text)]">
      {blocks.map((b, i) =>
        b.kind === "code" ? <CodeBlock key={i} block={b} /> : <TextBlock key={i} body={b.body} base={`b${i}`} />,
      )}
    </div>
  );
}
