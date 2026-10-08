'use strict';
/**
 * ContextMemoryTierV2.cjs - CCV2-B04 Memory Tier Mapping production authority.
 *
 * ONE authority for the deterministic mapping between Nexus task-memory
 * objects and the five CCv2 memory tiers (PINNED / HOT / WARM / COLD /
 * ARCHIVE). B04 answers "what class of memory an object belongs to + what
 * storage/materialization behavior that tier permits" and NOTHING else.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (B04 freeze record). B04 defines policy metadata (tier + reason +
 * storage/materialization descriptors). It does NOT build the future
 * ContextView or Context Compiler (Phase C), and it owns no token budget,
 * retrieval ranking, search, embeddings, reranking, prompt assembly,
 * compression ladder, or JEV/Laya/DECIDE behavior.
 *
 * Authority order (frozen):
 *   mandatory correctness state            -> PINNED
 *   immediate active execution state       -> HOT
 *   durable current task knowledge         -> WARM
 *   old exact evidence with safe recovery  -> COLD
 *   canonical historical transcript only   -> ARCHIVE
 *
 * Primary rule: CCv2 may forget from the prompt; it must never forget
 * from the task. Uncertainty fails toward MORE retained context (WARM/HOT),
 * never toward DROP.
 *
 * B01/B02/B03 semantics are consumed verbatim and never modified here:
 *  - page identity/validation via config/ContextPageV2.cjs
 *  - checkpoint validation/build via config/ContextCheckpointV2.cjs
 *  - exact-resolution capability via inspectExactResolutionV2
 *    (config/ContextEvidenceRehydrationV2.cjs). The stored
 *    page.rehydratable flag is NEVER used as the sole COLD test; the
 *    inspector's durablySelfBacked / requiresExternalSource partition is.
 *
 * B04H proof boundary (frozen): exact-resolution CAPABILITY is not
 * exact-resolution PROOF. B03 owns proof (a validated RehydratedEvidenceV2
 * carrying the module-private brand, verified:true, and a recomputed
 * resultDigest); B04 owns tier policy. An externally-backed page
 * (exact-session-source, exact-repository-source, exact-artifact-source)
 * becomes COLD only with a live B03-validated resolutionProof bound to
 * this page, content, namespace, mode, and source identity. Structural
 * source presence alone yields WARM. There is NO caller-authoritative
 * status shortcut: sourceStatus was removed as an input (any such field
 * now fails closed as unknown), and mandatoryCorrectness may only be
 * asserted by controller code from typed authoritative state - never
 * derived from evidence prose (no string/prose input is accepted for it).
 * A B04 decision never guarantees future resolvability: Phase C must run
 * B03 exact rehydration again at materialization time.
 *
 * Purity: every export is deterministic and read-only. No clocks, no
 * randomness, no process identity, no filesystem reads, no mutation of
 * page / checkpoint / store / session / advisory inputs. Identical
 * validated inputs -> byte-identical decision across calls, restarts, and
 * independent OS processes.
 */

const pageV2 = require('./ContextPageV2.cjs');
const checkpointV2 = require('./ContextCheckpointV2.cjs');
const rehydrationV2 = require('./ContextEvidenceRehydrationV2.cjs');

const MEMORY_TIER_SCHEMA_VERSION = 1;

const MEMORY_TIERS = Object.freeze(['PINNED', 'HOT', 'WARM', 'COLD', 'ARCHIVE']);

// Closed-world classification subjects. Unknown subjects FAIL CLOSED.
const SUBJECT_KINDS = Object.freeze([
  'active-requirement',
  'active-constraint',
  'unresolved-approval',
  'open-tool-protocol',
  'mandatory-checkpoint-state',
  'current-user-turn',
  'active-failure',
  'completed-tool-transaction',
  'accepted-decision',
  'verification-state',
  'failure-state',
  'historical-evidence',
  'resolved-failure',
  'superseded-hypothesis',
  'archive-event',
]);

// Subjects that are pure authoritative structured state (never carry a page).
const STATE_SUBJECTS = Object.freeze([
  'active-requirement',
  'active-constraint',
  'unresolved-approval',
  'open-tool-protocol',
  'mandatory-checkpoint-state',
  'current-user-turn',
  'active-failure',
  'accepted-decision',
  'verification-state',
  'failure-state',
]);

// Subjects that classify a historical ContextPage (COLD candidacy).
const PAGE_SUBJECTS = Object.freeze([
  'completed-tool-transaction',
  'historical-evidence',
  'resolved-failure',
  'superseded-hypothesis',
]);

// Stable reason codes. Tests assert codes, not prose.
const REASON_CODES = Object.freeze([
  'tier-pinned-active-requirement',
  'tier-pinned-active-constraint',
  'tier-pinned-unresolved-approval',
  'tier-pinned-open-protocol',
  'tier-pinned-mandatory-state',
  'tier-pinned-correctness-mandatory',
  'tier-hot-current-user',
  'tier-hot-active-failure',
  'tier-hot-immediate-transaction',
  'tier-warm-active-decision',
  'tier-warm-verification-state',
  'tier-warm-failure-state',
  'tier-warm-settled-transaction',
  // CCV2-R1: a byte-bearing historical page that controller reachability
  // proves STILL REQUIRED rests WARM (exact) instead of COLD.
  'tier-warm-retention-required',
  'tier-cold-exact-history',
  'tier-cold-source-resolvable',
  'tier-keep-more-context-no-exact-resolution',
  'tier-archive-canonical-history',
]);

const EXACTNESS_VALUES = Object.freeze([
  'structured-authoritative',
  'exact-inline',
  'exact-source',
  'exact-blob',
  'canonical-history',
]);

const STORAGE_BEHAVIORS = Object.freeze([
  'authoritative-state',
  'active-working-set',
  'durable-reference',
  'content-addressed',
  'canonical-archive',
]);

