import { useNow } from "../../lib/useViewport";
import { useNexus } from "../../state/NexusContext";
import { absoluteTime, relativeTime, shortId } from "../../lib/format";
import { taskStatusView } from "../../lib/status";
import { useJournal } from "../workspace/ActivityPanel";
import {
  Alert,
  Badge,
  CheckRow,
  CodeBlock,
  KeyValue,
  Loading,
  SectionHeading,
  StatusDot,
} from "../../components/ui/primitives";

const CONNECTION_COPY: Record<string, string> = {
  disconnected: "The daemon socket is not reachable. Start nexus-daemon, or set NEXUS_SOCKET.",
  unauthorized: "The daemon refused this client (peer credentials).",
  malformed: "The daemon answered, but the response failed validation and was rejected (fail closed).",
  unsafe: "The daemon reports dispatch enabled, which this client refuses to treat as safe.",
  error: "The runtime check failed.",
  unavailable: "Not running inside the native shell.",
};

export function ControlRoomPage() {
  const { runtime, blockers, selectedTask, tasks } = useNexus();
  const journal = useJournal(selectedTask);
  const connected = runtime?.connection === "connected";
  const now = useNow();
  const stale = runtime ? now - runtime.checkedAtMs > 20_000 : false;
  const ledger = tasks.data?.available ? tasks.data.tasks : [];
  const active = ledger.filter((t) => taskStatusView(t.status).tone === "purple");

  return (
    <div className="nv-page">
      <h1 className="nv-page__title">Control Room</h1>
      <p className="nv-page__sub">Read-only observability over the authenticated native daemon and Controller ledger.</p>

      {!runtime && <Loading label="Contacting daemon…" />}
      {runtime && !connected && (
        <Alert tone={runtime.connection === "unsafe" ? "error" : "warning"} title={`Daemon ${runtime.connection}`}>
          {CONNECTION_COPY[runtime.connection] ?? ""} {runtime.detail}
        </Alert>
      )}
      {stale && <Alert tone="warning" title="Stale data">The last successful probe is older than 20 seconds.</Alert>}

      <div className="nv-grid-2">
        <section className="nv-panel">
          <SectionHeading>Daemon</SectionHeading>
          <KeyValue
            rows={[
              {
                label: "State",
                value: runtime ? (
                  <Badge tone={connected ? "success" : "error"} icon={<StatusDot tone={connected ? "success" : "error"} />}>
                    {connected ? (runtime.state ?? "unknown") : runtime.connection}
                  </Badge>
                ) : null,
              },
              { label: "Trust mode", value: runtime?.trustMode },
              { label: "Incarnation", value: runtime?.incarnation ? shortId(runtime.incarnation, 12) : null, mono: true },
              { label: "Started", value: runtime?.startedAtUtc ? `${absoluteTime(runtime.startedAtUtc)} (${relativeTime(runtime.startedAtUtc)})` : null },
              { label: "Commands", value: runtime?.acceptedCommands != null ? `${runtime.acceptedCommands} accepted / ${runtime.totalCommands} total` : null },
              { label: "Journal", value: runtime?.eventCount != null ? `${runtime.eventCount} events` : null },
              { label: "Witness", value: runtime?.witnessConfigured != null ? `${runtime.witnessConfigured ? "configured" : "not configured"} · ${runtime.witnessPresent ? "present" : "absent"}` : null },
              { label: "Peer UID", value: runtime?.peerUidEnforced != null ? (runtime.peerUidEnforced ? "enforced" : "not enforced") : null },
              { label: "Clients", value: runtime?.activeClients != null ? `${runtime.activeClients} active · ${runtime.requests} req · ${runtime.refusals} refused · ${runtime.errors} errors` : null },
              {
                label: "Reconcile",
                value: runtime?.reconciliationRequired != null ? (runtime.reconciliationRequired ? <Badge tone="error">required</Badge> : "not required") : null,
              },
            ]}
          />
        </section>

        <section className="nv-panel">
          <SectionHeading aside={runtime?.readinessVerdict ?? undefined}>Readiness &amp; authorization</SectionHeading>
          <KeyValue
            rows={[
              { label: "Dispatch", value: <Badge tone="warning">disabled (Kernel pinned)</Badge> },
              { label: "Live", value: <Badge tone="warning">{blockers.data?.ready ? "ready" : "blocked"}</Badge> },
              { label: "Registry route", value: "Not exposed by Client API v1" },
            ]}
          />
          {runtime?.readinessDimensions.map((d) => (
            <CheckRow key={d.name} label={d.name} status={d.ready ? "pass" : "fail"} detail={d.detail} />
          ))}
          {blockers.data && blockers.data.blockers.length > 0 && (
            <>
              <div className="nv-group-label" style={{ marginTop: 12 }}>Live execution blockers</div>
              <ul className="nv-list">
                {blockers.data.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="nv-panel">
          <SectionHeading>Controller</SectionHeading>
          <KeyValue
            rows={[
              { label: "Ledger", value: tasks.data?.available ? `${ledger.length} tasks` : "unavailable" },
              { label: "Active", value: tasks.data?.available ? `${active.length} implementing` : null },
              { label: "Selected", value: selectedTask ? `${selectedTask.taskId} · ${selectedTask.status}` : "none" },
              {
                label: "Attempt",
                value: selectedTask && selectedTask.attempt !== null ? `${selectedTask.attempt} of ${selectedTask.maxAttempts ?? "?"}` : null,
              },
              {
                label: "Verification",
                value: selectedTask
                  ? `${selectedTask.verificationOutcomes.filter((o) => o.status === "pass").length} pass / ${selectedTask.verificationRequired.length} required`
                  : null,
              },
            ]}
          />
        </section>

        <section className="nv-panel">
          <SectionHeading>Journal {selectedTask ? `· ${selectedTask.taskId}` : ""}</SectionHeading>
          {!selectedTask && <p className="nv-note" style={{ marginTop: 0 }}>Select a task in Workspace or Tasks to read its kernel journal.</p>}
          {journal.loading && <Loading label="Reading journal…" />}
          {journal.error && <Alert tone="warning" title="Journal unavailable">{journal.error}</Alert>}
          {journal.data && journal.data.events.length === 0 && (
            <p className="nv-note" style={{ marginTop: 0 }}>No kernel events for this task instance.</p>
          )}
          {journal.data && journal.data.events.length > 0 && (
            <CodeBlock wrap>
              {journal.data.events.map((e) => `#${e.seq} ${e.kind} ${e.recordedAtUtc ?? ""}`).join("\n")}
            </CodeBlock>
          )}
        </section>
      </div>
    </div>
  );
}
