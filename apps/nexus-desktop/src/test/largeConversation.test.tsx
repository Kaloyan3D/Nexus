import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { ev, fakeApi, task, view } from "./fakeApi";
import type { NativeApi } from "../lib/api";
import type { TranscriptEvent } from "../lib/contracts";

const A = "task_0123456789abcdef0123456789abcdef";
const B = "task_ffffffffffffffffffffffffffffffff";

function mount(api: NativeApi) {
  return render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
}

/** ~6000 records: user prompts, assistant text, paired tool calls over 3 attempts. */
function big(taskId: string): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  let seq = 0;
  for (let i = 0; i < 1500; i++) {
    const attempt = `TASK-0001-A${1 + Math.floor(i / 500)}`;
    const base = { taskInstanceId: taskId, attemptId: attempt };
    out.push(
      ev({ ...base, seq: seq++, messageId: `a${i}`, text: `assistant message ${i}\n\n\`\`\`ts\nconst n = ${i};\n\`\`\`` }),
      ev({ ...base, seq: seq++, messageId: `c${i}`, kind: "tool-call", toolName: "run_code", toolCallId: `call-${i}`, toolInput: `{"i":${i}}`, text: null }),
      ev({ ...base, seq: seq++, messageId: `r${i}`, kind: "tool-result", speaker: "tool", inputClass: "tool-output", toolCallId: `call-${i}`, text: `out ${i}`.repeat(50), isError: false }),
    );
    if (i % 5 === 0)
      out.push(
        ev({ ...base, seq: seq++, messageId: `u${i}`, kind: "user-message", speaker: "user", inputClass: "user-authored", text: `user ${i}` }),
      );
  }
  return out;
}

const bigView = (id: string) =>
  view(big(id), {
    taskInstanceId: id,
    attempts: [1, 2, 3].map((n) => ({
      attemptId: `TASK-0001-A${n}`,
      sequence: n,
      executionClass: "muse_main",
      sessionId: "session-x",
      startedByTurn: n,
      startedAtUtc: null,
      binding: "verified",
    })),
  });

describe("large conversation viewer", () => {
  it("view-model work for 6000 records is cheap", async () => {
    const { buildItems } = await import("../features/conversation/ConversationPanel");
    const { mergeEvents } = await import("../features/conversation/useConversation");
    const events = big(A);
    const t0 = performance.now();
    const merged = mergeEvents([], events, A);
    const items = buildItems(merged);
    const again = mergeEvents(merged, events, A); // full replay
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(again).toHaveLength(merged.length);
    expect(items.length).toBeLessThan(merged.length); // call+result collapse into one row
  });

  it("renders a ~6000 record transcript with bounded DOM, filtering, grouping and tool expansion", async () => {
    const user = userEvent.setup();
    mount(
      fakeApi({
        conversationRead: async (id: string) => bigView(id),
      }),
    );
    await user.click(await screen.findByRole("button", { name: /Implement the registry/ }));
    const panel = await screen.findByRole("tabpanel");
    await within(panel).findByText(/assistant message 1499/);
    const initialDom = document.querySelectorAll(".nv-msg, .nv-tool").length;
    expect(initialDom).toBeLessThanOrEqual(200);

    const t0 = performance.now();
    const pill = (label: string) =>
      [...panel.querySelectorAll<HTMLButtonElement>(".nv-pill")].find((b) => b.textContent === label)!;
    await user.click(pill("User"));
    await within(panel).findByText("user 1495");
    expect(within(panel).queryByText(/assistant message 1499/)).toBeNull();
    await user.click(pill("All"));
    await user.click(panel.querySelector<HTMLInputElement>(".nv-conv__toggle input")!);
    await within(panel).findByText(/Attempt 3 · TASK-0001-A3/);
    // tool expansion on the newest call
    const tools = panel.querySelectorAll<HTMLButtonElement>(".nv-tool__head");
    await user.click(tools[tools.length - 1]!);
    expect(within(panel).getAllByText(/out 1499/).length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(15000);
    expect(document.querySelectorAll(".nv-msg, .nv-tool").length).toBeLessThanOrEqual(260);
  }, 40000);

  it("rapid task switching ends on the last selection with no mixed records", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      listTasks: async () => ({
        available: true,
        source: "x",
        error: null,
        tasks: [task(), task({ taskId: "TASK-0002", title: "Second task", taskInstanceId: B })],
      }),
      conversationRead: (id: string) =>
        new Promise((res) =>
          setTimeout(
            () =>
              res(
                view([ev({ seq: 0, messageId: `only-${id}`, taskInstanceId: id, text: `message for ${id.slice(0, 9)}` })], {
                  taskInstanceId: id,
                }),
              ),
            id === A ? 80 : 10,
          ),
        ),
    });
    mount(api);
    const first = await screen.findByRole("button", { name: /Implement the registry/ });
    const second = await screen.findByRole("button", { name: /Second task/ });
    for (let i = 0; i < 12; i++) {
      await user.click(i % 2 === 0 ? first : second);
    }
    await user.click(second);
    await waitFor(() => expect(screen.getByText(/message for task_fff/)).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.queryByText(/message for task_012/)).toBeNull();
  }, 30000);

  it("a reconnect that replays the same records adds no duplicates", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const events = [
      ev({ seq: 0, messageId: "u", kind: "user-message", speaker: "user", inputClass: "user-authored", text: "dup-check", source: "mock-fixture", taskInstanceId: "mock_0123456789abcdef0123456789abcdef" }),
    ];
    mount(
      fakeApi({
        conversationRead: async (_id: string, q = {}) => {
          calls++;
          // every poll replays the same record again (reconnect/replay)
          return view(events, { source: "native-store", page: { ...view(events).page, headSeq: q.afterSeq ?? 0 } });
        },
        runMock: async (_p: string, on) => {
          on({ type: "conversation", conversationId: "mock_0123456789abcdef0123456789abcdef" });
          await new Promise((r) => setTimeout(r, 3400));
          throw { code: "internal", message: "stop" };
        },
      }),
    );
    await user.type(screen.getByLabelText("Task prompt"), "go");
    await user.click(screen.getByRole("button", { name: "Run Mock" }));
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(3), { timeout: 6000 });
    expect(screen.getAllByText("dup-check")).toHaveLength(1);
  }, 20000);
});
