'use strict';
/**
 * ContextCheckpointabilityV2LiveHost.Tests.cjs - CCV2-A07 real-host proof.
 *
 * Proves the CheckpointabilityGate contract against the REAL pinned DSH
 * host (@deepseek-ai/dsh-session 0.1.1-rc.2: real SessionStore, real
 * session/flush durability barrier, real Session restore). Nothing is
 * simulated: every session event enters a real host log through
 * session.append(), durability comes from store.flush() participation, and
 * restarts replay durable bytes. The A06 decision is detected for real,
 * the A05 token is captured from live revisions, and the A07 gate consumes
 * both verbatim. A05H strict gate applies: host absent plus strict env =
 * REQUIRED-MISSING (FAIL, never faked).
 *
 * Live scenarios: committed boundary gates checkpointable end to end
 * (detect SAFE, capture, evaluate, seal, cover, persist, reload, cover
 * again); state movement after capture blocks stale; re-capture restores
 * checkpointability across work; an open live tool edge blocks through the
 * real UNSAFE decision; restart preserves the gate result.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const gate = require(path.join(repoRoot, 'config', 'ContextCheckpointabilityV2.cjs'));
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const snapshotV2 = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const safepoint = require(path.join(repoRoot, 'config', 'ContextSafePointV2.cjs'));
const trustV2 = require(path.join(repoRoot, 'config', 'ContextTrustV2.cjs'));
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(title) { console.log('\n--- ' + title + ' ---'); }
function blockerCodes(decision) { return decision.blockers.map((b) => b.code); }
const clone = (o) => JSON.parse(JSON.stringify(o));

const HOST_APP = process.env.AIH_HOST_APP || '/home/kaloyan/.local/share/nexus/app';
const RUNTIME_PLUGIN = '@deepseek-ai/dsh-system-prompt';
const CREATED = '2026-09-25T10:00:00.000Z';
const SEALED_AT = '2026-09-25T10:00:01.000Z';
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
      return {
        root,
        sessionPath,
        cordisPath,
        session: require(sessionPath),
        cordis: require(cordisPath),
        version: require(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-session', 'package.json')).version,
      };
    } catch (e) { /* keep searching */ }
  }
  return null;
}

const host = resolveHost();
const liveGate = require(path.join(__dirname, 'Ccv2LiveHostGate.cjs'));
const liveHostFound = Boolean(host && host.session.Session && host.session.SessionStore && host.cordis.Context);
if (!liveHostFound) {
  liveGate.reportLiveHostGate('A07', liveGate.decideLiveHostGate(false, process.env));
  console.log('SKIP: pinned DSH host tree is absent; the A07 live-host proof is PENDING (never faked).');
  process.exit(0);
}
liveGate.reportLiveHostGate('A07', 'EXECUTED');
const { SessionStore } = host.session;
const { Context } = host.cordis;

let messageCounter = 0;
function newMessageId() { messageCounter += 1; return 'msg-a07live-' + messageCounter; }
function modelSource() { return { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' }; }
function userMessage(text, source) { return { id: newMessageId(), role: 'user', content: [{ type: 'text', text }], source: source || { kind: 'user' } }; }
function assistantText(text, turn, step) {
  const source = modelSource();
  return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'text', text }], source }, source };
}
function assistantToolCall(callId, turn, step) {
  const source = modelSource();
  return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'tool-call', name: 'run_command', callId }], source }, source };
}

function createHostProcess() {
  const app = new Context();
  const store = new SessionStore(app);
  const durable = { bytes: null, writes: 0, flushedSessionIds: [], header: null };
  app.on('session/flush', async (session) => {
    durable.bytes = JSON.stringify(session.events);
    durable.writes += 1;
    durable.flushedSessionIds.push(session.id);
    durable.header = { version: session.header.version, id: session.header.id, createdAt: session.header.createdAt, cwd: session.header.cwd };
  });
  return { app, store, durable };
}

async function flushBarrier(proc, session) {
  const participated = await proc.store.flush(session);
  return participated === true;
}

