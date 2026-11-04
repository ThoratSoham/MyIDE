import type { Settings as SharedSettings } from "../../shared/electron-api-types";

// One source of truth: the renderer, the preload bridge and the main process all
// use the shared Settings shape. This file only supplies the defaults.
export type Settings = SharedSettings;
export type Theme = Settings["theme"];

export const getDefaultSettings = (): Settings => ({
  theme: "dark",
  defaultMode: "balanced",
  chromePath: "",
  autoResumeAtQuotaReset: true,
  // PART 2 point 5: off means "create <Documents>/MyIDE-Projects/<name> silently".
  askWorkspaceEachTime: false,
  terminalFontSize: 13,
  askQuestionTimeoutSec: 120,
  providerOverrides: {
    geminiApiKeyLast4: "",
    openrouterApiKeyLast4: "",
    groqApiKeyLast4: "",
  },
});
