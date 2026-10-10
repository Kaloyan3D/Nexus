'use strict';

// Registry R5.1 - native CLI authentication and billing safety.
// Deterministic: every CLI shape arrives through injected exec hooks.
// No real CLI is required (none is installed in this environment); the
// read-only live check asserts the honest cli-missing path instead.
// No model request is ever issued (only --version and auth status).
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

function fakeAuthHooks(o) {
  const opts = o || {};
  const calls = [];
  return {
    calls,
    statMeta(p) {
      if (opts.filePresent && p === '/fake-home/.claude/.credentials.json') return { exists: true, size: 2048, mtimeMs: 789 };
      return null;
    },
    execFile(cmd, args) {
      calls.push([cmd].concat(args || []).join(' '));
      if (cmd === 'claude' && args[0] === '--version') {
        if (opts.cliMissing) return Promise.resolve({ code: 1, stdout: '', stderr: '' });
        return Promise.resolve({ code: 0, stdout: '2.1.0 (Claude Code)', stderr: '' });
      }
      if (cmd === 'claude' && args[0] === 'auth' && args[1] === 'status') {
        return Promise.resolve({ code: opts.statusCode === undefined ? 0 : opts.statusCode, stdout: opts.statusStdout === undefined ? '{}' : opts.statusStdout, stderr: '' });
      }
      return Promise.resolve({ code: 1, stdout: '', stderr: '' });
    },
    execEnv() { return Object.assign({}, opts.execEnv || {}); },
  };
}

