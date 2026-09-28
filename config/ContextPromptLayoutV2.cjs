'use strict';
/**
 * ContextPromptLayoutV2.cjs - CCV2-C06 Cache-Aware Prompt Layout production authority.
 *
 * ONE authority for the deterministic presentation (model-facing) order of an
 * already-finalized C05 ContextView. C06 answers "in what order are the final
 * members presented" and NOTHING else:
 *
 *   final C05 ContextView -> C06 layout planner -> disposable ContextPromptLayout
 *
 * C06 owns: layout classification, layout ordering, layout validation, layout
 * identity/digest, and logical-prefix observability. C06 owns NO membership,
 * NO tier classification, NO retrieval, NO packing, NO compression, NO token
 * budget decisions, NO rehydration, NO trust/provenance, NO task truth, NO
 * provider routing, and NO inference.
 *
 * Frozen posture (consumed verbatim, never reinterpreted):
 *   C02 chooses candidates, C03 retrieves, C04 packs, C05 chooses
 *   representation, C06 orders final presentation.
 *
 * Critical distinction (frozen): ContextView order != Prompt layout order.
 * C01 owns the ContextView canonical structure and identity; its section
 * order (PINNED -> HOT -> WARM -> materialized COLD -> referenced COLD) is
 * identity-relevant and MUST NOT be reordered. C06 never mutates the source
 * view: it emits a disposable layout of reference blocks that bind back to
 * exactly one ContextView member each. No model-facing bytes are added,
 * removed, or rewritten here, so C04/C05 token accounting stays honest.
 *
 * Zone classification derives ONLY from typed frozen metadata (section,
 * tier, sourceType, sourceId, mandatory flag, tierDecision.subjectKind,
 * toolTransaction presence). Evidence prose (exactText) is never read and
 * never influences any decision, so prompt-injected instructions in content
 * have zero effect.
 *
 * Layout zones (conceptual model-facing order):
 *   HOST_STABLE_CONTRACT (host-owned external slot; always zero CCv2 members)
 *   TASK_IDENTITY          (stable: requirements/constraints/approvals)
 *   CHECKPOINT_STATE       (stable: checkpoint-backed continuation state)
 *   STABLE_WARM            (stable: WARM context incl. settled tool transactions)
 *   HOT_EXECUTION          (volatile: immediate execution state)
 *   QUERY_EVIDENCE         (volatile: query-specific COLD material + references)
 *   CURRENT_INTERACTION    (volatile: current user/tool turn, causal order kept)
 *
 * The layout is provider-neutral: no cache_control fields, no provider cache
 * keys, no TTL logic, no billing assumptions, no provider prefix markers.
 * The stable-prefix boundary and logical prefix digest are observability and
 * planning metadata, NOT provider cache keys and NOT hit guarantees.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (section 37, C06 freeze record). A/B/C01/C02/C03/C04/C05 semantics are
 * consumed verbatim. D-phase content (DECIDE, JEV/Laya, embeddings,
 * reranking, learned stability prediction, semantic scoring, model-generated
 * ordering, probabilities) does not exist here: every decision is
 * deterministic.
 *
 * Purity: every export is deterministic and read-only. No clocks, no
 * randomness, no process identity, no filesystem reads, no mutation of the
 * source view or any other input. Identical valid final views produce
 * byte-identical layouts across repeat runs, fresh processes, and restarts.
 */

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const viewV2 = require('./ContextViewV2.cjs');

const LAYOUT_SCHEMA_VERSION = 1;
const LAYOUT_POLICY_REVISION_V1 = 'context-prompt-layout-v1';
const LAYOUT_DIGEST_DOMAIN_V1 = 'nexus/context-prompt-layout/v1';
const LOGICAL_PREFIX_DIGEST_DOMAIN_V1 = 'nexus/context-prompt-logical-prefix/v1';

// Conceptual model-facing zone order (frozen). HOST_STABLE_CONTRACT is the
// host-owned external slot descriptor: DSH owns the system/controller bytes
// and assembles them; CCv2 never copies or imports them, so the CCv2-owned
// layout always carries zero members in that zone. The remaining zones are
// CCv2-owned and ordered stable-first.
const LAYOUT_ZONES = Object.freeze([
  'HOST_STABLE_CONTRACT',
  'TASK_IDENTITY',
  'CHECKPOINT_STATE',
  'STABLE_WARM',
  'HOT_EXECUTION',
  'QUERY_EVIDENCE',
  'CURRENT_INTERACTION',
]);

// Zones whose members are expected to remain unchanged across ordinary
// high-churn turns unless their authoritative source changes. All later
// zones form the volatile suffix.
const STABLE_ZONES = Object.freeze([
  'TASK_IDENTITY',
  'CHECKPOINT_STATE',
  'STABLE_WARM',
]);

const VOLATILE_ZONES = Object.freeze([
  'HOT_EXECUTION',
  'QUERY_EVIDENCE',
  'CURRENT_INTERACTION',
]);

// Closed-world layout top-level keys.
const LAYOUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'sourceViewId',
  'sourceViewDigest',
  'namespace',
  'checkpointBinding',
  'scope',
  'externalPrefix',
  'layoutPolicyRevision',
  'blocks',
  'stablePrefixBoundary',
  'stablePrefixDigest',
  'prefixMilestones',
  'zoneCounts',
  'layoutDigest',
  'disposable',
]);

const LAYOUT_BLOCK_EXACT_KEYS = Object.freeze([
  'ordinal',
  'zone',
  'memberKind',
  'sourceSection',
  'memberId',
  'sourceId',
  'contentHash',
  'representationKind',
  'sourceContentHash',
  'toolCallId',
  'stabilityClass',
  'reasonCode',
]);

