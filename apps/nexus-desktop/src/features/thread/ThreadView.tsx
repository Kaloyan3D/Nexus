import { EngineActivity } from "../engine/EngineActivity";
import { Archive, CheckCircle2, ChevronDown, ChevronRight, CircleSlash, FileText, Loader2, Lock, Plus, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { IntentRun, ThreadDetail, ThreadFinding, ThreadMessage, ThreadRunView } from "../../lib/contracts";
import { relativeTime } from "../../lib/format";
import { MarkdownLite } from "../../lib/markdown";
import { modelStateView } from "../../lib/modelRun";
import { countSteps, describeStep, nowLine, type StepTone } from "../../lib/progress";
import { outcomeView } from "../../lib/runKind";
import { stickToBottom, useNow } from "../../lib/useViewport";
import { Alert, Badge, Button, Loading, StatusDot } from "../../components/ui/primitives";
import { useNexus } from "../../state/NexusContext";
import { AdoptButton } from "../task/TaskView";
import { ThreadComposer } from "./ThreadComposer";
import { useThread } from "./useThread";

const STEP_ICON: Record<StepTone, typeof CheckCircle2> = {
  done: CheckCircle2,
  active: Loader2,
  blocked: CircleSlash,
  failed: TriangleAlert,
  uncertain: TriangleAlert,
};

const WORKSPACE_LABEL: Record<string, string> = {
  continued: "Continues the conversation's workspace",
  rebased: "Continues the workspace on your updated project",
  fresh: "Started from the project's files",
  "fresh-by-choice": "Started from your project's current files, as you chose",
};

function Steps({ run, limit }: { run: IntentRun; limit?: number }) {
  const steps = (run.toolActivity ?? []).map(describeStep);
  const shown = limit ? steps.slice(-limit) : steps;
  if (shown.length === 0) return <p className="nv-note">No tool has been used yet.</p>;
  return (
    <ul className="nv-steps" aria-label="Tool activity">
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

/** What the runtime verified about THIS run (its receipts) - never the conversation's state. */
function evidenceBadge(r: ThreadRunView): { label: string; tone: "success" | "warning" | "error" | "neutral"; detail: string } | null {
  const run = r.run;
  if (!run) return null;
  if (r.readOnly) {
    const wrote = (run.toolActivity ?? []).some((a) => (a.tool === "fs_write" || a.tool === "fs_edit") && a.status === "executed");
    const tried = (run.toolActivity ?? []).filter((a) => (a.tool === "fs_write" || a.tool === "fs_edit") && a.status === "refused").length;
    if (wrote) return { label: "Read-only run changed a file — report this", tone: "error", detail: "The runtime recorded an executed edit in a read-only run." };
    return {
      label: tried > 0 ? `Read-only · ${tried} edit attempt${tried === 1 ? "" : "s"} refused · no file changed` : "Read-only · no file changed",
      tone: "success",
      detail: "The runtime refuses every edit and write in a read-only request.",
    };
  }
  // The task asked for an implementation: say what the runtime found, not what the model said.
  if (run.completion === "incomplete") {
    const kept = run.codingOutcome?.editsApplied ?? 0;
    return {
      label: kept > 0 ? `Incomplete · ${kept} change${kept === 1 ? "" : "s"} kept, work not finished` : "Incomplete · nothing changed, nothing verified",
      tone: "warning",
      detail: run.completionNote ?? "The model ended before finishing the work.",
    };
  }
  if (run.completion === "failing-checks") {
    const n = run.unresolvedFailedChecks ?? run.codingOutcome?.checksFailedUnresolved ?? 0;
    return {
      label: `Changes made · ${n || "some"} check${n === 1 ? "" : "s"} failed, not verified`,
      tone: "warning",
      detail: run.completionNote ?? "Verification commands failed and were never re-run successfully; the change is blocked or unverified, not passed.",
    };
  }
  if (run.completion === "no-change-reported") {
    return { label: "Completed · no change was made", tone: "warning", detail: "The request asked for an implementation, but no file was changed and no check ran. Read the answer to see why." };
  }
  if (run.completion === "no-change-verified") {
    return { label: "No change needed · checks passed", tone: "success", detail: "Nothing was changed; the relevant check passed (a verified no-op)." };
  }
  const v = outcomeView(run);
  return v ? { label: v.label, tone: v.tone, detail: v.detail } : null;
}

function RunBlock({ r, isLast, detail }: { r: ThreadRunView; isLast: boolean; detail: ThreadDetail }) {
  const { openPanel, api, refreshThreads } = useNexus();
  const [resumeError, setResumeError] = useState<string | null>(null);
  const resumeRun = async (id: string) => {
    setResumeError(null);
    try {
      await api.intentResume(id);
      await refreshThreads();
    } catch (e) {
      setResumeError((e as { message?: string })?.message ?? "Could not resume.");
    }
  };
  const run = r.run;
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const v = modelStateView(run?.stopReason === "no-implementation" ? "incomplete" : (run?.state ?? r.state));
  const live = run !== null && !run.terminal;
  const ev = evidenceBadge(r);
  const files = run?.changedFiles ?? [];
  const hasCmd = (run?.toolActivity ?? []).some((a) => a.tool === "proc_run");
  const ownEdits = r.digest?.editsApplied ?? run?.codingOutcome?.editsApplied ?? 0;
  const elapsed = live && run ? Math.max(0, Math.round((now - run.createdAtMs) / 1000)) : null;
  const steps = run?.toolActivity ?? [];
  const note = run?.workspaceRelation ? (WORKSPACE_LABEL[run.workspaceRelation] ?? null) : null;
  return (
    <section className="nv-run" aria-label={`Run ${r.n}`}>
      <div className="nv-run__head">
        <span className="nv-run__n">Run {r.n}</span>
        <Badge tone={r.readOnly ? "neutral" : "purple"} icon={r.readOnly ? <Lock size={11} aria-hidden="true" /> : undefined} title={r.modeReason}>
          {r.readOnly ? "Read-only" : "Can change files"}
        </Badge>
        <Badge tone={v.tone} icon={<StatusDot tone={v.tone} pulse={v.pulse} />} title="What this run did (lifecycle), not whether the task succeeded">
          {v.label}
        </Badge>
        {ev && (
          <Badge tone={ev.tone} title={ev.detail}>
            {ev.label}
          </Badge>
        )}
        {run && (run.providerId || run.remoteModelId) && (
          <Badge mono title={run.routeId ? `Route ${run.routeId}: the model and route this run used` : "The model this run used"}>
            {run.providerId ?? "?"} / {run.remoteModelId ?? "?"}{run.routeId ? ` · route ${run.routeId}` : ""}
          </Badge>
        )}
        {r.context && (
          <Badge title={`The conversation's memory given to the model when this run started · sha256 ${r.context.sha256.slice(0, 12)}…`}>
            Memory: {r.context.priorRuns} earlier run{r.context.priorRuns === 1 ? "" : "s"}
            {r.context.findings > 0 ? `, ${r.context.findings} finding${r.context.findings === 1 ? "" : "s"}` : ""} · {Math.max(1, Math.round(r.context.bytes / 1024))} KB
          </Badge>
        )}
        {elapsed != null && <span className="nv-note">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</span>}
      </div>
      {run?.completion === "failing-checks" && ev && (
        <p className="nv-note" role="note">
          {ev.detail}
        </p>
      )}
      {note && (
        <p className="nv-note nv-run__ws" title={run?.workspaceNote ?? undefined}>
          {note}
          {run?.workspaceNote ? ` — ${run.workspaceNote}` : ""}
        </p>
      )}
      {run && <EngineActivity runId={run.runId} live={live} />}
      {isLast && !live && run && !r.readOnly && ["cancelled", "failed", "interrupted", "recovered"].includes(run.state) && (
        <div className="nv-run__actions">
          <Button size="sm" onClick={() => void resumeRun(run.runId)} title="Continue from this run's work in a new run (the broker refuses if the conversation moved on)">
            Resume
          </Button>
          {resumeError && <span className="nv-note" role="alert">{resumeError}</span>}
        </div>
      )}
      {live && run && (
        <section className="nv-runprogress" aria-label="Run progress" aria-live="polite">
          <div className="nv-runprogress__now">
            <Loader2 size={14} className="nv-spin" aria-hidden="true" /> <strong>Now:</strong> {nowLine(run.state, run.pendingApproval?.target ?? null)}
            <span className="nv-note nv-runprogress__turn">
              turn {run.turn ?? 0} of {run.maxTurns ?? "—"}
            </span>
          </div>
          <Steps run={run} limit={6} />
          <p className="nv-note">
            {(() => {
              const c = countSteps(steps);
              return `${c.reads} read(s) · ${c.edits} edit(s) · ${c.commands} command(s)`;
            })()}
            {(run.recoveries ?? 0) > 0 ? ` · recovered from ${run.recoveries} interruption(s) on its own` : ""}
          </p>
        </section>
      )}
      {!live && run && steps.length > 0 && (
        <div className="nv-run__steps">
          <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)} icon={open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}>
            {steps.length} step{steps.length === 1 ? "" : "s"}
            {ownEdits > 0 ? ` · ${ownEdits} edit${ownEdits === 1 ? "" : "s"}` : ""}
          </Button>
          {open && <Steps run={run} />}
        </div>
      )}
      {!live && run && (files.length > 0 || hasCmd || ownEdits > 0) && !r.readOnly && (
        <div className="nv-run__actions">
          {files.length > 0 && (
            <Button size="sm" onClick={() => openPanel("diff", run)}>
              View diff · {files.length} file{files.length === 1 ? "" : "s"}
            </Button>
          )}
          {hasCmd && (
            <Button size="sm" onClick={() => openPanel("test", run)}>
              Test output
            </Button>
          )}
          <Button size="sm" onClick={() => openPanel("evidence", run)}>
            Execution evidence
          </Button>
          {isLatestWithChanges(detail, r) && run.codingOutcome?.change === "applied" && <AdoptButton run={run} />}
        </div>
      )}
      {!live && run && r.readOnly && (
        <div className="nv-run__actions">
          <Button size="sm" variant="ghost" onClick={() => openPanel("evidence", run)}>
            Execution evidence
          </Button>
        </div>
      )}
      {isLast && !live && run?.autoAdopt && <p className="nv-note">Trusted workspace: {run.autoAdopt}.</p>}
    </section>
  );
}

/** The cumulative patch is the one of the newest run that holds the conversation's workspace. */
function isLatestWithChanges(detail: ThreadDetail, r: ThreadRunView): boolean {
  const withCopy = [...detail.runs].reverse().find((x) => x.run && (x.run.changedFiles?.length ?? 0) > 0);
  return withCopy?.runId === r.runId;
}

function Bubble({ m, who }: { m: ThreadMessage; who: "you" | "nexus" }) {
  return (
    <article className={`nv-msgbubble nv-msgbubble--${who}`} aria-label={who === "you" ? "You" : "Nexus"}>
      <header className="nv-msgbubble__meta">
        <strong>{who === "you" ? "You" : "Nexus"}</strong>
        <span className="nv-note">{relativeTime(new Date(m.atMs).toISOString())}</span>
      </header>
      {who === "you" ? <p className="nv-msgbubble__text">{m.text}</p> : <MarkdownLite text={m.text} />}
      {m.truncated && <p className="nv-note">Shortened for display.</p>}
    </article>
  );
}

function FindingsBar({ findings }: { findings: ThreadFinding[] }) {
  const [open, setOpen] = useState(false);
  if (findings.length === 0) return null;
  const addressed = findings.filter((f) => f.addressedIn != null).length;
  return (
    <section className="nv-findings" aria-label="Findings">
      <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)} icon={open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}>
        <FileText size={13} aria-hidden="true" /> {findings.length} finding{findings.length === 1 ? "" : "s"} remembered · {addressed} addressed
      </Button>
      <span className="nv-note">Refer to them by number (F1, F2…) in your next message.</span>
      {open && (
        <ul className="nv-findings__list">
          {findings.map((f) => (
            <li key={f.id}>
              <Badge mono>{f.id}</Badge> <strong>{f.title}</strong>{" "}
              {f.addressedIn != null ? (
                <Badge tone={f.addressedVerification === "verified-passed" ? "success" : "warning"} title="From the run's receipts">
                  addressed in run {f.addressedIn}
                  {f.addressedVerification ? ` · ${f.addressedVerification.replace(/-/g, " ")}` : ""}
                </Badge>
              ) : (
                <Badge>open</Badge>
              )}
              {f.detail && <p className="nv-note">{f.detail}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One persistent conversation: requests, runs and answers in chronological order, then the composer. */
export function ThreadView({ threadId }: { threadId: string }) {
  const { threads, projects, intentCodeSources, newConversation, api, refreshThreads } = useNexus();
  const stamp = threads.find((t) => t.threadId === threadId)?.updatedAtMs ?? 0;
  const { detail, error, reload } = useThread(threadId, stamp);
  const logRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const tail = detail ? `${detail.messages.length}:${detail.runs.map((r) => `${r.state}${r.run?.toolActivity?.length ?? 0}`).join(",")}` : "";
  useEffect(() => {
    const el = logRef.current?.closest(".nv-thread") as HTMLElement | null;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [tail]);
  const byRun = useMemo(() => {
    const m = new Map<number, ThreadMessage>();
    for (const x of detail?.messages ?? []) m.set(x.seq, x);
    return m;
  }, [detail]);
  if (error && !detail) {
    return (
      <div className="nv-page nv-narrow nv-thread">
        <Button variant="ghost" size="sm" onClick={newConversation} icon={<Plus size={14} />}>
          New conversation
        </Button>
        <Alert tone="warning" title="Conversation unavailable">
          {error.message}
        </Alert>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="nv-page nv-narrow nv-thread">
        <Loading label="Opening the conversation…" />
      </div>
    );
  }
  const t = detail.thread;
  const project = projects.find((p) => p.projectId === t.projectId)?.label ?? intentCodeSources?.find((s) => s.sourceId === t.projectId)?.label ?? t.projectId;
  const lastRun = detail.runs[detail.runs.length - 1];
  const state = t.active ? "Working" : lastRun ? "Ready for your next message" : "No messages yet";
  const archive = async () => {
    try {
      await api.threadUpdate(t.threadId, { archived: true });
      await refreshThreads();
      newConversation();
    } catch {
      /* the broker refused (a run is in progress); the header still shows it */
    }
  };
  return (
    <div className="nv-page nv-narrow nv-thread" onScroll={(e) => (pinned.current = stickToBottom(e.currentTarget, 80))}>
      <div className="nv-thread__top">
        <Button variant="ghost" size="sm" onClick={newConversation} icon={<Plus size={14} />}>
          New conversation
        </Button>
        <span className="nv-taskhead__spacer" />
        <Badge mono title="The project this conversation belongs to">
          {project}
        </Badge>
        <Badge tone={t.active ? "purple" : "neutral"} icon={<StatusDot tone={t.active ? "purple" : "neutral"} pulse={t.active} />} title="The conversation's state; each run below has its own status">
          {state}
        </Badge>
        <Button variant="ghost" size="sm" onClick={() => void archive()} disabled={t.active} aria-label="Archive conversation" icon={<Archive size={14} />} />
      </div>
      <h1 className="nv-taskhead__title">{t.title || "Conversation"}</h1>
      {t.target && (
        <p className="nv-note" aria-label="Conversation model">
          Runs on {t.target.providerId} / {t.target.remoteModelId}
          {t.target.routeId ? ` · route ${t.target.routeId}` : ""}.
        </p>
      )}
      {t.legacy && <p className="nv-note">Recorded before conversations existed; you can continue it from here.</p>}
      <FindingsBar findings={detail.findings} />
      <div className="nv-thread__log" ref={logRef} role="log" aria-label="Conversation">
        {detail.runs.map((r, i) => {
          const user = r.userSeq != null ? byRun.get(r.userSeq) : undefined;
          const ans = r.assistantSeq != null ? byRun.get(r.assistantSeq) : undefined;
          const notes = detail.messages.filter((m) => m.kind === "note" && m.runId === r.runId);
          return (
            <div key={r.runId} className="nv-turn">
              {user ? <Bubble m={user} who="you" /> : <p className="nv-note nv-turn__auto">Nexus continued the previous run automatically.</p>}
              <RunBlock r={r} isLast={i === detail.runs.length - 1} detail={detail} />
              {ans && <Bubble m={ans} who="nexus" />}
              {!ans && r.ended && !notes.length && r.state === "completed" && <p className="nv-note">The run finished without a written answer.</p>}
              {notes.map((n) => (
                <Alert key={n.seq} tone={r.state === "completed" ? "info" : "warning"} title={`Run ${r.n}`}>
                  {n.text}
                </Alert>
              ))}
            </div>
          );
        })}
        {detail.runs.length === 0 && <p className="nv-note">Ask a question about the project, or describe what to change. Nexus remembers everything said here.</p>}
      </div>
      <ThreadComposer key={t.threadId} detail={detail} onSent={reload} />
    </div>
  );
}
