'use strict';
/**
 * ContextEvidenceRehydrationV2.cjs - CCV2-B03 exact evidence rehydration.
 *
 * ONE production authority for identity-driven exact rehydration over the
 * frozen B01 ContextPage contract (config/ContextPageV2.cjs) and the frozen
 * B02 content-addressed store (config/ContextPageStoreV2.cjs). B03 answers
 * "I already know exactly which evidence I need; give me that exact
 * validated evidence" and NOTHING else:
 *
 *   Known EvidenceRef -> durable binding -> Known ContextPage
 *     -> Known exact backing route -> exact evidence
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (section 27, B03 freeze record). B01/B02 identity semantics are consumed
 * verbatim and never modified here.
 *
 * Frozen rules:
 * - Every call carries an explicit expectedNamespace, enforced by the frozen
 *   store/page authorities BEFORE any evidence is returned. Cross-task and
 *   cross-repository reads fail closed even for byte-identical content:
 *   deduplication never confers access.
 * - Missing identity fails closed. There is no relevance path, no candidate
 *   list, no query string, no fallback to similar pages, summaries, or
 *   advisory gloss. EvidenceRef.summary and semanticGloss NEVER substitute
 *   for exact backing.
 * - Caller-held objects are hints only: production flow re-reads and
 *   revalidates durable state through the frozen authorities on every call.
 * - Tool-result pages prove a balanced canonical tool unit over the exact
 *   resolved session events (call exists, matching result exists, call
 *   before result, unit balanced, protocol identity matches). One-sided or
 *   mismatched units fail closed.
 * - Pure-session pages resolve iff the caller supplies a session exact
 *   source AND the page attests the frozen B03 session digest (see
 *   config/ContextSessionEvidenceSourceV2.cjs). The stored page is never
 *   rewritten; rehydratable=false pages without a provable route are
 *   refused as not-rehydratable.
 * - Repository/artifact evidence resolves ONLY from the already-known exact
 *   locator in sourceBinding. Changed source bytes invalidate the old
 *   identity (source-mismatch); newer bytes are never returned under it.
 * - Text evidence is exact persistable text (UTF-8, redaction-stable where
 *   the frozen pipeline owns the route). Binary evidence stays binary:
 *   exact bytes with mediaType binary, never decoded, never rendered.
 * - B03 is read-only: no store/session/repository/page/EvidenceRef mutation,
 *   no advisory updates, no access-time metadata, no prompt materialization,
 *   no budget, no tier, no view, no compiler.
 *
 * B03H clarification (section 28, frozen): the stored B01
 * page.rehydratable field is NEVER redefined here. Runtime exact
 * resolvability is a separate deterministic concept exposed by the pure
 * capability helper inspectExactResolutionV2 (no reads, no authority).
 * B04 handoff rule (frozen): B04 MUST NOT use the stored rehydratable flag
 * alone to decide rehydrate-on-demand tiering; it must distinguish
 * durably self-backed vs exactly source-resolvable vs not exactly
 * resolvable using the inspector modes. B03 owns proof of exact
 * resolution; B04 owns tier policy.
 */

const crypto = require('node:crypto');

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const pageV2 = require('./ContextPageV2.cjs');
const storeV2 = require('./ContextPageStoreV2.cjs');
const sessionSource = require('./ContextSessionEvidenceSourceV2.cjs');

// ---- frozen constants ----
const REHYDRATION_SCHEMA_VERSION = 1;
const REHYDRATION_DIGEST_DOMAIN_V1 = 'nexus/context-rehydration-digest/v1';
const SOURCE_ROUTES = Object.freeze(['inline-exact', 'blob', 'session', 'repository', 'artifact']);
const MEDIA_TYPES = Object.freeze(['text', 'binary']);
const PAGE_ID_PATTERN = /^cxp_[0-9a-f]{32}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

const REHYDRATED_RESULT_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'evidenceId', 'pageId', 'kind', 'contentHash', 'namespace',
  'provenance', 'sourceRoute', 'mediaType', 'exactText', 'exactBytes',
  'sourceIdentity', 'resultDigest', 'verified',
]);

// Module-private proof brand (same pattern as B02H): unforgable without
// module access, so no caller can manufacture verified:true.
const REHYDRATED_BRAND = Symbol('nexus.ccv2.rehydrated-evidence');

function failRehydration(reason, detail) {
  throw new Error('v2-context-rehydration: ' + reason + (detail ? ' (' + detail + ')' : '') + ' (BLOCK/KEEP)');
}

function sha256HexUtf8(text) {
  return checkpointV2.sha256HexUtf8(String(text));
}

function sha256HexBytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function unknownKeyOf(value, allowedKeys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) return key;
  }
  return null;
}

function boundedCause(error) {
  return String(error && error.message ? error.message : error).slice(0, 240);
}

