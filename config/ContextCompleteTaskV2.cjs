'use strict';
/**
 * ContextCompleteTaskV2.cjs - CCV2-A13 Complete-Task integration authority.
 *
 * A13 integrates the PROVEN CCv2 Phase-A runtime into the real Nexus task
 * lifecycle. This module is the ONE narrow orchestration component
 * (conceptually ContextCompactionRuntimeV2). It observes controller
 * lifecycle state, invokes the frozen CCv2 authorities verbatim, and
 * returns a bounded integration outcome. It MUST NOT redefine pressure,
 * safe points, checkpointability, retention, projection, generation
 * semantics, recovery, or completion.
 *
 * Frozen stack consumed (never reimplemented): A01 projection (via A09
 * helpers), A02 durable operation + reconciliation (inside A10/A11 only),
 * A03 checkpoint V2 (inside A09/A10), A04 trust + seal (inside A09/A10),
 * A05 snapshot freshness, A05H hardening, A06 SafePointDetector, A07
 * CheckpointabilityGate, A08/A08H pressure + retention, A09/A09H shadow /
 * exact projection, A10/A10H transactional apply (ONLY through the A11
 * generation entry), A11/A11H multi-generation runtime, A12 crash /
 * concurrency / recovery hardening.
 *
 * Production path (architectural):
 *   Controller -> evaluateBoundary -> A11 generation-aware runtime entry
 *                                     -> A10 active transaction
 *                                     -> A02 transaction primitive
 * The controller NEVER calls raw A10 (applyActiveCompactionV2) or raw A02
 * where the A11 generation lifecycle applies. This module never calls raw
 * A10/A02 itself.
 *
 * COMPLETION AUTHORITY (critical invariant): CCv2 NEVER decides whether
 * the task is complete. Completion stays owned by the deterministic
 * controller (TaskController.ps1 Test-AihTaskCompletion via Task.ps1
 * -Action complete). This module takes controller-owned task status as
 * INPUT and exposes checkCompletionHealth() as a consistency GATE, never
 * a decision.
 *
 * EXISTING TASK LIFECYCLE (discovered, not invented):
 *   Task ledger + lifecycle : scripts/TaskController.ps1 (New-AihTask,
 *     Start-AihTaskAttempt, Add-AihAttemptEvent, Set-AihTaskEvidence,
 *     Add-AihTaskFailure, Test-AihTaskCompletion)
 *   Production CLI seam     : scripts/Task.ps1 -Action <verb>
 *   Session/message path    : config/AihController.cjs (session bindings
 *     reference the TaskController taskInstanceId)
 *   Compaction V1 bridge    : config/ContextCompaction.cjs (V1 UNCHANGED)
 * Eligible boundaries are committed controller states where an A06
 * observation is authoritative: assistant turn committed, tool result
 * committed, controller step committed, task completion committed.
 */
const durablePolicyV2 = require('./ContextDurableMutationPolicyV2.cjs');

const crypto = require('node:crypto');
const safepoint = require('./ContextSafePointV2.cjs');
const snapshotV2 = require('./ContextSnapshotV2.cjs');
const gate = require('./ContextCheckpointabilityV2.cjs');
const pressure = require('./ContextPressureV2.cjs');
const retention = require('./ContextRetentionV2.cjs');
const compactionV2 = require('./ContextCompaction.cjs');
const trustV2 = require('./ContextTrustV2.cjs');
const shadow = require('./ContextShadowV2.cjs');
const generation = require('./ContextGenerationRuntimeV2.cjs');

const COMPLETE_TASK_V2_SCHEMA_VERSION = 1;
const INTEGRATION_VERSION_ENV = 'NEXUS_CONTEXT_COMPACTION_V2';
const INTEGRATION_ACTIONS = Object.freeze(['none', 'blocked', 'compacted', 'recovered', 'failed']);
const TERMINAL_TASK_STATUSES = Object.freeze(['complete', 'failed', 'cancelled']);

const EVALUATE_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'taskId', 'taskInstanceId', 'sessionId',
  'runtimeDir', 'checkpointDir', 'operationRoot', 'lockWorkspace',
  'compactionVersion', 'controller', 'sessionDurable', 'hostRuntime',
  'provider', 'tokenObservation', 'session', 'taskState', 'contextUnits',
  'protocolSpans', 'serialization', 'flushFn', 'stateCache', 'createdAtUtc',
]);
const CONTROLLER_INPUT_EXACT_KEYS = Object.freeze([
  'taskStatus', 'transitionOpen', 'completionCommitted',
  'streamOpen', 'toolEdgeOpen', 'taskRevision',
]);
const DURABLE_INPUT_EXACT_KEYS = Object.freeze(['flushedSeq', 'flushParticipated']);
const HOST_RUNTIME_INPUT_EXACT_KEYS = Object.freeze(['currentSnapshotSeq', 'transitionOpen']);
const PROVIDER_INPUT_EXACT_KEYS = Object.freeze([
  'modelId', 'capacityTokens', 'capability', 'capacitySource',
]);
const TOKEN_OBSERVATION_INPUT_EXACT_KEYS = Object.freeze([
  'currentContextTokens', 'costMethod', 'costExact',
  'reservedOutputTokens', 'reservedProtocolTokens', 'reservedSafetyTokens',
]);
const HEALTH_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'taskId', 'taskInstanceId', 'sessionId',
  'runtimeDir', 'checkpointDir', 'operationRoot', 'session', 'terminal',
]);
const RESUME_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'taskId', 'taskInstanceId', 'sessionId',
  'runtimeDir', 'checkpointDir', 'operationRoot', 'session', 'flushFn',
]);
const RECOVER_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'taskId', 'taskInstanceId', 'sessionId',
  'runtimeDir', 'checkpointDir', 'operationRoot', 'lockWorkspace',
  'generation', 'session', 'serialization', 'pendingRequest',
]);

