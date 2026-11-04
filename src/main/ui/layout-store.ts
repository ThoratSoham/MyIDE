import fs from "fs";
import path from "path";
import { app } from "electron";
import log from "electron-log";
import type { LayoutState } from "../../shared/electron-api-types";

// Step 2 / Step 5: Persist layout (active top-level mode, panel sizes,
// collapsed states, dock positions, active tabs, and open editor files) to
// <userData>/layout.json and restore on startup.

export function getDefaultLayout(): LayoutState {
  return {
    appMode: "editor",
    activeActivity: "explorer",
    sidebarOpen: true,
    sidebarWidth: 256,
    agentPanelOpen: true,
    agentPanelWidth: 420,
    agentDockSide: "right",
    bottomPanelOpen: false,
    bottomPanelHeight: 240,
    bottomTab: "terminal",
    openTabs: [],
    activeTab: null,
    recentWorkspaces: [],
  };
}

let cachedLayout: LayoutState | null = null;

function layoutFilePath(): string {
  return path.join(app.getPath("userData"), "layout.json");
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function sanitizeLayout(raw: Partial<LayoutState> | null | undefined): LayoutState {
  const d = getDefaultLayout();
  if (!raw || typeof raw !== "object") return d;
  return {
    appMode: raw.appMode === "manager" ? "manager" : "editor",
    activeActivity:
      raw.activeActivity === "search" ||
      raw.activeActivity === "git" ||
      raw.activeActivity === "artifacts" ||
      raw.activeActivity === "rules" ||
      raw.activeActivity === "inbox"
        ? raw.activeActivity
        : "explorer",
    sidebarOpen: typeof raw.sidebarOpen === "boolean" ? raw.sidebarOpen : d.sidebarOpen,
    sidebarWidth: clamp(raw.sidebarWidth, 180, 520, d.sidebarWidth),
    agentPanelOpen: typeof raw.agentPanelOpen === "boolean" ? raw.agentPanelOpen : d.agentPanelOpen,
    agentPanelWidth: clamp(raw.agentPanelWidth, 300, 820, d.agentPanelWidth),
    agentDockSide: raw.agentDockSide === "left" ? "left" : "right",
    bottomPanelOpen: typeof raw.bottomPanelOpen === "boolean" ? raw.bottomPanelOpen : d.bottomPanelOpen,
    bottomPanelHeight: clamp(raw.bottomPanelHeight, 120, 680, d.bottomPanelHeight),
    bottomTab:
      raw.bottomTab === "problems" || raw.bottomTab === "output" || raw.bottomTab === "quota"
        ? raw.bottomTab
        : "terminal",
    openTabs: Array.isArray(raw.openTabs)
      ? raw.openTabs.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 40)
      : [],
    activeTab: typeof raw.activeTab === "string" && raw.activeTab.length > 0 ? raw.activeTab : null,
    recentWorkspaces: Array.isArray(raw.recentWorkspaces)
      ? raw.recentWorkspaces.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 15)
      : [],
  };
}

export function getLayout(): LayoutState {
  if (cachedLayout) return { ...cachedLayout };
  const f = layoutFilePath();
  if (!fs.existsSync(f)) {
    cachedLayout = getDefaultLayout();
    return { ...cachedLayout };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<LayoutState>;
    cachedLayout = sanitizeLayout(parsed);
    return { ...cachedLayout };
  } catch (e) {
    log.warn("layout-store: failed to parse layout.json, using defaults", e);
    cachedLayout = getDefaultLayout();
    return { ...cachedLayout };
  }
}

export function setLayout(partial: Partial<LayoutState>): LayoutState {
  const current = getLayout();
  const merged = sanitizeLayout({ ...current, ...partial });
  cachedLayout = merged;
  try {
    const f = layoutFilePath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
    fs.renameSync(tmp, f);
  } catch (e) {
    log.warn("layout-store: failed to write layout.json", e);
  }
  return { ...merged };
}

export function recordRecentWorkspace(dir: string): LayoutState {
  const norm = path.resolve(dir);
  const cur = getLayout();
  const deduped = [norm, ...cur.recentWorkspaces.filter((w) => path.resolve(w) !== norm)].slice(0, 15);
  return setLayout({ recentWorkspaces: deduped });
}

