import { describe, expect, it } from "vitest";
import { evidenceRows, hasVisualEvidence, inspectionSummary, visualRequirement } from "../lib/visualEvidence";
import type { BrowserEvidence, EvidenceLevels, IntentRun } from "../lib/contracts";

const levels = (o: Partial<EvidenceLevels> = {}): EvidenceLevels => ({
  staticChecks: "none",
  browserRuntime: "none",
  visualObservation: "none",
  visualAssessment: "none",
  visualBasis: [],
  visualRequested: true,
  visualRequirement: "unmet-not-attempted",
  browserRuns: 0,
  inspectedAfterLastEdit: false,
  unsupportedVisualClaim: false,
  ...o,
});

const run = (e: EvidenceLevels, extra: Partial<IntentRun> = {}): IntentRun =>
  ({ runId: "run_x", visualRequested: true, codingOutcome: { evidence: e }, toolActivity: [], ...extra }) as unknown as IntentRun;

describe("visual evidence", () => {
  it("never merges the four levels: a passing syntax check says nothing about the page", () => {
    const rows = evidenceRows(run(levels({ staticChecks: "passed" })));
    expect(rows.map((r) => r.id)).toEqual(["static", "browser", "observation", "assessment"]);
    expect(rows[0]!.state).toBe("passed");
    expect(rows[0]!.detail).toMatch(/nothing about how the page looks/i);
    expect(rows[1]!.state).toBe("not run");
    expect(rows[2]!.state).toBe("none");
    expect(rows[3]!.state).toBe("none");
  });

  it("an unmet visual request is shown as NOT done, with the reason, even when a parser passed", () => {
    for (const [code, text] of [
      ["unmet-no-browser", /no browser/i],
      ["unmet-model-cannot-see", /cannot read images/i],
      ["unmet-browser-failed", /did not produce a screenshot/i],
      ["unmet-not-attempted", /never opened/i],
      ["unmet-stale-after-edit", /changed afterwards/i],
    ] as const) {
      const v = visualRequirement(run(levels({ staticChecks: "passed", visualRequirement: code })));
      expect(v?.tone).toBe("bad");
      expect(v?.title).toMatch(/NOT done/);
      expect(v?.detail).toMatch(text);
    }
  });

  it("a claim without evidence is called out", () => {
    const v = visualRequirement(run(levels({ visualRequirement: "unmet-model-cannot-see", unsupportedVisualClaim: true })));
    expect(v?.detail).toMatch(/claims it looked at the page; that claim has no evidence/i);
  });

  it("a met request needs a screenshot shown to the model, and the assessment stays a judgement", () => {
    const e = levels({ visualRequirement: "met", visualObservation: "seen-by-model", visualAssessment: "model-stated", visualBasis: ["a".repeat(64), "b".repeat(64)], browserRuns: 2, browserRuntime: "passed", inspectedAfterLastEdit: true });
    expect(visualRequirement(run(e))?.tone).toBe("ok");
    const rows = evidenceRows(run(e));
    expect(rows[2]!.state).toBe("shown to model");
    expect(rows[3]!.detail).toMatch(/not independently verified/i);
    expect(rows[3]!.tone).toBe("warn");
  });

  it("captured but never shown is not an observation", () => {
    const rows = evidenceRows(run(levels({ visualObservation: "captured-not-seen", browserRuntime: "passed", browserRuns: 1 })));
    expect(rows[2]!.state).toBe("captured, not seen");
    expect(rows[2]!.detail).toMatch(/Nobody looked/);
  });

  it("is hidden for ordinary runs and shown once a request or a browser run exists", () => {
    expect(hasVisualEvidence({ runId: "r", toolActivity: [] } as unknown as IntentRun)).toBe(false);
    expect(hasVisualEvidence(run(levels()))).toBe(true);
  });

  it("summarises an inspection factually", () => {
    const b = { viewport: "mobile", viewportW: 390, viewportH: 844, launched: true, loaded: true, httpStatus: 200, steps: [{ do: "click", ok: true }, { do: "fill", ok: false }], pageErrors: 1, consoleErrors: 0, horizontalOverflow: true } as unknown as BrowserEvidence;
    const s = inspectionSummary(b);
    expect(s).toContain("mobile 390×844");
    expect(s).toContain("1/2 interactions worked");
    expect(s).toContain("1 page error(s)");
    expect(s).toContain("horizontal overflow");
  });
});

import { describeStep } from "../lib/progress";
import type { ToolActivity } from "../lib/contracts";

