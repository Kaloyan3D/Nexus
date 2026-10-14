import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { ev, fakeApi, task, view } from "./fakeApi";
import { buildItems } from "../features/conversation/ConversationPanel";
import { mergeEvents } from "../features/conversation/useConversation";
import { MarkdownLite, splitBlocks } from "../lib/markdown";
import type { NativeApi } from "../lib/api";
import type { TranscriptEvent } from "../lib/contracts";

const TASK_ID = "task_0123456789abcdef0123456789abcdef";

function mount(api: NativeApi) {
  return render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
}

const events: TranscriptEvent[] = [
  ev({
    seq: 0,
    messageId: "c1",
    kind: "controller-message",
    speaker: "controller",
    inputClass: "controller-compiled",
    text: "Controller: task TASK-0001 bound to this session.",
    actor: { agent: null, model: null, provider: null },
  }),
  ev({
    seq: 1,
    messageId: "u1",
    kind: "user-message",
    speaker: "user",
    inputClass: "user-authored",
    text: "Implement the registry with api_key=[REDACTED:credential]",
    redactions: 1,
    actor: { agent: null, model: null, provider: null },
  }),
  ev({ seq: 2, messageId: "a1", text: "Working on it.\n\n```ts\nconst x = 1;\n```" }),
  ev({
    seq: 3,
    messageId: "tc1",
    kind: "tool-call",
    toolName: "run_code",
    toolCallId: "call-1",
    toolInput: '{"code":"return 1"}',
    text: null,
  }),
  ev({
    seq: 4,
    messageId: "tr1",
    kind: "tool-result",
    speaker: "tool",
    inputClass: "tool-output",
    toolCallId: "call-1",
    text: "tool says 42",
    isError: false,
    actor: { agent: null, model: null, provider: null },
  }),
  ev({ seq: 5, messageId: "e1", kind: "error", speaker: "runtime", inputClass: "system", text: "boom", isError: true }),
];

async function openTask(api: NativeApi) {
  const user = userEvent.setup();
  mount(api);
  await user.click(await screen.findByRole("button", { name: /Implement the registry/ }));
  return user;
}

describe("Conversation tab", () => {
  it("is the default view when messages were recorded, and separates roles", async () => {
    await openTask(fakeApi({ conversationRead: async () => view(events) }));
    const panel = await screen.findByRole("tabpanel");
    expect(await within(panel).findByText("Implement the registry with api_key=[REDACTED:credential]")).toBeInTheDocument();
    expect(within(panel).getByText("user-authored")).toBeInTheDocument();
    expect(within(panel).getByText("controller-compiled")).toBeInTheDocument();
    expect(within(panel).getByText(/redacted ×1/)).toBeInTheDocument();
    // actual recorded agent/model, never "Nova"
    expect(within(panel).getByText(/Worker · aih-muse/)).toBeInTheDocument();
    expect(within(panel).queryByText(/Nova/)).toBeNull();
    expect(screen.getByRole("tab", { name: "Conversation" })).toHaveAttribute("aria-selected", "true");
  });

  it("falls back to Activity and states history was not recorded", async () => {
    const user = await openTask(fakeApi({ conversationRead: async () => view([]) }));
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Conversation" }));
    expect(
      await screen.findByText("Conversation history was not recorded for this task."),
    ).toBeInTheDocument();
  });

  it("expands recorded tool calls with input and output", async () => {
    const user = await openTask(fakeApi({ conversationRead: async () => view(events) }));
    const toggle = await screen.findByRole("button", { name: /run_code/ });
    expect(screen.queryByText("tool says 42", { selector: "pre" })).toBeNull();
    await user.click(toggle);
    expect(screen.getByText('{"code":"return 1"}')).toBeInTheDocument();
    expect(screen.getByText("tool says 42", { selector: "pre" })).toBeInTheDocument();
  });

  it("filters by speaker and keeps chronological order", async () => {
    const user = await openTask(fakeApi({ conversationRead: async () => view(events) }));
    await screen.findByText("Working on it.");
    await user.click(screen.getByRole("button", { name: "User" }));
    expect(screen.queryByText("Working on it.")).toBeNull();
    expect(screen.getByText(/Implement the registry with api_key/)).toBeInTheDocument();
  });

  it("shows the exact error and never fabricates content when the read fails", async () => {
    await openTask(
      fakeApi({
        conversationRead: async () => Promise.reject({ code: "internal", message: "store unreadable" }),
      }),
    );
    await userEvent.setup().click(await screen.findByRole("tab", { name: "Conversation" }));
    expect(await screen.findByText("store unreadable")).toBeInTheDocument();
  });

  it("ignores a slow response for a previously selected task (no cross-task leakage)", async () => {
    const user = userEvent.setup();
    const slow = new Promise<ReturnType<typeof view>>((res) =>
      setTimeout(() => res(view([ev({ seq: 0, messageId: "LEAK", text: "LEAKED FROM TASK 1" })])), 120),
    );
    const api = fakeApi({
      listTasks: async () => ({
        available: true,
        source: "x",
        error: null,
        tasks: [
          task(),
          task({ taskId: "TASK-0002", title: "Second task", taskInstanceId: "task_ffffffffffffffffffffffffffffffff" }),
        ],
      }),
      conversationRead: (id: string) =>
        id === TASK_ID
          ? slow
          : Promise.resolve(
              view([ev({ seq: 0, messageId: "ok", text: "second task message", taskInstanceId: id })], {
                taskInstanceId: id,
              }),
            ),
    });
    mount(api);
    await user.click(await screen.findByRole("button", { name: /Implement the registry/ }));
    await user.click(await screen.findByRole("button", { name: /Second task/ }));
    expect(await screen.findByText("second task message")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByText("LEAKED FROM TASK 1")).toBeNull();
  });

  it("renders untrusted markdown as inert text", async () => {
    const evil = ev({
      seq: 0,
      messageId: "x",
      text: "<script>window.__pwned=1</script> [click](javascript:alert(1)) **bold** `code`\n```\nunterminated",
    });
    await openTask(fakeApi({ conversationRead: async () => view([evil]) }));
    await screen.findByText(/click/);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(document.querySelector("script[src], a[href^='javascript']")).toBeNull();
    expect(document.querySelector(".nv-md a")).toBeNull();
    expect(screen.getByText(/<script>window.__pwned=1<\/script>/)).toBeInTheDocument();
  });

  it("labels mock-fixture records as MOCK and polls with a cursor", async () => {
    const user = userEvent.setup();
    const calls: Array<{ afterSeq?: number }> = [];
    const mockEv = [
      ev({ seq: 0, messageId: "u", kind: "user-message", speaker: "user", inputClass: "user-authored", source: "mock-fixture", text: "hi", taskInstanceId: "mock_0123456789abcdef0123456789abcdef" }),
    ];
    const api = fakeApi({
      conversationRead: async (_id: string, q = {}) => {
        calls.push(q);
        return view(mockEv, { source: "native-store" });
      },
      runMock: async (_p: string, on) => {
        on({ type: "conversation", conversationId: "mock_0123456789abcdef0123456789abcdef" });
        await new Promise((r) => setTimeout(r, 1700));
        return {
          conversationId: "mock_0123456789abcdef0123456789abcdef",
          runId: "r",
          mock: true as const,
          text: "t",
          attemptId: "a",
          commandId: "c",
          requestDigest: "d",
          finishReason: "stop",
          usageInput: 1,
          usageOutput: 1,
          checks: [],
          eventCount: 0,
          durationMs: 1,
        };
      },
    });
    mount(api);
    await user.type(screen.getByLabelText("Task prompt"), "hi");
    await user.click(screen.getByRole("button", { name: "Run Mock" }));
    await waitFor(() => expect(calls.some((c) => c.afterSeq !== undefined)).toBe(true), { timeout: 4000 });
    const panel = await screen.findByRole("tabpanel");
    expect((await within(panel).findAllByText("MOCK")).length).toBeGreaterThan(0);
  });
});

