import { create } from "zustand";

export interface OpenFileTarget {
  path: string;
  line?: number;
  nonce: number;
}

interface WorkspaceStore {
  root: string;
  workspaceKey: number;
  previewNonce: number;
  previewPath: string | null;
  openTarget: OpenFileTarget | null;
  files: string[];
  loadingFiles: boolean;

  setRoot: (root: string) => void;
  bumpWorkspace: () => void;
  openFile: (path: string, line?: number) => void;
  openPreview: (path: string) => void;
  closePreview: () => void;
  refreshFiles: () => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  root: "",
  workspaceKey: 0,
  previewNonce: 0,
  previewPath: null,
  openTarget: null,
  files: [],
  loadingFiles: false,

  setRoot: (root) => set({ root }),

  bumpWorkspace: () => {
    set((s) => ({ workspaceKey: s.workspaceKey + 1, previewNonce: s.previewNonce + 1 }));
    void get().refreshFiles();
  },

  openFile: (path, line) => {
    set({ openTarget: { path, line, nonce: Date.now() } });
  },

  openPreview: (path) => set({ previewPath: path }),

  closePreview: () => {
    void window.electron?.preview?.close().catch(() => undefined);
    set({ previewPath: null });
  },

  refreshFiles: async () => {
    if (!window.electron?.fs?.listFiles) return;
    set({ loadingFiles: true });
    try {
      const files = await window.electron.fs.listFiles(2500);
      set({ files, loadingFiles: false });
    } catch {
      set({ loadingFiles: false });
    }
  },
}));

