import { Ban } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { asUiError } from "../../lib/api";
import type { IntentRun, ModelRunStatus, ToolActivity } from "../../lib/contracts";
import { endpointLabel, modelStateView, usageLabel } from "../../lib/modelRun";
import { useNexus } from "../../state/NexusContext";
import { Alert, Badge, Button, Loading, StatusDot } from "../../components/ui/primitives";
import { toolKind } from "../../lib/runKind";

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

/** A5.5: the broker's record of a repo-inspect run for this conversation. */
export function useInspectRun(conversationId: string | null, active: boolean): IntentRun | null {
  const { api } = useNexus();
  const [run, setRun] = useState<IntentRun | null>(null);
  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    let t: ReturnType<typeof setInterval> | undefined;
    const load = () =>
      api
        .intentList()
        .then((runs) => {
          if (!alive) return;
          const mine = runs.find(
            (r) => r.conversationId === conversationId && (r.intentType === "repo-inspect" || r.intentType === "repo-code"),
          );
          setRun(mine ?? null);
          // A terminal run never changes again: stop polling. Reopening or
          // navigating back remounts this effect and fetches it afresh.
          if (mine?.terminal && t !== undefined) {
            clearInterval(t);
            t = undefined;
          }
        })
        .catch(() => alive && setRun(null));
    load();
    if (!active) return () => void (alive = false);
    t = setInterval(load, 1500);
    return () => {
      alive = false;
      if (t !== undefined) clearInterval(t);
    };
  }, [api, conversationId, active]);
  return run;
}

function activityTone(a: ToolActivity): "success" | "warning" | "error" | "neutral" {
  if (a.status === "executed") return "success";
  if (a.status === "refused") return "error";
  if (a.status === "cancelled") return "warning";
  return "warning";
}

const STOP_REASONS: Record<string, string> = {
  "max-turns": "the model-turn limit",
  "max-tool-calls": "the tool-call limit",
  "max-tool-result-bytes": "the total tool-result byte limit",
  "max-runtime": "the run-time limit",
  "output-limit": "the output-token limit",
};

