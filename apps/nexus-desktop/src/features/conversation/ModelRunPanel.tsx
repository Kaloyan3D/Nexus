import { Ban } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { asUiError } from "../../lib/api";
import type { ModelRunStatus } from "../../lib/contracts";
import { endpointLabel, modelStateView, usageLabel } from "../../lib/modelRun";
import { useNexus } from "../../state/NexusContext";
import { Alert, Badge, Button, Loading, StatusDot } from "../../components/ui/primitives";

const POLL_MS = 1000;

/** Read-only provenance and lifecycle of one model-only run, plus cancel. */
export function useModelRunStatus(conversationId: string | null, active: boolean) {
  const { api } = useNexus();
  const [state, setState] = useState<{ id: string; status: ModelRunStatus | null; error: string | null } | null>(null);
  const load = useCallback(() => {
    if (!conversationId) return;
    api
      .modelRunStatus(conversationId)
      .then((status) => setState({ id: conversationId, status, error: null }))
      .catch((e) => setState({ id: conversationId, status: null, error: asUiError(e).message }));
  }, [api, conversationId]);
  useEffect(() => {
    load();
    if (!active) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load, active]);
  const mine = state && state.id === conversationId ? state : null;
  return { status: mine?.status ?? null, error: mine?.error ?? null, reload: load };
}

export function CancelModelRunButton({ status, onDone }: { status: ModelRunStatus; onDone: () => void }) {
  const { api, refreshModelRuns } = useNexus();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (status.terminal) return null;
  const requested = status.cancelRequested || busy;
  return (
    <span>
      <Button
        size="sm"
        icon={<Ban size={13} aria-hidden="true" />}
        disabled={requested}
        onClick={() => {
          setBusy(true);
          setErr(null);
          api
            .cancelModelRun(status.conversationId)
            .then(() => {
              onDone();
              refreshModelRuns();
            })
            .catch((e) => {
              setErr(asUiError(e).message);
              setBusy(false);
            });
        }}
      >
        {requested ? "Cancellation requested" : "Cancel run"}
      </Button>
      {err && <span className="nv-note"> {err}</span>}
    </span>
  );
}

export function ModelRunPanel({ conversationId }: { conversationId: string }) {
  const { status, error, reload } = useModelRunStatus(conversationId, true);
  if (error) return <Alert tone="warning" title="Run status unavailable">{error}</Alert>;
  if (!status) return <Loading label="Reading model run record…" />;
  const v = modelStateView(status.state);
  return (
    <div className="nv-stack" style={{ gap: 12 }}>
      <div className="nv-heading__meta">
        <Badge tone={v.tone} icon={<StatusDot tone={v.tone} pulse={v.pulse} />}>
          {v.label}
        </Badge>
        <Badge tone={status.endpointKind === "provider" ? "purple" : "warning"}>
          {status.endpointKind === "provider" ? "Provider" : "Loopback fixture"}
        </Badge>
        <CancelModelRunButton status={status} onDone={reload} />
      </div>
      {status.state === "uncertain" && (
        <Alert tone="warning" title="Submission outcome is uncertain">
          The request may have been processed and billed. Nexus never re-sends it automatically.
        </Alert>
      )}
      {status.errorCode && status.state !== "completed" && (
        <Alert tone="error" title={`Run ended: ${status.errorCode}`}>
          See the conversation for the recorded explanation.
        </Alert>
      )}
      <dl className="nv-kv">
        <dt>Provider</dt>
        <dd className="nv-mono">{status.providerId ?? "—"}</dd>
        <dt>Model</dt>
        <dd className="nv-mono">{status.remoteModelId ?? "—"}</dd>
        <dt>Registry target</dt>
        <dd className="nv-mono">{status.logicalModelId ?? "—"}</dd>
        <dt>Endpoint</dt>
        <dd>{endpointLabel(status.endpointKind)}</dd>
        <dt>Attempt</dt>
        <dd className="nv-mono">{status.attemptId ?? "—"}</dd>
        <dt>Command</dt>
        <dd className="nv-mono">{status.commandId ?? "—"}</dd>
        <dt>Request digest</dt>
        <dd className="nv-mono">{status.requestDigest ?? "—"}</dd>
        <dt>HTTP status</dt>
        <dd>{status.httpStatus ?? "—"}</dd>
        <dt>Usage</dt>
        <dd>{usageLabel(status)}</dd>
        <dt>Latency</dt>
        <dd>{status.latencyMs === null ? "—" : `${status.latencyMs} ms`}</dd>
        <dt>Finish</dt>
        <dd>{status.finishReason ?? "—"}</dd>
      </dl>
      <p className="nv-note">
        Text-only. The model has no tools, files or processes; its output is displayed as untrusted
        text and is never executed.
      </p>
    </div>
  );
}
