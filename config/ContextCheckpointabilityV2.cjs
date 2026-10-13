'use strict';
/**
 * ContextCheckpointabilityV2.cjs - CCV2-A07 CheckpointabilityGate authority.
 *
 * ONE authority for the V2 checkpointability decision: required-state
 * classification, coverage rules, representability policy, stable refusal
 * reasons, pre-build evaluation, and post-build coverage verification. No
 * other V2 component redefines checkpointable.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md (A07
 * sections). A07 answers exactly ONE question and NOTHING else:
 *
 *   Can the current authoritative task state be represented by a CCv2
 *   checkpoint completely enough to resume correctly without silently
 *   losing required task semantics?
 *
 * Core invariant (frozen): CCv2 may forget from the prompt. CCv2 must never
 * forget from the task.
 *
 * Authorities consumed verbatim (never redefined here): A06
 * validateSafePointDecision / assertCheckpointBindsSafePoint, A05
 * validateSnapshotToken / revalidate, A03 validateCheckpointV2 / BOUNDS /
 * redaction / canonical serialization, A04 CLOSED_TRUST_RULES /
 * normalizeField / mandatoryProvenancePaths. A valid ContentSeal NEVER
 * substitutes for coverage.
 *
 * Frozen distinctions: A05 asks whether this is still the same
 * authoritative state; A06 asks whether this is a coherent execution
 * boundary; A07 asks whether this state can be represented safely by the
 * checkpoint contract. A safe point is NOT automatically checkpointable.
 * A fresh snapshot is NOT automatically checkpointable.
 *
 * NOT implemented here: A08 pressure/retention, A09 shadow mode, A10
 * transactional apply, automatic checkpoint triggering, automatic
 * compaction, context pages, context compiler, compression policy, LLM
 * summarization, JEV / Laya, Nexus Nova.
 *
 * Determinism: no clock, no randomness, no LLM. Identical authoritative
 * state plus identical safe-point/snapshot inputs yields identical
 * decision, inventory, digests, and blockers.
 *
 * Security: classification derives ONLY from authority metadata
 * (sourceKind/fieldKind/ids/flags/bounds). Repository/tool/model TEXT is
 * inert data: redacted and hashed for digests, compared for presence,
 * never branched on. Secrets never enter inventories (redacted digests
 * only, per frozen A03/A04 redaction semantics).
 */

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const snapshotV2 = require('./ContextSnapshotV2.cjs');
const safepointV2 = require('./ContextSafePointV2.cjs');
const trustV2 = require('./ContextTrustV2.cjs');

const CHECKPOINTABILITY_SCHEMA_VERSION = 1;

// Frozen digest domains. Exact formulas:
//   requiredStateDigest = sha256Hex(UTF8(domain LF canonicalJson(
//     normalizedRequiredStateInventory)))
//   representedStateDigest = sha256Hex(UTF8(domain LF canonicalJson(
//     normalizedRepresentedInventory)))
// canonicalJson is the shared repository canonical serializer (sorted
// keys). No timestamps, no traversal-order dependence.
const REQUIRED_STATE_DIGEST_DOMAIN_V1 = 'nexus/context-required-state/v1';
const REPRESENTED_STATE_DIGEST_DOMAIN_V1 = 'nexus/context-represented-state/v1';

// Frozen blocker codes (stable refusal reasons; sorted on output).
const CHECKPOINTABILITY_BLOCKER_CODES = Object.freeze([
  'checkpointability-safe-point-required',
  'checkpointability-snapshot-required',
  'checkpointability-snapshot-stale',
  'checkpointability-unsupported-authoritative-state',
  'checkpointability-required-state-uncovered',
  'checkpointability-authority-mismatch',
  'checkpointability-objective-incomplete',
  'checkpointability-requirement-uncovered',
  'checkpointability-constraint-uncovered',
  'checkpointability-decision-uncovered',
  'checkpointability-evidence-unavailable',
  'checkpointability-failure-state-uncovered',
  'checkpointability-verification-state-uncovered',
  'checkpointability-continuation-incomplete',
  'checkpointability-ephemeral-state-required',
  'checkpointability-size-bound-exceeded',
  'checkpointability-state-changed',
  'checkpointability-checkpoint-coverage-mismatch',
  // CCV2-R1: a NATIVE task (or any objective/requirements category) whose
  // authority completeness is not COMPLETE. Distinct from
  // unsupported-authoritative-state, which keeps its hard-blocking meaning.
  'checkpointability-authority-incomplete',
]);

// Frozen authoritative-state kinds (closed world). Every current
// authoritative fact whose absence could change future execution belongs
// to exactly one kind. Anything else is explicitly non-required (see
// NON_REQUIRED_CLASSES, which never enters the contract) or unknown future
// controller state declared in unsupportedState, which always BLOCKS.
const AUTHORITATIVE_STATE_KINDS = Object.freeze([
  'task-identity',
  'objective',
  'requirement',
  'constraint',
  'progress',
  'decision',
  'repository',
  'evidence',
  'failure',
  'retry-state',
  'verification',
  'continuation',
  'snapshot-binding',
  'safe-point-boundary',
  // CCV2-R1: inventoried only when the task state declares completeness.
  'authority-completeness',
]);

// Frozen A03 destinations. A required item is covered exactly when it is
// represented in its destination section or deterministically
// reconstructible from a referenced authoritative durable source
// (durable-reference). No third category exists.
const COVERAGE_DESTINATIONS = Object.freeze([
  'objective',
  'requirements',
  'constraints',
  'progress',
  'decisions',
  'repository',
  'evidenceRefs',
  'failures',
  'verification',
  'continuation',
  'binding',
  'durable-reference',
  // CCV2-R1 authority-completeness destination (checkpoint top level).
  'authorityCompleteness',
]);

// Frozen ephemeral kinds: state that cannot survive restart. A06 removes
// open protocol edges; A07 BLOCKS when continuation still requires an
// ephemeral object that cannot be reconstructed.
const EPHEMERAL_STATE_KINDS = Object.freeze([
  'open-process-handle',
  'in-memory-callback',
  'ipc-handle',
  'unpersisted-local-handle',
  'volatile-stream',
  'model-runtime-ref',
  'open-file-handle',
  'pending-io',
]);

// Explicit non-required exclusion classes (frozen). Omitted only because
// reconstructible or non-authoritative by construction. Never a judgment
// call: these classes never enter the taskState contract.
const NON_REQUIRED_CLASSES = Object.freeze([
  'ui-state',
  'render-state',
  'derived-cache',
  'temp-index',
  'derived-summary',
  'telemetry',
  'ranking-data',
]);

// Required evidence sources (frozen). Agent/review content is advisory by
// A04 construction and can never serve as required evidence.
const EVIDENCE_GROUNDED_SOURCES = Object.freeze([
  'controller',
  'user',
  'repository',
  'tool',
  'verification',
]);
// ---- closed-world exact keys (A05H rule: unknown key FAILS CLOSED) ----
// Validation runs BEFORE digest computation, coverage comparison, and the
// checkpointability decision. Unknown fields are never stripped.
const TASK_STATE_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'taskId', 'taskInstanceId', 'sessionId', 'workspaceId',
  'repositoryId', 'checkoutId', 'generation', 'safePointBoundarySeq',
  'sessionRevision', 'taskRevision', 'repositoryRevision', 'runtimeRevision',
  'objective', 'requirements', 'constraints', 'progress', 'decisions',
  'repository', 'evidenceRefs', 'failures', 'verification', 'continuation',
  'provenance', 'ephemeralState', 'unsupportedState', 'reconstructionRefs',
  'authorityCompleteness',
]);
const TASK_STATE_REPOSITORY_REVISION_EXACT_KEYS = Object.freeze([
  'headCommit', 'indexDigest', 'worktreeDigest',
]);
const TASK_STATE_RUNTIME_REVISION_EXACT_KEYS = Object.freeze([
  'runtimeSnapshotSeq',
]);
const TASK_STATE_OBJECTIVE_EXACT_KEYS = Object.freeze(['text', 'status']);
const TASK_STATE_REQUIREMENT_EXACT_KEYS = Object.freeze([
  'id', 'text', 'status', 'evidenceRefs', 'sourceKind',
]);
const TASK_STATE_CONSTRAINT_EXACT_KEYS = Object.freeze(['type', 'text', 'sourceKind']);
const TASK_STATE_PROGRESS_EXACT_KEYS = Object.freeze([
  'taskStatus', 'completedMilestones', 'currentMilestone', 'remainingMilestones',
]);
const TASK_STATE_DECISION_EXACT_KEYS = Object.freeze([
  'id', 'statement', 'authority', 'status', 'evidenceRefs', 'sourceKind',
]);
const TASK_STATE_REPOSITORY_EXACT_KEYS = Object.freeze([
  'repositoryId', 'checkoutId', 'headCommit', 'baseCommit', 'cleanWorktree',
  'changedFiles', 'changedFileCount', 'stagedSummary', 'unstagedSummary',
]);
const TASK_STATE_EVIDENCE_REF_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'evidenceId', 'kind', 'locator', 'digest',
  'observedAtUtc', 'taskInstanceId', 'accessible', 'sourceKind',
]);
const TASK_STATE_FAILURES_EXACT_KEYS = Object.freeze([
  'activeFailures', 'rejectedHypotheses', 'retryState',
]);
const TASK_STATE_ACTIVE_FAILURE_EXACT_KEYS = Object.freeze([
  'id', 'status', 'detail', 'attemptCount', 'evidenceRefs',
]);
const TASK_STATE_RETRY_STATE_EXACT_KEYS = Object.freeze([
  'attemptCount', 'nextRetryAtUtc', 'note',
]);
const TASK_STATE_VERIFICATION_EXACT_KEYS = Object.freeze(['outcomes', 'note']);
const TASK_STATE_VERIFICATION_OUTCOME_EXACT_KEYS = Object.freeze([
  'scope', 'status', 'detail', 'evidenceRefs',
]);
const TASK_STATE_CONTINUATION_EXACT_KEYS = Object.freeze([
  'nextAction', 'unresolvedQuestions', 'recentUserIntent',
]);
const TASK_STATE_PROVENANCE_ENTRY_EXACT_KEYS = Object.freeze([
  'sourceKind', 'fieldKind', 'sourceRefs', 'authorityScope',
]);
const TASK_STATE_EPHEMERAL_EXACT_KEYS = Object.freeze([
  'id', 'kind', 'requiredForContinuation',
]);
const TASK_STATE_UNSUPPORTED_EXACT_KEYS = Object.freeze(['stateKind', 'stateId']);
const TASK_STATE_RECONSTRUCTION_REF_EXACT_KEYS = Object.freeze([
  'stateId', 'locator', 'digest', 'accessible',
]);
const EVALUATE_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'taskState', 'safePointDecision', 'snapshotToken',
  'currentSnapshotState', 'projectedSizeBytes',
]);
const COVERAGE_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'taskState', 'checkpoint', 'snapshotToken', 'safePointDecision',
]);
const DECISION_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'checkpointable', 'taskId', 'taskInstanceId', 'sessionId',
  'safePointBoundarySeq', 'snapshotTokenId', 'revisionDigest',
  'requiredState', 'representableState', 'blockers',
]);
const DECISION_STATE_DIGEST_EXACT_KEYS = Object.freeze(['count', 'digest']);
const DECISION_BLOCKER_EXACT_KEYS = Object.freeze(['code', 'detail']);

