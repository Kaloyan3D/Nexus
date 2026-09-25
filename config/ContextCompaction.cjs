'use strict';
/**
 * ContextCompaction.cjs - Context Compaction V1 bridge helpers (pure, engine-neutral).
 *
 * ONE consumer of these helpers is the controller bridge (config/AihController.cjs).
 * This module owns NO state, performs NO I/O, and NEVER decides routing, model
 * selection, or task completion. It answers three narrow questions:
 *
 *   1. effectiveInputTokensOf: the authoritative root pressure signal for one
 *      DSH usage event (uncachedInputTokens + cacheReadTokens). No cost is
 *      ever inferred.
 *   2. rootUsageCandidateOf: whether one session/event usage record is a ROOT
 *      engineering call that may feed compaction pressure. Reviewer,
 *      visual-review, worker/subagent, and non-engineering usage are excluded
 *      here so they can never pollute the root metric.
 *   3. balancedRetainCut: where a checkpoint replacement may cut the session
 *      surface so no assistant tool call is orphaned from its result.
 *
 * Fail-closed bias: ambiguous usage is NOT a root candidate (KEEP).
 */

const ROOT_ENGINE_ROLES = Object.freeze(['muse_main', 'engineer_normal', 'engineer_deep']);

function toNonNegativeInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.trunc(number);
}

function effectiveInputTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (usage.usageAvailable === false) return null;
  const uncached = toNonNegativeInt(usage.uncachedInputTokens !== undefined ? usage.uncachedInputTokens : usage.inputTokens);
  const cacheRead = toNonNegativeInt(usage.cacheReadTokens !== undefined ? usage.cacheReadTokens : 0);
  if (usage.uncachedInputTokens === undefined && usage.inputTokens === undefined) return null;
  return uncached + cacheRead;
}
function isWorkerSession(session) {
  const header = session && session.header;
  return Boolean(header && (header.origin === 'subagent' || (header.delegationDepth || 0) > 0));
}

function rootUsageCandidateOf(event, view) {
  const usage = event && event.type === 'assistant/chunk' && event.data && event.data.chunk && event.data.chunk.type === 'usage'
    ? event.data.chunk.usage
    : null;
  if (!usage || typeof usage !== 'object') return null;
  if (!view || typeof view !== 'object') return null;
  if (view.isWorker === true) return null;
  const engine = view.engine;
  if (engine !== 'muse' && engine !== 'dual') return null;
  const role = view.role;
  if (engine === 'muse') {
    if (role !== null && role !== undefined && role !== 'muse_main') return null;
  } else {
    if (role !== 'engineer_normal' && role !== 'engineer_deep') return null;
  }
  if (view.executionClass === 'reviewer') return null;
  const uncachedRaw = usage.inputTokens;
  const outputRaw = usage.outputTokens;
  const cacheRaw = usage.cacheReadTokens === undefined || usage.cacheReadTokens === null ? 0 : usage.cacheReadTokens;
  const uncached = Number(uncachedRaw);
  const output = Number(outputRaw);
  const cache = Number(cacheRaw);
  if (!Number.isFinite(uncached) || !Number.isFinite(output) || !Number.isFinite(cache)) return null;
  const candidate = {
    engine,
    engineRole: engine === 'muse' ? 'muse_main' : role,
    uncachedInputTokens: Math.max(0, Math.trunc(uncached)),
    cacheReadTokens: Math.max(0, Math.trunc(cache)),
    outputTokens: Math.max(0, Math.trunc(output)),
    usageAvailable: true,
  };
  candidate.effectiveInputTokens = candidate.uncachedInputTokens + candidate.cacheReadTokens;
  const turn = event.data && event.data.turn !== undefined && event.data.turn !== null ? String(event.data.turn) : '';
  const step = event.data && event.data.step !== undefined && event.data.step !== null ? String(event.data.step) : '';
  candidate.stepId = turn || step ? turn + ':' + step : (typeof view.stepId === 'string' ? view.stepId : '');
  if (typeof view.model === 'string' && view.model !== '') candidate.model = view.model;
  if (typeof view.provider === 'string' && view.provider !== '') candidate.provider = view.provider;
  return candidate;
}
function toolCallDeltaOfSurfaceEvent(event) {
  if (!event || typeof event !== 'object') return 0;
  if (event.type === 'assistant/message') {
    const content = event.data && event.data.message && Array.isArray(event.data.message.content)
      ? event.data.message.content
      : [];
    let calls = 0;
    for (const block of content) {
      if (block && block.type === 'tool-call') calls += 1;
    }
    return calls;
  }
  if (event.type === 'tool/result') return -1;
  return 0;
}

function surfaceNodesOf(session) {
  if (!session) return [];
  const surface = session.surface;
  if (surface && Array.isArray(surface.nodes)) return surface.nodes.slice();
  return [];
}

function eventBySeq(session, seq) {
  if (!session || !Array.isArray(session.events)) return null;
  const event = session.events[seq];
  return event && event.seq === seq ? event : null;
}

function textLengthOfSurfaceEvent(event) {
  try {
    return JSON.stringify(event && event.data ? event.data : null).length;
  } catch {
    return 0;
  }
}

function balancedRetainCut(session, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const nodes = surfaceNodesOf(session);
  if (nodes.length === 0) return null;
  const maxTailNodes = Number.isFinite(Number(opts.maxTailNodes)) ? Math.max(1, Math.trunc(Number(opts.maxTailNodes))) : 6;
  const maxTailChars = Number.isFinite(Number(opts.maxTailChars)) ? Math.max(256, Math.trunc(Number(opts.maxTailChars))) : 6000;
  const minShadowed = Number.isFinite(Number(opts.minShadowed)) ? Math.max(1, Math.trunc(Number(opts.minShadowed))) : 1;
  const prefixBalanced = [true];
  let balance = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const event = eventBySeq(session, nodes[index]);
    if (!event) return null;
    balance += toolCallDeltaOfSurfaceEvent(event);
    if (balance < 0) return null;
    prefixBalanced.push(balance === 0);
  }
  if (balance !== 0) return null;
  let tailStart = -1;
  let tailChars = 0;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (nodes.length - index > maxTailNodes) break;
    const event = eventBySeq(session, nodes[index]);
    if (!event) return null;
    tailChars += textLengthOfSurfaceEvent(event);
    // F9: hard whole-node continuity bound. NO first-node exception: if the
    // mandatory newest node (or any required balanced group) exceeds
    // maxTailChars, there is no safe bounded cut -- tailStart stays -1 and
    // the caller KEEPs. Never truncate/split protocol structures to fit.
    if (tailChars > maxTailChars) break;
    // An unbalanced cut cannot START the retained tail (it would orphan a
    // tool call inside the shadowed span). With no candidate yet, keep
    // scanning backward for an earlier balanced cut instead of giving up:
    // a surface ending mid-tool-pair still has a valid earlier boundary.
    if (!prefixBalanced[index]) {
      if (tailStart !== -1) break;
      continue;
    }
    tailStart = index;
  }
  if (tailStart === -1) return null;
  if (tailStart < minShadowed) return null;
  const shadowedSeqs = nodes.slice(0, tailStart);
  const retainedSeqs = nodes.slice(tailStart);
  return {
    start: shadowedSeqs[0],
    end: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
    retainedSeqs,
  };
}
const RUNTIME_CONTEXT_PLUGIN = '@deepseek-ai/dsh-system-prompt';

