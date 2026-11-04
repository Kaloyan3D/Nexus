'use strict';
// A2.3 dispatch-intent bundle builder: binds Controller intent, sealed
// issuance digests, request identity, session, and mock-e2e scope.
const assert = require('node:assert/strict');
const builder = require('../config/registry/native-dispatch-intent.cjs');

delete process.env.DSH_HOME;
delete process.env.AIH_INSTALL_ROOT;

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log('PASS: ' + label);
}

const HEX = 'ab'.repeat(32);

function baseOpts(overrides) {
  const o = {
    shadowIntent: { taskInstanceId: 'task-1', attemptId: 'task-1-A1', commandId: 'shadow-abc' },
    lease: { epoch: 2, storeIncarnation: 'inc-1' },
    role: 'muse_main',
    issuance: {
      taskInstanceId: 'task-1',
      resolution: { provenance: { targetDigest: HEX, registrySnapshotDigest: HEX, issuanceId: HEX } },
    },
    extensionDigest: HEX,
    requestDigest: HEX,
    sessionId: 'session-1',
    scope: 'mock-e2e',
  };
  return Object.assign(o, overrides || {});
}

check('happy path binds every dispatch proof', function () {
  const r = builder.buildDispatchIntent(baseOpts());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.bundle, {
    schemaVersion: 1,
    commandId: 'shadow-abc',
    taskInstanceId: 'task-1',
    attemptId: 'task-1-A1',
    leaseEpoch: 2,
    storeIncarnation: 'inc-1',
    role: 'muse_main',
    targetDigest: HEX,
    snapshotDigest: HEX,
    issuanceId: HEX,
    extensionDigest: HEX,
    requestDigest: HEX,
    sessionId: 'session-1',
    scope: 'mock-e2e',
  });
});

check('missing lease fails closed', function () {
  const r = builder.buildDispatchIntent(baseOpts({ lease: null }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'intent-invalid');
});

check('missing request digest fails closed', function () {
  const r = builder.buildDispatchIntent(baseOpts({ requestDigest: 'nope' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'intent-invalid');
});

check('non-mock scope is refused', function () {
  const r = builder.buildDispatchIntent(baseOpts({ scope: 'live' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'intent-scope-refused');
});

check('model-only scope requires an explicit user initiator', function () {
  const missing = builder.buildDispatchIntent(baseOpts({ scope: 'model-only' }));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'intent-initiator-refused');
  const wrong = builder.buildDispatchIntent(baseOpts({ scope: 'model-only', initiator: 'autonomous-workflow' }));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'intent-initiator-refused');
  const ok = builder.buildDispatchIntent(baseOpts({ scope: 'model-only', initiator: 'user-explicit' }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.bundle.scope, 'model-only');
  assert.equal(ok.bundle.initiator, 'user-explicit');
});

check('initiator is not accepted on the mock scope', function () {
  const r = builder.buildDispatchIntent(baseOpts({ initiator: 'user-explicit' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'intent-initiator-refused');
});

check('generation mismatch between issuance and intent is refused', function () {
  const bad = baseOpts();
  bad.issuance = { taskInstanceId: 'task-2', resolution: bad.issuance.resolution };
  const r = builder.buildDispatchIntent(bad);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'intent-generation-mismatch');
});

check('missing session fails closed', function () {
  const r = builder.buildDispatchIntent(baseOpts({ sessionId: '' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'intent-invalid');
});

console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed);
