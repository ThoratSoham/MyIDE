/* Unit tests for PART 1, PART 2, and PART 3:
 * - Router status-code handling:
 *   1) 404 / 400 "model unavailable": session-dead mark, 0 retries, suggested replacement slug extraction (no silent swap), skip on subsequent calls
 *   2) 429 / quota: honors Retry-After header, exponential backoff + jitter (max 3 retries per lane), sets per-lane cooldown, falls to next lane
 *   3) 401 / 403: stops immediately with "check your API key", never rotates lanes
 *   4) 5xx / network: retries once with backoff, then falls to next lane
 *   5) All lanes exhausted: per-lane reasons, local-time resume estimate only from real cooldowns/quota, UI actions ("Retry now", "Edit models", "Add API key")
 *   6) Cancellation with AbortController: stops in-flight or mid-backoff immediately
 * - Efficiency: ProviderConcurrencyLimiter (max 2 per provider + FIFO queue), RequestDeduplicator
 * - Build / exports: agent/index.ts & agent/loop.ts export loadRun, getRun, listRuns, interruptedRuns, stopRun
 * - Popup questions (ask_user) + session persistence in userData
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const { REPO, installElectronStub, freshWorkspace, waitForIdle, okReply } =
  require(path.join(__dirname, "helpers", "harness.js"));

installElectronStub();

const { Router, computeExponentialBackoffMs } = require(path.join(REPO, "dist", "main", "ai", "router.js"));
const { Ledger } = require(path.join(REPO, "dist", "main", "ai", "ledger.js"));
const { buildLanes } = require(path.join(REPO, "dist", "main", "ai", "providers.js"));
const { classifyHttpError } = require(path.join(REPO, "dist", "main", "ai", "real-providers.js"));
const { parseRetryAfterMs, extractSuggestedModel } = require(path.join(REPO, "dist", "main", "ai", "http.js"));
const { ProviderConcurrencyLimiter, RequestDeduplicator } = require(
  path.join(REPO, "dist", "main", "ai", "concurrency.js"),
);
const { DEFAULT_MODEL_ENTRIES, saveModelSettings, loadModelSettings, replaceOrAddSuggestedModel } = require(
  path.join(REPO, "dist", "main", "ai", "model-settings.js"),
);
const agentIndex = require(path.join(REPO, "dist", "main", "agent", "index.js"));
const agentLoop = require(path.join(REPO, "dist", "main", "agent", "loop.js"));
const { setWorkspaceRoot } = require(path.join(REPO, "dist", "main", "fs-workspace.js"));
const { JobManager } = require(path.join(REPO, "dist", "main", "jobs.js"));

/** Build a test Router backed by a real Ledger and scripted per-lane handlers. */
function makeRouterHarness(modelConfigs, handlers, extraConfig = {}) {
  const lanes = buildLanes(modelConfigs).filter((l) => l.provider !== "offline");
  const laneById = new Map(lanes.map((l) => [l.id, l]));
  const ledger = new Ledger();
  ledger.load(lanes);

  const callsByLane = new Map();
  const sleeps = [];
  const laneEvents = [];

  const router = new Router({
    getLanes: () => lanes,
    isProviderConfigured: () => true,
    healthFor: (laneId) => {
      const lane = laneById.get(laneId);
      return lane ? ledger.healthFor(lane) : undefined;
    },
    markSessionDead: (lane, reason, suggestedModel) => {
      ledger.markSessionDead(lane, reason, suggestedModel);
    },
    setLaneCooldown: (lane, untilMs, reason) => {
      ledger.setCooldown(lane, untilMs, reason);
    },
    onOutcome: (lane, outcome, estimatedTokens) => {
      if (outcome.ok) {
        ledger.recordSend(lane, outcome.usage?.totalTokens ?? estimatedTokens);
      } else if (outcome.error.kind === "rateLimitDay") {
        ledger.markDayExhausted(lane, outcome.error.waitUntilMs);
      }
    },
    onLaneEvent: (ev) => laneEvents.push(ev),
    sendVia: async (lane, req) => {
      callsByLane.set(lane.id, (callsByLane.get(lane.id) ?? 0) + 1);
      const fn = handlers[lane.id];
      if (!fn) {
        throw new Error(`No handler configured for lane ${lane.id}`);
      }
      return fn(callsByLane.get(lane.id), req, lane);
    },
    baseBackoffMs: 100,
    serverBackoffMs: 80,
    maxInlineWaitMs: 60_000,
    random: () => 0.2,
    sleepFn: async (ms, signal) => {
      if (signal?.aborted) {
        const err = new Error("Cancelled by user");
        err.name = "StreamCancelledError";
        throw err;
      }
      sleeps.push(ms);
    },
    ...extraConfig,
  });

  return { router, lanes, ledger, callsByLane, sleeps, laneEvents };
}

