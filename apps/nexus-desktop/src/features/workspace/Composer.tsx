import { ArrowUp, Code2, FileText, Globe, Loader2, Paperclip, Search, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { useNexus } from "../../state/NexusContext";
import { Badge, Button, Kbd, modKeys } from "../../components/ui/primitives";

const TOOLS = [
  { id: "code", label: "Code", icon: Code2 },
  { id: "file", label: "File", icon: FileText },
  { id: "web", label: "Web", icon: Globe },
  { id: "research", label: "Deep Research", icon: Search },
];

export const COMPOSER_PLACEHOLDER = "Describe the next step, ask Nova, or give an engineering task...";

export function Composer() {
  const { startMock, mockBusy } = useNexus();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const empty = text.trim().length === 0;

  const submit = () => {
    if (empty || mockBusy) return;
    const prompt = text;
    setText("");
    void startMock(prompt);
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
        <Button variant="ghost" size="sm" disabled aria-label="Attach (unavailable)" title="Attachments are not supported by the native backend yet" icon={<Paperclip size={15} />} />
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="nv-chip"
            aria-disabled="true"
            tabIndex={0}
            title={`${t.label} is not exposed by the native backend yet`}
            onClick={(e) => e.preventDefault()}
          >
            <t.icon size={14} aria-hidden="true" />
            {t.label}
          </button>
        ))}
        <span className="nv-composer__spacer" />
        <Badge tone="warning" title="Live dispatch is disabled in the Kernel (dispatch_enabled == false)">
          Live execution unavailable
        </Badge>
        <span className="nv-chip nv-chip--static" title="Offline mock catalog entry; the mock workflow does not route models">
          <Sparkles size={14} aria-hidden="true" /> Mock · e2e-mock-model
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
      </div>
      <div className="nv-composer__hint">
        Runs the isolated native mock workflow only. No provider traffic. <Kbd keys={modKeys("↵")} />
      </div>
    </section>
  );
}
