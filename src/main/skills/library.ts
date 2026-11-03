import fs from "fs";
import path from "path";
import { app } from "electron";
import log from "electron-log";

// FR-8: skill packs are the library. This is where the intelligence lives, not
// in the model. Each pack has a skill.json plus tokens/templates/recipes, and
// the loader checks every pack at start-up, reporting anything wrong so the
// Logs panel can show it (FR-8.1).

export interface Palette {
  id: string;
  name: string;
  mode: "light" | "dark";
  colors: Record<string, string>;
}

export interface FontPair {
  id: string;
  name: string;
  heading: string;
  body: string;
  headingStack: string;
  bodyStack: string;
  googleUrl?: string;
}

export interface SectionTemplate {
  id: string;
  type: string;
  variant: string;
  html: string;
}

export interface MotionRecipe {
  id: string;
  name: string;
  css: string;
  js: string;
  reducedMotionSafe: boolean;
  noJsFallback: boolean;
}

export interface WebCorePack {
  palettes: Palette[];
  fontPairs: FontPair[];
  spacingSteps: number[];
  typeScale: { base: number; ratio: number };
  radius: Record<string, string>;
  shadow: Record<string, string>;
  sections: SectionTemplate[];
  baseCss: string;
}

export interface SkillPackInfo {
  id: string;
  name: string;
  version: string;
  dir: string;
  ok: boolean;
  problems: string[];
}

export interface Library {
  webCore: WebCorePack;
  motion: MotionRecipe[];
  packs: SkillPackInfo[];
}

