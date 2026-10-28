import type { IntentRun, ToolActivity } from "./contracts";

/**
 * Who stopped something and what the person can do about it. A refusal is never shown as a generic "budget": the
 * source says whether it was Nexus (a rule that protects your files or a limit of ONE operation), the sandbox, your
 * own permissions, your own request (Review only), or the provider.
 */
export type RefusalSource = "nexus" | "sandbox" | "permission" | "request" | "provider";

export interface RefusalInfo {
  source: RefusalSource;
  /** What happened, in plain words. */
  why: string;
  /** Can the task carry on (usually yes: the model is told and tries something else)? */
  canContinue: boolean;
  /** What the person can do. */
  action: string;
}

const SOURCE_WORDS: Record<RefusalSource, string> = {
  nexus: "Nexus",
  sandbox: "the sandbox",
  permission: "your permissions",
  request: "your request",
  provider: "the provider",
};
export const sourceWords = (s: RefusalSource): string => SOURCE_WORDS[s];

const INFO: Record<string, RefusalInfo> = {
  "read-only-request": { source: "request", why: "this task was started as Review only, so Nexus may not change files", canContinue: true, action: "Send your next message with “Make changes” if you want edits." },
  "no-grant": { source: "permission", why: "this project does not allow Nexus to run commands in it yet", canContinue: true, action: "Allow commands in the project; the card offers it." },
  "grant-inactive": { source: "permission", why: "the project's permissions ended (revoked or expired)", canContinue: true, action: "Allow them again in Projects." },
  "dev-port-not-authorized": { source: "permission", why: "a preview was asked for on a port you have not allowed", canContinue: true, action: "Allow that port; the card offers it." },
  "path-not-in-scope": { source: "permission", why: "that file is outside the part of the project Nexus may change", canContinue: true, action: "Widen the project's write scope, or let the model choose another place." },
  "hidden-path-refused": { source: "nexus", why: "that is a protected path (hidden, credential-like or version-control internals)", canContinue: true, action: "Nothing to do; Nexus never writes these." },
  "sensitive-path-refused": { source: "nexus", why: "that is a credential-like path", canContinue: true, action: "Nothing to do; Nexus never writes these." },
  "symlink-refused": { source: "nexus", why: "symbolic links are never followed", canContinue: true, action: "Nothing to do." },
  "policy-refused": { source: "nexus", why: "the workspace policy does not allow this operation", canContinue: true, action: "Nothing to do; the model chooses another way." },
  "invalid-arguments": { source: "nexus", why: "the request was malformed or larger than ONE operation allows (a single write or edit call has a size limit, the task does not)", canContinue: true, action: "Nothing to do; the model splits the work into several operations." },
  "file-too-large": { source: "nexus", why: "that one file is larger than a single operation can safely rewrite", canContinue: true, action: "The model can split it into smaller files." },
  conflict: { source: "nexus", why: "the file changed since it was read (or the edit did not match)", canContinue: true, action: "Nothing to do; the model reads it again." },
  "not-found": { source: "nexus", why: "the file or folder does not exist", canContinue: true, action: "Nothing to do." },
  "too-many-refused-tool-calls": { source: "nexus", why: "the model kept repeating a call that is refused every time, so it was going in circles", canContinue: true, action: "Send a message saying what to do differently; the work so far is kept." },
  "approval-denied": { source: "permission", why: "the operation was not approved", canContinue: true, action: "Allow it, or tell the model to do it another way." },
};

export function refusalInfo(code: string | null | undefined): RefusalInfo | null {
  return code ? (INFO[code] ?? null) : null;
}

/** One line for a refused step, with the source and what to do. */
export function refusalLine(a: Pick<ToolActivity, "errorCode">): string {
  const i = refusalInfo(a.errorCode);
  return i ? ` — ${sourceWords(i.source)}: ${i.why}` : "";
}

/** A run that stopped at a limit the PERSON chose (Nexus has none of its own). */
export function stopNote(run: Pick<IntentRun, "stopReason" | "maxTurns" | "maxToolCalls"> | null | undefined): string | null {
  switch (run?.stopReason) {
    case "max-turns":
      return `This run stopped at the limit you set (${run.maxTurns ?? "?"} model turns). Nothing is lost: send a message to carry on, or remove the limit in Settings.`;
    case "max-tool-calls":
      return `This run stopped at the limit you set (${run.maxToolCalls ?? "?"} tool calls). Nothing is lost: send a message to carry on, or remove the limit in Settings.`;
    case "max-runtime":
      return "This run stopped at the time limit you set. Nothing is lost: send a message to carry on, or remove the limit in Settings.";
    case "output-limit":
      return "The model's answer was cut off by the provider's output limit for one response. Send a message to carry on; Nexus will ask for the rest in smaller pieces.";
    default:
      return null;
  }
}
