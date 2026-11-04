import { useMemo, useState } from "react";
import { ListChecks } from "lucide-react";
import { KIND_GROUP, runKind, type RunKind } from "../../lib/runKind";
import { useNexus } from "../../state/NexusContext";
import { EmptyState, SearchInput } from "../../components/ui/primitives";
import { ModelRow } from "../workspace/RecentTasks";

const KINDS: Array<{ id: "all" | RunKind; label: string }> = [
  { id: "all", label: "All" },
  { id: "code", label: "Code in copy" },
  { id: "inspect", label: "Inspect" },
  { id: "ask", label: "Ask" },
];

/** Every run the broker knows, newest first, by kind. Opening one reopens its task view from durable records. */
export function RunList({ limit, filters = false }: { limit?: number; filters?: boolean }) {
  const { modelRuns, runByConversation, selection, select } = useNexus();
  const [kind, setKind] = useState<"all" | RunKind>("all");
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => {
    const list = modelRuns.filter((m) => {
      const k = runKind(runByConversation.get(m.conversationId));
      if (kind !== "all" && k !== kind) return false;
      return !needle || (m.firstPrompt ?? "").toLowerCase().includes(needle);
    });
    return limit ? list.slice(0, limit) : list;
  }, [modelRuns, runByConversation, kind, needle, limit]);
  return (
    <div className="nv-runlist">
      {filters && (
        <div className="nv-runlist__filters">
          <div className="nv-seg" role="group" aria-label="Filter by kind">
            {KINDS.map((k) => (
              <button key={k.id} type="button" aria-pressed={kind === k.id} onClick={() => setKind(k.id)} title={k.id === "all" ? "All runs" : KIND_GROUP[k.id]}>
                {k.label}
              </button>
            ))}
          </div>
          <SearchInput value={q} onChange={setQ} placeholder="Search runs…" label="Search runs" />
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState icon={ListChecks} title={modelRuns.length === 0 ? "No runs yet" : "No matching runs"}>
          {modelRuns.length === 0 ? "Describe a task in Workspace to start one." : "Try a different filter."}
        </EmptyState>
      ) : (
        <div className="nv-runlist__rows">
          {rows.map((m) => (
            <ModelRow
              key={m.conversationId}
              run={m}
              record={runByConversation.get(m.conversationId) ?? null}
              selected={selection?.kind === "model" && selection.id === m.conversationId}
              onSelect={() => select({ kind: "model", id: m.conversationId })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
