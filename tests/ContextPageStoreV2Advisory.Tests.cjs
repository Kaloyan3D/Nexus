'use strict';
/**
 * ContextPageStoreV2Advisory.Tests.cjs - CCV2-B02H H3 advisory determinism.
 *
 * Freezes advisory revision identity against the REAL production authority:
 * three advisory records (A1/A2/A3) for one page prove the core page bytes,
 * pageId, and contentHash never move, each advisory is immutable and
 * explicitly addressable by its digest, and restart resolves identically.
 * Proves no recency authority exists: no mtime/ctime/directory-order
 * selection anywhere in the authority, and no "current advisory" pointer or
 * listing API is introduced (B02 reads exactly the addressed record).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const store = require(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(title) { console.log('\n--- ' + title + ' ---'); }
const clone = (o) => JSON.parse(JSON.stringify(o));

const NS = Object.freeze({
  taskId: 'TASK-B02H-D',
  taskInstanceId: 'task_b02h_d_0001',
  sessionId: 'sess-b02h-d',
  workspaceId: '/tmp/nexus-b02h-d',
  repositoryId: 'repo-b02h',
  checkoutId: 'checkout-b02h',
});

function makeRoot(name) {
  const dir = path.join(repoRoot, 'tmp', 'b02h-adv-' + name + '-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return store.contextRootForV2(dir, 'TASK-B02H-D');
}

// ── H3.1 NO RECENCY AUTHORITY ──────────────────────────────────────────
section('NO RECENCY AUTHORITY');
{
  const source = fs.readFileSync(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs'), 'utf8');
  for (const token of ['mtime', 'ctime', 'birthtime', 'mtimeMs']) {
    check(!source.includes(token), 'authority never consults filesystem recency (' + token + ')');
  }
  // Directory walks exist only for sorted validation counting; resolution
  // always addresses an exact digest, never a listing position.
  check(source.includes("'.tmp-'"), 'temp debris is name-matched, never authority-selected');
  check(typeof store.readCurrentAdvisoryV2 === 'undefined', 'no current-advisory pointer API exists');
  check(typeof store.listAdvisoriesV2 === 'undefined', 'no advisory listing/selection API exists');
  check(typeof store.latestAdvisoryV2 === 'undefined', 'no latest-advisory heuristic API exists');
}

// ── H3.2/H3.3 MULTI-ADVISORY DETERMINISM ───────────────────────────────
section('MULTI-ADVISORY DETERMINISM');
{
  const root = makeRoot('multi');
  fs.mkdirSync(root, { recursive: true });
  const p = page.createContextPageV2({
    kind: 'conversation', namespace: clone(NS), sourceKind: 'user', sourceRefs: ['session-event:91'],
    mutability: 'immutable', sourceSeqs: [91], exactText: 'Advisory determinism evidence unit.',
    semanticGloss: 'Core gloss.', createdAtGeneration: 1,
  });
  store.putContextPageV2(root, p, { expectedNamespace: clone(NS) });
  const corePath = path.join(root, 'pages', p.id.slice(4, 6), p.id + '.json');
  const coreBefore = fs.readFileSync(corePath, 'utf8');

  const a1 = store.updatePageAdvisoryV2(root, p.id, { semanticGloss: 'First observation.', tags: ['a1'] }, { expectedNamespace: clone(NS) });
  const a2 = store.updatePageAdvisoryV2(root, p.id, { semanticGloss: 'Second observation.', tags: ['a2'], lastNeededAtGeneration: 2 }, { expectedNamespace: clone(NS) });
  const a3 = store.updatePageAdvisoryV2(root, p.id, { semanticGloss: 'Third observation.', tags: ['a3'], lastNeededAtGeneration: 5 }, { expectedNamespace: clone(NS) });
  check(new Set([a1.advisoryDigest, a2.advisoryDigest, a3.advisoryDigest]).size === 3, 'A1/A2/A3 carry distinct revision digests');

  check(fs.readFileSync(corePath, 'utf8') === coreBefore, 'core ContextPage bytes unchanged by three advisory writes');
  const core = store.readContextPageV2(root, p.id, { expectedNamespace: clone(NS) });
  check(core.id === p.id && core.contentHash === p.contentHash, 'pageId and contentHash unchanged');
  check(core.semanticGloss === 'Core gloss.', 'core advisory text is not overlaid by derived records');

  const r1 = store.readPageAdvisoryV2(root, p.id, a1.advisoryDigest, { expectedNamespace: clone(NS) });
  const r2 = store.readPageAdvisoryV2(root, p.id, a2.advisoryDigest, { expectedNamespace: clone(NS) });
  const r3 = store.readPageAdvisoryV2(root, p.id, a3.advisoryDigest, { expectedNamespace: clone(NS) });
  check(r1.advisory.semanticGloss === 'First observation.' && r1.advisory.tags.join(',') === 'a1', 'A1 explicitly addressable and immutable');
  check(r2.advisory.semanticGloss === 'Second observation.' && r2.advisory.lastNeededAtGeneration === 2, 'A2 body carries its own fields including generation');
  check(r3.advisory.tags.join(',') === 'a3', 'A3 explicitly addressable and immutable');
  check(r1.pageId === p.id && r2.contentHash === p.contentHash && r3.contentHash === p.contentHash, 'every advisory binds core identity');

  // Restart: identical resolution with no memory.
  for (const key of Object.keys(require.cache)) {
    if (key === __filename) continue;
    delete require.cache[key];
  }
  const store2 = require(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs'));
  const s1 = store2.readPageAdvisoryV2(root, p.id, a1.advisoryDigest, { expectedNamespace: clone(NS) });
  const s3 = store2.readPageAdvisoryV2(root, p.id, a3.advisoryDigest, { expectedNamespace: clone(NS) });
  check(s1.advisoryDigest === a1.advisoryDigest && s3.advisoryDigest === a3.advisoryDigest, 'restart yields identical advisory resolution');
  check(JSON.stringify(s1.advisory) === JSON.stringify(r1.advisory), 'restart advisory bytes identical');
  const report = store2.validateContextPageStoreV2(root, { expectedNamespace: clone(NS) });
  check(report.valid === true && report.advisoryValid === 3 && report.pagesValid === 1, 'store validates core plus three advisories');
}

console.log('\nB02H advisory suites: ' + passed + ' passed, ' + failed + ' failed');
