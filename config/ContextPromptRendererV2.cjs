'use strict';
/**
 * ContextPromptRendererV2.cjs - CCV2-C08 physical renderer authority.
 *
 * The ONE authority that turns an already-finalized (C01->C06)
 * ContextView + ContextPromptLayout into physical model-facing
 * context bytes. It owns ONLY:
 *
 *   physical serialization of already-selected members
 *   layout order realization
 *   host attachment contract (message plan)
 *   render validation
 *   render digest
 *
 * It owns NONE of: membership, retrieval, tiering, packing,
 * compression, priority, routing, provider selection. It adds no
 * semantic prose: every content byte comes from a frozen
 * entry.exactText (materialized) or from the versioned reference-
 * marker contract below (referenced COLD). The separator and marker
 * framing are typed, versioned, token-counted, digest-bound, and
 * tested. Rendering overhead is part of authoritative token
 * accounting (spec option B): the render proves
 *
 *   renderedTokens = recount(joinedText) (authoritative wire bytes)
 *   boundaryDeltaTokens = recount - segmentTokens - separatorOverhead
 *     (measured subword boundary-merge delta, either sign)
 *
 * through the caller-supplied production counter, so the compiler
 * budget can never silently under-claim the wire bytes.
 *
 * Role contract (RENDER_ROLE_CONTRACT_V1, semantic, tested):
 *   entry.sourceType === 'current-turn' -> role 'user' (the actual
 *     current turn, byte-exact, exactly once per render)
 *   every other materialized entry      -> role 'system' (CCv2
 *     historical/state context; never impersonates the user)
 *   referenced COLD markers             -> role 'system'
 * Historical user content therefore never reaches a user-role message.
 * The host places these messages after the DSH-owned stable
 * system/controller prefix and before/around no other context: the
 * compiled projection replaces the legacy bulk region atomically.
 *
 * Fail-closed: any invalid view, layout, binding, duplicate member,
 * unbalanced tool transaction, missing mandatory member, or token
 * disagreement throws context-render-*. The OUTER active layer
 * (ContextCompilerActiveV2) catches render failures and falls back to
 * the legacy projection; compiler internals never salvage a partial
 * render (no strip-and-send).
 *
 * Determinism: no clocks, no randomness, no PIDs, no I/O. Identical
 * (view, layout, counter outputs) -> byte-identical render.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (C08 record).
 */

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const viewV2 = require('./ContextViewV2.cjs');
const layoutV2 = require('./ContextPromptLayoutV2.cjs');
const counterV2 = require('./ContextTokenCounterV2.cjs');

const RENDER_SCHEMA_VERSION = 1;
const RENDER_REVISION_V1 = 'context-prompt-render-v1';
const RENDER_DIGEST_DOMAIN_V1 = 'nexus/context-prompt-render/v1';
const RENDER_SEGMENT_DIGEST_DOMAIN_V1 = 'nexus/context-prompt-segment/v1';

// Typed, versioned framing contract. Both constants are token-bearing
// model-facing bytes and are counted into renderOverheadTokens.
const RENDER_SEPARATOR_V1 = String.fromCharCode(10);
const RENDER_ROLE_CONTRACT_V1 = 'render-roles-system-current-turn-v1';

// Reference-marker contract for referenced-only COLD pages:
// '[ccv2-ref:<pageId>:<contentHash[0..16)>]'. Deterministic, typed,
// counted as overhead, digest-bound.
const REFERENCE_MARKER_PREFIX_V1 = '[ccv2-ref:';
const REFERENCE_MARKER_SUFFIX_V1 = ']';
const PAGE_ID_PATTERN = /^cxp_[0-9a-f]{32}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

const RENDER_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'rendererRevision',
  'roleContract',
  'separatorContract',
  'sourceViewId',
  'sourceViewDigest',
  'layoutDigest',
  'tokenizerFingerprint',
  'segments',
  'messagePlan',
  'joinedText',
  'segmentTokens',
  'separatorOverheadTokens',
  'boundaryDeltaTokens',
  'referenceMarkerTokens',
  'renderedTokens',
  'evidenceMap',
  'renderDigest',
  'disposable',
]);

