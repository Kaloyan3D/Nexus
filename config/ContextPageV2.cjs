'use strict';
/**
 * ContextPageV2.cjs - CCV2-B01 ContextPage production authority.
 *
 * ONE authority for the V2 ContextPage contract: schema, creation,
 * closed-world validation, canonical serialization, deterministic page
 * identity, content-integrity binding, namespace binding, trust/provenance
 * reuse, structure-aware page-unit rules, and bounded advisory metadata.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (section 24, B01 freeze record). B01 answers "what exact historical
 * evidence unit may later phases persist, rehydrate, retrieve, and
 * materialize" and NOTHING else:
 *
 *   Checkpoint  = authoritative current task state (TaskController/A03).
 *   ContextPage = bounded exact/source-linked historical evidence unit (here).
 *   ContextView = future disposable model-facing working set (Phase C).
 *
 * A ContextPage is NOT task completion authority, verification authority,
 * checkpoint authority, permission authority, repository truth, retention
 * authority, a model-facing prompt by itself, a semantic-search result, or
 * summary-as-truth.
 *
 * Frozen formulas:
 *
 *   contentHash (exactText route) = sha256Hex(UTF-8(redacted exactText))
 *   contentHash (blob route)      = digest embedded in exactBlobRef
 *   contentHash (binding route)   = contentDigest embedded in sourceBinding
 *   contentHash (session route)   = caller-attested sha256 hex (B02 resolves)
 *   pageId = 'cxp_' + sha256Hex(UTF-8('nexus/context-page/v1' LF taskId LF
 *              taskInstanceId LF sessionId LF workspaceId LF repositoryId LF
 *              checkoutId LF generation LF kind LF mutability LF contentHash
 *              LF canonicalJson(sourceSeqs) LF canonicalJson(sourceBinding)
 *              LF provenanceKey)).slice(0, 32)
 *
 *   provenanceKey = sourceKind LF trust LF fieldKind LF
 *                   canonicalJson(sourceRefs) LF authorityScope
 *
 * Creation purity: identical canonical input -> byte-identical page
 * (same id, same contentHash, same canonical serialization). No clock
 * reads, no randomness, no process identity, no filesystem mtime.
 *
 *   NOT implemented here (B02+): blob persistence, page persistence,
 *   content-addressed store, EvidenceIndex, exact rehydration, lexical /
 *   symbol / file / embedding / semantic retrieval, ContextView, Context
 *   Compiler, budget packing, memory-tier policy, JEV/Laya/DECIDE.
 *   This module performs NO storage lookup and persists NOTHING.
 */

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const trustV2 = require('./ContextTrustV2.cjs');

const CONTEXT_PAGE_SCHEMA_VERSION = 1;
const CONTEXT_PAGE_ID_DOMAIN_V1 = 'nexus/context-page/v1';
const CONTEXT_PAGE_ID_PREFIX = 'cxp_';

// v0.3 page kinds, frozen as a closed world. Unknown kinds FAIL CLOSED:
// 'other' must be explicitly supplied, never silently defaulted.
const PAGE_KINDS = Object.freeze([
  'requirement',
  'repo-span',
  'diff',
  'tool-result',
  'verification',
  'decision',
  'failure',
  'conversation',
  'other',
]);

const PAGE_MUTABILITY = Object.freeze(['immutable', 'versioned']);

// Deterministic kind -> A04 fieldKind mapping (frozen). Trust is derived
// from (sourceKind, fieldKind) through the frozen A04 TrustNormalizer, so
// a page NEVER carries caller-chosen trust. Supported sourceKinds per
// kind are exactly the closed A04 rule entries for that fieldKind:
//   requirement-text : controller/authoritative, user/user-intent,
//                      agent/advisory, repository+tool/untrusted-data
//   repository-fact  : repository+tool/evidence, agent+review/advisory
//   tool-fact        : tool/evidence, agent/advisory
//   verification-outcome : verification/evidence, agent+review/advisory
//                          (user/controller narration is REJECTED by A04)
//   decision-statement   : controller/authoritative, agent+review/advisory
//   failure-detail       : controller/authoritative, agent+review/advisory
//   user-intent          : user+controller/user-intent
//                          (agent/repository/tool can NEVER yield it)
//   agent-text           : agent+review/advisory
const PAGE_KIND_FIELD_KIND = Object.freeze({
  requirement: 'requirement-text',
  'repo-span': 'repository-fact',
  diff: 'repository-fact',
  'tool-result': 'tool-fact',
  verification: 'verification-outcome',
  decision: 'decision-statement',
  failure: 'failure-detail',
  conversation: 'user-intent',
  other: 'agent-text',
});

// A tool page claims a balanced protocol transaction (call + result), so a
// single seq cannot back it. All other kinds have no minimum beyond the
// global exact-backing rule.
const TOOL_RESULT_MIN_SEQS = 2;

// Bounds (frozen). A03/A04 bounds are reused where they own the dimension;
// page-specific bounds are frozen here with rationale in section 24:
// exact evidence stays small and addressable; bulk belongs behind a B02
// blob reference, never inside an unbounded inline field.
const PAGE_BOUNDS = Object.freeze({
  taskId: 256,
  taskInstanceId: 256,
  sessionId: 256,
  workspaceId: 512,
  repositoryId: 256,
  checkoutId: 256,
  exactTextMaxChars: 8192,
  extractMaxChars: 1000,
  semanticGlossMaxChars: 1000,
  metadataEntriesMax: 32,
  metadataEntryMaxChars: 128,
  fileEntryMaxChars: 500,
  sourceSeqsMax: 512,
  pathMaxChars: 500,
  artifactIdMaxChars: 256,
  symbolMaxChars: 256,
  pageMaxBytes: 16384,
});

const PAGE_ID_PATTERN = /^cxp_[0-9a-f]{32}$/;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const EXACT_BLOB_REF_PATTERN = /^blob:sha256:[0-9a-f]{64}$/;

