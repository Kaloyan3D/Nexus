import { useCallback, useEffect, useRef, useState } from "react";
import { asUiError } from "../../lib/api";
import type { JobView, UiError } from "../../lib/contracts";
import { useNexus } from "../../state/NexusContext";

const POLL_MS = 3_000;

/**
 * The background jobs (development servers, watchers) of one project, or of all of them. The broker is the
 * source of truth: a job that stopped, was stopped by a revocation or did not survive a restart is shown as
 * whatever the broker's record says, never as running.
 */
export function useJobs(projectId?: string | null): { jobs: JobView[]; error: UiError | null; loaded: boolean; reload: () => void } {
  const { api } = useNexus();
  const [state, setState] = useState<{ jobs: JobView[]; error: UiError | null; loaded: boolean }>({ jobs: [], error: null, loaded: false });
  const alive = useRef(true);
  const load = useCallback(() => {
    api
      .jobList(projectId ?? null)
      .then((r) => alive.current && setState({ jobs: r.jobs, error: null, loaded: true }))
      .catch((e: unknown) => alive.current && setState((s) => ({ ...s, error: asUiError(e), loaded: true })));
  }, [api, projectId]);
  useEffect(() => {
    alive.current = true;
    load();
    const h = setInterval(load, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(h);
    };
  }, [load]);
  return { ...state, reload: load };
}

/** `npm run dev` from `npm run dev` / `node server.js`; the broker's display string already is the command. */
export function jobTitle(j: JobView): string {
  return j.command.trim() || "Background process";
}

export type JobTone = "success" | "warning" | "error" | "neutral";

/** A job's state in words a person understands. */
export function jobStateView(j: JobView): { label: string; tone: JobTone; running: boolean } {
  switch (j.state) {
    case "running":
      return j.ready ? { label: "Running", tone: "success", running: true } : { label: "Starting…", tone: "warning", running: true };
    case "stopped":
      return { label: "Stopped", tone: "neutral", running: false };
    case "exited":
      return j.exitCode ? { label: `Ended with an error (exit ${j.exitCode})`, tone: "error", running: false } : { label: "Finished", tone: "neutral", running: false };
    case "failed":
      return { label: "Could not start", tone: "error", running: false };
    case "interrupted":
      return { label: "Interrupted when Nexus restarted", tone: "warning", running: false };
    default:
      return { label: j.state, tone: "neutral", running: false };
  }
}
