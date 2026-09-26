'use strict';
/**
 * ContextShadowV2.cjs - CCV2-A09 ShadowCompactionEvaluatorV2 production authority.
 *
 * ONE orchestrator for V2 shadow mode: it observes the complete CCv2 decision
 * pipeline (A06 safe point, A05 snapshot freshness, A07 checkpointability,
 * A03 checkpoint build, A04 seal, A08 pressure + retention plan, A01
 * projection semantics) and reports what compaction WOULD produce, without
 * ever applying anything to the live Nexus session.
 *
 * A09H composition (frozen): the hypothetical projection is the COMPLETE
 * model-facing context A10 would expose -- exactly one checkpoint-payload
 * replacement node (A03 canonical content bytes, digest-proven) plus any
 * bounded continuation anchors plus the retained suffix in surface order.
 * Retained source suffix != complete post-compaction projection: the
 * payload representation participates in identity, costs, and validation.
 *
 * Core invariant (frozen):
 *
 *   SHADOW MAY PREDICT. SHADOW MAY COMPARE. SHADOW MAY REPORT.
 *   SHADOW MUST NOT APPLY.
 *
 * Authority separation (frozen): this module redefines NO lower-level
 * authority. A06/A05/A07/A03/A04/A08 verdicts are consumed verbatim through
 * their own validators. Pressure thresholds, retention eligibility,
 * safe-boundary classification, checkpointability coverage, snapshot
 * freshness, checkpoint identity, and seal integrity are never redefined
 * here. This module only orchestrates, constructs the hypothetical
 * projection through pure machinery, validates it, and reports.
 *
 * Production immutability (frozen): evaluateShadowCompactionV2() is pure
 * over its input object. It performs no session mutation, no projection
 * replacement, no context deletion, no checkpoint persistence, no
 * CompactionOperationV2 execution, no A02 reconciliation, no controller
 * prompt mutation, no model call, and no clock read. All timestamps
 * (createdAtUtc, sealedAtUtc) are explicit caller inputs so repeated
 * evaluation of identical state yields byte-identical results.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (A09 sections). NOT implemented here: A10 transactional active apply,
 * live session mutation, Phase B ContextPage, semantic retrieval, LLM
 * summarization, JEV / Laya, Nexus Nova.
 *
 * Determinism: no clock, no randomness, no LLM. Identical inputs rebuild
 * byte-identical shadow results, digests, and ids.
 *
 * Security: classification derives ONLY from authority metadata. Prompt,
 * tool-output, and repository TEXT are inert data: never branched on,
 * never copied into telemetry. Content-bearing input fields fail closed.
 * Secrets never enter shadow artifacts (frozen A03/A04 redaction).
 */

const crypto = require('node:crypto');

const compactionV2 = require('./ContextCompaction.cjs');
const checkpointV2 = require('./ContextCheckpointV2.cjs');
const snapshotV2 = require('./ContextSnapshotV2.cjs');
const trustV2 = require('./ContextTrustV2.cjs');
const safepointV2 = require('./ContextSafePointV2.cjs');
const gateV2 = require('./ContextCheckpointabilityV2.cjs');
const pressureV2 = require('./ContextPressureV2.cjs');
const retentionV2 = require('./ContextRetentionV2.cjs');

const SHADOW_SCHEMA_VERSION = 1;
const SHADOW_RESULT_DIGEST_DOMAIN_V1 = 'nexus/context-shadow-result/v1';
const SHADOW_RESULT_ID_DOMAIN_V1 = 'nexus/context-shadow-result-id/v1';
const SHADOW_PROJECTION_DIGEST_DOMAIN_V2 = 'nexus/context-projection/v2';
const LF_JOIN = String.fromCharCode(10);

// Frozen verdict taxonomy (section 22): exactly one verdict per result.
const SHADOW_VERDICTS = Object.freeze([
  'no-action',
  'blocked',
  'shadow-ready',
  'shadow-invalid',
]);

// Frozen shadow blocker codes (stable machine-readable refusal reasons).
const SHADOW_BLOCKER_CODES = Object.freeze([
  'shadow-input-invalid',
  'shadow-safe-point-required',
  'shadow-snapshot-required',
  'shadow-snapshot-stale',
  'shadow-checkpointability-required',
  'shadow-pressure-unknown',
  'shadow-pressure-none',
  'shadow-retention-not-actionable',
  'shadow-retention-insufficient-reclaim',
  'shadow-checkpoint-build-failed',
  'shadow-seal-invalid',
  'shadow-coverage-mismatch',
  'shadow-projection-current-user',
  'shadow-projection-protocol',
  'shadow-projection-suffix-mismatch',
  'shadow-projection-coverage',
  'shadow-projection-failed',
  'shadow-payload-unproven',
  'shadow-projection-messages',
  'shadow-continuation-incomplete',
]);

const SHADOW_PRECISIONS = Object.freeze(['exact', 'estimated', 'unknown']);

const SHADOW_BOUNDS = Object.freeze({
  taskId: 256,
  taskInstanceId: 256,
  sessionId: 256,
  detail: 1024,
  eventsMax: 100000,
  hex64: 64,
});

const SHADOW_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'generation',
  'snapshotToken',
  'snapshotCurrentState',
  'safePointDecision',
  'checkpointabilityDecision',
  'pressureDecision',
  'retentionPlan',
  'taskState',
  'parentCheckpointId',
  'contextUnits',
  'sessionEvents',
  'surfaceNodes',
  'protocolSpans',
  'createdAtUtc',
  'sealedAtUtc',
]);

const SHADOW_RESULT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'generation',
  'snapshotTokenId',
  'revisionDigest',
  'safePointBoundarySeq',
  'providerModelId',
  'pressureBasisDigest',
  'retentionPlanId',
  'safePoint',
  'checkpointability',
  'pressure',
  'retentionPlan',
  'checkpoint',
  'projection',
  'reclaimComparison',
  'verdict',
  'blockers',
  'shadowDigest',
  'shadowId',
]);

const SHADOW_CHECKPOINT_DESCRIPTOR_EXACT_KEYS = Object.freeze([
  'checkpointId',
  'checkpointContentDigest',
  'generation',
  'safePointBoundarySeq',
  'snapshotTokenId',
  'revisionDigest',
  'sealDigest',
  'checkpointBytes',
  'requiredItemCount',
  'coverageOk',
]);

const SHADOW_PROJECTION_EXACT_KEYS = Object.freeze([
  'attempted',
  'valid',
  'beforeEventCount',
  'projectedEventCount',
  'beforeMessageCount',
  'projectedMessageCount',
  'beforeContextTokens',
  'projectedContextTokens',
  'checkpointPayloadTokens',
  'retainedSuffixTokens',
  'projectedReclaimTokens',
  'precision',
  'currentUserMessageCountBefore',
  'currentUserMessageCountAfter',
  'protocolBalanced',
  'projectionDigest',
  'operationId',
  'segments',
]);

const SHADOW_RECLAIM_COMPARISON_EXACT_KEYS = Object.freeze([
  'a08PlannedReclaimTokens',
  'a09ProjectedReclaimTokens',
  'deltaTokens',
  'basisNote',
]);

const SHADOW_BLOCKER_EXACT_KEYS = Object.freeze(['code', 'detail']);

const SHADOW_PROJECTION_ARTIFACT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'generation',
  'operationId',
  'checkpointId',
  'checkpointContentDigest',
  'retentionPlanId',
  'sourceSnapshotTokenId',
  'sourceRevisionDigest',
  'candidateCompactionBoundarySeq',
  'segments',
  'payloadText',
  'replacementMessages',
  'projectedEvents',
  'projectedMessages',
  'projectionDigest',
]);

const SHADOW_SEGMENT_EXACT_KEYS = Object.freeze([
  'start',
  'end',
  'sourceEventSeqs',
  'role',
]);

function failShadow(message) {
  throw new Error('ccv2-shadow-v2: ' + message);
}

function unknownKeyOf(value, exactKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of Object.keys(value)) {
    if (exactKeys.indexOf(key) === -1) return key;
  }
  return null;
}

function isBoundedString(value, bound, allowNull) {
  if (value === null || value === undefined) return allowNull === true;
  if (typeof value !== 'string' || value === '') return false;
  return value.length <= bound;
}

