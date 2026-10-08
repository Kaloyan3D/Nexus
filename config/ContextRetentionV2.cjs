'use strict';
/**
 * ContextRetentionV2.cjs - CCV2-A08 RetentionPlannerV2 production authority.
 *
 * ONE authority for the V2 retention plan: closed-world retention
 * classification, contiguous-prefix candidate boundary selection, retained
 * suffix planning, projected savings, plan identity, and stale-plan
 * validation. No other CCv2 component redefines what is eligible to leave
 * active context.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (A08 sections). This module answers A08 question 2: what existing
 * context may leave the active prompt without violating the frozen
 * A01-A07 safety contracts. It PLANS ONLY: it never deletes context,
 * never mutates the session projection, never triggers a checkpoint, and
 * never performs compaction (A09 observes in shadow mode; A10 applies).
 *
 * Authority separation (frozen):
 *   A05 answers whether this is still the same state (freshness).
 *   A06 answers whether this is a coherent boundary (safe point).
 *   A07 answers whether the task survives checkpointing (coverage).
 *   A08 answers whether pressure justifies compaction and what is eligible.
 * This module CONSUMES the A05/A06/A07 verdicts verbatim through their own
 * validators and never redefines safe, fresh, or checkpointable.
 *
 * Fundamental invariant (frozen): eligibility derives ONLY from authority
 * metadata (continuation requirements, A07 coverage, durability,
 * reconstructibility, protocol position). Never from semantic intuition:
 * age alone never makes an event eligible; size alone never makes content
 * eligible; prompt text such as RETENTION_CLASS=DISCARDABLE has zero
 * policy effect (content-bearing fields FAIL CLOSED on input).
 *
 * Retention classes (closed world):
 *   ACTIVE_REQUIRED     - must remain directly available in the active
 *                         continuation projection (current user request,
 *                         uncovered required state).
 *   CHECKPOINT_COVERED  - historical source releasable only because A07
 *                         proves the state is represented or durably
 *                         reconstructible; actual release additionally
 *                         requires A07 post-build PASS + persisted seal.
 *   REHYDRATABLE        - an authoritative durable source can reconstruct
 *                         the unit exactly when needed (validated ref).
 *   DERIVED_DISCARDABLE - explicitly non-authoritative derived/cache
 *                         material that may be regenerated.
 *   NOT_ELIGIBLE        - cannot currently leave active context.
 *
 * Prefix semantics (frozen): compaction is a contiguous eligible old prefix
 * plus a retained suffix. One non-eligible event inside the prefix moves
 * the cut earlier or BLOCKS; the planner never skips around it.
 * The candidate boundary is a real authoritative DSH event seq (never a
 * message index, timestamp, or array guess) at or before the A06
 * safePointBoundarySeq, and it never splits a declared protocol span
 * (tool request/result lifecycle, stream lifecycle, controller
 * transition) or the current user request (which survives exactly once).
 *
 * A08H historical-cut rule (frozen): the candidate cut must itself satisfy
 * A06 safe-boundary semantics. A08 computes the latest retention-eligible
 * prefix end, then walks unit-aligned eligible ends backward asking A06
 * (classifyHistoricalBoundaryV2, the same frozen state machine over the
 * authoritative prefix) about each exact seq. The first A06-safe end wins;
 * none yields candidate null plus retention-no-safe-boundary. A08 never
 * decides on its own that a historical seq looks safe. The caller supplies
 * the A06 observation context (boundaryContext: full sessionEvents plus the
 * sessionDurable/controller/runtime observations); A08 only asks, never
 * redefines. Projected reclaim counts the A06-authorized cut, while
 * eligiblePrefixEndSeq stays informational.
 *
 * Pressure-basis binding (frozen, A08H): every plan embeds
 * pressureBasisDigest (nexus/context-pressure-basis/v1 over policy ids,
 * reserves, route, capacity, capacity source, and cost honesty). Validation
 * recomputes it from the embedded pressure decision, and
 * assertRetentionPlanFresh() BLOCKS on any basis drift, so persisted plans
 * never survive policy/config changes without replanning.
 *
 * Frozen identity formulas:
 *   retentionPlanDigest = SHA256(UTF8('nexus/context-retention-plan/v1'
 *                         LF canonicalJson(planBodyWithoutDigestOrId)))
 *   retentionPlanId     = 'crp_' + SHA256('nexus/context-retention-plan-id/v1'
 *                         LF taskId LF generation LF retentionPlanDigest).slice(0, 32)
 * No timestamps enter the digested body.
 *
 * Frozen hysteresis/minimum policy: minimumReclaimTokens = 2048 (shared
 * with the pressure threshold policy id). Projected reclaim below the
 * minimum yields actionable=false with blocker
 * retention-insufficient-reclaim, even under elevated pressure; CRITICAL
 * with no safe useful cut still fails honestly (blocked), never compacts.
 *
 * Determinism: no clock, no randomness, no LLM. Security: classification
 * derives only from protocol/authority metadata; TEXT is inert and
 * content-bearing input fields fail closed. Secrets never enter plans:
 * telemetry carries counts/digests/ids only.
 */

const crypto = require('node:crypto');
const pressureV2 = require('./ContextPressureV2.cjs');
const snapshotV2 = require('./ContextSnapshotV2.cjs');
const safepointV2 = require('./ContextSafePointV2.cjs');
const gateV2 = require('./ContextCheckpointabilityV2.cjs');

const RETENTION_SCHEMA_VERSION = 1;
const RETENTION_PLAN_DIGEST_DOMAIN_V1 = 'nexus/context-retention-plan/v1';
const RETENTION_PLAN_ID_DOMAIN_V1 = 'nexus/context-retention-plan-id/v1';
const RETENTION_HYSTERESIS_POLICY_ID_V1 = 'nexus/context-retention-hysteresis/v1';
const LF_JOIN = String.fromCharCode(10);

