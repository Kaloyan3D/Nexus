import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi, fakeRun, view } from "./fakeApi";
import type { NativeApi } from "../lib/api";
import type { IntentRun, ModelConversationSummary, ModelRunStatus, PendingApproval, ToolActivity } from "../lib/contracts";

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
    expect(send).toBeDisabled(); // no acknowledgement yet
    await user.click(await screen.findByRole("checkbox", { name: "Acknowledge disclosure" }));
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
          pendingApproval: { approvalId: "ap9", tool: "fs_edit", summary: "edit src/lib.rs", requestDigest: "e".repeat(64), expiresAtMs: Date.now() + 60_000 },
        }),
      ],
    });
    const user = userEvent.setup();
    mount(api);
    await user.click(await screen.findByRole("button", { name: /Fix the failing test/ }));
    await user.click(await screen.findByRole("tab", { name: "Activity" }));
    const card = await screen.findByRole("region", { name: "Pending approval" });
    expect(within(card).getByText(/Waiting for an independent approval/)).toBeInTheDocument();
    expect(screen.getAllByText(/Nexus Desktop cannot approve/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/nothing has run/i).length).toBeGreaterThan(0);
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

const pa = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  approvalId: "ap9",
  tool: "fs_edit",
  summary: "edit src/lib.rs",
  requestDigest: "e".repeat(64),
  expiresAtMs: Date.now() + 120_000,
  operation: "edit",
  target: "src/lib.rs",
  proposal: "@@ edit 1 @@\n- a - b\n+ a + b\n",
  restrictions: ["changes are made only in the throw-away working copy, never in your repository", "nothing is committed, pushed or merged"],
  createdAtMs: Date.now(),
  ...over,
});

async function openRun(run: IntentRun, extra: Partial<NativeApi> = {}) {
  const api = fakeApi({
    listModelConversations: async () => [{ ...summary, state: run.state, terminal: run.terminal }],
    modelRunStatus: async () => status({ state: run.state, terminal: run.terminal }),
    conversationRead: async () => view([]),
    intentList: async () => [run],
    ...extra,
  });
  const user = userEvent.setup();
  mount(api);
  await user.click(await screen.findByRole("button", { name: /Fix the failing test/ }));
  return { user, api };
}

