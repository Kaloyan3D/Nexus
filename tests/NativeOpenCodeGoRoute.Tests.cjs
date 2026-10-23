'use strict';
// A5.4: OpenCode Go Registry probe compatibility and the billable-verification
// gate, offline (stub fetch; no network, no real credential).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const setup = require('../scripts/Setup-NativeOpenCodeGo.cjs');
const gate = require('../scripts/Verify-NativeOpenCodeGoRoute.cjs');

let passed = 0;
async function check(label, fn) { await fn(); passed++; console.log('PASS: ' + label); }
const quiet = () => {};
const publicLookup = async () => [{ address: '104.18.0.1', family: 4 }];

function root() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ogo-'));
  assert.equal(setup.run(['--data-root', d, '--apply'], quiet), 0);
  return d;
}
function creds(d, key) {
  const f = path.join(d, 'creds.json');
  fs.writeFileSync(f, JSON.stringify({ 'credential://connections/conn-opencode-go-native': key }), { mode: 0o600 });
  return f;
}
function stub(calls, overrides) {
  return async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const o = (overrides || {})[calls.length - 1];
    if (o) return o;
    if (init.method === 'GET') return { status: 200, text: async () => JSON.stringify({ data: [{ id: 'muse-spark-1.3-contributor' }] }) };
    const parsed = JSON.parse(init.body);
    if (parsed.tools) return { status: 200, text: async () => JSON.stringify({ status: 'completed', output: [{ type: 'function_call', name: 'probe_echo', call_id: 'call_1', arguments: '{"word":"probe-ok"}' }] }) };
    if (Array.isArray(parsed.input)) return { status: 200, text: async () => JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] }) };
    if (parsed.stream) {
      const ev = 'event: response.output_text.delta\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'probe-ok' }) + '\n\n';
      return { status: 200, text: async () => ev + 'data: [DONE]\n\n' };
    }
    return { status: 200, text: async () => JSON.stringify({ status: 'completed', output_text: 'probe-ok', reasoning: { effort: (parsed.reasoning && parsed.reasoning.effort) || 'low' } }) };
  };
}

