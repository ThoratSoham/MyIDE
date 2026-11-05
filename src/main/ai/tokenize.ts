// FR-2.6: size-aware routing. Estimate tokens from prompt characters.
// Heuristic: characters / 3.5 (a common rough token:char ratio for English)
// plus an output budget. We prefer over-estimating for quota safety, so we
// add a small output token buffer and round up.

const CHAR_TO_TOKEN = 3.5;
const OUTPUT_BUFFER_TOKENS = 512;

export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / CHAR_TO_TOKEN);
}

export function estimateTokens(prompt: string, expectedOutputTokens = 256): number {
  const inputTokens = Math.ceil(prompt.length / CHAR_TO_TOKEN);
  return inputTokens + Math.max(expectedOutputTokens, OUTPUT_BUFFER_TOKENS);
}

// For Groq (FR-2.6): never send more than 5,500 tokens to Groq. If the
// estimate is over that, we return a scaled-down target and the caller must
// trim the prompt or route to another lane. We do NOT silently send it.
export function groqTokenBudget(
  estimatedTokens: number,
  cap = 5500,
): { usable: boolean; targetTokens: number; shrinkRatio: number } {
  if (estimatedTokens <= cap) {
    return { usable: true, targetTokens: estimatedTokens, shrinkRatio: 1 };
  }
  // Requested too big for Groq. Do not send. Tell the router to skip Groq
  // for this request only (FR-3 / FR-2.6).
  return { usable: false, targetTokens: cap, shrinkRatio: cap / estimatedTokens };
}

export function shrinkPromptToTokens(
  prompt: string,
  targetTokens: number,
): { text: string; actualTokens: number } {
  // First attempt: trim to roughly the target. After shrinking we re-estimate
  // and, if still over the Groq cap, treat as a lane skip for this request
  // (not a retry loop).
  const chars = Math.floor(targetTokens * CHAR_TO_TOKEN);
  const text = prompt.length > chars ? prompt.slice(0, chars) : prompt;
  return { text, actualTokens: estimateTokens(text) };
}
