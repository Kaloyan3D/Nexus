'use strict';
/**
 * ContextActiveApplyV2.Tests.cjs - CCV2-A10 Transactional Active Apply proof.
 *
 * Proves the first REAL active CCv2 compaction path against the REAL
 * production authorities (no fakes above the DSH seam):
 *
 *   config/ContextActiveApplyV2.cjs (TransactionalCompactionApplierV2)
 *     orchestrates A01-A09H (shadow, snapshot, safe-point, gate, checkpoint,
 *     seal, pressure, retention, A02 operation lifecycle) and applies EXACTLY
 *     the already-proven A09H projection to a session surface.
 *
 * Sessions below are faithful in-memory doubles of the pinned DSH seam
 * (append-only positional log, surface replace splice, verbatim
 * deriveEventMessage mirror): the live-host file proves equivalence on the
 * real host. Every checkpoint/operation/snapshot/safe/gate/pressure/
 * retention/shadow decision is the real authority, never a stub.
 *
 * Covers: refusal matrix, stale/generation/route/basis drift, digest and
 * identity mismatch, closed-world input, success (single + multi segment),
 * shadow-vs-actual equivalence, current-user-once, protocol balance,
 * required-state survival, append-only log, idempotent retry, ambiguous
 * failure retry, partial-apply recovery, crash matrix (durable-state
 * injection, labeled honestly), restart, conflicts, error isolation,
 * serialization, security inertness, secret safety, A09 purity, telemetry.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const active = require(path.join(repoRoot, 'config', 'ContextActiveApplyV2.cjs'));
const shadow = require(path.join(repoRoot, 'config', 'ContextShadowV2.cjs'));
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));
const snapshotV2 = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const safepoint = require(path.join(repoRoot, 'config', 'ContextSafePointV2.cjs'));
const gate = require(path.join(repoRoot, 'config', 'ContextCheckpointabilityV2.cjs'));
const pressure = require(path.join(repoRoot, 'config', 'ContextPressureV2.cjs'));
const retention = require(path.join(repoRoot, 'config', 'ContextRetentionV2.cjs'));
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
function codes(r) { return (r.blockers || []).map((b) => b.code); }
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
function occurrences(haystack, needle) {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

const CREATED = '2026-09-25T10:00:00.000Z';
const RUNTIME_PLUGIN = '@deepseek-ai/dsh-system-prompt';

// ---- scaffold (frozen A09 host-free lineage; nothing faked) ------------------
function draftTaskState(boundary, sessionRev, over) {
  const ts = { schemaVersion: 1, taskId: 'TASK-A10', taskInstanceId: 'task_a10_0001', sessionId: 'sess-a10', workspaceId: '/tmp/nexus-a10', repositoryId: null, checkoutId: null, generation: 1, safePointBoundarySeq: boundary, sessionRevision: sessionRev, taskRevision: 'pending', repositoryRevision: { headCommit: 'abc123', indexDigest: null, worktreeDigest: null }, runtimeRevision: { runtimeSnapshotSeq: null }, objective: { text: 'Prove A10 transactional active apply.', status: 'in-progress' }, requirements: [{ id: 'R1', text: 'Apply exactly the shadow prediction.', status: 'active', evidenceRefs: ['ev-cmd-1'], sourceKind: 'controller' }], constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.', sourceKind: 'controller' }], progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'A10 apply', remainingMilestones: [] }, decisions: [{ id: 'D1', statement: 'Active apply is explicit.', authority: 'controller-established', status: 'active', evidenceRefs: [], sourceKind: 'controller' }], repository: { repositoryId: null, checkoutId: null, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null }, evidenceRefs: [{ schemaVersion: 1, evidenceId: 'ev-cmd-1', kind: 'command', locator: 'cmd:prove-a10', digest: null, observedAtUtc: CREATED, taskInstanceId: 'task_a10_0001', accessible: true, sourceKind: 'tool' }], failures: { activeFailures: [], rejectedHypotheses: [], retryState: null }, verification: { outcomes: [{ scope: 'unit', status: 'PENDING', detail: null, evidenceRefs: [] }], note: null }, continuation: { nextAction: 'Apply the shadow result.', unresolvedQuestions: [], recentUserIntent: 'Land A10.' }, provenance: {}, ephemeralState: [], unsupportedState: [], reconstructionRefs: [] };
  if (over) { for (const k of Object.keys(over)) ts[k] = over[k]; }
  return ts;
}
function provenanceFor(ts) {
  const P = {};
  const put = (p, sk, fk, refs) => { P[p] = { sourceKind: sk, fieldKind: fk, sourceRefs: refs, authorityScope: null }; };
  put('objective.text', 'controller', 'task-objective', ['controller:objective']);
  ts.requirements.forEach((r, i) => { put('requirements.' + i + '.text', r.sourceKind, 'requirement-text', ['user:req-' + r.id]); put('requirements.' + i + '.status', r.sourceKind, 'requirement-status', ['user:req-' + r.id]); });
  ts.constraints.forEach((c, i) => { put('constraints.' + i + '.text', c.sourceKind, 'constraint-text', ['user:constraint-' + i]); });
  ts.decisions.forEach((d, i) => { put('decisions.' + i + '.statement', d.sourceKind, 'decision-statement', ['controller:decision-' + d.id]); put('decisions.' + i + '.authority', d.sourceKind, 'decision-authority', ['controller:decision-' + d.id]); put('decisions.' + i + '.status', d.sourceKind, 'decision-status', ['controller:decision-' + d.id]); });
  ts.verification.outcomes.forEach((o, i) => { put('verification.outcomes.' + i + '.status', 'verification', 'verification-outcome', ['verification:' + o.scope]); });
  put('continuation.nextAction', 'controller', 'next-action', ['controller:continuation']);
  put('continuation.recentUserIntent', 'controller', 'user-intent', ['user:intent-event']);
  put('repository', 'repository', 'repository-fact', ['repository:HEAD']);
  return P;
}
function finalizeTs(ts) { const f = clone(ts); f.taskRevision = snapshotV2.deriveTaskRevision(f); f.provenance = provenanceFor(f); return f; }
function snapInputOf(ts) {
  return { taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, workspaceId: ts.workspaceId, repositoryId: ts.repositoryId, checkoutId: ts.checkoutId, generation: ts.generation, safePointBoundarySeq: ts.safePointBoundarySeq, sessionRevision: ts.sessionRevision, taskRevision: ts.taskRevision, repositoryRevision: clone(ts.repositoryRevision), runtimeRevision: null };
}
function safeDecisionFor(ts) {
  return { schemaVersion: 1, safe: true, boundarySeq: ts.safePointBoundarySeq, boundaryKind: 'assistant-turn-committed', blockers: [], inspectedRevision: { taskRevision: ts.taskRevision, sessionRevision: ts.sessionRevision, runtimeSnapshotId: null } };
}
function pressureFor(token, current) {
  return pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: 131072, currentContextTokens: current, costMethod: 'conservative-estimate', costExact: false, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: token.taskId, taskInstanceId: token.taskInstanceId, sessionId: token.sessionId, generation: token.generation, snapshotTokenId: token.snapshotTokenId, revisionDigest: token.revisionDigest });
}
function U(id, s, e, o) {
  const u = { unitId: id, eventSeqStart: s, eventSeqEnd: e, requiresContinuation: false, a07Coverage: null, durableReference: null, derivedNonAuthoritative: false, isCurrentUserTurn: false, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } };
  if (o) { for (const k of Object.keys(o)) u[k] = o[k]; }
  return u;
}
let evCounter = 0;
function evUser(text, source) { evCounter += 1; return { type: 'user/message', data: { id: 'msg-a10-' + evCounter, role: 'user', content: [{ type: 'text', text }], source: source || { kind: 'user' } } }; }
function evAssistant(text) { evCounter += 1; return { type: 'assistant/message', data: { turn: 't1', step: 's1', message: { id: 'msg-a10-' + evCounter, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } } }; }
function evRuntime(text) { evCounter += 1; return { type: 'user/message', data: { id: 'msg-a10-' + evCounter, role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: RUNTIME_PLUGIN, form: 'snapshot' } } }; }
function seqify(events) { return events.map((e, i) => Object.assign({}, e, { seq: i })); }
function boundaryCtx(events, taskRevision) {
  return { sessionEvents: events, sessionDurable: { flushedSeq: events.length - 1, flushParticipated: true }, controller: { taskStatus: 'active', transitionOpen: false, completionCommitted: false, taskRevision }, runtime: { currentSnapshotSeq: null, transitionOpen: false } };
}

// Faithful DSH-seam double: append-only positional log, surface replace
// splice mirroring host applySurfacePlan, verbatim deriveEventMessage mirror.
function makeSessionDouble(events, surfaceNodes, hooks) {
  const h = hooks || {};
  const session = {
    id: 'sess-a10',
    events: events.map((e) => clone(e)),
    surface: { nodes: surfaceNodes.slice() },
    append(type, data, opts) {
      if (typeof h.onAppend === 'function') h.onAppend(session, type, data, opts);
      const seq = session.events.length;
      session.events.push({ seq, type, data: clone(data) });
      const op = opts && opts.surfaceOp;
      if (op && op.op === 'replace') {
        const si = session.surface.nodes.indexOf(op.start);
        const ei = session.surface.nodes.indexOf(op.end);
        if (si === -1 || ei === -1 || si > ei) throw new Error('double: replacement span not found in surface order');
        session.surface.nodes.splice(si, ei - si + 1, seq);
      } else {
        session.surface.nodes.push(seq);
      }
      return { seq };
    },
    deriveMessages() {
      const out = [];
      for (const sq of session.surface.nodes) {
        const message = shadow.deriveProjectedMessageV2(session.events[sq]);
        if (message !== null && message !== undefined) out.push(message);
      }
      return out;
    },
  };
  return session;
}
function makeFakeLockClient(behavior) {
  const b = behavior || {};
  const state = { held: false, ownerId: null, log: [] };
  let ownerCounter = 0;
  async function acquire(call) {
    state.log.push('acquire');
    if (b.failAcquire) return { acquired: false, ownerId: null, leaseSeconds: 60, reason: b.failAcquire };
    if (state.held) return { acquired: false, ownerId: null, leaseSeconds: 60, reason: 'held-by-live-owner' };
    ownerCounter += 1;
    state.held = true;
    state.ownerId = 'fake-owner-' + ownerCounter;
    return { acquired: true, ownerId: state.ownerId, leaseSeconds: 60, reason: null };
  }
  async function renew(call) {
    state.log.push('renew');
    if (b.failRenew) return { renewed: false, expiresAtUtc: null, reason: 'injected-renew-loss' };
    if (!state.held || !call || call.ownerId !== state.ownerId) return { renewed: false, expiresAtUtc: null, reason: 'not-owner' };
    return { renewed: true, expiresAtUtc: '2030-01-01T00:00:00.000Z', reason: null };
  }
  async function release(call) {
    state.log.push('release');
    if (state.held && call && call.ownerId === state.ownerId) { state.held = false; state.ownerId = null; }
    return { released: true, reason: null };
  }
  return { _state: state, acquire: acquire, renew: renew, release: release };
}
function snapshotDouble(session) {
  return { events: clone(session.events), surface: session.surface.nodes.slice() };
}
function restoreDouble(snap) {
  return makeSessionDouble(snap.events, snap.surface);
}

// Full happy-path fixture through the REAL authorities.
function buildHappy(kind) {
  evCounter = 0;
  const multi = kind === 'multi';
  const boundary = multi ? 4 : 3;
  const events = multi
    ? seqify([evUser('u0'), evAssistant('a1'), evRuntime('RUNTIME-POLICY-A'), evUser('u3'), evAssistant('a4'), evUser('u5'), evAssistant('a6'), evUser('u7-current')])
    : seqify([evUser('u0'), evAssistant('a1'), evUser('u2'), evAssistant('a3'), evUser('u4'), evAssistant('a5'), evUser('u6-current')]);
  const surface = events.map((e) => e.seq);
  const units = multi
    ? [U('u-hist-1', 0, 1, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('u-runtime', 2, 2, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 500, method: 'provider-tokenizer', exact: true } }), U('u-mid', 3, 4, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('u-req-new', 5, 6, { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }), U('u-user', 7, 7, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } })]
    : [U('u-hist-1', 0, 1, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('u-derived', 2, 3, { derivedNonAuthoritative: true, tokenCost: { tokens: 2500, method: 'provider-tokenizer', exact: true } }), U('u-req-new', 4, 5, { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }), U('u-user', 6, 6, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } })];
  const ts = finalizeTs(draftTaskState(boundary, boundary));
  const token = snapshotV2.capture(snapInputOf(ts), CREATED);
  const safe = safeDecisionFor(ts);
  const g = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safe, snapshotToken: token });
  const p = pressureFor(token, 100000);
  const plan = retention.planRetentionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, boundaryContext: boundaryCtx(events, ts.taskRevision), contextUnits: units, protocolSpans: [] });
  const shadowInput = { schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, snapshotCurrentState: snapInputOf(ts), safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, retentionPlan: plan, taskState: ts, contextUnits: units, sessionEvents: events, surfaceNodes: surface, protocolSpans: [], createdAtUtc: CREATED, sealedAtUtc: CREATED };
  const result = shadow.evaluateShadowCompactionV2(shadowInput);
  assert.equal(result.verdict, 'shadow-ready', 'fixture must be shadow-ready, got ' + result.verdict + ' ' + JSON.stringify(result.blockers).slice(0, 300));
  const sealed = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId: null, safePointBoundarySeq: safe.boundarySeq, snapshotToken: token, taskState: ts, createdAtUtc: CREATED, sealedAtUtc: CREATED });
  const artifact = shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, sealedCheckpoint: sealed.sealedCheckpoint, retentionPlan: plan, snapshotToken: token, taskState: ts, contextUnits: units, sourceEvents: events, surfaceNodes: surface, protocolSpans: [] });
  assert.equal(artifact.projectionDigest, result.projection.projectionDigest, 'fixture artifact binds the shadow digest');
  return { ts, token, safe, g, p, plan, units, events, surface, result, sealed: sealed.sealedCheckpoint, artifact };
}
function applyInputFor(fx, over) {
  const session = (over && over.session !== undefined) ? over.session : makeSessionDouble(fx.events, fx.surface);
  const input = {
    schemaVersion: 1,
    taskId: fx.ts.taskId, taskInstanceId: fx.ts.taskInstanceId, sessionId: fx.ts.sessionId, generation: fx.ts.generation,
    shadowResult: fx.result, sealedCheckpoint: fx.sealed, projectionArtifact: fx.artifact,
    snapshotToken: fx.token, snapshotCurrentState: snapInputOf(fx.ts),
    safePointDecision: fx.safe, checkpointabilityDecision: fx.g, pressureDecision: fx.p,
    retentionPlan: fx.plan, taskState: fx.ts, contextUnits: fx.units, protocolSpans: [],
    session,
    checkpointDir: (over && over.checkpointDir !== undefined) ? over.checkpointDir : fs.mkdtempSync(path.join(os.tmpdir(), 'a10ckpt-')),
    operationDir: (over && over.operationDir !== undefined) ? over.operationDir : fs.mkdtempSync(path.join(os.tmpdir(), 'a10op-')),
    flushFn: (over && over.flushFn !== undefined) ? over.flushFn : (async () => true),
    serialization: (over && Object.prototype.hasOwnProperty.call(over, 'serialization')) ? over.serialization : makeFakeLockClient(),
  };
  if (over) {
    for (const k of Object.keys(over)) {
      if (k === 'session' || k === 'checkpointDir' || k === 'operationDir' || k === 'flushFn' || k === 'serialization') continue;
      input[k] = over[k];
    }
  }
  return input;
}
function opFileCount(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.indexOf('context-compaction-operation-v2') !== -1).length;
  } catch { return 0; }
}

async function main() {
  section('A10 AUTHORITY SHAPE (explicit API only, no auto-trigger)');
  check(typeof active.applyActiveCompactionV2 === 'function', 'explicit applyActiveCompactionV2 API exists');
  check(active.ACTIVE_APPLY_STATUSES.join(',') === 'refused,stale,committed,recovered,failed', 'bounded result statuses (no prepared, no auto states)');
  check(typeof shadow.evaluateShadowCompactionV2 === 'function' && shadow.applyActiveCompactionV2 === undefined, 'A09 shadow authority carries no active behavior');
  check(active.validateActiveResultV2({ schemaVersion: 1 }).valid === false, 'result validation rejects malformed input');

  section('SUCCESS: single segment commits exactly the shadow prediction');
  {
    const fx = buildHappy('single');
    const input = applyInputFor(fx);
    const eventsBefore = JSON.stringify(input.session.events);
    const res = await active.applyActiveCompactionV2(input);
    check(res.status === 'committed', 'single-segment apply commits (got ' + res.status + ' ' + JSON.stringify(res.blockers).slice(0, 200) + ')');
    check(res.mutated === true && res.durable === true, 'commit reports mutated + durable');
    check(res.operationId === fx.artifact.operationId && res.checkpointId === fx.result.checkpoint.checkpointId, 'result binds operation + checkpoint identity');
    check(res.shadowId === fx.result.shadowId && res.projectionDigest === fx.artifact.projectionDigest, 'result binds shadow + projection identity');
    check(active.validateActiveResultV2(res).valid === true, 'committed result validates closed-world');
    check(canon(input.session.deriveMessages()) === canon(fx.artifact.projectedMessages), 'actual deriveMessages() equals A09 projectedMessages (content-exact)');
    const digestBody = {};
    for (const k of ['schemaVersion', 'taskId', 'taskInstanceId', 'sessionId', 'generation', 'operationId', 'checkpointId', 'checkpointContentDigest', 'retentionPlanId', 'sourceSnapshotTokenId', 'sourceRevisionDigest', 'candidateCompactionBoundarySeq', 'segments', 'payloadText', 'replacementMessages', 'projectedEvents', 'projectedMessages']) digestBody[k] = fx.artifact[k];
    check(shadow.sha256HexUtf8(shadow.SHADOW_PROJECTION_DIGEST_DOMAIN_V2 + '\n' + shadow.serializeCanonical(digestBody)) === fx.artifact.projectionDigest, 'expected projection digest recomputes (structural proof)');
    const texts = messageTexts(input.session.deriveMessages()).join('\n');
    check(occurrences(texts, 'u6-current') === 1, 'current user request occurs exactly once');
    check(shadow.checkMessagesBalanced(input.session.deriveMessages()) === true, 'actual tool protocol is balanced');
    check(occurrences(texts, fx.artifact.payloadText) === 1, 'checkpoint payload representation occurs exactly once');
    check(occurrences(texts, 'Apply exactly the shadow prediction.') === 1, 'historical requirement survives exactly once via the payload');
    const post = input.session.events;
    check(post.length === fx.events.length + 1, 'log grew by exactly one replacement node');
    check(JSON.stringify(post.slice(0, fx.events.length)) === JSON.stringify(fx.events), 'raw-log prefix is byte-identical (append-only)');
    check(input.session.surface.nodes.length === 4, 'surface is payload plus retained suffix (got ' + input.session.surface.nodes.length + ')');
    const stored = compaction.readCompactionOperationV2(input.operationDir);
    check(stored !== null && stored.operationId === fx.artifact.operationId, 'durable A02 operation is readable after commit');
    check(JSON.stringify(stored.segments) === JSON.stringify(fx.artifact.segments), 'operation segments equal projection segments');
    const expectedOp = { taskId: fx.ts.taskId, taskInstanceId: fx.ts.taskInstanceId, sessionId: fx.ts.sessionId, workspace: fx.ts.workspaceId, repositoryId: null, checkoutId: null, checkpointGeneration: 1, checkpointId: fx.result.checkpoint.checkpointId };
    check(compaction.validateCompactionOperationV2(stored, expectedOp).valid === true, 'durable operation validates against the binding');
    const ckpt = trustV2.readSealedCheckpointV2(input.checkpointDir, 1);
    check(ckpt !== null && ckpt.checkpoint.checkpointId === fx.result.checkpoint.checkpointId, 'sealed checkpoint is durable + readable before history hides');
    check(JSON.stringify(active.activeApplyTelemetry(res)).indexOf(fx.artifact.payloadText.slice(0, 40)) === -1, 'telemetry carries no raw checkpoint payload');
    check(JSON.stringify(res).length < 20000, 'result is bounded telemetry (no prompt text)');
  }

  section('SUCCESS: multi segment (pinned runtime split) commits exactly');
  {
    const fx = buildHappy('multi');
    check(fx.artifact.segments.length === 2, 'fixture splits into two segments (got ' + fx.artifact.segments.length + ')');
    check(fx.artifact.segments[0].role === 'payload' && fx.artifact.segments[1].role === 'continuation', 'exactly one earliest payload plus continuation');
    const input = applyInputFor(fx);
    const res = await active.applyActiveCompactionV2(input);
    check(res.status === 'committed', 'multi-segment apply commits (got ' + res.status + ' ' + JSON.stringify(res.blockers).slice(0, 200) + ')');
    check(canon(input.session.deriveMessages()) === canon(fx.artifact.projectedMessages), 'multi actual equals multi shadow prediction');
    const texts = messageTexts(input.session.deriveMessages()).join('\n');
    check(occurrences(texts, fx.artifact.payloadText) === 1, 'one payload across segments (no duplicate payload)');
    check(occurrences(texts, 'nexus-context-continuation') === 1, 'one identity-only continuation anchor');
    check(occurrences(texts, 'u7-current') === 1, 'current user exactly once (multi)');
    check(shadow.checkMessagesBalanced(input.session.deriveMessages()) === true, 'multi protocol balanced');
    check(input.session.events.length === fx.events.length + 2, 'log grew by exactly one node per segment');
    check(JSON.stringify(input.session.events.slice(0, fx.events.length)) === JSON.stringify(fx.events), 'multi raw prefix append-only');
  }

  section('IDEMPOTENT RETRY: second call recovers without new mutation');
  {
    const fx = buildHappy('single');
    const input = applyInputFor(fx);
    const first = await active.applyActiveCompactionV2(input);
    check(first.status === 'committed', 'first call commits');
    const eventsAfterFirst = JSON.stringify(input.session.events);
    const messagesAfterFirst = canon(input.session.deriveMessages());
    const second = await active.applyActiveCompactionV2(input);
    check(second.status === 'recovered', 'second call recovers (got ' + second.status + ')');
    check(second.mutated === false && second.durable === true, 'retry reports no new mutation + durable');
    check(JSON.stringify(input.session.events) === eventsAfterFirst, 'retry appended nothing');
    check(canon(input.session.deriveMessages()) === messagesAfterFirst, 'retry leaves the projection identical');
    check(second.operationId === first.operationId, 'retry binds the same operation');
  }

  section('AMBIGUOUS FAILURE: flush fails after apply, retry recovers');
  {
    const fx = buildHappy('single');
    let flushOk = false;
    const input = applyInputFor(fx, { flushFn: async () => flushOk });
    const bad = await active.applyActiveCompactionV2(input);
    check(bad.status === 'failed' && bad.mutated === true, 'flush failure is a recoverable failure (never harmless)');
    check(bad.intentDurable === true && bad.applicationDurable === false && bad.durable === false, 'H3: intent durable, application NOT durable, durable follows application');
    check(codes(bad).indexOf('active-flush-failed') !== -1, 'failure names active-flush-failed');
    flushOk = true;
    const retry = await active.applyActiveCompactionV2(input);
    check(retry.status === 'recovered', 'retry after ambiguous failure recovers (got ' + retry.status + ')');
    check(canon(input.session.deriveMessages()) === canon(fx.artifact.projectedMessages), 'recovered projection equals the prediction');
  }

  section('H1 MANDATORY SERIALIZATION: no lock, no apply');
  {
    const fx = buildHappy('single');
    const ckptContents = (dir) => { try { return fs.readdirSync(dir); } catch (e) { return []; } };
    {
      const input = applyInputFor(fx, { serialization: null });
      const before = JSON.stringify(input.session.events);
      const res = await active.applyActiveCompactionV2(input);
      check(res.status === 'refused' && codes(res).indexOf('active-serialization-unavailable') !== -1, 'absent lock client refuses (got ' + res.status + ')');
      check(res.mutated === false && res.intentDurable === false && res.applicationDurable === false && res.durable === false, 'unavailable lock proves no durability of any kind');
      check(JSON.stringify(input.session.events) === before, 'refused apply touches nothing');
      check(ckptContents(input.checkpointDir).length === 0 && opFileCount(input.operationDir) === 0, 'refused apply persists nothing (lock precedes all durable work)');
    }
    {
      const input = applyInputFor(fx, { serialization: { acquire: async () => ({ acquired: true }) } });
      const res = await active.applyActiveCompactionV2(input);
      check(res.status === 'refused' && codes(res).indexOf('active-serialization-unavailable') !== -1, 'malformed lock client refuses');
    }
    {
      const lock = makeFakeLockClient({ failAcquire: 'held-by-live-owner' });
      const input = applyInputFor(fx, { serialization: lock });
      const before = JSON.stringify(input.session.events);
      const res = await active.applyActiveCompactionV2(input);
      check(res.status === 'refused' && codes(res).indexOf('active-serialization-conflict') !== -1, 'held lock refuses with conflict (got ' + res.status + ')');
      check(res.mutated === false, 'conflict refusal mutates nothing');
      check(JSON.stringify(input.session.events) === before, 'conflict refusal touches nothing');
      check(ckptContents(input.checkpointDir).length === 0 && opFileCount(input.operationDir) === 0, 'conflict refusal persists nothing (freshness never observed without the lock)');
      check(lock._state.log.join(',') === 'acquire', 'failed acquire performs no further lock steps');
    }
    {
      const lock = makeFakeLockClient({ failRenew: true });
      const ckptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10ckpt-'));
      const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10op-'));
      const input = applyInputFor(fx, { serialization: lock, checkpointDir: ckptDir, operationDir: opDir });
      const before = JSON.stringify(input.session.events);
      const res = await active.applyActiveCompactionV2(input);
      check(res.status === 'failed' && codes(res).indexOf('active-serialization-conflict') !== -1, 'renew loss fails closed (got ' + res.status + ')');
      check(res.mutated === false, 'renew loss applies nothing');
      check(res.intentDurable === true && res.applicationDurable === false && res.durable === false, 'H3: renew loss proves intent only');
      check(JSON.stringify(input.session.events) === before, 'renew loss touches nothing');
      check(opFileCount(opDir) === 1, 'renew loss keeps the durable intent for recovery');
      check(lock._state.log.join(',') === 'acquire,renew,release', 'ownership gate renews before any append; release always runs');
    }
    {
      const lock = makeFakeLockClient();
      const input = applyInputFor(fx, { serialization: lock });
      const res = await active.applyActiveCompactionV2(input);
      check(res.status === 'committed', 'locked apply commits');
      check(lock._state.log.join(',') === 'acquire,renew,release', 'lock order is acquire,renew,release (got ' + lock._state.log.join(',') + ')');
    }
  }

  section('H2 END-SEED TRANSPARENCY: marker-only restart forward-recovers');
  {
    const fx = buildHappy('single');
    const ckptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10ckpt-'));
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10op-'));
    let appends = 0;
    const flaky = makeSessionDouble(fx.events, fx.surface, { onAppend: () => { appends += 1; if (appends === 1) throw new Error('injected pre-landing crash'); } });
    const crashed = await active.applyActiveCompactionV2(applyInputFor(fx, { session: flaky, checkpointDir: ckptDir, operationDir: opDir }));
    check(crashed.status === 'failed' && crashed.intentDurable === true && crashed.applicationDurable === false, 'pre-landing crash keeps durable intent only');
    check(flaky.events.length === fx.events.length, 'nothing landed before the crash');
    check(opFileCount(opDir) === 1, 'intent is durably frozen before the crash');
    flaky.events.push({ seq: flaky.events.length, type: 'session/end-seed', time: 1, data: {} });
    const retry = await active.applyActiveCompactionV2(applyInputFor(fx, { session: flaky, checkpointDir: ckptDir, operationDir: opDir }));
    check(retry.status === 'committed', 'marker-only restart forward-recovers to commit (got ' + retry.status + ' ' + JSON.stringify(retry.blockers).slice(0, 200) + ')');
    check(retry.intentDurable === true && retry.applicationDurable === true, 'H3: forward recovery proves both legs');
    check(canon(flaky.deriveMessages()) === canon(fx.artifact.projectedMessages), 'post-recovery surface equals the original prediction');
    const texts = messageTexts(flaky.deriveMessages()).join('\n');
    check(occurrences(texts, fx.artifact.payloadText) === 1, 'exactly one payload after marker-tolerant recovery');
    check(occurrences(texts, 'u6-current') === 1, 'current user exactly once after recovery');
    check(shadow.checkMessagesBalanced(flaky.deriveMessages()) === true, 'protocol balanced after recovery');
  }

  section('H2 CASE B: real semantic change after intent still fails closed');
  {
    const fx = buildHappy('single');
    const ckptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10ckpt-'));
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10op-'));
    let appends = 0;
    const flaky = makeSessionDouble(fx.events, fx.surface, { onAppend: () => { appends += 1; if (appends === 1) throw new Error('injected pre-landing crash'); } });
    const crashed = await active.applyActiveCompactionV2(applyInputFor(fx, { session: flaky, checkpointDir: ckptDir, operationDir: opDir }));
    check(crashed.status === 'failed' && crashed.intentDurable === true, 'Case B setup keeps durable intent');
    flaky.append('user/message', { id: 'msg-real', role: 'user', content: [{ type: 'text', text: 'real late work' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
    const before = JSON.stringify(flaky.events);
    const retry = await active.applyActiveCompactionV2(applyInputFor(fx, { session: flaky, checkpointDir: ckptDir, operationDir: opDir }));
    check(retry.status === 'stale', 'real semantic change after intent fails closed (got ' + retry.status + ')');
    check(retry.mutated === false && JSON.stringify(flaky.events) === before, 'Case B mutates and appends nothing');
  }

  section('H3 DURABILITY SPLIT MATRIX');
  {
    const fx = buildHappy('single');
    const input = applyInputFor(fx);
    const first = await active.applyActiveCompactionV2(input);
    check(first.status === 'committed' && first.intentDurable === true && first.applicationDurable === true && first.durable === true, 'committed proves both legs; durable follows application');
    check(first.telemetry.intentDurable === true && first.telemetry.applicationDurable === true, 'telemetry carries the split');
    const second = await active.applyActiveCompactionV2(input);
    check(second.status === 'recovered' && second.intentDurable === true && second.applicationDurable === true, 'recovered proves both legs');
    const refusedRes = await active.applyActiveCompactionV2(applyInputFor(fx, { serialization: null }));
    check(refusedRes.intentDurable === false && refusedRes.applicationDurable === false && refusedRes.durable === false, 'refused proves neither leg');
    const crypto = require('node:crypto');
    const forged = {
      schemaVersion: 1, taskId: 't', taskInstanceId: 'ti', sessionId: 's', generation: 1,
      checkpointId: null, operationId: null, shadowId: null, projectionDigest: null,
      status: 'failed', mutated: true, durable: true, intentDurable: true, applicationDurable: false,
      blockers: [],
      telemetry: { operationId: null, checkpointId: null, generation: 1, sourceBoundary: null, segmentCount: null, sourceEventCount: null, projectionDigest: null, beforeMessageCount: null, afterMessageCount: null, beforeTokenEstimate: null, afterTokenEstimate: null, status: 'failed', mutated: true, durable: true, intentDurable: true, applicationDurable: false, reconciliationOutcome: null, blockerCodes: [] },
    };
    const digestBody = {};
    for (const k of active.ACTIVE_RESULT_EXACT_KEYS) { if (k !== 'resultDigest') digestBody[k] = forged[k]; }
    forged.resultDigest = crypto.createHash('sha256').update(active.ACTIVE_RESULT_DIGEST_DOMAIN_V1 + '\n' + shadow.serializeCanonical(digestBody), 'utf8').digest('hex');
    check(active.validateActiveResultV2(forged).valid === false, 'durable=true with applicationDurable=false is structurally invalid even with a consistent digest');
  }

  section('REFUSAL MATRIX: non-ready and drifted inputs never mutate');
  async function refusalCase(name, mutateInput, expectedCode, expectedStatus) {
    const fx = buildHappy('single');
    const input = applyInputFor(fx);
    mutateInput(fx, input);
    const before = JSON.stringify(input.session.events);
    const res = await active.applyActiveCompactionV2(input);
    const okStatus = expectedStatus.indexOf(res.status) !== -1;
    check(okStatus && codes(res).indexOf(expectedCode) !== -1, name + ' -> ' + expectedCode + ' (got ' + res.status + ' ' + JSON.stringify(res.blockers).slice(0, 160) + ')');
    check(res.mutated === false, name + ': mutated=false');
    check(JSON.stringify(input.session.events) === before, name + ': session untouched');
    check(opFileCount(input.operationDir) === 0, name + ': no durable operation created');
  }
  await refusalCase('shadow verdict not ready', (fx, input) => {
    const b = buildHappy('single');
    const lowP = pressure.measurePressureV2({ schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: 131072, currentContextTokens: 10000, costMethod: 'conservative-estimate', costExact: false, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: b.token.taskId, taskInstanceId: b.token.taskInstanceId, sessionId: b.token.sessionId, generation: b.token.generation, snapshotTokenId: b.token.snapshotTokenId, revisionDigest: b.token.revisionDigest });
    const lowPlan = retention.planRetentionV2({ schemaVersion: 1, taskId: b.ts.taskId, taskInstanceId: b.ts.taskInstanceId, sessionId: b.ts.sessionId, generation: b.ts.generation, snapshotToken: b.token, safePointDecision: b.safe, checkpointabilityDecision: b.g, pressureDecision: lowP, boundaryContext: boundaryCtx(b.events, b.ts.taskRevision), contextUnits: b.units, protocolSpans: [] });
    const notReady = shadow.evaluateShadowCompactionV2({ schemaVersion: 1, taskId: b.ts.taskId, taskInstanceId: b.ts.taskInstanceId, sessionId: b.ts.sessionId, generation: b.ts.generation, snapshotToken: b.token, snapshotCurrentState: snapInputOf(b.ts), safePointDecision: b.safe, checkpointabilityDecision: b.g, pressureDecision: lowP, retentionPlan: lowPlan, taskState: b.ts, contextUnits: b.units, sessionEvents: b.events, surfaceNodes: b.surface, protocolSpans: [], createdAtUtc: CREATED, sealedAtUtc: CREATED });
    if (notReady.verdict === 'shadow-ready') throw new Error('fixture must not be ready');
    input.shadowResult = notReady;
  }, 'active-shadow-not-ready', ['refused']);
  await refusalCase('unknown input key fails closed', (fx, input) => { input.injectedKey = 'x'; }, 'active-input-invalid', ['refused']);
  await refusalCase('stale snapshot (session moved)', (fx, input) => {
    const moved = snapInputOf(fx.ts); moved.sessionRevision = moved.sessionRevision + 1; input.snapshotCurrentState = moved;
  }, 'active-snapshot-stale', ['stale']);
  await refusalCase('revision mismatch (task moved)', (fx, input) => {
    const moved = snapInputOf(fx.ts); moved.taskRevision = 'tampered-revision'; input.snapshotCurrentState = moved;
  }, 'active-snapshot-stale', ['stale']);
  await refusalCase('generation drift', (fx, input) => { input.generation = 2; }, 'active-shadow-unproven', ['refused']);
  await refusalCase('boundary moved', (fx, input) => {
    const safe = clone(fx.safe); safe.boundarySeq = fx.safe.boundarySeq - 1; safe.inspectedRevision = clone(fx.safe.inspectedRevision); input.safePointDecision = safe;
  }, 'active-boundary-mismatch', ['stale']);
  await refusalCase('provider route drift', (fx, input) => {
    const p = clone(fx.p); p.providerModelId = 'other-model'; input.pressureDecision = p;
  }, 'active-route-drift', ['stale']);
  await refusalCase('pressure basis drift', (fx, input) => {
    const plan = clone(fx.plan); plan.pressureBasisDigest = 'tampered-basis'; input.retentionPlan = plan;
  }, 'active-retention-stale', ['stale']);
  await refusalCase('retention plan identity drift', (fx, input) => {
    const plan = clone(fx.plan); plan.retentionPlanId = 'crp_other'; input.retentionPlan = plan;
  }, 'active-retention-stale', ['stale']);
  await refusalCase('projection digest mismatch', (fx, input) => {
    const art = clone(fx.artifact); art.projectionDigest = '0'.repeat(64); input.projectionArtifact = art;
  }, 'active-projection-mismatch', ['refused']);
  await refusalCase('artifact payload tamper', (fx, input) => {
    const art = clone(fx.artifact); art.payloadText = art.payloadText + ' '; input.projectionArtifact = art;
  }, 'active-projection-mismatch', ['refused']);
  await refusalCase('checkpoint identity mismatch', (fx, input) => {
    const other = buildHappy('single');
    other.ts.taskId = 'TASK-A10-OTHER';
    const ts2 = finalizeTs(other.ts);
    const token2 = snapshotV2.capture(snapInputOf(ts2), CREATED);
    const sealed2 = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts2.taskId, taskInstanceId: ts2.taskInstanceId, sessionId: ts2.sessionId, generation: ts2.generation, parentCheckpointId: null, safePointBoundarySeq: ts2.safePointBoundarySeq, snapshotToken: token2, taskState: ts2, createdAtUtc: CREATED, sealedAtUtc: CREATED });
    input.sealedCheckpoint = sealed2.sealedCheckpoint;
  }, 'active-checkpoint-mismatch', ['refused']);
  await refusalCase('operation/projection segment tamper (block before mutation)', (fx, input) => {
    const art = clone(fx.artifact);
    art.segments = [{ start: 0, end: 2, sourceEventSeqs: [0, 1, 2], role: 'payload' }];
    input.projectionArtifact = art;
  }, 'active-projection-mismatch', ['refused']);

  section('STALE SHADOW S1->S2: continued work blocks without mutation');
  {
    const fx = buildHappy('single');
    const input = applyInputFor(fx);
    input.session.append('user/message', { id: 'msg-late', role: 'user', content: [{ type: 'text', text: 'late work' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
    const res = await active.applyActiveCompactionV2(input);
    check(res.status === 'stale', 'S2 session with S1 shadow is stale (got ' + res.status + ')');
    check(res.mutated === false, 'stale path never mutates');
    check(opFileCount(input.operationDir) === 0, 'stale path requires no durable operation');
  }

  section('CONFLICTS FAIL CLOSED');
  {
    const fx = buildHappy('single');
    const input = applyInputFor(fx);
    const other = buildHappy('single');
    const ts2 = finalizeTs(Object.assign(clone(other.ts), { taskId: 'TASK-A10-CONFLICT' }));
    const token2 = snapshotV2.capture(snapInputOf(ts2), CREATED);
    const sealed2 = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts2.taskId, taskInstanceId: ts2.taskInstanceId, sessionId: ts2.sessionId, generation: ts2.generation, parentCheckpointId: null, safePointBoundarySeq: ts2.safePointBoundarySeq, snapshotToken: token2, taskState: ts2, createdAtUtc: CREATED, sealedAtUtc: CREATED });
    const ckptMod = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
    trustV2.persistSealedCheckpointV2(input.checkpointDir, { checkpoint: clone(sealed2.sealedCheckpoint), serialized: ckptMod.serializeCheckpointCanonical(sealed2.sealedCheckpoint) });
    const res = await active.applyActiveCompactionV2(input);
    check(res.status === 'failed' && codes(res).indexOf('active-checkpoint-conflict') !== -1, 'same generation + different bytes fails closed (got ' + res.status + ' ' + JSON.stringify(res.blockers).slice(0, 160) + ')');
    check(res.mutated === false && JSON.stringify(input.session.events) === JSON.stringify(fx.events), 'checkpoint conflict never touches the live session');
  }
  {
    const fx = buildHappy('single');
    const input = applyInputFor(fx);
    const conflictOpId = compaction.deriveCanonicalOperationIdV2(fx.ts.taskId, fx.ts.taskInstanceId, fx.ts.sessionId, 1, 'ccp_conflict0000000000000000000001');
    const draft = {
      schemaVersion: 2, operationId: conflictOpId, attemptId: 'att-conflict',
      taskId: fx.ts.taskId, taskInstanceId: fx.ts.taskInstanceId, sessionId: fx.ts.sessionId,
      workspace: fx.ts.workspaceId, repositoryId: null, checkoutId: null,
      checkpointGeneration: 1, checkpointId: 'ccp_conflict0000000000000000000001',
      checkpointContentDigest: '0'.repeat(64), checkpointPath: null,
      snapshotTokenId: null, safePointBoundarySeq: 3,
      sourceEventSeqs: [0, 1, 2, 3],
      segments: [{ start: 0, end: 3, sourceEventSeqs: [0, 1, 2, 3], role: 'payload' }],
      lifecycle: 'frozen',
    };
    // Pre-freeze a conflicting operation directly through the A02 authority.
    // Digest '0'*64 is a placeholder: freeze only checks structure/identity,
    // and the conflict is detected by operation-id divergence before any use.
    const expected = { taskId: fx.ts.taskId, taskInstanceId: fx.ts.taskInstanceId, sessionId: fx.ts.sessionId, workspace: fx.ts.workspaceId, checkpointGeneration: 1, checkpointId: 'ccp_conflict0000000000000000000001' };
    check(compaction.validateCompactionOperationV2(draft, expected).valid === true, 'conflict-operation fixture validates structurally');
    compaction.freezeCompactionOperationV2(input.operationDir, draft, expected);
    const res = await active.applyActiveCompactionV2(input);
    check(res.status === 'failed' && codes(res).indexOf('active-operation-conflict') !== -1, 'foreign operation id fails closed (got ' + res.status + ' ' + JSON.stringify(res.blockers).slice(0, 160) + ')');
    check(res.mutated === false && JSON.stringify(input.session.events) === JSON.stringify(fx.events), 'operation conflict never touches the live session');
  }

  section('DURABILITY ORDERING: checkpoint and operation precede mutation');
  {
    const fx = buildHappy('single');
    const fileAsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'a10file-')), 'not-a-dir');
    fs.writeFileSync(fileAsDir, 'x');
    const input = applyInputFor(fx, { checkpointDir: fileAsDir });
    const res = await active.applyActiveCompactionV2(input);
    check(res.status === 'failed' && codes(res).indexOf('active-persist-failed') !== -1, 'checkpoint persistence failure blocks before mutation (got ' + res.status + ')');
    check(res.mutated === false && JSON.stringify(input.session.events) === JSON.stringify(fx.events), 'crashed-before-checkpoint leaves the session unmodified');
    check(opFileCount(path.dirname(fileAsDir)) === 0, 'no operation persisted without a checkpoint');
  }
  {
    const fx = buildHappy('single');
    const fileAsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'a10file-')), 'not-a-dir');
    fs.writeFileSync(fileAsDir, 'x');
    const input = applyInputFor(fx, { operationDir: fileAsDir });
    const res = await active.applyActiveCompactionV2(input);
    check(res.status === 'failed', 'operation persistence failure blocks (got ' + res.status + ' ' + JSON.stringify(res.blockers).slice(0, 160) + ')');
    check(res.mutated === false && JSON.stringify(input.session.events) === JSON.stringify(fx.events), 'crashed-before-durable-intent leaves the session unmodified');
  }

  section('PARTIAL APPLY RECOVERY: mid-apply crash converges (multi)');
  {
    const fx = buildHappy('multi');
    let appends = 0;
    const flaky = makeSessionDouble(fx.events, fx.surface, {
      onAppend: () => { appends += 1; if (appends === 2) throw new Error('injected mid-apply crash'); },
    });
    const ckptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10ckpt-'));
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10op-'));
    const input = applyInputFor(fx, { session: flaky, checkpointDir: ckptDir, operationDir: opDir, flushFn: async () => true });
    const crashed = await active.applyActiveCompactionV2(input);
    check(crashed.status === 'failed' && crashed.mutated === true, 'mid-apply crash is recoverable (never harmless)');
    check(crashed.intentDurable === true && crashed.applicationDurable === false && crashed.durable === false, 'H3: mid-apply crash proves intent only');
    // Restart injection: rebuild the session purely from durable event bytes
    // (no in-memory handle survives) and retry through the same dirs.
    const snap = snapshotDouble(flaky);
    const revived = restoreDouble(snap);
    const retryInput = applyInputFor(fx, { session: revived, checkpointDir: ckptDir, operationDir: opDir, flushFn: async () => true });
    const retry = await active.applyActiveCompactionV2(retryInput);
    check(retry.status === 'committed', 'partial landing forward-recovers to commit (got ' + retry.status + ' ' + JSON.stringify(retry.blockers).slice(0, 200) + ')');
    check(canon(revived.deriveMessages()) === canon(fx.artifact.projectedMessages), 'recovered surface equals the prediction');
    const texts = messageTexts(revived.deriveMessages()).join('\n');
    check(occurrences(texts, fx.artifact.payloadText) === 1, 'no duplicated payload after partial recovery');
    check(occurrences(texts, 'nexus-context-continuation') === 1, 'no duplicated continuation anchor');
    check(revived.events.length === fx.events.length + 2, 'exactly one node per segment after recovery');
  }

  section('RESTART: durable-state injection converges to the prediction');
  {
    const fx = buildHappy('single');
    const ckptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10ckpt-'));
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10op-'));
    const input = applyInputFor(fx, { checkpointDir: ckptDir, operationDir: opDir, flushFn: async () => true });
    const first = await active.applyActiveCompactionV2(input);
    check(first.status === 'committed', 'initial apply commits');
    // Simulate restart: only durable bytes survive (events log + dirs).
    const durableBytes = JSON.stringify(input.session.events);
    const durableSurface = JSON.stringify(input.session.surface.nodes);
    const restarted = makeSessionDouble(JSON.parse(durableBytes), JSON.parse(durableSurface));
    const retryInput = applyInputFor(fx, { session: restarted, checkpointDir: ckptDir, operationDir: opDir, flushFn: async () => true });
    const retry = await active.applyActiveCompactionV2(retryInput);
    check(retry.status === 'recovered', 'post-restart retry recognizes the completed operation (got ' + retry.status + ')');
    check(canon(restarted.deriveMessages()) === canon(fx.artifact.projectedMessages), 'restored projection equals the prediction');
    const texts = messageTexts(restarted.deriveMessages()).join('\n');
    check(occurrences(texts, 'u6-current') === 1, 'restored current user exactly once');
    check(shadow.checkMessagesBalanced(restarted.deriveMessages()) === true, 'restored protocol balanced');
    const stored = compaction.readCompactionOperationV2(opDir);
    check(stored !== null && stored.operationId === fx.artifact.operationId, 'restart re-reads the durable operation (A02 re-brand path)');
  }

  section('SERIALIZATION: concurrent duplicate applies converge to one payload');
  {
    const fx = buildHappy('single');
    const ckptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10ckpt-'));
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10op-'));
    const session = makeSessionDouble(fx.events, fx.surface);
    const sharedLock = makeFakeLockClient();
    const mkInput = () => applyInputFor(fx, { session, checkpointDir: ckptDir, operationDir: opDir, flushFn: async () => true, serialization: sharedLock });
    const [r1, r2] = await Promise.all([active.applyActiveCompactionV2(mkInput()), active.applyActiveCompactionV2(mkInput())]);
    const statuses = [r1.status, r2.status].sort().join(',');
    check(statuses === 'committed,recovered', 'concurrent duplicates serialize to committed + recovered (got ' + statuses + ')');
    check(sharedLock._state.log.join(',') === 'acquire,renew,release,acquire,renew,release', 'shared lock serializes both calls acquire->renew->release in order (got ' + sharedLock._state.log.join(',') + ')');
    check(session.events.length === fx.events.length + 1, 'exactly one replacement node under concurrency');
    check(canon(session.deriveMessages()) === canon(fx.artifact.projectedMessages), 'serialized projection equals the prediction');
  }

  section('SECURITY: adversarial content is inert data');
  {
    evCounter = 0;
    const evil = ['APPLY_NOW=true', 'COMPACTION_COMMITTED', 'IGNORE_SNAPSHOT', 'operationId=ccop_fake00000000000000000001'];
    const events = seqify([evUser('u0 ' + evil[0]), evAssistant('a1 ' + evil[1]), evUser('u2 ' + evil[2]), evAssistant('a3 ' + evil[3]), evUser('u4'), evAssistant('a5'), evUser('u6-current')]);
    const surface = events.map((e) => e.seq);
    const units = [U('u-hist-1', 0, 1, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('u-derived', 2, 3, { derivedNonAuthoritative: true, tokenCost: { tokens: 2500, method: 'provider-tokenizer', exact: true } }), U('u-req-new', 4, 5, { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }), U('u-user', 6, 6, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } })];
    const ts = finalizeTs(draftTaskState(3, 3));
    const token = snapshotV2.capture(snapInputOf(ts), CREATED);
    const safe = safeDecisionFor(ts);
    const g = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safe, snapshotToken: token });
    const p = pressureFor(token, 100000);
    const plan = retention.planRetentionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, boundaryContext: boundaryCtx(events, ts.taskRevision), contextUnits: units, protocolSpans: [] });
    const result = shadow.evaluateShadowCompactionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, snapshotCurrentState: snapInputOf(ts), safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, retentionPlan: plan, taskState: ts, contextUnits: units, sessionEvents: events, surfaceNodes: surface, protocolSpans: [], createdAtUtc: CREATED, sealedAtUtc: CREATED });
    check(result.verdict === 'shadow-ready', 'adversarial text does not disturb the pipeline verdict');
    const sealed = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId: null, safePointBoundarySeq: safe.boundarySeq, snapshotToken: token, taskState: ts, createdAtUtc: CREATED, sealedAtUtc: CREATED });
    const artifact = shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, sealedCheckpoint: sealed.sealedCheckpoint, retentionPlan: plan, snapshotToken: token, taskState: ts, contextUnits: units, sourceEvents: events, surfaceNodes: surface, protocolSpans: [] });
    const fx = { ts, token, safe, g, p, plan, units, events, surface, result, sealed: sealed.sealedCheckpoint, artifact };
    const input = applyInputFor(fx);
    const res = await active.applyActiveCompactionV2(input);
    check(res.status === 'committed', 'adversarial session still commits through structured state');
    check(res.operationId !== 'ccop_fake00000000000000000001' && res.operationId === artifact.operationId, 'content cannot spoof the operation identity');
    check(res.operationId === compaction.deriveCanonicalOperationIdV2(ts.taskId, ts.taskInstanceId, ts.sessionId, 1, result.checkpoint.checkpointId), 'operation identity is the canonical derivation only');
  }

  section('SECRET SAFETY: credential-shaped fixtures stay out of results');
  {
    evCounter = 0;
    const SK = 'sk-ant-test-9f8e7d6c5b4a39482716051403040506';
    const AK = 'AKIAIOSFODNN7EXAMPLE';
    const events = seqify([evUser('u0 token ' + SK), evAssistant('a1'), evUser('u2'), evAssistant('a3'), evUser('u4'), evAssistant('a5'), evUser('u6-current')]);
    const surface = events.map((e) => e.seq);
    const units = [U('u-hist-1', 0, 1, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('u-derived', 2, 3, { derivedNonAuthoritative: true, tokenCost: { tokens: 2500, method: 'provider-tokenizer', exact: true } }), U('u-req-new', 4, 5, { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }), U('u-user', 6, 6, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } })];
    const ts = finalizeTs(draftTaskState(3, 3, { requirements: [{ id: 'R1', text: 'Rotate ' + AK + ' after use.', status: 'active', evidenceRefs: ['ev-cmd-1'], sourceKind: 'controller' }] }));
    const token = snapshotV2.capture(snapInputOf(ts), CREATED);
    const safe = safeDecisionFor(ts);
    const g = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safe, snapshotToken: token });
    const p = pressureFor(token, 100000);
    const plan = retention.planRetentionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, boundaryContext: boundaryCtx(events, ts.taskRevision), contextUnits: units, protocolSpans: [] });
    const result = shadow.evaluateShadowCompactionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, snapshotCurrentState: snapInputOf(ts), safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, retentionPlan: plan, taskState: ts, contextUnits: units, sessionEvents: events, surfaceNodes: surface, protocolSpans: [], createdAtUtc: CREATED, sealedAtUtc: CREATED });
    check(result.verdict === 'shadow-ready', 'secret-shaped fixture stays shadow-ready (redaction, not refusal)');
    const sealed = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId: null, safePointBoundarySeq: safe.boundarySeq, snapshotToken: token, taskState: ts, createdAtUtc: CREATED, sealedAtUtc: CREATED });
    const artifact = shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, sealedCheckpoint: sealed.sealedCheckpoint, retentionPlan: plan, snapshotToken: token, taskState: ts, contextUnits: units, sourceEvents: events, surfaceNodes: surface, protocolSpans: [] });
    const fx = { ts, token, safe, g, p, plan, units, events, surface, result, sealed: sealed.sealedCheckpoint, artifact };
    const input = applyInputFor(fx);
    const res = await active.applyActiveCompactionV2(input);
    check(res.status === 'committed', 'secret-shaped session commits');
    check(JSON.stringify(res).indexOf(SK) === -1 && JSON.stringify(res).indexOf(AK) === -1, 'A10 result carries no raw secrets');
    check(JSON.stringify(active.activeApplyTelemetry(res)).indexOf(SK) === -1, 'A10 telemetry carries no raw secrets');
  }

  section('A09 PURITY: shadow stays observe-only after A10 exists');
  {
    const fx = buildHappy('single');
    const session = makeSessionDouble(fx.events, fx.surface);
    const before = JSON.stringify({ events: session.events, surface: session.surface.nodes, messages: session.deriveMessages() });
    const fpBefore = shadow.fingerprintLiveState({ sessionEvents: clone(session.events), deriveMessages: session.deriveMessages(), taskState: fx.ts, snapshotToken: fx.token, checkpointState: null, runtimeSnapshotIdentity: 'rss_none' });
    shadow.evaluateShadowCompactionV2({ schemaVersion: 1, taskId: fx.ts.taskId, taskInstanceId: fx.ts.taskInstanceId, sessionId: fx.ts.sessionId, generation: fx.ts.generation, snapshotToken: fx.token, snapshotCurrentState: snapInputOf(fx.ts), safePointDecision: fx.safe, checkpointabilityDecision: fx.g, pressureDecision: fx.p, retentionPlan: fx.plan, taskState: fx.ts, contextUnits: fx.units, sessionEvents: clone(session.events), surfaceNodes: session.surface.nodes.slice(), protocolSpans: [], createdAtUtc: CREATED, sealedAtUtc: CREATED });
    shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: fx.ts.taskId, taskInstanceId: fx.ts.taskInstanceId, sessionId: fx.ts.sessionId, generation: fx.ts.generation, sealedCheckpoint: clone(fx.sealed), retentionPlan: clone(fx.plan), snapshotToken: clone(fx.token), taskState: clone(fx.ts), contextUnits: clone(fx.units), sourceEvents: clone(session.events), surfaceNodes: session.surface.nodes.slice(), protocolSpans: [] });
    const after = JSON.stringify({ events: session.events, surface: session.surface.nodes, messages: session.deriveMessages() });
    const fpAfter = shadow.fingerprintLiveState({ sessionEvents: clone(session.events), deriveMessages: session.deriveMessages(), taskState: fx.ts, snapshotToken: fx.token, checkpointState: null, runtimeSnapshotIdentity: 'rss_none' });
    check(before === after && fpBefore === fpAfter, 'A09 evaluation + shared builder mutate nothing');
  }

  console.log('\nA10 unit: passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
}

// Shared with the two-process suite (which requires this file for fixture
// builders only): running under require() must not execute the matrix.
if (require.main === module) {
  main().catch((e) => { console.error('A10 TEST HARNESS FAIL:', e && e.stack ? e.stack : e); process.exit(1); });
}
module.exports = {
  CREATED,
  draftTaskState,
  provenanceFor,
  finalizeTs,
  snapInputOf,
  safeDecisionFor,
  pressureFor,
  boundaryCtx,
  U,
  makeSessionDouble,
  makeFakeLockClient,
  buildHappy,
  applyInputFor,
};
