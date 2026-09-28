'use strict';
/**
 * ContextViewV2.cjs - CCV2-C01 ContextView contract production authority.
 *
 * ONE authority for the V2 ContextView contract: schema, creation,
 * closed-world validation, canonical serialization, deterministic view
 * identity, full-view integrity digest, namespace/checkpoint/snapshot
 * binding, tier/provenance preservation, mandatory-manifest completeness,
 * budget-shape contract, compilation-trace shape, and disposable semantics.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (C01 freeze record). C01 answers "what exact disposable model-facing
 * working set was compiled for ONE inference" and NOTHING else:
 *
 *   Checkpoint         = authoritative task state (TaskController/A03).
 *   ContextPage        = durable exact historical evidence descriptor (B01).
 *   MemoryTierDecision = deterministic memory policy (B04).
 *   ContextView        = disposable model-facing working set for ONE
 *                        inference (here).
 *
 * A ContextView is NOT task truth, durability proof, verification
 * authority, completion authority, retention authority, EvidenceRef
 * authority, a checkpoint replacement, or canonical history. Deleting
 * every ContextView loses zero durable task truth.
 *
 * Frozen formulas:
 *
 *   entryId = 'cxm_' + sha256Hex(UTF-8('nexus/context-view-material/v1' LF
 *               section LF tier LF sourceType LF sourceId LF contentHash))
 *               .slice(0, 32)
 *
 *   viewId  = 'cxv_' + sha256Hex(UTF-8('nexus/context-view/v1' LF
 *               canonicalJson(identityBody))).slice(0, 32)
 *             identityBody = { namespace, checkpointGeneration,
 *               checkpointId, checkpointContentHash, snapshotRevision,
 *               turnRef, compilerPolicyRevision,
 *               budget:{hardMax,target,used},
 *               mandatoryRefs (view order),
 *               materialized (view order: pinned,hot,warm,materializedCold
 *                 as {section,id,sourceId,contentHash,tier}),
 *               referenced (view order as {pageId,contentHash}) }
 *             The compilation trace is observability, NOT identity: two
 *             views differing only in trace share a viewId and differ in
 *             viewDigest.
 *
 *   viewDigest = sha256Hex(UTF-8('nexus/context-view-digest/v1' LF
 *                canonicalJson(view WITHOUT id + viewDigest)))
 *
 * Creation purity: identical canonical input -> byte-identical view
 * (same id, same digest, same canonical serialization). No clock reads,
 * no randomness, no process identity, no filesystem mtime, no queries
 * against live TaskController state.
 *
 *   NOT implemented here (C02+): Context Compiler, candidate selection,
 *   retrieval, lexical/file/symbol search, embeddings, semantic
 *   retrieval, reranking, budget allocation, compression, prompt layout,
 *   DECIDE, JEV/Laya, root-model prompt rendering. This module performs
 *   NO search, NO packing, NO compression, and persists NOTHING.
 *   Pre-freeze C05 representation extension (section 36): a materialized
 *   entry may carry ONE optional 'representation' binding separating
 *   source identity (sourcePageId/sourceContentHash, bound to the B04
 *   decision) from shown identity (representationHash/contentHash, bound
 *   to the exact shown bytes). Entries without it are legacy EXACT with
 *   byte-identical identity semantics to before.
 *   The architecture baseline names this section 'retrievedPages'; C01
 *   freezes the canonical field name 'materializedCold' with that exact
 *   meaning: exact COLD material already chosen by a future compiler.
 *   C01 itself performs no retrieval. A top-level 'retrievedPages' key
 *   is rejected as unknown (use 'materializedCold').
 */

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const trustV2 = require('./ContextTrustV2.cjs');
const pageV2 = require('./ContextPageV2.cjs');
const tierV2 = require('./ContextMemoryTierV2.cjs');
const rehydrationV2 = require('./ContextEvidenceRehydrationV2.cjs');

const CONTEXT_VIEW_SCHEMA_VERSION = 1;
const CONTEXT_VIEW_ID_DOMAIN_V1 = 'nexus/context-view/v1';
const CONTEXT_VIEW_DIGEST_DOMAIN_V1 = 'nexus/context-view-digest/v1';
const CONTEXT_VIEW_MATERIAL_DOMAIN_V1 = 'nexus/context-view-material/v1';
const CONTEXT_VIEW_ID_PREFIX = 'cxv_';
const CONTEXT_VIEW_ENTRY_PREFIX = 'cxm_';

// Frozen compiler-policy revision namespace seed. C01 freezes the FIELD;
// C02 supplies real policy revisions. The placeholder below is the only
// C01-known value and exists for contract tests, never as a compiler.
const CONTEXT_VIEW_COMPILER_POLICY_SEED = 'context-compiler-v1';

// Closed-world section order (frozen). PINNED first, referenced COLD last.
// Within a section the compiler-chosen order is PRESERVED (source order
// is semantic, e.g. conversation order); sections themselves are never
// reordered. Order is identity-relevant: reordering changes viewId.
const VIEW_SECTIONS = Object.freeze(['pinned', 'hot', 'warm', 'materializedCold']);

// Section -> required materialized tier (frozen tier-preservation rule).
const SECTION_TIERS = Object.freeze({
  pinned: 'PINNED',
  hot: 'HOT',
  warm: 'WARM',
  materializedCold: 'COLD',
});

// Materialized tiers. ARCHIVE is deliberately absent: canonical history
// is recovery-only and must never become normal model-facing content,
// materialized or referenced.
const MATERIAL_TIERS = Object.freeze(['PINNED', 'HOT', 'WARM', 'COLD']);

// Closed-world materialized source types (frozen).
const MATERIAL_SOURCE_TYPES = Object.freeze([
  'checkpoint-state',
  'current-turn',
  'context-page',
  'rehydrated-evidence',
  'runtime-state',
]);

// Page-backed source types: the entry represents a durable ContextPage
// and must bind a page-bearing B04 decision (pageId/contentHash/trust).
const PAGE_BACKED_SOURCES = Object.freeze(['context-page', 'rehydrated-evidence']);

// State-backed source types: the entry represents authoritative structured
// state or live runtime state and must bind a page-less B04 decision.
const STATE_BACKED_SOURCES = Object.freeze(['checkpoint-state', 'current-turn', 'runtime-state']);

// Full-checkpoint representation marker. At most one entry per view may
// carry sourceType 'checkpoint-state' with this sourceId (latest
// checkpoint exactly once). Element slices use
// 'checkpoint:<section>:<element-id>' and are distinct sources.
const CHECKPOINT_FULL_SOURCE_ID = 'checkpoint:full';

// Closed-world mandatory-ref kinds (frozen).
const MANDATORY_REF_KINDS = Object.freeze([
  'checkpoint-requirement',
  'checkpoint-constraint',
  'checkpoint-full',
  'checkpoint-element',
  'current-turn',
  'tool-protocol',
  'page-evidence',
]);

// Closed-world trace actions (frozen, plus one C05 extension). The trace
// records what a future compiler claims it did; it authorizes nothing.
// C05 (CCV2-C05 compression ladder) adds exactly one action, 'STRUCTURE',
// for deterministic typed structured projections. EXTRACT remains reserved
// for source-exact substrings, LOAD for exact materialization, REFERENCE
// for COLD reference fallback, SKIP for omission, PIN for mandatory
// pinning. A STRUCTURED projection recorded as EXTRACT would falsely
// claim source-substring semantics, so the honest minimal extension is
// one new verb (see docs/architecture/context-compaction-v2.md section 36).
const TRACE_ACTIONS = Object.freeze(['PIN', 'LOAD', 'EXTRACT', 'STRUCTURE', 'REFERENCE', 'SKIP']);

