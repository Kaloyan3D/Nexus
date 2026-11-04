import { CheckCircle2, CircleAlert, Loader2, TriangleAlert } from "lucide-react";
import type { HostSync, ProjectView } from "../../lib/contracts";
import { relativeTime } from "../../lib/format";
import { Alert } from "../../components/ui/primitives";
import { syncPolicySentence } from "../../lib/access";

/**
 * macOS projects: the engine finishing a task is not the same as the Mac folder being updated.
 * This says which of the two has happened, from the Mac host's own durable record.
 */
export function HostSyncNote({ hs, taskDone }: { hs: HostSync; taskDone?: boolean }) {
  const shown = hs.changed.slice(0, 6);
  const more = hs.changed.length - shown.length;
  if (hs.state === "conflict" || hs.state === "failed") {
    return (
      <Alert tone="error" title={hs.state === "conflict" ? "Not applied: your Mac folder changed too" : "Not applied: the update to your Mac folder stopped"}>
        {hs.message ?? hs.label}
        {hs.conflicts.length > 0 && (
          <ul className="nv-list">
            {hs.conflicts.map((c) => (
              <li key={c.path}>
                <code>{c.path}</code>: {c.reason}
              </li>
            ))}
          </ul>
        )}
        <p className="nv-note">Nothing on your Mac was overwritten. Nexus keeps its result{hs.savedResult ? ` (${hs.savedResult})` : ""}; once your file matches the original again, “Apply” on the project retries it.</p>
      </Alert>
    );
  }
  if (hs.state === "not-applied") {
    return (
      <p className="nv-note nv-run__sync" role="note">
        <TriangleAlert size={13} aria-hidden="true" /> {hs.label}. Your Mac folder was not changed.
        {hs.label.includes("could not be verified") ? " For a project without tests, choose the folder again and allow “also apply results that could not be verified”." : ""}
      </p>
    );
  }
  const done = hs.state === "applied";
  return (
    <p className="nv-note nv-run__sync" role="status" data-sync-state={hs.state}>
      {done ? <CheckCircle2 size={13} aria-hidden="true" /> : <Loader2 size={13} className="nv-spin" aria-hidden="true" />} {hs.label}
      {!done && taskDone ? " — the task has finished; its changes are not on your Mac yet" : ""}
      {done && hs.appliedMs ? ` · ${relativeTime(new Date(hs.appliedMs).toISOString())}` : ""}
      {done && shown.length > 0 ? ` · ${shown.map((c) => c.path).join(", ")}${more > 0 ? ` and ${more} more` : ""}` : ""}
    </p>
  );
}

const STATE_LABEL: Record<string, string> = {
  staging: "Copying to the engine…",
  running: "Nexus is working",
  exporting: "Collecting the result…",
  prepared: "Updating your Mac folder…",
  applying: "Updating your Mac folder…",
  conflict: "A result could not be applied: your Mac folder changed too",
  failed: "The last update to your Mac folder failed",
  synced: "In sync with your Mac folder",
};

export function ProjectSyncLine({ p }: { p: ProjectView }) {
  const s = p.sync;
  if (!s) return null;
  const bad = s.state === "conflict" || s.state === "failed";
  return (
    <div className="nv-project__snap">
      <p className="nv-note">
        {bad ? <CircleAlert size={13} aria-hidden="true" /> : s.state === "synced" ? <CheckCircle2 size={13} aria-hidden="true" /> : <Loader2 size={13} className="nv-spin" aria-hidden="true" />}{" "}
        <strong>{STATE_LABEL[s.state] ?? s.state}</strong>
        {s.lastSyncMs ? ` · last update ${relativeTime(new Date(s.lastSyncMs).toISOString())}` : ""}
      </p>
      {p.macPath && (
        <p className="nv-note">
          <code>{p.macPath}</code> · {s.files} file(s) synchronized
          {s.skippedTotal > 0 ? ` · ${s.skippedTotal} item(s) never copied (secrets, Git data, build output, links)` : ""}
        </p>
      )}
      <p className="nv-note">{syncPolicySentence(s.applyUnverified)}</p>
      {bad && s.conflicts.length > 0 && (
        <Alert tone="error" title="Needs your attention">
          Nexus did not overwrite: {s.conflicts.map((c) => c.path).join(", ")}. Open the task to see both versions.
        </Alert>
      )}
    </div>
  );
}
