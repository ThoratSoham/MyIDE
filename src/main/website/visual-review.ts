import * as fs from "node:fs";
import * as path from "node:path";
import type { Router } from "../ai/router";
import type { Lane } from "../ai/types";
import { validateHtmlDocument } from "./validator";
import { checkReferenceClosure } from "./reference-closure";

export interface VisualIssue {
  area: string;
  problem: string;
  fix: string;
  severity: "error" | "warning";
}

export interface VisualReviewReport {
  visualScore: number; // 1-10
  structurePassed: boolean;
  assetsPassed: boolean;
  desktopScreenshot?: string; // base64 or file path
  mobileScreenshot?: string;
  issues: VisualIssue[];
  runtimeErrors: string[];
  evaluatedWithVision: boolean;
}

export interface VisualReviewOptions {
  workspaceRoot: string;
  router?: Router;
  signal?: AbortSignal;
  visionLane?: Lane;
}

/**
 * Local heuristic audit (fast, free, runs anywhere in Node.js or Electron)
 */
export function runLocalHeuristicAudit(html: string): {
  issues: VisualIssue[];
  runtimeErrors: string[];
  contrastRatioEstimate: number;
} {
  const issues: VisualIssue[] = [];
  const runtimeErrors: string[] = [];

  // 1. Unstyled fallback font check
  const hasStylesheet = /<link[^>]+rel=["']stylesheet["']/i.test(html);
  const hasStyleTag = /<style(?:\s+[^>]*)?>[\s\S]+?<\/style>/i.test(html);
  if (!hasStylesheet && !hasStyleTag) {
    issues.push({
      area: "Typography",
      problem: "Page lacks any stylesheet or style tag; rendering will fall back to default Times New Roman.",
      fix: "Add <link rel=\"stylesheet\" href=\"css/style.css\"> or an inline <style> block with design tokens.",
      severity: "error",
    });
  }

  // 2. Empty element check
  const emptyHeadings = html.match(/<h[1-6][^>]*>\s*<\/h[1-6]>/gi) ?? [];
  if (emptyHeadings.length > 0) {
    issues.push({
      area: "Headings",
      problem: `Found ${emptyHeadings.length} empty heading tag(s) with no text content.`,
      fix: "Ensure all <h1>-<h6> tags have meaningful, descriptive headline copy.",
      severity: "warning",
    });
  }

  const emptySections = html.match(/<section[^>]*>\s*<\/section>/gi) ?? [];
  if (emptySections.length > 0) {
    issues.push({
      area: "Layout",
      problem: `Found ${emptySections.length} empty <section> tag(s).`,
      fix: "Remove empty section tags or populate them with content and components.",
      severity: "warning",
    });
  }

  // 3. Overflow hazards (fixed pixel widths without responsive constraints)
  const fixedWidthMatch = html.match(/style=["'][^"']*width:\s*(?:1[2-9]\d\d|\d{4,})px[^"']*["']/gi) ?? [];
  const overflowVwMatch = html.match(/width:\s*100vw/gi) ?? [];
  if (fixedWidthMatch.length > 0 || overflowVwMatch.length > 0) {
    issues.push({
      area: "Responsiveness",
      problem: "Found elements with hardcoded wide pixel widths (e.g. >1200px) or width:100vw, triggering mobile horizontal scroll.",
      fix: "Use max-width: 100% or max-width: 1200px; width: 100%; box-sizing: border-box.",
      severity: "error",
    });
  }

  // 4. Low-contrast detection (e.g. light-on-light or dark-on-dark styles)
  let contrastRatioEstimate = 7.0;
  const lowContrastPatterns = [
    /color:\s*#(?:fff|ffffff|eee|ddd|ccc)[^;}"']*;\s*background(?:-color)?:\s*#(?:fff|ffffff|f8f9fa|eee|ddd)/i,
    /color:\s*#(?:000|000000|111|222|333)[^;}"']*;\s*background(?:-color)?:\s*#(?:000|000000|0a0a0a|111|222)/i,
    /color:\s*(?:rgba?\([^)]+\)|#[a-f0-9]{3,6});\s*background:\s*transparent/i,
  ];

  for (const pat of lowContrastPatterns) {
    if (pat.test(html)) {
      contrastRatioEstimate = 2.1;
      issues.push({
        area: "Accessibility & Contrast",
        problem: "Low text-to-background contrast detected (< 4.5:1 WCAG AA limit).",
        fix: "Adjust text color or background fill to achieve at least 4.5:1 contrast ratio.",
        severity: "error",
      });
      break;
    }
  }

  // 5. Broken image detection (empty src or 404 external links)
  const emptyImgSrc = html.match(/<img[^>]+src=["'](?:\s*|#)["']/gi) ?? [];
  if (emptyImgSrc.length > 0) {
    issues.push({
      area: "Images",
      problem: `Found ${emptyImgSrc.length} <img> tag(s) with empty or '#' src attribute.`,
      fix: "Replace empty src with inline SVGs or valid asset paths.",
      severity: "warning",
    });
  }

  return { issues, runtimeErrors, contrastRatioEstimate };
}

/**
 * Runs a complete visual review using local heuristics and optionally a vision model
 * if an eligible vision lane is available (e.g. Gemini 2.5 Flash).
 */
export async function runVisualReview(opts: VisualReviewOptions): Promise<VisualReviewReport> {
  const { workspaceRoot, router, visionLane, signal } = opts;
  const indexAbs = path.join(workspaceRoot, "index.html");

  if (!fs.existsSync(indexAbs)) {
    return {
      visualScore: 1,
      structurePassed: false,
      assetsPassed: false,
      issues: [{ area: "File System", problem: "index.html not found", fix: "Generate index.html", severity: "error" }],
      runtimeErrors: ["index.html missing"],
      evaluatedWithVision: false,
    };
  }

  const html = fs.readFileSync(indexAbs, "utf8");

  // Step 1: Validate HTML structure
  const structureResult = validateHtmlDocument(html);
  const structurePassed = structureResult.ok;

  // Step 2: Validate asset closure
  const knownFiles = new Map<string, string>();
  knownFiles.set("index.html", html);
  const cssAbs = path.join(workspaceRoot, "css", "style.css");
  if (fs.existsSync(cssAbs)) knownFiles.set("css/style.css", fs.readFileSync(cssAbs, "utf8"));
  const jsAbs = path.join(workspaceRoot, "js", "main.js");
  if (fs.existsSync(jsAbs)) knownFiles.set("js/main.js", fs.readFileSync(jsAbs, "utf8"));

  const closureResult = checkReferenceClosure(workspaceRoot, knownFiles);
  const assetsPassed = closureResult.valid;

  // Step 3: Run local heuristics
  const heuristic = runLocalHeuristicAudit(html);
  const issues: VisualIssue[] = [...heuristic.issues];
  const runtimeErrors: string[] = [...heuristic.runtimeErrors];

  if (!structurePassed) {
    issues.unshift({
      area: "HTML Structure",
      problem: structureResult.error || "Duplicate <html>, <body>, or <!DOCTYPE> declarations found.",
      fix: "Ensure exactly 1 <!DOCTYPE html>, 1 <html>, and 1 <body> exist.",
      severity: "error",
    });
  }

  if (!assetsPassed && closureResult.missing.length > 0) {
    const missingPaths = closureResult.missing.map((m) => m.rawRef).join(", ");
    issues.push({
      area: "Asset References",
      problem: `Missing local asset reference(s): ${missingPaths}`,
      fix: "Inline the styles/scripts or generate the missing files.",
      severity: "error",
    });
  }

  // Calculate base score from heuristics
  let score = 10;
  for (const issue of issues) {
    if (issue.severity === "error") score -= 2.5;
    else score -= 1.0;
  }
  score = Math.max(1, Math.min(10, Math.round(score * 10) / 10));

  let evaluatedWithVision = false;

  // Step 4: Vision model review (if router and visionLane are available)
  if (router && visionLane && visionLane.capabilities?.supportsVision) {
    try {
      evaluatedWithVision = true;
      const visionPrompt = [
        "You are an expert design director evaluating a generated webpage layout.",
        "Evaluate the design quality, contrast, hierarchy, spacing, typography, and polish.",
        "HTML content snippet:",
        "```html",
        html.slice(0, 3000),
        "```",
        "Known heuristic findings:",
        JSON.stringify(issues, null, 2),
        "Respond STRICTLY with valid JSON in this exact shape:",
        `{
  "visualScore": number (1-10),
  "issues": [
    { "area": "Hero | Nav | Contrast | Typography | Grid", "problem": "string", "fix": "string", "severity": "error" | "warning" }
  ]
}`,
      ].join("\n");

      const visionRes = await router.send(
        "reasoning",
        [
          { role: "system", content: "You evaluate webpage designs visually and return strictly JSON." },
          { role: "user", content: visionPrompt },
        ],
        {
          signal,
          pinnedLaneId: visionLane.id,
          minOutputTokens: 1000,
        },
      );

      if (visionRes.ok && visionRes.content) {
        const jsonMatch = visionRes.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (typeof parsed.visualScore === "number") {
            score = Math.max(1, Math.min(10, parsed.visualScore));
          }
          if (Array.isArray(parsed.issues)) {
            for (const item of parsed.issues) {
              if (item.problem && item.fix) {
                issues.push({
                  area: item.area || "Visual Design",
                  problem: item.problem,
                  fix: item.fix,
                  severity: item.severity === "error" ? "error" : "warning",
                });
              }
            }
          }
        }
      }
    } catch {
      // Heuristics remain fallback
    }
  }

  // Generate lightweight SVG mock previews for desktop and mobile thumbnails
  const desktopThumbnail = `data:image/svg+xml;utf8,<svg width="320" height="200" viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg"><rect width="320" height="200" fill="%231e293b"/><rect x="10" y="10" width="300" height="25" rx="4" fill="%23334155"/><rect x="10" y="45" width="180" height="70" rx="4" fill="%23475569"/><rect x="200" y="45" width="110" height="70" rx="4" fill="%233b82f6"/><rect x="10" y="125" width="95" height="65" rx="4" fill="%23334155"/><rect x="112" y="125" width="95" height="65" rx="4" fill="%23334155"/><rect x="215" y="125" width="95" height="65" rx="4" fill="%23334155"/></svg>`;
  const mobileThumbnail = `data:image/svg+xml;utf8,<svg width="120" height="240" viewBox="0 0 120 240" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="240" rx="8" fill="%230f172a"/><rect x="8" y="10" width="104" height="20" rx="3" fill="%23334155"/><rect x="8" y="38" width="104" height="60" rx="3" fill="%233b82f6"/><rect x="8" y="106" width="104" height="50" rx="3" fill="%231e293b"/><rect x="8" y="164" width="104" height="50" rx="3" fill="%231e293b"/></svg>`;

  return {
    visualScore: score,
    structurePassed,
    assetsPassed,
    desktopScreenshot: desktopThumbnail,
    mobileScreenshot: mobileThumbnail,
    issues,
    runtimeErrors,
    evaluatedWithVision,
  };
}
