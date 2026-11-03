import fs from "fs";
import path from "path";
import crypto from "crypto";
import log from "electron-log";
import type { AIService } from "../ai/service";
import type { Message, TaskClass } from "../ai/types";
import { issuesToText, validateSchema } from "./schema";
import { parseJsonLoose } from "./json-repair";

// FR-7.1: a stage is one small step. Its output is checked against a JSON
// schema, repaired (max 3, with the exact error), and if the models still
// return garbage the library fallback supplies a safe default (FR-7.6).
// Pipelines never use tool calling.

export interface StageSpec<T> {
  id: string;
  taskClass: TaskClass;
  system: string;
  user: string;
  schema: any;
  fallback: () => T;
  expectedOutputTokens?: number;
  // Optional extra semantic check; return an error string to trigger a repair.
  semanticCheck?: (v: any) => string | null;
  maxRepairs?: number;
}

export interface StageOutcome<T> {
  ok: boolean;
  stageId: string;
  value: T;
  source: "model" | "fallback" | "cache";
  repairs: number;
  laneId?: string;
  promptTokens?: number;
  error?: string;
}

export class StageRunner {
  constructor(private ai: AIService, private cacheDir?: string) {}

  private cachePath(spec: StageSpec<any>): string | null {
    if (!this.cacheDir) return null;
    const h = crypto
      .createHash("sha256")
      .update(spec.id)
      .update("|")
      .update(spec.system)
      .update("|")
      .update(spec.user)
      .update("|")
      .update(JSON.stringify(spec.schema))
      .digest("hex")
      .slice(0, 32);
    return path.join(this.cacheDir, `${spec.id.replace(/[^a-z0-9_.-]/gi, "_")}.${h}.json`);
  }

  async run<T>(spec: StageSpec<T>): Promise<StageOutcome<T>> {
    const cacheFile = this.cachePath(spec);
    if (cacheFile && fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        const problems = validateSchema(spec.schema, cached);
        if (problems.length === 0) {
          log.info(`stage ${spec.id}: cache hit`);
          return { ok: true, stageId: spec.id, value: cached as T, source: "cache", repairs: 0 };
        }
      } catch {
        /* fall through to a real request */
      }
    }

    const maxRepairs = spec.maxRepairs ?? 3;
    const schemaNote = `\n\nReturn ONLY minified JSON that matches this JSON Schema (no prose, no code fences):\n${JSON.stringify(spec.schema)}`;

    let messages: Message[] = [
      { role: "system", content: spec.system },
      { role: "user", content: spec.user + schemaNote },
    ];

    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      const res = await this.ai.complete(spec.taskClass, messages, {
        schema: spec.schema,
        expectedOutputTokens: spec.expectedOutputTokens ?? 700,
      });

      if (!res.ok) {
        if (res.pause) {
          log.warn(`stage ${spec.id}: providers paused; using library fallback`);
          break;
        }
        log.warn(`stage ${spec.id}: request failed (${res.error?.kind ?? "unknown"}); using library fallback`);
        break;
      }

      const parsed = parseJsonLoose(res.content ?? "");
      if (!parsed.ok) {
        messages = [
          ...messages,
          { role: "assistant", content: (res.content ?? "").slice(0, 1200) },
          {
            role: "user",
            content: `That was not valid JSON. Error: ${parsed.error}\nReturn ONLY minified JSON matching the schema.`,
          },
        ];
        continue;
      }

      const problems = validateSchema(spec.schema, parsed.value);
      if (problems.length > 0) {
        messages = [
          ...messages,
          { role: "assistant", content: JSON.stringify(parsed.value).slice(0, 1200) },
          {
            role: "user",
            content: `The JSON did not match the schema. Exact problems: ${issuesToText(problems)}. Return ONLY corrected minified JSON.`,
          },
        ];
        continue;
      }

      const semantic = spec.semanticCheck?.(parsed.value);
      if (semantic) {
        messages = [
          ...messages,
          { role: "assistant", content: JSON.stringify(parsed.value).slice(0, 1200) },
          { role: "user", content: `Problem: ${semantic}. Return ONLY corrected minified JSON.` },
        ];
        continue;
      }

      if (cacheFile) {
        try {
          fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
          fs.writeFileSync(cacheFile, JSON.stringify(parsed.value));
        } catch {
          /* cache is best-effort */
        }
      }

      return {
        ok: true,
        stageId: spec.id,
        value: parsed.value as T,
        source: "model",
        repairs: attempt,
        laneId: res.laneUsed?.id,
        promptTokens: res.promptTokens,
      };
    }

    return {
      ok: false,
      stageId: spec.id,
      value: spec.fallback(),
      source: "fallback",
      repairs: maxRepairs,
      error: "model output unusable; library fallback used",
    };
  }
}
