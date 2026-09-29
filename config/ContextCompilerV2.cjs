'use strict';
/**
 * ContextCompilerV2.cjs - CCV2-C02 Deterministic Context Compiler production authority.
 *
 * ONE authority for deterministic compilation of frozen authoritative task
 * state plus already-known exact memory metadata into a validated C01
 * ContextView. C02 answers "what is mandatory / current / eligible for ONE
 * inference" and NOTHING else:
 *
 *   Durable Task Memory -> deterministic compiler -> disposable ContextView
 *
 * C02 owns: mandatory-state derivation, deterministic candidate
 * enumeration, deterministic candidate policy, and baseline ContextView
 * construction. C02 performs NO discovery: candidate enumeration operates
 * only over explicitly supplied validated task-memory inputs (checkpoint,
 * current turn, pages, tier decisions, evidence refs, already-supplied
 * exact material). C03 owns discovery and retrieval, C04 owns token
 * packing, C05 owns compression.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (C02 + C02H freeze records). Phase-A/B/C01 semantics are consumed
 * verbatim and never modified here.
 *
 * Open vs completed tool protocol (C02H, frozen): an OPEN/PENDING protocol
 * (call emitted, result not committed) is continuation-critical runtime
 * state and is NEVER rendered as a balanced completed transaction. No
 * synthetic resultPresent:true is ever produced: without an actual
 * matching result, compilation fails closed with
 * context-compiler-protocol-open and emits no view. A COMPLETED
 * transaction (call + matching result, call before result) materializes
 * only with an explicit caller-supplied matched binding whose seqs are
 * both inside the backing page's exact sourceSeqs and whose callId binds
 * the page protocol identity; wrong-result and result-before-call
 * bindings fail closed, mirroring frozen B03/A06 balance semantics
 * without resolving any session event (no reads, no discovery).
 *
 * Frozen formulas:
 *
 *   candidateId = 'ccx_' + sha256Hex(UTF-8(
 *     'nexus/context-compiler-candidate/v1' LF taskId LF taskInstanceId
 *     LF sessionId LF subjectKind LF sourceId LF tier LF pageId LF
 *     contentHash)).slice(0, 32)
 *
 *   planDigest = sha256Hex(UTF-8('nexus/context-compilation-plan/v1' LF
 *                canonicalJson(plan WITHOUT planDigest)))
 *
 * Purity: every export is deterministic and read-only. No clocks, no
 * randomness, no process identity, no filesystem reads, no mutation of
 * checkpoint / pages / decisions / evidence / store / session /
 * repository / canonical history. Identical validated inputs ->
 * byte-identical plan, trace, and ContextView across calls, restarts, and
 * independent OS processes.
 *
 * NOT implemented here (C03+): exact / lexical / file / symbol retrieval,
 * store reads, repository walks, semantic retrieval, rank-based ordering, token
 * packing, token allocation, compression, prompt rendering, provider
 * messages, advisory recommendations. This module never calls exact
 * rehydration entry points; it only validates an already-supplied B03
 * result object through the frozen B03 validator.
 */

const crypto = require('node:crypto');

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const trustV2 = require('./ContextTrustV2.cjs');
const pageV2 = require('./ContextPageV2.cjs');
const tierV2 = require('./ContextMemoryTierV2.cjs');
const rehydrationV2 = require('./ContextEvidenceRehydrationV2.cjs');
const viewV2 = require('./ContextViewV2.cjs');

// ---- frozen constants ----

const COMPILER_SCHEMA_VERSION = 1;
const COMPILER_POLICY_REVISION_V2 = 'context-compiler-v1';
const COMPILER_CANDIDATE_DOMAIN_V1 = 'nexus/context-compiler-candidate/v1';
const COMPILER_PLAN_DIGEST_DOMAIN_V1 = 'nexus/context-compilation-plan/v1';
const COMPILER_CANDIDATE_PREFIX = 'ccx_';

const COMPILE_INPUT_EXACT_KEYS = Object.freeze([
  'checkpoint',
  'currentTurn',
  'namespace',
  'snapshotRevision',
  'runtimeState',
  'pages',
  'tierDecisions',
  'evidenceRefs',
  'exactMaterial',
  'toolTransactions',
  'budget',
  'compilerPolicyRevision',
]);

const CURRENT_TURN_EXACT_KEYS = Object.freeze(['turnId', 'text', 'revision']);

const RUNTIME_STATE_EXACT_KEYS = Object.freeze(['pendingProtocol']);

// Pending/open runtime protocol identity (frozen A06 shape): the emitted
// call whose result is not committed. callSeq null means the dispatch
// start itself was never recorded (A06 call-open); a recorded callSeq
// with no result is result-pending. Both block model-facing compilation.
const PENDING_PROTOCOL_EXACT_KEYS = Object.freeze(['callId', 'callSeq']);

// Caller-supplied matched call/result binding for ONE tool-result page.
// The binding is matched-pair evidence, not discovery: both seqs must be
// inside the page's exact sourceSeqs, callSeq must precede resultSeq, and
// callId must bind the page protocol identity (frozen B03/A06 balance
// semantics, mirrored without resolving any session event).
const TOOL_TRANSACTION_EXACT_KEYS = Object.freeze(['pageId', 'callId', 'callSeq', 'resultSeq']);

const COMPILE_BUDGET_EXACT_KEYS = Object.freeze(['hardMax', 'target']);

const COMPILE_NAMESPACE_EXACT_KEYS = Object.freeze([
  'taskId',
  'taskInstanceId',
  'sessionId',
  'workspaceId',
  'repositoryId',
  'checkoutId',
]);

const EVIDENCE_REF_EXACT_KEYS = Object.freeze([
  'evidenceId',
  'pageId',
  'contentHash',
  'namespace',
]);

const EVIDENCE_REF_NAMESPACE_EXACT_KEYS = Object.freeze([
  'taskId',
  'taskInstanceId',
  'sessionId',
]);

const CANDIDATE_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'candidateId',
  'subjectKind',
  'sourceId',
  'tier',
  'mandatory',
  'contentHash',
  'pageId',
  'evidenceId',
  'provenance',
  'materializationState',
  'deterministicReasonCode',
  'deterministic',
]);

const PLAN_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'namespace',
  'checkpointBinding',
  'compilerPolicyRevision',
  'mandatoryRefs',
  'candidates',
  'decisions',
  'deterministic',
  'planDigest',
]);

// Closed-world candidate tiers. ARCHIVE appears only as an observability
// record (archive-only, never materialized, never referenced).
const CANDIDATE_TIERS = Object.freeze(['PINNED', 'HOT', 'WARM', 'COLD', 'ARCHIVE']);

const MATERIALIZATION_STATES = Object.freeze([
  'exact-available',
  'reference-only',
  'requires-retrieval',
  'archive-only',
]);

// Stable deterministic reason codes. Tests assert codes, not prose.
const COMPILER_REASON_CODES = Object.freeze([
  'compiler-pin-active-requirement',
  'compiler-pin-active-constraint',
  'compiler-pin-unresolved-approval',
  'compiler-pin-mandatory-state',
  'compiler-load-current-user',
  'compiler-load-active-failure',
  'compiler-load-immediate-transaction',
  'compiler-load-warm-decision',
  'compiler-load-verification',
  'compiler-load-failure-state',
  'compiler-load-warm-history',
  'compiler-load-cold-inline',
  'compiler-materialize-exact-cold',
  'compiler-reference-cold',
  'compiler-defer-retrieval',
  'compiler-archive-excluded',
]);

// C01-compatible trace actions for compiler decisions. Internal DEFER
// outcomes map deterministically onto SKIP (observability only: C01 never
// consults the trace for membership, so SKIP here records "not selected
// into this baseline view" and never means permanently discarded).
const TRACE_ACTION_FOR_REASON = Object.freeze({
  'compiler-pin-active-requirement': 'PIN',
  'compiler-pin-active-constraint': 'PIN',
  'compiler-pin-unresolved-approval': 'PIN',
  'compiler-pin-mandatory-state': 'PIN',
  'compiler-load-current-user': 'LOAD',
  'compiler-load-active-failure': 'LOAD',
  'compiler-load-immediate-transaction': 'LOAD',
  'compiler-load-warm-decision': 'LOAD',
  'compiler-load-verification': 'LOAD',
  'compiler-load-failure-state': 'LOAD',
  'compiler-load-warm-history': 'LOAD',
  'compiler-load-cold-inline': 'LOAD',
  'compiler-materialize-exact-cold': 'LOAD',
  'compiler-reference-cold': 'REFERENCE',
  'compiler-defer-retrieval': 'SKIP',
  'compiler-archive-excluded': 'SKIP',
});

// Caller-supplied advisory / scoring / authority-claim fields are never
// normalized into a valid compile: they fail closed as unknown input.
const REJECTED_INPUT_KEYS = Object.freeze([
  'score',
  'priorityScore',
  'relevanceScore',
  'confidence',
  'embeddingSimilarity',
  'embedding',
  'embeddings',
  'llmPriority',
  'forcePinned',
  'authority',
  'provider',
  'ranking',
  'topK',
  'query',
  'used',
]);

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const PAGE_ID_PATTERN = /^cxp_[0-9a-f]{32}$/;
const CANDIDATE_ID_PATTERN = /^ccx_[0-9a-f]{32}$/;

// External exact-resolution modes (frozen B03H taxonomy): materialization
// requires a fresh supplied B03 result; the old B04 proof never suffices.
const EXTERNAL_RESOLUTION_MODES = Object.freeze([
  'exact-session-source',
  'exact-repository-source',
  'exact-artifact-source',
]);

// ---- failures ----

function failCompiler(code, detail) {
  throw new Error('context-compiler-' + code + (detail === undefined ? '' : ': ' + detail) + ' (KEEP)');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownKeyOf(value, allowedKeys) {
  if (!isPlainObject(value)) return null;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) return key;
  }
  return null;
}

function rejectScoringKeys(value, what) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (REJECTED_INPUT_KEYS.includes(key)) {
      failCompiler('input-invalid', what + ' carries rejected field ' + key);
    }
  }
}

