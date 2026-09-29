'use strict';
/**
 * ContextCompilerShadowV2.cjs - CCV2-C07 Compiler Shadow Mode pure authority.
 *
 * ONE authority for the deterministic LOGICAL shadow comparison between the
 * current authoritative production prompt baseline and a disposable
 * C01->C06 candidate ContextView. C07 answers "how does the candidate
 * differ from the live baseline, and is mandatory truth preserved" and
 * NOTHING else:
 *
 *   existing Nexus/DSH projection (authority, untouched)
 *     vs
 *   C01->C06 candidate ContextView + ContextPromptLayout (disposable)
 *     -> sanitized shadow report (observability, never truth)
 *
 * Frozen posture (consumed verbatim, never reinterpreted):
 *   C07 = observe only. C08 = authority/production enablement.
 *   The candidate MUST NEVER affect the model request. There is no
 *   renderer here: C06 is a logical layout plan, so C07 performs a
 *   LOGICAL shadow comparison (source identity, membership, exact
 *   materialized bytes where available, representation identity,
 *   mandatory coverage, token accounting, logical ordering) -- never a
 *   physical prompt-parity claim.
 *
 * Host ownership (frozen C06 rule): DSH/host owns the system/controller
 * contract bytes. CCv2 owns the disposable suffix projection. C07 never
 * compares the entire provider prompt against the ContextView. The actual
 * side carries a TYPED hostOwned flag per member (set by the caller from
 * typed ownership/provenance boundaries, never by text matching); such
 * members are classified HOST_EXTERNAL and excluded from comparison.
 *
 * Failure semantics: every export is deterministic and read-only, but the
 * comparison layer fails CLOSED internally (invalid inputs throw, invalid
 * candidates are rejected, never salvaged). The OUTER fail-open shell
 * lives in config/ContextCompilerShadowAdapterV2.cjs, which catches any
 * shadow failure and lets the existing prompt proceed unchanged. C01-C06
 * fail-closed invariants are never weakened here.
 *
 * Determinism: no clocks, no randomness, no PIDs, no filesystem reads.
 * Identical inputs -> byte-identical reports and digests across repeat
 * runs, parallel processes, fresh processes, and restarts.
 *
 * Security: typed metadata only. Evidence prose (exactText, user prompt,
 * system prompt, tool results, secrets) is never read, never branched
 * on, and never copied into any report. Reports carry IDs, hashes,
 * counts, tiers, zones, reason codes, representation kinds, token
 * counts, boolean coverage results, and durations supplied by the
 * caller -- safe for normal diagnostic display.
 *
 * Explicitly NOT implemented here (C08 scope, Phase D scope): prompt
 * rendering, provider payload mutation, routing changes, cache-control
 * insertion, compiled/legacy fallback, embeddings, reranking, DECIDE,
 * JEV/Laya, learned scoring, LLM comparison, probabilities, automatic
 * promotion (no counter, no threshold, no auto-enable path exists).
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (section 38, C07 freeze record).
 */

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const viewV2 = require('./ContextViewV2.cjs');
const compilerV2 = require('./ContextCompilerV2.cjs');
const retrieverV2 = require('./ContextRetrieverV2.cjs');
const allocatorV2 = require('./ContextBudgetAllocatorV2.cjs');
const compressionV2 = require('./ContextCompressionLadderV2.cjs');
const layoutV2 = require('./ContextPromptLayoutV2.cjs');
const counterV2 = require('./ContextTokenCounterV2.cjs');

const SHADOW_SCHEMA_VERSION = 1;
const SHADOW_POLICY_REVISION_V2 = 'context-compiler-shadow-v1';
const SHADOW_DIGEST_DOMAIN_V1 = 'nexus/context-compiler-shadow/v1';
const LF_JOIN = String.fromCharCode(10);

// Single authoritative enablement setting (conceptually
// contextCompiler.shadowMode). Closed world: off | observe. There is
// deliberately NO active/production mode: that belongs to C08.
const SHADOW_MODES = Object.freeze(['off', 'observe']);
const SHADOW_MODE_ENV_VAR = 'NEXUS_CCV2_SHADOW_MODE';

// Closed-world shadow statuses.
const SHADOW_STATUSES = Object.freeze([
  'MATCHED',
  'DIVERGED',
  'STATE_CHANGED',
  'CANDIDATE_FAILED',
  'UNCOMPARABLE',
]);

// Closed-world discrepancy vocabulary (frozen semantics).
const DISCREPANCY_CODES = Object.freeze([
  'MATCHED_EXACT',
  'MATCHED_SOURCE',
  'ACTUAL_ONLY_OPTIONAL',
  'CANDIDATE_ONLY_OPTIONAL',
  'CANDIDATE_REFERENCE',
  'CANDIDATE_COMPRESSED',
  'MANDATORY_MISSING',
  'CURRENT_TURN_MISSING',
  'TOOL_PROTOCOL_MISSING',
  'VERIFICATION_TRUTH_MISSING',
  'SOURCE_HASH_MISMATCH',
  'REPRESENTATION_HASH_MISMATCH',
  'HOST_EXTERNAL',
  'UNCOMPARABLE',
  'STATE_CHANGED',
  'CANDIDATE_FAILED',
]);

// Closed-world severity taxonomy.
const DISCREPANCY_SEVERITIES = Object.freeze([
  'CRITICAL',
  'INFORMATIONAL',
  'EXPECTED_TRANSFORMATION',
  'UNCOMPARABLE',
]);

const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const ID256_PATTERN = /^.{1,256}$/;
const SHADOW_ACTUAL_MEMBERS_MAX = 16384;

const ACTUAL_TOP_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'namespace', 'checkpointBinding', 'turnRef', 'members',
  'currentTurn', 'toolTransactions', 'verification', 'comparableTokens',
  'tokenizerFingerprint',
]);
const ACTUAL_NAMESPACE_EXACT_KEYS = Object.freeze(['taskId', 'taskInstanceId', 'sessionId']);
const ACTUAL_BINDING_EXACT_KEYS = Object.freeze(['checkpointGeneration', 'checkpointId', 'snapshotRevision']);
const ACTUAL_TURN_REF_EXACT_KEYS = Object.freeze(['turnId', 'revision']);
const ACTUAL_MEMBER_EXACT_KEYS = Object.freeze([
  'sourceId', 'shownHash', 'sourceHash', 'kind', 'tier', 'section',
  'mandatory', 'hostOwned', 'reference', 'tokens',
]);
const ACTUAL_CURRENT_TURN_EXACT_KEYS = Object.freeze(['turnId', 'textHash', 'revision']);
const ACTUAL_TOOL_TX_EXACT_KEYS = Object.freeze(['callId', 'balanced']);
const ACTUAL_VERIFICATION_EXACT_KEYS = Object.freeze(['digest', 'revision']);

const REPORT_TOP_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'shadowPolicyRevision', 'namespace', 'requestBinding',
  'checkpointBinding', 'actualObservation', 'candidateObservation',
  'comparisonSummary', 'discrepancies', 'promotionBlocker',
  'promotionBlockerReasons', 'comparable', 'comparisonDigest', 'disposable',
]);
const REPORT_NAMESPACE_EXACT_KEYS = ACTUAL_NAMESPACE_EXACT_KEYS;
const REPORT_REQUEST_BINDING_EXACT_KEYS = Object.freeze([
  'taskId', 'taskInstanceId', 'sessionId', 'checkpointGeneration',
  'checkpointId', 'captureSnapshotRevision', 'completeSnapshotRevision',
]);
const REPORT_CHECKPOINT_BINDING_EXACT_KEYS = ACTUAL_BINDING_EXACT_KEYS;
const REPORT_ACTUAL_OBS_EXACT_KEYS = Object.freeze([
  'memberCount', 'comparableMemberCount', 'hostExternalCount',
  'actualComparableTokens', 'tokenizerAvailable', 'currentTurnBound',
  'verificationBound', 'toolTransactionCount',
]);
const REPORT_CANDIDATE_OBS_EXACT_KEYS = Object.freeze([
  'viewId', 'viewDigest', 'layoutDigest', 'stablePrefixDigest',
  'memberCount', 'referencedColdCount', 'candidateMaterializedTokens',
  'mandatoryTokens', 'hotTokens', 'warmTokens', 'coldMaterializedTokens',
  'referencedOnlyColdCount', 'stablePrefixBoundary', 'zoneCounts',
]);
const REPORT_SUMMARY_EXACT_KEYS = Object.freeze([
  'status', 'matchedExactCount', 'matchedSourceCount',
  'expectedTransformationCount', 'actualOnlyOptionalCount',
  'actualOnlyOptionalTokens', 'candidateOnlyCount', 'criticalCount',
  'informationalCount', 'hostExternalCount', 'logicalReduction',
  'comparableTokensAvailable', 'mandatoryCoverage', 'currentTurnCoverage',
  'toolProtocolCoverage', 'verificationCoverage',
]);
const REPORT_DISCREPANCY_EXACT_KEYS = Object.freeze([
  'sourceId', 'code', 'severity', 'mandatory', 'detail',
]);

