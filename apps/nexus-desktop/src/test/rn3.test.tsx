import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { ModelPicker } from "../features/models/ModelPicker";
import {
  boundLabel,
  failedBeforeSubmissionMessage,
  hasSecretField,
  reasonWords,
  refusalMessage,
  selectionOf,
  targetLabel,
} from "../features/models/modelTargets";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi, fakeRun, REGISTRY_TARGETS } from "./fakeApi";
import type { NativeApi } from "../lib/api";
import type { RuntimeState, ThreadDetail, ThreadRunView, ThreadSummary } from "../lib/contracts";

afterEach(cleanup);

const LARGE = REGISTRY_TARGETS[0]!;
const MEDIUM = REGISTRY_TARGETS[1]!;
const T1 = "thr_" + "1".repeat(32);
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
  title: "Work on the repository",
  createdAtMs: 1_790_000_000_000,
  updatedAtMs: 1_790_000_100_000,
  archived: false,
  legacy: false,
  runCount: 1,
  messageCount: 2,
  lastPreview: "done",
  lastState: "completed",
  active: false,
  activeRunId: null,
  findingCount: 0,
  ...over,
});

function runView(over: Partial<ReturnType<typeof fakeRun>> = {}): ThreadRunView {
  return {
    runId: R("1"),
    n: 1,
    userSeq: 1,
    assistantSeq: 2,
    mode: "edit",
    readOnly: false,
    modeReason: "changes are allowed in an isolated copy",
    continuationOf: null,
    state: "completed",
    ended: true,
    startedAtMs: 1_790_000_000_000,
    endedAtMs: 1_790_000_050_000,
    digest: null,
    run: fakeRun({ runId: R("1"), intentType: "repo-code", state: "completed", terminal: true, conversationId: null, workspaceId: "east-india", threadId: T1, ...over }),
  };
}

const detail = (over: Partial<ThreadDetail> = {}, run: Partial<ReturnType<typeof fakeRun>> = {}): ThreadDetail => ({
  thread: summary(),
  messages: [
    { seq: 1, role: "user", kind: "request", runId: R("1"), atMs: 1_790_000_001_000, text: "Implement the thing", truncated: false },
    { seq: 2, role: "assistant", kind: "answer", runId: R("1"), atMs: 1_790_000_002_000, text: "Done.", truncated: false },
  ],
  runs: [runView(run)],
  findings: [],
  head: { runId: R("1"), n: 1, changedFiles: 0 },
  ...over,
});

const mount = (api: NativeApi, hash = `#/workspace/c/${T1}`) => {
  window.history.replaceState(null, "", hash);
  return render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
};

const base = (over: Partial<NativeApi> = {}) =>
  fakeApi({
    runtimeState: async () => rt(),
    intentCodeSources: async () => [{ sourceId: "east-india", label: "East India Companies", managed: true, kinds: ["dotnet"] }],
    threadList: async () => ({ threads: [summary()] }),
    threadGet: async () => detail(),
    ...over,
  });

const okReply = (i: { idempotencyKey: string }) => ({ threadId: T1, replay: false, run: fakeRun({ runId: R("2"), requestId: i.idempotencyKey, intentType: "repo-code", threadId: T1 }) });

