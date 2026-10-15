import type { ToolEventStatus, ToolEventV1 } from "./contracts";

export type ToolEventTone = "neutral" | "progress" | "success" | "warning" | "danger";

/** Pure presentation mapping for tool records in Conversation/Activity. */
export function toolEventPresentation(e: ToolEventV1): {
  tone: ToolEventTone;
  label: string;
  summary: string;
} {
  const tone: Record<ToolEventStatus, ToolEventTone> = {
    authorized: "neutral",
    started: "progress",
    completed: e.truncated ? "warning" : "success",
    failed: "danger",
    interrupted: "warning",
    expired: "neutral",
    cancelled: "warning",
  };
  const path = typeof e.args?.path === "string" ? (e.args.path as string) : ".";
  const what = e.toolId === "fs.search" ? `search in ${path}` : `${e.toolId.slice(3)} ${path}`;
  const detail =
    e.status === "failed"
      ? ` — refused: ${e.errorCode ?? "error"}`
      : e.truncated
        ? ` — truncated (${e.truncationReasons.join(", ")})`
        : "";
  const red = e.redacted ? ` [redacted: ${e.redactionKinds.join(", ")}]` : "";
  return { tone: tone[e.status], label: e.status, summary: what + detail + red };
}
