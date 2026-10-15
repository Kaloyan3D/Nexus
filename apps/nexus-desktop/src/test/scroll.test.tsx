import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { ev, fakeApi, view } from "./fakeApi";
import type { NativeApi } from "../lib/api";

// jsdom has no layout: model a 1000px tall list in a 300px viewport.
const tops = new WeakMap<Element, number>();
const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
const saved: Record<string, PropertyDescriptor | undefined> = {};

beforeEach(() => {
  for (const k of ["scrollHeight", "clientHeight", "scrollTop"]) {
    saved[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
  }
  const isList = (el: Element) => el.classList.contains("nv-conv__list");
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      return isList(this) ? 1000 : 0;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: Element) {
      return isList(this) ? 300 : 0;
    },
  });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return tops.get(this) ?? 0;
    },
    set(this: Element, v: number) {
      tops.set(this, v);
    },
  });
});
afterEach(() => {
  for (const [k, d] of Object.entries(saved)) {
    if (d) Object.defineProperty(HTMLElement.prototype, k, d);
    else delete proto[k];
  }
});

function mount(api: NativeApi) {
  return render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
}
const list = () => document.querySelector(".nv-conv__list") as HTMLElement;
const history = [0, 1, 2].map((i) => ev({ seq: i, messageId: `m${i}`, text: `msg ${i}` }));

describe("conversation scroll policy", () => {
  it("historical conversations open on the latest message (no jump control)", async () => {
    const user = userEvent.setup();
    mount(fakeApi({ conversationRead: async () => view(history) }));
    await user.click(await screen.findByRole("button", { name: /Implement the registry/ }));
    await screen.findByText("msg 2");
    await waitFor(() => expect(list().scrollTop).toBe(1000));
    expect(screen.queryByText("Jump to latest")).toBeNull();
  });

  it("a native/mock conversation opens at the top so the prompt is visible, with Jump to latest", async () => {
    const user = userEvent.setup();
    const mockId = "mock_0123456789abcdef0123456789abcdef";
    const evs = [
      ev({ seq: 0, messageId: "u", kind: "user-message", speaker: "user", inputClass: "user-authored", source: "mock-fixture", taskInstanceId: mockId, text: "my prompt" }),
      ev({ seq: 1, messageId: "a", source: "mock-fixture", taskInstanceId: mockId, text: "reply" }),
    ];
    mount(
      fakeApi({
        conversationRead: async () => view(evs, { source: "native-store", taskInstanceId: mockId }),
        runMock: async (_p: string, on) => {
          on({ type: "conversation", conversationId: mockId });
          return {
            conversationId: mockId, runId: "r", mock: true as const, text: "reply", attemptId: "a",
            commandId: "c", requestDigest: "d", finishReason: "stop", usageInput: 1, usageOutput: 1,
            checks: [], eventCount: 0, durationMs: 1,
          };
        },
      }),
    );
    await user.type(screen.getByLabelText("Task prompt"), "my prompt");
    await user.click(screen.getByRole("button", { name: "Run Mock" }));
    await screen.findAllByText("my prompt");
    await waitFor(() => expect(screen.getByText("Jump to latest")).toBeInTheDocument());
    expect(list().scrollTop).toBe(0);
    await user.click(screen.getByText("Jump to latest"));
    expect(list().scrollTop).toBe(1000);
    expect(screen.queryByText("Jump to latest")).toBeNull();
  });

  it("does not drag the user back down when they have scrolled up", async () => {
    const user = userEvent.setup();
    let polls = 0;
    const mockId = "mock_0123456789abcdef0123456789abcdef";
    const base = [ev({ seq: 0, messageId: "u", kind: "user-message", speaker: "user", inputClass: "user-authored", source: "mock-fixture", taskInstanceId: mockId, text: "p" })];
    mount(
      fakeApi({
        conversationRead: async (_i: string, q = {}) => {
          if (q.afterSeq !== undefined) {
            polls++;
            const more = ev({ seq: 1 + polls, messageId: `n${polls}`, source: "mock-fixture", taskInstanceId: mockId, text: `chunk ${polls}`, revisionSeq: 1 + polls });
            return view([more], { source: "native-store", taskInstanceId: mockId, page: { ...view([more]).page, headSeq: 1 + polls } });
          }
          return view(base, { source: "native-store", taskInstanceId: mockId });
        },
        runMock: async (_p: string, on) => {
          on({ type: "conversation", conversationId: mockId });
          await new Promise((r) => setTimeout(r, 3500));
          throw { code: "internal", message: "end" };
        },
      }),
    );
    await user.type(screen.getByLabelText("Task prompt"), "p");
    await user.click(screen.getByRole("button", { name: "Run Mock" }));
    await waitFor(() => expect(screen.getByText("Jump to latest")).toBeInTheDocument());
    // user is at the top (not near bottom): new output must not move the viewport
    await act(async () => {
      fireEvent.scroll(list());
    });
    await waitFor(() => expect(polls).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    expect(list().scrollTop).toBe(0);
    expect(screen.getByText("Jump to latest")).toBeInTheDocument();
  }, 15000);

  it("expanding a tool call does not move the viewport", async () => {
    const user = userEvent.setup();
    const evs = [
      ev({ seq: 0, messageId: "t", kind: "tool-call", toolName: "run_code", toolCallId: "c1", toolInput: "{}", text: null }),
      ev({ seq: 1, messageId: "r", kind: "tool-result", speaker: "tool", inputClass: "tool-output", toolCallId: "c1", text: "out" }),
    ];
    mount(fakeApi({ conversationRead: async () => view(evs) }));
    await user.click(await screen.findByRole("button", { name: /Implement the registry/ }));
    const head = await waitFor(() => {
      const h = document.querySelector<HTMLButtonElement>(".nv-tool__head");
      if (!h) throw new Error("no tool row");
      return h;
    });
    await waitFor(() => expect(list().scrollTop).toBe(1000));
    tops.set(list(), 420);
    await user.click(head);
    expect(list().scrollTop).toBe(420);
  });

  it("keeps the same message in place when earlier records are prepended", async () => {
    const user = userEvent.setup();
    const later = [10, 11, 12].map((i) => ev({ seq: i, messageId: `m${i}`, text: `later ${i}` }));
    const earlier = [7, 8, 9].map((i) => ev({ seq: i, messageId: `m${i}`, text: `earlier ${i}` }));
    let call = 0;
    mount(
      fakeApi({
        conversationRead: async () => {
          call++;
          const first = call === 1;
          return view(first ? later : earlier, {
            page: { ...view(first ? later : earlier).page, hasEarlier: first, headSeq: 12 },
          });
        },
      }),
    );
    await user.click(await screen.findByRole("button", { name: /Implement the registry/ }));
    await screen.findByText("later 12");
    await waitFor(() => expect(list().scrollTop).toBe(1000));
    // the list becomes 400px taller once the earlier records are in the DOM
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: Element) {
        if (!this.classList.contains("nv-conv__list")) return 0;
        return 1000 + (this.textContent?.includes("earlier 7") ? 400 : 0);
      },
    });
    tops.set(list(), 200);
    await user.click(await screen.findByText("Load earlier messages"));
    await screen.findByText("earlier 9");
    await waitFor(() => expect(list().scrollTop).toBe(600));
  });
});