const MATERIALIZATION_POLICIES = Object.freeze([
  'mandatory',
  'normally-visible',
  'selective',
  'reference-by-default',
  'recovery-only',
]);

// Tier -> static capability triple (frozen materialization mapping).
const TIER_CAPABILITIES = Object.freeze({
  PINNED: Object.freeze({
    exactness: 'structured-authoritative',
    storageBehavior: 'authoritative-state',
    materializationPolicy: 'mandatory',
  }),
  HOT: Object.freeze({
    exactness: 'exact-inline',
    storageBehavior: 'active-working-set',
    materializationPolicy: 'normally-visible',
  }),
  WARM: Object.freeze({
    exactness: 'exact-source',
    storageBehavior: 'durable-reference',
    materializationPolicy: 'selective',
  }),
  COLD: Object.freeze({
    exactness: 'exact-blob',
    storageBehavior: 'content-addressed',
    materializationPolicy: 'reference-by-default',
  }),
  ARCHIVE: Object.freeze({
    exactness: 'canonical-history',
    storageBehavior: 'canonical-archive',
    materializationPolicy: 'recovery-only',
  }),
});

// Legal tier-transition edges. ARCHIVE is the canonical historical
// substrate, never a normal mutable working-tier endpoint.
const TIER_TRANSITIONS = Object.freeze({
  'PINNED>HOT': Object.freeze(['constraint-satisfied', 'approval-resolved', 'protocol-closed', 'gate-released', 'evidence-reactivated']),
  'HOT>PINNED': Object.freeze(['constraint-activated', 'approval-opened', 'protocol-opened', 'gate-armed', 'new-user-turn']),
  'HOT>WARM': Object.freeze(['transaction-settled', 'failure-partly-resolved', 'decision-accepted', 'verification-recorded', 'turn-superseded']),
  'WARM>HOT': Object.freeze(['evidence-reactivated', 'failure-raised', 'new-user-turn', 'gate-armed']),
  // CCV2-R1 (M01A 45.2): checkpoint-superseded-unreferenced is the one
  // structural historical-transition cause (sealed generation boundary +
  // not active-root reachable + authority sufficiently complete).
  'WARM>COLD': Object.freeze(['exact-backing-established', 'failure-resolved', 'decision-superseded', 'transaction-aged', 'checkpoint-superseded-unreferenced']),
  'COLD>WARM': Object.freeze(['evidence-reactivated', 'resolution-weakened', 'failure-raised']),
  'COLD>HOT': Object.freeze(['evidence-reactivated']),
});

const TRANSITION_CAUSES = Object.freeze((() => {
  const set = new Set();
  for (const causes of Object.values(TIER_TRANSITIONS)) {
    for (const cause of causes) set.add(cause);
  }
  return Array.from(set).sort();
})());

// A08 retention-class compatibility (frozen mapping; A08 never modified).
const RETENTION_CLASSES = Object.freeze([
  'ACTIVE_REQUIRED',
  'CHECKPOINT_COVERED',
  'REHYDRATABLE',
  'DERIVED_DISCARDABLE',
  'NOT_ELIGIBLE',
]);

const RETENTION_COMPATIBILITY = Object.freeze({
  ACTIVE_REQUIRED: Object.freeze({ tiers: ['PINNED', 'HOT'], note: 'must remain directly available in the active continuation projection' }),
  CHECKPOINT_COVERED: Object.freeze({ tiers: ['WARM', 'COLD'], note: 'covered or durably reconstructible state; release additionally requires A07 post-build PASS plus persisted seal' }),
  REHYDRATABLE: Object.freeze({ tiers: ['WARM', 'COLD'], note: 'authoritative durable source can reconstruct the unit exactly when needed' }),
  DERIVED_DISCARDABLE: Object.freeze({ tiers: [], note: 'non-authoritative derived/cache material is not task memory and holds no tier' }),
  NOT_ELIGIBLE: Object.freeze({ tiers: ['PINNED', 'HOT', 'WARM'], note: 'cannot leave active context; never COLD or ARCHIVE' }),
});

// B04H: no caller-authoritative source status exists. External COLD requires
// a live B03-validated resolutionProof (see below). Any sourceStatus-shaped
// field is an unknown input and fails closed.
const PROOF_SOURCE_ROUTES = Object.freeze(['session', 'repository', 'artifact']);
const PROOF_ROUTE_TO_MODE = Object.freeze({
  session: 'exact-session-source',
  repository: 'exact-repository-source',
  artifact: 'exact-artifact-source',
});

// Advisory signals may be supplied for future use but have ZERO policy
// effect in B04. Recency/size/frequency/gloss/hint never decide the tier.
const ADVISORY_EXACT_KEYS = Object.freeze([
  'ageGenerations',
  'sizeBytes',
  'accessCount',
  'semanticGloss',
  'coldHint',
]);

const CLASSIFY_EXACT_KEYS = Object.freeze([
  'subjectKind',
  'page',
  'checkpoint',
  'elementRef',
  'expectedNamespace',
  'sources',
  'resolutionProof',
  'mandatoryCorrectness',
  'immediateRelevance',
  'exactPreservationRequired',
  'advisory',
  'archiveRef',
  // CCV2-R1: controller/reachability-owned requiredness (never relevance)
  // and the structural historical-transition provenance.
  'retentionRequired',
  'historicalTransition',
]);

// CCV2-R1 historical transition provenance (closed world).
const HISTORICAL_TRANSITION_REASONS = Object.freeze(['checkpoint-superseded-unreferenced']);
const HISTORICAL_TRANSITION_EXACT_KEYS = Object.freeze(['reason', 'supersededByGeneration']);

const ELEMENT_SECTIONS = Object.freeze([
  'requirement',
  'constraint',
  'decision',
  'verification',
  'failure',
  'continuation',
]);

