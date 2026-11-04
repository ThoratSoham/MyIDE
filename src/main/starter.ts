// PART 3 point 7: a small built-in starter template. When the website pipeline
// cannot run (or produces nothing), the general agent writes these three files
// with the real writeFile tool and verifies them on disk. The page is
// responsive, accessible and shows all its content by default — no animation
// or script is required for anything to be visible.

export interface StarterFile {
  path: string;
  content: string;
}

export const STARTER_FILES: StarterFile[] = [
  {
    path: "index.html",
    content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MyIDE starter page</title>
  <link rel="stylesheet" href="css/style.css" />
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <span class="brand">MyIDE</span>
    <nav aria-label="Main">
      <a href="#features">Features</a>
      <a href="#contact">Contact</a>
    </nav>
  </header>

  <main id="main">
    <section class="hero">
      <h1>Your new page is ready</h1>
      <p>Everything on this page is visible by default. No script is needed to read it.</p>
      <p><a class="cta" href="#contact">Get in touch</a></p>
    </section>

    <section id="features" class="cards" aria-label="Features">
      <article class="card">
        <h2>Responsive</h2>
        <p>One column on a phone, three on a wide screen. No fixed widths.</p>
      </article>
      <article class="card">
        <h2>Accessible</h2>
        <p>Real landmarks, a skip link, readable contrast and focus outlines kept.</p>
      </article>
      <article class="card">
        <h2>Editable</h2>
        <p>Plain HTML, CSS and JavaScript you can change right here in the editor.</p>
      </article>
    </section>

    <section id="contact" class="contact">
      <h2>Contact</h2>
      <p>Replace this text with your own details, then ask MyIDE to change anything you like.</p>
    </section>
  </main>

  <footer class="site-footer">
    <p>Built with MyIDE.</p>
  </footer>

  <script src="js/main.js" defer></script>
</body>
</html>
`,
  },
  {
    path: "css/style.css",
    content: `:root {
  --bg: #ffffff;
  --fg: #16181d;
  --muted: #5b6270;
  --accent: #2563eb;
  --surface: #f4f6fa;
  --border: #d9dee8;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  line-height: 1.6;
}
.skip-link {
  position: absolute; left: -9999px; top: 0;
  background: var(--accent); color: #fff; padding: 8px 12px; z-index: 10;
}
.skip-link:focus { left: 8px; top: 8px; }
.site-header {
  display: flex; align-items: center; gap: 16px;
  padding: 16px 24px; border-bottom: 1px solid var(--border);
}
.brand { font-weight: 700; letter-spacing: 0.04em; }
.site-header nav { margin-left: auto; display: flex; gap: 16px; }
.site-header a { color: var(--accent); text-decoration: none; }
.site-header a:hover, .site-header a:focus { text-decoration: underline; }
main { max-width: 1080px; margin: 0 auto; padding: 32px 24px 64px; }
.hero h1 { font-size: clamp(30px, 5vw, 52px); line-height: 1.15; margin: 24px 0 12px; }
.hero p { color: var(--muted); max-width: 60ch; font-size: 18px; }
.cta {
  display: inline-block; margin-top: 8px; padding: 10px 18px;
  background: var(--accent); color: #fff; border-radius: 8px; text-decoration: none;
}
.cards { display: grid; gap: 16px; grid-template-columns: 1fr; margin-top: 40px; }
@media (min-width: 720px) { .cards { grid-template-columns: repeat(3, 1fr); } }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
.card h2 { margin: 0 0 6px; font-size: 18px; }
.card p { margin: 0; color: var(--muted); }
.contact { margin-top: 40px; }
.site-footer { border-top: 1px solid var(--border); padding: 18px 24px; color: var(--muted); font-size: 14px; }
a:focus-visible, button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
`,
  },
  {
    path: "js/main.js",
    content: `// Progressive enhancement only: the page reads fine without this file.
document.addEventListener("DOMContentLoaded", () => {
  for (const link of document.querySelectorAll('a[href^="#"]')) {
    link.addEventListener("click", (event) => {
      const id = link.getAttribute("href").slice(1);
      const target = document.getElementById(id);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
});
`,
  },
];
