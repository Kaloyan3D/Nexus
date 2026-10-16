import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi, fakeRun, view } from "./fakeApi";
import type { NativeApi } from "../lib/api";
import type { IntentRun, ModelConversationSummary, ModelRunStatus, ToolActivity } from "../lib/contracts";

const CONV = "model_0123456789abcdef0123456789abcdef";

function mount(api: NativeApi) {
  return render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
}

const act = (over: Partial<ToolActivity>): ToolActivity => ({
  index: 1,
  turn: 1,
  callId: "call_1",
  tool: "fs_read",
  argsSummary: "path=src/lib.rs",
  status: "executed",
  errorCode: null,
  resultBytes: 100,
  resultDigest: "a".repeat(64),
  truncated: false,
  executionId: "e1",
  journalSeq: 3,
  argsDigest: "b".repeat(64),
  ...over,
});

function codeRun(over: Partial<IntentRun> = {}): IntentRun {
  return fakeRun({
    intentType: "repo-code",
    conversationId: CONV,
    state: "completed",
    terminal: true,
    workspaceId: "proj",
    turn: 7,
    maxTurns: 12,
    editsUsed: 2,
    maxEdits: 5,
    testsUsed: 2,
    maxTests: 5,
    lastTestVerification: "pass",
    worktreeCommit: "c".repeat(40),
    changedFiles: [{ path: "src/lib.rs", status: "M", additions: 1, deletions: 1 }],
    diffDigest: "d".repeat(64),
    toolActivity: [
      act({}),
      act({ index: 2, tool: "fs_edit", argsSummary: "edit src/lib.rs", approvalId: "ap1", approvalOutcome: "approved", preSha256: "1".repeat(64), postSha256: "2".repeat(64) }),
      act({ index: 3, tool: "proc_run", argsSummary: "cargo test --offline", approvalId: "ap2", approvalOutcome: "approved", verification: "fail", exitCode: 101 }),
      act({ index: 4, tool: "fs_write", argsSummary: "write build.rs", status: "refused", errorCode: "invalid-arguments", executionId: null }),
      act({ index: 5, tool: "proc_run", argsSummary: "cargo test --offline", approvalId: "ap3", approvalOutcome: "denied", status: "refused", errorCode: "approval-denied", executionId: null }),
    ],
    ...over,
  });
}

const summary: ModelConversationSummary = {
  conversationId: CONV,
  firstPrompt: "Fix the failing test",
  startedAtMs: 1_790_000_000_000,
  state: "completed",
  terminal: true,
  providerId: "acme",
  remoteModelId: "acme-large-1",
  endpointKind: "provider",
};

const status = (over: Partial<ModelRunStatus> = {}): ModelRunStatus => ({
  conversationId: CONV,
  state: "completed",
  terminal: true,
  providerId: "acme",
  remoteModelId: "acme-large-1",
  logicalModelId: "acme/large",
  endpointKind: "provider",
  attemptId: "T-A3",
  commandId: "shadow-x",
  requestDigest: "d".repeat(64),
  httpStatus: 200,
  usageInputTokens: 10,
  usageOutputTokens: 5,
  finishReason: "stop",
  latencyMs: 20,
  errorCode: null,
  cancelRequested: false,
  text: "",
  ...over,
});

