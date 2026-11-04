import { Compass, FlaskConical, Play } from "lucide-react";
import { useState } from "react";
import { Loader2, ArrowUp } from "lucide-react";
import { relativeTime } from "../../lib/format";
import { taskStatusView } from "../../lib/status";
import { useNexus } from "../../state/NexusContext";
import { Badge, Button, StatusDot } from "../../components/ui/primitives";
import { Inspector } from "../../components/shell/Inspector";
import { ActivityPanel } from "../workspace/ActivityPanel";
import { RecentTasks } from "../workspace/RecentTasks";

/** Advanced › Mock runs and Controller ledger: the diagnostic workspace (kept intact, no longer primary). */
function MockComposer() {
  const { startMock, mockBusy } = useNexus();
  const [text, setText] = useState("");
  const empty = text.trim().length === 0;
  const submit = () => {
    if (empty || mockBusy) return;
    const prompt = text;
    setText("");
    void startMock(prompt);
  };
  return (
    <section className="nv-composer" aria-label="Mock run composer">
      <label className="nv-sr-only" htmlFor="nv-mock-input">
        Task prompt
      </label>
      <textarea
        id="nv-mock-input"
        className="nv-composer__input"
        value={text}
        rows={2}
        placeholder="Describe a step to run through the isolated mock workflow…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="nv-composer__ctx">
        <Badge tone="warning">Mock · e2e-mock-model · fixture data only</Badge>
        <span className="nv-composer__spacer" />
        <Button variant="primary" disabled={empty || mockBusy} onClick={submit} aria-label="Run Mock" title="Run the isolated mock workflow (never contacts a provider)" icon={mockBusy ? <Loader2 size={15} className="nv-spin" /> : <ArrowUp size={15} />}>
          Run Mock
        </Button>
      </div>
    </section>
  );
}

export function MockPage() {
  const { selectedTask, selectedMock } = useNexus();
  return (
    <div className="nv-page nv-workspace nv-mockpage">
      <div className="nv-mockpage__main">
        <nav className="nv-breadcrumb" aria-label="Breadcrumb">
          <span>Advanced</span>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{selectedMock ? "Mock run" : selectedTask ? "Engineering Task" : "Mock runs and Controller ledger"}</span>
        </nav>
        <Heading />
        <MockComposer />
        <div className="nv-split">
          <RecentTasks />
          <ActivityPanel />
        </div>
      </div>
      <Inspector overlay={false} />
    </div>
  );

  function Heading() {
    if (selectedMock) {
      return (
        <div className="nv-heading">
          <div className="nv-heading__icon">
            <FlaskConical size={20} aria-hidden="true" />
          </div>
          <div className="nv-heading__text">
            <h1>{selectedMock.prompt.split("\n")[0]!.slice(0, 90)}</h1>
            <p>Isolated mock execution. Output is fixture data from a loopback mock provider.</p>
            <div className="nv-heading__meta">
              <Badge tone="warning">Mock</Badge>
              <Badge
                tone={selectedMock.status === "failed" ? "error" : selectedMock.status === "done" ? "success" : "purple"}
                icon={<StatusDot tone={selectedMock.status === "failed" ? "error" : selectedMock.status === "done" ? "success" : "purple"} pulse={selectedMock.status === "running"} />}
              >
                {selectedMock.status === "running" ? "Running" : selectedMock.status === "done" ? "Completed" : "Failed"}
              </Badge>
            </div>
          </div>
          <MainAction label="Live execution unavailable" />
        </div>
      );
    }
    if (selectedTask) {
      const v = taskStatusView(selectedTask.status);
      const first = selectedTask.description.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"))[0] ?? "";
      return (
        <div className="nv-heading">
          <div className="nv-heading__icon">
            <Compass size={20} aria-hidden="true" />
          </div>
          <div className="nv-heading__text">
            <h1>{selectedTask.title}</h1>
            {first && <p>{first.slice(0, 180)}</p>}
            <div className="nv-heading__meta">
              {selectedTask.boundEngine && <Badge tone="purple">{selectedTask.boundEngine}</Badge>}
              <Badge mono>{selectedTask.taskId}</Badge>
              <Badge tone={v.tone} icon={<StatusDot tone={v.tone} pulse={v.pulse} />}>
                {v.label}
              </Badge>
              <span className="nv-heading__updated">
                Updated {relativeTime(selectedTask.updatedAtUtc)}
              </span>
            </div>
          </div>
          <MainAction label="Live execution unavailable" />
        </div>
      );
    }
    return (
      <div className="nv-heading">
        <div className="nv-heading__icon">
          <Compass size={20} aria-hidden="true" />
        </div>
        <div className="nv-heading__text">
          <h1>Mock runs and Controller ledger</h1>
          <p>
            Diagnostics: select a Controller ledger task to inspect it, or run a step through the isolated native mock
            workflow. Real work starts in Workspace.
          </p>
        </div>
      </div>
    );
  }
}

function MainAction({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="nv-btn"
      disabled
      title="The Kernel forbids dispatch (dispatch_enabled == false). Use Run Mock in the composer."
    >
      <Play size={14} aria-hidden="true" />
      {label}
    </button>
  );
}
