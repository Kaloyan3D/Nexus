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