function isIsoUtc(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function sha256HexUtf8(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function canonicalize(value) {
  return pressureV2.canonicalize(value);
}

function serializeCanonical(value) {
  return JSON.stringify(canonicalize(value));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortBlockers(blockers) {
  return blockers.slice().sort((a, b) => {
    if (a.code < b.code) return -1;
    if (a.code > b.code) return 1;
    const da = a.detail === null || a.detail === undefined ? '' : String(a.detail);
    const db = b.detail === null || b.detail === undefined ? '' : String(b.detail);
    if (da < db) return -1;
    if (da > db) return 1;
    return 0;
  });
}

// ---- input normalization (closed world; throws fail-closed) ----

// The authoritative model-visible surface order, supplied by the caller
// from the live host (session.surface.nodes) or, for host-free unit
// inputs, as the seqs of surface-eligible events in log order. Every node
// must resolve to a real event; resolution failure throws fail-closed.
function normalizeSurfaceNodes(raw, sessionEvents) {
  if (!Array.isArray(raw) || raw.length === 0) failShadow('surfaceNodes must be a non-empty array');
  if (raw.length > SHADOW_BOUNDS.eventsMax) failShadow('surfaceNodes exceeds the bound');
  const seen = Object.create(null);
  for (let i = 0; i < raw.length; i += 1) {
    const seq = raw[i];
    if (!Number.isInteger(seq) || seq < 0 || seq > 100000000) failShadow('surfaceNodes[' + i + '] must be a non-negative integer seq');
    if (seen[seq] === true) failShadow('surfaceNodes must not contain duplicates');
    seen[seq] = true;
    const event = Array.isArray(sessionEvents) ? sessionEvents[seq] : null;
    if (!event || event.seq !== seq) failShadow('surfaceNodes[' + i + '] does not resolve to a session event');
  }
  return raw.slice();
}

function normalizeContextUnits(raw) {
  if (!Array.isArray(raw) || raw.length === 0) failShadow('contextUnits must be a non-empty array');
  if (raw.length > 100000) failShadow('contextUnits exceeds the bound');
  let currentTurns = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const u = raw[i];
    if (!u || typeof u !== 'object' || Array.isArray(u)) failShadow('contextUnits[' + i + '] must be an object');
    if (typeof u.isCurrentUserTurn !== 'boolean') failShadow('contextUnits[' + i + '] isCurrentUserTurn must be boolean');
    if (!Number.isInteger(u.eventSeqStart) || !Number.isInteger(u.eventSeqEnd)) {
      failShadow('contextUnits[' + i + '] seqs must be integers');
    }
    if (u.isCurrentUserTurn === true) currentTurns += 1;
  }
  if (currentTurns !== 1) failShadow('exactly one current user turn is required');
  return raw;
}

function normalizeShadowInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) failShadow('input is required');
  for (const banned of ['text', 'content', 'prompt', 'message', 'transcript', 'importance', 'priority']) {
    if (input[banned] !== undefined) failShadow('content field ' + banned + ' is forbidden');
  }
  const unknown = unknownKeyOf(input, SHADOW_INPUT_EXACT_KEYS);
  if (unknown !== null) failShadow('unknown field ' + unknown);
  if (Number(input.schemaVersion) !== SHADOW_SCHEMA_VERSION) failShadow('schemaVersion must be 1');
  if (!isBoundedString(input.taskId, SHADOW_BOUNDS.taskId, false)) failShadow('taskId is required');
  if (!isBoundedString(input.taskInstanceId, SHADOW_BOUNDS.taskInstanceId, false)) failShadow('taskInstanceId is required');
  if (!isBoundedString(input.sessionId, SHADOW_BOUNDS.sessionId, false)) failShadow('sessionId is required');
  if (!Number.isInteger(input.generation) || input.generation < 1) failShadow('generation must be a positive integer');
  if (!input.snapshotToken || typeof input.snapshotToken !== 'object') failShadow('snapshotToken is required');
  if (!input.snapshotCurrentState || typeof input.snapshotCurrentState !== 'object') {
    failShadow('snapshotCurrentState is required');
  }
  if (!input.safePointDecision || typeof input.safePointDecision !== 'object') failShadow('safePointDecision is required');
  if (!input.checkpointabilityDecision || typeof input.checkpointabilityDecision !== 'object') {
    failShadow('checkpointabilityDecision is required');
  }
  if (!input.pressureDecision || typeof input.pressureDecision !== 'object') failShadow('pressureDecision is required');
  if (!input.retentionPlan || typeof input.retentionPlan !== 'object') failShadow('retentionPlan is required');
  if (!input.taskState || typeof input.taskState !== 'object') failShadow('taskState is required');
  if (!Array.isArray(input.sessionEvents)) failShadow('sessionEvents must be an array');
  if (input.sessionEvents.length > SHADOW_BOUNDS.eventsMax) failShadow('sessionEvents exceeds the bound');
  const spans = input.protocolSpans === undefined || input.protocolSpans === null ? [] : input.protocolSpans;
  if (!Array.isArray(spans)) failShadow('protocolSpans must be an array');
  if (typeof input.createdAtUtc !== 'string' || !isIsoUtc(input.createdAtUtc)) {
    failShadow('createdAtUtc must be explicit ISO-8601 UTC input');
  }
  if (typeof input.sealedAtUtc !== 'string' || !isIsoUtc(input.sealedAtUtc)) {
    failShadow('sealedAtUtc must be explicit ISO-8601 UTC input');
  }
  const units = normalizeContextUnits(input.contextUnits);
  const surfaceNodes = normalizeSurfaceNodes(input.surfaceNodes, input.sessionEvents);
  const parentCheckpointId = input.parentCheckpointId === undefined ? null : input.parentCheckpointId;
  if (parentCheckpointId !== null && (typeof parentCheckpointId !== 'string' || parentCheckpointId === '' || parentCheckpointId.length > 128)) {
    failShadow('parentCheckpointId must be null or a bounded checkpoint id');
  }
  if (input.generation === 1 && parentCheckpointId !== null) failShadow('first generation must carry parentCheckpointId=null');
  if (input.generation > 1 && parentCheckpointId === null) failShadow('generation>1 requires parentCheckpointId (A03 lineage)');
  return {
    schemaVersion: SHADOW_SCHEMA_VERSION,
    taskId: input.taskId,
    taskInstanceId: input.taskInstanceId,
    sessionId: input.sessionId,
    generation: input.generation,
    snapshotToken: input.snapshotToken,
    snapshotCurrentState: input.snapshotCurrentState,
    safePointDecision: input.safePointDecision,
    checkpointabilityDecision: input.checkpointabilityDecision,
    pressureDecision: input.pressureDecision,
    retentionPlan: input.retentionPlan,
    taskState: input.taskState,
    parentCheckpointId,
    contextUnits: units,
    sessionEvents: input.sessionEvents,
    surfaceNodes,
    protocolSpans: spans,
    createdAtUtc: input.createdAtUtc,
    sealedAtUtc: input.sealedAtUtc,
  };
}

// ---- pure compacted-projection machinery (reusable by A10; no policy) ----
// A09H: the hypothetical projection is the COMPLETE model-facing context
// the frozen A01/A02 machinery would expose after active compaction:
//
//   replacement payload node (checkpoint canonical bytes; exactly one
//   payload segment, earliest) [+ bounded continuation anchors for any
//   sibling segments] + retained suffix in surface order
//
// The payload text is FORCED by the frozen reconcile contract
// (sha256(payloadText) MUST equal checkpointContentDigest, enforced by
// the frozen A02 apply/reconcile gates): the only
// frozen byte string with that property is the A03 canonical content
// bytes (checkpoint minus checkpointId/checkpointContentDigest/seal, per
// checkpointPayloadWithoutIdentity in ContextCheckpointV2.cjs). Any other
// rendering fails the digest gate, so this composition is determination
// from existing machinery, not invention. Operation identity reuses the
// real deriveCanonicalOperationIdV2; segment roles reuse the real
// shapeSegmentsWithRoles; continuation anchors reuse the real
// buildContinuationAnchorText; the replaced-span splice mirrors the host
// applySurfacePlan (nodes.splice(startIdx, endIdx - startIdx + 1, seq));
// per-node message derivation mirrors the pinned dsh-session host
// deriveEventMessage verbatim (0.1.1-rc.2: user/message -> data,
// assistant/message -> data.message unless empty, tool/result ->
// data.message, else null). The live-host proof asserts the mirror equals
// the real host projection on live data, so drift fails loudly.
//
// A09 and A10 share this builder: A10 will later call
// buildCompactedProjectionV2, validate the artifact, and transactionally
// apply its replacement nodes. No separate shadow-only algorithm exists.

const COMPACTED_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'generation',
  'sealedCheckpoint',
  'retentionPlan',
  'snapshotToken',
  'taskState',
  'contextUnits',
  'sourceEvents',
  'surfaceNodes',
  'protocolSpans',
]);

const COMPACTED_EXPECT_EXACT_KEYS = Object.freeze([
  'taskId',
  'taskInstanceId',
  'sessionId',
  'generation',
  'operationId',
  'checkpointId',
  'checkpointContentDigest',
  'retentionPlanId',
  'sourceSnapshotTokenId',
  'sourceRevisionDigest',
  'candidateCompactionBoundarySeq',
  'retainedSuffixStartSeq',
  'sourceEvents',
  'surfaceNodes',
  'taskState',
  'contextUnits',
  'protocolSpans',
]);

function eventSeqOf(event) {
  if (event && typeof event === 'object' && Number.isInteger(event.seq)) return event.seq;
  return null;
}

// Frozen A03 content bytes (mirrors checkpointPayloadWithoutIdentity:
// identity and seal bind the digest but are NOT part of it; provenance IS).
// Self-proving: the hash MUST equal the sealed content digest, exactly the
// gate A02 reconciliation enforces before any apply.
function checkpointPayloadTextOf(sealedCheckpoint) {
  if (!sealedCheckpoint || typeof sealedCheckpoint !== 'object' || Array.isArray(sealedCheckpoint)) {
    failShadow('compacted sealed checkpoint is required');
  }
  if (typeof sealedCheckpoint.checkpointContentDigest !== 'string') failShadow('compacted checkpoint digest is required');
  const body = {};
  for (const key of Object.keys(sealedCheckpoint)) {
    if (key === 'checkpointId' || key === 'checkpointContentDigest' || key === 'seal') continue;
    body[key] = sealedCheckpoint[key];
  }
  const text = checkpointV2.serializeCheckpointCanonical(body);
  if (sha256HexUtf8(text) !== sealedCheckpoint.checkpointContentDigest) {
    failShadow('compacted payload digest unproven (reconcile gate would refuse)');
  }
  return text;
}

// Verbatim mirror of the pinned host deriveEventMessage (0.1.1-rc.2).
// Any host upgrade changing these lines must update this mirror AND the
// live equivalence proof together; divergence fails the live proof loudly.
function deriveProjectedMessageV2(event) {
  if (!event || typeof event !== 'object') return null;
  switch (event.type) {
    case 'user/message': return event.data;
    case 'assistant/message':
      if (!event.data || !event.data.message || !Array.isArray(event.data.message.content)) return null;
      if (event.data.message.content.length === 0) return null;
      return event.data.message;
    case 'tool/result':
      return event.data ? event.data.message : null;
    default: return null;
  }
}

// Message-level tool balance over the FINAL model-facing projection,
// folding message content blocks exactly like the A01 generation proof:
// every tool-call block needs exactly one tool-result block and vice versa.
function messageToolBlocks(messages) {
  const calls = [];
  const results = [];
  for (const message of messages) {
    const blocks = message && Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (block && block.type === 'tool-call' && typeof block.callId === 'string') calls.push(block.callId);
      if (block && block.type === 'tool-result' && typeof block.toolCallId === 'string') results.push(block.toolCallId);
    }
  }
  return { calls, results };
}

function checkMessagesBalanced(messages) {
  const seen = messageToolBlocks(messages);
  if (seen.calls.length !== seen.results.length) return false;
  const callCounts = Object.create(null);
  for (const id of seen.calls) callCounts[id] = (callCounts[id] || 0) + 1;
  const resultCounts = Object.create(null);
  for (const id of seen.results) resultCounts[id] = (resultCounts[id] || 0) + 1;
  for (const id of Object.keys(callCounts)) {
    if (callCounts[id] !== 1 || resultCounts[id] !== 1) return false;
  }
  for (const id of Object.keys(resultCounts)) {
    if (callCounts[id] !== 1) return false;
  }
  return true;
}

function cutSplitsSpan(candidateEndSeq, spans) {
  const cutPoint = candidateEndSeq + 1;
  for (const span of spans) {
    if (span && Number.isInteger(span.startSeq) && Number.isInteger(span.endSeq)) {
      if (cutPoint > span.startSeq && cutPoint <= span.endSeq) return true;
    }
  }
  return false;
}