// Map frozen B01/B02/store/source errors onto stable B03 reason codes.
// B03-family errors (this module + the two source adapters) already carry
// stable context-rehydration-* codes and pass through untouched.
function wrapSourceError(error) {
  const message = String(error && error.message ? error.message : error);
  if (message.indexOf('v2-context-rehydration:') === 0
    || message.indexOf('v2-session-source:') === 0
    || message.indexOf('v2-repository-source:') === 0) {
    throw error;
  }
  const cause = boundedCause(error);
  const has = (fragment) => message.indexOf(fragment) !== -1;
  if (has('context-page-namespace-mismatch') || has('context-evidence-namespace-mismatch')) {
    failRehydration('context-rehydration-namespace-mismatch', cause);
  }
  if (has('context-page-missing') || has('context-evidence-missing') || has('context-blob-missing')
    || has('context-store-missing') || has('context-advisory-missing')) {
    failRehydration('context-rehydration-evidence-not-found', cause);
  }
  if (has('context-evidence-content-mismatch') || has('context-evidence-id-mismatch')) {
    failRehydration('context-rehydration-binding-mismatch', cause);
  }
  if (has('context-page-content-mismatch') || has('context-blob-content-mismatch')
    || has('context-page-digest-mismatch') || has('context-evidence-corrupt')
    || has('context-page-corrupt') || has('context-store-corrupt') || has('context-store-conflict')
    || has('context-page-id-mismatch') || has('context-page-rehydratable-invalid')) {
    failRehydration('context-rehydration-content-mismatch', cause);
  }
  if (has('context-namespace-required')) {
    failRehydration('context-rehydration-namespace-required', cause);
  }
  failRehydration('context-rehydration-source-mismatch', cause);
}

function requireExpectedNamespace(expectedNamespace) {
  if (!expectedNamespace || typeof expectedNamespace !== 'object' || Array.isArray(expectedNamespace)) {
    failRehydration('context-rehydration-namespace-required', 'an explicit expected namespace is required');
  }
  return expectedNamespace;
}

function requireContextRoot(contextRoot) {
  if (typeof contextRoot !== 'string' || contextRoot === '') {
    failRehydration('context-rehydration-source-missing', 'contextRoot is required');
  }
  return contextRoot;
}

// ---- deterministic result digest (telemetry/idempotency only) ----
function deriveRehydrationDigestV2(fields) {
  if (!fields || typeof fields !== 'object') failRehydration('context-rehydration-unknown-field', 'digest fields are required');
  for (const key of ['pageId', 'contentHash', 'sourceRoute', 'mediaType', 'sourceIdentity']) {
    if (typeof fields[key] !== 'string' || fields[key] === '') {
      failRehydration('context-rehydration-unknown-field', 'digest field ' + key + ' is required');
    }
  }
  if (!fields.namespace || typeof fields.namespace !== 'object') {
    failRehydration('context-rehydration-unknown-field', 'digest namespace is required');
  }
  return sha256HexUtf8(JSON.stringify(checkpointV2.canonicalize({
    domain: REHYDRATION_DIGEST_DOMAIN_V1,
    pageId: fields.pageId,
    contentHash: fields.contentHash,
    sourceRoute: fields.sourceRoute,
    mediaType: fields.mediaType,
    namespace: fields.namespace,
    sourceIdentity: fields.sourceIdentity,
  })));
}

// ---- tool protocol proof (frozen) ----
// Structural readers mirror the frozen A06 field spellings exactly
// (assistant tool-call blocks: id/callId/toolCallId; results:
// message.source.callId, block.toolCallId, data.callId). Balance semantics
// mirror the frozen compaction delta (call +1, result -1, never negative,
// ends at zero). No second protocol model is introduced.
function toolCallIdOfBlock(block) {
  if (!block || typeof block !== 'object') return null;
  for (const key of ['id', 'callId', 'toolCallId']) {
    if (typeof block[key] === 'string' && block[key] !== '') return block[key];
  }
  return null;
}

function toolCallIdsOfAssistantEvent(event) {
  const content = event && event.data && event.data.message && Array.isArray(event.data.message.content)
    ? event.data.message.content : [];
  const ids = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'tool-call') continue;
    const id = toolCallIdOfBlock(block);
    if (id !== null) ids.push(id);
  }
  return ids;
}

function toolResultCallIdOf(event) {
  if (!event || typeof event !== 'object' || event.type !== 'tool/result') return null;
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const source = data.message && typeof data.message === 'object' ? data.message.source : null;
  if (source && typeof source.callId === 'string' && source.callId !== '') return source.callId;
  const content = data.message && Array.isArray(data.message.content) ? data.message.content : [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.toolCallId === 'string' && block.toolCallId !== '') return block.toolCallId;
  }
  if (typeof data.callId === 'string' && data.callId !== '') return data.callId;
  return null;
}

function toolCallEventCallIdOf(event) {
  if (!event || typeof event !== 'object' || event.type !== 'tool/call') return null;
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  if (typeof data.callId === 'string' && data.callId !== '') return data.callId;
  return null;
}

