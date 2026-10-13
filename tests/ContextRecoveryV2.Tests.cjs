'use strict';
/**
 * ContextRecoveryV2.Tests.cjs - CCV2-A12 crash/concurrency/recovery hardening.
 *
 * Adversarial validation campaign for the frozen A01-A11H runtime: deterministic
 * fault injection at every durable transition, crash matrices for reservation /
 * checkpoint / operation / head / supersession persistence, lock lifecycle,
 * segment application, flush ambiguity, post-verify loss, fully-landed recovery
 * classification (A12-1: fully-landed-but-head-missing is UNRESOLVED
 * commit-pending-verification until session-verified repair establishes
 * recovered-completion evidence; segment presence alone NEVER advances the
 * head), lost-A10-result reconstruction, bad-projection fail-closed,
 * supersede/apply and reserve/recover races (single-process ordering proof;
 * true OS-process proof lives in ContextRecoveryV2XProc), stale-handle matrix,
 * full restart-state matrix, multi-generation crash chain, repeated-restart
 * convergence, duplicate-surface proof, global invariants (current-user-once,
 * balanced protocol, shadow==actual, required-state survival, raw-log
 * append-only), corrupt/missing/conflicting artifact campaigns, timestamp
 * irrelevance, security inertness, secret safety, determinism/bounded
 * convergence.
 *
 * No A13 integration, no policy changes, no new projection semantics.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runtime = require(path.join(repoRoot, 'config', 'ContextGenerationRuntimeV2.cjs'));
const active = require(path.join(repoRoot, 'config', 'ContextActiveApplyV2.cjs'));
const shadow = require(path.join(repoRoot, 'config', 'ContextShadowV2.cjs'));
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));
const snapshotV2 = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const checkpointV2 = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const trustV2 = require(path.join(repoRoot, 'config', 'ContextTrustV2.cjs'));
const fault = require(path.join(repoRoot, 'config', 'ContextRecoveryFaultV2.cjs'));
const a10builders = require(path.join(__dirname, 'ContextActiveApplyV2.Tests.cjs'));

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(t) { console.log(''); console.log('--- ' + t + ' ---'); }
const clone = (o) => JSON.parse(JSON.stringify(o));
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

const TASK_ID = 'TASK-A12';
const TASK_INSTANCE = 'task_a12_0001';
const SESSION_ID = 'sess-a12';

function makeEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a12-'));
  return {
    base,
    runtimeDir: path.join(base, 'runtime'),
    checkpointDir: path.join(base, 'checkpoints'),
    operationRoot: path.join(base, 'operations'),
    lockWorkspace: path.join(base, 'ledger'),
  };
}
function makeLock() { return a10builders.makeFakeLockClient(); }
function bind(env, lock) {
  return {
    schemaVersion: 1,
    taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
    runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
    serialization: lock || makeLock(), lockWorkspace: env.lockWorkspace,
  };
}
function inspectOf(env, session, repairHead) {
  return runtime.reconstructGenerationRuntimeV2({
    schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
    runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
    session: session === undefined ? null : session,
    repairHead: repairHead === undefined ? false : repairHead,
  });
}
async function expectFail(promise, fragment, name) {
  try { await promise; }
  catch (error) {
    const message = String((error && error.message) || error);
    check(message.indexOf(fragment) !== -1, name, 'expected [' + fragment + '] got [' + message.slice(0, 220) + ']');
    return message;
  }
  check(false, name, 'expected failure containing [' + fragment + '] but the call succeeded');
  return null;
}
function expectThrowSync(fn, fragment, name) {
  try { fn(); }
  catch (error) {
    const message = String((error && error.message) || error);
    check(message.indexOf(fragment) !== -1, name, 'expected [' + fragment + '] got [' + message.slice(0, 220) + ']');
    return message;
  }
  check(false, name, 'expected failure containing [' + fragment + '] but the call succeeded');
  return null;
}

// ---- A12 fixture (A11 multi shape, A12 task binding) ---------------------------
let a12EvCounter = 0;
function a12EvUser(text, source) { a12EvCounter += 1; return { type: 'user/message', data: { id: 'msg-a12-' + a12EvCounter, role: 'user', content: [{ type: 'text', text }], source: source || { kind: 'user' } } }; }
function a12EvAssistant(text) { a12EvCounter += 1; return { type: 'assistant/message', data: { turn: 't1', step: 's1', message: { id: 'msg-a12-' + a12EvCounter, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } } }; }
function a12EvRuntime(text) { return a12EvUser(text, { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }); }
function a12Seqify(events) { return events.map((e, i) => Object.assign({}, e, { seq: i })); }

function buildFx(session, generation, parentCheckpointId, opts) {
  a12EvCounter = 0;
  const seedEvents = a12Seqify([a12EvUser('u0'), a12EvAssistant('a1'), a12EvRuntime('RUNTIME-POLICY-A'), a12EvUser('u3'), a12EvAssistant('a4'), a12EvUser('u5'), a12EvAssistant('a6'), a12EvUser('u7-current')]);
  const withMarker = opts && opts.midLogMarker === true;
  if (withMarker) {
    // A12-4 shape: a host-only restore marker sits mid-log (a restart
    // happened, then later work arrived). Units skip the marker seq.
    seedEvents.splice(5, 0, { seq: -1, type: 'session/end-seed', time: 1, data: {} });
    seedEvents.forEach((e, i) => { e.seq = i; });
  }
  session.events = clone(seedEvents);
  // Markers are never surfaced by the host.
  session.surface.nodes = seedEvents.filter((e) => e.type !== 'session/end-seed').map((e) => e.seq);
  const events = clone(session.events);
  const surface = session.surface.nodes.slice();
  const boundary = 4;
  const U = a10builders.U;
  const shift = withMarker ? 1 : 0;
  const units = [
    U('u-hist-1', 0, 1, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }),
    U('u-runtime', 2, 2, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 500, method: 'provider-tokenizer', exact: true } }),
    U('u-mid', 3, 4, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }),
    // Marker shape: the unit range covers the marker seq (contiguous tiling
    // is required); planning treats the neutral marker as non-payload bulk.
    U('u-req-new', 5, 6 + shift, { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }),
    U('u-user', 7 + shift, 7 + shift, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } }),
  ];
  const over = { taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, workspaceId: '/tmp/nexus-a12', generation };
  const ts0 = a10builders.draftTaskState(boundary, boundary, over);
  ts0.evidenceRefs = ts0.evidenceRefs.map((e) => Object.assign({}, e, { taskInstanceId: TASK_INSTANCE }));
  const ts = a10builders.finalizeTs(ts0);
  const snapInput = a10builders.snapInputOf(ts);
  const token = snapshotV2.capture(snapInput, a10builders.CREATED);
  const safe = a10builders.safeDecisionFor(ts);
  const gate = require(path.join(repoRoot, 'config', 'ContextCheckpointabilityV2.cjs'));
  const g = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safe, snapshotToken: token });
  const p = a10builders.pressureFor(token, 100000);
  const retention = require(path.join(repoRoot, 'config', 'ContextRetentionV2.cjs'));
  const plan = retention.planRetentionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, boundaryContext: a10builders.boundaryCtx(events, ts.taskRevision), contextUnits: units, protocolSpans: [] });
  const result = shadow.evaluateShadowCompactionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId, snapshotToken: token, snapshotCurrentState: snapInput, safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, retentionPlan: plan, taskState: ts, contextUnits: units, sessionEvents: events, surfaceNodes: surface, protocolSpans: [], createdAtUtc: a10builders.CREATED, sealedAtUtc: a10builders.CREATED });
  assert.equal(result.verdict, 'shadow-ready', 'fx must be shadow-ready, got ' + result.verdict + ' ' + JSON.stringify(result.blockers).slice(0, 300));
  const sealed = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId, safePointBoundarySeq: safe.boundarySeq, snapshotToken: token, taskState: ts, createdAtUtc: a10builders.CREATED, sealedAtUtc: a10builders.CREATED });
  const artifact = shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, sealedCheckpoint: sealed.sealedCheckpoint, retentionPlan: plan, snapshotToken: token, taskState: ts, contextUnits: units, sourceEvents: events, surfaceNodes: surface, protocolSpans: [] });
  assert.equal(artifact.projectionDigest, result.projection.projectionDigest, 'fx artifact binds the shadow digest');
  return { ts, token, safe, g, p, plan, units, events, surface, result, sealed: sealed.sealedCheckpoint, artifact };
}
// Chained fixture: preserves the live session (prior landings stay surfaced),
// builds the next generation over current events like A11 buildChainedFixture.
function buildFxChained(session, generation, parentCheckpointId) {
  a12EvCounter = 0;
  const events = clone(session.events);
  const surface = session.surface.nodes.slice();
  const boundary = events.length - 1;
  const U = a10builders.U;
  const last = events.length - 1;
  const units = [
    U('u-hist', 0, Math.max(0, last - 3), { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 6000, method: 'provider-tokenizer', exact: true } }),
    U('u-new', Math.max(0, last - 2), Math.max(0, last - 1), { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }),
    U('u-user', last, last, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } }),
  ];
  const over = { taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, workspaceId: '/tmp/nexus-a12', generation };
  const ts0 = a10builders.draftTaskState(boundary, boundary, over);
  ts0.requirements = [{ id: 'R1', text: 'Carry the A12 chain forward (G' + generation + ').', status: 'active', evidenceRefs: ['ev-cmd-1'], sourceKind: 'controller' }];
  ts0.evidenceRefs = ts0.evidenceRefs.map((e) => Object.assign({}, e, { taskInstanceId: TASK_INSTANCE }));
  ts0.continuation = { nextAction: 'Continue the A12 chain (G' + generation + ').', unresolvedQuestions: [], recentUserIntent: 'Advance G' + generation + '.' };
  const ts = a10builders.finalizeTs(ts0);
  const snapInput = a10builders.snapInputOf(ts);
  const token = snapshotV2.capture(snapInput, a10builders.CREATED);
  const safe = a10builders.safeDecisionFor(ts);
  const gate = require(path.join(repoRoot, 'config', 'ContextCheckpointabilityV2.cjs'));
  const g = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safe, snapshotToken: token });
  const p = a10builders.pressureFor(token, 100000);
  const retention = require(path.join(repoRoot, 'config', 'ContextRetentionV2.cjs'));
  const plan = retention.planRetentionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, boundaryContext: a10builders.boundaryCtx(events, ts.taskRevision), contextUnits: units, protocolSpans: [] });
  const result = shadow.evaluateShadowCompactionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId, snapshotToken: token, snapshotCurrentState: snapInput, safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, retentionPlan: plan, taskState: ts, contextUnits: units, sessionEvents: events, surfaceNodes: surface, protocolSpans: [], createdAtUtc: a10builders.CREATED, sealedAtUtc: a10builders.CREATED });
  assert.equal(result.verdict, 'shadow-ready', 'chained fx must be shadow-ready, got ' + result.verdict + ' ' + JSON.stringify(result.blockers).slice(0, 300));
  const sealed = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId, safePointBoundarySeq: safe.boundarySeq, snapshotToken: token, taskState: ts, createdAtUtc: a10builders.CREATED, sealedAtUtc: a10builders.CREATED });
  const artifact = shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, sealedCheckpoint: sealed.sealedCheckpoint, retentionPlan: plan, snapshotToken: token, taskState: ts, contextUnits: units, sourceEvents: events, surfaceNodes: surface, protocolSpans: [] });
  assert.equal(artifact.projectionDigest, result.projection.projectionDigest, 'chained artifact binds the shadow digest');
  return { ts, token, safe, g, p, plan, units, events, surface, result, sealed: sealed.sealedCheckpoint, artifact };
}
function payloadTextOf(sealed) { return shadow.checkpointPayloadTextOf(sealed); }
function freezeIntentOnly(env, fx, generation) {
  const sealedSerialized = checkpointV2.serializeCheckpointCanonical(fx.sealed);
  trustV2.persistSealedCheckpointV2(env.checkpointDir, { checkpoint: clone(fx.sealed), serialized: sealedSerialized });
  const unioned = [];
  for (const seg of fx.artifact.segments) for (const seq of seg.sourceEventSeqs) unioned.push(seq);
  unioned.sort((a, b) => a - b);
  const draft = {
    schemaVersion: 2,
    operationId: fx.artifact.operationId,
    attemptId: 'att_' + sha256('nexus/context-active-apply-attempt/v1' + String.fromCharCode(10) + String(fx.artifact.operationId)).slice(0, 24),
    taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
    workspace: '/tmp/nexus-a12', repositoryId: null, checkoutId: null,
    checkpointGeneration: generation,
    checkpointId: fx.result.checkpoint.checkpointId,
    checkpointContentDigest: fx.result.checkpoint.checkpointContentDigest,
    checkpointPath: null,
    snapshotTokenId: fx.token.snapshotTokenId,
    safePointBoundarySeq: fx.safe.boundarySeq,
    sourceEventSeqs: unioned,
    segments: clone(fx.artifact.segments),
    lifecycle: 'frozen',
  };
  const expected = { taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, workspace: '/tmp/nexus-a12', repositoryId: null, checkoutId: null, checkpointGeneration: generation, checkpointId: fx.result.checkpoint.checkpointId };
  return compaction.freezeCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, generation), draft, expected);
}
function applyInputForGen(fx, session, dirs, lock, generation) {
  return {
    schemaVersion: 1,
    taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, generation,
    shadowResult: fx.result, sealedCheckpoint: fx.sealed, projectionArtifact: fx.artifact,
    snapshotToken: fx.token, snapshotCurrentState: a10builders.snapInputOf(fx.ts),
    safePointDecision: fx.safe, checkpointabilityDecision: fx.g, pressureDecision: fx.p,
    retentionPlan: fx.plan, taskState: fx.ts, contextUnits: fx.units, protocolSpans: [],
    session,
    checkpointDir: dirs.checkpointDir,
    operationDir: runtime.operationDirForGenerationV2(dirs.operationRoot, generation),
    flushFn: async () => true,
    serialization: lock,
  };
}
function appendWork(session, n, tag) {
  for (let i = 0; i < n; i += 1) {
    const seqU = session.events.length;
    session.events.push({ seq: seqU, type: 'user/message', data: { id: 'msg-a12-w' + seqU, role: 'user', content: [{ type: 'text', text: (tag || 'A12-NEW-WORK-') + seqU }], source: { kind: 'user' } } });
    session.surface.nodes.push(seqU);
    const seqA = session.events.length;
    session.events.push({ seq: seqA, type: 'assistant/message', data: { turn: 't9', step: 's9', message: { id: 'msg-a12-w' + seqA, role: 'assistant', content: [{ type: 'text', text: (tag || 'A12-NEW-REPLY-') + seqA }], source: { kind: 'model' } } } });
    session.surface.nodes.push(seqA);
  }
  const seqC = session.events.length;
  session.events.push({ seq: seqC, type: 'user/message', data: { id: 'msg-a12-w' + seqC, role: 'user', content: [{ type: 'text', text: (tag || 'A12-CURRENT-') + seqC }], source: { kind: 'user' } } });
  session.surface.nodes.push(seqC);
}

// ---- shared global-invariant assertions (used by EVERY scenario) ----------------
function messageTextsOf(session) {
  const texts = [];
  const walk = (value) => {
    if (typeof value === 'string') { texts.push(value); return; }
    if (Array.isArray(value)) { for (const entry of value) walk(entry); return; }
    if (value !== null && typeof value === 'object') {
      if (typeof value.text === 'string' && value.type === 'text') texts.push(value.text);
      else { for (const key of Object.keys(value)) { if (key !== 'id') walk(value[key]); } }
    }
  };
  for (const message of session.deriveMessages() || []) walk(message);
  return texts;
}
function currentUserTextOf(session) {
  // The live current request is the last user-role event's text (compaction
  // consumes older history; the invariant tracks the CURRENT request).
  for (let i = session.events.length - 1; i >= 0; i -= 1) {
    const ev = session.events[i];
    try {
      const content = ev && ev.data && (ev.data.content || (ev.data.message && ev.data.message.content));
      const role = (ev && ev.data && (ev.data.role || (ev.data.message && ev.data.message.role))) || '';
      if (role === 'user' && Array.isArray(content)) {
        const text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
        if (text !== '') return text;
      }
    } catch { /* keep scanning */ }
  }
  return null;
}
function assertCurrentUserOnce(session, name) {
  const marker = currentUserTextOf(session);
  check(marker !== null, name + ' (a current user request exists)');
  if (marker === null) return;
  const texts = messageTextsOf(session).join('\n');
  const occurrences = texts.split(marker).length - 1;
  check(occurrences === 1, name + ' (current user exactly once, got ' + occurrences + ')');
}
function assertProtocolBalanced(session, name) {
  check(shadow.checkMessagesBalanced(session.deriveMessages()) === true, name + ' (protocol balanced)');
}
function assertNoDuplicateSurface(session, operation, sealed, name) {
  const texts = messageTextsOf(session).join('\n');
  const countOf = (needle) => (needle === null || needle === undefined || needle === '') ? 0 : texts.split(String(needle)).length - 1;
  // Segment identity is the duplication invariant (the operation id is
  // additionally cited in event source metadata by design, so it is not
  // counted here): exactly one payload text and exactly one anchor text
  // per non-payload segment index.
  const payloadText = payloadTextOf(sealed);
  check(countOf(payloadText) <= 1, name + ' (payload multiplicity<=1, got ' + countOf(payloadText) + ')');
  const count = operation.segments.length;
  for (let index = 0; index < count; index += 1) {
    if (operation.segments[index] && operation.segments[index].role === 'payload') continue;
    const anchor = compaction.buildContinuationAnchorText(operation.operationId, operation.checkpointGeneration, index, count);
    check(countOf(anchor) <= 1, name + ' (anchor[' + index + '] multiplicity<=1, got ' + countOf(anchor) + ')');
  }
}
function assertRawLogAppendOnly(beforeLen, session, name) {
  check(session.events.length >= beforeLen, name + ' (raw log never shrinks: ' + beforeLen + ' -> ' + session.events.length + ')');
  for (let i = 0; i < session.events.length; i += 1) check(session.events[i].seq === i, name + ' (positional log seq ' + i + ')');
}

