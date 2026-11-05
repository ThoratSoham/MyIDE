const test = require("node:test");
const assert = require("node:assert/strict");
const { installElectronStub } = require("./helpers/harness");

installElectronStub();

const {
  startRunTelemetry,
  withRunTelemetry,
  currentTelemetry,
  finishRunTelemetry,
  formatRunStatsLine,
  loadStoredTelemetry,
} = require("../dist/main/telemetry");
const { parseJsonLoose } = require("../dist/main/quality/json-repair");

test("RunTelemetryTracker records calls, tokens, retries, repairs, failed edits, and persists locally", async () => {
  const tracker = startRunTelemetry("run-test-1");

  await withRunTelemetry(tracker, async () => {
    assert.equal(currentTelemetry(), tracker);
    tracker.recordModelCall({ inputTokens: 1200, outputTokens: 300 });
    tracker.recordModelCall({ promptChars: 700, completionChars: 350 });
    tracker.recordRetry("429");
    tracker.recordRetry("5xx");
    tracker.recordDeadLane();
    tracker.recordFailedEditFile();
    tracker.recordToolCall();
    tracker.recordToolCall();
    tracker.recordVerification(true);

    // Trigger malformed JSON repair inside active telemetry context
    const parsed = parseJsonLoose("Here is JSON:\n```json\n{\"thought\": \"hi\",}\n```");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.repaired, true);
  });

  const stats = finishRunTelemetry("run-test-1", true);
  assert.ok(stats);
  assert.equal(stats.modelCalls, 2);
  assert.equal(stats.inputTokens, 1400);
  assert.equal(stats.outputTokens, 400);
  assert.equal(stats.retries, 2);
  assert.equal(stats.retries429, 1);
  assert.equal(stats.retries5xx, 1);
  assert.equal(stats.retries413, 0);
  assert.equal(stats.deadLaneEvents, 1);
  assert.equal(stats.malformedJsonRepairs, 1);
  assert.equal(stats.failedEditFileAttempts, 1);
  assert.equal(stats.toolCallsExecuted, 2);
  assert.equal(stats.verificationPassed, true);

  const line = formatRunStatsLine(stats);
  assert.match(line, /2 calls/);
  assert.match(line, /1\.8k tokens/);
  assert.match(line, /2 retries/);
  assert.match(line, /verified ✓/);

  const stored = loadStoredTelemetry();
  assert.ok(stored.some((r) => r.runId === "run-test-1"));
});

