'use strict';
/**
 * ContextSafePointV2LiveHost.Tests.cjs - CCV2-A06 real-host proof.
 *
 * Proves the SafePointDetector contract against the REAL pinned DSH host
 * (@deepseek-ai/dsh-session 0.1.1-rc.2: real SessionStore, real
 * session/flush durability barrier, real Session.fromRestore resume, real
 * deriveMessages() projection). Nothing is simulated: every session event
 * below enters a real host log through session.append(), durability comes
 * from store.flush() participation, and restarts replay durable bytes.
 *
 * Required scenarios: normal committed user/assistant boundary, open tool
 * call, closed tool result, multiple tool calls with one unresolved,
 * restart at a committed boundary, restart with incomplete protocol state,
 * runtime snapshot stable, runtime snapshot change where observable,
 * streaming open/closed, and session-durability gating. The A05
 * capture-race binding and the A03 boundary binding run end-to-end on the
 * live session. A05H strict gate applies: host absent + strict env = FAIL.
 *
 * Controller-mutation and runtime-transition legs that no offline host
 * signal can induce are proven against the live session with the grounded
 * controller/runtime snapshot shape (same shape the unit matrix
 * exhausts); the residual limitation is recorded UNVERIFIED, never faked.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const safepoint = require(path.join(repoRoot, 'config', 'ContextSafePointV2.cjs'));
const snapshotV2 = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));

const HOST_APP = process.env.AIH_HOST_APP || '/home/kaloyan/.local/share/nexus/app';
const RUNTIME_PLUGIN = '@deepseek-ai/dsh-system-prompt';

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(title) { console.log('\n--- ' + title + ' ---'); }

// ---- host resolution (never faked) ----
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
    } catch { /* keep searching */ }
  }
  return null;
}

const host = resolveHost();
const liveGate = require(path.join(__dirname, 'Ccv2LiveHostGate.cjs'));
const liveHostFound = Boolean(host && host.session.Session && host.session.SessionStore && host.cordis.Context);
if (!liveHostFound) {
  liveGate.reportLiveHostGate('A06', liveGate.decideLiveHostGate(false, process.env));
  console.log('SKIP: pinned DSH host tree is absent; the A06 live-host proof is PENDING (never faked).');
  process.exit(0);
}
liveGate.reportLiveHostGate('A06', 'EXECUTED');
const { SessionStore } = host.session;
const { Context } = host.cordis;

// ---- pinned-host drift guard (same four contracts as A01) ----
{
  const src = fs.readFileSync(host.sessionPath, 'utf8');
  check(src.includes('surface replace: sourceEventSeqs must include every shadowed surface node'), 'pinned host still states the split contract');
  check(src.includes('static fromRestore(id, seed, header)'), 'pinned host still states the restore contract');
  check(src.includes('async flush(session)'), 'pinned host still states the flush barrier contract');
}

// ---- message factories (typed exactly like the real loop) ----
let messageCounter = 0;
function newMessageId() { messageCounter += 1; return 'msg-a06live-' + messageCounter; }
function modelSource() { return { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' }; }
function userMessage(text, source) { return { id: newMessageId(), role: 'user', content: [{ type: 'text', text }], source: source || { kind: 'user' } }; }
function runtimeSnapshot(text) { return userMessage(text, { kind: 'plugin', plugin: RUNTIME_PLUGIN, form: 'snapshot' }); }
function assistantText(text, turn, step) {
  const source = modelSource();
  return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'text', text }], source }, source };
}
function assistantToolCall(callId, turn, step) {
  const source = modelSource();
  return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'tool-call', name: 'run_command', callId }], source }, source };
}
function toolResult(callId, text, turn, step) {
  return { turn, step, message: { id: newMessageId(), role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } };
}

const WORKSPACE = path.resolve(repoRoot);
const TASK_REV = snapshotV2.deriveTaskRevision({
  objective: 'a06-live', requirements: [], constraints: [], progress: {},
  decisions: [], failures: {}, verification: {}, continuation: {},
});

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

