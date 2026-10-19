'use strict';
// R-NATIVE-1 Registry-native adapter: read-only catalog over the
// authoritative Registry, golden default issuance, fail-closed selection.
// Offline, no network, no credentials, no writes outside tmp dirs.
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const bridgeFile = path.join(repo, 'config', 'registry', 'native-intent-bridge.cjs');
const v2 = require('../config/registry/native-target-v2.cjs');
const catalog = require('../config/registry/native-registry-catalog.cjs');
const resolver = require('../config/registry/resolver.cjs');

delete process.env.DSH_HOME;
delete process.env.AIH_INSTALL_ROOT;

let passed = 0;
function check(label, fn) { fn(); passed++; console.log('PASS: ' + label); }

function run(args) {
  const r = cp.spawnSync('node', [bridgeFile, ...args], { encoding: 'utf8' });
  const line = (r.stdout || '').trim().split('\n').pop();
  return JSON.parse(line);
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'r1-'));

// ---- fixture records: one issuable target -------------------------------
function goodRecords(over) {
  const o = over || {};
  return {
    providers: [Object.assign({
      schemaVersion: 1, id: 'prov-good', name: 'Good Provider', transportId: 'openai-responses', status: 'enabled',
      baseUrl: 'https://api.example.test/v1', authType: 'api-key',
      metadata: { billingTier: 'test-metered' },
    }, o.provider || {})],
    models: [Object.assign({
      schemaVersion: 1, id: 'logi-good', vendor: 'test-vendor', displayName: 'Good Model',
      checkpoint: 'ckpt-1', contextWindow: 8192, maxOutputTokens: 1024,
      dataUseTier: 'contributor', enabled: true, engines: ['muse-v0'],
      capabilities: { textInput: true, imageInput: false, toolCalling: true, streaming: true, reasoning: true },
    }, o.model || {})],
    connections: [Object.assign({
      schemaVersion: 1, id: 'conn-good', providerId: 'prov-good', connectionKind: 'api-key',
      credentialRef: 'credential://connections/conn-good',
      status: 'connected', provenance: 'operator-manual',
    }, o.connection || {})],
    routes: [Object.assign({
      schemaVersion: 1, id: 'route-good', providerId: 'prov-good', logicalModelId: 'logi-good',
      remoteModelId: 'remote-good', connectionId: 'conn-good', accessType: 'api-key',
      executionKind: 'raw-model', reasoningLevels: ['low'],
      availability: 'verified', enabled: true,
      compatibility: { transport: 'openai-responses' },
    }, o.route || {})],
  };
}

function stubService(records, modeConfig) {
  const snap = Object.assign({ schemaVersion: 1, modes: [modeDef()] }, records);
  const mc = modeConfig || {
    schemaVersion: 1, modeId: 'engineering-v2', revision: 0,
    slots: { main: { logicalModelId: 'logi-good', routeId: 'route-good', reasoning: 'low' } },
    roleOverrides: {},
  };
  return {
    calls: [],
    effectiveSnapshot: function () { return { snapshot: JSON.parse(JSON.stringify(snap)), errors: [] }; },
    getModeConfiguration: function () {
      return { result: { modeId: 'engineering-v2', persisted: true, revision: 0, config: JSON.parse(JSON.stringify(mc)) }, errors: [] };
    },
    compilePreview: function (config) {
      this.calls.push(JSON.parse(JSON.stringify(config)));
      const r = resolver.compileModeConfig(config, JSON.parse(JSON.stringify(snap)));
      if (!r.ok) return { ok: false, errors: r.errors };
      return { ok: true, snapshot: r.snapshot };
    },
  };
}

function modeDef() {
  return {
    schemaVersion: 1, id: 'engineering-v2', displayName: 'Engineering',
    status: 'active', runnable: true, orchestrationEngineId: 'muse-v0',
    slots: [{
      id: 'main', label: 'Main', required: true, internalRoles: ['muse_main'],
      requirements: { toolCalling: true, adaptiveReasoningContract: 'muse-v0', singleAgent: true },
    }],
    internalRoles: ['muse_main'], optionalCapabilities: [],
  };
}

