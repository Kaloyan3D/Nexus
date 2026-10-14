import { Menu, PanelRight, Search } from "lucide-react";
import { useNexus } from "../../state/NexusContext";
import { Badge, Button, Kbd, StatusDot, modKeys } from "../ui/primitives";

export function TopBar({
  compact,
  onOpenNav,
  onToggleInspector,
  inspectorOpen,
  onOpenPalette,
}: {
  compact: boolean;
  onOpenNav: () => void;
  onToggleInspector: () => void;
  inspectorOpen: boolean;
  onOpenPalette: () => void;
}) {
  const { runtime } = useNexus();
  const connected = runtime?.connection === "connected";
  return (
    <header className="nv-topbar">
      {compact && (
        <Button variant="ghost" aria-label="Open navigation" onClick={onOpenNav} icon={<Menu size={18} />} />
      )}
      <button type="button" className="nv-topbar__search" onClick={onOpenPalette}>
        <Search size={15} aria-hidden="true" />
        <span>Search tasks and destinations…</span>
        <Kbd keys={modKeys("K")} />
      </button>
      <div className="nv-topbar__right">
        <Badge tone={connected ? "success" : "neutral"} icon={<StatusDot tone={connected ? "success" : "error"} />}>
          {connected ? "Daemon connected" : "Daemon offline"}
        </Badge>
        <Badge tone="warning">Mock only</Badge>
        <Button
          variant="ghost"
          aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
          aria-pressed={inspectorOpen}
          onClick={onToggleInspector}
          icon={<PanelRight size={18} />}
        />
      </div>
    </header>
  );
}
