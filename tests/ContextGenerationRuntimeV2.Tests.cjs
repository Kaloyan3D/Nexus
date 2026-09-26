'use strict';
/**
 * ContextGenerationRuntimeV2.Tests.cjs - CCV2-A11 Multi-Generation Runtime proof.
 *
 * Proves the authoritative generation runtime against the REAL production
 * authorities (no fakes above the DSH seam): reserve/commit/supersede/
 * reconstruct ownership, monotonic allocation without reuse, allocated-vs-
 * committed distinction, parent-lineage selection (including skipped
 * superseded generations), commit-before-head crash repair, zero-landing
 * supersession, partial-landing refusal, unresolved blocking, fork/corruption
 * fail-closed, determinism, security inertness, secret safety, telemetry.
 *
 * Sessions below are the faithful in-memory doubles shared with the A10
 * suite (append-only positional log, surface replace splice, verbatim
 * deriveEventMessage mirror): the live-host file proves equivalence on the
 * real host. Every checkpoint/operation/snapshot/safe/gate/pressure/
 * retention/shadow/active decision is the real authority, never a stub.
 *
 * A11H hardening: applyCurrentGenerationV2() is the ONLY supported
 * generation-aware active path (architectural, not conventional); raw A02
 * and A10 remain documented low-level primitives. Superseded generations
 * are permanently non-applicable through every supported route, and the
 * runtime-snapshot lifecycle (pinned vs shadowable per generation state)
 * is derived purely from durable state plus the live session.
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
const checkpointV2 = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const trustV2 = require(path.join(repoRoot, 'config', 'ContextTrustV2.cjs'));
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
const canon = (v) => shadow.serializeCanonical(v);
function stripIds(v) {
  if (Array.isArray(v)) return v.map(stripIds);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) { if (k === 'id') continue; out[k] = stripIds(v[k]); }
    return out;
  }
  return v;
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

const TASK_ID = 'TASK-A11';
const TASK_INSTANCE = 'task_a11_0001';
const SESSION_ID = 'sess-a11';

function makeEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a11-'));
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
async function expectFail(promise, fragment, name) {
  try {
    await promise;
  } catch (error) {
    const message = String((error && error.message) || error);
    check(message.indexOf(fragment) !== -1, name, 'expected [' + fragment + '] got [' + message.slice(0, 200) + ']');
    return;
  }
  check(false, name, 'expected failure containing [' + fragment + '] but the call succeeded');
}

// ---- chained generation fixtures (single-segment shape) -----------------------
// G1 uses the frozen A10 happy fixture. G(n>1) chains on the live session:
// real appended work, a fresh task revision, and fresh A05-A09 decisions.
// The parent checkpoint id selects lineage (latest committed head).

function buildChainedFixture(session, generation, parentCheckpointId, tag) {
  const events = clone(session.events);
  const surface = session.surface.nodes.slice();
  const boundary = events.length - 1;
  const over = { taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, workspaceId: '/tmp/nexus-a11', generation };
  const ts0 = a10builders.draftTaskState(boundary, boundary, over);
  ts0.requirements = [{ id: 'R1', text: 'Carry the A11 chain forward (' + tag + ').', status: 'active', evidenceRefs: ['ev-cmd-1'], sourceKind: 'controller' }];
  ts0.evidenceRefs = ts0.evidenceRefs.map((e) => Object.assign({}, e, { taskInstanceId: TASK_INSTANCE }));
  ts0.continuation = { nextAction: 'Continue the A11 chain (' + tag + ').', unresolvedQuestions: [], recentUserIntent: 'Advance ' + tag + '.' };
  const ts = a10builders.finalizeTs(ts0);
  const snapInput = a10builders.snapInputOf(ts);
  const token = snapshotV2.capture(snapInput, a10builders.CREATED);
  const safe = a10builders.safeDecisionFor(ts);
  const g = (function () {
    const gate = require(path.join(repoRoot, 'config', 'ContextCheckpointabilityV2.cjs'));
    return gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safe, snapshotToken: token });
  })();
  const p = a10builders.pressureFor(token, 100000);
  // Units tile the whole live log: older (possibly already-compacted) history
  // is represented, fresh work is new, the last event is the current user.
  const last = events.length - 1;
  const U = a10builders.U;
  const units = [
    U('u-hist', 0, Math.max(0, last - 3), { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 6000, method: 'provider-tokenizer', exact: true } }),
    U('u-new', Math.max(0, last - 2), Math.max(0, last - 1), { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }),
    U('u-user', last, last, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } }),
  ];
  const retention = require(path.join(repoRoot, 'config', 'ContextRetentionV2.cjs'));
  const plan = retention.planRetentionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, boundaryContext: a10builders.boundaryCtx(events, ts.taskRevision), contextUnits: units, protocolSpans: [] });
  const shadowInput = { schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId, snapshotToken: token, snapshotCurrentState: snapInput, safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, retentionPlan: plan, taskState: ts, contextUnits: units, sessionEvents: events, surfaceNodes: surface, protocolSpans: [], createdAtUtc: a10builders.CREATED, sealedAtUtc: a10builders.CREATED };
  const result = shadow.evaluateShadowCompactionV2(shadowInput);
  assert.equal(result.verdict, 'shadow-ready', tag + ' fixture must be shadow-ready, got ' + result.verdict + ' ' + JSON.stringify(result.blockers).slice(0, 300));
  const sealed = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId, safePointBoundarySeq: safe.boundarySeq, snapshotToken: token, taskState: ts, createdAtUtc: a10builders.CREATED, sealedAtUtc: a10builders.CREATED });
  const artifact = shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, sealedCheckpoint: sealed.sealedCheckpoint, retentionPlan: plan, snapshotToken: token, taskState: ts, contextUnits: units, sourceEvents: events, surfaceNodes: surface, protocolSpans: [] });
  assert.equal(artifact.projectionDigest, result.projection.projectionDigest, tag + ' artifact binds the shadow digest');
  return { ts, token, safe, g, p, plan, units, events, surface, result, sealed: sealed.sealedCheckpoint, artifact };
}


let a11EvCounter = 0;
function a11EvUser(text, source) { a11EvCounter += 1; return { type: 'user/message', data: { id: 'msg-a11-' + a11EvCounter, role: 'user', content: [{ type: 'text', text }], source: source || { kind: 'user' } } }; }
function a11EvAssistant(text) { a11EvCounter += 1; return { type: 'assistant/message', data: { turn: 't1', step: 's1', message: { id: 'msg-a11-' + a11EvCounter, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } } }; }
function a11EvRuntime(text) { return a11EvUser(text, { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }); }
function a11Seqify(events) { return events.map((e, i) => Object.assign({}, e, { seq: i })); }

// Multi-segment fixture with A11 task binding (mirrors the frozen A10 multi
// shape: runtime snapshot pinned, tool span declared, current user last).
function buildMultiFixture(session, generation, parentCheckpointId) {
  a11EvCounter = 0;
  const seedEvents = a11Seqify([a11EvUser('u0'), a11EvAssistant('a1'), a11EvRuntime('RUNTIME-POLICY-A'), a11EvUser('u3'), a11EvAssistant('a4'), a11EvUser('u5'), a11EvAssistant('a6'), a11EvUser('u7-current')]);
  session.events = clone(seedEvents);
  session.surface.nodes = seedEvents.map((e) => e.seq);
  const events = clone(session.events);
  const surface = session.surface.nodes.slice();
  const boundary = 4;
  const U = a10builders.U;
  const units = [
    U('u-hist-1', 0, 1, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }),
    U('u-runtime', 2, 2, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 500, method: 'provider-tokenizer', exact: true } }),
    U('u-mid', 3, 4, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }),
    U('u-req-new', 5, 6, { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }),
    U('u-user', 7, 7, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } }),
  ];
  const over = { taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, workspaceId: '/tmp/nexus-a11', generation };
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
  assert.equal(result.verdict, 'shadow-ready', 'multi fixture must be shadow-ready, got ' + result.verdict + ' ' + JSON.stringify(result.blockers).slice(0, 300));
  const sealed = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId, safePointBoundarySeq: safe.boundarySeq, snapshotToken: token, taskState: ts, createdAtUtc: a10builders.CREATED, sealedAtUtc: a10builders.CREATED });
  const artifact = shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, sealedCheckpoint: sealed.sealedCheckpoint, retentionPlan: plan, snapshotToken: token, taskState: ts, contextUnits: units, sourceEvents: events, surfaceNodes: surface, protocolSpans: [] });
  assert.equal(artifact.projectionDigest, result.projection.projectionDigest, 'multi artifact binds the shadow digest');
  assert.ok(artifact.segments.length >= 2, 'multi fixture must yield multiple segments');
  return { ts, token, safe, g, p, plan, units, events, surface, result, sealed: sealed.sealedCheckpoint, artifact };
}

// Durable intent with ZERO landing (checkpoint + frozen operation persisted,
// no session mutation): the exact residual-A10 scenario supersession closes.
function freezeIntentOnly(env, fx, generation) {
  const sealedSerialized = checkpointV2.serializeCheckpointCanonical(fx.sealed);
  trustV2.persistSealedCheckpointV2(env.checkpointDir, { checkpoint: clone(fx.sealed), serialized: sealedSerialized });
  const unioned = [];
  for (const seg of fx.artifact.segments) for (const seq of seg.sourceEventSeqs) unioned.push(seq);
  unioned.sort((a, b) => a - b);
  const draft = {
    schemaVersion: 2,
    operationId: fx.artifact.operationId,
    attemptId: 'att_' + require('node:crypto').createHash('sha256').update('nexus/context-active-apply-attempt/v1' + String.fromCharCode(10) + String(fx.artifact.operationId), 'utf8').digest('hex').slice(0, 24), // byte-identical to the A10 derivation
    taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
    workspace: '/tmp/nexus-a11', repositoryId: null, checkoutId: null,
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
  const expected = { taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, workspace: '/tmp/nexus-a11', repositoryId: null, checkoutId: null, checkpointGeneration: generation, checkpointId: fx.result.checkpoint.checkpointId };
  return compaction.freezeCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, generation), draft, expected);
}

function entryInputForGen(fx, session, env, lock, generation) {
  return {
    schemaVersion: 1,
    taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
    runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir,
    operationRoot: env.operationRoot, lockWorkspace: env.lockWorkspace,
    request: applyInputForGen(fx, session, env, lock, generation),
  };
}
function appendRuntimeSnapshot(session, text) {
  const seq = session.events.length;
  session.events.push({ seq, type: 'user/message', data: { id: 'msg-a11-rs' + seq, role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' } } });
  session.surface.nodes.push(seq);
  return seq;
}
function protectionOf(env, session) {
  return runtime.snapshotProtectionOfV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session });
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

function payloadTextOf(sealed) { return shadow.checkpointPayloadTextOf(sealed); }

function appendWork(session, n) {
  for (let i = 0; i < n; i += 1) {
    const seqU = session.events.length;
    session.events.push({ seq: seqU, type: 'user/message', data: { id: 'msg-a11-w' + seqU, role: 'user', content: [{ type: 'text', text: 'A11-NEW-WORK-' + seqU }], source: { kind: 'user' } } });
    session.surface.nodes.push(seqU);
    const seqA = session.events.length;
    session.events.push({ seq: seqA, type: 'assistant/message', data: { turn: 't9', step: 's9', message: { id: 'msg-a11-w' + seqA, role: 'assistant', content: [{ type: 'text', text: 'A11-NEW-REPLY-' + seqA }], source: { kind: 'model' } } } });
    session.surface.nodes.push(seqA);
  }
  const seqC = session.events.length;
  session.events.push({ seq: seqC, type: 'user/message', data: { id: 'msg-a11-w' + seqC, role: 'user', content: [{ type: 'text', text: 'A11-CURRENT-' + seqC }], source: { kind: 'user' } } });
  session.surface.nodes.push(seqC);
}

async function main() {
  section('A11 AUTHORITY SHAPE (identity only, no auto-trigger)');
  check(typeof runtime.reserveNextGenerationV2 === 'function', 'explicit reserveNextGenerationV2 API exists');
  check(typeof runtime.commitGenerationV2 === 'function', 'explicit commitGenerationV2 API exists');
  check(typeof runtime.supersedeGenerationV2 === 'function', 'explicit supersedeGenerationV2 API exists');
  check(typeof runtime.reconstructGenerationRuntimeV2 === 'function', 'explicit reconstructGenerationRuntimeV2 API exists');
  check(typeof runtime.checkOperationSupersededV2 === 'function', 'superseded-operation guard exists');
  check(typeof runtime.assertGenerationEligibleForApplyV2 === 'function', 'generation eligibility guard exists');
  check(runtime.GENERATION_RUNTIME_SCHEMA_VERSION === 1, 'runtime schema version is 1');
  check(runtime.GENERATION_OUTCOMES.join(',') === 'RESERVED,COMMITTED,SUPERSEDED,UNRESOLVED', 'bounded outcome vocabulary');
  check(active.applyActiveCompactionV2 !== undefined && runtime.applyActiveCompactionV2 === undefined, 'A11 carries no apply behavior (A10 frozen)');

  section('RESERVATION: G1 null parent, monotonic, idempotent');
  {
    const env = makeEnv();
    const b = bind(env);
    const fx = a10builders.buildHappy('single');
    const r1 = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId,
      safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    check(r1.generation === 1, 'first reservation allocates G1');
    check(r1.parentCommittedCheckpointId === null, 'G1 parent is null (frozen A03 rule)');
    check(runtime.validateReservationV2(r1).valid === true, 'G1 reservation validates closed-world');
    const r1b = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId,
      safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    check(r1b.generation === 1 && r1b.reservationDigest === r1.reservationDigest, 'identical retry returns the same G1 reservation (no new generation consumed)');
    const other = Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId,
      safePointBoundarySeq: fx.safe.boundarySeq + 100,
    });
    await expectFail(runtime.reserveNextGenerationV2(other), 'generation-reservation-conflict', 'changed source state never rebinds G1 (conflict, not silent rebind)');
    const st = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: null });
    check(st.highestAllocatedGeneration === 1 && st.latestCommittedGeneration === null, 'allocated (1) vs committed (null) are distinct concepts');
    check(st.activeGeneration === 1 && st.activeGenerationState === 'reserved', 'active G1 is reserved');
  }

  section('RESERVATION: no caller-chosen generation');
  {
    const env = makeEnv();
    const b = bind(env);
    check(typeof b.generation === 'undefined', 'reserve input carries no generation field');
    const fx = a10builders.buildHappy('single');
    await expectFail(runtime.reserveNextGenerationV2(Object.assign({}, b, {
      generation: 27, revisionDigest: fx.token.revisionDigest, safePointBoundarySeq: fx.safe.boundarySeq,
    })), 'unknown field generation', 'caller-provided generation identity is refused as an unknown field');
  }

  section('G1 COMMIT: full A10 flow then head advancement');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const seed = a10builders.buildHappy('single');
    const session = a10builders.makeSessionDouble(seed.events, seed.surface);
    const fx = buildChainedFixture(session, 1, null, 'G1');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId,
      safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    const res = await active.applyActiveCompactionV2(applyInputForGen(fx, session, env, lock, 1));
    check(res.status === 'committed' && res.applicationDurable === true, 'A10 G1 commits (got ' + res.status + ')');
    const after = await runtime.commitGenerationV2(Object.assign({}, b, {
      generation: 1, activeResult: res, postApplyVerified: true, session,
    }));
    check(after.latestCommittedGeneration === 1, 'head advances to G1 only after proven durability');
    check(after.latestCommittedCheckpointId === res.checkpointId, 'head checkpoint binds the proven result');
    check(after.highestAllocatedGeneration === 1, 'highest allocated stays 1');
    check(after.activeGeneration === null, 'no active generation after commit');
    check(canon(stripIds(session.deriveMessages())) === canon(stripIds(fx.artifact.projectedMessages)), 'actual equals the G1 A09 prediction');
    // Head cannot advance before durability: a refused result never commits.
    const bad = clone(res); bad.status = 'refused';
    await expectFail(runtime.commitGenerationV2(Object.assign({}, b, {
      generation: 1, activeResult: bad, postApplyVerified: true, session,
    })), 'generation-', 'refused A10 result cannot advance the head');
    // Tampered durability never commits.
    const tampered = clone(res); tampered.applicationDurable = false;
    await expectFail(runtime.commitGenerationV2(Object.assign({}, b, {
      generation: 1, activeResult: tampered, postApplyVerified: true, session,
    })), 'generation-', 'result without application durability cannot advance the head');
    // Idempotent reconvergence: committing G1 again converges on the same head.
    const again = await runtime.commitGenerationV2(Object.assign({}, b, {
      generation: 1, activeResult: res, postApplyVerified: true, session,
    }));
    check(again.latestCommittedGeneration === 1 && again.latestCommittedCheckpointId === res.checkpointId, 'repeated head advancement is idempotent');
  }

  section('G1->G2->G3 chained commits with latest-only surface');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const seed1 = a10builders.buildHappy('single');
    const session = a10builders.makeSessionDouble(seed1.events, seed1.surface);
    const fx1 = buildChainedFixture(session, 1, null, 'G1');
    const r1 = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx1.token.revisionDigest, snapshotTokenId: fx1.token.snapshotTokenId,
      safePointBoundarySeq: fx1.safe.boundarySeq,
    }));
    check(r1.generation === 1, 'chain reserves G1');
    const res1 = await active.applyActiveCompactionV2(applyInputForGen(fx1, session, env, lock, 1));
    check(res1.status === 'committed', 'chain A10 G1 commits');
    const c1 = await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res1, postApplyVerified: true, session }));
    check(c1.latestCommittedGeneration === 1, 'chain head is G1');
    appendWork(session, 1);
    const fx2 = buildChainedFixture(session, 2, res1.checkpointId, 'G2');
    const r2 = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx2.token.revisionDigest, snapshotTokenId: fx2.token.snapshotTokenId,
      safePointBoundarySeq: fx2.safe.boundarySeq,
    }));
    check(r2.generation === 2, 'chain reserves G2 (never reuses G1)');
    check(r2.parentCommittedCheckpointId === res1.checkpointId, 'G2 parent is the latest committed checkpoint');
    const elig2 = runtime.assertGenerationEligibleForApplyV2({ taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session, generation: 2, shadowResult: fx2.result });
    check(elig2.eligible === true, 'G2 is eligible for apply');
    const res2 = await active.applyActiveCompactionV2(applyInputForGen(fx2, session, env, lock, 2));
    check(res2.status === 'committed', 'chain A10 G2 commits (got ' + res2.status + ' ' + JSON.stringify(res2.blockers).slice(0, 200) + ')');
    const c2 = await runtime.commitGenerationV2(Object.assign({}, b, { generation: 2, activeResult: res2, postApplyVerified: true, session }));
    check(c2.latestCommittedGeneration === 2, 'chain head is G2');
    appendWork(session, 1);
    const fx3 = buildChainedFixture(session, 3, res2.checkpointId, 'G3');
    const r3 = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx3.token.revisionDigest, snapshotTokenId: fx3.token.snapshotTokenId,
      safePointBoundarySeq: fx3.safe.boundarySeq,
    }));
    check(r3.generation === 3, 'chain reserves G3');
    check(r3.parentCommittedCheckpointId === res2.checkpointId, 'G3 parent is the G2 checkpoint');
    const res3 = await active.applyActiveCompactionV2(applyInputForGen(fx3, session, env, lock, 3));
    check(res3.status === 'committed', 'chain A10 G3 commits (got ' + res3.status + ' ' + JSON.stringify(res3.blockers).slice(0, 200) + ')');
    const c3 = await runtime.commitGenerationV2(Object.assign({}, b, { generation: 3, activeResult: res3, postApplyVerified: true, session }));
    check(c3.latestCommittedGeneration === 3, 'chain head is G3');
    check(c3.highestAllocatedGeneration === 3, 'highest allocated is 3');
    // Latest-only model-facing projection: deriveMessages equals the G3
    // prediction exactly; old payloads do not accumulate on the surface.
    check(canon(stripIds(session.deriveMessages())) === canon(stripIds(fx3.artifact.projectedMessages)), 'final surface equals the G3 A09 prediction exactly');
    const texts = messageTexts(session.deriveMessages()).join('\n');
    check(texts.split(payloadTextOf(fx3.sealed)).length - 1 === 1, 'latest payload is active exactly once');
    check(texts.indexOf(payloadTextOf(fx1.sealed)) === -1, 'G1 payload no longer accumulates on the active surface');
    check(texts.indexOf(payloadTextOf(fx2.sealed)) === -1, 'G2 payload no longer accumulates on the active surface');
    const currentCount = texts.split('A11-CURRENT-').length - 1;
    check(currentCount === 1, 'current user remains exactly once (got ' + currentCount + ')');
    check(shadow.checkMessagesBalanced(session.deriveMessages()) === true, 'protocol remains balanced after G3');
    // Fresh pressure/retention per generation: G2/G3 never reuse G1 decisions.
    check(fx2.plan.retentionPlanId !== fx1.plan.retentionPlanId, 'G2 retention plan is fresh (never G1 reuse)');
    check(fx3.plan.retentionPlanId !== fx2.plan.retentionPlanId, 'G3 retention plan is fresh (never G2 reuse)');
    check(fx2.token.snapshotTokenId !== fx1.token.snapshotTokenId, 'G2 snapshot binding is fresh');
    // Restart reconstruction returns the exact same runtime.
    const before = canon(c3);
    const revived = runtime.reconstructGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session, repairHead: true });
    check(canon(revived) === before, 'restart reconstruction is byte-identical');
    check(revived.reconstructionOutcome === 'steady', 'steady reconstruction outcome on healthy state');
  }


  section('ZERO-LANDING SUPERSESSION + SKIPPED LINEAGE (G1 committed, G2 superseded, G3 from G1)');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const seed1 = a10builders.buildHappy('single');
    const session = a10builders.makeSessionDouble(seed1.events, seed1.surface);
    const fx1 = buildChainedFixture(session, 1, null, 'G1-sup');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx1.token.revisionDigest, snapshotTokenId: fx1.token.snapshotTokenId,
      safePointBoundarySeq: fx1.safe.boundarySeq,
    }));
    const res1 = await active.applyActiveCompactionV2(applyInputForGen(fx1, session, env, lock, 1));
    check(res1.status === 'committed', 'supersede-chain G1 commits');
    await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res1, postApplyVerified: true, session }));
    appendWork(session, 1);
    // G2 reserves against revA, then intent becomes durable with ZERO landing.
    const fx2 = buildChainedFixture(session, 2, res1.checkpointId, 'G2-stale');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx2.token.revisionDigest, snapshotTokenId: fx2.token.snapshotTokenId,
      safePointBoundarySeq: fx2.safe.boundarySeq,
    }));
    freezeIntentOnly(env, fx2, 2);
    check(fs.existsSync(require('node:path').join(env.checkpointDir, 'cp-000002.json')), 'G2 checkpoint persists as immutable evidence');
    check(fs.existsSync(require('node:path').join(runtime.operationDirForGenerationV2(env.operationRoot, 2), 'context-compaction-operation-v2.json')), 'G2 operation persists as immutable evidence');
    // Real semantic task state moves: new user event + new observation revB.
    appendWork(session, 0);
    const fx2b = buildChainedFixture(session, 2, res1.checkpointId, 'G2-stale-moved');
    check(fx2b.token.revisionDigest !== fx2.token.revisionDigest, 'moved state yields a new revision digest (staleness is real)');
    const sup = await runtime.supersedeGenerationV2(Object.assign({}, b, {
      generation: 2, observedRevisionDigest: fx2b.token.revisionDigest,
      observedSafePointBoundarySeq: fx2b.safe.boundarySeq,
      payloadText: payloadTextOf(fx2.sealed), session,
    }));
    const g2entry = sup.generations.filter((g) => g.generation === 2)[0];
    check(g2entry && g2entry.outcome === 'SUPERSEDED', 'G2 becomes SUPERSEDED after proving zero landing + staleness');
    check(sup.supersededGenerationCount === 1 && sup.activeGeneration === null, 'no active generation after supersession');
    check(sup.highestAllocatedGeneration === 2 && sup.latestCommittedGeneration === 1, 'allocated (2) vs committed (1) stay distinct');
    // Recovery guard: the old G2 intent must never land again.
    const g2op = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 2));
    const guard = runtime.checkOperationSupersededV2({ runtimeDir: env.runtimeDir, operation: g2op });
    check(guard.superseded === true, 'A02 recovery guard reports the G2 intent superseded (must not apply)');
    const eligG2 = runtime.assertGenerationEligibleForApplyV2({ taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session, generation: 2, shadowResult: fx2.result });
    check(eligG2.eligible === false, 'superseded G2 is never eligible for apply');
    // Committed history cannot be superseded retroactively.
    await expectFail(runtime.supersedeGenerationV2(Object.assign({}, b, {
      generation: 1, observedRevisionDigest: fx2b.token.revisionDigest, payloadText: payloadTextOf(fx1.sealed), session,
    })), 'generation-cannot-supersede', 'committed G1 cannot be superseded');
    // G3 allocates past the consumed G2 number and descends from G1.
    const r3 = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx2b.token.revisionDigest, snapshotTokenId: fx2b.token.snapshotTokenId,
      safePointBoundarySeq: fx2b.safe.boundarySeq,
    }));
    check(r3.generation === 3, 'next generation is G3 (G2 number never reused)');
    check(r3.parentCommittedCheckpointId === res1.checkpointId, 'G3 parent is the G1 checkpoint (skipped lineage, not G2)');
    const fx3 = buildChainedFixture(session, 3, res1.checkpointId, 'G3-after-supersede');
    const res3 = await active.applyActiveCompactionV2(applyInputForGen(fx3, session, env, lock, 3));
    check(res3.status === 'committed', 'G3 commits (got ' + res3.status + ' ' + JSON.stringify(res3.blockers).slice(0, 200) + ')');
    const c3 = await runtime.commitGenerationV2(Object.assign({}, b, { generation: 3, activeResult: res3, postApplyVerified: true, session }));
    check(c3.latestCommittedGeneration === 3, 'head is G3 with skipped lineage');
    const sealed3 = trustV2.readSealedCheckpointV2(env.checkpointDir, 3);
    check(sealed3.checkpoint.parentCheckpointId === res1.checkpointId, 'G3.parentCheckpointId == G1.checkpointId (proven skipped lineage)');
    check(canon(stripIds(session.deriveMessages())) === canon(stripIds(fx3.artifact.projectedMessages)), 'final surface equals the G3 prediction');
    check(runtime.generationCitationsOf(session, 2).length === 0, 'old G2 intent never landed (zero citations)');
    check(messageTexts(session.deriveMessages()).join('\n').indexOf(payloadTextOf(fx2.sealed)) === -1, 'abandoned G2 payload never appears on the surface');
    // Unchanged source must recover, never supersede: fresh G4 reserve is
    // unchanged-state, so supersession is refused.
    const r4 = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx3.token.revisionDigest, snapshotTokenId: fx3.token.snapshotTokenId,
      safePointBoundarySeq: fx3.safe.boundarySeq,
    }));
    check(r4.generation === 4, 'G4 reserves for continued work');
    await expectFail(runtime.supersedeGenerationV2(Object.assign({}, b, {
      generation: 4, observedRevisionDigest: fx3.token.revisionDigest,
      observedSafePointBoundarySeq: fx3.safe.boundarySeq, session,
    })), 'generation-source-stale', 'unchanged source refuses supersession (recover instead)');
  }

  section('PARTIAL LANDING: refuse supersede, block G3, reconcile then commit');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const seed = a10builders.buildHappy('multi');
    let appends = 0;
    const crashHook = { armed: true };
    const flaky = a10builders.makeSessionDouble(seed.events, seed.surface, {
      onAppend: () => { appends += 1; if (crashHook.armed && appends >= 2) throw new Error('injected mid-apply crash'); },
    });
    const fx = buildMultiFixture(flaky, 1, null);
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId,
      safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    freezeIntentOnly(env, fx, 1);
    const op = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 1));
    const durableOp = op;
    let applyError = null;
    try {
      compaction.applyCompactionOperationV2(flaky, op, payloadTextOf(fx.sealed), durableOp);
    } catch (error) { applyError = error; }
    check(applyError !== null, 'injected crash interrupts the multi-segment apply');
    const st = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: flaky });
    const entry = st.generations.filter((g) => g.generation === 1)[0];
    check(entry.outcome === 'UNRESOLVED' && entry.activeState === 'application-pending', 'partial G1 is UNRESOLVED (got ' + entry.outcome + ')');
    check(st.unresolvedGeneration === 1, 'unresolved generation reported with blocker');
    check(st.blockerCodes.join(',') === 'generation-unresolved-operation', 'stable unresolved blocker code');
    await expectFail(runtime.supersedeGenerationV2(Object.assign({}, b, {
      generation: 1, observedRevisionDigest: 'f'.repeat(64), payloadText: payloadTextOf(fx.sealed), session: flaky,
    })), 'generation-cannot-supersede', 'partial application cannot be superseded (reconcile first)');
    await expectFail(runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, safePointBoundarySeq: fx.safe.boundarySeq, session: flaky,
    })), 'generation-unresolved-operation', 'G2 reservation blocks across UNRESOLVED G1');
    const elig = runtime.assertGenerationEligibleForApplyV2({ taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: flaky, generation: 1 });
    check(elig.eligible === false && elig.code === 'generation-unresolved-operation', 'partial G1 is not eligible for fresh apply');
    // Forward recovery: reconcile, retry exactly the missing segments, then
    // the real A10 converges to recovered and the head advances.
    const rec = compaction.reconcileCompactionOperationV2(op, flaky, { payloadText: payloadTextOf(fx.sealed), durable: false });
    check(rec.decision === 'retry-missing', 'reconciliation demands retry of exactly the missing segments (got ' + rec.decision + ')');
    crashHook.armed = false;
    const retry = compaction.retryMissingSegmentsV2(flaky, op, payloadTextOf(fx.sealed), durableOp, rec.missingSegments);
    check(retry.landed.length === rec.missingSegments.length, 'retry lands exactly the missing segments');
    const res = await active.applyActiveCompactionV2(applyInputForGen(fx, flaky, env, lock, 1));
    check(res.status === 'recovered' || res.status === 'committed', 'A10 converges after partial recovery (got ' + res.status + ')');
    const c1 = await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res, postApplyVerified: true, session: flaky }));
    check(c1.latestCommittedGeneration === 1, 'head advances after reconciliation completes');
    // Runtime snapshot policy: the current host snapshot stays pinned.
    check(messageTexts(flaky.deriveMessages()).join('\n').indexOf('RUNTIME-POLICY-A') !== -1, 'current runtime snapshot remains pinned on the surface');
  }

  section('COMMIT-BEFORE-HEAD CRASH: reconstruct repairs without reapply');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const seed1 = a10builders.buildHappy('single');
    const session = a10builders.makeSessionDouble(seed1.events, seed1.surface);
    const fx1 = buildChainedFixture(session, 1, null, 'G1-crash');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx1.token.revisionDigest, snapshotTokenId: fx1.token.snapshotTokenId, safePointBoundarySeq: fx1.safe.boundarySeq,
    }));
    const res1 = await active.applyActiveCompactionV2(applyInputForGen(fx1, session, env, lock, 1));
    await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res1, postApplyVerified: true, session }));
    appendWork(session, 1);
    const fx2 = buildChainedFixture(session, 2, res1.checkpointId, 'G2-crash');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx2.token.revisionDigest, snapshotTokenId: fx2.token.snapshotTokenId, safePointBoundarySeq: fx2.safe.boundarySeq,
    }));
    const res2 = await active.applyActiveCompactionV2(applyInputForGen(fx2, session, env, lock, 2));
    check(res2.status === 'committed', 'G2 commits before the simulated crash');
    const eventsBefore = session.events.length;
    // Process dies before head advancement: restart reconstructs from disk.
    const revived = runtime.reconstructGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session, repairHead: true });
    check(revived.latestCommittedGeneration === 2, 'restart repairs the head to G2 (no reapply, no G1 stall)');
    check(revived.reconstructionOutcome === 'repaired-commit-before-head-crash', 'repair outcome is explicit');
    check(session.events.length === eventsBefore, 'repair appends nothing (G2 is not reapplied)');
    // Head-before-commit is an impossible state: a head without durable
    // application fails closed instead of rolling back.
    const fakeHead = {
      schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID,
      highestAllocatedGeneration: 9, latestCommittedGeneration: 9, latestCommittedCheckpointId: 'ccp_fake',
      lineage: [{ generation: 9, checkpointId: 'ccp_fake', parentCheckpointId: res1.checkpointId }], superseded: [],
      headDigest: null,
    };
    const rt = require(path.join(repoRoot, 'config', 'ContextGenerationRuntimeV2.cjs'));
    fakeHead.headDigest = rt.deriveRuntimeDigestV2(fakeHead);
    fs.writeFileSync(require('node:path').join(env.runtimeDir, 'context-generation-runtime-v2.json'), JSON.stringify(fakeHead, null, 2));
    let closed = false;
    try {
      runtime.reconstructGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session, repairHead: true });
    } catch (error) { closed = String((error && error.message) || error).indexOf('generation-runtime-corrupt') !== -1; }
    check(closed, 'head without durable checkpoint fails closed');
  }


  section('CRASH MATRIX: reservation / shadow / checkpoint-only / intent-only restarts');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const seed1 = a10builders.buildHappy('single');
    const session = a10builders.makeSessionDouble(seed1.events, seed1.surface);
    const fx1 = buildChainedFixture(session, 1, null, 'G1-matrix');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx1.token.revisionDigest, snapshotTokenId: fx1.token.snapshotTokenId, safePointBoundarySeq: fx1.safe.boundarySeq,
    }));
    const res1 = await active.applyActiveCompactionV2(applyInputForGen(fx1, session, env, lock, 1));
    await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res1, postApplyVerified: true, session }));
    // Reservation crash: G2 allocated/persisted, process dies before A09.
    appendWork(session, 1);
    const fx2 = buildChainedFixture(session, 2, res1.checkpointId, 'G2-matrix');
    const r2 = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx2.token.revisionDigest, snapshotTokenId: fx2.token.snapshotTokenId, safePointBoundarySeq: fx2.safe.boundarySeq,
    }));
    const revived = runtime.reconstructGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session, repairHead: true });
    check(revived.activeGeneration === 2 && revived.activeGenerationState === 'reserved', 'restart recovers the same G2 reservation (state reserved)');
    const r2b = await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx2.token.revisionDigest, snapshotTokenId: fx2.token.snapshotTokenId, safePointBoundarySeq: fx2.safe.boundarySeq,
    }));
    check(r2b.generation === 2 && r2b.reservationDigest === r2.reservationDigest, 'unchanged source resumes the same G2 (no rebinding, no new generation)');
    // Shadow crash: A09 shadow-ready exists but nothing persisted for apply.
    const eligShadow = runtime.assertGenerationEligibleForApplyV2({ taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session, generation: 2, shadowResult: fx2.result });
    check(eligShadow.eligible === true, 'shadow-crash G2 remains reserved and eligible (no mutation occurred)');
    // Checkpoint-only crash: sealed checkpoint persisted, no operation yet.
    const sealedSerialized = checkpointV2.serializeCheckpointCanonical(fx2.sealed);
    trustV2.persistSealedCheckpointV2(env.checkpointDir, { checkpoint: clone(fx2.sealed), serialized: sealedSerialized });
    const afterCkpt = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session });
    const ckptEntry = afterCkpt.generations.filter((g) => g.generation === 2)[0];
    check(ckptEntry.outcome === 'RESERVED' && ckptEntry.activeState === 'reserved', 'checkpoint-only G2 may resume the same generation (got ' + ckptEntry.outcome + '/' + ckptEntry.activeState + ')');
    // Intent-only crash with moved state: freeze intent, move state, restart
    // must supersede (zero landing proven) rather than rebind or apply.
    freezeIntentOnly(env, fx2, 2);
    appendWork(session, 0);
    const fx2moved = buildChainedFixture(session, 2, res1.checkpointId, 'G2-matrix-moved');
    const intentRestart = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session });
    check(intentRestart.activeGeneration === 2, 'intent-only restart still owns G2 (never silently dropped)');
    await runtime.supersedeGenerationV2(Object.assign({}, b, {
      generation: 2, observedRevisionDigest: fx2moved.token.revisionDigest,
      observedSafePointBoundarySeq: fx2moved.safe.boundarySeq,
      payloadText: payloadTextOf(fx2.sealed), session,
    }));
    const supState = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session });
    check(supState.generations.filter((g) => g.generation === 2)[0].outcome === 'SUPERSEDED', 'moved-state intent-only G2 supersedes after restart');
    // Restart never makes a superseded generation applicable again.
    const g2op = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 2));
    check(runtime.checkOperationSupersededV2({ runtimeDir: env.runtimeDir, operation: g2op }).superseded === true, 'supersession survives restart (durable, identity-bound)');
    const probe = compaction.reconcileCompactionOperationV2(g2op, session, { payloadText: payloadTextOf(fx2.sealed), durable: false });
    check(probe.decision === 'apply', 'raw reconcile still sees zero landing (the guard, not luck, blocks application)');
  }

  section('CORRUPTION / FORK: fail closed, never heuristic');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const seed1 = a10builders.buildHappy('single');
    const session = a10builders.makeSessionDouble(seed1.events, seed1.surface);
    const fx1 = buildChainedFixture(session, 1, null, 'G1-fork');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx1.token.revisionDigest, safePointBoundarySeq: fx1.safe.boundarySeq,
    }));
    // Unknown keys in the reservation record fail closed before digest use.
    const resPath = runtime.reservationFilePath(env.runtimeDir, 1);
    const recorded = JSON.parse(fs.readFileSync(resPath, 'utf8'));
    const tampered = Object.assign({}, recorded, { injected: 'MARK_G2_SUPERSEDED' });
    fs.writeFileSync(resPath, JSON.stringify(tampered, null, 2));
    let closedUnknown = false;
    try {
      runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: null });
    } catch (error) { closedUnknown = String((error && error.message) || error).indexOf('generation-runtime-corrupt') !== -1; }
    check(closedUnknown, 'unknown keys in durable metadata fail closed');
    fs.writeFileSync(resPath, JSON.stringify(recorded, null, 2));
    // Conflicting supersession markers for one generation are a fork.
    appendWork(session, 0);
    const fxMoved = buildChainedFixture(session, 1, null, 'G1-fork-moved');
    freezeIntentOnly(env, fx1, 1);
    await runtime.supersedeGenerationV2(Object.assign({}, b, {
      generation: 1, observedRevisionDigest: fxMoved.token.revisionDigest,
      observedSafePointBoundarySeq: fxMoved.safe.boundarySeq,
      payloadText: payloadTextOf(fx1.sealed), session,
    }));
    const markerPath = runtime.supersessionFilePath(env.runtimeDir, 1);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    const rival = Object.assign({}, marker, { observedRevisionDigest: fx1.token.revisionDigest });
    rival.supersessionDigest = runtime.deriveSupersessionDigestV2(rival);
    fs.writeFileSync(markerPath, JSON.stringify(rival, null, 2));
    let closedFork = false;
    try {
      await runtime.supersedeGenerationV2(Object.assign({}, b, {
        generation: 1, observedRevisionDigest: fxMoved.token.revisionDigest, payloadText: payloadTextOf(fx1.sealed), session,
      }));
    } catch (error) { closedFork = String((error && error.message) || error).indexOf('generation-runtime-fork') !== -1; }
    check(closedFork, 'conflicting supersession markers fail closed as fork');
    // Operation/checkpoint identity mismatch fails closed.
    const env2 = makeEnv();
    const b2 = bind(env2, makeLock());
    const s2 = a10builders.makeSessionDouble(seed1.events, seed1.surface);
    const f2 = buildChainedFixture(s2, 1, null, 'G1-mismatch');
    await runtime.reserveNextGenerationV2(Object.assign({}, b2, {
      revisionDigest: f2.token.revisionDigest, safePointBoundarySeq: f2.safe.boundarySeq,
    }));
    freezeIntentOnly(env2, f2, 1);
    const opPath = require('node:path').join(runtime.operationDirForGenerationV2(env2.operationRoot, 1), 'context-compaction-operation-v2.json');
    const opJson = JSON.parse(fs.readFileSync(opPath, 'utf8'));
    opJson.checkpointId = 'ccp_rival_identity';
    fs.writeFileSync(opPath, JSON.stringify(opJson, null, 2));
    let closedMismatch = false;
    try {
      runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env2.runtimeDir, checkpointDir: env2.checkpointDir, operationRoot: env2.operationRoot, session: null });
    } catch (error) { closedMismatch = String((error && error.message) || error).indexOf('generation-runtime-corrupt') !== -1; }
    check(closedMismatch, 'operation/checkpoint identity mismatch fails closed');
  }

  section('DETERMINISM / SECURITY / SECRET-SAFETY / TELEMETRY');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const seed1 = a10builders.buildHappy('single');
    const session = a10builders.makeSessionDouble(seed1.events, seed1.surface);
    const fx1 = buildChainedFixture(session, 1, null, 'G1-det');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx1.token.revisionDigest, safePointBoundarySeq: fx1.safe.boundarySeq,
    }));
    const res1 = await active.applyActiveCompactionV2(applyInputForGen(fx1, session, env, lock, 1));
    const c1 = await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: res1, postApplyVerified: true, session }));
    const rA = runtime.reconstructGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session, repairHead: true });
    const rB = runtime.reconstructGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session, repairHead: true });
    check(canon(rA) === canon(rB) && canon(rA) === canon(c1), 'identical artifacts reconstruct byte-identical state');
    // Security: structured validated state only; prompt/tool text is inert.
    await expectFail(runtime.commitGenerationV2(Object.assign({}, b, {
      generation: '2', activeResult: res1, postApplyVerified: true,
    })), 'generation must be a positive integer', 'string generation identity fails closed');
    await expectFail(runtime.supersedeGenerationV2(Object.assign({}, b, {
      generation: 1, observedRevisionDigest: 'MARK_G2_SUPERSEDED',
    })), 'observedRevisionDigest must be sha256 hex', 'prompt-style supersede marker has zero effect');
    await expectFail(runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx1.token.revisionDigest, safePointBoundarySeq: fx1.safe.boundarySeq, ADVANCE_HEAD: true,
    })), 'unknown field ADVANCE_HEAD', 'prompt-style reservation field has zero effect');
    const allDurable = [];
    const walkFiles = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const p = require('node:path').join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walkFiles(p);
        else allDurable.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walkFiles(env.runtimeDir);
    const blob = allDurable.join('\n');
    check(blob.indexOf('Carry the A11 chain') === -1, 'runtime records carry no prompt/checkpoint text');
    check(blob.indexOf('GENERATION=999') === -1, 'runtime records carry no injected text');
    // Telemetry: bounded facts only.
    const tel = runtime.generationTelemetryV2(c1);
    check(JSON.stringify(Object.keys(tel).sort()) === JSON.stringify(['activeGeneration', 'activeGenerationState', 'blockerCodes', 'highestAllocatedGeneration', 'latestCommittedCheckpointId', 'latestCommittedGeneration', 'parentCheckpointId', 'reconstructionOutcome', 'supersededGenerationCount', 'unresolvedGeneration'].sort()), 'telemetry exposes exactly the bounded fact set');
    check(tel.highestAllocatedGeneration === 1 && tel.latestCommittedGeneration === 1 && tel.activeGeneration === null, 'telemetry values are correct');
    check(JSON.stringify(tel).indexOf('Carry the A11 chain') === -1, 'telemetry carries no task content');
    // Eligibility matrix.
    const eligActive = runtime.assertGenerationEligibleForApplyV2({ taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session, generation: 1 });
    check(eligActive.eligible === false && eligActive.code === 'generation-already-committed', 'committed head is not eligible for re-apply');
    const eligGhost = runtime.assertGenerationEligibleForApplyV2({ taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session, generation: 9 });
    check(eligGhost.eligible === false && eligGhost.code === 'generation-not-active', 'unallocated generation is never eligible');
  }


  section('A11H ENTRY: one generation-aware active path, explicit commit stays separate');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    check(typeof runtime.applyCurrentGenerationV2 === 'function', 'generation-aware entry applyCurrentGenerationV2 exists');
    check(runtime.applyActiveCompactionV2 === undefined, 'runtime module carries no raw active primitive (layering is mechanical)');
    check(typeof runtime.reconcileGenerationV2 === 'function', 'gated generation recovery reconcileGenerationV2 exists');
    check(typeof runtime.snapshotProtectionOfV2 === 'function', 'snapshot lifecycle policy snapshotProtectionOfV2 exists');
    const seed = a10builders.buildHappy('single');
    const session = a10builders.makeSessionDouble(seed.events, seed.surface);
    const fx = buildChainedFixture(session, 1, null, 'G1-entry');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
    }));
    const out = await runtime.applyCurrentGenerationV2(entryInputForGen(fx, session, env, lock, 1));
    check(out.ok === true && out.activeResult.status === 'committed', 'entry applies G1 through the gate (got ' + out.activeResult.status + ')');
    check(out.activeResult.applicationDurable === true, 'entry result proves application durability');
    check(canon(stripIds(session.deriveMessages())) === canon(stripIds(fx.artifact.projectedMessages)), 'entry actual equals the A09 prediction');
    const st = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session });
    check(st.latestCommittedGeneration === null, 'entry never auto-advances the head (explicit commit stays separate)');
    await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: out.activeResult, postApplyVerified: true, session }));
    const st2 = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session });
    check(st2.latestCommittedGeneration === 1, 'explicit commit advances after entry apply');
    // Stale reservation binding never applies through the entry: fresh env,
    // G1 still active (uncommitted), request built from moved state.
    const envS = makeEnv();
    const lockS = makeLock();
    const bS = bind(envS, lockS);
    const seedS = a10builders.buildHappy('single');
    const sessS = a10builders.makeSessionDouble(seedS.events, seedS.surface);
    const fxS = buildChainedFixture(sessS, 1, null, 'G1-stale');
    await runtime.reserveNextGenerationV2(Object.assign({}, bS, {
      revisionDigest: fxS.token.revisionDigest, snapshotTokenId: fxS.token.snapshotTokenId, safePointBoundarySeq: fxS.safe.boundarySeq,
    }));
    appendWork(sessS, 0);
    const moved = buildChainedFixture(sessS, 1, null, 'G1-stale-moved');
    check(moved.token.revisionDigest !== fxS.token.revisionDigest, 'stale fixture really moved revisions');
    let staleCode = null;
    try {
      await runtime.applyCurrentGenerationV2(entryInputForGen(moved, sessS, envS, lockS, 1));
    } catch (error) { staleCode = String((error && error.message) || error); }
    check(staleCode !== null && staleCode.indexOf('generation-source-stale') !== -1, 'entry refuses a request that moved past its reservation (got ' + String(staleCode).slice(0, 120) + ')');
    check(sessS.events.length === moved.events.length, 'stale refusal mutates nothing');
  }

  section('A11H SUPERSEDED MATRIX: permanently non-applicable on every route');
  {
    const env = makeEnv();
    const lock = makeLock();
    const b = bind(env, lock);
    const seed1 = a10builders.buildHappy('single');
    const session = a10builders.makeSessionDouble(seed1.events, seed1.surface);
    const fx1 = buildChainedFixture(session, 1, null, 'G1-matrixH');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx1.token.revisionDigest, snapshotTokenId: fx1.token.snapshotTokenId, safePointBoundarySeq: fx1.safe.boundarySeq,
    }));
    const out1 = await runtime.applyCurrentGenerationV2(entryInputForGen(fx1, session, env, lock, 1));
    await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: out1.activeResult, postApplyVerified: true, session }));
    appendWork(session, 1);
    const fx2 = buildChainedFixture(session, 2, out1.activeResult.checkpointId, 'G2-matrixH');
    await runtime.reserveNextGenerationV2(Object.assign({}, b, {
      revisionDigest: fx2.token.revisionDigest, snapshotTokenId: fx2.token.snapshotTokenId, safePointBoundarySeq: fx2.safe.boundarySeq,
    }));
    // Stale pre-supersession handle: the request is built while G2 is active.
    const staleRequest = entryInputForGen(fx2, session, env, lock, 2);
    const preSup = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session });
    check(preSup.activeGeneration === 2, 'stale handle observes G2 as active before supersession');
    freezeIntentOnly(env, fx2, 2);
    appendWork(session, 0);
    const fx2moved = buildChainedFixture(session, 2, out1.activeResult.checkpointId, 'G2-matrixH-moved');
    await runtime.supersedeGenerationV2(Object.assign({}, b, {
      generation: 2, observedRevisionDigest: fx2moved.token.revisionDigest,
      observedSafePointBoundarySeq: fx2moved.safe.boundarySeq,
      payloadText: payloadTextOf(fx2.sealed), session,
    }));
    // Simulate process exit + restart: fresh reconstruction from disk.
    const restarted = runtime.reconstructGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session, repairHead: true });
    check(restarted.generations.filter((g) => g.generation === 2)[0].outcome === 'SUPERSEDED', 'restart preserves supersession');
    const eventsBefore = session.events.length;
    const attemptRoute = async (name, fn, fragment) => {
      let code = null;
      try { await fn(); } catch (error) { code = String((error && error.message) || error); }
      check(code !== null && code.indexOf(fragment) !== -1, name + ' (got ' + String(code).slice(0, 140) + ')');
    };
    await attemptRoute('stale-handle entry refuses after supersession', async () => {
      await runtime.applyCurrentGenerationV2(staleRequest);
    }, 'generation-cannot-supersede');
    await attemptRoute('entry retry refuses again', async () => {
      await runtime.applyCurrentGenerationV2(entryInputForGen(fx2, session, env, lock, 2));
    }, 'generation-cannot-supersede');
    await attemptRoute('gated reconcile refuses superseded recovery', async () => {
      await runtime.reconcileGenerationV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, generation: 2, session });
    }, 'permanently non-applicable');
    check(session.events.length === eventsBefore, 'every refused route appends zero events');
    check(runtime.generationCitationsOf(session, 2).length === 0, 'zero payload and zero anchors from refused routes');
    // Layering proof: the raw A02 primitive is unguarded by design (it lands
    // on a scratch copy), while every SUPPORTED route above refuses. This is
    // why production must consume the entry, never the primitive.
    const scratch = a10builders.makeSessionDouble(session.events, session.surface.nodes);
    const g2op = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 2));
    const landed = compaction.applyCompactionOperationV2(scratch, g2op, payloadTextOf(fx2.sealed), g2op);
    check(landed.landed.length === g2op.segments.length, 'raw A02 primitive would land (unguarded by design; entry-only discipline required)');
    check(session.events.length === eventsBefore, 'live session untouched by the layering probe (scratch copy only)');
  }

  section('A11H SNAPSHOT MATRIX: pinned vs shadowable per generation state');
  {
    // Case A: current committed generation pins the current snapshot; older
    // snapshots with no recovery dependency are shadowable.
    const envA = makeEnv();
    const lockA = makeLock();
    const bA = bind(envA, lockA);
    const seedA = a10builders.buildHappy('multi');
    const sessA = a10builders.makeSessionDouble(seedA.events, seedA.surface);
    const fxA = buildMultiFixture(sessA, 1, null);
    await runtime.reserveNextGenerationV2(Object.assign({}, bA, {
      revisionDigest: fxA.token.revisionDigest, snapshotTokenId: fxA.token.snapshotTokenId, safePointBoundarySeq: fxA.safe.boundarySeq,
    }));
    const outA = await runtime.applyCurrentGenerationV2(entryInputForGen(fxA, sessA, envA, lockA, 1));
    check(outA.activeResult.status === 'committed', 'snapshot-matrix G1 commits through the entry');
    await runtime.commitGenerationV2(Object.assign({}, bA, { generation: 1, activeResult: outA.activeResult, postApplyVerified: true, session: sessA }));
    const oldSeq = 2;
    const newSeq = appendRuntimeSnapshot(sessA, 'RUNTIME-POLICY-B');
    const protA = protectionOf(envA, sessA);
    check(runtime.validateSnapshotProtectionV2(protA).valid === true, 'protection record validates closed-world');
    check(protA.currentRuntimeSeq === newSeq, 'current runtime snapshot identified');
    const pinA = protA.snapshots.filter((s) => s.seq === newSeq)[0];
    check(pinA && pinA.protection === 'pinned' && pinA.reason === 'current-generation-requirement', 'current committed snapshot is PINNED');
    const oldA = protA.snapshots.filter((s) => s.seq === oldSeq)[0];
    check(oldA && oldA.protection === 'shadowable', 'older snapshot with no recovery dependency is shadowable');
    check(canon(protA) === canon(protectionOf(envA, sessA)), 'protection classification is deterministic');
    // Case B: unresolved partial apply pins every live snapshot; a newer
    // reservation over it is impossible.
    const envB = makeEnv();
    const lockB = makeLock();
    const bB = bind(envB, lockB);
    const seedB = a10builders.buildHappy('multi');
    let appendsB = 0;
    const hookB = { armed: true };
    const sessB = a10builders.makeSessionDouble(seedB.events, seedB.surface, {
      onAppend: () => { appendsB += 1; if (hookB.armed && appendsB >= 2) throw new Error('injected H2 crash'); },
    });
    const fxB = buildMultiFixture(sessB, 1, null);
    await runtime.reserveNextGenerationV2(Object.assign({}, bB, {
      revisionDigest: fxB.token.revisionDigest, safePointBoundarySeq: fxB.safe.boundarySeq,
    }));
    freezeIntentOnly(envB, fxB, 1);
    const opB = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(envB.operationRoot, 1));
    try { compaction.applyCompactionOperationV2(sessB, opB, payloadTextOf(fxB.sealed), opB); } catch { /* partial landing retained */ }
    hookB.armed = false;
    const r2B = appendRuntimeSnapshot(sessB, 'RUNTIME-POLICY-B2');
    const protB = protectionOf(envB, sessB);
    check(protB.snapshots.length >= 2, 'two live runtime snapshots during UNRESOLVED (got ' + protB.snapshots.length + ')');
    check(protB.snapshots.every((s) => s.protection === 'pinned'), 'UNRESOLVED generation pins every live snapshot (newer reservation cannot unpin)');
    check(protB.snapshots.filter((s) => s.seq !== protB.currentRuntimeSeq).every((s) => s.reason === 'unresolved-recovery-dependency'), 'non-current pins cite the recovery dependency');
    await expectFail(runtime.reserveNextGenerationV2(Object.assign({}, bB, {
      revisionDigest: fxB.token.revisionDigest, safePointBoundarySeq: fxB.safe.boundarySeq, session: sessB,
    })), 'generation-unresolved-operation', 'G2 reservation over UNRESOLVED G1 is impossible');
    // Case C: superseded zero-landing generation unpins its snapshots.
    const envC = makeEnv();
    const lockC = makeLock();
    const bC = bind(envC, lockC);
    const seedC = a10builders.buildHappy('single');
    const sessC = a10builders.makeSessionDouble(seedC.events, seedC.surface);
    const fxC1 = buildChainedFixture(sessC, 1, null, 'G1-snapC');
    await runtime.reserveNextGenerationV2(Object.assign({}, bC, {
      revisionDigest: fxC1.token.revisionDigest, safePointBoundarySeq: fxC1.safe.boundarySeq,
    }));
    const outC1 = await runtime.applyCurrentGenerationV2(entryInputForGen(fxC1, sessC, envC, lockC, 1));
    await runtime.commitGenerationV2(Object.assign({}, bC, { generation: 1, activeResult: outC1.activeResult, postApplyVerified: true, session: sessC }));
    const oldC = appendRuntimeSnapshot(sessC, 'RUNTIME-POLICY-OLD-C');
    appendWork(sessC, 1);
    const fxC2 = buildChainedFixture(sessC, 2, outC1.activeResult.checkpointId, 'G2-snapC');
    await runtime.reserveNextGenerationV2(Object.assign({}, bC, {
      revisionDigest: fxC2.token.revisionDigest, safePointBoundarySeq: fxC2.safe.boundarySeq,
    }));
    freezeIntentOnly(envC, fxC2, 2);
    appendWork(sessC, 0);
    const fxC2m = buildChainedFixture(sessC, 2, outC1.activeResult.checkpointId, 'G2-snapC-moved');
    await runtime.supersedeGenerationV2(Object.assign({}, bC, {
      generation: 2, observedRevisionDigest: fxC2m.token.revisionDigest,
      observedSafePointBoundarySeq: fxC2m.safe.boundarySeq,
      payloadText: payloadTextOf(fxC2.sealed), session: sessC,
    }));
    const newC = appendRuntimeSnapshot(sessC, 'RUNTIME-POLICY-NEW-C');
    const protC = protectionOf(envC, sessC);
    const oldEntryC = protC.snapshots.filter((s) => s.seq === oldC)[0];
    check(oldEntryC && oldEntryC.protection === 'shadowable', 'superseded zero-landing snapshot may become shadowable');
    check(protC.currentRuntimeSeq === newC && protC.snapshots.filter((s) => s.seq === newC)[0].protection === 'pinned', 'new current snapshot stays PINNED');
    check(canon(protC) === canon(protectionOf(envC, sessC)), 'superseded-state protection reconstructs identically (no in-memory pins)');
    // Case D: older committed lineage is shadowable once a newer
    // self-contained generation commits; the newest stays pinned.
    const envD = makeEnv();
    const lockD = makeLock();
    const bD = bind(envD, lockD);
    const seedD = a10builders.buildHappy('single');
    const sessD = a10builders.makeSessionDouble(seedD.events, seedD.surface);
    const fxD1 = buildChainedFixture(sessD, 1, null, 'G1-snapD');
    await runtime.reserveNextGenerationV2(Object.assign({}, bD, {
      revisionDigest: fxD1.token.revisionDigest, safePointBoundarySeq: fxD1.safe.boundarySeq,
    }));
    const outD1 = await runtime.applyCurrentGenerationV2(entryInputForGen(fxD1, sessD, envD, lockD, 1));
    await runtime.commitGenerationV2(Object.assign({}, bD, { generation: 1, activeResult: outD1.activeResult, postApplyVerified: true, session: sessD }));
    const oldD = appendRuntimeSnapshot(sessD, 'RUNTIME-POLICY-OLD-D');
    appendWork(sessD, 1);
    const fxD2 = buildChainedFixture(sessD, 2, outD1.activeResult.checkpointId, 'G2-snapD');
    await runtime.reserveNextGenerationV2(Object.assign({}, bD, {
      revisionDigest: fxD2.token.revisionDigest, safePointBoundarySeq: fxD2.safe.boundarySeq,
    }));
    const outD2 = await runtime.applyCurrentGenerationV2(entryInputForGen(fxD2, sessD, envD, lockD, 2));
    await runtime.commitGenerationV2(Object.assign({}, bD, { generation: 2, activeResult: outD2.activeResult, postApplyVerified: true, session: sessD }));
    const newD = appendRuntimeSnapshot(sessD, 'RUNTIME-POLICY-NEW-D');
    const protD = protectionOf(envD, sessD);
    check(protD.snapshots.filter((s) => s.seq === newD)[0].protection === 'pinned', 'newest committed snapshot is PINNED');
    const oldEntryD = protD.snapshots.filter((s) => s.seq === oldD)[0];
    check(oldEntryD && oldEntryD.protection === 'shadowable', 'older committed snapshot shadowable after self-contained successor (no recovery dependency)');
    check(canon(protD) === canon(protectionOf(envD, sessD)), 'committed-state protection reconstructs identically');
  }


  section('A11H ENTRY RECOVERY: unchanged partial recovers; moved partial refuses cleanly');
  {
    const buildPartial = () => {
      const env = makeEnv();
      const lock = makeLock();
      const b = bind(env, lock);
      const seed = a10builders.buildHappy('multi');
      let appends = 0;
      const hook = { armed: true };
      const sess = a10builders.makeSessionDouble(seed.events, seed.surface, {
        onAppend: () => { appends += 1; if (hook.armed && appends >= 2) throw new Error('injected entry-recovery crash'); },
      });
      return { env, lock, b, sess, hook };
    };
    // Unchanged partial: the entry drives A10 forward recovery to commit.
    {
      const { env, lock, b, sess, hook } = buildPartial();
      const fx = buildMultiFixture(sess, 1, null);
      await runtime.reserveNextGenerationV2(Object.assign({}, b, {
        revisionDigest: fx.token.revisionDigest, safePointBoundarySeq: fx.safe.boundarySeq,
      }));
      freezeIntentOnly(env, fx, 1);
      const op = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 1));
      try { compaction.applyCompactionOperationV2(sess, op, payloadTextOf(fx.sealed), op); } catch { /* partial retained */ }
      hook.armed = false;
      const out = await runtime.applyCurrentGenerationV2(entryInputForGen(fx, sess, env, lock, 1));
      check(out.ok === true && (out.activeResult.status === 'committed' || out.activeResult.status === 'recovered'), 'entry recovers unchanged partial (got ' + out.activeResult.status + ')');
      await runtime.commitGenerationV2(Object.assign({}, b, { generation: 1, activeResult: out.activeResult, postApplyVerified: true, session: sess }));
      const st = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: sess });
      check(st.latestCommittedGeneration === 1, 'head advances after entry-driven recovery');
    }
    // Moved partial: the entry refuses without new mutation (frozen A10
    // post-verify could never converge on drifted state either).
    {
      const { env, lock, b, sess, hook } = buildPartial();
      const fx = buildMultiFixture(sess, 1, null);
      await runtime.reserveNextGenerationV2(Object.assign({}, b, {
        revisionDigest: fx.token.revisionDigest, safePointBoundarySeq: fx.safe.boundarySeq,
      }));
      freezeIntentOnly(env, fx, 1);
      const op = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(env.operationRoot, 1));
      try { compaction.applyCompactionOperationV2(sess, op, payloadTextOf(fx.sealed), op); } catch { /* partial retained */ }
      hook.armed = false;
      appendWork(sess, 0);
      // Request bindings still match the reservation (revA), but the live
      // session drifted: the entry authorizes identity and invokes A10 once;
      // the frozen exact post-verify remains the semantic backstop and
      // fails the drifted recovery WITHOUT advancing anything.
      const outM = await runtime.applyCurrentGenerationV2(entryInputForGen(fx, sess, env, lock, 1));
      check(outM.activeResult.status === 'failed', 'moved partial fails at the frozen post-verify (got ' + outM.activeResult.status + ')');
      check(outM.activeResult.blockers.some((bl) => bl.code === 'active-post-apply-mismatch'), 'drift names the post-apply cause');
      const stM = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId: TASK_ID, taskInstanceId: TASK_INSTANCE, sessionId: SESSION_ID, runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: sess });
      // The retry completed the landing (fully landed) but the drifted
      // projection stays unverified: head unmoved, and only a
      // committed/recovered A10 result (impossible on drifted state) could
      // advance it. Safe stuck, never silent progress.
      check(stM.latestCommittedGeneration === null, 'failed recovery moves no head');
      check(stM.generations.filter((g) => g.generation === 1)[0].outcome === 'COMMITTED', 'completed landing classifies as commit-pending (projection unverified)');
    }
  }

  console.log('\nA11 unit: passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error('A11 TEST HARNESS FAIL:', e && e.stack ? e.stack : e); process.exit(1); });
}
