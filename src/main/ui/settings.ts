export type Theme = "system" | "dark" | "light";

export interface Settings {
  theme: Theme;
  defaultMode: "fast" | "balanced" | "best";
  chromePath: string;
  autoResumeAtQuotaReset: boolean;
  providerOverrides: {
    geminiApiKeyLast4: string;
    openrouterApiKeyLast4: string;
    groqApiKeyLast4: string;
  };
}

export const getDefaultSettings = (): Settings => ({
  theme: "system",
  defaultMode: "balanced",
  chromePath: "",
  autoResumeAtQuotaReset: true,
  providerOverrides: {
    geminiApiKeyLast4: "",
    openrouterApiKeyLast4: "",
    groqApiKeyLast4: "",
  },
});
