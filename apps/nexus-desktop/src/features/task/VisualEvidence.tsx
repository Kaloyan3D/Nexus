import { useState } from "react";
import { asUiError } from "../../lib/api";
import { useNexus } from "../../state/NexusContext";
import type { BrowserEvidence, IntentRun, ScreenshotRef } from "../../lib/contracts";
import { browserInspections, evidenceRows, hasVisualEvidence, inspectionSummary, sizeLabel, visualRequirement } from "../../lib/visualEvidence";
import { Alert, Button } from "../../components/ui/primitives";

const DELIVERY: Record<string, string> = {
  "delivered-to-vision-model": "shown to the model",
  "not-delivered-text-only-model": "NOT shown: the model cannot read images",
  "not-delivered-unknown-model": "NOT shown: the model is not known to read images",
  "not-delivered-too-large": "NOT shown: too large",
  "no-screenshot": "no screenshot",
};

function Shot({ runId, ev, shot }: { runId: string; ev: BrowserEvidence; shot: ScreenshotRef }) {
  const { api } = useNexus();
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    setErr(null);
    try {
      const a = await api.browserArtifact(runId, ev.evidenceId, shot.file);
      setSrc(`data:${a.mediaType};base64,${a.dataB64}`);
    } catch (e) {
      setErr(asUiError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <figure className="nv-shot">
      {src ? (
        <img className="nv-shot__img" src={src} alt={`Screenshot "${shot.name}" at ${ev.viewport} ${shot.viewportW}×${shot.viewportH}`} />
      ) : (
        <Button size="sm" onClick={load} disabled={busy || !shot.file}>
          {busy ? "Loading…" : "Show screenshot"}
        </Button>
      )}
      {err && <Alert tone="error">{err}</Alert>}
      <figcaption className="nv-shot__cap">
        {shot.name} · {shot.viewportW}×{shot.viewportH} · {sizeLabel(shot.bytes)} · <code title={shot.sha256}>{shot.sha256.slice(0, 12)}</code> ·{" "}
        {shot.delivery === "delivered" ? "shown to the model" : "not shown to the model"}
      </figcaption>
    </figure>
  );
}

/** M4.1: what the browser actually did and showed, and which kind of evidence each fact is. */
export function VisualEvidence({ run }: { run: IntentRun }) {
  if (!hasVisualEvidence(run)) return null;
  const req = visualRequirement(run);
  const rows = evidenceRows(run);
  const inspections = browserInspections(run);
  return (
    <section className="nv-visual" aria-label="Browser and visual evidence">
      {req && (
        <p className={`nv-visual__req nv-visual__req--${req.tone}`} role="status">
          <strong>{req.title}.</strong> {req.detail}
        </p>
      )}
      {rows.length > 0 && (
        <dl className="nv-visual__rows">
          {rows.map((r) => (
            <div key={r.id} className={`nv-visual__row nv-visual__row--${r.tone}`}>
              <dt>{r.label}</dt>
              <dd>
                <strong>{r.state}</strong> — {r.detail}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {inspections.map(({ activity, evidence: ev }) => (
        <details key={ev.evidenceId} className="nv-visual__inspection">
          <summary>
            Inspection {activity.index}: {ev.url} — {inspectionSummary(ev)}
          </summary>
          <p className="nv-note">
            {ev.startedAt} · {ev.durationMs} ms · {DELIVERY[ev.imageDelivery] ?? ev.imageDelivery}
            {ev.error ? ` · ${ev.error}` : ""}
          </p>
          {ev.steps.length > 0 && (
            <ul className="nv-visual__steps">
              {ev.steps.map((s, i) => (
                <li key={i}>
                  {s.ok ? "✓" : "✗"} {s.do}
                  {s.error ? ` — ${s.error}` : ""}
                </li>
              ))}
            </ul>
          )}
          <div className="nv-visual__shots">
            {ev.screenshots
              .filter((s) => s.sha256)
              .map((s) => (
                <Shot key={s.sha256} runId={run.runId} ev={ev} shot={s} />
              ))}
          </div>
        </details>
      ))}
    </section>
  );
}
