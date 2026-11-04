import { ShieldQuestion } from "lucide-react";
import { useState } from "react";
import { accessOf, needsOf, type Need } from "../../lib/access";
import type { IntentRun, ProjectView } from "../../lib/contracts";
import { Button } from "../../components/ui/primitives";
import { useNexus } from "../../state/NexusContext";
import { humanAccessError } from "./ProjectAccess";

function copy(n: Need, ports: string): { title: string; body: string; allow: string; again: string } {
  switch (n.kind) {
    case "preview-port":
      return {
        title: `Nexus wants to show your site on port ${ports}`,
        body: `It tried to start “${n.command.split(" · ")[0]}” as a preview, but previews are not allowed on ${n.ports.length === 1 ? "that port" : "those ports"} for this project. Allowing lets a server run there and be shown on this computer only, until you stop it or revoke this.`,
        allow: `Allow previews on ${ports}…`,
        again: `Previews are now allowed on ${ports}. Please start the preview again.`,
      };
    case "work":
      return {
        title: "Nexus needs to run commands in your project folder",
        body: `${n.why} Commands still run in a sandbox, offline, and only inside the project folder.`,
        allow: "Allow Nexus to run commands here…",
        again: "I allowed Nexus to run commands in the project folder. Please continue.",
      };
    case "installs":
      return {
        title: "Nexus could not download your project's dependencies",
        body: `It ran “${n.command}”, but downloads are off for this project. Allowing lets install commands (and only those) reach package registries.`,
        allow: "Allow dependency downloads…",
        again: "Dependency downloads are now allowed. Please run the install again.",
      };
  }
}

/**
 * What a run asked for and was not allowed, each as ONE scoped request the person can accept at the moment
 * it matters. Accepting opens the native confirmation with the broker's exact text; the model never sees,
 * triggers or answers it. Permissions apply to NEW runs (a run keeps the ones it started with), so while a
 * run is live the cards say so, and afterwards one click can allow and tell Nexus to carry on.
 */
export function RunNeeds({ run, project, threadId, live }: { run: IntentRun; project: ProjectView | undefined; threadId: string; live: boolean }) {
  const { allowProjectWork, allowProjectPreviews, allowProjectInstalls, sendThread, threadSending, accessBusy, accessError, clearAccessError } = useNexus();
  const [done, setDone] = useState<string | null>(null);
  const needs = needsOf(run, project);
  if (!project || (needs.length === 0 && !done)) return null;
  const a = accessOf(project);
  const apply = async (n: Need): Promise<boolean> => {
    if (n.kind === "work") return allowProjectWork(project.projectId);
    if (n.kind === "installs") return allowProjectInstalls(project.projectId, true);
    // a preview needs the project folder first
    if (!a.previewsPossible && !(await allowProjectWork(project.projectId))) return false;
    return allowProjectPreviews(project.projectId, n.ports);
  };
  const act = async (n: Need, andContinue: boolean, text: string) => {
    clearAccessError();
    if (!(await apply(n))) return;
    if (andContinue) {
      const r = await sendThread({ threadId, projectId: project.projectId, content: text, mode: "auto" });
      setDone(r ? "Allowed. Nexus is carrying on." : "Allowed. Send a message to carry on.");
    } else setDone("Allowed. This applies from your next message.");
  };
  return (
    <section className="nv-needs" aria-label="Permission requests">
      {needs.map((n) => {
        const ports = n.kind === "preview-port" ? n.ports.join(", ") : "";
        const c = copy(n, ports);
        const busy = accessBusy !== null || threadSending;
        return (
          <div key={`${n.kind}:${ports}`} className="nv-needs__card" role="group" aria-label={c.title}>
            <div className="nv-needs__head">
              <ShieldQuestion size={16} aria-hidden="true" /> <strong>{c.title}</strong>
            </div>
            <p className="nv-note">{c.body}</p>
            <p className="nv-note">
              {live
                ? "This run keeps the permissions it started with; what you allow applies from your next message."
                : "You will be asked to confirm in a system dialog that shows exactly what changes."}
            </p>
            <div className="nv-needs__act">
              {!live && (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(n, true, c.again)} aria-label={`${c.allow.replace("…", "")} and continue`}>
                  Allow and continue…
                </Button>
              )}
              <Button size="sm" disabled={busy} onClick={() => void act(n, false, c.again)} aria-label={c.allow.replace("…", "")}>
                {live ? c.allow : "Allow only…"}
              </Button>
            </div>
          </div>
        );
      })}
      {accessError && (
        <p className="nv-note" role="alert">
          Nothing changed: {humanAccessError(accessError.message)}
        </p>
      )}
      {done && (
        <p className="nv-note" role="status">
          {done}
        </p>
      )}
    </section>
  );
}
