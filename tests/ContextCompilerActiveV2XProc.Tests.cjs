'use strict';
/**
 * ContextCompilerActiveV2XProc.Tests.cjs - CCV2-C08 cross-process proof.
 *
 * Two independent OS processes race behind a barrier over the same
 * synthetic fixture through the REAL production authorities; both
 * must produce byte-identical view/layout/render digests, token
 * counts, and decisions, matching the in-process attempt. No live
 * task state, no durable writes beyond temp fixture/result files
 * (removed afterwards).
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const child = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const snapshotMod = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const tier = require(path.join(repoRoot, 'config', 'ContextMemoryTierV2.cjs'));
const compiler = require(path.join(repoRoot, 'config', 'ContextCompilerV2.cjs'));
const counterMod = require(path.join(repoRoot, 'config', 'ContextTokenCounterV2.cjs'));
const capMod = require(path.join(repoRoot, 'config', 'ContextModelCapabilityV2.cjs'));
const active = require(path.join(repoRoot, 'config', 'ContextCompilerActiveV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log(String.fromCharCode(10) + title); }
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');

const NS = Object.freeze({
  taskId: 'TASK-C08-X',
  taskInstanceId: 'task_c08_x_0001',
  sessionId: 'sess-c08-x',
  workspaceId: '/tmp/nexus-c08-x',
  repositoryId: 'repo-c08',
  checkoutId: 'checkout-c08',
});
const TURN = 'Prove cross-process determinism.';
const SYSTEM = 'You are the Nexus host-contract system prompt.';

function buildFixture() {
  const raw = {
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove XProc.', status: 'in-progress' },
    requirements: [{ id: 'REQ-X1', text: 'XProc reproduces digests.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C08 xproc', remainingMilestones: [] },
    decisions: [{ id: 'D-X1', statement: 'XProc is disposable.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-X1', status: 'open', detail: 'Flaky gate.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'], retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Attempt XProc.', unresolvedQuestions: ['Approve?'], recentUserIntent: 'Ship C08.' },
  };
  const token = snapshotMod.capture({
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    workspaceId: raw.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    generation: 1, safePointBoundarySeq: 9, sessionRevision: 21,
    taskRevision: snapshotMod.deriveTaskRevision({
      objective: raw.objective, requirements: raw.requirements, constraints: raw.constraints,
      progress: raw.progress, decisions: raw.decisions,
      failures: { activeFailures: raw.failures.activeFailures, rejectedHypotheses: raw.failures.rejectedHypotheses },
      verification: raw.verification, continuation: raw.continuation,
    }),
    repositoryRevision: { headCommit: 'abc123', indexDigest: sha('c08x:index'), worktreeDigest: sha('c08x:worktree') },
    runtimeRevision: { runtimeSnapshotSeq: 7 },
  }, '2026-09-26T10:00:00.000Z');
  const built = checkpoint.buildCheckpointV2(Object.assign({}, raw, { snapshotToken: token }));
  const CP = built.checkpoint;
  const mk = (kind, sourceKind, refs, seqs, text) => page.createContextPageV2({
    kind, namespace: {
      taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
      workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    },
    sourceKind, sourceRefs: refs.slice(), mutability: 'immutable',
    sourceSeqs: seqs.slice(), exactText: text, createdAtGeneration: 1,
  });
  const COLD = mk('decision', 'agent', ['decision:H9'], [40], 'Historical host note. '.repeat(30));
  const TOOL = mk('tool-result', 'tool', ['tool-event:call-x1'], [7, 8], 'exit 0 settled xproc tool log. '.repeat(8));
  const decisions = [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-X1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F-X1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-X1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'superseded-hypothesis', page: COLD }),
    tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: TOOL, immediateRelevance: true }),
  ];
  const cap = capMod.createStubTestCapabilityV2({ provider: 'stub-test', model: 'stub-model-v1', maxContextTokens: 60000 });
  const ctr = cap.tokenCounter;
  const maxTokens = 2048;
  const counts = {
    hostPrefixTokens: counterMod.countTextVerifiedV2(ctr, SYSTEM),
    toolSchemaTokens: counterMod.countTextVerifiedV2(ctr, JSON.stringify(checkpoint.canonicalize([{ name: 'run-tests' }]))),
    framingTokens: counterMod.countTextVerifiedV2(ctr, JSON.stringify(checkpoint.canonicalize({ provider: 'stub-test', model: 'stub-model-v1', reasoningEffort: 'high' }))),
    reservedOutputTokens: maxTokens,
    modelMax: cap.maxContextTokens,
  };
  const budget = active.deriveActiveBudgetV2({
    modelMax: counts.modelMax, hostPrefixTokens: counts.hostPrefixTokens,
    toolSchemaTokens: counts.toolSchemaTokens, framingTokens: counts.framingTokens,
    reservedOutputTokens: counts.reservedOutputTokens, safetyReserveTokens: 0,
  });
  const ccv2Budget = { hardMax: budget.budget.ccv2HardMax, target: budget.budget.ccv2Target };
  const compileInput = {
    checkpoint: CP,
    currentTurn: { turnId: 'live', text: TURN, revision: null },
    namespace: {
      taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
      workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    },
    snapshotRevision: CP.snapshot.revisionDigest,
    runtimeState: { pendingProtocol: null },
    pages: [COLD, TOOL],
    tierDecisions: decisions,
    evidenceRefs: [],
    exactMaterial: [],
    toolTransactions: [{ pageId: TOOL.id, callId: 'call-x1', callSeq: 7, resultSeq: 8 }],
    budget: ccv2Budget,
    compilerPolicyRevision: compiler.COMPILER_POLICY_REVISION_V2,
  };
  const binding = {
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    checkpointGeneration: 1, checkpointId: CP.checkpointId,
    snapshotRevision: CP.snapshot.revisionDigest,
    turnId: 'live', turnTextHash: sha(TURN), turnRevision: null,
    provider: 'stub-test', model: 'stub-model-v1',
    maxTokens, outputReserveTokens: maxTokens,
    tokenizerFingerprint: cap.tokenizerFingerprint, capabilityRevision: cap.capabilityRevision,
  };
  return {
    compileInput, pages: [COLD, TOOL], ccv2Budget, counts, binding,
    capabilityRoute: { provider: 'stub-test', model: 'stub-model-v1', maxContextTokens: 60000, maxOutputTokens: null },
    systemText: SYSTEM,
    toolsJson: JSON.stringify(checkpoint.canonicalize([{ name: 'run-tests' }])),
    framingJson: JSON.stringify(checkpoint.canonicalize({ provider: 'stub-test', model: 'stub-model-v1', reasoningEffort: 'high' })),
    capability: cap,
  };
}

section('C08-XPROC CROSS-PROCESS DETERMINISM');
{
  const fx = buildFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c08x-'));
  const inFile = path.join(dir, 'fixture.json');
  const goFile = path.join(dir, 'go');
  const outA = path.join(dir, 'a.json');
  const outB = path.join(dir, 'b.json');
  const serial = {
    compileInput: fx.compileInput, pages: fx.pages, ccv2Budget: fx.ccv2Budget,
    counts: fx.counts, binding: fx.binding, capabilityRoute: fx.capabilityRoute,
    systemText: fx.systemText, toolsJson: fx.toolsJson, framingJson: fx.framingJson,
  };
  fs.writeFileSync(inFile, JSON.stringify(serial));
  const worker = path.join(repoRoot, 'tests', 'ContextCompilerActiveV2XProc.Worker.cjs');
  const spawn = (out) => child.spawn(process.execPath, [worker, '--in', inFile, '--go', goFile, '--out', out], { stdio: 'ignore' });
  const a = spawn(outA);
  const b = spawn(outB);
  const wait = (proc) => new Promise((resolve) => proc.on('close', resolve));
  // Release the barrier only after both workers are plausibly waiting.
  setTimeout(() => { try { fs.writeFileSync(goFile, 'go'); } catch (e) { void e; } }, 500);
  Promise.all([wait(a), wait(b)]).then(() => {
    let ra = null;
    let rb = null;
    try { ra = JSON.parse(fs.readFileSync(outA, 'utf8')); } catch (e) { ra = null; }
    try { rb = JSON.parse(fs.readFileSync(outB, 'utf8')); } catch (e) { rb = null; }
    check(ra !== null && ra.ok === true, 'worker A completes eligible', ra && ra.error ? ra.error : 'no result');
    check(rb !== null && rb.ok === true, 'worker B completes eligible', rb && rb.error ? rb.error : 'no result');
    if (ra !== null && rb !== null && ra.ok === true && rb.ok === true) {
      check(ra.viewId === rb.viewId && ra.viewDigest === rb.viewDigest, 'view identity identical across processes');
      check(ra.layoutDigest === rb.layoutDigest, 'layout digest identical across processes');
      check(ra.renderDigest === rb.renderDigest, 'render digest identical across processes');
      check(ra.finalInputTokens === rb.finalInputTokens && ra.decisionCanonical === rb.decisionCanonical, 'counts + decision bytes identical across processes');
      // In-process attempt must agree with both workers.
      const local = active.attemptCompilerActiveV2({
        compileInput: fx.compileInput, pages: fx.pages, capability: fx.capability,
        ccv2Budget: fx.ccv2Budget, hostPrefixTokens: fx.counts.hostPrefixTokens,
        toolSchemaTokens: fx.counts.toolSchemaTokens, framingTokens: fx.counts.framingTokens,
        reservedOutputTokens: fx.counts.reservedOutputTokens, modelMax: fx.counts.modelMax,
        binding: fx.binding,
      });
      check(local.eligible === true && local.render.renderDigest === ra.renderDigest, 'in-process attempt matches workers');
      check(local.view.id === ra.viewId && local.tokenAccounting.finalInputTokens === ra.finalInputTokens, 'in-process counts match workers');
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { void e; }
    console.log(String.fromCharCode(10) + 'ContextCompilerActiveV2XProc suite: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) process.exitCode = 1;
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
