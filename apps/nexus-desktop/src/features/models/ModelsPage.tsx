import { useNexus } from "../../state/NexusContext";
import { Alert, Badge, Loading } from "../../components/ui/primitives";
import { reasonWords } from "./modelTargets";

function limit(n: number | null | undefined): string {
  return n == null ? "—" : String(n);
}

export function ModelsPage() {
  const { catalog, intentTargets, intentTargetsError } = useNexus();
  const c = catalog.data;
  return (
    <div className="nv-page">
      <h1 className="nv-page__title">Models</h1>
      <p className="nv-page__sub">What the native client can see. Read-only; no routing or credential changes.</p>
      <h2 className="nv-detail__h">Registry models (read-only)</h2>
      <p className="nv-page__sub">Live Registry targets with their status. No edit controls; nothing secret is shown.</p>
      {intentTargets == null && !intentTargetsError && <Loading label="Loading Registry models…" />}
      {intentTargetsError && <Alert tone="error" title="Registry models unavailable">{intentTargetsError.message}</Alert>}
      {intentTargets && (
        <div className="nv-table-scroll" role="region" aria-label="Registry models (scrolls sideways on narrow windows)" tabIndex={0}>
        <div className="nv-table nv-table--targets" role="table" aria-label="Registry models">
          <div className="nv-table__row nv-table__row--head" role="row">
            <span role="columnheader">Provider</span>
            <span role="columnheader">Model</span>
            <span role="columnheader">Route</span>
            <span role="columnheader">Connection</span>
            <span role="columnheader">Protocol</span>
            <span role="columnheader">Context limit</span>
            <span role="columnheader">Output limit</span>
            <span role="columnheader">Billing tier</span>
            <span role="columnheader">Data use</span>
            <span role="columnheader">Status</span>
          </div>
          {intentTargets.map((t) => {
            const ok = t.issuable !== false;
            return (
              <div className="nv-table__row" role="row" key={t.routeId || `${t.providerId}/${t.remoteModelId}`}>
                <span role="cell" className="nv-mono">{t.providerId}</span>
                <span role="cell" className="nv-mono">{t.logicalModelId || t.remoteModelId}</span>
                <span role="cell" className="nv-mono nv-table__muted">{t.routeId || "—"}</span>
                <span role="cell">{t.connectionStatus || "—"}</span>
                <span role="cell">{t.protocol || "—"}</span>
                <span role="cell" className="nv-mono">{limit(t.contextLimitTokens)}</span>
                <span role="cell" className="nv-mono">{limit(t.outputLimitTokens)}</span>
                <span role="cell">{t.billingTier || "—"}</span>
                <span role="cell">{t.dataUse || "—"}</span>
                <span role="cell">
                  {ok ? <Badge tone="success">Issuable</Badge> : <Badge tone="warning">Unavailable</Badge>}
                  {!ok && <span className="nv-note"> {reasonWords(t.reason)}</span>}
                </span>
              </div>
            );
          })}
        </div>
        </div>
      )}
      <Alert tone="info" title="Offline mock catalog">
        These entries come from the native client&apos;s built-in offline mock catalog. They are not the
        production Registry, and none of them can serve live traffic. The Registry service remains the only live
        model authority.
      </Alert>
      {catalog.loading && <Loading />}
      {catalog.error && <Alert tone="error" title="Catalog unavailable">{catalog.error.message}</Alert>}
      {c && (
        <>
          <div className="nv-table" role="table" aria-label="Offline mock catalog">
            <div className="nv-table__row nv-table__row--head" role="row">
              <span role="columnheader">Model</span>
              <span role="columnheader">Scope</span>
              <span role="columnheader">Origin</span>
              <span role="columnheader">Reasoning</span>
              <span role="columnheader">Live</span>
            </div>
            {c.entries.map((e) => (
              <div className="nv-table__row" role="row" key={e.model}>
                <span role="cell" className="nv-mono">{e.model}</span>
                <span role="cell"><Badge mono>{e.scope}</Badge></span>
                <span role="cell" className="nv-mono nv-table__muted">{e.origin}</span>
                <span role="cell">{e.reasoning}</span>
                <span role="cell">{e.live ? <Badge tone="success">live</Badge> : <Badge tone="warning">mock only</Badge>}</span>
              </div>
            ))}
          </div>
          <h2 className="nv-detail__h">Why live is blocked</h2>
          <ul className="nv-list">
            {c.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