// External exact-resolution modes (frozen B03H taxonomy): COLD entries
// with one of these modes were NOT durably self-backed and must carry a
// fresh B03 evidence binding record (C01 validates binding agreement;
// it never rehydrates and never vouches for freshness itself).
const EXTERNAL_RESOLUTION_MODES = Object.freeze([
  'exact-session-source',
  'exact-repository-source',
  'exact-artifact-source',
]);

// B04 subject kinds that claim a balanced tool-protocol transaction. A
// materialized entry bound to one of these decisions MUST carry a
// balanced toolTransaction unit; C01 detects invalid supplied units,
// it never discovers protocol state.
const TOOL_PROTOCOL_SUBJECTS = Object.freeze(['open-tool-protocol', 'completed-tool-transaction']);

// Structural bounds (frozen schema-safety bounds, NOT the C04 model
// token budget). Large exact evidence belongs behind COLD/reference
// backing, never in unbounded inline fields.
const VIEW_BOUNDS = Object.freeze({
  taskId: 256,
  taskInstanceId: 256,
  sessionId: 256,
  workspaceId: 512,
  repositoryId: 256,
  checkoutId: 256,
  sectionEntriesMax: 256,
  referencedColdMax: 512,
  traceEntriesMax: 1024,
  mandatoryRefsMax: 256,
  exactTextMaxChars: 8192,
  sourceIdMaxChars: 512,
  compilerPolicyRevisionMaxChars: 128,
  turnIdMaxChars: 256,
  reasonCodeMaxChars: 128,
  providerMaxChars: 128,
  callIdMaxChars: 256,
  sourceIdentityMaxChars: 600,
  viewMaxBytes: 1048576,
});

const VIEW_ID_PATTERN = /^cxv_[0-9a-f]{32}$/;
const ENTRY_ID_PATTERN = /^cxm_[0-9a-f]{32}$/;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const CHECKPOINT_ID_PATTERN = /^ccp_[0-9a-f]{32}$/;
const PAGE_ID_PATTERN = /^cxp_[0-9a-f]{32}$/;

// ---- closed-world exact keys (frozen) ----
const VIEW_TOP_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'id', 'namespace', 'checkpointBinding', 'turnRef',
  'pinned', 'hot', 'warm', 'materializedCold', 'referencedColdPages',
  'tokenBudget', 'compilerPolicyRevision', 'compilationTrace',
  'mandatoryRefs', 'viewDigest', 'disposable',
]);
const VIEW_NAMESPACE_EXACT_KEYS = Object.freeze([
  'taskId', 'taskInstanceId', 'sessionId', 'workspaceId',
  'repositoryId', 'checkoutId',
]);
const VIEW_CHECKPOINT_BINDING_EXACT_KEYS = Object.freeze([
  'checkpointGeneration', 'checkpointId', 'checkpointContentHash', 'snapshotRevision',
]);
const VIEW_TURN_REF_EXACT_KEYS = Object.freeze(['turnId', 'revision']);
const MATERIAL_ENTRY_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'id', 'tier', 'sourceType', 'sourceId', 'contentHash',
  'provenance', 'mediaType', 'exactText', 'mandatory', 'tierDecision',
  'evidence', 'toolTransaction', 'representation',
]);

// C05 model-facing representation contract (CCV2-C05 compression ladder).
// An entry WITHOUT 'representation' is legacy EXACT: contentHash binds the
// source bytes shown to the model and the B04 tier decision binds the same
// hash. An entry WITH 'representation' is a lossy deterministic projection:
// contentHash binds the exact representation bytes shown to the model
// (representationHash), while sourceContentHash binds the canonical exact
// backing evidence (and agrees with the B04 tier decision). The two hashes
// MUST differ for lossy kinds, so a compressed representation can never
// claim the source hash (see section 36). 'representation' is absent
// (not null) on legacy EXACT entries, so frozen canonical bytes, view ids,
// and digests of representation-free views are byte-identical to before.
const REPRESENTATION_KINDS = Object.freeze(['EXACT', 'EXTRACTIVE', 'STRUCTURED']);
const REPRESENTATION_EXACT_KEYS = Object.freeze([
  'kind', 'sourcePageId', 'sourceContentHash', 'representationHash',
]);
const MATERIAL_EVIDENCE_EXACT_KEYS = Object.freeze([
  'pageId', 'contentHash', 'sourceRoute', 'mediaType', 'sourceIdentity',
  'resultDigest', 'verified', 'namespace', 'provenance',
]);
const MATERIAL_EVIDENCE_NAMESPACE_EXACT_KEYS = Object.freeze([
  'taskId', 'taskInstanceId', 'sessionId',
]);
const MATERIAL_TOOL_TRANSACTION_EXACT_KEYS = Object.freeze([
  'callId', 'callPresent', 'resultPresent',
]);
const COLD_REFERENCE_EXACT_KEYS = Object.freeze([
  'pageId', 'contentHash', 'evidenceId', 'kind', 'provenance',
  'exactResolutionMode', 'namespace', 'tierDecision',
]);
const COLD_REFERENCE_NAMESPACE_EXACT_KEYS = Object.freeze([
  'taskId', 'taskInstanceId', 'sessionId',
]);
const BUDGET_EXACT_KEYS = Object.freeze(['hardMax', 'target', 'used']);
const TRACE_ENTRY_EXACT_KEYS = Object.freeze([
  'pageId', 'action', 'reasonCode', 'deterministic', 'provider', 'confidence',
]);
const MANDATORY_REF_EXACT_KEYS = Object.freeze(['sourceId', 'kind', 'contentHash']);

// Keys that must never appear in a ContextView. Closed-world validation
// already rejects every unknown key; retrieval/packing/compression/
// rendering dimensions are named explicitly because they belong to C02+.
const FORBIDDEN_VIEW_KEYS = Object.freeze([
  'query', 'searchText', 'similarity', 'topK', 'embedding', 'embeddings',
  'candidates', 'ranking', 'rerank', 'packed', 'packing',
  'compressed', 'summary', 'summaries', 'messages', 'prompt',
  'retrievedPages',
]);

function failView(reason, detail) {
  throw new Error('context-view-' + reason + (detail === undefined ? '' : ': ' + detail) + ' (DISCARDABLE)');
}

function unknownKeyOf(value, allowedKeys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) return key;
  }
  return null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256HexUtf8(text) {
  return checkpointV2.sha256HexUtf8(String(text));
}

