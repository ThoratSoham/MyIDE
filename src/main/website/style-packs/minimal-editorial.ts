import type { StylePack } from "./types";

export const minimalEditorialPack: StylePack = {
  id: "minimal-editorial",
  name: "Minimal Editorial",
  description: "Refined serif headlines, magazine layout, generous whitespace, razor-thin hairline borders, and understated luxury.",
  keywords: ["minimal-editorial", "editorial", "minimal", "minimalist", "luxury", "magazine", "serif", "clean serif", "clean editorial", "vogue"],
  fontLinks: [
    "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,400&family=Inter:wght@300;400;500;600&display=swap",
  ],
  typography: {
    heading: "'Playfair Display', Georgia, serif",
    body: "'Inter', -apple-system, system-ui, sans-serif",
    mono: "monospace",
    headingWeight: "600",
  },
  tokens: {
    "--bg": "#FAF9F6",
    "--surface": "#FFFFFF",
    "--ink": "#18181B",
    "--muted": "#71717A",
    "--border": "1px solid #E4E4E7",
    "--accent": "#991B1B",
    "--radius": "0px",
  },
  cssStarter: `
:root {
  --bg: #FAF9F6;
  --surface: #FFFFFF;
  --ink: #18181B;
  --muted: #71717A;
  --border: 1px solid #E4E4E7;
  --accent: #991B1B;
  --radius: 0px;
  --font-heading: 'Playfair Display', Georgia, serif;
  --font-body: 'Inter', -apple-system, sans-serif;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background-color: var(--bg);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.7;
}

h1, h2, h3 {
  font-family: var(--font-heading);
  font-weight: 600;
  line-height: 1.15;
  color: var(--ink);
  letter-spacing: -0.01em;
}

h1 { font-size: clamp(2.75rem, 6vw, 4.5rem); }
h2 { font-size: clamp(1.85rem, 4vw, 2.75rem); }

.tagline {
  font-family: var(--font-body);
  font-size: 0.85rem;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 1rem;
}

.card {
  background: var(--surface);
  border: var(--border);
  padding: 2.5rem;
  transition: border-color 0.2s ease;
}

.card:hover {
  border-color: var(--ink);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.85rem 2rem;
  font-family: var(--font-body);
  font-size: 0.95rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  font-weight: 500;
  background: var(--ink);
  color: var(--surface);
  text-decoration: none;
  border: 1px solid var(--ink);
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn:hover {
  background: transparent;
  color: var(--ink);
}

.btn-outline {
  background: transparent;
  color: var(--ink);
}

.btn-outline:hover {
  background: var(--ink);
  color: var(--surface);
}

.section {
  padding: 6rem 2rem;
  border-bottom: var(--border);
}

.container {
  max-width: 1140px;
  margin: 0 auto;
}

.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem 2.5rem;
  border-bottom: var(--border);
  background: var(--bg);
  position: sticky;
  top: 0;
  z-index: 100;
}
`,
  doRules: [
    "Use elegant serif typography (Playfair Display) for headlines paired with clean geometric sans-serif for body.",
    "Use generous whitespace (padding: 5rem - 7rem per section).",
    "Use delicate 1px border dividers (#E4E4E7) and subtle uppercase tracking for labels.",
    "Restrained monochrome palette (#FAF9F6 off-white, #18181B deep charcoal) with an optional subtle dark crimson accent.",
  ],
  dontRules: [
    "No cartoonish badge stickers, heavy shadows, or saturated candy colors.",
    "Do not crowd components; respect negative space.",
  ],
  checklist: [
    "Does the page feature refined serif headings?",
    "Is whitespace generous and balanced across sections?",
    "Are borders subtle and hairlined?",
  ],
};
