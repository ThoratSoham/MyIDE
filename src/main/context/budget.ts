import type { Message } from "../ai/types";
import { estimateInputTokens } from "../ai/tokenize";

// PHASE 4D: Prompt-Cache Stability & Priority-Ordered Pre-Send Lane Budget Fitter.
//
// Invariants:
// 1. `messages[0]` (the static system prompt) is NEVER mutated across turns or lanes so
//    provider prefix prompt caches (Gemini / Anthropic / OpenRouter) remain 100% warm.
// 2. When fitting into a lane's input token budget (e.g. Groq free ~5,500 request cap),
//    context blocks are shed strictly in reverse-priority order:
//      Priority 1 (highest, never dropped): system prompt (messages[0])
//      Priority 2: working memory (`[Working Memory]`)
//      Priority 3: user task (messages[1])
//      Priority 4: recent turns + progress ledger
//      Priority 5: workspace repo map (`[Workspace Repo Map]`)
//      Priority 6 (lowest, dropped/shrunk first): retrieved BM25 chunks (`[Retrieved Context]`)

export interface AssemblePromptInputs {
  baseMessages: Message[]; // [system, userTask, optional workingMemory, ...turns]
  repoMapBlock?: string;
  retrievedContextBlock?: string;
  progressLedgerBlock?: string;
  maxInputTokens?: number;
}

function classifyMessagePriority(msg: Message, index: number): number {
  if (index === 0 && msg.role === "system") return 1;
  const text = msg.content.trimStart();
  if (text.startsWith("[Working Memory]")) return 2;
  if (index === 1) return 3;
  if (text.startsWith("[Workspace Repo Map]")) return 5;
  if (text.startsWith("[Retrieved Context]")) return 6;
  return 4; // recent turns & progress ledger
}

function clipTextToTokenBudget(text: string, allowedTokens: number): string {
  if (allowedTokens <= 30) return "";
  const est = estimateInputTokens(text);
  if (est <= allowedTokens) return text;
  const approxChars = Math.max(80, Math.floor(allowedTokens * 3.2));
  if (approxChars >= text.length) return text;
  return `${text.slice(0, approxChars)}\n...[trimmed to fit lane token budget]`;
}

/**
 * Assembles dynamic context blocks AFTER `messages[0]` (static system prompt) and `messages[1]` (user task),
 * preserving `messages[0]` byte-for-byte.
 */
export function assembleTurnMessages(inputs: AssemblePromptInputs): Message[] {
  if (inputs.baseMessages.length === 0) return [];

  const out: Message[] = [];
  // Keep messages[0] strictly untouched!
  out.push(inputs.baseMessages[0]);

  if (inputs.baseMessages.length >= 2) {
    out.push(inputs.baseMessages[1]);
  }

  // Insert Repo Map + Retrieved Context + Progress Ledger right after the user task
  // so recent tool turns stay contiguous at the tail.
  if (inputs.repoMapBlock && inputs.repoMapBlock.trim()) {
    out.push({ role: "user", content: inputs.repoMapBlock });
  }
  if (inputs.retrievedContextBlock && inputs.retrievedContextBlock.trim()) {
    out.push({ role: "user", content: inputs.retrievedContextBlock });
  }
  if (inputs.progressLedgerBlock && inputs.progressLedgerBlock.trim()) {
    out.push({ role: "user", content: `[System progress ledger]\n${inputs.progressLedgerBlock}` });
  }

  for (let i = 2; i < inputs.baseMessages.length; i++) {
    out.push(inputs.baseMessages[i]);
  }

  if (inputs.maxInputTokens && inputs.maxInputTokens > 0) {
    return fitMessagesToLaneBudget(out, inputs.maxInputTokens);
  }
  return out;
}

/**
 * Fits an assembled `Message[]` array into `maxInputTokens` (excluding `expectedOutputTokens`)
 * without ever mutating `messages[0]`. Drops/trims Priority 6 (`[Retrieved Context]`) first,
 * then Priority 5 (`[Workspace Repo Map]`), then older Priority 4 turns.
 */
export function fitMessagesToLaneBudget(messages: Message[], maxInputTokens: number): Message[] {
  if (messages.length === 0 || maxInputTokens <= 0) return messages;

  const totalTokens = (list: Message[]) =>
    estimateInputTokens(list.map((m) => m.content).join("\n"));

  if (totalTokens(messages) <= maxInputTokens) {
    return messages;
  }

  const working: Array<{ msg: Message; priority: number; originalIndex: number }> = messages.map(
    (msg, idx) => ({
      msg: idx === 0 ? msg : { ...msg }, // messages[0] reference kept 100% immutable
      priority: classifyMessagePriority(msg, idx),
      originalIndex: idx,
    }),
  );

  // Pass 1: Drop or trim Priority 6 ([Retrieved Context]), then Priority 5 ([Workspace Repo Map])
  for (const targetPriority of [6, 5]) {
    for (let i = working.length - 1; i >= 0; i--) {
      if (working[i].priority !== targetPriority) continue;
      const currentTotal = totalTokens(working.map((w) => w.msg));
      if (currentTotal <= maxInputTokens) break;

      const excess = currentTotal - maxInputTokens;
      const itemTokens = estimateInputTokens(working[i].msg.content);
      if (itemTokens - excess >= 140) {
        working[i].msg = {
          role: working[i].msg.role,
          content: clipTextToTokenBudget(working[i].msg.content, itemTokens - excess - 20),
        };
      } else {
        working.splice(i, 1);
      }
    }
  }

  // Pass 2: Drop oldest Priority 4 messages (preserving the very last message so turn alternation / latest tool output stays intact)
  while (totalTokens(working.map((w) => w.msg)) > maxInputTokens) {
    const droppableIdx = working.findIndex(
      (w, idx) => w.priority === 4 && idx < working.length - 1,
    );
    if (droppableIdx === -1) break;
    working.splice(droppableIdx, 1);
  }

  // Pass 3: If latest Priority 4 message is still slightly over budget, trim it while keeping messages[0] untouched
  const afterDropTotal = totalTokens(working.map((w) => w.msg));
  if (afterDropTotal > maxInputTokens) {
    const lastIdx = working.length - 1;
    if (lastIdx > 0 && working[lastIdx].priority >= 3) {
      const itemTok = estimateInputTokens(working[lastIdx].msg.content);
      const excess = afterDropTotal - maxInputTokens;
      if (itemTok - excess >= 100) {
        working[lastIdx].msg = {
          role: working[lastIdx].msg.role,
          content: clipTextToTokenBudget(working[lastIdx].msg.content, itemTok - excess - 15),
        };
      }
    }
  }

  return working.map((w) => w.msg);
}
