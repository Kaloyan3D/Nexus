'use strict';
/**
 * ContextGenerationRuntimeV2.cjs - CCV2-A11 Multi-Generation Runtime production authority.
 *
 * ONE explicit authority for CCv2 generation identity over the lifetime of one
 * task/session. A11 answers: "which generation is current/next, who owns it,
 * what is its parent lineage, and which generations are terminally resolved?"
 *
 * Core model (frozen):
 *
 *   G1 -> commit -> continued work -> G2 -> commit -> continued work -> G3 ...
 *
 * Generation numbers are durable identity: once allocated, a generation number
 * is NEVER reused for different source state, even when the generation is
 * abandoned, stale, superseded, or failed before apply. Allocation is strictly
 * monotonic (highestAllocatedGeneration + 1); the parent of a new generation
 * is the latest successfully committed checkpoint, NOT necessarily
 * generation - 1 (skipped abandoned generations are supported).
 *
 * Authority separation (frozen): this module redefines NO lower-level
 * authority. It orchestrates existing authorities only:
 *
 *   A06 -> boundary safety (never re-decided here)
 *   A05 -> freshness (never re-derived here)
 *   A07 -> checkpointability (never re-decided here)
 *   A08 -> pressure/retention (never re-decided here)
 *   A09 -> predicted projection (never rebuilt here)
 *   A10 -> active transaction (never re-applied here)
 *   A11 -> which generation is current/next (THIS module, identity only)
 *
 * Durable representation (minimal, derived index only): the sealed
 * checkpoints (A03/A04, one file per generation in checkpointDir) and the
 * per-generation A02 operations (one operation file per generation under
 * operationRoot/generation-NNNNNN/) remain the authoritative source of truth.
 * A11 adds only a minimal derived index:
 *
 *   runtimeDir/context-generation-runtime-v2.json   - head index
 *     { highestAllocatedGeneration, latestCommittedGeneration,
 *       latestCommittedCheckpointId, lineage[], superseded[] }
 *   runtimeDir/generations/<N>/reservation.json     - allocation record
 *   runtimeDir/generations/<N>/superseded.json      - supersession marker
 *
 * The index carries ids/digests/bindings/statuses only: NEVER checkpoint
 * contents, A02 operation state, A10 apply state, shadow artifacts, prompt
 * text, or tool output. The index is fully re-derivable (reconstruction
 * scans the authoritative artifacts); deterministic repair is applied only
 * where one authoritative answer is provable (e.g. an allocated head that
 * lags a provably fully-landed generation).
 *
 * Per-generation A02 operation layout: the frozen A02 persistence authority
 * stores exactly one operation per directory
 * (context-compaction-operation-v2.json), so each generation owns
 * operationRoot/generation-NNNNNN/ and the frozen A02 persist/read/freeze
 * functions are reused verbatim per generation. No A02 semantic is changed;
 * the A11 supersession guard is consulted AROUND reconciliation/application.
 *
 * A10 integration (A11H hardening): the frozen A10 contract is UNCHANGED
 * (no new input keys, no new apply semantics). Layering is architectural,
 * not conventional:
 *
 *   A02 = transaction primitive (unguarded by design; never called
 *         directly for generation-managed operations outside tests)
 *   A10 = single-generation transactional active primitive (unguarded
 *         generation ownership; never called directly for
 *         generation-managed operations)
 *   A11 = generation-aware authorization + lifecycle authority. The
 *         ONLY supported generation-aware active path is
 *         applyCurrentGenerationV2(), which reconstructs, validates
 *         eligibility + supersession + unresolved state + reservation
 *         binding UNDER the cross-process lock, then invokes A10 exactly
 *         once with a reentrant lock attribution. Production/controller
 *         integration must consume the A11 entry, never raw A10, for any
 *         generation-managed CCv2 operation.
 *
 * A shadow result for a superseded, older-committed, or unallocated
 * generation must never mutate through any supported path (fresh apply,
 * retry, restart reconciliation, cross-process recovery).
 *
 * Explicit invocation only: NOTHING here triggers compaction automatically
 * (no pressure trigger, no background work). A13 owns runtime integration.
 *
 * NOT implemented here: A12 crash/concurrency campaign, A13 integration,
 * automatic pressure triggers, background compaction, new retention policy,
 * new projection semantics, new A10 apply semantics, Phase B ContextPage,
 * Phase C Context Compiler, LLM summarization, JEV / Laya, Nexus Nova.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md (A11).
 *
 * Determinism: no clock, no randomness, no LLM, no model call. Reservation
 * and supersession digests are deterministic domain-separated hashes over
 * validated bindings. Timestamps never enter semantic identity.
 *
 * Security: classification derives ONLY from authority metadata. Prompt,
 * tool-output, and repository TEXT are inert data: never branched on, never
 * copied into records/telemetry. Content-bearing input fields fail closed.
 *
 * Durability scope (frozen A05H wording preserved): atomic file writes
 * (temp + rename) + read-back validation are process-crash recoverable under
 * the filesystem/OS contract. NOT claimed power-loss durable (no fsync).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const compactionV2 = require('./ContextCompaction.cjs');
const checkpointV2 = require('./ContextCheckpointV2.cjs');
const trustV2 = require('./ContextTrustV2.cjs');
const shadowV2 = require('./ContextShadowV2.cjs');
// A12: deterministic test-only fault injection (defaults OFF; zero production
// behavior change unless a test explicitly arms a named point in-process).
let faultV2 = null;
try { faultV2 = require('./ContextRecoveryFaultV2.cjs'); } catch { faultV2 = null; }
function faultAt(point) {
  if (!faultV2) return;
  faultV2.maybeFaultV2(point);
}

const GENERATION_RUNTIME_SCHEMA_VERSION = 1;
const RUNTIME_FILE_NAME = 'context-generation-runtime-v2.json';
const GENERATIONS_SUBDIR = 'generations';
const GENERATION_DIR_PREFIX = 'generation-';
const RESERVATION_FILE_NAME = 'reservation.json';
const SUPERSEDED_FILE_NAME = 'superseded.json';

const RUNTIME_DIGEST_DOMAIN_V1 = 'nexus/context-generation-runtime/v1';
const RESERVATION_DIGEST_DOMAIN_V1 = 'nexus/context-generation-reservation/v1';
const SUPERSESSION_DIGEST_DOMAIN_V1 = 'nexus/context-generation-supersession/v1';
const LF_JOIN = String.fromCharCode(10);

// Active-generation lifecycle states (transient classification, never the
// persisted outcome vocabulary). null when no generation is active.
// A12 adds 'commit-pending-verification': fully landed but the committed
// head was never advanced and no verified recovered-completion evidence has
// been established yet (UNRESOLVED, never heuristic COMMITTED).
const ACTIVE_GENERATION_STATES = Object.freeze([
  'reserved',
  'intent-durable',
  'application-pending',
  'commit-pending-verification',
]);

// Allowed terminal-per-generation outcomes (section 11).
const GENERATION_OUTCOMES = Object.freeze([
  'RESERVED',
  'COMMITTED',
  'SUPERSEDED',
  'UNRESOLVED',
]);

// Stable machine-readable blocker codes (section 44).
const GENERATION_BLOCKER_CODES = Object.freeze([
  'generation-runtime-unavailable',
  'generation-reservation-conflict',
  'generation-source-stale',
  'generation-unresolved-operation',
  'generation-parent-mismatch',
  'generation-not-active',
  'generation-already-committed',
  'generation-cannot-supersede',
  'generation-runtime-fork',
  'generation-runtime-corrupt',
  'generation-head-conflict',
]);

const GENERATION_ID_BOUNDS = Object.freeze({
  taskId: 256,
  taskInstanceId: 256,
  sessionId: 256,
  detail: 1024,
});

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

// Closed-world exact keys. Unknown keys FAIL CLOSED before any digest/id
// computation (A05H rules apply to these protocol objects).
const RUNTIME_HEAD_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'highestAllocatedGeneration',
  'latestCommittedGeneration',
  'latestCommittedCheckpointId',
  'lineage',
  'superseded',
  'headDigest',
]);

const RUNTIME_LINEAGE_EXACT_KEYS = Object.freeze([
  'generation',
  'checkpointId',
  'parentCheckpointId',
]);

const RUNTIME_SUPERSEDED_EXACT_KEYS = Object.freeze([
  'generation',
  'checkpointId',
  'supersessionDigest',
]);

const RESERVATION_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'generation',
  'snapshotTokenId',
  'revisionDigest',
  'safePointBoundarySeq',
  'parentCommittedCheckpointId',
  'reservationDigest',
]);

const SUPERSESSION_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'generation',
  'checkpointId',
  'operationId',
  'reservedRevisionDigest',
  'observedRevisionDigest',
  'reason',
  'supersessionDigest',
]);

const RESERVE_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'runtimeDir',
  'checkpointDir',
  'operationRoot',
  'revisionDigest',
  'snapshotTokenId',
  'safePointBoundarySeq',
  'session',
  'serialization',
  'lockWorkspace',
]);

const COMMIT_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'runtimeDir',
  'checkpointDir',
  'operationRoot',
  'generation',
  'activeResult',
  'postApplyVerified',
  'session',
  'serialization',
  'lockWorkspace',
]);

const SUPERSEDE_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'runtimeDir',
  'checkpointDir',
  'operationRoot',
  'generation',
  'observedRevisionDigest',
  'observedSafePointBoundarySeq',
  'payloadText',
  'session',
  'serialization',
  'lockWorkspace',
]);

const RECONSTRUCT_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'runtimeDir',
  'checkpointDir',
  'operationRoot',
  'session',
  'repairHead',
]);

function failRuntime(message) {
  throw new Error('ccv2-generation-runtime-v2: ' + message);
}

function unknownKeyOf(value, exactKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of Object.keys(value)) {
    if (exactKeys.indexOf(key) === -1) return key;
  }
  return null;
}

function sha256HexUtf8(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function canonicalOf(value) {
  return shadowV2.serializeCanonical(value);
}

function isBoundedId(value, bound) {
  return typeof value === 'string' && value !== '' && value.length <= bound;
}

function isDigest(value) {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

// ---- paths -----------------------------------------------------------------

function runtimeFilePath(runtimeDir) {
  if (typeof runtimeDir !== 'string' || runtimeDir === '') failRuntime('generation-runtime-unavailable: runtimeDir is required');
  return path.join(runtimeDir, RUNTIME_FILE_NAME);
}

function generationDirPath(runtimeDir, generation) {
  if (typeof runtimeDir !== 'string' || runtimeDir === '') failRuntime('generation-runtime-unavailable: runtimeDir is required');
  if (!Number.isInteger(generation) || generation < 1) failRuntime('generation-runtime-corrupt: generation must be a positive integer');
  return path.join(runtimeDir, GENERATIONS_SUBDIR, GENERATION_DIR_PREFIX + String(generation).padStart(6, '0'));
}

function reservationFilePath(runtimeDir, generation) {
  return path.join(generationDirPath(runtimeDir, generation), RESERVATION_FILE_NAME);
}

function supersessionFilePath(runtimeDir, generation) {
  return path.join(generationDirPath(runtimeDir, generation), SUPERSEDED_FILE_NAME);
}

// Each generation owns one A02 operation directory under the shared root, so
// the frozen single-file A02 persistence authority is reused verbatim.
function operationDirForGenerationV2(operationRoot, generation) {
  if (typeof operationRoot !== 'string' || operationRoot === '') failRuntime('generation-runtime-unavailable: operationRoot is required');
  if (!Number.isInteger(generation) || generation < 1) failRuntime('generation-runtime-corrupt: generation must be a positive integer');
  return path.join(operationRoot, GENERATION_DIR_PREFIX + String(generation).padStart(6, '0'));
}

// ---- atomic persistence -----------------------------------------------------

function faultScopeOf(targetPath) {
  const base = path.basename(targetPath);
  if (base === RESERVATION_FILE_NAME) return 'reservation';
  if (base === SUPERSEDED_FILE_NAME) return 'supersession';
  if (base === RUNTIME_FILE_NAME) return 'head';
  return null;
}

function persistJsonAtomic(targetPath, value, serialize) {
  const scope = faultScopeOf(targetPath);
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const text = typeof serialize === 'function' ? serialize(value) : JSON.stringify(value, null, 2);
  if (scope) faultAt(scope + ':before-temp-write');
  const tmp = targetPath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, Buffer.from(text, 'utf8'));
  if (scope) faultAt(scope + ':after-temp-write');
  if (scope) faultAt(scope + ':before-rename');
  try {
    fs.renameSync(tmp, targetPath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    failRuntime('generation-runtime-unavailable: atomic rename failed for ' + path.basename(targetPath));
  }
  if (scope) faultAt(scope + ':after-rename');
  if (scope) faultAt(scope + ':before-read-back');
  const readBack = fs.readFileSync(targetPath, 'utf8');
  if (readBack !== text) failRuntime('generation-runtime-unavailable: read-back differs for ' + path.basename(targetPath));
  if (scope) faultAt(scope + ':after-read-back-before-return');
  return { text, readBack };
}

function readJsonFile(targetPath) {
  if (!fs.existsSync(targetPath)) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    failRuntime('generation-runtime-corrupt: malformed JSON in ' + path.basename(path.dirname(targetPath)) + '/' + path.basename(targetPath));
  }
  return parsed;
}

// ---- deterministic digests ---------------------------------------------------

function deriveReservationDigestV2(fields) {
  const body = {
    taskId: fields.taskId,
    taskInstanceId: fields.taskInstanceId,
    sessionId: fields.sessionId,
    generation: fields.generation,
    snapshotTokenId: fields.snapshotTokenId === undefined ? null : fields.snapshotTokenId,
    revisionDigest: fields.revisionDigest,
    safePointBoundarySeq: fields.safePointBoundarySeq,
    parentCommittedCheckpointId: fields.parentCommittedCheckpointId === undefined ? null : fields.parentCommittedCheckpointId,
  };
  return sha256HexUtf8(RESERVATION_DIGEST_DOMAIN_V1 + LF_JOIN + canonicalOf(body));
}

function deriveSupersessionDigestV2(fields) {
  const body = {
    taskId: fields.taskId,
    taskInstanceId: fields.taskInstanceId,
    sessionId: fields.sessionId,
    generation: fields.generation,
    checkpointId: fields.checkpointId === undefined ? null : fields.checkpointId,
    operationId: fields.operationId === undefined ? null : fields.operationId,
    reservedRevisionDigest: fields.reservedRevisionDigest,
    observedRevisionDigest: fields.observedRevisionDigest,
    reason: fields.reason,
  };
  return sha256HexUtf8(SUPERSESSION_DIGEST_DOMAIN_V1 + LF_JOIN + canonicalOf(body));
}

function deriveRuntimeDigestV2(fields) {
  const body = {
    taskId: fields.taskId,
    taskInstanceId: fields.taskInstanceId,
    sessionId: fields.sessionId,
    highestAllocatedGeneration: fields.highestAllocatedGeneration,
    latestCommittedGeneration: fields.latestCommittedGeneration,
    latestCommittedCheckpointId: fields.latestCommittedCheckpointId,
    lineage: fields.lineage,
    superseded: fields.superseded,
  };
  return sha256HexUtf8(RUNTIME_DIGEST_DOMAIN_V1 + LF_JOIN + canonicalOf(body));
}

// ---- closed-world validation ---------------------------------------------------

function validateReservationV2(reservation) {
  const fail = (reason) => ({ valid: false, reason });
  if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation)) return fail('generation-runtime-corrupt');
  if (unknownKeyOf(reservation, RESERVATION_EXACT_KEYS) !== null) return fail('generation-runtime-corrupt');
  if (Number(reservation.schemaVersion) !== GENERATION_RUNTIME_SCHEMA_VERSION) return fail('generation-runtime-corrupt');
  if (!isBoundedId(reservation.taskId, GENERATION_ID_BOUNDS.taskId)) return fail('generation-runtime-corrupt');
  if (!isBoundedId(reservation.taskInstanceId, GENERATION_ID_BOUNDS.taskInstanceId)) return fail('generation-runtime-corrupt');
  if (!isBoundedId(reservation.sessionId, GENERATION_ID_BOUNDS.sessionId)) return fail('generation-runtime-corrupt');
  if (!Number.isInteger(reservation.generation) || reservation.generation < 1) return fail('generation-runtime-corrupt');
  if (reservation.snapshotTokenId !== null && reservation.snapshotTokenId !== undefined
    && (typeof reservation.snapshotTokenId !== 'string' || reservation.snapshotTokenId === '')) return fail('generation-runtime-corrupt');
  if (!isDigest(reservation.revisionDigest)) return fail('generation-runtime-corrupt');
  if (!Number.isInteger(reservation.safePointBoundarySeq) || reservation.safePointBoundarySeq < 0) return fail('generation-runtime-corrupt');
  if (reservation.parentCommittedCheckpointId !== null && reservation.parentCommittedCheckpointId !== undefined
    && typeof reservation.parentCommittedCheckpointId !== 'string') return fail('generation-runtime-corrupt');
  if (typeof reservation.reservationDigest !== 'string' || reservation.reservationDigest.length !== 64) return fail('generation-runtime-corrupt');
  const expected = deriveReservationDigestV2(reservation);
  if (reservation.reservationDigest !== expected) return fail('generation-runtime-corrupt');
  return { valid: true, reason: null };
}

function validateSupersessionV2(marker) {
  const fail = (reason) => ({ valid: false, reason });
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return fail('generation-runtime-corrupt');
  if (unknownKeyOf(marker, SUPERSESSION_EXACT_KEYS) !== null) return fail('generation-runtime-corrupt');
  if (Number(marker.schemaVersion) !== GENERATION_RUNTIME_SCHEMA_VERSION) return fail('generation-runtime-corrupt');
  if (!isBoundedId(marker.taskId, GENERATION_ID_BOUNDS.taskId)) return fail('generation-runtime-corrupt');
  if (!isBoundedId(marker.taskInstanceId, GENERATION_ID_BOUNDS.taskInstanceId)) return fail('generation-runtime-corrupt');
  if (!isBoundedId(marker.sessionId, GENERATION_ID_BOUNDS.sessionId)) return fail('generation-runtime-corrupt');
  if (!Number.isInteger(marker.generation) || marker.generation < 1) return fail('generation-runtime-corrupt');
  if (marker.checkpointId !== null && marker.checkpointId !== undefined && typeof marker.checkpointId !== 'string') return fail('generation-runtime-corrupt');
  if (marker.operationId !== null && marker.operationId !== undefined && typeof marker.operationId !== 'string') return fail('generation-runtime-corrupt');
  if (!isDigest(marker.reservedRevisionDigest)) return fail('generation-runtime-corrupt');
  if (!isDigest(marker.observedRevisionDigest)) return fail('generation-runtime-corrupt');
  if (typeof marker.reason !== 'string' || marker.reason === '') return fail('generation-runtime-corrupt');
  if (typeof marker.supersessionDigest !== 'string' || marker.supersessionDigest.length !== 64) return fail('generation-runtime-corrupt');
  const expected = deriveSupersessionDigestV2(marker);
  if (marker.supersessionDigest !== expected) return fail('generation-runtime-corrupt');
  return { valid: true, reason: null };
}

function validateGenerationRuntimeV2(head) {
  const fail = (reason) => ({ valid: false, reason });
  if (!head || typeof head !== 'object' || Array.isArray(head)) return fail('generation-runtime-corrupt');
  if (unknownKeyOf(head, RUNTIME_HEAD_EXACT_KEYS) !== null) return fail('generation-runtime-corrupt');
  if (Number(head.schemaVersion) !== GENERATION_RUNTIME_SCHEMA_VERSION) return fail('generation-runtime-corrupt');
  if (!isBoundedId(head.taskId, GENERATION_ID_BOUNDS.taskId)) return fail('generation-runtime-corrupt');
  if (!isBoundedId(head.taskInstanceId, GENERATION_ID_BOUNDS.taskInstanceId)) return fail('generation-runtime-corrupt');
  if (!isBoundedId(head.sessionId, GENERATION_ID_BOUNDS.sessionId)) return fail('generation-runtime-corrupt');
  if (!Number.isInteger(head.highestAllocatedGeneration) || head.highestAllocatedGeneration < 0) return fail('generation-runtime-corrupt');
  if (head.latestCommittedGeneration !== null && head.latestCommittedGeneration !== undefined
    && (!Number.isInteger(head.latestCommittedGeneration) || head.latestCommittedGeneration < 1)) return fail('generation-runtime-corrupt');
  if (head.latestCommittedCheckpointId !== null && head.latestCommittedCheckpointId !== undefined
    && typeof head.latestCommittedCheckpointId !== 'string') return fail('generation-runtime-corrupt');
  if ((head.latestCommittedGeneration === null || head.latestCommittedGeneration === undefined)
    !== (head.latestCommittedCheckpointId === null || head.latestCommittedCheckpointId === undefined)) {
    return fail('generation-runtime-corrupt');
  }
  if (!Array.isArray(head.lineage)) return fail('generation-runtime-corrupt');
  if (!Array.isArray(head.superseded)) return fail('generation-runtime-corrupt');
  const seenLineage = new Set();
  for (const entry of head.lineage) {
    if (!entry || typeof entry !== 'object') return fail('generation-runtime-corrupt');
    if (unknownKeyOf(entry, RUNTIME_LINEAGE_EXACT_KEYS) !== null) return fail('generation-runtime-corrupt');
    if (!Number.isInteger(entry.generation) || entry.generation < 1) return fail('generation-runtime-corrupt');
    if (typeof entry.checkpointId !== 'string' || entry.checkpointId === '') return fail('generation-runtime-corrupt');
    if (entry.parentCheckpointId !== null && entry.parentCheckpointId !== undefined && typeof entry.parentCheckpointId !== 'string') {
      return fail('generation-runtime-corrupt');
    }
    if (seenLineage.has(entry.generation)) return fail('generation-runtime-fork');
    seenLineage.add(entry.generation);
  }
  const seenSuperseded = new Set();
  for (const entry of head.superseded) {
    if (!entry || typeof entry !== 'object') return fail('generation-runtime-corrupt');
    if (unknownKeyOf(entry, RUNTIME_SUPERSEDED_EXACT_KEYS) !== null) return fail('generation-runtime-corrupt');
    if (!Number.isInteger(entry.generation) || entry.generation < 1) return fail('generation-runtime-corrupt');
    // A12-2: reservation-only supersession carries checkpointId=null (no
    // checkpoint was ever persisted). The marker authority already permits
    // null; the head index mirrors the marker verbatim. Rejecting null here
    // used to half-persist supersession (marker durable, head stale).
    if (entry.checkpointId !== null && entry.checkpointId !== undefined && typeof entry.checkpointId !== 'string') return fail('generation-runtime-corrupt');
    if (typeof entry.supersessionDigest !== 'string' || entry.supersessionDigest.length !== 64) return fail('generation-runtime-corrupt');
    if (seenSuperseded.has(entry.generation)) return fail('generation-runtime-fork');
    seenSuperseded.add(entry.generation);
    if (seenLineage.has(entry.generation)) return fail('generation-runtime-corrupt');
  }
  if (typeof head.headDigest !== 'string' || head.headDigest.length !== 64) return fail('generation-runtime-corrupt');
  const expected = deriveRuntimeDigestV2(head);
  if (head.headDigest !== expected) return fail('generation-runtime-corrupt');
  return { valid: true, reason: null };
}

// ---- in-process serialization ---------------------------------------------------
// INNER layer: a per-session promise chain so concurrent A11 calls in this
// process never interleave. The cross-process lock (same family as A10)
// remains MANDATORY for reserve/commit/supersede/head-repair.
const generationRuntimeChains = new Map();

function runSerializedGeneration(key, fn) {
  const prior = generationRuntimeChains.get(key) || Promise.resolve();
  let settle = null;
  const current = new Promise((resolve) => { settle = resolve; });
  generationRuntimeChains.set(key, prior.then(() => current));
  return prior.then(() => Promise.resolve().then(fn)).then(
    (value) => { settle(); if (generationRuntimeChains.get(key) === current) generationRuntimeChains.delete(key); return value; },
    (error) => { settle(); if (generationRuntimeChains.get(key) === current) generationRuntimeChains.delete(key); throw error; }
  );
}

async function withGenerationLockV2(serialization, lockCall, fn) {
  if (!serialization || typeof serialization.acquire !== 'function'
    || typeof serialization.renew !== 'function' || typeof serialization.release !== 'function') {
    failRuntime('generation-runtime-unavailable: compaction serialization client is required');
  }
  let acquired = null;
  try {
    acquired = await serialization.acquire(lockCall);
  } catch (error) {
    failRuntime('generation-runtime-unavailable: lock acquire failed (' + String((error && error.message) || error).slice(0, 200) + ')');
  }
  if (!acquired || acquired.acquired !== true || typeof acquired.ownerId !== 'string' || acquired.ownerId === '') {
    failRuntime('generation-reservation-conflict: compaction lock is held by a live owner');
  }
  try {
    return await fn(acquired);
  } finally {
    try {
      await serialization.release({ taskId: lockCall.taskId, ownerId: acquired.ownerId });
    } catch { /* best effort: the lease expires; never mask the call result */ }
  }
}

