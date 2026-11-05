import type { StylePack } from "./types";

export const glassmorphismPack: StylePack = {
  id: "glassmorphism",
  name: "Glassmorphism",
  description: "Frosted translucent glass panels, background blurs, ambient glowing gradients, and sleek modern typography.",
  keywords: ["glassmorphism", "glass", "frosted", "translucent", "glow", "ambient", "blur", "apple style"],
  fontLinks: [
    "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Inter:wght@400;500;600&display=swap",
  ],
  typography: {
    heading: "'Plus Jakarta Sans', system-ui, sans-serif",
    body: "'Inter', system-ui, sans-serif",
    mono: "monospace",
    headingWeight: "700",
  },
  tokens: {
    "--bg": "#0B0F19",
    "--bg-glass": "rgba(255, 255, 255, 0.07)",
    "--border-glass": "1px solid rgba(255, 255, 255, 0.15)",
    "--ink": "#F8FAFC",
    "--ink-muted": "#94A3B8",
    "--accent": "#818CF8",
    "--accent-glow": "rgba(129, 140, 248, 0.25)",
    "--radius": "16px",
    "--radius-pill": "9999px",
  },
  cssStarter: `
:root {
  --bg: #0B0F19;
  --bg-glass: rgba(255, 255, 255, 0.07);
  --border-glass: 1px solid rgba(255, 255, 255, 0.15);
  --ink: #F8FAFC;
  --ink-muted: #94A3B8;
  --accent: #818CF8;
  --accent-glow: rgba(129, 140, 248, 0.25);
  --radius: 16px;
  --radius-pill: 9999px;
  --font-heading: 'Plus Jakarta Sans', system-ui, sans-serif;
  --font-body: 'Inter', system-ui, sans-serif;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background-color: var(--bg);
  background-image: 
    radial-gradient(circle at 15% 15%, rgba(99, 102, 241, 0.15) 0%, transparent 40%),
    radial-gradient(circle at 85% 85%, rgba(236, 72, 153, 0.12) 0%, transparent 40%);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.6;
  min-height: 100vh;
}

h1, h2, h3, h4 {
  font-family: var(--font-heading);
  color: var(--ink);
  letter-spacing: -0.02em;
  line-height: 1.15;
}

h1 { font-size: clamp(2.5rem, 5vw, 4rem); }
h2 { font-size: clamp(1.75rem, 3.5vw, 2.5rem); }

.card {
  background: var(--bg-glass);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: var(--border-glass);
  border-radius: var(--radius);
  padding: 2rem;
  box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.36);
  transition: border-color 0.2s ease, transform 0.2s ease;
}

.card:hover {
  border-color: rgba(255, 255, 255, 0.3);
  transform: translateY(-2px);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.8rem 1.8rem;
  font-family: var(--font-heading);
  font-weight: 600;
  border-radius: var(--radius-pill);
  background: linear-gradient(135deg, #6366F1, #8B5CF6);
  color: #FFFFFF;
  text-decoration: none;
  border: 1px solid rgba(255, 255, 255, 0.2);
  box-shadow: 0 0 20px var(--accent-glow);
  cursor: pointer;
  transition: opacity 0.2s ease, transform 0.15s ease;
}

.btn:hover {
  opacity: 0.95;
  transform: translateY(-1px);
}

.btn-secondary {
  background: var(--bg-glass);
  backdrop-filter: blur(12px);
  color: var(--ink);
}

.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 2rem;
  background: rgba(11, 15, 25, 0.7);
  backdrop-filter: blur(20px);
  border-bottom: var(--border-glass);
  position: sticky;
  top: 0;
  z-index: 100;
}

.section {
  padding: 5rem 1.5rem;
}

.container {
  max-width: 1200px;
  margin: 0 auto;
}
`,
  doRules: [
    "Use backdrop-filter: blur(16px) with translucent white backgrounds (rgba(255, 255, 255, 0.07)).",
    "Use subtle translucent borders (1px solid rgba(255, 255, 255, 0.15)) to catch light edges.",
    "Ambient background radial gradients to show off frosted refraction.",
    "Rounded pill shapes and sleek modern sans-serif typography.",
  ],
  dontRules: [
    "Do NOT use opaque dark backgrounds for cards that cancel the glass effect.",
    "Do NOT use hard harsh black shadows.",
    "Ensure text contrast remains >= 4.5:1 against translucent glass panels.",
  ],
  checklist: [
    "Do glass cards have backdrop-filter: blur applied?",
    "Is the background dark with ambient glowing color orbs?",
    "Do cards have fine translucent specular borders?",
  ],
};
