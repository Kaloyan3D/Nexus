'use strict';
/**
 * ContextCheckpointV2.cjs - CCV2-A03 Checkpoint Schema V2 production authority.
 *
 * ONE authority for the V2 checkpoint artifact: schema, builder, validator,
 * deterministic serialization, content digest, checkpoint identity,
 * persistence, and A02 operation binding. V1 schema/behavior is UNCHANGED
 * (explicit schema branching; this module never reads V1 checkpoints).
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (sections 3.3 CCv2Checkpoint, 4.5 self-contained generation, 4.10
 * integrity). A03 answers "what exact durable structured state constitutes
 * one CCv2 checkpoint generation" and NOTHING else:
 *
 *   NOT implemented here: TrustNormalizer / ContentSeal lifecycle (A04),
 *   ContextSnapshotToken (A05), SafePointDetector (A06),
 *   CheckpointabilityGate (A07), active-task production triggering,
 *   Context Pages / Compiler / DECIDE / retrieval.
 *
 * Frozen formulas (canonical; PS twins in scripts/ContextLifecycle.ps1):
 *
 *   canonical bytes  = UTF-8(canonicalJson(checkpoint WITHOUT
 *                      checkpointId + checkpointContentDigest))
 *   contentDigest    = sha256Hex(canonical bytes), lowercase hex (64)
 *   checkpointId     = 'ccp_' + sha256Hex(
 *                        'nexus/context-checkpoint/v2' LF taskId LF
 *                        taskInstanceId LF sessionId LF generation LF
 *                        contentDigest).slice(0, 32)
 *   serialized bytes = UTF-8(canonicalJson(full finalized checkpoint
 *                      INCLUDING id + digest)); hard bound <= 64 KiB.
 *
 * Builder purity: given identical grounded inputs (including createdAtUtc
 * supplied as explicit input), build twice -> byte-identical checkpoint.
 * createdAtUtc is NEVER read from the clock inside canonicalization.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
// A05: snapshot-identity shapes only (no minting here; SnapshotManager owns
// capture/derivation/revalidation and this module never mints token ids).
const snapshotV2 = require('./ContextSnapshotV2.cjs');

const CHECKPOINT_SCHEMA_VERSION_V2 = 2;
const CHECKPOINT_ID_DOMAIN_V2 = 'nexus/context-checkpoint/v2';
const CHECKPOINT_MAX_BYTES = 65536; // 64 KiB, measured in UTF-8 bytes.
const CHECKPOINT_FILE_PREFIX = 'cp-';

// ---- field bounds (frozen; validator enforces, builder fails closed) ----
const BOUNDS = Object.freeze({
  taskId: 256,
  taskInstanceId: 256,
  sessionId: 256,
  workspaceId: 512,
  repositoryId: 256,
  checkoutId: 256,
  stepId: 256,
  objectiveText: 2000,
  objectiveStatus: 64,
  requirementsMax: 100,
  requirementId: 128,
  requirementText: 1000,
  requirementEvidenceMax: 10,
  requirementEvidenceRef: 256,
  constraintsMax: 50,
  constraintType: 64,
  constraintText: 1000,
  milestonesMax: 50,
  milestoneText: 500,
  decisionsMax: 50,
  decisionId: 128,
  decisionStatement: 1000,
  decisionEvidenceMax: 10,
  evidenceRefsMax: 50,
  evidenceId: 256,
  evidenceLocator: 1000,
  evidenceDigest: 128,
  repositoryChangedFilesMax: 100,
  repositoryChangedFile: 500,
  repositoryCommit: 256,
  repositorySummary: 1000,
  failureMax: 20,
  failureId: 256,
  failureStatus: 64,
  failureDetail: 1000,
  hypothesisText: 1000,
  retryNote: 500,
  verificationOutcomesMax: 20,
  verificationScope: 256,
  verificationDetail: 1000,
  nextAction: 1000,
  unresolvedMax: 20,
  unresolvedText: 500,
  recentUserIntent: 1000,
  provenanceNotes: 1000,
  redactMaxChars: 4000,
});

const REQUIREMENT_STATUSES = Object.freeze(['active', 'satisfied', 'superseded']);
const DECISION_AUTHORITIES = Object.freeze([
  'agent-proposed',
  'user-approved',
  'controller-established',
  'evidence-supported',
]);
const DECISION_STATUSES = Object.freeze(['active', 'superseded']);
const VERIFICATION_STATUSES = Object.freeze(['PASS', 'FAIL', 'PENDING', 'UNVERIFIED']);
const CHECKPOINT_KINDS = Object.freeze(['active', 'complete']);
const EVIDENCE_KINDS = Object.freeze(['file', 'command', 'verification', 'artifact', 'event']);

// Keys that must never appear in a checkpoint (bulk / secret / reasoning).
const FORBIDDEN_KEYS = Object.freeze([
  'chainOfThought', 'chain-of-thought', 'hiddenReasoning', 'hidden-reasoning',
  'reasoning', 'thought',
  'shellLog', 'testLog', 'fullLog', 'toolTranscript',
  'sourceFile', 'sourceFiles', 'fileContents', 'diff', 'fullDiff',
  'envDump', 'environment', 'providerRequest', 'requestBody',
  'credentials', 'apiKey', 'accessToken', 'password', 'secret',
  'authorization',
]);

// A05H H1 closed-world exact-key validation. Every protocol object below
// FAILS CLOSED on unknown keys: unknown fields are never digested-and-
// accepted, never stripped, never ignored. Each check runs BEFORE the
// section's value checks (and always before the digest/id legs at the end),
// so a recomputed digest/id can never legalize an unknown schema field.
// Reason codes reuse the section's existing frozen code.
const CHECKPOINT_TOP_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'generation', 'parentCheckpointId', 'kind',
  'taskId', 'taskInstanceId', 'sessionId', 'workspaceId',
  'repositoryId', 'checkoutId', 'safePointBoundarySeq', 'safePointStepId',
  'createdAtUtc', 'objective', 'requirements', 'constraints', 'progress',
  'decisions', 'repository', 'evidenceRefs', 'failures', 'verification',
  'continuation', 'snapshot', 'provenance', 'pressure',
  'checkpointContentDigest', 'checkpointId', 'seal',
]);
const CHECKPOINT_OBJECTIVE_EXACT_KEYS = Object.freeze(['text', 'status']);
const CHECKPOINT_REQUIREMENT_EXACT_KEYS = Object.freeze(['id', 'text', 'status', 'evidenceRefs']);
const CHECKPOINT_CONSTRAINT_EXACT_KEYS = Object.freeze(['type', 'text']);
const CHECKPOINT_PROGRESS_EXACT_KEYS = Object.freeze([
  'taskStatus', 'completedMilestones', 'currentMilestone', 'remainingMilestones',
]);
const CHECKPOINT_DECISION_EXACT_KEYS = Object.freeze([
  'id', 'statement', 'authority', 'status', 'evidenceRefs',
]);
const CHECKPOINT_REPOSITORY_EXACT_KEYS = Object.freeze([
  'repositoryId', 'checkoutId', 'headCommit', 'baseCommit', 'cleanWorktree',
  'changedFiles', 'changedFileCount', 'changedFilesTruncated',
  'stagedSummary', 'unstagedSummary',
]);
const CHECKPOINT_EVIDENCE_REF_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'evidenceId', 'kind', 'locator', 'digest',
  'observedAtUtc', 'taskInstanceId',
]);
const CHECKPOINT_FAILURES_EXACT_KEYS = Object.freeze([
  'activeFailures', 'rejectedHypotheses', 'retryState',
]);
const CHECKPOINT_ACTIVE_FAILURE_EXACT_KEYS = Object.freeze([
  'id', 'status', 'detail', 'attemptCount', 'evidenceRefs',
]);
const CHECKPOINT_RETRY_STATE_EXACT_KEYS = Object.freeze([
  'attemptCount', 'nextRetryAtUtc', 'note',
]);
const CHECKPOINT_VERIFICATION_EXACT_KEYS = Object.freeze(['outcomes', 'note']);
const CHECKPOINT_VERIFICATION_OUTCOME_EXACT_KEYS = Object.freeze([
  'scope', 'status', 'detail', 'evidenceRefs',
]);
const CHECKPOINT_CONTINUATION_EXACT_KEYS = Object.freeze([
  'nextAction', 'unresolvedQuestions', 'recentUserIntent',
]);
const CHECKPOINT_SNAPSHOT_SLOT_EXACT_KEYS = Object.freeze([
  'snapshotTokenId', 'revisionDigest',
]);
const CHECKPOINT_PRESSURE_EXACT_KEYS = Object.freeze([
  'preCheckpointEffectiveInputTokens', 'peakEffectiveInputTokens',
]);
const CHECKPOINT_PROVENANCE_MAP_EXACT_KEYS = Object.freeze(['schemaVersion', 'fields']);
const CHECKPOINT_PROVENANCE_LEGACY_EXACT_KEYS = Object.freeze(['sourceNotes', 'collectedAtUtc']);
const CHECKPOINT_PROVENANCE_ENTRY_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'sourceKind', 'trust', 'sourceRefs', 'authorityScope', 'fieldKind',
]);
const CHECKPOINT_SEAL_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'checkpointId', 'checkpointContentDigest', 'generation',
  'taskId', 'taskInstanceId', 'sessionId', 'sealedAtUtc', 'algorithm', 'sealDigest',
]);

function unknownCheckpointKeyOf(value, allowedKeys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) return key;
  }
  return null;
}

function sha256HexUtf8(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function byteLengthUtf8(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

// ---- deterministic V2 redaction (mirrors V1 machinery, no LLM) ----
// V1 sources: redactControllerDiagnostic (config/AihController.cjs) and
// ConvertTo-AihContextRedactedText (scripts/ContextLifecycle.ps1). V2 keeps
// the same deterministic regex pipeline semantics in JS: PEM blocks first,
// URL userinfo, URL query credentials, Bearer, key shapes, key=value
// assignments, sensitive JSON properties. Every replacement emits the stable
// '<redacted>' marker; the matched secret value is never logged/persisted.
function redactCheckpointTextV2(value, maxChars) {
  let text = String(value == null ? '' : value);
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : BOUNDS.redactMaxChars;
  text = text.replace(/-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi, '<redacted>');
  text = text.replace(/([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1<redacted>@');
  text = text.replace(/([?&#;](?:token|access_token|api[_-]?key|client_secret|password|secret|auth)\s*=\s*)([^\s&#;]+)/gi, '$1<redacted>');
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<redacted>');
  text = text.replace(/\b(sk-[A-Za-z0-9_\-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[bpas]-[A-Za-z0-9\-]{8,})\b/g, '<redacted>');
  text = text.replace(/\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token)[A-Za-z0-9_.-]*\s*[:=]\s*)(["']?)([^\s,;"']+)(["']?)/gi, '$1$2<redacted>$4');
  text = text.replace(/("(?:apiKey|api_key|accessToken|access_token|clientSecret|client_secret|password|authorization|token|secret)"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2');
  text = text.trim();
  if (text.length > limit) text = text.slice(0, limit) + '...<truncated>';
  return text;
}

function redactCheckpointValueV2(value, maxChars) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactCheckpointTextV2(value, maxChars);
  if (Array.isArray(value)) return value.map((entry) => redactCheckpointValueV2(entry, maxChars));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = redactCheckpointValueV2(value[key], maxChars);
    return out;
  }
  return value;
}

// ---- deterministic canonical serialization ----
// Canonical form: plain objects with keys sorted lexicographically
// (recursive); arrays keep author order; no whitespace. Same semantic
// finalized checkpoint -> same bytes regardless of insertion order.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function serializeCheckpointCanonical(checkpoint) {
  return JSON.stringify(canonicalize(checkpoint));
}

function checkpointPayloadWithoutIdentity(checkpoint) {
  const copy = {};
  for (const key of Object.keys(checkpoint)) {
    // A04: the content seal binds the digest/identity but is NOT part of the
    // digested payload (exactly like checkpointId/checkpointContentDigest).
    // Provenance IS part of the payload: changing it changes the digest/id.
    if (key === 'checkpointId' || key === 'checkpointContentDigest' || key === 'seal') continue;
    copy[key] = checkpoint[key];
  }
  return copy;
}

function deriveCheckpointContentDigest(checkpointWithoutIdentity) {
  return sha256HexUtf8(serializeCheckpointCanonical(checkpointWithoutIdentity));
}

function deriveCheckpointIdV2(taskId, taskInstanceId, sessionId, generation, contentDigest) {
  if (typeof taskId !== 'string' || taskId === '') throw new Error('v2-checkpoint-id: taskId is required');
  if (typeof taskInstanceId !== 'string' || taskInstanceId === '') throw new Error('v2-checkpoint-id: taskInstanceId is required');
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('v2-checkpoint-id: sessionId is required');
  if (!Number.isInteger(generation) || generation < 1) throw new Error('v2-checkpoint-id: generation must be a positive integer');
  if (typeof contentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(contentDigest)) throw new Error('v2-checkpoint-id: contentDigest must be sha256 hex');
  const joined = [CHECKPOINT_ID_DOMAIN_V2, taskId, taskInstanceId, sessionId, String(generation), contentDigest].join('\n');
  return 'ccp_' + sha256HexUtf8(joined).slice(0, 32);
}

// ---- closed-world V2 validator ----
function isIsoUtc(value) {
  if (typeof value !== 'string' || value === '') return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
}

function isBoundedString(value, max, allowEmpty) {
  if (typeof value !== 'string') return false;
  if (!allowEmpty && value === '') return false;
  return value.length <= max;
}

function walkStrings(value, visit) {
  if (typeof value === 'string') { visit(value); return; }
  if (Array.isArray(value)) { for (const entry of value) walkStrings(entry, visit); return; }
  if (value !== null && typeof value === 'object') { for (const key of Object.keys(value)) { visit(key, true); walkStrings(value[key], visit); } }
}

function validateEvidenceRef(ref, taskInstanceId) {
  if (!ref || typeof ref !== 'object') return 'checkpoint-evidence-invalid';
  if (unknownCheckpointKeyOf(ref, CHECKPOINT_EVIDENCE_REF_EXACT_KEYS) !== null) return 'checkpoint-evidence-invalid';
  if (Number(ref.schemaVersion) !== 1) return 'checkpoint-evidence-invalid';
  if (!isBoundedString(ref.evidenceId, BOUNDS.evidenceId, false)) return 'checkpoint-evidence-invalid';
  if (!EVIDENCE_KINDS.includes(ref.kind)) return 'checkpoint-evidence-invalid';
  if (!isBoundedString(ref.locator, BOUNDS.evidenceLocator, false)) return 'checkpoint-evidence-invalid';
  if (ref.digest !== null && ref.digest !== undefined && !isBoundedString(String(ref.digest), BOUNDS.evidenceDigest, false)) return 'checkpoint-evidence-invalid';
  if (!isIsoUtc(ref.observedAtUtc)) return 'checkpoint-evidence-invalid';
  if (typeof ref.taskInstanceId !== 'string' || ref.taskInstanceId === '' || ref.taskInstanceId !== taskInstanceId) return 'checkpoint-evidence-invalid';
  return null;
}

function validateCheckpointV2(checkpoint) {
  const fail = (reason) => ({ valid: false, reason });
  if (!checkpoint || typeof checkpoint !== 'object') return fail('checkpoint-missing');
  if (Number(checkpoint.schemaVersion) !== CHECKPOINT_SCHEMA_VERSION_V2) return fail('checkpoint-schema-version');
  if (unknownCheckpointKeyOf(checkpoint, CHECKPOINT_TOP_EXACT_KEYS) !== null) return fail('checkpoint-schema-version');
  if (!isBoundedString(checkpoint.checkpointId, 128, false)) return fail('checkpoint-identity-invalid');
  if (typeof checkpoint.checkpointContentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(checkpoint.checkpointContentDigest)) return fail('checkpoint-identity-invalid');
  if (!Number.isInteger(checkpoint.generation) || checkpoint.generation < 1) return fail('checkpoint-generation-invalid');
  if (checkpoint.parentCheckpointId !== null && !isBoundedString(checkpoint.parentCheckpointId, 128, false)) return fail('checkpoint-parent-invalid');
  if (checkpoint.generation === 1 && checkpoint.parentCheckpointId !== null) return fail('checkpoint-parent-invalid');
  if (checkpoint.generation > 1 && checkpoint.parentCheckpointId === null) return fail('checkpoint-parent-invalid');
  if (!CHECKPOINT_KINDS.includes(checkpoint.kind)) return fail('checkpoint-kind-invalid');
  if (!isBoundedString(checkpoint.taskId, BOUNDS.taskId, false)) return fail('checkpoint-identity-invalid');
  if (!isBoundedString(checkpoint.taskInstanceId, BOUNDS.taskInstanceId, false)) return fail('checkpoint-identity-invalid');
  if (!isBoundedString(checkpoint.sessionId, BOUNDS.sessionId, false)) return fail('checkpoint-identity-invalid');
  if (!isBoundedString(checkpoint.workspaceId, BOUNDS.workspaceId, false)) return fail('checkpoint-identity-invalid');
  if (checkpoint.repositoryId !== null && !isBoundedString(checkpoint.repositoryId, BOUNDS.repositoryId, true)) return fail('checkpoint-repository-invalid');
  if (checkpoint.checkoutId !== null && !isBoundedString(checkpoint.checkoutId, BOUNDS.checkoutId, true)) return fail('checkpoint-repository-invalid');
  if (!Number.isInteger(checkpoint.safePointBoundarySeq) || checkpoint.safePointBoundarySeq < 0) return fail('checkpoint-boundary-invalid');
  if (checkpoint.safePointStepId !== null && checkpoint.safePointStepId !== undefined && !isBoundedString(checkpoint.safePointStepId, BOUNDS.stepId, true)) return fail('checkpoint-boundary-invalid');
  if (!isIsoUtc(checkpoint.createdAtUtc)) return fail('checkpoint-identity-invalid');

  const objective = checkpoint.objective;
  if (!objective || typeof objective !== 'object') return fail('checkpoint-objective-missing');
  if (unknownCheckpointKeyOf(objective, CHECKPOINT_OBJECTIVE_EXACT_KEYS) !== null) return fail('checkpoint-objective-missing');
  if (!isBoundedString(objective.text, BOUNDS.objectiveText, false)) return fail('checkpoint-objective-missing');
  if (!isBoundedString(objective.status, BOUNDS.objectiveStatus, false)) return fail('checkpoint-objective-missing');

  const requirements = checkpoint.requirements;
  if (!Array.isArray(requirements)) return fail('checkpoint-requirements-invalid');
  if (requirements.length > BOUNDS.requirementsMax) return fail('checkpoint-requirements-invalid');
  for (const req of requirements) {
    if (!req || typeof req !== 'object') return fail('checkpoint-requirements-invalid');
    if (unknownCheckpointKeyOf(req, CHECKPOINT_REQUIREMENT_EXACT_KEYS) !== null) return fail('checkpoint-requirements-invalid');
    if (!isBoundedString(req.id, BOUNDS.requirementId, false)) return fail('checkpoint-requirements-invalid');
    if (!isBoundedString(req.text, BOUNDS.requirementText, false)) return fail('checkpoint-requirements-invalid');
    if (!REQUIREMENT_STATUSES.includes(req.status)) return fail('checkpoint-requirements-invalid');
    if (!Array.isArray(req.evidenceRefs)) return fail('checkpoint-requirements-invalid');
    if (req.evidenceRefs.length > BOUNDS.requirementEvidenceMax) return fail('checkpoint-requirements-invalid');
    for (const ref of req.evidenceRefs) {
      if (!isBoundedString(ref, BOUNDS.requirementEvidenceRef, true)) return fail('checkpoint-requirements-invalid');
    }
  }

  const constraints = checkpoint.constraints;
  if (!Array.isArray(constraints)) return fail('checkpoint-constraints-invalid');
  if (constraints.length > BOUNDS.constraintsMax) return fail('checkpoint-constraints-invalid');
  for (const constraint of constraints) {
    if (!constraint || typeof constraint !== 'object') return fail('checkpoint-constraints-invalid');
    if (unknownCheckpointKeyOf(constraint, CHECKPOINT_CONSTRAINT_EXACT_KEYS) !== null) return fail('checkpoint-constraints-invalid');
    if (!isBoundedString(constraint.type, BOUNDS.constraintType, false)) return fail('checkpoint-constraints-invalid');
    if (!isBoundedString(constraint.text, BOUNDS.constraintText, false)) return fail('checkpoint-constraints-invalid');
  }

  const progress = checkpoint.progress;
  if (!progress || typeof progress !== 'object') return fail('checkpoint-progress-invalid');
  if (unknownCheckpointKeyOf(progress, CHECKPOINT_PROGRESS_EXACT_KEYS) !== null) return fail('checkpoint-progress-invalid');
  if (!isBoundedString(progress.taskStatus, 64, false)) return fail('checkpoint-progress-invalid');
  for (const listKey of ['completedMilestones', 'remainingMilestones']) {
    if (!Array.isArray(progress[listKey])) return fail('checkpoint-progress-invalid');
    if (progress[listKey].length > BOUNDS.milestonesMax) return fail('checkpoint-progress-invalid');
    for (const entry of progress[listKey]) {
      if (!isBoundedString(entry, BOUNDS.milestoneText, false)) return fail('checkpoint-progress-invalid');
    }
  }
  if (progress.currentMilestone !== null && progress.currentMilestone !== undefined && !isBoundedString(progress.currentMilestone, BOUNDS.milestoneText, true)) return fail('checkpoint-progress-invalid');

  const decisions = checkpoint.decisions;
  if (!Array.isArray(decisions)) return fail('checkpoint-decisions-invalid');
  if (decisions.length > BOUNDS.decisionsMax) return fail('checkpoint-decisions-invalid');
  for (const decision of decisions) {
    if (!decision || typeof decision !== 'object') return fail('checkpoint-decisions-invalid');
    if (unknownCheckpointKeyOf(decision, CHECKPOINT_DECISION_EXACT_KEYS) !== null) return fail('checkpoint-decisions-invalid');
    if (!isBoundedString(decision.id, BOUNDS.decisionId, false)) return fail('checkpoint-decisions-invalid');
    if (!isBoundedString(decision.statement, BOUNDS.decisionStatement, false)) return fail('checkpoint-decisions-invalid');
    if (!DECISION_AUTHORITIES.includes(decision.authority)) return fail('checkpoint-decisions-invalid');
    if (!DECISION_STATUSES.includes(decision.status)) return fail('checkpoint-decisions-invalid');
    if (decision.evidenceRefs !== undefined && decision.evidenceRefs !== null) {
      if (!Array.isArray(decision.evidenceRefs) || decision.evidenceRefs.length > BOUNDS.decisionEvidenceMax) return fail('checkpoint-decisions-invalid');
    }
  }

  const repository = checkpoint.repository;
  if (!repository || typeof repository !== 'object') return fail('checkpoint-repository-invalid');
  if (unknownCheckpointKeyOf(repository, CHECKPOINT_REPOSITORY_EXACT_KEYS) !== null) return fail('checkpoint-repository-invalid');
  if (repository.repositoryId !== null && repository.repositoryId !== undefined && !isBoundedString(String(repository.repositoryId), BOUNDS.repositoryId, true)) return fail('checkpoint-repository-invalid');
  if (repository.checkoutId !== null && repository.checkoutId !== undefined && !isBoundedString(String(repository.checkoutId), BOUNDS.checkoutId, true)) return fail('checkpoint-repository-invalid');
  if (repository.headCommit !== null && repository.headCommit !== undefined && !isBoundedString(String(repository.headCommit), BOUNDS.repositoryCommit, true)) return fail('checkpoint-repository-invalid');
  if (repository.baseCommit !== null && repository.baseCommit !== undefined && !isBoundedString(String(repository.baseCommit), BOUNDS.repositoryCommit, true)) return fail('checkpoint-repository-invalid');
  if (repository.cleanWorktree !== null && repository.cleanWorktree !== undefined && typeof repository.cleanWorktree !== 'boolean') return fail('checkpoint-repository-invalid');
  if (!Array.isArray(repository.changedFiles)) return fail('checkpoint-repository-invalid');
  if (repository.changedFiles.length > BOUNDS.repositoryChangedFilesMax) return fail('checkpoint-repository-invalid');
  for (const file of repository.changedFiles) {
    if (!isBoundedString(file, BOUNDS.repositoryChangedFile, false)) return fail('checkpoint-repository-invalid');
  }
  if (!Number.isInteger(repository.changedFileCount) || repository.changedFileCount < repository.changedFiles.length) return fail('checkpoint-repository-invalid');
  if (typeof repository.changedFilesTruncated !== 'boolean') return fail('checkpoint-repository-invalid');
  if (repository.changedFilesTruncated === false && repository.changedFileCount !== repository.changedFiles.length) return fail('checkpoint-repository-invalid');
  for (const summaryKey of ['stagedSummary', 'unstagedSummary']) {
    const summary = repository[summaryKey];
    if (summary !== null && summary !== undefined && !isBoundedString(String(summary), BOUNDS.repositorySummary, true)) return fail('checkpoint-repository-invalid');
  }

  const evidenceRefs = checkpoint.evidenceRefs;
  if (!Array.isArray(evidenceRefs)) return fail('checkpoint-evidence-invalid');
  if (evidenceRefs.length > BOUNDS.evidenceRefsMax) return fail('checkpoint-evidence-invalid');
  for (const ref of evidenceRefs) {
    const reason = validateEvidenceRef(ref, checkpoint.taskInstanceId);
    if (reason) return fail(reason);
  }

  const failures = checkpoint.failures;
  if (!failures || typeof failures !== 'object') return fail('checkpoint-failures-invalid');
  if (unknownCheckpointKeyOf(failures, CHECKPOINT_FAILURES_EXACT_KEYS) !== null) return fail('checkpoint-failures-invalid');
  if (!Array.isArray(failures.activeFailures) || !Array.isArray(failures.rejectedHypotheses)) return fail('checkpoint-failures-invalid');
  if (failures.activeFailures.length > BOUNDS.failureMax || failures.rejectedHypotheses.length > BOUNDS.failureMax) return fail('checkpoint-failures-invalid');
  for (const failure of failures.activeFailures) {
    if (!failure || typeof failure !== 'object') return fail('checkpoint-failures-invalid');
    if (unknownCheckpointKeyOf(failure, CHECKPOINT_ACTIVE_FAILURE_EXACT_KEYS) !== null) return fail('checkpoint-failures-invalid');
    if (!isBoundedString(failure.id, BOUNDS.failureId, false)) return fail('checkpoint-failures-invalid');
    if (!isBoundedString(failure.status, BOUNDS.failureStatus, false)) return fail('checkpoint-failures-invalid');
    if (failure.detail !== undefined && failure.detail !== null && !isBoundedString(String(failure.detail), BOUNDS.failureDetail, true)) return fail('checkpoint-failures-invalid');
    if (failure.evidenceRefs !== undefined && failure.evidenceRefs !== null) {
      if (!Array.isArray(failure.evidenceRefs)) return fail('checkpoint-failures-invalid');
      for (const ref of failure.evidenceRefs) {
        if (!isBoundedString(ref, BOUNDS.requirementEvidenceRef, true)) return fail('checkpoint-failures-invalid');
      }
    }
  }
  for (const hypothesis of failures.rejectedHypotheses) {
    if (!isBoundedString(hypothesis, BOUNDS.hypothesisText, false)) return fail('checkpoint-failures-invalid');
  }
  if (failures.retryState !== null && failures.retryState !== undefined) {
    if (typeof failures.retryState !== 'object') return fail('checkpoint-failures-invalid');
    if (unknownCheckpointKeyOf(failures.retryState, CHECKPOINT_RETRY_STATE_EXACT_KEYS) !== null) return fail('checkpoint-failures-invalid');
    if (failures.retryState.note !== undefined && failures.retryState.note !== null && !isBoundedString(String(failures.retryState.note), BOUNDS.retryNote, true)) return fail('checkpoint-failures-invalid');
  }

  const verification = checkpoint.verification;
  if (!verification || typeof verification !== 'object') return fail('checkpoint-verification-invalid');
  if (unknownCheckpointKeyOf(verification, CHECKPOINT_VERIFICATION_EXACT_KEYS) !== null) return fail('checkpoint-verification-invalid');
  if (!Array.isArray(verification.outcomes)) return fail('checkpoint-verification-invalid');
  if (verification.outcomes.length > BOUNDS.verificationOutcomesMax) return fail('checkpoint-verification-invalid');
  for (const outcome of verification.outcomes) {
    if (!outcome || typeof outcome !== 'object') return fail('checkpoint-verification-invalid');
    if (unknownCheckpointKeyOf(outcome, CHECKPOINT_VERIFICATION_OUTCOME_EXACT_KEYS) !== null) return fail('checkpoint-verification-invalid');
    if (!isBoundedString(outcome.scope, BOUNDS.verificationScope, false)) return fail('checkpoint-verification-invalid');
    if (!VERIFICATION_STATUSES.includes(outcome.status)) return fail('checkpoint-verification-invalid');
    if (outcome.detail !== undefined && outcome.detail !== null && !isBoundedString(String(outcome.detail), BOUNDS.verificationDetail, true)) return fail('checkpoint-verification-invalid');
  }

  const continuation = checkpoint.continuation;
  if (!continuation || typeof continuation !== 'object') return fail('checkpoint-continuation-invalid');
  if (unknownCheckpointKeyOf(continuation, CHECKPOINT_CONTINUATION_EXACT_KEYS) !== null) return fail('checkpoint-continuation-invalid');
  if (continuation.nextAction !== null && continuation.nextAction !== undefined && !isBoundedString(String(continuation.nextAction), BOUNDS.nextAction, true)) return fail('checkpoint-continuation-invalid');
  if (!Array.isArray(continuation.unresolvedQuestions)) return fail('checkpoint-continuation-invalid');
  if (continuation.unresolvedQuestions.length > BOUNDS.unresolvedMax) return fail('checkpoint-continuation-invalid');
  for (const question of continuation.unresolvedQuestions) {
    if (!isBoundedString(question, BOUNDS.unresolvedText, false)) return fail('checkpoint-continuation-invalid');
  }
  if (continuation.recentUserIntent !== null && continuation.recentUserIntent !== undefined && !isBoundedString(String(continuation.recentUserIntent), BOUNDS.recentUserIntent, true)) return fail('checkpoint-continuation-invalid');

  // A05 snapshot semantics (additive, A03 legacy preserved): the snapshot
  // slot is EITHER legacy pre-A05 (both null; never reinterpreted as
  // bound) OR A05 snapshot-bound (both non-null token identity embedded
  // verbatim from a real SnapshotManager capture). Mixed null/non-null
  // FAILS CLOSED. Structural shape is enforced here; checkpoint<->token
  // binding and freshness are owned by ContextSnapshotV2
  // (validateCheckpointSnapshotBinding / revalidate) and never proven by
  // this leg alone.
  const snapshot = checkpoint.snapshot;
  if (!snapshot || typeof snapshot !== 'object') return fail('checkpoint-snapshot-invalid');
  if (unknownCheckpointKeyOf(snapshot, CHECKPOINT_SNAPSHOT_SLOT_EXACT_KEYS) !== null) return fail('checkpoint-snapshot-invalid');
  if (snapshot.snapshotTokenId === null && snapshot.revisionDigest === null) {
    // Legacy pre-A05 checkpoint: structurally accepted, NOT snapshot-bound.
  } else if (
    typeof snapshot.snapshotTokenId === 'string' &&
    snapshotV2.TOKEN_ID_PATTERN.test(snapshot.snapshotTokenId) &&
    typeof snapshot.revisionDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(snapshot.revisionDigest)
  ) {
    // A05 snapshot-bound checkpoint: shapes valid; digest/id legs below
    // recompute over the payload INCLUDING this slot, so any snapshot
    // reference change moves checkpointContentDigest/checkpointId.
  } else {
    return fail('checkpoint-snapshot-invalid');
  }

  const provenance = checkpoint.provenance;
  if (provenance !== null && provenance !== undefined) {
    if (typeof provenance !== 'object') return fail('checkpoint-provenance-invalid');
    // A05H H1: the provenance envelope itself is closed-world. The map
    // shape and the legacy shape are mutually exclusive (see builder).
    if (provenance.fields !== undefined && provenance.fields !== null) {
      if (unknownCheckpointKeyOf(provenance, CHECKPOINT_PROVENANCE_MAP_EXACT_KEYS) !== null) return fail('checkpoint-provenance-invalid');
    } else if (unknownCheckpointKeyOf(provenance, CHECKPOINT_PROVENANCE_LEGACY_EXACT_KEYS) !== null) {
      return fail('checkpoint-provenance-invalid');
    }
    if (provenance.fields !== undefined && provenance.fields !== null) {
      // A04 provenance map shape: { schemaVersion: 1, fields: { path: TrustProvenance } }.
      // Structural validation here (bounds + enums); closed-world authority
      // (sourceKind/trust derivability) is enforced by ContextTrustV2, which
      // owns the mapping. Legacy { sourceNotes } shape remains accepted below.
      if (Number(provenance.schemaVersion) !== 1) return fail('checkpoint-provenance-invalid');
      if (typeof provenance.fields !== 'object' || Array.isArray(provenance.fields)) return fail('checkpoint-provenance-invalid');
      const fieldPaths = Object.keys(provenance.fields);
      if (fieldPaths.length === 0) return fail('checkpoint-provenance-missing');
      if (fieldPaths.length > 96) return fail('checkpoint-provenance-invalid');
      const knownSources = ['controller', 'user', 'agent', 'repository', 'tool', 'verification', 'review'];
      const knownTrusts = ['authoritative', 'user-intent', 'evidence', 'advisory', 'untrusted-data'];
      for (const fieldPath of fieldPaths) {
        if (typeof fieldPath !== 'string' || fieldPath === '' || fieldPath.length > 256) return fail('checkpoint-provenance-invalid');
        const entry = provenance.fields[fieldPath];
        if (!entry || typeof entry !== 'object') return fail('checkpoint-provenance-invalid');
        if (unknownCheckpointKeyOf(entry, CHECKPOINT_PROVENANCE_ENTRY_EXACT_KEYS) !== null) return fail('checkpoint-provenance-invalid');
        if (Number(entry.schemaVersion) !== 1) return fail('checkpoint-provenance-invalid');
        if (!knownSources.includes(entry.sourceKind)) return fail('checkpoint-provenance-invalid');
        if (!knownTrusts.includes(entry.trust)) return fail('checkpoint-provenance-invalid');
        if (!Array.isArray(entry.sourceRefs) || entry.sourceRefs.length === 0 || entry.sourceRefs.length > 8) {
          return fail('checkpoint-provenance-source-ref-invalid');
        }
        for (const ref of entry.sourceRefs) {
          if (typeof ref !== 'string' || ref === '' || ref.length > 256) return fail('checkpoint-provenance-source-ref-invalid');
        }
        if (entry.authorityScope !== null && entry.authorityScope !== undefined) {
          if (typeof entry.authorityScope !== 'string' || entry.authorityScope === '' || entry.authorityScope.length > 128) {
            return fail('checkpoint-provenance-invalid');
          }
        }
      }
    } else if (provenance.sourceNotes !== undefined && provenance.sourceNotes !== null && !isBoundedString(String(provenance.sourceNotes), BOUNDS.provenanceNotes, true)) {
      return fail('checkpoint-provenance-invalid');
    }
  }

  // A04 seal field: structural validation only. The seal is excluded from the
  // digest (see checkpointPayloadWithoutIdentity); identity binding
  // (seal <-> checkpointId/digest/generation/task/session) is enforced by
  // ContextTrustV2.validateContentSeal, which owns seal semantics.
  const seal = checkpoint.seal;
  if (seal !== null && seal !== undefined) {
    if (typeof seal !== 'object' || Array.isArray(seal)) return fail('checkpoint-seal-invalid');
    if (unknownCheckpointKeyOf(seal, CHECKPOINT_SEAL_EXACT_KEYS) !== null) return fail('checkpoint-seal-invalid');
    if (Number(seal.schemaVersion) !== 1) return fail('checkpoint-seal-invalid');
    if (seal.algorithm !== 'sha256') return fail('checkpoint-seal-invalid');
    if (!isBoundedString(seal.checkpointId, 128, false)) return fail('checkpoint-seal-invalid');
    if (typeof seal.checkpointContentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(seal.checkpointContentDigest)) return fail('checkpoint-seal-invalid');
    if (!Number.isInteger(seal.generation) || seal.generation < 1) return fail('checkpoint-seal-invalid');
    if (!isBoundedString(seal.taskId, BOUNDS.taskId, false)) return fail('checkpoint-seal-invalid');
    if (!isBoundedString(seal.taskInstanceId, BOUNDS.taskInstanceId, false)) return fail('checkpoint-seal-invalid');
    if (!isBoundedString(seal.sessionId, BOUNDS.sessionId, false)) return fail('checkpoint-seal-invalid');
    if (!isIsoUtc(seal.sealedAtUtc)) return fail('checkpoint-seal-invalid');
    // A04R: the seal-record digest is structurally required on every sealed
    // checkpoint; record-mismatch itself is reported by ContextTrustV2 with
    // checkpoint-seal-record-digest-mismatch.
    if (typeof seal.sealDigest !== 'string' || !/^[0-9a-f]{64}$/.test(seal.sealDigest)) return fail('checkpoint-seal-invalid');
  }

  const pressure = checkpoint.pressure;
  if (pressure !== null && pressure !== undefined) {
    if (typeof pressure !== 'object') return fail('checkpoint-pressure-invalid');
    if (unknownCheckpointKeyOf(pressure, CHECKPOINT_PRESSURE_EXACT_KEYS) !== null) return fail('checkpoint-pressure-invalid');
    for (const key of ['preCheckpointEffectiveInputTokens', 'peakEffectiveInputTokens']) {
      const tokens = pressure[key];
      if (tokens !== null && tokens !== undefined && (!Number.isInteger(tokens) || tokens < 0)) return fail('checkpoint-pressure-invalid');
    }
  }

  // Forbidden bulk / secret-adjacent shape: closed-world rejection.
  let forbidden = null;
  walkStrings(checkpoint, (text, isKey) => {
    if (forbidden) return;
    if (isKey && FORBIDDEN_KEYS.includes(text)) forbidden = text;
  });
  if (forbidden) return fail('checkpoint-forbidden-content');
  let pemLeak = false;
  walkStrings(checkpoint, (text, isKey) => {
    if (isKey || pemLeak) return;
    if (/-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/i.test(text) && !text.includes('<redacted>')) pemLeak = true;
  });
  if (pemLeak) return fail('checkpoint-forbidden-content');

  // Byte identity: recompute digest + id over the supplied object.
  const recomputedDigest = deriveCheckpointContentDigest(checkpointPayloadWithoutIdentity(checkpoint));
  if (recomputedDigest !== checkpoint.checkpointContentDigest) return fail('checkpoint-content-digest-mismatch');
  let expectedId = null;
  try {
    expectedId = deriveCheckpointIdV2(checkpoint.taskId, checkpoint.taskInstanceId, checkpoint.sessionId, checkpoint.generation, checkpoint.checkpointContentDigest);
  } catch { return fail('checkpoint-id-mismatch'); }
  if (checkpoint.checkpointId !== expectedId) return fail('checkpoint-id-mismatch');

  // Hard size bound on the exact canonical serialized bytes.
  const bytes = byteLengthUtf8(serializeCheckpointCanonical(checkpoint));
  if (bytes > CHECKPOINT_MAX_BYTES) return fail('checkpoint-size-limit');

  return { valid: true, reason: null, sizeBytes: bytes };
}

// A04: provenance source selection. Legacy { sourceNotes } (A03) and the
// A04 provenance map { schemaVersion: 1, fields } are mutually exclusive;
// supplying both FAILS CLOSED. The map is canonicalized (sorted field paths)
// so identical inputs build byte-identical checkpoints.
function buildProvenanceFieldV2(input) {
  const hasLegacy = input.provenance !== undefined && input.provenance !== null;
  const hasMap = input.provenanceMap !== undefined && input.provenanceMap !== null;
  if (hasLegacy && hasMap) throw new Error('v2-checkpoint-build: provenance and provenanceMap are mutually exclusive (KEEP)');
  if (hasMap) {
    const map = input.provenanceMap;
    if (typeof map !== 'object' || Array.isArray(map)) throw new Error('v2-checkpoint-build: provenanceMap must be an object (KEEP)');
    if (Number(map.schemaVersion) !== 1) throw new Error('v2-checkpoint-build: provenanceMap.schemaVersion must be 1 (KEEP)');
    if (!map.fields || typeof map.fields !== 'object' || Array.isArray(map.fields)) {
      throw new Error('v2-checkpoint-build: provenanceMap.fields is required (KEEP)');
    }
    const fields = {};
    for (const fieldPath of Object.keys(map.fields).sort()) {
      const entry = map.fields[fieldPath];
      if (!entry || typeof entry !== 'object') throw new Error('v2-checkpoint-build: provenance entry is required (KEEP)');
      fields[fieldPath] = {
        schemaVersion: 1,
        sourceKind: String(entry.sourceKind),
        trust: String(entry.trust),
        sourceRefs: Array.isArray(entry.sourceRefs) ? entry.sourceRefs.map(String) : [],
        authorityScope: entry.authorityScope === undefined ? null : entry.authorityScope,
        fieldKind: String(entry.fieldKind),
      };
    }
    return { schemaVersion: 1, fields };
  }
  if (!hasLegacy) return null;
  return {
    sourceNotes: input.provenance.sourceNotes === undefined || input.provenance.sourceNotes === null ? null : String(input.provenance.sourceNotes),
    collectedAtUtc: input.provenance.collectedAtUtc === undefined || input.provenance.collectedAtUtc === null ? null : String(input.provenance.collectedAtUtc),
  };
}

// ---- authoritative builder ----
function asNullableString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text === '' ? null : text;
}

// ---- A05 snapshot slot (embedding only; minting is SnapshotManager's) ----
// A05H H2 production contract (frozen): a snapshot-bound checkpoint can ONLY
// be established from input.snapshotToken, a full ContextSnapshotToken that
// passes ContextSnapshotV2.validateSnapshotToken() and matches the
// checkpoint's taskId/taskInstanceId/sessionId/generation. The raw
// input.snapshot identity-only path ({ snapshotTokenId, revisionDigest })
// was a bypass: it could make a checkpoint appear snapshot-bound without
// proving the identity came from a real SnapshotManager capture, so any
// non-null raw slot now FAILS CLOSED. Legacy pre-A05 checkpoints remain
// constructible by supplying NO token (snapshotToken absent/null AND
// snapshot absent/null or explicit null/null) and stay structurally valid
// but NOT bound (see snapshotModeOf / validateCheckpointSnapshotBinding).
// There is NO internal/test-only raw path: production creation is the only
// creation path.
function buildSnapshotSlotV2(input) {
  const fromToken = input.snapshotToken;
  if (fromToken !== undefined && fromToken !== null) {
    const check = snapshotV2.validateSnapshotToken(fromToken);
    if (!check.valid) throw new Error('v2-checkpoint-build: snapshotToken refused (' + check.reason + ') (KEEP)');
    if (Number(input.generation) !== Number(fromToken.generation)) {
      throw new Error('v2-checkpoint-build: snapshotToken generation must equal checkpoint generation (KEEP)');
    }
    for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
      if (String(input[key]) !== String(fromToken[key])) {
        throw new Error('v2-checkpoint-build: snapshotToken ' + key + ' must equal checkpoint ' + key + ' (KEEP)');
      }
    }
    return { snapshotTokenId: fromToken.snapshotTokenId, revisionDigest: fromToken.revisionDigest };
  }
  const slot = input.snapshot;
  if (slot === undefined || slot === null) return { snapshotTokenId: null, revisionDigest: null };
  if (typeof slot !== 'object') throw new Error('v2-checkpoint-build: snapshot must be an object or null (KEEP)');
  if (slot.snapshotTokenId === null && slot.revisionDigest === null) return { snapshotTokenId: null, revisionDigest: null };
  throw new Error('v2-checkpoint-build: snapshot must be null/null or a real captured token identity via input.snapshotToken (raw snapshot slots are not accepted) (KEEP)');
}

// Returns 'legacy' for pre-A05 null/null checkpoints and 'snapshot-bound'
// for A05 checkpoints. Never reinterprets legacy checkpoints as bound.
function snapshotModeOf(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return 'invalid';
  const snapshot = checkpoint.snapshot;
  if (!snapshot || typeof snapshot !== 'object') return 'invalid';
  if (snapshot.snapshotTokenId === null && snapshot.revisionDigest === null) return 'legacy';
  if (typeof snapshot.snapshotTokenId === 'string' && typeof snapshot.revisionDigest === 'string') return 'snapshot-bound';
  return 'invalid';
}

function buildCheckpointV2(input) {
  if (!input || typeof input !== 'object') throw new Error('v2-checkpoint-build: input is required (KEEP)');
  const fail = (message) => { throw new Error('v2-checkpoint-build: ' + message + ' (KEEP)'); };
  for (const key of ['taskId', 'taskInstanceId', 'sessionId', 'workspaceId']) {
    if (typeof input[key] !== 'string' || input[key] === '') fail(key + ' is required');
  }
  if (!Number.isInteger(input.generation) || input.generation < 1) fail('generation must be a positive integer');
  if (input.kind !== undefined && input.kind !== null && !CHECKPOINT_KINDS.includes(input.kind)) fail('kind must be active|complete');
  if (!Number.isInteger(input.safePointBoundarySeq) || input.safePointBoundarySeq < 0) fail('safePointBoundarySeq must be a non-negative integer');
  if (typeof input.createdAtUtc !== 'string' || !isIsoUtc(input.createdAtUtc)) fail('createdAtUtc must be explicit ISO-8601 UTC input');
  if (!input.objective || typeof input.objective.text !== 'string' || input.objective.text === '') fail('objective.text is required');
  if (typeof input.objective.status !== 'string' || input.objective.status === '') fail('objective.status is required');
  if (!input.progress || typeof input.progress.taskStatus !== 'string' || input.progress.taskStatus === '') fail('progress.taskStatus is required');
  if (!input.repository || typeof input.repository !== 'object') fail('repository state is required');
  if (!input.verification || !Array.isArray(input.verification.outcomes)) fail('verification.outcomes is required');
  if (!input.continuation || !Array.isArray(input.continuation.unresolvedQuestions)) fail('continuation.unresolvedQuestions is required');
  if (!input.failures || !Array.isArray(input.failures.activeFailures) || !Array.isArray(input.failures.rejectedHypotheses)) fail('failures state is required');
  for (const listKey of ['requirements', 'constraints', 'decisions', 'evidenceRefs']) {
    if (input[listKey] !== undefined && input[listKey] !== null && !Array.isArray(input[listKey])) fail(listKey + ' must be an array (never inferred from prose)');
  }

  // kind=complete requires controller-derived completion: the grounded
  // progress.taskStatus must itself state completion. The builder never
  // upgrades a non-complete taskStatus into kind=complete.
  const kind = input.kind || 'active';
  if (kind === 'complete' && String(input.progress.taskStatus).toLowerCase() !== 'complete') {
    fail('kind=complete requires grounded progress.taskStatus=complete');
  }

  // Parent lineage is explicit builder input (audit/history only).
  let parentCheckpointId = null;
  if (input.parentCheckpoint !== null && input.parentCheckpoint !== undefined) {
    const parent = input.parentCheckpoint;
    if (!parent || typeof parent !== 'object' || typeof parent.checkpointId !== 'string') fail('parentCheckpoint must be a finalized V2 checkpoint');
    if (parent.generation !== input.generation - 1) fail('parent generation must be exactly generation-1');
    parentCheckpointId = parent.checkpointId;
  } else if (input.parentCheckpointId !== null && input.parentCheckpointId !== undefined) {
    parentCheckpointId = String(input.parentCheckpointId);
  }
  if (input.generation === 1 && parentCheckpointId !== null) fail('first generation must carry parentCheckpointId=null');
  if (input.generation > 1 && (parentCheckpointId === null || parentCheckpointId === '')) fail('generation>1 requires a parent checkpoint id');

  // Changed-file bounding: never represent a truncated list as complete.
  const rawChangedFiles = Array.isArray(input.repository.changedFiles) ? input.repository.changedFiles.map(String) : [];
  const declaredCount = input.repository.changedFileCount !== undefined && input.repository.changedFileCount !== null
    ? Number(input.repository.changedFileCount)
    : rawChangedFiles.length;
  if (!Number.isInteger(declaredCount) || declaredCount < 0) fail('repository.changedFileCount must be a non-negative integer');
  if (declaredCount < rawChangedFiles.length) fail('repository.changedFileCount must cover every listed file');
  let changedFiles = rawChangedFiles.slice();
  let truncated = false;
  if (changedFiles.length > BOUNDS.repositoryChangedFilesMax) {
    changedFiles = changedFiles.slice(0, BOUNDS.repositoryChangedFilesMax);
    truncated = true;
  }
  if (declaredCount > changedFiles.length) truncated = true;

  // Candidate schema (identity fields attached after digest).
  const candidate = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION_V2,
    generation: input.generation,
    parentCheckpointId,
    kind,
    taskId: String(input.taskId),
    taskInstanceId: String(input.taskInstanceId),
    sessionId: String(input.sessionId),
    workspaceId: String(input.workspaceId),
    repositoryId: asNullableString(input.repositoryId !== undefined ? input.repositoryId : input.repository.repositoryId),
    checkoutId: asNullableString(input.checkoutId !== undefined ? input.checkoutId : input.repository.checkoutId),
    safePointBoundarySeq: input.safePointBoundarySeq,
    safePointStepId: asNullableString(input.safePointStepId),
    createdAtUtc: String(input.createdAtUtc),
    objective: { text: String(input.objective.text), status: String(input.objective.status) },
    requirements: (Array.isArray(input.requirements) ? input.requirements : []).map((req) => ({
      id: String(req.id),
      text: String(req.text),
      status: String(req.status),
      evidenceRefs: Array.isArray(req.evidenceRefs) ? req.evidenceRefs.map(String) : [],
    })),
    constraints: (Array.isArray(input.constraints) ? input.constraints : []).map((constraint) => ({
      type: String(constraint.type),
      text: String(constraint.text),
    })),
    progress: {
      taskStatus: String(input.progress.taskStatus),
      completedMilestones: Array.isArray(input.progress.completedMilestones) ? input.progress.completedMilestones.map(String) : [],
      currentMilestone: input.progress.currentMilestone === undefined || input.progress.currentMilestone === null ? null : String(input.progress.currentMilestone),
      remainingMilestones: Array.isArray(input.progress.remainingMilestones) ? input.progress.remainingMilestones.map(String) : [],
    },
    decisions: (Array.isArray(input.decisions) ? input.decisions : []).map((decision) => ({
      id: String(decision.id),
      statement: String(decision.statement),
      authority: String(decision.authority),
      status: String(decision.status),
      evidenceRefs: Array.isArray(decision.evidenceRefs) ? decision.evidenceRefs.map(String) : [],
    })),
    repository: {
      repositoryId: asNullableString(input.repository.repositoryId),
      checkoutId: asNullableString(input.repository.checkoutId),
      headCommit: asNullableString(input.repository.headCommit),
      baseCommit: asNullableString(input.repository.baseCommit),
      cleanWorktree: input.repository.cleanWorktree === null || input.repository.cleanWorktree === undefined ? null : Boolean(input.repository.cleanWorktree),
      changedFiles,
      changedFileCount: declaredCount,
      changedFilesTruncated: truncated,
      stagedSummary: asNullableString(input.repository.stagedSummary),
      unstagedSummary: asNullableString(input.repository.unstagedSummary),
    },
    evidenceRefs: (Array.isArray(input.evidenceRefs) ? input.evidenceRefs : []).map((ref) => ({
      schemaVersion: 1,
      evidenceId: String(ref.evidenceId),
      kind: String(ref.kind),
      locator: String(ref.locator),
      digest: ref.digest === undefined ? null : ref.digest,
      observedAtUtc: String(ref.observedAtUtc),
      taskInstanceId: String(ref.taskInstanceId || input.taskInstanceId),
    })),
    failures: {
      activeFailures: (input.failures.activeFailures || []).map((failure) => ({
        id: String(failure.id),
        status: String(failure.status),
        detail: failure.detail === undefined || failure.detail === null ? null : String(failure.detail),
        attemptCount: failure.attemptCount === undefined || failure.attemptCount === null ? null : Number(failure.attemptCount),
        evidenceRefs: Array.isArray(failure.evidenceRefs) ? failure.evidenceRefs.map(String) : [],
      })),
      rejectedHypotheses: (input.failures.rejectedHypotheses || []).map(String),
      retryState: input.failures.retryState === undefined || input.failures.retryState === null ? null : {
        attemptCount: input.failures.retryState.attemptCount === undefined ? null : Number(input.failures.retryState.attemptCount),
        nextRetryAtUtc: input.failures.retryState.nextRetryAtUtc === undefined ? null : input.failures.retryState.nextRetryAtUtc,
        note: input.failures.retryState.note === undefined || input.failures.retryState.note === null ? null : String(input.failures.retryState.note),
      },
    },
    verification: {
      outcomes: (input.verification.outcomes || []).map((outcome) => ({
        scope: String(outcome.scope),
        status: String(outcome.status),
        detail: outcome.detail === undefined || outcome.detail === null ? null : String(outcome.detail),
        evidenceRefs: Array.isArray(outcome.evidenceRefs) ? outcome.evidenceRefs.map(String) : [],
      })),
      note: input.verification.note === undefined || input.verification.note === null ? null : String(input.verification.note),
    },
    continuation: {
      nextAction: input.continuation.nextAction === undefined || input.continuation.nextAction === null ? null : String(input.continuation.nextAction),
      unresolvedQuestions: (input.continuation.unresolvedQuestions || []).map(String),
      recentUserIntent: input.continuation.recentUserIntent === undefined || input.continuation.recentUserIntent === null ? null : String(input.continuation.recentUserIntent),
    },
    // A05: snapshot identity embedded verbatim from a real SnapshotManager
    // capture when input.snapshot / input.snapshotToken is supplied;
    // legacy null/null when absent (pre-A05 fixtures stay constructible).
    // The builder NEVER mints token identity: it only embeds what the
    // caller captured via SnapshotManager.capture.
    snapshot: buildSnapshotSlotV2(input),
    provenance: buildProvenanceFieldV2(input),

    pressure: input.pressure === undefined || input.pressure === null ? null : {
      preCheckpointEffectiveInputTokens: input.pressure.preCheckpointEffectiveInputTokens === undefined ? null : input.pressure.preCheckpointEffectiveInputTokens,
      peakEffectiveInputTokens: input.pressure.peakEffectiveInputTokens === undefined ? null : input.pressure.peakEffectiveInputTokens,
    },
  };

  // Redaction BEFORE validation/persistence (deterministic, no LLM).
  const redacted = redactCheckpointValueV2(candidate, BOUNDS.redactMaxChars);

  // Deterministic identity over the redacted payload bytes.
  const contentDigest = deriveCheckpointContentDigest(redacted);
  const checkpointId = deriveCheckpointIdV2(
    redacted.taskId, redacted.taskInstanceId, redacted.sessionId, redacted.generation, contentDigest,
  );
  const finalized = Object.assign({}, redacted, { checkpointContentDigest: contentDigest, checkpointId });

  // Closed-world validation, then the hard UTF-8 size bound. Mandatory
  // state that exceeds the bound FAILS CLOSED (never silently truncated:
  // truncation applies only to changed-file lists with an explicit marker).
  const check = validateCheckpointV2(finalized);
  if (!check.valid) fail('candidate rejected (' + check.reason + ')');
  const serialized = serializeCheckpointCanonical(finalized);
  const sizeBytes = byteLengthUtf8(serialized);
  if (sizeBytes > CHECKPOINT_MAX_BYTES) fail('serialized size ' + sizeBytes + ' exceeds the 64 KiB bound');
  return { checkpoint: Object.freeze(finalized), serialized, sizeBytes, checkpointId, contentDigest };
}

// ---- persistence (one file per generation, atomic, no overwrite) ----
function checkpointV2FileName(generation) {
  if (!Number.isInteger(generation) || generation < 1) throw new Error('v2-checkpoint-path: generation must be a positive integer');
  return CHECKPOINT_FILE_PREFIX + String(generation).padStart(6, '0') + '.json';
}

function checkpointV2FilePath(dir, generation) {
  if (typeof dir !== 'string' || dir === '') throw new Error('v2-checkpoint-path: dir is required');
  return path.join(dir, checkpointV2FileName(generation));
}

// A05H H6 durability scope (frozen): atomic (temp file + rename) +
// read-back validated + process-crash recoverable under the
// filesystem/OS contract; NOT claimed power-loss durable (no fsync). The
// authoritative session durability barrier is DSH SessionStore.flush().
function persistCheckpointV2(dir, built) {
  if (typeof dir !== 'string' || dir === '') throw new Error('v2-checkpoint-persist: dir is required (KEEP)');
  if (!built || typeof built !== 'object' || !built.checkpoint || typeof built.serialized !== 'string') {
    throw new Error('v2-checkpoint-persist: build output is required (KEEP)');
  }
  fs.mkdirSync(dir, { recursive: true });
  const target = checkpointV2FilePath(dir, built.checkpoint.generation);
  if (fs.existsSync(target)) {
    const prior = fs.readFileSync(target, 'utf8');
    if (prior === built.serialized) return readCheckpointV2(dir, built.checkpoint.generation);
    throw new Error('v2-checkpoint-persist: refusing to overwrite another generation payload (KEEP)');
  }
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, Buffer.from(built.serialized, 'utf8'));
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw new Error('v2-checkpoint-persist: atomic rename failed (KEEP)');
  }
  return readCheckpointV2(dir, built.checkpoint.generation);
}

function readCheckpointV2(dir, generation) {
  const target = checkpointV2FilePath(dir, generation);
  if (!fs.existsSync(target)) return null;
  const rawText = fs.readFileSync(target, 'utf8');
  const loadedBytes = byteLengthUtf8(rawText);
  if (loadedBytes > CHECKPOINT_MAX_BYTES) throw new Error('v2-checkpoint-read: checkpoint exceeds the 64 KiB bound (BLOCK/KEEP)');
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('v2-checkpoint-read: checkpoint is malformed (BLOCK/KEEP)');
  }
  const check = validateCheckpointV2(parsed);
  if (!check.valid) throw new Error('v2-checkpoint-read: checkpoint invalid (' + check.reason + ') (BLOCK/KEEP)');
  if (Number(parsed.generation) !== Number(generation)) {
    throw new Error('v2-checkpoint-read: generation isolation violated (BLOCK/KEEP)');
  }
  // Read-back byte identity: the persisted bytes must already be the
  // canonical form (no drift, no in-place edits, no reformatting).
  if (serializeCheckpointCanonical(parsed) !== rawText) {
    throw new Error('v2-checkpoint-read: persisted bytes fail read-back identity (BLOCK/KEEP)');
  }
  return { checkpoint: parsed, serialized: rawText, sizeBytes: loadedBytes };
}

// ---- A02 operation binding (real checkpoint identity, fail closed) ----
// The projected payload IS the canonical serialized checkpoint, which carries
// its own id + digest. Byte identity therefore cannot be a raw hash of the
// text (the digest lives inside the bytes). Instead the projected bytes are
// parsed and closed-world validated: validation recomputes the digest over
// the canonical payload section and re-derives the id, so only byte-identical
// content passes. Mismatch on any leg BLOCKS mutation.
function assertOperationBindsCheckpointV2(operation, checkpoint, payloadText) {
  const block = (reason) => ({ ok: false, reason });
  if (!operation || typeof operation !== 'object') return block('operation-missing');
  if (!checkpoint || typeof checkpoint !== 'object') return block('checkpoint-missing');
  if (typeof payloadText !== 'string' || payloadText === '') return block('payload-unproven');
  if (operation.checkpointId !== checkpoint.checkpointId) return block('checkpoint-identity-mismatch');
  if (Number(operation.checkpointGeneration) !== Number(checkpoint.generation)) return block('checkpoint-generation-mismatch');
  if (operation.checkpointContentDigest !== checkpoint.checkpointContentDigest) return block('checkpoint-digest-mismatch');
  let projected = null;
  try {
    projected = JSON.parse(payloadText);
  } catch {
    return block('checkpoint-digest-mismatch');
  }
  if (!projected || typeof projected !== 'object') return block('checkpoint-digest-mismatch');
  if (projected.checkpointId !== checkpoint.checkpointId) return block('checkpoint-identity-mismatch');
  if (projected.checkpointContentDigest !== checkpoint.checkpointContentDigest) return block('checkpoint-digest-mismatch');
  const check = validateCheckpointV2(projected);
  if (!check.valid) return block(check.reason === 'checkpoint-content-digest-mismatch' || check.reason === 'checkpoint-id-mismatch' ? check.reason : 'checkpoint-digest-mismatch');
  // Exact byte identity: even semantically-null drift (trailing whitespace,
  // reordered keys) is refused. The projected bytes must BE the canonical
  // finalized bytes, not merely parse to the same value.
  if (payloadText !== serializeCheckpointCanonical(checkpoint)) return block('checkpoint-digest-mismatch');
  return { ok: true, reason: null };
}

module.exports = {
  CHECKPOINT_SCHEMA_VERSION_V2,
  CHECKPOINT_ID_DOMAIN_V2,
  CHECKPOINT_MAX_BYTES,
  BOUNDS,
  REQUIREMENT_STATUSES,
  DECISION_AUTHORITIES,
  DECISION_STATUSES,
  VERIFICATION_STATUSES,
  CHECKPOINT_KINDS,
  EVIDENCE_KINDS,
  CHECKPOINT_TOP_EXACT_KEYS,
  CHECKPOINT_OBJECTIVE_EXACT_KEYS,
  CHECKPOINT_REQUIREMENT_EXACT_KEYS,
  CHECKPOINT_CONSTRAINT_EXACT_KEYS,
  CHECKPOINT_PROGRESS_EXACT_KEYS,
  CHECKPOINT_DECISION_EXACT_KEYS,
  CHECKPOINT_REPOSITORY_EXACT_KEYS,
  CHECKPOINT_EVIDENCE_REF_EXACT_KEYS,
  CHECKPOINT_FAILURES_EXACT_KEYS,
  CHECKPOINT_ACTIVE_FAILURE_EXACT_KEYS,
  CHECKPOINT_RETRY_STATE_EXACT_KEYS,
  CHECKPOINT_VERIFICATION_EXACT_KEYS,
  CHECKPOINT_VERIFICATION_OUTCOME_EXACT_KEYS,
  CHECKPOINT_CONTINUATION_EXACT_KEYS,
  CHECKPOINT_SNAPSHOT_SLOT_EXACT_KEYS,
  CHECKPOINT_PRESSURE_EXACT_KEYS,
  CHECKPOINT_PROVENANCE_MAP_EXACT_KEYS,
  CHECKPOINT_PROVENANCE_LEGACY_EXACT_KEYS,
  CHECKPOINT_PROVENANCE_ENTRY_EXACT_KEYS,
  CHECKPOINT_SEAL_EXACT_KEYS,
  sha256HexUtf8,
  byteLengthUtf8,
  redactCheckpointTextV2,
  redactCheckpointValueV2,
  canonicalize,
  serializeCheckpointCanonical,
  deriveCheckpointContentDigest,
  deriveCheckpointIdV2,
  validateCheckpointV2,
  buildCheckpointV2,
  buildSnapshotSlotV2,
  snapshotModeOf,
  checkpointV2FileName,
  checkpointV2FilePath,
  persistCheckpointV2,
  readCheckpointV2,
  assertOperationBindsCheckpointV2,
};
