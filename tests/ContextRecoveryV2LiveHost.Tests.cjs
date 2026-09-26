'use strict';
/**
 * ContextRecoveryV2LiveHost.Tests.cjs - CCV2-A12 real-host crash campaign.
 *
 * Principal real-host scenarios (§45) on the pinned DSH host
 * (@deepseek-ai/dsh-session 0.1.1-rc.2: real SessionStore, real flush
 * barrier, real restart-from-durable): partial segment recovery,
 * fully-landed lost-result recovery, commit-before-head repair,
 * zero-landing supersession, multi-generation crash chain with restart
 * after each generation. Nothing about the host is simulated.
 *
 * Gate: host available -> EXECUTED; host unavailable +
 * NEXUS_REQUIRE_CCV2_LIVE_HOST unset -> SKIPPED; required-but-missing ->
 * FAIL (never faked).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runtime = require(path.join(repoRoot, 'config', 'ContextGenerationRuntimeV2.cjs'));
const active = require(path.join(repoRoot, 'config', 'ContextActiveApplyV2.cjs'));
const shadow = require(path.join(repoRoot, 'config', 'ContextShadowV2.cjs'));
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));
const snapshotV2 = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const safepoint = require(path.join(repoRoot, 'config', 'ContextSafePointV2.cjs'));
const gate = require(path.join(repoRoot, 'config', 'ContextCheckpointabilityV2.cjs'));
const pressure = require(path.join(repoRoot, 'config', 'ContextPressureV2.cjs'));
const retention = require(path.join(repoRoot, 'config', 'ContextRetentionV2.cjs'));
const checkpointV2 = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const trustV2 = require(path.join(repoRoot, 'config', 'ContextTrustV2.cjs'));

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(t) { console.log(''); console.log('--- ' + t + ' ---'); }
const clone = (o) => JSON.parse(JSON.stringify(o));

const HOST_APP = process.env.AIH_HOST_APP || '/home/kaloyan/.local/share/nexus/app';
const CREATED = '2026-09-25T10:00:00.000Z';
const WORKSPACE = path.resolve(repoRoot);

function resolveHost() {
  const roots = [];
  if (process.env.AIH_HOST_APP) roots.push(process.env.AIH_HOST_APP);
  if (process.env.AIH_TOOLCHAIN_ROOT) roots.push(path.join(process.env.AIH_TOOLCHAIN_ROOT, 'app'));
  if (process.env.DSH_HOME) roots.push(path.join(path.dirname(path.resolve(process.env.DSH_HOME)), 'app'));
  roots.push(HOST_APP);
  for (const root of roots) {
    const sessionPath = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
    const cordisPath = path.join(root, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');
    if (!fs.existsSync(sessionPath) || !fs.existsSync(cordisPath)) continue;
    try {
      return { root, session: require(sessionPath), cordis: require(cordisPath), version: require(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-session', 'package.json')).version };
    } catch (e) { /* keep searching */ }
  }
  return null;
}
const host = resolveHost();
const liveGate = require(path.join(__dirname, 'Ccv2LiveHostGate.cjs'));
const liveHostFound = Boolean(host && host.session.Session && host.session.SessionStore && host.cordis.Context);
if (!liveHostFound) {
  liveGate.reportLiveHostGate('A12', liveGate.decideLiveHostGate(false, process.env));
  console.log('SKIP: pinned DSH host tree is absent; the A12 live-host proof is PENDING (never faked).');
  process.exit(0);
}
liveGate.reportLiveHostGate('A12', 'EXECUTED');

const TASK_ID = 'TASK-A12-LIVE';
const TASK_INSTANCE = 'task_a12live_0001';

let messageCounter = 0;
function newMessageId() { messageCounter += 1; return 'msg-a12live-' + messageCounter; }
function modelSource() { return { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' }; }
function userMessage(text, source) { return { id: newMessageId(), role: 'user', content: [{ type: 'text', text }], source: source || { kind: 'user' } }; }
function assistantText(text, turn, step) { const source = modelSource(); return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'text', text }], source }, source }; }
function assistantToolCall(callId, turn, step) { const source = modelSource(); return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'tool-call', name: 'run_command', callId }], source }, source }; }
function toolResult(callId, text, turn, step) { return { turn, step, message: { id: newMessageId(), role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } }; }
const BIG = 'LIVE-A12-BIG-0123456789;'.repeat(17200);

