import { useNexus } from "../../state/NexusContext";
import { Alert, Badge, Loading } from "../../components/ui/primitives";

export function ModelsPage() {
  const { catalog } = useNexus();
  const c = catalog.data;
  return (
    <div className="nv-page">
      <h1 className="nv-page__title">Models</h1>
      <p className="nv-page__sub">What the native client can see. Read-only; no routing or credential changes.</p>
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
