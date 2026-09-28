'use strict';
/**
 * ContextCompressionLadderV2.cjs - CCV2-C05 Deterministic Compression Ladder.
 *
 * ONE authority for deriving least-lossy deterministic model-facing
 * representations of optional context under a fixed token budget:
 *
 *   EXACT -> EXTRACTIVE -> STRUCTURED -> REFERENCE
 *
 * C05 changes what the model sees. It MUST NOT change what Nexus
 * remembers: durable ContextPage / EvidenceRef / Evidence Store /
 * Checkpoint / MemoryTierDecision / transcript state is never mutated
 * here (read-only inputs, new ephemeral outputs only).
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (section 36, C05 freeze record). The frozen C04 budget semantics are
 * consumed verbatim and never reinterpreted:
 *
 *   target  = preferred model-facing materialization target
 *   hardMax = absolute logical-context ceiling
 *   target <= hardMax, used <= hardMax
 *
 * Mandatory material may exceed target but never hardMax. Optional
 * material may exceed neither. C04 remains the SOLE budget/packing
 * authority: C05 derives smaller candidate representations, recounts
 * them through the frozen C04 token counter, and re-runs the SAME C04
 * packing policy. C05 implements no second packer and copies no greedy
 * selection: every fit decision comes from packContextBudgetV2.
 *
 * Determinism: identical (view, pages, budget, tokenizer, policy
 * revision) inputs produce byte-identical representations, hashes,
 * packing results, view ids/digests, and plan digests across repeat
 * runs, fresh processes, and restarts. No clock, no randomness, no PID,
 * no mtime. Out of scope on purpose (future Phase-D D06 lane, removable
 * without affecting this baseline): embedding-based selection, learned
 * token selection, semantic scoring, reranking, LLM summarization,
 * abstractive generation, and any probabilistic/confidence-weighted
 * choice. Policy reads typed metadata only, never evidence prose, so
 * prompt-injected instructions in content have zero effect.
 */
const checkpointV2 = require('./ContextCheckpointV2.cjs');
const pageV2 = require('./ContextPageV2.cjs');
const tierV2 = require('./ContextMemoryTierV2.cjs');
const viewV2 = require('./ContextViewV2.cjs');
const allocatorV2 = require('./ContextBudgetAllocatorV2.cjs');
const counterV2 = require('./ContextTokenCounterV2.cjs');

const COMPRESSION_SCHEMA_VERSION = 1;
const COMPRESSION_POLICY_REVISION_V1 = 'context-compression-ladder-v1';
const COMPRESSION_PLAN_DIGEST_DOMAIN_V1 = 'nexus/context-compression-plan/v1';
const STRUCTURED_REPRESENTATION_DOMAIN_V1 = 'nexus/context-structured-representation/v1';

// Materialized representation rungs derived by C05. REFERENCE is a C04
// packing disposition for COLD (frozen referencedColdPages semantics),
// not a C05-derived materialized text, so it is not a kind here.
const REPRESENTATION_KINDS = Object.freeze(['EXACT', 'EXTRACTIVE', 'STRUCTURED']);

// Page-backed source types: the entry represents a durable ContextPage
// (mirrors the frozen C01 partition; C05 never redefines it).
const PAGE_BACKED_SOURCES = Object.freeze(['context-page', 'rehydrated-evidence']);

// B04 subject kinds claiming a balanced tool-protocol transaction
// (mirrors the frozen C01 taxonomy; C05 never redefines it).
const TOOL_PROTOCOL_SUBJECTS = Object.freeze(['open-tool-protocol', 'completed-tool-transaction']);

// Structured-text safety bound: a STRUCTURED projection must remain a
// C01-valid materialized text (frozen VIEW exactTextMaxChars, in chars).
const STRUCTURED_TEXT_MAX_CHARS = 8192;

const COMPRESSION_BOUNDS = Object.freeze({
  hardMaxMin: 1,
  hardMaxMax: 10000000,
  planSourcesMax: 1024,
});

const COMPRESSION_REASON_CODES = Object.freeze([
  'compression-exact-fits',
  'compression-exact-mandatory',
  'compression-exact-pinned',
  'compression-exact-current-turn',
  'compression-exact-tool-protocol',
  'compression-exact-state-backed',
  'compression-exact-hot-conservative',
  'compression-extractive-budget',
  'compression-structured-budget',
  'compression-extractive-unavailable',
  'compression-structured-unavailable',
  'compression-structured-too-large',
  'compression-reference-accepted',
  'compression-omitted',
]);

const COMPRESSION_FAILURE_MANDATORY_OVER_BUDGET = 'compiler-mandatory-over-budget';

const COMPRESSION_PLAN_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'compressionPolicyRevision', 'tokenizerFingerprint',
  'hardMax', 'target', 'deterministic', 'sources', 'planDigest',
]);

const COMPRESSION_SOURCE_EXACT_KEYS = Object.freeze([
  'sourceId', 'sourcePageId', 'sourceContentHash', 'section', 'tier',
  'originalKind', 'originalTokens', 'originalContentHash',
  'selectedKind', 'representationHash', 'selectedTokens',
  'transitions', 'finalDisposition', 'reasonCode',
]);

const COMPRESSION_TRANSITION_EXACT_KEYS = Object.freeze([
  'from', 'to', 'reasonCode', 'deterministic',
]);

const COMPRESSION_FINAL_DISPOSITIONS = Object.freeze(['KEPT', 'REFERENCE', 'OMIT']);