function shadowMessageId(text, form, seq) {
  // Deterministic hypothetical-only identity (A10 mints live ids at apply
  // time; shadow ids never enter the authoritative log).
  return 'msg-shadow-' + sha256HexUtf8(String(text) + '|' + String(form) + '|' + String(seq)).slice(0, 16);
}

function normalizeCompactedInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) failShadow('compacted projection input is required');
  const unknown = unknownKeyOf(input, COMPACTED_INPUT_EXACT_KEYS);
  if (unknown !== null) failShadow('compacted projection unknown field ' + unknown);
  if (Number(input.schemaVersion) !== 1) failShadow('compacted projection schemaVersion must be 1');
  for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
    if (typeof input[key] !== 'string' || input[key] === '') failShadow('compacted projection ' + key + ' is required');
  }
  if (!Number.isInteger(input.generation) || input.generation < 1) failShadow('compacted projection generation invalid');
  if (!input.sealedCheckpoint || typeof input.sealedCheckpoint !== 'object') failShadow('compacted sealedCheckpoint is required');
  if (!input.retentionPlan || typeof input.retentionPlan !== 'object') failShadow('compacted retentionPlan is required');
  if (!input.snapshotToken || typeof input.snapshotToken !== 'object') failShadow('compacted snapshotToken is required');
  if (!input.taskState || typeof input.taskState !== 'object') failShadow('compacted taskState is required');
  if (!Array.isArray(input.sourceEvents)) failShadow('compacted sourceEvents must be an array');
  if (!Array.isArray(input.surfaceNodes) || input.surfaceNodes.length === 0) failShadow('compacted surfaceNodes must be a non-empty array');
  if (!Array.isArray(input.contextUnits) || input.contextUnits.length === 0) failShadow('compacted contextUnits must be an array');
  const spans = input.protocolSpans === undefined || input.protocolSpans === null ? [] : input.protocolSpans;
  if (!Array.isArray(spans)) failShadow('compacted protocolSpans must be an array');
  return input;
}

// Pure builder shared by A09 (observe) and A10 (apply): from the sealed
// checkpoint, the verbatim A08 plan, and cloned source state, derive the
// exact hypothetical post-compaction model-facing context. Throws
// fail-closed on malformed input; semantic validation belongs to
// validateCompactedProjectionV2 (stable reasons, mutation-testable).
function buildCompactedProjectionV2(input) {
  const n = normalizeCompactedInput(input);
  const candidate = n.retentionPlan.candidateCompactionBoundarySeq;
  const retainedStart = n.retentionPlan.retainedSuffixStartSeq;
  if (!Number.isInteger(candidate) || candidate < 0) failShadow('compacted plan candidate boundary invalid');
  if (retainedStart !== candidate + 1) failShadow('compacted plan suffix must start exactly after the candidate boundary');
  const payloadText = checkpointPayloadTextOf(n.sealedCheckpoint);
  const operationId = compactionV2.deriveCanonicalOperationIdV2(
    n.taskId, n.taskInstanceId, n.sessionId, n.generation, n.sealedCheckpoint.checkpointId
  );
  // Clone + isolate: the source log is never touched.
  const sourceEvents = n.sourceEvents.map((e) => deepClone(e));
  const bySeq = Object.create(null);
  // A12-4: replacement seqs anchor on the semantic log only. Host-only
  // end-seed markers still resolve in bySeq (positional lookups stay
  // intact) but never advance maxSeq: otherwise a restart marker shifts
  // every replacement seq/id and falsely moves the projection digest.
  let maxSeq = -1;
  for (const event of sourceEvents) {
    const seq = eventSeqOf(event);
    if (seq === null) failShadow('compacted event without integer seq');
    bySeq[seq] = event;
    if (event && event.type === 'session/end-seed') continue;
    if (seq > maxSeq) maxSeq = seq;
  }
  for (const seq of n.surfaceNodes) {
    if (!bySeq[seq]) failShadow('compacted surface node does not resolve to a source event');
  }
  const shadowed = n.surfaceNodes.filter((seq) => seq <= candidate);
  if (shadowed.length === 0) failShadow('compacted shadowed surface set is empty');
  // Real A01/A02 segment planning over the shadowed surface set (splits
  // only around host-owned runtime snapshots; tool-pair unsafe -> null).
  const sessionLike = { events: sourceEvents, surface: { nodes: n.surfaceNodes.slice() } };
  const planned = compactionV2.planCompactionSegmentsV2(sessionLike, shadowed);
  if (!planned) failShadow('compacted plan yields no segments (no bulk or tool-pair unsafe)');
  const roled = compactionV2.shapeSegmentsWithRoles(planned.segments);
  const payloadCount = roled.filter((s) => s.role === 'payload').length;
  if (payloadCount !== 1 || roled[0].role !== 'payload') failShadow('compacted plan must carry exactly one earliest payload segment');
  const owned = planned.currentRuntimeSeq === null || planned.currentRuntimeSeq === undefined ? [] : [planned.currentRuntimeSeq];
  const expectedUnion = shadowed.filter((seq) => owned.indexOf(seq) === -1).sort((a, b) => a - b);
  const actualUnion = [];
  for (const seg of roled) {
    if (!seg || !Array.isArray(seg.sourceEventSeqs)) failShadow('compacted segment malformed');
    for (const seq of seg.sourceEventSeqs) actualUnion.push(seq);
  }
  actualUnion.sort((a, b) => a - b);
  if (serializeCanonical(actualUnion) !== serializeCanonical(expectedUnion)) {
    failShadow('compacted segments do not partition the shadowed surface set');
  }
  // Replacement nodes shaped exactly like the frozen A02 apply path
  // (payload text or bounded anchor; aih-controller plugin sources).
  const segmentCount = roled.length;
  const replacementEvents = roled.map((seg, index) => {
    const isPayload = seg.role === 'payload';
    const text = isPayload ? payloadText : compactionV2.buildContinuationAnchorText(operationId, n.generation, index, segmentCount);
    const form = isPayload ? 'context-checkpoint' : 'context-continuation';
    const seq = maxSeq + 1 + index;
    const source = isPayload
      ? { kind: 'plugin', plugin: 'aih-controller', form, operationId, generation: n.generation, taskInstanceId: n.taskInstanceId }
      : { kind: 'plugin', plugin: 'aih-controller', form, operationId, generation: n.generation };
    return {
      seq,
      type: 'user/message',
      data: { id: shadowMessageId(text, form, seq), role: 'user', content: [{ type: 'text', text }], source },
      surfaceOp: { op: 'replace', start: seg.start, end: seg.end },
      sourceEventSeqs: seg.sourceEventSeqs.slice(),
    };
  });
  // Hypothetical surface: sequential span splice mirroring the host
  // applySurfacePlan (replacement occupies the replaced span position).
  const hypoSurface = n.surfaceNodes.slice();
  roled.forEach((seg, index) => {
    const startIdx = hypoSurface.indexOf(seg.start);
    const endIdx = hypoSurface.indexOf(seg.end);
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) failShadow('compacted replacement span not found in surface order');
    hypoSurface.splice(startIdx, endIdx - startIdx + 1, maxSeq + 1 + index);
  });
  const hypoBySeq = Object.create(null);
  for (const event of sourceEvents) hypoBySeq[event.seq] = event;
  for (const event of replacementEvents) hypoBySeq[event.seq] = event;
  const projectedMessages = [];
  for (const seq of hypoSurface) {
    const event = hypoBySeq[seq];
    if (!event) failShadow('compacted hypothetical surface does not resolve');
    const message = deriveProjectedMessageV2(event);
    if (message === null || message === undefined) continue;
    projectedMessages.push(message);
  }
  const replacementMessages = replacementEvents.map((event) => deriveProjectedMessageV2(event));
  // Retained suffix (source-true view, kept for exactness accounting).
  // A12-4: host-only session/end-seed restore markers are excluded from the
  // digest input (H2 execution transparency). Markers stay in sourceEvents
  // for positional eventBySeq lookups (filtering the array shifts positions
  // and falsely breaks planning for mid-log markers); they are unsurfaced
  // and semantically neutral, so excluding them here loses no authority
  // while keeping the digest stable across restarts.
  const RESTORE_MARKER_TYPE_V2 = 'session/end-seed';
  const projectedEvents = sourceEvents
    .filter((e) => e && e.type !== RESTORE_MARKER_TYPE_V2 && e.seq >= retainedStart)
    .sort((a, b) => a.seq - b.seq)
    .map((e) => deepClone(e));
  const segments = roled.map((seg) => ({
    start: seg.start,
    end: seg.end,
    sourceEventSeqs: seg.sourceEventSeqs.slice(),
    role: seg.role,
  }));
  const body = {
    schemaVersion: 1,
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    generation: n.generation,
    operationId,
    checkpointId: n.sealedCheckpoint.checkpointId,
    checkpointContentDigest: n.sealedCheckpoint.checkpointContentDigest,
    retentionPlanId: n.retentionPlan.retentionPlanId,
    sourceSnapshotTokenId: n.snapshotToken.snapshotTokenId,
    sourceRevisionDigest: n.snapshotToken.revisionDigest,
    candidateCompactionBoundarySeq: candidate,
    segments,
    payloadText,
    replacementMessages,
    projectedEvents,
    projectedMessages,
  };
  const projectionDigest = sha256HexUtf8(
    SHADOW_PROJECTION_DIGEST_DOMAIN_V2 + LF_JOIN + serializeCanonical(body)
  );
  return Object.freeze(Object.assign({}, body, {
    segments: Object.freeze(segments.map((s) => Object.freeze(Object.assign({}, s, { sourceEventSeqs: Object.freeze(s.sourceEventSeqs.slice()) })))),
    replacementMessages: Object.freeze(replacementMessages.map((m) => Object.freeze(deepClone(m)))),
    projectedEvents: Object.freeze(projectedEvents.map((e) => Object.freeze(deepClone(e)))),
    projectedMessages: Object.freeze(projectedMessages.map((m) => Object.freeze(deepClone(m)))),
    projectionDigest,
  }));
}

function normalizeCompactedExpect(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) failShadow('compacted expectations are required');
  const unknown = unknownKeyOf(raw, COMPACTED_EXPECT_EXACT_KEYS);
  if (unknown !== null) failShadow('compacted expectations unknown field ' + unknown);
  return raw;
}