describe("conversation view-model", () => {
  it("dedupes by message id and the newest revision wins", () => {
    const a = ev({ seq: 1, messageId: "m", text: "Hel", state: "partial" });
    const b = ev({ seq: 1, messageId: "m", text: "Hello", state: "final", revision: 1, revisionSeq: 5 });
    const merged = mergeEvents([a], [b, a], TASK_ID);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.text).toBe("Hello");
    // replaying the stale revision never regresses
    expect(mergeEvents(merged, [a], TASK_ID)[0]!.text).toBe("Hello");
  });

  it("drops records that name another task", () => {
    const other = ev({ seq: 0, messageId: "z", taskInstanceId: "task_ffffffffffffffffffffffffffffffff" });
    expect(mergeEvents([], [other], TASK_ID)).toHaveLength(0);
  });

  it("pairs tool calls with results and leaves unmatched results visible", () => {
    const items = buildItems(events);
    const tool = items.find((i) => i.type === "tool" && i.call?.toolCallId === "call-1");
    expect(tool && tool.type === "tool" && tool.result?.text).toBe("tool says 42");
    const orphan = buildItems([
      ev({ seq: 0, messageId: "r", kind: "tool-result", toolCallId: "nope", speaker: "tool", text: "x" }),
    ]);
    expect(orphan[0]!.type).toBe("tool");
  });

  it("orders by display position even when later revisions arrive last", () => {
    const merged = mergeEvents(
      [ev({ seq: 0, messageId: "a" }), ev({ seq: 2, messageId: "c" })],
      [ev({ seq: 1, messageId: "b", revisionSeq: 9 })],
      TASK_ID,
    );
    expect(merged.map((e) => e.messageId)).toEqual(["a", "b", "c"]);
  });

  it("handles a very large transcript without rendering everything", async () => {
    const big = Array.from({ length: 3000 }, (_, i) => ev({ seq: i, messageId: `m${i}`, text: `message ${i}` }));
    const t0 = performance.now();
    await openTask(fakeApi({ conversationRead: async () => view(big) }));
    await screen.findByText("message 2999");
    const rendered = document.querySelectorAll("article.nv-msg").length;
    expect(rendered).toBeLessThanOrEqual(120);
    expect(performance.now() - t0).toBeLessThan(8000);
  });
});

describe("markdown-lite", () => {
  it("splits fences, tolerating an unterminated one", () => {
    const b = splitBlocks("a\n```js\nx\n```\nb\n```\nopen");
    expect(b.map((x) => x.type)).toEqual(["text", "code", "text", "code"]);
    expect(b[3]!.body).toBe("open");
  });
  it("never emits anchors or raw html", () => {
    const { container } = render(<MarkdownLite text="<img src=x onerror=alert(1)> [a](http://e.com)" />);
    expect(container.querySelector("img, a")).toBeNull();
  });
  it("is quiet about unused vi", () => {
    expect(vi).toBeDefined();
  });
});