function failCompression(code, detail) {
  throw new Error('context-compression-' + code + (detail === undefined ? '' : ': ' + detail) + ' (DISCARDABLE)');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownKeyOf(value, allowedKeys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) return key;
  }
  return null;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freezeDeep(value) {
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry);
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    return Object.freeze(value);
  }
  return value;
}

function sha256HexUtf8(text) {
  return checkpointV2.sha256HexUtf8(String(text));
}

function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}

function namespaceTripleOf(namespace) {
  return {
    taskId: namespace.taskId,
    taskInstanceId: namespace.taskInstanceId,
    sessionId: namespace.sessionId,
  };
}

function tripleMatches(expected, triple) {
  if (!isPlainObject(triple)) return false;
  return triple.taskId === expected.taskId
    && triple.taskInstanceId === expected.taskInstanceId
    && triple.sessionId === expected.sessionId;
}

// ---- input validation (fail closed, no partial output) ----

function validateCompressionPolicyRevision(revision) {
  const effective = revision === undefined || revision === null
    ? COMPRESSION_POLICY_REVISION_V1
    : revision;
  if (effective !== COMPRESSION_POLICY_REVISION_V1) {
    failCompression('context-compression-policy-unknown', 'compression policy ' + String(effective).slice(0, 64) + ' is unknown');
  }
  return effective;
}

function validateCompressionBudget(budget) {
  if (!isPlainObject(budget)) failCompression('context-compression-budget-invalid', 'budget must be an object');
  if (unknownKeyOf(budget, ['hardMax', 'target']) !== null) {
    failCompression('context-compression-budget-invalid', 'budget carries unknown keys');
  }
  if (!Number.isInteger(budget.hardMax)
    || budget.hardMax < COMPRESSION_BOUNDS.hardMaxMin
    || budget.hardMax > COMPRESSION_BOUNDS.hardMaxMax) {
    failCompression('context-compression-budget-invalid', 'budget.hardMax is invalid');
  }
  if (!Number.isInteger(budget.target) || budget.target < 0 || budget.target > budget.hardMax) {
    failCompression('context-compression-budget-invalid', 'budget.target must satisfy 0 <= target <= hardMax');
  }
  return { hardMax: budget.hardMax, target: budget.target };
}

function requireCounter(counter) {
  const check = counterV2.validateContextTokenCounterV2(counter);
  if (!check.valid) failCompression('context-compression-tokenizer-unavailable', 'certified compression requires a valid token-counting authority');
  return check.fingerprint;
}

function validateSourcePages(pages) {
  if (!Array.isArray(pages)) failCompression('context-compression-source-invalid', 'pages must be an explicit array');
  const byId = new Map();
  for (const page of pages) {
    const check = pageV2.validateContextPageV2(page);
    if (!check.valid) {
      failCompression('context-compression-source-invalid', 'page failed validation: ' + String(check.reasonCode || check.reason).slice(0, 160));
    }
    if (byId.has(page.id)) failCompression('context-compression-source-invalid', 'duplicate page identity');
    byId.set(page.id, page);
  }
  return byId;
}

// ---- eligibility (typed metadata only; evidence prose never read) ----

/**
 * Determine the representation ladder for one materialized entry.
 * Returns { eligible, ladder, exactOnlyReason }: eligible entries walk
 * [EXACT, EXTRACTIVE, STRUCTURED] (COLD additionally falls back to the
 * frozen C04 REFERENCE disposition); ineligible entries are EXACT-only
 * with a stable reason code. Throws closed-world on integrity failures
 * (unknown tier, already-compressed input, source binding mismatch):
 * no partial view is ever emitted.
 */
