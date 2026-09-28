'use strict';
/**
 * ContextBudgetAllocatorV2.cjs - CCV2-C04 Budgeted Packing production authority.
 *
 * ONE authority for deterministic token-budget accounting and packing of an
 * already-safe Context Compiler working set. C04 answers "which
 * model-facing material can safely remain materialized" and NOTHING else:
 *
 *   C02 = what state/candidates are structurally eligible.
 *   C03 = which exact evidence is retrievable/relevant.
 *   C04 = which already-safe material fits (here).
 *   C05 = how optional material may be represented more compactly (not here).
 *   C06 = how packed content is laid out for prefix/cache stability (not here).
 *
 * Packing never changes truth: it chooses materialized vs
 * reference/omitted view membership only. Tier, requirement status,
 * verification truth, provenance, retrieval route, and durable evidence
 * are untouched. Deleting every plan and packed view loses zero durable
 * task truth.
 *
 * Primary ordering (frozen): correctness > current relevance > useful
 * historical evidence > optional context. Priority classes (frozen):
 *
 *   0. mandatory correctness (every C01 mandatory entry, any tier)
 *   1. non-mandatory HOT current execution
 *   2. selected WARM durable task knowledge
 *   3. exact materialized COLD historical evidence
 *
 * No model scoring, no per-token value arithmetic, no retrieval ranking
 * changes: within a class the deterministic C02/C03 view order is reused
 * verbatim with the view order index as the frozen tie-break.
 *
 * Greedy baseline (frozen as context-budget-packer-v1):
 *
 *   materialize all mandatory;
 *   walk optional entries in (class, view-order) sequence;
 *   keep a whole entry when it fits the effective target;
 *   otherwise leave it unmaterialized (COLD falls back to its exact
 *   identity reference where a valid COLD reference is buildable;
 *   HOT/WARM omissions stay observable in the plan);
 *   within one class a blocked entry is skipped and the class continues
 *   (whole-entry first-fit); once any entry of class N is blocked, every
 *   lower class is gated (no lower-priority fill while higher-priority
 *   material waits) with reason packing-blocked-by-higher-priority.
 *
 * Each C01 materialized entry is atomic: KEEP the exact entry or leave it
 * unmaterialized. C04 never shortens, slices, rewrites, or re-represents
 * text; reduced representations belong to C05.
 *
 * Budget semantics (frozen):
 *
 *   hardMax = absolute correctness boundary (usable input budget already
 *             derived upstream: contextWindow - reservedOutput -
 *             fixedRuntimeReserve - toolProtocolReserve - safetyMargin).
 *             C04 consumes hardMax/target; it never derives model limits
 *             from model names and never treats a provider advertised
 *             window as hardMax. Provider/system/tool framing overhead is
 *             owned upstream of hardMax; C04 measures logical model-facing
 *             text only and claims no final wire-level provider token use.
 *   target  = preferred model-facing materialization target. Optional
 *             packing stops at target and never causes target overflow:
 *             an optional entry is kept only when the running total
 *             stays within the requested target. When mandatoryUsed
 *             already reaches or exceeds target, optional capacity is
 *             zero (no lower-priority fill while mandatory truth alone
 *             meets or exceeds the preferred size).
 *   used    = actual materialized token count. used <= hardMax always;
 *             used <= target holds except for honest mandatory overflow.
 * Mandatory material always survives: mandatoryUsed > hardMax fails
 * closed with compiler-mandatory-over-budget (no view emitted,
 * mandatory truth is never shortened, omitted, or converted);
 * target < mandatoryUsed <= hardMax is valid with optional material
 * omitted/referenced and used = mandatoryUsed. Target overflow is
 * legal ONLY because of mandatory material.
 *
 * Requested-target honesty (C04H): the packed view and the plan carry
 * the caller-requested target byte-for-byte/integer-for-integer, even
 * when used > target. C04 never rewrites target to mandatory usage;
 * hardMax remains the only absolute token ceiling. (C04H correction:
 * C01 now structurally accepts used > target within hardMax, so no
 * target masking is needed or permitted.)
 *
 * Accounting unit (frozen): the exact model-facing textual payload of
 * each C01 MaterializedContext entry (entry.exactText passed to the
 * counter byte-for-byte, including Unicode text; no case folding, no
 * transliteration, no normalization). Referenced-only COLD identity
 * metadata is NOT counted as evidence text: the plan records
 * referenceMetadataCount (packed referencedColdPages size) separately and
 * C04 never labels it as final provider cost. Reference markers consume
 * no C04 budget unless a future layer renders them into prompt text.
 *
 * Counter trust boundary (frozen): ordinary caller metadata (tokenCount
 * fields, prior used values, caller-supplied counts) is never
 * authoritative. Every packed count is computed in-operation through the
 * supplied validated counter, verified twice per unique text with failure
 * on disagreement, and bound to (materialId, contentHash). No persistent
 * count cache exists in C04: memoization is per-operation only, keyed by
 * material identity, so changed text/contentHash always recounts.
 *
 * conceptual exports: packContextBudgetV2, buildContextPackingPlanV2,
 * validateContextPackingPlanV2, calculateContextTokenUsageV2,
 * derivePackingPriorityV2, describeContextPackingPlanV2.
 *
 * Purity: every export is deterministic and read-only over checkpoint /
 * pages / evidence store / tier decisions / retrieval results / canonical
 * history. Same inputs + tokenizer outputs + budget + policy revision ->
 * same costs, decisions, membership, plan digest, viewId, viewDigest.
 * Outputs are deeply frozen. Packing diagnostics carry ids, tiers, token
 * counts, reason codes, hash prefixes, and budget totals only, never raw
 * exact text. Evidence prose (KEEP ME / I AM MANDATORY / PRIORITY=MAX)
 * cannot influence packing: only typed mandatory/tier/order/cost govern.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (C04 freeze record). A/B/C01/C02/C03 semantics are consumed verbatim.
 *
 * Explicitly NOT implemented here (unsupported dimensions named once so
 * the boundary is auditable): hand-picked passages, structural
 * re-representation, machine-written digests, similarity search, vector
 * stores, learned rankers, decision-provider scoring, model-assurance
 * values, and cache-aware layout. No such dependency
 * exists in this module: it imports only the C01 view gate, the counter
 * contract, and the frozen digest primitives. In particular this module
 * performs no lexical/file/symbol search, no store reads, no session or
 * repository access, and no evidence rehydration; it consumes supplied
 * C03 results as already-materialized view membership.
 */