// Prove the exact resolved events form the claimed supported tool unit.
// Rejects: call only, result only, wrong result for call, result before
// call, interleaved incompatible unit, duplicate seq, non-protocol events
// inside the claimed unit.
function validateToolTransactionV2(eventsInOrder) {
  if (!Array.isArray(eventsInOrder) || eventsInOrder.length < 2) {
    failRehydration('context-rehydration-tool-protocol-invalid', 'tool-result evidence requires call + result events');
  }
  const seenSeq = new Set();
  const opened = new Map();
  const results = [];
  let balance = 0;
  for (const event of eventsInOrder) {
    if (!event || typeof event !== 'object') {
      failRehydration('context-rehydration-tool-protocol-invalid', 'tool unit carries a non-object event');
    }
    if (seenSeq.has(event.seq)) {
      failRehydration('context-rehydration-tool-protocol-invalid', 'duplicate seq inside the tool unit');
    }
    seenSeq.add(event.seq);
    if (event.type === 'assistant/message') {
      const ids = toolCallIdsOfAssistantEvent(event);
      if (ids.length === 0) {
        failRehydration('context-rehydration-tool-protocol-invalid', 'assistant event opens no tool call');
      }
      for (const id of ids) {
        if (opened.has(id)) {
          failRehydration('context-rehydration-tool-protocol-invalid', 'duplicate tool call identity');
        }
        opened.set(id, event.seq);
        balance += 1;
      }
      continue;
    }
    if (event.type === 'tool/result') {
      const callId = toolResultCallIdOf(event);
      if (callId === null || !opened.has(callId)) {
        failRehydration('context-rehydration-tool-protocol-invalid', 'result closes no open call in this unit');
      }
      if (!(opened.get(callId) < event.seq)) {
        failRehydration('context-rehydration-tool-protocol-invalid', 'result does not follow its call');
      }
      results.push({ callId, seq: event.seq });
      balance -= 1;
      if (balance < 0) {
        failRehydration('context-rehydration-tool-protocol-invalid', 'result precedes its call inside this unit');
      }
      continue;
    }
    if (event.type === 'tool/call') {
      const callId = toolCallEventCallIdOf(event);
      if (callId === null || !opened.has(callId) || !(opened.get(callId) <= event.seq)) {
        failRehydration('context-rehydration-tool-protocol-invalid', 'tool dispatch matches no open call in this unit');
      }
      continue;
    }
    failRehydration('context-rehydration-tool-protocol-invalid', 'non-protocol event inside the claimed tool unit');
  }
  if (opened.size === 0) {
    failRehydration('context-rehydration-tool-protocol-invalid', 'tool unit opens no call');
  }
  if (results.length === 0) {
    failRehydration('context-rehydration-tool-protocol-invalid', 'tool unit closes no call');
  }
  for (const [callId] of opened) {
    if (!results.some((result) => result.callId === callId)) {
      failRehydration('context-rehydration-tool-protocol-invalid', 'tool call has no matching result in this unit');
    }
  }
  if (balance !== 0) {
    failRehydration('context-rehydration-tool-protocol-invalid', 'tool unit is not balanced');
  }
  return { calls: opened.size, results: results.length };
}

// ---- session linkage proof (frozen) ----
// Resolves every bound seq by canonical seq identity and, for tool-result
// pages, proves the balanced unit. Returns the resolved events in seq order.
// Digest comparison against page.contentHash happens ONLY for pure-session
// pages (byte-backed pages bind contentHash to their byte route; seqs are
// provenance linkage there, still identity-checked).
function resolveSessionLinkageV2(page, sessionSourceArg) {
  const seqs = page.sourceSeqs || [];
  if (seqs.length === 0) return [];
  if (!sessionSourceArg || typeof sessionSourceArg !== 'object') {
    if (page.kind === 'tool-result') {
      failRehydration('context-rehydration-source-missing', 'tool-result evidence requires a session exact source');
    }
    return [];
  }
  if (typeof sessionSourceArg.sessionId !== 'string' || typeof sessionSourceArg.readEvents !== 'function') {
    failRehydration('context-rehydration-source-missing', 'session exact source is malformed');
  }
  if (sessionSourceArg.sessionId !== page.namespace.sessionId) {
    failRehydration('context-rehydration-source-mismatch', 'session source identity is outside the page namespace');
  }
  let resolved = null;
  try {
    resolved = sessionSourceArg.readEvents(seqs.slice());
  } catch (error) {
    wrapSourceError(error);
  }
  if (!Array.isArray(resolved) || resolved.length !== seqs.length) {
    failRehydration('context-rehydration-source-mismatch', 'session source returned a diverging event count');
  }
  for (let index = 0; index < seqs.length; index += 1) {
    const event = resolved[index];
    if (event === null || event === undefined) {
      failRehydration('context-rehydration-source-missing', 'canonical session event ' + seqs[index] + ' is not available');
    }
    if (!event || typeof event !== 'object' || event.seq !== seqs[index]) {
      failRehydration('context-rehydration-source-mismatch', 'session event identity diverged for seq ' + seqs[index]);
    }
  }
  if (page.kind === 'tool-result') {
    validateToolTransactionV2(resolved);
  }
  return resolved;
}

