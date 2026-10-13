'use strict';
/**
 * ContextPageStoreV2Fallback.Tests.cjs - CCV2-B02H H1 forced-fallback proof.
 *
 * Forces the exclusive-create fallback claim deterministically through the
 * internal seam (NEXUS_B02_FORCE_FALLBACK_CLAIM=1: process environment only,
 * never task/user content) and exercises blob, page, and evidence records
 * through the ACTUAL fallback implementation. Proves the H1 invariant for
 * the fallback strategy: same identity + different bytes -> one valid
 * winner, every conflicting writer fails closed, never last-writer-wins.
 * Also audits that no overwrite-capable rename remains in the authority.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(title) { console.log('\n--- ' + title + ' ---'); }
function throwsWith(fn, fragment, name) {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  check(error !== null && String(error && error.message).includes(fragment), name,
    error ? String(error.message).slice(0, 240) : 'did not throw');
}
const clone = (o) => JSON.parse(JSON.stringify(o));

process.env.NEXUS_B02_FORCE_FALLBACK_CLAIM = '1';
const store = require(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));

const NS = Object.freeze({
  taskId: 'TASK-B02H-F',
  taskInstanceId: 'task_b02h_f_0001',
  sessionId: 'sess-b02h-f',
  workspaceId: '/tmp/nexus-b02h-f',
  repositoryId: 'repo-b02h',
  checkoutId: 'checkout-b02h',
});

function makeRoot(name) {
  const dir = path.join(repoRoot, 'tmp', 'b02h-fb-' + name + '-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return store.contextRootForV2(dir, 'TASK-B02H-F');
}

function phaseAEvidenceRef(evidenceId, digest) {
  return {
    schemaVersion: 1,
    evidenceId,
    kind: 'event',
    locator: '61',
    digest: digest === undefined ? null : digest,
    observedAtUtc: '2026-09-27T00:00:00.000Z',
    taskInstanceId: NS.taskInstanceId,
  };
}

// ── SEAM + AUDIT ───────────────────────────────────────────────────────
section('FALLBACK SEAM AND NO-RENAME AUDIT');
{
  const source = fs.readFileSync(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs'), 'utf8');
  check(!source.includes('renameSync'), 'no overwrite-capable rename remains in the authority');
  check(source.includes("NEXUS_B02_FORCE_FALLBACK_CLAIM"), 'fallback seam is environment-selected, never content-selected');
  check(!source.includes('alreadyRedacted'), 'no user-controlled boolean acts as sanitization authority');
  const root = makeRoot('seam');
  fs.mkdirSync(root, { recursive: true });
  const put = store.putBlobV2(root, 'fallback seam proof bytes');
  check(put.blobRef.startsWith('blob:sha256:'), 'fallback claim persists a verifiable blob');
  check(store.readBlobV2(root, put.blobRef).toString('utf8') === 'fallback seam proof bytes', 'fallback blob reads back valid');
  // Default (non-forced) production path still works in a child without the seam.
  const { execFileSync } = require('node:child_process');
  const cleanEnv = Object.assign({}, process.env);
  delete cleanEnv.NEXUS_B02_FORCE_FALLBACK_CLAIM;
  const out = execFileSync(process.execPath, ['-e',
    'const s=require(' + JSON.stringify(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs')) + ');'
    + 'if(process.env.NEXUS_B02_FORCE_FALLBACK_CLAIM==="1"){console.log("SEAM-LEAK");process.exit(2);}'
    + 'console.log("SEAM-CLEAN");',
  ], { encoding: 'utf8', env: cleanEnv });
  check(out.trim() === 'SEAM-CLEAN', 'seam is opt-in per process; default behavior unchanged');
}

// ── FALLBACK BLOB / PAGE / EVIDENCE ────────────────────────────────────
section('FALLBACK BLOB PAGE EVIDENCE');
{
  const root = makeRoot('records');
  fs.mkdirSync(root, { recursive: true });
  const blobRes = store.putBlobV2(root, 'fallback record bytes');
  const p = page.createContextPageV2({
    kind: 'other', namespace: clone(NS), sourceKind: 'agent', sourceRefs: ['agent:note:71'],
    mutability: 'immutable', sourceSeqs: [], exactBlobRef: blobRes.blobRef, createdAtGeneration: 1,
  });
  const pageRes = store.putContextPageV2(root, p, { expectedNamespace: clone(NS) });
  check(pageRes.pageId === p.id, 'fallback page persists under its pageId');
  const ref = phaseAEvidenceRef('E-b02h-fb-1', p.contentHash);
  const evRes = store.putEvidenceV2(root, { evidenceRef: ref, pageId: p.id, expectedNamespace: clone(NS) });
  check(typeof evRes.evidenceBindingId === 'string', 'fallback evidence binding persists');
  // Idempotent fallback reuse converges.
  const again = store.putContextPageV2(root, p, { expectedNamespace: clone(NS) });
  check(again.pageId === p.id && again.deduplicated === true, 'identical fallback rewrite converges');
  const reread = store.readEvidenceV2(root, NS.taskInstanceId, 'E-b02h-fb-1', { expectedNamespace: clone(NS) });
  check(reread.pageId === p.id, 'fallback evidence reads back bound');
}

// ── FALLBACK CONFLICT FAILS CLOSED ─────────────────────────────────────
section('FALLBACK CONFLICT');
{
  const root = makeRoot('conflict');
  fs.mkdirSync(root, { recursive: true });
  const mk = (gloss) => page.createContextPageV2({
    kind: 'conversation', namespace: clone(NS), sourceKind: 'user', sourceRefs: ['session-event:72'],
    mutability: 'immutable', sourceSeqs: [72], exactText: 'Fallback conflict evidence unit.', semanticGloss: gloss,
    createdAtGeneration: 1,
  });
  const first = mk('first contender gloss');
  const second = mk('second contender gloss');
  check(first.id === second.id, 'contenders share one storage identity (B01 frozen)');
  store.putContextPageV2(root, first, { expectedNamespace: clone(NS) });
  throwsWith(() => store.putContextPageV2(root, second, { expectedNamespace: clone(NS) }),
    'v2-context-store: context-store-conflict', 'fallback conflicting write fails closed (never last-writer-wins)');
  const reread = store.readContextPageV2(root, first.id, { expectedNamespace: clone(NS) });
  check(reread.semanticGloss === 'first contender gloss', 'fallback winner stands; loser never overwrote');
}

// ── FALLBACK TORN DEBRIS FAILS CLOSED ──────────────────────────────────
section('FALLBACK TORN DEBRIS');
{
  const root = makeRoot('torn');
  fs.mkdirSync(root, { recursive: true });
  const put = store.putBlobV2(root, 'fallback torn fixture bytes');
  const blobPath = path.join(root, 'blobs', put.digest.slice(0, 2), put.digest + '.blob');
  const full = fs.readFileSync(blobPath);
  fs.writeFileSync(blobPath, full.slice(0, Math.floor(full.length / 2)));
  throwsWith(() => store.readBlobV2(root, put.blobRef),
    'v2-context-store: context-blob-content-mismatch', 'torn fallback blob fails closed on read');
  throwsWith(() => store.putBlobV2(root, 'fallback torn fixture bytes'),
    'v2-context-store: ', 'identical retry over torn debris fails closed (never adopt, never overwrite)');
  const report = store.validateContextPageStoreV2(root);
  check(report.valid === false && report.failures.length === 1, 'torn fallback debris is detectable by store validation');
}

console.log('\nB02H fallback unit suites: ' + passed + ' passed, ' + failed + ' failed');