const viewV2 = require('./ContextViewV2.cjs');
const checkpointV2 = require('./ContextCheckpointV2.cjs');
const counterV2 = require('./ContextTokenCounterV2.cjs');

// ---- frozen revision / identity ----

const PACKING_SCHEMA_VERSION = 1;
// Policy revision stays v1: the C04H effective-target removal is a
// pre-freeze schema correction (same greedy selection, honest target
// carriage), not a new selection algorithm. C04 is not frozen yet, so
// no v2 rotation is required; the choice is recorded in the C04H
// architecture note.
const PACKING_POLICY_REVISION_V1 = 'context-budget-packer-v1';
const PACKING_PLAN_DIGEST_DOMAIN_V1 = 'nexus/context-packing-plan/v1';

// ---- frozen budget bounds (shape only; values are caller-supplied) ----

const PACKING_BOUNDS = Object.freeze({
  hardMaxMin: 1,
  hardMaxMax: 10000000,
  reasonCodeMaxChars: 128,
});

// ---- frozen priority classes ----

const PACKING_CLASSES = Object.freeze({
  mandatory: 0,
  hot: 1,
  warm: 2,
  cold: 3,
});

const PACKING_CLASS_NAMES = Object.freeze(['mandatory-correctness', 'hot-current', 'warm-selected', 'cold-evidence']);

// ---- frozen decision actions ----

const PACKING_ACTIONS = Object.freeze(['KEEP', 'REFERENCE', 'OMIT']);

// ---- frozen packing reason codes (closed world) ----

const PACKING_REASON_CODES = Object.freeze([
  'packing-mandatory-kept',
  'packing-hot-kept',
  'packing-warm-kept',
  'packing-cold-kept',
  'packing-hot-omitted-over-target',
  'packing-warm-omitted-from-view',
  'packing-cold-referenced',
  'packing-cold-reference-unavailable',
  'packing-blocked-by-higher-priority',
]);

// ---- frozen failure codes (closed world) ----

const PACKING_FAILURE_MANDATORY_OVER_BUDGET = 'compiler-mandatory-over-budget';

// Exact C01 COLD-reference modes, mirrored from the frozen B03 authority
// (B03 EXACT_RESOLUTION_MODES). The list is mirrored rather than
// imported so this module performs no rehydration discovery; a test
// proves the mirror matches B03 exactly.
const PACKING_COLD_REFERENCE_MODES = Object.freeze([
  'durable-inline',
  'durable-blob',
  'exact-session-source',
  'exact-repository-source',
  'exact-artifact-source',
]);

const PAGE_ID_PATTERN = /^cxp_[0-9a-f]{32}$/;

// ---- frozen plan/decision/cost key contracts ----

const PACKING_PLAN_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'tokenizerFingerprint', 'packingPolicyRevision',
  'compilerPolicyRevision', 'hardMax', 'target',
  'mandatoryUsed', 'optionalUsed', 'used', 'referenceMetadataCount',
  'keptMaterialIds', 'referencedPageIds', 'omittedMaterialIds',
  'decisions', 'deterministic', 'planDigest',
]);

const PACKING_DECISION_EXACT_KEYS = Object.freeze([
  'materialId', 'tier', 'mandatory', 'action', 'tokens', 'reasonCode', 'deterministic',
]);

const PACKING_COST_EXACT_KEYS = Object.freeze([
  'sourceId', 'materialId', 'tier', 'mandatory', 'tokens', 'tokenizerFingerprint', 'contentHash',
]);

function failPacking(code, detail) {
  throw new Error(String(code) + (detail === undefined ? '' : ': ' + detail) + ' (DISCARDABLE)');
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
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    return Object.freeze(value);
  }
  return value;
}

function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}

function sha256HexUtf8(text) {
  return checkpointV2.sha256HexUtf8(String(text));
}

