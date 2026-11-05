import type { StylePack } from "./types";

export const neoBrutalismPack: StylePack = {
  id: "neo-brutalism",
  name: "Neo Brutalism",
  description: "High-contrast, bold outlines, hard offset drop shadows, vibrant flat fills, and oversized typography.",
  keywords: ["neo-brutalism", "neo brutalism", "brutalist", "brutalism", "gumroad", "retro bold", "thick border"],
  fontLinks: [
    "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700;800&family=JetBrains+Mono:wght@500;700&display=swap",
  ],
  typography: {
    heading: "'Space Grotesk', system-ui, -apple-system, sans-serif",
    body: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    mono: "'JetBrains Mono', monospace",
    headingWeight: "800",
  },
  tokens: {
    "--bg": "#FFF8E7",
    "--bg-card": "#FFFFFF",
    "--ink": "#000000",
    "--border": "3px solid #000000",
    "--shadow": "5px 5px 0px #000000",
    "--shadow-sm": "3px 3px 0px #000000",
    "--shadow-lg": "8px 8px 0px #000000",
    "--radius": "0px",
    "--yellow": "#FFDE59",
    "--pink": "#FF5C8A",
    "--blue": "#4D9DE0",
    "--green": "#7AE582",
    "--orange": "#FFA45B",
  },
  cssStarter: `
:root {
  --bg: #FFF8E7;
  --bg-card: #FFFFFF;
  --ink: #000000;
  --border: 3px solid #000000;
  --shadow: 5px 5px 0px #000000;
  --shadow-sm: 3px 3px 0px #000000;
  --shadow-lg: 8px 8px 0px #000000;
  --radius: 0px;
  --yellow: #FFDE59;
  --pink: #FF5C8A;
  --blue: #4D9DE0;
  --green: #7AE582;
  --orange: #FFA45B;
  --font-heading: 'Space Grotesk', system-ui, sans-serif;
  --font-body: system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background-color: var(--bg);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3, h4, h5 {
  font-family: var(--font-heading);
  font-weight: 800;
  line-height: 1.1;
  color: var(--ink);
  letter-spacing: -0.02em;
}

h1 { font-size: clamp(2.5rem, 6vw, 4.5rem); margin-bottom: 1.25rem; }
h2 { font-size: clamp(2rem, 4vw, 3rem); margin-bottom: 1rem; }

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.75rem 1.75rem;
  font-family: var(--font-heading);
  font-weight: 800;
  font-size: 1.1rem;
  text-decoration: none;
  cursor: pointer;
  border: var(--border);
  box-shadow: var(--shadow);
  border-radius: var(--radius);
  background: var(--yellow);
  color: var(--ink);
  transition: transform 0.1s ease, box-shadow 0.1s ease;
}

.btn:hover {
  transform: translate(2px, 2px);
  box-shadow: 3px 3px 0px #000000;
}

.btn:active {
  transform: translate(5px, 5px);
  box-shadow: 0px 0px 0px #000000;
}

.btn-secondary { background: var(--pink); color: #000; }
.btn-blue { background: var(--blue); color: #000; }
.btn-green { background: var(--green); color: #000; }

.card {
  background: var(--bg-card);
  border: var(--border);
  box-shadow: var(--shadow);
  border-radius: var(--radius);
  padding: 2rem;
  transition: transform 0.15s ease;
}

.card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
}

.badge {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 0.85rem;
  text-transform: uppercase;
  border: 2px solid #000000;
  background: var(--pink);
  color: #000;
  transform: rotate(-2deg);
  margin-bottom: 0.75rem;
}

.section {
  padding: 5rem 1.5rem;
  border-bottom: var(--border);
}

.container {
  max-width: 1200px;
  margin: 0 auto;
}

.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.25rem 2rem;
  border-bottom: var(--border);
  background: #FFFDF2;
  position: sticky;
  top: 0;
  z-index: 100;
}

.marquee-strip {
  border-top: var(--border);
  border-bottom: var(--border);
  background: var(--yellow);
  padding: 0.75rem 0;
  overflow: hidden;
  white-space: nowrap;
  font-family: var(--font-heading);
  font-weight: 800;
  font-size: 1.25rem;
}
`,
  doRules: [
    "Use 3px solid black borders around all cards, buttons, inputs, and section boundaries.",
    "Hard offset drop-shadows (5px 5px 0px #000) with ZERO blur on all components.",
    "Tactile button press: buttons translate(3px, 3px) with reduced shadow on hover/active.",
    "Alternate flat background colors per section (e.g. #FFF8E7, #FFDE59, #FFFFFF, #4D9DE0).",
    "Badge stickers slightly tilted with CSS transform: rotate(-2deg) or rotate(2deg).",
    "Hero title must be massive (64px - 96px) in Space Grotesk or heavy sans-serif.",
  ],
  dontRules: [
    "NEVER use blurred drop shadows (e.g. 0 10px 20px rgba(0,0,0,0.1)). Shadows must be 0-blur hard black offsets.",
    "NEVER use gradient fills or soft glassy opacities.",
    "NEVER use large rounded pill shapes or border-radius > 4px.",
    "NEVER use washed-out low-contrast gray text; ink must be solid #000000.",
  ],
  checklist: [
    "Are all borders exactly 3px solid black?",
    "Are all shadows hard-edged with 0 blur?",
    "Does the hero section feature huge high-impact typography?",
    "Are interactive buttons tactile with active push-down offsets?",
    "Does the page use high-contrast flat color blocks?",
  ],
};
