'use strict';
/**
 * ContextGenerationRuntimeV2LiveHost.Tests.cjs - CCV2-A11 real-host proof.
 *
 * Proves the multi-generation runtime against the REAL pinned DSH host
 * (@deepseek-ai/dsh-session 0.1.1-rc.2: real SessionStore, real append-only
 * log, real store.flush durability barrier, real deriveMessages(), real
 * Session restore). Nothing about the host is simulated: every generation
 * reserves through the A11 authority, shadows through the real A09, applies
 * through the real A10 transaction, and commits through the A11 head.
 *
 * Proves: G1 -> G2 -> G3 real active compaction (each actual equals its A09
 * prediction), superseded-G2 -> G3 skipped lineage (G3.parent == G1), latest-
 * only surface, current-user-once, protocol balance, self-contained
 * checkpoints, restart reconstruction after every generation, and that old
 * superseded intent never lands. A05H strict gate applies: host absent +
 * strict env = FAIL (never faked).
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
const pressure = require(path.join(repoRoot, 'config', 'ContextPressureV2.cjs'));
const retention = require(path.join(repoRoot, 'config', 'ContextRetentionV2.cjs'));
const snapshotV2 = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const safepoint = require(path.join(repoRoot, 'config', 'ContextSafePointV2.cjs'));
const gate = require(path.join(repoRoot, 'config', 'ContextCheckpointabilityV2.cjs'));
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
function messageTexts(messages) {
  const texts = [];
  const walk = (value) => {
    if (typeof value === 'string') { texts.push(value); return; }
    if (Array.isArray(value)) { for (const entry of value) walk(entry); return; }
    if (value !== null && typeof value === 'object') {
      if (typeof value.text === 'string' && value.type === 'text') texts.push(value.text);
      else { for (const key of Object.keys(value)) { if (key !== 'id') walk(value[key]); } }
    }
  };
  for (const message of messages || []) walk(message);
  return texts;
}

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
  liveGate.reportLiveHostGate('A11', liveGate.decideLiveHostGate(false, process.env));
  console.log('SKIP: pinned DSH host tree is absent; the A11 live-host proof is PENDING (never faked).');
  process.exit(0);
}
liveGate.reportLiveHostGate('A11', 'EXECUTED');

const TASK_ID = 'TASK-A11-LIVE';
const TASK_INSTANCE = 'task_a11live_0001';

let messageCounter = 0;
function newMessageId() { messageCounter += 1; return 'msg-a11live-' + messageCounter; }
function modelSource() { return { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' }; }
function userMessage(text, source) { return { id: newMessageId(), role: 'user', content: [{ type: 'text', text }], source: source || { kind: 'user' } }; }
function assistantText(text, turn, step) { const source = modelSource(); return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'text', text }], source }, source }; }
function assistantToolCall(callId, turn, step) { const source = modelSource(); return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'tool-call', name: 'run_command', callId }], source }, source }; }
function toolResult(callId, text, turn, step) { return { turn, step, message: { id: newMessageId(), role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } }; }

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
async function flushBarrier(proc, session) { const p = await proc.store.flush(session); return p === true; }
function restartFromDurable(durable, sessionId) {
  assert.ok(typeof durable.bytes === 'string' && durable.bytes !== '', 'durable bytes exist before restart');
  const proc = createHostProcess();
  const seed = JSON.parse(durable.bytes);
  const session = proc.store.create(sessionId, { seedSource: 'persistence', seed, meta: durable.header });
  return { proc, session };
}
function makeEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a11live-'));
  return { base, runtimeDir: path.join(base, 'runtime'), checkpointDir: path.join(base, 'checkpoints'), operationRoot: path.join(base, 'operations'), lockWorkspace: path.join(base, 'ledger') };
}
function makeFakeLockClient() {
  const state = { held: false, ownerId: null };
  let ownerCounter = 0;
  async function acquire() {
    if (state.held) return { acquired: false, ownerId: null, leaseSeconds: 60, reason: 'held-by-live-owner' };
    ownerCounter += 1;
    state.held = true;
    state.ownerId = 'fake-a11live-owner-' + ownerCounter;
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
  const ts = { schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId, workspaceId: WORKSPACE, repositoryId: null, checkoutId: null, generation, safePointBoundarySeq: boundarySeq, sessionRevision, taskRevision: 'pending', repositoryRevision: { headCommit: 'live-head', indexDigest: null, worktreeDigest: null }, runtimeRevision: { runtimeSnapshotSeq: null }, objective: { text: 'Prove A11 multi-generation runtime on the live host.', status: 'in-progress' }, requirements: [{ id: 'R-live', text: 'Advance the live generation chain (' + tag + ').', status: 'active', evidenceRefs: [], sourceKind: 'controller' }], constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.', sourceKind: 'controller' }], progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'A11 live ' + tag, remainingMilestones: [] }, decisions: [{ id: 'D-live', statement: 'The live generation path is explicit.', authority: 'controller-established', status: 'active', evidenceRefs: [], sourceKind: 'controller' }], repository: { repositoryId: null, checkoutId: null, headCommit: 'live-head', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null }, evidenceRefs: [], failures: { activeFailures: [], rejectedHypotheses: [], retryState: null }, verification: { outcomes: [{ scope: 'unit', status: 'PENDING', detail: null, evidenceRefs: [] }], note: null }, continuation: { nextAction: 'Continue live generation work (' + tag + ').', unresolvedQuestions: [], recentUserIntent: 'Prove A11 live ' + tag + '.' }, provenance: {}, ephemeralState: [], unsupportedState: [], reconstructionRefs: [] };
  ts.taskRevision = snapshotV2.deriveTaskRevision(ts);
  ts.provenance = { 'objective.text': { sourceKind: 'controller', fieldKind: 'task-objective', sourceRefs: ['controller:objective'], authorityScope: null }, 'requirements.0.text': { sourceKind: 'controller', fieldKind: 'requirement-text', sourceRefs: ['user:req-R-live'], authorityScope: null }, 'requirements.0.status': { sourceKind: 'controller', fieldKind: 'requirement-status', sourceRefs: ['user:req-R-live'], authorityScope: null }, 'constraints.0.text': { sourceKind: 'controller', fieldKind: 'constraint-text', sourceRefs: ['user:constraint-0'], authorityScope: null }, 'decisions.0.statement': { sourceKind: 'controller', fieldKind: 'decision-statement', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'decisions.0.authority': { sourceKind: 'controller', fieldKind: 'decision-authority', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'decisions.0.status': { sourceKind: 'controller', fieldKind: 'decision-status', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'verification.outcomes.0.status': { sourceKind: 'verification', fieldKind: 'verification-outcome', sourceRefs: ['verification:unit'], authorityScope: null }, 'continuation.nextAction': { sourceKind: 'controller', fieldKind: 'next-action', sourceRefs: ['controller:continuation'], authorityScope: null }, 'continuation.recentUserIntent': { sourceKind: 'controller', fieldKind: 'user-intent', sourceRefs: ['user:intent-event'], authorityScope: null }, repository: { sourceKind: 'repository', fieldKind: 'repository-fact', sourceRefs: ['repository:HEAD'], authorityScope: null } };
  return ts;
}
function liveSnapshotInput(ts) {
  return { taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, workspaceId: ts.workspaceId, repositoryId: ts.repositoryId, checkoutId: ts.checkoutId, generation: ts.generation, safePointBoundarySeq: ts.safePointBoundarySeq, sessionRevision: ts.sessionRevision, taskRevision: ts.taskRevision, repositoryRevision: clone(ts.repositoryRevision), runtimeRevision: null };
}
function liveSafeInput(session, tracker, taskRevision) {
  return { schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: session.id, sessionEvents: Array.from(session.events), sessionDurable: { flushedSeq: tracker.flushedSeq === undefined ? null : tracker.flushedSeq, flushParticipated: tracker.flushParticipated === undefined ? false : tracker.flushParticipated }, controller: { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision }, runtime: { currentSnapshotSeq: null, transitionOpen: false } };
}
function liveBoundaryContext(session, tracker, taskRevision) {
  return { sessionEvents: Array.from(session.events), sessionDurable: { flushedSeq: tracker.flushedSeq === undefined ? null : tracker.flushedSeq, flushParticipated: tracker.flushParticipated === undefined ? false : tracker.flushParticipated }, controller: { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision }, runtime: { currentSnapshotSeq: null, transitionOpen: false } };
}
function unitCost(sliceEvents) {
  const bytes = pressure.byteLengthUtf8(pressure.serializeCanonical(sliceEvents));
  return { tokens: pressure.estimateTokensForUtf8Bytes(bytes), method: 'conservative-estimate', exact: false };
}
const BIG = 'LIVE-A11-BIG-0123456789;'.repeat(17200);

function appendLiveWork(session, tag, callSeq) {
  session.append('user/message', userMessage('LIVE-A11-TOOL-REQUEST-' + tag), { surfaceOp: 'append' });
  session.append('assistant/message', assistantToolCall('live-a11-call-' + callSeq, 't' + callSeq, 's' + callSeq), { surfaceOp: 'append' });
  session.append('tool/call', { callId: 'live-a11-call-' + callSeq, turn: 't' + callSeq, step: 's' + callSeq });
  session.append('tool/result', toolResult('live-a11-call-' + callSeq, BIG, 't' + callSeq, 's' + callSeq), { surfaceOp: 'append' });
  session.append('assistant/message', assistantText('LIVE-A11-POST-TOOL-' + tag, 't' + callSeq, 's' + callSeq), { surfaceOp: 'append' });
  session.append('user/message', userMessage('LIVE-A11-CURRENT-' + tag), { surfaceOp: 'append' });
}

// Builds ONE live generation fixture on the CURRENT host session (chained):
// appends normal new work, flushes, then runs the real A05/A06/A07/A08/A09
// chain for generation G with the given parent lineage.
async function buildLiveGeneration(proc, tracker, session, sid, generation, parentCheckpointId, tag, callSeq) {
  appendLiveWork(session, tag, callSeq);
  tracker.flushParticipated = await flushBarrier(proc, session);
  tracker.flushedSeq = session.events.length - 1;
  const ts = liveTaskState(sid, generation, session.events.length - 1, tracker.flushedSeq, tag);
  const safeDecision = safepoint.detectSafePointV2(liveSafeInput(session, tracker, ts.taskRevision));
  if (safeDecision.safe !== true) return { blocked: 'safe-point' };
  const token = snapshotV2.capture(liveSnapshotInput(ts), CREATED);
  const gateDecision = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safeDecision, snapshotToken: token });
  if (gateDecision.checkpointable !== true) return { blocked: 'gate' };
  const cap = pressure.resolveProviderCapacity('deepseek-v4-flash');
  const cost = pressure.estimateTokensForEvents(Array.from(session.events));
  const pressureDecision = pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: cap.capacityTokens, currentContextTokens: cost.tokens, costMethod: cost.method, costExact: cost.exact, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: token.taskId, taskInstanceId: token.taskInstanceId, sessionId: token.sessionId, generation: token.generation, snapshotTokenId: token.snapshotTokenId, revisionDigest: token.revisionDigest });
  const liveEvents = Array.from(session.events);
  const surfaceSeqs = Array.from(session.surface.nodes);
  const toolCallSeq = liveEvents.filter((e) => e.type === 'assistant/message' && JSON.stringify(e).indexOf('live-a11-call-' + callSeq) !== -1).map((e) => e.seq);
  const toolResultSeq = liveEvents.filter((e) => e.type === 'tool/result' && JSON.stringify(e).indexOf('live-a11-call-' + callSeq) !== -1).map((e) => e.seq);
  if (toolCallSeq.length === 0 || toolResultSeq.length === 0) return { blocked: 'tool-span-missing' };
  const firstSeq = session.events.length - 6;
  const lastPre = toolResultSeq[0];
  const units = [];
  if (firstSeq > 0) {
    units.push({ unitId: 'live-old', eventSeqStart: 0, eventSeqEnd: firstSeq - 1, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(0, firstSeq)) });
  }
  units.push({ unitId: 'live-hist', eventSeqStart: firstSeq, eventSeqEnd: lastPre - 2, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(firstSeq, lastPre - 1)) });
  units.push({ unitId: 'live-tool', eventSeqStart: lastPre - 1, eventSeqEnd: lastPre, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(lastPre - 1, lastPre + 1)) });
  units.push({ unitId: 'live-post', eventSeqStart: lastPre + 1, eventSeqEnd: lastPre + 1, requiresContinuation: true, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(lastPre + 1, lastPre + 2)) });
  units.push({ unitId: 'live-user', eventSeqStart: lastPre + 2, eventSeqEnd: lastPre + 2, requiresContinuation: true, a07Coverage: null, derivedNonAuthoritative: false, isCurrentUserTurn: true, tokenCost: unitCost(liveEvents.slice(lastPre + 2)) });
  const spans = [{ startSeq: toolCallSeq[0], endSeq: toolResultSeq[0] }];
  const plan = retention.planRetentionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, safePointDecision: safeDecision, checkpointabilityDecision: gateDecision, pressureDecision, boundaryContext: liveBoundaryContext(session, tracker, ts.taskRevision), contextUnits: units, protocolSpans: spans });
  if (plan.actionable !== true) return { blocked: 'retention:' + JSON.stringify(plan.blockers).slice(0, 200) };
  const input = { schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: session.id, generation: ts.generation, parentCheckpointId, snapshotToken: token, snapshotCurrentState: liveSnapshotInput(ts), safePointDecision: safeDecision, checkpointabilityDecision: gateDecision, pressureDecision, retentionPlan: plan, taskState: ts, contextUnits: units, sessionEvents: Array.from(session.events), surfaceNodes: Array.from(session.surface.nodes), protocolSpans: spans, createdAtUtc: CREATED, sealedAtUtc: CREATED };
  const result = shadow.evaluateShadowCompactionV2(input);
  if (result.verdict !== 'shadow-ready') return { blocked: 'shadow:' + JSON.stringify(result.blockers).slice(0, 300) };
  const liveSealed = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: session.id, generation: ts.generation, parentCheckpointId, safePointBoundarySeq: safeDecision.boundarySeq, snapshotToken: token, taskState: ts, createdAtUtc: CREATED, sealedAtUtc: CREATED });
  const artifact = shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: session.id, generation: ts.generation, sealedCheckpoint: liveSealed.sealedCheckpoint, retentionPlan: plan, snapshotToken: token, taskState: ts, contextUnits: units, sourceEvents: Array.from(session.events), surfaceNodes: Array.from(session.surface.nodes), protocolSpans: spans });
  return { proc, tracker, session, ts, token, safeDecision, gateDecision, pressureDecision, plan, units, spans, result, sealed: liveSealed.sealedCheckpoint, artifact };
}

function liveApplyInput(fx, dirs, lock, generation) {
  return {
    schemaVersion: 1,
    taskId: fx.ts.taskId, taskInstanceId: fx.ts.taskInstanceId, sessionId: fx.session.id, generation,
    shadowResult: fx.result, sealedCheckpoint: fx.sealed, projectionArtifact: fx.artifact,
    snapshotToken: fx.token, snapshotCurrentState: liveSnapshotInput(fx.ts),
    safePointDecision: fx.safeDecision, checkpointabilityDecision: fx.gateDecision, pressureDecision: fx.pressureDecision,
    retentionPlan: fx.plan, taskState: fx.ts, contextUnits: fx.units, protocolSpans: fx.spans,
    session: fx.session,
    checkpointDir: dirs.checkpointDir,
    operationDir: runtime.operationDirForGenerationV2(dirs.operationRoot, generation),
    flushFn: async (s) => (await fx.proc.store.flush(s)) === true,
    serialization: lock,
  };
}

function liveBind(env, lock, sid) {
  return {
    schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid,
    runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
    serialization: lock, lockWorkspace: env.lockWorkspace,
  };
}

function payloadTextOf(sealed) { return shadow.checkpointPayloadTextOf(sealed); }

async function main() {
  {
    const src = fs.readFileSync(host.sessionPath, 'utf8');
    check(host.version === '0.1.1-rc.2', 'pinned DSH host is 0.1.1-rc.2 (got ' + host.version + ')');
    check(src.indexOf('async flush(session)') !== -1, 'pinned host still states the flush barrier contract');
  }

  section('live: G1 -> G2 -> G3 real active compaction with restart after every generation');
  {
    const env = makeEnv();
    const lock = makeFakeLockClient();
    const sid = 'sess-a11live-chain';
    const b = liveBind(env, lock, sid);
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
    // Prime the log with opening context so G1 has compactable history.
    session.append('user/message', userMessage('LIVE-A11-FIRST-REQUEST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-A11-FIRST-REPLY', 't0', 's0'), { surfaceOp: 'append' });
    const payloads = [];
    let parentId = null;
    for (let gen = 1; gen <= 3; gen += 1) {
      const tag = 'G' + gen;
      const fx = await buildLiveGeneration(proc, tracker, session, sid, gen, parentId, tag, gen);
      check(!fx.blocked, 'live ' + tag + ' reaches shadow-ready' + (fx.blocked ? ' (blocked: ' + fx.blocked + ')' : ''));
      if (fx.blocked) break;
      check(fx.gateDecision.checkpointable === true, 'live ' + tag + ' checkpoint is self-contained under A07');
      const res = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
        revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId,
        safePointBoundarySeq: fx.safeDecision.boundarySeq,
      }));
      check(res.generation === gen, 'live reserves ' + tag + ' (got G' + res.generation + ')');
      if (gen === 1) check(res.parentCommittedCheckpointId === null, 'live G1 parent is null');
      else check(res.parentCommittedCheckpointId === parentId, 'live ' + tag + ' parent is the latest committed checkpoint');
      const applied = await active.applyActiveCompactionV2(liveApplyInput(fx, env, lock, gen));
      check(applied.status === 'committed', 'live ' + tag + ' actually applies (got ' + applied.status + ' ' + JSON.stringify(applied.blockers).slice(0, 300) + ')');
      check(applied.applicationDurable === true, 'live ' + tag + ' proves application durability');
      check(canon(session.deriveMessages()) === canon(fx.artifact.projectedMessages), 'live ' + tag + ' actual == its A09 prediction');
      const committed = await runtime.commitGenerationV2(Object.assign({}, b, {
        generation: gen, activeResult: applied, postApplyVerified: true, session,
      }));
      check(committed.latestCommittedGeneration === gen, 'live head advances to ' + tag);
      parentId = applied.checkpointId;
      payloads.push(payloadTextOf(fx.sealed));
      // Restart after EVERY generation: destroy/recreate from persistence,
      // then reconstruction must return the exact same runtime and messages.
      const bytes = proc.durable.bytes;
      assert.ok(typeof bytes === 'string' && bytes !== '', 'durable bytes exist after ' + tag);
      const revived = restartFromDurable({ bytes, header: proc.durable.header }, sid);
      const state = runtime.reconstructGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: revived.session, repairHead: true });
      check(state.latestCommittedGeneration === gen, 'restart after ' + tag + ' reconstructs the committed head');
      check(state.highestAllocatedGeneration === gen, 'restart after ' + tag + ' reconstructs allocation');
      check(canon(revived.session.deriveMessages()) === canon(fx.artifact.projectedMessages), 'restart after ' + tag + ' reproduces the exact messages');
    }
    const texts = messageTexts(session.deriveMessages()).join('\n');
    check(texts.split('LIVE-A11-CURRENT-G3').length - 1 === 1, 'live current user exactly once after G3');
    check(shadow.checkMessagesBalanced(session.deriveMessages()) === true, 'live protocol balanced after G3');
    check(texts.split(payloads[2]).length - 1 === 1, 'live latest payload active exactly once');
    check(payloads[0] && texts.indexOf(payloads[0]) === -1, 'live G1 payload superseded on the active surface');
    check(payloads[1] && texts.indexOf(payloads[1]) === -1, 'live G2 payload superseded on the active surface');
  }

  section('live: superseded G2 -> G3 skipped lineage, old intent never lands');
  {
    const env = makeEnv();
    const lock = makeFakeLockClient();
    const sid = 'sess-a11live-sup';
    const b = liveBind(env, lock, sid);
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-A11-SUP-FIRST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-A11-SUP-REPLY', 't0', 's0'), { surfaceOp: 'append' });
    const fx1 = await buildLiveGeneration(proc, tracker, session, sid, 1, null, 'SUP-G1', 11);
    check(!fx1.blocked, 'live supersede-chain G1 reaches shadow-ready' + (fx1.blocked ? ' (blocked: ' + fx1.blocked + ')' : ''));
    if (!fx1.blocked) {
      await runtime.reserveNextGenerationV2(Object.assign({}, b, {
        revisionDigest: fx1.token.revisionDigest, snapshotTokenId: fx1.token.snapshotTokenId,
        safePointBoundarySeq: fx1.safeDecision.boundarySeq,
      }));
      const res1 = await active.applyActiveCompactionV2(liveApplyInput(fx1, env, lock, 1));
      check(res1.status === 'committed', 'live supersede-chain G1 commits');
      await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res1, postApplyVerified: true, session }));
      // G2 reserves, then durable intent with zero landing.
      const fx2 = await buildLiveGeneration(proc, tracker, session, sid, 2, res1.checkpointId, 'SUP-G2', 12);
      check(!fx2.blocked, 'live G2 reaches shadow-ready' + (fx2.blocked ? ' (blocked: ' + fx2.blocked + ')' : ''));
      if (!fx2.blocked) {
        await runtime.reserveNextGenerationV2(Object.assign({}, b, {
          revisionDigest: fx2.token.revisionDigest, snapshotTokenId: fx2.token.snapshotTokenId,
          safePointBoundarySeq: fx2.safeDecision.boundarySeq,
        }));
        const sealedSerialized = checkpointV2.serializeCheckpointCanonical(fx2.sealed);
        trustV2.persistSealedCheckpointV2(env.checkpointDir, { checkpoint: clone(fx2.sealed), serialized: sealedSerialized });
        const unioned = [];
        for (const seg of fx2.artifact.segments) for (const seq of seg.sourceEventSeqs) unioned.push(seq);
        unioned.sort((a, b2) => a - b2);
        const draft = {
          schemaVersion: 2, operationId: fx2.artifact.operationId,
          attemptId: 'att_' + require('node:crypto').createHash('sha256').update('nexus/context-active-apply-attempt/v1' + String.fromCharCode(10) + String(fx2.artifact.operationId), 'utf8').digest('hex').slice(0, 24),
          taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid,
          workspace: WORKSPACE, repositoryId: null, checkoutId: null,
          checkpointGeneration: 2, checkpointId: fx2.result.checkpoint.checkpointId,
          checkpointContentDigest: fx2.result.checkpoint.checkpointContentDigest, checkpointPath: null,
          snapshotTokenId: fx2.token.snapshotTokenId, safePointBoundarySeq: fx2.safeDecision.boundarySeq,
          sourceEventSeqs: unioned, segments: clone(fx2.artifact.segments), lifecycle: 'frozen',
        };
        const expected = { taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid, workspace: WORKSPACE, repositoryId: null, checkoutId: null, checkpointGeneration: 2, checkpointId: fx2.result.checkpoint.checkpointId };
        compaction.freezeCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 2), draft, expected);
        // A real user event arrives: source state moves before landing.
        session.append('user/message', userMessage('LIVE-A11-SUP-INTERRUPT'), { surfaceOp: 'append' });
        tracker.flushParticipated = await flushBarrier(proc, session);
        tracker.flushedSeq = session.events.length - 1;
        const movedTs = liveTaskState(sid, 2, session.events.length - 1, tracker.flushedSeq, 'SUP-G2-moved');
        const movedToken = snapshotV2.capture(liveSnapshotInput(movedTs), CREATED);
        check(movedToken.revisionDigest !== fx2.token.revisionDigest, 'live interrupt moves the revision (staleness is real)');
        await runtime.supersedeGenerationV2(Object.assign({}, b, {
          generation: 2, observedRevisionDigest: movedToken.revisionDigest,
          observedSafePointBoundarySeq: movedTs.safePointBoundarySeq,
          payloadText: payloadTextOf(fx2.sealed), session,
        }));
        const afterSup = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session });
        check(afterSup.generations.filter((g) => g.generation === 2)[0].outcome === 'SUPERSEDED', 'live G2 supersedes after the interrupt');
        // G3 allocates past G2 with the G1 parent and commits.
        const r3 = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
          revisionDigest: movedToken.revisionDigest, snapshotTokenId: movedToken.snapshotTokenId,
          safePointBoundarySeq: movedTs.safePointBoundarySeq,
        }));
        check(r3.generation === 3, 'live allocates G3 (G2 never reused)');
        check(r3.parentCommittedCheckpointId === res1.checkpointId, 'live G3 parent is the G1 checkpoint');
        const fx3 = await buildLiveGeneration(proc, tracker, session, sid, 3, res1.checkpointId, 'SUP-G3', 13);
        check(!fx3.blocked, 'live G3 reaches shadow-ready' + (fx3.blocked ? ' (blocked: ' + fx3.blocked + ')' : ''));
        if (!fx3.blocked) {
          const res3 = await active.applyActiveCompactionV2(liveApplyInput(fx3, env, lock, 3));
          check(res3.status === 'committed', 'live G3 commits (got ' + res3.status + ' ' + JSON.stringify(res3.blockers).slice(0, 300) + ')');
          const c3 = await runtime.commitGenerationV2(Object.assign({}, b, { generation: 3, activeResult: res3, postApplyVerified: true, session }));
          check(c3.latestCommittedGeneration === 3, 'live head is G3 with skipped lineage');
          const sealed3 = trustV2.readSealedCheckpointV2(env.checkpointDir, 3);
          check(sealed3.checkpoint.parentCheckpointId === res1.checkpointId, 'live G3.parentCheckpointId == G1.checkpointId');
          check(canon(session.deriveMessages()) === canon(fx3.artifact.projectedMessages), 'live G3 actual == its A09 prediction');
          check(runtime.generationCitationsOf(session, 2).length === 0, 'live old G2 intent never landed');
          const texts3 = messageTexts(session.deriveMessages()).join('\n');
          check(texts3.indexOf(payloadTextOf(fx2.sealed)) === -1, 'live abandoned G2 payload never surfaces');
        }
      }
    }
  }


  section('live: generation-aware entry applies; snapshot protection reconstructs');
  {
    const env = makeEnv();
    const lock = makeFakeLockClient();
    const sid = 'sess-a11live-entry';
    const b = liveBind(env, lock, sid);
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-A11-ENTRY-FIRST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-A11-ENTRY-REPLY', 't0', 's0'), { surfaceOp: 'append' });
    const fx = await buildLiveGeneration(proc, tracker, session, sid, 1, null, 'ENTRY-G1', 21);
    check(!fx.blocked, 'live entry G1 reaches shadow-ready' + (fx.blocked ? ' (blocked: ' + fx.blocked + ')' : ''));
    if (!fx.blocked) {
      await runtime.reserveNextGenerationV2(Object.assign({}, b, {
        revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId,
        safePointBoundarySeq: fx.safeDecision.boundarySeq,
      }));
      const request = liveApplyInput(fx, env, lock, 1);
      const out = await runtime.applyCurrentGenerationV2({
        schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid,
        runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir,
        operationRoot: env.operationRoot, lockWorkspace: env.lockWorkspace,
        request,
      });
      check(out.ok === true && out.activeResult.status === 'committed', 'live entry applies G1 (got ' + out.activeResult.status + ')');
      check(canon(session.deriveMessages()) === canon(fx.artifact.projectedMessages), 'live entry actual == its A09 prediction');
      await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: out.activeResult, postApplyVerified: true, session }));
      // Snapshot lifecycle on the live host: append a host runtime snapshot,
      // then protection must pin the current one and reconstruct identically
      // after a real restore.
      session.append('user/message', { id: newMessageId(), role: 'user', content: [{ type: 'text', text: 'Current runtime context. Snapshot generation B.' }], source: { kind: 'plugin', plugin: RUNTIME_PLUGIN, form: 'snapshot' } }, { surfaceOp: 'append' });
      tracker.flushParticipated = await flushBarrier(proc, session);
      const prot = runtime.snapshotProtectionOfV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session });
      check(runtime.validateSnapshotProtectionV2(prot).valid === true, 'live protection record validates');
      check(prot.currentRuntimeSeq !== null, 'live current runtime snapshot identified');
      check(prot.snapshots.filter((s) => s.seq === prot.currentRuntimeSeq)[0].protection === 'pinned', 'live current snapshot is PINNED');
      const revived = restartFromDurable({ bytes: proc.durable.bytes, header: proc.durable.header }, sid);
      const prot2 = runtime.snapshotProtectionOfV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: revived.session });
      check(prot2.protectionDigest === prot.protectionDigest, 'live protection reconstructs identically after restore');
      // Gated recovery refuses a superseded live generation: reserve G2,
      // freeze intent, move, supersede, then reconcile must refuse.
      const fx2 = await buildLiveGeneration(proc, tracker, session, sid, 2, out.activeResult.checkpointId, 'ENTRY-G2', 22);
      check(!fx2.blocked, 'live entry G2 reaches shadow-ready' + (fx2.blocked ? ' (blocked: ' + fx2.blocked + ')' : ''));
      if (!fx2.blocked) {
        await runtime.reserveNextGenerationV2(Object.assign({}, b, {
          revisionDigest: fx2.token.revisionDigest, snapshotTokenId: fx2.token.snapshotTokenId,
          safePointBoundarySeq: fx2.safeDecision.boundarySeq,
        }));
        const sealedSerialized = checkpointV2.serializeCheckpointCanonical(fx2.sealed);
        trustV2.persistSealedCheckpointV2(env.checkpointDir, { checkpoint: clone(fx2.sealed), serialized: sealedSerialized });
        session.append('user/message', userMessage('LIVE-A11-ENTRY-INTERRUPT'), { surfaceOp: 'append' });
        tracker.flushParticipated = await flushBarrier(proc, session);
        const movedTs = liveTaskState(sid, 2, session.events.length - 1, session.events.length - 1, 'ENTRY-G2-moved');
        const movedToken = snapshotV2.capture(liveSnapshotInput(movedTs), CREATED);
        await runtime.supersedeGenerationV2(Object.assign({}, b, {
          generation: 2, observedRevisionDigest: movedToken.revisionDigest,
          observedSafePointBoundarySeq: movedTs.safePointBoundarySeq,
          payloadText: payloadTextOf(fx2.sealed), session,
        }));
        let recCode = null;
        try {
          runtime.reconcileGenerationV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: sid, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, generation: 2, session });
        } catch (error) { recCode = String((error && error.message) || error); }
        check(recCode !== null && recCode.indexOf('permanently non-applicable') !== -1, 'live gated recovery refuses superseded G2 (got ' + String(recCode).slice(0, 120) + ')');
      }
    }
  }

  console.log('\nA11 live-host: passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error('A11 LIVE TEST HARNESS FAIL:', e && e.stack ? e.stack : e); process.exit(1); });
}
