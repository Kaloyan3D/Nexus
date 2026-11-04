'use strict';
// EM-02 Registry per-attempt reasoning: the task binding is built once from the task's own
// issuance and the bound route's declared levels; an attempt target differs from the task's
// issuance ONLY in its effort, which must be one of the binding's levels. Pure, no FS, no network.
const assert = require('node:assert/strict');
const issuer = require('../config/registry/native-issuer.cjs');
const tb = require('../config/registry/native-task-binding.cjs');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log('PASS: ' + label);
}

function taskTarget(effort, policy) {
  const target = {
    schemaVersion: 1, resolutionId: 'r', modeId: 'engineering-v2', orchestrationEngineId: 'muse-v0',
    modeConfigRevision: 0, roleId: 'muse_main', logicalModelId: 'm/1', routeId: 'p/m-1',
    providerId: 'p', remoteModelId: 'remote-1', connectionId: 'conn-1', executionKind: 'raw-model',
    accessType: 'api-key', protocolId: 'openai-responses', reasoning: effort,
    requiredCapabilities: ['toolCalling'], slotRequirements: { toolCalling: true }, dataUseTier: 'standard',
  };
  // the operator's slot policy as the resolver emits it (sorted); null = no policy configured
  const p = policy === undefined ? ['high', 'low', 'medium'] : policy;
  if (p !== null) target.allowedReasoning = p;
  const provenance = { issuer: issuer.ISSUER_ID, resolutionIdCompat: 'r', registrySnapshotDigest: 'a'.repeat(64), targetDigest: issuer.canonicalSha256(target), modeConfigRevision: 0 };
  const sealContent = { issuer: issuer.ISSUER_ID, taskInstanceId: 'task-1', role: 'muse_main', target: target, provenance: provenance };
  const resolution = { schemaVersion: 1, issuer: issuer.ISSUER_ID, taskInstanceId: 'task-1', role: 'muse_main', target: target, provenance: Object.assign({}, provenance, { issuanceId: issuer.canonicalSha256(sealContent) }) };
  const extension = {
    extensionVersion: 1, endpoint: { protocol: 'https', origin: 'https://api.example.test', path: '/v1/responses', method: 'POST', localLoopback: false },
    remoteModelIdConfirmed: 'remote-1', reasoningEffort: effort, billing: { tier: 'metered', dataUse: 'standard' },
    session: { sessionId: 'session-1' }, capabilities: ['toolCalling'], contextLimitTokens: 1000, outputLimitTokens: 100,
    connectionBinding: 'conn-1', credentialRef: 'credential://connections/conn-1',
  };
  return { issuance: { resolution: resolution }, extension: extension };
}
const ROUTE = { id: 'p/m-1', reasoningLevels: ['low', 'medium', 'high'] };

function bound() {
  const t = taskTarget('low');
  const b = tb.buildTaskBinding(t, ROUTE);
  assert.equal(b.ok, true, JSON.stringify(b));
  return { t: t, b: b };
}

function attempt(x, effort, patch) {
  const input = { taskBinding: x.b.binding, taskBindingDigest: x.b.bindingDigest, resolution: x.t.issuance.resolution, extension: x.t.extension, requestedEffort: effort };
  return tb.authorizeAttemptTarget(Object.assign(input, patch || {}));
}

check('the binding projects out exactly the effort and carries default + declared levels', function () {
  const x = bound();
  assert.equal(x.b.binding.defaultReasoning, 'low');
  assert.deepEqual(x.b.binding.supportedReasoning, ['high', 'low', 'medium']);
  assert.equal('reasoning' in x.b.binding.target, false);
  assert.equal('reasoningEffort' in x.b.binding.extension, false);
  assert.equal(x.b.binding.target.routeId, 'p/m-1');
  assert.equal(x.b.bindingDigest, tb.bindingDigest(x.b.binding));
});

check('a binding is refused when the route is not the bound one or declares no usable levels', function () {
  const t = taskTarget('low');
  assert.equal(tb.buildTaskBinding(t, { id: 'other', reasoningLevels: ['low'] }).ok, false);
  assert.equal(tb.buildTaskBinding(t, { id: 'p/m-1', reasoningLevels: [] }).ok, false);
  assert.equal(tb.buildTaskBinding(t, { id: 'p/m-1', reasoningLevels: ['high'] }).code, 'reasoning-level-not-supported');
  const drift = taskTarget('low');
  drift.extension.reasoningEffort = 'high';
  assert.equal(tb.buildTaskBinding(drift, ROUTE).ok, false);
});

