import { Bot, FlaskConical, ListChecks, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { relativeTime } from "../../lib/format";
import { taskStatusView } from "../../lib/status";
import { useNexus } from "../../state/NexusContext";
import type { MockRun } from "../../state/mockRuns";
import type { ModelConversationSummary, TaskRecord } from "../../lib/contracts";
import { modelStateView } from "../../lib/modelRun";
import { Alert, Badge, EmptyState, Loading, SearchInput, StatusDot } from "../../components/ui/primitives";

export function TaskRow({
  task,
  selected,
  onSelect,
}: {
  task: TaskRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  const v = taskStatusView(task.status);
  return (
    <button
      type="button"
      className="nv-row"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="nv-row__status">
        <StatusDot tone={v.tone} pulse={v.pulse} />
      </span>
      <span className="nv-row__main">
        <span className="nv-row__title">{task.title}</span>
        <span className="nv-row__meta">
          <span className="nv-mono">{task.taskId}</span>
          {task.boundEngine && <span>{task.boundEngine}</span>}
          <span>{v.label}</span>
          <span>{relativeTime(task.updatedAtUtc ?? task.createdAtUtc)}</span>
        </span>
      </span>
    </button>
  );
}

export function MockRow({
  run,
  selected,
  onSelect,
}: {
  run: MockRun;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone = run.status === "failed" ? "error" : run.status === "done" ? "success" : "purple";
  return (
    <button
      type="button"
      className="nv-row"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="nv-row__status">
        <StatusDot tone={tone} pulse={run.status === "running"} />
      </span>
      <span className="nv-row__main">
        <span className="nv-row__title">{run.prompt}</span>
        <span className="nv-row__meta">
          <Badge tone="warning" icon={<FlaskConical size={11} />}>
            MOCK
          </Badge>
          <span>{run.status === "running" ? "Running" : run.status === "done" ? "Completed" : "Failed"}</span>
          <span>{relativeTime(new Date(run.startedAtMs).toISOString())}</span>
        </span>
      </span>
    </button>
  );
}

export function ModelRow({
  run,
  selected,
  onSelect,
}: {
  run: ModelConversationSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const v = modelStateView(run.state);
  return (
    <button
      type="button"
      className="nv-row"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="nv-row__status">
        <StatusDot tone={v.tone} pulse={v.pulse} />
      </span>
      <span className="nv-row__main">
        <span className="nv-row__title">{run.firstPrompt || "(model run)"}</span>
        <span className="nv-row__meta">
          <Badge tone={run.endpointKind === "provider" ? "purple" : "warning"} icon={<Bot size={11} />}>
            {run.endpointKind === "provider" ? "MODEL" : "FIXTURE"}
          </Badge>
          <span className="nv-mono">
            {run.providerId ?? "?"}/{run.remoteModelId ?? "?"}
          </span>
          <span>{v.label}</span>
          {run.startedAtMs !== null && <span>{relativeTime(new Date(run.startedAtMs).toISOString())}</span>}
        </span>
      </span>
    </button>
  );
}

export function RecentTasks() {
  const { tasks, mockRuns, modelRuns, selection, select } = useNexus();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();

  const filtered = useMemo(() => {
    const list = tasks.data?.available ? tasks.data.tasks : [];
    if (!needle) return list.slice(0, 60);
    return list.filter(
      (t) =>
        t.title.toLowerCase().includes(needle) ||
        t.taskId.toLowerCase().includes(needle) ||
        t.status.toLowerCase().includes(needle),
    );
  }, [tasks.data, needle]);
  const mocks = needle ? mockRuns.filter((m) => m.prompt.toLowerCase().includes(needle)) : mockRuns;

  return (
    <section className="nv-recent" aria-label="Recent tasks">
      <div className="nv-recent__head">
        <h2>Recent Tasks</h2>
        {tasks.data?.available && (
          <span className="nv-recent__count">{tasks.data.tasks.length}</span>
        )}
      </div>
      <SearchInput value={q} onChange={setQ} placeholder="Search tasks…" label="Search tasks" />
      <div className="nv-recent__list">
        {modelRuns.length > 0 && (
          <>
            <div className="nv-group-label">Model-only runs · user-initiated, text only</div>
            {modelRuns.map((m) => (
              <ModelRow
                key={m.conversationId}
                run={m}
                selected={selection?.kind === "model" && selection.id === m.conversationId}
                onSelect={() => select({ kind: "model", id: m.conversationId })}
              />
            ))}
          </>
        )}
        {mocks.length > 0 && (
          <>
            <div className="nv-group-label">Mock runs · not in the Controller ledger</div>
            {mocks.map((m) => (
              <MockRow
                key={m.key}
                run={m}
                selected={selection?.kind === "mock" && selection.id === m.key}
                onSelect={() => select({ kind: "mock", id: m.key })}
              />
            ))}
          </>
        )}
        <div className="nv-group-label">Controller ledger</div>
        {tasks.loading && !tasks.data && <Loading label="Reading Controller ledger…" />}
        {tasks.data && !tasks.data.available && (
          <div style={{ padding: "8px 4px" }}>
            <Alert tone="warning" title="Task ledger unavailable">
              {tasks.data.error ?? "No ledger could be read."} Set <code>NEXUS_LEDGER_DIR</code> to
              the Controller state directory.
            </Alert>
          </div>
        )}
        {tasks.data?.available && filtered.length === 0 && (
          <EmptyState icon={ListChecks} title={needle ? "No matching tasks" : "No tasks in the ledger"}>
            {needle ? "Try a different search." : "The Controller ledger contains no task records."}
          </EmptyState>
        )}
        {filtered.map((t) => (
          <TaskRow
            key={t.taskId}
            task={t}
            selected={selection?.kind === "task" && selection.id === t.taskId}
            onSelect={() => select({ kind: "task", id: t.taskId })}
          />
        ))}
      </div>
      <div className="nv-recent__foot">
        <Plus size={13} aria-hidden="true" /> Tasks are created by the Controller. Model-only runs are started by the operator (nexus model run); this window follows and can cancel them.
      </div>
    </section>
  );
}
