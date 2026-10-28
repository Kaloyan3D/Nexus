import { describe, expect, it } from "vitest";
import { accessOf, accessSentence, isInstallCommand, needsOf, parsePreviewPorts } from "../lib/access";
import type { IntentRun, JobView, ProjectView, ToolActivity } from "../lib/contracts";
import { jobStateView } from "../features/jobs/useJobs";
import { fakeRun } from "./fakeApi";

function project(over: Partial<ProjectView> = {}): ProjectView {
  return { projectId: "p", label: "demo", managed: true, kinds: [], pinnedCommit: "", writeAllow: [], snapshotAtMs: 1, originDirty: false, changedSinceSnapshot: false, ...over };
}
function grant(over: Partial<NonNullable<ProjectView["grant"]>> = {}): NonNullable<ProjectView["grant"]> {
  return { grantId: "g", version: 1, digest: "d", fs: "workspace", net: "offline", approval: "auto", expiresAtMs: null, createdAtMs: 1, createdBy: "desktop", status: "active", revokedAtMs: null, history: [], ...over };
}
function act(over: Partial<ToolActivity>): ToolActivity {
  return { index: 1, turn: 1, callId: "c", tool: "job_start", argsSummary: "", status: "refused", errorCode: null, resultBytes: 0, resultDigest: null, truncated: false, executionId: null, journalSeq: null, argsDigest: null, ...over };
}
const run = (acts: ToolActivity[]): IntentRun => fakeRun({ toolActivity: acts });

describe("what a project's permissions mean", () => {
  it("a new project: edits a copy, temporary-copy commands, no downloads, no previews", () => {
    const a = accessOf(project());
    expect(a).toMatchObject({ editsDirectly: false, commands: "copy", downloads: "off", previewPorts: [], ended: null, previewsPossible: false });
    expect(accessSentence(a)).toBe("Nexus works on a copy and you apply its changes · commands run in a temporary copy · no downloads · no previews");
  });

  it("working in the project folder with previews allowed", () => {
    const a = accessOf(project({ workspaceMode: "direct", grant: grant({ net: "install", devPorts: [5173, 3000] }) }));
    expect(a).toMatchObject({ editsDirectly: true, commands: "project", downloads: "dependencies", previewPorts: [5173, 3000], previewsPossible: true });
    expect(accessSentence(a)).toContain("previews allowed on 5173, 3000");
  });

  it("revoked or expired permissions allow nothing, and say so", () => {
    for (const status of ["revoked", "expired"] as const) {
      const a = accessOf(project({ workspaceMode: "direct", grant: grant({ status, net: "install", devPorts: [5173] }) }));
      expect(a).toMatchObject({ commands: "copy", downloads: "off", previewPorts: [], ended: status, previewsPossible: false });
      expect(accessSentence(a).startsWith(`Permissions ${status}.`)).toBe(true);
    }
  });

  it("Full Access and listed destinations are named for what they are, never as a simple 'on'", () => {
    expect(accessOf(project({ grant: grant({ fs: "full", net: "full" }) }))).toMatchObject({ commands: "full", downloads: "full", previewsPossible: false });
    expect(accessOf(project({ workspaceMode: "direct", grant: grant({ net: "controlled" }) })).downloads).toBe("listed");
  });

  it("the legacy per-project installs switch counts only while there are no permissions", () => {
    expect(accessOf(project({ installs: true })).downloads).toBe("dependencies");
    expect(accessOf(project({ installs: true, grant: grant({ net: "offline" }) })).downloads).toBe("off");
  });
});

describe("preview ports", () => {
  it("accepts development ports only: 1024..65535, sorted, unique", () => {
    expect(parsePreviewPorts("5173, 3000 5173;8080")).toEqual({ ports: [3000, 5173, 8080], invalid: [] });
    expect(parsePreviewPorts("80 1023 65536 abc 0 -1 1.5")).toEqual({ ports: [], invalid: ["80", "1023", "65536", "abc", "0", "-1", "1.5"] });
    expect(parsePreviewPorts("")).toEqual({ ports: [], invalid: [] });
  });
});