function generationLockCallOf(taskId, taskInstanceId, sessionId, lockWorkspace) {
  if (typeof lockWorkspace !== 'string' || lockWorkspace === '') {
    failRuntime('generation-runtime-unavailable: lockWorkspace (ledger workspace) is required');
  }
  return {
    workspace: lockWorkspace,
    taskId,
    taskInstanceId,
    sessionId,
    operationId: 'ccv2-generation-reservation',
  };
}

// ---- evidence scan ------------------------------------------------------------
// Reused authorities only: sealed checkpoints (A04), A02 operations, A11
// reservation/supersession records. Never invents state.

function listCheckpointGenerations(checkpointDir) {
  if (typeof checkpointDir !== 'string' || checkpointDir === '' || !fs.existsSync(checkpointDir)) return [];
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(checkpointDir);
  } catch {
    return [];
  }
  for (const name of entries) {
    const match = /^cp-(\d{6})\.json$/.exec(name);
    if (match) found.push(Number(match[1]));
  }
  return found.sort((a, b) => a - b);
}

function listOperationGenerations(operationRoot) {
  if (typeof operationRoot !== 'string' || operationRoot === '' || !fs.existsSync(operationRoot)) return [];
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(operationRoot);
  } catch {
    return [];
  }
  for (const name of entries) {
    const match = new RegExp('^' + GENERATION_DIR_PREFIX + '(\\d{6})$').exec(name);
    if (!match) continue;
    const gen = Number(match[1]);
    try {
      if (fs.existsSync(path.join(operationRoot, name, compactionV2.OPERATION_V2_FILENAME))) found.push(gen);
    } catch { /* ignore unreadable entries; file scan stays total */ }
  }
  return found.sort((a, b) => a - b);
}

function listReservationGenerations(runtimeDir) {
  if (typeof runtimeDir !== 'string' || runtimeDir === '') return [];
  const base = path.join(runtimeDir, GENERATIONS_SUBDIR);
  if (!fs.existsSync(base)) return [];
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return [];
  }
  for (const name of entries) {
    const match = new RegExp('^' + GENERATION_DIR_PREFIX + '(\\d{6})$').exec(name);
    if (!match) continue;
    if (fs.existsSync(path.join(base, name, RESERVATION_FILE_NAME))) found.push(Number(match[1]));
  }
  return found.sort((a, b) => a - b);
}

function readReservationV2(runtimeDir, generation, taskBinding) {
  const parsed = readJsonFile(reservationFilePath(runtimeDir, generation));
  if (parsed === null) return null;
  const check = validateReservationV2(parsed);
  if (!check.valid) failRuntime(check.reason + ': reservation for generation ' + generation + ' is corrupt');
  if (taskBinding) {
    if (parsed.taskId !== taskBinding.taskId || parsed.taskInstanceId !== taskBinding.taskInstanceId
      || parsed.sessionId !== taskBinding.sessionId) {
      failRuntime('generation-runtime-corrupt: reservation for generation ' + generation + ' binds another task/session');
    }
  }
  return parsed;
}

function readSupersessionV2(runtimeDir, generation, taskBinding) {
  const parsed = readJsonFile(supersessionFilePath(runtimeDir, generation));
  if (parsed === null) return null;
  const check = validateSupersessionV2(parsed);
  if (!check.valid) failRuntime(check.reason + ': supersession marker for generation ' + generation + ' is corrupt');
  if (taskBinding) {
    if (parsed.taskId !== taskBinding.taskId || parsed.taskInstanceId !== taskBinding.taskInstanceId
      || parsed.sessionId !== taskBinding.sessionId) {
      failRuntime('generation-runtime-corrupt: supersession marker for generation ' + generation + ' binds another task/session');
    }
  }
  return parsed;
}

function readSealedEvidence(checkpointDir, generation) {
  let stored = null;
  try {
    stored = trustV2.readSealedCheckpointV2(checkpointDir, generation);
  } catch (error) {
    failRuntime('generation-runtime-corrupt: sealed checkpoint for generation ' + generation + ' is unreadable (' + String((error && error.message) || error).slice(0, 200) + ')');
  }
  return stored;
}

function readOperationEvidence(operationRoot, generation) {
  const dir = operationDirForGenerationV2(operationRoot, generation);
  let parsed = null;
  try {
    parsed = compactionV2.readCompactionOperationV2(dir);
  } catch (error) {
    failRuntime('generation-runtime-corrupt: operation for generation ' + generation + ' is unreadable (' + String((error && error.message) || error).slice(0, 200) + ')');
  }
  return parsed;
}

// ---- landing classification ------------------------------------------------------
// Citation scan over the live session: which compaction segments of ONE
// frozen operation have verifiably landed. Mirrors the frozen A02
// reconciliation citation rules (payload digest + exact continuation anchors,
// stray anchors are foreign). Returns segment status plus the two facts A11
// needs: allLanded (commit candidate) and anyLanded (supersession refusal).

function generationCitationsOf(session, generation) {
  const cited = [];
  if (!session || !Array.isArray(session.events)) return cited;
  for (const event of session.events) {
    if (!event || event.type !== 'user/message') continue;
    const source = event.data && event.data.source;
    if (!source || source.kind !== 'plugin' || source.plugin !== 'aih-controller') continue;
    if (Number(source.generation) !== Number(generation)) continue;
    if (source.form !== 'context-checkpoint' && source.form !== 'context-continuation') continue;
    cited.push(event);
  }
  return cited;
}

