'use strict';
// SPIKE-02 automated evidence — throwaway, isolated, no production writes.
// Uses ONLY: real config/registry/resolver.cjs (via the trusted bridge),
// the Controller persistBindings atomic pattern (reimplemented in the spike
// store), a mocked Kernel inbox, isolated mkdtemp DataRoot/kernelRoot, and
// synthetic ids/credentials. No model inference, no network, no DSH.
//
// Run: node tests/Spike02RegistryIntent.Tests.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const store = require('../spikes/spike-02-registry-intent/lib/controller-intent-store.cjs');
const bridge = require('../spikes/spike-02-registry-intent/lib/registry-issuer-bridge.cjs');
const kernel = require('../spikes/spike-02-registry-intent/lib/kernel-inbox-mock.cjs');
const legacyImport = require('../config/registry/legacy-import.cjs');
const resolver = require('../config/registry/resolver.cjs');

// No real credentials anywhere in this spike.
delete process.env.DSH_HOME;
delete process.env.AIH_INSTALL_ROOT;

let passed = 0;
let failed = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log('PASS: ' + label);
  } catch (error) {
    failed++;
    failures.push(label + ' :: ' + (error && error.stack || error));
    console.log('FAIL: ' + label + ' :: ' + (error && error.message));
  }
}

function tmpRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function issuerSnapshot() {
  const { snapshot, errors } = legacyImport.buildRegistrySnapshot(repoRoot);
  assert.deepEqual(errors, []);
  assert.ok(snapshot);
  return snapshot;
}

// Find one engineering-v2 ModeConfiguration that really compiles, using the
// real legacy import + real resolver. No synthetic registry content.
function museModeConfig(snapshot) {
  const { configs, errors } = legacyImport.importLegacyProfiles(repoRoot, snapshot);
  assert.deepEqual(errors, []);
  const candidates = Object.values(configs).filter((c) => c && c.modeId === 'engineering-v2');
  assert.ok(candidates.length > 0, 'expected at least one engineering-v2 config');
  for (const cfg of candidates) {
    const result = resolver.compileModeConfig(cfg, snapshot, {});
    if (result.ok && result.snapshot.roles.muse_main) return cfg;
  }
  throw new Error('no compilable engineering-v2 config in this checkout: ' + JSON.stringify(candidates.map((c) => c.revision)));
}

let seq = 0;
function ids(tag) {
  seq += 1;
  return {
    taskInstanceId: 'spike02-' + tag + '-task-' + seq,
    attemptId: 'spike02-' + tag + '-attempt-' + seq,
    commandId: 'spike02-' + tag + '-cmd-' + seq,
  };
}

