import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  ApprovalsView,
  ConversationQuery,
  ConversationView,
  IntegrityView,
  AllowedModel,
  AllowedWorkspace,
  AllowedCodeSource,
  ConnectReport,
  CopyInfo,
  DesktopCodeLimits,
  DiffReply,
  IntentCancelReply,
  IntentRun,
  IntentSubmitReply,
  MockConversationSummary,
  ModelConversationSummary,
  ModelRunStatus,
  ModelIoView,
  ProjectOpenReply,
  ProjectView,
  RegistryTarget,
  ThreadDetail,
  ThreadSendInput,
  ThreadSendReply,
  ThreadSummary,
  RuntimeState,
  JournalResult,
  LiveBlockers,
  MockEvent,
  MockResult,
  ModelCatalog,
  RuntimeSnapshot,
  TaskToolEvents,
  TasksResult,
  UiError,
} from "./contracts";

/** Every capability the renderer has. Mirrors the Tauri command allowlist. */
export interface NativeApi {
  appInfo(): Promise<AppInfo>;
  runtimeStatus(): Promise<RuntimeSnapshot>;
  listTasks(): Promise<TasksResult>;
  taskJournal(taskInstanceId: string): Promise<JournalResult>;
  modelCatalog(): Promise<ModelCatalog>;
  liveBlockers(): Promise<LiveBlockers>;
  runMock(prompt: string, onEvent: (e: MockEvent) => void): Promise<MockResult>;
  conversationRead(taskInstanceId: string, q?: ConversationQuery): Promise<ConversationView>;
  modelIoRead(taskInstanceId: string): Promise<ModelIoView>;
  listMockConversations(): Promise<MockConversationSummary[]>;
  /** A5.3: Registry-issued models the broker lets this client select. */
  intentModels(): Promise<AllowedModel[]>;
  /** R-NATIVE-3: read-only Registry target catalog (status, identities only). */
  intentTargets(): Promise<RegistryTarget[]>;
  /** A5.3: submit text through the same broker the CLI uses. */
  intentSubmit(
    prompt: string,
    model: { providerId: string; remoteModelId: string; logicalModelId?: string | null; routeId?: string | null } | null,
    idempotencyKey: string,
  ): Promise<IntentSubmitReply>;
  /** A5.5: read-only workspaces (identities) the broker lets this client inspect. */
  intentWorkspaces(): Promise<AllowedWorkspace[]>;
  /** A5.5: submit a READ-ONLY repository inspection (text + workspace identity only). */
  intentInspectSubmit(
    prompt: string,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<IntentSubmitReply>;
  /** A5.6: sources (identities) the broker lets this client have MODIFIED in an isolated copy. */
  intentCodeSources(): Promise<AllowedCodeSource[]>;
  /** A6.1: the fixed limits a Desktop coding task uses (shown before submitting). */
  intentCodeLimits(): Promise<DesktopCodeLimits>;
  codeLimitsSet(limits: Record<string, number>): Promise<unknown>;
  /** A5.6: submit a controlled coding task (text + source identity only). */
  intentCodeSubmit(
    prompt: string,
    sourceId: string,
    idempotencyKey: string,
  ): Promise<IntentSubmitReply>;
  /** A5.6: read-only change set of this user's repo-code run. */
  intentDiff(runId: string): Promise<DiffReply>;
  intentCopy(runId: string): Promise<CopyInfo>;
  /** A6.1.4: the native runtime's state (interactive profile) or `external`. */
  runtimeState(): Promise<RuntimeState>;
  runtimeStart(): Promise<void>;
  /** Native password prompt, then one-time provider connection. The key never reaches this page. */
  providerConnect(): Promise<ConnectReport>;
  /** Native confirmation of the exact consent text. */
  providerConsent(): Promise<RuntimeState["consent"]>;
  providerRevoke(): Promise<RuntimeState["consent"]>;
  /** Native folder picker, then open the folder as a project. No path crosses this API. */
  projectPick(): Promise<ProjectOpenReply>;
  projectList(withChanges?: boolean): Promise<{ projects: ProjectView[] }>;
  projectRefresh(projectId: string): Promise<ProjectOpenReply>;
  projectSetPolicy(projectId: string, policy: { installs?: boolean; trusted?: boolean }): Promise<unknown>;
  projectForget(projectId: string): Promise<{ forgotten: string }>;
  /** Apply a finished run's patch to the user's folder after a native confirmation. */
  projectAdopt(runId: string): Promise<{ applied: string[] }>;
  /** A7.1: persistent conversations (the broker's durable record). */
  threadList(projectId?: string | null, includeArchived?: boolean): Promise<{ threads: ThreadSummary[] }>;
  threadGet(threadId: string, afterSeq?: number | null): Promise<ThreadDetail>;
  threadSend(input: ThreadSendInput): Promise<ThreadSendReply>;
  threadCreate(projectId: string, title?: string | null): Promise<{ thread: ThreadSummary }>;
  threadUpdate(threadId: string, patch: { title?: string | null; archived?: boolean | null }): Promise<{ thread: ThreadSummary }>;
  intentStatus(runId: string): Promise<IntentRun>;
  intentResult(runId: string): Promise<string>;
  intentCancel(runId: string): Promise<IntentCancelReply>;
  intentList(): Promise<IntentRun[]>;
  /** A5.1: recorded user-initiated model-only runs (read-only). */
  listModelConversations(): Promise<ModelConversationSummary[]>;
  /** A5.1: durable status of one model-only run (read-only). */
  modelRunStatus(conversationId: string): Promise<ModelRunStatus>;
  /** A5.1: fail-safe stop request. Cannot start, resend or authorize a run. */
  cancelModelRun(conversationId: string): Promise<void>;
  /** Read-only tool records for a task attempt. Never executes tools. */
  toolEvents(taskInstanceId: string): Promise<TaskToolEvents>;
  /** Read-only approval status. There is deliberately no approve/deny here. */
  listApprovals(taskInstanceId: string): Promise<ApprovalsView>;
  /** Read-only journal integrity; holds no witness credential. */
  integrityStatus(): Promise<IntegrityView>;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function asUiError(e: unknown): UiError {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const o = e as { code: unknown; message: unknown };
    return { code: String(o.code), message: String(o.message) };
  }
  return { code: "internal", message: e instanceof Error ? e.message : String(e) };
}

export const tauriApi: NativeApi = {
  appInfo: () => invoke<AppInfo>("app_info"),
  runtimeStatus: () => invoke<RuntimeSnapshot>("runtime_status"),
  listTasks: () => invoke<TasksResult>("list_tasks"),
  taskJournal: (taskInstanceId) => invoke<JournalResult>("task_journal", { taskInstanceId }),
  modelCatalog: () => invoke<ModelCatalog>("model_catalog"),
  liveBlockers: () => invoke<LiveBlockers>("live_blockers"),
  runMock: (prompt, onEvent) => {
    const channel = new Channel<MockEvent>();
    channel.onmessage = onEvent;
    return invoke<MockResult>("run_mock", { prompt, onEvent: channel });
  },
  conversationRead: (taskInstanceId, q = {}) =>
    invoke<ConversationView>("conversation_read", {
      taskInstanceId,
      afterSeq: q.afterSeq ?? null,
      beforeSeq: q.beforeSeq ?? null,
      limit: q.limit ?? null,
    }),
  modelIoRead: (taskInstanceId) => invoke<ModelIoView>("model_io_read", { taskInstanceId }),
  listMockConversations: () => invoke<MockConversationSummary[]>("list_mock_conversations"),
  intentModels: () => invoke<AllowedModel[]>("intent_models"),
  intentTargets: () => invoke<RegistryTarget[]>("intent_targets"),
  intentSubmit: (prompt, model, idempotencyKey) =>
    invoke<IntentSubmitReply>("intent_submit", {
      prompt,
      providerId: model?.providerId ?? null,
      remoteModelId: model?.remoteModelId ?? null,
      logicalModelId: model?.logicalModelId ?? null,
      routeId: model?.routeId ?? null,
      idempotencyKey,
    }),
  intentWorkspaces: () => invoke<AllowedWorkspace[]>("intent_workspaces"),
  intentInspectSubmit: (prompt, workspaceId, idempotencyKey) =>
    invoke<IntentSubmitReply>("intent_inspect_submit", { prompt, workspaceId, idempotencyKey }),
  intentCodeSources: () => invoke<AllowedCodeSource[]>("intent_code_sources"),
  intentCodeLimits: () => invoke<DesktopCodeLimits>("intent_code_limits"),
  codeLimitsSet: (limits) => invoke<unknown>("code_limits_set", { limits }),
  intentCodeSubmit: (prompt, sourceId, idempotencyKey) =>
    invoke<IntentSubmitReply>("intent_code_submit", { prompt, sourceId, idempotencyKey }),
  intentDiff: (runId) => invoke<DiffReply>("intent_diff", { runId }),
  intentCopy: (runId) => invoke<CopyInfo>("intent_copy", { runId }),
  runtimeState: () => invoke<RuntimeState>("runtime_state"),
  runtimeStart: () => invoke<void>("runtime_start"),
  providerConnect: () => invoke<ConnectReport>("provider_connect"),
  providerConsent: () => invoke<RuntimeState["consent"]>("provider_consent"),
  providerRevoke: () => invoke<RuntimeState["consent"]>("provider_revoke"),
  projectPick: () => invoke<ProjectOpenReply>("project_pick"),
  projectList: (withChanges) => invoke<{ projects: ProjectView[] }>("project_list", { withChanges: withChanges ?? false }),
  projectRefresh: (projectId) => invoke<ProjectOpenReply>("project_refresh", { projectId }),
  projectSetPolicy: (projectId, policy) => invoke<unknown>("project_set_policy", { projectId, installs: policy.installs ?? null, trusted: policy.trusted ?? null }),
  projectForget: (projectId) => invoke<{ forgotten: string }>("project_forget", { projectId }),
  projectAdopt: (runId) => invoke<{ applied: string[] }>("project_adopt", { runId }),
  threadList: (projectId, includeArchived) => invoke<{ threads: ThreadSummary[] }>("thread_list", { projectId: projectId ?? null, includeArchived: includeArchived ?? false }),
  threadGet: (threadId, afterSeq) => invoke<ThreadDetail>("thread_get", { threadId, afterSeq: afterSeq ?? null }),
  threadSend: (i) =>
    invoke<ThreadSendReply>("thread_send", {
      threadId: i.threadId,
      projectId: i.projectId,
      content: i.content,
      mode: i.mode,
      workspace: i.workspace,
      providerId: i.model?.providerId ?? null,
      remoteModelId: i.model?.remoteModelId ?? null,
      logicalModelId: i.model?.logicalModelId ?? null,
      routeId: i.model?.routeId ?? null,
      idempotencyKey: i.idempotencyKey,
    }),
  threadCreate: (projectId, title) => invoke<{ thread: ThreadSummary }>("thread_create", { projectId, title: title ?? null }),
  threadUpdate: (threadId, patch) => invoke<{ thread: ThreadSummary }>("thread_update", { threadId, title: patch.title ?? null, archived: patch.archived ?? null }),
  intentStatus: (runId) => invoke<IntentRun>("intent_status", { runId }),
  intentResult: (runId) => invoke<string>("intent_result", { runId }),
  intentCancel: (runId) => invoke<IntentCancelReply>("intent_cancel", { runId }),
  intentList: () => invoke<IntentRun[]>("intent_list"),
  listModelConversations: () => invoke<ModelConversationSummary[]>("list_model_conversations"),
  modelRunStatus: (conversationId) => invoke<ModelRunStatus>("model_run_status", { conversationId }),
  cancelModelRun: (conversationId) => invoke<void>("cancel_model_run", { conversationId }),
  toolEvents: (taskInstanceId) => invoke<TaskToolEvents>("tool_events", { taskInstanceId }),
  listApprovals: (taskInstanceId) => invoke<ApprovalsView>("list_approvals", { taskInstanceId }),
  integrityStatus: () => invoke<IntegrityView>("integrity_status"),
};

const notInShell: UiError = {
  code: "unavailable",
  message: "Not running inside the Nexus native shell; no backend is reachable.",
};

/** Used in a plain browser (e.g. `vite dev`): everything reports unavailable. */
export const unavailableApi: NativeApi = {
  appInfo: () => Promise.reject(notInShell),
  runtimeStatus: () =>
    Promise.resolve({
      connection: "unavailable",
      detail: notInShell.message,
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
    }),
  listTasks: () =>
    Promise.resolve({ available: false, source: null, error: notInShell.message, tasks: [] }),
  taskJournal: () => Promise.reject(notInShell),
  modelCatalog: () => Promise.reject(notInShell),
  liveBlockers: () => Promise.reject(notInShell),
  runMock: () => Promise.reject(notInShell),
  conversationRead: () => Promise.reject(notInShell),
  modelIoRead: () => Promise.reject(notInShell),
  listMockConversations: () => Promise.resolve([]),
  intentModels: () => Promise.reject(notInShell),
  intentTargets: () => Promise.reject(notInShell),
  intentSubmit: () => Promise.reject(notInShell),
  intentWorkspaces: () => Promise.resolve([]),
  intentInspectSubmit: () => Promise.reject(notInShell),
  intentCodeSources: () => Promise.resolve([]),
  intentCodeLimits: () => Promise.reject(notInShell),
  codeLimitsSet: () => Promise.reject(notInShell),
  intentCodeSubmit: () => Promise.reject(notInShell),
  intentDiff: () => Promise.reject(notInShell),
  intentCopy: () => Promise.reject(notInShell),
  runtimeState: () => Promise.reject(notInShell),
  runtimeStart: () => Promise.reject(notInShell),
  providerConnect: () => Promise.reject(notInShell),
  providerConsent: () => Promise.reject(notInShell),
  providerRevoke: () => Promise.reject(notInShell),
  projectPick: () => Promise.reject(notInShell),
  projectList: () => Promise.resolve({ projects: [] }),
  projectRefresh: () => Promise.reject(notInShell),
  projectSetPolicy: () => Promise.reject(notInShell),
  projectForget: () => Promise.reject(notInShell),
  projectAdopt: () => Promise.reject(notInShell),
  threadList: () => Promise.resolve({ threads: [] }),
  threadGet: () => Promise.reject(notInShell),
  threadSend: () => Promise.reject(notInShell),
  threadCreate: () => Promise.reject(notInShell),
  threadUpdate: () => Promise.reject(notInShell),
  intentStatus: () => Promise.reject(notInShell),
  intentResult: () => Promise.reject(notInShell),
  intentCancel: () => Promise.reject(notInShell),
  intentList: () => Promise.resolve([]),
  listModelConversations: () => Promise.resolve([]),
  modelRunStatus: () => Promise.reject(notInShell),
  cancelModelRun: () => Promise.reject(notInShell),
  toolEvents: () => Promise.reject(notInShell),
  listApprovals: () => Promise.reject(notInShell),
  integrityStatus: () => Promise.reject(notInShell),
};

export function defaultApi(): NativeApi {
  return isTauri() ? tauriApi : unavailableApi;
}
