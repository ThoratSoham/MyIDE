import type { StylePack } from "./types";

export const darkNeonTechPack: StylePack = {
  id: "dark-neon-tech",
  name: "Dark Neon Tech",
  description: "Cyberpunk dev aesthetic: pitch black canvas, electric cyan and neon purple accents, glowing borders, and monospace code blocks.",
  keywords: ["dark-neon-tech", "neon", "cyberpunk", "tech", "hacker", "developer", "dark mode", "glow", "matrix", "terminal"],
  fontLinks: [
    "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap",
  ],
  typography: {
    heading: "'Space Grotesk', system-ui, sans-serif",
    body: "system-ui, -apple-system, sans-serif",
    mono: "'JetBrains Mono', monospace",
    headingWeight: "700",
  },
  tokens: {
    "--bg": "#090A0F",
    "--surface": "#12141F",
    "--border": "1px solid #23273D",
    "--ink": "#F1F5F9",
    "--muted": "#64748B",
    "--neon-cyan": "#00F5FF",
    "--neon-purple": "#B026FF",
    "--neon-green": "#00FF85",
    "--glow-cyan": "0 0 20px rgba(0, 245, 255, 0.4)",
    "--glow-purple": "0 0 20px rgba(176, 38, 255, 0.4)",
    "--radius": "8px",
  },
  cssStarter: `
:root {
  --bg: #090A0F;
  --surface: #12141F;
  --border: 1px solid #23273D;
  --ink: #F1F5F9;
  --muted: #64748B;
  --neon-cyan: #00F5FF;
  --neon-purple: #B026FF;
  --neon-green: #00FF85;
  --glow-cyan: 0 0 20px rgba(0, 245, 255, 0.4);
  --glow-purple: 0 0 20px rgba(176, 38, 255, 0.4);
  --radius: 8px;
  --font-heading: 'Space Grotesk', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background-color: var(--bg);
  background-image: 
    linear-gradient(rgba(0, 245, 255, 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 245, 255, 0.03) 1px, transparent 1px);
  background-size: 40px 40px;
  color: var(--ink);
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 16px;
  line-height: 1.6;
}

h1, h2, h3 {
  font-family: var(--font-heading);
  color: var(--ink);
  letter-spacing: -0.02em;
}

h1 { font-size: clamp(2.5rem, 5.5vw, 4.25rem); }
.text-cyan { color: var(--neon-cyan); }
.text-purple { color: var(--neon-purple); }

.card {
  background: var(--surface);
  border: var(--border);
  border-radius: var(--radius);
  padding: 2rem;
  transition: all 0.2s ease;
  position: relative;
}

.card:hover {
  border-color: var(--neon-cyan);
  box-shadow: var(--glow-cyan);
  transform: translateY(-2px);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.8rem 1.8rem;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 0.95rem;
  border-radius: var(--radius);
  background: var(--neon-cyan);
  color: #000000;
  text-decoration: none;
  border: 1px solid var(--neon-cyan);
  box-shadow: var(--glow-cyan);
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn:hover {
  background: transparent;
  color: var(--neon-cyan);
}

.btn-purple {
  background: var(--neon-purple);
  border-color: var(--neon-purple);
  box-shadow: var(--glow-purple);
  color: #FFFFFF;
}

.btn-purple:hover {
  background: transparent;
  color: var(--neon-purple);
}

.code-badge {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--neon-green);
  background: rgba(0, 255, 133, 0.1);
  border: 1px solid rgba(0, 255, 133, 0.3);
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
}

.section { padding: 5rem 1.5rem; border-bottom: var(--border); }
.container { max-width: 1200px; margin: 0 auto; }
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.25rem 2rem;
  background: rgba(9, 10, 15, 0.85);
  backdrop-filter: blur(12px);
  border-bottom: var(--border);
  position: sticky;
  top: 0;
  z-index: 100;
}
`,
  doRules: [
    "Use deep dark canvas (#090A0F) with fine subtle cyber grid lines.",
    "Electric high-voltage accent colors (#00F5FF cyan, #B026FF purple, #00FF85 green).",
    "Glow drop shadows on interactive hover states and prominent CTA buttons.",
    "Monospace details (JetBrains Mono) for tags, metrics, and technical labels.",
  ],
  dontRules: [
    "No bright white backgrounds.",
    "Do not use pastel muted vintage tones.",
    "Ensure contrast: always use bright text (#F1F5F9) on dark backgrounds.",
  ],
  checklist: [
    "Is the canvas deep dark with cyber grid or neon accents?",
    "Do CTA buttons and card hovers have vivid glowing drop shadows?",
    "Are technical details formatted with monospace typography?",
  ],
};
