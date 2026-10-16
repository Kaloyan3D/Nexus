import type { ModelRunStatus } from "./contracts";

export type RunTone = "success" | "purple" | "warning" | "error" | "neutral";

/** Presentation of the durable run state. No state is ever invented. */
export function modelStateView(state: string): { label: string; tone: RunTone; pulse: boolean } {
  switch (state) {
    case "received":
    case "preparing":
      return { label: "Preparing request", tone: "purple", pulse: true };
    case "executing":
      return { label: "Running", tone: "purple", pulse: true };
    case "rejected":
      return { label: "Rejected (nothing sent)", tone: "error", pulse: false };
    case "abandoned":
      return { label: "Abandoned (nothing sent)", tone: "warning", pulse: false };
    case "accepted":
      return { label: "Accepted", tone: "purple", pulse: true };
    case "target-selected":
      return { label: "Target selected", tone: "purple", pulse: true };
    case "authorized":
      return { label: "Authorized", tone: "purple", pulse: true };
    case "request-started":
      return { label: "Request sent", tone: "purple", pulse: true };
    case "streaming":
      return { label: "Streaming", tone: "purple", pulse: true };
    case "tool-running":
      return { label: "Running read-only tools", tone: "purple", pulse: true };
    case "approval-pending":
      return { label: "Waiting for an independent approver", tone: "warning", pulse: true };
    case "limit-reached":
      return { label: "Stopped at a limit", tone: "warning", pulse: false };
    case "completed":
      return { label: "Completed", tone: "success", pulse: false };
    case "cancelled":
      return { label: "Cancelled", tone: "warning", pulse: false };
    case "timed-out":
      return { label: "Timed out", tone: "warning", pulse: false };
    case "uncertain":
      return { label: "Outcome uncertain", tone: "warning", pulse: false };
    case "refused":
      return { label: "Refused (nothing sent)", tone: "error", pulse: false };
    case "provider-failed":
      return { label: "Provider failed", tone: "error", pulse: false };
    case "failed":
      return { label: "Failed", tone: "error", pulse: false };
    default:
      return { label: state, tone: "neutral", pulse: false };
  }
}

/** Truthful endpoint label: a loopback fixture is never presented as a provider. */
export function endpointLabel(kind: string | null): string {
  if (kind === "provider") return "Provider endpoint";
  if (kind === "loopback-test-double") return "Loopback test double (not a real provider)";
  return "Endpoint not recorded";
}

export function usageLabel(s: Pick<ModelRunStatus, "usageInputTokens" | "usageOutputTokens">): string {
  if (s.usageInputTokens === null && s.usageOutputTokens === null) {
    return "Usage not reported by the provider";
  }
  return `${s.usageInputTokens ?? "?"} in · ${s.usageOutputTokens ?? "?"} out tokens (provider-reported)`;
}
