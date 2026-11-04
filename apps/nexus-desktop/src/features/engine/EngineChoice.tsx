import { Loader2 } from "lucide-react";
import { Alert, Button } from "../../components/ui/primitives";
import { useNexus } from "../../state/NexusContext";
import type { EngineKind } from "../../lib/contracts";

export const ENGINE_LABEL: Record<EngineKind, string> = { adaptive: "Nexus Adaptive", stable: "Stable (legacy)" };

/** Plain-language name for the engineering mode a conversation/run is bound to. */
export function engineLabelForMode(modeId: string | null | undefined): string | null {
  if (!modeId) return null;
  if (modeId === "engineering-v2-adaptive") return ENGINE_LABEL.adaptive;
  return ENGINE_LABEL.stable;
}

/**
 * Which engine NEW tasks use. Adaptive is the recommended default; Stable (the historical muse-v0) stays
 * selectable. If the chosen engine cannot be used, the reason is shown - it never falls back silently.
 */
export function EngineChoice({ compact = false }: { compact?: boolean }) {
  const { engineChoice: c, setEnginePreference, setupAdaptive, adaptiveBusy, adaptiveReport, adaptiveError } = useNexus();
  if (!c) return null;
  const needsSetup = c.preferred === "adaptive" && !c.adaptiveAvailable;
  return (
    <div className="nv-engine" aria-label="Engine for new tasks">
      <label className="nv-note" htmlFor="nv-engine-select">
        Engine{" "}
      </label>
      <select
        id="nv-engine-select"
        className="nv-select nv-select--quiet"
        value={c.preferred}
        onChange={(e) => void setEnginePreference(e.target.value as EngineKind)}
        title="The engine NEW tasks use. Existing conversations keep the engine they started with."
      >
        <option value="adaptive">{ENGINE_LABEL.adaptive} (recommended)</option>
        <option value="stable">{ENGINE_LABEL.stable}</option>
      </select>
      {!compact && c.adaptiveAvailable && c.adaptiveModel && (
        <span className="nv-note"> · {c.adaptiveModel} via {c.adaptiveRoute}</span>
      )}
      {needsSetup && (
        <Alert tone="warning" title="Nexus Adaptive is not set up yet">
          {c.adaptiveReason ?? "It needs a one-time provider check."} New tasks will not start until you set it up or pick Stable.{" "}
          <Button size="sm" onClick={() => void setupAdaptive()} disabled={adaptiveBusy} icon={adaptiveBusy ? <Loader2 size={14} className="nv-spin" /> : undefined}>
            {adaptiveBusy ? "Setting up…" : "Set up Nexus Adaptive…"}
          </Button>
        </Alert>
      )}
      {adaptiveReport && (
        <p className="nv-note" role="status">
          {adaptiveReport.verified ? "Nexus Adaptive verified with the provider." : "The provider checks did not all pass; Nexus Adaptive stays unavailable."}
        </p>
      )}
      {adaptiveError && (
        <Alert tone="warning" title="Setup did not finish">
          {adaptiveError.message}
        </Alert>
      )}
    </div>
  );
}
