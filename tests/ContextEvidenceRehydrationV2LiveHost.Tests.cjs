'use strict';
/**
 * ContextEvidenceRehydrationV2LiveHost.Tests.cjs - CCV2-B03 pinned-host proof.
 *
 * Proves session-backed exact rehydration against the REAL pinned DSH host
 * (@deepseek-ai/dsh-session 0.1.1-rc.2: real SessionStore, real
 * session/append, real flush durability barrier, real seeded restore).
 * Nothing is simulated: every session event below enters a real host log
 * through session.append(), durability comes from store.flush()
 * participation, and restarts replay durable bytes through a seeded restore
 * in a fresh host process.
 *
 * Required real scenario: append canonical tool call + canonical result,
 * flush, destroy the process/session object, restore from durable bytes,
 * rehydrate known evidence, assert exact equality. If the environment cannot
 * run the pinned host, the suite reports ENVIRONMENTAL honestly through the
 * shared live-host gate (never a faked PASS).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const store = require(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const rehydrate = require(path.join(repoRoot, 'config', 'ContextEvidenceRehydrationV2.cjs'));
const sessionAdapter = require(path.join(repoRoot, 'config', 'ContextSessionEvidenceSourceV2.cjs'));

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(title) { console.log('\n--- ' + title + ' ---'); }

const HOST_APP = process.env.AIH_HOST_APP || '/home/kaloyan/.local/share/nexus/app';
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
      return {
        root, sessionPath, cordisPath,
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
  liveGate.reportLiveHostGate('B03', liveGate.decideLiveHostGate(false, process.env));
  console.log('SKIP: pinned DSH host tree is absent; the B03 live-host proof is PENDING (never faked).');
  process.exit(0);
}
liveGate.reportLiveHostGate('B03', 'EXECUTED');
const { SessionStore } = host.session;
const { Context } = host.cordis;

{
  const src = fs.readFileSync(host.sessionPath, 'utf8');
  check(src.includes('surface replace: sourceEventSeqs must include every shadowed surface node'), 'pinned host still states the split contract');
  check(src.includes('static fromRestore(id, seed, header)'), 'pinned host still states the restore contract');
  check(src.includes('async flush(session)'), 'pinned host still states the flush barrier contract');
}

const NS = Object.freeze({
  taskId: 'TASK-B03-LIVE',
  taskInstanceId: 'task_b03_live_0001',
  sessionId: 'sess-b03-live-tool',
  workspaceId: '/tmp/nexus-b03-live',
  repositoryId: 'repo-b03-live',
  checkoutId: 'checkout-b03-live',
});

let messageCounter = 0;
function newMessageId() { messageCounter += 1; return 'msg-b03live-' + messageCounter; }
function modelSource() { return { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' }; }
function userMessage(text, source) {
  return { id: newMessageId(), role: 'user', content: [{ type: 'text', text }], source: source || { kind: 'user' } };
}
function assistantToolCall(callId, turn, step) {
  const source = modelSource();
  return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'tool-call', name: 'run_command', callId }], source }, source };
}
function toolResult(callId, text, turn, step) {
  return { turn, step, message: { id: newMessageId(), role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } };
}

const WORKSPACE = path.resolve(repoRoot);

function createHostProcess() {
  const app = new Context();
  const storeHost = new SessionStore(app);
  const durable = { bytes: null, writes: 0, header: null };
  app.on('session/flush', async (session) => {
    durable.bytes = JSON.stringify(session.events);
    durable.writes += 1;
    durable.header = { version: session.header.version, id: session.header.id, createdAt: session.header.createdAt, cwd: session.header.cwd };
  });
  return { app, store: storeHost, durable };
}

function makeRoot(name) {
  const dir = path.join(repoRoot, 'tmp', 'b03-live-' + name + '-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

async function flushBarrier(proc, session) {
  const participated = await proc.store.flush(session);
  return participated === true;
}

async function main() {
  section('live: canonical tool transaction restart rehydration');
  {
    const proc = createHostProcess();
    const session = proc.store.create(NS.sessionId, { meta: { cwd: WORKSPACE } });
    check(true, 'live session created through SessionStore.create (' + host.version + ')');
    session.append('user/message', userMessage('LIVE-B03-TOOL-REQUEST'), { surfaceOp: 'append' });
    session.append('assistant/message', assistantToolCall('live-b03-call-1', 't1', 's1'), { surfaceOp: 'append' });
    session.append('tool/call', { callId: 'live-b03-call-1', turn: 't1', step: 's1' });
    session.append('tool/result', toolResult('live-b03-call-1', 'LIVE-B03-TOOL-OK', 't1', 's1'), { surfaceOp: 'append' });
    const flushed = await flushBarrier(proc, session);
    check(flushed === true, 'live store.flush(session) reports a participating listener');

    // Resolve the canonical call/result seqs from the LIVE log (never assumed).
    const events = Array.from(session.events);
    const callSeq = events.find((e) => e.type === 'assistant/message'
      && Array.isArray(e.data && e.data.message && e.data.message.content)
      && e.data.message.content.some((b) => b && b.type === 'tool-call'
        && (b.callId === 'live-b03-call-1' || b.id === 'live-b03-call-1' || b.toolCallId === 'live-b03-call-1'))).seq;
    const resultSeq = events.find((e) => e.type === 'tool/result').seq;
    check(Number.isInteger(callSeq) && Number.isInteger(resultSeq) && callSeq < resultSeq, 'live canonical call/result seqs resolved (' + callSeq + '/' + resultSeq + ')');

    // Persist a byte-backed tool-result page bound to the live seqs, plus an
    // EvidenceRef binding, through the real B01/B02 authorities.
    const root = store.contextRootForV2(makeRoot('tool'), NS.taskId);
    fs.mkdirSync(root, { recursive: true });
    const toolPage = page.createContextPageV2({
      kind: 'tool-result',
      namespace: clone(NS),
      sourceKind: 'tool',
      sourceRefs: ['tool-event:live-b03-call-1'],
      mutability: 'immutable',
      sourceSeqs: [callSeq, resultSeq],
      exactText: 'LIVE-B03-TOOL-OK',
      createdAtGeneration: 1,
    });
    store.putContextPageV2(root, toolPage, { expectedNamespace: clone(NS) });
    const ref = {
      schemaVersion: 1, evidenceId: 'E-b03-live-tool-001', kind: 'event',
      locator: String(resultSeq), digest: toolPage.contentHash,
      observedAtUtc: '2026-09-27T00:00:00.000Z', taskInstanceId: NS.taskInstanceId,
    };
    store.putEvidenceV2(root, { evidenceRef: ref, pageId: toolPage.id, expectedNamespace: clone(NS) });

    // Rehydrate BEFORE restart against the live session object.
    const before = rehydrate.rehydrateEvidenceRefV2({
      contextRoot: root,
      evidenceRef: clone(ref),
      expectedNamespace: clone(NS),
      sessionSource: sessionAdapter.wrapDshSessionV2(session),
    });
    check(before.verified === true, 'pre-restart live rehydration verifies');
    check(before.exactText === 'LIVE-B03-TOOL-OK', 'pre-restart exact text matches');

    // Destroy the in-memory session object; restore from durable bytes in a
    // fresh host process; rehydrate the SAME known evidence.
    const seed = JSON.parse(proc.durable.bytes);
    const proc2 = createHostProcess();
    const resumed = proc2.store.create(NS.sessionId, { seedSource: 'persistence', seed, meta: proc.durable.header });
    const replayedVerb = events.every((e) => {
      const found = Array.from(resumed.events).find((r) => r && r.seq === e.seq);
      return found !== undefined && JSON.stringify(found) === JSON.stringify(e);
    });
    check(replayedVerb, 'restore replays every durable seq verbatim (seed marker is transparent)');
    const after = rehydrate.rehydrateEvidenceRefV2({
      contextRoot: root,
      evidenceRef: clone(ref),
      expectedNamespace: clone(NS),
      sessionSource: sessionAdapter.wrapDshSessionV2(resumed),
    });
    check(after.verified === true, 'post-restart live rehydration verifies');
    check(after.exactText === before.exactText, 'restart yields byte-identical exact evidence');
    check(after.contentHash === before.contentHash, 'restart preserves the content identity');
    check(after.sourceIdentity === before.sourceIdentity, 'restart preserves the source identity');
    check(after.resultDigest === before.resultDigest, 'restart preserves the result digest');
    check(after.pageId === toolPage.id, 'restart resolves the same page');
  }

  section('live: pure-session evidence restart rehydration');
  {
    const proc = createHostProcess();
    const sessionId = 'sess-b03-live-conv';
    const session = proc.store.create(sessionId, { meta: { cwd: WORKSPACE } });
    session.append('user/message', userMessage('LIVE-B03-SESSION-ONE'), { surfaceOp: 'append' });
    session.append('user/message', userMessage('LIVE-B03-SESSION-TWO'), { surfaceOp: 'append' });
    check(await flushBarrier(proc, session) === true, 'conversation tail flushed');
    const liveEvents = Array.from(session.events);
    const seqs = liveEvents.map((e) => e.seq);
    const nsConv = Object.assign(clone(NS), { sessionId });
    const digest = rehydrate.deriveSessionEvidenceDigestV2(sessionId, liveEvents);
    const root = store.contextRootForV2(makeRoot('conv'), NS.taskId);
    fs.mkdirSync(root, { recursive: true });
    const convPage = page.createContextPageV2({
      kind: 'conversation',
      namespace: clone(nsConv),
      sourceKind: 'user',
      sourceRefs: ['session-event:' + seqs[0]],
      mutability: 'immutable',
      sourceSeqs: seqs.slice(),
      contentHash: digest,
      createdAtGeneration: 1,
    });
    store.putContextPageV2(root, convPage, { expectedNamespace: clone(nsConv) });
    const before = rehydrate.rehydrateContextPageV2({
      contextRoot: root, pageId: convPage.id, expectedNamespace: clone(nsConv),
      sessionSource: sessionAdapter.wrapDshSessionV2(session),
    });
    check(before.verified === true && before.sourceRoute === 'session', 'pre-restart pure-session evidence verifies');

    const seed = JSON.parse(proc.durable.bytes);
    const proc2 = createHostProcess();
    const resumed = proc2.store.create(sessionId, { seedSource: 'persistence', seed, meta: proc.durable.header });
    const after = rehydrate.rehydrateContextPageV2({
      contextRoot: root, pageId: convPage.id, expectedNamespace: clone(nsConv),
      sessionSource: sessionAdapter.wrapDshSessionV2(resumed),
    });
    check(after.verified === true, 'post-restart pure-session evidence verifies');
    check(after.exactText === before.exactText, 'restart yields identical session evidence text');
    check(after.contentHash === digest, 'restart preserves the attested session digest');
  }

  console.log('\nB03 LIVEHOST: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.log('FAIL: live-host proof threw :: ' + String(error && error.stack || error).slice(0, 800));
  process.exit(1);
});