function planWithoutDigest(plan) {
  const copy = {};
  for (const key of Object.keys(plan)) {
    if (key === 'planDigest') continue;
    copy[key] = plan[key];
  }
  return copy;
}

function derivePackingPlanDigestV2(plan) {
  return sha256HexUtf8(
    PACKING_PLAN_DIGEST_DOMAIN_V1 + '\n' + canonicalJsonOf(planWithoutDigest(plan)),
  );
}

// ---- usable-budget contract (consumed, never derived) ----

const PACKING_BUDGET_EXACT_KEYS = Object.freeze(['hardMax', 'target']);

function validatePackingBudgetV2(budget) {
  if (!isPlainObject(budget)) failPacking('context-budget-invalid', 'budget must be an object');
  const unknown = unknownKeyOf(budget, PACKING_BUDGET_EXACT_KEYS);
  // Caller-supplied count metadata (tokenCount/used/estimates) is never
  // authoritative and never silently accepted: unknown budget keys fail.
  if (unknown !== null) failPacking('context-budget-invalid', 'budget.' + String(unknown));
  if (!Number.isInteger(budget.hardMax)
    || budget.hardMax < PACKING_BOUNDS.hardMaxMin
    || budget.hardMax > PACKING_BOUNDS.hardMaxMax) {
    failPacking('context-budget-invalid', 'budget.hardMax is invalid');
  }
  if (!Number.isInteger(budget.target) || budget.target < 0 || budget.target > budget.hardMax) {
    failPacking('context-budget-invalid', 'budget.target must satisfy 0 <= target <= hardMax');
  }
  return { hardMax: budget.hardMax, target: budget.target };
}

function validatePackingPolicyRevision(revision) {
  const effective = revision === undefined || revision === null
    ? PACKING_POLICY_REVISION_V1
    : revision;
  if (effective !== PACKING_POLICY_REVISION_V1) {
    failPacking('context-budget-policy-unknown', 'packing policy ' + String(effective).slice(0, 64) + ' is unknown');
  }
  return effective;
}

function requireCounter(counter) {
  const check = counterV2.validateContextTokenCounterV2(counter);
  if (!check.valid) failPacking('context-budget-tokenizer-unavailable', 'certified packing requires a valid token-counting authority');
  return check.fingerprint;
}

// ---- priority derivation (frozen classifier, no scoring) ----

/**
 * Derive the frozen packing priority for one materialized entry.
 * Inputs only: typed tier, typed mandatory flag, frozen view order.
 * Entry prose is never consulted.
 */
function derivePackingPriorityV2(input) {
  if (!isPlainObject(input)) failPacking('context-budget-invalid', 'priority input must be an object');
  const unknown = unknownKeyOf(input, ['tier', 'mandatory', 'orderIndex']);
  if (unknown !== null) failPacking('context-budget-invalid', 'priority.' + String(unknown));
  if (!viewV2.MATERIAL_TIERS.includes(input.tier)) failPacking('context-budget-invalid', 'priority tier is unknown');
  if (typeof input.mandatory !== 'boolean') failPacking('context-budget-invalid', 'priority mandatory must be boolean');
  if (!Number.isInteger(input.orderIndex) || input.orderIndex < 0) {
    failPacking('context-budget-invalid', 'priority orderIndex must be a non-negative integer');
  }
  if (input.mandatory === true) {
    return Object.freeze({ class: PACKING_CLASSES.mandatory, className: PACKING_CLASS_NAMES[0], orderIndex: input.orderIndex });
  }
  if (input.tier === 'PINNED') {
    // Unreachable for C01-valid views (PINNED is mandatory by
    // construction), frozen defensively as mandatory correctness.
    return Object.freeze({ class: PACKING_CLASSES.mandatory, className: PACKING_CLASS_NAMES[0], orderIndex: input.orderIndex });
  }
  if (input.tier === 'HOT') {
    return Object.freeze({ class: PACKING_CLASSES.hot, className: PACKING_CLASS_NAMES[1], orderIndex: input.orderIndex });
  }
  if (input.tier === 'WARM') {
    return Object.freeze({ class: PACKING_CLASSES.warm, className: PACKING_CLASS_NAMES[2], orderIndex: input.orderIndex });
  }
  return Object.freeze({ class: PACKING_CLASSES.cold, className: PACKING_CLASS_NAMES[3], orderIndex: input.orderIndex });
}

// ---- entry enumeration (frozen view order) ----

function enumeratePackingEntries(view) {
  const check = viewV2.validateContextViewV2(view);
  if (!check.valid) failPacking('context-budget-view-invalid', String(check.reason));
  const entries = [];
  let orderIndex = 0;
  for (const section of viewV2.VIEW_SECTIONS) {
    for (const entry of view[section]) {
      const priority = derivePackingPriorityV2({
        tier: entry.tier, mandatory: entry.mandatory, orderIndex,
      });
      entries.push({
        section,
        materialId: entry.id,
        sourceId: entry.sourceId,
        sourceType: entry.sourceType,
        tier: entry.tier,
        mandatory: entry.mandatory,
        contentHash: entry.contentHash,
        exactText: entry.exactText,
        provenance: entry.provenance,
        tierDecision: entry.tierDecision,
        // C05: the representation binding travels with the enumerated
        // entry so COLD fallback resolves the source identity it names.
        representation: entry.representation === undefined ? null : entry.representation,
        orderIndex,
        packingClass: priority.class,
      });
      orderIndex += 1;
    }
  }
  return entries;
}