function messageTextsOf(messages) {
  const texts = [];
  const walk = (value) => {
    if (typeof value === 'string') { texts.push(value); return; }
    if (Array.isArray(value)) { for (const entry of value) walk(entry); return; }
    if (value !== null && typeof value === 'object') {
      if (typeof value.text === 'string' && value.type === 'text') texts.push(value.text);
      else { for (const key of Object.keys(value)) { if (key !== 'id') walk(value[key]); } }
    }
  };
  for (const message of messages || []) walk(message);
  return texts;
}

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

// Full validation of the complete model-facing artifact. Every reason is a
// frozen shadow blocker code; any tamper (payload removed/changed,
// checkpoint id/content changed, suffix event removed, current user
// duplicated, continuation altered) lands on a stable explicit reason.
function validateCompactedProjectionV2(artifact, expectations) {
  const fail = (reason) => ({ valid: false, reason });
  const exp = normalizeCompactedExpect(expectations);
  if (!artifact || typeof artifact !== 'object') return fail('shadow-projection-failed');
  if (unknownKeyOf(artifact, SHADOW_PROJECTION_ARTIFACT_EXACT_KEYS) !== null) return fail('shadow-projection-failed');
  if (artifact.taskId !== exp.taskId) return fail('shadow-projection-failed');
  if (artifact.taskInstanceId !== exp.taskInstanceId) return fail('shadow-projection-failed');
  if (artifact.sessionId !== exp.sessionId) return fail('shadow-projection-failed');
  if (artifact.generation !== exp.generation) return fail('shadow-projection-failed');
  if (artifact.operationId !== exp.operationId) return fail('shadow-projection-failed');
  if (artifact.checkpointId !== exp.checkpointId) return fail('shadow-projection-failed');
  if (artifact.checkpointContentDigest !== exp.checkpointContentDigest) return fail('shadow-projection-failed');
  if (artifact.retentionPlanId !== exp.retentionPlanId) return fail('shadow-projection-failed');
  if (artifact.sourceSnapshotTokenId !== exp.sourceSnapshotTokenId) return fail('shadow-projection-failed');
  if (artifact.sourceRevisionDigest !== exp.sourceRevisionDigest) return fail('shadow-projection-failed');
  if (artifact.candidateCompactionBoundarySeq !== exp.candidateCompactionBoundarySeq) return fail('shadow-projection-suffix-mismatch');
  if (!Array.isArray(artifact.segments) || artifact.segments.length === 0) return fail('shadow-projection-failed');
  for (const seg of artifact.segments) {
    if (!seg || typeof seg !== 'object' || unknownKeyOf(seg, SHADOW_SEGMENT_EXACT_KEYS) !== null) return fail('shadow-projection-failed');
    if ((seg.role !== 'payload' && seg.role !== 'continuation') || !Array.isArray(seg.sourceEventSeqs)) return fail('shadow-projection-failed');
  }
  if (artifact.segments[0].role !== 'payload') return fail('shadow-projection-failed');
  if (artifact.segments.filter((s) => s.role === 'payload').length !== 1) return fail('shadow-projection-failed');
  const body = {};
  for (const key of SHADOW_PROJECTION_ARTIFACT_EXACT_KEYS) {
    if (key === 'projectionDigest') continue;
    body[key] = artifact[key];
  }
  if (sha256HexUtf8(SHADOW_PROJECTION_DIGEST_DOMAIN_V2 + LF_JOIN + serializeCanonical(body)) !== artifact.projectionDigest) {
    return fail('shadow-projection-failed');
  }
  // Payload leg: the checkpoint-derived representation is proven by the
  // frozen digest gate, and present exactly once in the model-facing view.
  if (typeof artifact.payloadText !== 'string' || artifact.payloadText === '') return fail('shadow-payload-unproven');
  if (sha256HexUtf8(artifact.payloadText) !== artifact.checkpointContentDigest) return fail('shadow-payload-unproven');
  if (!Array.isArray(artifact.replacementMessages) || artifact.replacementMessages.length !== artifact.segments.length) {
    return fail('shadow-projection-failed');
  }
  // Retained suffix leg: no invented, lost, rewritten, or reordered events.
  // A12-4: host-only end-seed markers are excluded on both sides (the
  // artifact's projectedEvents excludes them by construction).
  const expected = (exp.sourceEvents || [])
    .filter((e) => e && e.type !== 'session/end-seed' && Number.isInteger(e.seq) && e.seq >= exp.retainedSuffixStartSeq)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  if (!Array.isArray(artifact.projectedEvents) || artifact.projectedEvents.length !== expected.length) {
    return fail('shadow-projection-suffix-mismatch');
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (serializeCanonical(artifact.projectedEvents[i]) !== serializeCanonical(expected[i])) return fail('shadow-projection-suffix-mismatch');
    if (artifact.projectedEvents[i].seq !== expected[i].seq) return fail('shadow-projection-suffix-mismatch');
  }
  // Complete-messages leg: recompute the hypothetical surface independently
  // (span splices over the caller-supplied surface order) and require the
  // artifact messages to match exactly. Any added/removed/duplicated or
  // rewritten message fails here, even with an intact event suffix.
  if (!Array.isArray(artifact.projectedMessages)) return fail('shadow-projection-messages');
  const recomputedSurface = (exp.surfaceNodes || []).slice();
  let maxSourceSeq = -1;
  for (const e of exp.sourceEvents || []) { if (Number.isInteger(e.seq) && e.seq > maxSourceSeq) maxSourceSeq = e.seq; }
  const recomputedSeqs = [];
  artifact.segments.forEach((seg, index) => {
    const startIdx = recomputedSurface.indexOf(seg.start);
    const endIdx = recomputedSurface.indexOf(seg.end);
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) recomputedSeqs.push(null);
    else {
      const replacementSeq = maxSourceSeq + 1 + index;
      recomputedSurface.splice(startIdx, endIdx - startIdx + 1, replacementSeq);
      recomputedSeqs.push(replacementSeq);
    }
  });
  if (recomputedSeqs.indexOf(null) !== -1) return fail('shadow-projection-messages');
  const hypoBySeq = Object.create(null);
  for (const e of exp.sourceEvents || []) hypoBySeq[e.seq] = e;
  const rebuiltReplacements = [];
  for (let index = 0; index < artifact.segments.length; index += 1) {
    const seg = artifact.segments[index];
    const isPayload = seg.role === 'payload';
    let text = null;
    if (isPayload) text = artifact.payloadText;
    else {
      try {
        text = compactionV2.buildContinuationAnchorText(artifact.operationId, artifact.generation, index, artifact.segments.length);
      } catch (error) { return fail('shadow-projection-failed'); }
    }
    const form = isPayload ? 'context-checkpoint' : 'context-continuation';
    const seq = maxSourceSeq + 1 + index;
    const source = isPayload
      ? { kind: 'plugin', plugin: 'aih-controller', form, operationId: artifact.operationId, generation: artifact.generation, taskInstanceId: artifact.taskInstanceId }
      : { kind: 'plugin', plugin: 'aih-controller', form, operationId: artifact.operationId, generation: artifact.generation };
    rebuiltReplacements.push({ id: shadowMessageId(text, form, seq), role: 'user', content: [{ type: 'text', text }], source });
    hypoBySeq[seq] = rebuiltReplacements[rebuiltReplacements.length - 1];
  }
  if (rebuiltReplacements.length !== artifact.replacementMessages.length) return fail('shadow-projection-failed');
  for (let index = 0; index < rebuiltReplacements.length; index += 1) {
    if (serializeCanonical(rebuiltReplacements[index]) !== serializeCanonical(artifact.replacementMessages[index])) {
      return fail('shadow-projection-failed');
    }
  }
  const recomputedMessages = [];
  for (const seq of recomputedSurface) {
    const source = hypoBySeq[seq];
    if (source === null || source === undefined) return fail('shadow-projection-messages');
    let message = null;
    if (Number.isInteger(seq) && seq > maxSourceSeq) message = source;
    else message = deriveProjectedMessageV2(source);
    if (message === null || message === undefined) continue;
    recomputedMessages.push(message);
  }
  if (recomputedMessages.length !== artifact.projectedMessages.length) return fail('shadow-projection-messages');
  for (let i = 0; i < recomputedMessages.length; i += 1) {
    if (serializeCanonical(recomputedMessages[i]) !== serializeCanonical(artifact.projectedMessages[i])) {
      return fail('shadow-projection-messages');
    }
  }
  // Payload-once leg: the checkpoint-derived text occurs exactly once
  // across the complete model-facing view (proves the checkpoint
  // participates rather than merely decorating the result).
  const joinedTexts = messageTextsOf(artifact.projectedMessages).join('\n');
  if (countOccurrences(joinedTexts, artifact.payloadText) !== 1) return fail('shadow-payload-unproven');
  // Continuation anchors (if any) must be the exact frozen anchor texts.
  for (let index = 0; index < artifact.segments.length; index += 1) {
    if (artifact.segments[index].role !== 'continuation') continue;
    let expectedAnchor = null;
    try {
      expectedAnchor = compactionV2.buildContinuationAnchorText(artifact.operationId, artifact.generation, index, artifact.segments.length);
    } catch (error) { return fail('shadow-projection-failed'); }
    const texts = messageTextsOf([artifact.replacementMessages[index]].filter((m) => m !== null && m !== undefined)).join('\n');
    if (countOccurrences(texts, expectedAnchor) !== 1) return fail('shadow-projection-failed');
  }
  // Current-user leg: the literal current request text occurs exactly once
  // across the COMPLETE projected context (checkpoint state plus suffix),
  // so a payload duplicating the live request fails instead of passing.
  const currentUnits = (exp.contextUnits || []).filter((u) => u && u.isCurrentUserTurn === true);
  if (currentUnits.length !== 1) return fail('shadow-projection-current-user');
  const currentUnit = currentUnits[0];
  const currentTexts = [];
  for (const e of exp.sourceEvents || []) {
    if (Number.isInteger(e.seq) && e.seq >= currentUnit.eventSeqStart && e.seq <= currentUnit.eventSeqEnd) {
      const text = compactionV2.textContentOfEvent(e);
      if (typeof text === 'string' && text !== '') currentTexts.push(text);
    }
  }
  if (currentTexts.length === 0) return fail('shadow-projection-current-user');
  for (const text of currentTexts) {
    if (countOccurrences(joinedTexts, text) !== 1) return fail('shadow-projection-current-user');
  }
  // Protocol leg over the FINAL model-facing projection (payload anchors
  // included; the compacted representation carries no tool blocks, but a
  // malformed one would fail here rather than hide behind suffix checks).
  if (checkMessagesBalanced(artifact.projectedMessages) !== true) return fail('shadow-projection-protocol');
  // Continuation leg: deterministic required-state presence over the
  // checkpoint-derived payload (no LLM judgment). The payload must carry
  // objective, every requirement/decision identity with status, constraint
  // coverage, next action, unresolved questions, verification outcomes, and
  // failure/retry obligations verbatim from the task state.
  const continuationCheck = checkPayloadContinuation(artifact.payloadText, exp.taskState);
  if (continuationCheck.valid !== true) return fail('shadow-continuation-incomplete');
  return { valid: true, reason: null };
}

