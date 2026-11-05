/**
 * Site Manifest Manager (PHASE 1)
 *
 * Defines the contract of files to be generated before code generation begins.
 * On free-tier models, defaults to a single self-contained index.html with inline
 * <style> and <script>, preventing broken 404 local asset references.
 */

export interface ManifestFileEntry {
  path: string;
  purpose: string;
}

export interface SiteManifest {
  entry: string;
  files: ManifestFileEntry[];
  selfContained: boolean;
}

export interface ManifestOptions {
  brief: string;
  laneOutputBudget?: number;
  forceMultiFile?: boolean;
  forceSelfContained?: boolean;
}

const MULTI_FILE_KEYWORDS = /\b(?:separate\s+(?:css|js|files|stylesheets)|external\s+(?:css|js|styles|scripts)|multi-?file|css\/style\.css|js\/main\.js|styles\.css|script\.js)\b/i;

/**
 * Resolves the site manifest based on prompt requirements and lane output capacity.
 */
export function resolveSiteManifest(opts: ManifestOptions): SiteManifest {
  if (opts.forceSelfContained) {
    return {
      entry: "index.html",
      files: [
        {
          path: "index.html",
          purpose: "Self-contained page with embedded inline <style> and <script>",
        },
      ],
      selfContained: true,
    };
  }

  if (opts.forceMultiFile) {
    return {
      entry: "index.html",
      files: [
        { path: "index.html", purpose: "Semantic HTML5 markup and layout structure" },
        { path: "css/style.css", purpose: "Design tokens, utility classes, and responsive styles" },
        { path: "js/main.js", purpose: "Client-side interactive behavior and micro-interactions" },
      ],
      selfContained: false,
    };
  }

  const asksForMultiFile = MULTI_FILE_KEYWORDS.test(opts.brief);
  const hasAmpleBudget = (opts.laneOutputBudget ?? 4096) >= 16000;

  // On free-tier lanes or when not explicitly requested, prefer self-contained single-file
  // to guarantee 100% asset completeness with 0 missing local files.
  if (asksForMultiFile && hasAmpleBudget) {
    return {
      entry: "index.html",
      files: [
        { path: "index.html", purpose: "Semantic HTML5 markup and layout structure" },
        { path: "css/style.css", purpose: "Design tokens, utility classes, and responsive styles" },
        { path: "js/main.js", purpose: "Client-side interactive behavior and micro-interactions" },
      ],
      selfContained: false,
    };
  }

  return {
    entry: "index.html",
    files: [
      {
        path: "index.html",
        purpose: "Self-contained landing page with embedded inline <style> and <script>",
      },
    ],
    selfContained: true,
  };
}

/**
 * Builds instructions for the LLM system/user prompt enforcing the manifest file list.
 */
export function formatManifestPromptInstruction(manifest: SiteManifest): string {
  if (manifest.selfContained) {
    return [
      "SITE MANIFEST (Strict):",
      "- Target file: Exactly 1 self-contained file: `index.html`.",
      "- All CSS must be placed directly inside a `<style>` block in the `<head>`.",
      "- All JavaScript must be placed directly inside a `<script>` block before `</body>`.",
      "- DO NOT emit or link to external local assets like `css/style.css` or `js/main.js`.",
      "- For images/graphics: use inline SVG elements or CSS shapes. Do NOT use fake local file paths or external image URLs that can 404.",
    ].join("\n");
  }

  const fileLines = manifest.files.map((f) => `  - <file path="${f.path}">: ${f.purpose}`);
  return [
    "SITE MANIFEST (Strict):",
    `You MUST emit complete <file path="...">...</file> blocks for EVERY file in this manifest:`,
    ...fileLines,
    "- Every `<link rel=\"stylesheet\">`, `<script src=\"...\">`, `<img src=\"...\">`, and CSS `@import` MUST point to one of the exact files listed above, or to an absolute https:// URL (e.g. Google Fonts).",
    "- Never reference uncreated local paths like `images/...` or `assets/...` unless you emit them as <file> blocks.",
  ].join("\n");
}
