import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { asUiError, defaultApi, type NativeApi } from "../lib/api";
import type {
  AppInfo,
  AllowedModel,
  AllowedWorkspace,
  AllowedCodeSource,
  IntentRun,
  LiveBlockers,
  MockEvent,
  ModelConversationSummary,
  ModelCatalog,
  RuntimeSnapshot,
  TaskRecord,
  TasksResult,
  UiError,
} from "../lib/contracts";
import { mockReducer, type MockRun } from "./mockRuns";

export type Selection =
  | { kind: "task"; id: string }
  | { kind: "mock"; id: string }
  | { kind: "model"; id: string }
  | null;

export type Page =
  | "workspace"
  | "tasks"
  | "control-room"
  | "models"
  | "sentry"
  | "sessions"
  | "settings";

interface Loadable<T> {
  data: T | null;
  error: UiError | null;
  loading: boolean;
}

export interface NexusState {
  api: NativeApi;
  appInfo: Loadable<AppInfo>;
  runtime: RuntimeSnapshot | null;
  runtimeLoading: boolean;
  tasks: Loadable<TasksResult>;
  catalog: Loadable<ModelCatalog>;
  blockers: Loadable<LiveBlockers>;
  mockRuns: MockRun[];
  selection: Selection;
  page: Page;
  setPage: (p: Page) => void;
  select: (s: Selection) => void;
  selectedTask: TaskRecord | null;
  selectedMock: MockRun | null;
  modelRuns: ModelConversationSummary[];
  selectedModel: ModelConversationSummary | null;
  refreshModelRuns: () => void;
  refreshRuntime: () => void;
  refreshTasks: () => void;
  startMock: (prompt: string) => Promise<void>;
  mockBusy: boolean;
  /** A5.3: models the broker lets this client choose (null = not loaded). */
  intentModels: AllowedModel[] | null;
  intentModelsError: UiError | null;
  /** A5.5: read-only workspaces (identities) available for inspection. */
  intentWorkspaces: AllowedWorkspace[] | null;
  /** The run being submitted/prepared (before its conversation exists). */
  intentPending: IntentRun | null;
  intentSubmitting: boolean;
  intentError: UiError | null;
  sendIntent: (prompt: string, model: AllowedModel | null) => Promise<boolean>;
  /** A5.6: sources (identities) that may be modified in an isolated copy. */
  intentCodeSources: AllowedCodeSource[] | null;
  /** A5.6: submit a controlled coding task for a source identity. */
  sendCode: (prompt: string, sourceId: string) => Promise<boolean>;
  /** A5.5: submit a read-only repository inspection for a workspace identity. */
  sendInspect: (prompt: string, workspaceId: string) => Promise<boolean>;
  cancelPendingIntent: () => Promise<void>;
}

function newIdempotencyKey(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  const id =
    c && "randomUUID" in c
      ? c.randomUUID().replace(/-/g, "")
      : Math.random().toString(16).slice(2) + Date.now().toString(16);
  return `gui-${id}`;
}

const Ctx = createContext<NexusState | null>(null);

export function useNexus(): NexusState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNexus outside NexusProvider");
  return v;
}

const RUNTIME_POLL_MS = 5_000;
const TASKS_POLL_MS = 20_000;

function useLoadable<T>(
  fn: () => Promise<T>,
  key: unknown,
): [Loadable<T>, () => void] {
  const [state, setState] = useState<Loadable<T>>({ data: null, error: null, loading: true });
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const alive = useRef(true);
  const run = useCallback(() => {
    fnRef
      .current()
      .then((data) => alive.current && setState({ data, error: null, loading: false }))
      .catch(
        (e) =>
          alive.current &&
          setState((s) => ({ data: s.data, error: asUiError(e), loading: false })),
      );
  }, []);
  useEffect(() => {
    alive.current = true;
    run();
    return () => {
      alive.current = false;
    };
  }, [run, key]);
  return [state, run];
}

