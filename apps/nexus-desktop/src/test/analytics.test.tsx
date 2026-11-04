import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunAnalytics } from "../features/analytics/RunAnalytics";
import { fmtCost, fmtMs, fmtPct, shares, UNAVAILABLE } from "../lib/analytics";
import type { RunAnalytics as A } from "../lib/contracts";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi } from "./fakeApi";

const full = (over: Partial<A> = {}): A =>
  ({
    schemaVersion: 1,
    runId: "run_1",
    source: { perRequestRecord: true, perToolRecord: true, runRecord: true, toolActivity: true },
    identity: { permissionMode: "ask", engine: null },
    runtime: {
      startedAtMs: 1000, endedAtMs: 61000, wallMs: 60000, state: "completed", terminal: true,
      categoriesExclusive: { modelRequestMs: 30000, toolExecutionMs: 5000, approvalWaitMs: 2000, controllerMs: 23000 },
      overlapping: { timeToFirstTokenMs: { avg: 1500, min: 1000, max: 2000, samples: 2 }, buildAndTestMs: 4000 },
      requests: { count: 2, avgLatencyMs: 15000, minLatencyMs: 10000, maxLatencyMs: 20000, latenciesMs: [10000, 20000] },
      outputTokensPerSecond: 10, recordCapped: false,
    },
    tokens: {
      source: "per-request", input: 2100, output: 160, total: 2260, cachedInput: 1800, cacheWrite: null, noncachedInput: 300, reasoning: null, cacheHitRate: 0.857143,
      byAttempt: [],
      byModel: [{ model: "opencode-go/kimi", requests: 2, inputTokens: 2100, outputTokens: 160, cachedInputTokens: 1800, reasoningTokens: null, latencyMs: 30000, cacheHitRate: 0.857143 }],
      byPhase: [{ phase: "work", requests: 2, inputTokens: 2100, outputTokens: 160, cachedInputTokens: 1800, reasoningTokens: null, latencyMs: 30000, cacheHitRate: 0.857143 }],
    },
    routing: { configured: { provider: "opencode-go", model: "kimi" }, requests: [], attemptsPerModel: [], attemptsPerEffort: {}, modelSwitches: 0, phaseTransitions: [] },
    tools: {
      modelRequested: 1, recordedCalls: 1, succeeded: 1, failed: 0, refusedOrDenied: 0, byTool: [], executionMs: 5000, approvalWaitMs: 2000, buildAndTestMs: 4000,
      fileEdits: { proposed: 0, applied: 0, conflicts: 0 },
      commands: [{ index: 1, command: "cargo test", status: "executed", exitCode: 0, verification: "pass", execMs: 4000, waitMs: 0 }],
      dependencyInstalls: { requests: 1, approved: 1, denied: 0, automatic: 0 }, permissionPrompts: 1,
    },
    verification: { cycles: 1, failedAttempts: 0, recoveryCycles: 0, finalVerification: "verified-passed", evidence: [] },
    cost: { actual: { usd: null, requestsReporting: 0, requestsTotal: 2 }, estimated: { usd: null }, display: "unknown" },
    missing: [{ metric: "tokens.reasoning", reason: "the provider did not report reasoning tokens" }],
    ...over,
  }) as A;

function mount(a: A | Error, live = false, api = fakeApi()) {
  vi.spyOn(api, "runAnalytics").mockImplementation(async () => {
    if (a instanceof Error) throw { code: "unavailable", message: a.message };
    return a;
  });
  render(
    <NexusProvider api={api}>
      <RunAnalytics runId="run_1" live={live} />
    </NexusProvider>,
  );
  return api;
}