function byteLengthUtf8(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

function isBoundedString(value, max, allowEmpty) {
  if (typeof value !== 'string') return false;
  if (!allowEmpty && value === '') return false;
  return value.length <= max;
}

function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalDeepEqual(a, b) {
  return canonicalJsonOf(a) === canonicalJsonOf(b);
}

// ---- deterministic identity primitives (frozen) ----

function deriveMaterialEntryIdV2(section, tier, sourceType, sourceId, contentHash) {
  const joined = [
    CONTEXT_VIEW_MATERIAL_DOMAIN_V1, section, tier, sourceType, sourceId, contentHash,
  ].join('\n');
  return CONTEXT_VIEW_ENTRY_PREFIX + sha256HexUtf8(joined).slice(0, 32);
}

function identityBodyOf(viewWithoutIdentity) {
  const materialized = [];
  for (const section of VIEW_SECTIONS) {
    for (const entry of viewWithoutIdentity[section]) {
      const record = {
        section,
        id: entry.id,
        sourceId: entry.sourceId,
        contentHash: entry.contentHash,
        tier: entry.tier,
      };
      // C05: a lossy representation binds its source identity into the
      // view id explicitly. Representation-free (EXACT) entries produce
      // byte-identical identity bodies to before (frozen view ids kept).
      if (entry.representation !== null && entry.representation !== undefined) {
        record.representationKind = entry.representation.kind;
        record.sourceContentHash = entry.representation.sourceContentHash;
      }
      materialized.push(record);
    }
  }
  return {
    namespace: viewWithoutIdentity.namespace,
    checkpointGeneration: viewWithoutIdentity.checkpointBinding.checkpointGeneration,
    checkpointId: viewWithoutIdentity.checkpointBinding.checkpointId,
    checkpointContentHash: viewWithoutIdentity.checkpointBinding.checkpointContentHash,
    snapshotRevision: viewWithoutIdentity.checkpointBinding.snapshotRevision,
    turnRef: viewWithoutIdentity.turnRef,
    compilerPolicyRevision: viewWithoutIdentity.compilerPolicyRevision,
    budget: viewWithoutIdentity.tokenBudget,
    mandatoryRefs: viewWithoutIdentity.mandatoryRefs,
    materialized,
    referenced: viewWithoutIdentity.referencedColdPages.map((ref) => ({
      pageId: ref.pageId,
      contentHash: ref.contentHash,
    })),
  };
}

function deriveContextViewIdV2(view) {
  if (!isPlainObject(view)) failView('unknown-field', 'view is required');
  if (!isPlainObject(view.namespace) || !isPlainObject(view.checkpointBinding)
    || !isPlainObject(view.tokenBudget) || !Array.isArray(view.mandatoryRefs)
    || !Array.isArray(view.referencedColdPages)
    || VIEW_SECTIONS.some((section) => !Array.isArray(view[section]))) {
    failView('unknown-field', 'view is structurally incomplete');
  }
  const body = identityBodyOf(view);
  return CONTEXT_VIEW_ID_PREFIX + sha256HexUtf8(
    CONTEXT_VIEW_ID_DOMAIN_V1 + '\n' + canonicalJsonOf(body),
  ).slice(0, 32);
}

function viewWithoutIdentity(view) {
  const copy = {};
  for (const key of Object.keys(view)) {
    if (key === 'id' || key === 'viewDigest') continue;
    copy[key] = view[key];
  }
  return copy;
}

function deriveContextViewDigestV2(view) {
  if (!isPlainObject(view)) failView('unknown-field', 'view is required');
  return sha256HexUtf8(
    CONTEXT_VIEW_DIGEST_DOMAIN_V1 + '\n' + canonicalJsonOf(viewWithoutIdentity(view)),
  );
}

function canonicalizeContextViewV2(view) {
  const check = validateContextViewV2(view);
  if (!check.valid) failView(check.reason, 'cannot canonicalize an invalid view');
  return canonicalJsonOf(view);
}

// ---- namespace / binding validation ----

function validateViewNamespace(namespace) {
  if (!isPlainObject(namespace)) return 'context-view-namespace-invalid';
  if (unknownKeyOf(namespace, VIEW_NAMESPACE_EXACT_KEYS) !== null) {
    return 'context-view-unknown-field';
  }
  if (!isBoundedString(namespace.taskId, VIEW_BOUNDS.taskId, false)) return 'context-view-namespace-invalid';
  if (!isBoundedString(namespace.taskInstanceId, VIEW_BOUNDS.taskInstanceId, false)) {
    return 'context-view-namespace-invalid';
  }
  if (!isBoundedString(namespace.sessionId, VIEW_BOUNDS.sessionId, false)) return 'context-view-namespace-invalid';
  if (!isBoundedString(namespace.workspaceId, VIEW_BOUNDS.workspaceId, false)) {
    return 'context-view-namespace-invalid';
  }
  if (namespace.repositoryId !== null && namespace.repositoryId !== undefined
    && !isBoundedString(String(namespace.repositoryId), VIEW_BOUNDS.repositoryId, true)) {
    return 'context-view-namespace-invalid';
  }
  if (namespace.checkoutId !== null && namespace.checkoutId !== undefined
    && !isBoundedString(String(namespace.checkoutId), VIEW_BOUNDS.checkoutId, true)) {
    return 'context-view-namespace-invalid';
  }
  return null;
}

function namespaceTripleMatches(viewNamespace, triple, what) {
  if (!isPlainObject(triple)) return what + ' namespace must be an object';
  for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
    if (triple[key] !== viewNamespace[key]) return what + ' escapes the view namespace';
  }
  return null;
}

function validateCheckpointBinding(binding) {
  if (!isPlainObject(binding)) return 'context-view-checkpoint-binding-invalid';
  if (unknownKeyOf(binding, VIEW_CHECKPOINT_BINDING_EXACT_KEYS) !== null) {
    return 'context-view-unknown-field';
  }
  if (!Number.isInteger(binding.checkpointGeneration) || binding.checkpointGeneration < 1) {
    return 'context-view-checkpoint-binding-invalid';
  }
  if (typeof binding.checkpointId !== 'string' || !CHECKPOINT_ID_PATTERN.test(binding.checkpointId)) {
    return 'context-view-checkpoint-binding-invalid';
  }
  if (typeof binding.checkpointContentHash !== 'string'
    || !CONTENT_HASH_PATTERN.test(binding.checkpointContentHash)) {
    return 'context-view-checkpoint-binding-invalid';
  }
  // Snapshot binding reuses frozen A05 revision semantics: the binding is
  // the snapshot revisionDigest (sha256 hex), never a second snapshot
  // system. The view carries it as compilation provenance only; it owns
  // no freshness authority (C02/C07 decide stale -> rebuild). Legacy
  // checkpoints without A05 binding carry an explicit null (binding
  // where available, never an invented revision).
  if (binding.snapshotRevision === null) return null;
  if (typeof binding.snapshotRevision !== 'string'
    || !CONTENT_HASH_PATTERN.test(binding.snapshotRevision)) {
    return 'context-view-snapshot-binding-invalid';
  }
  return null;
}

function validateTurnRef(turnRef) {
  if (turnRef === null || turnRef === undefined) return null;
  if (!isPlainObject(turnRef)) return 'context-view-turn-ref-invalid';
  if (unknownKeyOf(turnRef, VIEW_TURN_REF_EXACT_KEYS) !== null) return 'context-view-unknown-field';
  if (!isBoundedString(turnRef.turnId, VIEW_BOUNDS.turnIdMaxChars, false)) {
    return 'context-view-turn-ref-invalid';
  }
  if (turnRef.revision !== null && turnRef.revision !== undefined
    && !isBoundedString(String(turnRef.revision), VIEW_BOUNDS.turnIdMaxChars, false)) {
    return 'context-view-turn-ref-invalid';
  }
  return null;
}

// ---- tier-decision binding (tier + trust preservation) ----

function checkTierDecisionBinding(entry, section, viewNamespace) {
  const decision = entry.tierDecision;
  const check = tierV2.validateMemoryTierDecisionV2(decision);
  if (!check.valid) return 'context-view-tier-proof-invalid';
  if (decision.tier === 'ARCHIVE') return 'context-view-archive-excluded';
  if (decision.tier !== entry.tier) return 'context-view-tier-mismatch';
  if (decision.tier !== SECTION_TIERS[section]) return 'context-view-section-tier-mismatch';
  // Caller relabeling is impossible: the B04 decision is the tier truth
  // and the entry must agree with it exactly.
  if (decision.namespace !== null && decision.namespace !== undefined) {
    const mismatch = namespaceTripleMatches(viewNamespace, decision.namespace, 'tier decision');
    if (mismatch !== null) return 'context-view-namespace-mismatch';
  }
  const pageBacked = PAGE_BACKED_SOURCES.includes(entry.sourceType);
  const stateBacked = STATE_BACKED_SOURCES.includes(entry.sourceType);
  if (pageBacked) {
    if (decision.pageId === null || decision.pageId === undefined) return 'context-view-tier-binding-mismatch';
    if (decision.pageId !== entry.sourceId) return 'context-view-tier-binding-mismatch';
    // C05: a lossy representation keeps the B04 decision bound to the
    // canonical source bytes, not to the shown representation bytes.
    // checkRepresentationBinding proves the representation side; here the
    // decision side must agree with the source hash exactly.
    if (entry.representation !== null && entry.representation !== undefined) {
      if (decision.contentHash !== entry.representation.sourceContentHash) {
        return 'context-view-tier-binding-mismatch';
      }
    } else if (decision.contentHash !== entry.contentHash) {
      return 'context-view-tier-binding-mismatch';
    }
  }
  if (stateBacked) {
    // State subjects are authoritative structured state and carry no
    // page; a page-bearing decision on a state entry (or vice versa)
    // is a binding mismatch.
    if (decision.pageId !== null && decision.pageId !== undefined) {
      return 'context-view-tier-binding-mismatch';
    }
  }
  // Trust preservation: a view never upgrades provenance. When the B04
  // decision echoes page trust, the entry provenance must carry that
  // exact trust class. B03 exact verification never promotes evidence
  // to authoritative: the provenance object travels through unchanged.
  if (decision.trust !== null && decision.trust !== undefined) {
    if (!isPlainObject(entry.provenance) || entry.provenance.trust !== decision.trust) {
      return 'context-view-provenance-mismatch';
    }
  }
  return null;
}

