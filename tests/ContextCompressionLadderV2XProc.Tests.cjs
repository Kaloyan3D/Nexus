'use strict';
/**
 * ContextCompressionLadderV2XProc.Tests.cjs - CCV2-C05 cross-process determinism proof.
 *
 * Spawns independent OS processes
 * (tests/ContextCompressionLadderV2XProc.Worker.cjs) that compress the
 * same canonical fixture through the REAL production authorities with no
 * shared module state. The token counter crosses processes as a
 * fingerprint string only (rebuilt deterministically in the worker);
 * closures are never serialized. Proves: simultaneous compressors return
 * byte-identical plans and packed views (same plan digest, same bytes,
 * same view id/digest), restart-fresh processes agree with in-process
 * compression, the fixture input crosses processes untouched, and an
 * unreconstructable fingerprint fails closed in the worker without
 * crashing it. The fixture uses inline pages only, so no store paths or
 * branded proofs cross processes.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const ladder = require(path.join(repoRoot, 'config', 'ContextCompressionLadderV2.cjs'));
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
const NS = Object.freeze({
  taskId: 'TASK-C05-X',
  taskInstanceId: 'task_c05_x_0001',
  sessionId: 'sess-c05-x',
  workspaceId: '/tmp/nexus-c05-x',
  repositoryId: 'repo-c05',
  checkoutId: 'checkout-c05',
});
function checkpointInput() {
  return {
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove cross-process compression.', status: 'in-progress' },
    requirements: [{ id: 'REQ-001', text: 'Active requirement stays PINNED.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C05 XProc', remainingMilestones: [] },
    decisions: [{ id: 'D1', statement: 'Views are disposable working sets.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F1', status: 'open', detail: 'Flaky harness gate.', attemptCount: 2, evidenceRefs: [] }],
      rejectedHypotheses: ['cache-miss theory'],
      retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry-after-flake' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Build C05 XProc.', unresolvedQuestions: ['Approve the ladder policy?'], recentUserIntent: 'Ship C05 XProc.' },
  };
}
const CP = checkpoint.buildCheckpointV2(checkpointInput()).checkpoint;
const SNAP_REV = CP.snapshot.revisionDigest;
function stateDecisions() {
  return [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-001' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
  ];
}
const EXTRACT = 'salient exact finding: cache key derives from plan digest';
const BIG_TEXT = 'XProc evidence body. ' + EXTRACT + '. ' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(18);
const BIG_PAGE = page.createContextPageV2({
  kind: 'conversation', namespace: clone(NS), sourceKind: 'user',
  sourceRefs: ['session-event:501'], mutability: 'immutable',
  sourceSeqs: [501], exactText: BIG_TEXT, createdAtGeneration: 1, extract: EXTRACT,
});
const SMALL_PAGE = page.createContextPageV2({
  kind: 'other', namespace: clone(NS), sourceKind: 'agent',
  sourceRefs: ['session-event:502'], mutability: 'immutable',
  sourceSeqs: [502], exactText: 'Small xproc note, short and exact.', createdAtGeneration: 1,
});
const D_BIG = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: BIG_PAGE });
const D_SMALL = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: SMALL_PAGE });
const XV = compiler.compileContextV2({
  checkpoint: CP,
  currentTurn: { turnId: 't1', text: 'Ship XProc now.', revision: null },
  namespace: clone(NS),
  snapshotRevision: SNAP_REV,
  runtimeState: { pendingProtocol: null },
  pages: [BIG_PAGE, SMALL_PAGE],
  tierDecisions: stateDecisions().concat([D_BIG, D_SMALL]),
  evidenceRefs: [],
  exactMaterial: [],
  toolTransactions: [],
  budget: { hardMax: 20000, target: 18000 },
  compilerPolicyRevision: 'context-compiler-v1',
}).view;
const BUDGET = { hardMax: 4000, target: 900 };
const CTR = counterModule.createCodepointTestCounterV2();
const EXPECTED = ladder.compressContextViewV2({ view: XV, pages: [BIG_PAGE, SMALL_PAGE], budget: clone(BUDGET), counter: CTR });
function workDir(tag) {
  const dir = path.join(repoRoot, 'tmp', 'c05-xproc-' + process.pid + '-' + tag);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function runWorker(input, tag) {
  return new Promise((resolve, reject) => {
    const dir = workDir(tag);
    const inFile = path.join(dir, tag + '.in.json');
    const goFile = path.join(dir, tag + '.go');
    const outFile = path.join(dir, tag + '.out.json');
    fs.writeFileSync(inFile, JSON.stringify(input));
    const before = crypto.createHash('sha256').update(fs.readFileSync(inFile)).digest('hex');
    const child = spawn(process.execPath, [
      path.join(repoRoot, 'tests', 'ContextCompressionLadderV2XProc.Worker.cjs'),
      '--in', inFile, '--go', goFile, '--out', outFile,
    ], { stdio: 'ignore' });
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) { reject(err); return; }
      try {
        const after = crypto.createHash('sha256').update(fs.readFileSync(inFile)).digest('hex');
        const result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        resolve({ result, inputIntact: before === after });
      } catch (e) { reject(e); }
    };
    child.on('error', finish);
    child.on('exit', (code) => {
      if (code !== 0) { finish(new Error('worker exit ' + code)); return; }
      finish(null);
    });
    setTimeout(() => { try { fs.writeFileSync(goFile, 'go'); } catch (e) { /* barrier best effort */ } }, 50);
  });
}
async function main() {
  section('C05 XPROC DETERMINISM');
  const input = {
    view: JSON.parse(JSON.stringify(XV)),
    pages: JSON.parse(JSON.stringify([BIG_PAGE, SMALL_PAGE])),
    budget: clone(BUDGET),
    counterFingerprint: CTR.tokenizerFingerprint,
  };
  const [first, second] = await Promise.all([runWorker(input, 'a'), runWorker(input, 'b')]);
  check(first.result.ok === true, 'worker A compresses cleanly', first.result.ok === true ? undefined : first.result.error);
  check(second.result.ok === true, 'worker B compresses cleanly', second.result.ok === true ? undefined : second.result.error);
  check(first.result.planDigest === second.result.planDigest, 'simultaneous workers agree on the plan digest');
  check(first.result.planCanonical === second.result.planCanonical, 'simultaneous workers agree on plan bytes');
  check(first.result.viewId === second.result.viewId && first.result.viewDigest === second.result.viewDigest, 'simultaneous workers agree on view identity');
  check(first.result.viewCanonical === second.result.viewCanonical, 'simultaneous workers agree on view bytes');
  check(first.result.planDigest === EXPECTED.compressionPlan.planDigest, 'fresh worker agrees with in-process plan');
  check(first.result.viewId === EXPECTED.compressedView.id, 'fresh worker agrees with in-process view id');
  check(first.result.viewDigest === EXPECTED.compressedView.viewDigest, 'fresh worker agrees with in-process digest');
  check(first.result.viewCanonical === view.canonicalizeContextViewV2(EXPECTED.compressedView), 'fresh worker agrees with in-process bytes');
  check(first.inputIntact === true && second.inputIntact === true, 'fixture input crosses processes untouched');
  const bad = await runWorker({
    view: JSON.parse(JSON.stringify(XV)),
    pages: JSON.parse(JSON.stringify([BIG_PAGE, SMALL_PAGE])),
    budget: clone(BUDGET),
    counterFingerprint: 'gpt-x',
  }, 'bad');
  check(bad.result.ok === false, 'unreconstructable fingerprint fails closed in the worker');
  console.log('--- SUMMARY ---');
  console.log('ContextCompressionLadderV2XProc suite: ' + passed + ' passed, ' + failed + ' failed.');
  if (failed > 0) { process.exitCode = 1; }
}
main().catch((e) => { console.log('FAIL: xproc harness crashed :: ' + String((e && e.message) || e).slice(0, 200)); process.exitCode = 1; });
