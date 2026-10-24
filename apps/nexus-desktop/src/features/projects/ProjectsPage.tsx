import { FolderGit2, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { useNexus } from "../../state/NexusContext";
import type { WorkspaceMode } from "../../lib/contracts";
import { Alert, Badge, Button, EmptyState } from "../../components/ui/primitives";

/**
 * Read-only: the projects the operator has authorized. Registering a project (a path, a
 * commit pin, a write scope, a credential) is an operator action on the broker, never
 * something the Desktop can do or request.
 */
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
                <td className="nv-note">
                  {new Date(p.snapshotAtMs).toLocaleString()}
                  {p.changedSinceSnapshot === true ? " · folder changed since (new tasks refresh automatically)" : ""}
                  {p.originDirty ? " · had uncommitted changes" : ""}
                </td>
                <td>
                  <label className="nv-note" title="Lets Nexus download this project's dependencies (npm ci, pip install, ...) inside its sandbox. Everything else runs without network.">
                    <input type="checkbox" checked={p.installs === true} onChange={(e) => void setProjectPolicy(p.projectId, { installs: e.target.checked })} disabled={setupBusy === "project"} aria-label={`Allow dependency installs for ${p.label}`} /> installs
                  </label>{" "}
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