function failShadow(code, detail) {
  throw new Error('context-compiler-shadow-' + code + (detail === undefined ? '' : ': ' + detail) + ' (DISCARDABLE)');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownKeyOf(value, allowedKeys) {
  if (!isPlainObject(value)) return '(non-object)';
  for (const key of Object.keys(value)) {
    if (allowedKeys.indexOf(key) === -1) return key;
  }
  return null;
}

function sha256HexUtf8(text) {
  return checkpointV2.sha256HexUtf8(String(text));
}

function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isBoundedId(value) {
  return typeof value === 'string' && value !== '' && value.length <= 256;
}

function isHex64(value) {
  return typeof value === 'string' && HEX64_PATTERN.test(value);
}

// ---- enablement control (single authoritative setting) ----

/**
 * Resolve the C07 shadow mode from one authoritative setting:
 * an explicit mode, else config.contextCompiler.shadowMode, else the
 * NEXUS_CCV2_SHADOW_MODE environment binding, else 'off'. Closed world:
 * only 'off' and 'observe' are honored; anything else resolves to 'off'
 * with valid:false (never throws, never enables). There is no
 * active/production mode in C07.
 */
function resolveCompilerShadowModeV2(input) {
  const source = isPlainObject(input) ? input : {};
  let raw = source.mode;
  let origin = 'explicit';
  if (raw === undefined || raw === null) {
    const cfg = source.config;
    if (isPlainObject(cfg) && isPlainObject(cfg.contextCompiler)
      && cfg.contextCompiler.shadowMode !== undefined
      && cfg.contextCompiler.shadowMode !== null) {
      raw = cfg.contextCompiler.shadowMode;
      origin = 'config';
    } else {
      const env = isPlainObject(source.env) ? source.env : null;
      const envValue = env !== null && env[SHADOW_MODE_ENV_VAR] !== undefined
        ? env[SHADOW_MODE_ENV_VAR]
        : (typeof process !== 'undefined' && process.env ? process.env[SHADOW_MODE_ENV_VAR] : undefined);
      if (envValue !== undefined && envValue !== null && String(envValue) !== '') {
        raw = String(envValue);
        origin = 'env';
      } else {
        raw = 'off';
        origin = 'default';
      }
    }
  }
  const mode = String(raw);
  if (SHADOW_MODES.indexOf(mode) === -1) {
    return Object.freeze({ mode: 'off', valid: false, origin, reason: 'context-compiler-shadow-mode-unknown' });
  }
  return Object.freeze({ mode, valid: true, origin, reason: null });
}

// ---- actual-side observation (typed live projection metadata only) ----

function checkActualNamespace(ns) {
  if (!isPlainObject(ns)) return 'actual-namespace-invalid';
  if (unknownKeyOf(ns, ACTUAL_NAMESPACE_EXACT_KEYS) !== null) return 'actual-namespace-invalid';
  for (const key of ACTUAL_NAMESPACE_EXACT_KEYS) {
    if (!isBoundedId(ns[key])) return 'actual-namespace-invalid';
  }
  return null;
}

function checkActualBinding(binding) {
  if (!isPlainObject(binding)) return 'actual-binding-invalid';
  if (unknownKeyOf(binding, ACTUAL_BINDING_EXACT_KEYS) !== null) return 'actual-binding-invalid';
  if (!Number.isInteger(binding.checkpointGeneration) || binding.checkpointGeneration < 0) return 'actual-binding-invalid';
  if (typeof binding.checkpointId !== 'string' || binding.checkpointId === '') return 'actual-binding-invalid';
  if (typeof binding.snapshotRevision !== 'string' || binding.snapshotRevision === '') return 'actual-binding-invalid';
  return null;
}

function checkActualMember(member, index) {
  if (!isPlainObject(member)) return 'actual-member-invalid';
  const unknown = unknownKeyOf(member, ACTUAL_MEMBER_EXACT_KEYS);
  if (unknown !== null) return 'actual-member-invalid';
  if (!isBoundedId(member.sourceId)) return 'actual-member-invalid';
  if (!isHex64(member.shownHash)) return 'actual-member-invalid';
  if (member.sourceHash !== null && member.sourceHash !== undefined && !isHex64(member.sourceHash)) {
    return 'actual-member-invalid';
  }
  if (member.kind !== null && member.kind !== undefined
    && viewV2.REPRESENTATION_KINDS.indexOf(member.kind) === -1) {
    return 'actual-member-invalid';
  }
  if (member.tier !== null && member.tier !== undefined
    && viewV2.MATERIAL_TIERS.indexOf(member.tier) === -1
    && member.tier !== 'PINNED') {
    return 'actual-member-invalid';
  }
  if (member.section !== null && member.section !== undefined && typeof member.section !== 'string') {
    return 'actual-member-invalid';
  }
  if (typeof member.mandatory !== 'boolean') return 'actual-member-invalid';
  if (typeof member.hostOwned !== 'boolean') return 'actual-member-invalid';
  if (typeof member.reference !== 'boolean') return 'actual-member-invalid';
  if (member.tokens !== null && member.tokens !== undefined
    && (!Number.isInteger(member.tokens) || member.tokens < 0)) {
    return 'actual-member-invalid';
  }
  return null;
}

/**
 * Validate + normalize the caller-supplied actual-side observation. The
 * descriptor is built by the host adapter from TYPED live projection
 * structure (ownership, provenance, source identity, digests); arbitrary
 * prompt prose is never parsed. Carries hashes/IDs/counts only.
 */
function observeActualV2(rawActual) {
  if (!isPlainObject(rawActual)) failShadow('actual-invalid', 'actual observation must be an object');
  const unknown = unknownKeyOf(rawActual, ACTUAL_TOP_EXACT_KEYS);
  if (unknown !== null) failShadow('actual-invalid', 'actual carries unknown key ' + String(unknown).slice(0, 64));
  if (rawActual.schemaVersion !== SHADOW_SCHEMA_VERSION) failShadow('actual-invalid', 'actual schemaVersion must be 1');
  const nsProblem = checkActualNamespace(rawActual.namespace);
  if (nsProblem !== null) failShadow('actual-invalid', nsProblem);
  const bindingProblem = checkActualBinding(rawActual.checkpointBinding);
  if (bindingProblem !== null) failShadow('actual-invalid', bindingProblem);
  if (rawActual.turnRef !== null && rawActual.turnRef !== undefined) {
    if (!isPlainObject(rawActual.turnRef)
      || unknownKeyOf(rawActual.turnRef, ACTUAL_TURN_REF_EXACT_KEYS) !== null
      || !isBoundedId(rawActual.turnRef.turnId)) {
      failShadow('actual-invalid', 'actual turnRef invalid');
    }
  }
  if (!Array.isArray(rawActual.members)) failShadow('actual-invalid', 'actual members must be an array');
  // CCV2-R1 (supersedes 2048): one member per live message plus the host
  // system contract; bounded to the R1 plan-source ceiling so a session C08
  // can compile is never silently unobservable.
  if (rawActual.members.length > SHADOW_ACTUAL_MEMBERS_MAX) failShadow('actual-invalid', 'actual members exceed the observation bound');
  const seen = new Set();
  rawActual.members.forEach((member, index) => {
    const problem = checkActualMember(member, index);
    if (problem !== null) failShadow('actual-invalid', problem + ' at index ' + index);
    if (seen.has(member.sourceId)) failShadow('actual-invalid', 'duplicate actual sourceId');
    seen.add(member.sourceId);
  });
  if (rawActual.currentTurn !== null && rawActual.currentTurn !== undefined) {
    const turn = rawActual.currentTurn;
    if (!isPlainObject(turn) || unknownKeyOf(turn, ACTUAL_CURRENT_TURN_EXACT_KEYS) !== null
      || !isBoundedId(turn.turnId) || !isHex64(turn.textHash)) {
      failShadow('actual-invalid', 'actual currentTurn invalid');
    }
  }
  if (rawActual.toolTransactions !== null && rawActual.toolTransactions !== undefined) {
    if (!Array.isArray(rawActual.toolTransactions)) failShadow('actual-invalid', 'actual toolTransactions must be an array');
    rawActual.toolTransactions.forEach((tx) => {
      if (!isPlainObject(tx) || unknownKeyOf(tx, ACTUAL_TOOL_TX_EXACT_KEYS) !== null
        || !isBoundedId(tx.callId) || typeof tx.balanced !== 'boolean') {
        failShadow('actual-invalid', 'actual tool transaction invalid');
      }
    });
  }
  if (rawActual.verification !== null && rawActual.verification !== undefined) {
    const verification = rawActual.verification;
    if (!isPlainObject(verification)
      || unknownKeyOf(verification, ACTUAL_VERIFICATION_EXACT_KEYS) !== null
      || !isHex64(verification.digest)) {
      failShadow('actual-invalid', 'actual verification invalid');
    }
  }
  if (rawActual.comparableTokens !== null && rawActual.comparableTokens !== undefined
    && (!Number.isInteger(rawActual.comparableTokens) || rawActual.comparableTokens < 0)) {
    failShadow('actual-invalid', 'actual comparableTokens invalid');
  }
  if (rawActual.tokenizerFingerprint !== null && rawActual.tokenizerFingerprint !== undefined
    && (typeof rawActual.tokenizerFingerprint !== 'string' || rawActual.tokenizerFingerprint === '')) {
    failShadow('actual-invalid', 'actual tokenizerFingerprint invalid');
  }
  return Object.freeze(checkpointV2.canonicalize(deepClone(rawActual)));
}

// ---- candidate pipeline (real frozen C01->C06 authorities, no fork) ----

/**
 * Build the shadow candidate through the REAL frozen stack:
 *   C02 compileContextV2 -> C05 compressContextViewV2 (which re-runs the
 *   SAME C04 packing policy; no second packer exists here) -> C04
 *   read-only usage/metrics observation -> C06 planContextPromptLayoutV2
 * Optional C03 retrieval runs observationally (digest only) when a
 * retrieval request is supplied; C02 inputs already carry exact
 * material, so retrieval never rewires compilation. Any failure throws
 * (fail closed internally); the adapter converts it to a
 * shadow-state CANDIDATE_FAILED outcome without touching the request.
 */
function buildCandidateV2(input) {
  if (!isPlainObject(input)) failShadow('candidate-input-invalid', 'candidate input must be an object');
  const unknown = unknownKeyOf(input,
    ['compileInput', 'pages', 'budget', 'counter', 'retrievalRequest',
     'compressionPolicyRevision', 'packingPolicyRevision', 'layoutPolicyRevision']);
  if (unknown !== null) failShadow('candidate-input-invalid', 'candidate input carries unknown key ' + String(unknown).slice(0, 64));
  if (!isPlainObject(input.compileInput)) failShadow('candidate-input-invalid', 'compileInput is required');
  if (!Array.isArray(input.pages)) failShadow('candidate-input-invalid', 'pages must be an explicit array');
  if (!isPlainObject(input.budget)) failShadow('candidate-input-invalid', 'budget is required');
  const counterCheck = counterV2.validateContextTokenCounterV2(input.counter);
  if (!counterCheck.valid) failShadow('candidate-input-invalid', 'no valid token-counting authority');

  let compiled = null;
  try {
    compiled = compilerV2.compileContextV2(input.compileInput);
  } catch (error) {
    failShadow('candidate-compile-failed', String((error && error.message) || error).slice(0, 200));
  }
  const viewCheck = viewV2.validateContextViewV2(compiled.view);
  if (!viewCheck.valid) failShadow('candidate-compile-failed', 'C02 output rejected by the C01 gate');

  let retrievalDigest = null;
  if (input.retrievalRequest !== null && input.retrievalRequest !== undefined) {
    let retrieved = null;
    try {
      retrieved = retrieverV2.retrieveContextEvidenceV2(input.retrievalRequest);
    } catch (error) {
      failShadow('candidate-retrieval-failed', String((error && error.message) || error).slice(0, 200));
    }
    const retrievalCheck = retrieverV2.validateRetrievalResultV2(retrieved);
    if (!retrievalCheck.valid) failShadow('candidate-retrieval-failed', 'C03 result failed validation');
    retrievalDigest = retrieved.resultDigest;
  }

  let compressed = null;
  try {
    compressed = compressionV2.compressContextViewV2({
      view: compiled.view,
      pages: input.pages,
      budget: input.budget,
      counter: input.counter,
      compressionPolicyRevision: input.compressionPolicyRevision,
    });
  } catch (error) {
    failShadow('candidate-compress-failed', String((error && error.message) || error).slice(0, 200));
  }
  const finalView = compressed.compressedView;
  const finalCheck = viewV2.validateContextViewV2(finalView);
  if (!finalCheck.valid) failShadow('candidate-compress-failed', 'C05 output rejected by the C01 gate');

  // C04 read-only metrics observation over the final view (no repacking,
  // no membership change): usage totals plus the disposable packing plan
  // that proves the final membership fits the same budget authority.
  let usage = null;
  let packingDescription = null;
  try {
    usage = allocatorV2.calculateContextTokenUsageV2({ view: finalView, counter: input.counter });
    const packingPlan = allocatorV2.buildContextPackingPlanV2({
      view: finalView,
      budget: input.budget,
      counter: input.counter,
      packingPolicyRevision: input.packingPolicyRevision,
    });
    packingDescription = allocatorV2.describeContextPackingPlanV2(packingPlan.plan);
  } catch (error) {
    failShadow('candidate-pack-failed', String((error && error.message) || error).slice(0, 200));
  }

  let planned = null;
  try {
    planned = layoutV2.planContextPromptLayoutV2({
      view: finalView,
      layoutPolicyRevision: input.layoutPolicyRevision,
    });
  } catch (error) {
    failShadow('candidate-layout-failed', String((error && error.message) || error).slice(0, 200));
  }

  const candidateObservation = observeCandidateV2({
    view: finalView,
    layout: planned.layout,
    tokenizerFingerprint: counterCheck.fingerprint,
    tokenMetrics: {
      mandatoryTokens: usage.mandatoryUsed,
      hotTokens: packingDescription.hotTokens,
      warmTokens: packingDescription.warmTokens,
      coldMaterializedTokens: packingDescription.coldMaterializedTokens,
      referencedOnlyColdCount: packingDescription.referencedCount,
    },
  });

  return Object.freeze({
    view: finalView,
    layout: planned.layout,
    compressionPlanDigest: compressed.compressionPlan.planDigest,
    packingPlanDigest: packingDescription.planDigestPrefix,
    retrievalDigest,
    candidateObservation,
  });
}

// ---- candidate-side observation (bound to frozen view/layout identity) ----

function candidateMemberOf(entry, section) {
  const representation = entry.representation === undefined || entry.representation === null
    ? null : entry.representation;
  const kind = representation !== null ? representation.kind : 'EXACT';
  const sourceHash = representation !== null ? representation.sourceContentHash : entry.contentHash;
  let toolCallId = null;
  let toolBalanced = null;
  if (entry.toolTransaction !== null && entry.toolTransaction !== undefined) {
    toolCallId = entry.toolTransaction.callId;
    toolBalanced = entry.toolTransaction.callPresent === true && entry.toolTransaction.resultPresent === true;
  }
  return {
    sourceId: entry.sourceId,
    memberId: entry.id,
    shownHash: entry.contentHash,
    sourceHash,
    kind,
    tier: entry.tier,
    section,
    mandatory: entry.mandatory === true,
    toolCallId,
    toolBalanced,
  };
}

/**
 * Derive the candidate observation from a validated final ContextView
 * and its validated ContextPromptLayout. Binds viewId, viewDigest,
 * layoutDigest, stablePrefixDigest, checkpoint binding, namespace,
 * budget, member identities, and representation identities. Full
 * exactText is never copied: only content hashes travel.
 */
function observeCandidateV2(input) {
  if (!isPlainObject(input)) failShadow('candidate-invalid', 'candidate observation input must be an object');
  if (unknownKeyOf(input, ['view', 'layout', 'tokenizerFingerprint', 'tokenMetrics']) !== null) {
    failShadow('candidate-invalid', 'candidate observation input carries unknown keys');
  }
  const viewCheck = viewV2.validateContextViewV2(input.view);
  if (!viewCheck.valid) failShadow('candidate-invalid', 'candidate view failed the C01 gate');
  const layoutCheck = layoutV2.validateContextPromptLayoutV2({ layout: input.layout, view: input.view });
  if (!layoutCheck.valid) failShadow('candidate-invalid', 'candidate layout failed the C06 gate: ' + String(layoutCheck.reason || 'invalid').slice(0, 120));
  if (input.layout.sourceViewId !== input.view.id
    || input.layout.sourceViewDigest !== input.view.viewDigest) {
    failShadow('candidate-invalid', 'layout does not bind the candidate view');
  }
  if (typeof input.tokenizerFingerprint !== 'string' || input.tokenizerFingerprint === '') {
    failShadow('candidate-invalid', 'tokenizer fingerprint is required');
  }
  const metrics = input.tokenMetrics;
  if (!isPlainObject(metrics)) failShadow('candidate-invalid', 'token metrics are required');
  for (const key of ['mandatoryTokens', 'hotTokens', 'warmTokens', 'coldMaterializedTokens', 'referencedOnlyColdCount']) {
    if (!Number.isInteger(metrics[key]) || metrics[key] < 0) failShadow('candidate-invalid', 'token metric ' + key + ' invalid');
  }

  const members = [];
  const seenSources = new Set();
  for (const section of viewV2.VIEW_SECTIONS) {
    for (const entry of input.view[section]) {
      if (seenSources.has(entry.sourceId)) failShadow('candidate-invalid', 'duplicate candidate sourceId');
      seenSources.add(entry.sourceId);
      members.push(candidateMemberOf(entry, section));
    }
  }
  const references = input.view.referencedColdPages.map((ref) => ({
    pageId: ref.pageId, contentHash: ref.contentHash,
  }));

  const currentTurnEntries = members.filter((m) => {
    const entry = findViewEntry(input.view, m.memberId);
    return entry !== null && entry.sourceType === 'current-turn';
  });
  const currentTurn = currentTurnEntries.length === 0 ? null : {
    count: currentTurnEntries.length,
    textHash: currentTurnEntries[0].shownHash,
    turnId: input.view.turnRef !== null && input.view.turnRef !== undefined ? input.view.turnRef.turnId : null,
  };

  const toolGroups = new Map();
  for (const member of members) {
    if (member.toolCallId === null) continue;
    let group = toolGroups.get(member.toolCallId);
    if (group === undefined) {
      group = { callId: member.toolCallId, balanced: true, memberCount: 0 };
      toolGroups.set(member.toolCallId, group);
    }
    group.memberCount += 1;
    if (member.toolBalanced !== true) group.balanced = false;
  }
  const toolTransactions = Array.from(toolGroups.values()).map((group) => ({
    callId: group.callId, balanced: group.balanced,
  }));

  let verification = null;
  for (const section of viewV2.VIEW_SECTIONS) {
    for (const entry of input.view[section]) {
      const decision = entry.tierDecision;
      if (isPlainObject(decision) && decision.subjectKind === 'verification-state') {
        verification = { digest: entry.contentHash, section };
        break;
      }
    }
    if (verification !== null) break;
  }

  return Object.freeze({
    schemaVersion: SHADOW_SCHEMA_VERSION,
    viewId: input.view.id,
    viewDigest: input.view.viewDigest,
    layoutDigest: input.layout.layoutDigest,
    stablePrefixDigest: input.layout.stablePrefixDigest,
    namespace: {
      taskId: input.view.namespace.taskId,
      taskInstanceId: input.view.namespace.taskInstanceId,
      sessionId: input.view.namespace.sessionId,
    },
    checkpointBinding: {
      checkpointGeneration: input.view.checkpointBinding.checkpointGeneration,
      checkpointId: input.view.checkpointBinding.checkpointId,
    },
    snapshotRevision: input.view.checkpointBinding.snapshotRevision,
    turnRef: input.view.turnRef === null || input.view.turnRef === undefined
      ? null : { turnId: input.view.turnRef.turnId, revision: input.view.turnRef.revision },
    budget: {
      hardMax: input.view.tokenBudget.hardMax,
      target: input.view.tokenBudget.target,
      used: input.view.tokenBudget.used,
    },
    tokenizerFingerprint: input.tokenizerFingerprint,
    members,
    references,
    mandatoryRefs: input.view.mandatoryRefs.map((ref) => ({
      sourceId: ref.sourceId, kind: ref.kind, contentHash: ref.contentHash,
    })),
    currentTurn,
    toolTransactions,
    verification,
    tokenMetrics: {
      mandatoryTokens: metrics.mandatoryTokens,
      hotTokens: metrics.hotTokens,
      warmTokens: metrics.warmTokens,
      coldMaterializedTokens: metrics.coldMaterializedTokens,
      referencedOnlyColdCount: metrics.referencedOnlyColdCount,
      candidateMaterializedTokens: input.view.tokenBudget.used,
    },
    stablePrefixBoundary: input.layout.stablePrefixBoundary,
    zoneCounts: deepClone(input.layout.zoneCounts),
  });
}

function findViewEntry(view, memberId) {
  for (const section of viewV2.VIEW_SECTIONS) {
    for (const entry of view[section]) {
      if (entry.id === memberId) return entry;
    }
  }
  return null;
}

// ---- logical shadow comparison ----

function tripleEqual(a, b) {
  return a.taskId === b.taskId && a.taskInstanceId === b.taskInstanceId && a.sessionId === b.sessionId;
}

function sortDiscrepancies(list) {
  return list.slice().sort((a, b) => {
    if (a.sourceId < b.sourceId) return -1;
    if (a.sourceId > b.sourceId) return 1;
    if (a.code < b.code) return -1;
    if (a.code > b.code) return 1;
    return 0;
  });
}

function pushDiscrepancy(list, sourceId, code, severity, mandatory, detail) {
  list.push({
    sourceId: String(sourceId),
    code,
    severity,
    mandatory: mandatory === true,
    detail: String(detail).slice(0, 256),
  });
}

/**
 * Compare a validated actual observation against a validated candidate
 * observation. Pure logical comparison over source identity, membership,
 * exact materialized bytes (hash equality computed locally, byte-exact,
 * no normalization), representation identity, mandatory coverage, tool
 * and current-turn coverage, COLD reference identity, token accounting,
 * and logical ordering. captureRevision/completeRevision bind the
 * state-consistency rule: any movement discards the comparison with
 * STATE_CHANGED.
 */
function compareShadowV2(input) {
  if (!isPlainObject(input)) failShadow('comparison-invalid', 'comparison input must be an object');
  if (unknownKeyOf(input, ['actual', 'candidate', 'captureSnapshotRevision', 'completeSnapshotRevision']) !== null) {
    failShadow('comparison-invalid', 'comparison input carries unknown keys');
  }
  const actual = observeActualV2(input.actual);
  if (typeof input.captureSnapshotRevision !== 'string' || input.captureSnapshotRevision === '') {
    failShadow('comparison-invalid', 'captureSnapshotRevision is required');
  }
  const completeRevision = input.completeSnapshotRevision === undefined || input.completeSnapshotRevision === null
    ? input.captureSnapshotRevision : input.completeSnapshotRevision;
  if (typeof completeRevision !== 'string' || completeRevision === '') {
    failShadow('comparison-invalid', 'completeSnapshotRevision is invalid');
  }
  const cand = isPlainObject(input.candidate) ? input.candidate : null;
  const candidateShapeValid = cand !== null
    && cand.schemaVersion === SHADOW_SCHEMA_VERSION
    && typeof cand.viewId === 'string' && typeof cand.viewDigest === 'string'
    && typeof cand.layoutDigest === 'string' && typeof cand.stablePrefixDigest === 'string'
    && isPlainObject(cand.namespace) && isPlainObject(cand.checkpointBinding)
    && Array.isArray(cand.members) && Array.isArray(cand.references)
    && Array.isArray(cand.mandatoryRefs) && Array.isArray(cand.toolTransactions)
    && isPlainObject(cand.tokenMetrics);
  if (!candidateShapeValid) failShadow('comparison-invalid', 'candidate observation is required');
  const candidate = cand;

  const discrepancies = [];

  // Namespace isolation: cross-task observations never compare.
  if (!tripleEqual(actual.namespace, candidate.namespace)) {
    pushDiscrepancy(discrepancies, '(binding)', 'UNCOMPARABLE', 'UNCOMPARABLE', false, 'namespace-mismatch');
    return finishComparison(actual, candidate, input.captureSnapshotRevision, completeRevision,
      discrepancies, 'UNCOMPARABLE', false, true);
  }

  // State-consistency rule: stale candidates never compare.
  if (completeRevision !== input.captureSnapshotRevision) {
    pushDiscrepancy(discrepancies, '(binding)', 'STATE_CHANGED', 'UNCOMPARABLE', false, 'shadow-snapshot-stale');
    return finishComparison(actual, candidate, input.captureSnapshotRevision, completeRevision,
      discrepancies, 'STATE_CHANGED', false, true);
  }

  // Checkpoint binding agreement (generation + id, revision already bound).
  if (actual.checkpointBinding.checkpointGeneration !== candidate.checkpointBinding.checkpointGeneration
    || actual.checkpointBinding.checkpointId !== candidate.checkpointBinding.checkpointId) {
    pushDiscrepancy(discrepancies, '(binding)', 'STATE_CHANGED', 'UNCOMPARABLE', false, 'checkpoint-binding-mismatch');
    return finishComparison(actual, candidate, input.captureSnapshotRevision, completeRevision,
      discrepancies, 'STATE_CHANGED', false, true);
  }

  const candidateBySource = new Map();
  for (const member of candidate.members) candidateBySource.set(member.sourceId, member);
  const candidateRefs = new Map();
  for (const ref of candidate.references) candidateRefs.set(ref.pageId, ref);
  const actualBySource = new Map();
  for (const member of actual.members) actualBySource.set(member.sourceId, member);

  let matchedExactCount = 0;
  let matchedSourceCount = 0;
  let expectedTransformationCount = 0;
  let actualOnlyOptionalCount = 0;
  let actualOnlyOptionalTokens = 0;
  let actualOnlyOptionalTokensKnown = true;
  let candidateOnlyCount = 0;

  // Question B: candidate vs actual membership.
  const allSources = new Set();
  for (const sourceId of actualBySource.keys()) allSources.add(sourceId);
  for (const sourceId of candidateBySource.keys()) allSources.add(sourceId);

  for (const sourceId of allSources) {
    const actualMember = actualBySource.get(sourceId) || null;
    const candidateMember = candidateBySource.get(sourceId) || null;
    const candidateRef = candidateRefs.get(sourceId) || null;

    if (actualMember !== null && actualMember.hostOwned === true) {
      pushDiscrepancy(discrepancies, sourceId, 'HOST_EXTERNAL', 'UNCOMPARABLE', false, 'host-owned-region-excluded');
      continue;
    }

    if (actualMember !== null && (candidateMember !== null || candidateRef !== null)) {
      if (actualMember.reference === true) {
        // The live baseline holds a reference marker for this source:
        // only source-identity agreement is comparable, never shown bytes.
        const actualSourceHash = actualMember.sourceHash || actualMember.shownHash;
        const candidateSourceHash = candidateMember !== null
          ? candidateMember.sourceHash
          : (candidateRef !== null ? candidateRef.contentHash : null);
        if (candidateSourceHash !== null && candidateSourceHash === actualSourceHash) {
          matchedSourceCount += 1;
        } else {
          pushDiscrepancy(discrepancies, sourceId, 'SOURCE_HASH_MISMATCH', 'CRITICAL',
            actualMember.mandatory, 'reference-source-hash-mismatch');
        }
        continue;
      }
      if (candidateRef !== null && candidateMember === null) {
        // Valid COLD reference fallback: source identity survives without
        // materialized source bytes (only when the reference binds the
        // actual source hash).
        if (candidateRef.contentHash === (actualMember.sourceHash || actualMember.shownHash)) {
          expectedTransformationCount += 1;
          pushDiscrepancy(discrepancies, sourceId, 'CANDIDATE_REFERENCE', 'EXPECTED_TRANSFORMATION',
            actualMember.mandatory, 'cold-reference-binds-source-identity');
        } else {
          pushDiscrepancy(discrepancies, sourceId, 'SOURCE_HASH_MISMATCH', 'CRITICAL',
            actualMember.mandatory, 'reference-source-hash-mismatch');
        }
        continue;
      }
      const actualSourceHash = actualMember.sourceHash || actualMember.shownHash;
      if (candidateMember.shownHash === actualMember.shownHash) {
        if (candidateMember.kind === 'EXACT') matchedExactCount += 1;
        else {
          // Same shown bytes through a representation rung: expected.
          if (candidateMember.sourceHash === actualSourceHash) {
            expectedTransformationCount += 1;
            pushDiscrepancy(discrepancies, sourceId, 'CANDIDATE_COMPRESSED', 'EXPECTED_TRANSFORMATION',
              candidateMember.mandatory, 'representation-kind-' + candidateMember.kind);
          } else {
            pushDiscrepancy(discrepancies, sourceId, 'REPRESENTATION_HASH_MISMATCH', 'CRITICAL',
              candidateMember.mandatory || actualMember.mandatory, 'representation-source-binding-mismatch');
          }
        }
        continue;
      }
      if (candidateMember.kind !== 'EXACT' && candidateMember.sourceHash === actualSourceHash) {
        // Legitimate C05 compression: source identity survives, shown
        // bytes differ by a validated representation.
        if (candidateMember.shownHash === null || candidateMember.shownHash === undefined) {
          pushDiscrepancy(discrepancies, sourceId, 'REPRESENTATION_HASH_MISMATCH', 'CRITICAL',
            candidateMember.mandatory || actualMember.mandatory, 'representation-hash-missing');
        } else {
          expectedTransformationCount += 1;
          pushDiscrepancy(discrepancies, sourceId, 'CANDIDATE_COMPRESSED', 'EXPECTED_TRANSFORMATION',
            candidateMember.mandatory, 'representation-kind-' + candidateMember.kind);
        }
        continue;
      }
      if (candidateMember.sourceHash === actualSourceHash) {
        matchedSourceCount += 1;
        continue;
      }
      pushDiscrepancy(discrepancies, sourceId, 'SOURCE_HASH_MISMATCH', 'CRITICAL',
        candidateMember.mandatory || actualMember.mandatory, 'source-hash-mismatch');
      continue;
    }

    if (actualMember !== null) {
      if (actualMember.mandatory === true) {
        pushDiscrepancy(discrepancies, sourceId, 'MANDATORY_MISSING', 'CRITICAL', true, 'mandatory-actual-not-in-candidate');
      } else {
        actualOnlyOptionalCount += 1;
        pushDiscrepancy(discrepancies, sourceId, 'ACTUAL_ONLY_OPTIONAL', 'INFORMATIONAL', false, 'actual-only-optional-context');
        if (typeof actualMember.tokens === 'number') actualOnlyOptionalTokens += actualMember.tokens;
        else actualOnlyOptionalTokensKnown = false;
      }
      continue;
    }

    // Candidate-only members.
    candidateOnlyCount += 1;
    pushDiscrepancy(discrepancies, sourceId, 'CANDIDATE_ONLY_OPTIONAL', 'INFORMATIONAL',
      candidateMember.mandatory, 'candidate-only-context');
  }

  // Question A: candidate completeness relative to authoritative truth.
  const mandatoryCoverage = checkMandatoryCoverage(candidate, discrepancies);
  const currentTurnCoverage = checkCurrentTurnCoverage(actual, candidate, discrepancies);
  const toolProtocolCoverage = checkToolProtocolCoverage(actual, candidate, discrepancies);
  const verificationCoverage = checkVerificationCoverage(actual, candidate, discrepancies);

  // Representation binding integrity (defense in depth: C01/C05 already
  // validated, but a mismatch here stays critical and blocking).
  for (const member of candidate.members) {
    if (member.kind !== 'EXACT' && member.sourceHash === member.shownHash) {
      pushDiscrepancy(discrepancies, member.sourceId, 'REPRESENTATION_HASH_MISMATCH', 'CRITICAL',
        member.mandatory, 'lossy-kind-claims-source-hash');
    }
  }

  let criticalCount = 0;
  for (const entry of discrepancies) {
    if (entry.severity === 'CRITICAL') criticalCount += 1;
  }
  const status = criticalCount === 0 ? 'MATCHED' : 'DIVERGED';
  const blocker = criticalCount !== 0;

  const ordered = sortDiscrepancies(discrepancies);
  const summary = buildSummary(status, {
    matchedExactCount, matchedSourceCount, expectedTransformationCount,
    actualOnlyOptionalCount,
    actualOnlyOptionalTokens: actualOnlyOptionalTokensKnown ? actualOnlyOptionalTokens : null,
    candidateOnlyCount,
    discrepancies: ordered,
    mandatoryCoverage, currentTurnCoverage, toolProtocolCoverage, verificationCoverage,
  }, actual, candidate);

  const comparisonDigest = deriveComparisonDigestV2({
    actual, candidate, ordered,
    captureSnapshotRevision: input.captureSnapshotRevision,
    completeSnapshotRevision: completeRevision,
    promotionBlocker: blocker,
    comparable: true,
  });

  return Object.freeze({
    status, comparable: true, promotionBlocker: blocker,
    discrepancies: Object.freeze(ordered),
    summary: Object.freeze(summary),
    comparisonDigest,
    captureSnapshotRevision: input.captureSnapshotRevision,
    completeSnapshotRevision: completeRevision,
  });
}

function checkMandatoryCoverage(candidate, discrepancies) {
  // Every mandatoryRef must resolve to a kept candidate member whose
  // shown-or-source hash binds the manifest hash.
  const bySource = new Map();
  for (const member of candidate.members) bySource.set(member.sourceId, member);
  let covered = 0;
  for (const ref of candidate.mandatoryRefs) {
    const member = bySource.get(ref.sourceId) || null;
    const bound = member !== null
      && (member.shownHash === ref.contentHash || member.sourceHash === ref.contentHash);
    if (bound) {
      covered += 1;
      continue;
    }
    pushDiscrepancy(discrepancies, ref.sourceId, 'MANDATORY_MISSING', 'CRITICAL', true, 'mandatory-ref-unbound-' + ref.kind);
  }
  return Object.freeze({
    total: candidate.mandatoryRefs.length,
    covered,
    complete: covered === candidate.mandatoryRefs.length,
  });
}

function checkCurrentTurnCoverage(actual, candidate, discrepancies) {
  // Current user turn must be exact, exactly once, source-bound, and
  // revision-bound in the candidate.
  if (actual.currentTurn === null || actual.currentTurn === undefined) {
    return Object.freeze({ required: false, exact: true, count: candidate.currentTurn === null ? 0 : candidate.currentTurn.count });
  }
  if (candidate.currentTurn === null || candidate.currentTurn.count !== 1) {
    pushDiscrepancy(discrepancies, '(current-turn)', 'CURRENT_TURN_MISSING', 'CRITICAL', true,
      'current-turn-count-' + (candidate.currentTurn === null ? '0' : String(candidate.currentTurn.count)));
    return Object.freeze({ required: true, exact: false, count: candidate.currentTurn === null ? 0 : candidate.currentTurn.count });
  }
  if (candidate.currentTurn.textHash !== actual.currentTurn.textHash) {
    pushDiscrepancy(discrepancies, '(current-turn)', 'CURRENT_TURN_MISSING', 'CRITICAL', true, 'current-turn-bytes-mismatch');
    return Object.freeze({ required: true, exact: false, count: 1 });
  }
  return Object.freeze({ required: true, exact: true, count: 1 });
}

function checkToolProtocolCoverage(actual, candidate, discrepancies) {
  // Complete tool transactions only: every balanced actual callId must
  // have a balanced candidate unit with the same callId. A call matched
  // without its result is never acceptable.
  const actualBalanced = (actual.toolTransactions || []).filter((tx) => tx.balanced === true);
  const candidateByCall = new Map();
  for (const tx of candidate.toolTransactions) candidateByCall.set(tx.callId, tx);
  // Candidate-side open protocol is itself a loss (C02H would have
  // failed closed; observation stays critical).
  for (const tx of candidate.toolTransactions) {
    if (tx.balanced !== true) {
      pushDiscrepancy(discrepancies, '(tool:' + tx.callId + ')', 'TOOL_PROTOCOL_MISSING', 'CRITICAL', true, 'candidate-protocol-open');
    }
  }
  let covered = 0;
  for (const tx of actualBalanced) {
    const match = candidateByCall.get(tx.callId) || null;
    if (match !== null && match.balanced === true) {
      covered += 1;
      continue;
    }
    pushDiscrepancy(discrepancies, '(tool:' + tx.callId + ')', 'TOOL_PROTOCOL_MISSING', 'CRITICAL', true,
      match === null ? 'tool-transaction-absent' : 'tool-transaction-unbalanced');
  }
  return Object.freeze({ total: actualBalanced.length, covered, complete: covered === actualBalanced.length });
}

function checkVerificationCoverage(actual, candidate, discrepancies) {
  if (actual.verification === null || actual.verification === undefined) {
    return Object.freeze({ required: false, preserved: true });
  }
  if (candidate.verification === null) {
    pushDiscrepancy(discrepancies, '(verification)', 'VERIFICATION_TRUTH_MISSING', 'CRITICAL', true, 'verification-truth-absent');
    return Object.freeze({ required: true, preserved: false });
  }
  if (candidate.verification.digest !== actual.verification.digest) {
    pushDiscrepancy(discrepancies, '(verification)', 'VERIFICATION_TRUTH_MISSING', 'CRITICAL', true, 'verification-digest-mismatch');
    return Object.freeze({ required: true, preserved: false });
  }
  return Object.freeze({ required: true, preserved: true });
}

function finishComparison(actual, candidate, captureRevision, completeRevision, discrepancies, status, comparable, blocker) {
  const ordered = sortDiscrepancies(discrepancies);
  const summary = buildSummary(status, {
    matchedExactCount: 0, matchedSourceCount: 0, expectedTransformationCount: 0,
    actualOnlyOptionalCount: 0, actualOnlyOptionalTokens: null, candidateOnlyCount: 0,
    discrepancies: ordered,
    mandatoryCoverage: Object.freeze({ total: 0, covered: 0, complete: status !== 'CANDIDATE_FAILED' && status !== 'UNCOMPARABLE' ? true : false }),
    currentTurnCoverage: Object.freeze({ required: false, exact: false, count: 0 }),
    toolProtocolCoverage: Object.freeze({ total: 0, covered: 0, complete: false }),
    verificationCoverage: Object.freeze({ required: false, preserved: false }),
  }, actual, candidate);
  const comparisonDigest = deriveComparisonDigestV2({
    actual, candidate, ordered,
    captureSnapshotRevision: captureRevision,
    completeSnapshotRevision: completeRevision,
    promotionBlocker: blocker,
    comparable,
  });
  return Object.freeze({
    status, comparable, promotionBlocker: blocker,
    discrepancies: Object.freeze(ordered),
    summary: Object.freeze(summary),
    comparisonDigest,
    captureSnapshotRevision: captureRevision,
    completeSnapshotRevision: completeRevision,
  });
}

function buildSummary(status, parts, actual, candidate) {
  let criticalCount = 0;
  let informationalCount = 0;
  let hostExternalCount = 0;
  for (const entry of parts.discrepancies) {
    if (entry.severity === 'CRITICAL') criticalCount += 1;
    else if (entry.severity === 'INFORMATIONAL') informationalCount += 1;
    if (entry.code === 'HOST_EXTERNAL') hostExternalCount += 1;
  }
  const tokensAvailable = (actual.comparableTokens === null || actual.comparableTokens === undefined)
    ? false
    : actual.tokenizerFingerprint === candidate.tokenizerFingerprint;
  const candidateTokens = candidate.tokenMetrics.candidateMaterializedTokens;
  let logicalReduction = null;
  if (tokensAvailable && Number.isInteger(actual.comparableTokens)
    && actual.comparableTokens > 0 && Number.isInteger(candidateTokens)) {
    logicalReduction = 1 - candidateTokens / actual.comparableTokens;
  }
  return {
    status,
    matchedExactCount: parts.matchedExactCount,
    matchedSourceCount: parts.matchedSourceCount,
    expectedTransformationCount: parts.expectedTransformationCount,
    actualOnlyOptionalCount: parts.actualOnlyOptionalCount,
    actualOnlyOptionalTokens: parts.actualOnlyOptionalTokens,
    candidateOnlyCount: parts.candidateOnlyCount,
    criticalCount,
    informationalCount,
    hostExternalCount,
    logicalReduction,
    comparableTokensAvailable: tokensAvailable,
    mandatoryCoverage: parts.mandatoryCoverage,
    currentTurnCoverage: parts.currentTurnCoverage,
    toolProtocolCoverage: parts.toolProtocolCoverage,
    verificationCoverage: parts.verificationCoverage,
  };
}

function deriveComparisonDigestV2(parts) {
  const body = {
    domain: SHADOW_DIGEST_DOMAIN_V1,
    policyRevision: SHADOW_POLICY_REVISION_V2,
    namespace: parts.actual.namespace,
    captureSnapshotRevision: parts.captureSnapshotRevision,
    completeSnapshotRevision: parts.completeSnapshotRevision,
    actualDigest: sha256HexUtf8(canonicalJsonOf(parts.actual)),
    candidateViewId: parts.candidate.viewId,
    candidateViewDigest: parts.candidate.viewDigest,
    candidateLayoutDigest: parts.candidate.layoutDigest,
    candidateStablePrefixDigest: parts.candidate.stablePrefixDigest,
    discrepancies: parts.ordered,
    promotionBlocker: parts.promotionBlocker,
    comparable: parts.comparable,
  };
  return sha256HexUtf8(SHADOW_DIGEST_DOMAIN_V1 + LF_JOIN + canonicalJsonOf(body));
}

// ---- shadow report contract (observability, never authority) ----

/**
 * Assemble the closed-world observational report. The report is
 * observability: NOT task truth, NOT a ContextView, NOT checkpoint
 * state, NOT authority. Carries hashes/IDs/counts only.
 */
function buildShadowReportV2(input) {
  if (!isPlainObject(input)) failShadow('report-invalid', 'report input must be an object');
  if (unknownKeyOf(input, ['actual', 'candidateResult', 'comparison', 'tokenizerFingerprint']) !== null) {
    failShadow('report-invalid', 'report input carries unknown keys');
  }
  const actual = observeActualV2(input.actual);
  const candidateResult = input.candidateResult;
  if (!isPlainObject(candidateResult) || !isPlainObject(candidateResult.candidateObservation)) {
    failShadow('report-invalid', 'candidate result is required');
  }
  const candidate = candidateResult.candidateObservation;
  if (input.tokenizerFingerprint !== null && input.tokenizerFingerprint !== undefined
    && input.tokenizerFingerprint !== candidate.tokenizerFingerprint) {
    failShadow('report-invalid', 'tokenizer fingerprint does not bind the candidate');
  }
  const comparison = input.comparison;
  if (!isPlainObject(comparison) || SHADOW_STATUSES.indexOf(comparison.status) === -1
    || !Array.isArray(comparison.discrepancies) || typeof comparison.comparisonDigest !== 'string') {
    failShadow('report-invalid', 'comparison outcome is required');
  }

  const comparableMembers = actual.members.filter((m) => m.hostOwned !== true).length;
  const hostExternalCount = actual.members.length - comparableMembers;
  const report = {
    schemaVersion: SHADOW_SCHEMA_VERSION,
    shadowPolicyRevision: SHADOW_POLICY_REVISION_V2,
    namespace: deepClone(actual.namespace),
    requestBinding: {
      taskId: actual.namespace.taskId,
      taskInstanceId: actual.namespace.taskInstanceId,
      sessionId: actual.namespace.sessionId,
      checkpointGeneration: actual.checkpointBinding.checkpointGeneration,
      checkpointId: actual.checkpointBinding.checkpointId,
      captureSnapshotRevision: comparison.captureSnapshotRevision,
      completeSnapshotRevision: comparison.completeSnapshotRevision,
    },
    checkpointBinding: deepClone(actual.checkpointBinding),
    actualObservation: {
      memberCount: actual.members.length,
      comparableMemberCount: comparableMembers,
      hostExternalCount,
      actualComparableTokens: (actual.comparableTokens === null || actual.comparableTokens === undefined)
        ? null : actual.comparableTokens,
      tokenizerAvailable: actual.tokenizerFingerprint === candidate.tokenizerFingerprint,
      currentTurnBound: actual.currentTurn !== null && actual.currentTurn !== undefined,
      verificationBound: actual.verification !== null && actual.verification !== undefined,
      toolTransactionCount: (actual.toolTransactions || []).length,
    },
    candidateObservation: {
      viewId: candidate.viewId,
      viewDigest: candidate.viewDigest,
      layoutDigest: candidate.layoutDigest,
      stablePrefixDigest: candidate.stablePrefixDigest,
      memberCount: candidate.members.length,
      referencedColdCount: candidate.references.length,
      candidateMaterializedTokens: candidate.tokenMetrics.candidateMaterializedTokens,
      mandatoryTokens: candidate.tokenMetrics.mandatoryTokens,
      hotTokens: candidate.tokenMetrics.hotTokens,
      warmTokens: candidate.tokenMetrics.warmTokens,
      coldMaterializedTokens: candidate.tokenMetrics.coldMaterializedTokens,
      referencedOnlyColdCount: candidate.tokenMetrics.referencedOnlyColdCount,
      stablePrefixBoundary: candidate.stablePrefixBoundary,
      zoneCounts: deepClone(candidate.zoneCounts),
    },
    comparisonSummary: deepClone(comparison.summary),
    discrepancies: deepClone(comparison.discrepancies),
    promotionBlocker: comparison.promotionBlocker,
    promotionBlockerReasons: comparison.discrepancies
      .filter((entry) => entry.severity === 'CRITICAL')
      .map((entry) => entry.code)
      .filter((code, index, all) => all.indexOf(code) === index)
      .sort(),
    comparable: comparison.comparable,
    comparisonDigest: comparison.comparisonDigest,
    disposable: true,
  };
  const check = validateShadowReportV2(report);
  if (!check.valid) failShadow('report-invalid', String(check.reason).slice(0, 200));
  return Object.freeze(report);
}

function validateShadowReportV2(report) {
  const fail = (reason) => ({ valid: false, reason });
  if (!isPlainObject(report)) return fail('shadow-report-invalid');
  if (unknownKeyOf(report, REPORT_TOP_EXACT_KEYS) !== null) return fail('shadow-report-invalid');
  if (report.schemaVersion !== SHADOW_SCHEMA_VERSION) return fail('shadow-report-version-invalid');
  if (report.shadowPolicyRevision !== SHADOW_POLICY_REVISION_V2) return fail('shadow-report-policy-invalid');
  if (report.disposable !== true) return fail('shadow-report-disposable-invalid');
  if (!isPlainObject(report.namespace) || unknownKeyOf(report.namespace, REPORT_NAMESPACE_EXACT_KEYS) !== null) {
    return fail('shadow-report-namespace-invalid');
  }
  if (!isPlainObject(report.requestBinding)
    || unknownKeyOf(report.requestBinding, REPORT_REQUEST_BINDING_EXACT_KEYS) !== null) {
    return fail('shadow-report-binding-invalid');
  }
  if (!isPlainObject(report.checkpointBinding)
    || unknownKeyOf(report.checkpointBinding, REPORT_CHECKPOINT_BINDING_EXACT_KEYS) !== null) {
    return fail('shadow-report-binding-invalid');
  }
  if (!isPlainObject(report.actualObservation)
    || unknownKeyOf(report.actualObservation, REPORT_ACTUAL_OBS_EXACT_KEYS) !== null) {
    return fail('shadow-report-actual-invalid');
  }
  if (!isPlainObject(report.candidateObservation)
    || unknownKeyOf(report.candidateObservation, REPORT_CANDIDATE_OBS_EXACT_KEYS) !== null) {
    return fail('shadow-report-candidate-invalid');
  }
  if (!isPlainObject(report.comparisonSummary)
    || unknownKeyOf(report.comparisonSummary, REPORT_SUMMARY_EXACT_KEYS) !== null) {
    return fail('shadow-report-summary-invalid');
  }
  if (SHADOW_STATUSES.indexOf(report.comparisonSummary.status) === -1) return fail('shadow-report-status-invalid');
  if (!Array.isArray(report.discrepancies)) return fail('shadow-report-discrepancies-invalid');
  for (const entry of report.discrepancies) {
    if (!isPlainObject(entry) || unknownKeyOf(entry, REPORT_DISCREPANCY_EXACT_KEYS) !== null) {
      return fail('shadow-report-discrepancy-invalid');
    }
    if (DISCREPANCY_CODES.indexOf(entry.code) === -1) return fail('shadow-report-discrepancy-invalid');
    if (DISCREPANCY_SEVERITIES.indexOf(entry.severity) === -1) return fail('shadow-report-severity-invalid');
    if (typeof entry.sourceId !== 'string' || typeof entry.detail !== 'string'
      || typeof entry.mandatory !== 'boolean') {
      return fail('shadow-report-discrepancy-invalid');
    }
  }
  const ordered = sortDiscrepancies(report.discrepancies);
  if (canonicalJsonOf(ordered) !== canonicalJsonOf(report.discrepancies)) {
    return fail('shadow-report-order-invalid');
  }
  if (typeof report.promotionBlocker !== 'boolean') return fail('shadow-report-blocker-invalid');
  if (!Array.isArray(report.promotionBlockerReasons)) return fail('shadow-report-blocker-invalid');
  if (typeof report.comparable !== 'boolean') return fail('shadow-report-comparable-invalid');
  if (!isHex64(report.comparisonDigest)) return fail('shadow-report-digest-invalid');
  return { valid: true, reason: null };
}

function canonicalizeShadowReportV2(report) {
  const check = validateShadowReportV2(report);
  if (!check.valid) failShadow('report-invalid', 'cannot canonicalize an invalid report: ' + check.reason);
  return canonicalJsonOf(report);
}

/**
 * Bounded safe summary for consoles/diagnostics (section 55 vocabulary).
 * IDs/digests truncated to prefixes; no text ever carried.
 */
function describeShadowReportV2(report) {
  const check = validateShadowReportV2(report);
  if (!check.valid) failShadow('report-invalid', 'cannot describe an invalid report: ' + check.reason);
  return Object.freeze({
    shadowStatus: report.comparisonSummary.status,
    candidateViewId: report.candidateObservation.viewId,
    candidateViewDigestPrefix: String(report.candidateObservation.viewDigest).slice(0, 16),
    candidateLayoutDigestPrefix: String(report.candidateObservation.layoutDigest).slice(0, 16),
    stablePrefixDigestPrefix: String(report.candidateObservation.stablePrefixDigest).slice(0, 16),
    candidateTokens: report.candidateObservation.candidateMaterializedTokens,
    actualComparableTokens: report.actualObservation.actualComparableTokens,
    logicalReduction: report.comparisonSummary.logicalReduction,
    mandatoryCoverage: report.comparisonSummary.mandatoryCoverage,
    criticalCount: report.comparisonSummary.criticalCount,
    expectedTransformationCount: report.comparisonSummary.expectedTransformationCount,
    actualOnlyOptionalCount: report.comparisonSummary.actualOnlyOptionalCount,
    candidateOnlyCount: report.comparisonSummary.candidateOnlyCount,
    promotionBlocker: report.promotionBlocker,
    comparable: report.comparable,
    comparisonDigestPrefix: String(report.comparisonDigest).slice(0, 16),
    disposable: true,
  });
}

/**
 * Minimal fail-open report for catastrophic shadow failures (candidate
 * unavailable, comparison impossible). Carries no candidate identity;
 * the live request still proceeds unchanged.
 */
function buildFailedShadowReportV2(input) {
  const source = isPlainObject(input) ? input : {};
  const namespace = isPlainObject(source.namespace) ? source.namespace : { taskId: '?', taskInstanceId: '?', sessionId: '?' };
  const reason = typeof source.reason === 'string' ? source.reason : 'shadow-failed';
  const capture = typeof source.captureSnapshotRevision === 'string' ? source.captureSnapshotRevision : 'unknown';
  const complete = typeof source.completeSnapshotRevision === 'string' ? source.completeSnapshotRevision : capture;
  const discrepancies = sortDiscrepancies([{
    sourceId: '(shadow)', code: 'CANDIDATE_FAILED', severity: 'CRITICAL', mandatory: false, detail: reason.slice(0, 256),
  }]);
  const placeholderActual = {
    schemaVersion: SHADOW_SCHEMA_VERSION,
    namespace: { taskId: 'x', taskInstanceId: 'y', sessionId: 'z' },
    checkpointBinding: { checkpointGeneration: 0, checkpointId: 'ccp_probe', snapshotRevision: capture },
    members: [],
  };
  const placeholderCandidate = {
    viewId: 'cxv_probe', viewDigest: sha256HexUtf8('probe').repeat(1).slice(0, 64),
    layoutDigest: sha256HexUtf8('probe-layout').slice(0, 64),
    stablePrefixDigest: sha256HexUtf8('probe-prefix').slice(0, 64),
  };
  const digestBody = {
    domain: SHADOW_DIGEST_DOMAIN_V1,
    policyRevision: SHADOW_POLICY_REVISION_V2,
    namespace,
    captureSnapshotRevision: capture,
    completeSnapshotRevision: complete,
    actualDigest: sha256HexUtf8(canonicalJsonOf(placeholderActual)),
    candidateViewId: null,
    candidateViewDigest: null,
    candidateLayoutDigest: null,
    candidateStablePrefixDigest: null,
    discrepancies,
    promotionBlocker: true,
    comparable: false,
    failureReason: reason.slice(0, 128),
  };
  return Object.freeze({
    schemaVersion: SHADOW_SCHEMA_VERSION,
    shadowPolicyRevision: SHADOW_POLICY_REVISION_V2,
    namespace: {
      taskId: String(namespace.taskId || '?').slice(0, 256),
      taskInstanceId: String(namespace.taskInstanceId || '?').slice(0, 256),
      sessionId: String(namespace.sessionId || '?').slice(0, 256),
    },
    requestBinding: {
      taskId: String(namespace.taskId || '?').slice(0, 256),
      taskInstanceId: String(namespace.taskInstanceId || '?').slice(0, 256),
      sessionId: String(namespace.sessionId || '?').slice(0, 256),
      checkpointGeneration: Number.isInteger(source.checkpointGeneration) ? source.checkpointGeneration : 0,
      checkpointId: typeof source.checkpointId === 'string' ? source.checkpointId : 'unknown',
      captureSnapshotRevision: capture,
      completeSnapshotRevision: complete,
    },
    checkpointBinding: {
      checkpointGeneration: Number.isInteger(source.checkpointGeneration) ? source.checkpointGeneration : 0,
      checkpointId: typeof source.checkpointId === 'string' ? source.checkpointId : 'unknown',
      snapshotRevision: capture,
    },
    actualObservation: {
      memberCount: 0, comparableMemberCount: 0, hostExternalCount: 0,
      actualComparableTokens: null, tokenizerAvailable: false,
      currentTurnBound: false, verificationBound: false, toolTransactionCount: 0,
    },
    candidateObservation: {
      viewId: null, viewDigest: null, layoutDigest: null, stablePrefixDigest: null,
      memberCount: 0, referencedColdCount: 0, candidateMaterializedTokens: null,
      mandatoryTokens: 0, hotTokens: 0, warmTokens: 0, coldMaterializedTokens: 0,
      referencedOnlyColdCount: 0, stablePrefixBoundary: 0, zoneCounts: {},
    },
    comparisonSummary: {
      status: 'CANDIDATE_FAILED',
      matchedExactCount: 0, matchedSourceCount: 0, expectedTransformationCount: 0,
      actualOnlyOptionalCount: 0, actualOnlyOptionalTokens: null, candidateOnlyCount: 0,
      criticalCount: 1, informationalCount: 0, hostExternalCount: 0,
      logicalReduction: null, comparableTokensAvailable: false,
      mandatoryCoverage: { total: 0, covered: 0, complete: false },
      currentTurnCoverage: { required: false, exact: false, count: 0 },
      toolProtocolCoverage: { total: 0, covered: 0, complete: false },
      verificationCoverage: { required: false, preserved: false },
    },
    discrepancies,
    promotionBlocker: true,
    promotionBlockerReasons: ['CANDIDATE_FAILED'],
    comparable: false,
    comparisonDigest: sha256HexUtf8(SHADOW_DIGEST_DOMAIN_V1 + LF_JOIN + canonicalJsonOf(digestBody)),
    disposable: true,
  });
}

module.exports = {
  SHADOW_ACTUAL_MEMBERS_MAX,
  SHADOW_SCHEMA_VERSION,
  SHADOW_POLICY_REVISION_V2,
  SHADOW_DIGEST_DOMAIN_V1,
  SHADOW_MODES,
  SHADOW_MODE_ENV_VAR,
  SHADOW_STATUSES,
  DISCREPANCY_CODES,
  DISCREPANCY_SEVERITIES,
  resolveCompilerShadowModeV2,
  observeActualV2,
  observeCandidateV2,
  buildCandidateV2,
  compareShadowV2,
  buildShadowReportV2,
  validateShadowReportV2,
  canonicalizeShadowReportV2,
  describeShadowReportV2,
  buildFailedShadowReportV2,
};
