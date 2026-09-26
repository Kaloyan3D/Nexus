'use strict';
/**
 * ContextPressureV2.cjs - CCV2-A08 ContextPressureV2 production authority.
 *
 * ONE authority for the V2 pressure decision: provider-capacity accounting,
 * explicit safety reserves, headroom computation, frozen threshold policy,
 * and the deterministic pressure level + recommendation. No other CCv2
 * component redefines what pressure means.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (A08 sections). A08 answers two questions and NOTHING else:
 *
 *   1. How much usable context headroom remains?
 *   2. If compaction were to happen, what existing context may leave the
 *      active prompt without violating the frozen A01-A07 safety contracts?
 *
 * This module answers question 1. config/ContextRetentionV2.cjs answers
 * question 2. Neither module mutates the live session, the DSH log,
 * deriveMessages(), any checkpoint projection, or any controller prompt.
 * Pressure may REQUEST compaction; it never PERFORMS it (A09 observes in
 * shadow mode; A10 is the first stage allowed to apply).
 *
 * Core rule (frozen): pressure NEVER overrides safety. A CRITICAL pressure
 * level combined with an unsafe/unfresh/non-checkpointable safety state
 * yields recommendation 'blocked' at the retention-plan layer, never
 * 'compact anyway'. Permission to compact requires A06 SAFE + A05 FRESH +
 * A07 CHECKPOINTABLE + an A08 actionable plan; this module owns only the
 * pressure leg of that plan.
 *
 * Provider capacity (frozen resolution order, mirroring the existing
 * production authority Get-AihReviewerModelCapacity in
 * scripts/CodexReview.ps1 (TASK-0012): the provider's own /models
 * metadata when it declares capacity (authoritative over the fallback),
 * then the Nexus model registry (config/model-registry.json, contextWindow
 * per model id), then UNKNOWN. This module never invents a window and never
 * fetches provider metadata itself: the caller supplies the grounded
 * provider capability document (or null) and A08 resolves deterministically.
 * Declared provider metadata wins over any caller-asserted token value
 * (same precedence as the PS authority). A caller-asserted token value may
 * additionally claim source 'model-registry', which A08 verifies
 * against the registry and refuses on mismatch. Every decision records
 * capacitySource (provider-models-metadata | model-registry |
 * caller-asserted | unknown). Malformed metadata containers fail closed;
 * a well-formed document that simply declares nothing falls back per the
 * existing policy. No source declaring capacity yields known=false and
 * level UNKNOWN: the decision stays honest and any action requiring exact
 * capacity fails closed with blocker pressure-capacity-unknown.
 *
 * Context cost (frozen precedence):
 *   real provider tokenizer/count
 *   -> existing Nexus deterministic estimator (none exists; reserved)
 *   -> explicit conservative estimate (UTF-8 bytes / 4, ceiling)
 * Estimated counts are ALWAYS marked exact=false with their method; they
 * are never represented as exact provider token counts.
 *
 * Frozen formulas:
 *   usableCapacity = providerCapacity - reservedOutput - reservedProtocol
 *                    - reservedSafety
 *   headroom       = usableCapacity - currentActiveContextCost
 *   usedFraction   = currentActiveContextCost / usableCapacity
 *
 * Frozen threshold policy (nexus/context-pressure-policy/v1), evaluated
 * on usedFraction (headroom-based, never age/message-count based):
 *   usedFraction >= 0.95 -> CRITICAL
 *   usedFraction >= 0.85 -> HIGH
 *   usedFraction >= 0.70 -> ELEVATED
 *   else                 -> NORMAL
 * Hysteresis exits (0.90 / 0.80 / 0.65) and minimumReclaimTokens (2048)
 * are frozen alongside for A09 thrash protection; the level itself is a
 * pure enter-threshold function (deterministic, no clock).
 *
 * Determinism: no clock, no randomness, no LLM. Identical provider
 * capability + active context cost + snapshot binding yields byte-identical
 * decisions and digests.
 *
 * Security: prompt/repository/tool TEXT never influences the decision.
 * measurePressureV2() accepts only numeric costs and capability metadata;
 * any content-bearing field on the input FAILS CLOSED.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PRESSURE_SCHEMA_VERSION = 1;
const THRESHOLD_POLICY_ID_V1 = 'nexus/context-pressure-policy/v1';
const RESERVE_POLICY_ID_V1 = 'nexus/context-reserve-policy/v1';
const PRESSURE_DECISION_DIGEST_DOMAIN_V1 = 'nexus/context-pressure-decision/v1';
const PRESSURE_BASIS_DIGEST_DOMAIN_V1 = 'nexus/context-pressure-basis/v1';
const LF_JOIN = String.fromCharCode(10);
// Frozen capacity-source taxonomy: every decision records exactly where its
// capacity came from. caller-asserted means the caller supplied the token
// value without a verifiable declaration (metadata/registry take precedence
// whenever they declare).
const CAPACITY_SOURCES = Object.freeze(['provider-models-metadata', 'model-registry', 'caller-asserted', 'unknown']);
// Frozen provider-metadata field scan order (mirrors Get-AihReviewerModelCapacity
// field lists verbatim; first positive declaration wins).
const PROVIDER_CAPACITY_FIELDS = Object.freeze(['context_window', 'contextWindow', 'max_context_tokens', 'max_context_window_tokens', 'max_input_tokens', 'context_length', 'contextLength']);
const PROVIDER_OUTPUT_FIELDS = Object.freeze(['max_output_tokens', 'maxOutputTokens', 'max_completion_tokens']);
const CAPACITY_SOURCE_CLAIMS = Object.freeze(['model-registry']);

// ---- frozen threshold policy (single definition; no scattered literals) ----
const THRESHOLD_POLICY_V1 = Object.freeze({
  policyId: THRESHOLD_POLICY_ID_V1,
  elevatedEnter: 0.70,
  highEnter: 0.85,
  criticalEnter: 0.95,
  elevatedExit: 0.65,
  highExit: 0.80,
  criticalExit: 0.90,
  minimumReclaimTokens: 2048,
});

// ---- frozen default reserves (explicit architecture values, not magic) ----
// Rationale: next-model-response room (largest vendor-verified output floor
// across registry tools-capable models), tool-protocol framing budget, and
// an independent safety margin for transport/continuation-kernel overhead.
// Callers SHOULD supply grounded per-route reserves; these defaults apply
// only when the caller passes null and are always reported verbatim.
const DEFAULT_RESERVES_V1 = Object.freeze({
  outputTokens: 8192,
  protocolTokens: 4096,
  safetyTokens: 4096,
});

const PRESSURE_LEVELS = Object.freeze(['NORMAL', 'ELEVATED', 'HIGH', 'CRITICAL', 'UNKNOWN']);
const PRESSURE_RECOMMENDATIONS = Object.freeze(['none', 'prepare', 'compact-when-safe', 'compact-required', 'blocked']);
const PRESSURE_BLOCKER_CODES = Object.freeze([
  'pressure-capacity-unknown',
  'pressure-accounting-invalid',
]);
const COST_METHODS = Object.freeze(['provider-tokenizer', 'deterministic-estimate', 'conservative-estimate']);

const PRESSURE_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'providerModelId',
  'providerCapability',
  'providerCapacityTokens',
  'capacitySource',
  'currentContextTokens',
  'costMethod',
  'costExact',
  'reservedOutputTokens',
  'reservedProtocolTokens',
  'reservedSafetyTokens',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'generation',
  'snapshotTokenId',
  'revisionDigest',
]);

const PRESSURE_DECISION_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'known',
  'level',
  'providerModelId',
  'capacitySource',
  'providerCapacityTokens',
  'currentContextTokens',
  'costMethod',
  'costExact',
  'reserves',
  'usableCapacityTokens',
  'remainingHeadroomTokens',
  'usedFraction',
  'thresholdPolicyId',
  'reservePolicyId',
  'recommendation',
  'blockers',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'generation',
  'snapshotTokenId',
  'revisionDigest',
]);

const PRESSURE_RESERVES_EXACT_KEYS = Object.freeze(['outputTokens', 'protocolTokens', 'safetyTokens']);
const PRESSURE_BLOCKER_EXACT_KEYS = Object.freeze(['code', 'detail']);

const PRESSURE_BOUNDS = Object.freeze({
  taskId: 256,
  taskInstanceId: 256,
  sessionId: 256,
  providerModelId: 256,
  tokenId: 256,
  digest: 128,
  detail: 1024,
  capacityMax: 100000000,
});

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function failPressure(message) {
  throw new Error('v2-pressure: ' + message + ' (KEEP)');
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

function sha256HexUtf8(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function byteLengthUtf8(text) {
  return Buffer.byteLength(text, 'utf8');
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

// ---- deterministic conservative estimator (frozen) ----
// ceil(utf8Bytes / 4): deliberately conservative, never exact.
function estimateTokensForUtf8Bytes(byteCount) {
  if (!Number.isInteger(byteCount) || byteCount < 0) failPressure('byteCount must be a non-negative integer');
  if (byteCount === 0) return 0;
  return Math.ceil(byteCount / 4);
}

function estimateTokensForText(text) {
  if (typeof text !== 'string') failPressure('text must be a string');
  return { tokens: estimateTokensForUtf8Bytes(byteLengthUtf8(text)), method: 'conservative-estimate', exact: false };
}

function estimateTokensForEvents(events) {
  if (!Array.isArray(events)) failPressure('events must be an array');
  const bytes = byteLengthUtf8(serializeCanonical(events));
  return { tokens: estimateTokensForUtf8Bytes(bytes), method: 'conservative-estimate', exact: false };
}

// ---- provider capacity (grounded registry ONLY) ----
let registryCache;
let registryLoaded = false;
function registryPath() {
  return path.join(__dirname, 'model-registry.json');
}

function loadModelRegistry() {
  if (registryLoaded) return registryCache;
  registryLoaded = true;
  let raw = null;
  try {
    raw = fs.readFileSync(registryPath(), 'utf8');
  } catch {
    registryCache = null;
    return null;
  }
  try {
    registryCache = JSON.parse(raw);
  } catch {
    failPressure('model registry is malformed');
  }
  return registryCache;
}

// Scans one grounded provider /models capability document for a capacity
// declaration for the model. Mirrors Get-AihReviewerModelCapacity: the first
// positive numeric declaration in frozen field order wins (truncated to an
// integer, exactly like the PS [int64] cast). A well-formed document that
// declares nothing yields { declared: false } (documented fallback); a
// malformed container fails closed. Provider documents carry foreign keys
// (object types, timestamps), so content is scanned defensively instead of
// exact-key validated: only the capacity declaration is trusted, nothing else.
function scanProviderCapability(providerModelId, providerCapability) {
  if (providerCapability === null || providerCapability === undefined) return { declared: false, capacityTokens: null, providerMaxOutputTokens: null };
  if (!providerCapability || typeof providerCapability !== 'object' || Array.isArray(providerCapability) || Object.getPrototypeOf(providerCapability) !== Object.prototype) {
    failPressure('providerCapability must be a /models capability object or null');
  }
  let entries = null;
  if (Array.isArray(providerCapability.data)) {
    entries = providerCapability.data;
  } else if (typeof providerCapability.id === 'string' || typeof providerCapability.model === 'string') {
    entries = [providerCapability];
  } else if (providerCapability.data === undefined || providerCapability.data === null) {
    return { declared: false, capacityTokens: null, providerMaxOutputTokens: null };
  } else {
    failPressure('providerCapability.data must be an array or absent');
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (entry.id !== providerModelId && entry.model !== providerModelId) continue;
    let declared = null;
    for (const field of PROVIDER_CAPACITY_FIELDS) {
      const raw = entry[field];
      if (raw === null || raw === undefined || raw === '') continue;
      const num = Number(raw);
      if (!Number.isFinite(num) || num <= 0) continue;
      const truncated = Math.trunc(num);
      if (truncated <= 0 || truncated > PRESSURE_BOUNDS.capacityMax) continue;
      declared = truncated;
      break;
    }
    let maxOutput = null;
    for (const field of PROVIDER_OUTPUT_FIELDS) {
      const raw = entry[field];
      if (raw === null || raw === undefined || raw === '') continue;
      const num = Number(raw);
      if (!Number.isFinite(num) || num <= 0) continue;
      const truncated = Math.trunc(num);
      if (truncated <= 0 || truncated > PRESSURE_BOUNDS.capacityMax) continue;
      maxOutput = truncated;
      break;
    }
    if (declared !== null) return { declared: true, capacityTokens: declared, providerMaxOutputTokens: maxOutput };
    return { declared: false, capacityTokens: null, providerMaxOutputTokens: maxOutput };
  }
  return { declared: false, capacityTokens: null, providerMaxOutputTokens: null };
}

// Frozen resolution order (same authority as Get-AihReviewerModelCapacity):
// grounded provider /models metadata first (authoritative when declared),
// then the model-registry fallback, then UNKNOWN. Never invents capacity.
function resolveProviderCapacity(providerModelId, providerModelsMetadata) {
  if (typeof providerModelId !== 'string' || providerModelId === '') failPressure('providerModelId is required');
  const scanned = scanProviderCapability(providerModelId, providerModelsMetadata === undefined ? null : providerModelsMetadata);
  if (scanned.declared) {
    return { known: true, capacityTokens: scanned.capacityTokens, providerId: null, modelId: providerModelId, source: 'provider-models-metadata', providerMaxOutputTokens: scanned.providerMaxOutputTokens };
  }
  const registry = loadModelRegistry();
  if (!registry || !Array.isArray(registry.models)) {
    return { known: false, capacityTokens: null, providerId: null, modelId: providerModelId, source: 'unknown', providerMaxOutputTokens: scanned.providerMaxOutputTokens };
  }
  const entry = registry.models.find((m) => m && (m.id === providerModelId || m.model === providerModelId));
  if (!entry || !Number.isInteger(entry.contextWindow) || entry.contextWindow <= 0) {
    return { known: false, capacityTokens: null, providerId: null, modelId: providerModelId, source: 'unknown', providerMaxOutputTokens: scanned.providerMaxOutputTokens };
  }
  const providerId = typeof entry.provider === 'string' ? entry.provider : null;
  const registryMaxOutput = Number.isInteger(entry.maxOutputTokens) && entry.maxOutputTokens > 0 ? entry.maxOutputTokens : null;
  return { known: true, capacityTokens: entry.contextWindow, providerId, modelId: entry.id || providerModelId, source: 'model-registry', providerMaxOutputTokens: scanned.providerMaxOutputTokens !== null ? scanned.providerMaxOutputTokens : registryMaxOutput };
}

function resolveReserves(outputTokens, protocolTokens, safetyTokens) {
  const pick = (given, def, what) => {
    if (given === null || given === undefined) return def;
    if (!Number.isInteger(given) || given < 0 || given > PRESSURE_BOUNDS.capacityMax) {
      failPressure(what + ' must be a non-negative integer within bounds');
    }
    return given;
  };
  return {
    outputTokens: pick(outputTokens, DEFAULT_RESERVES_V1.outputTokens, 'reservedOutputTokens'),
    protocolTokens: pick(protocolTokens, DEFAULT_RESERVES_V1.protocolTokens, 'reservedProtocolTokens'),
    safetyTokens: pick(safetyTokens, DEFAULT_RESERVES_V1.safetyTokens, 'reservedSafetyTokens'),
  };
}

function levelForUsedFraction(usedFraction) {
  if (usedFraction >= THRESHOLD_POLICY_V1.criticalEnter) return 'CRITICAL';
  if (usedFraction >= THRESHOLD_POLICY_V1.highEnter) return 'HIGH';
  if (usedFraction >= THRESHOLD_POLICY_V1.elevatedEnter) return 'ELEVATED';
  return 'NORMAL';
}

function recommendationForLevel(level) {
  if (level === 'NORMAL') return 'none';
  if (level === 'ELEVATED') return 'prepare';
  if (level === 'HIGH') return 'compact-when-safe';
  if (level === 'CRITICAL') return 'compact-required';
  return 'blocked';
}

function normalizePressureInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) failPressure('input is required');
  for (const banned of ['text', 'content', 'prompt', 'message', 'transcript']) {
    if (input[banned] !== undefined) failPressure('content field ' + banned + ' is forbidden');
  }
  const unknown = unknownKeyOf(input, PRESSURE_INPUT_EXACT_KEYS);
  if (unknown !== null) failPressure('unknown field ' + unknown);
  if (Number(input.schemaVersion) !== PRESSURE_SCHEMA_VERSION) failPressure('schemaVersion must be 1');
  if (!isBoundedString(input.providerModelId, PRESSURE_BOUNDS.providerModelId, false)) {
    failPressure('providerModelId is required (bounded string)');
  }
  const providerCapability = input.providerCapability === undefined ? null : input.providerCapability;
  if (providerCapability !== null) {
    scanProviderCapability(input.providerModelId, providerCapability);
  }
  const capacitySourceClaim = input.capacitySource === undefined ? null : input.capacitySource;
  if (capacitySourceClaim !== null && CAPACITY_SOURCE_CLAIMS.indexOf(capacitySourceClaim) === -1) {
    failPressure('capacitySource must be a verifiable source claim or null');
  }
  const capacity = input.providerCapacityTokens;
  if (capacity !== null && capacity !== undefined && (!Number.isInteger(capacity) || capacity <= 0 || capacity > PRESSURE_BOUNDS.capacityMax)) {
    failPressure('providerCapacityTokens must be a positive integer within bounds or null');
  }
  const current = input.currentContextTokens;
  if (current !== null && current !== undefined && (!Number.isInteger(current) || current < 0 || current > PRESSURE_BOUNDS.capacityMax)) {
    failPressure('currentContextTokens must be a non-negative integer within bounds or null');
  }
  if (COST_METHODS.indexOf(input.costMethod) === -1) failPressure('costMethod must be a closed-world cost method');
  if (typeof input.costExact !== 'boolean') failPressure('costExact must be boolean');
  if (input.costMethod === 'provider-tokenizer' && input.costExact !== true) {
    failPressure('provider-tokenizer costs must be exact');
  }
  if ((input.costMethod === 'deterministic-estimate' || input.costMethod === 'conservative-estimate') && input.costExact !== false) {
    failPressure('estimated costs must not claim exact');
  }
  if (!isBoundedString(input.taskId, PRESSURE_BOUNDS.taskId, false)) failPressure('taskId is required');
  if (!isBoundedString(input.taskInstanceId, PRESSURE_BOUNDS.taskInstanceId, false)) failPressure('taskInstanceId is required');
  if (!isBoundedString(input.sessionId, PRESSURE_BOUNDS.sessionId, false)) failPressure('sessionId is required');
  if (!Number.isInteger(input.generation) || input.generation < 1) failPressure('generation must be a positive integer');
  if (!isBoundedString(input.snapshotTokenId, PRESSURE_BOUNDS.tokenId, false)) failPressure('snapshotTokenId is required');
  if (typeof input.revisionDigest !== 'string' || !DIGEST_PATTERN.test(input.revisionDigest)) {
    failPressure('revisionDigest must be sha256 hex');
  }
  const reserves = resolveReserves(input.reservedOutputTokens, input.reservedProtocolTokens, input.reservedSafetyTokens);
  return {
    schemaVersion: PRESSURE_SCHEMA_VERSION,
    providerModelId: input.providerModelId,
    providerCapability,
    capacitySourceClaim,
    providerCapacityTokens: capacity === undefined ? null : capacity,
    currentContextTokens: current === undefined ? null : current,
    costMethod: input.costMethod,
    costExact: input.costExact,
    reserves,
    taskId: input.taskId,
    taskInstanceId: input.taskInstanceId,
    sessionId: input.sessionId,
    generation: input.generation,
    snapshotTokenId: input.snapshotTokenId,
    revisionDigest: input.revisionDigest,
  };
}

function sortBlockers(blockers) {
  return blockers.slice().sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

function unknownDecisionBindings(n) {
  return {
    schemaVersion: PRESSURE_SCHEMA_VERSION,
    known: false,
    level: 'UNKNOWN',
    providerModelId: n.providerModelId,
    capacitySource: n.capacitySource,
    providerCapacityTokens: n.providerCapacityTokens,
    currentContextTokens: n.currentContextTokens,
    costMethod: n.costMethod,
    costExact: n.costExact,
    reserves: Object.freeze({ outputTokens: n.reserves.outputTokens, protocolTokens: n.reserves.protocolTokens, safetyTokens: n.reserves.safetyTokens }),
    usableCapacityTokens: null,
    remainingHeadroomTokens: null,
    usedFraction: null,
    thresholdPolicyId: THRESHOLD_POLICY_ID_V1,
    reservePolicyId: RESERVE_POLICY_ID_V1,
    recommendation: 'blocked',
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    generation: n.generation,
    snapshotTokenId: n.snapshotTokenId,
    revisionDigest: n.revisionDigest,
  };
}

// Pure deterministic pressure decision. Never throws for UNKNOWN/over-limit
// states (those are honest decisions); throws only for malformed input.
// Effective capacity resolution (frozen order): declared provider metadata
// wins over any caller-asserted value (same precedence as the PS authority);
// a claimed model-registry value is verified against the registry and refused
// on mismatch; otherwise the registry resolves automatically; nothing
// declares anything yields UNKNOWN. Throws only for malformed input and for
// verifiably false source claims.
function resolveEffectiveCapacity(n) {
  const scanned = scanProviderCapability(n.providerModelId, n.providerCapability);
  if (scanned.declared) {
    return { capacityTokens: scanned.capacityTokens, source: 'provider-models-metadata' };
  }
  if (n.providerCapacityTokens !== null) {
    if (n.capacitySourceClaim === 'model-registry') {
      const registry = loadModelRegistry();
      const entry = registry && Array.isArray(registry.models)
        ? registry.models.find((m) => m && (m.id === n.providerModelId || m.model === n.providerModelId))
        : null;
      if (!entry || !Number.isInteger(entry.contextWindow) || entry.contextWindow !== n.providerCapacityTokens) {
        failPressure('claimed model-registry capacity does not match the registry');
      }
      return { capacityTokens: n.providerCapacityTokens, source: 'model-registry' };
    }
    return { capacityTokens: n.providerCapacityTokens, source: 'caller-asserted' };
  }
  const fallback = resolveProviderCapacity(n.providerModelId, null);
  if (fallback.known) return { capacityTokens: fallback.capacityTokens, source: 'model-registry' };
  return { capacityTokens: null, source: 'unknown' };
}

function measurePressureV2(input) {
  const raw = normalizePressureInput(input);
  const effective = resolveEffectiveCapacity(raw);
  const n = Object.assign({}, raw, { providerCapacityTokens: effective.capacityTokens, capacitySource: effective.source });
  const blockers = [];
  const known = n.providerCapacityTokens !== null && n.currentContextTokens !== null;
  if (n.providerCapacityTokens === null) {
    blockers.push({ code: 'pressure-capacity-unknown', detail: 'provider capacity is unavailable for ' + n.providerModelId });
  }
  if (n.currentContextTokens === null) {
    blockers.push({ code: 'pressure-accounting-invalid', detail: 'current context cost is unavailable' });
  }
  if (!known) {
    const base = unknownDecisionBindings(n);
    return Object.freeze(Object.assign({}, base, { blockers: Object.freeze(sortBlockers(blockers)) }));
  }
  const usable = n.providerCapacityTokens - n.reserves.outputTokens - n.reserves.protocolTokens - n.reserves.safetyTokens;
  if (usable <= 0) {
    blockers.push({ code: 'pressure-accounting-invalid', detail: 'reserves consume the provider window' });
    const base = unknownDecisionBindings(n);
    return Object.freeze(Object.assign({}, base, { blockers: Object.freeze(sortBlockers(blockers)) }));
  }
  const headroom = usable - n.currentContextTokens;
  const usedFraction = n.currentContextTokens / usable;
  const level = levelForUsedFraction(usedFraction);
  const recommendation = recommendationForLevel(level);
  return Object.freeze({
    schemaVersion: PRESSURE_SCHEMA_VERSION,
    known: true,
    level,
    providerModelId: n.providerModelId,
    capacitySource: n.capacitySource,
    providerCapacityTokens: n.providerCapacityTokens,
    currentContextTokens: n.currentContextTokens,
    costMethod: n.costMethod,
    costExact: n.costExact,
    reserves: Object.freeze({ outputTokens: n.reserves.outputTokens, protocolTokens: n.reserves.protocolTokens, safetyTokens: n.reserves.safetyTokens }),
    usableCapacityTokens: usable,
    remainingHeadroomTokens: headroom,
    usedFraction,
    thresholdPolicyId: THRESHOLD_POLICY_ID_V1,
    reservePolicyId: RESERVE_POLICY_ID_V1,
    recommendation,
    blockers: Object.freeze(sortBlockers(blockers)),
    taskId: n.taskId,
    taskInstanceId: n.taskInstanceId,
    sessionId: n.sessionId,
    generation: n.generation,
    snapshotTokenId: n.snapshotTokenId,
    revisionDigest: n.revisionDigest,
  });
}

function validatePressureDecision(decision) {
  const fail = (reason) => ({ valid: false, reason });
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return fail('pressure-decision-missing');
  const unknown = unknownKeyOf(decision, PRESSURE_DECISION_EXACT_KEYS);
  if (unknown !== null) return fail('pressure-unknown-field');
  if (Number(decision.schemaVersion) !== PRESSURE_SCHEMA_VERSION) return fail('pressure-schema-mismatch');
  if (typeof decision.known !== 'boolean') return fail('pressure-known-mismatch');
  if (PRESSURE_LEVELS.indexOf(decision.level) === -1) return fail('pressure-level-unknown');
  if (PRESSURE_RECOMMENDATIONS.indexOf(decision.recommendation) === -1) return fail('pressure-recommendation-unknown');
  if (decision.thresholdPolicyId !== THRESHOLD_POLICY_ID_V1) return fail('pressure-threshold-policy-mismatch');
  if (decision.reservePolicyId !== RESERVE_POLICY_ID_V1) return fail('pressure-reserve-policy-mismatch');
  if (!decision.reserves || typeof decision.reserves !== 'object') return fail('pressure-reserves-missing');
  if (unknownKeyOf(decision.reserves, PRESSURE_RESERVES_EXACT_KEYS) !== null) return fail('pressure-reserves-unknown-field');
  for (const key of PRESSURE_RESERVES_EXACT_KEYS) {
    if (!Number.isInteger(decision.reserves[key]) || decision.reserves[key] < 0) return fail('pressure-reserve-invalid');
  }
  if (!Array.isArray(decision.blockers)) return fail('pressure-blockers-missing');
  for (const b of decision.blockers) {
    if (!b || typeof b !== 'object') return fail('pressure-blocker-malformed');
    if (unknownKeyOf(b, PRESSURE_BLOCKER_EXACT_KEYS) !== null) return fail('pressure-blocker-unknown-field');
    if (PRESSURE_BLOCKER_CODES.indexOf(b.code) === -1) return fail('pressure-blocker-unknown');
    if (typeof b.detail !== 'string' || b.detail === '' || b.detail.length > PRESSURE_BOUNDS.detail) {
      return fail('pressure-blocker-detail-invalid');
    }
  }
  if (CAPACITY_SOURCES.indexOf(decision.capacitySource) === -1) return fail('pressure-capacity-source-unknown');
  if (decision.providerCapacityTokens === null) {
    if (decision.capacitySource !== 'unknown') return fail('pressure-capacity-source-mismatch');
  } else if (decision.capacitySource === 'unknown') {
    return fail('pressure-capacity-source-mismatch');
  }
  if (decision.known === false) {
    if (decision.level !== 'UNKNOWN') return fail('pressure-unknown-level-mismatch');
    if (decision.recommendation !== 'blocked') return fail('pressure-unknown-recommendation-mismatch');
    if (decision.usableCapacityTokens !== null || decision.remainingHeadroomTokens !== null || decision.usedFraction !== null) {
      return fail('pressure-unknown-must-not-claim-tokens');
    }
  } else {
    if (decision.level === 'UNKNOWN') return fail('pressure-known-level-mismatch');
    if (!Number.isInteger(decision.providerCapacityTokens) || !Number.isInteger(decision.currentContextTokens)) {
      return fail('pressure-tokens-missing');
    }
    if (!Number.isInteger(decision.usableCapacityTokens) || !Number.isInteger(decision.remainingHeadroomTokens)) {
      return fail('pressure-tokens-missing');
    }
    const expectUsable = decision.providerCapacityTokens - decision.reserves.outputTokens - decision.reserves.protocolTokens - decision.reserves.safetyTokens;
    if (decision.usableCapacityTokens !== expectUsable) return fail('pressure-usable-mismatch');
    if (decision.remainingHeadroomTokens !== expectUsable - decision.currentContextTokens) return fail('pressure-headroom-mismatch');
    if (typeof decision.usedFraction !== 'number' || !(decision.usedFraction >= 0)) return fail('pressure-fraction-missing');
    if (decision.level !== levelForUsedFraction(decision.usedFraction)) return fail('pressure-level-threshold-mismatch');
    if (decision.recommendation !== recommendationForLevel(decision.level)) return fail('pressure-recommendation-mismatch');
  }
  return { valid: true, reason: null };
}

function derivePressureDecisionDigest(decision) {
  const check = validatePressureDecision(decision);
  if (!check.valid) failPressure('cannot digest invalid decision (' + check.reason + ')');
  return sha256HexUtf8(PRESSURE_DECISION_DIGEST_DOMAIN_V1 + LF_JOIN + serializeCanonical(decision));
}

// Frozen pressure-basis identity (H3): one deterministic digest over every
// pressure-policy assumption a persisted plan stays actionable under. Any
// change (route, capacity, source, policy ids, reserves, cost honesty)
// changes the basis and makes old plans stale. No timestamps.
//   pressureBasisDigest = SHA256(UTF8('nexus/context-pressure-basis/v1'
//                         LF canonicalJson(basisBody)))
function pressureBasisBodyOf(decision) {
  const check = validatePressureDecision(decision);
  if (!check.valid) failPressure('cannot derive basis of invalid decision (' + check.reason + ')');
  return {
    thresholdPolicyId: decision.thresholdPolicyId,
    reservePolicyId: decision.reservePolicyId,
    reserves: { outputTokens: decision.reserves.outputTokens, protocolTokens: decision.reserves.protocolTokens, safetyTokens: decision.reserves.safetyTokens },
    providerModelId: decision.providerModelId,
    providerCapacityTokens: decision.providerCapacityTokens,
    capacitySource: decision.capacitySource,
    costMethod: decision.costMethod,
    costExact: decision.costExact,
  };
}

function derivePressureBasisDigest(decision) {
  return sha256HexUtf8(PRESSURE_BASIS_DIGEST_DOMAIN_V1 + LF_JOIN + serializeCanonical(pressureBasisBodyOf(decision)));
}

// Bounded shadow-ready telemetry: counts/ids/levels only, never raw text.
function pressureTelemetry(decision) {
  const check = validatePressureDecision(decision);
  if (!check.valid) failPressure('cannot telemeter invalid decision (' + check.reason + ')');
  return Object.freeze({
    schemaVersion: 1,
    known: decision.known,
    pressureLevel: decision.level,
    currentContextTokens: decision.currentContextTokens,
    usableCapacityTokens: decision.usableCapacityTokens,
    headroomTokens: decision.remainingHeadroomTokens,
    recommendation: decision.recommendation,
    blockerCodes: Object.freeze(decision.blockers.map((b) => b.code).slice().sort()),
    thresholdPolicyId: decision.thresholdPolicyId,
    capacitySource: decision.capacitySource,
    costExact: decision.costExact,
  });
}

module.exports = {
  PRESSURE_SCHEMA_VERSION,
  THRESHOLD_POLICY_ID_V1,
  RESERVE_POLICY_ID_V1,
  PRESSURE_BASIS_DIGEST_DOMAIN_V1,
  CAPACITY_SOURCES,
  PROVIDER_CAPACITY_FIELDS,
  PROVIDER_OUTPUT_FIELDS,
  THRESHOLD_POLICY_V1,
  DEFAULT_RESERVES_V1,
  PRESSURE_LEVELS,
  PRESSURE_RECOMMENDATIONS,
  PRESSURE_BLOCKER_CODES,
  COST_METHODS,
  PRESSURE_INPUT_EXACT_KEYS,
  PRESSURE_DECISION_EXACT_KEYS,
  PRESSURE_BOUNDS,
  sha256HexUtf8,
  byteLengthUtf8,
  canonicalize,
  serializeCanonical,
  estimateTokensForUtf8Bytes,
  estimateTokensForText,
  estimateTokensForEvents,
  loadModelRegistry,
  scanProviderCapability,
  resolveProviderCapacity,
  resolveReserves,
  levelForUsedFraction,
  recommendationForLevel,
  normalizePressureInput,
  measurePressureV2,
  validatePressureDecision,
  derivePressureDecisionDigest,
  pressureBasisBodyOf,
  derivePressureBasisDigest,
  pressureTelemetry,
};
