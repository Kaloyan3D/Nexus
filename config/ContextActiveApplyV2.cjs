'use strict';
/**
 * ContextActiveApplyV2.cjs - CCV2-A10 TransactionalCompactionApplierV2 production authority.
 *
 * ONE explicit authority for the first REAL active CCv2 compaction application
 * path. A10 answers: "given a fully validated fresh A09 shadow result, can
 * Nexus apply exactly that already-proven projection to the real DSH surface
 * transactionally, durably and recoverably?"
 *
 * Core invariant (frozen):
 *
 *   SHADOW PREDICTS. A10 APPLIES EXACTLY THAT PREDICTION.
 *
 *   NO LIVE MUTATION UNTIL DURABLE INTENT + ALL SAFETY GATES PASS.
 *
 * Authority separation (frozen): this module redefines NO lower-level
 * authority. It orchestrates existing authorities only:
 *
 *   A09H buildCompactedProjectionV2  - the ONLY projection builder (shared
 *                                     with shadow; no active-only algorithm).
 *   A09  validateShadowResultV2,
 *        assertShadowResultFresh,
 *        validateCompactedProjectionV2,
 *        checkMessagesBalanced        - shadow/projection proof, verbatim.
 *   A05  validateSnapshotToken,
 *        revalidateBeforeMutation     - snapshot freshness, verbatim.
 *   A06  validateSafePointDecision,
 *        assertCheckpointBindsSafePoint - boundary identity, verbatim.
 *   A07  validateCheckpointabilityDecision,
 *        assertCheckpointCoverageV2   - coverage, verbatim.
 *   A08  validatePressureDecision (via retention plan),
 *        validateRetentionPlan,
 *        assertRetentionPlanFresh     - pressure/retention, verbatim.
 *   A03  serializeCheckpointCanonical,
 *        validateCheckpointV2         - checkpoint bytes, verbatim.
 *   A04  validateSealedCheckpoint,
 *        persistSealedCheckpointV2,
 *        readSealedCheckpointV2 - seal + durability, verbatim
 *        (the regime-1 full-serialized binding helper is NOT used: A10
 *        applies the regime-2 digest-proven payload per §20).
 *   A02  deriveCanonicalOperationIdV2,
 *        validateCompactionOperationV2,
 *        freezeCompactionOperationV2,
 *        readCompactionOperationV2,
 *        applyCompactionOperationV2,
 *        retryMissingSegmentsV2,
 *        reconcileCompactionOperationV2,
 *        nexusReplacementEventsOf,
 *        textContentOfEvent           - the SOLE transaction authority.
 *   LOCK config/ContextActiveApplyLockClientV2.cjs (A10H) - the Node
 *        invocation seam for the frozen cross-process apply lock
 *        (scripts/ContextLifecycle.ps1 via ContextLifecycleCli.ps1).
 *        The lock protocol lives in PowerShell; the client only invokes
 *        acquire/renew/release and parses results. A10 treats the client
 *        as MANDATORY serialization: no client, or a client that cannot
 *        acquire, means REFUSE, never silent proceed.
 *
 * Explicit invocation only: production default behavior is unchanged unless
 * applyActiveCompactionV2() is deliberately called (A13 owns runtime
 * integration; no automatic triggering exists here, even at CRITICAL
 * pressure).
 *
 * Transactional semantics (frozen): the DSH source log is append-only, so
 * there is NO destructive rollback. A10 means: durable intent + idempotent
 * application + forward reconciliation.
 *
 * A10H hardening (frozen): (H1) the cross-process apply lock is mandatory
 * and acquired BEFORE the final freshness observation; the serialized
 * order is acquire -> re-read -> validate -> intent -> apply -> flush ->
 * verify -> release. (H2) host-only `session/end-seed` restore markers are
 * execution-transparent for the rebuild barrier (A06 precedent); digest
 * equality still governs, so real semantic drift still fails closed.
 * (H3) durability is split: intentDurable (operation persisted+branded)
 * vs applicationDurable (landed + flushed + verified); `durable` is
 * derived as applicationDurable. Process-crash recoverable is still never
 * claimed as power-loss durable.
 *
 * Durability scope (frozen, A05H wording preserved): atomic file writes +
 * read-back validation + SessionStore.flush() participation are
 * process-crash recoverable under the filesystem/OS contract. NOT claimed
 * power-loss durable (no fsync barrier).
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md (A10).
 * NOT implemented here: A11 multi-generation runtime policy, A12 expanded
 * crash/concurrency campaign, A13 complete-task integration, automatic
 * controller triggering, background compaction, new pressure/retention/
 * safe-point/checkpointability policy, new projection algorithm, Phase B
 * ContextPage, Phase C Context Compiler, LLM summarization, JEV / Laya,
 * Nexus Nova.
 *
 * Determinism: no clock, no randomness, no LLM, no model call. Timestamps
 * are never minted here (the sealed checkpoint already carries them).
 *
 * Security: classification derives ONLY from authority metadata. Prompt,
 * tool-output, and repository TEXT are inert data: never branched on, never
 * copied into results/telemetry. Content-bearing input fields fail closed.
 * Secrets never enter A10 artifacts (frozen A03/A04 redaction is inherited;
 * telemetry carries ids/digests/counts only).
 */

const crypto = require('node:crypto');

const compactionV2 = require('./ContextCompaction.cjs');
const checkpointV2 = require('./ContextCheckpointV2.cjs');
const snapshotV2 = require('./ContextSnapshotV2.cjs');
const trustV2 = require('./ContextTrustV2.cjs');
const safepointV2 = require('./ContextSafePointV2.cjs');
const gateV2 = require('./ContextCheckpointabilityV2.cjs');
const retentionV2 = require('./ContextRetentionV2.cjs');
const shadowV2 = require('./ContextShadowV2.cjs');
const lockClientV2 = require('./ContextActiveApplyLockClientV2.cjs');

const ACTIVE_APPLY_SCHEMA_VERSION = 1;
const ACTIVE_RESULT_DIGEST_DOMAIN_V1 = 'nexus/context-active-apply-result/v1';
const LF_JOIN = String.fromCharCode(10);

// Bounded A10 result statuses. These describe the A10 application attempt,
// never the A02 operation lifecycle (frozen/blocked/applied live in A02).
// 'prepared' is intentionally absent: intent persistence and mutation occur
// inside one serialized call, so an interrupted intent surfaces through
// retry/recovery (reconcile), not as a returned halfway status.
const ACTIVE_APPLY_STATUSES = Object.freeze([
  'refused',
  'stale',
  'committed',
  'recovered',
  'failed',
]);

// Frozen A10 blocker codes (stable machine-readable refusal/failure reasons).
const ACTIVE_APPLY_BLOCKER_CODES = Object.freeze([
  'active-input-invalid',
  'active-shadow-not-ready',
  'active-shadow-unproven',
  'active-shadow-stale',
  'active-seal-invalid',
  'active-checkpoint-mismatch',
  'active-projection-unproven',
  'active-projection-mismatch',
  'active-snapshot-stale',
  'active-boundary-mismatch',
  'active-checkpointability-required',
  'active-coverage-mismatch',
  'active-pressure-unknown',
  'active-route-drift',
  'active-generation-drift',
  'active-retention-stale',
  'active-retention-not-actionable',
  'active-operation-mismatch',
  'active-operation-conflict',
  'active-checkpoint-conflict',
  'active-serialization-unavailable',
  'active-serialization-conflict',
  'active-persist-failed',
  'active-apply-failed',
  'active-flush-unavailable',
  'active-flush-failed',
  'active-post-apply-mismatch',
  'active-recovery-blocked',
]);

const ACTIVE_APPLY_BOUNDS = Object.freeze({
  taskId: 256,
  taskInstanceId: 256,
  sessionId: 256,
  detail: 1024,
});

// Closed-world A10 input contract. Unknown keys FAIL CLOSED before any
// identity/digest computation (A05H rules apply to this protocol object).
const ACTIVE_APPLY_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'generation',
  'shadowResult',
  'sealedCheckpoint',
  'projectionArtifact',
  'snapshotToken',
  'snapshotCurrentState',
  'safePointDecision',
  'checkpointabilityDecision',
  'pressureDecision',
  'retentionPlan',
  'taskState',
  'contextUnits',
  'protocolSpans',
  'session',
  'checkpointDir',
  'operationDir',
  'flushFn',
  'serialization',
  'lockLeaseSeconds',
  'workspace',
  'repositoryId',
  'checkoutId',
  'attemptId',
]);

