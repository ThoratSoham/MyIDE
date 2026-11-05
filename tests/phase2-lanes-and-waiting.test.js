const test = require("node:test");
const assert = require("node:assert/strict");

const { installElectronStub } = require("./helpers/harness");
installElectronStub();

const { buildLanes } = require("../dist/main/ai/providers");
const { Router } = require("../dist/main/ai/router");
const { DEFAULT_MODEL_ENTRIES } = require("../dist/main/ai/model-settings");

test("Phase 2: buildLanes attaches capabilities (maxOutputTokens, supportsVision, isReasoning, roleTags)", () => {
  const lanes = buildLanes(DEFAULT_MODEL_ENTRIES);
  const gemini = lanes.find((l) => l.model === "gemini-3.8-flash");
  assert.ok(gemini);
  assert.equal(gemini.supportsVision, true);
  assert.equal(gemini.maxOutputTokens, 65536);
  assert.ok(gemini.roleTags?.includes("codegen"));
  assert.ok(gemini.roleTags?.includes("vision"));

  const groqReasoning = lanes.find((l) => l.model === "openai/gpt-oss-120b");
  assert.ok(groqReasoning);
  assert.equal(groqReasoning.isReasoning, true);
  assert.equal(groqReasoning.maxOutputTokens, 5500);
});

test("Phase 2: Lane filter skips low-output lanes for single-shot codegen", async () => {
  const lanes = buildLanes(DEFAULT_MODEL_ENTRIES);
  const healthMap = new Map();
  for (const l of lanes) {
    healthMap.set(l.id, {
      deadSession: false,
      cooldownUntil: 0,
      minuteRequestCount: 0,
      minuteTokenCount: 0,
    });
  }

  const calls = [];
  const router = new Router({
    getLanes: () => lanes,
    isProviderConfigured: () => true,
    healthFor: (id) => healthMap.get(id),
    sendVia: async (lane, req) => {
      calls.push(lane.id);
      return { ok: true, content: "ok" };
    },
  });

  // With minOutputTokens = 16000, 5,500 token Groq lanes must be filtered out
  const res = await router.send("codegen", [{ role: "user", content: "build site" }], {
    minOutputTokens: 16000,
  });

  assert.equal(res.ok, true);
  assert.ok(res.laneUsed.maxOutputTokens >= 16000);
  assert.notEqual(res.laneUsed.provider, "groq");
});

test("Phase 2: Model pinning keeps the exact same lane across calls", async () => {
  const lanes = buildLanes(DEFAULT_MODEL_ENTRIES);
  const healthMap = new Map();
  for (const l of lanes) {
    healthMap.set(l.id, {
      deadSession: false,
      cooldownUntil: 0,
      minuteRequestCount: 0,
      minuteTokenCount: 0,
    });
  }

  const calls = [];
  const router = new Router({
    getLanes: () => lanes,
    isProviderConfigured: () => true,
    healthFor: (id) => healthMap.get(id),
    sendVia: async (lane, req) => {
      calls.push(lane.id);
      return { ok: true, content: "ok" };
    },
  });

  // Normally priority 1 (gemini-3.8-flash) would run first.
  // When pinned to priority 2 (gemini-2.5-flash), it must run the pinned lane!
  const res = await router.send("codegen", [{ role: "user", content: "repair snippet" }], {
    pinnedLaneId: "gemini:gemini-2.5-flash",
  });

  assert.equal(res.ok, true);
  assert.equal(res.laneUsed.id, "gemini:gemini-2.5-flash");
  assert.equal(calls[0], "gemini:gemini-2.5-flash");
});

test("Phase 2: Wait-for-best-lane waits if cooldown <= waitBudget, but switches if wait exceeds budget", async () => {
  const lanes = [
    {
      id: "gemini:best",
      provider: "gemini",
      model: "gemini-3.8-flash",
      role: "reasoning",
      priority: 1,
      maxTokens: 32000,
      maxOutputTokens: 32000,
      limits: { rpm: 15, rpd: 1500, tpm: null, maxTokensPerRequest: null, resetHourUtc: 0 },
    },
    {
      id: "gemini:fallback",
      provider: "gemini",
      model: "gemini-2.5-flash",
      role: "general",
      priority: 2,
      maxTokens: 32000,
      maxOutputTokens: 32000,
      limits: { rpm: 15, rpd: 1500, tpm: null, maxTokensPerRequest: null, resetHourUtc: 0 },
    },
  ];

  let bestCooldownUntil = Date.now() + 50; // Short 50ms cooldown (well within 20s budget)
  const healthMap = new Map();
  healthMap.set("gemini:best", {
    deadSession: false,
    get cooldownUntil() {
      return bestCooldownUntil;
    },
    minuteRequestCount: 0,
    minuteTokenCount: 0,
  });
  healthMap.set("gemini:fallback", {
    deadSession: false,
    cooldownUntil: 0,
    minuteRequestCount: 0,
    minuteTokenCount: 0,
  });

  const countdowns = [];
  const router = new Router({
    getLanes: () => lanes,
    isProviderConfigured: () => true,
    healthFor: (id) => healthMap.get(id),
    sendVia: async (lane, req) => ({ ok: true, content: "ok" }),
  });

  // Case A: Short cooldown <= waitBudget -> router waits and executes on BEST lane
  const resA = await router.send("codegen", [{ role: "user", content: "site" }], {
    waitForBestLane: true,
    waitBudgetSeconds: 20,
    onWaitCountdown: (info) => countdowns.push(info),
  });
  assert.equal(resA.ok, true);
  assert.equal(resA.laneUsed.id, "gemini:best");
  assert.ok(countdowns.length > 0);

  // Case B: Cooldown of 45s (> 20s budget) -> router switches to fallback lane
  bestCooldownUntil = Date.now() + 45_000;
  const switchedEvents = [];
  const routerB = new Router({
    getLanes: () => lanes,
    isProviderConfigured: () => true,
    healthFor: (id) => healthMap.get(id),
    onLaneEvent: (e) => switchedEvents.push(e),
    sendVia: async (lane, req) => ({ ok: true, content: "fallback ok" }),
  });

  const resB = await routerB.send("codegen", [{ role: "user", content: "site" }], {
    waitForBestLane: true,
    waitBudgetSeconds: 20,
  });
  assert.equal(resB.ok, true);
  assert.equal(resB.laneUsed.id, "gemini:fallback");
});