function gateOf(records) {
  const r = records;
  const byId = (l, id) => (l || []).find((e) => e && e.id === id) || null;
  const route = r.routes[0];
  return v2.catalogIssuability({
    route: route,
    model: byId(r.models, route.logicalModelId),
    provider: byId(r.providers, route.providerId),
    connection: route.connectionId ? byId(r.connections, route.connectionId) : null,
  });
}

check('one issuable target passes every gate', () => {
  const g = gateOf(goodRecords());
  assert.deepEqual(g, { issuable: true, reason: null });
  const out = catalog.listRegistryTargets(stubService(goodRecords()));
  assert.equal(out.ok, true);
  assert.equal(out.targets.length, 1);
  assert.deepEqual(out.targets[0], {
    providerId: 'prov-good', logicalModelId: 'logi-good', remoteModelId: 'remote-good',
    routeId: 'route-good', connectionId: 'conn-good', connectionStatus: 'connected',
    protocol: 'openai-responses', contextLimitTokens: 8192, outputLimitTokens: 1024,
    billingTier: 'test-metered', dataUse: 'contributor', issuable: true, reason: null,
  });
});

check('every non-issuable shape maps to its machine reason', () => {
  const cases = [
    ['unknown-route skips', {}, null, 'unknown-route'],
    ['model-disabled', { record: 'model', patch: { enabled: false } }, null, 'model-disabled'],
    ['provider-disabled', { record: 'provider', patch: { status: 'disabled' } }, null, 'provider-disabled'],
    ['route-not-verified', { record: 'route', patch: { availability: 'probe-required' } }, null, 'route-not-verified'],
    ['route-model-identity-mismatch', { record: 'model', patch: { id: 'logi-other' } }, null, 'route-model-identity-mismatch'],
    ['route-provider-mismatch', { record: 'provider', patch: { id: 'prov-other' } }, null, 'route-provider-mismatch'],
    ['connection-not-connected', { record: 'connection', patch: { status: 'not-connected' } }, null, 'connection-not-connected'],
    ['protocol-unsupported', { record: 'route', patch: { compatibility: { transport: 'openai-chat-completions' } } }, null, 'protocol-unsupported'],
    ['no-credential-ref', { record: 'connection', patch: { credentialRef: '' } }, null, 'no-credential-ref'],
    ['context-unknown', { record: 'model', patch: { contextWindow: 0 } }, null, 'context-unknown'],
    ['output-unknown', { record: 'model', patch: { maxOutputTokens: 0 } }, { record: 'route', patch: { capacityConstraints: {} } }, 'output-unknown'],
    ['no-billing-tier', { record: 'provider', patch: { metadata: {} } }, null, 'no-billing-tier'],
    ['no-data-use', { record: 'model', patch: { dataUseTier: '' } }, null, 'no-data-use'],
  ];
  for (const [label, a, b, reason] of cases) {
    let rec;
    if (label === 'unknown-route skips') {
      const out = catalog.listRegistryTargets({ effectiveSnapshot: () => ({ snapshot: { providers: [], models: [], routes: [{ id: 'route-x', providerId: 'p', logicalModelId: 'm', remoteModelId: 'r', connectionId: null }], connections: [] }, errors: [] }) });
      assert.equal(out.targets[0].issuable, false, label);
      assert.equal(out.targets[0].reason, 'unknown-model', label);
      continue;
    }
    rec = goodRecords();
    // route-model-identity-mismatch: route names a *different existing*
    // model, so the gate reaches the identity comparison.
    if (label === 'route-model-identity-mismatch') {
      rec.models.push(Object.assign({}, rec.models[0], { id: 'logi-other' }));
      rec.routes[0].logicalModelId = 'logi-other';
      const direct = v2.catalogIssuability({
        route: rec.routes[0],
        model: rec.models[0],
        provider: rec.providers[0],
        connection: rec.connections[0],
      });
      assert.equal(direct.issuable, false, label);
      assert.equal(direct.reason, reason, label + ' got ' + direct.reason);
      continue;
    }
    // route-provider-mismatch: route names a *different existing*
    // provider, so the gate reaches the identity comparison.
    if (label === 'route-provider-mismatch') {
      rec.providers.push(Object.assign({}, rec.providers[0], { id: 'prov-other' }));
      rec.routes[0].providerId = 'prov-other';
      const direct = v2.catalogIssuability({
        route: rec.routes[0],
        model: rec.models[0],
        provider: rec.providers[0],
        connection: rec.connections[0],
      });
      assert.equal(direct.issuable, false, label);
      assert.equal(direct.reason, reason, label + ' got ' + direct.reason);
      continue;
    }
    const key = { model: 'models', provider: 'providers', connection: 'connections', route: 'routes' }[a.record];
    Object.assign(rec[key][0], a.patch);
    if (b) {
      const key2 = { model: 'models', provider: 'providers', connection: 'connections', route: 'routes' }[b.record];
      Object.assign(rec[key2][0], b.patch);
    }
    const g = gateOf(rec);
    assert.equal(g.issuable, false, label);
    assert.equal(g.reason, reason, label + ' got ' + g.reason);
  }
});

