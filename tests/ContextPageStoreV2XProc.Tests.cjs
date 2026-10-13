'use strict';
/**
 * ContextPageStoreV2XProc.Tests.cjs - B02 cross-process atomicity proof.
 *
 * Independent OS processes (real node children, no in-process doubles)
 * contend on the REAL production authority:
 *
 *   concurrent same blob    -> one valid blob, all converge on one blobRef
 *   concurrent same page    -> one durable canonical page, all converge
 *   concurrent conflicting  -> at most one identity interpretation wins,
 *                              losers fail closed, never last-writer-wins
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const store = require(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs'));
const WORKER = path.join(__dirname, 'ContextPageStoreV2XProc.Worker.cjs');

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
  taskId: 'TASK-B02-X',
  taskInstanceId: 'task_b02_x_0001',
  sessionId: 'sess-b02-x',
  workspaceId: '/tmp/nexus-b02-x',
  repositoryId: 'repo-b02',
  checkoutId: 'checkout-b02',
});

function makeRoot(name) {
  const dir = path.join(repoRoot, 'tmp', 'b02-xproc-' + name + '-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return store.contextRootForV2(dir, 'TASK-B02-X');
}

function runContenders(root, op, count) {
  const dir = path.join(root, '..', 'xproc-' + op);
  fs.mkdirSync(dir, { recursive: true });
  const go = path.join(dir, 'go.signal');
  try { fs.unlinkSync(go); } catch { /* fresh barrier */ }
  const children = [];
  for (let id = 0; id < count; id += 1) {
    const out = path.join(dir, 'result-' + id + '.json');
    const child = spawn(process.execPath, [
      WORKER, '--root', root, '--op', op, '--id', String(id), '--go', go, '--out', out,
    ], { stdio: 'ignore' });
    children.push({ child, out });
  }
  fs.writeFileSync(go, 'go');
  return Promise.all(children.map(({ child, out }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker timeout ' + out)), 60000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(fs.readFileSync(out, 'utf8')));
      } catch (e) { reject(e); }
    });
  })));
}

async function main() {
  section('CONCURRENT SAME BLOB');
  {
    const root = makeRoot('blob');
    fs.mkdirSync(root, { recursive: true });
    const results = await runContenders(root, 'put-blob', 4);
    check(results.every((r) => r.ok === true), 'all blob contenders converge without corruption');
    const refs = new Set(results.map((r) => r.blobRef));
    check(refs.size === 1, 'all processes converge on the same blobRef');
    const ref = results[0].blobRef;
    check(store.readBlobV2(root, ref).toString('utf8').includes('xproc shared fixture'), 'converged blob reads back valid');
    check(store.hasBlobV2(root, ref) === true, 'converged blob verifies');
  }

  section('CONCURRENT SAME PAGE');
  {
    const root = makeRoot('page');
    fs.mkdirSync(root, { recursive: true });
    const results = await runContenders(root, 'put-page', 4);
    check(results.every((r) => r.ok === true), 'all page contenders converge without corruption');
    check(new Set(results.map((r) => r.pageId)).size === 1, 'all processes converge on one durable page');
    check(new Set(results.map((r) => r.pageRecordDigest)).size === 1, 'all processes converge on one record digest');
    const reread = store.readContextPageV2(root, results[0].pageId, { expectedNamespace: clone(NS) });
    check(reread.semanticGloss === 'shared contender gloss', 'converged page reads back canonical');
  }

  section('CONCURRENT CONFLICTING PAGE');
  {
    const root = makeRoot('conflict');
    fs.mkdirSync(root, { recursive: true });
    const results = await runContenders(root, 'put-conflict-page', 4);
    const winners = results.filter((r) => r.ok === true);
    const losers = results.filter((r) => r.ok !== true);
    check(winners.length === 1, 'exactly one identity interpretation wins (' + winners.length + ' won)');
    check(losers.length === 3 && losers.every((r) => String(r.error).includes('context-store-conflict')),
      'every loser fails closed on conflict (never last-writer-wins)');
    const pageId = winners[0].pageId;
    const reread = store.readContextPageV2(root, pageId, { expectedNamespace: clone(NS) });
    check(reread.semanticGloss === winners[0].gloss, 'durable record matches the single winner');
    const report = store.validateContextPageStoreV2(root, { expectedNamespace: clone(NS) });
    check(report.valid === true && report.pagesValid === 1, 'conflict aftermath is one valid record');
  }

  console.log('\nB02 XProc suites: ' + passed + ' passed, ' + failed + ' failed');
}

main().catch((error) => {
  console.error('XPROC-FATAL ' + String(error && error.stack || error));
  process.exit(1);
});
