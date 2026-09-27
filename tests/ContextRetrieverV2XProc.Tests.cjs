'use strict';
/**
 * ContextRetrieverV2XProc.Tests.cjs - CCV2-C03 cross-process determinism proof.
 *
 * Spawns independent OS processes (tests/ContextRetrieverV2XProc.Worker.cjs)
 * that rebuild the same derived index and run the same retrieval request
 * through the REAL production authorities with no shared module state.
 * Proves: simultaneous retrievers return byte-identical results (same
 * result digest, same canonical bytes, same index id), restart-fresh
 * processes agree with in-process retrieval, and the JSON fixture crosses
 * processes untouched. No store authority is needed: the fixture uses
 * identity-only file/symbol/lexical routes over validated B01 pages.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const retriever = require(path.join(repoRoot, 'config', 'ContextRetrieverV2.cjs'));
const evidenceIndex = require(path.join(repoRoot, 'config', 'ContextEvidenceIndexV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log('' + title + ''); }
const clone = (o) => JSON.parse(JSON.stringify(o));
const NS = Object.freeze({
  taskId: 'TASK-C03-X',
  taskInstanceId: 'task_c03_x_0001',
  sessionId: 'sess-c03-x',
  workspaceId: '/tmp/nexus-c03-x',
  repositoryId: 'repo-c03-x',
  checkoutId: 'checkout-c03-x',
});
let seq = 5000;
function nextSeq() { seq += 1; return seq; }
function mkPage(text, extra) {
  return page.createContextPageV2(Object.assign({
    kind: 'other',
    namespace: clone(NS),
    sourceKind: 'agent',
    sourceRefs: ['agent:note:xproc'],
    mutability: 'immutable',
    sourceSeqs: [nextSeq()],
    exactText: text,
    createdAtGeneration: 1,
  }, extra || {}));
}
function runWorker(inFile, goFile, outFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(repoRoot, 'tests', 'ContextRetrieverV2XProc.Worker.cjs'),
      '--in', inFile, '--go', goFile, '--out', outFile,
    ], { stdio: 'ignore' });
    child.on('close', () => {
      try {
        resolve(JSON.parse(fs.readFileSync(outFile, 'utf8')));
      } catch (e) {
        resolve({ ok: false, error: 'worker output unreadable: ' + String(e).slice(0, 120) });
      }
    });
    child.on('error', (e) => resolve({ ok: false, error: 'spawn failed: ' + String(e).slice(0, 120) }));
  });
}
async function main() {
  section('CROSS-PROCESS RETRIEVAL DETERMINISM');
  const dir = path.join(repoRoot, 'tmp', 'c03-xproc-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const pages = [
    mkPage('xproc canary service handler', { files: ['xproc/svc.ts'], symbols: ['xprocFn'], tags: ['xproc'] }),
    mkPage('xproc canary retry policy note', { tags: ['xproc', 'canary'] }),
    mkPage('Грешка при удостоверяване на потребителя', { tags: ['грешка'] }),
    mkPage('Morning notes from the café', { tags: ['café'] }),
    mkPage('υπολογισμός σφάλμα', { tags: ['σφάλμα'] }),
    mkPage('日本語', { tags: ['cjk'] }),
    mkPage('Die Straße ist gesperrt', { tags: ['straße'] }),
    mkPage('unrelated filler paragraph', { tags: ['filler'] }),
  ];
  const inFile = path.join(dir, 'fixture.json');
  fs.writeFileSync(inFile, JSON.stringify({ namespace: clone(NS), pages }));
  const goFile = path.join(dir, 'go.barrier');
  const out1 = path.join(dir, 'out1.json');
  const out2 = path.join(dir, 'out2.json');
  const pending = [runWorker(inFile, goFile, out1), runWorker(inFile, goFile, out2)];
  fs.writeFileSync(goFile, 'go');
  const [r1, r2] = await Promise.all(pending);
  check(r1.ok === true, 'worker 1 retrieved without refusal', r1.error);
  check(r2.ok === true, 'worker 2 retrieved without refusal', r2.error);
  if (r1.ok && r2.ok) {
    check(r1.indexId === r2.indexId, 'independent processes rebuild the same index id');
    check(r1.resultDigest === r2.resultDigest, 'independent processes agree on the result digest');
    check(r1.resultCanonical === r2.resultCanonical, 'independent processes return byte-identical results');
  }
  const index = evidenceIndex.buildEvidenceIndexV2({ namespace: clone(NS), pages: pages.slice() });
  const local = retriever.retrieveContextEvidenceV2({
    namespace: clone(NS),
    exactEvidenceIds: [],
    exactPageIds: [],
    fileIdentities: [{ path: 'xproc/svc.ts' }],
    symbolIdentities: [{ symbol: 'xprocFn' }],
    lexicalTerms: ['xproc', 'canary', 'грешка', 'café', 'σφάλμα', '日本語', 'потребител', 'straße'],
    limit: 10,
    mode: 'identity-only',
    evidenceIndex: index,
    pages: pages.slice(),
  });
  const localCanonical = retriever.canonicalizeRetrievalResultV2(local);
  if (r1.ok) {
    check(r1.resultCanonical === localCanonical, 'restart-fresh process agrees with in-process retrieval');
    check(r1.indexId === index.indexId, 'worker index id matches the local derived index');
  }
  check(local.results.length > 0 && local.errors.length === 0, 'local retrieval returns results with no errors');
  check(retriever.validateRetrievalResultV2(local).valid === true, 'local result validates');
  console.log('\nC03-XPROC-RESULT passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.log('FAIL: xproc harness crashed :: ' + String(e).slice(0, 200)); process.exit(1); });
