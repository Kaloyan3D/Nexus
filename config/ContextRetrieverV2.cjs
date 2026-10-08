'use strict';
/**
 * ContextRetrieverV2.cjs - CCV2-C03 deterministic retrieval production authority.
 *
 * ONE authority for deterministic retrieval of already-stored exact evidence.
 * C03 answers "which already-stored exact evidence should be returned for
 * the current compile request" and NOTHING else. Retrieval cascade:
 *
 *   exact EvidenceRef / Page ID -> exact file identity -> exact symbol
 *   identity -> deterministic lexical retrieval. Stop there.
 *
 * Primary rules (frozen):
 *   - exact references always win (route priority is categorical, never numeric)
 *   - retrieval answers evidence relevance/access, never task truth
 *   - namespace is constrained BEFORE ranking (search-then-filter is a
 *     security defect; cross-task leakage fails closed)
 *   - exact failures are returned, never silently replaced by near-matches
 *
 * Exact resolution uses the frozen B03 authority (config/
 * ContextEvidenceRehydrationV2.cjs) and the frozen B02 store
 * (config/ContextPageStoreV2.cjs). C03 owns retrieval orchestration;
 * B03 owns exact proof. File/symbol/lexical discovery runs over the
 * derived namespace-scoped index (config/ContextEvidenceIndexV2.cjs),
 * rebuilt or verified against validated B01 pages on every call.
 *
 * Retrieval is read-only: no checkpoint/page/tier/EvidenceRef/advisory/
 * repository/session/history mutation, no usage counters. Every export is
 * deterministic: same namespace/index/query/candidates/limit -> same
 * identities, routes, scores, tie order across calls, restarts, processes.
 *
 * NOT implemented here (explicitly unsupported): embeddings, vector DB,
 * ANN/HNSW, cosine similarity, semantic retrieval, learned rerankers,
 * LLM relevance scoring, DecisionProvider/JEV/Laya, confidence scoring,
 * token-budget packing, compression, prompt rendering, root-model
 * enablement. Those words appear in this comment only to name the
 * unsupported dimension; no such dependency exists in this module.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (C03 freeze record). A/B/C01/C02 semantics are consumed verbatim.
 */

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const pageV2 = require('./ContextPageV2.cjs');
const storeV2 = require('./ContextPageStoreV2.cjs');
const rehydrationV2 = require('./ContextEvidenceRehydrationV2.cjs');
const evidenceIndexV2 = require('./ContextEvidenceIndexV2.cjs');

const RETRIEVAL_SCHEMA_VERSION = 1;
const RETRIEVAL_RESULT_DOMAIN_V1 = 'nexus/context-retrieval-result/v1';

// Categorical route priority (frozen): lower number always outranks higher,
// regardless of any numeric lexical score.
const ROUTE_PRIORITY = Object.freeze({
  'exact-evidence': 1,
  'exact-page': 2,
  file: 3,
  symbol: 4,
  lexical: 5,
});
const ROUTES = Object.freeze(Object.keys(ROUTE_PRIORITY));

const SCORE_CLASSES = Object.freeze({
  'exact-evidence': 'exact-v1',
  'exact-page': 'exact-v1',
  file: 'identity-file-v1',
  symbol: 'identity-symbol-v1',
  lexical: 'lexical-v1',
});

// Frozen lexical field weights (transparent, no learned weights).
const LEXICAL_FIELD_WEIGHTS = Object.freeze({
  files: 50,
  symbols: 50,
  tags: 30,
  entities: 30,
  extract: 20,
  exactText: 20,
  kind: 10,
  semanticGloss: 5,
});
const LEXICAL_PHRASE_BONUS = 15;

const REASON_CODES = Object.freeze([
  'retrieval-exact-evidence',
  'retrieval-exact-page',
  'retrieval-file-identity',
  'retrieval-symbol-identity',
  'retrieval-lexical-phrase',
  'retrieval-lexical-token',
  'retrieval-no-match',
  'retrieval-index-stale',
  'retrieval-namespace-mismatch',
  'retrieval-exact-not-found',
  'retrieval-exact-content-mismatch',
  'retrieval-request-invalid',
  'retrieval-file-query-invalid',
  'retrieval-symbol-query-invalid',
  'retrieval-file-repository-mismatch',
  'retrieval-symbol-repository-mismatch',
  'retrieval-candidate-restricted',
]);

const PAGE_ID_PATTERN = /^cxp_[0-9a-f]{32}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const RETRIEVAL_MODES = Object.freeze(['identity-only', 'exact-materialized']);
const OPTIONAL_RESULT_MAX = 100;

const RETRIEVAL_REQUEST_EXACT_KEYS = Object.freeze([
  'namespace', 'exactEvidenceIds', 'exactPageIds', 'fileIdentities',
  'symbolIdentities', 'lexicalTerms', 'candidatePageIds', 'limit',
  'mode', 'contextRoot', 'evidenceIndex', 'pages',
  'sessionSource', 'repositorySource', 'artifactSource',
]);
const FILE_QUERY_EXACT_KEYS = Object.freeze(['path', 'contentHash', 'repositoryId']);
const SYMBOL_QUERY_EXACT_KEYS = Object.freeze(['symbol', 'file', 'repositoryId']);
const EVIDENCE_QUERY_EXACT_KEYS = Object.freeze(['evidenceId', 'taskInstanceId', 'evidenceRef']);
const RESULT_TOP_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'namespace', 'results', 'errors', 'trace',
  'resultDigest', 'deterministic',
]);
const RESULT_ENTRY_EXACT_KEYS = Object.freeze([
  'pageId', 'evidenceId', 'contentHash', 'route', 'scoreClass', 'score',
  'matchedFields', 'provenance', 'namespace', 'rehydratedEvidence', 'deterministic',
]);

