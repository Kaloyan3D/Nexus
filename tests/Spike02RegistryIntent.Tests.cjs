'use strict';
// SPIKE-02 automated evidence — throwaway, isolated, no production writes.
// Uses ONLY: real config/registry/resolver.cjs (via the trusted bridge),
// the Controller persistBindings atomic pattern (reimplemented in the spike
// store), a mocked Kernel inbox, isolated mkdtemp DataRoot/kernelRoot, and
// synthetic ids/credentials. No model inference, no network, no DSH.
//
// Hardening coverage: F-01 sealed issuance + adversarial forgeries, F-02
// rollback witness + recovery, F-03 cross-process concurrency (separate OS
// processes via lib/test-workers/spike02-worker.cjs), F-04 intent→resolution
// binding, F-05 canonical envelope digests + tamper tests, F-06 real process
// termination crashes (distinguished from injected-exception simulations).
//
// Run: node tests/Spike02RegistryIntent.Tests.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const workerPath = path.join(repoRoot, 'spikes', 'spike-02-registry-intent', 'lib', 'test-workers', 'spike02-worker.cjs');
const store = require('../spikes/spike-02-registry-intent/lib/controller-intent-store.cjs');
const bridge = require('../spikes/spike-02-registry-intent/lib/registry-issuer-bridge.cjs');
const kernel = require('../spikes/spike-02-registry-intent/lib/kernel-inbox-mock.cjs');
const envelope = require('../spikes/spike-02-registry-intent/lib/envelope.cjs');
const legacyImport = require('../config/registry/legacy-import.cjs');
const resolver = require('../config/registry/resolver.cjs');

// No real credentials anywhere in this spike.
delete process.env.DSH_HOME;
delete process.env.AIH_INSTALL_ROOT;