// ---- backing resolution (frozen priority) ----
// inline-exact > blob > sourceBinding(repository-span|artifact) > session.
// Co-present routes must already agree (B01 creation + B02 read-time proof);
// B03 re-verifies each touched edge explicitly.
// B03H media determinism (frozen, section 28): text/binary classification is
// a pure function of the frozen source contract (exact bytes + frozen
// pipeline). Strict UTF-8 uses TextDecoder fatal (no locale, no platform
// default encoding); the word-run gate uses fixed ASCII classes (no
// filesystem metadata); the persistability check is the frozen deterministic
// redaction pipeline (no mtime, no randomness). Same bytes -> same mediaType
// on every host and every restart. Text-to-binary conservative fallback is
// allowed; binary is NEVER coerced to model-facing text.
function strictDecodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function hasLongWordRun(text) {
  let run = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const word = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || code === 95 || code === 46 || code === 45;
    if (word) {
      run += 1;
      if (run > 4096) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

function resolvePageBackingV2(input) {
  if (!input || typeof input !== 'object') failRehydration('context-rehydration-unknown-field', 'backing input is required');
  const unknown = unknownKeyOf(input, ['page', 'contextRoot', 'sessionSource', 'repositorySource', 'artifactSource']);
  if (unknown !== null) failRehydration('context-rehydration-unknown-field', unknown);
  const page = input.page;
  const backingRoot = typeof input.contextRoot === 'string' && input.contextRoot !== '' ? input.contextRoot : null;
  if (!page || typeof page !== 'object') failRehydration('context-rehydration-content-mismatch', 'durable page is required');
  const check = pageV2.validateContextPageV2(page);
  if (!check.valid) failRehydration('context-rehydration-content-mismatch', check.reason || 'stored page is invalid');

  const hasExactText = page.exactText !== null && page.exactText !== undefined;
  const hasBlobRef = page.exactBlobRef !== null && page.exactBlobRef !== undefined;
  const hasBinding = page.sourceBinding !== null && page.sourceBinding !== undefined;
  const hasSeqs = Array.isArray(page.sourceSeqs) && page.sourceSeqs.length > 0;

  if (!page.rehydratable && (hasExactText || hasBlobRef || hasBinding)) {
    failRehydration('context-rehydration-content-mismatch', 'stored rehydratable flag diverges from the exact route');
  }

  // Non-rehydratable pages resolve ONLY through the deterministic session
  // digest route (sufficient source identity, stored page untouched).
  if (!page.rehydratable) {
    if (!hasSeqs) failRehydration('context-rehydration-not-rehydratable', 'page carries no deterministic exact route');
    const events = resolveSessionLinkageV2(page, input.sessionSource);
    if (events.length === 0) {
      failRehydration('context-rehydration-not-rehydratable', 'pure-session page has no session exact source');
    }
    let redacted = null;
    try {
      redacted = sessionSource.canonicalSessionEvidenceTextV2(page.namespace.sessionId, events);
    } catch (error) {
      wrapSourceError(error);
    }
    if (sha256HexUtf8(redacted) !== page.contentHash) {
      failRehydration('context-rehydration-source-mismatch', 'canonical session evidence diverged from the bound identity');
    }
    return {
      sourceRoute: 'session',
      mediaType: 'text',
      exactText: redacted,
      exactBytes: null,
      sourceIdentity: 'session:' + page.namespace.sessionId + ':seqs:' + page.sourceSeqs.join(','),
    };
  }

  // Inline exactText route: recompute, compare, return persistable text.
  if (hasExactText) {
    if (sha256HexUtf8(page.exactText) !== page.contentHash) {
      failRehydration('context-rehydration-content-mismatch', 'inline exact bytes diverged from the bound identity');
    }
    resolveSessionLinkageV2(page, input.sessionSource);
    return {
      sourceRoute: 'inline-exact',
      mediaType: 'text',
      exactText: page.exactText,
      exactBytes: null,
      sourceIdentity: 'page:' + page.id,
    };
  }

  // Blob route through the B02 authority only (never direct store paths).
  if (hasBlobRef) {
    if (backingRoot === null) {
      failRehydration('context-rehydration-source-missing', 'blob-backed evidence requires a bound contextRoot');
    }
    let blobBytes = null;
    try {
      blobBytes = storeV2.readBlobV2(backingRoot, page.exactBlobRef);
    } catch (error) {
      wrapSourceError(error);
    }
    if (sha256HexBytes(blobBytes) !== page.contentHash) {
      failRehydration('context-rehydration-content-mismatch', 'blob bytes diverged from the bound identity');
    }
    resolveSessionLinkageV2(page, input.sessionSource);
    const digest = String(page.exactBlobRef).slice('blob:sha256:'.length);
    if (sha256HexBytes(blobBytes) !== digest) {
      failRehydration('context-rehydration-content-mismatch', 'blob bytes diverged from the blob reference');
    }
    const decoded = strictDecodeUtf8(blobBytes);
    if (decoded !== null && !hasLongWordRun(decoded)
      && checkpointV2.redactCheckpointTextV2(decoded, decoded.length * 2 + 4096) === decoded) {
      return {
        sourceRoute: 'blob', mediaType: 'text', exactText: decoded, exactBytes: null, sourceIdentity: page.exactBlobRef,
      };
    }
    if (decoded !== null && (hasLongWordRun(decoded) || decoded.length === 0)) {
      // Long-run or empty decodable bytes cannot travel the text pipeline
      // deterministically: opaque binary, never coerced.
      return {
        sourceRoute: 'blob', mediaType: 'binary', exactText: null,
        exactBytes: Buffer.from(blobBytes), sourceIdentity: page.exactBlobRef,
      };
    }
    if (decoded === null) {
      return {
        sourceRoute: 'blob', mediaType: 'binary', exactText: null,
        exactBytes: Buffer.from(blobBytes), sourceIdentity: page.exactBlobRef,
      };
    }
    failRehydration('context-rehydration-media-type-invalid', 'blob text is not in persistable redacted form');
  }

  // Exact sourceBinding routes (locator already known: resolution, not lookup).
  if (hasBinding && page.sourceBinding.kind === 'repository-span') {
    const binding = page.sourceBinding;
    if (!input.repositorySource || typeof input.repositorySource !== 'object'
      || typeof input.repositorySource.readSpanText !== 'function') {
      failRehydration('context-rehydration-source-missing', 'repository-span evidence requires a repository exact source');
    }
    let span = null;
    try {
      span = input.repositorySource.readSpanText(binding.path, binding.startLine, binding.endLine);
    } catch (error) {
      wrapSourceError(error);
    }
    if (typeof span !== 'string') {
      failRehydration('context-rehydration-source-mismatch', 'repository source returned non-text for a text span');
    }
    if ((binding.symbol !== null && binding.symbol !== undefined) && !span.includes(binding.symbol)) {
      failRehydration('context-rehydration-source-mismatch', 'bound symbol is no longer addressed by the exact span');
    }
    if (sha256HexUtf8(span) !== String(binding.contentDigest)
      || sha256HexUtf8(span) !== page.contentHash) {
      failRehydration('context-rehydration-source-mismatch', 'repository source diverged from the bound identity');
    }
    resolveSessionLinkageV2(page, input.sessionSource);
    return {
      sourceRoute: 'repository',
      mediaType: 'text',
      exactText: span,
      exactBytes: null,
      sourceIdentity: 'repo:' + binding.path + '#L' + binding.startLine + '-L' + binding.endLine,
    };
  }

  if (hasBinding && page.sourceBinding.kind === 'artifact') {
    const binding = page.sourceBinding;
    if (!input.artifactSource || typeof input.artifactSource !== 'object'
      || typeof input.artifactSource.readArtifactBytes !== 'function') {
      failRehydration('context-rehydration-source-missing', 'artifact evidence requires an artifact exact source');
    }
    let bytes = null;
    try {
      bytes = input.artifactSource.readArtifactBytes(binding.artifactId);
    } catch (error) {
      wrapSourceError(error);
    }
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      failRehydration('context-rehydration-source-missing', 'artifact bytes are not available');
    }
    if (sha256HexBytes(bytes) !== String(binding.contentDigest)
      || sha256HexBytes(bytes) !== page.contentHash) {
      failRehydration('context-rehydration-source-mismatch', 'artifact source diverged from the bound identity');
    }
    resolveSessionLinkageV2(page, input.sessionSource);
    // Opaque artifact bytes: exact binary, never decoded or redacted.
    return {
      sourceRoute: 'artifact',
      mediaType: 'binary',
      exactText: null,
      exactBytes: Buffer.from(bytes),
      sourceIdentity: 'artifact:' + binding.artifactId,
    };
  }

  if (hasBinding) {
    failRehydration('context-rehydration-content-mismatch', 'stored page carries an unknown source binding');
  }

  // Session-only rehydratable pages cannot exist under frozen B01 (pure
  // session implies rehydratable=false); reaching here is corruption.
  failRehydration('context-rehydration-not-rehydratable', 'page carries no deterministic exact route');
  return null;
}

// The B02 store authority is root-scoped per call; the blob leg therefore
// takes contextRoot explicitly (module holds no cache and no mutable state:
// restart-safe by construction, identical reads across processes).

// ---- B03H: stored rehydratability vs runtime exact resolvability ----
// Frozen distinction (section 28): page.rehydratable is the immutable B01
// property of the stored page itself (byte-strong route present at mint).
// Effective exact resolvability is whether B03 can currently prove an exact
// route for the page PLUS the explicitly supplied exact-source authority.
// A pure-session page keeps rehydratable:false forever and may still be
// exactly resolvable when a bound SessionSource is supplied; supplying a
// source NEVER rewrites the stored flag. The inspector below is capability
// metadata only: it performs NO reads, resolves NO bytes, declares NO
// verified evidence, and owns NO authority over retention or memory tier.
// Advisory fields (semanticGloss, summary-shaped hints, similar pages) can
// NEVER contribute to resolvability: only durable backing or an explicit
// exact-source authority counts.
const EXACT_RESOLUTION_MODES = Object.freeze([
  'durable-inline',
  'durable-blob',
  'exact-session-source',
  'exact-repository-source',
  'exact-artifact-source',
]);

function hasSessionSourceShape(source) {
  return Boolean(source && typeof source === 'object'
    && typeof source.sessionId === 'string' && source.sessionId !== ''
    && typeof source.readEvents === 'function');
}

function hasRepositorySourceShape(source) {
  return Boolean(source && typeof source === 'object'
    && typeof source.readSpanText === 'function');
}

function hasArtifactSourceShape(source) {
  return Boolean(source && typeof source === 'object'
    && typeof source.readArtifactBytes === 'function');
}

function inspectExactResolutionV2(page, sources) {
  const src = sources === undefined || sources === null ? {} : sources;
  if (typeof src !== 'object' || Array.isArray(src)) {
    failRehydration('context-rehydration-unknown-field', 'inspection sources must be an object');
  }
  const unknown = unknownKeyOf(src, ['sessionSource', 'repositorySource', 'artifactSource']);
  if (unknown !== null) failRehydration('context-rehydration-unknown-field', unknown);
  const storedRehydratable = Boolean(page && typeof page === 'object' && page.rehydratable === true);
  const check = pageV2.validateContextPageV2(page);
  if (!check.valid) {
    return Object.freeze({
      resolvable: false, mode: null, requiresExternalSource: false,
      storedRehydratable, durablySelfBacked: false,
    });
  }
  const hasExactText = page.exactText !== null && page.exactText !== undefined;
  const hasBlobRef = page.exactBlobRef !== null && page.exactBlobRef !== undefined;
  const hasBinding = page.sourceBinding !== null && page.sourceBinding !== undefined;
  const hasSeqs = Array.isArray(page.sourceSeqs) && page.sourceSeqs.length > 0;
  const durablySelfBacked = hasExactText || hasBlobRef;
  if (hasExactText) {
    return Object.freeze({
      resolvable: true, mode: 'durable-inline', requiresExternalSource: false,
      storedRehydratable, durablySelfBacked,
    });
  }
  if (hasBlobRef) {
    return Object.freeze({
      resolvable: true, mode: 'durable-blob', requiresExternalSource: false,
      storedRehydratable, durablySelfBacked,
    });
  }
  if (hasBinding && page.sourceBinding.kind === 'repository-span') {
    const present = hasRepositorySourceShape(src.repositorySource);
    return Object.freeze({
      resolvable: present, mode: 'exact-repository-source', requiresExternalSource: true,
      storedRehydratable, durablySelfBacked,
    });
  }
  if (hasBinding && page.sourceBinding.kind === 'artifact') {
    const present = hasArtifactSourceShape(src.artifactSource);
    return Object.freeze({
      resolvable: present, mode: 'exact-artifact-source', requiresExternalSource: true,
      storedRehydratable, durablySelfBacked,
    });
  }
  if (hasBinding || !hasSeqs) {
    return Object.freeze({
      resolvable: false, mode: null, requiresExternalSource: false,
      storedRehydratable, durablySelfBacked,
    });
  }
  // Pure-session route: the mode is structurally known; resolvability
  // additionally requires the supplied authority to be bound to this page's
  // session. A wrong-session authority is capability-absent (false); a
  // mutated payload still fails at proof time inside rehydration.
  if (hasSessionSourceShape(src.sessionSource) && src.sessionSource.sessionId === page.namespace.sessionId) {
    return Object.freeze({
      resolvable: true, mode: 'exact-session-source', requiresExternalSource: true,
      storedRehydratable, durablySelfBacked,
    });
  }
  return Object.freeze({
    resolvable: false, mode: 'exact-session-source', requiresExternalSource: true,
    storedRehydratable, durablySelfBacked,
  });
}

function brandRehydrated(fields) {
  const result = {
    schemaVersion: REHYDRATION_SCHEMA_VERSION,
    evidenceId: fields.evidenceId === undefined ? null : fields.evidenceId,
    pageId: fields.pageId,
    kind: fields.kind,
    contentHash: fields.contentHash,
    namespace: fields.namespace,
    provenance: fields.provenance,
    sourceRoute: fields.sourceRoute,
    mediaType: fields.mediaType,
    exactText: fields.exactText === undefined ? null : fields.exactText,
    exactBytes: fields.exactBytes === undefined || fields.exactBytes === null ? null : Buffer.from(fields.exactBytes),
    sourceIdentity: fields.sourceIdentity,
    resultDigest: fields.resultDigest,
    verified: true,
  };
  result[REHYDRATED_BRAND] = true;
  return Object.freeze(result);
}

function finishRehydration(page, backing, evidenceId) {
  const namespace = JSON.parse(JSON.stringify(page.namespace));
  const provenance = JSON.parse(JSON.stringify(page.provenance));
  const resultDigest = deriveRehydrationDigestV2({
    pageId: page.id,
    contentHash: page.contentHash,
    sourceRoute: backing.sourceRoute,
    mediaType: backing.mediaType,
    namespace,
    sourceIdentity: backing.sourceIdentity,
  });
  return brandRehydrated({
    evidenceId: evidenceId === undefined || evidenceId === null ? null : String(evidenceId),
    pageId: page.id,
    kind: page.kind,
    contentHash: page.contentHash,
    namespace,
    provenance,
    sourceRoute: backing.sourceRoute,
    mediaType: backing.mediaType,
    exactText: backing.exactText,
    exactBytes: backing.exactBytes,
    sourceIdentity: backing.sourceIdentity,
    resultDigest,
  });
}

// ---- EvidenceRef direct resolution (frozen chain) ----
// EvidenceRef -> durable evidence binding -> ContextPage -> exact backing ->
// rehydrated exact bytes/text. Every edge must agree on evidenceId, pageId,
// contentHash, namespace, and source identity where applicable.
function rehydrateEvidenceRefV2(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    failRehydration('context-rehydration-unknown-field', 'rehydration input is required');
  }
  const unknown = unknownKeyOf(input, [
    'contextRoot', 'evidenceRef', 'taskInstanceId', 'evidenceId',
    'expectedNamespace', 'sessionSource', 'repositorySource', 'artifactSource',
  ]);
  if (unknown !== null) failRehydration('context-rehydration-unknown-field', unknown);
  const contextRoot = requireContextRoot(input.contextRoot);
  const expectedNamespace = requireExpectedNamespace(input.expectedNamespace);

  let taskInstanceId = input.taskInstanceId;
  let evidenceId = input.evidenceId;
  const hintedRef = input.evidenceRef === undefined || input.evidenceRef === null ? null : input.evidenceRef;
  if (hintedRef !== null) {
    if (typeof hintedRef !== 'object' || Array.isArray(hintedRef)) {
      failRehydration('context-rehydration-binding-mismatch', 'hinted EvidenceRef is not an object');
    }
    if (typeof hintedRef.evidenceId === 'string' && hintedRef.evidenceId !== '') evidenceId = hintedRef.evidenceId;
    if (typeof hintedRef.taskInstanceId === 'string' && hintedRef.taskInstanceId !== '') {
      taskInstanceId = hintedRef.taskInstanceId;
    }
  }
  if (typeof taskInstanceId !== 'string' || taskInstanceId === '') {
    failRehydration('context-rehydration-binding-mismatch', 'taskInstanceId identity is required');
  }
  if (typeof evidenceId !== 'string' || evidenceId === '') {
    failRehydration('context-rehydration-binding-mismatch', 'evidenceId identity is required');
  }
  // No query string, no candidate list, no relevance prompt: the caller
  // supplies the known identity and B03 resolves it directly.
  if (taskInstanceId !== expectedNamespace.taskInstanceId) {
    failRehydration('context-rehydration-namespace-mismatch', 'evidence taskInstanceId is outside the expected namespace');
  }

  let binding = null;
  try {
    binding = storeV2.readEvidenceV2(contextRoot, taskInstanceId, evidenceId, { expectedNamespace });
  } catch (error) {
    wrapSourceError(error);
  }
  if (hintedRef !== null) {
    const stored = binding.evidenceRef;
    if (stored.evidenceId !== evidenceId || stored.taskInstanceId !== taskInstanceId) {
      failRehydration('context-rehydration-binding-mismatch', 'hinted EvidenceRef diverges from the durable binding');
    }
    if (typeof hintedRef.kind === 'string' && hintedRef.kind !== stored.kind) {
      failRehydration('context-rehydration-binding-mismatch', 'hinted EvidenceRef kind diverges from the durable binding');
    }
    if (typeof hintedRef.locator === 'string' && hintedRef.locator !== stored.locator) {
      failRehydration('context-rehydration-binding-mismatch', 'hinted EvidenceRef locator diverges from the durable binding');
    }
    if (hintedRef.digest !== null && hintedRef.digest !== undefined && String(hintedRef.digest) !== page_contentHashOf(binding)) {
      failRehydration('context-rehydration-binding-mismatch', 'hinted EvidenceRef digest diverges from the bound identity');
    }
    // A caller hint never substitutes for backing: summaries are not evidence.
  }

  let page = null;
  try {
    page = storeV2.readContextPageV2(contextRoot, binding.pageId, { expectedNamespace });
  } catch (error) {
    wrapSourceError(error);
  }
  if (page.contentHash !== binding.contentHash) {
    failRehydration('context-rehydration-binding-mismatch', 'evidence binding diverges from its page');
  }
  const bindingNs = JSON.stringify(checkpointV2.canonicalize(binding.namespace));
  const pageNs = JSON.stringify(checkpointV2.canonicalize(page.namespace));
  if (bindingNs !== pageNs) {
    failRehydration('context-rehydration-binding-mismatch', 'evidence binding namespace diverges from its page');
  }

  let backing = null;
  try {
    backing = resolvePageBackingV2({
      page,
      contextRoot,
      sessionSource: input.sessionSource === undefined ? null : input.sessionSource,
      repositorySource: input.repositorySource === undefined ? null : input.repositorySource,
      artifactSource: input.artifactSource === undefined ? null : input.artifactSource,
    });
  } catch (error) {
    wrapSourceError(error);
  }
  return finishRehydration(page, backing, evidenceId);
}