const ELEMENT_REF_EXACT_KEYS = Object.freeze(['section', 'id', 'text']);
const ARCHIVE_REF_EXACT_KEYS = Object.freeze(['eventId', 'seq']);
const NAMESPACE_EXACT_KEYS = Object.freeze([
  'taskId',
  'taskInstanceId',
  'sessionId',
  'workspaceId',
  'repositoryId',
  'checkoutId',
]);

const DECISION_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'tier',
  'reasonCode',
  'exactness',
  'storageBehavior',
  'materializationPolicy',
  'materializationIntent',
  'requiresExactResolution',
  'exactResolutionMode',
  'subjectKind',
  'pageId',
  'pageKind',
  'contentHash',
  'namespace',
  'trust',
  'resolution',
  'deterministic',
  // CCV2-R1 optional members: present only when set (legacy decisions keep
  // byte-identical shape). retentionRequired is literal true on HOT/WARM
  // page decisions; historicalTransition rides only on COLD page decisions.
  'retentionRequired',
  'historicalTransition',
]);

const RESOLUTION_EXACT_KEYS = Object.freeze([
  'resolvable',
  'mode',
  'requiresExternalSource',
  'storedRehydratable',
  'durablySelfBacked',
]);

function failTier(code, detail) {
  throw new Error('context-memory-tier-' + code + (detail === undefined ? '' : ': ' + detail) + ' (KEEP)');
}

function unknownKeyOf(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkNamespaceShape(ns, what) {
  if (!isPlainObject(ns)) failTier('namespace-invalid', what + ' must be an object');
  const unknown = unknownKeyOf(ns, NAMESPACE_EXACT_KEYS);
  if (unknown !== null) failTier('unknown-field', what + '.' + unknown);
  for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
    if (typeof ns[key] !== 'string' || ns[key] === '') failTier('namespace-invalid', what + '.' + key + ' is required');
  }
}

function assertSameTask(page, expectedNamespace) {
  // Cross-task isolation: a foreign page is never classified into the
  // current task, even for byte-identical content. Deduplication never
  // confers access.
  for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
    if (page.namespace[key] !== expectedNamespace[key]) {
      failTier('namespace-mismatch', 'page belongs to ' + String(page.namespace[key]) + ' not ' + String(expectedNamespace[key]));
    }
  }
}

function assertSameCheckpointTask(checkpoint, expectedNamespace) {
  for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
    if (checkpoint[key] !== expectedNamespace[key]) {
      failTier('namespace-mismatch', 'checkpoint belongs to ' + String(checkpoint[key]) + ' not ' + String(expectedNamespace[key]));
    }
  }
}

function validateElementRef(checkpoint, elementRef, subjectKind) {
  if (!isPlainObject(elementRef)) failTier('element-ref-invalid', 'elementRef must be an object');
  const unknown = unknownKeyOf(elementRef, ELEMENT_REF_EXACT_KEYS);
  if (unknown !== null) failTier('unknown-field', 'elementRef.' + unknown);
  if (!ELEMENT_SECTIONS.includes(elementRef.section)) failTier('element-ref-invalid', 'unknown element section');
  const section = elementRef.section;
  if (section === 'requirement') {
    if (typeof elementRef.id !== 'string' || elementRef.id === '') failTier('element-ref-invalid', 'requirement elementRef.id is required');
    const req = (checkpoint.requirements || []).find((r) => r.id === elementRef.id);
    if (!req) failTier('element-ref-missing', 'requirement ' + elementRef.id + ' not present in checkpoint');
    if (subjectKind === 'active-requirement' && req.status !== 'active') {
      failTier('element-ref-status-mismatch', 'requirement ' + elementRef.id + ' status is ' + req.status + ', not active');
    }
    return;
  }
  if (section === 'constraint') {
    if (!Array.isArray(checkpoint.constraints) || checkpoint.constraints.length === 0) {
      failTier('element-ref-missing', 'checkpoint carries no active constraints');
    }
    if (elementRef.id !== undefined && elementRef.id !== null) {
      failTier('element-ref-invalid', 'constraint elementRef carries no id; use text');
    }
    if (elementRef.text !== undefined && elementRef.text !== null) {
      const hit = checkpoint.constraints.some((c) => c.text === String(elementRef.text));
      if (!hit) failTier('element-ref-missing', 'constraint text not present in checkpoint');
    }
    return;
  }
  if (section === 'decision') {
    if (typeof elementRef.id !== 'string' || elementRef.id === '') failTier('element-ref-invalid', 'decision elementRef.id is required');
    const dec = (checkpoint.decisions || []).find((d) => d.id === elementRef.id);
    if (!dec) failTier('element-ref-missing', 'decision ' + elementRef.id + ' not present in checkpoint');
    if (subjectKind === 'accepted-decision' && dec.status !== 'active') {
      failTier('element-ref-status-mismatch', 'decision ' + elementRef.id + ' status is ' + dec.status + ', not active');
    }
    return;
  }
  if (section === 'verification') {
    if (!checkpoint.verification || !Array.isArray(checkpoint.verification.outcomes) || checkpoint.verification.outcomes.length === 0) {
      failTier('element-ref-missing', 'checkpoint carries no verification outcomes');
    }
    return;
  }
  if (section === 'failure') {
    if (typeof elementRef.id !== 'string' || elementRef.id === '') failTier('element-ref-invalid', 'failure elementRef.id is required');
    const active = (checkpoint.failures && checkpoint.failures.activeFailures) || [];
    const hit = active.find((f) => f.id === elementRef.id);
    if (!hit) failTier('element-ref-missing', 'failure ' + elementRef.id + ' not active in checkpoint');
    return;
  }
  // continuation: unresolved approvals / current user intent live here.
  if (!checkpoint.continuation || !Array.isArray(checkpoint.continuation.unresolvedQuestions)) {
    failTier('element-ref-missing', 'checkpoint carries no continuation state');
  }
  if (subjectKind === 'unresolved-approval' && checkpoint.continuation.unresolvedQuestions.length === 0) {
    failTier('element-ref-missing', 'checkpoint carries no unresolved questions');
  }
}