// ---- exact token-cost accounting (computed, never caller-supplied) ----

/**
 * Compute exact token costs for every materialized entry of a validated
 * view through the supplied validated counter. One verified count per
 * identity per operation (per-operation memoization only); changing
 * text/contentHash always recounts because the count is bound to the
 * live entry, never to a stored number.
 */
function calculateContextTokenUsageV2(input) {
  if (!isPlainObject(input)) failPacking('context-budget-invalid', 'usage input must be an object');
  const unknown = unknownKeyOf(input, ['view', 'counter']);
  if (unknown !== null) failPacking('context-budget-invalid', 'usage.' + String(unknown));
  const fingerprint = requireCounter(input.counter);
  const entries = enumeratePackingEntries(input.view);
  const seen = new Map();
  const costs = [];
  let mandatoryUsed = 0;
  for (const entry of entries) {
    if (seen.has(entry.materialId)) failPacking('context-budget-invalid', 'duplicate material identity');
    // Per-operation memoization is performance-only and keyed by exact
    // material identity (materialId + contentHash): never authority, and
    // never shared across operations.
    const memoKey = entry.materialId + '\n' + entry.contentHash;
    let tokens = seen.get(memoKey);
    if (tokens === undefined) {
      tokens = counterV2.countTextVerifiedV2(input.counter, entry.exactText);
      seen.set(entry.materialId, tokens);
      seen.set(memoKey, tokens);
    }
    if (entry.mandatory === true) mandatoryUsed += tokens;
    costs.push({
      sourceId: entry.sourceId,
      materialId: entry.materialId,
      tier: entry.tier,
      mandatory: entry.mandatory,
      tokens,
      tokenizerFingerprint: fingerprint,
      contentHash: entry.contentHash,
    });
  }
  const materializedTotal = costs.reduce((sum, cost) => sum + cost.tokens, 0);
  return freezeDeep({
    tokenizerFingerprint: fingerprint,
    costs,
    mandatoryUsed,
    materializedTotal,
    materializedCount: costs.length,
  });
}

// ---- COLD materialized -> reference fallback (view decision only) ----

function buildColdFallbackReference(entry, viewNamespace) {
  // Only page-backed COLD with a frozen B03 mode and a well-formed page
  // identity can fall back to referencedColdPages. Anything else stays
  // observable as OMIT: no evidence is deleted, the durable page
  // survives outside this disposable view.
  if (entry.sourceType !== 'context-page' && entry.sourceType !== 'rehydrated-evidence') return null;
  if (typeof entry.sourceId !== 'string' || !PAGE_ID_PATTERN.test(entry.sourceId)) return null;
  const decision = entry.tierDecision;
  if (!isPlainObject(decision)) return null;
  if (decision.tier !== 'COLD') return null;
  if (typeof decision.exactResolutionMode !== 'string'
    || !PACKING_COLD_REFERENCE_MODES.includes(decision.exactResolutionMode)) return null;
  if (decision.pageId !== entry.sourceId) return null;
  // C05: a representation-bearing entry shows projection bytes while the
  // tier binding still names the canonical source bytes. The reference
  // must name the source bytes (the rehydratable identity), resolved
  // through the entry representation binding when one is present.
  const sourceHash = (entry.representation !== null && entry.representation !== undefined)
    ? entry.representation.sourceContentHash
    : entry.contentHash;
  if (typeof sourceHash !== 'string' || decision.contentHash !== sourceHash) return null;
  const kind = decision.pageKind;
  if (typeof kind !== 'string' || kind === '') return null;
  return {
    pageId: entry.sourceId,
    contentHash: sourceHash,
    evidenceId: null,
    kind,
    provenance: deepClone(entry.provenance),
    exactResolutionMode: decision.exactResolutionMode,
    namespace: {
      taskId: viewNamespace.taskId,
      taskInstanceId: viewNamespace.taskInstanceId,
      sessionId: viewNamespace.sessionId,
    },
    tierDecision: deepClone(decision),
  };
}

function keepReasonForTier(tier) {
  if (tier === 'HOT') return 'packing-hot-kept';
  if (tier === 'WARM') return 'packing-warm-kept';
  return 'packing-cold-kept';
}

// ---- deterministic packing plan ----

/**
 * Build the disposable deterministic packing plan for an already-valid
 * C01 view. Fails closed (no plan) when mandatory truth exceeds hardMax
 * or when no valid counting authority exists. Never mutates inputs.
 */
