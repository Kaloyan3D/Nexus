import { useState } from "react";
import { FolderGit2, FolderOpen, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useNexus } from "../../state/NexusContext";
import type { ProjectView } from "../../lib/contracts";
import { Alert, Badge, Button, EmptyState } from "../../components/ui/primitives";
import { ProjectAccess } from "../access/ProjectAccess";
import { PreviewsPanel } from "../jobs/PreviewsPanel";
import { limitsLine } from "../../lib/limits";

/**
 * Read-only: the projects the operator has authorized. Registering a project (a path, a
 * commit pin, a write scope, a credential) is an operator action on the broker, never
 * something the Desktop can do or request.
 */

const FS_LABEL: Record<string, string> = {
  scratch: "Commands work on a throw-away copy",
  workspace: "Commands change the task's working copy",
  full: "FULL ACCESS: commands run as me, unsandboxed, anywhere I can reach",
};
const NET_LABEL: Record<string, string> = { offline: "No network", controlled: "Only the internet destinations I list", install: "Network for dependency installs", full: "FULL NETWORK: my machine's network, no destination checks" };
const PRESET_CHOICES = ["npm", "pnpm", "yarn", "cargo", "pip", "github", "gitlab", "go"];

/** `host` or `host:443,8443` lines (comma/space/newline separated) -> entries for the consent dialog; the broker validates every one. */
export function parseHosts(text: string): string[] {
  return text.split(/[\s;]+/).map((s) => s.trim()).filter(Boolean);
}
export function parsePorts(text: string): number[] {
  return text.split(/[\s,;]+/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
}
const APPROVAL_LABEL: Record<string, string> = { auto: "Runs without asking (inside these permissions)", ask: "Asks me first — answered in a separate terminal program (advanced)" };
const EXPIRY_CHOICES: { label: string; secs: number | null }[] = [
  { label: "until I revoke it", secs: null },
  { label: "1 day", secs: 86_400 },
  { label: "7 days", secs: 7 * 86_400 },
  { label: "30 days", secs: 30 * 86_400 },
];

/** The destinations of a Controlled Internet grant, for a badge: where commands may connect (not what they may send). */
export function destinationSummary(g: NonNullable<ProjectView["grant"]>): string {
  const hosts = g.netPolicy?.hosts.map((h) => h.host) ?? [];
  const local = g.netPolicy?.local_ports ?? [];
  const shown = hosts.slice(0, 3).join(", ") + (hosts.length > 3 ? ` +${hosts.length - 3}` : "");
  return [shown, local.length ? `local ${local.join("/")}` : ""].filter(Boolean).join(" · ") || "none";
}

/** A short summary of the project's standing permissions (nothing here changes them). */
export function grantSummary(p: ProjectView): string {
  const g = p.grant;
  if (!g) return "Default permissions";
  const s = g.status === "active" ? "" : ` · ${g.status}`;
  if (g.fs === "full") return `FULL ACCESS (unsandboxed, runs as you) · full network · ${g.approval === "ask" ? "asks" : "automatic"}${s}`;
  return `${g.fs === "workspace" ? "In-place commands" : "Copy only"} · ${g.net === "install" ? "installs online" : g.net === "controlled" ? `internet: ${destinationSummary(g)}` : "offline"} · ${g.approval === "ask" ? "asks" : "automatic"}${s}`;
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
  const [presets, setPresets] = useState<string[]>([]);
  const [hostsText, setHostsText] = useState<string>(g?.netPolicy?.hosts.map((h) => `${h.host}:${h.ports.join(",")}`).join(" ") ?? "");
  const [portsText, setPortsText] = useState<string>((g?.netPolicy?.local_ports ?? []).join(" "));
  const [expiry, setExpiry] = useState<number>(0);
  const busy = setupBusy === "project";
  // In-place commands need Landlock and the launch gate on this machine (asked of the runtime). For a project that
  // edits its real folder they change YOUR files, which the consent dialog says in so many words.
  const inPlaceBlocked = permissionSupport?.known === true && permissionSupport.inPlaceAvailable === false;
  const inPlaceWhy = permissionSupport?.inPlaceReason ?? "this machine cannot confine them";
  const direct = p.workspaceMode === "direct";
  // Controlled Internet needs the network gatekeeper on this machine and commands that run in place
  const fullBlocked = !direct || (permissionSupport?.known === true && permissionSupport.hostExecAvailable !== true);
  const fullWhy = !direct ? "needs a Direct workspace project" : (permissionSupport?.hostExecReason ?? "the host backend is not enabled on this installation");
  const controlledBlocked = permissionSupport?.known === true && permissionSupport.controlledAvailable === false;
  const controlledWhy = permissionSupport?.controlledReason ?? "this machine cannot run the network gatekeeper";
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
            <select className="nv-select nv-select--quiet" aria-label={`Command filesystem scope for ${p.label}`} value={fs} onChange={(e) => { setFs(e.target.value); if (e.target.value === "full") setNet("full"); else if (net === "full") setNet("offline"); }}>
              <option value="scratch">{FS_LABEL.scratch}</option>
              <option value="workspace" disabled={inPlaceBlocked}>{direct ? "Commands change my real project files directly" : FS_LABEL.workspace}{inPlaceBlocked ? ` (not available: ${inPlaceWhy})` : ""}</option>
              <option value="full" disabled={fullBlocked}>{FS_LABEL.full}{fullBlocked ? ` (not available: ${fullWhy})` : ""}</option>
            </select>
          </label>
          {fs === "full" && (
            <Alert tone="error" title="Full Access is not the confined workspace">
              Commands run as you, with no sandbox: they can read, change or delete anything you can — other projects, keys, system files you can write — and use your network without destination checks. Nexus observes changes inside this project only and cannot undo effects outside it. The confined Workspace stays the recommended mode.
            </Alert>
          )}
          <label className="nv-note">
            Network{" "}
            <select className="nv-select nv-select--quiet" aria-label={`Network scope for ${p.label}`} value={net} onChange={(e) => setNet(e.target.value)}>
              <option value="offline">{NET_LABEL.offline}</option>
              <option value="controlled" disabled={controlledBlocked || fs !== "workspace"}>{NET_LABEL.controlled}{controlledBlocked ? ` (not available: ${controlledWhy})` : fs !== "workspace" ? " (needs commands that change the project in place)" : ""}</option>
              <option value="install">{NET_LABEL.install}</option>
              <option value="full" disabled={fs !== "full"}>{NET_LABEL.full}{fs !== "full" ? " (only with Full Access commands)" : ""}</option>
            </select>
          </label>
          {net === "controlled" && (
            <fieldset className="nv-stack" style={{ gap: 4, border: "none", padding: 0 }} aria-label={`Allowed internet destinations for ${p.label}`}>
              <span className="nv-note">Commands may connect only to these destinations. This limits WHERE they connect, not WHAT they send: anything a command can read can be sent to a destination you allow.</span>
              <span className="nv-note">
                {PRESET_CHOICES.map((n) => (
                  <label key={n} style={{ marginRight: 8 }}>
                    <input type="checkbox" checked={presets.includes(n)} onChange={(e) => setPresets(e.target.checked ? [...presets, n] : presets.filter((x) => x !== n))} aria-label={`Allow the ${n} preset for ${p.label}`} /> {n}
                  </label>
                ))}
              </span>
              <label className="nv-note">
                Hosts{" "}
                <input className="nv-input" value={hostsText} onChange={(e) => setHostsText(e.target.value)} placeholder="registry.example.org:443 *.cdn.example.org" aria-label={`Allowed hosts for ${p.label}`} />
              </label>
              <label className="nv-note">
                Ports of services on this computer{" "}
                <input className="nv-input" value={portsText} onChange={(e) => setPortsText(e.target.value)} placeholder="5432 8080" aria-label={`Allowed local ports for ${p.label}`} />
              </label>
            </fieldset>
          )}
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
            <Button size="sm" variant="primary" disabled={busy || !supportKnown || (approval === "ask" && !askOk)} onClick={() => void setProjectPermissions(p.projectId, { fs, net, approval, expiresInSecs: EXPIRY_CHOICES[expiry]?.secs ?? null, ...(net === "controlled" ? { netPresets: presets, allowHosts: parseHosts(hostsText), allowLocalPorts: parsePorts(portsText) } : {}) })}>
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

function ProjectKinds({ p }: { p: ProjectView }) {
  if (p.kinds.length === 0) return <Badge tone="warning" title="Nexus could not tell what kind of project this is">type not detected</Badge>;
  return (
    <>
      {p.kinds.map((k) => (
        <Badge key={k.id} tone={k.supported ? "purple" : "warning"} title={k.supported ? "Nexus can build and test this" : "Nexus can read and edit this but cannot run its builds yet"}>
          {k.label}
          {k.supported ? "" : " · edit only"}
        </Badge>
      ))}
    </>
  );
}

/** Everything granular, behind one disclosure: the plain choices above are enough for ordinary use. */
function AdvancedSettings({ p }: { p: ProjectView }) {
  const { setProjectPolicy, setupBusy } = useNexus();
  return (
    <details className="nv-details nv-project__advanced" aria-label={`Advanced settings for ${p.label}`}>
      <summary>Advanced permissions</summary>
      <div className="nv-stack" style={{ gap: 10, marginTop: 8 }}>
        <PermissionsEditor p={p} />
        {p.workspaceMode !== "direct" && (
          <label className="nv-note" title="When a task finishes and its checks pass, Nexus applies the change to your folder by itself (all-or-nothing, only if your folder did not change meanwhile). Nothing is committed or pushed.">
            <input type="checkbox" checked={p.trusted === true} onChange={(e) => void setProjectPolicy(p.projectId, { trusted: e.target.checked })} disabled={setupBusy === "project"} aria-label={`Apply finished work to ${p.label} automatically`} /> Apply finished, checked work to my folder automatically
          </label>
        )}
      </div>
    </details>
  );
}

function OpenedProjects() {
  const { projects, openProject, refreshProject, forgetProject, refreshProjects, setupBusy, setupError } = useNexus();
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
      <p className="nv-note">Choose a folder with the system picker. Nexus works only in the folders you open, and only in the ways you allow below. Permissions of one project never apply to another.</p>
      {setupError && <Alert tone="warning" title="That did not finish">{setupError.message}</Alert>}
      {managed.length === 0 ? (
        <EmptyState icon={FolderGit2} title="No project open yet">
          Press “Open project…”, pick a software project folder, then describe a task on the Workspace page.
        </EmptyState>
      ) : (
        <div aria-label="Opened projects" role="region" className="nv-projects">
          {managed.map((p) => (
            <article key={p.projectId} className="nv-project" aria-label={`Project ${p.label}`}>
              <header className="nv-project__head">
                <h2 className="nv-project__name">{p.label}</h2>
                <ProjectKinds p={p} />
                <span className="nv-composer__spacer" />
                <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} aria-label={`Refresh ${p.label}`} onClick={() => void refreshProject(p.projectId)} disabled={setupBusy === "project"}>
                  Refresh
                </Button>
                <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} aria-label={`Remove ${p.label}`} onClick={() => void forgetProject(p.projectId)} disabled={setupBusy === "project"}>
                  Remove
                </Button>
              </header>
              <p className="nv-note nv-project__snap">
                Snapshot {new Date(p.snapshotAtMs).toLocaleString()}
                {p.changedSinceSnapshot === true ? " · folder changed since (new tasks refresh automatically)" : ""}
                {p.originDirty ? " · had uncommitted changes" : ""}
              </p>
              <ProjectAccess p={p} />
              <PreviewsPanel projectId={p.projectId} heading="Running now" />
              <AdvancedSettings p={p} />
            </article>
          ))}
        </div>
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
        <h2 className="nv-subheading">How Nexus keeps you in control</h2>
        <ul className="nv-list" aria-label="Safety summary">
          <li>Nexus changes nothing without your permission: each project starts with the safest settings, and every widening is confirmed in a system dialog that shows exactly what changes. Nexus itself cannot grant, widen or renew a permission.</li>
          <li>Commands run in a sandbox. The network is off unless you allow dependency downloads (install commands only) or list specific sites; a preview can be reached from this computer only.</li>
          <li>Protected files (lock files, build scripts, hidden and credential-shaped paths, version-control internals) cannot be written. Nothing is ever committed, pushed or merged for you.</li>
          <li>Selected source text and command output are sent to your connected provider; each model turn is a billable request. You can revoke autonomous work in Settings.</li>
          <li>“Done” always comes from what actually ran: results marked verified come from recorded command results, never from what the model says about itself.</li>
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
          {intentCodeLimits ? limitsLine(intentCodeLimits) : "Run settings: not reported by the backend."}
        </li>
        <li>Selected source text and command output are sent to the model provider; each model turn is a billable request.</li>
      </ul>
    </div>
  );
}
