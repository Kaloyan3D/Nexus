import { ArrowUp, Loader2, Square } from "lucide-react";
import { useRef, useState } from "react";
import type { ModelSelection, ThreadDetail, ThreadMode } from "../../lib/contracts";
import { Alert, Button } from "../../components/ui/primitives";
import { useNexus } from "../../state/NexusContext";
import { engineLabelForMode } from "../engine/EngineChoice";
import { ModelPicker } from "../models/ModelPicker";
import { failedBeforeSubmissionMessage, refusalMessage } from "../models/modelTargets";

export const THREAD_PLACEHOLDER = "Message Nexus about this project…";

const MODES: Array<{ id: ThreadMode; label: string; title: string }> = [
  { id: "auto", label: "Auto", title: "Questions and reviews stay read-only; requests to change something may edit the project (in the workspace you chose for it)" },
  { id: "review", label: "Review only", title: "Read-only: Nexus can read and run checks but cannot change a file" },
  { id: "edit", label: "Make changes", title: "Nexus may edit files in the project (in the workspace you chose for it) and run tests there" },
];

/** Run endings that mean the conversation's workspace could not be carried into a new run. */
const WORKSPACE_CODES = new Set(["workspace-conflict", "workspace-missing", "seed-failed"]);

export function ModeSwitch({ value, onChange }: { value: ThreadMode; onChange: (m: ThreadMode) => void }) {
  return (
    <div className="nv-seg" role="radiogroup" aria-label="What Nexus may do">
      {MODES.map((m) => (
        <button key={m.id} type="button" role="radio" aria-checked={value === m.id} onClick={() => onChange(m.id)} title={m.title}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The conversation's composer. It is available after EVERY run (completed, failed, cancelled,
 * recovered); only while a run is in progress does it offer Stop instead of Send. The
 * conversation's project is fixed - the page cannot name another one.
 */
export function ThreadComposer({ detail, onSent }: { detail: ThreadDetail; onSent: () => void }) {
  const { sendThread, threadSending, threadError, clearThreadError, api, runtimeState, intentTargets } = useNexus();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<ThreadMode>("auto");
  // R-NATIVE-3: null = broker default (sends NO selection); a choice sends identities only.
  // Never reset on refusal: the user's choice stays visible (no silent fallback).
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [fresh, setFresh] = useState(false);
  const [stopping, setStopping] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const t = detail.thread;
  const last = detail.runs[detail.runs.length - 1];
  const interactive = runtimeState?.mode === "interactive";
  const consentOk = !interactive || (runtimeState?.consent.given === true && runtimeState.providerConnected);
  const workspaceProblem = last?.run?.errorCode && WORKSPACE_CODES.has(last.run.errorCode) ? last.run : null;
  const cacheNote = failedBeforeSubmissionMessage(last?.run?.errorCode ?? null, last?.run?.errorMessage ?? null);
  const engineLabel = engineLabelForMode(t.target?.modeId ?? null);
  const busy = t.active;
  const empty = text.trim().length === 0;
  const canSend = !busy && !threadSending && !empty && consentOk && !t.archived;

  const send = async () => {
    if (!canSend) return;
    const reply = await sendThread({ threadId: t.threadId, projectId: t.projectId, content: text, mode, workspace: fresh ? "fresh" : "continue", model });
    if (reply) {
      setText("");
      setFresh(false);
      onSent();
    }
  };
  const stop = async () => {
    if (!t.activeRunId) return;
    setStopping(true);
    try {
      await api.intentCancel(t.activeRunId);
    } catch {
      /* the run view shows what happened */
    } finally {
      setStopping(false);
      onSent();
    }
  };

  return (
    <section className="nv-composer nv-composer--unified nv-thread__composer" aria-label="Message composer">
      {workspaceProblem && (
        <div className="nv-thread__wsproblem">
          <Alert tone="warning" title="This conversation's changes could not be carried into a new run">
            {workspaceProblem.errorMessage ?? "The project changed in a way that conflicts with this conversation's work."} Your files were not touched and the earlier working copy is kept.{" "}
            <button type="button" className="nv-linkbtn" aria-pressed={fresh} onClick={() => setFresh((f) => !f)}>
              {fresh ? "Starting from your project's current files ✓ (click to undo)" : "Continue from my project's current files instead"}
            </button>
          </Alert>
        </div>
      )}
      <label className="nv-sr-only" htmlFor="nv-thread-input">
        Message
      </label>
      <textarea
        id="nv-thread-input"
        ref={ref}
        className="nv-composer__input"
        value={text}
        rows={2}
        placeholder={busy ? "Nexus is working on the last message…" : THREAD_PLACEHOLDER}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="nv-composer__ctx">
        {engineLabel ? (
          <span className="nv-note" title="This conversation keeps the engine it started with. Start a new conversation to use another.">
            Engine: {engineLabel}
          </span>
        ) : (
          <ModelPicker targets={intentTargets} value={model} bound={t.target ?? null} disabled={busy} onChange={setModel} />
        )}
        <ModeSwitch value={mode} onChange={setMode} />
        {fresh && <span className="nv-note">Next message starts from your project's current files.</span>}
        <span className="nv-composer__spacer" />
        {busy ? (
          <Button onClick={() => void stop()} disabled={stopping} aria-label="Stop" icon={<Square size={14} />}>
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        ) : (
          <Button variant="primary" disabled={!canSend} onClick={() => void send()} aria-label="Send" icon={threadSending ? <Loader2 size={15} className="nv-spin" /> : <ArrowUp size={15} />} title="Send (Ctrl+Enter)">
            Send
          </Button>
        )}
      </div>
      {!consentOk && <Alert tone="warning" title="Autonomous work is not allowed yet">Finish setup first (connect OpenCode Go and allow autonomous work).</Alert>}
      {t.archived && <p className="nv-note">This conversation is archived.</p>}
      {cacheNote && <Alert tone="info" title="The model list changed">{cacheNote}</Alert>}
      {threadError && (
        <Alert tone="error" title={threadError.code === "thread-busy" ? "Still working" : `Send failed: ${threadError.code}`}>
          {refusalMessage(threadError.code, threadError.message)}{" "}
          <button type="button" className="nv-linkbtn" onClick={clearThreadError}>
            Dismiss
          </button>
        </Alert>
      )}
    </section>
  );
}