function buildContextPackingPlanV2(input) {
  if (!isPlainObject(input)) failPacking('context-budget-invalid', 'packing input must be an object');
  const unknown = unknownKeyOf(input, ['view', 'budget', 'counter', 'packingPolicyRevision']);
  if (unknown !== null) failPacking('context-budget-invalid', 'packing.' + String(unknown));
  const policyRevision = validatePackingPolicyRevision(input.packingPolicyRevision);
  const budget = validatePackingBudgetV2(input.budget);
  const fingerprint = requireCounter(input.counter);
  if (!isPlainObject(input.view)) failPacking('context-budget-view-invalid', 'view is required');
  const usage = calculateContextTokenUsageV2({ view: input.view, counter: input.counter });
  const tokensByMaterial = new Map();
  for (const cost of usage.costs) tokensByMaterial.set(cost.materialId, cost.tokens);

  if (usage.mandatoryUsed > budget.hardMax) {
    // Mandatory state exceeds the hard budget: fail closed. Mandatory
    // truth is never shortened, omitted, or converted to a reference.
    failPacking(PACKING_FAILURE_MANDATORY_OVER_BUDGET,
      'mandatory ' + usage.mandatoryUsed + ' tokens exceed hardMax ' + budget.hardMax);
  }

  // Requested-target control flow (C04H): all mandatory entries are
  // already kept above, so used >= mandatoryUsed here. Optional entries
  // fit only within the requested target: when mandatory truth already
  // reaches or exceeds target, optional capacity is zero. No public
  // target value is derived or rewritten from this local comparison.
  const entries = enumeratePackingEntries(input.view);
  const mandatoryIds = new Set();
  for (const entry of entries) {
    if (entry.mandatory === true) mandatoryIds.add(entry.materialId);
  }

  const optional = entries
    .filter((entry) => entry.mandatory !== true)
    .sort((a, b) => (a.packingClass - b.packingClass) || (a.orderIndex - b.orderIndex));

  const decisions = [];
  const keptMaterialIds = [];
  const referencedPageIds = [];
  const omittedMaterialIds = [];
  const fallbackReferences = [];
  let used = 0;
  let blockedLevel = Number.POSITIVE_INFINITY;

  const recordKeep = (entry, tokens) => {
    used += tokens;
    keptMaterialIds.push(entry.materialId);
    decisions.push({
      materialId: entry.materialId,
      tier: entry.tier,
      mandatory: entry.mandatory,
      action: 'KEEP',
      tokens,
      reasonCode: entry.mandatory === true ? 'packing-mandatory-kept' : keepReasonForTier(entry.tier),
      deterministic: true,
    });
  };

  for (const entry of entries) {
    if (entry.mandatory === true) {
      recordKeep(entry, tokensByMaterial.get(entry.materialId));
    }
  }

  for (const entry of optional) {
    const tokens = tokensByMaterial.get(entry.materialId);
    if (entry.packingClass > blockedLevel) {
      if (entry.tier === 'COLD') {
        const fallback = buildColdFallbackReference(entry, input.view.namespace);
        if (fallback !== null) {
          referencedPageIds.push(fallback.pageId);
          fallbackReferences.push(fallback);
          decisions.push({
            materialId: entry.materialId, tier: entry.tier, mandatory: false,
            action: 'REFERENCE', tokens, reasonCode: 'packing-blocked-by-higher-priority', deterministic: true,
          });
          continue;
        }
      }
      omittedMaterialIds.push(entry.materialId);
      decisions.push({
        materialId: entry.materialId, tier: entry.tier, mandatory: false,
        action: 'OMIT', tokens, reasonCode: 'packing-blocked-by-higher-priority', deterministic: true,
      });
      continue;
    }
    if (used + tokens <= budget.target) {
      used += tokens;
      keptMaterialIds.push(entry.materialId);
      decisions.push({
        materialId: entry.materialId, tier: entry.tier, mandatory: false,
        action: 'KEEP', tokens, reasonCode: keepReasonForTier(entry.tier), deterministic: true,
      });
      continue;
    }
    if (entry.packingClass < blockedLevel) blockedLevel = entry.packingClass;
    if (entry.tier === 'COLD') {
      const fallback = buildColdFallbackReference(entry, input.view.namespace);
      if (fallback !== null) {
        referencedPageIds.push(fallback.pageId);
        fallbackReferences.push(fallback);
        decisions.push({
          materialId: entry.materialId, tier: entry.tier, mandatory: false,
          action: 'REFERENCE', tokens, reasonCode: 'packing-cold-referenced', deterministic: true,
        });
        continue;
      }
      omittedMaterialIds.push(entry.materialId);
      decisions.push({
        materialId: entry.materialId, tier: entry.tier, mandatory: false,
        action: 'OMIT', tokens, reasonCode: 'packing-cold-reference-unavailable', deterministic: true,
      });
      continue;
    }
    omittedMaterialIds.push(entry.materialId);
    decisions.push({
      materialId: entry.materialId,
      tier: entry.tier,
      mandatory: false,
      action: 'OMIT',
      tokens,
      reasonCode: entry.tier === 'HOT' ? 'packing-hot-omitted-over-target' : 'packing-warm-omitted-from-view',
      deterministic: true,
    });
  }

  // Frozen ordering for plan lists: mandatory decisions follow view
  // order; optional decisions follow the (class, view-order) walk above.
  const optionalUsed = used - usage.mandatoryUsed;
  const referenceMetadataCount = input.view.referencedColdPages.length + fallbackReferences.length;
  const plan = {
    schemaVersion: PACKING_SCHEMA_VERSION,
    tokenizerFingerprint: fingerprint,
    packingPolicyRevision: policyRevision,
    compilerPolicyRevision: input.view.compilerPolicyRevision,
    hardMax: budget.hardMax,
    target: budget.target,
    mandatoryUsed: usage.mandatoryUsed,
    optionalUsed,
    used,
    referenceMetadataCount,
    keptMaterialIds,
    referencedPageIds,
    omittedMaterialIds,
    decisions,
    deterministic: true,
    planDigest: null,
  };
  plan.planDigest = derivePackingPlanDigestV2(plan);
  const frozenPlan = freezeDeep(plan);
  const validation = validateContextPackingPlanV2(frozenPlan);
  if (!validation.valid) failPacking('context-budget-plan-invalid', String(validation.reason));
  return {
    plan: frozenPlan,
    costs: usage.costs,
    fallbackReferences: freezeDeep(fallbackReferences),
  };
}

