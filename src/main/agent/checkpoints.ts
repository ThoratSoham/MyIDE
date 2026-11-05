import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface FileSnapshot {
  relPath: string;
  existedBefore: boolean;
  originalContent: string | null;
  hashBefore: string | null;
  timestamp: number;
}

export interface RunManifest {
  runId: string;
  createdAt: number;
  files: Record<string, FileSnapshot>;
}

export interface RunFileDiff {
  path: string;
  runId: string;
  before: string;
  after: string;
  addedLines: number;
  removedLines: number;
  isNew: boolean;
  isDeleted: boolean;
}

export interface RevertResult {
  ok: boolean;
  path: string;
  action: "restored" | "deleted_to_trash" | "unchanged";
  message: string;
}

export interface UndoRunResult {
  ok: boolean;
  runId: string;
  revertedFiles: string[];
  trashedFiles: string[];
  message: string;
}

function normalizeRel(rel: string): string {
  return rel.split("\\").join("/").replace(/^\/+/, "");
}

function runBackupDir(workspaceRoot: string, runId: string): string {
  return path.join(workspaceRoot, ".myide", "backups", "runs", runId);
}

function manifestPath(workspaceRoot: string, runId: string): string {
  return path.join(runBackupDir(workspaceRoot, runId), "manifest.json");
}

function blobPath(workspaceRoot: string, runId: string, relPath: string): string {
  const safeName = relPath.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(runBackupDir(workspaceRoot, runId), "blobs", safeName);
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function loadRunManifest(workspaceRoot: string, runId: string): RunManifest {
  const mfPath = manifestPath(workspaceRoot, runId);
  try {
    if (fs.existsSync(mfPath)) {
      const parsed = JSON.parse(fs.readFileSync(mfPath, "utf8")) as RunManifest;
      return parsed;
    }
  } catch {
    /* fallback to empty */
  }
  return { runId, createdAt: Date.now(), files: {} };
}

export function saveRunManifest(workspaceRoot: string, manifest: RunManifest): void {
  const dir = runBackupDir(workspaceRoot, manifest.runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(workspaceRoot, manifest.runId), JSON.stringify(manifest, null, 2), "utf8");
}

/**
 * Snapshot pre-run state before the first write/edit/delete of this file within this runId.
 */
export function snapshotFileForRun(workspaceRoot: string, runId: string, relPath: string): void {
  if (!runId) return;
  const norm = normalizeRel(relPath);
  const manifest = loadRunManifest(workspaceRoot, runId);
  if (manifest.files[norm]) {
    // Already snapshotted for this run
    return;
  }

  const abs = path.join(workspaceRoot, norm);
  let existed = false;
  let content: string | null = null;
  let hash: string | null = null;

  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      existed = true;
      content = fs.readFileSync(abs, "utf8");
      hash = hashContent(content);
      const bPath = blobPath(workspaceRoot, runId, norm);
      fs.mkdirSync(path.dirname(bPath), { recursive: true });
      fs.writeFileSync(bPath, content, "utf8");
    }
  } catch {
    existed = false;
    content = null;
    hash = null;
  }

  manifest.files[norm] = {
    relPath: norm,
    existedBefore: existed,
    originalContent: content,
    hashBefore: hash,
    timestamp: Date.now(),
  };

  saveRunManifest(workspaceRoot, manifest);
}

/**
 * Compute line-level diff stats (+added, -removed) between two text versions.
 */
export function computeLineDiffStats(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 };
  const beforeLines = before ? before.split(/\r?\n/) : [];
  const afterLines = after ? after.split(/\r?\n/) : [];

  if (beforeLines.length === 0) return { added: afterLines.length, removed: 0 };
  if (afterLines.length === 0) return { added: 0, removed: beforeLines.length };

  const beforeCounts = new Map<string, number>();
  for (const l of beforeLines) beforeCounts.set(l, (beforeCounts.get(l) ?? 0) + 1);

  const afterCounts = new Map<string, number>();
  for (const l of afterLines) afterCounts.set(l, (afterCounts.get(l) ?? 0) + 1);

  let removed = 0;
  for (const [line, count] of beforeCounts.entries()) {
    const afterC = afterCounts.get(line) ?? 0;
    if (count > afterC) removed += count - afterC;
  }

  let added = 0;
  for (const [line, count] of afterCounts.entries()) {
    const beforeC = beforeCounts.get(line) ?? 0;
    if (count > beforeC) added += count - beforeC;
  }

  return { added, removed };
}