function payloadJsonOf(payloadText) {
  try {
    const parsed = JSON.parse(payloadText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return null;
  } catch (error) { return null; }
}

// Frozen A03/A07 redaction-equality mirror (ContextCheckpointabilityV2
// redactEqual verbatim): checkpoint text is redacted at build time, so
// continuation presence compares redacted-against-redacted, never raw.
function redactEqualTexts(taskText, checkpointText) {
  const left = checkpointV2.redactCheckpointTextV2(String(taskText === null || taskText === undefined ? '' : taskText), checkpointV2.BOUNDS.redactMaxChars);
  const right = checkpointV2.redactCheckpointTextV2(String(checkpointText === null || checkpointText === undefined ? '' : checkpointText), checkpointV2.BOUNDS.redactMaxChars);
  return left === right;
}

function checkPayloadContinuation(payloadText, taskState) {
  const fail = (reason) => ({ valid: false, reason });
  const ok = () => ({ valid: true, reason: null });
  if (!taskState || typeof taskState !== 'object') return fail('task-state-missing');
  const payload = payloadJsonOf(payloadText);
  if (!payload) return fail('payload-unparseable');
  if (!payload.objective || !redactEqualTexts(taskState.objective.text, payload.objective.text) || payload.objective.status !== taskState.objective.status) return fail('objective-missing');
  if (!redactEqualTexts(taskState.continuation.nextAction === null ? '' : taskState.continuation.nextAction, payload.continuation.nextAction === null || payload.continuation.nextAction === undefined ? '' : payload.continuation.nextAction) || serializeCanonical(payload.continuation.unresolvedQuestions || []) !== serializeCanonical(taskState.continuation.unresolvedQuestions || []) || (payload.continuation.recentUserIntent === undefined ? null : payload.continuation.recentUserIntent) !== taskState.continuation.recentUserIntent) return fail('continuation-missing');
  
  const payloadReqs = Array.isArray(payload.requirements) ? payload.requirements : [];
  for (const req of taskState.requirements || []) {
    const found = payloadReqs.filter((entry) => entry && entry.id === req.id && entry.status === req.status && redactEqualTexts(req.text, entry.text));
    if (found.length !== 1) return fail('requirement-missing:' + req.id);
  }
  const payloadDecisions = Array.isArray(payload.decisions) ? payload.decisions : [];
  for (const decision of taskState.decisions || []) {
    const found = payloadDecisions.filter((entry) => entry && entry.id === decision.id && entry.status === decision.status && redactEqualTexts(decision.statement, entry.statement) && entry.authority === decision.authority);
    if (found.length !== 1) return fail('decision-missing:' + decision.id);
  }
  if ((Array.isArray(payload.constraints) ? payload.constraints.length : 0) !== (Array.isArray(taskState.constraints) ? taskState.constraints.length : 0)) {
    return fail('constraints-missing');
  }
  const payloadOutcomes = payload.verification && Array.isArray(payload.verification.outcomes) ? payload.verification.outcomes : [];
  const stateOutcomes = taskState.verification && Array.isArray(taskState.verification.outcomes) ? taskState.verification.outcomes : [];
  if (payloadOutcomes.length !== stateOutcomes.length) return fail('verification-missing');
  for (let i = 0; i < stateOutcomes.length; i += 1) {
    if (!payloadOutcomes[i] || payloadOutcomes[i].scope !== stateOutcomes[i].scope || payloadOutcomes[i].status !== stateOutcomes[i].status) {
      return fail('verification-missing');
    }
  }
  const payloadFailures = payload.failures && Array.isArray(payload.failures.activeFailures) ? payload.failures.activeFailures : [];
  const stateFailures = taskState.failures && Array.isArray(taskState.failures.activeFailures) ? taskState.failures.activeFailures : [];
  if (payloadFailures.length !== stateFailures.length) return fail('failure-state-missing');
  for (let i = 0; i < stateFailures.length; i += 1) {
    if (!payloadFailures[i] || payloadFailures[i].id !== stateFailures[i].id) return fail('failure-state-missing');
  }
  if (serializeCanonical(payload.progress || null) !== serializeCanonical(taskState.progress || null)) return fail('progress-missing');
  return ok();
}

// Honest message-basis token cost (conservative estimator over canonical
// message bytes; always estimated, never exact).
function messageTokensOf(messages) {
  const bytes = pressureV2.byteLengthUtf8(pressureV2.serializeCanonical(messages));
  return { tokens: pressureV2.estimateTokensForUtf8Bytes(bytes), method: 'conservative-estimate', exact: false };
}
// ---- shadow checkpoint construction (real A03 + A04, never persisted) ----

function deriveCheckpointInput(n) {
  // The checkpoint contract carries mapped shapes (never task-state widows
  // such as sourceKind/accessible markers): map explicitly per the frozen
  // A03 builder contract, mirroring the A07 proof scaffold field-for-field.
  const ts = n.taskState;
  const checkpointInput = {
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    workspaceId: ts.workspaceId,
    repositoryId: ts.repositoryId === undefined ? null : ts.repositoryId,
    checkoutId: ts.checkoutId === undefined ? null : ts.checkoutId,
    generation: n.generation,
    kind: 'active',
    parentCheckpointId: n.parentCheckpointId,
    safePointBoundarySeq: n.safePointDecision.boundarySeq,
    safePointStepId: null,
    snapshotToken: n.snapshotToken,
    objective: deepClone(ts.objective),
    requirements: (Array.isArray(ts.requirements) ? ts.requirements : []).map((r) => ({
      id: r.id, text: r.text, status: r.status, evidenceRefs: Array.isArray(r.evidenceRefs) ? r.evidenceRefs.slice() : [],
    })),
    constraints: (Array.isArray(ts.constraints) ? ts.constraints : []).map((c) => ({
      type: c.type, text: c.text,
    })),
    progress: deepClone(ts.progress),
    decisions: (Array.isArray(ts.decisions) ? ts.decisions : []).map((d) => ({
      id: d.id,
      statement: d.statement,
      authority: d.authority,
      status: d.status,
      evidenceRefs: Array.isArray(d.evidenceRefs) ? d.evidenceRefs.slice() : [],
    })),
    repository: deepClone(ts.repository),
    evidenceRefs: (Array.isArray(ts.evidenceRefs) ? ts.evidenceRefs : []).map((e) => ({
      schemaVersion: 1,
      evidenceId: e.evidenceId,
      kind: e.kind,
      locator: e.locator,
      digest: e.digest === undefined ? null : e.digest,
      observedAtUtc: e.observedAtUtc,
      taskInstanceId: e.taskInstanceId,
    })),
    failures: deepClone(ts.failures),
    verification: deepClone(ts.verification),
    continuation: deepClone(ts.continuation),
    pressure: null,
    createdAtUtc: n.createdAtUtc,
  };
  return checkpointInput;
}

function deriveProvenanceInputs(n) {
  // buildSealedCheckpointV2 requires decisionValue on decisions.N.authority
  // paths (the recorded authority value must be establishable by the
  // sourcing kind): enrich verbatim from the task state's own authorities.
  const inputs = {};
  const provenance = n.taskState.provenance || {};
  for (const fieldPath of Object.keys(provenance)) {
    const slot = provenance[fieldPath];
    if (!slot || typeof slot !== 'object') continue;
    inputs[fieldPath] = {
      fieldKind: slot.fieldKind,
      sourceKind: slot.sourceKind,
      sourceRefs: Array.isArray(slot.sourceRefs) ? slot.sourceRefs.slice() : [],
      authorityScope: slot.authorityScope === undefined ? null : slot.authorityScope,
    };
    const m = /^decisions[.](\d+)[.]authority$/.exec(fieldPath);
    if (m && Array.isArray(n.taskState.decisions) && n.taskState.decisions[Number(m[1])]) {
      inputs[fieldPath].decisionValue = n.taskState.decisions[Number(m[1])].authority;
    }
  }
  return inputs;
}

const SHADOW_CHECKPOINT_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'generation',
  'parentCheckpointId',
  'safePointBoundarySeq',
  'snapshotToken',
  'taskState',
  'createdAtUtc',
  'sealedAtUtc',
]);