let passed = 0;
let failed = 0;
const failures = [];
// Contract assertions check error CODES (not message text): codes are the API.
function throwsCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(error && error.code, code, 'expected code ' + code + ', got ' + ((error && error.code) || error));
    return;
  }
  throw new assert.AssertionError({ message: 'expected throw with code ' + code + ' but nothing threw' });
}
async function check(label, fn) {
  try {
    await fn();
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

function museModeConfig(snapshot) {
  const { configs, errors } = legacyImport.importLegacyProfiles(repoRoot, snapshot);
  assert.deepEqual(errors, []);
  const candidates = Object.values(configs).filter((c) => c && c.modeId === 'engineering-v2');
  assert.ok(candidates.length > 0, 'expected at least one engineering-v2 config');
  for (const cfg of candidates) {
    const result = resolver.compileModeConfig(cfg, snapshot, {});
    if (result.ok && result.snapshot.roles.muse_main) return cfg;
  }
  throw new Error('no compilable engineering-v2 config in this checkout');
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

function runWorker(args) {
  return new Promise((resolve) => {
    cp.execFile('node', [workerPath, JSON.stringify(args)], { timeout: 30000 }, (err, stdout) => {
      const lines = String(stdout || '').trim().split('\n').filter((l) => l.trim() !== '');
      let doc = null;
      try { doc = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null; } catch { doc = null; }
      resolve({ err, doc });
    });
  });
}

// Full happy-path handshake: commit → acquire → attach → seal-issue → deliver.
function handshake(dataRoot, kernelRoot, tag, witnessRoot) {
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
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' }, { witnessRoot });
  assert.equal(lease.leaseEpoch, 1);
  const attached = store.attachLease(dataRoot, commandId, { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  assert.equal(attached.updated, true);
  const intent = store.queryByCommandId(dataRoot, commandId);
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main', modeId: 'engineering-v2' }, modeConfig, snapshot, { kernelRoot });
  assert.equal(issue.ok, true, JSON.stringify(issue.errors));
  assert.ok(issue.issuanceId);
  const delivery = kernel.deliverCommand(kernelRoot, { intent, issued: issue.issued }, { witnessRoot });
  assert.equal(delivery.created, true);
  return { snapshot, modeConfig, intent, issued: issue.issued, receipt: delivery.receipt };
}

async function main() {
// ── 1. Idempotency: resend never creates a second attempt ────────────────
await check('resend of the same command never creates a second attempt', () => {
  const dataRoot = tmpRoot('spike02-idem-ctrl-');
  const kernelRoot = tmpRoot('spike02-idem-kern-');
  const h = handshake(dataRoot, kernelRoot, 'idem');
  const before = { intents: store.countIntents(dataRoot), receipts: kernel.countReceipts(kernelRoot) };
  const again = store.commitIntent(dataRoot, {
    taskInstanceId: h.intent.taskInstanceId, attemptId: h.intent.attemptId, commandId: h.intent.commandId,
    backend: 'native', controllerRevision: 1, role: 'muse_main', modeId: 'engineering-v2',
    modeConfigRevision: h.modeConfig.revision, intentPayload: h.intent.intentPayload, lease: h.intent.lease,
  });
  assert.equal(again.created, false);
  assert.equal(again.intent.attemptId, h.intent.attemptId);
  const redeliver = kernel.deliverCommand(kernelRoot, { intent: h.intent, issued: h.issued }, {});
  assert.equal(redeliver.created, false);
  assert.equal(redeliver.receipt.commandId, h.receipt.commandId);
  assert.equal(store.countIntents(dataRoot), before.intents);
  assert.equal(kernel.countReceipts(kernelRoot), before.receipts);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

// ── 2. Crash matrix (SIMULATED injected exceptions) ──────────────────────
await check('SIMULATED crash before intent commit commits nothing; commit succeeds after', () => {
  const dataRoot = tmpRoot('spike02-crash-pre-');
  const { taskInstanceId, attemptId, commandId } = ids('precommit');
  throwsCode(() => store.commitIntent(dataRoot, {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: 0,
    intentPayload: { op: 'x' }, lease: null,
  }, { crashPoint: 'before-commit' }), 'injected-crash');
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

await check('SIMULATED crash during intent commit leaves orphan tmp but no intent; retry commits once', () => {
  const dataRoot = tmpRoot('spike02-crash-mid-');
  const { taskInstanceId, attemptId, commandId } = ids('midcommit');
  throwsCode(() => store.commitIntent(dataRoot, {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: 0,
    intentPayload: { op: 'x' }, lease: null,
  }, { crashPoint: 'during-commit' }), 'injected-crash');
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

await check('SIMULATED crash after intent commit (ACK lost): exactly one intent, replay is idempotent', () => {
  const dataRoot = tmpRoot('spike02-crash-post-');
  const { taskInstanceId, attemptId, commandId } = ids('postcommit');
  const fields = {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: 0,
    intentPayload: { op: 'x' }, lease: null,
  };
  throwsCode(() => store.commitIntent(dataRoot, fields, { crashPoint: 'after-commit' }), 'injected-crash');
  assert.ok(store.queryByCommandId(dataRoot, commandId));
  const replay = store.commitIntent(dataRoot, fields);
  assert.equal(replay.created, false);
  assert.equal(store.countIntents(dataRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

await check('lost bridge delivery commits nothing in Kernel; redelivery accepted exactly once', () => {
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
  const q = store.attachLease(dataRoot, commandId, { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  assert.equal(issue.ok, true);
  assert.equal(kernel.countReceipts(kernelRoot), 0);
  const first = kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, {});
  assert.equal(first.created, true);
  const replay = kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, {});
  assert.equal(replay.created, false);
  assert.equal(kernel.countReceipts(kernelRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

await check('SIMULATED crash before/during/after inbox commit and ACK loss keep exactly one receipt', () => {
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
  const q = store.attachLease(dataRoot, commandId, { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  assert.equal(issue.ok, true);
  const env = { intent: q.intent, issued: issue.issued };
  throwsCode(() => kernel.deliverCommand(kernelRoot, env, { crashPoint: 'before-commit' }), 'injected-crash');
  assert.equal(kernel.readReceipt(kernelRoot, commandId), null);
  throwsCode(() => kernel.deliverCommand(kernelRoot, env, { crashPoint: 'during-commit' }), 'injected-crash');
  assert.equal(kernel.readReceipt(kernelRoot, commandId), null);
  assert.equal(kernel.countReceipts(kernelRoot), 0);
  throwsCode(() => kernel.deliverCommand(kernelRoot, env, { crashPoint: 'after-commit-before-ack' }), 'injected-crash');
  assert.ok(kernel.readReceipt(kernelRoot, commandId));
  const replay = kernel.deliverCommand(kernelRoot, env, {});
  assert.equal(replay.created, false);
  assert.equal(kernel.countReceipts(kernelRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

// ── 3. Rejections ───────────────────────────────────────────────────────
await check('forged target (wrong issuer string) is refused', () => {
  const dataRoot = tmpRoot('spike02-forge-ctrl-');
  const kernelRoot = tmpRoot('spike02-forge-kern-');
  const h = handshake(dataRoot, kernelRoot, 'forge');
  const forged = JSON.parse(JSON.stringify(h.issued));
  forged.issuer = 'controller';
  forged.provenance.issuer = 'controller';
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: h.intent, issued: forged }, {}), 'forged-issuer');
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

await check('F-01 ADVERSARIAL: self-consistent forgery (correct issuer string + recomputed matching digests, never sealed) is rejected', () => {
  const dataRoot = tmpRoot('spike02-adv-ctrl-');
  const kernelRoot = tmpRoot('spike02-adv-kern-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const { taskInstanceId, attemptId, commandId } = ids('adversarial');
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'engineer-turn' }, lease: null,
  });
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' });
  const q = store.attachLease(dataRoot, commandId, { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  const good = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  assert.equal(good.ok, true);
  // Attacker swaps the model target, then honestly recomputes every digest and
  // stamps the trusted issuer string — without ever passing through the bridge seal.
  const evilTarget = { ...good.issued.target, routeId: 'attacker-route', providerId: 'attacker-provider', remoteModelId: 'attacker-model' };
  const forged = {
    issuer: 'registry-bridge',
    taskInstanceId, role: 'muse_main', target: evilTarget,
    provenance: {
      issuer: 'registry-bridge',
      resolutionIdCompat: good.issued.provenance.resolutionIdCompat,
      registrySnapshotDigest: bridge.snapshotDigestOf(snapshot),
      targetDigest: bridge.targetDigestOf(evilTarget),
      modeConfigRevision: modeConfig.revision,
    },
  };
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: forged }, {}), 'forged-issuer');
  assert.equal(kernel.countReceipts(kernelRoot), 0);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

await check('F-01 ADVERSARIAL: sealed issuance with attacker-swapped target bytes is rejected', () => {
  const dataRoot = tmpRoot('spike02-adv2-ctrl-');
  const kernelRoot = tmpRoot('spike02-adv2-kern-');
  const h = handshake(dataRoot, kernelRoot, 'advswap');
  // Attacker keeps the sealed provenance (hits the sealed record) but swaps target bytes.
  const swapped = JSON.parse(JSON.stringify(h.issued));
  swapped.target.remoteModelId = 'attacker-model';
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: h.intent, issued: swapped }, {}), 'forged-issuer');
  // Attacker recomputes digests to match the swapped bytes: no sealed record exists.
  const regilded = JSON.parse(JSON.stringify(swapped));
  regilded.provenance.targetDigest = bridge.targetDigestOf(swapped.target);
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: h.intent, issued: regilded }, {}), 'forged-issuer');
  assert.equal(kernel.countReceipts(kernelRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

await check('F-01: unsealed bridge issuance (no kernelRoot seal step) is rejected at delivery', () => {
  const dataRoot = tmpRoot('spike02-unsealed-c-');
  const kernelRoot = tmpRoot('spike02-unsealed-k-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const { taskInstanceId, attemptId, commandId } = ids('unsealed');
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'engineer-turn' }, lease: null,
  });
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' });
  const q = store.attachLease(dataRoot, commandId, { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  const unsealed = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, {});
  assert.equal(unsealed.ok, true);
  // issuanceId is only an identifier; authority comes from the sealed record, which was never written.
  assert.equal(typeof unsealed.issuanceId, 'string');
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: unsealed.issued }, {}), 'forged-issuer');
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

await check('stale lease epoch is refused after fencing advances', () => {
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
  const second = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' });
  assert.equal(second.leaseEpoch, 2);
  const staleIntent = { ...store.queryByCommandId(dataRoot, commandId), lease: { epoch: first.leaseEpoch, storeIncarnation: first.storeIncarnation } };
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  assert.equal(issue.ok, true);
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: staleIntent, issued: issue.issued }, {}), 'stale-lease');
  assert.equal(kernel.countReceipts(kernelRoot), 0);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

await check('conflicting payload under the same commandId is refused (no second attempt)', () => {
  const dataRoot = tmpRoot('spike02-conf-ctrl-');
  const kernelRoot = tmpRoot('spike02-kern-');
  const h = handshake(dataRoot, kernelRoot, 'conflict');
  throwsCode(() => store.commitIntent(dataRoot, {
    taskInstanceId: h.intent.taskInstanceId, attemptId: 'spike02-other-attempt',
    commandId: h.intent.commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: h.modeConfig.revision,
    intentPayload: { op: 'different-payload' }, lease: null,
  }), 'intent-conflict');
  // Attacker-consistent redigest with a swapped attemptId still cannot reuse the commandId.
  const reused = { ...h.intent, attemptId: 'spike02-other-attempt' };
  reused.intentDigest = envelope.intentDigestOf({ ...reused, payloadDigest: reused.payloadDigest });
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: reused, issued: h.issued }, {}), 'command-conflict');
  assert.equal(store.countIntents(dataRoot), 1);
  assert.equal(kernel.countReceipts(kernelRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

await check('F-05 TAMPER: mutated payload with stale digest is rejected', () => {
  const dataRoot = tmpRoot('spike02-tamper-c-');
  const kernelRoot = tmpRoot('spike02-tamper-k-');
  const h = handshake(dataRoot, kernelRoot, 'tamper');
  const tampered = { ...h.intent, intentPayload: { op: 'engineer-turn', smuggled: 'attacker-instruction' } };
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: tampered, issued: h.issued }, {}), 'payload-tamper');
  assert.equal(kernel.countReceipts(kernelRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

// ── F-02: real stale-restore attack ──────────────────────────────────────
await check('F-02 REAL ATTACK: valid epoch-1 lease reused after epoch-1 DB restore is rejected (rollback-detected)', async () => {
  const dataRoot = tmpRoot('spike02-f02-c-');
  const kernelRoot = tmpRoot('spike02-f02-k-');
  const witnessRoot = tmpRoot('spike02-f02-w-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const taskInstanceId = 'spike02-f02-task-' + (++seq);
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId: 'a1', commandId: 'cmd1', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'x' }, lease: null,
  });
  const lease1 = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' }, { witnessRoot });
  assert.equal(lease1.leaseEpoch, 1);
  const backup = tmpRoot('spike02-f02-bak-');
  cp.execFileSync('cp', ['-a', kernelRoot + '/.', backup + '/']);
  kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' }, { witnessRoot }); // epoch 2 fences epoch 1
  cp.execFileSync('cp', ['-a', backup + '/.', kernelRoot + '/']); // restore stale epoch-1 DB
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId: 'a2', commandId: 'cmd2', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'y' }, lease: null,
  });
  const q = store.attachLease(dataRoot, 'cmd2', { epoch: lease1.leaseEpoch, storeIncarnation: lease1.storeIncarnation });
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  assert.equal(issue.ok, true);
  // The epoch-1 lease is cryptographically valid and matches the restored DB counter —
  // only the OUT-OF-DB witness (max=2) detects the rollback.
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, { witnessRoot }), 'rollback-detected');
  assert.equal(kernel.countReceipts(kernelRoot), 0);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
  fs.rmSync(witnessRoot, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
});

await check('F-02 RECOVERY: after rollback, re-acquisition fences above the witness max and executes once', () => {
  const dataRoot = tmpRoot('spike02-f02r-c-');
  const kernelRoot = tmpRoot('spike02-f02r-k-');
  const witnessRoot = tmpRoot('spike02-f02r-w-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const taskInstanceId = 'spike02-f02r-task-' + (++seq);
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId: 'a1', commandId: 'cmd1', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'x' }, lease: null,
  });
  kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' }, { witnessRoot });
  const backup = tmpRoot('spike02-f02r-bak-');
  cp.execFileSync('cp', ['-a', kernelRoot + '/.', backup + '/']);
  kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' }, { witnessRoot });
  cp.execFileSync('cp', ['-a', backup + '/.', kernelRoot + '/']);
  // Operator recovery: suspend, re-acquire (epoch 3 = witness max 2 + 1, never re-issues 2),
  // authorize a NEW command, deliver.
  const lease3 = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' }, { witnessRoot });
  assert.equal(lease3.leaseEpoch, 3);
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId: 'a3', commandId: 'cmd3', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'recovered' }, lease: null,
  });
  const q = store.attachLease(dataRoot, 'cmd3', { epoch: lease3.leaseEpoch, storeIncarnation: lease3.storeIncarnation });
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  const delivery = kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, { witnessRoot });
  assert.equal(delivery.created, true);
  assert.equal(delivery.receipt.leaseEpoch, 3);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
  fs.rmSync(witnessRoot, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
});

await check('F-02 LIMIT (documented): without an independent witness the restore is UNDETECTED', () => {
  const dataRoot = tmpRoot('spike02-f02u-c-');
  const kernelRoot = tmpRoot('spike02-f02u-k-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const taskInstanceId = 'spike02-f02u-task-' + (++seq);
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId: 'a1', commandId: 'cmd1', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'x' }, lease: null,
  });
  const lease1 = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' });
  const backup = tmpRoot('spike02-f02u-bak-');
  cp.execFileSync('cp', ['-a', kernelRoot + '/.', backup + '/']);
  kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' });
  cp.execFileSync('cp', ['-a', backup + '/.', kernelRoot + '/']);
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId: 'a2', commandId: 'cmd2', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'y' }, lease: null,
  });
  const q = store.attachLease(dataRoot, 'cmd2', { epoch: lease1.leaseEpoch, storeIncarnation: lease1.storeIncarnation });
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  // No witnessRoot: the counter restored with its DB accepts the old lease. This is the
  // documented UNSUPPORTED case — production MUST NOT rely on same-DB counters alone.
  const delivery = kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, {});
  assert.equal(delivery.created, true);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
});

// ── F-04: intent→resolution binding ──────────────────────────────────────
await check('F-04: role mismatch against an otherwise valid sealed resolution is rejected', () => {
  const dataRoot = tmpRoot('spike02-brole-c-');
  const kernelRoot = tmpRoot('spike02-brole-k-');
  const h = handshake(dataRoot, kernelRoot, 'bindrole');
  const wrong = { ...h.intent, role: 'reviewer' };
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: wrong, issued: h.issued }, {}), 'binding-mismatch');
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

await check('F-04: mode mismatch against an otherwise valid sealed resolution is rejected', () => {
  const dataRoot = tmpRoot('spike02-bmode-c-');
  const kernelRoot = tmpRoot('spike02-bmode-k-');
  const h = handshake(dataRoot, kernelRoot, 'bindmode');
  const wrong = { ...h.intent, modeId: 'engineering-v1' };
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: wrong, issued: h.issued }, {}), 'binding-mismatch');
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

await check('F-04: revision mismatch against an otherwise valid sealed resolution is rejected', () => {
  const dataRoot = tmpRoot('spike02-brev-c-');
  const kernelRoot = tmpRoot('spike02-brev-k-');
  const h = handshake(dataRoot, kernelRoot, 'bindrev');
  const wrong = { ...h.intent, modeConfigRevision: (h.intent.modeConfigRevision || 0) + 1000 };
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: wrong, issued: h.issued }, {}), 'binding-mismatch');
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

// ── F-03: cross-process concurrency (separate OS processes) ──────────────
await check('F-03 XPROC: 8 concurrent identical commits yield one intent, one winner, idempotent losers', async () => {
  const dataRoot = tmpRoot('spike02-xc-c-');
  const fields = {
    taskInstanceId: 'spike02-xc-task', attemptId: 'spike02-xc-attempt', commandId: 'spike02-xc-cmd',
    backend: 'native', controllerRevision: 1, role: 'muse_main', modeId: 'engineering-v2',
    modeConfigRevision: 0, intentPayload: { op: 'xproc' }, lease: null,
  };
  const results = await Promise.all(Array.from({ length: 8 }, () => runWorker({ mode: 'commit', dataRoot, fields })));
  for (const r of results) assert.equal(r.doc && r.doc.ok, true, JSON.stringify(r));
  assert.equal(results.filter((r) => r.doc.created === true).length, 1);
  assert.equal(store.countIntents(dataRoot), 1);
  assert.equal(store.queryByCommandId(dataRoot, fields.commandId).attemptId, fields.attemptId);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

await check('F-03 XPROC: 8 concurrent conflicting commits yield one winner, conflict losers, never overwrite', async () => {
  const dataRoot = tmpRoot('spike02-xcc-c-');
  const base = {
    taskInstanceId: 'spike02-xcc-task', commandId: 'spike02-xcc-cmd',
    backend: 'native', controllerRevision: 1, role: 'muse_main', modeId: 'engineering-v2',
    modeConfigRevision: 0, lease: null,
  };
  const jobs = Array.from({ length: 8 }, (_, i) => runWorker({
    mode: 'commit', dataRoot,
    fields: { ...base, attemptId: 'spike02-xcc-attempt-' + (i % 2), intentPayload: { op: 'variant-' + (i % 2) } },
  }));
  const results = await Promise.all(jobs);
  for (const r of results) assert.ok(r.doc, 'worker produced no result');
  assert.equal(results.filter((r) => r.doc.ok === true && r.doc.created === true).length, 1);
  for (const r of results) {
    if (!(r.doc.ok === true)) assert.equal(r.doc.code, 'intent-conflict');
  }
  assert.equal(store.countIntents(dataRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

await check('F-03 XPROC: 8 concurrent lease acquisitions yield unique monotonic epochs 1..8', async () => {
  const kernelRoot = tmpRoot('spike02-xa-k-');
  const results = await Promise.all(Array.from({ length: 8 }, () => runWorker({
    mode: 'acquire', kernelRoot, taskInstanceId: 'spike02-xa-task', backend: 'native',
  })));
  const epochs = results.map((r) => r.doc && r.doc.leaseEpoch).sort((a, b) => a - b);
  assert.deepEqual(epochs, [1, 2, 3, 4, 5, 6, 7, 8]);
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

await check('F-03 XPROC: 8 concurrent identical deliveries yield one receipt, one winner', async () => {
  const dataRoot = tmpRoot('spike02-xd-c-');
  const kernelRoot = tmpRoot('spike02-xd-k-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const { taskInstanceId, attemptId, commandId } = ids('xdeliver');
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId, commandId, backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'xproc-deliver' }, lease: null,
  });
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' });
  const q = store.attachLease(dataRoot, commandId, { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  assert.equal(issue.ok, true);
  const results = await Promise.all(Array.from({ length: 8 }, () => runWorker({
    mode: 'deliver', kernelRoot, intent: q.intent, issued: issue.issued,
  })));
  for (const r of results) assert.equal(r.doc && r.doc.ok, true, JSON.stringify(r));
  assert.equal(results.filter((r) => r.doc.created === true).length, 1);
  assert.equal(kernel.countReceipts(kernelRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

// ── F-06: REAL process termination crashes ───────────────────────────────
await check('F-06 REAL: process exit(3) before commit persists nothing', async () => {
  const dataRoot = tmpRoot('spike02-f06pre-c-');
  const { err } = await runWorker({ mode: 'die-before-commit', dataRoot });
  assert.ok(err, 'expected nonzero exit');
  assert.equal(err.code, 3);
  assert.equal(store.countIntents(dataRoot), 0);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

await check('F-06 REAL: commit then death without ACK keeps exactly one intent; replay idempotent', async () => {
  const dataRoot = tmpRoot('spike02-f06post-c-');
  const fields = {
    taskInstanceId: 'spike02-f06-task', attemptId: 'spike02-f06-attempt', commandId: 'spike02-f06-cmd',
    backend: 'native', controllerRevision: 1, role: 'muse_main', modeId: 'engineering-v2',
    modeConfigRevision: 0, intentPayload: { op: 'x' }, lease: null,
  };
  const { err } = await runWorker({ mode: 'commit-no-ack', dataRoot, fields });
  assert.equal(err, null);
  assert.ok(store.queryByCommandId(dataRoot, fields.commandId));
  const replay = store.commitIntent(dataRoot, fields);
  assert.equal(replay.created, false);
  assert.equal(store.countIntents(dataRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

await check('F-06 REAL: SIGKILL mid-loop leaves only complete records; orphan tmps ignored; replay consistent', async () => {
  const dataRoot = tmpRoot('spike02-f06kill-c-');
  const fields = {
    taskInstanceId: 'spike02-f06k-task', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: 0,
    intentPayload: { op: 'x' }, lease: null,
  };
  const child = cp.spawn('node', [workerPath, JSON.stringify({ mode: 'commit-loop', dataRoot, fields, prefix: 'spike02-f06k-cmd-', count: 2000 })], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
    if (child.exitCode === null) await new Promise((resolve) => child.on('close', resolve));
  }
  const dir = path.join(dataRoot, 'controller-intent');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const jsons = names.filter((n) => n.endsWith('.json'));
  // Every committed record is complete and self-consistent (no torn writes: O_EXCL + rename).
  for (const name of jsons) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.payloadDigest, envelope.payloadDigestOf(doc.intentPayload));
    assert.equal(doc.intentDigest, envelope.intentDigestOf({ ...doc, payloadDigest: doc.payloadDigest }));
    // Replay of the exact committed envelope is idempotent, never a second attempt.
    const replay = store.commitIntent(dataRoot, {
      taskInstanceId: doc.taskInstanceId, attemptId: doc.attemptId, commandId: doc.commandId,
      backend: doc.backend, controllerRevision: doc.controllerRevision, role: doc.role, modeId: doc.modeId,
      modeConfigRevision: doc.modeConfigRevision, intentPayload: doc.intentPayload, lease: doc.lease,
    });
    assert.equal(replay.created, false);
  }
  console.log('      (SIGKILL recovery inspected ' + jsons.length + ' complete records, ' + (names.length - jsons.length) + ' orphan tmps ignored)');
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

// ── 4. Source-mapping fixtures ──────────────────────────────────────────
await check('resolutionId is compat-only: baseUrl mutation keeps resolutionId, changes source digest', () => {
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

await check('modeConfigRevision is not a definition digest: same revision, changed definition diverges', () => {
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const before = bridge.snapshotDigestOf(snapshot);
  const mutated = JSON.parse(JSON.stringify(snapshot));
  const v2 = mutated.modes.find((m) => m.id === 'engineering-v2');
  v2.slots[0].requirements = { ...(v2.slots[0].requirements || {}), pinnedProvider: 'synthetic-ghost-provider' };
  assert.notEqual(bridge.snapshotDigestOf(mutated), before);
  const result = resolver.compileModeConfig(modeConfig, mutated, {});
  assert.equal(result.ok, false);
});

await check('engineering-v2 is Muse-only: Dual role mapping is rejected', () => {
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
  const modeConfig = museModeConfig(snapshot);
  const outsider = bridge.issueForIntent({ taskInstanceId: 'spike02-x', role: 'primaryEngineer' }, modeConfig, snapshot, {});
  assert.equal(outsider.ok, false);
});

await check('unresolvable endpoint yields target-incomplete, never a fake binding', () => {
  const snapshot = issuerSnapshot();
  const bad = { schemaVersion: 1, modeId: 'engineering-v2', revision: 0, slots: { main: { logicalModelId: 'no-such-model', routeId: 'no-such-provider/no-such-route', reasoning: 'xhigh' } } };
  const issue = bridge.issueForIntent({ taskInstanceId: 'spike02-t', role: 'muse_main' }, bad, snapshot, {});
  assert.equal(issue.ok, false);
  assert.ok(issue.errors.length > 0);
});

// ── G. Final hardening: same-lease rollback, issuance identity, witness loss ──
await check('G-01 Finding 1: same-lease rollback losing an accepted receipt fails closed (reconciliation-required)', () => {
  const dataRoot = tmpRoot('spike02-g01-c-');
  const kernelRoot = tmpRoot('spike02-g01-k-');
  const witnessRoot = tmpRoot('spike02-g01-w-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const taskInstanceId = 'spike02-g01-task-' + (++seq);
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId: 'a1', commandId: 'cmd1', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'irreversible-effect' }, lease: null,
  });
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' }, { witnessRoot });
  const q = store.attachLease(dataRoot, 'cmd1', { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  assert.equal(issue.ok, true);
  // Back up AFTER sealing (sealed record + key present) but BEFORE delivery.
  const backup = tmpRoot('spike02-g01-bak-');
  cp.execFileSync('cp', ['-a', kernelRoot + '/.', backup + '/']);
  const first = kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, { witnessRoot });
  assert.equal(first.created, true);
  // Restore pre-acceptance kernel state (wipe + copy = true restore; plain cp
  // would leave post-backup files behind); witness stays intact. Same epoch, same lease.
  fs.rmSync(kernelRoot, { recursive: true, force: true });
  fs.mkdirSync(kernelRoot, { recursive: true });
  cp.execFileSync('cp', ['-a', backup + '/.', kernelRoot + '/']);
  // The lost receipt must NOT be silently re-accepted: prior acceptance may have executed.
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, { witnessRoot }), 'reconciliation-required');
  assert.equal(kernel.countReceipts(kernelRoot), 0);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
  fs.rmSync(witnessRoot, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
});

await check('G-02 Finding 1 crash window: receipt-without-witness heals on idempotent replay, never duplicates', () => {
  const dataRoot = tmpRoot('spike02-g02-c-');
  const kernelRoot = tmpRoot('spike02-g02-k-');
  const witnessRoot = tmpRoot('spike02-g02-w-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const taskInstanceId = 'spike02-g02-task-' + (++seq);
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId: 'a1', commandId: 'cmd1', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'x' }, lease: null,
  });
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' }, { witnessRoot });
  const q = store.attachLease(dataRoot, 'cmd1', { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  assert.equal(issue.ok, true);
  // Crash AFTER receipt publish but BEFORE witness note: receipt durable, witness stale.
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, { witnessRoot, crashPoint: 'after-receipt-before-witness' }), 'injected-crash');
  assert.ok(kernel.readReceipt(kernelRoot, 'cmd1'));
  // Replay must be idempotent (receipt exists) AND heal the witness entry.
  const replay = kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, { witnessRoot });
  assert.equal(replay.created, false);
  assert.equal(kernel.countReceipts(kernelRoot), 1);
  const replay2 = kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, { witnessRoot });
  assert.equal(replay2.created, false);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
  fs.rmSync(witnessRoot, { recursive: true, force: true });
});

await check('G-03 Finding 2: two tasks sharing the same model target are both accepted', () => {
  const dataRoot = tmpRoot('spike02-g03-c-');
  const kernelRoot = tmpRoot('spike02-g03-k-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const acceptTask = (n) => {
    const taskInstanceId = 'spike02-g03-task-' + (++seq) + '-' + n;
    const commandId = 'spike02-g03-cmd-' + seq;
    store.commitIntent(dataRoot, {
      taskInstanceId, attemptId: 'a' + n, commandId, backend: 'native', controllerRevision: 1,
      role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
      intentPayload: { op: 'shared-target-task-' + n }, lease: null,
    });
    const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' });
    const q = store.attachLease(dataRoot, commandId, { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
    const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
    assert.equal(issue.ok, true);
    const delivery = kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, {});
    assert.equal(delivery.created, true);
    return issue;
  };
  const first = acceptTask('A');
  const second = acceptTask('B');
  // Same model target, but distinct issuance identities (task binding differs).
  assert.equal(second.issued.provenance.targetDigest, first.issued.provenance.targetDigest);
  assert.notEqual(second.issuanceId, first.issuanceId);
  assert.equal(kernel.countReceipts(kernelRoot), 2);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

await check('G-04 Finding 2: same task and target under two snapshots seal twice, no conflict', () => {
  const dataRoot = tmpRoot('spike02-g04-c-');
  const kernelRoot = tmpRoot('spike02-g04-k-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const mutated = JSON.parse(JSON.stringify(snapshot));
  mutated.providers[0].baseUrl = 'https://synthetic-second.example.invalid/v1';
  const taskInstanceId = 'spike02-g04-task-' + (++seq);
  const first = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  const second = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, mutated, { kernelRoot });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.issued.provenance.targetDigest, first.issued.provenance.targetDigest);
  assert.notEqual(second.issued.provenance.registrySnapshotDigest, first.issued.provenance.registrySnapshotDigest);
  assert.notEqual(second.issuanceId, first.issuanceId);
  // Cross-task issuance replay is still rejected (generation binding holds).
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId: 'a1', commandId: 'cmd1', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'x' }, lease: null,
  });
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' });
  const q = store.attachLease(dataRoot, 'cmd1', { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  const otherTask = bridge.issueForIntent({ taskInstanceId: 'spike02-g04-other', role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  assert.equal(otherTask.ok, true);
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: otherTask.issued }, {}), 'generation-mismatch');
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
});

await check('G-05 Finding 3: witness deletion after protection fails closed', () => {
  const dataRoot = tmpRoot('spike02-g05-c-');
  const kernelRoot = tmpRoot('spike02-g05-k-');
  const witnessRoot = tmpRoot('spike02-g05-w-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const taskInstanceId = 'spike02-g05-task-' + (++seq);
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId: 'a1', commandId: 'cmd1', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'x' }, lease: null,
  });
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' }, { witnessRoot });
  const q = store.attachLease(dataRoot, 'cmd1', { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  assert.equal(issue.ok, true);
  // Attacker/operator deletes the witness after protection was established.
  fs.rmSync(witnessRoot, { recursive: true, force: true });
  fs.mkdirSync(witnessRoot, { recursive: true });
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, { witnessRoot }), 'reconciliation-required');
  assert.equal(kernel.countReceipts(kernelRoot), 0);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
  fs.rmSync(witnessRoot, { recursive: true, force: true });
});

await check('G-06 Finding 3: corrupted witness fails closed (never SyntaxError, never skipped)', () => {
  const dataRoot = tmpRoot('spike02-g06-c-');
  const kernelRoot = tmpRoot('spike02-g06-k-');
  const witnessRoot = tmpRoot('spike02-g06-w-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const taskInstanceId = 'spike02-g06-task-' + (++seq);
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId: 'a1', commandId: 'cmd1', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'x' }, lease: null,
  });
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' }, { witnessRoot });
  const q = store.attachLease(dataRoot, 'cmd1', { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  assert.equal(issue.ok, true);
  // Corrupt the witness record bytes for this generation.
  const files = fs.readdirSync(witnessRoot).filter((n) => n.endsWith('.witness.json'));
  assert.ok(files.length > 0);
  fs.writeFileSync(path.join(witnessRoot, files[0]), '{corrupt,,json');
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, { witnessRoot }), 'reconciliation-required');
  assert.equal(kernel.countReceipts(kernelRoot), 0);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
  fs.rmSync(witnessRoot, { recursive: true, force: true });
});

await check('G-07 Finding 3: omitting witnessRoot after protection is a downgrade and fails closed', () => {
  const dataRoot = tmpRoot('spike02-g07-c-');
  const kernelRoot = tmpRoot('spike02-g07-k-');
  const witnessRoot = tmpRoot('spike02-g07-w-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const taskInstanceId = 'spike02-g07-task-' + (++seq);
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId: 'a1', commandId: 'cmd1', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'x' }, lease: null,
  });
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' }, { witnessRoot });
  const q = store.attachLease(dataRoot, 'cmd1', { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  assert.equal(issue.ok, true);
  // Caller "forgets" the witness: protection must not silently drop.
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, {}), 'witness-required');
  throwsCode(() => kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' }, {}), 'witness-required');
  assert.equal(kernel.countReceipts(kernelRoot), 0);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
  fs.rmSync(witnessRoot, { recursive: true, force: true });
});

await check('G-08 Finding 3: explicit fenced recovery re-enables progress; old leases stay dead', () => {
  const dataRoot = tmpRoot('spike02-g08-c-');
  const kernelRoot = tmpRoot('spike02-g08-k-');
  const witnessRoot = tmpRoot('spike02-g08-w-');
  const snapshot = issuerSnapshot();
  const modeConfig = museModeConfig(snapshot);
  const taskInstanceId = 'spike02-g08-task-' + (++seq);
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId: 'a1', commandId: 'cmd1', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'x' }, lease: null,
  });
  const lease = kernel.acquireGeneration(kernelRoot, { taskInstanceId, backend: 'native' }, { witnessRoot });
  const q = store.attachLease(dataRoot, 'cmd1', { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation });
  const issue = bridge.issueForIntent({ taskInstanceId, role: 'muse_main' }, modeConfig, snapshot, { kernelRoot });
  assert.equal(issue.ok, true);
  fs.rmSync(witnessRoot, { recursive: true, force: true });
  fs.mkdirSync(witnessRoot, { recursive: true });
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, { witnessRoot }), 'reconciliation-required');
  // Explicit operator recovery: attested max + reason recorded, epoch fenced above all known.
  const recovered = kernel.fenceForRecovery(kernelRoot, witnessRoot, {
    taskInstanceId, backend: 'native', attestedMaxEpoch: 1, operatorAttestation: 'synthetic-test-recovery',
  });
  assert.equal(recovered.leaseEpoch, 2);
  // Old lease can never deliver again (fenced).
  throwsCode(() => kernel.deliverCommand(kernelRoot, { intent: q.intent, issued: issue.issued }, { witnessRoot }), 'stale-lease');
  // New command under the recovery lease executes exactly once.
  store.commitIntent(dataRoot, {
    taskInstanceId, attemptId: 'a2', commandId: 'cmd2', backend: 'native', controllerRevision: 1,
    role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: modeConfig.revision,
    intentPayload: { op: 'recovered' }, lease: null,
  });
  const q2 = store.attachLease(dataRoot, 'cmd2', { epoch: recovered.leaseEpoch, storeIncarnation: recovered.storeIncarnation });
  const delivery = kernel.deliverCommand(kernelRoot, { intent: q2.intent, issued: issue.issued }, { witnessRoot });
  assert.equal(delivery.created, true);
  assert.equal(kernel.countReceipts(kernelRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
  fs.rmSync(witnessRoot, { recursive: true, force: true });
});

await check('G-09 Finding 3: legitimate first-time witness initialization still works', () => {
  const dataRoot = tmpRoot('spike02-g09-c-');
  const kernelRoot = tmpRoot('spike02-g09-k-');
  const witnessRoot = tmpRoot('spike02-g09-w-');
  const h = handshake(dataRoot, kernelRoot, 'g09first', witnessRoot);
  assert.ok(h.receipt);
  assert.equal(kernel.countReceipts(kernelRoot), 1);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kernelRoot, { recursive: true, force: true });
  fs.rmSync(witnessRoot, { recursive: true, force: true });
});

console.log('\nSpike02: PASS ' + passed + ' / FAIL ' + failed);
if (failed > 0) {
  console.log('Failures:\n' + failures.join('\n---\n'));
  process.exitCode = 1;
}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
