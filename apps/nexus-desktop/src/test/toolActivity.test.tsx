import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { TaskToolEvents, ToolEventV1 } from "../lib/contracts";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi } from "./fakeApi";

const base: ToolEventV1 = {
  schemaVersion: 1,
  requestId: "r",
  executionId: "e",
  taskInstanceId: "task_0123456789abcdef0123456789abcdef",
  attemptId: "TASK-0001-A1",
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
  process: null,
  aiInitiated: false,
  leaseEpoch: 3,
  firstSeq: 1,
  lastSeq: 3,
  authorizedAtUtc: "1.0Z",
  lastAtUtc: "2.0Z",
};

async function open(data: TaskToolEvents | Error, seen: string[] = []) {
  const api = fakeApi({
    toolEvents: async (inst) => {
      seen.push(inst);
      if (data instanceof Error) throw { code: "x", message: data.message };
      return data;
    },
  });
  const user = userEvent.setup();
  window.history.replaceState(null, "", "#/advanced/mock");
  render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
  await user.click(await screen.findByRole("button", { name: /Implement the registry/ }));
  return screen.getByRole("complementary", { name: "Task inspector" });
}

describe("Inspector tool activity", () => {
  it("shows events per authoritative attempt and never merges attempts", async () => {
    const seen: string[] = [];
    const insp = await open(
      {
        available: true,
        reason: null,
        attempts: [
          { attemptId: "TASK-0001-A1", sequence: 1, complete: true, error: null, events: [{ ...base, requestId: "r1" }] },
          {
            attemptId: "TASK-0001-A2",
            sequence: 2,
            complete: true,
            error: null,
            events: [{ ...base, requestId: "r2", attemptId: "TASK-0001-A2", leaseEpoch: 4, status: "failed", errorCode: "hardlink-refused" }],
          },
        ],
      },
      seen,
    );
    const a1 = await within(insp).findByRole("list", { name: "Tool executions for TASK-0001-A1" });
    const a2 = within(insp).getByRole("list", { name: "Tool executions for TASK-0001-A2" });
    expect(within(a1).getAllByRole("listitem")).toHaveLength(1);
    expect(within(a2).getByText(/hardlink-refused/)).toBeInTheDocument();
    expect(within(a2).getByText(/generation 4/)).toBeInTheDocument();
    expect(within(a1).queryByText(/hardlink-refused/)).toBeNull();
    // The renderer asks only by task instance: it never supplies an attempt id.
    expect(seen).toEqual(["task_0123456789abcdef0123456789abcdef"]);
  });

  it("shows an explicit unavailable state when attempt identity is not established", async () => {
    const insp = await open({
      available: false,
      reason: "no Controller run directory is configured; attempt identity cannot be established",
      attempts: [],
    });
    expect(await within(insp).findByText(/Tool activity unavailable/)).toBeInTheDocument();
    expect(within(insp).queryByRole("list", { name: /Tool executions/ })).toBeNull();
  });

  it("reports a stale/unknown attempt per attempt instead of hiding or guessing", async () => {
    const insp = await open({
      available: true,
      reason: null,
      attempts: [
        { attemptId: "TASK-0001-A9", sequence: 9, complete: true, error: "intent-unknown", events: [] },
      ],
    });
    expect(await within(insp).findByText(/No kernel record for this attempt \(intent-unknown\)/)).toBeInTheDocument();
  });

  it("surfaces backend errors without inventing events", async () => {
    const insp = await open(new Error("daemon unreachable"));
    expect(await within(insp).findByText(/Tool records unavailable: daemon unreachable/)).toBeInTheDocument();
  });
});
