import { BarChart3, ChevronDown, ChevronRight, Copy, Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { RunAnalytics as Analytics } from "../../lib/contracts";
import { asUiError } from "../../lib/api";
import { fmtCost, fmtMs, fmtNum, fmtPct, hasSomething, shares, UNAVAILABLE } from "../../lib/analytics";
import { Alert, Badge, Button } from "../../components/ui/primitives";
import { modeLabel } from "../permissions/PermissionControls";
import { useNexus } from "../../state/NexusContext";

function Row({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className={v === UNAVAILABLE ? "nv-an__na" : undefined} title={note}>
        {v}
      </dd>
    </>
  );
}

/**
 * Run Analytics: a compact summary line for any run and an expandable detail. Every number comes from the engine's own
 * records; what the run could not measure says "Unavailable" and why, never zero.
 */
export function RunAnalytics({ runId, live }: { runId: string; live: boolean }) {
  const { api } = useNexus();
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .runAnalytics(runId)
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError(null);
          setLoading(false);
        })
        .catch((e) => {
          if (!alive) return;
          setError(asUiError(e).message);
          setLoading(false);
        });
    void pull();
    const t = live ? window.setInterval(() => void pull(), 5000) : null;
    return () => {
      alive = false;
      if (t !== null) window.clearInterval(t);
    };
  }, [api, runId, live]);

  const copy = async () => {
    try {
      const doc = await api.runAnalyticsExport(runId);
      await navigator.clipboard.writeText(JSON.stringify(doc, null, 2));
      setNote("Benchmark JSON copied to the clipboard.");
    } catch (e) {
      setNote(`Could not export: ${asUiError(e).message}`);
    }
  };
  const save = async () => {
    try {
      const r = await api.runAnalyticsSave(runId);
      setNote(`Saved to ${r.path}`);
    } catch (e) {
      setNote(`Could not save: ${asUiError(e).message}`);
    }
  };

  if (loading && !data) {
    return (
      <section className="nv-an" aria-label="Run analytics">
        <p className="nv-note">
          <Loader2 size={13} className="nv-spin" aria-hidden="true" /> Loading run analytics…
        </p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="nv-an" aria-label="Run analytics">
        <p className="nv-note">Run analytics are unavailable for this run{error ? `: ${error}` : "."}</p>
      </section>
    );
  }
  const a = data;
  const cost = fmtCost(a.cost);
  const sh = shares(a);
  const models = a.tokens.byModel;
  return (
    <section className="nv-an" aria-label="Run analytics">
      <div className="nv-an__summary">
        <BarChart3 size={14} aria-hidden="true" />
        <strong>Run analytics</strong>
        {!a.runtime.terminal && <Badge tone="warning">in progress</Badge>}
        {a.runtime.terminal && !a.source.perRequestRecord && <Badge tone="warning" title="This run ran before per-request analytics existed">partial history</Badge>}
        <span title="Total wall-clock time">⏱ {fmtMs(a.runtime.wallMs)}</span>
        <span title="Provider requests">{a.runtime.requests.count > 0 ? `${a.runtime.requests.count} requests` : "requests: Unavailable"}</span>
        <span title="Input / output tokens">
          ↓ {fmtNum(a.tokens.input)} ↑ {fmtNum(a.tokens.output)} tokens
        </span>
        <span title="Cached input tokens ÷ input tokens">cache {fmtPct(a.tokens.cacheHitRate)}</span>
        <span title="Output tokens ÷ total request time">{a.runtime.outputTokensPerSecond != null ? `${a.runtime.outputTokensPerSecond} tok/s` : "tok/s Unavailable"}</span>
        <span title={cost.kind === "estimated" ? "Estimated from your pricing data; not a billed cost" : cost.kind === "actual" ? "Reported by the provider" : "No cost data"}>cost {cost.text}{cost.kind === "actual" ? " (provider-reported)" : cost.kind === "estimated" ? " (estimate)" : ""}</span>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)} icon={open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}>
          Details
        </Button>
      </div>
      {!hasSomething(a) && <p className="nv-note">Nothing was measured for this run yet.</p>}
      {open && (
        <div className="nv-an__detail">
          <h4>Runtime</h4>
          <dl className="nv-an__facts">
            <Row k="Started" v={new Date(a.runtime.startedAtMs).toLocaleString()} />
            <Row k="Ended" v={a.runtime.endedAtMs ? new Date(a.runtime.endedAtMs).toLocaleString() : "Not ended"} />
            <Row k="Wall clock" v={fmtMs(a.runtime.wallMs)} />
            <Row k="Average request latency" v={fmtMs(a.runtime.requests.avgLatencyMs)} />
            <Row k="Time to first token (avg)" v={fmtMs(a.runtime.overlapping.timeToFirstTokenMs.avg)} note="Inside each request; not added to the categories below" />
            <Row k="Output throughput" v={a.runtime.outputTokensPerSecond != null ? `${a.runtime.outputTokensPerSecond} tokens/s` : UNAVAILABLE} note="Output tokens ÷ total request time (end to end, first-token wait included)" />
          </dl>
          <h5>Where the time went (these add up to the wall clock)</h5>
          {sh ? (
            <>
              <div className="nv-an__bar" role="img" aria-label={sh.map((r) => `${r.label} ${r.pct.toFixed(0)}%`).join(", ")}>
                {sh.map((r) => (
                  <span key={r.key} className={`nv-an__seg nv-an__seg--${r.key}`} style={{ width: `${Math.max(r.pct, 0.5)}%` }} title={`${r.label}: ${fmtMs(r.ms)}`} />
                ))}
              </div>
              <ul className="nv-list">
                {sh.map((r) => (
                  <li key={r.key}>
                    {r.label}: {fmtMs(r.ms)} ({r.pct.toFixed(0)}%)
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="nv-note">Unavailable: this run has no per-request and per-tool timing, so its time cannot be split.</p>
          )}
          <p className="nv-note">
            Overlapping measures, not part of that sum: build and test time inside tool execution {fmtMs(a.runtime.overlapping.buildAndTestMs)}; time to first token inside model requests.
          </p>

          <h4>Tokens</h4>
          <dl className="nv-an__facts">
            <Row k="Input" v={fmtNum(a.tokens.input)} />
            <Row k="Cached input" v={fmtNum(a.tokens.cachedInput)} note="A subset of input" />
            <Row k="Noncached input" v={fmtNum(a.tokens.noncachedInput)} />
            <Row k="Cache write" v={fmtNum(a.tokens.cacheWrite)} />
            <Row k="Output" v={fmtNum(a.tokens.output)} />
            <Row k="Reasoning" v={fmtNum(a.tokens.reasoning)} note="A subset of output" />
            <Row k="Cache hit rate" v={fmtPct(a.tokens.cacheHitRate)} note="Cached input ÷ input" />
          </dl>
          {a.tokens.source === "run-record-cumulative" && <p className="nv-note">Only run totals were recorded for this run: per-request, cache and reasoning figures are Unavailable.</p>}
          {a.tokens.byPhase.length > 0 && (
            <table className="nv-an__table" aria-label="Tokens by phase">
              <thead>
                <tr><th>Phase</th><th>Requests</th><th>Input</th><th>Output</th></tr>
              </thead>
              <tbody>
                {a.tokens.byPhase.map((p) => (
                  <tr key={p.phase}><td>{p.phase}</td><td>{p.requests}</td><td>{fmtNum(p.inputTokens)}</td><td>{fmtNum(p.outputTokens)}</td></tr>
                ))}
              </tbody>
            </table>
          )}

          <h4>Models and routing</h4>
          <dl className="nv-an__facts">
            <Row k="Configured model" v={[a.routing.configured.provider, a.routing.configured.model].filter(Boolean).join(" / ") || UNAVAILABLE} />
            <Row k="Model switches" v={String(a.routing.modelSwitches)} />
            <Row k="Permission mode" v={a.identity.permissionMode ? modeLabel(a.identity.permissionMode) : UNAVAILABLE} />
          </dl>
          {models.length > 0 ? (
            <table className="nv-an__table" aria-label="Per-model breakdown">
              <thead>
                <tr><th>Model</th><th>Attempts</th><th>Input</th><th>Output</th><th>Cache</th><th>Request time</th></tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.model}><td>{m.model}</td><td>{m.requests}</td><td>{fmtNum(m.inputTokens)}</td><td>{fmtNum(m.outputTokens)}</td><td>{fmtPct(m.cacheHitRate)}</td><td>{fmtMs(m.latencyMs)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="nv-note">Per-model figures are Unavailable for this run.</p>
          )}
          {a.routing.requests.some((r) => r.actualModel && r.routedAsConfigured === false) && <p className="nv-note">The provider named a different serving model than the one configured for at least one request.</p>}
          {a.routing.phaseTransitions.length > 0 && (
            <p className="nv-note">Phases: {a.routing.phaseTransitions.map((p) => p.phase).join(" → ")}</p>
          )}

          <h4>Tools and verification</h4>
          <dl className="nv-an__facts">
            <Row k="Tool calls requested by the model" v={fmtNum(a.tools.modelRequested)} />
            <Row k="Calls recorded" v={fmtNum(a.tools.recordedCalls)} note="What the controller authorized and tried" />
            <Row k="Succeeded / failed / refused" v={`${a.tools.succeeded} / ${a.tools.failed} / ${a.tools.refusedOrDenied}`} />
            <Row k="Tool execution time" v={fmtMs(a.tools.executionMs)} />
            <Row k="Build and test time" v={fmtMs(a.tools.buildAndTestMs)} />
            <Row k="File edits (applied / proposed)" v={`${a.tools.fileEdits.applied} / ${a.tools.fileEdits.proposed}`} />
            <Row k="Dependency installs (approved / denied / automatic)" v={`${a.tools.dependencyInstalls.approved} / ${a.tools.dependencyInstalls.denied} / ${a.tools.dependencyInstalls.automatic}`} />
            <Row k="Permission prompts" v={String(a.tools.permissionPrompts)} />
            <Row k="Verification cycles" v={String(a.verification.cycles)} />
            <Row k="Failed verification attempts" v={String(a.verification.failedAttempts)} />
            <Row k="Recovery cycles" v={fmtNum(a.verification.recoveryCycles)} />
            <Row k="Final verification" v={a.verification.finalVerification ?? UNAVAILABLE} note="From the execution receipts, never from the model's answer" />
          </dl>
          {a.tools.commands.length > 0 && (
            <table className="nv-an__table" aria-label="Commands">
              <thead>
                <tr><th>#</th><th>Command</th><th>Exit</th><th>Time</th></tr>
              </thead>
              <tbody>
                {a.tools.commands.slice(0, 20).map((c) => (
                  <tr key={c.index}><td>{c.index}</td><td className="nv-mono">{c.command}</td><td>{c.exitCode ?? "—"}</td><td>{fmtMs(c.execMs)}</td></tr>
                ))}
              </tbody>
            </table>
          )}

          <h4>Cost</h4>
          <dl className="nv-an__facts">
            <Row k="Provider-reported" v={a.cost.actual.usd != null ? `$${a.cost.actual.usd.toFixed(4)}` : UNAVAILABLE} note={`${a.cost.actual.requestsReporting} of ${a.cost.actual.requestsTotal} requests reported a cost`} />
            <Row k="Provider list-price equivalent" v={a.cost.providerListPrice?.usd != null ? `$${a.cost.providerListPrice.usd.toFixed(6)}` : UNAVAILABLE} note="What the tokens would cost at list price, as the provider reports it; not what was billed" />
            <Row k="Estimated (your pricing data)" v={a.cost.estimated.usd != null ? `~$${a.cost.estimated.usd.toFixed(4)}` : UNAVAILABLE} note="Never shown as a billed amount" />
          </dl>

          {a.missing.length > 0 && (
            <details className="nv-an__missing">
              <summary>{a.missing.length} metric{a.missing.length === 1 ? "" : "s"} unavailable</summary>
              <ul className="nv-list">
                {a.missing.map((m) => (
                  <li key={m.metric}>
                    <span className="nv-mono">{m.metric}</span>: {m.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="nv-an__actions">
            <Button size="sm" onClick={() => void copy()} icon={<Copy size={14} />}>Copy benchmark JSON</Button>
            <Button size="sm" onClick={() => void save()} icon={<Download size={14} />}>Save to Downloads</Button>
          </div>
          {note && <Alert tone="info" title="Benchmark export">{note}</Alert>}
        </div>
      )}
    </section>
  );
}
