import { useState } from "react";
import { FolderGit2, FolderOpen, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useNexus } from "../../state/NexusContext";
import type { ProjectView, WorkspaceMode } from "../../lib/contracts";
import { Alert, Badge, Button, EmptyState } from "../../components/ui/primitives";

/**
 * Read-only: the projects the operator has authorized. Registering a project (a path, a
 * commit pin, a write scope, a credential) is an operator action on the broker, never
 * something the Desktop can do or request.
 */

const FS_LABEL: Record<string, string> = {
  scratch: "Commands work on a throw-away copy",
  workspace: "Commands change the task's working copy",
};
const NET_LABEL: Record<string, string> = { offline: "No network", install: "Network for dependency installs" };
const APPROVAL_LABEL: Record<string, string> = { auto: "Runs without asking (inside these permissions)", ask: "Asks me first (approver terminal)" };
const EXPIRY_CHOICES: { label: string; secs: number | null }[] = [
  { label: "until I revoke it", secs: null },
  { label: "1 day", secs: 86_400 },
  { label: "7 days", secs: 7 * 86_400 },
  { label: "30 days", secs: 30 * 86_400 },
];

/** A short summary of the project's standing permissions (nothing here changes them). */
export function grantSummary(p: ProjectView): string {
  const g = p.grant;
  if (!g) return "Default permissions";
  const s = g.status === "active" ? "" : ` · ${g.status}`;
  return `${g.fs === "workspace" ? "In-place commands" : "Copy only"} · ${g.net === "install" ? "installs online" : "offline"} · ${g.approval === "ask" ? "asks" : "automatic"}${s}`;
}

/**
 * The user's standing permissions for one project. Choosing and pressing Apply only SENDS the choice: the
 * native backend shows the exact consent text in its own dialog and nothing changes without a "yes" there.
 * The model cannot create, widen or renew a permission; this panel is the only Desktop path to one.
 */