// Grounded live task state bound to the real session: live session id,
// live boundary seq, live durable revision, and a live-derived task
// revision over the fixture semantic sections.
function liveTaskState(sessionId, boundarySeq, sessionRevision) {
  const ts = {
    schemaVersion: 1,
    taskId: 'TASK-A07-LIVE',
    taskInstanceId: 'task_a07live_0001',
    sessionId,
    workspaceId: WORKSPACE,
    repositoryId: null,
    checkoutId: null,
    generation: 1,
    safePointBoundarySeq: boundarySeq,
    sessionRevision,
    taskRevision: 'pending',
    repositoryRevision: { headCommit: 'live-head', indexDigest: null, worktreeDigest: null },
    runtimeRevision: { runtimeSnapshotSeq: null },
    objective: { text: 'Prove A07 on the live host.', status: 'in-progress' },
    requirements: [{ id: 'R-live', text: 'Gate decides over live state.', status: 'active', evidenceRefs: [], sourceKind: 'controller' }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.', sourceKind: 'controller' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'A07 live', remainingMilestones: [] },
    decisions: [{ id: 'D-live', statement: 'The live boundary authorizes capture.', authority: 'controller-established', status: 'active', evidenceRefs: [], sourceKind: 'controller' }],
    repository: { repositoryId: null, checkoutId: null, headCommit: 'live-head', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: { activeFailures: [], rejectedHypotheses: [], retryState: null },
    verification: { outcomes: [{ scope: 'unit', status: 'PENDING', detail: null, evidenceRefs: [] }], note: null },
    continuation: { nextAction: 'Continue live work.', unresolvedQuestions: [], recentUserIntent: 'Prove A07 live.' },
    provenance: {},
    ephemeralState: [],
    unsupportedState: [],
    reconstructionRefs: [],
  };
  ts.taskRevision = snapshotV2.deriveTaskRevision(ts);
  ts.provenance = {
    'objective.text': { sourceKind: 'controller', fieldKind: 'task-objective', sourceRefs: ['controller:objective'], authorityScope: null },
    'requirements.0.text': { sourceKind: 'controller', fieldKind: 'requirement-text', sourceRefs: ['user:req-R-live'], authorityScope: null },
    'requirements.0.status': { sourceKind: 'controller', fieldKind: 'requirement-status', sourceRefs: ['user:req-R-live'], authorityScope: null },
    'constraints.0.text': { sourceKind: 'controller', fieldKind: 'constraint-text', sourceRefs: ['user:constraint-0'], authorityScope: null },
    'decisions.0.statement': { sourceKind: 'controller', fieldKind: 'decision-statement', sourceRefs: ['controller:decision-D-live'], authorityScope: null },
    'decisions.0.authority': { sourceKind: 'controller', fieldKind: 'decision-authority', sourceRefs: ['controller:decision-D-live'], authorityScope: null },
    'decisions.0.status': { sourceKind: 'controller', fieldKind: 'decision-status', sourceRefs: ['controller:decision-D-live'], authorityScope: null },
    'verification.outcomes.0.status': { sourceKind: 'verification', fieldKind: 'verification-outcome', sourceRefs: ['verification:unit'], authorityScope: null },
    'continuation.nextAction': { sourceKind: 'controller', fieldKind: 'next-action', sourceRefs: ['controller:continuation'], authorityScope: null },
    'continuation.recentUserIntent': { sourceKind: 'controller', fieldKind: 'user-intent', sourceRefs: ['user:intent-event'], authorityScope: null },
    repository: { sourceKind: 'repository', fieldKind: 'repository-fact', sourceRefs: ['repository:HEAD'], authorityScope: null },
  };
  return ts;
}

function liveSnapshotInput(ts) {
  return {
    taskId: ts.taskId,
    taskInstanceId: ts.taskInstanceId,
    sessionId: ts.sessionId,
    workspaceId: ts.workspaceId,
    repositoryId: ts.repositoryId,
    checkoutId: ts.checkoutId,
    generation: ts.generation,
    safePointBoundarySeq: ts.safePointBoundarySeq,
    sessionRevision: ts.sessionRevision,
    taskRevision: ts.taskRevision,
    repositoryRevision: clone(ts.repositoryRevision),
    runtimeRevision: null,
  };
}

function liveSafeInput(session, tracker, taskRevision) {
  return {
    schemaVersion: 1,
    taskId: 'TASK-A07-LIVE',
    taskInstanceId: 'task_a07live_0001',
    sessionId: session.id,
    sessionEvents: Array.from(session.events),
    sessionDurable: {
      flushedSeq: tracker.flushedSeq === undefined ? null : tracker.flushedSeq,
      flushParticipated: tracker.flushParticipated === undefined ? false : tracker.flushParticipated,
    },
    controller: { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision },
    runtime: { currentSnapshotSeq: compaction.currentRuntimeSnapshotSeqOf(session), transitionOpen: false },
  };
}

function liveCheckpointInput(ts, token) {
  return {
    taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, workspaceId: ts.workspaceId,
    repositoryId: ts.repositoryId, checkoutId: ts.checkoutId, generation: ts.generation, kind: 'active',
    safePointBoundarySeq: ts.safePointBoundarySeq, safePointStepId: null, createdAtUtc: CREATED,
    objective: clone(ts.objective),
    requirements: ts.requirements.map((r) => ({ id: r.id, text: r.text, status: r.status, evidenceRefs: r.evidenceRefs.slice() })),
    constraints: ts.constraints.map((c) => ({ type: c.type, text: c.text })),
    progress: clone(ts.progress),
    decisions: ts.decisions.map((d) => ({ id: d.id, statement: d.statement, authority: d.authority, status: d.status, evidenceRefs: d.evidenceRefs.slice() })),
    repository: clone(ts.repository),
    evidenceRefs: [],
    failures: clone(ts.failures),
    verification: clone(ts.verification),
    continuation: clone(ts.continuation),
    snapshotToken: token,
    pressure: null,
  };
}

function liveProvenanceInputs(ts) {
  const inputs = {};
  for (const p of Object.keys(ts.provenance)) {
    const s = ts.provenance[p];
    inputs[p] = { fieldKind: s.fieldKind, sourceKind: s.sourceKind, sourceRefs: s.sourceRefs.slice(), authorityScope: s.authorityScope };
    const m = /^decisions[.](\d+)[.]authority$/.exec(p);
    if (m) inputs[p].decisionValue = ts.decisions[Number(m[1])].authority;
  }
  return inputs;
}
async function main() {
  // == 1. live committed boundary gates checkpointable end to end ==========
  section('live: committed boundary is checkpointable end to end');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a07live-committed', { meta: { cwd: WORKSPACE } });
    check(true, 'live session created through SessionStore.create (' + host.version + ')');
    session.append('user/message', userMessage('LIVE-A07-REQUEST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-A07-REPLY', 't1', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    check(tracker.flushParticipated === true, 'live store.flush(session) reports a participating listener');
    const ts = liveTaskState(session.id, session.events.length - 1, tracker.flushedSeq);
    const safeDecision = safepoint.detectSafePointV2(liveSafeInput(session, tracker, ts.taskRevision));
    check(safeDecision.safe === true, 'live committed boundary is SAFE (real A06 detection)');
    check(safeDecision.boundarySeq === session.events.length - 1, 'live boundarySeq is the grounded tail seq');
    const token = snapshotV2.capture(liveSnapshotInput(ts), CREATED);
    check(snapshotV2.validateSnapshotToken(token).valid === true, 'live snapshot token captures (real A05 capture)');
    const decision = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safeDecision, snapshotToken: token });
    check(decision.checkpointable === true, 'live SAFE plus live token yields checkpointable');
    check(gate.validateCheckpointabilityDecision(decision).valid === true, 'live decision validates');
    const sealed = trustV2.buildSealedCheckpointV2(liveCheckpointInput(ts, token), liveProvenanceInputs(ts), { sealedAtUtc: SEALED_AT });
    check(trustV2.validateSealedCheckpoint(sealed.checkpoint).valid === true, 'live checkpoint seals');
    const coverage = gate.assertCheckpointCoverageV2({ schemaVersion: 1, taskState: ts, checkpoint: sealed.checkpoint, snapshotToken: token, safePointDecision: safeDecision });
    check(coverage.ok === true, 'live checkpoint passes post-build coverage');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a07-live-'));
    const stored = checkpoint.persistCheckpointV2(dir, sealed);
    snapshotV2.persistSnapshotToken(dir, token);
    const reloaded = checkpoint.readCheckpointV2(dir, 1).checkpoint;
    const reloadedToken = snapshotV2.readSnapshotToken(dir, token.snapshotTokenId).token;
    const afterRestart = gate.assertCheckpointCoverageV2({ schemaVersion: 1, taskState: ts, checkpoint: reloaded, snapshotToken: reloadedToken, safePointDecision: safeDecision });
    check(afterRestart.ok === true, 'reloaded live checkpoint still covers every required item');
    check(stored.checkpoint.checkpointId === sealed.checkpointId, 'live checkpoint identity survives persistence');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // == 2. live state movement after capture blocks ==========================
  section('live: state movement after capture blocks');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a07live-moved', { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-A07-BEFORE'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-A07-REPLY', 't1', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const ts = liveTaskState(session.id, session.events.length - 1, tracker.flushedSeq);
    const safeDecision = safepoint.detectSafePointV2(liveSafeInput(session, tracker, ts.taskRevision));
    check(safeDecision.safe === true, 'pre-move boundary is SAFE');
    const token = snapshotV2.capture(liveSnapshotInput(ts), CREATED);
    // Work continues on the live log: a new committed turn, then a flush.
    session.append('user/message', userMessage('LIVE-A07-AFTER'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-A07-REPLY-2', 't2', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const movedInput = liveSnapshotInput(ts);
    movedInput.sessionRevision = tracker.flushedSeq;
    const stale = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safeDecision, snapshotToken: token, currentSnapshotState: movedInput });
    check(stale.checkpointable === false, 'moved live state blocks the old token');
    check(blockerCodes(stale).includes('checkpointability-snapshot-stale'), 'moved live state yields snapshot-stale');
    // Re-detect plus re-capture on the live log restores checkpointability.
    const ts2 = liveTaskState(session.id, session.events.length - 1, tracker.flushedSeq);
    const safe2 = safepoint.detectSafePointV2(liveSafeInput(session, tracker, ts2.taskRevision));
    check(safe2.safe === true, 'post-move boundary is SAFE again');
    const token2 = snapshotV2.capture(liveSnapshotInput(ts2), CREATED);
    const decision2 = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts2, safePointDecision: safe2, snapshotToken: token2 });
    check(decision2.checkpointable === true, 're-capture after live work restores checkpointability');
  }

  // == 3. live open tool edge blocks through the real UNSAFE decision =======
  section('live: open tool edge blocks');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a07live-openedge', { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-A07-TOOL-REQUEST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantToolCall('live-a07-call-1', 't1', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const ts = liveTaskState(session.id, tracker.flushedSeq, tracker.flushedSeq);
    const unsafe = safepoint.detectSafePointV2(liveSafeInput(session, tracker, ts.taskRevision));
    check(unsafe.safe === false, 'live open tool call is UNSAFE (real A06 detection)');
    const token = snapshotV2.capture(liveSnapshotInput(ts), CREATED);
    const decision = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: unsafe, snapshotToken: token });
    check(decision.checkpointable === false, 'UNSAFE live boundary blocks even with a fresh token');
    check(blockerCodes(decision).includes('checkpointability-safe-point-required'), 'open edge yields safe-point-required (no layer compensates)');
  }
  // == 4. live restart preserves the gate result ============================
  section('live: restart preserves checkpointability');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a07live-restart', { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-A07-RESTART-REQUEST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-A07-RESTART-REPLY', 't1', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const ts = liveTaskState(session.id, session.events.length - 1, tracker.flushedSeq);
    const safeDecision = safepoint.detectSafePointV2(liveSafeInput(session, tracker, ts.taskRevision));
    check(safeDecision.safe === true, 'pre-restart boundary is SAFE');
    const token = snapshotV2.capture(liveSnapshotInput(ts), CREATED);
    const before = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safeDecision, snapshotToken: token });
    check(before.checkpointable === true, 'pre-restart state is checkpointable');
    const proc2 = createHostProcess();
    const seed = JSON.parse(proc.durable.bytes);
    const resumed = proc2.store.create('sess-a07live-restart', { seedSource: 'persistence', seed, meta: proc.durable.header });
    const tracker2 = { flushedSeq: tracker.flushedSeq, flushParticipated: true };
    const ts2 = liveTaskState(resumed.id, tracker.flushedSeq, tracker.flushedSeq);
    const safe2 = safepoint.detectSafePointV2(liveSafeInput(resumed, tracker2, ts2.taskRevision));
    check(safe2.safe === true, 'restored boundary is SAFE with no new flush');
    check(safe2.boundarySeq === safeDecision.boundarySeq, 'restart preserves the boundary seq');
    const after = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts2, safePointDecision: safe2, snapshotToken: token });
    check(after.checkpointable === true, 'restored state is still checkpointable under the same token');
    check(after.requiredState.digest === before.requiredState.digest, 'restart preserves the required-state digest');
  }
}

main().then(() => {
  console.log('\nA07 live-host proof: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
}).catch((error) => {
  console.error('FAIL: live-host proof crashed :: ' + String(error && error.stack ? error.stack : error));
  process.exit(1);
});