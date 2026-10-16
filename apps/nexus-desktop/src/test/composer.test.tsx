import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi, fakeRun } from "./fakeApi";
import type { NativeApi } from "../lib/api";

const CONV = "model_0123456789abcdef0123456789abcdef";

function mount(api: NativeApi) {
  return render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
}

async function type(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(await screen.findByLabelText("Task prompt"), text);
}

describe("Composer -> intent broker (A5.3)", () => {
  it("sends the typed text with the selected Registry model through the broker API", async () => {
    const submit = vi.fn(async (_p: string, _m: unknown, key: string) => ({
      replay: false,
      run: fakeRun({ requestId: key, conversationId: CONV, state: "executing" }),
    }));
    const api = fakeApi({
      intentSubmit: submit as NativeApi["intentSubmit"],
      listModelConversations: async () => [
        { conversationId: CONV, firstPrompt: "design it", startedAtMs: 1, state: "streaming", terminal: false, providerId: "acme", remoteModelId: "acme-large-1", endpointKind: "provider" },
      ],
    });
    const user = userEvent.setup();
    mount(api);
    await type(user, "design it");
    const send = await screen.findByRole("button", { name: "Send to model" });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const [prompt, model, key] = submit.mock.calls[0]!;
    expect(prompt).toBe("design it");
    expect(model).toEqual({ providerId: "acme", remoteModelId: "acme-large-1" });
    expect(String(key)).toMatch(/^gui-[0-9a-f]{16,}/);
    // The shared conversation view takes over, showing provenance.
    expect(await screen.findByText(/acme \/ acme-large-1/)).toBeInTheDocument();
    // Only the three documented fields cross the renderer boundary.
    expect(submit.mock.calls[0]!.length).toBe(3);
  });

  it("a duplicate click while submitting cannot create a second submission", async () => {
    let release: (v: unknown) => void = () => {};
    const submit = vi.fn(
      () =>
        new Promise((res) => {
          release = res;
        }),
    );
    const api = fakeApi({ intentSubmit: submit as unknown as NativeApi["intentSubmit"] });
    const user = userEvent.setup();
    mount(api);
    await type(user, "once");
    const send = await screen.findByRole("button", { name: "Send to model" });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await user.click(send);
    await user.click(send);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(send).toBeDisabled();
    release({ replay: false, run: fakeRun({ conversationId: CONV }) });
  });

  it("keeps the text and shows the explicit reason when the broker refuses", async () => {
    const api = fakeApi({
      intentSubmit: (async () => {
        throw { code: "model-not-available", message: "the Registry does not currently issue this provider/model" };
      }) as NativeApi["intentSubmit"],
    });
    const user = userEvent.setup();
    mount(api);
    await type(user, "keep me");
    const send = await screen.findByRole("button", { name: "Send to model" });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    expect(await screen.findByText("Send failed: model-not-available")).toBeInTheDocument();
    expect(screen.getByLabelText("Task prompt")).toHaveValue("keep me");
  });

  it("offers cancellation while the run is being prepared and uses the broker cancel", async () => {
    const cancel = vi.fn(async (id: string) => ({ run: fakeRun({ runId: id, cancelRequested: true, conversationId: null }), outcome: "requested" }));
    const api = fakeApi({
      intentSubmit: (async () => ({ replay: false, run: fakeRun({ conversationId: null, state: "preparing" }) })) as NativeApi["intentSubmit"],
      intentStatus: (async (id: string) => fakeRun({ runId: id, conversationId: null, state: "preparing" })) as NativeApi["intentStatus"],
      intentCancel: cancel as NativeApi["intentCancel"],
    });
    const user = userEvent.setup();
    mount(api);
    await type(user, "slow start");
    const send = await screen.findByRole("button", { name: "Send to model" });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    const stop = await screen.findByRole("button", { name: "Cancel submission" });
    await user.click(stop);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("run_" + "a".repeat(32)));
  });

  it("disables Send and says why when the broker is unavailable", async () => {
    const api = fakeApi({
      intentModels: (async () => {
        throw { code: "disconnected", message: "daemon socket unreachable" };
      }) as NativeApi["intentModels"],
    });
    mount(api);
    const send = await screen.findByRole("button", { name: "Send to model" });
    expect(send).toBeDisabled();
    expect(await screen.findByText(/Model sending is unavailable: daemon socket unreachable/)).toBeInTheDocument();
  });

  it("the renderer API exposes no secret, grant, capability or tool vocabulary", () => {
    const keys = Object.keys(fakeApi());
    for (const k of keys) {
      expect(k).not.toMatch(/credential|capab|grant|secret|token|shell|exec|approve|issuer|redeem|workspace|writeFile/i);
    }
    expect(keys).toEqual(expect.arrayContaining(["intentModels", "intentSubmit", "intentStatus", "intentCancel", "intentList"]));
  });
});
