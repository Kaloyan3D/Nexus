'use strict';
/**
 * ContextPressureRetentionV2LiveHost.Tests.cjs - CCV2-A08 real-host proof.
 *
 * Proves the pressure + retention contracts against the REAL pinned DSH host
 * (@deepseek-ai/dsh-session 0.1.1-rc.2: real SessionStore, real append-only
 * session log, real store.flush durability barrier, real deriveMessages()
 * projection). Nothing is simulated: every session event below enters a real
 * host log through session.append(), the A06 boundary is really detected, the
 * A05 token is really captured, A07 really decides, and A08 really plans.
 * Planning stops before mutation: no session write, no projection write, no
 * checkpoint trigger occurs anywhere in this proof. A05H strict gate applies:
 * host absent + strict env = FAIL (never faked, never skipped green).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const pressure = require(path.join(repoRoot, 'config', 'ContextPressureV2.cjs'));
const retention = require(path.join(repoRoot, 'config', 'ContextRetentionV2.cjs'));
const snapshotV2 = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const safepoint = require(path.join(repoRoot, 'config', 'ContextSafePointV2.cjs'));
const gate = require(path.join(repoRoot, 'config', 'ContextCheckpointabilityV2.cjs'));
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(t) { console.log(''); console.log('--- ' + t + ' ---'); }
function codes(o) { return o.blockers.map((b) => b.code); }
const clone = (o) => JSON.parse(JSON.stringify(o));
const HOST_APP = process.env.AIH_HOST_APP || '/home/kaloyan/.local/share/nexus/app';
const CREATED = '2026-09-25T10:00:00.000Z';
const WORKSPACE = path.resolve(repoRoot);
function hostAppCandidates() {
  const roots = [];
  if (process.env.AIH_HOST_APP) roots.push(process.env.AIH_HOST_APP);
  if (process.env.AIH_TOOLCHAIN_ROOT) roots.push(path.join(process.env.AIH_TOOLCHAIN_ROOT, 'app'));
  if (process.env.DSH_HOME) roots.push(path.join(path.dirname(path.resolve(process.env.DSH_HOME)), 'app'));
  roots.push(HOST_APP);
  return roots;
}
function resolveHost() {
  for (const root of hostAppCandidates()) {
    const sessionPath = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
    const cordisPath = path.join(root, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');
    if (!fs.existsSync(sessionPath) || !fs.existsSync(cordisPath)) continue;
    try {
      return { root, sessionPath, cordisPath, session: require(sessionPath), cordis: require(cordisPath), version: require(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-session', 'package.json')).version };
    } catch (e) { }
  }
  return null;
}
const host = resolveHost();
const liveGate = require(path.join(__dirname, 'Ccv2LiveHostGate.cjs'));
const liveHostFound = Boolean(host && host.session.Session && host.session.SessionStore && host.cordis.Context);
if (!liveHostFound) {
  liveGate.reportLiveHostGate('A08', liveGate.decideLiveHostGate(false, process.env));
  console.log('SKIP: pinned DSH host tree is absent; the A08 live-host proof is PENDING (never faked).');
  process.exit(0);
}
liveGate.reportLiveHostGate('A08', 'EXECUTED');
const SessionStore = host.session.SessionStore;
const Context = host.cordis.Context;
{
  const src = fs.readFileSync(host.sessionPath, 'utf8');
  check(host.version === '0.1.1-rc.2', 'pinned DSH host is 0.1.1-rc.2 (got ' + host.version + ')');
  check(src.indexOf('async flush(session)') !== -1, 'pinned host still states the flush barrier contract');
}
let messageCounter = 0;
function newMessageId() { messageCounter += 1; return 'msg-a08live-' + messageCounter; }
function modelSource() { return { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' }; }
function userMessage(text, source) { return { id: newMessageId(), role: 'user', content: [{ type: 'text', text }], source: source || { kind: 'user' } }; }
function assistantText(text, turn, step) { const source = modelSource(); return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'text', text }], source }, source }; }
function assistantToolCall(callId, turn, step) { const source = modelSource(); return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'tool-call', name: 'run_command', callId }], source }, source }; }
function toolResult(callId, text, turn, step) { return { turn, step, message: { id: newMessageId(), role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } }; }
function createHostProcess() {
  const app = new Context();
  const store = new SessionStore(app);
  const durable = { bytes: null, writes: 0, flushedSessionIds: [] };
  app.on('session/flush', async (session) => { durable.bytes = JSON.stringify(session.events); durable.writes += 1; durable.flushedSessionIds.push(session.id); });
  return { app, store, durable };
}
async function flushBarrier(proc, session) { const p = await proc.store.flush(session); return p === true; }
function liveSafeInput(session, tracker, taskRevision) {
  return { schemaVersion: 1, taskId: 'TASK-A08-LIVE', taskInstanceId: 'task_a08live_0001', sessionId: session.id, sessionEvents: Array.from(session.events), sessionDurable: { flushedSeq: tracker.flushedSeq === undefined ? null : tracker.flushedSeq, flushParticipated: tracker.flushParticipated === undefined ? false : tracker.flushParticipated }, controller: { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision }, runtime: { currentSnapshotSeq: compaction.currentRuntimeSnapshotSeqOf(session), transitionOpen: false } };
}
function liveTaskState(sessionId, boundarySeq, sessionRevision) {
  const ts = { schemaVersion: 1, taskId: 'TASK-A08-LIVE', taskInstanceId: 'task_a08live_0001', sessionId, workspaceId: WORKSPACE, repositoryId: null, checkoutId: null, generation: 1, safePointBoundarySeq: boundarySeq, sessionRevision, taskRevision: 'pending', repositoryRevision: { headCommit: 'live-head', indexDigest: null, worktreeDigest: null }, runtimeRevision: { runtimeSnapshotSeq: null }, objective: { text: 'Prove A08 on the live host.', status: 'in-progress' }, requirements: [{ id: 'R-live', text: 'Planner decides over live state.', status: 'active', evidenceRefs: [], sourceKind: 'controller' }], constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.', sourceKind: 'controller' }], progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'A08 live', remainingMilestones: [] }, decisions: [{ id: 'D-live', statement: 'The live boundary authorizes planning.', authority: 'controller-established', status: 'active', evidenceRefs: [], sourceKind: 'controller' }], repository: { repositoryId: null, checkoutId: null, headCommit: 'live-head', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null }, evidenceRefs: [], failures: { activeFailures: [], rejectedHypotheses: [], retryState: null }, verification: { outcomes: [{ scope: 'unit', status: 'PENDING', detail: null, evidenceRefs: [] }], note: null }, continuation: { nextAction: 'Continue live work.', unresolvedQuestions: [], recentUserIntent: 'Prove A08 live.' }, provenance: {}, ephemeralState: [], unsupportedState: [], reconstructionRefs: [] };
  ts.taskRevision = snapshotV2.deriveTaskRevision(ts);
  ts.provenance = { 'objective.text': { sourceKind: 'controller', fieldKind: 'task-objective', sourceRefs: ['controller:objective'], authorityScope: null }, 'requirements.0.text': { sourceKind: 'controller', fieldKind: 'requirement-text', sourceRefs: ['user:req-R-live'], authorityScope: null }, 'requirements.0.status': { sourceKind: 'controller', fieldKind: 'requirement-status', sourceRefs: ['user:req-R-live'], authorityScope: null }, 'constraints.0.text': { sourceKind: 'controller', fieldKind: 'constraint-text', sourceRefs: ['user:constraint-0'], authorityScope: null }, 'decisions.0.statement': { sourceKind: 'controller', fieldKind: 'decision-statement', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'decisions.0.authority': { sourceKind: 'controller', fieldKind: 'decision-authority', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'decisions.0.status': { sourceKind: 'controller', fieldKind: 'decision-status', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'verification.outcomes.0.status': { sourceKind: 'verification', fieldKind: 'verification-outcome', sourceRefs: ['verification:unit'], authorityScope: null }, 'continuation.nextAction': { sourceKind: 'controller', fieldKind: 'next-action', sourceRefs: ['controller:continuation'], authorityScope: null }, 'continuation.recentUserIntent': { sourceKind: 'controller', fieldKind: 'user-intent', sourceRefs: ['user:intent-event'], authorityScope: null }, repository: { sourceKind: 'repository', fieldKind: 'repository-fact', sourceRefs: ['repository:HEAD'], authorityScope: null } };
  return ts;
}
function liveBoundaryContext(session, tracker, taskRevision) {
  return { sessionEvents: Array.from(session.events), sessionDurable: { flushedSeq: tracker.flushedSeq === undefined ? null : tracker.flushedSeq, flushParticipated: tracker.flushParticipated === undefined ? false : tracker.flushParticipated }, controller: { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision }, runtime: { currentSnapshotSeq: compaction.currentRuntimeSnapshotSeqOf(session), transitionOpen: false } };
}
function liveSnapshotInput(ts) {
  return { taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, workspaceId: ts.workspaceId, repositoryId: ts.repositoryId, checkoutId: ts.checkoutId, generation: ts.generation, safePointBoundarySeq: ts.safePointBoundarySeq, sessionRevision: ts.sessionRevision, taskRevision: ts.taskRevision, repositoryRevision: clone(ts.repositoryRevision), runtimeRevision: null };
}
function unitCost(sliceEvents) {
  const bytes = pressure.byteLengthUtf8(pressure.serializeCanonical(sliceEvents));
  return { tokens: pressure.estimateTokensForUtf8Bytes(bytes), method: 'conservative-estimate', exact: false };
}
function liveUnits(events) {
  const tail = events.length - 1;
  return [{ unitId: 'live-hist', eventSeqStart: 0, eventSeqEnd: 3, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(events.slice(0, 4)) }, { unitId: 'live-tool', eventSeqStart: 4, eventSeqEnd: 5, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(events.slice(4, 6)) }, { unitId: 'live-post', eventSeqStart: 6, eventSeqEnd: 6, requiresContinuation: true, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(events.slice(6, 7)) }, { unitId: 'live-user', eventSeqStart: tail, eventSeqEnd: tail, requiresContinuation: true, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: true, tokenCost: unitCost(events.slice(tail)) }];
}
async function main() {
  section('live: multi-turn session with closed tool lifecycle plans end to end');
  const proc = createHostProcess();
  const tracker = {};
  const session = proc.store.create('sess-a08live-plan', { meta: { cwd: WORKSPACE } });
  check(true, 'live session created through SessionStore.create (' + host.version + ')');
  session.append('user/message', userMessage('LIVE-A08-FIRST-REQUEST'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantText('LIVE-A08-FIRST-REPLY', 't1', 's1'), { surfaceOp: 'append' });
  session.append('user/message', userMessage('LIVE-A08-TOOL-REQUEST'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantToolCall('live-a08-call-1', 't1', 's1'), { surfaceOp: 'append' });
  session.append('tool/call', { callId: 'live-a08-call-1', turn: 't1', step: 's1' });
  session.append('tool/result', toolResult('live-a08-call-1', 'LIVE-A08-TOOL-OK', 't1', 's1'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantText('LIVE-A08-POST-TOOL', 't1', 's1'), { surfaceOp: 'append' });
  session.append('user/message', userMessage('LIVE-A08-CURRENT'), { surfaceOp: 'append' });
  check(session.events.length === 8, 'live log holds 8 real events (seqs 0..7)');
  tracker.flushParticipated = await flushBarrier(proc, session);
  tracker.flushedSeq = session.events.length - 1;
  check(tracker.flushParticipated === true, 'live store.flush(session) reports a participating listener');
  const ts = liveTaskState(session.id, session.events.length - 1, tracker.flushedSeq);
  const safeDecision = safepoint.detectSafePointV2(liveSafeInput(session, tracker, ts.taskRevision));
  check(safeDecision.safe === true, 'live committed tail with closed tool lifecycle is SAFE (real A06)');
  check(safeDecision.boundarySeq === session.events.length - 1, 'live boundarySeq is the grounded tail seq');
  const token = snapshotV2.capture(liveSnapshotInput(ts), CREATED);
  check(snapshotV2.validateSnapshotToken(token).valid === true, 'live snapshot token captures (real A05)');
  const gateDecision = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safeDecision, snapshotToken: token });
  check(gateDecision.checkpointable === true, 'live SAFE plus live token yields checkpointable (real A07)');
  const cap = pressure.resolveProviderCapacity('deepseek-v4-flash');
  check(cap.known === true && cap.capacityTokens === 131072, 'live pressure capacity resolves from the registry (never invented)');
  const cost = pressure.estimateTokensForEvents(Array.from(session.events));
  check(cost.method === 'conservative-estimate' && cost.exact === false, 'live context cost is an explicit conservative estimate');
  const pressureDecision = pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: cap.capacityTokens, currentContextTokens: cost.tokens, costMethod: cost.method, costExact: cost.exact, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: token.taskId, taskInstanceId: token.taskInstanceId, sessionId: token.sessionId, generation: token.generation, snapshotTokenId: token.snapshotTokenId, revisionDigest: token.revisionDigest });
  check(pressureDecision.known === true, 'live pressure is known (got ' + pressureDecision.level + ')');
  check(pressure.validatePressureDecision(pressureDecision).valid === true, 'live pressure decision validates');
  const eventsBefore = JSON.stringify(session.events);
  const messagesBefore = JSON.stringify(session.deriveMessages());
  const units = liveUnits(Array.from(session.events));
  const plan = retention.planRetentionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, safePointDecision: safeDecision, checkpointabilityDecision: gateDecision, pressureDecision, boundaryContext: liveBoundaryContext(session, tracker, ts.taskRevision), contextUnits: units, protocolSpans: [{ startSeq: 3, endSeq: 5 }] });
  check(retention.validateRetentionPlan(plan).valid === true, 'live retention plan validates');
  check(JSON.stringify(session.events) === eventsBefore, 'planning wrote no session events (read-only)');
  check(JSON.stringify(session.deriveMessages()) === messagesBefore, 'planning left deriveMessages() untouched (read-only)');
  function pcls(id) { for (const c of plan.classifications) { if (c.unitId === id) return c; } return null; }
  check(pcls('live-hist').retentionClass === 'CHECKPOINT_COVERED', 'live history is CHECKPOINT_COVERED');
  check(pcls('live-tool').retentionClass === 'CHECKPOINT_COVERED', 'live closed tool lifecycle is CHECKPOINT_COVERED');
  check(pcls('live-post').retentionClass === 'NOT_ELIGIBLE', 'live uncovered post-tool state is NOT_ELIGIBLE');
  check(pcls('live-user').retentionClass === 'ACTIVE_REQUIRED', 'live current request is ACTIVE_REQUIRED');
  check(plan.candidateCompactionBoundarySeq === 5, 'live cut is the real tool-result seq 5 (got ' + String(plan.candidateCompactionBoundarySeq) + ')');
  check(plan.candidateCompactionBoundarySeq <= safeDecision.boundarySeq, 'live cut never passes the A06 boundary');
  check(session.events[plan.candidateCompactionBoundarySeq].type === 'tool/result', 'live cut lands on the real tool-result event');
  const liveCutPoint = plan.candidateCompactionBoundarySeq + 1;
  check(!(liveCutPoint > 3 && liveCutPoint <= 5), 'cut point sits outside the live tool span 3..5');
  check(plan.retainedSuffixStartSeq === 6, 'live retained suffix starts at 6');
  const liveCtx = liveBoundaryContext(session, tracker, ts.taskRevision);
  function liveHistVerdict(seq) {
    return safepoint.classifyHistoricalBoundaryV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: session.id, sessionEvents: liveCtx.sessionEvents, sessionDurable: liveCtx.sessionDurable, controller: liveCtx.controller, runtime: liveCtx.runtime, candidateSeq: seq });
  }
  const liveV5 = liveHistVerdict(5);
  check(safepoint.validateHistoricalBoundaryDecision(liveV5).valid === true, 'live A06 historical verdict validates');
  check(liveV5.safe === true && liveV5.boundaryKind === 'tool-result-committed', 'A06 authorizes historical seq 5 as tool-result-committed (owns the verdict)');
  check(plan.candidateCompactionBoundarySeq === 5 && liveV5.candidateSeq === 5, 'plan candidate equals the A06-authorized historical cut');
  const liveV3 = liveHistVerdict(3);
  check(liveV3.safe === false, 'live mid-lifecycle seq 3 is NOT A06-safe (open tool edge)');
  check(liveV3.blockers.map((b) => b.code).indexOf('safe-point-tool-call-open') !== -1, 'live seq 3 refusal names tool-call-open (A06 rule, not event type)');
  const suffixHasUser = plan.classifications.filter((c) => c.eventSeqStart >= plan.retainedSuffixStartSeq && c.unitId === 'live-user').length === 1;
  check(suffixHasUser, 'live retained suffix holds the current request exactly once');
  check(plan.projectionPrecision === 'estimated', 'live small-context projections stay honest (estimated)');
  check(plan.actionable === false && codes(plan).length === 1 && codes(plan)[0] === 'retention-insufficient-reclaim', 'live small-context plan is honestly not actionable: only insufficient-reclaim, no safety block');
  section('live: projection dry run is read-only and boundary-faithful');
  const projected = JSON.stringify(session.deriveMessages());
  const occurrences = projected.split('LIVE-A08-CURRENT').length - 1;
  check(occurrences === 1, 'current user request survives exactly once in deriveMessages()');
  check(plan.eligiblePrefixEndSeq !== null, 'dry run has an eligible prefix');
  for (const c of plan.classifications) {
    if (c.eventSeqEnd <= plan.eligiblePrefixEndSeq) { check(c.retentionClass !== 'NOT_ELIGIBLE' && c.retentionClass !== 'ACTIVE_REQUIRED', 'every event at or before the cut is eligible (' + c.unitId + ')'); }
    check(c.eventSeqEnd <= session.events.length - 1, 'every planned unit references a real event seq (' + c.unitId + ')');
  }
  const cutPoint = plan.candidateCompactionBoundarySeq + 1;
  check(!(cutPoint > 3 && cutPoint <= 5), 'dry-run cut never splits the live tool lifecycle');
  check(proc.durable.writes >= 1, 'live durability barrier participated at least once');
  section('live: continued work makes the old plan stale; a fresh plan is required');
  session.append('user/message', userMessage('LIVE-A08-NEXT'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantText('LIVE-A08-NEXT-REPLY', 't2', 's1'), { surfaceOp: 'append' });
  tracker.flushParticipated = await flushBarrier(proc, session);
  tracker.flushedSeq = session.events.length - 1;
  const ts2 = liveTaskState(session.id, session.events.length - 1, tracker.flushedSeq);
  const safe2 = safepoint.detectSafePointV2(liveSafeInput(session, tracker, ts2.taskRevision));
  check(safe2.safe === true, 'post-work boundary is SAFE again');
  const token2 = snapshotV2.capture(liveSnapshotInput(ts2), CREATED);
  const freshBindings = { snapshotTokenId: token2.snapshotTokenId, revisionDigest: token2.revisionDigest, safePointBoundarySeq: safe2.boundarySeq, generation: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: 131072 };
  const staleCheck = retention.assertRetentionPlanFresh(plan, freshBindings);
  check(staleCheck.ok === false && staleCheck.reason === 'retention-plan-stale', 'continued live work makes the old plan STALE');
  const gate2 = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts2, safePointDecision: safe2, snapshotToken: token2 });
  check(gate2.checkpointable === true, 're-capture after live work restores checkpointability');
  const cost2 = pressure.estimateTokensForEvents(Array.from(session.events));
  const pressure2 = pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: 131072, currentContextTokens: cost2.tokens, costMethod: cost2.method, costExact: cost2.exact, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: token2.taskId, taskInstanceId: token2.taskInstanceId, sessionId: token2.sessionId, generation: token2.generation, snapshotTokenId: token2.snapshotTokenId, revisionDigest: token2.revisionDigest });
  const liveEvents2 = Array.from(session.events);
  const units2 = [{ unitId: 'live-hist', eventSeqStart: 0, eventSeqEnd: 3, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents2.slice(0, 4)) }, { unitId: 'live-tool', eventSeqStart: 4, eventSeqEnd: 5, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents2.slice(4, 6)) }, { unitId: 'live-post', eventSeqStart: 6, eventSeqEnd: 7, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents2.slice(6, 8)) }, { unitId: 'live-next', eventSeqStart: 8, eventSeqEnd: 8, requiresContinuation: true, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents2.slice(8, 9)) }, { unitId: 'live-user-2', eventSeqStart: 9, eventSeqEnd: 9, requiresContinuation: true, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: true, tokenCost: unitCost(liveEvents2.slice(9)) }];
  const plan2 = retention.planRetentionV2({ schemaVersion: 1, taskId: ts2.taskId, taskInstanceId: ts2.taskInstanceId, sessionId: ts2.sessionId, generation: ts2.generation, snapshotToken: token2, safePointDecision: safe2, checkpointabilityDecision: gate2, pressureDecision: pressure2, boundaryContext: liveBoundaryContext(session, tracker, ts2.taskRevision), contextUnits: units2, protocolSpans: [{ startSeq: 3, endSeq: 5 }] });
  check(retention.validateRetentionPlan(plan2).valid === true, 'fresh live plan validates');
  check(plan2.retentionPlanId !== plan.retentionPlanId, 'fresh live plan has distinct identity');
  freshBindings.pressureBasisDigest = plan2.pressureBasisDigest;
  check(retention.assertRetentionPlanFresh(plan2, freshBindings).ok === true, 'fresh live plan (plus basis) is fresh against live state');
  section('live: open tool edge blocks the plan on the real UNSAFE decision');
  const proc3 = createHostProcess();
  const tracker3 = {};
  const session3 = proc3.store.create('sess-a08live-openedge', { meta: { cwd: WORKSPACE } });
  session3.append('user/message', userMessage('LIVE-A08-OPEN-REQUEST'), { surfaceOp: 'append' });
  session3.append('assistant/message', assistantToolCall('live-a08-open-1', 't1', 's1'), { surfaceOp: 'append' });
  tracker3.flushParticipated = await flushBarrier(proc3, session3);
  tracker3.flushedSeq = session3.events.length - 1;
  const ts3 = liveTaskState(session3.id, tracker3.flushedSeq, tracker3.flushedSeq);
  const unsafeLive = safepoint.detectSafePointV2(liveSafeInput(session3, tracker3, ts3.taskRevision));
  check(unsafeLive.safe === false, 'live open tool call is UNSAFE (real A06)');
  const token3 = snapshotV2.capture(liveSnapshotInput(ts3), CREATED);
  const gate3 = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts3, safePointDecision: unsafeLive, snapshotToken: token3 });
  check(gate3.checkpointable === false, 'UNSAFE live boundary blocks even with a fresh token');
  const cost3 = pressure.estimateTokensForEvents(Array.from(session3.events));
  const pressure3 = pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: 131072, currentContextTokens: cost3.tokens, costMethod: cost3.method, costExact: cost3.exact, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: token3.taskId, taskInstanceId: token3.taskInstanceId, sessionId: token3.sessionId, generation: token3.generation, snapshotTokenId: token3.snapshotTokenId, revisionDigest: token3.revisionDigest });
  const plan3 = retention.planRetentionV2({ schemaVersion: 1, taskId: ts3.taskId, taskInstanceId: ts3.taskInstanceId, sessionId: ts3.sessionId, generation: ts3.generation, snapshotToken: token3, safePointDecision: unsafeLive, checkpointabilityDecision: gate3, pressureDecision: pressure3, boundaryContext: liveBoundaryContext(session3, tracker3, ts3.taskRevision), contextUnits: [{ unitId: 'open-hist', eventSeqStart: 0, eventSeqEnd: 0, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(Array.from(session3.events).slice(0, 1)) }, { unitId: 'open-user', eventSeqStart: 1, eventSeqEnd: 1, requiresContinuation: true, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: true, tokenCost: unitCost(Array.from(session3.events).slice(1)) }], protocolSpans: [] });
  check(plan3.actionable === false, 'CRITICAL-or-not, UNSAFE live boundary yields no actionable plan');
  check(codes(plan3).indexOf('retention-safe-point-required') !== -1, 'open edge carries retention-safe-point-required');
  check(plan3.candidateCompactionBoundarySeq === null, 'UNSAFE live boundary yields no candidate cut');
}
main().then(() => { console.log(''); console.log('A08 live-host proof: ' + passed + ' passed, ' + failed + ' failed'); if (failed > 0) process.exit(1); }).catch((e) => { console.log('FAIL: live proof threw :: ' + String((e && e.message) || e).slice(0, 400)); process.exit(1); });
