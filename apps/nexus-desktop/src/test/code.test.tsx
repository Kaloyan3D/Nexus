import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { ev, fakeApi, fakeRun, view } from "./fakeApi";
import type { NativeApi } from "../lib/api";
import type { IntentRun, ModelConversationSummary, ModelRunStatus, PendingApproval, ToolActivity } from "../lib/contracts";

const CONV = "model_0123456789abcdef0123456789abcdef";

function mount(api: NativeApi, hash = "#") {
  window.history.replaceState(null, "", hash);
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

const passed = {
  verification: "verified-passed",
  change: "applied",
  editsApplied: 1,
  editsNotApplied: 0,
  testsExecuted: 1,
  testsNotExecuted: 0,
  blockedByApproval: 0,
  lastExitCode: 0,
  staleAfterEdit: false,
  uncertainOperations: 0,
};
const blocked = { ...passed, verification: "blocked-by-approval", change: "not-applied", editsApplied: 0, editsNotApplied: 1, testsExecuted: 0, testsNotExecuted: 1, blockedByApproval: 2, lastExitCode: null };

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

const expiredRun = (over: Partial<IntentRun> = {}) =>
  codeRun({
    state: "completed",
    terminal: true,
    lastTestVerification: null,
    changedFiles: [],
    editsUsed: 1,
    testsUsed: 1,
    toolActivity: [
      act({}),
      act({ index: 2, tool: "fs_edit", argsSummary: "edit src/lib.rs", status: "refused", errorCode: "approval-expired", approvalId: "a1", approvalOutcome: "expired", executionId: null }),
      act({ index: 3, tool: "proc_run", argsSummary: "cargo test --offline", status: "refused", errorCode: "approval-expired", approvalId: "a2", approvalOutcome: "expired", executionId: null }),
    ],
    codingOutcome: blocked,
    ...over,
  });

const passedRun = (over: Partial<IntentRun> = {}) =>
  codeRun({
    codingOutcome: passed,
    toolActivity: [
      act({}),
      act({ index: 2, tool: "fs_edit", argsSummary: "edit src/lib.rs", approvalId: "a", approvalOutcome: "approved", preSha256: "1".repeat(64), postSha256: "2".repeat(64) }),
      act({ index: 3, tool: "proc_run", argsSummary: "cargo test --offline", approvalId: "b", approvalOutcome: "approved", verification: "pass", exitCode: 0 }),
    ],
    ...over,
  });

describe("Code in copy: composer (A6.1.2)", () => {
  it("offers Code in copy only with an authorized project, shows backend limits, scope and disclosure, and gates Start", async () => {
    const user = userEvent.setup();
    mount(fakeApi({ intentCodeSources: async () => [] }));
    const none = await screen.findByRole("radio", { name: "Code in copy" });
    await waitFor(() => expect(none).toBeDisabled());
    expect(none).toHaveAttribute("title", expect.stringMatching(/No project has been authorized for coding/));
    cleanup();

    mount(fakeApi({ intentCodeSources: async () => [{ sourceId: "synthetic-test", pinnedCommit: "ab".repeat(20), writeAllow: ["src/"] }, { sourceId: "other" }] }));
    const radio = await screen.findByRole("radio", { name: "Code in copy" });
    await waitFor(() => expect(radio).toBeEnabled());
    await user.click(radio);
    const terms = await screen.findByRole("region", { name: "Coding task terms" });
    expect(within(terms).getAllByText(/synthetic-test/).length).toBeGreaterThan(0);
    expect(within(terms).getByText(/registered by the operator, not a typed path/)).toBeInTheDocument();
    expect(within(terms).getByText(/pinned to ababababab/)).toBeInTheDocument();
    expect(within(terms).getByText(/writes limited to src\//)).toBeInTheDocument();
    expect(within(terms).getByText(/12 model turns · 30 tool calls · 5 edits · 5 commands · 1024 output tokens per call · 128 KiB of tool results · 30 min/)).toBeInTheDocument();
    const sel = screen.getByLabelText("Project") as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(["synthetic-test", "other"]);
    expect(screen.queryByPlaceholderText(/path/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Task prompt"), "do it");
    const start = screen.getByRole("button", { name: "Start coding" });
    expect(start).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Acknowledge disclosure" }));
    expect(start).toBeEnabled();
    await user.click(screen.getByRole("checkbox", { name: "Acknowledge disclosure" }));
    expect(start).toBeDisabled();
    // the long-form warning is one click away, never hidden from the person who needs it
    await user.click(within(terms).getByRole("button", { name: "more" }));
    expect(screen.getByText("This mode can change files (in an isolated copy) and run commands")).toBeInTheDocument();
  });

  it("submits a project IDENTITY and text only; never a path, command, limit or approval", async () => {
    const submit = vi.fn(async (_p: string, _s: string, key: string) => ({ replay: false, run: fakeRun({ requestId: key, conversationId: CONV, state: "executing", intentType: "repo-code" }) }));
    const inspectSubmit = vi.fn();
    const api = fakeApi({
      intentCodeSources: async () => [{ sourceId: "proj" }],
      intentCodeSubmit: submit as NativeApi["intentCodeSubmit"],
      intentInspectSubmit: inspectSubmit as unknown as NativeApi["intentInspectSubmit"],
    });
    const user = userEvent.setup();
    mount(api);
    await user.type(await screen.findByLabelText("Task prompt"), "fix the failing test");
    const mode = await screen.findByRole("radio", { name: "Code in copy" });
    await waitFor(() => expect(mode).toBeEnabled());
    await user.click(mode);
    const send = await screen.findByRole("button", { name: "Start coding" });
    expect(send).toBeDisabled();
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

  it("shows the exact byte count and SHA-256 of the prompt, which changes with a trailing newline", async () => {
    const user = userEvent.setup();
    mount(fakeApi({ intentCodeSources: async () => [{ sourceId: "proj" }] }));
    const radio = await screen.findByRole("radio", { name: "Code in copy" });
    await waitFor(() => expect(radio).toBeEnabled());
    await user.click(radio);
    expect(screen.getByLabelText("Prompt fingerprint")).toHaveTextContent("appears once you type");
    await user.type(screen.getByLabelText("Task prompt"), "abc");
    await waitFor(() => expect(screen.getByLabelText("Prompt fingerprint")).toHaveTextContent("3 bytes · sha256 ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    await user.type(screen.getByLabelText("Task prompt"), "{Enter}");
    await waitFor(() => expect(screen.getByLabelText("Prompt fingerprint")).toHaveTextContent("4 bytes"));
    expect(screen.getByLabelText("Prompt fingerprint")).not.toHaveTextContent("ba7816bf8f01cfea");
    await user.click(screen.getByRole("radio", { name: "Ask" }));
    expect(screen.queryByLabelText("Prompt fingerprint")).not.toBeInTheDocument();
  });

  it("refuses to submit when the backend reports no limits", async () => {
    const user = userEvent.setup();
    mount(fakeApi({ intentCodeSources: async () => [{ sourceId: "proj" }], intentCodeLimits: async () => Promise.reject(new Error("down")) }));
    const radio = await screen.findByRole("radio", { name: "Code in copy" });
    await waitFor(() => expect(radio).toBeEnabled());
    await user.click(radio);
    expect(await screen.findByText(/did not report limits, so submitting is disabled/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Task prompt"), "x");
    await user.click(screen.getByRole("checkbox", { name: "Acknowledge disclosure" }));
    expect(screen.getByRole("button", { name: "Start coding" })).toBeDisabled();
  });

  it("keeps the task text and shows the broker's reason when submission fails", async () => {
    const user = userEvent.setup();
    const submit = vi.fn(async () => {
      throw { code: "workspace-not-allowed", message: "that project is not available to you", class: "refused", retryable: false };
    });
    mount(fakeApi({ intentCodeSources: async () => [{ sourceId: "proj" }], intentCodeSubmit: submit as unknown as NativeApi["intentCodeSubmit"] }));
    const radio = await screen.findByRole("radio", { name: "Code in copy" });
    await waitFor(() => expect(radio).toBeEnabled());
    await user.click(radio);
    await user.type(screen.getByLabelText("Task prompt"), "fix it");
    await user.click(screen.getByRole("checkbox", { name: "Acknowledge disclosure" }));
    await user.click(screen.getByRole("button", { name: "Start coding" }));
    expect(await screen.findByText(/Send failed: workspace-not-allowed/)).toBeInTheDocument();
    expect(screen.getByText(/that project is not available to you/)).toBeInTheDocument();
    expect((screen.getByLabelText("Task prompt") as HTMLTextAreaElement).value).toBe("fix it");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("switching modes does not leak an acknowledgement or a project into the text-only request", async () => {
    const user = userEvent.setup();
    const sendText = vi.fn(async (_p: string, _m: unknown, key: string) => ({ replay: false, run: fakeRun({ requestId: key, conversationId: null, state: "preparing" }) }));
    const code = vi.fn();
    mount(fakeApi({ intentCodeSources: async () => [{ sourceId: "proj" }], intentSubmit: sendText as unknown as NativeApi["intentSubmit"], intentCodeSubmit: code as unknown as NativeApi["intentCodeSubmit"] }));
    const codeRadio = await screen.findByRole("radio", { name: "Code in copy" });
    await waitFor(() => expect(codeRadio).toBeEnabled());
    await user.click(codeRadio);
    await user.click(screen.getByRole("checkbox", { name: "Acknowledge disclosure" }));
    await user.click(screen.getByRole("radio", { name: "Ask" }));
    expect(screen.queryByRole("region", { name: "Coding task terms" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Task prompt"), "hello");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    expect(code).not.toHaveBeenCalled();
  });
});

describe("Approval banner (A6.1.2)", () => {
  it("is compact by default, names the operation, target, expiry and the separate approver, and offers no authority", async () => {
    await openRun(codeRun({ state: "approval-pending", terminal: false, pendingApproval: pa(), codingOutcome: { ...passed, verification: "not-yet-verified", change: "pending-approval", editsApplied: 0, testsExecuted: 0, lastExitCode: null } }));
    const banner = await screen.findByRole("region", { name: "Pending approval" });
    expect(banner).toHaveAttribute("data-expired", "false");
    expect(within(banner).getByText("Approval needed — nothing has run")).toBeInTheDocument();
    expect(within(banner).getByText("Edit file")).toBeInTheDocument();
    expect(within(banner).getByText("src/lib.rs")).toBeInTheDocument();
    expect(within(banner).getByText(/expires in \d+:\d\d/)).toBeInTheDocument();
    expect(within(banner).getByText(/Approve or deny in the separate approver/)).toBeInTheDocument();
    expect(within(banner).getByText(/Nexus Desktop cannot approve or deny/)).toBeInTheDocument();
    // collapsed: the proposal is behind Details
    expect(within(banner).queryByLabelText(/Proposed operation/)).not.toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "Details" })).toHaveAttribute("aria-expanded", "false");
    for (const bad of [/approve$/i, /^approve/i, /deny$/i, /^deny/i, /allow/i, /^run/i, /apply/i, /merge/i, /commit/i, /push/i]) {
      expect(within(banner).queryByRole("button", { name: bad })).not.toBeInTheDocument();
    }
    expect(within(banner).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("expands to the model's proposal, labelled as NOT the authoritative request, with restrictions and the approver command", async () => {
    const { user } = await openRun(codeRun({ state: "approval-pending", terminal: false, pendingApproval: pa() }));
    const banner = await screen.findByRole("region", { name: "Pending approval" });
    await user.click(within(banner).getByRole("button", { name: "Details" }));
    const note = within(banner).getByRole("note");
    expect(note).toHaveTextContent("Model proposal — not the authoritative request.");
    expect(note).toHaveTextContent(/shown only to the approver/);
    expect(note).toHaveTextContent(/Inspect that actual request in nexus-approver review before approving/);
    const pre = within(banner).getByLabelText("Proposed operation (model proposal, unverified)");
    expect(pre).toHaveTextContent("- a - b");
    expect(pre).toHaveTextContent("+ a + b");
    expect(note.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(banner).getByLabelText("Restrictions")).toHaveTextContent("throw-away working copy");
    expect(within(banner).getByLabelText("Approver command")).toHaveTextContent("review ap9");
    expect(within(banner).getByText(/request digest/)).toBeInTheDocument();
    expect(within(banner).queryByRole("button", { name: /approve|deny/i })).not.toBeInTheDocument();
  });

  it("shows a pending command with its sandbox restrictions", async () => {
    const { user } = await openRun(
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
    const banner = await screen.findByRole("region", { name: "Pending approval" });
    expect(within(banner).getByText("Run command")).toBeInTheDocument();
    await user.click(within(banner).getByRole("button", { name: "Details" }));
    expect(within(banner).getByLabelText(/Proposed operation/)).toHaveTextContent("cargo test --offline");
    expect(within(banner).getByLabelText("Restrictions")).toHaveTextContent("network access is disabled");
    expect(within(banner).getByLabelText("Restrictions")).toHaveTextContent("read-only snapshot");
    expect(within(banner).getByText(/argument vector and sandbox policy/)).toBeInTheDocument();
  });

  it("marks an approval whose time has passed as expired and says nothing ran", async () => {
    await openRun(codeRun({ state: "approval-pending", terminal: false, pendingApproval: pa({ expiresAtMs: Date.now() - 5_000 }) }));
    const banner = await screen.findByRole("region", { name: "Pending approval" });
    expect(banner).toHaveAttribute("data-expired", "true");
    expect(within(banner).getByText("Approval expired — nothing ran")).toBeInTheDocument();
    expect(within(banner).getByText("expired")).toBeInTheDocument();
  });

  it("disappears when the run ends", async () => {
    const calls = { ended: false };
    const live = codeRun({ state: "approval-pending", terminal: false, pendingApproval: pa(), changedFiles: [] });
    const api = fakeApi({
      listModelConversations: async () => [{ ...summary, state: calls.ended ? "completed" : "approval-pending", terminal: calls.ended }],
      modelRunStatus: async () => status({ state: calls.ended ? "completed" : "approval-pending", terminal: calls.ended }),
      conversationRead: async () => view([]),
      intentList: async () => [calls.ended ? passedRun() : live],
    });
    const user = userEvent.setup();
    mount(api);
    await user.click(await screen.findByRole("button", { name: /Fix the failing test/ }));
    expect(await screen.findByRole("region", { name: "Pending approval" })).toBeInTheDocument();
    calls.ended = true;
    await waitFor(() => expect(screen.queryByRole("region", { name: "Pending approval" })).not.toBeInTheDocument(), { timeout: 6000 });
    expect(await screen.findByRole("region", { name: "Verified outcome" })).toBeInTheDocument();
  }, 20000);
});

describe("Running task (A6.1.2)", () => {
  it("shows what the run is doing in plain language from receipts, not a raw event stream", async () => {
    await openRun(
      codeRun({
        state: "tool-running",
        terminal: false,
        turn: 3,
        maxTurns: 12,
        pendingApproval: null,
        codingOutcome: { ...passed, verification: "not-yet-verified", change: "none-proposed", editsApplied: 0, testsExecuted: 0, lastExitCode: null },
        toolActivity: [act({ argsSummary: "path=." , tool: "fs_list" }), act({ index: 2, tool: "fs_read", argsSummary: "path=src/lib.rs start=1 max=400" })],
      }),
    );
    const prog = await screen.findByRole("region", { name: "Run progress" });
    expect(within(prog).getByText(/Running a tool call/)).toBeInTheDocument();
    expect(within(prog).getByText(/turn 3 of 12/)).toBeInTheDocument();
    expect(within(prog).getByText("Listed .")).toBeInTheDocument();
    expect(within(prog).getByText("Read src/lib.rs")).toBeInTheDocument();
    expect(within(prog).getByText(/2 read\(s\) · 0 edit\(s\) proposed · 0 command\(s\) proposed/)).toBeInTheDocument();
    // no raw hashes/digests/tool json in the default view
    expect(within(prog).queryByText(/sha256|digest|journal/i)).toBeNull();
    // nothing is claimed about the outcome while running
    expect(screen.queryByRole("region", { name: "Verified outcome" })).not.toBeInTheDocument();
  });

  it("offers cancel for a running coding task", async () => {
    const cancel = vi.fn(async () => undefined);
    const { user } = await openRun(codeRun({ state: "tool-running", terminal: false, pendingApproval: null }), {
      modelRunStatus: async () => status({ state: "tool-running", terminal: false }),
      cancelModelRun: cancel as unknown as NativeApi["cancelModelRun"],
    });
    await user.click((await screen.findAllByRole("button", { name: "Cancel run" }))[0]!);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(CONV));
  });
});

describe("Verified outcome (A6.1.1 + A6.1.2)", () => {
  it("a completed run whose approvals expired shows the model's claim as a claim and the runtime's verdict as blocked", async () => {
    await openRun(expiredRun(), { modelRunStatus: async () => status({ text: "Fixed add (a - b -> a + b); cargo test passes." }) });
    expect((await screen.findAllByText("Model completed")).length).toBeGreaterThan(0);
    const card = await screen.findByRole("region", { name: "Verified outcome" });
    expect(within(card).getByText(/Blocked · approval expired · not executed/)).toBeInTheDocument();
    expect(within(card).getByText(/0 applied, 1 not applied/)).toBeInTheDocument();
    expect(within(card).queryByText(/Tests passed/)).not.toBeInTheDocument();
    // the claim is shown, labelled, and never as a status
    const claim = screen.getByRole("region", { name: "Model's summary" });
    expect(within(claim).getByText(/a claim, not verified/)).toBeInTheDocument();
    expect(within(claim).getByText(/cargo test passes/)).toBeInTheDocument();
    expect(screen.queryByText(/Tests passed/)).not.toBeInTheDocument();
  });

  it("lifecycle and verified outcome are independent", async () => {
    for (const [state, terminal] of [["completed", true], ["failed", true], ["cancelled", true]] as const) {
      cleanup();
      await openRun(expiredRun({ state, terminal }));
      expect((await screen.findAllByText(/approval expired · not executed/)).length).toBeGreaterThan(0);
      expect(screen.queryByText(/Tests passed/)).not.toBeInTheDocument();
    }
  });

  it("a genuinely approved and passing run shows applied and passed, and does not claim the task is proven correct", async () => {
    await openRun(passedRun());
    const card = await screen.findByRole("region", { name: "Verified outcome" });
    expect(within(card).getByText("Tests passed · exit 0")).toBeInTheDocument();
    expect(within(card).getByText(/applied · 1 applied, 0 not applied/)).toBeInTheDocument();
    expect(within(card).getByText(/cargo test --offline/)).toBeInTheDocument();
    expect(within(card).getByText(/does not prove the whole task is correct/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Changed files" })).toHaveTextContent("M src/lib.rs +1 -1");
  });

  it("uncertain operations are shown as uncertain, never as success", async () => {
    await openRun(
      codeRun({
        state: "uncertain",
        terminal: true,
        errorCode: "tool-outcome-uncertain",
        lastTestVerification: null,
        toolActivity: [act({}), act({ index: 2, tool: "fs_edit", status: "uncertain", errorCode: "tool-outcome-uncertain", approvalOutcome: "approved", executionId: null })],
        codingOutcome: { ...blocked, verification: "uncertain", change: "uncertain", editsNotApplied: 0, testsNotExecuted: 0, blockedByApproval: 0, uncertainOperations: 1 },
      }),
    );
    expect((await screen.findAllByText("Coding outcome uncertain")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Tests passed/)).not.toBeInTheDocument();
  });

  it("a coding run from a broker that reports no outcome is never shown as passed", async () => {
    await openRun(codeRun({ codingOutcome: null }));
    expect((await screen.findAllByText("Outcome not reported")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Tests passed/)).not.toBeInTheDocument();
  });
});

describe("Evidence panel (A6.1.2)", () => {
  it("is closed by default, opens the diff on request, and closes with the button and with Escape", async () => {
    const diffText = "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,3 +1,3 @@\n pub fn add(a: i32, b: i32) -> i32 {\n-    a - b\n+    a + b\n }\n";
    const run = passedRun();
    const intentDiff = vi.fn(async (id: string) => ({ run: { ...run, runId: id }, baseCommit: "c".repeat(40), files: run.changedFiles ?? [], filesTruncated: false, diff: diffText, diffDigest: "d".repeat(64), diffTruncated: false }));
    const { user } = await openRun(run, { intentDiff: intentDiff as NativeApi["intentDiff"] });
    expect(screen.queryByRole("complementary", { name: "Evidence panel" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "View diff" }));
    const panel = await screen.findByRole("dialog", { name: "Evidence panel" });
    const viewer = await within(panel).findByLabelText("Unified diff");
    const lines = Array.from(viewer.querySelectorAll("[data-diff]")).map((n) => [n.getAttribute("data-diff"), n.textContent]);
    expect(lines).toContainEqual(["del", "-    a - b"]);
    expect(lines).toContainEqual(["add", "+    a + b"]);
    expect(within(panel).getByText(/Your repository is unchanged/)).toBeInTheDocument();
    expect(intentDiff).toHaveBeenCalledWith(run.runId);
    await user.click(within(panel).getByRole("button", { name: "Close panel" }));
    expect(screen.queryByRole("dialog", { name: "Evidence panel" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View diff" }));
    await screen.findByRole("dialog", { name: "Evidence panel" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Evidence panel" })).not.toBeInTheDocument());
    // no apply / commit / push / merge / approve anywhere
    for (const bad of [/apply/i, /commit/i, /push/i, /merge/i, /^approve/i, /^deny/i]) expect(screen.queryByRole("button", { name: bad })).not.toBeInTheDocument();
  });

  it("Copy patch copies the diff only on an explicit click and nothing else happens", async () => {
    const diffText = "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-a - b\n+a + b\n";
    const run = passedRun();
    const { user } = await openRun(run, { intentDiff: (async (id: string) => ({ run: { ...run, runId: id }, baseCommit: "c".repeat(40), files: [], filesTruncated: false, diff: diffText, diffDigest: "d".repeat(64), diffTruncated: false })) as NativeApi["intentDiff"] });
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(await screen.findByRole("button", { name: "View diff" }));
    const panel = await screen.findByRole("dialog", { name: "Evidence panel" });
    const btn = await within(panel).findByRole("button", { name: "Copy patch" });
    expect(writeText).not.toHaveBeenCalled();
    await user.click(btn);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(diffText);
    expect(await within(panel).findByText(/Applying it is a manual step by you/)).toBeInTheDocument();
    // read-only working-copy facts, no path, no remove control
    expect(await within(panel).findByLabelText("Working copy")).toHaveTextContent(/retained · 2\.0 MiB · 3 min old/);
    expect(within(panel).queryByRole("button", { name: /remove|delete|discard/i })).not.toBeInTheDocument();
  });

  it("a truncated diff cannot be copied as if it were whole, and a removed copy is reported honestly", async () => {
    const run = passedRun();
    const { user } = await openRun(run, {
      intentDiff: (async (id: string) => ({ run: { ...run, runId: id }, baseCommit: "c".repeat(40), files: [], filesTruncated: true, diff: "+x\n", diffDigest: "d".repeat(64), diffTruncated: true })) as NativeApi["intentDiff"],
      intentCopy: (async () => ({ retained: false, active: false, projectId: "proj", baseCommit: "c".repeat(40) })) as NativeApi["intentCopy"],
    });
    await user.click(await screen.findByRole("button", { name: "View diff" }));
    const panel = await screen.findByRole("dialog", { name: "Evidence panel" });
    expect(await within(panel).findByRole("button", { name: "Copy patch" })).toBeDisabled();
    expect(await within(panel).findByLabelText("Working copy")).toHaveTextContent(/removed by the operator/);
  });

  it("the Source tab shows the approval lifetime and the lowered run limits the broker reports", async () => {
    const { user } = await openRun(passedRun(), { intentCodeLimits: (async () => ({ maxTurns: 6, maxToolCalls: 30, maxToolResultBytes: 131072, maxEdits: 2, maxTests: 1, maxOutputTokens: 1024, maxRuntimeSecs: 1800, approvalLifetimeSecs: 120 })) as NativeApi["intentCodeLimits"] });
    await user.click(await screen.findByRole("button", { name: "Source" }));
    const panel = await screen.findByRole("dialog", { name: "Evidence panel" });
    expect(within(panel).getByText("6 turns · 30 tool calls · 2 edits · 1 commands")).toBeInTheDocument();
    expect(within(panel).getByText("2 min")).toBeInTheDocument();
  });

  it("a failed diff load is reported, not hidden", async () => {
    const { user } = await openRun(passedRun(), { intentDiff: async () => { throw { code: "not-found", message: "no such run", class: "refused", retryable: false }; } });
    await user.click(await screen.findByRole("button", { name: "View diff" }));
    expect(await screen.findByText(/no such run/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Unified diff")).not.toBeInTheDocument();
  });

  it("Test output shows the recorded command output while the verdict comes from the receipt", async () => {
    const out = ev({
      seq: 2,
      messageId: "toolresult-3",
      taskInstanceId: CONV,
      kind: "tool-result",
      toolName: "proc_run",
      toolCallId: "call_3",
      text: JSON.stringify({ exitCode: 0, reason: "exited", verification: "pass", wallMs: 1234, stdoutTail: "test adds_positive_numbers ... ok\ntest result: ok. 1 passed", stderrTail: "   Compiling calc v0.1.0" }),
    });
    const { user } = await openRun(passedRun(), { conversationRead: async () => view([out]) });
    await user.click(await screen.findByRole("button", { name: "Test output" }));
    const panel = await screen.findByRole("dialog", { name: "Evidence panel" });
    const cmd = await within(panel).findByRole("region", { name: "Command 1" });
    expect(within(cmd).getByText(/passed · exit 0/)).toBeInTheDocument();
    expect(within(cmd).getByLabelText("stdout tail")).toHaveTextContent("test result: ok. 1 passed");
    expect(within(cmd).getByLabelText("stderr tail")).toHaveTextContent("Compiling calc");
    expect(within(cmd).getByText(/verdict above comes from the execution receipt, not from this text/)).toBeInTheDocument();
  });

  it("Test output for a command that never ran says so and shows no output or result", async () => {
    const { user } = await openRun(expiredRun());
    await user.click(await screen.findByRole("button", { name: "Test output" }));
    const panel = await screen.findByRole("dialog", { name: "Evidence panel" });
    const cmd = await within(panel).findByRole("region", { name: "Command 1" });
    expect(within(cmd).getByText(/not executed · approval expired/)).toBeInTheDocument();
    expect(within(cmd).getByText(/did not run, so there is no output and no test result/)).toBeInTheDocument();
    expect(within(cmd).queryByLabelText("stdout tail")).not.toBeInTheDocument();
  });

  it("Execution evidence lists receipts: approvals, hashes and exit codes", async () => {
    const { user } = await openRun(passedRun());
    await user.click(await screen.findByRole("button", { name: "Execution evidence" }));
    const panel = await screen.findByRole("dialog", { name: "Evidence panel" });
    const table = await within(panel).findByRole("table", { name: "Operation receipts" });
    expect(within(table).getByText(/1111111111 → 2222222222/)).toBeInTheDocument();
    expect(within(table).getByText(/exit 0 · pass/)).toBeInTheDocument();
    expect(within(table).getAllByText(/approved/).length).toBeGreaterThan(0);
    expect(within(panel).getByText(/1 edit\(s\) applied · 0 not applied · 1 command\(s\) executed/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("tab", { name: "Source" }));
    expect(await within(panel).findByText("Working copy commit")).toBeInTheDocument();
  });
});

describe("Classification, history and projects (A6.1.2)", () => {
  it("classifies runs by intent: a coding fixture run is a Code run (and a fixture), not a text-only model run", async () => {
    const inspect: IntentRun = fakeRun({ runId: "run_" + "d".repeat(32), intentType: "repo-inspect", conversationId: "model_" + "1".repeat(32), state: "completed", terminal: true });
    const ask: IntentRun = fakeRun({ runId: "run_" + "e".repeat(32), intentType: "model-only", conversationId: "model_" + "2".repeat(32), state: "completed", terminal: true });
    const mk = (id: string, prompt: string, over: Partial<ModelConversationSummary> = {}): ModelConversationSummary => ({ ...summary, conversationId: id, firstPrompt: prompt, ...over });
    const api = fakeApi({
      listModelConversations: async () => [mk(CONV, "Fix the failing add test (GUI fixture run)", { endpointKind: "loopback" }), mk("model_" + "1".repeat(32), "Look around"), mk("model_" + "2".repeat(32), "Say hi")],
      intentList: async () => [expiredRun(), inspect, ask],
      modelRunStatus: async () => status({ endpointKind: "loopback" }),
      conversationRead: async () => view([]),
    });
    const user = userEvent.setup();
    mount(api, "#/history");
    const codeBtn = await screen.findByRole("button", { name: /Fix the failing add test \(GUI fixture run\)/ });
    expect(within(codeBtn).getByText("CODE")).toBeInTheDocument();
    expect(within(codeBtn).getByText("FIXTURE")).toBeInTheDocument();
    expect(within(codeBtn).getByText("Model completed")).toBeInTheDocument();
    expect(within(codeBtn).getByText(/Blocked · approval expired · not executed/)).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Say hi/ })).getByText("ASK")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Look around/ })).getByText("INSPECT")).toBeInTheDocument();
    // filters
    await user.click(screen.getByRole("button", { name: "Code in copy" }));
    expect(screen.queryByRole("button", { name: /Say hi/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Fix the failing add test/ })).toBeInTheDocument();
    // opening it opens the coding task view, not a model-only view
    await user.click(screen.getByRole("button", { name: /Fix the failing add test/ }));
    expect(await screen.findByRole("region", { name: "Verified outcome" })).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/workspace/run/${CONV}`);
  });

  it("the idle screen shows at most five recent runs (three on short windows) and links to History", async () => {
    const rows: ModelConversationSummary[] = Array.from({ length: 8 }, (_, i) => ({ ...summary, conversationId: "model_" + String(i).repeat(32), firstPrompt: `Run number ${i}` }));
    const api = fakeApi({ listModelConversations: async () => rows, intentList: async () => [], modelRunStatus: async () => status(), conversationRead: async () => view([]) });
    const user = userEvent.setup();
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    mount(api);
    const recent = await screen.findByRole("region", { name: "Recent runs" });
    await waitFor(() => expect(within(recent).getAllByRole("button", { name: /Run number/ })).toHaveLength(5));
    await user.click(within(recent).getByRole("button", { name: /View all in History/ }));
    expect(await screen.findByRole("heading", { name: "History" })).toBeInTheDocument();
    expect(await screen.findAllByRole("button", { name: /Run number/ })).toHaveLength(8);
    cleanup();
    Object.defineProperty(window, "innerHeight", { value: 720, configurable: true });
    mount(api);
    const recent2 = await screen.findByRole("region", { name: "Recent runs" });
    await waitFor(() => expect(within(recent2).getAllByRole("button", { name: /Run number/ })).toHaveLength(3));
    Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  });

  it("historical runs without a broker record still render under Ask, with no outcome claimed", async () => {
    const api = fakeApi({ listModelConversations: async () => [{ ...summary, firstPrompt: "Reply with exactly: NEXUS_NATIVE_OK" }], intentList: async () => [], modelRunStatus: async () => status(), conversationRead: async () => view([]) });
    mount(api, "#/history");
    const row = await screen.findByRole("button", { name: /NEXUS_NATIVE_OK/ });
    expect(within(row).getByText("ASK")).toBeInTheDocument();
    expect(within(row).queryByText(/Tests passed|Blocked|verified/i)).not.toBeInTheDocument();
  });

  it("Projects is read-only: identities, pins, write scope and restrictions, with no way to add or edit a project", async () => {
    mount(fakeApi({ intentCodeSources: async () => [{ sourceId: "proj", pinnedCommit: "ab".repeat(20), writeAllow: ["src/", "Cargo.toml"] }], intentWorkspaces: async () => [{ workspaceId: "proj" }, { workspaceId: "docs" }] }), "#/projects");
    const table = await screen.findByRole("table", { name: "Authorized projects" });
    expect(within(table).getByText("abababababab")).toBeInTheDocument();
    expect(within(table).getByText("src/, Cargo.toml")).toBeInTheDocument();
    expect(within(table).getAllByText("Inspect").length).toBe(2);
    expect(within(table).getByText("Code in copy")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Execution restrictions" })).toHaveTextContent(/Every edit and every command needs its own independent approval/);
    expect(screen.getByText(/cannot add a project, type a path or change a restriction/)).toBeInTheDocument();
    for (const bad of [/add/i, /register/i, /browse/i, /new project/i, /edit/i, /remove/i]) expect(screen.queryByRole("button", { name: bad })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("deep links restore the place: a run hash opens the task; the route follows navigation", async () => {
    const user = userEvent.setup();
    const run = passedRun();
    const api = fakeApi({ listModelConversations: async () => [summary], modelRunStatus: async () => status(), conversationRead: async () => view([]), intentList: async () => [run] });
    mount(api, `#/workspace/run/${CONV}`);
    expect(await screen.findByRole("region", { name: "Verified outcome" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Projects/ }));
    expect(window.location.hash).toBe("#/projects");
    await user.click(screen.getByRole("button", { name: /Workspace/ }));
    expect(window.location.hash).toBe("#/workspace");
    expect(await screen.findByText("What should Nexus work on?")).toBeInTheDocument();
  });

  it("restores a persisted result after the app restarts (fresh mount reads run history)", async () => {
    const run = passedRun();
    const api = fakeApi({ listModelConversations: async () => [summary], modelRunStatus: async () => status(), conversationRead: async () => view([]), intentList: async () => [run] });
    for (let launch = 0; launch < 2; launch++) {
      const user = userEvent.setup();
      mount(api, "#/history");
      await user.click(await screen.findByRole("button", { name: /Fix the failing test/ }));
      const card = await screen.findByRole("region", { name: "Verified outcome" });
      expect(within(card).getByText("Tests passed · exit 0")).toBeInTheDocument();
      cleanup();
    }
  });

  it("run-history polling stops after the run is terminal and continues while a run is live", async () => {
    const calls = { n: 0 };
    const mkApi = (terminal: boolean) =>
      fakeApi({
        listModelConversations: async () => [{ ...summary, state: terminal ? "completed" : "streaming", terminal }],
        modelRunStatus: async () => status({ state: terminal ? "completed" : "streaming", terminal }),
        conversationRead: async () => view([]),
        intentList: async () => {
          calls.n += 1;
          return [terminal ? passedRun() : codeRun({ state: "tool-running", terminal: false, pendingApproval: null })];
        },
      });
    const user = userEvent.setup();
    mount(mkApi(true));
    await user.click(await screen.findByRole("button", { name: /Fix the failing test/ }));
    await waitFor(() => expect(calls.n).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 400));
    const settled = calls.n;
    await new Promise((r) => setTimeout(r, 3400));
    expect(calls.n).toBe(settled);
    cleanup();
    calls.n = 0;
    const user2 = userEvent.setup();
    mount(mkApi(false));
    await user2.click(await screen.findByRole("button", { name: /Fix the failing test/ }));
    const a = calls.n;
    await waitFor(() => expect(calls.n).toBeGreaterThan(a + 1), { timeout: 5000 });
  }, 20000);

  it("old transcripts that call every proposal read-only are shown accurately for a coding run (original kept) and untouched for an inspect run", async () => {
    const old = ev({ seq: 1, messageId: "st-1", taskInstanceId: CONV, kind: "status", speaker: "runtime", text: "Model proposed 1 read-only tool call(s); validating." });
    const { user } = await openRun(expiredRun(), { conversationRead: async () => view([old]) });
    await user.click(await screen.findByRole("button", { name: "Details" }));
    await user.click(await screen.findByRole("tab", { name: "Transcript" }));
    const line = await screen.findByText(/Model proposed 1 tool call\(s\); every edit and command still needs an independent approval/);
    expect(line).toHaveAttribute("title", "Recorded as: Model proposed 1 read-only tool call(s); validating.");
    cleanup();
    const inspectRun: IntentRun = fakeRun({ intentType: "repo-inspect", conversationId: CONV, state: "completed", terminal: true });
    const u2 = userEvent.setup();
    mount(fakeApi({ listModelConversations: async () => [summary], modelRunStatus: async () => status(), intentList: async () => [inspectRun], conversationRead: async () => view([old]) }));
    await u2.click(await screen.findByRole("button", { name: /Fix the failing test/ }));
    await u2.click(await screen.findByRole("button", { name: "Details" }));
    await u2.click(await screen.findByRole("tab", { name: "Transcript" }));
    expect(await screen.findByText("Model proposed 1 read-only tool call(s); validating.")).toBeInTheDocument();
  });

  it("tool calls are labelled by what they do: edits and commands are never described as read-only", async () => {
    const { user } = await openRun(expiredRun());
    await user.click(await screen.findByRole("button", { name: "Details" }));
    await user.click(await screen.findByRole("tab", { name: "Tool calls" }));
    const table = await screen.findByRole("table", { name: "Proposed edits and tool activity" });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]!).getByText("read")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("write")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("command")).toBeInTheDocument();
    expect(within(table).getAllByText(/refused · approval-expired/)).toHaveLength(2);
    expect(within(table).queryByText(/read-only/i)).not.toBeInTheDocument();
  });
});

describe("Runtime pill and no-privilege guarantees (A6.1.2)", () => {
  it("the renderer source holds no approver, issuer or provider credential and never talks to the daemon", async () => {
    const files = import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const prod = Object.entries(files).filter(([k]) => !k.includes("/test/"));
    expect(prod.length).toBeGreaterThan(10);
    for (const [name, text] of prod) {
      for (const bad of ["approval-decide", "approval-get", "approver.cap", "issuer.cap", "OPENCODE_API_KEY", "tool-execute", "read_capability", "signed_frame", "cap-handoff"]) {
        expect(text.includes(bad), `${name} mentions ${bad}`).toBe(false);
      }
    }
    const api = prod.find(([k]) => k.endsWith("lib/api.ts"))![1];
    expect(api).not.toMatch(/invoke<[^>]*>\("(approval_decide|approval_get|approval_request|approval_revoke|decide|issuer|tool_execute)/);
    expect(api).toContain("list_approvals");
  });
});
