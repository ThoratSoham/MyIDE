// FR-7.2: JSON repair. Weak models wrap JSON in prose or fences, leave trailing
// commas, or use smart quotes. Code fixes those before anything touches disk.
import { currentTelemetry } from "../telemetry";

export interface ParseJsonResult {
  ok: boolean;
  value?: any;
  repaired: boolean;
  error?: string;
}

const FENCE = /```(?:json|JSON)?\s*([\s\S]*?)```/;

export function parseJsonLoose(raw: string): ParseJsonResult {
  if (raw == null) return { ok: false, repaired: false, error: "empty response" };

  let text = raw.trim();
  let repaired = false;

  // 0. A reply that is already valid JSON must never be touched. Repair steps
  // below (fence stripping in particular) would mangle a JSON object whose
  // answer field happens to contain a code fence, e.g. {"answer":"```html ..."}.
  try {
    return { ok: true, value: JSON.parse(text), repaired: false };
  } catch {
    /* not plain JSON — fall through to the repairs */
  }

  // 1. Strip code fences.
  const fence = FENCE.exec(text);
  if (fence) {
    text = fence[1].trim();
    repaired = true;
  }

  // 2. Cut prose before the first { or [ and after the matching close.
  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);

  if (start > 0) {
    text = text.slice(start);
    repaired = true;
  }
  if (start !== -1) {
    const open = text[0];
    const close = open === "{" ? "}" : "]";
    const last = text.lastIndexOf(close);
    if (last !== -1 && last < text.length - 1) {
      text = text.slice(0, last + 1);
      repaired = true;
    }
  }

  // 3. Smart quotes -> straight quotes.
  if (/[\u201C\u201D\u2018\u2019]/.test(text)) {
    text = text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
    repaired = true;
  }

  // 4. Trailing commas.
  const withoutTrailing = text.replace(/,\s*([}\]])/g, "$1");
  if (withoutTrailing !== text) {
    text = withoutTrailing;
    repaired = true;
  }

  try {
    const val = JSON.parse(text);
    if (repaired) currentTelemetry()?.recordMalformedJsonRepair();
    return { ok: true, value: val, repaired };
  } catch (e) {
    // 5. Last resort: pull the first balanced object/array.
    const balanced = extractBalanced(text);
    if (balanced) {
      try {
        const val = JSON.parse(balanced);
        currentTelemetry()?.recordMalformedJsonRepair();
        return { ok: true, value: val, repaired: true };
      } catch (e2) {
        currentTelemetry()?.recordMalformedJsonRepair();
        return { ok: false, repaired: true, error: (e2 as Error).message };
      }
    }
    if (repaired) currentTelemetry()?.recordMalformedJsonRepair();
    return { ok: false, repaired, error: (e as Error).message };
  }
}

function extractBalanced(text: string): string | null {
  const openIdx = text.search(/[{\[]/);
  if (openIdx === -1) return null;
  const open = text[openIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return null;
}

// FR-7.4: filler words are rejected. Code checks the copy before assembly.
export const FILLER_PATTERNS = [
  /\blorem\b/i,
  /\bipsum\b/i,
  /\bTODO\b/,
  /your\s+company/i,
  /\bcompany\s+name\b/i,
  /\byour\s+text\s+here\b/i,
  /example\.com/i,
  /click\s+here/i,
  /\bplaceholder\b/i,
];

export function findFiller(text: string): string | null {
  for (const p of FILLER_PATTERNS) {
    const m = p.exec(text);
    if (m) return m[0];
  }
  return null;
}
