'use strict';
// A2.3 Registry-issued ExecutionTargetV2: every field derives from trusted
// Registry configuration or the explicit Controller session; anything else
// fails closed. No FS writes, no network, no credentials.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const v2 = require('../config/registry/native-target-v2.cjs');

delete process.env.DSH_HOME;
delete process.env.AIH_INSTALL_ROOT;

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log('PASS: ' + label);
}

function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function (k) { return JSON.stringify(k) + ':' + canonicalize(value[k]); }).join(',') + '}';
  }
  return JSON.stringify(value);
}
function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function baseBinding(overrides) {
  const b = {
    schemaVersion: 1,
    resolutionId: 'compat-resolution',
    modeId: 'engineering-v2',
    // the engine the Registry's engineering-v2 definition declares (EM-04C2 S4 closed table)
    orchestrationEngineId: 'muse-v0',
    modeConfigRevision: 3,
    roleId: 'muse_main',
    logicalModelId: 'logi-test',
    routeId: 'route-test',
    providerId: 'prov-test',
    remoteModelId: 'remote-test',
    connectionId: 'conn-test',
    executionKind: 'raw-model',
    accessType: 'api-key',
    protocolId: 'openai-responses',
    reasoning: 'low',
    requiredCapabilities: ['text'],
    slotRequirements: {},
    dataUseTier: 'standard',
  };
  return Object.assign(b, overrides || {});
}

function baseRecords(overrides) {
  const o = overrides || {};
  return {
    providers: [Object.assign({
      id: 'prov-test', transportId: 'openai-responses', status: 'enabled',
      authType: 'api-key', baseUrl: 'http://127.0.0.1:9',
      metadata: { billingTier: 'test-unmetered' },
    }, o.provider || {})],
    connections: [Object.assign({
      id: 'conn-test', providerId: 'prov-test', connectionKind: 'api-key',
      credentialRef: 'credential://connections/conn-test', status: 'connected',
      metadata: {},
    }, o.connection || {})],
    models: [Object.assign({
      id: 'logi-test', contextWindow: 8192, maxOutputTokens: 1024,
      dataUseTier: 'standard', capabilities: { text: true },
    }, o.model || {})],
    routes: [Object.assign({
      id: 'route-test', providerId: 'prov-test', logicalModelId: 'logi-test',
      remoteModelId: 'remote-test', reasoningLevels: ['low'],
      connectionId: 'conn-test', capacityConstraints: {},
    }, o.route || {})],
  };
}

function harness(bindingOverrides, recordOverrides, opts) {
  const binding = baseBinding(bindingOverrides);
  const records = baseRecords(recordOverrides);
  const compiled = { ok: true, code: null, message: null, binding: binding, snapshot: {}, modeConfig: {} };
  const service = { effectiveSnapshot: function () { return { snapshot: records, errors: [] }; } };
  const options = Object.assign({ taskInstanceId: 'task-e2e-1', sessionId: 'session-e2e-1' }, opts || {});
  return v2.issueExecutionTargetV2(options, { compiled: compiled, service: service });
}

check('happy path issues the exact extension contract', function () {
  const r = harness();
  assert.equal(r.ok, true, JSON.stringify(r));
  const t = r.target;
  assert.equal(t.extensionVersion, 1);
  assert.deepEqual(t.extension.endpoint, { protocol: 'http', origin: 'http://127.0.0.1:9', path: '/v1/responses', method: 'POST', localLoopback: true });
  assert.equal(t.extension.remoteModelIdConfirmed, 'remote-test');
  assert.equal(t.extension.reasoningEffort, 'low');
  assert.deepEqual(t.extension.billing, { tier: 'test-unmetered', dataUse: 'standard' });
  assert.deepEqual(t.extension.session, { sessionId: 'session-e2e-1' });
  assert.deepEqual(t.extension.capabilities, ['text']);
  assert.equal(t.extension.contextLimitTokens, 8192);
  assert.equal(t.extension.outputLimitTokens, 1024);
  assert.equal(t.extension.connectionBinding, 'conn-test');
  assert.equal(t.extension.credentialRef, 'credential://connections/conn-test');
  assert.equal(t.extensionDigest, sha256Hex(canonicalize(t.extension)), 'digest self-consistency');
  assert.equal(t.core.remoteModelId, 'remote-test', 'core travels alongside for the Rust seal check');
});

