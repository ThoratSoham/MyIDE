import log from "electron-log";
import type { AIService } from "../ai/service";
import type { VerifyReport } from "./verifier";
import type { StageRunner } from "./stage-runner";

// FR-10: the critic scores the rubric (1 to 10) and returns at most 5 fixes.
// Allowed changes only: swap palette, swap variant, change copy, add/remove
// recipe, reorder sections. The model NEVER writes raw HTML or CSS (FR-10.1).
//
// FR-10.3: the ratchet needs a *deterministic* score so it can decide whether a
// fix helped. That score comes from the code verifier report, not from a model,
// so it also works when every model returns garbage (the dumb-model test).

export const RUBRIC_ITEMS = [
  "visual hierarchy",
  "spacing and rhythm",
  "colour and contrast",
  "typography",
  "icons and imagery",
  "motion quality",
  "content quality (specific, no filler)",
  "responsiveness",
  "consistency",
  "overall polish",
];

export type CriticFixKind =
  | "swap-palette"
  | "swap-variant"
  | "change-copy"
  | "add-recipe"
  | "remove-recipe"
  | "reorder-sections";

export interface CriticFix {
  kind: CriticFixKind;
  reason: string;
  sectionType?: string;
  paletteId?: string;
  variant?: string;
  recipeId?: string;
  order?: string[];
  content?: Record<string, unknown>;
}

export interface CriticResult {
  score: number; // rubric score, 1..10 as judged by the model
  fixes: CriticFix[];
}

/**
 * Deterministic score (0..10) derived purely from the code verifier report.
 * This is the number the ratchet compares between rounds (FR-10.3).
 */
export function scoreReport(report: VerifyReport): number {
  if (!report.verified) return 0;
  const errors = report.issues.filter((i) => i.severity === "error").length;
  const warnings = report.issues.filter((i) => i.severity === "warning").length;
  let score = 10;
  score -= Math.min(errors, 20) * 0.7;
  score -= Math.min(warnings, 20) * 0.12;
  if (report.textLength < 900) score -= 0.4;
  return Math.max(0, Math.min(10, Math.round(score * 100) / 100));
}

const FIX_SCHEMA = {
  type: "object",
  required: ["score", "fixes"],
  properties: {
    score: { type: "number", minimum: 1, maximum: 10 },
    fixes: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        required: ["kind", "reason"],
        properties: {
          kind: {
            type: "string",
            enum: [
              "swap-palette",
              "swap-variant",
              "change-copy",
              "add-recipe",
              "remove-recipe",
              "reorder-sections",
            ],
          },
          reason: { type: "string", minLength: 4 },
          sectionType: { type: "string" },
          paletteId: { type: "string" },
          variant: { type: "string" },
          recipeId: { type: "string" },
          order: { type: "array", items: { type: "string" } },
          content: { type: "object" },
        },
      },
    },
  },
};

export interface CriticInput {
  brief: string;
  paletteIds: string[];
  fontPairIds: string[];
  sectionTypes: string[];
  recipeIds: string[];
  variantsByType: Record<string, string[]>;
  summary: string; // a compact, text description of the current build
  verifierSummary: string; // the verifier issues, as text
}

/**
 * Ask a model to judge the current build and propose safe fixes. Uses the stage
 * runner so a garbage answer degrades to "no fixes" instead of breaking a run.
 */
export async function criticReview(
  runner: StageRunner,
  ai: AIService,
  input: CriticInput,
): Promise<CriticResult> {
  const system =
    "You are a senior web design critic. You score a generated website against a rubric and " +
    "propose a SMALL number of safe, high-impact changes. You never write HTML or CSS. " +
    `Score each of these 0-10 and report one overall score: ${RUBRIC_ITEMS.join(", ")}.`;

  const user = [
    `Brief: ${input.brief}`,
    "",
    "Current build:",
    input.summary,
    "",
    "What the code verifier found:",
    input.verifierSummary || "(no issues found)",
    "",
    `Allowed palettes: ${input.paletteIds.join(", ")}`,
    `Allowed font pairs: ${input.fontPairIds.join(", ")}`,
    `Current sections (in order): ${input.sectionTypes.join(", ")}`,
    `Allowed section variants: ${JSON.stringify(input.variantsByType)}`,
    `Allowed motion recipes: ${input.recipeIds.join(", ")}`,
    "",
    "Return JSON with a score (1-10) and at most 5 fixes. Each fix has a kind and a short reason.",
    "Use only the ids listed above. Prefer change-copy and swap-variant for weak sections.",
  ].join("\n");

  const out = await runner.run<CriticResult>({
    id: "critic",
    taskClass: "reasoning",
    system,
    user,
    schema: FIX_SCHEMA,
    expectedOutputTokens: 600,
    maxRepairs: 1,
    fallback: () => ({ score: 0, fixes: [] }),
  });

  if (out.source !== "model") {
    log.warn(`critic: no usable critique (${out.source}); skipping this round`);
    return { score: 0, fixes: [] };
  }

  const fixes = (out.value.fixes ?? []).slice(0, 5).filter((f) => !!f && !!f.kind);
  return { score: clamp(out.value.score ?? 0), fixes };
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

// FR-10.4: merge fix lists from several critics, ranking by agreement then by
// how severe the fix kind is. Kept simple: identical (kind, sectionType) fixes
// count as agreement, and the first occurrence keeps its payload.
const FIX_WEIGHT: Record<CriticFixKind, number> = {
  "swap-palette": 5,
  "reorder-sections": 4,
  "swap-variant": 3,
  "change-copy": 2,
  "add-recipe": 1,
  "remove-recipe": 1,
};

export function mergeFixes(lists: CriticFix[][], max = 5): CriticFix[] {
  const groups = new Map<string, { fix: CriticFix; votes: number }>();
  for (const list of lists) {
    for (const fix of list) {
      const key = `${fix.kind}:${fix.sectionType ?? "-"}`;
      const g = groups.get(key);
      if (g) g.votes += 1;
      else groups.set(key, { fix, votes: 1 });
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.votes - a.votes || FIX_WEIGHT[b.fix.kind] - FIX_WEIGHT[a.fix.kind])
    .slice(0, max)
    .map((g) => g.fix);
}
