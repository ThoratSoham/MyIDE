import fs from "fs";
import log from "electron-log";
import type { WorkspaceChanged } from "../shared/electron-api-types";
import { invalidateRepoMapCache } from "./context/repo-map";

// PART 3 point 6: when files change on disk the explorer, the open tabs and the
// preview must refresh by themselves. One recursive watcher per active root,
// debounced, ignoring our own bookkeeping folders (.myide) so backups, trash and
// chat history never cause a refresh storm.

let watcher: fs.FSWatcher | null = null;
let watchedDir: string | null = null;
let sink: ((e: WorkspaceChanged) => void) | null = null;
let timer: NodeJS.Timeout | null = null;
let lastPath = "";

export function setWorkspaceChangeSink(fn: ((e: WorkspaceChanged) => void) | null): void {
  sink = fn;
}

function schedule(rel: string): void {
  const clean = rel.replace(/\\/g, "/");
  // Our own state lives in .myide (chat history, backups, trash, verify shots).
  if (clean === ".myide" || clean.startsWith(".myide/")) return;
  lastPath = clean;
  if (timer) clearTimeout(timer);
  // Editors write in bursts (write + rename + chmod); one refresh per burst is
  // plenty and keeps the tree from flickering.
  timer = setTimeout(flush, 150);
}

function flush(): void {
  timer = null;
  if (!watchedDir) return;
  invalidateRepoMapCache(watchedDir, lastPath || undefined);
  try {
    sink?.({ path: lastPath || watchedDir, kind: "file" });
  } catch (e) {
    log.warn("workspace change sink failed", e);
  }
}

/** Watch one workspace root. Safe to call repeatedly with the same path. */
export function watchWorkspace(dir: string): void {
  if (watchedDir === dir && watcher) return;
  stopWatching();
  watchedDir = dir;
  try {
    watcher = fs.watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
      schedule(filename ? String(filename) : "");
    });
  } catch (e) {
    // Some Linux setups reject recursive watch. Fall back to the top level so
    // new top-level files still refresh the tree.
    try {
      watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        schedule(filename ? String(filename) : "");
      });
      log.warn("workspace watch: recursive mode unavailable, watching the top level only");
    } catch (e2) {
      watcher = null;
      log.warn("workspace watch failed", e2 ?? e);
    }
  }
}

export function stopWatching(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* already gone */
    }
    watcher = null;
  }
  watchedDir = null;
}
