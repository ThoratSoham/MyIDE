import type { StylePack } from "./types";

export const softPastelPlayfulPack: StylePack = {
  id: "soft-pastel-playful",
  name: "Soft Pastel Playful",
  description: "Friendly rounded cards, warm cream backgrounds, soft pastel candy accents, bubbly pill buttons, and cheerful vibes.",
  keywords: ["soft-pastel-playful", "pastel", "playful", "cute", "bubbly", "soft", "friendly", "children", "cream", "rounded"],
  fontLinks: [
    "https://fonts.googleapis.com/css2?family=Quicksand:wght@600;700&family=Nunito:wght@400;600;700&display=swap",
  ],
  typography: {
    heading: "'Quicksand', system-ui, sans-serif",
    body: "'Nunito', system-ui, sans-serif",
    mono: "monospace",
    headingWeight: "700",
  },
  tokens: {
    "--bg": "#FDFBF7",
    "--surface": "#FFFFFF",
    "--ink": "#2D3748",
    "--muted": "#718096",
    "--pastel-pink": "#FED7E2",
    "--pastel-yellow": "#FEFCBF",
    "--pastel-purple": "#E9D8FD",
    "--pastel-teal": "#C6F6D5",
    "--pastel-blue": "#BEE3F8",
    "--coral": "#FF6B6B",
    "--radius": "20px",
    "--radius-pill": "9999px",
    "--shadow-soft": "0 10px 25px -5px rgba(237, 137, 54, 0.12)",
  },
  cssStarter: `
:root {
  --bg: #FDFBF7;
  --surface: #FFFFFF;
  --ink: #2D3748;
  --muted: #718096;
  --pastel-pink: #FED7E2;
  --pastel-yellow: #FEFCBF;
  --pastel-purple: #E9D8FD;
  --pastel-teal: #C6F6D5;
  --pastel-blue: #BEE3F8;
  --coral: #FF6B6B;
  --radius: 20px;
  --radius-pill: 9999px;
  --shadow-soft: 0 10px 25px -5px rgba(237, 137, 54, 0.12);
  --font-heading: 'Quicksand', system-ui, sans-serif;
  --font-body: 'Nunito', system-ui, sans-serif;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background-color: var(--bg);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.6;
}

h1, h2, h3 {
  font-family: var(--font-heading);
  font-weight: 700;
  color: var(--ink);
}

h1 { font-size: clamp(2.5rem, 5vw, 3.75rem); }
h2 { font-size: clamp(1.75rem, 3.5vw, 2.5rem); }

.card {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 2.25rem;
  box-shadow: var(--shadow-soft);
  border: 2px solid transparent;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.card:hover {
  transform: translateY(-4px);
  box-shadow: 0 16px 32px -6px rgba(237, 137, 54, 0.18);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.9rem 2rem;
  font-family: var(--font-heading);
  font-weight: 700;
  font-size: 1rem;
  border-radius: var(--radius-pill);
  background: var(--coral);
  color: #FFFFFF;
  text-decoration: none;
  border: none;
  box-shadow: 0 4px 14px rgba(255, 107, 107, 0.35);
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn:hover {
  transform: scale(1.03);
  box-shadow: 0 6px 20px rgba(255, 107, 107, 0.45);
}

.btn-secondary {
  background: var(--pastel-yellow);
  color: var(--ink);
  box-shadow: none;
}

.badge {
  display: inline-block;
  padding: 0.35rem 1rem;
  font-family: var(--font-heading);
  font-weight: 700;
  font-size: 0.85rem;
  border-radius: var(--radius-pill);
  background: var(--pastel-pink);
  color: #97266D;
  margin-bottom: 0.75rem;
}

.section { padding: 5rem 1.5rem; }
.container { max-width: 1140px; margin: 0 auto; }
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.25rem 2rem;
  background: var(--bg);
  position: sticky;
  top: 0;
  z-index: 100;
}
`,
  doRules: [
    "Use warm comforting cream background (#FDFBF7) and rounded corners (border-radius: 20px).",
    "Bubbly pill buttons with soft organic drop-shadows.",
    "Friendly pastel color blocks (pink, lavender, mint, buttercup yellow).",
    "Rounded friendly typography (Quicksand & Nunito).",
  ],
  dontRules: [
    "No harsh black borders or aggressive sharp angles.",
    "No cold tech neon or stark clinical enterprise palettes.",
  ],
  checklist: [
    "Are corners rounded and pill-shaped?",
    "Is the palette warm and pastel-accented?",
    "Is the overall tone welcoming, cheerful, and approachable?",
  ],
};

