import { ArrowUp, ChevronDown, ChevronRight, FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { accessOf, accessSentence } from "../../lib/access";
import type { ThreadMode } from "../../lib/contracts";
import { Alert, Button } from "../../components/ui/primitives";
import { useNexus } from "../../state/NexusContext";
import { ProjectAccess } from "../access/ProjectAccess";
import { ENGINE_LABEL } from "../engine/EngineChoice";
import { ModeSwitch } from "../thread/ThreadComposer";
import { limitsLine } from "../../lib/limits";

export const PROJECT_COMPOSER_PLACEHOLDER = "Describe what to build or fix…";

const LAST_PROJECT = "nexus.lastProject";
const remembered = (): string | null => {
  try {
    return window.localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
};
const remember = (id: string) => {
  try {
    window.localStorage.setItem(LAST_PROJECT, id);
  } catch {
    /* a convenience only */
  }
};

/**
 * The one input for the interactive profile: pick a project, say what to build or fix, press Run. What
 * Nexus may do in the project is stated in a sentence and changed through the access panel (each change a
 * native confirmation). There is no model, route, path, limit or approval on this page: the engine is
 * chosen in Settings and the renderer can name nothing but a project identity and text.
 */
export function ProjectComposer({ autoFocus = false }: { autoFocus?: boolean }) {
  const { intentCodeSources, intentCodeLimits, sendThread, threadSending, threadError, clearThreadError, runtimeState, openProject, projects, setupBusy, engineChoice, intentModels } = useNexus();
  const sources = intentCodeSources ?? [];
  const [pick, setPick] = useState<string | null>(remembered());
  const source = sources.find((s) => s.sourceId === pick) ?? sources[0] ?? null;
  const project = projects.find((p) => p.projectId === source?.sourceId);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<ThreadMode>("auto");
  const [showAccess, setShowAccess] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const consentGiven = runtimeState?.consent.given === true && runtimeState.providerConnected;
  const hasModel = (intentModels?.length ?? 0) > 0;
  const empty = text.trim().length === 0;
  const canSend = !threadSending && !empty && source !== null && intentCodeLimits !== null && consentGiven && hasModel;
  const engine = engineChoice?.effective ? ENGINE_LABEL[engineChoice.effective] : null;

  const send = () => {
    if (!canSend || !source) return;
    const prompt = text;
    remember(source.sourceId);
    // Keep the text until the broker accepted it, so a refusal loses nothing.
    void sendThread({ threadId: null, projectId: source.sourceId, content: prompt, mode }).then((r) => r && setText(""));
  };

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
        placeholder={PROJECT_COMPOSER_PLACEHOLDER}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="nv-composer__ctx">
        <label className="nv-sr-only" htmlFor="nv-source-select">
          Project
        </label>
        <select id="nv-source-select" className="nv-select" value={source?.sourceId ?? ""} onChange={(e) => { setPick(e.target.value); remember(e.target.value); }} title="The projects you have opened in Nexus">
          {sources.map((w) => (
            <option key={w.sourceId} value={w.sourceId}>
              {w.label ?? w.sourceId}
            </option>
          ))}
        </select>
        <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => void openProject()} disabled={setupBusy === "project"} aria-label="Open project">
          {setupBusy === "project" ? "Opening…" : "Open…"}
        </Button>
        <ModeSwitch value={mode} onChange={setMode} />
        <span className="nv-composer__spacer" />
        <Button variant="primary" disabled={!canSend} onClick={send} aria-label="Run" title="Start the task (Ctrl+Enter)" icon={threadSending ? <Loader2 size={15} className="nv-spin" /> : <ArrowUp size={15} />}>
          Run
        </Button>
      </div>

      {source && project && (
        <section className="nv-terms" aria-label="What Nexus may do here">
          <div className="nv-terms__line">
            <button type="button" className="nv-linkbtn nv-terms__toggle" aria-expanded={showAccess} onClick={() => setShowAccess((s) => !s)}>
              {showAccess ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />} What can Nexus do in <span className="nv-mono">{project.label}</span>?
            </button>
            <span className="nv-note"> {accessSentence(accessOf(project))}.</span>
          </div>
          {showAccess && <ProjectAccess p={project} />}
          <div className="nv-terms__line nv-note">
            {engine ? `Engine: ${engine}. ` : ""}
            {intentCodeLimits ? limitsLine(intentCodeLimits) : "The runtime did not report its settings, so Run is disabled."}
          </div>
          {runtimeState?.updatePending && <Alert tone="info" title="Nexus was updated">A task is still running. Nexus restarts by itself when it finishes; new tasks can start right after.</Alert>}
        </section>
      )}
      {sources.length === 0 && <div className="nv-composer__hint">Open a project first: press “Open…”.</div>}
      {threadError && (
        <Alert tone="error" title={`Send failed: ${threadError.code}`}>
          {threadError.message}{" "}
          <button type="button" className="nv-linkbtn" onClick={clearThreadError}>
            Dismiss
          </button>
        </Alert>
      )}
    </section>
  );
}
