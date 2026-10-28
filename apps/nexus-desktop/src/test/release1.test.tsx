import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { NexusProvider } from "../state/NexusContext";
import { environmentFindings } from "../features/setup/EnvironmentNotes";
import { fakeApi, fakeRun } from "./fakeApi";
import type { NativeApi } from "../lib/api";
import type { EnvCheck, ExecEffects, JobView, ProjectView, RestorePreview, RuntimeState, ThreadDetail, ThreadMessage, ThreadRunView, ThreadSummary, ToolActivity } from "../lib/contracts";

// Release 1 UI contracts. The native layer is a fake: what these tests state is what the PAGE asks for, what
// it shows, and that it never offers a way to name a path, an address, a digest it did not receive, or to
// answer a permission request on the model's behalf. GUI-level validation of the real dialogs is separate.

const T1 = "thr_" + "1".repeat(32);
const R = (c: string) => "run_" + c.repeat(32);
const PID = "site-6c94b7";

const rt = (): RuntimeState => ({
  mode: "interactive", phase: "ready", message: null, home: "/home/u/.local/share/nexus", providerConnected: true,
  consent: { given: true, providerId: "opencode-go-native", remoteModelId: "m", text: "Allow." }, canOpenProjects: true,
});

const grant = (over: Partial<NonNullable<ProjectView["grant"]>> = {}): NonNullable<ProjectView["grant"]> => ({
  grantId: "g", version: 1, digest: "d".repeat(64), fs: "workspace", net: "offline", approval: "auto", expiresAtMs: null, createdAtMs: 1,
  createdBy: "desktop", status: "active", revokedAtMs: null, history: [], ...over,
});
const project = (over: Partial<ProjectView> = {}): ProjectView => ({
  projectId: PID, label: "site", managed: true, kinds: [{ id: "node", label: "Node.js", supported: true }], pinnedCommit: "", writeAllow: [],
  snapshotAtMs: 1_700_000_000_000, originDirty: false, changedSinceSnapshot: false, ...over,
});
const support = (over: Record<string, unknown> = {}) => ({ known: true, standingGrants: true, askAvailable: false, askReason: "no approver", inPlaceAvailable: true, ...over });

function mount(api: NativeApi, hash = "#") {
  window.history.replaceState(null, "", hash);
  return render(
    <NexusProvider api={api}>
      <App />
    </NexusProvider>,
  );
}

const baseApi = (over: Partial<NativeApi> = {}) =>
  fakeApi({
    runtimeState: async () => rt(),
    intentCodeSources: async () => [{ sourceId: PID, label: "site", managed: true, kinds: ["node"] }],
    projectList: async () => ({ projects: [project({ workspaceMode: "direct" })], permissions: support() }),
    ...over,
  });

const declined = { code: "cancelled", message: "cancelled", class: "refused", retryable: false };

async function projectArticle(name = "site") {
  const region = await screen.findByRole("region", { name: "Opened projects" });
  return within(within(region).getByRole("article", { name: `Project ${name}` }));
}