function failRetrieval(reason, detail) {
  throw new Error('v2-context-retrieval: ' + reason + (detail ? ' (' + detail + ')' : '') + ' (BLOCK/KEEP)');
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

function normalizeNamespace(namespace) {
  if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) {
    failRetrieval('retrieval-request-invalid', 'namespace is required');
  }
  return {
    taskId: namespace.taskId,
    taskInstanceId: namespace.taskInstanceId,
    sessionId: namespace.sessionId,
    workspaceId: namespace.workspaceId,
    repositoryId: namespace.repositoryId === undefined ? null : namespace.repositoryId,
    checkoutId: namespace.checkoutId === undefined ? null : namespace.checkoutId,
  };
}

// ---- frozen file-path normalization (mirrors B01 validatePagePath) ----
function normalizeFilePathV2(path) {
  if (typeof path !== 'string' || path === '' || path.length > 500) return null;
  if (path.startsWith('/')) return null;
  if (path.includes('\\')) return null;
  if (!/^[\x20-\x7E]+$/.test(path)) return null;
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
  }
  return path;
}

function checkRepositoryScope(queryRepositoryId, namespace) {
  if (queryRepositoryId === undefined || queryRepositoryId === null) return true;
  if (typeof queryRepositoryId !== 'string' || queryRepositoryId === '') return false;
  if (namespace.repositoryId === null || namespace.repositoryId === undefined) return false;
  return queryRepositoryId === namespace.repositoryId;
}

// ---- request validation (closed world) ----
function normalizeEvidenceQuery(entry, namespace) {
  if (typeof entry === 'string') {
    if (entry === '') failRetrieval('retrieval-request-invalid', 'empty evidenceId');
    return { evidenceId: entry, taskInstanceId: namespace.taskInstanceId, evidenceRef: null };
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    failRetrieval('retrieval-request-invalid', 'exactEvidenceIds entries must be strings or objects');
  }
  if (unknownKeyOf(entry, EVIDENCE_QUERY_EXACT_KEYS) !== null) {
    failRetrieval('retrieval-request-invalid', 'unknown evidence query key ' + unknownKeyOf(entry, EVIDENCE_QUERY_EXACT_KEYS));
  }
  if (typeof entry.evidenceId !== 'string' || entry.evidenceId === '') {
    failRetrieval('retrieval-request-invalid', 'evidenceId is required');
  }
  const taskInstanceId = entry.taskInstanceId === undefined || entry.taskInstanceId === null
    ? namespace.taskInstanceId : entry.taskInstanceId;
  if (typeof taskInstanceId !== 'string' || taskInstanceId === '') {
    failRetrieval('retrieval-request-invalid', 'taskInstanceId is required');
  }
  return { evidenceId: entry.evidenceId, taskInstanceId, evidenceRef: entry.evidenceRef === undefined ? null : entry.evidenceRef };
}

function validateRetrievalRequestV2(input) {
  const fail = (reason) => ({ valid: false, reason });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('retrieval-request-invalid');
  if (unknownKeyOf(input, RETRIEVAL_REQUEST_EXACT_KEYS) !== null) return fail('retrieval-request-invalid');
  try {
    normalizeNamespace(input.namespace);
  } catch {
    return fail('retrieval-request-invalid');
  }
  for (const key of ['exactEvidenceIds', 'exactPageIds', 'fileIdentities', 'symbolIdentities', 'lexicalTerms']) {
    if (!Array.isArray(input[key])) return fail('retrieval-request-invalid');
  }
  for (const pageId of input.exactPageIds) {
    if (typeof pageId !== 'string' || !PAGE_ID_PATTERN.test(pageId)) return fail('retrieval-request-invalid');
  }
  if (input.candidatePageIds !== undefined && input.candidatePageIds !== null) {
    if (!Array.isArray(input.candidatePageIds)) return fail('retrieval-request-invalid');
    for (const pageId of input.candidatePageIds) {
      if (typeof pageId !== 'string' || !PAGE_ID_PATTERN.test(pageId)) return fail('retrieval-request-invalid');
    }
  }
  if (!Number.isInteger(input.limit) || input.limit < 0 || input.limit > OPTIONAL_RESULT_MAX) {
    return fail('retrieval-request-invalid');
  }
  if (typeof input.mode !== 'string' || !RETRIEVAL_MODES.includes(input.mode)) return fail('retrieval-request-invalid');
  if (!Array.isArray(input.pages)) return fail('retrieval-request-invalid');
  if (input.fileIdentities.length > 0 || input.symbolIdentities.length > 0 || input.lexicalTerms.length > 0) {
    if (!input.evidenceIndex || typeof input.evidenceIndex !== 'object') return fail('retrieval-request-invalid');
  }
  for (const term of input.lexicalTerms) {
    if (typeof term !== 'string') return fail('retrieval-request-invalid');
  }
  return { valid: true, reason: null };
}