// Frozen minimum useful compaction (tokens). Shared value with the
// pressure threshold policy; single definition lives in pressureV2.
const MINIMUM_RECLAIM_TOKENS = 2048;

const RETENTION_CLASSES = Object.freeze([
  'ACTIVE_REQUIRED',
  'CHECKPOINT_COVERED',
  'REHYDRATABLE',
  'DERIVED_DISCARDABLE',
  'NOT_ELIGIBLE',
]);

const ELIGIBLE_PREFIX_CLASSES = Object.freeze(['CHECKPOINT_COVERED', 'REHYDRATABLE', 'DERIVED_DISCARDABLE']);

const RETENTION_REASON_CODES = Object.freeze([
  'retention-active-user-turn',
  'retention-required-state-uncovered',
  'retention-checkpoint-covered',
  'retention-rehydratable',
  'retention-derived-discardable',
  'retention-not-eligible',
  'retention-newer-than-boundary',
]);

const RETENTION_BLOCKER_CODES = Object.freeze([
  'pressure-capacity-unknown',
  'pressure-accounting-invalid',
  'retention-safe-point-required',
  'retention-snapshot-required',
  'retention-snapshot-stale',
  'retention-checkpointability-required',
  'retention-no-eligible-prefix',
  'retention-required-state-uncovered',
  'retention-durable-reference-unavailable',
  'retention-active-user-turn',
  'retention-boundary-mismatch',
  'retention-no-safe-boundary',
  'retention-plan-stale',
  'retention-insufficient-reclaim',
  'retention-provider-capacity-unknown',
]);

const A07_COVERAGE_VALUES = Object.freeze(['represented', 'reconstructible']);

const RETENTION_UNIT_EXACT_KEYS = Object.freeze([
  'unitId',
  'eventSeqStart',
  'eventSeqEnd',
  'requiresContinuation',
  'a07Coverage',
  'durableReference',
  'derivedNonAuthoritative',
  'isCurrentUserTurn',
  'tokenCost',
]);

const RETENTION_DURABLE_REF_EXACT_KEYS = Object.freeze([
  'accessible',
  'identityBound',
  'nonEphemeral',
  'revalidatable',
]);

const RETENTION_TOKEN_COST_EXACT_KEYS = Object.freeze(['tokens', 'method', 'exact']);
const RETENTION_SPAN_EXACT_KEYS = Object.freeze(['startSeq', 'endSeq']);
const RETENTION_CLASSIFICATION_EXACT_KEYS = Object.freeze([
  'unitId',
  'eventSeqStart',
  'eventSeqEnd',
  'retentionClass',
  'reasonCode',
]);
const RETENTION_BLOCKER_EXACT_KEYS = Object.freeze(['code', 'detail']);

const RETENTION_PLAN_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'generation',
  'snapshotToken',
  'safePointDecision',
  'checkpointabilityDecision',
  'pressureDecision',
  'boundaryContext',
  'contextUnits',
  'protocolSpans',
]);
const RETENTION_BOUNDARY_CONTEXT_EXACT_KEYS = Object.freeze([
  'sessionEvents',
  'sessionDurable',
  'controller',
  'runtime',
]);

const RETENTION_PLAN_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'generation',
  'snapshotTokenId',
  'revisionDigest',
  'safePointBoundarySeq',
  'providerModelId',
  'providerCapacityTokens',
  'pressure',
  'pressureBasisDigest',
  'candidateCompactionBoundarySeq',
  'classifications',
  'eligiblePrefixEndSeq',
  'retainedSuffixStartSeq',
  'projectedReclaimTokens',
  'projectedRetainedTokens',
  'projectedHeadroomAfterTokens',
  'projectionPrecision',
  'actionable',
  'blockers',
  'retentionPlanDigest',
  'retentionPlanId',
]);

const RETENTION_BOUNDS = Object.freeze({
  taskId: 256,
  taskInstanceId: 256,
  sessionId: 256,
  unitId: 256,
  tokenId: 256,
  digest: 128,
  detail: 1024,
  unitsMax: 100000,
  spansMax: 100000,
  seqMax: 100000000,
  tokensMax: 100000000,
});

function failRetention(message) {
  throw new Error('v2-retention: ' + message + ' (KEEP)');
}

function unknownKeyOf(value, allowedKeys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    if (allowedKeys.indexOf(key) === -1) return key;
  }
  return null;
}

function isBoundedString(value, max, allowEmpty) {
  if (typeof value !== 'string') return false;
  if (!allowEmpty && value === '') return false;
  return value.length <= max;
}

