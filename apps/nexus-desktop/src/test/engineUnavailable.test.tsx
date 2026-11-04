import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi } from "./fakeApi";
import type { NativeApi } from "../lib/api";
import type { RuntimeState } from "../lib/contracts";

const MESSAGE = "The Nexus engineering engine runs on Linux and is not connected to this Mac yet.";

// What the macOS desktop-only host reports (src-tauri/src/macos_app.rs).
const unavailable: RuntimeState = {
  mode: "interactive",
  phase: "unavailable",
  message: MESSAGE,
  home: null,
  providerConnected: false,
  consent: { given: false, providerId: null, remoteModelId: null, text: null },
  canOpenProjects: false,
  updatePending: false,
};

function mount(api: NativeApi, hash = "#") {
  window.history.replaceState(null, "", hash);
  return render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
}

afterEach(cleanup);

describe("Engine not connected (macOS desktop-only host)", () => {
  it("says the engine is not connected, never ready, and starts nothing", async () => {
    const runtimeStart = vi.fn(async () => undefined);
    mount(fakeApi({ runtimeState: async () => unavailable, runtimeStart }));
    expect((await screen.findAllByText(/engine not connected/i)).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: /Nexus engine not connected/ })).toBeInTheDocument();
    expect(screen.queryByText(/Nexus ready/i)).toBeNull();
    expect(screen.queryByText(/could not start/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    expect(runtimeStart).not.toHaveBeenCalled();
  });

  it("keeps navigation working and disables engine-dependent settings actions", async () => {
    const user = userEvent.setup();
    mount(fakeApi({ runtimeState: async () => unavailable }), "#settings");
    const connect = await screen.findByRole("button", { name: /connect opencode go/i });
    expect(connect).toBeDisabled();
    await waitFor(() => expect(screen.getAllByText(/not connected/i).length).toBeGreaterThan(0));
    const nav = screen.getAllByRole("button", { name: /projects/i })[0];
    expect(nav).toBeDefined();
    await user.click(nav!);
    expect(window.location.hash).toMatch(/projects/);
  });
});
