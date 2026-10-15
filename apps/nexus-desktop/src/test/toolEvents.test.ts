import { describe, expect, it } from "vitest";
import type { ToolEventV1 } from "../lib/contracts";
import { toolEventPresentation } from "../lib/toolEvents";

const base: ToolEventV1 = {
  schemaVersion: 1,
  requestId: "r",
  executionId: "e",
  taskInstanceId: "t",
  attemptId: "a",
  commandId: "c",
  toolId: "fs.read",
  toolVersion: 1,
  status: "completed",
  args: { path: "src/lib.rs" },
  resultStatus: "ok",
  errorCode: null,
  truncated: false,
  truncationReasons: [],
  redacted: false,
  redactionKinds: [],
  outputDigest: "d",
  outputBytes: 10,
  stats: null,
  aiInitiated: false,
  firstSeq: 1,
  lastSeq: 3,
  authorizedAtUtc: "1.0Z",
  lastAtUtc: "2.0Z",
};

describe("toolEventPresentation", () => {
  it("renders success, truncation and refusal distinctly", () => {
    expect(toolEventPresentation(base)).toMatchObject({ tone: "success", summary: "read src/lib.rs" });
    const t = toolEventPresentation({ ...base, truncated: true, truncationReasons: ["max-lines"] });
    expect(t.tone).toBe("warning");
    expect(t.summary).toContain("max-lines");
    const f = toolEventPresentation({ ...base, status: "failed", errorCode: "sensitive-path-refused" });
    expect(f.tone).toBe("danger");
    expect(f.summary).toContain("sensitive-path-refused");
  });
});
