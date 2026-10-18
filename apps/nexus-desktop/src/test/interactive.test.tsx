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
