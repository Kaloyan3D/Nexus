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
    if (!prefixBalanced[index]) break;
    const event = eventBySeq(session, nodes[index]);
    if (!event) return null;
    const nextChars = tailChars + textLengthOfSurfaceEvent(event);
    if (nextChars > maxTailChars && tailStart !== -1) break;
    tailChars = nextChars;
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
