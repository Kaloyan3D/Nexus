import { MessagesSquare } from "lucide-react";
import { useMemo, useState } from "react";
import { relativeTime } from "../../lib/format";
import { modelStateView } from "../../lib/modelRun";
import type { ThreadSummary } from "../../lib/contracts";
import { EmptyState, Badge, SearchInput, StatusDot } from "../../components/ui/primitives";
import { useNexus } from "../../state/NexusContext";

export function ThreadRow({ t, selected, onSelect, projectLabel }: { t: ThreadSummary; selected: boolean; onSelect: () => void; projectLabel: string }) {
  const v = modelStateView(t.active ? "executing" : t.lastState || "completed");
  return (
    <button type="button" className="nv-row" aria-current={selected ? "true" : undefined} onClick={onSelect}>
      <span className="nv-row__status">
        <StatusDot tone={t.active ? "purple" : v.tone} pulse={t.active} />
      </span>
      <span className="nv-row__main">
        <span className="nv-row__title">{t.title || "Conversation"}</span>
        <span className="nv-row__meta">
          <Badge mono>{projectLabel}</Badge>
          <span>
            {t.runCount} run{t.runCount === 1 ? "" : "s"}
          </span>
          {t.findingCount > 0 && (
            <span>
              {t.findingCount} finding{t.findingCount === 1 ? "" : "s"}
            </span>
          )}
          <span>{t.active ? "Working" : v.label}</span>
          <span>{relativeTime(new Date(t.updatedAtMs).toISOString())}</span>
        </span>
        {t.lastPreview && <span className="nv-row__preview">{t.lastPreview}</span>}
      </span>
    </button>
  );
}

/** The user's conversations, newest activity first. Opening one restores it from the broker's durable record. */
export function ThreadList({ limit, filters = false }: { limit?: number; filters?: boolean }) {
  const { threads, selection, openThread, projects, intentCodeSources } = useNexus();
  const [q, setQ] = useState("");
  const [project, setProject] = useState<string>("all");
  const label = (id: string) => projects.find((p) => p.projectId === id)?.label ?? intentCodeSources?.find((s) => s.sourceId === id)?.label ?? id;
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => {
    const list = threads.filter((t) => (project === "all" || t.projectId === project) && (!needle || `${t.title} ${t.lastPreview}`.toLowerCase().includes(needle)));
    return limit ? list.slice(0, limit) : list;
  }, [threads, project, needle, limit]);
  const projectIds = Array.from(new Set(threads.map((t) => t.projectId)));
  return (
    <div className="nv-runlist">
      {filters && (
        <div className="nv-runlist__filters">
          <label className="nv-sr-only" htmlFor="nv-thread-project-filter">
            Project
          </label>
          <select id="nv-thread-project-filter" className="nv-select" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="all">All projects</option>
            {projectIds.map((id) => (
              <option key={id} value={id}>
                {label(id)}
              </option>
            ))}
          </select>
          <SearchInput value={q} onChange={setQ} placeholder="Search conversations…" label="Search conversations" />
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState icon={MessagesSquare} title={threads.length === 0 ? "No conversations yet" : "No matching conversations"}>
          {threads.length === 0 ? "Describe a task in Workspace to start one." : "Try a different filter."}
        </EmptyState>
      ) : (
        <div className="nv-runlist__rows" role="list" aria-label="Conversations">
          {rows.map((t) => (
            <ThreadRow key={t.threadId} t={t} projectLabel={label(t.projectId)} selected={selection?.kind === "thread" && selection.id === t.threadId} onSelect={() => openThread(t.threadId)} />
          ))}
        </div>
      )}
    </div>
  );
}