function checkProvenance(entry) {
  const check = trustV2.validateTrustProvenance(entry.provenance);
  if (!check.valid) return 'context-view-provenance-invalid';
  // Authority legality: a structurally well-formed but policy-impossible
  // pair (e.g. repository + authoritative) fails here even though the
  // structural check above passed. Content can never self-declare higher
  // authority through text: tier/trust come only from frozen decisions
  // and frozen provenance, never from evidence prose.
  const fieldKind = entry.provenance.fieldKind;
  if (fieldKind !== null && fieldKind !== undefined) {
    const authority = trustV2.validateProvenanceAuthority(entry.provenance, fieldKind);
    if (!authority.valid) return 'context-view-provenance-authority-invalid';
  }
  return null;
}

// ---- C05 representation binding (source vs shown identity) ----

function checkRepresentationBinding(entry, section) {
  const representation = entry.representation === undefined ? null : entry.representation;
  if (representation === null) return null;
  if (!isPlainObject(representation)) return 'context-view-representation-invalid';
  if (unknownKeyOf(representation, REPRESENTATION_EXACT_KEYS) !== null) {
    return 'context-view-unknown-field';
  }
  if (!REPRESENTATION_KINDS.includes(representation.kind)) {
    return 'context-view-representation-invalid';
  }
  if (typeof representation.sourcePageId !== 'string'
    || !PAGE_ID_PATTERN.test(representation.sourcePageId)) {
    return 'context-view-representation-invalid';
  }
  if (typeof representation.sourceContentHash !== 'string'
    || !CONTENT_HASH_PATTERN.test(representation.sourceContentHash)) {
    return 'context-view-representation-invalid';
  }
  if (typeof representation.representationHash !== 'string'
    || !CONTENT_HASH_PATTERN.test(representation.representationHash)) {
    return 'context-view-representation-invalid';
  }
  // The representation hash binds the exact shown bytes (the exactness
  // equation above already proved shown bytes hash to contentHash).
  if (representation.representationHash !== entry.contentHash) {
    return 'context-view-representation-mismatch';
  }
  // Source identity travels on sourceId; the representation must agree.
  if (representation.sourcePageId !== entry.sourceId) {
    return 'context-view-representation-mismatch';
  }
  // Anti-laundering rule: lossy kinds MUST differ from the source hash
  // (a projection must never claim source bytes), and EXACT must not
  // claim a divergent hash. Hash equality is the exactness proof.
  if (representation.kind === 'EXACT') {
    if (representation.sourceContentHash !== representation.representationHash) {
      return 'context-view-representation-mismatch';
    }
  } else if (representation.sourceContentHash === representation.representationHash) {
    return 'context-view-representation-mismatch';
  }
  // Only page-backed optional WARM/COLD memory may carry a lossy form:
  // state-backed truth, PINNED correctness, HOT working set, mandatory
  // material, and balanced tool transactions stay exact by construction.
  if (!PAGE_BACKED_SOURCES.includes(entry.sourceType)) {
    return 'context-view-representation-invalid';
  }
  if (entry.tier !== 'WARM' && entry.tier !== 'COLD') {
    return 'context-view-representation-invalid';
  }
  if (SECTION_TIERS[section] !== entry.tier) return 'context-view-section-tier-mismatch';
  if (entry.mandatory === true) return 'context-view-representation-invalid';
  const unit = entry.toolTransaction === undefined ? null : entry.toolTransaction;
  if (unit !== null) return 'context-view-representation-invalid';
  // The B04 decision stays bound to the canonical source bytes.
  const decision = entry.tierDecision;
  if (!isPlainObject(decision)) return 'context-view-tier-proof-invalid';
  if (decision.pageId !== representation.sourcePageId) {
    return 'context-view-tier-binding-mismatch';
  }
  if (decision.contentHash !== representation.sourceContentHash) {
    return 'context-view-tier-binding-mismatch';
  }
  return null;
}

// ---- fresh-proof binding for external COLD (B03 handoff) ----

function checkMaterialEvidence(entry, viewNamespace) {
  const decision = entry.tierDecision;
  const external = decision.exactResolutionMode !== null
    && decision.exactResolutionMode !== undefined
    && EXTERNAL_RESOLUTION_MODES.includes(decision.exactResolutionMode);
  const evidence = entry.evidence === undefined ? null : entry.evidence;
  if (!external) {
    // Durably self-backed COLD (durable-inline / durable-blob) needs no
    // external proof record: the exactText/contentHash equation below is
    // the integrity check. A supplied record must still bind exactly.
    if (evidence === null) return null;
  } else if (evidence === null) {
    // The old B04 resolution proof alone never counts as materialized
    // exact evidence. Phase-C handoff: select external COLD -> B03 runs
    // again -> fresh exact evidence -> the view may include it with the
    // fresh binding record attached.
    return 'context-view-cold-proof-required';
  }
  if (!isPlainObject(evidence)) return 'context-view-cold-proof-invalid';
  if (unknownKeyOf(evidence, MATERIAL_EVIDENCE_EXACT_KEYS) !== null) {
    return 'context-view-unknown-field';
  }
  if (typeof evidence.pageId !== 'string' || !PAGE_ID_PATTERN.test(evidence.pageId)) {
    return 'context-view-cold-proof-invalid';
  }
  if (evidence.pageId !== entry.sourceId) return 'context-view-cold-proof-binding-mismatch';
  // C05: external proof binds the canonical source bytes. For a lossy
  // representation that is sourceContentHash, not the shown bytes.
  const sourceHash = (entry.representation !== null && entry.representation !== undefined)
    ? entry.representation.sourceContentHash
    : entry.contentHash;
  if (evidence.contentHash !== sourceHash) return 'context-view-cold-proof-binding-mismatch';
  if (!rehydrationV2.SOURCE_ROUTES.includes(evidence.sourceRoute)) {
    return 'context-view-cold-proof-invalid';
  }
  // Only external-route proof records authorize external COLD: a
  // durable-inline/blob record on an exact-repository-source decision
  // (or any route/mode disagreement) fails closed.
  const routeToMode = {
    session: 'exact-session-source',
    repository: 'exact-repository-source',
    artifact: 'exact-artifact-source',
  };
  if (routeToMode[evidence.sourceRoute] !== decision.exactResolutionMode) {
    return 'context-view-cold-proof-binding-mismatch';
  }
  if (evidence.mediaType !== 'text') return 'context-view-binary-rejected';
  if (typeof evidence.sourceIdentity !== 'string' || evidence.sourceIdentity === ''
    || evidence.sourceIdentity.length > VIEW_BOUNDS.sourceIdentityMaxChars) {
    return 'context-view-cold-proof-invalid';
  }
  if (evidence.verified !== true) return 'context-view-cold-proof-invalid';
  if (typeof evidence.resultDigest !== 'string' || !CONTENT_HASH_PATTERN.test(evidence.resultDigest)) {
    return 'context-view-cold-proof-invalid';
  }
  if (!isPlainObject(evidence.namespace)) return 'context-view-namespace-mismatch';
  if (unknownKeyOf(evidence.namespace, MATERIAL_EVIDENCE_NAMESPACE_EXACT_KEYS) !== null) {
    return 'context-view-unknown-field';
  }
  const mismatch = namespaceTripleMatches(viewNamespace, evidence.namespace, 'cold evidence');
  if (mismatch !== null) return 'context-view-namespace-mismatch';
  // The binding record must be a genuine B03 shape: the resultDigest is
  // recomputed through the frozen B03 digest authority. (Digest
  // recomputation proves structural B03 agreement, not execution
  // freshness: freshness stays C02's rebuild responsibility.)
  let recomputed = null;
  try {
    recomputed = rehydrationV2.deriveRehydrationDigestV2({
      pageId: evidence.pageId,
      contentHash: evidence.contentHash,
      sourceRoute: evidence.sourceRoute,
      mediaType: evidence.mediaType,
      namespace: {
        taskId: evidence.namespace.taskId,
        taskInstanceId: evidence.namespace.taskInstanceId,
        sessionId: evidence.namespace.sessionId,
        workspaceId: viewNamespace.workspaceId,
        repositoryId: viewNamespace.repositoryId,
        checkoutId: viewNamespace.checkoutId,
      },
      sourceIdentity: evidence.sourceIdentity,
    });
  } catch (e) {
    return 'context-view-cold-proof-invalid';
  }
  if (recomputed !== evidence.resultDigest) return 'context-view-cold-proof-binding-mismatch';
  // Provenance travels through rehydration unchanged.
  if (!canonicalDeepEqual(evidence.provenance, entry.provenance)) {
    return 'context-view-provenance-mismatch';
  }
  return null;
}

