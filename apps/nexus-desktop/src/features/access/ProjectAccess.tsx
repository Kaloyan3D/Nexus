import { useState } from "react";
import { COMMON_PREVIEW_PORTS, MIN_PREVIEW_PORT, accessOf, accessSentence, parsePreviewPorts } from "../../lib/access";
import type { ProjectView } from "../../lib/contracts";
import { Alert, Badge, Button } from "../../components/ui/primitives";
import { useNexus } from "../../state/NexusContext";

function Row({ title, state, tone, children, action }: { title: string; state: string; tone: "success" | "warning" | "neutral"; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <li className="nv-access__row">
      <div className="nv-access__main">
        <div className="nv-access__title">
          {title} <Badge tone={tone}>{state}</Badge>
        </div>
        <p className="nv-note nv-access__why">{children}</p>
      </div>
      <div className="nv-access__act">{action}</div>
    </li>
  );
}

/** "Allow local previews": pick from the usual development ports or type your own. Nothing is allowed until the native dialog is confirmed. */
function PreviewPorts({ p, onDone }: { p: ProjectView; onDone: () => void }) {
  const { allowProjectPreviews, accessBusy } = useNexus();
  const have = accessOf(p).previewPorts;
  const [picked, setPicked] = useState<number[]>([]);
  const [custom, setCustom] = useState("");
  const parsed = parsePreviewPorts(custom);
  const ports = Array.from(new Set([...picked, ...parsed.ports]));
  const busy = accessBusy === `previews:${p.projectId}`;
  return (
    <div className="nv-access__ports" role="group" aria-label={`Preview ports for ${p.label}`}>
      <p className="nv-note">Pick the ports your site is likely to use. Nexus can then show a server on only these ports, and only on this computer.</p>
      <div className="nv-access__choices">
        {COMMON_PREVIEW_PORTS.filter((n) => !have.includes(n)).map((n) => (
          <label key={n} className="nv-note">
            <input type="checkbox" checked={picked.includes(n)} onChange={(e) => setPicked(e.target.checked ? [...picked, n] : picked.filter((x) => x !== n))} aria-label={`Allow previews on port ${n}`} /> {n}
          </label>
        ))}
        <label className="nv-note">
          Other{" "}
          <input className="nv-input nv-access__custom" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. 5000" aria-label="Another preview port" />
        </label>
      </div>
      {parsed.invalid.length > 0 && (
        <p className="nv-note" role="alert">
          Not a usable port: {parsed.invalid.join(", ")}. Development servers use ports {MIN_PREVIEW_PORT} to 65535.
        </p>
      )}
      <div>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || ports.length === 0 || parsed.invalid.length > 0 || ports.length > 8}
          onClick={() => void allowProjectPreviews(p.projectId, ports).then((ok) => ok && onDone())}
        >
          Review and allow…
        </Button>{" "}
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * What Nexus may do in one project, as four plain choices. Each button only ASKS: the native backend shows
 * the broker's exact consent text in a system dialog, and nothing changes without a "yes" there. Granular
 * network destinations, expiry and Full Access live under Advanced permissions on the Projects page.
 */
export function ProjectAccess({ p, onAdvanced }: { p: ProjectView; onAdvanced?: () => void }) {
  const { allowProjectWork, allowProjectInstalls, revokeProjectPreviews, switchToAutomaticApproval, setProjectEditMode, permissionSupport, accessBusy, accessError, clearAccessError } = useNexus();
  const [choosingPorts, setChoosingPorts] = useState(false);
  const a = accessOf(p);
  const id = p.projectId;
  const idle = accessBusy === null;
  const inPlaceBlocked = permissionSupport?.known === true && permissionSupport.inPlaceAvailable === false;
  const inPlaceWhy = permissionSupport?.inPlaceReason ?? "this computer cannot confine them";
  const fullAccess = a.commands === "full";
  const needsWork = !a.previewsPossible;
  return (
    <div className="nv-access" role="group" aria-label={`What Nexus may do in ${p.label}`}>
      <p className="nv-note nv-access__summary">{accessSentence(a)}</p>
      {a.ended && (
        <Alert tone="warning" title={`This project's permissions were ${a.ended}`}>
          Nexus is using the safe defaults. Allow what you need again below.
        </Alert>
      )}
      {a.asksFirst && (
        <Alert tone="warning" title="This project asks before every action — that is not available in this release">
          Answering each request needs a separate terminal program, which this release does not use, so tasks here would wait for an answer nobody can give.{" "}
          <Button size="sm" variant="primary" disabled={!idle} onClick={() => void switchToAutomaticApproval(id)} aria-label={`Switch ${p.label} to automatic approval`}>
            Switch to automatic…
          </Button>{" "}
          Everything stays inside the permissions below; you confirm the change in a system dialog.
        </Alert>
      )}
      {fullAccess && (
        <Alert tone="warning" title="This project has Full Access">
          Commands run as you with no sandbox. Reduce this under Advanced permissions if you did not mean it.
        </Alert>
      )}
      <ul className="nv-access__list">
        <Row
          title="Edit files"
          state={a.editsDirectly ? "in your folder" : "on a copy"}
          tone={a.editsDirectly ? "success" : "neutral"}
          action={
            <Button size="sm" disabled={!idle} onClick={() => void setProjectEditMode(id, a.editsDirectly ? "isolated" : "direct")} aria-label={a.editsDirectly ? `Work on a copy of ${p.label} instead` : `Let Nexus edit ${p.label} directly`}>
              {a.editsDirectly ? "Use a copy instead" : "Edit my folder…"}
            </Button>
          }
        >
          {a.editsDirectly
            ? "Each change is saved in your project folder as it is made. Nexus keeps the original of every file it changes (30 days) and never touches secrets or .git. You can restore its changes from a run's details; files you changed since are left alone."
            : "Nexus changes a throw-away copy. You review the changes and apply them to your folder yourself."}
        </Row>
        <Row
          title="Run commands"
          state={a.commands === "project" ? "in the project" : a.commands === "full" ? "full access" : "temporary copy"}
          tone={a.commands === "project" ? "success" : a.commands === "full" ? "warning" : "neutral"}
          action={
            needsWork && !fullAccess ? (
              <Button size="sm" variant="primary" disabled={!idle || inPlaceBlocked} onClick={() => void allowProjectWork(id)} aria-label={`Allow Nexus to edit and run commands in ${p.label}`}>
                Allow…
              </Button>
            ) : null
          }
        >
          {inPlaceBlocked
            ? `Not available on this computer: ${inPlaceWhy}. Tests and builds still run, in a temporary copy.`
            : a.commands === "project"
              ? "Tests, builds, installs and servers run inside the project folder, in a sandbox."
              : "Tests and builds run in a temporary copy, so files they create (dependencies, build output) are not kept and servers cannot be shown. Allow this to build and preview a project."}
        </Row>
        <Row
          title="Download dependencies"
          state={a.downloads === "off" ? "off" : a.downloads === "dependencies" ? "on" : a.downloads === "listed" ? "listed sites" : "any site"}
          tone={a.downloads === "dependencies" ? "success" : a.downloads === "off" ? "neutral" : "warning"}
          action={
            a.downloads === "off" || a.downloads === "dependencies" ? (
              <Button
                size="sm"
                disabled={!idle}
                onClick={() => void allowProjectInstalls(id, a.downloads === "off")}
                aria-label={a.downloads === "off" ? `Allow dependency downloads for ${p.label}` : `Turn off dependency downloads for ${p.label}`}
              >
                {a.downloads === "off" ? "Allow…" : "Turn off"}
              </Button>
            ) : null
          }
        >
          {a.downloads === "off"
            ? "Install commands such as npm install cannot reach the internet. Turn this on so Nexus can fetch your project's dependencies; nothing else gets network access."
            : a.downloads === "dependencies"
              ? "Only install commands may reach the internet (package registries). Everything else stays offline."
              : "A specific list of sites is set under Advanced permissions."}
        </Row>
        <Row
          title="Local previews"
          state={a.previewPorts.length > 0 ? `port${a.previewPorts.length === 1 ? "" : "s"} ${a.previewPorts.join(", ")}` : "off"}
          tone={a.previewPorts.length > 0 ? "success" : "neutral"}
          action={
            <>
              {a.previewsPossible && !choosingPorts && (
                <Button size="sm" disabled={!idle} onClick={() => setChoosingPorts(true)} aria-label={`Allow local previews for ${p.label}`}>
                  {a.previewPorts.length > 0 ? "Add ports…" : "Allow…"}
                </Button>
              )}
              {a.previewPorts.length > 0 && (
                <Button size="sm" variant="ghost" disabled={!idle} onClick={() => void revokeProjectPreviews(id)} aria-label={`Stop allowing previews for ${p.label}`}>
                  Stop allowing
                </Button>
              )}
            </>
          }
        >
          {a.previewsPossible
            ? "Lets Nexus start your site's development server and show it on this computer only. A server stops when you stop it or revoke this."
            : "Needs Nexus to run commands in the project folder first. When you ask for a website, Nexus will ask for the port it needs."}
        </Row>
      </ul>
      {choosingPorts && <PreviewPorts p={p} onDone={() => setChoosingPorts(false)} />}
      {accessError && (
        <Alert tone="warning" title="That did not change anything">
          {humanAccessError(accessError.message)}{" "}
          <button type="button" className="nv-linkbtn" onClick={clearAccessError}>
            Dismiss
          </button>
        </Alert>
      )}
      {onAdvanced && (
        <p className="nv-note">
          <button type="button" className="nv-linkbtn" onClick={onAdvanced}>
            Advanced permissions…
          </button>{" "}
          for network destinations, how long permissions last, and Full Access.
        </p>
      )}
    </div>
  );
}

/** The native layer prefixes a machine-readable reason ("no-grant: …"); a person reads only the sentence. */
export function humanAccessError(message: string): string {
  return message.replace(/^(?:no-grant|not-available|ended|changed|refused|bad-request):\s*/, "");
}
