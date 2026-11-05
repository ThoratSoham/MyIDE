import type { StylePack } from "./types";

export const retroY2kPack: StylePack = {
  id: "retro-y2k",
  name: "Retro Y2K",
  description: "Late 90s / early 2000s desktop nostalgia: gray window bevels, pixelated accents, bright magenta/cyan fills, and window title bars.",
  keywords: ["retro-y2k", "retro", "y2k", "90s", "windows 95", "pixel", "vaporwave", "web 1.0", "nostalgia"],
  fontLinks: [
    "https://fonts.googleapis.com/css2?family=VT323&family=Space+Mono:wght@400;700&display=swap",
  ],
  typography: {
    heading: "'VT323', 'Courier New', monospace",
    body: "Tahoma, 'MS Sans Serif', Geneva, sans-serif",
    mono: "'Space Mono', monospace",
    headingWeight: "700",
  },
  tokens: {
    "--bg": "#008080",
    "--surface": "#C0C0C0",
    "--surface-inner": "#FFFFFF",
    "--ink": "#000000",
    "--win-blue": "#000080",
    "--win-blue-light": "#1084D0",
    "--magenta": "#FF00FF",
    "--cyan": "#00FFFF",
    "--yellow": "#FFFF00",
    "--bevel-light": "#FFFFFF",
    "--bevel-dark": "#808080",
    "--bevel-darkest": "#000000",
  },
  cssStarter: `
:root {
  --bg: #008080;
  --surface: #C0C0C0;
  --surface-inner: #FFFFFF;
  --ink: #000000;
  --win-blue: #000080;
  --win-blue-light: #1084D0;
  --magenta: #FF00FF;
  --cyan: #00FFFF;
  --yellow: #FFFF00;
  --bevel-light: #FFFFFF;
  --bevel-dark: #808080;
  --bevel-darkest: #000000;
  --font-heading: 'VT323', monospace;
  --font-body: Tahoma, 'MS Sans Serif', sans-serif;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background-color: var(--bg);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 15px;
  line-height: 1.5;
}

h1, h2 {
  font-family: var(--font-heading);
  letter-spacing: 0.05em;
}

h1 { font-size: clamp(2.5rem, 6vw, 4.5rem); }
h2 { font-size: clamp(2rem, 4vw, 3rem); }

.window-box {
  background: var(--surface);
  border-top: 2px solid var(--bevel-light);
  border-left: 2px solid var(--bevel-light);
  border-right: 2px solid var(--bevel-darkest);
  border-bottom: 2px solid var(--bevel-darkest);
  box-shadow: inset -1px -1px 0 var(--bevel-dark), inset 1px 1px 0 var(--bevel-light);
  padding: 3px;
  margin-bottom: 2rem;
}

.window-titlebar {
  background: linear-gradient(90deg, var(--win-blue), var(--win-blue-light));
  color: #FFFFFF;
  font-weight: bold;
  padding: 4px 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
}

.window-content {
  padding: 1.5rem;
  background: var(--surface);
}

.card-white {
  background: var(--surface-inner);
  border-top: 2px solid var(--bevel-dark);
  border-left: 2px solid var(--bevel-dark);
  border-right: 2px solid var(--bevel-light);
  border-bottom: 2px solid var(--bevel-light);
  padding: 1.5rem;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 16px;
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: bold;
  background: var(--surface);
  color: var(--ink);
  text-decoration: none;
  border-top: 2px solid var(--bevel-light);
  border-left: 2px solid var(--bevel-light);
  border-right: 2px solid var(--bevel-darkest);
  border-bottom: 2px solid var(--bevel-darkest);
  cursor: pointer;
}

.btn:active {
  border-top: 2px solid var(--bevel-darkest);
  border-left: 2px solid var(--bevel-darkest);
  border-right: 2px solid var(--bevel-light);
  border-bottom: 2px solid var(--bevel-light);
  padding: 7px 15px 5px 17px;
}

.btn-rainbow {
  background: var(--magenta);
  color: #FFFFFF;
}

.section { padding: 4rem 1.5rem; }
.container { max-width: 1080px; margin: 0 auto; }
.nav {
  background: var(--surface);
  border-bottom: 2px solid var(--bevel-darkest);
  padding: 8px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
`,
  doRules: [
    "Classic 3D beveled borders (border-top/left white, border-bottom/right gray/black).",
    "Retro desktop window headers with title bars and buttons.",
    "Early web nostalgia color palette (#008080 teal desktop or classic gray #C0C0C0).",
  ],
  dontRules: [
    "No modern rounded glass panels or soft shadows.",
  ],
  checklist: [
    "Are window frames beveled with 3D inset/outset borders?",
    "Does the page capture early-2000s desktop and web nostalgia?",
  ],
};