describe("Project access in plain words (Projects page)", () => {
  it("Allow… on 'Run commands' asks the native layer to work in the project - and sends nothing else", async () => {
    const allowWork = vi.fn(async () => ({}));
    const user = userEvent.setup();
    mount(baseApi({ projectAllowWork: allowWork }), "#/projects");
    const p = await projectArticle();
    expect(p.getByText("temporary copy")).toBeInTheDocument();
    await user.click(p.getByRole("button", { name: "Allow Nexus to edit and run commands in site" }));
    expect(allowWork).toHaveBeenCalledTimes(1);
    expect(allowWork.mock.calls[0]).toEqual([PID]);
  });

  it("declining the system dialog is silent; a real refusal is explained without internal prefixes", async () => {
    const user = userEvent.setup();
    const allowWork = vi.fn().mockRejectedValueOnce(declined).mockRejectedValueOnce({ code: "project", message: "not-available: this folder is on a different device", class: "refused", retryable: false });
    mount(baseApi({ projectAllowWork: allowWork as NativeApi["projectAllowWork"] }), "#/projects");
    const p = await projectArticle();
    await user.click(p.getByRole("button", { name: /Allow Nexus to edit and run commands/ }));
    await waitFor(() => expect(allowWork).toHaveBeenCalledTimes(1));
    expect(p.queryByText("That did not change anything")).not.toBeInTheDocument();
    await user.click(p.getByRole("button", { name: /Allow Nexus to edit and run commands/ }));
    expect(await p.findByText(/this folder is on a different device/)).toBeInTheDocument();
    expect(p.queryByText(/not-available:/)).not.toBeInTheDocument();
  });

  it("local previews: pick or type development ports, review, and only those ports are sent", async () => {
    const allowPreviews = vi.fn(async () => ({}));
    const user = userEvent.setup();
    mount(baseApi({
      projectAllowPreviews: allowPreviews,
      projectList: async () => ({ projects: [project({ workspaceMode: "direct", grant: grant({ devPorts: [3000] }) })], permissions: support() }),
    }), "#/projects");
    const p = await projectArticle();
    expect(p.getByText("port 3000")).toBeInTheDocument();
    await user.click(p.getByRole("button", { name: "Allow local previews for site" }));
    const group = within(p.getByRole("group", { name: "Preview ports for site" }));
    // a port that is already allowed is not offered again
    expect(group.queryByLabelText("Allow previews on port 3000")).not.toBeInTheDocument();
    await user.click(group.getByLabelText("Allow previews on port 5173"));
    await user.type(group.getByLabelText("Another preview port"), "80");
    expect(group.getByRole("alert")).toHaveTextContent(/Not a usable port: 80/);
    expect(group.getByRole("button", { name: "Review and allow…" })).toBeDisabled();
    await user.clear(group.getByLabelText("Another preview port"));
    await user.type(group.getByLabelText("Another preview port"), "5000");
    await user.click(group.getByRole("button", { name: "Review and allow…" }));
    expect(allowPreviews).toHaveBeenCalledTimes(1);
    const [id, ports] = allowPreviews.mock.calls[0] as unknown as [string, number[]];
    expect(id).toBe(PID);
    expect([...ports].sort()).toEqual([5000, 5173]);
  });

  it("previews can be stopped, and are not offered until commands run in the project", async () => {
    const revoke = vi.fn(async () => ({}));
    const user = userEvent.setup();
    mount(baseApi({
      projectRevokePreviews: revoke,
      projectList: async () => ({ projects: [project({ workspaceMode: "direct", grant: grant({ devPorts: [5173] }) }), project({ projectId: "b", label: "other" })], permissions: support() }),
    }), "#/projects");
    const p = await projectArticle();
    await user.click(p.getByRole("button", { name: "Stop allowing previews for site" }));
    expect(revoke).toHaveBeenCalledWith(PID);
    const o = await projectArticle("other");
    expect(o.queryByRole("button", { name: "Allow local previews for other" })).not.toBeInTheDocument();
    expect(o.getByText(/Needs Nexus to run commands in the project folder first/)).toBeInTheDocument();
  });

  it("when this computer cannot confine commands, the choice is disabled with the reason and previews are not promised", async () => {
    mount(baseApi({ projectList: async () => ({ projects: [project({ workspaceMode: "direct" })], permissions: support({ inPlaceAvailable: false, inPlaceReason: "this kernel has no Landlock" }) }) }), "#/projects");
    const p = await projectArticle();
    expect(p.getByRole("button", { name: /Allow Nexus to edit and run commands/ })).toBeDisabled();
    expect(p.getByText(/Not available on this computer: this kernel has no Landlock/)).toBeInTheDocument();
  });

  it("dependency downloads in a folder Nexus edits directly first get the permissions they need, then the network", async () => {
    const order: string[] = [];
    const allowWork = vi.fn(async () => void order.push("work"));
    const allowInstalls = vi.fn(async () => void order.push("installs"));
    const user = userEvent.setup();
    mount(baseApi({ projectAllowWork: allowWork, projectAllowInstalls: allowInstalls }), "#/projects");
    const p = await projectArticle();
    await user.click(p.getByRole("button", { name: "Allow dependency downloads for site" }));
    await waitFor(() => expect(order).toEqual(["work", "installs"]));
    expect(allowInstalls).toHaveBeenCalledWith(PID, true);
  });

  it("if the first confirmation is declined, the second is never asked", async () => {
    const allowInstalls = vi.fn(async () => ({}));
    const user = userEvent.setup();
    mount(baseApi({ projectAllowWork: async () => { throw declined; }, projectAllowInstalls: allowInstalls }), "#/projects");
    const p = await projectArticle();
    await user.click(p.getByRole("button", { name: "Allow dependency downloads for site" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(allowInstalls).not.toHaveBeenCalled();
  });

  it("everything granular sits under one Advanced disclosure, and Full Access is flagged where it is on", async () => {
    mount(baseApi({ projectList: async () => ({ projects: [project({ workspaceMode: "direct", grant: grant({ fs: "full", net: "full" }) })], permissions: support({ hostExecAvailable: true }) }) }), "#/projects");
    const p = await projectArticle();
    expect(p.getByText("This project has Full Access")).toBeInTheDocument();
    const adv = p.getByLabelText("Advanced settings for site");
    expect(adv.tagName).toBe("DETAILS");
    expect(within(adv).getByRole("button", { name: "Permissions for site" })).toBeInTheDocument();
  });
});

// ---- permission requests at the moment they matter ---------------------------------------------------------

const act = (over: Partial<ToolActivity>): ToolActivity => ({
  index: 1, turn: 1, callId: "c", tool: "job_start", argsSummary: "", status: "refused", errorCode: null, resultBytes: 0, resultDigest: null,
  truncated: false, executionId: null, journalSeq: null, argsDigest: null, ...over,
});
const thread = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  threadId: T1, projectId: PID, title: "Build the site", createdAtMs: 1_790_000_000_000, updatedAtMs: 1_790_000_100_000, archived: false, legacy: false,
  runCount: 1, messageCount: 2, lastPreview: "", lastState: "completed", active: false, activeRunId: null, findingCount: 0, ...over,
});
const m = (seq: number, role: ThreadMessage["role"], kind: string, text: string): ThreadMessage => ({ seq, role, kind, runId: R("1"), atMs: 1_790_000_000_000 + seq, text, truncated: false });
function detailWith(acts: ToolActivity[], run: Record<string, unknown> = {}, tr: Partial<ThreadSummary> = {}): ThreadDetail {
  const rv: ThreadRunView = {
    runId: R("1"), n: 1, userSeq: 1, assistantSeq: 2, mode: "edit", readOnly: false, modeReason: "", continuationOf: null, state: "completed", ended: true,
    startedAtMs: 1_790_000_000_000, endedAtMs: 1_790_000_050_000, digest: null,
    run: fakeRun({ runId: R("1"), intentType: "repo-code", state: "completed", terminal: true, conversationId: null, workspaceId: PID, threadId: T1, toolActivity: acts, ...run }),
  };
  return { thread: thread(tr), messages: [m(1, "user", "request", "Build me a website and preview it"), m(2, "assistant", "answer", "I could not start the preview.")], runs: [rv], findings: [], head: { runId: R("1"), n: 1, changedFiles: 0 } };
}
const refusedPort = act({ errorCode: "dev-port-not-authorized", requestedPorts: [5173], argsSummary: "npm run dev · preview port 5173" });

describe("A refused preview becomes one scoped request the person can accept", () => {
  const threadApi = (d: ThreadDetail, over: Partial<NativeApi> = {}) =>
    baseApi({
      threadList: async () => ({ threads: [d.thread] }),
      threadGet: async () => d,
      projectList: async () => ({ projects: [project({ workspaceMode: "direct", grant: grant() })], permissions: support() }),
      ...over,
    });

  it("names the exact port, allows it, and on request tells Nexus to carry on in the same conversation", async () => {
    const allow = vi.fn(async () => ({}));
    const send = vi.fn(async (i) => ({ threadId: T1, replay: false, run: fakeRun({ runId: R("2"), requestId: i.idempotencyKey, threadId: T1 }) }));
    const user = userEvent.setup();
    mount(threadApi(detailWith([refusedPort]), { projectAllowPreviews: allow, threadSend: send as NativeApi["threadSend"] }), `#/workspace/c/${T1}`);
    const card = await screen.findByRole("group", { name: "Nexus wants to show your site on port 5173" });
    expect(within(card).getByText(/previews are not allowed on that port/)).toBeInTheDocument();
    expect(allow).not.toHaveBeenCalled(); // nothing is allowed by showing the request
    await user.click(within(card).getByRole("button", { name: "Allow previews on 5173 and continue" }));
    await waitFor(() => expect(allow).toHaveBeenCalledWith(PID, [5173]));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const sent = send.mock.calls[0]![0];
    expect(sent).toMatchObject({ threadId: T1, projectId: PID, mode: "auto", content: "Previews are now allowed on 5173. Please start the preview again." });
  });

  it("'Allow only' allows the port and sends no message", async () => {
    const allow = vi.fn(async () => ({}));
    const send = vi.fn();
    const user = userEvent.setup();
    mount(threadApi(detailWith([refusedPort]), { projectAllowPreviews: allow, threadSend: send as NativeApi["threadSend"] }), `#/workspace/c/${T1}`);
    const card = await screen.findByRole("group", { name: /show your site on port 5173/ });
    await user.click(within(card).getByRole("button", { name: "Allow previews on 5173" }));
    await waitFor(() => expect(allow).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/applies from your next message/)).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it("a declined system dialog changes nothing and sends nothing", async () => {
    const send = vi.fn();
    const user = userEvent.setup();
    mount(threadApi(detailWith([refusedPort]), { projectAllowPreviews: async () => { throw declined; }, threadSend: send as NativeApi["threadSend"] }), `#/workspace/c/${T1}`);
    const card = await screen.findByRole("group", { name: /show your site on port 5173/ });
    await user.click(within(card).getByRole("button", { name: "Allow previews on 5173 and continue" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a project that does not yet run commands in its folder is asked for that first, then the port", async () => {
    const order: string[] = [];
    const user = userEvent.setup();
    mount(
      threadApi(detailWith([refusedPort]), {
        projectList: async () => ({ projects: [project({ workspaceMode: "direct" })], permissions: support() }),
        projectAllowWork: async () => void order.push("work"),
        projectAllowPreviews: async () => void order.push("previews"),
      }),
      `#/workspace/c/${T1}`,
    );
    const card = await screen.findByRole("group", { name: /show your site on port 5173/ });
    await user.click(within(card).getByRole("button", { name: "Allow previews on 5173" }));
    await waitFor(() => expect(order).toEqual(["work", "previews"]));
  });

  it("while the run is live, the request says it applies to the next message and offers no 'continue'", async () => {
    const d = detailWith([refusedPort], { state: "executing", terminal: false }, { active: true, activeRunId: R("1") });
    d.runs[0] = { ...d.runs[0]!, state: "executing", ended: false };
    mount(threadApi(d), `#/workspace/c/${T1}`);
    const card = await screen.findByRole("group", { name: /show your site on port 5173/ });
    expect(within(card).getByText(/keeps the permissions it started with/)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /and continue/ })).not.toBeInTheDocument();
  });

  it("no request is shown once the permissions already cover the port, or for a read-only run", async () => {
    mount(threadApi(detailWith([refusedPort]), { projectList: async () => ({ projects: [project({ workspaceMode: "direct", grant: grant({ devPorts: [5173] }) })], permissions: support() }) }), `#/workspace/c/${T1}`);
    await screen.findByRole("log", { name: "Conversation" });
    expect(screen.queryByRole("region", { name: "Permission requests" })).not.toBeInTheDocument();
  });

  it("a failed dependency install offers dependency downloads - never network in general", async () => {
    const allowInstalls = vi.fn(async () => ({}));
    const user = userEvent.setup();
    const d = detailWith([act({ tool: "proc_run", argsSummary: "npm install", status: "executed", exitCode: 1 })]);
    mount(threadApi(d, { projectAllowInstalls: allowInstalls }), `#/workspace/c/${T1}`);
    const card = await screen.findByRole("group", { name: "Nexus could not download your project's dependencies" });
    expect(within(card).getByText(/install commands \(and only those\)/)).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Allow dependency downloads" }));
    await waitFor(() => expect(allowInstalls).toHaveBeenCalledWith(PID, true));
  });
});

// ---- running previews -------------------------------------------------------------------------------------

const job = (over: Partial<JobView> = {}): JobView => ({
  jobId: "job-1", projectId: PID, state: "running", command: "npm run dev", task: "t", startedAtMs: Date.now() - 60_000, endedAtMs: null, exitCode: null,
  exposed: [{ port: 5173, hostPort: 43111, url: "http://127.0.0.1:43111" }], ready: true, logBytes: 10, logTruncated: false, ...over,
});

describe("Running previews", () => {
  const withJobs = (jobs: JobView[], over: Partial<NativeApi> = {}) =>
    baseApi({
      threadList: async () => ({ threads: [thread()] }),
      threadGet: async () => detailWith([]),
      jobList: async () => ({ jobs }),
      ...over,
    });

  it("shows a running server with Open preview, its address, its log and Stop; the page only names the job and the port", async () => {
    const open = vi.fn(async (_j: string, port: number) => `http://127.0.0.1:${port}`);
    const stop = vi.fn(async () => job({ state: "stopped" }));
    const logs = vi.fn(async (id: string) => ({ jobId: id, logs: "VITE ready in 120 ms" }));
    const user = userEvent.setup();
    mount(withJobs([job()], { previewOpen: open, jobStop: stop, jobLogs: logs }), `#/workspace/c/${T1}`);
    const panel = await screen.findByRole("region", { name: "Running processes" });
    expect(within(panel).getByText("Running")).toBeInTheDocument();
    expect(within(panel).getByText("http://127.0.0.1:43111")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Open preview of npm run dev" }));
    expect(open).toHaveBeenCalledWith("job-1", 5173); // an identity and a port: no address crosses
    expect(await within(panel).findByText(/Opened http:\/\/127.0.0.1:5173 in your browser/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Show log" }));
    expect(await within(panel).findByLabelText("Log of npm run dev")).toHaveTextContent("VITE ready in 120 ms");
    await user.click(within(panel).getByRole("button", { name: "Stop npm run dev" }));
    expect(stop).toHaveBeenCalledWith("job-1");
  });

  it("asks only for this project's jobs, and shows nothing when there are none", async () => {
    const list = vi.fn(async () => ({ jobs: [] as JobView[] }));
    mount(withJobs([], { jobList: list }), `#/workspace/c/${T1}`);
    await screen.findByRole("log", { name: "Conversation" });
    await waitFor(() => expect(list).toHaveBeenCalledWith(PID));
    expect(screen.queryByRole("region", { name: "Running processes" })).not.toBeInTheDocument();
  });

  it("an open that fails (no browser) says why and keeps the address to copy", async () => {
    const user = userEvent.setup();
    mount(withJobs([job()], { previewOpen: async () => { throw { code: "preview", message: "no way to open a browser was found", class: "refused", retryable: false }; } }), `#/workspace/c/${T1}`);
    const panel = await screen.findByRole("region", { name: "Running processes" });
    await user.click(within(panel).getByRole("button", { name: /Open preview/ }));
    expect(await within(panel).findByText(/no way to open a browser was found/)).toBeInTheDocument();
    expect(within(panel).getByText("http://127.0.0.1:43111")).toBeInTheDocument();
  });

  it("a server that is not running is never shown as running; ended ones sit behind a toggle on the Projects page", async () => {
    const user = userEvent.setup();
    mount(
      withJobs([job({ jobId: "j2", state: "interrupted", command: "node server.js", exposed: [] }), job({ jobId: "j3", state: "exited", exitCode: 1, command: "npm test", exposed: [] })], {
        projectList: async () => ({ projects: [project({ workspaceMode: "direct", grant: grant({ devPorts: [5173] }) })], permissions: support() }),
      }),
      "#/projects",
    );
    const p = await projectArticle();
    await user.click(await p.findByRole("button", { name: /Show 2 ended processes/ }));
    expect(p.getByText("Interrupted when Nexus restarted")).toBeInTheDocument();
    expect(p.getByText("Ended with an error (exit 1)")).toBeInTheDocument();
    expect(p.queryByRole("button", { name: /Open preview/ })).not.toBeInTheDocument();
    expect(p.queryByRole("button", { name: /^Stop (node|npm)/ })).not.toBeInTheDocument();
  });
});

// ---- recovery ----------------------------------------------------------------------------------------------

const effects = (over: Partial<ExecEffects["effects"]> = {}): ExecEffects => ({
  effects: {
    executionId: "exec-1", outcome: "observed", outcomeReasons: [], fsScope: "workspace", startedMs: 1, endedMs: 2,
    process: { exited: true, how: "exited", exitCode: 0, settled: true },
    effects: { created: { count: 1, paths: ["dist/app.js"], truncated: false }, modified: { count: 2, paths: ["src/a.ts", "src/b.ts"], truncated: false }, deleted: { count: 0, paths: [], truncated: false }, listsMayBeIncomplete: false },
    recoverability: { complete: true, available: 2, unavailable: 0, newPaths: 1, bulkNotCaptured: 0 },
    note: "", ...over,
  },
});
const preview = (r: Partial<RestorePreview["restore"]> = {}): RestorePreview => ({
  confirmDigest: "digest-1",
  restore: { executionId: "exec-1", dryRun: true, outcome: "completed", refused: null, restored: [{ path: "src/a.ts", detail: "restored" }, { path: "src/b.ts", detail: "restored" }], skipped: [], conflicted: [{ path: "dist/app.js", detail: "changed since" }], unrecoverable: [], recordListsTruncated: false, note: "Restoration is not atomic.", ...r },
});
const cmd = act({ tool: "proc_run", argsSummary: "npm run build", status: "executed", executionId: "exec-1", exitCode: 0, verification: "pass" });

async function openEvidence(api: NativeApi, user: ReturnType<typeof userEvent.setup>) {
  mount(api, `#/workspace/c/${T1}`);
  await user.click(await screen.findByRole("button", { name: "Execution evidence" }));
  return screen.findByRole("dialog", { name: "Evidence panel" });
}

describe("Recovering what a command changed", () => {
  const api = (over: Partial<NativeApi> = {}, d = detailWith([cmd], { workspaceKind: "direct", codingOutcome: { change: "applied", verification: "verified-passed", editsApplied: 0, editsNotApplied: 0, testsExecuted: 1, testsNotExecuted: 0, blockedByApproval: 0, lastExitCode: 0, staleAfterEdit: false, uncertainOperations: 0 } })) =>
    baseApi({ threadList: async () => ({ threads: [d.thread] }), threadGet: async () => d, commandEffects: async () => effects(), recoveryPreview: async () => preview(), ...over });

  it("shows what the command changed, reviews a restore first, and applies exactly the previewed digest", async () => {
    const apply = vi.fn(async () => ({ restore: { ...preview().restore, dryRun: false } }));
    const user = userEvent.setup();
    const panel = await openEvidence(api({ recoveryApply: apply as NativeApi["recoveryApply"] }), user);
    expect(await within(panel).findByText(/Created 1 · changed 2 · deleted 0 files/)).toBeInTheDocument();
    expect(within(panel).getByText(/The original of every changed or deleted file was saved/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Review recovery…" }));
    const review = await within(panel).findByRole("group", { name: "Recovery review" });
    expect(within(review).getByText("src/a.ts")).toBeInTheDocument();
    expect(within(review).getByText(/Changed since — will be left alone/)).toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled(); // reviewing restores nothing
    await user.click(within(review).getByRole("button", { name: "Restore 2 files…" }));
    expect(apply).toHaveBeenCalledWith("exec-1", "digest-1");
    expect(await within(review).findByText(/2 files restored · 0 already as before · 1 left alone because they changed since/)).toBeInTheDocument();
    // honest about the limits: no promise of a universal undo
    expect(within(panel).getByText(/not a universal undo/)).toBeInTheDocument();
  });

  it("a declined confirmation or a stale review shows no success", async () => {
    const apply = vi.fn().mockRejectedValueOnce(declined).mockRejectedValueOnce({ code: "recovery", message: "changed: the files changed since you reviewed this recovery; review it again", class: "refused", retryable: false });
    const user = userEvent.setup();
    const panel = await openEvidence(api({ recoveryApply: apply as NativeApi["recoveryApply"] }), user);
    await user.click(await within(panel).findByRole("button", { name: "Review recovery…" }));
    const restore = await within(panel).findByRole("button", { name: "Restore 2 files…" });
    await user.click(restore);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(within(panel).queryByText(/restored ·/)).not.toBeInTheDocument();
    expect(within(panel).queryByText("Nothing was restored")).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Restore 2 files…" }));
    expect(await within(panel).findByText("Nothing was restored")).toBeInTheDocument();
    expect(within(panel).getByText(/review it again/)).toBeInTheDocument();
    expect(within(panel).queryByText(/restored ·/)).not.toBeInTheDocument();
  });

  it("a refused recovery (a command still running) offers no restore and says why", async () => {
    const user = userEvent.setup();
    const panel = await openEvidence(api({ recoveryPreview: async () => preview({ refused: "the task still has a command in progress", restored: [], conflicted: [] }) }), user);
    await user.click(await within(panel).findByRole("button", { name: "Review recovery…" }));
    expect(await within(panel).findByText("Nothing can be restored right now")).toBeInTheDocument();
    expect(within(panel).getByText(/command in progress/)).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /^Restore/ })).not.toBeInTheDocument();
  });

  it("a command Nexus could not fully observe is not presented as a complete record", async () => {
    const user = userEvent.setup();
    const panel = await openEvidence(api({ commandEffects: async () => effects({ outcome: "uncertain", outcomeReasons: ["post manifest incomplete"] }) }), user);
    expect(await within(panel).findByText("not fully observed")).toBeInTheDocument();
    expect(within(panel).getByText(/may be incomplete. Check your folder yourself/)).toBeInTheDocument();
  });

  it("edits made directly in the folder are not offered a one-click undo that does not exist", async () => {
    const user = userEvent.setup();
    const d = detailWith([act({ tool: "fs_edit", argsSummary: "edit src/a.ts", status: "executed" })], { workspaceKind: "direct", changedFiles: [{ path: "src/a.ts", status: "M", additions: 1, deletions: 1 }], codingOutcome: { change: "applied", verification: "no-test-executed", editsApplied: 1, editsNotApplied: 0, testsExecuted: 0, testsNotExecuted: 0, blockedByApproval: 0, lastExitCode: null, staleAfterEdit: false, uncertainOperations: 0 } });
    const panel = await openEvidence(api({}, d), user);
    expect(within(panel).getByText(/Restoring file edits with one click is not available in this version/)).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /^Restore/ })).not.toBeInTheDocument();
  });

  it("a run that worked on a copy has nothing to restore, and says so", async () => {
    const user = userEvent.setup();
    const d = detailWith([act({ tool: "fs_edit", argsSummary: "edit src/a.ts", status: "executed" })], { changedFiles: [{ path: "src/a.ts", status: "M", additions: 1, deletions: 1 }], codingOutcome: { change: "applied", verification: "no-test-executed", editsApplied: 1, editsNotApplied: 0, testsExecuted: 0, testsNotExecuted: 0, blockedByApproval: 0, lastExitCode: null, staleAfterEdit: false, uncertainOperations: 0 } });
    const panel = await openEvidence(api({}, d), user);
    expect(within(panel).getByText(/your folder is unchanged until you apply the changes, so there is nothing to restore/)).toBeInTheDocument();
  });
});

// ---- this computer ---------------------------------------------------------------------------------------

describe("What this computer lacks, and what to do about it", () => {
  const env = (over: Partial<EnvCheck> = {}): EnvCheck => ({ platform: "linux", dialogTool: "zenity", opener: "xdg-open", toolchains: [["git", true], ["node", true], ["npm", true], ["python3", true], ["cargo", true]], ...over });
  const ok: { available: boolean | undefined; reason: string | null | undefined } = { available: true, reason: null };

  it("says nothing when everything is in place", () => {
    expect(environmentFindings(env(), ok)).toEqual([]);
    expect(environmentFindings(null, ok)).toEqual([]);
  });

  it("every gap gets a plain title and a way forward", () => {
    const f = (e: EnvCheck, p = ok) => environmentFindings(e, p).map((x) => [x.id, x.tone]);
    expect(f(env({ dialogTool: null }))).toEqual([["dialog", "error"]]);
    expect(f(env({ platform: "macos" }))).toEqual([["platform", "warning"]]);
    expect(f(env(), { available: false, reason: "no Landlock" })).toEqual([["sandbox", "warning"]]);
    expect(f(env({ toolchains: [["git", true], ["node", false], ["npm", false], ["python3", false], ["cargo", false]] }))).toEqual([["toolchains", "warning"]]);
    expect(f(env({ toolchains: [["git", true], ["node", true], ["npm", true], ["python3", false], ["cargo", false]] }))).toEqual([["missing-tools", "info"]]);
    expect(f(env({ opener: null }))).toEqual([["opener", "info"]]);
    const sandbox = environmentFindings(env(), { available: false, reason: "no Landlock" })[0]!;
    expect(sandbox.body).toMatch(/no Landlock/);
    expect(sandbox.body).toMatch(/temporary copy/);
  });
});

