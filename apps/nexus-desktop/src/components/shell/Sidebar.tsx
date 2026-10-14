import {
  ChevronsUpDown,
  FolderGit2,
  Home,
  KeyRound,
  LayoutList,
  MonitorCog,
  Settings,
  ShieldCheck,
  Boxes,
  History,
  type LucideIcon,
} from "lucide-react";
import { useNexus, type Page } from "../../state/NexusContext";
import { StatusDot } from "../ui/primitives";

const NAV: Array<{ id: Page; label: string; icon: LucideIcon }> = [
  { id: "workspace", label: "Workspace", icon: Home },
  { id: "tasks", label: "Tasks", icon: LayoutList },
  { id: "control-room", label: "Control Room", icon: MonitorCog },
  { id: "models", label: "Models", icon: Boxes },
  { id: "sentry", label: "Sentry", icon: ShieldCheck },
  { id: "sessions", label: "Sessions", icon: History },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { page, setPage, tasks, runtime, appInfo } = useNexus();
  const taskCount = tasks.data?.available ? tasks.data.tasks.length : null;
  const conn = runtime?.connection;
  const connected = conn === "connected";
  const go = (p: Page) => {
    setPage(p);
    onNavigate?.();
  };
  const project = appInfo.data?.ledgerDir ? baseName(appInfo.data.ledgerDir) : null;
  return (
    <nav className="nv-sidebar" aria-label="Primary">
      <div className="nv-brand">
        <img src="/nexus-mark.png" alt="" width={28} height={28} />
        <span>Nexus</span>
      </div>
      <div className="nv-workspace-card" title="Workspace selection is not configurable yet">
        <FolderGit2 size={18} aria-hidden="true" />
        <div className="nv-workspace-card__text">
          <div className="nv-workspace-card__name">Nexus</div>
          <div className="nv-workspace-card__sub">
            {project ? `Ledger: ${project}` : "No ledger configured"}
          </div>
        </div>
        <ChevronsUpDown size={14} aria-hidden="true" />
      </div>
      <ul className="nv-nav">
        {NAV.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              className="nv-nav__item"
              aria-current={page === n.id ? "page" : undefined}
              onClick={() => go(n.id)}
            >
              <n.icon size={17} aria-hidden="true" />
              <span>{n.label}</span>
              {n.id === "tasks" && taskCount !== null && (
                <span className="nv-nav__count">{taskCount}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <div className="nv-sidebar__spacer" />
      <button
        type="button"
        className="nv-nav__item"
        aria-current={page === "settings" ? "page" : undefined}
        onClick={() => go("settings")}
      >
        <Settings size={17} aria-hidden="true" />
        <span>Settings</span>
      </button>
      <div className="nv-runtime-card" aria-live="polite">
        <StatusDot tone={connected ? "success" : conn === undefined ? "neutral" : "error"} />
        <div>
          <div className="nv-runtime-card__title">
            {conn === undefined
              ? "Checking runtime…"
              : connected
                ? "Native runtime connected"
                : `Runtime ${conn}`}
          </div>
          <div className="nv-runtime-card__sub">
            <KeyRound size={11} aria-hidden="true" /> Live execution unavailable
          </div>
        </div>
      </div>
    </nav>
  );
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}
