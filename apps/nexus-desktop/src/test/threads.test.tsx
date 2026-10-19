import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi, fakeRun } from "./fakeApi";
import type { NativeApi } from "../lib/api";
import type { RuntimeState, ThreadDetail, ThreadRunView, ThreadSummary, ThreadMessage } from "../lib/contracts";

const T1 = "thr_" + "1".repeat(32);
const T2 = "thr_" + "2".repeat(32);
const R = (c: string) => "run_" + c.repeat(32);

const rt = (): RuntimeState => ({
  mode: "interactive",
  phase: "ready",
  message: null,
  home: "/home/u/.local/share/nexus",
  providerConnected: true,
  consent: { given: true, providerId: "opencode-go-native", remoteModelId: "m", text: "Allow." },
  canOpenProjects: true,
});

const summary = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  threadId: T1,
  projectId: "east-india",
  title: "Review the repository",
  createdAtMs: 1_790_000_000_000,
  updatedAtMs: 1_790_000_100_000,
  archived: false,
  legacy: false,
  runCount: 2,
  messageCount: 4,
  lastPreview: "F1 was fixed",
  lastState: "completed",
  active: false,
  activeRunId: null,
  findingCount: 2,
  ...over,
});

const msg = (seq: number, role: ThreadMessage["role"], kind: string, runId: string | null, text: string): ThreadMessage => ({ seq, role, kind, runId, atMs: 1_790_000_000_000 + seq * 1000, text, truncated: false });

function runView(n: number, over: Partial<ThreadRunView> = {}, run: Partial<ReturnType<typeof fakeRun>> = {}): ThreadRunView {
  return {
    runId: R(String(n)),
    n,
    userSeq: n * 2 - 1,
    assistantSeq: n * 2,
    mode: "edit",
    readOnly: false,
    modeReason: "changes are allowed in an isolated copy",
    continuationOf: null,
    state: "completed",
    ended: true,
    startedAtMs: 1_790_000_000_000,
    endedAtMs: 1_790_000_050_000,
    digest: null,
    run: fakeRun({ runId: R(String(n)), intentType: "repo-code", state: "completed", terminal: true, conversationId: null, workspaceId: "east-india", threadId: T1, ...run }),
    ...over,
  };
}

function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    thread: summary(),
    messages: [
      msg(1, "user", "request", R("1"), "Review this repository. Read-only."),
      msg(2, "assistant", "answer", R("1"), "## Findings\n\n### F1 — add() subtracts\nsrc/lib.rs:2"),
      msg(3, "user", "request", R("2"), "Fix finding F1 and add regression tests."),
      msg(4, "assistant", "answer", R("2"), "Fixed F1. cargo test passes."),
    ],
    runs: [
      runView(1, { mode: "review", readOnly: true, modeReason: "you asked not to change any files" }, { readOnly: true }),
      runView(2, { context: { bytes: 14_336, sha256: "ab".repeat(32), priorRuns: 1, findings: 2 } }, {
        workspaceRelation: "continued",
        workspaceNote: "Started from the working copy of run 1: 0 file(s) carried over.",
        changedFiles: [{ path: "src/lib.rs", status: "M", additions: 1, deletions: 1 }, { path: "tests/regression.rs", status: "A", additions: 4, deletions: 0 }] as never,
        toolActivity: [
          { index: 1, turn: 1, callId: "c1", tool: "fs_edit", argsSummary: "edit src/lib.rs", status: "executed", errorCode: null, resultBytes: 1, resultDigest: null, truncated: false, executionId: null, journalSeq: 1, argsDigest: null, postSha256: "b".repeat(64) },
          { index: 2, turn: 2, callId: "c2", tool: "proc_run", argsSummary: "cargo test --offline", status: "executed", errorCode: null, resultBytes: 1, resultDigest: null, truncated: false, executionId: null, journalSeq: 2, argsDigest: null, exitCode: 0, verification: "pass" },
        ] as never,
        codingOutcome: { verification: "verified-passed", change: "applied", editsApplied: 1, editsNotApplied: 0, testsExecuted: 1, testsNotExecuted: 0, blockedByApproval: 0, lastExitCode: 0, staleAfterEdit: false, uncertainOperations: 0 },
      }),
    ],
    findings: [
      { id: "F1", title: "add() subtracts", detail: "src/lib.rs:2", runId: R("1"), addressedIn: 2, addressedVerification: "verified-passed" },
      { id: "F2", title: "No overflow handling", detail: "", runId: R("1"), addressedIn: null, addressedVerification: null },
    ],
    head: { runId: R("2"), n: 2, changedFiles: 2 },
    ...over,
  };
}