function failGate(message) {
  throw new Error('v2-checkpointability: ' + message + ' (KEEP)');
}

function unknownKeyOf(value, allowedKeys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) return key;
  }
  return null;
}

function isBoundedString(value, max, allowEmpty) {
  if (typeof value !== 'string') return false;
  if (!allowEmpty && value === '') return false;
  return value.length <= max;
}

function isIsoUtc(value) {
  if (typeof value !== 'string' || value === '') return false;
  return Number.isFinite(Date.parse(value));
}

const HEX64_PATTERN = /^[0-9a-f]{64}$/;
function asNullableBoundedString(value, max, what) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value === '') return null;
  if (value.length > max) failGate(what + ' exceeds the bound');
  return value;
}

function normalizeStringArray(value, maxItems, maxChars, what) {
  if (!Array.isArray(value)) failGate(what + ' must be an array');
  if (value.length > maxItems) failGate(what + ' exceeds the bound');
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry === '') failGate(what + ' entries must be non-empty strings');
    if (entry.length > maxChars) failGate(what + ' entry exceeds the bound');
    return entry;
  });
}

function normalizeEvidenceIdArray(value, what) {
  if (!Array.isArray(value)) failGate(what + ' must be an array');
  if (value.length > checkpointV2.BOUNDS.requirementEvidenceMax) failGate(what + ' exceeds the bound');
  return value.map((entry) => {
    if (!isBoundedString(entry, checkpointV2.BOUNDS.requirementEvidenceRef, true)) {
      failGate(what + ' entries must be bounded strings');
    }
    return String(entry);
  });
}

function normalizeSourceKind(value, what) {
  if (typeof value !== 'string' || !trustV2.SOURCE_KINDS.includes(value)) {
    failGate(what + ' must be a frozen source kind');
  }
  return value;
}

function normalizeStateList(value, what, normalizeEntry) {
  const list = value === undefined || value === null ? [] : value;
  if (!Array.isArray(list)) failGate(what + ' must be an array');
  return list.map(normalizeEntry);
}

