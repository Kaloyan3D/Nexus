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
  DesktopCodeLimits,
  ConnectReport,
  IntentRun,
  LiveBlockers,
  MockEvent,
  ModelConversationSummary,
  ModelCatalog,
  ModelSelection,
  ProjectOpenReply,
  ProjectView,
  RegistryTarget,
  ThreadMode,
  ThreadSendReply,
  ThreadSummary,
  RuntimeSnapshot,
  RuntimeState,
  TaskRecord,
  TasksResult,
  UiError,
} from "../lib/contracts";
import { mockReducer, type MockRun } from "./mockRuns";
import { formatHash, parseHash } from "../lib/route";

export type Selection =
  | { kind: "task"; id: string }
  | { kind: "mock"; id: string }
  | { kind: "model"; id: string }
  /** A7.1: a persistent conversation (the broker's durable record). */
  | { kind: "thread"; id: string }
  | null;

export type Page =
  | "workspace"
  | "projects"
  | "history"
  | "models"
  | "sentry"
  | "settings"
  // Advanced / diagnostics (A6.1.2): kept, just not primary
  | "tasks"
  | "control-room"
  | "mock";

/** The on-demand side panel (A6.1.2): evidence about the selected run, opened by the user. */
export type PanelKind = "diff" | "test" | "evidence" | "source";

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
  /** The side panel (null = closed). Never open by default. */
  panel: PanelKind | null;
  /** The run the panel talks about when it was opened from a conversation (else the selected run). */
  panelRun: IntentRun | null;
  openPanel: (k: PanelKind, run?: IntentRun | null) => void;
  closePanel: () => void;
  selectedTask: TaskRecord | null;
  selectedMock: MockRun | null;
  modelRuns: ModelConversationSummary[];
  /** A6.1.1: the broker's record of each run, by conversation id (kind, lifecycle, verified outcome). */
  runByConversation: Map<string, IntentRun>;
  selectedModel: ModelConversationSummary | null;
  refreshModelRuns: () => void;
  refreshRuntime: () => void;
  refreshTasks: () => void;
  startMock: (prompt: string) => Promise<void>;
  mockBusy: boolean;
  /** A5.3: models the broker lets this client choose (null = not loaded). */
  intentModels: AllowedModel[] | null;
  intentModelsError: UiError | null;
  /** R-NATIVE-3: read-only Registry target catalog (null = not loaded). */
  intentTargets: RegistryTarget[] | null;
  intentTargetsError: UiError | null;
  /** A5.5: read-only workspaces (identities) available for inspection. */
  intentWorkspaces: AllowedWorkspace[] | null;
  /** The run being submitted/prepared (before its conversation exists). */
  intentPending: IntentRun | null;
  intentSubmitting: boolean;
  intentError: UiError | null;
  sendIntent: (prompt: string, model: AllowedModel | null) => Promise<boolean>;
  /** A5.6: sources (identities) that may be modified in an isolated copy. */
  intentCodeSources: AllowedCodeSource[] | null;
  /** A6.1: the fixed limits a coding task will run with (null = not loaded). */
  intentCodeLimits: DesktopCodeLimits | null;
  saveCodeLimits: (limits: Record<string, number>) => Promise<void>;
  /** A7.1: the user's conversations, newest activity first (the broker's durable record). */
  threads: ThreadSummary[];
  refreshThreads: () => Promise<void>;
  openThread: (threadId: string) => void;
  /** Leave the open conversation; the next message starts a NEW one with fresh context. */
  newConversation: () => void;
  /** Send a message into a conversation (a new one when `threadId` is null) and open it. */
  sendThread: (input: { threadId: string | null; projectId: string; content: string; mode: ThreadMode; workspace?: "continue" | "fresh"; model?: ModelSelection | null }) => Promise<ThreadSendReply | null>;
  threadSending: boolean;
  threadError: UiError | null;
  clearThreadError: () => void;
  /** A5.6: submit a controlled coding task for a source identity. */
  sendCode: (prompt: string, sourceId: string) => Promise<boolean>;
  /** A5.5: submit a read-only repository inspection for a workspace identity. */
  sendInspect: (prompt: string, workspaceId: string) => Promise<boolean>;
  cancelPendingIntent: () => Promise<void>;
  /** A6.1.4: the native runtime / setup state (null until the first answer). */
  runtimeState: RuntimeState | null;
  /** The setup action in flight (a native dialog may be open) and its last error. */
  setupBusy: "connect" | "consent" | "project" | "start" | null;
  setupError: UiError | null;
  connectProvider: () => Promise<ConnectReport | null>;
  giveConsent: () => Promise<void>;
  revokeConsent: () => Promise<void>;
  retryRuntime: () => Promise<void>;
  /** Projects Nexus knows (opened from the Desktop or registered by an operator). */
  projects: ProjectView[];
  refreshProjects: (withChanges?: boolean) => Promise<void>;
  openProject: () => Promise<ProjectOpenReply | null>;
  refreshProject: (projectId: string) => Promise<void>;
  forgetProject: (projectId: string) => Promise<void>;
  setProjectPolicy: (projectId: string, policy: { installs?: boolean; trusted?: boolean }) => Promise<void>;
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
  const [intentRuns, setIntentRuns] = useState<IntentRun[]>([]);
  const refreshModelRuns = useCallback(() => {
    nativeApi
      .listModelConversations()
      .then((list) => setModelRuns(list))
      .catch(() => {});
    // The transcript list does not say what KIND of run it was; the broker's record does.
    nativeApi
      .intentList()
      .then((runs) => setIntentRuns(runs))
      .catch(() => {});
  }, [nativeApi]);
  const runByConversation = useMemo(() => {
    const m = new Map<string, IntentRun>();
    for (const r of intentRuns) if (r.conversationId) m.set(r.conversationId, r);
    return m;
  }, [intentRuns]);
  const anyActive = modelRuns.some((m) => !m.terminal);
  useEffect(() => {
    refreshModelRuns();
    const t = setInterval(refreshModelRuns, anyActive ? 1_000 : 8_000);
    return () => clearInterval(t);
  }, [refreshModelRuns, anyActive]);
  // A5.3: the composer's Send goes through the SAME broker the CLI uses.
  const [intentModels, setIntentModels] = useState<AllowedModel[] | null>(null);
  const [intentModelsError, setIntentModelsError] = useState<UiError | null>(null);
  // R-NATIVE-3: the read-only Registry target catalog behind the picker/Models view.
  const [intentTargets, setIntentTargets] = useState<RegistryTarget[] | null>(null);
  const [intentTargetsError, setIntentTargetsError] = useState<UiError | null>(null);
  // A6.1.4: everything the broker serves is re-read when the runtime becomes ready or a
  // setup step (provider, consent, project) completes.
  const [runtimeState, setRuntimeState] = useState<RuntimeState | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const readyKey = `${runtimeState?.phase ?? "?"}:${runtimeState?.providerConnected ? 1 : 0}:${runtimeState?.consent.given ? 1 : 0}`;
  useEffect(() => {
    let alive = true;
    nativeApi
      .intentModels()
      .then((m) => alive && (setIntentModels(m), setIntentModelsError(null)))
      .catch((e) => alive && (setIntentModels(null), setIntentModelsError(asUiError(e))));
    nativeApi
      .intentTargets()
      .then((t) => alive && (setIntentTargets(t), setIntentTargetsError(null)))
      .catch((e) => alive && (setIntentTargets(null), setIntentTargetsError(asUiError(e))));
    return () => {
      alive = false;
    };
  }, [nativeApi, readyKey, reloadTick]);
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
  }, [nativeApi, readyKey, reloadTick]);
  const [intentCodeLimits, setIntentCodeLimits] = useState<DesktopCodeLimits | null>(null);
  useEffect(() => {
    let alive = true;
    nativeApi
      .intentCodeLimits()
      .then((l) => alive && setIntentCodeLimits(l))
      .catch(() => alive && setIntentCodeLimits(null));
    return () => {
      alive = false;
    };
  }, [nativeApi, readyKey, reloadTick]);
  const saveCodeLimits = useCallback(
    async (limits: Record<string, number>) => {
      await nativeApi.codeLimitsSet(limits);
      setIntentCodeLimits(await nativeApi.intentCodeLimits());
    },
    [nativeApi],
  );
  const [intentPending, setIntentPending] = useState<IntentRun | null>(null);
  const [intentSubmitting, setIntentSubmitting] = useState(false);
  const [intentError, setIntentError] = useState<UiError | null>(null);
  const [mockBusy, setMockBusy] = useState(false);
  const initialRoute = useMemo(() => parseHash(window.location.hash), []);
  const [selection, setSelection] = useState<Selection>(initialRoute.selection);
  const [page, setPageState] = useState<Page>(initialRoute.page);
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const [panelRun, setPanelRun] = useState<IntentRun | null>(null);
  const openPanel = useCallback((k: PanelKind, run?: IntentRun | null) => {
    setPanel(k);
    if (run !== undefined) setPanelRun(run);
  }, []);
  const closePanel = useCallback(() => {
    setPanel(null);
    setPanelRun(null);
  }, []);
  // Selecting a run opens it in the Workspace; selecting anything closes the panel.
  const select = useCallback((s: Selection) => {
    setSelection(s);
    setPanel(null);
    setPanelRun(null);
    if (s?.kind === "model" || s?.kind === "thread") setPageState("workspace");
    if (s?.kind === "task" || s?.kind === "mock") setPageState((p) => (p === "tasks" || p === "mock" ? p : "mock"));
  }, []);
  const setPage = useCallback((p: Page) => {
    setPageState(p);
    setPanel(null);
    setPanelRun(null);
    if (p !== "workspace") setSelection((cur) => (cur?.kind === "model" || cur?.kind === "thread" ? null : cur));
  }, []);
  // The URL hash follows the state and the state follows the hash (back/forward, deep links, restarts).
  useEffect(() => {
    const want = formatHash(page, selection);
    if (window.location.hash !== want) window.history.replaceState(null, "", want);
  }, [page, selection]);
  useEffect(() => {
    const onHash = () => {
      const r = parseHash(window.location.hash);
      setPageState(r.page);
      setSelection((cur) => (r.selection ?? (cur?.kind === "model" || cur?.kind === "thread" ? null : cur)));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
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
    [nativeApi, select],
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
    [nativeApi, refreshModelRuns, select],
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

  // ---- A6.1.4 runtime, setup and projects ------------------------------------------
  const refreshRuntimeState = useCallback(async () => {
    try {
      setRuntimeState(await nativeApi.runtimeState());
    } catch {
      setRuntimeState(null);
    }
  }, [nativeApi]);
  const setupDone =
    runtimeState === null ||
    runtimeState.mode === "external" ||
    (runtimeState.phase === "ready" && runtimeState.providerConnected && runtimeState.consent.given);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      nativeApi
        .runtimeState()
        .then((st) => alive && setRuntimeState(st))
        .catch(() => alive && setRuntimeState(null));
    tick();
    const t = setInterval(tick, setupDone ? 15_000 : 1_500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [nativeApi, setupDone]);
  const [setupBusy, setSetupBusy] = useState<NexusState["setupBusy"]>(null);
  const [setupError, setSetupError] = useState<UiError | null>(null);
  const guarded = useCallback(
    async <T,>(what: NonNullable<NexusState["setupBusy"]>, f: () => Promise<T>): Promise<T | null> => {
      setSetupBusy(what);
      setSetupError(null);
      try {
        return await f();
      } catch (e) {
        const u = asUiError(e);
        // dismissing a native dialog is not an error
        if (u.code !== "cancelled") setSetupError(u);
        return null;
      } finally {
        setSetupBusy(null);
        await refreshRuntimeState();
        setReloadTick((n) => n + 1);
      }
    },
    [refreshRuntimeState],
  );
  const connectProvider = useCallback(() => guarded("connect", () => nativeApi.providerConnect()), [guarded, nativeApi]);
  const giveConsent = useCallback(async () => void (await guarded("consent", () => nativeApi.providerConsent())), [guarded, nativeApi]);
  const revokeConsent = useCallback(async () => void (await guarded("consent", () => nativeApi.providerRevoke())), [guarded, nativeApi]);
  const retryRuntime = useCallback(async () => void (await guarded("start", () => nativeApi.runtimeStart())), [guarded, nativeApi]);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const refreshProjects = useCallback(
    async (withChanges?: boolean) => {
      try {
        setProjects((await nativeApi.projectList(withChanges)).projects);
      } catch {
        setProjects([]);
      }
    },
    [nativeApi],
  );
  useEffect(() => {
    let alive = true;
    nativeApi
      .projectList()
      .then((r) => alive && setProjects(r.projects))
      .catch(() => alive && setProjects([]));
    return () => {
      alive = false;
    };
  }, [nativeApi, readyKey, reloadTick]);
  const openProject = useCallback(() => guarded("project", () => nativeApi.projectPick()), [guarded, nativeApi]);
  const refreshProject = useCallback(async (id: string) => void (await guarded("project", () => nativeApi.projectRefresh(id))), [guarded, nativeApi]);
  const setProjectPolicy = useCallback(
    async (id: string, policy: { installs?: boolean; trusted?: boolean }) => {
      await guarded("project", () => nativeApi.projectSetPolicy(id, policy));
      await refreshProjects(false);
    },
    [guarded, nativeApi, refreshProjects],
  );
  const forgetProject = useCallback(async (id: string) => void (await guarded("project", () => nativeApi.projectForget(id))), [guarded, nativeApi]);

  // ---- A7.1 conversations -----------------------------------------------------------
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  // Reopening the app returns to the conversation the user was in (only when no route was given).
  const restored = useRef(false);
  const applyThreads = useCallback(
    (list: ThreadSummary[]) => {
      setThreads(list);
      if (!restored.current && list.length > 0) {
        restored.current = true;
        if (initialRoute.page === "workspace" && initialRoute.selection === null) {
          try {
            const last = window.localStorage.getItem("nexus.lastThread");
            if (last && list.some((t) => t.threadId === last)) setSelection({ kind: "thread", id: last });
          } catch {
            /* storage unavailable: start on the idle view */
          }
        }
      }
    },
    [initialRoute],
  );
  const refreshThreads = useCallback(async () => {
    try {
      applyThreads((await nativeApi.threadList(null, false)).threads);
    } catch {
      /* transient: the next poll tries again */
    }
  }, [nativeApi, applyThreads]);
  const anyThreadActive = threads.some((t) => t.active);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      nativeApi
        .threadList(null, false)
        .then((r) => alive && applyThreads(r.threads))
        .catch(() => undefined);
    tick();
    const t = setInterval(tick, anyThreadActive ? 1_500 : 6_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [nativeApi, applyThreads, anyThreadActive, readyKey, reloadTick]);
  const [threadSending, setThreadSending] = useState(false);
  const [threadError, setThreadError] = useState<UiError | null>(null);
  const clearThreadError = useCallback(() => setThreadError(null), []);
  const openThread = useCallback((id: string) => select({ kind: "thread", id }), [select]);
  const newConversation = useCallback(() => {
    select(null);
    setPageState("workspace");
  }, [select]);
  const sendThread = useCallback(
    async (input: { threadId: string | null; projectId: string; content: string; mode: ThreadMode; workspace?: "continue" | "fresh"; model?: ModelSelection | null }) => {
      // One key per click: a retried call never creates a second run or message.
      const key = newIdempotencyKey();
      setThreadSending(true);
      setThreadError(null);
      try {
        const { model, ...rest } = input;
        const reply = await nativeApi.threadSend({
          ...rest,
          workspace: input.workspace ?? "continue",
          // default = NO selection key at all (the same request as before R-NATIVE-3); a choice carries identities only
          ...(model ? { model } : {}),
          idempotencyKey: key,
        });
        await refreshThreads();
        select({ kind: "thread", id: reply.threadId });
        return reply;
      } catch (e) {
        setThreadError(asUiError(e));
        return null;
      } finally {
        setThreadSending(false);
      }
    },
    [nativeApi, refreshThreads, select],
  );
  useEffect(() => {
    if (selection?.kind !== "thread") return;
    try {
      window.localStorage.setItem("nexus.lastThread", selection.id);
    } catch {
      /* ignore */
    }
  }, [selection]);

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
    panel,
    panelRun,
    openPanel,
    closePanel,
    selectedTask,
    selectedMock,
    modelRuns,
    runByConversation,
    selectedModel,
    refreshModelRuns,
    refreshRuntime,
    refreshTasks,
    startMock,
    mockBusy,
    intentModels,
    intentModelsError,
    intentTargets,
    intentTargetsError,
    intentWorkspaces,
    intentCodeSources,
    intentCodeLimits,
    saveCodeLimits,
    threads,
    refreshThreads,
    openThread,
    newConversation,
    sendThread,
    threadSending,
    threadError,
    clearThreadError,
    sendCode,
    intentPending,
    intentSubmitting,
    intentError,
    sendIntent,
    sendInspect,
    cancelPendingIntent,
    runtimeState,
    setupBusy,
    setupError,
    connectProvider,
    giveConsent,
    revokeConsent,
    retryRuntime,
    projects,
    refreshProjects,
    openProject,
    refreshProject,
    forgetProject,
    setProjectPolicy,
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