const SAMPLE_MODELS = [
  { id: "dead-free-model", provider: "openrouter", priority: 1, maxTokens: 16384, costTier: "free" },
  { id: "gemini-2.5-flash", provider: "gemini", priority: 2, maxTokens: 32768, costTier: "free" },
  { id: "llama-3.1-8b-instant", provider: "groq", priority: 3, maxTokens: 5500, costTier: "free" },
];

test("1. 404 / 400 'model unavailable': marks session-dead, 0 retries, surfaces suggestedModel without silent swap", async () => {
  const raw404Body = JSON.stringify({
    error: {
      message:
        "This model is unavailable for free. The paid version is available now - use this slug instead: meta-llama/llama-3.2-3b-instruct",
      code: 404,
    },
  });

  // Verify HTTP classifier extracts suggested slug and marks modelDead on both 404 and 400 "unavailable"
  assert.equal(extractSuggestedModel(raw404Body), "meta-llama/llama-3.2-3b-instruct");
  const err404 = classifyHttpError(404, raw404Body, {});
  assert.equal(err404.kind, "modelDead");
  assert.equal(err404.suggestedModel, "meta-llama/llama-3.2-3b-instruct");

  const err400Unavail = classifyHttpError(400, '{"error":"Model foo/bar does not exist or is unavailable"}', {});
  assert.equal(err400Unavail.kind, "modelDead");

  const { router, callsByLane, sleeps, laneEvents, ledger, lanes } = makeRouterHarness(SAMPLE_MODELS, {
    "openrouter:dead-free-model": async () => ({ ok: false, error: err404 }),
    "gemini:gemini-2.5-flash": async () => ({ ok: true, content: "Hello from lane 2" }),
    "groq:llama-3.1-8b-instant": async () => ({ ok: true, content: "Hello from lane 3" }),
  });

  const res1 = await router.send("reasoning", [{ role: "user", content: "hi" }]);
  assert.equal(res1.ok, true);
  assert.equal(res1.content, "Hello from lane 2");
  assert.equal(res1.laneUsed.id, "gemini:gemini-2.5-flash");

  // Never retried the 404 lane, no backoff sleep, no silent swap to meta-llama/llama-3.2-3b-instruct
  assert.equal(callsByLane.get("openrouter:dead-free-model"), 1);
  assert.equal(sleeps.length, 0);

  const deadEvt = laneEvents.find((e) => e.type === "model-dead");
  assert.ok(deadEvt, "router must emit a model-dead event for the UI");
  assert.equal(deadEvt.suggestedModel, "meta-llama/llama-3.2-3b-instruct");

  const deadHealth = ledger.healthFor(lanes[0]);
  assert.equal(deadHealth.deadSession, true);
  assert.equal(deadHealth.suggestedModel, "meta-llama/llama-3.2-3b-instruct");

  // Subsequent request in the same session MUST skip the dead model with 0 additional calls
  const res2 = await router.send("reasoning", [{ role: "user", content: "hi again" }]);
  assert.equal(res2.ok, true);
  assert.equal(callsByLane.get("openrouter:dead-free-model"), 1, "dead model must never be called again in session");
  assert.equal(callsByLane.get("gemini:gemini-2.5-flash"), 2);
});