function representationEligibilityV2(input) {
  if (!isPlainObject(input)) failCompression('context-compression-input-invalid', 'eligibility input must be an object');
  if (unknownKeyOf(input, ['entry', 'section', 'page']) !== null) {
    failCompression('context-compression-input-invalid', 'eligibility carries unknown keys');
  }
  const entry = input.entry;
  const section = input.section;
  const page = input.page === undefined ? null : input.page;
  if (!isPlainObject(entry)) failCompression('context-compression-input-invalid', 'entry must be an object');
  if (typeof section !== 'string' || !viewV2.VIEW_SECTIONS.includes(section)) {
    failCompression('context-compression-input-invalid', 'section is unknown');
  }
  if (!viewV2.MATERIAL_TIERS.includes(entry.tier)) {
    failCompression('context-compression-tier-unknown', 'tier ' + String(entry.tier).slice(0, 64) + ' is unknown');
  }
  if (typeof entry.mandatory !== 'boolean') failCompression('context-compression-input-invalid', 'entry.mandatory must be boolean');
  if (typeof entry.sourceType !== 'string') failCompression('context-compression-input-invalid', 'entry.sourceType is required');
  if (typeof entry.sourceId !== 'string' || entry.sourceId === '') {
    failCompression('context-compression-input-invalid', 'entry.sourceId is required');
  }
  if (entry.representation !== null && entry.representation !== undefined) {
    failCompression('context-compression-already-compressed', 'C05 consumes exact candidate sets only');
  }
  const exactOnly = (reason) => ({ eligible: false, ladder: ['EXACT'], exactOnlyReason: reason });
  // Mandatory truth is outside the lossy ladder, always.
  if (entry.mandatory === true) return exactOnly('compression-exact-mandatory');
  // PINNED correctness state is EXACT-only.
  if (entry.tier === 'PINNED') return exactOnly('compression-exact-pinned');
  // The exact current user turn survives untouched.
  if (entry.sourceType === 'current-turn') return exactOnly('compression-exact-current-turn');
  // Balanced tool protocol stays exact: neither half of a transaction is
  // ever projected alone, and settled tool pages stay exact by the same
  // conservative rule (kind-checked below once the page binds).
  const unit = entry.toolTransaction === undefined ? null : entry.toolTransaction;
  if (unit !== null) return exactOnly('compression-exact-tool-protocol');
  if (isPlainObject(entry.tierDecision)
    && typeof entry.tierDecision.subjectKind === 'string'
    && TOOL_PROTOCOL_SUBJECTS.includes(entry.tierDecision.subjectKind)) {
    return exactOnly('compression-exact-tool-protocol');
  }
  // Authoritative structured state renders are already minimal typed
  // truth; no extract authority exists for them.
  if (!PAGE_BACKED_SOURCES.includes(entry.sourceType)) {
    return exactOnly('compression-exact-state-backed');
  }
  // Conservative tier policy: optional HOT stays EXACT by default.
  if (entry.tier === 'HOT') return exactOnly('compression-exact-hot-conservative');
  // Page-backed optional WARM/COLD: bind the source page before any lossy
  // rung is allowed, so derivation below can prove source linkage.
  if (page === null || !isPlainObject(page)) {
    failCompression('context-compression-source-missing', 'page-backed entry without a bound source page: ' + entry.sourceId.slice(0, 64));
  }
  if (page.id !== entry.sourceId) {
    failCompression('context-compression-source-mismatch', 'page/entry identity mismatch');
  }
  if (page.contentHash !== entry.contentHash) {
    failCompression('context-compression-source-mismatch', 'page/entry source hash mismatch');
  }
  if (!tripleMatches(namespaceTripleOf(page.namespace), namespaceTripleOf(entry.tierDecision && entry.tierDecision.namespace
    ? entry.tierDecision.namespace : page.namespace))) {
    failCompression('context-compression-source-mismatch', 'tier decision escapes the page namespace');
  }
  // Settled tool-result pages keep balanced exact semantics even as
  // history: their prose jointly narrates a call and its result.
  if (page.kind === 'tool-result') return exactOnly('compression-exact-tool-protocol');
  if (entry.tier === 'WARM') return { eligible: true, ladder: ['EXACT', 'EXTRACTIVE', 'STRUCTURED'], exactOnlyReason: null };
  if (entry.tier === 'COLD') return { eligible: true, ladder: ['EXACT', 'EXTRACTIVE', 'STRUCTURED'], exactOnlyReason: null };
  failCompression('context-compression-tier-unknown', 'tier ' + String(entry.tier).slice(0, 64) + ' admits no ladder');
  return exactOnly('compression-exact-state-backed');
}

// ---- rung derivation (provenance-preserving, deterministic) ----

/**
 * Derive the EXTRACTIVE text for one bound source page. Uses ONLY the
 * frozen B01 extract authority (a bounded source-exact substring proven
 * by exactText.includes at page validation). Returns
 * { available, text, reason }: unavailable is never guessed.
 */
function deriveExtractiveTextV2(input) {
  if (!isPlainObject(input)) failCompression('context-compression-input-invalid', 'extract input must be an object');
  if (unknownKeyOf(input, ['page', 'entryText']) !== null) {
    failCompression('context-compression-input-invalid', 'extract input carries unknown keys');
  }
  const page = input.page;
  const entryText = input.entryText;
  if (!isPlainObject(page)) failCompression('context-compression-input-invalid', 'page is required');
  if (entryText === undefined) failCompression('context-compression-input-invalid', 'entryText is required');
  if (typeof entryText !== 'string' || entryText === '') {
    return { available: false, text: null, reason: 'compression-extractive-unavailable' };
  }
  const extract = page.extract === undefined ? null : page.extract;
  if (typeof extract !== 'string' || extract === '') {
    return { available: false, text: null, reason: 'compression-extractive-unavailable' };
  }
  // Source linkage must hold against the exact bytes about to be
  // replaced: the B01 page proof covers page.exactText, and this second
  // containment covers the live model-facing bytes. Either side failing
  // means EXTRACTIVE is unavailable, not approximated.
  if (!entryText.includes(extract)) {
    return { available: false, text: null, reason: 'compression-extractive-unavailable' };
  }
  if (sha256HexUtf8(extract) === page.contentHash) {
    // Degenerate: the extract IS the whole source (hash-equal). Walking
    // to it would launder EXACT bytes as EXTRACTIVE; stay EXACT.
    return { available: false, text: null, reason: 'compression-extractive-unavailable' };
  }
  return { available: true, text: extract, reason: null };
}

/**
 * Derive the STRUCTURED text for one bound source page. A deterministic
 * canonical serialization of validated typed/source-bound fields only:
 * identity, kind, source binding, typed metadata arrays, bounded exact
 * extract, typed provenance, and the exact rehydration reference that
 * keeps the backing recoverable. semanticGloss NEVER participates (it is
 * advisory and must not become the sole surviving representation); no
 * fact is inferred from prose. Returns { available, text, reason }.
 */
