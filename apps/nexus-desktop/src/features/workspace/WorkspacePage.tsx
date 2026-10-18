import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useNexus } from "../../state/NexusContext";
import { Loading } from "../../components/ui/primitives";
import { RunList } from "../history/RunList";
import { TaskView } from "../task/TaskView";
import { SetupCard } from "../setup/SetupCard";
import { ThreadView } from "../thread/ThreadView";
import { ThreadList } from "../thread/ThreadList";
import { UnifiedComposer } from "./UnifiedComposer";

/** Idle shows 5 recent runs, 3 on short windows. */
function useRecentLimit(): number {
  const [h, setH] = useState(() => window.innerHeight);
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return h < 800 ? 3 : 5;
}

function IdleView() {
  const { setPage, runtimeState } = useNexus();
  const interactive = runtimeState?.mode === "interactive";
  const limit = useRecentLimit();
  const needsSetup =
    runtimeState?.mode === "interactive" &&
    !(runtimeState.phase === "ready" && runtimeState.providerConnected && runtimeState.consent.given);
  if (needsSetup) {
    return (
      <div className="nv-page nv-narrow nv-idle">
        <SetupCard />
      </div>
    );
  }
  return (
    <div className="nv-page nv-narrow nv-idle">
      <h1 className="nv-hero">What should Nexus work on?</h1>
      <UnifiedComposer autoFocus />
      <section aria-label="Recent runs" className="nv-recentblock">
        <div className="nv-recentblock__head">
          <h2 className="nv-subheading">Recent</h2>
          <button type="button" className="nv-linkbtn" onClick={() => setPage("history")}>
            View all in History →
          </button>
        </div>
        {interactive ? <ThreadList limit={limit} /> : <RunList limit={limit} />}
      </section>
    </div>
  );
}

export function WorkspacePage() {
  const { selection, selectedModel, select } = useNexus();
  if (selection?.kind === "thread") return <ThreadView key={selection.id} threadId={selection.id} />;
  if (selection?.kind !== "model") return <IdleView />;
  return (
    <div className="nv-page nv-narrow nv-task">
      <button type="button" className="nv-linkbtn nv-newtask" onClick={() => select(null)}>
        <Plus size={13} aria-hidden="true" /> New task
      </button>
      {selectedModel ? <TaskView key={selectedModel.conversationId} summary={selectedModel} /> : <Loading label="Opening the run…" />}
    </div>
  );
}