// ---- plan validation (observability gate, never authority) ----

function isReasonCode(value) {
  return typeof value === 'string' && PACKING_REASON_CODES.includes(value);
}

/**
 * Validate a packing plan as a closed-world observability record.
 * Proves digest agreement, binding agreement (tokenizer fingerprint,
 * packing policy, compiler policy, budget), and budget arithmetic
 * (mandatory + optional = used, used <= hardMax, optional never causes
 * target overflow). Expected bindings fail closed on mismatch so a plan
 * cannot be replayed under incompatible accounting.
 */
function validateContextPackingPlanV2(plan, options) {
  const fail = (reason) => ({ valid: false, reason });
  if (!isPlainObject(plan)) return fail('context-budget-plan-invalid');
  if (unknownKeyOf(plan, PACKING_PLAN_EXACT_KEYS) !== null) return fail('context-budget-plan-invalid');
  if (plan.schemaVersion !== PACKING_SCHEMA_VERSION) return fail('context-budget-plan-invalid');
  if (typeof plan.tokenizerFingerprint !== 'string' || plan.tokenizerFingerprint === ''
    || plan.tokenizerFingerprint.length > counterV2.TOKENIZER_FINGERPRINT_MAX_CHARS) {
    return fail('context-budget-plan-invalid');
  }
  if (plan.packingPolicyRevision !== PACKING_POLICY_REVISION_V1) return fail('context-budget-plan-invalid');
  if (typeof plan.compilerPolicyRevision !== 'string' || plan.compilerPolicyRevision === '') {
    return fail('context-budget-plan-invalid');
  }
  for (const key of ['hardMax', 'target', 'mandatoryUsed', 'optionalUsed', 'used', 'referenceMetadataCount']) {
    if (!Number.isInteger(plan[key]) || plan[key] < 0) return fail('context-budget-plan-invalid');
  }
  if (plan.hardMax < PACKING_BOUNDS.hardMaxMin || plan.hardMax > PACKING_BOUNDS.hardMaxMax) {
    return fail('context-budget-plan-invalid');
  }
  if (plan.target > plan.hardMax) return fail('context-budget-plan-invalid');
  if (plan.mandatoryUsed + plan.optionalUsed !== plan.used) return fail('context-budget-plan-invalid');
  if (plan.used > plan.hardMax) return fail('context-budget-plan-invalid');
  // Strong target invariant (C04H): used <= max(target, mandatoryUsed).
  // Either the pack stayed within the preferred target, or mandatory
  // truth alone exceeded it with zero optional contribution.
  if (plan.used > Math.max(plan.target, plan.mandatoryUsed)) return fail('context-budget-plan-invalid');
  if (!Array.isArray(plan.keptMaterialIds) || !Array.isArray(plan.referencedPageIds)
    || !Array.isArray(plan.omittedMaterialIds) || !Array.isArray(plan.decisions)) {
    return fail('context-budget-plan-invalid');
  }
  if (plan.deterministic !== true) return fail('context-budget-plan-invalid');
  if (typeof plan.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(plan.planDigest)) {
    return fail('context-budget-plan-invalid');
  }
  const seenMaterials = new Set();
  const keptFromDecisions = [];
  const omittedFromDecisions = [];
  let referenceDecisionCount = 0;
  let recomputedUsed = 0;
  let recomputedOptional = 0;
  for (const decision of plan.decisions) {
    if (!isPlainObject(decision)) return fail('context-budget-plan-invalid');
    if (unknownKeyOf(decision, PACKING_DECISION_EXACT_KEYS) !== null) return fail('context-budget-plan-invalid');
    if (typeof decision.materialId !== 'string' || decision.materialId === '') return fail('context-budget-plan-invalid');
    if (seenMaterials.has(decision.materialId)) return fail('context-budget-plan-invalid');
    seenMaterials.add(decision.materialId);
    if (!viewV2.MATERIAL_TIERS.includes(decision.tier)) return fail('context-budget-plan-invalid');
    if (typeof decision.mandatory !== 'boolean') return fail('context-budget-plan-invalid');
    if (!PACKING_ACTIONS.includes(decision.action)) return fail('context-budget-plan-invalid');
    if (!Number.isInteger(decision.tokens) || decision.tokens < 0) return fail('context-budget-plan-invalid');
    if (!isReasonCode(decision.reasonCode)) return fail('context-budget-plan-invalid');
    if (decision.deterministic !== true) return fail('context-budget-plan-invalid');
    if (decision.mandatory === true && decision.action !== 'KEEP') return fail('context-budget-plan-invalid');
    if (decision.action === 'KEEP') {
      keptFromDecisions.push(decision.materialId);
      recomputedUsed += decision.tokens;
      if (decision.mandatory !== true) recomputedOptional += decision.tokens;
    } else if (decision.action === 'REFERENCE') {
      referenceDecisionCount += 1;
      if (decision.mandatory === true) return fail('context-budget-plan-invalid');
    } else {
      omittedFromDecisions.push(decision.materialId);
    }
    // Target-overflow rule: only mandatory material may push used past
    // target. Any non-mandatory KEEP carrying tokens while used exceeds
    // target invalidates the plan.
    if (plan.used > plan.target && decision.mandatory !== true
      && decision.action === 'KEEP' && decision.tokens > 0) {
      return fail('context-budget-plan-invalid');
    }
  }
  if (recomputedUsed !== plan.used) return fail('context-budget-plan-invalid');
  if (recomputedOptional !== plan.optionalUsed) return fail('context-budget-plan-invalid');
  if (JSON.stringify(keptFromDecisions) !== JSON.stringify(plan.keptMaterialIds)) {
    return fail('context-budget-plan-invalid');
  }
  if (JSON.stringify(omittedFromDecisions) !== JSON.stringify(plan.omittedMaterialIds)) {
    return fail('context-budget-plan-invalid');
  }
  if (referenceDecisionCount !== plan.referencedPageIds.length) return fail('context-budget-plan-invalid');
  if (derivePackingPlanDigestV2(plan) !== plan.planDigest) return fail('context-budget-plan-invalid');
  const expected = isPlainObject(options) ? options : {};
  if (expected.expectedTokenizerFingerprint !== undefined && expected.expectedTokenizerFingerprint !== null
    && expected.expectedTokenizerFingerprint !== plan.tokenizerFingerprint) {
    return fail('context-budget-fingerprint-mismatch');
  }
  if (expected.expectedPackingPolicyRevision !== undefined && expected.expectedPackingPolicyRevision !== null
    && expected.expectedPackingPolicyRevision !== plan.packingPolicyRevision) {
    return fail('context-budget-plan-invalid');
  }
  if (expected.expectedHardMax !== undefined && expected.expectedHardMax !== null
    && expected.expectedHardMax !== plan.hardMax) {
    return fail('context-budget-plan-invalid');
  }
  if (expected.expectedTarget !== undefined && expected.expectedTarget !== null
    && expected.expectedTarget !== plan.target) {
    return fail('context-budget-plan-invalid');
  }
  if (expected.expectedCompilerPolicyRevision !== undefined && expected.expectedCompilerPolicyRevision !== null
    && expected.expectedCompilerPolicyRevision !== plan.compilerPolicyRevision) {
    return fail('context-budget-plan-invalid');
  }
  return { valid: true, reason: null };
}

