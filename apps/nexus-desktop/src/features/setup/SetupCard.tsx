import { Check, Circle, Loader2 } from "lucide-react";
import { useNexus } from "../../state/NexusContext";
import { Alert, Button } from "../../components/ui/primitives";

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

/**
 * First-run setup for the interactive profile: start the native runtime, connect the
 * provider once, give consent once. Every privileged act happens in a NATIVE dialog
 * the backend opens; these buttons only ask for it.
 */
export function SetupCard() {
  const { runtimeState: rt, setupBusy, setupError, connectProvider, giveConsent, retryRuntime } = useNexus();
  if (!rt || rt.mode !== "interactive") return null;
  const ready = rt.phase === "ready";
  const connected = rt.providerConnected;
  const consented = rt.consent.given;
  const connecting = setupBusy === "connect";
  return (
    <section className="nv-setup" aria-label="Set up Nexus">
      <h1 className="nv-hero">Set up Nexus</h1>
      <p className="nv-note">You do this once. After that: open a project, describe a task, press Run.</p>
      <ol className="nv-setup__steps">
        <Step state={ready ? "done" : rt.phase === "error" ? "todo" : "active"} title={ready ? "Nexus is running on this computer" : rt.phase === "error" ? "Nexus could not start" : "Starting Nexus…"}>
          {rt.phase === "error" && (
            <div className="nv-setup__act">
              <Alert tone="error" title="Startup failed">
                {rt.message ?? "The runtime did not start."}
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
              <p className="nv-note">Your API key is typed into a system dialog and stored privately on this computer. Nexus then checks the connection with a few small requests.</p>
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
                Nexus will read your project, edit files and run build/test commands in an isolated copy without asking for each step. Your original folder is never changed. You confirm once, in a system dialog.
              </p>
              <Button onClick={() => void giveConsent()} disabled={setupBusy === "consent"}>
                Review and allow…
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
