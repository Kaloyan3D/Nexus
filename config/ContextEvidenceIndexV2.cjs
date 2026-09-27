'use strict';
/**
 * ContextEvidenceIndexV2.cjs - CCV2-C03 derived namespace-scoped evidence index.
 *
 * ONE derived authority for the C03 retrieval index. The index is:
 *   derived      - rebuilt from validated durable B01 pages supplied by the caller
 *   rebuildable  - deleting it loses zero task truth (pages remain canonical)
 *   namespace-scoped - every entry binds one frozen ContextNamespaceV2
 *   non-authoritative - NEVER task/checkpoint/verification truth, NEVER
 *     canonical evidence storage (B01/B02 own that)
 *
 * Build source: caller-supplied validated B01 ContextPages (validated with
 * pageV2.validateContextPageV2 here). Arbitrary filesystem text, prompt
 * contents, unvalidated JSON, env dumps, and hidden reasoning are never
 * indexed: every entry resolves back to a valid ContextPage id/contentHash.
 *
 * Indexing is read-only and deterministic: same namespace + same canonical
 * pages -> byte-identical logical index (entries sorted by pageId ascending,
 * token sets sorted). No clocks, no randomness, no mtime, no insertion
 * order, no filesystem reads.
 *
 * Lexical normalization (frozen, cross-platform, C03H unicode-lexical-v1):
 *   NFKC Unicode normalization -> locale-independent lowercase via
 *   String.prototype.toLowerCase (never toLocaleLowerCase, never
 *   Intl.Collator, never locale word segmentation) -> tokens are maximal
 *   runs of Unicode letters and numbers ([\p{L}\p{N}]+ with the u flag).
 *   Tokens longer than 64 Unicode code points are dropped; per-field token
 *   sets are deduplicated and sorted. Empty tokens never match.
 *
 * Frozen Unicode policy (C03H):
 *   - Different scripts stay different tokens: no transliteration
 *     (грешка never becomes greshka), no translation, no synonyms.
 *   - No diacritic stripping: NFKC + case folding only, so cafe != café
 *     and their token sets never merge.
 *   - Identifier separators: '_' and '$' (and all punctuation/symbols/
 *     emoji/controls) split tokens: get_user -> get + user, $user -> user.
 *     Exact symbol identity is a separate byte-exact route and is never
 *     derived from lexical tokens.
 *   - Case folding is ECMAScript default (locale-free) mapping, NOT
 *     linguistic lowercasing: ß stays ß (only uppercasing maps it to SS);
 *     U+0130 İ folds to i + combining dot (the dot is Mark, not a
 *     letter, so İ tokenizes as [i]); Σ/σ/ς fold to σ/σ/ς (final sigma
 *     ς is preserved as its own token). Deterministic per Unicode
 *     Standard version carried by the JS engine; any algorithm change
 *     requires a new LEXICAL_NORMALIZATION_REVISION_V2 value.
 *   - Length bound unit: Unicode code points (Array.from length), so
 *     surrogate pairs are never split or corrupted by the bound.
 *
 * Secret safety: indexed fields are the already-redacted B01 persistable
 * representations (exactText/extract/gloss/files/symbols/entities/tags).
 * describeEvidenceIndexV2 exposes ids/routes/hash prefixes only.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (C03 freeze record). B01/B02/B03/B04/C01/C02 semantics are consumed
 * verbatim and never modified here. NOT implemented: embeddings, vectors,
 * ANN, semantic retrieval, learned rerankers, DecisionProvider/JEV/Laya,
 * budget packing, compression, prompt rendering.
 */

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const pageV2 = require('./ContextPageV2.cjs');

const EVIDENCE_INDEX_SCHEMA_VERSION = 1;
const EVIDENCE_INDEX_DOMAIN_V1 = 'nexus/context-evidence-index/v1';
const LEXICAL_NORMALIZATION_REVISION_V2 = 'unicode-lexical-v1';
const INDEX_ID_PREFIX = 'cxi_';
const PAGE_ID_PATTERN = /^cxp_[0-9a-f]{32}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_MAX_CHARS = 64;

