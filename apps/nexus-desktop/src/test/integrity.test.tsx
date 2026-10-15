import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi } from "./fakeApi";
import type { IntegrityView } from "../lib/contracts";

async function open(view: IntegrityView | Error) {
  const api = fakeApi({
    integrityStatus: async () => {
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
  const nav = await screen.findAllByRole("button", { name: /Control Room/ });
  await user.click(nav[0]!);
}

describe("Control Room journal integrity (A4.3, read-only)", () => {
  it("shows the state together with its verification scope", async () => {
    await open({
      state: "verified",
      scope: "detects rollback relative to a separate same-host witness identity; does not resist root",
      configured: true,
      detail: "",
      journals: [{ journal: "tool-journal", localCount: 4, witnessCount: 4, status: "verified", detail: "" }],
    });
    expect(await screen.findByText(/Verified against independent witness/)).toBeTruthy();
    expect(screen.getByText(/does not resist root/)).toBeTruthy();
    expect(screen.queryByText(/^secure$/i)).toBeNull();
  });

  it("surfaces mismatch and unconfigured states honestly", async () => {
    await open({
      state: "integrity-mismatch",
      scope: "scope text",
      configured: true,
      detail: "tool-journal: local journal is behind the witness",
      journals: [],
    });
    expect(await screen.findByText("Integrity mismatch")).toBeTruthy();
    expect(screen.getByText(/behind the witness/)).toBeTruthy();
  });

  it("reports unavailability without fabricating a healthy state", async () => {
    await open(new Error("daemon unreachable"));
    expect(await screen.findByText(/Integrity status unavailable: daemon unreachable/)).toBeTruthy();
  });
});
