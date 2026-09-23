'use strict';

// MuseOpenCodeSession.Tests.cjs — TASK-0008/TASK-0009 regression coverage.
//
// Deterministic and offline: every case runs against fixtures (no installed
// files, no network, no key). Covers the TASK-0009 deployment matrix:
//   A. fresh install -> patch applied
//   B. upgrade/reinstall -> still exactly one patch
//   C. double apply -> idempotent
//   D. remove -> byte-exact original restoration
//   E. incompatible substrate fixture -> fail closed
//   F. partial-edit fixture -> fail closed (both directions)
//   G. Meta behavior -> no x-opencode-session header
//   H. OpenCode behavior -> x-opencode-session wiring present and stable
// G/H execute the REAL requestHeaders merge logic extracted from the patched
// artifact text plus the artifact-coupled provider predicate.

const assert = require('node:assert/strict');
const path = require('node:path');

const patch = require(path.resolve(__dirname, '..', 'scripts', 'Apply-OpenCodeSessionPatch.cjs'));

let total = 0;
function check(name, cond) {
  total++;
  assert.ok(cond, 'FAIL: ' + name);
  console.log('PASS: ' + name);
}

// The real substrate shape (copied verbatim from the pinned
// dsh-llm-pi-ai/lib/index.js requestHeaders block + call site).
function substrateExcerpt() {
  return [
    '/** Merge deployment headers while removing case-insensitive attribution collisions. */',
    'function requestHeaders(headers) {',
    '\tconst attribution = attributionHeaders();',
    '\tconst reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()));',
    '\treturn {',
    '\t\t...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),',
    '\t\t...attribution',
    '\t};',
    '}',
    'async *streamWithSnapshot(options, snapshot) {',
    '\t\t\t\t\t...options.sessionId === void 0 ? {} : { sessionId: String(options.sessionId) },',
    '\t\t\t\t\tsignal: watchdog.signal,',
    '\t\t\t\t\theaders: requestHeaders(profile.headers)',
    '}',
  ].join('\n');
}

function markerCount(source) {
  return source.split(patch.MARKER).length - 1;
}

// A. Fresh install -> patch applied.
const pristine = substrateExcerpt();
check('A-status-absent-on-fresh-substrate', patch.statusOf(pristine) === 'absent');
const first = patch.applyPatch(pristine);
check('A-apply-changes-fresh-substrate', first.changed === true);
check('A-status-applied', patch.statusOf(first.source) === 'applied');
check('A-exactly-one-marker', markerCount(first.source) === 1);

// B. Upgrade/reinstall -> still exactly one patch.
const second = patch.applyPatch(first.source);
check('B-reapply-is-noop', second.changed === false && second.source === first.source);
check('B-still-exactly-one-marker', markerCount(second.source) === 1);

// C. Double apply -> idempotent (same bytes, one patch).
const third = patch.applyPatch(second.source);
check('C-double-apply-stable', third.source === first.source && markerCount(third.source) === 1);

// D. Remove -> byte-exact original restoration.
const reverted = patch.removePatch(first.source);
check('D-remove-restores-bytes', reverted.changed === true && reverted.source === pristine);
check('D-status-absent-after-remove', patch.statusOf(reverted.source) === 'absent');
check('D-remove-noop-when-absent', patch.removePatch(pristine).changed === false);

// E. Incompatible/changed substrate fixture -> fail closed, input untouched.
const incompatible = pristine.replace('function requestHeaders(headers) {', 'function requestHeaders2(headers) {');
let eThrew = false;
try { patch.applyPatch(incompatible); } catch { eThrew = true; }
check('E-incompatible-anchor-fails-closed', eThrew === true);
check('E-incompatible-input-untouched', incompatible === pristine.replace('function requestHeaders(headers) {', 'function requestHeaders2(headers) {'));
const missingCallSite = pristine.replace('headers: requestHeaders(profile.headers)', 'headers: mergeHeaders(profile.headers)');
let e2Threw = false;
try { patch.applyPatch(missingCallSite); } catch { e2Threw = true; }
check('E-missing-call-site-fails-closed', e2Threw === true);

// F. Partial-edit fixture -> fail closed in both directions.
const partialState = first.source.replace(patch.MARKER, '');
check('F-fixture-is-partial', patch.statusOf(partialState) === 'partial');
let fApplyThrew = false;
try { patch.applyPatch(partialState); } catch (e) { fApplyThrew = /partial/.test(String((e && e.message) || e)); }
check('F-partial-apply-fails-closed', fApplyThrew === true);
let fRemoveThrew = false;
try { patch.removePatch(partialState); } catch (e) { fRemoveThrew = /partial/.test(String((e && e.message) || e)); }
check('F-partial-remove-fails-closed', fRemoveThrew === true);

// G/H. Execute the REAL merge logic from the patched artifact text.
// The call-site provider predicate, coupled to the artifact string.
const PREDICATE = "options.provider === 'opencode-go' && options.sessionId !== void 0";
check('H-predicate-present-in-artifact', first.source.includes(PREDICATE));
check('H-header-name-present-in-artifact', first.source.includes("'x-opencode-session': String(options.sessionId)"));
function extraFor(provider, sessionId) {
  return provider === 'opencode-go' && sessionId !== void 0
    ? { 'x-opencode-session': String(sessionId) }
    : void 0;
}
const fnMatch = first.source.match(/function requestHeaders\(headers, extra\) \{[\s\S]*?\n\}/);
check('H-merge-function-extractable', fnMatch !== null);
const attributionHeaders = () => ({ 'user-agent': 'nexus-test/1' });
const requestHeaders = eval('(' + fnMatch[0].replace(/^function requestHeaders/, 'function') + ')');
void attributionHeaders;
// G. Meta behavior: extra resolves to void 0 -> header absent.
check('G-meta-extra-is-void', extraFor('meta-model-api', 'sess-1') === void 0);
check('G-meta-headers-absent', !('x-opencode-session' in requestHeaders({}, extraFor('meta-model-api', 'sess-1'))));
check('G-meta-no-session-absent', !('x-opencode-session' in requestHeaders({}, extraFor('meta-model-api', void 0))));
check('G-other-provider-absent', !('x-opencode-session' in requestHeaders({}, extraFor('deepseek-pro-direct', 'sess-1'))));
// H. OpenCode behavior: header present, exact value, stable, isolated.
const hA1 = requestHeaders({}, extraFor('opencode-go', 'sess-A'));
const hA2 = requestHeaders({}, extraFor('opencode-go', 'sess-A'));
const hB = requestHeaders({}, extraFor('opencode-go', 'sess-B'));
check('H-opencode-header-present', hA1['x-opencode-session'] === 'sess-A');
check('H-opencode-stable-per-conversation', hA2['x-opencode-session'] === hA1['x-opencode-session']);
check('H-opencode-isolated-across-conversations', hB['x-opencode-session'] !== hA1['x-opencode-session']);
check('H-opencode-no-session-no-header', !('x-opencode-session' in requestHeaders({}, extraFor('opencode-go', void 0))));
// Attribution still wins reserved collisions through the patched merge.
const colliding = requestHeaders({}, { 'User-Agent': 'evil', 'x-opencode-session': 'sess-A' });
check('H-attribution-wins-reserved', colliding['user-agent'] === 'nexus-test/1');
check('H-nonreserved-extra-preserved', colliding['x-opencode-session'] === 'sess-A');

console.log('SUITE RESULT: PASS ' + total + ' | FAIL 0 | total ' + total);