function landingStatusOfV2(operation, session, payloadText) {
  const segments = Array.isArray(operation.segments) ? operation.segments : [];
  const segmentStatus = segments.map(() => 'NOT_LANDED');
  if (segments.length === 0) return { segmentStatus, landedCount: 0, allLanded: false, anyLanded: false, foreign: true };
  if (typeof payloadText !== 'string' || payloadText === '') {
    return { segmentStatus, landedCount: 0, allLanded: false, anyLanded: false, foreign: false, unproven: true };
  }
  const expectedDigest = sha256HexUtf8(payloadText);
  if (operation.checkpointContentDigest !== expectedDigest) {
    return { segmentStatus: segments.map(() => 'LANDED_FOREIGN_OR_CORRUPT'), landedCount: 0, allLanded: false, anyLanded: false, foreign: true };
  }
  const cited = generationCitationsOf(session, operation.checkpointGeneration);
  const payloadNodes = cited.filter((e) => e.data && e.data.source && e.data.source.form === 'context-checkpoint');
  const anchorNodes = cited.filter((e) => e.data && e.data.source && e.data.source.form === 'context-continuation');
  const payloadIndexes = segments.map((s, i) => (s && s.role === 'payload' ? i : -1)).filter((i) => i >= 0);
  if (payloadIndexes.length !== 1) {
    return { segmentStatus: segments.map(() => 'LANDED_FOREIGN_OR_CORRUPT'), landedCount: 0, allLanded: false, anyLanded: false, foreign: true };
  }
  const payloadIndex = payloadIndexes[0];
  if (payloadNodes.length === 0) {
    segmentStatus[payloadIndex] = 'NOT_LANDED';
  } else if (payloadNodes.length === 1 && sha256HexUtf8(compactionV2.textContentOfEvent(payloadNodes[0])) === expectedDigest) {
    segmentStatus[payloadIndex] = 'LANDED_EXPECTED';
  } else {
    return { segmentStatus: segments.map(() => 'LANDED_FOREIGN_OR_CORRUPT'), landedCount: 0, allLanded: false, anyLanded: payloadNodes.length > 0, foreign: true };
  }
  const expectedAnchors = new Map();
  for (let index = 0; index < segments.length; index += 1) {
    if (index === payloadIndex) continue;
    expectedAnchors.set(index, compactionV2.buildContinuationAnchorText(operation.operationId, operation.checkpointGeneration, index, segments.length));
  }
  const expectedAnchorTexts = new Set(expectedAnchors.values());
  const strayAnchors = anchorNodes.filter((e) => !expectedAnchorTexts.has(compactionV2.textContentOfEvent(e)));
  if (strayAnchors.length > 0) {
    return { segmentStatus: segments.map(() => 'LANDED_FOREIGN_OR_CORRUPT'), landedCount: 0, allLanded: false, anyLanded: true, foreign: true };
  }
  for (const [index, expectedAnchor] of expectedAnchors) {
    const matches = anchorNodes.filter((e) => compactionV2.textContentOfEvent(e) === expectedAnchor);
    if (matches.length === 1) segmentStatus[index] = 'LANDED_EXPECTED';
    else if (matches.length === 0) segmentStatus[index] = 'NOT_LANDED';
    else {
      return { segmentStatus: segments.map(() => 'LANDED_FOREIGN_OR_CORRUPT'), landedCount: 0, allLanded: false, anyLanded: true, foreign: true };
    }
  }
  let landedCount = 0;
  for (const status of segmentStatus) if (status === 'LANDED_EXPECTED') landedCount += 1;
  return {
    segmentStatus,
    landedCount,
    allLanded: landedCount === segments.length,
    anyLanded: landedCount > 0,
    foreign: false,
  };
}

// ---- per-generation classification -------------------------------------------------

function classifyGenerationV2(evidence) {
  // evidence: { generation, reservation, supersession, sealed, operation,
  //   landing (nullable), sessionCitations (count, no-operation case),
  //   committedHead (nullable { generation, checkpointId }) }.
  // Returns { outcome, activeState, checkpointId, operationId,
  //   parentCheckpointId }.
  const out = {
    outcome: 'RESERVED',
    activeState: null,
    checkpointId: evidence.sealed ? evidence.sealed.checkpoint.checkpointId : null,
    operationId: evidence.operation ? evidence.operation.operationId : null,
    parentCheckpointId: evidence.sealed ? evidence.sealed.checkpoint.parentCheckpointId : null,
  };
  if (evidence.supersession) {
    if (evidence.landing && (evidence.landing.anyLanded || evidence.landing.foreign)) {
      failRuntime('generation-runtime-corrupt: generation ' + evidence.generation + ' is marked superseded but shows landed segments');
    }
    if (!evidence.landing && evidence.sessionCitations > 0) {
      failRuntime('generation-runtime-corrupt: generation ' + evidence.generation + ' is marked superseded but shows session citations');
    }
    out.outcome = 'SUPERSEDED';
    return out;
  }
  // Any generation in the committed lineage is COMMITTED history (not only
  // the head): older committed checkpoints never become active again.
  if (evidence.committedLineage && evidence.committedLineage.has(Number(evidence.generation))) {
    out.outcome = 'COMMITTED';
    return out;
  }
  if (evidence.committedHead && Number(evidence.committedHead.generation) === Number(evidence.generation)) {
    out.outcome = 'COMMITTED';
    return out;
  }
  if (evidence.landing) {
    if (evidence.landing.foreign) {
      out.outcome = 'UNRESOLVED';
      out.activeState = 'application-pending';
      return out;
    }
    if (evidence.landing.allLanded) {
      // A12 §12: fully landed but the committed head was never advanced is
      // NOT commit proof. Segment-count completeness never authorizes the
      // head: the generation is UNRESOLVED (commit-pending-verification)
      // until reconstruct re-runs verification against the restored
      // authoritative session (sealed checkpoint + durable operation +
      // clean landing) and promotes it through the explicit recovered-
      // completion path. Without that evidence it stays UNRESOLVED.
      out.outcome = 'UNRESOLVED';
      out.activeState = 'commit-pending-verification';
      out.commitPending = true;
      out.headAdvanced = false;
      return out;
    }
    if (evidence.landing.anyLanded) {
      out.outcome = 'UNRESOLVED';
      out.activeState = 'application-pending';
      return out;
    }
    out.outcome = 'RESERVED';
    out.activeState = 'intent-durable';
    return out;
  }
  if (evidence.operation && !evidence.sealed) {
    // Operation without a checkpoint is ambiguous forward state: recovery
    // must reconcile before any newer generation may proceed.
    out.outcome = 'UNRESOLVED';
    out.activeState = 'application-pending';
    return out;
  }
  if (!evidence.operation && evidence.sessionCitations > 0) {
    out.outcome = 'UNRESOLVED';
    out.activeState = 'application-pending';
    return out;
  }
  out.outcome = 'RESERVED';
  out.activeState = evidence.operation ? 'intent-durable' : 'reserved';
  return out;
}

// ---- reconstruction ------------------------------------------------------------------

function normalizeReconstructInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) failRuntime('generation-runtime-unavailable: input is required');
  const unknown = unknownKeyOf(rawInput, RECONSTRUCT_INPUT_EXACT_KEYS);
  if (unknown !== null) failRuntime('generation-runtime-unavailable: unknown field ' + unknown);
  if (Number(rawInput.schemaVersion) !== GENERATION_RUNTIME_SCHEMA_VERSION) failRuntime('generation-runtime-unavailable: schemaVersion must be 1');
  if (!isBoundedId(rawInput.taskId, GENERATION_ID_BOUNDS.taskId)) failRuntime('generation-runtime-unavailable: taskId is required');
  if (!isBoundedId(rawInput.taskInstanceId, GENERATION_ID_BOUNDS.taskInstanceId)) failRuntime('generation-runtime-unavailable: taskInstanceId is required');
  if (!isBoundedId(rawInput.sessionId, GENERATION_ID_BOUNDS.sessionId)) failRuntime('generation-runtime-unavailable: sessionId is required');
  for (const key of ['runtimeDir', 'checkpointDir', 'operationRoot']) {
    if (typeof rawInput[key] !== 'string' || rawInput[key] === '') failRuntime('generation-runtime-unavailable: ' + key + ' is required');
  }
  if (rawInput.session !== undefined && rawInput.session !== null && typeof rawInput.session !== 'object') {
    failRuntime('generation-runtime-unavailable: session must be an object');
  }
  return rawInput;
}

function emptyHeadFor(binding) {
  const head = {
    schemaVersion: GENERATION_RUNTIME_SCHEMA_VERSION,
    taskId: binding.taskId,
    taskInstanceId: binding.taskInstanceId,
    sessionId: binding.sessionId,
    highestAllocatedGeneration: 0,
    latestCommittedGeneration: null,
    latestCommittedCheckpointId: null,
    lineage: [],
    superseded: [],
    headDigest: null,
  };
  head.headDigest = deriveRuntimeDigestV2(head);
  return Object.freeze(head);
}

function writeHeadV2(runtimeDir, head) {
  const check = validateGenerationRuntimeV2(head);
  if (!check.valid) failRuntime(check.reason + ': refusing to persist an invalid runtime head');
  const target = runtimeFilePath(runtimeDir);
  persistJsonAtomic(target, head);
  const back = readJsonFile(target);
  const recheck = validateGenerationRuntimeV2(back);
  if (!recheck.valid) failRuntime(recheck.reason + ': head read-back refused');
  if (back.headDigest !== head.headDigest) failRuntime('generation-runtime-unavailable: head read-back differs');
  return Object.freeze(JSON.parse(JSON.stringify(back)));
}

// ---- A12 recovered-completion evidence --------------------------------------------
// buildRecoveredCompletionV2 produces the deterministic recovered-completion
// record for a session-verified commit-pending generation: ids, digests,
// bindings and landing counts only (never payload text, prompt text, or
// tool output). It is the durable-authoritative equivalent of the lost
// in-memory A10 result: commitGenerationV2 accepts status 'recovered'
// results whose checkpoint/operation identity matches this evidence.
function buildRecoveredCompletionV2(evidence, generation) {
  if (!evidence || !evidence.sealed || !evidence.operation || !evidence.landing) return null;
  return Object.freeze({
    schemaVersion: GENERATION_RUNTIME_SCHEMA_VERSION,
    kind: 'recovered-completion',
    generation,
    checkpointId: evidence.sealed.checkpointId,
    checkpointContentDigest: evidence.sealed.checkpointContentDigest,
    operationId: evidence.operation.operationId,
    parentCheckpointId: evidence.sealed.parentCheckpointId,
    landedSegments: evidence.landing.landedCount,
    verification: 'session-landing-reverified',
  });
}

// recoveryTraceV2 returns the bounded deterministic recovery trace for one
// reconstruct pass: observed state, decision, action, result. Identical
// durable state yields identical traces. No wall-clock, no PID, no raw
// task content: ids/digests/counts/statuses only.
function recoveryTraceV2(state) {
  if (!state || typeof state !== 'object') failRuntime('generation-runtime-unavailable: runtime state is required');
  const trace = [];
  for (const gen of state.generations || []) {
    let decision = 'steady';
    if (gen.outcome === 'UNRESOLVED' && gen.activeState === 'commit-pending-verification') decision = 'reverify-then-repair-or-hold';
    else if (gen.outcome === 'UNRESOLVED') decision = 'reconcile-before-newer-generation';
    else if (gen.outcome === 'RESERVED') decision = 'await-intent-or-supersede';
    else decision = 'terminal-' + String(gen.outcome).toLowerCase();
    trace.push(Object.freeze({
      generation: gen.generation,
      observedState: gen.outcome + (gen.activeState ? '/' + gen.activeState : ''),
      decision,
      action: state.repairedHead && gen.generation === state.latestCommittedGeneration ? 'advance-head' : 'none',
      result: state.reconstructionOutcome,
    }));
  }
  return Object.freeze(trace);
}

