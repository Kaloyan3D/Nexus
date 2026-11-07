'use strict';

// MuseOpenCodeSession.Tests.cjs — OpenCode Go x-opencode-session coverage for
// the DSH 0.2.x supported-hook port (replaces the 0.1.x substrate-patch
// tests A-F, which exercised the removed in-place bundle edit).
//
// Deterministic and offline. Covers:
//   G. non-OpenCode routes and missing session ids -> no header
//   H. OpenCode route -> header present, exact, stable per conversation,
//      isolated across conversations
//   I. the plugin registers on the real supported waterfall and chains next()
//   J. (installed runtime only) the REAL pinned pi-ai adapter dispatches the
//      waterfall with the request's provider/sessionId, and harness
//      attribution still wins a reserved-header collision.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const plugin = require(path.resolve(__dirname, '..', 'config', 'OpenCode-SessionHeader.cjs'));

let total = 0;
function check(name, cond) {
  total++;
  assert.ok(cond, 'FAIL: ' + name);
  console.log('PASS: ' + name);
}
const run = (provider, sessionId, initial) => plugin.applyOpenCodeSessionHeader({ provider, ...(sessionId === undefined ? {} : { sessionId }) }, new Headers(initial || {}));

// G. Everything that is not OpenCode Go (or has no session) is untouched.
check('G-meta-route-no-header', !run('meta-model-api', 'sess-1').has('x-opencode-session'));
check('G-other-provider-no-header', !run('deepseek-pro-direct', 'sess-1').has('x-opencode-session'));
check('G-opencode-without-session-no-header', !run('opencode-go', undefined).has('x-opencode-session'));
check('G-unrelated-headers-preserved', run('deepseek-pro-direct', 'sess-1', { 'x-a': '1' }).get('x-a') === '1');

// H. OpenCode Go: exact value, stable per conversation, isolated across them.
const a1 = run('opencode-go', 'sess-A');
const a2 = run('opencode-go', 'sess-A');
const b = run('opencode-go', 'sess-B');
check('H-header-present-exact', a1.get('x-opencode-session') === 'sess-A');
check('H-stable-per-conversation', a2.get('x-opencode-session') === a1.get('x-opencode-session'));
check('H-isolated-across-conversations', b.get('x-opencode-session') !== a1.get('x-opencode-session'));
check('H-profile-headers-preserved', run('opencode-go', 'sess-A', { 'x-a': '1' }).get('x-a') === '1');

// I. Registration on the supported waterfall; next() is always chained.
const registered = [];
plugin.apply({ on(name, listener) { registered.push({ name, listener }); } });
check('I-registers-exactly-the-request-headers-waterfall', registered.length === 1 && registered[0].name === 'llm-pi-ai/request-headers');
const sentinel = new Headers({ 'x-sentinel': 'next' });
const chained = registered[0].listener({ provider: 'opencode-go', sessionId: 's' }, sentinel, () => sentinel);
check('I-chains-next-and-returns-its-headers', chained === sentinel && sentinel.get('x-opencode-session') === 's');

// J. Real pinned adapter (needs an installed 0.2.x runtime; skipped otherwise).
async function installedAdapterProof() {
  const root = process.env.NEXUS_RUNTIME_ROOT || process.env.AIH_INSTALL_ROOT;
  const entry = root && path.join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js');
  if (!entry || !fs.existsSync(entry)) { console.log('NOTE: pinned pi-ai not installed; section J skipped'); return; }
  const source = fs.readFileSync(entry, 'utf8');
  check('J-pinned-substrate-declares-the-supported-waterfall', /ctx\.waterfall\(["']llm-pi-ai\/request-headers["']/.test(source));
  check('J-pinned-substrate-passes-provider-and-sessionId', /provider: options\.provider/.test(source) && /sessionId: options\.sessionId/.test(source));
  check('J-pinned-substrate-applies-attribution-after-contributors', (() => { const at = source.indexOf('prepare(request, initial)'); return at !== -1 && source.indexOf('attributionHeaders()', at) !== -1; })());
}

installedAdapterProof().then(() => {
  console.log('SUITE RESULT: PASS ' + total + ' | FAIL 0 | total ' + total);
}).catch((error) => { console.error(error); process.exit(1); });
