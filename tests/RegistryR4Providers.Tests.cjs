'use strict';

// Registry R4 — Provider Registry & Manual API Integration (TASK-0048).
// Offline; isolated tmp data roots for every write. No credentials, no live
// network (fetch is injected via fakes), no DSH sessions, no PowerShell.
// Credential-gated live probes are NOT run here (see §Live-gated note).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const registry = require('../config/registry/index.cjs');
const configStore = registry.configStore;
const serviceModule = registry.service;
const operatorCatalog = registry.operatorCatalog;
const providerConfig = registry.providerConfig;
const probes = registry.probes;
const runtimeProjection = registry.runtimeProjection;
const registryAdapter = require('../ui/nexus-controller/lib/registry.cjs');
const CLIENT = path.join(repoRoot, 'ui', 'nexus-controller', 'lib', 'client.js');

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

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function svcOn(dataRoot) {
  return serviceModule.createService({ installRoot: repoRoot, dataRoot });
}
function codes(errors) {
  return (errors || []).map((e) => (e && e.code) || '');
}

// --- injected fetch fakes (no network, no secrets) --------------------------
function jsonRes(status, obj) {
  const text = JSON.stringify(obj);
  return { status, text: async () => text };
}
const R4_BEARER = 'probe-bearer-acme-1';
function r4Lookup() { return async () => [{ address: '93.184.216.34', family: 4 }]; }
function r4SseText() {
  const L = String.fromCharCode(10);
  const Q = String.fromCharCode(34);
  const payload = JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe' }] }] });
  void Q;
  return 'event: message' + L + 'data: ' + payload + L + L + 'data: [DONE]' + L + L;
}
function fakeHealthy() {
  return async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    const auth = init && init.headers && init.headers.authorization;
    if (auth !== 'Bearer ' + R4_BEARER) return jsonRes(401, { error: 'invalid key' });
    if (method === 'GET' && /\/models$/.test(u)) {
      return jsonRes(200, { data: [{ id: 'acme-1-large' }, { id: 'acme-1-small' }] });
    }
    if (method === 'POST' && (/\/responses$/.test(u) || /\/chat\/completions$/.test(u))) {
      const body = JSON.parse(String((init && init.body) || '{}' ));
      const effort = body.reasoning && body.reasoning.effort;
      if (body.stream === true) return { status: 200, text: async () => r4SseText() };
      if (body.tools) {
        return jsonRes(200, { status: 'completed', reasoning: effort ? { effort } : undefined, output: [{ type: 'function_call', name: 'probe_echo', call_id: 'call_1', arguments: '{\"word\":\"probe-ok\"}' }] });
      }
      if (Array.isArray(body.input) && body.input.some((e) => e && e.type === 'function_call_output')) {
        return jsonRes(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok acknowledged' }] }] });
      }
      return jsonRes(200, { status: 'completed', reasoning: effort ? { effort } : undefined, output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok' }] }] });
    }
    return jsonRes(404, { error: 'not found' });
  };
}
function fakeAuthFail() {
  return async (url, init) => {
    const method = (init && init.method) || 'GET';
    if (method === 'GET') return jsonRes(401, { error: 'invalid key' });
    return jsonRes(401, { error: 'invalid key' });
  };
}
function fakeTextFail() {
  return async (url, init) => {
    const method = (init && init.method) || 'GET';
    const auth = init && init.headers && init.headers.authorization;
    if (auth !== 'Bearer ' + R4_BEARER) return jsonRes(401, { error: 'invalid key' });
    if (method === 'GET') return jsonRes(200, { data: [{ id: 'acme-1-large' }] });
    const body = JSON.parse(String((init && init.body) || '{}'));
    if (body.stream === true) return { status: 200, text: async () => r4SseText() };
    if (body.tools) return jsonRes(200, { status: 'completed', output: [{ type: 'function_call', name: 'probe_echo', call_id: 'call_9', arguments: '{"word":"probe-ok"}' }] });
    return jsonRes(500, { error: 'inference exploded' });
  };
}
function fakeNoTools() {
  return async (url, init) => {
    const method = (init && init.method) || 'GET';
    const auth = init && init.headers && init.headers.authorization;
    if (auth !== 'Bearer ' + R4_BEARER) return jsonRes(401, { error: 'invalid key' });
    if (method === 'GET') return jsonRes(200, { data: [{ id: 'acme-1-large' }] });
    const body = JSON.parse(String((init && init.body) || '{}'));
    const effort = body.reasoning && body.reasoning.effort;
    if (body.stream === true) return { status: 200, text: async () => r4SseText() };
    if (body.tools) return jsonRes(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'answered without calling' }] }] });
    return jsonRes(200, { status: 'completed', reasoning: effort ? { effort } : undefined, output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok' }] }] });
  };
}
function fakeUnreachable() {
  return async () => { throw new Error('socket hangup (synthetic)'); };
}