function sha256HexUtf8(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

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

function sortBlockers(blockers) {
  return blockers.slice().sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

function isValidDurableReference(ref) {
  if (ref === null || ref === undefined) return false;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return false;
  if (unknownKeyOf(ref, RETENTION_DURABLE_REF_EXACT_KEYS) !== null) return false;
  return ref.accessible === true && ref.identityBound === true && ref.nonEphemeral === true && ref.revalidatable === true;
}

function normalizeTokenCost(cost, what) {
  if (!cost || typeof cost !== 'object' || Array.isArray(cost)) failRetention(what + ' tokenCost is required');
  const unknown = unknownKeyOf(cost, RETENTION_TOKEN_COST_EXACT_KEYS);
  if (unknown !== null) failRetention(what + ' unknown tokenCost field ' + unknown);
  if (!Number.isInteger(cost.tokens) || cost.tokens < 0 || cost.tokens > RETENTION_BOUNDS.tokensMax) {
    failRetention(what + ' tokenCost.tokens must be a non-negative integer within bounds');
  }
  if (pressureV2.COST_METHODS.indexOf(cost.method) === -1) failRetention(what + ' tokenCost.method must be a closed-world cost method');
  if (typeof cost.exact !== 'boolean') failRetention(what + ' tokenCost.exact must be boolean');
  if (cost.method === 'provider-tokenizer' && cost.exact !== true) failRetention(what + ' provider-tokenizer costs must be exact');
  if ((cost.method === 'deterministic-estimate' || cost.method === 'conservative-estimate') && cost.exact !== false) {
    failRetention(what + ' estimated costs must not claim exact');
  }
  return { tokens: cost.tokens, method: cost.method, exact: cost.exact };
}

function normalizeUnit(raw, index) {
  const what = 'contextUnits[' + index + ']';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) failRetention(what + ' must be an object');
  const unknown = unknownKeyOf(raw, RETENTION_UNIT_EXACT_KEYS);
  if (unknown !== null) failRetention(what + ' unknown field ' + unknown);
  if (!isBoundedString(raw.unitId, RETENTION_BOUNDS.unitId, false)) failRetention(what + ' unitId is required');
  if (!Number.isInteger(raw.eventSeqStart) || raw.eventSeqStart < 0 || raw.eventSeqStart > RETENTION_BOUNDS.seqMax) {
    failRetention(what + ' eventSeqStart must be a non-negative integer within bounds');
  }
  if (!Number.isInteger(raw.eventSeqEnd) || raw.eventSeqEnd < raw.eventSeqStart || raw.eventSeqEnd > RETENTION_BOUNDS.seqMax) {
    failRetention(what + ' eventSeqEnd must be an integer >= eventSeqStart within bounds');
  }
  if (typeof raw.requiresContinuation !== 'boolean') failRetention(what + ' requiresContinuation must be boolean');
  if (raw.a07Coverage !== null && raw.a07Coverage !== undefined && A07_COVERAGE_VALUES.indexOf(raw.a07Coverage) === -1) {
    failRetention(what + ' a07Coverage must be represented, reconstructible, or null');
  }
  if (raw.durableReference !== null && raw.durableReference !== undefined) {
    const runknown = unknownKeyOf(raw.durableReference, RETENTION_DURABLE_REF_EXACT_KEYS);
    if (runknown !== null) failRetention(what + ' unknown durableReference field ' + runknown);
    for (const key of RETENTION_DURABLE_REF_EXACT_KEYS) {
      if (typeof raw.durableReference[key] !== 'boolean') failRetention(what + ' durableReference.' + key + ' must be boolean');
    }
  }
  if (typeof raw.derivedNonAuthoritative !== 'boolean') failRetention(what + ' derivedNonAuthoritative must be boolean');
  if (typeof raw.isCurrentUserTurn !== 'boolean') failRetention(what + ' isCurrentUserTurn must be boolean');
  const tokenCost = normalizeTokenCost(raw.tokenCost, what);
  return {
    unitId: raw.unitId,
    eventSeqStart: raw.eventSeqStart,
    eventSeqEnd: raw.eventSeqEnd,
    requiresContinuation: raw.requiresContinuation,
    a07Coverage: raw.a07Coverage === undefined ? null : raw.a07Coverage,
    durableReference: raw.durableReference === undefined ? null : raw.durableReference,
    derivedNonAuthoritative: raw.derivedNonAuthoritative,
    isCurrentUserTurn: raw.isCurrentUserTurn,
    tokenCost,
  };
}

function normalizeSpans(raw) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) failRetention('protocolSpans must be an array');
  if (raw.length > RETENTION_BOUNDS.spansMax) failRetention('protocolSpans exceeds the bound');
  return raw.map((span, index) => {
    const what = 'protocolSpans[' + index + ']';
    if (!span || typeof span !== 'object' || Array.isArray(span)) failRetention(what + ' must be an object');
    const unknown = unknownKeyOf(span, RETENTION_SPAN_EXACT_KEYS);
    if (unknown !== null) failRetention(what + ' unknown field ' + unknown);
    if (!Number.isInteger(span.startSeq) || span.startSeq < 0 || span.startSeq > RETENTION_BOUNDS.seqMax) {
      failRetention(what + ' startSeq must be a non-negative integer within bounds');
    }
    if (!Number.isInteger(span.endSeq) || span.endSeq < span.startSeq || span.endSeq > RETENTION_BOUNDS.seqMax) {
      failRetention(what + ' endSeq must be an integer >= startSeq within bounds');
    }
    return { startSeq: span.startSeq, endSeq: span.endSeq };
  });
}

// Frozen classification: authority metadata ONLY. Order matters:
// current-user-turn protection first, then required-state gating on A07
// coverage, then durable reconstruction, then derived-cache, else blocked.
function classifyUnit(unit) {
  if (unit.isCurrentUserTurn === true) {
    return { retentionClass: 'ACTIVE_REQUIRED', reasonCode: 'retention-active-user-turn' };
  }
  const covered = unit.a07Coverage === 'represented' || unit.a07Coverage === 'reconstructible';
  if (unit.requiresContinuation === true) {
    if (covered) return { retentionClass: 'CHECKPOINT_COVERED', reasonCode: 'retention-checkpoint-covered' };
    if (isValidDurableReference(unit.durableReference)) {
      return { retentionClass: 'REHYDRATABLE', reasonCode: 'retention-rehydratable' };
    }
    return { retentionClass: 'NOT_ELIGIBLE', reasonCode: 'retention-required-state-uncovered' };
  }
  if (isValidDurableReference(unit.durableReference)) {
    return { retentionClass: 'REHYDRATABLE', reasonCode: 'retention-rehydratable' };
  }
  if (covered) return { retentionClass: 'CHECKPOINT_COVERED', reasonCode: 'retention-checkpoint-covered' };
  if (unit.derivedNonAuthoritative === true) {
    return { retentionClass: 'DERIVED_DISCARDABLE', reasonCode: 'retention-derived-discardable' };
  }
  return { retentionClass: 'NOT_ELIGIBLE', reasonCode: 'retention-not-eligible' };
}

function normalizePlanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) failRetention('input is required');
  for (const banned of ['text', 'content', 'prompt', 'message', 'transcript', 'importance', 'priority']) {
    if (input[banned] !== undefined) failRetention('content field ' + banned + ' is forbidden');
  }
  const unknown = unknownKeyOf(input, RETENTION_PLAN_INPUT_EXACT_KEYS);
  if (unknown !== null) failRetention('unknown field ' + unknown);
  if (Number(input.schemaVersion) !== RETENTION_SCHEMA_VERSION) failRetention('schemaVersion must be 1');
  if (!isBoundedString(input.taskId, RETENTION_BOUNDS.taskId, false)) failRetention('taskId is required');
  if (!isBoundedString(input.taskInstanceId, RETENTION_BOUNDS.taskInstanceId, false)) failRetention('taskInstanceId is required');
  if (!isBoundedString(input.sessionId, RETENTION_BOUNDS.sessionId, false)) failRetention('sessionId is required');
  if (!Number.isInteger(input.generation) || input.generation < 1) failRetention('generation must be a positive integer');
  if (!input.snapshotToken || typeof input.snapshotToken !== 'object') failRetention('snapshotToken is required');
  if (!input.safePointDecision || typeof input.safePointDecision !== 'object') failRetention('safePointDecision is required');
  if (!input.checkpointabilityDecision || typeof input.checkpointabilityDecision !== 'object') {
    failRetention('checkpointabilityDecision is required');
  }
  if (!input.pressureDecision || typeof input.pressureDecision !== 'object') failRetention('pressureDecision is required');
  if (!Array.isArray(input.contextUnits)) failRetention('contextUnits must be an array');
  if (input.contextUnits.length === 0) failRetention('contextUnits must not be empty');
  if (input.contextUnits.length > RETENTION_BOUNDS.unitsMax) failRetention('contextUnits exceeds the bound');
  const units = input.contextUnits.map((u, i) => normalizeUnit(u, i));
  const seen = Object.create(null);
  for (const u of units) {
    if (seen[u.unitId] === true) failRetention('duplicate unitId ' + u.unitId);
    seen[u.unitId] = true;
  }
  const ordered = units.slice().sort((a, b) => a.eventSeqStart - b.eventSeqStart);
  if (ordered[0].eventSeqStart !== 0) failRetention('contextUnits must tile from seq 0 (boundary-mismatch)');
  for (let i = 0; i < ordered.length; i += 1) {
    if (i > 0 && ordered[i].eventSeqStart !== ordered[i - 1].eventSeqEnd + 1) {
      failRetention('contextUnits must tile contiguously without gaps or overlaps (boundary-mismatch)');
    }
  }
  const userTurns = units.filter((u) => u.isCurrentUserTurn === true);
  if (userTurns.length !== 1) failRetention('exactly one current user turn is required');
  const spans = normalizeSpans(input.protocolSpans);
  const boundaryContext = normalizeBoundaryContext(input.boundaryContext);
  return {
    schemaVersion: RETENTION_SCHEMA_VERSION,
    taskId: input.taskId,
    taskInstanceId: input.taskInstanceId,
    sessionId: input.sessionId,
    generation: input.generation,
    snapshotToken: input.snapshotToken,
    safePointDecision: input.safePointDecision,
    checkpointabilityDecision: input.checkpointabilityDecision,
    pressureDecision: input.pressureDecision,
    boundaryContext,
    contextUnits: ordered,
    protocolSpans: spans,
  };
}

// Closed-world validation for the A06 observation context. The session event
// payloads may carry message text (inert data A06 never branches on); only the
// top-level protocol structure is validated here, and A06 revalidates every
// leg verbatim on each historical-boundary call.
function normalizeBoundaryContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) failRetention('boundaryContext is required');
  const unknown = unknownKeyOf(raw, RETENTION_BOUNDARY_CONTEXT_EXACT_KEYS);
  if (unknown !== null) failRetention('boundaryContext unknown field ' + unknown);
  if (!Array.isArray(raw.sessionEvents) || raw.sessionEvents.length === 0) failRetention('boundaryContext.sessionEvents must be a non-empty array');
  if (raw.sessionEvents.length > RETENTION_BOUNDS.unitsMax) failRetention('boundaryContext.sessionEvents exceeds the bound');
  for (const banned of ['text', 'content', 'prompt', 'transcript', 'importance', 'priority']) {
    if (raw[banned] !== undefined) failRetention('boundaryContext content field ' + banned + ' is forbidden');
  }
  if (!raw.sessionDurable || typeof raw.sessionDurable !== 'object') failRetention('boundaryContext.sessionDurable is required');
  if (!raw.controller || typeof raw.controller !== 'object') failRetention('boundaryContext.controller is required');
  if (!raw.runtime || typeof raw.runtime !== 'object') failRetention('boundaryContext.runtime is required');
  return { sessionEvents: raw.sessionEvents, sessionDurable: raw.sessionDurable, controller: raw.controller, runtime: raw.runtime };
}

function cutSplitsSpan(candidateEndSeq, spans) {
  const cutPoint = candidateEndSeq + 1;
  for (const span of spans) {
    if (cutPoint > span.startSeq && cutPoint <= span.endSeq) return span;
  }
  return null;
}

