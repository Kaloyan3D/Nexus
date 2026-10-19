import { describe, expect, it } from "vitest";
import { outcomeView } from "../lib/runKind";
import type { IntentRun } from "../lib/contracts";

function run(o: Record<string, unknown>): IntentRun {
  return {
    runId: "run_x",
    intentType: "repo-code",
    state: "completed",
    terminal: true,
    codingOutcome: {
      verification: "verified-passed",
      change: "applied",
      editsApplied: 1,
      editsNotApplied: 0,
      testsExecuted: 2,
      testsNotExecuted: 0,
      blockedByApproval: 0,
      lastExitCode: 0,
      staleAfterEdit: false,
      uncertainOperations: 0,
      ...o,
    },
  } as unknown as IntentRun;
}

describe("a run is never shown as having passed all tests while a recorded check failed (D5)", () => {
  it("a passing last check with an unresolved failed check is a warning, not 'Tests passed'", () => {
    const v = outcomeView(run({ verification: "verified-mixed", checksFailedUnresolved: 2 }))!;
    expect(v.label).toBe("Last check passed · 2 other checks failed");
    expect(v.tone).toBe("warning");
    expect(v.label).not.toMatch(/^Tests passed/);
    expect(v.detail).toMatch(/not a passing run/);
  });

  it("a single failed check is worded in the singular", () => {
    const v = outcomeView(run({ verification: "verified-mixed", checksFailedUnresolved: 1 }))!;
    expect(v.label).toBe("Last check passed · 1 other check failed");
  });

  it("a genuinely passing run is unchanged", () => {
    const v = outcomeView(run({ verification: "verified-passed", checksFailedUnresolved: 0 }))!;
    expect(v.label).toBe("Tests passed · exit 0");
    expect(v.tone).toBe("success");
  });

  it("an older broker that omits the new fields still renders", () => {
    const v = outcomeView(run({ verification: "verified-passed" }))!;
    expect(v.tone).toBe("success");
  });
});
