'use strict';

// Registry R5 - subscription connections and Claude subscription agent.
// Covers: built-in Codex/Claude/OpenCode records, legacy specialization
// stability, snapshot validity, overlay persistence without secrets,
// billing separation, adapter bounds (timeout/cancel/streaming), and the
// R5 host endpoints. Offline; injected hooks only; no real CLI required.
// Live-CLI verification status is recorded in
// docs/integration/claude-subscription-r5.md (binary absent in this env).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const registry = require('../config/registry/index.cjs');
const serviceModule = registry.service;
const sub = registry.subscriptions;

delete process.env.DSH_HOME;
delete process.env.AIH_INSTALL_ROOT;

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

// --- fake hooks: metadata only, loopback model list, fake CLI ---
function fakeHooks(o) {
  const opts = o || {};
  return {
    statMeta(p) {
      if (opts.codexPresent && p === '/fake-home/.codex/auth.json') return { exists: true, size: 4242, mtimeMs: 123 };
      if (opts.claudePresent && p === '/fake-home/.claude/.credentials.json') return { exists: true, size: 1337, mtimeMs: 456 };
      return null;
    },
    execFile(cmd, args) {
      if (opts.claudePresent && cmd === 'claude' && args[0] === '--version') {
        return Promise.resolve({ code: 0, stdout: '2.1.0 (Claude Code)', stderr: '' });
      }
      if (opts.claudePresent && cmd === 'claude' && args[0] === 'auth' && args[1] === 'status') {
        return Promise.resolve({ code: 0, stdout: JSON.stringify({ authenticated: true, method: 'oauth', plan: 'max' }), stderr: '' });
      }
      if (opts.claudePresent && cmd === 'claude' && args[0] === '--help') {
        return Promise.resolve({ code: 0, stdout: 'Usage: claude [options]\n  --model <name>  Model choice: "sonnet" or "opus"\n', stderr: '' });
      }
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    },
    fetchJson(url) {
      if (opts.codexService && /\/models$/.test(url)) {
        return Promise.resolve({ status: 200, body: { data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.7' }] } });
      }
      return Promise.resolve({ status: 0, error: 'unreachable' });
    },
  };
}

(async () => {
await check('R5 built-in Claude records validate and merge idempotently', () => {
  const built = sub.claudeBuiltinRecords();
  assert.deepEqual(registry.schemas.validateProvider(built.provider, 'p'), []);
  assert.deepEqual(registry.schemas.validateLogicalModel(built.model, 'm'), []);
  assert.deepEqual(registry.schemas.validateConnection(built.connection, 'c'), []);
  assert.deepEqual(registry.schemas.validateModelRoute(built.route, 'r'), []);
  assert.equal(built.route.availability, 'auth-required');
  assert.deepEqual(built.model.engines, []);
  const svc = svcOn(tmpDir('r5-builtin-'));
  const snap = svc.effectiveSnapshot().snapshot;
  assert.ok(snap.providers.some((p) => p.id === 'claude-code-subscription'));
  assert.ok(snap.models.some((m) => m.id === 'claude-subscription-agent'));
  assert.ok(snap.connections.some((c) => c.id === 'conn-claude-code-subscription'));
  assert.ok(snap.routes.some((r) => r.id === 'claude-code-subscription/claude-subscription-agent'));
  assert.deepEqual(registry.schemas.validateRegistrySnapshot(snap, 'reg'), []);
});

await check('R5 Codex integration is distinguished from official delegation', () => {
  const svc = svcOn(tmpDir('r5-codex-'));
  const snap = svc.effectiveSnapshot().snapshot;
  const conn = snap.connections.find((c) => c.id === 'conn-sol-local');
  assert.equal(conn.connectionKind, 'subscription-delegated');
  assert.ok(conn.authMethod.indexOf('NOT official Sign in with ChatGPT delegation') !== -1);
  assert.ok(conn.authMethod.indexOf('third-party openai-oauth') !== -1);
  const route = snap.routes.find((x) => x.id === 'sol-local/gpt-5.6-sol');
  assert.equal(route.accessType, 'subscription-delegated');
  assert.equal(route.availability, 'verified', 'existing executability preserved');
  assert.equal(route.executionKind, 'raw-model');
  const provider = snap.providers.find((p) => p.id === 'sol-local');
  assert.equal(provider.transportId, 'local-openai-compatible');
  // Existing EMv1 config still compiles with the reviewer on sol-local.
  const cfg = svc.getModeConfiguration('engineering-v1', {}).result.config;
  assert.deepEqual(svc.validate(cfg).errors, []);
  const compiled = svc.compilePreview(cfg);
  assert.equal(compiled.ok, true);
  assert.equal(compiled.snapshot.roles.reviewer.providerId, 'sol-local');
});

await check('R5 OpenCode Go stays an honest api-key record', () => {
  const svc = svcOn(tmpDir('r5-opencode-'));
  const snap = svc.effectiveSnapshot().snapshot;
  const conn = snap.connections.find((c) => c.id === 'conn-opencode-go');
  assert.equal(conn.connectionKind, 'api-key');
  const provider = snap.providers.find((p) => p.id === 'opencode-go');
  assert.equal(provider.transportId, 'openai-responses');
  const described = sub.describeConnection('conn-opencode-go');
  assert.equal(described.billingSource, 'opencode-api-key');
  assert.equal(described.supportsCheck, false, 'no server-side credential boundary: checks stay credential-gated');
});

await check('R5 Codex live check: metadata plus model list, no token reads', async () => {
  const svc = svcOn(tmpDir('r5-codexcheck-'));
  const hooks = fakeHooks({ codexPresent: true, codexService: true });
  let statPaths = [];
  const watching = Object.assign({}, hooks, { statMeta(p) { statPaths.push(p); return hooks.statMeta(p); } });
  const out = await svc.checkConnection('conn-sol-local', { hooks: watching, userHome: '/fake-home' });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'connected');
  assert.deepEqual(out.detail.models, ['gpt-5.6-sol', 'gpt-5.7']);
  assert.ok(statPaths.indexOf('/fake-home/.codex/auth.json') !== -1);
  // Overlay persisted the non-secret status.
  const again = svc.getConnections().connections.find((c) => c.id === 'conn-sol-local');
  assert.equal(again.status, 'connected');
  const overlayRaw = fs.readFileSync(path.join(svc.dataRoot, 'registry', 'connection-status.json'), 'utf8');
  assert.ok(overlayRaw.indexOf('connected') !== -1);
  assert.ok(!/sk-|eyJ|token/i.test(overlayRaw.replace(/connection-status/g, '')), 'overlay holds no secret-shaped material');
});

await check('R5 Codex live check fails closed when auth file is missing', async () => {
  const svc = svcOn(tmpDir('r5-codexmiss-'));
  const out = await svc.checkConnection('conn-sol-local', { hooks: fakeHooks({}), userHome: '/fake-home' });
  assert.equal(out.ok, false);
  assert.ok(codes(out.errors).indexOf('codex-auth-missing') !== -1);
});

await check('R5 Claude check: installed plus session metadata, tokens never read', async () => {
  const svc = svcOn(tmpDir('r5-claudecheck-'));
  const hooks = fakeHooks({ claudePresent: true });
  const out = await svc.checkConnection('conn-claude-code-subscription', { hooks, userHome: '/fake-home' });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'connected');
  assert.equal(out.detail.version, '2.1.0 (Claude Code)');
  assert.equal(out.detail.authState, 'subscription-confirmed');
  assert.equal(out.detail.sessionFileObserved, true);
  assert.ok(!('token' in out.detail), 'no token field exists on the hook surface');
  const again = svc.getConnections().connections.find((c) => c.id === 'conn-claude-code-subscription');
  assert.equal(again.status, 'connected');
});

await check('R5 Claude check reports cli-missing honestly without a binary', async () => {
  const svc = svcOn(tmpDir('r5-claudemiss-'));
  const out = await svc.checkConnection('conn-claude-code-subscription', { hooks: fakeHooks({}), userHome: '/fake-home' });
  assert.equal(out.ok, false);
  assert.ok(codes(out.errors).indexOf('claude-cli-missing') !== -1, JSON.stringify(codes(out.errors)));
});

await check('R5 Claude discovery uses native help hints, invents no proxy models', async () => {
  const svc = svcOn(tmpDir('r5-claudedisc-'));
  const out = await svc.discoverConnectionModels('conn-claude-code-subscription', { hooks: fakeHooks({ claudePresent: true }) });
  assert.equal(out.ok, true);
  assert.equal(out.capabilities.executionKind, 'agent-sdk');
  assert.equal(out.capabilities.billingSource, 'claude-subscription');
  assert.ok(out.capabilities.models.indexOf('sonnet') !== -1, JSON.stringify(out.capabilities.models));
  assert.ok(out.capabilities.engineeringMode.indexOf('pending-r6') !== -1);
});

await check('R5 billing guard refuses silent API billing', () => {
  const blocked = sub.checkBillingSeparation({ ANTHROPIC_API_KEY: 'sk-ant-real-looking-key' }, {});
  assert.equal(blocked.ok, false);
  assert.ok(codes(blocked.errors).indexOf('billing-boundary') !== -1);
  const opted = sub.checkBillingSeparation({ ANTHROPIC_API_KEY: 'sk-ant-real-looking-key' }, { allowApiBilling: true });
  assert.equal(opted.ok, true);
  assert.ok(opted.billingSource.indexOf('explicit opt-in') !== -1);
  const clean = sub.checkBillingSeparation({}, {});
  assert.equal(clean.ok, true);
  assert.equal(clean.billingSource, 'claude-subscription');
});

await check('R5 adapter: argv contract, task identity, session continuity', async () => {
  const argv = sub.buildClaudeArgv({ prompt: 'fix it', cwd: '/repo', taskId: 't-1', maxTurns: 3, resumeSessionId: 'sess-9', allowedTools: ['Read', 'Bash'] });
  assert.ok(argv.indexOf('--print') !== -1);
  assert.ok(argv.indexOf('stream-json') !== -1);
  assert.ok(argv.indexOf('--resume') !== -1 && argv.indexOf('sess-9') !== -1);
  assert.ok(argv.indexOf('--max-turns') !== -1 && argv.indexOf('3') !== -1);
  let seen = null;
  const hooks = {
    spawnEvents(bin, args, opts) {
      seen = { bin, args, opts };
      return Promise.resolve({ code: 0, stdout: '{"type":"system","session_id":"sess-10"}\n{"type":"result","text":"done"}\n', stderr: '' });
    },
  };
  const out = await sub.runClaudeAgent({ prompt: 'fix it', cwd: '/repo', taskId: 't-1' }, { hooks, env: {} });
  assert.equal(out.ok, true);
  assert.equal(seen.bin, 'claude');
  assert.equal(seen.opts.cwd, '/repo');
  assert.equal(out.sessionId, 'sess-10');
  assert.ok(out.events.every((e) => e.taskId === 't-1'), 'every event carries the caller task identity');
  assert.equal(out.billingSource, 'claude-subscription');
});

await check('R5 adapter: cancellation, timeout, exit codes and secret scan', async () => {
  const cancelled = await sub.runClaudeAgent({ prompt: 'x' }, { hooks: { spawnEvents: () => Promise.resolve({ cancelled: true }) }, env: {} });
  assert.equal(cancelled.ok, false);
  assert.ok(codes(cancelled.errors).indexOf('claude-cancelled') !== -1);
  const timedOut = await sub.runClaudeAgent({ prompt: 'x' }, { hooks: { spawnEvents: () => Promise.resolve({ timedOut: true }) }, env: {} });
  assert.ok(codes(timedOut.errors).indexOf('claude-timeout') !== -1);
  const exited = await sub.runClaudeAgent({ prompt: 'x' }, { hooks: { spawnEvents: () => Promise.resolve({ code: 1, stdout: '', stderr: 'boom' }) }, env: {} });
  assert.ok(codes(exited.errors).indexOf('claude-exit-1') !== -1);
  const secreted = await sub.runClaudeAgent({ prompt: 'x' }, { hooks: { spawnEvents: () => Promise.resolve({ code: 0, stdout: '{"type":"result","text":"sk-ant-secret-key-material-here"}\n', stderr: '' }) }, env: {} });
  assert.equal(secreted.ok, false);
  assert.ok(codes(secreted.errors).indexOf('secret-material-rejected') !== -1);
  const billed = await sub.runClaudeAgent({ prompt: 'x' }, { hooks: { spawnEvents: () => { throw new Error('must not spawn'); } }, env: { ANTHROPIC_API_KEY: 'sk-ant-abc' } });
  assert.ok(codes(billed.errors).indexOf('billing-boundary') !== -1);
});

await check('R5 R4 gates intact: operator subscription and agent routes refused', () => {
  const svc = svcOn(tmpDir('r5-gates-'));
  const sub2 = svc.saveConnection({ id: 'c9', providerId: 'sol-local', connectionKind: 'subscription-agent', credentialRef: 'credential://connections/c9', status: 'not-connected' }, {});
  assert.equal(sub2.ok, false, 'manual subscription onboarding stays refused');
  const prov = svc.saveProvider({ id: 'x', name: 'X', transportId: 'openai-responses', baseUrl: 'https://x.example/v1', authType: 'subscription-agent' }, {});
  assert.equal(prov.ok, false, 'manual subscription providers stay refused');
  const other = svc.checkConnection('conn-opencode-go', {});
  return other.then((o) => {
    assert.equal(o.ok, false);
    assert.ok(codes(o.errors).indexOf('connection-check-unsupported') !== -1);
  });
});

await check('R5 host endpoints: list, check, discover, secret rejection', async () => {
  const adapter = require('../ui/nexus-controller/lib/registry.cjs');
  const svc = svcOn(tmpDir('r5-host-'));
  const handlers = adapter.createRegistryHandlers(svc, { userHome: '/fake-home' });
  assert.equal(typeof handlers.connectionsHandler, 'function');
  assert.equal(typeof handlers.connectionCheckHandler, 'function');
  assert.equal(typeof handlers.connectionDiscoverHandler, 'function');
  function req(method, url, body) {
    const { Readable } = require('node:stream');
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const stream = new Readable({ read() { for (const c of chunks) this.push(c); this.push(null); } });
    stream.method = method;
    stream.url = url;
    stream.headers = { host: '127.0.0.1:3080' };
    return stream;
  }
  function res() {
    let resolveDone;
    const done = new Promise((r2) => { resolveDone = r2; });
    const r2 = { statusCode: 0, bodyText: '', writeHead(c) { r2.statusCode = c; }, end(t) { r2.bodyText = String(t); resolveDone(); } };
    r2.done = done;
    return r2;
  }
  const r1 = res();
  await handlers.connectionsHandler(req('GET', '/nexus/registry/v1/connections/list'), r1);
  await r1.done;
  assert.equal(r1.statusCode, 200);
  const list = JSON.parse(r1.bodyText);
  assert.equal(list.ok, true);
  const ids = list.connections.map((c) => c.id);
  assert.ok(ids.indexOf('conn-sol-local') !== -1 && ids.indexOf('conn-claude-code-subscription') !== -1 && ids.indexOf('conn-opencode-go') !== -1);
  const claude = list.connections.find((c) => c.id === 'conn-claude-code-subscription');
  assert.equal(claude.billingSource, 'claude-subscription');
  assert.ok(claude.connectCommand.indexOf('claude auth login') !== -1);
  // Secret-shaped caller fields are rejected; userHome/claudeBin never come from the caller.
  const r2 = res();
  await handlers.connectionCheckHandler(req('POST', '/x', { id: 'conn-sol-local', apiKey: 'sk-live-abc' }), r2);
  await r2.done;
  assert.equal(r2.statusCode, 400);
  assert.ok(r2.bodyText.indexOf('secret-material-rejected') !== -1);
  const r3 = res();
  await handlers.connectionCheckHandler(req('POST', '/x', { id: 'conn-sol-local', userHome: '/etc' }), r3);
  await r3.done;
  assert.equal(r3.statusCode, 400);
});

await check('R5 UI smoke: Connections panel renders check/discover guidance', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'ui', 'nexus-controller', 'lib', 'client.js'), 'utf8');
  for (const label of ['Connections (Registry)', 'Check Connection', 'Discover Models', 'Connect: ', 'Disconnect: ']) {
    assert.ok(source.indexOf(label) !== -1, 'connections panel content present: ' + label);
  }
  assert.ok(sub.describeConnection('conn-claude-code-subscription').connectCommand.indexOf('claude auth login') !== -1, 'claude connect guidance present');
  assert.ok(sub.describeConnection('conn-sol-local').capabilitiesNote.indexOf('NOT the official Sign in with ChatGPT delegation') !== -1, 'codex distinction present');
});

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failed + ' | total ' + (passed + failed));
  if (failed > 0) {
    console.log('FAILURES:\n' + failures.join('\n'));
    process.exitCode = 1;
  }
})().catch((e) => { console.error('SUITE CRASH: ' + ((e && e.stack) || e)); process.exitCode = 1; });