// H2 historical-cut authorization (A08H): A06 alone decides whether an exact
// historical seq is a safe boundary. A08 walks unit-aligned eligible ends
// backward (latest first), skipping span-splitting cuts, and asks A06 about
// each via classifyHistoricalBoundaryV2 (same frozen state machine over the
// authoritative prefix). The first A06-safe end wins; none yields null and the
// caller records retention-no-safe-boundary. Structural observation failures
// fail closed (throw); seqs beyond the observed log are simply skipped.
function authorizeHistoricalCut(n, spanCleanEnd) {
  const ends = [];
  for (const u of n.contextUnits) {
    if (u.eventSeqEnd <= spanCleanEnd && ends.indexOf(u.eventSeqEnd) === -1) ends.push(u.eventSeqEnd);
  }
  ends.sort((a, b) => b - a);
  const observedLength = n.boundaryContext.sessionEvents.length;
  for (const end of ends) {
    if (cutSplitsSpan(end, n.protocolSpans) !== null) continue;
    if (end > observedLength - 1) continue;
    let verdict = null;
    try {
      verdict = safepointV2.classifyHistoricalBoundaryV2({
        schemaVersion: 1,
        taskId: n.taskId,
        taskInstanceId: n.taskInstanceId,
        sessionId: n.sessionId,
        sessionEvents: n.boundaryContext.sessionEvents,
        sessionDurable: n.boundaryContext.sessionDurable,
        controller: n.boundaryContext.controller,
        runtime: n.boundaryContext.runtime,
        candidateSeq: end,
      });
    } catch (error) {
      failRetention('boundaryContext refused by A06 (' + String((error && error.message) || error).slice(0, 160) + ')');
    }
    const vcheck = safepointV2.validateHistoricalBoundaryDecision(verdict);
    if (!vcheck.valid) failRetention('A06 historical verdict refused (' + vcheck.reason + ')');
    if (verdict.safe === true) return end;
  }
  return null;
}

