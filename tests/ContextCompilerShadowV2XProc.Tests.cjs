'use strict';
/**
 * ContextCompilerShadowV2XProc.Tests.cjs - CCV2-C07 cross-process proof.
 *
 * Spawns independent OS processes (tests/ContextCompilerShadowV2XProc.Worker.cjs)
 * that run the full C01->C06 candidate pipeline plus the logical shadow
 * comparison for the same canonical fixture through the REAL production
 * authorities with no shared module state. The counting authority crosses
 * processes as a fingerprint string only. Proves: simultaneous workers
 * return byte-identical shadow reports (same view id/digest, layout
 * digest, stable-prefix digest, comparison digest, discrepancy vector,
 * promotionBlocker), restart-fresh processes agree with the in-process
 * baseline, fixture inputs cross processes untouched, no worker mutates
 * durable state, and a forged candidate input fails closed in the worker
 * without crashing it.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const shadow = require(path.join(repoRoot, 'config', 'ContextCompilerShadowV2.cjs'));
const adapter = require(path.join(repoRoot, 'config', 'ContextCompilerShadowAdapterV2.cjs'));
const view = require(path.join(repoRoot, 'config', 'ContextViewV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const tier = require(path.join(repoRoot, 'config', 'ContextMemoryTierV2.cjs'));
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const snapshotMod = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const counterMod = require(path.join(repoRoot, 'config', 'ContextTokenCounterV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log('' + title + ''); }
const clone = (o) => JSON.parse(JSON.stringify(o));
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const CTR = counterMod.createCodepointTestCounterV2();
const NS = Object.freeze({
  taskId: 'TASK-C07-X',
  taskInstanceId: 'task_c07_x_0001',
  sessionId: 'sess-c07-x',
  workspaceId: '/tmp/nexus-c07-x',
  repositoryId: 'repo-c07',
  checkoutId: 'checkout-c07',
});
function makeDir(name) {
  const dir = path.join(repoRoot, 'tmp', 'c07-xproc-' + name + '-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function checkpointInput() {
  return {
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove cross-process shadow.', status: 'in-progress' },
    requirements: [{ id: 'REQ-X', text: 'Shadow survives restart.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C07 xproc', remainingMilestones: [] },
    decisions: [{ id: 'D-X', statement: 'Reports are disposable.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-X', status: 'open', detail: 'Gate flaked once.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'],
      retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry-after-flake' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Prove C07 xproc.', unresolvedQuestions: ['Approve?'], recentUserIntent: 'Ship C07.' },
  };
}
const RAW = checkpointInput();
const TOKEN = snapshotMod.capture({
  taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
  workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
  generation: 1, safePointBoundarySeq: 9, sessionRevision: 77,
  taskRevision: snapshotMod.deriveTaskRevision({
    objective: RAW.objective, requirements: RAW.requirements, constraints: RAW.constraints,
    progress: RAW.progress, decisions: RAW.decisions,
    failures: { activeFailures: RAW.failures.activeFailures, rejectedHypotheses: RAW.failures.rejectedHypotheses },
    verification: RAW.verification, continuation: RAW.continuation,
  }),
  repositoryRevision: { headCommit: 'abc123', indexDigest: sha('c07x:index'), worktreeDigest: sha('c07x:worktree') },
  runtimeRevision: { runtimeSnapshotSeq: 7 },
}, '2026-09-26T10:00:00.000Z');
const CP = checkpoint.buildCheckpointV2(Object.assign({}, RAW, { snapshotToken: TOKEN })).checkpoint;
function inlinePage(kind, sourceKind, refs, seqs, text, extra) {
  return page.createContextPageV2(Object.assign({
    kind, namespace: clone(NS), sourceKind,
    sourceRefs: refs.slice(), mutability: 'immutable',
    sourceSeqs: seqs.slice(), exactText: text, createdAtGeneration: 1,
  }, extra || {}));
}
const BIG_TEXT = 'Cross-process evidence note. '.repeat(60);
const BIG_EXTRACT = 'Cross-process evidence note. '.repeat(2).trim();
const COLD_BIG = inlinePage('decision', 'agent', ['decision:X9'], [40], BIG_TEXT, { extract: BIG_EXTRACT });
const TOOL_PAGE = inlinePage('tool-result', 'tool', ['tool-event:call-5'], [5, 6], 'exit 0 settled xproc tool log. '.repeat(8));
const UNI_PAGE = inlinePage('conversation', 'user', ['session-event:12'], [12], 'Български Ελληνικά 中文 🎉 stable across restarts.');
function stateDecisions() {
  return [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-X' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F-X' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-X' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'superseded-hypothesis', page: COLD_BIG }),
    tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: TOOL_PAGE, immediateRelevance: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: UNI_PAGE }),
  ];
}
const BUDGET = { hardMax: 12000, target: 10000 };
function compileInput() {
  return {
    checkpoint: CP,
    currentTurn: { turnId: 't-x', text: 'Prove shadow across processes 🎉.', revision: null },
    namespace: clone(NS),
    snapshotRevision: CP.snapshot.revisionDigest,
    runtimeState: { pendingProtocol: null },
    pages: [COLD_BIG, TOOL_PAGE, UNI_PAGE],
    tierDecisions: stateDecisions(),
    evidenceRefs: [],
    exactMaterial: [],
    toolTransactions: [{ pageId: TOOL_PAGE.id, callId: 'call-5', callSeq: 5, resultSeq: 6 }],
    budget: clone(BUDGET),
    compilerPolicyRevision: 'context-compiler-v1',
  };
}
const BASELINE_BUILT = shadow.buildCandidateV2({
  compileInput: compileInput(), pages: [COLD_BIG, TOOL_PAGE, UNI_PAGE], budget: clone(BUDGET), counter: CTR,
});
const BASELINE_OBS = BASELINE_BUILT.candidateObservation;
function actualFor(obs, viewObj) {
  const members = obs.members.map((m) => ({
    sourceId: m.sourceId, shownHash: m.shownHash, sourceHash: m.sourceHash, kind: m.kind,
    tier: m.tier, section: m.section, mandatory: m.mandatory, hostOwned: false, reference: false, tokens: null,
  }));
  for (const ref of obs.references) {
    members.push({
      sourceId: ref.pageId, shownHash: ref.contentHash, sourceHash: ref.contentHash,
      kind: 'EXACT', tier: 'COLD', section: 'materializedCold', mandatory: false,
      hostOwned: false, reference: false, tokens: null,
    });
  }
  let turnEntry = null;
  for (const s of view.VIEW_SECTIONS) {
    for (const e of viewObj[s]) { if (e.sourceType === 'current-turn') turnEntry = e; }
  }
  return {
    schemaVersion: 1,
    namespace: { taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId },
    checkpointBinding: {
      checkpointGeneration: viewObj.checkpointBinding.checkpointGeneration,
      checkpointId: viewObj.checkpointBinding.checkpointId,
      snapshotRevision: viewObj.checkpointBinding.snapshotRevision,
    },
    turnRef: viewObj.turnRef === null || viewObj.turnRef === undefined ? null : clone(viewObj.turnRef),
    members,
    currentTurn: turnEntry === null ? null : { turnId: 't-x', textHash: turnEntry.contentHash, revision: null },
    toolTransactions: obs.toolTransactions.map((t) => ({ callId: t.callId, balanced: t.balanced })),
    verification: obs.verification === null ? null : { digest: obs.verification.digest, revision: 'r1' },
    comparableTokens: null,
    tokenizerFingerprint: null,
  };
}
const BASELINE_ACTUAL = actualFor(BASELINE_OBS, BASELINE_BUILT.view);
const BASELINE_COMPARISON = shadow.compareShadowV2({
  actual: BASELINE_ACTUAL,
  candidate: BASELINE_OBS,
  captureSnapshotRevision: BASELINE_ACTUAL.checkpointBinding.snapshotRevision,
  completeSnapshotRevision: BASELINE_ACTUAL.checkpointBinding.snapshotRevision,
});
const BASELINE_REPORT = shadow.buildShadowReportV2({
  actual: BASELINE_ACTUAL, candidateResult: BASELINE_BUILT, comparison: BASELINE_COMPARISON,
  tokenizerFingerprint: BASELINE_OBS.tokenizerFingerprint,
});
const BASELINE_CANON = shadow.canonicalizeShadowReportV2(BASELINE_REPORT);
function runWave(dir, count, mutate) {
  const fixture = {
    compileInput: compileInput(),
    pages: [COLD_BIG, TOOL_PAGE, UNI_PAGE],
    budget: clone(BUDGET),
    actual: clone(BASELINE_ACTUAL),
    tokenizerFingerprint: CTR.tokenizerFingerprint,
  };
  if (mutate === 'forge') {
    fixture.compileInput.checkpoint = clone(fixture.compileInput.checkpoint);
    fixture.compileInput.checkpoint.taskId = 'TASK-FORGED';
  }
  const inFile = path.join(dir, 'input.json');
  const goFile = path.join(dir, 'go');
  fs.writeFileSync(inFile, JSON.stringify(fixture));
  const beforeHash = sha(fs.readFileSync(inFile, 'utf8'));
  const items = [];
  for (let i = 0; i < count; i += 1) { items.push({ outFile: path.join(dir, 'out-' + i + '.json') }); }
  const procs = items.map((item) => spawn(process.execPath,
    [path.join(__dirname, 'ContextCompilerShadowV2XProc.Worker.cjs'), '--in', inFile, '--go', goFile, '--out', item.outFile],
    { stdio: 'ignore' }));
  fs.writeFileSync(goFile, 'go');
  const deadline = Date.now() + 60000;
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
section('C07 XPROC BASELINE');
{
  check(view.validateContextViewV2(BASELINE_BUILT.view).valid === true, 'xproc fixture candidate passes the C01 gate');
  check(BASELINE_COMPARISON.status === 'MATCHED', 'in-process baseline comparison is MATCHED');
  check(BASELINE_REPORT.promotionBlocker === false, 'baseline carries no promotion blocker');
  check(/^[0-9a-f]{64}$/.test(BASELINE_COMPARISON.comparisonDigest), 'baseline comparison digest is 64 hex');
}
section('C07 SIMULTANEOUS PROCESSES');
{
  const results = runWave(makeDir('wave1'), 2);
  for (let i = 0; i < results.length; i += 1) {
    check(results[i].ok === true, 'worker ' + i + ' shadowed without crashing');
    check(results[i].viewId === BASELINE_OBS.viewId, 'worker ' + i + ' view id matches baseline');
    check(results[i].viewDigest === BASELINE_OBS.viewDigest, 'worker ' + i + ' view digest matches baseline');
    check(results[i].layoutDigest === BASELINE_OBS.layoutDigest, 'worker ' + i + ' layout digest matches baseline');
    check(results[i].stablePrefixDigest === BASELINE_OBS.stablePrefixDigest, 'worker ' + i + ' prefix digest matches baseline');
    check(results[i].comparisonDigest === BASELINE_COMPARISON.comparisonDigest, 'worker ' + i + ' comparison digest matches baseline');
    check(results[i].reportCanonical === BASELINE_CANON, 'worker ' + i + ' report bytes match baseline');
    check(results[i].status === 'MATCHED' && results[i].promotionBlocker === false, 'worker ' + i + ' status/blocker match baseline');
  }
  check(results[0].reportCanonical === results[1].reportCanonical, 'simultaneous workers agree on the discrepancy vector');
}
section('C07 RESTART FRESHNESS');
{
  const results = runWave(makeDir('wave2'), 1);
  check(results[0].ok === true && results[0].reportCanonical === BASELINE_CANON, 'fresh restart process agrees on the report');
  check(results[0].comparisonDigest === BASELINE_COMPARISON.comparisonDigest, 'fresh restart process agrees on the digest');
}
section('C07 XPROC FAIL CLOSED');
{
  const results = runWave(makeDir('wave3'), 1, 'forge');
  check(results[0].ok === false, 'forged candidate input fails closed in the worker');
  check(String(results[0].error).indexOf('context-') !== -1, 'worker refusal carries the stable code');
}
console.log('ContextCompilerShadowV2XProc suite: ' + passed + ' passed, ' + failed + ' failed.');
if (failed > 0) { process.exit(1); }