// Pure A03/A04 construction shared by A09 (observe) and A10 (apply-time
// rebuild): real checkpoint build plus real seal plus seal revalidation.
// Throws fail-closed with a stable prefix the evaluator maps to a frozen
// blocker code (shadow-checkpoint-build-failed vs shadow-seal-invalid).
// Never persists; never mutates.
function buildShadowCheckpointV2(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) failShadow('shadow-checkpoint-build-failed: input is required');
  const unknown = unknownKeyOf(input, SHADOW_CHECKPOINT_INPUT_EXACT_KEYS);
  if (unknown !== null) failShadow('shadow-checkpoint-build-failed: unknown field ' + unknown);
  if (Number(input.schemaVersion) !== 1) failShadow('shadow-checkpoint-build-failed: schemaVersion must be 1');
  for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
    if (typeof input[key] !== 'string' || input[key] === '') failShadow('shadow-checkpoint-build-failed: ' + key + ' is required');
  }
  if (!Number.isInteger(input.generation) || input.generation < 1) failShadow('shadow-checkpoint-build-failed: generation invalid');
  if (!Number.isInteger(input.safePointBoundarySeq) || input.safePointBoundarySeq < 0) {
    failShadow('shadow-checkpoint-build-failed: safePointBoundarySeq invalid');
  }
  if (!input.snapshotToken || typeof input.snapshotToken !== 'object') failShadow('shadow-checkpoint-build-failed: snapshotToken is required');
  if (!input.taskState || typeof input.taskState !== 'object') failShadow('shadow-checkpoint-build-failed: taskState is required');
  if (typeof input.createdAtUtc !== 'string' || !isIsoUtc(input.createdAtUtc)) {
    failShadow('shadow-checkpoint-build-failed: createdAtUtc must be explicit ISO-8601 UTC input');
  }
  if (typeof input.sealedAtUtc !== 'string' || !isIsoUtc(input.sealedAtUtc)) {
    failShadow('shadow-checkpoint-build-failed: sealedAtUtc must be explicit ISO-8601 UTC input');
  }
  const sub = {
    taskId: input.taskId,
    taskInstanceId: input.taskInstanceId,
    sessionId: input.sessionId,
    generation: input.generation,
    parentCheckpointId: input.parentCheckpointId === undefined ? null : input.parentCheckpointId,
    safePointDecision: { boundarySeq: input.safePointBoundarySeq },
    snapshotToken: input.snapshotToken,
    taskState: input.taskState,
    createdAtUtc: input.createdAtUtc,
  };
  let sealed = null;
  try {
    const checkpointInput = deriveCheckpointInput(sub);
    sealed = trustV2.buildSealedCheckpointV2(checkpointInput, deriveProvenanceInputs(sub) || {}, { sealedAtUtc: input.sealedAtUtc });
  } catch (error) {
    failShadow('shadow-checkpoint-build-failed: ' + String((error && error.message) || error).slice(0, 300));
  }
  try {
    const sealCheck = trustV2.validateSealedCheckpoint(sealed.checkpoint);
    if (!sealCheck.valid) failShadow('shadow-seal-invalid: ' + sealCheck.reason);
  } catch (error) {
    const message = String((error && error.message) || error);
    if (message.indexOf('shadow-seal-invalid:') !== -1) throw error;
    failShadow('shadow-seal-invalid: ' + message.slice(0, 300));
  }
  return Object.freeze({
    sealedCheckpoint: sealed.checkpoint,
    checkpointId: sealed.checkpointId,
    contentDigest: sealed.contentDigest,
    sizeBytes: sealed.sizeBytes,
    seal: sealed.seal,
  });
}

// ---- main evaluation ----

