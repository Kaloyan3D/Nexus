import { useState } from "react";
import { useNexus } from "../../state/NexusContext";
import { ThreadList } from "../thread/ThreadList";
import { RunList } from "./RunList";

/** History: conversations (the durable, resumable unit) and, separately, every individual run. */
export function HistoryPage() {
  const { runtimeState } = useNexus();
  const interactive = runtimeState?.mode === "interactive";
  const [view, setView] = useState<"conversations" | "runs" | null>(null);
  const shown = interactive ? (view ?? "conversations") : "runs";
  return (
    <div className="nv-page nv-narrow">
      <h1 className="nv-pagetitle">History</h1>
      {interactive && (
        <div className="nv-seg" role="group" aria-label="History view">
          <button type="button" aria-pressed={shown === "conversations"} onClick={() => setView("conversations")}>
            Conversations
          </button>
          <button type="button" aria-pressed={shown === "runs"} onClick={() => setView("runs")}>
            Runs
          </button>
        </div>
      )}
      {shown === "conversations" ? (
        <>
          <p className="nv-note">Every conversation, restored from durable records, including after a restart. Open one to continue it.</p>
          <ThreadList filters />
        </>
      ) : (
        <>
          <p className="nv-note">Every run recorded by the broker. Opening one reopens its result, evidence and transcript from durable records, including after a restart.</p>
          <RunList filters />
        </>
      )}
    </div>
  );
}
