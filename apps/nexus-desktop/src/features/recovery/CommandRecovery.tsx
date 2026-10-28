import { History, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { asUiError } from "../../lib/api";
import type { ExecEffects, IntentRun, PathList, RestoreItem, RestorePreview, ToolActivity, UiError } from "../../lib/contracts";
import { Alert, Badge, Button, Loading } from "../../components/ui/primitives";
import { useNexus } from "../../state/NexusContext";

/** `restore-refused`, `busy: …`, `changed: …` are reasons; a person reads the sentence. */
function sentence(e: UiError): string {
  return e.message.replace(/^(?:refused|busy|changed|not-found|recovery):\s*/, "");
}

function Paths({ title, items, max = 8 }: { title: string; items: string[]; max?: number }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="nv-note">
        {title} ({items.length})
      </div>
      <ul className="nv-list nv-mono nv-recovery__paths">
        {items.slice(0, max).map((p) => (
          <li key={p}>{p}</li>
        ))}
        {items.length > max && <li className="nv-note">… and {items.length - max} more</li>}
      </ul>
    </div>
  );
}

const pathsOf = (l: PathList | undefined): string[] => l?.paths ?? [];
const countOf = (l: PathList | undefined): number => l?.count ?? 0;

function Review({ executionId, onApplied }: { executionId: string; onApplied: () => void }) {
  const { api } = useNexus();
  const [pv, setPv] = useState<RestorePreview | null>(null);
  const [loadErr, setLoadErr] = useState<UiError | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .recoveryPreview(executionId)
      .then((p) => alive && setPv(p))
      .catch((e: unknown) => alive && setLoadErr(asUiError(e)));
    return () => {
      alive = false;
    };
  }, [api, executionId]);
  if (loadErr) return <Alert tone="warning" title="Recovery is not available">{sentence(loadErr)}</Alert>;
  if (!pv) return <Loading label="Checking what can be restored…" />;
  const r = pv.restore;
  const items = (l: RestoreItem[]) => l.map((i) => i.path);
  const can = r.refused === null && r.restored.length > 0;
  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      const out = await api.recoveryApply(executionId, pv.confirmDigest);
      const x = out.restore;
      setResult(`${x.restored.length} file${x.restored.length === 1 ? "" : "s"} restored · ${x.skipped.length} already as before · ${x.conflicted.length} left alone because they changed since · ${x.unrecoverable.length} could not be restored.`);
      onApplied();
    } catch (e) {
      const u = asUiError(e);
      // declining the system dialog is not a failure
      if (u.code !== "cancelled" && u.message !== "cancelled") setErr(u);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="nv-recovery__review" role="group" aria-label="Recovery review">
      {r.refused && <Alert tone="warning" title="Nothing can be restored right now">{r.refused}</Alert>}
      <Paths title="Would be restored" items={items(r.restored)} />
      <Paths title="Already as they were" items={items(r.skipped)} />
      <Paths title="Changed since — will be left alone" items={items(r.conflicted)} />
      <Paths title="Cannot be recovered" items={items(r.unrecoverable)} />
      {!r.refused && r.restored.length === 0 && !result && <p className="nv-note">There is nothing to restore: every file is already as it was, or was changed afterwards.</p>}
      {r.recordListsTruncated && <p className="nv-note">The change record was too long to list every file; files beyond it are not covered.</p>}
      <p className="nv-note">{r.note}</p>
      {can && !result && (
        <Button variant="primary" size="sm" disabled={busy} icon={busy ? <Loader2 size={13} className="nv-spin" /> : <RotateCcw size={13} />} onClick={() => void apply()}>
          Restore {r.restored.length} file{r.restored.length === 1 ? "" : "s"}…
        </Button>
      )}
      {result && <p role="status">{result}</p>}
      {err && <Alert tone="warning" title="Nothing was restored">{sentence(err)}</Alert>}
    </div>
  );
}