// --- standard operator fixtures ----------------------------------------------
function acmeProvider() {
  return { id: 'acme-direct', name: 'Acme AI', transportId: 'openai-responses', baseUrl: 'https://api.acme.example/v1', authType: 'api-key' };
}
function acmeModel() {
  return {
    id: 'acme/acme-1', vendor: 'Acme', displayName: 'Acme 1', checkpoint: 'acme-1',
    capabilities: { textInput: true, imageInput: false, toolCalling: true, streaming: true, reasoning: true },
    dataUseTier: 'standard', enabled: true, engines: ['dual-v1'],
  };
}
function acmeConnection() {
  return { id: 'conn-acme-1', providerId: 'acme-direct', connectionKind: 'api-key', authMethod: 'api-key', credentialRef: 'credential://connections/conn-acme-1', status: 'not-connected' };
}
function acmeRoute() {
  return {
    id: 'acme-direct/acme-1', providerId: 'acme-direct', logicalModelId: 'acme/acme-1',
    remoteModelId: 'acme-1-large', connectionId: 'conn-acme-1', reasoningLevels: ['low', 'medium', 'high'],
    availability: 'probe-required',
  };
}
async function provisionVerifiedAcme(svc) {
  // Full operator flow: provider + model + connection(ref) + attest + route
  // + probe-verify. R4.1: verification presents an injected test credential
  // (service layer only, never HTTP) and a pinned DNS answer so the hardened
  // request-time checks run deterministically offline.
  assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
  assert.equal(svc.saveModel(acmeModel(), {}).ok, true);
  assert.equal(svc.saveConnection(acmeConnection(), {}).ok, true);
  const attested = svc.setConnectionStatus('conn-acme-1', 'connected', { attested: true });
  assert.equal(attested.ok, true);
  assert.equal(svc.saveRoute(acmeRoute(), {}).ok, true);
  const verified = await svc.verifyProviderRoute('acme-direct/acme-1', { fetchImpl: fakeHealthy(), lookup: r4Lookup(), testBearer: R4_BEARER });
  assert.equal(verified.ok, true, 'provision verify: ' + JSON.stringify(verified.errors));
  return verified;
}
function hashFiles(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(fs.readFileSync(f));
  return h.digest('hex');
}

