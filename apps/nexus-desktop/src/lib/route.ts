import type { Page, Selection } from "../state/NexusContext";

/**
 * Hash routes keep the user's place across reloads and app restarts and make a
 * run linkable: #/workspace, #/workspace/run/<conversationId>, #/workspace/c/<threadId>, #/projects,
 * #/history, #/models, #/sentry, #/settings, #/advanced/{tasks|control-room|mock}.
 * Only identities appear in a route - never a path, credential or approval.
 */
const PRIMARY: Page[] = ["workspace", "projects", "history", "models", "sentry", "settings"];
const ADVANCED: Page[] = ["tasks", "control-room", "mock"];
const CONV = /^model_[0-9a-f]{32}$/;
const THREAD = /^thr_[0-9a-f]{32}$/;

export function parseHash(hash: string): { page: Page; selection: Selection } {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [a, b, c] = parts;
  if (a === "advanced" && ADVANCED.includes(b as Page)) return { page: b as Page, selection: null };
  if (a && PRIMARY.includes(a as Page)) {
    if (a === "workspace" && b === "run" && c && CONV.test(c)) return { page: "workspace", selection: { kind: "model", id: c } };
    if (a === "workspace" && b === "c" && c && THREAD.test(c)) return { page: "workspace", selection: { kind: "thread", id: c } };
    return { page: a as Page, selection: null };
  }
  return { page: "workspace", selection: null };
}

export function formatHash(page: Page, selection: Selection): string {
  if (ADVANCED.includes(page)) return `#/advanced/${page}`;
  if (page === "workspace" && selection?.kind === "model") return `#/workspace/run/${selection.id}`;
  if (page === "workspace" && selection?.kind === "thread") return `#/workspace/c/${selection.id}`;
  return `#/${page}`;
}

export const ADVANCED_PAGES = ADVANCED;
