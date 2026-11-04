import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PermissionPanel, PERMISSION_MODES } from "../features/permissions/PermissionControls";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi, fakeRun } from "./fakeApi";
import type { IntentRun } from "../lib/contracts";
import { describeStep } from "../lib/progress";
import { nowLine } from "../lib/progress";
import { modeLabel } from "../features/permissions/PermissionControls";

const pending = {
  requestId: "pr-1", kind: "dependency-install", digest: "d1d1", program: "cargo", args: ["add", "clap@4", "rusqlite"], cwd: "src",
  plan: { manager: "cargo", verb: "add", packages: [{ name: "clap", constraint: "4" }, { name: "rusqlite", constraint: "" }], options: ["--features bundled"], fromManifest: false },
  purpose: "cargo add clap@4 rusqlite", mode: "ask" as const, createdAtMs: 0, expiresAtMs: Date.now() + 600_000,
};

function mount(run: IntentRun, live: boolean, api = fakeApi()) {
  render(
    <NexusProvider api={api}>
      <PermissionPanel run={run} live={live} />
    </NexusProvider>,
  );
  return api;
}

describe("permission modes (M4.5)", () => {
  it("offers exactly the three modes with their names", () => {
    expect(PERMISSION_MODES.map((m) => m.label)).toEqual(["Ask for Approval", "Auto Approve Safe Operations", "Full Access"]);
    expect(modeLabel(undefined)).toBe("Ask for Approval");
  });

  it("shows the active mode on a live run and the request with packages, versions, manager and workspace", () => {
    mount(fakeRun({ permissionMode: "ask", state: "permission-pending", pendingPermission: pending }), true);
    expect(screen.getByLabelText("Permissions for this run")).toBeInTheDocument();
    expect(screen.getAllByText("Ask for Approval").length).toBeGreaterThan(0);
    const card = screen.getByRole("region", { name: "Permission request" });
    expect(within(card).getByText(/Nexus wants to install dependencies — nothing has run/)).toBeInTheDocument();
    expect(within(card).getByText("cargo")).toBeInTheDocument();
    expect(within(card).getByText("clap (4), rusqlite")).toBeInTheDocument();
    expect(within(card).getByText("--features bundled")).toBeInTheDocument();
    expect(within(card).getByText("src")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /Approve once/ })).toBeEnabled();
    expect(within(card).getByRole("button", { name: /Deny/ })).toBeEnabled();
  });

  it("approve and deny go to the app with the request id and digest, never a path or a command", async () => {
    const api = fakeApi();
    const spy = vi.spyOn(api, "permissionDecide");
    mount(fakeRun({ permissionMode: "ask", pendingPermission: pending }), true, api);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Approve once/ }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.any(String), "pr-1", "d1d1", "approve"));
    await user.click(screen.getByRole("button", { name: /Deny/ }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(expect.any(String), "pr-1", "d1d1", "deny"));
  });

  it("a refused decision is shown, not swallowed", async () => {
    const api = fakeApi();
    vi.spyOn(api, "permissionDecide").mockRejectedValue({ code: "permission-gone", message: "That request is no longer waiting." });
    mount(fakeRun({ permissionMode: "ask", pendingPermission: pending }), true, api);
    await userEvent.setup().click(screen.getByRole("button", { name: /Approve once/ }));
    expect(await screen.findByText(/no longer waiting/)).toBeInTheDocument();
  });

  it("changing the mode of a running task goes through the app (which confirms an upgrade natively)", async () => {
    const api = fakeApi();
    const spy = vi.spyOn(api, "permissionSetMode");
    mount(fakeRun({ permissionMode: "full" }), true, api);
    const group = screen.getByRole("radiogroup", { name: "Change permissions for this run" });
    expect(within(group).getByRole("radio", { name: "Full Access" })).toBeChecked();
    await userEvent.setup().click(within(group).getByRole("radio", { name: "Ask for Approval" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.any(String), "ask"));
  });

  it("a finished run lists what it installed and how each installation was decided", () => {
    const run = fakeRun({
      permissionMode: "full",
      dependencies: [
        { atMs: 1, manager: "cargo", verb: "add", packages: ["clap@4"], command: "cargo add clap@4", mode: "full", decision: "auto-full-access", outcome: "installed", exitCode: 0 },
        { atMs: 2, manager: "npm", verb: "install", packages: [], command: "npm install", mode: "ask", decision: "approved-once", outcome: "installed", exitCode: 0 },
      ],
      terminal: true,
    });
    mount(run, false);
    const list = screen.getByRole("list", { name: "Dependencies this run acquired" });
    expect(list.textContent).toContain("cargo add: clap@4 — installed (exit 0) · automatic (Full Access)");
    expect(list.textContent).toContain("you approved once");
  });

  it("states and denials are worded as what they are", () => {
    expect(nowLine("permission-pending", "npm install")).toContain("Waiting for your decision");
    const s = describeStep({ index: 3, turn: 3, callId: "c", tool: "proc_run", argsSummary: "npm install ./x", status: "refused", errorCode: "permission-denied", approvalOutcome: "refused", resultBytes: 1, truncated: false } as never);
    expect(s.text).toContain("Command not run (permission-denied)");
    expect(s.hint).toContain("continues without it");
  });
});