function page_contentHashOf(binding) {
  return binding && typeof binding.contentHash === 'string' ? binding.contentHash : null;
}

// ---- Page-ID direct resolution (frozen) ----
// Known pageId without a fabricated EvidenceRef; explicit namespace still
// required. EvidenceRef-adjacent identity (evidenceId) stays null.
function rehydrateContextPageV2(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    failRehydration('context-rehydration-unknown-field', 'rehydration input is required');
  }
  const unknown = unknownKeyOf(input, [
    'contextRoot', 'pageId', 'expectedNamespace', 'sessionSource', 'repositorySource', 'artifactSource',
  ]);
  if (unknown !== null) failRehydration('context-rehydration-unknown-field', unknown);
  const contextRoot = requireContextRoot(input.contextRoot);
  const expectedNamespace = requireExpectedNamespace(input.expectedNamespace);
  if (typeof input.pageId !== 'string' || !PAGE_ID_PATTERN.test(input.pageId)) {
    failRehydration('context-rehydration-binding-mismatch', 'pageId identity is required');
  }
  let page = null;
  try {
    page = storeV2.readContextPageV2(contextRoot, input.pageId, { expectedNamespace });
  } catch (error) {
    wrapSourceError(error);
  }
  let backing = null;
  try {
    backing = resolvePageBackingV2({
      page,
      contextRoot,
      sessionSource: input.sessionSource === undefined ? null : input.sessionSource,
      repositorySource: input.repositorySource === undefined ? null : input.repositorySource,
      artifactSource: input.artifactSource === undefined ? null : input.artifactSource,
    });
  } catch (error) {
    wrapSourceError(error);
  }
  return finishRehydration(page, backing, null);
}

