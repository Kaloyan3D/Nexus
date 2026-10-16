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
  tool: "fs_list",
  argsSummary: "path=.",
  status: "executed",
  errorCode: null,
  resultBytes: 408,
  resultDigest: "a".repeat(64),
  truncated: false,
  executionId: "e1",
  journalSeq: 3,
  argsDigest: "b".repeat(64),
  ...over,
});

function inspectRun(over: Partial<IntentRun> = {}): IntentRun {
  return fakeRun({
    intentType: "repo-inspect",
    conversationId: CONV,
    state: "completed",
    terminal: true,
    workspaceId: "demo",
    turn: 3,
    maxTurns: 5,
    toolCalls: 3,
    maxToolCalls: 10,
    toolResultBytes: 1234,
    toolActivity: [
      act({}),
      act({ index: 2, turn: 2, callId: "call_2", tool: "fs_read", argsSummary: "path=src/auth.rs start=4 max=12", resultBytes: 700 }),
      act({ index: 3, turn: 2, callId: "call_3", tool: "fs_write", argsSummary: "fs_write (48 bytes of arguments)", status: "refused", errorCode: "unknown-tool", resultBytes: 148, executionId: null, journalSeq: null }),
    ],
    citationsVerified: ["src/auth.rs:5-13"],
    citationsUnverified: ["src/ghost.rs:99"],
    ...over,
  });
}

describe("Desktop repo-inspect (A5.5)", () => {
  it("offers Inspect only with an operator-approved workspace, and discloses what is sent", async () => {
    const user = userEvent.setup();
    mount(fakeApi({ intentWorkspaces: async () => [] }));
    const none = await screen.findByRole("button", { name: "Inspect repo" });
    await waitFor(() => expect(none).toBeDisabled());
    expect(none).toHaveAttribute("title", expect.stringMatching(/No read-only workspace has been approved/));
    expect(screen.queryByText(/Repository contents may be sent/)).not.toBeInTheDocument();

    const api = fakeApi({ intentWorkspaces: async () => [{ workspaceId: "demo" }] });
    cleanup();
    mount(api);
    const btn = await screen.findByRole("button", { name: "Inspect repo" });
    await waitFor(() => expect(btn).toBeEnabled());
    await user.click(btn);
    expect(await screen.findByText("Repository contents may be sent to the model provider")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is written or executed/)).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace")).toBeInTheDocument();
  });

  it("submits a workspace IDENTITY with the text: no path, model, tool or limit from the renderer", async () => {
    const submit = vi.fn(async (_p: string, _w: string, key: string) => ({
      replay: false,
      run: fakeRun({ requestId: key, conversationId: CONV, state: "executing", intentType: "repo-inspect" }),
    }));
    const textOnly = vi.fn();
    const api = fakeApi({
      intentWorkspaces: async () => [{ workspaceId: "demo" }],
      intentInspectSubmit: submit as NativeApi["intentInspectSubmit"],
      intentSubmit: textOnly as unknown as NativeApi["intentSubmit"],
    });
    const user = userEvent.setup();
    mount(api);
    await user.type(await screen.findByLabelText("Task prompt"), "explain auth");
    const mode = await screen.findByRole("button", { name: "Inspect repo" });
    await waitFor(() => expect(mode).toBeEnabled());
    await user.click(mode);
    const send = await screen.findByRole("button", { name: "Inspect repository" });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const call = submit.mock.calls[0]!;
    expect(call.length).toBe(3);
    expect(call[0]).toBe("explain auth");
    expect(call[1]).toBe("demo");
    expect(String(call[2])).toMatch(/^gui-[0-9a-f]{16,}/);
    expect(textOnly).not.toHaveBeenCalled();
  });

  it("shows tool activity, refusals, limits and supported/unsupported references", async () => {
    const summary: ModelConversationSummary = {
      conversationId: CONV,
      firstPrompt: "Explain the auth flow",
      startedAtMs: 1_790_000_000_000,
      state: "limit-reached",
      terminal: true,
      providerId: "acme",
      remoteModelId: "acme-large-1",
      endpointKind: "provider",
    };
    const st: ModelRunStatus = {
      conversationId: CONV,
      state: "limit-reached",
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
      errorCode: "max-turns",
      cancelRequested: false,
      text: "",
    };
    const api = fakeApi({
      listModelConversations: async () => [summary],
      modelRunStatus: async () => st,
      conversationRead: async () => view([]),
      intentList: async () => [inspectRun({ stopReason: "max-turns" })],
    });
    const user = userEvent.setup();
    mount(api);
    await user.click(await screen.findByRole("button", { name: /Explain the auth flow/ }));
    await user.click(await screen.findByRole("tab", { name: "Activity" }));
    const section = await screen.findByRole("region", { name: "Repository inspection" });
    expect(within(section).getByText("Read-only inspection")).toBeInTheDocument();
    expect(within(section).getByText("Workspace demo")).toBeInTheDocument();
    expect(within(section).getByText("Turn 3/5")).toBeInTheDocument();
    expect(within(section).getByText("Tool calls 3/10")).toBeInTheDocument();
    const table = within(section).getByRole("table", { name: "Tool activity" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("path=src/auth.rs start=4 max=12")).toBeInTheDocument();
    expect(within(table).getByText("refused · unknown-tool")).toBeInTheDocument();
    expect(within(section).getByText(/the model-turn limit/)).toBeInTheDocument();
    expect(within(section).getByText("src/auth.rs:5-13")).toBeInTheDocument();
    expect(within(section).getByText("src/ghost.rs:99")).toBeInTheDocument();
    expect(within(section).getByText(/Nothing is written or executed/)).toBeInTheDocument();
    // a text-only run still says it has no tools
    expect(screen.queryByText(/The model has no tools, files or processes/)).not.toBeInTheDocument();
  });
});