// Keys that must never appear in a page (bulk / secret / reasoning stores).
// Closed-world validation already rejects every unknown key; these names
// are documented explicitly because they name the forbidden dimension.
const FORBIDDEN_PAGE_KEYS = Object.freeze([
  'chainOfThought', 'chain-of-thought', 'hiddenReasoning', 'hidden-reasoning',
  'reasoning', 'thought', 'scratchpad', 'privateScratchpad',
]);

// ---- closed-world exact keys ----
const PAGE_TOP_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'id', 'kind', 'namespace', 'provenance', 'mutability',
  'sourceSeqs', 'sourceBinding', 'contentHash', 'exactText', 'exactBlobRef',
  'extract', 'semanticGloss', 'entities', 'symbols', 'files', 'tags',
  'createdAtGeneration', 'lastNeededAtGeneration', 'rehydratable',
]);
const PAGE_NAMESPACE_EXACT_KEYS = Object.freeze([
  'taskId', 'taskInstanceId', 'sessionId', 'workspaceId',
  'repositoryId', 'checkoutId',
]);
const PAGE_PROVENANCE_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'sourceKind', 'trust', 'sourceRefs',
  'authorityScope', 'fieldKind',
]);
const PAGE_SOURCE_BINDING_REPO_EXACT_KEYS = Object.freeze([
  'kind', 'path', 'contentDigest', 'startLine', 'endLine', 'symbol',
]);
const PAGE_SOURCE_BINDING_ARTIFACT_EXACT_KEYS = Object.freeze([
  'kind', 'artifactId', 'contentDigest',
]);
const PAGE_SOURCE_BINDING_KINDS = Object.freeze(['repository-span', 'artifact']);

function failPage(reason, detail) {
  throw new Error('v2-context-page: ' + reason + (detail ? ' (' + detail + ')' : '') + ' (BLOCK/KEEP)');
}

function unknownKeyOf(value, allowedKeys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) return key;
  }
  return null;
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

// Reuse the frozen A03 canonical serializer (sorted keys, recursive;
// arrays keep author order; no whitespace). Equivalent pages serialize
// byte-identically regardless of insertion order.
function canonicalizeContextPageV2(page) {
  return JSON.stringify(checkpointV2.canonicalize(page));
}

function serializePageCanonical(page) {
  return canonicalizeContextPageV2(page);
}

// ---- B01 path normalization (frozen) ----
// No existing Nexus authority owns page source paths, so B01 freezes the
// minimum rule explicitly: relative POSIX workspace paths only. Rejects
// absolute paths, host-global escapes, traversal, and empty segments, so
// a page namespace can never be resolved through uncontrolled locations.
function validatePagePath(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value.length > PAGE_BOUNDS.pathMaxChars) return false;
  if (value.startsWith('/')) return false;
  if (value.includes('\\')) return false;
  if (!/^[\x20-\x7E]+$/.test(value)) return false;
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

// Persistent page strings must already be in redacted persistable form:
// re-running the frozen A03 redaction must be a fixed point, and the
// value must fit its bound (exact evidence is never silently truncated).
function isRedactionStable(value, maxChars) {
  if (typeof value !== 'string') return false;
  if (value.length > maxChars) return false;
  return checkpointV2.redactCheckpointTextV2(value, maxChars) === value;
}

function isStringArray(value, maxEntries, maxChars) {
  if (!Array.isArray(value)) return false;
  if (value.length > maxEntries) return false;
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '' || entry.length > maxChars) return false;
    if (seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}

function canonicalStringSet(values) {
  return Array.from(new Set(values.map((entry) => String(entry)))).sort();
}

function validateSourceSeqs(seqs) {
  if (!Array.isArray(seqs)) return 'context-page-source-seqs-invalid';
  if (seqs.length > PAGE_BOUNDS.sourceSeqsMax) return 'context-page-source-seqs-invalid';
  let previous = -1;
  for (const seq of seqs) {
    if (!Number.isInteger(seq) || seq < 0) return 'context-page-source-seqs-invalid';
    if (seq <= previous) {
      return seq === previous
        ? 'context-page-source-seqs-duplicate'
        : 'context-page-source-seqs-unsorted';
    }
    previous = seq;
  }
  return null;
}

function validateSourceBinding(binding) {
  if (binding === null || binding === undefined) return null;
  if (typeof binding !== 'object' || Array.isArray(binding)) return 'context-page-source-binding-invalid';
  if (typeof binding.kind !== 'string' || !PAGE_SOURCE_BINDING_KINDS.includes(binding.kind)) {
    return 'context-page-source-binding-invalid';
  }
  if (binding.kind === 'repository-span') {
    if (unknownKeyOf(binding, PAGE_SOURCE_BINDING_REPO_EXACT_KEYS) !== null) {
      return 'context-page-source-binding-invalid';
    }
    if (!validatePagePath(binding.path)) return 'context-page-path-invalid';
    if (typeof binding.contentDigest !== 'string' || !CONTENT_HASH_PATTERN.test(binding.contentDigest)) {
      return 'context-page-source-binding-invalid';
    }
    if (!Number.isInteger(binding.startLine) || binding.startLine < 1) return 'context-page-source-binding-invalid';
    if (!Number.isInteger(binding.endLine) || binding.endLine < binding.startLine) return 'context-page-source-binding-invalid';
    if (binding.symbol !== null && binding.symbol !== undefined) {
      if (!isBoundedString(binding.symbol, PAGE_BOUNDS.symbolMaxChars, false)) return 'context-page-source-binding-invalid';
      if (!isRedactionStable(binding.symbol, PAGE_BOUNDS.symbolMaxChars)) return 'context-page-secret-unredacted';
    }
    return null;
  }
  if (unknownKeyOf(binding, PAGE_SOURCE_BINDING_ARTIFACT_EXACT_KEYS) !== null) {
    return 'context-page-source-binding-invalid';
  }
  if (!isBoundedString(binding.artifactId, PAGE_BOUNDS.artifactIdMaxChars, false)) {
    return 'context-page-source-binding-invalid';
  }
  if (!isRedactionStable(binding.artifactId, PAGE_BOUNDS.artifactIdMaxChars)) return 'context-page-secret-unredacted';
  if (typeof binding.contentDigest !== 'string' || !CONTENT_HASH_PATTERN.test(binding.contentDigest)) {
    return 'context-page-source-binding-invalid';
  }
  return null;
}