// Reconstructs the full multi-generation runtime from authoritative durable
// state. Deterministic: identical artifacts yield byte-identical state (the
// returned object serializes canonically equal). When repairHead is true
// (default) AND the authoritative session is restored from durable flushed
// state (restart recovery), a fully-landed generation that the head lags is
// re-verified (sealed checkpoint + durable operation + clean landing
// re-computed verbatim) and advanced deterministically (commit-before-head
// crash repair with recovered-completion evidence); anything ambiguous fails
// closed instead of guessing. STRICT PRECONDITION: repairHead:true requires
// a restored (durable-flushed) session. A live in-memory session may show
// landed segments whose flush never succeeded (flush ambiguity); healing
// from such a session would falsely commit unflushed application. The
// reserve and entry paths therefore always reconstruct with repairHead:false
// and reach terminal state only via A10 forward recovery (re-flush +
// re-verify) plus explicit commit. Without the restored session, a
// fully-landed head-missing generation stays UNRESOLVED
// (commit-pending-verification) and repair is deferred
// (head-repair-pending). Segment presence alone NEVER advances the head.
function reconstructGenerationRuntimeV2(rawInput) {
  const n = normalizeReconstructInput(rawInput);
  const binding = { taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId };
  const repairHead = n.repairHead === undefined || n.repairHead === null ? true : n.repairHead === true;

  const storedHead = readJsonFile(runtimeFilePath(n.runtimeDir));
  let head = storedHead;
  if (head !== null) {
    const check = validateGenerationRuntimeV2(head);
    if (!check.valid) failRuntime(check.reason + ': stored runtime head is corrupt');
    if (head.taskId !== n.taskId || head.taskInstanceId !== n.taskInstanceId || head.sessionId !== n.sessionId) {
      failRuntime('generation-runtime-corrupt: stored head binds another task/session');
    }
  }

  const checkpointGens = listCheckpointGenerations(n.checkpointDir);
  const operationGens = listOperationGenerations(n.operationRoot);
  const reservationGens = listReservationGenerations(n.runtimeDir);
  const headLineageGens = head ? head.lineage.map((e) => e.generation) : [];
  const headSupersededGens = head ? head.superseded.map((e) => e.generation) : [];
  const headHighest = head ? head.highestAllocatedGeneration : 0;
  const allGens = Array.from(new Set(checkpointGens.concat(operationGens, reservationGens, headLineageGens, headSupersededGens)))
    .filter((g) => Number.isInteger(g) && g >= 1)
    .sort((a, b) => a - b);

  // Duplicate reservations with different bindings are a fork, never merged.
  const perGeneration = new Map();
  for (const generation of allGens) {
    const reservation = readReservationV2(n.runtimeDir, generation, binding);
    const supersession = readSupersessionV2(n.runtimeDir, generation, binding);
    let sealed = null;
    if (checkpointGens.indexOf(generation) !== -1) sealed = readSealedEvidence(n.checkpointDir, generation);
    let operation = null;
    if (operationGens.indexOf(generation) !== -1) operation = readOperationEvidence(n.operationRoot, generation);
    if (reservation && sealed && reservation.generation !== sealed.checkpoint.generation) {
      failRuntime('generation-runtime-corrupt: reservation/checkpoint generation mismatch at ' + generation);
    }
    if (reservation && operation && Number(operation.checkpointGeneration) !== Number(generation)) {
      failRuntime('generation-runtime-corrupt: operation binds another generation (expected ' + generation + ')');
    }
    if (sealed && operation) {
      if (operation.checkpointId !== sealed.checkpoint.checkpointId) {
        failRuntime('generation-runtime-corrupt: operation/checkpoint identity mismatch at generation ' + generation);
      }
      if (operation.checkpointContentDigest !== sealed.checkpoint.checkpointContentDigest) {
        failRuntime('generation-runtime-corrupt: operation/checkpoint digest mismatch at generation ' + generation);
      }
      if (operation.taskId !== n.taskId || operation.taskInstanceId !== n.taskInstanceId || operation.sessionId !== n.sessionId) {
        failRuntime('generation-runtime-corrupt: operation binds another task/session at generation ' + generation);
      }
      if (sealed.checkpoint.taskId !== n.taskId || sealed.checkpoint.taskInstanceId !== n.taskInstanceId
        || sealed.checkpoint.sessionId !== n.sessionId) {
        failRuntime('generation-runtime-corrupt: checkpoint binds another task/session at generation ' + generation);
      }
    }
    if (reservation && sealed && reservation.parentCommittedCheckpointId !== null
      && sealed.checkpoint.generation === 1) {
      failRuntime('generation-runtime-corrupt: generation 1 must carry parentCheckpointId=null');
    }
    // A12-3 note (investigated, NOT enforced here): reservation source
    // bindings (revisionDigest/snapshotTokenId) are generation-bound
    // observations captured at reservation time, while the sealed
    // checkpoint snapshot is captured at build time for the checkpoint
    // generation; frozen A11 flows legitimately carry different values
    // across the two (e.g. G3 reserved from a moved-state G2 observation,
    // checkpoint built later for G3). Cross-enforcing them contradicts
    // A11. Rebinding is instead contained by: monotonic allocation (never
    // reused), duplicate-binding fork refusal at reserve, digest-validated
    // reservation records, and commit-time identity checks (reservation +
    // sealed + operation + active-result generation/binding agreement).
    void 0;
    let landing = null;
    let sessionCitations = 0;
    if (n.session && operation && sealed) {
      // Regime-2 digest-proven payload bytes (A09H/A10 §20): the landed
      // payload text is the WITHOUT-identity checkpoint bytes whose sha256
      // equals checkpointContentDigest -- never the full canonical sealed
      // bytes (which self-carry the digest).
      let payloadText = null;
      try {
        payloadText = shadowV2.checkpointPayloadTextOf(sealed.checkpoint);
      } catch {
        failRuntime('generation-runtime-corrupt: checkpoint payload unproven at generation ' + generation);
      }
      landing = landingStatusOfV2(operation, n.session, payloadText);
    } else if (n.session && !operation) {
      sessionCitations = generationCitationsOf(n.session, generation).length;
    }
    perGeneration.set(generation, {
      generation,
      reservation,
      supersession,
      sealed: sealed ? sealed.checkpoint : null,
      operation,
      landing,
      sessionCitations,
    });
  }

  const committedHead = head && head.latestCommittedGeneration !== null && head.latestCommittedGeneration !== undefined
    ? { generation: head.latestCommittedGeneration, checkpointId: head.latestCommittedCheckpointId }
    : null;

  const committedLineage = new Set(head ? head.lineage.map((e) => Number(e.generation)) : []);
  // Every lineage entry must resolve to immutable durable evidence: a head
  // that cites a generation without a checkpoint/operation is corrupt.
  if (head) {
    for (const entry of head.lineage) {
      const ev = perGeneration.get(entry.generation);
      if (!ev || !ev.sealed || ev.sealed.checkpointId !== entry.checkpointId) {
        failRuntime('generation-runtime-corrupt: committed lineage G' + entry.generation + ' has no matching durable checkpoint');
      }
      if (!ev.operation) {
        failRuntime('generation-runtime-corrupt: committed lineage G' + entry.generation + ' has no durable operation');
      }
      if (ev.supersession) {
        failRuntime('generation-runtime-corrupt: committed lineage G' + entry.generation + ' is marked superseded');
      }
    }
    for (const entry of head.superseded) {
      const ev = perGeneration.get(entry.generation);
      if (!ev || !ev.supersession) {
        failRuntime('generation-runtime-corrupt: superseded index G' + entry.generation + ' has no matching durable marker');
      }
      if (ev.supersession.supersessionDigest !== entry.supersessionDigest) {
        failRuntime('generation-runtime-fork: superseded index G' + entry.generation + ' conflicts with the durable marker');
      }
    }
  }
  const classified = new Map();
  for (const [generation, evidence] of perGeneration) {
    classified.set(generation, classifyGenerationV2({
      generation,
      reservation: evidence.reservation,
      supersession: evidence.supersession,
      sealed: evidence.sealed ? { checkpoint: evidence.sealed } : null,
      operation: evidence.operation,
      landing: evidence.landing,
      sessionCitations: evidence.sessionCitations,
      committedHead,
      committedLineage,
    }));
  }

  // Committed-head validation: the claimed head must correspond to a valid
  // durable checkpoint + matching operation + matching generation + correct
  // identity + valid lineage. Any mismatch FAILS CLOSED (never silently
  // rolled back: only the provable forward repair below may move the head).
  if (committedHead) {
    const headEvidence = perGeneration.get(committedHead.generation);
    if (!headEvidence || !headEvidence.sealed) {
      failRuntime('generation-runtime-corrupt: committed head G' + committedHead.generation + ' has no durable checkpoint');
    }
    if (headEvidence.sealed.checkpointId !== committedHead.checkpointId) {
      failRuntime('generation-runtime-corrupt: committed head checkpoint id mismatches G' + committedHead.generation);
    }
    if (!headEvidence.operation) {
      failRuntime('generation-runtime-corrupt: committed head G' + committedHead.generation + ' has no durable operation');
    }
    if (headEvidence.supersession) {
      failRuntime('generation-runtime-corrupt: committed head G' + committedHead.generation + ' is marked superseded');
    }
    if (n.session && headEvidence.landing && !headEvidence.landing.allLanded) {
      failRuntime('generation-runtime-corrupt: committed head G' + committedHead.generation + ' has incomplete application');
    }
    const lineageEntry = head.lineage.filter((e) => e.generation === committedHead.generation)[0];
    if (!lineageEntry || lineageEntry.checkpointId !== committedHead.checkpointId) {
      failRuntime('generation-runtime-corrupt: committed head G' + committedHead.generation + ' lineage is inconsistent');
    }
  }

  // Linear committed lineage: every committed generation's parent must equal
  // the previous committed head (skipped superseded generations supported).
  // Two competing committed heads from one parent are a fork: FAIL CLOSED.
  const committedGens = [];
  for (const [generation, cls] of classified) {
    if (cls.outcome === 'COMMITTED') committedGens.push(generation);
  }
  committedGens.sort((a, b) => a - b);
  let previousCheckpointId = null;
  let previousGeneration = 0;
  for (const generation of committedGens) {
    const evidence = perGeneration.get(generation);
    const parentId = evidence.sealed ? evidence.sealed.parentCheckpointId : null;
    if (previousCheckpointId === null) {
      if (generation !== 1 && committedGens[0] === generation && committedHead === null) {
        // No head yet (pre-head history): the earliest committed generation
        // must still anchor at G1 rules when it IS G1; otherwise its parent
        // must resolve to an older committed checkpoint or null only for G1.
        if (generation !== 1 && parentId === null) {
          failRuntime('generation-runtime-corrupt: committed G' + generation + ' has no parent and no older committed lineage');
        }
      }
      if (generation === 1 && parentId !== null) {
        failRuntime('generation-runtime-corrupt: committed G1 must carry parentCheckpointId=null');
      }
    } else {
      if (parentId !== previousCheckpointId) {
        failRuntime('generation-runtime-fork: committed G' + generation + ' parent mismatches the committed lineage head');
      }
    }
    if (generation <= previousGeneration) {
      failRuntime('generation-runtime-fork: non-monotonic committed lineage');
    }
    previousCheckpointId = evidence.sealed ? evidence.sealed.checkpointId : previousCheckpointId;
    previousGeneration = generation;
  }

  // A12 §12-13 commit-before-head recovery (rigorous, never heuristic):
  // fully-landed-but-head-missing generations (commit-pending-verification)
  // are re-verified here against the RESTORED authoritative session only.
  // Required evidence chain: durable sealed checkpoint + durable operation
  // (identity/digest-bound, checked above) + clean all-landed landing
  // re-computed verbatim from the restored session + valid parent lineage.
  // Without the session the candidate stays UNRESOLVED and repair is
  // deferred (head-repair-pending). With the session + clean evidence the
  // repair writes the head and records deterministic recovered-completion
  // evidence (see buildRecoveredCompletionV2); only then may the head
  // advance. Corrupt/foreign/ambiguous landing fails closed.
  const sessionPresent = n.session !== undefined && n.session !== null;
  const commitPendingGens = [];
  for (const [generation, cls] of classified) {
    if (cls.commitPending === true) {
      const ev = perGeneration.get(generation);
      if (!ev || !ev.sealed || !ev.operation) {
        failRuntime('generation-head-conflict: commit-pending generation ' + generation + ' lacks durable checkpoint/operation');
      }
      if (ev.supersession) {
        failRuntime('generation-runtime-corrupt: commit-pending generation ' + generation + ' is marked superseded');
      }
      if (!ev.landing || !ev.landing.allLanded || ev.landing.foreign) {
        failRuntime('generation-head-conflict: commit-pending generation ' + generation + ' landing is not clean');
      }
      commitPendingGens.push(generation);
    }
  }
  commitPendingGens.sort((a, b) => a - b);
  // A commit-pending candidate older than (or equal to) the claimed head is
  // contradictory evidence: fail closed, never silently rewind or fork.
  const headGenPre = committedHead ? committedHead.generation : 0;
  for (const generation of commitPendingGens) {
    if (Number(generation) <= Number(headGenPre)) {
      failRuntime('generation-head-conflict: commit-pending generation ' + generation + ' contradicts the committed head');
    }
  }
  let repairedHead = false;
  let reconstructionOutcome = 'steady';
  let recoveredCompletion = null;
  if (commitPendingGens.length > 0 && !sessionPresent) {
    reconstructionOutcome = 'head-repair-pending';
  }
  const newestLanded = committedGens.length > 0 ? committedGens[committedGens.length - 1] : 0;
  const headGen = committedHead ? committedHead.generation : 0;
  if (newestLanded > headGen) {
    const candidate = perGeneration.get(newestLanded);
    const candidateClass = classified.get(newestLanded);
    if (candidateClass.outcome === 'COMMITTED' && candidate.sealed && candidate.operation) {
      if (!repairHead) {
        reconstructionOutcome = 'head-repair-pending';
      } else {
        const lineage = [];
        for (const generation of committedGens) {
          const ev = perGeneration.get(generation);
          lineage.push({
            generation,
            checkpointId: ev.sealed.checkpointId,
            parentCheckpointId: ev.sealed.parentCheckpointId,
          });
        }
        const superseded = [];
        for (const [generation, cls] of classified) {
          if (cls.outcome === 'SUPERSEDED') {
            const ev = perGeneration.get(generation);
            superseded.push({
              generation,
              checkpointId: ev.supersession.checkpointId,
              supersessionDigest: ev.supersession.supersessionDigest,
            });
          }
        }
        superseded.sort((a, b) => a.generation - b.generation);
        const repaired = {
          schemaVersion: GENERATION_RUNTIME_SCHEMA_VERSION,
          taskId: n.taskId,
          taskInstanceId: n.taskInstanceId,
          sessionId: n.sessionId,
          highestAllocatedGeneration: Math.max(headHighest, newestLanded),
          latestCommittedGeneration: newestLanded,
          latestCommittedCheckpointId: candidate.sealed.checkpointId,
          lineage,
          superseded,
          headDigest: null,
        };
        repaired.headDigest = deriveRuntimeDigestV2(repaired);
        writeHeadV2(n.runtimeDir, repaired);
        head = repaired;
        repairedHead = true;
        reconstructionOutcome = 'repaired-commit-before-head-crash';
      }
    } else {
      failRuntime('generation-head-conflict: durable evidence newer than the committed head is not a clean commit candidate');
    }
  }

  // A12 verified commit-pending repair: advance the head over clean,
  // session-verified commit-pending generations (parent chain validated).
  // Without the session this block never runs (deferred above); with
  // repairHead:false (inspect/commit paths) it reports pending only.
  if (commitPendingGens.length > 0 && sessionPresent) {
    // Parent-chain validation: each candidate's parent must equal the
    // previous committed checkpoint (head lineage first, then repaired
    // candidates in order). Skipped superseded generations are supported
    // (their checkpoints are simply absent from the chain).
    let expectedParent = committedHead ? committedHead.checkpointId : null;
    const chainOk = commitPendingGens.every((generation) => {
      const ev = perGeneration.get(generation);
      const parentId = ev.sealed.parentCheckpointId;
      if (expectedParent === null || expectedParent === undefined) {
        if (generation === 1) return parentId === null;
        // No committed lineage yet: a repaired candidate must either anchor
        // at null (first-ever commit) or descend from a provably committed
        // older candidate; a non-null parent with no committed lineage is
        // unprovable -> chain broken.
        if (parentId === null) return true;
        return false;
      }
      return parentId === expectedParent;
    }) && (() => {
      // Sequentially advance the expectation across the candidate chain.
      let parent = committedHead ? committedHead.checkpointId : null;
      for (const generation of commitPendingGens) {
        const ev = perGeneration.get(generation);
        if (parent !== null && parent !== undefined && ev.sealed.parentCheckpointId !== parent) return false;
        if ((parent === null || parent === undefined) && generation !== 1 && ev.sealed.parentCheckpointId !== null && commitPendingGens.indexOf(generation) === 0) return false;
        parent = ev.sealed.checkpointId;
      }
      return true;
    })();
    if (!chainOk) {
      failRuntime('generation-head-conflict: commit-pending parent lineage is unprovable');
    }
    if (!repairHead) {
      if (reconstructionOutcome === 'steady') reconstructionOutcome = 'head-repair-pending';
    } else {
      const repairedLineageGens = [];
      for (const [generation, cls] of classified) {
        if (cls.outcome === 'COMMITTED') repairedLineageGens.push(generation);
      }
      for (const generation of commitPendingGens) repairedLineageGens.push(generation);
      repairedLineageGens.sort((a, b) => a - b);
      const lineage = [];
      for (const generation of repairedLineageGens) {
        const ev = perGeneration.get(generation);
        lineage.push({
          generation,
          checkpointId: ev.sealed.checkpointId,
          parentCheckpointId: ev.sealed.parentCheckpointId,
        });
      }
      const superseded = [];
      for (const [generation, cls] of classified) {
        if (cls.outcome === 'SUPERSEDED') {
          const ev = perGeneration.get(generation);
          superseded.push({
            generation,
            checkpointId: ev.supersession.checkpointId,
            supersessionDigest: ev.supersession.supersessionDigest,
          });
        }
      }
      superseded.sort((a, b) => a.generation - b.generation);
      const newestRepaired = commitPendingGens[commitPendingGens.length - 1];
      const newestEv = perGeneration.get(newestRepaired);
      const repaired = {
        schemaVersion: GENERATION_RUNTIME_SCHEMA_VERSION,
        taskId: n.taskId,
        taskInstanceId: n.taskInstanceId,
        sessionId: n.sessionId,
        highestAllocatedGeneration: Math.max(headHighest, newestRepaired),
        latestCommittedGeneration: newestRepaired,
        latestCommittedCheckpointId: newestEv.sealed.checkpointId,
        lineage,
        superseded,
        headDigest: null,
      };
      repaired.headDigest = deriveRuntimeDigestV2(repaired);
      writeHeadV2(n.runtimeDir, repaired);
      head = repaired;
      repairedHead = true;
      reconstructionOutcome = 'repaired-commit-before-head-crash';
      // Promote the repaired candidates so the returned state converges:
      // they are COMMITTED history with the head advanced.
      for (const generation of commitPendingGens) {
        const cls = classified.get(generation);
        cls.outcome = 'COMMITTED';
        cls.activeState = null;
        cls.headAdvanced = true;
        delete cls.commitPending;
      }
      recoveredCompletion = buildRecoveredCompletionV2(perGeneration.get(newestRepaired), newestRepaired);
    }
  }

  const highestAllocated = Math.max(
    headHighest,
    allGens.length > 0 ? allGens[allGens.length - 1] : 0
  );
  const latestCommitted = head && head.latestCommittedGeneration !== null && head.latestCommittedGeneration !== undefined
    ? head.latestCommittedGeneration : (repairedHead ? newestLanded : headGen);
  const latestCheckpointId = head && head.latestCommittedCheckpointId !== null && head.latestCommittedCheckpointId !== undefined
    ? head.latestCommittedCheckpointId : null;

  // Active generation: the single non-terminal generation, if any. More than
  // one is a fork: FAIL CLOSED (never heuristically choose).
  const activeCandidates = [];
  for (const [generation, cls] of classified) {
    if (cls.outcome === 'RESERVED' || cls.outcome === 'UNRESOLVED') activeCandidates.push(generation);
  }
  activeCandidates.sort((a, b) => a - b);
  if (activeCandidates.length > 1) {
    failRuntime('generation-runtime-fork: multiple non-terminal generations (' + activeCandidates.join(',') + ')');
  }
  const activeGeneration = activeCandidates.length === 1 ? activeCandidates[0] : null;
  const activeGenerationState = activeGeneration !== null ? classified.get(activeGeneration).activeState : null;

  let unresolvedGeneration = null;
  for (const [generation, cls] of classified) {
    if (cls.outcome === 'UNRESOLVED') { unresolvedGeneration = generation; break; }
  }

  let supersededGenerationCount = 0;
  for (const cls of classified.values()) if (cls.outcome === 'SUPERSEDED') supersededGenerationCount += 1;

  const generations = allGens.map((generation) => {
    const cls = classified.get(generation);
    return {
      generation,
      outcome: cls.outcome,
      activeState: cls.activeState,
      checkpointId: cls.checkpointId,
      operationId: cls.operationId,
      parentCheckpointId: cls.parentCheckpointId,
    };
  });

  const parentCheckpointId = latestCheckpointId;
  const state = {
    schemaVersion: GENERATION_RUNTIME_SCHEMA_VERSION,
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    highestAllocatedGeneration: highestAllocated,
    latestCommittedGeneration: latestCommitted === 0 ? null : latestCommitted,
    latestCommittedCheckpointId: latestCheckpointId,
    activeGeneration,
    activeGenerationState,
    parentCheckpointId,
    generations,
    supersededGenerationCount,
    unresolvedGeneration,
    reconstructionOutcome,
    repairedHead,
    recoveredCompletion,
    blockerCodes: unresolvedGeneration !== null ? ['generation-unresolved-operation'] : [],
  };
  return Object.freeze(state);
}

