import { describe, expect, it } from "vitest";
import { describeStep } from "../lib/progress";
import type { ToolActivity } from "../lib/contracts";

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