function validateNamespace(namespace) {
  if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) return 'context-page-namespace-invalid';
  if (unknownKeyOf(namespace, PAGE_NAMESPACE_EXACT_KEYS) !== null) return 'context-page-namespace-invalid';
  if (!isBoundedString(namespace.taskId, PAGE_BOUNDS.taskId, false)) return 'context-page-namespace-invalid';
  if (!isBoundedString(namespace.taskInstanceId, PAGE_BOUNDS.taskInstanceId, false)) return 'context-page-namespace-invalid';
  if (!isBoundedString(namespace.sessionId, PAGE_BOUNDS.sessionId, false)) return 'context-page-namespace-invalid';
  if (!isBoundedString(namespace.workspaceId, PAGE_BOUNDS.workspaceId, false)) return 'context-page-namespace-invalid';
  if (namespace.repositoryId !== null && namespace.repositoryId !== undefined &&
      !isBoundedString(namespace.repositoryId, PAGE_BOUNDS.repositoryId, true)) {
    return 'context-page-namespace-invalid';
  }
  if (namespace.checkoutId !== null && namespace.checkoutId !== undefined &&
      !isBoundedString(namespace.checkoutId, PAGE_BOUNDS.checkoutId, true)) {
    return 'context-page-namespace-invalid';
  }
  return null;
}

function namespacesEqual(a, b) {
  if (!a || !b) return false;
  const norm = (ns) => ({
    taskId: ns.taskId,
    taskInstanceId: ns.taskInstanceId,
    sessionId: ns.sessionId,
    workspaceId: ns.workspaceId,
    repositoryId: ns.repositoryId === undefined ? null : ns.repositoryId,
    checkoutId: ns.checkoutId === undefined ? null : ns.checkoutId,
  });
  const left = norm(a);
  const right = norm(b);
  return left.taskId === right.taskId
    && left.taskInstanceId === right.taskInstanceId
    && left.sessionId === right.sessionId
    && left.workspaceId === right.workspaceId
    && left.repositoryId === right.repositoryId
    && left.checkoutId === right.checkoutId;
}

// ---- content identity ----
// contentHash ALWAYS binds the exact backing. Derivation per route:
//   exactText present  -> sha256 of the redacted persistable exact bytes
//   blobRef only       -> digest embedded in the blob reference
//   binding only       -> contentDigest embedded in the source binding
//   session seqs only  -> caller-attested sha256 (B02/B03 resolves bytes)
function deriveContextPageDigestV2(text) {
  return sha256HexUtf8(String(text));
}

function digestOfBlobRef(blobRef) {
  return String(blobRef).slice('blob:sha256:'.length);
}

function resolveContentHash(input) {
  if (input.exactText !== null && input.exactText !== undefined) {
    return deriveContextPageDigestV2(input.exactText);
  }
  if (input.exactBlobRef !== null && input.exactBlobRef !== undefined) {
    return digestOfBlobRef(input.exactBlobRef);
  }
  if (input.sourceBinding !== null && input.sourceBinding !== undefined) {
    return String(input.sourceBinding.contentDigest);
  }
  return String(input.contentHash);
}

// Byte-strong routes carry content identity verifiable NOW (bytes present
// or a digest-bearing descriptor). A pure session-seq page is valid
// source-linked evidence, but its attested hash cannot be revalidated at
// B01, so it is NOT byte-strong: rehydratable must be false until B02/B03
// binds session resolution.
function hasByteStrongRoute(page) {
  return (page.exactText !== null && page.exactText !== undefined)
    || (page.exactBlobRef !== null && page.exactBlobRef !== undefined)
    || (page.sourceBinding !== null && page.sourceBinding !== undefined);
}

// ---- page identity ----
// Domain-separated, deterministic, timestamp-free. Binds the task-bound
// semantic page identity: namespace, generation, kind, mutability,
// exact-backing identity, source location, and provenance. Advisory
// metadata (extract, semanticGloss, entities, symbols, files, tags,
// lastNeededAtGeneration) and the derived rehydratable flag NEVER enter
// the identity: an LLM-generated gloss must not change the identity of
// exact evidence.
function deriveContextPageIdV2(parts) {
  for (const key of ['taskId', 'taskInstanceId', 'sessionId', 'workspaceId', 'kind', 'mutability', 'contentHash']) {
    if (typeof parts[key] !== 'string' || parts[key] === '') {
      failPage('context-page-id-invalid', key + ' is required');
    }
  }
  if (!Number.isInteger(parts.createdAtGeneration) || parts.createdAtGeneration < 1) {
    failPage('context-page-generation-invalid', 'createdAtGeneration must be an integer >= 1');
  }
  const repositoryId = parts.repositoryId === null || parts.repositoryId === undefined ? '' : String(parts.repositoryId);
  const checkoutId = parts.checkoutId === null || parts.checkoutId === undefined ? '' : String(parts.checkoutId);
  const joined = [
    CONTEXT_PAGE_ID_DOMAIN_V1,
    parts.taskId,
    parts.taskInstanceId,
    parts.sessionId,
    parts.workspaceId,
    repositoryId,
    checkoutId,
    String(parts.createdAtGeneration),
    parts.kind,
    parts.mutability,
    parts.contentHash,
    JSON.stringify(checkpointV2.canonicalize(parts.sourceSeqs || [])),
    JSON.stringify(checkpointV2.canonicalize(parts.sourceBinding === undefined ? null : parts.sourceBinding)),
    String(parts.provenanceKey || ''),
  ].join('\n');
  return CONTEXT_PAGE_ID_PREFIX + sha256HexUtf8(joined).slice(0, 32);
}