const SUBSCRIPTION_JSON = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' });
(async () => {
await check('R5.1 valid subscription login reports connected', async () => {
  const svc = svcOn(tmpDir('r51-sub-'));
  const hooks = fakeAuthHooks({ filePresent: true, statusStdout: SUBSCRIPTION_JSON });
  const out = await svc.checkConnection('conn-claude-code-subscription', { hooks, userHome: '/fake-home' });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'connected');
  assert.equal(out.detail.authState, 'subscription-confirmed');
  assert.ok(out.detail.billingSource.indexOf('claude-subscription') !== -1);
  assert.equal(out.detail.authSource, 'native-cli-status (claude auth status, JSON by default)');
  const again = svc.getConnections().connections.find((c) => c.id === 'conn-claude-code-subscription');
  assert.equal(again.status, 'connected');
});

await check('R5.1 whole-value plan signal confirms subscription', async () => {
  const out = await sub.checkClaudeConnection({ hooks: fakeAuthHooks({ statusStdout: JSON.stringify({ loggedIn: true, subscriptionType: 'pro' }) }), userHome: '/fake-home' });
  assert.equal(out.ok, true);
  assert.equal(out.detail.authState, 'subscription-confirmed');
});

await check('R5.1 missing CLI skips status probe and reports cli-missing', async () => {
  const hooks = fakeAuthHooks({ cliMissing: true, statusStdout: SUBSCRIPTION_JSON });
  const out = await sub.checkClaudeConnection({ hooks, userHome: '/fake-home' });
  assert.equal(out.ok, false);
  assert.equal(out.status, 'not-connected');
  assert.ok(codes(out.errors).indexOf('claude-cli-missing') !== -1);
  assert.ok(!hooks.calls.some((c) => c.indexOf('auth status') !== -1), 'no status probe without a CLI');
});

await check('R5.1 expired login is expired, never connected', async () => {
  for (const payload of [JSON.stringify({ status: 'expired' }), JSON.stringify({ loggedIn: true, expired: true })]) {
    const out = await sub.checkClaudeConnection({ hooks: fakeAuthHooks({ filePresent: true, statusStdout: payload }), userHome: '/fake-home' });
    assert.equal(out.ok, false);
    assert.equal(out.detail.authState, 'expired');
    assert.ok(codes(out.errors).indexOf('claude-session-expired') !== -1);
  }
});

await check('R5.1 revoked login maps to revoked status', async () => {
  const out = await sub.checkClaudeConnection({ hooks: fakeAuthHooks({ statusStdout: JSON.stringify({ status: 'revoked' }) }), userHome: '/fake-home' });
  assert.equal(out.ok, false);
  assert.equal(out.status, 'revoked');
  assert.ok(codes(out.errors).indexOf('claude-session-revoked') !== -1);
});

await check('R5.1 stale file metadata never reports connected', async () => {
  const out = await sub.checkClaudeConnection({ hooks: fakeAuthHooks({ filePresent: true, statusStdout: JSON.stringify({ status: 'expired' }) }), userHome: '/fake-home' });
  assert.equal(out.ok, false);
  assert.equal(out.detail.sessionFileObserved, true);
  assert.equal(out.detail.authState, 'expired');
});

await check('R5.1 valid login without the assumed file still connects', async () => {
  const hooks = fakeAuthHooks({ statusStdout: SUBSCRIPTION_JSON });
  let statCalls = 0;
  const counting = Object.assign({}, hooks, { statMeta(p) { statCalls++; return hooks.statMeta(p); } });
  const out = await sub.checkClaudeConnection({ hooks: counting, userHome: '/fake-home' });
  assert.equal(out.ok, true);
  assert.equal(out.detail.sessionFileObserved, false);
  assert.equal(out.detail.authState, 'subscription-confirmed');
});

await check('R5.1 API-key identity is not a subscription', async () => {
  const out = await sub.checkClaudeConnection({ hooks: fakeAuthHooks({ statusStdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key' }) }), userHome: '/fake-home' });
  assert.equal(out.ok, false);
  assert.equal(out.detail.authState, 'api-key-identity');
  assert.ok(codes(out.errors).indexOf('claude-apikey-identity') !== -1);
  const billed = await sub.runClaudeAgent({ prompt: 'x' }, { hooks: { execEnv() { return { ANTHROPIC_API_KEY: 'k' }; }, spawnEvents() { throw new Error('must not spawn'); } } });
  assert.ok(codes(billed.errors).indexOf('billing-boundary') !== -1);
});

await check('R5.1 environment billing overrides fail closed per source', () => {
  const bedrock = sub.checkBillingSeparation({ CLAUDE_CODE_USE_BEDROCK: '1' }, {});
  assert.equal(bedrock.ok, false);
  assert.ok(codes(bedrock.errors).indexOf('billing-boundary') !== -1);
  const bedrockOpt = sub.checkBillingSeparation({ CLAUDE_CODE_USE_BEDROCK: '1' }, { allowAlternateProvider: true });
  assert.equal(bedrockOpt.ok, true);
  const vertex = sub.checkBillingSeparation({ CLAUDE_CODE_USE_VERTEX: 'true' }, { allowApiBilling: true });
  assert.equal(vertex.ok, false, 'API opt-in does not cover cloud routing');
  const endpoint = sub.checkBillingSeparation({ ANTHROPIC_BASE_URL: 'https://proxy.example/v1' }, {});
  assert.equal(endpoint.ok, false);
  const endpointOpt = sub.checkBillingSeparation({ ANTHROPIC_BASE_URL: 'https://proxy.example/v1' }, { allowApiBilling: true });
  assert.equal(endpointOpt.ok, true);
  const clean = sub.checkBillingSeparation({}, {});
  assert.equal(clean.ok, true);
  assert.equal(clean.billingSource, 'claude-subscription');
  const missing = sub.checkBillingSeparation(null, {});
  assert.equal(missing.ok, false);
  assert.ok(codes(missing.errors).indexOf('billing-unverifiable') !== -1);
});

await check('R5.1 malformed and oversize status JSON stay unknown', async () => {
  const bad = await sub.checkClaudeConnection({ hooks: fakeAuthHooks({ statusStdout: 'not-json{{{' }), userHome: '/fake-home' });
  assert.equal(bad.ok, false);
  assert.ok(codes(bad.errors).indexOf('claude-status-unparseable') !== -1);
  const arr = await sub.checkClaudeConnection({ hooks: fakeAuthHooks({ statusStdout: '[1,2]' }), userHome: '/fake-home' });
  assert.ok(codes(arr.errors).indexOf('claude-status-unparseable') !== -1);
  let big = '';
  for (let i = 0; i < 70000; i++) big += 'x';
  const over = await sub.checkClaudeConnection({ hooks: fakeAuthHooks({ statusStdout: big }), userHome: '/fake-home' });
  assert.ok(codes(over.errors).indexOf('claude-status-oversize') !== -1);
});

await check('R5.1 secret-bearing status output is withheld', async () => {
  const out = await sub.checkClaudeConnection({ hooks: fakeAuthHooks({ statusStdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', token: 'sk-ant-abc123XYZ' }) }), userHome: '/fake-home' });
  assert.equal(out.ok, false);
  assert.ok(codes(out.errors).indexOf('secret-material-rejected') !== -1);
});

await check('R5.1 ambiguous authenticated session stays source-unestablished', async () => {
  const out = await sub.checkClaudeConnection({ hooks: fakeAuthHooks({ statusStdout: JSON.stringify({ loggedIn: true }) }), userHome: '/fake-home' });
  assert.equal(out.ok, false);
  assert.equal(out.detail.authState, 'source-unestablished');
  assert.ok(codes(out.errors).indexOf('claude-auth-source-unknown') !== -1);
});

await check('R5.1 login/logout/status argv compatibility', () => {
  assert.deepEqual(sub.buildClaudeAuthArgv('login'), ['auth', 'login']);
  assert.deepEqual(sub.buildClaudeAuthArgv('logout'), ['auth', 'logout']);
  assert.deepEqual(sub.buildClaudeAuthArgv('status'), ['auth', 'status']);
  assert.deepEqual(sub.buildClaudeAuthArgv('other'), ['auth', 'status']);
});

await check('R5.1 adapter uses the real child env, refuses when unestablished', async () => {
  let spawned = false;
  const noEnvHooks = { spawnEvents() { spawned = true; return Promise.resolve({ code: 0, stdout: '', stderr: '' }); } };
  const refused = await sub.runClaudeAgent({ prompt: 'x' }, { hooks: noEnvHooks });
  assert.equal(spawned, false);
  assert.ok(codes(refused.errors).indexOf('billing-unverifiable') !== -1);
  const live = await sub.runClaudeAgent({ prompt: 'hi', cwd: '/repo', taskId: 't-9' }, {
    hooks: {
      execEnv() { return {}; },
      spawnEvents(bin, argv, opts) {
        assert.equal(bin, 'claude');
        assert.equal(opts.cwd, '/repo');
        return Promise.resolve({ code: 0, stdout: '{"type":"result","text":"ok"}\n', stderr: '' });
      },
    },
  });
  assert.equal(live.ok, true);
  assert.equal(live.billingEnvSource, 'child-process');
  assert.equal(live.billingSource, 'claude-subscription');
  const legacy = await sub.runClaudeAgent({ prompt: 'hi' }, {
    hooks: { spawnEvents() { return Promise.resolve({ code: 0, stdout: '{"type":"result"}\n', stderr: '' }); } },
    env: {},
  });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.billingEnvSource, 'caller-provided');
});

await check('R5.1 Linux and Windows CLI detection parity in helpers', () => {
  const ps = fs.readFileSync(path.join(repoRoot, 'scripts', 'Common.ps1'), 'utf8');
  assert.ok(ps.indexOf('claude.exe') !== -1, 'windows executable candidates');
  assert.ok(ps.indexOf('APPDATA') !== -1, 'windows npm global location');
  assert.ok(ps.indexOf('.npm-global') !== -1, 'posix npm global location');
  assert.ok(ps.indexOf('Get-Command') !== -1, 'PATH fallback on every OS');
  assert.ok(ps.indexOf('auth status') !== -1, 'native status probe');
  assert.ok(ps.indexOf('--output json') === -1, 'no assumed output flag');
  assert.ok(ps.indexOf('auth login') === -1 && ps.indexOf('auth logout') === -1, 'helpers never trigger login/logout themselves (read-only probes)');
  const setPs = fs.readFileSync(path.join(repoRoot, 'scripts', 'Set-ClaudeSubscription.ps1'), 'utf8');
  assert.ok(setPs.indexOf('auth login') !== -1, 'connect uses native login');
  const discPs = fs.readFileSync(path.join(repoRoot, 'scripts', 'Disconnect-ClaudeSubscription.ps1'), 'utf8');
  assert.ok(discPs.indexOf('auth logout') !== -1, 'disconnect uses native logout');
  const env = sub.defaultHooks().execEnv();
  assert.ok(env && typeof env === 'object', 'live child-process env snapshot (Linux executed here)');
});

await check('R5.1 read-only live check degrades honestly without a CLI', async () => {
  const svc = svcOn(tmpDir('r51-live-'));
  const out = await svc.checkConnection('conn-claude-code-subscription', { userHome: os.homedir() });
  assert.equal(out.ok, false);
  assert.ok(codes(out.errors).indexOf('claude-cli-missing') !== -1, JSON.stringify(codes(out.errors)));
  assert.equal(out.status, 'not-connected');
});

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failed + ' | total ' + (passed + failed));
  if (failed > 0) {
    console.log('FAILURES:\n' + failures.join('\n'));
    process.exitCode = 1;
  }
})().catch((e) => { console.error('SUITE CRASH: ' + ((e && e.stack) || e)); process.exitCode = 1; });