function checkToolTransaction(entry) {
  const decision = entry.tierDecision;
  const requiresUnit = TOOL_PROTOCOL_SUBJECTS.includes(decision.subjectKind);
  const unit = entry.toolTransaction === undefined ? null : entry.toolTransaction;
  if (unit === null) {
    return requiresUnit ? 'context-view-tool-protocol-incomplete' : null;
  }
  if (!isPlainObject(unit)) return 'context-view-tool-protocol-incomplete';
  if (unknownKeyOf(unit, MATERIAL_TOOL_TRANSACTION_EXACT_KEYS) !== null) {
    return 'context-view-unknown-field';
  }
  if (!isBoundedString(unit.callId, VIEW_BOUNDS.callIdMaxChars, false)) {
    return 'context-view-tool-protocol-incomplete';
  }
  // A balanced unit must remain intact: a tool call in the view without
  // its matching result (or vice versa) is rejected. C01 detects invalid
  // supplied units; it never discovers protocol state.
  if (unit.callPresent !== true || unit.resultPresent !== true) {
    return 'context-view-tool-protocol-unbalanced';
  }
  return null;
}

function validateMaterialEntry(entry, section, viewNamespace) {
  if (!isPlainObject(entry)) return 'context-view-material-invalid';
  if (unknownKeyOf(entry, MATERIAL_ENTRY_EXACT_KEYS) !== null) return 'context-view-unknown-field';
  if (entry.schemaVersion !== CONTEXT_VIEW_SCHEMA_VERSION) return 'context-view-schema-mismatch';
  if (typeof entry.id !== 'string' || !ENTRY_ID_PATTERN.test(entry.id)) {
    return 'context-view-material-id-invalid';
  }
  if (!MATERIAL_TIERS.includes(entry.tier)) return 'context-view-tier-unknown';
  if (entry.tier !== SECTION_TIERS[section]) return 'context-view-section-tier-mismatch';
  if (!MATERIAL_SOURCE_TYPES.includes(entry.sourceType)) return 'context-view-source-type-unknown';
  if (!isBoundedString(entry.sourceId, VIEW_BOUNDS.sourceIdMaxChars, false)) {
    return 'context-view-material-invalid';
  }
  if (typeof entry.contentHash !== 'string' || !CONTENT_HASH_PATTERN.test(entry.contentHash)) {
    return 'context-view-material-invalid';
  }
  // Binary boundary (frozen B03 distinction): a model-facing materialized
  // unit carries supported textual representation only. Raw binary
  // evidence must never be silently UTF-8 decoded; a future explicit
  // adapter (not C01) is required for any binary materialization.
  if (entry.mediaType !== 'text') return 'context-view-binary-rejected';
  if (typeof entry.exactText !== 'string' || entry.exactText === '') {
    return 'context-view-material-invalid';
  }
  if (entry.exactText.length > VIEW_BOUNDS.exactTextMaxChars) return 'context-view-material-too-large';
  // Exactness equation: the model-facing text must hash to the claimed
  // content identity. Same bytes do not imply same ownership (namespace
  // is bound separately), but differing bytes always fail. For C05 lossy
  // entries this proves representationHash binds the shown bytes; the
  // source binding is proven separately below (never the same hash).
  if (sha256HexUtf8(entry.exactText) !== entry.contentHash) {
    return 'context-view-content-mismatch';
  }
  const representationFailure = checkRepresentationBinding(entry, section);
  if (representationFailure !== null) return representationFailure;
  if (typeof entry.mandatory !== 'boolean') return 'context-view-material-invalid';
  // PINNED is mandatory by construction: correctness-critical current
  // state with mandatory=false is rejected.
  if (entry.tier === 'PINNED' && entry.mandatory !== true) return 'context-view-pinned-not-mandatory';
  const provenanceFailure = checkProvenance(entry);
  if (provenanceFailure !== null) return provenanceFailure;
  if (!isPlainObject(entry.tierDecision)) return 'context-view-tier-proof-invalid';
  const bindingFailure = checkTierDecisionBinding(entry, section, viewNamespace);
  if (bindingFailure !== null) return bindingFailure;
  // HOT current-user exact preservation (frozen B04 intent): a
  // mandatory materializationIntent demands mandatory=true in the view.
  if (entry.tierDecision.materializationIntent === 'mandatory' && entry.mandatory !== true) {
    return 'context-view-mandatory-intent-violated';
  }
  // Entry id must be the frozen derivation (deterministic, no UUIDs).
  const expectedId = deriveMaterialEntryIdV2(
    section, entry.tier, entry.sourceType, entry.sourceId, entry.contentHash,
  );
  if (entry.id !== expectedId) return 'context-view-material-id-mismatch';
  const evidenceFailure = checkMaterialEvidence(entry, viewNamespace);
  if (evidenceFailure !== null) return evidenceFailure;
  return checkToolTransaction(entry);
}