export function skillsRoot(): string {
  const candidates = [
    path.join(app.getAppPath(), "resources", "skills"),
    path.join(process.resourcesPath ?? "", "skills"),
    path.join(__dirname, "..", "..", "..", "resources", "skills"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function readJson<T>(file: string, problems: string[]): T | null {
  if (!fs.existsSync(file)) {
    problems.push(`missing file: ${path.basename(file)}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e) {
    problems.push(`bad JSON in ${path.basename(file)}: ${(e as Error).message}`);
    return null;
  }
}

const EMPTY_WEB_CORE: WebCorePack = {
  palettes: [],
  fontPairs: [],
  spacingSteps: [4, 8, 12, 16, 24, 32, 48, 64],
  typeScale: { base: 16, ratio: 1.25 },
  radius: { sm: "6px", md: "10px", lg: "16px" },
  shadow: { sm: "0 1px 2px rgba(0,0,0,0.12)", md: "0 8px 24px rgba(0,0,0,0.18)" },
  sections: [],
  baseCss: "",
};

// FR-8.2 / FR-8.3: the known slots the loader validates against. Anything else
// is reported as an unknown slot.
const KNOWN_SECTION_TYPES = new Set([
  "navbar", "hero", "logostrip", "features", "stats", "process", "services",
  "pricing", "testimonials", "team", "gallery", "faq", "cta", "contact", "footer",
]);

export function loadLibrary(): Library {
  const root = skillsRoot();
  const packs: SkillPackInfo[] = [];
  const webCore: WebCorePack = { ...EMPTY_WEB_CORE };
  let motion: MotionRecipe[] = [];

  if (!fs.existsSync(root)) {
    log.warn(`library: skills folder not found at ${root}`);
    return { webCore, motion, packs };
  }

  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const id of dirs) {
    const dir = path.join(root, id);
    const problems: string[] = [];
    const skill = readJson<{ id: string; name: string; version: string; slots?: string[] }>(
      path.join(dir, "skill.json"),
      problems,
    );

    if (skill) {
      if (skill.id !== id) problems.push(`skill.json id "${skill.id}" does not match folder "${id}"`);
      for (const slot of skill.slots ?? []) {
        if (!["palette", "fontPair", "scale", "section", "motion", "scene", "topo", "video"].includes(slot)) {
          problems.push(`unknown slot: ${slot}`);
        }
      }

      if (id === "web-core") {
        const tokens = readJson<any>(path.join(dir, "tokens.json"), problems);
        if (tokens) {
          webCore.palettes = tokens.palettes ?? [];
          webCore.fontPairs = tokens.fontPairs ?? [];
          webCore.spacingSteps = tokens.spacingSteps ?? webCore.spacingSteps;
          webCore.typeScale = tokens.typeScale ?? webCore.typeScale;
          webCore.radius = tokens.radius ?? webCore.radius;
          webCore.shadow = tokens.shadow ?? webCore.shadow;
          if (!webCore.palettes.length) problems.push("no palettes found in tokens.json");
          if (!webCore.fontPairs.length) problems.push("no font pairs found in tokens.json");
        }
        const sections = readJson<{ sections: SectionTemplate[] }>(path.join(dir, "sections.json"), problems);
        if (sections) {
          webCore.sections = (sections.sections ?? []).map((s) => {
            if (!KNOWN_SECTION_TYPES.has(s.type)) problems.push(`unknown section type: ${s.type}`);
            return s;
          });
          const byType = new Map<string, number>();
          for (const s of webCore.sections) byType.set(s.type, (byType.get(s.type) ?? 0) + 1);
          for (const t of KNOWN_SECTION_TYPES) {
            if (!byType.has(t)) problems.push(`no template for section type: ${t}`);
          }
        }
        if (!fs.existsSync(path.join(dir, "rubric.md"))) problems.push("missing file: rubric.md");

        const baseCssFile = path.join(dir, "base.css");
        if (fs.existsSync(baseCssFile)) {
          webCore.baseCss = fs.readFileSync(baseCssFile, "utf8");
        } else {
          problems.push("missing file: base.css");
        }
      }

      if (id === "web-motion") {
        const recipes = readJson<{ recipes: MotionRecipe[] }>(path.join(dir, "recipes.json"), problems);
        if (recipes) {
          motion = recipes.recipes ?? [];
          for (const r of motion) {
            if (!r.reducedMotionSafe) problems.push(`recipe ${r.id} does not respect reduced motion`);
          }
        }
      }
    }

    const ok = problems.length === 0;
    if (!ok) for (const p of problems) log.warn(`library: [${id}] ${p}`);
    packs.push({ id, name: skill?.name ?? id, version: skill?.version ?? "?", dir, ok, problems });
  }

  log.info(
    `library: ${packs.length} pack(s), ${webCore.palettes.length} palettes, ${webCore.fontPairs.length} font pairs, ${webCore.sections.length} section templates, ${motion.length} motion recipes`,
  );

  return { webCore, motion, packs };
}

// ---------------------------------------------------------------------------
// Template rendering. Code assembles files from templates + tokens + recipes
// (FR-7.5). No model ever writes raw HTML or CSS (FR-10.1).
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Build the flat token map the templates and base.css substitute against.
export function buildTokens(pack: WebCorePack, palette: Palette, font: FontPair): Record<string, string> {
  const t: Record<string, string> = {};
  for (const [k, v] of Object.entries(palette.colors)) t[`color.${k}`] = v;
  t["font.heading"] = font.headingStack;
  t["font.body"] = font.bodyStack;
  for (const [k, v] of Object.entries(pack.radius)) t[`radius.${k}`] = v;
  for (const [k, v] of Object.entries(pack.shadow)) t[`shadow.${k}`] = v;
  pack.spacingSteps.forEach((s, i) => {
    t[`space.${i + 1}`] = `${s}px`;
  });

  const base = pack.typeScale.base;
  const r = pack.typeScale.ratio;
  t["type.h1"] = `${round(base * Math.pow(r, 4))}px`;
  t["type.h2"] = `${round(base * Math.pow(r, 3))}px`;
  t["type.h3"] = `${round(base * Math.pow(r, 2))}px`;
  t["type.h4"] = `${round(base * r)}px`;
  t["type.body"] = `${base}px`;
  t["type.lead"] = `${round(base * 1.125)}px`;
  t["type.small"] = `${round(base * 0.875)}px`;
  return t;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// CSS is not HTML-escaped (font stacks contain quotes and commas).
export function renderCss(tpl: string, tokens: Record<string, string>): string {
  return tpl.replace(/\{\{token\.([a-zA-Z0-9_.]+)\}\}/g, (_m, k: string) => tokens[k] ?? "");
}

export interface RenderContext {
  tokens: Record<string, string>;
  content: Record<string, any>;
}

// {{#items}} ... {{/items}} expands a list; nested loops are supported so a
// pricing card can loop its own feature bullets. Scalars are substituted after
// the loops collapse. All content values are escaped (FR-7.5).
function expandLoops(html: string, ctx: RenderContext): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf("{{#", i);
    if (open === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, open);
    const keyEnd = html.indexOf("}}", open);
    if (keyEnd === -1) {
      out += html.slice(open);
      break;
    }
    const key = html.slice(open + 3, keyEnd).trim();

    // Find the matching close tag, counting nested loops of the same key.
    let depth = 1;
    let cursor = keyEnd + 2;
    let closeStart = -1;
    let closeEnd = -1;
    while (depth > 0) {
      const nextOpen = html.indexOf(`{{#${key}}}`, cursor);
      const nextClose = html.indexOf(`{{/${key}}}`, cursor);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        cursor = nextOpen + key.length + 5;
      } else {
        depth--;
        if (depth === 0) {
          closeStart = nextClose;
          closeEnd = nextClose + key.length + 5;
        } else {
          cursor = nextClose + key.length + 5;
        }
      }
    }

    if (closeStart === -1) {
      out += html.slice(open);
      break;
    }

    const body = html.slice(keyEnd + 2, closeStart);
    const list = ctx.content[key];
    if (Array.isArray(list)) {
      for (const item of list) {
        out += renderTemplate(body, {
          tokens: ctx.tokens,
          content: typeof item === "object" && item ? item : { value: item },
        });
      }
    } else if (list && typeof list === "object") {
      out += renderTemplate(body, { tokens: ctx.tokens, content: list });
    }
    i = closeEnd;
  }
  return out;
}

export function renderTemplate(html: string, ctx: RenderContext): string {
  const looped = expandLoops(html, ctx);
  return looped.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_m, key: string) => {
    const value = key.startsWith("token.") ? ctx.tokens[key.slice(6)] : ctx.content[key];
    if (value == null) return "";
    return escapeHtml(String(value));
  });
}