function failIntegration(message) { throw new Error(String(message)); }
function unknownKeyOf(value, exactKeys) {
  for (const key of Object.keys(value)) {
    if (exactKeys.indexOf(key) === -1) return key;
  }
  return null;
}
function isBoundedId(value, bound) {
  return typeof value === 'string' && value.length > 0 && value.length <= bound;
}
function sha256HexUtf8(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}
// Secret-safe detail bound: every surfaced string is truncated and scrubbed
// of credential-shaped material (A03/A04/A12 redaction discipline reused:
// bounded metadata only, never raw prompt or secret-bearing state).
function redactDetail(value) {
  let text = value === null || value === undefined ? '' : String(value);
  text = text.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-REDACTED');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+\/=\-]{8,}/gi, 'Bearer REDACTED');
  text = text.replace(/(api[_-]?key\s*[:=]\s*)([^\s,;}"]+)/gi, '$1REDACTED');
  text = text.replace(/((?:secret|token)\s*[:=]\s*)([^\s,;}"]+)/gi, '$1REDACTED');
  if (text.length > 300) text = text.slice(0, 300);
  return text;
}
function blocker(code, detail) {
  return Object.freeze({ code: String(code), detail: detail === null || detail === undefined ? null : redactDetail(detail) });
}
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
// ---- versioned activation (section 35) -----------------------------------
// Explicit versioned selector; the global production default is UNCHANGED
// (v1). CCv1 behavior is untouched when V2 is not selected: this module
// performs zero V2 work and returns evaluated:false.
function selectCompactionVersion(requested, env) {
  if (requested !== undefined && requested !== null && String(requested) !== '') {
    const want = String(requested).trim().toLowerCase();
    if (want === 'v2') return 'v2';
    if (want === 'v1') return 'v1';
    failIntegration('complete-task-unavailable: unknown compactionVersion ' + redactDetail(want));
  }
  const source = env && typeof env === 'object' ? env : process.env;
  const raw = String(source[INTEGRATION_VERSION_ENV] === undefined || source[INTEGRATION_VERSION_ENV] === null
    ? '' : source[INTEGRATION_VERSION_ENV]).trim().toLowerCase();
  if (raw === 'v2' || raw === '1' || raw === 'true' || raw === 'yes') return 'v2';
  return 'v1';
}

function normalizeEvaluateInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) failIntegration('complete-task-unavailable: input is required');
  const unknown = unknownKeyOf(raw, EVALUATE_INPUT_EXACT_KEYS);
  if (unknown !== null) failIntegration('complete-task-unavailable: unknown field ' + redactDetail(unknown));
  if (Number(raw.schemaVersion) !== COMPLETE_TASK_V2_SCHEMA_VERSION) failIntegration('complete-task-unavailable: schemaVersion must be 1');
  for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
    if (!isBoundedId(raw[key], 256)) failIntegration('complete-task-unavailable: ' + key + ' is required');
  }
  for (const key of ['runtimeDir', 'checkpointDir', 'operationRoot', 'lockWorkspace']) {
    if (typeof raw[key] !== 'string' || raw[key] === '') failIntegration('complete-task-unavailable: ' + key + ' is required');
  }
  const c = raw.controller;
  if (!c || typeof c !== 'object' || Array.isArray(c)) failIntegration('complete-task-unavailable: controller boundary state is required');
  const cUnknown = unknownKeyOf(c, CONTROLLER_INPUT_EXACT_KEYS);
  if (cUnknown !== null) failIntegration('complete-task-unavailable: unknown controller field ' + redactDetail(cUnknown));
  if (typeof c.taskStatus !== 'string' || c.taskStatus === '') failIntegration('complete-task-unavailable: controller.taskStatus is required');
  for (const key of ['transitionOpen', 'completionCommitted', 'streamOpen', 'toolEdgeOpen']) {
    if (typeof c[key] !== 'boolean') failIntegration('complete-task-unavailable: controller.' + key + ' must be boolean');
  }
  if (c.taskRevision !== null && c.taskRevision !== undefined && typeof c.taskRevision !== 'string') {
    failIntegration('complete-task-unavailable: controller.taskRevision must be a string or null');
  }
  const d = raw.sessionDurable;
  if (!d || typeof d !== 'object' || Array.isArray(d)) failIntegration('complete-task-unavailable: sessionDurable observation is required');
  if (unknownKeyOf(d, DURABLE_INPUT_EXACT_KEYS) !== null) failIntegration('complete-task-unavailable: unknown sessionDurable field');
  if (!Number.isInteger(d.flushedSeq) || d.flushedSeq < -1) failIntegration('complete-task-unavailable: sessionDurable.flushedSeq must be an integer >= -1');
  if (typeof d.flushParticipated !== 'boolean') failIntegration('complete-task-unavailable: sessionDurable.flushParticipated must be boolean');
  const r = raw.hostRuntime;
  if (!r || typeof r !== 'object' || Array.isArray(r)) failIntegration('complete-task-unavailable: hostRuntime observation is required');
  if (unknownKeyOf(r, HOST_RUNTIME_INPUT_EXACT_KEYS) !== null) failIntegration('complete-task-unavailable: unknown hostRuntime field');
  if (r.currentSnapshotSeq !== null && r.currentSnapshotSeq !== undefined && !Number.isInteger(r.currentSnapshotSeq)) {
    failIntegration('complete-task-unavailable: hostRuntime.currentSnapshotSeq must be an integer or null');
  }
  if (typeof r.transitionOpen !== 'boolean') failIntegration('complete-task-unavailable: hostRuntime.transitionOpen must be boolean');
  const p = raw.provider;
  if (!p || typeof p !== 'object' || Array.isArray(p)) failIntegration('complete-task-unavailable: provider capability observation is required');
  if (unknownKeyOf(p, PROVIDER_INPUT_EXACT_KEYS) !== null) failIntegration('complete-task-unavailable: unknown provider field');
  if (typeof p.modelId !== 'string' || p.modelId === '') failIntegration('complete-task-unavailable: provider.modelId is required');
  if (p.capacityTokens !== null && p.capacityTokens !== undefined && (!Number.isFinite(p.capacityTokens) || p.capacityTokens < 0)) {
    failIntegration('complete-task-unavailable: provider.capacityTokens must be a non-negative number or null');
  }
  const t = raw.tokenObservation;
  if (!t || typeof t !== 'object' || Array.isArray(t)) failIntegration('complete-task-unavailable: tokenObservation is required');
  if (unknownKeyOf(t, TOKEN_OBSERVATION_INPUT_EXACT_KEYS) !== null) failIntegration('complete-task-unavailable: unknown tokenObservation field');
  if (!Number.isFinite(t.currentContextTokens) || t.currentContextTokens < 0) {
    failIntegration('complete-task-unavailable: tokenObservation.currentContextTokens must be a non-negative number');
  }
  if (typeof t.costMethod !== 'string' || t.costMethod === '') failIntegration('complete-task-unavailable: tokenObservation.costMethod is required');
  if (typeof t.costExact !== 'boolean') failIntegration('complete-task-unavailable: tokenObservation.costExact must be boolean');
  if (!raw.session || typeof raw.session !== 'object') failIntegration('complete-task-unavailable: session is required');
  if (!raw.taskState || typeof raw.taskState !== 'object' || Array.isArray(raw.taskState)) {
    failIntegration('complete-task-unavailable: taskState is required');
  }
  if (!Array.isArray(raw.contextUnits)) failIntegration('complete-task-unavailable: contextUnits array is required');
  if (raw.protocolSpans !== undefined && raw.protocolSpans !== null && !Array.isArray(raw.protocolSpans)) {
    failIntegration('complete-task-unavailable: protocolSpans must be an array or null');
  }
  if (!raw.serialization || typeof raw.serialization !== 'object') failIntegration('complete-task-unavailable: serialization client is required');
  if (raw.flushFn !== undefined && raw.flushFn !== null && typeof raw.flushFn !== 'function') {
    failIntegration('complete-task-unavailable: flushFn must be a function or null');
  }
  if (raw.stateCache !== undefined && raw.stateCache !== null && (typeof raw.stateCache !== 'object' || Array.isArray(raw.stateCache))) {
    failIntegration('complete-task-unavailable: stateCache must be an object or null');
  }
  return raw;
}

function baseResult(n, fields) {
  return Object.freeze(Object.assign({
    schemaVersion: COMPLETE_TASK_V2_SCHEMA_VERSION,
    evaluated: true, compactionVersion: 'v2',
    taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
    pressureLevel: null, action: 'none', generation: null,
    checkpointId: null, operationId: null, projectionDigest: null, taskMayContinue: true,
    blockerCodes: Object.freeze([]), blockers: Object.freeze([]),
    idempotentRepeat: false, terminal: false, telemetry: null,
  }, fields || {}));
}
function telemetryOf(n, extra) {
  const e = extra || {};
  return Object.freeze({
    taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
    pressureLevel: e.pressureLevel !== undefined ? e.pressureLevel : null,
    generation: e.generation !== undefined ? e.generation : null,
    action: e.action ? e.action : 'none',
    checkpointId: e.checkpointId !== undefined ? e.checkpointId : null,
    operationId: e.operationId !== undefined ? e.operationId : null,
    tokensBefore: e.tokensBefore !== undefined ? e.tokensBefore : null,
    tokensAfterEstimate: e.tokensAfterEstimate !== undefined ? e.tokensAfterEstimate : null,
    recoveryOutcome: e.recoveryOutcome !== undefined ? e.recoveryOutcome : null,
    taskMayContinue: e.taskMayContinue !== false,
    blockerCodes: Object.freeze(((e.blockerCodes) || []).slice().sort()),
  });
}
function dirsOf(n) {
  return {
    taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
    runtimeDir: n.runtimeDir, checkpointDir: n.checkpointDir, operationRoot: n.operationRoot,
  };
}
function inspectRuntime(n, session) {
  return generation.inspectGenerationRuntimeV2(Object.assign(dirsOf(n), { schemaVersion: 1, session: session || null }));
}
function reconstructRuntime(n, session, repairHead) {
  return generation.reconstructGenerationRuntimeV2(Object.assign(dirsOf(n), {
    schemaVersion: 1, session: session || null, repairHead: repairHead === true,
  }));
}
// taskMayContinue is DERIVED from A11/A12 runtime state (sections 33, H2):
// false while an unresolved active compaction makes further task progress
// unsafe, AND false whenever the runtime state cannot be established at
// all (null/unknown: the system cannot prove no unresolved compaction
// exists). Only a successfully reconstructed clean/terminal runtime
// permits continuation.
function continueFromRuntime(st) {
  if (!st) return false;
  return st.unresolvedGeneration === null || st.unresolvedGeneration === undefined;
}
function blockedResult(n, st, pressureLevel, blockers, extra, forceFalse) {
  const codes = blockers.map((b) => b.code);
  const mayContinue = forceFalse === true ? false : continueFromRuntime(st);
  return baseResult(n, Object.assign({
    pressureLevel, action: 'blocked', taskMayContinue: mayContinue,
    blockerCodes: Object.freeze(codes.slice().sort()), blockers: Object.freeze(blockers),
    telemetry: telemetryOf(n, { pressureLevel, action: 'blocked', taskMayContinue: mayContinue, blockerCodes: codes }),
  }, extra || {}));
}
function failedResult(n, st, pressureLevel, blockers, extra, forceFalse) {
  const codes = blockers.map((b) => b.code);
  const mayContinue = forceFalse === true ? false : continueFromRuntime(st);
  return baseResult(n, Object.assign({
    pressureLevel, action: 'failed', taskMayContinue: mayContinue,
    blockerCodes: Object.freeze(codes.slice().sort()), blockers: Object.freeze(blockers),
    telemetry: telemetryOf(n, { pressureLevel, action: 'failed', taskMayContinue: mayContinue, blockerCodes: codes }),
  }, extra || {}));
}
// ---- projection validity (A01 global invariants, read-only) -----------------
function projectedMessagesOf(session) {
  if (session && typeof session.deriveMessages === 'function') {
    const messages = session.deriveMessages();
    if (!Array.isArray(messages)) failIntegration('complete-task-unavailable: session.deriveMessages() must return an array');
    return messages;
  }
  if (session && Array.isArray(session.events) && session.surface && Array.isArray(session.surface.nodes)) {
    const out = [];
    for (const sq of session.surface.nodes) {
      const message = shadow.deriveProjectedMessageV2(session.events[sq]);
      if (message !== null && message !== undefined) out.push(message);
    }
    return out;
  }
  failIntegration('complete-task-unavailable: session must expose deriveMessages() or events+surface');
  return [];
}
function messageTextsOf(messages) {
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
function currentUserMarkerOf(session) {
  if (!session || !Array.isArray(session.events) || session.events.length === 0) return null;
  for (let i = session.events.length - 1; i >= 0; i -= 1) {
    const event = session.events[i];
    if (!event || typeof event !== 'object') continue;
    let message = null;
    try { message = shadow.deriveProjectedMessageV2(event); } catch (e) { message = null; }
    if (message === null || message === undefined) continue;
    const role = message.role || (message.message && message.message.role);
    if (role === 'user') {
      const joined = messageTextsOf([message]).join('\n');
      return joined === '' ? null : joined;
    }
    if (role === 'assistant') break;
  }
  return null;
}
// Shared integration assertion (sections 39-40): current user exactly once
// (when present) and checkMessagesBalanced(...) === true at every resumable
// controller state. Pure observation; decides nothing.
function projectionValidityOf(session) {
  const messages = projectedMessagesOf(session);
  const balanced = shadow.checkMessagesBalanced(messages) === true;
  const marker = currentUserMarkerOf(session);
  let occurrences = 0;
  if (marker !== null) {
    const joined = messageTextsOf(messages).join('\n');
    occurrences = joined.split(marker).length - 1;
  }
  return { balanced, userMarkerPresent: marker !== null, userOccurrences: occurrences };
}

function evaluationFingerprint(n, st) {
  const events = (n.session && Array.isArray(n.session.events)) ? n.session.events : null;
  const lastDigest = events && events.length > 0
    ? sha256HexUtf8(shadow.serializeCanonical(events[events.length - 1])).slice(0, 32)
    : 'empty';
  return [
    String(n.controller.taskRevision === null || n.controller.taskRevision === undefined ? '' : n.controller.taskRevision),
    String(events ? events.length : -1), lastDigest,
    String(n.provider.modelId),
    String(st ? st.highestAllocatedGeneration : -1),
    String(st ? st.latestCommittedGeneration : -1),
  ].join('|');
}

// ---- main boundary evaluation (section 5 live flow) -------------------------
// H2 fail-closed wrapper: input validation still throws (caller contract),
// but ANY failure to establish runtime truth inside becomes a bounded
// failed/taskMayContinue=false result (never an exception, never continue).
async function evaluateBoundary(rawInput) {
  if (selectCompactionVersion(rawInput && rawInput.compactionVersion, process.env) === 'v2') durablePolicyV2.assertDurableMutationAllowedV2();
  const n = normalizeEvaluateInput(rawInput);
  try {
    return await evaluateBoundaryInner(n);
  } catch (error) {
    if (error && typeof error.message === 'string' && error.message.indexOf('complete-task-unavailable:') === 0) throw error;
    return failedResult(n, null, null, [blocker('integration-runtime-unreadable', error && error.message)]);
  }
}
async function evaluateBoundaryInner(n) {
  const version = selectCompactionVersion(n.compactionVersion, process.env);
  if (version !== 'v2') {
    // CCv1 path unchanged: zero V2 work (no checkpoint persist, no
    // generation allocation, no A10 operation, no model-facing mutation).
    return baseResult(n, {
      evaluated: false, compactionVersion: 'v1', action: 'none', taskMayContinue: true,
      telemetry: telemetryOf(n, { action: 'none', taskMayContinue: true }),
    });
  }
  durablePolicyV2.assertDurableMutationAllowedV2();
  const tokensBefore = n.tokenObservation.currentContextTokens;
  // Terminal tasks never start new generations (section 18): no fresh
  // reservation, no new active compaction. The health gate still observes
  // durable artifacts; unresolved state still blocks finalization.
  const terminalStatus = TERMINAL_TASK_STATUSES.indexOf(String(n.controller.taskStatus)) !== -1
    || n.controller.completionCommitted === true;
  if (terminalStatus) {
    let st = null;
    try {
      st = inspectRuntime(n, n.session);
    } catch (error) {
      return failedResult(n, null, null, [blocker('integration-terminal-inspect-failed', error && error.message)], { terminal: true });
    }
    if (!continueFromRuntime(st)) {
      let diagnosis = null;
      try {
        diagnosis = generation.reconcileGenerationV2(Object.assign(dirsOf(n), {
          schemaVersion: 1, generation: st.unresolvedGeneration, session: n.session,
        }));
      } catch (e) { diagnosis = null; }
      return baseResult(n, {
        pressureLevel: null, action: 'blocked', taskMayContinue: false, terminal: true,
        blockerCodes: Object.freeze(['generation-unresolved-operation']),
        blockers: Object.freeze([blocker('generation-unresolved-operation',
          'terminal task holds unresolved generation ' + st.unresolvedGeneration +
          (diagnosis && diagnosis.decision ? ' (reconcile: ' + diagnosis.decision + ')' : ''))]),
        telemetry: telemetryOf(n, {
          action: 'blocked', taskMayContinue: false,
          blockerCodes: ['generation-unresolved-operation'],
          recoveryOutcome: diagnosis && diagnosis.decision ? diagnosis.decision : 'unresolved',
        }),
      });
    }
    return baseResult(n, {
      pressureLevel: null, action: 'none', taskMayContinue: true, terminal: true,
      telemetry: telemetryOf(n, { action: 'none', taskMayContinue: true }),
    });
  }
  // Authoritative reconstruct BEFORE any new work (read-only, no repair on
  // the live path): unresolved compaction blocks new task progression
  // (sections 14-15); repair never runs on a live unflushed session.
  let st = null;
  try {
    st = reconstructRuntime(n, n.session, false);
  } catch (error) {
    return failedResult(n, null, null, [blocker('integration-reconstruct-failed', error && error.message)]);
  }
  if (!continueFromRuntime(st)) {
    return failedResult(n, st, null, [blocker('generation-unresolved-operation',
      'generation ' + st.unresolvedGeneration + ' must reconcile before new task progression')],
      { pendingGeneration: st.unresolvedGeneration });
  }
  // Exactly-once evaluation per committed state (section 10): repeated
  // callbacks on one unchanged authoritative revision converge without new
  // durable work. The fingerprint covers controller revision, live log
  // identity, provider route, and durable head identity.
  const cache = n.stateCache || null;
  const fingerprint = evaluationFingerprint(n, st);
  if (cache && cache.key === fingerprint && cache.result) {
    const prior = cloneJson(cache.result);
    prior.idempotentRepeat = true;
    return Object.freeze(prior);
  }
  const remember = (result) => {
    if (cache) {
      const cached = cloneJson(result);
      if (cached && typeof cached === 'object') delete cached.pendingRequest;
      cache.key = fingerprint;
      cache.result = cached;
    }
    return result;
  };
  // A06 safe-point observation (verbatim authority). Unsafe/open lifecycle
  // boundaries never compact (sections 9, 28): open stream, open tool edge,
  // open controller transition, and unflushed state all fail closed inside
  // the frozen detector; this layer adds no timing heuristic.
  let safe = null;
  try {
    safe = safepoint.detectSafePointV2({
      schemaVersion: 1,
      taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
      sessionEvents: cloneJson(n.session.events || []),
      sessionDurable: { flushedSeq: n.sessionDurable.flushedSeq, flushParticipated: n.sessionDurable.flushParticipated },
      controller: {
        taskStatus: n.controller.taskStatus,
        transitionOpen: n.controller.transitionOpen || n.controller.streamOpen || n.controller.toolEdgeOpen,
        completionCommitted: n.controller.completionCommitted,
        taskRevision: n.controller.taskRevision === undefined ? null : n.controller.taskRevision,
      },
      runtime: {
        currentSnapshotSeq: n.hostRuntime.currentSnapshotSeq === undefined ? null : n.hostRuntime.currentSnapshotSeq,
        transitionOpen: n.hostRuntime.transitionOpen,
      },
    });
  } catch (error) {
    return remember(failedResult(n, st, null, [blocker('integration-safepoint-failed', error && error.message)]));
  }
  if (!safe || safe.safe !== true) {
    const codes = ((safe && safe.blockers) || []).map((b) => b.code);
    return remember(blockedResult(n, st, null,
      [blocker('safe-point-unsafe', 'A06 reports no safe boundary' + (codes.length > 0 ? ' (' + codes.join(',') + ')' : ''))]));
  }
  // A05 state capture/freshness (verbatim authority). The CCv2 generation
  // is compaction-scoped: the controller-owned taskState is cloned (never
  // mutated) and bound to the candidate generation before capture, exactly
  // as the proven A11 chained fixtures do.
  const candidateGeneration = st.highestAllocatedGeneration + 1;
  const taskStateForCapture = cloneJson(n.taskState);
  taskStateForCapture.generation = candidateGeneration;
  taskStateForCapture.safePointBoundarySeq = safe.boundarySeq;
  if (!taskStateForCapture.taskRevision || taskStateForCapture.taskRevision === 'pending') {
    try {
      taskStateForCapture.taskRevision = snapshotV2.deriveTaskRevision(taskStateForCapture);
    } catch (error) {
      return remember(failedResult(n, st, null, [blocker('integration-task-revision-failed', error && error.message)]));
    }
  }
  let snapshotInput = null;
  try {
    snapshotInput = {
      taskId: taskStateForCapture.taskId, taskInstanceId: taskStateForCapture.taskInstanceId,
      sessionId: taskStateForCapture.sessionId, workspaceId: taskStateForCapture.workspaceId,
      repositoryId: taskStateForCapture.repositoryId === undefined ? null : taskStateForCapture.repositoryId,
      checkoutId: taskStateForCapture.checkoutId === undefined ? null : taskStateForCapture.checkoutId,
      generation: candidateGeneration,
      safePointBoundarySeq: safe.boundarySeq,
      sessionRevision: taskStateForCapture.sessionRevision,
      taskRevision: taskStateForCapture.taskRevision,
      repositoryRevision: cloneJson(taskStateForCapture.repositoryRevision),
      runtimeRevision: null,
    };
    snapshotV2.deriveTaskRevision(taskStateForCapture);
  } catch (error) {
    return remember(failedResult(n, st, null, [blocker('integration-snapshot-input-failed', error && error.message)]));
  }
  let token = null;
  try {
    token = snapshotV2.capture(snapshotInput, n.createdAtUtc || new Date().toISOString());
  } catch (error) {
    return remember(failedResult(n, st, null, [blocker('integration-snapshot-failed', error && error.message)]));
  }
  // A08 pressure observation (verbatim authority; section 7 trigger
  // semantics). No local threshold rule exists anywhere in this module.
  // Frozen A08 vocabulary: providerCapability is a /models capability
  // object or null (never an invented string); capacitySource admits only
  // the verifiable 'model-registry' claim (else null: caller-asserted
  // capacity, resolved by the frozen precedence). Anything else fails
  // closed inside the frozen authority -- this layer invents no value.
  const capabilityOrNull = (n.provider.capability !== null && typeof n.provider.capability === 'object'
    && !Array.isArray(n.provider.capability)) ? n.provider.capability : null;
  const sourceClaimOrNull = n.provider.capacitySource === 'model-registry' ? 'model-registry' : null;
  const pressureInputFor = (gen) => ({
    schemaVersion: 1,
    providerModelId: n.provider.modelId,
    providerCapability: capabilityOrNull,
    providerCapacityTokens: n.provider.capacityTokens === undefined ? null : n.provider.capacityTokens,
    capacitySource: sourceClaimOrNull,
    currentContextTokens: n.tokenObservation.currentContextTokens,
    costMethod: n.tokenObservation.costMethod,
    costExact: n.tokenObservation.costExact,
    reservedOutputTokens: n.tokenObservation.reservedOutputTokens === undefined ? null : n.tokenObservation.reservedOutputTokens,
    reservedProtocolTokens: n.tokenObservation.reservedProtocolTokens === undefined ? null : n.tokenObservation.reservedProtocolTokens,
    reservedSafetyTokens: n.tokenObservation.reservedSafetyTokens === undefined ? null : n.tokenObservation.reservedSafetyTokens,
    taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
    generation: gen, snapshotTokenId: token.snapshotTokenId, revisionDigest: token.revisionDigest,
  });
  let pressureDecision = null;
  try {
    pressureDecision = pressure.measurePressureV2(pressureInputFor(candidateGeneration));
  } catch (error) {
    return remember(failedResult(n, st, null, [blocker('integration-pressure-failed', error && error.message)]));
  }
  const level = pressureDecision.level;
  if (level === 'NORMAL' || level === 'ELEVATED') {
    // Low-pressure path is cheap (section 11): no checkpoint persist, no
    // generation allocation, no A10 operation, no model-facing mutation.
    // ELEVATED prepares/observes per frozen A08 policy (recommendation
    // 'prepare') without active compaction.
    return remember(baseResult(n, {
      pressureLevel: level, action: 'none', taskMayContinue: true,
      telemetry: telemetryOf(n, { pressureLevel: level, action: 'none', taskMayContinue: true, tokensBefore }),
    }));
  }
  if (level === 'UNKNOWN') {
    // Never invent capacity-based authorization (section 7).
    return remember(blockedResult(n, st, level, [blocker('pressure-unknown-capacity',
      'provider capacity is unknown; recommendation is ' + pressureDecision.recommendation)]));
  }
  if (level !== 'HIGH' && level !== 'CRITICAL') {
    return remember(failedResult(n, st, level, [blocker('integration-pressure-level-unexpected', 'level ' + level)]));
  }
  // CRITICAL follows the SAME safety gates as HIGH: safety still wins
  // (section 7). No gate is bypassed below.
  // Gate + reservation + retention + shadow + apply run inside
  // gateReserveApply so a generation-label mismatch converges honestly
  // (bounded recursion, at most one realignment): the bundle is rebuilt
  // for the owned generation only when the live source is unchanged
  // (recover path, section 30); moved source is superseded-if-eligible
  // and a fresh generation is considered later.
  const bundle = {
    taskStateForCapture, snapshotInput, token, safe,
    generation: candidateGeneration, pressureDecision,
  };
  return remember(await gateReserveApply(n, st, level, bundle, tokensBefore, pressureInputFor, 0));
}
// Recapture the A05 bundle for an explicitly owned generation label. Used
// only on the recover path (unchanged live source re-bound to its own
// reservation); the caller verifies the exact reservation binding after.
function recaptureForGeneration(n, safe, gen) {
  const taskStateForCapture = cloneJson(n.taskState);
  taskStateForCapture.generation = gen;
  taskStateForCapture.safePointBoundarySeq = safe.boundarySeq;
  if (!taskStateForCapture.taskRevision || taskStateForCapture.taskRevision === 'pending') {
    taskStateForCapture.taskRevision = snapshotV2.deriveTaskRevision(taskStateForCapture);
  }
  const snapshotInput = {
    taskId: taskStateForCapture.taskId, taskInstanceId: taskStateForCapture.taskInstanceId,
    sessionId: taskStateForCapture.sessionId, workspaceId: taskStateForCapture.workspaceId,
    repositoryId: taskStateForCapture.repositoryId === undefined ? null : taskStateForCapture.repositoryId,
    checkoutId: taskStateForCapture.checkoutId === undefined ? null : taskStateForCapture.checkoutId,
    generation: gen,
    safePointBoundarySeq: safe.boundarySeq,
    sessionRevision: taskStateForCapture.sessionRevision,
    taskRevision: taskStateForCapture.taskRevision,
    repositoryRevision: cloneJson(taskStateForCapture.repositoryRevision),
    runtimeRevision: null,
  };
  const token = snapshotV2.capture(snapshotInput, n.createdAtUtc || new Date().toISOString());
  return { taskStateForCapture, snapshotInput, token, safe, generation: gen };
}
function readOwnedReservation(n, gen) {
  try {
    return generation.readReservationV2(n.runtimeDir, gen, dirsOf(n));
  } catch (e) { return null; }
}
// Derive zero-landing proof from durable evidence when the sealed
// checkpoint survived (crash between A10 sealed-persist and apply). Fails
// soft (null) when unprovable: supersession then refuses fail-closed.
function durablePayloadTextOf(n, gen) {
  try {
    const stored = trustV2.readSealedCheckpointV2(n.checkpointDir, gen);
    const sealedCkpt = stored && stored.checkpoint ? stored.checkpoint : stored;
    if (!sealedCkpt) return null;
    return shadow.checkpointPayloadTextOf(sealedCkpt);
  } catch (e) { return null; }
}
async function supersedeWithLiveEvidence(n, gen, observedRevisionDigest, safe) {
  return supersedeQuietly(n, gen, { taskRevision: observedRevisionDigest },
    safe, durablePayloadTextOf(n, gen), n.session);
}
// A07 checkpointability (verbatim authority), then A11 reservation.
async function gateReserveApply(n, st, level, bundle, tokensBefore, pressureInputFor, attempt) {
  const safe = bundle.safe;
  let gateDecision = null;
  try {
    gateDecision = gate.evaluateCheckpointabilityV2({
      schemaVersion: 1, taskState: bundle.taskStateForCapture, safePointDecision: safe, snapshotToken: bundle.token,
    });
  } catch (error) {
    return failedResult(n, st, level, [blocker('integration-checkpointability-failed', error && error.message)],
      { generation: bundle.generation });
  }
  if (!gateDecision || gateDecision.checkpointable !== true) {
    const codes = ((gateDecision && gateDecision.blockers) || []).map((b) => b.code);
    // Non-checkpointable state is left untouched (section 12): the owned
    // reservation (if any) stays RESERVED for an unchanged-source repeat
    // and is superseded honestly once source moves.
    return blockedResult(n, st, level,
      [blocker('checkpoint-not-checkpointable', 'A07 refuses checkpoint' + (codes.length > 0 ? ' (' + codes.join(',') + ')' : ''))],
      { generation: bundle.generation });
  }
  // A11 generation reservation / ownership (verbatim authority).
  let reservation = null;
  try {
    reservation = await generation.reserveNextGenerationV2({
      schemaVersion: 1, taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
      runtimeDir: n.runtimeDir, checkpointDir: n.checkpointDir, operationRoot: n.operationRoot,
      revisionDigest: bundle.token.revisionDigest, snapshotTokenId: bundle.token.snapshotTokenId,
      safePointBoundarySeq: safe.boundarySeq, session: n.session,
      serialization: n.serialization, lockWorkspace: n.lockWorkspace,
    });
  } catch (error) {
    return await handleReserveConflict(n, st, level, bundle, tokensBefore, pressureInputFor, attempt, error);
  }
  if (Number(reservation.generation) !== Number(bundle.generation)) {
    return await alignOwnedReservation(n, st, level, bundle, reservation, tokensBefore, pressureInputFor, attempt);
  }
  return await continueAfterReserve(n, st, level, bundle, gateDecision, bundle.pressureDecision, reservation, tokensBefore);
}
// The reserve call converged on a generation other than our candidate
// label (same-binding repeat or cross-process race). Reuse is allowed
// ONLY on byte-identical source binding (recover path); anything else is
// moved source and follows supersede-if-eligible (section 30).
async function alignOwnedReservation(n, st, level, bundle, reservation, tokensBefore, pressureInputFor, attempt) {
  const target = reservation.generation;
  const fresh = inspectRuntime(n, n.session);
  if (fresh.activeGeneration === null || Number(fresh.activeGeneration) !== Number(target)) {
    return blockedResult(n, fresh, level, [blocker('generation-not-active',
      'reservation G' + target + ' is not the active generation')], { generation: target });
  }
  const stored = readOwnedReservation(n, target);
  const labelOnly = stored
    && stored.revisionDigest === bundle.token.revisionDigest
    && Number(stored.safePointBoundarySeq) === Number(bundle.safe.boundarySeq);
  if (!labelOnly || attempt >= 1) {
    await supersedeWithLiveEvidence(n, target, bundle.token.revisionDigest, bundle.safe);
    const after = inspectRuntime(n, n.session);
    return blockedResult(n, after, level, [blocker('generation-reservation-conflict',
      'reservation G' + target + ' binds another source state; supersede attempted, fresh generation later')],
      { generation: target });
  }
  // Unchanged live source: rebuild the bundle for the owned generation and
  // verify the EXACT reservation binding before proceeding. The recursion
  // re-reserves with the identical binding (converges on the same G).
  let rebuilt = null;
  try {
    rebuilt = recaptureForGeneration(n, bundle.safe, target);
  } catch (error) {
    return failedResult(n, fresh, level, [blocker('integration-snapshot-failed', error && error.message)], { generation: target });
  }
  if (rebuilt.token.revisionDigest !== stored.revisionDigest || rebuilt.token.snapshotTokenId !== stored.snapshotTokenId) {
    await supersedeWithLiveEvidence(n, target, rebuilt.token.revisionDigest, bundle.safe);
    const after = inspectRuntime(n, n.session);
    return blockedResult(n, after, level, [blocker('generation-reservation-conflict',
      'live source moved during alignment; supersede attempted, fresh generation later')], { generation: target });
  }
  let pressureForTarget = bundle.pressureDecision;
  try {
    pressureForTarget = pressure.measurePressureV2(Object.assign(pressureInputFor(target), {
      snapshotTokenId: rebuilt.token.snapshotTokenId, revisionDigest: rebuilt.token.revisionDigest,
    }));
  } catch (error) {
    return failedResult(n, fresh, level, [blocker('integration-pressure-failed', error && error.message)], { generation: target });
  }
  const nextBundle = {
    taskStateForCapture: rebuilt.taskStateForCapture, snapshotInput: rebuilt.snapshotInput,
    token: rebuilt.token, safe: bundle.safe, generation: target, pressureDecision: pressureForTarget,
  };
  return await gateReserveApply(n, fresh, level, nextBundle, tokensBefore, pressureInputFor, attempt + 1);
}
// A09 exact shadow projection + seal + A11 entry + explicit head advance.
async function shadowApplyCommit(n, st, level, token, safe, snapshotInput, taskStateForCapture,
  gateDecision, pressureForGeneration, plan, reservation, tokensBefore) {
  const targetGeneration = reservation.generation;
  // A09 exact shadow projection (verbatim authority). A non-ready shadow
  // closes the owned reservation via zero-landing supersession (nothing was
  // ever applied) and reports blocked: live task state remains unchanged
  // (section 12).
  const surfaceNodes = (n.session.surface && Array.isArray(n.session.surface.nodes)) ? n.session.surface.nodes.slice() : [];
  const shadowInput = {
    schemaVersion: 1, taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
    generation: targetGeneration, parentCheckpointId: reservation.parentCommittedCheckpointId,
    snapshotToken: token, snapshotCurrentState: snapshotInput, safePointDecision: safe,
    checkpointabilityDecision: gateDecision, pressureDecision: pressureForGeneration,
    retentionPlan: plan, taskState: taskStateForCapture, contextUnits: cloneJson(n.contextUnits),
    sessionEvents: cloneJson(n.session.events || []), surfaceNodes,
    protocolSpans: cloneJson(n.protocolSpans || []),
    createdAtUtc: n.createdAtUtc || new Date().toISOString(), sealedAtUtc: n.createdAtUtc || new Date().toISOString(),
  };
  let shadowResult = null;
  try {
    shadowResult = shadow.evaluateShadowCompactionV2(shadowInput);
  } catch (error) {
    return failedResult(n, st, level, [blocker('integration-shadow-failed', error && error.message)],
      { generation: targetGeneration });
  }
  if (!shadowResult || shadowResult.verdict !== 'shadow-ready') {
    const codes = ((shadowResult && shadowResult.blockers) || []).map((b) => b.code);
    return blockedResult(n, st, level,
      [blocker('retention-no-useful-cut', 'A09 shadow is ' + (shadowResult ? shadowResult.verdict : 'missing') +
        (codes.length > 0 ? ' (' + codes.join(',') + ')' : ''))],
      { generation: targetGeneration });
  }
  // Sealed checkpoint + projection artifact (verbatim A09 builders). The
  // artifact MUST bind the shadow digest (A09 exact-projection invariant).
  let sealed = null;
  let artifact = null;
  try {
    const builtSealed = shadow.buildShadowCheckpointV2({
      schemaVersion: 1, taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
      generation: targetGeneration, parentCheckpointId: reservation.parentCommittedCheckpointId,
      safePointBoundarySeq: safe.boundarySeq, snapshotToken: token, taskState: taskStateForCapture,
      createdAtUtc: n.createdAtUtc || new Date().toISOString(), sealedAtUtc: n.createdAtUtc || new Date().toISOString(),
    });
    sealed = builtSealed.sealedCheckpoint;
    artifact = shadow.buildCompactedProjectionV2({
      schemaVersion: 1, taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
      generation: targetGeneration, sealedCheckpoint: sealed, retentionPlan: plan, snapshotToken: token,
      taskState: taskStateForCapture, contextUnits: cloneJson(n.contextUnits),
      sourceEvents: cloneJson(n.session.events || []), surfaceNodes,
      protocolSpans: cloneJson(n.protocolSpans || []),
    });
  } catch (error) {
    return failedResult(n, st, level, [blocker('integration-projection-build-failed', error && error.message)],
      { generation: targetGeneration });
  }
  if (!artifact || artifact.projectionDigest !== shadowResult.projection.projectionDigest) {
    return failedResult(n, st, level, [blocker('integration-projection-mismatch', 'artifact does not bind the shadow digest')],
      { generation: targetGeneration });
  }
  // A11 generation-aware active entry (the ONLY supported production path,
  // section 6): exactly one A10 invocation happens inside, under one held
  // cross-process lock acquisition. operationDir is derived by A11 and
  // never trusted from the caller.
  const request = {
    schemaVersion: 1, taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
    generation: targetGeneration, shadowResult, sealedCheckpoint: sealed, projectionArtifact: artifact,
    snapshotToken: token, snapshotCurrentState: snapshotInput, safePointDecision: safe,
    checkpointabilityDecision: gateDecision, pressureDecision: pressureForGeneration,
    retentionPlan: plan, taskState: taskStateForCapture, contextUnits: cloneJson(n.contextUnits),
    protocolSpans: cloneJson(n.protocolSpans || []), session: n.session,
    checkpointDir: n.checkpointDir, operationDir: generation.operationDirForGenerationV2(n.operationRoot, targetGeneration),
    flushFn: (typeof n.flushFn === 'function') ? n.flushFn : (async () => true),
    serialization: n.serialization,
  };
  let entry = null;
  try {
    entry = await generation.applyCurrentGenerationV2({
      schemaVersion: 1, taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
      runtimeDir: n.runtimeDir, checkpointDir: n.checkpointDir, operationRoot: n.operationRoot,
      lockWorkspace: n.lockWorkspace, request,
    });
  } catch (error) {
    return await handleApplyThrow(n, level, token, safe, targetGeneration, request, error);
  }
  return await handleActiveResult(n, level, token, safe, targetGeneration, request, entry, tokensBefore);
}

// Fresh per-generation retention + shadow + apply after the reservation is
// aligned (section 5). The retention plan, shadow projection, seal, and
// artifact are all built for the OWNED generation with its exact token.
async function continueAfterReserve(n, st, level, bundle, gateDecision, pressureForGeneration, reservation, tokensBefore) {
  const token = bundle.token;
  const safe = bundle.safe;
  const taskStateForCapture = bundle.taskStateForCapture;
  const snapshotInput = bundle.snapshotInput;
  const targetGeneration = reservation.generation;
  const boundaryContext = {
    sessionEvents: cloneJson(n.session.events || []),
    sessionDurable: { flushedSeq: n.sessionDurable.flushedSeq, flushParticipated: n.sessionDurable.flushParticipated },
    controller: {
      taskStatus: n.controller.taskStatus,
      transitionOpen: n.controller.transitionOpen,
      completionCommitted: n.controller.completionCommitted,
      taskRevision: taskStateForCapture.taskRevision,
    },
    runtime: {
      currentSnapshotSeq: n.hostRuntime.currentSnapshotSeq === undefined ? null : n.hostRuntime.currentSnapshotSeq,
      transitionOpen: n.hostRuntime.transitionOpen,
    },
  };
  let plan = null;
  try {
    plan = retention.planRetentionV2({
      schemaVersion: 1, taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
      generation: targetGeneration, snapshotToken: token, safePointDecision: safe,
      checkpointabilityDecision: gateDecision, pressureDecision: pressureForGeneration,
      boundaryContext, contextUnits: cloneJson(n.contextUnits),
      protocolSpans: cloneJson(n.protocolSpans || []),
    });
  } catch (error) {
    // No useful cut (section 12): live task state remains unchanged. The
    // reservation stays RESERVED for an unchanged-source repeat and is
    // superseded honestly once source moves (reuse path, section 30).
    return blockedResult(n, st, level, [blocker('retention-no-useful-cut', error && error.message)],
      { generation: targetGeneration });
  }
  return await shadowApplyCommit(n, st, level, token, safe, snapshotInput, taskStateForCapture,
    gateDecision, pressureForGeneration, plan, reservation, tokensBefore);
}
async function handleReserveConflict(n, st, level, bundle, tokensBefore, pressureInputFor, attempt, error) {
  const message = String((error && error.message) || error);
  if (message.indexOf('generation-runtime-fork') !== -1 || message.indexOf('generation-runtime-corrupt') !== -1) {
    return failedResult(n, st, level, [blocker('generation-runtime-corrupt', message.slice(0, 200))],
      { generation: bundle.generation }, true);
  }
  const fresh = inspectRuntime(n, n.session);
  if (!continueFromRuntime(fresh)) {
    return failedResult(n, fresh, level, [blocker('generation-unresolved-operation', message.slice(0, 200))],
      { pendingGeneration: fresh.unresolvedGeneration, generation: bundle.generation });
  }
  if (message.indexOf('generation-unresolved-operation') !== -1) {
    return failedResult(n, fresh, level, [blocker('generation-unresolved-operation', message.slice(0, 200))],
      { pendingGeneration: fresh.unresolvedGeneration, generation: bundle.generation });
  }
  if (message.indexOf('generation-reservation-conflict') !== -1
    && fresh.activeGeneration !== null && fresh.activeGeneration !== undefined && attempt < 1) {
    const active = fresh.activeGeneration;
    const stored = readOwnedReservation(n, active);
    const labelOnly = stored
      && stored.revisionDigest === bundle.token.revisionDigest
      && Number(stored.safePointBoundarySeq) === Number(bundle.safe.boundarySeq);
    if (labelOnly) {
      // Unchanged live source still bound to the active reservation
      // (recover path, section 30): rebuild the bundle for the owned
      // generation and re-reserve with the identical binding.
      let rebuilt = null;
      try {
        rebuilt = recaptureForGeneration(n, bundle.safe, active);
      } catch (captureError) {
        return failedResult(n, fresh, level, [blocker('integration-snapshot-failed', captureError && captureError.message)],
          { generation: active });
      }
      if (rebuilt.token.revisionDigest === stored.revisionDigest && rebuilt.token.snapshotTokenId === stored.snapshotTokenId) {
        let pressureForActive = bundle.pressureDecision;
        try {
          pressureForActive = pressure.measurePressureV2(Object.assign(pressureInputFor(active), {
            snapshotTokenId: rebuilt.token.snapshotTokenId, revisionDigest: rebuilt.token.revisionDigest,
          }));
        } catch (pressureError) {
          return failedResult(n, fresh, level, [blocker('integration-pressure-failed', pressureError && pressureError.message)],
            { generation: active });
        }
        const nextBundle = {
          taskStateForCapture: rebuilt.taskStateForCapture, snapshotInput: rebuilt.snapshotInput,
          token: rebuilt.token, safe: bundle.safe, generation: active, pressureDecision: pressureForActive,
        };
        return await gateReserveApply(n, fresh, level, nextBundle, tokensBefore, pressureInputFor, attempt + 1);
      }
    }
    // Genuinely moved source (or unverifiable reuse): the stale candidate
    // never applies (section 30). Supersede if eligible; fresh later.
    await supersedeWithLiveEvidence(n, active, bundle.token.revisionDigest, bundle.safe);
    const after = inspectRuntime(n, n.session);
    return blockedResult(n, after, level, [blocker('generation-reservation-conflict', message.slice(0, 200))],
      { generation: active });
  }
  if (message.indexOf('generation-reservation-conflict') !== -1) {
    return blockedResult(n, fresh, level, [blocker('generation-reservation-conflict', message.slice(0, 200))],
      { generation: bundle.generation });
  }
  if (continueFromRuntime(fresh)) {
    return blockedResult(n, fresh, level, [blocker('integration-reserve-failed', message.slice(0, 200))],
      { generation: bundle.generation });
  }
  return failedResult(n, fresh, level, [blocker('integration-reserve-failed', message.slice(0, 200))],
    { generation: bundle.generation });
}

// Best-effort zero-landing supersession of a reservation this call owns.
// Never throws: supersession refusal (something landed concurrently) falls
// back to authoritative inspection by the caller.
async function supersedeQuietly(n, gen, taskStateForRevision, safe, payloadText, session) {
  try {
    await generation.supersedeGenerationV2({
      schemaVersion: 1, taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
      runtimeDir: n.runtimeDir, checkpointDir: n.checkpointDir, operationRoot: n.operationRoot,
      generation: gen,
      observedRevisionDigest: String((taskStateForRevision && taskStateForRevision.taskRevision) || 'unknown'),
      observedSafePointBoundarySeq: safe && Number.isInteger(safe.boundarySeq) ? safe.boundarySeq : 0,
      payloadText: payloadText === undefined ? null : payloadText,
      session: session === undefined ? null : session,
      serialization: n.serialization, lockWorkspace: n.lockWorkspace,
    });
    return true;
  } catch (e) { return false; }
}

async function handleApplyThrow(n, level, token, safe, targetGeneration, request, error) {
  const message = String((error && error.message) || error);
  // Map known fail-closed generation states without inventing outcomes.
  if (message.indexOf('generation-already-committed') !== -1) {
    // Lost-winner race: another process committed our generation. No
    // duplicate work exists; the task continues on the committed head.
    return baseResult(n, {
      pressureLevel: level, action: 'none', generation: targetGeneration, taskMayContinue: true,
      telemetry: telemetryOf(n, { pressureLevel: level, action: 'none', generation: targetGeneration, taskMayContinue: true }),
    });
  }
  if (message.indexOf('generation-cannot-supersede') !== -1 || message.indexOf('generation-superseded') !== -1) {
    const fresh = inspectRuntime(n, n.session);
    return blockedResult(n, fresh, level, [blocker('generation-superseded', message.slice(0, 200))],
      { generation: targetGeneration, terminal: true });
  }
  let fresh = null;
  try { fresh = inspectRuntime(n, n.session); } catch (e) { fresh = null; }
  if (fresh && !continueFromRuntime(fresh)) {
    // Post-mutation ambiguity (section 14): the controller must NOT make
    // new model/tool progress until A12 recovery converges. The in-hand
    // request bundle is returned opaquely for recoverUnresolvedGeneration
    // (same-process forward recovery through the A11 entry); it is never
    // persisted, logged, or transmitted.
    return failedResult(n, fresh, level, [blocker('generation-unresolved-operation', message.slice(0, 200))],
      { generation: targetGeneration, pendingRequest: request, pendingGeneration: fresh.unresolvedGeneration });
  }
  if (fresh) return blockedResult(n, fresh, level, [blocker('integration-apply-failed', message.slice(0, 200))],
    { generation: targetGeneration });
  return failedResult(n, null, level, [blocker('integration-apply-failed', message.slice(0, 200))],
    { generation: targetGeneration, pendingRequest: request });
}

async function handleActiveResult(n, level, token, safe, targetGeneration, request, entry, tokensBefore) {
  const activeResult = entry && entry.activeResult ? entry.activeResult : null;
  if (!activeResult) {
    const fresh = inspectRuntime(n, n.session);
    return failedResult(n, fresh, level, [blocker('integration-apply-failed', 'A11 entry returned no active result')],
      { generation: targetGeneration, pendingRequest: request });
  }
  const status = activeResult.status;
  const tele = activeResult.telemetry || {};
  const ids = {
    generation: targetGeneration,
    checkpointId: activeResult.checkpointId || null,
    operationId: activeResult.operationId || null,
    projectionDigest: activeResult.projectionDigest || null,
  };
  if (status === 'committed' || status === 'recovered') {
    // A11 explicit committed-head advancement (section 5): only after the
    // integration verifies the post-apply projection itself (balanced
    // protocol, current user exactly once, durable application). The
    // postApplyVerified flag is EARNED here, never assumed.
    const validity = projectionValidityOf(n.session);
    const verified = validity.balanced === true
      && (validity.userMarkerPresent ? validity.userOccurrences === 1 : true)
      && activeResult.applicationDurable === true;
    if (!verified) {
      const fresh = inspectRuntime(n, n.session);
      return failedResult(n, fresh, level, [blocker('integration-post-apply-unverified',
        'balanced=' + validity.balanced + ' userOnce=' + (validity.userMarkerPresent ? validity.userOccurrences : 'absent') +
        ' durable=' + activeResult.applicationDurable)], ids);
    }
    try {
      await generation.commitGenerationV2({
        schemaVersion: 1, taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
        runtimeDir: n.runtimeDir, checkpointDir: n.checkpointDir, operationRoot: n.operationRoot,
        lockWorkspace: n.lockWorkspace, generation: targetGeneration,
        activeResult, postApplyVerified: true, session: n.session, serialization: n.serialization,
      });
    } catch (error) {
      const fresh = inspectRuntime(n, n.session);
      if (continueFromRuntime(fresh)) {
        return blockedResult(n, fresh, level, [blocker('integration-commit-failed', String((error && error.message) || error).slice(0, 200))], ids);
      }
      return failedResult(n, fresh, level, [blocker('integration-commit-failed', String((error && error.message) || error).slice(0, 200))],
        Object.assign({}, ids, { pendingRequest: request, pendingGeneration: fresh ? fresh.unresolvedGeneration : targetGeneration }));
    }
    const action = status === 'recovered' ? 'recovered' : 'compacted';
    return baseResult(n, Object.assign({}, ids, {
      pressureLevel: level, action, taskMayContinue: true,
      telemetry: telemetryOf(n, {
        pressureLevel: level, action, generation: targetGeneration,
        checkpointId: ids.checkpointId, operationId: ids.operationId, taskMayContinue: true,
        tokensBefore: tele.beforeTokenEstimate === undefined ? tokensBefore : tele.beforeTokenEstimate,
        tokensAfterEstimate: tele.afterTokenEstimate === undefined ? null : tele.afterTokenEstimate,
      }),
    }));
  }
  if (status === 'stale') {
    // Moved state under us: nothing landed (mutated=false). The stale
    // reservation may be superseded if eligible; a fresh generation is
    // considered later (section 30).
    let payloadText = null;
    try { payloadText = shadow.checkpointPayloadTextOf(request.sealedCheckpoint); } catch (e) { payloadText = null; }
    const observedRevision = (n.controller.taskRevision !== null && n.controller.taskRevision !== undefined
      && n.controller.taskRevision !== '') ? n.controller.taskRevision : token.revisionDigest;
    await supersedeQuietly(n, targetGeneration, { taskRevision: observedRevision }, safe, payloadText, n.session);
    const fresh = inspectRuntime(n, n.session);
    return blockedResult(n, fresh, level, [blocker('generation-source-stale', 'live state moved; stale attempt closed')],
      { generation: targetGeneration });
  }
  if (status === 'refused') {
    const codes = ((activeResult.blockers) || []).map((b) => b.code);
    const fresh = inspectRuntime(n, n.session);
    return blockedResult(n, fresh, level,
      [blocker('active-apply-refused', codes.length > 0 ? codes.join(',') : 'A10 refused before mutation')],
      { generation: targetGeneration });
  }
  // status 'failed' (or anything unexpected): route by durable truth.
  const fresh = inspectRuntime(n, n.session);
  if (fresh && !continueFromRuntime(fresh)) {
    return failedResult(n, fresh, level, [blocker('generation-unresolved-operation', 'A10 reported ' + status + ' with durable intent')],
      Object.assign({}, ids, { pendingRequest: request, pendingGeneration: fresh.unresolvedGeneration }));
  }
  return failedResult(n, fresh, level, [blocker('active-apply-failed', 'A10 reported ' + status)], ids);
}
// ---- same-process forward recovery (sections 14-15, 26) --------------------
// recoverUnresolvedGeneration re-invokes the A11 generation-aware entry with
// the in-hand request bundle from the evaluateBoundary call that left the
// generation UNRESOLVED (same-process A10 forward recovery; the reservation
// binding still matches because live state holds only the operation's own
// landing). Cross-restart recovery without the bundle follows the A12 frozen
// outcome (resumeTask): fully-landed repairs the head; partial landing stays
// UNRESOLVED and the task stays blocked. This operation never starts a new
// generation and never touches task completion.
async function recoverUnresolvedGeneration(rawInput) {
  durablePolicyV2.assertDurableMutationAllowedV2();
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) failIntegration('complete-task-unavailable: input is required');
  const unknown = unknownKeyOf(rawInput, RECOVER_INPUT_EXACT_KEYS);
  if (unknown !== null) failIntegration('complete-task-unavailable: unknown field ' + redactDetail(unknown));
  if (Number(rawInput.schemaVersion) !== COMPLETE_TASK_V2_SCHEMA_VERSION) failIntegration('complete-task-unavailable: schemaVersion must be 1');
  for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
    if (!isBoundedId(rawInput[key], 256)) failIntegration('complete-task-unavailable: ' + key + ' is required');
  }
  for (const key of ['runtimeDir', 'checkpointDir', 'operationRoot', 'lockWorkspace']) {
    if (typeof rawInput[key] !== 'string' || rawInput[key] === '') failIntegration('complete-task-unavailable: ' + key + ' is required');
  }
  if (!Number.isInteger(rawInput.generation) || rawInput.generation < 1) failIntegration('complete-task-unavailable: generation must be a positive integer');
  if (!rawInput.session || typeof rawInput.session !== 'object') failIntegration('complete-task-unavailable: session is required');
  if (!rawInput.serialization || typeof rawInput.serialization !== 'object') failIntegration('complete-task-unavailable: serialization client is required');
  if (!rawInput.pendingRequest || typeof rawInput.pendingRequest !== 'object') {
    failIntegration('complete-task-unavailable: pendingRequest (the in-hand apply bundle) is required');
  }
  const n = rawInput;
  let st = null;
  try {
    st = inspectRuntime(n, n.session);
  } catch (error) {
    return failedResult(n, null, null, [blocker('integration-runtime-unreadable', error && error.message)],
      { generation: n.generation });
  }
  if (continueFromRuntime(st)) {
    return baseResult(n, {
      pressureLevel: null, action: 'none', generation: n.generation, taskMayContinue: true,
      telemetry: telemetryOf(n, { action: 'none', generation: n.generation, taskMayContinue: true, recoveryOutcome: 'already-terminal' }),
    });
  }
  if (Number(st.unresolvedGeneration) !== Number(n.generation)) {
    return failedResult(n, st, null, [blocker('generation-unresolved-operation',
      'generation ' + st.unresolvedGeneration + ' blocks recovery of generation ' + n.generation)],
      { generation: n.generation });
  }
  let entry = null;
  try {
    entry = await generation.applyCurrentGenerationV2({
      schemaVersion: 1, taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
      runtimeDir: n.runtimeDir, checkpointDir: n.checkpointDir, operationRoot: n.operationRoot,
      lockWorkspace: n.lockWorkspace, request: n.pendingRequest,
    });
  } catch (error) {
    const fresh = inspectRuntime(n, n.session);
    return failedResult(n, fresh, null, [blocker('integration-recovery-failed', String((error && error.message) || error).slice(0, 200))],
      { generation: n.generation, pendingRequest: n.pendingRequest, pendingGeneration: fresh ? fresh.unresolvedGeneration : n.generation });
  }
  const activeResult = entry && entry.activeResult ? entry.activeResult : null;
  if (!activeResult || (activeResult.status !== 'committed' && activeResult.status !== 'recovered')) {
    const fresh = inspectRuntime(n, n.session);
    return failedResult(n, fresh, null, [blocker('integration-recovery-failed',
      'forward recovery converged to ' + (activeResult ? activeResult.status : 'missing'))],
      { generation: n.generation, pendingRequest: n.pendingRequest, pendingGeneration: fresh ? fresh.unresolvedGeneration : n.generation });
  }
  const validity = projectionValidityOf(n.session);
  const verified = validity.balanced === true
    && (validity.userMarkerPresent ? validity.userOccurrences === 1 : true)
    && activeResult.applicationDurable === true;
  if (!verified) {
    const fresh = inspectRuntime(n, n.session);
    return failedResult(n, fresh, null, [blocker('integration-post-apply-unverified', 'recovered projection failed verification')],
      { generation: n.generation });
  }
  try {
    await generation.commitGenerationV2({
      schemaVersion: 1, taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
      runtimeDir: n.runtimeDir, checkpointDir: n.checkpointDir, operationRoot: n.operationRoot,
      lockWorkspace: n.lockWorkspace, generation: n.generation,
      activeResult, postApplyVerified: true, session: n.session, serialization: n.serialization,
    });
  } catch (error) {
    const fresh = inspectRuntime(n, n.session);
    return failedResult(n, fresh, null, [blocker('integration-commit-failed', String((error && error.message) || error).slice(0, 200))],
      { generation: n.generation });
  }
  return baseResult(n, {
    pressureLevel: null, action: 'recovered', generation: n.generation,
    checkpointId: activeResult.checkpointId || null, operationId: activeResult.operationId || null,
    projectionDigest: activeResult.projectionDigest || null,
    taskMayContinue: true,
    telemetry: telemetryOf(n, {
      action: 'recovered', generation: n.generation,
      checkpointId: activeResult.checkpointId || null, operationId: activeResult.operationId || null,
      taskMayContinue: true, recoveryOutcome: activeResult.status,
    }),
  });
}

