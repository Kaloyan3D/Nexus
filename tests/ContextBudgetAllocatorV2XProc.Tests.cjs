'use strict';
/**
 * ContextBudgetAllocatorV2XProc.Tests.cjs - CCV2-C04 cross-process determinism proof.
 *
 * Spawns independent OS processes (tests/ContextBudgetAllocatorV2XProc.Worker.cjs)
 * that pack the same canonical fixture through the REAL production
 * authorities with no shared module state. The token counter crosses
 * processes as a fingerprint string only (rebuilt deterministically in
 * the worker); closures are never serialized. Proves: simultaneous
 * packers return byte-identical plans and packed views (same plan
 * digest, same bytes, same view id/digest), restart-fresh processes
 * agree with in-process packing, the fixture input crosses processes
 * untouched, and an unreconstructable fingerprint fails closed in the
 * worker without crashing it. The fixture uses durably self-backed
 * material only, so no branded proofs cross processes.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const allocator = require(path.join(repoRoot, 'config', 'ContextBudgetAllocatorV2.cjs'));
const counterModule = require(path.join(repoRoot, 'config', 'ContextTokenCounterV2.cjs'));
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
  taskId: 'TASK-C04-X',
  taskInstanceId: 'task_c04_x_0001',
  sessionId: 'sess-c04-x',
  workspaceId: '/tmp/nexus-c04-x',
  repositoryId: 'repo-c04-x',
  checkoutId: 'checkout-c04-x',
});
function makeDir(name) {
  const dir = path.join(repoRoot, 'tmp', 'c04-xproc-' + name + '-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function checkpointInput() {
  return {
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 4, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove cross-process packing.', status: 'in-progress' },
    requirements: [{ id: 'R-x', text: 'Packs survive restart.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C04 xproc', remainingMilestones: [] },
    decisions: [{ id: 'D-x', statement: 'Packed views.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-x', status: 'open', detail: 'Gate flaked once.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'],
      retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry-after-flake' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Pack C04.', unresolvedQuestions: ['Approve the packing policy?'], recentUserIntent: 'Ship C04.' },
  };
}
const CP = checkpoint.buildCheckpointV2(checkpointInput()).checkpoint;
const SNAP_REV = CP.snapshot.revisionDigest;
function stateDecisions() {
  return [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'R-x' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F-x' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-x' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
  ];
}
function inlinePage(kind, sourceKind, refs, seqs, text) {
  return page.createContextPageV2({
    kind, namespace: clone(NS), sourceKind,
    sourceRefs: refs.slice(), mutability: 'immutable',
    sourceSeqs: seqs.slice(), exactText: text, createdAtGeneration: 1,
  });
}
const COLD_PAGE = inlinePage('verification', 'verification', ['test-run:c04x:1'], [31], 'PASS suites=9 tests=81');
const D_COLD = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: COLD_PAGE });
const WARM_PAGE = inlinePage('conversation', 'user', ['session-event:11'], [11], 'XProc guards the branch.');
const D_WARM = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: WARM_PAGE });
const UNI_PAGE = inlinePage('conversation', 'user', ['session-event:12'], [12], 'Български Ελληνικά 中文 🎉');
const D_UNI = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: UNI_PAGE });
function compileFixture() {
  return compiler.compileContextV2({
    checkpoint: CP,
    currentTurn: { turnId: 't-x', text: 'Pack across processes.', revision: null },
    namespace: clone(NS),
    snapshotRevision: SNAP_REV,
    runtimeState: { pendingProtocol: null },
    pages: [COLD_PAGE, WARM_PAGE, UNI_PAGE],
    tierDecisions: stateDecisions().concat([D_COLD, D_WARM, D_UNI]),
    evidenceRefs: [],
    exactMaterial: [],
    toolTransactions: [],
    budget: { hardMax: 8000, target: 6000 },
    compilerPolicyRevision: 'context-compiler-v1',
  });
}
const FIXTURE_VIEW = compileFixture().view;
const PACK_BUDGET = Object.freeze({ hardMax: 8000, target: 6000 });
const PACK_FINGERPRINT = counterModule.TEST_CODEPOINT_FINGERPRINT_V2;
const EXPECTED = allocator.packContextBudgetV2({
  view: FIXTURE_VIEW, budget: { hardMax: PACK_BUDGET.hardMax, target: PACK_BUDGET.target },
  counter: counterModule.createCodepointTestCounterV2(),
});
const EXPECTED_PLAN_CANON = JSON.stringify(EXPECTED.plan);
const EXPECTED_VIEW_CANON = view.canonicalizeContextViewV2(EXPECTED.packedView);
function buildPackInput(fingerprint) {
  return { view: clone(FIXTURE_VIEW), budget: { hardMax: 8000, target: 6000 }, counterFingerprint: fingerprint || PACK_FINGERPRINT };
}
function runWave(dir, count, fingerprint) {
  const inFile = path.join(dir, 'input.json');
  const goFile = path.join(dir, 'go');
  fs.writeFileSync(inFile, JSON.stringify(buildPackInput(fingerprint)));
  const beforeHash = sha(fs.readFileSync(inFile, 'utf8'));
  const items = [];
  for (let i = 0; i < count; i += 1) { items.push({ outFile: path.join(dir, 'out-' + i + '.json') }); }
  const procs = items.map((item) => spawn(process.execPath,
    [path.join(__dirname, 'ContextBudgetAllocatorV2XProc.Worker.cjs'), '--in', inFile, '--go', goFile, '--out', item.outFile],
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
section('C04 XPROC BASELINE');
{
  check(view.validateContextViewV2(FIXTURE_VIEW).valid === true, 'xproc fixture is a C01-valid compiled view');
  check(allocator.validateContextPackingPlanV2(EXPECTED.plan).valid === true, 'in-process baseline plan validates');
  check(EXPECTED.plan.tokenizerFingerprint === PACK_FINGERPRINT, 'baseline binds the test fingerprint');
}
section('SIMULTANEOUS PROCESSES');
{
  const results = runWave(makeDir('wave1'), 2);
  for (let i = 0; i < results.length; i += 1) {
    check(results[i].ok === true, 'worker ' + i + ' packed without crashing');
    check(results[i].planDigest === EXPECTED.plan.planDigest, 'worker ' + i + ' plan digest matches baseline');
    check(results[i].planCanonical === EXPECTED_PLAN_CANON, 'worker ' + i + ' plan bytes match baseline');
    check(results[i].viewId === EXPECTED.packedView.id, 'worker ' + i + ' view id matches baseline');
    check(results[i].viewDigest === EXPECTED.packedView.viewDigest, 'worker ' + i + ' digest matches baseline');
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
section('XPROC FAIL CLOSED');
{
  const results = runWave(makeDir('wave3'), 1, 'provider-tokenizer-v9');
  check(results[0].ok === false, 'unreconstructable fingerprint fails closed in the worker');
  check(String(results[0].error).indexOf('context-budget-tokenizer-unavailable') !== -1, 'worker refusal carries the stable code');
}
console.log('ContextBudgetAllocatorV2XProc suite: ' + passed + ' passed, ' + failed + ' failed.');
if (failed > 0) { process.exit(1); }
