'use strict';
/**
 * ContextSnapshotV2.cjs - CCV2-A05 ContextSnapshotToken + SnapshotManager production authority.
 *
 * ONE authority for V2 snapshot identity: schema, capture, normalization,
 * revisionDigest, snapshotTokenId, structural validation, persistence, and
 * revalidation against current authoritative state. V1 behavior is UNCHANGED
 * (this module never reads V1 artifacts).
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (A05 sections). A05 answers ONE question and NOTHING else:
 *
 *   "Is this still the same authoritative state the checkpoint was built from?"
 *
 * It does NOT answer "is this moment safe to checkpoint" (A06), "may this
 * binding be compacted at all" (A07), or anything about pressure/retention/
 * triggering/production compaction (A08-A10).
 *
 * Core invariant (frozen): a sealed checkpoint may be structurally valid,
 * authentic, and untampered while still being STALE. Freshness comes ONLY
 * from SnapshotManager.revalidate(token, currentState); the checkpoint
 * itself proves "I was built from snapshot X", never "X is still current".
 *
 * Ownership (frozen): CheckpointBuilder consumes snapshot identity (it
 * embeds the token's snapshotTokenId/revisionDigest verbatim and never
 * mints them). TransactionalApply consumes revalidate() verbatim at the
 * final pre-mutation gate and never redefines freshness. Only
 * SnapshotManager mints, derives, or compares snapshot identity.
 *
 * Grounded revision primitives (no fabrication):
 *   - sessionRevision : integer captureSeq = highest durable session event
 *     seq observed at capture (0 when the session log is empty). Sessions
 *     are append-only, so any intervening session mutation strictly
 *     increases the seq: revert-to-identical is IMPOSSIBLE for session
 *     state, and any intervening append stays STALE forever (monotonic).
 *   - taskRevision    : sha256 hex over the canonical normalized task-state
 *     body (objective/requirements/constraints/progress/decisions/failures/
 *     verification/continuation) via deriveTaskRevision(). State-based: an
 *     exact revert to the same task state yields VALID again.
 *   - repositoryRevision : { headCommit, indexDigest, worktreeDigest }.
 *     HEAD alone is NOT freshness: staged (index) and unstaged (worktree)
 *     states are fingerprinted separately as bounded digests. Null digests
 *     mean "unobserved for this binding", compared null-safely.
 *   - runtimeRevision : grounded on the A01/A02 host-owned current runtime
 *     snapshot seq (currentRuntimeSnapshotSeqOf). seq null <=> no live host
 *     snapshot. runtimeSnapshotId ("rss_<seq>") and runtimeSnapshotDigest
 *     (domain-separated hash of the id) are DERIVED, never free text.
 *
 * Frozen formulas (canonical; PS twins in scripts/ContextLifecycle.ps1):
 *
 *   revisionBody   = { taskId, taskInstanceId, sessionId, workspaceId,
 *                      repositoryId, checkoutId,
 *                      safePointBoundarySeq, sessionRevision, taskRevision,
 *                      repositoryRevision:{headCommit,indexDigest,worktreeDigest},
 *                      runtimeRevision:{runtimeSnapshotSeq,runtimeSnapshotId,
 *                                      runtimeSnapshotDigest} }
 *                    (excludes snapshotTokenId, revisionDigest, capturedAtUtc
 *                    AND generation: revisionDigest is pure authoritative-
 *                    state identity, so byte-identical state in another
 *                    generation yields the SAME revisionDigest while
 *                    snapshotTokenId stays generation-bound via its own
 *                    formula. Revalidation still compares generation
 *                    explicitly: a token never validates another generation.)
 *   revisionDigest = sha256Hex(UTF-8('nexus/context-snapshot-revision/v1'
 *                      LF canonicalJson(revisionBody)))
 *   snapshotTokenId = 'cst_' + sha256Hex(UTF-8(
 *                      'nexus/context-snapshot-token/v1' LF taskId LF
 *                      taskInstanceId LF sessionId LF generation LF
 *                      revisionDigest)).slice(0, 32)
 *
 * capturedAtUtc is AUDIT metadata only: it never enters revisionBody, so
 * two captures of the same authoritative state yield the same
 * revisionDigest/snapshotTokenId even with different timestamps.
 *
 * Capture consistency (frozen): capture() is pure over one caller-supplied
 * state object. captureConsistent(readStateFn, ...) guards against mixed
 * revisions by reading before/after and failing closed when the
 * revision-relevant projection moved during capture (retry or BLOCK per
 * caller policy; never accept a mixed token).
 *
 * Persistence design: the checkpoint/operation embed ONLY the token ids
 * (snapshot.snapshotTokenId/revisionDigest, operation.snapshotTokenId).
 * Those ids are insufficient to revalidate after restart (HEAD/digests/
 * revisions are not reconstructible from the checkpoint alone), so the
 * FULL token persists as one immutable atomic file per token id
 * (snapshot-<tokenId>.json): no overwrite with different bytes,
 * read-back validated, generation-scoped by the bound generation inside.
 * Embedded-only persistence is therefore NOT sufficient; this module owns
 * the token files.
 *
 * Determinism: no clock reads. capturedAtUtc is an explicit caller input;
 * identical state + identical audit timestamp rebuild byte-identical tokens.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_SCHEMA_VERSION = 1;
const REVISION_DIGEST_DOMAIN_V1 = 'nexus/context-snapshot-revision/v1';
const SNAPSHOT_TOKEN_ID_DOMAIN_V1 = 'nexus/context-snapshot-token/v1';
const RUNTIME_DIGEST_DOMAIN_V1 = 'nexus/context-snapshot-runtime/v1';
const TASK_REVISION_DOMAIN_V1 = 'nexus/context-snapshot-task-revision/v1';
const SNAPSHOT_MAX_BYTES = 8192; // 8 KiB: tokens carry digests/identity, never raw content.
const SNAPSHOT_FILE_PREFIX = 'snapshot-';

const SNAPSHOT_BOUNDS = Object.freeze({
  taskId: 256,
  taskInstanceId: 256,
  sessionId: 256,
  workspaceId: 512,
  repositoryId: 256,
  checkoutId: 256,
  headCommit: 256,
  digestHex: 64,
  runtimeSnapshotId: 128,
  tokenId: 68, // 'cst_' + 32 hex + spare bound
  serializedBytes: SNAPSHOT_MAX_BYTES,
});

const TOKEN_ID_PATTERN = /^cst_[0-9a-f]{32}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function sha256HexUtf8(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function byteLengthUtf8(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

function isIsoUtc(value) {
  if (typeof value !== 'string' || value === '') return false;
  return Number.isFinite(Date.parse(value));
}

function isBoundedString(value, max, allowEmpty) {
  if (typeof value !== 'string') return false;
  if (!allowEmpty && value === '') return false;
  return value.length <= max;
}

// Deterministic canonical serialization (same contract as the A03
// canonicalizer: plain objects with lexicographically sorted keys,
// recursive; arrays keep author order; no whitespace).
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function serializeCanonical(value) {
  return JSON.stringify(canonicalize(value));
}

function asNullableString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text === '' ? null : text;
}

// ---- grounded task-revision derivation ----
// The ONE authoritative way to turn task state into the taskRevision
// digest. Callers supply the grounded task-state body; this function owns
// the digest. Any requirement/constraint/decision/milestone/status change
// alters the canonical body and therefore the digest.
const TASK_REVISION_FIELDS = Object.freeze([
  'objective', 'requirements', 'constraints', 'progress',
  'decisions', 'failures', 'verification', 'continuation',
]);

function taskRevisionBodyOf(taskState) {
  if (!taskState || typeof taskState !== 'object') {
    throw new Error('v2-snapshot-task-revision: taskState is required (KEEP)');
  }
  const body = {};
  for (const field of TASK_REVISION_FIELDS) {
    body[field] = taskState[field] === undefined ? null : taskState[field];
  }
  return body;
}

function deriveTaskRevision(taskState) {
  const body = taskRevisionBodyOf(taskState);
  return sha256HexUtf8(TASK_REVISION_DOMAIN_V1 + '\n' + serializeCanonical(body));
}

// ---- grounded runtime-snapshot derivation ----
// Binds the A01/A02 host-owned current runtime snapshot seq. The id and
// digest are DERIVED from the seq, never caller-chosen.
function deriveRuntimeSnapshotId(seq) {
  if (seq === null || seq === undefined) return null;
  if (!Number.isInteger(seq) || seq < 0) throw new Error('v2-snapshot-runtime: runtimeSnapshotSeq must be a non-negative integer or null (KEEP)');
  return 'rss_' + String(seq);
}

function deriveRuntimeSnapshotDigest(runtimeSnapshotId) {
  if (runtimeSnapshotId === null || runtimeSnapshotId === undefined) return null;
  return sha256HexUtf8(RUNTIME_DIGEST_DOMAIN_V1 + '\n' + String(runtimeSnapshotId));
}

function normalizeRuntimeRevision(input) {
  const raw = input === undefined || input === null ? null : input;
  if (raw === null) return { runtimeSnapshotSeq: null, runtimeSnapshotId: null, runtimeSnapshotDigest: null };
  if (typeof raw !== 'object') throw new Error('v2-snapshot-capture: runtimeRevision must be an object or null (KEEP)');
  const seq = raw.runtimeSnapshotSeq === undefined || raw.runtimeSnapshotSeq === null ? null : raw.runtimeSnapshotSeq;
  if (seq !== null && (!Number.isInteger(seq) || seq < 0)) {
    throw new Error('v2-snapshot-capture: runtimeSnapshotSeq must be a non-negative integer or null (KEEP)');
  }
  const expectedId = deriveRuntimeSnapshotId(seq);
  const expectedDigest = deriveRuntimeSnapshotDigest(expectedId);
  if (raw.runtimeSnapshotId !== undefined && raw.runtimeSnapshotId !== null && raw.runtimeSnapshotId !== expectedId) {
    throw new Error('v2-snapshot-capture: runtimeSnapshotId must be derived (' + String(expectedId) + ') (KEEP)');
  }
  if (raw.runtimeSnapshotDigest !== undefined && raw.runtimeSnapshotDigest !== null && raw.runtimeSnapshotDigest !== expectedDigest) {
    throw new Error('v2-snapshot-capture: runtimeSnapshotDigest must be derived (KEEP)');
  }
  if (expectedId !== null && !isBoundedString(expectedId, SNAPSHOT_BOUNDS.runtimeSnapshotId, false)) {
    throw new Error('v2-snapshot-capture: runtimeSnapshotId exceeds the bound (KEEP)');
  }
  return { runtimeSnapshotSeq: seq, runtimeSnapshotId: expectedId, runtimeSnapshotDigest: expectedDigest };
}

function normalizeRepositoryRevision(input) {
  const raw = input === undefined || input === null ? {} : input;
  if (typeof raw !== 'object') throw new Error('v2-snapshot-capture: repositoryRevision must be an object (KEEP)');
  const headCommit = asNullableString(raw.headCommit);
  const indexDigest = asNullableString(raw.indexDigest);
  const worktreeDigest = asNullableString(raw.worktreeDigest);
  if (headCommit !== null && !isBoundedString(headCommit, SNAPSHOT_BOUNDS.headCommit, true)) {
    throw new Error('v2-snapshot-capture: headCommit exceeds the bound (KEEP)');
  }
  for (const [name, digest] of [['indexDigest', indexDigest], ['worktreeDigest', worktreeDigest]]) {
    if (digest !== null && !DIGEST_PATTERN.test(digest)) {
      throw new Error('v2-snapshot-capture: ' + name + ' must be sha256 hex or null (KEEP)');
    }
  }
  return { headCommit, indexDigest, worktreeDigest };
}

// ---- revision body / digests / token id (frozen formulas) ----
function revisionBodyOf(normalized) {
  // NOTE: generation is INTENTIONALLY excluded: revisionDigest is pure
  // authoritative-state identity (same state in another generation yields
  // the same digest); generation binding lives in snapshotTokenId and in
  // the explicit generation comparison inside revalidate().
  return {
    taskId: normalized.taskId,
    taskInstanceId: normalized.taskInstanceId,
    sessionId: normalized.sessionId,
    workspaceId: normalized.workspaceId,
    repositoryId: normalized.repositoryId,
    checkoutId: normalized.checkoutId,
    safePointBoundarySeq: normalized.safePointBoundarySeq,
    sessionRevision: normalized.sessionRevision,
    taskRevision: normalized.taskRevision,
    repositoryRevision: {
      headCommit: normalized.repositoryRevision.headCommit,
      indexDigest: normalized.repositoryRevision.indexDigest,
      worktreeDigest: normalized.repositoryRevision.worktreeDigest,
    },
    runtimeRevision: {
      runtimeSnapshotSeq: normalized.runtimeRevision.runtimeSnapshotSeq,
      runtimeSnapshotId: normalized.runtimeRevision.runtimeSnapshotId,
      runtimeSnapshotDigest: normalized.runtimeRevision.runtimeSnapshotDigest,
    },
  };
}

function deriveRevisionDigest(revisionBody) {
  return sha256HexUtf8(REVISION_DIGEST_DOMAIN_V1 + '\n' + serializeCanonical(revisionBody));
}

function deriveSnapshotTokenId(taskId, taskInstanceId, sessionId, generation, revisionDigest) {
  if (typeof taskId !== 'string' || taskId === '') throw new Error('v2-snapshot-id: taskId is required');
  if (typeof taskInstanceId !== 'string' || taskInstanceId === '') throw new Error('v2-snapshot-id: taskInstanceId is required');
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('v2-snapshot-id: sessionId is required');
  if (!Number.isInteger(generation) || generation < 1) throw new Error('v2-snapshot-id: generation must be a positive integer');
  if (typeof revisionDigest !== 'string' || !DIGEST_PATTERN.test(revisionDigest)) {
    throw new Error('v2-snapshot-id: revisionDigest must be sha256 hex');
  }
  const joined = [SNAPSHOT_TOKEN_ID_DOMAIN_V1, taskId, taskInstanceId, sessionId, String(generation), revisionDigest].join('\n');
  return 'cst_' + sha256HexUtf8(joined).slice(0, 32);
}

// Normalizes one caller-supplied authoritative state observation into the
// frozen revision shape. Pure: never reads clocks, sessions, or the repo.
function normalizeSnapshotState(input) {
  if (!input || typeof input !== 'object') throw new Error('v2-snapshot-capture: state is required (KEEP)');
  const fail = (message) => { throw new Error('v2-snapshot-capture: ' + message + ' (KEEP)'); };
  if (!isBoundedString(input.taskId, SNAPSHOT_BOUNDS.taskId, false)) fail('taskId is required (bounded string)');
  if (!isBoundedString(input.taskInstanceId, SNAPSHOT_BOUNDS.taskInstanceId, false)) fail('taskInstanceId is required (bounded string)');
  if (!isBoundedString(input.sessionId, SNAPSHOT_BOUNDS.sessionId, false)) fail('sessionId is required (bounded string)');
  if (!isBoundedString(input.workspaceId, SNAPSHOT_BOUNDS.workspaceId, false)) fail('workspaceId is required (bounded string)');
  const repositoryId = asNullableString(input.repositoryId);
  const checkoutId = asNullableString(input.checkoutId);
  if (repositoryId !== null && !isBoundedString(repositoryId, SNAPSHOT_BOUNDS.repositoryId, true)) fail('repositoryId exceeds the bound');
  if (checkoutId !== null && !isBoundedString(checkoutId, SNAPSHOT_BOUNDS.checkoutId, true)) fail('checkoutId exceeds the bound');
  if (!Number.isInteger(input.generation) || input.generation < 1) fail('generation must be a positive integer');
  if (!Number.isInteger(input.safePointBoundarySeq) || input.safePointBoundarySeq < 0) fail('safePointBoundarySeq must be a non-negative integer');
  if (!Number.isInteger(input.sessionRevision) || input.sessionRevision < 0) fail('sessionRevision must be a non-negative integer captureSeq');
  if (typeof input.taskRevision !== 'string' || !DIGEST_PATTERN.test(input.taskRevision)) fail('taskRevision must be sha256 hex (use deriveTaskRevision)');
  const repositoryRevision = normalizeRepositoryRevision(input.repositoryRevision);
  const runtimeRevision = normalizeRuntimeRevision(input.runtimeRevision === undefined ? null : input.runtimeRevision);
  return {
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
    repositoryRevision,
    runtimeRevision,
  };
}

// Authoritative capture: state -> ContextSnapshotToken. Snapshot capture
// MUST occur before checkpoint finalization; the checkpoint embeds the
// returned snapshotTokenId/revisionDigest verbatim.
function capture(stateInput, capturedAtUtc) {
  if (typeof capturedAtUtc !== 'string' || !isIsoUtc(capturedAtUtc)) {
    throw new Error('v2-snapshot-capture: capturedAtUtc must be explicit ISO-8601 UTC input (KEEP)');
  }
  const normalized = normalizeSnapshotState(stateInput);
  const body = revisionBodyOf(normalized);
  const revisionDigest = deriveRevisionDigest(body);
  const snapshotTokenId = deriveSnapshotTokenId(
    normalized.taskId, normalized.taskInstanceId, normalized.sessionId,
    normalized.generation, revisionDigest,
  );
  const token = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotTokenId,
    revisionDigest,
    taskId: normalized.taskId,
    taskInstanceId: normalized.taskInstanceId,
    sessionId: normalized.sessionId,
    workspaceId: normalized.workspaceId,
    repositoryId: normalized.repositoryId,
    checkoutId: normalized.checkoutId,
    generation: normalized.generation,
    safePointBoundarySeq: normalized.safePointBoundarySeq,
    sessionRevision: normalized.sessionRevision,
    taskRevision: normalized.taskRevision,
    repositoryRevision: normalized.repositoryRevision,
    runtimeRevision: normalized.runtimeRevision,
    capturedAtUtc: String(capturedAtUtc),
  };
  const check = validateSnapshotToken(token);
  if (!check.valid) throw new Error('v2-snapshot-capture: candidate rejected (' + check.reason + ') (KEEP)');
  const serialized = serializeSnapshotTokenCanonical(token);
  if (byteLengthUtf8(serialized) > SNAPSHOT_MAX_BYTES) {
    throw new Error('v2-snapshot-capture: serialized token exceeds the bound (KEEP)');
  }
  return Object.freeze(token);
}

function serializeSnapshotTokenCanonical(token) {
  return serializeCanonical(token);
}

// Revision-relevant projection used by captureConsistent(): the exact
// subset of a state observation that enters revision identity. Two
// observations with equal projections MUST yield equal revisionDigests.
function revisionProjectionOf(stateInput) {
  const normalized = normalizeSnapshotState(stateInput);
  return serializeCanonical(revisionBodyOf(normalized));
}

// Capture-consistency guard (frozen): read revision_before, capture all
// components, read revision_after, accept only if the revision projection
// is identical across both reads. A token assembled from mixed revisions
// MUST never be accepted: with maxAttempts=1 (default) this FAILS CLOSED
// with snapshot-capture-inconsistent; callers may retry with a higher
// budget while authority is settling.
function captureConsistent(readStateFn, capturedAtUtc, options) {
  if (typeof readStateFn !== 'function') throw new Error('v2-snapshot-capture: readStateFn is required (KEEP)');
  const maxAttempts = options && options.maxAttempts !== undefined ? Number(options.maxAttempts) : 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('v2-snapshot-capture: maxAttempts must be a positive integer (KEEP)');
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = readStateFn();
    const token = capture(before, capturedAtUtc);
    const after = readStateFn();
    if (revisionProjectionOf(before) === revisionProjectionOf(after)) return token;
    lastError = new Error('v2-snapshot-capture: inconsistent observations during capture (snapshot-capture-inconsistent) (BLOCK/KEEP)');
  }
  throw lastError;
}

// ---- closed-world structural validation ----
function validateSnapshotToken(token) {
  const fail = (reason) => ({ valid: false, reason });
  if (!token || typeof token !== 'object') return fail('snapshot-token-missing');
  if (Number(token.schemaVersion) !== SNAPSHOT_SCHEMA_VERSION) return fail('snapshot-token-invalid');
  if (typeof token.snapshotTokenId !== 'string' || !TOKEN_ID_PATTERN.test(token.snapshotTokenId)) return fail('snapshot-token-invalid');
  if (typeof token.revisionDigest !== 'string' || !DIGEST_PATTERN.test(token.revisionDigest)) return fail('snapshot-token-invalid');
  if (!isBoundedString(token.taskId, SNAPSHOT_BOUNDS.taskId, false)) return fail('snapshot-token-invalid');
  if (!isBoundedString(token.taskInstanceId, SNAPSHOT_BOUNDS.taskInstanceId, false)) return fail('snapshot-token-invalid');
  if (!isBoundedString(token.sessionId, SNAPSHOT_BOUNDS.sessionId, false)) return fail('snapshot-token-invalid');
  if (!isBoundedString(token.workspaceId, SNAPSHOT_BOUNDS.workspaceId, false)) return fail('snapshot-token-invalid');
  if (token.repositoryId !== null && !isBoundedString(token.repositoryId, SNAPSHOT_BOUNDS.repositoryId, true)) return fail('snapshot-token-invalid');
  if (token.checkoutId !== null && !isBoundedString(token.checkoutId, SNAPSHOT_BOUNDS.checkoutId, true)) return fail('snapshot-token-invalid');
  if (!Number.isInteger(token.generation) || token.generation < 1) return fail('snapshot-token-invalid');
  if (!Number.isInteger(token.safePointBoundarySeq) || token.safePointBoundarySeq < 0) return fail('snapshot-token-invalid');
  if (!Number.isInteger(token.sessionRevision) || token.sessionRevision < 0) return fail('snapshot-token-invalid');
  if (typeof token.taskRevision !== 'string' || !DIGEST_PATTERN.test(token.taskRevision)) return fail('snapshot-token-invalid');
  const repo = token.repositoryRevision;
  if (!repo || typeof repo !== 'object') return fail('snapshot-token-invalid');
  if (repo.headCommit !== null && !isBoundedString(String(repo.headCommit), SNAPSHOT_BOUNDS.headCommit, true)) return fail('snapshot-token-invalid');
  for (const digest of [repo.indexDigest, repo.worktreeDigest]) {
    if (digest !== null && (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest))) return fail('snapshot-token-invalid');
  }
  const runtime = token.runtimeRevision;
  if (!runtime || typeof runtime !== 'object') return fail('snapshot-token-invalid');
  if (runtime.runtimeSnapshotSeq !== null && (!Number.isInteger(runtime.runtimeSnapshotSeq) || runtime.runtimeSnapshotSeq < 0)) {
    return fail('snapshot-token-invalid');
  }
  const expectedRuntimeId = deriveRuntimeSnapshotId(runtime.runtimeSnapshotSeq);
  const expectedRuntimeDigest = deriveRuntimeSnapshotDigest(expectedRuntimeId);
  if (runtime.runtimeSnapshotId !== expectedRuntimeId) return fail('snapshot-token-invalid');
  if (runtime.runtimeSnapshotDigest !== expectedRuntimeDigest) return fail('snapshot-token-invalid');
  if (!isIsoUtc(token.capturedAtUtc)) return fail('snapshot-token-invalid');
  // Identity legs: recompute the digested identity over the supplied object.
  let normalized = null;
  try {
    normalized = normalizeSnapshotState({
      taskId: token.taskId,
      taskInstanceId: token.taskInstanceId,
      sessionId: token.sessionId,
      workspaceId: token.workspaceId,
      repositoryId: token.repositoryId,
      checkoutId: token.checkoutId,
      generation: token.generation,
      safePointBoundarySeq: token.safePointBoundarySeq,
      sessionRevision: token.sessionRevision,
      taskRevision: token.taskRevision,
      repositoryRevision: token.repositoryRevision,
      runtimeRevision: token.runtimeRevision,
    });
  } catch {
    return fail('snapshot-token-invalid');
  }
  const expectedDigest = deriveRevisionDigest(revisionBodyOf(normalized));
  if (token.revisionDigest !== expectedDigest) return fail('snapshot-revision-digest-mismatch');
  let expectedId = null;
  try {
    expectedId = deriveSnapshotTokenId(token.taskId, token.taskInstanceId, token.sessionId, token.generation, token.revisionDigest);
  } catch {
    return fail('snapshot-token-invalid');
  }
  if (token.snapshotTokenId !== expectedId) return fail('snapshot-token-id-mismatch');
  if (byteLengthUtf8(serializeSnapshotTokenCanonical(token)) > SNAPSHOT_MAX_BYTES) return fail('snapshot-token-invalid');
  // No timestamp freshness: capturedAtUtc is never compared here.
  return { valid: true, reason: null };
}

// ---- authoritative revalidation (TOCTOU gate) ----
// Compares a captured token against CURRENT authoritative state and
// returns VALID or fails closed with a stable reason. Never fuzzy.
// Only grounded, present fields are compared; nullable fields compare
// null-safely (null vs value is a mismatch with the leg's own code).
function revalidate(token, currentState) {
  const fail = (reason) => ({ valid: false, reason });
  if (!token || typeof token !== 'object') return fail('snapshot-token-missing');
  if (!currentState || typeof currentState !== 'object') return fail('snapshot-token-invalid');
  const structural = validateSnapshotToken(token);
  if (!structural.valid) return fail(structural.reason);
  let current = null;
  try {
    current = normalizeSnapshotState(currentState);
  } catch {
    return fail('snapshot-token-invalid');
  }
  if (current.taskId !== token.taskId) return fail('snapshot-task-mismatch');
  if (current.taskInstanceId !== token.taskInstanceId) return fail('snapshot-task-instance-mismatch');
  if (current.sessionId !== token.sessionId) return fail('snapshot-session-mismatch');
  if (current.workspaceId !== token.workspaceId) return fail('snapshot-workspace-mismatch');
  if (current.repositoryId !== token.repositoryId) return fail('snapshot-repository-id-mismatch');
  if (current.checkoutId !== token.checkoutId) return fail('snapshot-checkout-mismatch');
  if (current.generation !== token.generation) return fail('snapshot-generation-mismatch');
  if (current.safePointBoundarySeq !== token.safePointBoundarySeq) return fail('snapshot-boundary-mismatch');
  if (current.taskRevision !== token.taskRevision) return fail('snapshot-task-stale');
  if (current.sessionRevision !== token.sessionRevision) return fail('snapshot-session-stale');
  if (current.repositoryRevision.headCommit !== token.repositoryRevision.headCommit) return fail('snapshot-head-stale');
  if (current.repositoryRevision.indexDigest !== token.repositoryRevision.indexDigest) return fail('snapshot-index-stale');
  if (current.repositoryRevision.worktreeDigest !== token.repositoryRevision.worktreeDigest) return fail('snapshot-worktree-stale');
  if (
    current.runtimeRevision.runtimeSnapshotSeq !== token.runtimeRevision.runtimeSnapshotSeq ||
    current.runtimeRevision.runtimeSnapshotId !== token.runtimeRevision.runtimeSnapshotId ||
    current.runtimeRevision.runtimeSnapshotDigest !== token.runtimeRevision.runtimeSnapshotDigest
  ) return fail('snapshot-runtime-stale');
  const currentDigest = deriveRevisionDigest(revisionBodyOf(current));
  if (currentDigest !== token.revisionDigest) return fail('snapshot-revision-digest-mismatch');
  let currentId = null;
  try {
    currentId = deriveSnapshotTokenId(current.taskId, current.taskInstanceId, current.sessionId, current.generation, currentDigest);
  } catch {
    return fail('snapshot-token-invalid');
  }
  if (currentId !== token.snapshotTokenId) return fail('snapshot-token-id-mismatch');
  return { valid: true, reason: null };
}

// Named TOCTOU gate: the final pre-mutation check TransactionalApply
// invokes verbatim immediately before model-facing mutation.
function revalidateBeforeMutation(token, currentState) {
  return revalidate(token, currentState);
}

// ---- checkpoint <-> snapshot binding ----
// The checkpoint proves "I was built from snapshot X" (identity legs);
// freshness still requires revalidate(X, current). Legacy pre-A05
// checkpoints (snapshot null/null) are NOT snapshot-bound: they report
// snapshot-token-missing here and must never be reinterpreted as bound.
function validateCheckpointSnapshotBinding(checkpoint, token) {
  const fail = (reason) => ({ valid: false, reason });
  if (!checkpoint || typeof checkpoint !== 'object') return fail('checkpoint-missing');
  if (!token || typeof token !== 'object') return fail('snapshot-token-missing');
  const structural = validateSnapshotToken(token);
  if (!structural.valid) return fail(structural.reason);
  const snapshot = checkpoint.snapshot;
  if (!snapshot || typeof snapshot !== 'object') return fail('snapshot-token-missing');
  if (snapshot.snapshotTokenId === null || snapshot.revisionDigest === null) return fail('snapshot-token-missing');
  if (snapshot.snapshotTokenId !== token.snapshotTokenId) return fail('snapshot-token-id-mismatch');
  if (snapshot.revisionDigest !== token.revisionDigest) return fail('snapshot-revision-digest-mismatch');
  if (checkpoint.generation !== token.generation) return fail('snapshot-generation-mismatch');
  if (checkpoint.taskId !== token.taskId) return fail('snapshot-task-mismatch');
  if (checkpoint.taskInstanceId !== token.taskInstanceId) return fail('snapshot-task-instance-mismatch');
  if (checkpoint.sessionId !== token.sessionId) return fail('snapshot-session-mismatch');
  return { valid: true, reason: null };
}

// ---- operation <-> snapshot binding ----
// operation.snapshotTokenId == checkpoint.snapshot.snapshotTokenId ==
// captured token.snapshotTokenId. Any mismatch BLOCKS. The revision
// digest is transitively bound: it lives inside the checkpoint payload
// and therefore inside checkpointContentDigest/checkpointId/sealDigest.
function assertOperationBindsSnapshot(operation, checkpoint, token) {
  const block = (reason) => ({ ok: false, reason });
  if (!operation || typeof operation !== 'object') return block('operation-missing');
  if (!checkpoint || typeof checkpoint !== 'object') return block('checkpoint-missing');
  const checkpointSnapshot = checkpoint.snapshot;
  if (!checkpointSnapshot || typeof checkpointSnapshot !== 'object') return block('snapshot-token-missing');
  if (checkpointSnapshot.snapshotTokenId === null || checkpointSnapshot.snapshotTokenId === undefined) {
    return block('snapshot-token-missing');
  }
  if (typeof operation.snapshotTokenId !== 'string' || !TOKEN_ID_PATTERN.test(operation.snapshotTokenId)) {
    return block('snapshot-token-invalid');
  }
  if (operation.snapshotTokenId !== checkpointSnapshot.snapshotTokenId) return block('snapshot-token-id-mismatch');
  if (token !== undefined && token !== null) {
    if (!token || typeof token !== 'object') return block('snapshot-token-missing');
    if (operation.snapshotTokenId !== token.snapshotTokenId) return block('snapshot-token-id-mismatch');
    if (checkpointSnapshot.revisionDigest !== token.revisionDigest) return block('snapshot-revision-digest-mismatch');
  }
  return { ok: true, reason: null };
}

// ---- token persistence (restart-safe validation) ----
// One immutable file per token id. No overwrite with different bytes;
// read-back is validated and byte-compared. Generation scoping is
// enforced by the bound generation inside the token (a token for
// generation N never validates state for generation M: revalidate
// compares generation explicitly).
function snapshotTokenFileName(tokenId) {
  if (typeof tokenId !== 'string' || !TOKEN_ID_PATTERN.test(tokenId)) {
    throw new Error('v2-snapshot-path: tokenId must be a valid snapshot token id');
  }
  return SNAPSHOT_FILE_PREFIX + tokenId + '.json';
}

function snapshotTokenFilePath(dir, tokenId) {
  if (typeof dir !== 'string' || dir === '') throw new Error('v2-snapshot-path: dir is required');
  return path.join(dir, snapshotTokenFileName(tokenId));
}

function persistSnapshotToken(dir, token) {
  if (typeof dir !== 'string' || dir === '') throw new Error('v2-snapshot-persist: dir is required (KEEP)');
  const check = validateSnapshotToken(token);
  if (!check.valid) throw new Error('v2-snapshot-persist: token refused (' + check.reason + ') (KEEP)');
  const serialized = serializeSnapshotTokenCanonical(token);
  fs.mkdirSync(dir, { recursive: true });
  const target = snapshotTokenFilePath(dir, token.snapshotTokenId);
  if (fs.existsSync(target)) {
    const prior = fs.readFileSync(target, 'utf8');
    if (prior === serialized) return readSnapshotToken(dir, token.snapshotTokenId);
    throw new Error('v2-snapshot-persist: refusing to overwrite another snapshot token (KEEP)');
  }
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, Buffer.from(serialized, 'utf8'));
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw new Error('v2-snapshot-persist: atomic rename failed (KEEP)');
  }
  return readSnapshotToken(dir, token.snapshotTokenId);
}

function readSnapshotToken(dir, tokenId) {
  const target = snapshotTokenFilePath(dir, tokenId);
  if (!fs.existsSync(target)) return null;
  const rawText = fs.readFileSync(target, 'utf8');
  if (byteLengthUtf8(rawText) > SNAPSHOT_MAX_BYTES) {
    throw new Error('v2-snapshot-read: token exceeds the bound (BLOCK/KEEP)');
  }
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('v2-snapshot-read: token is malformed (BLOCK/KEEP)');
  }
  const check = validateSnapshotToken(parsed);
  if (!check.valid) throw new Error('v2-snapshot-read: token invalid (' + check.reason + ') (BLOCK/KEEP)');
  if (parsed.snapshotTokenId !== tokenId) {
    throw new Error('v2-snapshot-read: token identity violated (BLOCK/KEEP)');
  }
  if (serializeSnapshotTokenCanonical(parsed) !== rawText) {
    throw new Error('v2-snapshot-read: persisted bytes fail read-back identity (BLOCK/KEEP)');
  }
  return { token: parsed, serialized: rawText, sizeBytes: byteLengthUtf8(rawText) };
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  REVISION_DIGEST_DOMAIN_V1,
  SNAPSHOT_TOKEN_ID_DOMAIN_V1,
  RUNTIME_DIGEST_DOMAIN_V1,
  TASK_REVISION_DOMAIN_V1,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_BOUNDS,
  TOKEN_ID_PATTERN,
  sha256HexUtf8,
  byteLengthUtf8,
  canonicalize,
  serializeCanonical,
  taskRevisionBodyOf,
  deriveTaskRevision,
  deriveRuntimeSnapshotId,
  deriveRuntimeSnapshotDigest,
  normalizeRuntimeRevision,
  normalizeRepositoryRevision,
  revisionBodyOf,
  deriveRevisionDigest,
  deriveSnapshotTokenId,
  normalizeSnapshotState,
  capture,
  revisionProjectionOf,
  captureConsistent,
  validateSnapshotToken,
  revalidate,
  revalidateBeforeMutation,
  validateCheckpointSnapshotBinding,
  assertOperationBindsSnapshot,
  snapshotTokenFileName,
  snapshotTokenFilePath,
  persistSnapshotToken,
  readSnapshotToken,
  serializeSnapshotTokenCanonical,
};