test("2. 429 backoff: honors Retry-After, exponential backoff + jitter (max 3 retries), sets cooldown, then falls to next lane", async () => {
  assert.equal(parseRetryAfterMs({ "retry-after": "3" }), 3000);
  assert.equal(parseRetryAfterMs({ "retry-after-ms": "1500" }), 1500);

  const err429WithHeader = classifyHttpError(429, "Rate limit exceeded", { "retry-after": "2" });
  assert.equal(err429WithHeader.kind, "rateLimitMinute");
  assert.equal(err429WithHeader.retryAfterMs, 2000);

  const models = [
    { id: "gemini-2.5-flash", provider: "gemini", priority: 1, maxTokens: 32768, costTier: "free" },
    { id: "llama-3.1-8b-instant", provider: "groq", priority: 2, maxTokens: 5500, costTier: "free" },
  ];

  const { router, callsByLane, sleeps, ledger, lanes } = makeRouterHarness(models, {
    "gemini:gemini-2.5-flash": async (attempt) => ({
      ok: false,
      error: {
        kind: "rateLimitMinute",
        status: 429,
        message: "Too Many Requests",
        // First failure has Retry-After: 500ms; subsequent ones rely on exponential growth
        retryAfterMs: attempt === 1 ? 500 : undefined,
      },
    }),
    "groq:llama-3.1-8b-instant": async () => ({ ok: true, content: "Recovered on Groq" }),
  });

  const res = await router.send("reasoning", [{ role: "user", content: "test 429" }]);
  assert.equal(res.ok, true);
  assert.equal(res.content, "Recovered on Groq");
  assert.equal(res.laneUsed.id, "groq:llama-3.1-8b-instant");

  // 1 initial attempt + 3 retries = 4 total attempts on lane 1, then moved to lane 2
  assert.equal(callsByLane.get("gemini:gemini-2.5-flash"), 4);
  assert.equal(callsByLane.get("groq:llama-3.1-8b-instant"), 1);

  // Verify 3 backoff sleeps occurred and honored Retry-After (500ms floor + jitter on retry 0)
  assert.equal(sleeps.length, 3);
  const expected0 = computeExponentialBackoffMs(0, 100, 500, () => 0.2); // floor=500 + jitter=25 -> 525
  const expected1 = computeExponentialBackoffMs(1, 100, undefined, () => 0.2); // floor=200 + jitter=10 -> 210
  const expected2 = computeExponentialBackoffMs(2, 100, undefined, () => 0.2); // floor=400 + jitter=20 -> 420
  assert.deepEqual(sleeps, [expected0, expected1, expected2]);

  // Verify per-lane cooldown was set on lane 1 after exhausting its 3 retries
  const h1 = ledger.healthFor(lanes[0]);
  assert.ok(h1.cooldownUntil && h1.cooldownUntil > Date.now(), "lane 1 must have an active cooldown");
});

test("3. 401 / 403 unauthorized: stops immediately with 'check your API key' without rotating lanes", async () => {
  const err401 = classifyHttpError(401, '{"error":"Invalid API key"}', {});
  const err403 = classifyHttpError(403, '{"error":"Forbidden key"}', {});
  assert.equal(err401.kind, "unauthorized");
  assert.equal(err403.kind, "unauthorized");

  const { router, callsByLane } = makeRouterHarness(SAMPLE_MODELS, {
    "openrouter:dead-free-model": async () => ({ ok: false, error: err401 }),
    "gemini:gemini-2.5-flash": async () => ({ ok: true, content: "Should never be called" }),
    "groq:llama-3.1-8b-instant": async () => ({ ok: true, content: "Should never be called" }),
  });

  const res = await router.send("reasoning", [{ role: "user", content: "auth check" }]);
  assert.equal(res.ok, false);
  assert.equal(res.authStop, true);
  assert.match(res.error.message, /check your api key/i);

  // Must NOT rotate to lane 2 or lane 3
  assert.equal(callsByLane.get("openrouter:dead-free-model"), 1);
  assert.equal(callsByLane.get("gemini:gemini-2.5-flash") ?? 0, 0);
  assert.equal(callsByLane.get("groq:llama-3.1-8b-instant") ?? 0, 0);
});