function requireValidRequest(input) {
  const check = validateRetrievalRequestV2(input);
  if (!check.valid) failRetrieval(check.reason, 'retrieval request failed closed-world validation');
  return input;
}

function mapExactError(error, identity) {
  const message = boundedCause(error);
  if (message.indexOf('namespace-mismatch') !== -1) {
    return { identity, reason: 'retrieval-namespace-mismatch', detail: message };
  }
  if (message.indexOf('missing') !== -1 || message.indexOf('not-found') !== -1
    || message.indexOf('not available') !== -1 || message.indexOf('not durable') !== -1
    || message.indexOf('not-rehydratable') !== -1) {
    return { identity, reason: 'retrieval-exact-not-found', detail: message };
  }
  if (message.indexOf('mismatch') !== -1 || message.indexOf('corrupt') !== -1
    || message.indexOf('conflict') !== -1 || message.indexOf('invalid') !== -1) {
    return { identity, reason: 'retrieval-exact-content-mismatch', detail: message };
  }
  return { identity, reason: 'retrieval-exact-not-found', detail: message };
}

// ---- index verification against supplied pages (stale fails closed) ----
function verifyIndexAgainstPages(evidenceIndex, pagesById, namespace) {
  const check = evidenceIndexV2.validateEvidenceIndexV2(evidenceIndex);
  if (!check.valid) {
    failRetrieval('retrieval-index-stale', 'index failed validation: ' + check.reason);
  }
  if (JSON.stringify(checkpointV2.canonicalize(evidenceIndex.namespace))
      !== JSON.stringify(checkpointV2.canonicalize(namespace))) {
    failRetrieval('retrieval-namespace-mismatch', 'index namespace diverges from the request namespace');
  }
  for (const entry of evidenceIndex.entries) {
    const page = pagesById.get(entry.pageId);
    if (!page) failRetrieval('retrieval-index-stale', 'index points to a missing page ' + entry.pageId);
    if (page.contentHash !== entry.contentHash) {
      failRetrieval('retrieval-index-stale', 'stale binding for ' + entry.pageId);
    }
  }
  return evidenceIndex;
}

function buildPagesById(pages, namespace) {
  const map = new Map();
  for (const page of pages) {
    const check = pageV2.validateContextPageV2(page, { expectedNamespace: namespace });
    if (!check.valid) {
      failRetrieval(
        check.reason === 'context-page-namespace-mismatch' ? 'retrieval-namespace-mismatch' : 'retrieval-request-invalid',
        'page failed validation: ' + check.reason);
    }
    if (map.has(page.id)) failRetrieval('retrieval-request-invalid', 'duplicate page ' + page.id);
    map.set(page.id, page);
  }
  return map;
}

// ---- exact routes (B03/store owned proof) ----
function resolveExactEvidence(query, request, namespace) {
  const { contextRoot, sessionSource, repositorySource, artifactSource, mode } = request;
  if (typeof contextRoot !== 'string' || contextRoot === '') {
    failRetrieval('retrieval-request-invalid', 'contextRoot is required for exact EvidenceRef resolution');
  }
  if (query.taskInstanceId !== namespace.taskInstanceId) {
    const error = mapExactError(new Error('v2-context-rehydration: context-rehydration-namespace-mismatch'), 'ev:' + query.evidenceId);
    error.reason = 'retrieval-namespace-mismatch';
    return { error };
  }
  try {
    if (mode === 'exact-materialized') {
      const rehydrated = rehydrationV2.rehydrateEvidenceRefV2({
        contextRoot,
        evidenceId: query.evidenceId,
        taskInstanceId: query.taskInstanceId,
        evidenceRef: query.evidenceRef,
        expectedNamespace: namespace,
        sessionSource: sessionSource === undefined ? null : sessionSource,
        repositorySource: repositorySource === undefined ? null : repositorySource,
        artifactSource: artifactSource === undefined ? null : artifactSource,
      });
      return { rehydrated };
    }
    const binding = storeV2.readEvidenceV2(contextRoot, query.taskInstanceId, query.evidenceId, { expectedNamespace: namespace });
    const page = storeV2.readContextPageV2(contextRoot, binding.pageId, { expectedNamespace: namespace });
    return { identity: { page, evidenceId: query.evidenceId } };
  } catch (error) {
    return { error: mapExactError(error, 'ev:' + query.evidenceId) };
  }
}

function resolveExactPage(pageId, request, namespace) {
  const { contextRoot, sessionSource, repositorySource, artifactSource, mode } = request;
  if (typeof contextRoot !== 'string' || contextRoot === '') {
    failRetrieval('retrieval-request-invalid', 'contextRoot is required for exact Page-ID resolution');
  }
  try {
    if (mode === 'exact-materialized') {
      const rehydrated = rehydrationV2.rehydrateContextPageV2({
        contextRoot,
        pageId,
        expectedNamespace: namespace,
        sessionSource: sessionSource === undefined ? null : sessionSource,
        repositorySource: repositorySource === undefined ? null : repositorySource,
        artifactSource: artifactSource === undefined ? null : artifactSource,
      });
      return { rehydrated };
    }
    const page = storeV2.readContextPageV2(contextRoot, pageId, { expectedNamespace: namespace });
    return { identity: { page, evidenceId: null } };
  } catch (error) {
    return { error: mapExactError(error, 'page:' + pageId) };
  }
}