function Command({ a }: { a: ToolActivity }) {
  const { api } = useNexus();
  const id = a.executionId as string;
  const [data, setData] = useState<ExecEffects | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    api
      .commandEffects(id)
      .then((d) => alive && (setData(d), setErr(null)))
      .catch((e: unknown) => alive && setErr(asUiError(e)));
    return () => {
      alive = false;
    };
  }, [api, id, tick]);
  if (err) return <li className="nv-recovery__cmd"><code>{a.argsSummary}</code> <span className="nv-note">— no change record: {sentence(err)}</span></li>;
  if (!data) return <li><Loading label="Reading what the command changed…" /></li>;
  const e = data.effects;
  const created = countOf(e.effects.created);
  const modified = countOf(e.effects.modified);
  const deleted = countOf(e.effects.deleted);
  const total = created + modified + deleted;
  const rec = e.recoverability;
  const observed = e.outcome === "observed";
  return (
    <li className="nv-recovery__cmd">
      <div className="nv-heading__meta">
        <code>{a.argsSummary}</code>
        <Badge tone={observed ? "success" : "warning"} title={e.outcomeReasons.join("; ") || undefined}>
          {observed ? "changes observed" : e.outcome === "partial" ? "partly observed" : "not fully observed"}
        </Badge>
      </div>
      <p className="nv-note">
        {total === 0 ? "It changed no files in the project." : `Created ${created} · changed ${modified} · deleted ${deleted} file${total === 1 ? "" : "s"} in the project folder.`}
      </p>
      <Paths title="Created" items={pathsOf(e.effects.created)} max={5} />
      <Paths title="Changed" items={pathsOf(e.effects.modified)} max={5} />
      <Paths title="Deleted" items={pathsOf(e.effects.deleted)} max={5} />
      {rec && modified + deleted > 0 && (
        <p className="nv-note">
          {rec.complete ? "The original of every changed or deleted file was saved before the command ran." : `Originals saved for ${rec.available} file${rec.available === 1 ? "" : "s"}; ${rec.unavailable + rec.bulkNotCaptured} could not be saved, so they cannot be restored.`}
        </p>
      )}
      {!observed && <p className="nv-note">Nexus could not fully observe this command, so the lists above may be incomplete. Check your folder yourself.</p>}
      {total > 0 && (
        <div>
          <Button size="sm" variant="ghost" aria-expanded={reviewing} icon={<History size={13} />} onClick={() => setReviewing((r) => !r)}>
            {reviewing ? "Hide recovery" : "Review recovery…"}
          </Button>
        </div>
      )}
      {reviewing && <Review executionId={id} onApplied={() => setTick((t) => t + 1)} />}
    </li>
  );
}

/**
 * What the commands of a run changed in the project folder, and what can be put back. Recovery is guarded:
 * the preview changes nothing, the apply is bound to that preview and confirmed in a system dialog, and
 * anything changed since is left alone. It covers only what Nexus OBSERVED - it is not a universal undo.
 */
export function RecoverySection({ run }: { run: IntentRun }) {
  const ops = (run.toolActivity ?? []).filter((a) => a.tool === "proc_run" && a.executionId);
  const direct = run.workspaceKind === "direct";
  const edits = run.codingOutcome?.editsApplied ?? 0;
  return (
    <section className="nv-recovery" aria-label="Recover changes">
      <h3 className="nv-subheading">Recover changes</h3>
      {ops.length > 0 && (
        <ul className="nv-list">
          {ops.map((a) => (
            <Command key={a.index} a={a} />
          ))}
        </ul>
      )}
      {direct && edits > 0 && (
        <p className="nv-note">
          Nexus saved the original of each of the {edits} file{edits === 1 ? "" : "s"} it edited directly in your folder (kept for 30 days). Restoring file edits with one click is not available in this version: use the Diff tab to see exactly what changed, and your version control to go back.
        </p>
      )}
      {!direct && ops.length === 0 && <p className="nv-note">This run worked on a copy: your folder is unchanged until you apply the changes, so there is nothing to restore.</p>}
      {direct && ops.length === 0 && edits === 0 && <p className="nv-note">This run changed nothing in your folder.</p>}
      <p className="nv-note">Only changes Nexus observed inside the project folder can be restored. Downloads, changes outside the folder, and the contents of dependency folders are not recoverable — this is not a universal undo.</p>
    </section>
  );
}
