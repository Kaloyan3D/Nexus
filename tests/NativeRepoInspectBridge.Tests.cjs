'use strict';
// A5.5 Controller side of repo-inspect: per-turn attempts of one task, the
// repo-inspect publish scope (fixed, user-initiated only) and the workspace
// commitment in the Controller intent payload. Offline, no network.
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const bridgeFile = path.join(repo, 'config', 'registry', 'native-intent-bridge.cjs');
const dispatchIntent = require('../config/registry/native-dispatch-intent.cjs');
const shadowBridge = require('../config/registry/native-shadow-bridge.cjs');

let passed = 0;
function check(label, fn) { fn(); passed++; console.log('PASS: ' + label); }

function run(args, stdin) {
  const r = cp.spawnSync('node', [bridgeFile, ...args], { input: stdin, encoding: 'utf8' });
  const line = (r.stdout || '').trim().split('\n').pop();
  return JSON.parse(line);
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ri-'));
const ledger = (d) => JSON.parse(fs.readFileSync(path.join(d, '.ai-harness', 'state', 'tasks.json'), 'utf8'));
const attempts = (d, id) => fs.readFileSync(path.join(d, '.ai-harness', 'runs', id, 'attempts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

check('task-create records the task kind; model-only stays the default', () => {
  const d = tmp();
  const a = run(['task-create', d]);
  assert.equal(a.ok, true);
  assert.equal(ledger(d).tasks[0].kind, 'model-only-intent');
  const b = run(['task-create', d, 'repo-inspect']);
  assert.equal(b.ok, true);
  assert.equal(ledger(d).tasks[1].kind, 'repo-inspect-intent');
  assert.equal(run(['task-create', d, 'shell']).ok, false, 'unknown kinds are refused');
});

check('attempt-add appends one attempt per model turn to the SAME task, same session', () => {
  const d = tmp();
  const t = run(['task-create', d, 'repo-inspect']);
  const a2 = run(['attempt-add', d, t.taskId, t.taskInstanceId]);
  const a3 = run(['attempt-add', d, t.taskId, t.taskInstanceId]);
  assert.deepEqual([a2.attemptId, a2.sequence, a3.attemptId, a3.sequence], [t.taskId + '-A2', 2, t.taskId + '-A3', 3]);
  const recs = attempts(d, t.taskId);
  assert.equal(recs.length, 3);
  assert.ok(recs.every((r) => r.taskInstanceId === t.taskInstanceId && r.sessionId === t.sessionId && r.status === 'started'));
  assert.equal(ledger(d).tasks[0].attemptCount, 3);
  // commandIds are distinct per attempt (deterministic from instance + attempt)
  const shadow = require('../config/registry/native-shadow-intent.cjs');
  const ids = [t.attemptId, a2.attemptId, a3.attemptId].map((id) => shadow.resolveShadowIntent({ workspace: d, taskId: t.taskId, taskInstanceId: t.taskInstanceId, attemptId: id }).intent.commandId);
  assert.equal(new Set(ids).size, 3);
});

check('attempt-add refuses a foreign instance, a model-only task and hostile ids', () => {
  const d = tmp();
  const m = run(['task-create', d]);
  assert.equal(run(['attempt-add', d, m.taskId, m.taskInstanceId]).ok, false, 'model-only tasks never gain turns');
  const t = run(['task-create', d, 'repo-inspect']);
  assert.equal(run(['attempt-add', d, t.taskId, 'task-someone-else']).ok, false);
  assert.equal(run(['attempt-add', d, '../x', t.taskInstanceId]).ok, false);
  assert.equal(run(['attempt-add', 'relative', t.taskId, t.taskInstanceId]).ok, false);
  assert.equal(run(['attempt-add', d, 'INTENT-99999', t.taskInstanceId]).ok, false);
});

check('the attempt count is bounded', () => {
  const d = tmp();
  const t = run(['task-create', d, 'repo-inspect']);
  let last;
  for (let i = 0; i < 100; i++) last = run(['attempt-add', d, t.taskId, t.taskInstanceId]);
  assert.equal(last.ok, false);
  assert.equal(last.code, "too-many-attempts");
});

const issuance = () => ({
  taskInstanceId: 'ti',
  resolution: { provenance: { targetDigest: 'a'.repeat(64), registrySnapshotDigest: 'b'.repeat(64), issuanceId: 'c'.repeat(64) } },
});
const base = (over) => Object.assign({
  shadowIntent: { commandId: 'shadow-x', taskInstanceId: 'ti', attemptId: 'T-A1' },
  lease: { epoch: 1, storeIncarnation: 'inc' }, role: 'muse_main', issuance: issuance(),
  extensionDigest: 'd'.repeat(64), requestDigest: 'e'.repeat(64), sessionId: 's',
}, over || {});

check('repo-code is a separate task kind and scope; the publishers fix their own scope', () => {
  const d = tmp();
  const t = run(['task-create', d, 'repo-code']);
  assert.equal(ledger(d).tasks[0].kind, 'repo-code-intent');
  assert.equal(run(['attempt-add', d, t.taskId, t.taskInstanceId]).ok, true);
  const ok = dispatchIntent.buildDispatchIntent(base({ scope: 'repo-code', initiator: 'user-explicit' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.bundle.scope, 'repo-code');
  assert.equal(dispatchIntent.buildDispatchIntent(base({ scope: 'repo-code' })).ok, false);
  assert.equal(dispatchIntent.buildDispatchIntent(base({ scope: 'repo-code', initiator: 'agent' })).ok, false);
  for (const sub of ['publish-code']) {
    const r = run([sub], JSON.stringify(base({ scope: 'repo-inspect', initiator: 'agent' })));
    assert.equal(r.bundle.scope, 'repo-code');
    assert.equal(r.bundle.initiator, 'user-explicit');
  }
  // the other publishers do not become repo-code publishers
  assert.equal(run(['publish-inspect'], JSON.stringify(base({ scope: 'repo-code' }))).bundle.scope, 'repo-inspect');
  assert.equal(run(['publish'], JSON.stringify(base({ scope: 'repo-code' }))).bundle.scope, 'model-only');
});

check('repo-inspect bundles need the explicit user initiator and are scoped repo-inspect', () => {
  const ok = dispatchIntent.buildDispatchIntent(base({ scope: 'repo-inspect', initiator: 'user-explicit' }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.bundle.scope, 'repo-inspect');
  assert.equal(ok.bundle.initiator, 'user-explicit');
  assert.equal(dispatchIntent.buildDispatchIntent(base({ scope: 'repo-inspect' })).ok, false);
  assert.equal(dispatchIntent.buildDispatchIntent(base({ scope: 'repo-inspect', initiator: 'agent' })).ok, false);
  assert.equal(dispatchIntent.buildDispatchIntent(base({ scope: 'repo-edit', initiator: 'user-explicit' })).ok, false);
  assert.equal(dispatchIntent.buildDispatchIntent(base({ scope: 'mock-e2e', initiator: 'user-explicit' })).ok, false);
});

check('publish-inspect fixes the scope: stdin cannot choose it', () => {
  const r = run(['publish-inspect'], JSON.stringify(base({ scope: 'model-only', initiator: 'agent' })));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.bundle.scope, 'repo-inspect');
  assert.equal(r.bundle.initiator, 'user-explicit');
  const m = run(['publish'], JSON.stringify(base({ scope: 'repo-inspect' })));
  assert.equal(m.bundle.scope, 'model-only', 'the model-only publisher is unchanged');
});

const shadow = { taskId: 'T', sequence: 1, executionClass: 'muse_main', sessionIdDigest: 'x', startedByTurnDigest: 'y', taskInstanceId: 'ti', attemptId: 'T-A1', commandId: 'shadow-x', controllerRevision: 1 };
const iss = { modeConfigDigest: 'm', modeConfigRevision: 0, modeId: 'engineering-v2', role: 'muse_main' };

check('the Controller intent commits to the workspace digest only when given; existing digests do not move', () => {
  const plain = shadowBridge.buildKernelIntent(shadow, iss);
  assert.equal('workspaceRootDigest' in plain.intent.intentPayload, false);
  const digest = '1'.repeat(64);
  const ws = shadowBridge.buildKernelIntent(shadow, iss, { workspaceRootDigest: digest });
  assert.equal(ws.intent.intentPayload.workspaceRootDigest, digest);
  assert.notEqual(ws.intent.intentDigest, plain.intent.intentDigest);
  for (const bad of ['', 'abc', 'G'.repeat(64), '1'.repeat(63), 5, null]) {
    assert.equal(shadowBridge.buildKernelIntent(shadow, iss, { workspaceRootDigest: bad }).ok, false, String(bad));
  }
});

console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed);