function isRuntimeContextMessage(event) {
  return Boolean(event && event.type === 'user/message' && event.data && event.data.source
    && event.data.source.kind === 'plugin' && event.data.source.plugin === RUNTIME_CONTEXT_PLUGIN);
}

function runtimeContextSeqsOf(session) {
  const seqs = [];
  if (!session || !Array.isArray(session.events)) return seqs;
  for (const event of session.events) {
    if (isRuntimeContextMessage(event) && typeof event.seq === 'number') seqs.push(event.seq);
  }
  return seqs;
}

function withoutSeqs(seqs, excluded) {
  const drop = new Set(excluded);
  return seqs.filter((seq) => !drop.has(seq));
}

// Split one shadowed span around host-owned runtime-context nodes (F1): the
// owned snapshots stay visible while the bulk on either side is replaced by
// one replacement node per contiguous non-owned segment. Returns null when
// no bulk remains OR when a split would orphan a tool call/result pair
// (tool-pair checks are never weakened to make frozen operations easier).
function splitRangeAroundOwned(session, shadowedSeqs, ownedSeqs) {
  if (!Array.isArray(shadowedSeqs) || shadowedSeqs.length === 0) return null;
  const owned = new Set(Array.isArray(ownedSeqs) ? ownedSeqs : []);
  const segments = [];
  let current = [];
  for (const seq of shadowedSeqs) {
    if (owned.has(seq)) {
      if (current.length > 0) { segments.push(current); current = []; }
      continue;
    }
    current.push(seq);
  }
  if (current.length > 0) segments.push(current);
  if (segments.length === 0) return null;
  // Per-segment tool-pair safety: fold the session surface from its start
  // and require every segment to open and close at the same in-progress
  // tool-call depth without dipping below it (no call orphaned inside the
  // shadowed span, no result adopted from outside it).
  const nodes = surfaceNodesOf(session);
  const depthAt = new Map();
  let depth = 0;
  for (const node of nodes) {
    const event = eventBySeq(session, node);
    if (!event) return null;
    depthAt.set(node, depth);
    depth += toolCallDeltaOfSurfaceEvent(event);
    if (depth < 0) return null;
  }
  const shaped = [];
  for (const seqs of segments) {
    const entry = depthAt.has(seqs[0]) ? depthAt.get(seqs[0]) : null;
    if (entry === null) return null;
    let running = entry;
    for (const seq of seqs) {
      running += toolCallDeltaOfSurfaceEvent(eventBySeq(session, seq));
      if (running < entry) return null;
    }
    if (running !== entry) return null;
    shaped.push({ start: seqs[0], end: seqs[seqs.length - 1], sourceEventSeqs: seqs });
  }
  return shaped;
}

function findReplacementByOperation(session, operationId) {
  if (!session || !Array.isArray(session.events) || typeof operationId !== 'string' || operationId === '') return null;
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (!event || event.type !== 'user/message') continue;
    const source = event.data && event.data.source;
    if (!source || source.kind !== 'plugin' || source.plugin !== 'aih-controller') continue;
    if (source.form !== 'context-checkpoint') continue;
    if (source.operationId !== operationId) continue;
    return event;
  }
  return null;
}

// Full pre-mutation provenance validation for one frozen compaction
// operation (F2). Every field is checked BEFORE any DSH mutation; any
// mismatch returns { valid: false } (BLOCK/KEEP). No surface inspection is
// used to reconstruct authority -- the persisted record must prove itself.
function validateOperationForApply(operation, expected) {
  const fail = (reason) => ({ valid: false, reason });
  if (!operation || typeof operation !== 'object') return fail('operation-missing');
  if (!expected || typeof expected !== 'object') return fail('expectation-missing');
  if (Number(operation.schemaVersion) !== 1) return fail('operation-schema-mismatch');
  if (typeof operation.operationId !== 'string' || operation.operationId === '') return fail('operation-id-missing');
  // Derived identity, not free text: recompute the canonical operationId
  // from the bound task/session triple and require an exact match BEFORE
  // any mutation. A merely nonempty string is never sufficient.
  let expectedOperationId = null;
  try {
    expectedOperationId = deriveCanonicalOperationId(expected.taskId, expected.taskInstanceId, expected.sessionId);
  } catch { return fail('operation-id-derivation-failed'); }
  if (operation.operationId !== expectedOperationId) return fail('operation-id-mismatch');
  if (operation.taskId !== expected.taskId) return fail('task-id-mismatch');
  if (typeof operation.taskInstanceId !== 'string' || operation.taskInstanceId === '' || operation.taskInstanceId !== expected.taskInstanceId) {
    return fail('task-instance-mismatch');
  }
  if (typeof operation.sessionId !== 'string' || operation.sessionId === '' || operation.sessionId !== expected.sessionId) {
    return fail('session-id-mismatch');
  }
  if (typeof operation.workspace !== 'string' || operation.workspace === '' || operation.workspace !== expected.workspace) {
    return fail('workspace-mismatch');
  }
  if (expected.repositoryId !== null && expected.repositoryId !== undefined && expected.repositoryId !== '') {
    if (operation.repositoryId !== expected.repositoryId) return fail('repository-id-mismatch');
  }
  if (expected.checkoutId !== null && expected.checkoutId !== undefined && expected.checkoutId !== '') {
    if (operation.checkoutId !== expected.checkoutId) return fail('checkout-id-mismatch');
  }
  if (typeof operation.checkpointPath !== 'string' || operation.checkpointPath === '') return fail('checkpoint-identity-missing');
  const seqs = operation.sourceEventSeqs;
  if (!Array.isArray(seqs) || seqs.length === 0) return fail('source-seqs-missing');
  for (const seq of seqs) {
    if (!Number.isInteger(seq) || seq < 0) return fail('source-seq-malformed');
  }
  const unique = new Set(seqs);
  if (unique.size !== seqs.length) return fail('source-seqs-duplicate');
  if (operation.replacementStart !== seqs[0] || operation.replacementEnd !== seqs[seqs.length - 1]) {
    return fail('range-endpoint-mismatch');
  }
  const boundary = Number(operation.completionBoundarySeq);
  if (!Number.isInteger(boundary) || boundary < 0) return fail('completion-boundary-missing');
  for (const seq of seqs) {
    if (seq > boundary) return fail('source-seq-beyond-completion-boundary');
  }
  const segments = operation.segments;
  if (!Array.isArray(segments) || segments.length === 0) return fail('segments-missing');
  const union = [];
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') return fail('segment-malformed');
    if (segment.start !== segment.sourceEventSeqs[0] || segment.end !== segment.sourceEventSeqs[segment.sourceEventSeqs.length - 1]) {
      return fail('segment-endpoint-mismatch');
    }
    if (!Array.isArray(segment.sourceEventSeqs) || segment.sourceEventSeqs.length === 0) return fail('segment-seqs-missing');
    for (const seq of segment.sourceEventSeqs) {
      if (!Number.isInteger(seq) || seq < 0) return fail('segment-seq-malformed');
      union.push(seq);
    }
  }
  if (union.length !== seqs.length) return fail('segment-union-mismatch');
  for (let i = 0; i < seqs.length; i += 1) {
    if (union[i] !== seqs[i]) return fail('segment-union-mismatch');
  }
  // Closed-world ordering: segments strictly ordered, non-overlapping, and
  // every frozen seq inside the completion boundary (no foreign adoption).
  let previousEnd = -1;
  for (const segment of segments) {
    if (segment.start <= previousEnd) return fail('segment-overlap');
    if (segment.end < segment.start) return fail('segment-endpoint-mismatch');
    for (const seq of segment.sourceEventSeqs) {
      if (seq < segment.start || seq > segment.end) return fail('segment-ownership-mismatch');
      if (seq < 0 || seq > boundary) return fail('source-seq-beyond-completion-boundary');
    }
    previousEnd = segment.end;
  }
  for (let i = 1; i < seqs.length; i += 1) {
    if (seqs[i] <= seqs[i - 1]) return fail('source-seqs-unordered');
  }
  return { valid: true, reason: null };
}

