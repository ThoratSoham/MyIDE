import type { StylePack } from "./types";
import { neoBrutalismPack } from "./neo-brutalism";
import { glassmorphismPack } from "./glassmorphism";
import { minimalEditorialPack } from "./minimal-editorial";
import { darkNeonTechPack } from "./dark-neon-tech";
import { softPastelPlayfulPack } from "./soft-pastel-playful";
import { corporateCleanPack } from "./corporate-clean";
import { retroY2kPack } from "./retro-y2k";

export * from "./types";
export {
  neoBrutalismPack,
  glassmorphismPack,
  minimalEditorialPack,
  darkNeonTechPack,
  softPastelPlayfulPack,
  corporateCleanPack,
  retroY2kPack,
};

export const STYLE_PACKS: StylePack[] = [
  neoBrutalismPack,
  glassmorphismPack,
  minimalEditorialPack,
  darkNeonTechPack,
  softPastelPlayfulPack,
  corporateCleanPack,
  retroY2kPack,
];

/**
 * Detects the best style pack from user prompt keywords, or falls back to defaultStyle.
 * Prefers the most specific (longest) keyword match.
 */
export function detectStylePack(prompt: string, defaultStyle = "minimal-editorial"): StylePack {
  const lower = (prompt ?? "").toLowerCase();

  let bestMatch: { pack: StylePack; len: number } | null = null;
  for (const pack of STYLE_PACKS) {
    for (const kw of pack.keywords) {
      if (lower.includes(kw) && (!bestMatch || kw.length > bestMatch.len)) {
        bestMatch = { pack, len: kw.length };
      }
    }
  }

  if (bestMatch) {
    return bestMatch.pack;
  }

  const fallback = STYLE_PACKS.find((p) => p.id === defaultStyle);
  return fallback ?? minimalEditorialPack;
}

export function getStylePack(id: string): StylePack {
  const match = STYLE_PACKS.find((p) => p.id === id);
  return match ?? minimalEditorialPack;
}

/**
 * Formats a comprehensive style-pack instruction block for LLM prompts.
 */
export function formatStylePackPromptInstruction(pack: StylePack): string {
  const fontLinks = pack.fontLinks.map((url) => `<link rel="stylesheet" href="${url}">`).join("\n");
  const doRules = pack.doRules.map((r) => `- DO: ${r}`).join("\n");
  const dontRules = pack.dontRules.map((r) => `- DON'T: ${r}`).join("\n");
  const checklist = pack.checklist.map((c) => `- [ ] ${c}`).join("\n");

  return [
    `CHOSEN DESIGN SYSTEM: "${pack.name}" (${pack.id}) - ${pack.id.toUpperCase()} STYLE PACK ACTIVE`,
    `Description: ${pack.description}`,
    "",
    "Font links (insert in <head>):",
    fontLinks,
    "",
    "DESIGN RULES:",
    doRules,
    dontRules,
    "",
    "BASE CSS STARTER (extend this in your <style id=\"nova-style-pack\"> or css/style.css):",
    "```css",
    `<style id="nova-style-pack" data-style-pack="${pack.id}">`,
    pack.cssStarter.trim(),
    "</style>",
    "```",
    "",
    "QUALITY CHECKLIST:",
    checklist,
    "",
    "CONTENT QUALITY REQUIREMENTS (enforced across all styles):",
    "- Real, specific copy only (strictly ZERO lorem ipsum, placeholder text, or 'Coming Soon').",
    "- Minimum page sections required: 1) Navigation, 2) High-impact Hero, 3) Features/Offerings, 4) Social Proof/Reviews, 5) Pricing or Clear CTA, 6) FAQ accordion or detail list, 7) Complete Footer.",
    "- Fully responsive at 375px (mobile), 768px (tablet), and 1280px (desktop) with zero horizontal overflow.",
    "- High contrast: text-to-background contrast >= 4.5:1 on every element.",
    "- Accessible: meaningful alt attributes on all images and aria attributes on interactive elements.",
    "- No external image links that can 404: use clean inline SVGs, CSS geometric graphics, or emoji icons.",
  ].join("\n");
}

/**
 * Applies a style pack directly to existing HTML by replacing or upgrading
 * the <style> block and injecting the Google Fonts link, preserving user content.
 */
export function applyStylePackToExistingHtml(existingHtml: string, packOrId: StylePack | string): string {
  const pack = typeof packOrId === "string" ? getStylePack(packOrId) : packOrId;
  let html = existingHtml;

  // 1. Inject font links into <head> if missing
  for (const linkUrl of pack.fontLinks) {
    if (!html.includes(linkUrl)) {
      const linkTag = `<link rel="stylesheet" href="${linkUrl}">`;
      if (/<head(?:\s+[^>]*)?>/i.test(html)) {
        html = html.replace(/<head(?:\s+[^>]*)?>/i, (m) => `${m}\n  ${linkTag}`);
      }
    }
  }

  // 2. Replace or inject <style> block
  const styleBlock = `<style id="nova-style-pack" data-style-pack="${pack.id}">\n${pack.cssStarter.trim()}\n</style>`;
  if (/<style(?:\s+[^>]*)?>[\s\S]*?<\/style>/i.test(html)) {
    html = html.replace(/<style(?:\s+[^>]*)?>[\s\S]*?<\/style>/i, styleBlock);
  } else if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `  ${styleBlock}\n</head>`);
  } else {
    html = `${styleBlock}\n${html}`;
  }

  return html;
}