const ACTIVE_RESULT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'generation',
  'checkpointId',
  'operationId',
  'shadowId',
  'projectionDigest',
  'status',
  'mutated',
  'durable',
  'intentDurable',
  'applicationDurable',
  'blockers',
  'telemetry',
  'resultDigest',
]);

const ACTIVE_BLOCKER_EXACT_KEYS = Object.freeze(['code', 'detail']);

const ACTIVE_TELEMETRY_EXACT_KEYS = Object.freeze([
  'operationId',
  'checkpointId',
  'generation',
  'sourceBoundary',
  'segmentCount',
  'sourceEventCount',
  'projectionDigest',
  'beforeMessageCount',
  'afterMessageCount',
  'beforeTokenEstimate',
  'afterTokenEstimate',
  'status',
  'mutated',
  'durable',
  'intentDurable',
  'applicationDurable',
  'reconciliationOutcome',
  'blockerCodes',
]);

function failActive(message) {
  throw new Error('ccv2-active-apply-v2: ' + message);
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

// Message-identity transport rule (frozen-contract strongest comparison):
// live replacement nodes mint host-side message ids (A02 v2UserMessageNode)
// while the shadow artifact carries deterministic hypothetical ids (A09H
// shadowMessageId). Ids are transport, never content: source-event ids are
// identical on both sides, so the strongest content-exact comparison is
// canonical equality modulo the volatile `id` key. Every other field
// (role/content/source) must be byte-exact. Tool-pairing keys
// (callId/toolCallId) and evidence locators are NEVER stripped: only the
// exact key `id` is removed, recursively.
function stripMessageIds(value) {
  if (Array.isArray(value)) return value.map(stripMessageIds);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === 'id') continue;
      out[key] = stripMessageIds(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalMessagesOf(messages) {
  return canonicalOf(stripMessageIds(messages));
}

// H2 host-restore transparency (A06 precedent: the seed-boundary marker is
// execution-transparent for boundary identity). `session/end-seed` is
// host-owned restore bookkeeping appended by seed restore: it is never
// task/semantic state and never appears on the model-facing surface. The
// rebuild barrier therefore reasons over the LOGICAL source view with
// these markers excluded. Digest equality still governs end-to-end, so any
// REAL semantic change (user/tool/controller event) still fails closed
// (Case B). Only the barrier input is filtered; the live log itself is
// never rewritten and post-verify still observes the full live state.
const RESTORE_MARKER_TYPE = 'session/end-seed';

function withoutRestoreMarkers(events) {
  if (!Array.isArray(events)) return [];
  return events.filter((e) => !e || e.type !== RESTORE_MARKER_TYPE);
}

function surfaceWithoutRestoreMarkers(surfaceNodes, events) {
  const bySeq = new Map();
  for (const e of withoutRestoreMarkers(events)) {
    if (e && Number.isInteger(e.seq)) bySeq.set(e.seq, true);
  }
  return (Array.isArray(surfaceNodes) ? surfaceNodes : []).filter((seq) => bySeq.has(seq));
}

function isBoundedId(value, bound) {
  return typeof value === 'string' && value !== '' && value.length <= bound;
}

// ---- mutation serialization (H1, two layers) --------------------------------
// OUTER (mandatory): the cross-process apply lock through the caller-
// supplied serialization client (config/ContextActiveApplyLockClientV2.cjs
// -> the frozen scripts/ContextLifecycle.ps1 authority). Acquired BEFORE
// the final freshness observation; the serialized order is acquire ->
// re-read -> validate -> intent -> apply -> flush -> verify -> release.
// No client, or a failed acquire, REFUSES (never silent proceed).
// INNER: a per-key (sessionId) promise chain so concurrent A10 calls in
// this process never interleave either. The chain slot is held across the
// lock acquisition, so same-process callers queue before touching the
// cross-process lock.
//
// Honest scope: the two layers close the validate->apply TOCTOU window
// for all callers sharing the lock authority. A process bypassing the
// lock entirely is outside the contract; A02 durable-intent plus
// idempotent forward reconciliation still guarantees one valid final
// state in that case, and the post-freeze renew gate refuses to apply
// when this process has lost ownership.
const activeApplyChains = new Map();

function runSerializedInternal(key, fn) {
  const prior = activeApplyChains.get(key) || Promise.resolve();
  let settle = null;
  const current = new Promise((resolve) => { settle = resolve; });
  activeApplyChains.set(key, prior.then(() => current));
  return prior.then(() => Promise.resolve().then(fn)).then(
    (value) => { settle(); if (activeApplyChains.get(key) === current) activeApplyChains.delete(key); return value; },
    (error) => { settle(); if (activeApplyChains.get(key) === current) activeApplyChains.delete(key); throw error; }
  );
}

// ---- closed-world result validation ----------------------------------------

function validateActiveResultV2(result) {
  const fail = (reason) => ({ valid: false, reason });
  if (!result || typeof result !== 'object' || Array.isArray(result)) return fail('active-input-invalid');
  if (unknownKeyOf(result, ACTIVE_RESULT_EXACT_KEYS) !== null) return fail('active-input-invalid');
  if (Number(result.schemaVersion) !== ACTIVE_APPLY_SCHEMA_VERSION) return fail('active-input-invalid');
  if (ACTIVE_APPLY_STATUSES.indexOf(result.status) === -1) return fail('active-input-invalid');
  if (typeof result.mutated !== 'boolean' || typeof result.durable !== 'boolean') return fail('active-input-invalid');
  if (typeof result.intentDurable !== 'boolean' || typeof result.applicationDurable !== 'boolean') return fail('active-input-invalid');
  // H3 invariant: `durable` is exactly application durability (never
  // intent alone). A result claiming durable application without
  // applicationDurable is structurally invalid.
  if (result.durable !== result.applicationDurable) return fail('active-input-invalid');
  if (!Array.isArray(result.blockers)) return fail('active-input-invalid');
  for (const b of result.blockers) {
    if (!b || typeof b !== 'object') return fail('active-input-invalid');
    if (unknownKeyOf(b, ACTIVE_BLOCKER_EXACT_KEYS) !== null) return fail('active-input-invalid');
    if (ACTIVE_APPLY_BLOCKER_CODES.indexOf(b.code) === -1) return fail('active-input-invalid');
    if (b.detail !== null && b.detail !== undefined && typeof b.detail !== 'string') return fail('active-input-invalid');
  }
  if (!result.telemetry || typeof result.telemetry !== 'object') return fail('active-input-invalid');
  if (unknownKeyOf(result.telemetry, ACTIVE_TELEMETRY_EXACT_KEYS) !== null) return fail('active-input-invalid');
  if (typeof result.resultDigest !== 'string' || result.resultDigest.length !== 64) return fail('active-input-invalid');
  const body = {};
  for (const key of ACTIVE_RESULT_EXACT_KEYS) {
    if (key === 'resultDigest') continue;
    body[key] = result[key];
  }
  const expected = sha256HexUtf8(ACTIVE_RESULT_DIGEST_DOMAIN_V1 + LF_JOIN + canonicalOf(body));
  if (result.resultDigest !== expected) return fail('active-input-invalid');
  return { valid: true, reason: null };
}

// H3 durability split (frozen): intentDurable = the A02 operation is durably
// persisted and branded (forward recovery may proceed); applicationDurable =
// the projection landed AND passed the SessionStore.flush() barrier AND
// post-apply verification. `durable` is derived as applicationDurable.
function buildActiveResult(fields) {
  const blockers = (fields.blockers || []).map((b) => Object.freeze({
    code: b.code,
    detail: b.detail === null || b.detail === undefined ? null : String(b.detail).slice(0, ACTIVE_APPLY_BOUNDS.detail),
  }));
  const telemetry = Object.freeze({
    operationId: fields.operationId || null,
    checkpointId: fields.checkpointId || null,
    generation: fields.generation,
    sourceBoundary: fields.sourceBoundary === undefined ? null : fields.sourceBoundary,
    segmentCount: fields.segmentCount === undefined ? null : fields.segmentCount,
    sourceEventCount: fields.sourceEventCount === undefined ? null : fields.sourceEventCount,
    projectionDigest: fields.projectionDigest || null,
    beforeMessageCount: fields.beforeMessageCount === undefined ? null : fields.beforeMessageCount,
    afterMessageCount: fields.afterMessageCount === undefined ? null : fields.afterMessageCount,
    beforeTokenEstimate: fields.beforeTokenEstimate === undefined ? null : fields.beforeTokenEstimate,
    afterTokenEstimate: fields.afterTokenEstimate === undefined ? null : fields.afterTokenEstimate,
    status: fields.status,
    mutated: fields.mutated,
    durable: fields.applicationDurable === true,
    intentDurable: fields.intentDurable === true,
    applicationDurable: fields.applicationDurable === true,
    reconciliationOutcome: fields.reconciliationOutcome || null,
    blockerCodes: Object.freeze(blockers.map((b) => b.code).slice().sort()),
  });
  const body = {
    schemaVersion: ACTIVE_APPLY_SCHEMA_VERSION,
    taskId: fields.taskId,
    taskInstanceId: fields.taskInstanceId,
    sessionId: fields.sessionId,
    generation: fields.generation,
    checkpointId: fields.checkpointId || null,
    operationId: fields.operationId || null,
    shadowId: fields.shadowId || null,
    projectionDigest: fields.projectionDigest || null,
    status: fields.status,
    mutated: fields.mutated,
    durable: fields.applicationDurable === true,
    intentDurable: fields.intentDurable === true,
    applicationDurable: fields.applicationDurable === true,
    blockers,
    telemetry,
  };  // H3: `durable` is DERIVED as applicationDurable (never intent alone).
  const resultDigest = sha256HexUtf8(ACTIVE_RESULT_DIGEST_DOMAIN_V1 + LF_JOIN + canonicalOf(body));
  return Object.freeze(Object.assign({}, body, {
    blockers: Object.freeze(blockers),
    resultDigest,
  }));
}

// ---- input normalization (closed world; throws fail-closed) -----------------

function normalizeActiveInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) failActive('input is required');
  const unknown = unknownKeyOf(input, ACTIVE_APPLY_INPUT_EXACT_KEYS);
  if (unknown !== null) failActive('unknown field ' + unknown);
  if (Number(input.schemaVersion) !== ACTIVE_APPLY_SCHEMA_VERSION) failActive('schemaVersion must be 1');
  if (!isBoundedId(input.taskId, ACTIVE_APPLY_BOUNDS.taskId)) failActive('taskId is required');
  if (!isBoundedId(input.taskInstanceId, ACTIVE_APPLY_BOUNDS.taskInstanceId)) failActive('taskInstanceId is required');
  if (!isBoundedId(input.sessionId, ACTIVE_APPLY_BOUNDS.sessionId)) failActive('sessionId is required');
  if (!Number.isInteger(input.generation) || input.generation < 1) failActive('generation must be a positive integer');
  for (const key of ['shadowResult', 'sealedCheckpoint', 'projectionArtifact', 'snapshotToken',
    'snapshotCurrentState', 'safePointDecision', 'checkpointabilityDecision',
    'pressureDecision', 'retentionPlan', 'taskState']) {
    if (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key])) failActive(key + ' is required');
  }
  if (!Array.isArray(input.contextUnits) || input.contextUnits.length === 0) failActive('contextUnits must be a non-empty array');
  if (input.protocolSpans !== undefined && input.protocolSpans !== null && !Array.isArray(input.protocolSpans)) {
    failActive('protocolSpans must be an array');
  }
  if (!input.session || typeof input.session !== 'object') failActive('session is required');
  if (typeof input.checkpointDir !== 'string' || input.checkpointDir === '') failActive('checkpointDir is required');
  if (typeof input.operationDir !== 'string' || input.operationDir === '') failActive('operationDir is required');
  if (input.flushFn !== undefined && input.flushFn !== null && typeof input.flushFn !== 'function') {
    failActive('flushFn must be a function');
  }
  // H1: cross-process serialization is MANDATORY for the production active
  // path. The client owns ledger paths (same frozen lock authority); A10
  // supplies per-call binding identity. Absent or malformed client input
  // does not throw here: execute() refuses with active-serialization-
  // unavailable so the refusal carries the full result contract.
  if (input.lockLeaseSeconds !== undefined && input.lockLeaseSeconds !== null
    && (typeof input.lockLeaseSeconds !== 'number' || !Number.isFinite(input.lockLeaseSeconds))) {
    failActive('lockLeaseSeconds must be a finite number');
  }
  for (const key of ['workspace', 'repositoryId', 'checkoutId', 'attemptId', 'checkpointDir', 'operationDir']) {
    const v = input[key];
    if (v !== undefined && v !== null && (typeof v !== 'string' || v === '')) failActive(key + ' must be a non-empty string or null');
  }
  return input;
}

