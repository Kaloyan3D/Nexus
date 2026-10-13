'use strict';

// Registry R4.1 — Secure Probes & Evidence Integrity (adversarial suite).
// Each check encodes the HARDENED expectation: it must FAIL against the
// permissive R4 implementation and PASS after the H1/H2/H3 correction.
// Offline; isolated tmp data roots; injected fake transports only. No
// credentials, no live network, no DSH sessions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

const BEARER = 'probe-bearer-acme-1';
function publicLookup() { return async () => [{ address: '93.184.216.34', family: 4 }]; }
function privateLookup() { return async () => [{ address: '10.0.0.5', family: 4 }]; }
function jsonRes(status, obj, extra) {
  return Object.assign({ status, text: async () => JSON.stringify(obj) }, extra || {});
}

// Records every requested URL; optionally emulates fetch redirect-following
// (honoring redirect:'manual' exactly like the platform fetch does).
function recordingFetch(handler, opts) {
  const seen = [];
  const follow = !(opts && opts.noFollow);
  async function invoke(url, init) {
    seen.push(String(url));
    let res = await handler(String(url), init || {});
    let hops = 0;
    while (follow && res && res.status >= 300 && res.status < 400 && hops < 5) {
      if (init && init.redirect === 'manual') break;
      const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : (res.location || null);
      if (!loc) break;
      hops += 1;
      seen.push(String(loc));
      res = await handler(String(loc), init || {});
    }
    return res;
  }
  invoke.seen = seen;
  return invoke;
}
function locHeaders(target) {
  return { get: (name) => (String(name).toLowerCase() === 'location' ? target : null) };
}

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

