'use strict';
/**
 * ContextShadowV2LiveHost.Tests.cjs - CCV2-A09 real-host proof.
 *
 * Proves shadow mode against the REAL pinned DSH host
 * (@deepseek-ai/dsh-session 0.1.1-rc.2: real SessionStore, real append-only
 * session log, real store.flush durability barrier, real deriveMessages()
 * projection). Nothing is simulated: every session event below enters a real
 * host log through session.append(), the A06 boundary is really detected,
 * the A05 token is really captured, A07 really decides, A08 really plans,
 * and A09 really evaluates the full shadow pipeline (real A03 checkpoint,
 * A07 post-build coverage, real A04 seal, hypothetical projection).
 * Evaluation stops before mutation: no session write, no projection write,
 * no checkpoint persistence, no CompactionOperationV2 occurs anywhere.
 * A05H strict gate applies: host absent + strict env = FAIL (never faked).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const shadow = require(path.join(repoRoot, 'config', 'ContextShadowV2.cjs'));
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
    } catch (e) { /* keep searching */ }
  }
  return null;
}
const host = resolveHost();
const liveGate = require(path.join(__dirname, 'Ccv2LiveHostGate.cjs'));
const liveHostFound = Boolean(host && host.session.Session && host.session.SessionStore && host.cordis.Context);
if (!liveHostFound) {
  liveGate.reportLiveHostGate('A09', liveGate.decideLiveHostGate(false, process.env));
  console.log('SKIP: pinned DSH host tree is absent; the A09 live-host proof is PENDING (never faked).');
  process.exit(0);
}
liveGate.reportLiveHostGate('A09', 'EXECUTED');
const SessionStore = host.session.SessionStore;
const Context = host.cordis.Context;
{
  const src = fs.readFileSync(host.sessionPath, 'utf8');
  check(host.version === '0.1.1-rc.2', 'pinned DSH host is 0.1.1-rc.2 (got ' + host.version + ')');
  check(src.indexOf('async flush(session)') !== -1, 'pinned host still states the flush barrier contract');
}
let messageCounter = 0;
function newMessageId() { messageCounter += 1; return 'msg-a09live-' + messageCounter; }
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
  return { schemaVersion: 1, taskId: 'TASK-A09-LIVE', taskInstanceId: 'task_a09live_0001', sessionId: session.id, sessionEvents: Array.from(session.events), sessionDurable: { flushedSeq: tracker.flushedSeq === undefined ? null : tracker.flushedSeq, flushParticipated: tracker.flushParticipated === undefined ? false : tracker.flushParticipated }, controller: { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision }, runtime: { currentSnapshotSeq: null, transitionOpen: false } };
}
function liveTaskState(sessionId, boundarySeq, sessionRevision) {
  const ts = { schemaVersion: 1, taskId: 'TASK-A09-LIVE', taskInstanceId: 'task_a09live_0001', sessionId, workspaceId: WORKSPACE, repositoryId: null, checkoutId: null, generation: 1, safePointBoundarySeq: boundarySeq, sessionRevision, taskRevision: 'pending', repositoryRevision: { headCommit: 'live-head', indexDigest: null, worktreeDigest: null }, runtimeRevision: { runtimeSnapshotSeq: null }, objective: { text: 'Prove A09 shadow mode on the live host.', status: 'in-progress' }, requirements: [{ id: 'R-live', text: 'Shadow observes the live pipeline without applying.', status: 'active', evidenceRefs: [], sourceKind: 'controller' }], constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.', sourceKind: 'controller' }], progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'A09 live', remainingMilestones: [] }, decisions: [{ id: 'D-live', statement: 'The live boundary authorizes shadow evaluation.', authority: 'controller-established', status: 'active', evidenceRefs: [], sourceKind: 'controller' }], repository: { repositoryId: null, checkoutId: null, headCommit: 'live-head', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null }, evidenceRefs: [], failures: { activeFailures: [], rejectedHypotheses: [], retryState: null }, verification: { outcomes: [{ scope: 'unit', status: 'PENDING', detail: null, evidenceRefs: [] }], note: null }, continuation: { nextAction: 'Continue live shadow work.', unresolvedQuestions: [], recentUserIntent: 'Prove A09 live.' }, provenance: {}, ephemeralState: [], unsupportedState: [], reconstructionRefs: [] };
  ts.taskRevision = snapshotV2.deriveTaskRevision(ts);
  ts.provenance = { 'objective.text': { sourceKind: 'controller', fieldKind: 'task-objective', sourceRefs: ['controller:objective'], authorityScope: null }, 'requirements.0.text': { sourceKind: 'controller', fieldKind: 'requirement-text', sourceRefs: ['user:req-R-live'], authorityScope: null }, 'requirements.0.status': { sourceKind: 'controller', fieldKind: 'requirement-status', sourceRefs: ['user:req-R-live'], authorityScope: null }, 'constraints.0.text': { sourceKind: 'controller', fieldKind: 'constraint-text', sourceRefs: ['user:constraint-0'], authorityScope: null }, 'decisions.0.statement': { sourceKind: 'controller', fieldKind: 'decision-statement', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'decisions.0.authority': { sourceKind: 'controller', fieldKind: 'decision-authority', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'decisions.0.status': { sourceKind: 'controller', fieldKind: 'decision-status', sourceRefs: ['controller:decision-D-live'], authorityScope: null }, 'verification.outcomes.0.status': { sourceKind: 'verification', fieldKind: 'verification-outcome', sourceRefs: ['verification:unit'], authorityScope: null }, 'continuation.nextAction': { sourceKind: 'controller', fieldKind: 'next-action', sourceRefs: ['controller:continuation'], authorityScope: null }, 'continuation.recentUserIntent': { sourceKind: 'controller', fieldKind: 'user-intent', sourceRefs: ['user:intent-event'], authorityScope: null }, repository: { sourceKind: 'repository', fieldKind: 'repository-fact', sourceRefs: ['repository:HEAD'], authorityScope: null } };
  return ts;
}
function liveSnapshotInput(ts) {
  return { taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, workspaceId: ts.workspaceId, repositoryId: ts.repositoryId, checkoutId: ts.checkoutId, generation: ts.generation, safePointBoundarySeq: ts.safePointBoundarySeq, sessionRevision: ts.sessionRevision, taskRevision: ts.taskRevision, repositoryRevision: clone(ts.repositoryRevision), runtimeRevision: null };
}
function liveBoundaryContext(session, tracker, taskRevision) {
  return { sessionEvents: Array.from(session.events), sessionDurable: { flushedSeq: tracker.flushedSeq === undefined ? null : tracker.flushedSeq, flushParticipated: tracker.flushParticipated === undefined ? false : tracker.flushParticipated }, controller: { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision }, runtime: { currentSnapshotSeq: null, transitionOpen: false } };
}
function unitCost(sliceEvents) {
  const bytes = pressure.byteLengthUtf8(pressure.serializeCanonical(sliceEvents));
  return { tokens: pressure.estimateTokensForUtf8Bytes(bytes), method: 'conservative-estimate', exact: false };
}
function shadowInputOf(session, tracker, ts, token, safeDecision, gateDecision, pressureDecision, plan, units, spans) {
  return { schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: session.id, generation: ts.generation, snapshotToken: token, snapshotCurrentState: liveSnapshotInput(ts), safePointDecision: safeDecision, checkpointabilityDecision: gateDecision, pressureDecision, retentionPlan: plan, taskState: ts, contextUnits: units, sessionEvents: Array.from(session.events), surfaceNodes: Array.from(session.surface.nodes), protocolSpans: spans || [], createdAtUtc: CREATED, sealedAtUtc: CREATED };
}
function mirrorMessages(session) {
  const out = [];
  for (const seq of session.surface.nodes) {
    const message = shadow.deriveProjectedMessageV2(session.events[seq]);
    if (message !== null && message !== undefined) out.push(message);
  }
  return out;
}
function liveMessageTexts(messages) {
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
async function main() {
  section('live: large history yields a valid A08 plan, then A09 shadow-ready');
  const proc = createHostProcess();
  const tracker = {};
  const session = proc.store.create('sess-a09live-ready', { meta: { cwd: WORKSPACE } });
  check(true, 'live session created through SessionStore.create (' + host.version + ')');
  // Deterministic large history: ~419 KiB of tool output drives HIGH
  // pressure honestly through the frozen conservative estimator.
  const BIG = 'LIVE-A09-BIG-0123456789;'.repeat(17200);
  session.append('user/message', userMessage('LIVE-A09-FIRST-REQUEST'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantText('LIVE-A09-FIRST-REPLY', 't1', 's1'), { surfaceOp: 'append' });
  session.append('user/message', userMessage('LIVE-A09-TOOL-REQUEST'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantToolCall('live-a09-call-1', 't1', 's1'), { surfaceOp: 'append' });
  session.append('tool/call', { callId: 'live-a09-call-1', turn: 't1', step: 's1' });
  session.append('tool/result', toolResult('live-a09-call-1', BIG, 't1', 's1'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantText('LIVE-A09-POST-TOOL', 't1', 's1'), { surfaceOp: 'append' });
  session.append('user/message', userMessage('LIVE-A09-CURRENT'), { surfaceOp: 'append' });
  check(session.events.length === 8, 'live log holds 8 real events (seqs 0..7)');
  tracker.flushParticipated = await flushBarrier(proc, session);
  tracker.flushedSeq = session.events.length - 1;
  check(tracker.flushParticipated === true, 'live store.flush(session) reports a participating listener');
  const ts = liveTaskState(session.id, session.events.length - 1, tracker.flushedSeq);
  const safeDecision = safepoint.detectSafePointV2(liveSafeInput(session, tracker, ts.taskRevision));
  check(safeDecision.safe === true, 'live committed tail with closed tool lifecycle is SAFE (real A06)');
  const token = snapshotV2.capture(liveSnapshotInput(ts), CREATED);
  check(snapshotV2.validateSnapshotToken(token).valid === true, 'live snapshot token captures (real A05)');
  const gateDecision = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safeDecision, snapshotToken: token });
  check(gateDecision.checkpointable === true, 'live SAFE plus live token yields checkpointable (real A07)');
  const cap = pressure.resolveProviderCapacity('deepseek-v4-flash');
  check(cap.known === true && cap.capacityTokens === 131072, 'live pressure capacity resolves from the registry (never invented)');
  const cost = pressure.estimateTokensForEvents(Array.from(session.events));
  const pressureDecision = pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: cap.capacityTokens, currentContextTokens: cost.tokens, costMethod: cost.method, costExact: cost.exact, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: token.taskId, taskInstanceId: token.taskInstanceId, sessionId: token.sessionId, generation: token.generation, snapshotTokenId: token.snapshotTokenId, revisionDigest: token.revisionDigest });
  check(pressureDecision.known === true && pressureDecision.level === 'HIGH', 'live large history yields HIGH pressure honestly (got ' + pressureDecision.level + ' at ' + cost.tokens + ' tokens)');
  const liveEvents = Array.from(session.events);
  const units = [{ unitId: 'live-hist', eventSeqStart: 0, eventSeqEnd: 3, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(0, 4)) }, { unitId: 'live-tool', eventSeqStart: 4, eventSeqEnd: 5, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(4, 6)) }, { unitId: 'live-post', eventSeqStart: 6, eventSeqEnd: 6, requiresContinuation: true, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents.slice(6, 7)) }, { unitId: 'live-user', eventSeqStart: 7, eventSeqEnd: 7, requiresContinuation: true, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: true, tokenCost: unitCost(liveEvents.slice(7)) }];
  // live-post is uncovered NEW state: the cut must stop at the closed tool
  // result seq 5 and retain 6..7 (the planner proves this, A09 consumes it).
  const plan = retention.planRetentionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, safePointDecision: safeDecision, checkpointabilityDecision: gateDecision, pressureDecision, boundaryContext: liveBoundaryContext(session, tracker, ts.taskRevision), contextUnits: units, protocolSpans: [{ startSeq: 3, endSeq: 5 }] });
  check(retention.validateRetentionPlan(plan).valid === true, 'live retention plan validates');
  check(plan.actionable === true && plan.blockers.length === 0, 'live large-history plan is actionable (got ' + JSON.stringify(plan.blockers) + ')');
  check(plan.candidateCompactionBoundarySeq === 5, 'live cut is the real tool-result seq 5 (got ' + String(plan.candidateCompactionBoundarySeq) + ')');
  check(plan.retainedSuffixStartSeq === 6, 'live retained suffix starts at 6');
  // Production immutability baseline: canonical live state before shadow.
  const eventsBefore = JSON.stringify(session.events);
  const messagesBefore = JSON.stringify(session.deriveMessages());
  const fpBefore = shadow.fingerprintLiveState({ sessionEvents: Array.from(session.events), deriveMessages: session.deriveMessages(), taskState: ts, snapshotToken: token, checkpointState: null, runtimeSnapshotIdentity: 'rss_none' });
  const result = shadow.evaluateShadowCompactionV2(shadowInputOf(session, tracker, ts, token, safeDecision, gateDecision, pressureDecision, plan, units, [{ startSeq: 3, endSeq: 5 }]));
  check(result.verdict === 'shadow-ready', 'live shadow verdict is shadow-ready (got ' + result.verdict + ' ' + JSON.stringify(result.blockers).slice(0, 300) + ')');
  check(result.blockers.length === 0, 'live shadow-ready carries zero blockers');
  check(result.checkpoint !== null && result.checkpoint.coverageOk === true, 'live shadow checkpoint carries A07 post-build coverage PASS');
  check(/^[0-9a-f]{64}$/.test(result.checkpoint.sealDigest), 'live shadow seal is a real A04 seal digest');
  check(result.checkpoint.safePointBoundarySeq === safeDecision.boundarySeq, 'live shadow checkpoint binds the real A06 boundary');
  check(result.checkpoint.snapshotTokenId === token.snapshotTokenId, 'live shadow checkpoint binds the real A05 token');
  check(result.projection.attempted === true && result.projection.valid === true, 'live hypothetical projection is valid');
  check(result.projection.beforeEventCount === 8 && result.projection.projectedEventCount === 9, 'live hypothetical log adds one payload replacement (got ' + result.projection.projectedEventCount + ')');
  check(result.projection.beforeMessageCount === 7 && result.projection.projectedMessageCount === 3, 'live model-facing view is payload plus retained suffix (1+2)');
  check(result.projection.segments.length === 1 && result.projection.segments[0].role === 'payload', 'live composition carries exactly one earliest payload segment');
  check(result.projection.segments[0].sourceEventSeqs.join(',') === '0,1,2,3,5', 'live payload sources are the shadowed surface seqs (non-surface tool/call excluded)');
  check(result.projection.operationId.slice(0, 5) === 'ccop_', 'live operation id uses the frozen A02 derivation');
  check(result.projection.currentUserMessageCountBefore === 1 && result.projection.currentUserMessageCountAfter === 1, 'live current request survives exactly once');
  check(result.projection.protocolBalanced === true, 'live complete projected context is protocol-balanced');
  check(result.projection.projectedReclaimTokens === result.projection.beforeContextTokens - result.projection.projectedContextTokens, 'live projected savings equal before minus after on message surfaces');
  check(result.projection.beforeContextTokens > result.projection.projectedContextTokens, 'live shadow projection reclaims context honestly');
  check(result.projection.projectedContextTokens >= result.projection.checkpointPayloadTokens, 'live projected cost covers the payload representation');
  check(result.projection.checkpointPayloadTokens > 0 && result.projection.retainedSuffixTokens > 0, 'live cost breakdown separates payload and suffix');
  console.log('LIVE-COST: before=' + result.projection.beforeContextTokens + ' payload=' + result.projection.checkpointPayloadTokens + ' suffix=' + result.projection.retainedSuffixTokens + ' projected=' + result.projection.projectedContextTokens + ' reclaim=' + result.projection.projectedReclaimTokens + ' a08planned=' + result.reclaimComparison.a08PlannedReclaimTokens + ' delta=' + result.reclaimComparison.deltaTokens);
  check(result.reclaimComparison !== null && result.reclaimComparison.deltaTokens === result.reclaimComparison.a09ProjectedReclaimTokens - result.reclaimComparison.a08PlannedReclaimTokens, 'live A08 vs A09 delta is explicit');
  // Mirror equivalence: the shadow message mirror equals the real host
  // projection on live data (drift would fail loudly, never silently).
  check(JSON.stringify(mirrorMessages(session)) === JSON.stringify(session.deriveMessages()), 'live mirror equals the real host message projection');
  // Independent recomputation through the shared pure builder (the exact
  // path A10 will later apply): sealed checkpoint plus plan plus clones.
  const liveSealed = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: session.id, generation: ts.generation, parentCheckpointId: null, safePointBoundarySeq: safeDecision.boundarySeq, snapshotToken: token, taskState: ts, createdAtUtc: CREATED, sealedAtUtc: CREATED });
  check(liveSealed.checkpointId === result.checkpoint.checkpointId, 'live independently built checkpoint matches the shadow checkpoint');
  const liveUnitsForBuilder = units;
  const rebuilt = shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: session.id, generation: ts.generation, sealedCheckpoint: liveSealed.sealedCheckpoint, retentionPlan: plan, snapshotToken: token, taskState: ts, contextUnits: liveUnitsForBuilder, sourceEvents: Array.from(session.events), surfaceNodes: Array.from(session.surface.nodes), protocolSpans: [{ startSeq: 3, endSeq: 5 }] });
  check(shadow.validateCompactedProjectionV2(rebuilt, { taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: session.id, generation: ts.generation, operationId: rebuilt.operationId, checkpointId: liveSealed.checkpointId, checkpointContentDigest: liveSealed.contentDigest, retentionPlanId: plan.retentionPlanId, sourceSnapshotTokenId: token.snapshotTokenId, sourceRevisionDigest: token.revisionDigest, candidateCompactionBoundarySeq: plan.candidateCompactionBoundarySeq, retainedSuffixStartSeq: plan.retainedSuffixStartSeq, sourceEvents: Array.from(session.events), surfaceNodes: Array.from(session.surface.nodes), taskState: ts, contextUnits: liveUnitsForBuilder, protocolSpans: [{ startSeq: 3, endSeq: 5 }] }).valid === true, 'live independently built projection validates');
  check(rebuilt.projectionDigest === result.projection.projectionDigest, 'live rebuilt complete projection matches the shadow digest');
  const liveTexts = liveMessageTexts(rebuilt.projectedMessages).join('');
  check(liveTexts.split('LIVE-A09-CURRENT').length - 1 === 1, 'live current request appears exactly once in the complete view');
  check(liveTexts.split('LIVE-A09-BIG').length - 1 === 0, 'live compacted prefix leaves the complete view');
  check(liveTexts.split('Shadow observes the live pipeline without applying.').length - 1 === 1, 'live historical requirement survives exactly once via the payload (no raw retained carrier)');
  check(shadow.validateShadowResultV2(result).valid === true, 'live shadow result validates closed-world');
  const tel = shadow.shadowTelemetry(result);
  check(tel.shadowVerdict === 'shadow-ready' && tel.protocolBalanced === true, 'live shadow telemetry reports the ready verdict');
  check(JSON.stringify(tel).indexOf('LIVE-A09-BIG') === -1, 'live telemetry carries no raw context text');
  // The sole production behavior rule: identical live state after shadow.
  check(JSON.stringify(session.events) === eventsBefore, 'live session events are byte-identical after shadow evaluation');
  check(JSON.stringify(session.deriveMessages()) === messagesBefore, 'live deriveMessages() is byte-identical after shadow evaluation');
  const fpAfter = shadow.fingerprintLiveState({ sessionEvents: Array.from(session.events), deriveMessages: session.deriveMessages(), taskState: ts, snapshotToken: token, checkpointState: null, runtimeSnapshotIdentity: 'rss_none' });
  check(fpBefore === fpAfter, 'live fingerprint is identical before and after shadow evaluation');
  // Determinism on the live host: evaluate twice, byte-identical.
  const again = shadow.evaluateShadowCompactionV2(shadowInputOf(session, tracker, ts, token, safeDecision, gateDecision, pressureDecision, plan, units, [{ startSeq: 3, endSeq: 5 }]));
  check(JSON.stringify(again) === JSON.stringify(result), 'live repeated evaluation is byte-identical');

  section('live: open tool edge blocks the shadow with no projection');
  const proc3 = createHostProcess();
  const tracker3 = {};
  const session3 = proc3.store.create('sess-a09live-openedge', { meta: { cwd: WORKSPACE } });
  session3.append('user/message', userMessage('LIVE-A09-OPEN-REQUEST'), { surfaceOp: 'append' });
  session3.append('assistant/message', assistantToolCall('live-a09-open-1', 't1', 's1'), { surfaceOp: 'append' });
  tracker3.flushParticipated = await flushBarrier(proc3, session3);
  tracker3.flushedSeq = session3.events.length - 1;
  const ts3 = liveTaskState(session3.id, tracker3.flushedSeq, tracker3.flushedSeq);
  const unsafeLive = safepoint.detectSafePointV2(liveSafeInput(session3, tracker3, ts3.taskRevision));
  check(unsafeLive.safe === false, 'live open tool call is UNSAFE (real A06)');
  const token3 = snapshotV2.capture(liveSnapshotInput(ts3), CREATED);
  const gate3 = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts3, safePointDecision: unsafeLive, snapshotToken: token3 });
  check(gate3.checkpointable === false, 'UNSAFE live boundary blocks even with a fresh token (real A07)');
  const cost3 = pressure.estimateTokensForEvents(Array.from(session3.events));
  const pressure3 = pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: 131072, currentContextTokens: cost3.tokens, costMethod: cost3.method, costExact: cost3.exact, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: token3.taskId, taskInstanceId: token3.taskInstanceId, sessionId: token3.sessionId, generation: token3.generation, snapshotTokenId: token3.snapshotTokenId, revisionDigest: token3.revisionDigest });
  const units3 = [{ unitId: 'open-hist', eventSeqStart: 0, eventSeqEnd: 0, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(Array.from(session3.events).slice(0, 1)) }, { unitId: 'open-user', eventSeqStart: 1, eventSeqEnd: 1, requiresContinuation: true, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: true, tokenCost: unitCost(Array.from(session3.events).slice(1)) }];
  const plan3 = retention.planRetentionV2({ schemaVersion: 1, taskId: ts3.taskId, taskInstanceId: ts3.taskInstanceId, sessionId: ts3.sessionId, generation: ts3.generation, snapshotToken: token3, safePointDecision: unsafeLive, checkpointabilityDecision: gate3, pressureDecision: pressure3, boundaryContext: liveBoundaryContext(session3, tracker3, ts3.taskRevision), contextUnits: units3, protocolSpans: [] });
  check(plan3.actionable === false, 'UNSAFE live boundary yields no actionable plan');
  const events3Before = JSON.stringify(session3.events);
  const messages3Before = JSON.stringify(session3.deriveMessages());
  const blocked = shadow.evaluateShadowCompactionV2(shadowInputOf(session3, tracker3, ts3, token3, unsafeLive, gate3, pressure3, plan3, units3, []));
  check(blocked.verdict === 'blocked', 'live open edge yields shadow blocked (got ' + blocked.verdict + ')');
  check(blocked.checkpoint === null && blocked.projection.attempted === false, 'live blocked path produces no projection');
  check(codes(blocked).indexOf('shadow-safe-point-required') !== -1, 'live blocked names the A06 cause');
  check(JSON.stringify(session3.events) === events3Before, 'blocked evaluation leaves live events untouched');
  check(JSON.stringify(session3.deriveMessages()) === messages3Before, 'blocked evaluation leaves live projection untouched');

  section('live: continued work stales S1; a fresh evaluation is required');
  session.append('user/message', userMessage('LIVE-A09-NEXT'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantText('LIVE-A09-NEXT-REPLY', 't2', 's1'), { surfaceOp: 'append' });
  tracker.flushParticipated = await flushBarrier(proc, session);
  tracker.flushedSeq = session.events.length - 1;
  const ts2 = liveTaskState(session.id, session.events.length - 1, tracker.flushedSeq);
  const token2 = snapshotV2.capture(liveSnapshotInput(ts2), CREATED);
  const freshBindings = { taskId: result.taskId, taskInstanceId: result.taskInstanceId, sessionId: result.sessionId, generation: result.generation, snapshotTokenId: token2.snapshotTokenId, revisionDigest: token2.revisionDigest, safePointBoundarySeq: session.events.length - 1, providerModelId: result.providerModelId, pressureBasisDigest: result.pressureBasisDigest, retentionPlanId: 'crp_pending' };
  check(shadow.assertShadowResultFresh(result, freshBindings).ok === false, 'continued live work makes S1 STALE (never eligible for A10)');
  const safe2 = safepoint.detectSafePointV2(liveSafeInput(session, tracker, ts2.taskRevision));
  check(safe2.safe === true, 'post-work live boundary is SAFE again');
  const gate2 = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts2, safePointDecision: safe2, snapshotToken: token2 });
  check(gate2.checkpointable === true, 're-capture after live work restores checkpointability');
  const cost2 = pressure.estimateTokensForEvents(Array.from(session.events));
  const pressure2 = pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: 131072, currentContextTokens: cost2.tokens, costMethod: cost2.method, costExact: cost2.exact, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: token2.taskId, taskInstanceId: token2.taskInstanceId, sessionId: token2.sessionId, generation: token2.generation, snapshotTokenId: token2.snapshotTokenId, revisionDigest: token2.revisionDigest });
  const liveEvents2 = Array.from(session.events);
  const units2 = [{ unitId: 'live-hist', eventSeqStart: 0, eventSeqEnd: 3, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents2.slice(0, 4)) }, { unitId: 'live-tool', eventSeqStart: 4, eventSeqEnd: 5, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents2.slice(4, 6)) }, { unitId: 'live-post', eventSeqStart: 6, eventSeqEnd: 7, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents2.slice(6, 8)) }, { unitId: 'live-next', eventSeqStart: 8, eventSeqEnd: 8, requiresContinuation: true, a07Coverage: 'represented', durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: unitCost(liveEvents2.slice(8, 9)) }, { unitId: 'live-user-2', eventSeqStart: 9, eventSeqEnd: 9, requiresContinuation: true, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: true, tokenCost: unitCost(liveEvents2.slice(9)) }];
  const plan2 = retention.planRetentionV2({ schemaVersion: 1, taskId: ts2.taskId, taskInstanceId: ts2.taskInstanceId, sessionId: ts2.sessionId, generation: ts2.generation, snapshotToken: token2, safePointDecision: safe2, checkpointabilityDecision: gate2, pressureDecision: pressure2, boundaryContext: liveBoundaryContext(session, tracker, ts2.taskRevision), contextUnits: units2, protocolSpans: [{ startSeq: 3, endSeq: 5 }] });
  check(retention.validateRetentionPlan(plan2).valid === true, 'fresh live plan validates');
  const fresh = shadow.evaluateShadowCompactionV2(shadowInputOf(session, tracker, ts2, token2, safe2, gate2, pressure2, plan2, units2, [{ startSeq: 3, endSeq: 5 }]));
  check(fresh.verdict === 'shadow-ready', 'fresh live evaluation after continued work is shadow-ready (got ' + fresh.verdict + ' ' + JSON.stringify(fresh.blockers).slice(0, 300) + ')');
  check(fresh.shadowId !== result.shadowId, 'fresh live result carries distinct identity (S1 never reused)');
  check(shadow.assertShadowResultFresh(fresh, { taskId: fresh.taskId, taskInstanceId: fresh.taskInstanceId, sessionId: fresh.sessionId, generation: fresh.generation, snapshotTokenId: fresh.snapshotTokenId, revisionDigest: fresh.revisionDigest, safePointBoundarySeq: fresh.safePointBoundarySeq, providerModelId: fresh.providerModelId, pressureBasisDigest: fresh.pressureBasisDigest, retentionPlanId: fresh.retentionPlanId }).ok === true, 'fresh live result validates against current bindings');
}
main().then(() => { console.log(''); console.log('A09 live-host proof: ' + passed + ' passed, ' + failed + ' failed'); if (failed > 0) process.exit(1); }).catch((e) => { console.log('FAIL: live proof threw :: ' + String((e && e.message) || e).slice(0, 500)); console.log(String((e && e.stack) || '').split('\n').slice(0, 6).join('\n')); process.exit(1); });