// ---- Complete-Task consistency gate (section 44) ----------------------------
// checkCompletionHealth runs BEFORE the existing controller finalization
// closes the lifecycle. It is a consistency GATE, never a completion
// decision: the controller decides; this reports health. Checks:
// generation runtime reconstructable, no unresolved compaction, active
// model-facing projection valid.
function checkCompletionHealth(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) failIntegration('complete-task-unavailable: input is required');
  const unknown = unknownKeyOf(rawInput, HEALTH_INPUT_EXACT_KEYS);
  if (unknown !== null) failIntegration('complete-task-unavailable: unknown field ' + redactDetail(unknown));
  if (Number(rawInput.schemaVersion) !== COMPLETE_TASK_V2_SCHEMA_VERSION) failIntegration('complete-task-unavailable: schemaVersion must be 1');
  for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
    if (!isBoundedId(rawInput[key], 256)) failIntegration('complete-task-unavailable: ' + key + ' is required');
  }
  for (const key of ['runtimeDir', 'checkpointDir', 'operationRoot']) {
    if (typeof rawInput[key] !== 'string' || rawInput[key] === '') failIntegration('complete-task-unavailable: ' + key + ' is required');
  }
  if (!rawInput.session || typeof rawInput.session !== 'object') failIntegration('complete-task-unavailable: session is required');
  const n = rawInput;
  const terminal = n.terminal === true;
  const checks = { reconstructable: false, noUnresolved: false, projectionValid: false };
  let st = null;
  try {
    st = generation.inspectGenerationRuntimeV2({
      schemaVersion: 1, taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
      runtimeDir: n.runtimeDir, checkpointDir: n.checkpointDir, operationRoot: n.operationRoot, session: n.session,
    });
    checks.reconstructable = true;
    checks.noUnresolved = continueFromRuntime(st);
  } catch (error) {
    return Object.freeze({
      schemaVersion: COMPLETE_TASK_V2_SCHEMA_VERSION, healthy: false, checks: Object.freeze(checks),
      latestCommittedGeneration: null, lineage: Object.freeze([]),
      detail: redactDetail(error && error.message),
    });
  }
  try {
    const validity = projectionValidityOf(n.session);
    const userOk = validity.userMarkerPresent ? validity.userOccurrences === 1 : terminal;
    checks.projectionValid = validity.balanced === true && userOk;
  } catch (e) { checks.projectionValid = false; }
  const lineage = st ? st.generations.filter((g) => g.outcome === 'COMMITTED').map((g) => g.generation) : [];
  return Object.freeze({
    schemaVersion: COMPLETE_TASK_V2_SCHEMA_VERSION,
    healthy: checks.reconstructable && checks.noUnresolved && checks.projectionValid,
    checks: Object.freeze(checks),
    latestCommittedGeneration: st ? st.latestCommittedGeneration : null,
    lineage: Object.freeze(lineage),
    detail: null,
  });
}

