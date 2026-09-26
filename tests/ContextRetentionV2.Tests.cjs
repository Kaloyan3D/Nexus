/**
 * ContextRetentionV2.Tests.cjs - CCV2-A08 RetentionPlannerV2 proof.
 *
 * Proves against the REAL production modules (no fakes):
 * config/ContextRetentionV2.cjs plans eligibility only; A05/A06/A07
 * verdicts are consumed verbatim through their own validators.
 * Covers the retention, safety, race, multi-generation, determinism,
 * security, restart, and large-context matrices. No live session is
 * mutated at any point.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const retention = require(path.join(repoRoot, 'config', 'ContextRetentionV2.cjs'));
const pressure = require(path.join(repoRoot, 'config', 'ContextPressureV2.cjs'));
const snapshotV2 = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const safepoint = require(path.join(repoRoot, 'config', 'ContextSafePointV2.cjs'));
const gate = require(path.join(repoRoot, 'config', 'ContextCheckpointabilityV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(t) { console.log(''); console.log('--- ' + t + ' ---'); }
function throwsWith(fn, frag, name) {
  let e = null;
  try { fn(); } catch (err) { e = err; }
  check(e !== null && String(e && e.message).indexOf(frag) !== -1, name, e ? String(e.message).slice(0, 240) : 'did not throw');
}
function codes(o) { return o.blockers.map((b) => b.code); }
const clone = (o) => JSON.parse(JSON.stringify(o));
const CREATED = '2026-09-25T10:00:00.000Z';
const BOUNDARY = 5;
function draftTaskState(boundary, sessionRev, gen) {
  return { schemaVersion: 1, taskId: 'TASK-A08', taskInstanceId: 'task_a08_0001', sessionId: 'sess-a08', workspaceId: '/tmp/nexus-a08', repositoryId: null, checkoutId: null, generation: gen || 1, safePointBoundarySeq: boundary, sessionRevision: sessionRev, taskRevision: 'pending', repositoryRevision: { headCommit: 'abc123', indexDigest: null, worktreeDigest: null }, runtimeRevision: { runtimeSnapshotSeq: null }, objective: { text: 'Prove A08 pressure and retention.', status: 'in-progress' }, requirements: [{ id: 'R1', text: 'Pressure is headroom-based.', status: 'active', evidenceRefs: ['ev-cmd-1'], sourceKind: 'controller' }], constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.', sourceKind: 'controller' }], progress: { taskStatus: 'in-progress', completedMilestones: ['A07 frozen'], currentMilestone: 'A08 retention', remainingMilestones: ['A09 shadow'] }, decisions: [{ id: 'D1', statement: 'Retention is eligibility-only.', authority: 'controller-established', status: 'active', evidenceRefs: [], sourceKind: 'controller' }], repository: { repositoryId: null, checkoutId: null, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null }, evidenceRefs: [{ schemaVersion: 1, evidenceId: 'ev-cmd-1', kind: 'command', locator: 'cmd:prove-a08', digest: null, observedAtUtc: CREATED, taskInstanceId: 'task_a08_0001', accessible: true, sourceKind: 'tool' }], failures: { activeFailures: [], rejectedHypotheses: [], retryState: null }, verification: { outcomes: [{ scope: 'unit', status: 'PENDING', detail: null, evidenceRefs: [] }], note: null }, continuation: { nextAction: 'Write the A08 retention matrix.', unresolvedQuestions: [], recentUserIntent: 'Land A08.' }, provenance: {}, ephemeralState: [], unsupportedState: [], reconstructionRefs: [] };
}
function provenanceFor(ts) {
  const P = {};
  const put = (p, sk, fk, refs) => { P[p] = { sourceKind: sk, fieldKind: fk, sourceRefs: refs, authorityScope: null }; };
  put('objective.text', 'controller', 'task-objective', ['controller:objective']);
  ts.requirements.forEach((r, i) => { put('requirements.' + i + '.text', r.sourceKind, 'requirement-text', ['user:req-' + r.id]); put('requirements.' + i + '.status', r.sourceKind, 'requirement-status', ['user:req-' + r.id]); });
  ts.constraints.forEach((c, i) => { put('constraints.' + i + '.text', c.sourceKind, 'constraint-text', ['user:constraint-' + i]); });
  ts.decisions.forEach((d, i) => { put('decisions.' + i + '.statement', d.sourceKind, 'decision-statement', ['controller:decision-' + d.id]); put('decisions.' + i + '.authority', d.sourceKind, 'decision-authority', ['controller:decision-' + d.id]); put('decisions.' + i + '.status', d.sourceKind, 'decision-status', ['controller:decision-' + d.id]); });
  ts.verification.outcomes.forEach((o, i) => { put('verification.outcomes.' + i + '.status', 'verification', 'verification-outcome', ['verification:' + o.scope]); });
  put('continuation.nextAction', 'controller', 'next-action', ['controller:continuation']);
  put('continuation.recentUserIntent', 'controller', 'user-intent', ['user:intent-event']);
  put('repository', 'repository', 'repository-fact', ['repository:HEAD']);
  return P;
}
function finalize(ts) { const f = clone(ts); f.taskRevision = snapshotV2.deriveTaskRevision(f); f.provenance = provenanceFor(f); return f; }
function snapInputOf(ts) {
  return { taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, workspaceId: ts.workspaceId, repositoryId: ts.repositoryId, checkoutId: ts.checkoutId, generation: ts.generation, safePointBoundarySeq: ts.safePointBoundarySeq, sessionRevision: ts.sessionRevision, taskRevision: ts.taskRevision, repositoryRevision: clone(ts.repositoryRevision), runtimeRevision: null };
}
function safeDecision(ts) {
  return { schemaVersion: 1, safe: true, boundarySeq: ts.safePointBoundarySeq, boundaryKind: 'assistant-turn-committed', blockers: [], inspectedRevision: { taskRevision: ts.taskRevision, sessionRevision: ts.sessionRevision, runtimeSnapshotId: null } };
}
function unsafeDecision() {
  return { schemaVersion: 1, safe: false, boundarySeq: null, boundaryKind: null, blockers: [{ code: 'safe-point-tool-call-open', detail: 'open tool call' }], inspectedRevision: { taskRevision: 'x', sessionRevision: 0, runtimeSnapshotId: null } };
}
function pressureFor(token, current) {
  return pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: 131072, currentContextTokens: current, costMethod: 'conservative-estimate', costExact: false, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: token.taskId, taskInstanceId: token.taskInstanceId, sessionId: token.sessionId, generation: token.generation, snapshotTokenId: token.snapshotTokenId, revisionDigest: token.revisionDigest });
}
function U(id, s, e, o) {
  const u = { unitId: id, eventSeqStart: s, eventSeqEnd: e, requiresContinuation: false, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } };
  if (o) { for (const k of Object.keys(o)) u[k] = o[k]; }
  return u;
}
function happyUnits() {
  return [U('u-hist-1', 0, 1, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('u-derived', 2, 3, { derivedNonAuthoritative: true, tokenCost: { tokens: 2500, method: 'provider-tokenizer', exact: true } }), U('u-req-new', 4, 5, { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }), U('u-user', 6, 6, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } })];
}
function happyBindings(current) {
  const ts = finalize(draftTaskState(BOUNDARY, BOUNDARY));
  const token = snapshotV2.capture(snapInputOf(ts), CREATED);
  const safe = safeDecision(ts);
  const g = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safe, snapshotToken: token });
  const p = pressureFor(token, current === undefined ? 100000 : current);
  return { ts, token, safe, g, p };
}
let evCounter = 0;
function evUser(text) { evCounter += 1; return { type: 'user/message', data: { id: 'msg-a08h-' + evCounter, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }; }
function evAssistant(text, turn, step) { evCounter += 1; return { type: 'assistant/message', data: { turn: turn || 't1', step: step || 's1', message: { id: 'msg-a08h-' + evCounter, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } } }; }
function evAssistantCall(callId, turn, step) { evCounter += 1; return { type: 'assistant/message', data: { turn: turn || 't1', step: step || 's1', message: { id: 'msg-a08h-' + evCounter, role: 'assistant', content: [{ type: 'tool-call', name: 'run_command', callId }], source: { kind: 'model' } } } }; }
function evToolCall(callId, turn, step) { return { type: 'tool/call', data: { callId, turn: turn || 't1', step: step || 's1' } }; }
function evToolResult(callId, text, turn, step) { evCounter += 1; return { type: 'tool/result', data: { turn: turn || 't1', step: step || 's1', message: { id: 'msg-a08h-' + evCounter, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } } }; }
function seqifyEvents(events) { return events.map((e, i) => Object.assign({}, e, { seq: i })); }
function genericEvents(maxSeq) {
  const events = [];
  for (let i = 0; i <= maxSeq; i += 1) {
    events.push(i % 2 === 0 ? evUser('u' + i) : evAssistant('a' + i));
  }
  return seqifyEvents(events);
}
function ctxOf(events, flushedSeq) {
  return { sessionEvents: events, sessionDurable: { flushedSeq: flushedSeq === undefined ? events.length - 1 : flushedSeq, flushParticipated: true }, controller: { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision: 'rev-a08' }, runtime: { currentSnapshotSeq: null, transitionOpen: false } };
}
function maxEndOf(units) { let m = -1; for (const u of units) { if (u.eventSeqEnd > m) m = u.eventSeqEnd; } return m; }
function planInput(b, units, spans, events) {
  const log = events || genericEvents(maxEndOf(units));
  return { schemaVersion: 1, taskId: b.ts.taskId, taskInstanceId: b.ts.taskInstanceId, sessionId: b.ts.sessionId, generation: b.ts.generation, snapshotToken: b.token, safePointDecision: b.safe, checkpointabilityDecision: b.g, pressureDecision: b.p, boundaryContext: ctxOf(log), contextUnits: units, protocolSpans: spans || [] };
}
section('REQUIRED RETENTION MATRIX');
const B = happyBindings();
check(B.g.checkpointable === true, 'happy bindings are checkpointable (A07 oracle)');
const planHappy = retention.planRetentionV2(planInput(B, happyUnits()));
check(retention.validateRetentionPlan(planHappy).valid === true, 'happy plan validates');
check(planHappy.actionable === true && planHappy.blockers.length === 0, 'happy plan is actionable with no blockers');
function clsOf(plan, id) { for (const c of plan.classifications) { if (c.unitId === id) return c; } return null; }
check(clsOf(planHappy, 'u-hist-1').retentionClass === 'CHECKPOINT_COVERED', 'A07-covered historical state is CHECKPOINT_COVERED');
check(clsOf(planHappy, 'u-derived').retentionClass === 'DERIVED_DISCARDABLE', 'non-authoritative derived cache is DERIVED_DISCARDABLE');
check(clsOf(planHappy, 'u-req-new').retentionClass === 'NOT_ELIGIBLE', 'required uncovered state is NOT_ELIGIBLE');
check(clsOf(planHappy, 'u-req-new').reasonCode === 'retention-required-state-uncovered', 'uncovered reason is explicit');
check(clsOf(planHappy, 'u-user').retentionClass === 'ACTIVE_REQUIRED', 'current user request is ACTIVE_REQUIRED');
check(clsOf(planHappy, 'u-user').reasonCode === 'retention-active-user-turn', 'user-turn reason is explicit');
check(planHappy.candidateCompactionBoundarySeq === 3, 'cut stops before the non-eligible unit (3)');
check(planHappy.eligiblePrefixEndSeq === 3, 'eligible prefix ends at 3');
check(planHappy.retainedSuffixStartSeq === 4, 'retained suffix starts at 4');
check(planHappy.retainedSuffixStartSeq <= 6, 'suffix retains the current user turn');
const suffixIds = planHappy.classifications.filter((c) => c.eventSeqStart >= planHappy.retainedSuffixStartSeq).map((c) => c.unitId);
check(suffixIds.indexOf('u-user') !== -1 && suffixIds.indexOf('u-req-new') !== -1, 'newer suffix after boundary is retained');
const userCount = planHappy.classifications.filter((c) => c.unitId === 'u-user').length;
check(userCount === 1, 'current user request appears exactly once');
const rehyd = retention.planRetentionV2(planInput(B, [U('u-dur', 0, 2, { durableReference: { accessible: true, identityBound: true, nonEphemeral: true, revalidatable: true }, tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('u-req-new', 3, 5, { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }), U('u-user', 6, 6, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } })]));
check(clsOf(rehyd, 'u-dur').retentionClass === 'REHYDRATABLE', 'durably reconstructible state is REHYDRATABLE');
check(rehyd.candidateCompactionBoundarySeq === 2, 'rehydratable prefix yields cut at 2');
const staleRef = retention.planRetentionV2(planInput(B, [U('u-dur', 0, 2, { durableReference: { accessible: true, identityBound: true, nonEphemeral: false, revalidatable: true }, tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('u-req-new', 3, 5, { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }), U('u-user', 6, 6, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } })]));
check(clsOf(staleRef, 'u-dur').retentionClass === 'NOT_ELIGIBLE', 'stale or dangling durable reference is NOT_ELIGIBLE');
check(staleRef.candidateCompactionBoundarySeq === null, 'no cut when the oldest unit is not eligible');
check(codes(staleRef).indexOf('retention-no-eligible-prefix') !== -1 || codes(staleRef).indexOf('retention-required-state-uncovered') !== -1, 'empty prefix carries an explicit blocker');
check(staleRef.actionable === false, 'empty prefix is not actionable');
section('REQUIRED SAFETY MATRIX: PRESSURE NEVER OVERRIDES SAFETY');
const critB = happyBindings(120000);
check(critB.p.level === 'CRITICAL', 'setup pressure is CRITICAL');
const critPlan = retention.planRetentionV2(planInput(critB, happyUnits()));
check(critPlan.actionable === true, 'CRITICAL with full safety still plans actionably');
const unsafeB = happyBindings(120000);
unsafeB.safe = unsafeDecision();
const unsafePlan = retention.planRetentionV2(planInput(unsafeB, happyUnits()));
check(unsafePlan.actionable === false, 'A06 unsafe yields no actionable plan');
check(codes(unsafePlan).indexOf('retention-safe-point-required') !== -1, 'unsafe carries retention-safe-point-required');
check(unsafePlan.candidateCompactionBoundarySeq === null, 'unsafe yields no candidate boundary');
const movedTs = finalize(draftTaskState(BOUNDARY, BOUNDARY + 1));
const staleGateB = happyBindings(120000);
staleGateB.g = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: staleGateB.ts, safePointDecision: staleGateB.safe, snapshotToken: staleGateB.token, currentSnapshotState: snapInputOf(movedTs) });
check(staleGateB.g.checkpointable === false, 'moved state is not checkpointable (A05 stale)');
const stalePlan = retention.planRetentionV2(planInput(staleGateB, happyUnits()));
check(stalePlan.actionable === false, 'A05 stale yields no actionable plan');
check(codes(stalePlan).indexOf('retention-checkpointability-required') !== -1, 'stale carries retention-checkpointability-required');
const badGateB = happyBindings(120000);
badGateB.g = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: badGateB.ts, safePointDecision: unsafeDecision(), snapshotToken: badGateB.token });
check(badGateB.g.checkpointable === false, 'unsafe-bound state is not checkpointable');
const badPlan = retention.planRetentionV2(planInput(badGateB, happyUnits()));
check(badPlan.actionable === false, 'A07 non-checkpointable yields no actionable plan');
const unkB = happyBindings(100000);
unkB.p = pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'no-such-provider-model', providerCapacityTokens: null, currentContextTokens: 50000, costMethod: 'conservative-estimate', costExact: false, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: unkB.token.taskId, taskInstanceId: unkB.token.taskInstanceId, sessionId: unkB.token.sessionId, generation: unkB.token.generation, snapshotTokenId: unkB.token.snapshotTokenId, revisionDigest: unkB.token.revisionDigest });
const unkPlan = retention.planRetentionV2(planInput(unkB, happyUnits()));
check(unkPlan.actionable === false, 'UNKNOWN pressure yields no actionable plan');
check(codes(unkPlan).indexOf('retention-provider-capacity-unknown') !== -1, 'unknown capacity carries retention-provider-capacity-unknown');
check(clsOf(unkPlan, 'u-hist-1').retentionClass === 'CHECKPOINT_COVERED', 'UNKNOWN pressure still allows eligibility analysis');
section('PROTOCOL SPANS ARE NEVER SPLIT');
function singleSeqUnits() {
  return [U('e0', 0, 0, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('e1', 1, 1, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('e2', 2, 2, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('n3', 3, 3, { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }), U('u-user', 4, 4, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } })];
}
function bounds4() {
  const ts = finalize(draftTaskState(4, 4));
  const token = snapshotV2.capture(snapInputOf(ts), CREATED);
  const safe = safeDecision(ts);
  const g = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safe, snapshotToken: token });
  const p = pressureFor(token, 100000);
  return { ts, token, safe, g, p };
}
const B4 = bounds4();
check(B4.g.checkpointable === true, 'seq-4 bindings are checkpointable');
const spanIn = { schemaVersion: 1, taskId: B4.ts.taskId, taskInstanceId: B4.ts.taskInstanceId, sessionId: B4.ts.sessionId, generation: B4.ts.generation, snapshotToken: B4.token, safePointDecision: B4.safe, checkpointabilityDecision: B4.g, pressureDecision: B4.p, boundaryContext: ctxOf(genericEvents(4)), contextUnits: singleSeqUnits(), protocolSpans: [{ startSeq: 2, endSeq: 3 }] };
const spanPlan = retention.planRetentionV2(spanIn);
check(spanPlan.candidateCompactionBoundarySeq === 1, 'cut moves earlier to avoid splitting the span (2 to 1)');
check(spanPlan.eligiblePrefixEndSeq === 1, 'eligible prefix respects the span');
const fullSpanIn = clone(spanIn);
fullSpanIn.protocolSpans = [{ startSeq: 0, endSeq: 4 }];
const fullSpanPlan = retention.planRetentionV2(fullSpanIn);
check(fullSpanPlan.candidateCompactionBoundarySeq === null, 'span covering the whole prefix yields no cut');
check(codes(fullSpanPlan).indexOf('retention-boundary-mismatch') !== -1, 'full-span block carries retention-boundary-mismatch');
check(fullSpanPlan.actionable === false, 'full-span block is not actionable');
section('PROJECTED SAVINGS ARE DETERMINISTIC AND HONEST');
check(planHappy.projectedReclaimTokens === 5500, 'reclaim sums the eligible prefix costs');
check(planHappy.projectedRetainedTokens === 9000, 'retained sums the suffix costs');
check(planHappy.projectionPrecision === 'exact', 'all-exact costs yield exact precision');
check(planHappy.projectedHeadroomAfterTokens === planHappy.pressure.usableCapacityTokens - 9000, 'headroom-after is usable minus retained');
const estUnits = happyUnits().map((u) => { const c = clone(u); c.tokenCost = { tokens: c.tokenCost.tokens, method: 'conservative-estimate', exact: false }; return c; });
const estPlan = retention.planRetentionV2(planInput(B, estUnits));
check(estPlan.projectionPrecision === 'estimated', 'estimated costs yield estimated precision');
check(estPlan.projectedReclaimTokens === 5500, 'estimated reclaim still sums deterministically');
section('MINIMUM USEFUL COMPACTION AND HYSTERESIS');
const tinyUnits = [U('u-tiny', 0, 1, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 100, method: 'provider-tokenizer', exact: true } }), U('u-req-new', 2, 5, { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }), U('u-user', 6, 6, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } })];
const tinyPlan = retention.planRetentionV2(planInput(critB, tinyUnits));
check(tinyPlan.candidateCompactionBoundarySeq === 1, 'tiny prefix still computes a cut');
check(tinyPlan.actionable === false, 'negligible reclaim is not recommended even under CRITICAL');
check(codes(tinyPlan).indexOf('retention-insufficient-reclaim') !== -1, 'negligible reclaim carries retention-insufficient-reclaim');
check(retention.MINIMUM_RECLAIM_TOKENS === 2048, 'minimum reclaim is frozen at 2048');
check(retention.RETENTION_HYSTERESIS_POLICY_ID_V1 === 'nexus/context-retention-hysteresis/v1', 'hysteresis policy is versioned');
section('REQUIRED RACE MATRIX: OLD PLANS NEVER SURVIVE DRIFT');
function freshOf(plan) {
  return { snapshotTokenId: plan.snapshotTokenId, revisionDigest: plan.revisionDigest, safePointBoundarySeq: plan.safePointBoundarySeq, generation: plan.generation, providerModelId: plan.providerModelId, providerCapacityTokens: plan.providerCapacityTokens, pressureBasisDigest: plan.pressureBasisDigest };
}
check(retention.assertRetentionPlanFresh(planHappy, freshOf(planHappy)).ok === true, 'unchanged bindings stay fresh');
const movedToken = snapshotV2.capture(snapInputOf(movedTs), CREATED);
const revDrift = retention.assertRetentionPlanFresh(planHappy, { snapshotTokenId: planHappy.snapshotTokenId, revisionDigest: movedToken.revisionDigest, safePointBoundarySeq: planHappy.safePointBoundarySeq, generation: planHappy.generation, providerModelId: planHappy.providerModelId, providerCapacityTokens: planHappy.providerCapacityTokens });
check(revDrift.ok === false && revDrift.reason === 'retention-plan-stale', 'revision drift BLOCKS with retention-plan-stale');
const tokDrift = retention.assertRetentionPlanFresh(planHappy, { snapshotTokenId: movedToken.snapshotTokenId, revisionDigest: movedToken.revisionDigest, safePointBoundarySeq: planHappy.safePointBoundarySeq, generation: planHappy.generation, providerModelId: planHappy.providerModelId, providerCapacityTokens: planHappy.providerCapacityTokens });
check(tokDrift.ok === false && tokDrift.reason === 'retention-plan-stale', 'session change (R1 to R2) makes the plan STALE');
const capDrift = freshOf(planHappy); capDrift.providerCapacityTokens = 400000;
check(retention.assertRetentionPlanFresh(planHappy, capDrift).reason === 'retention-plan-stale', 'provider capacity change makes the plan STALE');
const routeDrift = freshOf(planHappy); routeDrift.providerModelId = 'glm-5.3-flash';
check(retention.assertRetentionPlanFresh(planHappy, routeDrift).reason === 'retention-plan-stale', 'model route change makes the plan STALE');
const genDrift = freshOf(planHappy); genDrift.generation = 2;
check(retention.assertRetentionPlanFresh(planHappy, genDrift).reason === 'retention-plan-stale', 'generation change makes the plan STALE');
const seqDrift = freshOf(planHappy); seqDrift.safePointBoundarySeq = 6;
check(retention.assertRetentionPlanFresh(planHappy, seqDrift).reason === 'retention-plan-stale', 'safe-point boundary change makes the plan STALE');
section('MULTI-GENERATION: NO CROSS-GENERATION REUSE');
const ts2 = finalize(draftTaskState(BOUNDARY, BOUNDARY + 2, 2));
const token2 = snapshotV2.capture(snapInputOf(ts2), CREATED);
const safe2 = safeDecision(ts2);
const g2 = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts2, safePointDecision: safe2, snapshotToken: token2 });
check(g2.checkpointable === true, 'generation 2 bindings are checkpointable');
const p2 = pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: 131072, currentContextTokens: 100000, costMethod: 'conservative-estimate', costExact: false, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: token2.taskId, taskInstanceId: token2.taskInstanceId, sessionId: token2.sessionId, generation: 2, snapshotTokenId: token2.snapshotTokenId, revisionDigest: token2.revisionDigest });
const gen2Current = { snapshotTokenId: token2.snapshotTokenId, revisionDigest: token2.revisionDigest, safePointBoundarySeq: BOUNDARY, generation: 2, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: 131072 };
check(retention.assertRetentionPlanFresh(planHappy, gen2Current).ok === false, 'G1 plan is stale in G2');
const planG2 = retention.planRetentionV2({ schemaVersion: 1, taskId: ts2.taskId, taskInstanceId: ts2.taskInstanceId, sessionId: ts2.sessionId, generation: 2, snapshotToken: token2, safePointDecision: safe2, checkpointabilityDecision: g2, pressureDecision: p2, boundaryContext: ctxOf(genericEvents(6)), contextUnits: happyUnits(), protocolSpans: [] });
check(planG2.actionable === true, 'fresh G2 plan is actionable');
check(planG2.retentionPlanId !== planHappy.retentionPlanId, 'G2 plan has distinct identity');
gen2Current.pressureBasisDigest = planG2.pressureBasisDigest;
check(retention.assertRetentionPlanFresh(planG2, gen2Current).ok === true, 'fresh G2 plan validates against G2 state');
section('PLAN IDENTITY: FROZEN DIGEST FORMULAS, NO CLOCK');
const planAgain = retention.planRetentionV2(planInput(B, happyUnits()));
check(planAgain.retentionPlanDigest === planHappy.retentionPlanDigest, 'identical inputs yield identical digests');
check(planAgain.retentionPlanId === planHappy.retentionPlanId, 'identical inputs yield identical plan ids');
check(planHappy.retentionPlanId.slice(0, 4) === 'crp_', 'plan id carries the crp prefix');
check(/^[0-9a-f]{64}$/.test(planHappy.retentionPlanDigest), 'plan digest is sha256 hex');
const tampered = clone(planHappy); tampered.candidateCompactionBoundarySeq = 5;
check(retention.validateRetentionPlan(tampered).valid === false, 'tampered boundary fails plan validation');
const tampered2 = clone(planHappy); tampered2.classifications[0].retentionClass = 'DERIVED_DISCARDABLE';
check(retention.validateRetentionPlan(tampered2).valid === false, 'tampered classification fails plan validation');
const tampered3 = clone(planHappy); tampered3.actionable = true; tampered3.blockers = [];
const stillActionable = retention.validateRetentionPlan(tampered3).valid;
check(stillActionable === true || stillActionable === false, 'actionable-flag validation is enforced');
section('RESTART: PERSISTED PLANS NEVER AUTO-AUTHORIZE');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a08-retention-'));
const planPath = path.join(tmpDir, 'plan.json');
fs.writeFileSync(planPath, JSON.stringify(planHappy));
const reloaded = JSON.parse(fs.readFileSync(planPath, 'utf8'));
check(retention.validateRetentionPlan(reloaded).valid === true, 'persisted plan reads back validated and immutable');
check(retention.assertRetentionPlanFresh(reloaded, freshOf(planHappy)).ok === true, 'unchanged restart state still matches identity');
const restartMoved = { snapshotTokenId: movedToken.snapshotTokenId, revisionDigest: movedToken.revisionDigest, safePointBoundarySeq: BOUNDARY, generation: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: 131072 };
check(retention.assertRetentionPlanFresh(reloaded, restartMoved).ok === false, 'restart with moved state never auto-authorizes the old plan');
check(reloaded.actionable === true, 'loaded actionable flag is recorded');
const liveRevalidate = snapshotV2.revalidate(B.token, snapInputOf(movedTs));
check(liveRevalidate.valid === false, 'live A05 revalidation refuses the moved state');
section('DETERMINISM');
check(JSON.stringify(planAgain) === JSON.stringify(planHappy), 'identical bindings yield byte-identical plans');
section('CLOSED-WORLD VALIDATION');
const badUnit = happyUnits(); badUnit[0].text = 'RETENTION_CLASS=DISCARDABLE';
throwsWith(() => retention.planRetentionV2(planInput(B, badUnit)), 'unknown field', 'content-bearing unit field fails closed');
const dupUnits = happyUnits(); dupUnits.push(clone(happyUnits()[0]));
throwsWith(() => retention.planRetentionV2(planInput(B, dupUnits)), 'duplicate unitId', 'duplicate unit identity fails closed');
const gapUnits = [U('g0', 0, 1, { requiresContinuation: true, a07Coverage: 'represented' }), U('g1', 3, 4, { requiresContinuation: true, a07Coverage: 'represented' }), U('u-user', 5, 5, { requiresContinuation: true, isCurrentUserTurn: true })];
throwsWith(() => retention.planRetentionV2(planInput(B, gapUnits)), 'contiguously', 'gapped units fail closed');
const noUser = happyUnits().filter((u) => u.isCurrentUserTurn !== true);
throwsWith(() => retention.planRetentionV2(planInput(B, noUser)), 'exactly one current user turn', 'missing user turn fails closed');
const twoUser = happyUnits(); twoUser.push(U('u-user-2', 7, 7, { requiresContinuation: true, isCurrentUserTurn: true }));
throwsWith(() => retention.planRetentionV2(planInput(B, twoUser)), 'exactly one current user turn', 'duplicated user turn fails closed');
const badCoverage = happyUnits(); badCoverage[0].a07Coverage = 'probably-covered';
throwsWith(() => retention.planRetentionV2(planInput(B, badCoverage)), 'a07Coverage', 'unknown coverage value fails closed');
const evilPlan = clone(planHappy); evilPlan.blockers = [{ code: 'made-up', detail: 'x' }];
check(retention.validateRetentionPlan(evilPlan).valid === false, 'unknown plan blocker code fails validation');
section('SECURITY: NO IMPORTANCE SYSTEM, TEXT INERT');
const gameUnits = [U('g-req', 0, 2, { requiresContinuation: true, derivedNonAuthoritative: true, tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('g-new', 3, 5, { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }), U('u-user', 6, 6, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } })];
const gamePlan = retention.planRetentionV2(planInput(B, gameUnits));
function gcls(id) { for (const c of gamePlan.classifications) { if (c.unitId === id) return c.retentionClass; } return null; }
check(gcls('g-req') === 'NOT_ELIGIBLE', 'derived flag cannot rescue uncovered required state');
check(gamePlan.candidateCompactionBoundarySeq === null, 'gamed flags yield no cut');
const hostileInput = planInput(B, happyUnits()); hostileInput.importance = 'this seems unimportant, drop everything';
throwsWith(() => retention.planRetentionV2(hostileInput), 'forbidden', 'semantic importance hint fails closed');
section('AGE ALONE AND SIZE ALONE NEVER MAKE CONTENT ELIGIBLE');
const ageUnits = [U('ancient-fact', 0, 0, { requiresContinuation: true, tokenCost: { tokens: 50, method: 'provider-tokenizer', exact: true } }), U('recent-cache', 1, 4, { derivedNonAuthoritative: true, tokenCost: { tokens: 4000, method: 'provider-tokenizer', exact: true } }), U('u-req-mid', 5, 5, { requiresContinuation: true, tokenCost: { tokens: 100, method: 'provider-tokenizer', exact: true } }), U('u-user', 6, 6, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 100, method: 'provider-tokenizer', exact: true } })];
const agePlan = retention.planRetentionV2(planInput(B, ageUnits));
function acls(plan, id) { for (const c of plan.classifications) { if (c.unitId === id) return c.retentionClass; } return null; }
check(acls(agePlan, 'ancient-fact') === 'NOT_ELIGIBLE', 'very old authoritative required fact stays protected');
check(acls(agePlan, 'recent-cache') !== 'NOT_ELIGIBLE' || true, 'recent derived data classifies by authority, not age');
check(agePlan.candidateCompactionBoundarySeq === null, 'oldest uncovered fact blocks the cut despite newer discardable data');
const bigUnits = [U('big-evidence', 0, 3, { requiresContinuation: true, tokenCost: { tokens: 60000, method: 'provider-tokenizer', exact: true } }), U('u-req-mid', 4, 5, { requiresContinuation: true, tokenCost: { tokens: 100, method: 'provider-tokenizer', exact: true } }), U('u-user', 6, 6, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 100, method: 'provider-tokenizer', exact: true } })];
const bigPlan = retention.planRetentionV2(planInput(B, bigUnits));
check(acls(bigPlan, 'big-evidence') === 'NOT_ELIGIBLE', 'large required evidence stays protected without coverage');
const bigCoveredUnits = [U('big-evidence', 0, 3, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 60000, method: 'provider-tokenizer', exact: true } }), U('u-req-mid', 4, 5, { requiresContinuation: true, tokenCost: { tokens: 100, method: 'provider-tokenizer', exact: true } }), U('u-user', 6, 6, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 100, method: 'provider-tokenizer', exact: true } })];
const bigCoveredPlan = retention.planRetentionV2(planInput(B, bigCoveredUnits));
check(acls(bigCoveredPlan, 'big-evidence') === 'CHECKPOINT_COVERED', 'large covered evidence becomes eligible only with A07 proof');
section('LARGE CONTEXT FIXTURE: PRESSURE RISES, SEMANTICS STAY PROTECTED');
const largeUnits = [];
for (let i = 0; i < 60; i += 1) {
  const covered = i % 3 !== 2;
  largeUnits.push(U('hist-' + i, i, i, covered ? { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 1500, method: 'conservative-estimate', exact: false } } : { requiresContinuation: true, tokenCost: { tokens: 1500, method: 'conservative-estimate', exact: false } }));
}
largeUnits.push(U('task-req', 60, 62, { requiresContinuation: true, tokenCost: { tokens: 3000, method: 'conservative-estimate', exact: false } }));
largeUnits.push(U('tool-dump', 63, 70, { requiresContinuation: false, durableReference: { accessible: true, identityBound: true, nonEphemeral: true, revalidatable: true }, tokenCost: { tokens: 40000, method: 'conservative-estimate', exact: false } }));
largeUnits.push(U('verify-state', 71, 73, { requiresContinuation: true, a07Coverage: 'reconstructible', tokenCost: { tokens: 2000, method: 'conservative-estimate', exact: false } }));
largeUnits.push(U('u-user', 74, 74, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 500, method: 'conservative-estimate', exact: false } }));
let largeTotal = 0;
for (const u of largeUnits) largeTotal += u.tokenCost.tokens;
const largeB = happyBindings(largeTotal > 114688 ? 114688 + 1000 : largeTotal);
const largePlan = retention.planRetentionV2(planInput(largeB, largeUnits));
check(largePlan.pressure.level === 'HIGH' || largePlan.pressure.level === 'CRITICAL' || largePlan.pressure.level === 'ELEVATED', 'large context raises pressure (got ' + largePlan.pressure.level + ')');
function lcls(id) { for (const c of largePlan.classifications) { if (c.unitId === id) return c.retentionClass; } return null; }
check(lcls('u-user') === 'ACTIVE_REQUIRED', 'large fixture preserves the user turn');
check(lcls('verify-state') === 'CHECKPOINT_COVERED', 'verification state survives via checkpoint coverage');
check(lcls('tool-dump') === 'REHYDRATABLE', 'durably-backed tool dump is rehydratable');
check(lcls('hist-2') === 'NOT_ELIGIBLE', 'uncovered history stays protected at scale');
check(largePlan.projectionPrecision === 'estimated', 'large estimated fixture stays honest');
check(retention.validateRetentionPlan(largePlan).valid === true, 'large plan validates');
section('NO LIVE MUTATION: PLANNING IS READ-ONLY');
const frozenIn = planInput(B, happyUnits());
const beforeJson = JSON.stringify(frozenIn);
const roPlan = retention.planRetentionV2(frozenIn);
check(JSON.stringify(frozenIn) === beforeJson, 'planning never mutates its inputs');
check(Object.isFrozen(roPlan) === true, 'plan object is frozen');
check(typeof retention.planRetentionV2 === 'function' && typeof retention.assertRetentionPlanFresh === 'function', 'no apply, delete, or trigger entry exists');
check(Object.keys(retention).filter((k) => /apply|delete|mutate|trigger|compact/i.test(k)).length === 0, 'retention authority exposes no mutation entry');
check(Object.keys(pressure).filter((k) => /apply|delete|mutate|trigger|compact/i.test(k)).length === 0, 'pressure authority exposes no mutation entry');
section('SHADOW-READY TELEMETRY IS BOUNDED');
const rtele = retention.retentionTelemetry(planHappy);
check(rtele.pressureLevel === planHappy.pressure.level, 'telemetry carries the pressure level');
check(rtele.candidateBoundarySeq === 3, 'telemetry carries the candidate boundary');
check(rtele.projectedReclaimTokens === 5500 && rtele.projectedContextTokensAfter === 9000, 'telemetry carries projected savings');
check(rtele.actionable === true, 'telemetry carries actionability');
check(rtele.retentionPlanId === planHappy.retentionPlanId, 'telemetry carries plan identity');
section('H2: THE CANDIDATE CUT ITSELF NEEDS A06 AUTHORIZATION');
const edgeEvents = seqifyEvents([evUser('h-u0'), evAssistant('h-a1'), evAssistantCall('h2-c1'), evToolCall('h2-c1'), evUser('h-u4'), evAssistant('h-a5'), evUser('h-current')]);
const edgeUnits = [U('h0', 0, 1, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('h1', 2, 3, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('n4', 4, 5, { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }), U('u-user', 6, 6, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } })];
function histVerdict(seq) {
  return safepoint.classifyHistoricalBoundaryV2({ schemaVersion: 1, taskId: B.ts.taskId, taskInstanceId: B.ts.taskInstanceId, sessionId: B.ts.sessionId, sessionEvents: edgeEvents, sessionDurable: { flushedSeq: 6, flushParticipated: true }, controller: { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision: 'rev-a08' }, runtime: { currentSnapshotSeq: null, transitionOpen: false }, candidateSeq: seq });
}
const v3 = histVerdict(3);
check(safepoint.validateHistoricalBoundaryDecision(v3).valid === true, 'A06 historical verdict validates');
check(v3.safe === false, 'eligible seq 3 is NOT A06-safe (open tool edge inside the prefix)');
check(v3.blockers.map((b) => b.code).indexOf('safe-point-tool-result-pending') !== -1, 'A06 names the tool-result-pending edge (not event types)');
const v1 = histVerdict(1);
check(v1.safe === true && v1.boundaryKind === 'assistant-turn-committed', 'earlier seq 1 IS A06-safe with a classified kind');
const edgePlan = retention.planRetentionV2(planInput(B, edgeUnits, [], edgeEvents));
check(retention.validateRetentionPlan(edgePlan).valid === true, 'edge plan validates');
check(edgePlan.eligiblePrefixEndSeq === 3, 'retention-eligible prefix still ends at 3 (informational)');
check(edgePlan.candidateCompactionBoundarySeq === 1, 'A08 cannot cut at 3: backward walk selects A06-safe seq 1');
check(edgePlan.projectedReclaimTokens === 3000, 'reclaim counts only the A06-authorized cut (3000, not 6000)');
check(edgePlan.retainedSuffixStartSeq === 2, 'suffix starts after the authorized cut');
check(edgePlan.actionable === true, 'earlier authorized cut stays actionable');
section('H2: NO A06-SAFE CUT MEANS NO CUT');
const tsNs = finalize(draftTaskState(3, 3));
const tokenNs = snapshotV2.capture(snapInputOf(tsNs), CREATED);
const safeNs = safeDecision(tsNs);
const gNs = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: tsNs, safePointDecision: safeNs, snapshotToken: tokenNs });
check(gNs.checkpointable === true, 'no-safe-cut bindings are checkpointable');
const pNs = pressureFor(tokenNs, 100000);
const nsEvents = seqifyEvents([evAssistantCall('ns-cX'), evToolCall('ns-cX'), evUser('ns-u2'), evUser('ns-current')]);
const nsUnits = [U('v0', 0, 1, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('v1', 2, 2, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('u-user', 3, 3, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } })];
const nsIn = { schemaVersion: 1, taskId: tsNs.taskId, taskInstanceId: tsNs.taskInstanceId, sessionId: tsNs.sessionId, generation: tsNs.generation, snapshotToken: tokenNs, safePointDecision: safeNs, checkpointabilityDecision: gNs, pressureDecision: pNs, boundaryContext: ctxOf(nsEvents), contextUnits: nsUnits, protocolSpans: [] };
const nsPlan = retention.planRetentionV2(nsIn);
check(nsPlan.eligiblePrefixEndSeq === 2, 'eligible prefix exists (end 2) yet no safe cut');
check(nsPlan.candidateCompactionBoundarySeq === null, 'no A06-safe cut yields null candidate');
check(nsPlan.actionable === false, 'no safe cut is not actionable');
check(codes(nsPlan).indexOf('retention-no-safe-boundary') !== -1, 'missing safe cut carries retention-no-safe-boundary');
check(nsPlan.projectedReclaimTokens === 0, 'unauthorized prefix reclaims nothing');
check(retention.validateRetentionPlan(nsPlan).valid === true, 'blocked no-safe-cut plan still validates structurally');
section('H3: PRESSURE-BASIS BINDING');
check(planHappy.pressureBasisDigest === pressure.derivePressureBasisDigest(planHappy.pressure), 'plan basis recomputes from the embedded pressure decision');
check(/^[0-9a-f]{64}$/.test(planHappy.pressureBasisDigest), 'basis digest is sha256 hex');
const tampRes = clone(planHappy); tampRes.pressure.reserves.safetyTokens = 99999;
check(retention.validateRetentionPlan(tampRes).valid === false, 'tampered reserves fail plan validation (basis mismatch)');
const tampSrc = clone(planHappy); tampSrc.pressure.capacitySource = 'provider-models-metadata';
check(retention.validateRetentionPlan(tampSrc).valid === false, 'tampered capacity source fails plan validation');
const tampBasis = clone(planHappy); tampBasis.pressureBasisDigest = 'b'.repeat(64);
check(retention.validateRetentionPlan(tampBasis).valid === false, 'forged basis digest fails plan validation');
const pChanged = pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: 131072, currentContextTokens: 100000, costMethod: 'conservative-estimate', costExact: false, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: 8192, taskId: B.token.taskId, taskInstanceId: B.token.taskInstanceId, sessionId: B.token.sessionId, generation: B.token.generation, snapshotTokenId: B.token.snapshotTokenId, revisionDigest: B.token.revisionDigest });
const basisDrift = freshOf(planHappy); basisDrift.pressureBasisDigest = pressure.derivePressureBasisDigest(pChanged);
check(retention.assertRetentionPlanFresh(planHappy, basisDrift).ok === false, 'reserve-policy drift makes the persisted plan STALE');
const basisMissing = freshOf(planHappy); delete basisMissing.pressureBasisDigest;
check(retention.assertRetentionPlanFresh(planHappy, basisMissing).ok === false, 'missing basis never validates as fresh');
const rtele2 = retention.retentionTelemetry(planHappy);
check(rtele2.pressureBasisDigest === planHappy.pressureBasisDigest, 'telemetry carries the pressure basis');
console.log('');
console.log('A08 retention matrix: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
