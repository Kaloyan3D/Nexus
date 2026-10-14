import { Activity, FileBox, ListChecks, SquareStack, X } from "lucide-react";
import type { TaskRecord } from "../../lib/contracts";
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