describe("R-NATIVE-3 helpers", () => {
  it("labels targets and bound targets as provider / remote model · route", () => {
    expect(targetLabel(LARGE)).toBe("acme / acme-large-1 · acme/large");
    expect(boundLabel({ providerId: "acme", remoteModelId: "acme-large-1", logicalModelId: "acme/large", routeId: "acme/large" })).toBe("acme / acme-large-1 · route acme/large");
    expect(boundLabel(null)).toBeNull();
  });

  it("explains every machine reason the Registry catalog can produce, and shows an unknown one verbatim", () => {
    const real = [
      "connection-not-connected", "route-not-verified", "protocol-unsupported", "no-billing-tier", "no-credential-ref",
      "model-disabled", "context-unknown", "output-unknown", "no-data-use", "provider-disabled", "connection-auth-required",
      "route-unavailable", "route-model-identity-mismatch", "route-provider-mismatch", "unknown-route", "unknown-model", "unknown-provider",
    ];
    for (const r of real) {
      const w = reasonWords(r);
      expect(w, r).not.toBe(r);
      expect(w.length).toBeGreaterThan(8);
    }
    expect(reasonWords("some-new-reason")).toBe("some-new-reason");
    expect(reasonWords(null)).toBe("Not available.");
  });

  it("builds an identities-only selection from the real contract", () => {
    const sel = selectionOf(MEDIUM);
    expect(sel).toEqual({ providerId: "acme", remoteModelId: "acme-medium-1", logicalModelId: "acme/medium", routeId: "acme/medium" });
    expect(hasSecretField(sel)).toBe(false);
    expect(hasSecretField({ credentialRef: "x" })).toBe(true);
  });

  it("maps the broker's refusals to clear wording and treats an unknown code verbatim", () => {
    expect(refusalMessage("model-not-available", "the Registry does not currently issue this provider/model (model-disabled)")).toMatch(/not available.*model-disabled/);
    expect(refusalMessage("ambiguous-target", "choose one: a, b")).toMatch(/more than one target.*choose one/);
    expect(refusalMessage("model-not-allowed", "")).toBe("That model is not allowed.");
    expect(refusalMessage("project-mismatch", "belongs to another project")).toBe("belongs to another project");
  });

  it("explains a run that failed before submission because the Registry changed inside the cache window", () => {
    expect(failedBeforeSubmissionMessage("registry-selection-not-issuable", "x")).toMatch(/Registry changed.*Pick the model again/);
    expect(failedBeforeSubmissionMessage("send-uncertain", "x")).toBeNull();
    expect(failedBeforeSubmissionMessage(null, null)).toBeNull();
  });
});