// Canonical operation identity (mirrors New-AihContextCompactionOperationId
// byte-for-byte: domain LF taskId LF taskInstanceId LF sessionId, UTF-8,
// SHA-256 hex, first 32 chars, ccop_ prefix). The PS function is the
// derivation authority; this twin exists so the bridge can recompute and
// compare without spawning a CLI. Parity is proven by test.
const OPERATION_ID_DOMAIN = 'nexus/context-compaction-operation/v1';

function deriveCanonicalOperationId(taskId, taskInstanceId, sessionId) {
  const crypto = require('node:crypto');
  const joined = [OPERATION_ID_DOMAIN, String(taskId), String(taskInstanceId), String(sessionId)].join('\n');
  const digest = crypto.createHash('sha256').update(joined, 'utf8').digest('hex');
  return 'ccop_' + digest.slice(0, 32);
}

function checkpointProvenanceValid(checkpoint, binding) {
  if (!checkpoint || typeof checkpoint !== 'object') return { valid: false, reason: 'checkpoint-missing' };
  if (!binding || typeof binding !== 'object') return { valid: false, reason: 'binding-missing' };
  if (typeof checkpoint.taskInstanceId !== 'string' || checkpoint.taskInstanceId === '') {
    return { valid: false, reason: 'checkpoint-instance-missing' };
  }
  if (typeof binding.taskInstanceId !== 'string' || binding.taskInstanceId === '') {
    return { valid: false, reason: 'binding-instance-missing' };
  }
  if (checkpoint.taskInstanceId !== binding.taskInstanceId) {
    return { valid: false, reason: 'task-instance-mismatch' };
  }
  if (checkpoint.taskId !== binding.taskId) return { valid: false, reason: 'task-id-mismatch' };
  return { valid: true, reason: null };
}

function lastTextOfRole(session, role, maxChars) {
  if (!session || !Array.isArray(session.events) || (role !== 'user' && role !== 'assistant')) return '';
  const bound = Number.isFinite(Number(maxChars)) ? Math.max(64, Math.trunc(Number(maxChars))) : 4000;
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (!event) continue;
    if (role === 'user' && event.type !== 'user/message') continue;
    if (role === 'assistant' && event.type !== 'assistant/message') continue;
    const source = event.data && event.data.source;
    if (source && source.kind === 'plugin' && source.plugin === 'aih-controller') continue;
    const message = role === 'user' ? event.data : event.data && event.data.message;
    const content = message && Array.isArray(message.content) ? message.content : [];
    const texts = [];
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        texts.push(block.text);
      }
    }
    if (texts.length === 0) continue;
    const joined = texts.join('\n');
    return joined.length > bound ? joined.slice(0, bound) + '...<truncated>' : joined;
  }
  return '';
}

// F7 event-time apply boundary: the maximum turn:step the authoritative
// live session has PRODUCED at apply, independent of whether usage
// accounting has finished persisting it. Pressure lastStepId alone is NOT
// sufficient (a produced-but-unpersisted pre-apply event would slip past).
// Pure, engine-neutral, no I/O. Returns '' when no parseable order exists.
function compareStepId(a, b) {
  const pa = String(a || '').split(':');
  const pb = String(b || '').split(':');
  if (pa.length !== 2 || pb.length !== 2) return null;
  const at = Number(pa[0]); const as = Number(pa[1]);
  const bt = Number(pb[0]); const bs = Number(pb[1]);
  if (!Number.isInteger(at) || !Number.isInteger(as) || !Number.isInteger(bt) || !Number.isInteger(bs)) return null;
  if (at !== bt) return at > bt ? 1 : -1;
  if (as !== bs) return as > bs ? 1 : -1;
  return 0;
}
function maxStepIdOfSession(session) {
  if (!session || !Array.isArray(session.events)) return '';
  let best = '';
  for (const event of session.events) {
    if (!event || !event.data) continue;
    const turn = event.data.turn;
    const step = event.data.step;
    if (turn === undefined || turn === null || step === undefined || step === null) continue;
    if (String(turn).trim() === '' || String(step).trim() === '') continue;
    const id = String(turn) + ':' + String(step);
    if (best === '') { best = id; continue; }
    const cmp = compareStepId(id, best);
    if (cmp !== null && cmp > 0) best = id;
  }
  return best;
}
// ══════════════════════════════════════════════════════════════════════
// CCV2-A02 — durable multi-generation operation foundation (V2).
//
// V1 helpers above are UNCHANGED (compatibility baseline). Everything below
// lives in an explicit V2 domain: schemaVersion 2, a separate operation-ID
// domain, and a separate persistence filename. V1 validation, derivation,
// and stored operations are never reinterpreted as V2 (schema branching).
//
// Ordering invariant (HARD): construct → closed-world validate → atomic
// persist → prove persisted operation readable/valid → ONLY THEN mutate.
// applyCompactionOperationV2 enforces this by requiring the durable
// read-back object (byte-identical) before the first session.append.
// ══════════════════════════════════════════════════════════════════════

