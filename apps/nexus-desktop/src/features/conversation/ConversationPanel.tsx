import {
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  Layers,
  MessageSquare,
  RefreshCw,
  ArrowDown,
  ShieldAlert,
  Terminal,
  User,
  Wrench,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { asUiError } from "../../lib/api";
import type {
  AttemptProvenance,
  ModelIoView,
  Speaker,
  TranscriptEvent,
} from "../../lib/contracts";
import { absoluteTime } from "../../lib/format";
import { MarkdownLite } from "../../lib/markdown";
import { stickToBottom } from "../../lib/useViewport";
import { useNexus } from "../../state/NexusContext";
import { Alert, Badge, Button, EmptyState, Loading } from "../../components/ui/primitives";
import type { ConversationState } from "./useConversation";

const COLLAPSE_AT = 1400;
const INITIAL_VISIBLE = 120;

/* ---------- view model ---------- */

export interface ToolItem {
  type: "tool";
  key: string;
  call: TranscriptEvent | null;
  result: TranscriptEvent | null;
  seq: number;
}
export type Item = { type: "event"; key: string; event: TranscriptEvent; seq: number } | ToolItem;

/** Pair tool calls with their results by call id; keep chronological order. */
export function buildItems(events: TranscriptEvent[]): Item[] {
  const results = new Map<string, TranscriptEvent>();
  for (const e of events) {
    if (e.kind === "tool-result" && e.toolCallId) results.set(e.toolCallId, e);
  }
  const consumed = new Set<string>();
  const items: Item[] = [];
  for (const e of events) {
    if (e.kind === "tool-call") {
      const r = e.toolCallId ? (results.get(e.toolCallId) ?? null) : null;
      if (r) consumed.add(r.messageId);
      items.push({ type: "tool", key: e.messageId, call: e, result: r, seq: e.seq });
    } else if (e.kind === "tool-result" && consumed.has(e.messageId)) {
      continue;
    } else if (e.kind === "tool-result") {
      items.push({ type: "tool", key: e.messageId, call: null, result: e, seq: e.seq });
    } else {
      items.push({ type: "event", key: e.messageId, event: e, seq: e.seq });
    }
  }
  return items;
}

const SPEAKER_FILTERS: Array<{ id: string; label: string; match: (e: TranscriptEvent) => boolean }> = [
  { id: "all", label: "All", match: () => true },
  { id: "user", label: "User", match: (e) => e.speaker === "user" },
  {
    id: "agent",
    label: "Agents",
    match: (e) => ["worker", "orchestrator", "reviewer"].includes(e.speaker),
  },
  { id: "tool", label: "Tools", match: (e) => e.speaker === "tool" || e.kind === "tool-call" },
  {
    id: "system",
    label: "System",
    match: (e) => ["controller", "runtime"].includes(e.speaker),
  },
];

const SPEAKER_LABEL: Record<Speaker, string> = {
  user: "You",
  orchestrator: "Orchestrator",
  worker: "Worker",
  reviewer: "Reviewer",
  tool: "Tool",
  runtime: "Runtime",
  controller: "Controller",
};

function itemAgentLabel(e: TranscriptEvent): string {
  // Only recorded identities; never a guessed agent name.
  return [SPEAKER_LABEL[e.speaker], e.actor.agent].filter(Boolean).join(" · ");
}

/* ---------- small pieces ---------- */

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="nv-copy"
      aria-label={label}
      title={label}
      onClick={() => {
        try {
          void navigator.clipboard.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          });
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      <Copy size={13} aria-hidden="true" />
      {done && <span className="nv-copy__done">Copied</span>}
    </button>
  );
}

function Flags({ e }: { e: TranscriptEvent }) {
  return (
    <>
      {e.source === "mock-fixture" && <Badge tone="warning">MOCK</Badge>}
      {e.state === "partial" && <Badge tone="purple">partial</Badge>}
      {e.state === "interrupted" && <Badge tone="error">interrupted</Badge>}
      {e.recording === "assembled-from-chunks" && (
        <Badge title="No finalized record existed; text was assembled from recorded stream chunks">
          from stream chunks
        </Badge>
      )}
      {e.redactions > 0 && (
        <Badge tone="warning" icon={<ShieldAlert size={11} />} title="Credential-like text was replaced">
          redacted ×{e.redactions}
        </Badge>
      )}
      {e.truncated && (
        <Badge title={`Original length ${e.originalLen ?? "?"} characters`}>truncated</Badge>
      )}
    </>
  );
}