// Pure deterministic retention plan. Consumes A05/A06/A07 verdicts verbatim
// via their own validators; never redefines safe, fresh, or checkpointable.
// Never mutates any live state; returns a frozen plan object.
function planRetentionV2(input) {
  const n = normalizePlanInput(input);
  const blockers = [];
  const block = (code, detail) => blockers.push({ code, detail });

  // ---- A05 binding: snapshot token must be structurally valid ----
  let snapshotValid = false;
  let snapshotTokenId = null;
  let revisionDigest = null;
  try {
    const check = snapshotV2.validateSnapshotToken(n.snapshotToken);
    if (check.valid) {
      snapshotValid = true;
      snapshotTokenId = n.snapshotToken.snapshotTokenId;
      revisionDigest = n.snapshotToken.revisionDigest;
    } else {
      block('retention-snapshot-required', 'snapshot token invalid (' + check.reason + ')');
    }
  } catch (error) {
    block('retention-snapshot-required', 'snapshot token validation failed');
  }

  // ---- A06 binding: safe-point decision must be valid AND safe ----
  let safePointOk = false;
  let safePointBoundarySeq = null;
  try {
    const check = safepointV2.validateSafePointDecision(n.safePointDecision);
    if (!check.valid) {
      block('retention-safe-point-required', 'safe-point decision invalid (' + check.reason + ')');
    } else if (n.safePointDecision.safe !== true) {
      block('retention-safe-point-required', 'safe point is not safe');
    } else {
      safePointOk = true;
      safePointBoundarySeq = n.safePointDecision.boundarySeq;
    }
  } catch (error) {
    block('retention-safe-point-required', 'safe-point validation failed');
  }

  // ---- A07 binding: checkpointability decision must be valid AND PASS ----
  let checkpointableOk = false;
  try {
    const check = gateV2.validateCheckpointabilityDecision(n.checkpointabilityDecision);
    if (!check.valid) {
      block('retention-checkpointability-required', 'checkpointability decision invalid (' + check.reason + ')');
    } else if (n.checkpointabilityDecision.checkpointable !== true) {
      block('retention-checkpointability-required', 'task is not checkpointable');
    } else {
      checkpointableOk = true;
    }
  } catch (error) {
    block('retention-checkpointability-required', 'checkpointability validation failed');
  }

  // ---- pressure binding: must be a valid, known decision ----
  let pressureOk = false;
  let pressure = null;
  try {
    const check = pressureV2.validatePressureDecision(n.pressureDecision);
    if (!check.valid) {
      block('pressure-accounting-invalid', 'pressure decision invalid (' + check.reason + ')');
    } else if (n.pressureDecision.known !== true) {
      block('retention-provider-capacity-unknown', 'pressure capacity is unknown');
      pressure = n.pressureDecision;
    } else {
      pressureOk = true;
      pressure = n.pressureDecision;
    }
  } catch (error) {
    block('pressure-accounting-invalid', 'pressure validation failed');
  }
  if (pressure === null) {
    pressure = n.pressureDecision;
  }

  // ---- cross-binding: plan identity must match the bound snapshot ----
  if (snapshotValid === true) {
    if (n.snapshotToken.generation !== n.generation) {
      block('retention-snapshot-stale', 'snapshot generation does not match plan generation');
      snapshotValid = false;
    }
    if (pressure !== null && pressure !== undefined && pressure.snapshotTokenId !== undefined && pressure.snapshotTokenId !== snapshotTokenId) {
      block('retention-snapshot-stale', 'pressure decision binds a different snapshot');
    }
    if (pressure !== null && pressure !== undefined && pressure.revisionDigest !== undefined && pressure.revisionDigest !== revisionDigest) {
      block('retention-snapshot-stale', 'pressure decision binds a different revision');
    }
    if (pressure !== null && pressure !== undefined && Number.isInteger(pressure.generation) && pressure.generation !== n.generation) {
      block('retention-snapshot-stale', 'pressure decision binds a different generation');
    }
  }

  // ---- classification (authority metadata only) ----
  const classifications = n.contextUnits.map((u) => {
    const c = classifyUnit(u);
    return { unitId: u.unitId, eventSeqStart: u.eventSeqStart, eventSeqEnd: u.eventSeqEnd, retentionClass: c.retentionClass, reasonCode: c.reasonCode };
  });
  const classById = Object.create(null);
  for (const c of classifications) classById[c.unitId] = c.retentionClass;

  // ---- contiguous eligible prefix at or before the safe boundary ----
  let eligiblePrefixEndSeq = null;
  let candidateCompactionBoundarySeq = null;
  let boundaryMismatch = false;
  if (safePointOk === true) {
    let prefixEnd = -1;
    let stopped = false;
    for (const u of n.contextUnits) {
      if (stopped) break;
      if (u.eventSeqStart > safePointBoundarySeq) break;
      const cls = classById[u.unitId];
      if (ELIGIBLE_PREFIX_CLASSES.indexOf(cls) === -1) {
        stopped = true;
        break;
      }
      const cappedEnd = u.eventSeqEnd > safePointBoundarySeq ? safePointBoundarySeq : u.eventSeqEnd;
      prefixEnd = cappedEnd;
      if (u.eventSeqEnd > safePointBoundarySeq) {
        stopped = true;
        break;
      }
    }
    if (prefixEnd >= 0) {
      let spanCleanEnd = prefixEnd;
      let guard = 0;
      let span = cutSplitsSpan(spanCleanEnd, n.protocolSpans);
      while (span !== null && guard < 100000) {
        guard += 1;
        spanCleanEnd = span.startSeq - 1;
        if (spanCleanEnd < 0) break;
        span = cutSplitsSpan(spanCleanEnd, n.protocolSpans);
      }
      if (spanCleanEnd < 0) {
        boundaryMismatch = true;
        block('retention-boundary-mismatch', 'no cut avoids splitting a protocol span');
      } else {
        let rewalkEnd = -1;
        let rewalkOk = true;
        for (const u of n.contextUnits) {
          if (u.eventSeqStart > spanCleanEnd) break;
          const cls = classById[u.unitId];
          if (ELIGIBLE_PREFIX_CLASSES.indexOf(cls) === -1) {
            rewalkOk = false;
            break;
          }
          if (u.eventSeqEnd > spanCleanEnd) {
            rewalkOk = false;
            break;
          }
          rewalkEnd = u.eventSeqEnd;
        }
        if (!rewalkOk || rewalkEnd !== spanCleanEnd) {
          boundaryMismatch = true;
          block('retention-boundary-mismatch', 'span-avoiding cut crosses a non-eligible unit');
        } else {
          eligiblePrefixEndSeq = spanCleanEnd;
          candidateCompactionBoundarySeq = authorizeHistoricalCut(n, spanCleanEnd);
          if (candidateCompactionBoundarySeq === null) {
            block('retention-no-safe-boundary', 'no A06-authorized eligible cut exists at or before seq ' + spanCleanEnd);
          }
        }
      }
    } else {
      block('retention-no-eligible-prefix', 'no eligible contiguous prefix at or before the safe boundary');
    }
    if (eligiblePrefixEndSeq === null && boundaryMismatch === false) {
      const firstUnit = n.contextUnits[0];
      const firstClass = classById[firstUnit.unitId];
      if (firstUnit.eventSeqStart <= safePointBoundarySeq && ELIGIBLE_PREFIX_CLASSES.indexOf(firstClass) === -1) {
        if (firstUnit.requiresContinuation === true) {
          block('retention-required-state-uncovered', 'oldest required state is uncovered');
        }
      }
    }
  }

  // ---- retained suffix + projected savings (honest precision) ----
  const maxSeq = n.contextUnits[n.contextUnits.length - 1].eventSeqEnd;
  let retainedSuffixStartSeq = null;
  let projectedReclaimTokens = 0;
  let projectedRetainedTokens = 0;
  let projectionPrecision = 'unknown';
  if (candidateCompactionBoundarySeq !== null) {
    retainedSuffixStartSeq = candidateCompactionBoundarySeq + 1;
    let allExact = true;
    for (const u of n.contextUnits) {
      if (u.eventSeqEnd <= candidateCompactionBoundarySeq) {
        projectedReclaimTokens += u.tokenCost.tokens;
      } else {
        projectedRetainedTokens += u.tokenCost.tokens;
      }
      if (u.tokenCost.exact !== true) allExact = false;
    }
    projectionPrecision = allExact ? 'exact' : 'estimated';
  } else {
    let allExact = true;
    for (const u of n.contextUnits) projectedRetainedTokens += u.tokenCost.tokens;
    for (const u of n.contextUnits) {
      if (u.tokenCost.exact !== true) allExact = false;
    }
    projectionPrecision = allExact ? 'exact' : 'estimated';
    retainedSuffixStartSeq = 0;
  }
  let projectedHeadroomAfterTokens = null;
  if (pressureOk === true && projectionPrecision !== 'unknown') {
    projectedHeadroomAfterTokens = pressure.usableCapacityTokens - projectedRetainedTokens;
  }

  // ---- actionability: pressure NEVER overrides safety ----
  if (safePointOk !== true && blockers.map((b) => b.code).indexOf('retention-safe-point-required') === -1) {
    block('retention-safe-point-required', 'safe point is required');
  }
  if (snapshotValid !== true && blockers.map((b) => b.code).indexOf('retention-snapshot-required') === -1
      && blockers.map((b) => b.code).indexOf('retention-snapshot-stale') === -1) {
    block('retention-snapshot-required', 'snapshot binding is required');
  }
  if (checkpointableOk !== true && blockers.map((b) => b.code).indexOf('retention-checkpointability-required') === -1) {
    block('retention-checkpointability-required', 'checkpointability is required');
  }
  let actionable = false;
  if (safePointOk === true && snapshotValid === true && checkpointableOk === true && pressureOk === true
      && eligiblePrefixEndSeq !== null && candidateCompactionBoundarySeq !== null && boundaryMismatch === false) {
    if (projectedReclaimTokens < MINIMUM_RECLAIM_TOKENS) {
      block('retention-insufficient-reclaim', 'projected reclaim is below the minimum useful compaction');
    } else {
      actionable = true;
    }
  } else if (safePointOk === true && snapshotValid === true && checkpointableOk === true && pressureOk === true
      && eligiblePrefixEndSeq === null && boundaryMismatch === false
      && blockers.map((b) => b.code).indexOf('retention-no-eligible-prefix') === -1
      && blockers.map((b) => b.code).indexOf('retention-required-state-uncovered') === -1) {
    block('retention-no-eligible-prefix', 'no eligible contiguous prefix exists');
  }

  const pressureForPlan = pressure !== null ? pressure : n.pressureDecision;
  let pressureBasisDigest = null;
  try {
    pressureBasisDigest = pressureV2.derivePressureBasisDigest(pressureForPlan);
  } catch (error) {
    pressureBasisDigest = null;
  }
  const body = {
    schemaVersion: RETENTION_SCHEMA_VERSION,
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    generation: n.generation,
    snapshotTokenId,
    revisionDigest,
    safePointBoundarySeq,
    providerModelId: pressureForPlan && pressureForPlan.providerModelId !== undefined ? pressureForPlan.providerModelId : null,
    providerCapacityTokens: pressureForPlan && pressureForPlan.providerCapacityTokens !== undefined ? pressureForPlan.providerCapacityTokens : null,
    pressure: pressureForPlan,
    pressureBasisDigest,
    candidateCompactionBoundarySeq,
    classifications,
    eligiblePrefixEndSeq,
    retainedSuffixStartSeq,
    projectedReclaimTokens,
    projectedRetainedTokens,
    projectedHeadroomAfterTokens,
    projectionPrecision,
    actionable,
    blockers: sortBlockers(blockers),
  };
  const retentionPlanDigest = sha256HexUtf8(RETENTION_PLAN_DIGEST_DOMAIN_V1 + LF_JOIN + serializeCanonical(body));
  const retentionPlanId = 'crp_' + sha256HexUtf8(
    RETENTION_PLAN_ID_DOMAIN_V1 + LF_JOIN + n.taskId + LF_JOIN + String(n.generation) + LF_JOIN + retentionPlanDigest
  ).slice(0, 32);
  return Object.freeze(Object.assign({}, body, {
    classifications: Object.freeze(classifications.map((c) => Object.freeze(Object.assign({}, c)))),
    blockers: Object.freeze(sortBlockers(blockers).map((b) => Object.freeze(Object.assign({}, b)))),
    pressure: Object.freeze(serializeFreeze(pressureForPlan)),
    retentionPlanDigest,
    retentionPlanId,
  }));
}