// Generation-aware V2 operation identity domain. V1
// ('nexus/context-compaction-operation/v1') is unchanged; the domain string
// difference alone makes V1 and V2 IDs never ambiguously interchangeable.
const OPERATION_ID_DOMAIN_V2 = 'nexus/context-compaction-operation/v2';

// V2 operation lifecycle. APPLIED requires durable evidence; in-memory
// projection presence alone is insufficient (see reconcile below).
const OPERATION_V2_LIFECYCLES = Object.freeze(['frozen', 'applying', 'awaiting-durability', 'applied', 'blocked']);
const OPERATION_V2_FILENAME = 'context-compaction-operation-v2.json';
const ATTEMPT_V2_FILE_PREFIX = 'context-compaction-attempt-v2-';

// Canonical V2 operation identity (PS twin: New-AihContextCompactionOperationIdV2).
// Serialization: domain LF taskId LF taskInstanceId LF sessionId LF generation
// LF checkpointId, UTF-8, SHA-256 hex, first 32 chars, ccop_ prefix.
function deriveCanonicalOperationIdV2(taskId, taskInstanceId, sessionId, generation, checkpointId) {
  if (typeof taskId !== 'string' || taskId === '') throw new Error('v2-operation-id: taskId is required');
  if (typeof taskInstanceId !== 'string' || taskInstanceId === '') throw new Error('v2-operation-id: taskInstanceId is required');
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('v2-operation-id: sessionId is required');
  if (!Number.isInteger(generation) || generation < 1) throw new Error('v2-operation-id: generation must be a positive integer');
  if (typeof checkpointId !== 'string' || checkpointId === '') throw new Error('v2-operation-id: checkpointId is required');
  const crypto = require('node:crypto');
  const joined = [OPERATION_ID_DOMAIN_V2, String(taskId), String(taskInstanceId), String(sessionId), String(generation), String(checkpointId)].join('\n');
  const digest = crypto.createHash('sha256').update(joined, 'utf8').digest('hex');
  return 'ccop_' + digest.slice(0, 32);
}

function sha256HexUtf8(text) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// Bounded identity-only continuation anchor. Carries operation identity only:
// NEVER checkpoint body, task description, requirements, constraints,
// repository state, verification details, runtime policy, logs, semantic
// summaries, or reasoning.
function buildContinuationAnchorText(operationId, generation, segmentIndex, segmentCount) {
  if (typeof operationId !== 'string' || operationId === '' || /["<>]/.test(operationId)) {
    throw new Error('continuation-anchor: operationId must be a bounded identity token');
  }
  if (!Number.isInteger(generation) || generation < 1) throw new Error('continuation-anchor: generation must be a positive integer');
  if (!Number.isInteger(segmentIndex) || !Number.isInteger(segmentCount) || segmentIndex < 0 || segmentIndex >= segmentCount || segmentCount < 1) {
    throw new Error('continuation-anchor: segment index out of range');
  }
  return '<nexus-context-continuation operation="' + operationId + '" generation="' + generation
    + '" segment="' + (segmentIndex + 1) + '/' + segmentCount + '"/>';
}

// Assign explicit segment roles: exactly ONE payload segment (the earliest),
// every other segment is a continuation. Rejects anything else.
function shapeSegmentsWithRoles(shaped) {
  if (!Array.isArray(shaped) || shaped.length === 0) throw new Error('v2-segments: at least one segment is required');
  return shaped.map((segment, index) => {
    if (!segment || typeof segment !== 'object') throw new Error('v2-segments: segment-malformed');
    return {
      start: segment.start,
      end: segment.end,
      sourceEventSeqs: Array.isArray(segment.sourceEventSeqs) ? segment.sourceEventSeqs.slice() : [],
      role: index === 0 ? 'payload' : 'continuation',
    };
  });
}

// Host-grounded current-runtime-snapshot rule (B2, Option A support):
// the LAST host-owned runtime-context node on the LIVE surface, identified
// by surface/event ordering plus DSH projection ownership/provenance only.
// NEVER semantic text matching. Returns the seq, or null when no host-owned
// runtime snapshot is live.
function currentRuntimeSnapshotSeqOf(session) {
  const nodes = surfaceNodesOf(session);
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = eventBySeq(session, nodes[index]);
    if (!event) return null;
    if (isRuntimeContextMessage(event)) return nodes[index];
  }
  return null;
}

// Apply-time revalidation gate (Option A safety): the current host runtime
// snapshot must still be the one pinned at plan time. A newer host snapshot
// committed between plan and apply means the frozen plan no longer pins the
// true current policy → BLOCK/KEEP (never shadow a snapshot that became
// current after planning, never widen). Returns { ok, reason }.
function currentRuntimeSnapshotUnchanged(session, pinnedSeq, sourceSeqs) {
  const current = currentRuntimeSnapshotSeqOf(session);
  if (current === pinnedSeq) return { ok: true, reason: null };
  if (pinnedSeq === null || pinnedSeq === undefined) {
    // Nothing was pinned at plan time: the plan is still safe iff no
    // current snapshot exists, or the current one lies outside the frozen
    // source set (retained tail, untouched by the plan).
    if (current === null) return { ok: true, reason: null };
    const frozen = Array.isArray(sourceSeqs) ? sourceSeqs : [];
    return frozen.includes(current)
      ? { ok: false, reason: 'runtime-snapshot-changed' }
      : { ok: true, reason: null };
  }
  return { ok: false, reason: 'runtime-snapshot-changed' };
}

// V2 segment planner (Option A): split the shadowed range ONLY around the
// CURRENT host-owned runtime snapshot. Strictly-superseded (non-last) host
// snapshots inside the range are shadowed with the bulk. Nexus authors zero
// runtime snapshots; the current snapshot is pinned (excluded), never cited
// as a source seq. Returns null when no bulk remains or tool-pair safety
// fails (KEEP).
function planCompactionSegmentsV2(session, shadowedSeqs, options) {
  if (!Array.isArray(shadowedSeqs) || shadowedSeqs.length === 0) return null;
  // Segments are contiguous runs in SURFACE order: the host span
  // [start, end] is defined by surface positions, so only a surface-ordered
  // run is a valid replacement span (past generations interleave replacement
  // seqs with older live seqs on the surface). Runs are sorted by start seq
  // into the canonical frozen order; each run keeps its surface-application
  // order. The frozen sourceEventSeqs are the ascending-sorted union (see
  // validateCompactionOperationV2: set-partition semantics).
  const current = currentRuntimeSnapshotSeqOf(session);
  const owned = current === null || current === undefined ? [] : [current];
  const shaped = splitRangeAroundOwned(session, shadowedSeqs, owned);
  if (!shaped) return null;
  shaped.sort((a, b) => a.start - b.start);
  const staleShadowed = runtimeContextSeqsOf(session).filter((seq) => shadowedSeqs.includes(seq) && seq !== current);
  return {
    segments: shaped,
    currentRuntimeSeq: current,
    shadowedStaleRuntimeSeqs: staleShadowed,
    pinnedCurrentRuntimeSeq: current !== null && shadowedSeqs.includes(current) ? current : null,
  };
}