// ---- file / symbol / lexical routes over the derived index ----
function matchFileQuery(query, entry, page, namespace) {
  if (query === null) return { matched: false, invalid: true };
  if (unknownKeyOf(query, FILE_QUERY_EXACT_KEYS) !== null) return { matched: false, invalid: true };
  const normalized = normalizeFilePathV2(query.path);
  if (normalized === null) return { matched: false, invalid: true };
  if (!checkRepositoryScope(query.repositoryId === undefined ? null : query.repositoryId, namespace)) {
    return { matched: false, repositoryMismatch: true };
  }
  if (query.contentHash !== undefined && query.contentHash !== null) {
    if (typeof query.contentHash !== 'string' || !HEX64_PATTERN.test(query.contentHash)) {
      return { matched: false, invalid: true };
    }
    if (page.contentHash !== query.contentHash) return { matched: false };
  }
  if (!entry.files.includes(normalized)) {
    const bindingPath = page.sourceBinding && page.sourceBinding.kind === 'repository-span'
      ? page.sourceBinding.path : null;
    if (bindingPath !== normalized) return { matched: false };
  }
  return { matched: true, normalized };
}

function matchSymbolQuery(query, entry, page, namespace) {
  if (query === null) return { matched: false, invalid: true };
  if (unknownKeyOf(query, SYMBOL_QUERY_EXACT_KEYS) !== null) return { matched: false, invalid: true };
  if (typeof query.symbol !== 'string' || query.symbol === '' || query.symbol.length > 256) {
    return { matched: false, invalid: true };
  }
  if (!checkRepositoryScope(query.repositoryId === undefined ? null : query.repositoryId, namespace)) {
    return { matched: false, repositoryMismatch: true };
  }
  // Case sensitivity is frozen exact: symbols match byte-for-byte.
  const bindingSymbol = page.sourceBinding && typeof page.sourceBinding.symbol === 'string'
    ? page.sourceBinding.symbol : null;
  if (!entry.symbols.includes(query.symbol) && bindingSymbol !== query.symbol) {
    return { matched: false };
  }
  if (query.file !== undefined && query.file !== null) {
    const normalized = normalizeFilePathV2(query.file);
    if (normalized === null) return { matched: false, invalid: true };
    if (!entry.files.includes(normalized)) {
      const bindingPath = page.sourceBinding && page.sourceBinding.kind === 'repository-span'
        ? page.sourceBinding.path : null;
      if (bindingPath !== normalized) return { matched: false };
    }
  }
  return { matched: true };
}

function scoreLexicalEntry(queryTokens, phrase, entry) {
  let score = 0;
  const matchedFields = [];
  for (const token of queryTokens) {
    let bestWeight = 0;
    let bestField = null;
    for (const field of Object.keys(LEXICAL_FIELD_WEIGHTS)) {
      const tokens = entry.fieldTokens[field] || [];
      if (tokens.includes(token) && LEXICAL_FIELD_WEIGHTS[field] > bestWeight) {
        bestWeight = LEXICAL_FIELD_WEIGHTS[field];
        bestField = field;
      }
    }
    if (bestWeight > 0) {
      score += bestWeight;
      if (!matchedFields.includes(bestField)) matchedFields.push(bestField);
    }
  }
  if (score === 0) return { score: 0, matchedFields: [], phrase: false };
  let phraseHit = false;
  if (phrase !== '' && entry.phraseText.includes(phrase)) {
    score += LEXICAL_PHRASE_BONUS;
    phraseHit = true;
  }
  matchedFields.sort();
  return { score, matchedFields, phrase: phraseHit };
}