function deriveStructuredTextV2(input) {
  if (!isPlainObject(input)) failCompression('context-compression-input-invalid', 'structured input must be an object');
  if (unknownKeyOf(input, ['page', 'viewNamespace']) !== null) {
    failCompression('context-compression-input-invalid', 'structured input carries unknown keys');
  }
  const page = input.page;
  const viewNamespace = input.viewNamespace;
  if (!isPlainObject(page)) failCompression('context-compression-input-invalid', 'page is required');
  if (!isPlainObject(viewNamespace)) failCompression('context-compression-input-invalid', 'viewNamespace is required');
  const record = {
    domain: STRUCTURED_REPRESENTATION_DOMAIN_V1,
    pageId: page.id,
    kind: page.kind,
    sourceContentHash: page.contentHash,
    sourceBinding: page.sourceBinding === undefined ? null : page.sourceBinding,
    sourceSeqs: page.sourceSeqs === undefined ? [] : page.sourceSeqs,
    files: page.files === undefined ? [] : page.files,
    symbols: page.symbols === undefined ? [] : page.symbols,
    entities: page.entities === undefined ? [] : page.entities,
    tags: page.tags === undefined ? [] : page.tags,
    extract: page.extract === undefined ? null : page.extract,
    provenance: {
      sourceKind: page.provenance.sourceKind,
      trust: page.provenance.trust,
      fieldKind: page.provenance.fieldKind,
    },
    rehydration: {
      pageId: page.id,
      contentHash: page.contentHash,
      namespace: namespaceTripleOf(page.namespace),
    },
  };
  let text = null;
  try {
    text = canonicalJsonOf(record);
  } catch (error) {
    return { available: false, text: null, reason: 'compression-structured-unavailable' };
  }
  if (typeof text !== 'string' || text === '') {
    return { available: false, text: null, reason: 'compression-structured-unavailable' };
  }
  // A structured form that cannot be materialized exactly (over the C01
  // text bound) is unavailable: budget pressure never creates license to
  // clip typed fields.
  if (text.length > STRUCTURED_TEXT_MAX_CHARS) {
    return { available: false, text: null, reason: 'compression-structured-too-large' };
  }
  if (sha256HexUtf8(text) === page.contentHash) {
    return { available: false, text: null, reason: 'compression-structured-unavailable' };
  }
  return { available: true, text, reason: null };
}

// ---- compression plan digest + validation (observability only) ----

function planWithoutDigest(plan) {
  const copy = {};
  for (const key of Object.keys(plan)) {
    if (key === 'planDigest') continue;
    copy[key] = plan[key];
  }
  return copy;
}

function deriveCompressionPlanDigestV2(plan) {
  return sha256HexUtf8(
    COMPRESSION_PLAN_DIGEST_DOMAIN_V1 + '\n' + canonicalJsonOf(planWithoutDigest(plan)),
  );
}