function snapshotResolution(page, sources) {
  const inspected = rehydrationV2.inspectExactResolutionV2(page, sources === undefined ? {} : sources);
  return Object.freeze({
    resolvable: inspected.resolvable === true,
    mode: inspected.mode,
    requiresExternalSource: inspected.requiresExternalSource === true,
    storedRehydratable: inspected.storedRehydratable === true,
    durablySelfBacked: inspected.durablySelfBacked === true,
  });
}

// B04H: validate a caller-supplied exact-resolution proof against the page
// under classification. The proof must be a LIVE B03 RehydratedEvidenceV2
// object: validateRehydratedEvidenceV2 enforces the module-private brand
// (a Symbol no caller can mint or revive through serialization), the
// verified:true flag, content-hash agreement with the carried exact bytes,
// and a recomputed resultDigest. B04 additionally binds pageId,
// contentHash, namespace, mode, and source identity to THIS classification.
// Anything less is not proof. Returns the proof's resolution mode.
function validateResolutionProofV2(proof, page, expectedNamespace) {
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) {
    failTier('proof-invalid', 'resolutionProof must be a B03 rehydration result object');
  }
  const check = rehydrationV2.validateRehydratedEvidenceV2(proof);
  if (!check.valid) failTier('proof-invalid', check.reason || 'B03 proof validation failed');
  if (!PROOF_SOURCE_ROUTES.includes(proof.sourceRoute)) {
    failTier('proof-not-applicable', 'only external-route proofs authorize tier policy');
  }
  if (proof.pageId !== page.id) failTier('proof-binding-mismatch', 'proof belongs to another page');
  if (proof.contentHash !== page.contentHash) failTier('proof-binding-mismatch', 'proof binds another content revision');
  for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
    if (!proof.namespace || proof.namespace[key] !== page.namespace[key]) {
      failTier('proof-binding-mismatch', 'proof belongs to another task namespace');
    }
    if (expectedNamespace !== null && proof.namespace[key] !== expectedNamespace[key]) {
      failTier('proof-binding-mismatch', 'proof escapes the expected namespace');
    }
  }
  return PROOF_ROUTE_TO_MODE[proof.sourceRoute];
}

function brandDecision(fields) {
  const caps = TIER_CAPABILITIES[fields.tier];
  const decision = {
    schemaVersion: MEMORY_TIER_SCHEMA_VERSION,
    tier: fields.tier,
    reasonCode: fields.reasonCode,
    exactness: caps.exactness,
    storageBehavior: caps.storageBehavior,
    materializationPolicy: caps.materializationPolicy,
    materializationIntent: fields.materializationIntent === undefined ? null : fields.materializationIntent,
    requiresExactResolution: fields.requiresExactResolution === true,
    exactResolutionMode: fields.exactResolutionMode === undefined ? null : fields.exactResolutionMode,
    subjectKind: fields.subjectKind,
    pageId: fields.pageId === undefined ? null : fields.pageId,
    pageKind: fields.pageKind === undefined ? null : fields.pageKind,
    contentHash: fields.contentHash === undefined ? null : fields.contentHash,
    namespace: fields.namespace === undefined ? null : fields.namespace,
    trust: fields.trust === undefined ? null : fields.trust,
    resolution: fields.resolution === undefined ? null : fields.resolution,
    deterministic: true,
  };
  if (fields.retentionRequired === true) decision.retentionRequired = true;
  if (fields.historicalTransition !== undefined && fields.historicalTransition !== null) {
    decision.historicalTransition = Object.freeze({
      reason: fields.historicalTransition.reason,
      supersededByGeneration: fields.historicalTransition.supersededByGeneration,
    });
  }
  return Object.freeze(decision);
}

function validateHistoricalTransitionInput(value) {
  if (!isPlainObject(value)) failTier('unknown-field', 'historicalTransition must be an object');
  const unknown = unknownKeyOf(value, HISTORICAL_TRANSITION_EXACT_KEYS);
  if (unknown !== null) failTier('unknown-field', 'historicalTransition.' + unknown);
  if (!HISTORICAL_TRANSITION_REASONS.includes(value.reason)) failTier('unknown-cause', String(value.reason));
  if (!Number.isInteger(value.supersededByGeneration) || value.supersededByGeneration < 1) {
    failTier('unknown-field', 'historicalTransition.supersededByGeneration must be a positive integer');
  }
  return { reason: value.reason, supersededByGeneration: value.supersededByGeneration };
}

function namespaceEcho(ns) {
  // Metadata only: task/instance/session binding. No workspace paths, no
  // evidence text, no secrets.
  return Object.freeze({
    taskId: ns.taskId,
    taskInstanceId: ns.taskInstanceId,
    sessionId: ns.sessionId,
  });
}

/**
 * Deterministic tier classification over proven task-memory state.
 * Pure and read-only: inputs are never mutated.
 */
