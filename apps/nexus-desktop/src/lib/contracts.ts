// Mirrors src-tauri/src/dto.rs. Keep field names in lockstep (camelCase).

export interface AppInfo {
  appVersion: string;
  clientApiVersion: number;
  ipcProtocol: number;
  platform: string;
  socketPath: string;
  ledgerDir: string | null;
  dispatchEnabled: boolean;
  liveReady: boolean;
}

export type Connection =
  | "connected"
  | "disconnected"
  | "unauthorized"
  | "malformed"
  | "unsafe"
  | "error"
  | "unavailable"; // frontend-only: not running inside the Tauri shell

export interface ReadinessDimension {
  name: string;
  ready: boolean;
  detail: string;
}

export interface RuntimeSnapshot {
  connection: Connection;
  detail: string | null;
  checkedAtMs: number;
  state: string | null;
  trustMode: string | null;
  incarnation: string | null;
  acceptedCommands: number | null;
  totalCommands: number | null;
  eventCount: number | null;
  witnessConfigured: boolean | null;
  witnessPresent: boolean | null;
  reconciliationRequired: boolean | null;
  peerUidEnforced: boolean | null;
  socketShared: boolean | null;
  startedAtUtc: string | null;
  activeClients: number | null;
  requests: number | null;
  refusals: number | null;
  errors: number | null;
  dispatchEnabled: boolean | null;
  readinessVerdict: string | null;
  readinessDimensions: ReadinessDimension[];
}

export type CheckStatus = "pass" | "fail" | "unknown";

export interface VerificationOutcome {
  name: string;
  status: CheckStatus;
  raw: string;
}

export interface TaskRecord {
  taskId: string;
  taskInstanceId: string | null;
  title: string;
  description: string;
  descriptionTruncated: boolean;
  status: string;
  boundEngine: string | null;
  executionClass: string | null;
  risk: string | null;
  attempt: number | null;
  maxAttempts: number | null;
  baseCommit: string | null;
  worktree: string | null;
  createdAtUtc: string | null;
  updatedAtUtc: string | null;
  completedAtUtc: string | null;
  acceptanceCriteria: string[];
  dependencies: string[];
  verificationRequired: string[];
  verificationOutcomes: VerificationOutcome[];
  failureSignatures: string[];
}

export interface TasksResult {
  available: boolean;
  source: string | null;
  error: string | null;
  tasks: TaskRecord[];
}

export interface JournalEvent {
  seq: number;
  kind: string;
  commandId: string | null;
  recordedAtUtc: string | null;
  payload: string;
}

export interface JournalResult {
  events: JournalEvent[];
  receiptCount: number;
  truncated: boolean;
}

export interface CatalogEntry {
  model: string;
  scope: string;
  origin: string;
  reasoning: string;
  live: boolean;
}

export interface ModelCatalog {
  source: "offline-mock-catalog";
  entries: CatalogEntry[];
  liveReady: boolean;
  blockers: string[];
  dispatchEnabled: boolean;
}

export interface LiveBlockers {
  ready: boolean;
  dispatchEnabled: boolean;
  blockers: string[];
}

export type MockEvent =
  | { type: "started"; runId: string }
  | { type: "step"; id: string; label: string }
  | { type: "stream"; index: number; kind: string; content: string }
  | { type: "conversation"; conversationId: string };

export interface MockCheck {
  id: string;
  label: string;
  status: "pass" | "fail";
  detail: string;
}

export interface MockResult {
  conversationId: string;
  runId: string;
  mock: true;
  text: string;
  attemptId: string;
  commandId: string;
  requestDigest: string;
  finishReason: string;
  usageInput: number;
  usageOutput: number;
  checks: MockCheck[];
  eventCount: number;
  durationMs: number;
}

export interface UiError {
  code: string;
  message: string;
}

/* ---------- Conversation (transcript contract nexus.transcript/v1) ---------- */

export type EventKind =
  | "user-message"
  | "controller-message"
  | "assistant-message"
  | "tool-call"
  | "tool-result"
  | "status"
  | "error"
  | "model-handoff";
export type Speaker =
  | "user"
  | "orchestrator"
  | "worker"
  | "reviewer"
  | "tool"
  | "runtime"
  | "controller";
export type InputClass =
  | "user-authored"
  | "controller-compiled"
  | "runtime-injected"
  | "tool-output"
  | "model-generated"
  | "system";
export type MessageState = "partial" | "final" | "interrupted";
export type TranscriptSource = "native-store" | "dsh-session-log" | "mock-fixture";

export interface TranscriptEvent {
  schema: string;
  eventId: string;
  messageId: string;
  revision: number;
  seq: number;
  revisionSeq: number;
  taskInstanceId: string;
  displayTaskId: string | null;
  attemptId: string | null;
  sessionId: string | null;
  turn: number | null;
  kind: EventKind;
  speaker: Speaker;
  actor: { agent: string | null; model: string | null; provider: string | null };
  inputClass: InputClass;
  timestampMs: number | null;
  state: MessageState;
  text: string | null;
  toolName: string | null;
  toolCallId: string | null;
  toolInput: string | null;
  isError: boolean | null;
  errorCode: string | null;
  source: TranscriptSource;
  recording: "recorded" | "assembled-from-chunks";
  redactions: number;
  truncated: boolean;
  originalLen: number | null;
}

export interface AttemptProvenance {
  attemptId: string;
  sequence: number;
  executionClass: string | null;
  sessionId: string | null;
  startedByTurn: number | null;
  startedAtUtc: string | null;
  binding: string;
}

export interface ConversationCoverage {
  recordsScanned: number;
  eventsEmitted: number;
  recordsInvalid: number;
  reasoningBlocksOmitted: number;
  redactions: number;
  truncatedFields: number;
  nestedToolDispatchesNotRendered: number;
  notes: string[];
}

export interface ConversationPage {
  events: TranscriptEvent[];
  total: number;
  firstSeq: number | null;
  lastSeq: number | null;
  hasEarlier: boolean;
  hasLater: boolean;
  headSeq: number | null;
}