// ---- packed ContextView assembly (C01 remains the final gate) ----

function rawEntryOf(viewEntry) {
  const raw = {
    tier: deepClone(viewEntry.tier),
    sourceType: deepClone(viewEntry.sourceType),
    sourceId: deepClone(viewEntry.sourceId),
    contentHash: deepClone(viewEntry.contentHash),
    provenance: deepClone(viewEntry.provenance),
    mediaType: deepClone(viewEntry.mediaType),
    exactText: deepClone(viewEntry.exactText),
    mandatory: viewEntry.mandatory,
    tierDecision: deepClone(viewEntry.tierDecision),
    evidence: viewEntry.evidence === null || viewEntry.evidence === undefined
      ? null : deepClone(viewEntry.evidence),
    toolTransaction: viewEntry.toolTransaction === null || viewEntry.toolTransaction === undefined
      ? null : deepClone(viewEntry.toolTransaction),
  };
  // C05: a model-facing representation binding on the kept entry travels
  // into the packed view untouched, so the packed entry keeps the same
  // source/shown identity the plan accounted for. Entries without one
  // pack byte-identically to before.
  if (viewEntry.representation !== null && viewEntry.representation !== undefined) {
    raw.representation = deepClone(viewEntry.representation);
  }
  return raw;
}

/**
 * Pack an already-valid C01 view under a usable budget through a valid
 * counter. Returns { plan, packedView, costs }: the disposable plan, the
 * new C01-valid packed view (tokenBudget.used = exact packed logical
 * count, target = effective target, fresh viewId/viewDigest), and the
 * bound cost records. Inputs are never mutated; only a new disposable
 * view and plan are created.
 */
