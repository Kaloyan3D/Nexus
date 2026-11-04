import { useCallback, useEffect, useRef, useState } from "react";
import { asUiError } from "../../lib/api";
import type { ThreadDetail, UiError } from "../../lib/contracts";
import { useNexus } from "../../state/NexusContext";

const ACTIVE_POLL_MS = 1_500;

/**
 * The broker's record of ONE conversation. A response for a previously opened conversation
 * (or an out-of-order poll) is inert: only the newest request of the current id is applied,
 * so two open conversations can never show each other's messages.
 */
export function useThread(threadId: string, stamp: number) {
  const { api } = useNexus();
  const [state, setState] = useState<{ id: string; detail: ThreadDetail | null; error: UiError | null }>({ id: "", detail: null, error: null });
  const token = useRef(0);
  const load = useCallback(() => {
    const mine = ++token.current;
    api
      .threadGet(threadId)
      .then((detail) => token.current === mine && setState({ id: threadId, detail, error: null }))
      .catch((e) => token.current === mine && setState((s) => ({ id: threadId, detail: s.id === threadId ? s.detail : null, error: asUiError(e) })));
  }, [api, threadId]);
  // (re)load when opened and whenever the conversation list says something moved
  useEffect(() => {
    const t = token;
    load();
    return () => {
      t.current++;
    };
  }, [load, stamp]);
  // also keep reading while a Mac project's result is still on its way to the folder, so the line
  // "task finished, not on your Mac yet" turns into the real outcome without a manual refresh
  const syncPending = state.id === threadId && (state.detail?.runs ?? []).some((r) => {
    const s = r.run?.hostSync?.state;
    return s !== undefined && !["applied", "conflict", "failed", "not-applied"].includes(s);
  });
  const active = state.id === threadId && (state.detail?.thread.active === true || syncPending);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, ACTIVE_POLL_MS);
    return () => clearInterval(t);
  }, [active, load]);
  const mine = state.id === threadId;
  return { detail: mine ? state.detail : null, error: mine ? state.error : null, reload: load };
}