function provenanceKeyOf(provenance) {
  return [
    provenance.sourceKind,
    provenance.trust,
    provenance.fieldKind,
    JSON.stringify(checkpointV2.canonicalize(provenance.sourceRefs)),
    provenance.authorityScope === null || provenance.authorityScope === undefined
      ? '' : String(provenance.authorityScope),
  ].join('\n');
}

// ---- creation ----
function normalizeNamespaceInput(namespace) {
  if (!namespace || typeof namespace !== 'object') failPage('context-page-namespace-invalid', 'namespace is required');
  return {
    taskId: namespace.taskId,
    taskInstanceId: namespace.taskInstanceId,
    sessionId: namespace.sessionId,
    workspaceId: namespace.workspaceId,
    repositoryId: namespace.repositoryId === undefined ? null : namespace.repositoryId,
    checkoutId: namespace.checkoutId === undefined ? null : namespace.checkoutId,
  };
}

function createContextPageV2(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) failPage('context-page-invalid', 'input is required');
  const unknownTop = unknownKeyOf(input, [
    'kind', 'namespace', 'sourceKind', 'sourceRefs', 'authorityScope',
    'mutability', 'sourceSeqs', 'sourceBinding', 'contentHash',
    'exactText', 'exactBlobRef', 'extract', 'semanticGloss',
    'entities', 'symbols', 'files', 'tags',
    'createdAtGeneration', 'lastNeededAtGeneration', 'rehydratable',
  ]);
  if (unknownTop !== null) failPage('context-page-unknown-field', unknownTop);
  for (const forbidden of FORBIDDEN_PAGE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, forbidden)) failPage('context-page-unknown-field', forbidden);
  }

  if (typeof input.kind !== 'string' || !PAGE_KINDS.includes(input.kind)) failPage('context-page-kind-invalid', String(input.kind));
  const fieldKind = PAGE_KIND_FIELD_KIND[input.kind];

  const namespace = normalizeNamespaceInput(input.namespace);
  const namespaceReason = validateNamespace(namespace);
  if (namespaceReason !== null) failPage(namespaceReason);

  if (typeof input.mutability !== 'string' || !PAGE_MUTABILITY.includes(input.mutability)) {
    failPage('context-page-mutability-invalid', String(input.mutability));
  }

  const sourceSeqs = input.sourceSeqs === undefined ? [] : input.sourceSeqs;
  const seqReason = validateSourceSeqs(sourceSeqs);
  if (seqReason !== null) failPage(seqReason);
  if (input.kind === 'tool-result' && sourceSeqs.length < TOOL_RESULT_MIN_SEQS) {
    failPage('context-page-tool-transaction-unbalanced', 'tool-result pages require call + result seqs');
  }

  const sourceBinding = input.sourceBinding === undefined ? null : input.sourceBinding;
  const bindingReason = validateSourceBinding(sourceBinding);
  if (bindingReason !== null) failPage(bindingReason);

  // Provenance/trust: caller names the source; A04 derives the trust.
  // Callers MUST NOT supply trust: it is derived, never chosen.
  if (input.trust !== undefined) failPage('context-page-provenance-authority-invalid', 'callers must not supply trust');
  if (typeof input.sourceKind !== 'string' || !trustV2.SOURCE_KINDS.includes(input.sourceKind)) {
    failPage('context-page-provenance-invalid', 'unknown source kind ' + String(input.sourceKind));
  }
  let provenance;
  try {
    const normalized = trustV2.normalizeField({
      fieldPath: 'context-page/' + input.kind,
      fieldKind,
      value: typeof input.exactText === 'string' ? input.exactText : '',
      sourceKind: input.sourceKind,
      sourceRefs: input.sourceRefs,
      authorityScope: input.authorityScope,
    });
    provenance = {
      schemaVersion: 1,
      sourceKind: normalized.provenance.sourceKind,
      trust: normalized.provenance.trust,
      sourceRefs: normalized.provenance.sourceRefs.slice(),
      authorityScope: normalized.provenance.authorityScope === undefined ? null : normalized.provenance.authorityScope,
      fieldKind,
    };
  } catch (error) {
    failPage('context-page-provenance-authority-invalid', String(error && error.message).slice(0, 160));
  }

  // Exact backing inputs: redaction BEFORE identity (frozen order).
  let exactText = input.exactText === undefined ? null : input.exactText;
  if (exactText !== null) {
    if (typeof exactText !== 'string' || exactText === '') failPage('context-page-exact-invalid', 'exactText must be a nonempty string');
    exactText = checkpointV2.redactCheckpointTextV2(exactText, PAGE_BOUNDS.exactTextMaxChars);
    // Never silently truncate mandatory exact evidence: oversized exact
    // evidence belongs behind a B02 blob reference.
    if (byteLengthUtf8(exactText) > PAGE_BOUNDS.exactTextMaxChars || exactText.endsWith('...<truncated>')) {
      failPage('context-page-exact-too-large', 'exact evidence exceeds the inline bound; use exactBlobRef');
    }
  }
  let exactBlobRef = input.exactBlobRef === undefined ? null : input.exactBlobRef;
  if (exactBlobRef !== null) {
    if (typeof exactBlobRef !== 'string' || !EXACT_BLOB_REF_PATTERN.test(exactBlobRef)) {
      failPage('context-page-blob-ref-invalid', String(exactBlobRef).slice(0, 80));
    }
  }

  const hasExactText = exactText !== null;
  const hasBlobRef = exactBlobRef !== null;
  const hasBinding = sourceBinding !== null;
  const hasSeqs = sourceSeqs.length > 0;
  // Every page needs ONE provable exact backing route. Advisory metadata
  // alone (gloss/tags/entities/summary/extract) is never sufficient.
  if (!hasExactText && !hasBlobRef && !hasBinding && !hasSeqs) {
    failPage('context-page-content-missing', 'no exact or strongly source-linked backing');
  }
  // Non-session evidence (empty sourceSeqs) is allowed ONLY with an
  // alternate exact source binding present.
  if (!hasSeqs && !hasExactText && !hasBlobRef && !hasBinding) {
    failPage('context-page-content-missing', 'empty sourceSeqs require an alternate exact binding');
  }

  let contentHash;
  if (hasExactText) {
    contentHash = deriveContextPageDigestV2(exactText);
    if (hasBlobRef && digestOfBlobRef(exactBlobRef) !== contentHash) {
      failPage('context-page-content-mismatch', 'exactBlobRef digest must match exactText bytes');
    }
    if (hasBinding && String(sourceBinding.contentDigest) !== contentHash) {
      failPage('context-page-content-mismatch', 'sourceBinding digest must match exactText bytes');
    }
  } else if (hasBlobRef) {
    contentHash = digestOfBlobRef(exactBlobRef);
    if (hasBinding && String(sourceBinding.contentDigest) !== contentHash) {
      failPage('context-page-content-mismatch', 'sourceBinding digest must match exactBlobRef digest');
    }
  } else if (hasBinding) {
    contentHash = String(sourceBinding.contentDigest);
  } else {
    if (typeof input.contentHash !== 'string' || !CONTENT_HASH_PATTERN.test(input.contentHash)) {
      failPage('context-page-content-hash-invalid', 'session-only pages require an attested sha256 contentHash');
    }
    contentHash = String(input.contentHash);
  }
  if ((hasExactText || hasBlobRef || hasBinding)
      && input.contentHash !== undefined && input.contentHash !== null
      && String(input.contentHash) !== contentHash) {
    failPage('context-page-content-mismatch', 'supplied contentHash does not match the exact backing');
  }

  // Extract: source-exact bounded span, provable only against present
  // exact bytes. semanticGloss: optional derived advisory prose.
  let extract = input.extract === undefined ? null : input.extract;
  if (extract !== null) {
    if (typeof extract !== 'string' || extract === '') failPage('context-page-extract-invalid', 'extract must be a nonempty string');
    if (exactText === null) failPage('context-page-extract-invalid', 'extract requires present exactText');
    if (!exactText.includes(extract)) failPage('context-page-extract-invalid', 'extract must be a source-exact substring');
    extract = checkpointV2.redactCheckpointTextV2(extract, PAGE_BOUNDS.extractMaxChars);
    if (extract.length > PAGE_BOUNDS.extractMaxChars || extract.endsWith('...<truncated>')) {
      failPage('context-page-extract-invalid', 'extract exceeds the bound');
    }
    if (!exactText.includes(extract)) failPage('context-page-extract-invalid', 'redacted extract must remain source-exact');
  }
  let semanticGloss = input.semanticGloss === undefined ? null : input.semanticGloss;
  if (semanticGloss !== null) {
    if (typeof semanticGloss !== 'string' || semanticGloss === '') failPage('context-page-gloss-invalid', 'semanticGloss must be a nonempty string');
    semanticGloss = checkpointV2.redactCheckpointTextV2(semanticGloss, PAGE_BOUNDS.semanticGlossMaxChars);
    if (semanticGloss.length > PAGE_BOUNDS.semanticGlossMaxChars || semanticGloss.endsWith('...<truncated>')) {
      failPage('context-page-gloss-invalid', 'semanticGloss exceeds the bound');
    }
  }
  // semanticGloss is advisory: it MUST NOT become the sole backing.
  if (semanticGloss !== null && !hasExactText && !hasBlobRef && !hasBinding && !hasSeqs) {
    failPage('context-page-content-missing', 'semanticGloss cannot replace exact backing');
  }

  // Advisory/search metadata: canonical sort + deduplicate (frozen).
  // Order is not semantically meaningful here, unlike sourceSeqs.
  const entities = input.entities === undefined ? [] : input.entities;
  const symbols = input.symbols === undefined ? [] : input.symbols;
  const files = input.files === undefined ? [] : input.files;
  const tags = input.tags === undefined ? [] : input.tags;
  if (!isStringArray(entities, PAGE_BOUNDS.metadataEntriesMax, PAGE_BOUNDS.metadataEntryMaxChars)) {
    failPage('context-page-metadata-invalid', 'entities');
  }
  if (!isStringArray(symbols, PAGE_BOUNDS.metadataEntriesMax, PAGE_BOUNDS.metadataEntryMaxChars)) {
    failPage('context-page-metadata-invalid', 'symbols');
  }
  if (!isStringArray(tags, PAGE_BOUNDS.metadataEntriesMax, PAGE_BOUNDS.metadataEntryMaxChars)) {
    failPage('context-page-metadata-invalid', 'tags');
  }
  if (!isStringArray(files, PAGE_BOUNDS.metadataEntriesMax, PAGE_BOUNDS.fileEntryMaxChars)) {
    failPage('context-page-metadata-invalid', 'files');
  }
  for (const file of files) {
    if (!validatePagePath(file)) failPage('context-page-path-invalid', file.slice(0, 120));
  }
  for (const entry of entities.concat(symbols, tags)) {
    if (!isRedactionStable(entry, PAGE_BOUNDS.metadataEntryMaxChars)) failPage('context-page-secret-unredacted', 'metadata');
  }
  for (const file of files) {
    if (!isRedactionStable(file, PAGE_BOUNDS.fileEntryMaxChars)) failPage('context-page-secret-unredacted', 'files');
  }

  if (!Number.isInteger(input.createdAtGeneration) || input.createdAtGeneration < 1) {
    failPage('context-page-generation-invalid', 'createdAtGeneration must be an integer >= 1');
  }
  let lastNeededAtGeneration = input.lastNeededAtGeneration === undefined ? null : input.lastNeededAtGeneration;
  if (lastNeededAtGeneration !== null) {
    if (!Number.isInteger(lastNeededAtGeneration) || lastNeededAtGeneration < input.createdAtGeneration) {
      failPage('context-page-generation-invalid', 'lastNeededAtGeneration must be an integer >= createdAtGeneration');
    }
  }
  // lastNeededAtGeneration is metadata only: it never decides truth.

  const byteStrong = hasExactText || hasBlobRef || hasBinding;
  const derivedRehydratable = byteStrong;
  let rehydratable;
  if (input.rehydratable === undefined || input.rehydratable === null) {
    rehydratable = derivedRehydratable;
  } else {
    if (typeof input.rehydratable !== 'boolean') failPage('context-page-rehydratable-invalid', 'rehydratable must be boolean');
    if (input.rehydratable !== derivedRehydratable) {
      failPage('context-page-rehydratable-invalid', 'rehydratable must match the exact-route derivation');
    }
    rehydratable = input.rehydratable;
  }

  const provenanceKey = provenanceKeyOf(provenance);
  const id = deriveContextPageIdV2({
    taskId: namespace.taskId,
    taskInstanceId: namespace.taskInstanceId,
    sessionId: namespace.sessionId,
    workspaceId: namespace.workspaceId,
    repositoryId: namespace.repositoryId,
    checkoutId: namespace.checkoutId,
    createdAtGeneration: input.createdAtGeneration,
    kind: input.kind,
    mutability: input.mutability,
    contentHash,
    sourceSeqs: sourceSeqs.slice(),
    sourceBinding,
    provenanceKey,
  });

  const page = {
    schemaVersion: CONTEXT_PAGE_SCHEMA_VERSION,
    id,
    kind: input.kind,
    namespace: Object.freeze({
      taskId: namespace.taskId,
      taskInstanceId: namespace.taskInstanceId,
      sessionId: namespace.sessionId,
      workspaceId: namespace.workspaceId,
      repositoryId: namespace.repositoryId,
      checkoutId: namespace.checkoutId,
    }),
    provenance: Object.freeze({
      schemaVersion: provenance.schemaVersion,
      sourceKind: provenance.sourceKind,
      trust: provenance.trust,
      sourceRefs: Object.freeze(provenance.sourceRefs.slice()),
      authorityScope: provenance.authorityScope,
      fieldKind: provenance.fieldKind,
    }),
    mutability: input.mutability,
    sourceSeqs: Object.freeze(sourceSeqs.slice()),
    sourceBinding: sourceBinding === null ? null : Object.freeze(JSON.parse(JSON.stringify(sourceBinding))),
    contentHash,
    exactText,
    exactBlobRef,
    extract,
    semanticGloss,
    entities: Object.freeze(canonicalStringSet(entities)),
    symbols: Object.freeze(canonicalStringSet(symbols)),
    files: Object.freeze(canonicalStringSet(files)),
    tags: Object.freeze(canonicalStringSet(tags)),
    createdAtGeneration: input.createdAtGeneration,
    lastNeededAtGeneration,
    rehydratable,
  };

  const serialized = serializePageCanonical(page);
  if (byteLengthUtf8(serialized) > PAGE_BOUNDS.pageMaxBytes) {
    failPage('context-page-size-exceeded', 'canonical page exceeds ' + PAGE_BOUNDS.pageMaxBytes + ' bytes');
  }
  return Object.freeze(page);
}

