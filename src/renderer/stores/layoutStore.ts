import { create } from "zustand";
import type {
  ActivityId,
  AppViewMode,
  BottomTabId,
  LayoutState,
} from "../../shared/electron-api-types";

const DEFAULT_LAYOUT: LayoutState = {
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

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(partial: Partial<LayoutState>) {
  if (typeof window === "undefined" || !window.electron?.layout) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void window.electron.layout.set(partial).catch(() => undefined);
  }, 150);
}

export interface LayoutStore extends LayoutState {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setAppMode: (mode: AppViewMode) => void;
  toggleAppMode: () => void;
  setActiveActivity: (activity: ActivityId) => void;
  toggleActivity: (activity: ActivityId) => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setAgentPanelOpen: (open: boolean) => void;
  setAgentPanelWidth: (width: number) => void;
  toggleAgentDockSide: () => void;
  setBottomPanelOpen: (open: boolean) => void;
  setBottomPanelHeight: (height: number) => void;
  openBottomTab: (tab: BottomTabId) => void;
  syncEditorTabs: (openTabs: string[], activeTab: string | null) => void;
  resetLayout: () => void;
}

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  ...DEFAULT_LAYOUT,
  hydrated: false,

  hydrate: async () => {
    try {
      if (!window.electron?.layout) {
        set({ hydrated: true });
        return;
      }
      const saved = await window.electron.layout.get();
      set({ ...saved, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  setAppMode: (appMode) => {
    set({ appMode });
    schedulePersist({ appMode });
  },

  toggleAppMode: () => {
    const next: AppViewMode = get().appMode === "editor" ? "manager" : "editor";
    set({ appMode: next });
    schedulePersist({ appMode: next });
  },

  setActiveActivity: (activeActivity) => {
    set({ activeActivity, sidebarOpen: true, appMode: "editor" });
    schedulePersist({ activeActivity, sidebarOpen: true, appMode: "editor" });
  },

  toggleActivity: (activity) => {
    const cur = get();
    if (cur.appMode !== "editor") {
      set({ appMode: "editor", activeActivity: activity, sidebarOpen: true });
      schedulePersist({ appMode: "editor", activeActivity: activity, sidebarOpen: true });
      return;
    }
    if (cur.sidebarOpen && cur.activeActivity === activity) {
      set({ sidebarOpen: false });
      schedulePersist({ sidebarOpen: false });
    } else {
      set({ activeActivity: activity, sidebarOpen: true });
      schedulePersist({ activeActivity: activity, sidebarOpen: true });
    }
  },

  setSidebarOpen: (sidebarOpen) => {
    set({ sidebarOpen });
    schedulePersist({ sidebarOpen });
  },

  setSidebarWidth: (sidebarWidth) => {
    const clamped = Math.min(520, Math.max(180, Math.round(sidebarWidth)));
    set({ sidebarWidth: clamped });
    schedulePersist({ sidebarWidth: clamped });
  },

  setAgentPanelOpen: (agentPanelOpen) => {
    set({ agentPanelOpen });
    schedulePersist({ agentPanelOpen });
  },

  setAgentPanelWidth: (agentPanelWidth) => {
    const clamped = Math.min(820, Math.max(300, Math.round(agentPanelWidth)));
    set({ agentPanelWidth: clamped });
    schedulePersist({ agentPanelWidth: clamped });
  },

  toggleAgentDockSide: () => {
    const next = get().agentDockSide === "right" ? "left" : "right";
    set({ agentDockSide: next });
    schedulePersist({ agentDockSide: next });
  },

  setBottomPanelOpen: (bottomPanelOpen) => {
    set({ bottomPanelOpen });
    schedulePersist({ bottomPanelOpen });
  },

  setBottomPanelHeight: (bottomPanelHeight) => {
    const clamped = Math.min(680, Math.max(120, Math.round(bottomPanelHeight)));
    set({ bottomPanelHeight: clamped });
    schedulePersist({ bottomPanelHeight: clamped });
  },

  openBottomTab: (bottomTab) => {
    set({ bottomTab, bottomPanelOpen: true, appMode: "editor" });
    schedulePersist({ bottomTab, bottomPanelOpen: true, appMode: "editor" });
  },

  syncEditorTabs: (openTabs, activeTab) => {
    set({ openTabs, activeTab });
    schedulePersist({ openTabs, activeTab });
  },

  resetLayout: () => {
    const recent = get().recentWorkspaces;
    const fresh = { ...DEFAULT_LAYOUT, recentWorkspaces: recent };
    set(fresh);
    schedulePersist(fresh);
  },
}));

