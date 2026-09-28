'use strict';
/**
 * ContextPromptLayoutV2XProc.Tests.cjs - CCV2-C06 cross-process determinism proof.
 *
 * Spawns independent OS processes (tests/ContextPromptLayoutV2XProc.Worker.cjs)
 * that plan the presentation layout for the same canonical final C05 fixture
 * through the REAL production authorities with no shared module state. No
 * token counter crosses processes: C06 planning needs no counting authority.
 * Proves: simultaneous planners return byte-identical layouts (same layout
 * digest, same stable-prefix digest, same canonical bytes), restart-fresh
 * processes agree with in-process planning, the fixture input crosses
 * processes untouched, and a forged source view fails closed in the worker
 * without crashing it.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const layoutModule = require(path.join(repoRoot, 'config', 'ContextPromptLayoutV2.cjs'));
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
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const NS = Object.freeze({
  taskId: 'TASK-C06-X',
  taskInstanceId: 'task_c06_x_0001',
  sessionId: 'sess-c06-x',
  workspaceId: '/tmp/nexus-c06-x',
  repositoryId: 'repo-c06-x',
  checkoutId: 'checkout-c06-x',
});
function makeDir(name) {
  const dir = path.join(repoRoot, 'tmp', 'c06-xproc-' + name + '-' + process.pid);
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
    objective: { text: 'Prove cross-process layout.', status: 'in-progress' },
    requirements: [{ id: 'R-x', text: 'Layouts survive restart.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C06 xproc', remainingMilestones: [] },
    decisions: [{ id: 'D-x', statement: 'Layouts are disposable.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-x', status: 'open', detail: 'Gate flaked once.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'],
      retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry-after-flake' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Plan C06.', unresolvedQuestions: ['Approve the layout policy?'], recentUserIntent: 'Ship C06.' },
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
const COLD_PAGE = inlinePage('verification', 'verification', ['test-run:c06x:1'], [31], 'PASS suites=9 tests=81 across processes.');
const D_COLD = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: COLD_PAGE });
const TOOL_PAGE = inlinePage('tool-result', 'tool', ['tool-event:call-5'], [5, 6], 'exit 0 settled xproc tool log');
const D_TOOL = tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: TOOL_PAGE });
const UNI_PAGE = inlinePage('conversation', 'user', ['session-event:12'], [12], 'Български Ελληνικά 中文 🎉 stable across restarts.');
const D_UNI = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: UNI_PAGE });
function compileFixture() {
  return compiler.compileContextV2({
    checkpoint: CP,
    currentTurn: { turnId: 't-x', text: 'Plan across processes.', revision: null },
    namespace: clone(NS),
    snapshotRevision: SNAP_REV,
    runtimeState: { pendingProtocol: null },
    pages: [COLD_PAGE, TOOL_PAGE, UNI_PAGE],
    tierDecisions: stateDecisions().concat([D_COLD, D_TOOL, D_UNI]),
    evidenceRefs: [],
    exactMaterial: [],
    toolTransactions: [{ pageId: TOOL_PAGE.id, callId: 'call-5', callSeq: 5, resultSeq: 6 }],
    budget: { hardMax: 12000, target: 10000 },
    compilerPolicyRevision: 'context-compiler-v1',
  });
}
const BASE_VIEW = compileFixture().view;
const FINAL = ladder.compressContextViewV2({
  view: BASE_VIEW, pages: [COLD_PAGE, TOOL_PAGE, UNI_PAGE],
  budget: { hardMax: 12000, target: 10000 },
  counter: counterModule.createCodepointTestCounterV2(),
}).compressedView;
const EXPECTED = layoutModule.planContextPromptLayoutV2({ view: FINAL }).layout;
const EXPECTED_CANON = layoutModule.canonicalizeContextPromptLayoutV2(EXPECTED);
function runWave(dir, count, mutate) {
  const inputView = mutate === 'forge' ? Object.assign(clone(FINAL), { id: 'cxv_ffffffffffffffffffffffffffffffff' }) : clone(FINAL);
  const inFile = path.join(dir, 'input.json');
  const goFile = path.join(dir, 'go');
  fs.writeFileSync(inFile, JSON.stringify({ view: inputView }));
  const beforeHash = sha(fs.readFileSync(inFile, 'utf8'));
  const items = [];
  for (let i = 0; i < count; i += 1) { items.push({ outFile: path.join(dir, 'out-' + i + '.json') }); }
  const procs = items.map((item) => spawn(process.execPath,
    [path.join(__dirname, 'ContextPromptLayoutV2XProc.Worker.cjs'), '--in', inFile, '--go', goFile, '--out', item.outFile],
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
section('C06 XPROC BASELINE');
{
  check(view.validateContextViewV2(FINAL).valid === true, 'xproc fixture is a C01-valid final view');
  check(layoutModule.validateContextPromptLayoutV2({ layout: EXPECTED, view: FINAL }).valid === true, 'in-process baseline layout validates');
  check(EXPECTED.sourceViewId === FINAL.id, 'baseline binds the fixture view id');
  check(EXPECTED.sourceViewDigest === FINAL.viewDigest, 'baseline binds the fixture view digest');
}
section('SIMULTANEOUS PROCESSES');
{
  const results = runWave(makeDir('wave1'), 2);
  for (let i = 0; i < results.length; i += 1) {
    check(results[i].ok === true, 'worker ' + i + ' planned without crashing');
    check(results[i].layoutDigest === EXPECTED.layoutDigest, 'worker ' + i + ' layout digest matches baseline');
    check(results[i].stablePrefixDigest === EXPECTED.stablePrefixDigest, 'worker ' + i + ' prefix digest matches baseline');
    check(results[i].layoutCanonical === EXPECTED_CANON, 'worker ' + i + ' layout bytes match baseline');
    check(results[i].sourceViewId === FINAL.id, 'worker ' + i + ' source view id matches baseline');
    check(results[i].sourceViewDigest === FINAL.viewDigest, 'worker ' + i + ' source view digest matches baseline');
  }
  check(results[0].layoutCanonical === results[1].layoutCanonical, 'simultaneous workers agree on the layout');
}
section('RESTART FRESHNESS');
{
  const results = runWave(makeDir('wave2'), 1);
  check(results[0].ok === true && results[0].layoutCanonical === EXPECTED_CANON, 'fresh restart process agrees on the layout');
  check(results[0].stablePrefixDigest === EXPECTED.stablePrefixDigest, 'fresh restart process agrees on the prefix');
}
section('XPROC FAIL CLOSED');
{
  const results = runWave(makeDir('wave3'), 1, 'forge');
  check(results[0].ok === false, 'forged source view fails closed in the worker');
  check(String(results[0].error).indexOf('context-layout-') !== -1, 'worker refusal carries the stable code');
}
console.log('ContextPromptLayoutV2XProc suite: ' + passed + ' passed, ' + failed + ' failed.');
if (failed > 0) { process.exit(1); }