describe("R-NATIVE-3 model picker", () => {
  it("offers the default first, issuable targets as choices and unavailable ones disabled with the reason in words", async () => {
    const user = userEvent.setup();
    const seen: unknown[] = [];
    render(<ModelPicker targets={REGISTRY_TARGETS} value={null} onChange={(m) => seen.push(m)} />);
    const select = screen.getByRole("combobox", { name: "Model" });
    expect(select).toHaveValue("default");
    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    expect(options[0]!.textContent).toBe("Use the default (as configured)");
    const byValue = (v: string) => options.find((o) => o.value === v)!;
    expect(byValue("acme/large").disabled).toBe(false);
    expect(byValue("acme/small").disabled).toBe(true);
    expect(byValue("acme/small").textContent).toContain("unavailable: Its route is not verified.");
    expect(byValue("beta/one").disabled).toBe(true);
    expect(byValue("beta/one").textContent).toContain("unavailable: some-new-reason");
    await user.selectOptions(select, "acme/medium");
    expect(seen).toEqual([selectionOf(MEDIUM)]);
  });

  it("is operable from the keyboard and never selects an unavailable target", async () => {
    const user = userEvent.setup();
    const seen: unknown[] = [];
    render(<ModelPicker targets={REGISTRY_TARGETS} value={null} onChange={(m) => seen.push(m)} />);
    await user.tab();
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(seen.length).toBeLessThanOrEqual(1);
    for (const s of seen) expect((s as { routeId: string }).routeId).not.toBe("acme/small");
    await user.selectOptions(screen.getByRole("combobox", { name: "Model" }), "default").catch(() => undefined);
  });

  it("announces the bound target and a switch (with the change recorded) for an existing conversation", () => {
    const bound = { providerId: "acme", remoteModelId: "acme-large-1", logicalModelId: "acme/large", routeId: "acme/large" };
    const { rerender } = render(<ModelPicker targets={REGISTRY_TARGETS} value={null} bound={bound} onChange={() => {}} />);
    expect(screen.getByText(/This conversation runs on acme \/ acme-large-1 · route acme\/large/)).toBeInTheDocument();
    expect(screen.queryByText(/will continue on/)).toBeNull();
    rerender(<ModelPicker targets={REGISTRY_TARGETS} value={selectionOf(MEDIUM)} bound={bound} onChange={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent(/will continue on acme \/ acme-medium-1 · route acme\/medium; Nexus records the change/);
    // choosing the target it already has is not a switch
    rerender(<ModelPicker targets={REGISTRY_TARGETS} value={selectionOf(LARGE)} bound={bound} onChange={() => {}} />);
    expect(screen.queryByText(/will continue on/)).toBeNull();
  });

  it("without a catalog the picker is disabled and says so (older broker or an error)", () => {
    render(<ModelPicker targets={null} value={null} onChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();
    expect(screen.getByText("Model list unavailable.")).toBeInTheDocument();
  });
});

describe("R-NATIVE-3 composer: what is actually sent", () => {
  it("the default sends NO selection: no model key at all, the same keys as before R-NATIVE-3", async () => {
    const send = vi.fn(async (i) => okReply(i));
    const user = userEvent.setup();
    mount(base({ threadSend: send as NativeApi["threadSend"] }));
    await user.type(await screen.findByLabelText("Message"), "Please continue");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const sent = send.mock.calls[0]![0];
    expect(Object.keys(sent).sort()).toEqual(["content", "idempotencyKey", "mode", "projectId", "threadId", "workspace"]);
    expect("model" in sent).toBe(false);
  });

  it("an explicit choice sends exactly the four identities, and nothing else changes", async () => {
    const send = vi.fn(async (i) => okReply(i));
    const user = userEvent.setup();
    mount(base({ threadSend: send as NativeApi["threadSend"] }));
    await user.selectOptions(await screen.findByRole("combobox", { name: "Model" }), "acme/medium");
    await user.type(screen.getByLabelText("Message"), "Use the medium model");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const sent = send.mock.calls[0]![0];
    expect(sent.model).toEqual({ providerId: "acme", remoteModelId: "acme-medium-1", logicalModelId: "acme/medium", routeId: "acme/medium" });
    expect(Object.keys(sent).sort()).toEqual(["content", "idempotencyKey", "mode", "model", "projectId", "threadId", "workspace"]);
    expect(hasSecretField(sent)).toBe(false);
  });

  it("an existing conversation shows its bound target and a switch is explicit before it is sent", async () => {
    const send = vi.fn(async (i) => okReply(i));
    const user = userEvent.setup();
    const d = detail({ thread: { ...summary(), target: { providerId: "acme", remoteModelId: "acme-large-1", logicalModelId: "acme/large", routeId: "acme/large" } } as ThreadSummary });
    mount(base({ threadGet: async () => d, threadSend: send as NativeApi["threadSend"] }));
    expect(await screen.findAllByText(/runs on acme \/ acme-large-1 · route acme\/large/i)).not.toHaveLength(0);
    await user.selectOptions(screen.getByRole("combobox", { name: "Model" }), "acme/medium");
    expect(await screen.findByText(/will continue on acme \/ acme-medium-1/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Message"), "Switch please");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0].model).toMatchObject({ routeId: "acme/medium" });
  });

  it("a refused choice keeps the user's selection and typed text visible, explains why, and falls back to nothing", async () => {
    const send = vi.fn(async () => {
      throw { code: "model-not-available", message: "the Registry does not currently issue this provider/model (model-disabled)", class: "refused", retryable: false };
    });
    const user = userEvent.setup();
    mount(base({ threadSend: send as unknown as NativeApi["threadSend"] }));
    const select = await screen.findByRole("combobox", { name: "Model" });
    await user.selectOptions(select, "acme/medium");
    await user.type(screen.getByLabelText("Message"), "try it");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/That model is not available: .*model-disabled/)).toBeInTheDocument();
    expect(select).toHaveValue("acme/medium");
    expect(screen.getByLabelText("Message")).toHaveValue("try it");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a run that failed before submission because the Registry changed asks for a new choice (no retry loop)", async () => {
    const d = detail({}, { state: "rejected", errorCode: "registry-selection-not-issuable", errorMessage: "selection is not issuable: model-disabled" });
    const send = vi.fn();
    mount(base({ threadGet: async () => d, threadSend: send as unknown as NativeApi["threadSend"] }));
    expect(await screen.findByText(/The Registry changed after the model list was read/)).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it("an older broker without the target catalog still lets the user send with the default", async () => {
    const send = vi.fn(async (i) => okReply(i));
    const user = userEvent.setup();
    mount(base({ intentTargets: async () => { throw { code: "unknown-command", message: "intent-targets", class: "refused", retryable: false }; }, threadSend: send as NativeApi["threadSend"] }));
    expect(await screen.findByRole("combobox", { name: "Model" })).toBeDisabled();
    await user.type(screen.getByLabelText("Message"), "still works");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect("model" in send.mock.calls[0]![0]).toBe(false);
  });
});

describe("R-NATIVE-3 where the model is shown", () => {
  it("each run shows the provider / model / route it used, and the conversation header its bound target", async () => {
    const d = detail(
      { thread: { ...summary(), target: { providerId: "acme", remoteModelId: "acme-medium-1", logicalModelId: "acme/medium", routeId: "acme/medium" } } as ThreadSummary },
      { providerId: "acme", remoteModelId: "acme-medium-1", routeId: "acme/medium" },
    );
    mount(base({ threadGet: async () => d }));
    const run = await screen.findByRole("region", { name: "Run 1" });
    expect(within(run).getByText(/acme \/ acme-medium-1 · route acme\/medium/)).toBeInTheDocument();
    expect(screen.getByLabelText("Conversation model")).toHaveTextContent(/Runs on acme \/ acme-medium-1 · route acme\/medium/);
  });

  it("an older payload (no target, no route fields) renders without any model line", async () => {
    mount(base());
    const run = await screen.findByRole("region", { name: "Run 1" });
    expect(within(run).queryByText(/route /)).toBeNull();
    expect(screen.queryByLabelText("Conversation model")).toBeNull();
  });
});

describe("R-NATIVE-3 Models view", () => {
  it("lists every target with its limits and status, read-only, and shows nothing secret", async () => {
    const user = userEvent.setup();
    mount(base(), "#");
    await user.click(await screen.findByRole("button", { name: /^Models/ }));
    const table = await screen.findByRole("table", { name: "Registry models" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(1 + REGISTRY_TARGETS.length);
    const large = rows.find((r) => within(r).queryByText("acme/large", { selector: ".nv-table__muted" }))!;
    expect(within(large).getByText("200000")).toBeInTheDocument();
    expect(within(large).getByText("8192")).toBeInTheDocument();
    expect(within(large).getByText("Issuable")).toBeInTheDocument();
    const small = rows.find((r) => within(r).queryByText("acme/small", { selector: ".nv-table__muted" }))!;
    expect(within(small).getByText("Unavailable")).toBeInTheDocument();
    expect(within(small).getByText(/Its route is not verified\./)).toBeInTheDocument();
    // read-only: no control inside the table, and the scroll region is keyboard-reachable
    expect(within(table).queryAllByRole("button")).toHaveLength(0);
    expect(within(table).queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.getByRole("region", { name: /Registry models/ })).toHaveAttribute("tabindex", "0");
    expect(table.textContent).not.toMatch(/credential|secret|sk-|token":/i);
    expect(hasSecretField(REGISTRY_TARGETS)).toBe(false);
  });

  it("says plainly when the catalog cannot be read", async () => {
    const user = userEvent.setup();
    mount(base({ intentTargets: async () => { throw { code: "broker-unreachable", message: "no broker", class: "unavailable", retryable: true }; } }), "#");
    await user.click(await screen.findByRole("button", { name: /^Models/ }));
    expect(await screen.findByText("Registry models unavailable")).toBeInTheDocument();
  });
});

describe("R-NATIVE-3 narrow windows and accessibility", () => {
  it("the picker stays labelled and usable in the compact layout", async () => {
    const before = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 720 });
    window.dispatchEvent(new Event("resize"));
    const send = vi.fn(async (i) => okReply(i));
    const user = userEvent.setup();
    mount(base({ threadSend: send as NativeApi["threadSend"] }));
    expect(document.querySelector(".nv-app")).toHaveAttribute("data-layout", "compact");
    const select = await screen.findByLabelText("Model");
    expect(select.tagName).toBe("SELECT");
    await user.selectOptions(select, "acme/large");
    await user.type(screen.getByLabelText("Message"), "narrow");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: before });
  });

  it("the styles let the picker wrap and the 10-column table scroll sideways instead of overflowing the window", async () => {
    // the test runner swallows CSS imports (css: false), so read the stylesheet source through Node
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync: (p: string, enc: string) => string };
    const layoutCss = fs.readFileSync("src/styles/layout.css", "utf8");
    const rule = (sel: string) => {
      const i = layoutCss.indexOf(sel + " {");
      expect(i, `${sel} has a rule`).toBeGreaterThanOrEqual(0);
      return layoutCss.slice(i, layoutCss.indexOf("}", i));
    };
    expect(rule(".nv-modelpicker")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".nv-modelpicker__select")).toMatch(/min-width:\s*0/);
    expect(rule(".nv-modelpicker__select")).toMatch(/max-width:\s*100%/);
    expect(rule(".nv-table-scroll")).toMatch(/overflow-x:\s*auto/);
    expect(rule(".nv-table--targets .nv-table__row")).toMatch(/repeat\(10,/);
  });
});
