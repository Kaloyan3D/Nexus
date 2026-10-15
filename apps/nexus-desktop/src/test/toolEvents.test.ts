import { describe, expect, it } from "vitest";
import type { ToolEventV1 } from "../lib/contracts";
import { approvalNote, describeMutation, toolEventPresentation } from "../lib/toolEvents";

const base: ToolEventV1 = {
  schemaVersion: 1,
  requestId: "r",
  executionId: "e",
  taskInstanceId: "t",
  attemptId: "a",
  commandId: "c",
  toolId: "fs.read",
  toolVersion: 1,
  scope: "read",
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
  change: null,
  aiInitiated: false,
  leaseEpoch: 3,
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

  it("presents write lifecycle states, pre/post metadata and honest mutation claims", () => {
    const w: ToolEventV1 = {
      ...base,
      toolId: "fs.write",
      scope: "write",
      status: "verified",
      change: { operation: "replace", path: "src/a.rs", preSha256: "a".repeat(64), postSha256: "b".repeat(64), postBytes: 42, mutation: "applied" },
    };
    const p = toolEventPresentation(w);
    expect(p.tone).toBe("success");
    expect(p.summary).toContain("replace src/a.rs");
    expect(p.change).toBe("aaaaaaaaaa → bbbbbbbbbb · 42 B");
    expect(p.requiresApproval).toBe(false);
    expect(toolEventPresentation({ ...w, status: "planned" }).requiresApproval).toBe(true);
    const c = toolEventPresentation({ ...w, status: "conflict", change: { ...w.change, conflict: "preimage-mismatch", mutation: "none" } });
    expect(c.tone).toBe("danger");
    expect(c.summary).toContain("preimage-mismatch");
    expect(describeMutation({ mutation: "none" })).toBe("no file was changed");
    // An interrupted write that may have published must never read as "no changes".
    expect(describeMutation({ mutation: "applied-unverified" })).toMatch(/published/);
    expect(describeMutation({ mutation: "uncertain" })).toMatch(/uncertain/);
    expect(describeMutation(null)).toBeNull();
  });

  it("labels non-independent write approval as test-only and discloses preserved files", () => {
    expect(approvalNote({ approverIndependent: false }, "write")).toMatch(/test-only/);
    expect(approvalNote({ approverIndependent: true }, "write")).toBe("independently approved");
    expect(approvalNote(null, "write")).toMatch(/not recorded/);
    expect(approvalNote(null, "read")).toBeNull();
    expect(describeMutation({ mutation: "none", preservedAs: ".nexus-displaced-x" })).toMatch(/preserved as/);
  });
});