test("4. 5xx / network errors: retries once with backoff, then falls to the next lane", async () => {
  const models = [
    { id: "gemini-2.5-flash", provider: "gemini", priority: 1, maxTokens: 32768, costTier: "free" },
    { id: "llama-3.1-8b-instant", provider: "groq", priority: 2, maxTokens: 5500, costTier: "free" },
  ];

  const { router, callsByLane, sleeps } = makeRouterHarness(models, {
    "gemini:gemini-2.5-flash": async () => ({
      ok: false,
      error: classifyHttpError(503, "Upstream overloaded", {}),
    }),
    "groq:llama-3.1-8b-instant": async () => ({ ok: true, content: "Fallback succeeded" }),
  });

  const res = await router.send("reasoning", [{ role: "user", content: "503 test" }]);
  assert.equal(res.ok, true);
  assert.equal(res.content, "Fallback succeeded");
  assert.equal(callsByLane.get("gemini:gemini-2.5-flash"), 2, "5xx must retry exactly once (2 calls total)");
  assert.equal(sleeps.length, 1, "exactly 1 backoff sleep before retry");
  assert.equal(callsByLane.get("groq:llama-3.1-8b-instant"), 1);
});

test("5. All lanes exhausted: reports real reason per lane, local resume estimate, and UI actions ('Retry now', 'Edit models', 'Add API key')", async () => {
  const futureReset = Date.now() + 20 * 60 * 1000;
  const { router } = makeRouterHarness(
    SAMPLE_MODELS,
    {
      "openrouter:dead-free-model": async () => ({
        ok: false,
        error: {
          kind: "modelDead",
          status: 404,
          message: "Model unavailable for free",
          suggestedModel: "meta-llama/llama-3.2-3b-instruct",
        },
      }),
      "gemini:gemini-2.5-flash": async () => ({
        ok: false,
        error: {
          kind: "rateLimitDay",
          status: 429,
          message: "Daily quota exceeded",
          waitUntilMs: futureReset,
        },
      }),
      "groq:llama-3.1-8b-instant": async () => ({
        ok: false,
        error: { kind: "serverError", status: 502, message: "Bad gateway" },
      }),
    },
  );

  const res = await router.send("reasoning", [{ role: "user", content: "exhaust all" }]);
  assert.equal(res.ok, false);
  assert.equal(res.allExhausted, true);
  assert.equal(res.laneDetails.length, 3);

  const byId = Object.fromEntries(res.laneDetails.map((d) => [d.laneId, d]));
  assert.equal(byId["openrouter:dead-free-model"].status, "dead");
  assert.equal(byId["openrouter:dead-free-model"].resumeAtMs, null, "dead models must never fake a quota timer");
  assert.equal(byId["openrouter:dead-free-model"].suggestedModel, "meta-llama/llama-3.2-3b-instruct");

  assert.equal(byId["gemini:gemini-2.5-flash"].status, "quota");
  assert.equal(byId["gemini:gemini-2.5-flash"].resumeAtMs, futureReset);

  assert.equal(byId["groq:llama-3.1-8b-instant"].status, "error");
  assert.equal(res.resumeAtMs, futureReset, "overall resumeAtMs reflects real quota reset");

  // Verify JobManager surfaces per-lane details AND all 3 required actions ("Retry now", "Edit models", "Add API key")
  const ws = freshWorkspace("exhausted-ui");
  setWorkspaceRoot(ws);
  const fakeExhaustedAI = {
    onWaiting: null,
    lastFailure: null,
    isOfflineMode: () => false,
    providerLabels: () => ({ openrouter: "OpenRouter", gemini: "Gemini", groq: "Groq" }),
    quotaSnapshot: () => [],
    init() {},
    reload() {},
    save() {},
    async complete() {
      return { ...res, pause: true };
    },
  };
  const jobs = new JobManager({
    ai: fakeExhaustedAI,
    workspaceRoot: () => ws,
    emit: () => {},
    onPreview: () => {},
    onOpenFile: () => {},
    onWorkspaceChanged: () => {},
  });

  jobs.start({ text: "explain this file", mode: "fast", intent: "explain" });
  const snap = await waitForIdle(jobs);
  const exhaustedMsg = snap.messages.find((m) => m.laneDetails && m.laneDetails.length === 3);
  assert.ok(exhaustedMsg, "chat must contain the detailed exhausted breakdown message");
  const actionLabels = (exhaustedMsg.actions ?? []).map((a) => a.label);
  assert.ok(actionLabels.includes("Retry now"), "must include 'Retry now' action");
  assert.ok(actionLabels.includes("Edit models"), "must include 'Edit models' action");
  assert.ok(actionLabels.includes("Add API key"), "must include 'Add API key' action");
  jobs.dispose();
});

