import { useNexus } from "../../state/NexusContext";
import { absoluteTime } from "../../lib/format";
import { Alert, Badge, KeyValue } from "../../components/ui/primitives";

export function SettingsPage() {
  const { appInfo, runtime, blockers, refreshRuntime } = useNexus();
  const i = appInfo.data;
  const connected = runtime?.connection === "connected";
  return (
    <div className="nv-page">
      <h1 className="nv-page__title">Settings</h1>
      <p className="nv-page__sub">Read-only configuration. Nexus does not change privileged settings.</p>

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