// ---- main retrieval entry point ----
function retrieveContextEvidenceV2(input) {
  requireValidRequest(input);
  const namespace = normalizeNamespace(input.namespace);
  const pagesById = buildPagesById(input.pages, namespace);
  const candidateSet = input.candidatePageIds === undefined || input.candidatePageIds === null
    ? null : new Set(input.candidatePageIds);

  const merged = new Map();
  const errors = [];
  const trace = [];
  const emitTrace = (entry) => trace.push(Object.freeze(entry));

  const upsert = (pageId, record) => {
    const existing = merged.get(pageId);
    if (!existing || ROUTE_PRIORITY[record.route] < ROUTE_PRIORITY[existing.route]) {
      merged.set(pageId, record);
    } else if (ROUTE_PRIORITY[record.route] === ROUTE_PRIORITY[existing.route]) {
      const fields = Array.from(new Set((existing.matchedFields || []).concat(record.matchedFields || []))).sort();
      merged.set(pageId, Object.assign({}, existing, { matchedFields: Object.freeze(fields) }));
    }
  };

  // Route 1: exact EvidenceRef (mandatory obligations, never truncated).
  for (const raw of input.exactEvidenceIds) {
    const query = normalizeEvidenceQuery(raw, namespace);
    const outcome = resolveExactEvidence(query, input, namespace);
    if (outcome.error) {
      errors.push(Object.freeze({
        identity: outcome.error.identity, route: 'exact-evidence',
        reason: outcome.error.reason, detail: outcome.error.detail.slice(0, 240),
      }));
      emitTrace({
        pageId: null, route: 'exact-evidence', matchedFields: [],
        scoreClass: SCORE_CLASSES['exact-evidence'], score: null,
        reasonCode: outcome.error.reason,
      });
      continue;
    }
    const page = outcome.rehydrated ? {
      id: outcome.rehydrated.pageId, contentHash: outcome.rehydrated.contentHash,
      kind: outcome.rehydrated.kind, provenance: outcome.rehydrated.provenance, namespace,
    } : outcome.identity.page;
    upsert(page.id, {
      pageId: page.id,
      evidenceId: query.evidenceId,
      contentHash: page.contentHash,
      route: 'exact-evidence',
      scoreClass: SCORE_CLASSES['exact-evidence'],
      score: null,
      matchedFields: Object.freeze([]),
      provenance: page.provenance,
      namespace,
      rehydratedEvidence: outcome.rehydrated === undefined ? null : outcome.rehydrated,
    });
    emitTrace({
      pageId: page.id, route: 'exact-evidence', matchedFields: [],
      scoreClass: SCORE_CLASSES['exact-evidence'], score: null,
      reasonCode: 'retrieval-exact-evidence',
    });
  }

  // Route 2: exact Page ID (mandatory obligations, never truncated).
  for (const pageId of input.exactPageIds) {
    const outcome = resolveExactPage(pageId, input, namespace);
    if (outcome.error) {
      errors.push(Object.freeze({
        identity: outcome.error.identity, route: 'exact-page',
        reason: outcome.error.reason, detail: outcome.error.detail.slice(0, 240),
      }));
      emitTrace({
        pageId: null, route: 'exact-page', matchedFields: [],
        scoreClass: SCORE_CLASSES['exact-page'], score: null,
        reasonCode: outcome.error.reason,
      });
      continue;
    }
    const page = outcome.rehydrated ? {
      id: outcome.rehydrated.pageId, contentHash: outcome.rehydrated.contentHash,
      kind: outcome.rehydrated.kind, provenance: outcome.rehydrated.provenance, namespace,
    } : outcome.identity.page;
    upsert(page.id, {
      pageId: page.id,
      evidenceId: null,
      contentHash: page.contentHash,
      route: 'exact-page',
      scoreClass: SCORE_CLASSES['exact-page'],
      score: null,
      matchedFields: Object.freeze([]),
      provenance: page.provenance,
      namespace,
      rehydratedEvidence: outcome.rehydrated === undefined ? null : outcome.rehydrated,
    });
    emitTrace({
      pageId: page.id, route: 'exact-page', matchedFields: [],
      scoreClass: SCORE_CLASSES['exact-page'], score: null,
      reasonCode: 'retrieval-exact-page',
    });
  }

  const needsIndex = input.fileIdentities.length > 0 || input.symbolIdentities.length > 0
    || input.lexicalTerms.length > 0;
  let evidenceIndex = null;
  if (needsIndex) {
    evidenceIndex = verifyIndexAgainstPages(input.evidenceIndex, pagesById, namespace);
  }

  const inCandidates = (pageId) => candidateSet === null || candidateSet.has(pageId);
  const optional = [];

  // Route 3: exact file identity.
  for (const query of input.fileIdentities) {
    const probe = matchFileQueryPrecheck(query, namespace);
    if (probe.invalid) {
      emitTrace({
        pageId: null, route: 'file', matchedFields: [],
        scoreClass: SCORE_CLASSES.file, score: null,
        reasonCode: 'retrieval-file-query-invalid',
      });
      continue;
    }
    if (probe.repositoryMismatch) {
      emitTrace({
        pageId: null, route: 'file', matchedFields: [],
        scoreClass: SCORE_CLASSES.file, score: null,
        reasonCode: 'retrieval-file-repository-mismatch',
      });
      continue;
    }
    let hits = 0;
    for (const entry of evidenceIndex.entries) {
      if (!inCandidates(entry.pageId)) continue;
      const page = pagesById.get(entry.pageId);
      const match = matchFileQuery(query, entry, page, namespace);
      if (!match.matched) continue;
      hits += 1;
      const record = {
        pageId: entry.pageId,
        evidenceId: null,
        contentHash: entry.contentHash,
        route: 'file',
        scoreClass: SCORE_CLASSES.file,
        score: null,
        matchedFields: Object.freeze(['files']),
        provenance: page.provenance,
        namespace,
        rehydratedEvidence: null,
      };
      upsert(entry.pageId, record);
      optional.push(record);
      emitTrace({
        pageId: entry.pageId, route: 'file', matchedFields: ['files'],
        scoreClass: SCORE_CLASSES.file, score: null,
        reasonCode: 'retrieval-file-identity',
      });
    }
    if (hits === 0) {
      emitTrace({
        pageId: null, route: 'file', matchedFields: [],
        scoreClass: SCORE_CLASSES.file, score: null,
        reasonCode: 'retrieval-no-match',
      });
    }
  }

  // Route 4: exact symbol identity.
  for (const query of input.symbolIdentities) {
    const probe = matchSymbolQueryPrecheck(query, namespace);
    if (probe.invalid) {
      emitTrace({
        pageId: null, route: 'symbol', matchedFields: [],
        scoreClass: SCORE_CLASSES.symbol, score: null,
        reasonCode: 'retrieval-symbol-query-invalid',
      });
      continue;
    }
    if (probe.repositoryMismatch) {
      emitTrace({
        pageId: null, route: 'symbol', matchedFields: [],
        scoreClass: SCORE_CLASSES.symbol, score: null,
        reasonCode: 'retrieval-symbol-repository-mismatch',
      });
      continue;
    }
    let hits = 0;
    for (const entry of evidenceIndex.entries) {
      if (!inCandidates(entry.pageId)) continue;
      const page = pagesById.get(entry.pageId);
      const match = matchSymbolQuery(query, entry, page, namespace);
      if (!match.matched) continue;
      hits += 1;
      const record = {
        pageId: entry.pageId,
        evidenceId: null,
        contentHash: entry.contentHash,
        route: 'symbol',
        scoreClass: SCORE_CLASSES.symbol,
        score: null,
        matchedFields: Object.freeze(['symbols']),
        provenance: page.provenance,
        namespace,
        rehydratedEvidence: null,
      };
      upsert(entry.pageId, record);
      optional.push(record);
      emitTrace({
        pageId: entry.pageId, route: 'symbol', matchedFields: ['symbols'],
        scoreClass: SCORE_CLASSES.symbol, score: null,
        reasonCode: 'retrieval-symbol-identity',
      });
    }
    if (hits === 0) {
      emitTrace({
        pageId: null, route: 'symbol', matchedFields: [],
        scoreClass: SCORE_CLASSES.symbol, score: null,
        reasonCode: 'retrieval-no-match',
      });
    }
  }

  // Route 5: deterministic lexical retrieval.
  const queryTokens = tokenizeTerms(input.lexicalTerms);
  if (queryTokens.length > 0) {
    const phrase = evidenceIndexV2.normalizeLexicalTextV2(input.lexicalTerms.join(' ')).trim();
    const scored = [];
    for (const entry of evidenceIndex.entries) {
      if (!inCandidates(entry.pageId)) continue;
      const scoredEntry = scoreLexicalEntry(queryTokens, phrase, entry);
      if (scoredEntry.score === 0) continue;
      scored.push({ entry, score: scoredEntry.score, matchedFields: scoredEntry.matchedFields, phrase: scoredEntry.phrase });
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.entry.pageId < b.entry.pageId ? -1 : a.entry.pageId > b.entry.pageId ? 1 : 0;
    });
    if (scored.length === 0) {
      emitTrace({
        pageId: null, route: 'lexical', matchedFields: [],
        scoreClass: SCORE_CLASSES.lexical, score: null,
        reasonCode: 'retrieval-no-match',
      });
    }
    for (const hit of scored) {
      const page = pagesById.get(hit.entry.pageId);
      const record = {
        pageId: hit.entry.pageId,
        evidenceId: null,
        contentHash: hit.entry.contentHash,
        route: 'lexical',
        scoreClass: SCORE_CLASSES.lexical,
        score: hit.score,
        matchedFields: Object.freeze(hit.matchedFields.slice()),
        provenance: page.provenance,
        namespace,
        rehydratedEvidence: null,
      };
      upsert(hit.entry.pageId, record);
      optional.push(record);
      emitTrace({
        pageId: hit.entry.pageId, route: 'lexical', matchedFields: hit.matchedFields.slice(),
        scoreClass: SCORE_CLASSES.lexical, score: hit.score,
        reasonCode: hit.phrase ? 'retrieval-lexical-phrase' : 'retrieval-lexical-token',
      });
    }
  } else if (input.lexicalTerms.length > 0) {
    emitTrace({
      pageId: null, route: 'lexical', matchedFields: [],
      scoreClass: SCORE_CLASSES.lexical, score: null,
      reasonCode: 'retrieval-no-match',
    });
  }

  // Final ordering: categorical route priority first; within the same
  // route, exact routes keep request order, file/symbol keep pageId
  // ascending, lexical keeps score desc then pageId ascending. limit
  // applies ONLY to optional (non-exact) results; exact obligations
  // are never truncated.
  const exactOut = [];
  const optionalOut = [];
  for (const record of merged.values()) {
    if (record.route === 'exact-evidence' || record.route === 'exact-page') exactOut.push(record);
    else optionalOut.push(record);
  }
  exactOut.sort((a, b) => ROUTE_PRIORITY[a.route] - ROUTE_PRIORITY[b.route]);
  optionalOut.sort((a, b) => {
    if (ROUTE_PRIORITY[a.route] !== ROUTE_PRIORITY[b.route]) return ROUTE_PRIORITY[a.route] - ROUTE_PRIORITY[b.route];
    if (a.route === 'lexical' && b.route === 'lexical' && a.score !== b.score) return b.score - a.score;
    return a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0;
  });
  const limitedOptional = optionalOut.slice(0, input.limit);
  const finalResults = exactOut.concat(limitedOptional).map((record) => Object.freeze({
    pageId: record.pageId,
    evidenceId: record.evidenceId,
    contentHash: record.contentHash,
    route: record.route,
    scoreClass: record.scoreClass,
    score: record.score,
    matchedFields: record.matchedFields,
    provenance: record.provenance,
    namespace,
    rehydratedEvidence: record.rehydratedEvidence,
    deterministic: true,
  }));

  const resultDigest = checkpointV2.sha256HexUtf8(JSON.stringify(checkpointV2.canonicalize({
    domain: RETRIEVAL_RESULT_DOMAIN_V1,
    namespace,
    results: finalResults.map((record) => ({
      pageId: record.pageId, evidenceId: record.evidenceId, contentHash: record.contentHash,
      route: record.route, scoreClass: record.scoreClass, score: record.score,
      matchedFields: record.matchedFields,
    })),
    errors: errors.map((entry) => ({ identity: entry.identity, route: entry.route, reason: entry.reason })),
    trace: trace.map((entry) => ({
      pageId: entry.pageId, route: entry.route, matchedFields: entry.matchedFields,
      scoreClass: entry.scoreClass, score: entry.score, reasonCode: entry.reasonCode,
    })),
  })));

  return Object.freeze({
    schemaVersion: RETRIEVAL_SCHEMA_VERSION,
    namespace: Object.freeze(namespace),
    results: Object.freeze(finalResults),
    errors: Object.freeze(errors),
    trace: Object.freeze(trace),
    resultDigest,
    deterministic: true,
  });
}