// Read-only inspection: reconstruct without head repair and without locks.
function inspectGenerationRuntimeV2(rawInput) {
  return reconstructGenerationRuntimeV2(Object.assign({}, rawInput, { repairHead: false }));
}

// ---- reservation ---------------------------------------------------------------------

function normalizeReserveInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) failRuntime('generation-runtime-unavailable: input is required');
  const unknown = unknownKeyOf(rawInput, RESERVE_INPUT_EXACT_KEYS);
  if (unknown !== null) failRuntime('generation-runtime-unavailable: unknown field ' + unknown);
  if (Number(rawInput.schemaVersion) !== GENERATION_RUNTIME_SCHEMA_VERSION) failRuntime('generation-runtime-unavailable: schemaVersion must be 1');
  if (!isBoundedId(rawInput.taskId, GENERATION_ID_BOUNDS.taskId)) failRuntime('generation-runtime-unavailable: taskId is required');
  if (!isBoundedId(rawInput.taskInstanceId, GENERATION_ID_BOUNDS.taskInstanceId)) failRuntime('generation-runtime-unavailable: taskInstanceId is required');
  if (!isBoundedId(rawInput.sessionId, GENERATION_ID_BOUNDS.sessionId)) failRuntime('generation-runtime-unavailable: sessionId is required');
  for (const key of ['runtimeDir', 'checkpointDir', 'operationRoot', 'lockWorkspace']) {
    if (typeof rawInput[key] !== 'string' || rawInput[key] === '') failRuntime('generation-runtime-unavailable: ' + key + ' is required');
  }
  if (!isDigest(rawInput.revisionDigest)) failRuntime('generation-runtime-unavailable: revisionDigest must be sha256 hex');
  if (rawInput.snapshotTokenId !== null && rawInput.snapshotTokenId !== undefined
    && (typeof rawInput.snapshotTokenId !== 'string' || rawInput.snapshotTokenId === '')) {
    failRuntime('generation-runtime-unavailable: snapshotTokenId must be a non-empty string');
  }
  if (!Number.isInteger(rawInput.safePointBoundarySeq) || rawInput.safePointBoundarySeq < 0) {
    failRuntime('generation-runtime-unavailable: safePointBoundarySeq must be a non-negative integer');
  }
  // Optional session evidence: when supplied, reconstruction classifies
  // landing state (UNRESOLVED blocks; fully-landed repairs). Without it, the
  // active-reservation conflict still prevents newer allocation, but partial
  // application is invisible: callers that may have mutated MUST supply it.
  if (rawInput.session !== undefined && rawInput.session !== null && typeof rawInput.session !== 'object') {
    failRuntime('generation-runtime-unavailable: session must be an object');
  }
  if (!rawInput.serialization || typeof rawInput.serialization !== 'object') {
    failRuntime('generation-runtime-unavailable: serialization client is required');
  }
  return rawInput;
}

function bindingsEqual(a, b) {
  return a.revisionDigest === b.revisionDigest
    && Number(a.safePointBoundarySeq) === Number(b.safePointBoundarySeq)
    && (a.snapshotTokenId === undefined || b.snapshotTokenId === undefined || a.snapshotTokenId === null || b.snapshotTokenId === null || a.snapshotTokenId === b.snapshotTokenId);
}

async function reserveNextGenerationV2(rawInput) {
  const n = normalizeReserveInput(rawInput);
  const serialKey = String(n.sessionId);
  return runSerializedGeneration(serialKey, () => withGenerationLockV2(
    n.serialization,
    generationLockCallOf(n.taskId, n.taskInstanceId, n.sessionId, n.lockWorkspace),
    async () => executeReserveCritical(n)
  ));
}

function executeReserveCritical(n) {
  // A12: reconstruct WITHOUT repair. The reserve path never heals the head:
  // a fully-landed-but-head-missing generation may be landed-yet-unflushed
  // (flush ambiguity), and segment presence alone never authorizes the
  // head. A pending generation blocks newer allocation (refuse/retry); it
  // reaches terminal state only through the entry (A10 forward recovery,
  // re-flush + re-verify) followed by explicit commit. Explicit restart
  // recovery uses reconstruct with repairHead:true under its documented
  // restored-session precondition.
  const runtime = reconstructGenerationRuntimeV2({
    schemaVersion: 1,
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    runtimeDir: n.runtimeDir,
    checkpointDir: n.checkpointDir,
    operationRoot: n.operationRoot,
    session: n.session === undefined ? null : n.session,
    repairHead: false,
  });
  if (runtime.unresolvedGeneration !== null) {
    failRuntime('generation-unresolved-operation: generation ' + runtime.unresolvedGeneration + ' must reconcile before a newer generation may proceed');
  }
  if (runtime.activeGeneration !== null) {
    const existing = readReservationV2(n.runtimeDir, runtime.activeGeneration, n);
    const candidateBinding = {
      revisionDigest: n.revisionDigest,
      safePointBoundarySeq: n.safePointBoundarySeq,
      snapshotTokenId: n.snapshotTokenId === undefined ? null : n.snapshotTokenId,
    };
    const existingBinding = {
      revisionDigest: existing.revisionDigest,
      safePointBoundarySeq: existing.safePointBoundarySeq,
      snapshotTokenId: existing.snapshotTokenId,
    };
    if (bindingsEqual(candidateBinding, existingBinding)) {
      return Object.freeze(JSON.parse(JSON.stringify(existing)));
    }
    failRuntime('generation-reservation-conflict: generation ' + runtime.activeGeneration + ' is already active for different source state (supersede or commit it first)');
  }
  const next = runtime.highestAllocatedGeneration + 1;
  const parentId = runtime.latestCommittedCheckpointId;
  if (next === 1 && parentId !== null) {
    failRuntime('generation-runtime-corrupt: first generation must carry parentCheckpointId=null');
  }
  if (next > 1 && (parentId === null || parentId === undefined)) {
    // No committed lineage yet but generations were allocated before (all
    // superseded): the parent is still null only when NOTHING ever
    // committed. That is valid: G1 superseded, G2 reserves with null parent.
    // The checkpoint builder still requires parent for G>1, so the A09 layer
    // for such a generation must either commit G1 first or fail closed there.
    // A11 records the true lineage (null) and never invents a parent.
  }
  const reservation = {
    schemaVersion: GENERATION_RUNTIME_SCHEMA_VERSION,
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    generation: next,
    snapshotTokenId: n.snapshotTokenId === undefined ? null : n.snapshotTokenId,
    revisionDigest: n.revisionDigest,
    safePointBoundarySeq: n.safePointBoundarySeq,
    parentCommittedCheckpointId: parentId === undefined ? null : parentId,
    reservationDigest: null,
  };
  reservation.reservationDigest = deriveReservationDigestV2(reservation);
  const target = reservationFilePath(n.runtimeDir, next);
  if (fs.existsSync(target)) {
    const prior = readReservationV2(n.runtimeDir, next, n);
    if (prior.reservationDigest === reservation.reservationDigest) {
      return Object.freeze(JSON.parse(JSON.stringify(prior)));
    }
    failRuntime('generation-runtime-fork: duplicate generation reservation with different binding at G' + next);
  }
  persistJsonAtomic(target, reservation);
  const back = readReservationV2(n.runtimeDir, next, n);
  if (back.reservationDigest !== reservation.reservationDigest) {
    failRuntime('generation-runtime-unavailable: reservation read-back differs at G' + next);
  }
  // Highest-allocated tracking lives in the head index: advance it
  // deterministically (monotonic; never reused, never moved backward).
  advanceHighestAllocated(n, next);
  return Object.freeze(JSON.parse(JSON.stringify(back)));
}

function advanceHighestAllocated(n, next) {
  const target = runtimeFilePath(n.runtimeDir);
  const stored = readJsonFile(target);
  let head = stored;
  if (head === null) {
    head = {
      schemaVersion: GENERATION_RUNTIME_SCHEMA_VERSION,
      taskId: n.taskId,
      taskInstanceId: n.taskInstanceId,
      sessionId: n.sessionId,
      highestAllocatedGeneration: next,
      latestCommittedGeneration: null,
      latestCommittedCheckpointId: null,
      lineage: [],
      superseded: [],
      headDigest: null,
    };
  } else {
    const check = validateGenerationRuntimeV2(head);
    if (!check.valid) failRuntime(check.reason + ': stored runtime head is corrupt');
    if (head.taskId !== n.taskId || head.taskInstanceId !== n.taskInstanceId || head.sessionId !== n.sessionId) {
      failRuntime('generation-runtime-corrupt: stored head binds another task/session');
    }
    head = JSON.parse(JSON.stringify(head));
    if (head.highestAllocatedGeneration >= next) return Object.freeze(head);
    head.highestAllocatedGeneration = next;
  }
  head.headDigest = deriveRuntimeDigestV2(head);
  return writeHeadV2(n.runtimeDir, head);
}

// ---- commit advancement ------------------------------------------------------------------

function normalizeCommitInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) failRuntime('generation-runtime-unavailable: input is required');
  const unknown = unknownKeyOf(rawInput, COMMIT_INPUT_EXACT_KEYS);
  if (unknown !== null) failRuntime('generation-runtime-unavailable: unknown field ' + unknown);
  if (Number(rawInput.schemaVersion) !== GENERATION_RUNTIME_SCHEMA_VERSION) failRuntime('generation-runtime-unavailable: schemaVersion must be 1');
  if (!isBoundedId(rawInput.taskId, GENERATION_ID_BOUNDS.taskId)) failRuntime('generation-runtime-unavailable: taskId is required');
  if (!isBoundedId(rawInput.taskInstanceId, GENERATION_ID_BOUNDS.taskInstanceId)) failRuntime('generation-runtime-unavailable: taskInstanceId is required');
  if (!isBoundedId(rawInput.sessionId, GENERATION_ID_BOUNDS.sessionId)) failRuntime('generation-runtime-unavailable: sessionId is required');
  for (const key of ['runtimeDir', 'checkpointDir', 'operationRoot', 'lockWorkspace']) {
    if (typeof rawInput[key] !== 'string' || rawInput[key] === '') failRuntime('generation-runtime-unavailable: ' + key + ' is required');
  }
  if (!Number.isInteger(rawInput.generation) || rawInput.generation < 1) failRuntime('generation-runtime-unavailable: generation must be a positive integer');
  if (!rawInput.activeResult || typeof rawInput.activeResult !== 'object') failRuntime('generation-runtime-unavailable: activeResult is required');
  if (rawInput.postApplyVerified !== true) failRuntime('generation-runtime-unavailable: post-apply projection verification is required before head advancement');
  if (rawInput.session !== undefined && rawInput.session !== null && typeof rawInput.session !== 'object') {
    failRuntime('generation-runtime-unavailable: session must be an object');
  }
  if (!rawInput.serialization || typeof rawInput.serialization !== 'object') {
    failRuntime('generation-runtime-unavailable: serialization client is required');
  }
  return rawInput;
}

// A generation becomes current/committed ONLY after A10 proves durability:
// status committed (or valid recovered completion), applicationDurable true,
// and post-apply projection verified. Head advancement is atomic + read-back
// validated + idempotent (repeated advancement converges on the same head).
async function commitGenerationV2(rawInput) {
  const n = normalizeCommitInput(rawInput);
  const serialKey = String(n.sessionId);
  return runSerializedGeneration(serialKey, () => withGenerationLockV2(
    n.serialization,
    generationLockCallOf(n.taskId, n.taskInstanceId, n.sessionId, n.lockWorkspace),
    async () => executeCommitCritical(n)
  ));
}