const LAYOUT_NAMESPACE_EXACT_KEYS = Object.freeze([
  'taskId',
  'taskInstanceId',
  'sessionId',
]);

const LAYOUT_CHECKPOINT_BINDING_EXACT_KEYS = Object.freeze([
  'checkpointGeneration',
  'checkpointId',
]);

const LAYOUT_EXTERNAL_PREFIX_EXACT_KEYS = Object.freeze([
  'owner',
  'slot',
  'memberCount',
  'attachPoint',
]);

const LAYOUT_MILESTONE_EXACT_KEYS = Object.freeze([
  'zone',
  'memberCount',
  'digest',
]);

const MEMBER_KINDS = Object.freeze(['materialized', 'reference']);

const STABILITY_CLASSES = Object.freeze(['stable', 'volatile']);

// Closed-world layout reason codes. Tests assert codes, never prose.
const LAYOUT_REASON_CODES = Object.freeze([
  'layout-task-identity-stable',
  'layout-checkpoint-state-stable',
  'layout-warm-tool-stable',
  'layout-warm-state-stable',
  'layout-warm-conservative-stable',
  'layout-hot-execution-volatile',
  'layout-cold-query-volatile',
  'layout-cold-reference-volatile',
  'layout-current-interaction-volatile',
]);

// Each reason code binds exactly one zone; a forged reason/zone pair fails.
const REASON_ZONE = Object.freeze({
  'layout-task-identity-stable': 'TASK_IDENTITY',
  'layout-checkpoint-state-stable': 'CHECKPOINT_STATE',
  'layout-warm-tool-stable': 'STABLE_WARM',
  'layout-warm-state-stable': 'STABLE_WARM',
  'layout-warm-conservative-stable': 'STABLE_WARM',
  'layout-hot-execution-volatile': 'HOT_EXECUTION',
  'layout-cold-query-volatile': 'QUERY_EVIDENCE',
  'layout-cold-reference-volatile': 'QUERY_EVIDENCE',
  'layout-current-interaction-volatile': 'CURRENT_INTERACTION',
});

// Typed stability-zone classification inputs only. subjectKind values mirror
// the frozen B04 taxonomy (consumed, never redefined here).
const TASK_IDENTITY_SUBJECTS = Object.freeze([
  'active-requirement',
  'active-constraint',
  'unresolved-approval',
]);

const CHECKPOINT_STATE_SUBJECTS = Object.freeze([
  'mandatory-checkpoint-state',
  'accepted-decision',
  'verification-state',
  'failure-state',
]);

const TOOL_PROTOCOL_SUBJECTS = Object.freeze([
  'open-tool-protocol',
  'completed-tool-transaction',
]);

// Typed sourceId prefixes for task/security identity (frozen C02 source
// identity vocabulary: 'checkpoint:<section>:<element-id>'). Corroborating
// signal only; subjectKind is primary.
const TASK_IDENTITY_SOURCE_PREFIXES = Object.freeze([
  'checkpoint:requirement:',
  'checkpoint:constraint:',
  'checkpoint:approval:',
]);

const CHECKPOINT_FULL_SOURCE_ID = 'checkpoint:full';

const CURRENT_TURN_SOURCE_TYPE = 'current-turn';

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

