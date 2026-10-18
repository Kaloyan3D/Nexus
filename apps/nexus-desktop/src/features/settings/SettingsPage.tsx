import { useState } from "react";
import { useNexus } from "../../state/NexusContext";
import { absoluteTime } from "../../lib/format";
import { Alert, Badge, Button, KeyValue } from "../../components/ui/primitives";

const LIMIT_FIELDS: { key: "maxTurns" | "maxToolCalls" | "maxEdits" | "maxTests" | "maxRuntimeSecs"; label: string }[] = [
  { key: "maxTurns", label: "Model turns" },
  { key: "maxToolCalls", label: "Tool calls" },
  { key: "maxEdits", label: "File changes" },
  { key: "maxTests", label: "Commands" },
  { key: "maxRuntimeSecs", label: "Run time (seconds)" },
];

/** Advanced: lower the automatic limits. Nothing here needs to be touched for ordinary use. */
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
      setMsg(reset ? "Limits reset to the built-in values." : "Saved. New tasks use these limits.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save the limits.");
    }
  };
  return (
    <details className="nv-details" style={{ marginTop: 10 }}>
      <summary>Advanced: run limits</summary>
      <p className="nv-note">Nexus sizes these generously by itself; lower them only if you want shorter, cheaper runs. They apply to new tasks.</p>
      <div className="nv-heading__meta" style={{ flexWrap: "wrap", gap: 8 }}>
        {LIMIT_FIELDS.map((f) => (
          <label key={f.key} className="nv-note">
            {f.label}{" "}
            <input type="number" min={1} aria-label={f.label} style={{ width: 90 }} placeholder={String(intentCodeLimits[f.key])} value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
          </label>
        ))}
        <Button size="sm" onClick={() => void save(false)}>Save</Button>
        <Button size="sm" variant="ghost" onClick={() => void save(true)}>Reset</Button>
      </div>
      {msg && <p className="nv-note" role="status">{msg}</p>}
    </details>
  );
}

export function SettingsPage() {
  const { appInfo, runtime, blockers, refreshRuntime, runtimeState, connectProvider, giveConsent, revokeConsent, retryRuntime, setupBusy, setupError, intentCodeLimits } = useNexus();
  const i = appInfo.data;
  const connected = runtime?.connection === "connected";
  return (
    <div className="nv-page">
      <h1 className="nv-page__title">Settings</h1>
      <p className="nv-page__sub">Read-only configuration. Nexus does not change privileged settings.</p>

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
          <AdvancedLimits />
          <details className="nv-details" style={{ marginTop: 10 }}>
            <summary>Diagnostics</summary>
            <KeyValue
              rows={[
                { label: "Data folder", value: runtimeState.home ?? "—", mono: true },
                { label: "Run limits (automatic)", value: intentCodeLimits ? `${intentCodeLimits.maxTurns} turns · ${intentCodeLimits.maxToolCalls} tool calls · ${intentCodeLimits.maxEdits} edits · ${intentCodeLimits.maxTests} test runs · ${intentCodeLimits.maxOutputTokens} output tokens/turn · ${Math.round(intentCodeLimits.maxRuntimeSecs / 60)} min` : "—" },
                { label: "Message", value: runtimeState.message ?? "—" },
              ]}
            />
          </details>
        </section>
      )}

      <section className="nv-panel">
        <h2 className="nv-panel__title">Appearance</h2>
        <KeyValue
          rows={[
            { label: "Theme", value: "Nexus Dark (only theme)" },
            { label: "Accent", value: <Badge tone="purple" mono>#7C5CFF</Badge> },
            { label: "Motion", value: "Follows system reduced-motion preference" },
          ]}
        />
      </section>

      <section className="nv-panel">
        <h2 className="nv-panel__title">Native daemon</h2>
        <KeyValue
          rows={[
            { label: "Connection", value: runtime ? <Badge tone={connected ? "success" : "error"}>{runtime.connection}</Badge> : null },
            { label: "Detail", value: runtime?.detail },
            { label: "Last check", value: runtime ? absoluteTime(new Date(runtime.checkedAtMs).toISOString()) : null },
            { label: "Socket", value: i?.socketPath, mono: true },
            { label: "Ledger dir", value: i?.ledgerDir ?? "unset (NEXUS_LEDGER_DIR)", mono: true },
          ]}
        />
        <div style={{ marginTop: 12 }}>
          <button type="button" className="nv-btn nv-btn--sm" onClick={refreshRuntime}>
            Re-run diagnostics
          </button>
        </div>
      </section>

      <section className="nv-panel">
        <h2 className="nv-panel__title">Application</h2>
        {appInfo.error && <Alert tone="warning" title="App info unavailable">{appInfo.error.message}</Alert>}
        <KeyValue
          rows={[
            { label: "Version", value: i?.appVersion, mono: true },
            { label: "Client API", value: i ? `v${i.clientApiVersion}` : null },
            { label: "IPC protocol", value: i ? `v${i.ipcProtocol}` : null },
            { label: "Platform", value: i?.platform },
            { label: "Dispatch", value: <Badge tone="warning">disabled</Badge> },
          ]}
        />
      </section>

      <section className="nv-panel">
        <h2 className="nv-panel__title">Known live-execution blockers</h2>
        <ul className="nv-list">
          {(blockers.data?.blockers ?? []).map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
        {!blockers.data && <p className="nv-note">Blocker list unavailable.</p>}
      </section>
    </div>
  );
}