function Body({ text, markdown }: { text: string; markdown: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > COLLAPSE_AT;
  const shown = long && !open ? text.slice(0, COLLAPSE_AT) : text;
  return (
    <div className="nv-msg__body">
      {markdown ? <MarkdownLite text={shown} /> : <pre className="nv-msg__pre">{shown}</pre>}
      {long && (
        <button type="button" className="nv-link nv-msg__more" onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : `Show more (${text.length - COLLAPSE_AT} more characters)`}
        </button>
      )}
    </div>
  );
}

function Meta({ e }: { e: TranscriptEvent }) {
  const bits = [e.actor.model, e.actor.provider].filter(Boolean).join(" · ");
  return (
    <span className="nv-msg__meta">
      {bits && <span className="nv-mono">{bits}</span>}
      {e.timestampMs !== null && <span>{absoluteTime(new Date(e.timestampMs).toISOString())}</span>}
    </span>
  );
}

function EventRow({ e }: { e: TranscriptEvent }) {
  const [open, setOpen] = useState(false);
  const text = e.text ?? "";
  if (e.kind === "model-handoff") {
    return (
      <div className="nv-handoff" role="separator">
        <span>{text}</span>
        <Meta e={e} />
      </div>
    );
  }
  if (e.kind === "status") {
    return (
      <div className="nv-status-line">
        <Layers size={12} aria-hidden="true" /> <span>{text}</span> <Flags e={e} />
        <Meta e={e} />
      </div>
    );
  }
  if (e.inputClass === "runtime-injected" || (e.kind === "controller-message" && e.speaker === "runtime")) {
    return (
      <div className="nv-injected">
        <button type="button" className="nv-injected__head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>Runtime-injected context (model-visible, not user-authored)</span>
          <span className="nv-injected__size">{e.originalLen ?? text.length} chars</span>
        </button>
        {open && <Body text={text} markdown={false} />}
      </div>
    );
  }
  const isUser = e.kind === "user-message";
  const isController = e.kind === "controller-message";
  const isError = e.kind === "error";
  const Icon = isUser ? User : isController ? Cpu : isError ? AlertTriangle : Bot;
  return (
    <article
      className={[
        "nv-msg",
        isUser && "nv-msg--user",
        isController && "nv-msg--controller",
        isError && "nv-msg--error",
      ]
        .filter(Boolean)
        .join(" ")}
      data-kind={e.kind}
    >
      <header className="nv-msg__head">
        <Icon size={14} aria-hidden="true" />
        <span className="nv-msg__who">{itemAgentLabel(e)}</span>
        {isUser && <Badge tone="purple">user-authored</Badge>}
        {isController && <Badge>controller-compiled</Badge>}
        <Flags e={e} />
        <Meta e={e} />
        <CopyButton text={text} />
      </header>
      <Body text={text} markdown={!isController && !isError} />
    </article>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const c = item.call;
  const r = item.result;
  const name = c?.toolName ?? "tool result";
  const err = r?.isError === true;
  const summary = r?.text ? r.text.split("\n")[0]!.slice(0, 120) : item.result ? "" : "no result recorded";
  return (
    <div className={`nv-tool${err ? " nv-tool--error" : ""}`}>
      <button
        type="button"
        className="nv-tool__head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Wrench size={13} aria-hidden="true" />
        <span className="nv-mono nv-tool__name">{name}</span>
        <span className="nv-tool__summary">{summary}</span>
        {err && <Badge tone="error">error</Badge>}
        {c && <Flags e={c} />}
        {r && r !== c && <Flags e={r} />}
      </button>
      {open && (
        <div className="nv-tool__body">
          {c && (
            <section>
              <div className="nv-tool__label">
                Input <CopyButton text={c.toolInput ?? ""} label="Copy input" />
              </div>
              <pre className="nv-msg__pre">{c.toolInput ?? "(none recorded)"}</pre>
            </section>
          )}
          <section>
            <div className="nv-tool__label">
              <Terminal size={12} aria-hidden="true" /> Output{" "}
              {r && <CopyButton text={r.text ?? ""} label="Copy output" />}
            </div>
            {r ? (
              <pre className="nv-msg__pre">{r.text || "(empty)"}</pre>
            ) : (
              <p className="nv-note" style={{ margin: 0 }}>
                No result was recorded for this call (it may have been interrupted).
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/* ---------- Model I/O ---------- */

export function ModelIoPanel({ conversationId }: { conversationId: string }) {
  const { api } = useNexus();
  const [state, setState] = useState<{
    id: string;
    data: ModelIoView | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .modelIoRead(conversationId)
      .then((data) => alive && setState({ id: conversationId, data, error: null }))
      .catch((e) => alive && setState({ id: conversationId, data: null, error: asUiError(e).message }));
    return () => {
      alive = false;
    };
  }, [api, conversationId]);
  if (!state || state.id !== conversationId) return <Loading label="Reading recorded request headers…" />;
  if (state.error) return <Alert tone="warning" title="Model I/O unavailable">{state.error}</Alert>;
  const d = state.data!;
  if (!d.available)
    return (
      <EmptyState icon={Cpu} title="No verified model request records">
        {d.note}
      </EmptyState>
    );
  return (
    <div className="nv-stack" style={{ gap: 12 }}>
      <Alert tone="info" title="What this shows">
        {d.note}
      </Alert>
      {d.records.map((r) => (
        <details key={r.recordId} className="nv-modelio">
          <summary>
            <span className="nv-mono">{r.model ?? "unknown model"}</span>
            <span className="nv-modelio__sub">
              {r.provider ?? "?"} · effort {r.reasoningEffort ?? "—"} · {r.attemptId ?? "no attempt"}
              {r.timestampMs ? ` · ${absoluteTime(new Date(r.timestampMs).toISOString())}` : ""}
            </span>
            {r.redactions > 0 && <Badge tone="warning">redacted ×{r.redactions}</Badge>}
          </summary>
          <div className="nv-modelio__body">
            <p className="nv-note" style={{ margin: "0 0 8px" }}>
              Context window {r.contextWindow ?? "—"} · max tokens {r.maxTokens ?? "—"} · tools:{" "}
              {r.toolNames.length ? r.toolNames.join(", ") : "none recorded"}
            </p>
            {r.systemPrompt ? (
              <>
                <div className="nv-tool__label">
                  System prompt ({r.systemPromptLen} chars{r.systemPromptTruncated ? ", truncated" : ""}){" "}
                  <CopyButton text={r.systemPrompt} label="Copy system prompt" />
                </div>
                <pre className="nv-msg__pre nv-modelio__sys">{r.systemPrompt}</pre>
              </>
            ) : (
              <p className="nv-note">No system prompt recorded.</p>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

/* ---------- panel ---------- */

function Provenance({ attempts, source, displayId }: { attempts: AttemptProvenance[]; source: string; displayId: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="nv-prov">
      <button type="button" className="nv-link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Provenance
      </button>
      {open && (
        <div className="nv-prov__body">
          <div>
            Source: <code>{source}</code>
            {displayId && (
              <>
                {" "}
                · display id <code>{displayId}</code> (label only, never used to join)
              </>
            )}
          </div>
          {attempts.length === 0 && <div>No attempt records.</div>}
          {attempts.map((a) => (
            <div key={a.attemptId} className="nv-prov__row">
              <code>{a.attemptId}</code> · session <code>{a.sessionId ?? "—"}</code> · from turn{" "}
              {a.startedByTurn ?? "—"} · {a.executionClass ?? "—"} · binding: <strong>{a.binding}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConversationPanel({
  state,
  conversationId,
}: {
  state: ConversationState;
  conversationId: string;
}) {
  const [filter, setFilter] = useState("all");
  const [grouped, setGrouped] = useState(false);
  const [modelIo, setModelIo] = useState(false);
  const [visible, setVisible] = useState(INITIAL_VISIBLE);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const initialFor = useRef<string | null>(null);
  const anchor = useRef<{ height: number; top: number; firstKey: string | undefined } | null>(null);
  const [showJump, setShowJump] = useState(false);
  const { view, events } = state;

  const items = useMemo(() => {
    const f = SPEAKER_FILTERS.find((x) => x.id === filter) ?? SPEAKER_FILTERS[0]!;
    const filtered = filter === "all" ? events : events.filter(f.match);
    return buildItems(filtered);
  }, [events, filter]);
  const shown = items.slice(Math.max(0, items.length - visible));
  const firstKey = shown[0]?.key;

  // Scroll policy (documented in README):
  //  * Opening a historical (DSH) conversation lands on the latest message.
  //  * Opening a native/mock conversation lands on the top so the submitted
  //    prompt is visible; "Jump to latest" appears when more content follows.
  //  * Output is followed only while the viewport is already at the bottom.
  //  * Prepending earlier records keeps the visible message in place.
  //  * Expanding a tool call never moves the viewport.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current && firstKey !== anchor.current.firstKey) {
      // earlier records were prepended: compensate for the added height
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
      return;
    }
    if (events.length > 0 && initialFor.current !== conversationId) {
      initialFor.current = conversationId;
      if (view?.source === "dsh-session-log") {
        el.scrollTop = el.scrollHeight;
      } else {
        el.scrollTop = 0;
      }
      pinned.current = stickToBottom(el);
      setShowJump(!pinned.current);
    }
  }, [firstKey, events.length, conversationId, view?.source]);

  const lastKey = events[events.length - 1]?.revisionSeq ?? -1;
  useEffect(() => {
    const el = scroller.current;
    if (!el || initialFor.current !== conversationId) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    setShowJump(!stickToBottom(el));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastKey, filter]);

  const onScroll = () => {
    const near = stickToBottom(scroller.current);
    pinned.current = near;
    setShowJump((cur) => (cur === !near ? cur : !near));
  };
  const jumpToLatest = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setShowJump(false);
  };
  const rememberAnchor = () => {
    const el = scroller.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop, firstKey };
  };

  if (state.loading && !view) return <Loading label="Loading recorded conversation…" />;
  if (state.error)
    return (
      <Alert tone="error" title="Conversation could not be read">
        {state.error.message}
      </Alert>
    );
  if (!view) return null;
  if (!view.available)
    return (
      <div className="nv-scroll">
        <EmptyState icon={MessageSquare} title="Conversation history was not recorded for this task.">
          {view.reason && view.reason.replace("Conversation history was not recorded for this task.", "").trim()}
          {" "}Activity may still show lifecycle records.
        </EmptyState>
        <Provenance attempts={view.attempts} source={view.source} displayId={view.displayTaskId} />
      </div>
    );

  const attemptsById = new Map(view.attempts.map((a) => [a.attemptId, a]));
  const rows: React.ReactNode[] = [];
  let lastAttempt: string | null | undefined;
  for (const it of shown) {
    const att = it.type === "tool" ? (it.call ?? it.result)?.attemptId : it.event.attemptId;
    if (grouped && att !== lastAttempt) {
      const a = att ? attemptsById.get(att) : undefined;
      rows.push(
        <div className="nv-attempt-sep" key={`att-${it.key}`}>
          {att ? `Attempt ${a?.sequence ?? ""} · ${att}` : "Before first attempt"}
        </div>,
      );
      lastAttempt = att;
    }
    rows.push(
      it.type === "tool" ? <ToolRow key={it.key} item={it} /> : <EventRow key={it.key} e={it.event} />,
    );
  }

  return (
    <div className="nv-conv">
      <div className="nv-conv__bar">
        <div className="nv-conv__filters" role="group" aria-label="Filter by speaker">
          {SPEAKER_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="nv-pill"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label className="nv-conv__toggle">
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> Group by
          attempt
        </label>
        <Button
          size="sm"
          variant={modelIo ? "primary" : "default"}
          aria-pressed={modelIo}
          onClick={() => setModelIo((m) => !m)}
          icon={<Cpu size={13} />}
        >
          Model I/O
        </Button>
        {view.source === "dsh-session-log" && (
          <Button size="sm" variant="ghost" aria-label="Reload from session log" onClick={state.refresh} icon={<RefreshCw size={13} />} />
        )}
      </div>
      {view.source === "dsh-session-log" && (
        <p className="nv-note" style={{ margin: "0 0 8px" }}>
          Historical record, read-only, imported from a DSH session log joined through the Controller attempt
          journal. Reasoning text is never shown.
        </p>
      )}
      {view.integrityFailure && (
        <Alert tone="error" title="Transcript integrity failure">
          {view.integrityFailure}
        </Alert>
      )}
      {modelIo ? (
        <div className="nv-scroll">
          <ModelIoPanel conversationId={conversationId} />
        </div>
      ) : (
        <div className="nv-conv__viewport">
          <div
            className="nv-scroll nv-conv__list"
            ref={scroller}
            onScroll={onScroll}
            aria-live="polite"
          >
            {(state.hasEarlier || items.length > shown.length) && (
              <button
                type="button"
                className="nv-link nv-conv__earlier"
                onClick={() => {
                  rememberAnchor();
                  if (items.length > shown.length) setVisible((v) => v + INITIAL_VISIBLE);
                  else state.loadEarlier();
                }}
              >
                Load earlier messages
              </button>
            )}
            {rows}
            {items.length === 0 && (
              <p className="nv-note">No messages match this filter.</p>
            )}
          </div>
          {showJump && (
            <button type="button" className="nv-jump" onClick={jumpToLatest}>
              <ArrowDown size={13} aria-hidden="true" /> Jump to latest
            </button>
          )}
        </div>
      )}
      <Provenance attempts={view.attempts} source={view.source} displayId={view.displayTaskId} />
      <p className="nv-note nv-conv__foot">
        {view.coverage.eventsEmitted || events.length} records ·{" "}
        {view.coverage.reasoningBlocksOmitted > 0 &&
          `${view.coverage.reasoningBlocksOmitted} reasoning blocks withheld · `}
        {view.coverage.redactions > 0 && `${view.coverage.redactions} redactions · `}
        {view.coverage.nestedToolDispatchesNotRendered > 0 &&
          `${view.coverage.nestedToolDispatchesNotRendered} nested tool dispatches not rendered`}
      </p>
    </div>
  );
}
