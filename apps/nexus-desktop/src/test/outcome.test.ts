import { describe, expect, it } from "vitest";
import { runResult, RESULT_WORD } from "../lib/outcome";
import { startupHelp } from "../lib/startupHelp";
import type { CodingOutcome, ThreadRunView, ToolActivity } from "../lib/contracts";
import { fakeRun } from "./fakeApi";

const outcome = (o: Partial<CodingOutcome>): CodingOutcome => ({
  change: "applied", verification: "verified-passed", editsApplied: 1, editsNotApplied: 0, testsExecuted: 1, testsNotExecuted: 0,
  blockedByApproval: 0, lastExitCode: 0, staleAfterEdit: false, uncertainOperations: 0, ...o,
});
const act = (over: Partial<ToolActivity>): ToolActivity => ({
  index: 1, turn: 1, callId: "c", tool: "fs_edit", argsSummary: "", status: "executed", errorCode: null, resultBytes: 0, resultDigest: null,
  truncated: false, executionId: null, journalSeq: null, argsDigest: null, ...over,
});
function view(run: Record<string, unknown>, readOnly = false): ThreadRunView {
  return {
    runId: "run_" + "1".repeat(32), n: 1, userSeq: 1, assistantSeq: 2, mode: readOnly ? "review" : "edit", readOnly, modeReason: "", continuationOf: null,
    state: "completed", ended: true, startedAtMs: 1, endedAtMs: 2, digest: null,
    run: fakeRun({ intentType: "repo-code", state: "completed", terminal: true, ...run }),
  };
}
const cat = (r: ThreadRunView) => runResult(r)?.category;

describe("every finished run is exactly one of six honest results", () => {
  it("verified only when a recorded command passed (or a read-only run changed nothing)", () => {
    expect(cat(view({ codingOutcome: outcome({}) }))).toBe("verified");
    expect(cat(view({ completion: "no-change-verified" }))).toBe("verified");
    expect(cat(view({}, true))).toBe("verified");
    expect(runResult(view({ codingOutcome: outcome({}) }))?.label).toBe("Tests passed · exit 0");
  });

  it("a model that says it is done is not evidence: no executed check means not verified", () => {
    expect(cat(view({ codingOutcome: outcome({ verification: "no-test-executed", testsExecuted: 0, lastExitCode: null }) }))).toBe("unverified");
    expect(cat(view({ completion: "unexecuted-claims", codingOutcome: outcome({}) }))).toBe("unverified");
    expect(cat(view({ completion: "incomplete" }))).toBe("unverified");
    expect(cat(view({ completion: "no-change-reported" }))).toBe("unverified");
    // a check that passed only inside a throw-away copy verified the copy, not the project
    expect(cat(view({ codingOutcome: outcome({ verification: "verified-scratch", lastCheckUnsavedFiles: 2 }) }))).toBe("unverified");
    // no outcome reported at all is never "verified"
    expect(cat(view({ codingOutcome: null }))).toBe("unverified");
  });

  it("failed checks, a failed run and an uncertain outcome are failures", () => {
    expect(cat(view({ codingOutcome: outcome({ verification: "verified-failed", lastExitCode: 1 }) }))).toBe("failed");
    expect(cat(view({ codingOutcome: outcome({ verification: "verified-mixed", checksFailedUnresolved: 1 }) }))).toBe("failed");
    expect(cat(view({ completion: "failing-checks", unresolvedFailedChecks: 2, codingOutcome: outcome({}) }))).toBe("failed");
    expect(cat(view({ codingOutcome: outcome({ verification: "uncertain", change: "uncertain" }) }))).toBe("failed");
    expect(cat(view({ state: "failed", errorCode: "model-error" }))).toBe("failed");
    // a read-only run that changed a file is a defect to report, not a success
    expect(cat(view({ toolActivity: [act({ tool: "fs_write", status: "executed" })] }, true))).toBe("failed");
  });

  it("work stopped at a boundary is refused, not failed and not done", () => {
    const r = runResult(view({ codingOutcome: outcome({ verification: "blocked-by-approval", change: "not-applied", editsApplied: 0, editsNotApplied: 1, testsExecuted: 0, blockedByApproval: 1, lastExitCode: null }) }));
    expect(r?.category).toBe("refused");
    expect(r?.tone).toBe("warning");
  });

  it("a cancelled or interrupted run is stopped - even if a test had passed before the stop", () => {
    const r = runResult(view({ state: "cancelled", codingOutcome: outcome({}) }));
    expect(r?.category).toBe("stopped");
    expect(r?.label).toBe("Last test command passed · exit 0");
    expect(r?.detail).toMatch(/cancelled before it finished/);
    expect(cat(view({ continuedAs: "run_" + "2".repeat(32), codingOutcome: outcome({}) }))).toBe("stopped");
  });

  it("a run that could not start because this computer cannot do it is unavailable, not failed", () => {
    for (const errorCode of ["not-available", "sandbox-unavailable", "no-grant"]) expect(cat(view({ state: "failed", errorCode })), errorCode).toBe("unavailable");
  });

  it("a run still going has no result yet", () => {
    expect(runResult(view({ state: "executing", terminal: false }))).toBeNull();
    expect(runResult({ ...view({}), run: null })).toBeNull();
  });

  it("each category has its own plain word", () => {
    expect(Object.values(RESULT_WORD).sort()).toEqual(["Failed", "Not verified", "Refused", "Stopped", "Unavailable", "Verified"]);
  });
});

describe("start-up failures say what to do", () => {
  it("a missing Node.js is explained, with the desktop-menu PATH trap", () => {
    const h = startupHelp("node was not found on PATH");
    expect(h.title).toBe("Nexus needs Node.js");
    expect(h.steps.join(" ")).toMatch(/nvm/);
  });
  it("missing programs mean reinstall", () => {
    expect(startupHelp("nexusd not found (set NEXUS_BIN_DIR)").title).toMatch(/missing/);
    expect(startupHelp("the Registry/Controller bridge was not found (set NEXUS_REPO_ROOT)").title).toMatch(/missing/);
  });
  it("a too-long data path is explained instead of the socket error", () => {
    expect(startupHelp("socket bind failed: path must be shorter than SUN_LEN").title).toMatch(/too long/);
  });
  it("an unknown message still gets safe generic advice", () => {
    expect(startupHelp("something odd").steps[0]).toBe("Press Try again.");
    expect(startupHelp(null).title).toBe("Nexus could not start");
  });
});