function validateCompressionPlanV2(plan, options) {
  const fail = (reason) => ({ valid: false, reason });
  if (!isPlainObject(plan)) return fail('context-compression-plan-invalid');
  if (unknownKeyOf(plan, COMPRESSION_PLAN_EXACT_KEYS) !== null) return fail('context-compression-plan-invalid');
  if (plan.schemaVersion !== COMPRESSION_SCHEMA_VERSION) return fail('context-compression-plan-invalid');
  if (plan.compressionPolicyRevision !== COMPRESSION_POLICY_REVISION_V1) {
    return fail('context-compression-plan-invalid');
  }
  if (typeof plan.tokenizerFingerprint !== 'string' || plan.tokenizerFingerprint === '') {
    return fail('context-compression-plan-invalid');
  }
  if (!Number.isInteger(plan.hardMax) || plan.hardMax < COMPRESSION_BOUNDS.hardMaxMin
    || plan.hardMax > COMPRESSION_BOUNDS.hardMaxMax) return fail('context-compression-plan-invalid');
  if (!Number.isInteger(plan.target) || plan.target < 0 || plan.target > plan.hardMax) {
    return fail('context-compression-plan-invalid');
  }
  if (plan.deterministic !== true) return fail('context-compression-plan-invalid');
  if (!Array.isArray(plan.sources) || plan.sources.length > COMPRESSION_BOUNDS.planSourcesMax) {
    return fail('context-compression-plan-invalid');
  }
  const seenSources = new Set();
  for (const source of plan.sources) {
    if (!isPlainObject(source)) return fail('context-compression-plan-invalid');
    if (unknownKeyOf(source, COMPRESSION_SOURCE_EXACT_KEYS) !== null) return fail('context-compression-plan-invalid');
    if (typeof source.sourceId !== 'string' || source.sourceId === '') return fail('context-compression-plan-invalid');
    if (seenSources.has(source.sourceId)) return fail('context-compression-plan-invalid');
    seenSources.add(source.sourceId);
    if (typeof source.sourcePageId !== 'string' || source.sourcePageId === '') return fail('context-compression-plan-invalid');
    if (typeof source.sourceContentHash !== 'string' || !/^[0-9a-f]{64}$/.test(source.sourceContentHash)) {
      return fail('context-compression-plan-invalid');
    }
    if (typeof source.section !== 'string' || !viewV2.VIEW_SECTIONS.includes(source.section)) {
      return fail('context-compression-plan-invalid');
    }
    if (!viewV2.MATERIAL_TIERS.includes(source.tier)) return fail('context-compression-plan-invalid');
    if (source.originalKind !== 'EXACT' || !REPRESENTATION_KINDS.includes(source.selectedKind)) {
      return fail('context-compression-plan-invalid');
    }
    if (!Number.isInteger(source.originalTokens) || source.originalTokens < 0) return fail('context-compression-plan-invalid');
    if (typeof source.originalContentHash !== 'string' || !/^[0-9a-f]{64}$/.test(source.originalContentHash)) {
      return fail('context-compression-plan-invalid');
    }
    if (typeof source.representationHash !== 'string' || !/^[0-9a-f]{64}$/.test(source.representationHash)) {
      return fail('context-compression-plan-invalid');
    }
    if (source.selectedTokens !== null
      && (!Number.isInteger(source.selectedTokens) || source.selectedTokens < 0)) {
      return fail('context-compression-plan-invalid');
    }
    if (!COMPRESSION_FINAL_DISPOSITIONS.includes(source.finalDisposition)) return fail('context-compression-plan-invalid');
    if (typeof source.reasonCode !== 'string' || !COMPRESSION_REASON_CODES.includes(source.reasonCode)) {
      return fail('context-compression-plan-invalid');
    }
    if (!Array.isArray(source.transitions)) return fail('context-compression-plan-invalid');
    let previous = 'EXACT';
    for (const transition of source.transitions) {
      if (!isPlainObject(transition)) return fail('context-compression-plan-invalid');
      if (unknownKeyOf(transition, COMPRESSION_TRANSITION_EXACT_KEYS) !== null) {
        return fail('context-compression-plan-invalid');
      }
      if (transition.from !== previous) return fail('context-compression-plan-invalid');
      // Monotonic ladder: transitions only move toward less
      // information-rich rungs, never back, never skipping backward.
      const fromIndex = REPRESENTATION_KINDS.indexOf(transition.from);
      const toIndex = REPRESENTATION_KINDS.indexOf(transition.to);
      if (fromIndex === -1 || toIndex === -1 || toIndex <= fromIndex) return fail('context-compression-plan-invalid');
      if (typeof transition.reasonCode !== 'string'
        || !COMPRESSION_REASON_CODES.includes(transition.reasonCode)) {
        return fail('context-compression-plan-invalid');
      }
      if (transition.deterministic !== true) return fail('context-compression-plan-invalid');
      previous = transition.to;
    }
    if (previous !== source.selectedKind) return fail('context-compression-plan-invalid');
    // A lossy selection must actually change the bytes (anti-laundering:
    // same hash with a lossy kind is rejected, mirroring C01).
    if (source.selectedKind !== 'EXACT'
      && source.representationHash === source.sourceContentHash) {
      return fail('context-compression-plan-invalid');
    }
    if (source.selectedKind === 'EXACT'
      && (source.representationHash !== source.sourceContentHash
        || source.originalContentHash !== source.sourceContentHash)) {
      return fail('context-compression-plan-invalid');
    }
    if (source.finalDisposition === 'KEPT' && source.selectedTokens === null) {
      return fail('context-compression-plan-invalid');
    }
    if (source.finalDisposition !== 'KEPT' && source.selectedTokens !== null) {
      return fail('context-compression-plan-invalid');
    }
  }
  if (typeof plan.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(plan.planDigest)) {
    return fail('context-compression-plan-invalid');
  }
  if (isPlainObject(options) && options !== null) {
    if (options.expectedFingerprint !== undefined && options.expectedFingerprint !== null
      && plan.tokenizerFingerprint !== options.expectedFingerprint) {
      return fail('context-compression-plan-binding-mismatch');
    }
    if (options.expectedPolicyRevision !== undefined && options.expectedPolicyRevision !== null
      && plan.compressionPolicyRevision !== options.expectedPolicyRevision) {
      return fail('context-compression-plan-binding-mismatch');
    }
  }
  let recomputed = null;
  try {
    recomputed = deriveCompressionPlanDigestV2(plan);
  } catch (error) {
    return fail('context-compression-plan-invalid');
  }
  if (recomputed !== plan.planDigest) return fail('context-compression-plan-digest-mismatch');
  return { valid: true, reason: null };
}

/**
 * Describe a validated plan for telemetry: bounded arithmetic and
 * identity prefixes only, never representation text.
 */
function describeCompressionPlanV2(plan) {
  const check = validateCompressionPlanV2(plan);
  if (!check.valid) failCompression('context-compression-plan-invalid', String(check.reason));
  let exactCount = 0;
  let extractiveCount = 0;
  let structuredCount = 0;
  let keptCount = 0;
  let referencedCount = 0;
  let omittedCount = 0;
  let originalTokens = 0;
  let selectedTokens = 0;
  for (const source of plan.sources) {
    if (source.selectedKind === 'EXACT') exactCount += 1;
    else if (source.selectedKind === 'EXTRACTIVE') extractiveCount += 1;
    else structuredCount += 1;
    if (source.finalDisposition === 'KEPT') keptCount += 1;
    else if (source.finalDisposition === 'REFERENCE') referencedCount += 1;
    else omittedCount += 1;
    originalTokens += source.originalTokens;
    if (source.selectedTokens !== null) selectedTokens += source.selectedTokens;
  }
  return Object.freeze({
    planDigestPrefix: String(plan.planDigest).slice(0, 16),
    compressionPolicyRevision: plan.compressionPolicyRevision,
    tokenizerFingerprint: plan.tokenizerFingerprint,
    hardMax: plan.hardMax,
    target: plan.target,
    sourceCount: plan.sources.length,
    exactCount,
    extractiveCount,
    structuredCount,
    keptCount,
    referencedCount,
    omittedCount,
    originalTokens,
    selectedTokens,
    deterministic: true,
  });
}

// ---- main compilation: exact candidates -> ladder -> C04 pack ----

function enumerateViewEntries(view) {
  const entries = [];
  let orderIndex = 0;
  for (const section of viewV2.VIEW_SECTIONS) {
    for (const entry of view[section]) {
      entries.push({ section, entry, orderIndex });
      orderIndex += 1;
    }
  }
  return entries;
}