export interface ConversationView {
  taskInstanceId: string;
  source: "native-store" | "dsh-session-log" | "none";
  available: boolean;
  reason: string | null;
  displayTaskId: string | null;
  attempts: AttemptProvenance[];
  page: ConversationPage;
  coverage: ConversationCoverage;
  integrityFailure: string | null;
}

export interface ModelRequestRecord {
  recordId: string;
  attemptId: string | null;
  sessionId: string;
  turn: number | null;
  timestampMs: number | null;
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  maxTokens: number | null;
  contextWindow: number | null;
  systemPrompt: string | null;
  systemPromptLen: number;
  systemPromptTruncated: boolean;
  toolNames: string[];
  redactions: number;
  source: TranscriptSource;
}

export interface ModelIoView {
  taskInstanceId: string;
  source: string;
  available: boolean;
  records: ModelRequestRecord[];
  note: string;
}

export interface MockConversationSummary {
  conversationId: string;
  firstPrompt: string;
  startedAtMs: number | null;
  events: number;
  finalized: boolean;
}

// ---- A5.1 controlled model-only runs ---------------------------------------
// Mirrors native/nexus-client `ModelRunStatus` / `ModelConversationSummary`.
// Display-only: the renderer cannot start, resend or authorize a run; it can
// only read status and request a fail-safe cancellation. No field here can
// carry a credential, grant or capability.

export type ModelRunStateName =
  | "accepted"
  | "target-selected"
  | "authorized"
  | "request-started"
  | "streaming"
  | "completed"
  | "cancelled"
  | "timed-out"
  | "provider-failed"
  | "uncertain"
  | "refused"
  | "failed";

export interface ModelConversationSummary {
  conversationId: string;
  firstPrompt: string;
  startedAtMs: number | null;
  state: ModelRunStateName | string;
  terminal: boolean;
  providerId: string | null;
  remoteModelId: string | null;
  /** `provider` | `loopback-test-double` */
  endpointKind: string | null;
}

export interface ModelRunStatus {
  conversationId: string;
  state: ModelRunStateName | string;
  terminal: boolean;
  providerId: string | null;
  remoteModelId: string | null;
  logicalModelId: string | null;
  endpointKind: string | null;
  attemptId: string | null;
  commandId: string | null;
  requestDigest: string | null;
  httpStatus: number | null;
  usageInputTokens: number | null;
  usageOutputTokens: number | null;
  finishReason: string | null;
  latencyMs: number | null;
  firstTokenMs?: number | null;
  providerRequestId?: string | null;
  providerResponseId?: string | null;
  errorCode: string | null;
  cancelRequested: boolean;
  text: string;
}

// ---- A5.3 intent broker ------------------------------------------------------
// Mirrors native/nexus-client `intent_client`. The renderer can submit text with
// an explicit model, read status and cancel. Nothing here carries a credential,
// grant, capability, URL, path or tool vocabulary.

export interface IntentRun {
  runId: string;
  requestId: string;
  clientId: string;
  state: string;
  terminal: boolean;
  intentType: string;
  responseMode: string;
  taskId: string | null;
  taskInstanceId: string | null;
  attemptId: string | null;
  commandId: string | null;
  conversationId: string | null;
  providerId: string | null;
  remoteModelId: string | null;
  logicalModelId: string | null;
  /** R-NATIVE-2 resolved target identity bound to this run (identity only). */
  routeId?: string | null;
  endpointKind: string | null;
  requestDigest: string | null;
  httpStatus: number | null;
  usageInputTokens: number | null;
  usageOutputTokens: number | null;
  finishReason: string | null;
  latencyMs: number | null;
  firstTokenMs?: number | null;
  providerRequestId?: string | null;
  providerResponseId?: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  cancelRequested: boolean;
  promptPreview?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  // ---- A5.5 repo-inspect progress (absent for model-only runs) ----
  workspaceId?: string | null;
  turn?: number;
  maxTurns?: number;
  toolCalls?: number;
  /** Limits the PERSON chose (absent = no limit; Nexus has none of its own). */
  maxToolCalls?: number;
  toolResultBytes?: number;
  stopReason?: string | null;
  toolActivity?: ToolActivity[];
  citationsVerified?: string[];
  citationsUnverified?: string[];
  // ---- A5.6 repo-code progress (absent for other run types) ----
  /** A6.1.1: verified outcome of a coding run (absent for other run types and for older brokers). */
  codingOutcome?: CodingOutcome | null;
  /** M4.1: the request asked for the website to be looked at. */
  visualRequested?: boolean;
  /** M4.1: `no-browser` | `model-cannot-see` when that could not be offered. */
  visualUnavailable?: string | null;
  /** M4.1: the answer claimed to have seen the page though no screenshot reached a model. */
  visualClaimUnsupported?: boolean;
  /** Statements in the final answer that contradict the run's receipts and survived the restatement. */
  answerConflicts?: string[];
  /** Compound verification commands whose exit 0 attested nothing and that were never re-established. */
  unresolvedUnattestedChecks?: number;
  /** Edits applied so far (a count, never a quota). */
  editsUsed?: number;
  /** Commands run so far (a count, never a quota). */
  testsUsed?: number;
  /** Every tool call the run recorded; `toolActivity` is only the latest ones (read the rest with `runActivity`). */
  activityTotal?: number;
  /** Turns whose conversation was shortened to stay inside the model context budget. */
  contextCompactions?: number;
  /** Provider interruptions the broker recovered from by itself. */
  recoveries?: number;
  continuationOf?: string | null;
  continuedAs?: string | null;
  autoAdopt?: string | null;
  lastRecovery?: string | null;
  /** `pass` / `fail` of the most recent approved test or build command. */
  lastTestVerification?: string | null;
  /** The operation currently waiting for an INDEPENDENT approver. */
  pendingApproval?: PendingApproval | null;
  /** M4.5: how much the run may do without asking; the audit trail of its decisions; what it installed. */
  permissionMode?: PermissionMode;
  pendingPermission?: PendingPermission | null;
  permissionEvents?: PermissionEvent[];
  dependencies?: DependencyRecord[];
  /** Commit the isolated working copy was created from. */
  worktreeCommit?: string | null;
  changedFiles?: ChangedFile[];
  diffDigest?: string | null;
  // ---- A7.1 conversations ----
  /** The conversation this run belongs to. */
  threadId?: string | null;
  /** The request was read-only: the broker refused every write for this run. */
  readOnly?: boolean;
  /** How the working copy relates to earlier runs: fresh | continued | rebased | fresh-by-choice. */
  workspaceRelation?: string | null;
  /** `direct` when this run edited the project's real folder in place (fixed at submission); absent = an isolated copy. */
  workspaceKind?: "direct" | null;
  workspaceNote?: string | null;
  /** macOS projects: where this run's result is on its way to the Mac folder (set by the Mac host, never by the engine). */
  hostSync?: HostSync | null;
  /** The earlier run whose working copy this run started from. */
  seedFrom?: string | null;
  /** Derived from the request and the receipts: fulfilled | no-change-verified | no-change-reported | incomplete. */
  /** fulfilled | no-change-verified | no-change-reported | incomplete | failing-checks | unattested-checks | unexecuted-claims */
  completion?: string | null;
  completionNote?: string | null;
  /** Verification commands whose latest result is a failure (counted over the whole run). */
  unresolvedFailedChecks?: number;
}

