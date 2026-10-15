import type { ToolChange, ToolEventStatus, ToolEventV1 } from "./contracts";

export type ToolEventTone = "neutral" | "progress" | "success" | "warning" | "danger";

const short = (h: string | null | undefined) => (h ? h.slice(0, 10) : "none");

/**
 * Honest description of what is known about the file after a write event.
 * Never claims "no changes" unless the backend recorded `mutation: none`.
 */
/** Write approvals that were not provably independent are test-only. */
export function approvalNote(c: ToolChange | null | undefined, scope: string): string | null {
  if (scope !== "write") return null;
  if (c?.approverIndependent === false) return "test-only approval (not independent)";
  if (c?.approverIndependent === true) return "independently approved";
  return "approval state not recorded";
}

export function describeMutation(c: ToolChange | null | undefined): string | null {
  if (!c || !c.mutation) return null;
  switch (c.mutation) {
    case "none":
      return c.preservedAs
        ? `no change published; a conflicting file was preserved as ${c.preservedAs}`
        : "no file was changed";
    case "applied":
      return "change applied and verified";
    case "applied-unverified":
      return "change was published but not verified";
    case "published-unverified":
      return "change was published; verification did not match";
    default:
      return "outcome uncertain: the file may have been changed";
  }
}

/** Pure presentation mapping for tool records in Conversation/Activity. */
export function toolEventPresentation(e: ToolEventV1): {
  tone: ToolEventTone;
  label: string;
  summary: string;
  change: string | null;
  requiresApproval: boolean;
} {
  const tone: Record<ToolEventStatus, ToolEventTone> = {
    authorized: "neutral",
    started: "progress",
    planned: "progress",
    prepared: "progress",
    applied: "warning",
    verified: "success",
    conflict: "danger",
    completed: e.truncated ? "warning" : "success",
    failed: "danger",
    interrupted: "warning",
    expired: "neutral",
    cancelled: "warning",
  };
  const path =
    (typeof e.change?.path === "string" && e.change.path) ||
    (typeof e.args?.path === "string" ? (e.args.path as string) : ".");
  const op = e.change?.operation;
  const what =
    e.toolId === "fs.search"
      ? `search in ${path}`
      : e.scope === "write"
        ? `${op ?? e.toolId.slice(3)} ${path}`
        : `${e.toolId.slice(3)} ${path}`;
  const detail =
    e.status === "failed" || e.status === "conflict"
      ? ` — ${e.status === "conflict" ? "conflict" : "refused"}: ${e.change?.conflict ?? e.errorCode ?? "error"}`
      : e.truncated
        ? ` — truncated (${e.truncationReasons.join(", ")})`
        : "";
  const red = e.redacted ? ` [redacted: ${e.redactionKinds.join(", ")}]` : "";
  const c = e.change;
  const change =
    e.scope === "write" && c
      ? `${short(c.preSha256)} → ${short(c.postSha256)}${c.postBytes !== undefined ? ` · ${c.postBytes} B` : ""}`
      : null;
  return {
    tone: tone[e.status],
    label: e.status,
    summary: what + detail + red,
    change,
    // A write that has not reached a terminal state is awaiting (or
    // proceeding under) the independently approved scope; the renderer can
    // only display this, never grant it.
    requiresApproval: e.scope === "write" && ["authorized", "started", "planned"].includes(e.status),
  };
}