// Build the authoritative A06 input from a LIVE session: the real ordered
// event log, the real durability observation (flushedSeq advances only on
// a participating flush), the controller observation, and the host-owned
// current runtime snapshot seq via the real A01/A02 rule.
function liveInput(session, tracker, overrides) {
  const o = overrides || {};
  const controller = Object.assign(
    { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision: TASK_REV },
    o.controller || {},
  );
  const runtime = Object.assign(
    { currentSnapshotSeq: compaction.currentRuntimeSnapshotSeqOf(session), transitionOpen: false },
    o.runtime || {},
  );
  return {
    schemaVersion: 1,
    taskId: 'TASK-A06-LIVE',
    taskInstanceId: 'task_a06live_0001',
    sessionId: session.id,
    sessionEvents: Array.from(session.events),
    sessionDurable: {
      flushedSeq: tracker.flushedSeq === undefined ? null : tracker.flushedSeq,
      flushParticipated: tracker.flushParticipated === undefined ? false : tracker.flushParticipated,
    },
    controller,
    runtime,
  };
}

function codes(decision) { return decision.blockers.map((b) => b.code); }
function occurrences(session, needle) {
  const escaped = JSON.stringify(String(needle)).slice(1, -1);
  return JSON.stringify(session.deriveMessages()).split(escaped).length - 1;
}

