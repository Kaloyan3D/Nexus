import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  FlaskConical,
  Flag,
  GitCommitHorizontal,
  Layers,
  MessageSquare,
  PlayCircle,
  ScrollText,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { JournalResult, TaskRecord } from "../../lib/contracts";
import { absoluteTime, parseUtc } from "../../lib/format";
import { taskStatusView } from "../../lib/status";
import { stickToBottom } from "../../lib/useViewport";
import { asUiError } from "../../lib/api";
import { useNexus } from "../../state/NexusContext";
import { ConversationPanel } from "../conversation/ConversationPanel";
import { useConversation } from "../conversation/useConversation";
import { streamedText, type MockRun } from "../../state/mockRuns";
import { Alert, Badge, CheckRow, CodeBlock, EmptyState, Loading, Tabs, type TabDef } from "../../components/ui/primitives";
import { Timeline, type TimelineItem } from "../../components/ui/Timeline";

const TABS: TabDef[] = [
  { id: "conversation", label: "Conversation" },
  { id: "activity", label: "Activity" },
  { id: "files", label: "Files", hint: "No file data source in Client API v1" },
  { id: "terminal", label: "Terminal", hint: "Terminal execution is not available (no shell tool)" },
  { id: "preview", label: "Preview", hint: "No preview data source in Client API v1" },
  { id: "logs", label: "Logs" },
  { id: "verification", label: "Verification" },
];

const UNAVAILABLE: Record<string, string> = {
  files:
    "Nexus can only show files that Controller records associate with a task. Client API v1 exposes no file or diff data, so this view is unavailable rather than guessed.",
  terminal:
    "Unrestricted shell and terminal execution is deliberately not part of the native runtime. Mock output appears under Activity and Logs.",
  preview: "No preview data source exists in Client API v1.",
};

export function ActivityPanel() {
  const { selectedTask, selectedMock } = useNexus();
  const conversationId = selectedMock
    ? selectedMock.conversationId
    : (selectedTask?.taskInstanceId ?? null);
  const selKey = selectedMock ? `m:${selectedMock.key}` : selectedTask ? `t:${selectedTask.taskId}` : "";
  const follow = selectedMock?.status === "running";
  const conv = useConversation(conversationId, follow, selKey + (selectedMock?.status ?? ""));
  const [pick, setPick] = useState<{ key: string; tab: string } | null>(null);
  // Conversation is the default view only when recorded messages exist.
  const preferred = conv.view?.available ? "conversation" : "activity";
  const tab = pick && pick.key === selKey ? pick.tab : preferred;
  const hasSelection = Boolean(selectedTask || selectedMock);
  return (
    <section className="nv-activity" aria-label="Engineering activity">
      <Tabs
        tabs={TABS}
        value={tab}
        onChange={(t) => setPick({ key: selKey, tab: t })}
        label="Activity views"
      />
      <div className="nv-activity__body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {!hasSelection ? (
          <EmptyState icon={ScrollText} title="Nothing selected">
            Select a task from Recent Tasks, or enter a prompt and choose Run Mock to see its
            conversation and activity here.
          </EmptyState>
        ) : tab === "conversation" ? (
          conversationId ? (
            <ConversationPanel state={conv} conversationId={conversationId} />
          ) : (
            <EmptyState icon={ScrollText} title="Conversation history was not recorded for this task.">
              The Controller ledger entry has no task instance id to join against, and Nexus never joins on
              display ids alone.
            </EmptyState>
          )
        ) : tab === "activity" ? (
          selectedMock ? <MockActivity run={selectedMock} /> : <TaskActivity task={selectedTask!} />
        ) : tab === "logs" ? (
          selectedMock ? <MockLogs run={selectedMock} /> : <TaskLogs task={selectedTask!} />
        ) : tab === "verification" ? (
          <VerificationTab />
        ) : (
          <EmptyState icon={Layers} title={`${TABS.find((t) => t.id === tab)?.label} unavailable`}>
            {UNAVAILABLE[tab]}
          </EmptyState>
        )}
      </div>
    </section>
  );
}

