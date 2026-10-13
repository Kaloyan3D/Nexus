'use strict';
/**
 * ContextBudgetAllocatorV2H.Tests.cjs - CCV2-C04H target/hardMax hardening proof.
 *
 * Proves the downstream-proven contract correction against the REAL
 * production authorities: frozen C01 structurally accepts honest
 * mandatory overflow (used > target within hardMax); C04 never rewrites
 * the requested target (no effective-target disguise); the PackingPlan
 * validator enforces used = mandatoryUsed + optionalUsed,
 * used <= hardMax, and used <= max(target, mandatoryUsed), so optional
 * content can never cause preferred-target overflow. Hand-crafted plan
 * vectors use the literal C04H numbers (target=100, hardMax=150);
 * pack-level vectors reuse a lean REAL C02-compiled fixture with the
 * REAL counter contract.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
function throwsWith(fn, fragment, name) {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  check(error !== null && String(error && error.message).indexOf(fragment) !== -1, name,
    error ? String(error.message).slice(0, 300) : 'did not throw');
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const NS = Object.freeze({
  taskId: 'TASK-C04-H',
  taskInstanceId: 'task_c04_h_0001',
  sessionId: 'sess-c04-h',
  workspaceId: '/tmp/nexus-c04-h',
  repositoryId: 'repo-c04-h',
  checkoutId: 'checkout-c04-h',
});
function checkpointInput() {
  return {
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 4, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove honest target overflow.', status: 'in-progress' },
    requirements: [{ id: 'R-h', text: 'Mandatory truth survives honestly.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C04H', remainingMilestones: [] },
    decisions: [{ id: 'D-h', statement: 'Honest budgets.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-h', status: 'open', detail: 'Gate flaked once.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'],
      retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry-after-flake' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Harden C04.', unresolvedQuestions: ['Approve honest overflow?'], recentUserIntent: 'Ship C04H.' },
  };
}
const CP = checkpoint.buildCheckpointV2(checkpointInput()).checkpoint;
const SNAP_REV = CP.snapshot.revisionDigest;
function stateDecisions() {
  return [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'R-h' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F-h' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-h' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
  ];
}
const COLD_PAGE = page.createContextPageV2({
  kind: 'verification', namespace: clone(NS), sourceKind: 'verification',
  sourceRefs: ['test-run:c04h:1'], mutability: 'immutable',
  sourceSeqs: [31], exactText: 'PASS suites=9 tests=81', createdAtGeneration: 1,
});
const D_COLD = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: COLD_PAGE });
const BASE_VIEW = compiler.compileContextV2({
  checkpoint: CP,
  currentTurn: { turnId: 't-h', text: 'Harden honestly.', revision: null },
  namespace: clone(NS),
  snapshotRevision: SNAP_REV,
  runtimeState: { pendingProtocol: null },
  pages: [COLD_PAGE],
  tierDecisions: stateDecisions().concat([D_COLD]),
  evidenceRefs: [],
  exactMaterial: [],
  toolTransactions: [],
  budget: { hardMax: 8000, target: 6000 },
  compilerPolicyRevision: 'context-compiler-v1',
}).view;
function testCounter() { return counterModule.createCodepointTestCounterV2(); }
function pack(baselineView, hardMax, target) {
  return allocator.packContextBudgetV2({
    view: baselineView, budget: { hardMax, target }, counter: testCounter(),
  });
}
const MAND = allocator.calculateContextTokenUsageV2({ view: BASE_VIEW, counter: testCounter() }).mandatoryUsed;
function craftPlan(overrides) {
  const base = {
    schemaVersion: 1,
    tokenizerFingerprint: 'test-codepoint-v1',
    packingPolicyRevision: 'context-budget-packer-v1',
    compilerPolicyRevision: 'context-compiler-v1',
    hardMax: 150,
    target: 100,
    mandatoryUsed: 80,
    optionalUsed: 0,
    used: 80,
    referenceMetadataCount: 0,
    keptMaterialIds: ['cxm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    referencedPageIds: [],
    omittedMaterialIds: [],
    decisions: [{
      materialId: 'cxm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tier: 'HOT', mandatory: true,
      action: 'KEEP', tokens: 80, reasonCode: 'packing-mandatory-kept', deterministic: true,
    }],
    deterministic: true,
    planDigest: null,
  };
  const plan = Object.assign(base, overrides || {});
  plan.planDigest = allocator.derivePackingPlanDigestV2(plan);
  return plan;
}
section('C04H HONEST MANDATORY OVERFLOW');
{
  check(MAND > 0, 'fixture carries mandatory cost', String(MAND));
  const result = pack(BASE_VIEW, 8000, MAND - 1);
  check(result.plan.used === MAND && result.plan.optionalUsed === 0, 'overflow pack keeps mandatory only');
  check(result.packedView.tokenBudget.target === MAND - 1, 'packed view keeps the requested target');
  check(result.packedView.tokenBudget.used === MAND, 'packed view honestly exposes used > target');
  check(result.packedView.tokenBudget.hardMax === 8000, 'hardMax unchanged');
  check(view.validateContextViewV2(result.packedView).valid === true, 'honest overflow view is C01-valid');
  check(result.plan.effectiveTarget === undefined, 'no effective target survives anywhere');
  const twice = pack(BASE_VIEW, 8000, MAND - 1);
  check(JSON.stringify(twice.plan) === JSON.stringify(result.plan), 'honest overflow is deterministic');
}
section('C04H ZERO TARGET');
{
  const result = pack(BASE_VIEW, 8000, 0);
  check(result.plan.used === MAND && result.plan.optionalUsed === 0, 'zero target retains mandatory truth');
  check(result.packedView.tokenBudget.target === 0, 'target remains 0');
  check(view.validateContextViewV2(result.packedView).valid === true, 'zero-target overflow view is C01-valid');
  const described = allocator.describeContextPackingPlanV2(result.plan);
  check(described.targetUtilization === null, 'zero-target utilization stays explicit null');
  check(described.mandatoryTargetOverflowTokens === MAND, 'overflow metric equals mandatory excess at zero target');
}
section('C04H OPTIONAL OVERFLOW REJECTION');
{
  const usage = allocator.calculateContextTokenUsageV2({ view: BASE_VIEW, counter: testCounter() });
  const optionals = usage.costs.filter(function (c) { return c.mandatory !== true; });
  check(optionals.length > 0, 'fixture carries optional material');
  const first = optionals[0];
  const exact = pack(BASE_VIEW, 8000, MAND + first.tokens);
  const kept = exact.plan.decisions.filter(function (d) { return d.materialId === first.materialId; })[0];
  check(kept.action === 'KEEP' && exact.plan.used === MAND + first.tokens, 'exact optional fit keeps the entry');
  if (first.tokens >= 1) {
    const over = pack(BASE_VIEW, 8000, MAND + first.tokens - 1);
    const blocked = over.plan.decisions.filter(function (d) { return d.materialId === first.materialId; })[0];
    check(blocked.action !== 'KEEP' && over.plan.used <= MAND + first.tokens - 1, 'optional never pushes used past target');
  }
  let sweepOk = true;
  for (let target = 0; target <= MAND + 50; target += 7) {
    const r = pack(BASE_VIEW, 8000, target);
    if (r.plan.used > Math.max(target, MAND)) sweepOk = false;
    if (r.plan.used > target && r.plan.optionalUsed !== 0) sweepOk = false;
    if (r.packedView.tokenBudget.target !== target) sweepOk = false;
  }
  check(sweepOk, 'sweep proves optional never causes overflow and target never rewrites');
}
section('C04H MANDATORY LIMITS');
{
  const atTarget = pack(BASE_VIEW, 8000, MAND);
  check(atTarget.plan.used === MAND && atTarget.plan.optionalUsed === 0, 'mandatory at target is exact');
  const atHardMax = pack(BASE_VIEW, MAND, 0);
  check(atHardMax.plan.used === MAND && atHardMax.packedView.tokenBudget.hardMax === MAND, 'mandatory at hardMax passes');
  check(atHardMax.packedView.tokenBudget.target === 0, 'hardMax pack keeps the lower requested target');
  throwsWith(function () { pack(BASE_VIEW, MAND - 1, 0); }, 'compiler-mandatory-over-budget', 'mandatory hardMax+1 fails closed');
  let emitted = null;
  try { emitted = pack(BASE_VIEW, MAND - 1, 0); } catch (e) { emitted = null; }
  check(emitted === null, 'hardMax overflow emits no view');
}
section('C04H PLAN VALIDATOR VECTORS');
{
  const forged = craftPlan({
    mandatoryUsed: 80, optionalUsed: 30, used: 110,
    keptMaterialIds: ['cxm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'cxm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    decisions: [
      {
        materialId: 'cxm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tier: 'HOT', mandatory: true,
        action: 'KEEP', tokens: 80, reasonCode: 'packing-mandatory-kept', deterministic: true,
      },
      {
        materialId: 'cxm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', tier: 'WARM', mandatory: false,
        action: 'KEEP', tokens: 30, reasonCode: 'packing-warm-kept', deterministic: true,
      },
    ],
  });
  check(allocator.validateContextPackingPlanV2(forged).valid === false, 'forged optional overflow fails even within hardMax');
  const legit = craftPlan({
    mandatoryUsed: 110, optionalUsed: 0, used: 110,
    keptMaterialIds: ['cxm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    decisions: [{
      materialId: 'cxm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tier: 'HOT', mandatory: true,
      action: 'KEEP', tokens: 110, reasonCode: 'packing-mandatory-kept', deterministic: true,
    }],
  });
  check(allocator.validateContextPackingPlanV2(legit).valid === true, 'legitimate mandatory overflow passes');
  const overHard = craftPlan({
    mandatoryUsed: 160, optionalUsed: 0, used: 160,
    keptMaterialIds: ['cxm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    decisions: [{
      materialId: 'cxm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tier: 'HOT', mandatory: true,
      action: 'KEEP', tokens: 160, reasonCode: 'packing-mandatory-kept', deterministic: true,
    }],
  });
  check(allocator.validateContextPackingPlanV2(overHard).valid === false, 'used above hardMax fails plan validation');
  const fit = craftPlan({
    mandatoryUsed: 90, optionalUsed: 10, used: 100,
    keptMaterialIds: ['cxm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'cxm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    decisions: [
      {
        materialId: 'cxm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tier: 'HOT', mandatory: true,
        action: 'KEEP', tokens: 90, reasonCode: 'packing-mandatory-kept', deterministic: true,
      },
      {
        materialId: 'cxm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', tier: 'WARM', mandatory: false,
        action: 'KEEP', tokens: 10, reasonCode: 'packing-warm-kept', deterministic: true,
      },
    ],
  });
  check(allocator.validateContextPackingPlanV2(fit).valid === true, 'exact optional fit validates at the boundary');
  const retargeted = clone(legit);
  retargeted.target = 90;
  check(allocator.validateContextPackingPlanV2(retargeted).valid === false, 'plan digest binds the requested target');
  check(legit.packingPolicyRevision === 'context-budget-packer-v1', 'pre-freeze correction retains v1 (documented)');
}
section('C04H METRICS HONESTY');
{
  const result = pack(BASE_VIEW, 8000, MAND - 1);
  const described = allocator.describeContextPackingPlanV2(result.plan);
  check(described.target === MAND - 1, 'metrics use the real requested target');
  check(described.targetUtilization > 1, 'mandatory overflow utilization honestly exceeds 1.0', String(described.targetUtilization));
  check(described.targetUtilization === Math.round(MAND / (MAND - 1) * 10000) / 10000, 'utilization is exact arithmetic, not renormalization');
  check(described.hardMaxUtilization <= 1, 'hardMax utilization stays bounded');
  check(described.mandatoryTargetOverflowTokens === MAND - (MAND - 1), 'overflow metric is exact');
}
console.log('ContextBudgetAllocatorV2H suite: ' + passed + ' passed, ' + failed + ' failed.');
if (failed > 0) { process.exit(1); }
