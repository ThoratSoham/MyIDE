const test = require("node:test");
const assert = require("node:assert/strict");
const { installElectronStub } = require("./helpers/harness");

installElectronStub();

const { Ledger } = require("../dist/main/ai/ledger");
const { Router } = require("../dist/main/ai/router");
const { AIService } = require("../dist/main/ai/service");
const { setProviderKey } = require("../dist/main/store");

function makeLane(id, provider, model, priority, limits = {}) {
  return {
    id,
    provider,
    model,
    role: "reasoning",
    priority,
    limits: {
      rpm: limits.rpm ?? 10,
      rpd: limits.rpd ?? 100,
      tpm: limits.tpm ?? null,
      maxTokensPerRequest: limits.maxTokensPerRequest ?? 16000,
      resetHourUtc: 0,
    },
  };
}

test("Proactive token-bucket ledger: pre-skips TPM/RPM/RPD-full lanes without firing wasted HTTP requests", async () => {
  const ledger = new Ledger();
  const groqTight = makeLane("groq:tight", "groq", "openai/gpt-oss-120b", 1, {
    rpm: 5,
    rpd: 50,
    tpm: 2000,
    maxTokensPerRequest: 5500,
  });
  const geminiBackup = makeLane("gemini:backup", "gemini", "gemini-2.5-flash", 2, {
    rpm: 15,
    rpd: 250,
    tpm: null,
  });
  ledger.load([groqTight, geminiBackup]);

  // Simulate 1,600 tokens already spent on groq:tight in this minute
  ledger.recordSend(groqTight, 1600);

  const sentTo = [];
  const router = new Router({
    getLanes: () => [groqTight, geminiBackup],
    healthFor: (id) => ledger.healthFor(id === groqTight.id ? groqTight : geminiBackup),
    canAfford: (lane, est, now) => ledger.canAfford(lane, est, now),
    sendVia: async (lane) => {
      sentTo.push(lane.id);
      return { ok: true, content: '{"thought":"ok","answer":"routed"}' };
    },
    onOutcome: (lane, _out, est) => ledger.recordSend(lane, est),
  });

  // Request needs ~600+ tokens -> 1600 + 600 > 2000 TPM on groq:tight!
  // Router must pre-skip groq:tight (0 HTTP calls to it) and succeed on gemini:backup.
  const res = await router.send("codegen", [{ role: "user", content: "x".repeat(400) }], {
    expectedOutputTokens: 500,
  });

  assert.equal(res.ok, true);
  assert.equal(res.laneUsed.id, "gemini:backup");
  assert.deepEqual(sentTo, ["gemini:backup"]);
});

test("Dynamic lane scoring & probation: demotes lane with >25% malformed JSON rate and re-tests after probation expires", async () => {
  const ledger = new Ledger();
  ledger.probationDurationMs = 80; // 80ms probation for fast unit test

  const flakyLane = makeLane("openrouter:flaky", "openrouter", "flaky-7b", 1);
  const solidLane = makeLane("gemini:solid", "gemini", "gemini-2.5-flash", 2);
  ledger.load([flakyLane, solidLane]);

  let flakyHealthyNow = false;
  const calls = [];

  const router = new Router({
    getLanes: () =>
      [flakyLane, solidLane].sort(
        (a, b) => a.priority + ledger.qualityScorePenalty(a.id) - (b.priority + ledger.qualityScorePenalty(b.id)),
      ),
    healthFor: (id) => ledger.healthFor(id === flakyLane.id ? flakyLane : solidLane),
    canAfford: (lane, est, now) => ledger.canAfford(lane, est, now),
    recordQualitySample: (lane, sample) => ledger.recordQualitySample(lane, sample),
    sendVia: async (lane) => {
      calls.push(lane.id);
      if (lane.id === flakyLane.id && !flakyHealthyNow) {
        // Emit broken non-JSON text
        return { ok: true, content: "NOT VALID JSON AT ALL" };
      }
      return { ok: true, content: '{"thought":"clean","answer":"valid"}' };
    },
    onOutcome: (lane, _out, est) => ledger.recordSend(lane, est),
  });

  const schema = { type: "object", properties: { thought: { type: "string" } } };

  // Feed 4 schema-validated calls where flakyLane emits broken JSON -> >25% malformed rate triggers probation!
  for (let i = 0; i < 4; i++) {
    await router.send("codegen", [{ role: "user", content: "ping" }], { schema });
  }

  // Call #5: flakyLane is in probation cooldown AND has quality penalty -> routes straight to solidLane!
  const fifth = await router.send("codegen", [{ role: "user", content: "ping" }], { schema });
  assert.equal(fifth.ok, true);
  assert.equal(fifth.laneUsed.id, "gemini:solid");

  // Wait for 80ms probation to expire and verify flakyLane can be used again when solidLane is removed
  await new Promise((r) => setTimeout(r, 110));
  flakyHealthyNow = true;
  ledger.markDayExhausted(solidLane, Date.now() + 60_000);

  const recovered = await router.send("codegen", [{ role: "user", content: "ping" }], { schema });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.laneUsed.id, "openrouter:flaky");
});

test("Task-class routing: routes classify/summarize/chat to fast high-RPM lanes while codegen uses top coding lane", () => {
  setProviderKey("gemini", "test-gem-key");
  setProviderKey("groq", "test-groq-key");

  const svc = new AIService();
  svc.init({ skipLiveFetch: true });

  const codegenLanes = svc.router.config.getLanes("codegen");
  const classifyLanes = svc.router.config.getLanes("classify");
  const summarizeLanes = svc.router.config.getLanes("summarize");

  assert.equal(codegenLanes[0].model, "gemini-3.8-flash");
  // Light utility classes prefer lite / groq lanes over top codegen lane!
  assert.notEqual(classifyLanes[0].model, "gemini-3.8-flash");
  assert.notEqual(summarizeLanes[0].model, "gemini-3.8-flash");

  setProviderKey("gemini", "");
  setProviderKey("groq", "");
});
