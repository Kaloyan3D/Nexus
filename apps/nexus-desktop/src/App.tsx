import { useEffect, useState, type ReactElement } from "react";
import { CommandPalette } from "./components/shell/CommandPalette";
import { SidePanel } from "./components/shell/SidePanel";
import { Sidebar } from "./components/shell/Sidebar";
import { TopBar } from "./components/shell/TopBar";
import { ControlRoomPage } from "./features/control-room/ControlRoomPage";
import { ModelsPage } from "./features/models/ModelsPage";
import { SentryPage } from "./features/sentry/SentryPage";
import { HistoryPage } from "./features/history/HistoryPage";
import { MockPage } from "./features/mock/MockPage";
import { ProjectsPage } from "./features/projects/ProjectsPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { TasksPage } from "./features/tasks/TasksPage";
import { WorkspacePage } from "./features/workspace/WorkspacePage";
import { useLayout } from "./lib/useViewport";
import { useNexus, type Page } from "./state/NexusContext";

const PAGES: Record<Page, () => ReactElement> = {
  workspace: WorkspacePage,
  tasks: TasksPage,
  "control-room": ControlRoomPage,
  models: ModelsPage,
  sentry: SentryPage,
  projects: ProjectsPage,
  history: HistoryPage,
  settings: SettingsPage,
  mock: MockPage,
};

export function App() {
  const { page, panel } = useNexus();
  const layout = useLayout();
  const compact = layout === "compact";
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  // Cmd/Ctrl+K opens the palette; Escape closes overlays (palette and panel handle their own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === "Escape") {
        setNavOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const Page = PAGES[page];
  // The evidence panel docks only on wide windows; below that it is an overlay so it never steals width from the task.
  const docked = layout === "wide" && panel !== null;
  return (
    <div className="nv-app" data-layout={layout} data-panel={docked ? "open" : "closed"}>
      {!compact && <Sidebar />}
      <TopBar compact={compact} onOpenNav={() => setNavOpen(true)} onOpenPalette={() => setPaletteOpen(true)} />
      <main className="nv-main">
        <Page />
      </main>
      {docked && <SidePanel overlay={false} />}
      {compact && navOpen && (
        <>
          <div className="nv-overlay" onMouseDown={() => setNavOpen(false)} aria-hidden="true" />
          <div className="nv-drawer">
            <Sidebar onNavigate={() => setNavOpen(false)} />
          </div>
        </>
      )}
      {!docked && panel !== null && (
        <>
          <div className="nv-overlay" onMouseDown={() => undefined} aria-hidden="true" />
          <SidePanel overlay />
        </>
      )}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