test("6. Cancellation (AbortController): aborts in-flight request immediately without rotating lanes", async () => {
  const controller = new AbortController();
  const { router, callsByLane } = makeRouterHarness(SAMPLE_MODELS, {
    "openrouter:dead-free-model": async (_attempt, req) => {
      // Simulate aborting while lane 1 is in flight
      controller.abort();
      if (req.signal?.aborted) {
        const err = new Error("Request cancelled");
        err.name = "StreamCancelledError";
        throw err;
      }
      return { ok: true, content: "unexpected" };
    },
    "gemini:gemini-2.5-flash": async () => ({ ok: true, content: "should not reach lane 2" }),
    "groq:llama-3.1-8b-instant": async () => ({ ok: true, content: "should not reach lane 3" }),
  });

  const res = await router.send(
    "reasoning",
    [{ role: "user", content: "cancel me" }],
    { signal: controller.signal },
  );
  assert.equal(res.ok, false);
  assert.equal(res.cancelled, true);
  assert.equal(callsByLane.get("openrouter:dead-free-model"), 1);
  assert.equal(callsByLane.get("gemini:gemini-2.5-flash") ?? 0, 0);
});

test("7. Efficiency & settings: no ':free' default slugs, concurrency limiter (max 2), request deduplicator, and loop.ts exports", async () => {
  // Default model list has zero hard-coded ':free' slugs and persists to models.json
  assert.ok(DEFAULT_MODEL_ENTRIES.length > 0);
  for (const m of DEFAULT_MODEL_ENTRIES) {
    assert.ok(!m.id.includes(":free"), `default model ${m.id} must not be a hard-coded :free slug`);
  }
  saveModelSettings(DEFAULT_MODEL_ENTRIES);
  const loaded = loadModelSettings();
  assert.equal(loaded.length, DEFAULT_MODEL_ENTRIES.length);

  // One-click suggested model replacement updates models.json cleanly
  saveModelSettings([
    { id: "meta-llama/llama-3.2-3b-instruct:free", provider: "openrouter", priority: 1, maxTokens: 16384, costTier: "free" },
  ]);
  const swapped = replaceOrAddSuggestedModel(
    "openrouter",
    "meta-llama/llama-3.2-3b-instruct:free",
    "meta-llama/llama-3.2-3b-instruct",
  );
  assert.equal(swapped[0].id, "meta-llama/llama-3.2-3b-instruct");
  assert.equal(swapped[0].costTier, "low");

  // Concurrency limiter caps at 2 concurrent calls per provider and queues the 3rd
  const limiter = new ProviderConcurrencyLimiter(2);
  let peak = 0;
  let active = 0;
  const work = () =>
    limiter.run("openrouter", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 25));
      active -= 1;
      return "ok";
    });
  await Promise.all([work(), work(), work(), work()]);
  assert.equal(peak, 2, "must never exceed 2 concurrent requests for the same provider");

  // Deduplicator shares a single flight + streams deltas to all identical concurrent callers
  const dedup = new RequestDeduplicator();
  let upstreamFlights = 0;
  const deltasA = [];
  const deltasB = [];
  const [outA, outB] = await Promise.all([
    dedup.run(
      "same-key",
      async (_sig, emit) => {
        upstreamFlights += 1;
        await new Promise((r) => setTimeout(r, 15));
        emit("chunk-1");
        emit("chunk-2");
        return { ok: true, content: "chunk-1chunk-2" };
      },
      { onDelta: (c) => deltasA.push(c) },
    ),
    dedup.run(
      "same-key",
      async () => {
        upstreamFlights += 1;
        return { ok: true, content: "wrong" };
      },
      { onDelta: (c) => deltasB.push(c) },
    ),
  ]);
  assert.equal(upstreamFlights, 1, "identical concurrent requests must share 1 upstream call");
  assert.equal(outA.content, "chunk-1chunk-2");
  assert.equal(outB.content, "chunk-1chunk-2");
  assert.deepEqual(deltasA, ["chunk-1", "chunk-2"]);
  assert.deepEqual(deltasB, ["chunk-1", "chunk-2"]);

  // PART 1 #6: verify agent/index.ts & agent/loop.ts export loadRun, getRun, listRuns, interruptedRuns, stopRun
  for (const fnName of ["loadRun", "getRun", "listRuns", "interruptedRuns", "stopRun"]) {
    assert.equal(typeof agentLoop[fnName], "function", `loop.ts must export ${fnName}`);
    assert.equal(typeof agentIndex[fnName], "function", `agent/index.ts must export ${fnName}`);
  }
});

