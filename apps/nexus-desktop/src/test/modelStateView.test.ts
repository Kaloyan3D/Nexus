import { describe, expect, it } from "vitest";
import { modelStateView } from "../lib/modelRun";

describe("modelStateView (broker run states)", () => {
  it("labels broker lifecycle states without inventing success", () => {
    expect(modelStateView("preparing").label).toBe("Preparing request");
    expect(modelStateView("executing").pulse).toBe(true);
    expect(modelStateView("rejected")).toMatchObject({ label: "Rejected (nothing sent)", tone: "error" });
    expect(modelStateView("abandoned").tone).toBe("warning");
    expect(modelStateView("uncertain").label).toBe("Outcome uncertain");
    expect(modelStateView("cancelled").tone).not.toBe("success");
    expect(modelStateView("completed").tone).toBe("success");
  });
});