function matchFileQueryPrecheck(query, namespace) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return { invalid: true };
  if (unknownKeyOf(query, FILE_QUERY_EXACT_KEYS) !== null) return { invalid: true };
  if (normalizeFilePathV2(query.path) === null) return { invalid: true };
  if (query.contentHash !== undefined && query.contentHash !== null) {
    if (typeof query.contentHash !== 'string' || !HEX64_PATTERN.test(query.contentHash)) return { invalid: true };
  }
  if (query.repositoryId !== undefined && query.repositoryId !== null
      && !checkRepositoryScope(query.repositoryId, namespace)) {
    return { invalid: false, repositoryMismatch: true };
  }
  return { invalid: false };
}

function matchSymbolQueryPrecheck(query, namespace) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return { invalid: true };
  if (unknownKeyOf(query, SYMBOL_QUERY_EXACT_KEYS) !== null) return { invalid: true };
  if (typeof query.symbol !== 'string' || query.symbol === '' || query.symbol.length > 256) return { invalid: true };
  if (query.file !== undefined && query.file !== null && normalizeFilePathV2(query.file) === null) {
    return { invalid: true };
  }
  if (query.repositoryId !== undefined && query.repositoryId !== null
      && !checkRepositoryScope(query.repositoryId, namespace)) {
    return { invalid: false, repositoryMismatch: true };
  }
  return { invalid: false };
}