/**
 * What the RUNTIME verified about a coding run (A6.1.1), derived by the broker from
 * execution receipts only - never from model text and never from the lifecycle state.
 */
export interface CodingOutcome {
  /** verified-passed | verified-mixed | verified-failed | blocked-by-approval | no-test-executed | not-yet-verified | uncertain */
  verification: string;
  /** none-proposed | pending-approval | applied | partially-applied | not-applied | uncertain */
  change: string;
  editsApplied: number;
  editsNotApplied: number;
  testsExecuted: number;
  testsNotExecuted: number;
  blockedByApproval: number;
  lastExitCode: number | null;
  staleAfterEdit: boolean;
  uncertainOperations: number;
  /** Checks whose latest result is a failure and that were not re-run successfully (older brokers omit it). */
  checksFailedUnresolved?: number;
  /** Commands whose verdict proved nothing (a pipeline cut off or without pipefail). */
  checksUnverified?: number;
  /** Files the last passing check wrote only into its own throw-away copy (not saved to the project). */
  lastCheckUnsavedFiles?: number;
  /** M4.1: static checks, browser run, visual observation and visual assessment, kept apart. */
  evidence?: EvidenceLevels;
  /** Invalid-invocation checks still unresolved (also counted in `checksFailedUnresolved`) / resolved by Nexus's replacement. */
  checksInvalidUnresolved?: number;
  checksInvalidResolved?: number;
  /** Compound-command checks whose exit 0 attested nothing and that nothing re-established: block automatic writeback under every policy. */
  checksUnattestedUnresolved?: number;
  checksUnattestedResolved?: number;
}

/** One screenshot Nexus captured; `sha256` is of the stored bytes, which are what a vision model was shown. */
export interface ScreenshotRef {
  name: string;
  file: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  viewportW: number;
  viewportH: number;
  takenAt: string;
  /** `delivered` | `not-delivered` */
  delivery: string;
}

export interface BrowserStepResult {
  do: string;
  ok: boolean;
  error?: string | null;
}

/** M4.1: what Nexus itself measured and captured in one browser inspection (never what the page said). */
export interface BrowserEvidence {
  evidenceId: string;
  runId: string;
  url: string;
  viewport: string;
  viewportW: number;
  viewportH: number;
  startedAt: string;
  launched: boolean;
  loaded: boolean;
  httpStatus?: number | null;
  title?: string | null;
  steps: BrowserStepResult[];
  consoleErrors: number;
  consoleWarnings: number;
  pageErrors: number;
  failedRequests: number;
  blockedRequests: number;
  horizontalOverflow?: boolean | null;
  screenshots: ScreenshotRef[];
  /** delivered-to-vision-model | not-delivered-text-only-model | not-delivered-unknown-model | not-delivered-too-large | no-screenshot */
  imageDelivery: string;
  durationMs: number;
  error?: string | null;
}

/** Four different kinds of evidence; never merged. */
export interface EvidenceLevels {
  /** none | passed | failed | unverified */
  staticChecks: string;
  /** none | passed | failed */
  browserRuntime: string;
  /** none | captured-not-seen | seen-by-model */
  visualObservation: string;
  /** none | model-stated (a judgement, never "verified") */
  visualAssessment: string;
  visualBasis: string[];
  visualRequested: boolean;
  /** not-requested | met | unmet-no-browser | unmet-model-cannot-see | unmet-browser-failed | unmet-not-attempted | unmet-stale-after-edit */
  visualRequirement: string;
  browserRuns: number;
  inspectedAfterLastEdit: boolean;
  unsupportedVisualClaim: boolean;
}

/** One stored screenshot (base64 of the exact stored bytes). */
export interface BrowserArtifact {
  mediaType: string;
  bytes: number;
  sha256: string;
  dataB64: string;
}

/** M4.6: execution analytics of one run (derived by the engine from the run's own records). Every metric the run could
 *  not measure is `null` and listed in `missing` with the reason; null is never shown as zero. */
