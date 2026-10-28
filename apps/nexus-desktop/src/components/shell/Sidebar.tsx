import { Boxes, ChevronDown, ChevronRight, FolderGit2, History, Home, LayoutList, MonitorCog, FlaskConical, Settings, ShieldCheck, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { useNexus, type Page } from "../../state/NexusContext";

const NAV: Array<{ id: Page; label: string; icon: LucideIcon }> = [
  { id: "workspace", label: "Workspace", icon: Home },
  { id: "projects", label: "Projects", icon: FolderGit2 },
  { id: "history", label: "History", icon: History },
  { id: "models", label: "Models", icon: Boxes },
];

const ADVANCED: Array<{ id: Page; label: string; icon: LucideIcon }> = [
  { id: "tasks", label: "Controller ledger", icon: LayoutList },
  { id: "control-room", label: "Control Room", icon: MonitorCog },
  { id: "mock", label: "Mock runs", icon: FlaskConical },
  { id: "sentry", label: "Sentry (not connected)", icon: ShieldCheck },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { page, setPage, tasks } = useNexus();
  const taskCount = tasks.data?.available ? tasks.data.tasks.length : null;
  const inAdvanced = ADVANCED.some((a) => a.id === page);
  const [openAdv, setOpenAdv] = useState(false);
  const advOpen = openAdv || inAdvanced;
  const go = (p: Page) => {
    setPage(p);
    onNavigate?.();
  };
  return (
    <nav className="nv-sidebar" aria-label="Primary">
      <div className="nv-brand">
        <img src="/nexus-mark.png" alt="" width={28} height={28} />
        <span>Nexus</span>
      </div>
      <ul className="nv-nav">
        {NAV.map((n) => (
          <li key={n.id}>
            <button type="button" className="nv-nav__item" aria-current={page === n.id ? "page" : undefined} onClick={() => go(n.id)} title={n.label}>
              <n.icon size={17} aria-hidden="true" />
              <span>{n.label}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="nv-sidebar__spacer" />
      <button type="button" className="nv-nav__item" aria-current={page === "settings" ? "page" : undefined} onClick={() => go("settings")} title="Settings">
        <Settings size={17} aria-hidden="true" />
        <span>Settings</span>
      </button>
      <div className="nv-advanced">
        <button type="button" className="nv-nav__item nv-nav__item--quiet" aria-expanded={advOpen} onClick={() => setOpenAdv((o) => !o)} title="Advanced: diagnostics and developer tools">
          {advOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
          <span>Advanced</span>
        </button>
        {advOpen && (
          <ul className="nv-nav nv-nav--sub" aria-label="Advanced">
            {ADVANCED.map((n) => (
              <li key={n.id}>
                <button type="button" className="nv-nav__item" aria-current={page === n.id ? "page" : undefined} onClick={() => go(n.id)} title={n.label}>
                  <n.icon size={16} aria-hidden="true" />
                  <span>{n.label}</span>
                  {n.id === "tasks" && taskCount !== null && <span className="nv-nav__count">{taskCount}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