function tokenizeTerms(terms) {
  const seen = new Set();
  for (const term of terms) {
    for (const token of evidenceIndexV2.tokenizeLexicalV2(term)) seen.add(token);
  }
  return Array.from(seen).sort();
}

// ---- thin route conveniences (same authority, same semantics) ----
function retrieveExactEvidenceV2(request) {
  return retrieveContextEvidenceV2(Object.assign({}, request, {
    exactPageIds: [], fileIdentities: [], symbolIdentities: [], lexicalTerms: [],
  }));
}

function retrieveByFileIdentityV2(request) {
  return retrieveContextEvidenceV2(Object.assign({}, request, {
    exactEvidenceIds: [], exactPageIds: [], symbolIdentities: [], lexicalTerms: [],
  }));
}

function retrieveBySymbolIdentityV2(request) {
  return retrieveContextEvidenceV2(Object.assign({}, request, {
    exactEvidenceIds: [], exactPageIds: [], fileIdentities: [], lexicalTerms: [],
  }));
}

function retrieveLexicalEvidenceV2(request) {
  return retrieveContextEvidenceV2(Object.assign({}, request, {
    exactEvidenceIds: [], exactPageIds: [], fileIdentities: [], symbolIdentities: [],
  }));
}

// ---- result validation / description ----
function validateRetrievalResultV2(result) {
  const fail = (reason) => ({ valid: false, reason });
  if (!result || typeof result !== 'object' || Array.isArray(result)) return fail('retrieval-request-invalid');
  if (unknownKeyOf(result, RESULT_TOP_EXACT_KEYS) !== null) return fail('retrieval-request-invalid');
  if (Number(result.schemaVersion) !== RETRIEVAL_SCHEMA_VERSION) return fail('retrieval-request-invalid');
  if (result.deterministic !== true) return fail('retrieval-request-invalid');
  if (!Array.isArray(result.results) || !Array.isArray(result.errors) || !Array.isArray(result.trace)) {
    return fail('retrieval-request-invalid');
  }
  const seen = new Set();
  let lastPriority = 0;
  for (const entry of result.results) {
    if (!entry || typeof entry !== 'object') return fail('retrieval-request-invalid');
    if (unknownKeyOf(entry, RESULT_ENTRY_EXACT_KEYS) !== null) return fail('retrieval-request-invalid');
    if (typeof entry.pageId !== 'string' || !PAGE_ID_PATTERN.test(entry.pageId)) return fail('retrieval-request-invalid');
    if (seen.has(entry.pageId)) return fail('retrieval-request-invalid');
    seen.add(entry.pageId);
    if (!ROUTES.includes(entry.route)) return fail('retrieval-request-invalid');
    if (entry.scoreClass !== SCORE_CLASSES[entry.route]) return fail('retrieval-request-invalid');
    if (entry.route === 'lexical') {
      if (typeof entry.score !== 'number' || entry.score <= 0) return fail('retrieval-request-invalid');
    } else if (entry.score !== null) {
      return fail('retrieval-request-invalid');
    }
    if (!Array.isArray(entry.matchedFields)) return fail('retrieval-request-invalid');
    if (entry.deterministic !== true) return fail('retrieval-request-invalid');
    const priority = ROUTE_PRIORITY[entry.route];
    if (priority < lastPriority) return fail('retrieval-request-invalid');
    lastPriority = priority;
  }
  for (const entry of result.errors) {
    if (!entry || typeof entry !== 'object') return fail('retrieval-request-invalid');
    if (typeof entry.identity !== 'string' || typeof entry.reason !== 'string') return fail('retrieval-request-invalid');
  }
  for (const entry of result.trace) {
    if (!entry || typeof entry !== 'object') return fail('retrieval-request-invalid');
    if (typeof entry.reasonCode !== 'string' || !REASON_CODES.includes(entry.reasonCode)) {
      return fail('retrieval-request-invalid');
    }
  }
  const recomputed = checkpointV2.sha256HexUtf8(JSON.stringify(checkpointV2.canonicalize({
    domain: RETRIEVAL_RESULT_DOMAIN_V1,
    namespace: result.namespace,
    results: result.results.map((record) => ({
      pageId: record.pageId, evidenceId: record.evidenceId, contentHash: record.contentHash,
      route: record.route, scoreClass: record.scoreClass, score: record.score,
      matchedFields: record.matchedFields,
    })),
    errors: result.errors.map((entry) => ({ identity: entry.identity, route: entry.route, reason: entry.reason })),
    trace: result.trace.map((entry) => ({
      pageId: entry.pageId, route: entry.route, matchedFields: entry.matchedFields,
      scoreClass: entry.scoreClass, score: entry.score, reasonCode: entry.reasonCode,
    })),
  })));
  if (recomputed !== result.resultDigest) return fail('retrieval-request-invalid');
  return { valid: true, reason: null };
}