// ---- closed-world result validation (frozen) ----
function validateRehydratedEvidenceV2(result) {
  const fail = (reason) => ({ valid: false, reason });
  if (!result || typeof result !== 'object' || Array.isArray(result)) return fail('context-rehydration-unknown-field');
  if (result[REHYDRATED_BRAND] !== true) return fail('context-rehydration-unknown-field');
  if (unknownKeyOf(result, REHYDRATED_RESULT_EXACT_KEYS) !== null) return fail('context-rehydration-unknown-field');
  if (Number(result.schemaVersion) !== REHYDRATION_SCHEMA_VERSION) return fail('context-rehydration-unknown-field');
  if (result.evidenceId !== null && (typeof result.evidenceId !== 'string' || result.evidenceId === '')) {
    return fail('context-rehydration-binding-mismatch');
  }
  if (typeof result.pageId !== 'string' || !PAGE_ID_PATTERN.test(result.pageId)) {
    return fail('context-rehydration-binding-mismatch');
  }
  if (typeof result.kind !== 'string' || !pageV2.PAGE_KINDS.includes(result.kind)) {
    return fail('context-rehydration-content-mismatch');
  }
  if (typeof result.contentHash !== 'string' || !HEX64_PATTERN.test(result.contentHash)) {
    return fail('context-rehydration-content-mismatch');
  }
  if (!result.namespace || typeof result.namespace !== 'object' || Array.isArray(result.namespace)) {
    return fail('context-rehydration-namespace-mismatch');
  }
  if (unknownKeyOf(result.namespace, pageV2.PAGE_NAMESPACE_EXACT_KEYS) !== null) {
    return fail('context-rehydration-namespace-mismatch');
  }
  if (!result.provenance || typeof result.provenance !== 'object' || Array.isArray(result.provenance)) {
    return fail('context-rehydration-content-mismatch');
  }
  if (!SOURCE_ROUTES.includes(result.sourceRoute)) return fail('context-rehydration-source-mismatch');
  if (!MEDIA_TYPES.includes(result.mediaType)) return fail('context-rehydration-media-type-invalid');
  if (result.mediaType === 'text') {
    if (typeof result.exactText !== 'string' || result.exactText === '') return fail('context-rehydration-media-type-invalid');
    if (result.exactBytes !== null && result.exactBytes !== undefined) return fail('context-rehydration-media-type-invalid');
    if (sha256HexUtf8(result.exactText) !== result.contentHash) {
      return fail('context-rehydration-content-mismatch');
    }
  } else {
    if (!Buffer.isBuffer(result.exactBytes) || result.exactBytes.length === 0) {
      return fail('context-rehydration-media-type-invalid');
    }
    if (result.exactText !== null && result.exactText !== undefined) return fail('context-rehydration-media-type-invalid');
    if (sha256HexBytes(result.exactBytes) !== result.contentHash) return fail('context-rehydration-content-mismatch');
  }
  if (typeof result.sourceIdentity !== 'string' || result.sourceIdentity === '' || result.sourceIdentity.length > 600) {
    return fail('context-rehydration-source-mismatch');
  }
  if (result.verified !== true) return fail('context-rehydration-content-mismatch');
  if (typeof result.resultDigest !== 'string' || !HEX64_PATTERN.test(result.resultDigest)) {
    return fail('context-rehydration-content-mismatch');
  }
  const recomputed = deriveRehydrationDigestV2({
    pageId: result.pageId,
    contentHash: result.contentHash,
    sourceRoute: result.sourceRoute,
    mediaType: result.mediaType,
    namespace: JSON.parse(JSON.stringify(result.namespace)),
    sourceIdentity: result.sourceIdentity,
  });
  if (recomputed !== result.resultDigest) return fail('context-rehydration-content-mismatch');
  return { valid: true, reason: null };
}