function classifyMemoryTierV2(input) {
  if (!isPlainObject(input)) failTier('unknown-field', 'input is required');
  const unknown = unknownKeyOf(input, CLASSIFY_EXACT_KEYS);
  if (unknown !== null) failTier('unknown-field', unknown);
  const subjectKind = input.subjectKind;
  if (typeof subjectKind !== 'string' || !SUBJECT_KINDS.includes(subjectKind)) {
    failTier('unknown-subject', String(subjectKind));
  }

  const mandatoryCorrectness = input.mandatoryCorrectness === undefined ? false : input.mandatoryCorrectness;
  if (typeof mandatoryCorrectness !== 'boolean') failTier('unknown-field', 'mandatoryCorrectness must be boolean');
  const immediateRelevance = input.immediateRelevance === undefined ? false : input.immediateRelevance;
  if (typeof immediateRelevance !== 'boolean') failTier('unknown-field', 'immediateRelevance must be boolean');
  const exactPreservationRequired = input.exactPreservationRequired === undefined ? false : input.exactPreservationRequired;
  if (typeof exactPreservationRequired !== 'boolean') failTier('unknown-field', 'exactPreservationRequired must be boolean');
  // CCV2-R1: requiredness is a controller/reachability boolean, distinct
  // from mandatoryCorrectness (prose/strings fail closed, never inferred).
  const retentionRequired = input.retentionRequired === undefined ? false : input.retentionRequired;
  if (typeof retentionRequired !== 'boolean') failTier('unknown-field', 'retentionRequired must be boolean');
  const hasTransition = input.historicalTransition !== undefined && input.historicalTransition !== null;
  const historicalTransition = hasTransition ? validateHistoricalTransitionInput(input.historicalTransition) : null;
  if (retentionRequired && !PAGE_SUBJECTS.includes(subjectKind)) {
    failTier('required-not-applicable', subjectKind + ' is not a historical page unit');
  }
  if (retentionRequired && mandatoryCorrectness) {
    failTier('required-mandatory-conflict', 'mandatory and retention-required are distinct authorities');
  }
  if (hasTransition && (retentionRequired || !PAGE_SUBJECTS.includes(subjectKind) || subjectKind === 'completed-tool-transaction')) {
    failTier('transition-not-applicable', 'historical transition applies only to unrequired historical page units');
  }
  // B04H: no caller-held status may claim exact-resolution authority.
  // mandatoryCorrectness stays a controller-asserted boolean (checked
  // above): any prose or string form already fails closed, so untrusted
  // evidence text can never set it.
  const hasProof = input.resolutionProof !== undefined && input.resolutionProof !== null;

  if (input.advisory !== undefined && input.advisory !== null) {
    // Advisory signals are accepted and IGNORED. Age, size, access count,
    // semantic gloss, and cold hints never decide the tier.
    if (!isPlainObject(input.advisory)) failTier('unknown-field', 'advisory must be an object');
    const unknownAdvisory = unknownKeyOf(input.advisory, ADVISORY_EXACT_KEYS);
    if (unknownAdvisory !== null) failTier('unknown-field', 'advisory.' + unknownAdvisory);
  }

  const hasPage = input.page !== undefined && input.page !== null;
  const hasCheckpoint = input.checkpoint !== undefined && input.checkpoint !== null;
  const hasArchiveRef = input.archiveRef !== undefined && input.archiveRef !== null;
  const hasSources = input.sources !== undefined && input.sources !== null;

  if (STATE_SUBJECTS.includes(subjectKind) && hasPage) {
    failTier('page-not-applicable', subjectKind + ' is authoritative structured state and carries no page');
  }
  if (STATE_SUBJECTS.includes(subjectKind) && hasProof) {
    failTier('proof-not-applicable', subjectKind + ' needs no exact-resolution proof');
  }
  if (subjectKind === 'archive-event' && (hasPage || hasCheckpoint || hasProof)) {
    failTier('page-not-applicable', 'archive-event is canonical history, not a ContextPage, checkpoint, or proof');
  }
  if (!PAGE_SUBJECTS.includes(subjectKind) && subjectKind !== 'archive-event' && hasSources && !hasPage) {
    failTier('sources-not-applicable', subjectKind + ' carries no exact-resolution sources');
  }
  if (hasSources && !isPlainObject(input.sources)) failTier('unknown-field', 'sources must be an object');

  let archiveEventId = null;
  if (subjectKind === 'archive-event') {
    if (hasArchiveRef) {
      if (!isPlainObject(input.archiveRef)) failTier('unknown-field', 'archiveRef must be an object');
      const unknownRef = unknownKeyOf(input.archiveRef, ARCHIVE_REF_EXACT_KEYS);
      if (unknownRef !== null) failTier('unknown-field', 'archiveRef.' + unknownRef);
      if (input.archiveRef.eventId !== undefined && input.archiveRef.eventId !== null) {
        archiveEventId = String(input.archiveRef.eventId);
      }
    }
    if (mandatoryCorrectness) {
      failTier('mandatory-archive-conflict', 'canonical history is never mandatory working state');
    }
    return brandDecision({
      tier: 'ARCHIVE',
      reasonCode: 'tier-archive-canonical-history',
      subjectKind,
      pageId: archiveEventId,
      namespace: input.expectedNamespace === undefined || input.expectedNamespace === null
        ? null
        : (() => { checkNamespaceShape(input.expectedNamespace, 'expectedNamespace'); return namespaceEcho(input.expectedNamespace); })(),
    });
  }
  if (hasArchiveRef) failTier('archive-ref-not-applicable', subjectKind + ' is not canonical history');

  // Checkpoint grounding: when supplied, the checkpoint is validated
  // verbatim through its own authority and the element pointer must exist.
  let checkpointNamespace = null;
  if (hasCheckpoint) {
    const check = checkpointV2.validateCheckpointV2(input.checkpoint);
    if (!check.valid) failTier('checkpoint-invalid', check.reasonCode || 'checkpoint failed validation');
    if (input.elementRef !== undefined && input.elementRef !== null) {
      validateElementRef(input.checkpoint, input.elementRef, subjectKind);
    }
    checkpointNamespace = namespaceEcho(input.checkpoint);
  } else if (input.elementRef !== undefined && input.elementRef !== null) {
    failTier('element-ref-without-checkpoint', 'elementRef requires its checkpoint');
  }

  if (input.expectedNamespace !== undefined && input.expectedNamespace !== null) {
    checkNamespaceShape(input.expectedNamespace, 'expectedNamespace');
    if (hasCheckpoint) assertSameCheckpointTask(input.checkpoint, input.expectedNamespace);
  }

  // PINNED hard rule: anything required for correctness of the next legal
  // continuation stays PINNED. Never demoted by age, size, access count,
  // semantic gloss, or cold hints (those live in advisory and are inert).
  if (mandatoryCorrectness) {
    return brandDecision({
      tier: 'PINNED',
      reasonCode: 'tier-pinned-correctness-mandatory',
      subjectKind,
      namespace: checkpointNamespace,
    });
  }

  switch (subjectKind) {
    case 'active-requirement':
      return brandDecision({
        tier: 'PINNED', reasonCode: 'tier-pinned-active-requirement', subjectKind, namespace: checkpointNamespace,
      });
    case 'active-constraint':
      return brandDecision({
        tier: 'PINNED', reasonCode: 'tier-pinned-active-constraint', subjectKind, namespace: checkpointNamespace,
      });
    case 'unresolved-approval':
      return brandDecision({
        tier: 'PINNED', reasonCode: 'tier-pinned-unresolved-approval', subjectKind, namespace: checkpointNamespace,
      });
    case 'open-tool-protocol':
      return brandDecision({
        tier: 'PINNED', reasonCode: 'tier-pinned-open-protocol', subjectKind, namespace: checkpointNamespace,
      });
    case 'mandatory-checkpoint-state':
      return brandDecision({
        tier: 'PINNED', reasonCode: 'tier-pinned-mandatory-state', subjectKind, namespace: checkpointNamespace,
      });
    case 'current-user-turn':
      return brandDecision({
        tier: 'HOT',
        reasonCode: 'tier-hot-current-user',
        subjectKind,
        namespace: checkpointNamespace,
        materializationIntent: exactPreservationRequired ? 'mandatory' : null,
      });
    case 'active-failure':
      return brandDecision({
        tier: 'HOT', reasonCode: 'tier-hot-active-failure', subjectKind, namespace: checkpointNamespace,
      });
    case 'accepted-decision':
      return brandDecision({
        tier: 'WARM', reasonCode: 'tier-warm-active-decision', subjectKind, namespace: checkpointNamespace,
      });
    case 'verification-state':
      return brandDecision({
        tier: 'WARM', reasonCode: 'tier-warm-verification-state', subjectKind, namespace: checkpointNamespace,
      });
    case 'failure-state':
      return brandDecision({
        tier: 'WARM', reasonCode: 'tier-warm-failure-state', subjectKind, namespace: checkpointNamespace,
      });
    default:
      break;
  }

  // Page-bearing subjects: completed-tool-transaction, historical-evidence,
  // resolved-failure, superseded-hypothesis.
  if (!hasPage) failTier('page-required', subjectKind + ' classifies a ContextPage');
  const pageCheck = pageV2.validateContextPageV2(input.page);
  if (!pageCheck.valid) failTier('page-invalid', pageCheck.reasonCode || 'page failed validation');
  const page = input.page;
  if (input.expectedNamespace !== undefined && input.expectedNamespace !== null) {
    assertSameTask(page, input.expectedNamespace);
  }
  const expectedNs = input.expectedNamespace === undefined || input.expectedNamespace === null
    ? null
    : input.expectedNamespace;
  const resolution = snapshotResolution(page, hasSources ? input.sources : {});
  const pageNamespace = namespaceEcho(page.namespace);
  // B04H: a supplied proof is bound here. Proof outside an external-route
  // COLD candidacy is not applicable and fails closed.
  let proofMode = null;
  if (hasProof) {
    if (subjectKind === 'completed-tool-transaction') {
      failTier('proof-not-applicable', 'settled transactions rest without exact-resolution proof');
    }
    proofMode = validateResolutionProofV2(input.resolutionProof, page, expectedNs);
    if (proofMode !== resolution.mode) {
      failTier('proof-mode-mismatch', 'proof route disagrees with page capability');
    }
  }

  if (subjectKind === 'completed-tool-transaction') {
    if (immediateRelevance) {
      return brandDecision({
        tier: 'HOT', reasonCode: 'tier-hot-immediate-transaction', subjectKind,
        pageId: page.id, pageKind: page.kind, contentHash: page.contentHash,
        namespace: pageNamespace, trust: page.provenance.trust, resolution,
        retentionRequired,
      });
    }
    return brandDecision({
      tier: 'WARM', reasonCode: 'tier-warm-settled-transaction', subjectKind,
      pageId: page.id, pageKind: page.kind, contentHash: page.contentHash,
      namespace: pageNamespace, trust: page.provenance.trust, resolution,
      retentionRequired,
    });
  }

  // CCV2-R1 (supersedes the C05H "byte-bearing non-tool history -> COLD"
  // outcome for REQUIRED units): a historical page that controller
  // reachability proves still required rests WARM with its exact bytes.
  if (retentionRequired) {
    return brandDecision({
      tier: 'WARM',
      reasonCode: 'tier-warm-retention-required',
      subjectKind,
      pageId: page.id,
      pageKind: page.kind,
      contentHash: page.contentHash,
      namespace: pageNamespace,
      trust: page.provenance.trust,
      resolution,
      retentionRequired: true,
    });
  }

  // COLD eligibility (B04H, frozen): old / non-immediate evidence +
  // proven exact recovery + not correctness-mandatory (mandatory already
  // returned PINNED above). Durably self-backed pages (durable-inline,
  // durable-blob) are structurally COLD-eligible under frozen B01/B02
  // durable-store semantics. External routes (exact-*-source) require a
  // live B03-validated resolutionProof bound to this page; structural
  // source capability alone - however complete - yields WARM.
  // Anything else fails toward WARM (more context), never toward DROP.
  if (resolution.durablySelfBacked && resolution.mode !== null) {
    return brandDecision({
      tier: 'COLD',
      reasonCode: 'tier-cold-exact-history',
      subjectKind,
      requiresExactResolution: true,
      exactResolutionMode: resolution.mode,
      pageId: page.id,
      pageKind: page.kind,
      contentHash: page.contentHash,
      namespace: pageNamespace,
      trust: page.provenance.trust,
      resolution,
      historicalTransition,
    });
  }
  if (proofMode !== null) {
    return brandDecision({
      tier: 'COLD',
      reasonCode: 'tier-cold-source-resolvable',
      subjectKind,
      requiresExactResolution: true,
      exactResolutionMode: proofMode,
      pageId: page.id,
      pageKind: page.kind,
      contentHash: page.contentHash,
      namespace: pageNamespace,
      trust: page.provenance.trust,
      resolution,
      historicalTransition,
    });
  }
  // A transition is recorded only when the unit actually reaches COLD; a
  // unit without exact recovery stays WARM and carries no transition.
  return brandDecision({
    tier: 'WARM',
    reasonCode: 'tier-keep-more-context-no-exact-resolution',
    subjectKind,
    pageId: page.id,
    pageKind: page.kind,
    contentHash: page.contentHash,
    namespace: pageNamespace,
    trust: page.provenance.trust,
    resolution,
  });
}