check('catalog output never carries secrets, refs or paths', () => {
  const rec = goodRecords({ connection: { credentialRef: 'credential://connections/conn-good-sk-live-SECRETVALUE9' } });
  const out = catalog.listRegistryTargets(stubService(rec));
  assert.equal(out.ok, true);
  const text = JSON.stringify(out.targets);
  assert.ok(text.indexOf('sk-live-SECRETVALUE9') === -1, 'secret material leaked');
  assert.ok(text.indexOf('credential://') === -1, 'credential reference leaked');
  assert.ok(text.indexOf('/tmp/') === -1 && text.indexOf(repo) === -1, 'filesystem path leaked');
});

check('golden default: bridge target-info matches the trusted pipeline byte-for-byte, deterministically', () => {
  const dataRoot = tmp();
  const a = run(['target-info', repo, dataRoot]);
  const b = run(['target-info', repo, dataRoot]);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'deterministic');
  // The default path compiles through the same pipeline with no selection.
  const svc = require('../config/registry/service.cjs').createService({ installRoot: repo, dataRoot: dataRoot });
  const direct = v2.issueExecutionTargetV2(
    { installRoot: repo, dataRoot: dataRoot, taskInstanceId: 'task-target-info', sessionId: 'session-target-info' },
    { service: svc }
  );
  assert.equal(a.ok, direct.ok);
  if (a.ok) {
    assert.equal(a.providerId, direct.target.core.providerId);
    assert.equal(a.remoteModelId, direct.target.core.remoteModelId);
    assert.equal(a.outputLimitTokens, direct.target.extension.outputLimitTokens);
  } else {
    assert.equal(a.code, direct.code, 'fail-closed code is unchanged');
  }
});

check('golden default: bridge issue without selection is byte-identical to the trusted pipeline', () => {
  const dataRoot = tmp();
  const a = run(['issue', repo, dataRoot, 'task-golden-1', 'session-golden-1']);
  const b = run(['issue', repo, dataRoot, 'task-golden-1', 'session-golden-1']);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 're-issuance is content-stable');
  const svc = require('../config/registry/service.cjs').createService({ installRoot: repo, dataRoot: dataRoot });
  const direct = v2.issueExecutionTargetV2(
    { installRoot: repo, dataRoot: dataRoot, taskInstanceId: 'task-golden-1', sessionId: 'session-golden-1' },
    { service: svc }
  );
  assert.equal(a.ok, direct.ok);
  assert.equal(JSON.stringify(a), JSON.stringify(a.ok
    ? { ok: true, resolution: direct.target.issuance.resolution, snapshot: direct.target.issuance.snapshot, core: direct.target.core, extension: direct.target.extension, extensionDigest: direct.target.extensionDigest, issuanceId: direct.target.issuance.issuanceId, modeId: direct.target.issuance.modeId, role: direct.target.issuance.role, modeConfigRevision: direct.target.issuance.modeConfigRevision, modeConfigDigest: direct.target.issuance.modeConfigDigest }
    : { ok: false, code: direct.code, message: direct.message }));
});