function executeCommitCritical(n) {
  let activeModule = null;
  try {
    activeModule = require('./ContextActiveApplyV2.cjs');
  } catch (error) {
    failRuntime('generation-runtime-unavailable: A10 authority is unavailable (' + String((error && error.message) || error).slice(0, 200) + ')');
  }
  const resultCheck = activeModule.validateActiveResultV2(n.activeResult);
  if (!resultCheck.valid) failRuntime('generation-runtime-corrupt: active result is invalid (' + resultCheck.reason + ')');
  const result = n.activeResult;
  if (result.taskId !== n.taskId || result.taskInstanceId !== n.taskInstanceId || result.sessionId !== n.sessionId) {
    failRuntime('generation-runtime-corrupt: active result binds another task/session');
  }
  if (Number(result.generation) !== Number(n.generation)) {
    failRuntime('generation-parent-mismatch: active result binds generation ' + result.generation + ' (expected ' + n.generation + ')');
  }
  if (result.status !== 'committed' && result.status !== 'recovered') {
    failRuntime('generation-not-active: active result status ' + result.status + ' cannot advance the committed head');
  }
  if (result.applicationDurable !== true) {
    failRuntime('generation-not-active: application durability is required before head advancement');
  }
  const runtime = reconstructGenerationRuntimeV2({
    schemaVersion: 1,
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    runtimeDir: n.runtimeDir,
    checkpointDir: n.checkpointDir,
    operationRoot: n.operationRoot,
    session: n.session === undefined ? null : n.session,
    repairHead: false,
  });
  const superseded = readSupersessionV2(n.runtimeDir, n.generation, null);
  if (superseded) failRuntime('generation-cannot-supersede: generation ' + n.generation + ' is superseded and can never commit');
  if (runtime.latestCommittedGeneration !== null && runtime.latestCommittedGeneration !== undefined
    && Number(n.generation) <= Number(runtime.latestCommittedGeneration)) {
    // Idempotent reconvergence: the head already reflects this (or a newer)
    // generation. A newer head with a different checkpoint is a fork signal,
    // never silently accepted.
    if (Number(n.generation) === Number(runtime.latestCommittedGeneration)) {
      if (runtime.latestCommittedCheckpointId !== result.checkpointId) {
        failRuntime('generation-head-conflict: committed head checkpoint mismatches the proven result');
      }
      return inspectGenerationRuntimeV2({
        schemaVersion: 1,
        taskId: n.taskId,
        taskInstanceId: n.taskInstanceId,
        sessionId: n.sessionId,
        runtimeDir: n.runtimeDir,
        checkpointDir: n.checkpointDir,
        operationRoot: n.operationRoot,
        session: n.session === undefined ? null : n.session,
      });
    }
    failRuntime('generation-already-committed: generation ' + n.generation + ' is older than the committed head');
  }
  const reservation = readReservationV2(n.runtimeDir, n.generation, n);
  if (!reservation) failRuntime('generation-not-active: generation ' + n.generation + ' was never allocated');
  const sealedStored = readSealedEvidence(n.checkpointDir, n.generation);
  if (!sealedStored) failRuntime('generation-runtime-corrupt: generation ' + n.generation + ' has no durable checkpoint');
  if (sealedStored.checkpoint.checkpointId !== result.checkpointId) {
    failRuntime('generation-runtime-corrupt: sealed checkpoint mismatches the proven result at G' + n.generation);
  }
  const operation = readOperationEvidence(n.operationRoot, n.generation);
  if (!operation) failRuntime('generation-runtime-corrupt: generation ' + n.generation + ' has no durable operation');
  if (operation.operationId !== result.operationId) {
    failRuntime('generation-runtime-corrupt: operation mismatches the proven result at G' + n.generation);
  }
  // Parent lineage rule: the new checkpoint must descend from the latest
  // committed checkpoint (NOT blindly generation - 1).
  const expectedParent = runtime.latestCommittedCheckpointId;
  const actualParent = sealedStored.checkpoint.parentCheckpointId;
  if (Number(n.generation) === 1) {
    if (actualParent !== null) failRuntime('generation-parent-mismatch: G1 must carry parentCheckpointId=null');
  } else if (expectedParent === null || expectedParent === undefined) {
    if (actualParent !== null && actualParent !== undefined) {
      failRuntime('generation-parent-mismatch: no committed lineage exists but G' + n.generation + ' claims a parent');
    }
  } else if (actualParent !== expectedParent) {
    failRuntime('generation-parent-mismatch: G' + n.generation + ' parent must be the latest committed checkpoint');
  }
  // Independent landing proof when the session is supplied: the head must
  // never advance before the active projection is durably committed.
  if (n.session !== undefined && n.session !== null) {
    let payloadText = null;
    try {
      payloadText = shadowV2.checkpointPayloadTextOf(sealedStored.checkpoint);
    } catch {
      failRuntime('generation-runtime-corrupt: checkpoint payload unproven at G' + n.generation);
    }
    const landing = landingStatusOfV2(operation, n.session, payloadText);
    if (!landing.allLanded || landing.foreign) {
      failRuntime('generation-not-active: G' + n.generation + ' active projection is not durably committed');
    }
  }
  const stored = readJsonFile(runtimeFilePath(n.runtimeDir));
  const lineage = stored ? JSON.parse(JSON.stringify(stored.lineage)) : [];
  if (!lineage.some((e) => e.generation === n.generation)) {
    lineage.push({
      generation: n.generation,
      checkpointId: sealedStored.checkpoint.checkpointId,
      parentCheckpointId: sealedStored.checkpoint.parentCheckpointId,
    });
    lineage.sort((a, b) => a.generation - b.generation);
  }
  const supersededList = stored ? JSON.parse(JSON.stringify(stored.superseded)) : [];
  const highest = Math.max(stored ? stored.highestAllocatedGeneration : 0, n.generation);
  const next = {
    schemaVersion: GENERATION_RUNTIME_SCHEMA_VERSION,
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    highestAllocatedGeneration: highest,
    latestCommittedGeneration: n.generation,
    latestCommittedCheckpointId: sealedStored.checkpoint.checkpointId,
    lineage,
    superseded: supersededList,
    headDigest: null,
  };
  next.headDigest = deriveRuntimeDigestV2(next);
  writeHeadV2(n.runtimeDir, next);
  return inspectGenerationRuntimeV2({
    schemaVersion: 1,
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    runtimeDir: n.runtimeDir,
    checkpointDir: n.checkpointDir,
    operationRoot: n.operationRoot,
    session: n.session === undefined ? null : n.session,
  });
}

// ---- supersession ------------------------------------------------------------------------

function normalizeSupersedeInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) failRuntime('generation-runtime-unavailable: input is required');
  const unknown = unknownKeyOf(rawInput, SUPERSEDE_INPUT_EXACT_KEYS);
  if (unknown !== null) failRuntime('generation-runtime-unavailable: unknown field ' + unknown);
  if (Number(rawInput.schemaVersion) !== GENERATION_RUNTIME_SCHEMA_VERSION) failRuntime('generation-runtime-unavailable: schemaVersion must be 1');
  if (!isBoundedId(rawInput.taskId, GENERATION_ID_BOUNDS.taskId)) failRuntime('generation-runtime-unavailable: taskId is required');
  if (!isBoundedId(rawInput.taskInstanceId, GENERATION_ID_BOUNDS.taskInstanceId)) failRuntime('generation-runtime-unavailable: taskInstanceId is required');
  if (!isBoundedId(rawInput.sessionId, GENERATION_ID_BOUNDS.sessionId)) failRuntime('generation-runtime-unavailable: sessionId is required');
  for (const key of ['runtimeDir', 'checkpointDir', 'operationRoot', 'lockWorkspace']) {
    if (typeof rawInput[key] !== 'string' || rawInput[key] === '') failRuntime('generation-runtime-unavailable: ' + key + ' is required');
  }
  if (!Number.isInteger(rawInput.generation) || rawInput.generation < 1) failRuntime('generation-runtime-unavailable: generation must be a positive integer');
  if (!isDigest(rawInput.observedRevisionDigest)) failRuntime('generation-runtime-unavailable: observedRevisionDigest must be sha256 hex');
  if (rawInput.observedSafePointBoundarySeq !== undefined && rawInput.observedSafePointBoundarySeq !== null
    && (!Number.isInteger(rawInput.observedSafePointBoundarySeq) || rawInput.observedSafePointBoundarySeq < 0)) {
    failRuntime('generation-runtime-unavailable: observedSafePointBoundarySeq must be a non-negative integer');
  }
  if (rawInput.payloadText !== undefined && rawInput.payloadText !== null && typeof rawInput.payloadText !== 'string') {
    failRuntime('generation-runtime-unavailable: payloadText must be a string');
  }
  if (rawInput.session !== undefined && rawInput.session !== null && typeof rawInput.session !== 'object') {
    failRuntime('generation-runtime-unavailable: session must be an object');
  }
  if (!rawInput.serialization || typeof rawInput.serialization !== 'object') {
    failRuntime('generation-runtime-unavailable: serialization client is required');
  }
  return rawInput;
}

// Safe abandoned-intent supersession: a generation may become SUPERSEDED only
// after proving (a) it never committed, (b) zero compaction segments landed
// (no payload, no anchor, no partial multi-segment application, no ambiguous
// state), and (c) its source binding is stale. G2 artifacts remain immutable
// historical evidence: NOTHING is deleted.
async function supersedeGenerationV2(rawInput) {
  const n = normalizeSupersedeInput(rawInput);
  const serialKey = String(n.sessionId);
  return runSerializedGeneration(serialKey, () => withGenerationLockV2(
    n.serialization,
    generationLockCallOf(n.taskId, n.taskInstanceId, n.sessionId, n.lockWorkspace),
    async () => executeSupersedeCritical(n)
  ));
}

function executeSupersedeCritical(n) {
  const runtime = reconstructGenerationRuntimeV2({
    schemaVersion: 1,
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    runtimeDir: n.runtimeDir,
    checkpointDir: n.checkpointDir,
    operationRoot: n.operationRoot,
    session: n.session === undefined ? null : n.session,
    repairHead: false,
  });
  if (runtime.latestCommittedGeneration !== null && runtime.latestCommittedGeneration !== undefined
    && Number(n.generation) <= Number(runtime.latestCommittedGeneration)) {
    failRuntime('generation-cannot-supersede: generation ' + n.generation + ' is committed history and can never be superseded');
  }
  const existing = readSupersessionV2(n.runtimeDir, n.generation, null);
  if (existing) {
    // Terminal state is never re-decided: an identical observation converges
    // idempotently, but a DIFFERENT observation for an already-superseded
    // generation is a fork signal (two writers disagree about history).
    if (existing.observedRevisionDigest !== n.observedRevisionDigest) {
      failRuntime('generation-runtime-fork: conflicting supersession observations at G' + n.generation);
    }
    return inspectGenerationRuntimeV2({
      schemaVersion: 1,
      taskId: n.taskId,
      taskInstanceId: n.taskInstanceId,
      sessionId: n.sessionId,
      runtimeDir: n.runtimeDir,
      checkpointDir: n.checkpointDir,
      operationRoot: n.operationRoot,
      session: n.session === undefined ? null : n.session,
    });
  }
  const reservation = readReservationV2(n.runtimeDir, n.generation, n);
  if (!reservation) failRuntime('generation-not-active: generation ' + n.generation + ' was never allocated');
  if (Number(runtime.activeGeneration) !== Number(n.generation)) {
    failRuntime('generation-not-active: generation ' + n.generation + ' is not the active generation');
  }
  const sealedStored = readSealedEvidence(n.checkpointDir, n.generation);
  const operation = readOperationEvidence(n.operationRoot, n.generation);
  // Zero-landing proof (section 12): ANY landed payload, anchor, partial
  // multi-segment application, or ambiguous state REFUSES supersession and
  // requires A02/A10 reconciliation instead.
  if (operation) {
    if (typeof n.payloadText !== 'string' || n.payloadText === '') {
      failRuntime('generation-cannot-supersede: payload proof is required to supersede generation ' + n.generation);
    }
    if (!n.session) {
      failRuntime('generation-cannot-supersede: session evidence is required to supersede generation ' + n.generation);
    }
    const landing = landingStatusOfV2(operation, n.session, n.payloadText);
    if (landing.unproven) failRuntime('generation-cannot-supersede: payload proof is required to supersede generation ' + n.generation);
    if (landing.foreign || landing.anyLanded) {
      failRuntime('generation-cannot-supersede: generation ' + n.generation + ' shows landed or ambiguous application (reconcile first)');
    }
  } else if (n.session) {
    const citations = generationCitationsOf(n.session, n.generation);
    if (citations.length > 0) {
      failRuntime('generation-cannot-supersede: generation ' + n.generation + ' shows session citations (reconcile first)');
    }
  } else if (sealedStored) {
    // Checkpoint persisted but no operation and no session evidence supplied:
    // landing is unprovable, so supersession is refused (fail closed).
    failRuntime('generation-cannot-supersede: session evidence is required to supersede generation ' + n.generation);
  }
  // Staleness proof: the reservation binding must no longer describe current
  // source state. An unchanged source must recover the reservation, never
  // supersede it (no rebinding, no silent abandonment).
  const staleRevision = n.observedRevisionDigest !== reservation.revisionDigest;
  const staleBoundary = n.observedSafePointBoundarySeq !== undefined && n.observedSafePointBoundarySeq !== null
    && Number(n.observedSafePointBoundarySeq) !== Number(reservation.safePointBoundarySeq);
  if (!staleRevision && !staleBoundary) {
    failRuntime('generation-source-stale: generation ' + n.generation + ' source binding is unchanged (recover it instead of superseding)');
  }
  const marker = {
    schemaVersion: GENERATION_RUNTIME_SCHEMA_VERSION,
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    generation: n.generation,
    checkpointId: sealedStored ? sealedStored.checkpoint.checkpointId : null,
    operationId: operation ? operation.operationId : null,
    reservedRevisionDigest: reservation.revisionDigest,
    observedRevisionDigest: n.observedRevisionDigest,
    reason: staleRevision ? 'source-revision-changed' : 'safe-point-boundary-changed',
    supersessionDigest: null,
  };
  marker.supersessionDigest = deriveSupersessionDigestV2(marker);
  const target = supersessionFilePath(n.runtimeDir, n.generation);
  if (fs.existsSync(target)) {
    const prior = readSupersessionV2(n.runtimeDir, n.generation, n);
    if (prior.supersessionDigest !== marker.supersessionDigest) {
      failRuntime('generation-runtime-fork: conflicting supersession markers at G' + n.generation);
    }
  } else {
    persistJsonAtomic(target, marker);
    const back = readSupersessionV2(n.runtimeDir, n.generation, n);
    if (back.supersessionDigest !== marker.supersessionDigest) {
      failRuntime('generation-runtime-unavailable: supersession read-back differs at G' + n.generation);
    }
  }
  const stored = readJsonFile(runtimeFilePath(n.runtimeDir));
  const supersededList = stored ? JSON.parse(JSON.stringify(stored.superseded)) : [];
  if (!supersededList.some((e) => e.generation === n.generation)) {
    supersededList.push({
      generation: n.generation,
      checkpointId: marker.checkpointId,
      supersessionDigest: marker.supersessionDigest,
    });
    supersededList.sort((a, b) => a.generation - b.generation);
  }
  const next = {
    schemaVersion: GENERATION_RUNTIME_SCHEMA_VERSION,
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    highestAllocatedGeneration: Math.max(stored ? stored.highestAllocatedGeneration : 0, n.generation),
    latestCommittedGeneration: stored ? stored.latestCommittedGeneration : null,
    latestCommittedCheckpointId: stored ? stored.latestCommittedCheckpointId : null,
    lineage: stored ? stored.lineage : [],
    superseded: supersededList,
    headDigest: null,
  };
  next.headDigest = deriveRuntimeDigestV2(next);
  writeHeadV2(n.runtimeDir, next);
  return inspectGenerationRuntimeV2({
    schemaVersion: 1,
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    runtimeDir: n.runtimeDir,
    checkpointDir: n.checkpointDir,
    operationRoot: n.operationRoot,
    session: n.session === undefined ? null : n.session,
  });
}