// Closed-world V2 validation (task section 8 + architecture 3.8).
// Any failure → { valid: false } (BLOCK/KEEP) before any mutation.
function validateCompactionOperationV2(operation, expected) {
  const fail = (reason) => ({ valid: false, reason });
  if (!operation || typeof operation !== 'object') return fail('operation-missing');
  if (!expected || typeof expected !== 'object') return fail('expectation-missing');
  if (Number(operation.schemaVersion) !== 2) return fail('operation-schema-mismatch');
  if (typeof operation.operationId !== 'string' || operation.operationId === '') return fail('operation-id-missing');
  if (typeof operation.attemptId !== 'string' || operation.attemptId === '') return fail('attempt-id-missing');
  if (typeof operation.taskId !== 'string' || operation.taskId === '' || operation.taskId !== expected.taskId) return fail('task-id-mismatch');
  if (typeof operation.taskInstanceId !== 'string' || operation.taskInstanceId === '' || operation.taskInstanceId !== expected.taskInstanceId) {
    return fail('task-instance-mismatch');
  }
  if (typeof operation.sessionId !== 'string' || operation.sessionId === '' || operation.sessionId !== expected.sessionId) {
    return fail('session-id-mismatch');
  }
  if (typeof operation.workspace !== 'string' || operation.workspace === '' || operation.workspace !== expected.workspace) {
    return fail('workspace-mismatch');
  }
  if (expected.repositoryId !== null && expected.repositoryId !== undefined && expected.repositoryId !== '') {
    if (operation.repositoryId !== expected.repositoryId) return fail('repository-id-mismatch');
  }
  if (expected.checkoutId !== null && expected.checkoutId !== undefined && expected.checkoutId !== '') {
    if (operation.checkoutId !== expected.checkoutId) return fail('checkout-id-mismatch');
  }
  if (!Number.isInteger(operation.checkpointGeneration) || operation.checkpointGeneration < 1) return fail('checkpoint-generation-invalid');
  if (typeof operation.checkpointId !== 'string' || operation.checkpointId === '') return fail('checkpoint-identity-missing');
  if (expected.checkpointGeneration !== null && expected.checkpointGeneration !== undefined) {
    if (operation.checkpointGeneration !== expected.checkpointGeneration) return fail('checkpoint-generation-mismatch');
  }
  if (expected.checkpointId !== null && expected.checkpointId !== undefined && expected.checkpointId !== '') {
    if (operation.checkpointId !== expected.checkpointId) return fail('checkpoint-identity-mismatch');
  }
  // Generation-aware derived identity, recomputed on every validation.
  let expectedOperationId = null;
  try {
    expectedOperationId = deriveCanonicalOperationIdV2(
      expected.taskId, expected.taskInstanceId, expected.sessionId,
      operation.checkpointGeneration, operation.checkpointId);
  } catch { return fail('operation-id-derivation-failed'); }
  if (operation.operationId !== expectedOperationId) return fail('operation-id-mismatch');
  // snapshotTokenId: null in A02 (no SnapshotToken implementation yet;
  // explicit temporary semantics per architecture). A non-null value must be
  // a non-empty token string.
  if (operation.snapshotTokenId !== null && operation.snapshotTokenId !== undefined) {
    if (typeof operation.snapshotTokenId !== 'string' || operation.snapshotTokenId === '') return fail('snapshot-token-invalid');
  }
  const boundary = Number(operation.safePointBoundarySeq);
  if (!Number.isInteger(boundary) || boundary < 0) return fail('safe-point-boundary-missing');
  const seqs = operation.sourceEventSeqs;
  if (!Array.isArray(seqs) || seqs.length === 0) return fail('source-seqs-missing');
  for (const seq of seqs) {
    if (!Number.isInteger(seq) || seq < 0) return fail('source-seq-malformed');
  }
  if (new Set(seqs).size !== seqs.length) return fail('source-seqs-duplicate');
  for (let i = 1; i < seqs.length; i += 1) {
    if (seqs[i] <= seqs[i - 1]) return fail('source-seqs-unordered');
  }
  for (const seq of seqs) {
    if (seq > boundary) return fail('source-seq-beyond-safe-point-boundary');
  }
  const segments = operation.segments;
  if (!Array.isArray(segments) || segments.length === 0) return fail('segments-missing');
  const KNOWN_ROLES = new Set(['payload', 'continuation']);
  let payloadCount = 0;
  const union = [];
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') return fail('segment-malformed');
    if (typeof segment.role !== 'string' || !KNOWN_ROLES.has(segment.role)) {
      return segment.role === undefined ? fail('segment-role-missing') : fail('segment-role-unknown');
    }
    if (segment.role === 'payload') payloadCount += 1;
    if (!Array.isArray(segment.sourceEventSeqs) || segment.sourceEventSeqs.length === 0) return fail('segment-seqs-missing');
    if (!Number.isInteger(segment.start) || !Number.isInteger(segment.end)) return fail('segment-endpoint-mismatch');
    if (segment.start !== segment.sourceEventSeqs[0] || segment.end !== segment.sourceEventSeqs[segment.sourceEventSeqs.length - 1]) {
      return fail('segment-endpoint-mismatch');
    }
    for (const seq of segment.sourceEventSeqs) {
      if (!Number.isInteger(seq) || seq < 0) return fail('segment-seq-malformed');
      union.push(seq);
    }
  }
  if (payloadCount !== 1) return payloadCount === 0 ? fail('payload-segment-missing') : fail('payload-segment-duplicate');
  // Canonical segment order: strictly ascending by start seq (deterministic
  // frozen form; multi-generation surfaces interleave seqs, so segments are
  // surface-application runs listed in start order).
  let previousStart = -1;
  for (const segment of segments) {
    if (segment.start <= previousStart) return fail('segments-unordered');
    previousStart = segment.start;
  }
  // Non-overlap: segment source sets are pairwise disjoint (set partition).
  const seen = new Set();
  for (const segment of segments) {
    for (const seq of segment.sourceEventSeqs) {
      if (seen.has(seq)) return fail('segment-overlap');
      seen.add(seq);
    }
  }
  // Exact coverage: the union multiset, ascending-sorted, equals the frozen
  // sourceEventSeqs (every frozen seq in exactly one segment and vice versa).
  const sortedUnion = union.slice().sort((a, b) => a - b);
  if (sortedUnion.length !== seqs.length) return fail('segment-union-mismatch');
  for (let i = 0; i < seqs.length; i += 1) {
    if (sortedUnion[i] !== seqs[i]) return fail('segment-union-mismatch');
  }
  for (const segment of segments) {
    for (const seq of segment.sourceEventSeqs) {
      if (seq > boundary) return fail('source-seq-beyond-safe-point-boundary');
    }
  }
  if (!OPERATION_V2_LIFECYCLES.includes(operation.lifecycle)) return fail('lifecycle-invalid');
  return { valid: true, reason: null };
}

