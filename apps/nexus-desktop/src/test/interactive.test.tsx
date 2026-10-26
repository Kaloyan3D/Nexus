import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { fakeApi, fakeRun } from "./fakeApi";
import type { NativeApi } from "../lib/api";
import type { ProjectView, RuntimeState, ThreadSendInput } from "../lib/contracts";

const CONV = "model_0123456789abcdef0123456789abcdef";

const rt = (over: Partial<RuntimeState> = {}): RuntimeState => ({
  mode: "interactive",
  phase: "ready",
  message: null,
  home: "/home/u/.local/share/nexus",
  providerConnected: true,
  consent: { given: true, providerId: "opencode-go-native", remoteModelId: "muse-spark-1.3-contributor", text: "Allow Nexus to work autonomously on your projects." },
  canOpenProjects: true,
  ...over,
});

const support = (over: Partial<{ known: boolean; standingGrants: boolean; askAvailable: boolean; askReason: string | null; inPlaceAvailable: boolean; controlledAvailable: boolean; controlledReason: string | null }> = {}) => ({
  known: true, standingGrants: true, askAvailable: true, askReason: null as string | null, ...over,
});

const project = (over: Partial<ProjectView> = {}): ProjectView => ({
  projectId: "tinycsv-6c94b7",
  label: "tinycsv",
  managed: true,
  kinds: [{ id: "rust", label: "Rust (Cargo)", supported: true }],
  pinnedCommit: "6da8a77a6e300d4b04f361b42bca66c1a8d173a6",
  writeAllow: [],
  snapshotAtMs: 1_700_000_000_000,
  originDirty: false,
  changedSinceSnapshot: false,
  ...over,
});

function mount(api: NativeApi, hash = "#") {
  window.history.replaceState(null, "", hash);
  return render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
}

const sources = [{ sourceId: "tinycsv-6c94b7", label: "tinycsv", managed: true, kinds: ["rust"], pinnedCommit: "6da8a77a6e300d4b04f361b42bca66c1a8d173a6" }];
const limits = { maxTurns: 60, maxToolCalls: 300, maxToolResultBytes: 2097152, maxEdits: 60, maxTests: 40, maxOutputTokens: 16384, maxRuntimeSecs: 3600 };