function VerificationTab() {
  const { selectedTask, selectedMock } = useNexus();
  type Row = { name: string; status: "pass" | "fail" | "unknown"; detail?: string };
  let rows: Row[] = [];
  if (selectedMock?.result) {
    rows = selectedMock.result.checks.map((c) => ({ name: c.label, status: c.status, detail: c.detail }));
  } else if (selectedTask) {
    const req = selectedTask.verificationRequired;
    const out = selectedTask.verificationOutcomes;
    rows = [
      ...req.map((n) => ({ name: n, status: out.find((o) => o.name === n)?.status ?? ("unknown" as const) })),
      ...out.filter((o) => !req.includes(o.name)).map((o) => ({ name: o.name, status: o.status })),
    ];
  }
  if (rows.length === 0)
    return (
      <EmptyState icon={ScrollText} title="No verification records">
        No checks are required or recorded for this selection.
      </EmptyState>
    );
  return (
    <div className="nv-scroll">
      {rows.map((r) => (
        <CheckRow key={r.name} label={r.name} status={r.status} detail={r.detail} />
      ))}
    </div>
  );
}

/* ---------- authoritative task ---------- */

export function useJournal(task: TaskRecord | null) {
  const { api, runtime } = useNexus();
  const id = task?.taskInstanceId ?? null;
  const active = id !== null && runtime?.connection === "connected";
  const [result, setResult] = useState<{
    forId: string;
    data: JournalResult | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!active || id === null) return;
    let alive = true;
    api
      .taskJournal(id)
      .then((data) => alive && setResult({ forId: id, data, error: null }))
      .catch((e) => alive && setResult({ forId: id, data: null, error: asUiError(e).message }));
    return () => {
      alive = false;
    };
  }, [api, id, active]);
  if (!active || id === null) return { data: null, error: null, loading: false };
  if (!result || result.forId !== id) return { data: null, error: null, loading: true };
  return { data: result.data, error: result.error, loading: false };
}

function TaskActivity({ task }: { task: TaskRecord }) {
  const journal = useJournal(task);
  const v = taskStatusView(task.status);
  const items = useMemo<TimelineItem[]>(() => {
    const out: Array<TimelineItem & { at: number }> = [];
    const at = (iso: string | null, fallback: number) => parseUtc(iso) ?? fallback;
    out.push({
      key: "created",
      at: at(task.createdAtUtc, 0),
      icon: PlayCircle,
      tone: "neutral",
      title: "Task created in the Controller ledger",
      time: absoluteTime(task.createdAtUtc),
      body: (
        <span>
          Bound engine <code>{task.boundEngine ?? "—"}</code> · class{" "}
          <code>{task.executionClass ?? "—"}</code> · risk <code>{task.risk ?? "—"}</code>
        </span>
      ),
    });
    if (task.updatedAtUtc && task.updatedAtUtc !== task.createdAtUtc) {
      out.push({
        key: "status",
        at: at(task.updatedAtUtc, 1),
        icon: v.tone === "error" ? XCircle : v.tone === "success" ? CheckCircle2 : CircleDot,
        tone: v.tone,
        title: (
          <>
            Ledger status: <strong>{v.label}</strong>
          </>
        ),
        time: absoluteTime(task.updatedAtUtc),
        body:
          task.attempt !== null ? (
            <span>
              Attempt {task.attempt} of {task.maxAttempts ?? "?"}
            </span>
          ) : undefined,
      });
    }
    for (const sig of task.failureSignatures) {
      out.push({
        key: `fail-${sig}`,
        at: at(task.updatedAtUtc, 2),
        icon: AlertTriangle,
        tone: "error",
        title: "Failure signature",
        body: <code>{sig}</code>,
      });
    }
    if (task.completedAtUtc) {
      out.push({
        key: "completed",
        at: at(task.completedAtUtc, 3),
        icon: Flag,
        tone: "success",
        title: "Completed",
        time: absoluteTime(task.completedAtUtc),
      });
    }
    for (const e of journal.data?.events ?? []) {
      out.push({
        key: `j-${e.seq}`,
        at: at(e.recordedAtUtc, 4),
        icon: GitCommitHorizontal,
        tone: "purple",
        title: (
          <>
            Kernel event <code>{e.kind}</code>
          </>
        ),
        time: absoluteTime(e.recordedAtUtc),
        body: e.payload ? <CodeBlock wrap>{e.payload}</CodeBlock> : undefined,
      });
    }
    return out.sort((a, b) => a.at - b.at);
  }, [task, journal.data, v]);

  return (
    <div className="nv-scroll">
      {task.description && (
        <div className="nv-prompt-card">
          <div className="nv-prompt-card__label">Task description</div>
          <div className="nv-prompt-card__text">{task.description.slice(0, 600)}
            {task.description.length > 600 ? "…" : ""}</div>
        </div>
      )}
      <Timeline items={items} label="Task activity" />
      {journal.loading && <Loading label="Reading kernel journal…" />}
      {journal.error && (
        <Alert tone="warning" title="Kernel journal unavailable">
          {journal.error}
        </Alert>
      )}
      {!journal.loading && !journal.error && task.taskInstanceId && journal.data && journal.data.events.length === 0 && (
        <p className="nv-note">The kernel journal holds no events for this task instance.</p>
      )}
      <p className="nv-note">
        Only recorded facts are shown. Model output, tool calls and per-attempt telemetry are not
        part of the Controller ledger.
      </p>
    </div>
  );
}