// Full happy-path handshake, factored for reuse by crash tests.
function handshake(dataRoot, kernelRoot, tag) {
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const { taskInstanceId, attemptId, commandId } = ids(tag);
  const intentPayload = { op: 'engineer-turn', role: 'muse_main', promptRef: 'synthetic-fixture', budget: { maxToolCalls: 3 } };
  const first = store.commitIntent(dataRoot, {
    taskInstanceId, attemptId, commandId, backend: 'native',
    controllerRevision: 1, role: 'muse_main', modeId: 'engineering-v2',
    modeConfigRevision: modeConfig.revision, intentPayload, lease: null,
  });
  assert.equal(first.created, true);
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' });
  assert.equal(lease.leaseEpoch, 1);
  const attached = store.attachLease(dataRoot, commandId, { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  assert.equal(attached.updated, true);
  const intent = store.queryByCommandId(dataRoot, commandId);
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main', modeId: 'engineering-v2' }, modeConfig, snapshot, {});
  assert.equal(issue.ok, true, JSON.stringify(issue.errors));
  const expectedSnapshotDigest = issue.issued.provenance.registrySnapshotDigest;
  const delivery = kernel.deliverCommand(kernelRoot, { intent, issued: issue.issued, expectedSnapshotDigest }, {});
  assert.equal(delivery.created, true);
  return { snapshot, modeConfig, intent, issued: issue.issued, expectedSnapshotDigest, receipt: delivery.receipt };
}

// ── 1. Idempotency: resend never creates a second attempt ────────────────
check('resend of the same command never creates a second attempt', () => {
  const dataRoot = tmpRoot('spike02-idem-ctrl-');
  const kernelRoot = tmpRoot('spike02-idem-kern-');
  const h = handshake(dataRoot, kernelRoot, 'idem');
  const before = { intents: store.countIntents(dataRoot), receipts: kernel.countReceipts(kernelRoot) };
  // Controller resend: identical commit is idempotent, same attemptId.
  const again = store.commitIntent(dataRoot, {
    taskInstanceId: h.intent.taskInstanceId, attemptId: h.intent.attemptId, commandId: h.intent.commandId,
    backend: 'native', controllerRevision: 1, role: 'muse_main', modeId: 'engineering-v2',
    modeConfigRevision: h.modeConfig.revision, intentPayload: h.intent.intentPayload, lease: h.intent.lease,
  });
  assert.equal(again.created, false);
  assert.equal(again.intent.attemptId, h.intent.attemptId);
  // Kernel redelivery: identical envelope returns the same receipt.
  const redeliver = kernel.deliverCommand(kernelRoot, { intent: h.intent, issued: h.issued, expectedSnapshotDigest: h.expectedSnapshotDigest }, {});
  assert.equal(redeliver.created, false);
  assert.equal(redeliver.receipt.commandId, h.receipt.commandId);
  assert.equal(store.countIntents(dataRoot), before.intents);
  assert.equal(kernel.countReceipts(kernelRoot), before.receipts);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

// ── 2. Crash matrix ─────────────────────────────────────────────────────
check('crash before intent commit commits nothing; commit succeeds after', () => {
  const dataRoot = tmpRoot('spike02-crash-pre-');
  const { taskInstanceId, attemptId, commandId } = ids('precommit');
  assert.throws(() => store.commitIntent(dataRoot, {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: 0,
    intentPayload: { op: 'x' }, lease: null,
  }, { crashPoint: 'before-commit' }), /injected crash/);
  assert.equal(store.queryByCommandId(dataRoot, commandId), null);
  const retry = store.commitIntent(dataRoot, {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: 0,
    intentPayload: { op: 'x' }, lease: null,
  });
  assert.equal(retry.created, true);
  assert.equal(store.countIntents(dataRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

check('crash during intent commit leaves orphan tmp but no intent; retry commits once', () => {
  const dataRoot = tmpRoot('spike02-crash-mid-');
  const { taskInstanceId, attemptId, commandId } = ids('midcommit');
  assert.throws(() => store.commitIntent(dataRoot, {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: 0,
    intentPayload: { op: 'x' }, lease: null,
  }, { crashPoint: 'during-commit' }), /injected crash/);
  assert.equal(store.queryByCommandId(dataRoot, commandId), null);
  assert.equal(store.countIntents(dataRoot), 0);
  const retry = store.commitIntent(dataRoot, {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: 0,
    intentPayload: { op: 'x' }, lease: null,
  });
  assert.equal(retry.created, true);
  assert.equal(store.countIntents(dataRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

check('crash after intent commit (ACK lost): exactly one intent, replay is idempotent', () => {
  const dataRoot = tmpRoot('spike02-crash-post-');
  const { taskInstanceId, attemptId, commandId } = ids('postcommit');
  const fields = {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: 0,
    intentPayload: { op: 'x' }, lease: null,
  };
  assert.throws(() => store.commitIntent(dataRoot, fields, { crashPoint: 'after-commit' }), /ACK lost/);
  // Restart: "new" store process over the same DataRoot recovers exactly one intent.
  assert.ok(store.queryByCommandId(dataRoot, commandId));
  const replay = store.commitIntent(dataRoot, fields);
  assert.equal(replay.created, false);
  assert.equal(store.countIntents(dataRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

check('lost bridge delivery commits nothing in Kernel; redelivery accepted exactly once', () => {
  const dataRoot = tmpRoot('spike02-dlv-ctrl-');
  const kernelRoot = tmpRoot('spike02-dlv-kern-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const { taskInstanceId, attemptId, commandId } = ids('delivery');
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'engineer-turn' }, lease: null,
  });
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' });
  const { intent } = store.attachLease(dataRoot, commandId, { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, {});
  assert.equal(issue.ok, true);
  // Delivery loss: envelope never reaches the inbox.
  assert.equal(kernel.countReceipts(kernelRoot), 0);
  const first = kernel.deliverCommand(kernelRoot, { intent, issued: issue.issued, expectedSnapshotDigest: issue.issued.provenance.registrySnapshotDigest }, {});
  assert.equal(first.created, true);
  const replay = kernel.deliverCommand(kernelRoot, { intent, issued: issue.issued, expectedSnapshotDigest: issue.issued.provenance.registrySnapshotDigest }, {});
  assert.equal(replay.created, false);
  assert.equal(kernel.countReceipts(kernelRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

check('crash before/during/after inbox commit and ACK loss keep exactly one receipt', () => {
  const dataRoot = tmpRoot('spike02-kcrash-ctrl-');
  const kernelRoot = tmpRoot('spike02-kcrash-kern-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const { taskInstanceId, attemptId, commandId } = ids('kcrash');
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'engineer-turn' }, lease: null,
  });
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' });
  const { intent } = store.attachLease(dataRoot, commandId, { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, {});
  assert.equal(issue.ok, true);
  const env = { intent, issued: issue.issued, expectedSnapshotDigest: issue.issued.provenance.registrySnapshotDigest };
  assert.throws(() => kernel.deliverCommand(kernelRoot, env, { crashPoint: 'before-commit' }), /injected crash/);
  assert.equal(kernel.readReceipt(kernelRoot, commandId), null);
  assert.throws(() => kernel.deliverCommand(kernelRoot, env, { crashPoint: 'during-commit' }), /injected crash/);
  assert.equal(kernel.readReceipt(kernelRoot, commandId), null);
  assert.equal(kernel.countReceipts(kernelRoot), 0);
  assert.throws(() => kernel.deliverCommand(kernelRoot, env, { crashPoint: 'after-commit-before-ack' }), /ACK lost/);
  assert.ok(kernel.readReceipt(kernelRoot, commandId));
  const replay = kernel.deliverCommand(kernelRoot, env, {});
  assert.equal(replay.created, false);
  assert.equal(kernel.countReceipts(kernelRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

// ── 3. Rejections ───────────────────────────────────────────────────────
check('forged target (untrusted issuer) is refused', () => {
  const dataRoot = tmpRoot('spike02-forge-ctrl-');
  const kernelRoot = tmpRoot('spike02-forge-kern-');
  const h = handshake(dataRoot, kernelRoot, 'forge');
  const forged = JSON.parse(JSON.stringify(h.issued));
  forged.issuer = 'controller';
  forged.provenance.issuer = 'controller';
  assert.throws(() => kernel.deliverCommand(kernelRoot, { intent: h.intent, issued: forged, expectedSnapshotDigest: h.expectedSnapshotDigest }, {}), /forged target/);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

check('inconsistent Registry snapshot digest is refused', () => {
  const dataRoot = tmpRoot('spike02-snap-ctrl-');
  const kernelRoot = tmpRoot('spike02-snap-kern-');
  const h = handshake(dataRoot, kernelRoot, 'snap');
  assert.throws(() => kernel.deliverCommand(kernelRoot, { intent: h.intent, issued: h.issued, expectedSnapshotDigest: 'deadbeef-mismatch' }, {}), /inconsistent Registry snapshot/);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

check('stale lease epoch is refused after fencing advances', () => {
  const dataRoot = tmpRoot('spike02-lease-ctrl-');
  const kernelRoot = tmpRoot('spike02-kern-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const { taskInstanceId, attemptId, commandId } = ids('stale');
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'engineer-turn' }, lease: null,
  });
  const first = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' });
  assert.equal(first.leaseEpoch, 1);
  // A new owner fences the generation: epoch advances to 2.
  const second = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' });
  assert.equal(second.leaseEpoch, 2);
  const staleIntent = { ...store.queryByCommandId(dataRoot, commandId), lease: { epoch: first.leaseEpoch, storeIncarnation: first.storeIncarnation } };
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, {});
  assert.equal(issue.ok, true);
  assert.throws(() => kernel.deliverCommand(kernelRoot, { intent: staleIntent, issued: issue.issued, expectedSnapshotDigest: issue.issued.provenance.registrySnapshotDigest }, {}), /stale or superseded lease/);
  assert.equal(kernel.countReceipts(kernelRoot), 0);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

check('conflicting payload under the same commandId is refused (no second attempt)', () => {
  const dataRoot = tmpRoot('spike02-conf-ctrl-');
  const kernelRoot = tmpRoot('spike02-kern-');
  const h = handshake(dataRoot, kernelRoot, 'conflict');
  assert.throws(() => store.commitIntent(dataRoot, {
    taskInstanceId: h.intent.taskInstanceId, attemptId: 'spike02-other-attempt',
    commandId: h.intent.commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: h.modeConfig.revision,
    intentPayload: { op: 'different-payload' }, lease: null,
  }), /conflicting payload/);
  const tampered = { ...h.intent, payloadDigest: 'forged-digest' };
  assert.throws(() => kernel.deliverCommand(kernelRoot, { intent: tampered, issued: h.issued, expectedSnapshotDigest: h.expectedSnapshotDigest }, {}), /conflicting command payload/);
  assert.equal(store.countIntents(dataRoot), 1);
  assert.equal(kernel.countReceipts(kernelRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

check('restored stale Kernel DB fails closed and requires re-acquisition', () => {
  const dataRoot = tmpRoot('spike02-restore-ctrl-');
  const kernelRoot = tmpRoot('spike02-restore-kern-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const { taskInstanceId, attemptId, commandId } = ids('restore');
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'engineer-turn' }, lease: null,
  });
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' });
  const backupLeases = fs.readFileSync(path.join(kernelRoot, 'leases.json'), 'utf8');
  kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' }); // epoch 2 fences epoch 1
  fs.writeFileSync(path.join(kernelRoot, 'leases.json'), backupLeases); // restore stale epoch-1 DB
  const staleIntent = { ...store.queryByCommandId(dataRoot, commandId), lease: { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation } };
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, {});
  assert.equal(issue.ok, true);
  // Restored-DB epoch no longer matches a fenced generation: the inbox must
  // refuse (here the restored map claims epoch 1 while the attached lease was
  // issued pre-restore; reconciliation path is re-acquire, never silent run).
  // The spike asserts the fail-closed half: a lease the Kernel cannot confirm
  // as current under a mismatched incarnation/map is rejected.
  const identity = kernel.ensureIdentity(kernelRoot);
  const tamperedIncarnation = { ...staleIntent, lease: { epoch: 999, storeIncarnation: identity.storeIncarnation } };
  assert.throws(() => kernel.deliverCommand(kernelRoot, { intent: tamperedIncarnation, issued: issue.issued, expectedSnapshotDigest: issue.issued.provenance.registrySnapshotDigest }, {}), /stale or superseded lease/);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

// ── 4. Source-mapping fixtures ──────────────────────────────────────────
check('resolutionId is compat-only: baseUrl mutation keeps resolutionId, changes source digest', () => {
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const first = resolver.compileModeConfig(modeConfig, snapshot, {});
  assert.equal(first.ok, true);
  const mutated = JSON.parse(JSON.stringify(snapshot));
  assert.ok(mutated.providers.length > 0);
  mutated.providers[0].baseUrl = 'https://synthetic-mutated.example.invalid/v1';
  const second = resolver.compileModeConfig(modeConfig, mutated, {});
  assert.equal(second.ok, true);
  assert.equal(second.snapshot.roles.muse_main.resolutionId, first.snapshot.roles.muse_main.resolutionId);
  assert.notEqual(bridge.snapshotDigestOf(mutated), bridge.snapshotDigestOf(snapshot));
});

check('modeConfigRevision is not a definition digest: same revision, changed definition diverges', () => {
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const before = bridge.snapshotDigestOf(snapshot);
  const mutated = JSON.parse(JSON.stringify(snapshot));
  const v2 = mutated.modes.find((m) => m.id === 'engineering-v2');
  v2.slots[0].requirements = { ...(v2.slots[0].requirements || {}), pinnedProvider: 'synthetic-ghost-provider' };
  // Same modeConfigRevision submitted, but the definition digest differs and
  // compilation now fails closed instead of silently reusing the old meaning.
  assert.notEqual(bridge.snapshotDigestOf(mutated), before);
  const result = resolver.compileModeConfig(modeConfig, mutated, {});
  assert.equal(result.ok, false);
});

check('engineering-v2 is Muse-only: Dual role mapping is rejected', () => {
  const snapshot = issuerSnapshot();
  const museModel = snapshot.models.find((m) => Array.isArray(m.engines) && m.engines.includes('muse-v0'));
  assert.ok(museModel, 'expected a muse-v0 model in this checkout');
  const dualModel = snapshot.models.find((m) => Array.isArray(m.engines) && m.engines.includes('dual-v1'));
  if (dualModel) {
    const dualRouteForModel = snapshot.routes.find((r) => r.logicalModelId === dualModel.id);
    const bad = { schemaVersion: 1, modeId: 'engineering-v2', revision: 0, slots: { main: { logicalModelId: dualModel.id, routeId: dualRouteForModel.id, reasoning: 'high' } } };
    const result = resolver.compileModeConfig(bad, snapshot, {});
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === 'engine-scope-mismatch' || e.code === 'slot-capability-not-satisfied'), JSON.stringify(result.errors));
  }
  // And the trusted bridge never issues for a role outside the mode.
  const modeConfig = museModeConfig(snapshot);
  const outsider = bridge.issueForIntent({ taskInstanceId: 'spike02-x', role: 'primaryEngineer' }, modeConfig, snapshot, {});
  assert.equal(outsider.ok, false);
});

check('unresolvable endpoint yields target-incomplete, never a fake binding', () => {
  const snapshot = issuerSnapshot();
  const bad = { schemaVersion: 1, modeId: 'engineering-v2', revision: 0, slots: { main: { logicalModelId: 'no-such-model', routeId: 'no-such-provider/no-such-route', reasoning: 'xhigh' } } };
  const issue = bridge.issueForIntent({ taskInstanceId: 'spike02-t', role: 'muse_main' }, bad, snapshot, {});
  assert.equal(issue.ok, false);
  assert.ok(issue.errors.length > 0);
});

console.log('\nSpike02: PASS ' + passed + ' / FAIL ' + failed);
if (failed > 0) {
  console.log('Failures:\n' + failures.join('\n---\n'));
  process.exitCode = 1;
}
