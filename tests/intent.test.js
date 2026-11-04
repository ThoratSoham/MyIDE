/* PART 2 point 8: a table test with 30 example sentences for the intent router.
 * The router is code only — no model call — so this runs in plain Node. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const intent = require(path.join(REPO, "dist", "shared", "intent.js"));
const { routeIntent, pipelineFor, estimateRun, INTENT_LABELS, INTENT_OPTIONS } = intent;

// [sentence, expected intent, expected confidence]
const TABLE = [
  // website
  ["make me a website for a coffee shop", "website", "high"],
  ["build a landing page for my app", "website", "high"],
  ["I need a portfolio site", "website", "high"],
  ["create a web app for a todo list", "website", "high"],
  ["one-pager for a music festival", "website", "high"],
  // video / animation
  ["make a logo animation for my brand", "video", "high"],
  ["create an mp4 promo video", "video", "high"],
  ["animated logo reveal", "video", "high"],
  ["motion graphic intro for my channel", "video", "high"],
  ["export a gif for the readme", "video", "high"],
  // 3D
  ["make a 3D science explainer", "3d", "high"],
  ["build a three.js scene", "3d", "high"],
  ["interactive 3d model viewer", "3d", "high"],
  ["a simulation of the solar system", "3d", "high"],
  ["explainer for photosynthesis", "3d", "high"],
  // general agent
  ["run npm install", "agent", "high"],
  ["fix this error in my build", "agent", "high"],
  ["install python dependencies", "agent", "high"],
  ["git commit my changes", "agent", "high"],
  ["refactor the utils file", "agent", "high"],
  // chat only
  ["what is a closure in javascript?", "chat", "high"],
  ["explain this code to me", "chat", "high"],
  ["how does the router work", "chat", "high"],
  ["why is my file empty", "chat", "high"],
  ["compare REST and GraphQL", "chat", "high"],
  // unclear -> the general agent handles it (PART 2 point 3: "do not fail")
  ["make me something cool", "agent", "low"],
  ["blorp", "agent", "low"],
  // mixed: the first matching rule wins, so order is part of the contract
  ["build a website and then run the build", "website", "high"],
  ["explain how to make a video", "video", "high"],
  ["fix a bug on my landing page", "website", "high"],
];

test("intent router: 30-sentence table", () => {
  assert.equal(TABLE.length, 30, "the table must hold exactly 30 sentences");
  for (const [text, expected, confidence] of TABLE) {
    const got = routeIntent(text);
    assert.equal(got.intent, expected, `"${text}" routed to ${got.intent} (${got.reason}) but should be ${expected}`);
    assert.equal(got.confidence, confidence, `"${text}" confidence should be ${confidence}`);
    assert.equal(got.label, INTENT_LABELS[expected], `"${text}" label`);
  }
});

test("intent router: empty text is unclear", () => {
  const got = routeIntent("   ");
  assert.equal(got.intent, "chat");
  assert.equal(got.confidence, "low");
});

test("pipelineFor: only the website pipeline exists, everything else uses the agent", () => {
  assert.equal(pipelineFor("website"), "website");
  assert.equal(pipelineFor("video"), "agent");
  assert.equal(pipelineFor("3d"), "agent");
  assert.equal(pipelineFor("agent"), "agent");
  assert.equal(pipelineFor("chat"), "agent");
});

test("estimateRun: mode raises the request count, chat is one call", () => {
  assert.equal(estimateRun("chat", "fast").requests, 1);
  const fast = estimateRun("website", "fast").requests;
  const balanced = estimateRun("website", "balanced").requests;
  const best = estimateRun("website", "best").requests;
  assert.ok(fast < balanced && balanced < best, "website estimate must grow with the mode");
  assert.ok(estimateRun("agent", "balanced").requests > estimateRun("chat", "balanced").requests);
});

test("the chip offers Auto plus every intent", () => {
  const values = INTENT_OPTIONS.map((o) => o.value);
  assert.deepEqual(values, ["auto", "website", "video", "3d", "agent", "chat"]);
});