describe("install commands", () => {
  it("recognizes dependency installs, not ordinary build or test commands", () => {
    for (const c of ["npm install", "npm ci", "npm i left-pad", "pnpm add vite", "yarn install", "pip install -r requirements.txt", "pip3 install x", "python3 -m pip install x", "cargo fetch", "go mod download"]) expect(isInstallCommand(c), c).toBe(true);
    for (const c of ["npm test", "npm run build", "node server.js", "cargo test", "pip list", "ls node_modules", "echo npm install"]) expect(isInstallCommand(c), c).toBe(false);
  });
});

describe("what a run asked for and was not allowed", () => {
  const direct = (g?: NonNullable<ProjectView["grant"]>) => project({ workspaceMode: "direct", grant: g });
  const refusedPort = act({ errorCode: "dev-port-not-authorized", requestedPorts: [5173], argsSummary: "npm run dev · preview port 5173" });

  it("an unauthorized preview port becomes an exact, scoped request for that port", () => {
    expect(needsOf(run([refusedPort]), direct(grant()))).toEqual([{ kind: "preview-port", ports: [5173], command: "npm run dev · preview port 5173" }]);
  });

  it("is gone once the permissions cover the port, or a later start worked", () => {
    expect(needsOf(run([refusedPort]), direct(grant({ devPorts: [5173] })))).toEqual([]);
    expect(needsOf(run([refusedPort, act({ index: 2, status: "executed", requestedPorts: [5173] })]), direct(grant()))).toEqual([]);
    // a later start WITHOUT the port (seen live: the model started the server after the refusal, with no preview) still needs the request
    expect(needsOf(run([refusedPort, act({ index: 2, status: "executed", requestedPorts: [] })]), direct(grant()))).toHaveLength(1);
    // permissions that ended do not cover anything
    expect(needsOf(run([refusedPort]), direct(grant({ status: "revoked", devPorts: [5173] })))).toHaveLength(1);
  });

  it("asks only for the ports that are missing", () => {
    const r = run([act({ errorCode: "dev-port-not-authorized", requestedPorts: [3000, 5173], argsSummary: "x" })]);
    expect(needsOf(r, direct(grant({ devPorts: [3000] })))).toEqual([{ kind: "preview-port", ports: [5173], command: "x" }]);
  });

  it("a preview refused for lack of permissions asks for the project to be worked on directly", () => {
    for (const errorCode of ["no-grant", "grant-inactive", "not-available"]) {
      expect(needsOf(run([act({ errorCode })]), project()).map((n) => n.kind), errorCode).toEqual(["work"]);
    }
    expect(needsOf(run([act({ errorCode: "no-grant" })]), direct(grant()))).toEqual([]);
  });

  it("a failed dependency install asks for downloads only while downloads are off", () => {
    const failed = act({ tool: "proc_run", argsSummary: "npm install", status: "executed", exitCode: 1 });
    expect(needsOf(run([failed]), direct(grant()))).toEqual([{ kind: "installs", command: "npm install" }]);
    expect(needsOf(run([failed]), direct(grant({ net: "install" })))).toEqual([]);
    expect(needsOf(run([{ ...failed, exitCode: 0 }]), direct(grant()))).toEqual([]);
    expect(needsOf(run([act({ tool: "proc_run", argsSummary: "npm test", status: "executed", exitCode: 1 })]), direct(grant()))).toEqual([]);
    expect(needsOf(run([act({ tool: "proc_run", argsSummary: "npm ci", status: "refused" })]), project())).toHaveLength(1);
  });

  it("nothing is asked for from a run without refused work, or without a known project", () => {
    expect(needsOf(null, project())).toEqual([]);
    expect(needsOf(run([refusedPort]), undefined)).toEqual([]);
    expect(needsOf(run([]), project())).toEqual([]);
  });
});

describe("a running process's state in words", () => {
  const job = (o: Partial<JobView>): JobView => ({ jobId: "j", state: "running", command: "npm start", task: "t", startedAtMs: 0, exposed: [], ready: false, logBytes: 0, logTruncated: false, ...o });
  it("is Running when nothing is exposed (seen live: it said Starting… forever), Starting… only while a preview port is not answering yet", () => {
    expect(jobStateView(job({})).label).toBe("Running");
    expect(jobStateView(job({ exposed: [{ port: 5173, hostPort: 40000, url: "http://127.0.0.1:40000" }] })).label).toBe("Starting…");
    expect(jobStateView(job({ exposed: [{ port: 5173, hostPort: 40000, url: "http://127.0.0.1:40000" }], ready: true })).label).toBe("Running");
  });
});
