import { create } from "zustand";

export type PaletteMode = "commands" | "files" | null;

export interface CommandItem {
  id: string;
  category: string;
  label: string;
  shortcut?: string;
  keywords?: string;
  run: () => void;
}

export interface FuzzyMatchResult<T> {
  item: T;
  score: number;
  positions: number[];
}

/** Fast subsequence + word-boundary fuzzy scorer returning matched char positions. */
export function fuzzyScore(query: string, candidate: string): { score: number; positions: number[] } | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 1, positions: [] };

  const lower = candidate.toLowerCase();
  const positions: number[] = [];
  let qi = 0;
  let score = 0;
  let consecutive = 0;

  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      positions.push(i);
      // Bonus for consecutive characters and word/path boundaries
      if (consecutive > 0) {
        score += 12 + consecutive * 4;
      } else {
        score += 5;
      }
      if (i === 0 || "/\\-_ .".includes(candidate[i - 1])) {
        score += 14;
      }
      // Bonus for matching filename segment
      const lastSlash = candidate.lastIndexOf("/");
      if (i > lastSlash) {
        score += 4;
      }
      consecutive += 1;
      qi += 1;
    } else {
      consecutive = 0;
    }
  }

  if (qi < q.length) return null;
  // Slightly prefer shorter strings when match quality is equal
  score -= Math.min(20, Math.floor(candidate.length * 0.15));
  return { score, positions };
}

interface PaletteStore {
  mode: PaletteMode;
  initialQuery: string;
  openCommands: (initialQuery?: string) => void;
  openQuickOpen: (initialQuery?: string) => void;
  close: () => void;
}

export const usePaletteStore = create<PaletteStore>((set) => ({
  mode: null,
  initialQuery: "",
  openCommands: (initialQuery = "") => set({ mode: "commands", initialQuery }),
  openQuickOpen: (initialQuery = "") => set({ mode: "files", initialQuery }),
  close: () => set({ mode: null, initialQuery: "" }),
}));