// Concatenated text content of one session event (for landing comparison).
function textContentOfEvent(event) {
  if (!event || !event.data) return '';
  const containers = [];
  if (event.data.message && Array.isArray(event.data.message.content)) containers.push(event.data.message.content);
  if (Array.isArray(event.data.content)) containers.push(event.data.content);
  const texts = [];
  for (const content of containers) {
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  return texts.join('\n');
}

function nexusReplacementEventsOf(session, operationId) {
  const found = [];
  if (!session || !Array.isArray(session.events)) return found;
  for (const event of session.events) {
    if (!event || event.type !== 'user/message') continue;
    const source = event.data && event.data.source;
    if (!source || source.kind !== 'plugin' || source.plugin !== 'aih-controller') continue;
    if (source.operationId !== operationId) continue;
    found.push(event);
  }
  return found;
}

// Nexus-side reconciliation of ONE frozen operation against the live session.
// Never re-plans: every decision cites the frozen segments verbatim.
//
// options: { payloadText, durable (boolean: flush participated / durable
//   bytes prove the replacements) }. Continuation anchors are re-derived
// from the frozen operation identity (never trusted from the session).
// Returns { decision, reason, segmentStatus, missingSegments } where decision
// is one of: apply | retry-missing | awaiting-durability | applied | block.
// Per-segment status is NOT_LANDED | LANDED_EXPECTED |
// LANDED_FOREIGN_OR_CORRUPT.
function reconcileCompactionOperationV2(operation, session, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const blocked = (reason, extra) => Object.assign({
    decision: 'block', reason, segmentStatus: [], missingSegments: [],
  }, extra);
  if (!operation || typeof operation !== 'object') return blocked('operation-missing');
  if (Number(operation.schemaVersion) !== 2) return blocked('operation-schema-mismatch');
  const segments = Array.isArray(operation.segments) ? operation.segments : [];
  if (segments.length === 0) return blocked('segments-missing');
  if (typeof opts.payloadText !== 'string' || opts.payloadText === '') return blocked('payload-unproven');
  const expectedDigest = sha256HexUtf8(opts.payloadText);
  if (operation.checkpointContentDigest !== expectedDigest) return blocked('checkpoint-digest-mismatch');
  const liveSet = new Set(surfaceNodesOf(session));
  const cited = nexusReplacementEventsOf(session, operation.operationId);
  const payloadNodes = cited.filter((e) => e.data && e.data.source && e.data.source.form === 'context-checkpoint');
  const anchorNodes = cited.filter((e) => e.data && e.data.source && e.data.source.form === 'context-continuation');
  const segmentStatus = [];
  const payloadIndexes = segments.map((s, i) => (s && s.role === 'payload' ? i : -1)).filter((i) => i >= 0);
  if (payloadIndexes.length === 0) return blocked('payload-segment-missing');
  if (payloadIndexes.length !== 1) return blocked('payload-segment-duplicate');
  const payloadIndex = payloadIndexes[0];
  if (payloadNodes.length === 0) {
    segmentStatus[payloadIndex] = 'NOT_LANDED';
  } else if (payloadNodes.length === 1 && sha256HexUtf8(textContentOfEvent(payloadNodes[0])) === expectedDigest) {
    segmentStatus[payloadIndex] = 'LANDED_EXPECTED';
  } else {
    for (let i = 0; i < segments.length; i += 1) segmentStatus[i] = 'LANDED_FOREIGN_OR_CORRUPT';
    return blocked('foreign-or-corrupt-payload-landing', { segmentStatus, citedCount: cited.length });
  }
  // Continuation segments: LANDED_EXPECTED iff the exact bounded anchor for
  // THAT segment slot is cited exactly once. Anchors for sibling slots are
  // legitimate; an anchor citing this operation that matches NO expected slot
  // is FOREIGN (do not improvise). A duplicated slot anchor is FOREIGN.
  const expectedAnchors = new Map();
  for (let index = 0; index < segments.length; index += 1) {
    if (index === payloadIndex) continue;
    try {
      expectedAnchors.set(index, buildContinuationAnchorText(operation.operationId, operation.checkpointGeneration, index, segments.length));
    } catch { return blocked('anchor-derivation-failed'); }
  }
  const expectedAnchorTexts = new Set(expectedAnchors.values());
  const strayAnchors = anchorNodes.filter((e) => !expectedAnchorTexts.has(textContentOfEvent(e)));
  if (strayAnchors.length > 0) {
    for (let i = 0; i < segments.length; i += 1) segmentStatus[i] = segmentStatus[i] || 'LANDED_FOREIGN_OR_CORRUPT';
    return blocked('foreign-or-corrupt-continuation-landing', { segmentStatus, citedCount: cited.length });
  }
  for (const [index, expectedAnchor] of expectedAnchors) {
    const matches = anchorNodes.filter((e) => textContentOfEvent(e) === expectedAnchor);
    if (matches.length === 1) {
      segmentStatus[index] = 'LANDED_EXPECTED';
    } else if (matches.length === 0) {
      segmentStatus[index] = 'NOT_LANDED';
    } else {
      for (let i = 0; i < segments.length; i += 1) segmentStatus[i] = segmentStatus[i] || 'LANDED_FOREIGN_OR_CORRUPT';
      segmentStatus[index] = 'LANDED_FOREIGN_OR_CORRUPT';
      return blocked('foreign-or-corrupt-continuation-landing', { segmentStatus, citedCount: cited.length });
    }
  }
  // Cross-check: a segment whose source seqs are still fully live cannot be
  // LANDED_EXPECTED. A fully shadowed segment with no citation is reconciled
  // as landed only when 'durable' proves it (crash-after-flush-before-finalize);
  // otherwise BLOCK (never infer durability from memory).
  for (let index = 0; index < segments.length; index += 1) {
    const seqs = segments[index].sourceEventSeqs;
    const stillLive = seqs.filter((seq) => liveSet.has(seq));
    if (segmentStatus[index] === 'LANDED_EXPECTED' && stillLive.length === seqs.length && seqs.length > 0) {
      return blocked('landing-claims-shadowed-live-source', { segmentStatus });
    }
    if (segmentStatus[index] === 'NOT_LANDED' && stillLive.length === 0 && seqs.length > 0) {
      if (opts.durable === true) {
        segmentStatus[index] = 'LANDED_EXPECTED';
      } else {
        return blocked('shadowed-source-without-citation', { segmentStatus });
      }
    }
  }
  const missingSegments = [];
  for (let index = 0; index < segments.length; index += 1) {
    if (segmentStatus[index] === 'NOT_LANDED') missingSegments.push(index);
  }
  if (missingSegments.length === segments.length) {
    return { decision: 'apply', reason: 'none-landed-apply-frozen-operation', segmentStatus, missingSegments };
  }
  if (missingSegments.length > 0) {
    return { decision: 'retry-missing', reason: 'partial-landing-retry-exact-missing-only', segmentStatus, missingSegments };
  }
  if (opts.durable !== true) {
    return { decision: 'awaiting-durability', reason: 'all-landed-but-durability-unproven', segmentStatus, missingSegments };
  }
  return { decision: 'applied', reason: 'durable-intended-projection-reconciled', segmentStatus, missingSegments };
}

// Atomic durable persistence (repository atomic-write discipline: temp file
// in the same directory + rename). Freezes the exact operation plan.
// Returns the read-back object; throws (KEEP) on any write/readback failure.
function operationV2FilePath(dir) {
  const path = require('node:path');
  return path.join(dir, OPERATION_V2_FILENAME);
}

function persistCompactionOperationV2(dir, operation) {
  const fs = require('node:fs');
  const path = require('node:path');
  if (typeof dir !== 'string' || dir === '') throw new Error('v2-persist: dir is required');
  if (!operation || typeof operation !== 'object') throw new Error('v2-persist: operation is required');
  if (Number(operation.schemaVersion) !== 2) throw new Error('v2-persist: refusing non-V2 operation (KEEP)');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, OPERATION_V2_FILENAME);
  const tmp = path.join(dir, OPERATION_V2_FILENAME + '.tmp-' + process.pid + '-' + Date.now());
  const bytes = Buffer.from(JSON.stringify(operation, null, 2), 'utf8');
  fs.writeFileSync(tmp, bytes);
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw new Error('v2-persist: atomic rename failed (KEEP): ' + (error && error.message ? error.message : error));
  }
  return readCompactionOperationV2(dir);
}