function rawEntryForRung(original, rung, derivedText, sourceHash) {
  if (rung === 0) {
    return {
      tier: deepClone(original.tier),
      sourceType: deepClone(original.sourceType),
      sourceId: deepClone(original.sourceId),
      contentHash: deepClone(original.contentHash),
      provenance: deepClone(original.provenance),
      mediaType: deepClone(original.mediaType),
      exactText: deepClone(original.exactText),
      mandatory: original.mandatory,
      tierDecision: deepClone(original.tierDecision),
      evidence: original.evidence === null || original.evidence === undefined
        ? null : deepClone(original.evidence),
      toolTransaction: original.toolTransaction === null || original.toolTransaction === undefined
        ? null : deepClone(original.toolTransaction),
    };
  }
  const kind = rung === 1 ? 'EXTRACTIVE' : 'STRUCTURED';
  const representationHash = sha256HexUtf8(derivedText);
  return {
    tier: deepClone(original.tier),
    sourceType: deepClone(original.sourceType),
    sourceId: deepClone(original.sourceId),
    contentHash: representationHash,
    provenance: deepClone(original.provenance),
    mediaType: 'text',
    exactText: derivedText,
    mandatory: false,
    tierDecision: deepClone(original.tierDecision),
    evidence: original.evidence === null || original.evidence === undefined
      ? null : deepClone(original.evidence),
    toolTransaction: null,
    representation: {
      kind,
      sourcePageId: deepClone(original.sourceId),
      sourceContentHash: sourceHash,
      representationHash,
    },
  };
}

/**
 * Compress an exact C01 candidate view under a usable budget.
 *
 * Inputs (all read-only, never mutated): a C01-valid exact view, the
 * bound source pages, the usable budget {hardMax, target}, and a valid
 * token-counting authority. Output: { compressedView, compressionPlan,
 * packingPlan, packingCosts } where compressedView is the FINAL C04
 * packed view (C04 remains the sole packing authority) and the
 * compression plan is disposable observability (never authority).
 *
 * Fail-closed (no partial view): mandatory truth above hardMax, unknown
 * policy/tokenizer, source binding mismatch, or derivation defect.
 */
