import React from "react";
import {
  Bell,
  Command,
  Cpu,
  FileCheck2,
  Files,
  GitBranch,
  type LucideIcon,
  Search,
  Settings,
  Sliders,
} from "lucide-react";
import type { ActivityId } from "../../../shared/electron-api-types";
import { MissionOrbitGlyph } from "../../branding/NovaBrand";
import { useLayoutStore } from "../../stores/layoutStore";
import { usePaletteStore } from "../../stores/paletteStore";

interface Props {
  inboxCount: number;
  changedFilesCount: number;
  onOpenModels: () => void;
  onOpenSettings: () => void;
}

const ITEMS: Array<{
  id: ActivityId;
  label: string;
  shortcut: string;
  Icon: LucideIcon;
}> = [
  { id: "explorer", label: "Explorer", shortcut: "Ctrl+Shift+E", Icon: Files },
  { id: "search", label: "Search in Workspace", shortcut: "Ctrl+Shift+F", Icon: Search },
  { id: "git", label: "Source Control", shortcut: "Ctrl+Shift+G", Icon: GitBranch },
  { id: "artifacts", label: "Artifacts & Plans", shortcut: "Ctrl+Shift+A", Icon: FileCheck2 },
  { id: "rules", label: "Rules, Workflows & MCP", shortcut: "Ctrl+Shift+R", Icon: Sliders },
  { id: "inbox", label: "Agent Inbox", shortcut: "Ctrl+Shift+I", Icon: Bell },
];

export function ActivityBar({ inboxCount, changedFilesCount, onOpenModels, onOpenSettings }: Props) {
  const { appMode, setAppMode, activeActivity, sidebarOpen, toggleActivity } = useLayoutStore();
  const { openCommands } = usePaletteStore();

  return (
    <nav
      aria-label="Activity Bar"
      data-activity-bar
      className="flex w-11 flex-none select-none flex-col items-center justify-between border-r border-[var(--nova-border)] bg-[var(--nova-bg-rail)] py-2"
    >
      <div className="flex flex-col items-center gap-1">
        {ITEMS.map(({ id, label, shortcut, Icon }) => {
          const active = appMode === "editor" && sidebarOpen && activeActivity === id;
          const badge = id === "inbox" ? inboxCount : id === "git" ? changedFilesCount : 0;
          return (
            <button
              key={id}
              type="button"
              data-activity-item={id}
              aria-label={label}
              aria-pressed={active}
              title={`${label} (${shortcut})`}
              onClick={() => toggleActivity(id)}
              className={`relative flex h-9 w-9 items-center justify-center rounded-lg ${
                active
                  ? "bg-[var(--nova-accent-soft)] text-[var(--nova-accent-bright)]"
                  : "text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
              }`}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-[var(--nova-accent-bright)]"
                />
              )}
              <Icon size={18} />
              {badge > 0 && (
                <span className="absolute right-1 top-1 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-[var(--nova-accent)] px-1 text-[9px] font-bold text-white">
                  {badge > 9 ? "9+" : badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col items-center gap-1">
        <button
          type="button"
          aria-label="Agent Manager (Mission Control)"
          title="Agent Manager — Mission Control (Ctrl+Shift+M)"
          onClick={() => setAppMode(appMode === "manager" ? "editor" : "manager")}
          className={`flex h-9 w-9 items-center justify-center rounded-lg ${
            appMode === "manager"
              ? "bg-[var(--nova-accent-soft)] text-[var(--nova-accent-bright)]"
              : "text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
          }`}
        >
          <MissionOrbitGlyph size={17} />
        </button>

        <button
          type="button"
          aria-label="Command Palette"
          title="Command Palette (Ctrl+Shift+P)"
          onClick={() => openCommands()}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
        >
          <Command size={17} />
        </button>

        <button
          type="button"
          aria-label="Model Routing & Free Tiers"
          title="Models & Routing Priority"
          onClick={onOpenModels}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
        >
          <Cpu size={17} />
        </button>

        <button
          type="button"
          aria-label="Settings"
          title="Settings (Ctrl+,)"
          onClick={onOpenSettings}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--nova-text-muted)] hover:bg-[var(--nova-bg-hover)] hover:text-[var(--nova-text-primary)]"
        >
          <Settings size={17} />
        </button>
      </div>
    </nav>
  );
}
