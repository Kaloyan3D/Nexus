import type { ThreadRunView } from "./contracts";
import { outcomeView } from "./runKind";

/**
 * The six things a finished (or stopped) run can honestly be. Every one is derived from the runtime's
 * receipts - what actually executed, what was refused, what the recorded commands returned. The model's own
 * summary is never consulted, and "verified" is only ever said when a recorded command passed.
 */
export type ResultCategory =
  | "verified" // a recorded command passed (or a read-only run changed nothing)
  | "unverified" // finished, but nothing independently confirms it, or a claimed command never ran
  | "failed" // checks failed, an operation failed, or the outcome is uncertain
  | "refused" // the work was stopped at a boundary (an approval, a permission)
  | "stopped" // cancelled or interrupted by the person or by a restart
  | "unavailable"; // this computer or installation cannot do what was asked

export const RESULT_WORD: Record<ResultCategory, string> = {
  verified: "Verified",
  unverified: "Not verified",
  failed: "Failed",
  refused: "Refused",
  stopped: "Stopped",
  unavailable: "Unavailable",
};

export interface ResultView {
  category: ResultCategory;
  label: string;
  tone: "success" | "warning" | "error" | "neutral";
  detail: string;
}

/** Run endings that mean the machine or installation cannot do the thing, as opposed to the work failing. */
const UNAVAILABLE_CODES = new Set(["not-available", "sandbox-unavailable", "provider-unavailable", "model-unavailable", "no-grant", "grant-inactive", "runtime-updating"]);

/** What the runtime verified about THIS run (its receipts) - never the conversation's state. */
export function runResult(r: ThreadRunView): ResultView | null {
  const run = r.run;
  if (!run) return null;
  // A run still in progress has no result yet: the live progress section says what it is doing.
  if (!run.terminal && run.state !== "completed") return null;
  if (r.readOnly) {
    const wrote = (run.toolActivity ?? []).some((a) => (a.tool === "fs_write" || a.tool === "fs_edit") && a.status === "executed");
    const tried = (run.toolActivity ?? []).filter((a) => (a.tool === "fs_write" || a.tool === "fs_edit") && a.status === "refused").length;
    if (wrote) return { category: "failed", label: "Read-only run changed a file — report this", tone: "error", detail: "The runtime recorded an executed edit in a read-only run." };
    return {
      category: "verified",
      label: tried > 0 ? `Read-only · ${tried} edit attempt${tried === 1 ? "" : "s"} refused · no file changed` : "Read-only · no file changed",
      tone: "success",
      detail: "The runtime refuses every edit and write in a read-only request.",
    };
  }
  if (run.state === "cancelled") {
    const v = outcomeView(run);
    // The recorded result stays as it is; only the wording stops implying the task was finished.
    return {
      category: "stopped",
      label: v ? v.label.replace(/^Tests passed/, "Last test command passed").replace(/^Tests failed/, "Last test command failed") : "Cancelled",
      tone: v?.tone ?? "neutral",
      detail: `${v ? `${v.detail} ` : ""}The run was cancelled before it finished: this is not a completed task.`,
    };
  }
  if (run.continuedAs) {
    const v = outcomeView(run);
    return { category: "stopped", label: v?.label ?? "Interrupted · continued automatically", tone: "warning", detail: v?.detail ?? "The runtime was interrupted and the work continued in a new run." };
  }
  if (run.state === "failed" || run.state === "timed-out") {
    const unavailable = run.errorCode != null && UNAVAILABLE_CODES.has(run.errorCode);
    return {
      category: unavailable ? "unavailable" : "failed",
      label: unavailable ? "Unavailable · nothing was done" : `Failed${run.errorCode ? ` · ${run.errorCode}` : ""}`,
      tone: unavailable ? "warning" : "error",
      detail: run.errorMessage ?? run.completionNote ?? (unavailable ? "This computer or installation cannot do what was asked." : "The run ended with an error."),
    };
  }
  // The task asked for an implementation: say what the runtime found, not what the model said.
  if (run.completion === "incomplete") {
    const kept = run.codingOutcome?.editsApplied ?? 0;
    return {
      category: "unverified",
      label: kept > 0 ? `Incomplete · ${kept} change${kept === 1 ? "" : "s"} kept, work not finished` : "Incomplete · nothing changed, nothing verified",
      tone: "warning",
      detail: run.completionNote ?? "The model ended before finishing the work.",
    };
  }
  if (run.completion === "failing-checks") {
    const n = run.unresolvedFailedChecks ?? run.codingOutcome?.checksFailedUnresolved ?? 0;
    return {
      category: "failed",
      label: `Changes made · ${n || "some"} check${n === 1 ? "" : "s"} failed, not verified`,
      tone: "warning",
      detail: run.completionNote ?? "Verification commands failed and were never re-run successfully; the change is blocked or unverified, not passed.",
    };
  }
  if (run.completion === "unexecuted-claims") {
    return { category: "unverified", label: "Not verified · a command did not run", tone: "warning", detail: run.completionNote ?? "A command in this run was refused, failed or never executed, so its claimed result is not evidence. Passing checks elsewhere in the run do not cover it." };
  }
  if (run.completion === "no-change-reported") {
    return { category: "unverified", label: "Completed · no change was made", tone: "warning", detail: "The request asked for an implementation, but no file was changed and no check ran. Read the answer to see why." };
  }
  if (run.completion === "no-change-verified") {
    return { category: "verified", label: "No change needed · checks passed", tone: "success", detail: "Nothing was changed; the relevant check passed (a verified no-op)." };
  }
  const v = outcomeView(run);
  if (!v) return null;
  const verification = run.codingOutcome?.verification;
  const category: ResultCategory =
    v.tone === "success"
      ? "verified"
      : verification === "blocked-by-approval"
        ? "refused"
        : verification === "verified-failed" || verification === "verified-mixed" || verification === "uncertain" || run.codingOutcome?.change === "uncertain"
          ? "failed"
          : "unverified";
  return { category, label: v.label, tone: v.tone, detail: v.detail };
}