function normalizeTaskState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) failGate('taskState is required');
  const unknownTop = unknownKeyOf(input, TASK_STATE_EXACT_KEYS);
  if (unknownTop !== null) failGate('unknown taskState field ' + unknownTop);
  if (Number(input.schemaVersion) !== CHECKPOINTABILITY_SCHEMA_VERSION) failGate('taskState.schemaVersion must be 1');
  const B = checkpointV2.BOUNDS;
  for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
    if (!isBoundedString(input[key], B.taskId, false)) failGate('taskState.' + key + ' is required (bounded string)');
  }
  if (!isBoundedString(input.workspaceId, B.workspaceId, false)) failGate('taskState.workspaceId is required (bounded string)');
  const repositoryId = asNullableBoundedString(input.repositoryId, B.repositoryId, 'taskState.repositoryId');
  const checkoutId = asNullableBoundedString(input.checkoutId, B.checkoutId, 'taskState.checkoutId');
  if (!Number.isInteger(input.generation) || input.generation < 1) failGate('taskState.generation must be a positive integer');
  if (!Number.isInteger(input.safePointBoundarySeq) || input.safePointBoundarySeq < 0) {
    failGate('taskState.safePointBoundarySeq must be a non-negative integer');
  }
  if (!Number.isInteger(input.sessionRevision) || input.sessionRevision < 0) {
    failGate('taskState.sessionRevision must be a non-negative integer captureSeq');
  }
  if (typeof input.taskRevision !== 'string' || !HEX64_PATTERN.test(input.taskRevision)) {
    failGate('taskState.taskRevision must be sha256 hex (use ContextSnapshotV2.deriveTaskRevision)');
  }
  const repoRevisionRaw = input.repositoryRevision === undefined || input.repositoryRevision === null
    ? { headCommit: null, indexDigest: null, worktreeDigest: null }
    : input.repositoryRevision;
  if (!repoRevisionRaw || typeof repoRevisionRaw !== 'object') failGate('taskState.repositoryRevision must be an object or null');
  if (unknownKeyOf(repoRevisionRaw, TASK_STATE_REPOSITORY_REVISION_EXACT_KEYS) !== null) {
    failGate('unknown taskState.repositoryRevision field');
  }
  const headCommit = asNullableBoundedString(repoRevisionRaw.headCommit, B.repositoryCommit, 'taskState.repositoryRevision.headCommit');
  for (const digestKey of ['indexDigest', 'worktreeDigest']) {
    const digest = repoRevisionRaw[digestKey];
    if (digest !== null && digest !== undefined && (typeof digest !== 'string' || !HEX64_PATTERN.test(digest))) {
      failGate('taskState.repositoryRevision.' + digestKey + ' must be sha256 hex or null');
    }
  }
  const runtimeRaw = input.runtimeRevision === undefined || input.runtimeRevision === null
    ? { runtimeSnapshotSeq: null }
    : input.runtimeRevision;
  if (!runtimeRaw || typeof runtimeRaw !== 'object') failGate('taskState.runtimeRevision must be an object or null');
  if (unknownKeyOf(runtimeRaw, TASK_STATE_RUNTIME_REVISION_EXACT_KEYS) !== null) {
    failGate('unknown taskState.runtimeRevision field');
  }
  const runtimeSnapshotSeq = runtimeRaw.runtimeSnapshotSeq === undefined || runtimeRaw.runtimeSnapshotSeq === null
    ? null
    : runtimeRaw.runtimeSnapshotSeq;
  if (runtimeSnapshotSeq !== null && (!Number.isInteger(runtimeSnapshotSeq) || runtimeSnapshotSeq < 0)) {
    failGate('taskState.runtimeRevision.runtimeSnapshotSeq must be a non-negative integer or null');
  }
  let objective = null;
  if (input.objective !== null && input.objective !== undefined) {
    if (typeof input.objective !== 'object') failGate('taskState.objective must be an object or null');
    if (unknownKeyOf(input.objective, TASK_STATE_OBJECTIVE_EXACT_KEYS) !== null) failGate('unknown taskState.objective field');
    objective = {
      text: typeof input.objective.text === 'string' ? input.objective.text : '',
      status: typeof input.objective.status === 'string' ? input.objective.status : '',
    };
    if (objective.text.length > B.objectiveText) failGate('taskState.objective.text exceeds the bound');
    if (objective.status.length > B.objectiveStatus) failGate('taskState.objective.status exceeds the bound');
  }

  const requirements = normalizeStateList(input.requirements, 'taskState.requirements', (req) => {
    if (!req || typeof req !== 'object') failGate('taskState.requirements entries must be objects');
    if (unknownKeyOf(req, TASK_STATE_REQUIREMENT_EXACT_KEYS) !== null) failGate('unknown taskState.requirements field');
    if (!isBoundedString(req.id, B.requirementId, false)) failGate('taskState.requirements.id is required');
    if (typeof req.text !== 'string' || req.text.length > B.requirementText) failGate('taskState.requirements.text exceeds the bound');
    if (!checkpointV2.REQUIREMENT_STATUSES.includes(req.status)) failGate('taskState.requirements.status must be a frozen status');
    return {
      id: String(req.id),
      text: String(req.text),
      status: String(req.status),
      evidenceRefs: normalizeEvidenceIdArray(req.evidenceRefs === undefined ? [] : req.evidenceRefs, 'taskState.requirements.evidenceRefs'),
      sourceKind: req.sourceKind === undefined ? 'controller' : normalizeSourceKind(req.sourceKind, 'taskState.requirements.sourceKind'),
    };
  });

  const constraints = normalizeStateList(input.constraints, 'taskState.constraints', (constraint) => {
    if (!constraint || typeof constraint !== 'object') failGate('taskState.constraints entries must be objects');
    if (unknownKeyOf(constraint, TASK_STATE_CONSTRAINT_EXACT_KEYS) !== null) failGate('unknown taskState.constraints field');
    if (!isBoundedString(constraint.type, B.constraintType, false)) failGate('taskState.constraints.type is required');
    if (typeof constraint.text !== 'string' || constraint.text.length > B.constraintText) {
      failGate('taskState.constraints.text exceeds the bound');
    }
    return {
      type: String(constraint.type),
      text: String(constraint.text),
      sourceKind: constraint.sourceKind === undefined ? 'controller' : normalizeSourceKind(constraint.sourceKind, 'taskState.constraints.sourceKind'),
    };
  });

  if (!input.progress || typeof input.progress !== 'object') failGate('taskState.progress is required');
  if (unknownKeyOf(input.progress, TASK_STATE_PROGRESS_EXACT_KEYS) !== null) failGate('unknown taskState.progress field');
  const progress = {
    taskStatus: String(input.progress.taskStatus || ''),
    completedMilestones: normalizeStringArray(input.progress.completedMilestones === undefined ? [] : input.progress.completedMilestones, B.milestonesMax, B.milestoneText, 'taskState.progress.completedMilestones'),
    currentMilestone: input.progress.currentMilestone === undefined || input.progress.currentMilestone === null ? null : String(input.progress.currentMilestone),
    remainingMilestones: normalizeStringArray(input.progress.remainingMilestones === undefined ? [] : input.progress.remainingMilestones, B.milestonesMax, B.milestoneText, 'taskState.progress.remainingMilestones'),
  };
  if (progress.taskStatus === '' || progress.taskStatus.length > 64) failGate('taskState.progress.taskStatus is required (bounded string)');
  if (progress.currentMilestone !== null && progress.currentMilestone.length > B.milestoneText) {
    failGate('taskState.progress.currentMilestone exceeds the bound');
  }

  const decisions = normalizeStateList(input.decisions, 'taskState.decisions', (decision) => {
    if (!decision || typeof decision !== 'object') failGate('taskState.decisions entries must be objects');
    if (unknownKeyOf(decision, TASK_STATE_DECISION_EXACT_KEYS) !== null) failGate('unknown taskState.decisions field');
    if (!isBoundedString(decision.id, B.decisionId, false)) failGate('taskState.decisions.id is required');
    if (typeof decision.statement !== 'string' || decision.statement.length > B.decisionStatement) {
      failGate('taskState.decisions.statement exceeds the bound');
    }
    if (!checkpointV2.DECISION_AUTHORITIES.includes(decision.authority)) failGate('taskState.decisions.authority must be a frozen authority');
    if (!checkpointV2.DECISION_STATUSES.includes(decision.status)) failGate('taskState.decisions.status must be a frozen status');
    return {
      id: String(decision.id),
      statement: String(decision.statement),
      authority: String(decision.authority),
      status: String(decision.status),
      evidenceRefs: normalizeEvidenceIdArray(decision.evidenceRefs === undefined ? [] : decision.evidenceRefs, 'taskState.decisions.evidenceRefs'),
      sourceKind: decision.sourceKind === undefined ? 'controller' : normalizeSourceKind(decision.sourceKind, 'taskState.decisions.sourceKind'),
    };
  });

  if (!input.repository || typeof input.repository !== 'object') failGate('taskState.repository is required');
  if (unknownKeyOf(input.repository, TASK_STATE_REPOSITORY_EXACT_KEYS) !== null) failGate('unknown taskState.repository field');
  const changedFiles = Array.isArray(input.repository.changedFiles) ? input.repository.changedFiles.map(String) : [];
  const declaredCount = input.repository.changedFileCount === undefined || input.repository.changedFileCount === null
    ? changedFiles.length
    : Number(input.repository.changedFileCount);
  const repository = {
    repositoryId: asNullableBoundedString(input.repository.repositoryId, B.repositoryId, 'taskState.repository.repositoryId'),
    checkoutId: asNullableBoundedString(input.repository.checkoutId, B.checkoutId, 'taskState.repository.checkoutId'),
    headCommit: asNullableBoundedString(input.repository.headCommit, B.repositoryCommit, 'taskState.repository.headCommit'),
    baseCommit: asNullableBoundedString(input.repository.baseCommit, B.repositoryCommit, 'taskState.repository.baseCommit'),
    cleanWorktree: input.repository.cleanWorktree === null || input.repository.cleanWorktree === undefined ? null : Boolean(input.repository.cleanWorktree),
    changedFiles,
    changedFileCount: declaredCount,
    stagedSummary: asNullableBoundedString(input.repository.stagedSummary, B.repositorySummary, 'taskState.repository.stagedSummary'),
    unstagedSummary: asNullableBoundedString(input.repository.unstagedSummary, B.repositorySummary, 'taskState.repository.unstagedSummary'),
  };
  const evidenceRefs = normalizeStateList(input.evidenceRefs, 'taskState.evidenceRefs', (ref) => {
    if (!ref || typeof ref !== 'object') failGate('taskState.evidenceRefs entries must be objects');
    if (unknownKeyOf(ref, TASK_STATE_EVIDENCE_REF_EXACT_KEYS) !== null) failGate('unknown taskState.evidenceRefs field');
    if (Number(ref.schemaVersion) !== 1) failGate('taskState.evidenceRefs.schemaVersion must be 1');
    if (!isBoundedString(ref.evidenceId, B.evidenceId, false)) failGate('taskState.evidenceRefs.evidenceId is required');
    if (!checkpointV2.EVIDENCE_KINDS.includes(ref.kind)) failGate('taskState.evidenceRefs.kind must be a frozen kind');
    if (!isBoundedString(ref.locator, B.evidenceLocator, false)) failGate('taskState.evidenceRefs.locator is required');
    if (ref.digest !== null && ref.digest !== undefined && !isBoundedString(String(ref.digest), B.evidenceDigest, false)) {
      failGate('taskState.evidenceRefs.digest exceeds the bound');
    }
    if (!isIsoUtc(ref.observedAtUtc)) failGate('taskState.evidenceRefs.observedAtUtc must be ISO-8601 UTC');
    if (typeof ref.taskInstanceId !== 'string' || ref.taskInstanceId === '') failGate('taskState.evidenceRefs.taskInstanceId is required');
    if (typeof ref.accessible !== 'boolean') failGate('taskState.evidenceRefs.accessible must be a boolean');
    return {
      schemaVersion: 1,
      evidenceId: String(ref.evidenceId),
      kind: String(ref.kind),
      locator: String(ref.locator),
      digest: ref.digest === undefined ? null : ref.digest,
      observedAtUtc: String(ref.observedAtUtc),
      taskInstanceId: String(ref.taskInstanceId),
      accessible: Boolean(ref.accessible),
      sourceKind: ref.sourceKind === undefined ? 'tool' : normalizeSourceKind(ref.sourceKind, 'taskState.evidenceRefs.sourceKind'),
    };
  });

  if (!input.failures || typeof input.failures !== 'object') failGate('taskState.failures is required');
  if (unknownKeyOf(input.failures, TASK_STATE_FAILURES_EXACT_KEYS) !== null) failGate('unknown taskState.failures field');
  const activeFailures = normalizeStateList(input.failures.activeFailures, 'taskState.failures.activeFailures', (failure) => {
    if (!failure || typeof failure !== 'object') failGate('taskState.failures.activeFailures entries must be objects');
    if (unknownKeyOf(failure, TASK_STATE_ACTIVE_FAILURE_EXACT_KEYS) !== null) failGate('unknown taskState.failures.activeFailures field');
    if (!isBoundedString(failure.id, B.failureId, false)) failGate('taskState.failures.activeFailures.id is required');
    if (!isBoundedString(failure.status, B.failureStatus, false)) failGate('taskState.failures.activeFailures.status is required');
    if (failure.detail !== undefined && failure.detail !== null && String(failure.detail).length > B.failureDetail) {
      failGate('taskState.failures.activeFailures.detail exceeds the bound');
    }
    const attemptCount = failure.attemptCount === undefined || failure.attemptCount === null ? null : Number(failure.attemptCount);
    if (attemptCount !== null && (!Number.isInteger(attemptCount) || attemptCount < 0)) {
      failGate('taskState.failures.activeFailures.attemptCount must be a non-negative integer or null');
    }
    return {
      id: String(failure.id),
      status: String(failure.status),
      detail: failure.detail === undefined || failure.detail === null ? null : String(failure.detail),
      attemptCount,
      evidenceRefs: normalizeEvidenceIdArray(failure.evidenceRefs === undefined ? [] : failure.evidenceRefs, 'taskState.failures.activeFailures.evidenceRefs'),
    };
  });
  const rejectedHypotheses = normalizeStringArray(
    input.failures.rejectedHypotheses === undefined ? [] : input.failures.rejectedHypotheses,
    B.failureMax, B.hypothesisText, 'taskState.failures.rejectedHypotheses',
  );
  let retryState = null;
  if (input.failures.retryState !== null && input.failures.retryState !== undefined) {
    const raw = input.failures.retryState;
    if (typeof raw !== 'object') failGate('taskState.failures.retryState must be an object or null');
    if (unknownKeyOf(raw, TASK_STATE_RETRY_STATE_EXACT_KEYS) !== null) failGate('unknown taskState.failures.retryState field');
    const retryAttemptCount = raw.attemptCount === undefined || raw.attemptCount === null ? null : Number(raw.attemptCount);
    if (retryAttemptCount !== null && (!Number.isInteger(retryAttemptCount) || retryAttemptCount < 0)) {
      failGate('taskState.failures.retryState.attemptCount must be a non-negative integer or null');
    }
    if (raw.nextRetryAtUtc !== undefined && raw.nextRetryAtUtc !== null && !isIsoUtc(raw.nextRetryAtUtc)) {
      failGate('taskState.failures.retryState.nextRetryAtUtc must be ISO-8601 UTC or null');
    }
    if (raw.note !== undefined && raw.note !== null && String(raw.note).length > B.retryNote) {
      failGate('taskState.failures.retryState.note exceeds the bound');
    }
    retryState = {
      attemptCount: retryAttemptCount,
      nextRetryAtUtc: raw.nextRetryAtUtc === undefined ? null : raw.nextRetryAtUtc,
      note: raw.note === undefined || raw.note === null ? null : String(raw.note),
    };
  }

  if (!input.verification || typeof input.verification !== 'object') failGate('taskState.verification is required');
  if (unknownKeyOf(input.verification, TASK_STATE_VERIFICATION_EXACT_KEYS) !== null) failGate('unknown taskState.verification field');
  const outcomes = normalizeStateList(input.verification.outcomes, 'taskState.verification.outcomes', (outcome) => {
    if (!outcome || typeof outcome !== 'object') failGate('taskState.verification.outcomes entries must be objects');
    if (unknownKeyOf(outcome, TASK_STATE_VERIFICATION_OUTCOME_EXACT_KEYS) !== null) failGate('unknown taskState.verification.outcomes field');
    if (!isBoundedString(outcome.scope, B.verificationScope, false)) failGate('taskState.verification.outcomes.scope is required');
    if (!checkpointV2.VERIFICATION_STATUSES.includes(outcome.status)) failGate('taskState.verification.outcomes.status must be a frozen status');
    if (outcome.detail !== undefined && outcome.detail !== null && String(outcome.detail).length > B.verificationDetail) {
      failGate('taskState.verification.outcomes.detail exceeds the bound');
    }
    return {
      scope: String(outcome.scope),
      status: String(outcome.status),
      detail: outcome.detail === undefined || outcome.detail === null ? null : String(outcome.detail),
      evidenceRefs: normalizeEvidenceIdArray(outcome.evidenceRefs === undefined ? [] : outcome.evidenceRefs, 'taskState.verification.outcomes.evidenceRefs'),
    };
  });
  if (outcomes.length > B.verificationOutcomesMax) failGate('taskState.verification.outcomes exceeds the bound');

  if (!input.continuation || typeof input.continuation !== 'object') failGate('taskState.continuation is required');
  if (unknownKeyOf(input.continuation, TASK_STATE_CONTINUATION_EXACT_KEYS) !== null) failGate('unknown taskState.continuation field');
  const continuation = {
    nextAction: input.continuation.nextAction === undefined || input.continuation.nextAction === null ? null : String(input.continuation.nextAction),
    unresolvedQuestions: normalizeStringArray(
      input.continuation.unresolvedQuestions === undefined ? [] : input.continuation.unresolvedQuestions,
      B.unresolvedMax, B.unresolvedText, 'taskState.continuation.unresolvedQuestions',
    ),
    recentUserIntent: input.continuation.recentUserIntent === undefined || input.continuation.recentUserIntent === null ? null : String(input.continuation.recentUserIntent),
  };
  if (continuation.nextAction !== null && (continuation.nextAction === '' || continuation.nextAction.length > B.nextAction)) {
    failGate('taskState.continuation.nextAction exceeds the bound');
  }
  if (continuation.recentUserIntent !== null && continuation.recentUserIntent.length > B.recentUserIntent) {
    failGate('taskState.continuation.recentUserIntent exceeds the bound');
  }
  if (!input.provenance || typeof input.provenance !== 'object' || Array.isArray(input.provenance)) {
    failGate('taskState.provenance is required');
  }
  const provenance = {};
  for (const fieldPath of Object.keys(input.provenance).sort()) {
    const entry = input.provenance[fieldPath];
    if (!entry || typeof entry !== 'object') failGate('taskState.provenance entries must be objects');
    if (unknownKeyOf(entry, TASK_STATE_PROVENANCE_ENTRY_EXACT_KEYS) !== null) failGate('unknown taskState.provenance entry field');
    if (fieldPath === '' || fieldPath.length > trustV2.PROVENANCE_BOUNDS.maxFieldPathLength) {
      failGate('taskState.provenance field path exceeds the bound');
    }
    const sourceKind = normalizeSourceKind(entry.sourceKind, 'taskState.provenance.sourceKind');
    if (typeof entry.fieldKind !== 'string' || !trustV2.FIELD_KINDS.includes(entry.fieldKind)) {
      failGate('taskState.provenance.fieldKind must be a frozen field kind');
    }
    if (!Array.isArray(entry.sourceRefs) || entry.sourceRefs.length === 0) {
      failGate('taskState.provenance.sourceRefs must be a non-empty array');
    }
    if (entry.sourceRefs.length > trustV2.PROVENANCE_BOUNDS.maxSourceRefsPerEntry) {
      failGate('taskState.provenance.sourceRefs exceeds the bound');
    }
    for (const ref of entry.sourceRefs) {
      if (typeof ref !== 'string' || ref === '' || ref.length > trustV2.PROVENANCE_BOUNDS.maxSourceRefLength) {
        failGate('taskState.provenance.sourceRefs entries must be bounded strings');
      }
    }
    const authorityScope = entry.authorityScope === undefined || entry.authorityScope === null ? null : entry.authorityScope;
    if (authorityScope !== null && (typeof authorityScope !== 'string' || authorityScope === '' || authorityScope.length > trustV2.PROVENANCE_BOUNDS.maxAuthorityScopeLength)) {
      failGate('taskState.provenance.authorityScope exceeds the bound');
    }
    provenance[fieldPath] = {
      sourceKind,
      fieldKind: String(entry.fieldKind),
      sourceRefs: entry.sourceRefs.map(String),
      authorityScope,
    };
  }

  const ephemeralState = normalizeStateList(input.ephemeralState, 'taskState.ephemeralState', (entry) => {
    if (!entry || typeof entry !== 'object') failGate('taskState.ephemeralState entries must be objects');
    if (unknownKeyOf(entry, TASK_STATE_EPHEMERAL_EXACT_KEYS) !== null) failGate('unknown taskState.ephemeralState field');
    if (typeof entry.id !== 'string' || entry.id === '') failGate('taskState.ephemeralState.id is required');
    if (typeof entry.kind !== 'string' || entry.kind === '') failGate('taskState.ephemeralState.kind is required');
    if (typeof entry.requiredForContinuation !== 'boolean') failGate('taskState.ephemeralState.requiredForContinuation must be a boolean');
    return { id: String(entry.id), kind: String(entry.kind), requiredForContinuation: Boolean(entry.requiredForContinuation) };
  });

  const unsupportedState = normalizeStateList(input.unsupportedState, 'taskState.unsupportedState', (entry) => {
    if (!entry || typeof entry !== 'object') failGate('taskState.unsupportedState entries must be objects');
    if (unknownKeyOf(entry, TASK_STATE_UNSUPPORTED_EXACT_KEYS) !== null) failGate('unknown taskState.unsupportedState field');
    if (typeof entry.stateKind !== 'string' || entry.stateKind === '') failGate('taskState.unsupportedState.stateKind is required');
    if (typeof entry.stateId !== 'string' || entry.stateId === '') failGate('taskState.unsupportedState.stateId is required');
    return { stateKind: String(entry.stateKind), stateId: String(entry.stateId) };
  });

  const reconstructionRefs = normalizeStateList(input.reconstructionRefs, 'taskState.reconstructionRefs', (entry) => {
    if (!entry || typeof entry !== 'object') failGate('taskState.reconstructionRefs entries must be objects');
    if (unknownKeyOf(entry, TASK_STATE_RECONSTRUCTION_REF_EXACT_KEYS) !== null) failGate('unknown taskState.reconstructionRefs field');
    if (typeof entry.stateId !== 'string' || entry.stateId === '') failGate('taskState.reconstructionRefs.stateId is required');
    if (typeof entry.locator !== 'string' || entry.locator === '') failGate('taskState.reconstructionRefs.locator is required');
    if (typeof entry.accessible !== 'boolean') failGate('taskState.reconstructionRefs.accessible must be a boolean');
    return {
      stateId: String(entry.stateId),
      locator: String(entry.locator),
      digest: entry.digest === undefined || entry.digest === null ? null : String(entry.digest),
      accessible: Boolean(entry.accessible),
    };
  });

  // CCV2-R1 authority completeness: closed-world SHAPE here (unknown
  // keys/values fail closed); semantic legality (NATIVE must be COMPLETE,
  // objective/requirements always COMPLETE) is an evaluate-time blocker.
  let authorityCompleteness = null;
  if (input.authorityCompleteness !== undefined && input.authorityCompleteness !== null) {
    const raw = input.authorityCompleteness;
    if (typeof raw !== 'object' || Array.isArray(raw)) failGate('taskState.authorityCompleteness must be an object');
    if (unknownKeyOf(raw, checkpointV2.CHECKPOINT_AUTHORITY_COMPLETENESS_EXACT_KEYS) !== null) {
      failGate('unknown taskState.authorityCompleteness field');
    }
    if (!checkpointV2.AUTHORITY_ORIGINS.includes(raw.origin)) failGate('taskState.authorityCompleteness.origin must be a frozen origin');
    const normalizedCompleteness = { origin: String(raw.origin) };
    for (const category of checkpointV2.AUTHORITY_CATEGORIES) {
      if (!checkpointV2.AUTHORITY_COMPLETENESS_VALUES.includes(raw[category])) {
        failGate('taskState.authorityCompleteness.' + category + ' must be a frozen completeness value');
      }
      normalizedCompleteness[category] = String(raw[category]);
    }
    authorityCompleteness = Object.freeze(normalizedCompleteness);
  }

  return Object.freeze({
    schemaVersion: CHECKPOINTABILITY_SCHEMA_VERSION,
    taskId: String(input.taskId),
    taskInstanceId: String(input.taskInstanceId),
    sessionId: String(input.sessionId),
    workspaceId: String(input.workspaceId),
    repositoryId,
    checkoutId,
    generation: Number(input.generation),
    safePointBoundarySeq: Number(input.safePointBoundarySeq),
    sessionRevision: Number(input.sessionRevision),
    taskRevision: String(input.taskRevision),
    repositoryRevision: Object.freeze({
      headCommit,
      indexDigest: repoRevisionRaw.indexDigest === undefined ? null : repoRevisionRaw.indexDigest,
      worktreeDigest: repoRevisionRaw.worktreeDigest === undefined ? null : repoRevisionRaw.worktreeDigest,
    }),
    runtimeRevision: Object.freeze({ runtimeSnapshotSeq }),
    objective: objective === null ? null : Object.freeze(objective),
    requirements: Object.freeze(requirements),
    constraints: Object.freeze(constraints),
    progress: Object.freeze(progress),
    decisions: Object.freeze(decisions),
    repository: Object.freeze(repository),
    evidenceRefs: Object.freeze(evidenceRefs),
    failures: Object.freeze({ activeFailures: Object.freeze(activeFailures), rejectedHypotheses: Object.freeze(rejectedHypotheses), retryState: retryState === null ? null : Object.freeze(retryState) }),
    verification: Object.freeze({ outcomes: Object.freeze(outcomes), note: input.verification.note === undefined || input.verification.note === null ? null : String(input.verification.note) }),
    continuation: Object.freeze(continuation),
    provenance: Object.freeze(provenance),
    ephemeralState: Object.freeze(ephemeralState),
    unsupportedState: Object.freeze(unsupportedState),
    reconstructionRefs: Object.freeze(reconstructionRefs),
    authorityCompleteness,
  });
}
// ---- deterministic inventory (AuthoritativeStateInventoryV2) ----
// Each item carries identity plus authority metadata plus a one-way content
// digest. Raw giant content is never kept for coverage accounting: bounded
// identities and redacted digests only. No secrets cross this seam.
function valueDigestOf(value) {
  const redacted = checkpointV2.redactCheckpointValueV2(value, checkpointV2.BOUNDS.redactMaxChars);
  return snapshotV2.sha256HexUtf8(snapshotV2.serializeCanonical(redacted === undefined ? null : redacted));
}

