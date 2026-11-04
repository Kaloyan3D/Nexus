'use strict';
// A5.3: the intent bridge allocates Controller-shaped intent tasks and can
// only publish user-initiated model-only bundles.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BRIDGE = path.join(__dirname, '..', 'config', 'registry', 'native-intent-bridge.cjs');
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('PASS: ' + name); }
function run(args, stdin) {
  const r = spawnSync('node', [BRIDGE].concat(args), { input: stdin || '', encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { out = { ok: false, raw: r.stdout }; }
  return { status: r.status, out: out };
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-bridge-'));

check('task-create allocates sequential Controller-shaped tasks with attempt evidence', function () {
  const a = run(['task-create', ws]);
  const b = run(['task-create', ws]);
  assert.equal(a.out.ok, true);
  assert.equal(a.out.taskId, 'INTENT-00001');
  assert.equal(b.out.taskId, 'INTENT-00002');
  assert.notEqual(a.out.taskInstanceId, b.out.taskInstanceId);
  const doc = JSON.parse(fs.readFileSync(path.join(ws, '.ai-harness', 'state', 'tasks.json'), 'utf8'));
  assert.equal(doc.tasks.length, 2);
  assert.equal(doc.nextSequence, 3);
  const att = fs.readFileSync(path.join(ws, '.ai-harness', 'runs', 'INTENT-00001', 'attempts.jsonl'), 'utf8');
  assert.equal(JSON.parse(att.trim()).status, 'started');
  // The shadow-intent reader accepts exactly this shape.
  const s = run(['shadow', ws, a.out.taskId, a.out.attemptId, a.out.taskInstanceId]);
  assert.equal(s.out.ok, true, JSON.stringify(s.out));
});

check('task-create refuses to overwrite an unreadable ledger', function () {
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-bridge-bad-'));
  fs.mkdirSync(path.join(bad, '.ai-harness', 'state'), { recursive: true });
  fs.writeFileSync(path.join(bad, '.ai-harness', 'state', 'tasks.json'), '{not json');
  const r = run(['task-create', bad]);
  assert.equal(r.out.ok, false);
  assert.equal(r.out.code, 'ledger-unreadable');
  assert.equal(fs.readFileSync(path.join(bad, '.ai-harness', 'state', 'tasks.json'), 'utf8'), '{not json');
});

check('a foreign (legacy Controller) ledger is never appended to or overwritten', function () {
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-bridge-legacy-'));
  const state = path.join(legacy, '.ai-harness', 'state');
  fs.mkdirSync(state, { recursive: true });
  const original = JSON.stringify({ schemaVersion: 1, nextSequence: 7, tasks: [{ taskId: 'TASK-0006', taskInstanceId: 'task-legacy', attemptCount: 2 }] });
  fs.writeFileSync(path.join(state, 'tasks.json'), original);
  const r = run(['task-create', legacy]);
  assert.equal(r.out.ok, false);
  assert.equal(r.out.code, 'ledger-foreign');
  assert.equal(fs.readFileSync(path.join(state, 'tasks.json'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(legacy, '.ai-harness', 'runs')), false);
});

check('task id collisions are refused and orphan attempt directories are skipped, never reused', function () {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-bridge-coll-'));
  const state = path.join(w, '.ai-harness', 'state');
  fs.mkdirSync(state, { recursive: true });
  // nextSequence regressed onto an existing intent id
  fs.writeFileSync(path.join(state, 'tasks.json'), JSON.stringify({ schemaVersion: 1, nextSequence: 1, tasks: [{ taskId: 'INTENT-00001', taskInstanceId: 'task-x', attemptCount: 1, kind: 'model-only-intent' }] }));
  assert.equal(run(['task-create', w]).out.code, 'ledger-collision');
  // a leftover attempt directory from a crashed allocation is never reused
  const w2 = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-bridge-coll2-'));
  fs.mkdirSync(path.join(w2, '.ai-harness', 'runs', 'INTENT-00001'), { recursive: true });
  const r2 = run(['task-create', w2]);
  assert.equal(r2.out.ok, true, JSON.stringify(r2.out));
  assert.equal(r2.out.taskId, 'INTENT-00002', 'skips past the orphan');
  assert.equal(fs.readdirSync(path.join(w2, '.ai-harness', 'runs', 'INTENT-00001')).length, 0, 'orphan untouched');
});

check('relative workspace and unknown subcommands are refused', function () {
  assert.equal(run(['task-create', 'relative/dir']).out.code, 'bad-args');
  assert.equal(run(['exec', 'ls']).out.code, 'bad-subcommand');
});

check('publish cannot be steered to another scope or initiator', function () {
  const HEX = 'a'.repeat(64);
  const input = {
    shadowIntent: { taskInstanceId: 't1', attemptId: 't1-A1', commandId: 'shadow-abc' },
    lease: { epoch: 2, storeIncarnation: 'inc-1' }, role: 'muse_main',
    issuance: { taskInstanceId: 't1', resolution: { provenance: { targetDigest: HEX, registrySnapshotDigest: HEX, issuanceId: HEX } } },
    extensionDigest: HEX, requestDigest: HEX, sessionId: 's1',
    scope: 'mock-e2e', initiator: 'autonomous-workflow',
  };
  const r = run(['publish'], JSON.stringify(input));
  assert.equal(r.out.ok, true, JSON.stringify(r.out));
  assert.equal(r.out.bundle.scope, 'model-only');
  assert.equal(r.out.bundle.initiator, 'user-explicit');
});

console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed);
