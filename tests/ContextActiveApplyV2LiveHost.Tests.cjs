'use strict';
/**
 * ContextActiveApplyV2LiveHost.Tests.cjs - CCV2-A10 real-host proof.
 *
 * Proves transactional active apply against the REAL pinned DSH host
 * (@deepseek-ai/dsh-session 0.1.1-rc.2: real SessionStore, real append-only
 * log, real store.flush durability barrier, real deriveMessages(), real
 * Session.fromRestore resume). Nothing about the host is simulated: every
 * event enters a real log through session.append(), the A06 boundary is
 * really detected, the A05 token really captured, A07/A08 really decide,
 * A09 really evaluates, and A10 really applies (A02 operation, durable
 * checkpoint, flush, post-apply proof). A05H strict gate applies: host
 * absent + strict env = FAIL (never faked).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const active = require(path.join(repoRoot, 'config', 'ContextActiveApplyV2.cjs'));
const shadow = require(path.join(repoRoot, 'config', 'ContextShadowV2.cjs'));
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));
const pressure = require(path.join(repoRoot, 'config', 'ContextPressureV2.cjs'));
const retention = require(path.join(repoRoot, 'config', 'ContextRetentionV2.cjs'));
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
const clone = (o) => JSON.parse(JSON.stringify(o));
function stripIds(v) {
  if (Array.isArray(v)) return v.map(stripIds);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) { if (k === 'id') continue; out[k] = stripIds(v[k]); }
    return out;
  }
  return v;
}
const canon = (v) => shadow.serializeCanonical(stripIds(v));

const HOST_APP = process.env.AIH_HOST_APP || '/home/kaloyan/.local/share/nexus/app';
const CREATED = '2026-09-25T10:00:00.000Z';
const WORKSPACE = path.resolve(repoRoot);
const RUNTIME_PLUGIN = '@deepseek-ai/dsh-system-prompt';

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
    } catch (e) { /* keep searching */ }
  }
  return null;
}
const host = resolveHost();
const liveGate = require(path.join(__dirname, 'Ccv2LiveHostGate.cjs'));
const liveHostFound = Boolean(host && host.session.Session && host.session.SessionStore && host.cordis.Context);
if (!liveHostFound) {
  liveGate.reportLiveHostGate('A10', liveGate.decideLiveHostGate(false, process.env));
  console.log('SKIP: pinned DSH host tree is absent; the A10 live-host proof is PENDING (never faked).');
  process.exit(0);
}
liveGate.reportLiveHostGate('A10', 'EXECUTED');
const SessionStore = host.session.SessionStore;
const Context = host.cordis.Context;
{
  const src = fs.readFileSync(host.sessionPath, 'utf8');
  check(host.version === '0.1.1-rc.2', 'pinned DSH host is 0.1.1-rc.2 (got ' + host.version + ')');
  check(src.indexOf('async flush(session)') !== -1, 'pinned host still states the flush barrier contract');
  check(src.indexOf('static fromRestore(id, seed, header)') !== -1, 'pinned host still states the restore contract');
}

let messageCounter = 0;
function newMessageId() { messageCounter += 1; return 'msg-a10live-' + messageCounter; }
function modelSource() { return { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' }; }
function userMessage(text, source) { return { id: newMessageId(), role: 'user', content: [{ type: 'text', text }], source: source || { kind: 'user' } }; }
function runtimeSnapshot(text) { return userMessage(text, { kind: 'plugin', plugin: RUNTIME_PLUGIN, form: 'snapshot' }); }
function assistantText(text, turn, step) { const source = modelSource(); return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'text', text }], source }, source }; }
function assistantToolCall(callId, turn, step) { const source = modelSource(); return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'tool-call', name: 'run_command', callId }], source }, source }; }
function toolResult(callId, text, turn, step) { return { turn, step, message: { id: newMessageId(), role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } }; }

