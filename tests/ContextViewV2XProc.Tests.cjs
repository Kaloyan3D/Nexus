'use strict';
/**
 * ContextViewV2XProc.Tests.cjs - CCV2-C01 cross-process determinism proof.
 *
 * Spawns independent OS processes (tests/ContextViewV2XProc.Worker.cjs)
 * that compile the same canonical fixture through the REAL production
 * authority with no shared module state. Proves: simultaneous compilers
 * return byte-identical canonical views (same id, same digest, same
 * bytes), restart-fresh processes agree with in-process reads, and the
 * fixture input crosses processes untouched. No filesystem authority is
 * needed beyond temporary JSON fixtures: proofs (branded B03 results)
 * never cross processes, so the XProc fixture uses durably self-backed
 * COLD material only.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const view = require(path.join(repoRoot, 'config', 'ContextViewV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const tier = require(path.join(repoRoot, 'config', 'ContextMemoryTierV2.cjs'));
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const snapshot = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log('' + title + ''); }
const clone = (o) => JSON.parse(JSON.stringify(o));
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const NS = Object.freeze({
  taskId: 'TASK-C01-X',
  taskInstanceId: 'task_c01_x_0001',
  sessionId: 'sess-c01-x',
  workspaceId: '/tmp/nexus-c01-x',
  repositoryId: 'repo-c01-x',
  checkoutId: 'checkout-c01-x',
});
function makeDir(name) {
  const dir = path.join(repoRoot, 'tmp', 'c01-xproc-' + name + '-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const CP = checkpoint.buildCheckpointV2({
  taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
  workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
  generation: 1, kind: 'active', safePointBoundarySeq: 4, safePointStepId: null,
  createdAtUtc: '2026-09-26T10:00:00.000Z',
  objective: { text: 'Prove cross-process views.', status: 'in-progress' },
  requirements: [{ id: 'R-x', text: 'Views survive restart.', status: 'active', evidenceRefs: [] }],
  constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
  progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C01 xproc', remainingMilestones: [] },
  decisions: [{ id: 'D-x', statement: 'Derived views.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
  repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
  evidenceRefs: [],
  failures: { activeFailures: [], rejectedHypotheses: [], retryState: null },
  verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'xproc', evidenceRefs: [] }] },
  continuation: { nextAction: 'Compare workers.', unresolvedQuestions: [], recentUserIntent: 'Land C01.' },
}).checkpoint;
const SNAP_REV = sha('c01-xproc:revision');
const D_REQ = tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'R-x' } });
const D_USER = tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true });
const D_DEC = tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-x' } });
function inlinePage(kind, sourceKind, refs, seqs, text) {
  return page.createContextPageV2({ kind, namespace: clone(NS), sourceKind, sourceRefs: refs.slice(), mutability: 'immutable', sourceSeqs: seqs.slice(), exactText: text, createdAtGeneration: 1 });
}
const COLD_PAGE = inlinePage('verification', 'verification', ['test-run:xproc:1'], [31], 'PASS xproc suites=2');
const D_COLD = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: COLD_PAGE });
const REF_PAGE = inlinePage('decision', 'agent', ['decision:Dx'], [40], 'Xproc hypothesis superseded.');
const D_REF = tier.classifyMemoryTierV2({ subjectKind: 'superseded-hypothesis', page: REF_PAGE });
const REQ_TEXT = 'R-x: Views survive restart.';
const USER_TEXT = 'Compare the workers.';
const DEC_TEXT = 'D-x: Derived views.';
function buildInput() {
  return {
    namespace: clone(NS),
    checkpointBinding: { checkpointGeneration: CP.generation, checkpointId: CP.checkpointId, checkpointContentHash: CP.checkpointContentDigest, snapshotRevision: SNAP_REV },
    turnRef: { turnId: 'tx', revision: 'r7' },
    pinned: [{ tier: 'PINNED', sourceType: 'checkpoint-state', sourceId: 'checkpoint:requirement:R-x', contentHash: sha(REQ_TEXT), provenance: { schemaVersion: 1, sourceKind: 'controller', trust: 'authoritative', sourceRefs: ['user:R-x'], authorityScope: 'task', fieldKind: 'requirement-text' }, mediaType: 'text', exactText: REQ_TEXT, mandatory: true, tierDecision: clone(D_REQ) }],
    hot: [{ tier: 'HOT', sourceType: 'current-turn', sourceId: 'current-turn:tx', contentHash: sha(USER_TEXT), provenance: { schemaVersion: 1, sourceKind: 'user', trust: 'user-intent', sourceRefs: ['session-event:3'], authorityScope: 'task', fieldKind: 'user-intent' }, mediaType: 'text', exactText: USER_TEXT, mandatory: true, tierDecision: clone(D_USER) }],
    warm: [{ tier: 'WARM', sourceType: 'checkpoint-state', sourceId: 'checkpoint:decision:D-x', contentHash: sha(DEC_TEXT), provenance: { schemaVersion: 1, sourceKind: 'controller', trust: 'authoritative', sourceRefs: ['controller:D-x'], authorityScope: 'task', fieldKind: 'decision-statement' }, mediaType: 'text', exactText: DEC_TEXT, mandatory: false, tierDecision: clone(D_DEC) }],
    materializedCold: [{ tier: 'COLD', sourceType: 'context-page', sourceId: COLD_PAGE.id, contentHash: COLD_PAGE.contentHash, provenance: clone(COLD_PAGE.provenance), mediaType: 'text', exactText: 'PASS xproc suites=2', mandatory: false, tierDecision: clone(D_COLD) }],
    referencedColdPages: [{ pageId: REF_PAGE.id, contentHash: REF_PAGE.contentHash, evidenceId: null, kind: REF_PAGE.kind, provenance: clone(REF_PAGE.provenance), exactResolutionMode: D_REF.exactResolutionMode, namespace: { taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId }, tierDecision: clone(D_REF) }],
    tokenBudget: { hardMax: 4000, target: 3000, used: null },
    compilerPolicyRevision: 'context-compiler-v1',
    compilationTrace: [{ pageId: null, action: 'PIN', reasonCode: 'tier-pinned-active-requirement', deterministic: true }],
    mandatoryRefs: [{ sourceId: 'checkpoint:requirement:R-x', kind: 'checkpoint-requirement' }, { sourceId: 'current-turn:tx', kind: 'current-turn' }],
  };
}
section('IN PROCESS BASELINE');
const EXPECTED = view.createContextViewV2(buildInput());
const EXPECTED_CANON = view.canonicalizeContextViewV2(EXPECTED);
check(EXPECTED.id.indexOf('cxv_') === 0, 'baseline view id well-formed');
check(view.validateContextViewV2(EXPECTED).valid === true, 'baseline fixture valid');
function runWave(dir, count) {
  const inFile = path.join(dir, 'input.json');
  const goFile = path.join(dir, 'go');
  fs.writeFileSync(inFile, JSON.stringify(buildInput()));
  const beforeHash = sha(fs.readFileSync(inFile, 'utf8'));
  const items = [];
  for (let i = 0; i < count; i += 1) { items.push({ outFile: path.join(dir, 'out-' + i + '.json') }); }
  const procs = items.map((item) => spawn(process.execPath,
    [path.join(__dirname, 'ContextViewV2XProc.Worker.cjs'), '--in', inFile, '--go', goFile, '--out', item.outFile],
    { stdio: 'ignore' }));
  fs.writeFileSync(goFile, 'go');
  const deadline = Date.now() + 30000;
  let pending = true;
  while (pending && Date.now() < deadline) {
    pending = items.some((item) => !fs.existsSync(item.outFile));
    if (pending) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  check(!pending, 'every worker result landed before the deadline');
  for (const proc of procs) { try { proc.kill(); } catch (e) { /* reaped */ } }
  check(sha(fs.readFileSync(inFile, 'utf8')) === beforeHash, 'workers left the fixture input untouched');
  return items.map((item) => JSON.parse(fs.readFileSync(item.outFile, 'utf8')));
}
section('SIMULTANEOUS PROCESSES');
{
  const results = runWave(makeDir('wave1'), 2);
  for (let i = 0; i < results.length; i += 1) {
    check(results[i].ok === true, 'worker ' + i + ' compiled without crashing');
    check(results[i].id === EXPECTED.id, 'worker ' + i + ' view id matches baseline');
    check(results[i].viewDigest === EXPECTED.viewDigest, 'worker ' + i + ' digest matches baseline');
    check(results[i].canonical === EXPECTED_CANON, 'worker ' + i + ' canonical bytes match baseline');
  }
  check(results[0].canonical === results[1].canonical, 'simultaneous workers agree with each other');
}
section('RESTART FRESHNESS');
{
  const results = runWave(makeDir('wave2'), 1);
  check(results[0].ok === true && results[0].canonical === EXPECTED_CANON, 'fresh restart process agrees');
}
console.log('' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) { process.exit(1); }
