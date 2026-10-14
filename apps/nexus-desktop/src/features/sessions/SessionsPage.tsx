import { History } from "lucide-react";
import { relativeTime } from "../../lib/format";
import { useNexus } from "../../state/NexusContext";
import { Badge, EmptyState } from "../../components/ui/primitives";

export function SessionsPage() {
  const { mockRuns, select, setPage } = useNexus();
  return (
    <div className="nv-page">
      <h1 className="nv-page__title">Sessions</h1>
      <p className="nv-page__sub">Persistent sessions are not part of Client API v1.</p>
      <EmptyState icon={History} title="No authoritative sessions">
        The native backend exposes no session records. Mock runs started in this window are listed below and
        disappear when the app closes.
      </EmptyState>
      {mockRuns.length > 0 && (
        <div className="nv-table" role="list" aria-label="Mock runs in this window">
          {mockRuns.map((m) => (
            <button
              key={m.key}
              type="button"
              role="listitem"
              className="nv-table__row nv-table__row--button"
              onClick={() => {
                select({ kind: "mock", id: m.key });
                setPage("workspace");
              }}
            >
              <span>{m.prompt.slice(0, 80)}</span>
              <span><Badge tone="warning">MOCK</Badge></span>
              <span className="nv-table__muted">{m.status}</span>
              <span className="nv-table__muted">{relativeTime(new Date(m.startedAtMs).toISOString())}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
