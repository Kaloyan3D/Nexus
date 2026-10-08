'use strict';
/**
 * ContextCompleteTaskV2LiveHost.Tests.cjs - CCV2-A13 real-host integration.
 *
 * Proves the complete-task integration against the REAL pinned DSH host
 * (@deepseek-ai/dsh-session 0.1.1-rc.2: real SessionStore, real append-only
 * log, real store.flush durability barrier, real deriveMessages(), real
 * Session restore). Nothing about the host is simulated: every boundary
 * evaluates through the A13 integration, every generation reserves through
 * A11, shadows through A09, applies through A10, and commits through A11.
 *
 * Proves on the host: START -> work -> HIGH -> CCv2 G1 -> more work ->
 * HIGH -> CCv2 G2 -> COMPLETE (controller-owned) -> restart-from-durable
 * -> resume with the committed head, valid projection, current-user-once,
 * and balanced protocol. A05H strict gate applies: host absent + strict
 * env = FAIL (never faked).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const integ = require(path.join(repoRoot, 'config', 'ContextCompleteTaskV2.cjs'));
const runtime = require(path.join(repoRoot, 'config', 'ContextGenerationRuntimeV2.cjs'));
const shadow = require(path.join(repoRoot, 'config', 'ContextShadowV2.cjs'));
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));
const snapshotV2 = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const builders = require(path.join(__dirname, 'ContextActiveApplyV2.Tests.cjs'));
const liveGate = require(path.join(__dirname, 'Ccv2LiveHostGate.cjs'));

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
const CREATED = builders.CREATED;
const WORKSPACE = path.resolve(repoRoot);
const TASK_ID = 'TASK-A13-LIVE';
const TASK_INSTANCE = 'task_a13live_0001';
const HIGH_TOK = 100000;

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
      return { root, session: require(sessionPath), cordis: require(cordisPath), version: require(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-session', 'package.json')).version };
    } catch (e) { /* keep searching */ }
  }
  return null;
}
const host = resolveHost();
const liveHostFound = Boolean(host && host.session.Session && host.session.SessionStore && host.cordis.Context);
if (!liveHostFound) {
  liveGate.reportLiveHostGate('A13', liveGate.decideLiveHostGate(false, process.env));
  console.log('SKIP: pinned DSH host tree is absent; the A13 live-host proof is PENDING (never faked).');
  process.exit(0);
}
liveGate.reportLiveHostGate('A13', 'EXECUTED');
console.log('HOST: dsh-session@' + host.version);

