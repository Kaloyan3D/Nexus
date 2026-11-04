import type { DesktopCodeLimits } from "./contracts";

/**
 * Nexus applies NO limit of its own to how many steps, edits, commands, bytes or minutes a task may use: a long
 * engineering task is not an error. A limit exists only when the person set one (Settings) to bound their own cost
 * or time, and then it is shown as theirs.
 */
export const NO_LIMITS = "No limit on steps, edits or time — press Stop whenever you want.";

export function ownLimits(l: DesktopCodeLimits | null | undefined): string | null {
  if (!l) return null;
  const parts: string[] = [];
  if (l.maxTurns) parts.push(`${l.maxTurns} model turns`);
  if (l.maxToolCalls) parts.push(`${l.maxToolCalls} tool calls`);
  if (l.maxRuntimeSecs) parts.push(`${Math.max(1, Math.round(l.maxRuntimeSecs / 60))} min`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The sentence shown with a task: the person's own limits, or that there are none. */
export function limitsLine(l: DesktopCodeLimits | null | undefined): string {
  const own = ownLimits(l);
  return own ? `Your limits: ${own} (set in Settings).` : NO_LIMITS;
}

/** `turn 12` or, when the person chose a turn limit, `turn 12 of 60`. */
export function turnLabel(turn: number | undefined, max: number | undefined): string {
  return max ? `turn ${turn ?? 0} of ${max}` : `turn ${turn ?? 0}`;
}