// ---- validation ----
function validateContextPageV2(page, options) {
  const fail = (reason) => ({ valid: false, reason });
  if (!page || typeof page !== 'object' || Array.isArray(page)) return fail('context-page-invalid');
  if (Number(page.schemaVersion) !== CONTEXT_PAGE_SCHEMA_VERSION) return fail('context-page-schema-version');
  const unknownTop = unknownKeyOf(page, PAGE_TOP_EXACT_KEYS);
  if (unknownTop !== null) return fail('context-page-unknown-field');
  for (const forbidden of FORBIDDEN_PAGE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(page, forbidden)) return fail('context-page-unknown-field');
  }
  if (typeof page.id !== 'string' || !PAGE_ID_PATTERN.test(page.id)) return fail('context-page-id-invalid');
  if (typeof page.kind !== 'string' || !PAGE_KINDS.includes(page.kind)) return fail('context-page-kind-invalid');
  if (typeof page.mutability !== 'string' || !PAGE_MUTABILITY.includes(page.mutability)) return fail('context-page-mutability-invalid');

  const namespaceReason = validateNamespace(page.namespace);
  if (namespaceReason !== null) return fail(namespaceReason);
  if (options !== undefined && options !== null) {
    if (options.expectedNamespace !== undefined && options.expectedNamespace !== null) {
      const expectedReason = validateNamespace(options.expectedNamespace);
      if (expectedReason !== null) return fail(expectedReason);
      if (!namespacesEqual(page.namespace, options.expectedNamespace)) return fail('context-page-namespace-mismatch');
    }
    const unknownOption = unknownKeyOf(options, ['expectedNamespace']);
    if (unknownOption !== null) return fail('context-page-unknown-field');
  }

  // Provenance: structural shape via A04, derivation via the closed
  // (sourceKind, fieldKind) rule, and kind/fieldKind binding via B01.
  const provenance = page.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return fail('context-page-provenance-invalid');
  if (unknownKeyOf(provenance, PAGE_PROVENANCE_EXACT_KEYS) !== null) return fail('context-page-provenance-invalid');
  if (Number(provenance.schemaVersion) !== trustV2.TRUST_PROVENANCE_SCHEMA_VERSION) return fail('context-page-provenance-invalid');
  const structural = trustV2.validateTrustProvenance({
    schemaVersion: provenance.schemaVersion,
    sourceKind: provenance.sourceKind,
    trust: provenance.trust,
    sourceRefs: provenance.sourceRefs,
    authorityScope: provenance.authorityScope,
  });
  if (!structural.valid) return fail('context-page-provenance-invalid');
  if (provenance.fieldKind !== PAGE_KIND_FIELD_KIND[page.kind]) return fail('context-page-provenance-authority-invalid');
  const authority = trustV2.validateProvenanceAuthority(provenance, provenance.fieldKind);
  if (!authority.valid) return fail('context-page-provenance-authority-invalid');

  const seqReason = validateSourceSeqs(page.sourceSeqs);
  if (seqReason !== null) return fail(seqReason);
  if (page.kind === 'tool-result' && page.sourceSeqs.length < TOOL_RESULT_MIN_SEQS) {
    return fail('context-page-tool-transaction-unbalanced');
  }
  const bindingReason = validateSourceBinding(page.sourceBinding);
  if (bindingReason !== null) return fail(bindingReason);

  if (typeof page.contentHash !== 'string' || !CONTENT_HASH_PATTERN.test(page.contentHash)) {
    return fail('context-page-content-hash-invalid');
  }
  const hasExactText = page.exactText !== null && page.exactText !== undefined;
  const hasBlobRef = page.exactBlobRef !== null && page.exactBlobRef !== undefined;
  const hasBinding = page.sourceBinding !== null && page.sourceBinding !== undefined;
  const hasSeqs = Array.isArray(page.sourceSeqs) && page.sourceSeqs.length > 0;
  if (!hasExactText && !hasBlobRef && !hasBinding && !hasSeqs) return fail('context-page-content-missing');

  if (hasExactText) {
    if (typeof page.exactText !== 'string' || page.exactText === '') return fail('context-page-exact-invalid');
    if (!isRedactionStable(page.exactText, PAGE_BOUNDS.exactTextMaxChars)) return fail('context-page-secret-unredacted');
    // Recompute whenever exact bytes are available; mismatch REJECTS.
    if (deriveContextPageDigestV2(page.exactText) !== page.contentHash) return fail('context-page-content-mismatch');
    if (hasBlobRef && digestOfBlobRef(page.exactBlobRef) !== page.contentHash) return fail('context-page-content-mismatch');
    if (hasBinding && String(page.sourceBinding.contentDigest) !== page.contentHash) return fail('context-page-content-mismatch');
  }
  if (hasBlobRef) {
    if (typeof page.exactBlobRef !== 'string' || !EXACT_BLOB_REF_PATTERN.test(page.exactBlobRef)) {
      return fail('context-page-blob-ref-invalid');
    }
    // B01 defines the reference contract only: NO storage lookup here.
    if (!hasExactText && digestOfBlobRef(page.exactBlobRef) !== page.contentHash) return fail('context-page-content-mismatch');
    if (!hasExactText && hasBinding && String(page.sourceBinding.contentDigest) !== page.contentHash) {
      return fail('context-page-content-mismatch');
    }
  }
  if (hasBinding && !hasExactText && !hasBlobRef && String(page.sourceBinding.contentDigest) !== page.contentHash) {
    return fail('context-page-content-mismatch');
  }
  if (!hasExactText && !hasBlobRef && !hasBinding && !CONTENT_HASH_PATTERN.test(page.contentHash || '')) {
    return fail('context-page-content-hash-invalid');
  }

  if (page.extract !== null && page.extract !== undefined) {
    if (typeof page.extract !== 'string' || page.extract === '') return fail('context-page-extract-invalid');
    if (page.extract.length > PAGE_BOUNDS.extractMaxChars) return fail('context-page-extract-invalid');
    if (!hasExactText || !page.exactText.includes(page.extract)) return fail('context-page-extract-invalid');
    if (!isRedactionStable(page.extract, PAGE_BOUNDS.extractMaxChars)) return fail('context-page-secret-unredacted');
  }
  if (page.semanticGloss !== null && page.semanticGloss !== undefined) {
    if (typeof page.semanticGloss !== 'string' || page.semanticGloss === '') return fail('context-page-gloss-invalid');
    if (page.semanticGloss.length > PAGE_BOUNDS.semanticGlossMaxChars) return fail('context-page-gloss-invalid');
    if (!isRedactionStable(page.semanticGloss, PAGE_BOUNDS.semanticGlossMaxChars)) return fail('context-page-secret-unredacted');
  }
  // semanticGloss can never be the sole backing (already enforced by the
  // content-missing leg above, re-asserted here for clarity of intent).

  if (!isStringArray(page.entities, PAGE_BOUNDS.metadataEntriesMax, PAGE_BOUNDS.metadataEntryMaxChars)) {
    return fail('context-page-metadata-invalid');
  }
  if (!isStringArray(page.symbols, PAGE_BOUNDS.metadataEntriesMax, PAGE_BOUNDS.metadataEntryMaxChars)) {
    return fail('context-page-metadata-invalid');
  }
  if (!isStringArray(page.tags, PAGE_BOUNDS.metadataEntriesMax, PAGE_BOUNDS.metadataEntryMaxChars)) {
    return fail('context-page-metadata-invalid');
  }
  if (!isStringArray(page.files, PAGE_BOUNDS.metadataEntriesMax, PAGE_BOUNDS.fileEntryMaxChars)) {
    return fail('context-page-metadata-invalid');
  }
  for (const file of page.files) {
    if (!validatePagePath(file)) return fail('context-page-path-invalid');
  }
  // Canonical metadata order: set-like fields are always sorted.
  for (const list of [page.entities, page.symbols, page.files, page.tags]) {
    const sorted = list.slice().sort();
    for (let index = 0; index < list.length; index += 1) {
      if (list[index] !== sorted[index]) return fail('context-page-metadata-invalid');
    }
  }
  for (const entry of page.entities.concat(page.symbols, page.tags)) {
    if (!isRedactionStable(entry, PAGE_BOUNDS.metadataEntryMaxChars)) return fail('context-page-secret-unredacted');
  }
  for (const file of page.files) {
    if (!isRedactionStable(file, PAGE_BOUNDS.fileEntryMaxChars)) return fail('context-page-secret-unredacted');
  }

  if (!Number.isInteger(page.createdAtGeneration) || page.createdAtGeneration < 1) {
    return fail('context-page-generation-invalid');
  }
  if (page.lastNeededAtGeneration !== null && page.lastNeededAtGeneration !== undefined) {
    if (!Number.isInteger(page.lastNeededAtGeneration) || page.lastNeededAtGeneration < page.createdAtGeneration) {
      return fail('context-page-generation-invalid');
    }
  }

  // Rehydratable means a deterministic exact retrieval route is present
  // in the contract. It is derived, and the stored flag must agree.
  const byteStrong = hasByteStrongRoute(page);
  if (typeof page.rehydratable !== 'boolean') return fail('context-page-rehydratable-invalid');
  if (page.rehydratable !== byteStrong) return fail('context-page-rehydratable-invalid');

  if (byteLengthUtf8(serializePageCanonical(page)) > PAGE_BOUNDS.pageMaxBytes) {
    return fail('context-page-size-exceeded');
  }

  // Page identity is recomputed over the semantic identity; a stale id
  // after ANY semantic change REJECTS.
  let expectedId;
  try {
    expectedId = deriveContextPageIdV2({
      taskId: page.namespace.taskId,
      taskInstanceId: page.namespace.taskInstanceId,
      sessionId: page.namespace.sessionId,
      workspaceId: page.namespace.workspaceId,
      repositoryId: page.namespace.repositoryId,
      checkoutId: page.namespace.checkoutId,
      createdAtGeneration: page.createdAtGeneration,
      kind: page.kind,
      mutability: page.mutability,
      contentHash: page.contentHash,
      sourceSeqs: page.sourceSeqs.slice(),
      sourceBinding: page.sourceBinding,
      provenanceKey: provenanceKeyOf(page.provenance),
    });
  } catch (error) {
    return fail('context-page-id-invalid');
  }
  if (page.id !== expectedId) return fail('context-page-id-mismatch');

  return { valid: true, reason: null };
}