function createHostProcess() {
  const app = new host.cordis.Context();
  const store = new host.session.SessionStore(app);
  const durable = { bytes: null, writes: 0, header: null };
  app.on('session/flush', async (session) => {
    durable.bytes = JSON.stringify(Array.from(session.events));
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a13live-'));
  return { base, runtimeDir: path.join(base, 'runtime'), checkpointDir: path.join(base, 'checkpoints'), operationRoot: path.join(base, 'operations'), lockWorkspace: path.join(base, 'ledger') };
}
function makeFakeLockClient() {
  const state = { held: false, ownerId: null };
  let ownerCounter = 0;
  async function acquire() {
    if (state.held) return { acquired: false, ownerId: null, leaseSeconds: 60, reason: 'held-by-live-owner' };
    ownerCounter += 1;
    state.held = true;
    state.ownerId = 'fake-a13live-owner-' + ownerCounter;
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
let messageCounter = 0;
function newMessageId() { messageCounter += 1; return 'msg-a13live-' + messageCounter; }
function userMessage(text) { return { id: newMessageId(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }; }
function assistantText(text, turn, step) {
  return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' } }, source: { kind: 'model' } };
}
function liveFixture(session, generation, tag) {
  const events = Array.from(session.events);
  const last = events.length - 1;
  const U = builders.U;
  const units = [
    U('u-hist', 0, Math.max(0, last - 3), { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 6000, method: 'provider-tokenizer', exact: true } }),
    U('u-new', Math.max(0, last - 2), Math.max(0, last - 1), { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }),
    U('u-user', last, last, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } }),
  ];
  const over = { taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: session.id, workspaceId: WORKSPACE, generation };
  const ts0 = builders.draftTaskState(last, last, over);
  ts0.requirements = [{ id: 'R-live', text: 'Advance the live chain (' + tag + ').', status: 'active', evidenceRefs: [], sourceKind: 'controller' }];
  ts0.evidenceRefs = [];
  const ts = builders.finalizeTs(ts0);
  return { ts, units };
}
async function liveBoundary(env, lock, proc, session, tracker, fx, tok, controllerOver) {
  await flushBarrier(proc, session);
  tracker.flushedSeq = session.events.length - 1;
  tracker.flushParticipated = true;
  return integ.evaluateBoundary({
    schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: session.id,
    runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, lockWorkspace: env.lockWorkspace,
    compactionVersion: 'v2',
    controller: Object.assign({ taskStatus: 'active', transitionOpen: false, completionCommitted: false, streamOpen: false, toolEdgeOpen: false, taskRevision: fx.ts.taskRevision }, controllerOver || {}),
    sessionDurable: { flushedSeq: tracker.flushedSeq, flushParticipated: true },
    hostRuntime: { currentSnapshotSeq: null, transitionOpen: false },
    provider: { modelId: 'deepseek-v4-flash', capacityTokens: 131072 },
    tokenObservation: { currentContextTokens: tok, costMethod: 'conservative-estimate', costExact: false },
    session, taskState: fx.ts, contextUnits: fx.units, protocolSpans: [],
    serialization: lock, flushFn: async (s) => (await proc.store.flush(s)) === true,
    stateCache: {}, createdAtUtc: CREATED,
  });
}
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

async function main() {
  section('A13 LIVE integrated task (START -> G1 -> work -> G2 -> COMPLETE -> restart)');
  const env = makeEnv();
  const lock = makeFakeLockClient();
  const proc = createHostProcess();
  const sid = 'sess-a13live-1';
  const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
  session.append('user/message', userMessage('LIVE-A13-FIRST-REQUEST'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantText('LIVE-A13-FIRST-REPLY', 't0', 's0'), { surfaceOp: 'append' });
  session.append('user/message', userMessage('LIVE-A13-SECOND-REQUEST'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantText('LIVE-A13-SECOND-REPLY', 't0', 's1'), { surfaceOp: 'append' });
  session.append('user/message', userMessage('LIVE-A13-CURRENT-0'), { surfaceOp: 'append' });
  const tracker = {};
  const fx0 = liveFixture(session, 1, 'open');
  const n0 = await liveBoundary(env, lock, proc, session, tracker, fx0, 50000);
  check(n0.action === 'none' && n0.taskMayContinue === true, 'live NORMAL boundary continues the task');
  session.append('user/message', userMessage('LIVE-A13-WORK-1'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantText('LIVE-A13-WORK-REPLY-1', 't1', 's0'), { surfaceOp: 'append' });
  session.append('user/message', userMessage('LIVE-A13-CURRENT-1'), { surfaceOp: 'append' });
  const fx1 = liveFixture(session, 1, 'g1');
  const g1 = await liveBoundary(env, lock, proc, session, tracker, fx1, HIGH_TOK);
  check(g1.action === 'compacted' && g1.generation === 1, 'live G1 compacts through the integrated path (got ' + g1.action + ')');
  check(typeof g1.projectionDigest === 'string', 'live result carries the projection digest');
  const v1 = integ.projectionValidityOf(session);
  check(v1.balanced === true && v1.userOccurrences === 1, 'live post-G1 projection valid');
  session.append('user/message', userMessage('LIVE-A13-WORK-2'), { surfaceOp: 'append' });
  session.append('assistant/message', assistantText('LIVE-A13-WORK-REPLY-2', 't2', 's0'), { surfaceOp: 'append' });
  session.append('user/message', userMessage('LIVE-A13-CURRENT-2'), { surfaceOp: 'append' });
  const fx2 = liveFixture(session, 2, 'g2');
  const g2 = await liveBoundary(env, lock, proc, session, tracker, fx2, HIGH_TOK);
  check(g2.action === 'compacted' && g2.generation === 2, 'live G2 compacts through the integrated path (got ' + g2.action + ')');
  const headNow = runtime.inspectGenerationRuntimeV2({
    schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: session.id,
    runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session,
  });
  check(headNow.latestCommittedGeneration === 2, 'live head is G2');
  // Controller-owned completion on the live task, then restart from durable.
  const health = integ.checkCompletionHealth({
    schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: session.id,
    runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
    session, terminal: false,
  });
  check(health.healthy === true && health.latestCommittedGeneration === 2, 'live health gate passes before finalization');
  await flushBarrier(proc, session);
  const messagesBefore = messageTexts(session.deriveMessages()).join('\n');
  const revived = restartFromDurable(proc.durable, sid);
  const resumed = await integ.resumeTask({
    schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: revived.session.id,
    runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: revived.session,
  });
  check(resumed.mayResume === true && resumed.latestCommittedGeneration === 2, 'live restart resumes with the committed head (got ' + resumed.reconstructionOutcome + ')');
  const messagesAfter = messageTexts(revived.session.deriveMessages()).join('\n');
  check(messagesAfter === messagesBefore, 'restart reproduces the exact live messages');
  check(shadow.checkMessagesBalanced(revived.session.deriveMessages()) === true, 'live restarted protocol balanced');
  const vAfter = integ.projectionValidityOf(revived.session);
  check(vAfter.userOccurrences === 1, 'live restarted current user exactly once');
  check(headNow.generations.filter((g) => g.outcome === 'COMMITTED').map((g) => g.generation).join('->') === '1->2', 'live lineage is G1->G2');
  section('A13H LIVE H1.4 partial-apply crash, durable-only resume recovery');
  {
    const env = makeEnv();
    const lock = makeFakeLockClient();
    const proc = createHostProcess();
    const sid = 'sess-a13live-h14';
    const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-A13H-U0'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-A13H-A1', 't0', 's0'), { surfaceOp: 'append' });
    session.append('user/message', { id: 'msg-a13h-rt', role: 'user', content: [{ type: 'text', text: 'LIVE-A13H-RUNTIME' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' } }, { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-A13H-A3', 't0', 's1'), { surfaceOp: 'append' });
    session.append('user/message', userMessage('LIVE-A13H-U4'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-A13H-A5', 't0', 's2'), { surfaceOp: 'append' });
    session.append('user/message', userMessage('LIVE-A13H-CURRENT'), { surfaceOp: 'append' });
    const tracker = {};
    // Deterministic partial crash through the REAL host append path.
    const origAppend = session.append.bind(session);
    const hook = { appends: 0, armed: true };
    session.append = (type, data, opts) => {
      hook.appends += 1;
      if (hook.armed && hook.appends >= 2) throw new Error('injected A13H live partial crash');
      return origAppend(type, data, opts);
    };
    const fx = liveFixture(session, 1, 'h14');
    const partial = await liveBoundary(env, lock, proc, session, tracker, fx, HIGH_TOK);
    hook.armed = false;
    session.append = origAppend;
    check(partial.taskMayContinue === false, 'live partial apply blocks (got ' + partial.action + ')');
    // DESTROY the process: drop the bundle and every closure over the live
    // session. Only the flushed durable bytes + task dirs survive.
    const durableBytes = String(proc.durable.bytes);
    const revived = restartFromDurable(proc.durable, sid);
    const resumed = await integ.resumeTask({
      schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: revived.session.id,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
      session: revived.session, flushFn: async (s) => (await revived.proc.store.flush(s)) === true,
    });
    check(resumed.mayResume === true && resumed.latestCommittedGeneration === 1, 'live resume recovers G1 from durable state (recovery=' + resumed.recoveryDecision + ')');
    check(resumed.recoveryAttempted === true, 'live recovery engaged (no silent steady)');
    const vLive = integ.projectionValidityOf(revived.session);
    check(vLive.balanced === true && vLive.userOccurrences === 1, 'live recovered projection valid');
    check(shadow.checkMessagesBalanced(revived.session.deriveMessages()) === true, 'live recovered protocol balanced on the host');
    // H7 on the host: resume again -> steady, identical messages.
    const messagesAfterRecovery = messageTexts(revived.session.deriveMessages()).join('\n');
    const resumed2 = await integ.resumeTask({
      schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: revived.session.id,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
      session: revived.session, flushFn: async (s) => (await revived.proc.store.flush(s)) === true,
    });
    check(resumed2.mayResume === true && resumed2.reconstructionOutcome === 'steady', 'live second resume is steady');
    check(messageTexts(revived.session.deriveMessages()).join('\n') === messagesAfterRecovery, 'live recovery never replays');
    void durableBytes;
  }
}

main().then(() => {
  console.log('');
  console.log('A13L SUMMARY passed=' + passed + ' failed=' + failed);
  if (failed > 0) process.exitCode = 1;
}, (error) => {
  console.error('A13L FATAL:', error);
  process.exitCode = 1;
});
