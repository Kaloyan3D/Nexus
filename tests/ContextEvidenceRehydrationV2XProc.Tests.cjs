'use strict';
/**
 * ContextEvidenceRehydrationV2XProc.Tests.cjs - CCV2-B03 cross-process proof.
 *
 * Spawns independent OS processes (tests/ContextEvidenceRehydrationV2XProc.Worker.cjs)
 * that resolve the same known evidence through the REAL production authority
 * with no shared module state. Proves: simultaneous readers return identical
 * verified evidence (digests, identities, routes), restart-fresh processes
 * agree with in-process reads, and concurrent reads mutate zero durable
 * bytes (read-only across processes, no lock-based mutation on read paths).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const store = require(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const rehydrate = require(path.join(repoRoot, 'config', 'ContextEvidenceRehydrationV2.cjs'));

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(title) { console.log('\n--- ' + title + ' ---'); }

const NS = Object.freeze({
  taskId: 'TASK-B03-X',
  taskInstanceId: 'task_b03_x_0001',
  sessionId: 'sess-b03-x',
  workspaceId: '/tmp/nexus-b03-x',
  repositoryId: 'repo-b03-x',
  checkoutId: 'checkout-b03-x',
});
const clone = (o) => JSON.parse(JSON.stringify(o));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function makeDir(name) {
  const dir = path.join(repoRoot, 'tmp', 'b03-xproc-' + name + '-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function snapshotStoreBytes(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (e.isFile() && !e.name.includes('.tmp-')) out.push(f + ':' + sha256(fs.readFileSync(f)));
    }
  };
  walk(root);
  return out.sort().join('\n');
}

function spawnReaders(list) {
  const procs = list.map((item) => {
    const args = ['--root', item.root, '--op', item.op, '--id', String(item.id),
      '--ns', item.nsFile, '--go', item.goFile, '--out', item.outFile];
    if (item.op === 'read-page') args.push('--page', item.pageId);
    else args.push('--ref', item.ref);
    return { item, proc: spawn(process.execPath, [path.join(__dirname, 'ContextEvidenceRehydrationV2XProc.Worker.cjs')].concat(args), { stdio: 'ignore' }) };
  });
  fs.writeFileSync(list[0].goFile, 'go');
  // Block until every worker result lands (bounded wait).
  const deadline = Date.now() + 30000;
  let pending = true;
  while (pending && Date.now() < deadline) {
    pending = list.some((item) => !fs.existsSync(item.outFile));
    if (pending) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  check(!pending, 'every worker result landed before the deadline');
  for (const { proc } of procs) {
    try { proc.kill(); } catch { /* reaped */ }
  }
  return list.map((item) => JSON.parse(fs.readFileSync(item.outFile, 'utf8')));
}

section('cross-process identical verified reads');
{
  const dir = makeDir('readers');
  const root = store.contextRootForV2(path.join(dir, 'ws'), NS.taskId);
  fs.mkdirSync(root, { recursive: true });
  const persisted = store.persistEvidenceV2(root, {
    expectedNamespace: clone(NS),
    pageInput: {
      kind: 'requirement', namespace: clone(NS), sourceKind: 'user', sourceRefs: ['session-event:3'],
      mutability: 'immutable', sourceSeqs: [3], exactText: 'XProc shared exact evidence unit.',
      createdAtGeneration: 1,
    },
    evidenceRef: {
      schemaVersion: 1, evidenceId: 'E-b03-xproc-001', kind: 'event', locator: '3', digest: null,
      observedAtUtc: '2026-09-27T00:00:00.000Z', taskInstanceId: NS.taskInstanceId,
    },
  });
  const nsFile = path.join(dir, 'ns.json');
  fs.writeFileSync(nsFile, JSON.stringify(clone(NS)));
  const goFile = path.join(dir, 'go');
  const before = snapshotStoreBytes(root);
  const inProcess = rehydrate.rehydrateContextPageV2({ contextRoot: root, pageId: persisted.pageId, expectedNamespace: clone(NS) });

  const list = [];
  for (let i = 0; i < 6; i += 1) {
    list.push({
      root, op: i % 2 === 0 ? 'read-page' : 'read-ref', id: i, nsFile, goFile,
      outFile: path.join(dir, 'out-' + i + '.json'),
      pageId: persisted.pageId, ref: NS.taskInstanceId + ':E-b03-xproc-001',
    });
  }
  const results = spawnReaders(list);
  check(results.length === 6, 'all six readers reported');
  for (const r of results) {
    check(r.ok === true && r.verified === true, 'reader ' + r.id + ' verified (' + r.op + ')');
    check(r.pageId === persisted.pageId, 'reader ' + r.id + ' resolves the same page');
    check(r.contentHash === inProcess.contentHash, 'reader ' + r.id + ' agrees on contentHash');
    check(r.resultDigest === inProcess.resultDigest, 'reader ' + r.id + ' agrees on resultDigest');
    check(r.sourceIdentity === inProcess.sourceIdentity, 'reader ' + r.id + ' agrees on sourceIdentity');
  }
  const after = snapshotStoreBytes(root);
  check(before === after, 'concurrent cross-process reads mutate zero durable bytes');
}

console.log('\nB03 XPROC: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
