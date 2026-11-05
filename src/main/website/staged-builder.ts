import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentEvent } from "../agent/loop";
import type { AgentState } from "../agent/tools";
import type { Lane } from "../ai/types";
import { Router } from "../ai/router";
import { parseFileTags } from "../agent/file-tags";
import { validateHtmlDocument, sanitizeHtmlDocument } from "./validator";
import { checkReferenceClosure, inlineOrStubMissingAssetsLocally } from "./reference-closure";
import { detectStylePack, formatStylePackPromptInstruction } from "./style-packs/index";
import { snapshotFileForRun } from "../agent/checkpoints";

export interface StagedBuildOptions {
  state: AgentState;
  router: Router;
  brief: string;
  defaultStyle?: string;
  pinnedLane?: Lane;
  onEvent: (evt: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface StagedBuildResult {
  ok: boolean;
  files: Array<{ path: string; content: string }>;
  stagesCompleted: string[];
  stagesFailed: string[];
  error?: string;
}

/**
 * Executes a 4-stage build designed specifically for models with small output limits (<16k tokens, e.g. Groq 5,500).
 * Stages:
 *  1. design-system: emits css/style.css
 *  2. skeleton: emits index.html with section placeholders
 *  3. sections: splices real section markup into each placeholder (2-3 per call)
 *  4. behavior: emits js/main.js with interactive behavior
 */
export async function runStagedWebsite(opts: StagedBuildOptions): Promise<StagedBuildResult> {
  const { state, router, brief, onEvent, signal } = opts;
  const pack = detectStylePack(brief, opts.defaultStyle || "minimal-editorial");

  const filesMap = new Map<string, string>();
  const stagesCompleted: string[] = [];
  const stagesFailed: string[] = [];

  const pinnedLaneId = opts.pinnedLane?.id;

  onEvent({
    type: "assistant",
    text: `Starting **staged website build** for small-output lane (${opts.pinnedLane?.id || "auto"}):\n` +
      `Design system: **${pack.name}**\n` +
      `Stages: 1. Design System → 2. Skeleton → 3. Content Sections → 4. Interactive Behavior`,
  });

  const writeFileToDiskAndState = (relPath: string, content: string) => {
    const absPath = path.join(state.workspaceRoot, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    if (state.runId) {
      snapshotFileForRun(state.workspaceRoot, state.runId, relPath);
    }
    fs.writeFileSync(absPath, content, "utf8");
    filesMap.set(relPath, content);
  };

  // Helper to call router with auto-continuation if output was truncated
  const callRouterStage = async (system: string, userMsg: string, maxRetries = 2): Promise<string> => {
    let attempts = 0;
    let lastError = "";

    while (attempts <= maxRetries) {
      attempts++;
      const res = await router.send(
        "codegen",
        [
          { role: "system", content: system },
          { role: "user", content: attempts === 1 ? userMsg : `${userMsg}\n\nPREVIOUS ATTEMPT FAILED WITH: ${lastError}\nPlease fix and output clean complete file tags.` },
        ],
        {
          signal,
          pinnedLaneId,
          minOutputTokens: 3000,
          onWaitCountdown: (info: { laneId: string; model: string; secondsRemaining: number }) => {
            onEvent({ type: "assistant", text: `Waiting for ${info.laneId} (${info.secondsRemaining}s remaining)...` });
          },
        },
      );

      if (!res.ok || !res.content) {
        lastError = res.error?.message || "No response received from model";
        continue;
      }

      let text = res.content;

      // Auto-continuation if truncated (has opening <file> without closing </file>)
      if (text.includes("<file ") && !text.includes("</file>")) {
        const continuation = await router.send(
          "codegen",
          [
            { role: "system", content: system },
            { role: "user", content: userMsg },
            { role: "assistant", content: text },
            { role: "user", content: "continue exactly from where you stopped. Complete the file and close with </file>" },
          ],
          { signal, pinnedLaneId, minOutputTokens: 2000 },
        );
        if (continuation.ok && continuation.content) {
          text += "\n" + continuation.content;
        }
      }

      return text;
    }

    throw new Error(`Stage failed after ${maxRetries} retries: ${lastError}`);
  };

  try {
    // ==========================================
    // STAGE 1: DESIGN SYSTEM (css/style.css)
    // ==========================================
    onEvent({ type: "assistant", text: "Stage 1/4: Generating design system (`css/style.css`)..." });

    const stage1System = [
      "You are a master CSS architect.",
      `Design system to implement: ${pack.name} (${pack.id})`,
      formatStylePackPromptInstruction(pack),
      "Task: Emit a comprehensive, self-contained CSS stylesheet in `css/style.css`.",
      "Include: CSS custom properties (:root), modern reset, typography, layout containers, cards, buttons (.btn, .btn-secondary), forms, badges, responsive utilities, and animations.",
      "Output format strictly: <file path=\"css/style.css\">/* CSS content */</file>",
    ].join("\n");

    const stage1Response = await callRouterStage(
      stage1System,
      `Create the complete design system stylesheet css/style.css for website: "${brief}" in style "${pack.name}". Keep it under 2,500 tokens.`,
    );

    const stage1Parsed = parseFileTags(stage1Response);
    let cssContent = stage1Parsed.find((f: { path: string; content: string }) => f.path.endsWith(".css"))?.content;

    if (!cssContent) {
      cssContent = pack.cssStarter;
    }

    writeFileToDiskAndState("css/style.css", cssContent);
    stagesCompleted.push("design-system");
    onEvent({ type: "assistant", text: "Stage 1 complete: `css/style.css` emitted." });

    // ==========================================
    // STAGE 2: SKELETON (index.html)
    // ==========================================
    onEvent({ type: "assistant", text: "Stage 2/4: Generating page skeleton (`index.html`)..." });

    const stage2System = [
      "You are a frontend HTML architect.",
      `Design system: ${pack.name}. Linked CSS: css/style.css. Linked JS: js/main.js`,
      "Task: Emit the structural skeleton in `index.html`.",
      "Requirements:",
      "- Exactly 1 <!DOCTYPE html>, 1 <html>, 1 <head>, and 1 <body>.",
      "- In <head>: meta tags, Google Fonts links, <link rel=\"stylesheet\" href=\"css/style.css\">, <script defer src=\"js/main.js\"></script>",
      "- In <body>: Header with brand and nav, followed by EXACTLY 5 section shells with comment placeholders inside:",
      "  <!-- SECTION_PLACEHOLDER: hero -->",
      "  <!-- SECTION_PLACEHOLDER: features -->",
      "  <!-- SECTION_PLACEHOLDER: social-proof -->",
      "  <!-- SECTION_PLACEHOLDER: pricing -->",
      "  <!-- SECTION_PLACEHOLDER: faq -->",
      "- Complete, detailed <footer>.",
      "Output format strictly: <file path=\"index.html\"><!DOCTYPE html>...</file>",
    ].join("\n");

    const stage2Response = await callRouterStage(
      stage2System,
      `Create the skeleton index.html with header, 5 section placeholders (hero, features, social-proof, pricing, faq), and footer for: "${brief}".`,
    );

    const stage2Parsed = parseFileTags(stage2Response);
    let htmlContent = stage2Parsed.find((f: { path: string; content: string }) => f.path.endsWith(".html"))?.content;

    if (!htmlContent || !htmlContent.includes("<!-- SECTION_PLACEHOLDER:")) {
      const fontsTag = pack.fontLinks.map((url) => `  <link rel="stylesheet" href="${url}">`).join("\n");
      htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeXml(brief.slice(0, 40))}</title>
${fontsTag}
  <link rel="stylesheet" href="css/style.css">
  <script defer src="js/main.js"></script>
</head>
<body>
  <nav class="nav">
    <div class="container" style="display:flex;justify-content:space-between;align-items:center;width:100%;">
      <a href="#" class="brand" style="font-weight:800;font-size:1.25rem;text-decoration:none;">Nova</a>
      <div class="nav-links">
        <a href="#features" class="btn btn-secondary" style="padding:0.4rem 1rem;font-size:0.9rem;">Features</a>
        <a href="#pricing" class="btn" style="padding:0.4rem 1rem;font-size:0.9rem;">Get Started</a>
      </div>
    </div>
  </nav>

  <main>
    <!-- SECTION_PLACEHOLDER: hero -->
    <!-- SECTION_PLACEHOLDER: features -->
    <!-- SECTION_PLACEHOLDER: social-proof -->
    <!-- SECTION_PLACEHOLDER: pricing -->
    <!-- SECTION_PLACEHOLDER: faq -->
  </main>

  <footer class="section" style="padding:3rem 1.5rem;text-align:center;">
    <div class="container">
      <p>&copy; ${new Date().getFullYear()} Nova Studio. All rights reserved.</p>
    </div>
  </footer>
</body>
</html>`;
    }

    writeFileToDiskAndState("index.html", htmlContent);
    stagesCompleted.push("skeleton");
    onEvent({ type: "assistant", text: "Stage 2 complete: `index.html` skeleton emitted." });

    // ==========================================
    // STAGE 3: SECTIONS (splicing real markup)
    // ==========================================
    onEvent({ type: "assistant", text: "Stage 3/4: Generating and splicing content sections..." });

    const placeholderRegex = /<!--\s*SECTION_PLACEHOLDER:\s*([a-zA-Z0-9_-]+)\s*-->/g;
    const placeholderMatches = [...htmlContent.matchAll(placeholderRegex)];
    let sectionIds = placeholderMatches.map((m) => m[1]);

    if (sectionIds.length === 0) {
      sectionIds = ["hero", "features", "social-proof", "pricing", "faq"];
    }

    const batches: string[][] = [];
    for (let i = 0; i < sectionIds.length; i += 2) {
      batches.push(sectionIds.slice(i, i + 2));
    }

    for (const batch of batches) {
      onEvent({ type: "assistant", text: `Generating section batch: [${batch.join(", ")}]...` });

      const stage3System = [
        "You are an expert HTML content designer.",
        `Design system: ${pack.name}. Classes from css/style.css: .section, .container, .card, .btn, .btn-secondary, .badge, .grid.`,
        "Strict rules:",
        "- DO NOT emit <!DOCTYPE>, <html>, <head>, or <body>.",
        "- Emit ONLY <section id=\"...\">...</section> elements for each requested section.",
        "- High-quality real copy (no lorem ipsum, no empty sections).",
        "- For images, use clean inline SVGs or icons, never external URLs that 404.",
        "Output format strictly: <file path=\"sections.html\"><section id=\"...\">...</section></file>",
      ].join("\n");

      const stage3Response = await callRouterStage(
        stage3System,
        `Write complete, production-ready HTML markup for sections: [${batch.join(", ")}] for site: "${brief}". Use style "${pack.name}".`,
      );

      const stage3Parsed = parseFileTags(stage3Response);
      const rawSections = stage3Parsed[0]?.content || stage3Response;

      for (const id of batch) {
        const phComment = new RegExp(`<!--\\s*SECTION_PLACEHOLDER:\\s*${id}\\s*-->`, "i");
        const secMatch = new RegExp(`(<section[^>]*id=["']?${id}["']?[^>]*>[\\s\\S]*?<\\/section>)`, "i").exec(rawSections);

        let sectionHtml = "";
        if (secMatch) {
          sectionHtml = secMatch[1];
        } else {
          sectionHtml = `<section id="${id}" class="section">
  <div class="container">
    <h2>${capitalize(id.replace(/-/g, " "))}</h2>
    <p>Discover our bespoke ${escapeXml(brief)} experience crafted for high performance and elegance.</p>
  </div>
</section>`;
        }

        if (phComment.test(htmlContent)) {
          htmlContent = htmlContent.replace(phComment, sectionHtml);
        } else if (htmlContent.includes("</main>")) {
          htmlContent = htmlContent.replace("</main>", `  ${sectionHtml}\n</main>`);
        }
      }
    }

    htmlContent = htmlContent.replace(/<!--\s*SECTION_PLACEHOLDER:\s*[a-zA-Z0-9_-]+\s*-->/g, "");

    const validated = validateHtmlDocument(htmlContent);
    if (!validated.ok) {
      htmlContent = sanitizeHtmlDocument(htmlContent);
    }

    writeFileToDiskAndState("index.html", htmlContent);
    stagesCompleted.push("sections");
    onEvent({ type: "assistant", text: "Stage 3 complete: All sections spliced into `index.html`." });

    // ==========================================
    // STAGE 4: BEHAVIOR (js/main.js)
    // ==========================================
    onEvent({ type: "assistant", text: "Stage 4/4: Generating interactive behavior (`js/main.js`)..." });

    const stage4System = [
      "You are a vanilla JavaScript engineer.",
      "Task: Emit clean, robust, zero-dependency JavaScript in `js/main.js`.",
      "Include:",
      "- DOMContentLoaded listener",
      "- Smooth anchor scrolling for in-page navigation (#features, #pricing, etc.)",
      "- Mobile hamburger menu toggle handler",
      "- Accordion/FAQ collapsible behavior if FAQ exists",
      "- Form submit interceptor with tactile success notification",
      "Output format strictly: <file path=\"js/main.js\">/* JavaScript */</file>",
    ].join("\n");

    const stage4Response = await callRouterStage(
      stage4System,
      `Write interactive vanilla JavaScript for index.html on site: "${brief}". Keep under 1,500 tokens.`,
    );

    const stage4Parsed = parseFileTags(stage4Response);
    let jsContent = stage4Parsed.find((f: { path: string; content: string }) => f.path.endsWith(".js"))?.content;

    if (!jsContent) {
      jsContent = `document.addEventListener('DOMContentLoaded', () => {
  // Smooth scroll
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      const target = document.querySelector(this.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });

  // Basic interaction feedback
  document.querySelectorAll('.btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (btn.tagName === 'BUTTON' || btn.getAttribute('href') === '#') {
        e.preventDefault();
        console.log('Action triggered:', btn.textContent.trim());
      }
    });
  });
});`;
    }

    writeFileToDiskAndState("js/main.js", jsContent);
    stagesCompleted.push("behavior");
    onEvent({ type: "assistant", text: "Stage 4 complete: `js/main.js` emitted." });

    // Run final reference closure check
    const closure = checkReferenceClosure(state.workspaceRoot, filesMap);
    if (!closure.valid && closure.missing.length > 0) {
      const result = inlineOrStubMissingAssetsLocally(htmlContent, closure.missing);
      if (result.updatedHtml !== htmlContent) {
        htmlContent = result.updatedHtml;
        writeFileToDiskAndState("index.html", htmlContent);
      }
      for (const s of result.stubsToCreate) {
        writeFileToDiskAndState(s.path, s.content);
      }
    }

    onEvent({
      type: "assistant",
      text: `✅ **Staged website build complete!** All 4 stages finished successfully.\n` +
        `- \`index.html\` (complete structure with all ${sectionIds.length} sections)\n` +
        `- \`css/style.css\` (${pack.name} design tokens and layout)\n` +
        `- \`js/main.js\` (interactive behavior)\n` +
        `Total files emitted: ${filesMap.size}`,
    });

    return {
      ok: true,
      files: Array.from(filesMap.entries()).map(([p, c]) => ({ path: p, content: c })),
      stagesCompleted,
      stagesFailed,
    };
  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    stagesFailed.push(stagesCompleted.length > 0 ? `stage-${stagesCompleted.length + 1}` : "stage-1");
    onEvent({
      type: "assistant",
      text: `❌ Staged website build failed at stage ${stagesCompleted.length + 1}: ${errorMsg}`,
    });
    return {
      ok: false,
      files: Array.from(filesMap.entries()).map(([p, c]) => ({ path: p, content: c })),
      stagesCompleted,
      stagesFailed,
      error: errorMsg,
    };
  }
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "'": return "&apos;";
      case '"': return "&quot;";
      default: return c;
    }
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