check('missing Controller session is refused', function () {
  const r = harness(null, null, { sessionId: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'registry-target-incomplete');
});

check('CRLF session is refused before issuance', function () {
  const r = harness(null, null, { sessionId: 's\r\nX: 1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'registry-target-incomplete');
});

check('missing billing tier fails closed', function () {
  const r = harness(null, { provider: { metadata: {} } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'registry-target-incomplete');
});

check('connection billing tier overrides provider tier', function () {
  const r = harness(null, { connection: { metadata: { billingTier: 'conn-tier' } } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.target.extension.billing.tier, 'conn-tier');
});

check('missing context window fails closed (never infinite)', function () {
  const r = harness(null, { model: { contextWindow: undefined } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'registry-target-incomplete');
});

check('missing output limit fails closed (never unbounded)', function () {
  const r = harness(null, { model: { maxOutputTokens: undefined } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'registry-target-incomplete');
});

check('route output limit wins over model output limit', function () {
  const r = harness(null, { route: { capacityConstraints: { maxOutputTokens: 512 } } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.target.extension.outputLimitTokens, 512);
});

check('missing credential reference fails closed', function () {
  const r = harness(null, { connection: { credentialRef: '' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'registry-target-incomplete');
});

check('disabled connection is unauthorized', function () {
  const r = harness(null, { connection: { status: 'disabled' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'registry-target-unauthorized');
});

check('unknown protocol dialect has no invented path', function () {
  const r = harness({ protocolId: 'agent-sdk' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'registry-target-incomplete');
});

check('non-loopback http is refused', function () {
  const rec = { provider: { baseUrl: 'http://192.0.2.1/' } };
  const r = harness(null, rec);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'registry-target-incomplete');
});

check('baseUrl path prefix is preserved in the endpoint path', function () {
  const r = harness(null, { provider: { baseUrl: 'http://127.0.0.1:9/prefix/' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.target.extension.endpoint.path, '/prefix/v1/responses');
});

check('a versioned baseUrl (.../v1) does not double the version segment', function () {
  // Regression (A5.2): https://api.example/v1 + /v1/responses produced
  // /v1/v1/responses, a request no provider serves, while the probe used
  // /v1/responses. The authoritative path must match the probed path.
  const r = harness(null, { provider: { baseUrl: 'http://127.0.0.1:9/v1' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.target.extension.endpoint.path, '/v1/responses');
  const r2 = harness(null, { provider: { baseUrl: 'http://127.0.0.1:9/v1/' } });
  assert.equal(r2.target.extension.endpoint.path, '/v1/responses');
});

check('wireProfile is emitted only when the provider declares a known profile (A5.4)', function () {
  const plain = harness(null, {});
  assert.equal(plain.ok, true, JSON.stringify(plain));
  assert.equal('wireProfile' in plain.target.extension, false, 'legacy digest must be unchanged');
  const go = harness(null, { provider: { metadata: { billingTier: 'test-unmetered', wireProfile: 'opencode-go-responses' } } });
  assert.equal(go.ok, true, JSON.stringify(go));
  assert.equal(go.target.extension.wireProfile, 'opencode-go-responses');
  assert.notEqual(go.target.extensionDigest || sha256Hex(canonicalize(go.target.extension)), sha256Hex(canonicalize(plain.target.extension)));
  const bad = harness(null, { provider: { metadata: { billingTier: 'test-unmetered', wireProfile: 'something-else' } } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'registry-target-incomplete');
});

// EM-04C2 S10 SEC-5: the mode -> engine mapping and the saved-configuration requirement are pinned
// here as well as in RegistryAdaptiveMode, so the authorization boundary does not rest on one suite
check('the mode/engine table and the saved-configuration requirement are pinned (SEC-5)', function () {
  const issuer = require('../config/registry/native-issuer.cjs');
  assert.deepEqual(Object.keys(issuer.NATIVE_SCOPES).sort(), ['engineering-v2', 'engineering-v2-adaptive']);
  assert.equal(issuer.scopeOf('engineering-v2').engineId, 'muse-v0');
  assert.equal(issuer.scopeOf('engineering-v2-adaptive').engineId, 'nexus-adaptive-v1');
  assert.equal(issuer.scopeOf('engineering-v2').requiresSavedConfiguration, false);
  assert.equal(issuer.scopeOf('engineering-v2-adaptive').requiresSavedConfiguration, true);
  assert.equal(issuer.engineAllowed(issuer.scopeOf('engineering-v2'), 'nexus-adaptive-v1'), false, 'the adaptive engine is never issued under the default mode');
  assert.equal(issuer.engineAllowed(issuer.scopeOf('engineering-v2-adaptive'), 'muse-v0'), false);
  // a selection naming any other mode is refused before anything is compiled
  for (const bad of ['engineering-v3', 'engineering-v1', '__proto__']) {
    const r = v2.issueExecutionTargetV2({ taskInstanceId: 't', sessionId: 's', selection: { modeId: bad } }, { service: {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'registry-unsupported-scope', bad);
  }
});

check('unsupported scope never reaches extension', function () {
  const r = harness({ roleId: 'engineer_normal' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'registry-role-unauthorized');
});

check('real repo config fails closed (chat-completions has no Responses path)', function () {
  const r = v2.issueExecutionTargetV2(
    { installRoot: repoRoot, dataRoot: repoRoot, taskInstanceId: 'task-real', sessionId: 'session-real' },
    {}
  );
  assert.equal(r.ok, false, 'real muse_main binding must not silently issue: ' + JSON.stringify(r.target));
  assert.equal(r.code, 'registry-target-incomplete');
});

console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed);