function packContextBudgetV2(input) {
  if (!isPlainObject(input)) failPacking('context-budget-invalid', 'packing input must be an object');
  const built = buildContextPackingPlanV2(input);
  const view = input.view;
  const kept = new Set(built.plan.keptMaterialIds);
  const packedSections = {};
  for (const section of viewV2.VIEW_SECTIONS) {
    packedSections[section] = [];
    for (const entry of view[section]) {
      if (kept.has(entry.id)) packedSections[section].push(rawEntryOf(entry));
    }
  }
  // Mandatory manifest survival is structural: every mandatory ref must
  // resolve to kept material or packing has an internal defect.
  const keptSources = new Set();
  for (const section of viewV2.VIEW_SECTIONS) {
    for (const raw of packedSections[section]) keptSources.add(raw.sourceId);
  }
  for (const ref of view.mandatoryRefs) {
    if (!keptSources.has(ref.sourceId)) {
      failPacking('context-budget-plan-invalid', 'mandatory manifest would not survive packing');
    }
  }
  const packedView = viewV2.createContextViewV2({
    namespace: deepClone(view.namespace),
    checkpointBinding: deepClone(view.checkpointBinding),
    turnRef: deepClone(view.turnRef),
    pinned: packedSections.pinned,
    hot: packedSections.hot,
    warm: packedSections.warm,
    materializedCold: packedSections.materializedCold,
    referencedColdPages: deepClone(view.referencedColdPages).concat(deepClone(built.fallbackReferences)),
    // Requested-target honesty (C04H): the packed view carries the
    // caller-requested target even when used > target. C01 structurally
    // accepts that honest state; the plan proves its mandatory cause.
    tokenBudget: { hardMax: built.plan.hardMax, target: built.plan.target, used: built.plan.used },
    compilerPolicyRevision: view.compilerPolicyRevision,
    compilationTrace: deepClone(view.compilationTrace),
    mandatoryRefs: deepClone(view.mandatoryRefs),
  });
  return freezeDeep({ plan: built.plan, packedView, costs: built.costs });
}

// ---- bounded description (ids/counts/reasons/prefixes/totals only) ----

function roundUtilization(used, bound) {
  if (bound === 0) return null;
  return Math.round((used / bound) * 10000) / 10000;
}

/**
 * Describe a validated plan for telemetry: bounded arithmetic only, no
 * exact text, no blobs, no credentials. targetUtilization uses the real
 * requested target and may honestly exceed 1.0 when mandatory truth
 * alone overflows the preferred target; mandatoryTargetOverflowTokens
 * exposes that overflow separately for later telemetry. Throws on an
 * invalid plan.
 */
function describeContextPackingPlanV2(plan) {
  const check = validateContextPackingPlanV2(plan);
  if (!check.valid) failPacking('context-budget-plan-invalid', String(check.reason));
  let hotTokens = 0;
  let warmTokens = 0;
  let coldMaterializedTokens = 0;
  let keptCount = 0;
  let referencedCount = 0;
  let omittedCount = 0;
  for (const decision of plan.decisions) {
    if (decision.action === 'KEEP') {
      keptCount += 1;
      if (decision.mandatory !== true) {
        if (decision.tier === 'HOT') hotTokens += decision.tokens;
        else if (decision.tier === 'WARM') warmTokens += decision.tokens;
        else if (decision.tier === 'COLD') coldMaterializedTokens += decision.tokens;
      }
    } else if (decision.action === 'REFERENCE') {
      referencedCount += 1;
    } else {
      omittedCount += 1;
    }
  }
  return Object.freeze({
    planDigestPrefix: String(plan.planDigest).slice(0, 16),
    tokenizerFingerprint: plan.tokenizerFingerprint,
    packingPolicyRevision: plan.packingPolicyRevision,
    compilerPolicyRevision: plan.compilerPolicyRevision,
    hardMax: plan.hardMax,
    target: plan.target,
    mandatoryTokens: plan.mandatoryUsed,
    mandatoryTargetOverflowTokens: Math.max(0, plan.mandatoryUsed - plan.target),
    hotTokens,
    warmTokens,
    coldMaterializedTokens,
    totalUsedTokens: plan.used,
    keptCount,
    referencedCount,
    omittedCount,
    referenceMetadataCount: plan.referenceMetadataCount,
    targetUtilization: roundUtilization(plan.used, plan.target),
    hardMaxUtilization: roundUtilization(plan.used, plan.hardMax),
    deterministic: true,
  });
}

module.exports = {
  PACKING_SCHEMA_VERSION,
  PACKING_POLICY_REVISION_V1,
  PACKING_PLAN_DIGEST_DOMAIN_V1,
  PACKING_BOUNDS,
  PACKING_CLASSES,
  PACKING_CLASS_NAMES,
  PACKING_ACTIONS,
  PACKING_REASON_CODES,
  PACKING_FAILURE_MANDATORY_OVER_BUDGET,
  PACKING_COLD_REFERENCE_MODES,
  PACKING_PLAN_EXACT_KEYS,
  PACKING_DECISION_EXACT_KEYS,
  PACKING_COST_EXACT_KEYS,
  packContextBudgetV2,
  buildContextPackingPlanV2,
  validateContextPackingPlanV2,
  calculateContextTokenUsageV2,
  derivePackingPriorityV2,
  describeContextPackingPlanV2,
  derivePackingPlanDigestV2,
};
