import { Check, Circle, Loader2 } from "lucide-react";
import { useNexus } from "../../state/NexusContext";
import { Alert, Button } from "../../components/ui/primitives";
import { EnvironmentNotes } from "./EnvironmentNotes";

type StepState = "done" | "active" | "todo";

function Step({ state, title, children }: { state: StepState; title: string; children?: React.ReactNode }) {
  return (
    <li className="nv-setup__step" data-state={state}>
      <span className="nv-setup__mark" aria-hidden="true">
        {state === "done" ? <Check size={14} /> : state === "active" ? <Loader2 size={14} className="nv-spin" /> : <Circle size={12} />}
      </span>
      <div className="nv-setup__body">
        <div className="nv-setup__title">{title}</div>
        {children}
      </div>
    </li>
  );
}

/** A project Nexus can work on: one the person opened, or one the broker offers for coding. */
export function useHasProject(): boolean {
  const { projects, intentCodeSources } = useNexus();
  return projects.some((p) => p.managed) || (intentCodeSources?.length ?? 0) > 0;
}

/** Is everything before the first task in place? Used by the Workspace page to decide between setup and the composer. */
export function setupComplete(
  rt: ReturnType<typeof useNexus>["runtimeState"],
  engine: ReturnType<typeof useNexus>["engineChoice"],
  hasProject: boolean,
): boolean {
  if (!rt || rt.mode !== "interactive") return true;
  const adaptiveReady = !engine || engine.preferred !== "adaptive" || engine.adaptiveAvailable;
  return rt.phase === "ready" && rt.providerConnected && rt.consent.given && adaptiveReady && hasProject;
}

/**
 * First-run setup for the interactive profile: start the native runtime, connect the provider once, give
 * consent once, prepare the engine, open a project. Every privileged act happens in a NATIVE dialog the
 * backend opens; these buttons only ask for it. Nothing here needs a terminal.
 */
export function SetupCard() {
  const { runtimeState: rt, setupBusy, setupError, connectProvider, giveConsent, retryRuntime, engineChoice, setupAdaptive, adaptiveBusy, adaptiveError, openProject } = useNexus();
  const hasProject = useHasProject();
  if (!rt || rt.mode !== "interactive") return null;
  const ready = rt.phase === "ready";
  const connected = rt.providerConnected;
  const consented = rt.consent.given;
  const connecting = setupBusy === "connect";
  const needsEngine = engineChoice !== null && engineChoice.preferred === "adaptive" && !engineChoice.adaptiveAvailable;
  const engineDone = consented && !needsEngine;
  return (
    <section className="nv-setup" aria-label="Set up Nexus">
      <h1 className="nv-hero">Set up Nexus</h1>
      <p className="nv-note">You do this once. After that: open a project, describe what to build or fix, and watch it happen.</p>
      <EnvironmentNotes />
      <ol className="nv-setup__steps">
        <Step state={ready ? "done" : rt.phase === "error" ? "todo" : "active"} title={ready ? "Nexus is running on this computer" : rt.phase === "error" ? "Nexus could not start" : "Starting Nexus…"}>
          {rt.phase === "error" && (
            <div className="nv-setup__act">
              <Alert tone="error" title="Startup failed">
                {rt.message ?? "The runtime did not start."} If this keeps happening, reinstall Nexus or move its data folder{rt.home ? ` (${rt.home})` : ""} aside and start again; your projects are not stored there.
              </Alert>
              <Button onClick={() => void retryRuntime()} disabled={setupBusy === "start"}>
                Try again
              </Button>
            </div>
          )}
        </Step>
        <Step state={!ready ? "todo" : connected ? "done" : "active"} title={connected ? "OpenCode Go is connected" : "Connect OpenCode Go"}>
          {ready && !connected && (
            <div className="nv-setup__act">
              <p className="nv-note">Nexus works with OpenCode Go. Your API key is typed into a system dialog and stored privately on this computer; it never passes through this window. Nexus then checks the connection with a few small requests.</p>
              <Button onClick={() => void connectProvider()} disabled={connecting}>
                {connecting ? "Waiting for the system dialog / verifying…" : "Connect…"}
              </Button>
            </div>
          )}
        </Step>
        <Step state={!connected ? "todo" : consented ? "done" : "active"} title={consented ? "Autonomous work is allowed" : "Allow autonomous work"}>
          {connected && !consented && (
            <div className="nv-setup__act">
              <p className="nv-note">
                Nexus will read your project, edit files and run build/test commands without asking for each step, inside the permissions you set for each project. Nothing is ever committed, pushed or deployed. You confirm once, in a system dialog.
              </p>
              <Button onClick={() => void giveConsent()} disabled={setupBusy === "consent"}>
                Review and allow…
              </Button>
            </div>
          )}
        </Step>
        <Step state={!consented ? "todo" : engineDone ? "done" : "active"} title={engineDone ? `Nexus Adaptive is ready${engineChoice?.adaptiveModel ? ` (${engineChoice.adaptiveModel})` : ""}` : "Prepare Nexus Adaptive"}>
          {consented && needsEngine && (
            <div className="nv-setup__act">
              <p className="nv-note">
                Nexus Adaptive is the engine that does your tasks. It needs a one-time check with your provider: eight small requests that count against your OpenCode Go plan. {engineChoice?.adaptiveReason ?? ""}
              </p>
              <Button onClick={() => void setupAdaptive()} disabled={adaptiveBusy} icon={adaptiveBusy ? <Loader2 size={14} className="nv-spin" /> : undefined}>
                {adaptiveBusy ? "Checking with the provider…" : "Set up Nexus Adaptive…"}
              </Button>
              {adaptiveError && (
                <Alert tone="warning" title="That check did not finish">
                  {adaptiveError.message}
                </Alert>
              )}
            </div>
          )}
        </Step>
        <Step state={!engineDone ? "todo" : hasProject ? "done" : "active"} title={hasProject ? "A project is open" : "Open your project"}>
          {engineDone && !hasProject && (
            <div className="nv-setup__act">
              <p className="nv-note">Pick the folder of a project, or an empty folder for something new. Nexus only works in folders you open, and asks before it can change anything outside the safe defaults.</p>
              <Button variant="primary" onClick={() => void openProject()} disabled={setupBusy === "project"}>
                {setupBusy === "project" ? "Opening…" : "Open project…"}
              </Button>
            </div>
          )}
        </Step>
      </ol>
      {setupError && (
        <Alert tone="warning" title="That did not finish">
          {setupError.message}
        </Alert>
      )}
    </section>
  );
}
