import type { ToolActivity } from "./contracts";
import { toolKind } from "./runKind";
import { refusalInfo, refusalLine } from "./refusal";

export type StepTone = "done" | "blocked" | "failed" | "uncertain" | "active";

export interface Step {
  key: string;
  tone: StepTone;
  /** Plain-language line. Built from receipts (status/approval/verdict), never from model text. */
  text: string;
  /** For a refused step: whether the task goes on and what the person can do (from the refusal code, never model text). */
  hint?: string;
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
  const r = refusalLine({ errorCode: code ?? null });
  if (r) return r;
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
  const s = describeStepText(a);
  const info = a.status === "refused" || a.status === "failed" ? refusalInfo(a.errorCode) : null;
  return info ? { ...s, hint: `${info.canContinue ? "The task goes on. " : ""}${info.action}` } : s;
}

function describeStepText(a: ToolActivity): Step {
  const kind = toolKind(a.tool);
  const key = `${a.index}`;
  if (a.status === "uncertain") return { key, tone: "uncertain", text: `${a.tool === "proc_run" ? "Command" : "Edit"} outcome unknown: ${target(a)}` };
  const blocked = stoppedAtApproval(a);
  if (kind === "read") {
    const verb = a.tool === "fs_list" ? "Listed" : a.tool === "fs_search" ? "Searched" : "Read";
    if (a.status === "executed") return { key, tone: "done", text: `${verb} ${target(a)}` };
    return { key, tone: "blocked", text: `${verb} ${target(a)} refused${a.errorCode ? ` (${a.errorCode})` : ""}${why(a.errorCode)}` };
  }
  if (kind === "write") {
    if (a.status === "executed" && a.postSha256) return { key, tone: "done", text: `Edit applied: ${target(a)}` };
    if (blocked) return { key, tone: "blocked", text: `Edit not applied (${approvalWords(a)}): ${target(a)}` };
    return { key, tone: "failed", text: `Edit not applied${a.errorCode ? ` (${a.errorCode})` : ""}: ${target(a)}${why(a.errorCode)}` };
  }
  if (kind === "command" && (a.checkClass === "filter-status" || a.checkClass === "filter-status-joined")) {
    // M4.7: `check | grep x` exited with the filter's "no line matched": neither a pass nor the check's failure
    return { key, tone: "uncertain", text: `Check piped into a line filter; exit ${a.exitCode ?? "?"} is the filter's, not the check's (not counted as passed or failed): ${a.argsSummary}` };
  }
  if (kind === "command" && a.checkClass === "unattested-joined") {
    return { key, tone: "uncertain", text: `Check ran inside a compound command again; same open check as before (not counted as verified): ${a.argsSummary}` };
  }
  if (kind === "command" && a.checkClass === "unattested-composition") {
    return { key, tone: "uncertain", text: `Check ran inside a compound command; its exit status cannot show it passed (not counted as verified): ${a.argsSummary}` };
  }
  if (kind === "command" && a.verification === "pass" && (a.resolvesFailed?.length ?? 0) > 0 && (a.resolvesHazards?.length ?? 0) === 0) {
    return { key, tone: "done", text: `Ran ${a.argsSummary} · passed · re-establishes the failed check${a.resolvesFailed!.length === 1 ? "" : "s"} of step${a.resolvesFailed!.length === 1 ? "" : "s"} ${a.resolvesFailed!.join(", ")}` };
  }
  if (kind === "command" && a.checkClass === "attested-recheck" && (a.resolvesHazards?.length ?? 0) > 0) {
    return { key, tone: "done", text: `Check re-established on its own · resolves the unattested check${a.resolvesHazards!.length === 1 ? "" : "s"} of step${a.resolvesHazards!.length === 1 ? "" : "s"} ${a.resolvesHazards!.join(", ")}` };
  }
  if (kind === "command" && a.checkClass === "invalid-invocation") {
    // the check failed before it looked at the project; it stays open until Nexus's own replacement passes
    return { key, tone: "uncertain", text: `Check could not run (invalid invocation, nothing was checked): ${a.argsSummary} — still unresolved` };
  }
  if (kind === "command" && a.checkClass === "controller-recheck" && a.verification === "pass") {
    return { key, tone: "done", text: `Nexus's replacement check passed · resolves the invalid check of step ${a.resolvesCheck ?? "?"}` };
  }
  if (kind === "command") {
    if (a.status === "executed" && a.verification === "pass") {
      // a pass over files that exist only in the command's own scratch copy is not a pass of the project
      const un = a.unsavedFiles ?? 0;
      return { key, tone: un > 0 ? "uncertain" : "done", text: `Ran ${a.argsSummary} · passed · exit ${a.exitCode ?? "?"}${un > 0 ? ` · it also wrote ${un} file${un === 1 ? "" : "s"} that ${un === 1 ? "was" : "were"} NOT saved to your project` : ""}` };
    }
    if (a.status === "executed" && a.verification === "fail") return { key, tone: "failed", text: `Ran ${a.argsSummary} · failed · exit ${a.exitCode ?? "?"}` };
    // an EXECUTED command that is not a verification check (the broker labels it `run-pass` / `run-fail`): it ran,
    // and its exit status is what it is. It must never be worded as "not run".
    if (a.status === "executed") {
      if (a.processClass === "executable-not-found") {
        return { key, tone: "uncertain", text: `Ran ${a.argsSummary} · exit ${a.exitCode ?? 127} · a program inside it does not exist in this runtime (not a permission decision)` };
      }
      if (a.processClass === "needs-network") {
        return { key, tone: "uncertain", text: `Ran ${a.argsSummary} · exit ${a.exitCode ?? "?"} · it needed the network, which ordinary commands do not have (dependencies come from a direct install command that you approve)` };
      }
      if (a.processClass === "not-executable") {
        return { key, tone: "uncertain", text: `Ran ${a.argsSummary} · exit ${a.exitCode ?? 126} · a program inside it cannot be executed` };
      }
      const code = a.exitCode;
      return { key, tone: "done", text: `Ran ${a.argsSummary} · exit ${code ?? "?"}${code === 0 ? "" : " (not a verification check)"}` };
    }
    if (blocked) return { key, tone: "blocked", text: `Command not run (${approvalWords(a)}): ${a.argsSummary}` };
    return { key, tone: "failed", text: `Command not run${a.errorCode ? ` (${a.errorCode})` : ""}: ${a.argsSummary}${why(a.errorCode)}` };
  }
  if (a.tool === "browser_inspect") {
    // M4.1: say what the browser did, from Nexus's own measurements, and whether anyone saw the page
    const b = a.browser;
    if (b && a.status === "executed") {
      const seen = b.imageDelivery === "delivered-to-vision-model" ? "screenshot shown to the model" : "screenshot NOT shown to the model";
      return { key, tone: b.imageDelivery === "delivered-to-vision-model" && b.pageErrors === 0 ? "done" : "uncertain", text: `Opened ${b.url} in a browser (${b.viewport} ${b.viewportW}×${b.viewportH}) · ${b.pageErrors} page error(s) · ${seen}` };
    }
    if (b) return { key, tone: "failed", text: `Browser could not inspect ${b.url}: ${b.error ?? "no page"}` };
    return { key, tone: "failed", text: `Browser request refused${a.errorCode ? ` (${a.errorCode})` : ""}: ${a.argsSummary}` };
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
    case "permission-pending":
      return pendingTarget ? `Waiting for your decision: ${pendingTarget}` : "Waiting for your decision";
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