function TaskLogs({ task }: { task: TaskRecord }) {
  const journal = useJournal(task);
  if (journal.loading) return <Loading label="Reading kernel journal…" />;
  if (journal.error)
    return (
      <Alert tone="warning" title="Kernel journal unavailable">
        {journal.error}
      </Alert>
    );
  const events = journal.data?.events ?? [];
  if (events.length === 0)
    return (
      <EmptyState icon={ScrollText} title="No journal entries">
        The daemon journal has no events for this task instance
        {task.taskInstanceId ? "." : ", and the ledger record carries no instance id."}
      </EmptyState>
    );
  const text = events
    .map((e) => `#${e.seq} ${e.recordedAtUtc ?? ""} ${e.kind}${e.commandId ? ` ${e.commandId}` : ""}\n  ${e.payload}`)
    .join("\n");
  return (
    <div className="nv-scroll">
      <CodeBlock title="Kernel journal (read-only)">{text}</CodeBlock>
    </div>
  );
}

/* ---------- mock run ---------- */

function MockActivity({ run }: { run: MockRun }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const text = streamedText(run);
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [run.steps.length, run.stream.length, run.status]);

  const items: TimelineItem[] = [
    {
      key: "prompt",
      icon: MessageSquare,
      title: "Prompt submitted",
      badge: <Badge tone="warning">MOCK</Badge>,
      time: absoluteTime(new Date(run.startedAtMs).toISOString()),
      body: <div className="nv-prose">{run.prompt}</div>,
    },
    ...run.steps.map<TimelineItem>((s) => ({
      key: `step-${s.id}`,
      icon: CheckCircle2,
      tone: "success",
      title: s.label,
    })),
  ];
  if (text || run.status === "running") {
    items.push({
      key: "stream",
      icon: FlaskConical,
      tone: "purple",
      title: "Mock provider stream",
      body: text ? (
        <div className="nv-prose">
          {text}
          {run.status === "running" && <span className="nv-caret" aria-hidden="true" />}
        </div>
      ) : (
        <Loading label="Waiting for stream…" />
      ),
    });
  }
  if (run.status === "done" && run.result) {
    const r = run.result;
    items.push({
      key: "result",
      icon: Flag,
      tone: "success",
      title: "Mock run completed",
      time: `${r.durationMs} ms`,
      body: (
        <div className="nv-stack">
          <div className="nv-note" style={{ margin: 0 }}>
            Finish reason <code>{r.finishReason}</code> · usage in/out {r.usageInput}/{r.usageOutput}{" "}
            · {r.eventCount} events
          </div>
          {r.checks.map((c) => (
            <CheckRow key={c.id} label={c.label} status={c.status} detail={c.detail} />
          ))}
        </div>
      ),
    });
  }
  if (run.status === "failed" && run.error) {
    items.push({
      key: "error",
      icon: XCircle,
      tone: "error",
      title: "Mock run failed",
      body: (
        <Alert tone="error" title={run.error.code}>
          {run.error.message}
        </Alert>
      ),
    });
  }
  return (
    <div
      className="nv-scroll"
      ref={scroller}
      onScroll={() => (pinned.current = stickToBottom(scroller.current))}
    >
      <Timeline items={items} label="Mock run activity" />
      <p className="nv-note">
        This run executed in an isolated throwaway kernel against a loopback mock provider. It is
        not recorded in the Controller ledger or the daemon store.
      </p>
    </div>
  );
}

function MockLogs({ run }: { run: MockRun }) {
  const lines = [
    `# mock run ${run.result?.runId ?? run.key} ${run.status}`,
    ...run.steps.map((s) => `step    ${s.id}: ${s.label}`),
    ...run.stream.map((f) => `stream  #${f.index} ${f.kind}: ${JSON.stringify(f.content)}`),
    ...(run.result
      ? [
          `attempt ${run.result.attemptId}`,
          `command ${run.result.commandId}`,
          `digest  ${run.result.requestDigest}`,
          `finish  ${run.result.finishReason}`,
        ]
      : []),
    ...(run.error ? [`error   ${run.error.code}: ${run.error.message}`] : []),
  ].join("\n");
  return (
    <div className="nv-scroll">
      <CodeBlock title="Mock run log" wrap>
        {lines}
      </CodeBlock>
    </div>
  );
}