const INDEX_TOP_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'indexId', 'namespace', 'lexicalRevision', 'builtFromDigest', 'entryCount', 'entries',
]);
const INDEX_ENTRY_EXACT_KEYS = Object.freeze([
  'pageId', 'contentHash', 'kind', 'files', 'symbols', 'entities', 'tags',
  'sourceIdentity', 'fieldTokens', 'phraseText',
]);

// Lexical fields indexed per entry (frozen closed world).
const INDEXED_FIELDS = Object.freeze([
  'kind', 'files', 'symbols', 'entities', 'tags', 'extract', 'semanticGloss', 'exactText',
]);

function failIndex(reason, detail) {
  throw new Error('v2-context-evidence-index: ' + reason + (detail ? ' (' + detail + ')' : '') + ' (BLOCK/KEEP)');
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

function namespacesEqual(a, b) {
  return JSON.stringify(checkpointV2.canonicalize(normalizeNamespace(a)))
    === JSON.stringify(checkpointV2.canonicalize(normalizeNamespace(b)));
}

function normalizeNamespace(namespace) {
  if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) {
    failIndex('context-evidence-index-namespace-invalid', 'namespace is required');
  }
  const out = {
    taskId: namespace.taskId,
    taskInstanceId: namespace.taskInstanceId,
    sessionId: namespace.sessionId,
    workspaceId: namespace.workspaceId,
    repositoryId: namespace.repositoryId === undefined ? null : namespace.repositoryId,
    checkoutId: namespace.checkoutId === undefined ? null : namespace.checkoutId,
  };
  return out;
}

// ---- frozen lexical normalization ----
function normalizeLexicalTextV2(text) {
  if (typeof text !== 'string') return '';
  return String(text).normalize('NFKC').toLowerCase();
}

function tokenizeLexicalV2(text) {
  const normalized = normalizeLexicalTextV2(text);
  const runs = normalized.match(/[\p{L}\p{N}]+/gu);
  const kept = [];
  const seen = new Set();
  for (const token of runs === null ? [] : runs) {
    if (token === '' || Array.from(token).length > TOKEN_MAX_CHARS) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    kept.push(token);
  }
  kept.sort();
  return Object.freeze(kept);
}

function sourceIdentityOf(page) {
  if (page.sourceBinding !== null && page.sourceBinding !== undefined) {
    if (page.sourceBinding.kind === 'repository-span') {
      return 'repository-span:' + String(page.sourceBinding.path);
    }
    return 'artifact:' + String(page.sourceBinding.artifactId);
  }
  if (page.exactBlobRef !== null && page.exactBlobRef !== undefined) return 'blob:' + String(page.exactBlobRef);
  if (page.exactText !== null && page.exactText !== undefined) return 'inline-exact';
  if (Array.isArray(page.sourceSeqs) && page.sourceSeqs.length > 0) return 'session:' + page.sourceSeqs.join(',');
  return 'unknown';
}

function fieldTokensOf(page) {
  const fields = {};
  fields.kind = tokenizeLexicalV2(String(page.kind || ''));
  fields.files = tokenizeLexicalV2((page.files || []).join(' '));
  fields.symbols = tokenizeLexicalV2((page.symbols || []).join(' '));
  fields.entities = tokenizeLexicalV2((page.entities || []).join(' '));
  fields.tags = tokenizeLexicalV2((page.tags || []).join(' '));
  fields.extract = tokenizeLexicalV2(page.extract === null || page.extract === undefined ? '' : String(page.extract));
  fields.semanticGloss = tokenizeLexicalV2(
    page.semanticGloss === null || page.semanticGloss === undefined ? '' : String(page.semanticGloss));
  // Bounded exactText is indexed ONLY when inline bytes are already present
  // on the validated page object (no blob fetch, no session read, no scan).
  fields.exactText = tokenizeLexicalV2(
    page.exactText === null || page.exactText === undefined ? '' : String(page.exactText));
  return Object.freeze(fields);
}