function inventoryItem(stateKind, stateId, sourceKind, authorityScope, destination, value) {
  if (!AUTHORITATIVE_STATE_KINDS.includes(stateKind)) failGate('unknown authoritative state kind ' + stateKind);
  if (!COVERAGE_DESTINATIONS.includes(destination)) failGate('unknown coverage destination ' + destination);
  const normalizedSource = sourceKind === undefined || sourceKind === null ? null : String(sourceKind);
  const normalizedScope = authorityScope === undefined || authorityScope === null ? null : String(authorityScope);
  const normalized = {
    stateKind,
    stateId: String(stateId),
    sourceKind: normalizedSource,
    authorityScope: normalizedScope,
    requiredForContinuation: true,
    contentDigest: snapshotV2.sha256HexUtf8(snapshotV2.serializeCanonical({
      stateKind,
      stateId: String(stateId),
      sourceKind: normalizedSource,
      authorityScope: normalizedScope,
      destination,
      valueDigest: valueDigestOf(value === undefined ? null : value),
    })),
    destination,
  };
  return Object.freeze(normalized);
}

function provenanceOf(taskState, fieldPath) {
  const entry = taskState.provenance[fieldPath];
  return entry === undefined ? null : entry;
}

// A reconstruction entry declares, per state id, a deterministic durable
// source the item rebuilds from. Only an accessible durable reference
// counts as coverage; a stale (inaccessible) reference never does.
function reconstructionFor(taskState, stateId) {
  for (const ref of taskState.reconstructionRefs) {
    if (ref.stateId === stateId) return ref;
  }
  return null;
}