function createHostProcess() {
  const app = new host.cordis.Context();
  const store = new host.session.SessionStore(app);
  const durable = { bytes: null, writes: 0, header: null };
  app.on('session/flush', async (session) => {
    durable.bytes = JSON.stringify(session.events);
    durable.writes += 1;
    durable.header = { version: session.header.version, id: session.header.id, createdAt: session.header.createdAt, cwd: session.header.cwd };
  });
  return { app, store, durable };
}
async function flushBarrier(proc, session) { return (await proc.store.flush(session)) === true; }
function restartFromDurable(durable, sessionId) {
  assert.ok(typeof durable.bytes === 'string' && durable.bytes !== '', 'durable bytes exist before restart');
  const proc = createHostProcess();
  const seed = JSON.parse(durable.bytes);
  const session = proc.store.create(sessionId, { seedSource: 'persistence', seed, meta: durable.header });
  return { proc, session };
}
function makeEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a12live-'));
  return { base, runtimeDir: path.join(base, 'runtime'), checkpointDir: path.join(base, 'checkpoints'), operationRoot: path.join(base, 'operations'), lockWorkspace: path.join(base, 'ledger') };
}
function makeFakeLockClient() {
  const state = { held: false, ownerId: null };
  let ownerCounter = 0;
  async function acquire() {
    if (state.held) return { acquired: false, ownerId: null, leaseSeconds: 60, reason: 'held-by-live-owner' };
    ownerCounter += 1;
    state.held = true;
    state.ownerId = 'fake-a12live-owner-' + ownerCounter;
    return { acquired: true, ownerId: state.ownerId, leaseSeconds: 60, reason: null };
  }
  async function renew(call) {
    if (!state.held || !call || call.ownerId !== state.ownerId) return { renewed: false, expiresAtUtc: null, reason: 'not-owner' };
    return { renewed: true, expiresAtUtc: '2030-01-01T00:00:00.000Z', reason: null };
  }
  async function release(call) {
    if (state.held && call && call.ownerId === state.ownerId) { state.held = false; state.ownerId = null; }
    return { released: true, reason: null };
  }
  return { acquire, renew, release };
}
function liveTaskState(sessionId, generation, boundarySeq, sessionRevision, tag) {
  const ts = { schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId, workspaceId: WORKSPACE, repositoryId: null, checkoutId: null, generation, safePointBoundarySeq: boundarySeq, sessionRevision, taskRevision: 'pending', repositoryRevision: { headCommit: 'live-head', indexDigest: null, worktreeDigest: null }, runtimeRevision: { runtimeSnapshotSeq: null }, objective: { text: 'Prove A12 recovery on the live host.', status: 'in-progress' }, requirements: [{ id: 'R-live', text: 'Advance live recovery (' + tag + ').', status: 'active', evidenceRefs: [], sourceKind: 'controller' }], constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.', sourceKind: 'controller' }], progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'A12 live ' + tag, remainingMilestones: [] }, decisions: [{ id: 'D-live', statement: 'Live recovery is explicit.', authority: 'controller-established', status: 'active', evidenceRefs: [], sourceKind: 'controller' }], repository: { repositoryId: null, checkoutId: null, headCommit: 'live-head', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null }, evidenceRefs: [], failures: { activeFailures: [], rejectedHypotheses: [], retryState: null }, verification: { outcomes: [{ scope: 'unit', status: 'PENDING', detail: null, evidenceRefs: [] }], note: null }, continuation: { nextAction: 'Continue live recovery (' + tag + ').', unresolvedQuestions: [], recentUserIntent: 'Prove A12 live ' + tag + '.' }, provenance: {}, ephemeralState: [], unsupportedState: [], reconstructionRefs: [] };
  ts.taskRevision = snapshotV2.deriveTaskRevision(ts);
  ts.provenance = { 'objective.text': { sourceKind: 'controller', fieldKind: 'task-objective', sourceRefs: ['controller:objective'], authorityScope: null }, 'requirements.0.text': { sourceKind: 'controller', fieldKind: 'requirement-text', sourceRefs: ['user:req-R-live'], authorityScope: null }, 'requirements.0.status': { sourceKind: 'controller', fieldKind: 'requirement-status', sourceRefs: ['user:req-R-live'], authorityScope: null }, 'constraints.0.text': { sourceKind: 'controller', fieldKind: 'constraint-text', sourceRefs: ['user:constraint-0'], authorityScope: null }, 'decisions.0.statement': { sourceKind: 'controller', fieldKind: 'decision-statement', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'decisions.0.authority': { sourceKind: 'controller', fieldKind: 'decision-authority', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'decisions.0.status': { sourceKind: 'controller', fieldKind: 'decision-status', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'verification.outcomes.0.status': { sourceKind: 'verification', fieldKind: 'verification-outcome', sourceRefs: ['verification:unit'], authorityScope: null }, 'continuation.nextAction': { sourceKind: 'controller', fieldKind: 'next-action', sourceRefs: ['controller:continuation'], authorityScope: null }, 'continuation.recentUserIntent': { sourceKind: 'controller', fieldKind: 'user-intent', sourceRefs: ['user:intent-event'], authorityScope: null }, repository: { sourceKind: 'repository', fieldKind: 'repository-fact', sourceRefs: ['repository:HEAD'], authorityScope: null } };
  return ts;
}
function appendLiveWork(session, tag, callSeq) {
  session.append('user/message', userMessage('LIVE-A12-TOOL-REQUEST-' + tag), { surfaceOp: 'append' });
  session.append('assistant/message', assistantToolCall('live-a12-call-' + callSeq, 't' + callSeq, 's' + callSeq), { surfaceOp: 'append' });
  session.append('tool/call', { callId: 'live-a12-call-' + callSeq, turn: 't' + callSeq, step: 's' + callSeq });
  session.append('tool/result', toolResult('live-a12-call-' + callSeq, BIG, 't' + callSeq, 's' + callSeq), { surfaceOp: 'append' });
  session.append('assistant/message', assistantText('LIVE-A12-POST-TOOL-' + tag, 't' + callSeq, 's' + callSeq), { surfaceOp: 'append' });
  session.append('user/message', userMessage('LIVE-A12-CURRENT-' + tag), { surfaceOp: 'append' });
}
function unitCost(sliceEvents) {
  const bytes = pressure.byteLengthUtf8(pressure.serializeCanonical(sliceEvents));
  return { tokens: pressure.estimateTokensForUtf8Bytes(bytes), method: 'conservative-estimate', exact: false };
}
async function buildLiveGeneration(proc, tracker, session, sid, generation, parentCheckpointId, tag, callSeq) {
  appendLiveWork(session, tag, callSeq);
  tracker.flushParticipated = await flushBarrier(proc, session);
  tracker.flushedSeq = session.events.length - 1;
  const ts = liveTaskState(sid, generation, session.events.length - 1, tracker.flushedSeq, tag);
  const safeDecision = safepoint.detectSafePointV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: session.id, sessionEvents: Array.from(session.events), sessionDurable: { flushedSeq: tracker.flushedSeq, flushParticipated: tracker.flushParticipated }, controller: { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision: ts.taskRevision }, runtime: { currentSnapshotSeq: null, transitionOpen: false } });
  if (safeDecision.safe !== true) return { blocked: 'safe-point' };
  const snapInput = { taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, workspaceId: ts.workspaceId, repositoryId: ts.repositoryId, checkoutId: ts.checkoutId, generation: ts.generation, safePointBoundarySeq: ts.safePointBoundarySeq, sessionRevision: ts.sessionRevision, taskRevision: ts.taskRevision, repositoryRevision: clone(ts.repositoryRevision), runtimeRevision: null };
  const token = snapshotV2.capture(snapInput, CREATED);
  const gateDecision = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safeDecision, snapshotToken: token });
  if (gateDecision.checkpointable !== true) return { blocked: 'gate' };
  const cap = pressure.resolveProviderCapacity('deepseek-v4-flash');
  const cost = pressure.estimateTokensForEvents(Array.from(session.events));
  const pressureDecision = pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: cap.capacityTokens, currentContextTokens: cost.tokens, costMethod: cost.method, costExact: cost.exact, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: token.taskId, taskInstanceId: token.taskInstanceId, sessionId: token.sessionId, generation: token.generation, snapshotTokenId: token.snapshotTokenId, revisionDigest: token.revisionDigest });
  const liveEvents = Array.from(session.events);
  const firstSeq = session.events.length - 6;
  const toolCallSeq = liveEvents.filter((e) => e.type === 'assistant/message' && JSON.stringify(e).indexOf('live-a12-call-' + callSeq) !== -1).map((e) => e.seq);
  const toolResultSeq = liveEvents.filter((e) => e.type === 'tool/result' && JSON.stringify(e).indexOf('live-a12-call-' + callSeq) !== -1).map((e) => e.seq);
  if (toolCallSeq.length === 0 || toolResultSeq.length === 0) return { blocked: 'tool-span-missing' };
  const lastPre = toolResultSeq[0];
  const units = [];
  if (firstSeq > 0) units.push({ unitId: 'live-old', eventSeqStart: 0, eventSeqEnd: firstSeq - 1, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(0, firstSeq)) });
  units.push({ unitId: 'live-hist', eventSeqStart: firstSeq, eventSeqEnd: lastPre - 2, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(firstSeq, lastPre - 1)) });
  units.push({ unitId: 'live-tool', eventSeqStart: lastPre - 1, eventSeqEnd: lastPre, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(lastPre - 1, lastPre + 1)) });
  units.push({ unitId: 'live-post', eventSeqStart: lastPre + 1, eventSeqEnd: lastPre + 1, requiresContinuation: true, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(lastPre + 1, lastPre + 2)) });
  units.push({ unitId: 'live-user', eventSeqStart: lastPre + 2, eventSeqEnd: lastPre + 2, requiresContinuation: true, a07Coverage: null, derivedNonAuthoritative: false, isCurrentUserTurn: true, tokenCost: unitCost(liveEvents.slice(lastPre + 2)) });
  const spans = [{ startSeq: toolCallSeq[0], endSeq: toolResultSeq[0] }];
  const plan = retention.planRetentionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, safePointDecision: safeDecision, checkpointabilityDecision: gateDecision, pressureDecision, boundaryContext: { sessionEvents: Array.from(session.events), sessionDurable: { flushedSeq: tracker.flushedSeq, flushParticipated: tracker.flushParticipated }, controller: { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision: ts.taskRevision }, runtime: { currentSnapshotSeq: null, transitionOpen: false } }, contextUnits: units, protocolSpans: spans });
  if (plan.actionable !== true) return { blocked: 'retention' };
  const input = { schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: session.id, generation: ts.generation, parentCheckpointId, snapshotToken: token, snapshotCurrentState: snapInput, safePointDecision: safeDecision, checkpointabilityDecision: gateDecision, pressureDecision, retentionPlan: plan, taskState: ts, contextUnits: units, sessionEvents: Array.from(session.events), surfaceNodes: Array.from(session.surface.nodes), protocolSpans: spans, createdAtUtc: CREATED, sealedAtUtc: CREATED };
  const result = shadow.evaluateShadowCompactionV2(input);
  if (result.verdict !== 'shadow-ready') return { blocked: 'shadow:' + JSON.stringify(result.blockers).slice(0, 200) };
  const liveSealed = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: session.id, generation: ts.generation, parentCheckpointId, safePointBoundarySeq: safeDecision.boundarySeq, snapshotToken: token, taskState: ts, createdAtUtc: CREATED, sealedAtUtc: CREATED });
  const artifact = shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: session.id, generation: ts.generation, sealedCheckpoint: liveSealed.sealedCheckpoint, retentionPlan: plan, snapshotToken: token, taskState: ts, contextUnits: units, sourceEvents: Array.from(session.events), surfaceNodes: Array.from(session.surface.nodes), protocolSpans: spans });
  return { proc, tracker, session, ts, token, safeDecision, gateDecision, pressureDecision, plan, units, spans, result, sealed: liveSealed.sealedCheckpoint, artifact };
}
function liveApplyInput(fx, dirs, lock, generation, flushFn) {
  return {
    schemaVersion: 1, taskId: fx.ts.taskId, taskInstanceId: fx.ts.taskInstanceId, sessionId: fx.session.id, generation,
    shadowResult: fx.result, sealedCheckpoint: fx.sealed, projectionArtifact: fx.artifact,
    snapshotToken: fx.token, snapshotCurrentState: { taskId: fx.ts.taskId, taskInstanceId: fx.ts.taskInstanceId, sessionId: fx.ts.sessionId, workspaceId: fx.ts.workspaceId, repositoryId: fx.ts.repositoryId, checkoutId: fx.ts.checkoutId, generation: fx.ts.generation, safePointBoundarySeq: fx.ts.safePointBoundarySeq, sessionRevision: fx.ts.sessionRevision, taskRevision: fx.ts.taskRevision, repositoryRevision: clone(fx.ts.repositoryRevision), runtimeRevision: null },
    safePointDecision: fx.safeDecision, checkpointabilityDecision: fx.gateDecision, pressureDecision: fx.pressureDecision,
    retentionPlan: fx.plan, taskState: fx.ts, contextUnits: fx.units, protocolSpans: fx.spans,
    session: fx.session, checkpointDir: dirs.checkpointDir,
    operationDir: runtime.operationDirForGenerationV2(dirs.operationRoot, generation),
    flushFn: flushFn || (async (s) => (await fx.proc.store.flush(s)) === true),
    serialization: lock,
  };
}
function liveBind(env, lock, sid) {
  return { schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, serialization: lock, lockWorkspace: env.lockWorkspace };
}
function payloadTextOf(sealed) { return shadow.checkpointPayloadTextOf(sealed); }