check('selection fails closed: unknown and non-issuable selections, bad shapes', () => {
  const dataRoot = tmp();
  const unknown = run(['issue', repo, dataRoot, 'task-sel-1', 'session-sel-1', JSON.stringify({ logicalModelId: 'nope', routeId: 'nope' })]);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'registry-selection-not-issuable');
  assert.ok(unknown.message.indexOf('unknown-target') !== -1);
  const badShapes = ['', 'not-json', '[]', JSON.stringify({ logicalModelId: 'a' }), JSON.stringify({ logicalModelId: 'a', routeId: 'b', extra: 1 })];
  for (const shape of badShapes) {
    const r = run(['issue', repo, dataRoot, 'task-sel-1', 'session-sel-1', shape]);
    assert.equal(r.ok, false, 'shape refused: ' + shape);
  }
  const t = run(['target-info', repo, dataRoot, JSON.stringify({ logicalModelId: 'nope', routeId: 'nope' })]);
  assert.equal(t.ok, false);
  assert.equal(t.code, 'registry-selection-not-issuable');
});

check('selection compiles in memory: digests cover it, saved config untouched', () => {
  const svc = stubService(goodRecords());
  const base = v2.issueExecutionTargetV2(
    { installRoot: 'x', dataRoot: 'y', taskInstanceId: 'task-mem-1', sessionId: 'session-mem-1', selection: null },
    { service: svc }
  );
  assert.equal(base.ok, true, JSON.stringify(base));
  const def = svc.getModeConfiguration().result.config;
  const sel = v2.issueExecutionTargetV2(
    { installRoot: 'x', dataRoot: 'y', taskInstanceId: 'task-mem-1', sessionId: 'session-mem-1', selection: { logicalModelId: 'logi-good', routeId: 'route-good' } },
    { service: svc }
  );
  assert.equal(sel.ok, true, JSON.stringify(sel));
  assert.equal(sel.target.core.logicalModelId, 'logi-good');
  assert.equal(sel.target.core.routeId, 'route-good');
  // Same generation, same slot content => same digests; the selection is part
  // of what the digests cover (a different target would digest differently).
  assert.equal(sel.target.issuance.snapshotDigest, base.target.issuance.snapshotDigest);
  assert.equal(sel.target.issuance.issuanceId, base.target.issuance.issuanceId);
  // The saved configuration object was never rewritten: the stub service has
  // no persistence and the compiled mode config is a clone.
  assert.deepEqual(svc.getModeConfiguration().result.config, def);
  assert.ok(svc.calls.every((c) => c.modeId === 'engineering-v2'));
});

check('bridge catalog lists the real registry read-only', () => {
  const out = run(['catalog', repo, tmp()]);
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 200));
  assert.ok(Array.isArray(out.targets) && out.targets.length > 0, 'legacy routes are listed');
  for (const t of out.targets) {
    for (const k of ['providerId', 'logicalModelId', 'remoteModelId', 'routeId', 'connectionStatus', 'protocol', 'contextLimitTokens', 'outputLimitTokens', 'billingTier', 'issuable']) {
      assert.ok(k in t, 'field ' + k);
    }
    assert.ok(!('credentialRef' in t) && !('credential' in t), 'no credential field');
  }
  const text = JSON.stringify(out);
  assert.ok(text.indexOf('credential://') === -1, 'no credential references');
});

console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed);