test("8. PART 3 Popup questions (ask_user) & PART 2 session persistence: pauses loop, resumes with answer or 'no answer' on dismiss, persists in chat history", async () => {
  const ws = freshWorkspace("ask-user");
  setWorkspaceRoot(ws);

  const observedToolResults = [];
  let step = 0;
  const scriptedAI = {
    onWaiting: null,
    lastFailure: null,
    isOfflineMode: () => false,
    providerLabels: () => ({ fake: "Fake" }),
    quotaSnapshot: () => [],
    init() {},
    reload() {},
    save() {},
    async complete(_task, messages) {
      step += 1;
      if (step === 1) {
        return okReply({
          thought: "Need user framework choice.",
          tool: "ask_user",
          args: {
            question: "Which UI library should I use?",
            options: [
              { label: "React", description: "Component-based UI" },
              { label: "Vanilla JS", description: "Zero dependencies" },
            ],
            allowMultiple: false,
          },
        });
      }
      if (step === 2) {
        observedToolResults.push(messages[messages.length - 1].content);
        return okReply({
          thought: "Ask optional follow-up.",
          tool: "ask_user",
          args: {
            question: "Include unit tests?",
            options: [{ label: "Yes" }, { label: "No" }],
            allowMultiple: false,
          },
        });
      }
      observedToolResults.push(messages[messages.length - 1].content);
      return okReply({ thought: "All set.", answer: "Configured with React." });
    },
  };

  const events = [];
  const jobs = new JobManager({
    ai: scriptedAI,
    workspaceRoot: () => ws,
    emit: (e) => events.push(e),
    onPreview: () => {},
    onOpenFile: () => {},
    onWorkspaceChanged: () => {},
  });

  jobs.start({ text: "set up project preferences", mode: "fast", intent: "explain" });

  // Wait for first popup question to pause the loop
  let pending = [];
  for (let i = 0; i < 60; i++) {
    pending = jobs.pendingQuestions();
    if (pending.length > 0) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(pending.length, 1, "agent loop must pause with 1 pending popup question");
  assert.equal(pending[0].question, "Which UI library should I use?");

  // Answer question 1 with "React"
  jobs.respondQuestion({
    id: pending[0].id,
    selectedLabels: ["React"],
    dismissed: false,
  });

  // Wait for second popup question and dismiss/cancel it -> must become "no answer"
  let pending2 = [];
  for (let i = 0; i < 60; i++) {
    pending2 = jobs.pendingQuestions();
    if (pending2.length > 0 && pending2[0].id !== pending[0].id) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(pending2.length, 1, "second popup question must pause loop");
  jobs.respondQuestion({
    id: pending2[0].id,
    selectedLabels: [],
    dismissed: true,
  });

  const snap = await waitForIdle(jobs);
  assert.match(observedToolResults[0], /React/, "chosen option must be returned to agent loop");
  assert.match(observedToolResults[1], /no answer/, "dismissed question must return 'no answer'");

  // Both questions + answers stay in chat history AND persisted session JSON on disk
  const qCards = snap.messages.filter((m) => m.userQuestion);
  assert.equal(qCards.length, 2, "both popup questions must remain in chat history");
  assert.equal(qCards[0].userQuestion.response.dismissed, false);
  assert.deepEqual(qCards[0].userQuestion.response.selectedLabels, ["React"]);
  assert.equal(qCards[1].userQuestion.response.dismissed, true);

  const sessionsList = jobs.listSessions();
  assert.ok(sessionsList.sessions.length >= 1, "session must be persisted in userData");
  assert.ok(sessionsList.activeSessionId, "activeSessionId must be tracked");

  jobs.dispose();
});

