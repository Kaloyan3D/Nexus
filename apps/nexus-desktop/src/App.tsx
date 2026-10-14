import { useCallback, useEffect, useState, type ReactElement } from "react";
import { CommandPalette } from "./components/shell/CommandPalette";
import { Inspector } from "./components/shell/Inspector";
import { Sidebar } from "./components/shell/Sidebar";
import { TopBar } from "./components/shell/TopBar";
import { ControlRoomPage } from "./features/control-room/ControlRoomPage";
import { ModelsPage } from "./features/models/ModelsPage";
import { SentryPage } from "./features/sentry/SentryPage";
import { SessionsPage } from "./features/sessions/SessionsPage";
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
  sessions: SessionsPage,
  settings: SettingsPage,
};

export function App() {
  const { page } = useNexus();
  const layout = useLayout();
  const compact = layout === "compact";
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [overlayInspector, setOverlayInspector] = useState(false);

  // Cmd/Ctrl+K opens the palette; Escape closes overlays (palette handles its own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === "Escape") {
        setNavOpen(false);
        setOverlayInspector(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleInspector = useCallback(() => {
    if (compact) setOverlayInspector((o) => !o);
    else setInspectorOpen((o) => !o);
  }, [compact]);

  const Page = PAGES[page];
  const showInline = !compact && (layout === "wide" || inspectorOpen);

  return (
    <div
      className="nv-app"
      data-layout={layout}
      data-inspector={showInline ? "open" : "closed"}
    >
      {!compact && <Sidebar />}
      <TopBar
        compact={compact}
        onOpenNav={() => setNavOpen(true)}
        onToggleInspector={toggleInspector}
        inspectorOpen={compact ? overlayInspector : showInline}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <main className="nv-main">
        <Page />
      </main>
      {showInline && <Inspector overlay={false} />}
      {compact && navOpen && (
        <>
          <div className="nv-overlay" onMouseDown={() => setNavOpen(false)} aria-hidden="true" />
          <div className="nv-drawer">
            <Sidebar onNavigate={() => setNavOpen(false)} />
          </div>
        </>
      )}
      {compact && overlayInspector && (
        <>
          <div className="nv-overlay" onMouseDown={() => setOverlayInspector(false)} aria-hidden="true" />
          <Inspector overlay onClose={() => setOverlayInspector(false)} />
        </>
      )}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
