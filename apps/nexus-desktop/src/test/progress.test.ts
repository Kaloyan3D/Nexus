import { describe, expect, it } from "vitest";
import { describeStep } from "../lib/progress";
import type { ToolActivity } from "../lib/contracts";
import { outcomeView } from "../lib/runKind";
import { fakeRun } from "./fakeApi";

const act = (over: Partial<ToolActivity>): ToolActivity =>
  ({ index: 1, turn: 1, callId: "c", tool: "muse_update_reasoning_state", argsSummary: "phase=discover", status: "executed", errorCode: null, resultBytes: 1, resultDigest: null, truncated: false, executionId: null, journalSeq: null, argsDigest: null, ...over }) as ToolActivity;

describe("reasoning-state reports (owner finding B)", () => {
  it("an accepted report is shown as a report, never as a refused tool", () => {
    const s = describeStep(act({}));
    expect(s.text).toBe("Reported reasoning state (phase=discover)");
    expect(s.tone).toBe("done");
    expect(s.text).not.toMatch(/refused/);
  });
  it("a report the host did not accept is still shown as not accepted, with its code", () => {
    const s = describeStep(act({ status: "refused", errorCode: "forbidden-field" }));
    expect(s.text).toBe("Reasoning-state report not accepted (forbidden-field)");
    expect(s.tone).toBe("blocked");
  });
  it("an unknown tool that executed is not labelled refused, and one that did not is", () => {
    expect(describeStep(act({ tool: "something_else" })).text).toBe("Used something_else");
    expect(describeStep(act({ tool: "something_else", status: "refused", errorCode: "x" })).text).toBe("something_else refused (x)");
  });
});

describe("Direct Workspace smoke findings (steps and outcome wording)", () => {
  const w = (over: Partial<ToolActivity>): ToolActivity =>
    ({ index: 1, turn: 1, callId: "c", tool: "fs_write", argsSummary: "write src/index.js", status: "refused", errorCode: "not-found", approvalOutcome: "refused", resultBytes: 1, resultDigest: null, truncated: false, executionId: null, journalSeq: null, argsDigest: null, ...over }) as ToolActivity;

  it("a request refused before any approval shows its own error code, never 'approval refused'", () => {
    const s = describeStep(w({}));
    expect(s.text).toBe("Edit not applied (not-found): src/index.js — Nexus: the file or folder does not exist");
    expect(s.text).not.toMatch(/approval/);
    expect(s.tone).toBe("failed");
  });
  it("only a real decision at the approval boundary is shown as one", () => {
    expect(describeStep(w({ errorCode: "policy-refused" })).text).toContain("refused by the workspace policy");
    expect(describeStep(w({ approvalOutcome: "denied", errorCode: null })).text).toContain("approval denied");
    expect(describeStep(w({ approvalOutcome: "expired", errorCode: null })).tone).toBe("blocked");
  });
  it("a passing command that wrote files only into its scratch copy says so, and is not shown as plainly done", () => {
    const run = w({ tool: "proc_run", argsSummary: "sh -c mkdir -p tests && npm test", status: "executed", errorCode: null, approvalOutcome: "approved", verification: "pass", exitCode: 0, unsavedFiles: 2 });
    const s = describeStep(run);
    expect(s.text).toMatch(/passed · exit 0 · it also wrote 2 files that were NOT saved to your project/);
    expect(s.tone).toBe("uncertain");
    expect(describeStep({ ...run, unsavedFiles: undefined }).tone).toBe("done");
  });
  it("a check that passed over scratch-only files is not shown as 'Tests passed'", () => {
    const run = fakeRun({
      intentType: "repo-code", state: "completed", terminal: true,
      codingOutcome: { change: "applied", verification: "verified-scratch", editsApplied: 3, editsNotApplied: 0, testsExecuted: 1, testsNotExecuted: 0, blockedByApproval: 0, lastExitCode: 0, staleAfterEdit: false, uncertainOperations: 0, lastCheckUnsavedFiles: 1 },
    });
    const v = outcomeView(run)!;
    expect(v.label).toBe("Check passed in a scratch copy · 1 file it wrote was not saved");
    expect(v.label).not.toMatch(/^Tests passed/);
    expect(v.tone).toBe("warning");
    expect(v.detail).toMatch(/not in your project/);
  });
});
