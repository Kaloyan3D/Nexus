import type { ToolActivity } from "./contracts";
import { toolKind } from "./runKind";

export type StepTone = "done" | "blocked" | "failed" | "uncertain" | "active";

export interface Step {
  key: string;
  tone: StepTone;
  /** Plain-language line. Built from receipts (status/approval/verdict), never from model text. */
  text: string;
}

/** Plain words for the error codes a tool refusal carries (the code itself is always shown too). */
const CODE_WORDS: Record<string, string> = {
  "not-found": "the file or folder does not exist",
  conflict: "the file changed since it was read, or the edit did not match",
  "hidden-path-refused": "a protected path",
  "sensitive-path-refused": "a credential-like path",
  "symlink-refused": "symbolic links are never followed",
  "path-invalid": "the path is not a valid project path",
  "invalid-arguments": "the request was not valid",
  "file-too-large": "the file is too large",
  "policy-refused": "the workspace policy does not allow it",
  "not-a-directory": "a part of the path is not a folder",
};

function why(code: string | null | undefined): string {
  return code && CODE_WORDS[code] ? ` — ${CODE_WORDS[code]}` : "";
}

/** Stopped at the approval boundary: an approver or the policy said no, or it timed out. A request refused BEFORE any
 *  approval existed (missing folder, changed file, protected path) failed on its own error code; it is not an approval decision. */
function stoppedAtApproval(a: ToolActivity): boolean {
  const o = a.approvalOutcome;
  return a.status !== "executed" && !!o && o !== "approved" && (o !== "refused" || a.errorCode === "policy-refused");
}

function approvalWords(a: ToolActivity): string {
  return a.approvalOutcome === "refused" ? "refused by the workspace policy" : `approval ${a.approvalOutcome}`;
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
  const blocked = stoppedAtApproval(a);
  if (kind === "read") {
    const verb = a.tool === "fs_list" ? "Listed" : a.tool === "fs_search" ? "Searched" : "Read";
    if (a.status === "executed") return { key, tone: "done", text: `${verb} ${target(a)}` };
    return { key, tone: "blocked", text: `${verb} ${target(a)} refused${a.errorCode ? ` (${a.errorCode})` : ""}` };
  }
  if (kind === "write") {
    if (a.status === "executed" && a.postSha256) return { key, tone: "done", text: `Edit applied: ${target(a)}` };
    if (blocked) return { key, tone: "blocked", text: `Edit not applied (${approvalWords(a)}): ${target(a)}` };
    return { key, tone: "failed", text: `Edit not applied${a.errorCode ? ` (${a.errorCode})` : ""}: ${target(a)}${why(a.errorCode)}` };
  }
  if (kind === "command") {
    if (a.status === "executed" && a.verification === "pass") {
      // a pass over files that exist only in the command's own scratch copy is not a pass of the project
      const un = a.unsavedFiles ?? 0;
      return { key, tone: un > 0 ? "uncertain" : "done", text: `Ran ${a.argsSummary} · passed · exit ${a.exitCode ?? "?"}${un > 0 ? ` · it also wrote ${un} file${un === 1 ? "" : "s"} that ${un === 1 ? "was" : "were"} NOT saved to your project` : ""}` };
    }
    if (a.status === "executed" && a.verification === "fail") return { key, tone: "failed", text: `Ran ${a.argsSummary} · failed · exit ${a.exitCode ?? "?"}` };
    if (blocked) return { key, tone: "blocked", text: `Command not run (${approvalWords(a)}): ${a.argsSummary}` };
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