describe("timeline wording for the browser tool", () => {
  const act = (b: Partial<BrowserEvidence> | null, extra: Partial<ToolActivity> = {}): ToolActivity =>
    ({ index: 3, turn: 3, callId: "c", tool: "browser_inspect", argsSummary: "project:index.html · mobile · 0 step(s)", status: "executed", errorCode: null, resultBytes: 1, resultDigest: null, truncated: false, executionId: null, journalSeq: null, argsDigest: null, browser: b as BrowserEvidence | null, ...extra }) as ToolActivity;
  it("says whether the screenshot was shown to the model", () => {
    const shown = describeStep(act({ url: "project:index.html", viewport: "mobile", viewportW: 390, viewportH: 844, pageErrors: 0, imageDelivery: "delivered-to-vision-model" }));
    expect(shown.text).toContain("screenshot shown to the model");
    expect(shown.tone).toBe("done");
    const unseen = describeStep(act({ url: "project:index.html", viewport: "desktop", viewportW: 1280, viewportH: 800, pageErrors: 0, imageDelivery: "not-delivered-text-only-model" }));
    expect(unseen.text).toContain("NOT shown");
    expect(unseen.tone).toBe("uncertain");
  });
  it("reports a browser that failed or a refused address plainly", () => {
    expect(describeStep(act({ url: "project:index.html", error: "Executable does not exist" }, { status: "failed" })).text).toContain("could not inspect");
    expect(describeStep(act(null, { status: "refused", errorCode: "url-not-allowed" })).text).toContain("refused (url-not-allowed)");
  });
});

describe("timeline wording for checks that never ran", () => {
  const cmd = (extra: Partial<ToolActivity>): ToolActivity =>
    ({ index: 6, turn: 6, callId: "c", tool: "proc_run", argsSummary: "sh -c node --check <(...)", status: "executed", errorCode: null, resultBytes: 1, resultDigest: null, truncated: false, executionId: null, journalSeq: null, argsDigest: null, verification: "fail", exitCode: 1, ...extra }) as ToolActivity;
  it("labels an invalid invocation as unresolved, not as a project failure", () => {
    const s = describeStep(cmd({ checkClass: "invalid-invocation" }));
    expect(s.text).toContain("invalid invocation, nothing was checked");
    expect(s.text).toContain("still unresolved");
    expect(s.tone).toBe("uncertain");
  });
  it("shows which failure Nexus's own replacement resolved", () => {
    const s = describeStep(cmd({ index: 7, checkClass: "controller-recheck", verification: "pass", exitCode: 0, resolvesCheck: 6 }));
    expect(s.text).toContain("resolves the invalid check of step 6");
    expect(s.tone).toBe("done");
  });
  it("leaves an ordinary failing check untouched", () => {
    expect(describeStep(cmd({})).text).toContain("failed");
  });
});


describe("compound-command checks (M4.2 Phase A)", () => {
  const cmd = (extra: Partial<ToolActivity>): ToolActivity =>
    ({ index: 4, turn: 4, callId: "c", tool: "proc_run", argsSummary: "sh -c node --check a.js; echo done", status: "executed", errorCode: null, resultBytes: 1, resultDigest: null, truncated: false, executionId: null, journalSeq: null, argsDigest: null, verification: "pass", exitCode: 0, ...extra }) as ToolActivity;
  it("says an unattested check is not counted as verified, although the Kernel exit was 0", () => {
    const s = describeStep(cmd({ checkClass: "unattested-composition", assessment: "unverified" }));
    expect(s.text).toContain("cannot show it passed");
    expect(s.text).toContain("not counted as verified");
    expect(s.tone).toBe("uncertain");
  });
  it("shows which unattested check an attested command re-established", () => {
    const s = describeStep(cmd({ index: 6, checkClass: "attested-recheck", resolvesHazards: [4] }));
    expect(s.text).toContain("resolves the unattested check of step 4");
    expect(s.tone).toBe("done");
  });
});


describe("how a command's fate is worded (M4.x execution investigation)", () => {
  const cmd = (extra: Partial<ToolActivity>): ToolActivity =>
    ({ index: 2, turn: 2, callId: "c", tool: "proc_run", argsSummary: "sh -c ls /work", status: "executed", errorCode: null, resultBytes: 1, resultDigest: null, truncated: false, executionId: null, journalSeq: null, argsDigest: null, verification: "run-pass", exitCode: 0, ...extra }) as ToolActivity;
  it("an executed command that is not a check is NEVER worded as not run", () => {
    for (const verification of ["run-pass", "run-fail"]) {
      const s = describeStep(cmd({ verification, exitCode: verification === "run-pass" ? 0 : 2 }));
      expect(s.text).toMatch(/^Ran /);
      expect(s.text).not.toMatch(/not run/i);
    }
    expect(describeStep(cmd({ verification: "run-fail", exitCode: 2 })).text).toContain("exit 2 (not a verification check)");
  });
  it("exit 127 says a program is missing, and that it is not a permission decision", () => {
    const s = describeStep(cmd({ verification: "run-fail", exitCode: 127, processClass: "executable-not-found" }));
    expect(s.text).toContain("does not exist in this runtime");
    expect(s.text).toContain("not a permission decision");
  });
  it("a command that never started is worded as not run, with the right reason", () => {
    const missing = describeStep(cmd({ status: "refused", verification: null, exitCode: null, errorCode: "executable-not-found", approvalOutcome: "refused" }));
    expect(missing.text).toContain("Command not run (executable-not-found)");
    expect(missing.text).toContain("not installed in the Linux runtime");
    expect(missing.text).toContain("not a permission decision");
    const policy = describeStep(cmd({ status: "refused", verification: null, exitCode: null, errorCode: "command-refused", approvalOutcome: "refused" }));
    expect(policy.text).toContain("command policy");
    expect(policy.text).not.toContain("not installed");
  });
});

