import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi, snapshot } from "./fakeApi";
import type { NativeApi } from "../lib/api";

function mount(api: NativeApi) {
  return render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
}

describe("Nexus shell", () => {
  it("renders all navigation destinations and the spec placeholder", async () => {
    mount(fakeApi());
    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const n of ["Workspace", "Tasks", "Control Room", "Models", "Sentry", "Sessions", "Settings"]) {
      expect(within(nav).getByRole("button", { name: new RegExp(n) })).toBeInTheDocument();
    }
    expect(
      screen.getByPlaceholderText("Describe the next step, ask Nova, or give an engineering task..."),
    ).toBeInTheDocument();
    await screen.findByText("Native runtime connected");
  });

  it("never offers a live-ready primary action", async () => {
    mount(fakeApi());
    expect(screen.getByRole("button", { name: "Run Mock" })).toBeDisabled(); // empty prompt
    expect(screen.getAllByText(/Live execution unavailable/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /^Run Task$/ })).toBeNull();
  });

  it("shows ledger tasks and selects one into the inspector", async () => {
    const user = userEvent.setup();
    mount(fakeApi());
    const row = await screen.findByRole("button", { name: /Fix the bug/ });
    await user.click(row);
    const insp = screen.getByRole("complementary", { name: "Task inspector" });
    expect(within(insp).getByText("TASK-0002")).toBeInTheDocument();
    expect(within(insp).getByText(/Authoritative/)).toBeInTheDocument();
    // honest absence rather than invented model/cost
    expect(within(insp).getByText("Not recorded in ledger")).toBeInTheDocument();
  });

  it("shows an honest unavailable state when the ledger cannot be read", async () => {
    mount(
      fakeApi({
        listTasks: async () => ({ available: false, source: null, error: "ledger unreadable", tasks: [] }),
      }),
    );
    expect(await screen.findAllByText(/Task ledger unavailable/)).not.toHaveLength(0);
    expect(screen.queryByText("TASK-0001")).toBeNull();
  });

  it("runs a mock workflow end to end and labels it MOCK", async () => {
    const user = userEvent.setup();
    const runMock = vi.fn(fakeApi().runMock);
    mount(fakeApi({ runMock }));
    await user.type(screen.getByLabelText("Task prompt"), "Привет, Nova");
    await user.click(screen.getByRole("button", { name: "Run Mock" }));
    await waitFor(() => expect(runMock).toHaveBeenCalledWith("Привет, Nova", expect.any(Function)));
    expect(await screen.findByText("Mock run completed")).toBeInTheDocument();
    expect(screen.getAllByText("MOCK").length).toBeGreaterThan(0);
    const insp = screen.getByRole("complementary", { name: "Task inspector" });
    expect(within(insp).getByText("attempt-mock-1")).toBeInTheDocument();
    expect(within(insp).getByText(/Not recorded in the Controller ledger/)).toBeInTheDocument();
  });

  it("reports mock failures accurately", async () => {
    const user = userEvent.setup();
    mount(
      fakeApi({ runMock: async () => Promise.reject({ code: "internal", message: "mock kernel unavailable" }) }),
    );
    await user.type(screen.getByLabelText("Task prompt"), "go");
    await user.click(screen.getByRole("button", { name: "Run Mock" }));
    expect(await screen.findByText("Mock run failed")).toBeInTheDocument();
    expect(screen.getAllByText("mock kernel unavailable").length).toBeGreaterThan(0);
  });

  it("disables unavailable activity tabs with truthful copy", async () => {
    const user = userEvent.setup();
    mount(fakeApi());
    await user.click(await screen.findByRole("button", { name: /Fix the bug/ }));
    await user.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(screen.getByText(/Terminal unavailable/)).toBeInTheDocument();
  });

  it("reflects a disconnected daemon without fabricating status", async () => {
    mount(
      fakeApi({
        runtimeStatus: async () =>
          snapshot({ connection: "disconnected", detail: "socket missing", state: null }),
      }),
    );
    expect(await screen.findByText("Runtime disconnected")).toBeInTheDocument();
    expect(screen.getByText("Daemon offline")).toBeInTheDocument();
  });

  it("opens the command palette with Ctrl+K and closes with Escape", async () => {
    const user = userEvent.setup();
    mount(fakeApi());
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(within(dialog).getByRole("option", { name: /Control Room/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
  });

  it("palette finds real tasks only", async () => {
    const user = userEvent.setup();
    mount(fakeApi());
    await screen.findByText("Native runtime connected");
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("registry");
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(within(dialog).getByRole("option", { name: /Implement the registry/ })).toBeInTheDocument();
    await user.clear(within(dialog).getByRole("combobox"));
    await user.type(within(dialog).getByRole("combobox"), "zzzz-nothing");
    expect(within(dialog).getByText(/No matching/)).toBeInTheDocument();
  });

  it("Sentry shows an integration-unavailable state, not findings", async () => {
    const user = userEvent.setup();
    mount(fakeApi());
    await user.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: /Sentry/ }));
    expect(screen.getByText("Sentry integration unavailable")).toBeInTheDocument();
  });

  it("Models page labels the catalog as offline mock", async () => {
    const user = userEvent.setup();
    mount(fakeApi());
    await user.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: /Models/ }));
    expect(await screen.findByText("Offline mock catalog", { selector: ".nv-alert__title" })).toBeInTheDocument();
    expect(await screen.findByText("e2e-mock-model")).toBeInTheDocument();
    expect(screen.getByText("mock only")).toBeInTheDocument();
  });
});