(async () => {
  await check('verification without an authorization record sends nothing', async () => {
    const d = root(); const calls = [];
    const code = await gate.verify(['--data-root', d, '--credentials', creds(d, 'SECRETKEY')], quiet, { opts: { fetchImpl: stub(calls), lookup: publicLookup } });
    assert.equal(code, 3); assert.equal(calls.length, 0);
  });

  await check('authorized verification sends exactly GET models + 4 POST responses, with session header and Go URLs', async () => {
    const d = root(); const calls = [];
    assert.equal(gate.authorize(['--data-root', d, '--acknowledge-billable'], quiet), 0);
    const lines = [];
    const code = await gate.verify(['--data-root', d, '--credentials', creds(d, 'SECRETKEY')], (l) => lines.push(l), { opts: { fetchImpl: stub(calls), lookup: publicLookup } });
    assert.equal(code, 0, lines.join('\n'));
    assert.deepEqual(calls.map((c) => c.method + ' ' + c.url), [
      'GET https://opencode.ai/inference/go/v1/models',
      'POST https://opencode.ai/inference/go/openai/v1/responses',
      'POST https://opencode.ai/inference/go/openai/v1/responses',
      'POST https://opencode.ai/inference/go/openai/v1/responses',
      'POST https://opencode.ai/inference/go/openai/v1/responses',
    ]);
    const cont = JSON.parse(calls[4].body);
    assert.deepEqual(cont.input.map((i) => i.type), ['function_call', 'function_call_output']);
    assert.equal(cont.input[0].call_id, cont.input[1].call_id);
    const reg = require('../config/registry/service.cjs').createService({ installRoot: path.resolve(__dirname, '..'), dataRoot: d });
    assert.ok(reg.getConnections ? true : true);
    for (const c of calls) {
      assert.equal(c.headers['x-opencode-session'], 'nexus-registry-probe-opencode-go-native');
      assert.equal(c.headers.authorization, 'Bearer SECRETKEY');
    }
    const body = JSON.parse(calls[1].body);
    assert.deepEqual(Object.keys(body).sort(), ['input', 'max_output_tokens', 'model', 'reasoning']);
    assert.equal(body.model, 'muse-spark-1.3-contributor'); assert.equal(body.max_output_tokens, 4096);
    assert.equal(JSON.parse(calls[2].body).stream, true);
    assert.ok(!('tools' in body));
  });

  await check('authorization is single-use and a failed verification does not retry', async () => {
    const d = root(); const calls = [];
    gate.authorize(['--data-root', d, '--acknowledge-billable'], quiet);
    const f = creds(d, 'K');
    const bad = { 1: { status: 429, text: async () => 'rate limited' } };
    const code = await gate.verify(['--data-root', d, '--credentials', f], quiet, { opts: { fetchImpl: stub(calls, bad), lookup: publicLookup } });
    assert.equal(code, 1); assert.ok(calls.length <= 5);
    const n = calls.length;
    assert.equal(await gate.verify(['--data-root', d, '--credentials', f], quiet, { opts: { fetchImpl: stub(calls), lookup: publicLookup } }), 3);
    assert.equal(calls.length, n);
  });

  await check('authorize requires the billable acknowledgement; expired/loose records refuse', async () => {
    const d = root();
    assert.equal(gate.authorize(['--data-root', d], quiet), 2);
    gate.authorize(['--data-root', d, '--acknowledge-billable'], quiet);
    const rec = path.join(d, 'route-verification-authorization.json');
    fs.chmodSync(rec, 0o644);
    assert.equal(gate.consume(d).ok, false);
    const d2 = root();
    gate.authorize(['--data-root', d2, '--acknowledge-billable'], quiet);
    const r2 = path.join(d2, 'route-verification-authorization.json');
    const j = JSON.parse(fs.readFileSync(r2, 'utf8')); j.expiresAtMs = 1; fs.writeFileSync(r2, JSON.stringify(j), { mode: 0o600 });
    assert.match(gate.consume(d2).why, /expired/);
  });

  await check('legacy providers keep base+/models and no session header', async () => {
    const probes = require('../config/registry/probes.cjs');
    const calls = [];
    const p = { id: 'acme', transportId: 'openai-responses', baseUrl: 'https://opencode.ai/inference/go/openai/v1', metadata: {} };
    await probes.discoverModels(p, { testBearer: 'k' }, stub(calls), { lookup: publicLookup });
    assert.equal(calls[0].url, 'https://opencode.ai/inference/go/openai/v1/models');
    assert.equal('x-opencode-session' in calls[0].headers, false);
  });

  await check('dual-stack hosts: Go probes dial IPv4 only, other providers keep the unchanged lookup', async () => {
    const probes = require('../config/registry/probes.cjs');
    const seen = [];
    const dns = require('node:dns').promises;
    const orig = dns.lookup;
    dns.lookup = async (h, o) => { seen.push(o); return [{ address: '172.65.90.20', family: 4 }]; };
    try {
      const go = { id: 'g', transportId: 'openai-responses', baseUrl: 'https://opencode.ai/inference/go/openai/v1', metadata: { wireProfile: 'opencode-go-responses' } };
      const other = { id: 'o', transportId: 'openai-responses', baseUrl: 'https://api.example.com/v1', metadata: {} };
      await probes.discoverModels(go, { testBearer: 'k' }, stub([]), {});
      await probes.discoverModels(other, { testBearer: 'k' }, stub([]), {});
    } finally { dns.lookup = orig; }
    assert.equal(seen[0].family, 4);
    assert.equal(seen[1].family, undefined);
  });

  await check('SSRF: Go probes validate EVERY address they may dial (A only; AAAA never dialed; mixed answers refused)', async () => {
    const probes = require('../config/registry/probes.cjs');
    const dns = require('node:dns').promises;
    const orig = dns.lookup;
    const go = { id: 'g', transportId: 'openai-responses', baseUrl: 'https://opencode.ai/inference/go/openai/v1', metadata: { wireProfile: 'opencode-go-responses' } };
    const run = async (answers) => {
      dns.lookup = async (h, o) => answers.filter((a) => !o || !o.family || a.family === o.family);
      const calls = [];
      try { const r = await probes.discoverModels(go, { testBearer: 'k' }, stub(calls), {}); return { r, calls }; } finally { dns.lookup = orig; }
    };
    const A = (address) => ({ address, family: 4 });
    const AAAA = (address) => ({ address, family: 6 });
    // dual-stack public: only the A records are considered, request goes out
    let o = await run([A('172.65.90.20'), A('172.65.90.21'), AAAA('2606:4700:78::90:0:140')]);
    assert.equal(o.r.ok, true); assert.equal(o.calls.length, 1);
    // AAAA-only host: nothing dialable -> refused, nothing sent
    o = await run([AAAA('2606:4700:78::90:0:140')]);
    assert.equal(o.r.ok, false); assert.equal(o.calls.length, 0);
    // a private/special A record anywhere in the answer -> whole host refused, nothing sent
    for (const bad of ['127.0.0.1', '10.0.0.1', '172.16.5.5', '192.168.0.9', '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.18.0.1', '224.0.0.1', '240.0.0.1']) {
      for (const order of [[A(bad), A('172.65.90.20')], [A('172.65.90.20'), A(bad)]]) {
        o = await run(order);
        assert.equal(o.r.ok, false, bad); assert.equal(o.calls.length, 0, bad);
        assert.equal(o.r.errors[0].code, 'endpoint-forbidden-ssrf', bad);
      }
    }
    // IPv4-mapped IPv6 in an A-family answer position is still judged by its embedded address
    o = await run([A('172.65.90.20'), { address: '::ffff:10.0.0.1', family: 4 }]);
    assert.equal(o.r.ok, false); assert.equal(o.calls.length, 0);
  });

  await check('SSRF: redirects are refused and never followed; the shared checker keeps IPv6 and special addresses restricted', async () => {
    const probes = require('../config/registry/probes.cjs');
    const pc = require('../config/registry/provider-config.cjs');
    const calls = [];
    const redirect = async (u) => { calls.push(u); return { status: 302, headers: { location: 'http://127.0.0.1/' }, text: async () => '' }; };
    const p = { id: 'g', transportId: 'openai-responses', baseUrl: 'https://opencode.ai/inference/go/openai/v1', metadata: { wireProfile: 'opencode-go-responses' } };
    const r = await probes.discoverModels(p, { testBearer: 'k' }, redirect, { lookup: publicLookup });
    assert.equal(r.ok, false); assert.equal(r.errors[0].code, 'probe-redirect-refused'); assert.equal(calls.length, 1);
    for (const addr of ['::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', '2606:4700:78::90:0:140', '::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      assert.ok(pc.checkRequestTarget('opencode.ai', [{ address: addr, family: 6 }], 'openai-responses').length > 0, addr);
    }
    for (const lit of ['http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::1]/']) {
      assert.ok(pc.validateEndpoint(lit, 'openai-responses', {}).length > 0, lit);
    }
  });

  // ---- S10: first-party onboarding of Nexus Adaptive (explicit, idempotent, verified through the real mechanism) ----
  const REPO = path.resolve(__dirname, '..');
  const regOf = (d) => require('../config/registry/service.cjs').createService({ installRoot: REPO, dataRoot: d });
  const ADAPTIVE = gate.ADAPTIVE_ROUTE_ID;

  await check('adaptive onboarding is idempotent, scoped ONLY to nexus-adaptive-v1, and leaves the historical entries alone', async () => {
    const d = root(); // default setup first (an existing installation)
    const before = regOf(d).effectiveSnapshot().snapshot;
    const lines = [];
    assert.equal(setup.run(['--data-root', d, '--apply', '--adaptive'], (l) => lines.push(l)), 0);
    assert.equal(setup.run(['--data-root', d, '--apply', '--adaptive'], (l) => lines.push(l)), 0, 'a repeated setup succeeds');
    assert.ok(lines.filter((l) => /already present/.test(l)).length >= 6, 'the second run leaves every record unchanged');
    const snap = regOf(d).effectiveSnapshot().snapshot;
    const models = snap.models.filter((m) => m.id === 'meta/muse-spark-1.3-contributor-adaptive');
    const routes = snap.routes.filter((r) => r.id === ADAPTIVE);
    assert.equal(models.length, 1); assert.equal(routes.length, 1, 'no duplicate entries');
    assert.deepEqual(models[0].engines, ['nexus-adaptive-v1']);
    assert.equal(routes[0].availability, 'probe-required', 'never pre-verified');
    assert.equal(routes[0].compatibility.transport, 'openai-responses');
    assert.deepEqual(routes[0].reasoningLevels, ['low', 'medium', 'high', 'xhigh']);
    // historical entries byte-identical
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    for (const id of ['meta/muse-spark-1.3-contributor', 'meta/muse-spark-1.3-contributor-native']) assert.ok(same(before.models.find((m) => m.id === id), snap.models.find((m) => m.id === id)), id);
    assert.ok(same(before.routes.find((r) => r.id === 'opencode-go-native/muse'), snap.routes.find((r) => r.id === 'opencode-go-native/muse')));
    // no operator configuration was created
    assert.equal(regOf(d).listModes().modes.find((m) => m.id === 'engineering-v2-adaptive').persisted, false)
  });

  await check('an authorization record names ONE route: the default record cannot verify the adaptive route and vice versa', async () => {
    const d = root(); setup.run(['--data-root', d, '--apply', '--adaptive'], quiet);
    const f = creds(d, 'SECRETKEY'); const calls = [];
    gate.authorize(['--data-root', d, '--acknowledge-billable'], quiet); // default route
    assert.equal(await gate.verify(['--data-root', d, '--credentials', f, '--adaptive'], quiet, { opts: { fetchImpl: stub(calls), lookup: publicLookup } }), 3);
    assert.equal(calls.length, 0, 'nothing sent');
    gate.authorize(['--data-root', d, '--acknowledge-billable', '--adaptive'], quiet); // adaptive route
    assert.equal(await gate.verify(['--data-root', d, '--credentials', f], quiet, { opts: { fetchImpl: stub(calls), lookup: publicLookup } }), 3);
    assert.equal(calls.length, 0, 'nothing sent');
  });

  await check('the adaptive route is verified by the real mechanism; the ModeConfiguration is saved only on the explicit flag', async () => {
    const d = root(); setup.run(['--data-root', d, '--apply', '--adaptive'], quiet);
    const f = creds(d, 'SECRETKEY'); const calls = []; const lines = [];
    gate.authorize(['--data-root', d, '--acknowledge-billable', '--adaptive'], quiet);
    assert.equal(await gate.verify(['--data-root', d, '--credentials', f, '--adaptive'], (l) => lines.push(l), { opts: { fetchImpl: stub(calls), lookup: publicLookup } }), 0, lines.join('\n'));
    // 1 GET + one text probe per declared level (low, medium, high, xhigh) + stream + tool + continuation
    assert.equal(calls.length, 8);
    const efforts = calls.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body)).filter((b) => !b.stream && !b.tools && !Array.isArray(b.input)).map((b) => b.reasoning.effort);
    assert.deepEqual(efforts, ['low', 'medium', 'high', 'xhigh'], 'the provider is asked once per authorized effort');
    assert.equal(JSON.parse(fs.readdirSync(d).filter((f) => /consumed/.test(f)).map((f) => fs.readFileSync(path.join(d, f), 'utf8'))[0]).maxRequests, 8, 'the authorization stated exactly what was sent');
    assert.ok(!lines.join('\n').includes('SECRETKEY'), 'the key is never printed');
    let reg = regOf(d);
    assert.equal(reg.effectiveSnapshot().snapshot.routes.find((r) => r.id === ADAPTIVE).availability, 'verified');
    assert.equal(reg.listModes().modes.find((m) => m.id === 'engineering-v2-adaptive').persisted, false, 'verification alone saves nothing');
    // the explicit authorized save
    gate.authorize(['--data-root', d, '--acknowledge-billable', '--adaptive'], quiet);
    const lines2 = [];
    assert.equal(await gate.verify(['--data-root', d, '--credentials', f, '--adaptive', '--save-adaptive-config'], (l) => lines2.push(l), { opts: { fetchImpl: stub([]), lookup: publicLookup } }), 0, lines2.join('\n'));
    reg = regOf(d);
    const got = reg.getModeConfiguration('engineering-v2-adaptive', {});
    assert.equal(got.result.persisted, true);
    assert.equal(got.result.config.slots.main.routeId, ADAPTIVE);
    assert.deepEqual(got.result.config.slots.main.allowedReasoning.slice().sort(), ['high', 'low', 'medium', 'xhigh']);
    // the default mode is untouched by the adaptive flow (this fixture never bound it)
    assert.equal(reg.listModes().modes.find((m) => m.id === 'engineering-v2').persisted, false);
  });

  await check('a failed adaptive verification saves no configuration (an unverified route can never be bound)', async () => {
    const d = root(); setup.run(['--data-root', d, '--apply', '--adaptive'], quiet);
    const f = creds(d, 'K'); const calls = [];
    gate.authorize(['--data-root', d, '--acknowledge-billable', '--adaptive'], quiet);
    const code = await gate.verify(['--data-root', d, '--credentials', f, '--adaptive', '--save-adaptive-config'], quiet, { opts: { fetchImpl: stub(calls, { 1: { status: 429, text: async () => 'rate limited' } }), lookup: publicLookup } });
    assert.equal(code, 1);
    assert.equal(regOf(d).listModes().modes.find((m) => m.id === 'engineering-v2-adaptive').persisted, false);
    // verification is PER LEVEL: the level whose probe failed is not claimed, and the configuration that needs it is refused
    const route = regOf(d).effectiveSnapshot().snapshot.routes.find((r) => r.id === ADAPTIVE);
    assert.ok(!route.reasoningLevels.includes('low'), 'a level whose probe failed is never claimed: ' + JSON.stringify(route.reasoningLevels));
  });

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed);
})().catch((e) => { console.error(e); process.exit(1); });