describe("Desktop coding GUI (A6.1)", () => {
  it("shows the fixed run limits and source identity, and keeps Start disabled until the disclosure is acknowledged", async () => {
    const user = userEvent.setup();
    mount(fakeApi({ intentCodeSources: async () => [{ sourceId: "synthetic-test" }, { sourceId: "nexus-self" }] }));
    const btn = await screen.findByRole("button", { name: "Code in copy" });
    await waitFor(() => expect(btn).toBeEnabled());
    await user.click(btn);
    const terms = await screen.findByRole("region", { name: "Coding task terms" });
    expect(within(terms).getByText(/synthetic-test \(registered by the operator; not a typed path\)/)).toBeInTheDocument();
    expect(within(terms).getByText(/12 model turns · 30 tool calls · 5 edits · 5 commands · 1024 output tokens per call · 128 KiB of tool results · 30 min/)).toBeInTheDocument();
    // only operator-registered identities are selectable: a <select>, no free text for the source
    const sel = screen.getByLabelText("Source repository") as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(["synthetic-test", "nexus-self"]);
    expect(screen.queryByPlaceholderText(/path/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Task prompt"), "do it");
    const start = screen.getByRole("button", { name: "Start coding task" });
    expect(start).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Acknowledge disclosure" }));
    expect(start).toBeEnabled();
    await user.click(screen.getByRole("checkbox", { name: "Acknowledge disclosure" }));
    expect(start).toBeDisabled();
  });

  it("shows the exact byte count and SHA-256 of the prompt, which changes with a trailing newline", async () => {
    const user = userEvent.setup();
    mount(fakeApi({ intentCodeSources: async () => [{ sourceId: "proj" }] }));
    const btn = await screen.findByRole("button", { name: "Code in copy" });
    await waitFor(() => expect(btn).toBeEnabled());
    await user.click(btn);
    expect(screen.getByLabelText("Prompt fingerprint")).toHaveTextContent("appears once you type");
    await user.type(screen.getByLabelText("Task prompt"), "abc");
    // sha256("abc")
    await waitFor(() =>
      expect(screen.getByLabelText("Prompt fingerprint")).toHaveTextContent(
        "3 bytes · sha256 ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      ),
    );
    await user.type(screen.getByLabelText("Task prompt"), "{Enter}");
    await waitFor(() => expect(screen.getByLabelText("Prompt fingerprint")).toHaveTextContent("4 bytes"));
    // sha256("abc\n") is a different value
    expect(screen.getByLabelText("Prompt fingerprint")).not.toHaveTextContent("ba7816bf8f01cfea");
    // text-only mode shows no fingerprint (nothing is bound to it)
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.queryByLabelText("Prompt fingerprint")).not.toBeInTheDocument();
  });

  it("refuses to submit when the backend reports no limits", async () => {
    const user = userEvent.setup();
    mount(fakeApi({ intentCodeSources: async () => [{ sourceId: "proj" }], intentCodeLimits: async () => Promise.reject(new Error("down")) }));
    const btn = await screen.findByRole("button", { name: "Code in copy" });
    await waitFor(() => expect(btn).toBeEnabled());
    await user.click(btn);
    expect(await screen.findByText(/did not report limits, so submitting is disabled/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Task prompt"), "x");
    await user.click(screen.getByRole("checkbox", { name: "Acknowledge disclosure" }));
    expect(screen.getByRole("button", { name: "Start coding task" })).toBeDisabled();
  });

  it("keeps the task text and shows the broker's reason when submission fails", async () => {
    const user = userEvent.setup();
    const submit = vi.fn(async () => {
      throw { code: "workspace-not-allowed", message: "that source is not available to you", class: "refused", retryable: false };
    });
    mount(fakeApi({ intentCodeSources: async () => [{ sourceId: "proj" }], intentCodeSubmit: submit as unknown as NativeApi["intentCodeSubmit"] }));
    const btn = await screen.findByRole("button", { name: "Code in copy" });
    await waitFor(() => expect(btn).toBeEnabled());
    await user.click(btn);
    await user.type(screen.getByLabelText("Task prompt"), "fix it");
    await user.click(screen.getByRole("checkbox", { name: "Acknowledge disclosure" }));
    await user.click(screen.getByRole("button", { name: "Start coding task" }));
    expect(await screen.findByText(/Send failed: workspace-not-allowed/)).toBeInTheDocument();
    expect(screen.getByText(/that source is not available to you/)).toBeInTheDocument();
    expect((screen.getByLabelText("Task prompt") as HTMLTextAreaElement).value).toBe("fix it");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("switching modes does not leak an acknowledgement or a source into the text-only request", async () => {
    const user = userEvent.setup();
    const sendText = vi.fn(async (_p: string, _m: unknown, key: string) => ({ replay: false, run: fakeRun({ requestId: key, conversationId: null, state: "preparing" }) }));
    const code = vi.fn();
    mount(fakeApi({ intentCodeSources: async () => [{ sourceId: "proj" }], intentSubmit: sendText as unknown as NativeApi["intentSubmit"], intentCodeSubmit: code as unknown as NativeApi["intentCodeSubmit"] }));
    const codeBtn = await screen.findByRole("button", { name: "Code in copy" });
    await waitFor(() => expect(codeBtn).toBeEnabled());
    await user.click(codeBtn);
    await user.click(screen.getByRole("checkbox", { name: "Acknowledge disclosure" }));
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.queryByRole("region", { name: "Coding task terms" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Task prompt"), "hello");
    await user.click(screen.getByRole("button", { name: "Send to model" }));
    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    expect(code).not.toHaveBeenCalled();
  });

  it("shows a prominent approval card with the exact proposal, target, restrictions, expiry and the separate approver command", async () => {
    await openRun(codeRun({ state: "approval-pending", terminal: false, changedFiles: [], pendingApproval: pa() }));
    const card = await screen.findByRole("region", { name: "Pending approval" });
    expect(card).toHaveAttribute("data-expired", "false");
    expect(within(card).getByText("Edit file")).toBeInTheDocument();
    expect(within(card).getByText("src/lib.rs")).toBeInTheDocument();
    expect(within(card).getByLabelText(/Proposed operation/)).toHaveTextContent("- a - b");
    expect(within(card).getByLabelText(/Proposed operation/)).toHaveTextContent("+ a + b");
    expect(within(card).getByLabelText("Restrictions")).toHaveTextContent("throw-away working copy");
    expect(within(card).getByText(/expires in \d+s/)).toBeInTheDocument();
    expect(within(card).getByLabelText("Approver command")).toHaveTextContent("nexus-approver");
    expect(within(card).getByLabelText("Approver command")).toHaveTextContent("review ap9");
    expect(within(card).getByText(/cannot approve or deny/)).toBeInTheDocument();
    // there is nothing to click that approves, denies or runs anything
    for (const bad of [/approve/i, /deny/i, /allow/i, /^run/i, /apply/i, /merge/i, /commit/i, /push/i]) {
      expect(within(card).queryByRole("button", { name: bad })).not.toBeInTheDocument();
    }
    expect(within(card).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("labels the contents as the model's proposal, not the authoritative request, and points to the approver review", async () => {
    await openRun(codeRun({ state: "approval-pending", terminal: false, pendingApproval: pa() }));
    const card = await screen.findByRole("region", { name: "Pending approval" });
    const note = within(card).getByRole("note");
    expect(note).toHaveTextContent("Model proposal — not the authoritative request.");
    expect(note).toHaveTextContent(/derived by the daemon and is shown only to the approver/);
    expect(note).toHaveTextContent(/Inspect that actual request in nexus-approver review before approving/);
    expect(within(card).getByLabelText("Proposed operation (model proposal, unverified)")).toBeInTheDocument();
    // the label precedes the contents in reading order
    const pre = within(card).getByLabelText(/Proposed operation/);
    expect(note.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows a pending command with its sandbox restrictions", async () => {
    await openRun(
      codeRun({
        state: "approval-pending",
        terminal: false,
        pendingApproval: pa({
          tool: "proc_run",
          operation: "command",
          target: "cargo",
          summary: "cargo test --offline",
          proposal: "cargo test --offline\n(working directory: .)",
          restrictions: ["network access is disabled", "runs over a read-only snapshot of the working copy; nothing it writes is kept"],
        }),
      }),
    );
    const card = await screen.findByRole("region", { name: "Pending approval" });
    expect(within(card).getByText("Run command")).toBeInTheDocument();
    expect(within(card).getByLabelText(/Proposed operation/)).toHaveTextContent("cargo test --offline");
    expect(within(card).getByLabelText("Restrictions")).toHaveTextContent("network access is disabled");
    expect(within(card).getByLabelText("Restrictions")).toHaveTextContent("read-only snapshot");
    expect(within(card).getByText(/argument vector and sandbox policy/)).toBeInTheDocument();
  });

  it("marks an approval whose time has passed as expired and says nothing ran", async () => {
    await openRun(codeRun({ state: "approval-pending", terminal: false, pendingApproval: pa({ expiresAtMs: Date.now() - 5_000 }) }));
    const card = await screen.findByRole("region", { name: "Pending approval" });
    expect(card).toHaveAttribute("data-expired", "true");
    expect(within(card).getAllByText(/expired/i).length).toBeGreaterThan(0);
    expect(within(card).getByText(/nothing ran/i)).toBeInTheDocument();
  });

  it("shows tool progress, a failed test and its output via the run's activity", async () => {
    const run = codeRun({
      state: "tool-running",
      terminal: false,
      lastTestVerification: "fail",
      pendingApproval: null,
      toolActivity: [
        act({}),
        act({ index: 2, tool: "proc_run", argsSummary: "cargo test --offline", approvalId: "a2", approvalOutcome: "approved", verification: "fail", exitCode: 101 }),
      ],
    });
    await openRun(run);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Activity" }));
    const section = await screen.findByRole("region", { name: "Controlled coding" });
    expect(within(section).getByText("Last test: failed")).toBeInTheDocument();
    expect(within(section).getByText(/tests failed \(exit 101\)/)).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "Show diff" })).not.toBeInTheDocument(); // not terminal yet
  });

  it("a failed diff load is reported, not hidden", async () => {
    const { user } = await openRun(codeRun(), { intentDiff: async () => { throw { code: "not-found", message: "no such run", class: "refused", retryable: false }; } });
    await user.click(await screen.findByRole("tab", { name: "Activity" }));
    await user.click(await screen.findByRole("button", { name: "Show diff" }));
    expect(await screen.findByText(/no such run/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Unified diff")).not.toBeInTheDocument();
  });

  it("restores a persisted result after the app restarts (fresh mount reads run history)", async () => {
    const run = codeRun();
    const api = fakeApi({
      listModelConversations: async () => [summary],
      modelRunStatus: async () => status(),
      conversationRead: async () => view([]),
      intentList: async () => [run],
      intentDiff: async (id: string) => ({ run: { ...run, runId: id }, baseCommit: "c".repeat(40), files: run.changedFiles ?? [], filesTruncated: false, diff: "--- a\n+++ b\n-    a - b\n+    a + b\n", diffDigest: "d".repeat(64), diffTruncated: false }),
    });
    for (let launch = 0; launch < 2; launch++) {
      const user = userEvent.setup();
      mount(api);
      await user.click(await screen.findByRole("button", { name: /Fix the failing test/ }));
      await user.click(await screen.findByRole("tab", { name: "Activity" }));
      const section = await screen.findByRole("region", { name: "Controlled coding" });
      expect(within(section).getByText("Last test: passed")).toBeInTheDocument();
      await user.click(within(section).getByRole("button", { name: "Show diff" }));
      expect((await screen.findByLabelText("Unified diff")).textContent).toContain("+    a + b");
      cleanup();
    }
  });

  it("offers cancel for a running coding task and reports the request", async () => {
    const cancel = vi.fn(async () => undefined);
    await openRun(codeRun({ state: "tool-running", terminal: false, pendingApproval: null }), {
      modelRunStatus: async () => status({ state: "tool-running", terminal: false }),
      cancelModelRun: cancel as unknown as NativeApi["cancelModelRun"],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Activity" }));
    const btns = await screen.findAllByRole("button", { name: "Cancel run" });
    await user.click(btns[0]!);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(CONV));
  });

  it("the renderer source holds no approver, issuer or provider credential and never talks to the daemon", async () => {
    const files = import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const prod = Object.entries(files).filter(([k]) => !k.includes("/test/"));
    expect(prod.length).toBeGreaterThan(10);
    for (const [name, text] of prod) {
      for (const bad of ["approval-decide", "approval-get", "approver.cap", "issuer.cap", "OPENCODE_API_KEY", "tool-execute", "read_capability", "signed_frame", "cap-handoff"]) {
        expect(text.includes(bad), `${name} mentions ${bad}`).toBe(false);
      }
    }
    // the only approval-related backend call exposed to the renderer is read-only status
    const api = prod.find(([k]) => k.endsWith("lib/api.ts"))![1];
    expect(api).not.toMatch(/invoke<[^>]*>\("(approval_decide|approval_get|approval_request|approval_revoke|decide|issuer|tool_execute)/);
    expect(api).toContain("list_approvals");
  });
});

describe("run-history polling (A6.1)", () => {
  const listCalls = (calls: { n: number }) => calls.n;

  it("stops polling run history once the selected run is terminal, but a fresh mount reads it again", async () => {
    const calls = { n: 0 };
    const api = fakeApi({
      listModelConversations: async () => [summary],
      modelRunStatus: async () => status(),
      conversationRead: async () => view([]),
      intentList: async () => {
        calls.n += 1;
        return [codeRun()];
      },
    });
    const user = userEvent.setup();
    mount(api);
    await user.click(await screen.findByRole("button", { name: /Fix the failing test/ }));
    await waitFor(() => expect(listCalls(calls)).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 400)); // let in-flight loads settle
    const settled = listCalls(calls);
    await new Promise((r) => setTimeout(r, 3400)); // > two 1.5 s intervals
    expect(listCalls(calls)).toBe(settled);
    // reconnect: a fresh mount fetches again and shows the persisted result
    cleanup();
    const before = listCalls(calls);
    const user2 = userEvent.setup();
    mount(api);
    await user2.click(await screen.findByRole("button", { name: /Fix the failing test/ }));
    await waitFor(() => expect(listCalls(calls)).toBeGreaterThan(before));
    await user2.click(await screen.findByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("Last test: passed")).toBeInTheDocument();
  }, 15000);

  it("keeps polling while the run is live and stops after it ends; the approval banner disappears with it", async () => {
    const calls = { n: 0 };
    let ended = false;
    const live = codeRun({ state: "approval-pending", terminal: false, pendingApproval: pa(), changedFiles: [] });
    const api = fakeApi({
      listModelConversations: async () => [summary],
      modelRunStatus: async () => status({ state: ended ? "completed" : "approval-pending", terminal: ended }),
      conversationRead: async () => view([]),
      intentList: async () => {
        calls.n += 1;
        return [ended ? codeRun() : live];
      },
    });
    const user = userEvent.setup();
    mount(api);
    await user.click(await screen.findByRole("button", { name: /Fix the failing test/ }));
    expect(await screen.findByRole("region", { name: "Pending approval" })).toBeInTheDocument();
    const a = listCalls(calls);
    await waitFor(() => expect(listCalls(calls)).toBeGreaterThan(a), { timeout: 4000 }); // live: still polling
    ended = true;
    await waitFor(() => expect(screen.queryByRole("region", { name: "Pending approval" })).not.toBeInTheDocument(), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 400));
    const settled = listCalls(calls);
    await new Promise((r) => setTimeout(r, 3400));
    expect(listCalls(calls)).toBe(settled);
  }, 20000);
});
