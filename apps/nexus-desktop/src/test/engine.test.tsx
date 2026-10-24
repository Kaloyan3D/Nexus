import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineActivity } from "../features/engine/EngineActivity";
import { EngineChoice, engineLabelForMode } from "../features/engine/EngineChoice";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi } from "./fakeApi";
import type { NativeApi } from "../lib/api";
import type { EngineChoiceView, RunEngineSummary } from "../lib/contracts";

afterEach(cleanup);

const choice = (over: Partial<EngineChoiceView> = {}): EngineChoiceView => ({
  preferred: "adaptive",
  adaptiveAvailable: true,
  adaptiveReason: null,
  adaptiveModel: "meta/muse-spark-1.3-contributor-adaptive",
  adaptiveRoute: "opencode-go-native/muse-adaptive",
  effective: "adaptive",
  ...over,
});

function mount(api: Partial<NativeApi>, ui: React.ReactNode) {
  return render(<NexusProvider api={{ ...fakeApi(), ...api } as NativeApi}>{ui}</NexusProvider>);
}

describe("engine labels", () => {
  it("names the adaptive mode and treats every other mode as Stable", () => {
    expect(engineLabelForMode("engineering-v2-adaptive")).toBe("Nexus Adaptive");
    expect(engineLabelForMode("engineering-v2")).toBe("Stable (legacy)");
    expect(engineLabelForMode(null)).toBeNull();
  });
});

describe("EngineChoice", () => {
  it("offers Adaptive as the recommended default and keeps Stable selectable", async () => {
    mount({ engineChoice: async () => choice() }, <EngineChoice />);
    const sel = (await screen.findByRole("combobox")) as HTMLSelectElement;
    expect(sel.value).toBe("adaptive");
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["adaptive", "stable"]);
  });

  it("shows a setup banner (not a silent fallback) when adaptive is not set up, and runs the setup on request", async () => {
    const setup = vi.fn(async () => ({ verified: true, checks: [] }));
    mount(
      { engineChoice: async () => choice({ adaptiveAvailable: false, adaptiveReason: "Nexus Adaptive has not been set up.", effective: null }), adaptiveSetup: setup },
      <EngineChoice />,
    );
    expect(await screen.findByText(/not set up yet/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Set up Nexus Adaptive/ }));
    await waitFor(() => expect(setup).toHaveBeenCalledTimes(1));
  });

  it("saves the preference when the user picks Stable", async () => {
    const prefer = vi.fn(async (e: "adaptive" | "stable") => e);
    mount({ engineChoice: async () => choice(), enginePrefer: prefer }, <EngineChoice />);
    await userEvent.selectOptions(await screen.findByRole("combobox"), "stable");
    expect(prefer).toHaveBeenCalledWith("stable");
  });
});

describe("EngineActivity", () => {
  const summary: RunEngineSummary = {
    run: "run_" + "a".repeat(32),
    live: false,
    bound: { engineId: "nexus-adaptive-v1", modeId: "engineering-v2-adaptive", route: "opencode-go-native/muse-adaptive" },
    record: {
      authenticated: true,
      engineId: "nexus-adaptive-v1",
      modeId: "engineering-v2-adaptive",
      defaultEffort: "medium",
      revision: 3,
      attempts: [{ ordinal: 1, effort: "high", state: "completed" }],
      events: [{ kind: "effort-selected", attempt: 1, effort: "high", detail: null }],
      lineage: null,
      limiter: null,
    },
  };

  it("shows only what the durable record holds", async () => {
    mount({ runEngine: async () => summary }, <EngineActivity runId={summary.run} live={false} />);
    expect(await screen.findByText(/Engine: Nexus Adaptive/)).toBeTruthy();
    expect(screen.getByText(/Reasoning effort chosen/)).toBeTruthy();
  });

  it("shows nothing for a run with no engine (historical runs)", async () => {
    const { container } = mount({}, <EngineActivity runId={"run_" + "b".repeat(32)} live={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector(".nv-engineactivity")).toBeNull();
  });

  it("refuses to show an engine record that failed authentication", async () => {
    mount(
      { runEngine: async () => Promise.reject({ code: "engine-state-unverified", message: "x", class: "refused", retryable: false }) },
      <EngineActivity runId={summary.run} live={false} />,
    );
    expect(await screen.findByText(/could not be verified/)).toBeTruthy();
    expect(screen.queryByText(/Reasoning effort chosen/)).toBeNull();
  });
});