function validateColdReference(ref, viewNamespace) {
  if (!isPlainObject(ref)) return 'context-view-reference-invalid';
  if (unknownKeyOf(ref, COLD_REFERENCE_EXACT_KEYS) !== null) return 'context-view-unknown-field';
  if (typeof ref.pageId !== 'string' || !PAGE_ID_PATTERN.test(ref.pageId)) {
    return 'context-view-reference-invalid';
  }
  if (typeof ref.contentHash !== 'string' || !CONTENT_HASH_PATTERN.test(ref.contentHash)) {
    return 'context-view-reference-invalid';
  }
  if (ref.evidenceId !== null && ref.evidenceId !== undefined
    && !isBoundedString(String(ref.evidenceId), VIEW_BOUNDS.sourceIdMaxChars, false)) {
    return 'context-view-reference-invalid';
  }
  if (typeof ref.kind !== 'string' || !pageV2.PAGE_KINDS.includes(ref.kind)) {
    return 'context-view-reference-invalid';
  }
  // Identity-only bounded record: no page text, no summary-as-evidence.
  // A referenced-only COLD item remains known but its exact bytes are
  // NOT present in this view; it must still carry sufficient identity
  // (pageId, contentHash, mode) for future exact resolution.
  if (!rehydrationV2.EXACT_RESOLUTION_MODES.includes(ref.exactResolutionMode)) {
    return 'context-view-reference-mode-invalid';
  }
  if (!isPlainObject(ref.namespace)) return 'context-view-namespace-mismatch';
  if (unknownKeyOf(ref.namespace, COLD_REFERENCE_NAMESPACE_EXACT_KEYS) !== null) {
    return 'context-view-unknown-field';
  }
  const mismatch = namespaceTripleMatches(viewNamespace, ref.namespace, 'cold reference');
  if (mismatch !== null) return 'context-view-namespace-mismatch';
  const provenanceCheck = trustV2.validateTrustProvenance(ref.provenance);
  if (!provenanceCheck.valid) return 'context-view-provenance-invalid';
  // Referenced COLD is still tiered memory: it binds the same frozen B04
  // decision shape (tier COLD) so callers cannot smuggle HOT/PINNED
  // state into the reference list, nor reference ARCHIVE history.
  if (!isPlainObject(ref.tierDecision)) return 'context-view-tier-proof-invalid';
  const decisionCheck = tierV2.validateMemoryTierDecisionV2(ref.tierDecision);
  if (!decisionCheck.valid) return 'context-view-tier-proof-invalid';
  if (ref.tierDecision.tier === 'ARCHIVE') return 'context-view-archive-excluded';
  if (ref.tierDecision.tier !== 'COLD') return 'context-view-tier-mismatch';
  if (ref.tierDecision.pageId !== ref.pageId) return 'context-view-tier-binding-mismatch';
  if (ref.tierDecision.contentHash !== ref.contentHash) return 'context-view-tier-binding-mismatch';
  if (ref.tierDecision.pageKind !== null && ref.tierDecision.pageKind !== undefined
    && ref.tierDecision.pageKind !== ref.kind) {
    return 'context-view-tier-binding-mismatch';
  }
  if (ref.tierDecision.trust !== null && ref.tierDecision.trust !== undefined
    && (!isPlainObject(ref.provenance) || ref.provenance.trust !== ref.tierDecision.trust)) {
    return 'context-view-provenance-mismatch';
  }
  if (ref.tierDecision.namespace !== null && ref.tierDecision.namespace !== undefined) {
    const decisionMismatch = namespaceTripleMatches(viewNamespace, ref.tierDecision.namespace, 'reference tier decision');
    if (decisionMismatch !== null) return 'context-view-namespace-mismatch';
  }
  return null;
}

function validateBudget(budget) {
  if (!isPlainObject(budget)) return 'context-view-budget-invalid';
  if (unknownKeyOf(budget, BUDGET_EXACT_KEYS) !== null) return 'context-view-unknown-field';
  // Budget is a CONTRACT only, never an allocator. The caller supplies
  // already-computed values; C01 validates the shape relationship and
  // computes nothing. C04 owns allocation.
  if (!Number.isInteger(budget.hardMax) || budget.hardMax < 1 || budget.hardMax > 10000000) {
    return 'context-view-budget-invalid';
  }
  if (!Number.isInteger(budget.target) || budget.target < 0 || budget.target > budget.hardMax) {
    return 'context-view-budget-invalid';
  }
  // Unknown token counts are explicit, never guessed: used:null means
  // exact tokenizer accounting is not yet available (pre-C04
  // construction/shadow use). Fabricated counts are worse than null.
  // C04H correction: target is the preferred materialization target and
  // hardMax is the absolute logical-context ceiling. A known used count
  // may honestly exceed target (mandatory truth above the preferred
  // target) but never hardMax. C01 validates this structural shape
  // only; it never decides WHY used exceeds target (no cost provenance
  // here) - packing-policy correctness belongs to C04 and its plan.
  if (budget.used !== null && budget.used !== undefined) {
    if (!Number.isInteger(budget.used) || budget.used < 0 || budget.used > budget.hardMax) {
      return 'context-view-budget-invalid';
    }
  }
  return null;
}

function validateTraceEntry(traceEntry) {
  if (!isPlainObject(traceEntry)) return 'context-view-trace-invalid';
  if (unknownKeyOf(traceEntry, TRACE_ENTRY_EXACT_KEYS) !== null) return 'context-view-unknown-field';
  if (traceEntry.pageId !== null && traceEntry.pageId !== undefined
    && (typeof traceEntry.pageId !== 'string' || !PAGE_ID_PATTERN.test(traceEntry.pageId))) {
    return 'context-view-trace-invalid';
  }
  if (!TRACE_ACTIONS.includes(traceEntry.action)) return 'context-view-trace-invalid';
  if (!isBoundedString(traceEntry.reasonCode, VIEW_BOUNDS.reasonCodeMaxChars, false)) {
    return 'context-view-trace-invalid';
  }
  // No DecisionProvider exists in C01: every recorded decision must be
  // deterministic. A probabilistic/confidence-driven trace entry fails
  // closed here; JEV/Laya/DECIDE belong to C02+.
  if (traceEntry.deterministic !== true) return 'context-view-trace-nondeterministic';
  if (traceEntry.provider !== null && traceEntry.provider !== undefined
    && !isBoundedString(String(traceEntry.provider), VIEW_BOUNDS.providerMaxChars, false)) {
    return 'context-view-trace-invalid';
  }
  if (traceEntry.confidence !== null && traceEntry.confidence !== undefined
    && (typeof traceEntry.confidence !== 'number' || traceEntry.confidence < 0 || traceEntry.confidence > 1)) {
    return 'context-view-trace-invalid';
  }
  return null;
}

function validateMandatoryRef(ref) {
  if (!isPlainObject(ref)) return 'context-view-mandatory-invalid';
  if (unknownKeyOf(ref, MANDATORY_REF_EXACT_KEYS) !== null) return 'context-view-unknown-field';
  if (!isBoundedString(ref.sourceId, VIEW_BOUNDS.sourceIdMaxChars, false)) {
    return 'context-view-mandatory-invalid';
  }
  if (!MANDATORY_REF_KINDS.includes(ref.kind)) return 'context-view-mandatory-invalid';
  if (ref.contentHash !== null && ref.contentHash !== undefined
    && (typeof ref.contentHash !== 'string' || !CONTENT_HASH_PATTERN.test(ref.contentHash))) {
    return 'context-view-mandatory-invalid';
  }
  return null;
}

// ---- full view validation (closed world) ----