function evaluateShadowCompactionV2(input) {
  const n = normalizeShadowInput(input);
  const blockers = [];
  const block = (code, detail) => blockers.push({ code, detail: detail === undefined || detail === null ? null : String(detail) });

  const taskBindingOk =
    n.taskState.taskId === n.taskId &&
    n.taskState.taskInstanceId === n.taskInstanceId &&
    n.taskState.sessionId === n.sessionId &&
    n.taskState.generation === n.generation;

  // A06 leg (consumed verbatim).
  let safeOk = false;
  let safeBoundarySeq = null;
  try {
    const check = safepointV2.validateSafePointDecision(n.safePointDecision);
    if (!check.valid) block('shadow-safe-point-required', 'safe-point decision refused (' + check.reason + ')');
    else if (n.safePointDecision.safe !== true) block('shadow-safe-point-required', 'safe point is not safe');
    else {
      safeOk = true;
      safeBoundarySeq = n.safePointDecision.boundarySeq;
    }
  } catch (error) {
    block('shadow-safe-point-required', 'safe-point validation failed');
  }

  // A05 legs (consumed verbatim: structural validity + freshness).
  let snapshotOk = false;
  let snapshotTokenId = null;
  let revisionDigest = null;
  try {
    const check = snapshotV2.validateSnapshotToken(n.snapshotToken);
    if (!check.valid) block('shadow-snapshot-required', 'snapshot token refused (' + check.reason + ')');
    else {
      snapshotTokenId = n.snapshotToken.snapshotTokenId;
      revisionDigest = n.snapshotToken.revisionDigest;
      let fresh = null;
      try {
        fresh = snapshotV2.revalidate(n.snapshotToken, n.snapshotCurrentState);
      } catch (error) {
        fresh = { valid: false, reason: 'snapshot-token-invalid' };
      }
      if (!fresh || fresh.valid !== true) {
        block('shadow-snapshot-stale', 'snapshot is stale (' + ((fresh && fresh.reason) || 'unknown') + ')');
      } else if (
        n.snapshotToken.taskId !== n.taskId ||
        n.snapshotToken.taskInstanceId !== n.taskInstanceId ||
        n.snapshotToken.sessionId !== n.sessionId ||
        n.snapshotToken.generation !== n.generation
      ) {
        block('shadow-snapshot-stale', 'snapshot binds another task binding');
      } else {
        snapshotOk = true;
      }
    }
  } catch (error) {
    block('shadow-snapshot-required', 'snapshot validation failed');
  }

  // A07 leg (consumed verbatim).
  let gateOk = false;
  try {
    const check = gateV2.validateCheckpointabilityDecision(n.checkpointabilityDecision);
    if (!check.valid) block('shadow-checkpointability-required', 'checkpointability refused (' + check.reason + ')');
    else if (n.checkpointabilityDecision.checkpointable !== true) {
      block('shadow-checkpointability-required', 'task is not checkpointable');
    } else gateOk = true;
  } catch (error) {
    block('shadow-checkpointability-required', 'checkpointability validation failed');
  }

  // Pressure leg (consumed verbatim; UNKNOWN claims no headroom).
  let pressureKnown = false;
  let pressureDecision = null;
  try {
    const check = pressureV2.validatePressureDecision(n.pressureDecision);
    if (!check.valid) block('shadow-pressure-unknown', 'pressure decision refused (' + check.reason + ')');
    else {
      pressureDecision = n.pressureDecision;
      if (n.pressureDecision.known === true) pressureKnown = true;
      else block('shadow-pressure-unknown', 'provider capacity is unknown');
    }
  } catch (error) {
    block('shadow-pressure-unknown', 'pressure validation failed');
  }

  // Retention leg (consumed verbatim).
  let retentionValid = false;
  let retentionActionable = false;
  let retentionPlan = null;
  try {
    const check = retentionV2.validateRetentionPlan(n.retentionPlan);
    if (!check.valid) block('shadow-retention-not-actionable', 'retention plan refused (' + check.reason + ')');
    else {
      retentionValid = true;
      retentionPlan = n.retentionPlan;
      if (n.retentionPlan.actionable === true) retentionActionable = true;
      else {
        const codes = n.retentionPlan.blockers.map((b) => b.code);
        if (codes.indexOf('retention-insufficient-reclaim') !== -1) {
          block('shadow-retention-insufficient-reclaim', 'projected reclaim is below the minimum useful compaction');
        } else {
          block('shadow-retention-not-actionable', 'retention plan is not actionable');
        }
      }
    }
  } catch (error) {
    block('shadow-retention-not-actionable', 'retention validation failed');
  }

  // Cross-binding: the shadow result must bind one coherent state.
  if (snapshotOk === true) {
    if (pressureDecision && pressureDecision.snapshotTokenId !== undefined && pressureDecision.snapshotTokenId !== snapshotTokenId) {
      block('shadow-snapshot-stale', 'pressure decision binds a different snapshot');
      snapshotOk = false;
    }
    if (retentionPlan && retentionPlan.snapshotTokenId !== snapshotTokenId) {
      block('shadow-snapshot-stale', 'retention plan binds a different snapshot');
      snapshotOk = false;
    }
    if (retentionPlan && retentionPlan.retentionPlanId !== undefined && n.retentionPlan.retentionPlanId !== retentionPlan.retentionPlanId) {
      block('shadow-snapshot-stale', 'retention plan identity drift');
      snapshotOk = false;
    }
  }
  if (taskBindingOk !== true) {
    block('shadow-snapshot-stale', 'task state binds another task binding');
    snapshotOk = false;
  }

  const pressureNone = pressureDecision && pressureDecision.recommendation === 'none';

  const baseProjection = {
    attempted: false,
    valid: false,
    beforeEventCount: n.sessionEvents.length,
    projectedEventCount: n.sessionEvents.length,
    beforeMessageCount: 0,
    projectedMessageCount: 0,
    beforeContextTokens: null,
    projectedContextTokens: null,
    checkpointPayloadTokens: null,
    retainedSuffixTokens: null,
    projectedReclaimTokens: null,
    precision: 'unknown',
    currentUserMessageCountBefore: 1,
    currentUserMessageCountAfter: 1,
    protocolBalanced: false,
    projectionDigest: null,
    operationId: null,
    segments: [],
  };

  function finalize(verdict, checkpoint, projection, extraBlockers, reclaimComparison) {
    const allBlockers = sortBlockers(blockers.concat(extraBlockers || []).map((b) =>
      Object.freeze({ code: b.code, detail: b.detail === null || b.detail === undefined ? null : String(b.detail) })
    ));
    for (const b of allBlockers) {
      if (SHADOW_BLOCKER_CODES.indexOf(b.code) === -1) failShadow('unknown shadow blocker ' + b.code);
    }
    if (verdict === 'shadow-ready' && allBlockers.length !== 0) {
      failShadow('shadow-ready must carry zero blockers');
    }
    if ((verdict === 'blocked' || verdict === 'no-action' || verdict === 'shadow-invalid') && allBlockers.length === 0) {
      failShadow('non-ready verdicts must carry at least one blocker');
    }
    const body = {
      schemaVersion: SHADOW_SCHEMA_VERSION,
      taskId: n.taskId,
      taskInstanceId: n.taskInstanceId,
      sessionId: n.sessionId,
      generation: n.generation,
      snapshotTokenId,
      revisionDigest,
      safePointBoundarySeq: safeBoundarySeq,
      providerModelId: pressureDecision && pressureDecision.providerModelId !== undefined ? pressureDecision.providerModelId : null,
      pressureBasisDigest: retentionPlan && retentionPlan.pressureBasisDigest !== undefined ? retentionPlan.pressureBasisDigest : null,
      retentionPlanId: retentionPlan && retentionPlan.retentionPlanId !== undefined ? retentionPlan.retentionPlanId : null,
      safePoint: deepClone(n.safePointDecision),
      checkpointability: deepClone(n.checkpointabilityDecision),
      pressure: deepClone(n.pressureDecision),
      retentionPlan: deepClone(n.retentionPlan),
      checkpoint: checkpoint === null ? null : deepClone(checkpoint),
      projection: deepClone(projection),
      reclaimComparison: reclaimComparison === undefined || reclaimComparison === null ? null : deepClone(reclaimComparison),
      verdict,
      blockers: allBlockers.map((b) => ({ code: b.code, detail: b.detail })),
    };
    const shadowDigest = sha256HexUtf8(SHADOW_RESULT_DIGEST_DOMAIN_V1 + LF_JOIN + serializeCanonical(body));
    const shadowId = 'csr_' + sha256HexUtf8(
      SHADOW_RESULT_ID_DOMAIN_V1 + LF_JOIN + n.taskId + LF_JOIN + String(n.generation) + LF_JOIN + shadowDigest
    ).slice(0, 32);
    const result = Object.freeze(Object.assign({}, body, { shadowDigest, shadowId }));
    const check = validateShadowResultV2(result);
    if (!check.valid) failShadow('shadow result refused (' + check.reason + ')');
    return result;
  }

  // Verdict ladder (no new policy: every leg below restates a lower-layer
  // decision; A09 only sequences them).
  if (safeOk !== true || snapshotOk !== true) {
    return finalize('blocked', null, baseProjection, []);
  }
  if (gateOk !== true) {
    return finalize('blocked', null, baseProjection, []);
  }
  if (pressureKnown !== true) {
    return finalize('blocked', null, baseProjection, []);
  }
  if (pressureNone === true) {
    const hasNone = blockers.some((b) => b.code === 'shadow-pressure-none');
    return finalize('no-action', null, baseProjection, hasNone ? [] : [{ code: 'shadow-pressure-none', detail: 'pressure recommends none' }]);
  }
  if (retentionActionable !== true) {
    const hasReclaim = blockers.some((b) => b.code === 'shadow-retention-insufficient-reclaim');
    return finalize(hasReclaim ? 'no-action' : 'blocked', null, baseProjection, []);
  }

  // All lower layers allow planning: construct the real shadow checkpoint,
  // seal it, enforce post-build coverage, and build the hypothetical
  // projection. Any failure here is shadow-invalid (loud, never downgraded).
  let shadowCheckpoint = null;
  try {
    shadowCheckpoint = buildShadowCheckpointV2({
      schemaVersion: 1,
      taskId: n.taskId,
      taskInstanceId: n.taskInstanceId,
      sessionId: n.sessionId,
      generation: n.generation,
      parentCheckpointId: n.parentCheckpointId,
      safePointBoundarySeq: n.safePointDecision.boundarySeq,
      snapshotToken: n.snapshotToken,
      taskState: n.taskState,
      createdAtUtc: n.createdAtUtc,
      sealedAtUtc: n.sealedAtUtc,
    });
  } catch (error) {
    const message = String((error && error.message) || error);
    const code = message.indexOf('shadow-seal-invalid:') !== -1 ? 'shadow-seal-invalid' : 'shadow-checkpoint-build-failed';
    return finalize('shadow-invalid', null, Object.assign({}, baseProjection, { attempted: true }), [
      { code, detail: message.slice(0, 300) },
    ]);
  }
  const sealed = { checkpoint: shadowCheckpoint.sealedCheckpoint, checkpointId: shadowCheckpoint.checkpointId, contentDigest: shadowCheckpoint.contentDigest, sizeBytes: shadowCheckpoint.sizeBytes, seal: shadowCheckpoint.seal };
  let coverageOk = false;
  try {
    const coverage = gateV2.assertCheckpointCoverageV2({
      schemaVersion: 1,
      taskState: n.taskState,
      checkpoint: sealed.checkpoint,
      safePointDecision: n.safePointDecision,
      snapshotToken: n.snapshotToken,
    });
    if (!coverage || coverage.ok !== true) {
      return finalize('shadow-invalid', null, Object.assign({}, baseProjection, { attempted: true }), [
        { code: 'shadow-coverage-mismatch', detail: (coverage && coverage.reason) || 'coverage refused' },
      ]);
    }
    coverageOk = true;
  } catch (error) {
    return finalize('shadow-invalid', null, Object.assign({}, baseProjection, { attempted: true }), [
      { code: 'shadow-coverage-mismatch', detail: String((error && error.message) || error).slice(0, 300) },
    ]);
  }

  const candidateBoundary = retentionPlan.candidateCompactionBoundarySeq;
  const retainedStart = retentionPlan.retainedSuffixStartSeq;
  if (!Number.isInteger(candidateBoundary) || !Number.isInteger(retainedStart) || retainedStart !== candidateBoundary + 1) {
    return finalize('shadow-invalid', null, Object.assign({}, baseProjection, { attempted: true }), [
      { code: 'shadow-projection-failed', detail: 'retention boundary is not a contiguous cut' },
    ]);
  }
  if (cutSplitsSpan(candidateBoundary, n.protocolSpans)) {
    return finalize('shadow-invalid', null, Object.assign({}, baseProjection, { attempted: true }), [
      { code: 'shadow-projection-protocol', detail: 'candidate cut splits a protocol span' },
    ]);
  }

  // A09H: the COMPLETE hypothetical model-facing context (checkpoint
  // payload representation plus retained suffix), built through the shared
  // pure builder A10 will later apply. Suffix-only accounting is gone:
  // every cost below measures model-facing message surfaces.
  let artifact = null;
  try {
    artifact = buildCompactedProjectionV2({
      schemaVersion: 1,
      taskId: n.taskId,
      taskInstanceId: n.taskInstanceId,
      sessionId: n.sessionId,
      generation: n.generation,
      sealedCheckpoint: sealed.checkpoint,
      retentionPlan,
      snapshotToken: n.snapshotToken,
      taskState: n.taskState,
      contextUnits: n.contextUnits,
      sourceEvents: n.sessionEvents,
      surfaceNodes: n.surfaceNodes,
      protocolSpans: n.protocolSpans,
    });
  } catch (error) {
    return finalize('shadow-invalid', null, Object.assign({}, baseProjection, { attempted: true }), [
      { code: 'shadow-projection-failed', detail: String((error && error.message) || error).slice(0, 300) },
    ]);
  }
  const artCheck = validateCompactedProjectionV2(artifact, {
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    generation: n.generation,
    operationId: artifact.operationId,
    checkpointId: sealed.checkpointId,
    checkpointContentDigest: sealed.contentDigest,
    retentionPlanId: retentionPlan.retentionPlanId,
    sourceSnapshotTokenId: snapshotTokenId,
    sourceRevisionDigest: revisionDigest,
    candidateCompactionBoundarySeq: candidateBoundary,
    retainedSuffixStartSeq: retainedStart,
    sourceEvents: n.sessionEvents,
    surfaceNodes: n.surfaceNodes,
    taskState: n.taskState,
    contextUnits: n.contextUnits,
    protocolSpans: n.protocolSpans,
  });
  if (!artCheck.valid) {
    return finalize('shadow-invalid', null, Object.assign({}, baseProjection, { attempted: true }), [
      { code: artCheck.reason, detail: artCheck.reason },
    ]);
  }

  // A09H token accounting over equivalent model-facing surfaces. before =
  // cost of the current messages; projected = cost of the COMPLETE
  // hypothetical messages (payload plus anchors plus retained suffix).
  // Frozen: reclaim = before - projected, and projected must cover the
  // checkpoint payload representation cost (honest estimated precision).
  const beforeMessages = [];
  for (const seq of n.surfaceNodes) {
    const event = n.sessionEvents[seq];
    if (!event || event.seq !== seq) {
      return finalize('shadow-invalid', null, Object.assign({}, baseProjection, { attempted: true }), [
        { code: 'shadow-projection-messages', detail: 'current surface does not resolve' },
      ]);
    }
    const message = deriveProjectedMessageV2(event);
    if (message !== null && message !== undefined) beforeMessages.push(message);
  }
  const retainedMessages = [];
  for (const seq of n.surfaceNodes) {
    if (seq <= candidateBoundary) continue;
    const message = deriveProjectedMessageV2(n.sessionEvents[seq]);
    if (message !== null && message !== undefined) retainedMessages.push(message);
  }
  const beforeTokens = messageTokensOf(beforeMessages).tokens;
  const projectedTokens = messageTokensOf(artifact.projectedMessages).tokens;
  const payloadTokens = messageTokensOf([artifact.replacementMessages[0]]).tokens;
  const suffixTokens = messageTokensOf(retainedMessages).tokens;
  if (projectedTokens < payloadTokens) {
    return finalize('shadow-invalid', null, Object.assign({}, baseProjection, { attempted: true }), [
      { code: 'shadow-projection-messages', detail: 'projected cost is below the payload representation cost' },
    ]);
  }
  const reclaimTokens = beforeTokens - projectedTokens;
  const a08Planned = retentionPlan.projectedReclaimTokens;
  const reclaimComparison = {
    a08PlannedReclaimTokens: a08Planned,
    a09ProjectedReclaimTokens: reclaimTokens,
    deltaTokens: reclaimTokens - a08Planned,
    basisNote: 'A08 plans in unit token-cost basis over classified context units; A09 measures the complete model-facing message basis including the checkpoint payload representation and projection framing.',
  };

  const checkpointDescriptor = {
    checkpointId: sealed.checkpointId,
    checkpointContentDigest: sealed.contentDigest,
    generation: n.generation,
    safePointBoundarySeq: safeBoundarySeq,
    snapshotTokenId,
    revisionDigest,
    sealDigest: sealed.seal.sealDigest,
    checkpointBytes: sealed.sizeBytes,
    requiredItemCount: countRequiredItems(n.taskState),
    coverageOk,
  };

  const projection = {
    attempted: true,
    valid: true,
    beforeEventCount: n.sessionEvents.length,
    projectedEventCount: n.sessionEvents.length + artifact.replacementMessages.length,
    beforeMessageCount: beforeMessages.length,
    projectedMessageCount: artifact.projectedMessages.length,
    beforeContextTokens: beforeTokens,
    projectedContextTokens: projectedTokens,
    checkpointPayloadTokens: payloadTokens,
    retainedSuffixTokens: suffixTokens,
    projectedReclaimTokens: reclaimTokens,
    precision: 'estimated',
    currentUserMessageCountBefore: 1,
    currentUserMessageCountAfter: 1,
    protocolBalanced: true,
    projectionDigest: artifact.projectionDigest,
    operationId: artifact.operationId,
    segments: deepClone(artifact.segments),
  };

  return finalize('shadow-ready', checkpointDescriptor, projection, [], reclaimComparison);
}

function countRequiredItems(taskState) {
  let count = 0;
  if (taskState.objective) count += 1;
  if (Array.isArray(taskState.requirements)) count += taskState.requirements.length;
  if (Array.isArray(taskState.constraints)) count += taskState.constraints.length;
  if (Array.isArray(taskState.decisions)) count += taskState.decisions.length;
  return count;
}

// ---- closed-world result validation (unknown keys fail closed) ----

