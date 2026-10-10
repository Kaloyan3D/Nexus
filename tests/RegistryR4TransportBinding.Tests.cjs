'use strict';

// Registry R4.2 — Final Probe Trust Boundary (adversarial suite).
// A: DNS-to-connection binding proven with a real local HTTP server and
// mocked DNS (not mocked fetch alone). B: capability completeness — no
// test-only shortcut may promote, reasoning verified per level with
// restricted eligibility. Each check FAILS on the R4.1 build and PASSES
// after the correction. Offline; isolated tmp roots; loopback servers only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const registry = require('../config/registry/index.cjs');
const serviceModule = registry.service;
const probes = registry.probes;

delete process.env.DSH_HOME;
delete process.env.AIH_INSTALL_ROOT;
delete process.env.DSH_AIH_PROFILE;
delete process.env.AIH_ACTIVE_PROFILE;

let passed = 0;
let failed = 0;
const failures = [];
function check(label, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log('PASS: ' + label); })
        .catch((e) => { failed++; failures.push(label + ' :: ' + (e && e.message)); console.log('FAIL: ' + label + ' :: ' + (e && e.message)); });
    }
    passed++;
    console.log('PASS: ' + label);
  } catch (e) {
    failed++;
    failures.push(label + ' :: ' + (e && e.message));
    console.log('FAIL: ' + label + ' :: ' + (e && e.message));
  }
  return undefined;
}

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function svcOn(dataRoot) { return serviceModule.createService({ installRoot: repoRoot, dataRoot }); }
function codes(errors) { return (errors || []).map((e) => (e && e.code) || ''); }
function delay(ms) { return new Promise((res) => setTimeout(res, ms)); }
function localhostRoute() { return [{ address: '127.0.0.1', family: 4 }]; }
function publicRoute() { return [{ address: '93.184.216.34', family: 4 }]; }
const TRUST_LOCAL = { trustedPrivateNetwork: true };

