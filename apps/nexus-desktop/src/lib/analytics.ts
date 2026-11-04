import type { RunAnalytics } from "./contracts";

/** "Unavailable" is what the person sees for a metric the run could not measure; it is never zero. */
export const UNAVAILABLE = "Unavailable";

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return UNAVAILABLE;
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, "0")}s`;
}

export const fmtNum = (n: number | null | undefined): string => (n == null ? UNAVAILABLE : n.toLocaleString("en-US"));

export const fmtPct = (r: number | null | undefined): string => (r == null ? UNAVAILABLE : `${(r * 100).toFixed(1)}%`);

export function fmtCost(a: RunAnalytics["cost"]): { text: string; kind: "actual" | "estimated" | "unknown" } {
  if (a.display === "actual" && a.actual.usd != null) return { text: `$${a.actual.usd.toFixed(4)}`, kind: "actual" };
  if (a.display === "estimated" && a.estimated.usd != null) return { text: `~$${a.estimated.usd.toFixed(4)}`, kind: "estimated" };
  return { text: "Unknown", kind: "unknown" };
}

/** Shares of the wall clock for the mutually exclusive categories (null when the run could not measure them). */
export function shares(a: RunAnalytics): Array<{ key: string; label: string; ms: number; pct: number }> | null {
  const c = a.runtime.categoriesExclusive;
  const wall = a.runtime.wallMs;
  if (wall == null || wall <= 0 || c.modelRequestMs == null || c.toolExecutionMs == null || c.approvalWaitMs == null || c.controllerMs == null) return null;
  const rows = [
    { key: "model", label: "Model requests", ms: c.modelRequestMs },
    { key: "tool", label: "Tool execution", ms: c.toolExecutionMs },
    { key: "approval", label: "Approval / permission wait", ms: c.approvalWaitMs },
    { key: "controller", label: "Controller & other", ms: c.controllerMs },
  ];
  const total = rows.reduce((s, r) => s + r.ms, 0) || 1;
  return rows.map((r) => ({ ...r, pct: (r.ms / total) * 100 }));
}

/** Is there enough data for the compact summary to mean something? */
export const hasSomething = (a: RunAnalytics): boolean => a.tokens.input != null || a.runtime.wallMs != null || a.tools.recordedCalls > 0;
