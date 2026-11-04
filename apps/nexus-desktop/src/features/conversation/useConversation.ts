import { useCallback, useEffect, useRef, useState } from "react";
import { asUiError } from "../../lib/api";
import type { ConversationView, TranscriptEvent, UiError } from "../../lib/contracts";
import { useNexus } from "../../state/NexusContext";

const TAIL = 200;
const POLL_MS = 1500;
const MAX_BUFFER = 5000; // bounded in-memory window per conversation

export interface ConversationState {
  view: ConversationView | null;
  events: TranscriptEvent[];
  loading: boolean;
  error: UiError | null;
  hasEarlier: boolean;
  loadEarlier: () => void;
  refresh: () => void;
}

/** Merge by message id, newest revision wins, ordered by display position. */
export function mergeEvents(
  current: TranscriptEvent[],
  incoming: TranscriptEvent[],
  taskInstanceId: string,
): TranscriptEvent[] {
  const byId = new Map<string, TranscriptEvent>();
  for (const e of current) byId.set(e.messageId, e);
  for (const e of incoming) {
    // Cross-task defense: a record naming another task is never displayed.
    if (e.taskInstanceId !== taskInstanceId) continue;
    const prev = byId.get(e.messageId);
    if (!prev || e.revisionSeq >= prev.revisionSeq) byId.set(e.messageId, e);
  }
  const out = [...byId.values()].sort((a, b) => a.seq - b.seq || a.revisionSeq - b.revisionSeq);
  return out.length > MAX_BUFFER ? out.slice(out.length - MAX_BUFFER) : out;
}

/**
 * Loads the recorded conversation for exactly one id. A monotonically
 * increasing request token makes responses for a previous selection (or an
 * out-of-order poll) inert, so concurrent tasks can never merge.
 */
export function useConversation(
  conversationId: string | null,
  follow: boolean,
  resetKey: string,
): ConversationState {
  const { api } = useNexus();
  const [state, setState] = useState<{
    id: string | null;
    view: ConversationView | null;
    events: TranscriptEvent[];
    loading: boolean;
    error: UiError | null;
    hasEarlier: boolean;
  }>({ id: null, view: null, events: [], loading: false, error: null, hasEarlier: false });
  const token = useRef(0);
  const cursor = useRef<number | null>(null);
  const [tick, setTick] = useState(0);

  // initial / reload
  useEffect(() => {
    if (!conversationId) return;
    const mine = ++token.current;
    cursor.current = null;
    api
      .conversationRead(conversationId, { limit: TAIL })
      .then((view) => {
        if (token.current !== mine) return;
        cursor.current = view.page.headSeq;
        setState({
          id: conversationId,
          view,
          events: mergeEvents([], view.page.events, conversationId),
          loading: false,
          error: null,
          hasEarlier: view.page.hasEarlier,
        });
      })
      .catch((e) => {
        if (token.current !== mine) return;
        setState({
          id: conversationId,
          view: null,
          events: [],
          loading: false,
          error: asUiError(e),
          hasEarlier: false,
        });
      });
    const tokenRef = token;
    return () => {
      tokenRef.current++;
    };
  }, [api, conversationId, resetKey, tick]);

  // live follow: cursor-based, never refetches the whole transcript
  useEffect(() => {
    if (!conversationId || !follow) return;
    const timer = setInterval(() => {
      const after = cursor.current;
      if (after === null) return;
      const mine = token.current;
      api
        .conversationRead(conversationId, { afterSeq: after, limit: 500 })
        .then((view) => {
          if (token.current !== mine) return;
          if (view.page.headSeq !== null) cursor.current = view.page.headSeq;
          if (view.page.events.length === 0) return;
          setState((s) =>
            s.id !== conversationId
              ? s
              : {
                  ...s,
                  view: s.view ? { ...s.view, coverage: view.coverage } : view,
                  events: mergeEvents(s.events, view.page.events, conversationId),
                },
          );
        })
        .catch(() => {
          /* transient; the next tick retries from the same cursor */
        });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [api, conversationId, follow]);

  const loadEarlier = useCallback(() => {
    if (!conversationId) return;
    setState((s) => {
      const first = s.events[0]?.seq;
      if (first === undefined || s.id !== conversationId) return s;
      const mine = token.current;
      api
        .conversationRead(conversationId, { beforeSeq: first, limit: TAIL })
        .then((view) => {
          if (token.current !== mine) return;
          setState((cur) =>
            cur.id !== conversationId
              ? cur
              : {
                  ...cur,
                  hasEarlier: view.page.hasEarlier,
                  events: mergeEvents(cur.events, view.page.events, conversationId),
                },
          );
        })
        .catch(() => {});
      return s;
    });
  }, [api, conversationId]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const active = conversationId !== null && state.id === conversationId;
  return {
    view: active ? state.view : null,
    events: active ? state.events : [],
    loading: conversationId !== null && !active,
    error: active ? state.error : null,
    hasEarlier: active && state.hasEarlier,
    loadEarlier,
    refresh,
  };
}