function createHostProcess() {
  const app = new Context();
  const store = new SessionStore(app);
  const durable = { bytes: null, writes: 0, header: null };
  app.on('session/flush', async (session) => {
    durable.bytes = JSON.stringify(session.events);
    durable.writes += 1;
    durable.header = { version: session.header.version, id: session.header.id, createdAt: session.header.createdAt, cwd: session.header.cwd };
  });
  return { app, store, durable };
}
async function flushBarrier(proc, session) { const p = await proc.store.flush(session); return p === true; }
function restartFromDurable(durable, sessionId) {
  assert.ok(typeof durable.bytes === 'string' && durable.bytes !== '', 'durable bytes exist before restart');
  const proc = createHostProcess();
  const seed = JSON.parse(durable.bytes);
  const session = proc.store.create(sessionId, { seedSource: 'persistence', seed, meta: durable.header });
  return { proc, session };
}
function liveTaskState(sessionId, boundarySeq, sessionRevision) {
  const ts = { schemaVersion: 1, taskId: 'TASK-A10-LIVE', taskInstanceId: 'task_a10live_0001', sessionId, workspaceId: WORKSPACE, repositoryId: null, checkoutId: null, generation: 1, safePointBoundarySeq: boundarySeq, sessionRevision, taskRevision: 'pending', repositoryRevision: { headCommit: 'live-head', indexDigest: null, worktreeDigest: null }, runtimeRevision: { runtimeSnapshotSeq: null }, objective: { text: 'Prove A10 active apply on the live host.', status: 'in-progress' }, requirements: [{ id: 'R-live', text: 'Apply exactly the shadow prediction live.', status: 'active', evidenceRefs: [], sourceKind: 'controller' }], constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.', sourceKind: 'controller' }], progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'A10 live', remainingMilestones: [] }, decisions: [{ id: 'D-live', statement: 'The live apply path is explicit.', authority: 'controller-established', status: 'active', evidenceRefs: [], sourceKind: 'controller' }], repository: { repositoryId: null, checkoutId: null, headCommit: 'live-head', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null }, evidenceRefs: [], failures: { activeFailures: [], rejectedHypotheses: [], retryState: null }, verification: { outcomes: [{ scope: 'unit', status: 'PENDING', detail: null, evidenceRefs: [] }], note: null }, continuation: { nextAction: 'Continue live active-apply work.', unresolvedQuestions: [], recentUserIntent: 'Prove A10 live.' }, provenance: {}, ephemeralState: [], unsupportedState: [], reconstructionRefs: [] };
  ts.taskRevision = snapshotV2.deriveTaskRevision(ts);
  ts.provenance = { 'objective.text': { sourceKind: 'controller', fieldKind: 'task-objective', sourceRefs: ['controller:objective'], authorityScope: null }, 'requirements.0.text': { sourceKind: 'controller', fieldKind: 'requirement-text', sourceRefs: ['user:req-R-live'], authorityScope: null }, 'requirements.0.status': { sourceKind: 'controller', fieldKind: 'requirement-status', sourceRefs: ['user:req-R-live'], authorityScope: null }, 'constraints.0.text': { sourceKind: 'controller', fieldKind: 'constraint-text', sourceRefs: ['user:constraint-0'], authorityScope: null }, 'decisions.0.statement': { sourceKind: 'controller', fieldKind: 'decision-statement', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'decisions.0.authority': { sourceKind: 'controller', fieldKind: 'decision-authority', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'decisions.0.status': { sourceKind: 'controller', fieldKind: 'decision-status', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'verification.outcomes.0.status': { sourceKind: 'verification', fieldKind: 'verification-outcome', sourceRefs: ['verification:unit'], authorityScope: null }, 'continuation.nextAction': { sourceKind: 'controller', fieldKind: 'next-action', sourceRefs: ['controller:continuation'], authorityScope: null }, 'continuation.recentUserIntent': { sourceKind: 'controller', fieldKind: 'user-intent', sourceRefs: ['user:intent-event'], authorityScope: null }, repository: { sourceKind: 'repository', fieldKind: 'repository-fact', sourceRefs: ['repository:HEAD'], authorityScope: null } };
  return ts;
}
function liveSnapshotInput(ts) {
  return { taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, workspaceId: ts.workspaceId, repositoryId: ts.repositoryId, checkoutId: ts.checkoutId, generation: ts.generation, safePointBoundarySeq: ts.safePointBoundarySeq, sessionRevision: ts.sessionRevision, taskRevision: ts.taskRevision, repositoryRevision: clone(ts.repositoryRevision), runtimeRevision: null };
}
function liveSafeInput(session, tracker, taskRevision) {
  return { schemaVersion: 1, taskId: 'TASK-A10-LIVE', taskInstanceId: 'task_a10live_0001', sessionId: session.id, sessionEvents: Array.from(session.events), sessionDurable: { flushedSeq: tracker.flushedSeq === undefined ? null : tracker.flushedSeq, flushParticipated: tracker.flushParticipated === undefined ? false : tracker.flushParticipated }, controller: { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision }, runtime: { currentSnapshotSeq: null, transitionOpen: false } };
}
function liveBoundaryContext(session, tracker, taskRevision) {
  return { sessionEvents: Array.from(session.events), sessionDurable: { flushedSeq: tracker.flushedSeq === undefined ? null : tracker.flushedSeq, flushParticipated: tracker.flushParticipated === undefined ? false : tracker.flushParticipated }, controller: { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision }, runtime: { currentSnapshotSeq: null, transitionOpen: false } };
}
function unitCost(sliceEvents) {
  const bytes = pressure.byteLengthUtf8(pressure.serializeCanonical(sliceEvents));
  return { tokens: pressure.estimateTokensForUtf8Bytes(bytes), method: 'conservative-estimate', exact: false };
}
const BIG = 'LIVE-A10-BIG-0123456789;'.repeat(17200);

async function buildLiveShadowReady(sid, withRuntime) {
  const proc = createHostProcess();
  const tracker = {};
  const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
  session.append('user/message', userMessage('LIVE-A10-FIRST-REQUEST'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantText('LIVE-A10-FIRST-REPLY', 't1', 's1'), { surfaceOp: 'append' });
  if (withRuntime) session.append('user/message', runtimeSnapshot('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nsandbox: workspace-write\npolicy-generation: A'), { surfaceOp: 'append' });
  session.append('user/message', userMessage('LIVE-A10-TOOL-REQUEST'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantToolCall('live-a10-call-1', 't1', 's1'), { surfaceOp: 'append' });
  session.append('tool/call', { callId: 'live-a10-call-1', turn: 't1', step: 's1' });
  session.append('tool/result', toolResult('live-a10-call-1', BIG, 't1', 's1'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantText('LIVE-A10-POST-TOOL', 't1', 's1'), { surfaceOp: 'append' });
  session.append('user/message', userMessage('LIVE-A10-CURRENT'), { surfaceOp: 'append' });
  tracker.flushParticipated = await flushBarrier(proc, session);
  tracker.flushedSeq = session.events.length - 1;
  const ts = liveTaskState(session.id, session.events.length - 1, tracker.flushedSeq);
  const safeDecision = safepoint.detectSafePointV2(liveSafeInput(session, tracker, ts.taskRevision));
  if (safeDecision.safe !== true) return { proc, tracker, session, ts, blocked: 'safe-point' };
  const token = snapshotV2.capture(liveSnapshotInput(ts), CREATED);
  const gateDecision = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safeDecision, snapshotToken: token });
  if (gateDecision.checkpointable !== true) return { proc, tracker, session, ts, blocked: 'gate' };
  const cap = pressure.resolveProviderCapacity('deepseek-v4-flash');
  const cost = pressure.estimateTokensForEvents(Array.from(session.events));
  const pressureDecision = pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: cap.capacityTokens, currentContextTokens: cost.tokens, costMethod: cost.method, costExact: cost.exact, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: token.taskId, taskInstanceId: token.taskInstanceId, sessionId: token.sessionId, generation: token.generation, snapshotTokenId: token.snapshotTokenId, revisionDigest: token.revisionDigest });
  const liveEvents = Array.from(session.events);
  const surfaceSeqs = Array.from(session.surface.nodes);
  // Units tile the authoritative log; the tool lifecycle span is declared so
  // the cut never splits it. The runtime snapshot (multi case) is covered.
  const rt = surfaceSeqs.filter((sq) => { const e = session.events[sq]; return e && e.data && e.data.source && e.data.source.plugin === RUNTIME_PLUGIN; });
  const toolCallSeq = liveEvents.filter((e) => e.type === 'assistant/message' && JSON.stringify(e).indexOf('live-a10-call-1') !== -1).map((e) => e.seq);
  const toolResultSeq = liveEvents.filter((e) => e.type === 'tool/result').map((e) => e.seq);
  const firstSeq = 0;
  const lastPre = toolResultSeq[0];
  const units = [];
  if (rt.length > 0) {
    units.push({ unitId: 'live-pre', eventSeqStart: firstSeq, eventSeqEnd: rt[0] - 1, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(firstSeq, rt[0])) });
    units.push({ unitId: 'live-runtime', eventSeqStart: rt[0], eventSeqEnd: rt[0], requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(rt[0], rt[0] + 1)) });
    units.push({ unitId: 'live-tool', eventSeqStart: rt[0] + 1, eventSeqEnd: lastPre, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(rt[0] + 1, lastPre + 1)) });
  } else {
    units.push({ unitId: 'live-hist', eventSeqStart: firstSeq, eventSeqEnd: lastPre - 2, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(firstSeq, lastPre - 1)) });
    units.push({ unitId: 'live-tool', eventSeqStart: lastPre - 1, eventSeqEnd: lastPre, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(lastPre - 1, lastPre + 1)) });
  }
  units.push({ unitId: 'live-post', eventSeqStart: lastPre + 1, eventSeqEnd: lastPre + 1, requiresContinuation: true, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(lastPre + 1, lastPre + 2)) });
  units.push({ unitId: 'live-user', eventSeqStart: lastPre + 2, eventSeqEnd: lastPre + 2, requiresContinuation: true, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: true, tokenCost: unitCost(liveEvents.slice(lastPre + 2)) });
  const spans = [{ startSeq: toolCallSeq[0], endSeq: toolResultSeq[0] }];
  const plan = retention.planRetentionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, safePointDecision: safeDecision, checkpointabilityDecision: gateDecision, pressureDecision, boundaryContext: liveBoundaryContext(session, tracker, ts.taskRevision), contextUnits: units, protocolSpans: spans });
  if (plan.actionable !== true) return { proc, tracker, session, ts, blocked: 'retention:' + JSON.stringify(plan.blockers).slice(0, 200) };
  const input = { schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: session.id, generation: ts.generation, snapshotToken: token, snapshotCurrentState: liveSnapshotInput(ts), safePointDecision: safeDecision, checkpointabilityDecision: gateDecision, pressureDecision, retentionPlan: plan, taskState: ts, contextUnits: units, sessionEvents: Array.from(session.events), surfaceNodes: Array.from(session.surface.nodes), protocolSpans: spans, createdAtUtc: CREATED, sealedAtUtc: CREATED };
  const result = shadow.evaluateShadowCompactionV2(input);
  if (result.verdict !== 'shadow-ready') return { proc, tracker, session, ts, blocked: 'shadow:' + JSON.stringify(result.blockers).slice(0, 300) };
  const liveSealed = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: session.id, generation: ts.generation, parentCheckpointId: null, safePointBoundarySeq: safeDecision.boundarySeq, snapshotToken: token, taskState: ts, createdAtUtc: CREATED, sealedAtUtc: CREATED });
  const artifact = shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: session.id, generation: ts.generation, sealedCheckpoint: liveSealed.sealedCheckpoint, retentionPlan: plan, snapshotToken: token, taskState: ts, contextUnits: units, sourceEvents: Array.from(session.events), surfaceNodes: Array.from(session.surface.nodes), protocolSpans: spans });
  return { proc, tracker, session, ts, token, safeDecision, gateDecision, pressureDecision, plan, units, spans, result, sealed: liveSealed.sealedCheckpoint, artifact };
}

