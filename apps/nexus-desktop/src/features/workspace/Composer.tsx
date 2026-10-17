import { ArrowUp, Ban, Code2, FileText, Globe, Loader2, Paperclip, Search, Send, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNexus } from "../../state/NexusContext";
import { Alert, Badge, Button, Kbd, modKeys } from "../../components/ui/primitives";

const TOOLS = [
  { id: "code", label: "Code", icon: Code2 },
  { id: "file", label: "File", icon: FileText },
  { id: "web", label: "Web", icon: Globe },
  { id: "research", label: "Deep Research", icon: Search },
];

export const COMPOSER_PLACEHOLDER = "Describe the next step, ask Nova, or give an engineering task...";

/** SHA-256 (hex) of the exact UTF-8 bytes that would be submitted. */
async function sha256Hex(text: string): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(text);
    const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export function Composer() {
  const {
    startMock,
    mockBusy,
    intentModels,
    intentModelsError,
    intentPending,
    intentSubmitting,
    intentError,
    intentWorkspaces,
    intentCodeSources,
    intentCodeLimits,
    sendIntent,
    sendInspect,
    sendCode,
    cancelPendingIntent,
  } = useNexus();
  const [text, setText] = useState("");
  const [modelIdx, setModelIdx] = useState(0);
  // A5.5: "Ask" is the text-only model request; "Inspect" lets the model use
  // read-only list/read/search tools inside one operator-approved repository.
  // A5.6: "Code" lets the model PROPOSE edits and test commands in an isolated
  // copy; each one still needs a separate, independent approval.
  const [mode, setMode] = useState<"ask" | "inspect" | "code">("ask");
  const [wsIdx, setWsIdx] = useState(0);
  const [srcIdx, setSrcIdx] = useState(0);
  const sources = intentCodeSources ?? [];
  // A6.1: sending source text to the provider needs a fresh, explicit acknowledgement per task.
  const [ack, setAck] = useState(false);
  const source = sources.length > 0 ? sources[Math.min(srcIdx, sources.length - 1)]! : null;
  const workspaces = intentWorkspaces ?? [];
  const workspace = workspaces.length > 0 ? workspaces[Math.min(wsIdx, workspaces.length - 1)]! : null;
  const model = intentModels && intentModels.length > 0 ? intentModels[Math.min(modelIdx, intentModels.length - 1)]! : null;
  const canSend =
    (mode === "inspect" ? workspace !== null && model !== null : mode === "code" ? source !== null && model !== null && intentCodeLimits !== null && ack : model !== null) &&
    !intentSubmitting &&
    intentPending === null;
  // A6.1: a live session authorization is bound to the SHA-256 of the exact prompt bytes. Show the
  // fingerprint of what would be sent so the operator can compare it with `sha256sum` / the record.
  const [fp, setFp] = useState<{ text: string; bytes: number; sha: string | null } | null>(null);
  useEffect(() => {
    if (mode !== "code" || text.length === 0) return;
    let alive = true;
    void sha256Hex(text).then((sha) => alive && setFp({ text, bytes: new TextEncoder().encode(text).length, sha }));
    return () => {
      alive = false;
    };
  }, [mode, text]);
  // only ever show the fingerprint of the text currently in the box
  const fingerprint = mode === "code" && fp !== null && fp.text === text ? fp : null;
  const ref = useRef<HTMLTextAreaElement>(null);
  const empty = text.trim().length === 0;

  const submit = () => {
    if (empty || mockBusy) return;
    const prompt = text;
    setText("");
    void startMock(prompt);
  };

  const send = () => {
    if (empty || !canSend) return;
    const prompt = text;
    // Keep the text until the broker accepted it, so a refusal loses nothing.
    if (mode === "code" && source) {
      void sendCode(prompt, source.sourceId).then((ok) => {
        if (ok) {
          setText("");
          setAck(false);
        }
      });
      return;
    }
    if (mode === "inspect" && workspace) {
      void sendInspect(prompt, workspace.workspaceId).then((ok) => ok && setText(""));
      return;
    }
    void sendIntent(prompt, model).then((ok) => ok && setText(""));
  };

  return (
    <section className="nv-composer" aria-label="Task composer">
      <label className="nv-sr-only" htmlFor="nv-composer-input">
        Task prompt
      </label>
      <textarea
        id="nv-composer-input"
        ref={ref}
        className="nv-composer__input"
        value={text}
        rows={2}
        placeholder={COMPOSER_PLACEHOLDER}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="nv-composer__bar">
        <div className="nv-composer__tools" role="group" aria-label="Tools">
          <Button variant="ghost" size="sm" disabled aria-label="Attach (unavailable)" title="Attachments are not supported by the native backend yet" icon={<Paperclip size={15} />} />
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="nv-chip"
              aria-disabled="true"
              aria-label={t.label}
              tabIndex={0}
              title={`${t.label} is not exposed by the native backend yet`}
              onClick={(e) => e.preventDefault()}
            >
              <t.icon size={14} aria-hidden="true" />
              <span className="nv-chip__label">{t.label}</span>
            </button>
          ))}
        </div>
        <div className="nv-composer__actions">
          <Badge tone="warning" title="Live dispatch is disabled in the Kernel (dispatch_enabled == false)">
            Live execution unavailable
          </Badge>
          <span className="nv-chip nv-chip--static" title="Offline mock catalog entry; the mock workflow does not route models">
            <Sparkles size={14} aria-hidden="true" />
            <span className="nv-chip__label">Mock · e2e-mock-model</span>
          </span>
          <Button
            variant="primary"
            disabled={empty || mockBusy}
            onClick={submit}
            aria-label="Run Mock"
            title={`Run isolated mock workflow (${modKeys("Enter").join("+")})`}
            icon={mockBusy ? <Loader2 size={15} className="nv-spin" /> : <ArrowUp size={15} />}
          >
            Run Mock
          </Button>
          <label className="nv-sr-only" htmlFor="nv-model-select">
            Model
          </label>
          <select
            id="nv-model-select"
            className="nv-chip"
            value={modelIdx}
            disabled={!intentModels || intentModels.length === 0}
            onChange={(e) => setModelIdx(Number(e.target.value))}
            title="Registry-issued models allowed by the broker"
          >
            {(intentModels ?? []).map((m, i) => (
              <option key={`${m.providerId}/${m.remoteModelId}`} value={i}>
                {m.providerId} · {m.remoteModelId}
                {m.endpointKind === "provider" ? "" : " (loopback fixture)"}
              </option>
            ))}
            {(!intentModels || intentModels.length === 0) && <option value={0}>No model available</option>}
          </select>
          {intentPending ? (
            <Button
              variant="ghost"
              onClick={() => void cancelPendingIntent()}
              aria-label="Cancel submission"
              icon={<Ban size={15} />}
              disabled={intentPending.cancelRequested}
            >
              {intentPending.cancelRequested ? "Cancelling…" : "Cancel"}
            </Button>
          ) : null}
          <div className="nv-chip nv-chip--static" role="group" aria-label="Request mode">
            <button
              type="button"
              className="nv-chip"
              aria-pressed={mode === "ask"}
              onClick={() => setMode("ask")}
              title="Text-only request: no tools, no files"
            >
              Ask
            </button>
            <button
              type="button"
              className="nv-chip"
              aria-pressed={mode === "inspect"}
              onClick={() => setMode("inspect")}
              disabled={workspaces.length === 0}
              title={
                workspaces.length === 0
                  ? "No read-only workspace has been approved by the operator"
                  : "Let the model read an approved repository with read-only tools"
              }
            >
              Inspect repo
            </button>
            <button
              type="button"
              className="nv-chip"
              aria-pressed={mode === "code"}
              onClick={() => setMode("code")}
              disabled={sources.length === 0}
              title={
                sources.length === 0
                  ? "No source repository has been approved for coding by the operator"
                  : "Let the model propose edits and test commands in an isolated copy (each needs separate approval)"
              }
            >
              Code in copy
            </button>
          </div>
          {mode === "code" && (
            <>
              <label className="nv-sr-only" htmlFor="nv-source-select">
                Source repository
              </label>
              <select
                id="nv-source-select"
                className="nv-chip"
                value={srcIdx}
                onChange={(e) => setSrcIdx(Number(e.target.value))}
                title="Operator-approved coding sources (identities, not paths)"
              >
                {sources.map((w, i) => (
                  <option key={w.sourceId} value={i}>
                    {w.sourceId}
                  </option>
                ))}
              </select>
            </>
          )}
          {mode === "inspect" && (
            <>
              <label className="nv-sr-only" htmlFor="nv-workspace-select">
                Workspace
              </label>
              <select
                id="nv-workspace-select"
                className="nv-chip"
                value={wsIdx}
                onChange={(e) => setWsIdx(Number(e.target.value))}
                title="Operator-approved read-only workspaces (identities, not paths)"
              >
                {workspaces.map((w, i) => (
                  <option key={w.workspaceId} value={i}>
                    {w.workspaceId}
                  </option>
                ))}
              </select>
            </>
          )}
          <Button
            variant="primary"
            disabled={empty || !canSend}
            onClick={send}
            aria-label={mode === "code" ? "Start coding task" : mode === "inspect" ? "Inspect repository" : "Send to model"}
            title={
              mode === "code"
                ? "Start a controlled coding task in an isolated copy through the Nexus broker"
                : mode === "inspect"
                ? "Start a read-only repository inspection through the Nexus broker"
                : model
                  ? `Send as a text-only model request through the Nexus broker (${model.providerId}/${model.remoteModelId})`
                  : "No broker model is available"
            }
            icon={intentSubmitting || intentPending ? <Loader2 size={15} className="nv-spin" /> : <Send size={15} />}
          >
            {mode === "code" ? "Start coding" : mode === "inspect" ? "Inspect" : "Send"}
          </Button>
        </div>
      </div>
      {intentPending && (
        <div className="nv-composer__hint" role="status">
          Submitted {intentPending.runId.slice(0, 12)}… · {intentPending.state}
        </div>
      )}
      {intentError && (
        <Alert tone="error" title={`Send failed: ${intentError.code}`}>
          {intentError.message}
        </Alert>
      )}
      {!intentError && intentModelsError && (
        <div className="nv-composer__hint">
          Model sending is unavailable: {intentModelsError.message}
        </div>
      )}
      {mode === "inspect" && model && (
        <Alert tone="warning" title="Repository contents may be sent to the model provider">
          The model can list, read and search files in the selected repository (read-only; secrets, VCS
          internals and Nexus state are blocked, other source text is sent as-is to{" "}
          <span className="nv-mono">{model.providerId}</span>). Each model turn is a billable request.
          Nothing is written or executed.
        </Alert>
      )}
      {mode === "code" && model && (
        <Alert tone="warning" title="This mode can change files (in an isolated copy) and run commands">
          The model may propose edits and build/test commands. Nothing runs until a separate approver reviews the
          exact patch or command; this application cannot approve. Changes are made in a throw-away copy, never your
          repository, and nothing is committed, pushed or merged. Selected source text and command output are sent
          to <span className="nv-mono">{model.providerId}</span>; commands run offline in a sandbox. Each model turn
          is a billable request.
        </Alert>
      )}
      {mode === "code" && source && (
        <section className="nv-stack" style={{ gap: 6, padding: "0 var(--nv-s-3)" }} aria-label="Coding task terms">
          <dl className="nv-kv">
            <dt>Source</dt>
            <dd className="nv-mono">{source.sourceId} (registered by the operator; not a typed path)</dd>
            <dt>Run limits</dt>
            <dd>
              {intentCodeLimits
                ? `${intentCodeLimits.maxTurns} model turns · ${intentCodeLimits.maxToolCalls} tool calls · ${intentCodeLimits.maxEdits} edits · ${intentCodeLimits.maxTests} commands · ${intentCodeLimits.maxOutputTokens} output tokens per call · ${Math.round(intentCodeLimits.maxToolResultBytes / 1024)} KiB of tool results · ${Math.round(intentCodeLimits.maxRuntimeSecs / 60)} min`
                : "unavailable (the backend did not report limits, so submitting is disabled)"}
            </dd>
          </dl>
          <p className="nv-note" aria-label="Prompt fingerprint">
            {fingerprint
              ? `Prompt as it will be sent: ${fingerprint.bytes} bytes · sha256 ${fingerprint.sha ?? "unavailable"} (compare with \`sha256sum\` of your prompt file; whitespace and a trailing newline change it)`
              : "Prompt fingerprint appears once you type a task."}
          </p>
          <label className="nv-note">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} aria-label="Acknowledge disclosure" />{" "}
            I understand that selected text from <span className="nv-mono">{source.sourceId}</span> and command output will be sent to the
            model provider, and that every edit and command waits for a separate approval.
          </label>
        </section>
      )}
      <div className="nv-composer__hint">
        Send: text-only request to the selected Registry model via the broker (no tools, no files). Run Mock:
        isolated fixture only. <Kbd keys={modKeys("↵")} />
      </div>
    </section>
  );
}
