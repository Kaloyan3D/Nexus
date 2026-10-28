import { useState } from "react";
import { EngineChoice } from "../engine/EngineChoice";
import { EnvironmentNotes } from "../setup/EnvironmentNotes";
import { useNexus } from "../../state/NexusContext";
import { absoluteTime } from "../../lib/format";
import { Alert, Badge, Button, KeyValue } from "../../components/ui/primitives";
import { ownLimits } from "../../lib/limits";

const LIMIT_FIELDS: { key: "maxTurns" | "maxToolCalls" | "maxRuntimeSecs"; label: string }[] = [
  { key: "maxTurns", label: "Model turns" },
  { key: "maxToolCalls", label: "Tool calls" },
  { key: "maxRuntimeSecs", label: "Run time (seconds)" },
];

/** Optional: bound your own cost or time. Nexus has no limit of its own, so with nothing set a task runs until it is done. */
function AdvancedLimits() {
  const { intentCodeLimits, saveCodeLimits } = useNexus();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  if (!intentCodeLimits) return null;
  const save = async (reset: boolean) => {
    const out: Record<string, number> = {};
    if (!reset) for (const f of LIMIT_FIELDS) { const v = Number(draft[f.key]); if (draft[f.key] && Number.isFinite(v) && v > 0) out[f.key] = Math.floor(v); }
    try {
      await saveCodeLimits(out);
      setDraft({});
      setMsg(reset ? "Limits removed: tasks run until they are done or you press Stop." : "Saved. New tasks use these limits.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save the limits.");
    }
  };
  return (
    <details className="nv-details" style={{ marginTop: 10 }}>
      <summary>Optional: limit your own cost or time</summary>
      <p className="nv-note">Nexus never limits how many steps, edits, commands or minutes a task needs. Each model turn is a billable request, so you may set a limit of your own here; it applies to new tasks. Leave these empty for no limit, and press Stop to end any task.</p>
      <div className="nv-heading__meta" style={{ flexWrap: "wrap", gap: 8 }}>
        {LIMIT_FIELDS.map((f) => (
          <label key={f.key} className="nv-note">
            {f.label}{" "}
            <input type="number" min={1} aria-label={f.label} style={{ width: 90 }} placeholder={intentCodeLimits[f.key] ? String(intentCodeLimits[f.key]) : "no limit"} value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
          </label>
        ))}
        <Button size="sm" onClick={() => void save(false)}>Save</Button>
        <Button size="sm" variant="ghost" onClick={() => void save(true)}>Remove limits</Button>
      </div>
      {msg && <p className="nv-note" role="status">{msg}</p>}
    </details>
  );
}