const SEGMENT_EXACT_KEYS = Object.freeze([
  'ordinal',
  'zone',
  'role',
  'memberKind',
  'memberId',
  'sourceId',
  'contentHash',
  'representationKind',
  'text',
  'textHash',
  'tokens',
  'segmentDigest',
]);

const MESSAGE_EXACT_KEYS = Object.freeze([
  'ordinal',
  'role',
  'contextSource',
  'segmentOrdinals',
  'text',
  'textHash',
  'tokens',
]);

const EVIDENCE_EXACT_KEYS = Object.freeze([
  'ordinal',
  'memberId',
  'sourceId',
  'contentHash',
  'layoutZone',
  'role',
  'segmentDigest',
]);

function failRender(code, detail) {
  throw new Error('context-render-' + code + (detail === undefined ? '' : ': ' + detail) + ' (DISCARDABLE)');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256HexUtf8(text) {
  return checkpointV2.sha256HexUtf8(String(text));
}

function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}

function referenceMarkerForV2(pageId, contentHash) {
  if (typeof pageId !== 'string' || !PAGE_ID_PATTERN.test(pageId)) {
    failRender('reference-invalid', 'referenced page id is not well-formed');
  }
  if (typeof contentHash !== 'string' || !HEX64_PATTERN.test(contentHash)) {
    failRender('reference-invalid', 'referenced content hash is not well-formed');
  }
  return REFERENCE_MARKER_PREFIX_V1 + pageId + ':' + contentHash.slice(0, 16) + REFERENCE_MARKER_SUFFIX_V1;
}

function deriveSegmentDigestV2(fields) {
  return sha256HexUtf8(RENDER_SEGMENT_DIGEST_DOMAIN_V1 + '\n' + canonicalJsonOf(fields));
}

function deriveRenderDigestV2(fields) {
  return sha256HexUtf8(RENDER_DIGEST_DOMAIN_V1 + '\n' + canonicalJsonOf(fields));
}

function indexViewEntriesV2(view) {
  const byMemberId = new Map();
  for (const section of viewV2.VIEW_SECTIONS) {
    const entries = view[section];
    for (const entry of entries) {
      if (byMemberId.has(entry.id)) failRender('view-duplicate-member', 'duplicate materialized member ' + String(entry.id).slice(0, 40));
      byMemberId.set(entry.id, { entry, section });
    }
  }
  const referencesByPage = new Map();
  for (const ref of view.referencedColdPages) {
    if (referencesByPage.has(ref.pageId)) failRender('view-duplicate-member', 'duplicate cold reference ' + String(ref.pageId).slice(0, 40));
    referencesByPage.set(ref.pageId, ref);
  }
  return { byMemberId, referencesByPage };
}

/**
 * Render a validated final ContextView through a validated layout.
 * Input exact keys: { view, layout, counter, rendererPolicyRevision? }.
 * The counter must be the request-bound production counter (its
 * fingerprint binds the render). Returns the frozen physical render.
 */