function evidenceAccessible(taskState, evidenceId) {
  for (const ref of taskState.evidenceRefs) {
    if (ref.evidenceId === evidenceId) return ref.accessible;
  }
  const reconstruction = reconstructionFor(taskState, 'evidence:' + evidenceId);
  if (reconstruction !== null) return reconstruction.accessible;
  return null;
}

function buildAuthoritativeInventory(taskState) {
  const state = normalizeTaskState(taskState);
  const items = [];
  const provenanceScopeOf = (fieldPath) => {
    const entry = provenanceOf(state, fieldPath);
    return entry === null ? null : entry.authorityScope;
  };
  const sourceOf = (fieldPath, fallback) => {
    const entry = provenanceOf(state, fieldPath);
    return entry === null ? fallback : entry.sourceKind;
  };

  items.push(inventoryItem('task-identity', state.taskId + '|' + state.taskInstanceId + '|' + state.sessionId, 'controller', null, 'binding', {
    taskId: state.taskId, taskInstanceId: state.taskInstanceId, sessionId: state.sessionId,
  }));

  if (state.objective !== null) {
    items.push(inventoryItem('objective', 'objective', sourceOf('objective.text', 'controller'), provenanceScopeOf('objective.text'), 'objective', state.objective));
  }

  state.requirements.forEach((req, index) => {
    const fieldPath = 'requirements.' + index + '.text';
    items.push(inventoryItem('requirement', req.id, sourceOf(fieldPath, req.sourceKind), provenanceScopeOf(fieldPath), 'requirements', {
      id: req.id, text: req.text, status: req.status,
    }));
  });

  state.constraints.forEach((constraint, index) => {
    const fieldPath = 'constraints.' + index + '.text';
    items.push(inventoryItem('constraint', 'constraint-' + index, sourceOf(fieldPath, constraint.sourceKind), provenanceScopeOf(fieldPath), 'constraints', {
      type: constraint.type, text: constraint.text,
    }));
  });

  items.push(inventoryItem('progress', 'progress', sourceOf('objective.text', 'controller'), provenanceScopeOf('objective.text'), 'progress', state.progress));

  state.decisions.forEach((decision, index) => {
    const fieldPath = 'decisions.' + index + '.statement';
    items.push(inventoryItem('decision', decision.id, sourceOf(fieldPath, decision.sourceKind), provenanceScopeOf(fieldPath), 'decisions', {
      id: decision.id, statement: decision.statement, authority: decision.authority, status: decision.status,
    }));
  });

  items.push(inventoryItem('repository', state.repositoryId || state.repository.repositoryId || 'repository', sourceOf('repository', 'repository'), provenanceScopeOf('repository'), 'repository', {
    repositoryId: state.repository.repositoryId,
    checkoutId: state.repository.checkoutId,
    headCommit: state.repository.headCommit,
  }));

  for (const ref of state.evidenceRefs) {
    const reconstruction = reconstructionFor(state, 'evidence:' + ref.evidenceId);
    const destination = reconstruction !== null && reconstruction.accessible ? 'durable-reference' : 'evidenceRefs';
    items.push(inventoryItem('evidence', ref.evidenceId, ref.sourceKind, null, destination, {
      evidenceId: ref.evidenceId, kind: ref.kind, locator: ref.locator,
    }));
  }

  for (const failure of state.failures.activeFailures) {
    items.push(inventoryItem('failure', failure.id, sourceOf('objective.text', 'controller'), provenanceScopeOf('objective.text'), 'failures', {
      id: failure.id, status: failure.status, attemptCount: failure.attemptCount,
    }));
  }

  const retryRelevant = state.failures.retryState !== null
    || state.failures.activeFailures.some((failure) => failure.attemptCount !== null);
  if (retryRelevant) {
    items.push(inventoryItem('retry-state', 'retry-state', sourceOf('objective.text', 'controller'), provenanceScopeOf('objective.text'), 'failures', state.failures.retryState));
  }

  state.verification.outcomes.forEach((outcome) => {
    items.push(inventoryItem('verification', outcome.scope, 'verification', null, 'verification', {
      scope: outcome.scope, status: outcome.status,
    }));
  });

  items.push(inventoryItem('continuation', 'continuation', sourceOf('continuation.nextAction', 'controller'), provenanceScopeOf('continuation.nextAction'), 'continuation', {
    nextAction: state.continuation.nextAction,
    unresolvedQuestions: state.continuation.unresolvedQuestions,
  }));

  items.push(inventoryItem('snapshot-binding', 'snapshot-binding', 'controller', null, 'binding', {
    taskRevision: state.taskRevision, sessionRevision: state.sessionRevision,
  }));
  items.push(inventoryItem('safe-point-boundary', 'safe-point-boundary', 'controller', null, 'binding', {
    safePointBoundarySeq: state.safePointBoundarySeq,
  }));

  // CCV2-R1: declared completeness is required state (it governs historical
  // demotion), so the digests bind it. Absent -> no item (pre-R1 digests
  // unchanged).
  if (state.authorityCompleteness !== null) {
    items.push(inventoryItem('authority-completeness', 'authority-completeness', 'controller', null, 'authorityCompleteness', state.authorityCompleteness));
  }

  // Unknown future controller state is inventoried explicitly so the
  // digests bind it, and it ALWAYS blocks (see evaluate).
  for (const entry of state.unsupportedState) {
    items.push(inventoryItem('task-identity', 'unsupported:' + entry.stateKind + ':' + entry.stateId, 'controller', null, 'binding', entry));
  }

  items.sort((a, b) => {
    if (a.stateKind < b.stateKind) return -1;
    if (a.stateKind > b.stateKind) return 1;
    if (a.stateId < b.stateId) return -1;
    if (a.stateId > b.stateId) return 1;
    return 0;
  });
  return Object.freeze({ taskState: state, items: Object.freeze(items) });
}

// ---- frozen digest formulas ----
function normalizedInventoryForDigest(items) {
  return items.map((item) => ({
    authorityScope: item.authorityScope,
    contentDigest: item.contentDigest,
    destination: item.destination,
    requiredForContinuation: item.requiredForContinuation,
    sourceKind: item.sourceKind,
    stateId: item.stateId,
    stateKind: item.stateKind,
  }));
}

function deriveRequiredStateDigest(requiredItems) {
  return snapshotV2.sha256HexUtf8(
    REQUIRED_STATE_DIGEST_DOMAIN_V1 + String.fromCharCode(10) + snapshotV2.serializeCanonical(normalizedInventoryForDigest(requiredItems)),
  );
}

function deriveRepresentedStateDigest(representedItems) {
  return snapshotV2.sha256HexUtf8(
    REPRESENTED_STATE_DIGEST_DOMAIN_V1 + String.fromCharCode(10) + snapshotV2.serializeCanonical(normalizedInventoryForDigest(representedItems)),
  );
}
// ---- authority coverage (A04 provenance semantics, consumed verbatim) ----
// Required state must retain its authority classification: a user
// requirement must not become agent advisory in the checkpoint. The A04
// TrustNormalizer is the oracle: any combination it refuses, or any trust
// it derives outside authoritative/user-intent/evidence for required
// state, is a downgrade/elevation mismatch and BLOCKS.
const PRESERVING_TRUST_CLASSES = Object.freeze(['authoritative', 'user-intent', 'evidence']);

