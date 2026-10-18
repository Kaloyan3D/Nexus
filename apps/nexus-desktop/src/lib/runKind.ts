import type { CodingOutcome, IntentRun } from "./contracts";

/** What the user asked Nexus to do. Never inferred from text: it is the broker's intent type. */
export type RunKind = "ask" | "inspect" | "code";

export function runKind(run: IntentRun | null | undefined): RunKind {
  if (run?.intentType === "repo-code") return "code";
  if (run?.intentType === "repo-inspect") return "inspect";
  return "ask";
}

export const KIND_BADGE: Record<RunKind, string> = { ask: "ASK", inspect: "INSPECT", code: "CODE" };
export const KIND_GROUP: Record<RunKind, string> = {
  code: "Code in copy · edits and commands need independent approval",
  inspect: "Inspect · read-only repository tools",
  ask: "Ask · text only",
};
export const KIND_CRUMB: Record<RunKind, string> = { ask: "Ask run", inspect: "Inspection run", code: "Coding run" };

export type OutcomeTone = "success" | "error" | "warning" | "neutral";

export interface OutcomeView {
  label: string;
  tone: OutcomeTone;
  /** One honest sentence for the details panel. */
  detail: string;
}

function blockedWords(run: IntentRun): string {
  const outcomes = new Set(
    (run.toolActivity ?? [])
      .filter((a) => (a.tool === "fs_edit" || a.tool === "fs_write" || a.tool === "proc_run") && a.status !== "executed" && a.approvalOutcome && a.approvalOutcome !== "approved")
      .map((a) => a.approvalOutcome as string),
  );
  if (outcomes.size === 0) return "approval not granted";
  return `approval ${Array.from(outcomes).join(" / ")}`;
}

/**
 * The verified outcome of a coding run, in words. Everything here comes from the
 * broker's receipt-derived `codingOutcome`; the model's final text is never consulted.
 * A run with no reported outcome (older broker) is shown as UNREPORTED, never as passed.
 */
export function outcomeView(run: IntentRun | null | undefined): OutcomeView | null {
  if (!run || run.intentType !== "repo-code") return null;
  if (run.continuedAs) {
    return { label: "Interrupted · continued automatically", tone: "warning", detail: "The runtime was interrupted. Nexus carried this run's changes into a new run and carried on there." };
  }
  const o: CodingOutcome | null | undefined = run.codingOutcome;
  if (!o) return { label: "Outcome not reported", tone: "warning", detail: "This broker did not report a verified outcome; nothing is assumed." };
  const applied = o.editsApplied;
  if (o.verification === "uncertain" || o.change === "uncertain") {
    return {
      label: "Coding outcome uncertain",
      tone: "error",
      detail: "An operation may or may not have happened and its result was not recorded. Review the working copy; nothing was repeated.",
    };
  }
  switch (o.verification) {
    case "verified-passed":
      return {
        label: o.change === "not-applied" || o.change === "none-proposed" ? "Tests passed · no change applied" : `Tests passed · exit ${o.lastExitCode ?? "?"}`,
        tone: o.change === "not-applied" || o.change === "none-proposed" ? "warning" : "success",
        detail: `${applied} edit(s) applied and ${o.testsExecuted} command(s) executed; the last command exited ${o.lastExitCode ?? "without a code"}. This verifies the command, not that every requirement is met.`,
      };
    case "verified-failed":
      return { label: `Tests failed · exit ${o.lastExitCode ?? "?"}`, tone: "error", detail: "The last executed test command failed." };
    case "blocked-by-approval":
      return {
        label: `${run.terminal ? "Blocked" : "Waiting"} · ${blockedWords(run)} · not executed`,
        tone: "warning",
        detail: `${o.blockedByApproval} operation(s) stopped at the approval boundary: ${o.editsNotApplied} edit(s) not applied, ${o.testsNotExecuted} command(s) not executed.`,
      };
    case "no-test-executed":
      return {
        label: applied > 0 ? "Changes applied · no test executed" : "No change applied · no test executed",
        tone: "warning",
        detail: "No test command was executed, so nothing about correctness is verified.",
      };
    default:
      return {
        label: run.terminal ? (applied > 0 ? "Model completed · changes unverified" : "Model completed · nothing verified") : "Not yet verified",
        tone: "neutral",
        detail: o.staleAfterEdit ? "The last test ran before the last applied edit, so it does not verify the current state." : "No verifying evidence yet.",
      };
  }
}

/** Display-only wording fix for old transcripts that call every tool proposal read-only. */
export function normalizeEventText(text: string, kind: RunKind): string {
  if (kind !== "code") return text;
  return text.replace(/^Model proposed (\d+) read-only tool call\(s\); validating\.$/, "Model proposed $1 tool call(s); every edit and command still needs an independent approval; validating.");
}

export type ToolKind = "read" | "write" | "command" | "unknown";

/** What a model-proposed tool does, by its fixed name: only the three list/read/search tools are read-only. */
export function toolKind(tool: string): ToolKind {
  if (tool === "fs_list" || tool === "fs_read" || tool === "fs_search") return "read";
  if (tool === "fs_write" || tool === "fs_edit") return "write";
  if (tool === "proc_run") return "command";
  return "unknown";
}
