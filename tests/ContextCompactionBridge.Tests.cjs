'use strict';

/**
 * ContextCompactionBridge.Tests.cjs - Context Compaction V1 bridge-plane tests.
 *
 * Fully OFFLINE: every scenario runs against the pure helper module
 * (config/ContextCompaction.cjs) plus source-static assertions. No DSH host,
 * no network, no model calls.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));

let passed = 0;
function pass(name) { passed += 1; console.log('PASS: ' + name); }

function usageEvent(usage, turn, step) {
  return { type: 'assistant/chunk', data: { turn, step, chunk: { type: 'usage', usage } } };
}
// ── effective input signal ───────────────────────────────────────────────
assert.equal(compaction.effectiveInputTokensOf({ uncachedInputTokens: 90000, cacheReadTokens: 40000, usageAvailable: true }), 130000);
pass('effective input is uncached plus cache-read');
assert.equal(compaction.effectiveInputTokensOf({ uncachedInputTokens: 10, usageAvailable: true }), 10);
pass('missing cache-read defaults to zero, never NaN');
assert.equal(compaction.effectiveInputTokensOf({ usageAvailable: false }), null);
pass('unavailable usage yields no signal (never fabricated)');
assert.equal(compaction.effectiveInputTokensOf(null), null);
pass('missing usage yields no signal');

// ── root candidacy: muse main counted ──────────────────────────────────────
const museCandidate = compaction.rootUsageCandidateOf(
  usageEvent({ inputTokens: 90000, cacheReadTokens: 40000, outputTokens: 500 }, 9, 1),
  { engine: 'muse', role: 'muse_main', isWorker: false },
);
assert.ok(museCandidate);
assert.equal(museCandidate.engineRole, 'muse_main');
assert.equal(museCandidate.effectiveInputTokens, 130000);
assert.equal(museCandidate.stepId, '9:1');
pass('root muse usage is counted with the exact pressure signal');

const museNullRole = compaction.rootUsageCandidateOf(
  usageEvent({ inputTokens: 100, cacheReadTokens: 0, outputTokens: 5 }, 1, 1),
  { engine: 'muse', role: null, isWorker: false },
);
assert.ok(museNullRole && museNullRole.engineRole === 'muse_main');
pass('muse usage without a step role still counts as muse_main');

// ── root candidacy: dual normal/deep counted ───────────────────────────────
const normalCandidate = compaction.rootUsageCandidateOf(
  usageEvent({ inputTokens: 50000, cacheReadTokens: 10000, outputTokens: 20 }, 1, 1),
  { engine: 'dual', role: 'engineer_normal', isWorker: false },
);
assert.ok(normalCandidate && normalCandidate.engineRole === 'engineer_normal');
pass('root dual engineer_normal usage is counted');
const deepCandidate = compaction.rootUsageCandidateOf(
  usageEvent({ inputTokens: 20000, cacheReadTokens: 5000, outputTokens: 10 }, 1, 2),
  { engine: 'dual', role: 'engineer_deep', isWorker: false },
);
assert.ok(deepCandidate && deepCandidate.engineRole === 'engineer_deep');
pass('root dual engineer_deep usage is counted');
// ── root candidacy: reviewer / visual / worker / ambiguous excluded ─────────
assert.equal(compaction.rootUsageCandidateOf(
  usageEvent({ inputTokens: 999999, outputTokens: 1 }, 1, 9),
  { engine: 'dual', role: 'reviewer', isWorker: false },
), null);
pass('reviewer usage never pollutes root metrics');
assert.equal(compaction.rootUsageCandidateOf(
  usageEvent({ inputTokens: 999999, outputTokens: 1 }, 1, 9),
  { engine: 'dual', role: 'engineer_normal', executionClass: 'reviewer', isWorker: false },
), null);
pass('reviewer execution class never pollutes root metrics');
assert.equal(compaction.rootUsageCandidateOf(
  usageEvent({ inputTokens: 999999, outputTokens: 1 }, 1, 3),
  { engine: 'dual', role: 'engineer_normal', isWorker: true },
), null);
pass('worker/subagent usage never triggers root compaction');
assert.equal(compaction.isWorkerSession({ header: { origin: 'subagent' } }), true);
pass('subagent origin classifies as worker');
assert.equal(compaction.isWorkerSession({ header: { delegationDepth: 2 } }), true);
pass('delegation depth classifies as worker');
assert.equal(compaction.rootUsageCandidateOf(
  usageEvent({ inputTokens: 999999, outputTokens: 1 }, 1, 1),
  { engine: 'dual', role: null, isWorker: false },
), null);
pass('ambiguous dual usage without a role is excluded');
assert.equal(compaction.rootUsageCandidateOf(
  usageEvent({ inputTokens: 999999, outputTokens: 1 }, 1, 1),
  { engine: 'unknown', role: 'engineer_normal', isWorker: false },
), null);
pass('unknown engine usage is excluded');
assert.equal(compaction.rootUsageCandidateOf(
  { type: 'tool/result', data: {} },
  { engine: 'muse', role: 'muse_main', isWorker: false },
), null);
pass('non-usage events are never candidates');
assert.equal(compaction.rootUsageCandidateOf(
  usageEvent({ inputTokens: 'nan-nope', outputTokens: 1 }, 1, 1),
  { engine: 'muse', role: 'muse_main', isWorker: false },
), null);
pass('malformed usage numbers are excluded, never coerced');
// ── balanced cut: tool pairing is never orphaned ───────────────────────────
function fakeSession(events) {
  const withSeq = events.map((event, index) => Object.assign({ seq: index }, event));
  return { events: withSeq, surface: { nodes: withSeq.map((event) => event.seq), replaceGeneration: 0 } };
}
function userMessage(text) {
  return { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } };
}
function assistantText(text) {
  return { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } };
}
function assistantCall(id) {
  return { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', name: 'run', callId: id }] } } };
}
function toolResult(id) {
  return { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: id }] } } };
}
const bulkSession = fakeSession([
  userMessage('start the big task BULK-MARK'),
  assistantCall('c1'),
  toolResult('c1'),
  assistantText('final report: done'),
]);
const cut = compaction.balancedRetainCut(bulkSession, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
assert.ok(cut);
assert.deepEqual(cut.shadowedSeqs, [0, 1, 2]);
assert.deepEqual(cut.retainedSeqs, [3]);
pass('balanced cut shadows the bulk and retains the final exchange');
const openTail = fakeSession([userMessage('a'), assistantCall('c9')]);
assert.equal(compaction.balancedRetainCut(openTail, {}), null);
pass('open tool tail refuses the cut (KEEP)');
assert.equal(compaction.balancedRetainCut({ events: [], surface: { nodes: [] } }, {}), null);
pass('empty surface refuses the cut');
// ── provenance: generation joins use taskInstanceId ────────────────────────
const goodCheckpoint = { taskId: 'TASK-0004', taskInstanceId: 'task_abc123' };
assert.deepEqual(compaction.checkpointProvenanceValid(goodCheckpoint, { taskId: 'TASK-0004', taskInstanceId: 'task_abc123' }), { valid: true, reason: null });
pass('matching generation validates');
assert.equal(compaction.checkpointProvenanceValid({ taskId: 'TASK-0004', taskInstanceId: 'task_old' }, { taskId: 'TASK-0004', taskInstanceId: 'task_new' }).valid, false);
pass('stale taskId generation is blocked');
assert.equal(compaction.checkpointProvenanceValid(null, { taskId: 'TASK-0004', taskInstanceId: 'x' }).valid, false);
pass('missing checkpoint is invalid');

// ── continuity tail: controller notices are skipped, user text preferred ────
const historySession = {
  events: [
    { seq: 0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Controller: task bound' }], source: { kind: 'plugin', plugin: 'aih-controller' } } },
    { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'implement the widget' }], source: { kind: 'user' } } },
    { seq: 2, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'widget shipped' }] } } },
  ],
};
assert.equal(compaction.lastTextOfRole(historySession, 'user', 2000), 'implement the widget');
pass('continuity prefers real user text over controller notices');
assert.equal(compaction.lastTextOfRole(historySession, 'assistant', 2000), 'widget shipped');
pass('continuity captures the final assistant report');
assert.equal(compaction.lastTextOfRole({ events: [] }, 'user', 2000), '');
pass('empty history yields empty continuity, never throws');

// ── engine isolation untouched by compaction ─────────────────────────────────
const museIsolation = fs.readFileSync(path.join(repoRoot, 'config', 'Muse-Isolation.cjs'), 'utf8');
assert.ok(!museIsolation.includes('compaction') && !museIsolation.includes('Compaction'));
pass('muse request isolation carries no compaction policy');
const dualIsolation = fs.readFileSync(path.join(repoRoot, 'config', 'Engineering-Isolation.cjs'), 'utf8');
assert.ok(!dualIsolation.includes('compaction') && !dualIsolation.includes('Compaction'));
pass('dual request isolation carries no compaction policy');
assert.ok(museIsolation.includes('MUSE_V0_MAX_OUTPUT_TOKENS'));
pass('muse output bound is unchanged');
const governor = fs.readFileSync(path.join(repoRoot, 'config', 'Muse-ReasoningGovernor.cjs'), 'utf8');
assert.ok(!governor.includes('compaction') && !governor.includes('Compaction'));
pass('muse reasoning governor owns no compaction policy');
const routing = fs.readFileSync(path.join(repoRoot, 'scripts', 'Routing.ps1'), 'utf8');
assert.ok(!routing.includes('ompaction'));
pass('dual routing carries no compaction branch');
const bridge = fs.readFileSync(path.join(repoRoot, 'config', 'AihController.cjs'), 'utf8');
assert.ok(bridge.includes('maybeApplyContextCompaction'));
pass('controller bridge owns the apply seam');
assert.ok(bridge.includes('recordContextRootUsage'));
pass('controller bridge owns root pressure recording');

// ── F1: owned runtime context is identified, never frozen ──────────────────
function rtxMessage(text) {
  return { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' } } };
}
const rtxSession = fakeSession([
  userMessage('bulk task'),
  rtxMessage('Current runtime context. policy: workspace-write'),
  assistantText('done'),
]);
assert.deepEqual(compaction.runtimeContextSeqsOf(rtxSession), [1]);
pass('owned runtime snapshot seq is identified');
assert.ok(!compaction.isRuntimeContextMessage(rtxSession.events[0]));
pass('ordinary user text is not an owned snapshot');
const frozenMinusRtx = compaction.withoutSeqs([0, 1], [1]);
assert.deepEqual(frozenMinusRtx, [0]);
pass('freeze excludes the owned snapshot from the shadowed range');
const splitSession = fakeSession([
  userMessage('bulk-a'),
  { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'stale rtx' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' } } },
  assistantText('bulk-b'),
]);
const splitSegs = compaction.splitRangeAroundOwned(splitSession, [0, 1, 2], [1]);
assert.ok(splitSegs && splitSegs.length === 2);
assert.deepEqual(splitSegs[0], { start: 0, end: 0, sourceEventSeqs: [0] });
assert.deepEqual(splitSegs[1], { start: 2, end: 2, sourceEventSeqs: [2] });
pass('frozen boundary splits into contiguous segments around owned nodes');
assert.equal(compaction.splitRangeAroundOwned(splitSession, [1], [1]), null);
pass('all-owned range yields no segments (KEEP)');
assert.equal(compaction.splitRangeAroundOwned(splitSession, [], []), null);
pass('empty shadowed span yields no segments');
const orphanSession = fakeSession([
  { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', name: 'run', callId: 'orphan' }] } } },
  { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'stale rtx' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' } } },
  { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'orphan' }] } } },
]);
assert.equal(compaction.splitRangeAroundOwned(orphanSession, [0, 1, 2], [1]), null);
pass('split that would orphan a tool pair refuses (KEEP)');
// ── F2/F5: replacement addressed by operationId ───────────────────────────
function checkpointReplacement(seq, operationId) {
  return { seq, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'cp' }], source: { kind: 'plugin', plugin: 'aih-controller', form: 'context-checkpoint', operationId } } };
}
const opSession = {
  events: [
    userMessage('a'),
    Object.assign({ seq: 1 }, checkpointReplacement(1, 'ccop_deadbeef')),
    userMessage('Task B intent'),
  ].map((event, index) => Object.assign({ seq: index }, event)),
};
const found = compaction.findReplacementByOperation(opSession, 'ccop_deadbeef');
assert.ok(found && found.seq === 1);
pass('landed replacement resolves by operationId');
assert.equal(compaction.findReplacementByOperation(opSession, 'ccop_other'), null);
pass('unknown operationId resolves to nothing (no false reconcile)');
const foreignForm = {
  events: [{ seq: 0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'aih-controller', form: 'controller-binding', operationId: 'ccop_deadbeef' } } }],
};
assert.equal(compaction.findReplacementByOperation(foreignForm, 'ccop_deadbeef'), null);
pass('non-checkpoint forms never reconcile as replacements');

console.log('RESULT: ' + passed + ' context compaction bridge assertions passed.');