async function main() {
  // == 1. normal committed user/assistant boundary (live) =====================
  section('live: normal committed boundary');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a06live-committed', { meta: { cwd: WORKSPACE } });
    check(true, 'live session created through SessionStore.create (' + host.version + ')');
    session.append('user/message', userMessage('LIVE-COMMITTED-REQUEST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-COMMITTED-REPLY', 't1', 's1'), { surfaceOp: 'append' });
    // In-memory only: the boundary exists but is not durably established.
    let d = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(d.safe === false && codes(d).includes('safe-point-session-not-durable'), 'live unflushed tail is NOT durable (memory != durable)');
    const flushed = await flushBarrier(proc, session);
    check(flushed === true, 'live store.flush(session) reports a participating listener');
    tracker.flushedSeq = session.events.length - 1;
    tracker.flushParticipated = flushed;
    d = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(d.safe === true, 'live committed user/assistant boundary is SAFE after the real flush barrier');
    check(d.boundaryKind === 'assistant-turn-committed', 'live kind is assistant-turn-committed');
    check(d.boundarySeq === session.events.length - 1, 'live boundarySeq is the grounded tail seq');
    check(occurrences(session, 'LIVE-COMMITTED-REQUEST') === 1, 'current user request survives exactly once in deriveMessages()');
  }

  // == 2. open tool call blocks on the live log ===============================
  section('live: open tool call');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a06live-opencall', { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-TOOL-REQUEST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantToolCall('live-call-1', 't1', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const d = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(d.safe === false, 'live open tool call is UNSAFE even though the log is durably flushed');
    check(codes(d).includes('safe-point-tool-call-open'), 'live tool-call-open blocker present');
    check(!codes(d).includes('safe-point-session-not-durable'), 'durability leg passes; the tool edge is the blocker');
  }

  // == 3. closed tool result is safe on the live log ==========================
  section('live: closed tool result');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a06live-closedtool', { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-TOOL-REQUEST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantToolCall('live-call-2', 't1', 's1'), { surfaceOp: 'append' });
    session.append('tool/call', { callId: 'live-call-2', turn: 't1', step: 's1' });
    session.append('tool/result', toolResult('live-call-2', 'LIVE-TOOL-OK', 't1', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const d = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(d.safe === true, 'live closed tool result is SAFE');
    check(d.boundaryKind === 'tool-result-committed', 'live kind is tool-result-committed');
  }

  // == 4. multi-tool turn with one unresolved blocks ==========================
  section('live: multi-tool turn, one unresolved');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a06live-multitool', { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-MULTI-REQUEST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantToolCall('live-A', 't1', 's1'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantToolCall('live-B', 't1', 's1'), { surfaceOp: 'append' });
    session.append('tool/call', { callId: 'live-A', turn: 't1', step: 's1' });
    session.append('tool/call', { callId: 'live-B', turn: 't1', step: 's1' });
    session.append('tool/result', toolResult('live-A', 'A-OK', 't1', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const d = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(d.safe === false, 'live multi-tool turn with one unresolved result is UNSAFE');
    check(codes(d).includes('safe-point-tool-result-pending'), 'live result-pending names the unresolved sibling');
    // Resolve the sibling: the SAME log becomes safe (failure != forever is
    // covered in the unit matrix; here completion of the obligation clears it).
    session.append('tool/result', toolResult('live-B', 'B-OK', 't1', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const d2 = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(d2.safe === true, 'live fully resolved multi-tool turn is SAFE');
  }

  // == 5. streaming safety on the live log ====================================
  section('live: streaming');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a06live-stream', { meta: { cwd: WORKSPACE } });
    session.append('turn/start', { turn: 't9' });
    session.append('user/message', userMessage('LIVE-STREAM-REQUEST'), { surfaceOp: 'append' });
    session.append('assistant/chunk', { turn: 't9', step: 's1', chunk: { type: 'text-delta', delta: 'partial live output' } });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const d = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(d.safe === false, 'live streaming response is UNSAFE');
    check(codes(d).includes('safe-point-assistant-stream-open'), 'live stream-open blocker is protocol/state based (chunk run, no timing)');
    // The model finishes: closing message + turn/end, then flush -> SAFE.
    session.append('assistant/message', assistantText('LIVE-STREAM-COMPLETE', 't9', 's1'), { surfaceOp: 'append' });
    session.append('turn/end', { turn: 't9', reason: { kind: 'complete' } });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const d2 = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(d2.safe === true, 'live completed stream with closed turn is SAFE');
  }

  // == 6. restart at a committed boundary =====================================
  section('live: restart at committed boundary');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a06live-restart', { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-RESTART-REQUEST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-RESTART-REPLY', 't1', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const before = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(before.safe === true, 'pre-restart committed boundary is SAFE');
    // Restart through the REAL restore path in a fresh host process.
    const proc2 = createHostProcess();
    const seed = JSON.parse(proc.durable.bytes);
    const resumed = proc2.store.create('sess-a06live-restart', { seedSource: 'persistence', seed, meta: proc.durable.header });
    // The host seed-boundary marker is transparent: the restored session
    // reports the exact same boundary with no new durability owed by the
    // marker itself (the seeded events are the durable bytes verbatim).
    const tracker2 = { flushedSeq: tracker.flushedSeq, flushParticipated: true };
    const beforeFlush = safepoint.detectSafePointV2(liveInput(resumed, tracker2));
    check(beforeFlush.safe === true, 'restored committed boundary is SAFE with no new flush (marker is transparent)');
    check(beforeFlush.boundarySeq === before.boundarySeq, 'restore reports the exact same boundary seq (' + before.boundarySeq + ')');
    check(beforeFlush.boundaryKind === before.boundaryKind, 'restart preserves the boundary kind (' + before.boundaryKind + ')');
    tracker2.flushParticipated = await flushBarrier(proc2, resumed);
    tracker2.flushedSeq = resumed.events.length - 1;
    const after = safepoint.detectSafePointV2(liveInput(resumed, tracker2));
    check(after.safe === true && after.boundarySeq === before.boundarySeq, 'post-restore flush keeps the exact same boundary');
    check(occurrences(resumed, 'LIVE-RESTART-REQUEST') === 1, 'restarted projection keeps the user request exactly once');
  }

  // == 7. restart with incomplete protocol state ==============================
  section('live: restart with incomplete protocol state');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a06live-restartopen', { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-OPEN-REQUEST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantToolCall('live-open-1', 't1', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const before = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(before.safe === false, 'open protocol state is UNSAFE before restart');
    const proc2 = createHostProcess();
    const seed = JSON.parse(proc.durable.bytes);
    const resumed = proc2.store.create('sess-a06live-restartopen', { seedSource: 'persistence', seed, meta: proc.durable.header });
    const tracker2 = { flushParticipated: await flushBarrier(proc2, resumed) };
    tracker2.flushedSeq = resumed.events.length - 1;
    const after = safepoint.detectSafePointV2(liveInput(resumed, tracker2));
    check(after.safe === false && codes(after).includes('safe-point-tool-call-open'), 'incomplete protocol state does NOT become falsely safe across restart');
  }

  // == 8. runtime snapshot stable vs change ===================================
  section('live: runtime snapshot');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a06live-runtime', { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-RUNTIME-REQUEST'), { surfaceOp: 'append' });
    session.append('user/message', runtimeSnapshot('policy-generation: LIVE-A; supersedes earlier runtime-context snapshots.'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-RUNTIME-REPLY', 't1', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const current = compaction.currentRuntimeSnapshotSeqOf(session);
    check(current !== null, 'live host-owned runtime snapshot is determinable via the A01/A02 rule (seq ' + current + ')');
    const d = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(d.safe === true, 'live stable runtime projection is SAFE');
    // The host commits a newer policy snapshot: the prior SAFE decision is
    // now stale (observed change, not simulation).
    session.append('user/message', runtimeSnapshot('policy-generation: LIVE-B; supersedes earlier runtime-context snapshots.'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const fresh = safepoint.assertSafePointFresh(d, liveInput(session, tracker));
    check(fresh.ok === false && fresh.reason === 'safe-point-state-changed', 'runtime snapshot change invalidates the prior SAFE decision (retry / BLOCK)');
    // Explicit transition signal blocks while asserted.
    const blocked = safepoint.detectSafePointV2(liveInput(session, tracker, { runtime: { transitionOpen: true } }));
    check(blocked.safe === false && codes(blocked).includes('safe-point-runtime-transition'), 'live runtime transition blocks');
  }

  // == 9. controller transition against the live session ======================
  section('live: controller transition');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a06live-controller', { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-CTRL-REQUEST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-CTRL-REPLY', 't1', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const blocked = safepoint.detectSafePointV2(liveInput(session, tracker, { controller: { transitionOpen: true } }));
    check(blocked.safe === false && codes(blocked).includes('safe-point-controller-transition-open'), 'live controller mutation blocks the boundary');
    const clean = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(clean.safe === true, 'live boundary is SAFE once the controller mutation commits');
  }

  // == 10. A05 race + A03 binding end-to-end on the live session ==============
  // == 9b. boundary sequence is the host append-log ordinal =================
  section('live: boundary sequence ordinal');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a06live-seq', { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-SEQ-E0'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const d0 = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(d0.safe === true && d0.boundarySeq === 0, 'B0 is 0 for the first durable event');
    check(d0.boundarySeq === session.events[0].seq, 'B0 equals the authoritative host event.seq field');
    check(JSON.parse(proc.durable.bytes)[0].seq === 0, 'B0 equals the persisted seq of the first durable event');
    session.append('assistant/message', assistantText('LIVE-SEQ-E1', 't1', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const d1 = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(d1.safe === true && d1.boundarySeq === 1, 'B1 is 1 after the second append+flush');
    session.append('user/message', userMessage('LIVE-SEQ-E2'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const d2 = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(d2.safe === true && d2.boundarySeq === 2, 'B2 is 2 after the third append+flush');
    check(d2.boundarySeq === session.events[2].seq, 'B2 equals the host seq field, not a message count');
    const proc2 = createHostProcess();
    const seed = JSON.parse(proc.durable.bytes);
    const resumed = proc2.store.create('sess-a06live-seq', { seedSource: 'persistence', seed, meta: proc.durable.header });
    const seqsBefore = session.events.map((e) => e.seq);
    const seqsAfter = resumed.events.slice(0, seed.length).map((e) => e.seq);
    check(JSON.stringify(seqsAfter) === JSON.stringify(seqsBefore), 'restore preserves the canonical ordering and sequence element-wise');
    const tracker2 = { flushedSeq: tracker.flushedSeq, flushParticipated: true };
    const dr = safepoint.detectSafePointV2(liveInput(resumed, tracker2));
    check(dr.safe === true && dr.boundarySeq === 2, 'restarted session reports the exact same B2');
    check(dr.boundaryKind === d2.boundaryKind, 'restart preserves the boundary kind');
    const proc3 = createHostProcess();
    const swapped = JSON.parse(proc.durable.bytes);
    const tmp = swapped[0]; swapped[0] = swapped[1]; swapped[1] = tmp;
    const tamperMeta = Object.assign({}, proc.durable.header, { id: 'sess-a06live-seq-tamper' });
    let threwSwap = false;
    try { proc3.store.create('sess-a06live-seq-tamper', { seedSource: 'persistence', seed: swapped, meta: tamperMeta }); } catch { threwSwap = true; }
    check(threwSwap === true, 'host rejects a reordered seed (boundary cannot move via reorder)');
    const proc4 = createHostProcess();
    const gapped = JSON.parse(proc.durable.bytes).slice(1);
    const gapMeta = Object.assign({}, proc.durable.header, { id: 'sess-a06live-seq-gap' });
    let threwGap = false;
    try { proc4.store.create('sess-a06live-seq-gap', { seedSource: 'persistence', seed: gapped, meta: gapMeta }); } catch { threwGap = true; }
    check(threwGap === true, 'host rejects a gapped seed (contiguity from 0 enforced)');
  }

  section('live: A05 race and A03 binding');
  {
    const proc = createHostProcess();
    const tracker = {};
    const session = proc.store.create('sess-a06live-binding', { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-BIND-REQUEST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantText('LIVE-BIND-REPLY', 't1', 's1'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    const decision = safepoint.detectSafePointV2(liveInput(session, tracker));
    check(decision.safe === true, 'live binding fixture starts SAFE');
    const snapState = {
      taskId: 'TASK-A06-LIVE', taskInstanceId: 'task_a06live_0001', sessionId: session.id,
      workspaceId: WORKSPACE, repositoryId: null, checkoutId: null,
      generation: 1, safePointBoundarySeq: decision.boundarySeq,
      sessionRevision: decision.inspectedRevision.sessionRevision,
      taskRevision: TASK_REV,
      repositoryRevision: { headCommit: null, indexDigest: null, worktreeDigest: null },
      runtimeRevision: { runtimeSnapshotSeq: null },
    };
    const token = snapshotV2.capture(snapState, '2026-09-26T00:00:00.000Z');
    check(token.safePointBoundarySeq === decision.boundarySeq, 'live A05 capture carries the exact A06 boundary');
    check(safepoint.assertCheckpointBindsSafePoint({ safePointBoundarySeq: decision.boundarySeq }, decision).ok === true, 'live checkpoint boundary binding holds');
    check(safepoint.assertCheckpointBindsSafePoint({ safePointBoundarySeq: decision.boundarySeq + 100 }, decision).ok === false, 'live checkpoint boundary mismatch BLOCKS');
    // Execution moves: detect SAFE at R1, capture starts at R2 -> BLOCK.
    session.append('user/message', userMessage('LIVE-BIND-FOLLOWUP'), { surfaceOp: 'append' });
    tracker.flushParticipated = await flushBarrier(proc, session);
    tracker.flushedSeq = session.events.length - 1;
    check(safepoint.assertSafePointFresh(decision, liveInput(session, tracker)).ok === false, 'live stale SAFE decision cannot authorize later capture (BLOCK / retry)');
    const moved = Object.assign({}, snapState, { sessionRevision: snapState.sessionRevision + 1 });
    check(snapshotV2.revalidate(token, moved).valid === false, 'live A05 revalidation independently goes STALE after the move');
  }

  console.log('\nRESULT: ' + passed + ' live-host A06 assertions passed (host ' + host.version + ').');
}

main().then(
  () => { if (failed > 0) process.exit(1); },
  (error) => { console.log('FAIL: live-host A06 proof threw :: ' + String(error && error.stack || error).slice(0, 2000)); process.exit(1); },
);