function serializeFreeze(value) {
  if (Array.isArray(value)) return value.map(serializeFreeze);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = serializeFreeze(value[key]);
    return Object.freeze(out);
  }
  return value;
}

function validateRetentionPlan(plan) {
  const fail = (reason) => ({ valid: false, reason });
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return fail('retention-plan-missing');
  const unknown = unknownKeyOf(plan, RETENTION_PLAN_EXACT_KEYS);
  if (unknown !== null) return fail('retention-unknown-field');
  if (Number(plan.schemaVersion) !== RETENTION_SCHEMA_VERSION) return fail('retention-schema-mismatch');
  if (!isBoundedString(plan.taskId, RETENTION_BOUNDS.taskId, false)) return fail('retention-task-mismatch');
  if (!isBoundedString(plan.taskInstanceId, RETENTION_BOUNDS.taskInstanceId, false)) return fail('retention-instance-mismatch');
  if (!isBoundedString(plan.sessionId, RETENTION_BOUNDS.sessionId, false)) return fail('retention-session-mismatch');
  if (!Number.isInteger(plan.generation) || plan.generation < 1) return fail('retention-generation-mismatch');
  if (!Array.isArray(plan.classifications) || plan.classifications.length === 0) return fail('retention-classifications-missing');
  for (const c of plan.classifications) {
    if (!c || typeof c !== 'object') return fail('retention-classification-malformed');
    if (unknownKeyOf(c, RETENTION_CLASSIFICATION_EXACT_KEYS) !== null) return fail('retention-classification-unknown-field');
    if (RETENTION_CLASSES.indexOf(c.retentionClass) === -1) return fail('retention-class-unknown');
    if (RETENTION_REASON_CODES.indexOf(c.reasonCode) === -1) return fail('retention-reason-unknown');
    if (!Number.isInteger(c.eventSeqStart) || !Number.isInteger(c.eventSeqEnd) || c.eventSeqEnd < c.eventSeqStart) {
      return fail('retention-classification-seq-invalid');
    }
  }
  if (!Array.isArray(plan.blockers)) return fail('retention-blockers-missing');
  for (const b of plan.blockers) {
    if (!b || typeof b !== 'object') return fail('retention-blocker-malformed');
    if (unknownKeyOf(b, RETENTION_BLOCKER_EXACT_KEYS) !== null) return fail('retention-blocker-unknown-field');
    if (RETENTION_BLOCKER_CODES.indexOf(b.code) === -1) return fail('retention-blocker-unknown');
    if (typeof b.detail !== 'string' || b.detail === '' || b.detail.length > RETENTION_BOUNDS.detail) {
      return fail('retention-blocker-detail-invalid');
    }
  }
  if (typeof plan.actionable !== 'boolean') return fail('retention-actionable-mismatch');
  if (plan.actionable === true && plan.blockers.length !== 0) return fail('retention-actionable-with-blockers');
  if (plan.candidateCompactionBoundarySeq !== null
      && (!Number.isInteger(plan.candidateCompactionBoundarySeq) || plan.candidateCompactionBoundarySeq < 0)) {
    return fail('retention-boundary-invalid');
  }
  if (plan.candidateCompactionBoundarySeq !== null && plan.eligiblePrefixEndSeq !== null
      && plan.candidateCompactionBoundarySeq > plan.eligiblePrefixEndSeq) {
    return fail('retention-prefix-boundary-mismatch');
  }
  if (plan.candidateCompactionBoundarySeq !== null) {
    for (const c of plan.classifications) {
      if (c.eventSeqEnd <= plan.candidateCompactionBoundarySeq
          && ELIGIBLE_PREFIX_CLASSES.indexOf(c.retentionClass) === -1) {
        return fail('retention-prefix-boundary-mismatch');
      }
    }
    if (plan.retainedSuffixStartSeq !== plan.candidateCompactionBoundarySeq + 1) {
      return fail('retention-prefix-boundary-mismatch');
    }
  } else if (plan.retainedSuffixStartSeq !== 0) {
    return fail('retention-prefix-boundary-mismatch');
  }
  if (plan.projectionPrecision !== 'exact' && plan.projectionPrecision !== 'estimated' && plan.projectionPrecision !== 'unknown') {
    return fail('retention-precision-unknown');
  }
  const pressureCheck = pressureV2.validatePressureDecision(plan.pressure);
  if (!pressureCheck.valid) return fail('retention-pressure-invalid');
  let expectedBasis = null;
  try {
    expectedBasis = pressureV2.derivePressureBasisDigest(plan.pressure);
  } catch (error) {
    expectedBasis = null;
  }
  if (plan.pressureBasisDigest !== expectedBasis) return fail('retention-basis-mismatch');
  if (plan.actionable === true && plan.pressureBasisDigest === null) return fail('retention-basis-mismatch');
  const body = {};
  for (const key of RETENTION_PLAN_EXACT_KEYS) {
    if (key === 'retentionPlanDigest' || key === 'retentionPlanId') continue;
    body[key] = plan[key];
  }
  const expectedDigest = sha256HexUtf8(RETENTION_PLAN_DIGEST_DOMAIN_V1 + LF_JOIN + serializeCanonical(body));
  if (plan.retentionPlanDigest !== expectedDigest) return fail('retention-digest-mismatch');
  const expectedId = 'crp_' + sha256HexUtf8(
    RETENTION_PLAN_ID_DOMAIN_V1 + LF_JOIN + plan.taskId + LF_JOIN + String(plan.generation) + LF_JOIN + expectedDigest
  ).slice(0, 32);
  if (plan.retentionPlanId !== expectedId) return fail('retention-id-mismatch');
  return { valid: true, reason: null };
}