// ---- EvidenceRef compatibility (pure, read-only) ----
// Future EvidenceRef -> ContextPage/exact-blob backing WITHOUT redefining
// EvidenceRef semantics (A03/A04/A07 are never modified here). The adapter
// derives ONLY the source fragment a page can be built from; the caller
// still supplies namespace, kind, provenance inputs, and generation, and
// createContextPageV2 enforces every B01 rule on the result.
function derivePageSourceFromEvidenceRef(evidenceRef, taskInstanceId) {
  if (!evidenceRef || typeof evidenceRef !== 'object' || Array.isArray(evidenceRef)) {
    failPage('context-page-evidence-ref-incompatible', 'evidenceRef is required');
  }
  if (typeof taskInstanceId !== 'string' || taskInstanceId === '') {
    failPage('context-page-evidence-ref-incompatible', 'taskInstanceId is required');
  }
  if (typeof evidenceRef.taskInstanceId !== 'string' || evidenceRef.taskInstanceId !== taskInstanceId) {
    failPage('context-page-evidence-ref-incompatible', 'evidence taskInstanceId mismatch');
  }
  if (typeof evidenceRef.locator !== 'string' || evidenceRef.locator === '') {
    failPage('context-page-evidence-ref-incompatible', 'locator is required');
  }
  if (evidenceRef.kind === 'event' && /^[0-9]+$/.test(evidenceRef.locator)) {
    return { sourceSeqs: [Number(evidenceRef.locator)], sourceBinding: null };
  }
  if (typeof evidenceRef.digest !== 'string' || !CONTENT_HASH_PATTERN.test(evidenceRef.digest)) {
    failPage('context-page-evidence-ref-incompatible', 'a strong content digest is required');
  }
  return {
    sourceSeqs: [],
    sourceBinding: {
      kind: 'artifact',
      artifactId: typeof evidenceRef.evidenceId === 'string' && evidenceRef.evidenceId !== ''
        ? evidenceRef.evidenceId : evidenceRef.locator,
      contentDigest: evidenceRef.digest,
    },
  };
}