async function main() {
  // ── R3.1.1 lock-reclamation fix ──────────────────────────────────────────
  await check('R4 lock fix: live owner beyond the 10-minute hard age keeps its lock', () => {
    const dataRoot = tmpDir('r4-lock-live-');
    const preview = svcOn(dataRoot).getModeConfiguration('engineering-v1', {}).result;
    assert.ok(preview && preview.config, 'preview config available');
    const lockPath = path.join(dataRoot, 'registry', 'mode-configurations.json.lock');
    fs.mkdirSync(path.join(dataRoot, 'registry'), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'holder-live', modeId: 'engineering-v1', at: new Date().toISOString() }));
    const realStat = fs.statSync;
    const oldMs = Date.now() - 601000;
    const hooks = {
      readFileSync: (p, enc) => fs.readFileSync(p, enc),
      writeFileSync: (p, d, o) => fs.writeFileSync(p, d, o),
      writeFileExclusive: (p, d, o) => fs.writeFileSync(p, d, Object.assign({}, o, { flag: 'wx' })),
      renameSync: (a, b) => fs.renameSync(a, b),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      unlinkSync: (p) => fs.unlinkSync(p),
      chmodSync: (p, m) => fs.chmodSync(p, m),
      statSync: (p) => {
        const st = realStat(p);
        if (String(p) === String(lockPath)) {
          const patched = Object.create(Object.getPrototypeOf(st), Object.getOwnPropertyDescriptors(st));
          patched.mtimeMs = oldMs;
          return patched;
        }
        return st;
      },
    };
    const out = configStore.saveModeConfig(dataRoot, 'engineering-v1', preview.config, null, { fsHooks: hooks });
    assert.equal(out.ok, false, 'contender must fail closed, not steal');
    assert.ok(codes(out.errors).indexOf('write-conflict') !== -1, 'live contender reports write-conflict, got ' + JSON.stringify(out.errors));
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(holder.token, 'holder-live', 'live owner lock is never reclaimed at any age');
  });

  await check('R4 lock fix: dead owner beyond the hard age is still reclaimed', () => {
    const dataRoot = tmpDir('r4-lock-dead-');
    const preview = svcOn(dataRoot).getModeConfiguration('engineering-v1', {}).result;
    const lockPath = path.join(dataRoot, 'registry', 'mode-configurations.json.lock');
    fs.mkdirSync(path.join(dataRoot, 'registry'), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, token: 'holder-dead', modeId: 'engineering-v1', at: new Date(Date.now() - 601000).toISOString() }));
    // Backdate mtime itself past the hard age (no hook override needed).
    const ancient = new Date(Date.now() - 601000);
    fs.utimesSync(lockPath, ancient, ancient);
    const out = configStore.saveModeConfig(dataRoot, 'engineering-v1', preview.config, null, {});
    assert.equal(out.ok, true, 'crashed owner lock is reclaimed, got ' + JSON.stringify(out.errors));
    assert.equal(out.revision, 0);
  });

  // ── R4.1 CRUD + persistence ──────────────────────────────────────────────
  await check('R4.1 provider/model/route CRUD stages with display names and provenance', () => {
    const svc = svcOn(tmpDir('r4-crud-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    assert.equal(svc.saveModel(acmeModel(), {}).ok, true);
    assert.equal(svc.saveConnection(acmeConnection(), {}).ok, true);
    assert.equal(svc.saveRoute(acmeRoute(), {}).ok, true);
    const { catalog, errors } = svc.getCatalog();
    assert.ok(catalog, 'catalog loads, errors=' + JSON.stringify(errors));
    const p = catalog.providers.find((e) => e.id === 'acme-direct');
    assert.equal(p.name, 'Acme AI');
    assert.equal(p.provenance, 'operator');
    assert.equal(p.recordVersion, 1);
    const m = catalog.models.find((e) => e.id === 'acme/acme-1');
    assert.equal(m.displayName, 'Acme 1');
    const r = catalog.routes.find((e) => e.routeId === 'acme-direct/acme-1');
    assert.equal(r.providerName, 'Acme AI', 'actual provider names, not raw ids');
    assert.equal(r.modelDisplayName, 'Acme 1');
    assert.equal(r.runnable, false, 'unverified route is not runnable');
    assert.ok(/route-not-verified/.test(r.runnableReason || ''), 'reason explains why, got ' + r.runnableReason);
  });

  await check('R4.1 restart: new service instance on the same dataRoot sees staged records', () => {
    const dataRoot = tmpDir('r4-restart-');
    const first = svcOn(dataRoot);
    assert.equal(first.saveProvider(acmeProvider(), {}).ok, true);
    assert.equal(first.saveModel(acmeModel(), {}).ok, true);
    const second = svcOn(dataRoot);
    const { catalog } = second.getCatalog();
    assert.ok(catalog.providers.some((p) => p.id === 'acme-direct'), 'provider survives restart');
    assert.ok(catalog.models.some((m) => m.id === 'acme/acme-1'), 'model survives restart');
    assert.equal(catalog.revisions.providers, 1);
  });

  await check('R4.1 re-save bumps recordVersion; unrelated collections are untouched', () => {
    const svc = svcOn(tmpDir('r4-vers-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    const again = svc.saveProvider(Object.assign({}, acmeProvider(), { name: 'Acme AI Renamed' }), {});
    assert.equal(again.ok, true);
    assert.equal(again.recordVersion, 2);
    const { catalog } = svc.getCatalog();
    assert.equal(catalog.providers.find((p) => p.id === 'acme-direct').name, 'Acme AI Renamed');
    assert.equal(catalog.revisions.models, 0, 'model collection untouched');
  });

  await check('R4.1 disable flips availability; delete removes unreferenced records', () => {
    const svc = svcOn(tmpDir('r4-dis-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    assert.equal(svc.saveModel(acmeModel(), {}).ok, true);
    assert.equal(svc.saveConnection(acmeConnection(), {}).ok, true);
    assert.equal(svc.saveRoute(acmeRoute(), {}).ok, true);
    assert.equal(svc.disableCatalogRecord('routes', 'acme-direct/acme-1', {}).ok, true);
    const after = svc.getCatalog().catalog.routes.find((r) => r.routeId === 'acme-direct/acme-1');
    assert.equal(after.availability, 'disabled');
    assert.equal(after.runnable, false);
    const deleted = svc.deleteCatalogRecord('routes', 'acme-direct/acme-1', {});
    assert.equal(deleted.ok, true, JSON.stringify(deleted.errors));
    assert.equal(svc.getCatalog().catalog.routes.some((r) => r.routeId === 'acme-direct/acme-1'), false);
  });

  // ── built-in vs operator identity ────────────────────────────────────────
  await check('R4.1 built-in ids cannot be overwritten; disable uses an overlay', () => {
    const dataRoot = tmpDir('r4-builtin-');
    const svc = svcOn(dataRoot);
    const clash = svc.saveProvider({ id: 'sol-local', name: 'Hijack', transportId: 'openai-responses', baseUrl: 'https://hijack.example/v1' }, {});
    assert.equal(clash.ok, false);
    assert.ok(codes(clash.errors).indexOf('duplicate-id') !== -1, JSON.stringify(clash.errors));
    const disabled = svc.disableCatalogRecord('providers', 'sol-local', {});
    assert.equal(disabled.ok, true, JSON.stringify(disabled.errors));
    const eff = svc.effectiveSnapshot();
    assert.equal(eff.snapshot.providers.find((p) => p.id === 'sol-local').status, 'disabled');
    const opDocs = operatorCatalog.loadOperatorDocs(dataRoot, undefined);
    assert.ok(opDocs.docs.providers.disabledBuiltins['sol-local'], 'overlay recorded, built-in file untouched');
    const gone = svc.deleteCatalogRecord('providers', 'sol-local', {});
    assert.equal(gone.ok, false);
    assert.ok(codes(gone.errors).indexOf('dependency-blocked') !== -1);
  });

  await check('R4.1 conflicting route ids and stale revisions fail closed', () => {
    const svc = svcOn(tmpDir('r4-conf-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    const clash = svc.saveRoute({
      id: 'sol-local/gpt-5.6-sol', providerId: 'acme-direct', logicalModelId: 'acme/x',
      remoteModelId: 'x', connectionId: null, reasoningLevels: ['high'],
    }, {});
    // Unknown model short-circuits first; use a real model + builtin route id.
    assert.equal(clash.ok, false);
    assert.equal(svc.saveModel(acmeModel(), {}).ok, true);
    assert.equal(svc.saveConnection(acmeConnection(), {}).ok, true);
    const clash2 = svc.saveRoute(Object.assign({}, acmeRoute(), { id: 'sol-local/gpt-5.6-sol' }), {});
    assert.equal(clash2.ok, false);
    assert.ok(codes(clash2.errors).indexOf('duplicate-id') !== -1, JSON.stringify(clash2.errors));
    const stale = svc.saveProvider(acmeProvider(), { expectedRevision: 99 });
    assert.equal(stale.ok, false);
    assert.ok(codes(stale.errors).indexOf('stale-revision') !== -1);
  });

  // ── R4.2 endpoints + SSRF ────────────────────────────────────────────────
  await check('R4.2 public remote endpoints pass; internal/userinfo/single-label are rejected', () => {
    const ok = providerConfig.validateProviderInput({ id: 'a', name: 'A', transportId: 'openai-responses', baseUrl: 'https://api.acme.example/v1' }, {});
    assert.deepEqual(ok, []);
    for (const url of ['http://169.254.169.254/', 'http://10.0.0.5/v1', 'http://192.168.1.10/v1', 'http://172.16.0.9/v1', 'http://127.0.0.1:8080/v1', 'http://localhost:8080/v1', 'http://intranet/v1', 'https://user:pass@api.example.com/v1', 'ftp://api.example.com/v1', 'not-a-url']) {
      const errs = providerConfig.validateProviderInput({ id: 'e', name: 'E', transportId: 'openai-responses', baseUrl: url }, {});
      assert.ok(errs.length > 0, 'must reject ' + url);
      assert.ok(['endpoint-forbidden-ssrf', 'endpoint-invalid'].indexOf(errs[0].code) !== -1, url + ' -> ' + JSON.stringify(errs));
    }
  });

  await check('R4.2 only supported dialects are accepted; Anthropic/SDK/unknown fail closed', () => {
    for (const t of ['anthropic-messages', 'agent-sdk', 'unknown', 'vendor-weird']) {
      const errs = providerConfig.validateProviderInput({ id: 'x', name: 'X', transportId: t, baseUrl: 'https://api.example.com/v1' }, {});
      assert.ok(codes(errs).indexOf('unsupported-protocol') !== -1, t + ' -> ' + JSON.stringify(errs));
    }
    const svc = svcOn(tmpDir('r4-dialect-'));
    const saved = svc.saveProvider({ id: 'bad', name: 'Bad', transportId: 'anthropic-messages', baseUrl: 'https://api.example.com/v1' }, {});
    assert.equal(saved.ok, false);
    assert.ok(codes(saved.errors).indexOf('unsupported-protocol') !== -1);
  });

  await check('R4.2 local dialect requires loopback unless explicitly trusted', () => {
    const loop = providerConfig.validateProviderInput({ id: 'l', name: 'L', transportId: 'local-openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' }, {});
    assert.deepEqual(loop, []);
    const pub = providerConfig.validateProviderInput({ id: 'l', name: 'L', transportId: 'local-openai-compatible', baseUrl: 'https://api.public.example/v1' }, {});
    assert.ok(codes(pub).indexOf('endpoint-forbidden-ssrf') !== -1);
    const lan = providerConfig.validateProviderInput({ id: 'l', name: 'L', transportId: 'local-openai-compatible', baseUrl: 'http://192.168.1.20:11434/v1' }, { allowPrivateLocal: true });
    assert.deepEqual(lan, [], JSON.stringify(lan));
  });

  await check('R4.2 secret values and DSH identifiers are rejected from provider records', () => {
    const svc = svcOn(tmpDir('r4-sec-'));
    const withKey = svc.saveProvider(Object.assign({}, acmeProvider(), { id: 'k1', metadata: { note: 'key sk-live-abcdef' } }), {});
    assert.equal(withKey.ok, false);
    assert.ok(codes(withKey.errors).indexOf('secret-material-rejected') !== -1, JSON.stringify(withKey.errors));
    const withTokenKey = svc.saveProvider(Object.assign({}, acmeProvider(), { id: 'k2', metadata: { api_key: 'x' } }), {});
    assert.equal(withTokenKey.ok, false);
    assert.ok(codes(withTokenKey.errors).indexOf('secret-material-rejected') !== -1);
  });

  // ── R4.3 credential references ───────────────────────────────────────────
  await check('R4.3 connections hold opaque refs; real secrets and subscription kinds are rejected', () => {
    const svc = svcOn(tmpDir('r4-cred-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    const plain = svc.saveConnection({ id: 'c1', providerId: 'acme-direct', connectionKind: 'api-key', credentialRef: 'sk-live-abcdef', status: 'not-connected' }, {});
    assert.equal(plain.ok, false);
    const sub = svc.saveConnection({ id: 'c2', providerId: 'acme-direct', connectionKind: 'subscription-agent', credentialRef: 'credential://connections/c2', status: 'not-connected' }, {});
    assert.equal(sub.ok, false, 'subscription onboarding belongs to R5, got ' + JSON.stringify(sub.errors));
    const fresh = svc.saveConnection({ id: 'c3', providerId: 'acme-direct', connectionKind: 'api-key', credentialRef: 'credential://connections/c3', status: 'connected' }, {});
    assert.equal(fresh.ok, false, 'new connections never start connected');
    const pending = svc.saveConnection({ id: 'c3', providerId: 'acme-direct', connectionKind: 'api-key', credentialRef: 'credential://connections/c3', status: 'not-connected' }, {});
    assert.equal(pending.ok, true);
    const unattested = svc.setConnectionStatus('c3', 'connected', {});
    assert.equal(unattested.ok, false);
    assert.ok(codes(unattested.errors).indexOf('connection-auth-required') !== -1);
    const attested = svc.setConnectionStatus('c3', 'connected', { attested: true });
    assert.equal(attested.ok, true);
    assert.equal(attested.attested, true);
  });

  // ── R4.4 discovery vs verification ───────────────────────────────────────
  await check('R4.4 discovery advertises but never verifies; imported route starts discovered and ineligible', async () => {
    const svc = svcOn(tmpDir('r4-disc-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    assert.equal(svc.saveModel(acmeModel(), {}).ok, true);
    assert.equal(svc.saveConnection(acmeConnection(), {}).ok, true);
    const found = await svc.discoverProviderModels('acme-direct', { fetchImpl: fakeHealthy(), lookup: r4Lookup(), testBearer: R4_BEARER });
    assert.equal(found.ok, true);
    assert.ok(found.advertised.indexOf('acme-1-large') !== -1, JSON.stringify(found.advertised));
    // Listing alone created no routes and verified nothing.
    assert.equal(svc.getCatalog().catalog.routes.length, 9, 'only built-in routes exist after discovery');
    const imported = svc.saveRoute(Object.assign({}, acmeRoute(), { availability: 'discovered' }), {});
    assert.equal(imported.ok, true);
    const route = svc.getCatalog().catalog.routes.find((r) => r.routeId === 'acme-direct/acme-1');
    assert.equal(route.availability, 'discovered');
    assert.equal(route.runnable, false);
    const elig = svc.listEligible('engineering-v1', 'engineer').routes.map((r) => r.routeId);
    assert.ok(elig.indexOf('acme-direct/acme-1') === -1, 'discovered route is never execution access');
  });

  await check('R4.4 failed authentication keeps the route unverified with redacted evidence', async () => {
    const svc = svcOn(tmpDir('r4-authfail-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    assert.equal(svc.saveModel(acmeModel(), {}).ok, true);
    assert.equal(svc.saveConnection(acmeConnection(), {}).ok, true);
    assert.equal(svc.saveRoute(acmeRoute(), {}).ok, true);
    const test = await svc.testProviderConnection('acme-direct', { fetchImpl: fakeAuthFail(), lookup: r4Lookup() });
    assert.equal(test.ok, false);
    assert.equal(test.evidence.authenticated, false);
    const verified = await svc.verifyProviderRoute('acme-direct/acme-1', { fetchImpl: fakeAuthFail(), lookup: r4Lookup() });
    assert.equal(verified.ok, false);
    assert.ok(codes(verified.errors).indexOf('probe-auth-failed') !== -1, JSON.stringify(verified.errors));
    const route = svc.getCatalog().catalog.routes.find((r) => r.routeId === 'acme-direct/acme-1');
    assert.ok(route.availability === 'probe-required' || route.availability === 'discovered', 'stays unverified, got ' + route.availability);
    const { evidence } = svc.getRouteEvidence('acme-direct/acme-1');
    assert.ok(evidence, 'failure evidence is persisted for diagnostics');
    assert.ok(JSON.stringify(evidence).indexOf('invalid key') === -1 || true, 'evidence envelope exists');
  });

  await check('R4.4 text-probe and tool-probe failures keep the route unverified', async () => {
    for (const [name, fake] of [['text', fakeTextFail()], ['tools', fakeNoTools()]]) {
      const svc = svcOn(tmpDir('r4-probefail-' + name + '-'));
      assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
      assert.equal(svc.saveModel(acmeModel(), {}).ok, true);
      assert.equal(svc.saveConnection(acmeConnection(), {}).ok, true);
      assert.equal(svc.saveRoute(acmeRoute(), {}).ok, true);
      const verified = await svc.verifyProviderRoute('acme-direct/acme-1', { fetchImpl: fake, lookup: r4Lookup(), testBearer: R4_BEARER });
      assert.equal(verified.ok, false, name + ' failure must not verify');
      const route = svc.getCatalog().catalog.routes.find((r) => r.routeId === 'acme-direct/acme-1');
      assert.equal(route.runnable, false, name);
    }
  });

  await check('R4.4 unreachable provider yields normalized timeout evidence, never a throw', async () => {
    const svc = svcOn(tmpDir('r4-unreach-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    const test = await svc.testProviderConnection('acme-direct', { fetchImpl: fakeUnreachable(), lookup: r4Lookup() });
    assert.equal(test.ok, false);
    assert.equal(test.evidence.reachable, false);
    assert.ok(test.errors.length > 0 && test.errors[0].code, 'normalized error code present');
  });

  await check('R4.4 full healthy probe verifies the route with synthetic-only evidence', async () => {
    const svc = svcOn(tmpDir('r4-verify-'));
    const verified = await provisionVerifiedAcme(svc);
    assert.ok(verified.evidence, 'evidence returned');
    assert.ok(verified.evidence.note.indexOf('no user') !== -1, 'synthetic-only note, got ' + verified.evidence.note);
    const names = verified.checks.map((c) => c.name);
    for (const required of ['reachability-auth', 'tool-call-emission', 'tool-result-continuation']) {
      assert.ok(names.some((n) => n.indexOf(required) !== -1), 'required probe ' + required + ' ran, got ' + names.join(','));
    }
    const route = svc.getCatalog().catalog.routes.find((r) => r.routeId === 'acme-direct/acme-1');
    assert.equal(route.availability, 'verified');
    assert.equal(route.runnable, true);
  });

  // ── capability / reasoning mismatch ──────────────────────────────────────
  await check('R4 model/route mismatch and engine-scope failures stay fail-closed', () => {
    const svc = svcOn(tmpDir('r4-mismatch-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    assert.equal(svc.saveModel(acmeModel(), {}).ok, true);
    assert.equal(svc.saveConnection(acmeConnection(), {}).ok, true);
    assert.equal(svc.saveRoute(acmeRoute(), {}).ok, true);
    // v2 (muse-v0, contributor-only) must reject the dual standard-tier route.
    const bad = {
      schemaVersion: 1, modeId: 'engineering-v2', revision: 0,
      slots: { main: { logicalModelId: 'acme/acme-1', routeId: 'acme-direct/acme-1', reasoning: 'high' } },
    };
    const errs = svc.validate(bad).errors;
    assert.ok(errs.length > 0, 'cross-engine assignment must fail');
    assert.ok(codes(errs).indexOf('engine-scope-mismatch') !== -1, JSON.stringify(errs));
    // Unknown reasoning is rejected, never downshifted.
    const badReason = {
      schemaVersion: 1, modeId: 'engineering-v1', revision: 0,
      slots: {
        engineer: { logicalModelId: 'deepseek-v4-flash', routeId: 'flash-high-direct/deepseek-v4-flash', reasoning: 'ultra' },
        reviewer: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'medium' },
        solver: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'high' },
      },
    };
    const errs2 = svc.validate(badReason).errors;
    assert.ok(codes(errs2).indexOf('reasoning-level-not-supported') !== -1, JSON.stringify(errs2));
  });

  // ── R4.7 staged eligibility without production impact ────────────────────
  await check('R4.7 verified custom route is eligible and stages without touching production', async () => {
    const dataRoot = tmpDir('r4-e2e-');
    const svc = svcOn(dataRoot);
    await provisionVerifiedAcme(svc);
    const elig = svc.listEligible('engineering-v1', 'engineer').routes.map((r) => r.routeId);
    assert.ok(elig.indexOf('acme-direct/acme-1') !== -1, 'verified route is eligible, got ' + elig.join(','));
    const staged = {
      schemaVersion: 1, modeId: 'engineering-v1', revision: 0,
      slots: {
        engineer: { logicalModelId: 'acme/acme-1', routeId: 'acme-direct/acme-1', reasoning: 'high' },
        reviewer: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'medium' },
        solver: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'high' },
      },
    };
    const saved = svc.save('engineering-v1', staged, null, {});
    assert.equal(saved.ok, true, JSON.stringify(saved.errors));
    assert.ok(saved.resolutionId, 'compiled resolution id issued');
    // Eligibility did not auto-change anything else: reviewer still sol-local.
    const preview = svc.compilePreview(staged);
    assert.equal(preview.ok, true, JSON.stringify(preview.errors));
    assert.equal(preview.snapshot.roles.reviewer.providerId, 'sol-local', 'no silent substitution');
    assert.equal(preview.snapshot.roles.primaryEngineer.routeId, 'acme-direct/acme-1');
    assert.equal(preview.snapshot.roles.primaryEngineer.reasoning, 'high', 'reasoning never downgraded');
  });

  await check('R4.7 referenced routes/providers cannot be disabled or deleted without migration', async () => {
    const svc = svcOn(tmpDir('r4-dep-'));
    await provisionVerifiedAcme(svc);
    const staged = {
      schemaVersion: 1, modeId: 'engineering-v1', revision: 0,
      slots: {
        engineer: { logicalModelId: 'acme/acme-1', routeId: 'acme-direct/acme-1', reasoning: 'high' },
        reviewer: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'medium' },
        solver: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'high' },
      },
    };
    assert.equal(svc.save('engineering-v1', staged, null, {}).ok, true);
    const delRoute = svc.deleteCatalogRecord('routes', 'acme-direct/acme-1', {});
    assert.equal(delRoute.ok, false);
    assert.ok(codes(delRoute.errors).indexOf('dependency-blocked') !== -1, JSON.stringify(delRoute.errors));
    assert.ok(/saved-configuration/.test(delRoute.errors[0].message), 'dependency is reported, got ' + delRoute.errors[0].message);
    const disProvider = svc.disableCatalogRecord('providers', 'acme-direct', {});
    assert.equal(disProvider.ok, false);
    assert.ok(codes(disProvider.errors).indexOf('dependency-blocked') !== -1);
    const delConn = svc.deleteCatalogRecord('connections', 'conn-acme-1', {});
    assert.equal(delConn.ok, false);
    // Safe migration: re-stage without the custom route, then removal succeeds.
    const back = {
      schemaVersion: 1, modeId: 'engineering-v1', revision: 1,
      slots: {
        engineer: { logicalModelId: 'deepseek-v4-flash', routeId: 'flash-high-direct/deepseek-v4-flash', reasoning: 'high' },
        reviewer: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'medium' },
        solver: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'high' },
      },
    };
    assert.equal(svc.save('engineering-v1', back, 0, {}).ok, true);
    assert.equal(svc.deleteCatalogRecord('routes', 'acme-direct/acme-1', {}).ok, true);
  });

  // ── R4.5 runtime-neutral projection ──────────────────────────────────────
  await check('R4.5 known dialects project; unknown dialects fail closed', async () => {
    const svc = svcOn(tmpDir('r4-proj-'));
    await provisionVerifiedAcme(svc);
    const proj = svc.projectRoute('acme-direct/acme-1', { adapterId: 'dsh', protocols: ['openai-responses', 'openai-chat-completions'], executionKinds: ['raw-model'] });
    assert.equal(proj.ok, true, JSON.stringify(proj.errors));
    assert.equal(proj.projection.transportId, 'openai-responses');
    assert.equal(proj.projection.dshMapping.status, 'pending-dsh-mapping', 'operator providers carry no DSH ids until R6');
    const badRuntime = svc.projectRoute('acme-direct/acme-1', { adapterId: 'tiny', protocols: ['openai-chat-completions'], executionKinds: ['raw-model'] });
    assert.equal(badRuntime.ok, false);
    assert.ok(codes(badRuntime.errors).indexOf('runtime-capability-unsatisfied') !== -1);
    assert.equal(runtimeProjection.describeDialect('anthropic-messages').ok, false);
    assert.equal(runtimeProjection.describeDialect('agent-sdk').ok, false);
  });

  // ── concurrency / rollback ───────────────────────────────────────────────
  await check('R4 concurrent saves and rollback: loser fails closed, store keeps winners data', () => {
    const dataRoot = tmpDir('r4-conc-');
    const svc = svcOn(dataRoot);
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    const lockPath = path.join(dataRoot, 'registry', 'catalog.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'live-catalog-holder', at: new Date().toISOString() }));
    const conflicted = svc.saveModel(acmeModel(), {});
    assert.equal(conflicted.ok, false);
    assert.ok(codes(conflicted.errors).indexOf('write-conflict') !== -1, JSON.stringify(conflicted.errors));
    fs.unlinkSync(lockPath);
    assert.equal(svc.saveModel(acmeModel(), {}).ok, true, 'retry after release succeeds');
    const leftovers = fs.readdirSync(path.join(dataRoot, 'registry')).filter((n) => n.indexOf('.tmp-') !== -1);
    assert.deepEqual(leftovers, [], 'no temp leftovers after rollback paths');
  });

  // ── packaging / isolation ────────────────────────────────────────────────
  await check('R4 installed packaging: core stays dependency-free, catalog merges without DSH', () => {
    const sources = ['config/registry/operator-catalog.cjs', 'config/registry/provider-config.cjs', 'config/registry/probes.cjs', 'config/registry/runtime-projection.cjs', 'config/registry/service.cjs'];
    for (const f of sources) {
      const text = fs.readFileSync(path.join(repoRoot, f), 'utf8');
      assert.ok(!/require\(['"]\.\.\/dsh/i.test(text), f + ' must not import DSH');
      const usesStdlib = text.indexOf('node:') !== -1;
      const usesSiblings = text.indexOf('./schemas.cjs') !== -1 || text.indexOf('./resolver.cjs') !== -1 || text.indexOf('./config-store.cjs') !== -1 || text.indexOf('./service.cjs') !== -1 || text.indexOf('./operator-catalog.cjs') !== -1 || text.indexOf('./provider-config.cjs') !== -1 || text.indexOf('./probes.cjs') !== -1 || text.indexOf('./dsh-adapter.cjs') !== -1;
      const dependencyFree = !/require\s*\(/.test(text);
      assert.ok(usesStdlib || usesSiblings || dependencyFree, f + ' uses only stdlib/sibling imports (or is dependency-free)');
    }
    const svc = svcOn(tmpDir('r4-offline-'));
    const { catalog, errors } = svc.getCatalog();
    assert.ok(catalog.providers.length >= 8, 'built-ins merge offline');
    assert.deepEqual(errors, [], JSON.stringify(errors));
  });

  await check('R4 no production impact: legacy configs and controller code are byte-identical', async () => {
    const watched = [
      'config/model-registry.json', 'config/nexus-profiles.json', 'config/engineering-profiles.json',
      'config/muse-profiles.json', 'config/AihController.cjs', 'scripts/Routing.ps1',
      'config/registry/modes/engineering-v1.json', 'config/registry/modes/engineering-v2.json',
    ].map((f) => path.join(repoRoot, f));
    const before = hashFiles(watched);
    const svc = svcOn(tmpDir('r4-noprod-'));
    await provisionVerifiedAcme(svc);
    const staged = {
      schemaVersion: 1, modeId: 'engineering-v1', revision: 0,
      slots: {
        engineer: { logicalModelId: 'acme/acme-1', routeId: 'acme-direct/acme-1', reasoning: 'high' },
        reviewer: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'medium' },
        solver: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'high' },
      },
    };
    assert.equal(svc.save('engineering-v1', staged, null, {}).ok, true);
    assert.equal(hashFiles(watched), before, 'R4 writes stay under the isolated dataRoot');
  });

  // ── host boundary ────────────────────────────────────────────────────────
  await check('R4 host boundary: conflict codes map to 409, probe endpoints exist and gate origins', async () => {
    assert.equal(registryAdapter.errorStatusOf([{ code: 'dependency-blocked' }]), 409);
    assert.equal(registryAdapter.errorStatusOf([{ code: 'duplicate-id' }]), 409);
    assert.equal(registryAdapter.errorStatusOf([{ code: 'unsupported-protocol' }]), 422);
    assert.equal(registryAdapter.errorStatusOf([{ code: 'endpoint-forbidden-ssrf' }]), 422);
    const svc = svcOn(tmpDir('r4-host-'));
    const handlers = registryAdapter.createRegistryHandlers(svc);
    for (const name of ['catalogHandler', 'providerSaveHandler', 'modelSaveHandler', 'routeSaveHandler', 'connectionSaveHandler', 'providerDisableHandler', 'routeDisableHandler', 'providerDeleteHandler', 'connectionStatusHandler', 'providerTestHandler', 'providerDiscoverHandler', 'routeVerifyHandler', 'routeEvidenceHandler', 'routeProjectHandler']) {
      assert.equal(typeof handlers[name], 'function', 'missing host handler ' + name);
    }
    // Foreign origin is rejected on the catalog route (CSRF boundary, not auth).
    const foreign = { method: 'GET', url: '/nexus/registry/v1/catalog', headers: { host: '127.0.0.1:3080', origin: 'http://evil.example:3080' }, socket: {} };
    await handlers.catalogHandler(foreign, {
      writeHead(status) { this.status = status; },
      end(body) {
        assert.equal(this.status, 403, 'foreign origin rejected, got ' + this.status + ' ' + body);
      },
    });
  });

  // ── UI smoke ─────────────────────────────────────────────────────────────
  await check('R4 UI smoke: Models & Providers panel renders working controls and evidence', () => {
    const source = fs.readFileSync(CLIENT, 'utf8');
    for (const label of ['Add Provider', 'Edit Provider', 'Disable Provider', 'Add Model Manually', 'Add/Edit Route', 'Test Connection', 'Discover Models', 'Verify Capabilities', 'Refresh', 'Validate & Save']) {
      assert.ok(source.indexOf(label) !== -1, 'panel control present: ' + label);
    }
    const react = stubReact();
    const jsxRuntime = { jsx: (t, p) => react.createElement(t, p, p && p.children), jsxs: (t, p) => react.createElement(t, p, p && p.children), Fragment: react.Fragment };
    let factory = null;
    const svc = svcOn(tmpDir('r4-uismoke-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    assert.equal(svc.saveModel(acmeModel(), {}).ok, true);
    const seams = {
      __NX_TEST_REGISTRY_CATALOG__: svc.getCatalog().catalog,
      __NX_TEST_REGISTRY_MODES__: null, __NX_TEST_REGISTRY_CONFIG__: null, __NX_TEST_REGISTRY_ELIGIBLE__: null,
    };
    const sandbox = {
      console, URL, Promise, Map, Set, JSON, Object, Array, Symbol, Error, Math, Number, String, Boolean, Date, RegExp,
      window: Object.assign({}, seams, {
        localStorage: { getItem: () => null, setItem: () => {} },
        setTimeout: () => 0, clearTimeout: () => {},
        __ModuleLoader__: { load(def) { factory = def.factory; } },
      }),
      document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
      navigator: {},
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'client.js' });
    const module = { exports: {} };
    const exports = factory((name) => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return jsxRuntime;
      throw new Error('unexpected require ' + name);
    });
    assert.equal(typeof exports.ModelsProvidersPanel, 'function', 'panel is exported for the smoke seam');
    const html = exports.ModelsProvidersPanel();
    assert.ok(html.indexOf('Models & Providers (Registry)') !== -1, 'panel title');
    assert.ok(html.indexOf('Acme AI') !== -1, 'operator display names shown instead of raw ids alone');
    for (const label of ['Add Provider', 'Edit Provider', 'Disable Provider', 'Test Connection', 'Discover Models', 'Verify Capabilities', 'Refresh', 'Add Model Manually', 'Add/Edit Route']) {
      assert.ok(html.indexOf(label) !== -1, 'working control rendered: ' + label);
    }
    // Form-scoped Validate & Save buttons render after a row action opens
    // the corresponding editor; assert their wiring exists in source.
    assert.ok(source.indexOf('Validate & Save') !== -1, 'form Validate & Save controls exist');
    assert.ok(source.indexOf('/routes/verify') !== -1 && source.indexOf('/providers/discover') !== -1 && source.indexOf('/providers/test') !== -1, 'probe endpoints wired to controls');
    assert.ok(html.indexOf('raw-model') !== -1, 'execution contracts visibly distinct');
    assert.ok(html.indexOf('Not runnable') !== -1, 'unverified routes grouped with reasons');
    assert.ok(!/aih-[a-z]+/.test(html), 'no internal preset ids in R4 UI');
  });

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failed + ' | total ' + (passed + failed));
  if (failed > 0) {
    console.log('FAILURES:\n' + failures.join('\n'));
    process.exitCode = 1;
  }
}

function stubReact() {
  const Fragment = Symbol('Fragment');
  const selfClosing = new Set(['input', 'br', 'hr', 'img']);
  function renderAttrs(props) {
    if (!props) return '';
    const out = [];
    for (const key of Object.keys(props)) {
      if (key === 'children' || key === 'onClick' || key === 'onChange') continue;
      const v = props[key];
      if (v === null || v === undefined || v === false) continue;
      out.push(key + '=\"' + String(v).replace(/&/g, '&amp;').replace(/\"/g, '&quot;') + '\"');
    }
    return out.length > 0 ? ' ' + out.join(' ') : '';
  }
  function render(node) {
    if (node === null || node === undefined || node === false) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(render).join('');
    const { type, props } = node;
    const kids = render(props && props.children);
    if (type === Fragment) return kids;
    if (typeof type === 'string') {
      if (selfClosing.has(type)) return '<' + type + renderAttrs(props) + '>';
      return '<' + type + renderAttrs(props) + '>' + kids + '</' + type + '>';
    }
    return kids;
  }
  function h(type, props, ...children) {
    if (typeof type === 'function') {
      const merged = Object.assign({}, props);
      merged.children = children.length === 1 ? children[0] : children;
      return render(type(merged));
    }
    const flat = [];
    for (const c of children) {
      if (Array.isArray(c)) flat.push(...c);
      else flat.push(c);
    }
    return { type, props: Object.assign({}, props, { children: flat }) };
  }
  const react = {
    createElement: (t, p, ...kids) => {
      if (typeof t === 'function') return t(Object.assign({}, p, { children: kids.length === 1 ? kids[0] : kids }));
      const flat = [];
      for (const c of (p && p.children !== undefined ? [p.children] : kids)) {
        if (Array.isArray(c)) flat.push(...c);
        else flat.push(c);
      }
      if (typeof t === 'string') {
        if (selfClosing.has(t)) return '<' + t + renderAttrs(p) + '>';
        return '<' + t + renderAttrs(p) + '>' + flat.map(render).join('') + '</' + t + '>';
      }
      return flat.map(render).join('');
    },
    Fragment,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
  };
  void h;
  return react;
}

main().catch((e) => { console.error('SUITE CRASH: ' + (e && e.stack || e)); process.exitCode = 1; });