export function NexusProvider({ api, children }: { api?: NativeApi; children: ReactNode }) {
  const nativeApi = useMemo(() => api ?? defaultApi(), [api]);
  const [appInfo] = useLoadable(() => nativeApi.appInfo(), nativeApi);
  const [catalog] = useLoadable(() => nativeApi.modelCatalog(), nativeApi);
  const [blockers] = useLoadable(() => nativeApi.liveBlockers(), nativeApi);
  const [tasks, refreshTasks] = useLoadable(() => nativeApi.listTasks(), nativeApi);

  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const refreshRuntime = useCallback(() => {
    nativeApi
      .runtimeStatus()
      .then((s) => setRuntime(s))
      .catch((e) => {
        const err = asUiError(e);
        setRuntime((prev) => ({
          ...(prev ?? emptyRuntime()),
          connection: "error",
          detail: err.message,
          checkedAtMs: Date.now(),
        }));
      })
      .finally(() => setRuntimeLoading(false));
  }, [nativeApi]);
  useEffect(() => {
    refreshRuntime();
    const t = setInterval(refreshRuntime, RUNTIME_POLL_MS);
    return () => clearInterval(t);
  }, [refreshRuntime]);
  useEffect(() => {
    const t = setInterval(refreshTasks, TASKS_POLL_MS);
    return () => clearInterval(t);
  }, [refreshTasks]);

  const [mockRuns, dispatch] = useReducer(mockReducer, [] as MockRun[]);
  // Durably recorded mock conversations survive restarts; list them read-only.
  useEffect(() => {
    let alive = true;
    nativeApi
      .listMockConversations()
      .then((list) => {
        if (!alive) return;
        dispatch({
          type: "hydrate",
          runs: list.map((m) => ({
            key: m.conversationId,
            conversationId: m.conversationId,
            prompt: m.firstPrompt || "(mock run)",
            startedAtMs: m.startedAtMs ?? 0,
            finishedAtMs: null,
            status: m.finalized ? ("done" as const) : ("failed" as const),
            steps: [],
            stream: [],
            result: null,
            error: m.finalized
              ? null
              : { code: "incomplete", message: "This recorded run did not finish." },
          })),
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [nativeApi]);
  // A5.1 model-only runs are recorded by the backend executor; the renderer
  // only lists and follows them. Poll fast while one is in flight.
  const [modelRuns, setModelRuns] = useState<ModelConversationSummary[]>([]);
  const refreshModelRuns = useCallback(() => {
    nativeApi
      .listModelConversations()
      .then((list) => setModelRuns(list))
      .catch(() => {});
  }, [nativeApi]);
  const anyActive = modelRuns.some((m) => !m.terminal);
  useEffect(() => {
    refreshModelRuns();
    const t = setInterval(refreshModelRuns, anyActive ? 1_000 : 8_000);
    return () => clearInterval(t);
  }, [refreshModelRuns, anyActive]);
  // A5.3: the composer's Send goes through the SAME broker the CLI uses.
  const [intentModels, setIntentModels] = useState<AllowedModel[] | null>(null);
  const [intentModelsError, setIntentModelsError] = useState<UiError | null>(null);
  useEffect(() => {
    let alive = true;
    nativeApi
      .intentModels()
      .then((m) => alive && (setIntentModels(m), setIntentModelsError(null)))
      .catch((e) => alive && (setIntentModels(null), setIntentModelsError(asUiError(e))));
    return () => {
      alive = false;
    };
  }, [nativeApi]);
  const [intentWorkspaces, setIntentWorkspaces] = useState<AllowedWorkspace[] | null>(null);
  useEffect(() => {
    let alive = true;
    nativeApi
      .intentWorkspaces()
      .then((w) => alive && setIntentWorkspaces(w))
      .catch(() => alive && setIntentWorkspaces(null));
    return () => {
      alive = false;
    };
  }, [nativeApi]);
  const [intentCodeSources, setIntentCodeSources] = useState<AllowedCodeSource[] | null>(null);
  useEffect(() => {
    let alive = true;
    nativeApi
      .intentCodeSources()
      .then((w) => alive && setIntentCodeSources(w))
      .catch(() => alive && setIntentCodeSources(null));
    return () => {
      alive = false;
    };
  }, [nativeApi]);
  const [intentPending, setIntentPending] = useState<IntentRun | null>(null);
  const [intentSubmitting, setIntentSubmitting] = useState(false);
  const [intentError, setIntentError] = useState<UiError | null>(null);
  const [mockBusy, setMockBusy] = useState(false);
  const [selection, select] = useState<Selection>(null);
  const [page, setPage] = useState<Page>("workspace");
  const counter = useRef(0);

  const startMock = useCallback(
    async (prompt: string) => {
      const key = `local-mock-${++counter.current}`;
      dispatch({ type: "start", key, prompt, now: Date.now() });
      select({ kind: "mock", id: key });
      setMockBusy(true);
      // Coalesce streamed fragments to one state update per frame.
      let buffer: MockEvent[] = [];
      let scheduled = false;
      const flush = () => {
        scheduled = false;
        if (buffer.length) {
          const events = buffer;
          buffer = [];
          dispatch({ type: "events", key, events });
        }
      };
      try {
        const result = await nativeApi.runMock(prompt, (e) => {
          buffer.push(e);
          if (!scheduled) {
            scheduled = true;
            requestAnimationFrame(flush);
          }
        });
        flush();
        dispatch({ type: "done", key, result, now: Date.now() });
      } catch (e) {
        flush();
        dispatch({ type: "fail", key, error: asUiError(e), now: Date.now() });
      } finally {
        setMockBusy(false);
      }
    },
    [nativeApi],
  );

  const followSubmitted = useCallback(
    async (first: IntentRun): Promise<void> => {
      let run = first;
      setIntentPending(run);
      // Follow the run until its conversation exists, then hand over to the
      // shared conversation view (which streams from the transcript).
      for (let i = 0; i < 300 && !run.conversationId && !run.terminal; i++) {
        await new Promise((r) => setTimeout(r, 300));
        run = await nativeApi.intentStatus(run.runId);
        setIntentPending(run);
      }
      if (run.conversationId) {
        select({ kind: "model", id: run.conversationId });
        refreshModelRuns();
        setIntentPending(null);
      } else if (run.terminal) {
        setIntentError({
          code: run.errorCode ?? run.state,
          message: run.errorMessage ?? `The run ended as ${run.state} before any provider submission.`,
        });
        setIntentPending(null);
      }
    },
    [nativeApi, refreshModelRuns],
  );

  const sendIntent = useCallback(
    async (prompt: string, model: AllowedModel | null): Promise<boolean> => {
      // One key per click: a duplicate click or a retried call cannot create
      // a second billable attempt (the broker de-duplicates on this key).
      const key = newIdempotencyKey();
      setIntentSubmitting(true);
      setIntentError(null);
      try {
        const reply = await nativeApi.intentSubmit(
          prompt,
          model ? { providerId: model.providerId, remoteModelId: model.remoteModelId } : null,
          key,
        );
        await followSubmitted(reply.run);
        return true;
      } catch (e) {
        setIntentError(asUiError(e));
        setIntentPending(null);
        return false;
      } finally {
        setIntentSubmitting(false);
      }
    },
    [nativeApi, followSubmitted],
  );

  const sendInspect = useCallback(
    async (prompt: string, workspaceId: string): Promise<boolean> => {
      const key = newIdempotencyKey();
      setIntentSubmitting(true);
      setIntentError(null);
      try {
        const reply = await nativeApi.intentInspectSubmit(prompt, workspaceId, key);
        await followSubmitted(reply.run);
        return true;
      } catch (e) {
        setIntentError(asUiError(e));
        setIntentPending(null);
        return false;
      } finally {
        setIntentSubmitting(false);
      }
    },
    [nativeApi, followSubmitted],
  );

  const sendCode = useCallback(
    async (prompt: string, sourceId: string): Promise<boolean> => {
      const key = newIdempotencyKey();
      setIntentSubmitting(true);
      setIntentError(null);
      try {
        const reply = await nativeApi.intentCodeSubmit(prompt, sourceId, key);
        await followSubmitted(reply.run);
        return true;
      } catch (e) {
        setIntentError(asUiError(e));
        setIntentPending(null);
        return false;
      } finally {
        setIntentSubmitting(false);
      }
    },
    [nativeApi, followSubmitted],
  );

  const cancelPendingIntent = useCallback(async () => {
    if (!intentPending) return;
    try {
      const c = await nativeApi.intentCancel(intentPending.runId);
      setIntentPending(c.run);
    } catch (e) {
      setIntentError(asUiError(e));
    }
  }, [nativeApi, intentPending]);

  const selectedTask =
    selection?.kind === "task"
      ? (tasks.data?.tasks.find((t) => t.taskId === selection.id) ?? null)
      : null;
  const selectedMock =
    selection?.kind === "mock" ? (mockRuns.find((r) => r.key === selection.id) ?? null) : null;

  const selectedModel =
    selection?.kind === "model"
      ? (modelRuns.find((r) => r.conversationId === selection.id) ?? null)
      : null;

  const value: NexusState = {
    api: nativeApi,
    appInfo,
    runtime,
    runtimeLoading,
    tasks,
    catalog,
    blockers,
    mockRuns,
    selection,
    page,
    setPage,
    select,
    selectedTask,
    selectedMock,
    modelRuns,
    selectedModel,
    refreshModelRuns,
    refreshRuntime,
    refreshTasks,
    startMock,
    mockBusy,
    intentModels,
    intentModelsError,
    intentWorkspaces,
    intentCodeSources,
    sendCode,
    intentPending,
    intentSubmitting,
    intentError,
    sendIntent,
    sendInspect,
    cancelPendingIntent,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function emptyRuntime(): RuntimeSnapshot {
  return {
    connection: "error",
    detail: null,
    checkedAtMs: Date.now(),
    state: null,
    trustMode: null,
    incarnation: null,
    acceptedCommands: null,
    totalCommands: null,
    eventCount: null,
    witnessConfigured: null,
    witnessPresent: null,
    reconciliationRequired: null,
    peerUidEnforced: null,
    socketShared: null,
    startedAtUtc: null,
    activeClients: null,
    requests: null,
    refusals: null,
    errors: null,
    dispatchEnabled: null,
    readinessVerdict: null,
    readinessDimensions: [],
  };
}
