// PART 2: the intent router. Code only — no model call. It reads the user's
// words and picks what to do. If a pipeline does not exist yet the caller falls
// back to the general agent, so an unknown sentence can never fail a run.

import type { DetectedIntent, Intent, JobMode, LastRunState, RunEstimate } from "./electron-api-types";

export type { Intent };

export interface IntentResult extends DetectedIntent {
  intent: Intent;
}

interface Rule {
  intent: Intent;
  words: RegExp;
  reason: string;
}

// Order matters: the first rule that matches wins. "build me a website" is a
// website, not a general agent task, so website is checked before agent.
const RULES: Rule[] = [
  {
    intent: "website",
    words: /\b(website|web site|webpage|web page|landing page|webapp|web app|homepage|home page|portfolio|microsite|one-?pager|site|sales page|marketing page)\b/i,
    reason: "it asks for a web page",
  },
  {
    intent: "video",
    words: /\b(video|mp4|mov file|animation|animated|animate|motion graphic|logo animation|logo video|logo reveal|trailer|reel|gif|after effects|lottie)\b/i,
    reason: "it asks for motion or video",
  },
  {
    intent: "3d",
    words: /\b(3d|three\.?js|threejs|webgl|explainer|explaining video|simulation|simulate|physics demo|interactive 3d|model viewer|gltf|shader)\b/i,
    reason: "it asks for 3D or an explainer scene",
  },
  {
    intent: "agent",
    words: /\b(run|install|uninstall|build|compile|rebuild|fix|debug|error|exception|stack ?trace|failing|terminal|console|command|script|npm|npx|node|python|pip|git|commit|branch|merge|test|tests|refactor|rename|delete|remove file|upgrade|migrate|lint|typecheck|tsc|package\.json|dependency|dependencies|crash|broken|bug)\b/i,
    reason: "it asks for work in the project or the terminal",
  },
  {
    intent: "chat",
    words: /(\?|^\s*(what|why|how|when|where|which|who|can you|could you|would you|is|are|does|do|should|explain|describe|summar|summarize|tell me|help me understand|difference between|compare)\b)/i,
    reason: "it is a question",
  },
];

export const INTENT_LABELS: Record<Intent, string> = {
  website: "Website",
  video: "Video",
  "3d": "3D",
  agent: "Agent",
  chat: "Chat only",
};

export function routeIntent(raw: string, lastRun?: LastRunState): IntentResult {
  const text = (raw ?? "").trim();
  if (!text) {
    return detected("chat", "low", [], "nothing was typed");
  }

  // PHASE 6: Stateful follow-up intent resolution
  if (lastRun) {
    const isResume = /^\s*(continue|resume|go on|proceed|keep going|retry)\s*$/i.test(text);
    if (isResume) {
      return detected(
        lastRun.intent,
        "high",
        ["resume-follow-up"],
        `resuming previous ${lastRun.intent} run`,
      );
    }

    const isFix = /^\s*(fix it|fix this|fix errors?|why did it fail|fix visual issues?|repair)\s*$/i.test(text);
    if (isFix) {
      return detected(
        lastRun.intent,
        "high",
        ["fix-follow-up"],
        `fixing issues from previous ${lastRun.intent} run`,
      );
    }

    if (lastRun.intent === "website") {
      const isWebsiteEdit =
        /^\s*(?:make it (?:darker|lighter|better|cleaner|pop)|apply (?:neo|glass|editorial|dark|neon|pastel|corporate|y2k)|restyle|redesign|add (?:a |an )?(?:pricing|hero|features?|faq|contact|menu|footer|about) section|change (?:the )?(?:color|theme|font|style))\b/i.test(
          text,
        );
      if (isWebsiteEdit) {
        return detected(
          "website",
          "high",
          ["website-edit-follow-up"],
          "incremental website edit/restyle",
        );
      }
    }
  }

  // PHASE 6: Engineering prompt paste protection
  // If prompt is large (>1500 chars) AND contains structured engineering tokens,
  // route to agent (general coding), NEVER auto-route to website just because keywords like "site" or "page" appear.
  if (text.length > 1500) {
    const hasEngineeringStructure =
      /\b(GOAL|PHASE|ROOT CAUSE|TypeScript|Electron|IPC|test:unit|typecheck|pull request|git commit|refactor|safeStorage|contextIsolation)\b/i.test(
        text,
      );
    if (hasEngineeringStructure) {
      return detected(
        "agent",
        "high",
        ["engineering-prompt-paste"],
        "large structured engineering prompt detected; routing to codebase agent",
      );
    }
  }

  for (const rule of RULES) {
    const m = text.match(rule.words);
    if (m) return detected(rule.intent, "high", [m[0].toLowerCase()], rule.reason);
  }

  return detected(
    "agent",
    "low",
    [],
    "it is not obviously a website, a video, 3D or a plain question, so the general agent handles it",
  );
}

function detected(intent: Intent, confidence: "high" | "low", matched: string[], reason: string): IntentResult {
  return { intent, confidence, matched, reason, label: INTENT_LABELS[intent] };
}

// Only the website pipeline exists today. Everything else runs on the general
// agent, which is what PART 2 asks for ("do not fail").
export function pipelineFor(intent: Intent): "website" | "agent" {
  return intent === "website" ? "website" : "agent";
}

export interface IntentOption {
  value: "auto" | Intent;
  label: string;
}

export const INTENT_OPTIONS: IntentOption[] = [
  { value: "auto", label: "Auto" },
  { value: "website", label: "Website" },
  { value: "video", label: "Video" },
  { value: "3d", label: "3D" },
  { value: "agent", label: "Agent" },
  { value: "chat", label: "Chat only" },
];

// PART 2 point 6: mode + a code-built estimate of how many model requests a run
// is likely to need. Fast = 1 critic round, Balanced = 2, Best = 3.
const WEBSITE_STAGE_CALLS = 6;
const CRITIC_ROUNDS: Record<JobMode, number> = { fast: 1, balanced: 2, best: 3 };

export function estimateRun(intent: Intent, mode: JobMode): RunEstimate {
  const rounds = CRITIC_ROUNDS[mode];
  if (intent === "website") {
    const requests = WEBSITE_STAGE_CALLS + rounds * 2;
    return { mode, requests, note: `${WEBSITE_STAGE_CALLS} build steps + ${rounds} check round(s)` };
  }
  if (intent === "chat") {
    return { mode, requests: 1, note: "one answer, no tools" };
  }
  // Agent / video / 3D run on the agent loop: a plan plus a handful of steps.
  const requests = rounds === 1 ? 6 : rounds === 2 ? 10 : 14;
  return { mode, requests, note: `${requests} agent steps at most (${rounds} check round(s))` };
}

// PART 2 point 4: one short question with buttons when the text is unclear.
export const CLARIFY_OPTIONS = [
  { kind: "answer" as const, label: "Website", value: "website" },
  { kind: "answer" as const, label: "Video", value: "video" },
  { kind: "answer" as const, label: "3D", value: "3d" },
  { kind: "answer" as const, label: "Just answer me", value: "chat" },
];