function sha256HexUtf8(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isBoundedString(value, max, allowEmpty) {
  if (typeof value !== 'string') return false;
  if (!allowEmpty && value === '') return false;
  return value.length <= max;
}

// ---- namespace ----

function validateCompileNamespace(namespace) {
  if (!isPlainObject(namespace)) failCompiler('input-invalid', 'namespace must be an object');
  const unknown = unknownKeyOf(namespace, COMPILE_NAMESPACE_EXACT_KEYS);
  if (unknown !== null) failCompiler('input-invalid', 'namespace.' + unknown);
  rejectScoringKeys(namespace, 'namespace');
  for (const key of ['taskId', 'taskInstanceId', 'sessionId', 'workspaceId']) {
    if (!isBoundedString(namespace[key], 512, false)) {
      failCompiler('input-invalid', 'namespace.' + key + ' is required');
    }
  }
  for (const key of ['repositoryId', 'checkoutId']) {
    const value = namespace[key];
    if (value !== null && value !== undefined && !isBoundedString(String(value), 512, true)) {
      failCompiler('input-invalid', 'namespace.' + key + ' is invalid');
    }
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

function assertTripleMatches(expected, triple, what) {
  if (!isPlainObject(triple)) failCompiler('namespace-mismatch', what + ' namespace must be an object');
  for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
    if (triple[key] !== expected[key]) {
      failCompiler('namespace-mismatch', what + ' escapes the compile namespace');
    }
  }
}

// ---- input validation (closed world, no discovery) ----

function validateCurrentTurn(currentTurn) {
  if (currentTurn === null || currentTurn === undefined) return null;
  if (!isPlainObject(currentTurn)) failCompiler('input-invalid', 'currentTurn must be an object or null');
  const unknown = unknownKeyOf(currentTurn, CURRENT_TURN_EXACT_KEYS);
  if (unknown !== null) failCompiler('input-invalid', 'currentTurn.' + unknown);
  rejectScoringKeys(currentTurn, 'currentTurn');
  if (!isBoundedString(currentTurn.turnId, 256, false)) {
    failCompiler('input-invalid', 'currentTurn.turnId is required');
  }
  if (typeof currentTurn.text !== 'string' || currentTurn.text === '') {
    failCompiler('input-invalid', 'currentTurn.text is required');
  }
  // CCV2-R1: the current turn is bounded by the C01 exact-text bound (a
  // real turn may exceed the old 8192-char fixture bound; it materializes
  // exactly or the compile fails closed, never truncated).
  if (currentTurn.text.length > viewV2.VIEW_BOUNDS.exactTextMaxChars) {
    failCompiler('input-invalid', 'currentTurn.text exceeds the exact-text bound');
  }
  const revision = currentTurn.revision === undefined ? null : currentTurn.revision;
  if (revision !== null && !isBoundedString(String(revision), 256, false)) {
    failCompiler('input-invalid', 'currentTurn.revision is invalid');
  }
  return { turnId: currentTurn.turnId, text: currentTurn.text, revision };
}

function validateRuntimeState(runtimeState) {
  if (runtimeState === null || runtimeState === undefined) return { pendingProtocol: null };
  if (!isPlainObject(runtimeState)) failCompiler('input-invalid', 'runtimeState must be an object or null');
  const unknown = unknownKeyOf(runtimeState, RUNTIME_STATE_EXACT_KEYS);
  if (unknown !== null) failCompiler('input-invalid', 'runtimeState.' + unknown);
  rejectScoringKeys(runtimeState, 'runtimeState');
  const pending = runtimeState.pendingProtocol === undefined ? null : runtimeState.pendingProtocol;
  if (pending === null) return { pendingProtocol: null };
  if (!isPlainObject(pending)) failCompiler('input-invalid', 'runtimeState.pendingProtocol must be an object or null');
  const unknownPending = unknownKeyOf(pending, PENDING_PROTOCOL_EXACT_KEYS);
  if (unknownPending !== null) failCompiler('input-invalid', 'runtimeState.pendingProtocol.' + unknownPending);
  rejectScoringKeys(pending, 'runtimeState.pendingProtocol');
  if (!isBoundedString(pending.callId, 256, false)) {
    failCompiler('input-invalid', 'runtimeState.pendingProtocol.callId is required');
  }
  const callSeq = pending.callSeq === undefined ? null : pending.callSeq;
  if (callSeq !== null && (!Number.isInteger(callSeq) || callSeq < 0)) {
    failCompiler('input-invalid', 'runtimeState.pendingProtocol.callSeq must be a non-negative integer or null');
  }
  return { pendingProtocol: { callId: pending.callId, callSeq } };
}

// An unmatched tool call blocks model-facing compilation (frozen A06:
// a request without a result is an open edge, never a boundary). The
// pending call is mandatory runtime state for continuation, but it is
// NOT materializable: emitting a balanced unit for it would fabricate a
// result. Callers retry at a legal boundary once the result commits.
function failIfPendingProtocol(input) {
  if (input.runtimeState.pendingProtocol !== null) {
    failCompiler('protocol-open', 'tool call ' + input.runtimeState.pendingProtocol.callId
      + ' has no committed result; no inference boundary is legal');
  }
}

// Page protocol identity from frozen provenance (tool-event:<callId> refs
// carried by tool pages). A hint for cross-checking caller bindings,
// never balance proof by itself.
function pageToolCallRef(page) {
  const held = page.provenance === null || page.provenance === undefined ? null : page.provenance.sourceRefs;
  const refs = Array.isArray(held) ? held : [];
  for (const ref of refs) {
    if (typeof ref === 'string' && ref.indexOf('tool-event:') === 0 && ref.length > 11) {
      return ref.slice(11);
    }
  }
  return null;
}

// Validate caller-supplied matched call/result bindings against the exact
// backing of known pages (frozen B03/A06 balance mirrored, no reads):
// the page must be a known tool-result page, both seqs must be inside
// the page's exact sourceSeqs, callSeq must precede resultSeq, and callId
// must bind the page protocol identity. Wrong-result and
// result-before-call bindings fail closed with protocol-open.
function validateToolTransactions(bindings, pages) {
  if (bindings === null || bindings === undefined) return [];
  if (!Array.isArray(bindings)) failCompiler('input-invalid', 'toolTransactions must be an array');
  const byPageId = new Map(pages.map((page) => [page.id, page]));
  const seen = new Map();
  const out = [];
  for (const binding of bindings) {
    if (!isPlainObject(binding)) failCompiler('input-invalid', 'toolTransaction binding must be an object');
    const unknown = unknownKeyOf(binding, TOOL_TRANSACTION_EXACT_KEYS);
    if (unknown !== null) failCompiler('input-invalid', 'toolTransaction.' + unknown);
    rejectScoringKeys(binding, 'toolTransaction');
    if (typeof binding.pageId !== 'string' || !PAGE_ID_PATTERN.test(binding.pageId)) {
      failCompiler('input-invalid', 'toolTransaction.pageId is invalid');
    }
    const page = byPageId.get(binding.pageId);
    if (page === undefined) failCompiler('input-invalid', 'toolTransaction binds an unknown page: ' + binding.pageId);
    if (page.kind !== 'tool-result') {
      failCompiler('protocol-open', 'toolTransaction binds a non-transaction page: ' + binding.pageId);
    }
    if (!isBoundedString(binding.callId, 256, false)) {
      failCompiler('input-invalid', 'toolTransaction.callId is required');
    }
    if (!Number.isInteger(binding.callSeq) || binding.callSeq < 0
      || !Number.isInteger(binding.resultSeq) || binding.resultSeq < 0) {
      failCompiler('input-invalid', 'toolTransaction seqs must be non-negative integers');
    }
    const ref = pageToolCallRef(page);
    if (ref !== null && binding.callId !== ref) {
      failCompiler('protocol-open', 'toolTransaction callId binds another call for ' + binding.pageId);
    }
    const seqs = Array.isArray(page.sourceSeqs) ? page.sourceSeqs : [];
    if (seqs.indexOf(binding.callSeq) === -1 || seqs.indexOf(binding.resultSeq) === -1) {
      failCompiler('protocol-open', 'toolTransaction seqs escape the page exact backing for ' + binding.pageId);
    }
    if (!(binding.callSeq < binding.resultSeq)) {
      failCompiler('protocol-open', 'toolTransaction result does not follow its call for ' + binding.pageId);
    }
    const prior = seen.get(binding.pageId);
    if (prior !== undefined) {
      if (prior.callId !== binding.callId || prior.callSeq !== binding.callSeq || prior.resultSeq !== binding.resultSeq) {
        failCompiler('content-conflict', 'conflicting toolTransaction bindings for ' + binding.pageId);
      }
      continue;
    }
    seen.set(binding.pageId, { callId: binding.callId, callSeq: binding.callSeq, resultSeq: binding.resultSeq });
    out.push({ pageId: binding.pageId, callId: binding.callId, callSeq: binding.callSeq, resultSeq: binding.resultSeq });
  }
  return out;
}

function validateBudget(budget) {
  if (!isPlainObject(budget)) failCompiler('input-invalid', 'budget must be an object');
  const unknown = unknownKeyOf(budget, COMPILE_BUDGET_EXACT_KEYS);
  if (unknown !== null) failCompiler('input-invalid', 'budget.' + unknown);
  rejectScoringKeys(budget, 'budget');
  if (!Number.isInteger(budget.hardMax) || budget.hardMax < 1 || budget.hardMax > 10000000) {
    failCompiler('input-invalid', 'budget.hardMax is invalid');
  }
  if (!Number.isInteger(budget.target) || budget.target < 0 || budget.target > budget.hardMax) {
    failCompiler('input-invalid', 'budget.target must not exceed hardMax');
  }
  return { hardMax: budget.hardMax, target: budget.target, used: null };
}

function validateEvidenceRefs(evidenceRefs, expected) {
  if (evidenceRefs === null || evidenceRefs === undefined) return [];
  if (!Array.isArray(evidenceRefs)) failCompiler('input-invalid', 'evidenceRefs must be an array');
  const out = [];
  for (const ref of evidenceRefs) {
    if (!isPlainObject(ref)) failCompiler('input-invalid', 'evidenceRef must be an object');
    const unknown = unknownKeyOf(ref, EVIDENCE_REF_EXACT_KEYS);
    if (unknown !== null) failCompiler('input-invalid', 'evidenceRef.' + unknown);
    rejectScoringKeys(ref, 'evidenceRef');
    if (!isBoundedString(ref.evidenceId, 512, false)) {
      failCompiler('input-invalid', 'evidenceRef.evidenceId is required');
    }
    const pageId = ref.pageId === undefined ? null : ref.pageId;
    if (pageId !== null && (typeof pageId !== 'string' || !PAGE_ID_PATTERN.test(pageId))) {
      failCompiler('input-invalid', 'evidenceRef.pageId is invalid');
    }
    const contentHash = ref.contentHash === undefined ? null : ref.contentHash;
    if (contentHash !== null && (typeof contentHash !== 'string' || !CONTENT_HASH_PATTERN.test(contentHash))) {
      failCompiler('input-invalid', 'evidenceRef.contentHash is invalid');
    }
    if (!isPlainObject(ref.namespace)) failCompiler('namespace-mismatch', 'evidenceRef carries no namespace');
    const nsUnknown = unknownKeyOf(ref.namespace, EVIDENCE_REF_NAMESPACE_EXACT_KEYS);
    if (nsUnknown !== null) failCompiler('input-invalid', 'evidenceRef.namespace.' + nsUnknown);
    assertTripleMatches(expected, ref.namespace, 'evidenceRef');
    out.push({
      evidenceId: ref.evidenceId,
      pageId,
      contentHash,
      namespace: {
        taskId: ref.namespace.taskId,
        taskInstanceId: ref.namespace.taskInstanceId,
        sessionId: ref.namespace.sessionId,
      },
    });
  }
  return out;
}

function validatePages(pages, expected) {
  if (!Array.isArray(pages)) failCompiler('input-invalid', 'pages must be an explicit array');
  const out = [];
  for (const page of pages) {
    const check = pageV2.validateContextPageV2(page);
    if (!check.valid) failCompiler('input-invalid', 'page failed validation: ' + (check.reasonCode || check.reason));
    assertTripleMatches(expected, page.namespace, 'page ' + page.id);
    out.push(page);
  }
  return out;
}

function validateTierDecisions(decisions, expected) {
  if (!Array.isArray(decisions)) failCompiler('input-invalid', 'tierDecisions must be an explicit array');
  const out = [];
  for (const decision of decisions) {
    rejectScoringKeys(decision, 'tierDecision');
    const check = tierV2.validateMemoryTierDecisionV2(decision);
    if (!check.valid) failCompiler('input-invalid', 'tier decision failed validation: ' + check.reasonCode);
    if (decision.namespace !== null && decision.namespace !== undefined) {
      assertTripleMatches(expected, decision.namespace, 'tier decision');
    }
    out.push(decision);
  }
  return out;
}

// The caller supplies already-known B03 results only. Validation here is
// structural proof checking through the frozen B03 validator (brand,
// verified flag, content-hash agreement, recomputed resultDigest); no
// rehydration entry point is ever invoked.
function validateExactMaterial(exactMaterial, expected) {
  if (exactMaterial === null || exactMaterial === undefined) return [];
  if (!Array.isArray(exactMaterial)) failCompiler('input-invalid', 'exactMaterial must be an array');
  const out = [];
  for (const result of exactMaterial) {
    let check = null;
    try {
      check = rehydrationV2.validateRehydratedEvidenceV2(result);
    } catch (error) {
      failCompiler('evidence-binding-mismatch', 'exact material failed B03 validation');
    }
    if (!check || !check.valid) {
      failCompiler('evidence-binding-mismatch', 'exact material failed B03 validation');
    }
    assertTripleMatches(expected, result.namespace, 'exact material ' + result.pageId);
    out.push(result);
  }
  return out;
}

function validateCheckpoint(checkpoint, expected, snapshotRevision) {
  if (!isPlainObject(checkpoint)) failCompiler('input-invalid', 'checkpoint must be an object');
  const check = checkpointV2.validateCheckpointV2(checkpoint);
  if (!check.valid) {
    failCompiler('input-invalid', 'checkpoint failed validation: ' + (check.reasonCode || check.reason));
  }
  assertTripleMatches(expected, checkpoint, 'checkpoint');
  const slot = checkpoint.snapshot === undefined ? null : checkpoint.snapshot;
  const revision = slot === null ? null : slot.revisionDigest;
  if (snapshotRevision !== (revision === undefined ? null : revision)) {
    failCompiler('snapshot-mismatch', 'snapshotRevision does not match the checkpoint snapshot slot');
  }
  return checkpoint;
}

// ---- deterministic rendering (stable, bounded, schema-aware) ----

function renderRequirementText(req) {
  return 'requirement ' + req.id + ' [active]: ' + req.text;
}

function renderConstraintText(constraint) {
  return 'constraint ' + constraint.type + ': ' + constraint.text;
}

function renderApprovalText(question, index) {
  return 'unresolved-approval [' + index + ']: ' + question;
}

function renderObjectiveText(checkpoint) {
  return 'objective [' + checkpoint.objective.status + ']: ' + checkpoint.objective.text;
}

function renderFailureText(failure) {
  const detail = failure.detail === null || failure.detail === undefined ? '' : failure.detail;
  const attempt = failure.attemptCount === null || failure.attemptCount === undefined
    ? 'unknown'
    : String(failure.attemptCount);
  return 'failure ' + failure.id + ' [open]: ' + detail + ' (attempt ' + attempt + ')';
}

function renderDecisionText(decision) {
  return 'decision ' + decision.id + ' [active]: ' + decision.statement;
}

function renderVerificationText(outcome) {
  const detail = outcome.detail === null || outcome.detail === undefined ? '' : outcome.detail;
  return 'verification ' + outcome.scope + ' [' + outcome.status + ']: ' + detail;
}

function renderFailureStateText(checkpoint) {
  const rejected = checkpoint.failures.rejectedHypotheses.length;
  const retry = checkpoint.failures.retryState === null || checkpoint.failures.retryState === undefined
    ? 'none'
    : String(checkpoint.failures.retryState.note === null
      || checkpoint.failures.retryState.note === undefined
      ? 'retry-armed'
      : checkpoint.failures.retryState.note);
  return 'failure-state: rejected-hypotheses=' + rejected + ' retry=' + retry;
}

// ---- provenance constructors (frozen A04 legality) ----

function provenanceOf(sourceKind, trust, sourceRefs, fieldKind) {
  const entry = {
    schemaVersion: 1,
    sourceKind,
    trust,
    sourceRefs: sourceRefs.slice(),
    authorityScope: 'task',
    fieldKind,
  };
  const structural = trustV2.validateTrustProvenance(entry);
  if (!structural.valid) failCompiler('input-invalid', 'compiler provenance failed structural validation');
  const authority = trustV2.validateProvenanceAuthority(entry, fieldKind);
  if (!authority.valid) failCompiler('input-invalid', 'compiler provenance failed authority legality');
  return entry;
}

// ---- candidate identity ----

function deriveCandidateIdV2(expected, subjectKind, sourceId, tier, pageId, contentHash) {
  const joined = [
    COMPILER_CANDIDATE_DOMAIN_V1,
    expected.taskId,
    expected.taskInstanceId,
    expected.sessionId,
    subjectKind,
    sourceId,
    tier,
    pageId === null || pageId === undefined ? '-' : pageId,
    contentHash === null || contentHash === undefined ? '-' : contentHash,
  ].join('\n');
  return COMPILER_CANDIDATE_PREFIX + sha256HexUtf8(joined).slice(0, 32);
}

function makeCandidate(expected, fields) {
  if (!tierV2.SUBJECT_KINDS.includes(fields.subjectKind)) {
    failCompiler('input-invalid', 'unknown candidate subject ' + String(fields.subjectKind));
  }
  if (!CANDIDATE_TIERS.includes(fields.tier)) failCompiler('tier-conflict', 'unknown candidate tier');
  if (!MATERIALIZATION_STATES.includes(fields.materializationState)) {
    failCompiler('input-invalid', 'unknown materialization state');
  }
  if (!COMPILER_REASON_CODES.includes(fields.deterministicReasonCode)) {
    failCompiler('policy-invalid', 'unknown compiler reason code');
  }
  if (typeof fields.sourceId !== 'string' || fields.sourceId === '') {
    failCompiler('input-invalid', 'candidate sourceId is required');
  }
  const contentHash = fields.contentHash === undefined ? null : fields.contentHash;
  if (contentHash !== null && (typeof contentHash !== 'string' || !CONTENT_HASH_PATTERN.test(contentHash))) {
    failCompiler('content-conflict', 'candidate contentHash is invalid for ' + fields.sourceId);
  }
  const pageId = fields.pageId === undefined ? null : fields.pageId;
  if (pageId !== null && (typeof pageId !== 'string' || !PAGE_ID_PATTERN.test(pageId))) {
    failCompiler('input-invalid', 'candidate pageId is invalid for ' + fields.sourceId);
  }
  const candidate = {
    schemaVersion: COMPILER_SCHEMA_VERSION,
    candidateId: deriveCandidateIdV2(
      expected, fields.subjectKind, fields.sourceId, fields.tier, pageId, contentHash,
    ),
    subjectKind: fields.subjectKind,
    sourceId: fields.sourceId,
    tier: fields.tier,
    mandatory: fields.mandatory === true,
    contentHash,
    pageId,
    evidenceId: fields.evidenceId === undefined ? null : fields.evidenceId,
    provenance: deepClone(fields.provenance),
    materializationState: fields.materializationState,
    deterministicReasonCode: fields.deterministicReasonCode,
    deterministic: true,
  };
  if (candidate.tier === 'PINNED' && candidate.mandatory !== true) {
    failCompiler('mandatory-conflict', 'PINNED candidate must be mandatory: ' + fields.sourceId);
  }
  return Object.freeze(candidate);
}

// ---- decision indexing (conflict detection over supplied decisions) ----

function indexTierDecisions(decisions) {
  const bySubject = new Map();
  const byPage = new Map();
  for (const decision of decisions) {
    if (decision.pageId === null || decision.pageId === undefined) {
      const prior = bySubject.get(decision.subjectKind);
      if (prior !== undefined && prior.tier !== decision.tier) {
        failCompiler('tier-conflict', 'conflicting tiers for subject ' + decision.subjectKind);
      }
      if (prior === undefined) bySubject.set(decision.subjectKind, decision);
    } else {
      const prior = byPage.get(decision.pageId);
      if (prior !== undefined) {
        if (prior.tier !== decision.tier) {
          failCompiler('tier-conflict', 'conflicting tiers for page ' + decision.pageId);
        }
        if (prior.contentHash !== decision.contentHash) {
          failCompiler('content-conflict', 'conflicting contentHash for page ' + decision.pageId);
        }
      } else {
        byPage.set(decision.pageId, decision);
      }
    }
  }
  return { bySubject, byPage };
}

function requireStateDecision(bySubject, subjectKind, sourceId) {
  const decision = bySubject.get(subjectKind);
  if (decision === undefined) {
    failCompiler('mandatory-conflict', 'no B04 decision supplied for mandatory subject ' + subjectKind);
  }
  if (decision.tier === 'ARCHIVE') failCompiler('mandatory-conflict', 'mandatory subject archived: ' + sourceId);
  return decision;
}

function requireWarmDecision(bySubject, subjectKind, sourceId) {
  const decision = bySubject.get(subjectKind);
  if (decision === undefined) {
    failCompiler('input-invalid', 'no B04 decision supplied for known state ' + subjectKind);
  }
  if (decision.tier === 'ARCHIVE') failCompiler('input-invalid', 'state subject archived: ' + sourceId);
  return decision;
}

// ---- candidate enumeration (closed world: supplied inputs only) ----

function enumeratePinnedCandidates(enumerated, input, decisions) {
  const checkpoint = input.checkpoint;
  const out = [];
  const activeReqs = checkpoint.requirements.filter((req) => req.status === 'active');
  for (const req of activeReqs) {
    const text = renderRequirementText(req);
    const sourceId = 'checkpoint:requirement:' + req.id;
    const decision = requireStateDecision(decisions.bySubject, 'active-requirement', sourceId);
    if (decision.tier !== 'PINNED') {
      failCompiler('tier-conflict', 'active requirement tier is ' + decision.tier + ', not PINNED');
    }
    out.push(makeCandidate(input.namespace, {
      subjectKind: 'active-requirement',
      sourceId,
      tier: 'PINNED',
      mandatory: true,
      contentHash: sha256HexUtf8(text),
      provenance: provenanceOf('controller', 'authoritative', ['user:' + req.id], 'requirement-text'),
      materializationState: 'exact-available',
      deterministicReasonCode: 'compiler-pin-active-requirement',
    }));
  }
  checkpoint.constraints.forEach((constraint, index) => {
    const text = renderConstraintText(constraint);
    const sourceId = 'checkpoint:constraint:' + index;
    const decision = requireStateDecision(decisions.bySubject, 'active-constraint', sourceId);
    if (decision.tier !== 'PINNED') {
      failCompiler('tier-conflict', 'active constraint tier is ' + decision.tier + ', not PINNED');
    }
    out.push(makeCandidate(input.namespace, {
      subjectKind: 'active-constraint',
      sourceId,
      tier: 'PINNED',
      mandatory: true,
      contentHash: sha256HexUtf8(text),
      provenance: provenanceOf('controller', 'authoritative', ['policy:' + constraint.type], 'constraint-text'),
      materializationState: 'exact-available',
      deterministicReasonCode: 'compiler-pin-active-constraint',
    }));
  });
  checkpoint.continuation.unresolvedQuestions.forEach((question, index) => {
    const text = renderApprovalText(String(question), index);
    const sourceId = 'checkpoint:approval:' + index;
    const decision = requireStateDecision(decisions.bySubject, 'unresolved-approval', sourceId);
    if (decision.tier !== 'PINNED') {
      failCompiler('tier-conflict', 'unresolved approval tier is ' + decision.tier + ', not PINNED');
    }
    out.push(makeCandidate(input.namespace, {
      subjectKind: 'unresolved-approval',
      sourceId,
      tier: 'PINNED',
      mandatory: true,
      contentHash: sha256HexUtf8(text),
      provenance: provenanceOf('controller', 'authoritative', ['user:approval:' + index], 'unresolved-question'),
      materializationState: 'exact-available',
      deterministicReasonCode: 'compiler-pin-unresolved-approval',
    }));
  });
  {
    const text = renderObjectiveText(checkpoint);
    const sourceId = 'checkpoint:objective';
    const decision = requireStateDecision(decisions.bySubject, 'mandatory-checkpoint-state', sourceId);
    if (decision.tier !== 'PINNED') {
      failCompiler('tier-conflict', 'mandatory checkpoint state tier is ' + decision.tier + ', not PINNED');
    }
    out.push(makeCandidate(input.namespace, {
      subjectKind: 'mandatory-checkpoint-state',
      sourceId,
      tier: 'PINNED',
      mandatory: true,
      contentHash: sha256HexUtf8(text),
      provenance: provenanceOf('controller', 'authoritative', ['controller:objective'], 'task-objective'),
      materializationState: 'exact-available',
      deterministicReasonCode: 'compiler-pin-mandatory-state',
    }));
  }
  // Open/pending protocol is never enumerated: failIfPendingProtocol (in
  // validated-input assembly) already failed the compilation closed before
  // any candidate existed. A supplied B04 open-tool-protocol decision is
  // acknowledged as mandatory continuation state but is not renderable as
  // a balanced transaction, so it yields no candidate and no mandatory
  // ref. Pending protocol therefore can never reach the baseline view.
  for (const candidate of out) enumerated.push(candidate);
}

function enumerateHotCandidates(enumerated, input, decisions) {
  if (input.currentTurn === null) {
    const intent = decisions.bySubject.get('current-user-turn');
    if (intent !== undefined && intent.materializationIntent === 'mandatory') {
      failCompiler('mandatory-conflict', 'mandatory current user turn supplied no exact turn');
    }
  }
  if (input.currentTurn !== null) {
    const turn = input.currentTurn;
    const sourceId = 'current-turn:' + turn.turnId;
    const decision = requireWarmDecision(decisions.bySubject, 'current-user-turn', sourceId);
    if (decision.tier !== 'HOT') {
      failCompiler('tier-conflict', 'current user turn tier is ' + decision.tier + ', not HOT');
    }
    const mandatory = decision.materializationIntent === 'mandatory';
    enumerated.push(makeCandidate(input.namespace, {
      subjectKind: 'current-user-turn',
      sourceId,
      tier: 'HOT',
      mandatory,
      contentHash: sha256HexUtf8(turn.text),
      provenance: provenanceOf('user', 'user-intent', ['session-event:' + turn.turnId], 'user-intent'),
      materializationState: 'exact-available',
      deterministicReasonCode: 'compiler-load-current-user',
    }));
  }
  for (const failure of input.checkpoint.failures.activeFailures) {
    const text = renderFailureText(failure);
    const sourceId = 'checkpoint:failure:' + failure.id;
    const decision = requireWarmDecision(decisions.bySubject, 'active-failure', sourceId);
    if (decision.tier !== 'HOT') {
      failCompiler('tier-conflict', 'active failure tier is ' + decision.tier + ', not HOT');
    }
    enumerated.push(makeCandidate(input.namespace, {
      subjectKind: 'active-failure',
      sourceId,
      tier: 'HOT',
      mandatory: false,
      contentHash: sha256HexUtf8(text),
      provenance: provenanceOf('controller', 'authoritative', ['controller:' + failure.id], 'failure-detail'),
      materializationState: 'exact-available',
      deterministicReasonCode: 'compiler-load-active-failure',
    }));
  }
}

function pageBytesAvailable(page) {
  if (page.exactText === null || page.exactText === undefined) return false;
  if (typeof page.exactText !== 'string' || page.exactText === '') return false;
  if (page.exactText.length > 8192) return false;
  return sha256HexUtf8(page.exactText) === page.contentHash;
}

function findProofForPage(exactMaterial, page) {
  return exactMaterial.filter((result) => result.pageId === page.id);
}

// CCV2-R1 (WARM_EXACT / HOT blob bytes): a HOT/WARM page whose exact bytes
// live behind its durable exactBlobRef materializes only from a supplied,
// live B03 blob-route result bound to this page, content revision,
// namespace, and provenance. Anything less fails closed.
function blobProofForPage(exactMaterial, page, expected) {
  if (page.exactBlobRef === null || page.exactBlobRef === undefined) return null;
  const proofs = findProofForPage(exactMaterial, page).filter((proof) => proof.sourceRoute === 'blob');
  if (proofs.length === 0) return null;
  const proof = proofs[0];
  if (proof.contentHash !== page.contentHash) {
    failCompiler('evidence-binding-mismatch', 'blob proof binds another content revision for ' + page.id);
  }
  if (proof.sourceIdentity !== page.exactBlobRef) {
    failCompiler('evidence-binding-mismatch', 'blob proof names another blob for ' + page.id);
  }
  if (proof.mediaType !== 'text' || typeof proof.exactText !== 'string' || proof.exactText === '') {
    failCompiler('evidence-binding-mismatch', 'binary blob proof cannot materialize model-facing text for ' + page.id);
  }
  if (sha256HexUtf8(proof.exactText) !== page.contentHash) {
    failCompiler('evidence-binding-mismatch', 'blob proof bytes disagree with page content for ' + page.id);
  }
  if (!isPlainObject(proof.provenance)
    || canonicalJsonOf(proof.provenance) !== canonicalJsonOf(page.provenance)) {
    failCompiler('evidence-binding-mismatch', 'blob proof provenance drifted for ' + page.id);
  }
  assertTripleMatches(expected, proof.namespace, 'blob proof ' + page.id);
  return proof;
}

function exactBytesAvailableFor(input, page) {
  if (pageBytesAvailable(page)) return true;
  return blobProofForPage(input.exactMaterial, page, input.namespace) !== null;
}

// Set-like page candidates sort by stable page identity (frozen C02).
// CCV2-R1: retention-required pages are structural conversation/tool
// history and enumerate FIRST in canonical source order (first session
// seq, then page id): seqs are part of page identity, so no caller input
// order leaks. Legacy (non-required) pages keep the frozen page-id order.
function requiredPageIdsOf(input) {
  return new Set(input.tierDecisions
    .filter((decision) => decision.retentionRequired === true && typeof decision.pageId === 'string')
    .map((decision) => decision.pageId));
}

function pagesInEnumerationOrder(input) {
  const requiredPageIds = requiredPageIdsOf(input);
  const firstSeqOf = (page) => (Array.isArray(page.sourceSeqs) && page.sourceSeqs.length > 0
    ? page.sourceSeqs[0] : Number.MAX_SAFE_INTEGER);
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const requiredPages = input.pages.filter((page) => requiredPageIds.has(page.id))
    .sort((a, b) => (firstSeqOf(a) - firstSeqOf(b)) || byId(a, b));
  const otherPages = input.pages.filter((page) => !requiredPageIds.has(page.id)).sort(byId);
  return requiredPages.concat(otherPages);
}

function enumeratePageCandidate(enumerated, input, decisions, page) {
  const decision = decisions.byPage.get(page.id);
  if (decision === undefined) {
    failCompiler('input-invalid', 'no B04 decision supplied for known page ' + page.id);
  }
  if (decision.contentHash !== page.contentHash) {
    failCompiler('content-conflict', 'tier decision binds another content revision for ' + page.id);
  }
  if (decision.tier === 'ARCHIVE') {
    enumerated.push(makeCandidate(input.namespace, {
      subjectKind: decision.subjectKind,
      sourceId: page.id,
      tier: 'ARCHIVE',
      mandatory: false,
      contentHash: page.contentHash,
      pageId: page.id,
      provenance: deepClone(page.provenance),
      materializationState: 'archive-only',
      deterministicReasonCode: 'compiler-archive-excluded',
    }));
    return;
  }
  if (decision.tier === 'PINNED') {
    failCompiler('tier-conflict', 'page-backed subject must not claim PINNED: ' + page.id);
  }
  // A protocol-subject page is materializable only with an explicit
  // matched call/result binding (validated against the page exact
  // backing in validated-input assembly). Seq count alone never balances:
  // without a binding the candidate cannot exist, so plan construction
  // fails here rather than view construction later.
  if (decision.subjectKind === 'completed-tool-transaction'
    && !input.toolTransactions.some((binding) => binding.pageId === page.id)) {
    failCompiler('protocol-open', 'completed transaction without matched binding: ' + page.id);
  }
  if (decision.tier === 'HOT') {
    if (!exactBytesAvailableFor(input, page)) {
      failCompiler('content-conflict', 'immediate transaction page carries no exact bytes: ' + page.id);
    }
    enumerated.push(makeCandidate(input.namespace, {
      subjectKind: decision.subjectKind,
      sourceId: page.id,
      tier: 'HOT',
      mandatory: false,
      contentHash: page.contentHash,
      pageId: page.id,
      provenance: deepClone(page.provenance),
      materializationState: 'exact-available',
      deterministicReasonCode: 'compiler-load-immediate-transaction',
    }));
    return;
  }
  if (decision.tier === 'WARM') {
    // CCV2-R1: required WARM bytes are never silently deferred.
    if (decision.retentionRequired === true && !exactBytesAvailableFor(input, page)) {
      failCompiler('required-unavailable', 'retention-required page carries no exact bytes: ' + page.id);
    }
    if (exactBytesAvailableFor(input, page)) {
      enumerated.push(makeCandidate(input.namespace, {
        subjectKind: decision.subjectKind,
        sourceId: page.id,
        tier: 'WARM',
        mandatory: false,
        contentHash: page.contentHash,
        pageId: page.id,
        provenance: deepClone(page.provenance),
        materializationState: 'exact-available',
        deterministicReasonCode: 'compiler-load-warm-history',
      }));
    } else {
      enumerated.push(makeCandidate(input.namespace, {
        subjectKind: decision.subjectKind,
        sourceId: page.id,
        tier: 'WARM',
        mandatory: false,
        contentHash: page.contentHash,
        pageId: page.id,
        provenance: deepClone(page.provenance),
        materializationState: 'requires-retrieval',
        deterministicReasonCode: 'compiler-defer-retrieval',
      }));
    }
    return;
  }
  if (decision.tier === 'COLD') {
    const mode = decision.exactResolutionMode;
    if (mode === 'durable-inline' && pageBytesAvailable(page)) {
      enumerated.push(makeCandidate(input.namespace, {
        subjectKind: decision.subjectKind,
        sourceId: page.id,
        tier: 'COLD',
        mandatory: false,
        contentHash: page.contentHash,
        pageId: page.id,
        provenance: deepClone(page.provenance),
        materializationState: 'exact-available',
        deterministicReasonCode: 'compiler-load-cold-inline',
      }));
      return;
    }
    if (EXTERNAL_RESOLUTION_MODES.includes(mode)) {
      const proofs = findProofForPage(input.exactMaterial, page);
      if (proofs.length === 0) {
        enumerated.push(makeCandidate(input.namespace, {
          subjectKind: decision.subjectKind,
          sourceId: page.id,
          tier: 'COLD',
          mandatory: false,
          contentHash: page.contentHash,
          pageId: page.id,
          provenance: deepClone(page.provenance),
          materializationState: 'reference-only',
          deterministicReasonCode: 'compiler-reference-cold',
        }));
        return;
      }
      const proof = proofs[0];
      bindProofToPage(proof, page, decision, input.namespace);
      enumerated.push(makeCandidate(input.namespace, {
        subjectKind: decision.subjectKind,
        sourceId: page.id,
        tier: 'COLD',
        mandatory: false,
        contentHash: page.contentHash,
        pageId: page.id,
        evidenceId: proof.evidenceId === undefined ? null : proof.evidenceId,
        provenance: deepClone(page.provenance),
        materializationState: 'exact-available',
        deterministicReasonCode: 'compiler-materialize-exact-cold',
      }));
      return;
    }
    enumerated.push(makeCandidate(input.namespace, {
      subjectKind: decision.subjectKind,
      sourceId: page.id,
      tier: 'COLD',
      mandatory: false,
      contentHash: page.contentHash,
      pageId: page.id,
      provenance: deepClone(page.provenance),
      materializationState: 'reference-only',
      deterministicReasonCode: 'compiler-reference-cold',
    }));
    return;
  }
  failCompiler('tier-conflict', 'unknown tier for page ' + page.id);
}

// A supplied B03 result authorizes external-COLD materialization only when
// the live proof binds this page, this content revision, this namespace,
// the decision mode, and the entry provenance. Anything less fails closed;
// the old B04 proof alone never materializes.
function bindProofToPage(proof, page, decision, expected) {
  if (proof.contentHash !== page.contentHash) {
    failCompiler('evidence-binding-mismatch', 'proof binds another content revision for ' + page.id);
  }
  const routeToMode = {
    session: 'exact-session-source',
    repository: 'exact-repository-source',
    artifact: 'exact-artifact-source',
  };
  if (routeToMode[proof.sourceRoute] !== decision.exactResolutionMode) {
    failCompiler('evidence-binding-mismatch', 'proof route disagrees with the tier decision for ' + page.id);
  }
  if (proof.mediaType !== 'text') {
    failCompiler('evidence-binding-mismatch', 'binary proof cannot materialize model-facing text for ' + page.id);
  }
  if (typeof proof.exactText !== 'string' || proof.exactText === '') {
    failCompiler('evidence-binding-mismatch', 'proof carries no exact text for ' + page.id);
  }
  if (sha256HexUtf8(proof.exactText) !== page.contentHash) {
    failCompiler('evidence-binding-mismatch', 'proof bytes disagree with page content for ' + page.id);
  }
  if (!isPlainObject(proof.provenance)
    || canonicalJsonOf(proof.provenance) !== canonicalJsonOf(page.provenance)) {
    failCompiler('evidence-binding-mismatch', 'proof provenance drifted for ' + page.id);
  }
  if (typeof proof.sourceIdentity !== 'string' || proof.sourceIdentity === '') {
    failCompiler('evidence-binding-mismatch', 'proof carries no source identity for ' + page.id);
  }
}

function enumerateWarmStateCandidates(enumerated, input, decisions) {
  const checkpoint = input.checkpoint;
  const activeDecisions = checkpoint.decisions.filter((entry) => entry.status === 'active');
  if (activeDecisions.length > 0) {
    const decision = requireWarmDecision(decisions.bySubject, 'accepted-decision', 'checkpoint:decisions');
    if (decision.tier !== 'WARM') {
      failCompiler('tier-conflict', 'accepted decision tier is ' + decision.tier + ', not WARM');
    }
    for (const entry of activeDecisions) {
      const text = renderDecisionText(entry);
      enumerated.push(makeCandidate(input.namespace, {
        subjectKind: 'accepted-decision',
        sourceId: 'checkpoint:decision:' + entry.id,
        tier: 'WARM',
        mandatory: false,
        contentHash: sha256HexUtf8(text),
        provenance: provenanceOf('controller', 'authoritative', ['controller:' + entry.id], 'decision-statement'),
        materializationState: 'exact-available',
        deterministicReasonCode: 'compiler-load-warm-decision',
      }));
    }
  }
  if (checkpoint.verification.outcomes.length > 0) {
    const decision = requireWarmDecision(decisions.bySubject, 'verification-state', 'checkpoint:verification');
    if (decision.tier !== 'WARM') {
      failCompiler('tier-conflict', 'verification state tier is ' + decision.tier + ', not WARM');
    }
    checkpoint.verification.outcomes.forEach((outcome, index) => {
      const text = renderVerificationText(outcome);
      enumerated.push(makeCandidate(input.namespace, {
        subjectKind: 'verification-state',
        sourceId: 'checkpoint:verification:' + index,
        tier: 'WARM',
        mandatory: false,
        contentHash: sha256HexUtf8(text),
        provenance: provenanceOf('verification', 'evidence', ['test-run:' + outcome.scope], 'verification-outcome'),
        materializationState: 'exact-available',
        deterministicReasonCode: 'compiler-load-verification',
      }));
    });
  }
  const hasFailureState = checkpoint.failures.rejectedHypotheses.length > 0
    || (checkpoint.failures.retryState !== null && checkpoint.failures.retryState !== undefined);
  if (hasFailureState) {
    const decision = requireWarmDecision(decisions.bySubject, 'failure-state', 'checkpoint:failure-state');
    if (decision.tier !== 'WARM') {
      failCompiler('tier-conflict', 'failure state tier is ' + decision.tier + ', not WARM');
    }
    const text = renderFailureStateText(checkpoint);
    enumerated.push(makeCandidate(input.namespace, {
      subjectKind: 'failure-state',
      sourceId: 'checkpoint:failure-state',
      tier: 'WARM',
      mandatory: false,
      contentHash: sha256HexUtf8(text),
      provenance: provenanceOf('controller', 'authoritative', ['controller:failure-state'], 'failure-detail'),
      materializationState: 'exact-available',
      deterministicReasonCode: 'compiler-load-failure-state',
    }));
  }
}

function enumerateEvidenceRefCandidates(enumerated, input, decisions, knownPageIds) {
  const seen = new Set();
  for (const ref of input.evidenceRefs) {
    if (seen.has(ref.evidenceId)) {
      const prior = enumerated.find((candidate) => candidate.evidenceId === ref.evidenceId);
      if (prior !== undefined
        && (prior.pageId !== ref.pageId || prior.contentHash !== ref.contentHash)) {
        failCompiler('content-conflict', 'duplicate EvidenceRef identity with conflicting binding: ' + ref.evidenceId);
      }
      continue;
    }
    seen.add(ref.evidenceId);
    if (ref.pageId !== null && knownPageIds.has(ref.pageId)) continue;
    enumerated.push(makeCandidate(input.namespace, {
      subjectKind: 'historical-evidence',
      sourceId: 'evidence:' + ref.evidenceId,
      tier: 'COLD',
      mandatory: false,
      contentHash: ref.contentHash,
      pageId: ref.pageId,
      evidenceId: ref.evidenceId,
      provenance: provenanceOf('agent', 'advisory', ['evidence:' + ref.evidenceId], 'agent-text'),
      materializationState: 'requires-retrieval',
      deterministicReasonCode: 'compiler-defer-retrieval',
    }));
  }
}

// ---- deterministic candidate ordering ----
//
// Authority order: PINNED, HOT, WARM, COLD (then ARCHIVE observability).
// Sequential checkpoint state preserves canonical array order; set-like
// page candidates sort by stable page identity. No clock, no filesystem
// iteration order, no relevance ranking.
function orderCandidates(candidates, requiredPageIds) {
  const required = requiredPageIds instanceof Set ? requiredPageIds : new Set();
  const pinned = [];
  const hot = [];
  const warmState = [];
  const warmPages = [];
  const coldExact = [];
  const coldRef = [];
  const deferred = [];
  const archive = [];
  for (const candidate of candidates) {
    if (candidate.tier === 'PINNED') pinned.push(candidate);
    else if (candidate.tier === 'HOT') hot.push(candidate);
    else if (candidate.tier === 'WARM' && candidate.pageId === null) warmState.push(candidate);
    else if (candidate.tier === 'WARM') {
      if (candidate.materializationState === 'exact-available') warmPages.push(candidate);
      else deferred.push(candidate);
    } else if (candidate.tier === 'COLD' && candidate.materializationState === 'exact-available') coldExact.push(candidate);
    else if (candidate.tier === 'COLD' && candidate.materializationState === 'reference-only') coldRef.push(candidate);
    else if (candidate.tier === 'COLD') deferred.push(candidate);
    else archive.push(candidate);
  }
  const bySource = (a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
  // CCV2-R1: required WARM pages keep their canonical source order (set at
  // enumeration) ahead of legacy WARM pages, which keep page-id order.
  const warmRequired = warmPages.filter((candidate) => required.has(candidate.pageId));
  const warmLegacy = warmPages.filter((candidate) => !required.has(candidate.pageId)).sort(bySource);
  warmPages.length = 0;
  for (const candidate of warmRequired.concat(warmLegacy)) warmPages.push(candidate);
  coldExact.sort(bySource);
  coldRef.sort(bySource);
  deferred.sort(bySource);
  archive.sort(bySource);
  return pinned.concat(hot, warmState, warmPages, coldExact, coldRef, deferred, archive);
}

function checkCandidateDuplicates(candidates) {
  const seenSources = new Map();
  for (const candidate of candidates) {
    const prior = seenSources.get(candidate.sourceId);
    if (prior !== undefined) {
      if (prior.candidateId !== candidate.candidateId) {
        failCompiler('content-conflict', 'duplicate semantic source with conflicting identity: ' + candidate.sourceId);
      }
      failCompiler('content-conflict', 'duplicate semantic source enumerated twice: ' + candidate.sourceId);
    }
    seenSources.set(candidate.sourceId, candidate);
  }
  const turnCandidates = candidates.filter((candidate) => candidate.subjectKind === 'current-user-turn');
  if (turnCandidates.length > 1) {
    failCompiler('content-conflict', 'current user turn enumerated more than once');
  }
}

// ---- mandatory manifest derivation ----

function deriveMandatoryRefs(candidates) {
  const refs = [];
  for (const candidate of candidates) {
    if (candidate.mandatory !== true) continue;
    let kind = null;
    if (candidate.subjectKind === 'active-requirement') kind = 'checkpoint-requirement';
    else if (candidate.subjectKind === 'active-constraint') kind = 'checkpoint-constraint';
    else if (candidate.subjectKind === 'current-user-turn') kind = 'current-turn';
    else if (candidate.subjectKind === 'historical-evidence') kind = 'page-evidence';
    else kind = 'checkpoint-element';
    refs.push({ sourceId: candidate.sourceId, kind, contentHash: candidate.contentHash });
  }
  return refs;
}

// ---- deterministic policy (categorical, never scored) ----

function applyPolicyToCandidates(candidates) {
  const decisions = [];
  for (const candidate of candidates) {
    const action = TRACE_ACTION_FOR_REASON[candidate.deterministicReasonCode];
    if (action === undefined) failCompiler('policy-invalid', 'no trace action for ' + candidate.deterministicReasonCode);
    if (candidate.mandatory === true && (action === 'REFERENCE' || action === 'SKIP')) {
      failCompiler('mandatory-conflict', 'mandatory source would leave the baseline view: ' + candidate.sourceId);
    }
    if (candidate.tier === 'PINNED' && action !== 'PIN') {
      failCompiler('mandatory-conflict', 'PINNED source without PIN action: ' + candidate.sourceId);
    }
    decisions.push(Object.freeze({
      pageId: candidate.pageId,
      action,
      reasonCode: candidate.deterministicReasonCode,
      deterministic: true,
    }));
  }
  return decisions;
}

// ---- validated input assembly ----

function assembleValidatedInput(raw) {
  if (!isPlainObject(raw)) failCompiler('input-invalid', 'input is required');
  const unknown = unknownKeyOf(raw, COMPILE_INPUT_EXACT_KEYS);
  if (unknown !== null) failCompiler('input-invalid', unknown);
  rejectScoringKeys(raw, 'compile input');
  if (raw.compilerPolicyRevision !== COMPILER_POLICY_REVISION_V2) {
    failCompiler('policy-invalid', 'compiler policy revision must be ' + COMPILER_POLICY_REVISION_V2);
  }
  const namespace = validateCompileNamespace(raw.namespace);
  const expected = { taskId: namespace.taskId, taskInstanceId: namespace.taskInstanceId, sessionId: namespace.sessionId };
  if (raw.snapshotRevision !== null && raw.snapshotRevision !== undefined
    && (typeof raw.snapshotRevision !== 'string' || !CONTENT_HASH_PATTERN.test(raw.snapshotRevision))) {
    failCompiler('snapshot-mismatch', 'snapshotRevision must be a 64-hex digest or null');
  }
  const snapshotRevision = raw.snapshotRevision === undefined ? null : raw.snapshotRevision;
  const checkpoint = validateCheckpoint(raw.checkpoint, expected, snapshotRevision);
  const currentTurn = validateCurrentTurn(raw.currentTurn === undefined ? null : raw.currentTurn);
  const runtimeState = validateRuntimeState(raw.runtimeState === undefined ? null : raw.runtimeState);
  const pages = validatePages(raw.pages === undefined ? failCompiler('input-invalid', 'pages must be an explicit array') : raw.pages, expected);
  const tierDecisions = validateTierDecisions(raw.tierDecisions === undefined
    ? failCompiler('input-invalid', 'tierDecisions must be an explicit array') : raw.tierDecisions, expected);
  const evidenceRefs = validateEvidenceRefs(raw.evidenceRefs === undefined ? [] : raw.evidenceRefs, expected);
  const exactMaterial = validateExactMaterial(raw.exactMaterial === undefined ? [] : raw.exactMaterial, expected);
  const toolTransactions = validateToolTransactions(raw.toolTransactions === undefined ? [] : raw.toolTransactions, pages);
  const budget = validateBudget(raw.budget);
  const assembled = {
    checkpoint,
    currentTurn,
    namespace,
    snapshotRevision,
    runtimeState,
    pages,
    tierDecisions,
    evidenceRefs,
    exactMaterial,
    toolTransactions,
    budget,
    compilerPolicyRevision: COMPILER_POLICY_REVISION_V2,
  };
  failIfPendingProtocol(assembled);
  return assembled;
}

// ---- public enumeration entry points ----

function enumerateContextCandidatesV2(rawInput) {
  const input = assembleValidatedInput(rawInput);
  const decisions = indexTierDecisions(input.tierDecisions);
  const enumerated = [];
  enumeratePinnedCandidates(enumerated, input, decisions);
  enumerateHotCandidates(enumerated, input, decisions);
  enumerateWarmStateCandidates(enumerated, input, decisions);
  const pagesSorted = pagesInEnumerationOrder(input);
  for (const page of pagesSorted) {
    if (page.contentHash === null || page.contentHash === undefined) {
      failCompiler('content-conflict', 'known page carries no content identity: ' + page.id);
    }
    enumeratePageCandidate(enumerated, input, decisions, page);
  }
  const knownPageIds = new Set(input.pages.map((page) => page.id));
  for (const proof of input.exactMaterial) {
    if (!knownPageIds.has(proof.pageId)) {
      failCompiler('evidence-binding-mismatch', 'exact material binds an unknown page: ' + proof.pageId);
    }
  }
  enumerateEvidenceRefCandidates(enumerated, input, decisions, knownPageIds);
  checkCandidateDuplicates(enumerated);
  return Object.freeze(orderCandidates(enumerated, requiredPageIdsOf(input)).map((candidate) => candidate));
}

function deriveMandatoryManifestV2(rawInput) {
  const candidates = enumerateContextCandidatesV2(rawInput);
  return Object.freeze(deriveMandatoryRefs(candidates).map((ref) => Object.freeze({
    sourceId: ref.sourceId,
    kind: ref.kind,
    contentHash: ref.contentHash,
  })));
}

function applyDeterministicContextPolicyV2(rawInput) {
  const candidates = enumerateContextCandidatesV2(rawInput);
  return Object.freeze(applyPolicyToCandidates(candidates));
}

// ---- compilation plan ----

function derivePlanDigestV2(planWithoutDigest) {
  return sha256HexUtf8(COMPILER_PLAN_DIGEST_DOMAIN_V1 + '\n' + canonicalJsonOf(planWithoutDigest));
}

function checkpointBindingOf(checkpoint, snapshotRevision) {
  return {
    checkpointGeneration: checkpoint.generation,
    checkpointId: checkpoint.checkpointId,
    checkpointContentHash: checkpoint.checkpointContentDigest,
    snapshotRevision,
  };
}

function buildContextCompilationPlanV2(rawInput) {
  const input = assembleValidatedInput(rawInput);
  const decisions = indexTierDecisions(input.tierDecisions);
  const enumerated = [];
  enumeratePinnedCandidates(enumerated, input, decisions);
  enumerateHotCandidates(enumerated, input, decisions);
  enumerateWarmStateCandidates(enumerated, input, decisions);
  const pagesSorted = pagesInEnumerationOrder(input);
  for (const page of pagesSorted) {
    if (page.contentHash === null || page.contentHash === undefined) {
      failCompiler('content-conflict', 'known page carries no content identity: ' + page.id);
    }
    enumeratePageCandidate(enumerated, input, decisions, page);
  }
  const knownPageIds = new Set(input.pages.map((page) => page.id));
  for (const proof of input.exactMaterial) {
    if (!knownPageIds.has(proof.pageId)) {
      failCompiler('evidence-binding-mismatch', 'exact material binds an unknown page: ' + proof.pageId);
    }
  }
  enumerateEvidenceRefCandidates(enumerated, input, decisions, knownPageIds);
  checkCandidateDuplicates(enumerated);
  const candidates = orderCandidates(enumerated, requiredPageIdsOf(input));
  const policyDecisions = applyPolicyToCandidates(candidates);
  const mandatoryRefs = deriveMandatoryRefs(candidates);
  const planWithoutDigest = {
    schemaVersion: COMPILER_SCHEMA_VERSION,
    namespace: deepClone(input.namespace),
    checkpointBinding: checkpointBindingOf(input.checkpoint, input.snapshotRevision),
    compilerPolicyRevision: COMPILER_POLICY_REVISION_V2,
    mandatoryRefs: mandatoryRefs.map((ref) => ({
      sourceId: ref.sourceId,
      kind: ref.kind,
      contentHash: ref.contentHash,
    })),
    candidates: candidates.map((candidate) => ({
      schemaVersion: candidate.schemaVersion,
      candidateId: candidate.candidateId,
      subjectKind: candidate.subjectKind,
      sourceId: candidate.sourceId,
      tier: candidate.tier,
      mandatory: candidate.mandatory,
      contentHash: candidate.contentHash,
      pageId: candidate.pageId,
      evidenceId: candidate.evidenceId,
      provenance: deepClone(candidate.provenance),
      materializationState: candidate.materializationState,
      deterministicReasonCode: candidate.deterministicReasonCode,
      deterministic: true,
    })),
    decisions: policyDecisions.map((decision) => ({
      pageId: decision.pageId,
      action: decision.action,
      reasonCode: decision.reasonCode,
      deterministic: true,
    })),
    deterministic: true,
  };
  const plan = Object.assign({}, planWithoutDigest, {
    planDigest: derivePlanDigestV2(planWithoutDigest),
  });
  const check = validateContextCompilationPlanV2(plan);
  if (!check.valid) failCompiler('policy-invalid', 'assembled plan failed validation: ' + check.reason);
  return freezeDeep(plan);
}

function validateContextCompilationPlanV2(plan) {
  const fail = (reason) => ({ valid: false, reason });
  if (!isPlainObject(plan)) return fail('context-compiler-plan-invalid');
  const unknown = unknownKeyOf(plan, PLAN_EXACT_KEYS);
  if (unknown !== null) return fail('context-compiler-plan-invalid');
  if (plan.schemaVersion !== COMPILER_SCHEMA_VERSION) return fail('context-compiler-plan-invalid');
  if (plan.deterministic !== true) return fail('context-compiler-plan-invalid');
  if (plan.compilerPolicyRevision !== COMPILER_POLICY_REVISION_V2) {
    return fail('context-compiler-policy-invalid');
  }
  if (!isPlainObject(plan.namespace)) return fail('context-compiler-namespace-mismatch');
  if (!Array.isArray(plan.mandatoryRefs)) return fail('context-compiler-plan-invalid');
  if (!Array.isArray(plan.candidates)) return fail('context-compiler-plan-invalid');
  if (!Array.isArray(plan.decisions)) return fail('context-compiler-plan-invalid');
  const seenCandidates = new Set();
  const seenSources = new Set();
  for (const candidate of plan.candidates) {
    if (!isPlainObject(candidate)) return fail('context-compiler-plan-invalid');
    if (unknownKeyOf(candidate, CANDIDATE_EXACT_KEYS) !== null) return fail('context-compiler-plan-invalid');
    if (candidate.schemaVersion !== COMPILER_SCHEMA_VERSION) return fail('context-compiler-plan-invalid');
    if (typeof candidate.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(candidate.candidateId)) {
      return fail('context-compiler-plan-invalid');
    }
    if (!tierV2.SUBJECT_KINDS.includes(candidate.subjectKind)) return fail('context-compiler-plan-invalid');
    if (!CANDIDATE_TIERS.includes(candidate.tier)) return fail('context-compiler-tier-conflict');
    if (!MATERIALIZATION_STATES.includes(candidate.materializationState)) {
      return fail('context-compiler-plan-invalid');
    }
    if (!COMPILER_REASON_CODES.includes(candidate.deterministicReasonCode)) {
      return fail('context-compiler-policy-invalid');
    }
    if (candidate.deterministic !== true) return fail('context-compiler-plan-invalid');
    if (candidate.contentHash !== null && !CONTENT_HASH_PATTERN.test(String(candidate.contentHash))) {
      return fail('context-compiler-content-conflict');
    }
    if (seenCandidates.has(candidate.candidateId)) return fail('context-compiler-content-conflict');
    seenCandidates.add(candidate.candidateId);
    if (seenSources.has(candidate.sourceId)) return fail('context-compiler-content-conflict');
    seenSources.add(candidate.sourceId);
    if (candidate.tier === 'PINNED' && candidate.mandatory !== true) {
      return fail('context-compiler-mandatory-conflict');
    }
    const provenanceCheck = trustV2.validateTrustProvenance(candidate.provenance);
    if (!provenanceCheck.valid) return fail('context-compiler-plan-invalid');
  }
  if (plan.decisions.length !== plan.candidates.length) return fail('context-compiler-plan-invalid');
  for (let index = 0; index < plan.decisions.length; index += 1) {
    const decision = plan.decisions[index];
    const candidate = plan.candidates[index];
    if (!isPlainObject(decision)) return fail('context-compiler-plan-invalid');
    if (decision.deterministic !== true) return fail('context-compiler-plan-invalid');
    if (!viewV2.TRACE_ACTIONS.includes(decision.action)) return fail('context-compiler-plan-invalid');
    if (decision.reasonCode !== candidate.deterministicReasonCode) return fail('context-compiler-plan-invalid');
    if (decision.pageId !== candidate.pageId) return fail('context-compiler-plan-invalid');
    if (candidate.mandatory === true && (decision.action === 'REFERENCE' || decision.action === 'SKIP')) {
      return fail('context-compiler-mandatory-conflict');
    }
  }
  const seenMandatory = new Set();
  for (const ref of plan.mandatoryRefs) {
    if (!isPlainObject(ref)) return fail('context-compiler-plan-invalid');
    if (typeof ref.sourceId !== 'string' || ref.sourceId === '') return fail('context-compiler-plan-invalid');
    if (seenMandatory.has(ref.sourceId)) return fail('context-compiler-mandatory-conflict');
    seenMandatory.add(ref.sourceId);
    const candidate = plan.candidates.find((entry) => entry.sourceId === ref.sourceId);
    if (candidate === undefined || candidate.mandatory !== true) {
      return fail('context-compiler-mandatory-conflict');
    }
    if (ref.contentHash !== null && ref.contentHash !== undefined
      && ref.contentHash !== candidate.contentHash) {
      return fail('context-compiler-mandatory-conflict');
    }
  }
  for (const candidate of plan.candidates) {
    if (candidate.mandatory === true && !seenMandatory.has(candidate.sourceId)) {
      return fail('context-compiler-mandatory-conflict');
    }
  }
  const recomputed = derivePlanDigestV2({
    schemaVersion: plan.schemaVersion,
    namespace: plan.namespace,
    checkpointBinding: plan.checkpointBinding,
    compilerPolicyRevision: plan.compilerPolicyRevision,
    mandatoryRefs: plan.mandatoryRefs,
    candidates: plan.candidates,
    decisions: plan.decisions,
    deterministic: plan.deterministic,
  });
  if (typeof plan.planDigest !== 'string' || plan.planDigest !== recomputed) {
    return fail('context-compiler-plan-digest-mismatch');
  }
  return { valid: true, reason: null };
}
// ---- baseline ContextView construction ----

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

function bySourceId(candidates, sourceId) {
  return candidates.find((candidate) => candidate.sourceId === sourceId);
}

function compileToViewInput(plan, input) {
  const candidates = plan.candidates;
  const pinned = [];
  const hot = [];
  const warm = [];
  const materializedCold = [];
  const referencedColdPages = [];
  const byId = new Map(input.pages.map((page) => [page.id, page]));
  const proofByPage = new Map(input.exactMaterial.map((proof) => [proof.pageId, proof]));

  const stateTextOf = (candidate) => {
    const checkpoint = input.checkpoint;
    if (candidate.subjectKind === 'active-requirement') {
      const id = candidate.sourceId.slice('checkpoint:requirement:'.length);
      const req = checkpoint.requirements.find((entry) => entry.id === id);
      return renderRequirementText(req);
    }
    if (candidate.subjectKind === 'active-constraint') {
      const index = Number(candidate.sourceId.slice('checkpoint:constraint:'.length));
      return renderConstraintText(checkpoint.constraints[index]);
    }
    if (candidate.subjectKind === 'unresolved-approval') {
      const index = Number(candidate.sourceId.slice('checkpoint:approval:'.length));
      return renderApprovalText(String(checkpoint.continuation.unresolvedQuestions[index]), index);
    }
    if (candidate.subjectKind === 'mandatory-checkpoint-state') return renderObjectiveText(checkpoint);
    if (candidate.subjectKind === 'current-user-turn') return input.currentTurn.text;
    if (candidate.subjectKind === 'active-failure') {
      const id = candidate.sourceId.slice('checkpoint:failure:'.length);
      const failure = checkpoint.failures.activeFailures.find((entry) => entry.id === id);
      return renderFailureText(failure);
    }
    if (candidate.subjectKind === 'accepted-decision') {
      const id = candidate.sourceId.slice('checkpoint:decision:'.length);
      const entry = checkpoint.decisions.find((item) => item.id === id);
      return renderDecisionText(entry);
    }
    if (candidate.subjectKind === 'verification-state') {
      const index = Number(candidate.sourceId.slice('checkpoint:verification:'.length));
      return renderVerificationText(checkpoint.verification.outcomes[index]);
    }
    if (candidate.subjectKind === 'failure-state') return renderFailureStateText(checkpoint);
    failCompiler('policy-invalid', 'no state rendering for ' + candidate.subjectKind);
    return null;
  };

  const tierDecisionFor = (candidate) => {
    if (candidate.pageId !== null) {
      const decision = input.tierDecisions.find((entry) => entry.pageId === candidate.pageId
        && entry.subjectKind === candidate.subjectKind);
      if (decision === undefined) failCompiler('tier-conflict', 'tier decision vanished for ' + candidate.sourceId);
      return deepClone(decision);
    }
    const decision = input.tierDecisions.find((entry) => (entry.pageId === null || entry.pageId === undefined)
      && entry.subjectKind === candidate.subjectKind);
    if (decision === undefined) failCompiler('tier-conflict', 'tier decision vanished for ' + candidate.sourceId);
    return deepClone(decision);
  };

  const bindingByPage = new Map(input.toolTransactions.map((binding) => [binding.pageId, binding]));
  const toolUnitFor = (candidate) => {
    if (candidate.subjectKind !== 'completed-tool-transaction') return null;
    const binding = bindingByPage.get(candidate.pageId);
    if (binding === undefined) {
      failCompiler('protocol-open', 'completed transaction without matched binding: ' + candidate.sourceId);
    }
    return { callId: binding.callId, callPresent: true, resultPresent: true };
  };

  const evidenceFor = (candidate) => {
    if (candidate.deterministicReasonCode !== 'compiler-materialize-exact-cold') return null;
    const proof = proofByPage.get(candidate.pageId);
    return {
      pageId: proof.pageId,
      contentHash: proof.contentHash,
      sourceRoute: proof.sourceRoute,
      mediaType: 'text',
      sourceIdentity: proof.sourceIdentity,
      resultDigest: proof.resultDigest,
      verified: true,
      namespace: {
        taskId: proof.namespace.taskId,
        taskInstanceId: proof.namespace.taskInstanceId,
        sessionId: proof.namespace.sessionId,
      },
      provenance: deepClone(candidate.provenance),
    };
  };

  const exactTextFor = (candidate) => {
    if (candidate.pageId === null) return stateTextOf(candidate);
    if (candidate.deterministicReasonCode === 'compiler-materialize-exact-cold') {
      return String(proofByPage.get(candidate.pageId).exactText);
    }
    const page = byId.get(candidate.pageId);
    if (page.exactText !== null && page.exactText !== undefined) return String(page.exactText);
    // CCV2-R1: HOT/WARM blob-backed bytes from the bound B03 blob proof.
    const blobProof = blobProofForPage(input.exactMaterial, page, input.namespace);
    if (blobProof === null) failCompiler('required-unavailable', 'no exact bytes for ' + candidate.sourceId);
    return String(blobProof.exactText);
  };

  const sourceTypeFor = (candidate) => {
    if (candidate.subjectKind === 'current-user-turn') return 'current-turn';
    if (candidate.pageId !== null) return 'context-page';
    return 'checkpoint-state';
  };

  for (const candidate of candidates) {
    const decision = plan.decisions[candidates.indexOf(candidate)];
    if (decision.action === 'SKIP') continue;
    if (decision.action === 'REFERENCE') {
      const page = byId.get(candidate.pageId);
      const tierDecision = tierDecisionFor(candidate);
      referencedColdPages.push({
        pageId: page.id,
        contentHash: page.contentHash,
        evidenceId: null,
        kind: page.kind,
        provenance: deepClone(page.provenance),
        exactResolutionMode: tierDecision.exactResolutionMode,
        namespace: {
          taskId: input.namespace.taskId,
          taskInstanceId: input.namespace.taskInstanceId,
          sessionId: input.namespace.sessionId,
        },
        tierDecision,
      });
      continue;
    }
    const text = exactTextFor(candidate);
    if (sha256HexUtf8(text) !== candidate.contentHash) {
      failCompiler('content-conflict', 'rendered bytes disagree with candidate identity: ' + candidate.sourceId);
    }
    const entry = {
      tier: candidate.tier,
      sourceType: sourceTypeFor(candidate),
      sourceId: candidate.sourceId,
      contentHash: candidate.contentHash,
      provenance: deepClone(candidate.provenance),
      mediaType: 'text',
      exactText: text,
      mandatory: candidate.mandatory,
      tierDecision: tierDecisionFor(candidate),
      evidence: evidenceFor(candidate),
      toolTransaction: toolUnitFor(candidate),
    };
    if (candidate.tier === 'PINNED') pinned.push(entry);
    else if (candidate.tier === 'HOT') hot.push(entry);
    else if (candidate.tier === 'WARM') warm.push(entry);
    else if (candidate.tier === 'COLD') materializedCold.push(entry);
    else failCompiler('tier-conflict', 'ARCHIVE candidate must never materialize: ' + candidate.sourceId);
  }

  const turnRef = input.currentTurn === null
    ? null
    : { turnId: input.currentTurn.turnId, revision: input.currentTurn.revision };
  return {
    namespace: deepClone(input.namespace),
    checkpointBinding: checkpointBindingOf(input.checkpoint, input.snapshotRevision),
    turnRef,
    pinned,
    hot,
    warm,
    materializedCold,
    referencedColdPages,
    tokenBudget: { hardMax: input.budget.hardMax, target: input.budget.target, used: null },
    compilerPolicyRevision: COMPILER_POLICY_REVISION_V2,
    compilationTrace: plan.decisions.map((entry) => ({
      pageId: entry.pageId,
      action: entry.action,
      reasonCode: entry.reasonCode,
      deterministic: true,
    })),
    mandatoryRefs: plan.mandatoryRefs.map((ref) => ({
      sourceId: ref.sourceId,
      kind: mandatoryKindOf(candidates, ref.sourceId),
      contentHash: ref.contentHash,
    })),
  };
}

function mandatoryKindOf(candidates, sourceId) {
  const candidate = bySourceId(candidates, sourceId);
  if (candidate === undefined) failCompiler('mandatory-conflict', 'mandatory ref without candidate: ' + sourceId);
  if (candidate.subjectKind === 'active-requirement') return 'checkpoint-requirement';
  if (candidate.subjectKind === 'active-constraint') return 'checkpoint-constraint';
  if (candidate.subjectKind === 'current-user-turn') return 'current-turn';
  if (candidate.subjectKind === 'historical-evidence' && candidate.pageId !== null) return 'page-evidence';
  return 'checkpoint-element';
}

function checkPlanViewAgreement(plan, view) {
  if (canonicalJsonOf(plan.mandatoryRefs) !== canonicalJsonOf(view.mandatoryRefs)) {
    failCompiler('view-invalid', 'plan mandatory manifest diverged from the sealed view');
  }
  const materialized = [];
  for (const section of viewV2.VIEW_SECTIONS) {
    for (const entry of view[section]) materialized.push(entry.sourceId);
  }
  const expectedMaterialized = [];
  plan.candidates.forEach((candidate, index) => {
    const action = plan.decisions[index].action;
    if (action === 'PIN' || action === 'LOAD') expectedMaterialized.push(candidate.sourceId);
  });
  if (canonicalJsonOf(materialized.slice().sort()) !== canonicalJsonOf(expectedMaterialized.slice().sort())) {
    failCompiler('view-invalid', 'plan materialization diverged from the sealed view');
  }
  const referenced = view.referencedColdPages.map((ref) => ref.pageId).slice().sort();
  const expectedReferenced = [];
  plan.candidates.forEach((candidate, index) => {
    if (plan.decisions[index].action === 'REFERENCE') expectedReferenced.push(candidate.pageId);
  });
  if (canonicalJsonOf(referenced) !== canonicalJsonOf(expectedReferenced.slice().sort())) {
    failCompiler('view-invalid', 'plan references diverged from the sealed view');
  }
}

function compileContextV2(rawInput) {
  const before = rawInput === null || rawInput === undefined ? null : canonicalJsonOf(rawInput);
  const plan = buildContextCompilationPlanV2(rawInput);
  const input = assembleValidatedInput(rawInput);
  const viewInput = compileToViewInput(plan, input);
  let view = null;
  try {
    view = viewV2.createContextViewV2(viewInput);
  } catch (error) {
    failCompiler('view-invalid', 'C01 rejected the compiler output: '
      + String(error && error.message ? error.message : error).slice(0, 200));
  }
  checkPlanViewAgreement(plan, view);
  if (before !== null && canonicalJsonOf(rawInput) !== before) {
    failCompiler('view-invalid', 'compilation mutated its input');
  }
  return Object.freeze({ plan, view });
}

function describeContextCompilationPlanV2(plan) {
  const check = validateContextCompilationPlanV2(plan);
  if (!check.valid) failCompiler('policy-invalid', 'cannot describe an invalid plan: ' + check.reason);
  const tiers = {};
  const actions = {};
  for (const candidate of plan.candidates) {
    tiers[candidate.tier] = (tiers[candidate.tier] === undefined ? 0 : tiers[candidate.tier]) + 1;
  }
  for (const decision of plan.decisions) {
    actions[decision.action] = (actions[decision.action] === undefined ? 0 : actions[decision.action]) + 1;
  }
  return Object.freeze({
    planDigestPrefix: String(plan.planDigest).slice(0, 16),
    taskId: plan.namespace.taskId,
    taskInstanceId: plan.namespace.taskInstanceId,
    sessionId: plan.namespace.sessionId,
    checkpointGeneration: plan.checkpointBinding.checkpointGeneration,
    checkpointId: plan.checkpointBinding.checkpointId,
    checkpointContentHashPrefix: String(plan.checkpointBinding.checkpointContentHash).slice(0, 16),
    candidateIds: plan.candidates.map((candidate) => candidate.candidateId),
    sourceIds: plan.candidates.map((candidate) => candidate.sourceId),
    contentHashPrefixes: plan.candidates.map((candidate) => String(candidate.contentHash).slice(0, 16)),
    candidateCount: plan.candidates.length,
    mandatoryCount: plan.mandatoryRefs.length,
    traceCount: plan.decisions.length,
    tiers,
    actions,
    compilerPolicyRevision: plan.compilerPolicyRevision,
    deterministic: true,
  });
}

module.exports = {
  COMPILER_SCHEMA_VERSION,
  COMPILER_POLICY_REVISION_V2,
  COMPILER_REASON_CODES,
  CANDIDATE_TIERS,
  MATERIALIZATION_STATES,
  COMPILE_INPUT_EXACT_KEYS,
  CANDIDATE_EXACT_KEYS,
  compileContextV2,
  buildContextCompilationPlanV2,
  deriveMandatoryManifestV2,
  enumerateContextCandidatesV2,
  applyDeterministicContextPolicyV2,
  validateContextCompilationPlanV2,
  describeContextCompilationPlanV2,
};
