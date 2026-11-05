import type { StylePack } from "./types";

export const corporateCleanPack: StylePack = {
  id: "corporate-clean",
  name: "Corporate Clean",
  description: "Modern professional SaaS look: crisp slate backgrounds, vibrant royal blue primary accents, structured grids, and trustworthy typography.",
  keywords: ["corporate-clean", "corporate", "saas", "professional", "business", "stripe style", "clean tech", "enterprise", "fintech"],
  fontLinks: [
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap",
  ],
  typography: {
    heading: "'Inter', system-ui, -apple-system, sans-serif",
    body: "'Inter', system-ui, -apple-system, sans-serif",
    mono: "monospace",
    headingWeight: "700",
  },
  tokens: {
    "--bg": "#F8FAFC",
    "--surface": "#FFFFFF",
    "--ink": "#0F172A",
    "--muted": "#64748B",
    "--border": "1px solid #E2E8F0",
    "--primary": "#2563EB",
    "--primary-hover": "#1D4ED8",
    "--radius": "8px",
    "--shadow-sm": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    "--shadow-md": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  },
  cssStarter: `
:root {
  --bg: #F8FAFC;
  --surface: #FFFFFF;
  --ink: #0F172A;
  --muted: #64748B;
  --border: 1px solid #E2E8F0;
  --primary: #2563EB;
  --primary-hover: #1D4ED8;
  --radius: 8px;
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --font-body: 'Inter', system-ui, sans-serif;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background-color: var(--bg);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.6;
}

h1, h2, h3, h4 {
  color: var(--ink);
  font-weight: 700;
  letter-spacing: -0.02em;
}

h1 { font-size: clamp(2.5rem, 5vw, 3.75rem); line-height: 1.15; }
h2 { font-size: clamp(1.75rem, 3.5vw, 2.5rem); }

.card {
  background: var(--surface);
  border: var(--border);
  border-radius: var(--radius);
  padding: 2rem;
  box-shadow: var(--shadow-sm);
  transition: box-shadow 0.2s ease;
}

.card:hover {
  box-shadow: var(--shadow-md);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 0.95rem;
  border-radius: 6px;
  background: var(--primary);
  color: #FFFFFF;
  text-decoration: none;
  border: 1px solid var(--primary);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.btn:hover {
  background: var(--primary-hover);
}

.btn-secondary {
  background: var(--surface);
  color: var(--ink);
  border-color: #CBD5E1;
}

.btn-secondary:hover {
  background: #F1F5F9;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.75rem;
  font-size: 0.8rem;
  font-weight: 600;
  border-radius: 9999px;
  background: #EFF6FF;
  color: var(--primary);
  border: 1px solid #DBEAFE;
  margin-bottom: 1rem;
}

.section { padding: 5rem 1.5rem; border-bottom: var(--border); }
.container { max-width: 1200px; margin: 0 auto; }
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.25rem 2rem;
  background: #FFFFFF;
  border-bottom: var(--border);
  position: sticky;
  top: 0;
  z-index: 100;
}
`,
  doRules: [
    "Trustworthy enterprise SaaS layout with crisp borders and subtle shadows.",
    "Royal blue CTA accents (#2563EB) against clean slate backgrounds (#F8FAFC).",
    "High clarity, responsive grid layouts, and readable Inter typography.",
  ],
  dontRules: [
    "No whimsical neon glows, handwritten fonts, or retro gimmicks.",
  ],
  checklist: [
    "Does the page feel like a polished, trustworthy modern SaaS product?",
    "Are typography, spacing, and buttons consistent across sections?",
  ],
};
