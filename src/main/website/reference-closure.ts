import path from "path";
import fs from "fs";

/**
 * Reference Closure Checker (PHASE 1)
 *
 * Scans generated HTML and CSS files for local file references (stylesheets,
 * scripts, images, fonts) and verifies that every referenced file exists.
 * Provides targeted repair prompts or local fallbacks (inline SVGs, stub files)
 * so sites never render with broken assets or 404s.
 */

export interface AssetReference {
  parentFile: string;
  rawRef: string;
  normalizedPath: string;
  kind: "stylesheet" | "script" | "image" | "font" | "other";
}

export interface ReferenceClosureReport {
  valid: boolean;
  references: AssetReference[];
  missing: AssetReference[];
}

function isExternalOrSpecial(url: string): boolean {
  const trimmed = url.trim();
  return (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("javascript:")
  );
}

function normalizeAssetPath(parentRelPath: string, ref: string): string {
  const cleanRef = ref.split("?")[0].split("#")[0].trim();
  const parentDir = path.dirname(parentRelPath);
  const resolved = path.join(parentDir, cleanRef).replace(/\\/g, "/");
  return resolved.replace(/^\.\//, "");
}

/**
 * Extract all local asset references from HTML content.
 */
export function extractHtmlReferences(html: string, parentRelPath = "index.html"): AssetReference[] {
  const refs: AssetReference[] = [];

  // 1. <link ... href="...">
  const linkRe = /<link\s+[^>]*?href\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null) {
    const raw = match[1] ?? match[2] ?? "";
    if (isExternalOrSpecial(raw)) continue;
    const isStyle = /rel\s*=\s*["']stylesheet["']/i.test(match[0]);
    refs.push({
      parentFile: parentRelPath,
      rawRef: raw,
      normalizedPath: normalizeAssetPath(parentRelPath, raw),
      kind: isStyle ? "stylesheet" : "other",
    });
  }

  // 2. <script ... src="...">
  const scriptRe = /<script\s+[^>]*?src\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  while ((match = scriptRe.exec(html)) !== null) {
    const raw = match[1] ?? match[2] ?? "";
    if (isExternalOrSpecial(raw)) continue;
    refs.push({
      parentFile: parentRelPath,
      rawRef: raw,
      normalizedPath: normalizeAssetPath(parentRelPath, raw),
      kind: "script",
    });
  }

  // 3. <img ... src="..."> and <source ... src/srcset="...">
  const imgRe = /<(?:img|source)\s+[^>]*?src\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  while ((match = imgRe.exec(html)) !== null) {
    const raw = match[1] ?? match[2] ?? "";
    if (isExternalOrSpecial(raw)) continue;
    refs.push({
      parentFile: parentRelPath,
      rawRef: raw,
      normalizedPath: normalizeAssetPath(parentRelPath, raw),
      kind: "image",
    });
  }

  return refs;
}

/**
 * Extract all url(...) and @import references from CSS content.
 */
export function extractCssReferences(css: string, parentRelPath: string): AssetReference[] {
  const refs: AssetReference[] = [];

  const urlRe = /url\(\s*(?:['"]?)([^'")]+)(?:['"]?)\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(css)) !== null) {
    const raw = (match[1] ?? "").trim();
    if (isExternalOrSpecial(raw)) continue;
    const ext = path.extname(raw).toLowerCase();
    const kind = ext === ".woff" || ext === ".woff2" || ext === ".ttf" || ext === ".otf" ? "font" : "image";
    refs.push({
      parentFile: parentRelPath,
      rawRef: raw,
      normalizedPath: normalizeAssetPath(parentRelPath, raw),
      kind,
    });
  }

  const importRe = /@import\s+(?:url\()?['"]([^'"]+)['"](?:\))?/gi;
  while ((match = importRe.exec(css)) !== null) {
    const raw = (match[1] ?? "").trim();
    if (isExternalOrSpecial(raw)) continue;
    refs.push({
      parentFile: parentRelPath,
      rawRef: raw,
      normalizedPath: normalizeAssetPath(parentRelPath, raw),
      kind: "stylesheet",
    });
  }

  return refs;
}

/**
 * Checks that all references in the provided file contents resolve to either:
 * a) a file in `knownFiles` (files emitted during the current build)
 * b) or an existing file on disk in `workspaceRoot`.
 */
