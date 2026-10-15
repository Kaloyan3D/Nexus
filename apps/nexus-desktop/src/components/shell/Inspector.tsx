import { useEffect, useState } from "react";
import { Activity, FileBox, ListChecks, ShieldCheck, SquareStack, Wrench, X } from "lucide-react";
import type { ApprovalsView, TaskRecord, TaskToolEvents } from "../../lib/contracts";
import {
  approvalNote,
  describeMutation,
  describeProcess,
  sandboxSummary,
  toolEventPresentation,
} from "../../lib/toolEvents";
import { absoluteTime, durationBetween, relativeTime, shortId } from "../../lib/format";
import { taskStatusView } from "../../lib/status";
import { useNexus } from "../../state/NexusContext";
import type { MockRun } from "../../state/mockRuns";
import {
  Alert,
  Badge,
  Button,
  CheckRow,
  KeyValue,
  SectionHeading,
  StatusDot,
} from "../ui/primitives";

export function Inspector({ onClose, overlay }: { onClose?: () => void; overlay: boolean }) {
  const { selectedTask, selectedMock } = useNexus();
  return (
    <aside
      className={`nv-inspector${overlay ? " nv-inspector--overlay" : ""}`}
      aria-label="Task inspector"
      role={overlay ? "dialog" : undefined}
      aria-modal={overlay ? true : undefined}
    >
      <div className="nv-inspector__head">
        <SquareStack size={15} aria-hidden="true" />
        <span>Inspector</span>
        {onClose && (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Close inspector"
            onClick={onClose}
            icon={<X size={16} />}
            style={{ marginLeft: "auto" }}
          />
        )}
      </div>
      <div className="nv-inspector__body">
        {selectedMock ? (
          <MockInspector run={selectedMock} />
        ) : selectedTask ? (
          <TaskInspector task={selectedTask} />
        ) : (
          <div className="nv-inspector__empty">
            <Alert tone="info" title="No task selected">
              Task, attempt, verification and artifact details appear here once you select a task
              or run a mock workflow.
            </Alert>
          </div>
        )}
      </div>
    </aside>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <section className="nv-inspector__section">{children}</section>;
}

function ToolActivity({ task }: { task: TaskRecord }) {
  const { api } = useNexus();
  const instance = task.taskInstanceId;
  // Results are keyed by the instance they answer, so a stale response for
  // a previously selected task is never shown.
  const [res, setRes] = useState<{
    key: string;
    data?: TaskToolEvents;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!instance) return;
    let live = true;
    api
      .toolEvents(instance)
      .then((data) => live && setRes({ key: instance, data }))
      .catch((e: { message?: string }) => live && setRes({ key: instance, error: e?.message ?? "unavailable" }));
    return () => {
      live = false;
    };
  }, [api, instance]);
  const current = res && instance && res.key === instance ? res : null;
  const data = current?.data ?? null;
  const total = data?.attempts.reduce((n, a) => n + a.events.length, 0);
  return (
    <Section>
      <SectionHeading icon={Wrench} aside={data?.available ? String(total) : undefined}>
        Tool activity
      </SectionHeading>
      {!instance ? (
        <p className="nv-note" style={{ marginTop: 0 }}>
          No kernel task instance is linked to this ledger task.
        </p>
      ) : current?.error ? (
        <p className="nv-note" style={{ marginTop: 0 }}>
          Tool records unavailable: {current.error}
        </p>
      ) : data === null ? (
        <p className="nv-note" style={{ marginTop: 0 }}>Loading…</p>
      ) : !data.available ? (
        <p className="nv-note" style={{ marginTop: 0 }}>
          Tool activity unavailable: {data.reason ?? "attempt identity is not established"}.
        </p>
      ) : total === 0 && data.attempts.every((a) => !a.error) ? (
        <p className="nv-note" style={{ marginTop: 0 }}>
          No read-only tool executions are recorded for this task.
        </p>
      ) : (
        data.attempts.map((a) => (
          <div key={a.attemptId} className="nv-toolattempt">
            <div className="nv-note nv-mono">
              Attempt {a.sequence} · {a.attemptId}
            </div>
            {a.error ? (
              <p className="nv-note">No kernel record for this attempt ({a.error}).</p>
            ) : (
              <ul className="nv-toolevents" aria-label={`Tool executions for ${a.attemptId}`}>
                {a.events.map((e) => {
                  const p = toolEventPresentation(e);
                  return (
                    <li key={`${e.attemptId}:${e.requestId}`}>
                      <Badge tone={p.tone === "danger" ? "error" : p.tone === "success" ? "success" : "warning"}>
                        {p.label}
                      </Badge>{" "}
                      <span className="nv-mono">{e.toolId}</span> {p.summary}
                      {e.scope === "write" && (
                        <span className="nv-note">
                          {" "}
                          · write · {approvalNote(e.change, e.scope)}
                        </span>
                      )}
                      {p.change && <span className="nv-note nv-mono"> · {p.change}</span>}
                      {e.scope === "process" && (
                        <span className="nv-note">
                          {" "}
                          · sandboxed process
                          {describeProcess(e.process) && ` · ${describeProcess(e.process)}`}
                          {e.process?.verification && ` · verification ${e.process.verification}`}
                        </span>
                      )}
                      {e.scope === "process" && sandboxSummary(e.process) && (
                        <div className="nv-note">sandbox: {sandboxSummary(e.process)}</div>
                      )}
                      {e.scope === "process" && (e.process?.stdoutTail || e.process?.stderrTail) && (
                        <details className="nv-toolevents__output">
                          <summary>
                            Output (bounded, redacted
                            {e.process?.stdoutTruncated || e.process?.stderrTruncated ? ", truncated" : ""})
                          </summary>
                          {e.process?.stderrTail && <pre className="nv-mono">{e.process.stderrTail}</pre>}
                          {e.process?.stdoutTail && <pre className="nv-mono">{e.process.stdoutTail}</pre>}
                        </details>
                      )}
                      {describeMutation(e.change) && (
                        <span className="nv-note"> · {describeMutation(e.change)}</span>
                      )}
                      {e.leaseEpoch !== null && (
                        <span className="nv-note"> · generation {e.leaseEpoch}</span>
                      )}
                      {!e.aiInitiated && <span className="nv-note"> · operator/test initiated</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))
      )}
    </Section>
  );
}

const APPROVAL_LABEL: Record<string, string> = {
  pending: "Awaiting human review",
  approved: "Approved (unused)",
  consumed: "Approved and used",
  denied: "Denied",
  expired: "Expired",
  revoked: "Revoked",
};

function approvalTone(state: string): "success" | "warning" | "error" | "neutral" {
  if (state === "approved" || state === "consumed") return "success";
  if (state === "pending") return "warning";
  if (state === "denied" || state === "revoked") return "error";
  return "neutral";
}

/**
 * Read-only human-approval status. The approval itself happens only in the
 * trusted terminal approver (independent OS identity); nothing here can
 * approve, deny, or reveal the reviewed content.
 */
function Approvals({ task }: { task: TaskRecord }) {
  const { api } = useNexus();
  const instance = task.taskInstanceId;
  const [res, setRes] = useState<{ key: string; data?: ApprovalsView; error?: string } | null>(null);
  useEffect(() => {
    if (!instance) return;
    let live = true;
    api
      .listApprovals(instance)
      .then((data) => live && setRes({ key: instance, data }))
      .catch((e: { message?: string }) => live && setRes({ key: instance, error: e?.message ?? "unavailable" }));
    return () => {
      live = false;
    };
  }, [api, instance]);
  if (!instance) return null;
  const current = res && res.key === instance ? res : null;
  const data = current?.data ?? null;
  return (
    <Section>
      <SectionHeading icon={ShieldCheck} aside={data?.available ? String(data.approvals.length) : undefined}>
        Approvals
      </SectionHeading>
      {current?.error ? (
        <p className="nv-note" style={{ marginTop: 0 }}>Approvals unavailable: {current.error}</p>
      ) : data === null ? (
        <p className="nv-note" style={{ marginTop: 0 }}>Loading…</p>
      ) : !data.available ? (
        <p className="nv-note" style={{ marginTop: 0 }}>
          Human approval is not active: {data.reason ?? "unavailable"}.
        </p>
      ) : data.approvals.length === 0 ? (
        <p className="nv-note" style={{ marginTop: 0 }}>No approval requests for this task.</p>
      ) : (
        <ul className="nv-toolevents" aria-label="Approval requests">
          {data.approvals.map((a) => (
            <li key={a.approvalId}>
              <Badge tone={approvalTone(a.state)}>{APPROVAL_LABEL[a.state] ?? a.state}</Badge>{" "}
              <span className="nv-mono">{a.toolId}</span>
              {a.paths.length > 0 && <span className="nv-note nv-mono"> · {a.paths.join(", ")}</span>}
              <div className="nv-note nv-mono">
                {shortId(a.approvalId)} · request {a.requestDigest.slice(0, 12)}
                {a.humanAuthMechanism ? ` · ${a.humanAuthMechanism}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="nv-note">
        Approve or deny in a terminal as the approver identity (<span className="nv-mono">nexus-approver</span>).
        This window can only display status.
      </p>
    </Section>
  );
}

function TaskInspector({ task }: { task: TaskRecord }) {
  const v = taskStatusView(task.status);
  const lifetime = durationBetween(task.createdAtUtc, task.completedAtUtc);
  const required = task.verificationRequired;
  const outcomes = task.verificationOutcomes;
  const rows: Array<{ name: string; status: "pass" | "fail" | "unknown" }> = [
    ...required.map((name) => {
      const o = outcomes.find((x) => x.name === name);
      return { name, status: o?.status ?? "unknown" };
    }),
    ...outcomes.filter((o) => !required.includes(o.name)).map((o) => ({ name: o.name, status: o.status })),
  ];
  const passed = rows.filter((r) => r.status === "pass").length;
  return (
    <>
      <Section>
        <SectionHeading icon={ListChecks} aside={<span className="nv-mono">{task.taskId}</span>}>
          Task
        </SectionHeading>
        <h2 className="nv-inspector__title">{task.title}</h2>
        <KeyValue
          rows={[
            {
              label: "Status",
              value: (
                <Badge tone={v.tone} icon={<StatusDot tone={v.tone} pulse={v.pulse} />}>
                  {v.label}
                </Badge>
              ),
            },
            { label: "Instance", value: task.taskInstanceId ? shortId(task.taskInstanceId, 13) : null, mono: true },
            { label: "Engine", value: task.boundEngine },
            { label: "Class", value: task.executionClass },
            { label: "Risk", value: task.risk },
            { label: "Mode", value: <Badge>Authoritative · Controller ledger</Badge> },
            { label: "Created", value: absoluteTime(task.createdAtUtc) },
            { label: "Updated", value: relativeTime(task.updatedAtUtc) },
            { label: "Base commit", value: task.baseCommit ? task.baseCommit.slice(0, 10) : null, mono: true },
            { label: "Worktree", value: task.worktree, mono: true },
          ]}
        />
        {task.dependencies.length > 0 && (
          <KeyValue rows={[{ label: "Depends on", value: task.dependencies.join(", "), mono: true }]} />
        )}
      </Section>
      <Section>
        <SectionHeading icon={Activity}>Current Attempt</SectionHeading>
        <KeyValue
          rows={[
            {
              label: "Attempt",
              value: task.attempt !== null ? `${task.attempt} of ${task.maxAttempts ?? "?"}` : null,
            },
            { label: "Status", value: v.label },
            { label: "Model", value: "Not recorded in ledger" },
            { label: "Duration", value: lifetime ? `${lifetime} (task lifetime)` : null },
            { label: "Execution", value: <Badge tone="warning">Live dispatch disabled</Badge> },
          ]}
        />
        <p className="nv-note">
          The ledger records attempt counters only. Provider, resolved model and per-attempt timing
          are not part of this record.
        </p>
      </Section>
      <Section>
        <SectionHeading
          icon={ListChecks}
          aside={rows.length ? `${passed} / ${rows.length}` : undefined}
        >
          Verification
        </SectionHeading>
        {rows.length === 0 ? (
          <p className="nv-note" style={{ marginTop: 0 }}>
            No verification checks are required or recorded for this task.
          </p>
        ) : (
          <>
            <div className="nv-progress" aria-hidden="true">
              <div style={{ width: `${(passed / rows.length) * 100}%` }} />
            </div>
            {rows.map((r) => (
              <CheckRow key={r.name} label={r.name} status={r.status} />
            ))}
          </>
        )}
      </Section>
      <Approvals task={task} />
      <ToolActivity task={task} />
      <Section>
        <SectionHeading icon={FileBox}>Artifacts</SectionHeading>
        <p className="nv-note" style={{ marginTop: 0 }}>
          The Controller ledger holds no artifact records for this task
          {task.worktree ? "; its worktree path is listed above." : "."}
        </p>
      </Section>
    </>
  );
}

function MockInspector({ run }: { run: MockRun }) {
  const r = run.result;
  const dur = r ? `${r.durationMs} ms` : null;
  const checks = r?.checks ?? [];
  const passed = checks.filter((c) => c.status === "pass").length;
  return (
    <>
      <Section>
        <SectionHeading icon={ListChecks} aside={<Badge tone="warning">MOCK</Badge>}>
          Task
        </SectionHeading>
        <h2 className="nv-inspector__title">{run.prompt.slice(0, 160)}</h2>
        <KeyValue
          rows={[
            {
              label: "Status",
              value: (
                <Badge
                  tone={run.status === "failed" ? "error" : run.status === "done" ? "success" : "purple"}
                  icon={<StatusDot tone={run.status === "failed" ? "error" : run.status === "done" ? "success" : "purple"} pulse={run.status === "running"} />}
                >
                  {run.status === "running" ? "Running" : run.status === "done" ? "Completed" : "Failed"}
                </Badge>
              ),
            },
            { label: "Run", value: r?.runId ?? run.key, mono: true },
            { label: "Mode", value: <Badge tone="warning">Mock · isolated</Badge> },
            { label: "Started", value: absoluteTime(new Date(run.startedAtMs).toISOString()) },
            { label: "Ledger", value: "Not recorded in the Controller ledger" },
          ]}
        />
      </Section>
      <Section>
        <SectionHeading icon={Activity}>Current Attempt</SectionHeading>
        <KeyValue
          rows={[
            { label: "Attempt", value: r?.attemptId, mono: true },
            { label: "Command", value: r?.commandId, mono: true },
            { label: "Digest", value: r ? shortId(r.requestDigest, 14) : null, mono: true },
            { label: "Provider", value: "Loopback mock provider" },
            { label: "Grant", value: r ? "Sealed mock-e2e (kernel-minted)" : null },
            { label: "Finish", value: r?.finishReason },
            { label: "Usage", value: r ? `${r.usageInput} in / ${r.usageOutput} out (fixture)` : null },
            { label: "Duration", value: dur },
            { label: "Live", value: <Badge tone="warning">Unavailable</Badge> },
          ]}
        />
      </Section>
      <Section>
        <SectionHeading icon={ListChecks} aside={checks.length ? `${passed} / ${checks.length}` : undefined}>
          Verification
        </SectionHeading>
        {checks.length === 0 ? (
          <p className="nv-note" style={{ marginTop: 0 }}>
            {run.status === "running" ? "Checks appear when the run completes." : "No checks were produced."}
          </p>
        ) : (
          <>
            <div className="nv-progress" aria-hidden="true">
              <div style={{ width: `${(passed / checks.length) * 100}%` }} />
            </div>
            {checks.map((c) => (
              <CheckRow key={c.id} label={c.label} status={c.status} detail={c.detail} />
            ))}
          </>
        )}
      </Section>
      <Section>
        <SectionHeading icon={FileBox}>Artifacts</SectionHeading>
        <p className="nv-note" style={{ marginTop: 0 }}>
          Mock runs produce no files. The isolated store is destroyed when the run returns.
        </p>
      </Section>
    </>
  );
}