// ---- A02/A10 integration guards ------------------------------------------------------
// A02 recovery must consult the supersession record BEFORE applying old
// zero-landing intent: a durably superseded generation is never applicable
// again, even after restart. A10 callers must consult generation eligibility
// BEFORE invoking the frozen active transaction.

function checkOperationSupersededV2(options) {
  const opts = options && typeof options === 'object' ? options : {};
  if (typeof opts.runtimeDir !== 'string' || opts.runtimeDir === '') {
    failRuntime('generation-runtime-unavailable: runtimeDir is required');
  }
  if (!opts.operation || typeof opts.operation !== 'object') failRuntime('generation-runtime-unavailable: operation is required');
  const generation = Number(opts.operation.checkpointGeneration);
  if (!Number.isInteger(generation) || generation < 1) failRuntime('generation-runtime-unavailable: operation generation is required');
  const marker = readSupersessionV2(opts.runtimeDir, generation, null);
  if (!marker) return { superseded: false, generation, reason: null };
  if (marker.operationId !== null && marker.operationId !== undefined
    && opts.operation.operationId !== marker.operationId) {
    failRuntime('generation-runtime-fork: supersession marker binds another operation at G' + generation);
  }
  return { superseded: true, generation, reason: 'generation-superseded', supersessionDigest: marker.supersessionDigest };
}

function assertGenerationEligibleForApplyV2(options) {
  const opts = options && typeof options === 'object' ? options : {};
  for (const key of ['runtimeDir', 'checkpointDir', 'operationRoot']) {
    if (typeof opts[key] !== 'string' || opts[key] === '') failRuntime('generation-runtime-unavailable: ' + key + ' is required');
  }
  if (!Number.isInteger(opts.generation) || opts.generation < 1) failRuntime('generation-runtime-unavailable: generation is required');
  const runtime = inspectGenerationRuntimeV2({
    schemaVersion: 1,
    taskId: opts.taskId,
    taskInstanceId: opts.taskInstanceId,
    sessionId: opts.sessionId,
    runtimeDir: opts.runtimeDir,
    checkpointDir: opts.checkpointDir,
    operationRoot: opts.operationRoot,
    session: opts.session === undefined ? null : opts.session,
  });
  const fail = (code, detail) => ({ eligible: false, code, detail, runtime });
  if (runtime.unresolvedGeneration !== null && Number(runtime.unresolvedGeneration) !== Number(opts.generation)) {
    return fail('generation-unresolved-operation', 'generation ' + runtime.unresolvedGeneration + ' must reconcile first');
  }
  const entry = runtime.generations.filter((g) => g.generation === opts.generation)[0];
  if (!entry) return fail('generation-not-active', 'generation ' + opts.generation + ' was never allocated');
  if (entry.outcome === 'SUPERSEDED') return fail('generation-cannot-supersede', 'generation ' + opts.generation + ' is superseded and must never apply');
  if (entry.outcome === 'COMMITTED' && runtime.latestCommittedGeneration === opts.generation) {
    return fail('generation-already-committed', 'generation ' + opts.generation + ' is already the committed head');
  }
  if (entry.outcome === 'COMMITTED') {
    // Fully landed but the head was never advanced (commit-before-head
    // crash): only idempotent A10 recovery of THIS generation may proceed
    // (it converges without new mutation); fresh application of any other
    // generation is still gated below.
    return { eligible: true, code: null, detail: 'commit-pending-recovery-only', runtime };
  }
  if (entry.outcome === 'UNRESOLVED') {
    // Same-generation commit-pending-verification proceeds as A10 forward
    // recovery (it converges without new mutation once re-verified); any
    // other generation stays blocked until the pending generation resolves.
    if (entry.activeState === 'commit-pending-verification') {
      return { eligible: true, code: null, detail: 'commit-pending-recovery-only', runtime };
    }
    return fail('generation-unresolved-operation', 'generation ' + opts.generation + ' requires reconciliation');
  }
  if (Number(runtime.activeGeneration) !== Number(opts.generation)) {
    return fail('generation-not-active', 'generation ' + opts.generation + ' is not the active generation');
  }
  if (opts.shadowResult && typeof opts.shadowResult === 'object' && Number(opts.shadowResult.generation) !== Number(opts.generation)) {
    return fail('generation-parent-mismatch', 'shadow result binds another generation');
  }
  return { eligible: true, code: null, detail: null, runtime };
}

// ---- telemetry ------------------------------------------------------------------
// Bounded facts only: ids, digests, bindings, statuses, counts. No raw task
// content, no prompt text, no tool output.

function generationTelemetryV2(runtime) {
  if (!runtime || typeof runtime !== 'object') failRuntime('generation-runtime-unavailable: runtime state is required');
  return Object.freeze({
    highestAllocatedGeneration: runtime.highestAllocatedGeneration,
    latestCommittedGeneration: runtime.latestCommittedGeneration,
    latestCommittedCheckpointId: runtime.latestCommittedCheckpointId,
    activeGeneration: runtime.activeGeneration,
    activeGenerationState: runtime.activeGenerationState,
    parentCheckpointId: runtime.parentCheckpointId,
    supersededGenerationCount: runtime.supersededGenerationCount,
    unresolvedGeneration: runtime.unresolvedGeneration,
    reconstructionOutcome: runtime.reconstructionOutcome,
    blockerCodes: Object.freeze((runtime.blockerCodes || []).slice()),
  });
}


// ---- A11H: generation-aware active entry ---------------------------------------
// applyCurrentGenerationV2 is the ONLY supported generation-aware active
// path. It performs, under ONE held cross-process lock acquisition:
//
//   reconstruct (WITHOUT repair: the apply path never heals the head;
//      commit-pending generations proceed to A10 forward recovery)
//   -> active-generation validation
//   -> supersession refusal (permanently non-applicable)
//   -> unresolved gating (other-generation unresolved blocks; same-generation
//      unresolved proceeds as A10 forward recovery, never fresh application)
//   -> reservation/source binding validation (no stale-reservation apply)
//   -> exactly one A10 invocation with reentrant lock attribution
//
// A10 remains the sole transactional primitive; A11 owns WHETHER a
// generation may use it. The final eligibility observation happens under
// the held lock, so a supersession that lands after an earlier read still
// refuses (stale pre-supersession handles can never apply).
//
// Locking discipline: the outer (generation) lock is acquired with the
// generation's own operation identity and HELD across the A10 call, while
// the in-process chain slot is released before invoking A10 (A10 owns its
// own inner chain; nesting the same per-session chain would deadlock).
// A10's acquire/renew/release calls pass through a reentrant attribution
// wrapper: same lock file, same owner token, no second CLI acquisition.
// A supersede/commit/reserve from any process (or thread) contends on the
// same lock and therefore cannot interleave the check->apply window.

const APPLY_CURRENT_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'runtimeDir',
  'checkpointDir',
  'operationRoot',
  'lockWorkspace',
  'request',
]);

const SNAPSHOT_PROTECTION_DIGEST_DOMAIN_V1 = 'nexus/context-snapshot-protection/v1';
const SNAPSHOT_PROTECTION_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'currentRuntimeSeq',
  'snapshots',
  'protectionDigest',
]);
const SNAPSHOT_ENTRY_EXACT_KEYS = Object.freeze(['seq', 'protection', 'reason']);

const RECONCILE_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'runtimeDir',
  'checkpointDir',
  'operationRoot',
  'generation',
  'session',
]);

const SNAPSHOT_PROTECTION_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'runtimeDir',
  'checkpointDir',
  'operationRoot',
  'session',
]);

function activeModuleOf() {
  try {
    return require('./ContextActiveApplyV2.cjs');
  } catch (error) {
    failRuntime('generation-runtime-unavailable: A10 authority is unavailable (' + String((error && error.message) || error).slice(0, 200) + ')');
  }
  return null;
}

// Reentrant attribution over a held cross-process lock: calls carrying the
// authorized operation identity reuse the held owner token (same file, same
// owner, no second acquisition); every other call delegates to the base
// client normally. Release of the held owner is swallowed (the outer entry
// owns the real release); foreign releases delegate.
function reentrantLockClientV2(base, held, allowedOperationId) {
  if (!base || typeof base.acquire !== 'function' || typeof base.renew !== 'function' || typeof base.release !== 'function') {
    failRuntime('generation-runtime-unavailable: base serialization client is required');
  }
  if (!held || typeof held.ownerId !== 'string' || held.ownerId === '') {
    failRuntime('generation-runtime-unavailable: held lock ownership is required');
  }
  const sameOperation = (call) => Boolean(call && typeof call === 'object' && call.operationId === allowedOperationId);
  async function acquire(call) {
    if (sameOperation(call)) {
      return { acquired: true, ownerId: held.ownerId, leaseSeconds: held.leaseSeconds, reason: null };
    }
    return base.acquire(call);
  }
  async function renew(call) {
    return base.renew(call);
  }
  async function release(call) {
    if (call && typeof call === 'object' && call.ownerId === held.ownerId) {
      return { released: true, reason: 'reentrant-held-by-generation-entry' };
    }
    return base.release(call);
  }
  return Object.freeze({ acquire, renew, release });
}

function normalizeApplyCurrentInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) failRuntime('generation-runtime-unavailable: input is required');
  const unknown = unknownKeyOf(rawInput, APPLY_CURRENT_INPUT_EXACT_KEYS);
  if (unknown !== null) failRuntime('generation-runtime-unavailable: unknown field ' + unknown);
  if (Number(rawInput.schemaVersion) !== GENERATION_RUNTIME_SCHEMA_VERSION) failRuntime('generation-runtime-unavailable: schemaVersion must be 1');
  if (!isBoundedId(rawInput.taskId, GENERATION_ID_BOUNDS.taskId)) failRuntime('generation-runtime-unavailable: taskId is required');
  if (!isBoundedId(rawInput.taskInstanceId, GENERATION_ID_BOUNDS.taskInstanceId)) failRuntime('generation-runtime-unavailable: taskInstanceId is required');
  if (!isBoundedId(rawInput.sessionId, GENERATION_ID_BOUNDS.sessionId)) failRuntime('generation-runtime-unavailable: sessionId is required');
  for (const key of ['runtimeDir', 'checkpointDir', 'operationRoot', 'lockWorkspace']) {
    if (typeof rawInput[key] !== 'string' || rawInput[key] === '') failRuntime('generation-runtime-unavailable: ' + key + ' is required');
  }
  const request = rawInput.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) failRuntime('generation-runtime-unavailable: request (A10 input) is required');
  if (!request.serialization || typeof request.serialization !== 'object') {
    failRuntime('generation-runtime-unavailable: request.serialization client is required');
  }
  if (!request.session || typeof request.session !== 'object') failRuntime('generation-runtime-unavailable: request.session is required');
  if (!Number.isInteger(request.generation) || request.generation < 1) failRuntime('generation-runtime-unavailable: request.generation must be a positive integer');
  if (request.taskId !== rawInput.taskId || request.taskInstanceId !== rawInput.taskInstanceId || request.sessionId !== rawInput.sessionId) {
    failRuntime('generation-runtime-corrupt: request binds another task/session than the generation entry');
  }
  return rawInput;
}

async function lockAcquireV2(serialization, lockCall) {
  if (!serialization || typeof serialization.acquire !== 'function' || typeof serialization.release !== 'function') {
    failRuntime('generation-runtime-unavailable: compaction serialization client is required');
  }
  let acquired = null;
  try {
    acquired = await serialization.acquire(lockCall);
  } catch (error) {
    failRuntime('generation-runtime-unavailable: lock acquire failed (' + String((error && error.message) || error).slice(0, 200) + ')');
  }
  if (!acquired || acquired.acquired !== true || typeof acquired.ownerId !== 'string' || acquired.ownerId === '') {
    failRuntime('generation-reservation-conflict: compaction lock is held by a live owner');
  }
  return acquired;
}

async function lockReleaseV2(serialization, taskId, ownerId) {
  try {
    await serialization.release({ taskId, ownerId });
  } catch { /* best effort: the lease expires; never mask the call result */ }
}

function applyCurrentGenerationV2(rawInput) {
  const n = normalizeApplyCurrentInput(rawInput);
  const serialKey = String(n.sessionId);
  // Phase 1 (chain + lock): final under-lock eligibility observation.
  // Phase 2 (lock only, chain released): the single A10 invocation.
  // Phase 3: real release (always).
  return runSerializedGeneration(serialKey, async () => {
    const prepared = await acquireAndAuthorizeGeneration(n);
    let activeResult = null;
    try {
      const activeModule = activeModuleOf();
      activeResult = await activeModule.applyActiveCompactionV2(prepared.a10input);
    } finally {
      await lockReleaseV2(n.request.serialization, n.taskId, prepared.ownerId);
    }
    const runtime = inspectGenerationRuntimeV2({
      schemaVersion: 1,
      taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
      runtimeDir: n.runtimeDir, checkpointDir: n.checkpointDir, operationRoot: n.operationRoot,
      session: n.request.session,
    });
    return Object.freeze({ ok: true, generation: n.request.generation, activeResult, runtime });
  });
}