// Open fake: protocol-accurate Responses payloads, no auth requirement.
// Lets the pre-fix build reach verified so invalidation tests have a start
// state; post-fix the same flow passes with an injected test bearer.
function openFake() {
  return async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (method === 'GET' && /\/models$/.test(u)) return jsonRes(200, { data: [{ id: 'acme-1-large' }] });
    if (method === 'POST' && /\/responses$/.test(u)) {
      const body = JSON.parse(String((init && init.body) || '{}'));
      const effort = body.reasoning && body.reasoning.effort;
      if (body.stream === true) {
        const sse = 'event: response.output_text.delta\ndata: {\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"probe\"}]}]}\n\ndata: [DONE]\n\n';
        return { status: 200, text: async () => sse };
      }
      if (body.tools) {
        return jsonRes(200, { status: 'completed', reasoning: effort ? { effort } : undefined, output: [{ type: 'function_call', name: 'probe_echo', call_id: 'call_REAL_abc', arguments: '{\"word\":\"probe-ok\"}' }] });
      }
      if (Array.isArray(body.input) && body.input.some((e) => e && e.type === 'function_call_output')) {
        return jsonRes(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok acknowledged' }] }] });
      }
      return jsonRes(200, { status: 'completed', reasoning: effort ? { effort } : undefined, output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok' }] }] });
    }
    return jsonRes(404, { error: 'not found' });
  };
}

async function provisionOpen(svc, bearer) {
  assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
  assert.equal(svc.saveModel(acmeModel(), {}).ok, true);
  assert.equal(svc.saveConnection(acmeConnection(), {}).ok, true);
  assert.equal(svc.setConnectionStatus('conn-acme-1', 'connected', { attested: true }).ok, true);
  assert.equal(svc.saveRoute(acmeRoute(), {}).ok, true);
  // R4.2: no streaming shortcut remains; the open fake serves genuine SSE
  // plus per-level reasoning echoes, so setup verifies on the full path.
  const opts = { fetchImpl: openFake(), lookup: publicLookup() };
  if (bearer) opts.testBearer = bearer;
  const verified = await svc.verifyProviderRoute('acme-direct/acme-1', opts);
  assert.equal(verified.ok, true, 'setup must reach verified, got ' + JSON.stringify(verified.errors));
  return verified;
}
function eligibleIds(svc) {
  return svc.listEligible('engineering-v1', 'engineer').routes.map((r) => r.routeId);
}

async function main() {
  // ── H1: secure network probing ──────────────────────────────────────────
  await check('H1 redirect to loopback is refused and never requested', async () => {
    const svc = svcOn(tmpDir('h1-redir-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    const fetch = recordingFetch(async (url, init) => {
      if (/\/models$/.test(url) && url.indexOf('api.acme.example') !== -1) {
        return { status: 302, headers: locHeaders('http://127.0.0.1:9/models'), text: async () => 'redirect' };
      }
      return jsonRes(200, { data: [] });
    });
    const out = await svc.testProviderConnection('acme-direct', { fetchImpl: fetch, lookup: publicLookup() });
    assert.equal(out.ok, false, 'redirect must not satisfy a connection test');
    assert.ok(fetch.seen.every((u) => u.indexOf('127.0.0.1') === -1), 'loopback target must never be requested, saw ' + JSON.stringify(fetch.seen));
    assert.ok(codes(out.errors).indexOf('probe-redirect-refused') !== -1, 'refusal code, got ' + JSON.stringify(out.errors));
  });

  await check('H1 public hostname resolving to a private IP is refused', async () => {
    const svc = svcOn(tmpDir('h1-dns-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    let requested = 0;
    const fetch = async () => { requested += 1; return jsonRes(200, { data: [] }); };
    const out = await svc.testProviderConnection('acme-direct', { fetchImpl: fetch, lookup: privateLookup() });
    assert.equal(out.ok, false);
    assert.equal(requested, 0, 'no request may leave when DNS resolves private');
    assert.ok(codes(out.errors).indexOf('endpoint-forbidden-ssrf') !== -1, JSON.stringify(out.errors));
  });

  await check('H1 oversized streaming body stops before full buffering', async () => {
    const svc = svcOn(tmpDir('h1-size-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    let chunksYielded = 0;
    let bufferedAll = false;
    const total = 300;
    const chunk = 'x'.repeat(1024);
    const fetch = async () => ({
      status: 200,
      body: (async function* () { for (let i = 0; i < total; i += 1) { chunksYielded += 1; yield chunk; } })(),
      text: async () => { bufferedAll = true; return chunk.repeat(total); },
    });
    const out = await svc.discoverProviderModels('acme-direct', { fetchImpl: fetch, lookup: publicLookup() });
    assert.equal(out.ok, false);
    assert.ok(codes(out.errors).indexOf('probe-response-too-large') !== -1, JSON.stringify(out.errors));
    assert.equal(bufferedAll, false, 'must not buffer the whole body before enforcing the cap');
    assert.ok(chunksYielded < total, 'must stop early, pulled ' + chunksYielded + '/' + total);
  });

  await check('H1 deadline stays active while the body stalls', async () => {
    const svc = svcOn(tmpDir('h1-stall-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    const fetch = async () => ({ status: 200, text: () => new Promise(() => {}) });
    const raced = await Promise.race([
      svc.testProviderConnection('acme-direct', { fetchImpl: fetch, lookup: publicLookup(), timeoutMs: 60 }).then((r) => ({ settled: true, r })),
      delay(3000).then(() => ({ settled: false })),
    ]);
    assert.equal(raced.settled, true, 'probe must settle via its own deadline, not hang');
    assert.ok(codes(raced.r.errors).indexOf('probe-timeout') !== -1, JSON.stringify(raced.r.errors));
  });

  await check('H1 concurrent probes are bounded and responses are cleaned up', async () => {
    const svc = svcOn(tmpDir('h1-conc-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    let inflight = 0;
    let peak = 0;
    let cancelled = 0;
    let release;
    const gate = new Promise((res) => { release = res; });
    const fetch = async () => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await gate;
      inflight -= 1;
      return { status: 200, body: { cancel: async () => { cancelled += 1; } }, text: async () => JSON.stringify({ data: [] }) };
    };
    const calls = [];
    for (let i = 0; i < 6; i += 1) calls.push(svc.testProviderConnection('acme-direct', { fetchImpl: fetch, lookup: publicLookup() }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    await new Promise((res) => setImmediate(res));
    assert.ok(peak <= 4, 'at most 4 concurrent probe requests, saw ' + peak);
    release();
    const results = await Promise.all(calls);
    assert.ok(results.every((r) => r.ok), 'all bounded probes complete');
    assert.ok(cancelled >= 6, 'response bodies are cleaned up, got ' + cancelled);
  });

  await check('H1 caller cancellation settles verification promptly', async () => {
    const svc = svcOn(tmpDir('h1-cancel-'));
    await provisionOpen(svc, BEARER);
    const controller = new AbortController();
    const fetch = (url, init) => new Promise((res, rej) => {
      const sig = init && init.signal;
      if (sig && sig.aborted) { rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
      if (sig) sig.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const pending = svc.verifyProviderRoute('acme-direct/acme-1', { fetchImpl: fetch, lookup: publicLookup(), testBearer: BEARER, signal: controller.signal });
    controller.abort();
    const raced = await Promise.race([pending.then((r) => ({ settled: true, r })), delay(3000).then(() => ({ settled: false }))]);
    assert.equal(raced.settled, true, 'cancellation must settle verification');
    assert.equal(raced.r.ok, false);
    assert.ok(codes(raced.r.errors).indexOf('probe-cancelled') !== -1, JSON.stringify(raced.r.errors));
  });

  await check('H1 legitimate public endpoints still pass the hardened path', async () => {
    const svc = svcOn(tmpDir('h1-legit-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    assert.equal(svc.saveConnection(acmeConnection(), {}).ok, true);
    const fetch = async (url, init) => {
      const auth = init && init.headers && init.headers.authorization;
      if (auth !== 'Bearer ' + BEARER) return jsonRes(401, { error: 'invalid key' });
      return jsonRes(200, { data: [{ id: 'acme-1-large' }] });
    };
    const denied = await svc.testProviderConnection('acme-direct', { fetchImpl: fetch, lookup: publicLookup() });
    assert.equal(denied.ok, false, 'no bearer, no authenticated verdict');
    const allowed = await svc.testProviderConnection('acme-direct', { fetchImpl: fetch, lookup: publicLookup(), testBearer: BEARER });
    assert.equal(allowed.ok, true, JSON.stringify(allowed.errors));
    assert.equal(allowed.evidence.authenticated, true);
  });

  // ── H2: protocol-accurate verification ───────────────────────────────────
  await check('H2 arbitrary JSON cannot pass text verification', async () => {
    const svc = svcOn(tmpDir('h2-json-'));
    await provisionOpen(svc, BEARER);
    const fetch = async (url, init) => {
      if ((init && init.method) === 'GET') return jsonRes(200, { data: [{ id: 'acme-1-large' }] });
      return jsonRes(200, { hello: 'world', probe_echo: 'mentioned but not structured' });
    };
    const out = await svc.verifyProviderRoute('acme-direct/acme-1', { fetchImpl: fetch, lookup: publicLookup(), testBearer: BEARER });
    assert.equal(out.ok, false, 'arbitrary JSON is not a completion');
  });

  await check('H2 fake tool-call strings cannot pass structural validation', async () => {
    const svc = svcOn(tmpDir('h2-toolstr-'));
    await provisionOpen(svc, BEARER);
    const fetch = async (url, init) => {
      if ((init && init.method) === 'GET') return jsonRes(200, { data: [{ id: 'acme-1-large' }] });
      const body = JSON.parse(String((init && init.body) || '{}'));
      if (body.stream === true) {
        return { status: 200, text: async () => 'event: message\ndata: {\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"probe\"}]}]}\n\ndata: [DONE]\n\n' };
      }
      if (body.tools) return jsonRes(200, { status: 'completed', output: 'probe_echo function_call happened, call it done' });
      return jsonRes(200, { status: 'completed', reasoning: { effort: 'low' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok' }] }] });
    };
    const out = await svc.verifyProviderRoute('acme-direct/acme-1', { fetchImpl: fetch, lookup: publicLookup(), testBearer: BEARER });
    assert.equal(out.ok, false, 'stringified tool-call mention is not a tool call');
    assert.ok(out.checks.some((c) => c.name.indexOf('tool-call-emission') !== -1 && c.ok === false), 'emission check records the failure');
  });

  await check('H2 continuation reuses the emitted call id; wrong ids fail', async () => {
    const svc = svcOn(tmpDir('h2-callid-'));
    await provisionOpen(svc, BEARER);
    const out = await svc.verifyProviderRoute('acme-direct/acme-1', { fetchImpl: openFake(), lookup: publicLookup(), testBearer: BEARER, skipStreaming: true });
    assert.equal(out.ok, true, 'genuine id round-trips, got ' + JSON.stringify(out.errors));
    const emission = out.checks.find((c) => c.name.indexOf('tool-call-emission') !== -1);
    assert.ok(emission && emission.detail.indexOf('call_REAL_abc') !== -1, 'evidence names the reused id, got ' + JSON.stringify(emission));
    // Strict continuation endpoint: succeeds ONLY for the emitted id, so a
    // synthesized id fails while the genuinely reused id passes.
    const strictFake = async (url, init) => {
      const base = await openFake()(url, init);
      const body = JSON.parse(String((init && init.body) || '{}'));
      if (Array.isArray(body.input) && body.input.some((e) => e && e.type === 'function_call_output')) {
        const out = body.input.find((e) => e && e.type === 'function_call_output');
        if (!out || out.call_id !== 'call_REAL_abc') return jsonRes(422, { error: 'unknown call_id' });
      }
      return base;
    };
    const direct = await probes.verifyRoute(
      { id: 'acme-direct', transportId: 'openai-responses', baseUrl: 'https://api.acme.example/v1' },
      { id: 'm', capabilities: { textInput: true, toolCalling: true, streaming: false, reasoning: true } },
      { id: 'r', remoteModelId: 'acme-1-large', reasoningLevels: ['low'] },
      { credentialRef: 'credential://x', connectionKind: 'api-key', testBearer: BEARER },
      strictFake,
      { lookup: publicLookup() });
    assert.equal(direct.ok, true, 'emitted id must round-trip, got ' + JSON.stringify(direct.errors));
  });

  await check('H2 fake JSON cannot pass an SSE streaming probe', async () => {
    const svc = svcOn(tmpDir('h2-sse-'));
    await provisionOpen(svc, BEARER);
    const fetch = async (url, init) => {
      if ((init && init.method) === 'GET') return jsonRes(200, { data: [{ id: 'acme-1-large' }] });
      const body = JSON.parse(String((init && init.body) || '{}'));
      if (body.stream === true) return jsonRes(200, { streamed: true, output: [] });
      if (body.tools) return jsonRes(200, { status: 'completed', output: [{ type: 'function_call', name: 'probe_echo', call_id: 'call_REAL_abc', arguments: '{\"word\":\"probe-ok\"}' }] });
      if (Array.isArray(body.input) && body.input.some((e) => e && e.type === 'function_call_output')) {
        return jsonRes(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok acknowledged' }] }] });
      }
      return jsonRes(200, { status: 'completed', reasoning: { effort: 'low' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok' }] }] });
    };
    const out = await svc.verifyProviderRoute('acme-direct/acme-1', { fetchImpl: fetch, lookup: publicLookup(), testBearer: BEARER });
    assert.equal(out.ok, false, 'plain JSON is not an SSE stream');
  });

  await check('H2 unauthenticated 200 is reachability, never authenticated access', async () => {
    const svc = svcOn(tmpDir('h2-authsep-'));
    assert.equal(svc.saveProvider(acmeProvider(), {}).ok, true);
    assert.equal(svc.saveConnection(acmeConnection(), {}).ok, true);
    const fetch = async () => jsonRes(200, { data: [{ id: 'acme-1-large' }] });
    const out = await svc.testProviderConnection('acme-direct', { fetchImpl: fetch, lookup: publicLookup() });
    assert.equal(out.evidence.reachable, true);
    assert.equal(out.evidence.authenticated, false, 'no presented credential means no authenticated verdict');
    assert.equal(out.ok, false);
  });

  await check('H2 operator attestation cannot substitute missing API authorization', async () => {
    const svc = svcOn(tmpDir('h2-attest-'));
    await provisionOpen(svc, BEARER);
    const out = await svc.verifyProviderRoute('acme-direct/acme-1', { fetchImpl: openFake(), lookup: publicLookup() });
    assert.equal(out.ok, false, 'attested status without presented credentials must not verify');
    assert.ok(codes(out.errors).indexOf('probe-auth-required') !== -1, JSON.stringify(out.errors));
    assert.ok(eligibleIds(svc).indexOf('acme-direct/acme-1') === -1, 'route stays ineligible');
  });

  // ── H3: evidence binding ────────────────────────────────────────────────
  await check('H3 endpoint, model, route and connection changes invalidate old evidence', async () => {
    const svc = svcOn(tmpDir('h3-inval-'));
    await provisionOpen(svc, BEARER);
    assert.ok(eligibleIds(svc).indexOf('acme-direct/acme-1') !== -1, 'setup eligible');
    const changed = svc.saveProvider(Object.assign({}, acmeProvider(), { baseUrl: 'https://api2.acme.example/v1' }), {});
    assert.equal(changed.ok, true);
    assert.ok(eligibleIds(svc).indexOf('acme-direct/acme-1') === -1, 'endpoint change invalidates eligibility');
    const svc2 = svcOn(tmpDir('h3-inval2-'));
    await provisionOpen(svc2, BEARER);
    assert.equal(svc2.saveRoute(Object.assign({}, acmeRoute(), { remoteModelId: 'acme-1-small' }), {}).ok, true);
    assert.ok(eligibleIds(svc2).indexOf('acme-direct/acme-1') === -1, 'remote-model change invalidates eligibility');
    const svc3 = svcOn(tmpDir('h3-inval3-'));
    await provisionOpen(svc3, BEARER);
    assert.equal(svc3.setConnectionStatus('conn-acme-1', 'revoked', {}).ok, true);
    assert.ok(eligibleIds(svc3).indexOf('acme-direct/acme-1') === -1, 'revocation invalidates eligibility');
  });

  await check('H3 failed re-probe demotes previously verified operator routes', async () => {
    const svc = svcOn(tmpDir('h3-demote-'));
    await provisionOpen(svc, BEARER);
    assert.ok(eligibleIds(svc).indexOf('acme-direct/acme-1') !== -1, 'setup eligible');
    const failing = async (url, init) => {
      if ((init && init.method) === 'GET') return jsonRes(401, { error: 'revoked' });
      return jsonRes(500, { error: 'boom' });
    };
    const out = await svc.verifyProviderRoute('acme-direct/acme-1', { fetchImpl: failing, lookup: publicLookup(), testBearer: BEARER });
    assert.equal(out.ok, false);
    assert.ok(eligibleIds(svc).indexOf('acme-direct/acme-1') === -1, 'failed re-probe leaves no stale eligibility');
    const current = svc.getRouteEvidence('acme-direct/acme-1');
    assert.ok(current.evidence === null || current.evidence.failed === true, 'current evidence is not a pass');
    assert.ok(Array.isArray(current.attempts) && current.attempts.length >= 1, 'history preserves attempts for diagnostics, got ' + JSON.stringify(current.attempts && current.attempts.length));
    assert.ok(current.attempts.some((a) => a && a.failed !== true), 'the earlier passing attempt is preserved in history');
  });

  await check('H3 evidence carries a versioned fingerprint of the verified binding', async () => {
    const svc = svcOn(tmpDir('h3-fp-'));
    const verified = await provisionOpen(svc, BEARER);
    assert.ok(verified.evidence.fingerprint, 'fingerprint present');
    assert.equal(verified.evidence.contractVersion, 3, 'probe contract version pinned');
    assert.ok(verified.evidence.fingerprint !== verified.evidence.routeId, 'fingerprint is a digest, not an id');
    const stored = svc.getRouteEvidence('acme-direct/acme-1');
    assert.equal(stored.evidence.fingerprint, verified.evidence.fingerprint, 'stored evidence matches the granted binding');
  });

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failed + ' | total ' + (passed + failed));
  if (failed > 0) {
    console.log('FAILURES:\n' + failures.join('\n'));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('SUITE CRASH: ' + (e && e.stack || e)); process.exitCode = 1; });