function makeFakeLockClient() {
  const state = { held: false, ownerId: null };
  let ownerCounter = 0;
  async function acquire() {
    if (state.held) return { acquired: false, ownerId: null, leaseSeconds: 60, reason: 'held-by-live-owner' };
    ownerCounter += 1;
    state.held = true;
    state.ownerId = 'fake-live-owner-' + ownerCounter;
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
  return { acquire: acquire, renew: renew, release: release };
}

function applyInputForLive(fx, over) {
  const input = {
    schemaVersion: 1,
    taskId: fx.ts.taskId, taskInstanceId: fx.ts.taskInstanceId, sessionId: fx.session.id, generation: fx.ts.generation,
    shadowResult: fx.result, sealedCheckpoint: fx.sealed, projectionArtifact: fx.artifact,
    snapshotToken: fx.token, snapshotCurrentState: liveSnapshotInput(fx.ts),
    safePointDecision: fx.safeDecision, checkpointabilityDecision: fx.gateDecision, pressureDecision: fx.pressureDecision,
    retentionPlan: fx.plan, taskState: fx.ts, contextUnits: fx.units, protocolSpans: fx.spans,
    session: fx.session,
    checkpointDir: (over && over.checkpointDir !== undefined) ? over.checkpointDir : fs.mkdtempSync(path.join(os.tmpdir(), 'a10lckpt-')),
    operationDir: (over && over.operationDir !== undefined) ? over.operationDir : fs.mkdtempSync(path.join(os.tmpdir(), 'a10lop-')),
    flushFn: (over && over.flushFn !== undefined) ? over.flushFn : (async (s) => (await fx.proc.store.flush(s)) === true),
    serialization: (over && Object.prototype.hasOwnProperty.call(over, 'serialization')) ? over.serialization : makeFakeLockClient(),
  };
  if (over) {
    for (const k of Object.keys(over)) {
      if (k === 'checkpointDir' || k === 'operationDir' || k === 'flushFn' || k === 'serialization') continue;
      input[k] = over[k];
    }
  }
  return input;
}

async function main() {
  section('live: single-segment apply equals the shadow prediction');
  {
    const fx = await buildLiveShadowReady('sess-a10live-single', false);
    check(!fx.blocked, 'live single-segment fixture reaches shadow-ready' + (fx.blocked ? ' (blocked: ' + fx.blocked + ')' : ''));
    check(fx.artifact.segments.length === 1, 'live single-segment composition (got ' + fx.artifact.segments.length + ')');
    const rawPrefix = JSON.stringify(Array.from(fx.session.events));
    const rawCount = fx.session.events.length;
    const input = applyInputForLive(fx);
    const res = await active.applyActiveCompactionV2(input);
    check(res.status === 'committed', 'live single-segment commits (got ' + res.status + ' ' + JSON.stringify(res.blockers).slice(0, 300) + ')');
    check(res.mutated === true && res.durable === true, 'live commit reports mutated + durable');
    check(res.intentDurable === true && res.applicationDurable === true, 'live commit proves both durability legs');
    check(active.validateActiveResultV2(res).valid === true, 'live result validates closed-world');
    check(canon(fx.session.deriveMessages()) === canon(fx.artifact.projectedMessages), 'live actual deriveMessages() equals A09 projectedMessages');
    const texts = JSON.stringify(fx.session.deriveMessages());
    check(texts.split('LIVE-A10-CURRENT').length - 1 === 1, 'live current user exactly once');
    check(shadow.checkMessagesBalanced(fx.session.deriveMessages()) === true, 'live protocol balanced');
    check(texts.split('LIVE-A10-BIG').length - 1 === 0, 'live compacted prefix leaves the model-facing view');
    check(JSON.stringify(Array.from(fx.session.events).slice(0, rawCount)) === rawPrefix, 'live raw log prefix is historically present (append-only)');
    check(fx.session.events.length === rawCount + 1, 'live log grew by exactly one replacement node');
    check(fx.proc.durable.writes >= 1, 'live SessionStore.flush participated (durability barrier)');
    // Idempotent live retry: no new nodes, same projection.
    const eventsAfter = JSON.stringify(Array.from(fx.session.events));
    const retry = await active.applyActiveCompactionV2(applyInputForLive(fx, { checkpointDir: input.checkpointDir, operationDir: input.operationDir }));
    check(retry.status === 'recovered', 'live retry recovers (got ' + retry.status + ')');
    check(JSON.stringify(Array.from(fx.session.events)) === eventsAfter, 'live retry appends nothing');
    check(canon(fx.session.deriveMessages()) === canon(fx.artifact.projectedMessages), 'live retry projection is identical');
  }

  section('live: multi-segment apply (pinned runtime split)');
  {
    const fx = await buildLiveShadowReady('sess-a10live-multi', true);
    check(!fx.blocked, 'live multi-segment fixture reaches shadow-ready' + (fx.blocked ? ' (blocked: ' + fx.blocked + ')' : ''));
    if (!fx.blocked) {
      check(fx.artifact.segments.length === 2, 'live composition splits into two segments (got ' + fx.artifact.segments.length + ')');
      check(fx.artifact.segments[0].role === 'payload' && fx.artifact.segments[1].role === 'continuation', 'one payload plus continuation anchors');
      const rawPrefix = JSON.stringify(Array.from(fx.session.events));
      const rawCount = fx.session.events.length;
      const input = applyInputForLive(fx);
      const res = await active.applyActiveCompactionV2(input);
      check(res.status === 'committed', 'live multi-segment commits (got ' + res.status + ' ' + JSON.stringify(res.blockers).slice(0, 300) + ')');
      check(canon(fx.session.deriveMessages()) === canon(fx.artifact.projectedMessages), 'live multi actual equals multi prediction');
      const texts = JSON.stringify(fx.session.deriveMessages());
      check(texts.split('nexus-context-continuation').length - 1 === 1, 'live multi carries one continuation anchor');
      check(texts.split('LIVE-A10-CURRENT').length - 1 === 1, 'live multi current user exactly once');
      check(JSON.stringify(Array.from(fx.session.events).slice(0, rawCount)) === rawPrefix, 'live multi raw prefix append-only');
      check(fx.session.events.length === rawCount + 2, 'live multi log grew by exactly one node per segment');
    }
  }

  section('live: ambiguous flush failure recovers on retry');
  {
    const fx = await buildLiveShadowReady('sess-a10live-rec', false);
    check(!fx.blocked, 'live recovery fixture reaches shadow-ready');
    if (!fx.blocked) {
      let flushOk = false;
      const ckptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10lckpt-'));
      const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10lop-'));
      const bad = await active.applyActiveCompactionV2(applyInputForLive(fx, { checkpointDir: ckptDir, operationDir: opDir, flushFn: async () => flushOk }));
      check(bad.status === 'failed' && bad.mutated === true, 'live ambiguous failure stays recoverable (never harmless)');
      check(bad.intentDurable === true && bad.applicationDurable === false && bad.durable === false, 'H3: live flush failure proves intent only');
      check((bad.blockers[0] && bad.blockers[0].code) === 'active-flush-failed', 'live ambiguous failure names the flush cause');
      flushOk = true;
      const again = await active.applyActiveCompactionV2(applyInputForLive(fx, { checkpointDir: ckptDir, operationDir: opDir, flushFn: async (s) => (await fx.proc.store.flush(s)) === true }));
      check(again.status === 'recovered', 'live retry after ambiguous failure recovers (got ' + again.status + ')');
      check(canon(fx.session.deriveMessages()) === canon(fx.artifact.projectedMessages), 'live recovered projection equals the prediction');
    }
  }

  section('live: restart after commit reproduces the prediction (§45)');
  {
    const fx = await buildLiveShadowReady('sess-a10live-restart', false);
    check(!fx.blocked, 'live restart fixture reaches shadow-ready');
    if (!fx.blocked) {
      const ckptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10lckpt-'));
      const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10lop-'));
      const committed = await active.applyActiveCompactionV2(applyInputForLive(fx, { checkpointDir: ckptDir, operationDir: opDir }));
      check(committed.status === 'committed', 'live pre-restart apply commits');
      check(fx.proc.durable.writes >= 2, 'post-apply flush made the replacement durable');
      // Destroy the in-memory session; restore purely from durable bytes in
      // a brand-new host process. The host appends one off-surface
      // session/end-seed marker on seed restore: the log grows by host
      // metadata while the model-facing projection must stay identical.
      const postApplyBytes = fx.proc.durable.bytes;
      const revived = restartFromDurable({ bytes: postApplyBytes, header: fx.proc.durable.header }, fx.session.id);
      check(revived.session.events.length === fx.session.events.length + 1, 'restore adds exactly the host end-seed marker');
      check(JSON.stringify(revived.session.surface.nodes) === JSON.stringify(Array.from(fx.session.surface.nodes)), 'restore keeps the compacted surface');
      check(canon(revived.session.deriveMessages()) === canon(fx.artifact.projectedMessages), 'restored live projection equals the A09 prediction');
      const texts = JSON.stringify(revived.session.deriveMessages());
      check(texts.split('LIVE-A10-CURRENT').length - 1 === 1, 'restored current user exactly once');
      check(shadow.checkMessagesBalanced(revived.session.deriveMessages()) === true, 'restored protocol balanced');
      const stored = compaction.readCompactionOperationV2(opDir);
      check(stored !== null && stored.operationId === fx.artifact.operationId, 'restored operation binding is valid');
      // A10 retry on the restored session recognizes the completed
      // operation through durable reconciliation (no rebuild needed, no
      // new mutation) and converges to recovered.
      const retryInput = {
        schemaVersion: 1,
        taskId: fx.ts.taskId, taskInstanceId: fx.ts.taskInstanceId, sessionId: revived.session.id, generation: fx.ts.generation,
        shadowResult: fx.result, sealedCheckpoint: fx.sealed, projectionArtifact: fx.artifact,
        snapshotToken: fx.token, snapshotCurrentState: liveSnapshotInput(fx.ts),
        safePointDecision: fx.safeDecision, checkpointabilityDecision: fx.gateDecision, pressureDecision: fx.pressureDecision,
        retentionPlan: fx.plan, taskState: fx.ts, contextUnits: fx.units, protocolSpans: fx.spans,
        session: revived.session,
        checkpointDir: ckptDir, operationDir: opDir,
        flushFn: async (s) => (await revived.proc.store.flush(s)) === true,
        serialization: makeFakeLockClient(),
      };
      const retry = await active.applyActiveCompactionV2(retryInput);
      check(retry.status === 'recovered', 'live post-restart retry recovers (got ' + retry.status + ' ' + JSON.stringify(retry.blockers).slice(0, 200) + ')');
      check(retry.intentDurable === true && retry.applicationDurable === true, 'live post-restart recovery proves both legs');
      check(retry.mutated === false, 'live post-restart retry appends nothing');
      check(canon(revived.session.deriveMessages()) === canon(fx.artifact.projectedMessages), 'post-retry restored projection is still the prediction');
    }
  }

  section('live H2 Case A: durable intent plus no landing forward-recovers');
  {
    const fx = await buildLiveShadowReady('sess-a10live-lost', false);
    check(!fx.blocked, 'live lost-apply fixture reaches shadow-ready');
    if (!fx.blocked) {
      const ckptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10lckpt-'));
      const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10lop-'));
      // Freeze intent without durable application: the flush barrier never
      // runs, so the pre-apply flush stays the last durable state while the
      // operation file is durably frozen.
      let flushOk = false;
      const bad = await active.applyActiveCompactionV2(applyInputForLive(fx, { checkpointDir: ckptDir, operationDir: opDir, flushFn: async () => flushOk }));
      check(bad.status === 'failed' && bad.intentDurable === true && bad.applicationDurable === false, 'setup freezes intent without durable application');
      check(fx.proc.durable.bytes !== null && JSON.parse(fx.proc.durable.bytes).length === fx.session.events.length - 1, 'durable bytes are pre-apply (landing never flushed)');
      flushOk = true;
      // Restart: brand-new host process from pre-apply bytes. The host adds
      // its off-surface session/end-seed marker; logical state is unchanged.
      const revived = restartFromDurable({ bytes: fx.proc.durable.bytes, header: fx.proc.durable.header }, fx.session.id);
      const retryInput = {
        schemaVersion: 1,
        taskId: fx.ts.taskId, taskInstanceId: fx.ts.taskInstanceId, sessionId: revived.session.id, generation: fx.ts.generation,
        shadowResult: fx.result, sealedCheckpoint: fx.sealed, projectionArtifact: fx.artifact,
        snapshotToken: fx.token, snapshotCurrentState: liveSnapshotInput(fx.ts),
        safePointDecision: fx.safeDecision, checkpointabilityDecision: fx.gateDecision, pressureDecision: fx.pressureDecision,
        retentionPlan: fx.plan, taskState: fx.ts, contextUnits: fx.units, protocolSpans: fx.spans,
        session: revived.session,
        checkpointDir: ckptDir, operationDir: opDir,
        flushFn: async (s) => (await revived.proc.store.flush(s)) === true,
        serialization: makeFakeLockClient(),
      };
      const retry = await active.applyActiveCompactionV2(retryInput);
      check(retry.status === 'committed', 'marker-only restart applies the existing operation (got ' + retry.status + ' ' + JSON.stringify(retry.blockers).slice(0, 200) + ')');
      check(retry.intentDurable === true && retry.applicationDurable === true, 'H2 recovery proves both legs');
      check(canon(revived.session.deriveMessages()) === canon(fx.artifact.projectedMessages), 'live H2 actual equals the original prediction');
      const texts = JSON.stringify(revived.session.deriveMessages());
      check(texts.split('LIVE-A10-CURRENT').length - 1 === 1, 'live H2 current user exactly once');
      check(shadow.checkMessagesBalanced(revived.session.deriveMessages()) === true, 'live H2 protocol balanced');
      const stored = compaction.readCompactionOperationV2(opDir);
      check(stored !== null && stored.operationId === fx.artifact.operationId, 'live H2 reuses the pre-crash durable operation');
    }
  }

  section('live H2 Case B: real change after intent fails closed');
  {
    const fx = await buildLiveShadowReady('sess-a10live-changed', false);
    check(!fx.blocked, 'live changed-state fixture reaches shadow-ready');
    if (!fx.blocked) {
      const ckptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10lckpt-'));
      const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10lop-'));
      let flushOk = false;
      const bad = await active.applyActiveCompactionV2(applyInputForLive(fx, { checkpointDir: ckptDir, operationDir: opDir, flushFn: async () => flushOk }));
      check(bad.status === 'failed' && bad.intentDurable === true, 'Case B setup freezes intent');
      flushOk = true;
      const revived = restartFromDurable({ bytes: fx.proc.durable.bytes, header: fx.proc.durable.header }, fx.session.id);
      revived.session.append('user/message', userMessage('LIVE-A10-LATE-WORK'), { surfaceOp: 'append' });
      await revived.proc.store.flush(revived.session);
      const retryInput = {
        schemaVersion: 1,
        taskId: fx.ts.taskId, taskInstanceId: fx.ts.taskInstanceId, sessionId: revived.session.id, generation: fx.ts.generation,
        shadowResult: fx.result, sealedCheckpoint: fx.sealed, projectionArtifact: fx.artifact,
        snapshotToken: fx.token, snapshotCurrentState: liveSnapshotInput(fx.ts),
        safePointDecision: fx.safeDecision, checkpointabilityDecision: fx.gateDecision, pressureDecision: fx.pressureDecision,
        retentionPlan: fx.plan, taskState: fx.ts, contextUnits: fx.units, protocolSpans: fx.spans,
        session: revived.session,
        checkpointDir: ckptDir, operationDir: opDir,
        flushFn: async (s) => (await revived.proc.store.flush(s)) === true,
        serialization: makeFakeLockClient(),
      };
      const before = JSON.stringify(revived.session.events);
      const retry = await active.applyActiveCompactionV2(retryInput);
      check(retry.status === 'stale', 'real semantic change after intent fails closed (got ' + retry.status + ')');
      check(retry.mutated === false && JSON.stringify(revived.session.events) === before, 'Case B mutates and appends nothing');
    }
  }

  console.log('\nA10 live-host: passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('A10 LIVE HARNESS FAIL:', e && e.stack ? e.stack : e); process.exit(1); });
