import type { BrowserEvidence, IntentRun, ToolActivity } from "./contracts";

/** One of the four kinds of evidence, in plain words. They are shown as separate rows and never merged. */
export interface EvidenceRow {
  id: "static" | "browser" | "observation" | "assessment";
  label: string;
  state: string;
  tone: "ok" | "warn" | "bad" | "none";
  detail: string;
}

export interface VisualRequirementView {
  tone: "ok" | "bad";
  title: string;
  detail: string;
}

/** Every browser inspection of a run, oldest first. */
export function browserInspections(run: IntentRun): { activity: ToolActivity; evidence: BrowserEvidence }[] {
  return (run.toolActivity ?? [])
    .filter((a) => a.browser)
    .map((a) => ({ activity: a, evidence: a.browser as BrowserEvidence }));
}

/** Whether the run has anything to say about the rendered page (a request, or at least one inspection). */
export function hasVisualEvidence(run: IntentRun): boolean {
  const e = run.codingOutcome?.evidence;
  return !!run.visualRequested || (e?.browserRuns ?? 0) > 0 || browserInspections(run).length > 0;
}

const short = (s: string) => s.slice(0, 8);

export function evidenceRows(run: IntentRun): EvidenceRow[] {
  const e = run.codingOutcome?.evidence;
  if (!e) return [];
  const staticRow: EvidenceRow = {
    id: "static",
    label: "Static checks",
    state: e.staticChecks === "none" ? "none ran" : e.staticChecks,
    tone: e.staticChecks === "passed" ? "ok" : e.staticChecks === "failed" ? "bad" : e.staticChecks === "unverified" ? "warn" : "none",
    detail:
      e.staticChecks === "none"
        ? "No test, parser or syntax check ran. Nothing is claimed about the code from commands."
        : e.staticChecks === "passed"
          ? "Commands passed in the sandbox. They say nothing about how the page looks or behaves in a browser."
          : e.staticChecks === "failed"
            ? "A check failed and has not passed since."
            : "A command ran but its verdict proved nothing.",
  };
  const browserRow: EvidenceRow = {
    id: "browser",
    label: "Browser run",
    state: e.browserRuntime === "none" ? "not run" : e.browserRuntime,
    tone: e.browserRuntime === "passed" ? "ok" : e.browserRuntime === "failed" ? "bad" : "none",
    detail:
      e.browserRuntime === "none"
        ? "No browser opened the page."
        : e.browserRuntime === "passed"
          ? `A real browser loaded the page and its interactions worked, with no page errors (${e.browserRuns} inspection${e.browserRuns === 1 ? "" : "s"}). This is behaviour, not appearance.`
          : "The last browser run failed to load the page, a step failed, or the page raised an error.",
  };
  const obsDetail =
    e.visualObservation === "seen-by-model"
      ? `Screenshots were put in front of a vision-capable model${e.inspectedAfterLastEdit ? ", including after the last change" : ", but not after the last change"}.`
      : e.visualObservation === "captured-not-seen"
        ? "Screenshots exist, but no image was shown to the model (its model cannot read images, or it is not known to). Nobody looked at them."
        : "No screenshot exists.";
  const observationRow: EvidenceRow = {
    id: "observation",
    label: "Visual observation",
    state: e.visualObservation === "seen-by-model" ? "shown to model" : e.visualObservation === "captured-not-seen" ? "captured, not seen" : "none",
    tone: e.visualObservation === "seen-by-model" ? "ok" : e.visualObservation === "captured-not-seen" ? "warn" : "none",
    detail: obsDetail,
  };
  const assessmentRow: EvidenceRow = {
    id: "assessment",
    label: "Visual assessment",
    state: e.visualAssessment === "model-stated" ? "stated by the model" : "none",
    tone: e.visualAssessment === "model-stated" ? "warn" : "none",
    detail:
      e.visualAssessment === "model-stated"
        ? `The model's own judgement of the appearance, traceable to ${e.visualBasis.length} screenshot${e.visualBasis.length === 1 ? "" : "s"} (${e.visualBasis.slice(-3).map(short).join(", ")}). It is an opinion, not a measurement, and was not independently verified.`
        : "No assessment of the appearance can be traced to a screenshot.",
  };
  return [staticRow, browserRow, observationRow, assessmentRow];
}

const REQUIREMENT_DETAIL: Record<string, string> = {
  "unmet-no-browser": "This engine had no browser for the conversation, so the website could not be opened. Any appearance described in the answer was not observed.",
  "unmet-model-cannot-see": "The pages were captured, but the model cannot read images, so nobody looked at them. Any appearance described in the answer was not observed.",
  "unmet-browser-failed": "The browser was tried but did not produce a screenshot (it failed to start or load the page).",
  "unmet-not-attempted": "The browser was available but the agent never opened the page.",
  "unmet-stale-after-edit": "The page was looked at, but files were changed afterwards and the result was not inspected again.",
};

/** The user's request to look at the site: met, or unmet and why. Absent when it was not asked. */
export function visualRequirement(run: IntentRun): VisualRequirementView | null {
  const e = run.codingOutcome?.evidence;
  if (!run.visualRequested || !e) return null;
  if (e.visualRequirement === "met") {
    return {
      tone: "ok",
      title: "Visual inspection requested — done",
      detail: `Screenshots of the current result were shown to a vision-capable model (${e.browserRuns} browser inspection${e.browserRuns === 1 ? "" : "s"}).`,
    };
  }
  const base = REQUIREMENT_DETAIL[e.visualRequirement] ?? "The requested visual inspection was not completed.";
  return {
    tone: "bad",
    title: "Visual inspection requested — NOT done",
    detail: e.unsupportedVisualClaim ? `${base} The answer nevertheless claims it looked at the page; that claim has no evidence behind it.` : base,
  };
}

/** `42 KB`, `1.2 MB` */
export function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

export function inspectionSummary(b: BrowserEvidence): string {
  const parts = [`${b.viewport} ${b.viewportW}×${b.viewportH}`];
  if (!b.launched) parts.push("browser did not start");
  else if (!b.loaded) parts.push("page did not load");
  else parts.push(`loaded${b.httpStatus ? ` (${b.httpStatus})` : ""}`);
  const ok = b.steps.filter((s) => s.ok).length;
  if (b.steps.length > 0) parts.push(`${ok}/${b.steps.length} interaction${b.steps.length === 1 ? "" : "s"} worked`);
  parts.push(b.pageErrors === 0 && b.consoleErrors === 0 ? "no console/page errors" : `${b.pageErrors} page error(s), ${b.consoleErrors} console error(s)`);
  if (b.horizontalOverflow) parts.push("horizontal overflow");
  return parts.join(" · ");
}
