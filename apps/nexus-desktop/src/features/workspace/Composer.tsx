import { ArrowUp, Ban, Code2, FileText, Globe, Loader2, Paperclip, Search, Send, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { useNexus } from "../../state/NexusContext";
import { Alert, Badge, Button, Kbd, modKeys } from "../../components/ui/primitives";

const TOOLS = [
  { id: "code", label: "Code", icon: Code2 },
  { id: "file", label: "File", icon: FileText },
  { id: "web", label: "Web", icon: Globe },
  { id: "research", label: "Deep Research", icon: Search },
];

export const COMPOSER_PLACEHOLDER = "Describe the next step, ask Nova, or give an engineering task...";

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
    sendIntent,
    sendInspect,
    cancelPendingIntent,
  } = useNexus();
  const [text, setText] = useState("");
  const [modelIdx, setModelIdx] = useState(0);
  // A5.5: "Ask" is the text-only model request; "Inspect" lets the model use
  // read-only list/read/search tools inside one operator-approved repository.
  const [mode, setMode] = useState<"ask" | "inspect">("ask");
  const [wsIdx, setWsIdx] = useState(0);
  const workspaces = intentWorkspaces ?? [];
  const workspace = workspaces.length > 0 ? workspaces[Math.min(wsIdx, workspaces.length - 1)]! : null;
  const model = intentModels && intentModels.length > 0 ? intentModels[Math.min(modelIdx, intentModels.length - 1)]! : null;
  const canSend =
    (mode === "inspect" ? workspace !== null && model !== null : model !== null) &&
    !intentSubmitting &&
    intentPending === null;
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
          </div>
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
            aria-label={mode === "inspect" ? "Inspect repository" : "Send to model"}
            title={
              mode === "inspect"
                ? "Start a read-only repository inspection through the Nexus broker"
                : model
                  ? `Send as a text-only model request through the Nexus broker (${model.providerId}/${model.remoteModelId})`
                  : "No broker model is available"
            }
            icon={intentSubmitting || intentPending ? <Loader2 size={15} className="nv-spin" /> : <Send size={15} />}
          >
            {mode === "inspect" ? "Inspect" : "Send"}
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
      <div className="nv-composer__hint">
        Send: text-only request to the selected Registry model via the broker (no tools, no files). Run Mock:
        isolated fixture only. <Kbd keys={modKeys("↵")} />
      </div>
    </section>
  );
}
