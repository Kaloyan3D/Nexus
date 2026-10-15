import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { ev, fakeApi, view } from "./fakeApi";
import type { NativeApi } from "../lib/api";
import type { ModelConversationSummary, ModelRunStatus } from "../lib/contracts";

const CONV = "model_0123456789abcdef0123456789abcdef";

function summary(over: Partial<ModelConversationSummary> = {}): ModelConversationSummary {
  return {
    conversationId: CONV,
    firstPrompt: "Summarize the design",
    startedAtMs: 1_790_000_000_000,
    state: "streaming",
    terminal: false,
    providerId: "acme",
    remoteModelId: "acme-large-1",
    endpointKind: "provider",
    ...over,
  };
}

function status(over: Partial<ModelRunStatus> = {}): ModelRunStatus {
  return {
    conversationId: CONV,
    state: "streaming",
    terminal: false,
    providerId: "acme",
    remoteModelId: "acme-large-1",
    logicalModelId: "acme/large",
    endpointKind: "provider",
    attemptId: "TASK-1-A1",
    commandId: "shadow-abc",
    requestDigest: "d".repeat(64),
    httpStatus: null,
    usageInputTokens: null,
    usageOutputTokens: null,
    finishReason: null,
    latencyMs: null,
    errorCode: null,
    cancelRequested: false,
    text: "",
    ...over,
  };
}

const convEvents = (assistant: string, state: "partial" | "final" = "partial") => [
  ev({
    seq: 0,
    messageId: "user-1",
    kind: "user-message",
    speaker: "user",
    inputClass: "user-authored",
    text: "Summarize the design",
    source: "native-store",
    taskInstanceId: CONV,
    actor: { agent: null, model: null, provider: null },
  }),
  ev({
    seq: 1,
    messageId: "assistant-1",
    kind: "assistant-message",
    text: assistant,
    state,
    source: "native-store",
    taskInstanceId: CONV,
    actor: { agent: "nexus-model-only", model: "acme-large-1", provider: "acme" },
  }),
];

async function openRun(api: NativeApi) {
  const user = userEvent.setup();
  render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
  await user.click(await screen.findByRole("button", { name: /Summarize the design/ }));
  return user;
}

describe("Model-only runs (A5.1)", () => {
  it("shows provider, model, endpoint kind, streaming text and cancel", async () => {
    const cancel = vi.fn(async () => {});
    const api = fakeApi({
      listModelConversations: async () => [summary()],
      modelRunStatus: async () => status(),
      conversationRead: async () => ({
        ...view(convEvents("Partial answer so f")),
        taskInstanceId: CONV,
        source: "native-store",
      }),
      cancelModelRun: cancel,
    });
    const user = await openRun(api);
    const panel = await screen.findByRole("tabpanel");
    expect(await within(panel).findByText("Partial answer so f")).toBeInTheDocument();
    expect(within(panel).getByText("partial")).toBeInTheDocument();
    expect(await screen.findByText(/acme \/ acme-large-1/)).toBeInTheDocument();
    expect(screen.getAllByText("Streaming").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Provider").length).toBeGreaterThan(0);
    expect(screen.getByText("Usage not reported by the provider")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Cancel run" }, { timeout: 5000 }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(CONV), { timeout: 5000 });
  });

  it("labels a loopback fixture honestly and reports provider usage only when present", async () => {
    const api = fakeApi({
      listModelConversations: async () =>
        [summary({ state: "completed", terminal: true, endpointKind: "loopback-test-double" })],
      modelRunStatus: async () =>
        status({
          state: "completed",
          terminal: true,
          endpointKind: "loopback-test-double",
          usageInputTokens: 3,
          usageOutputTokens: 4,
          httpStatus: 200,
          finishReason: "stop",
          latencyMs: 41,
        }),
      conversationRead: async () => view(convEvents("Hello world", "final")),
    });
    await openRun(api);
    expect(await screen.findByText(/Loopback test double \(not a real provider\)/)).toBeInTheDocument();
    expect(screen.getByText("3 in · 4 out tokens (provider-reported)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument();
  });

  it("states uncertainty explicitly and offers no resend", async () => {
    const api = fakeApi({
      listModelConversations: async () => [summary({ state: "uncertain", terminal: true })],
      modelRunStatus: async () =>
        status({ state: "uncertain", terminal: true, errorCode: "send-uncertain" }),
      conversationRead: async () => view(convEvents("half", "partial")),
    });
    const user = await openRun(api);
    await user.click(await screen.findByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("Submission outcome is uncertain")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /resend|retry|run again/i })).not.toBeInTheDocument();
  });

  it("renders hostile model output as inert text (no markup, links or scripts)", async () => {
    const hostile =
      '<img src=x onerror="alert(1)"><script>alert(2)</script>\n[click](javascript:alert(3))\n<a href="https://evil.example">x</a>\n```html\n<iframe src="https://evil.example"></iframe>\n```';
    const api = fakeApi({
      listModelConversations: async () => [summary({ state: "completed", terminal: true })],
      modelRunStatus: async () => status({ state: "completed", terminal: true }),
      conversationRead: async () => view(convEvents(hostile, "final")),
    });
    await openRun(api);
    const panel = await screen.findByRole("tabpanel");
    await within(panel).findByText(/click\]\(javascript:alert\(3\)\)/);
    expect(panel.querySelector("script")).toBeNull();
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.querySelector("iframe")).toBeNull();
    expect(panel.querySelector('a[href*="evil"]')).toBeNull();
    expect(panel.querySelector('a[href^="javascript"]')).toBeNull();
    // Model-generated text can never reach a privileged function: the
    // renderer API has no execution, approval or credential method.
    const api2 = Object.keys(fakeApi()).sort();
    for (const k of api2) {
      expect(k).not.toMatch(/^(run(Tool|Process|Command|Shell)|approve|deny|grant|credential|execute)/i);
    }
  });
});