function renderContextPromptV2(input) {
  if (!isPlainObject(input)) failRender('render-input-invalid', 'render input must be an object');
  for (const key of Object.keys(input)) {
    if (['view', 'layout', 'counter', 'rendererPolicyRevision'].indexOf(key) === -1) {
      failRender('render-input-invalid', 'unknown render input key ' + String(key).slice(0, 64));
    }
  }
  const view = input.view;
  const layout = input.layout;
  const counter = input.counter;
  const counterCheck = counterV2.validateContextTokenCounterV2(counter);
  if (!counterCheck.valid) failRender('tokenizer-unavailable', 'no valid production token-counting authority');
  const viewCheck = viewV2.validateContextViewV2(view);
  if (!viewCheck.valid) failRender('view-invalid', viewCheck.reason || 'C01 gate rejected the view');
  const layoutCheck = layoutV2.validateContextPromptLayoutV2({ layout, view });
  if (!layoutCheck.valid) failRender('layout-invalid', layoutCheck.reason || 'C06 gate rejected the layout');
  if (layout.sourceViewId !== view.id) failRender('binding-mismatch', 'layout does not bind this view');
  if (layout.layoutDigest !== layoutV2.deriveLayoutDigestV2(layout)) {
    failRender('layout-digest-mismatch', 'layout digest does not recompute');
  }
  if (!Array.isArray(layout.blocks) || layout.blocks.length === 0) {
    failRender('layout-empty', 'active projection requires at least one laid-out member');
  }

  const indexed = indexViewEntriesV2(view);
  const segments = [];
  const evidenceMap = [];
  let currentTurnSegments = 0;

  layout.blocks.forEach((block, index) => {
    if (!isPlainObject(block) || block.ordinal !== index) {
      failRender('layout-order-invalid', 'layout block ordinals must be dense from zero');
    }
    let text = null;
    let role = 'system';
    if (block.memberKind === 'materialized') {
      const found = indexed.byMemberId.get(block.memberId);
      if (found === undefined) failRender('member-unbound', 'layout block binds no view member');
      const entry = found.entry;
      if (entry.sourceId !== block.sourceId || entry.contentHash !== block.contentHash) {
        failRender('member-binding-mismatch', 'layout block identity disagrees with the view member');
      }
      // Tool protocol must be balanced and complete: C02 never emits
      // open protocols into a compilable view, so any imbalance here
      // is a forged/tampered view and fails the render (outer fallback).
      if (entry.toolTransaction !== null && entry.toolTransaction !== undefined) {
        if (entry.toolTransaction.callPresent !== true || entry.toolTransaction.resultPresent !== true) {
          failRender('tool-protocol-invalid', 'unbalanced tool transaction in render member');
        }
      }
      text = entry.exactText;
      if (typeof text !== 'string' || text === '') failRender('member-empty', 'materialized member carries no model-facing text');
      if (sha256HexUtf8(text) !== entry.contentHash) {
        failRender('representation-hash-mismatch', 'member bytes do not hash to the bound content hash');
      }
      if (entry.sourceType === 'current-turn') {
        role = 'user';
        currentTurnSegments += 1;
      }
    } else if (block.memberKind === 'reference') {
      const ref = indexed.referencesByPage.get(block.sourceId);
      if (ref === undefined) failRender('member-unbound', 'layout reference binds no cold page');
      if (ref.contentHash !== block.contentHash) {
        failRender('member-binding-mismatch', 'layout reference identity disagrees with the view');
      }
      text = referenceMarkerForV2(ref.pageId, ref.contentHash);
      role = 'system';
    } else {
      failRender('member-kind-unknown', 'layout member kind is not renderable');
    }
    const textHash = sha256HexUtf8(text);
    let tokens = 0;
    try {
      tokens = counterV2.countTextVerifiedV2(counter, text);
    } catch (error) {
      failRender('counter-failed', String((error && error.message) || error).slice(0, 200));
    }
    const segmentDigest = deriveSegmentDigestV2({
      ordinal: index,
      zone: block.zone,
      role,
      memberKind: block.memberKind,
      memberId: block.memberId,
      sourceId: block.sourceId,
      contentHash: block.contentHash,
      representationKind: block.representationKind,
      textHash,
      rendererRevision: RENDER_REVISION_V1,
    });
    segments.push(Object.freeze({
      ordinal: index,
      zone: block.zone,
      role,
      memberKind: block.memberKind,
      memberId: block.memberId,
      sourceId: block.sourceId,
      contentHash: block.contentHash,
      representationKind: block.representationKind,
      text,
      textHash,
      tokens,
      segmentDigest,
    }));
    evidenceMap.push(Object.freeze({
      ordinal: index,
      memberId: block.memberId,
      sourceId: block.sourceId,
      contentHash: block.contentHash,
      layoutZone: block.zone,
      role,
      segmentDigest,
    }));
  });

  // The actual current turn must be present exactly once: zero means
  // the compiler dropped the live turn, more than one means
  // duplication. Both fail the render (outer deterministic fallback).
  if (currentTurnSegments !== 1) {
    failRender('current-turn-invalid', 'render carries ' + currentTurnSegments + ' current-turn segments, exactly one required');
  }

  // Mandatory preservation: every C01 mandatoryRef must be bound by a
  // rendered segment with the same source identity and shown hash.
  const segmentKeys = new Set(segments.map((segment) => segment.sourceId + '\n' + segment.contentHash));
  for (const ref of view.mandatoryRefs) {
    if (!isPlainObject(ref) || typeof ref.sourceId !== 'string' || typeof ref.contentHash !== 'string') {
      failRender('mandatory-invalid', 'mandatory manifest entry is malformed');
    }
    if (!segmentKeys.has(ref.sourceId + '\n' + ref.contentHash)) {
      failRender('mandatory-missing', 'mandatory member absent from the physical render');
    }
  }

  // Physical accounting (option B): separators and reference markers
  // are counted through the production counter; the joined-text
  // recount must equal segments + overhead exactly (no hidden bytes).
  const texts = segments.map((segment) => segment.text);
  const joinedText = texts.join(RENDER_SEPARATOR_V1);
  let segmentTokens = 0;
  for (const segment of segments) segmentTokens += segment.tokens;
  let separatorOverheadTokens = 0;
  if (segments.length > 1) {
    try {
      const perSeparator = counterV2.countTextVerifiedV2(counter, RENDER_SEPARATOR_V1);
      separatorOverheadTokens = perSeparator * (segments.length - 1);
    } catch (error) {
      failRender('counter-failed', String((error && error.message) || error).slice(0, 200));
    }
  }
  let joinedTokens = 0;
  try {
    joinedTokens = counterV2.countTextVerifiedV2(counter, joinedText);
  } catch (error) {
    failRender('counter-failed', String((error && error.message) || error).slice(0, 200));
  }
  // Boundary-merge delta (measured, never assumed): subword tokenizers
  // are not compositional, so the joined recount may differ from
  // segments + separator framing in either direction. The joined
  // recount is AUTHORITATIVE (it is the exact wire bytes); the delta
  // is reported explicitly, so no byte is ever hidden outside the
  // budget. C04 segment packing stays conservative-or-checked: the
  // active layer enforces renderedTokens <= hardMax on the recount.
  const boundaryDeltaTokens = joinedTokens - segmentTokens - separatorOverheadTokens;
  let referenceMarkerTokens = 0;
  for (const segment of segments) {
    if (segment.memberKind === 'reference') referenceMarkerTokens += segment.tokens;
  }
  const renderedTokens = joinedTokens;

  // Host attachment contract: consecutive same-role segments merge
  // into one message so C06 order is realized physically. The current
  // turn therefore forms the final user message; context forms prior
  // system messages. No legacy bulk bytes are referenced.
  const messagePlan = [];
  let run = null;
  const flushRun = () => {
    if (run === null) return;
    const text = run.texts.join(RENDER_SEPARATOR_V1);
    let tokens = 0;
    try {
      tokens = counterV2.countTextVerifiedV2(counter, text);
    } catch (error) {
      failRender('counter-failed', String((error && error.message) || error).slice(0, 200));
    }
    messagePlan.push(Object.freeze({
      ordinal: messagePlan.length,
      role: run.role,
      contextSource: 'ccv2-compiled-v1',
      segmentOrdinals: Object.freeze(run.ordinals.slice()),
      text,
      textHash: sha256HexUtf8(text),
      tokens,
    }));
    run = null;
  };
  for (const segment of segments) {
    if (run === null || run.role !== segment.role) {
      flushRun();
      run = { role: segment.role, texts: [], ordinals: [] };
    }
    run.texts.push(segment.text);
    run.ordinals.push(segment.ordinal);
  }
  flushRun();
  // Message-plan proof: same-role runs reconstruct the joined text
  // byte-exact (string equality, no counting assumption), so C06 order
  // is realized physically with zero hidden bytes by construction.
  const rebuiltTexts = [];
  for (const message of messagePlan) {
    if (rebuiltTexts.length > 0) rebuiltTexts.push(RENDER_SEPARATOR_V1);
    rebuiltTexts.push(message.text);
  }
  if (rebuiltTexts.join('') !== joinedText) {
    failRender('accounting-mismatch', 'message plan does not reconstruct the joined render');
  }

  const renderDigest = deriveRenderDigestV2({
    rendererRevision: RENDER_REVISION_V1,
    roleContract: RENDER_ROLE_CONTRACT_V1,
    separatorContract: RENDER_SEPARATOR_V1,
    sourceViewId: view.id,
    sourceViewDigest: view.viewDigest,
    layoutDigest: layout.layoutDigest,
    tokenizerFingerprint: counterCheck.fingerprint,
    segmentTokens,
    separatorOverheadTokens,
    boundaryDeltaTokens,
    renderedTokens,
    segments: segments.map((segment) => ({
      ordinal: segment.ordinal,
      role: segment.role,
      memberId: segment.memberId,
      contentHash: segment.contentHash,
      segmentDigest: segment.segmentDigest,
    })),
  });

  return Object.freeze({
    schemaVersion: RENDER_SCHEMA_VERSION,
    rendererRevision: RENDER_REVISION_V1,
    roleContract: RENDER_ROLE_CONTRACT_V1,
    separatorContract: RENDER_SEPARATOR_V1,
    sourceViewId: view.id,
    sourceViewDigest: view.viewDigest,
    layoutDigest: layout.layoutDigest,
    tokenizerFingerprint: counterCheck.fingerprint,
    segments: Object.freeze(segments),
    messagePlan: Object.freeze(messagePlan),
    joinedText,
    segmentTokens,
    separatorOverheadTokens,
    boundaryDeltaTokens,
    referenceMarkerTokens,
    renderedTokens,
    evidenceMap: Object.freeze(evidenceMap),
    renderDigest,
    disposable: true,
  });
}