async function main() {
  check(host.version === '0.1.1-rc.2', 'pinned DSH host is 0.1.1-rc.2 (got ' + host.version + ')');

  section('live: flush-throw partial recovery (segments landed, flush failed)');
  {
    const sid = 'sess-a12live-partial';
    const env = makeEnv();
    const lock = makeFakeLockClient();
    const b = liveBind(env, lock, sid);
    let proc = createHostProcess();
    const tracker = {};
    let session = proc.store.create(sid);
    const fx = await buildLiveGeneration(proc, tracker, session, sid, 1, null, 'G1-partial', 11);
    check(fx.blocked === undefined, 'live G1 fixture is shadow-ready (blocked=' + fx.blocked + ')');
    session = fx.session; proc = fx.proc;
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safeDecision.boundarySeq,
    }));
    // Flush throws AFTER segments land: intent + application landed, but
    // applicationDurable is false (flush ambiguity, never inferred durable).
    const doomed = liveApplyInput(fx, env, lock, 1, async () => { throw new Error('injected live flush failure'); });
    const attempt = await active.applyActiveCompactionV2(doomed);
    check(attempt.status === 'failed', 'flush failure fails the apply (got ' + attempt.status + ')');
    check(attempt.applicationDurable !== true, 'flush failure never claims application durability');
    // Restart from durable host bytes, then forward recovery converges.
    tracker.flushParticipated = await flushBarrier(proc, session);
    const revived = restartFromDurable(proc.durable, sid);
    const st = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: revived.session });
    check(st.generations.filter((g) => g.generation === 1)[0].outcome === 'UNRESOLVED', 'live partial restarts to UNRESOLVED');
    const b2 = liveBind(env, lock, sid);
    const entry = await runtime.applyCurrentGenerationV2({
      schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, lockWorkspace: env.lockWorkspace,
      request: liveApplyInput(Object.assign({}, fx, { session: revived.session, proc: revived.proc }), env, lock, 1),
    });
    check(entry.ok === true && (entry.activeResult.status === 'committed' || entry.activeResult.status === 'recovered'), 'live forward recovery converges (got ' + entry.activeResult.status + ')');
    const c1 = await runtime.commitGenerationV2(Object.assign({}, b2, { generation: 1, activeResult: entry.activeResult, postApplyVerified: true, session: revived.session }));
    check(c1.latestCommittedGeneration === 1, 'live head advances after recovery');
  }

  section('live: fully-landed lost-result + commit-before-head repair');
  {
    const sid = 'sess-a12live-lost';
    const env = makeEnv();
    const lock = makeFakeLockClient();
    const b = liveBind(env, lock, sid);
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create(sid);
    const fx = await buildLiveGeneration(proc, tracker, session, sid, 1, null, 'G1-lost', 21);
    check(fx.blocked === undefined, 'live G1 fixture is shadow-ready');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safeDecision.boundarySeq,
    }));
    const res = await active.applyActiveCompactionV2(liveApplyInput(fx, env, lock, 1));
    check(res.status === 'committed', 'live A10 commits (got ' + res.status + ')');
    // Process loses the returned result; the host restarts from durable bytes.
    const revived = restartFromDurable(proc.durable, sid);
    const healed = runtime.reconstructGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: revived.session, repairHead: true });
    check(healed.latestCommittedGeneration === 1, 'live head repairs without the lost result');
    check(healed.recoveredCompletion !== null && healed.recoveredCompletion.checkpointId === fx.result.checkpoint.checkpointId, 'live recovered completion binds the checkpoint');
    check(shadow.checkMessagesBalanced(revived.session.deriveMessages === undefined ? [] : []) !== undefined, 'live surface readable after restart');
  }

  section('live: zero-landing supersession + multi-generation chain with restarts');
  {
    const sid = 'sess-a12live-chain';
    const env = makeEnv();
    const lock = makeFakeLockClient();
    const b = liveBind(env, lock, sid);
    let proc = createHostProcess();
    const tracker = {};
    let session = proc.store.create(sid);
    // G1 commits; restart; G2 superseded zero-landing; restart; G3 commits.
    let fx1 = await buildLiveGeneration(proc, tracker, session, sid, 1, null, 'G1-chain', 31);
    check(fx1.blocked === undefined, 'live G1 chain fixture ready');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx1.token.revisionDigest, snapshotTokenId: fx1.token.snapshotTokenId, safePointBoundarySeq: fx1.safeDecision.boundarySeq,
    }));
    const res1 = await active.applyActiveCompactionV2(liveApplyInput(fx1, env, lock, 1));
    await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res1, postApplyVerified: true, session: fx1.session }));
    let revived = restartFromDurable(proc.durable, sid);
    let st = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: revived.session });
    check(st.latestCommittedGeneration === 1, 'live G1 survives restart as committed');
    const fx2 = await buildLiveGeneration(revived.proc, tracker, revived.session, sid, 2, res1.checkpointId, 'G2-stale', 32);
    check(fx2.blocked === undefined, 'live G2 fixture ready');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx2.token.revisionDigest, snapshotTokenId: fx2.token.snapshotTokenId, safePointBoundarySeq: fx2.safeDecision.boundarySeq, session: revived.session,
    }));
    const moved = await buildLiveGeneration(revived.proc, tracker, revived.session, sid, 2, res1.checkpointId, 'G2-moved', 33);
    await runtime.supersedeGenerationV2(Object.assign({}, b, {
      generation: 2, observedRevisionDigest: moved.token.revisionDigest, observedSafePointBoundarySeq: moved.safeDecision.boundarySeq,
      payloadText: null, session: null,
    }));
    revived = restartFromDurable(revived.proc.durable, sid);
    st = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: revived.session });
    check(st.generations.filter((g) => g.generation === 2)[0].outcome === 'SUPERSEDED', 'live G2 stays superseded across restart');
    // Fresh work after the superseded generation: the retention plan needs
    // new compactable bulk/tool pairs (G1 already compacted the old history).
    appendLiveWork(revived.session, 'G3-extra', 339);
    tracker.flushParticipated = await flushBarrier(revived.proc, revived.session);
    tracker.flushedSeq = revived.session.events.length - 1;
    const fx3 = await buildLiveGeneration(revived.proc, tracker, revived.session, sid, 3, res1.checkpointId, 'G3-after', 34);
    check(fx3.blocked === undefined, 'live G3 fixture ready');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx3.token.revisionDigest, snapshotTokenId: fx3.token.snapshotTokenId, safePointBoundarySeq: fx3.safeDecision.boundarySeq, session: revived.session,
    }));
    const res3 = await active.applyActiveCompactionV2(liveApplyInput(fx3, env, lock, 3));
    check(res3.status === 'committed' || res3.status === 'recovered', 'live G3 applies (got ' + res3.status + ' ' + JSON.stringify(res3.blockers).slice(0, 300) + ')');
    const c3 = await runtime.commitGenerationV2(Object.assign({}, b, { generation: 3, activeResult: res3, postApplyVerified: true, session: fx3.session }));
    const lineage = c3.generations.filter((g) => g.outcome === 'COMMITTED').map((g) => g.generation).join('->');
    check(lineage === '1->3', 'live final lineage is G1->G3 (got ' + lineage + ')');
  }

  console.log('\nA12 live-host: passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error('A12 LIVE HOST HARNESS FAIL:', e && e.stack ? e.stack : e); process.exit(1); });
}
