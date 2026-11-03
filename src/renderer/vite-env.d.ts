/// <reference types="vite/client" />

import type { ElectronApi } from "../shared/electron-api-types";

declare global {
  interface Window {
    electron: ElectronApi;
  }
}

export {};