function describeRetrievalResultV2(result) {
  const check = validateRetrievalResultV2(result);
  if (!check.valid) failRetrieval(check.reason, 'cannot describe an invalid retrieval result');
  return Object.freeze({
    resultDigestPrefix: String(result.resultDigest).slice(0, 16),
    resultCount: result.results.length,
    errorCount: result.errors.length,
    traceCount: result.trace.length,
    routes: Object.freeze(result.results.map((entry) => entry.pageId + ':' + entry.route)),
    scores: Object.freeze(result.results.map((entry) => (entry.score === null ? 'null' : String(entry.score)))),
    contentHashPrefixes: Object.freeze(result.results.map((entry) => String(entry.contentHash).slice(0, 16))),
    errorReasons: Object.freeze(result.errors.map((entry) => entry.reason)),
    reasonCodes: Object.freeze(result.trace.map((entry) => entry.reasonCode)),
    deterministic: true,
  });
}

function canonicalizeRetrievalResultV2(result) {
  const check = validateRetrievalResultV2(result);
  if (!check.valid) failRetrieval(check.reason, 'cannot canonicalize an invalid retrieval result');
  return JSON.stringify(checkpointV2.canonicalize(JSON.parse(JSON.stringify(result))));
}

// ---- C02 compiler handoff (narrow adapter; C02 stays frozen) ----
function c02CandidatesToRetrievalRequestV2(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    failRetrieval('retrieval-request-invalid', 'handoff input is required');
  }
  const namespace = normalizeNamespace(input.namespace);
  const candidatePageIds = input.candidatePageIds === undefined || input.candidatePageIds === null
    ? [] : input.candidatePageIds;
  if (!Array.isArray(candidatePageIds)) failRetrieval('retrieval-request-invalid', 'candidatePageIds must be an array');
  for (const pageId of candidatePageIds) {
    if (typeof pageId !== 'string' || !PAGE_ID_PATTERN.test(pageId)) {
      failRetrieval('retrieval-request-invalid', 'candidate pageId is not an identity');
    }
  }
  return Object.freeze({
    namespace: Object.freeze(namespace),
    exactEvidenceIds: Object.freeze([]),
    exactPageIds: Object.freeze(candidatePageIds.slice()),
    fileIdentities: Object.freeze([]),
    symbolIdentities: Object.freeze([]),
    lexicalTerms: Object.freeze([]),
    candidatePageIds: Object.freeze(candidatePageIds.slice()),
    limit: Number.isInteger(input.limit) ? input.limit : 0,
    mode: 'identity-only',
  });
}

module.exports = {
  RETRIEVAL_SCHEMA_VERSION,
  ROUTE_PRIORITY,
  SCORE_CLASSES,
  LEXICAL_FIELD_WEIGHTS,
  LEXICAL_PHRASE_BONUS,
  REASON_CODES,
  RETRIEVAL_MODES,
  normalizeFilePathV2,
  validateRetrievalRequestV2,
  retrieveContextEvidenceV2,
  retrieveExactEvidenceV2,
  retrieveByFileIdentityV2,
  retrieveBySymbolIdentityV2,
  retrieveLexicalEvidenceV2,
  validateRetrievalResultV2,
  describeRetrievalResultV2,
  canonicalizeRetrievalResultV2,
  c02CandidatesToRetrievalRequestV2,
};