function validateShadowResultV2(result) {
  const fail = (reason) => ({ valid: false, reason });
  if (!result || typeof result !== 'object' || Array.isArray(result)) return fail('shadow-result-missing');
  if (unknownKeyOf(result, SHADOW_RESULT_EXACT_KEYS) !== null) return fail('shadow-unknown-field');
  if (Number(result.schemaVersion) !== SHADOW_SCHEMA_VERSION) return fail('shadow-schema-mismatch');
  if (SHADOW_VERDICTS.indexOf(result.verdict) === -1) return fail('shadow-verdict-unknown');
  if (!Array.isArray(result.blockers)) return fail('shadow-blockers-missing');
  for (const b of result.blockers) {
    if (!b || typeof b !== 'object') return fail('shadow-blocker-malformed');
    if (unknownKeyOf(b, SHADOW_BLOCKER_EXACT_KEYS) !== null) return fail('shadow-blocker-unknown-field');
    if (SHADOW_BLOCKER_CODES.indexOf(b.code) === -1) return fail('shadow-blocker-unknown');
    if (b.detail !== null && b.detail !== undefined && typeof b.detail !== 'string') return fail('shadow-blocker-detail-invalid');
    if (typeof b.detail === 'string' && b.detail.length > SHADOW_BOUNDS.detail) return fail('shadow-blocker-detail-invalid');
  }
  if (result.verdict === 'shadow-ready' && result.blockers.length !== 0) return fail('shadow-ready-with-blockers');
  if (result.verdict !== 'shadow-ready' && result.blockers.length === 0) return fail('shadow-non-ready-without-blocker');
  if (result.checkpoint !== null && result.checkpoint !== undefined) {
    if (unknownKeyOf(result.checkpoint, SHADOW_CHECKPOINT_DESCRIPTOR_EXACT_KEYS) !== null) {
      return fail('shadow-checkpoint-unknown-field');
    }
  }
  if (!result.projection || typeof result.projection !== 'object') return fail('shadow-projection-missing');
  if (unknownKeyOf(result.projection, SHADOW_PROJECTION_EXACT_KEYS) !== null) return fail('shadow-projection-unknown-field');
  if (SHADOW_PRECISIONS.indexOf(result.projection.precision) === -1) return fail('shadow-precision-unknown');
  if (result.reclaimComparison !== null && result.reclaimComparison !== undefined) {
    if (unknownKeyOf(result.reclaimComparison, SHADOW_RECLAIM_COMPARISON_EXACT_KEYS) !== null) {
      return fail('shadow-reclaim-unknown-field');
    }
    if (typeof result.reclaimComparison.a08PlannedReclaimTokens !== 'number'
      || typeof result.reclaimComparison.a09ProjectedReclaimTokens !== 'number'
      || typeof result.reclaimComparison.deltaTokens !== 'number'
      || typeof result.reclaimComparison.basisNote !== 'string') {
      return fail('shadow-reclaim-malformed');
    }
    if (result.reclaimComparison.deltaTokens !== result.reclaimComparison.a09ProjectedReclaimTokens - result.reclaimComparison.a08PlannedReclaimTokens) {
      return fail('shadow-reclaim-malformed');
    }
  }
  if (result.verdict === 'shadow-ready' && (result.reclaimComparison === null || result.reclaimComparison === undefined)) {
    return fail('shadow-ready-without-reclaim');
  }
  if (typeof result.shadowDigest !== 'string' || result.shadowDigest.length !== 64) return fail('shadow-digest-invalid');
  if (typeof result.shadowId !== 'string' || result.shadowId.slice(0, 4) !== 'csr_') return fail('shadow-id-invalid');
  const body = {};
  for (const key of SHADOW_RESULT_EXACT_KEYS) {
    if (key === 'shadowDigest' || key === 'shadowId') continue;
    body[key] = result[key];
  }
  const expectedDigest = sha256HexUtf8(SHADOW_RESULT_DIGEST_DOMAIN_V1 + LF_JOIN + serializeCanonical(body));
  if (result.shadowDigest !== expectedDigest) return fail('shadow-digest-mismatch');
  const expectedId = 'csr_' + sha256HexUtf8(
    SHADOW_RESULT_ID_DOMAIN_V1 + LF_JOIN + String(result.taskId) + LF_JOIN + String(result.generation) + LF_JOIN + expectedDigest
  ).slice(0, 32);
  if (result.shadowId !== expectedId) return fail('shadow-id-mismatch');
  return { valid: true, reason: null };
}

// ---- freshness: an old result never becomes eligible without re-evaluation ----

function assertShadowResultFresh(result, current) {
  const stale = (reason) => ({ ok: false, reason });
  const check = validateShadowResultV2(result);
  if (!check.valid) return stale(check.reason);
  if (!current || typeof current !== 'object') return stale('shadow-stale');
  if (current.taskId !== result.taskId) return stale('shadow-stale');
  if (current.taskInstanceId !== result.taskInstanceId) return stale('shadow-stale');
  if (current.sessionId !== result.sessionId) return stale('shadow-stale');
  if (current.generation !== result.generation) return stale('shadow-stale');
  if (current.snapshotTokenId !== result.snapshotTokenId) return stale('shadow-stale');
  if (current.revisionDigest !== result.revisionDigest) return stale('shadow-stale');
  if (current.safePointBoundarySeq !== undefined && current.safePointBoundarySeq !== result.safePointBoundarySeq) {
    return stale('shadow-stale');
  }
  if (current.providerModelId !== undefined && current.providerModelId !== result.providerModelId) {
    return stale('shadow-stale');
  }
  if (current.pressureBasisDigest !== undefined && current.pressureBasisDigest !== result.pressureBasisDigest) {
    return stale('shadow-stale');
  }
  if (current.retentionPlanId !== undefined && current.retentionPlanId !== result.retentionPlanId) {
    return stale('shadow-stale');
  }
  return { ok: true, reason: null };
}

// ---- bounded observational telemetry (counts/digests/ids only; no text) ----

function shadowTelemetry(result) {
  const check = validateShadowResultV2(result);
  if (!check.valid) failShadow('telemetry refused (' + check.reason + ')');
  const plan = result.retentionPlan;
  return Object.freeze({
    shadowVerdict: result.verdict,
    pressureLevel: result.pressure && result.pressure.level !== undefined ? result.pressure.level : null,
    pressureRecommendation: result.pressure && result.pressure.recommendation !== undefined ? result.pressure.recommendation : null,
    safePoint: result.safePoint && result.safePoint.safe === true,
    checkpointable: result.checkpointability && result.checkpointability.checkpointable === true,
    retentionActionable: plan ? plan.actionable === true : false,
    currentContextTokens: result.pressure && result.pressure.currentContextTokens !== undefined ? result.pressure.currentContextTokens : null,
    projectedContextTokens: result.projection.projectedContextTokens,
    projectedReclaimTokens: result.projection.projectedReclaimTokens,
    projectedHeadroomAfterTokens: plan && plan.projectedHeadroomAfterTokens !== undefined ? plan.projectedHeadroomAfterTokens : null,
    eligiblePrefixEndSeq: plan && plan.eligiblePrefixEndSeq !== undefined ? plan.eligiblePrefixEndSeq : null,
    candidateCompactionBoundarySeq: plan && plan.candidateCompactionBoundarySeq !== undefined ? plan.candidateCompactionBoundarySeq : null,
    retainedSuffixStartSeq: plan && plan.retainedSuffixStartSeq !== undefined ? plan.retainedSuffixStartSeq : null,
    checkpointBytes: result.checkpoint && result.checkpoint.checkpointBytes !== undefined ? result.checkpoint.checkpointBytes : null,
    checkpointRequiredItemCount: result.checkpoint && result.checkpoint.requiredItemCount !== undefined ? result.checkpoint.requiredItemCount : null,
    projectionEventCountBefore: result.projection.beforeEventCount,
    projectionEventCountAfter: result.projection.projectedEventCount,
    projectedMessageCount: result.projection.projectedMessageCount,
    checkpointPayloadTokens: result.projection.checkpointPayloadTokens,
    retainedSuffixTokens: result.projection.retainedSuffixTokens,
    a08PlannedReclaimTokens: result.reclaimComparison ? result.reclaimComparison.a08PlannedReclaimTokens : null,
    a09ProjectedReclaimTokens: result.reclaimComparison ? result.reclaimComparison.a09ProjectedReclaimTokens : null,
    reclaimDeltaTokens: result.reclaimComparison ? result.reclaimComparison.deltaTokens : null,
    currentUserCountBefore: result.projection.currentUserMessageCountBefore,
    currentUserCountAfter: result.projection.currentUserMessageCountAfter,
    protocolBalanced: result.projection.protocolBalanced,
    blockerCodes: Object.freeze(result.blockers.map((b) => b.code).slice().sort()),
  });
}

// ---- live-state fingerprint (immutability proof support; read-only) ----

function fingerprintLiveState(input) {
  if (!input || typeof input !== 'object') failShadow('fingerprint input is required');
  const body = {
    sessionEvents: input.sessionEvents === undefined ? null : input.sessionEvents,
    deriveMessages: input.deriveMessages === undefined ? null : input.deriveMessages,
    taskState: input.taskState === undefined ? null : input.taskState,
    snapshotToken: input.snapshotToken === undefined ? null : input.snapshotToken,
    checkpointState: input.checkpointState === undefined ? null : input.checkpointState,
    runtimeSnapshotIdentity: input.runtimeSnapshotIdentity === undefined ? null : input.runtimeSnapshotIdentity,
  };
  return sha256HexUtf8('nexus/context-shadow-fingerprint/v1' + LF_JOIN + serializeCanonical(body));
}

module.exports = {
  SHADOW_SCHEMA_VERSION,
  SHADOW_VERDICTS,
  SHADOW_BLOCKER_CODES,
  SHADOW_RESULT_DIGEST_DOMAIN_V1,
  SHADOW_RESULT_ID_DOMAIN_V1,
  SHADOW_PROJECTION_DIGEST_DOMAIN_V2,
  SHADOW_INPUT_EXACT_KEYS,
  SHADOW_RESULT_EXACT_KEYS,
  evaluateShadowCompactionV2,
  buildShadowCheckpointV2,
  buildCompactedProjectionV2,
  validateCompactedProjectionV2,
  deriveProjectedMessageV2,
  checkMessagesBalanced,
  checkpointPayloadTextOf,
  messageTokensOf,
  validateShadowResultV2,
  assertShadowResultFresh,
  shadowTelemetry,
  fingerprintLiveState,
  canonicalize,
  serializeCanonical,
  sha256HexUtf8,
};