/**
 * Get diff for a single changed file from a run.
 */
export function getRunFileDiff(workspaceRoot: string, runId: string, relPath: string): RunFileDiff {
  const norm = normalizeRel(relPath);
  const manifest = loadRunManifest(workspaceRoot, runId);
  const snap = manifest.files[norm];

  const before = snap?.originalContent ?? "";
  const abs = path.join(workspaceRoot, norm);
  let after = "";
  let isDeleted = false;
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      after = fs.readFileSync(abs, "utf8");
    } else {
      isDeleted = true;
    }
  } catch {
    isDeleted = true;
  }

  const isNew = snap ? !snap.existedBefore : false;
  const stats = computeLineDiffStats(before, after);

  return {
    path: norm,
    runId,
    before,
    after,
    addedLines: stats.added,
    removedLines: stats.removed,
    isNew,
    isDeleted,
  };
}

/**
 * Revert a single file modified/created/deleted in a specific run back to its pre-run state.
 */
export function revertFileFromRun(
  workspaceRoot: string,
  runId: string,
  relPath: string,
  deleteToTrashFn?: (absPath: string) => void,
): RevertResult {
  const norm = normalizeRel(relPath);
  const manifest = loadRunManifest(workspaceRoot, runId);
  const snap = manifest.files[norm];
  const abs = path.join(workspaceRoot, norm);

  if (!snap) {
    return {
      ok: false,
      path: norm,
      action: "unchanged",
      message: `No pre-run snapshot found for ${norm} in run ${runId}`,
    };
  }

  try {
    if (!snap.existedBefore) {
      if (fs.existsSync(abs)) {
        if (deleteToTrashFn) {
          deleteToTrashFn(abs);
        } else {
          const trashDir = path.join(workspaceRoot, ".myide", "trash");
          fs.mkdirSync(trashDir, { recursive: true });
          fs.renameSync(abs, path.join(trashDir, `${path.basename(abs)}.${Date.now()}.trash`));
        }
      }
      return {
        ok: true,
        path: norm,
        action: "deleted_to_trash",
        message: `Removed created file ${norm} to trash`,
      };
    }

    // Existed before -> restore original content
    const original = snap.originalContent ?? "";
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, original, "utf8");
    return {
      ok: true,
      path: norm,
      action: "restored",
      message: `Restored ${norm} to its pre-run state`,
    };
  } catch (e) {
    return {
      ok: false,
      path: norm,
      action: "unchanged",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Undo all changes from a run in one click: restores edited/deleted files and moves newly created files to trash.
 */
export function undoEntireRun(
  workspaceRoot: string,
  runId: string,
  deleteToTrashFn?: (absPath: string) => void,
): UndoRunResult {
  const manifest = loadRunManifest(workspaceRoot, runId);
  const files = Object.keys(manifest.files);

  if (files.length === 0) {
    return {
      ok: false,
      runId,
      revertedFiles: [],
      trashedFiles: [],
      message: `No file checkpoints found for run ${runId}`,
    };
  }

  const reverted: string[] = [];
  const trashed: string[] = [];

  for (const rel of files) {
    const res = revertFileFromRun(workspaceRoot, runId, rel, deleteToTrashFn);
    if (res.ok) {
      if (res.action === "restored") reverted.push(rel);
      else if (res.action === "deleted_to_trash") trashed.push(rel);
    }
  }

  return {
    ok: true,
    runId,
    revertedFiles: reverted,
    trashedFiles: trashed,
    message: `Undo complete: restored ${reverted.length} file(s), trashed ${trashed.length} created file(s)`,
  };
}