// ---- deterministic attempt identity (idempotent retry support) --------------
// The A02 operation carries an attemptId; retries must reuse the SAME draft
// bytes so persistence comparison stays meaningful. Derivation is
// deterministic over the operation identity (never clock/random).
function deriveAttemptIdV2(operationId, attemptIdHint) {
  if (typeof attemptIdHint === 'string' && attemptIdHint !== '') return attemptIdHint;
  return 'att_' + sha256HexUtf8('nexus/context-active-apply-attempt/v1' + LF_JOIN + String(operationId)).slice(0, 24);
}

// ---- live-session observation helpers (read-only) ----------------------------

function liveEventsOf(session) {
  if (!Array.isArray(session.events)) failActive('session.events must be an array');
  return session.events;
}

function liveSurfaceOf(session) {
  if (!session.surface || !Array.isArray(session.surface.nodes)) failActive('session.surface.nodes must be an array');
  return session.surface.nodes.slice();
}

function deriveLiveMessages(session) {
  if (typeof session.deriveMessages === 'function') return session.deriveMessages();
  // Host-free fallback mirrors the pinned deriveEventMessage verbatim (same
  // mirror A09H uses); the live-host proof asserts mirror/host equivalence.
  const out = [];
  for (const seq of liveSurfaceOf(session)) {
    const message = shadowV2.deriveProjectedMessageV2(session.events[seq]);
    if (message !== null && message !== undefined) out.push(message);
  }
  return out;
}

// ---- main application --------------------------------------------------------

async function applyActiveCompactionV2(rawInput) {
  let n = null;
  try {
    n = normalizeActiveInput(rawInput);
  } catch (error) {
    return buildActiveResult({
      taskId: rawInput && typeof rawInput.taskId === 'string' ? rawInput.taskId : 'unknown',
      taskInstanceId: rawInput && typeof rawInput.taskInstanceId === 'string' ? rawInput.taskInstanceId : 'unknown',
      sessionId: rawInput && typeof rawInput.sessionId === 'string' ? rawInput.sessionId : 'unknown',
      generation: rawInput && Number.isInteger(rawInput.generation) ? rawInput.generation : 0,
      status: 'refused', mutated: false, durable: false,
      blockers: [{ code: 'active-input-invalid', detail: String((error && error.message) || error).slice(0, 300) }],
      reconciliationOutcome: 'none',
    });
  }

  // H1: the cross-process lock is the OUTER layer (acquired before any
  // authoritative observation); the in-process promise chain stays as the
  // inner layer so same-process callers never interleave either.
  const serialKey = String(n.sessionId);
  return runSerializedInternal(serialKey, () => executeActiveApplyCritical(n));
}

