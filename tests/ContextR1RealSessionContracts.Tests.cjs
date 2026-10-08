'use strict';
/**
 * ContextR1RealSessionContracts.Tests.cjs - CCV2-R1 real-session contract gate.
 *
 * Proves the R1 amendments against the REAL production authorities (no
 * fakes): A03 authority completeness, A07 checkpointability, B04
 * retentionRequired + structural historical transition, C01 R1 bounds,
 * C02 WARM_EXACT (inline and B03 blob-route) materialization, C04
 * retention-required hardMax precedence, C05 EXACT-only required material,
 * C07/C07H real-session read bounds, and a session-scale end-to-end
 * fixture (1500+ durable units, 684+ tool transactions, >256 WARM, >512
 * referenced COLD, >1024 plan sources, >1 MiB view, UNRECORDED_LEGACY
 * categories, required WARM byte-bearing conversation units).
 *
 * Every changed limit is proven at limit-1 (accepted), limit (accepted),
 * limit+1 (deterministic fail-closed).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const cfg = (name) => require(path.join(repoRoot, 'config', name));
const checkpoint = cfg('ContextCheckpointV2.cjs');
const gate = cfg('ContextCheckpointabilityV2.cjs');
const snapshotV2 = cfg('ContextSnapshotV2.cjs');
const trustV2 = cfg('ContextTrustV2.cjs');
const page = cfg('ContextPageV2.cjs');
const store = cfg('ContextPageStoreV2.cjs');
const tier = cfg('ContextMemoryTierV2.cjs');
const view = cfg('ContextViewV2.cjs');
const compiler = cfg('ContextCompilerV2.cjs');
const allocator = cfg('ContextBudgetAllocatorV2.cjs');
const ladder = cfg('ContextCompressionLadderV2.cjs');
const layoutV2 = cfg('ContextPromptLayoutV2.cjs');
const counterV2 = cfg('ContextTokenCounterV2.cjs');
const rehydration = cfg('ContextEvidenceRehydrationV2.cjs');
const memSession = cfg('ContextSessionEvidenceSourceV2.cjs');
const shadowV2 = cfg('ContextCompilerShadowV2.cjs');
const shadowHost = cfg('ContextCompilerShadowHostV2.cjs');

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log('\n--- ' + title + ' ---'); }
function throwsWith(fn, fragment, name) {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  check(error !== null && String(error && error.message).indexOf(fragment) !== -1, name,
    error ? String(error.message).slice(0, 300) : 'did not throw');
}
function noThrow(fn, name) {
  let error = null;
  let value = null;
  try { value = fn(); } catch (e) { error = e; }
  check(error === null, name, error ? String(error.message).slice(0, 300) : undefined);
  return value;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const CREATED = '2026-09-29T10:00:00.000Z';

const NS = Object.freeze({
  taskId: 'TASK-R1',
  taskInstanceId: 'task_r1_0001',
  sessionId: 'sess-r1',
  workspaceId: '/tmp/nexus-r1',
  repositoryId: 'repo-r1',
  checkoutId: 'checkout-r1',
});

const LEGACY_COMPLETENESS = Object.freeze({
  origin: 'LEGACY_BOOTSTRAP',
  objective: 'COMPLETE',
  requirements: 'COMPLETE',
  constraints: 'UNRECORDED_LEGACY',
  progress: 'UNRECORDED_LEGACY',
  decisions: 'UNRECORDED_LEGACY',
  failures: 'COMPLETE',
  verification: 'COMPLETE',
  continuation: 'UNRECORDED_LEGACY',
});
const NATIVE_COMPLETENESS = Object.freeze({
  origin: 'NATIVE',
  objective: 'COMPLETE',
  requirements: 'COMPLETE',
  constraints: 'COMPLETE',
  progress: 'COMPLETE',
  decisions: 'COMPLETE',
  failures: 'COMPLETE',
  verification: 'COMPLETE',
  continuation: 'COMPLETE',
});

function checkpointInput(extra) {
  return Object.assign({
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: CREATED,
    objective: { text: 'Prove the R1 real-session contracts.', status: 'implementing' },
    requirements: [],
    constraints: [],
    progress: { taskStatus: 'implementing', completedMilestones: [], currentMilestone: null, remainingMilestones: [] },
    decisions: [],
    repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: null, baseCommit: 'abc', cleanWorktree: null, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: { activeFailures: [], rejectedHypotheses: [], retryState: null },
    verification: { outcomes: [] },
    continuation: { nextAction: null, unresolvedQuestions: [], recentUserIntent: null },
  }, extra || {});
}

// ============================================================================
section('A03 AUTHORITY COMPLETENESS');
{
  const legacy = checkpoint.buildCheckpointV2(checkpointInput({ authorityCompleteness: clone(LEGACY_COMPLETENESS) }));
  check(checkpoint.validateCheckpointV2(legacy.checkpoint).valid === true, 'legacy completeness checkpoint validates');
  check(legacy.checkpoint.constraints.length === 0 && legacy.checkpoint.authorityCompleteness.constraints === 'UNRECORDED_LEGACY',
    'constraints=[] + UNRECORDED_LEGACY is representable');
  check(checkpoint.authorityCategoryCompleteV2(legacy.checkpoint, 'constraints') === false,
    'UNRECORDED_LEGACY constraints never read as complete');
  check(checkpoint.authorityCategoryCompleteV2(legacy.checkpoint, 'requirements') === true,
    'COMPLETE requirements with [] asserts authoritative emptiness');
  const pre = checkpoint.buildCheckpointV2(checkpointInput());
  check(!Object.prototype.hasOwnProperty.call(pre.checkpoint, 'authorityCompleteness'), 'absent completeness omits the key (pre-R1 shape)');
  check(checkpoint.authorityCategoryCompleteV2(pre.checkpoint, 'requirements') === false, 'absence is never read as completeness');
  check(pre.contentDigest !== legacy.contentDigest, 'completeness participates in the content digest');
  const again = checkpoint.buildCheckpointV2(checkpointInput({ authorityCompleteness: clone(LEGACY_COMPLETENESS) }));
  check(again.serialized === legacy.serialized, 'completeness build is deterministic');
  const native = checkpoint.buildCheckpointV2(checkpointInput({ authorityCompleteness: clone(NATIVE_COMPLETENESS) }));
  check(checkpoint.authorityCategoryCompleteV2(native.checkpoint, 'decisions') === true, 'native decisions=[] COMPLETE means no active decisions');
  const bad = [
    ['unknown key', Object.assign(clone(LEGACY_COMPLETENESS), { extra: 'COMPLETE' })],
    ['unknown value', Object.assign(clone(LEGACY_COMPLETENESS), { progress: 'PARTIAL' })],
    ['missing category', (() => { const c = clone(LEGACY_COMPLETENESS); delete c.failures; return c; })()],
    ['unknown origin', Object.assign(clone(LEGACY_COMPLETENESS), { origin: 'GUESSED' })],
    ['objective unrecorded', Object.assign(clone(LEGACY_COMPLETENESS), { objective: 'UNRECORDED_LEGACY' })],
    ['requirements unrecorded', Object.assign(clone(LEGACY_COMPLETENESS), { requirements: 'UNRECORDED_LEGACY' })],
    ['native degraded', Object.assign(clone(NATIVE_COMPLETENESS), { constraints: 'UNRECORDED_LEGACY' })],
  ];
  for (const [name, value] of bad) {
    throwsWith(() => checkpoint.buildCheckpointV2(checkpointInput({ authorityCompleteness: value })),
      'checkpoint-authority-completeness-invalid', 'builder fails closed: ' + name);
    const forged = clone(legacy.checkpoint);
    forged.authorityCompleteness = value;
    check(checkpoint.validateCheckpointV2(forged).reason === 'checkpoint-authority-completeness-invalid',
      'validator fails closed before digest: ' + name);
  }
  const tampered = clone(legacy.checkpoint);
  tampered.authorityCompleteness.decisions = 'COMPLETE';
  check(checkpoint.validateCheckpointV2(tampered).reason === 'checkpoint-content-digest-mismatch',
    'upgrading UNRECORDED_LEGACY to COMPLETE after build breaks the digest');
}

// ============================================================================
section('A07 CHECKPOINTABILITY');
function taskStateOf(completeness, overrides) {
  const ts = Object.assign({
    schemaVersion: 1,
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    generation: 1, safePointBoundarySeq: 9, sessionRevision: 9, taskRevision: 'pending',
    repositoryRevision: { headCommit: null, indexDigest: null, worktreeDigest: null },
    runtimeRevision: { runtimeSnapshotSeq: null },
    objective: { text: 'Prove the R1 real-session contracts.', status: 'implementing' },
    requirements: [], constraints: [],
    progress: { taskStatus: 'implementing', completedMilestones: [], currentMilestone: null, remainingMilestones: [] },
    decisions: [],
    repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: null, baseCommit: 'abc', cleanWorktree: null, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: { activeFailures: [], rejectedHypotheses: [], retryState: null },
    verification: { outcomes: [], note: null },
    continuation: { nextAction: null, unresolvedQuestions: [], recentUserIntent: null },
    provenance: {
      'objective.text': { sourceKind: 'controller', fieldKind: 'task-objective', sourceRefs: ['controller:objective'], authorityScope: null },
      repository: { sourceKind: 'repository', fieldKind: 'repository-fact', sourceRefs: ['repository:HEAD'], authorityScope: null },
    },
    ephemeralState: [], unsupportedState: [], reconstructionRefs: [],
  }, overrides || {});
  if (completeness !== null) ts.authorityCompleteness = clone(completeness);
  ts.taskRevision = snapshotV2.deriveTaskRevision(ts);
  return ts;
}
function tokenOf(ts) {
  return snapshotV2.capture({
    taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId,
    workspaceId: ts.workspaceId, repositoryId: ts.repositoryId, checkoutId: ts.checkoutId,
    generation: ts.generation, safePointBoundarySeq: ts.safePointBoundarySeq,
    sessionRevision: ts.sessionRevision, taskRevision: ts.taskRevision,
    repositoryRevision: clone(ts.repositoryRevision), runtimeRevision: null,
  }, CREATED);
}
function safeOf(ts) {
  return {
    schemaVersion: 1, safe: true, boundarySeq: ts.safePointBoundarySeq, boundaryKind: 'assistant-turn-committed',
    blockers: [], inspectedRevision: { taskRevision: ts.taskRevision, sessionRevision: ts.sessionRevision, runtimeSnapshotId: null },
  };
}
function evaluate(ts) {
  return gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safeOf(ts), snapshotToken: tokenOf(ts) });
}
{
  const legacyTs = taskStateOf(LEGACY_COMPLETENESS);
  const legacyDecision = evaluate(legacyTs);
  check(legacyDecision.checkpointable === true, 'legacy UNRECORDED_LEGACY state (empty continuation) is checkpointable',
    JSON.stringify(legacyDecision.blockers));
  const preTs = taskStateOf(null);
  const preDecision = evaluate(preTs);
  check(preDecision.checkpointable === false
    && preDecision.blockers.some((b) => b.code === 'checkpointability-continuation-incomplete'),
  'pre-R1 state without completeness keeps the frozen continuation blocker');
  const nativeEmpty = evaluate(taskStateOf(NATIVE_COMPLETENESS));
  check(nativeEmpty.blockers.some((b) => b.code === 'checkpointability-continuation-incomplete'),
    'native COMPLETE empty continuation still blocks (no waiver)');
  const nativeOk = evaluate(taskStateOf(NATIVE_COMPLETENESS, {
    continuation: { nextAction: 'Continue R1.', unresolvedQuestions: [], recentUserIntent: null },
    provenance: {
      'objective.text': { sourceKind: 'controller', fieldKind: 'task-objective', sourceRefs: ['controller:objective'], authorityScope: null },
      repository: { sourceKind: 'repository', fieldKind: 'repository-fact', sourceRefs: ['repository:HEAD'], authorityScope: null },
      'continuation.nextAction': { sourceKind: 'controller', fieldKind: 'next-action', sourceRefs: ['controller:continuation'], authorityScope: null },
    },
  }));
  check(nativeOk.checkpointable === true, 'native all-COMPLETE state is checkpointable', JSON.stringify(nativeOk.blockers));
  const degraded = evaluate(taskStateOf(Object.assign(clone(NATIVE_COMPLETENESS), { decisions: 'UNRECORDED_LEGACY' })));
  check(degraded.checkpointable === false
    && degraded.blockers.some((b) => b.code === 'checkpointability-authority-incomplete'),
  'native task silently degrading a category is NOT checkpointable');
  const objectiveGap = evaluate(taskStateOf(Object.assign(clone(LEGACY_COMPLETENESS), { objective: 'UNRECORDED_LEGACY' })));
  check(objectiveGap.blockers.some((b) => b.code === 'checkpointability-authority-incomplete'),
    'objective completeness is mandatory even for legacy bootstrap');
  const unsupported = evaluate(taskStateOf(LEGACY_COMPLETENESS, { unsupportedState: [{ stateKind: 'future-gate', stateId: 'g1' }] }));
  check(unsupported.blockers.some((b) => b.code === 'checkpointability-unsupported-authoritative-state'),
    'unsupportedState keeps its hard-blocking semantics alongside completeness');
  throwsWith(() => evaluate(taskStateOf(Object.assign(clone(LEGACY_COMPLETENESS), { bogus: 'COMPLETE' }))),
    'unknown taskState.authorityCompleteness field', 'unknown completeness key fails closed');
  throwsWith(() => evaluate(taskStateOf(Object.assign(clone(LEGACY_COMPLETENESS), { progress: 'MAYBE' }))),
    'must be a frozen completeness value', 'unknown completeness value fails closed');
  check(legacyDecision.requiredState.digest !== preDecision.requiredState.digest,
    'required-state digest binds declared completeness');
  // Post-build coverage: the sealed checkpoint must carry the evaluated completeness.
  const ts = legacyTs;
  const token = tokenOf(ts);
  const input = checkpointInput({
    safePointBoundarySeq: ts.safePointBoundarySeq, snapshotToken: token,
    authorityCompleteness: clone(LEGACY_COMPLETENESS),
  });
  const provenanceInputs = {
    'objective.text': { fieldKind: 'task-objective', sourceKind: 'controller', sourceRefs: ['controller:objective'], authorityScope: null },
    repository: { fieldKind: 'repository-fact', sourceKind: 'repository', sourceRefs: ['repository:HEAD'], authorityScope: null },
  };
  const sealed = trustV2.buildSealedCheckpointV2(input, provenanceInputs, { sealedAtUtc: CREATED });
  const coverage = gate.assertCheckpointCoverageV2({ schemaVersion: 1, taskState: ts, checkpoint: sealed.checkpoint, snapshotToken: token, safePointDecision: safeOf(ts) });
  check(coverage.ok === true, 'sealed legacy checkpoint covers the evaluated completeness', JSON.stringify(coverage.missing));
  const withoutCompleteness = trustV2.buildSealedCheckpointV2(checkpointInput({ safePointBoundarySeq: ts.safePointBoundarySeq, snapshotToken: token }), provenanceInputs, { sealedAtUtc: CREATED });
  const dropped = gate.assertCheckpointCoverageV2({ schemaVersion: 1, taskState: ts, checkpoint: withoutCompleteness.checkpoint, snapshotToken: token, safePointDecision: safeOf(ts) });
  check(dropped.ok === false && dropped.missing.indexOf('authority-completeness') !== -1,
    'a builder that drops completeness fails post-build coverage');
}

// ============================================================================
section('B04 RETENTION REQUIRED + HISTORICAL TRANSITION');
function convPage(seq, text, gen) {
  return page.createContextPageV2({
    kind: 'conversation', namespace: clone(NS), sourceKind: 'user',
    sourceRefs: ['session-event:' + seq], mutability: 'immutable',
    sourceSeqs: [seq], exactText: text, createdAtGeneration: gen || 1,
  });
}
function toolPage(seq, callId, text, gen) {
  return page.createContextPageV2({
    kind: 'tool-result', namespace: clone(NS), sourceKind: 'tool',
    sourceRefs: ['tool-event:' + callId], mutability: 'immutable',
    sourceSeqs: [seq, seq + 1, seq + 2], exactText: text, createdAtGeneration: gen || 1,
  });
}
{
  const conv = convPage(100, 'Historical user request that is still required.');
  const cold = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: conv });
  check(cold.tier === 'COLD' && cold.retentionRequired === undefined, 'unrequired byte-bearing history stays COLD (frozen)');
  const warm = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: conv, retentionRequired: true });
  check(warm.tier === 'WARM' && warm.reasonCode === 'tier-warm-retention-required' && warm.retentionRequired === true,
    'required byte-bearing conversation unit rests WARM exact');
  check(tier.validateMemoryTierDecisionV2(warm).valid === true, 'required WARM decision validates');
  const tool = toolPage(200, 'call-r1', 'exit 0 required tool');
  const hot = tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: tool, immediateRelevance: true, retentionRequired: true });
  check(hot.tier === 'HOT' && hot.retentionRequired === true, 'current-turn transaction HOT carries retentionRequired');
  const settled = tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: tool });
  check(settled.retentionRequired === undefined && Object.keys(settled).indexOf('retentionRequired') === -1,
    'legacy decisions keep the frozen key set (optional member absent)');
  const transitioned = tier.classifyMemoryTierV2({
    subjectKind: 'historical-evidence', page: tool,
    historicalTransition: { reason: 'checkpoint-superseded-unreferenced', supersededByGeneration: 3 },
  });
  check(transitioned.tier === 'COLD' && transitioned.historicalTransition.reason === 'checkpoint-superseded-unreferenced'
    && transitioned.historicalTransition.supersededByGeneration === 3, 'balanced transaction transitions whole to COLD with typed provenance');
  check(tier.validateMemoryTierDecisionV2(transitioned).valid === true, 'transition decision validates');
  check(tier.validateTierTransitionV2({ from: 'WARM', to: 'COLD', cause: 'checkpoint-superseded-unreferenced' }).valid === true,
    'WARM->COLD checkpoint-superseded-unreferenced is a legal closed-world cause');
  throwsWith(() => tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: conv, retentionRequired: 'yes' }),
    'retentionRequired must be boolean', 'prose requiredness fails closed');
  throwsWith(() => tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', retentionRequired: true }),
    'required-not-applicable', 'requiredness on state subjects fails closed');
  throwsWith(() => tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: conv, retentionRequired: true, mandatoryCorrectness: true }),
    'required-mandatory-conflict', 'mandatory and required stay distinct authorities');
  throwsWith(() => tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: conv, retentionRequired: true, historicalTransition: { reason: 'checkpoint-superseded-unreferenced', supersededByGeneration: 1 } }),
    'transition-not-applicable', 'a required unit cannot carry a historical transition');
  throwsWith(() => tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: conv, historicalTransition: { reason: 'aged-out', supersededByGeneration: 1 } }),
    'unknown-cause', 'recency-shaped transition causes fail closed');
  const forged = Object.assign({}, cold, { retentionRequired: true });
  check(tier.validateMemoryTierDecisionV2(forged).valid === false, 'COLD decision cannot claim retentionRequired');
  const forged2 = Object.assign({}, warm, { retentionRequired: false });
  check(tier.validateMemoryTierDecisionV2(forged2).valid === false, 'retentionRequired must be literal true when present');
  const forged3 = Object.assign({}, warm, { historicalTransition: { reason: 'checkpoint-superseded-unreferenced', supersededByGeneration: 1 } });
  check(tier.validateMemoryTierDecisionV2(forged3).valid === false, 'WARM decision cannot carry a historical transition');
}

// ============================================================================
section('C01 BOUNDS (limit-1 / limit / limit+1)');
const CP_LEGACY = checkpoint.buildCheckpointV2(checkpointInput({ authorityCompleteness: clone(LEGACY_COMPLETENESS) })).checkpoint;
const D_OBJECTIVE = tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP_LEGACY });
const D_TURN = tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP_LEGACY, exactPreservationRequired: true });
const PROV_USER = Object.freeze({ schemaVersion: 1, sourceKind: 'user', trust: 'user-intent', sourceRefs: ['session-event:1'], authorityScope: null, fieldKind: 'user-intent' });
const PROV_CTRL = Object.freeze({ schemaVersion: 1, sourceKind: 'controller', trust: 'authoritative', sourceRefs: ['controller:objective'], authorityScope: null, fieldKind: 'task-objective' });
function baseViewInput() {
  return {
    namespace: clone(NS),
    checkpointBinding: { checkpointGeneration: CP_LEGACY.generation, checkpointId: CP_LEGACY.checkpointId, checkpointContentHash: CP_LEGACY.checkpointContentDigest, snapshotRevision: null },
    turnRef: { turnId: 'live', revision: null },
    pinned: [], hot: [], warm: [], materializedCold: [], referencedColdPages: [],
    tokenBudget: { hardMax: 10000000, target: 10000000, used: null },
    compilerPolicyRevision: 'context-compiler-v1',
    compilationTrace: [],
    mandatoryRefs: [],
  };
}
function warmRequiredEntry(p, d) {
  return {
    tier: 'WARM', sourceType: 'context-page', sourceId: p.id, contentHash: p.contentHash,
    provenance: clone(p.provenance), mediaType: 'text', exactText: p.exactText, mandatory: false,
    tierDecision: clone(d), evidence: null, toolTransaction: null,
  };
}
// Pre-build N required WARM conversation entries once (reused by bounds).
const MAX_SECTION = view.VIEW_BOUNDS.sectionEntriesMax;
const WARM_POOL = [];
for (let i = 0; i < MAX_SECTION + 1; i += 1) {
  const p = convPage(10000 + i, 'Required WARM conversation unit number ' + i + '.');
  WARM_POOL.push(warmRequiredEntry(p, tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: p, retentionRequired: true })));
}
function viewWithWarm(count) {
  const input = baseViewInput();
  input.warm = WARM_POOL.slice(0, count).map((entry) => entry);
  return input;
}
check(MAX_SECTION === 8192 && view.VIEW_BOUNDS.referencedColdMax === 8192 && view.VIEW_BOUNDS.mandatoryRefsMax === 8192
  && view.VIEW_BOUNDS.traceEntriesMax === 16384 && view.VIEW_BOUNDS.viewMaxBytes === 16777216,
'C01 R1 bounds are the approved values');
noThrow(() => view.createContextViewV2(viewWithWarm(MAX_SECTION - 1)), 'section entries limit-1 accepted');
const FULL_WARM_VIEW = noThrow(() => view.createContextViewV2(viewWithWarm(MAX_SECTION)), 'section entries limit accepted');
throwsWith(() => view.createContextViewV2(viewWithWarm(MAX_SECTION + 1)), 'context-view-section-too-large', 'section entries limit+1 fails closed');
check(FULL_WARM_VIEW !== null && FULL_WARM_VIEW.warm.length === 8192, 'limit view keeps every entry (no silent truncation)');

function traceOf(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ pageId: null, action: 'LOAD', reasonCode: 'compiler-load-warm-history', deterministic: true });
  return out;
}
const TRACE_MAX = view.VIEW_BOUNDS.traceEntriesMax;
for (const [n, ok] of [[TRACE_MAX - 1, true], [TRACE_MAX, true], [TRACE_MAX + 1, false]]) {
  const input = viewWithWarm(1);
  input.compilationTrace = traceOf(n);
  if (ok) noThrow(() => view.createContextViewV2(input), 'trace entries ' + n + ' accepted');
  else throwsWith(() => view.createContextViewV2(input), 'context-view-trace-too-large', 'trace entries limit+1 fails closed');
}

// Referenced COLD bounds.
const COLD_REF_POOL = [];
for (let i = 0; i < view.VIEW_BOUNDS.referencedColdMax + 1; i += 1) {
  const p = convPage(40000 + i, 'Historical unreferenced unit ' + i + '.');
  const d = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: p, historicalTransition: { reason: 'checkpoint-superseded-unreferenced', supersededByGeneration: 2 } });
  COLD_REF_POOL.push({
    pageId: p.id, contentHash: p.contentHash, evidenceId: null, kind: p.kind, provenance: clone(p.provenance),
    exactResolutionMode: d.exactResolutionMode,
    namespace: { taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId },
    tierDecision: d,
  });
}
const REF_MAX = view.VIEW_BOUNDS.referencedColdMax;
for (const [n, ok] of [[REF_MAX - 1, true], [REF_MAX, true], [REF_MAX + 1, false]]) {
  const input = viewWithWarm(1);
  input.referencedColdPages = COLD_REF_POOL.slice(0, n);
  if (ok) noThrow(() => view.createContextViewV2(input), 'referenced COLD ' + n + ' accepted');
  else throwsWith(() => view.createContextViewV2(input), 'context-view-section-too-large', 'referenced COLD limit+1 fails closed');
}

// Per-entry exact-text bound (current turn is the largest single member).
const TEXT_MAX = view.VIEW_BOUNDS.exactTextMaxChars;
function turnView(chars) {
  const input = viewWithWarm(0);
  const text = 'u'.repeat(chars);
  input.hot.push({
    tier: 'HOT', sourceType: 'current-turn', sourceId: 'current-turn:live', contentHash: sha(text),
    provenance: clone(PROV_USER), mediaType: 'text', exactText: text, mandatory: true,
    tierDecision: clone(D_TURN), evidence: null, toolTransaction: null,
  });
  input.mandatoryRefs.push({ sourceId: 'current-turn:live', kind: 'current-turn', contentHash: sha(text) });
  return input;
}
// Mandatory refs bound: every ref needs one mandatory entry (PINNED
// objective-shaped state entries with distinct source identities).
const MAND_MAX = view.VIEW_BOUNDS.mandatoryRefsMax;
function mandatoryView(n) {
  // n-1 PINNED state slices + the mandatory current turn (HOT), so the
  // mandatory-ref bound is exercised without tripping the section bound.
  const input = turnView(16);
  for (let i = 0; i < n - 1; i += 1) {
    const text = 'Mandatory checkpoint state slice ' + i + '.';
    const sourceId = 'checkpoint:objective:' + i;
    input.pinned.push({
      tier: 'PINNED', sourceType: 'checkpoint-state', sourceId, contentHash: sha(text),
      provenance: clone(PROV_CTRL), mediaType: 'text', exactText: text, mandatory: true,
      tierDecision: clone(D_OBJECTIVE), evidence: null, toolTransaction: null,
    });
    input.mandatoryRefs.push({ sourceId, kind: 'checkpoint-element', contentHash: sha(text) });
  }
  return input;
}
for (const [n, ok] of [[MAND_MAX - 1, true], [MAND_MAX, true], [MAND_MAX + 1, false]]) {
  if (ok) noThrow(() => view.createContextViewV2(mandatoryView(n)), 'mandatory refs ' + n + ' accepted');
  else {
    throwsWith(() => view.createContextViewV2(mandatoryView(n)), 'context-view-mandatory-too-large', 'mandatory refs limit+1 fails closed');
  }
}

noThrow(() => view.createContextViewV2(turnView(TEXT_MAX - 1)), 'exact text limit-1 accepted');
noThrow(() => view.createContextViewV2(turnView(TEXT_MAX)), 'exact text limit accepted');
throwsWith(() => view.createContextViewV2(turnView(TEXT_MAX + 1)), 'context-view-material-too-large', 'exact text limit+1 fails closed');

// View byte bound: size exact bytes by padding the last WARM entry.
function sizedView(targetBytes) {
  const input = viewWithWarm(0);
  const chunk = 2000000;
  let i = 0;
  const bigPages = [];
  const add = (text) => {
    const p = page.createContextPageV2({
      kind: 'conversation', namespace: clone(NS), sourceKind: 'user', sourceRefs: ['session-event:' + (90000 + i)],
      mutability: 'immutable', sourceSeqs: [90000 + i], contentHash: sha(text), createdAtGeneration: 1,
    });
    i += 1;
    const d = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: p, retentionRequired: true });
    return { tier: 'WARM', sourceType: 'context-page', sourceId: p.id, contentHash: sha(text), provenance: clone(p.provenance), mediaType: 'text', exactText: text, mandatory: false, tierDecision: d, evidence: null, toolTransaction: null };
  };
  for (let k = 0; k < 8; k += 1) input.warm.push(add('w'.repeat(chunk)));
  const probe = view.canonicalizeContextViewV2 ? null : null;
  void probe;
  // measure with a 1-char pad entry, then resize it to hit the target
  input.warm.push(add('p'));
  const measure = () => Buffer.byteLength(JSON.stringify(checkpoint.canonicalize(Object.assign(clone(input), {
    schemaVersion: 1, disposable: true,
  }))), 'utf8');
  void measure;
  return { input, add, bigPages };
}
{
  // Build once, then find the exact size via the module's own structural gate.
  const VMAX = view.VIEW_BOUNDS.viewMaxBytes;
  const fixture = sizedView(VMAX);
  const base = fixture.input;
  const padIndex = base.warm.length - 1;
  const build = (padChars) => {
    const input = clone(base);
    const text = 'p'.repeat(padChars);
    const p = page.createContextPageV2({
      kind: 'conversation', namespace: clone(NS), sourceKind: 'user', sourceRefs: ['session-event:99999'],
      mutability: 'immutable', sourceSeqs: [99999], contentHash: sha(text), createdAtGeneration: 1,
    });
    const d = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: p, retentionRequired: true });
    input.warm[padIndex] = { tier: 'WARM', sourceType: 'context-page', sourceId: p.id, contentHash: sha(text), provenance: clone(p.provenance), mediaType: 'text', exactText: text, mandatory: false, tierDecision: d, evidence: null, toolTransaction: null };
    return input;
  };
  // Size with pad=1: the created view reports its canonical bytes through
  // validation; compute the canonical byte size of the identity-free body.
  const sizeOf = (input) => {
    const created = view.createContextViewV2(input);
    const body = {};
    for (const key of Object.keys(created)) if (key !== 'id' && key !== 'viewDigest') body[key] = created[key];
    return Buffer.byteLength(JSON.stringify(checkpoint.canonicalize(body)), 'utf8');
  };
  const size1 = sizeOf(build(1));
  const padFor = (target) => 1 + (target - size1);
  check(sizeOf(build(padFor(VMAX - 1))) === VMAX - 1, 'view bytes limit-1 accepted (exactly ' + (VMAX - 1) + ')');
  check(sizeOf(build(padFor(VMAX))) === VMAX, 'view bytes limit accepted (exactly ' + VMAX + ')');
  throwsWith(() => view.createContextViewV2(build(padFor(VMAX + 1))), 'context-view-too-large', 'view bytes limit+1 fails closed');
}

// ============================================================================
section('C02/C04/C05 WARM_EXACT + RETENTION REQUIRED');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-r1-'));
const CTX_ROOT = store.contextRootForV2(TMP, NS.taskId);
fs.mkdirSync(CTX_ROOT, { recursive: true });
function blobConvPage(seq, text) {
  const put = store.putBlobV2(CTX_ROOT, text);
  const p = page.createContextPageV2({
    kind: 'conversation', namespace: clone(NS), sourceKind: 'user', sourceRefs: ['session-event:' + seq],
    mutability: 'immutable', sourceSeqs: [seq], exactBlobRef: put.blobRef, contentHash: put.digest, createdAtGeneration: 1,
  });
  store.putContextPageV2(CTX_ROOT, p, { expectedNamespace: clone(NS) });
  return p;
}
function stateDecisions(cp) {
  return [
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: cp }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: cp, exactPreservationRequired: true }),
  ];
}
function compileWith(pages, decisions, exactMaterial, budget, txs) {
  return compiler.compileContextV2({
    checkpoint: CP_LEGACY,
    currentTurn: { turnId: 'live', text: 'Continue R1.', revision: null },
    namespace: clone(NS),
    snapshotRevision: null,
    runtimeState: { pendingProtocol: null },
    pages, tierDecisions: stateDecisions(CP_LEGACY).concat(decisions),
    evidenceRefs: [], exactMaterial: exactMaterial || [], toolTransactions: txs || [],
    budget: budget || { hardMax: 10000000, target: 10000000 },
    compilerPolicyRevision: 'context-compiler-v1',
  });
}
{
  const bigText = 'Large required historical user request. '.repeat(400);
  const blobPage = blobConvPage(300, bigText);
  const inlinePage = convPage(301, 'Small required historical user request.');
  const dBlob = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: blobPage, retentionRequired: true });
  const dInline = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: inlinePage, retentionRequired: true });
  check(dBlob.tier === 'WARM' && dBlob.resolution.mode === 'durable-blob', 'blob-backed required unit is WARM with durable-blob backing');
  throwsWith(() => compileWith([blobPage, inlinePage], [dBlob, dInline], []), 'context-compiler-required-unavailable',
    'required WARM blob bytes without a B03 proof fail closed (never silently deferred)');
  const proof = rehydration.rehydrateContextPageV2({ contextRoot: CTX_ROOT, pageId: blobPage.id, expectedNamespace: clone(NS) });
  const compiled = compileWith([blobPage, inlinePage], [dBlob, dInline], [proof]);
  const warmIds = compiled.view.warm.map((entry) => entry.sourceId);
  check(warmIds.indexOf(blobPage.id) !== -1 && warmIds.indexOf(inlinePage.id) !== -1, 'WARM_EXACT: byte-bearing required units materialize');
  const blobEntry = compiled.view.warm.find((entry) => entry.sourceId === blobPage.id);
  check(blobEntry.exactText === bigText.trim() || sha(blobEntry.exactText) === blobPage.contentHash, 'blob WARM bytes are exact (hash-bound)');
  check(blobEntry.tierDecision.retentionRequired === true, 'materialized entry carries the retentionRequired decision');
  check(warmIds.indexOf(blobPage.id) < warmIds.indexOf(inlinePage.id), 'required WARM pages keep canonical source order (seq 300 before 301)');
  const forgedProof = rehydration.rehydrateContextPageV2({ contextRoot: CTX_ROOT, pageId: blobPage.id, expectedNamespace: clone(NS) });
  const otherBlob = blobConvPage(302, 'Another required blob body. '.repeat(400));
  const dOther = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: otherBlob, retentionRequired: true });
  const wrongProof = JSON.parse(JSON.stringify(forgedProof));
  check(rehydration.validateRehydratedEvidenceV2(wrongProof).valid === false, 'a copied (brand-less) proof is not a B03 proof');
  throwsWith(() => compileWith([otherBlob], [dOther], [forgedProof]), 'context-compiler-required-unavailable',
    'a proof for another page cannot supply bytes');
  throwsWith(() => compileWith([otherBlob, blobPage], [dOther, dBlob], [forgedProof]), 'context-compiler-required-unavailable',
    'each required page needs its own bound proof');

  // C04: required material exceeds target but fits hardMax -> kept; optional COLD referenced.
  const counter = counterV2.createCodepointTestCounterV2();
  const coldPage = convPage(303, 'Unrequired historical note that may be referenced.');
  const dCold = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: coldPage, historicalTransition: { reason: 'checkpoint-superseded-unreferenced', supersededByGeneration: 1 } });
  const full = compileWith([blobPage, inlinePage, coldPage], [dBlob, dInline, dCold], [proof]);
  const usage = allocator.calculateContextTokenUsageV2({ view: full.view, counter });
  check(usage.requiredCount === 2, 'usage counts two retention-required entries');
  const target = usage.mandatoryUsed + 10;
  const packed = allocator.packContextBudgetV2({ view: full.view, budget: { hardMax: usage.mandatoryUsed + usage.requiredUsed + 5, target }, counter });
  check(packed.plan.keptMaterialIds.length >= 4 && packed.plan.requiredUsed === usage.requiredUsed,
    'required WARM kept above target with correctness precedence');
  check(packed.plan.used > packed.plan.target && packed.plan.used <= packed.plan.hardMax, 'target overflow is legal, hardMax never exceeded');
  check(packed.plan.decisions.filter((d) => d.reasonCode === 'packing-required-kept').length === 2, 'required keeps carry packing-required-kept');
  check(packed.plan.decisions.filter((d) => d.mandatory === true).every((d) => d.reasonCode === 'packing-mandatory-kept'),
    'mandatory and required stay distinct in the plan');
  check(allocator.validateContextPackingPlanV2(packed.plan).valid === true, 'required-bearing plan validates');
  throwsWith(() => allocator.packContextBudgetV2({ view: full.view, budget: { hardMax: usage.mandatoryUsed + usage.requiredUsed - 1, target: usage.mandatoryUsed }, counter }),
    'compiler-required-over-budget', 'required material alone over hardMax fails closed');
  noThrow(() => allocator.packContextBudgetV2({ view: full.view, budget: { hardMax: usage.mandatoryUsed + usage.requiredUsed, target: usage.mandatoryUsed }, counter }),
    'required material exactly at hardMax packs');
  const forgedPlan = clone(packed.plan);
  forgedPlan.requiredUsed = 0;
  forgedPlan.planDigest = allocator.derivePackingPlanDigestV2(forgedPlan);
  check(allocator.validateContextPackingPlanV2(forgedPlan).valid === false, 'forged requiredUsed fails plan validation');
  const legacyPlan = allocator.packContextBudgetV2({ view: compileWith([coldPage], [dCold]).view, budget: { hardMax: 100000, target: 90000 }, counter });
  check(!Object.prototype.hasOwnProperty.call(legacyPlan.plan, 'requiredUsed'), 'plans without required material keep the frozen key set');

  // C05: required material stays EXACT and never becomes REFERENCE.
  const compressed = ladder.compressContextViewV2({ view: full.view, pages: [blobPage, inlinePage, coldPage], budget: { hardMax: usage.mandatoryUsed + usage.requiredUsed + 5, target }, counter });
  const reqSources = compressed.compressionPlan.sources.filter((s) => s.sourceId === blobPage.id || s.sourceId === inlinePage.id);
  check(reqSources.length === 2 && reqSources.every((s) => s.selectedKind === 'EXACT' && s.finalDisposition === 'KEPT'
    && s.reasonCode === 'compression-exact-retention-required'), 'C05 holds required WARM EXACT and KEPT');
  throwsWith(() => ladder.compressContextViewV2({ view: full.view, pages: [blobPage, inlinePage, coldPage], budget: { hardMax: usage.mandatoryUsed + usage.requiredUsed - 1, target: usage.mandatoryUsed }, counter }),
    'compiler-required-over-budget', 'C05 never rescues required overflow');
}

// ============================================================================
section('C02 CURRENT-TURN BOUND');
{
  const input = (chars) => ({
    checkpoint: CP_LEGACY, currentTurn: { turnId: 'live', text: 't'.repeat(chars), revision: null },
    namespace: clone(NS), snapshotRevision: null, runtimeState: { pendingProtocol: null },
    pages: [], tierDecisions: stateDecisions(CP_LEGACY), evidenceRefs: [], exactMaterial: [], toolTransactions: [],
    budget: { hardMax: 10000000, target: 10000000 }, compilerPolicyRevision: 'context-compiler-v1',
  });
  noThrow(() => compiler.compileContextV2(input(8193)), 'a real >8192-char current turn compiles (old bound superseded)');
  noThrow(() => compiler.compileContextV2(input(TEXT_MAX)), 'current turn at the C01 bound compiles');
  throwsWith(() => compiler.compileContextV2(input(TEXT_MAX + 1)), 'currentTurn.text exceeds the exact-text bound', 'current turn limit+1 fails closed');
}

// ============================================================================
section('C05 PLAN SOURCES BOUND');
{
  const PS = ladder.COMPRESSION_BOUNDS.planSourcesMax;
  check(PS === 16384, 'planSourcesMax is the approved R1 value');
  const baseline = compileWith([], []);
  const compressed = ladder.compressContextViewV2({ view: baseline.view, pages: [], budget: { hardMax: 10000000, target: 10000000 }, counter: counterV2.createCodepointTestCounterV2() });
  const planOf = (n) => {
    const plan = clone(compressed.compressionPlan);
    const template = plan.sources[0];
    plan.sources = [];
    for (let i = 0; i < n; i += 1) plan.sources.push(Object.assign(clone(template), { sourceId: template.sourceId + ':' + i }));
    plan.planDigest = ladder.deriveCompressionPlanDigestV2(plan);
    return plan;
  };
  for (const [n, ok] of [[PS - 1, true], [PS, true], [PS + 1, false]]) {
    const result = ladder.validateCompressionPlanV2(planOf(n));
    check(ok ? result.valid === true : (result.valid === false), 'plan sources ' + n + (ok ? ' accepted' : ' fails closed'), JSON.stringify(result));
  }
}

// ============================================================================
section('C07/C07H REAL-SESSION READ BOUNDS');
{
  const B = shadowHost.READ_BOUNDS;
  check(B.pagesMax === 8192 && B.toolTxMax === 8192 && B.decisionsMax === 16384, 'C07H bounds are the approved R1 values');
  const memDir = path.join(TMP, 'mem');
  const pagesDir = path.join(memDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  const triple = { taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId };
  const writePages = (n) => {
    fs.rmSync(pagesDir, { recursive: true, force: true });
    fs.mkdirSync(pagesDir, { recursive: true });
    for (let i = 0; i < n; i += 1) {
      const p = WARM_POOL[i % WARM_POOL.length];
      const source = i < WARM_POOL.length ? null : convPage(60000 + i, 'Extra unit ' + i);
      if (source === null) {
        const pageObj = page.createContextPageV2({
          kind: 'conversation', namespace: clone(NS), sourceKind: 'user', sourceRefs: ['session-event:' + (10000 + i)],
          mutability: 'immutable', sourceSeqs: [10000 + i], exactText: p.exactText, createdAtGeneration: 1,
        });
        fs.writeFileSync(path.join(pagesDir, pageObj.id + '.json'), JSON.stringify(pageObj));
      } else {
        fs.writeFileSync(path.join(pagesDir, source.id + '.json'), JSON.stringify(source));
      }
    }
  };
  for (const [n, ok] of [[B.pagesMax - 1, true], [B.pagesMax, true], [B.pagesMax + 1, false]]) {
    writePages(n);
    const read = shadowHost.readStagedPagesV2(memDir, triple);
    if (ok) check(read.pages !== null && read.pages.length === n, 'C07H reads ' + n + ' staged pages');
    else check(read.pages === null && read.skipped === 'shadow-pages-oversize', 'C07H pages limit+1 skips closed (never truncates)');
  }
  const txFile = path.join(memDir, 'tool-transactions.json');
  const txOf = (n) => {
    const out = [];
    for (let i = 0; i < n; i += 1) out.push({ pageId: 'cxp_' + sha('tx' + i).slice(0, 32), callId: 'call-' + i, callSeq: i * 3, resultSeq: i * 3 + 2 });
    return out;
  };
  for (const [n, ok] of [[B.toolTxMax - 1, true], [B.toolTxMax, true], [B.toolTxMax + 1, false]]) {
    fs.writeFileSync(txFile, JSON.stringify(txOf(n)));
    const read = shadowHost.readStagedToolTransactionsV2(memDir);
    if (ok) check(read.transactions !== null && read.transactions.length === n, 'C07H reads ' + n + ' tool transactions');
    else check(read.transactions === null, 'C07H tool transactions limit+1 skips closed');
  }
  const decisionFile = path.join(memDir, 'tier-decisions.json');
  const oneDecision = WARM_POOL[0].tierDecision;
  for (const [n, ok] of [[B.decisionsMax - 1, true], [B.decisionsMax, true], [B.decisionsMax + 1, false]]) {
    const list = [];
    for (let i = 0; i < n; i += 1) list.push(oneDecision);
    fs.writeFileSync(decisionFile, JSON.stringify(list));
    const read = shadowHost.readStagedDecisionsV2(memDir, triple);
    if (ok) check(read.decisions !== null && read.decisions.length === n, 'C07H reads ' + n + ' tier decisions');
    else check(read.decisions === null && read.skipped === 'shadow-tier-decisions-invalid', 'C07H decisions limit+1 skips closed');
  }
  const turn = (chars) => shadowHost.extractLiveCurrentTurnV2([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(chars) }] }]);
  check(turn(8193).turn !== null, 'C07H accepts a real >8192-char live turn');
  check(turn(B.currentTurnTextMax).turn !== null, 'C07H live turn at the bound accepted');
  check(turn(B.currentTurnTextMax + 1).turn === null, 'C07H live turn limit+1 skips closed');
  check(shadowV2.SHADOW_ACTUAL_MEMBERS_MAX === 16384, 'C07 actual-members bound raised to the R1 ceiling');
}

// ============================================================================
section('SESSION-SCALE END-TO-END (1500+ units)');
{
  // Synthetic session with the real shape: user requests, assistant tool
  // calls, tool results; some units are blob-backed (> 8192 chars).
  const events = [];
  let seq = 0;
  const push = (type, data) => { events.push({ seq, type, data }); seq += 1; return seq - 1; };
  const units = [];
  const TX = 700;
  const CONV = 1100;
  for (let i = 0; i < CONV; i += 1) {
    const text = i % 97 === 0 ? ('Long user request ' + i + '. ').repeat(600) : 'User request number ' + i + ' with exact words.';
    const s = push('user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
    units.push({ kind: 'conversation', seqs: [s], text });
  }
  for (let i = 0; i < TX; i += 1) {
    const callId = 'call-scale-' + i;
    const a = push('assistant/message', { turn: 1, step: i + 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'run_code', arguments: '{"code":"x"}' }] } });
    const c = push('tool/call', { turn: 1, step: i + 1, callId, name: 'run_code', arguments: '{"code":"x"}' });
    const body = i % 50 === 0 ? ('tool output line ' + i + '\n').repeat(700) : 'exit 0 for step ' + i;
    const r = push('tool/result', { turn: 1, step: i + 1, message: { role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: body }], isError: false }] } });
    units.push({ kind: 'tool', seqs: [a, c, r], text: '[tool-call run_code ' + callId + ']\n{"code":"x"}\n[tool-result ' + callId + ' ok]\n' + body, callId, callSeq: c, resultSeq: r });
  }
  const sessionSource = memSession.createMemorySessionSourceV2(NS.sessionId, events);
  const pages = [];
  const decisions = [];
  const exactMaterial = [];
  const txs = [];
  let blobCount = 0;
  let coldCount = 0;
  units.forEach((unit, index) => {
    const large = unit.text.length > page.PAGE_BOUNDS.exactTextMaxChars;
    let p = null;
    const base = {
      kind: unit.kind === 'tool' ? 'tool-result' : 'conversation',
      namespace: clone(NS),
      sourceKind: unit.kind === 'tool' ? 'tool' : 'user',
      sourceRefs: [unit.kind === 'tool' ? 'tool-event:' + unit.callId : 'session-event:' + unit.seqs[0]],
      mutability: 'immutable', sourceSeqs: unit.seqs.slice(), createdAtGeneration: 1,
    };
    if (large) {
      const put = store.putBlobV2(CTX_ROOT, unit.text);
      p = page.createContextPageV2(Object.assign({}, base, { exactBlobRef: put.blobRef, contentHash: put.digest }));
      blobCount += 1;
    } else {
      p = page.createContextPageV2(Object.assign({}, base, { exactText: unit.text }));
    }
    store.putContextPageV2(CTX_ROOT, p, { expectedNamespace: clone(NS) });
    pages.push(p);
    // Every 2nd conversation unit is historical+unreferenced under complete
    // authority (COLD reference); the rest stay required WARM.
    const historical = unit.kind === 'conversation' && index % 2 === 1 && !large;
    let d = null;
    if (unit.kind === 'tool') {
      d = tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: p, retentionRequired: true });
      txs.push({ pageId: p.id, callId: unit.callId, callSeq: unit.callSeq, resultSeq: unit.resultSeq });
    } else if (historical) {
      const blobbed = store.putBlobV2(CTX_ROOT, unit.text + ' [archived]');
      const coldPage = page.createContextPageV2(Object.assign({}, base, { exactBlobRef: blobbed.blobRef, contentHash: blobbed.digest }));
      store.putContextPageV2(CTX_ROOT, coldPage, { expectedNamespace: clone(NS) });
      pages[pages.length - 1] = coldPage;
      p = coldPage;
      d = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: p, historicalTransition: { reason: 'checkpoint-superseded-unreferenced', supersededByGeneration: 1 } });
      coldCount += 1;
    } else {
      d = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: p, retentionRequired: true });
    }
    decisions.push(d);
    if (p.exactBlobRef && d.tier !== 'COLD') {
      exactMaterial.push(rehydration.rehydrateContextPageV2({ contextRoot: CTX_ROOT, pageId: p.id, expectedNamespace: clone(NS), sessionSource }));
    }
  });
  check(units.length >= 1500, 'fixture holds 1500+ durable units (' + units.length + ')');
  check(txs.length >= 684, 'fixture holds 684+ tool transactions (' + txs.length + ')');
  check(blobCount > 0, 'fixture exercises the real B02 blob path (' + blobCount + ' blobs)');
  const started = Date.now();
  const compileInput = {
    checkpoint: CP_LEGACY, currentTurn: { turnId: 'live', text: 'Continue the scale fixture.', revision: null },
    namespace: clone(NS), snapshotRevision: null, runtimeState: { pendingProtocol: null },
    pages, tierDecisions: stateDecisions(CP_LEGACY).concat(decisions), evidenceRefs: [], exactMaterial, toolTransactions: txs,
    budget: { hardMax: 1000000, target: 1000000 }, compilerPolicyRevision: 'context-compiler-v1',
  };
  const compiled = compiler.compileContextV2(compileInput);
  const again = compiler.compileContextV2(compileInput);
  check(compiled.view.id === again.view.id && compiled.view.viewDigest === again.view.viewDigest, 'scale compile is deterministic');
  check(compiled.view.warm.length > 256, 'more than 256 WARM entries (' + compiled.view.warm.length + ')');
  check(compiled.view.referencedColdPages.length > 512, 'more than 512 referenced COLD entries (' + compiled.view.referencedColdPages.length + ')');
  const viewBytes = Buffer.byteLength(JSON.stringify(checkpoint.canonicalize(compiled.view)), 'utf8');
  check(viewBytes > 1048576, 'ContextView exceeds 1 MiB (' + viewBytes + ' bytes)');
  const materialized = compiled.view.warm.length + compiled.view.hot.length + compiled.view.pinned.length + compiled.view.materializedCold.length;
  const expectedMaterialized = units.length - coldCount + 2;
  check(materialized === expectedMaterialized, 'no silent omission: every required unit materialized (' + materialized + '/' + expectedMaterialized + ')');
  const warmSeqs = compiled.view.warm.map((entry) => pages.find((p) => p.id === entry.sourceId).sourceSeqs[0]);
  check(warmSeqs.every((s, i) => i === 0 || warmSeqs[i - 1] < s), 'required WARM history is in canonical source order');
  const counter = counterV2.createCodepointTestCounterV2();
  const compressed = ladder.compressContextViewV2({ view: compiled.view, pages, budget: { hardMax: 10000000, target: 10000000 }, counter });
  check(compressed.compressionPlan.sources.length > 1024, 'more than 1024 plan sources (' + compressed.compressionPlan.sources.length + ')');
  check(compressed.packingPlan.omittedMaterialIds.length === 0, 'no silent truncation under a fitting budget');
  const layout = layoutV2.planContextPromptLayoutV2({ view: compressed.compressedView }).layout;
  check(layout && Array.isArray(layout.blocks) && layout.blocks.length >= materialized, 'C06 layout accepts the scale view (' + (layout ? layout.blocks.length : 0) + ' blocks)');
  const layout2 = layoutV2.planContextPromptLayoutV2({ view: compressed.compressedView }).layout;
  check(layout.layoutDigest === layout2.layoutDigest, 'layout is deterministic at scale');
  const shuffled = Object.assign({}, compileInput, { pages: pages.slice().reverse(), tierDecisions: compileInput.tierDecisions.slice().reverse(), toolTransactions: txs.slice().reverse() });
  check(compiler.compileContextV2(shuffled).view.id === compiled.view.id, 'input order never leaks into view identity (no unordered nondeterminism)');
  console.log('scale timing ms=' + (Date.now() - started) + ' units=' + units.length + ' viewBytes=' + viewBytes);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\nR1 real-session contracts: ' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed === 0 ? 0 : 1;
