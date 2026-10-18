import { X } from "lucide-react";
import { useEffect } from "react";
import { PanelContent } from "../../features/task/PanelContent";
import { useNexus } from "../../state/NexusContext";
import { Button } from "../ui/primitives";

/** The on-demand evidence panel: closed by default, dismissible (button or Esc), docked on wide windows and an overlay below. */
export function SidePanel({ overlay }: { overlay: boolean }) {
  const { panel, openPanel, closePanel, selectedModel, runByConversation } = useNexus();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closePanel]);
  if (!panel) return null;
  const run = selectedModel ? (runByConversation.get(selectedModel.conversationId) ?? null) : null;
  return (
    <aside className={`nv-evidence${overlay ? " nv-evidence--overlay" : ""}`} aria-label="Evidence panel" role={overlay ? "dialog" : undefined} aria-modal={overlay ? true : undefined}>
      <div className="nv-evidence__head">
        <strong>Evidence</strong>
        <Button variant="ghost" size="sm" aria-label="Close panel" onClick={closePanel} icon={<X size={16} />} style={{ marginLeft: "auto" }} />
      </div>
      <PanelContent kind={panel} run={run} onKind={openPanel} />
    </aside>
  );
}
