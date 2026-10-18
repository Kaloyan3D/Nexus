import { CheckCircle2, ChevronDown, ChevronRight, CircleSlash, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { asUiError } from "../../lib/api";
import type { IntentRun, ModelConversationSummary } from "../../lib/contracts";
import { modelStateView } from "../../lib/modelRun";
import { countSteps, describeStep, nowLine, type StepTone } from "../../lib/progress";
import { KIND_BADGE, outcomeView, runKind, type RunKind } from "../../lib/runKind";
import { useNow } from "../../lib/useViewport";
import { MarkdownLite } from "../../lib/markdown";
import { useNexus } from "../../state/NexusContext";
import { Alert, Badge, Button, Loading, StatusDot, Tabs, type TabDef } from "../../components/ui/primitives";
import { ConversationPanel } from "../conversation/ConversationPanel";
import { useConversation } from "../conversation/useConversation";
import { CancelModelRunButton, InspectRunSection, ModelRunPanel, ToolCallsTable, useModelRunStatus } from "../conversation/ModelRunPanel";
import { ApprovalBanner } from "./ApprovalBanner";

const STEP_ICON: Record<StepTone, typeof CheckCircle2> = {
  done: CheckCircle2,
  active: Loader2,
  blocked: CircleSlash,
  failed: TriangleAlert,
  uncertain: TriangleAlert,
};

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function Steps({ run, limit }: { run: IntentRun; limit?: number }) {
  const steps = (run.toolActivity ?? []).map(describeStep);
  const shown = limit ? steps.slice(-limit) : steps;
  if (shown.length === 0) return <p className="nv-note">No tool has been proposed yet.</p>;
  return (
    <ul className="nv-steps" aria-label="Progress">
      {shown.map((s) => {
        const Icon = STEP_ICON[s.tone];
        return (
          <li key={s.key} className={`nv-step nv-step--${s.tone}`}>
            <Icon size={13} aria-hidden="true" /> <span>{s.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Header({ summary, record, status, reload, interactiveHeader }: { interactiveHeader?: boolean; summary: ModelConversationSummary; record: IntentRun | null; status: ReturnType<typeof useModelRunStatus>["status"]; reload: () => void }) {
  const kind = runKind(record);
  const state = record?.state ?? status?.state ?? summary.state;
  const terminal = record?.terminal ?? status?.terminal ?? summary.terminal;
  const v = modelStateView(state);
  const fixture = (status?.endpointKind ?? summary.endpointKind) !== "provider";
  const now = useNow(1000);
  const elapsed = !terminal && record ? Math.max(0, Math.round((now - record.createdAtMs) / 1000)) : null;
  return (
    <div className="nv-taskhead">
      <div className="nv-taskhead__meta">
        <Badge tone="purple">{KIND_BADGE[kind]}</Badge>
        {fixture && <Badge tone="warning">FIXTURE</Badge>}
        {record?.workspaceId && <Badge mono>{record.workspaceId}</Badge>}
        <span className="nv-mono nv-note">
          {summary.providerId ?? "?"} / {summary.remoteModelId ?? "?"}
        </span>
        <span className="nv-taskhead__spacer" />
        <Badge tone={v.tone} icon={<StatusDot tone={v.tone} pulse={v.pulse} />} title="Lifecycle: what the run did, not whether the task succeeded">
          {kind === "code" && state === "completed" ? (interactiveHeader ? "Completed" : "Model completed") : v.label}
        </Badge>
        {elapsed != null && <span className="nv-note">{clock(elapsed)}</span>}
        {status && <CancelModelRunButton status={status} onDone={reload} />}
      </div>
      <h1 className="nv-taskhead__title">{summary.firstPrompt.split("\n")[0]!.slice(0, 160) || "Model run"}</h1>
    </div>
  );
}

/** Apply the patch to the user's own folder: explicit, confirmed natively, never automatic. */
function AdoptButton({ run }: { run: IntentRun }) {
  const { api, runtimeState, projects, refreshProjects } = useNexus();
  const [state, setState] = useState<{ busy: boolean; msg: string | null; ok: boolean }>({ busy: false, msg: null, ok: false });
  const managed = projects.some((p) => p.projectId === run.workspaceId && p.managed);
  if (runtimeState?.mode !== "interactive" || !managed) return null;
  const adopt = async () => {
    setState({ busy: true, msg: null, ok: false });
    try {
      const r = await api.projectAdopt(run.runId);
      setState({ busy: false, ok: true, msg: `Applied ${r.applied.length} file${r.applied.length === 1 ? "" : "s"} to your folder. Nothing was committed.` });
      void refreshProjects(true);
    } catch (e) {
      const u = asUiError(e);
      setState({ busy: false, ok: false, msg: u.code === "cancelled" ? null : u.message });
    }
  };
  return (
    <>
      <Button size="sm" variant="primary" onClick={() => void adopt()} disabled={state.busy || state.ok}>
        {state.ok ? "Applied" : state.busy ? "Applying…" : "Apply to my folder…"}
      </Button>
      {state.msg && (
        <span className="nv-note" role="status">
          {state.msg}
        </span>
      )}
    </>
  );
}

function OutcomeCard({ run }: { run: IntentRun }) {
  const { openPanel, runtimeState } = useNexus();
  const interactive = runtimeState?.mode === "interactive";
  const v = outcomeView(run);
  if (!v) return null;
  const o = run.codingOutcome;
  const acts = run.toolActivity ?? [];
  const lastRun = [...acts].reverse().find((a) => a.tool === "proc_run" && a.status === "executed");
  const hasCmd = acts.some((a) => a.tool === "proc_run");
  const files = run.changedFiles ?? [];
  const hasDiff = files.length > 0 || (o?.editsApplied ?? 0) > 0;
  return (
    <section className={`nv-outcome nv-outcome--${v.tone}`} role="region" aria-label="Verified outcome">
      <div className="nv-outcome__head">{v.label}</div>
      {o && (
        <p className="nv-outcome__sub">
          Change: {o.change.replace(/-/g, " ")} · {o.editsApplied} applied, {o.editsNotApplied} not applied
          {files.length > 0 ? ` · ${files.length} file${files.length === 1 ? "" : "s"} changed` : ""}
          {" · "}
          {o.testsExecuted} command(s) executed, {o.testsNotExecuted} not executed
          {lastRun ? ` · ${lastRun.argsSummary}` : ""}
          {o.blockedByApproval > 0 ? ` · ${o.blockedByApproval} ${interactive ? "refused by policy" : "stopped at approval"}` : ""}
        </p>
      )}
      {o?.verification === "verified-passed" && (
        <p className="nv-note">A passing validation command is evidence that the command succeeded in the sandbox; it does not prove the whole task is correct. Review the changes.</p>
      )}
      {o?.verification !== "verified-passed" && <p className="nv-note">{v.detail}</p>}
      <div className="nv-outcome__actions">
        {hasDiff && (
          <Button size="sm" onClick={() => openPanel("diff")}>
            View diff
          </Button>
        )}
        {hasCmd && (
          <Button size="sm" onClick={() => openPanel("test")}>
            Test output
          </Button>
        )}
        <Button size="sm" onClick={() => openPanel("evidence")}>
          Execution evidence
        </Button>
        <Button size="sm" variant="ghost" onClick={() => openPanel("source")}>
          Source
        </Button>
        {hasDiff && o?.change === "applied" && <AdoptButton run={run} />}
      </div>
    </section>
  );
}

const DETAIL_TABS: TabDef[] = [
  { id: "timeline", label: "Timeline" },
  { id: "transcript", label: "Transcript" },
  { id: "toolcalls", label: "Tool calls" },
  { id: "runinfo", label: "Run info" },
];

function TranscriptTab({ id, follow, resetKey }: { id: string; follow: boolean; resetKey: string }) {
  const conv = useConversation(id, follow, resetKey);
  return <ConversationPanel state={conv} conversationId={id} />;
}

function Details({ summary, record }: { summary: ModelConversationSummary; record: IntentRun | null }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("timeline");
  const kind = runKind(record);
  return (
    <section className="nv-details" aria-label="Details">
      <div className="nv-details__row">
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)} icon={open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}>
          Details
        </Button>
        <span className="nv-note">Timeline · Transcript · Tool calls · Run info</span>
      </div>
      {open && (
        <>
          <Tabs tabs={DETAIL_TABS} value={tab} onChange={setTab} label="Detail views" />
          <div className="nv-details__body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === "timeline" && (record ? <Steps run={record} /> : <p className="nv-note">No tool activity is recorded for this run.</p>)}
            {tab === "transcript" && <TranscriptTab id={summary.conversationId} follow={!summary.terminal} resetKey={`${summary.conversationId}:${summary.state}`} />}
            {tab === "toolcalls" &&
              (record ? (kind === "code" ? <ToolCallsTable run={record} /> : <InspectRunSection run={record} />) : <p className="nv-note">No tool activity is recorded for this run.</p>)}
            {tab === "runinfo" && <ModelRunPanel conversationId={summary.conversationId} />}
          </div>
        </>
      )}
    </section>
  );
}

/** A code run that only looked: no file was proposed for change and nothing verified a change
 *  (read-only commands such as grep or ls do not make it a coding run). */
function isReview(run: IntentRun | null): boolean {
  if (!run || run.intentType !== "repo-code") return false;
  const acts = run.toolActivity ?? [];
  if (acts.length === 0) return false;
  if (acts.some((a) => a.tool === "fs_write" || a.tool === "fs_edit")) return false;
  const v = run.codingOutcome?.verification;
  return v === undefined || v === "no-test-executed";
}

function RecoveryNote({ run }: { run: IntentRun }) {
  const n = run.recoveries ?? 0;
  if (n === 0) return null;
  return (
    <p className="nv-note" role="status">
      Recovered from {n} interruption{n === 1 ? "" : "s"} on its own{run.lastRecovery ? ` (last: ${run.lastRecovery})` : ""}. Nothing completed so far was lost or repeated.
    </p>
  );
}

/** How this run relates to others and to the user's folder (continuation, automatic apply). */
function RunLinks({ run }: { run: IntentRun }) {
  const notes: string[] = [];
  if (run.continuationOf) notes.push("This run continues an earlier one that was interrupted; its changes were carried over.");
  if (run.continuedAs) notes.push("This run was interrupted. Nexus continued the task in a new run.");
  if (run.autoAdopt) notes.push(`Trusted workspace: ${run.autoAdopt}.`);
  if (notes.length === 0) return null;
  return (
    <div className="nv-note" role="status">
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );
}

/** The result of a read-only investigation: the report itself, not diagnostics about it. */
function ReviewReport({ run, text }: { run: IntentRun; text: string }) {
  const acts = run.toolActivity ?? [];
  const files = new Set(acts.filter((a) => a.tool === "fs_read").map((a) => a.argsSummary.replace(/^path=/, "").split(" ")[0]));
  const searches = acts.filter((a) => a.tool === "fs_search").length;
  return (
    <section className="nv-answer nv-answer--report" role="region" aria-label="Review report">
      <div className="nv-answer__label">
        Review report — {files.size} file{files.size === 1 ? "" : "s"} read, {searches} search{searches === 1 ? "" : "es"}, nothing changed
      </div>
      <RecoveryNote run={run} />
      {text.trim() ? <MarkdownLite text={text} /> : <p className="nv-note">The run ended without a written report. See Details for what it inspected.</p>}
    </section>
  );
}

function Answer({ text, kind, partial, interactive }: { text: string; kind: RunKind; partial: boolean; interactive?: boolean }) {
  if (!text.trim()) return null;
  const code = kind === "code";
  return (
    <section className={`nv-answer${code && !interactive ? " nv-answer--claim" : ""}`} aria-label={code ? "Model's summary" : "Answer"}>
      <div className="nv-answer__label">
        {code ? (interactive ? "Summary" : "Model's summary — a claim, not verified") : partial ? "Answer (streaming)" : kind === "inspect" ? "Answer — read-only, nothing was changed" : "Answer — text only, nothing was executed"}
      </div>
      <MarkdownLite text={text} />
    </section>
  );
}

/** The task-first view of one run, shaped by its state. Everything shown comes from the run record and receipts. */
export function TaskView({ summary }: { summary: ModelConversationSummary }) {
  const { runByConversation, runtimeState } = useNexus();
  const interactive = runtimeState?.mode === "interactive";
  const id = summary.conversationId;
  const record = runByConversation.get(id) ?? null;
  const { status, error, reload } = useModelRunStatus(id, !summary.terminal);
  const kind = runKind(record);
  const state = record?.state ?? status?.state ?? summary.state;
  const terminal = record?.terminal ?? status?.terminal ?? summary.terminal;
  const pending = record && !record.terminal ? record.pendingApproval ?? null : null;
  const { api } = useNexus();
  // The final answer of a finished coding run is the broker's recorded result: the model
  // conversation status only keeps the latest turn's text, which a nudge or a retry can blank.
  const [finalText, setFinalText] = useState<{ run: string; text: string } | null>(null);
  const runId = record?.runId ?? null;
  const wantResult = terminal && kind === "code" && runId !== null;
  useEffect(() => {
    if (!wantResult || !runId) return;
    let alive = true;
    api
      .intentResult(runId)
      .then((t) => alive && setFinalText({ run: runId, text: t }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, wantResult, runId]);
  const brokerText = finalText && finalText.run === runId ? finalText.text : "";
  const text = brokerText || (status?.text ?? "");
  return (
    <div className="nv-taskview">
      <Header summary={summary} record={record} status={status} reload={reload} interactiveHeader={interactive} />
      {error && <Alert tone="warning" title="Run status unavailable">{error}</Alert>}
      {pending && <ApprovalBanner approval={pending} />}
      {!terminal && (
        <section className="nv-runprogress" aria-label="Run progress" aria-live="polite">
          <div className="nv-runprogress__now">
            <Loader2 size={14} className="nv-spin" aria-hidden="true" /> <strong>Now:</strong> {nowLine(state, pending?.target ?? pending?.tool ?? null)}
            {record && (
              <span className="nv-note nv-runprogress__turn">
                turn {record.turn ?? 0} of {record.maxTurns ?? "—"}
              </span>
            )}
          </div>
          {record && <Steps run={record} limit={6} />}
          {record && (
            <p className="nv-note">
              {(() => {
                const c = countSteps(record.toolActivity ?? []);
                return `${c.reads} read(s) · ${c.edits} edit(s) proposed · ${c.commands} command(s) proposed`;
              })()}
            </p>
          )}
          {record && <RecoveryNote run={record} />}
          {kind !== "code" && <Answer text={text} kind={kind} partial />}
        </section>
      )}
      {record && kind === "code" && <RunLinks run={record} />}
      {terminal && interactive && kind === "code" && isReview(record) && record && <ReviewReport run={record} text={text} />}
      {terminal && kind === "code" && record && !(interactive && isReview(record)) && <OutcomeCard run={record} />}
      {terminal && kind === "code" && record && !(interactive && isReview(record)) && <RecoveryNote run={record} />}
      {terminal && status?.state === "uncertain" && (
        <Alert tone="warning" title="Submission outcome is uncertain">
          The request may have been processed and billed. Nexus never re-sends it automatically.
        </Alert>
      )}
      {terminal && status?.errorCode && status.state !== "completed" && (
        <Alert tone="error" title={`Run ended: ${status.errorCode}`}>
          See the transcript under Details for the recorded explanation.
        </Alert>
      )}
      {terminal && !(interactive && kind === "code" && isReview(record)) && <Answer text={text} kind={kind} partial={false} interactive={interactive} />}
      {terminal && kind === "inspect" && record && (record.citationsVerified?.length ?? 0) + (record.citationsUnverified?.length ?? 0) > 0 && (
        <dl className="nv-kv">
          <dt>Supported references</dt>
          <dd className="nv-mono">{(record.citationsVerified ?? []).join(", ") || "—"}</dd>
          <dt>Unsupported references</dt>
          <dd className="nv-mono">{(record.citationsUnverified ?? []).join(", ") || "—"}</dd>
        </dl>
      )}
      {terminal && kind === "code" && record && (record.changedFiles?.length ?? 0) > 0 && (
        <ul className="nv-list" aria-label="Changed files">
          {record.changedFiles!.map((f) => (
            <li key={f.path} className="nv-mono">
              {f.status} {f.path} {f.additions != null ? `+${f.additions}` : ""} {f.deletions != null ? `-${f.deletions}` : ""}
            </li>
          ))}
        </ul>
      )}
      {!status && !error && <Loading label="Reading the run record…" />}
      <Details summary={summary} record={record} />
    </div>
  );
}