async function acquireAndAuthorizeGeneration(n) {
  const request = n.request;
  const generation = request.generation;
  const artifact = request.projectionArtifact;
  const operationId = artifact && typeof artifact === 'object' && typeof artifact.operationId === 'string' && artifact.operationId !== ''
    ? artifact.operationId
    : null;
  if (operationId === null) failRuntime('generation-runtime-unavailable: request.projectionArtifact.operationId is required for lock attribution');
  const base = request.serialization;
  const lockCall = {
    workspace: n.lockWorkspace,
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    operationId,
  };
  if (typeof n.lockWorkspace !== 'string' || n.lockWorkspace === '') {
    failRuntime('generation-runtime-unavailable: lockWorkspace (ledger workspace) is required');
  }
  const held = await lockAcquireV2(base, lockCall);
  try {
    // FINAL observation under the held lock: anything superseded, committed,
    // or reassigned after an earlier read is observed here, never trusted
    // from a stale handle. A12: WITHOUT repair. The apply path never heals
    // the head: a commit-pending generation proceeds to A10 forward recovery
    // (reconcile, re-establish flush durability, re-run post-apply
    // verification) instead of being auto-committed on segment presence.
    // Only A10's proven result plus explicit commit may advance the head.
    const runtime = reconstructGenerationRuntimeV2({
      schemaVersion: 1,
      taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
      runtimeDir: n.runtimeDir, checkpointDir: n.checkpointDir, operationRoot: n.operationRoot,
      session: request.session,
      repairHead: false,
    });
    if (runtime.unresolvedGeneration !== null && Number(runtime.unresolvedGeneration) !== Number(generation)) {
      failRuntime('generation-unresolved-operation: generation ' + runtime.unresolvedGeneration + ' must reconcile before generation ' + generation + ' may apply');
    }
    const entry = runtime.generations.filter((g) => Number(g.generation) === Number(generation))[0];
    if (!entry) failRuntime('generation-not-active: generation ' + generation + ' was never allocated');
    if (entry.outcome === 'SUPERSEDED') {
      failRuntime('generation-cannot-supersede: generation ' + generation + ' is superseded and permanently non-applicable');
    }
    if (entry.outcome === 'COMMITTED' && Number(runtime.latestCommittedGeneration) === Number(generation)) {
      failRuntime('generation-already-committed: generation ' + generation + ' is already the committed head');
    }
    if (entry.outcome === 'UNRESOLVED') {
      // Same-generation recovery proceeds (A10 reconciles forward); the
      // reservation binding below still must match the recovery request.
    } else if (Number(runtime.activeGeneration) !== Number(generation)) {
      failRuntime('generation-not-active: generation ' + generation + ' is not the active generation');
    }
    if (request.shadowResult && typeof request.shadowResult === 'object'
      && Number(request.shadowResult.generation) !== Number(generation)) {
      failRuntime('generation-parent-mismatch: shadow result binds another generation');
    }
    // Reservation/source binding: the request must describe exactly the
    // source state the reservation was allocated for. A stale reservation
    // never applies to moved state (supersede + reserve anew instead).
    const reservation = readReservationV2(n.runtimeDir, generation, n);
    if (!reservation) failRuntime('generation-not-active: generation ' + generation + ' was never allocated');
    const token = request.snapshotToken;
    if (!token || typeof token !== 'object') failRuntime('generation-runtime-unavailable: request.snapshotToken is required');
    // Reservation binding is unconditional (fresh apply AND recovery):
    // the frozen A10 post-verify demands actual == prediction exactly, so
    // no A10 path can converge on moved state either. Refusing moved
    // recovery up front (mutated=false, no missing-segment retry on drifted
    // state) is strictly safer than letting A10 mutate-then-fail with an
    // ambiguous post-apply mismatch. Unchanged-state recovery proceeds to
    // the single A10 invocation below.
    if (token.revisionDigest !== reservation.revisionDigest) {
      failRuntime('generation-source-stale: request revision moved since generation ' + generation + ' was reserved');
    }
    if (reservation.snapshotTokenId !== null && reservation.snapshotTokenId !== undefined
      && token.snapshotTokenId !== reservation.snapshotTokenId) {
      failRuntime('generation-source-stale: request snapshot moved since generation ' + generation + ' was reserved');
    }
    const safe = request.safePointDecision;
    if (!safe || typeof safe !== 'object') failRuntime('generation-runtime-unavailable: request.safePointDecision is required');
    if (Number(safe.boundarySeq) !== Number(reservation.safePointBoundarySeq)) {
      failRuntime('generation-source-stale: safe-point boundary moved since generation ' + generation + ' was reserved');
    }
    const currentParent = runtime.latestCommittedCheckpointId;
    const reservedParent = reservation.parentCommittedCheckpointId;
    if ((currentParent === null || currentParent === undefined) !== (reservedParent === null || reservedParent === undefined)
      || (currentParent !== null && currentParent !== undefined && currentParent !== reservedParent)) {
      failRuntime('generation-parent-mismatch: committed lineage moved since generation ' + generation + ' was reserved');
    }
    // Operation dir is DERIVED (never trusted from the caller): the
    // generation-owned directory is the only place A10 may persist intent.
    const derivedOpDir = operationDirForGenerationV2(n.operationRoot, generation);
    if (typeof request.operationDir === 'string' && request.operationDir !== '' && request.operationDir !== derivedOpDir) {
      failRuntime('generation-runtime-corrupt: request operationDir does not match the generation-owned directory');
    }
    const wrapper = reentrantLockClientV2(base, { ownerId: held.ownerId, leaseSeconds: held.leaseSeconds }, operationId);
    const a10input = Object.assign({}, request, { operationDir: derivedOpDir, serialization: wrapper });
    return { ownerId: held.ownerId, a10input };
  } catch (error) {
    await lockReleaseV2(base, n.taskId, held.ownerId);
    throw error;
  }
}

// ---- A11H: gated generation recovery ------------------------------------------------
// reconcileGenerationV2 is the ONLY supported generation-aware
// reconciliation path: it refuses superseded generations (permanently
// non-applicable, even across restarts) and unallocated generations, then
// runs the frozen A02 reconciliation verbatim for recovery diagnostics.
// Read-only: no lock, no mutation, no state change.

function normalizeReconcileInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) failRuntime('generation-runtime-unavailable: input is required');
  const unknown = unknownKeyOf(rawInput, RECONCILE_INPUT_EXACT_KEYS);
  if (unknown !== null) failRuntime('generation-runtime-unavailable: unknown field ' + unknown);
  if (Number(rawInput.schemaVersion) !== GENERATION_RUNTIME_SCHEMA_VERSION) failRuntime('generation-runtime-unavailable: schemaVersion must be 1');
  if (!isBoundedId(rawInput.taskId, GENERATION_ID_BOUNDS.taskId)) failRuntime('generation-runtime-unavailable: taskId is required');
  if (!isBoundedId(rawInput.taskInstanceId, GENERATION_ID_BOUNDS.taskInstanceId)) failRuntime('generation-runtime-unavailable: taskInstanceId is required');
  if (!isBoundedId(rawInput.sessionId, GENERATION_ID_BOUNDS.sessionId)) failRuntime('generation-runtime-unavailable: sessionId is required');
  for (const key of ['runtimeDir', 'checkpointDir', 'operationRoot']) {
    if (typeof rawInput[key] !== 'string' || rawInput[key] === '') failRuntime('generation-runtime-unavailable: ' + key + ' is required');
  }
  if (!Number.isInteger(rawInput.generation) || rawInput.generation < 1) failRuntime('generation-runtime-unavailable: generation must be a positive integer');
  if (!rawInput.session || typeof rawInput.session !== 'object') failRuntime('generation-runtime-unavailable: session is required');
  return rawInput;
}

function reconcileGenerationV2(rawInput) {
  const n = normalizeReconcileInput(rawInput);
  const runtime = inspectGenerationRuntimeV2({
    schemaVersion: 1,
    taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
    runtimeDir: n.runtimeDir, checkpointDir: n.checkpointDir, operationRoot: n.operationRoot,
    session: n.session,
  });
  const marker = readSupersessionV2(n.runtimeDir, n.generation, null);
  if (marker) {
    failRuntime('generation-cannot-supersede: generation ' + n.generation + ' is superseded and permanently non-applicable');
  }
  const entry = runtime.generations.filter((g) => Number(g.generation) === Number(n.generation))[0];
  if (!entry) failRuntime('generation-not-active: generation ' + n.generation + ' was never allocated');
  const sealedStored = readSealedEvidence(n.checkpointDir, n.generation);
  if (!sealedStored) failRuntime('generation-runtime-corrupt: generation ' + n.generation + ' has no durable checkpoint');
  const operation = readOperationEvidence(n.operationRoot, n.generation);
  if (!operation) failRuntime('generation-runtime-unavailable: generation ' + n.generation + ' has no durable operation to reconcile');
  let payloadText = null;
  try {
    payloadText = shadowV2.checkpointPayloadTextOf(sealedStored.checkpoint);
  } catch {
    failRuntime('generation-runtime-corrupt: checkpoint payload unproven at G' + n.generation);
  }
  const outcome = compactionV2.reconcileCompactionOperationV2(operation, n.session, { payloadText, durable: false });
  return Object.freeze({
    generation: n.generation,
    superseded: false,
    outcome: entry.outcome,
    decision: outcome.decision,
    reason: outcome.reason,
    segmentStatus: Object.freeze((outcome.segmentStatus || []).slice()),
    missingSegments: Object.freeze((outcome.missingSegments || []).slice()),
  });
}

// ---- A11H: runtime-snapshot lifecycle policy ------------------------------------------
// snapshotProtectionOfV2 derives, from durable runtime state plus the live
// session ONLY (no in-memory pin state, so restart reconstructs
// identically), whether each live host-owned runtime snapshot is PINNED or
// SHADOWABLE:
//
//   current (latest live) runtime snapshot
//     -> PINNED (required by the current active/committed state)
//
//   any live runtime snapshot while an UNRESOLVED generation exists, or any
//   snapshot cited in an unresolved operation's frozen source set
//     -> PINNED (recovery dependency; a newer reservation never unpins it)
//
//   non-current snapshots with no unresolved generation and no recovery
//   reference (superseded zero-landing generations, older committed lineage
//   superseded by a newer self-contained commit)
//     -> SHADOWABLE (eligibility only; no deletion/GC here -- Phase B owns
//        memory tiers, and physical retention is out of scope)
//
// A generation reservation alone pins nothing: G3 reserved while G2 is
// unresolved is impossible (reserve refuses), so the policy composes.

function normalizeSnapshotProtectionInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) failRuntime('generation-runtime-unavailable: input is required');
  const unknown = unknownKeyOf(rawInput, SNAPSHOT_PROTECTION_INPUT_EXACT_KEYS);
  if (unknown !== null) failRuntime('generation-runtime-unavailable: unknown field ' + unknown);
  if (Number(rawInput.schemaVersion) !== GENERATION_RUNTIME_SCHEMA_VERSION) failRuntime('generation-runtime-unavailable: schemaVersion must be 1');
  if (!isBoundedId(rawInput.taskId, GENERATION_ID_BOUNDS.taskId)) failRuntime('generation-runtime-unavailable: taskId is required');
  if (!isBoundedId(rawInput.taskInstanceId, GENERATION_ID_BOUNDS.taskInstanceId)) failRuntime('generation-runtime-unavailable: taskInstanceId is required');
  if (!isBoundedId(rawInput.sessionId, GENERATION_ID_BOUNDS.sessionId)) failRuntime('generation-runtime-unavailable: sessionId is required');
  for (const key of ['runtimeDir', 'checkpointDir', 'operationRoot']) {
    if (typeof rawInput[key] !== 'string' || rawInput[key] === '') failRuntime('generation-runtime-unavailable: ' + key + ' is required');
  }
  if (!rawInput.session || typeof rawInput.session !== 'object') failRuntime('generation-runtime-unavailable: session is required');
  return rawInput;
}

function snapshotProtectionOfV2(rawInput) {
  const n = normalizeSnapshotProtectionInput(rawInput);
  const runtime = inspectGenerationRuntimeV2({
    schemaVersion: 1,
    taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
    runtimeDir: n.runtimeDir, checkpointDir: n.checkpointDir, operationRoot: n.operationRoot,
    session: n.session,
  });
  const liveNodes = new Set(compactionV2.surfaceNodesOf(n.session));
  const liveRuntimeSeqs = compactionV2.runtimeContextSeqsOf(n.session)
    .filter((seq) => liveNodes.has(seq))
    .sort((a, b) => a - b);
  const currentRuntimeSeq = liveRuntimeSeqs.length > 0 ? liveRuntimeSeqs[liveRuntimeSeqs.length - 1] : null;
  // Recovery references: the frozen source sets of every UNRESOLVED
  // generation's operation. Superseded and committed generations carry no
  // recovery dependency (superseded ops never apply; committed projections
  // are self-contained), so their seqs never pin.
  const unresolvedRefs = new Set();
  let unresolvedPinned = false;
  for (const gen of runtime.generations) {
    if (gen.outcome !== 'UNRESOLVED') continue;
    unresolvedPinned = true;
    const operation = readOperationEvidence(n.operationRoot, gen.generation);
    if (operation && Array.isArray(operation.sourceEventSeqs)) {
      for (const seq of operation.sourceEventSeqs) unresolvedRefs.add(seq);
    }
  }
  const snapshots = liveRuntimeSeqs.map((seq) => {
    if (seq === currentRuntimeSeq) {
      return { seq, protection: 'pinned', reason: 'current-generation-requirement' };
    }
    if (unresolvedPinned || unresolvedRefs.has(seq)) {
      return { seq, protection: 'pinned', reason: 'unresolved-recovery-dependency' };
    }
    return { seq, protection: 'shadowable', reason: 'no-recovery-dependency' };
  });
  const body = {
    taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
    currentRuntimeSeq, snapshots,
    unresolvedGeneration: runtime.unresolvedGeneration,
    latestCommittedGeneration: runtime.latestCommittedGeneration,
  };
  const protectionDigest = sha256HexUtf8(SNAPSHOT_PROTECTION_DIGEST_DOMAIN_V1 + LF_JOIN + canonicalOf(body));
  return Object.freeze({
    schemaVersion: GENERATION_RUNTIME_SCHEMA_VERSION,
    taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
    currentRuntimeSeq,
    snapshots: Object.freeze(snapshots.map((s) => Object.freeze({ seq: s.seq, protection: s.protection, reason: s.reason }))),
    protectionDigest,
  });
}

function validateSnapshotProtectionV2(value) {
  const fail = (reason) => ({ valid: false, reason });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('generation-runtime-corrupt');
  if (unknownKeyOf(value, SNAPSHOT_PROTECTION_EXACT_KEYS) !== null) return fail('generation-runtime-corrupt');
  if (Number(value.schemaVersion) !== GENERATION_RUNTIME_SCHEMA_VERSION) return fail('generation-runtime-corrupt');
  if (!Array.isArray(value.snapshots)) return fail('generation-runtime-corrupt');
  for (const entry of value.snapshots) {
    if (!entry || typeof entry !== 'object') return fail('generation-runtime-corrupt');
    if (unknownKeyOf(entry, SNAPSHOT_ENTRY_EXACT_KEYS) !== null) return fail('generation-runtime-corrupt');
    if (!Number.isInteger(entry.seq) || entry.seq < 0) return fail('generation-runtime-corrupt');
    if (entry.protection !== 'pinned' && entry.protection !== 'shadowable') return fail('generation-runtime-corrupt');
    if (typeof entry.reason !== 'string' || entry.reason === '') return fail('generation-runtime-corrupt');
  }
  return { valid: true, reason: null };
}

module.exports = {
  GENERATION_RUNTIME_SCHEMA_VERSION,
  RUNTIME_FILE_NAME,
  GENERATIONS_SUBDIR,
  GENERATION_DIR_PREFIX,
  RESERVATION_FILE_NAME,
  SUPERSEDED_FILE_NAME,
  RUNTIME_DIGEST_DOMAIN_V1,
  RESERVATION_DIGEST_DOMAIN_V1,
  SUPERSESSION_DIGEST_DOMAIN_V1,
  ACTIVE_GENERATION_STATES,
  GENERATION_OUTCOMES,
  GENERATION_BLOCKER_CODES,
  RESERVATION_EXACT_KEYS,
  SUPERSESSION_EXACT_KEYS,
  RUNTIME_HEAD_EXACT_KEYS,
  runtimeFilePath,
  generationDirPath,
  reservationFilePath,
  supersessionFilePath,
  operationDirForGenerationV2,
  deriveReservationDigestV2,
  deriveSupersessionDigestV2,
  deriveRuntimeDigestV2,
  validateReservationV2,
  validateSupersessionV2,
  validateGenerationRuntimeV2,
  listCheckpointGenerations,
  listOperationGenerations,
  listReservationGenerations,
  readReservationV2,
  readSupersessionV2,
  generationCitationsOf,
  landingStatusOfV2,
  classifyGenerationV2,
  reconstructGenerationRuntimeV2,
  inspectGenerationRuntimeV2,
  reserveNextGenerationV2,
  commitGenerationV2,
  supersedeGenerationV2,
  checkOperationSupersededV2,
  assertGenerationEligibleForApplyV2,
  generationTelemetryV2,
  APPLY_CURRENT_INPUT_EXACT_KEYS,
  SNAPSHOT_PROTECTION_DIGEST_DOMAIN_V1,
  applyCurrentGenerationV2,
  reentrantLockClientV2,
  reconcileGenerationV2,
  snapshotProtectionOfV2,
  validateSnapshotProtectionV2,
  buildRecoveredCompletionV2,
  recoveryTraceV2,
};
