import fs from "fs";
import path from "path";
import crypto from "crypto";
import log from "electron-log";
import type { AIService } from "../ai/service";
import {
  buildTokens,
  escapeHtml,
  renderCss,
  renderTemplate,
  type FontPair,
  type Library,
  type Palette,
  type SectionTemplate,
} from "../skills/library";
import { StageRunner } from "./stage-runner";
import { verifyWebsite, type VerifyReport } from "./verifier";
import { criticReview, mergeFixes, scoreReport, type CriticFix } from "./critic";

// FR-7.3: the website pipeline is a fixed list of small stages with code checks
// in between:
//   S0 intake -> S1 style vote -> S2 sitemap -> S3 copy per section ->
//   S4 motion pick -> S5 assemble (code) -> S6 verify (code) ->
//   S7 critic + ratchet -> S8 polish (code) -> S9 report
// No stage uses tool calling and no model ever writes HTML or CSS (FR-7.5).

export type SiteMode = "fast" | "balanced" | "best";

export interface Intake {
  brand: string;
  tagline: string;
  industry: string;
  audience: string;
  goal: string;
  offer: string;
  tone: string;
  ctaPrimary: string;
  ctaSecondary: string;
  contactEmail: string;
  contactPhone: string;
  address: string;
  nav: { label: string; href: string }[];
  keywords: string[];
  facts: string[];
}

export interface SectionSpec {
  type: string;
  variant: string;
}

export interface SitePlan {
  slug: string;
  title: string;
  description: string;
  paletteId: string;
  fontPairId: string;
  sections: SectionSpec[];
  motion: Record<string, string>;
  content: Record<string, Record<string, any>>;
}

export interface StageEvent {
  stage: string;
  label: string;
  status: "start" | "done" | "skip" | "fail";
  detail?: string;
  model?: string;
}

export interface BuildInput {
  brief: string;
  mode: SiteMode;
  outDir: string;
  workspaceRoot: string;
  verifyDir: string;
  cacheDir?: string;
  onEvent?: (e: StageEvent) => void;
  signal?: { cancelled: boolean };
}

export interface RoundLog {
  round: number;
  fixes: number;
  score: number;
  kept: boolean;
}

export interface BuildResult {
  ok: boolean;
  plan: SitePlan;
  files: string[];
  report: VerifyReport;
  score: number;
  rounds: RoundLog[];
  notes: string[];
}

// The safe motion subset the pipeline hands to the model. The other recipes
// (sticky-scrub, cursor-glow, page-intro) expect extra structure and are used
// only by the dedicated scroll packs, not by a generic site build.
const SAFE_RECIPES = ["fade-up", "stagger", "count-up", "text-reveal", "parallax", "gradient-blob", "marquee"];

const DEFAULT_MOTION: Record<string, string> = {
  navbar: "fade-up",
  hero: "fade-up",
  logostrip: "marquee",
  features: "stagger",
  stats: "stagger",
  process: "stagger",
  services: "stagger",
  pricing: "stagger",
  testimonials: "fade-up",
  team: "stagger",
  gallery: "stagger",
  faq: "fade-up",
  cta: "fade-up",
  contact: "fade-up",
  footer: "fade-up",
};

const CORE_SECTIONS = ["navbar", "hero", "features", "stats", "cta", "contact", "footer"];
const FULL_SECTIONS = [
  "navbar",
  "hero",
  "logostrip",
  "features",
  "stats",
  "process",
  "services",
  "testimonials",
  "gallery",
  "faq",
  "cta",
  "contact",
  "footer",
];

const maxRoundsFor = (mode: SiteMode) => (mode === "fast" ? 1 : mode === "balanced" ? 2 : 3);

