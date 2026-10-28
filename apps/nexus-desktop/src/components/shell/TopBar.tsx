import { Menu, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNexus } from "../../state/NexusContext";
import { Badge, Button, Kbd, StatusDot, modKeys } from "../ui/primitives";

/** One runtime pill instead of scattered health badges: the reasons are in its popover. */
function RuntimePill() {
  const { runtime, intentModelsError, intentModels, tasks, runtimeState } = useNexus();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // The application's own runtime (interactive profile): its state is what the person needs. The Controller
  // ledger daemon and the model list belong to the operator view and say nothing about whether Nexus works.
  if (runtimeState?.mode === "interactive") {
    const phase = runtimeState.phase;
    const tone = phase === "ready" ? "success" : phase === "error" ? "error" : "neutral";
    const label = runtimeState.updatePending ? "ready · update waiting" : phase === "ready" ? "ready" : phase === "error" ? "could not start" : phase === "starting" ? "starting…" : "stopped";
    return (
      <div className="nv-runtime" ref={ref}>
        <button type="button" className="nv-runtime__pill" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <StatusDot tone={tone} /> <span>Nexus {label}</span>
        </button>
        {open && (
          <div className="nv-runtime__pop" role="dialog" aria-label="Nexus status">
            <dl className="nv-kv">
              <dt>Runtime</dt>
              <dd>{phase === "ready" ? "running on this computer" : (runtimeState.message ?? phase)}</dd>
              <dt>OpenCode Go</dt>
              <dd>{runtimeState.providerConnected ? "connected" : "not connected yet"}</dd>
              <dt>Autonomous work</dt>
              <dd>{runtimeState.consent.given ? "allowed" : "not allowed yet"}</dd>
              {runtimeState.node && (
                <>
                  <dt>Node.js</dt>
                  <dd>{runtimeState.node.source === "bundled" ? `${runtimeState.node.version ?? ""} (bundled with Nexus)` : "from this computer"}</dd>
                </>
              )}
            </dl>
            <Badge tone="neutral">More under Settings</Badge>
          </div>
        )}
      </div>
    );
  }
  const conn = runtime?.connection;
  const connected = conn === "connected";
  const brokerOk = intentModels !== null && !intentModelsError;
  const tone = conn === undefined ? "neutral" : connected && brokerOk ? "success" : brokerOk ? "warning" : "error";
  const label = conn === undefined ? "checking…" : connected && brokerOk ? "ready" : brokerOk ? "partly available" : "broker unreachable";
  return (
    <div className="nv-runtime" ref={ref}>
      <button type="button" className="nv-runtime__pill" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <StatusDot tone={tone} /> <span>Runtime {label}</span>
      </button>
      {open && (
        <div className="nv-runtime__pop" role="dialog" aria-label="Runtime status">
          <dl className="nv-kv">
            <dt>Broker</dt>
            <dd>{brokerOk ? "reachable" : intentModelsError ? `unreachable: ${intentModelsError.message}` : "checking"}</dd>
            <dt>Daemon</dt>
            <dd>{conn === undefined ? "checking" : connected ? "Native runtime connected" : `Runtime ${conn}`}</dd>
            <dt>Live dispatch</dt>
            <dd>Kernel dispatch is off; work goes through the broker's controlled paths</dd>
            <dt>Controller ledger</dt>
            <dd>{tasks.data?.available ? `${tasks.data.tasks.length} task(s)` : "not configured (only needed for the Advanced ledger view)"}</dd>
          </dl>
          <Badge tone="neutral">Diagnostics live under Advanced</Badge>
        </div>
      )}
    </div>
  );
}

export function TopBar({ compact, onOpenNav, onOpenPalette }: { compact: boolean; onOpenNav: () => void; onOpenPalette: () => void }) {
  return (
    <header className="nv-topbar">
      {compact && <Button variant="ghost" aria-label="Open navigation" onClick={onOpenNav} icon={<Menu size={18} />} />}
      <button type="button" className="nv-topbar__search" onClick={onOpenPalette}>
        <Search size={15} aria-hidden="true" />
        <span>Search tasks and destinations…</span>
        <Kbd keys={modKeys("K")} />
      </button>
      <div className="nv-topbar__right">
        <RuntimePill />
      </div>
    </header>
  );
}