// Deterministic stale-plan validation. Any drift in snapshot identity,
// boundary, generation, or provider capability BLOCKS the old plan.
function assertRetentionPlanFresh(plan, current) {
  const block = (reason) => ({ ok: false, reason });
  const check = validateRetentionPlan(plan);
  if (!check.valid) return block(check.reason);
  if (!current || typeof current !== 'object') return block('retention-plan-stale');
  if (current.snapshotTokenId !== plan.snapshotTokenId) return block('retention-plan-stale');
  if (current.revisionDigest !== plan.revisionDigest) return block('retention-plan-stale');
  if (current.safePointBoundarySeq !== plan.safePointBoundarySeq) return block('retention-plan-stale');
  if (current.generation !== plan.generation) return block('retention-plan-stale');
  if (current.providerModelId !== undefined && current.providerModelId !== plan.providerModelId) {
    return block('retention-plan-stale');
  }
  if (current.providerCapacityTokens !== undefined && current.providerCapacityTokens !== plan.providerCapacityTokens) {
    return block('retention-plan-stale');
  }
  if (current.pressureBasisDigest !== plan.pressureBasisDigest) {
    return block('retention-plan-stale');
  }
  return { ok: true, reason: null };
}

// Bounded shadow-ready telemetry: counts/ids/levels only, never raw text.
function retentionTelemetry(plan) {
  const check = validateRetentionPlan(plan);
  if (!check.valid) failRetention('cannot telemeter invalid plan (' + check.reason + ')');
  return Object.freeze({
    schemaVersion: 1,
    pressureLevel: plan.pressure.level,
    currentContextTokens: plan.pressure.currentContextTokens,
    usableCapacityTokens: plan.pressure.usableCapacityTokens,
    headroomTokens: plan.pressure.remainingHeadroomTokens,
    candidateBoundarySeq: plan.candidateCompactionBoundarySeq,
    eligiblePrefixEventCount: plan.eligiblePrefixEndSeq === null ? 0 : plan.eligiblePrefixEndSeq + 1,
    retainedSuffixEventCount: plan.retainedSuffixStartSeq === null ? 0 : 0 + countSuffix(plan),
    projectedReclaimTokens: plan.projectedReclaimTokens,
    projectedContextTokensAfter: plan.projectedRetainedTokens,
    projectedHeadroomAfter: plan.projectedHeadroomAfterTokens,
    actionable: plan.actionable,
    blockerCodes: Object.freeze(plan.blockers.map((b) => b.code).slice().sort()),
    retentionPlanId: plan.retentionPlanId,
    pressureBasisDigest: plan.pressureBasisDigest,
  });
}

function countSuffix(plan) {
  let maxEnd = -1;
  for (const c of plan.classifications) {
    if (c.eventSeqEnd > maxEnd) maxEnd = c.eventSeqEnd;
  }
  if (plan.retainedSuffixStartSeq === null || maxEnd < 0) return 0;
  return maxEnd - plan.retainedSuffixStartSeq + 1;
}

module.exports = {
  RETENTION_SCHEMA_VERSION,
  RETENTION_PLAN_DIGEST_DOMAIN_V1,
  RETENTION_PLAN_ID_DOMAIN_V1,
  RETENTION_HYSTERESIS_POLICY_ID_V1,
  MINIMUM_RECLAIM_TOKENS,
  RETENTION_CLASSES,
  ELIGIBLE_PREFIX_CLASSES,
  RETENTION_REASON_CODES,
  RETENTION_BLOCKER_CODES,
  RETENTION_UNIT_EXACT_KEYS,
  RETENTION_BOUNDS,
  sha256HexUtf8,
  canonicalize,
  serializeCanonical,
  classifyUnit,
  normalizePlanInput,
  planRetentionV2,
  validateRetentionPlan,
  assertRetentionPlanFresh,
  retentionTelemetry,
};