export async function buildWebsite(ai: AIService, lib: Library, input: BuildInput): Promise<BuildResult> {
  const notes: string[] = [];
  const rounds: RoundLog[] = [];
  const emit = (e: StageEvent) => {
    input.onEvent?.(e);
    if (e.status === "fail") log.warn(`[site] ${e.stage} ${e.label}: ${e.detail ?? ""}`);
  };

  if (!lib.webCore.palettes.length || !lib.webCore.sections.length) {
    throw new Error("the web-core skill pack is missing or empty; check resources/skills");
  }

  const runner = new StageRunner(ai, input.cacheDir);

  // ---- S0 intake -----------------------------------------------------------
  emit({ stage: "S0", label: "Understanding the brief", status: "start" });
  const intakeSpec = buildIntakeSpec(input.brief);
  const intakeOut = await runner.run<Intake>(intakeSpec);
  const intake = normalizeIntake(intakeOut.value, input.brief);
  emit({
    stage: "S0",
    label: "Understanding the brief",
    status: intakeOut.source === "model" ? "done" : "skip",
    detail: `${intake.brand} · ${intake.industry}`,
    model: intakeOut.laneId,
  });
  if (intakeOut.source !== "model") notes.push("S0 intake used the library default (no usable model answer)");

  const slug = slugify(intake.brand);

  // ---- S1 style vote -------------------------------------------------------
  emit({ stage: "S1", label: "Choosing a style", status: "start" });
  const styleSpec = buildStyleSpec(lib, intake, input.brief);
  const styleOut = await runner.run<{ paletteId: string; fontPairId: string; why?: string }>(styleSpec);
  const palette =
    lib.webCore.palettes.find((p) => p.id === styleOut.value.paletteId) ??
    pickPalette(lib, input.brief);
  const font =
    lib.webCore.fontPairs.find((f) => f.id === styleOut.value.fontPairId) ??
    lib.webCore.fontPairs[0];
  emit({
    stage: "S1",
    label: "Choosing a style",
    status: styleOut.source === "model" ? "done" : "skip",
    detail: `${palette.name} · ${font.name}`,
    model: styleOut.laneId,
  });
  if (styleOut.source !== "model") notes.push("S1 style vote used a library palette (no usable model answer)");

  // ---- S2 sitemap ----------------------------------------------------------
  emit({ stage: "S2", label: "Planning the sections", status: "start" });
  const allowedTypes = input.mode === "fast" ? CORE_SECTIONS : FULL_SECTIONS;
  const sitemapSpec = buildSitemapSpec(lib, intake, allowedTypes);
  const sitemapOut = await runner.run<{ sections: SectionSpec[] }>(sitemapSpec);
  const sections = normalizeSections(sitemapOut.value.sections, lib, allowedTypes);
  emit({
    stage: "S2",
    label: "Planning the sections",
    status: sitemapOut.source === "model" ? "done" : "skip",
    detail: sections.map((s) => s.type).join(" → "),
    model: sitemapOut.laneId,
  });
  if (sitemapOut.source !== "model") notes.push("S2 sitemap used the library default order");

  // ---- S3 copy per section -------------------------------------------------
  const content: Record<string, Record<string, any>> = {};
  for (const spec of sections) {
    if (input.signal?.cancelled) break;
    const tpl = findTemplate(lib, spec.type, spec.variant);
    if (!tpl) continue;
    const shape = describeTemplate(tpl.html);
    emit({ stage: "S3", label: `Writing copy: ${spec.type}`, status: "start" });
    const copySpec = buildCopySpec(spec, tpl, shape, intake, lib);
    const out = await runner.run<Record<string, any>>(copySpec);
    content[spec.type] = out.value;
    emit({
      stage: "S3",
      label: `Writing copy: ${spec.type}`,
      status: out.source === "model" ? "done" : "skip",
      detail: out.source === "model" ? "model" : "library default",
      model: out.laneId,
    });
  }

  // ---- S4 motion pick ------------------------------------------------------
  emit({ stage: "S4", label: "Choosing motion", status: "start" });
  const motionSpec = buildMotionSpec(lib, sections, intake);
  const motionOut = await runner.run<{ assignments: Record<string, string> }>(motionSpec);
  const motion = normalizeMotion(motionOut.value.assignments, sections);
  emit({
    stage: "S4",
    label: "Choosing motion",
    status: motionOut.source === "model" ? "done" : "skip",
    detail: Object.entries(motion).map(([k, v]) => `${k}:${v}`).join(", "),
    model: motionOut.laneId,
  });

  let plan: SitePlan = {
    slug,
    title: `${intake.brand} — ${intake.tagline}`.slice(0, 70),
    description: intake.offer.slice(0, 160),
    paletteId: palette.id,
    fontPairId: font.id,
    sections,
    motion,
    content,
  };

  // ---- S5 assemble (code) --------------------------------------------------
  emit({ stage: "S5", label: "Assembling the files", status: "start" });
  let assembled = assembleSite(plan, lib, input);
  emit({ stage: "S5", label: "Assembling the files", status: "done", detail: assembled.files.join(", ") });

  // ---- S6 verify (code) ----------------------------------------------------
  emit({ stage: "S6", label: "Verifying the page", status: "start" });
  let report = await verifyWebsite({
    pagePath: assembled.indexPath,
    workspaceRoot: input.workspaceRoot,
    outDir: input.verifyDir,
  });
  let score = scoreReport(report);
  emit({
    stage: "S6",
    label: "Verifying the page",
    status: report.ok ? "done" : "fail",
    detail: `${report.issues.filter((i) => i.severity === "error").length} error(s), score ${score}`,
  });

  // ---- S7 critic + ratchet -------------------------------------------------
  const best = { plan, assembled, report, score };
  const allPaletteIds = lib.webCore.palettes.map((p) => p.id);
  const allFontIds = lib.webCore.fontPairs.map((f) => f.id);
  const variantsByType = variantsMap(lib);
  const recipeIds = lib.motion.filter((r) => SAFE_RECIPES.includes(r.id)).map((r) => r.id);

  const criticLists: CriticFix[][] = [];
  const roundsToRun = maxRoundsFor(input.mode);
  for (let round = 1; round <= roundsToRun; round++) {
    if (input.signal?.cancelled) break;
    emit({ stage: "S7", label: `Critic round ${round}`, status: "start" });
    const crit = await criticReview(runner, ai, {
      brief: input.brief,
      paletteIds: allPaletteIds,
      fontPairIds: allFontIds,
      sectionTypes: best.plan.sections.map((s) => s.type),
      recipeIds,
      variantsByType,
      summary: summarizePlan(best.plan, lib),
      verifierSummary: report.issues
        .slice(0, 12)
        .map((i) => `${i.severity}: ${i.id} ${i.selector ?? ""} — ${i.message}`)
        .join("\n"),
    });
    criticLists.push(crit.fixes);

    if (!crit.fixes.length) {
      emit({ stage: "S7", label: `Critic round ${round}`, status: "skip", detail: "no fixes suggested" });
      rounds.push({ round, fixes: 0, score: best.score, kept: false });
      break;
    }

    const merged = mergeFixes(criticLists);
    const candidatePlan = applyFixes(best.plan, merged, lib, variantsByType, allPaletteIds, recipeIds);
    const candidateAssembled = assembleSite(candidatePlan, lib, input);
    const candidateReport = await verifyWebsite({
      pagePath: candidateAssembled.indexPath,
      workspaceRoot: input.workspaceRoot,
      outDir: path.join(input.verifyDir, `round-${round}`),
    });
    const candidateScore = scoreReport(candidateReport);

    // FR-10.3: keep the change only if the score goes up and errors do not.
    const errsBefore = best.report.issues.filter((i) => i.severity === "error").length;
    const errsAfter = candidateReport.issues.filter((i) => i.severity === "error").length;
    const keep = candidateScore > best.score && errsAfter <= errsBefore;

    rounds.push({ round, fixes: merged.length, score: candidateScore, kept: keep });
    if (keep) {
      best.plan = candidatePlan;
      best.assembled = candidateAssembled;
      best.report = candidateReport;
      best.score = candidateScore;
      emit({ stage: "S7", label: `Critic round ${round}`, status: "done", detail: `kept, score ${candidateScore}` });
    } else {
      // Revert the files on disk to the best build.
      assembled = assembleSite(best.plan, lib, input);
      emit({ stage: "S7", label: `Critic round ${round}`, status: "skip", detail: `reverted (${candidateScore} <= ${best.score})` });
    }
  }

  plan = best.plan;
  report = best.report;
  score = best.score;
  assembled = assembleSite(plan, lib, input); // guarantee disk matches the best plan

  // ---- S8 polish (code) ----------------------------------------------------
  emit({ stage: "S8", label: "Final polish", status: "done", detail: "title, meta, skip link, favicon" });

  // ---- S9 report -----------------------------------------------------------
  const result: BuildResult = {
    ok: report.ok,
    plan,
    files: assembled.files,
    report,
    score,
    rounds,
    notes,
  };
  try {
    fs.writeFileSync(
      path.join(input.outDir, "build-report.json"),
      JSON.stringify(
        {
          brand: intake.brand,
          score,
          ok: report.ok,
          rounds,
          notes,
          issues: report.issues,
          sections: plan.sections,
          palette: plan.paletteId,
          font: plan.fontPairId,
          motion: plan.motion,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    log.warn("site: could not write build-report.json", e);
  }
  emit({ stage: "S9", label: "Build report", status: "done", detail: `score ${score}` });

  return result;
}

// ---------------------------------------------------------------------------
// Stage specs
// ---------------------------------------------------------------------------

function buildIntakeSpec(brief: string) {
  const schema = {
    type: "object",
    required: [
      "brand",
      "tagline",
      "industry",
      "audience",
      "goal",
      "offer",
      "tone",
      "ctaPrimary",
      "ctaSecondary",
      "nav",
      "keywords",
      "facts",
    ],
    properties: {
      brand: { type: "string", minLength: 2, maxLength: 40 },
      tagline: { type: "string", minLength: 4, maxLength: 80 },
      industry: { type: "string", minLength: 2, maxLength: 40 },
      audience: { type: "string", minLength: 2, maxLength: 80 },
      goal: { type: "string", minLength: 2, maxLength: 80 },
      offer: { type: "string", minLength: 6, maxLength: 200 },
      tone: { type: "string", minLength: 3, maxLength: 40 },
      ctaPrimary: { type: "string", minLength: 2, maxLength: 30 },
      ctaSecondary: { type: "string", minLength: 2, maxLength: 30 },
      contactEmail: { type: "string" },
      contactPhone: { type: "string" },
      address: { type: "string" },
      nav: {
        type: "array",
        minItems: 3,
        maxItems: 6,
        items: {
          type: "object",
          required: ["label", "href"],
          properties: { label: { type: "string" }, href: { type: "string" } },
        },
      },
      keywords: { type: "array", minItems: 3, maxItems: 8, items: { type: "string" } },
      facts: { type: "array", minItems: 3, maxItems: 6, items: { type: "string", minLength: 12 } },
    },
  };

  return {
    id: "site.intake",
    taskClass: "general" as const,
    system:
      "You turn a short website brief into a precise, factual brief sheet. Never invent awards, " +
      "numbers or testimonials that the user did not imply. Keep every value short. " +
      "Never use placeholder words (lorem, ipsum, todo, example.com, 'click here', 'your company').",
    user: `Brief:\n${brief}\n\nReturn the brief sheet as JSON.`,
    schema,
    expectedOutputTokens: 500,
    fallback: () => fallbackIntake(brief),
  };
}

function buildStyleSpec(lib: Library, intake: Intake, brief: string) {
  const schema = {
    type: "object",
    required: ["paletteId", "fontPairId"],
    properties: {
      paletteId: { type: "string", enum: lib.webCore.palettes.map((p) => p.id) },
      fontPairId: { type: "string", enum: lib.webCore.fontPairs.map((f) => f.id) },
      why: { type: "string" },
    },
  };
  const paletteList = lib.webCore.palettes
    .map((p) => `${p.id} (${p.mode}, ${p.name}): bg ${p.colors.bg}, accent ${p.colors.accent}`)
    .join("\n");
  const fontList = lib.webCore.fontPairs.map((f) => `${f.id}: ${f.name}`).join("\n");

  return {
    id: "site.style",
    taskClass: "general" as const,
    system:
      "You are a senior art director. Pick exactly one palette id and one font pair id from the " +
      "lists provided. Prefer high contrast and a mood that fits the brief.",
    user: [
      `Brief: ${brief}`,
      `Brand: ${intake.brand} — ${intake.tagline}`,
      `Audience: ${intake.audience}. Tone: ${intake.tone}.`,
      "",
      "Palettes:",
      paletteList,
      "",
      "Font pairs:",
      fontList,
    ].join("\n"),
    schema,
    expectedOutputTokens: 120,
    fallback: () => ({ paletteId: pickPalette(lib, brief).id, fontPairId: lib.webCore.fontPairs[0].id }),
  };
}

function buildSitemapSpec(lib: Library, intake: Intake, allowedTypes: string[]) {
  const schema = {
    type: "object",
    required: ["sections"],
    properties: {
      sections: {
        type: "array",
        minItems: 4,
        maxItems: 12,
        items: {
          type: "object",
          required: ["type", "variant"],
          properties: {
            type: { type: "string", enum: allowedTypes },
            variant: { type: "string", enum: ["A", "B"] },
          },
        },
      },
    },
  };
  const available = allowedTypes
    .map((t) => {
      const vs = lib.webCore.sections.filter((s) => s.type === t).map((s) => s.variant);
      return `${t}: variants ${vs.join("/") || "(none)"}`;
    })
    .join("\n");

  return {
    id: "site.sitemap",
    taskClass: "general" as const,
    system:
      "You plan the section order of a one-page website. Start with navbar and hero, end with " +
      "contact and footer. Use each content section at most once. Do not invent new types.",
    user: [
      `Brief: ${intake.offer}`,
      `Audience: ${intake.audience}. Goal: ${intake.goal}.`,
      "",
      "Allowed section types and their variants:",
      available,
    ].join("\n"),
    schema,
    expectedOutputTokens: 300,
    fallback: () => ({ sections: allowedTypes.map((t) => ({ type: t, variant: "A" })) }),
  };
}

interface Shape {
  scalars: string[];
  lists: { key: string; shape: Shape }[];
}

function buildCopySpec(
  spec: SectionSpec,
  tpl: SectionTemplate,
  shape: Shape,
  intake: Intake,
  lib: Library,
) {
  const schema = schemaForShape(shape);
  const fields = [
    shape.scalars.length ? `text fields: ${shape.scalars.join(", ")}` : "",
    ...shape.lists.map((l) => `list "${l.key}" with items having: ${describeShape(l.shape)}`),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    id: `site.copy.${spec.type}`,
    taskClass: "general" as const,
    system:
      "You write short, specific marketing copy for exactly one website section. " +
      "No placeholder words (lorem, ipsum, todo, example.com, 'click here', 'your company'). " +
      "Be concrete: name the offer, the audience and a real benefit. Keep headlines under 70 characters.",
    user: [
      `Brand: ${intake.brand} — ${intake.tagline}`,
      `Industry: ${intake.industry}. Audience: ${intake.audience}. Tone: ${intake.tone}.`,
      `Goal: ${intake.goal}. Offer: ${intake.offer}`,
      `Primary call to action: "${intake.ctaPrimary}". Secondary: "${intake.ctaSecondary}".`,
      `Contact: ${intake.contactEmail} / ${intake.contactPhone} / ${intake.address}`,
      `Facts: ${intake.facts.join(" | ")}`,
      "",
      `Section type: ${spec.type} (variant ${spec.variant}).`,
      fields,
      "",
      "Return JSON with exactly these keys.",
    ].join("\n"),
    schema,
    expectedOutputTokens: 500,
    semanticCheck: (v: any) => {
      const words = JSON.stringify(v).toLowerCase();
      for (const bad of ["lorem", "ipsum", "todo", "your company", "example.com", "click here"]) {
        if (words.includes(bad)) return `placeholder word "${bad}" is not allowed`;
      }
      return null;
    },
    fallback: () => fallbackContent(spec.type, shape, intake),
  };
}

function buildMotionSpec(lib: Library, sections: SectionSpec[], intake: Intake) {
  const schema = {
    type: "object",
    required: ["assignments"],
    properties: {
      assignments: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          sections.map((s) => [s.type, { type: "string", enum: SAFE_RECIPES }]),
        ),
      },
    },
  };
  const recipeList = lib.motion
    .filter((r) => SAFE_RECIPES.includes(r.id))
    .map((r) => `${r.id}: ${r.name}`)
    .join("\n");

  return {
    id: "site.motion",
    taskClass: "general" as const,
    system:
      "You pick one scroll-motion recipe for each section. Prefer subtle recipes: fade-up and " +
      "stagger for most sections, count-up for statistics, marquee for a logo strip, and at most " +
      "one dramatic recipe per page. Never hide content.",
    user: [
      `Tone: ${intake.tone}. Goal: ${intake.goal}.`,
      `Sections: ${sections.map((s) => s.type).join(", ")}`,
      "",
      "Recipes:",
      recipeList,
    ].join("\n"),
    schema,
    expectedOutputTokens: 200,
    fallback: () => ({
      assignments: Object.fromEntries(sections.map((s) => [s.type, DEFAULT_MOTION[s.type] ?? "fade-up"])),
    }),
  };
}

// ---------------------------------------------------------------------------
// Template introspection — derive the content contract from the template itself
// so the "checklist" always matches what the template will consume.
// ---------------------------------------------------------------------------

export function describeTemplate(html: string): Shape {
  const { scalars, lists } = describeRegion(html);
  return { scalars, lists };
}

function describeRegion(html: string): { scalars: string[]; lists: { key: string; shape: Shape }[] } {
  const scalars: string[] = [];
  const lists: { key: string; shape: Shape }[] = [];
  let top = "";
  let i = 0;

  while (i < html.length) {
    const open = html.indexOf("{{#", i);
    if (open === -1) {
      top += html.slice(i);
      break;
    }
    top += html.slice(i, open);
    const keyEnd = html.indexOf("}}", open);
    if (keyEnd === -1) {
      top += html.slice(open);
      break;
    }
    const key = html.slice(open + 3, keyEnd).trim();

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
      top += html.slice(open);
      break;
    }
    const body = html.slice(keyEnd + 2, closeStart);
    lists.push({ key, shape: describeRegion(body) });
    i = closeEnd;
  }

  for (const m of top.matchAll(/\{\{([a-zA-Z0-9_.]+)\}\}/g)) {
    const name = m[1];
    if (name.startsWith("token.")) continue;
    if (!scalars.includes(name)) scalars.push(name);
  }
  return { scalars, lists };
}