/**
 * Closed-world decision validator. Unknown tiers fail closed; the
 * tier/capability triple must agree exactly.
 */
function validateMemoryTierDecisionV2(decision) {
  if (!isPlainObject(decision)) return { valid: false, reasonCode: 'context-memory-tier-decision-invalid' };
  const unknown = unknownKeyOf(decision, DECISION_EXACT_KEYS);
  if (unknown !== null) return { valid: false, reasonCode: 'context-memory-tier-unknown-field' };
  if (decision.schemaVersion !== MEMORY_TIER_SCHEMA_VERSION) {
    return { valid: false, reasonCode: 'context-memory-tier-schema-mismatch' };
  }
  if (!MEMORY_TIERS.includes(decision.tier)) return { valid: false, reasonCode: 'context-memory-tier-unknown-tier' };
  if (!REASON_CODES.includes(decision.reasonCode)) return { valid: false, reasonCode: 'context-memory-tier-unknown-reason' };
  const caps = TIER_CAPABILITIES[decision.tier];
  if (decision.exactness !== caps.exactness
    || decision.storageBehavior !== caps.storageBehavior
    || decision.materializationPolicy !== caps.materializationPolicy) {
    return { valid: false, reasonCode: 'context-memory-tier-capability-mismatch' };
  }
  if (decision.materializationIntent !== null && decision.materializationIntent !== 'mandatory') {
    return { valid: false, reasonCode: 'context-memory-tier-intent-invalid' };
  }
  if (decision.materializationIntent === 'mandatory'
    && !(decision.tier === 'HOT' && decision.subjectKind === 'current-user-turn')) {
    return { valid: false, reasonCode: 'context-memory-tier-intent-misplaced' };
  }
  if (decision.tier === 'PINNED' && decision.requiresExactResolution !== false) {
    return { valid: false, reasonCode: 'context-memory-tier-pinned-needs-no-resolution' };
  }
  if (decision.tier === 'COLD') {
    if (decision.requiresExactResolution !== true
      || typeof decision.exactResolutionMode !== 'string'
      || !rehydrationV2.EXACT_RESOLUTION_MODES.includes(decision.exactResolutionMode)) {
      return { valid: false, reasonCode: 'context-memory-tier-cold-needs-resolution' };
    }
  } else if (decision.requiresExactResolution !== false || decision.exactResolutionMode !== null) {
    return { valid: false, reasonCode: 'context-memory-tier-resolution-misplaced' };
  }
  if (!SUBJECT_KINDS.includes(decision.subjectKind)) return { valid: false, reasonCode: 'context-memory-tier-unknown-subject' };
  if (decision.pageId !== null && (typeof decision.pageId !== 'string' || decision.pageId === '')) {
    return { valid: false, reasonCode: 'context-memory-tier-page-id-invalid' };
  }
  if (decision.pageKind !== null && typeof decision.pageKind !== 'string') {
    return { valid: false, reasonCode: 'context-memory-tier-page-kind-invalid' };
  }
  if (decision.contentHash !== null && !/^[0-9a-f]{64}$/.test(String(decision.contentHash))) {
    return { valid: false, reasonCode: 'context-memory-tier-content-hash-invalid' };
  }
  if (decision.namespace !== null) {
    if (!isPlainObject(decision.namespace)) return { valid: false, reasonCode: 'context-memory-tier-namespace-invalid' };
    for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
      if (typeof decision.namespace[key] !== 'string' || decision.namespace[key] === '') {
        return { valid: false, reasonCode: 'context-memory-tier-namespace-invalid' };
      }
    }
  }
  if (decision.trust !== null && typeof decision.trust !== 'string') {
    return { valid: false, reasonCode: 'context-memory-tier-trust-invalid' };
  }
  if (decision.resolution !== null) {
    if (!isPlainObject(decision.resolution)) return { valid: false, reasonCode: 'context-memory-tier-resolution-invalid' };
    const unknownRes = unknownKeyOf(decision.resolution, RESOLUTION_EXACT_KEYS);
    if (unknownRes !== null) return { valid: false, reasonCode: 'context-memory-tier-unknown-field' };
    if (typeof decision.resolution.resolvable !== 'boolean'
      || typeof decision.resolution.requiresExternalSource !== 'boolean'
      || typeof decision.resolution.storedRehydratable !== 'boolean'
      || typeof decision.resolution.durablySelfBacked !== 'boolean') {
      return { valid: false, reasonCode: 'context-memory-tier-resolution-invalid' };
    }
    if (decision.resolution.mode !== null
      && !rehydrationV2.EXACT_RESOLUTION_MODES.includes(decision.resolution.mode)) {
      return { valid: false, reasonCode: 'context-memory-tier-resolution-mode-invalid' };
    }
  }
  if (decision.deterministic !== true) return { valid: false, reasonCode: 'context-memory-tier-determinism-invalid' };
  // CCV2-R1 optional members (present only when set).
  if (Object.prototype.hasOwnProperty.call(decision, 'retentionRequired')) {
    if (decision.retentionRequired !== true
      || (decision.tier !== 'HOT' && decision.tier !== 'WARM')
      || !PAGE_SUBJECTS.includes(decision.subjectKind)
      || decision.pageId === null) {
      return { valid: false, reasonCode: 'context-memory-tier-retention-required-invalid' };
    }
  }
  if (decision.reasonCode === 'tier-warm-retention-required' && decision.retentionRequired !== true) {
    return { valid: false, reasonCode: 'context-memory-tier-retention-required-invalid' };
  }
  if (Object.prototype.hasOwnProperty.call(decision, 'historicalTransition')) {
    const transition = decision.historicalTransition;
    if (!isPlainObject(transition)
      || unknownKeyOf(transition, HISTORICAL_TRANSITION_EXACT_KEYS) !== null
      || !HISTORICAL_TRANSITION_REASONS.includes(transition.reason)
      || !Number.isInteger(transition.supersededByGeneration) || transition.supersededByGeneration < 1
      || decision.tier !== 'COLD'
      || !PAGE_SUBJECTS.includes(decision.subjectKind)) {
      return { valid: false, reasonCode: 'context-memory-tier-historical-transition-invalid' };
    }
  }
  return { valid: true, reasonCode: 'context-memory-tier-decision-valid' };
}