export function SettingsPage() {
  const { appInfo, runtime, blockers, refreshRuntime, runtimeState, connectProvider, giveConsent, revokeConsent, retryRuntime, setupBusy, setupError, intentCodeLimits, permissionSupport } = useNexus();
  const i = appInfo.data;
  const connected = runtime?.connection === "connected";
  return (
    <div className="nv-page">
      <h1 className="nv-page__title">Settings</h1>
      <p className="nv-page__sub">Your connection, the engine, safety limits and what this computer can do. Privileged changes always ask in a system dialog.</p>

      {runtimeState?.mode === "interactive" && (
        <section className="nv-panel" aria-label="Provider and autonomy">
          <h2 className="nv-panel__title">Provider and autonomy</h2>
          <KeyValue
            rows={[
              { label: "Nexus runtime", value: <Badge tone={runtimeState.phase === "ready" ? "success" : runtimeState.phase === "error" ? "error" : "warning"}>{runtimeState.phase}</Badge> },
              { label: "OpenCode Go", value: <Badge tone={runtimeState.providerConnected ? "success" : "warning"}>{runtimeState.providerConnected ? "connected" : "not connected"}</Badge> },
              { label: "Autonomous work", value: <Badge tone={runtimeState.consent.given ? "success" : "warning"}>{runtimeState.consent.given ? "allowed" : "not allowed"}</Badge> },
              { label: "Model", value: runtimeState.consent.remoteModelId ?? "—", mono: true },
            ]}
          />
          <div className="nv-heading__meta" style={{ marginTop: 12 }}>
            <Button size="sm" onClick={() => void connectProvider()} disabled={setupBusy !== null}>
              {runtimeState.providerConnected ? "Replace API key…" : "Connect OpenCode Go…"}
            </Button>
            {runtimeState.consent.given ? (
              <Button size="sm" onClick={() => void revokeConsent()} disabled={setupBusy !== null}>
                Revoke autonomous work…
              </Button>
            ) : (
              <Button size="sm" onClick={() => void giveConsent()} disabled={setupBusy !== null || !runtimeState.providerConnected}>
                Allow autonomous work…
              </Button>
            )}
            {runtimeState.phase === "error" && (
              <Button size="sm" onClick={() => void retryRuntime()} disabled={setupBusy !== null}>
                Restart runtime
              </Button>
            )}
          </div>
          {runtimeState.consent.text && (
            <details className="nv-details" style={{ marginTop: 10 }}>
              <summary>What you agreed to</summary>
              <pre className="nv-msg__pre">{runtimeState.consent.text}</pre>
            </details>
          )}
          {setupError && <Alert tone="warning" title="That did not finish">{setupError.message}</Alert>}
          <div style={{ marginTop: 12 }}>
            <EngineChoice />
          </div>
          <AdvancedLimits />
          <details className="nv-details" style={{ marginTop: 10 }}>
            <summary>Diagnostics</summary>
            <KeyValue
              rows={[
                { label: "Data folder", value: runtimeState.home ?? "—", mono: true },
                { label: "Your run limits", value: intentCodeLimits ? (ownLimits(intentCodeLimits) ?? "none (Nexus applies no limit of its own)") : "—" },
                { label: "Message", value: runtimeState.message ?? "—" },
              ]}
            />
          </details>
        </section>
      )}

      {runtimeState?.mode === "interactive" && (
        <section className="nv-panel" aria-label="This computer">
          <h2 className="nv-panel__title">This computer</h2>
          <p className="nv-note">What Nexus found here decides what it can do. Anything that is missing is listed with how to fix it.</p>
          <EnvironmentNotes />
          <KeyValue
            rows={[
              { label: "Commands in your project", value: permissionSupport?.known ? <Badge tone={permissionSupport.inPlaceAvailable === false ? "warning" : "success"}>{permissionSupport.inPlaceAvailable === false ? "unavailable" : "available"}</Badge> : "—" },
              { label: "Node.js", value: runtimeState.node ? (runtimeState.node.source === "bundled" ? `${runtimeState.node.version ?? ""} — bundled with Nexus (private; your system is untouched)` : "from this computer (development build)") : "—" },
              { label: "Data folder", value: runtimeState.home ?? "—", mono: true },
            ]}
          />
        </section>
      )}

      <section className="nv-panel">
        <h2 className="nv-panel__title">Application</h2>
        {appInfo.error && <Alert tone="warning" title="App info unavailable">{appInfo.error.message}</Alert>}
        <KeyValue
          rows={[
            { label: "Version", value: i?.appVersion, mono: true },
            { label: "Platform", value: i?.platform },
          ]}
        />
      </section>

      <details className="nv-details nv-panel" aria-label="Advanced diagnostics">
        <summary>Advanced diagnostics</summary>
        <h3 className="nv-subheading">Native daemon</h3>
        <KeyValue
          rows={[
            { label: "Connection", value: runtime ? <Badge tone={connected ? "success" : "error"}>{runtime.connection}</Badge> : null },
            { label: "Detail", value: runtime?.detail },
            { label: "Last check", value: runtime ? absoluteTime(new Date(runtime.checkedAtMs).toISOString()) : null },
            { label: "Socket", value: i?.socketPath, mono: true },
            { label: "Ledger dir", value: i?.ledgerDir ?? "unset (NEXUS_LEDGER_DIR)", mono: true },
            { label: "Client API", value: i ? `v${i.clientApiVersion}` : null },
            { label: "IPC protocol", value: i ? `v${i.ipcProtocol}` : null },
          ]}
        />
        <div style={{ marginTop: 12 }}>
          <button type="button" className="nv-btn nv-btn--sm" onClick={refreshRuntime}>
            Re-run diagnostics
          </button>
        </div>
        <h3 className="nv-subheading">Known limitations of live execution</h3>
        <ul className="nv-list">
          {(blockers.data?.blockers ?? []).map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
        {!blockers.data && <p className="nv-note">The list is unavailable.</p>}
      </details>
    </div>
  );
}
