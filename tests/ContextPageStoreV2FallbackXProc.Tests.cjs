'use strict';
/**
 * ContextPageStoreV2FallbackXProc.Tests.cjs - CCV2-B02H H1.3/H1.4 proof.
 *
 * Independent OS processes contend through the ACTUAL exclusive-create
 * fallback implementation (children spawn with NEXUS_B02_FORCE_FALLBACK_CLAIM=1
 * in process environment; the strategy is never content-selected). Reuses the
 * production worker (tests/ContextPageStoreV2XProc.Worker.cjs) unchanged:
 * identical writers must converge on one identity; conflicting writers must
 * yield exactly one durable interpretation; restart must identify the same
 * winner. No timing oracle: the seam selects the implementation for the
 * whole child process before any write.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

const FALLBACK_ENV = Object.assign({}, process.env, { NEXUS_B02_FORCE_FALLBACK_CLAIM: '1' });

function makeRoot(name) {
  const dir = path.join(repoRoot, 'tmp', 'b02h-fbx-' + name + '-' + process.pid);
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
    ], { stdio: 'ignore', env: FALLBACK_ENV });
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
  section('FALLBACK CONCURRENT SAME BLOB');
  {
    const root = makeRoot('blob');
    fs.mkdirSync(root, { recursive: true });
    const results = await runContenders(root, 'put-blob', 4);
    check(results.every((r) => r.ok === true), 'all fallback blob contenders converge without corruption');
    check(new Set(results.map((r) => r.blobRef)).size === 1, 'fallback processes converge on the same blobRef');
    check(store.hasBlobV2(root, results[0].blobRef) === true, 'fallback converged blob verifies');
  }

  section('FALLBACK CONCURRENT SAME PAGE');
  {
    const root = makeRoot('page');
    fs.mkdirSync(root, { recursive: true });
    const results = await runContenders(root, 'put-page', 4);
    check(results.every((r) => r.ok === true), 'all fallback page contenders converge without corruption');
    check(new Set(results.map((r) => r.pageId)).size === 1, 'fallback processes converge on one durable page');
    const reread = store.readContextPageV2(root, results[0].pageId, { expectedNamespace: clone(NS) });
    check(reread.semanticGloss === 'shared contender gloss', 'fallback converged page reads back canonical');
  }

  section('FALLBACK CONCURRENT CONFLICTING PAGE');
  {
    const root = makeRoot('conflict');
    fs.mkdirSync(root, { recursive: true });
    const results = await runContenders(root, 'put-conflict-page', 4);
    const winners = results.filter((r) => r.ok === true);
    const losers = results.filter((r) => r.ok !== true);
    check(winners.length === 1, 'fallback: exactly one identity interpretation wins (' + winners.length + ' won)');
    check(losers.length === 3 && losers.every((r) => String(r.error).includes('context-store-conflict')),
      'fallback: every loser fails closed (never last-writer-wins)');
    const firstRead = store.readContextPageV2(root, winners[0].pageId, { expectedNamespace: clone(NS) });
    check(firstRead.semanticGloss === winners[0].gloss, 'fallback durable record matches the single winner');
    // Restart: drop module state and prove the same winner resolves.
    for (const key of Object.keys(require.cache)) {
      if (key === __filename) continue;
      delete require.cache[key];
    }
    const store2 = require(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs'));
    const secondRead = store2.readContextPageV2(root, winners[0].pageId, { expectedNamespace: clone(NS) });
    check(secondRead.semanticGloss === winners[0].gloss, 'restart identifies the same fallback winner');
    const report = store2.validateContextPageStoreV2(root, { expectedNamespace: clone(NS) });
    check(report.valid === true && report.pagesValid === 1, 'fallback conflict aftermath is one valid record');
  }

  console.log('\nB02H fallback XProc suites: ' + passed + ' passed, ' + failed + ' failed');
}

main().catch((error) => {
  console.error('XPROC-FATAL ' + String(error && error.stack || error));
  process.exit(1);
});
