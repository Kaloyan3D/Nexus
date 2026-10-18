import { ArrowUp, Ban, FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNexus } from "../../state/NexusContext";
import { Alert, Button } from "../../components/ui/primitives";

export const COMPOSER_PLACEHOLDER = "Describe the task…";

type Mode = "ask" | "inspect" | "code";

/** SHA-256 (hex) of the exact UTF-8 bytes that would be submitted. */
async function sha256Hex(text: string): Promise<string | null> {
  try {
    const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/**
 * One input for an engineering task. The mode decides what the model may do:
 * Ask (text only), Inspect (read-only repository tools), Code in copy (edits and
 * commands in an isolated copy, each needing a separate independent approval).
 * Projects are operator-registered identities; the renderer never types a path.
 */
export function UnifiedComposer({ autoFocus = false }: { autoFocus?: boolean }) {
  const {
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
    runtimeState,
    openProject,
    setupBusy,
  } = useNexus();
  const interactive = runtimeState?.mode === "interactive";
  const consentGiven = !interactive || (runtimeState?.consent.given === true && runtimeState.providerConnected);
  const [text, setText] = useState("");
  const [chosenMode, setMode] = useState<Mode | null>(null);
  const [modelIdx, setModelIdx] = useState(0);
  const [wsIdx, setWsIdx] = useState(0);
  const [srcIdx, setSrcIdx] = useState(0);
  const [ack, setAck] = useState(false);
  const [moreTerms, setMoreTerms] = useState(false);
  const workspaces = intentWorkspaces ?? [];
  const sources = intentCodeSources ?? [];
  const workspace = workspaces.length > 0 ? workspaces[Math.min(wsIdx, workspaces.length - 1)]! : null;
  const source = sources.length > 0 ? sources[Math.min(srcIdx, sources.length - 1)]! : null;
  const model = intentModels && intentModels.length > 0 ? intentModels[Math.min(modelIdx, intentModels.length - 1)]! : null;
  const empty = text.trim().length === 0;
  // Interactive profile: working on a project is THE default once one is open.
  const mode: Mode = chosenMode ?? (interactive ? "code" : "ask");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // A live session authorization is bound to the SHA-256 of the exact prompt bytes.
  const [fp, setFp] = useState<{ text: string; bytes: number; sha: string | null } | null>(null);
  useEffect(() => {
    if (mode !== "code" || text.length === 0) return;
    let alive = true;
    void sha256Hex(text).then((sha) => alive && setFp({ text, bytes: new TextEncoder().encode(text).length, sha }));
    return () => {
      alive = false;
    };
  }, [mode, text]);
  const fingerprint = mode === "code" && fp !== null && fp.text === text ? fp : null;

  const canSend =
    !intentSubmitting &&
    intentPending === null &&
    !empty &&
    model !== null &&
    (mode === "ask" || (mode === "inspect" && workspace !== null) || (mode === "code" && source !== null && intentCodeLimits !== null && (interactive ? consentGiven : ack)));

  const send = () => {
    if (!canSend || !model) return;
    const prompt = text;
    // Keep the text until the broker accepted it, so a refusal loses nothing.
    if (mode === "code" && source) {
      void sendCode(prompt, source.sourceId).then((ok) => {
        if (ok) {
          setText("");
          setAck(false);
        }
      });
    } else if (mode === "inspect" && workspace) {
      void sendInspect(prompt, workspace.workspaceId).then((ok) => ok && setText(""));
    } else {
      void sendIntent(prompt, model).then((ok) => ok && setText(""));
    }
  };

  const label = mode === "code" ? (interactive ? "Run" : "Start coding") : mode === "inspect" ? "Inspect" : "Ask";
  return (
    <section className="nv-composer nv-composer--unified" aria-label="Task composer">
      <label className="nv-sr-only" htmlFor="nv-composer-input">
        Task prompt
      </label>
      <textarea
        id="nv-composer-input"
        ref={ref}
        className="nv-composer__input"
        value={text}
        rows={3}
        placeholder={COMPOSER_PLACEHOLDER}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="nv-composer__ctx">
        <div className="nv-seg" role="radiogroup" aria-label="Request mode">
          <button type="button" role="radio" aria-checked={mode === "ask"} onClick={() => setMode("ask")} title="Text-only request: no tools, no files">
            Ask
          </button>
          {!interactive && (
          <button
            type="button"
            role="radio"
            aria-checked={mode === "inspect"}
            onClick={() => setMode("inspect")}
            disabled={workspaces.length === 0}
            title={workspaces.length === 0 ? "No project has been authorized for inspection by the operator" : "Let the model read an authorized project with read-only tools"}
          >
            Inspect
          </button>
          )}
          <button
            type="button"
            role="radio"
            aria-checked={mode === "code"}
            onClick={() => setMode("code")}
            disabled={!interactive && sources.length === 0}
            title={!interactive && sources.length === 0 ? "No project has been authorized for coding by the operator" : "Let the model propose edits and commands in an isolated copy (each needs separate approval)"}
          >
            {interactive ? "Work on project" : "Code in copy"}
          </button>
        </div>
        {mode === "inspect" && (
          <>
            <label className="nv-sr-only" htmlFor="nv-workspace-select">
              Project
            </label>
            <select id="nv-workspace-select" className="nv-select" value={wsIdx} onChange={(e) => setWsIdx(Number(e.target.value))} title="Operator-authorized projects (identities, not paths)">
              {workspaces.map((w, i) => (
                <option key={w.workspaceId} value={i}>
                  {w.workspaceId}
                </option>
              ))}
            </select>
          </>
        )}
        {mode === "code" && (
          <>
            <label className="nv-sr-only" htmlFor="nv-source-select">
              Project
            </label>
            <select id="nv-source-select" className="nv-select" value={srcIdx} onChange={(e) => setSrcIdx(Number(e.target.value))} title={interactive ? "Projects you have opened in Nexus" : "Operator-authorized projects (identities, not paths)"}>
              {sources.map((w, i) => (
                <option key={w.sourceId} value={i}>
                  {w.label ?? w.sourceId}
                </option>
              ))}
            </select>
            {interactive && (
              <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => void openProject()} disabled={setupBusy === "project"} aria-label="Open project">
                {setupBusy === "project" ? "Opening…" : "Open…"}
              </Button>
            )}
          </>
        )}
        <label className="nv-sr-only" htmlFor="nv-model-select">
          Model
        </label>
        <select
          id="nv-model-select"
          className="nv-select nv-select--quiet"
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
        <span className="nv-composer__spacer" />
        {intentPending && (
          <Button variant="ghost" onClick={() => void cancelPendingIntent()} aria-label="Cancel submission" icon={<Ban size={15} />} disabled={intentPending.cancelRequested}>
            {intentPending.cancelRequested ? "Cancelling…" : "Cancel"}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={!canSend}
          onClick={send}
          aria-label={label}
          title={
            mode === "code"
              ? "Start a controlled coding task in an isolated copy through the Nexus broker"
              : mode === "inspect"
                ? "Start a read-only repository inspection through the Nexus broker"
                : model
                  ? `Send as a text-only request through the Nexus broker (${model.providerId}/${model.remoteModelId})`
                  : "No broker model is available"
          }
          icon={intentSubmitting || intentPending ? <Loader2 size={15} className="nv-spin" /> : <ArrowUp size={15} />}
        >
          {label}
        </Button>
      </div>

      {mode === "code" && interactive && source && (
        <section className="nv-terms" aria-label="Autonomous run">
          <div className="nv-terms__line">
            <span>
              <span className="nv-mono">{source.label ?? source.sourceId}</span>
              {source.kinds && source.kinds.length > 0 ? ` · ${source.kinds.join(", ")}` : ""} · Nexus works in an isolated copy and runs builds and tests there automatically. Your folder is not changed until you apply the patch.
            </span>
          </div>
          <div className="nv-terms__line nv-note">
            {intentCodeLimits
              ? `Up to ${intentCodeLimits.maxTurns} model turns, ${intentCodeLimits.maxEdits} edits and ${intentCodeLimits.maxTests} test runs · ${Math.round(intentCodeLimits.maxRuntimeSecs / 60)} min`
              : "Run limits unavailable — the runtime did not report them, so Run is disabled."}
          </div>
          {runtimeState?.updatePending && <Alert tone="info" title="Nexus was updated">A task is still running. Nexus restarts by itself when it finishes; new tasks can start right after.</Alert>}
          {!consentGiven && <Alert tone="warning" title="Autonomous work is not allowed yet">Finish setup first (connect OpenCode Go and allow autonomous work).</Alert>}
        </section>
      )}
      {mode === "code" && !interactive && source && (
        <section className="nv-terms" aria-label="Coding task terms">
          <div className="nv-terms__line">
            <span>
              <span className="nv-mono">{source.sourceId}</span> · registered by the operator, not a typed path
              {source.pinnedCommit ? ` · pinned to ${source.pinnedCommit.slice(0, 10)}` : ""}
              {source.writeAllow && source.writeAllow.length > 0 ? ` · writes limited to ${source.writeAllow.join(", ")}` : ""}
            </span>
          </div>
          <div className="nv-terms__line nv-note">
            Run limits:{" "}
            {intentCodeLimits
              ? `${intentCodeLimits.maxTurns} model turns · ${intentCodeLimits.maxToolCalls} tool calls · ${intentCodeLimits.maxEdits} edits · ${intentCodeLimits.maxTests} commands · ${intentCodeLimits.maxOutputTokens} output tokens per call · ${Math.round(intentCodeLimits.maxToolResultBytes / 1024)} KiB of tool results · ${Math.round(intentCodeLimits.maxRuntimeSecs / 60)} min`
              : "unavailable (the backend did not report limits, so submitting is disabled)"}
            {intentCodeLimits?.approvalLifetimeSecs
              ? ` · each approval stays open ${Math.round((intentCodeLimits.approvalLifetimeSecs / 60) * 10) / 10} min`
              : ""}
          </div>
          <p className="nv-note" aria-label="Prompt fingerprint">
            {fingerprint
              ? `Prompt as it will be sent: ${fingerprint.bytes} bytes · sha256 ${fingerprint.sha ?? "unavailable"} (compare with \`sha256sum\` of your prompt file; whitespace and a trailing newline change it)`
              : "Prompt fingerprint appears once you type a task."}
          </p>
          <label className="nv-terms__ack nv-note">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} aria-label="Acknowledge disclosure" /> I understand that selected text from{" "}
            <span className="nv-mono">{source.sourceId}</span> and command output will be sent to the model provider
            {model ? <> (<span className="nv-mono">{model.providerId}</span>)</> : null}, and that every edit and command waits for a separate approval.{" "}
            <button type="button" className="nv-linkbtn" aria-expanded={moreTerms} onClick={() => setMoreTerms((m) => !m)}>
              {moreTerms ? "less" : "more"}
            </button>
          </label>
          {moreTerms && (
            <Alert tone="warning" title="This mode can change files (in an isolated copy) and run commands">
              The model may propose edits and build/test commands. Nothing runs until a separate approver reviews the exact patch or command; this application cannot approve. Changes are
              made in a throw-away copy, never your repository, and nothing is committed, pushed or merged. Selected source text and command output are sent to the provider; commands run
              offline in a sandbox. Each model turn is a billable request.
            </Alert>
          )}
        </section>
      )}
      {mode === "inspect" && model && (
        <p className="nv-note">
          Inspect reads files in the selected project with read-only tools (secrets, VCS internals and Nexus state are blocked); text it reads is sent to{" "}
          <span className="nv-mono">{model.providerId}</span>. Nothing is written or executed. Each model turn is a billable request.
        </p>
      )}
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
      {!intentError && intentModelsError && <div className="nv-composer__hint">Sending is unavailable: {intentModelsError.message}</div>}
    </section>
  );
}
