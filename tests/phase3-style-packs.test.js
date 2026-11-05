const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectStylePack,
  getStylePack,
  formatStylePackPromptInstruction,
  applyStylePackToExistingHtml,
} = require("../dist/main/website/style-packs/index.js");

test("detectStylePack detects all 7 style packs from prompt keywords", () => {
  assert.equal(detectStylePack("Build a neo brutalist landing page").id, "neo-brutalism");
  assert.equal(detectStylePack("Make it look like brutalism with heavy borders").id, "neo-brutalism");
  assert.equal(detectStylePack("I want a modern glassmorphic dashboard with frosted cards").id, "glassmorphism");
  assert.equal(detectStylePack("A minimal editorial essay portfolio with serif headings").id, "minimal-editorial");
  assert.equal(detectStylePack("A futuristic dark neon tech site for an AI crypto tool").id, "dark-neon-tech");
  assert.equal(detectStylePack("A cute playful soft pastel website for kids bakery").id, "soft-pastel-playful");
  assert.equal(detectStylePack("A corporate clean b2b enterprise landing page").id, "corporate-clean");
  assert.equal(detectStylePack("A retro y2k vaporwave 90s personal home page").id, "retro-y2k");
});

test("detectStylePack respects defaultStyle when prompt has no style keyword", () => {
  const pack = detectStylePack("Build a coffee shop website", "glassmorphism");
  assert.equal(pack.id, "glassmorphism");

  const defaultPack = detectStylePack("Build a coffee shop website");
  assert.equal(defaultPack.id, "minimal-editorial");
});

test("formatStylePackPromptInstruction outputs concrete design tokens, rules, and starter CSS", () => {
  const pack = getStylePack("neo-brutalism");
  const instruction = formatStylePackPromptInstruction(pack);

  assert.match(instruction, /NEO-BRUTALISM STYLE PACK ACTIVE/);
  assert.match(instruction, /--border: 3px solid/);
  assert.match(instruction, /--shadow:/);
  assert.match(instruction, /DO:/);
  assert.match(instruction, /DON'T:/);
  assert.match(instruction, /<style id="nova-style-pack"/);
});

test("applyStylePackToExistingHtml updates style pack CSS without destroying section markup", () => {
  const initialHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Coffee Shop</title>
  <style id="nova-style-pack">
    :root { --color-bg: #ffffff; }
    body { background: #fff; }
  </style>
</head>
<body>
  <header><h1>Roast & Steam</h1></header>
  <main>
    <section id="menu">
      <h2>Espresso Drinks</h2>
      <p>Single origin roast.</p>
    </section>
  </main>
  <script>console.log("ready");</script>
</body>
</html>`;

  const restyled = applyStylePackToExistingHtml(initialHtml, "dark-neon-tech");

  // Style pack tag replaced with new style tokens
  assert.match(restyled, /data-style-pack="dark-neon-tech"/);
  assert.match(restyled, /--neon-cyan/);

  // Existing sections and scripts remain intact
  assert.match(restyled, /<h1>Roast & Steam<\/h1>/);
  assert.match(restyled, /<section id="menu">/);
  assert.match(restyled, /Single origin roast\./);
  assert.match(restyled, /<script>console\.log\("ready"\);<\/script>/);
});