async function executeActiveApplyCritical(n) {
  const refused = (code, detail, extra) => buildActiveResult(Object.assign({
    taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId, generation: n.generation,
    checkpointId: n.shadowResult && n.shadowResult.checkpoint ? n.shadowResult.checkpoint.checkpointId : null,
    operationId: n.shadowResult && n.shadowResult.projection ? n.shadowResult.projection.operationId : null,
    shadowId: n.shadowResult && n.shadowResult.shadowId ? n.shadowResult.shadowId : null,
    projectionDigest: n.shadowResult && n.shadowResult.projection ? n.shadowResult.projection.projectionDigest : null,
    status: 'refused', mutated: false, durable: false,
    blockers: [{ code, detail }],
    reconciliationOutcome: 'none',
  }, extra || {}));
  const stale = (code, detail) => buildActiveResult({
    taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId, generation: n.generation,
    checkpointId: n.shadowResult && n.shadowResult.checkpoint ? n.shadowResult.checkpoint.checkpointId : null,
    operationId: n.shadowResult && n.shadowResult.projection ? n.shadowResult.projection.operationId : null,
    shadowId: n.shadowResult && n.shadowResult.shadowId ? n.shadowResult.shadowId : null,
    projectionDigest: n.shadowResult && n.shadowResult.projection ? n.shadowResult.projection.projectionDigest : null,
    status: 'stale', mutated: false, durable: false,
    blockers: [{ code, detail }],
    reconciliationOutcome: 'none',
  });

  // §8: only a proven shadow-ready result may proceed. Anything else REFUSES
  // before any observation, persistence, or mutation.
  const shadowCheck = shadowV2.validateShadowResultV2(n.shadowResult);
  if (!shadowCheck.valid) return refused('active-shadow-unproven', 'shadow result refused (' + shadowCheck.reason + ')');
  if (n.shadowResult.verdict !== 'shadow-ready') {
    return refused('active-shadow-not-ready', 'shadow verdict is ' + n.shadowResult.verdict + ' (only shadow-ready may apply)');
  }
  if (n.shadowResult.taskId !== n.taskId
    || n.shadowResult.taskInstanceId !== n.taskInstanceId
    || n.shadowResult.sessionId !== n.sessionId
    || n.shadowResult.generation !== n.generation) {
    return refused('active-shadow-unproven', 'shadow result binds another task binding or generation');
  }

  const descriptor = n.shadowResult.checkpoint;
  const shadowProjection = n.shadowResult.projection;
  if (!descriptor || typeof descriptor !== 'object') return refused('active-shadow-unproven', 'shadow checkpoint descriptor is missing');
  if (!shadowProjection || typeof shadowProjection !== 'object') return refused('active-shadow-unproven', 'shadow projection is missing');

  // Sealed checkpoint leg: real A04 validation + identity binding to the
  // shadow descriptor. Unsealed or mismatched checkpoints BLOCK.
  let sealCheck = null;
  try {
    sealCheck = trustV2.validateSealedCheckpoint(n.sealedCheckpoint);
  } catch (error) {
    return refused('active-seal-invalid', 'seal validation failed (' + String((error && error.message) || error).slice(0, 200) + ')');
  }
  if (!sealCheck.valid) return refused('active-seal-invalid', 'sealed checkpoint refused (' + sealCheck.reason + ')');
  if (n.sealedCheckpoint.checkpointId !== descriptor.checkpointId
    || n.sealedCheckpoint.checkpointContentDigest !== descriptor.checkpointContentDigest
    || Number(n.sealedCheckpoint.generation) !== Number(n.generation)) {
    return refused('active-checkpoint-mismatch', 'sealed checkpoint does not match the shadow descriptor');
  }

  // Projection artifact leg: structural self-proof first (digest recompute
  // over the artifact body; payload digest gate). A corrupt artifact is a
  // refusal, not staleness: no live comparison can repair it.
  const artifact = n.projectionArtifact;
  let payloadText = null;
  try {
    payloadText = shadowV2.checkpointPayloadTextOf(n.sealedCheckpoint);
  } catch (error) {
    return refused('active-projection-unproven', 'payload digest unproven (' + String((error && error.message) || error).slice(0, 200) + ')');
  }
  if (typeof artifact.payloadText !== 'string' || artifact.payloadText !== payloadText) {
    return refused('active-projection-mismatch', 'artifact payload bytes differ from the sealed checkpoint bytes');
  }
  if (artifact.projectionDigest !== shadowProjection.projectionDigest) {
    return refused('active-projection-mismatch', 'artifact digest differs from the shadow projection digest');
  }
  if (artifact.operationId !== shadowProjection.operationId) {
    return refused('active-projection-mismatch', 'artifact operation differs from the shadow operation');
  }
  if (canonicalOf(artifact.segments) !== canonicalOf(shadowProjection.segments)) {
    return refused('active-projection-mismatch', 'artifact segments differ from the shadow segments');
  }
  // §16/§20: operation identity is derived, never invented; payload digest
  // must equal the checkpoint content digest (frozen A02 gate restated).
  let derivedOperationId = null;
  try {
    derivedOperationId = compactionV2.deriveCanonicalOperationIdV2(
      n.taskId, n.taskInstanceId, n.sessionId, n.generation, descriptor.checkpointId);
  } catch (error) {
    return refused('active-operation-mismatch', 'operation identity derivation failed');
  }
  if (derivedOperationId !== artifact.operationId) {
    return refused('active-operation-mismatch', 'artifact operation id is not the canonical derivation');
  }
  if (sha256HexUtf8(payloadText) !== descriptor.checkpointContentDigest) {
    return refused('active-checkpoint-mismatch', 'payload digest does not equal the checkpoint content digest');
  }

  // H1 mandatory cross-process serialization. The client invokes the frozen
  // lock authority (same file, same lease/owner semantics as production);
  // A10 only supplies binding identity and enforces the outcome. Acquire
  // happens BEFORE the final authoritative observation per the required
  // order: acquire -> re-read -> validate -> intent -> apply -> flush ->
  // verify -> release. No client, or a failed acquire, REFUSES with
  // mutated=false (never silent proceed).
  const lockClient = n.serialization && typeof n.serialization === 'object' ? n.serialization : null;
  const lockUsable = lockClient !== null
    && typeof lockClient.acquire === 'function'
    && typeof lockClient.renew === 'function'
    && typeof lockClient.release === 'function';
  const serialRefused = (code, detail) => buildActiveResult({
    taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId, generation: n.generation,
    checkpointId: descriptor.checkpointId,
    operationId: artifact.operationId,
    shadowId: n.shadowResult.shadowId,
    projectionDigest: artifact.projectionDigest,
    status: 'refused', mutated: false, durable: false,
    blockers: [{ code, detail }],
    reconciliationOutcome: 'none',
  });
  if (!lockUsable) {
    return serialRefused('active-serialization-unavailable', 'mandatory apply serialization client is absent or malformed (REFUSE: never proceed unserialized)');
  }
  // Lease rule is owned by the lock client module (single definition).
  const lockLeaseSeconds = lockClientV2.normalizeLeaseSeconds(n.lockLeaseSeconds);
  let lockOwnerId = null;
  try {
    const acquired = await lockClient.acquire({
      taskId: n.taskId,
      taskInstanceId: n.taskInstanceId,
      sessionId: n.sessionId,
      operationId: artifact.operationId,
      leaseSeconds: lockLeaseSeconds,
    });
    if (!acquired || acquired.acquired !== true) {
      return serialRefused('active-serialization-conflict', 'apply serialization held by another owner (' + ((acquired && acquired.reason) || 'unknown') + ') (REFUSE: never run a second writer)');
    }
    lockOwnerId = typeof acquired.ownerId === 'string' ? acquired.ownerId : null;
  } catch (error) {
    return serialRefused('active-serialization-unavailable', 'apply serialization acquire failed (' + String((error && error.message) || error).slice(0, 200) + ')');
  }
  try {

  // Live-session observation (read-only clones). Captured once, up front,
  // and reused by the freshness barrier, the draft probe, and post-apply
  // verification, so every leg reasons about the same observation.
  let liveEvents = null;
  let liveSurface = null;
  try {
    liveEvents = liveEventsOf(n.session).map((e) => JSON.parse(JSON.stringify(e)));
    liveSurface = liveSurfaceOf(n.session);
  } catch (error) {
    return stale('active-shadow-stale', 'live session observation failed');
  }
  const rawPrefixCount = liveEvents.length;
  let liveMessagesBefore = null;
  try {
    liveMessagesBefore = deriveLiveMessages(n.session);
  } catch (error) {
    return stale('active-shadow-stale', 'live projection observation failed');
  }

  // Reconcile-first probe (pure, read-only, no persistence, no mutation).
  // A lightweight operation view suffices: reconcile cites segments,
  // identity, and the digest gate verbatim, never persistence.
  //   probe 'apply'          -> fresh path (full revalidation + barrier).
  //   probe landed / partial -> forward-recovery path (durability + verify).
  //   probe 'block'          -> fail closed before any persistence.
  // This ordering is what makes idempotent retry converge to recovered
  // instead of staling on our own committed surface.
  let probe = null;
  try {
    probe = compactionV2.reconcileCompactionOperationV2({
      schemaVersion: 2,
      operationId: artifact.operationId,
      checkpointContentDigest: descriptor.checkpointContentDigest,
      checkpointGeneration: n.generation,
      segments: artifact.segments,
    }, n.session, { payloadText, durable: false });
  } catch (error) {
    probe = { decision: 'block', reason: 'reconcile-probe-failed' };
  }
  if (!probe || probe.decision === 'block') {
    return buildActiveResult({
      taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId, generation: n.generation,
      checkpointId: descriptor.checkpointId,
      operationId: artifact.operationId,
      shadowId: n.shadowResult.shadowId,
      projectionDigest: artifact.projectionDigest,
      sourceBoundary: descriptor.safePointBoundarySeq,
      segmentCount: artifact.segments.length,
      sourceEventCount: artifact.segments.reduce((acc, s) => acc + (Array.isArray(s.sourceEventSeqs) ? s.sourceEventSeqs.length : 0), 0),
      beforeMessageCount: liveMessagesBefore.length,
      status: 'failed', mutated: false, durable: false,
      blockers: [{ code: 'active-recovery-blocked', detail: 'reconciliation blocks (' + ((probe && probe.reason) || 'unknown') + ')' }],
      reconciliationOutcome: (probe && probe.reason) || 'block',
    });
  }
  const recoveryMode = probe.decision !== 'apply';

  if (!recoveryMode) {

  // §9 revalidation legs (existing validators, verbatim; never redefined).
  // Any leg that moved since the shadow observation yields STALE: no live
  // mutation, no durable operation required.
  if (Number(n.snapshotToken.generation) !== Number(n.generation)) return stale('active-generation-drift', 'snapshot token binds another generation');
  let snapshotStructural = null;
  try {
    snapshotStructural = snapshotV2.validateSnapshotToken(n.snapshotToken);
  } catch (error) {
    return stale('active-snapshot-stale', 'snapshot token validation failed');
  }
  if (!snapshotStructural.valid) return stale('active-snapshot-stale', 'snapshot token refused (' + snapshotStructural.reason + ')');
  let fresh = null;
  try {
    // The final pre-mutation gate invokes the SnapshotManager rule verbatim.
    fresh = snapshotV2.revalidateBeforeMutation(n.snapshotToken, n.snapshotCurrentState);
  } catch (error) {
    return stale('active-snapshot-stale', 'snapshot revalidation failed');
  }
  if (!fresh.valid) return stale('active-snapshot-stale', 'snapshot is stale (' + fresh.reason + ')');

  let safeStructural = null;
  try {
    safeStructural = safepointV2.validateSafePointDecision(n.safePointDecision);
  } catch (error) {
    return stale('active-boundary-mismatch', 'safe-point validation failed');
  }
  if (!safeStructural.valid) return stale('active-boundary-mismatch', 'safe-point decision refused (' + safeStructural.reason + ')');
  if (n.safePointDecision.safe !== true) return stale('active-boundary-mismatch', 'safe point is not safe');
  if (Number(n.safePointDecision.boundarySeq) !== Number(descriptor.safePointBoundarySeq)) {
    return stale('active-boundary-mismatch', 'live boundary moved since the shadow observation');
  }
  let bindsSafe = null;
  try {
    bindsSafe = safepointV2.assertCheckpointBindsSafePoint(n.sealedCheckpoint, n.safePointDecision);
  } catch (error) {
    return stale('active-boundary-mismatch', 'checkpoint/safe-point binding failed');
  }
  if (!bindsSafe.ok) return stale('active-boundary-mismatch', 'checkpoint does not bind the live safe point (' + bindsSafe.reason + ')');

  let gateStructural = null;
  try {
    gateStructural = gateV2.validateCheckpointabilityDecision(n.checkpointabilityDecision);
  } catch (error) {
    return refused('active-checkpointability-required', 'checkpointability validation failed');
  }
  if (!gateStructural.valid) return refused('active-checkpointability-required', 'checkpointability refused (' + gateStructural.reason + ')');
  if (n.checkpointabilityDecision.checkpointable !== true) {
    return refused('active-checkpointability-required', 'binding is not checkpointable');
  }
  let coverage = null;
  try {
    coverage = gateV2.assertCheckpointCoverageV2({
      schemaVersion: 1,
      taskState: n.taskState,
      checkpoint: n.sealedCheckpoint,
      safePointDecision: n.safePointDecision,
      snapshotToken: n.snapshotToken,
    });
  } catch (error) {
    return refused('active-coverage-mismatch', 'coverage verification failed');
  }
  if (!coverage || coverage.ok !== true) {
    return refused('active-coverage-mismatch', 'checkpoint does not cover the live task state (' + ((coverage && coverage.reason) || 'unknown') + ')');
  }

  // Pressure basis + provider/model route leg: silent route/basis drift
  // never applies an old projection.
  const liveProviderModelId = n.pressureDecision && n.pressureDecision.providerModelId !== undefined
    ? n.pressureDecision.providerModelId : null;
  if (liveProviderModelId !== n.shadowResult.providerModelId) {
    return stale('active-route-drift', 'provider/model route moved since the shadow observation');
  }
  const liveBasis = n.retentionPlan && n.retentionPlan.pressureBasisDigest !== undefined
    ? n.retentionPlan.pressureBasisDigest : null;
  if (liveBasis !== n.shadowResult.pressureBasisDigest) {
    return stale('active-retention-stale', 'pressure basis moved since the shadow observation');
  }
  if (n.pressureDecision.known === false || n.pressureDecision.level === 'UNKNOWN') {
    return stale('active-pressure-unknown', 'live pressure capacity is unknown');
  }

  // Retention leg: verbatim plan validation + freshness + actionability.
  let planStructural = null;
  try {
    planStructural = retentionV2.validateRetentionPlan(n.retentionPlan);
  } catch (error) {
    return stale('active-retention-stale', 'retention plan validation failed');
  }
  if (!planStructural.valid) return stale('active-retention-stale', 'retention plan refused (' + planStructural.reason + ')');
  if (n.retentionPlan.actionable !== true) {
    return stale('active-retention-not-actionable', 'live retention plan is not actionable');
  }
  let planFresh = null;
  try {
    planFresh = retentionV2.assertRetentionPlanFresh(n.retentionPlan, {
      snapshotTokenId: n.snapshotToken.snapshotTokenId,
      revisionDigest: n.snapshotToken.revisionDigest,
      safePointBoundarySeq: n.safePointDecision.boundarySeq,
      generation: n.generation,
      providerModelId: liveProviderModelId,
      providerCapacityTokens: n.retentionPlan.providerCapacityTokens,
      pressureBasisDigest: liveBasis,
    });
  } catch (error) {
    return stale('active-retention-stale', 'retention freshness check failed');
  }
  if (!planFresh.ok) return stale('active-retention-stale', 'retention plan is stale (' + planFresh.reason + ')');
  if (n.retentionPlan.retentionPlanId !== n.shadowResult.retentionPlanId) {
    return stale('active-retention-stale', 'retention plan identity moved since the shadow observation');
  }
  // NOTE: the retention candidate cut legitimately sits AT OR BELOW the
  // safe boundary (prefix rule); equality is never required. Binding is
  // proven by assertRetentionPlanFresh (same safe point), the plan-identity
  // match, and the rebuild barrier (same segments) below.

  // Generation + shadow-result freshness legs.
  if (Number(n.taskState.generation) !== Number(n.generation)) {
    return stale('active-generation-drift', 'live generation moved since the shadow observation');
  }
  let shadowFresh = null;
  try {
    shadowFresh = shadowV2.assertShadowResultFresh(n.shadowResult, {
      taskId: n.taskId,
      taskInstanceId: n.taskInstanceId,
      sessionId: n.sessionId,
      generation: n.generation,
      snapshotTokenId: n.snapshotToken.snapshotTokenId,
      revisionDigest: n.snapshotToken.revisionDigest,
      safePointBoundarySeq: n.safePointDecision.boundarySeq,
      providerModelId: liveProviderModelId,
      pressureBasisDigest: liveBasis,
      retentionPlanId: n.retentionPlan.retentionPlanId,
    });
  } catch (error) {
    return stale('active-shadow-stale', 'shadow freshness check failed');
  }
  if (!shadowFresh.ok) return stale('active-shadow-stale', 'shadow result is stale (' + shadowFresh.reason + ')');

  // §11 pre-apply freshness barrier: the up-front observation is rebuilt
  // here through the shared A09H builder and requires byte-exact agreement
  // with the shadow prediction. Anything moved -> NO LIVE MUTATION.
  // Observation, persistence, and mutation below run with no interleaving
  // await in between (all synchronous), so the in-process TOCTOU window is
  // closed; cross-process races converge through A02 reconciliation below.
  let rebuilt = null;
  try {
    rebuilt = shadowV2.buildCompactedProjectionV2({
      schemaVersion: 1,
      taskId: n.taskId,
      taskInstanceId: n.taskInstanceId,
      sessionId: n.sessionId,
      generation: n.generation,
      sealedCheckpoint: JSON.parse(JSON.stringify(n.sealedCheckpoint)),
      retentionPlan: JSON.parse(JSON.stringify(n.retentionPlan)),
      snapshotToken: JSON.parse(JSON.stringify(n.snapshotToken)),
      taskState: JSON.parse(JSON.stringify(n.taskState)),
      contextUnits: JSON.parse(JSON.stringify(n.contextUnits)),
      // A12-4: pass the live events UNFILTERED. Host-only end-seed markers
      // are unsurfaced and semantically neutral (zero tool delta, never a
      // runtime snapshot, excluded from the shadowed set either way), so
      // filtering them is a no-op for planning but FATAL for positional
      // eventBySeq lookup: removing mid-log markers shifts array positions
      // and every later lookup misses (false "no segments" stale). The
      // build-time observation uses the same unfiltered log, so digest
      // equality still governs end-to-end and real drift still fails closed.
      sourceEvents: liveEvents,
      surfaceNodes: surfaceWithoutRestoreMarkers(liveSurface, liveEvents),
      protocolSpans: n.protocolSpans === undefined || n.protocolSpans === null
        ? [] : JSON.parse(JSON.stringify(n.protocolSpans)),
    });
  } catch (error) {
    return stale('active-shadow-stale', 'live state no longer yields the shadow projection (' + String((error && error.message) || error).slice(0, 200) + ')');
  }
  if (rebuilt.projectionDigest !== artifact.projectionDigest) {
    return stale('active-shadow-stale', 'live projection digest moved since the shadow observation');
  }
  if (canonicalOf(rebuilt.projectedMessages) !== canonicalOf(artifact.projectedMessages)) {
    return stale('active-shadow-stale', 'live projected messages moved since the shadow observation');
  }
  if (canonicalOf(rebuilt.segments) !== canonicalOf(artifact.segments)) {
    return stale('active-shadow-stale', 'live segments moved since the shadow observation');
  }

  } // end fresh-only revalidation + rebuild barrier (recovery converges via post-verify)

  // §12 checkpoint durable persistence BEFORE history is hidden: build the
  // canonical sealed bytes, persist immutably, read back, validate bytes /
  // identity / seal. Read-back conflict (same generation, different bytes)
  // FAILS CLOSED and never overwrites.
  const failed = (code, detail, extra) => buildActiveResult(Object.assign({
    taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId, generation: n.generation,
    checkpointId: descriptor.checkpointId,
    operationId: artifact.operationId,
    shadowId: n.shadowResult.shadowId,
    projectionDigest: artifact.projectionDigest,
    sourceBoundary: descriptor.safePointBoundarySeq,
    segmentCount: artifact.segments.length,
    sourceEventCount: artifact.segments.reduce((acc, s) => acc + (Array.isArray(s.sourceEventSeqs) ? s.sourceEventSeqs.length : 0), 0),
    beforeMessageCount: liveMessagesBefore.length,
    status: 'failed', mutated: false, durable: false,
    blockers: [{ code, detail }],
    reconciliationOutcome: 'none',
  }, extra || {}));

  let sealedSerialized = null;
  try {
    sealedSerialized = checkpointV2.serializeCheckpointCanonical(n.sealedCheckpoint);
  } catch (error) {
    return failed('active-persist-failed', 'sealed checkpoint serialization failed');
  }
  try {
    const stored = trustV2.persistSealedCheckpointV2(n.checkpointDir, {
      checkpoint: JSON.parse(JSON.stringify(n.sealedCheckpoint)),
      serialized: sealedSerialized,
    });
    if (!stored || stored.serialized !== sealedSerialized) {
      return failed('active-checkpoint-conflict', 'checkpoint read-back bytes differ (BLOCK/KEEP)');
    }
  } catch (error) {
    const message = String((error && error.message) || error);
    if (message.indexOf('refusing to overwrite') !== -1) {
      return failed('active-checkpoint-conflict', 'same generation persists different bytes (BLOCK/KEEP)');
    }
    return failed('active-persist-failed', 'checkpoint persistence failed (' + message.slice(0, 200) + ')');
  }

  // §15/§16 operation construction directly from the validated projection.
  // No independent segment planning; operation identity is the canonical
  // derivation (already proven equal above).
  const workspace = typeof n.workspace === 'string' && n.workspace !== '' ? n.workspace
    : (n.taskState.workspaceId || n.taskState.workspace || 'unknown-workspace');
  const repositoryId = n.repositoryId !== undefined && n.repositoryId !== null ? n.repositoryId
    : (n.taskState.repositoryId === undefined ? null : n.taskState.repositoryId);
  const checkoutId = n.checkoutId !== undefined && n.checkoutId !== null ? n.checkoutId
    : (n.taskState.checkoutId === undefined ? null : n.taskState.checkoutId);
  const unioned = [];
  for (const seg of artifact.segments) {
    for (const seq of seg.sourceEventSeqs) unioned.push(seq);
  }
  unioned.sort((a, b) => a - b);
  const draft = {
    schemaVersion: 2,
    operationId: artifact.operationId,
    attemptId: deriveAttemptIdV2(artifact.operationId, n.attemptId),
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    workspace,
    repositoryId,
    checkoutId,
    checkpointGeneration: n.generation,
    checkpointId: descriptor.checkpointId,
    checkpointContentDigest: descriptor.checkpointContentDigest,
    checkpointPath: null,
    snapshotTokenId: n.snapshotToken.snapshotTokenId,
    safePointBoundarySeq: descriptor.safePointBoundarySeq,
    sourceEventSeqs: unioned,
    segments: JSON.parse(JSON.stringify(artifact.segments)),
    lifecycle: 'frozen',
  };
  const expected = {
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    workspace,
    repositoryId,
    checkoutId,
    checkpointGeneration: n.generation,
    checkpointId: descriptor.checkpointId,
  };
  if (canonicalOf(draft.segments) !== canonicalOf(artifact.segments)) {
    return failed('active-operation-mismatch', 'operation segments differ from the proven projection (BLOCK BEFORE MUTATION)');
  }
  let opStructural = null;
  try {
    opStructural = compactionV2.validateCompactionOperationV2(draft, expected);
  } catch (error) {
    return failed('active-operation-mismatch', 'operation validation failed');
  }
  if (!opStructural.valid) return failed('active-operation-mismatch', 'operation refused (' + opStructural.reason + ') (BLOCK BEFORE MUTATION)');
  // Regime-2 binding (A09H digest-proven payload, §20): the operation
  // carries checkpoint id/generation/digest as exact fields, and the payload
  // bytes are the A03 canonical WITHOUT-identity bytes proven by sha256
  // equality -- the same gate A02 reconcile/apply enforce. The regime-1
  // full-serialized binding helpers (assertSealedOperationBindsCheckpointV2,
  // which require the payload to carry its own id/digest) do NOT apply to
  // digest-proven payloads and are intentionally not used here: sha256 of a
  // self-carrying byte string can never equal its own content digest.
  if (draft.checkpointId !== n.sealedCheckpoint.checkpointId
    || Number(draft.checkpointGeneration) !== Number(n.sealedCheckpoint.generation)
    || draft.checkpointContentDigest !== n.sealedCheckpoint.checkpointContentDigest) {
    return failed('active-operation-mismatch', 'operation does not bind the sealed checkpoint identity (BLOCK BEFORE MUTATION)');
  }
  if (sha256HexUtf8(payloadText) !== draft.checkpointContentDigest) {
    return failed('active-operation-mismatch', 'payload digest does not equal the operation checkpoint digest (BLOCK BEFORE MUTATION)');
  }
  let reproven = null;
  try {
    reproven = shadowV2.checkpointPayloadTextOf(n.sealedCheckpoint);
  } catch (error) {
    return failed('active-operation-mismatch', 'payload bytes unproven against the sealed checkpoint');
  }
  if (reproven !== payloadText) {
    return failed('active-operation-mismatch', 'payload bytes are not the sealed checkpoint bytes (BLOCK BEFORE MUTATION)');
  }

  // §17 durable intent before mutation: refuse to overwrite a conflicting
  // operation, reuse an identical one (idempotent retry), else freeze
  // (construct -> closed-world validate -> atomic persist -> read back ->
  // validate durable bytes -> brand). Only the branded read-back handle may
  // mutate the session (A05H proof, enforced inside A02 apply).
  let durableOp = null;
  try {
    const prior = compactionV2.readCompactionOperationV2(n.operationDir);
    if (prior !== null) {
      if (prior.operationId !== draft.operationId) {
        return failed('active-operation-conflict', 'another operation owns this generation (BLOCK/KEEP)', { intentDurable: true });
      }
      if (JSON.stringify(prior) !== JSON.stringify(draft)) {
        return failed('active-operation-conflict', 'same operation id persists different bytes (BLOCK/KEEP)', { intentDurable: true });
      }
      durableOp = prior;
    }
  } catch (error) {
    return failed('active-operation-conflict', 'prior operation unreadable (BLOCK/KEEP): ' + String((error && error.message) || error).slice(0, 200));
  }
  if (durableOp === null) {
    try {
      durableOp = compactionV2.freezeCompactionOperationV2(n.operationDir, draft, expected);
    } catch (error) {
      const message = String((error && error.message) || error);
      if (message.indexOf('refusing') !== -1 || message.indexOf('immutable') !== -1 || message.indexOf('differs') !== -1) {
        return failed('active-operation-conflict', message.slice(0, 300), { intentDurable: true });
      }
      return failed('active-persist-failed', 'operation freeze failed (' + message.slice(0, 200) + ')');
    }
  }

  // H1 ownership gate (controller §14 family): prove this process still
  // owns the lease after durable intent and before the first append. A lost
  // lease means another owner may interleave -> do NOT apply. Intent is
  // already durable, so this failure carries intentDurable (recoverable)
  // with mutated=false. Like everything else under the lock, the renew
  // call is awaited while holding the in-process chain slot.
  if (typeof lockOwnerId !== 'string' || lockOwnerId === '') {
    return failed('active-serialization-unavailable', 'lock owner identity missing; refusing to apply (recoverable intent)', { intentDurable: true });
  }
  try {
    const owned = await lockClient.renew({
      taskId: n.taskId,
      taskInstanceId: n.taskInstanceId,
      sessionId: n.sessionId,
      operationId: artifact.operationId,
      ownerId: lockOwnerId,
      leaseSeconds: lockLeaseSeconds,
    });
    if (!owned || owned.renewed !== true) {
      return failed('active-serialization-conflict', 'apply lock ownership lost after durable intent (' + ((owned && owned.reason) || 'unknown') + '); refusing to apply (recoverable intent)', { intentDurable: true });
    }
  } catch (error) {
    return failed('active-serialization-unavailable', 'apply lock renewal failed after durable intent (' + String((error && error.message) || error).slice(0, 200) + '); refusing to apply (recoverable intent)', { intentDurable: true });
  }

  // Reconcile-first (§30/§31/§34-§36): never blindly apply. An already-landed
  // operation converges to recovered; a partial landing retries exactly the
  // missing segments; only a clean operation applies fully.
  const baseFields = {
    taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId, generation: n.generation,
    checkpointId: descriptor.checkpointId,
    operationId: artifact.operationId,
    shadowId: n.shadowResult.shadowId,
    projectionDigest: artifact.projectionDigest,
    sourceBoundary: descriptor.safePointBoundarySeq,
    segmentCount: artifact.segments.length,
    sourceEventCount: unioned.length,
    beforeMessageCount: liveMessagesBefore.length,
    beforeTokenEstimate: shadowProjection.beforeContextTokens === undefined ? null : shadowProjection.beforeContextTokens,
    afterTokenEstimate: shadowProjection.projectedContextTokens === undefined ? null : shadowProjection.projectedContextTokens,
  };
  let reconcile = null;
  try {
    reconcile = compactionV2.reconcileCompactionOperationV2(durableOp, n.session, { payloadText, durable: false });
  } catch (error) {
    return failed('active-recovery-blocked', 'reconciliation failed (' + String((error && error.message) || error).slice(0, 200) + ')', { intentDurable: true });
  }
  if (!reconcile || reconcile.decision === 'block') {
    return failed('active-recovery-blocked', 'reconciliation blocks (' + ((reconcile && reconcile.reason) || 'unknown') + ')', { intentDurable: true, reconciliationOutcome: (reconcile && reconcile.reason) || 'block' });
  }

  const flushBarrier = async () => {
    if (typeof n.flushFn !== 'function') return { ok: false, reason: 'active-flush-unavailable' };
    try {
      const participated = await n.flushFn(n.session);
      if (participated !== true) return { ok: false, reason: 'active-flush-failed' };
      return { ok: true, reason: null };
    } catch (error) {
      return { ok: false, reason: 'active-flush-failed' };
    }
  };

  // Post-apply validation shared by every mutation path: actual
  // deriveMessages() must equal the shadow projectedMessages exactly;
  // current user exactly once; tool protocol balanced; raw log append-only;
  // payload bytes identical to the proven artifact bytes.
  const verifyPostApply = (reconciliationOutcome) => {
    let actualMessages = null;
    try {
      actualMessages = deriveLiveMessages(n.session);
    } catch (error) {
      return { ok: false, reason: 'post-apply readback failed', outcome: reconciliationOutcome };
    }
    // Shadow-vs-actual proof (§4/§44): content-exact equality modulo
    // volatile host-minted message ids (see stripMessageIds). Source-event
    // ids are identical both sides; replacement ids differ by minting
    // authority, so id-inclusive equality would mistake transport for
    // content. No semantic approximation anywhere: role, content, and
    // source must be byte-exact.
    if (canonicalMessagesOf(actualMessages) !== canonicalMessagesOf(artifact.projectedMessages)) {
      return { ok: false, reason: 'actual projection differs from the shadow projection', outcome: reconciliationOutcome };
    }
    // Structural digest recompute proves the expected digest still binds the
    // artifact whose messages the live surface now equals.
    const digestBody = {};
    const ARTIFACT_KEYS = ['schemaVersion', 'taskId', 'taskInstanceId', 'sessionId', 'generation',
      'operationId', 'checkpointId', 'checkpointContentDigest', 'retentionPlanId',
      'sourceSnapshotTokenId', 'sourceRevisionDigest', 'candidateCompactionBoundarySeq',
      'segments', 'payloadText', 'replacementMessages', 'projectedEvents', 'projectedMessages'];
    for (const key of ARTIFACT_KEYS) digestBody[key] = artifact[key];
    const recomputed = sha256HexUtf8(shadowV2.SHADOW_PROJECTION_DIGEST_DOMAIN_V2 + LF_JOIN + canonicalOf(digestBody));
    if (recomputed !== artifact.projectionDigest) {
      return { ok: false, reason: 'projection digest recomputation failed', outcome: reconciliationOutcome };
    }
    // Current-user exactly once over the COMPLETE actual context.
    const currentUnits = (n.contextUnits || []).filter((u) => u && u.isCurrentUserTurn === true);
    if (currentUnits.length !== 1) return { ok: false, reason: 'current-user unit ambiguous', outcome: reconciliationOutcome };
    const currentTexts = [];
    for (const e of liveEvents) {
      if (Number.isInteger(e.seq) && e.seq >= currentUnits[0].eventSeqStart && e.seq <= currentUnits[0].eventSeqEnd) {
        const text = compactionV2.textContentOfEvent(e);
        if (typeof text === 'string' && text !== '') currentTexts.push(text);
      }
    }
    if (currentTexts.length === 0) return { ok: false, reason: 'current-user text unproven', outcome: reconciliationOutcome };
    const joinedActual = actualMessages.map((m) => {
      const texts = [];
      const walk = (v) => {
        if (typeof v === 'string') { texts.push(v); return; }
        if (Array.isArray(v)) { for (const entry of v) walk(entry); return; }
        if (v !== null && typeof v === 'object') {
          if (typeof v.text === 'string' && v.type === 'text') texts.push(v.text);
          else { for (const k of Object.keys(v)) { if (k !== 'id') walk(v[k]); } }
        }
      };
      walk(m);
      return texts.join('\n');
    }).join('\n');
    for (const text of currentTexts) {
      if (joinedActual.split(text).length - 1 !== 1) {
        return { ok: false, reason: 'current user is not exactly once in the actual context', outcome: reconciliationOutcome };
      }
    }
    // Tool protocol over the FINAL actual projection (same proof as A09H).
    if (shadowV2.checkMessagesBalanced(actualMessages) !== true) {
      return { ok: false, reason: 'actual tool protocol is unbalanced', outcome: reconciliationOutcome };
    }
    // Payload representation present exactly once (required-state survival
    // through the checkpoint representation, as A09 predicted: byte identity
    // with the proven artifact payload carries the A09H continuation proof).
    if (joinedActual.split(payloadText).length - 1 !== 1) {
      return { ok: false, reason: 'checkpoint payload is not exactly once in the actual context', outcome: reconciliationOutcome };
    }
    // Raw-log append-only: the pre-apply prefix is historically present.
    const postEvents = liveEventsOf(n.session);
    if (postEvents.length < rawPrefixCount) {
      return { ok: false, reason: 'raw log prefix was truncated', outcome: reconciliationOutcome };
    }
    for (let i = 0; i < rawPrefixCount; i += 1) {
      if (JSON.stringify(postEvents[i]) !== JSON.stringify(liveEvents[i])) {
        return { ok: false, reason: 'raw log prefix was rewritten', outcome: reconciliationOutcome };
      }
    }
    return { ok: true, reason: null, outcome: reconciliationOutcome, afterMessageCount: actualMessages.length };
  };

  // H3: committed/recovered prove BOTH legs; ambiguous post-intent failure
  // proves intent only (application durability is exactly what failed).
  const commitFields = (reconciliationOutcome, verify) => buildActiveResult(Object.assign({}, baseFields, {
    afterMessageCount: verify.afterMessageCount,
    status: 'committed', mutated: true, intentDurable: true, applicationDurable: true,
    blockers: [],
    reconciliationOutcome,
  }));
  const recoveredFields = (reconciliationOutcome, verify) => buildActiveResult(Object.assign({}, baseFields, {
    afterMessageCount: verify.afterMessageCount,
    status: 'recovered', mutated: false, intentDurable: true, applicationDurable: true,
    blockers: [],
    reconciliationOutcome,
  }));
  const ambiguousFailure = (code, detail, reconciliationOutcome) => buildActiveResult(Object.assign({}, baseFields, {
    status: 'failed', mutated: true, intentDurable: true, applicationDurable: false,
    blockers: [{ code, detail }],
    reconciliationOutcome: reconciliationOutcome || 'ambiguous-mutation',
  }));

  // Case A: fully landed already -> prove durability, verify, recover without
  // any new mutation (§36 idempotent retry).
  if (reconcile.decision === 'applied' || reconcile.decision === 'awaiting-durability') {
    const flush = await flushBarrier();
    if (!flush.ok) {
      if (flush.reason === 'active-flush-unavailable') {
        return failed('active-flush-unavailable', 'durability barrier unavailable; cannot claim COMMITTED', { intentDurable: true, reconciliationOutcome: reconcile.reason });
      }
      return ambiguousFailure('active-flush-failed', 'flush failed after a complete landing; operation remains durable and recoverable', reconcile.reason);
    }
    const durableReconcile = compactionV2.reconcileCompactionOperationV2(durableOp, n.session, { payloadText, durable: true });
    if (!durableReconcile || (durableReconcile.decision !== 'applied' && durableReconcile.decision !== 'awaiting-durability')) {
      return ambiguousFailure('active-recovery-blocked', 'complete landing lost durability proof (' + ((durableReconcile && durableReconcile.reason) || 'unknown') + ')', reconcile.reason);
    }
    const verify = verifyPostApply(durableReconcile.decision === 'applied' ? 'applied' : 'awaiting-durability');
    if (!verify.ok) return ambiguousFailure('active-post-apply-mismatch', verify.reason, verify.outcome);
    return recoveredFields(verify.outcome, verify);
  }

  // Case B: partial landing -> forward-recover exactly the missing segments,
  // then flush + verify (§35). Never another payload when it already landed.
  if (reconcile.decision === 'retry-missing') {
    let retry = null;
    try {
      retry = compactionV2.retryMissingSegmentsV2(n.session, durableOp, payloadText, durableOp, reconcile.missingSegments);
    } catch (error) {
      return ambiguousFailure('active-apply-failed', 'missing-segment retry failed (' + String((error && error.message) || error).slice(0, 200) + '); operation remains durable and recoverable', reconcile.reason);
    }
    const flush = await flushBarrier();
    if (!flush.ok) {
      if (flush.reason === 'active-flush-unavailable') {
        return ambiguousFailure('active-flush-unavailable', 'durability barrier unavailable after retry; operation remains durable and recoverable', 'retry-missing');
      }
      return ambiguousFailure('active-flush-failed', 'flush failed after retry; operation remains durable and recoverable', 'retry-missing');
    }
    const verify = verifyPostApply('retry-missing');
    if (!verify.ok) return ambiguousFailure('active-post-apply-mismatch', verify.reason, verify.outcome);
    return commitFields('retry-missing', verify);
  }

  // Case C: clean apply of the frozen operation (§19/§20: A02 applies; A10
  // orchestrates). Any throw after the first append is ambiguous by
  // construction -> durable recoverable failure, never a harmless report.
  if (reconcile.decision === 'apply') {
    try {
      compactionV2.applyCompactionOperationV2(n.session, durableOp, payloadText, durableOp);
    } catch (error) {
      return ambiguousFailure('active-apply-failed', 'apply failed (' + String((error && error.message) || error).slice(0, 200) + '); operation remains durable and recoverable', reconcile.reason);
    }
    const flush = await flushBarrier();
    if (!flush.ok) {
      if (flush.reason === 'active-flush-unavailable') {
        return ambiguousFailure('active-flush-unavailable', 'durability barrier unavailable after apply; operation remains durable and recoverable', 'apply');
      }
      return ambiguousFailure('active-flush-failed', 'flush failed after apply; operation remains durable and recoverable', 'apply');
    }
    const verify = verifyPostApply('apply');
    if (!verify.ok) return ambiguousFailure('active-post-apply-mismatch', verify.reason, verify.outcome);
    return commitFields('apply', verify);
  }

  return failed('active-recovery-blocked', 'unknown reconciliation decision (' + String(reconcile.decision) + ')', { intentDurable: true });
  } finally {
    // H1: best-effort idempotent release. The result stands regardless;
    // abandonment is lease-bounded by the lock authority itself.
    if (lockOwnerId !== null) {
      try { await lockClient.release({ taskId: n.taskId, ownerId: lockOwnerId }); } catch { /* best effort */ }
    }
  }
}

// ---- bounded telemetry (ids/digests/counts only; never payload text) --------

function activeApplyTelemetry(result) {
  const check = validateActiveResultV2(result);
  if (!check.valid) failActive('telemetry refused (' + check.reason + ')');
  return result.telemetry;
}

module.exports = {
  ACTIVE_APPLY_SCHEMA_VERSION,
  ACTIVE_APPLY_STATUSES,
  ACTIVE_APPLY_BLOCKER_CODES,
  ACTIVE_APPLY_INPUT_EXACT_KEYS,
  ACTIVE_RESULT_EXACT_KEYS,
  ACTIVE_RESULT_DIGEST_DOMAIN_V1,
  applyActiveCompactionV2,
  validateActiveResultV2,
  activeApplyTelemetry,
  deriveAttemptIdV2,
};
