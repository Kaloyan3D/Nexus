import { useEffect, useState } from "react";
import { asUiError } from "../../lib/api";
import type { CopyInfo, DiffReply, IntentRun, TranscriptEvent } from "../../lib/contracts";
import { commandOutputs, type CommandOutput } from "../../lib/testOutput";
import { outcomeView, toolKind } from "../../lib/runKind";
import { useNexus, type PanelKind } from "../../state/NexusContext";
import { Alert, Badge, Loading, Tabs, type TabDef } from "../../components/ui/primitives";
import { DiffViewer } from "../conversation/ModelRunPanel";
import { RecoverySection } from "../recovery/CommandRecovery";
import { ownLimits } from "../../lib/limits";

const TABS: TabDef[] = [
  { id: "diff", label: "Diff" },
  { id: "test", label: "Test output" },
  { id: "evidence", label: "Evidence & recovery" },
  { id: "source", label: "Source" },
];

const short = (h?: string | null, n = 10) => (h ? h.slice(0, n) : "—");

function useLoad<T>(key: string, load: () => Promise<T>): { data: T | null; error: string | null; loading: boolean } {
  const [st, setSt] = useState<{ key: string; data: T | null; error: string | null }>({ key: "", data: null, error: null });
  useEffect(() => {
    let alive = true;
    load()
      .then((d) => alive && setSt({ key, data: d, error: null }))
      .catch((e) => alive && setSt({ key, data: null, error: asUiError(e).message }));
    return () => {
      alive = false;
    };
    // `load` closes over `key`'s inputs; the key is the identity of the request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const mine = st.key === key;
  return { data: mine ? st.data : null, error: mine ? st.error : null, loading: !mine };
}

function fmtBytes(n?: number | null): string {
  if (n == null) return "—";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function fmtAge(ms?: number | null): string {
  if (ms == null) return "—";
  const m = Math.round(ms / 60000);
  if (m < 1) return "under a minute";
  if (m < 120) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

/** Explicit, user-triggered copy of the patch text; nothing is applied anywhere. */
function CopyPatch({ patch, truncated }: { patch: string; truncated: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(patch);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="nv-heading__meta">
      <button type="button" className="nv-btn nv-btn--sm" onClick={copy} disabled={!patch || truncated} title={truncated ? "The diff is truncated; export the full patch with the operator CLI" : undefined}>
        Copy patch
      </button>
      <span className="nv-note" role="status">
        {state === "copied" && "Patch copied to the clipboard. Applying it is a manual step by you."}
        {state === "failed" && "The clipboard is not available here; select the text instead."}
        {truncated && "Too large to copy whole — use the operator CLI to export it."}
      </span>
    </div>
  );
}

function CopyFacts({ run }: { run: IntentRun }) {
  const { api } = useNexus();
  const { data, error } = useLoad<CopyInfo>(`copy:${run.runId}:${run.updatedAtMs}`, () => api.intentCopy(run.runId));
  if (error) return null;
  if (!data) return null;
  return (
    <p className="nv-note" aria-label="Working copy">
      Working copy:{" "}
      {data.retained
        ? `retained · ${fmtBytes(data.approxBytes)} · ${fmtAge(data.ageMs)} old${data.active ? " · in use" : ""}`
        : "removed by the operator (the recorded evidence remains; the diff is no longer available)"}
      {data.baseCommit ? <> · base <span className="nv-mono">{short(data.baseCommit)}</span></> : null}
    </p>
  );
}

function DiffTab({ run }: { run: IntentRun }) {
  const { api } = useNexus();
  const { data, error, loading } = useLoad<DiffReply>(`diff:${run.runId}:${run.updatedAtMs}`, () => api.intentDiff(run.runId));
  if (loading) return <Loading label="Reading the change set…" />;
  if (error) return <Alert tone="warning" title="Diff unavailable">{error}</Alert>;
  const d = data!;
  return (
    <div className="nv-stack" style={{ gap: 8 }}>
      <ul className="nv-list" aria-label="Changed files">
        {d.files.length === 0 && <li className="nv-note">No file was changed.</li>}
        {d.files.map((f) => (
          <li key={f.path} className="nv-mono">
            {f.status} {f.path} {f.additions != null ? `+${f.additions}` : ""} {f.deletions != null ? `-${f.deletions}` : ""}
          </li>
        ))}
      </ul>
      <CopyPatch patch={d.diff} truncated={d.diffTruncated} />
      <DiffViewer diff={d.diff || "(no changes)"} truncated={d.diffTruncated} />
      <CopyFacts run={run} />
      {run.workspaceKind === "direct" ? (
        <p className="nv-note">
          These changes were made directly in your project folder: they are already saved in your files. Nexus kept the original of every file it changed, so this is exactly what differs from before the run.
        </p>
      ) : (
        <p className="nv-note">
          This is the isolated working copy at commit <span className="nv-mono">{short(d.baseCommit)}</span>. Your folder is unchanged until you apply these changes.
        </p>
      )}
    </div>
  );
}

function useTranscript(run: IntentRun): { events: TranscriptEvent[]; error: string | null; loading: boolean } {
  const { api } = useNexus();
  const id = run.conversationId ?? "";
  const r = useLoad<TranscriptEvent[]>(`conv:${id}:${run.updatedAtMs}`, async () => {
    if (!id) return [];
    const v = await api.conversationRead(id, { limit: 200 });
    return v.page.events;
  });
  return { events: r.data ?? [], error: r.error, loading: r.loading };
}

function TestTab({ run }: { run: IntentRun }) {
  const t = useTranscript(run);
  if (t.loading) return <Loading label="Reading recorded command output…" />;
  if (t.error) return <Alert tone="warning" title="Output unavailable">{t.error}</Alert>;
  const outs: CommandOutput[] = commandOutputs(t.events);
  const cmds = (run.toolActivity ?? []).filter((a) => a.tool === "proc_run");
  if (cmds.length === 0) return <p className="nv-note">No command was proposed in this run.</p>;
  return (
    <div className="nv-stack" style={{ gap: 12 }}>
      {cmds.map((a, i) => {
        const o = outs[i];
        const ran = a.status === "executed";
        return (
          <section key={a.index} className="nv-stack" style={{ gap: 6 }} aria-label={`Command ${i + 1}`}>
            <div className="nv-heading__meta">
              <Badge mono>{a.argsSummary}</Badge>
              {ran ? (
                <Badge tone={a.verification === "pass" ? "success" : a.verification === "fail" ? "error" : "warning"}>
                  {a.verification === "pass" ? "passed" : a.verification === "fail" ? "failed" : "no verdict"} · exit {a.exitCode ?? "?"}
                </Badge>
              ) : (
                <Badge tone="warning">not executed{a.approvalOutcome && a.approvalOutcome !== "approved" ? ` · approval ${a.approvalOutcome}` : ""}</Badge>
              )}
            </div>
            {!ran && <p className="nv-note">The command did not run, so there is no output and no test result.</p>}
            {ran && !o && <p className="nv-note">No output was recorded for this command.</p>}
            {ran && o && (
              <>
                <p className="nv-note">
                  Bounded, redacted output as recorded and as returned to the model (untrusted text){o.wallMs != null ? ` · ${o.wallMs} ms` : ""}. The verdict above comes from the execution receipt, not from this text.
                </p>
                <pre className="nv-msg__pre" aria-label="stdout tail">{o.stdoutTail || "(no stdout)"}</pre>
                {o.stderrTail && <pre className="nv-msg__pre" aria-label="stderr tail">{o.stderrTail}</pre>}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

function EvidenceTab({ run }: { run: IntentRun }) {
  const v = outcomeView(run);
  const o = run.codingOutcome;
  const ops = (run.toolActivity ?? []).filter((a) => toolKind(a.tool) !== "read");
  return (
    <div className="nv-stack" style={{ gap: 10 }}>
      <dl className="nv-kv">
        <dt>Run</dt>
        <dd className="nv-mono">{run.runId}</dd>
        <dt>Lifecycle</dt>
        <dd>{run.state}{run.errorCode ? ` · ${run.errorCode}` : ""}</dd>
        <dt>Verified outcome</dt>
        <dd>{v ? v.label : "—"}</dd>
        {o && (
          <>
            <dt>Counts</dt>
            <dd>
              {o.editsApplied} edit(s) applied · {o.editsNotApplied} not applied · {o.testsExecuted} command(s) executed · {o.testsNotExecuted} not executed ·{" "}
              {o.blockedByApproval} stopped at approval · {o.uncertainOperations} uncertain
            </dd>
          </>
        )}
        <dt>Working copy base</dt>
        <dd className="nv-mono">{run.worktreeCommit ?? "—"}</dd>
        <dt>Change-set digest</dt>
        <dd className="nv-mono">{run.diffDigest ?? "—"}</dd>
      </dl>
      <table className="nv-table" aria-label="Operation receipts">
        <thead>
          <tr>
            <th>#</th>
            <th>Operation</th>
            <th>Approval</th>
            <th>Result</th>
            <th>Receipt</th>
          </tr>
        </thead>
        <tbody>
          {ops.length === 0 && (
            <tr>
              <td colSpan={5}>No edit or command was proposed.</td>
            </tr>
          )}
          {ops.map((a) => (
            <tr key={a.index}>
              <td>{a.index}</td>
              <td className="nv-mono">{a.tool} {a.argsSummary}</td>
              <td className="nv-mono">{a.approvalId ? `${short(a.approvalId, 8)} · ${a.approvalActor === "automated-policy" ? "automated workspace policy (not a person)" : (a.approvalOutcome ?? "?")}` : "—"}</td>
              <td>{a.status}{a.errorCode ? ` · ${a.errorCode}` : ""}</td>
              <td className="nv-mono">
                {a.postSha256 ? `${short(a.preSha256)} → ${short(a.postSha256)}` : a.exitCode != null ? `exit ${a.exitCode} · ${a.verification ?? "no verdict"}` : "—"}
                {a.journalSeq != null ? ` · journal ${a.journalSeq}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="nv-note">Receipts are the runtime&apos;s records of what executed. The model&apos;s own statements are never used for any status shown here.</p>
      <RecoverySection run={run} />
    </div>
  );
}

function SourceTab({ run }: { run: IntentRun }) {
  const { intentCodeSources, intentCodeLimits } = useNexus();
  const src = intentCodeSources?.find((s) => s.sourceId === run.workspaceId) ?? null;
  return (
    <dl className="nv-kv">
      <dt>Project</dt>
      <dd className="nv-mono">{run.workspaceId ?? "—"}</dd>
      <dt>Working copy commit</dt>
      <dd className="nv-mono">{run.worktreeCommit ?? "—"}</dd>
      <dt>Operator pin</dt>
      <dd className="nv-mono">{src?.pinnedCommit ?? "none"}</dd>
      <dt>Write scope</dt>
      <dd className="nv-mono">{src?.writeAllow && src.writeAllow.length > 0 ? src.writeAllow.join(", ") : "whole project (minus protected files)"}</dd>
      <dt>Run limits</dt>
      <dd>
        {intentCodeLimits ? (ownLimits(intentCodeLimits) ?? "none set by you") : "—"}
      </dd>
      <dt>Approval lifetime</dt>
      <dd>{intentCodeLimits?.approvalLifetimeSecs ? `${Math.round(intentCodeLimits.approvalLifetimeSecs / 60 * 10) / 10} min` : "—"}</dd>
      <dt>Provider</dt>
      <dd className="nv-mono">{run.providerId ?? "—"} / {run.remoteModelId ?? "—"}</dd>
      <dt>Where it ran</dt>
      <dd>
        {run.workspaceKind === "direct"
          ? "Edits made directly in your project folder, with the original of every changed file kept · commands run in a sandbox"
          : "An isolated copy of the project, so your folder is unchanged until you apply the changes · commands run in a sandbox"}
        {" · "}network only for what the project&apos;s permissions allow (off by default) · nothing is committed, pushed or merged
      </dd>
    </dl>
  );
}

export function PanelContent({ kind, run, onKind }: { kind: PanelKind; run: IntentRun | null; onKind: (k: PanelKind) => void }) {
  if (!run) return <p className="nv-note">Select a run to see its evidence.</p>;
  return (
    <>
      <Tabs tabs={TABS} value={kind} onChange={(t) => onKind(t as PanelKind)} label="Evidence views" />
      <div className="nv-evidence__body" role="tabpanel" id={`panel-${kind}`} aria-labelledby={`tab-${kind}`}>
        {kind === "diff" && <DiffTab run={run} />}
        {kind === "test" && <TestTab run={run} />}
        {kind === "evidence" && <EvidenceTab run={run} />}
        {kind === "source" && <SourceTab run={run} />}
      </div>
    </>
  );
}
