import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApprovalDecision,
  ApprovalRequest,
  InterruptedRun,
  JobEvent,
  JobMode,
  JobSnapshot,
} from "../../shared/electron-api-types";

// FR-12.1: one place in the renderer that knows about the running job. It
// subscribes to the main-process event stream and keeps a snapshot that the
// chat, pipeline and status bar all read.

export interface JobController {
  snapshot: JobSnapshot | null;
  approvals: ApprovalRequest[];
  interrupted: InterruptedRun | null;
  startWebsite: (brief: string, mode: JobMode) => Promise<void>;
  startAgent: (task: string, mode: JobMode) => Promise<void>;
  note: (text: string) => Promise<void>;
  cancel: () => Promise<void>;
  resume: () => Promise<void>;
  respond: (id: string, decision: ApprovalDecision) => Promise<void>;
  dismissInterrupted: () => void;
}

interface Options {
  onPreview: (path: string) => void;
}

export function useJob({ onPreview }: Options): JobController {
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [interrupted, setInterrupted] = useState<InterruptedRun | null>(null);

  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;

  const refresh = useCallback(async () => {
    const snap = await window.electron.jobs.snapshot();
    setSnapshot(snap);
    if (!snap?.running && snap?.finishedAt) setInterrupted(null);
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, 50);
    };

    const off = window.electron.jobs.onEvent((e: JobEvent) => {
      if (!alive) return;
      switch (e.type) {
        case "preview":
          previewRef.current(e.path);
          return;
        case "approval":
          setApprovals((prev) => (prev.some((a) => a.id === e.request.id) ? prev : [...prev, e.request]));
          return;
        case "approval-resolved":
          setApprovals((prev) => prev.filter((a) => a.id !== e.id));
          return;
        default:
          scheduleRefresh();
      }
    });

    void Promise.all([refresh(), window.electron.jobs.pendingApprovals().then(setApprovals)]);
    void window.electron.jobs.interrupted().then(setInterrupted);

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [refresh]);

  const startWebsite = useCallback(
    async (brief: string, mode: JobMode) => {
      const snap = await window.electron.jobs.startWebsite(brief, mode);
      setSnapshot(snap);
      setInterrupted(null);
    },
    [],
  );

  const startAgent = useCallback(async (task: string, mode: JobMode) => {
    const snap = await window.electron.jobs.startAgent(task, mode);
    setSnapshot(snap);
    setInterrupted(null);
  }, []);

  const note = useCallback(async (text: string) => {
    await window.electron.jobs.note(text);
  }, []);

  const cancel = useCallback(async () => {
    await window.electron.jobs.cancel();
  }, []);

  const resume = useCallback(async () => {
    await window.electron.jobs.resume();
    setInterrupted(null);
    await refresh();
  }, [refresh]);

  const respond = useCallback(async (id: string, decision: ApprovalDecision) => {
    await window.electron.jobs.respondApproval(id, decision);
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const dismissInterrupted = useCallback(() => setInterrupted(null), []);

  return {
    snapshot,
    approvals,
    interrupted,
    startWebsite,
    startAgent,
    note,
    cancel,
    resume,
    respond,
    dismissInterrupted,
  };
}