// ---- restart / resume (sections 20-22, H1-H3) -----------------------------------
// resumeTask runs BEFORE the restarted task accepts new work and owns the
// whole restart-recovery sequence (H3): frozen reconstruct with repair
// over the restored session, durable recovery of an UNRESOLVED generation
// when (and only when) the durable artifacts prove one unique recovery,
// projection validation, and the may-resume flag. It never starts a new
// generation and never completes the task. A durably superseded generation
// stays non-applicable (section 21); commit-head repair (section 22) is
// the frozen reconstruct path.
//
// H1 durable recovery (no re-planning, H1.1): the unresolved generation
// already owns a durable transaction (reservation + sealed checkpoint +
// A02 operation). Recovery reconciles landed segments through the frozen
// A11/A02 recovery authorities, retries ONLY missing segments, flushes,
// and lets the frozen A11 repair advance the head with recovered
// completion evidence. No new pressure decision, retention plan, shadow
// result, or reservation is created. If the artifacts cannot prove one
// unique recovery, resume fails closed (mayResume=false) with
// integration-recovery-evidence-incomplete (H1.3).
async function resumeTask(rawInput) {
  durablePolicyV2.assertDurableMutationAllowedV2();
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) failIntegration('complete-task-unavailable: input is required');
  const unknown = unknownKeyOf(rawInput, RESUME_INPUT_EXACT_KEYS);
  if (unknown !== null) failIntegration('complete-task-unavailable: unknown field ' + redactDetail(unknown));
  if (Number(rawInput.schemaVersion) !== COMPLETE_TASK_V2_SCHEMA_VERSION) failIntegration('complete-task-unavailable: schemaVersion must be 1');
  for (const key of ['taskId', 'taskInstanceId', 'sessionId']) {
    if (!isBoundedId(rawInput[key], 256)) failIntegration('complete-task-unavailable: ' + key + ' is required');
  }
  for (const key of ['runtimeDir', 'checkpointDir', 'operationRoot']) {
    if (typeof rawInput[key] !== 'string' || rawInput[key] === '') failIntegration('complete-task-unavailable: ' + key + ' is required');
  }
  if (!rawInput.session || typeof rawInput.session !== 'object') failIntegration('complete-task-unavailable: restored session is required');
  if (rawInput.flushFn !== undefined && rawInput.flushFn !== null && typeof rawInput.flushFn !== 'function') {
    failIntegration('complete-task-unavailable: flushFn must be a function or null');
  }
  const n = rawInput;
  const steadyResult = (st, projectionValid, extra) => {
    const lineage = st.generations.filter((g) => g.outcome === 'COMMITTED').map((g) => g.generation);
    return Object.freeze(Object.assign({
      schemaVersion: COMPLETE_TASK_V2_SCHEMA_VERSION, mayResume: continueFromRuntime(st) && projectionValid,
      reconstructionOutcome: st.reconstructionOutcome || 'steady',
      latestCommittedGeneration: st.latestCommittedGeneration,
      lineage: Object.freeze(lineage), projectionValid,
      unresolvedGeneration: st.unresolvedGeneration === undefined ? null : st.unresolvedGeneration,
      recoveryAttempted: false, recoveryDecision: null, retriedSegments: Object.freeze([]),
      flushed: null, recoveredCompletion: Boolean(st.recoveredCompletion),
      blockerCode: null, detail: null,
    }, extra || {}));
  };
  const checkProjection = () => {
    try {
      const validity = projectionValidityOf(n.session);
      return validity.balanced === true && (!validity.userMarkerPresent || validity.userOccurrences === 1);
    } catch (e) { return false; }
  };
  const reconstructRepair = () => generation.reconstructGenerationRuntimeV2({
    schemaVersion: 1, taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
    runtimeDir: n.runtimeDir, checkpointDir: n.checkpointDir, operationRoot: n.operationRoot,
    session: n.session, repairHead: true,
  });
  let st = null;
  try {
    st = reconstructRepair();
  } catch (error) {
    return Object.freeze({
      schemaVersion: COMPLETE_TASK_V2_SCHEMA_VERSION, mayResume: false,
      reconstructionOutcome: 'reconstruct-failed', latestCommittedGeneration: null,
      lineage: Object.freeze([]), projectionValid: false, unresolvedGeneration: null,
      recoveryAttempted: false, recoveryDecision: null, retriedSegments: Object.freeze([]),
      flushed: null, recoveredCompletion: false,
      blockerCode: 'integration-runtime-unreadable', detail: redactDetail(error && error.message),
    });
  }
  if (continueFromRuntime(st)) {
    // H1.5: a pending durable intent (active generation with a frozen A02
    // operation, e.g. crash between intent-freeze and flush) must converge
    // now through the same durable-only recovery. Abandoning it would let
    // later work supersede a valid pending transaction. A bare reservation
    // without a frozen operation has nothing to converge and is left for
    // the normal boundary path (reuse/supersede by binding).
    const pending = pendingDurableIntentGen(n, st);
    if (pending === null) {
      return steadyResult(st, checkProjection(), {});
    }
    const gen = pending;
    const recovery = await recoverUnresolvedFromDurable(n, gen);
    if (!recovery.ok) {
      return steadyResult(st, false, {
        mayResume: false, recoveryAttempted: true, recoveryDecision: recovery.decision,
        retriedSegments: Object.freeze(recovery.retriedSegments || []), flushed: recovery.flushed,
        blockerCode: recovery.blockerCode, detail: recovery.detail,
      });
    }
    let stp = null;
    try {
      stp = reconstructRepair();
    } catch (error) {
      return steadyResult(st, false, {
        mayResume: false, recoveryAttempted: true, recoveryDecision: recovery.decision,
        retriedSegments: Object.freeze(recovery.retriedSegments || []), flushed: recovery.flushed,
        blockerCode: 'integration-runtime-unreadable', detail: redactDetail(error && error.message),
      });
    }
    const projectionValidP = checkProjection();
    const headOkP = continueFromRuntime(stp) && Number(stp.latestCommittedGeneration) === Number(gen);
    return steadyResult(stp, projectionValidP, {
      mayResume: headOkP && projectionValidP,
      recoveryAttempted: true, recoveryDecision: recovery.decision,
      retriedSegments: Object.freeze(recovery.retriedSegments || []), flushed: recovery.flushed,
      blockerCode: headOkP ? null : 'integration-recovery-incomplete',
      detail: headOkP ? null : 'recovery did not reach the committed head',
    });
  }
  // UNRESOLVED generation: attempt durable recovery (H1), then re-verify.
  const gen = st.unresolvedGeneration;
  const recovery = await recoverUnresolvedFromDurable(n, gen);
  if (!recovery.ok) {
    return steadyResult(st, false, {
      mayResume: false, recoveryAttempted: true, recoveryDecision: recovery.decision,
      retriedSegments: Object.freeze(recovery.retriedSegments || []), flushed: recovery.flushed,
      blockerCode: recovery.blockerCode, detail: recovery.detail,
    });
  }
  let st2 = null;
  try {
    st2 = reconstructRepair();
  } catch (error) {
    return steadyResult(st, false, {
      mayResume: false, recoveryAttempted: true, recoveryDecision: recovery.decision,
      retriedSegments: Object.freeze(recovery.retriedSegments || []), flushed: recovery.flushed,
      blockerCode: 'integration-runtime-unreadable', detail: redactDetail(error && error.message),
    });
  }
  const projectionValid = checkProjection();
  const headOk = continueFromRuntime(st2) && Number(st2.latestCommittedGeneration) === Number(gen);
  return steadyResult(st2, projectionValid, {
    mayResume: headOk && projectionValid,
    recoveryAttempted: true, recoveryDecision: recovery.decision,
    retriedSegments: Object.freeze(recovery.retriedSegments || []), flushed: recovery.flushed,
    blockerCode: headOk ? null : 'integration-recovery-incomplete',
    detail: headOk ? null : 'recovery did not reach the committed head',
  });
}
// The active generation owns a pending durable intent when a frozen A02
// operation file exists for it. Returns the generation or null (a bare
// reservation without frozen intent has nothing to converge here).
function pendingDurableIntentGen(n, st) {
  const active = st ? st.activeGeneration : null;
  if (active === null || active === undefined) return null;
  try {
    const op = compactionV2.readCompactionOperationV2(generation.operationDirForGenerationV2(n.operationRoot, active));
    if (!op) return null;
    if (Number(op.checkpointGeneration) !== Number(active)) return null;
    return active;
  } catch (e) { return null; }
}
// Durable-only forward recovery for one UNRESOLVED generation. Reads ONLY
// durable artifacts (reservation, sealed checkpoint, A02 operation) plus
// the live restored session; creates no plans, pressures, shadows, or
// reservations. Returns { ok, decision, retriedSegments, flushed, ... }.
async function recoverUnresolvedFromDurable(n, gen) {
  durablePolicyV2.assertDurableMutationAllowedV2();
  const fail = (blockerCode, detail, extra) => Object.assign({
    ok: false, decision: null, retriedSegments: [], flushed: null,
    blockerCode, detail: detail === null || detail === undefined ? null : redactDetail(detail),
  }, extra || {});
  // (a) The reservation must exist: the generation was allocated to this
  // task/session binding (proves ownership, never invents it).
  let reservation = null;
  try {
    reservation = generation.readReservationV2(n.runtimeDir, gen, dirsOf(n));
  } catch (e) { reservation = null; }
  if (!reservation) {
    return fail('integration-recovery-evidence-incomplete', 'no durable reservation for generation ' + gen);
  }
  // (b) The sealed checkpoint must be durable and valid (A04-checked read).
  let sealed = null;
  try {
    const stored = trustV2.readSealedCheckpointV2(n.checkpointDir, gen);
    sealed = stored && stored.checkpoint ? stored.checkpoint : stored;
  } catch (e) { sealed = null; }
  if (!sealed) {
    return fail('integration-recovery-evidence-incomplete', 'no durable sealed checkpoint for generation ' + gen);
  }
  // (c) The A02 operation must be durable. The branded read-back handle
  // doubles as the A05H H3 durability proof for the retry below.
  let operation = null;
  try {
    operation = compactionV2.readCompactionOperationV2(generation.operationDirForGenerationV2(n.operationRoot, gen));
  } catch (e) { operation = null; }
  if (!operation) {
    return fail('integration-recovery-evidence-incomplete', 'no durable A02 operation for generation ' + gen);
  }
  // (d) Unique-recovery identity proof: the operation must bind exactly
  // this sealed checkpoint, generation, and task/session (payload digest
  // agreement is re-proven by reconcile below; this gates mismatch early).
  if (Number(operation.checkpointGeneration) !== Number(gen)
    || operation.checkpointId !== sealed.checkpointId
    || operation.checkpointContentDigest !== sealed.checkpointContentDigest
    || operation.taskId !== n.taskId || operation.taskInstanceId !== n.taskInstanceId || operation.sessionId !== n.sessionId) {
    return fail('integration-recovery-evidence-incomplete', 'operation/checkpoint identity mismatch at generation ' + gen);
  }
  let payloadText = null;
  try {
    payloadText = shadow.checkpointPayloadTextOf(sealed);
  } catch (e) { payloadText = null; }
  if (typeof payloadText !== 'string' || payloadText === '') {
    return fail('integration-recovery-evidence-incomplete', 'checkpoint payload unproven at generation ' + gen);
  }
  // (e) Frozen A11 classification (wraps frozen A02 reconcile): which
  // segments, if any, are still missing. Anything but apply/retry-missing/
  // awaiting-durability fails closed here (foreign/corrupt/superseded).
  let diagnosis = null;
  try {
    diagnosis = generation.reconcileGenerationV2({
      schemaVersion: 1, taskId: n.taskId, taskInstanceId: n.taskInstanceId, sessionId: n.sessionId,
      runtimeDir: n.runtimeDir, checkpointDir: n.checkpointDir, operationRoot: n.operationRoot,
      generation: gen, session: n.session,
    });
  } catch (e) { diagnosis = null; }
  if (!diagnosis) {
    return fail('integration-recovery-evidence-incomplete', 'generation ' + gen + ' refuses reconciliation');
  }
  const decision = diagnosis.decision;
  if (decision !== 'apply' && decision !== 'retry-missing' && decision !== 'awaiting-durability') {
    return fail('integration-recovery-evidence-incomplete', 'reconcile decision ' + decision + ' at generation ' + gen, { decision });
  }
  const missing = Array.isArray(diagnosis.missingSegments) ? diagnosis.missingSegments.filter((i) => Number.isInteger(i)) : [];
  // (f) Land ONLY the missing segments (frozen A02 retry primitive over
  // the branded durable handle), then (g) re-establish the durability
  // barrier exactly once. Both are required before the head may advance:
  // landed events alone never imply durability (H1.5 discipline).
  if (typeof n.flushFn !== 'function') {
    return fail('integration-flush-unavailable', 'recovery of generation ' + gen + ' requires a flush barrier', { decision });
  }
  if (missing.length > 0) {
    try {
      compactionV2.retryMissingSegmentsV2(n.session, operation, payloadText, operation, missing);
    } catch (error) {
      return fail('integration-recovery-evidence-incomplete', error && error.message, { decision });
    }
  }
  // Frozen A10 flush contract: participation is exactly `true`.
  let flushed = false;
  try {
    flushed = (await n.flushFn(n.session)) === true;
  } catch (e) { flushed = false; }
  if (flushed !== true) {
    return fail('integration-durability-unproven', 'flush barrier did not participate for generation ' + gen, { decision, retriedSegments: missing });
  }
  return { ok: true, decision, retriedSegments: missing, flushed: true, blockerCode: null, detail: null };
}

module.exports = {
  COMPLETE_TASK_V2_SCHEMA_VERSION,
  INTEGRATION_VERSION_ENV,
  INTEGRATION_ACTIONS,
  TERMINAL_TASK_STATUSES,
  selectCompactionVersion,
  evaluateBoundary,
  recoverUnresolvedGeneration,
  checkCompletionHealth,
  resumeTask,
  projectionValidityOf,
  currentUserMarkerOf,
};