/** Read-only repository inspection: progress, tool activity and citations. */
export function InspectRunSection({ run }: { run: IntentRun }) {
  const acts = run.toolActivity ?? [];
  return (
    <section className="nv-stack" style={{ gap: 8 }} aria-label="Repository inspection">
      <div className="nv-heading__meta">
        <Badge tone="purple">Read-only inspection</Badge>
        <Badge tone="neutral">Workspace {run.workspaceId ?? "—"}</Badge>
        <Badge tone="neutral">
          Turn {run.turn ?? 0}/{run.maxTurns ?? "—"}
        </Badge>
        <Badge tone="neutral">
          Tool calls {run.toolCalls ?? 0}/{run.maxToolCalls ?? "—"}
        </Badge>
        <Badge tone="neutral">{run.toolResultBytes ?? 0} bytes returned to the model</Badge>
      </div>
      {run.stopReason && (
        <Alert tone="warning" title="Stopped at a policy limit">
          The run ended cleanly at {STOP_REASONS[run.stopReason] ?? run.stopReason}; the findings so far are kept.
        </Alert>
      )}
      {acts.length > 0 ? (
        <table className="nv-table" aria-label="Tool activity">
          <thead>
            <tr>
              <th>#</th>
              <th>Turn</th>
              <th>Tool</th>
              <th>Arguments</th>
              <th>Outcome</th>
              <th>Bytes</th>
            </tr>
          </thead>
          <tbody>
            {acts.map((a) => (
              <tr key={a.index}>
                <td>{a.index}</td>
                <td>{a.turn}</td>
                <td className="nv-mono">{a.tool}</td>
                <td className="nv-mono">{a.argsSummary}</td>
                <td>
                  <Badge tone={activityTone(a)}>
                    {a.status}
                    {a.errorCode ? ` · ${a.errorCode}` : ""}
                  </Badge>
                </td>
                <td>
                  {a.resultBytes}
                  {a.truncated ? " (truncated)" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="nv-note">No tool has been proposed yet.</p>
      )}
      {(run.citationsVerified?.length ?? 0) + (run.citationsUnverified?.length ?? 0) > 0 && (
        <dl className="nv-kv">
          <dt>Supported references</dt>
          <dd className="nv-mono">{(run.citationsVerified ?? []).join(", ") || "—"}</dd>
          <dt>Unsupported references</dt>
          <dd className="nv-mono">{(run.citationsUnverified ?? []).join(", ") || "—"}</dd>
        </dl>
      )}
      <p className="nv-note">
        The model can only list, read and search files in this workspace. Tool results and file contents are untrusted
        data; selected repository text is sent to the model provider. Nothing is written or executed.
      </p>
    </section>
  );
}


const short = (h?: string | null) => (h ? h.slice(0, 10) : "—");

/** Unified diff, line-classified. Text only: never interpreted as HTML. */
export function DiffViewer({ diff, truncated }: { diff: string; truncated: boolean }) {
  const lines = diff.split("\n");
  return (
    <div>
      <pre className="nv-diff nv-mono" aria-label="Unified diff" style={{ overflow: "auto", maxHeight: 360 }}>
        {lines.map((l, i) => {
          const tone = l.startsWith("+++") || l.startsWith("---") ? "meta" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : "ctx";
          return (
            <div key={i} data-diff={tone} className={`nv-diff__line nv-diff__line--${tone}`}>
              {l || " "}
            </div>
          );
        })}
      </pre>
      {truncated && <p className="nv-note">The diff is truncated here; the full change set stays in the isolated copy.</p>}
    </div>
  );
}


/** Every proposed tool call with its approval and receipt, from the run record (never from model text). */
export function ToolCallsTable({ run }: { run: IntentRun }) {
  const acts = run.toolActivity ?? [];
  if (acts.length === 0) return <p className="nv-note">No tool has been proposed yet.</p>;
  return (
    <table className="nv-table" aria-label="Proposed edits and tool activity">
      <thead>
        <tr>
          <th>#</th>
          <th>Tool</th>
          <th>Proposed</th>
          <th>Approval</th>
          <th>Outcome</th>
          <th>Receipt</th>
        </tr>
      </thead>
      <tbody>
        {acts.map((a) => (
          <tr key={a.index}>
            <td>{a.index}</td>
            <td className="nv-mono">
              {a.tool} <Badge tone={toolKind(a.tool) === "read" ? "neutral" : "purple"}>{toolKind(a.tool)}</Badge>
            </td>
            <td className="nv-mono">{a.argsSummary}</td>
            <td>{a.approvalOutcome ? <Badge tone={a.approvalOutcome === "approved" ? "success" : "warning"}>{a.approvalActor === "automated-policy" ? "granted by policy" : a.approvalOutcome}</Badge> : "—"}</td>
            <td>
              <Badge tone={activityTone(a)}>
                {a.status}
                {a.errorCode ? ` · ${a.errorCode}` : ""}
              </Badge>
              {a.verification && (
                <Badge tone={a.verification === "pass" ? "success" : "error"}>
                  {a.verification === "pass" ? "tests passed" : "tests failed"}
                  {a.exitCode != null ? ` (exit ${a.exitCode})` : ""}
                </Badge>
              )}
            </td>
            <td className="nv-mono">{a.postSha256 ? `${short(a.preSha256)} → ${short(a.postSha256)}` : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ModelRunPanel({ conversationId }: { conversationId: string }) {
  const { status, error, reload } = useModelRunStatus(conversationId, true);
  const inspect = useInspectRun(conversationId, status ? !status.terminal : true);
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
        <dt>First token</dt>
        <dd>{status.firstTokenMs == null ? "—" : `${status.firstTokenMs} ms`}</dd>
        <dt>Latency</dt>
        <dd>{status.latencyMs === null ? "—" : `${status.latencyMs} ms`}</dd>
        <dt>Provider request id</dt>
        <dd className="nv-mono">{status.providerRequestId ?? "not supplied"}</dd>
        <dt>Provider response id</dt>
        <dd className="nv-mono">{status.providerResponseId ?? "not supplied"}</dd>
        <dt>Finish</dt>
        <dd>{status.finishReason ?? "—"}</dd>
      </dl>
      {inspect?.intentType === "repo-code" ? null : inspect ? (
        <InspectRunSection run={inspect} />
      ) : (
        <p className="nv-note">
          Text-only. The model has no tools, files or processes; its output is displayed as untrusted
          text and is never executed.
        </p>
      )}
    </div>
  );
}
