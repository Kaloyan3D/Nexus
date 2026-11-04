import type { TranscriptEvent } from "./contracts";

export interface CommandOutput {
  callId: string | null;
  exitCode: number | null;
  reason: string | null;
  signal: number | null;
  verification: string | null;
  wallMs: number | null;
  stdoutTail: string;
  stderrTail: string;
  /** The tool result was an error (the command did not run) rather than an execution result. */
  notRun: { code: string | null; message: string | null } | null;
}

/**
 * Bounded, redacted command output exactly as the broker recorded and returned it to
 * the model (`proc_run` tool results in the run's own transcript, served only to the
 * run's owner). This is evidence about the COMMAND; the run's verified verdict comes
 * from the execution receipts, never from parsing this text.
 */
export function commandOutputs(events: TranscriptEvent[]): CommandOutput[] {
  const out: CommandOutput[] = [];
  for (const e of events) {
    if (e.kind !== "tool-result" || e.toolName !== "proc_run" || !e.text) continue;
    try {
      const j = JSON.parse(e.text) as Record<string, unknown>;
      const err = (j.error ?? null) as { code?: string; message?: string } | null;
      out.push({
        callId: e.toolCallId ?? null,
        exitCode: typeof j.exitCode === "number" ? j.exitCode : null,
        reason: typeof j.reason === "string" ? j.reason : null,
        signal: typeof j.signal === "number" ? j.signal : null,
        verification: typeof j.verification === "string" ? j.verification : null,
        wallMs: typeof j.wallMs === "number" ? j.wallMs : null,
        stdoutTail: typeof j.stdoutTail === "string" ? j.stdoutTail : "",
        stderrTail: typeof j.stderrTail === "string" ? j.stderrTail : "",
        notRun: err || j.status === "refused" || j.status === "error" ? { code: err?.code ?? null, message: err?.message ?? null } : null,
      });
    } catch {
      out.push({ callId: e.toolCallId ?? null, exitCode: null, reason: null, signal: null, verification: null, wallMs: null, stdoutTail: "", stderrTail: "", notRun: { code: "unparsable", message: "The recorded result could not be read." } });
    }
  }
  return out;
}