/**
 * Bounded human-readable description. Metadata only: page id, hash prefix,
 * resolution mode, policy. Never evidence text, never secrets.
 */
function describeMemoryTierDecisionV2(decision) {
  const check = validateMemoryTierDecisionV2(decision);
  if (!check.valid) throw new Error(String(check.reasonCode) + ': decision is not describable (KEEP)');
  const hashPrefix = decision.contentHash === null ? 'none' : String(decision.contentHash).slice(0, 16);
  const pagePart = decision.pageId === null ? 'none' : String(decision.pageId);
  const modePart = decision.exactResolutionMode === null ? 'none' : String(decision.exactResolutionMode);
  const nsPart = decision.namespace === null ? 'none' : String(decision.namespace.taskInstanceId);
  return (
    'tier=' + decision.tier
    + ' reason=' + decision.reasonCode
    + ' subject=' + decision.subjectKind
    + ' page=' + pagePart
    + ' hash=' + hashPart(hashPrefix)
    + ' mode=' + modePart
    + ' policy=' + decision.materializationPolicy
    + ' ns=' + nsPart
  );
}

function hashPart(prefix) {
  return prefix;
}

/**
 * Static tier capabilities: storage/materialization behavior a tier permits.
 */
function deriveTierCapabilitiesV2(tier) {
  if (!MEMORY_TIERS.includes(tier)) failTier('unknown-tier', String(tier));
  const caps = TIER_CAPABILITIES[tier];
  return Object.freeze({
    tier,
    exactness: caps.exactness,
    storageBehavior: caps.storageBehavior,
    materializationPolicy: caps.materializationPolicy,
  });
}

