import { Bot, Compass, FlaskConical, Play } from "lucide-react";
import { CancelModelRunButton, PendingApprovalBanner, useModelRunStatus } from "../conversation/ModelRunPanel";
import { endpointLabel, modelStateView, usageLabel } from "../../lib/modelRun";
import { relativeTime } from "../../lib/format";
import { taskStatusView } from "../../lib/status";
import { useNexus } from "../../state/NexusContext";
import { Badge, StatusDot } from "../../components/ui/primitives";
import { ActivityPanel } from "./ActivityPanel";
import { Composer } from "./Composer";
import { RecentTasks } from "./RecentTasks";

export function WorkspacePage() {
  const { selectedTask, selectedMock, selectedModel } = useNexus();
  return (
    <div className="nv-page nv-workspace">
      <nav className="nv-breadcrumb" aria-label="Breadcrumb">
        <span>Workspace</span>
        <span aria-hidden="true">/</span>
        <span aria-current="page">
          {selectedModel
            ? "Model-only run"
            : selectedMock
              ? "Mock run"
              : selectedTask
                ? "Engineering Task"
                : "No task selected"}
        </span>
      </nav>
      <Heading />
      {selectedModel && <PendingApprovalBanner conversationId={selectedModel.conversationId} />}
      <Composer />
      {selectedMock && <span className="nv-sr-only" />}
      <div className="nv-split">
        <RecentTasks />
        <ActivityPanel />
      </div>
    </div>
  );

  function Heading() {
    if (selectedModel) return <ModelHeading />;
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
          <h1>Nexus workspace</h1>
          <p>
            Select a Controller task to inspect it, or describe a step below and run it through the
            isolated native mock workflow.
          </p>
        </div>
      </div>
    );
  }
}

function ModelHeading() {
  const { selectedModel } = useNexus();
  const id = selectedModel!.conversationId;
  const { status, reload } = useModelRunStatus(id, !selectedModel!.terminal);
  const state = status?.state ?? selectedModel!.state;
  const v = modelStateView(state);
  const kind = status?.endpointKind ?? selectedModel!.endpointKind;
  return (
    <div className="nv-heading">
      <div className="nv-heading__icon">
        <Bot size={20} aria-hidden="true" />
      </div>
      <div className="nv-heading__text">
        <h1>{selectedModel!.firstPrompt.split("\n")[0]!.slice(0, 90) || "Model run"}</h1>
        <p>
          {selectedModel!.providerId ?? "unknown provider"} / {selectedModel!.remoteModelId ?? "unknown model"}
          {" · "}
          {endpointLabel(kind)}
        </p>
        <div className="nv-heading__meta">
          <Badge tone={kind === "provider" ? "purple" : "warning"}>
            {kind === "provider" ? "Provider" : "Loopback fixture"}
          </Badge>
          <Badge tone={v.tone} icon={<StatusDot tone={v.tone} pulse={v.pulse} />}>
            {v.label}
          </Badge>
          {status?.cancelRequested && !status.terminal && <Badge tone="warning">Cancellation requested</Badge>}
          {status && <span className="nv-heading__updated">{usageLabel(status)}</span>}
        </div>
      </div>
      {status && <CancelModelRunButton status={status} onDone={reload} />}
    </div>
  );
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