function failLayout(code, detail) {
  throw new Error('context-layout-' + code + (detail === undefined ? '' : ': ' + detail) + ' (DISCARDABLE)');
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

function zoneRank(zone) {
  const rank = LAYOUT_ZONES.indexOf(zone);
  if (rank === -1) failLayout('zone-unknown', 'zone ' + String(zone).slice(0, 64) + ' is unknown');
  return rank;
}

function stabilityOf(zone) {
  if (STABLE_ZONES.includes(zone)) return 'stable';
  if (VOLATILE_ZONES.includes(zone)) return 'volatile';
  // HOST_STABLE_CONTRACT carries no CCv2 members; it is never a block zone.
  failLayout('zone-unknown', 'zone ' + String(zone).slice(0, 64) + ' carries no CCv2 members');
  return null;
}

// ---- typed zone classification (typed metadata only; prose never read) ----

/**
 * Classify one materialized entry into a CCv2 layout zone. Reads ONLY typed
 * frozen metadata: section, tier, sourceType, sourceId, mandatory,
 * tierDecision.subjectKind, toolTransaction presence. Never reads exactText,
 * representation bytes, or any prose field.
 */
function classifyMaterializedForLayout(input) {
  if (!isPlainObject(input)) failLayout('source-invalid', 'classification input must be an object');
  if (unknownKeyOf(input, ['entry', 'section']) !== null) {
    failLayout('source-invalid', 'classification input carries unknown keys');
  }
  const entry = input.entry;
  const section = input.section;
  if (!isPlainObject(entry)) failLayout('source-invalid', 'entry must be an object');
  if (typeof section !== 'string' || viewV2.VIEW_SECTIONS.indexOf(section) === -1) {
    failLayout('source-invalid', 'section is unknown');
  }
  const subjectKind = isPlainObject(entry.tierDecision)
    && typeof entry.tierDecision.subjectKind === 'string'
    ? entry.tierDecision.subjectKind
    : null;
  const sourceType = typeof entry.sourceType === 'string' ? entry.sourceType : null;
  const sourceId = typeof entry.sourceId === 'string' ? entry.sourceId : null;
  const hasToolUnit = entry.toolTransaction !== null && entry.toolTransaction !== undefined;
  const toolSubject = subjectKind !== null && TOOL_PROTOCOL_SUBJECTS.indexOf(subjectKind) !== -1;

  // The exact current user/tool turn always closes the layout, whatever
  // section the frozen view carries it in. Typed sourceType only.
  if (sourceType === CURRENT_TURN_SOURCE_TYPE) {
    return { zone: 'CURRENT_INTERACTION', reasonCode: 'layout-current-interaction-volatile' };
  }
  // Stable task/security identity: requirements, constraints, approvals.
  // Typed subjectKind first; frozen sourceId vocabulary corroborates.
  if (subjectKind !== null && TASK_IDENTITY_SUBJECTS.indexOf(subjectKind) !== -1) {
    return { zone: 'TASK_IDENTITY', reasonCode: 'layout-task-identity-stable' };
  }
  if (sourceId !== null && TASK_IDENTITY_SOURCE_PREFIXES.some((prefix) => sourceId.indexOf(prefix) === 0)) {
    return { zone: 'TASK_IDENTITY', reasonCode: 'layout-task-identity-stable' };
  }
  // HOT section remnants (active failure renders, immediate tool
  // interaction, HOT working set) are immediate execution state. The HOT
  // section reflects the frozen C02 tier judgment, so it wins over the
  // checkpoint-state source below: C06 never re-tiers frozen membership.
  if (section === 'hot') {
    return { zone: 'HOT_EXECUTION', reasonCode: 'layout-hot-execution-volatile' };
  }
  // Checkpoint-backed continuation state: the full checkpoint render and
  // checkpoint-derived state subjects. Typed source identity only.
  if (sourceId === CHECKPOINT_FULL_SOURCE_ID || sourceType === 'checkpoint-state') {
    return { zone: 'CHECKPOINT_STATE', reasonCode: 'layout-checkpoint-state-stable' };
  }
  if (subjectKind !== null && CHECKPOINT_STATE_SUBJECTS.indexOf(subjectKind) !== -1) {
    return { zone: 'CHECKPOINT_STATE', reasonCode: 'layout-checkpoint-state-stable' };
  }
  // Stable WARM (C05H frozen posture: EXACT-only; settled tool transactions
  // are the reachable byte-bearing WARM page case). WARM section only.
  if (section === 'warm') {
    if (hasToolUnit || toolSubject) {
      return { zone: 'STABLE_WARM', reasonCode: 'layout-warm-tool-stable' };
    }
    if (sourceType === 'checkpoint-state' || sourceType === 'runtime-state') {
      return { zone: 'STABLE_WARM', reasonCode: 'layout-warm-state-stable' };
    }
    // Conservative default (C05H: page-backed non-tool WARM materialization
    // is unreachable by frozen design; if it ever occurs it stays stable
    // and exact rather than leaking into the volatile suffix).
    return { zone: 'STABLE_WARM', reasonCode: 'layout-warm-conservative-stable' };
  }
  // PINNED remnants that are neither task identity nor checkpoint state
  // (conservative catch-all): mandatory correctness state is stable, so it
  // joins the checkpoint milestone rather than the volatile suffix.
  if (section === 'pinned') {
    return { zone: 'CHECKPOINT_STATE', reasonCode: 'layout-checkpoint-state-stable' };
  }
  // COLD materialized evidence is query/retrieval dependent by default and
  // belongs to the volatile suffix unless a frozen typed contract proves
  // otherwise (no such contract exists in the frozen baseline).
  return { zone: 'QUERY_EVIDENCE', reasonCode: 'layout-cold-query-volatile' };
}

function toolCallIdOfMaterialized(entry) {
  const unit = entry.toolTransaction === undefined ? null : entry.toolTransaction;
  if (isPlainObject(unit) && typeof unit.callId === 'string' && unit.callId !== '') {
    return unit.callId;
  }
  return null;
}

// ---- layout planning (ordering only; no membership or byte changes) ----

function validateLayoutPolicyRevision(revision) {
  const effective = revision === undefined || revision === null
    ? LAYOUT_POLICY_REVISION_V1
    : revision;
  if (effective !== LAYOUT_POLICY_REVISION_V1) {
    failLayout('policy-unknown', 'layout policy ' + String(effective).slice(0, 64) + ' is unknown');
  }
  return effective;
}

function blockForMaterialized(entry, section, classification) {
  const representation = entry.representation === undefined ? null : entry.representation;
  return {
    ordinal: -1,
    zone: classification.zone,
    memberKind: 'materialized',
    sourceSection: section,
    memberId: entry.id,
    sourceId: entry.sourceId,
    contentHash: entry.contentHash,
    representationKind: representation !== null ? representation.kind : null,
    sourceContentHash: representation !== null ? representation.sourceContentHash : null,
    toolCallId: toolCallIdOfMaterialized(entry),
    stabilityClass: stabilityOf(classification.zone),
    reasonCode: classification.reasonCode,
  };
}

function blockForReference(ref) {
  return {
    ordinal: -1,
    zone: 'QUERY_EVIDENCE',
    memberKind: 'reference',
    sourceSection: 'referencedColdPages',
    memberId: ref.pageId,
    sourceId: ref.pageId,
    contentHash: ref.contentHash,
    representationKind: null,
    sourceContentHash: null,
    toolCallId: null,
    stabilityClass: 'volatile',
    reasonCode: 'layout-cold-reference-volatile',
  };
}

function layoutWithoutDigest(layout) {
  const copy = {};
  for (const key of Object.keys(layout)) {
    if (key === 'layoutDigest') continue;
    copy[key] = layout[key];
  }
  return copy;
}

function deriveLayoutDigestV2(layout) {
  return sha256HexUtf8(
    LAYOUT_DIGEST_DOMAIN_V1 + '\n' + canonicalJsonOf(layoutWithoutDigest(layout)),
  );
}

function deriveLogicalPrefixDigestV2(prefixBindings) {
  return sha256HexUtf8(
    LOGICAL_PREFIX_DIGEST_DOMAIN_V1 + '\n' + canonicalJsonOf(prefixBindings),
  );
}

function prefixBindingOf(block) {
  const binding = {
    memberId: block.memberId,
    sourceSection: block.sourceSection,
    memberKind: block.memberKind,
    sourceId: block.sourceId,
    contentHash: block.contentHash,
    zone: block.zone,
  };
  if (block.representationKind !== null && block.representationKind !== undefined) {
    binding.representationKind = block.representationKind;
    binding.sourceContentHash = block.sourceContentHash;
  }
  return binding;
}

/**
 * Plan the deterministic model-facing presentation order for one final C05
 * ContextView. Returns { layout } with a frozen disposable layout. The
 * source view is never mutated. Throws closed-world 'context-layout-*'
 * errors (DISCARDABLE marker) with no partial output on integrity failure.
 */
function planContextPromptLayoutV2(input) {
  if (!isPlainObject(input)) failLayout('source-invalid', 'input must be an object');
  if (unknownKeyOf(input, ['view', 'layoutPolicyRevision']) !== null) {
    failLayout('source-invalid', 'input carries unknown keys');
  }
  const policyRevision = validateLayoutPolicyRevision(input.layoutPolicyRevision);
  const view = input.view;
  const viewCheck = viewV2.validateContextViewV2(view);
  if (!viewCheck.valid) {
    failLayout('view-invalid', 'source view failed validation: ' + String(viewCheck.reason || viewCheck.reasonCode || 'invalid').slice(0, 160));
  }

  // Collect one atomic placement unit per member. Tool-transaction members
  // sharing a callId form ONE atomic group (never split, never interleaved);
  // every other member is a singleton group. Within a group AND within a
  // zone, frozen ContextView relative order is preserved exactly.
  const units = [];
  const viewOrder = [];
  for (const section of viewV2.VIEW_SECTIONS) {
    for (const entry of view[section]) {
      const classification = classifyMaterializedForLayout({ entry, section });
      const block = blockForMaterialized(entry, section, classification);
      const callId = block.toolCallId;
      const groupKey = callId !== null ? 'tool:' + callId : 'member:' + block.memberId;
      units.push({ groupKey, callId, blocks: [block], firstViewIndex: viewOrder.length });
      viewOrder.push(block);
    }
  }
  for (const ref of view.referencedColdPages) {
    const block = blockForReference(ref);
    units.push({ groupKey: 'member:' + block.memberId, callId: null, blocks: [block], firstViewIndex: viewOrder.length });
    viewOrder.push(block);
  }

  // Merge tool groups that share a callId into one atomic group. (Each
  // transaction is normally a single entry; the merge keeps the rule total
  // if a frozen view ever carries related entries separately.)
  const merged = [];
  const byGroup = new Map();
  for (const unit of units) {
    if (unit.callId === null) {
      merged.push(unit);
      continue;
    }
    let target = byGroup.get(unit.groupKey);
    if (target === undefined) {
      target = { groupKey: unit.groupKey, callId: unit.callId, blocks: [], firstViewIndex: unit.firstViewIndex };
      byGroup.set(unit.groupKey, target);
      merged.push(target);
    }
    for (const block of unit.blocks) target.blocks.push(block);
    if (unit.firstViewIndex < target.firstViewIndex) target.firstViewIndex = unit.firstViewIndex;
  }

  // Zone of an atomic group: the most volatile (latest) zone among its
  // members, so a transaction never straddles the stable/volatile boundary.
  // Members inside the group keep frozen view relative order.
  const positionOf = new Map();
  for (let index = 0; index < viewOrder.length; index += 1) positionOf.set(viewOrder[index], index);
  const groups = merged.map((unit) => {
    let rank = -1;
    for (const block of unit.blocks) {
      const r = zoneRank(block.zone);
      if (r > rank) rank = r;
    }
    // A tool transaction never straddles zones: members of one atomic
    // group must classify identically, otherwise planning fails closed
    // instead of emitting a layout that validation would reject.
    for (const block of unit.blocks) {
      if (zoneRank(block.zone) !== rank) {
        failLayout('transaction-split', 'tool transaction spans stability zones');
      }
    }
    const ordered = unit.blocks.slice().sort((a, b) => positionOf.get(a) - positionOf.get(b));
    return { groupKey: unit.groupKey, zoneRank: rank, firstViewIndex: unit.firstViewIndex, blocks: ordered };
  });

  // Stable sort: zone rank first, frozen view order second. No other key
  // (never hash, pageId, text, token count, path, or relevance).
  const orderedGroups = groups.slice().sort((a, b) => {
    if (a.zoneRank !== b.zoneRank) return a.zoneRank - b.zoneRank;
    return a.firstViewIndex - b.firstViewIndex;
  });

  const blocks = [];
  for (const group of orderedGroups) {
    for (const block of group.blocks) {
      block.ordinal = blocks.length;
      blocks.push(block);
    }
  }

  let stablePrefixBoundary = 0;
  while (stablePrefixBoundary < blocks.length
    && blocks[stablePrefixBoundary].stabilityClass === 'stable') {
    stablePrefixBoundary += 1;
  }
  // The layout is zone-ordered, so every stable block precedes every
  // volatile block by construction; prove it rather than assuming it.
  for (let index = stablePrefixBoundary; index < blocks.length; index += 1) {
    if (blocks[index].stabilityClass === 'stable') {
      failLayout('boundary-invalid', 'stable block follows the volatile suffix');
    }
  }

  const stableBindings = blocks.slice(0, stablePrefixBoundary).map(prefixBindingOf);
  const stablePrefixDigest = deriveLogicalPrefixDigestV2(stableBindings);

  // Cumulative logical prefix milestones: task identity, checkpoint, and
  // stable-WARM prefixes. Each milestone digests the ordered bindings of
  // its zone plus all earlier stable zones, so a checkpoint change
  // invalidates the checkpoint-and-later prefix while the task prefix
  // remains byte-identical.
  const milestoneZones = ['TASK_IDENTITY', 'CHECKPOINT_STATE', 'STABLE_WARM'];
  const prefixMilestones = [];
  for (const zone of milestoneZones) {
    const rank = zoneRank(zone);
    const bindings = blocks
      .filter((block) => block.stabilityClass === 'stable' && zoneRank(block.zone) <= rank)
      .map(prefixBindingOf);
    prefixMilestones.push({
      zone,
      memberCount: bindings.length,
      digest: deriveLogicalPrefixDigestV2(bindings),
    });
  }

  const zoneCounts = {};
  for (const zone of LAYOUT_ZONES) zoneCounts[zone] = 0;
  for (const block of blocks) zoneCounts[block.zone] += 1;

  const layout = {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    sourceViewId: view.id,
    sourceViewDigest: view.viewDigest,
    namespace: {
      taskId: view.namespace.taskId,
      taskInstanceId: view.namespace.taskInstanceId,
      sessionId: view.namespace.sessionId,
    },
    checkpointBinding: {
      checkpointGeneration: view.checkpointBinding.checkpointGeneration,
      checkpointId: view.checkpointBinding.checkpointId,
    },
    scope: 'ccv2-suffix',
    externalPrefix: {
      owner: 'dsh-host',
      slot: 'system-prompt-assemble',
      memberCount: 0,
      attachPoint: 'before-ccv2-suffix',
    },
    layoutPolicyRevision: policyRevision,
    blocks: blocks.map((block) => Object.assign({}, block)),
    stablePrefixBoundary,
    stablePrefixDigest,
    prefixMilestones,
    zoneCounts,
    layoutDigest: null,
    disposable: true,
  };
  layout.layoutDigest = deriveLayoutDigestV2(layout);
  return freezeDeep({ layout });
}

// ---- layout validation (fail closed; no partial output) ----

function checkLayoutBlockShape(block, ordinal) {
  if (!isPlainObject(block)) return 'context-layout-block-invalid';
  if (unknownKeyOf(block, LAYOUT_BLOCK_EXACT_KEYS) !== null) return 'context-layout-unknown-field';
  if (block.ordinal !== ordinal) return 'context-layout-ordinal-forged';
  if (typeof block.zone !== 'string'
    || LAYOUT_ZONES.indexOf(block.zone) === -1
    || block.zone === 'HOST_STABLE_CONTRACT') {
    return 'context-layout-zone-forged';
  }
  if (MEMBER_KINDS.indexOf(block.memberKind) === -1) return 'context-layout-member-kind-invalid';
  if (block.memberKind === 'materialized'
    && viewV2.VIEW_SECTIONS.indexOf(block.sourceSection) === -1) {
    return 'context-layout-section-forged';
  }
  if (block.memberKind === 'reference' && block.sourceSection !== 'referencedColdPages') {
    return 'context-layout-section-forged';
  }
  if (typeof block.memberId !== 'string' || block.memberId === '') {
    return 'context-layout-member-unknown';
  }
  if (typeof block.sourceId !== 'string' || block.sourceId === '') {
    return 'context-layout-member-unknown';
  }
  if (typeof block.contentHash !== 'string' || !CONTENT_HASH_PATTERN.test(block.contentHash)) {
    return 'context-layout-hash-forged';
  }
  if (block.representationKind !== null && block.representationKind !== undefined
    && viewV2.REPRESENTATION_KINDS.indexOf(block.representationKind) === -1) {
    return 'context-layout-representation-forged';
  }
  const hasSourceHash = block.sourceContentHash !== null && block.sourceContentHash !== undefined;
  const hasRepKind = block.representationKind !== null && block.representationKind !== undefined;
  if (hasSourceHash !== hasRepKind) return 'context-layout-representation-forged';
  if (hasSourceHash && !CONTENT_HASH_PATTERN.test(block.sourceContentHash)) {
    return 'context-layout-hash-forged';
  }
  if (block.toolCallId !== null && block.toolCallId !== undefined
    && (typeof block.toolCallId !== 'string' || block.toolCallId === '')) {
    return 'context-layout-transaction-forged';
  }
  if (STABILITY_CLASSES.indexOf(block.stabilityClass) === -1) {
    return 'context-layout-stability-forged';
  }
  const expectedStability = STABLE_ZONES.indexOf(block.zone) !== -1 ? 'stable' : 'volatile';
  if (block.stabilityClass !== expectedStability) return 'context-layout-stability-forged';
  if (typeof block.reasonCode !== 'string'
    || LAYOUT_REASON_CODES.indexOf(block.reasonCode) === -1
    || REASON_ZONE[block.reasonCode] !== block.zone) {
    return 'context-layout-reason-forged';
  }
  return null;
}

function checkLayoutDerivedConsistency(layout) {
  for (let ordinal = 0; ordinal < layout.blocks.length; ordinal += 1) {
    const problem = checkLayoutBlockShape(layout.blocks[ordinal], ordinal);
    if (problem !== null) return problem;
  }
  if (!Number.isInteger(layout.stablePrefixBoundary)
    || layout.stablePrefixBoundary < 0
    || layout.stablePrefixBoundary > layout.blocks.length) {
    return 'context-layout-boundary-forged';
  }
  for (let index = 0; index < layout.stablePrefixBoundary; index += 1) {
    if (layout.blocks[index].stabilityClass !== 'stable') return 'context-layout-boundary-forged';
  }
  for (let index = layout.stablePrefixBoundary; index < layout.blocks.length; index += 1) {
    if (layout.blocks[index].stabilityClass !== 'volatile') return 'context-layout-boundary-forged';
  }
  const stableBindings = layout.blocks.slice(0, layout.stablePrefixBoundary).map(prefixBindingOf);
  if (deriveLogicalPrefixDigestV2(stableBindings) !== layout.stablePrefixDigest) {
    return 'context-layout-prefix-digest-forged';
  }
  if (!Array.isArray(layout.prefixMilestones) || layout.prefixMilestones.length !== 3) {
    return 'context-layout-milestones-invalid';
  }
  const milestoneZones = ['TASK_IDENTITY', 'CHECKPOINT_STATE', 'STABLE_WARM'];
  for (let index = 0; index < milestoneZones.length; index += 1) {
    const milestone = layout.prefixMilestones[index];
    if (!isPlainObject(milestone)) return 'context-layout-milestones-invalid';
    if (unknownKeyOf(milestone, LAYOUT_MILESTONE_EXACT_KEYS) !== null) {
      return 'context-layout-unknown-field';
    }
    if (milestone.zone !== milestoneZones[index]) return 'context-layout-milestones-invalid';
    const rank = zoneRank(milestone.zone);
    const bindings = layout.blocks
      .filter((block) => block.stabilityClass === 'stable' && zoneRank(block.zone) <= rank)
      .map(prefixBindingOf);
    if (milestone.memberCount !== bindings.length) return 'context-layout-milestones-invalid';
    if (milestone.digest !== deriveLogicalPrefixDigestV2(bindings)) {
      return 'context-layout-milestones-invalid';
    }
  }
  const zoneCounts = {};
  for (const zone of LAYOUT_ZONES) zoneCounts[zone] = 0;
  for (const block of layout.blocks) zoneCounts[block.zone] += 1;
  if (canonicalJsonOf(zoneCounts) !== canonicalJsonOf(layout.zoneCounts)) {
    return 'context-layout-zone-counts-forged';
  }
  if (deriveLayoutDigestV2(layout) !== layout.layoutDigest) {
    return 'context-layout-digest-mismatch';
  }
  return null;
}

function checkLayoutToolAtomicity(layout) {
  // Tool-transaction members sharing a callId must occupy one contiguous
  // run in a single zone with no foreign block interleaved.
  const runs = new Map();
  for (const block of layout.blocks) {
    const callId = block.toolCallId === undefined ? null : block.toolCallId;
    if (callId === null) continue;
    let run = runs.get(callId);
    if (run === undefined) {
      run = { first: block.ordinal, last: block.ordinal, zone: block.zone, count: 0 };
      runs.set(callId, run);
    }
    run.count += 1;
    if (block.ordinal < run.first) run.first = block.ordinal;
    if (block.ordinal > run.last) run.last = block.ordinal;
    if (block.zone !== run.zone) return 'context-layout-transaction-split';
  }
  for (const run of runs.values()) {
    if (run.last - run.first + 1 !== run.count) return 'context-layout-transaction-split';
    for (let ordinal = run.first; ordinal <= run.last; ordinal += 1) {
      const block = layout.blocks[ordinal];
      const callId = block.toolCallId === undefined ? null : block.toolCallId;
      if (block.zone !== run.zone) return 'context-layout-transaction-split';
    }
  }
  return null;
}

/**
 * Validate a layout, optionally bound to its source view. Without a view,
 * checks structural self-consistency (shape, boundary, milestones, counts,
 * prefix digest, layout digest). With a view, additionally proves exact
 * membership equality (no add/drop/duplicate), honest per-member bindings
 * (zone, section, hashes, representation, tool call), namespace and
 * checkpoint binding agreement, tool atomicity, and view-order preservation
 * inside zones. Returns { valid:true } or { valid:false, reason }.
 */
function validateContextPromptLayoutV2(input) {
  if (!isPlainObject(input)) return { valid: false, reason: 'context-layout-source-invalid' };
  if (unknownKeyOf(input, ['layout', 'view']) !== null) {
    return { valid: false, reason: 'context-layout-unknown-field' };
  }
  const layout = input.layout;
  const view = input.view === undefined ? null : input.view;
  if (!isPlainObject(layout)) return { valid: false, reason: 'context-layout-source-invalid' };
  if (unknownKeyOf(layout, LAYOUT_EXACT_KEYS) !== null) {
    return { valid: false, reason: 'context-layout-unknown-field' };
  }
  if (layout.schemaVersion !== LAYOUT_SCHEMA_VERSION) {
    return { valid: false, reason: 'context-layout-schema-mismatch' };
  }
  if (layout.layoutPolicyRevision !== LAYOUT_POLICY_REVISION_V1) {
    return { valid: false, reason: 'context-layout-policy-unknown' };
  }
  if (layout.disposable !== true) return { valid: false, reason: 'context-layout-not-disposable' };
  if (layout.scope !== 'ccv2-suffix') return { valid: false, reason: 'context-layout-scope-invalid' };
  if (!isPlainObject(layout.externalPrefix)) return { valid: false, reason: 'context-layout-external-prefix-invalid' };
  if (unknownKeyOf(layout.externalPrefix, LAYOUT_EXTERNAL_PREFIX_EXACT_KEYS) !== null) {
    return { valid: false, reason: 'context-layout-unknown-field' };
  }
  if (layout.externalPrefix.owner !== 'dsh-host'
    || layout.externalPrefix.slot !== 'system-prompt-assemble'
    || layout.externalPrefix.memberCount !== 0
    || layout.externalPrefix.attachPoint !== 'before-ccv2-suffix') {
    return { valid: false, reason: 'context-layout-external-prefix-invalid' };
  }
  if (!isPlainObject(layout.namespace)) return { valid: false, reason: 'context-layout-namespace-invalid' };
  if (unknownKeyOf(layout.namespace, LAYOUT_NAMESPACE_EXACT_KEYS) !== null) {
    return { valid: false, reason: 'context-layout-unknown-field' };
  }
  if (!isPlainObject(layout.checkpointBinding)) {
    return { valid: false, reason: 'context-layout-checkpoint-binding-invalid' };
  }
  if (unknownKeyOf(layout.checkpointBinding, LAYOUT_CHECKPOINT_BINDING_EXACT_KEYS) !== null) {
    return { valid: false, reason: 'context-layout-unknown-field' };
  }
  if (!Array.isArray(layout.blocks)) return { valid: false, reason: 'context-layout-blocks-invalid' };
  if (typeof layout.sourceViewId !== 'string' || typeof layout.sourceViewDigest !== 'string') {
    return { valid: false, reason: 'context-layout-source-mismatch' };
  }
  if (typeof layout.stablePrefixDigest !== 'string') {
    return { valid: false, reason: 'context-layout-prefix-digest-forged' };
  }
  if (!isPlainObject(layout.zoneCounts)) return { valid: false, reason: 'context-layout-zone-counts-forged' };
  if (typeof layout.layoutDigest !== 'string') return { valid: false, reason: 'context-layout-digest-mismatch' };

  const derived = checkLayoutDerivedConsistency(layout);
  if (derived !== null) return { valid: false, reason: derived };
  const atomic = checkLayoutToolAtomicity(layout);
  if (atomic !== null) return { valid: false, reason: atomic };

  if (view === null) return { valid: true, reason: null };
  if (!isPlainObject(view)) return { valid: false, reason: 'context-layout-view-invalid' };
  const viewCheck = viewV2.validateContextViewV2(view);
  if (!viewCheck.valid) return { valid: false, reason: 'context-layout-view-invalid' };

  if (layout.sourceViewId !== view.id) return { valid: false, reason: 'context-layout-source-mismatch' };
  if (layout.sourceViewDigest !== view.viewDigest) return { valid: false, reason: 'context-layout-source-mismatch' };
  if (layout.namespace.taskId !== view.namespace.taskId
    || layout.namespace.taskInstanceId !== view.namespace.taskInstanceId
    || layout.namespace.sessionId !== view.namespace.sessionId) {
    return { valid: false, reason: 'context-layout-namespace-mismatch' };
  }
  if (layout.checkpointBinding.checkpointGeneration !== view.checkpointBinding.checkpointGeneration
    || layout.checkpointBinding.checkpointId !== view.checkpointBinding.checkpointId) {
    return { valid: false, reason: 'context-layout-checkpoint-binding-mismatch' };
  }

  // Re-derive the expected binding for every view member and prove the
  // layout carries each member exactly once with honest metadata.
  const expectedByMember = new Map();
  const viewSequence = [];
  for (const section of viewV2.VIEW_SECTIONS) {
    for (const entry of view[section]) {
      const classification = classifyMaterializedForLayout({ entry, section });
      const key = 'materialized:' + entry.id;
      if (expectedByMember.has(key)) return { valid: false, reason: 'context-layout-view-invalid' };
      expectedByMember.set(key, {
        zone: classification.zone,
        reasonCode: classification.reasonCode,
        sourceSection: section,
        memberId: entry.id,
        sourceId: entry.sourceId,
        contentHash: entry.contentHash,
        representationKind: entry.representation === undefined || entry.representation === null
          ? null
          : entry.representation.kind,
        sourceContentHash: entry.representation === undefined || entry.representation === null
          ? null
          : entry.representation.sourceContentHash,
        toolCallId: toolCallIdOfMaterialized(entry),
      });
      viewSequence.push(key);
    }
  }
  for (const ref of view.referencedColdPages) {
    const key = 'reference:' + ref.pageId;
    if (expectedByMember.has(key)) return { valid: false, reason: 'context-layout-view-invalid' };
    expectedByMember.set(key, {
      zone: 'QUERY_EVIDENCE',
      reasonCode: 'layout-cold-reference-volatile',
      sourceSection: 'referencedColdPages',
      memberId: ref.pageId,
      sourceId: ref.pageId,
      contentHash: ref.contentHash,
      representationKind: null,
      sourceContentHash: null,
      toolCallId: null,
    });
    viewSequence.push(key);
  }

  if (layout.blocks.length !== expectedByMember.size) {
    return { valid: false, reason: 'context-layout-membership-mismatch' };
  }
  const seen = new Set();
  const layoutPosition = new Map();
  for (const block of layout.blocks) {
    const key = block.memberKind + ':' + block.memberId;
    if (seen.has(key)) return { valid: false, reason: 'context-layout-member-duplicate' };
    seen.add(key);
    layoutPosition.set(key, block.ordinal);
    const expected = expectedByMember.get(key);
    if (expected === undefined) return { valid: false, reason: 'context-layout-member-unknown' };
    if (block.zone !== expected.zone) return { valid: false, reason: 'context-layout-zone-forged' };
    if (block.reasonCode !== expected.reasonCode) return { valid: false, reason: 'context-layout-reason-forged' };
    if (block.sourceSection !== expected.sourceSection) {
      return { valid: false, reason: 'context-layout-section-forged' };
    }
    if (block.sourceId !== expected.sourceId) return { valid: false, reason: 'context-layout-binding-mismatch' };
    if (block.contentHash !== expected.contentHash) return { valid: false, reason: 'context-layout-hash-forged' };
    const blockRep = block.representationKind === undefined ? null : block.representationKind;
    const blockSrc = block.sourceContentHash === undefined ? null : block.sourceContentHash;
    if (blockRep !== expected.representationKind) {
      return { valid: false, reason: 'context-layout-representation-forged' };
    }
    if (blockSrc !== expected.sourceContentHash) {
      return { valid: false, reason: 'context-layout-representation-forged' };
    }
    const blockTool = block.toolCallId === undefined ? null : block.toolCallId;
    if (blockTool !== expected.toolCallId) return { valid: false, reason: 'context-layout-transaction-forged' };
  }
  for (const key of expectedByMember.keys()) {
    if (!seen.has(key)) return { valid: false, reason: 'context-layout-member-missing' };
  }

  // Relative order inside each zone must match frozen view order (tool
  // groups excluded: their internal order is proven contiguous above, and
  // a multi-entry group occupies one merged position).
  const zoneViewOrder = new Map();
  for (const key of viewSequence) {
    const expected = expectedByMember.get(key);
    if (expected.toolCallId !== null) continue;
    let list = zoneViewOrder.get(expected.zone);
    if (list === undefined) {
      list = [];
      zoneViewOrder.set(expected.zone, list);
    }
    list.push(key);
  }
  const zoneLayoutOrder = new Map();
  for (const block of layout.blocks) {
    const key = block.memberKind + ':' + block.memberId;
    const expected = expectedByMember.get(key);
    if (expected.toolCallId !== null) continue;
    let list = zoneLayoutOrder.get(block.zone);
    if (list === undefined) {
      list = [];
      zoneLayoutOrder.set(block.zone, list);
    }
    list.push(key);
  }
  for (const zone of zoneViewOrder.keys()) {
    const before = zoneViewOrder.get(zone).join(',');
    const after = (zoneLayoutOrder.get(zone) || []).join(',');
    if (before !== after) return { valid: false, reason: 'context-layout-order-violated' };
  }

  return { valid: true, reason: null };
}

// ---- canonical bytes + secret-safe description ----

function canonicalizeContextPromptLayoutV2(layout) {
  const check = validateContextPromptLayoutV2({ layout });
  if (!check.valid) failLayout(check.reason, 'cannot canonicalize an invalid layout');
  return canonicalJsonOf(layout);
}

/**
 * Secret-safe layout observability: IDs, hashes, zones, reason codes,
 * counts, source-section identity, digests. Never carries exactText, user
 * message text, requirements prose, tool output, code, logs, or secrets:
 * this function never reads any prose field of any input.
 */
function describeContextPromptLayoutV2(input) {
  if (!isPlainObject(input)) failLayout('source-invalid', 'input must be an object');
  if (unknownKeyOf(input, ['layout']) !== null) failLayout('source-invalid', 'input carries unknown keys');
  const check = validateContextPromptLayoutV2({ layout: input.layout });
  if (!check.valid) failLayout(check.reason, 'cannot describe an invalid layout');
  const layout = input.layout;
  return freezeDeep({
    schemaVersion: layout.schemaVersion,
    layoutPolicyRevision: layout.layoutPolicyRevision,
    sourceViewId: layout.sourceViewId,
    sourceViewDigest: layout.sourceViewDigest,
    scope: layout.scope,
    externalPrefix: deepClone(layout.externalPrefix),
    blockCount: layout.blocks.length,
    stablePrefixBoundary: layout.stablePrefixBoundary,
    stablePrefixDigest: layout.stablePrefixDigest,
    prefixMilestones: deepClone(layout.prefixMilestones),
    zoneCounts: deepClone(layout.zoneCounts),
    layoutDigest: layout.layoutDigest,
    stableMemberCount: layout.stablePrefixBoundary,
    volatileMemberCount: layout.blocks.length - layout.stablePrefixBoundary,
    disposable: true,
  });
}

module.exports = {
  LAYOUT_SCHEMA_VERSION,
  LAYOUT_POLICY_REVISION_V1,
  LAYOUT_DIGEST_DOMAIN_V1,
  LOGICAL_PREFIX_DIGEST_DOMAIN_V1,
  LAYOUT_ZONES,
  STABLE_ZONES,
  VOLATILE_ZONES,
  LAYOUT_EXACT_KEYS,
  LAYOUT_BLOCK_EXACT_KEYS,
  LAYOUT_REASON_CODES,
  REASON_ZONE,
  TASK_IDENTITY_SUBJECTS,
  CHECKPOINT_STATE_SUBJECTS,
  TOOL_PROTOCOL_SUBJECTS,
  classifyMaterializedForLayout,
  planContextPromptLayoutV2,
  validateContextPromptLayoutV2,
  canonicalizeContextPromptLayoutV2,
  describeContextPromptLayoutV2,
  deriveLayoutDigestV2,
  deriveLogicalPrefixDigestV2,
};