function readCompactionOperationV2(dir) {
  const fs = require('node:fs');
  const path = require('node:path');
  const target = path.join(dir, OPERATION_V2_FILENAME);
  if (!fs.existsSync(target)) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    throw new Error('v2-read: operation file is malformed (BLOCK/KEEP)');
  }
  if (!parsed || typeof parsed !== 'object' || Number(parsed.schemaVersion) !== 2) {
    throw new Error('v2-read: operation file is not a V2 operation (BLOCK/KEEP)');
  }
  return parsed;
}

// freezeCompactionOperationV2: construct → closed-world validate → atomic
// persist → prove persisted operation readable/valid. Returns the durable
// read-back. The mutation path MUST call this (or prove an identical prior
// call) before the first session.append.
function freezeCompactionOperationV2(dir, draft, expected) {
  const check = validateCompactionOperationV2(draft, expected);
  if (!check.valid) throw new Error('v2-freeze: operation refused (' + check.reason + ') (KEEP)');
  const durable = persistCompactionOperationV2(dir, draft);
  const recheck = validateCompactionOperationV2(durable, expected);
  if (!recheck.valid) throw new Error('v2-freeze: read-back refused (' + recheck.reason + ') (KEEP)');
  if (JSON.stringify(durable) !== JSON.stringify(draft)) throw new Error('v2-freeze: read-back differs from draft (KEEP)');
  return durable;
}

let v2MessageCounter = 0;
function v2UserMessageNode(text, source) {
  v2MessageCounter += 1;
  return { id: 'msg-ccv2-' + sha256HexUtf8(String(text) + '|' + v2MessageCounter).slice(0, 12), role: 'user', content: [{ type: 'text', text: String(text) }], source };
}

// V2 bridge apply: payload segment → full checkpoint replacement;
// continuation segment → identity-only anchor. NEVER one payload per segment.
// Requires the durable read-back (byte-identical) to prove
// durable-before-mutation; throws otherwise (no append happens first).
function applyCompactionOperationV2(session, operation, payloadText, durableOp) {
  if (!session || typeof session.append !== 'function') throw new Error('v2-apply: session append seam is required');
  if (!operation || typeof operation !== 'object') throw new Error('v2-apply: operation is required');
  if (typeof payloadText !== 'string' || payloadText === '') throw new Error('v2-apply: payload text is required');
  if (!durableOp || JSON.stringify(durableOp) !== JSON.stringify(operation)) {
    throw new Error('v2-apply: durable frozen operation required before mutation (KEEP)');
  }
  if (sha256HexUtf8(payloadText) !== operation.checkpointContentDigest) {
    throw new Error('v2-apply: payload digest mismatch (KEEP)');
  }
  const segments = operation.segments;
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('v2-apply: segments-missing (KEEP)');
  if (segments.filter((s) => s && s.role === 'payload').length !== 1) {
    throw new Error('v2-apply: exactly one payload segment is required (KEEP)');
  }
  const landed = [];
  segments.forEach((segment, index) => {
    if (!segment || (segment.role !== 'payload' && segment.role !== 'continuation')) {
      throw new Error('v2-apply: segment-role-unknown (KEEP)');
    }
    const isPayload = segment.role === 'payload';
    const text = isPayload ? payloadText : buildContinuationAnchorText(operation.operationId, operation.checkpointGeneration, index, segments.length);
    const source = isPayload
      ? { kind: 'plugin', plugin: 'aih-controller', form: 'context-checkpoint', operationId: operation.operationId, generation: operation.checkpointGeneration, taskInstanceId: operation.taskInstanceId }
      : { kind: 'plugin', plugin: 'aih-controller', form: 'context-continuation', operationId: operation.operationId, generation: operation.checkpointGeneration };
    const node = session.append('user/message', v2UserMessageNode(text, source), {
      surfaceOp: { op: 'replace', start: segment.start, end: segment.end },
      sourceEventSeqs: segment.sourceEventSeqs.slice(),
    });
    landed.push({ seq: node.seq, role: segment.role, segmentIndex: index });
  });
  return { landed, nextLifecycle: 'awaiting-durability' };
}

