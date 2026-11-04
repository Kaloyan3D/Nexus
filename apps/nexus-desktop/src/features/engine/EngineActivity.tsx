import { useEffect, useState } from "react";
import type { RunEngineSummary, UiError } from "../../lib/contracts";
import { Alert, Badge } from "../../components/ui/primitives";
import { useNexus } from "../../state/NexusContext";
import { engineLabelForMode } from "./EngineChoice";

const EVENT_LABEL: Record<string, string> = {
  "effort-selected": "Reasoning effort chosen",
  "effort-reset-continuation": "Effort reset for a continuation",
  "run-ended": "Run ended",
  "continued-without-predecessor-state": "Continued without earlier engine state",
  "predecessor-state-from-ancestor": "Earlier engine state inherited",
};

/**
 * What the run's engine DURABLY recorded: the engine, each attempt's reasoning effort and the effort
 * events, read from the broker's authenticated engine-state record. Nothing here is inferred or mocked;
 * when the record is absent or cannot be authenticated nothing is shown as an effort event.
 */
export function EngineActivity({ runId, live }: { runId: string; live: boolean }) {
  const { api } = useNexus();
  const [s, setS] = useState<RunEngineSummary | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .runEngine(runId)
        .then((x) => alive && (setS(x), setErr(null)))
        .catch((e) => alive && setErr(e as UiError));
    void load();
    if (!live) return () => void (alive = false);
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api, runId, live]);
  if (err) {
    return err.code === "engine-state-unverified" ? (
      <Alert tone="warning" title="Engine record could not be verified">
        Its contents are not shown.
      </Alert>
    ) : null;
  }
  if (!s || !s.bound.engineId) return null;
  const name = engineLabelForMode(s.bound.modeId) ?? s.bound.engineId;
  const rec = s.record;
  return (
    <details className="nv-details nv-engineactivity" open={live}>
      <summary>
        Engine: {name}
        {rec ? ` · ${rec.attempts.length} attempt${rec.attempts.length === 1 ? "" : "s"}` : ""}
      </summary>
      <p className="nv-note">
        <Badge mono>{s.bound.engineId}</Badge> {s.bound.route ? <Badge mono>{s.bound.route}</Badge> : null}
        {rec ? <> default effort <strong>{rec.defaultEffort}</strong>{rec.authenticated ? " · record verified" : ""}</> : " · no engine record yet"}
      </p>
      {rec && rec.attempts.length > 0 && (
        <ol className="nv-list" aria-label="Attempts">
          {rec.attempts.map((a) => (
            <li key={a.ordinal}>
              Attempt {a.ordinal}: effort <strong>{a.effort}</strong> · {a.state}
            </li>
          ))}
        </ol>
      )}
      {rec && rec.events.length > 0 && (
        <ul className="nv-list" aria-label="Effort events">
          {rec.events.map((e, i) => (
            <li key={i}>
              {EVENT_LABEL[e.kind] ?? e.kind}
              {e.attempt != null ? ` (attempt ${e.attempt})` : ""}
              {e.effort ? `: ${e.effort}` : ""}
              {e.detail ? ` — ${e.detail}` : ""}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
