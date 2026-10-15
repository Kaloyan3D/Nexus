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
  | "completed"
  | "failed"
  | "interrupted";

export interface ToolEventV1 {
  schemaVersion: 1;
  requestId: string;
  executionId: string;
  taskInstanceId: string;
  attemptId: string;
  commandId: string;
  toolId: "fs.list" | "fs.read" | "fs.search";
  toolVersion: number;
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
  aiInitiated: boolean;
  firstSeq: number;
  lastSeq: number;
  authorizedAtUtc: string;
  lastAtUtc: string;
}