// Apply ONLY the exact missing segments of a reconciled partial landing.
// Never appends another payload when the payload already landed.
function retryMissingSegmentsV2(session, operation, payloadText, durableOp, missingSegments) {
  if (!Array.isArray(missingSegments) || missingSegments.length === 0) throw new Error('v2-retry: missingSegments is required');
  if (!durableOp || JSON.stringify(durableOp) !== JSON.stringify(operation)) {
    throw new Error('v2-retry: durable frozen operation required before mutation (KEEP)');
  }
  const segments = operation.segments;
  const landed = [];
  for (const index of missingSegments) {
    const segment = segments[index];
    if (!segment) throw new Error('v2-retry: unknown segment index (KEEP)');
    const isPayload = segment.role === 'payload';
    const text = isPayload ? payloadText : buildContinuationAnchorText(operation.operationId, operation.checkpointGeneration, index, segments.length);
    const source = isPayload
      ? { kind: 'plugin', plugin: 'aih-controller', form: 'context-checkpoint', operationId: operation.operationId, generation: operation.checkpointGeneration, taskInstanceId: operation.taskInstanceId }
      : { kind: 'plugin', plugin: 'aih-controller', form: 'context-continuation', operationId: operation.operationId, generation: operation.checkpointGeneration };
    const node = session.append('user/message', v2UserMessageNode(text, source), {
      surfaceOp: { op: 'replace', start: segment.start, end: segment.end },
      sourceEventSeqs: segment.sourceEventSeqs.slice(),
    });
    landed.push({ seq: node.seq, role: segment.role, segmentIndex: index });
  }
  return { landed, nextLifecycle: 'awaiting-durability' };
}

// Minimal A02 attempt record: distinguishes a CompactionAttempt from an
// applied checkpoint generation. A failed/blocked/crashed attempt never
// fabricates a generation. Append-only per-attempt files; a finished attempt
// (applied/blocked) is never edited.
const ATTEMPT_V2_STATES = Object.freeze(['inactive', 'eligible', 'checkpoint-ready', 'apply-pending', 'awaiting-durability', 'applied', 'blocked']);
const ATTEMPT_V2_TRANSITIONS = Object.freeze({
  inactive: ['eligible', 'blocked'],
  eligible: ['checkpoint-ready', 'blocked'],
  'checkpoint-ready': ['apply-pending', 'blocked'],
  'apply-pending': ['awaiting-durability', 'blocked'],
  'awaiting-durability': ['applied', 'apply-pending', 'blocked'],
  applied: [],
  blocked: [],
});

function createCompactionAttemptV2(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  for (const key of ['attemptId', 'operationId', 'taskId', 'taskInstanceId', 'sessionId']) {
    if (typeof f[key] !== 'string' || f[key] === '') throw new Error('v2-attempt: ' + key + ' is required');
  }
  if (!Number.isInteger(f.generation) || f.generation < 1) throw new Error('v2-attempt: generation must be a positive integer');
  return {
    schemaVersion: 1,
    attemptId: f.attemptId,
    operationId: f.operationId,
    taskId: f.taskId,
    taskInstanceId: f.taskInstanceId,
    sessionId: f.sessionId,
    generation: f.generation,
    state: 'inactive',
    snapshotTokenId: f.snapshotTokenId === undefined ? null : f.snapshotTokenId,
    planId: f.planId === undefined ? null : f.planId,
    startedAtUtc: new Date().toISOString(),
    finishedAtUtc: null,
    result: 'in-progress',
    reason: null,
  };
}

function transitionCompactionAttemptV2(attempt, to, reason) {
  if (!attempt || typeof attempt !== 'object') throw new Error('v2-attempt: attempt is required');
  const from = attempt.state;
  if (!ATTEMPT_V2_TRANSITIONS[from] || !ATTEMPT_V2_TRANSITIONS[from].includes(to)) {
    throw new Error('v2-attempt: illegal transition ' + from + ' -> ' + to + ' (KEEP)');
  }
  const next = Object.assign({}, attempt, { state: to, reason: reason === undefined ? null : String(reason) });
  if (to === 'applied' || to === 'blocked') {
    next.finishedAtUtc = new Date().toISOString();
    next.result = to === 'applied' ? 'applied' : 'blocked';
  }
  return next;
}

function attemptV2FilePath(dir, attemptId) {
  const path = require('node:path');
  return path.join(dir, ATTEMPT_V2_FILE_PREFIX + String(attemptId) + '.json');
}

function persistCompactionAttemptV2(dir, attempt) {
  const fs = require('node:fs');
  if (typeof dir !== 'string' || dir === '') throw new Error('v2-attempt-persist: dir is required');
  if (!attempt || typeof attempt !== 'object') throw new Error('v2-attempt-persist: attempt is required');
  fs.mkdirSync(dir, { recursive: true });
  const target = attemptV2FilePath(dir, attempt.attemptId);
  if (fs.existsSync(target)) {
    const prior = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (prior && (prior.state === 'applied' || prior.state === 'blocked')) {
      throw new Error('v2-attempt-persist: finished attempt is immutable (KEEP)');
    }
  }
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, Buffer.from(JSON.stringify(attempt, null, 2), 'utf8'));
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw new Error('v2-attempt-persist: atomic rename failed (KEEP)');
  }
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

module.exports = {
  OPERATION_ID_DOMAIN,
  deriveCanonicalOperationId,
  RUNTIME_CONTEXT_PLUGIN,
  isRuntimeContextMessage,
  runtimeContextSeqsOf,
  withoutSeqs,
  splitRangeAroundOwned,
  validateOperationForApply,
  findReplacementByOperation,
  ROOT_ENGINE_ROLES,
  effectiveInputTokensOf,
  isWorkerSession,
  rootUsageCandidateOf,
  toolCallDeltaOfSurfaceEvent,
  surfaceNodesOf,
  balancedRetainCut,
  checkpointProvenanceValid,
  lastTextOfRole, compareStepId, maxStepIdOfSession,
  OPERATION_ID_DOMAIN_V2,
  OPERATION_V2_LIFECYCLES,
  OPERATION_V2_FILENAME,
  ATTEMPT_V2_STATES,
  deriveCanonicalOperationIdV2,
  sha256HexUtf8,
  buildContinuationAnchorText,
  shapeSegmentsWithRoles,
  currentRuntimeSnapshotSeqOf,
  currentRuntimeSnapshotUnchanged,
  planCompactionSegmentsV2,
  validateCompactionOperationV2,
  textContentOfEvent,
  nexusReplacementEventsOf,
  reconcileCompactionOperationV2,
  operationV2FilePath,
  persistCompactionOperationV2,
  readCompactionOperationV2,
  freezeCompactionOperationV2,
  applyCompactionOperationV2,
  retryMissingSegmentsV2,
  createCompactionAttemptV2,
  transitionCompactionAttemptV2,
  attemptV2FilePath,
  persistCompactionAttemptV2,
};