// Controlled local HTTP server. Tracks requests, sockets and Host headers.
async function startServer(handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, host: req.headers.host });
    handler(req, res);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port, requests,
    connections: () => new Promise((resolve, reject) => server.getConnections((e, n) => (e ? reject(e) : resolve(n)))),
    close: async () => {
      for (const s of sockets) { try { s.destroy(); } catch (x) { void x; } }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
function modelsBody(ids) { return JSON.stringify({ data: (ids || ['local-model-1']).map((id) => ({ id })) }); }

function localProvider(port) {
  return { id: 'pin-direct', name: 'Pinned Local', transportId: 'openai-responses', baseUrl: 'http://probe-test.invalid:' + port + '/v1', authType: 'api-key' };
}
function localModel(levels) {
  return {
    id: 'pin/local-1', vendor: 'Local', displayName: 'Local 1', checkpoint: 'local-1',
    capabilities: { textInput: true, imageInput: false, toolCalling: true, streaming: false, reasoning: true },
    dataUseTier: 'standard', enabled: true, engines: ['dual-v1'],
  };
}
function toolEmissionBody() {
  return JSON.stringify({ status: 'completed', output: [{ type: 'function_call', name: 'probe_echo', call_id: 'call_pin_1', arguments: '{"word":"probe-ok"}' }] });
}
function continuationBody() {
  return JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok acknowledged' }] }] });
}
function textBody(effort, echo) {
  return JSON.stringify({ status: 'completed', reasoning: echo ? { effort } : undefined, output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok' }] }] });
}
function localConnection() {
  return { id: 'conn-pin-1', providerId: 'pin-direct', connectionKind: 'local-server', authMethod: 'none', status: 'not-connected' };
}
function pinRoute(levels) {
  return {
    id: 'pin-direct/local-1', providerId: 'pin-direct', logicalModelId: 'pin/local-1',
    remoteModelId: 'local-model-1', connectionId: 'conn-pin-1', reasoningLevels: levels || ['low', 'high'],
    availability: 'probe-required',
  };
}

async function main() {
  // ── A: DNS-to-connection binding ────────────────────────────────────────
  await check('A1 pinned connection reaches the validated IP for an unresolvable hostname', async () => {
    const srv = await startServer((req, res) => {
      if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(modelsBody()); return; }
      res.writeHead(404, {}); res.end('{}');
    });
    try {
      const svc = svcOn(tmpDir('r42-a1-'));
      assert.equal(svc.saveProvider(localProvider(srv.port), {}).ok, true);
      const out = await svc.testProviderConnection('pin-direct', { lookup: async () => localhostRoute(), endpointOptions: TRUST_LOCAL });
      assert.equal(out.ok, true, 'pinned request must reach the server, got ' + JSON.stringify(out.errors));
      assert.equal(srv.requests.length, 1, 'server saw exactly one request');
      assert.ok(srv.requests[0].host.indexOf('probe-test.invalid') === 0, 'original hostname preserved in Host, got ' + srv.requests[0].host);
    } finally { await srv.close(); }
  });

  await check('A2 validated addresses are pinned: no re-resolution at connection time', async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(modelsBody());
    });
    try {
      const svc = svcOn(tmpDir('r42-a2-'));
      assert.equal(svc.saveProvider(localProvider(srv.port), {}).ok, true);
      let lookups = 0;
      const rebinding = async () => {
        lookups += 1;
        if (lookups > 1) return [{ address: '127.0.0.2', family: 4 }];
        return localhostRoute();
      };
      const out = await svc.testProviderConnection('pin-direct', { lookup: rebinding, endpointOptions: TRUST_LOCAL });
      assert.equal(out.ok, true, JSON.stringify(out.errors));
      assert.equal(lookups, 1, 'exactly one resolution per request, saw ' + lookups);
      assert.equal(srv.requests.length, 1, 'connection used the validated address');
    } finally { await srv.close(); }
  });

  await check('A3 mixed restricted/public DNS results are refused with nothing leaving', async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(modelsBody());
    });
    try {
      const svc = svcOn(tmpDir('r42-a3-'));
      assert.equal(svc.saveProvider(localProvider(srv.port), {}).ok, true);
      const out = await svc.testProviderConnection('pin-direct', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.9.9.9', family: 4 }],
      });
      assert.equal(out.ok, false);
      assert.ok(codes(out.errors).indexOf('endpoint-forbidden-ssrf') !== -1, JSON.stringify(out.errors));
      assert.equal(srv.requests.length, 0, 'no request may leave on mixed results');
    } finally { await srv.close(); }
  });

  await check('A4 TLS keeps hostname verification and SNI against the validated IP', async () => {
    let pinned = null;
    try {
      pinned = require('../config/registry/pinned-transport.cjs');
    } catch (e) { void e; }
    assert.ok(pinned && typeof pinned.buildRequestOptions === 'function', 'pinned transport exposes request options');
    const target = pinned.buildRequestOptions('https://api.acme.example:8443/v1/models', [{ address: '93.184.216.34', family: 4 }], { method: 'GET', headers: {} });
    assert.equal(target.host, '93.184.216.34', 'socket connects to the validated address');
    assert.equal(target.servername, 'api.acme.example', 'SNI carries the original hostname');
    assert.equal(target.port, 8443);
    assert.ok(target.headers.host.indexOf('api.acme.example') === 0, 'Host header carries the original hostname');
    assert.equal(target.rejectUnauthorized, true, 'TLS verification stays enabled');
    assert.equal(typeof target.checkServerIdentity, 'undefined', 'default hostname verification is not overridden');
  });

  await check('A5 DNS resolution is inside the bounded request deadline', async () => {
    const svc = svcOn(tmpDir('r42-a5-'));
    assert.equal(svc.saveProvider(localProvider(9), {}).ok, true);
    const stallingLookup = () => new Promise(() => {});
    const raced = await Promise.race([
      svc.testProviderConnection('pin-direct', { lookup: stallingLookup, endpointOptions: TRUST_LOCAL, timeoutMs: 80 }).then((r) => ({ settled: true, r })),
      delay(3000).then(() => ({ settled: false })),
    ]);
    assert.equal(raced.settled, true, 'a stalling resolver must not escape the deadline');
    assert.ok(codes(raced.r.errors).indexOf('probe-timeout') !== -1, JSON.stringify(raced.r.errors));
  });

  await check('A6 uncooperative connections are destroyed under a bounded resource policy', async () => {
    const srv = await startServer(() => {});
    try {
      const provider = { id: 'stall', transportId: 'openai-responses', baseUrl: 'http://127.0.0.1:' + srv.port + '/v1' };
      const connection = { id: 'c', connectionKind: 'local-server', status: 'not-connected' };
      const out = await probes.testConnection(provider, connection, null, { lookup: async () => localhostRoute(), endpointOptions: TRUST_LOCAL, timeoutMs: 80 });
      assert.equal(out.ok, false);
      assert.ok(codes(out.errors).indexOf('probe-timeout') !== -1, JSON.stringify(out.errors));
      let remaining = 99;
      for (let i = 0; i < 80 && remaining !== 0; i += 1) {
        remaining = await srv.connections();
        if (remaining !== 0) await delay(25);
      }
      assert.equal(remaining, 0, 'no lingering server-side connection, saw ' + remaining);
    } finally { await srv.close(); }
  });

  // ── B: capability completeness ──────────────────────────────────────────
  await check('B1 test-only streaming skips cannot promote a route', async () => {
    const svc = svcOn(tmpDir('r42-b1-'));
    assert.equal(svc.saveProvider(localProvider(9), {}).ok, true);
    const streamingModel = Object.assign({}, localModel(), { capabilities: { textInput: true, imageInput: false, toolCalling: true, streaming: true, reasoning: true } });
    assert.equal(svc.saveModel(streamingModel, {}).ok, true);
    assert.equal(svc.saveConnection(localConnection(), {}).ok, true);
    assert.equal(svc.setConnectionStatus('conn-pin-1', 'connected', { attested: true }).ok, true);
    assert.equal(svc.saveRoute(pinRoute(['low']), {}).ok, true);
    const fetch = async (url, init) => {
      const body = JSON.parse(String((init && init.body) || '{}'));
      if ((init && init.method) === 'GET') return { status: 200, text: async () => modelsBody(['local-model-1']) };
      if (body.stream === true) return { status: 200, text: async () => JSON.stringify({ streamed: true }) };
      if (body.tools) return { status: 200, text: async () => toolEmissionBody() };
      if (Array.isArray(body.input) && body.input.some((e) => e && e.type === 'function_call_output')) return { status: 200, text: async () => continuationBody() };
      return { status: 200, text: async () => textBody('low', true) };
    };
    const out = await svc.verifyProviderRoute('pin-direct/local-1', { fetchImpl: fetch, lookup: async () => publicRoute(), testBearer: 'probe-bearer-pin-1', skipStreaming: true });
    assert.equal(out.ok, false, 'a streaming-capable model with a broken stream must not verify, flag or not');
  });

  await check('B2 reasoning levels verify individually with restricted eligibility', async () => {
    const svc = svcOn(tmpDir('r42-b2-'));
    assert.equal(svc.saveProvider(localProvider(9), {}).ok, true);
    assert.equal(svc.saveModel(localModel(), {}).ok, true);
    assert.equal(svc.saveConnection(localConnection(), {}).ok, true);
    assert.equal(svc.setConnectionStatus('conn-pin-1', 'connected', { attested: true }).ok, true);
    assert.equal(svc.saveRoute(pinRoute(['low', 'high']), {}).ok, true);
    const fetch = async (url, init) => {
      if ((init && init.method) === 'GET') return { status: 200, text: async () => modelsBody(['local-model-1']) };
      const body = JSON.parse(String((init && init.body) || '{}'));
      const effort = body.reasoning && body.reasoning.effort;
      const echo = effort === 'low' ? { effort } : undefined;
      if (body.tools) return { status: 200, text: async () => toolEmissionBody() };
      if (Array.isArray(body.input) && body.input.some((e) => e && e.type === 'function_call_output')) return { status: 200, text: async () => continuationBody() };
      return { status: 200, text: async () => JSON.stringify({ status: 'completed', reasoning: echo, output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok' }] }] }) };
    };
    const prove = { fetchImpl: fetch, lookup: async () => publicRoute(), testBearer: 'probe-bearer-pin-1' };
    const out = await svc.verifyProviderRoute('pin-direct/local-1', prove);
    assert.equal(out.ok, true, 'partial grant verifies with restriction, got ' + JSON.stringify(out.errors));
    assert.deepEqual(out.evidence.levelsVerified, ['low']);
    const route = svc.getCatalog().catalog.routes.find((r) => r.routeId === 'pin-direct/local-1');
    assert.deepEqual(route.reasoningLevels, ['low'], 'effective levels narrow to the checked set, got ' + JSON.stringify(route.reasoningLevels));
    const stagedHigh = {
      schemaVersion: 1, modeId: 'engineering-v1', revision: 0,
      slots: {
        engineer: { logicalModelId: 'pin/local-1', routeId: 'pin-direct/local-1', reasoning: 'high' },
        reviewer: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'medium' },
        solver: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'high' },
      },
    };
    assert.ok(codes(svc.validate(stagedHigh).errors).indexOf('reasoning-level-not-supported') !== -1, 'unchecked level stays ineligible');
    const stagedLow = JSON.parse(JSON.stringify(stagedHigh));
    stagedLow.slots.engineer.reasoning = 'low';
    assert.equal(svc.save('engineering-v1', stagedLow, null, {}).ok, true, 'checked level stages');
  });

  await check('B3 legacy contract evidence no longer grants eligibility', async () => {
    const catalog = registry.operatorCatalog;
    const svc = svcOn(tmpDir('r42-b3-'));
    assert.equal(svc.saveProvider(localProvider(9), {}).ok, true);
    assert.equal(svc.saveModel(localModel(), {}).ok, true);
    assert.equal(svc.saveConnection(localConnection(), {}).ok, true);
    assert.equal(svc.setConnectionStatus('conn-pin-1', 'connected', { attested: true }).ok, true);
    assert.equal(svc.saveRoute(pinRoute(['low']), {}).ok, true);
    const eff = svc.effectiveSnapshot();
    const canon = svc.buildCanonical().snapshot;
    const ids = { providers: canon.providers.map((p) => p.id), models: canon.models.map((m) => m.id), routes: canon.routes.map((r) => r.id), connections: canon.connections.map((c) => c.id) };
    const snap = eff.snapshot;
    const digest = probes.fingerprintOf(probes.fingerprintInputOf({
      provider: snap.providers.find((p) => p.id === 'pin-direct'),
      model: snap.models.find((m) => m.id === 'pin/local-1'),
      route: snap.routes.find((r) => r.id === 'pin-direct/local-1'),
      connection: snap.connections.find((c) => c.id === 'conn-pin-1'),
    }));
    const legacyEvidence = { kind: 'capability-verification', contractVersion: 2, routeId: 'pin-direct/local-1', fingerprint: digest, checks: [] };
    const dataRoot = svc.dataRoot;
    const stored = catalog.saveEvidence(dataRoot, 'pin-direct/local-1', legacyEvidence, {});
    assert.equal(stored.ok, true);
    const route = JSON.parse(JSON.stringify(eff.snapshot.routes.find((r) => r.id === 'pin-direct/local-1')));
    route.availability = 'verified';
    const saved = catalog.saveRecord(dataRoot, 'routes', route, { builtInIds: ids, fsHooks: undefined });
    assert.equal(saved.ok, true, JSON.stringify(saved.errors));
    const elig = svc.listEligible('engineering-v1', 'engineer').routes.map((r) => r.routeId);
    assert.ok(elig.indexOf('pin-direct/local-1') === -1, 'stale-contract evidence grants nothing');
  });

  await check('B4 evidence reflects the exact successfully checked set', async () => {
    const a = probes.fingerprintOf(probes.fingerprintInputOf({ verifiedLevels: ['low'] }));
    const b = probes.fingerprintOf(probes.fingerprintInputOf({ verifiedLevels: ['low', 'high'] }));
    assert.ok(a && b && a !== b, 'verified levels participate in the binding digest');
    const svc = svcOn(tmpDir('r42-b4-'));
    assert.equal(svc.saveProvider(localProvider(9), {}).ok, true);
    assert.equal(svc.saveModel(localModel(), {}).ok, true);
    assert.equal(svc.saveConnection(localConnection(), {}).ok, true);
    assert.equal(svc.setConnectionStatus('conn-pin-1', 'connected', { attested: true }).ok, true);
    assert.equal(svc.saveRoute(pinRoute(['low', 'high']), {}).ok, true);
    const fetch = async (url, init) => {
      if ((init && init.method) === 'GET') return { status: 200, text: async () => modelsBody(['local-model-1']) };
      const body = JSON.parse(String((init && init.body) || '{}'));
      const effort = body.reasoning && body.reasoning.effort;
      const echo = effort === 'low' ? { effort } : undefined;
      if (body.tools) return { status: 200, text: async () => toolEmissionBody() };
      if (Array.isArray(body.input) && body.input.some((e) => e && e.type === 'function_call_output')) return { status: 200, text: async () => continuationBody() };
      return { status: 200, text: async () => JSON.stringify({ status: 'completed', reasoning: echo, output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok' }] }] }) };
    };
    const out = await svc.verifyProviderRoute('pin-direct/local-1', { fetchImpl: fetch, lookup: async () => publicRoute(), testBearer: 'probe-bearer-pin-1' });
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    const stored = svc.getRouteEvidence('pin-direct/local-1');
    assert.deepEqual(stored.evidence.levelsChecked, [{ level: 'low', ok: true }, { level: 'high', ok: false }]);
    assert.deepEqual(stored.evidence.levelsVerified, ['low']);
  });

  await check('B5 fully checked levels keep full eligibility', async () => {
    const svc = svcOn(tmpDir('r42-b5-'));
    assert.equal(svc.saveProvider(localProvider(9), {}).ok, true);
    assert.equal(svc.saveModel(localModel(), {}).ok, true);
    assert.equal(svc.saveConnection(localConnection(), {}).ok, true);
    assert.equal(svc.setConnectionStatus('conn-pin-1', 'connected', { attested: true }).ok, true);
    assert.equal(svc.saveRoute(pinRoute(['low', 'high']), {}).ok, true);
    const fetch = async (url, init) => {
      if ((init && init.method) === 'GET') return { status: 200, text: async () => modelsBody(['local-model-1']) };
      const body = JSON.parse(String((init && init.body) || '{}'));
      const effort = body.reasoning && body.reasoning.effort;
      if (body.tools) return { status: 200, text: async () => toolEmissionBody() };
      if (Array.isArray(body.input) && body.input.some((e) => e && e.type === 'function_call_output')) return { status: 200, text: async () => continuationBody() };
      return { status: 200, text: async () => JSON.stringify({ status: 'completed', reasoning: effort ? { effort } : undefined, output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok' }] }] }) };
    };
    const out = await svc.verifyProviderRoute('pin-direct/local-1', { fetchImpl: fetch, lookup: async () => publicRoute(), testBearer: 'probe-bearer-pin-1' });
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    assert.deepEqual(out.evidence.levelsVerified, ['low', 'high']);
    const route = svc.getCatalog().catalog.routes.find((r) => r.routeId === 'pin-direct/local-1');
    assert.deepEqual(route.reasoningLevels.slice().sort(), ['high', 'low']);
    const elig = svc.listEligible('engineering-v1', 'engineer').routes.map((r) => r.routeId);
    assert.ok(elig.indexOf('pin-direct/local-1') !== -1, 'fully checked route is eligible');
  });

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failed + ' | total ' + (passed + failed));
  if (failed > 0) {
    console.log('FAILURES:\n' + failures.join('\n'));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('SUITE CRASH: ' + (e && e.stack || e)); process.exitCode = 1; });
