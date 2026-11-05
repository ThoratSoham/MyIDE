import { DEFAULT_SETTINGS, type Settings as SharedSettings } from "../../shared/electron-api-types";

// One source of truth: the renderer, the preload bridge and the main process all
// use the shared Settings shape. This file only supplies the defaults.
export type Settings = SharedSettings;
export type Theme = Settings["theme"];

export const getDefaultSettings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  providerOverrides: { ...DEFAULT_SETTINGS.providerOverrides },
});
