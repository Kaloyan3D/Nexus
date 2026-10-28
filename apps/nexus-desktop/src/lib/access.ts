import type { IntentRun, ProjectView } from "./contracts";

/**
 * Release 1: what a project's standing permissions MEAN, in the words of the things a person asks Nexus to
 * do. Everything here is derived from the broker's description of the project (never invented) and is
 * display-only: changing any of it goes through the native confirmation flow.
 */

/** Ports development servers commonly use (Next/Express 3000, Astro 4321, Vite 5173, Python 8000, 8080). */
export const COMMON_PREVIEW_PORTS = [3000, 4321, 5173, 8000, 8080] as const;

export const MIN_PREVIEW_PORT = 1024;

export type CommandsScope = "project" | "copy" | "full";
export type DownloadsScope = "off" | "dependencies" | "listed" | "full";

export interface AccessSummary {
  /** Nexus saves its edits in the real project folder (`direct`), or works on a copy you review. */
  editsDirectly: boolean;
  /** Where commands (tests, builds, installs, servers) run. */
  commands: CommandsScope;
  downloads: DownloadsScope;
  /** Development-server ports that may be shown on this computer. */
  previewPorts: number[];
  /** Permissions exist but were revoked or have expired: nothing they allowed is allowed now. */
  ended: "revoked" | "expired" | null;
  /** Permissions ask for approval before each action (needs the terminal approver). */
  asksFirst: boolean;
  /** Nexus can run previews: the project edits its folder and its commands run in it. */
  previewsPossible: boolean;
}

export function accessOf(p: ProjectView): AccessSummary {
  const g = p.grant;
  const active = g && g.status === "active" ? g : null;
  const direct = p.workspaceMode === "direct";
  const fs = active?.fs ?? "scratch";
  const commands: CommandsScope = fs === "full" ? "full" : fs === "workspace" ? "project" : "copy";
  const net = active?.net;
  const downloads: DownloadsScope = net === "install" ? "dependencies" : net === "controlled" ? "listed" : net === "full" ? "full" : p.installs === true && !g ? "dependencies" : "off";
  return {
    editsDirectly: direct,
    commands,
    downloads,
    previewPorts: active?.devPorts ?? [],
    ended: g && g.status !== "active" ? (g.status === "revoked" ? "revoked" : "expired") : null,
    asksFirst: active?.approval === "ask",
    previewsPossible: direct && commands === "project",
  };
}

/** One honest sentence about what Nexus may do in a project right now. */
export function accessSentence(a: AccessSummary): string {
  const parts: string[] = [];
  parts.push(a.editsDirectly ? "Nexus edits the files in your folder directly" : "Nexus works on a copy and you apply its changes");
  if (a.commands === "full") parts.push("commands run as you with Full Access");
  else if (a.commands === "project") parts.push("it can run commands in the project");
  else parts.push("commands run in a temporary copy");
  if (a.downloads === "dependencies") parts.push("dependency downloads are on");
  else if (a.downloads === "listed") parts.push("downloads only from the sites you listed");
  else if (a.downloads === "full") parts.push("unrestricted network");
  else parts.push("no downloads");
  parts.push(a.previewPorts.length > 0 ? `previews allowed on ${a.previewPorts.join(", ")}` : "no previews");
  const s = parts.join(" · ");
  return a.ended ? `Permissions ${a.ended}. ${s}` : s;
}

export function parsePreviewPorts(text: string): { ports: number[]; invalid: string[] } {
  const ports: number[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/).filter(Boolean)) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= MIN_PREVIEW_PORT && n <= 65535) {
      if (!ports.includes(n)) ports.push(n);
    } else invalid.push(raw);
  }
  return { ports: ports.sort((x, y) => x - y), invalid };
}

/** Something Nexus asked for during a run and was not allowed. Each maps to ONE scoped, confirmed action. */
export type Need =
  | { kind: "preview-port"; ports: number[]; command: string }
  | { kind: "work"; why: string }
  | { kind: "installs"; command: string };

const INSTALL = /^(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add)\b|^pip3?\s+install\b|^python3?\s+-m\s+pip\s+install\b|^poetry\s+(?:install|add)\b|^cargo\s+(?:fetch|add)\b|^go\s+(?:mod\s+download|get)\b/;

/** Does a command line install dependencies? (Only used to OFFER an action; the daemon decides what is allowed.) */
export function isInstallCommand(summary: string): boolean {
  return INSTALL.test(summary.trim());
}

const NO_GRANT_CODES = new Set(["no-grant", "grant-inactive", "not-available"]);

/**
 * What the run asked for and did not get, given what the project allows NOW. A need disappears by itself once
 * the project's permissions cover it, or once a later attempt succeeded. The model proposes; this only lists
 * the proposals so the person can allow exactly that, in a native confirmation.
 */
export function needsOf(run: IntentRun | null | undefined, project: ProjectView | undefined): Need[] {
  if (!run || !project) return [];
  const acts = run.toolActivity ?? [];
  const a = accessOf(project);
  const out: Need[] = [];
  const startedLater = (i: number, ports?: number[]) =>
    acts.slice(i + 1).some((x) => x.tool === "job_start" && x.status === "executed" && (!ports || ports.every((p) => (x.requestedPorts ?? []).includes(p))));
  acts.forEach((t, i) => {
    if (t.tool === "job_start" && t.status === "refused") {
      if (t.errorCode === "dev-port-not-authorized") {
        const missing = (t.requestedPorts ?? []).filter((p) => !a.previewPorts.includes(p));
        if (missing.length > 0 && !startedLater(i, missing) && !out.some((n) => n.kind === "preview-port" && missing.every((p) => n.ports.includes(p)))) {
          out.push({ kind: "preview-port", ports: missing, command: t.argsSummary });
        }
      } else if (t.errorCode && NO_GRANT_CODES.has(t.errorCode) && !a.previewsPossible && !startedLater(i) && !out.some((n) => n.kind === "work")) {
        out.push({ kind: "work", why: "A preview runs the project's own server, so Nexus needs to work in the project folder itself." });
      }
    }
    if (t.tool === "proc_run" && isInstallCommand(t.argsSummary) && a.downloads === "off" && (t.status !== "executed" || (t.exitCode ?? 0) !== 0) && !out.some((n) => n.kind === "installs")) {
      out.push({ kind: "installs", command: t.argsSummary });
    }
  });
  return out;
}
