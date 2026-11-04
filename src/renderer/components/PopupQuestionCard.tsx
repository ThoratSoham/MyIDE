import React, { useEffect, useRef, useState } from "react";
import type {
  UserQuestionRecord,
  UserQuestionRequest,
  UserQuestionResponse,
} from "../../shared/electron-api-types";

// PART 3: Popup questions (ask_user tool).
// Renders both an interactive modal dialog when the agent pauses for a user
// decision AND a persistent inline card in the chat history showing the
// question, options, "Other" free-text input, and the chosen answer.

interface InteractiveProps {
  request: UserQuestionRequest;
  onRespond: (res: UserQuestionResponse) => void;
  variant: "modal" | "inline";
  onMinimizeModal?: () => void;
}

export function InteractiveQuestionForm({
  request,
  onRespond,
  variant,
  onMinimizeModal,
}: InteractiveProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [otherText, setOtherText] = useState("");
  const [remainingSec, setRemainingSec] = useState<number | null>(
    request.expiresAtMs ? Math.max(0, Math.ceil((request.expiresAtMs - Date.now()) / 1000)) : null,
  );
  const firstBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (variant === "modal") {
      firstBtnRef.current?.focus();
    }
  }, [variant, request.id]);

  useEffect(() => {
    if (!request.expiresAtMs) {
      setRemainingSec(null);
      return;
    }
    const tick = () => {
      setRemainingSec(Math.max(0, Math.ceil((request.expiresAtMs! - Date.now()) / 1000)));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [request.expiresAtMs]);

  const toggleOption = (label: string) => {
    if (!request.allowMultiple) {
      if (!otherText.trim()) {
        onRespond({ id: request.id, selectedLabels: [label] });
        return;
      }
      setSelected([label]);
      return;
    }
    setSelected((prev) => (prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label]));
  };

  const submit = () => {
    const cleanOther = otherText.trim();
    if (selected.length === 0 && !cleanOther) return;
    onRespond({
      id: request.id,
      selectedLabels: selected,
      otherText: cleanOther || undefined,
    });
  };

  const dismiss = () => {
    onRespond({ id: request.id, selectedLabels: [], dismissed: true });
  };

  return (
    <div
      data-ask-user-card={variant}
      className={
        variant === "modal"
          ? "w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-2xl"
          : "mt-2 rounded-lg border border-[var(--color-accent)]/50 bg-[var(--color-base)] p-3"
      }
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <span className="inline-block rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-strong)]">
            Decision needed {request.allowMultiple ? "(select one or more)" : "(choose one)"}
          </span>
          <h3 className="mt-1.5 text-sm font-medium text-[var(--color-text)]">{request.question}</h3>
        </div>
        <div className="flex items-center gap-1.5">
          {remainingSec !== null && (
            <span
              className="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]"
              title="Time remaining before automatic dismiss"
            >
              {remainingSec}s
            </span>
          )}
          {variant === "modal" && onMinimizeModal && (
            <button
              type="button"
              onClick={onMinimizeModal}
              title="Answer inline in chat instead"
              aria-label="Minimize popup to inline chat card"
              className="rounded px-1.5 py-0.5 text-xs text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
            >
              –
            </button>
          )}
        </div>
      </div>

      <div className="space-y-1.5" role="group" aria-label={request.question}>
        {request.options.map((opt, idx) => {
          const isSelected = selected.includes(opt.label);
          return (
            <button
              key={opt.label}
              ref={idx === 0 ? firstBtnRef : undefined}
              type="button"
              aria-pressed={isSelected}
              onClick={() => toggleOption(opt.label)}
              className={`flex w-full items-start gap-2.5 rounded border px-3 py-2 text-left text-xs ${
                isSelected
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-text)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface-alt)] text-[var(--color-text)] hover:border-[var(--color-accent)]"
              }`}
            >
              <span className="mt-0.5 font-mono text-[11px] text-[var(--color-accent-strong)]">
                {request.allowMultiple ? (isSelected ? "☑" : "☐") : "○"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{opt.label}</span>
                {opt.description && (
                  <span className="mt-0.5 block text-[11px] text-[var(--color-muted)]">{opt.description}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-2.5">
        <label className="block text-[11px] text-[var(--color-muted)]">
          Other (free-text answer)
          <input
            type="text"
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                dismiss();
              }
            }}
            placeholder="Or type your own answer…"
            className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-text)]"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={dismiss}
          className="rounded border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
        >
          Dismiss (no answer)
        </button>
        {(request.allowMultiple || otherText.trim().length > 0 || selected.length > 0) && (
          <button
            type="button"
            disabled={selected.length === 0 && !otherText.trim()}
            onClick={submit}
            className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            Submit answer
          </button>
        )}
      </div>
    </div>
  );
}

export function PopupQuestionModal({
  request,
  onRespond,
  onMinimize,
}: {
  request: UserQuestionRequest;
  onRespond: (res: UserQuestionResponse) => void;
  onMinimize: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onRespond({ id: request.id, selectedLabels: [], dismissed: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request.id, onRespond]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Agent question"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
    >
      <InteractiveQuestionForm
        request={request}
        onRespond={onRespond}
        variant="modal"
        onMinimizeModal={onMinimize}
      />
    </div>
  );
}

export function PopupQuestionHistoryCard({
  record,
  onRespond,
}: {
  record: UserQuestionRecord;
  onRespond: (res: UserQuestionResponse) => void;
}) {
  if (!record.response) {
    return <InteractiveQuestionForm request={record} onRespond={onRespond} variant="inline" />;
  }

  const r = record.response;
  const noAnswer = r.dismissed || r.timedOut;
  const chosenSummary = noAnswer
    ? r.timedOut
      ? "No answer (timed out)"
      : "No answer (dismissed)"
    : [
        ...r.selectedLabels,
        ...(r.otherText ? [`Other: ${r.otherText}`] : []),
      ].join(", ") || "No answer";

  return (
    <div className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-base)] p-2.5 text-xs">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        Question answered
      </div>
      <div className="mb-1.5 font-medium text-[var(--color-text)]">{record.question}</div>
      <ul className="mb-2 space-y-1">
        {record.options.map((opt) => {
          const picked = r.selectedLabels.includes(opt.label);
          return (
            <li
              key={opt.label}
              className={`flex items-center gap-2 rounded px-2 py-1 text-[11px] ${
                picked
                  ? "bg-[var(--color-accent)]/15 font-medium text-[var(--color-text)]"
                  : "text-[var(--color-muted)]"
              }`}
            >
              <span>{picked ? "✓" : "·"}</span>
              <span>{opt.label}</span>
              {opt.description && <span className="text-[10px] opacity-80">— {opt.description}</span>}
            </li>
          );
        })}
      </ul>
      <div className="border-t border-[var(--color-border)] pt-1.5 text-[11px]">
        <span className="text-[var(--color-muted)]">Answer: </span>
        <span className={noAnswer ? "italic text-[var(--color-muted)]" : "font-medium text-[var(--color-positive)]"}>
          {chosenSummary}
        </span>
      </div>
    </div>
  );
}