describe("Desktop repo-code (A5.6)", () => {
  it("offers Code only with an operator-approved source and discloses write and execution access", async () => {
    const user = userEvent.setup();
    mount(fakeApi({ intentCodeSources: async () => [] }));
    const none = await screen.findByRole("button", { name: "Code in copy" });
    await waitFor(() => expect(none).toBeDisabled());
    expect(none).toHaveAttribute("title", expect.stringMatching(/No source repository has been approved for coding/));
    cleanup();

    mount(fakeApi({ intentCodeSources: async () => [{ sourceId: "proj" }] }));
    const btn = await screen.findByRole("button", { name: "Code in copy" });
    await waitFor(() => expect(btn).toBeEnabled());
    await user.click(btn);
    expect(await screen.findByText("This mode can change files (in an isolated copy) and run commands")).toBeInTheDocument();
    expect(screen.getByText(/this application cannot approve/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is committed, pushed or merged/)).toBeInTheDocument();
    expect(screen.getByLabelText("Source repository")).toBeInTheDocument();
    // the read-only disclosure is not shown for code mode
    expect(screen.queryByText(/Nothing is written or executed/)).not.toBeInTheDocument();
  });

  it("submits a source IDENTITY and text only; never a path, command, limit or approval", async () => {
    const submit = vi.fn(async (_p: string, _s: string, key: string) => ({
      replay: false,
      run: fakeRun({ requestId: key, conversationId: CONV, state: "executing", intentType: "repo-code" }),
    }));
    const inspectSubmit = vi.fn();
    const api = fakeApi({
      intentCodeSources: async () => [{ sourceId: "proj" }],
      intentCodeSubmit: submit as NativeApi["intentCodeSubmit"],
      intentInspectSubmit: inspectSubmit as unknown as NativeApi["intentInspectSubmit"],
    });
    const user = userEvent.setup();
    mount(api);
    await user.type(await screen.findByLabelText("Task prompt"), "fix the failing test");
    const mode = await screen.findByRole("button", { name: "Code in copy" });
    await waitFor(() => expect(mode).toBeEnabled());
    await user.click(mode);
    const send = await screen.findByRole("button", { name: "Start coding task" });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const call = submit.mock.calls[0]!;
    expect(call.length).toBe(3);
    expect(call[0]).toBe("fix the failing test");
    expect(call[1]).toBe("proj");
    expect(String(call[2])).toMatch(/^gui-[0-9a-f]{16,}/);
    expect(inspectSubmit).not.toHaveBeenCalled();
  });

  it("shows proposed edits, approvals, receipts, test results and a classified diff", async () => {
    const diffText = "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,3 +1,3 @@\n pub fn add(a: i32, b: i32) -> i32 {\n-    a - b\n+    a + b\n }\n";
    const intentDiff = vi.fn(async (id: string) => ({
      run: codeRun({ runId: id }),
      baseCommit: "c".repeat(40),
      files: [{ path: "src/lib.rs", status: "M", additions: 1, deletions: 1 }],
      filesTruncated: false,
      diff: diffText,
      diffDigest: "d".repeat(64),
      diffTruncated: false,
    }));
    const api = fakeApi({
      listModelConversations: async () => [summary],
      modelRunStatus: async () => status(),
      conversationRead: async () => view([]),
      intentList: async () => [codeRun()],
      intentDiff: intentDiff as NativeApi["intentDiff"],
    });
    const user = userEvent.setup();
    mount(api);
    await user.click(await screen.findByRole("button", { name: /Fix the failing test/ }));
    await user.click(await screen.findByRole("tab", { name: "Activity" }));
    const section = await screen.findByRole("region", { name: "Controlled coding" });
    expect(within(section).getByText("Code in isolated copy")).toBeInTheDocument();
    expect(within(section).getByText("Edits 2/5")).toBeInTheDocument();
    expect(within(section).getByText("Commands 2/5")).toBeInTheDocument();
    expect(within(section).getByText("Last test: passed")).toBeInTheDocument();
    const table = within(section).getByRole("table", { name: "Proposed edits and tool activity" });
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    expect(within(table).getByText("edit src/lib.rs")).toBeInTheDocument();
    expect(within(table).getByText(/tests failed \(exit 101\)/)).toBeInTheDocument();
    expect(within(table).getByText("refused · invalid-arguments")).toBeInTheDocument();
    expect(within(table).getByText("denied")).toBeInTheDocument();
    expect(within(table).getByText("1111111111 → 2222222222")).toBeInTheDocument();
    expect(within(section).getByRole("list", { name: "Changed files" })).toHaveTextContent("M src/lib.rs +1 -1");
    expect(within(section).getByText(/Nothing is committed, pushed or merged automatically/)).toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "Show diff" }));
    const viewer = await screen.findByLabelText("Unified diff");
    expect(intentDiff).toHaveBeenCalledWith(codeRun().runId);
    const lines = Array.from(viewer.querySelectorAll("[data-diff]")).map((n) => [n.getAttribute("data-diff"), n.textContent]);
    expect(lines).toContainEqual(["del", "-    a - b"]);
    expect(lines).toContainEqual(["add", "+    a + b"]);
    // there is no apply / commit / push / approve control anywhere
    for (const bad of [/apply/i, /commit/i, /push/i, /merge/i, /^approve/i, /^deny/i]) {
      expect(screen.queryByRole("button", { name: bad })).not.toBeInTheDocument();
    }
  });

  it("explains a pending approval without offering to give it, and offers cancel", async () => {
    const running = status({ state: "approval-pending", terminal: false });
    const api = fakeApi({
      listModelConversations: async () => [{ ...summary, state: "approval-pending", terminal: false }],
      modelRunStatus: async () => running,
      conversationRead: async () => view([]),
      intentList: async () => [
        codeRun({
          state: "approval-pending",
          terminal: false,
          changedFiles: [],
          pendingApproval: { approvalId: "ap9", tool: "fs_edit", summary: "edit src/lib.rs", requestDigest: "e".repeat(64), expiresAtMs: 9 },
        }),
      ],
    });
    const user = userEvent.setup();
    mount(api);
    await user.click(await screen.findByRole("button", { name: /Fix the failing test/ }));
    await user.click(await screen.findByRole("tab", { name: "Activity" }));
    const alert = await screen.findByText("Waiting for an independent approval");
    expect(alert).toBeInTheDocument();
    expect(screen.getByText(/Nexus Desktop cannot approve/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has run/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Cancel run" })[0]).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show diff/ })).not.toBeInTheDocument();
  });

  it("surfaces an uncertain write or command as such", async () => {
    const api = fakeApi({
      listModelConversations: async () => [summary],
      modelRunStatus: async () => status({ state: "uncertain", errorCode: "tool-outcome-uncertain" }),
      conversationRead: async () => view([]),
      intentList: async () => [codeRun({ state: "uncertain", errorCode: "tool-outcome-uncertain" })],
    });
    const user = userEvent.setup();
    mount(api);
    await user.click(await screen.findByRole("button", { name: /Fix the failing test/ }));
    await user.click(await screen.findByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("A write or command may or may not have happened")).toBeInTheDocument();
    expect(screen.getByText(/not repeated/)).toBeInTheDocument();
  });
});