function mandatoryPathsFor(taskState) {
  return trustV2.mandatoryProvenancePaths({
    objective: taskState.objective === null ? { text: '', status: '' } : taskState.objective,
    requirements: taskState.requirements.map((req) => ({ text: req.text, status: req.status })),
    constraints: taskState.constraints.map((constraint) => ({ text: constraint.text })),
    decisions: taskState.decisions.map((decision) => ({ statement: decision.statement, authority: decision.authority, status: decision.status })),
    failures: { activeFailures: taskState.failures.activeFailures.map((failure) => ({ detail: failure.detail })) },
    verification: { outcomes: taskState.verification.outcomes.map((outcome) => ({ status: outcome.status, detail: outcome.detail })) },
    continuation: taskState.continuation,
    repository: taskState.repository,
  });
}

function checkProvenanceAuthority(taskState, blockers) {
  const block = (detail) => {
    blockers.push(Object.freeze({ code: 'checkpointability-authority-mismatch', detail }));
  };
  let mandatory = [];
  try {
    mandatory = mandatoryPathsFor(taskState);
  } catch (error) {
    block('provenance path enumeration refused');
    return;
  }
  for (const fieldPath of mandatory) {
    const slot = taskState.provenance[fieldPath];
    if (slot === undefined) {
      block('missing provenance for required field ' + fieldPath);
      continue;
    }
    let decisionValue = null;
    const authorityMatch = /^decisions[.](\d+)[.]authority$/.exec(fieldPath);
    if (authorityMatch !== null) {
      const decision = taskState.decisions[Number(authorityMatch[1])];
      decisionValue = decision === undefined ? null : decision.authority;
    }
    let normalized = null;
    try {
      normalized = trustV2.normalizeField({
        fieldPath,
        fieldKind: slot.fieldKind,
        value: decisionValue,
        sourceKind: slot.sourceKind,
        sourceRefs: slot.sourceRefs.slice(),
        authorityScope: slot.authorityScope,
        decisionValue: decisionValue === null ? undefined : decisionValue,
      });
    } catch (error) {
      block('authority refused for ' + fieldPath + ' (' + slot.sourceKind + ':' + slot.fieldKind + ')');
      continue;
    }
    if (!PRESERVING_TRUST_CLASSES.includes(normalized.provenance.trust)) {
      block('authority not preserved for ' + fieldPath + ' (derived ' + normalized.provenance.trust + ')');
    }
  }
  for (const ref of taskState.evidenceRefs) {
    if (!EVIDENCE_GROUNDED_SOURCES.includes(ref.sourceKind)) {
      block('required evidence ' + ref.evidenceId + ' sourced from ' + ref.sourceKind + ' cannot carry authority');
    }
  }
}

// ---- size-bound preflight (frozen A03 bounds; never truncate to fit) ----
// Required state that cannot fit without semantic loss BLOCKS. Truncating,
// summarizing, or dropping requirements/decisions/failures to fit belongs
// to no A07 policy and is refused here.
function checkSizeBounds(taskState, projectedSizeBytes, blockers) {
  const block = (detail) => {
    blockers.push(Object.freeze({ code: 'checkpointability-size-bound-exceeded', detail }));
  };
  const B = checkpointV2.BOUNDS;
  if (taskState.requirements.length > B.requirementsMax) block('requirements count ' + taskState.requirements.length + ' exceeds the A03 bound');
  if (taskState.constraints.length > B.constraintsMax) block('constraints count ' + taskState.constraints.length + ' exceeds the A03 bound');
  if (taskState.decisions.length > B.decisionsMax) block('decisions count ' + taskState.decisions.length + ' exceeds the A03 bound');
  if (taskState.evidenceRefs.length > B.evidenceRefsMax) block('evidence count ' + taskState.evidenceRefs.length + ' exceeds the A03 bound');
  if (taskState.failures.activeFailures.length > B.failureMax) block('failure count exceeds the A03 bound');
  if (taskState.verification.outcomes.length > B.verificationOutcomesMax) block('verification outcome count exceeds the A03 bound');
  if (projectedSizeBytes !== null && projectedSizeBytes !== undefined) {
    if (!Number.isInteger(projectedSizeBytes) || projectedSizeBytes < 0) failGate('projectedSizeBytes must be a non-negative integer or null');
    if (projectedSizeBytes > checkpointV2.CHECKPOINT_MAX_BYTES) {
      block('projected size ' + projectedSizeBytes + ' exceeds the 64 KiB bound');
    }
  }
}
// ---- pre-build: evaluateCheckpointabilityV2 ----
// Answers: can the current state be represented? Consumes the A06 decision
// and the A05 token verbatim; never redefines safe or fresh. Conceptual
// ordering enforced by the caller: A06 detect SAFE, A05 capture snapshot,
// A07 evaluate, A05 freshness verification, checkpoint construction.
function evaluateCheckpointabilityV2(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) failGate('input is required');
  const unknownInput = unknownKeyOf(input, EVALUATE_INPUT_EXACT_KEYS);
  if (unknownInput !== null) failGate('unknown evaluate field ' + unknownInput);
  if (Number(input.schemaVersion) !== CHECKPOINTABILITY_SCHEMA_VERSION) failGate('input.schemaVersion must be 1');
  const state = normalizeTaskState(input.taskState);
  const blockers = [];
  const block = (code, detail) => {
    blockers.push(Object.freeze({ code, detail: detail === undefined || detail === null ? null : String(detail) }));
  };

  // A06 leg: a valid SAFE decision is required. Unsafe BLOCKS. Malformed
  // decision envelopes fail closed with the A06 validator reason.
  const safeCheck = safepointV2.validateSafePointDecision(input.safePointDecision);
  if (!safeCheck.valid) {
    block('checkpointability-safe-point-required', 'safe-point decision refused (' + safeCheck.reason + ')');
  } else if (!input.safePointDecision.safe) {
    block('checkpointability-safe-point-required', 'safe point is not safe');
  } else if (input.safePointDecision.boundarySeq !== state.safePointBoundarySeq) {
    block('checkpointability-safe-point-required', 'safe-point boundary does not authorize this state');
  }

  // A05 leg: the matching snapshot token is required. Absent token,
  // structural refusal, or binding mismatch -> snapshot-required. A token
  // that no longer describes current reality -> snapshot-stale. State that
  // moved between capture and gate evaluation -> state-changed (retry). No
  // timestamp freshness is introduced: revision semantics only.
  const token = input.snapshotToken === undefined ? null : input.snapshotToken;
  let tokenUsable = false;
  if (token === null) {
    block('checkpointability-snapshot-required', 'no snapshot token for this state');
  } else {
    const tokenCheck = snapshotV2.validateSnapshotToken(token);
    if (!tokenCheck.valid) {
      block('checkpointability-snapshot-required', 'snapshot token refused (' + tokenCheck.reason + ')');
    } else if (token.taskId !== state.taskId || token.taskInstanceId !== state.taskInstanceId || token.sessionId !== state.sessionId) {
      block('checkpointability-snapshot-required', 'snapshot token binds another task binding');
    } else if (token.generation !== state.generation) {
      block('checkpointability-snapshot-required', 'snapshot token binds another generation');
    } else if (token.safePointBoundarySeq !== state.safePointBoundarySeq) {
      block('checkpointability-snapshot-required', 'snapshot token binds another boundary');
    } else if (token.taskRevision !== state.taskRevision || token.sessionRevision !== state.sessionRevision) {
      block('checkpointability-state-changed', 'task/session revision moved during gate evaluation (retry)');
    } else if (token.repositoryRevision.headCommit !== state.repositoryRevision.headCommit
      || token.repositoryRevision.indexDigest !== state.repositoryRevision.indexDigest
      || token.repositoryRevision.worktreeDigest !== state.repositoryRevision.worktreeDigest) {
      block('checkpointability-state-changed', 'repository revision moved during gate evaluation (retry)');
    } else if (token.runtimeRevision.runtimeSnapshotSeq !== state.runtimeRevision.runtimeSnapshotSeq) {
      block('checkpointability-state-changed', 'runtime revision moved during gate evaluation (retry)');
    } else {
      tokenUsable = true;
    }
  }

  // Freshness against live reality (A05 revalidation verbatim). A07 never
  // reinterprets stale state as checkpointable.
  if (tokenUsable && input.currentSnapshotState !== null && input.currentSnapshotState !== undefined) {
    let fresh = null;
    try {
      fresh = snapshotV2.revalidate(token, input.currentSnapshotState);
    } catch (error) {
      block('checkpointability-snapshot-required', 'freshness observation refused');
      fresh = null;
    }
    if (fresh !== null && !fresh.valid) {
      if (/^snapshot-(task|session|head|index|worktree|runtime)-stale$/.test(fresh.reason)
        || fresh.reason === 'snapshot-revision-digest-mismatch') {
        block('checkpointability-snapshot-stale', 'snapshot is stale (' + fresh.reason + ')');
      } else {
        block('checkpointability-snapshot-required', 'snapshot freshness refused (' + fresh.reason + ')');
      }
    }
  }

  // Forward-safety: unknown future authoritative state FAILS CLOSED.
  for (const entry of state.unsupportedState) {
    block('checkpointability-unsupported-authoritative-state', entry.stateKind + ':' + entry.stateId);
  }

  // CCV2-R1 authority completeness. UNRECORDED_LEGACY is legal only for
  // LEGACY_BOOTSTRAP replay; a NATIVE task never silently degrades a missing
  // current category, and objective/requirements are always authoritative.
  const completeness = state.authorityCompleteness;
  if (completeness !== null) {
    for (const category of checkpointV2.AUTHORITY_CATEGORIES) {
      const value = completeness[category];
      if (value === 'COMPLETE') continue;
      if (completeness.origin === 'NATIVE') {
        block('checkpointability-authority-incomplete', 'native task category ' + category + ' is ' + value);
      } else if (checkpointV2.ALWAYS_COMPLETE_CATEGORIES.includes(category)) {
        block('checkpointability-authority-incomplete', 'category ' + category + ' must be COMPLETE');
      }
    }
  }

  // Ephemeral state required for continuation cannot survive restart.
  for (const entry of state.ephemeralState) {
    if (entry.requiredForContinuation) {
      block('checkpointability-ephemeral-state-required', entry.kind + ':' + entry.id);
    }
  }

  // The objective must be present: resuming without one changes the task.
  if (state.objective === null || state.objective.text === '' || state.objective.status === '') {
    block('checkpointability-objective-incomplete', 'objective text/status is required');
  }

  // Continuation must let a resumed agent determine what was done, what
  // remains, what happens next, and what must not repeat, without
  // prompt-only information.
  // CCV2-R1: a LEGACY_BOOTSTRAP checkpoint that declares continuation
  // UNRECORDED_LEGACY does not claim an empty continuation; the unknown is
  // explicit (and forces conservative historical retention downstream), so
  // the empty-continuation blocker does not apply to it.
  const taskComplete = state.progress.taskStatus.toLowerCase() === 'complete';
  const continuationUnrecorded = completeness !== null
    && completeness.origin === 'LEGACY_BOOTSTRAP'
    && completeness.continuation === 'UNRECORDED_LEGACY';
  if (!taskComplete && !continuationUnrecorded
    && (state.continuation.nextAction === null || state.continuation.nextAction === '')
    && state.continuation.unresolvedQuestions.length === 0) {
    block('checkpointability-continuation-incomplete', 'no next action and no open questions for an incomplete task');
  }

  // Evidence cited anywhere must resolve to an accessible entry or an
  // accessible durable reconstruction reference. Stale references never
  // count as coverage.
  const citedEvidenceIds = [];
  const collectCited = (ids) => {
    for (const id of ids) {
      if (!citedEvidenceIds.includes(id)) citedEvidenceIds.push(id);
    }
  };
  for (const req of state.requirements) collectCited(req.evidenceRefs);
  for (const decision of state.decisions) collectCited(decision.evidenceRefs);
  for (const failure of state.failures.activeFailures) collectCited(failure.evidenceRefs);
  for (const outcome of state.verification.outcomes) collectCited(outcome.evidenceRefs);
  for (const cited of citedEvidenceIds.sort()) {
    const availability = evidenceAccessible(state, cited);
    if (availability === null) {
      block('checkpointability-evidence-unavailable', 'cited evidence ' + cited + ' has no entry or durable reference');
    } else if (availability === false) {
      block('checkpointability-evidence-unavailable', 'cited evidence ' + cited + ' is inaccessible');
    }
  }
  for (const ref of state.evidenceRefs) {
    if (ref.accessible === false && reconstructionFor(state, 'evidence:' + ref.evidenceId) === null) {
      block('checkpointability-evidence-unavailable', 'required evidence ' + ref.evidenceId + ' is inaccessible');
    }
  }

  // Authority preservation (A04 semantics verbatim).
  checkProvenanceAuthority(state, blockers);

  // Size-bound preflight (never truncate, summarize, or drop to fit).
  checkSizeBounds(state, input.projectedSizeBytes === undefined ? null : input.projectedSizeBytes, blockers);

  // Coverage inventory plus digests bind exactly what was evaluated.
  const inventory = buildAuthoritativeInventory(state);
  const requiredItems = inventory.items.filter((item) => item.requiredForContinuation);
  const requiredStateDigest = deriveRequiredStateDigest(requiredItems);
  const representableItems = requiredItems.filter((item) => COVERAGE_DESTINATIONS.includes(item.destination));
  const fullRepresentedDigest = deriveRepresentedStateDigest(representableItems);
  const emptyRepresentedDigest = deriveRepresentedStateDigest([]);
  const ok = blockers.length === 0;

  blockers.sort((a, b) => {
    if (a.code < b.code) return -1;
    if (a.code > b.code) return 1;
    if (a.detail < b.detail) return -1;
    if (a.detail > b.detail) return 1;
    return 0;
  });

  return Object.freeze({
    schemaVersion: CHECKPOINTABILITY_SCHEMA_VERSION,
    checkpointable: ok,
    taskId: state.taskId,
    taskInstanceId: state.taskInstanceId,
    sessionId: state.sessionId,
    safePointBoundarySeq: state.safePointBoundarySeq,
    snapshotTokenId: token !== null && typeof token === 'object' && typeof token.snapshotTokenId === 'string' ? token.snapshotTokenId : '',
    revisionDigest: token !== null && typeof token === 'object' && typeof token.revisionDigest === 'string' ? token.revisionDigest : '',
    requiredState: Object.freeze({ count: requiredItems.length, digest: requiredStateDigest }),
    representableState: Object.freeze({ count: ok ? representableItems.length : 0, digest: ok ? fullRepresentedDigest : emptyRepresentedDigest }),
    blockers: Object.freeze(blockers),
  });
}

