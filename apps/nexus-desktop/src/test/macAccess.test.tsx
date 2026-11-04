import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi } from "./fakeApi";
import type { NativeApi } from "../lib/api";
import type { ProjectView, RuntimeState } from "../lib/contracts";

const rt: RuntimeState = {
  mode: "interactive", phase: "ready", message: null, home: null, providerConnected: true,
  consent: { given: true, providerId: "p", remoteModelId: "m", text: "t" }, canOpenProjects: true,
};
const support = { known: true, standingGrants: true, askAvailable: false, askReason: "no approver", inPlaceAvailable: true };

/** A Mac folder as the Mac host presents it: the ENGINE's workspace/grant truth plus the Mac-side sync. */
const macProject = (over: Partial<ProjectView> = {}): ProjectView => ({
  projectId: "site-abc", label: "site", macPath: "/Users/me/site", managed: true, kinds: [], pinnedCommit: "", writeAllow: [],
  snapshotAtMs: 1, originDirty: false, changedSinceSnapshot: null, workspaceMode: "direct",
  sync: { state: "synced", generation: 1, consent: true, applyUnverified: false, files: 4, skippedTotal: 0, conflicts: [], lastSyncMs: Date.now() },
  ...over,
});
const activeGrant = { grantId: "g", version: 1, digest: "d".repeat(64), fs: "workspace" as const, net: "offline" as const, approval: "auto" as const, expiresAtMs: null, createdAtMs: 1, createdBy: "desktop:uid:1000", status: "active" as const, revokedAtMs: null, history: [] };

function mount(api: NativeApi) {
  window.history.replaceState(null, "", "#/projects");
  return render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
}
afterEach(cleanup);

async function card() {
  const region = await screen.findByRole("region", { name: "Opened projects" });
  return within(within(region).getByRole("article", { name: "Project site" }));
}

describe("Projects page for a Mac folder synchronized with the Linux engine", () => {
  it("keeps engine permissions and Mac updates apart and never uses the Linux-copy wording", async () => {
    mount(fakeApi({ runtimeState: async () => rt, projectList: async () => ({ projects: [macProject()], permissions: support }) }));
    const c = await card();
    expect(c.getByText("Updating your Mac folder")).toBeInTheDocument();
    expect(c.getByText("What Nexus may do in its Linux engine")).toBeInTheDocument();
    expect(c.getByText("verified results only")).toBeInTheDocument();
    expect(c.queryByText(/Nexus works on a copy and you apply its changes/)).toBeNull();
    expect(c.queryByRole("button", { name: /Let Nexus edit site directly|Edit my folder/ })).toBeNull();
    expect(c.queryByText("on a copy")).toBeNull();
    expect(c.getByText("in the engine's copy")).toBeInTheDocument();
    expect(c.getByText("/Users/me/site")).toBeInTheDocument();
  });

  it("the Mac-update policy states exactly what the host will do (verified only, or verified plus untestable)", async () => {
    const sync = (applyUnverified: boolean) => macProject({ sync: { ...macProject().sync!, applyUnverified } });
    mount(fakeApi({ runtimeState: async () => rt, projectList: async () => ({ projects: [sync(true)], permissions: support }) }));
    const c = await card();
    expect(c.getByText("verified and untestable results")).toBeInTheDocument();
    expect(c.getAllByText(/Never after failed checks, a cancelled task or an error/).length).toBeGreaterThan(0);
    expect(c.queryByText(/only after a task whose checks passed\. A task that could not be verified is not applied/)).toBeNull();
  });

  it("Run commands → Allow… asks the engine, then the page shows the grant that was applied", async () => {
    let granted = false;
    const allow = vi.fn(async () => {
      granted = true;
      return { project: {} };
    });
    const list = vi.fn(async () => ({ projects: [macProject(granted ? { grant: activeGrant } : {})], permissions: support }));
    const user = userEvent.setup();
    mount(fakeApi({ runtimeState: async () => rt, projectList: list, projectAllowWork: allow }));
    const c = await card();
    expect(c.getByText("temporary copy")).toBeInTheDocument();
    await user.click(c.getByRole("button", { name: "Allow Nexus to edit and run commands in site" }));
    expect(allow).toHaveBeenCalledWith("site-abc");
    await waitFor(() => expect(c.getByText("in the project copy")).toBeInTheDocument());
    expect(c.queryByRole("button", { name: "Allow Nexus to edit and run commands in site" })).toBeNull();
    expect(c.getByText(/The project's permissions were updated/)).toBeInTheDocument();
    // the click was not "nothing": the list was re-read after the confirmation
    expect(list.mock.calls.length).toBeGreaterThan(1);
  });

  it("Cancel is visible and leaves everything as it was", async () => {
    const allow = vi.fn(async () => Promise.reject({ code: "cancelled", message: "cancelled" }));
    const user = userEvent.setup();
    mount(fakeApi({ runtimeState: async () => rt, projectList: async () => ({ projects: [macProject()], permissions: support }), projectAllowWork: allow }));
    const c = await card();
    await user.click(c.getByRole("button", { name: "Allow Nexus to edit and run commands in site" }));
    await waitFor(() => expect(c.getByText("Cancelled. Nothing was changed.")).toBeInTheDocument());
    expect(c.getByText("temporary copy")).toBeInTheDocument();
    expect(c.queryByText("That did not change anything")).toBeNull();
  });

  it("a dialog that could not be shown or a refused grant is an actionable error, not silence", async () => {
    const allow = vi.fn(async () => Promise.reject({ code: "project", message: "the Mac could not show the confirmation: no display" }));
    const user = userEvent.setup();
    mount(fakeApi({ runtimeState: async () => rt, projectList: async () => ({ projects: [macProject()], permissions: support }), projectAllowWork: allow }));
    const c = await card();
    await user.click(c.getByRole("button", { name: "Allow Nexus to edit and run commands in site" }));
    await waitFor(() => expect(c.getByText("That did not change anything")).toBeInTheDocument());
    expect(c.getByText(/could not show the confirmation: no display/)).toBeInTheDocument();
  });

  it("a Linux-only project keeps its original wording", async () => {
    const linux = { ...macProject(), sync: undefined, macPath: undefined, workspaceMode: "isolated" as const };
    mount(fakeApi({ runtimeState: async () => rt, projectList: async () => ({ projects: [linux], permissions: support }) }));
    const c = await card();
    expect(c.getByText("on a copy")).toBeInTheDocument();
    expect(c.getByRole("button", { name: "Let Nexus edit site directly" })).toBeInTheDocument();
    expect(c.queryByText("Updating your Mac folder")).toBeNull();
  });
});