export function checkReferenceClosure(
  workspaceRoot: string,
  knownFiles: Map<string, string>,
): ReferenceClosureReport {
  const allRefs: AssetReference[] = [];

  for (const [relPath, content] of knownFiles.entries()) {
    if (relPath.endsWith(".html") || relPath.endsWith(".htm")) {
      allRefs.push(...extractHtmlReferences(content, relPath));
    } else if (relPath.endsWith(".css")) {
      allRefs.push(...extractCssReferences(content, relPath));
    }
  }

  const missing: AssetReference[] = [];
  const seenMissing = new Set<string>();

  for (const ref of allRefs) {
    const norm = ref.normalizedPath;
    if (knownFiles.has(norm)) continue;

    const abs = path.join(workspaceRoot, norm);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) continue;

    if (!seenMissing.has(norm)) {
      seenMissing.add(norm);
      missing.push(ref);
    }
  }

  return {
    valid: missing.length === 0,
    references: allRefs,
    missing,
  };
}

/**
 * Build a concise targeted prompt requesting ONLY the missing files.
 */
export function buildMissingAssetsPrompt(missing: AssetReference[]): string {
  const lines = [
    `Reference closure check failed: ${missing.length} referenced local file(s) are missing from the build:`,
  ];
  for (const m of missing) {
    lines.push(`- \`${m.normalizedPath}\` (referenced as ${m.kind} in \`${m.parentFile}\`)`);
  }
  lines.push(
    "",
    "Emit complete <file path=\"...\">...</file> blocks ONLY for the missing files listed above.",
    "Do NOT resend the entire website.",
  );
  return lines.join("\n");
}

/**
 * Fallback local resolution if model cannot generate missing assets:
 * - Stubs CSS / JS files.
 * - Replaces broken <img> tags with inline SVG placeholders so the preview never shows broken image icons.
 */
export function inlineOrStubMissingAssetsLocally(
  htmlContent: string,
  missing: AssetReference[],
): { updatedHtml: string; stubsToCreate: Array<{ path: string; content: string }> } {
  let updatedHtml = htmlContent;
  const stubsToCreate: Array<{ path: string; content: string }> = [];

  for (const item of missing) {
    if (item.kind === "stylesheet") {
      // Check if html already contains a <style> block
      if (/<style/i.test(updatedHtml)) {
        // Strip the broken <link>
        const linkPattern = new RegExp(`<link\\s+[^>]*?href=["']${escapeRegExp(item.rawRef)}["'][^>]*>`, "gi");
        updatedHtml = updatedHtml.replace(linkPattern, "<!-- Local stylesheet integrated into inline <style> -->");
      } else {
        stubsToCreate.push({
          path: item.normalizedPath,
          content: "/* Base stylesheet placeholder */\nbody { margin: 0; font-family: system-ui, sans-serif; }\n",
        });
      }
    } else if (item.kind === "script") {
      if (/<script(?!\s+src)/i.test(updatedHtml)) {
        const scriptPattern = new RegExp(`<script\\s+[^>]*?src=["']${escapeRegExp(item.rawRef)}["'][^>]*><\/script>`, "gi");
        updatedHtml = updatedHtml.replace(scriptPattern, "<!-- Local script integrated into inline <script> -->");
      } else {
        stubsToCreate.push({
          path: item.normalizedPath,
          content: "// Base script placeholder\nconsole.log('App ready');\n",
        });
      }
    } else if (item.kind === "image") {
      // Replace missing <img> with an inline SVG placeholder
      const imgPattern = new RegExp(`<img\\s+[^>]*?src=["']${escapeRegExp(item.rawRef)}["'][^>]*>`, "gi");
      const placeholderSvg = [
        `<svg width="120" height="80" viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" style="background:#e2e8f0;border-radius:6px;display:inline-block;vertical-align:middle;">`,
        `<rect width="120" height="80" fill="#f1f5f9"/>`,
        `<text x="60" y="44" font-family="system-ui,sans-serif" font-size="12" fill="#64748b" text-anchor="middle">Image</text>`,
        `</svg>`,
      ].join("");
      updatedHtml = updatedHtml.replace(imgPattern, placeholderSvg);
    }
  }

  return { updatedHtml, stubsToCreate };
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