function describeShape(shape: Shape): string {
  const parts = [...shape.scalars];
  for (const l of shape.lists) parts.push(`${l.key}[${describeShape(l.shape)}]`);
  return parts.join(", ");
}

function schemaForShape(shape: Shape): any {
  const properties: Record<string, any> = {};
  for (const s of shape.scalars) properties[s] = { type: "string", minLength: 1, maxLength: 240 };
  for (const l of shape.lists) {
    properties[l.key] = {
      type: "array",
      minItems: 2,
      maxItems: 6,
      items: schemaForShape(l.shape),
    };
  }
  return {
    type: "object",
    required: [...shape.scalars, ...shape.lists.map((l) => l.key)],
    properties,
  };
}

// ---------------------------------------------------------------------------
// Fallbacks (FR-7.6): with garbage from every model the pipeline must still
// output a page that passes the verifier.
// ---------------------------------------------------------------------------

function fallbackIntake(brief: string): Intake {
  const clean = brief.replace(/\s+/g, " ").trim();
  const m = /(?:for|about|of)\s+(?:a|an|the)?\s*([a-z][a-z0-9 &'-]{2,40})/i.exec(clean);
  const industryRaw = (m?.[1] ?? "professional services").replace(/[.,;:!?].*$/, "").trim();
  const industry = titleCase(industryRaw.split(" ").slice(0, 3).join(" ")) || "Professional Services";
  const brandPool = ["Studio", "Collective", "Group", "Works"];
  const brand = `${titleCase(industryRaw.split(" ")[0] ?? "Northwind")} ${brandPool[hash(clean) % brandPool.length]}`;
  const audience = `people looking for ${industryRaw.toLowerCase()}`;
  const offer = clean.length > 20 ? clean.slice(0, 180) : `Reliable ${industryRaw.toLowerCase()} for the people who need it most`;

  return {
    brand,
    tagline: `${industry} done properly`,
    industry,
    audience,
    goal: "win trust and enquiries",
    offer,
    tone: "clear, warm, professional",
    ctaPrimary: "Start an enquiry",
    ctaSecondary: "See how it works",
    contactEmail: `hello@${slugify(brand)}.test`,
    contactPhone: "+1 555 0100",
    address: "1 Market Street, Suite 100",
    nav: [
      { label: "Services", href: "#services" },
      { label: "About", href: "#main" },
      { label: "Contact", href: "#contact" },
    ],
    keywords: industryRaw.split(" ").slice(0, 5),
    facts: [
      `We focus entirely on ${industryRaw.toLowerCase()} so nothing is generic.`,
      `Every engagement starts with a short, honest conversation about what you actually need.`,
      `We measure success by the enquiries and repeat clients we earn for you.`,
    ],
  };
}

function fallbackContent(type: string, shape: Shape, intake: Intake, index = 0): Record<string, any> {
  const out: Record<string, any> = {};
  for (const s of shape.scalars) out[s] = defaultScalar(type, s, intake, index);
  for (const l of shape.lists) {
    const n = l.key === "columns" ? 3 : 4;
    out[l.key] = Array.from({ length: n }, (_, idx) => fallbackContent(type, l.shape, intake, idx));
  }
  return out;
}

function defaultScalar(type: string, name: string, intake: Intake, index = 0): string {
  const kw = intake.keywords[index % Math.max(1, intake.keywords.length)] ?? intake.industry;
  switch (name) {
    case "brand":
      return intake.brand;
    case "tagline":
      return intake.tagline;
    case "eyebrow":
      return sectionEyebrow(type);
    case "heading":
      return sectionHeading(type, intake);
    case "sub":
    case "body":
      return sectionSub(type, intake);
    case "ctaHref":
      return "#contact";
    case "ctaLabel":
      return intake.ctaPrimary;
    case "secondaryHref":
      return "#main";
    case "secondaryLabel":
      return intake.ctaSecondary;
    case "imageAlt":
    case "alt":
      return `${intake.brand} — ${kw}`;
    case "email":
      return intake.contactEmail;
    case "phone":
      return intake.contactPhone;
    case "address":
      return intake.address;
    case "copyright":
      return `© ${new Date().getFullYear()} ${intake.brand}. All rights reserved.`;
    case "value":
      return ["98%", "12k+", "4.9", "24h"][index % 4];
    case "label":
      return ["Client retention", "Jobs completed", "Average rating", "Response time"][index % 4];
    case "title":
      return itemTitle(type, index, intake);
    case "text":
      return itemText(type, index, intake);
    case "name":
      return ["Ama Osei", "Daniel Reid", "Priya Nair", "Tom Whittle"][index % 4];
    case "role":
      return ["Founder", "Operations lead", "Client partner", "Head of delivery"][index % 4];
    case "quote":
      return `${intake.brand} understood what we needed on the first call and delivered it without fuss.`;
    case "q":
      return faqQ(index, intake);
    case "a":
      return faqA(index, intake);
    case "price":
      return ["$490", "$990", "Let's talk"][index % 3];
    case "period":
      return ["per project", "per month", "custom scope"][index % 3];
    case "formTitle":
      return "Tell us what you need";
    case "formNote":
      return "We reply within one working day and never share your details.";
    default:
      return `${titleCase(name)} for ${intake.brand}`;
  }
}

function sectionEyebrow(type: string): string {
  const map: Record<string, string> = {
    features: "What you get",
    stats: "By the numbers",
    process: "How it works",
    services: "Services",
    pricing: "Pricing",
    testimonials: "Clients",
    team: "The team",
    gallery: "Recent work",
    faq: "Questions",
    cta: "Next step",
    contact: "Contact",
    logostrip: "Trusted by",
  };
  return map[type] ?? type.toUpperCase();
}

function sectionHeading(type: string, intake: Intake): string {
  const map: Record<string, string> = {
    hero: intake.offer.split(/[.!?]/)[0].slice(0, 70) || `${intake.industry} that works`,
    features: `Everything you need to ${intake.goal}`,
    stats: `Numbers that show the difference`,
    process: `A simple, honest process`,
    services: `What we do for ${intake.audience}`,
    pricing: `Straightforward pricing`,
    testimonials: `What clients say`,
    team: `The people behind the work`,
    gallery: `Selected work`,
    faq: `Questions people ask us`,
    cta: `Ready to ${intake.goal}?`,
    contact: `Let's talk about your project`,
    logostrip: `Trusted by teams like yours`,
  };
  return map[type] ?? `${type} at ${intake.brand}`;
}

function sectionSub(type: string, intake: Intake): string {
  const base = `${intake.brand} helps ${intake.audience} ${intake.goal} with ${intake.offer.toLowerCase()}`;
  const extra =
    type === "cta"
      ? " Tell us what you need and we will reply with a clear plan and a fair price."
      : type === "contact"
      ? " Send a short note and we will come back with next steps and a realistic timeline."
      : "";
  return base + "." + extra;
}

function itemTitle(type: string, index: number, intake: Intake): string {
  const kw = intake.keywords[index % Math.max(1, intake.keywords.length)] ?? intake.industry;
  const map: Record<string, string[]> = {
    features: [`${titleCase(kw)} that fits`, "No wasted time", "Clear pricing", "Support that answers", "Built to last", "Easy to start"],
    services: [`${titleCase(kw)} support`, "Planning and advice", "Delivery and follow-up", "Ongoing care"],
    process: ["Talk it through", "Get a plan", "We deliver", "We stay in touch"],
    pricing: ["Starter", "Standard", "Custom"],
  };
  const list = map[type] ?? [`${titleCase(kw)}`];
  return list[index % list.length];
}

function itemText(type: string, index: number, intake: Intake): string {
  return `We handle the details so you can focus on your work, and we keep you updated at every stage of the ${intake.industry.toLowerCase()} project.`;
}

function faqQ(index: number, intake: Intake): string {
  const list = [
    `How quickly can ${intake.brand} start?`,
    "What does it cost?",
    "Do you work with small teams?",
    "How do we get updates?",
  ];
  return list[index % list.length];
}

function faqA(_index: number, intake: Intake): string {
  return `${intake.brand} usually starts within a week of the first call, and we agree a fixed scope and price before any work begins so there are no surprises.`;
}

// ---------------------------------------------------------------------------
// Normalisation + validation of model answers
// ---------------------------------------------------------------------------

function normalizeIntake(raw: any, brief: string): Intake {
  const fb = fallbackIntake(brief);
  const str = (v: any, d: string) => (typeof v === "string" && v.trim() ? v.trim() : d);
  const nav = Array.isArray(raw?.nav) && raw.nav.length
    ? raw.nav
        .filter((n: any) => n && typeof n.label === "string")
        .slice(0, 6)
        .map((n: any) => ({ label: n.label, href: typeof n.href === "string" ? n.href : "#main" }))
    : fb.nav;
  return {
    brand: str(raw?.brand, fb.brand),
    tagline: str(raw?.tagline, fb.tagline),
    industry: str(raw?.industry, fb.industry),
    audience: str(raw?.audience, fb.audience),
    goal: str(raw?.goal, fb.goal),
    offer: str(raw?.offer, fb.offer),
    tone: str(raw?.tone, fb.tone),
    ctaPrimary: str(raw?.ctaPrimary, fb.ctaPrimary),
    ctaSecondary: str(raw?.ctaSecondary, fb.ctaSecondary),
    contactEmail: str(raw?.contactEmail, fb.contactEmail),
    contactPhone: str(raw?.contactPhone, fb.contactPhone),
    address: str(raw?.address, fb.address),
    nav,
    keywords: Array.isArray(raw?.keywords) && raw.keywords.length ? raw.keywords.slice(0, 8) : fb.keywords,
    facts: Array.isArray(raw?.facts) && raw.facts.length ? raw.facts.slice(0, 6) : fb.facts,
  };
}

function normalizeSections(
  raw: any,
  lib: Library,
  allowedTypes: string[],
): SectionSpec[] {
  const valid: SectionSpec[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const s of raw) {
      if (!s || typeof s.type !== "string") continue;
      if (!allowedTypes.includes(s.type) || seen.has(s.type)) continue;
      const tpl = findTemplate(lib, s.type, typeof s.variant === "string" ? s.variant : "A");
      if (!tpl) continue;
      seen.add(s.type);
      valid.push({ type: s.type, variant: tpl.variant });
    }
  }
  // Always guarantee the essential frame.
  const ensure = (type: string, first: boolean) => {
    if (seen.has(type)) return;
    const tpl = findTemplate(lib, type, "A");
    if (!tpl) return;
    seen.add(type);
    if (first) valid.unshift({ type, variant: tpl.variant });
    else valid.push({ type, variant: tpl.variant });
  };
  if (!seen.has("navbar")) ensure("navbar", true);
  if (!seen.has("hero")) {
    const idx = valid.findIndex((s) => s.type !== "navbar");
    const tpl = findTemplate(lib, "hero", "A");
    if (tpl) {
      seen.add("hero");
      valid.splice(idx === -1 ? valid.length : idx, 0, { type: "hero", variant: tpl.variant });
    }
  }
  ensure("contact", false);
  ensure("footer", false);

  if (valid.length < 4) {
    for (const t of allowedTypes) {
      if (valid.length >= 6) break;
      ensure(t, false);
    }
  }
  return valid;
}

function normalizeMotion(raw: any, sections: SectionSpec[]): Record<string, string> {
  const motion: Record<string, string> = {};
  for (const s of sections) {
    const pick = raw && typeof raw[s.type] === "string" && SAFE_RECIPES.includes(raw[s.type])
      ? raw[s.type]
      : DEFAULT_MOTION[s.type] ?? "fade-up";
    motion[s.type] = pick;
  }
  return motion;
}

// ---------------------------------------------------------------------------
// Apply critic fixes (FR-10.1 allowed changes only)
// ---------------------------------------------------------------------------

function applyFixes(
  plan: SitePlan,
  fixes: CriticFix[],
  lib: Library,
  variantsByType: Record<string, string[]>,
  paletteIds: string[],
  recipeIds: string[],
): SitePlan {
  const next: SitePlan = {
    ...plan,
    sections: plan.sections.map((s) => ({ ...s })),
    motion: { ...plan.motion },
    content: JSON.parse(JSON.stringify(plan.content)),
  };

  for (const fix of fixes) {
    switch (fix.kind) {
      case "swap-palette":
        if (fix.paletteId && paletteIds.includes(fix.paletteId)) next.paletteId = fix.paletteId;
        break;
      case "swap-variant":
        if (fix.sectionType && fix.variant) {
          const sec = next.sections.find((s) => s.type === fix.sectionType);
          const allowed = variantsByType[fix.sectionType] ?? [];
          if (sec && allowed.includes(fix.variant)) sec.variant = fix.variant;
        }
        break;
      case "change-copy":
        if (fix.sectionType && fix.content && typeof fix.content === "object") {
          next.content[fix.sectionType] = { ...(next.content[fix.sectionType] ?? {}), ...fix.content };
        }
        break;
      case "add-recipe":
        if (fix.sectionType && fix.recipeId && recipeIds.includes(fix.recipeId)) {
          next.motion[fix.sectionType] = fix.recipeId;
        }
        break;
      case "remove-recipe":
        if (fix.sectionType) delete next.motion[fix.sectionType];
        break;
      case "reorder-sections":
        if (Array.isArray(fix.order) && fix.order.length) {
          const byType = new Map(next.sections.map((s) => [s.type, s]));
          const reordered: SectionSpec[] = [];
          for (const t of fix.order) {
            const s = byType.get(t);
            if (s) {
              reordered.push(s);
              byType.delete(t);
            }
          }
          for (const s of byType.values()) reordered.push(s);
          if (reordered.length === next.sections.length) next.sections = reordered;
        }
        break;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Assembly (code only)
// ---------------------------------------------------------------------------

interface Assembled {
  files: string[];
  indexPath: string;
  html: string;
}

function assembleSite(plan: SitePlan, lib: Library, input: BuildInput): Assembled {
  const palette =
    lib.webCore.palettes.find((p) => p.id === plan.paletteId) ?? lib.webCore.palettes[0];
  const font = lib.webCore.fontPairs.find((f) => f.id === plan.fontPairId) ?? lib.webCore.fontPairs[0];
  const tokens = buildTokens(lib.webCore, palette, font);

  const usedRecipes = new Set<string>();
  const bodyParts: string[] = [];

  for (const spec of plan.sections) {
    const tpl = findTemplate(lib, spec.type, spec.variant);
    if (!tpl) continue;
    let html = renderTemplate(tpl.html, { tokens, content: plan.content[spec.type] ?? {} });
    const recipe = plan.motion[spec.type];
    if (recipe && lib.motion.some((r) => r.id === recipe)) {
      usedRecipes.add(recipe);
      html = injectRootRecipe(html, recipe);
    }
    bodyParts.push(html);
  }

  const css = [
    "/* Generated by MyIDE from the web-core skill pack. Do not edit by hand. */",
    renderCss(lib.webCore.baseCss, tokens),
    ...[...usedRecipes]
      .map((id) => lib.motion.find((r) => r.id === id))
      .filter(Boolean)
      .map((r) => `/* motion: ${r!.id} */\n${r!.css}`),
  ].join("\n");

  const motionJs = [
    "/* Generated by MyIDE from the web-motion skill pack. Content stays visible without JS. */",
    ...[...usedRecipes]
      .map((id) => lib.motion.find((r) => r.id === id))
      .filter(Boolean)
      .map((r) => r!.js),
    REVEAL_SAFETY_NET,
  ].join("\n");

  const html = buildHtml(plan, font, bodyParts.join("\n"));

  fs.mkdirSync(input.outDir, { recursive: true });
  const indexPath = path.join(input.outDir, "index.html");
  const cssPath = path.join(input.outDir, "styles.css");
  const jsPath = path.join(input.outDir, "motion.js");

  writeAtomic(indexPath, html);
  writeAtomic(cssPath, css);
  writeAtomic(jsPath, motionJs);

  return { files: [indexPath, cssPath, jsPath].map((p) => path.basename(p)), indexPath, html };
}

function buildHtml(plan: SitePlan, font: FontPair, body: string): string {
  const title = escapeHtml(plan.title);
  const desc = escapeHtml(plan.description);
  const favicon =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23111'/%3E%3C/svg%3E";
  const fontNote = font.googleUrl ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${favicon}">
${fontNote}
<link rel="stylesheet" href="styles.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
${body}
<script src="motion.js" defer></script>
</body>
</html>
`;
}

function injectRootRecipe(html: string, recipe: string): string {
  // Add the recipe to the section's root element only; inner template recipes
  // (for example the stat count-up) are allowed to stay.
  return html.replace(/^(\s*<[a-zA-Z][^>]*?)(\s*>)/, `$1 data-recipe="${recipe}"$2`);
}

const REVEAL_SAFETY_NET = `/* Safety net: whatever the observer missed, reveal as it enters the viewport.
   This guarantees content is never left invisible (FR-5.6, section 12). */
(function () {
  function reveal() {
    var els = document.querySelectorAll('[data-recipe]');
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) els[i].classList.add('is-in');
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reveal);
  } else {
    reveal();
  }
  window.addEventListener('scroll', function () { window.requestAnimationFrame(reveal); }, { passive: true });
  window.addEventListener('resize', reveal);
  setTimeout(reveal, 400);
})();`;

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

function summarizePlan(plan: SitePlan, lib: Library): string {
  const palette = lib.webCore.palettes.find((p) => p.id === plan.paletteId);
  const font = lib.webCore.fontPairs.find((f) => f.id === plan.fontPairId);
  const lines = [
    `Title: ${plan.title}`,
    `Palette: ${plan.paletteId} (${palette?.mode ?? "?"})`,
    `Font pair: ${plan.fontPairId} (${font?.name ?? "?"})`,
    "Sections:",
  ];
  for (const s of plan.sections) {
    const c = plan.content[s.type] ?? {};
    const head = c.heading ?? c.title ?? c.name ?? "";
    lines.push(`- ${s.type} / ${s.variant} / motion ${plan.motion[s.type] ?? "none"}: ${String(head).slice(0, 80)}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function findTemplate(lib: Library, type: string, variant: string): SectionTemplate | undefined {
  return (
    lib.webCore.sections.find((s) => s.type === type && s.variant === variant) ??
    lib.webCore.sections.find((s) => s.type === type)
  );
}

function variantsMap(lib: Library): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const s of lib.webCore.sections) {
    map[s.type] = map[s.type] ?? [];
    if (!map[s.type].includes(s.variant)) map[s.type].push(s.variant);
  }
  return map;
}

function pickPalette(lib: Library, brief: string): Palette {
  const dark = /dark|night|bold|tech|premium|sleek|modern/i.test(brief);
  const pool = lib.webCore.palettes.filter((p) => (dark ? p.mode === "dark" : true));
  const list = pool.length ? pool : lib.webCore.palettes;
  return list[hash(brief) % list.length];
}

function hash(s: string): number {
  return parseInt(crypto.createHash("sha1").update(s).digest("hex").slice(0, 8), 16);
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "site"
  );
}

function titleCase(s: string): string {
  return s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}