describe("the wording of a REAL run recorded by the rebuilt engine (M4.4 live, real model, real sandbox)", () => {
  // proc_run records exactly as the engine returned them (field values copied from `intent_activity`)
  const rec = (index: number, argsSummary: string, extra: Partial<ToolActivity>): ToolActivity =>
    ({ index, turn: index, callId: `call_${index}`, tool: "proc_run", argsSummary, status: "executed", errorCode: null, resultBytes: 1, resultDigest: null, truncated: false, executionId: null, journalSeq: null, argsDigest: null, ...extra }) as ToolActivity;
  it("shows the toolchain, the failing and passing checks and the test run with their exit codes", () => {
    const text = (a: ToolActivity) => describeStep(a).text;
    expect(text(rec(7, "cargo --version", { verification: "run-pass", exitCode: 0 }))).toBe("Ran cargo --version · exit 0");
    expect(text(rec(8, "rustc --version", { verification: "run-pass", exitCode: 0 }))).toBe("Ran rustc --version · exit 0");
    expect(text(rec(9, "cargo check --offline", { verification: "fail", exitCode: 101 }))).toBe("Ran cargo check --offline · failed · exit 101");
    expect(text(rec(11, "cargo check --offline", { verification: "pass", exitCode: 0 }))).toBe("Ran cargo check --offline · passed · exit 0");
    expect(text(rec(12, "cargo test --offline", { verification: "pass", exitCode: 0 }))).toBe("Ran cargo test --offline · passed · exit 0");
    expect(text(rec(2, "sh -c echo policy-test-done", { verification: "run-pass", exitCode: 0 }))).toBe("Ran sh -c echo policy-test-done · exit 0");
  });
  it("tells a program that is not installed apart from a command the policy refused", () => {
    const missing = describeStep(rec(13, "nexus-no-such-tool-m44 --version", { status: "refused", errorCode: "executable-not-found", approvalOutcome: "refused" }));
    expect(missing.tone).toBe("failed");
    expect(missing.text).toContain("Command not run (executable-not-found)");
    expect(missing.text).toContain("not installed in the Linux runtime");
    expect(missing.text).toContain("not a permission decision");
    const policy = describeStep(rec(1, "sh -i", { status: "refused", errorCode: "command-refused", approvalOutcome: "refused" }));
    expect(policy.text).toContain("Command not run (command-refused)");
    expect(policy.text).toContain("command policy");
    expect(policy.text).not.toContain("not installed");
    expect(policy.text).not.toBe(missing.text);
  });
});

describe("filter-status checks (M4.7)", () => {
  const cmd = (extra: Partial<ToolActivity>): ToolActivity =>
    ({ index: 111, turn: 113, callId: "c", tool: "proc_run", argsSummary: "sh -c touch src/lib.rs src/main.rs && cargo build 2>&1 | grep -i 'warn'", status: "executed", errorCode: null, resultBytes: 1, resultDigest: null, truncated: false, executionId: null, journalSeq: null, argsDigest: null, verification: "fail", exitCode: 1, ...extra }) as ToolActivity;
  it("never shows a grep no-match as a failed check", () => {
    for (const checkClass of ["filter-status", "filter-status-joined"]) {
      const s = describeStep(cmd({ checkClass, assessment: "unverified" }));
      expect(s.tone).toBe("uncertain");
      expect(s.text).toContain("the filter's, not the check's");
      expect(s.text).not.toContain("· failed ·");
    }
  });
  it("shows which failed compound check an attested pass re-established", () => {
    const s = describeStep(cmd({ index: 200, argsSummary: "sh -c cargo build --offline 2>&1", verification: "pass", exitCode: 0, resolvesFailed: [27] }));
    expect(s.tone).toBe("done");
    expect(s.text).toContain("re-establishes the failed check of step 27");
  });
  it("a genuine failure stays a failure", () => {
    expect(describeStep(cmd({ exitCode: 101 })).text).toContain("failed");
  });
});
