import type { ToolActivity } from "./contracts";
import { toolKind } from "./runKind";

export type StepTone = "done" | "blocked" | "failed" | "uncertain" | "active";

export interface Step {
  key: string;
  tone: StepTone;
  /** Plain-language line. Built from receipts (status/approval/verdict), never from model text. */
  text: string;
}

function target(a: ToolActivity): string {
  // argsSummary is "path=src/lib.rs start=1 max=400" or "edit src/lib.rs" or "cargo test --offline"
  const m = /path=(\S+)/.exec(a.argsSummary);
  if (m) return m[1]!;
  return a.argsSummary.replace(/^(edit|write)\s+/, "");
}

/** One plain-language progress step per model-proposed tool call. */
export function describeStep(a: ToolActivity): Step {
  const kind = toolKind(a.tool);
  const key = `${a.index}`;
  if (a.status === "uncertain") return { key, tone: "uncertain", text: `${a.tool === "proc_run" ? "Command" : "Edit"} outcome unknown: ${target(a)}` };
  const blocked = a.status !== "executed" && a.approvalOutcome && a.approvalOutcome !== "approved";
  if (kind === "read") {
    const verb = a.tool === "fs_list" ? "Listed" : a.tool === "fs_search" ? "Searched" : "Read";
    if (a.status === "executed") return { key, tone: "done", text: `${verb} ${target(a)}` };
    return { key, tone: "blocked", text: `${verb} ${target(a)} refused${a.errorCode ? ` (${a.errorCode})` : ""}` };
  }
  if (kind === "write") {
    if (a.status === "executed" && a.postSha256) return { key, tone: "done", text: `Edit applied: ${target(a)}` };
    if (blocked) return { key, tone: "blocked", text: `Edit not applied (approval ${a.approvalOutcome}): ${target(a)}` };
    return { key, tone: "failed", text: `Edit not applied${a.errorCode ? ` (${a.errorCode})` : ""}: ${target(a)}` };
  }
  if (kind === "command") {
    if (a.status === "executed" && a.verification === "pass") return { key, tone: "done", text: `Ran ${a.argsSummary} · passed · exit ${a.exitCode ?? "?"}` };
    if (a.status === "executed" && a.verification === "fail") return { key, tone: "failed", text: `Ran ${a.argsSummary} · failed · exit ${a.exitCode ?? "?"}` };
    if (blocked) return { key, tone: "blocked", text: `Command not run (approval ${a.approvalOutcome}): ${a.argsSummary}` };
    return { key, tone: "failed", text: `Command not run${a.errorCode ? ` (${a.errorCode})` : ""}: ${a.argsSummary}` };
  }
  if (a.tool === "muse_update_reasoning_state") {
    // A control-plane CLAIM from the model (phase, findings). It changes no file and never sets an effort: the host's
    // limiter owns the reasoning effort. Executed means the claim was accepted and recorded, not that anything ran.
    if (a.status === "executed") return { key, tone: "done", text: `Reported reasoning state${a.argsSummary ? ` (${a.argsSummary})` : ""}` };
    return { key, tone: "blocked", text: `Reasoning-state report not accepted${a.errorCode ? ` (${a.errorCode})` : ""}` };
  }
  if (a.status === "executed") return { key, tone: "done", text: `Used ${a.tool}` };
  return { key, tone: "failed", text: `${a.tool} refused${a.errorCode ? ` (${a.errorCode})` : ""}` };
}

/** What the run is doing right now, from the lifecycle state and the pending approval. */
export function nowLine(state: string, pendingTarget: string | null): string {
  switch (state) {
    case "approval-pending":
      return pendingTarget ? `Waiting for your independent approval of ${pendingTarget}` : "Waiting for an independent approval";
    case "tool-running":
      return "Running a tool call";
    case "streaming":
      return "The model is answering";
    case "request-started":
    case "executing":
    case "preparing":
    case "accepted":
      return "Waiting for the model";
    default:
      return state.replace(/-/g, " ");
  }
}

export function countSteps(acts: ToolActivity[]): { reads: number; edits: number; commands: number } {
  let reads = 0, edits = 0, commands = 0;
  for (const a of acts) {
    const k = toolKind(a.tool);
    if (k === "read") reads++;
    else if (k === "write") edits++;
    else if (k === "command") commands++;
  }
  return { reads, edits, commands };
}