// ---- bounded observational facts (no raw evidence content) ----
function describeContextPageV2(page) {
  const check = validateContextPageV2(page);
  if (!check.valid) failPage(check.reason, 'cannot describe an invalid page');
  const backingMethod = page.exactText !== null && page.exactText !== undefined
    ? 'exact-text'
    : page.exactBlobRef !== null && page.exactBlobRef !== undefined
      ? 'exact-blob-ref'
      : page.sourceBinding !== null && page.sourceBinding !== undefined
        ? 'source-binding:' + page.sourceBinding.kind
        : 'session-events';
  return Object.freeze({
    pageId: page.id,
    kind: page.kind,
    trust: page.provenance.trust,
    sourceKind: page.provenance.sourceKind,
    backingMethod,
    sourceSeqCount: page.sourceSeqs.length,
    contentBytes: page.exactText !== null && page.exactText !== undefined ? byteLengthUtf8(page.exactText) : 0,
    metadataBytes: byteLengthUtf8(serializePageCanonical({
      extract: page.extract, semanticGloss: page.semanticGloss,
      entities: page.entities, symbols: page.symbols,
      files: page.files, tags: page.tags,
    })),
    rehydratable: page.rehydratable,
    namespaceBound: true,
  });
}

module.exports = {
  CONTEXT_PAGE_SCHEMA_VERSION,
  CONTEXT_PAGE_ID_DOMAIN_V1,
  PAGE_KINDS,
  PAGE_MUTABILITY,
  PAGE_KIND_FIELD_KIND,
  PAGE_BOUNDS,
  PAGE_TOP_EXACT_KEYS,
  PAGE_NAMESPACE_EXACT_KEYS,
  PAGE_PROVENANCE_EXACT_KEYS,
  FORBIDDEN_PAGE_KEYS,
  sha256HexUtf8,
  byteLengthUtf8,
  canonicalizeContextPageV2,
  deriveContextPageDigestV2,
  deriveContextPageIdV2,
  createContextPageV2,
  validateContextPageV2,
  derivePageSourceFromEvidenceRef,
  describeContextPageV2,
};