describe("First-run setup (A6.1.4)", () => {
  it("walks start -> connect -> consent; each privileged step is a request for a NATIVE dialog", async () => {
    let state = rt({ phase: "starting", providerConnected: false, consent: { given: false, providerId: null, remoteModelId: null, text: null } });
    const providerConnect = vi.fn(async () => {
      state = rt({ providerConnected: true, consent: { given: false, providerId: "opencode-go-native", remoteModelId: "m", text: "t" } });
      return { verified: true, checks: [] };
    });
    const providerConsent = vi.fn(async () => {
      state = rt();
      return state.consent;
    });
    const api = fakeApi({ runtimeState: async () => state, providerConnect, providerConsent });
    const user = userEvent.setup();
    mount(api);
    expect(await screen.findByText("Starting Nexus…")).toBeInTheDocument();
    // no composer, no key field, no path field anywhere in setup
    expect(screen.queryByLabelText("Task prompt")).not.toBeInTheDocument();
    expect(document.querySelector("input[type=password], input[type=file]")).toBeNull();
    state = rt({ providerConnected: false, consent: { given: false, providerId: null, remoteModelId: null, text: null } });
    const connect = await screen.findByRole("button", { name: /Connect…/ }, { timeout: 5000 });
    await user.click(connect);
    expect(providerConnect).toHaveBeenCalledTimes(1);
    expect(providerConnect.mock.calls[0]).toHaveLength(0); // nothing from the page goes along
    const allow = await screen.findByRole("button", { name: /Review and allow…/ }, { timeout: 5000 });
    await user.click(allow);
    expect(providerConsent).toHaveBeenCalledTimes(1);
    expect(await screen.findByLabelText("Task prompt", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("a startup failure is explained and retryable; a dismissed dialog is not an error", async () => {
    const runtimeStart = vi.fn(async () => undefined);
    const api = fakeApi({
      runtimeState: async () => rt({ phase: "error", message: "the Kernel daemon did not become ready" }),
      runtimeStart,
      providerConnect: async () => {
        throw { code: "cancelled", message: "cancelled", class: "refused", retryable: false };
      },
    });
    const user = userEvent.setup();
    mount(api);
    expect(await screen.findByText(/the Kernel daemon did not become ready/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(runtimeStart).toHaveBeenCalled();
    cleanup();
    const api2 = fakeApi({
      runtimeState: async () => rt({ providerConnected: false }),
      providerConnect: async () => {
        throw { code: "cancelled", message: "cancelled", class: "refused", retryable: false };
      },
    });
    mount(api2);
    await userEvent.setup().click(await screen.findByRole("button", { name: /Connect…/ }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("That did not finish")).not.toBeInTheDocument();
  });
});

describe("Run on a project without ceremony (A6.1.4)", () => {
  function api(over: Partial<NativeApi> = {}) {
    return fakeApi({
      runtimeState: async () => rt(),
      intentCodeSources: async () => sources,
      intentCodeLimits: async () => limits,
      projectList: async () => ({ projects: [project()] }),
      ...over,
    });
  }

  it("defaults to the project, needs no acknowledgement, hash or limit choice, and Run submits text + identity only", async () => {
    const submit = vi.fn(async (i: ThreadSendInput) => ({ threadId: "thr_" + "a".repeat(32), replay: false, run: fakeRun({ requestId: i.idempotencyKey, conversationId: CONV, state: "executing", intentType: "repo-code", workspaceId: "tinycsv-6c94b7" }) }));
    const user = userEvent.setup();
    mount(api({ threadSend: submit as NativeApi["threadSend"] }));
    const run = await screen.findByRole("button", { name: "Run" });
    expect(screen.getByRole("radio", { name: "Work on project" })).toBeChecked();
    expect(screen.queryByRole("radio", { name: "Inspect" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Acknowledge disclosure")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Prompt fingerprint")).not.toBeInTheDocument();
    expect(screen.queryByText(/sha256/i)).not.toBeInTheDocument();
    expect(run).toBeDisabled(); // nothing typed
    await user.type(screen.getByLabelText("Task prompt"), "fix the failing tests");
    await waitFor(() => expect(run).toBeEnabled());
    const terms = screen.getByLabelText("Autonomous run");
    expect(within(terms).getByText(/isolated copy/)).toBeInTheDocument();
    expect(within(terms).getByText(/60 model turns, 60 edits and 40 test runs/)).toBeInTheDocument();
    await user.click(run);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const sent = submit.mock.calls[0]![0];
    expect(sent.content).toBe("fix the failing tests");
    expect(sent.projectId).toBe("tinycsv-6c94b7");
    expect(sent.threadId).toBeNull(); // a task from the idle view starts a NEW conversation
    // text, identity, mode choice and an idempotency key - no limit, path, tool or approval
    expect(Object.keys(sent).sort()).toEqual(["content", "idempotencyKey", "mode", "projectId", "threadId", "workspace"]);
  });

  it("Open… asks the native backend to pick a folder (no path can be typed) and the project becomes selectable", async () => {
    const projectPick = vi.fn(async () => ({ project: project(), created: true, snapshot: { files: 11, bytes: 4086, skippedTotal: 0, skipped: [] } }));
    const user = userEvent.setup();
    mount(api({ intentCodeSources: async () => [], projectPick }));
    await user.click(await screen.findByRole("button", { name: "Open project" }));
    expect(projectPick).toHaveBeenCalledTimes(1);
    expect(projectPick.mock.calls[0]).toHaveLength(0);
    expect(document.querySelector("input[type=file]")).toBeNull();
  });

  it("Run stays disabled without consent, with the reason shown", async () => {
    const user = userEvent.setup();
    mount(api({ runtimeState: async () => rt({ consent: { given: false, providerId: null, remoteModelId: null, text: null } }) }), "#/workspace");
    // the gate shows setup instead of a composer when consent is missing
    expect(await screen.findByRole("button", { name: /Review and allow…/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
    void user;
  });
});

describe("Projects page and evidence (A6.1.4)", () => {
  it("lists opened projects with their type and support, and offers refresh / remove through the backend", async () => {
    const refresh = vi.fn(async () => ({ project: project(), created: false, snapshot: { files: 1, bytes: 1, skippedTotal: 0, skipped: [] } }));
    const forget = vi.fn(async () => ({ forgotten: "tinycsv-6c94b7" }));
    const list = vi.fn(async () => ({
      projects: [project({ changedSinceSnapshot: true }), project({ projectId: "svc-aaaaaa", label: "svc", kinds: [{ id: "go", label: "Go", supported: false }] })],
    }));
    const user = userEvent.setup();
    mount(fakeApi({ runtimeState: async () => rt(), projectList: list, projectRefresh: refresh, projectForget: forget }), "#/projects");
    const table = await screen.findByRole("table", { name: "Opened projects" });
    expect(within(table).getByText("Rust (Cargo)")).toBeInTheDocument();
    expect(within(table).getByText(/Go · edit only/)).toBeInTheDocument();
    expect(within(table).getByText(/folder changed since/)).toBeInTheDocument();
    await user.click(within(table).getByRole("button", { name: "Refresh tinycsv" }));
    expect(refresh).toHaveBeenCalledWith("tinycsv-6c94b7");
    await user.click(within(table).getByRole("button", { name: "Remove tinycsv" }));
    expect(forget).toHaveBeenCalledWith("tinycsv-6c94b7");
    // the page carries no path field and no approve control
    expect(document.querySelector("input[type=file], input[type=text]")).toBeNull();
  });

  it("each project shows where its tasks edit and changes it through the backend (direct needs the native confirmation there)", async () => {
    const setWs = vi.fn(async () => ({}));
    const list = vi.fn(async () => ({
      projects: [project({ workspaceMode: "direct" }), project({ projectId: "svc-aaaaaa", label: "svc", workspaceMode: "isolated" })],
    }));
    const user = userEvent.setup();
    mount(fakeApi({ runtimeState: async () => rt(), projectList: list, projectSetEditMode: setWs }), "#/projects");
    const table = await screen.findByRole("table", { name: "Opened projects" });
    const direct = within(table).getByRole("combobox", { name: "Workspace for tinycsv" }) as HTMLSelectElement;
    const iso = within(table).getByRole("combobox", { name: "Workspace for svc" }) as HTMLSelectElement;
    expect(direct.value).toBe("direct");
    expect(iso.value).toBe("isolated");
    expect(within(table).getByText("edits your files")).toBeInTheDocument();
    // "apply automatically" belongs to isolated copies only
    expect(within(table).queryByLabelText("Apply finished work to tinycsv automatically")).not.toBeInTheDocument();
    expect(within(table).getByLabelText("Apply finished work to svc automatically")).toBeInTheDocument();
    await user.selectOptions(iso, "direct");
    expect(setWs).toHaveBeenCalledWith("svc-aaaaaa", "direct");
    await user.selectOptions(direct, "isolated");
    expect(setWs).toHaveBeenCalledWith("tinycsv-6c94b7", "isolated");
  });

  it("permissions show the project's standing grant and send only the user's choices (the native backend confirms)", async () => {
    const setGrant = vi.fn(async () => ({}));
    const endGrant = vi.fn(async () => ({}));
    const grant = {
      grantId: "grt_aaaaaaaaaaaaaaaa", version: 2, digest: "d".repeat(64), fs: "workspace" as const, net: "install" as const,
      approval: "auto" as const, expiresAtMs: Date.now() + 86_400_000, createdAtMs: 1, createdBy: "desktop:uid:1000",
      status: "active" as const, revokedAtMs: null, history: [],
    };
    const list = vi.fn(async () => ({
      projects: [project({ grant }), project({ projectId: "svc-aaaaaa", label: "svc", workspaceMode: "isolated" }), project({ projectId: "old-bbbbbb", label: "old", workspaceMode: "isolated", grant: { ...grant, status: "revoked" as const, revokedAtMs: 5 } })],
      permissions: support(),
    }));
    const user = userEvent.setup();
    mount(fakeApi({ runtimeState: async () => rt(), projectList: list, projectSetPermissions: setGrant, projectEndPermissions: endGrant }), "#/projects");
    const table = await screen.findByRole("table", { name: "Opened projects" });
    expect(within(table).getByText("In-place commands · installs online · automatic")).toBeInTheDocument();
    expect(within(table).getByText("Default permissions")).toBeInTheDocument();
    expect(within(table).getByText(/revoked$/)).toBeInTheDocument();
    // a project without a grant: choose and apply; only the three choices and a lifetime are sent
    await user.click(within(table).getByRole("button", { name: "Permissions for svc" }));
    const grp = within(table).getByRole("group", { name: "Permissions for svc" });
    await user.selectOptions(within(grp).getByLabelText("Command filesystem scope for svc"), "workspace");
    await user.selectOptions(within(grp).getByLabelText("Approval behaviour for svc"), "ask");
    await user.selectOptions(within(grp).getByLabelText("Lifetime of the permissions for svc"), "2");
    await user.click(within(grp).getByRole("button", { name: "Apply…" }));
    expect(setGrant).toHaveBeenCalledWith("svc-aaaaaa", { fs: "workspace", net: "offline", approval: "ask", expiresInSecs: 7 * 86_400 });
    // revoke / return to defaults go through the backend too
    await user.click(within(table).getByRole("button", { name: "Permissions for tinycsv" }));
    const g2 = within(table).getByRole("group", { name: "Permissions for tinycsv" });
    await user.click(within(g2).getByRole("button", { name: "Revoke" }));
    expect(endGrant).toHaveBeenCalledWith("tinycsv-6c94b7", false);
    await user.click(within(g2).getByRole("button", { name: "Use defaults" }));
    expect(endGrant).toHaveBeenCalledWith("tinycsv-6c94b7", true);
    // the page has no confirmation, digest or consent control of its own
    expect(document.querySelector("input[type=text], input[type=password]")).toBeNull();
  });

  it("'Ask me first' is disabled, with the reason, when this installation has no approver channel - before anything is granted", async () => {
    const setPerm = vi.fn(async () => ({}));
    const list = vi.fn(async () => ({
      projects: [project()],
      permissions: support({ askAvailable: false, askReason: "this installation has no approver channel to answer a request" }),
    }));
    const user = userEvent.setup();
    mount(fakeApi({ runtimeState: async () => rt(), projectList: list, projectSetPermissions: setPerm }), "#/projects");
    const table = await screen.findByRole("table", { name: "Opened projects" });
    await user.click(within(table).getByRole("button", { name: "Permissions for tinycsv" }));
    const ask = within(table).getByRole("option", { name: /Asks me first/ }) as HTMLOptionElement;
    expect(ask.disabled).toBe(true);
    expect(within(table).getByRole("note", { name: "Why Ask is unavailable for tinycsv" })).toHaveTextContent(/approver channel/);
    // the other choices still work
    await user.click(within(table).getByRole("button", { name: "Apply…" }));
    expect(setPerm).toHaveBeenCalledWith("tinycsv-6c94b7", expect.objectContaining({ approval: "auto" }));
  });

  it("'Ask me first' is offered when the runtime has an approver channel", async () => {
    const setPerm = vi.fn(async () => ({}));
    const list = vi.fn(async () => ({ projects: [project()], permissions: support() }));
    const user = userEvent.setup();
    mount(fakeApi({ runtimeState: async () => rt(), projectList: list, projectSetPermissions: setPerm }), "#/projects");
    const table = await screen.findByRole("table", { name: "Opened projects" });
    await user.click(within(table).getByRole("button", { name: "Permissions for tinycsv" }));
    expect((within(table).getByRole("option", { name: /Asks me first/ }) as HTMLOptionElement).disabled).toBe(false);
    expect(within(table).queryByRole("note", { name: /Why Ask is unavailable/ })).not.toBeInTheDocument();
    await user.selectOptions(within(table).getByLabelText("Approval behaviour for tinycsv"), "ask");
    await user.click(within(table).getByRole("button", { name: "Apply…" }));
    expect(setPerm).toHaveBeenCalledWith("tinycsv-6c94b7", expect.objectContaining({ approval: "ask" }));
  });

  it("Controlled Internet sends the owner's destinations only, says it limits where not what, and is disabled with a reason when the gatekeeper is missing", async () => {
    const setPerm = vi.fn(async () => ({}));
    const list = vi.fn(async () => ({ projects: [project({ workspaceMode: "direct" })], permissions: support({ inPlaceAvailable: true, controlledAvailable: true }) }));
    const user = userEvent.setup();
    mount(fakeApi({ runtimeState: async () => rt(), projectList: list, projectSetPermissions: setPerm }), "#/projects");
    const table = await screen.findByRole("table", { name: "Opened projects" });
    await user.click(within(table).getByRole("button", { name: "Permissions for tinycsv" }));
    await user.selectOptions(within(table).getByLabelText("Command filesystem scope for tinycsv"), "workspace");
    await user.selectOptions(within(table).getByLabelText("Network scope for tinycsv"), "controlled");
    expect(within(table).getByText(/limits WHERE they connect, not WHAT they send/)).toBeInTheDocument();
    await user.click(within(table).getByLabelText("Allow the npm preset for tinycsv"));
    await user.type(within(table).getByLabelText("Allowed hosts for tinycsv"), "api.example.org:443");
    await user.type(within(table).getByLabelText("Allowed local ports for tinycsv"), "5432 8080");
    await user.click(within(table).getByRole("button", { name: "Apply…" }));
    expect(setPerm).toHaveBeenCalledWith("tinycsv-6c94b7", expect.objectContaining({ fs: "workspace", net: "controlled", netPresets: ["npm"], allowHosts: ["api.example.org:443"], allowLocalPorts: [5432, 8080] }));
  });

  it("Controlled Internet is not offered when this machine has no network gatekeeper", async () => {
    const list = vi.fn(async () => ({ projects: [project()], permissions: support({ inPlaceAvailable: true, controlledAvailable: false, controlledReason: "the network gatekeeper `nexus-egress` was not found next to nexusd" }) }));
    const user = userEvent.setup();
    mount(fakeApi({ runtimeState: async () => rt(), projectList: list }), "#/projects");
    const table = await screen.findByRole("table", { name: "Opened projects" });
    await user.click(within(table).getByRole("button", { name: "Permissions for tinycsv" }));
    const opt = within(table).getByRole("option", { name: /Only the internet destinations I list/ }) as HTMLOptionElement;
    expect(opt.disabled).toBe(true);
    expect(opt.textContent).toMatch(/nexus-egress/);
  });

  it("nothing can be applied while the runtime cannot say what it supports", async () => {
    const setPerm = vi.fn(async () => ({}));
    const list = vi.fn(async () => ({ projects: [project()], permissions: support({ known: false, standingGrants: false, askAvailable: false, askReason: "the Nexus runtime could not be asked just now" }) }));
    const user = userEvent.setup();
    mount(fakeApi({ runtimeState: async () => rt(), projectList: list, projectSetPermissions: setPerm }), "#/projects");
    const table = await screen.findByRole("table", { name: "Opened projects" });
    await user.click(within(table).getByRole("button", { name: "Permissions for tinycsv" }));
    expect(within(table).getByRole("button", { name: "Apply…" })).toBeDisabled();
    expect(within(table).getByRole("note", { name: /Why Ask is unavailable/ })).toHaveTextContent(/could not be asked just now/);
  });

  it("the installs setting says which control governs it: the old checkbox without permissions, the Network setting with them", async () => {
    const grant = { grantId: "grt_a", version: 1, digest: "d".repeat(64), fs: "scratch" as const, net: "install" as const, approval: "auto" as const, expiresAtMs: null, createdAtMs: 1, createdBy: "cli:uid:1", status: "active" as const, revokedAtMs: null, history: [] };
    const list = vi.fn(async () => ({
      projects: [
        project({ projectId: "legacy-a", label: "legacy", installs: true }),
        project({ projectId: "on-b", label: "withnet", grant }),
        project({ projectId: "off-c", label: "offline", grant: { ...grant, net: "offline" as const } }),
        project({ projectId: "rev-d", label: "revoked", grant: { ...grant, status: "revoked" as const, revokedAtMs: 3 } }),
      ],
      permissions: support(),
    }));
    const setPolicy = vi.fn(async () => ({}));
    mount(fakeApi({ runtimeState: async () => rt(), projectList: list, projectSetPolicy: setPolicy }), "#/projects");
    const table = await screen.findByRole("table", { name: "Opened projects" });
    // legacy: the checkbox, unchanged
    expect(within(table).getByLabelText("Allow dependency installs for legacy")).toBeChecked();
    // with permissions: no checkbox, the sentence names the controlling setting
    for (const name of ["withnet", "offline", "revoked"]) {
      expect(within(table).queryByLabelText(`Allow dependency installs for ${name}`)).not.toBeInTheDocument();
    }
    expect(within(table).getByText("installs: allowed by Permissions")).toBeInTheDocument();
    expect(within(table).getByText("installs: not allowed by Permissions")).toBeInTheDocument();
    expect(within(table).getByText("installs: stopped (permissions revoked)")).toBeInTheDocument();
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it("a project that edits its real folder can choose in-place commands, labelled as changing the real files", async () => {
    const list = vi.fn(async () => ({ projects: [project({ workspaceMode: "direct" })], permissions: { ...support(), inPlaceAvailable: true, inPlaceReason: null } }));
    const user = userEvent.setup();
    mount(fakeApi({ runtimeState: async () => rt(), projectList: list }), "#/projects");
    const table = await screen.findByRole("table", { name: "Opened projects" });
    await user.click(within(table).getByRole("button", { name: "Permissions for tinycsv" }));
    const opt = within(table).getByRole("option", { name: /Commands change my real project files directly/ }) as HTMLOptionElement;
    expect(opt.disabled).toBe(false);
  });

  it("in-place commands are not offered when this machine cannot confine them, and the reason is shown", async () => {
    const list = vi.fn(async () => ({
      projects: [project({ workspaceMode: "direct" })],
      permissions: { ...support(), inPlaceAvailable: false, inPlaceReason: "the launch gate `nexus-confine` was not found next to nexusd; reinstall Nexus" },
    }));
    const user = userEvent.setup();
    mount(fakeApi({ runtimeState: async () => rt(), projectList: list }), "#/projects");
    const table = await screen.findByRole("table", { name: "Opened projects" });
    await user.click(within(table).getByRole("button", { name: "Permissions for tinycsv" }));
    const opt = within(table).getByRole("option", { name: /Commands change my real project files directly/ }) as HTMLOptionElement;
    expect(opt.disabled).toBe(true);
    expect(opt.textContent).toMatch(/nexus-confine/);
  });

  it("a policy grant is labelled as automated, never as an approval by a person", async () => {
    const run = fakeRun({
      intentType: "repo-code", conversationId: CONV, state: "completed", terminal: true, workspaceId: "tinycsv-6c94b7",
      codingOutcome: { change: "applied", verification: "verified-passed", editsApplied: 1, editsNotApplied: 0, testsExecuted: 1, testsNotExecuted: 0, blockedByApproval: 0, lastExitCode: 0, staleAfterEdit: false, uncertainOperations: 0 },
      toolActivity: [{ index: 1, turn: 1, callId: "c", tool: "fs_edit", argsSummary: "edit src/lib.rs", status: "executed", errorCode: null, resultBytes: 1, resultDigest: "a".repeat(64), truncated: false, executionId: "e", journalSeq: 1, argsDigest: "b".repeat(64), approvalId: "a1b2c3d4e5f6a7b8", approvalOutcome: "approved", approvalActor: "automated-policy" }],
    });
    const user = userEvent.setup();
    mount(
      fakeApi({
        runtimeState: async () => rt(),
        listModelConversations: async () => [{ conversationId: CONV, firstPrompt: "fix", startedAtMs: 1, state: "completed", terminal: true, providerId: "p", remoteModelId: "m", endpointKind: "provider" }],
        intentList: async () => [run],
        intentStatus: async () => run,
      }),
      `#/workspace/run/${CONV}`,
    );
    await user.click(await screen.findByRole("button", { name: "Execution evidence" }));
    const panel = await screen.findByRole("dialog", { name: "Evidence panel" });
    expect(within(panel).getByText(/automated workspace policy \(not a person\)/)).toBeInTheDocument();
    expect(within(panel).queryByText(/approved by you|human/i)).not.toBeInTheDocument();
  });
});

describe("Adopting a patch (A6.1.4)", () => {
  const done = fakeRun({
    intentType: "repo-code", conversationId: CONV, state: "completed", terminal: true, workspaceId: "tinycsv-6c94b7",
    changedFiles: [{ path: "src/lib.rs", status: "modified", additions: 1, deletions: 1 }],
    codingOutcome: { change: "applied", verification: "verified-passed", editsApplied: 1, editsNotApplied: 0, testsExecuted: 1, testsNotExecuted: 0, blockedByApproval: 0, lastExitCode: 0, staleAfterEdit: false, uncertainOperations: 0 },
  });
  const base = (over: Partial<NativeApi> = {}) =>
    fakeApi({
      runtimeState: async () => rt(),
      projectList: async () => ({ projects: [project()] }),
      listModelConversations: async () => [{ conversationId: CONV, firstPrompt: "fix", startedAtMs: 1, state: "completed", terminal: true, providerId: "p", remoteModelId: "m", endpointKind: "provider" }],
      intentList: async () => [done],
      intentStatus: async () => done,
      ...over,
    });

  it("applying is an explicit action the backend confirms natively; the result says nothing was committed", async () => {
    const adopt = vi.fn(async () => ({ applied: ["src/lib.rs"] }));
    const user = userEvent.setup();
    mount(base({ projectAdopt: adopt }), `#/workspace/run/${CONV}`);
    const btn = await screen.findByRole("button", { name: /Apply to my folder…/ });
    expect(adopt).not.toHaveBeenCalled();
    await user.click(btn);
    expect(adopt).toHaveBeenCalledWith(done.runId);
    expect(await screen.findByText(/Applied 1 file to your folder. Nothing was committed./)).toBeInTheDocument();
  });

  it("a refused or cancelled apply keeps the button and explains refusals; strict-profile runs have no such button", async () => {
    const user = userEvent.setup();
    mount(base({ projectAdopt: async () => { throw { code: "adopt", message: "the folder changed since Nexus copied it", class: "refused", retryable: false }; } }), `#/workspace/run/${CONV}`);
    await user.click(await screen.findByRole("button", { name: /Apply to my folder…/ }));
    expect(await screen.findByText(/the folder changed since Nexus copied it/)).toBeInTheDocument();
    cleanup();
    mount(base({ runtimeState: async () => rt({ mode: "external" }) }), `#/workspace/run/${CONV}`);
    await screen.findByRole("button", { name: "View diff" });
    expect(screen.queryByRole("button", { name: /Apply to my folder/ })).not.toBeInTheDocument();
  });
});

describe("Task-oriented result (autonomy-first)", () => {
  it("leads a read-only review with the report itself, from the broker's recorded result, and says what it recovered from", async () => {
    const summary = {
      conversationId: CONV,
      firstPrompt: "Audit this repository",
      startedAtMs: 1_790_000_000_000,
      state: "completed",
      terminal: true,
      providerId: "opencode-go-native",
      remoteModelId: "muse-spark-1.3-contributor",
      endpointKind: "provider",
    };
    const reads = [1, 2, 3].map((i) => ({
      index: i, turn: i, callId: `c${i}`, tool: "fs_read", argsSummary: `path=src/f${i}.ts start=1 max=100`, status: "executed", errorCode: null,
      resultBytes: 100, resultDigest: "a".repeat(64), truncated: false, executionId: `e${i}`, journalSeq: i, argsDigest: "b".repeat(64),
    }));
    const run = fakeRun({
      intentType: "repo-code", conversationId: CONV, state: "completed", terminal: true, workspaceId: "tinycsv-6c94b7",
      toolActivity: reads as never, recoveries: 2, lastRecovery: "send-uncertain: lost",
    });
    const report = "## 1. Architecture\n\n| Layer | Job |\n|---|---|\n| UI | shell |\n\n- finding one in `src/f1.ts:12`";
    const api = fakeApi({
      runtimeState: async () => rt(),
      listModelConversations: async () => [summary],
      modelRunStatus: async () => ({ conversationId: CONV, state: "completed", terminal: true, providerId: "p", remoteModelId: "m", logicalModelId: "l", endpointKind: "provider", attemptId: "a", commandId: "c", requestDigest: "d".repeat(64), httpStatus: 200, usageInputTokens: 1, usageOutputTokens: 1, finishReason: "stop", latencyMs: 1, errorCode: null, cancelRequested: false, text: "" }) as never,
      conversationRead: async () => ({ events: [], nextSeq: 0, truncated: false, terminal: true }) as never,
      intentList: async () => [run],
      intentResult: async () => report,
    });
    mount(api, `#/workspace/run/${CONV}`);
    const region = await screen.findByRole("region", { name: "Review report" });
    expect(within(region).getByText(/3 files read/)).toBeInTheDocument();
    expect(await within(region).findByRole("heading", { name: /1\. Architecture/ })).toBeInTheDocument();
    expect(within(region).getByRole("cell", { name: "shell" })).toBeInTheDocument();
    expect(within(region).getByText(/Recovered from 2 interruptions/)).toBeInTheDocument();
    // no approval vocabulary, no "claim, not verified" framing
    expect(screen.queryByText(/not verified/)).not.toBeInTheDocument();
  }, 20000);
});