/**
 * Validate a render object structurally (no recount): exact keys,
 * digest recomputation from its own segments, and binding fields.
 * Returns { valid:true } or { valid:false, reason } (never throws).
 */
function validateContextRenderV2(render) {
  const invalid = (reason) => ({ valid: false, reason });
  try {
    if (!isPlainObject(render)) return invalid('context-render-invalid');
    for (const key of Object.keys(render)) {
      if (RENDER_EXACT_KEYS.indexOf(key) === -1) return invalid('context-render-invalid');
    }
    if (render.schemaVersion !== RENDER_SCHEMA_VERSION) return invalid('context-render-invalid');
    if (render.rendererRevision !== RENDER_REVISION_V1) return invalid('context-render-invalid');
    if (render.roleContract !== RENDER_ROLE_CONTRACT_V1) return invalid('context-render-invalid');
    if (render.separatorContract !== RENDER_SEPARATOR_V1) return invalid('context-render-invalid');
    if (typeof render.sourceViewId !== 'string' || typeof render.sourceViewDigest !== 'string'
      || typeof render.layoutDigest !== 'string' || typeof render.tokenizerFingerprint !== 'string') {
      return invalid('context-render-invalid');
    }
    if (!Array.isArray(render.segments) || render.segments.length === 0) return invalid('context-render-invalid');
    for (let index = 0; index < render.segments.length; index += 1) {
      const segment = render.segments[index];
      if (!isPlainObject(segment)) return invalid('context-render-invalid');
      for (const key of Object.keys(segment)) {
        if (SEGMENT_EXACT_KEYS.indexOf(key) === -1) return invalid('context-render-invalid');
      }
      if (segment.ordinal !== index) return invalid('context-render-invalid');
      const recomputed = deriveSegmentDigestV2({
        ordinal: segment.ordinal,
        zone: segment.zone,
        role: segment.role,
        memberKind: segment.memberKind,
        memberId: segment.memberId,
        sourceId: segment.sourceId,
        contentHash: segment.contentHash,
        representationKind: segment.representationKind,
        textHash: segment.textHash,
        rendererRevision: RENDER_REVISION_V1,
      });
      if (recomputed !== segment.segmentDigest) return invalid('context-render-digest-mismatch');
      if (sha256HexUtf8(segment.text) !== segment.textHash) return invalid('context-render-digest-mismatch');
      if (sha256HexUtf8(segment.text) !== segment.contentHash && segment.memberKind === 'materialized') {
        return invalid('context-render-digest-mismatch');
      }
    }
    if (!Array.isArray(render.messagePlan) || render.messagePlan.length === 0) return invalid('context-render-invalid');
    for (const message of render.messagePlan) {
      if (!isPlainObject(message)) return invalid('context-render-invalid');
      for (const key of Object.keys(message)) {
        if (MESSAGE_EXACT_KEYS.indexOf(key) === -1) return invalid('context-render-invalid');
      }
    }
    if (!Array.isArray(render.evidenceMap) || render.evidenceMap.length !== render.segments.length) {
      return invalid('context-render-invalid');
    }
    const recomputed = deriveRenderDigestV2({
      rendererRevision: render.rendererRevision,
      roleContract: render.roleContract,
      separatorContract: render.separatorContract,
      sourceViewId: render.sourceViewId,
      sourceViewDigest: render.sourceViewDigest,
      layoutDigest: render.layoutDigest,
      tokenizerFingerprint: render.tokenizerFingerprint,
      segmentTokens: render.segmentTokens,
      separatorOverheadTokens: render.separatorOverheadTokens,
      boundaryDeltaTokens: render.boundaryDeltaTokens,
      renderedTokens: render.renderedTokens,
      segments: render.segments.map((segment) => ({
        ordinal: segment.ordinal,
        role: segment.role,
        memberId: segment.memberId,
        contentHash: segment.contentHash,
        segmentDigest: segment.segmentDigest,
      })),
    });
    if (recomputed !== render.renderDigest) return invalid('context-render-digest-mismatch');
    if (typeof render.joinedText !== 'string') return invalid('context-render-invalid');
    for (const field of ['segmentTokens', 'separatorOverheadTokens', 'referenceMarkerTokens', 'renderedTokens']) {
      if (!Number.isInteger(render[field]) || render[field] < 0) return invalid('context-render-invalid');
    }
    if (!Number.isInteger(render.boundaryDeltaTokens)) return invalid('context-render-invalid');
    if (render.segmentTokens + render.separatorOverheadTokens + render.boundaryDeltaTokens !== render.renderedTokens) {
      return invalid('context-render-digest-mismatch');
    }
    if (render.disposable !== true) return invalid('context-render-invalid');
    return { valid: true, reason: null };
  } catch {
    return invalid('context-render-invalid');
  }
}