check('each declared effort is authorized; only the effort and its digests change', function () {
  const x = bound();
  for (const e of ['medium', 'high']) {
    const a = attempt(x, e);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.attempt.effort, e);
    assert.equal(a.attempt.resolution.target.reasoning, e);
    assert.equal(a.attempt.extension.reasoningEffort, e);
    assert.notEqual(a.attempt.issuanceId, x.t.issuance.resolution.provenance.issuanceId);
    assert.equal(tb.selfConsistent(a.attempt.resolution), true);
    assert.deepEqual(tb.projectTarget(a.attempt.resolution.target), x.b.binding.target);
    assert.deepEqual(tb.projectExtension(a.attempt.extension), x.b.binding.extension);
    assert.equal(a.attempt.resolution.taskInstanceId, 'task-1');
  }
  // the default effort is the task's own issuance, byte for byte
  const d = attempt(x, 'low');
  assert.equal(d.attempt.issuanceId, x.t.issuance.resolution.provenance.issuanceId);
  assert.equal(d.attempt.resolution, x.t.issuance.resolution);
  // content-addressed: the same effort twice is the same target
  assert.equal(attempt(x, 'high').attempt.issuanceId, attempt(x, 'high').attempt.issuanceId);
});

check('undeclared efforts and non-levels are refused, never escalated or downshifted', function () {
  const x = bound();
  for (const e of ['xhigh', 'max', 'minimal', '', 'low high', null, 3]) {
    const a = attempt(x, e);
    assert.equal(a.ok, false, String(e));
  }
  assert.equal(attempt(x, 'xhigh').code, 'reasoning-level-not-supported');
});

check('a tampered binding, a foreign issuance or a changed target is refused', function () {
  const x = bound();
  const widened = Object.assign({}, x.b.binding, { supportedReasoning: ['high', 'low', 'medium', 'xhigh'] });
  assert.equal(attempt(x, 'xhigh', { taskBinding: widened }).code, 'registry-binding-invalid');
  assert.equal(attempt(x, 'high', { taskBindingDigest: 'f'.repeat(64) }).code, 'registry-binding-invalid');
  // an issuance whose content was changed without re-deriving its digests
  const bad = JSON.parse(JSON.stringify(x.t.issuance.resolution));
  bad.target.routeId = 'p/m-2';
  assert.equal(attempt(x, 'high', { resolution: bad }).code, 'registry-issuance-corrupt');
  // a self-consistent issuance of another route, or another task, is not this task's issuance
  for (const patch of [{ routeId: 'p/m-2' }, { remoteModelId: 'remote-2' }, { connectionId: 'conn-2' }]) {
    const other = taskTarget('low');
    Object.assign(other.issuance.resolution.target, patch);
    other.issuance.resolution.provenance.targetDigest = issuer.canonicalSha256(other.issuance.resolution.target);
    const sc = { issuer: other.issuance.resolution.issuer, taskInstanceId: 'task-1', role: 'muse_main', target: other.issuance.resolution.target, provenance: Object.assign({}, other.issuance.resolution.provenance) };
    delete sc.provenance.issuanceId;
    other.issuance.resolution.provenance.issuanceId = issuer.canonicalSha256(sc);
    assert.equal(attempt(x, 'high', { resolution: other.issuance.resolution }).code, 'registry-binding-mismatch', JSON.stringify(patch));
  }
  const ext = Object.assign({}, x.t.extension, { credentialRef: 'credential://other' });
  assert.equal(attempt(x, 'high', { extension: ext }).code, 'registry-binding-mismatch');
});

check('without a slot policy only the default is authorized, whatever the route declares', function () {
  const t = taskTarget('low', null);
  const b = tb.buildTaskBinding(t, ROUTE);
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.deepEqual(b.binding.supportedReasoning, ['low']);
  const x = { t: t, b: b };
  assert.equal(attempt(x, 'high').code, 'reasoning-level-not-supported');
  assert.equal(attempt(x, 'low').ok, true);
});

check('a policy level the route does not declare, or a binding claiming other levels, is refused', function () {
  const t = taskTarget('low', ['low', 'xhigh']);
  assert.equal(tb.buildTaskBinding(t, ROUTE).code, 'reasoning-level-not-supported');
  const x = bound();
  // the binding widened and re-digested (as a delivery channel could): it no longer matches
  // what the sealed task target authorizes
  const wide = Object.assign({}, x.b.binding, { supportedReasoning: ['high', 'low', 'medium', 'xhigh'] });
  const r = attempt(x, 'xhigh', { taskBinding: wide, taskBindingDigest: tb.bindingDigest(wide) });
  assert.equal(r.code, 'registry-binding-mismatch');
  const narrow = Object.assign({}, x.b.binding, { supportedReasoning: ['high', 'low'] });
  assert.equal(attempt(x, 'high', { taskBinding: narrow, taskBindingDigest: tb.bindingDigest(narrow) }).code, 'registry-binding-mismatch');
  assert.deepEqual(tb.authorizedLevels(taskTarget('low', null).issuance.resolution.target), ['low']);
});

console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed);