/**
 * Legal tier-transition check with deterministic cause codes. ARCHIVE is
 * never a transition endpoint. Pure: no state is read or written.
 */
function validateTierTransitionV2(input) {
  if (!isPlainObject(input)) failTier('unknown-field', 'input is required');
  const unknown = unknownKeyOf(input, ['from', 'to', 'cause']);
  if (unknown !== null) failTier('unknown-field', unknown);
  if (!MEMORY_TIERS.includes(input.from)) failTier('unknown-tier', String(input.from));
  if (!MEMORY_TIERS.includes(input.to)) failTier('unknown-tier', String(input.to));
  if (typeof input.cause !== 'string' || !TRANSITION_CAUSES.includes(input.cause)) {
    failTier('unknown-cause', String(input.cause));
  }
  if (input.from === 'ARCHIVE' || input.to === 'ARCHIVE') {
    return Object.freeze({ valid: false, reasonCode: 'context-memory-tier-transition-archive-immobile' });
  }
  if (input.from === input.to) {
    return Object.freeze({ valid: true, reasonCode: 'context-memory-tier-transition-steady' });
  }
  const allowed = TIER_TRANSITIONS[input.from + '>' + input.to];
  if (allowed === undefined || !allowed.includes(input.cause)) {
    return Object.freeze({ valid: false, reasonCode: 'context-memory-tier-transition-illegal' });
  }
  return Object.freeze({ valid: true, reasonCode: 'context-memory-tier-transition-legal' });
}

/**
 * A08 retention compatibility: the B04 tier must never contradict the
 * frozen A08 retention class for the same applicability state. Read-only
 * mapping; A08 is never modified.
 */
function checkRetentionCompatibilityV2(retentionClass, tier) {
  if (!RETENTION_CLASSES.includes(retentionClass)) failTier('unknown-retention-class', String(retentionClass));
  if (!MEMORY_TIERS.includes(tier)) failTier('unknown-tier', String(tier));
  if (tier === 'ARCHIVE') {
    return Object.freeze({
      compatible: false,
      reasonCode: 'context-memory-tier-retention-archive-outside',
      note: 'canonical history is outside A08 active-context retention planning',
    });
  }
  const entry = RETENTION_COMPATIBILITY[retentionClass];
  if (entry.tiers.includes(tier)) {
    return Object.freeze({ compatible: true, reasonCode: 'context-memory-tier-retention-compatible', note: entry.note });
  }
  return Object.freeze({
    compatible: false,
    reasonCode: 'context-memory-tier-retention-contradiction',
    note: retentionClass + ' forbids ' + tier + ': ' + entry.note,
  });
}

module.exports = {
  MEMORY_TIER_SCHEMA_VERSION,
  MEMORY_TIERS,
  SUBJECT_KINDS,
  REASON_CODES,
  EXACTNESS_VALUES,
  STORAGE_BEHAVIORS,
  MATERIALIZATION_POLICIES,
  TRANSITION_CAUSES,
  RETENTION_CLASSES,
  HISTORICAL_TRANSITION_REASONS,
  classifyMemoryTierV2,
  validateMemoryTierDecisionV2,
  describeMemoryTierDecisionV2,
  deriveTierCapabilitiesV2,
  validateTierTransitionV2,
  checkRetentionCompatibilityV2,
};