export interface RunAnalytics {
  schemaVersion: number;
  runId: string;
  source: { perRequestRecord: boolean; perToolRecord: boolean; runRecord: boolean; toolActivity: boolean };
  identity: { engine?: { modeId?: string | null; engineId?: string | null; defaultEffort?: string | null; effort?: unknown } | null; permissionMode: PermissionMode | null; host?: { engineOs?: string; engineArch?: string; hostPlatform?: string | null; appVersion?: string | null }; controllerVersion?: string };
  runtime: {
    startedAtMs: number;
    endedAtMs: number | null;
    wallMs: number | null;
    state: string;
    terminal: boolean;
    categoriesExclusive: { modelRequestMs: number | null; toolExecutionMs: number | null; approvalWaitMs: number | null; controllerMs: number | null };
    overlapping: { timeToFirstTokenMs: { avg: number | null; min: number | null; max: number | null; samples: number }; buildAndTestMs: number | null };
    requests: { count: number; avgLatencyMs: number | null; minLatencyMs: number | null; maxLatencyMs: number | null; latenciesMs: number[] };
    outputTokensPerSecond: number | null;
    recordCapped: boolean;
  };
  tokens: {
    source: "per-request" | "run-record-cumulative" | "none";
    input: number | null;
    output: number | null;
    total: number | null;
    cachedInput: number | null;
    cacheWrite: number | null;
    noncachedInput: number | null;
    reasoning: number | null;
    cacheHitRate: number | null;
    byAttempt: Array<{ ordinal: number; turn: number; model: string; effort: string; phase: string; outcome: string; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; reasoningTokens: number | null; latencyMs: number; ttftMs: number | null }>;
    byModel: Array<{ model: string; requests: number; inputTokens: number; outputTokens: number; cachedInputTokens: number | null; reasoningTokens: number | null; latencyMs: number; cacheHitRate: number | null }>;
    byPhase: Array<{ phase: string; requests: number; inputTokens: number; outputTokens: number; cachedInputTokens: number | null; reasoningTokens: number | null; latencyMs: number; cacheHitRate: number | null }>;
  };
  routing: {
    configured: { provider?: string | null; model?: string | null; logicalModel?: string | null; route?: string | null };
    requests: Array<{ ordinal: number; provider: string; model: string; actualModel?: string | null; effort: string; phase: string; outcome: string; routedAsConfigured: boolean | null }>;
    attemptsPerModel: Array<{ model: string; attempts: number }>;
    attemptsPerEffort: Record<string, number>;
    modelSwitches: number;
    phaseTransitions: Array<{ atMs: number; phase: string; detail: string }>;
  };
  tools: {
    modelRequested: number | null;
    recordedCalls: number;
    succeeded: number;
    failed: number;
    refusedOrDenied: number;
    byTool: Array<{ tool: string; calls: number; succeeded: number; failed: number; refusedOrDenied: number }>;
    executionMs: number | null;
    approvalWaitMs: number | null;
    buildAndTestMs: number | null;
    fileEdits: { proposed: number; applied: number; conflicts: number };
    commands: Array<{ index: number; command: string; status: string; exitCode: number | null; verification: string | null; execMs: number | null; waitMs: number | null }>;
    dependencyInstalls: { requests: number; approved: number; denied: number; automatic: number };
    permissionPrompts: number;
  };
  verification: { cycles: number; failedAttempts: number; recoveryCycles: number | null; providerRecoveries?: number | null; finalVerification: string | null; completion?: string | null; evidence: Array<{ callIndex: number; command: string; exitCode: number | null; verification: string | null }> };
  cost: { providerListPrice?: { usd: number | null }; actual: { usd: number | null; requestsReporting: number; requestsTotal: number }; estimated: { usd: number | null }; display: "actual" | "estimated" | "unknown" };
  missing: Array<{ metric: string; reason: string }>;
}

/** M4.5: the three permission modes. */
export type PermissionMode = "ask" | "auto-safe" | "full";

