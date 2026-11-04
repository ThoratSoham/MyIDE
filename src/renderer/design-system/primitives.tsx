import React, { useCallback, useRef } from "react";

export function Kbd({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={`inline-flex items-center rounded border border-[var(--nova-border)] bg-[var(--nova-bg-elevated)] px-1.5 py-0.5 font-mono text-[10px] leading-none text-[var(--nova-text-muted)] ${className}`}
    >
      {children}
    </kbd>
  );
}

export function Badge({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  children: React.ReactNode;
  className?: string;
}) {
  const styles: Record<string, string> = {
    neutral: "bg-[var(--nova-bg-elevated)] text-[var(--nova-text-secondary)] border-[var(--nova-border)]",
    accent: "bg-[var(--nova-accent-soft)] text-[var(--nova-accent-bright)] border-[var(--nova-accent-border)]",
    success: "bg-[var(--nova-success-soft)] text-[var(--nova-success)] border-[var(--nova-success)]/30",
    warning: "bg-[var(--nova-warning-soft)] text-[var(--nova-warning)] border-[var(--nova-warning)]/30",
    danger: "bg-[var(--nova-danger-soft)] text-[var(--nova-danger)] border-[var(--nova-danger)]/30",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide ${styles[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function StatusDot({
  state,
}: {
  state: "running" | "waiting" | "done" | "failed" | "idle";
}) {
  const map: Record<typeof state, string> = {
    running: "bg-[var(--nova-accent-bright)] nova-status-pulse",
    waiting: "bg-[var(--nova-warning)] animate-pulse",
    done: "bg-[var(--nova-success)]",
    failed: "bg-[var(--nova-danger)]",
    idle: "bg-[var(--nova-text-faint)]",
  };
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${map[state]}`} aria-hidden="true" />;
}

export function ResizeSeparator({
  orientation,
  label,
  value,
  min,
  max,
  invertDelta = false,
  onChange,
}: {
  orientation: "vertical" | "horizontal";
  label: string;
  value: number;
  min: number;
  max: number;
  invertDelta?: boolean;
  onChange: (next: number) => void;
}) {
  const dragRef = useRef<{ startPos: number; startVal: number } | null>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startPos = orientation === "vertical" ? e.clientX : e.clientY;
      dragRef.current = { startPos, startVal: value };
      document.body.style.cursor = orientation === "vertical" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const curPos = orientation === "vertical" ? ev.clientX : ev.clientY;
        const rawDelta = curPos - dragRef.current.startPos;
        const delta = invertDelta ? -rawDelta : rawDelta;
        const clamped = Math.min(max, Math.max(min, Math.round(dragRef.current.startVal + delta)));
        onChange(clamped);
      };
      const onUp = () => {
        dragRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [invertDelta, max, min, onChange, orientation, value],
  );

  const step = 20;

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={(e) => {
        if (orientation === "vertical") {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            onChange(Math.min(max, Math.max(min, value + (invertDelta ? step : -step))));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            onChange(Math.min(max, Math.max(min, value + (invertDelta ? -step : step))));
          }
        } else {
          if (e.key === "ArrowUp") {
            e.preventDefault();
            onChange(Math.min(max, Math.max(min, value + (invertDelta ? step : -step))));
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            onChange(Math.min(max, Math.max(min, value + (invertDelta ? -step : step))));
          }
        }
      }}
      className={
        orientation === "vertical"
          ? "group relative z-10 w-1 flex-none cursor-col-resize bg-[var(--nova-border-subtle)] hover:bg-[var(--nova-accent)] focus:bg-[var(--nova-accent)]"
          : "group relative z-10 h-1 w-full flex-none cursor-row-resize bg-[var(--nova-border-subtle)] hover:bg-[var(--nova-accent)] focus:bg-[var(--nova-accent)]"
      }
      title={label}
    />
  );
}

