'use strict';
/**
 * ContextCompilerV2XProc.Tests.cjs - CCV2-C02 cross-process determinism proof.
 *
 * Spawns independent OS processes (tests/ContextCompilerV2XProc.Worker.cjs)
 * that compile the same canonical fixture through the REAL production
 * authority with no shared module state. Proves: simultaneous compilers
 * return byte-identical plans, traces, and ContextViews (same plan digest,
 * same view id, same digests, same bytes), restart-fresh processes agree
 * with in-process reads, and the fixture input crosses processes
 * untouched. No filesystem authority is needed beyond temporary JSON
 * fixtures: branded B03 results never cross processes, so the fixture uses
 * durably self-backed COLD material and identity-only references only.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const compiler = require(path.join(repoRoot, 'config', 'ContextCompilerV2.cjs'));
const view = require(path.join(repoRoot, 'config', 'ContextViewV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const tier = require(path.join(repoRoot, 'config', 'ContextMemoryTierV2.cjs'));
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
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
  taskId: 'TASK-C02-X',
  taskInstanceId: 'task_c02_x_0001',
  sessionId: 'sess-c02-x',
  workspaceId: '/tmp/nexus-c02-x',
  repositoryId: 'repo-c02-x',
  checkoutId: 'checkout-c02-x',
});
function makeDir(name) {
  const dir = path.join(repoRoot, 'tmp', 'c02-xproc-' + name + '-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const CP = checkpoint.buildCheckpointV2({
  taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
  workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
  generation: 2, kind: 'active', safePointBoundarySeq: 4, safePointStepId: null,
  createdAtUtc: '2026-09-26T10:00:00.000Z',
  objective: { text: 'Prove cross-process compilation.', status: 'in-progress' },
  requirements: [{ id: 'R-x', text: 'Compiles survive restart.', status: 'active', evidenceRefs: [] }],
  constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
  progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C02 xproc', remainingMilestones: [] },
  decisions: [{ id: 'D-x', statement: 'Compiled views.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
  repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
  evidenceRefs: [],
  failures: { activeFailures: [], rejectedHypotheses: [], retryState: null },
  verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'xproc', evidenceRefs: [] }] },
  continuation: { nextAction: 'Compare workers.', unresolvedQuestions: [], recentUserIntent: 'Land C02.' },
  parentCheckpointId: 'ccp_00000000000000000000000000000000',
}).checkpoint;
function inlinePage(kind, sourceKind, refs, seqs, text) {
  return page.createContextPageV2({ kind, namespace: clone(NS), sourceKind, sourceRefs: refs.slice(), mutability: 'immutable', sourceSeqs: seqs.slice(), exactText: text, createdAtGeneration: 2 });
}
const COLD_PAGE = inlinePage('verification', 'verification', ['test-run:xproc:1'], [31], 'PASS xproc suites=2');
const D_COLD = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: COLD_PAGE });
const REF_PAGE = inlinePage('decision', 'agent', ['decision:Dx'], [40], 'Xproc hypothesis superseded.');
const D_REF = tier.classifyMemoryTierV2({ subjectKind: 'superseded-hypothesis', page: REF_PAGE });
function buildInput() {
  return {
    checkpoint: clone(CP),
    currentTurn: { turnId: 'tx', text: 'Compare the workers.', revision: null },
    namespace: clone(NS),
    snapshotRevision: CP.snapshot === null || CP.snapshot === undefined ? null : CP.snapshot.revisionDigest,
    runtimeState: { pendingProtocol: null },
    toolTransactions: [],
    pages: [clone(COLD_PAGE), clone(REF_PAGE)],
    tierDecisions: [
      tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'R-x' } }),
      tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
      tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
      tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
      tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-x' } }),
      tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
      clone(D_COLD),
      clone(D_REF),
    ],
    evidenceRefs: [],
    exactMaterial: [],
    budget: { hardMax: 4000, target: 3000 },
    compilerPolicyRevision: 'context-compiler-v1',
  };
}
section('IN PROCESS BASELINE');
const EXPECTED = compiler.compileContextV2(buildInput());
const EXPECTED_PLAN_CANON = JSON.stringify(EXPECTED.plan);
const EXPECTED_VIEW_CANON = view.canonicalizeContextViewV2(EXPECTED.view);
check(EXPECTED.view.id.indexOf('cxv_') === 0, 'baseline view id well-formed');
check(view.validateContextViewV2(EXPECTED.view).valid === true, 'baseline fixture valid');
check(compiler.validateContextCompilationPlanV2(EXPECTED.plan).valid === true, 'baseline plan valid');
check(EXPECTED.view.pinned.length === 3, 'baseline pins requirement + constraint + objective');
function runWave(dir, count) {
  const inFile = path.join(dir, 'input.json');
  const goFile = path.join(dir, 'go');
  fs.writeFileSync(inFile, JSON.stringify(buildInput()));
  const beforeHash = sha(fs.readFileSync(inFile, 'utf8'));
  const items = [];
  for (let i = 0; i < count; i += 1) { items.push({ outFile: path.join(dir, 'out-' + i + '.json') }); }
  const procs = items.map((item) => spawn(process.execPath,
    [path.join(__dirname, 'ContextCompilerV2XProc.Worker.cjs'), '--in', inFile, '--go', goFile, '--out', item.outFile],
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
    check(results[i].planDigest === EXPECTED.plan.planDigest, 'worker ' + i + ' plan digest matches baseline');
    check(results[i].planCanonical === EXPECTED_PLAN_CANON, 'worker ' + i + ' plan bytes match baseline');
    check(results[i].viewId === EXPECTED.view.id, 'worker ' + i + ' view id matches baseline');
    check(results[i].viewDigest === EXPECTED.view.viewDigest, 'worker ' + i + ' digest matches baseline');
    check(results[i].viewCanonical === EXPECTED_VIEW_CANON, 'worker ' + i + ' canonical bytes match baseline');
  }
  check(results[0].planCanonical === results[1].planCanonical, 'simultaneous workers agree on the plan');
  check(results[0].viewCanonical === results[1].viewCanonical, 'simultaneous workers agree on the view');
}
section('RESTART FRESHNESS');
{
  const results = runWave(makeDir('wave2'), 1);
  check(results[0].ok === true && results[0].viewCanonical === EXPECTED_VIEW_CANON, 'fresh restart process agrees on the view');
  check(results[0].planCanonical === EXPECTED_PLAN_CANON, 'fresh restart process agrees on the plan');
}
console.log('ContextCompilerV2XProc suite: ' + passed + ' passed, ' + failed + ' failed.');
if (failed > 0) { process.exit(1); }