// ---- decision validation (closed world) ----
function validateCheckpointabilityDecision(decision) {
  const fail = (reason) => ({ valid: false, reason });
  if (!decision || typeof decision !== 'object') return fail('checkpointability-decision-missing');
  if (unknownKeyOf(decision, DECISION_EXACT_KEYS) !== null) return fail('checkpointability-decision-schema-mismatch');
  if (Number(decision.schemaVersion) !== CHECKPOINTABILITY_SCHEMA_VERSION) return fail('checkpointability-decision-schema-mismatch');
  if (typeof decision.checkpointable !== 'boolean') return fail('checkpointability-decision-schema-mismatch');
  for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
    if (typeof decision[key] !== 'string' || decision[key] === '') return fail('checkpointability-decision-schema-mismatch');
  }
  if (!Number.isInteger(decision.safePointBoundarySeq) || decision.safePointBoundarySeq < 0) {
    return fail('checkpointability-decision-schema-mismatch');
  }
  if (typeof decision.snapshotTokenId !== 'string' || typeof decision.revisionDigest !== 'string') {
    return fail('checkpointability-decision-schema-mismatch');
  }
  for (const digestKey of ['requiredState', 'representableState']) {
    const slot = decision[digestKey];
    if (!slot || typeof slot !== 'object') return fail('checkpointability-decision-schema-mismatch');
    if (unknownKeyOf(slot, DECISION_STATE_DIGEST_EXACT_KEYS) !== null) return fail('checkpointability-decision-schema-mismatch');
    if (!Number.isInteger(slot.count) || slot.count < 0) return fail('checkpointability-decision-schema-mismatch');
    if (typeof slot.digest !== 'string' || !HEX64_PATTERN.test(slot.digest)) return fail('checkpointability-decision-schema-mismatch');
  }
  if (!Array.isArray(decision.blockers)) return fail('checkpointability-decision-schema-mismatch');
  for (const blocker of decision.blockers) {
    if (!blocker || typeof blocker !== 'object') return fail('checkpointability-decision-schema-mismatch');
    if (unknownKeyOf(blocker, DECISION_BLOCKER_EXACT_KEYS) !== null) return fail('checkpointability-decision-schema-mismatch');
    if (!CHECKPOINTABILITY_BLOCKER_CODES.includes(blocker.code)) return fail('checkpointability-decision-schema-mismatch');
    if (blocker.detail !== null && blocker.detail !== undefined && typeof blocker.detail !== 'string') {
      return fail('checkpointability-decision-schema-mismatch');
    }
  }
  if (decision.checkpointable && decision.blockers.length !== 0) return fail('checkpointability-decision-schema-mismatch');
  if (!decision.checkpointable && decision.blockers.length === 0) return fail('checkpointability-decision-schema-mismatch');
  return { valid: true, reason: null };
}
// ---- post-build: assertCheckpointCoverageV2 ----
// Answers: did the actual produced checkpoint represent everything A07
// said was required? Prevents preflight-yes-but-builder-dropped-one-item.
// A03 structural validity NEVER implies semantic completeness: each
// mutation below BLOCKS even when the checkpoint stays A03-valid. A
// ContentSeal proves the bytes did not change inconsistently; it never
// proves the bytes contain all required semantic state.
function redactEqual(taskText, checkpointText) {
  const left = checkpointV2.redactCheckpointTextV2(String(taskText === null || taskText === undefined ? '' : taskText), checkpointV2.BOUNDS.redactMaxChars);
  const right = checkpointV2.redactCheckpointTextV2(String(checkpointText === null || checkpointText === undefined ? '' : checkpointText), checkpointV2.BOUNDS.redactMaxChars);
  return left === right;
}

