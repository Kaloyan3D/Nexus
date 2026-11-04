import { useEffect, useState } from "react";
import type { RunResumable } from "../../lib/contracts";
import { Button } from "../../components/ui/primitives";
import { useNexus } from "../../state/NexusContext";

/**
 * Resume for an interrupted run. Whether a run can be resumed is the BROKER's answer (`intent-resumable`,
 * the same rule set `intent-resume` enforces); this component never decides eligibility itself and never
 * sends a chat message. Resuming calls the native resume for exactly this run, which continues from its
 * working copy and its authenticated engine state in a NEW run. When the broker says no, its reason is shown.
 */
export function ResumeControl({ runId }: { runId: string }) {
  const { api, refreshThreads } = useNexus();
  const [r, setR] = useState<RunResumable | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .runResumable(runId)
      .then((x) => alive && setR(x))
      .catch(() => alive && setR(null));
    return () => {
      alive = false;
    };
  }, [api, runId]);
  if (!r) return null;
  if (!r.resumable) {
    return r.reason ? (
      <p className="nv-note" aria-label="Resume unavailable">
        Cannot be resumed: {r.reason}
      </p>
    ) : null;
  }
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.intentResume(runId);
      await refreshThreads();
    } catch (e) {
      setErr((e as { message?: string })?.message ?? "Could not resume.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="nv-run__resume" role="group" aria-label="Resume this run">
      <Button variant="primary" size="sm" onClick={() => void go()} disabled={busy} title="Continue this run from its working copy and engine state, in a new run">
        {busy ? "Resuming…" : "Resume this run"}
      </Button>
      <span className="nv-note"> Continues from this run's work in a new run (not a new chat message).</span>
      {err && (
        <p className="nv-note" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