// ---- bounded observational facts (no evidence content) ----
function describeRehydrationV2(result) {
  const check = validateRehydratedEvidenceV2(result);
  if (!check.valid) failRehydration(check.reason, 'cannot describe an unverified rehydration');
  const byteLength = result.mediaType === 'text'
    ? Buffer.byteLength(result.exactText, 'utf8') : result.exactBytes.length;
  return Object.freeze({
    pageId: result.pageId,
    evidenceId: result.evidenceId,
    kind: result.kind,
    sourceRoute: result.sourceRoute,
    mediaType: result.mediaType,
    byteLength,
    contentHashPrefix: String(result.contentHash).slice(0, 16),
    resultDigestPrefix: String(result.resultDigest).slice(0, 16),
    sourceIdentityPrefix: String(result.sourceIdentity).slice(0, 48),
    verified: true,
  });
}

module.exports = {
  REHYDRATION_SCHEMA_VERSION,
  REHYDRATION_DIGEST_DOMAIN_V1,
  SOURCE_ROUTES,
  MEDIA_TYPES,
  REHYDRATED_RESULT_EXACT_KEYS,
  EXACT_RESOLUTION_MODES,
  inspectExactResolutionV2,
  rehydrateEvidenceRefV2,
  rehydrateContextPageV2,
  resolvePageBackingV2,
  validateRehydratedEvidenceV2,
  describeRehydrationV2,
  deriveRehydrationDigestV2,
  deriveSessionEvidenceDigestV2: sessionSource.deriveSessionEvidenceDigestV2,
  canonicalSessionEvidenceTextV2: sessionSource.canonicalSessionEvidenceTextV2,
};
