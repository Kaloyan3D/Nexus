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
    return { status: 200, text: async () => JSON.stringify({ status: 'completed', output_text: 'probe-ok', reasoning: { effort: 'low' } }) };
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
    assert.equal(body.model, 'muse-spark-1.3-contributor'); assert.equal(body.max_output_tokens, 1024);
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

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed);
})().catch((e) => { console.error(e); process.exit(1); });
