/**
 * Style Pack System (PHASE 3)
 * Provides concrete design tokens, CSS starters, typography rules,
 * component styling, and quality checklists for frontend generation.
 */

export interface StylePackTypography {
  heading: string;
  body: string;
  mono?: string;
  headingWeight: string;
}

export interface StylePack {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  fontLinks: string[];
  typography: StylePackTypography;
  tokens: Record<string, string>;
  cssStarter: string;
  doRules: string[];
  dontRules: string[];
  checklist: string[];
}

