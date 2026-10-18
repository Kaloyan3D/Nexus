import { CheckCircle2, ChevronDown, ChevronRight, CircleSlash, Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";
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

function Header({ summary, record, status, reload }: { summary: ModelConversationSummary; record: IntentRun | null; status: ReturnType<typeof useModelRunStatus>["status"]; reload: () => void }) {
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
          {kind === "code" && state === "completed" ? "Model completed" : v.label}
        </Badge>
        {elapsed != null && <span className="nv-note">{clock(elapsed)}</span>}
        {status && <CancelModelRunButton status={status} onDone={reload} />}
      </div>
      <h1 className="nv-taskhead__title">{summary.firstPrompt.split("\n")[0]!.slice(0, 160) || "Model run"}</h1>
    </div>
  );
}

function OutcomeCard({ run }: { run: IntentRun }) {
  const { openPanel } = useNexus();
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
          {o.blockedByApproval > 0 ? ` · ${o.blockedByApproval} stopped at approval` : ""}
        </p>
      )}
      {o?.verification === "verified-passed" && (
        <p className="nv-note">A passing validation command is evidence that the command succeeded in the sandbox (network off); it does not prove the whole task is correct. Review the changes.</p>
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

function Answer({ text, kind, partial }: { text: string; kind: RunKind; partial: boolean }) {
  if (!text.trim()) return null;
  const code = kind === "code";
  return (
    <section className={`nv-answer${code ? " nv-answer--claim" : ""}`} aria-label={code ? "Model's summary" : "Answer"}>
      <div className="nv-answer__label">
        {code ? "Model's summary — a claim, not verified" : partial ? "Answer (streaming)" : kind === "inspect" ? "Answer — read-only, nothing was changed" : "Answer — text only, nothing was executed"}
      </div>
      <MarkdownLite text={text} />
    </section>
  );
}

/** The task-first view of one run, shaped by its state. Everything shown comes from the run record and receipts. */
export function TaskView({ summary }: { summary: ModelConversationSummary }) {
  const { runByConversation } = useNexus();
  const id = summary.conversationId;
  const record = runByConversation.get(id) ?? null;
  const { status, error, reload } = useModelRunStatus(id, !summary.terminal);
  const kind = runKind(record);
  const state = record?.state ?? status?.state ?? summary.state;
  const terminal = record?.terminal ?? status?.terminal ?? summary.terminal;
  const pending = record && !record.terminal ? record.pendingApproval ?? null : null;
  const text = status?.text ?? "";
  return (
    <div className="nv-taskview">
      <Header summary={summary} record={record} status={status} reload={reload} />
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
          {kind !== "code" && <Answer text={text} kind={kind} partial />}
        </section>
      )}
      {terminal && kind === "code" && record && <OutcomeCard run={record} />}
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
      {terminal && <Answer text={text} kind={kind} partial={false} />}
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

