import { Check, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import type { DependencyRecord, IntentRun, PendingPermission, PermissionMode } from "../../lib/contracts";
import { asUiError } from "../../lib/api";
import { useNow } from "../../lib/useViewport";
import { Alert, Badge, Button } from "../../components/ui/primitives";
import { useNexus } from "../../state/NexusContext";

export const PERMISSION_MODES: Array<{ id: PermissionMode; label: string; title: string }> = [
  { id: "ask", label: "Ask for Approval", title: "Safe work runs on its own. Nexus asks before installing dependencies, before deleting files, and before anything that uses the network." },
  { id: "auto-safe", label: "Auto Approve Safe Operations", title: "Edits, builds, tests and single-file deletions run without asking. Nexus still asks before installing dependencies and before bulk deletions." },
  { id: "full", label: "Full Access", title: "Nexus does not ask again during the run: it may run commands, install packages and delete files in the project's working copy. It stays inside the project's permissions and the sandbox." },
];

export const modeLabel = (m: PermissionMode | undefined | null): string => PERMISSION_MODES.find((x) => x.id === (m ?? "ask"))?.label ?? "Ask for Approval";

/** The mode selector of the composer and of a running task. */
export function PermissionModeSwitch({ value, onChange, disabled, label = "Permissions" }: { value: PermissionMode; onChange: (m: PermissionMode) => void; disabled?: boolean; label?: string }) {
  return (
    <div className="nv-seg nv-seg--perm" role="radiogroup" aria-label={label}>
      {PERMISSION_MODES.map((m) => (
        <button key={m.id} type="button" role="radio" aria-checked={value === m.id} disabled={disabled} onClick={() => onChange(m.id)} title={m.title} data-mode={m.id}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

const pkgText = (p: { name: string; constraint: string }) => (p.constraint ? `${p.name} (${p.constraint})` : p.name);

/** One request waiting for the person. The decision itself is made in a native confirmation. */
export function PermissionCard({ run, request }: { run: IntentRun; request: PendingPermission }) {
  const { api } = useNexus();
  const now = useNow(1000);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const left = Math.max(0, Math.round((request.expiresAtMs - now) / 1000));
  const isInstall = request.kind === "dependency-install";
  const plan = request.plan;
  const decide = async (decision: "approve" | "deny") => {
    setBusy(decision);
    setError(null);
    try {
      await api.permissionDecide(run.runId, request.requestId, request.digest, decision);
    } catch (e) {
      setError(asUiError(e).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="nv-approval nv-permcard" role="region" aria-label="Permission request">
      <div className="nv-approval__row">
        <ShieldAlert size={16} aria-hidden="true" />
        <strong>{isInstall ? "Nexus wants to install dependencies — nothing has run" : request.kind === "bulk-delete" ? "Nexus wants to delete several files — nothing has run" : "Nexus wants to delete files — nothing has run"}</strong>
        <Badge tone="warning">{left > 0 ? `expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "expired"}</Badge>
      </div>
      {isInstall && plan && (
        <dl className="nv-permcard__facts">
          <dt>Package manager</dt>
          <dd>{plan.manager}</dd>
          <dt>Operation</dt>
          <dd>{plan.verb}</dd>
          <dt>Packages</dt>
          <dd>{plan.packages.length > 0 ? plan.packages.map(pkgText).join(", ") : "everything the project's manifest and lockfile declare"}</dd>
          {plan.options.length > 0 && (
            <>
              <dt>Options</dt>
              <dd>{plan.options.join(", ")}</dd>
            </>
          )}
          <dt>Workspace</dt>
          <dd className="nv-mono">{request.cwd}</dd>
        </dl>
      )}
      <p className="nv-note">
        Command: <span className="nv-mono">{[request.program, ...request.args].join(" ")}</span>
        {request.purpose ? ` · while: ${request.purpose}` : ""}
      </p>
      <p className="nv-note">Approving runs this one command, once. A confirmation window will show the details again before anything happens.</p>
      <div className="nv-permcard__actions">
        <Button variant="primary" size="sm" disabled={busy !== null || left === 0} onClick={() => void decide("approve")} icon={<Check size={14} />}>
          Approve once
        </Button>
        <Button size="sm" disabled={busy !== null} onClick={() => void decide("deny")} icon={<Trash2 size={14} />}>
          Deny
        </Button>
      </div>
      {error && (
        <Alert tone="warning" title="Not recorded">
          {error}
        </Alert>
      )}
    </section>
  );
}

function DependencyList({ deps }: { deps: DependencyRecord[] }) {
  return (
    <ul className="nv-list" aria-label="Dependencies this run acquired">
      {deps.map((d, i) => (
        <li key={`${d.atMs}-${i}`}>
          <Check size={11} aria-hidden="true" /> {d.manager} {d.verb}
          {d.packages.length > 0 ? `: ${d.packages.join(", ")}` : ""} — {d.outcome}
          {d.exitCode != null ? ` (exit ${d.exitCode})` : ""} · {d.decision === "auto-full-access" ? "automatic (Full Access)" : d.decision === "approved-once" ? "you approved once" : d.decision}
        </li>
      ))}
    </ul>
  );
}

/**
 * The permission surface of a coding run: the active mode (changeable while it runs; a more autonomous mode is
 * confirmed natively), the request waiting for the person, and, afterwards, what the run installed and decided.
 */
export function PermissionPanel({ run, live }: { run: IntentRun; live: boolean }) {
  const { api } = useNexus();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mode: PermissionMode = run.permissionMode ?? "ask";
  const pending = live ? run.pendingPermission ?? null : null;
  const deps = run.dependencies ?? [];
  const events = run.permissionEvents ?? [];
  const change = async (m: PermissionMode) => {
    if (m === mode) return;
    setBusy(true);
    setError(null);
    try {
      await api.permissionSetMode(run.runId, m);
    } catch (e) {
      setError(asUiError(e).message);
    } finally {
      setBusy(false);
    }
  };
  if (!live && deps.length === 0 && events.filter((e) => e.kind !== "mode-set").length === 0 && mode === "ask") return null;
  return (
    <section className="nv-perm" aria-label="Permissions for this run">
      <div className="nv-perm__row">
        {mode === "full" ? <ShieldAlert size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
        <strong>Permissions:</strong>
        <Badge tone={mode === "full" ? "warning" : "purple"} title="The permission mode of this run">
          {modeLabel(mode)}
        </Badge>
        {live && <PermissionModeSwitch value={mode} onChange={(m) => void change(m)} disabled={busy} label="Change permissions for this run" />}
      </div>
      {error && (
        <Alert tone="warning" title="Mode not changed">
          {error}
        </Alert>
      )}
      {pending && <PermissionCard run={run} request={pending} />}
      {deps.length > 0 && <DependencyList deps={deps} />}
      {!live && events.length > 1 && (
        <p className="nv-note">
          {events.filter((e) => e.kind === "approved" || e.kind === "denied" || e.kind === "mode-downgrade" || e.kind === "mode-upgrade-confirmed").length} permission decision(s) recorded for this run.
        </p>
      )}
    </section>
  );
}
