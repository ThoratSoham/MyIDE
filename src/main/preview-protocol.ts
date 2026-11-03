import { protocol } from "electron";
import path from "path";
import fs from "fs";

// FR-11.1: a private myide-ws:// protocol that serves ONLY workspace files.
// The renderer loads a workspace file into a sandboxed iframe using this scheme
// so no arbitrary remote content is ever loaded into the preview (FR-13.4).
//
// Callback signature (electron 33): (response: string | ProtocolResponse) => void
// where ProtocolResponse.error is a number (net error code) and .path is the file.

const NET_ERR_NOT_FOUND = -6;    // net::ERR_NOT_FOUND
const NET_ERR_ACCESS_DENIED = -15; // net::ERR_ACCESS_DENIED

export function registerPreviewProtocol() {
  protocol.registerFileProtocol("myide-ws", (request, callback) => {
    let workspacePath = request.url;
    if (workspacePath.startsWith("myide-ws://")) {
      workspacePath = workspacePath.slice("myide-ws://".length);
    }
    workspacePath = workspacePath.replace(/^\/+/, "");

    const rootPath = (globalThis as any).__MYIDE_WORKSPACE_ROOT__;
    if (!rootPath) {
      callback({ error: NET_ERR_NOT_FOUND });
      return;
    }

    const filePath = path.join(rootPath, workspacePath);

    // FR-5.3: only workspace files. Reject anything that escapes.
    if (!filePath.startsWith(rootPath + path.sep) && filePath !== rootPath) {
      callback({ error: NET_ERR_ACCESS_DENIED });
      return;
    }

    if (!fs.existsSync(filePath)) {
      callback({ error: NET_ERR_NOT_FOUND });
      return;
    }

    callback(filePath);
  });
}