/**
 * Secret-safe render summary (diagnostics only): ids, digests,
 * counts, tokens. Never segment text.
 */
function describeContextRenderV2(render) {
  const check = validateContextRenderV2(render);
  if (!check.valid) return Object.freeze({ valid: false, reason: check.reason });
  return Object.freeze({
    valid: true,
    sourceViewId: render.sourceViewId,
    sourceViewDigest: render.sourceViewDigest,
    layoutDigest: render.layoutDigest,
    renderDigest: render.renderDigest,
    tokenizerFingerprint: render.tokenizerFingerprint,
    segmentCount: render.segments.length,
    messageCount: render.messagePlan.length,
    segmentTokens: render.segmentTokens,
    separatorOverheadTokens: render.separatorOverheadTokens,
    boundaryDeltaTokens: render.boundaryDeltaTokens,
    referenceMarkerTokens: render.referenceMarkerTokens,
    renderedTokens: render.renderedTokens,
  });
}

module.exports = {
  RENDER_SCHEMA_VERSION,
  RENDER_REVISION_V1,
  RENDER_DIGEST_DOMAIN_V1,
  RENDER_SEGMENT_DIGEST_DOMAIN_V1,
  RENDER_SEPARATOR_V1,
  RENDER_ROLE_CONTRACT_V1,
  REFERENCE_MARKER_PREFIX_V1,
  REFERENCE_MARKER_SUFFIX_V1,
  RENDER_EXACT_KEYS,
  renderContextPromptV2,
  validateContextRenderV2,
  describeContextRenderV2,
  referenceMarkerForV2,
};
