/* PART 1 test 6: the fake-provider end-to-end chat test in headless Chrome.
 * Runs the BUILT renderer inside Electron with a deterministic in-process
 * provider (never the network), drives the real UI, and checks the transcript
 * plus the screenshots written to .myide/verify/chat-*.png.
 *
 * Usage: node tests/e2e-chat.mjs   (after `npm run build:main && npm run build:renderer`)
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, ".myide", "verify");
const KIND = "agent";
fs.mkdirSync(OUT, { recursive: true });

const electronPath = require("electron");

const SCENARIOS = ["ok", "error", "nokeys"];

// What each scenario must prove, read straight out of the smoke transcript.
const EXPECTED = {
  ok: [
    [/bubble within 2s -> true/, "a bubble appears within 2 seconds"],
    [/two-messages-visible: true/, "two messages in a row both stay visible"],
  ],
  error: [[/error: error bubble present -> true/, "a provider error shows an error bubble"]],
  nokeys: [[/nokeys: "Add an API key" button present -> true/, "no keys shows 'Add an API key'"]],
};

function runScenario(scenario) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, ["."], {
      cwd: REPO,
      env: {
        ...childEnv,
        MYIDE_SMOKE: "1",
        MYIDE_SMOKE_SCENARIO: scenario,
        MYIDE_SMOKE_KIND: KIND,
        MYIDE_SMOKE_OUT: OUT,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => child.kill(), 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const failures = [];
const lines = [];

for (const scenario of SCENARIOS) {
  const { code, out } = await runScenario(scenario);
  const logFile = path.join(OUT, `chat-${KIND}-${scenario}.log`);
  const png = path.join(OUT, `chat-${KIND}-${scenario}.png`);

  if (!fs.existsSync(logFile)) {
    failures.push(`${scenario}: no transcript at ${logFile}\n${out.slice(-2000)}`);
    lines.push(`${scenario}: NO TRANSCRIPT (exit ${code})`);
    continue;
  }
  const text = fs.readFileSync(logFile, "utf8");

  let ok = true;
  for (const [re, what] of EXPECTED[scenario]) {
    if (!re.test(text)) {
      ok = false;
      failures.push(`${scenario}: expected ${what}`);
    }
  }
  if (!fs.existsSync(png) || fs.statSync(png).size === 0) {
    ok = false;
    failures.push(`${scenario}: no screenshot at ${png}`);
  }
  // The numbered hop trace must be present (PART 1 DIAGNOSE).
  if (!/\[chat [0-9a-f]{4}\] 1 renderer: send clicked/.test(text)) {
    ok = false;
    failures.push(`${scenario}: the renderer hop 1 trace is missing`);
  }
  lines.push(`${scenario}: ${ok ? "PASS" : "FAIL"} (exit ${code})`);
}

console.log("---- headless chat test (fake provider) ----");
for (const l of lines) console.log(l);
console.log(`screenshots in ${OUT}`);
if (failures.length) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log("ALL CHAT E2E SCENARIOS PASSED");