function PermissionsEditor({ p }: { p: ProjectView }) {
  const { setProjectPermissions, endProjectPermissions, setupBusy, permissionSupport } = useNexus();
  const [open, setOpen] = useState(false);
  const g = p.grant;
  const [fs, setFs] = useState<string>(g?.fs ?? "scratch");
  const [net, setNet] = useState<string>(g?.net ?? "offline");
  const [approval, setApproval] = useState<string>(g?.approval ?? "auto");
  const [expiry, setExpiry] = useState<number>(0);
  const busy = setupBusy === "project";
  const inPlaceBlocked = p.workspaceMode === "direct";
  // what this installation can really do (asked of the runtime): never offer an "ask" nobody can answer
  const supportKnown = permissionSupport?.known === true && permissionSupport.standingGrants;
  const askOk = supportKnown && permissionSupport?.askAvailable === true;
  const askWhy = permissionSupport?.askReason ?? "this installation could not confirm that an approver is available";
  return (
    <div>
      <Badge tone={g && g.status !== "active" ? "warning" : g ? "purple" : "neutral"} title="What commands of this project's tasks may do">
        {grantSummary(p)}
      </Badge>{" "}
      <Button size="sm" variant="ghost" icon={<ShieldCheck size={13} />} aria-label={`Permissions for ${p.label}`} onClick={() => setOpen(!open)}>
        Permissions…
      </Button>
      {open && (
        <div className="nv-stack" style={{ gap: 6, marginTop: 6 }} role="group" aria-label={`Permissions for ${p.label}`}>
          <label className="nv-note">
            Commands{" "}
            <select className="nv-select nv-select--quiet" aria-label={`Command filesystem scope for ${p.label}`} value={fs} onChange={(e) => setFs(e.target.value)}>
              <option value="scratch">{FS_LABEL.scratch}</option>
              <option value="workspace" disabled={inPlaceBlocked}>{FS_LABEL.workspace}{inPlaceBlocked ? " (not available for direct editing yet)" : ""}</option>
            </select>
          </label>
          <label className="nv-note">
            Network{" "}
            <select className="nv-select nv-select--quiet" aria-label={`Network scope for ${p.label}`} value={net} onChange={(e) => setNet(e.target.value)}>
              <option value="offline">{NET_LABEL.offline}</option>
              <option value="install">{NET_LABEL.install}</option>
            </select>
          </label>
          <label className="nv-note">
            Approval{" "}
            <select className="nv-select nv-select--quiet" aria-label={`Approval behaviour for ${p.label}`} value={approval} onChange={(e) => setApproval(e.target.value)}>
              <option value="auto">{APPROVAL_LABEL.auto}</option>
              <option value="ask" disabled={!askOk}>{APPROVAL_LABEL.ask}{!askOk ? " (not available)" : ""}</option>
            </select>
          </label>
          {!askOk && (
            <p className="nv-note" role="note" aria-label={`Why Ask is unavailable for ${p.label}`}>
              “Ask me first” is not available: {supportKnown ? askWhy : (permissionSupport?.askReason ?? "the Nexus runtime could not be asked just now")}.
            </p>
          )}
          <label className="nv-note">
            Valid for{" "}
            <select className="nv-select nv-select--quiet" aria-label={`Lifetime of the permissions for ${p.label}`} value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
              {EXPIRY_CHOICES.map((c, i) => (
                <option key={c.label} value={i}>{c.label}</option>
              ))}
            </select>
          </label>
          <div>
            <Button size="sm" variant="primary" disabled={busy || !supportKnown || (approval === "ask" && !askOk)} onClick={() => void setProjectPermissions(p.projectId, { fs, net, approval, expiresInSecs: EXPIRY_CHOICES[expiry]?.secs ?? null })}>
              Apply…
            </Button>{" "}
            {g && g.status !== "revoked" && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void endProjectPermissions(p.projectId, false)}>
                Revoke
              </Button>
            )}{" "}
            {g && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void endProjectPermissions(p.projectId, true)}>
                Use defaults
              </Button>
            )}
          </div>
          {g && <p className="nv-note">Version {g.version}{g.expiresAtMs ? ` · expires ${new Date(g.expiresAtMs).toLocaleString()}` : ""}.</p>}
          <p className="nv-note">Widening applies to new tasks only; a running task never gains anything. Narrowing applies to a running task from its next operation. Revoking or removing stops it, including a command in progress.</p>
        </div>
      )}
    </div>
  );
}