/** M4.5: an operation waiting for the person's decision (made in a native confirmation, never in the page). */
export interface PendingPermission {
  requestId: string;
  /** `dependency-install` | `delete` | `bulk-delete` */
  kind: string;
  digest: string;
  program: string;
  args: string[];
  cwd: string;
  plan?: { manager: string; verb: string; packages: Array<{ name: string; constraint: string }>; options: string[]; fromManifest: boolean } | null;
  purpose: string;
  mode: PermissionMode;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface PermissionEvent {
  atMs: number;
  kind: string;
  mode: PermissionMode;
  requestId?: string;
  digest?: string;
  detail?: string;
}

export interface DependencyRecord {
  atMs: number;
  manager: string;
  verb: string;
  packages: string[];
  command: string;
  mode: PermissionMode;
  decision: string;
  outcome: string;
  exitCode?: number | null;
}

/** An operation waiting for an independent approval (A5.6). Desktop only shows it. */
export interface PendingApproval {
  approvalId: string;
  tool: string;
  summary: string;
  requestDigest: string | null;
  expiresAtMs: number | null;
  /** `edit` | `write` | `command` (A6.1). */
  operation?: string | null;
  /** File path inside the working copy, or the executable. */
  target?: string | null;
  /** The MODEL'S proposal (changed lines / argv); the approver reviews the daemon-derived diff. */
  proposal?: string | null;
  /** Fixed restrictions that apply to this operation. */
  restrictions?: string[];
  createdAtMs?: number | null;
}

/**
 * What bounds a coding task. Nexus has NO limit of its own on steps, edits, written bytes, commands or time; these
 * are only the limits the person (Settings) or the operator chose to bound cost or time. Absent = no limit.
 */
export interface DesktopCodeLimits {
  maxTurns?: number;
  maxToolCalls?: number;
  maxRuntimeSecs?: number;
  /** How long an approval stays decidable (broker-defined; operators can only shorten it). */
  approvalLifetimeSecs?: number;
}

/** One page of every tool call of a run, oldest first. */
export interface ActivityPage {
  total: number;
  offset: number;
  activity: ToolActivity[];
}

/** Read-only facts about a run's retained isolated working copy (never a path). */
export interface CopyInfo {
  retained: boolean;
  active: boolean;
  projectId?: string | null;
  baseCommit?: string | null;
  ageMs?: number | null;
  approxBytes?: number | null;
}

export interface ChangedFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

/** A source repository the operator lets this user have modified (identity only). */
export interface AllowedCodeSource {
  sourceId: string;
  /** The exact commit the operator pinned this project to (read-only display). */
  pinnedCommit?: string | null;
  /** Files or `dir/` prefixes the model may propose writes to; empty/absent = the whole project. */
  writeAllow?: string[];
  /** A6.1.4: display name, detected kinds and origin of a project opened from the Desktop. */
  label?: string | null;
  managed?: boolean;
  kinds?: string[];
}

/** A6.1.4 interactive profile: what the native backend reports about its runtime. */
export interface RuntimeState {
  /** `interactive`: this app runs the runtime. `external`: an operator-run broker (strict profile). */
  mode: "interactive" | "external";
  /** `unavailable`: this platform has no engine connected (macOS desktop-only mode); nothing was started. */
  phase: "starting" | "ready" | "error" | "stopped" | "unavailable";
  message: string | null;
  home: string | null;
  /** Connection facts for Settings → Diagnostics (never shown in the main panels). */
  diagnostics?: string[];
  providerConnected: boolean;
  consent: { given: boolean; providerId: string | null; remoteModelId: string | null; text: string | null };
  /** The broker can open project folders (interactive profile). */
  canOpenProjects: boolean;
  updatePending?: boolean;
  /** How to decide a pending operation of a project that asks: the trusted terminal approver, with this installation's real paths. */
  approverCommand?: string | null;
  /** Which Node.js runs Nexus itself: `bundled` = shipped and verified with the application. */
  node?: { source: "bundled" | "system"; version: string | null } | null;
}

export interface ProjectKindView {
  id: string;
  label: string;
  supported: boolean;
}

export type WorkspaceMode = "direct" | "isolated";

/** What this installation can really do with permissions (asked of the runtime, never assumed). */
export interface PermissionSupport {
  /** false = the runtime could not be asked just now; nothing is offered or changed meanwhile. */
  known: boolean;
  standingGrants: boolean;
  /** An approver channel exists, so "Ask me first" can be answered. */
  askAvailable: boolean;
  askReason: string | null;
  /** In-place commands (Landlock + launch gate) can run on this machine; absent = not reported. */
  inPlaceAvailable?: boolean;
  /** M8: Full Access (unsandboxed host execution) is available on this installation. */
  hostExecAvailable?: boolean;
  hostExecReason?: string | null;
  inPlaceReason?: string | null;
  /** Controlled Internet (the network gatekeeper) can run on this machine; absent = not reported. */
  controlledAvailable?: boolean;
  controlledReason?: string | null;
}

export interface ProjectListReply {
  projects: ProjectView[];
  permissions?: PermissionSupport;
}

export type GrantStatus = "active" | "expired" | "revoked";

/** The user's standing permissions for a project (what its tasks' commands may do). */
export interface ProjectGrantView {
  grantId: string;
  version: number;
  digest: string;
  /** `scratch`: commands work on a throw-away copy. `workspace`: they change the task's working copy in place. */
  fs: "scratch" | "workspace" | "full";
  net: "offline" | "controlled" | "install" | "full";
  /** Controlled Internet: the destinations commands may reach (an allowlist of WHERE, not of what is sent). */
  netPolicy?: { hosts: { host: string; ports: number[] }[]; local_ports?: number[] };
  /** `auto`: inside the grant, no prompt. `ask`: every operation waits for the independent approver. */
  approval: "ask" | "auto";
  /** Development-server ports (inside the sandbox) the owner allows to be shown on this computer. */
  devPorts?: number[];
  /** Recovery policy and Git choice: shown, kept when permissions are edited, never offered as controls. */
  checkpoint?: "off" | "best-effort" | "required";
  hardLinks?: "protect" | "allow";
  gitWrite?: boolean;
  expiresAtMs: number | null;
  createdAtMs: number;
  createdBy: string;
  status: GrantStatus;
  revokedAtMs: number | null;
  history: { atMs: number; kind: string; version: number; by: string }[];
}

export interface JobView {
  jobId: string;
  /** The project the job runs in (absent on records from before Release 1). */
  projectId?: string;
  state: string;
  command: string;
  task: string;
  startedAtMs: number;
  endedAtMs?: number | null;
  exitCode?: number | null;
  exposed: { port: number; hostPort: number; url: string }[];
  ready: boolean;
  logBytes: number;
  logTruncated: boolean;
}

/** macOS projects: synchronization of one run's result with the Mac folder. */
export interface HostSync {
  state: "staging" | "running" | "exporting" | "prepared" | "applying" | "applied" | "conflict" | "failed" | "not-applied";
  /** Plain-language status, written by the Mac host. */
  label: string;
  changed: { path: string; kind: "add" | "modify" | "delete" }[];
  conflicts: { path: string; reason: string }[];
  verification?: string | null;
  appliedMs?: number | null;
  message?: string | null;
  /** Where Nexus's result is kept when it could not be applied. */
  savedResult?: string | null;
}

/** macOS projects: synchronization status of the folder. */
export interface ProjectSync {
  state: "staging" | "running" | "exporting" | "prepared" | "applying" | "conflict" | "failed" | "synced";
  generation: number;
  lastSyncMs?: number | null;
  consent: boolean;
  /** The person chose to also apply results that could not be verified (projects without tests). */
  applyUnverified?: boolean;
  files: number;
  skippedTotal: number;
  conflicts: { path: string; reason: string }[];
}

export interface ProjectView {
  projectId: string;
  /** macOS projects: the folder on the Mac (the engine's own copy is never shown). */
  macPath?: string;
  sync?: ProjectSync;
  label: string;
  managed: boolean;
  kinds: ProjectKindView[];
  pinnedCommit: string;
  writeAllow: string[];
  /** Nexus may install this project's dependencies (network, in the sandbox, install commands only). */
  installs?: boolean;
  /** Trusted workspace: finished, verified work is applied to the user's folder automatically. */
  trusted?: boolean;
  /** Where NEW tasks edit: `direct` = this project's real folder, in place; `isolated` (or absent) = a throw-away copy. */
  workspaceMode?: WorkspaceMode;
  /** Standing permissions; absent = the defaults (throw-away copy, no network, automatic approval). */
  grant?: ProjectGrantView;
  snapshotAtMs: number;
  originDirty: boolean;
  /** True when the folder changed since Nexus last copied it (new tasks refresh automatically). */
  changedSinceSnapshot: boolean | null;
}

export interface ProjectOpenReply {
  project: ProjectView;
  created: boolean;
  snapshot: { files: number; bytes: number; skippedTotal: number; skipped: { path: string; reason: string }[] };
}

export interface ConnectReport {
  verified: boolean;
  checks: string[];
}

/** The reviewable result of a repo-code run, from the isolated working copy. */
export interface DiffReply {
  run: IntentRun;
  baseCommit: string;
  files: ChangedFile[];
  filesTruncated: boolean;
  diff: string;
  diffDigest: string;
  diffTruncated: boolean;
}

/** One model-proposed read-only tool call and what became of it (A5.5). */
export interface ToolActivity {
  /** M4.5: the mode in force when the command was decided, its class and how it was decided. */
  permissionMode?: PermissionMode | null;
  opClass?: string | null;
  permissionDecision?: string | null;
  /** Process: files the command created/changed/deleted in its throw-away copy that were NOT saved to the project. */
  unsavedFiles?: number;
  index: number;
  turn: number;
  callId: string;
  /** `fs_list` | `fs_read` | `fs_search`, or what the model asked for. */
  tool: string;
  argsSummary: string;
  /** `executed` | `refused` | `failed` | `cancelled` */
  status: string;
  errorCode: string | null;
  resultBytes: number;
  resultDigest: string | null;
  truncated: boolean;
  executionId: string | null;
  journalSeq: number | null;
  argsDigest: string | null;
  // ---- A5.6 (write/edit/command calls only) ----
  approvalId?: string | null;
  /** `approved` | `denied` | `expired` | `revoked` | `cancelled` | `timed-out` */
  approvalOutcome?: string | null;
  /** `automated-policy` when the daemon's workspace policy (never a person) granted it. */
  approvalActor?: string | null;
  preSha256?: string | null;
  postSha256?: string | null;
  exitCode?: number | null;
  /** `pass` | `fail` for a command. */
  verification?: string | null;
  /** `job_start` only: the development-server ports the model asked to show. A request, never an authorization. */
  requestedPorts?: number[] | null;
  /** M4.1: `browser_inspect` only. */
  browser?: BrowserEvidence | null;
  /** `invalid-invocation` (a check that never examined the project; stays unresolved) | `controller-recheck` (Nexus's own replacement). */
  checkClass?: string | null;
  /** On a passing `controller-recheck`: the call index of the invalid check it resolves. */
  resolvesCheck?: number | null;
  /** `executable-not-found` (exit 127) | `not-executable` (exit 126): the process says a program named inside the command is missing or not executable. Not a permission decision. */
  processClass?: string | null;
  /** The Core's own assessment of a verification command (kept apart from `verification`, the Kernel's verdict): `unverified` when its exit status cannot attest every check in it. */
  assessment?: string | null;
  /** `attested` | `unattested` | `unanalyzable`, with the reason after a colon. */
  composition?: string | null;
  /** On an `attested-recheck`: the call indices of the unattested checks it re-established. */
  resolvesHazards?: number[];
  /** M4.7: on an attested pass, the steps of earlier failed compound checks it re-established. */
  resolvesFailed?: number[];
}

/** An operator-approved read-only workspace, by identity only (never a path). */
export interface AllowedWorkspace {
  workspaceId: string;
}

export interface AllowedModel {
  providerId: string;
  remoteModelId: string;
  logicalModelId: string;
  endpointKind: string;
  outputLimitTokens: number;
}

/** R-NATIVE-3: one broker `intent-models` target (read-only status, identities only). */
export interface RegistryTarget {
  providerId: string;
  logicalModelId: string;
  remoteModelId: string;
  routeId: string;
  /** Omitted by the broker when the route has no connection. */
  connectionId?: string | null;
  connectionStatus: string;
  protocol: string;
  contextLimitTokens: number;
  outputLimitTokens: number;
  billingTier: string;
  /** Omitted by the broker when the model declares none. */
  dataUse?: string | null;
  issuable: boolean;
  /** Machine reason, present exactly when the target is not issuable. */
  reason?: string | null;
}

/** R-NATIVE-3: identities-only model selection (never a path, limit or credential). */
export interface ModelSelection {
  providerId: string;
  remoteModelId: string;
  logicalModelId?: string | null;
  routeId?: string | null;
}

/** R-NATIVE-3: a conversation's bound target (identities only). */
export interface ThreadTarget {
  providerId: string;
  remoteModelId: string;
  logicalModelId: string;
  routeId: string;
  /** Phase 2: the engineering mode (engine) the conversation is bound to; absent for historical conversations. */
  modeId?: string | null;
}

export interface IntentSubmitReply {
  run: IntentRun;
  replay: boolean;
}

export interface IntentCancelReply {
  run: IntentRun;
  outcome: string;
}

export interface ConversationQuery {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
}

// ---- A3.1 native read-only tool events -------------------------------------
// Mirrors native/nexus-tools `ToolEventV1`. Derived from the Kernel's
// authoritative tool journal; the renderer only *displays* these. It never
// executes tools and never authors them. `aiInitiated` is always false in
// A3.1 (live AI-initiated tool execution is disabled).

export type ToolEventStatus =
  | "authorized"
  | "started"
  | "planned"
  | "prepared"
  | "applied"
  | "verified"
  | "conflict"
  | "completed"
  | "failed"
  | "interrupted"
  | "expired"
  | "cancelled"
  | "running"
  | "exited";

/** Sandboxed process metadata (A3.4). Output tails are bounded + redacted. */
export interface ToolProcess {
  command?: string;
  program?: string;
  argvDigest?: string;
  cwd?: string;
  snapshotDigest?: string;
  snapshotFiles?: number;
  snapshotBytes?: number;
  sandboxDigest?: string;
  sandbox?: {
    backend?: string;
    network?: string;
    rootfs?: string;
    workspace?: string;
    writeBack?: string;
    env?: string;
  };
  limits?: { wallMs?: number; cpuSecs?: number; memoryBytes?: number; maxProcs?: number };
  exitCode?: number | null;
  signal?: number | null;
  /** termination reason: exited | timeout | memory-limit | process-limit | cancelled | revoked */
  terminationReason?: string;
  verification?: "pass" | "fail";
  wallMs?: number;
  userMs?: number;
  sysMs?: number;
  peakRssBytes?: number;
  peakProcs?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutTail?: string;
  stderrTail?: string;
  processStarted?: boolean;
  /** interrupted executions: never-started | uncertain */
  outcome?: string;
}

/** Pre/post-image metadata of a write or edit (never file content). */
export interface ToolChange {
  operation?: "create" | "replace" | "edit";
  path?: string;
  preSha256?: string | null;
  postSha256?: string;
  postBytes?: number;
  /** none | applied | applied-unverified | published-unverified | uncertain */
  mutation?: string;
  observed?: string;
  observedSha256?: string | null;
  conflict?: string;
  /** Name a displaced/modified file was preserved under (never deleted). */
  preservedAs?: string | null;
  /** false = single-identity TEST approval; not an independent approver. */
  approverIndependent?: boolean | null;
  displacedPreserved?: boolean;
  publishedOverUnexpectedPreImage?: boolean;
}

export interface ToolEventV1 {
  schemaVersion: 1;
  requestId: string;
  executionId: string;
  taskInstanceId: string;
  attemptId: string;
  commandId: string;
  toolId: "fs.list" | "fs.read" | "fs.search" | "fs.write" | "fs.edit" | "proc.run";
  toolVersion: number;
  /** `write` grants required an independently approved write scope. */
  scope: "read" | "write" | "process";
  status: ToolEventStatus;
  /** Redacted argument metadata (search queries appear as length + digest). */
  args: Record<string, unknown> | null;
  resultStatus: "ok" | "truncated" | "error" | null;
  errorCode: string | null;
  truncated: boolean;
  truncationReasons: string[];
  /** True when returned content had secrets redacted (see redactionKinds). */
  redacted: boolean;
  redactionKinds: string[];
  outputDigest: string | null;
  outputBytes: number | null;
  stats: Record<string, number> | null;
  /** Write tools only: proposed/applied change metadata. */
  change: ToolChange | null;
  /** Process tools only: sandboxed execution identity, exit and usage. */
  process: ToolProcess | null;
  aiInitiated: boolean;
  /** Lease generation the request was authorized under. */
  leaseEpoch: number | null;
  firstSeq: number;
  lastSeq: number;
  authorizedAtUtc: string;
  lastAtUtc: string;
}

/** One authoritative attempt of a task and its tool events (never merged). */
export interface AttemptToolEvents {
  attemptId: string;
  sequence: number;
  events: ToolEventV1[];
  complete: boolean;
  /** Set when the daemon refused or could not serve this attempt. */
  error: string | null;
}

/**
 * Tool events for a task instance, grouped by the attempts the Controller
 * attempt journal records. `available=false` means no authoritative attempt
 * list exists: the UI must show that state, never guess an attempt id.
 */
export interface TaskToolEvents {
  available: boolean;
  reason: string | null;
  attempts: AttemptToolEvents[];
}

/**
 * One human-approval request (A4.2). Status only: it carries no diff, argv
 * text, review code or credential. Approve/Deny exist only in the trusted
 * terminal approver, never in this renderer.
 */
export interface ApprovalRecord {
  approvalId: string;
  state: "pending" | "approved" | "denied" | "expired" | "revoked" | "consumed";
  commandId: string;
  taskInstanceId: string;
  attemptId: string;
  toolId: string;
  scope: "write" | "process";
  requestDigest: string;
  paths: string[];
  operationKind: string | null;
  createdMs: number;
  expiresMs: number;
  decidedMs: number | null;
  decision: string | null;
  decisionReason: string | null;
  approverId: string | null;
  humanAuthMechanism: string | null;
  grantRequestId: string | null;
}

export interface ApprovalsView {
  available: boolean;
  reason: string | null;
  /** Always "terminal-only": the GUI never approves. */
  approvalAction: "terminal-only";
  approvals: ApprovalRecord[];
}

/**
 * Journal integrity (A4.3). `scope` always states what was verified; the UI
 * must show it next to the state and never render a generic "secure" badge.
 */
export interface JournalIntegrity {
  journal: string;
  localCount: number;
  witnessCount: number | null;
  status: string;
  detail: string;
}

export interface IntegrityView {
  state:
    | "verified"
    | "unanchored-legacy"
    | "witness-unavailable"
    | "recovery-required"
    | "integrity-mismatch"
    | "not-configured";
  scope: string;
  configured: boolean;
  journals: JournalIntegrity[];
  detail: string;
}


// ---- A7.1 persistent conversations ------------------------------------------------

/** One row of the conversation list (History, Recent, switching). */
export interface ThreadSummary {
  threadId: string;
  projectId: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  archived: boolean;
  /** Built from a single-run record that predates conversations. */
  legacy: boolean;
  runCount: number;
  messageCount: number;
  lastPreview: string;
  /** Lifecycle of the LAST run (not of the conversation). */
  lastState: string;
  /** A run of this conversation is in progress. */
  active: boolean;
  activeRunId: string | null;
  findingCount: number;
  /** R-NATIVE-3: the conversation's bound target (identities only; absent when unbound). */
  target?: ThreadTarget | null;
}

export interface ThreadMessage {
  seq: number;
  role: "user" | "assistant" | "system";
  /** request | answer | note */
  kind: string;
  runId: string | null;
  atMs: number;
  text: string;
  truncated: boolean;
}

export interface ThreadReceipt {
  tool: string;
  summary: string;
  status: string;
  verdict?: string | null;
}

/** What the runtime recorded about a finished run (kept beyond the run record's bounded activity list). */
export interface ThreadRunDigest {
  filesTouched: string[];
  changedTotal: string[];
  editsApplied: number;
  receipts: ThreadReceipt[];
  verification: string;
  change: string;
  lastTest: string | null;
  turns: number;
  toolCalls: number;
  recoveries: number;
  compactions: number;
  stopReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** What the model was given of the conversation when a run started. */
export interface ThreadContextInfo {
  bytes: number;
  sha256: string;
  priorRuns: number;
  findings: number;
}

export interface ThreadRunView {
  runId: string;
  n: number;
  userSeq: number | null;
  assistantSeq: number | null;
  /** review (read-only) | edit */
  mode: string;
  readOnly: boolean;
  /** Why the mode is what it is, in words for the user. */
  modeReason: string;
  continuationOf: string | null;
  state: string;
  ended: boolean;
  startedAtMs: number;
  endedAtMs: number | null;
  digest: ThreadRunDigest | null;
  /** Absent on the first run of a conversation. */
  context?: ThreadContextInfo | null;
  /** The broker's live record of the run (verified outcome, tool activity, ...). */
  run: IntentRun | null;
}

export interface ThreadFinding {
  id: string;
  title: string;
  detail: string;
  runId: string;
  addressedIn: number | null;
  addressedVerification: string | null;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: ThreadMessage[];
  runs: ThreadRunView[];
  findings: ThreadFinding[];
  head: { runId: string; n: number; changedFiles: number } | null;
}

export interface ThreadSendReply {
  threadId: string;
  run: IntentRun;
  replay: boolean;
  mode?: { readOnly: boolean; reason: string };
}

export type ThreadMode = "auto" | "review" | "edit";

/** The broker's own answer to "may this run be resumed now?" (never decided by the Desktop). */
export interface RunResumable {
  run: string;
  resumable: boolean;
  code: string | null;
  reason: string | null;
}
/** Phase 2: which engine NEW tasks use. `adaptive` = Nexus Adaptive (recommended), `stable` = the historical muse-v0. */
export type EngineKind = "adaptive" | "stable";
/** The operator's engine choice and whether Nexus Adaptive can be used right now (read from the saved Registry configuration). */
export interface EngineChoiceView {
  preferred: EngineKind;
  adaptiveAvailable: boolean;
  /** Why adaptive cannot be used (actionable), when it cannot. */
  adaptiveReason: string | null;
  adaptiveModel: string | null;
  adaptiveRoute: string | null;
  /** The engine a new task would use right now; null = none until adaptive is set up or Stable is chosen. Never silently the other engine. */
  effective: EngineKind | null;
}
/** The result of the explicit adaptive setup (the provider's answers; nothing is ever recorded as verified without them). */
export interface AdaptiveSetupReport {
  verified: boolean;
  checks: string[];
}
/** What a run's engine DURABLY recorded (from the broker's authenticated engine-state record). */
export interface RunEngineSummary {
  run: string;
  live: boolean;
  bound: { engineId: string | null; modeId: string | null; route: string | null };
  record: null | {
    authenticated: boolean;
    engineId: string;
    modeId: string;
    defaultEffort: string;
    revision: number;
    attempts: Array<{ ordinal: number; effort: string; state: string }>;
    events: Array<{ kind: string; attempt: number | null; effort: string | null; detail: string | null }>;
    lineage: string | null;
    limiter: { droppedBefore?: boolean; rearmTokensUsed?: number } | null;
  };
}
export interface ThreadSendInput {
  threadId: string | null;
  projectId: string;
  content: string;
  mode: ThreadMode;
  /** `fresh` starts from the project's current files instead of the conversation's workspace. */
  workspace: "continue" | "fresh";
  idempotencyKey: string;
  /** M4.5: how much the run may do without asking. Absent = Ask for Approval. */
  permissionMode?: PermissionMode;
  /** R-NATIVE-3: optional identities-only selection. Absent = broker default. */
  model?: ModelSelection | null;
  /** Phase 2: the engine for a NEW conversation (ignored for an existing one, which keeps its own). */
  engine?: EngineKind | null;
}

/** Release 1: the bounded, redacted output of a background job. */
export interface JobLogs {
  jobId: string;
  logs: string;
}

/** Release 1: what this computer offers the application (first-run guidance; read-only). */
export interface EnvCheck {
  platform: string;
  dialogTool: string | null;
  opener: string | null;
  /** [program, found] */
  toolchains: [string, boolean][];
}

/** One path in a recovery report. */
export interface RestoreItem {
  path: string;
  detail: string;
}

/** What a guarded restore would do (or did). Preview changes nothing. */
export interface RestoreReport {
  executionId: string;
  dryRun: boolean;
  /** `refused` | `completed` | `partial` | `nothing-restored` */
  outcome: string;
  refused: string | null;
  checkpointStatus?: string | null;
  restored: RestoreItem[];
  skipped: RestoreItem[];
  conflicted: RestoreItem[];
  unrecoverable: RestoreItem[];
  recordListsTruncated: boolean;
  note: string;
}

/** Restoring the files Nexus's edit tools wrote in the project folder (one run). Same shape, no command ledger. */
export interface EditRestoreReport {
  dryRun: boolean;
  outcome: string;
  refused: string | null;
  restored: RestoreItem[];
  skipped: RestoreItem[];
  conflicted: RestoreItem[];
  unrecoverable: RestoreItem[];
  note: string;
}
export interface EditRestorePreview {
  edits: EditRestoreReport;
  confirmDigest: string;
}

export interface RestorePreview {
  restore: RestoreReport;
  /** Binds a later apply to exactly this preview. */
  confirmDigest: string;
}

/** A category of changed paths: the exact count, and as many paths as were recorded. */
export interface PathList {
  count: number;
  paths: string[];
  truncated: boolean;
}

/** What one in-place command changed, trimmed for display. */
export interface ExecEffects {
  effects: {
    executionId: string;
    /** `observed` | `partial` | `uncertain` */
    outcome: string;
    outcomeReasons: string[];
    fsScope: string;
    startedMs: number;
    endedMs: number;
    process: { exited: boolean; how: string; exitCode: number | null; settled: boolean };
    effects: {
      created: PathList;
      modified: PathList;
      deleted: PathList;
      listsMayBeIncomplete: boolean;
    };
    recoverability?: { complete: boolean; available: number; unavailable: number; newPaths: number; bulkNotCaptured: number };
    note: string;
  };
}
