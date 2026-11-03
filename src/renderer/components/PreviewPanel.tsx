import React, { useEffect, useRef, useState } from "react";

// FR-11.1: preview via a private myide-ws:// protocol that serves ONLY workspace
// files. The main process registers the protocol and the renderer loads it into
// a sandboxed iframe (FR-13.4). For M1 the protocol handler is wired in main
// to serve the seeded workspace.

interface Props {
  path: string;
  onClose: () => void;
}

export function PreviewPanel({ path, onClose }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const src = `myide-ws://${path}`;
    const frame = iframeRef.current;
    if (!frame) return;

    loadedRef.current = false;
    setError(null);
    setLoaded(false);

    const timer = setTimeout(() => {
      if (!loadedRef.current) {
        setError("preview took too long to load");
      }
    }, 10000);

    const onLoad = () => {
      loadedRef.current = true;
      clearTimeout(timer);
      setLoaded(true);
    };
    const onError = () => {
      clearTimeout(timer);
      setError("preview could not load that file");
    };

    frame.addEventListener("load", onLoad);
    frame.addEventListener("error", onError);
    frame.src = src;

    return () => {
      clearTimeout(timer);
      frame.removeEventListener("load", onLoad);
      frame.removeEventListener("error", onError);
    };
  }, [path]);

  return (
    <div className="absolute right-0 top-0 z-40 h-full w-[55%] border-l border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-2">
        <span className="text-sm font-medium text-[var(--color-text)] truncate">
          Preview · {path.split("/").pop()}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)]"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>

      {/* Sandboxed iframe (FR-13.4). The myide-ws:// protocol serves only
      workspace files; no arbitrary remote content is loaded here. */}
      <iframe
        ref={iframeRef}
        sandbox="allow-same-origin allow-scripts"
        className="flex-1 bg-white"
        style={{ height: "100%" }}
      />

      {error && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded bg-[var(--color-negative)]/10 px-3 py-1.5 text-xs text-[var(--color-negative)]">
          {error}
        </div>
      )}

      {!loaded && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-surface-alt)] text-sm text-[var(--color-muted)]">
          Loading preview…
        </div>
      )}
    </div>
  );
}