function mount(api: NativeApi, hash = "#") {
  window.history.replaceState(null, "", hash);
  return render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
}

const base = (over: Partial<NativeApi> = {}) =>
  fakeApi({
    runtimeState: async () => rt(),
    intentCodeSources: async () => [{ sourceId: "east-india", label: "East India Companies", managed: true, kinds: ["dotnet"] }],
    threadList: async () => ({ threads: [summary()] }),
    threadGet: async () => detail(),
    ...over,
  });

describe("Persistent conversations (A7.1)", () => {
  it("shows requests, runs and answers in chronological order with per-run status separate from the conversation's state", async () => {
    mount(base(), `#/workspace/c/${T1}`);
    const log = await screen.findByRole("log", { name: "Conversation" });
    const text = log.textContent ?? "";
    // chronological: request 1 < run 1 < answer 1 < request 2 < run 2 < answer 2
    const order = ["Review this repository. Read-only.", "Run 1", "F1 — add() subtracts", "Fix finding F1 and add regression tests.", "Run 2", "Fixed F1. cargo test passes."].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const run1 = within(log).getByRole("region", { name: "Run 1" });
    expect(within(run1).getByText("Read-only")).toBeInTheDocument();
    expect(within(run1).getByText(/Read-only · no file changed/)).toBeInTheDocument();
    const run2 = within(log).getByRole("region", { name: "Run 2" });
    expect(within(run2).getByText("Can change files")).toBeInTheDocument();
    expect(within(run2).getByText(/Tests passed · exit 0/)).toBeInTheDocument(); // the run's verified evidence
    expect(within(run2).getByText(/Continues the conversation's workspace/)).toBeInTheDocument();
    expect(within(run2).getByText(/Memory: 1 earlier run, 2 findings · 14 KB/)).toBeInTheDocument(); // what the model was given
    // the conversation's own state is separate from run status
    expect(screen.getByText("Ready for your next message")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Findings" })).toHaveTextContent("2 findings remembered · 1 addressed");
  });

  it("keeps the composer available after a completed run and sends into THE SAME conversation, in the same project", async () => {
    const send = vi.fn(async (i) => ({ threadId: T1, replay: false, run: fakeRun({ runId: R("3"), requestId: i.idempotencyKey, intentType: "repo-code", threadId: T1 }) }));
    const user = userEvent.setup();
    mount(base({ threadSend: send as NativeApi["threadSend"] }), `#/workspace/c/${T1}`);
    const box = await screen.findByLabelText("Message");
    expect(box).toBeEnabled();
    await user.type(box, "Now explain exactly why F2 is a problem. Don't change any files.");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const sent = send.mock.calls[0]![0];
    expect(sent).toMatchObject({ threadId: T1, projectId: "east-india", content: "Now explain exactly why F2 is a problem. Don't change any files.", mode: "auto", workspace: "continue" });
    // nothing but text, identity and choices goes along: no path, tool, limit or approval
    expect(Object.keys(sent).sort()).toEqual(["content", "idempotencyKey", "mode", "projectId", "threadId", "workspace"]);
    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("a refused send keeps the typed text and says why", async () => {
    const user = userEvent.setup();
    mount(base({ threadSend: async () => { throw { code: "project-mismatch", message: "this conversation belongs to another project", class: "refused", retryable: false }; } }), `#/workspace/c/${T1}`);
    const box = await screen.findByLabelText("Message");
    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/belongs to another project/)).toBeInTheDocument();
    expect(box).toHaveValue("hello");
  });

  it("while a run is in progress the composer offers Stop instead of Send, and Stop cancels exactly that run", async () => {
    const live = detail({
      thread: summary({ active: true, activeRunId: R("3"), runCount: 3, lastState: "executing" }),
      messages: [...detail().messages, msg(5, "user", "request", R("3"), "Now inspect F2")],
      runs: [...detail().runs, runView(3, { ended: false, state: "executing", assistantSeq: null, userSeq: 5 }, { state: "executing", terminal: false, turn: 2, maxTurns: 60 })],
    });
    const cancel = vi.fn(async (id: string) => ({ run: fakeRun({ runId: id, cancelRequested: true }), outcome: "requested" }));
    const user = userEvent.setup();
    mount(base({ threadGet: async () => live, threadList: async () => ({ threads: [live.thread] }), intentCancel: cancel as NativeApi["intentCancel"] }), `#/workspace/c/${T1}`);
    expect(await screen.findByText("Working")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(cancel).toHaveBeenCalledWith(R("3"));
    expect(screen.getByRole("region", { name: "Run progress" })).toHaveTextContent(/turn 2 of 60/);
  });

  it("after a failed run the composer is still there; a workspace conflict offers 'current files' as an explicit choice", async () => {
    const failed = detail({
      thread: summary({ lastState: "rejected", runCount: 3 }),
      messages: [...detail().messages, msg(5, "user", "request", R("3"), "And now?"), msg(6, "system", "note", R("3"), "This run ended as rejected: 1 file(s) were changed both by this conversation and in your project since: docs/NOTES.md")],
      runs: [...detail().runs, runView(3, { state: "rejected", assistantSeq: null, userSeq: 5 }, { state: "rejected", errorCode: "workspace-conflict", errorMessage: "1 file(s) were changed both by this conversation and in your project since: docs/NOTES.md" })],
    });
    const send = vi.fn(async (i) => ({ threadId: T1, replay: false, run: fakeRun({ runId: R("4"), requestId: i.idempotencyKey, threadId: T1 }) }));
    const user = userEvent.setup();
    mount(base({ threadGet: async () => failed, threadSend: send as NativeApi["threadSend"] }), `#/workspace/c/${T1}`);
    const box = await screen.findByLabelText("Message");
    expect(box).toBeEnabled();
    expect(await screen.findByText(/could not be carried into a new run/)).toBeInTheDocument();
    expect(screen.getAllByText(/docs\/NOTES.md/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /Continue from my project's current files instead/ }));
    await user.type(box, "start over from my files");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0]![0].workspace).toBe("fresh");
  });

  it("an implementation request that ended on a plan is shown as INCOMPLETE with its reason, not as a success", async () => {
    const note = "The task asked for an implementation, but the model ended without changing any file and nothing was verified (its last message was a plan or narration). Nothing was lost: send \"continue\" to try again from here.";
    const d = detail({
      thread: summary({ lastState: "incomplete", runCount: 3 }),
      messages: [...detail().messages, msg(5, "user", "request", R("3"), "Implement it now"), msg(6, "assistant", "answer", R("3"), "Plan: next I'll call fs_edit…"), msg(7, "system", "note", R("3"), note)],
      runs: [
        ...detail().runs,
        runView(3, { state: "limit-reached", userSeq: 5, assistantSeq: 6 }, { state: "limit-reached", stopReason: "no-implementation", completion: "incomplete", completionNote: note }),
      ],
    });
    mount(base({ threadGet: async () => d, threadList: async () => ({ threads: [d.thread] }) }), `#/workspace/c/${T1}`);
    const run3 = await screen.findByRole("region", { name: "Run 3" });
    expect(within(run3).getByText("Incomplete")).toBeInTheDocument();
    expect(within(run3).getByText(/Incomplete · nothing changed, nothing verified/)).toBeInTheDocument();
    expect(screen.getByText(/ended without changing any file/)).toBeInTheDocument();
    expect(within(run3).queryByText("Completed")).not.toBeInTheDocument();
    // and the composer is still there to continue
    expect(screen.getByLabelText("Message")).toBeEnabled();
  });


  it("an implementation that stopped after real changes says so: changes kept, work not finished", async () => {
    const kept = "The run stopped before the work was finished: 20 change(s) were made and are kept in the working copy, and the last check failed. Send \"continue\" to resume from here.";
    const d = detail({
      thread: summary({ lastState: "incomplete", runCount: 3 }),
      messages: [...detail().messages, msg(5, "user", "request", R("3"), "Implement it now"), msg(6, "assistant", "answer", R("3"), "Plan: next I'll call fs_edit…"), msg(7, "system", "note", R("3"), kept)],
      runs: [
        ...detail().runs,
        runView(3, { state: "limit-reached", userSeq: 5, assistantSeq: 6 }, { state: "limit-reached", stopReason: "no-implementation", completion: "incomplete", completionNote: kept, codingOutcome: { change: "applied", verification: "failed", editsApplied: 20, editsNotApplied: 0, testsExecuted: 4, testsNotExecuted: 0, blockedByApproval: 0, lastExitCode: 1, staleAfterEdit: false, uncertainOperations: 0 } }),
      ],
    });
    mount(base({ threadGet: async () => d, threadList: async () => ({ threads: [d.thread] }) }), `#/workspace/c/${T1}`);
    const run3 = await screen.findByRole("region", { name: "Run 3" });
    expect(within(run3).getByText("Incomplete")).toBeInTheDocument();
    expect(within(run3).getByText(/Incomplete · 20 changes kept, work not finished/)).toBeInTheDocument();
    expect(screen.getAllByText(/20 change\(s\) were made and are kept/).length).toBeGreaterThan(0);
    expect(within(run3).queryByText(/nothing changed/)).not.toBeInTheDocument();
    expect(within(run3).queryByText("Completed")).not.toBeInTheDocument();
    // and the composer is still there to continue
    expect(screen.getByLabelText("Message")).toBeEnabled();
  });

  it("a run that changed files but left verification commands failing is NOT shown as a clean success", async () => {
    const note = "Files were changed, but 5 verification commands failed and were never re-run successfully. They are blocked or unverified, not passed: re-run them to a pass, or verify them independently, before relying on this change.";
    const d = detail({
      thread: summary({ lastState: "completed", runCount: 3 }),
      messages: [...detail().messages, msg(5, "user", "request", R("3"), "Implement it now"), msg(6, "assistant", "answer", R("3"), "Re-reading the files. I must make a tool call.")],
      runs: [
        ...detail().runs,
        runView(3, { state: "completed", userSeq: 5, assistantSeq: 6 }, { state: "completed", completion: "failing-checks", completionNote: note, unresolvedFailedChecks: 5 }),
      ],
    });
    mount(base({ threadGet: async () => d, threadList: async () => ({ threads: [d.thread] }) }), `#/workspace/c/${T1}`);
    const run3 = await screen.findByRole("region", { name: "Run 3" });
    expect(within(run3).getByText(/Changes made · 5 checks failed, not verified/)).toBeInTheDocument();
    expect(screen.getByText(/blocked or unverified, not passed/)).toBeInTheDocument();
    expect(within(run3).queryByText(/Tests passed/)).not.toBeInTheDocument();
  });

  it("a no-change completion of an implementation request is labelled as such", async () => {
    const d = detail();
    d.runs[1]!.run = { ...d.runs[1]!.run!, completion: "no-change-reported", codingOutcome: null };
    mount(base({ threadGet: async () => d }), `#/workspace/c/${T1}`);
    const run2 = await screen.findByRole("region", { name: "Run 2" });
    expect(within(run2).getByText("Completed · no change was made")).toBeInTheDocument();
  });

  it("the mode switch sends the user's choice; Auto is the default", async () => {
    const send = vi.fn(async (i) => ({ threadId: T1, replay: false, run: fakeRun({ runId: R("3"), requestId: i.idempotencyKey, threadId: T1 }) }));
    const user = userEvent.setup();
    mount(base({ threadSend: send as NativeApi["threadSend"] }), `#/workspace/c/${T1}`);
    await screen.findByLabelText("Message");
    expect(screen.getByRole("radio", { name: "Auto" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Review only" }));
    await user.type(screen.getByLabelText("Message"), "look at F2");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0]![0].mode).toBe("review");
  });

  it("History lists conversations; opening one restores it, and switching shows only that conversation's messages", async () => {
    const two = [summary(), summary({ threadId: T2, title: "Second conversation", lastPreview: "other", projectId: "other" })];
    const get = vi.fn(async (id: string) =>
      id === T1 ? detail() : detail({ thread: summary({ threadId: T2, title: "Second conversation", projectId: "other" }), messages: [msg(1, "user", "request", R("9"), "A question in the OTHER conversation")], runs: [runView(1, { runId: R("9"), assistantSeq: null, userSeq: 1 }, { runId: R("9"), threadId: T2 })], findings: [] }),
    );
    const user = userEvent.setup();
    mount(base({ threadList: async () => ({ threads: two }), threadGet: get as NativeApi["threadGet"] }), "#/history");
    const list = await screen.findByRole("list", { name: "Conversations" });
    expect(within(list).getByText("Review the repository")).toBeInTheDocument();
    await user.click(within(list).getByText("Second conversation"));
    expect(await screen.findByText("A question in the OTHER conversation")).toBeInTheDocument();
    expect(screen.queryByText("Fixed F1. cargo test passes.")).not.toBeInTheDocument();
    expect(window.location.hash).toBe(`#/workspace/c/${T2}`);
    // switching back
    window.history.back();
    cleanup();
    mount(base({ threadList: async () => ({ threads: two }), threadGet: get as NativeApi["threadGet"] }), `#/workspace/c/${T1}`);
    expect(await screen.findByText("Fixed F1. cargo test passes.")).toBeInTheDocument();
    expect(screen.queryByText("A question in the OTHER conversation")).not.toBeInTheDocument();
  });

  it("reopening the app returns to the conversation the user was in", async () => {
    const user = userEvent.setup();
    const api = base();
    mount(api, "#/history");
    await user.click(await screen.findByText("Review the repository"));
    await screen.findByRole("log", { name: "Conversation" });
    cleanup();
    // a fresh start: no route, same device storage
    mount(api, "#");
    expect(await screen.findByRole("log", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByText("Fixed F1. cargo test passes.")).toBeInTheDocument();
  });

  it("'New conversation' starts empty: the idle composer sends with no thread id (fresh context)", async () => {
    const send = vi.fn(async (i) => ({ threadId: T2, replay: false, run: fakeRun({ runId: R("5"), requestId: i.idempotencyKey, threadId: T2 }) }));
    const user = userEvent.setup();
    mount(base({ threadSend: send as NativeApi["threadSend"], projectList: async () => ({ projects: [] }) }), `#/workspace/c/${T1}`);
    await user.click(await screen.findByRole("button", { name: /New conversation/ }));
    const box = await screen.findByLabelText("Task prompt");
    await user.type(box, "A different question");
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0]![0].threadId).toBeNull();
    expect(send.mock.calls[0]![0].projectId).toBe("east-india");
  });
});