describe("Run Analytics (M4.6)", () => {
  it("shows a loading state, then the compact summary of a completed run", async () => {
    mount(full());
    expect(screen.getByText(/Loading run analytics/)).toBeInTheDocument();
    const s = await screen.findByLabelText("Run analytics");
    await waitFor(() => expect(within(s).getByText(/1m 00s/)).toBeInTheDocument());
    expect(within(s).getByText(/2 requests/)).toBeInTheDocument();
    expect(within(s).getByText(/2,100/)).toBeInTheDocument();
    expect(within(s).getByText("cache 85.7%")).toBeInTheDocument();
    expect(within(s).getByText("10 tok/s")).toBeInTheDocument();
    expect(within(s).getByText("cost Unknown")).toBeInTheDocument(); // not zero
  });

  it("says unavailable when the engine cannot provide analytics", async () => {
    mount(new Error("no such run"));
    expect(await screen.findByText(/Run analytics are unavailable for this run: no such run/)).toBeInTheDocument();
  });

  it("an older run shows what its record held and Unavailable for the rest, never zero", async () => {
    const hist = full({
      source: { perRequestRecord: false, perToolRecord: false, runRecord: true, toolActivity: true },
      runtime: { ...full().runtime, categoriesExclusive: { modelRequestMs: null, toolExecutionMs: null, approvalWaitMs: null, controllerMs: null }, overlapping: { timeToFirstTokenMs: { avg: null, min: null, max: null, samples: 0 }, buildAndTestMs: null }, requests: { count: 0, avgLatencyMs: null, minLatencyMs: null, maxLatencyMs: null, latenciesMs: [] }, outputTokensPerSecond: null },
      tokens: { ...full().tokens, source: "run-record-cumulative", cachedInput: null, noncachedInput: null, cacheHitRate: null, byModel: [], byPhase: [] },
      tools: { ...full().tools, executionMs: null, approvalWaitMs: null, buildAndTestMs: null, modelRequested: null },
    });
    mount(hist);
    const s = await screen.findByLabelText("Run analytics");
    expect(await within(s).findByText("partial history")).toBeInTheDocument();
    expect(within(s).getByText("requests: Unavailable")).toBeInTheDocument();
    expect(within(s).getByText("cache Unavailable")).toBeInTheDocument();
    expect(within(s).getByText("tok/s Unavailable")).toBeInTheDocument();
    await userEvent.setup().click(within(s).getByRole("button", { name: /Details/ }));
    expect(within(s).getByText(/this run has no per-request and per-tool timing/)).toBeInTheDocument();
    expect(within(s).getByText(/Only run totals were recorded/)).toBeInTheDocument();
    expect(within(s).getByText("Per-model figures are Unavailable for this run.")).toBeInTheDocument();
  });

  it("the detail view separates the exclusive time categories from the overlapping measures", async () => {
    mount(full());
    const s = await screen.findByLabelText("Run analytics");
    await userEvent.setup().click(await within(s).findByRole("button", { name: /Details/ }));
    expect(within(s).getByText(/Where the time went \(these add up to the wall clock\)/)).toBeInTheDocument();
    expect(within(s).getByText(/Model requests: 30.0 s \(50%\)/)).toBeInTheDocument();
    expect(within(s).getByText(/Controller & other: 23.0 s \(38%\)/)).toBeInTheDocument();
    expect(within(s).getByText(/Overlapping measures, not part of that sum/)).toBeInTheDocument();
    expect(within(s).getByRole("table", { name: "Per-model breakdown" })).toBeInTheDocument();
    expect(within(s).getByText("tokens.reasoning")).toBeInTheDocument();
  });

  it("an in-progress run is labelled as such and refreshes itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = mount(full({ runtime: { ...full().runtime, terminal: false, wallMs: null, endedAtMs: null } }), true);
    expect(await screen.findByText("in progress")).toBeInTheDocument();
    const spy = vi.mocked(api.runAnalytics);
    const n = spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5200);
    expect(spy.mock.calls.length).toBeGreaterThan(n);
    vi.useRealTimers();
  });

  it("export copies the versioned document and saving reports the path", async () => {
    const api = fakeApi();
    vi.spyOn(api, "runAnalyticsExport").mockResolvedValue({ schema: "nexus.run-analytics", schemaVersion: 1 });
    vi.spyOn(api, "runAnalyticsSave").mockResolvedValue({ path: "/Users/x/Downloads/nexus-run-analytics-run_1.json" });
    mount(full(), false, api);
    const s = await screen.findByLabelText("Run analytics");
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await user.click(await within(s).findByRole("button", { name: /Details/ }));
    await user.click(within(s).getByRole("button", { name: /Copy benchmark JSON/ }));
    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(String(write.mock.calls[0]![0])).toContain('"schema": "nexus.run-analytics"');
    await user.click(within(s).getByRole("button", { name: /Save to Downloads/ }));
    expect(await within(s).findByText(/nexus-run-analytics-run_1\.json/)).toBeInTheDocument();
  });
});

describe("analytics formatting", () => {
  it("never turns a missing value into zero", () => {
    expect(fmtMs(null)).toBe(UNAVAILABLE);
    expect(fmtMs(0)).toBe("0 ms");
    expect(fmtPct(null)).toBe(UNAVAILABLE);
    expect(fmtPct(0)).toBe("0.0%");
  });

  it("an estimate is marked as one and never presented as an actual cost", () => {
    const est = full({ cost: { actual: { usd: null, requestsReporting: 0, requestsTotal: 2 }, estimated: { usd: 1.18 }, display: "estimated" } });
    expect(fmtCost(est.cost)).toEqual({ text: "~$1.1800", kind: "estimated" });
    const act = full({ cost: { actual: { usd: 3, requestsReporting: 2, requestsTotal: 2 }, estimated: { usd: null }, display: "actual" } });
    expect(fmtCost(act.cost)).toEqual({ text: "$3.0000", kind: "actual" });
    expect(fmtCost(full().cost)).toEqual({ text: "Unknown", kind: "unknown" });
  });

  it("time shares add up to the whole and are absent when the categories are not measured", () => {
    const s = shares(full())!;
    expect(Math.round(s.reduce((t, r) => t + r.pct, 0))).toBe(100);
    expect(shares(full({ runtime: { ...full().runtime, categoriesExclusive: { modelRequestMs: null, toolExecutionMs: null, approvalWaitMs: null, controllerMs: null } } }))).toBeNull();
  });
});