function phraseTextOf(page) {
  const parts = [];
  if (page.extract !== null && page.extract !== undefined) parts.push(String(page.extract));
  if (page.semanticGloss !== null && page.semanticGloss !== undefined) parts.push(String(page.semanticGloss));
  if (page.exactText !== null && page.exactText !== undefined) parts.push(String(page.exactText));
  // Code-point-safe truncation: never split a surrogate pair.
  return Array.from(normalizeLexicalTextV2(parts.join(' '))).slice(0, 4000).join('');
}

function buildEntry(page) {
  return Object.freeze({
    pageId: page.id,
    contentHash: page.contentHash,
    kind: page.kind,
    files: Object.freeze((page.files || []).slice().sort()),
    symbols: Object.freeze((page.symbols || []).slice().sort()),
    entities: Object.freeze((page.entities || []).slice().sort()),
    tags: Object.freeze((page.tags || []).slice().sort()),
    sourceIdentity: sourceIdentityOf(page),
    fieldTokens: fieldTokensOf(page),
    phraseText: phraseTextOf(page),
  });
}

// ---- build (derived, namespace-scoped, deterministic) ----
function buildEvidenceIndexV2(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    failIndex('context-evidence-index-input-invalid', 'input is required');
  }
  if (unknownKeyOf(input, ['namespace', 'pages']) !== null) {
    failIndex('context-evidence-index-unknown-field', unknownKeyOf(input, ['namespace', 'pages']));
  }
  const namespace = normalizeNamespace(input.namespace);
  if (!Array.isArray(input.pages)) failIndex('context-evidence-index-input-invalid', 'pages must be an array');
  const seen = new Set();
  const entries = [];
  for (const page of input.pages) {
    const check = pageV2.validateContextPageV2(page, { expectedNamespace: namespace });
    if (!check.valid) {
      failIndex(
        check.reason === 'context-page-namespace-mismatch'
          ? 'context-evidence-index-namespace-mismatch'
          : 'context-evidence-index-page-invalid',
        check.reason + ' for page ' + String(page && page.id).slice(0, 40));
    }
    if (seen.has(page.id)) failIndex('context-evidence-index-duplicate-page', String(page.id).slice(0, 40));
    seen.add(page.id);
    entries.push(buildEntry(page));
  }
  entries.sort((a, b) => (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0));
  // The lexical revision binds index identity: an ASCII-token index and
  // a Unicode-token index over identical pages MUST have different ids.
  const builtFromDigest = sha256HexUtf8(JSON.stringify(checkpointV2.canonicalize({
    domain: EVIDENCE_INDEX_DOMAIN_V1,
    lexicalRevision: LEXICAL_NORMALIZATION_REVISION_V2,
    namespace,
    pages: entries.map((entry) => ({ pageId: entry.pageId, contentHash: entry.contentHash })),
  })));
  const indexId = INDEX_ID_PREFIX + sha256HexUtf8(JSON.stringify(checkpointV2.canonicalize({
    domain: EVIDENCE_INDEX_DOMAIN_V1,
    lexicalRevision: LEXICAL_NORMALIZATION_REVISION_V2,
    namespace,
    builtFromDigest,
  }))).slice(0, 32);
  return Object.freeze({
    schemaVersion: EVIDENCE_INDEX_SCHEMA_VERSION,
    indexId,
    lexicalRevision: LEXICAL_NORMALIZATION_REVISION_V2,
    namespace: Object.freeze(namespace),
    builtFromDigest,
    entryCount: entries.length,
    entries: Object.freeze(entries),
  });
}

