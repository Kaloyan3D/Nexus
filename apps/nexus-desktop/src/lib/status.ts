import type { Tone } from "../components/ui/primitives";

export interface StatusView {
  label: string;
  tone: Tone;
  pulse: boolean;
}

/** Maps Controller ledger statuses to presentation. Unknown values pass through verbatim. */
export function taskStatusView(status: string): StatusView {
  const s = status.toLowerCase();
  const label = status.length ? status[0]!.toUpperCase() + status.slice(1).replace(/[-_]/g, " ") : "Unknown";
  if (["implementing", "running", "in_progress", "in-progress", "reviewing", "verifying"].includes(s))
    return { label, tone: "purple", pulse: true };
  if (["failed", "error", "blocked", "rejected", "abandoned"].includes(s))
    return { label, tone: "error", pulse: false };
  if (["completed", "done", "verified", "merged", "accepted", "passed"].includes(s))
    return { label, tone: "success", pulse: false };
  if (["ready", "pending", "queued", "created"].includes(s))
    return { label, tone: "neutral", pulse: false };
  return { label, tone: "neutral", pulse: false };
}
