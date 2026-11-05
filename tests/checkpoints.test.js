const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  snapshotFileForRun,
  getRunFileDiff,
  revertFileFromRun,
  undoEntireRun,
  computeLineDiffStats,
} = require("../dist/main/agent/checkpoints");

test("computeLineDiffStats: correctly counts added and removed lines", () => {
  const before = "function oldCode() {\n  return 1;\n}\n";
  const after = "function oldCode() {\n  // added comment\n  return 2;\n}\n";
  const stats = computeLineDiffStats(before, after);
  assert.equal(stats.added, 2);
  assert.equal(stats.removed, 1);
});

test("Checkpoints & Revert: snapshots pre-run state, captures line diffs, reverts individual file, and undoes entire run", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "myide-checkpoint-test-"));
  const runId = "test-run-123";

  try {
    // 1. Create initial files before run starts
    const existingFile = path.join(tmpRoot, "src", "index.ts");
    fs.mkdirSync(path.dirname(existingFile), { recursive: true });
    fs.writeFileSync(existingFile, "const A = 1;\nconst B = 2;\n", "utf8");

    // 2. Snapshot file before modification
    snapshotFileForRun(tmpRoot, runId, "src/index.ts");

    // Modify existing file
    fs.writeFileSync(existingFile, "const A = 100;\nconst B = 2;\nconst C = 3;\n", "utf8");

    // 3. Create a brand new file within the run and snapshot it
    const newFile = path.join(tmpRoot, "src", "new.ts");
    snapshotFileForRun(tmpRoot, runId, "src/new.ts");
    fs.writeFileSync(newFile, "export const X = 42;\n", "utf8");

    // 4. Verify getRunFileDiff
    const diffExisting = getRunFileDiff(tmpRoot, runId, "src/index.ts");
    assert.equal(diffExisting.path, "src/index.ts");
    assert.equal(diffExisting.isNew, false);
    assert.equal(diffExisting.before, "const A = 1;\nconst B = 2;\n");
    assert.equal(diffExisting.after, "const A = 100;\nconst B = 2;\nconst C = 3;\n");
    assert.ok(diffExisting.addedLines >= 1);
    assert.ok(diffExisting.removedLines >= 1);

    const diffNew = getRunFileDiff(tmpRoot, runId, "src/new.ts");
    assert.equal(diffNew.isNew, true);
    assert.equal(diffNew.before, "");
    assert.equal(diffNew.after, "export const X = 42;\n");
    assert.ok(diffNew.addedLines >= 1);

    // 5. Test single file revert on src/index.ts
    const revertRes = revertFileFromRun(tmpRoot, runId, "src/index.ts");
    assert.equal(revertRes.ok, true);
    assert.equal(revertRes.action, "restored");
    assert.equal(fs.readFileSync(existingFile, "utf8"), "const A = 1;\nconst B = 2;\n");

    // Modify existingFile again to test full run undo
    fs.writeFileSync(existingFile, "const A = 999;\n", "utf8");

    // 6. Test undoEntireRun: restores existingFile and moves newFile to .myide/trash
    const undoRes = undoEntireRun(tmpRoot, runId);
    assert.equal(undoRes.ok, true);
    assert.ok(undoRes.revertedFiles.includes("src/index.ts"));
    assert.ok(undoRes.trashedFiles.includes("src/new.ts"));

    assert.equal(fs.readFileSync(existingFile, "utf8"), "const A = 1;\nconst B = 2;\n");
    assert.equal(fs.existsSync(newFile), false);

    // Verify trashed file exists in .myide/trash
    const trashDir = path.join(tmpRoot, ".myide", "trash");
    const trashedFiles = fs.readdirSync(trashDir);
    assert.ok(trashedFiles.some((f) => f.includes("new.ts")));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