function OpenedProjects() {
  const { projects, openProject, refreshProject, forgetProject, setProjectPolicy, setProjectEditMode, refreshProjects, setupBusy, setupError } = useNexus();
  const managed = projects.filter((p) => p.managed);
  return (
    <section aria-label="Your projects" className="nv-stack" style={{ gap: 10 }}>
      <div className="nv-heading__meta">
        <h1 className="nv-pagetitle">Projects</h1>
        <span className="nv-composer__spacer" />
        <Button onClick={() => void refreshProjects(true)} size="sm" icon={<RefreshCw size={13} />} aria-label="Check for changes">
          Check for changes
        </Button>
        <Button variant="primary" icon={<FolderOpen size={15} />} onClick={() => void openProject()} disabled={setupBusy === "project"}>
          {setupBusy === "project" ? "Opening…" : "Open project…"}
        </Button>
      </div>
      <p className="nv-note">
        Choose a folder with the system picker. Nexus reads it, keeps a private snapshot to work from, and never changes your folder; new tasks start from your current files.
      </p>
      {setupError && <Alert tone="warning" title="That did not finish">{setupError.message}</Alert>}
      {managed.length === 0 ? (
        <EmptyState icon={FolderGit2} title="No project open yet">
          Press “Open project…”, pick a software project folder, then describe a task on the Workspace page.
        </EmptyState>
      ) : (
        <table className="nv-table" aria-label="Opened projects">
          <thead>
            <tr>
              <th>Project</th>
              <th>Type</th>
              <th>Workspace</th>
              <th>Permissions</th>
              <th>Snapshot</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {managed.map((p) => (
              <tr key={p.projectId}>
                <td>
                  <span className="nv-mono">{p.label}</span>
                </td>
                <td>
                  {p.kinds.length === 0 ? <Badge tone="warning">not detected</Badge> : p.kinds.map((k) => (
                    <Badge key={k.id} tone={k.supported ? "purple" : "warning"} title={k.supported ? "Nexus can build and test this" : "Nexus can read and edit this but cannot run its builds yet"}>
                      {k.label}{k.supported ? "" : " · edit only"}
                    </Badge>
                  ))}
                </td>
                <td>
                  <label className="nv-note" title="Where Nexus makes changes for NEW tasks. Direct: the real files in your project folder, saved as each change is made (no patch to apply). Isolated: a throw-away copy; you review and apply its patch.">
                    <span className="nv-sr-only">Workspace for {p.label}</span>
                    <select
                      className="nv-select nv-select--quiet"
                      aria-label={`Workspace for ${p.label}`}
                      value={p.workspaceMode === "direct" ? "direct" : "isolated"}
                      onChange={(e) => void setProjectEditMode(p.projectId, e.target.value as WorkspaceMode)}
                      disabled={setupBusy === "project"}
                    >
                      <option value="direct">Edit my folder directly</option>
                      <option value="isolated">Isolated copy (review and apply)</option>
                    </select>
                  </label>
                  {p.workspaceMode === "direct" ? <Badge tone="warning" title="Changes are written to your real files">edits your files</Badge> : null}
                </td>
                <td>
                  <PermissionsEditor p={p} />
                </td>
                <td className="nv-note">
                  {new Date(p.snapshotAtMs).toLocaleString()}
                  {p.changedSinceSnapshot === true ? " · folder changed since (new tasks refresh automatically)" : ""}
                  {p.originDirty ? " · had uncommitted changes" : ""}
                </td>
                <td>
                  {p.grant ? (
                    <span className="nv-note" title="This project has standing permissions: they decide whether dependencies may be installed (their Network setting). The older per-project switch is not used while they exist.">
                      installs: {p.grant.status !== "active" ? "stopped (permissions " + p.grant.status + ")" : p.grant.net === "install" ? "allowed by Permissions" : "not allowed by Permissions"}
                    </span>
                  ) : (
                    <label className="nv-note" title="Lets Nexus download this project's dependencies (npm ci, pip install, ...) inside its sandbox. Everything else runs without network.">
                      <input type="checkbox" checked={p.installs === true} onChange={(e) => void setProjectPolicy(p.projectId, { installs: e.target.checked })} disabled={setupBusy === "project"} aria-label={`Allow dependency installs for ${p.label}`} /> installs
                    </label>
                  )}{" "}
                  {p.workspaceMode !== "direct" && (
                    <>
                  <label className="nv-note" title="Trusted workspace: when a task finishes and its checks pass, Nexus applies the change to your folder by itself (all-or-nothing, only if your folder did not change meanwhile). Nothing is committed or pushed.">
                        <input type="checkbox" checked={p.trusted === true} onChange={(e) => void setProjectPolicy(p.projectId, { trusted: e.target.checked })} disabled={setupBusy === "project"} aria-label={`Apply finished work to ${p.label} automatically`} /> apply automatically
                      </label>{" "}
                    </>
                  )}
                  <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} aria-label={`Refresh ${p.label}`} onClick={() => void refreshProject(p.projectId)} disabled={setupBusy === "project"}>
                    Refresh
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} aria-label={`Remove ${p.label}`} onClick={() => void forgetProject(p.projectId)} disabled={setupBusy === "project"}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function ProjectsPage() {
  const { intentCodeSources, intentWorkspaces, intentCodeLimits, runtimeState } = useNexus();
  if (runtimeState?.mode === "interactive") {
    return (
      <div className="nv-page nv-narrow">
        <OpenedProjects />
        <h2 className="nv-subheading">What applies to every task</h2>
        <ul className="nv-list" aria-label="Execution policy">
          <li>Each project has a workspace setting you choose: Nexus edits the real files in the project folder directly (every change is on disk as soon as it is made; it keeps the original of every file it changes), or works in an isolated copy that you review and apply. Nothing is ever committed, pushed or merged.</li>
          <li>Edits and build/test commands run automatically under a workspace policy (recorded as automated grants, never as your approval). Commands run in a sandbox with the network off.</li>
          <li>Protected files (lock files, build scripts, hidden and credential-shaped paths, version-control internals) cannot be written.</li>
          <li>Selected source text and command output are sent to your connected provider; each model turn is a billable request. You can revoke consent in Settings.</li>
        </ul>
      </div>
    );
  }
  const code = intentCodeSources ?? [];
  const inspect = intentWorkspaces ?? [];
  const ids = Array.from(new Set([...code.map((c) => c.sourceId), ...inspect.map((w) => w.workspaceId)]));
  return (
    <div className="nv-page nv-narrow">
      <h1 className="nv-pagetitle">Projects</h1>
      <p className="nv-note">
        Projects are registered by the operator on the Nexus broker, outside this app. Desktop shows what you are allowed to use and the restrictions that apply; it cannot add a project,
        type a path or change a restriction.
      </p>
      {ids.length === 0 ? (
        <EmptyState icon={FolderGit2} title="No project authorized">
          Ask the operator to register a project with <span className="nv-mono">nexus-broker --workspace ID=PATH</span> (Inspect) or <span className="nv-mono">--code-source ID=PATH</span> (Code in copy).
        </EmptyState>
      ) : (
        <table className="nv-table" aria-label="Authorized projects">
          <thead>
            <tr>
              <th>Project</th>
              <th>Modes</th>
              <th>Pinned commit</th>
              <th>Writes limited to</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const c = code.find((x) => x.sourceId === id);
              const i = inspect.some((w) => w.workspaceId === id);
              return (
                <tr key={id}>
                  <td className="nv-mono">{id}</td>
                  <td>
                    {i && <Badge tone="neutral">Inspect</Badge>} {c && <Badge tone="purple">Code in copy</Badge>}
                  </td>
                  <td className="nv-mono">{c ? (c.pinnedCommit ? c.pinnedCommit.slice(0, 12) : "not pinned") : "—"}</td>
                  <td className="nv-mono">{c ? (c.writeAllow && c.writeAllow.length > 0 ? c.writeAllow.join(", ") : "whole project (minus protected files)") : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <h2 className="nv-subheading">What applies to every coding task</h2>
      <ul className="nv-list" aria-label="Execution restrictions">
        <li>Work happens in an isolated copy of the project at one commit; your repository is never modified, and nothing is committed, pushed or merged.</li>
        <li>Every edit and every command needs its own independent approval in the separate approver; Desktop cannot approve.</li>
        <li>Commands are limited to a short allowlist (cargo check/test/build/fmt, npm test/run build, tsc --noEmit) and run in a sandbox with the network off.</li>
        <li>Protected files (lock files, build scripts, hidden and credential-shaped paths, version-control internals) cannot be written.</li>
        <li>
          {intentCodeLimits
            ? `Run limits: ${intentCodeLimits.maxTurns} model turns · ${intentCodeLimits.maxToolCalls} tool calls · ${intentCodeLimits.maxEdits} edits · ${intentCodeLimits.maxTests} commands · ${intentCodeLimits.maxOutputTokens} output tokens per call · ${Math.round(intentCodeLimits.maxToolResultBytes / 1024)} KiB of tool results · ${Math.round(intentCodeLimits.maxRuntimeSecs / 60)} min.`
            : "Run limits: not reported by the backend."}
        </li>
        <li>Selected source text and command output are sent to the model provider; each model turn is a billable request.</li>
      </ul>
    </div>
  );
}