function compressContextViewV2(input) {
  if (!isPlainObject(input)) failCompression('context-compression-input-invalid', 'input must be an object');
  if (unknownKeyOf(input, ['view', 'pages', 'budget', 'counter', 'compressionPolicyRevision']) !== null) {
    failCompression('context-compression-input-invalid', 'input carries unknown keys');
  }
  const policyRevision = validateCompressionPolicyRevision(input.compressionPolicyRevision);
  const budget = validateCompressionBudget(input.budget);
  const fingerprint = requireCounter(input.counter);
  const counter = input.counter;
  if (!isPlainObject(input.view)) failCompression('context-compression-view-invalid', 'view is required');
  const viewCheck = viewV2.validateContextViewV2(input.view);
  if (!viewCheck.valid) failCompression('context-compression-view-invalid', String(viewCheck.reason).slice(0, 200));
  const view = input.view;
  const pagesById = validateSourcePages(input.pages);

  const slots = enumerateViewEntries(view).map((slot) => {
    const page = PAGE_BACKED_SOURCES.includes(slot.entry.sourceType)
      ? (pagesById.get(slot.entry.sourceId) || null)
      : null;
    // Namespace: every page-backed entry must resolve inside the view
    // namespace; cross-task pages fail closed before any packing.
    if (PAGE_BACKED_SOURCES.includes(slot.entry.sourceType)) {
      if (page !== null && !tripleMatches(namespaceTripleOf(view.namespace), namespaceTripleOf(page.namespace))) {
        failCompression('context-compression-namespace-mismatch', 'page escapes the view namespace: ' + slot.entry.sourceId.slice(0, 64));
      }
    }
    const eligibility = representationEligibilityV2({ entry: slot.entry, section: slot.section, page });
    return {
      section: slot.section,
      orderIndex: slot.orderIndex,
      original: slot.entry,
      page,
      eligibility,
      rung: 0,
      derived: { 1: null, 2: null },
      transitions: [],
      exhausted: false,
      originalTokens: counterV2.countTextVerifiedV2(counter, slot.entry.exactText),
    };
  });
  const materialIdOf = (section, entry) => viewV2.deriveMaterialEntryIdV2(
    section, entry.tier, entry.sourceType, entry.sourceId, entry.contentHash,
  );
  const sourceHashOf = (slot) => (slot.page !== null ? slot.page.contentHash : slot.original.contentHash);
  const rawOf = (slot) => rawEntryForRung(
    slot.original, slot.rung, slot.rung === 0 ? null : slot.derived[slot.rung], sourceHashOf(slot),
  );

  // Mandatory overflow is never solved by compression: same failure code
  // as C04, no view emitted.
  let mandatoryUsed = 0;
  for (const slot of slots) {
    if (slot.original.mandatory === true) mandatoryUsed += slot.originalTokens;
  }
  if (mandatoryUsed > budget.hardMax) {
    failCompression(COMPRESSION_FAILURE_MANDATORY_OVER_BUDGET,
      'mandatory ' + mandatoryUsed + ' tokens exceed hardMax ' + budget.hardMax);
  }

  const buildCandidateView = (trace) => {
    const sections = { pinned: [], hot: [], warm: [], materializedCold: [] };
    for (const slot of slots) sections[slot.section].push(rawOf(slot));
    return viewV2.createContextViewV2({
      namespace: deepClone(view.namespace),
      checkpointBinding: deepClone(view.checkpointBinding),
      turnRef: deepClone(view.turnRef),
      pinned: sections.pinned,
      hot: sections.hot,
      warm: sections.warm,
      materializedCold: sections.materializedCold,
      referencedColdPages: deepClone(view.referencedColdPages),
      tokenBudget: { hardMax: budget.hardMax, target: budget.target, used: null },
      compilerPolicyRevision: view.compilerPolicyRevision,
      compilationTrace: trace,
      mandatoryRefs: deepClone(view.mandatoryRefs),
    });
  };

  const advanceSlot = (slot) => {
    // Walk the ladder monotonically to the next AVAILABLE rung.
    // Unavailable rungs are marked false and skipped, never guessed.
    // Only successful walks are recorded in slot.transitions, so the
    // plan always proves a strict EXACT -> ... -> selected walk.
    for (let rung = slot.rung + 1; rung <= 2; rung += 1) {
      if (slot.derived[rung] === false) continue;
      if (typeof slot.derived[rung] === 'string') {
        const from = slot.rung === 0 ? 'EXACT' : 'EXTRACTIVE';
        slot.transitions.push({
          from,
          to: rung === 1 ? 'EXTRACTIVE' : 'STRUCTURED',
          reasonCode: rung === 1 ? 'compression-extractive-budget' : 'compression-structured-budget',
          deterministic: true,
        });
        slot.rung = rung;
        return true;
      }
      let derived = null;
      if (rung === 1) {
        derived = deriveExtractiveTextV2({ page: slot.page, entryText: slot.original.exactText });
      } else {
        derived = deriveStructuredTextV2({ page: slot.page, viewNamespace: view.namespace });
      }
      if (!derived.available) {
        slot.derived[rung] = false;
        continue;
      }
      // Anti-laundering: a derived form that hashes to the source bytes
      // is not a projection; skip the rung.
      if (sha256HexUtf8(derived.text) === slot.page.contentHash) {
        slot.derived[rung] = false;
        continue;
      }
      // Least-lossy guard: a rung that is not strictly smaller (in real
      // counted tokens) than the current form can never satisfy a budget
      // the current form failed, so it is skipped, never walked.
      const currentText = slot.rung === 0 ? slot.original.exactText : slot.derived[slot.rung];
      if (counterV2.countTextVerifiedV2(counter, derived.text)
        >= counterV2.countTextVerifiedV2(counter, currentText)) {
        slot.derived[rung] = false;
        continue;
      }
      slot.derived[rung] = derived.text;
      const from = slot.rung === 0 ? 'EXACT' : 'EXTRACTIVE';
      slot.transitions.push({
        from,
        to: rung === 1 ? 'EXTRACTIVE' : 'STRUCTURED',
        reasonCode: rung === 1 ? 'compression-extractive-budget' : 'compression-structured-budget',
        deterministic: true,
      });
      slot.rung = rung;
      return true;
    }
    return false;
  };

  // Least-lossy fixpoint: re-run the SAME C04 packing policy after every
  // single rung advance (highest blocked priority first), so kept
  // material is never touched and priority order structurally holds.
  // REFERENCE dispositions on exhausted COLD are accepted (the REFERENCE
  // rung, owned by C04); only advanceable rungs continue.
  let packed = null;
  const maxIterations = slots.length * 3 + 1;
  for (let iteration = 0; iteration <= maxIterations; iteration += 1) {
    // Material ids derive from shown bytes, so the decision -> slot map
    // is rebuilt every pass from the current rung assignment.
    const materialIndex = new Map();
    for (const slot of slots) materialIndex.set(materialIdOf(slot.section, rawOf(slot)), slot);
    const candidateView = buildCandidateView(deepClone(view.compilationTrace));
    packed = allocatorV2.packContextBudgetV2({
      view: candidateView, budget: { hardMax: budget.hardMax, target: budget.target }, counter,
    });
    const blocked = [];
    for (const decision of packed.plan.decisions) {
      if (decision.action !== 'OMIT' && decision.action !== 'REFERENCE') continue;
      const slot = materialIndex.get(decision.materialId);
      if (!slot || !slot.eligibility.eligible || slot.exhausted) continue;
      const priority = allocatorV2.derivePackingPriorityV2({
        tier: decision.tier, mandatory: decision.mandatory, orderIndex: slot.orderIndex,
      });
      blocked.push({ slot, packingClass: priority.class, orderIndex: slot.orderIndex });
    }
    if (blocked.length === 0) break;
    blocked.sort((a, b) => (a.packingClass - b.packingClass) || (a.orderIndex - b.orderIndex));
    if (advanceSlot(blocked[0].slot)) {
      if (iteration === maxIterations) {
        failCompression('context-compression-no-convergence', 'ladder fixpoint exceeded its deterministic bound');
      }
      continue;
    }
    // No further rung exists for the highest-priority blocked source:
    // its C04 disposition stands; continue with the rest.
    blocked[0].slot.exhausted = true;
  }

  // Final kept set comes from the authoritative C04 fixpoint plan.
  const keptMaterialIds = new Set(packed.plan.keptMaterialIds);

  // Compression trace: one honest entry per KEPT lossy representation
  // (what the model actually sees in non-exact form). REFERENCE/OMIT
  // dispositions keep C04's own plan reasons; the compression plan below
  // records their ladder history.
  const compressionTrace = deepClone(view.compilationTrace);
  for (const slot of slots) {
    if (slot.rung === 0) continue;
    // Entry ids derive from shown bytes: recompute for the kept check.
    if (!keptMaterialIds.has(materialIdOf(slot.section, rawOf(slot)))) continue;
    compressionTrace.push({
      pageId: slot.original.sourceId,
      action: slot.rung === 2 ? 'STRUCTURE' : 'EXTRACT',
      reasonCode: slot.rung === 2 ? 'compression-structured-budget' : 'compression-extractive-budget',
      deterministic: true,
    });
  }

  const finalView = buildCandidateView(compressionTrace);
  const finalPacked = allocatorV2.packContextBudgetV2({
    view: finalView, budget: { hardMax: budget.hardMax, target: budget.target }, counter,
  });
  // The appended trace is observability only: packing must agree exactly
  // with the fixpoint pass, or compression has an internal defect.
  if (JSON.stringify(finalPacked.plan.keptMaterialIds) !== JSON.stringify(packed.plan.keptMaterialIds)
    || JSON.stringify(finalPacked.plan.referencedPageIds) !== JSON.stringify(packed.plan.referencedPageIds)
    || JSON.stringify(finalPacked.plan.omittedMaterialIds) !== JSON.stringify(packed.plan.omittedMaterialIds)) {
    failCompression('context-compression-trace-interference', 'trace annotations altered packing');
  }

  const finalDispositionByMaterial = new Map();
  for (const decision of finalPacked.plan.decisions) {
    finalDispositionByMaterial.set(decision.materialId, decision.action);
  }

  const sources = [];
  for (const slot of slots) {
    const selectedKind = slot.rung === 0 ? 'EXACT' : (slot.rung === 1 ? 'EXTRACTIVE' : 'STRUCTURED');
    const selectedText = slot.rung === 0 ? slot.original.exactText : slot.derived[slot.rung];
    const representationHash = sha256HexUtf8(selectedText);
    // Material id of the final shown form (id derives from shown bytes).
    const shownMaterialId = materialIdOf(slot.section, rawOf(slot));
    const action = finalDispositionByMaterial.get(shownMaterialId);
    const finalDisposition = action === 'KEEP' ? 'KEPT' : (action === 'REFERENCE' ? 'REFERENCE' : 'OMIT');
    // slot.transitions holds successful walks only (unavailable rungs
    // are skipped, never recorded), so the chain below is strict.
    const transitions = [];
    let cursor = 'EXACT';
    for (const transition of slot.transitions) {
      if (transition.from !== cursor) {
        failCompression('context-compression-plan-invalid', 'non-monotonic ladder walk');
      }
      transitions.push({
        from: transition.from, to: transition.to, reasonCode: transition.reasonCode, deterministic: true,
      });
      cursor = transition.to;
    }
    if ((slot.rung === 1 && cursor !== 'EXTRACTIVE')
      || (slot.rung === 2 && cursor !== 'STRUCTURED')
      || (slot.rung === 0 && cursor !== 'EXACT')) {
      failCompression('context-compression-plan-invalid', 'ladder walk disagrees with the selected rung');
    }
    let reasonCode = null;
    if (finalDisposition === 'REFERENCE') reasonCode = 'compression-reference-accepted';
    else if (finalDisposition === 'OMIT') reasonCode = 'compression-omitted';
    else if (selectedKind === 'EXACT') {
      reasonCode = slot.eligibility.eligible ? 'compression-exact-fits' : slot.eligibility.exactOnlyReason;
    } else {
      reasonCode = selectedKind === 'EXTRACTIVE' ? 'compression-extractive-budget' : 'compression-structured-budget';
    }
    sources.push({
      sourceId: slot.original.sourceId,
      sourcePageId: slot.page !== null ? slot.page.id : slot.original.sourceId,
      sourceContentHash: slot.page !== null ? slot.page.contentHash : slot.original.contentHash,
      section: slot.section,
      tier: slot.original.tier,
      originalKind: 'EXACT',
      originalTokens: slot.originalTokens,
      originalContentHash: slot.original.contentHash,
      selectedKind,
      representationHash,
      selectedTokens: finalDisposition === 'KEPT'
        ? counterV2.countTextVerifiedV2(counter, selectedText)
        : null,
      transitions,
      finalDisposition,
      reasonCode,
    });
  }

  const plan = {
    schemaVersion: COMPRESSION_SCHEMA_VERSION,
    compressionPolicyRevision: policyRevision,
    tokenizerFingerprint: fingerprint,
    hardMax: budget.hardMax,
    target: budget.target,
    deterministic: true,
    sources,
    planDigest: null,
  };
  plan.planDigest = deriveCompressionPlanDigestV2(plan);
  const frozenPlan = freezeDeep(plan);
  const planCheck = validateCompressionPlanV2(frozenPlan, {
    expectedFingerprint: fingerprint, expectedPolicyRevision: policyRevision,
  });
  if (!planCheck.valid) failCompression('context-compression-plan-invalid', String(planCheck.reason));
  return freezeDeep({
    compressedView: finalPacked.packedView,
    compressionPlan: frozenPlan,
    packingPlan: finalPacked.plan,
    packingCosts: finalPacked.costs,
  });
}

module.exports = {
  COMPRESSION_SCHEMA_VERSION,
  COMPRESSION_POLICY_REVISION_V1,
  COMPRESSION_PLAN_DIGEST_DOMAIN_V1,
  STRUCTURED_REPRESENTATION_DOMAIN_V1,
  REPRESENTATION_KINDS,
  COMPRESSION_BOUNDS,
  COMPRESSION_REASON_CODES,
  COMPRESSION_FAILURE_MANDATORY_OVER_BUDGET,
  COMPRESSION_PLAN_EXACT_KEYS,
  COMPRESSION_SOURCE_EXACT_KEYS,
  representationEligibilityV2,
  deriveExtractiveTextV2,
  deriveStructuredTextV2,
  deriveCompressionPlanDigestV2,
  validateCompressionPlanV2,
  describeCompressionPlanV2,
  compressContextViewV2,
};
