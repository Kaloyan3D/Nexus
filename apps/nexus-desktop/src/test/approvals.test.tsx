import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi } from "./fakeApi";
import type { ApprovalsView } from "../lib/contracts";

async function open(view: ApprovalsView | Error) {
  const api = fakeApi({
    listApprovals: async () => {
      if (view instanceof Error) throw { code: "x", message: view.message };
      return view;
    },
  });
  const user = userEvent.setup();
  render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
  await user.click(await screen.findByRole("button", { name: /Implement the registry/ }));
  return screen.getByRole("complementary", { name: "Task inspector" });
}

const rec = {
  approvalId: "ab12cd34ef56ab12cd34ef56ab12cd34",
  state: "pending" as const,
  commandId: "c",
  taskInstanceId: "t",
  attemptId: "a",
  toolId: "fs.write",
  scope: "write" as const,
  requestDigest: "f".repeat(64),
  paths: ["src/lib.rs"],
  operationKind: "fs.write",
  createdMs: 1,
  expiresMs: 2,
  decidedMs: null,
  decision: null,
  decisionReason: null,
  approverId: null,
  humanAuthMechanism: null,
  grantRequestId: null,
};

describe("Inspector approvals (A4.2, read-only)", () => {
  it("shows status and offers no approve or deny control", async () => {
    const insp = await open({
      available: true,
      reason: null,
      approvalAction: "terminal-only",
      approvals: [rec, { ...rec, approvalId: "z".repeat(32), state: "consumed", humanAuthMechanism: "approver-uid-terminal-review-code" }],
    });
    const list = await within(insp).findByRole("list", { name: "Approval requests" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Awaiting human review")).toBeTruthy();
    expect(within(list).getByText("Approved and used")).toBeTruthy();
    expect(within(insp).queryByRole("button", { name: /approve|deny/i })).toBeNull();
    expect(within(insp).getByText(/can only display status/)).toBeTruthy();
  });

  it("reports an inactive daemon honestly instead of an empty approved list", async () => {
    const insp = await open({
      available: false,
      reason: "the daemon is not running in human-approval mode",
      approvalAction: "terminal-only",
      approvals: [],
    });
    expect(await within(insp).findByText(/Human approval is not active/)).toBeTruthy();
  });

  it("surfaces backend errors without fabricating state", async () => {
    const insp = await open(new Error("daemon unreachable"));
    expect(await within(insp).findByText(/Approvals unavailable: daemon unreachable/)).toBeTruthy();
  });
});
