'use strict';

// Registry R5.1.1 - Claude CLI contract compatibility (red-first suite).
// Native vocabulary: loggedIn, authMethod, subscriptionType, apiProvider.
// JSON output is the DEFAULT of (auth status): no --output flag is sent.
// Only an explicit native subscription signal reports connected; the words
// oauth/pro/subscription alone never imply it. No live CLI here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const sub = require('../config/registry/index.cjs').subscriptions;

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
function codes(errors) { return (errors || []).map((e) => (e && e.code) || ''); }
function parse(obj) { return sub.parseClaudeAuthStatus(JSON.stringify(obj)); }

(async () => {
await check('R5.1.1 native claude.ai login with loggedIn confirms subscription', async () => {
  const out = await sub.checkClaudeConnection({ hooks: {
    statMeta() { return null; },
    execFile(cmd, args) {
      if (args[0] === '--version') return Promise.resolve({ code: 0, stdout: '2.1.0 (Claude Code)', stderr: '' });
      return Promise.resolve({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), stderr: '' });
    },
  }, userHome: '/fake-home' });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'connected');
  assert.equal(out.detail.authState, 'subscription-confirmed');
});

await check('R5.1.1 explicit loggedIn:false always rejects, even claude.ai', () => {
  const p = parse({ loggedIn: false, authMethod: 'claude.ai' });
  assert.equal(p.outcome, 'unauthenticated');
  assert.ok(codes(p.errors).indexOf('claude-session-missing') !== -1);
});

await check('R5.1.1 missing login flag with subscription-looking method stays unknown', () => {
  const p = parse({ authMethod: 'oauth' });
  assert.equal(p.outcome, 'unknown');
  assert.ok(codes(p.errors).indexOf('claude-auth-source-unknown') !== -1);
});

await check('R5.1.1 api_key, helper, third_party and none are not subscriptions', () => {
  const key = parse({ loggedIn: true, authMethod: 'api_key' });
  assert.equal(key.outcome, 'api-key');
  const helper = parse({ loggedIn: true, authMethod: 'api_key_helper' });
  assert.equal(helper.outcome, 'api-key');
  const third = parse({ loggedIn: true, authMethod: 'third_party' });
  assert.equal(third.outcome, 'alternate');
  const none = parse({ loggedIn: true, authMethod: 'none' });
  assert.equal(none.outcome, 'unauthenticated');
});

await check('R5.1.1 oauth_token alone never implies Pro/Max', () => {
  const p = parse({ loggedIn: true, authMethod: 'oauth_token' });
  assert.equal(p.outcome, 'unknown');
  const typed = parse({ loggedIn: true, authMethod: 'oauth_token', subscriptionType: 'max' });
  assert.equal(typed.outcome, 'subscription');
});

await check('R5.1.1 alternate apiProvider is not a subscription', () => {
  const p = parse({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'bedrock' });
  assert.equal(p.outcome, 'alternate');
});

await check('R5.1.1 unknown and malformed sources stay unknown', () => {
  const u = parse({ loggedIn: true });
  assert.equal(u.outcome, 'unknown');
  const m = parse({ loggedIn: true, authMethod: 'frobnicator-9000' });
  assert.equal(m.outcome, 'unknown');
  assert.ok(codes(m.errors).indexOf('claude-auth-source-unknown') !== -1);
});

await check('R5.1.1 status vector is the bare native command', () => {
  assert.deepEqual(sub.buildClaudeAuthArgv('status'), ['auth', 'status']);
  assert.deepEqual(sub.buildClaudeAuthArgv('login'), ['auth', 'login']);
  assert.deepEqual(sub.buildClaudeAuthArgv('logout'), ['auth', 'logout']);
});

await check('R5.1.1 JS/PowerShell classification parity on native vocabulary', () => {
  const ps = fs.readFileSync(path.join(repoRoot, 'scripts', 'Common.ps1'), 'utf8');
  for (const token of ['loggedIn', 'authMethod', 'subscriptionType', 'apiProvider', 'claude.ai', 'api_key_helper', 'third_party', 'oauth_token']) {
    assert.ok(ps.indexOf(token) !== -1, 'PS classifier handles native token: ' + token);
  }
  assert.ok(ps.indexOf('auth status') !== -1, 'PS uses the native status command');
  assert.ok(ps.indexOf('--output json') === -1, 'PS sends no assumed output flag');
  const js = fs.readFileSync(path.join(repoRoot, 'config', 'registry', 'subscription-connections.cjs'), 'utf8');
  assert.ok(js.indexOf('--output') === -1 || js.indexOf("['auth', 'status']") !== -1, 'JS sends the bare native vector');
});

await check('R5.1.1 Windows PowerShell 5.1 syntax compatibility', () => {
  function stripPsStrings(line) { return line.split('\x27').filter(function(_, idx) { return idx % 2 === 0; }).join(''); }
  for (const f of ['Common.ps1', 'Set-ClaudeSubscription.ps1', 'Test-ClaudeConnection.ps1', 'Disconnect-ClaudeSubscription.ps1']) {
    const ps = fs.readFileSync(path.join(repoRoot, 'scripts', f), 'utf8');
    const lines = ps.split('\n');
    for (const line of lines) {
      const code = stripPsStrings(line);
      assert.ok(code.indexOf('?') === -1, 'no PS7-only ? syntax (ternary, ?. , ??) in ' + f + ': ' + line.slice(0, 100));
    }
  }
});

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failed + ' | total ' + (passed + failed));
  if (failed > 0) {
    console.log('FAILURES:\n' + failures.join('\n'));
    process.exitCode = 1;
  }
})().catch((e) => { console.error('SUITE CRASH: ' + ((e && e.stack) || e)); process.exitCode = 1; });