async function main() {
  section('A12 FAULT REGISTRY: named points, single-shot, disarm');
  {
    fault.disarmAllFaultsV2();
    check(fault.armedFaultsV2().length === 0, 'registry starts disarmed');
    fault.armFaultV2('reservation:before-temp-write', 'throw');
    let fired = false;
    try { fault.maybeFaultV2('reservation:before-temp-write'); } catch (e) { fired = String(e.message).indexOf('ccv2-fault-injected:') === 0; }
    check(fired, 'armed throw fault fires at the named point');
    check(fault.maybeFaultV2('reservation:before-temp-write') === null, 'single-shot fault fires exactly once');
    fault.armFaultV2('head:after-rename', 'simulated-process-loss', { persistent: true });
    let lost = false;
    try { fault.maybeFaultV2('head:after-rename'); } catch (e) { lost = fault.isProcessLostV2(e); }
    check(lost, 'simulated process loss throws ProcessLost');
    check(fault.isFaultInjectedV2(new Error('ccv2-fault-injected:x')), 'injected errors are recognizable');
    expectThrowSync(() => fault.armFaultV2('nope:nowhere', 'throw'), 'unknown point', 'unknown fault point fails closed');
    expectThrowSync(() => fault.armFaultV2('reservation:before-temp-write', 'nap'), 'unknown mode', 'unknown fault mode fails closed');
    fault.disarmAllFaultsV2();
    check(fault.maybeFaultV2('head:after-rename') === null, 'disarm restores zero production behavior change');
  }

  section('A12 RESERVATION CRASH MATRIX (throw + process-loss at every boundary)');
  {
    const points = ['reservation:before-temp-write', 'reservation:after-temp-write', 'reservation:before-rename', 'reservation:after-rename', 'reservation:before-read-back', 'reservation:after-read-back-before-return'];
    for (const point of points) {
      for (const mode of ['throw', 'simulated-process-loss']) {
        const env = makeEnv();
        const lock = makeLock();
        const b = bind(env, lock);
        const sess = a10builders.makeSessionDouble([], []);
        const fx = buildFx(sess, 1, null);
        fault.armFaultV2(point, mode);
        let faultSeen = false;
        try {
          await runtime.reserveNextGenerationV2(Object.assign({}, b, {
            revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
          }));
        } catch (e) { faultSeen = fault.isFaultInjectedV2(e); }
        check(faultSeen, 'reserve fault fires at ' + point + ' [' + mode + ']');
        fault.disarmAllFaultsV2();
        // Restart: either no reservation or exactly one valid reservation.
        const st = inspectOf(env, null, false);
        const resFile = path.join(env.runtimeDir, 'generations', 'generation-000001', 'reservation.json');
        const exists = fs.existsSync(resFile);
        if (exists) {
          const back = runtime.readReservationV2(env.runtimeDir, 1, { taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID });
          check(back !== null && back.generation === 1, 'half-valid reservation never survives at ' + point);
          check(st.highestAllocatedGeneration >= 0, 'restart converges with reservation at ' + point);
        } else {
          check(st.highestAllocatedGeneration === 0, 'restart converges to no-reservation at ' + point);
        }
        // Retry converges: reservation succeeds exactly once, identity never reused.
        const r1 = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
          revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
        }));
        check(r1.generation === 1, 'retry converges to G1 at ' + point + ' [' + mode + ']');
        const r2 = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
          revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
        }));
        check(r2.reservationDigest === r1.reservationDigest, 'identical retry is idempotent at ' + point);
        await expectFail(runtime.reserveNextGenerationV2(Object.assign({}, b, {
          revisionDigest: sha256('different-source'), snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
        })), 'generation-reservation-conflict', 'different source never rebinds G1 at ' + point);
      }
    }
    // Stale temp leftovers are ignored by recovery (never half-valid).
    {
      const env = makeEnv();
      const b = bind(makeLock() && env, makeLock());
      const sess = a10builders.makeSessionDouble([], []);
      const fx = buildFx(sess, 1, null);
      await runtime.reserveNextGenerationV2(Object.assign({}, b, {
        revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
      }));
      const dir = path.join(env.runtimeDir, 'generations', 'generation-000001');
      fs.writeFileSync(path.join(dir, 'reservation.json.tmp-999-12345'), '{"half":true}');
      const st = inspectOf(env, null, false);
      check(st.highestAllocatedGeneration === 1, 'stale temp files never shadow the valid reservation');
    }
  }

  section('A12 HEAD CRASH MATRIX (head write fails closed, read-back enforced)');
  {
    const points = ['head:before-temp-write', 'head:after-temp-write', 'head:before-rename', 'head:after-rename', 'head:before-read-back', 'head:after-read-back-before-return'];
    for (const point of points) {
      const env = makeEnv();
      const lock = makeLock();
      const b = bind(env, lock);
      const sess = a10builders.makeSessionDouble([], []);
      const fx = buildFx(sess, 1, null);
      fault.armFaultV2(point, 'throw');
      let faultSeen = false;
      try {
        await runtime.reserveNextGenerationV2(Object.assign({}, b, {
          revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
        }));
      } catch (e) { faultSeen = fault.isFaultInjectedV2(e); }
      fault.disarmAllFaultsV2();
      // Head write happens inside reserve (highest-allocated tracking): the
      // fault either prevented both writes or failed after the reservation.
      // Either way restart converges to a unique state and retry converges.
      const st = inspectOf(env, null, false);
      check(st.highestAllocatedGeneration === 0 || st.highestAllocatedGeneration === 1, 'head crash converges uniquely at ' + point + ' (got ' + st.highestAllocatedGeneration + ')');
      const r1 = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
        revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
      }));
      check(r1.generation === 1, 'retry converges after head crash at ' + point);
      check(faultSeen || st.highestAllocatedGeneration === 1, 'fault attribution holds at ' + point);
    }
    // Same checkpoint id + conflicting bytes fails closed.
    {
      const env = makeEnv();
      const lock = makeLock();
      const b = bind(env, lock);
      const sess = a10builders.makeSessionDouble([], []);
      const fx = buildFx(sess, 1, null);
      await runtime.reserveNextGenerationV2(Object.assign({}, b, {
        revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
      }));
      freezeIntentOnly(env, fx, 1);
      const files = fs.readdirSync(env.checkpointDir).filter((f) => f.indexOf('cp-') === 0);
      check(files.length === 1, 'one checkpoint file per generation');
      const cpPath = path.join(env.checkpointDir, files[0]);
      const parsed = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
      parsed.requirements.push({ id: 'RX', text: 'Tampered.', status: 'active', evidenceRefs: [], sourceKind: 'controller' });
      fs.writeFileSync(cpPath, JSON.stringify(parsed));
      expectThrowSync(() => inspectOf(env, null, false), 'generation-runtime-corrupt', 'conflicting checkpoint bytes fail closed');
    }
  }

  section('A12 SUPERSESSION PERSISTENCE CRASH (never half-superseded)');
  {
    const points = ['supersession:before-temp-write', 'supersession:after-temp-write', 'supersession:before-rename', 'supersession:after-rename', 'supersession:before-read-back', 'supersession:after-read-back-before-return'];
    for (const point of points) {
      const env = makeEnv();
      const lock = makeLock();
      const b = bind(env, lock);
      const sess = a10builders.makeSessionDouble([], []);
      const fx = buildFx(sess, 1, null);
      await runtime.reserveNextGenerationV2(Object.assign({}, b, {
        revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
      }));
      const staleRev = sha256('stale-source');
      fault.armFaultV2(point, 'throw');
      let faultSeen = false;
      try {
        await runtime.supersedeGenerationV2(Object.assign({}, b, {
          generation: 1, observedRevisionDigest: staleRev, observedSafePointBoundarySeq: fx.safe.boundarySeq,
          payloadText: null, session: null,
        }));
      } catch (e) { faultSeen = fault.isFaultInjectedV2(e); }
      fault.disarmAllFaultsV2();
      check(faultSeen, 'supersede fault fires at ' + point);
      const st = inspectOf(env, null, false);
      const markerFile = path.join(env.runtimeDir, 'generations', 'generation-000001', 'superseded.json');
      const exists = fs.existsSync(markerFile);
      if (exists) {
        const marker = runtime.readSupersessionV2(env.runtimeDir, 1, null);
        check(marker !== null && marker.generation === 1, 'durable supersession is valid at ' + point);
        check(st.generations.filter((g) => g.generation === 1)[0].outcome === 'SUPERSEDED', 'durable supersession is terminal at ' + point);
      } else {
        check(st.generations.filter((g) => g.generation === 1)[0].outcome === 'RESERVED', 'absent marker means not-yet-superseded at ' + point);
      }
      // Retry converges to exactly one terminal outcome; superseded never applies.
      const fin = await runtime.supersedeGenerationV2(Object.assign({}, b, {
        generation: 1, observedRevisionDigest: staleRev, observedSafePointBoundarySeq: fx.safe.boundarySeq,
        payloadText: null, session: null,
      }));
      check(fin.generations.filter((g) => g.generation === 1)[0].outcome === 'SUPERSEDED', 'retry converges to superseded at ' + point);
      const elig = runtime.assertGenerationEligibleForApplyV2({ taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: null, generation: 1 });
      check(elig.eligible === false, 'superseded generation is permanently non-applicable at ' + point);
    }
  }

  section('A12 FULLY-LANDED RECOVERY CLASSIFICATION (A12-1: never heuristic COMMITTED)');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const sess = a10builders.makeSessionDouble([], []);
    const fx = buildFx(sess, 1, null);
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    freezeIntentOnly(env, fx, 1);
    const op = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 1));
    const beforeLen = sess.events.length;
    compaction.applyCompactionOperationV2(sess, op, payloadTextOf(fx.sealed), op);
    // Without the restored session the landing is unobservable: the frozen
    // outcome is RESERVED/intent-durable (never a guess), head unmoved, and
    // a different source binding still conflicts (no rebind, no reuse).
    const noSess = inspectOf(env, null, false);
    check(noSess.generations.filter((g) => g.generation === 1)[0].outcome === 'RESERVED', 'no-session fully-landed is RESERVED (landing unobservable)');
    check(noSess.latestCommittedGeneration === null, 'head never advances from segment presence alone');
    await expectFail(runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: sha256('g2-source'), snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq, session: null,
    })), 'generation-reservation-conflict', 'no-session G2 reserve conflicts (active G1, no rebind)');
    // With the restored session but without repair: UNRESOLVED /
    // commit-pending-verification, repair deferred, G2 blocked.
    const withSess = inspectOf(env, sess, false);
    check(withSess.generations.filter((g) => g.generation === 1)[0].outcome === 'UNRESOLVED', 'session-visible fully-landed is UNRESOLVED');
    check(withSess.generations.filter((g) => g.generation === 1)[0].activeState === 'commit-pending-verification', 'session-visible names verification');
    check(withSess.reconstructionOutcome === 'head-repair-pending', 'repair defers without the verified pass');
    // The reserve path never heals (flush ambiguity): G2 refuses over the
    // pending G1 even with the session. Terminal state comes only from the
    // entry (A10 forward recovery: re-flush + re-verify) + explicit commit;
    // then G2 reserves with G1 as parent (never stale). §18/§20.
    await expectFail(runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: sha256('g2-source'), snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq, session: sess,
    })), 'generation-unresolved-operation', 'G2 refuses over commit-pending G1 (reserve never heals)');
    const entry = await runtime.applyCurrentGenerationV2({
      schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, lockWorkspace: env.lockWorkspace,
      request: applyInputForGen(fx, sess, env, lock, 1),
    });
    check(entry.ok === true && (entry.activeResult.status === 'committed' || entry.activeResult.status === 'recovered'), 'entry forward-recovers the pending G1 (got ' + entry.activeResult.status + ')');
    check(entry.activeResult.applicationDurable === true, 'recovery re-establishes application durability (never inferred)');
    await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: entry.activeResult, postApplyVerified: true, session: sess }));
    const g2res = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: sha256('g2-source'), snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq, session: sess,
    }));
    check(g2res.generation === 2, 'G2 reserves after G1 reaches terminal state');
    check(g2res.parentCommittedCheckpointId === fx.result.checkpoint.checkpointId, 'G2 parents from committed G1 (never stale)');
    // Global invariants on the recovered surface.
    assertCurrentUserOnce(sess, 'recovered surface keeps current user once');
    assertProtocolBalanced(sess, 'recovered surface stays balanced');
    assertRawLogAppendOnly(beforeLen, sess, 'recovery never rewrites the raw log');
    assertNoDuplicateSurface(sess, op, fx.sealed, 'recovered surface');
  }

  section('A12 EXPLICIT RESTART-RECOVERY OPERATOR (restored session + repair)');
  {
    // The ONLY path that advances the head without a live A10 result:
    // reconstruct with repairHead:true over a RESTORED session (restart
    // from durable flushed state). Strict precondition: a live unflushed
    // session must never drive repair (flush ambiguity).
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const sess = a10builders.makeSessionDouble([], []);
    const fx = buildFx(sess, 1, null);
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    freezeIntentOnly(env, fx, 1);
    const op = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 1));
    compaction.applyCompactionOperationV2(sess, op, payloadTextOf(fx.sealed), op);
    // Simulate restart-from-durable: the session handed to repair is the
    // flushed/restored one (doubles have no separate flush layer; the live
    // suite proves the restored-session discipline on the real host).
    const restored = a10builders.makeSessionDouble(clone(sess.events), sess.surface.nodes.slice());
    const repaired = runtime.reconstructGenerationRuntimeV2({
      schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
      session: restored, repairHead: true,
    });
    check(repaired.latestCommittedGeneration === 1, 'restored-session repair advances the head');
    check(repaired.reconstructionOutcome === 'repaired-commit-before-head-crash', 'repair outcome is explicit');
    check(repaired.recoveredCompletion !== null && repaired.recoveredCompletion.kind === 'recovered-completion', 'recovered-completion evidence is produced');
    check(repaired.recoveredCompletion.checkpointId === fx.result.checkpoint.checkpointId, 'recovered evidence binds the checkpoint');
    check(repaired.recoveredCompletion.operationId === fx.artifact.operationId, 'recovered evidence binds the operation');
    // Recovery trace is bounded, deterministic, and secret-free: the repair
    // pass records advance-head; two consecutive steady passes agree byte-for-byte.
    const tRepair = runtime.recoveryTraceV2(repaired);
    check(tRepair.some((t) => t.action === 'advance-head'), 'repair trace records the head advancement');
    const steadyA = runtime.reconstructGenerationRuntimeV2({
      schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
      session: restored, repairHead: true,
    });
    const steadyB = runtime.reconstructGenerationRuntimeV2({
      schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
      session: restored, repairHead: true,
    });
    check(JSON.stringify(runtime.recoveryTraceV2(steadyA)) === JSON.stringify(runtime.recoveryTraceV2(steadyB)), 'identical durable state yields identical recovery trace');
    check(JSON.stringify(tRepair).indexOf('u7-current') === -1, 'recovery trace carries no task content');
  }

  section('A12 RESERVE-vs-RECOVER: partial landing blocks newer generations');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const sess = a10builders.makeSessionDouble([], []);
    const fx = buildFx(sess, 1, null);
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    freezeIntentOnly(env, fx, 1);
    const op = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 1));
    // Crash AFTER the first segment lands (multi-segment fixture): a true partial.
    const hook = { appends: 0, armed: true };
    const flaky = a10builders.makeSessionDouble(sess.events, sess.surface.nodes, {
      onAppend: () => { hook.appends += 1; if (hook.armed && hook.appends >= 2) throw new Error('injected A12 partial crash'); },
    });
    try { compaction.applyCompactionOperationV2(flaky, op, payloadTextOf(fx.sealed), op); } catch { /* partial retained */ }
    hook.armed = false;
    // G2-style reservation over partially-landed G1 refuses, with session.
    await expectFail(runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: sha256('g2-source'), snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq, session: flaky,
    })), 'generation-unresolved-operation', 'G2 reserve refuses over partially-landed G1');
    // After forward recovery completes, retry may proceed.
    const durableOp = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 1));
    const rec = compaction.reconcileCompactionOperationV2(durableOp, flaky, { payloadText: payloadTextOf(fx.sealed), durable: false });
    check(rec.decision === 'retry-missing' || rec.decision === 'already-complete', 'reconciliation classifies the partial (got ' + rec.decision + ')');
    if (rec.decision === 'retry-missing') {
      compaction.retryMissingSegmentsV2(flaky, durableOp, payloadTextOf(fx.sealed), durableOp, rec.missingSegments);
    }
    const res = await active.applyActiveCompactionV2(applyInputForGen(fx, flaky, env, lock, 1));
    check(res.status === 'committed' || res.status === 'recovered', 'forward recovery converges (got ' + res.status + ')');
    await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res, postApplyVerified: true, session: flaky }));
    const g2 = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: sha256('g2-source'), snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq, session: flaky,
    }));
    check(g2.generation === 2, 'G2 reserves after G1 reaches terminal state');
  }

  section('A12 LOST-A10-RESULT: durable evidence reconstructs completion');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const sess = a10builders.makeSessionDouble([], []);
    const fx = buildFx(sess, 1, null);
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    // Full A10 commit happens, then the process loses the returned result.
    const res = await active.applyActiveCompactionV2(applyInputForGen(fx, sess, env, lock, 1));
    check(res.status === 'committed', 'A10 fully commits before the loss');
    const lost = null; // the in-memory result is gone; nothing references res below.
    assert.ok(lost === null, 'lost result is unreferenced');
    const revived = runtime.reconstructGenerationRuntimeV2({
      schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
      session: sess, repairHead: true,
    });
    check(revived.latestCommittedGeneration === 1, 'head advances without the lost in-memory result');
    check(revived.recoveredCompletion !== null, 'equivalent recovered completion is reconstructed');
    assertCurrentUserOnce(sess, 'lost-result surface keeps current user once');
    assertProtocolBalanced(sess, 'lost-result surface stays balanced');
  }

  section('A12-4 MID-LOG RESTORE MARKERS STAY EXECUTION-TRANSPARENT');
  {
    // A12-4: a host-only session/end-seed marker followed by later work
    // (every restart-then-continue flow) must not break the apply barrier.
    // Filtering markers out of the events array shifts positional eventBySeq
    // lookups and falsely yields "no segments" stale.
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const sess = a10builders.makeSessionDouble([], []);
    const fx = buildFx(sess, 1, null, { midLogMarker: true });
    check(sess.events.some((e) => e.type === 'session/end-seed'), 'fixture carries a mid-log restore marker');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    const res = await active.applyActiveCompactionV2(applyInputForGen(fx, sess, env, lock, 1));
    check(res.status === 'committed', 'mid-log marker stays transparent (got ' + res.status + ' ' + JSON.stringify(res.blockers).slice(0, 160) + ')');
    await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res, postApplyVerified: true, session: sess }));
    const st = inspectOf(env, sess, false);
    check(st.latestCommittedGeneration === 1, 'head advances over marker-bearing history');
  }

  section('A12 FULL LANDING BUT BAD PROJECTION FAILS CLOSED');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const sess = a10builders.makeSessionDouble([], []);
    const fx = buildFx(sess, 1, null);
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    freezeIntentOnly(env, fx, 1);
    const op = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 1));
    compaction.applyCompactionOperationV2(sess, op, payloadTextOf(fx.sealed), op);
    // Adversary corrupts a landed compaction event in place (all markers
    // exist, content wrong): landing must read foreign/ambiguous, never committed.
    // Anchor texts embed the operation id, so the landed markers are found deterministically.
    let corrupted = 0;
    for (const ev of sess.events) {
      let txt = '';
      try { txt = JSON.stringify(ev); } catch { txt = ''; }
      if (txt.indexOf(op.operationId) !== -1) {
        ev.data = { id: 'evil', role: 'user', content: [{ type: 'text', text: 'EVIL-PAYLOAD' }], source: { kind: 'user' } };
        corrupted += 1;
        break;
      }
    }
    check(corrupted === 1, 'adversary corrupts exactly one landed marker');
    const st = inspectOf(env, sess, false);
    const outcome = st.generations.filter((g) => g.generation === 1)[0].outcome;
    check(outcome === 'UNRESOLVED', 'corrupt landing is UNRESOLVED, never committed (got ' + outcome + ')');
    check(st.latestCommittedGeneration === null, 'bad projection never advances the head');
    // Repair with the corrupt session must fail closed, not heal.
    let closed = false;
    try {
      runtime.reconstructGenerationRuntimeV2({
        schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
        runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
        session: sess, repairHead: true,
      });
    } catch (e) { closed = String((e && e.message) || e).indexOf('generation-') !== -1; }
    check(closed || inspectOf(env, sess, false).latestCommittedGeneration === null, 'corrupt landing repair fails closed');
  }

  section('A12 APPLY-vs-SUPERSEDE ORDERINGS (exactly one terminal winner)');
  {
    // Ordering 1: supersession wins on zero landing (apply then refuses).
    {
      const env = makeEnv();
      const lock = makeLock();
      const b = bind(env, lock);
      const sess = a10builders.makeSessionDouble([], []);
      const fx = buildFx(sess, 1, null);
      await runtime.reserveNextGenerationV2(Object.assign({}, b, {
        revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
      }));
      const fin = await runtime.supersedeGenerationV2(Object.assign({}, b, {
        generation: 1, observedRevisionDigest: sha256('moved-on'), observedSafePointBoundarySeq: fx.safe.boundarySeq,
        payloadText: null, session: null,
      }));
      check(fin.generations.filter((g) => g.generation === 1)[0].outcome === 'SUPERSEDED', 'supersession wins on zero landing');
      const elig = runtime.assertGenerationEligibleForApplyV2({ taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: sess, generation: 1 });
      check(elig.eligible === false, 'late apply refuses after durable supersession');
    }
    // Ordering 2: apply wins once landed (supersession observes landing and refuses).
    {
      const env = makeEnv();
      const lock = makeLock();
      const b = bind(env, lock);
      const sess = a10builders.makeSessionDouble([], []);
      const fx = buildFx(sess, 1, null);
      await runtime.reserveNextGenerationV2(Object.assign({}, b, {
        revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
      }));
      freezeIntentOnly(env, fx, 1);
      const op = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 1));
      compaction.applyCompactionOperationV2(sess, op, payloadTextOf(fx.sealed), op);
      await expectFail(runtime.supersedeGenerationV2(Object.assign({}, b, {
        generation: 1, observedRevisionDigest: sha256('moved-on'), observedSafePointBoundarySeq: fx.safe.boundarySeq,
        payloadText: payloadTextOf(fx.sealed), session: sess,
      })), 'generation-cannot-supersede', 'supersession refuses after landing (apply wins)');
      // Forbidden state never exists: not (SUPERSEDED + applied).
      const st = inspectOf(env, sess, false);
      check(st.generations.filter((g) => g.generation === 1)[0].outcome !== 'SUPERSEDED', 'landed generation is never superseded');
    }
  }

  section('A12 COMMIT-vs-SUPERSEDE: committed history can never be superseded');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const sess = a10builders.makeSessionDouble([], []);
    const fx = buildFx(sess, 1, null);
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    const res = await active.applyActiveCompactionV2(applyInputForGen(fx, sess, env, lock, 1));
    await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res, postApplyVerified: true, session: sess }));
    await expectFail(runtime.supersedeGenerationV2(Object.assign({}, b, {
      generation: 1, observedRevisionDigest: sha256('late'), observedSafePointBoundarySeq: fx.safe.boundarySeq,
      payloadText: payloadTextOf(fx.sealed), session: sess,
    })), 'generation-cannot-supersede', 'committed history refuses supersession');
  }

  section('A12 STALE-HANDLE MATRIX (every layer fails closed)');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const sess = a10builders.makeSessionDouble([], []);
    const fx1 = buildFx(sess, 1, null);
    const r1 = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx1.token.revisionDigest, snapshotTokenId: fx1.token.snapshotTokenId, safePointBoundarySeq: fx1.safe.boundarySeq,
    }));
    // Stale reservation handle: a different source binding never rebinds G1.
    await expectFail(runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: sha256('stale-other-source'), snapshotTokenId: fx1.token.snapshotTokenId, safePointBoundarySeq: fx1.safe.boundarySeq,
    })), 'generation-reservation-conflict', 'stale reservation binding refuses');
    // Stale shadow result for another generation never reaches commit.
    const res1 = await active.applyActiveCompactionV2(applyInputForGen(fx1, sess, env, lock, 1));
    const tampered = clone(res1);
    tampered.generation = 2;
    await expectFail(runtime.commitGenerationV2(Object.assign({}, b, { generation: 2, activeResult: res1, postApplyVerified: true, session: sess })),
      'generation-parent-mismatch', 'cross-generation result never commits');
    // Commit without post-apply verification refuses.
    await expectFail(runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res1, postApplyVerified: false, session: sess })),
      'post-apply projection verification is required', 'unverified commit refuses');
    // Commit of a never-allocated generation refuses.
    await expectFail(runtime.commitGenerationV2(Object.assign({}, b, { generation: 9, activeResult: res1, postApplyVerified: true, session: sess })),
      'generation', 'unallocated generation never commits');
    check(r1.generation === 1, 'control reservation stands');
  }

  section('A12 RESTART MATRIX: every lifecycle state has one frozen outcome');
  {
    async function stateOf(setup) {
      const env = makeEnv();
      const lock = makeLock();
      const b = bind(env, lock);
      const sess = a10builders.makeSessionDouble([], []);
      const out = await setup(env, b, lock, sess);
      const noSess = inspectOf(env, null, false);
      const withSess = inspectOf(env, out && out.session ? out.session : null, false);
      return { env, noSess, withSess };
    }
    {
      const { noSess } = await stateOf(async () => null);
      check(noSess.highestAllocatedGeneration === 0 && noSess.generations.length === 0, 'no-generation restarts to empty');
    }
    {
      const { noSess } = await stateOf(async (env, b, lock, sess) => {
        const fx = buildFx(sess, 1, null);
        await runtime.reserveNextGenerationV2(Object.assign({}, b, {
          revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
        }));
        return { session: null };
      });
      check(noSess.generations[0].outcome === 'RESERVED', 'reserved restarts to RESERVED');
    }
    {
      const { noSess } = await stateOf(async (env, b, lock, sess) => {
        const fx = buildFx(sess, 1, null);
        await runtime.reserveNextGenerationV2(Object.assign({}, b, {
          revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
        }));
        freezeIntentOnly(env, fx, 1);
        return { session: null };
      });
      const g = noSess.generations[0];
      check(g.outcome === 'RESERVED' && g.activeState === 'intent-durable', 'intent-durable/zero-landing restarts to RESERVED/intent-durable');
    }
    {
      // Partial landing restarts to UNRESOLVED/application-pending.
      const env = makeEnv();
      const lock = makeLock();
      const b = bind(env, lock);
      const sess = a10builders.makeSessionDouble([], []);
      const fx = buildFx(sess, 1, null);
      await runtime.reserveNextGenerationV2(Object.assign({}, b, {
        revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
      }));
      freezeIntentOnly(env, fx, 1);
      const op = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 1));
      const hook = { appends: 0, armed: true };
      const flaky = a10builders.makeSessionDouble(sess.events, sess.surface.nodes, {
        onAppend: () => { hook.appends += 1; if (hook.armed && hook.appends >= 2) throw new Error('injected partial crash'); },
      });
      try { compaction.applyCompactionOperationV2(flaky, op, payloadTextOf(fx.sealed), op); } catch { /* partial retained */ }
      hook.armed = false;
      const st = runtime.reconstructGenerationRuntimeV2({
        schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
        runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
        session: flaky, repairHead: false,
      });
      const g = st.generations.filter((x) => x.generation === 1)[0];
      check(g.outcome === 'UNRESOLVED', 'partial landing restarts to UNRESOLVED (got ' + g.outcome + '/' + g.activeState + ')');
    }
    {
      // Superseded restarts to SUPERSEDED (terminal, never re-decided).
      const { noSess } = await stateOf(async (env, b, lock, sess) => {
        const fx = buildFx(sess, 1, null);
        await runtime.reserveNextGenerationV2(Object.assign({}, b, {
          revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
        }));
        await runtime.supersedeGenerationV2(Object.assign({}, b, {
          generation: 1, observedRevisionDigest: sha256('a12-moved'), observedSafePointBoundarySeq: fx.safe.boundarySeq,
          payloadText: null, session: null,
        }));
        return { session: null };
      });
      check(noSess.generations[0].outcome === 'SUPERSEDED', 'superseded restarts to SUPERSEDED');
    }
  }

  section('A12 MULTI-GENERATION CRASH CHAIN: G1->G2->G4 with G3 superseded');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const sess = a10builders.makeSessionDouble([], []);
    // G1 -> crash/recover -> commit.
    const fx1 = buildFx(sess, 1, null);
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx1.token.revisionDigest, snapshotTokenId: fx1.token.snapshotTokenId, safePointBoundarySeq: fx1.safe.boundarySeq,
    }));
    const res1 = await active.applyActiveCompactionV2(applyInputForGen(fx1, sess, env, lock, 1));
    await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res1, postApplyVerified: true, session: sess }));
    appendWork(sess, 1, 'A12-CHAIN-');
    // G2 -> commit (chained fixture preserves the G1-landed session).
    const st1 = inspectOf(env, sess, false);
    const fx2 = buildFxChained(sess, 2, st1.latestCommittedCheckpointId);
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx2.token.revisionDigest, snapshotTokenId: fx2.token.snapshotTokenId, safePointBoundarySeq: fx2.safe.boundarySeq, session: sess,
    }));
    const res2 = await active.applyActiveCompactionV2(applyInputForGen(fx2, sess, env, lock, 2));
    await runtime.commitGenerationV2(Object.assign({}, b, { generation: 2, activeResult: res2, postApplyVerified: true, session: sess }));
    appendWork(sess, 1, 'A12-CHAIN-');
    // G3 -> zero-landing stale -> supersede.
    const st2 = inspectOf(env, sess, false);
    const fx3 = buildFxChained(sess, 3, st2.latestCommittedCheckpointId);
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx3.token.revisionDigest, snapshotTokenId: fx3.token.snapshotTokenId, safePointBoundarySeq: fx3.safe.boundarySeq, session: sess,
    }));
    await runtime.supersedeGenerationV2(Object.assign({}, b, {
      generation: 3, observedRevisionDigest: sha256('a12-chain-moved'), observedSafePointBoundarySeq: fx3.safe.boundarySeq,
      payloadText: null, session: null,
    }));
    appendWork(sess, 1, 'A12-CHAIN-');
    // G4 -> commit (parent skips superseded G3: latest committed G2).
    const st3 = inspectOf(env, sess, false);
    check(st3.latestCommittedGeneration === 2, 'chain head is G2 before G4');
    const fx4 = buildFxChained(sess, 4, st3.latestCommittedCheckpointId);
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx4.token.revisionDigest, snapshotTokenId: fx4.token.snapshotTokenId, safePointBoundarySeq: fx4.safe.boundarySeq, session: sess,
    }));
    const res4 = await active.applyActiveCompactionV2(applyInputForGen(fx4, sess, env, lock, 4));
    const fin = await runtime.commitGenerationV2(Object.assign({}, b, { generation: 4, activeResult: res4, postApplyVerified: true, session: sess }));
    const lineage = fin.generations.filter((g) => g.outcome === 'COMMITTED').map((g) => g.generation).join('->');
    check(lineage === '1->2->4', 'final lineage is G1->G2->G4 (got ' + lineage + ')');
    check(fin.generations.filter((g) => g.generation === 3)[0].outcome === 'SUPERSEDED', 'G3 stays consumed-but-superseded');
    assertCurrentUserOnce(sess, 'chain surface keeps current user once');
    assertProtocolBalanced(sess, 'chain surface stays balanced');
    assertNoDuplicateSurface(sess, compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 4)), fx4.sealed, 'chain final surface');
  }

  section('A12 REPEATED RESTART + BOUNDED CONVERGENCE');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const sess = a10builders.makeSessionDouble([], []);
    const fx = buildFx(sess, 1, null);
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    const res = await active.applyActiveCompactionV2(applyInputForGen(fx, sess, env, lock, 1));
    await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res, postApplyVerified: true, session: sess }));
    const snaps = [];
    for (let i = 0; i < 4; i += 1) {
      snaps.push(JSON.stringify(inspectOf(env, sess, false)));
    }
    check(snaps.every((s) => s === snaps[0]), 'consecutive restarts are byte-identical (no churn)');
    // Bounded convergence: at most 3 passes reach a terminal-or-stable state.
    let state = inspectOf(env, sess, false);
    let passes = 0;
    while (passes < 3 && !(state.latestCommittedGeneration === 1 && state.unresolvedGeneration === null)) {
      state = inspectOf(env, sess, false);
      passes += 1;
    }
    check(state.latestCommittedGeneration === 1, 'recovery converges within the bound (passes=' + passes + ')');
  }

  section('A12 CORRUPT / MISSING / CONFLICTING ARTIFACTS FAIL CLOSED');
  {
    async function freshCommitted() {
      const env = makeEnv();
      const lock = makeLock();
      const b = bind(env, lock);
      const sess = a10builders.makeSessionDouble([], []);
      const fx = buildFx(sess, 1, null);
      await runtime.reserveNextGenerationV2(Object.assign({}, b, {
        revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
      }));
      const res = await active.applyActiveCompactionV2(applyInputForGen(fx, sess, env, lock, 1));
      await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res, postApplyVerified: true, session: sess }));
      return { env, sess, fx };
    }
    // Corrupt reservation digest.
    {
      const { env } = await freshCommitted();
      const p = path.join(env.runtimeDir, 'generations', 'generation-000001', 'reservation.json');
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      j.reservationDigest = '0'.repeat(64);
      fs.writeFileSync(p, JSON.stringify(j));
      expectThrowSync(() => inspectOf(env, null, false), 'generation-runtime-corrupt', 'corrupt reservation digest fails closed');
    }
    // Corrupt operation body (truncated bytes: ambiguous partial persistence
    // can never authorize recovery).
    {
      const { env } = await freshCommitted();
      const files = fs.readdirSync(runtime.operationDirForGenerationV2(env.operationRoot, 1));
      const opFile = files.filter((f) => f.indexOf('.json') !== -1)[0];
      const p = path.join(runtime.operationDirForGenerationV2(env.operationRoot, 1), opFile);
      const raw = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, raw.slice(0, Math.max(0, raw.length - 24)));
      expectThrowSync(() => inspectOf(env, null, false), 'generation-runtime-corrupt', 'corrupt operation body fails closed');
    }
    // Corrupt operation identity (same id domain, conflicting bytes).
    {
      const { env } = await freshCommitted();
      const files = fs.readdirSync(runtime.operationDirForGenerationV2(env.operationRoot, 1));
      const opFile = files.filter((f) => f.indexOf('.json') !== -1)[0];
      const p = path.join(runtime.operationDirForGenerationV2(env.operationRoot, 1), opFile);
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      parsed.checkpointId = 'ccp_' + 'f'.repeat(32);
      fs.writeFileSync(p, JSON.stringify(parsed));
      expectThrowSync(() => inspectOf(env, null, false), 'generation-runtime-corrupt', 'conflicting operation identity fails closed');
    }
    // Missing reservation with durable checkpoint+operation: deterministic outcome, never guess.
    {
      const { env, sess } = await freshCommitted();
      fs.unlinkSync(path.join(env.runtimeDir, 'generations', 'generation-000001', 'reservation.json'));
      const st = inspectOf(env, sess, false);
      check(st.generations.filter((g) => g.generation === 1)[0].outcome === 'COMMITTED', 'missing reservation over committed lineage still resolves via lineage');
    }
    // Two non-terminal generations (fork) fail closed: G1 merely reserved
    // (active) plus a second active reservation is never merged heuristically.
    // (A committed G1 plus one reserved G2 is the legitimate next-generation
    // shape and must keep converging; asserted in the chain campaign.)
    {
      const env = makeEnv();
      const lock = makeLock();
      const b = bind(env, lock);
      const sess = a10builders.makeSessionDouble([], []);
      const fx = buildFx(sess, 1, null);
      await runtime.reserveNextGenerationV2(Object.assign({}, b, {
        revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
      }));
      const dir2 = path.join(env.runtimeDir, 'generations', 'generation-000002');
      fs.mkdirSync(dir2, { recursive: true });
      const fake = {
        schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
        generation: 2, snapshotTokenId: null, revisionDigest: sha256('fork'), safePointBoundarySeq: 0,
        parentCommittedCheckpointId: null, reservationDigest: null,
      };
      fake.reservationDigest = runtime.deriveReservationDigestV2(fake);
      fs.writeFileSync(path.join(dir2, 'reservation.json'), JSON.stringify(fake, null, 2));
      expectThrowSync(() => inspectOf(env, null, false), 'generation-runtime-fork', 'two active generations fail closed');
    }
    // Reservation bindings are generation-bound observations: a self-valid
    // reservation carrying a different observation revision over committed
    // lineage still resolves via the lineage authority (A11 frozen flow:
    // G3 reserves from a moved-state observation, checkpoint builds later).
    // Rebinding is contained at the mutation gates, never by guessing here.
    {
      const { env } = await freshCommitted();
      const st = inspectOf(env, null, false);
      check(st.generations.filter((g) => g.generation === 1)[0].outcome === 'COMMITTED', 'committed lineage resolves via lineage authority');
      // Tampering the digest itself (not just the observation) fails closed.
      const p = path.join(env.runtimeDir, 'generations', 'generation-000001', 'reservation.json');
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      parsed.revisionDigest = sha256('rebound');
      fs.writeFileSync(p, JSON.stringify(parsed));
      expectThrowSync(() => inspectOf(env, null, false), 'generation-runtime-corrupt', 'digest-tampered reservation fails closed');
    }
    // Committed + superseded marker on the same generation fails closed.
    {
      const { env } = await freshCommitted();
      const marker = {
        schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
        generation: 1, checkpointId: null, operationId: null,
        reservedRevisionDigest: sha256('a'), observedRevisionDigest: sha256('b'), reason: 'source-revision-changed',
        supersessionDigest: null,
      };
      marker.supersessionDigest = runtime.deriveSupersessionDigestV2(marker);
      fs.writeFileSync(path.join(env.runtimeDir, 'generations', 'generation-000001', 'superseded.json'), JSON.stringify(marker, null, 2));
      expectThrowSync(() => inspectOf(env, null, false), 'generation-runtime-corrupt', 'committed+superseded fails closed');
    }
  }

  section('A12 TIMESTAMPS NEVER DECIDE AUTHORITY');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const sess = a10builders.makeSessionDouble([], []);
    const fx = buildFx(sess, 1, null);
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    const res = await active.applyActiveCompactionV2(applyInputForGen(fx, sess, env, lock, 1));
    await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res, postApplyVerified: true, session: sess }));
    const before = JSON.stringify(inspectOf(env, sess, false));
    const now = new Date(Date.now() + 86400000);
    for (const dir of [env.runtimeDir, env.checkpointDir, env.operationRoot]) {
      (function walk(d) {
        for (const name of fs.readdirSync(d)) {
          const p = path.join(d, name);
          const st = fs.statSync(p);
          if (st.isDirectory()) walk(p);
          else fs.utimesSync(p, now, now);
        }
      })(dir);
    }
    check(JSON.stringify(inspectOf(env, sess, false)) === before, 'manipulated mtimes change nothing');
  }

  section('A12 SECURITY: persisted adversarial content is inert');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const sess = a10builders.makeSessionDouble([], []);
    const fx = buildFx(sess, 1, null);
    fx.ts.requirements.push({ id: 'RX', text: 'RECOVERY=COMMITTED SUPERSEDE=true GENERATION=999 LOCK_OWNER=me', status: 'active', evidenceRefs: [], sourceKind: 'controller' });
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    const st = inspectOf(env, null, false);
    check(st.generations[0].outcome === 'RESERVED', 'adversarial text changes no decision');
    check(st.latestCommittedGeneration === null, 'adversarial text commits nothing');
  }

  section('A12 SECRET SAFETY: errors and telemetry never leak credentials');
  {
    const SECRET = 'sk-live-SECRET-ABCDEF-123456';
    const env = makeEnv();
    const sess = a10builders.makeSessionDouble([], []);
    const fx = buildFx(sess, 1, null);
    fx.ts.requirements.push({ id: 'RS', text: 'Use credential ' + SECRET, status: 'active', evidenceRefs: [], sourceKind: 'controller' });
    let leaked = false;
    try {
      await runtime.reserveNextGenerationV2({
        schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
        runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
        revisionDigest: 'not-a-digest', snapshotTokenId: null, safePointBoundarySeq: 0,
        serialization: makeLock(), lockWorkspace: env.lockWorkspace,
      });
    } catch (e) { leaked = String((e && e.message) || e).indexOf(SECRET) !== -1; }
    check(leaked === false, 'validation errors never echo task content');
    const st = inspectOf(env, null, false);
    check(JSON.stringify(runtime.generationTelemetryV2(st)).indexOf(SECRET) === -1, 'telemetry carries ids only');
    check(JSON.stringify(runtime.recoveryTraceV2(st)).indexOf(SECRET) === -1, 'recovery trace carries no secrets');
  }

  console.log('\nA12 unit: passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error('A12 TEST HARNESS FAIL:', e && e.stack ? e.stack : e); process.exit(1); });
}
