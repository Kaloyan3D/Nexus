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
    if (tailChars > maxTailChars && tailStart !== -1) break;
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

module.exports = {
  RUNTIME_CONTEXT_PLUGIN,
  isRuntimeContextMessage,
  runtimeContextSeqsOf,
  withoutSeqs,
  splitRangeAroundOwned,
  findReplacementByOperation,
  ROOT_ENGINE_ROLES,
  effectiveInputTokensOf,
  isWorkerSession,
  rootUsageCandidateOf,
  toolCallDeltaOfSurfaceEvent,
  surfaceNodesOf,
  balancedRetainCut,
  checkpointProvenanceValid,
  lastTextOfRole,
};