function assertCheckpointCoverageV2(input) {
  const refused = (missing) => Object.freeze({ ok: false, reason: 'checkpointability-checkpoint-coverage-mismatch', missing: Object.freeze(missing.slice().sort()) });
  if (!input || typeof input !== 'object' || Array.isArray(input)) failGate('input is required');
  const unknownInput = unknownKeyOf(input, COVERAGE_INPUT_EXACT_KEYS);
  if (unknownInput !== null) failGate('unknown coverage field ' + unknownInput);
  if (Number(input.schemaVersion) !== CHECKPOINTABILITY_SCHEMA_VERSION) failGate('input.schemaVersion must be 1');
  const state = normalizeTaskState(input.taskState);

  const checkpointCheck = checkpointV2.validateCheckpointV2(input.checkpoint);
  if (!checkpointCheck.valid) return refused(['checkpoint:' + checkpointCheck.reason]);
  const checkpoint = input.checkpoint;

  if (checkpoint.taskId !== state.taskId || checkpoint.taskInstanceId !== state.taskInstanceId
    || checkpoint.sessionId !== state.sessionId || checkpoint.generation !== state.generation) {
    return refused(['checkpoint:binding-mismatch']);
  }

  const safeCheck = safepointV2.validateSafePointDecision(input.safePointDecision);
  if (!safeCheck.valid || !input.safePointDecision.safe) return refused(['checkpoint:safe-point-required']);
  const bindSafe = safepointV2.assertCheckpointBindsSafePoint(checkpoint, input.safePointDecision);
  if (!bindSafe.ok) return refused(['checkpoint:' + bindSafe.reason]);
  if (checkpoint.safePointBoundarySeq !== state.safePointBoundarySeq) return refused(['checkpoint:boundary-mismatch']);

  const token = input.snapshotToken === undefined ? null : input.snapshotToken;
  if (token === null) return refused(['checkpoint:snapshot-required']);
  const tokenCheck = snapshotV2.validateSnapshotToken(token);
  if (!tokenCheck.valid) return refused(['checkpoint:snapshot-required']);
  const bindSnapshot = snapshotV2.validateCheckpointSnapshotBinding(checkpoint, token);
  if (!bindSnapshot.valid) return refused(['checkpoint:' + bindSnapshot.reason]);

  const missing = [];

  if (state.objective === null) {
    missing.push('objective');
  } else if (!redactEqual(state.objective.text, checkpoint.objective.text) || state.objective.status !== checkpoint.objective.status) {
    missing.push('objective');
  }

  const checkpointRequirements = Array.isArray(checkpoint.requirements) ? checkpoint.requirements : [];
  for (const req of state.requirements) {
    const found = checkpointRequirements.find((entry) => entry.id === req.id);
    if (!found || !redactEqual(req.text, found.text) || req.status !== found.status
      || JSON.stringify(req.evidenceRefs.slice().sort()) !== JSON.stringify((found.evidenceRefs || []).map(String).sort())) {
      missing.push('requirement:' + req.id);
    }
  }

  const checkpointConstraints = Array.isArray(checkpoint.constraints) ? checkpoint.constraints : [];
  for (const constraint of state.constraints) {
    const found = checkpointConstraints.find((entry) => entry.type === constraint.type && redactEqual(constraint.text, entry.text));
    if (!found) missing.push('constraint:' + constraint.type);
  }

  if (checkpoint.progress.taskStatus !== state.progress.taskStatus
    || JSON.stringify(checkpoint.progress.completedMilestones) !== JSON.stringify(state.progress.completedMilestones)
    || (checkpoint.progress.currentMilestone === undefined ? null : checkpoint.progress.currentMilestone) !== state.progress.currentMilestone
    || JSON.stringify(checkpoint.progress.remainingMilestones) !== JSON.stringify(state.progress.remainingMilestones)) {
    missing.push('progress');
  }

  const checkpointDecisions = Array.isArray(checkpoint.decisions) ? checkpoint.decisions : [];
  for (const decision of state.decisions) {
    const found = checkpointDecisions.find((entry) => entry.id === decision.id);
    if (!found || !redactEqual(decision.statement, found.statement) || decision.authority !== found.authority
      || decision.status !== found.status
      || JSON.stringify(decision.evidenceRefs.slice().sort()) !== JSON.stringify((found.evidenceRefs || []).map(String).sort())) {
      missing.push('decision:' + decision.id);
    }
  }

  if ((checkpoint.repository.headCommit === undefined ? null : checkpoint.repository.headCommit) !== state.repository.headCommit
    || (checkpoint.repository.baseCommit === undefined ? null : checkpoint.repository.baseCommit) !== state.repository.baseCommit) {
    missing.push('repository');
  }

  const checkpointEvidence = Array.isArray(checkpoint.evidenceRefs) ? checkpoint.evidenceRefs : [];
  for (const ref of state.evidenceRefs) {
    const reconstruction = reconstructionFor(state, 'evidence:' + ref.evidenceId);
    if (reconstruction !== null) {
      if (!reconstruction.accessible) missing.push('evidence:' + ref.evidenceId);
      continue;
    }
    const found = checkpointEvidence.find((entry) => entry.evidenceId === ref.evidenceId);
    if (!found || found.locator !== ref.locator || found.kind !== ref.kind
      || (found.digest === undefined ? null : found.digest) !== ref.digest) {
      missing.push('evidence:' + ref.evidenceId);
    } else if (!ref.accessible) {
      missing.push('evidence:' + ref.evidenceId);
    }
  }
  const cited = [];
  const collectCited = (ids) => {
    for (const id of ids) {
      if (!cited.includes(id)) cited.push(id);
    }
  };
  for (const req of state.requirements) collectCited(req.evidenceRefs);
  for (const decision of state.decisions) collectCited(decision.evidenceRefs);
  for (const failure of state.failures.activeFailures) collectCited(failure.evidenceRefs);
  for (const outcome of state.verification.outcomes) collectCited(outcome.evidenceRefs);
  for (const id of cited) {
    if (evidenceAccessible(state, id) !== true) missing.push('evidence:' + id);
  }

  const checkpointFailures = checkpoint.failures;
  for (const failure of state.failures.activeFailures) {
    const found = (checkpointFailures.activeFailures || []).find((entry) => entry.id === failure.id);
    if (!found || found.status !== failure.status
      || (found.detail === undefined ? null : found.detail) !== failure.detail
      || (found.attemptCount === undefined ? null : found.attemptCount) !== failure.attemptCount) {
      missing.push('failure:' + failure.id);
    }
  }
  const expectedRetry = state.failures.retryState;
  const actualRetry = checkpointFailures.retryState === undefined ? null : checkpointFailures.retryState;
  if (expectedRetry !== null) {
    if (actualRetry === null || actualRetry === undefined
      || (actualRetry.attemptCount === undefined ? null : actualRetry.attemptCount) !== expectedRetry.attemptCount
      || (actualRetry.note === undefined ? null : actualRetry.note) !== expectedRetry.note) {
      missing.push('retry-state');
    }
  }

  const checkpointOutcomes = checkpoint.verification && Array.isArray(checkpoint.verification.outcomes)
    ? checkpoint.verification.outcomes
    : [];
  for (const outcome of state.verification.outcomes) {
    const found = checkpointOutcomes.find((entry) => entry.scope === outcome.scope);
    if (!found || found.status !== outcome.status
      || (found.detail === undefined ? null : found.detail) !== outcome.detail
      || JSON.stringify((found.evidenceRefs || []).map(String).sort()) !== JSON.stringify(outcome.evidenceRefs.slice().sort())) {
      missing.push('verification:' + outcome.scope);
    }
  }

  if (!redactEqual(state.continuation.nextAction === null ? '' : state.continuation.nextAction, checkpoint.continuation.nextAction === null || checkpoint.continuation.nextAction === undefined ? '' : checkpoint.continuation.nextAction)
    || JSON.stringify(checkpoint.continuation.unresolvedQuestions) !== JSON.stringify(state.continuation.unresolvedQuestions)
    || (checkpoint.continuation.recentUserIntent === undefined ? null : checkpoint.continuation.recentUserIntent) !== state.continuation.recentUserIntent) {
    missing.push('continuation');
  }

  // CCV2-R1: the built checkpoint must carry exactly the evaluated
  // authority completeness (absent on both sides for pre-R1 state).
  const builtCompleteness = Object.prototype.hasOwnProperty.call(checkpoint, 'authorityCompleteness')
    ? checkpoint.authorityCompleteness : null;
  if (state.authorityCompleteness === null) {
    if (builtCompleteness !== null) missing.push('authority-completeness');
  } else if (builtCompleteness === null
    || JSON.stringify(checkpointV2.canonicalize(builtCompleteness)) !== JSON.stringify(checkpointV2.canonicalize(state.authorityCompleteness))) {
    missing.push('authority-completeness');
  }

  // Authority preservation in the built artifact: every mandatory A04 path
  // must carry the evaluated sourceKind/trust. A sealed but
  // authority-shifted checkpoint still fails coverage.
  const provenanceFields = checkpoint.provenance && typeof checkpoint.provenance === 'object' && !Array.isArray(checkpoint.provenance)
    && checkpoint.provenance.fields && typeof checkpoint.provenance.fields === 'object'
    ? checkpoint.provenance.fields
    : null;
  let mandatory = [];
  try {
    mandatory = mandatoryPathsFor(state);
  } catch (error) {
    return refused(['checkpoint:provenance-unprovable']);
  }
  for (const fieldPath of mandatory) {
    const slot = state.provenance[fieldPath];
    const built = provenanceFields === null ? undefined : provenanceFields[fieldPath];
    if (slot === undefined || built === undefined) {
      missing.push('provenance:' + fieldPath);
      continue;
    }
    const expectedTrust = trustV2.CLOSED_TRUST_RULES[slot.sourceKind + ':' + slot.fieldKind];
    if (built.sourceKind !== slot.sourceKind || built.trust !== expectedTrust || built.fieldKind !== slot.fieldKind) {
      missing.push('provenance:' + fieldPath);
    }
  }

  if (missing.length > 0) return refused(missing);
  return Object.freeze({ ok: true, reason: null, missing: Object.freeze([]) });
}

module.exports = {
  CHECKPOINTABILITY_SCHEMA_VERSION,
  REQUIRED_STATE_DIGEST_DOMAIN_V1,
  REPRESENTED_STATE_DIGEST_DOMAIN_V1,
  CHECKPOINTABILITY_BLOCKER_CODES,
  AUTHORITATIVE_STATE_KINDS,
  COVERAGE_DESTINATIONS,
  EPHEMERAL_STATE_KINDS,
  NON_REQUIRED_CLASSES,
  EVIDENCE_GROUNDED_SOURCES,
  TASK_STATE_EXACT_KEYS,
  EVALUATE_INPUT_EXACT_KEYS,
  COVERAGE_INPUT_EXACT_KEYS,
  DECISION_EXACT_KEYS,
  normalizeTaskState,
  buildAuthoritativeInventory,
  deriveRequiredStateDigest,
  deriveRepresentedStateDigest,
  evaluateCheckpointabilityV2,
  validateCheckpointabilityDecision,
  assertCheckpointCoverageV2,
};