function validateContextViewV2(view) {
  const fail = (reason) => ({ valid: false, reason });
  if (!isPlainObject(view)) return fail('context-view-unknown-field');
  const unknownTop = unknownKeyOf(view, VIEW_TOP_EXACT_KEYS);
  if (unknownTop !== null) {
    if (FORBIDDEN_VIEW_KEYS.includes(unknownTop)) {
      return fail(unknownTop === 'retrievedPages'
        ? 'context-view-retrieved-pages-renamed'
        : 'context-view-compiler-owned');
    }
    return fail('context-view-unknown-field');
  }
  if (view.schemaVersion !== CONTEXT_VIEW_SCHEMA_VERSION) return fail('context-view-schema-mismatch');
  if (typeof view.id !== 'string' || !VIEW_ID_PATTERN.test(view.id)) {
    return fail('context-view-id-invalid');
  }
  // Disposable semantics (architectural invariant): every valid view
  // carries disposable:true with no alternate value. Persistence of a
  // view for diagnostics later must never convert it into task
  // authority; validation rejects any other value.
  if (view.disposable !== true) return fail('context-view-not-disposable');
  const namespaceFailure = validateViewNamespace(view.namespace);
  if (namespaceFailure !== null) return fail(namespaceFailure);
  const bindingFailure = validateCheckpointBinding(view.checkpointBinding);
  if (bindingFailure !== null) return fail(bindingFailure);
  const turnFailure = validateTurnRef(view.turnRef === undefined ? null : view.turnRef);
  if (turnFailure !== null) return fail(turnFailure);
  for (const section of VIEW_SECTIONS) {
    if (!Array.isArray(view[section])) return fail('context-view-section-invalid');
    if (view[section].length > VIEW_BOUNDS.sectionEntriesMax) return fail('context-view-section-too-large');
  }
  if (!Array.isArray(view.referencedColdPages)) return fail('context-view-section-invalid');
  if (view.referencedColdPages.length > VIEW_BOUNDS.referencedColdMax) {
    return fail('context-view-section-too-large');
  }
  if (!Array.isArray(view.compilationTrace)) return fail('context-view-trace-invalid');
  if (view.compilationTrace.length > VIEW_BOUNDS.traceEntriesMax) return fail('context-view-trace-too-large');
  if (!Array.isArray(view.mandatoryRefs)) return fail('context-view-mandatory-invalid');
  if (view.mandatoryRefs.length > VIEW_BOUNDS.mandatoryRefsMax) return fail('context-view-mandatory-too-large');
  if (!isBoundedString(view.compilerPolicyRevision,
    VIEW_BOUNDS.compilerPolicyRevisionMaxChars, false)) {
    return fail('context-view-policy-invalid');
  }
  const budgetFailure = validateBudget(view.tokenBudget);
  if (budgetFailure !== null) return fail(budgetFailure);

  // Per-entry validation (tier/trust/namespace/exactness/tool binding).
  const seenSources = new Map();
  let currentTurnCount = 0;
  let checkpointFullCount = 0;
  for (const section of VIEW_SECTIONS) {
    for (const entry of view[section]) {
      const entryFailure = validateMaterialEntry(entry, section, view.namespace);
      if (entryFailure !== null) return fail(entryFailure);
      // One semantic source -> one materialized representation per view.
      // The full-checkpoint marker is definitionally one shared sourceId:
      // its exactly-once rule owns duplicates (checkpoint-duplicate),
      // not the generic duplicate-source rule.
      const isCheckpointFull = entry.sourceType === 'checkpoint-state'
        && entry.sourceId === CHECKPOINT_FULL_SOURCE_ID;
      if (!isCheckpointFull) {
        if (seenSources.has(entry.sourceId)) return fail('context-view-duplicate-source');
        seenSources.set(entry.sourceId, section);
      }
      if (entry.sourceType === 'current-turn') currentTurnCount += 1;
      if (isCheckpointFull) checkpointFullCount += 1;
    }
  }
  // Current user message appears exactly once when represented (Phase-A
  // invariant preserved through source identity, not text equality).
  if (currentTurnCount > 1) return fail('context-view-current-turn-duplicate');
  // Latest full checkpoint representation appears at most once.
  if (checkpointFullCount > 1) return fail('context-view-checkpoint-duplicate');

  for (const ref of view.referencedColdPages) {
    const refFailure = validateColdReference(ref, view.namespace);
    if (refFailure !== null) return fail(refFailure);
    // Materialized COLD and referenced-only COLD are distinct concepts:
    // the same page must never appear as both in one view.
    if (seenSources.has(ref.pageId)) return fail('context-view-duplicate-source');
    seenSources.set(ref.pageId, 'referencedColdPages');
  }

  for (const traceEntry of view.compilationTrace) {
    const traceFailure = validateTraceEntry(traceEntry);
    if (traceFailure !== null) return fail(traceFailure);
  }
  // Trace is observability, not authority: validation never consults it
  // for membership. A trace saying SKIP for mandatory state changes
  // nothing below.

  const seenMandatory = new Set();
  for (const ref of view.mandatoryRefs) {
    const refFailure = validateMandatoryRef(ref);
    if (refFailure !== null) return fail(refFailure);
    if (seenMandatory.has(ref.sourceId)) return fail('context-view-mandatory-duplicate');
    seenMandatory.add(ref.sourceId);
    // The final view must account for every mandatory ref exactly once.
    // C01 validates manifest <-> materialized entries; it never creates
    // the manifest from task semantics (C02 derives it from
    // authoritative state).
    const entrySection = seenSources.get(ref.sourceId);
    if (entrySection === undefined || entrySection === 'referencedColdPages') {
      return fail('context-view-mandatory-missing');
    }
    if (ref.contentHash !== null && ref.contentHash !== undefined) {
      let matchedHash = null;
      for (const section of VIEW_SECTIONS) {
        for (const entry of view[section]) {
          if (entry.sourceId === ref.sourceId) matchedHash = entry.contentHash;
        }
      }
      if (matchedHash !== ref.contentHash) return fail('context-view-mandatory-mismatch');
    }
  }

  // Full-view integrity: recompute both deterministic identities.
  if (deriveContextViewIdV2(view) !== view.id) return fail('context-view-id-mismatch');
  if (typeof view.viewDigest !== 'string' || !CONTENT_HASH_PATTERN.test(view.viewDigest)) {
    return fail('context-view-digest-invalid');
  }
  if (deriveContextViewDigestV2(view) !== view.viewDigest) return fail('context-view-digest-mismatch');

  // Schema safety bound (NOT the C04 model token budget).
  if (byteLengthUtf8(canonicalJsonOf(viewWithoutIdentity(view))) > VIEW_BOUNDS.viewMaxBytes) {
    return fail('context-view-too-large');
  }
  return { valid: true, reason: null };
}

// ---- creation (pure, read-only, no persistence) ----

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

function buildMaterialEntry(raw, section) {
  if (!isPlainObject(raw)) failView('material-invalid', 'materialized entry must be an object');
  if (unknownKeyOf(raw, MATERIAL_ENTRY_EXACT_KEYS) !== null
    && !Object.prototype.hasOwnProperty.call(raw, 'id')) {
    // Creation input must not smuggle unknown fields; 'id' is derived,
    // never caller-supplied.
    const unknown = unknownKeyOf(raw, MATERIAL_ENTRY_EXACT_KEYS);
    if (unknown !== 'id') failView('unknown-field', String(unknown));
  }
  if (raw.id !== undefined) failView('material-id-caller-supplied', 'entry id is derived, never supplied');
  for (const forbidden of ['query', 'topK', 'embedding', 'score', 'rank']) {
    if (raw[forbidden] !== undefined) failView('compiler-owned', String(forbidden));
  }
  const entry = {
    schemaVersion: CONTEXT_VIEW_SCHEMA_VERSION,
    id: deriveMaterialEntryIdV2(
      section, raw.tier, raw.sourceType, raw.sourceId, raw.contentHash,
    ),
    tier: raw.tier,
    sourceType: raw.sourceType,
    sourceId: raw.sourceId,
    contentHash: raw.contentHash,
    provenance: raw.provenance === undefined ? null : deepClone(raw.provenance),
    mediaType: raw.mediaType,
    exactText: raw.exactText,
    mandatory: raw.mandatory,
    tierDecision: raw.tierDecision === undefined ? null : deepClone(raw.tierDecision),
    evidence: raw.evidence === undefined || raw.evidence === null ? null : deepClone(raw.evidence),
    toolTransaction: raw.toolTransaction === undefined || raw.toolTransaction === null
      ? null
      : deepClone(raw.toolTransaction),
  };
  // C05: the representation binding travels only when supplied. Legacy
  // EXACT inputs carry no such key, so their canonical bytes, entry ids,
  // view ids, and digests are byte-identical to before this extension.
  if (raw.representation !== undefined && raw.representation !== null) {
    entry.representation = deepClone(raw.representation);
  }
  return entry;
}