function validateEvidenceIndexV2(index) {
  const fail = (reason) => ({ valid: false, reason });
  if (!index || typeof index !== 'object' || Array.isArray(index)) return fail('context-evidence-index-invalid');
  if (unknownKeyOf(index, INDEX_TOP_EXACT_KEYS) !== null) return fail('context-evidence-index-unknown-field');
  if (Number(index.schemaVersion) !== EVIDENCE_INDEX_SCHEMA_VERSION) return fail('context-evidence-index-schema-version');
  if (typeof index.indexId !== 'string' || !index.indexId.startsWith(INDEX_ID_PREFIX)) {
    return fail('context-evidence-index-id-invalid');
  }
  if (index.lexicalRevision !== LEXICAL_NORMALIZATION_REVISION_V2) {
    return fail('context-evidence-index-revision-mismatch');
  }
  if (!index.namespace || typeof index.namespace !== 'object') return fail('context-evidence-index-namespace-invalid');
  if (!Array.isArray(index.entries)) return fail('context-evidence-index-entries-invalid');
  if (index.entries.length !== index.entryCount) return fail('context-evidence-index-count-mismatch');
  const seen = new Set();
  for (const entry of index.entries) {
    if (!entry || typeof entry !== 'object') return fail('context-evidence-index-entry-invalid');
    if (unknownKeyOf(entry, INDEX_ENTRY_EXACT_KEYS) !== null) return fail('context-evidence-index-unknown-field');
    if (typeof entry.pageId !== 'string' || !PAGE_ID_PATTERN.test(entry.pageId)) {
      return fail('context-evidence-index-entry-invalid');
    }
    if (typeof entry.contentHash !== 'string' || !HEX64_PATTERN.test(entry.contentHash)) {
      return fail('context-evidence-index-entry-invalid');
    }
    if (seen.has(entry.pageId)) return fail('context-evidence-index-duplicate-page');
    seen.add(entry.pageId);
    if (!entry.fieldTokens || typeof entry.fieldTokens !== 'object') return fail('context-evidence-index-entry-invalid');
    for (const field of INDEXED_FIELDS) {
      if (!Array.isArray(entry.fieldTokens[field])) return fail('context-evidence-index-entry-invalid');
    }
  }
  for (let i = 1; i < index.entries.length; i += 1) {
    if (!(index.entries[i - 1].pageId < index.entries[i].pageId)) return fail('context-evidence-index-order-invalid');
  }
  const recomputed = sha256HexUtf8(JSON.stringify(checkpointV2.canonicalize({
    domain: EVIDENCE_INDEX_DOMAIN_V1,
    lexicalRevision: LEXICAL_NORMALIZATION_REVISION_V2,
    namespace: normalizeNamespace(index.namespace),
    pages: index.entries.map((entry) => ({ pageId: entry.pageId, contentHash: entry.contentHash })),
  })));
  if (recomputed !== index.builtFromDigest) return fail('context-evidence-index-digest-mismatch');
  const recomputedId = INDEX_ID_PREFIX + sha256HexUtf8(JSON.stringify(checkpointV2.canonicalize({
    domain: EVIDENCE_INDEX_DOMAIN_V1,
    lexicalRevision: LEXICAL_NORMALIZATION_REVISION_V2,
    namespace: normalizeNamespace(index.namespace),
    builtFromDigest: index.builtFromDigest,
  }))).slice(0, 32);
  if (recomputedId !== index.indexId) return fail('context-evidence-index-id-mismatch');
  return { valid: true, reason: null };
}

function canonicalizeEvidenceIndexV2(index) {
  const check = validateEvidenceIndexV2(index);
  if (!check.valid) failIndex(check.reason, 'cannot canonicalize an invalid index');
  return JSON.stringify(checkpointV2.canonicalize(JSON.parse(JSON.stringify(index))));
}

function describeEvidenceIndexV2(index) {
  const check = validateEvidenceIndexV2(index);
  if (!check.valid) failIndex(check.reason, 'cannot describe an invalid index');
  return Object.freeze({
    indexId: index.indexId,
    lexicalRevision: index.lexicalRevision,
    entryCount: index.entryCount,
    builtFromDigestPrefix: String(index.builtFromDigest).slice(0, 16),
    pageIds: Object.freeze(index.entries.map((entry) => entry.pageId)),
    contentHashPrefixes: Object.freeze(index.entries.map((entry) => String(entry.contentHash).slice(0, 16))),
    deterministic: true,
  });
}

module.exports = {
  EVIDENCE_INDEX_SCHEMA_VERSION,
  EVIDENCE_INDEX_DOMAIN_V1,
  LEXICAL_NORMALIZATION_REVISION_V2,
  INDEXED_FIELDS,
  normalizeLexicalTextV2,
  tokenizeLexicalV2,
  buildEvidenceIndexV2,
  validateEvidenceIndexV2,
  canonicalizeEvidenceIndexV2,
  describeEvidenceIndexV2,
};
