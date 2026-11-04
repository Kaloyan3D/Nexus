import { ListChecks } from "lucide-react";
import { useMemo, useState } from "react";
import { relativeTime } from "../../lib/format";
import { useNexus } from "../../state/NexusContext";
import { taskStatusView } from "../../lib/status";
import { Alert, EmptyState, Loading, SearchInput, StatusDot, Tabs } from "../../components/ui/primitives";
import { TaskRow } from "../workspace/RecentTasks";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "failed", label: "Failed" },
  { id: "ready", label: "Ready" },
  { id: "done", label: "Done" },
];

export function TasksPage() {
  const { tasks, selection, select, selectedTask, refreshTasks } = useNexus();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const list = useMemo(() => {
    const all = tasks.data?.available ? tasks.data.tasks : [];
    const needle = q.trim().toLowerCase();
    return all.filter((t) => {
      const tone = taskStatusView(t.status).tone;
      const ok =
        filter === "all" ||
        (filter === "active" && tone === "purple") ||
        (filter === "failed" && tone === "error") ||
        (filter === "done" && tone === "success") ||
        (filter === "ready" && tone === "neutral");
      return ok && (!needle || t.title.toLowerCase().includes(needle) || t.taskId.toLowerCase().includes(needle));
    });
  }, [tasks.data, q, filter]);

  return (
    <div className="nv-page">
      <h1 className="nv-page__title">Tasks</h1>
      <p className="nv-page__sub">
        Authoritative task records read from the Controller ledger (read-only).
        {tasks.data?.source && <> Source: <code>{tasks.data.source}</code></>}
      </p>
      {tasks.data && !tasks.data.available && (
        <Alert tone="warning" title="Task ledger unavailable">
          {tasks.data.error}{" "}
          <button className="nv-link" type="button" onClick={refreshTasks}>
            Retry
          </button>
        </Alert>
      )}
      {tasks.loading && !tasks.data && <Loading label="Reading Controller ledger…" />}
      {tasks.data?.available && (
        <div className="nv-tasks-layout">
          <div className="nv-tasks-list">
            <SearchInput value={q} onChange={setQ} placeholder="Filter by title or ID…" label="Filter tasks" />
            <Tabs
              tabs={FILTERS.map((f) => ({ id: f.id, label: f.label }))}
              value={filter}
              onChange={setFilter}
              label="Status filter"
            />
            <div className="nv-tasks-list__scroll">
              {list.length === 0 && (
                <EmptyState icon={ListChecks} title="No tasks match">
                  Adjust the filter or search.
                </EmptyState>
              )}
              {list.map((t) => (
                <TaskRow
                  key={t.taskId}
                  task={t}
                  selected={selection?.kind === "task" && selection.id === t.taskId}
                  onSelect={() => select({ kind: "task", id: t.taskId })}
                />
              ))}
            </div>
          </div>
          <div className="nv-task-detail">
            {selectedTask ? (
              <TaskDetail />
            ) : (
              <EmptyState icon={ListChecks} title="Select a task">
                Choose a task to see its full ledger record.
              </EmptyState>
            )}
          </div>
        </div>
      )}
    </div>
  );

  function TaskDetail() {
    const t = selectedTask!;
    const v = taskStatusView(t.status);
    return (
      <div className="nv-scroll">
        <h2 className="nv-detail__title">{t.title}</h2>
        <div className="nv-heading__meta" style={{ margin: "8px 0 16px" }}>
          <span className="nv-badge nv-badge--mono">{t.taskId}</span>
          <span className={`nv-badge nv-badge--${v.tone === "neutral" ? "" : v.tone}`}>
            <StatusDot tone={v.tone} pulse={v.pulse} /> {v.label}
          </span>
          <span className="nv-heading__updated">Updated {relativeTime(t.updatedAtUtc)}</span>
        </div>
        {t.acceptanceCriteria.length > 0 && (
          <>
            <h3 className="nv-detail__h">Acceptance criteria</h3>
            <ul className="nv-list">
              {t.acceptanceCriteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        )}
        <h3 className="nv-detail__h">Description</h3>
        <pre className="nv-desc">{t.description || "(empty)"}</pre>
        {t.descriptionTruncated && <p className="nv-note">Description truncated for display.</p>}
      </div>
    );
  }
}