function buildColdReference(raw) {
  if (!isPlainObject(raw)) failView('reference-invalid', 'cold reference must be an object');
  const unknown = unknownKeyOf(raw, COLD_REFERENCE_EXACT_KEYS);
  if (unknown !== null) failView('unknown-field', String(unknown));
  return {
    pageId: raw.pageId,
    contentHash: raw.contentHash,
    evidenceId: raw.evidenceId === undefined ? null : raw.evidenceId,
    kind: raw.kind,
    provenance: raw.provenance === undefined ? null : deepClone(raw.provenance),
    exactResolutionMode: raw.exactResolutionMode,
    namespace: raw.namespace === undefined ? null : deepClone(raw.namespace),
    tierDecision: raw.tierDecision === undefined ? null : deepClone(raw.tierDecision),
  };
}

/**
 * Create a validated disposable ContextView from explicit caller-supplied
 * material. Pure and read-only: inputs are never mutated, nothing is
 * persisted, no retrieval/search/packing/compression occurs. Throws
 * closed-world 'context-view-*' errors (DISCARDABLE marker).
 */
function createContextViewV2(input) {
  if (!isPlainObject(input)) failView('unknown-field', 'input is required');
  const unknown = unknownKeyOf(input, [
    'namespace', 'checkpointBinding', 'turnRef',
    'pinned', 'hot', 'warm', 'materializedCold', 'referencedColdPages',
    'tokenBudget', 'compilerPolicyRevision', 'compilationTrace', 'mandatoryRefs',
  ]);
  if (unknown !== null) {
    if (FORBIDDEN_VIEW_KEYS.includes(unknown)) {
      failView(unknown === 'retrievedPages' ? 'retrieved-pages-renamed'
        : 'compiler-owned', unknown + ' is owned by the future compiler, not C01');
    }
    failView('unknown-field', unknown);
  }
  // No retrieval surface: a query/search/ranking payload fails closed.
  for (const forbidden of ['query', 'searchText', 'similarity', 'topK', 'embedding', 'candidates']) {
    if (input[forbidden] !== undefined) failView('compiler-owned', String(forbidden));
  }
  const namespace = deepClone(input.namespace);
  const checkpointBinding = deepClone(input.checkpointBinding);
  if (isPlainObject(checkpointBinding) && checkpointBinding.snapshotRevision === undefined) {
    checkpointBinding.snapshotRevision = null;
  }
  const turnRef = input.turnRef === undefined || input.turnRef === null ? null : deepClone(input.turnRef);
  const view = {
    schemaVersion: CONTEXT_VIEW_SCHEMA_VERSION,
    id: null,
    namespace,
    checkpointBinding,
    turnRef,
    pinned: Array.isArray(input.pinned) ? input.pinned.map((e) => buildMaterialEntry(e, 'pinned')) : null,
    hot: Array.isArray(input.hot) ? input.hot.map((e) => buildMaterialEntry(e, 'hot')) : null,
    warm: Array.isArray(input.warm) ? input.warm.map((e) => buildMaterialEntry(e, 'warm')) : null,
    materializedCold: Array.isArray(input.materializedCold)
      ? input.materializedCold.map((e) => buildMaterialEntry(e, 'materializedCold'))
      : null,
    referencedColdPages: Array.isArray(input.referencedColdPages)
      ? input.referencedColdPages.map(buildColdReference)
      : null,
    tokenBudget: deepClone(input.tokenBudget),
    compilerPolicyRevision: input.compilerPolicyRevision,
    compilationTrace: deepClone(input.compilationTrace === undefined ? null : input.compilationTrace),
    mandatoryRefs: deepClone(input.mandatoryRefs === undefined ? null : input.mandatoryRefs),
    viewDigest: null,
    disposable: true,
  };
  // Normalize an explicitly unknown token count: callers may pass
  // used:undefined; the contract stores used:null (explicit unknown).
  if (isPlainObject(view.tokenBudget) && view.tokenBudget.used === undefined) {
    view.tokenBudget.used = null;
  }
  // Fail closed BEFORE identity derivation: every list is explicit.
  // Missing sections are never defaulted to empty (no silent defaults
  // in authority-sensitive structures).
  for (const section of VIEW_SECTIONS) {
    if (!Array.isArray(view[section])) failView('section-invalid', section + ' must be an explicit array');
  }
  if (!Array.isArray(view.referencedColdPages)) failView('section-invalid', 'referencedColdPages must be an explicit array');
  if (!Array.isArray(view.compilationTrace)) failView('trace-invalid', 'compilationTrace must be an explicit array');
  if (!Array.isArray(view.mandatoryRefs)) failView('mandatory-invalid', 'mandatoryRefs must be an explicit array');
  view.id = deriveContextViewIdV2(view);
  view.viewDigest = deriveContextViewDigestV2(view);
  const check = validateContextViewV2(view);
  if (!check.valid) failView(check.reason, 'assembled view failed closed-world validation');
  return freezeDeep(view);
}

// ---- bounded observational facts (no evidence content) ----

function describeContextViewV2(view) {
  const check = validateContextViewV2(view);
  if (!check.valid) failView(check.reason, 'cannot describe an invalid view');
  const tiers = {};
  for (const section of VIEW_SECTIONS) {
    for (const entry of view[section]) {
      tiers[entry.tier] = (tiers[entry.tier] === undefined ? 0 : tiers[entry.tier]) + 1;
    }
  }
  return Object.freeze({
    id: view.id,
    viewDigestPrefix: String(view.viewDigest).slice(0, 16),
    taskId: view.namespace.taskId,
    taskInstanceId: view.namespace.taskInstanceId,
    sessionId: view.namespace.sessionId,
    checkpointGeneration: view.checkpointBinding.checkpointGeneration,
    checkpointId: view.checkpointBinding.checkpointId,
    checkpointContentHashPrefix: String(view.checkpointBinding.checkpointContentHash).slice(0, 16),
    snapshotRevisionPrefix: view.checkpointBinding.snapshotRevision === null
      ? 'none'
      : String(view.checkpointBinding.snapshotRevision).slice(0, 16),
    pinnedCount: view.pinned.length,
    hotCount: view.hot.length,
    warmCount: view.warm.length,
    materializedColdCount: view.materializedCold.length,
    referencedColdCount: view.referencedColdPages.length,
    mandatoryCount: view.mandatoryRefs.length,
    traceCount: view.compilationTrace.length,
    tiers,
    tokenBudget: {
      hardMax: view.tokenBudget.hardMax,
      target: view.tokenBudget.target,
      used: view.tokenBudget.used,
    },
    compilerPolicyRevision: view.compilerPolicyRevision,
    disposable: true,
  });
}

module.exports = {
  CONTEXT_VIEW_SCHEMA_VERSION,
  CONTEXT_VIEW_ID_DOMAIN_V1,
  CONTEXT_VIEW_DIGEST_DOMAIN_V1,
  CONTEXT_VIEW_MATERIAL_DOMAIN_V1,
  CONTEXT_VIEW_COMPILER_POLICY_SEED,
  VIEW_SECTIONS,
  SECTION_TIERS,
  MATERIAL_TIERS,
  MATERIAL_SOURCE_TYPES,
  MANDATORY_REF_KINDS,
  TRACE_ACTIONS,
  EXTERNAL_RESOLUTION_MODES,
  CHECKPOINT_FULL_SOURCE_ID,
  VIEW_BOUNDS,
  VIEW_TOP_EXACT_KEYS,
  VIEW_NAMESPACE_EXACT_KEYS,
  VIEW_CHECKPOINT_BINDING_EXACT_KEYS,
  MATERIAL_ENTRY_EXACT_KEYS,
  REPRESENTATION_KINDS,
  REPRESENTATION_EXACT_KEYS,
  COLD_REFERENCE_EXACT_KEYS,
  BUDGET_EXACT_KEYS,
  TRACE_ENTRY_EXACT_KEYS,
  MANDATORY_REF_EXACT_KEYS,
  createContextViewV2,
  validateContextViewV2,
  canonicalizeContextViewV2,
  deriveContextViewIdV2,
  deriveContextViewDigestV2,
  deriveMaterialEntryIdV2,
  describeContextViewV2,
};
