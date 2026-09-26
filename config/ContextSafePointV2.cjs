'use strict';
/**
 * ContextSafePointV2.cjs - CCV2-A06 SafePointDetector production authority.
 *
 * ONE authority for the V2 safe-boundary decision: boundary classification,
 * open-edge detection, the safe-point decision, stable refusal reasons, and
 * boundary identity. No other CCv2 component redefines what "safe" means.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (A06 sections). A06 answers exactly ONE question and NOTHING else:
 *
 *   "Is the current execution boundary safe for checkpoint creation
 *    and future context compaction?"
 *
 * It does NOT answer whether compaction is needed (future pressure policy),
 * whether the task is checkpointable (A07), what should be retained (future
 * retention planning), or how the prompt is rebuilt (projection). It creates
 * no checkpoints, wires no triggers, and mutates no session projection: the
 * only production seam is detectSafePointV2() (plus the binding helpers
 * below, which also mutate nothing).
 *
 * Core invariant (frozen): NO CHECKPOINT ACROSS AN OPEN EXECUTION EDGE.
 * A checkpoint may only be created at an execution boundary where Nexus can
 * produce a coherent authoritative state without cutting through an
 * in-flight protocol interaction (open tool call, open stream, open
 * tool transaction, open controller mutation, runtime projection
 * transition, or undurable session tail).
 *
 * Grounded inputs (nothing fabricated):
 *   - sessionEvents : the authoritative ordered DSH session event log
 *     (contiguous seq from 0; surface markers surfaceOp/sourceEventSeqs are
 *     protocol structure, message TEXT is never consulted).
 *   - sessionDurable: the host durability observation
 *     ({ flushedSeq, flushParticipated }); a boundary is safe only when it
 *     is durably established, never merely present in memory.
 *   - controller   : the TaskController-side observation
 *     ({ taskStatus, transitionOpen, completionCommitted, taskRevision }).
 *   - runtime      : the host-owned runtime projection observation
 *     ({ currentSnapshotSeq, transitionOpen }).
 *
 * Boundary sequence semantics (frozen, Outcome A): safePointBoundarySeq is
 * the pinned DSH canonical append-log ordinal: the authoritative per-event
 * seq field of the last execution event, which the host assigns as
 * seq equal to log length at append and revalidates positionally on every
 * restore (seed seq must equal index) and surface transition. It is
 * grounded (a real host seq, never an index/count/clock), monotonic under
 * the host append-only contract, and restart-stable (the durable log
 * replays to the same seqs; the host seed-boundary marker is transparent
 * so a restore reports the exact same boundary). Unsafe
 * decisions carry boundarySeq/boundaryKind NULL and at least one blocker;
 * safe decisions carry a grounded boundary and zero blockers.
 *
 * Capture-race rule (frozen): a SafePointDecisionV2 is NOT a timeless
 * capability. detectSafePointV2() records inspectedRevision; the
 * snapshot-capture revision MUST be compared with assertSafePointFresh()
 * before SnapshotManager.capture() output is accepted. Any movement →
 * BLOCK with safe-point-state-changed (retry). A05 capture consistency
 * remains the mechanism that rejects mixed revisions.
 *
 * Determinism: pure over the input object. No clock reads, no randomness.
 * Identical authoritative state -> identical (safe, boundarySeq,
 * boundaryKind, blockers).
 *
 * Security: classification derives ONLY from trusted protocol/controller/
 * runtime structure (event types/seqs/markers, controller flags, runtime
 * flags). Repository/tool/model TEXT is inert data and never influences
 * the state machine.
 *
 * Closed world (A05H rule): every protocol object is exact-key validated
 * BEFORE any derived decision logic. Unknown fields FAIL CLOSED (throw,
 * never "safe").
 */

const SAFEPOINT_SCHEMA_VERSION = 1;

// Frozen boundary taxonomy: every category names a real production
// boundary. controller-step-committed is grounded on the DSH step/end
// tail event (a committed controller/DHS step); task-complete additionally
// requires committed controller completion. An assistant/message that still
// carries tool-call blocks is NEVER a safe boundary (it is an open tool
// edge), so assistant-turn-committed always names a text-only turn.
const SAFEPOINT_BOUNDARY_KINDS = Object.freeze([
  'user-turn-committed',
  'assistant-turn-committed',
  'tool-result-committed',
  'controller-step-committed',
  'task-complete',
]);

// Frozen unsafe-state taxonomy (stable machine-readable codes).
// safe-point-boundary-mismatch is the A03-binding leg: the checkpoint
// references a different boundary than the decision that authorized
// capture. safe-point-state-changed is the detect->capture race leg.
const SAFEPOINT_BLOCKER_CODES = Object.freeze([
  'safe-point-assistant-stream-open',
  'safe-point-tool-call-open',
  'safe-point-tool-result-pending',
  'safe-point-tool-transaction-open',
  'safe-point-controller-transition-open',
  'safe-point-session-not-durable',
  'safe-point-runtime-transition',
  'safe-point-protocol-unbalanced',
  'safe-point-boundary-unavailable',
  'safe-point-state-changed',
  'safe-point-boundary-mismatch',
]);

const SAFEPOINT_BOUNDS = Object.freeze({
  taskId: 256,
  taskInstanceId: 256,
  sessionId: 256,
  taskRevision: 256,
  taskStatus: 64,
  detail: 1024,
  eventsMax: 100000,
});

const SAFEPOINT_INPUT_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'sessionEvents',
  'sessionDurable',
  'controller',
  'runtime',
]);
const SAFEPOINT_DURABLE_EXACT_KEYS = Object.freeze([
  'flushedSeq',
  'flushParticipated',
]);
const SAFEPOINT_CONTROLLER_EXACT_KEYS = Object.freeze([
  'taskStatus',
  'transitionOpen',
  'completionCommitted',
  'taskRevision',
]);
const SAFEPOINT_RUNTIME_EXACT_KEYS = Object.freeze([
  'currentSnapshotSeq',
  'transitionOpen',
]);
const SAFEPOINT_DECISION_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'safe',
  'boundarySeq',
  'boundaryKind',
  'blockers',
  'inspectedRevision',
]);
const SAFEPOINT_BLOCKER_EXACT_KEYS = Object.freeze(['code', 'detail']);
const SAFEPOINT_REVISION_EXACT_KEYS = Object.freeze([
  'taskRevision',
  'sessionRevision',
  'runtimeSnapshotId',
]);

const SURFACE_EVENT_TYPES = Object.freeze(['user/message', 'assistant/message', 'tool/result']);
// Host seed-boundary marker: appended deterministically by the pinned DSH
// restore constructor when the seed tail is not one. Storage bookkeeping
// with no execution semantics; transparent to boundary identity.
const SEED_MARKER_TYPE = 'session/end-seed';

function failInput(message) {
  throw new Error('v2-safepoint-input: ' + message + ' (KEEP)');
}

function unknownKeyOf(value, allowedKeys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) return key;
  }
  return null;
}

function isBoundedString(value, max, allowEmpty) {
  if (typeof value !== 'string') return false;
  if (!allowEmpty && value === '') return false;
  return value.length <= max;
}

function deriveRuntimeSnapshotId(seq) {
  if (seq === null || seq === undefined) return null;
  return 'rss_' + String(seq);
}

// ---- structural protocol readers (structure only, never text) ----

// Tool-call block identity is protocol structure (which obligation is
// open), never content: accept every production id field spelling.
function toolCallIdOfBlock(block) {
  if (!block || typeof block !== 'object') return null;
  for (const key of ['id', 'callId', 'toolCallId']) {
    if (typeof block[key] === 'string' && block[key] !== '') return block[key];
  }
  return null;
}

function toolCallIdsOfAssistantEvent(event) {
  const content = event && event.data && event.data.message && Array.isArray(event.data.message.content)
    ? event.data.message.content
    : [];
  const ids = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'tool-call') continue;
    const id = toolCallIdOfBlock(block);
    if (id !== null) ids.push(id);
  }
  return ids;
}

// tool/result obligation identity: the call this result closes.
function toolResultCallIdOf(event) {
  if (!event || typeof event !== 'object' || event.type !== 'tool/result') return null;
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const source = data.message && typeof data.message === 'object' ? data.message.source : null;
  if (source && typeof source.callId === 'string' && source.callId !== '') return source.callId;
  const content = data.message && Array.isArray(data.message.content) ? data.message.content : [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.toolCallId === 'string' && block.toolCallId !== '') return block.toolCallId;
  }
  if (typeof data.callId === 'string' && data.callId !== '') return data.callId;
  return null;
}

function turnOf(event) {
  const data = event && typeof event.data === 'object' && event.data !== null ? event.data : {};
  return data.turn === undefined || data.turn === null ? null : String(data.turn);
}

function stepOf(event) {
  const data = event && typeof event.data === 'object' && event.data !== null ? event.data : {};
  return data.step === undefined || data.step === null ? null : String(data.step);
}

// A host-owned runtime-context node is identified by surface/event
// ordering plus DSH projection ownership/provenance only (the A01/A02
// rule): a user/message whose source is the DSH system-prompt plugin.
// NEVER semantic text matching.
function isRuntimeContextMessage(event) {
  if (!event || event.type !== 'user/message') return false;
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const message = data && typeof data === 'object' && data.role !== undefined ? data : null;
  const source = message && typeof message.source === 'object' && message.source !== null ? message.source : null;
  if (!source || source.kind !== 'plugin') return false;
  return source.plugin === '@deepseek-ai/dsh-system-prompt';
}

// ---- closed-world input validation (runs BEFORE any decision logic) ----

function validateSessionEvents(events) {
  if (!Array.isArray(events)) failInput('sessionEvents must be an array');
  if (events.length > SAFEPOINT_BOUNDS.eventsMax) failInput('sessionEvents exceeds the bound');
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event || typeof event !== 'object' || Array.isArray(event)) failInput('sessionEvents[' + index + '] must be an object');
    if (typeof event.type !== 'string' || event.type === '') failInput('sessionEvents[' + index + '].type is required');
    if (event.seq !== index) failInput('sessionEvents must be contiguous from 0 (expected seq ' + index + ')');
    if (!event.data || typeof event.data !== 'object') failInput('sessionEvents[' + index + '].data is required');
  }
  return events;
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object') failInput('state is required');
  const unknown = unknownKeyOf(input, SAFEPOINT_INPUT_EXACT_KEYS);
  if (unknown !== null) failInput('unknown field ' + unknown);
  if (Number(input.schemaVersion) !== SAFEPOINT_SCHEMA_VERSION) failInput('schemaVersion must be 1');
  if (!isBoundedString(input.taskId, SAFEPOINT_BOUNDS.taskId, false)) failInput('taskId is required (bounded string)');
  if (!isBoundedString(input.taskInstanceId, SAFEPOINT_BOUNDS.taskInstanceId, false)) {
    failInput('taskInstanceId is required (bounded string)');
  }
  if (!isBoundedString(input.sessionId, SAFEPOINT_BOUNDS.sessionId, false)) failInput('sessionId is required (bounded string)');
  const sessionEvents = validateSessionEvents(input.sessionEvents);
  const durable = input.sessionDurable;
  if (!durable || typeof durable !== 'object') failInput('sessionDurable is required');
  const unknownDurable = unknownKeyOf(durable, SAFEPOINT_DURABLE_EXACT_KEYS);
  if (unknownDurable !== null) failInput('unknown sessionDurable field ' + unknownDurable);
  if (durable.flushedSeq !== null && durable.flushedSeq !== undefined && (!Number.isInteger(durable.flushedSeq) || durable.flushedSeq < 0)) {
    failInput('sessionDurable.flushedSeq must be a non-negative integer or null');
  }
  if (typeof durable.flushParticipated !== 'boolean') failInput('sessionDurable.flushParticipated must be boolean');
  const controller = input.controller;
  if (!controller || typeof controller !== 'object') failInput('controller is required');
  const unknownController = unknownKeyOf(controller, SAFEPOINT_CONTROLLER_EXACT_KEYS);
  if (unknownController !== null) failInput('unknown controller field ' + unknownController);
  if (!isBoundedString(controller.taskStatus, SAFEPOINT_BOUNDS.taskStatus, false)) failInput('controller.taskStatus is required');
  if (typeof controller.transitionOpen !== 'boolean') failInput('controller.transitionOpen must be boolean');
  if (typeof controller.completionCommitted !== 'boolean') failInput('controller.completionCommitted must be boolean');
  if (controller.taskRevision !== null && controller.taskRevision !== undefined &&
      !isBoundedString(controller.taskRevision, SAFEPOINT_BOUNDS.taskRevision, true)) {
    failInput('controller.taskRevision exceeds the bound');
  }
  const runtime = input.runtime;
  if (!runtime || typeof runtime !== 'object') failInput('runtime is required');
  const unknownRuntime = unknownKeyOf(runtime, SAFEPOINT_RUNTIME_EXACT_KEYS);
  if (unknownRuntime !== null) failInput('unknown runtime field ' + unknownRuntime);
  if (runtime.currentSnapshotSeq !== null && runtime.currentSnapshotSeq !== undefined &&
      (!Number.isInteger(runtime.currentSnapshotSeq) || runtime.currentSnapshotSeq < 0)) {
    failInput('runtime.currentSnapshotSeq must be a non-negative integer or null');
  }
  if (typeof runtime.transitionOpen !== 'boolean') failInput('runtime.transitionOpen must be boolean');
  return {
    schemaVersion: SAFEPOINT_SCHEMA_VERSION,
    taskId: String(input.taskId),
    taskInstanceId: String(input.taskInstanceId),
    sessionId: String(input.sessionId),
    sessionEvents,
    sessionDurable: {
      flushedSeq: durable.flushedSeq === undefined ? null : durable.flushedSeq,
      flushParticipated: Boolean(durable.flushParticipated),
    },
    controller: {
      taskStatus: String(controller.taskStatus),
      transitionOpen: Boolean(controller.transitionOpen),
      completionCommitted: Boolean(controller.completionCommitted),
      taskRevision: controller.taskRevision === undefined ? null : controller.taskRevision,
    },
    runtime: {
      currentSnapshotSeq: runtime.currentSnapshotSeq === undefined ? null : runtime.currentSnapshotSeq,
      transitionOpen: Boolean(runtime.transitionOpen),
    },
  };
}

// ---- execution-edge fold (the open-edge state machine) ----

function foldExecutionEdges(sessionEvents) {
  let openTurn = null;
  let openStep = null;
  // callId -> { requestedSeq, callSeq|null, turn, step }
  const pendingCalls = new Map();
  // chunkKey -> { turn, step, firstSeq } for chunk runs with no closing
  // assistant/message yet. Keyed structurally by (turn, step).
  const openChunkRuns = new Map();
  const chunkKeyOf = (turn, step) => String(turn === null ? '' : turn) + '\u0000' + String(step === null ? '' : step);
  for (const event of sessionEvents) {
    switch (event.type) {
      case 'turn/start':
        openTurn = turnOf(event) === null ? '__open__' : turnOf(event);
        break;
      case 'turn/end':
        openTurn = null;
        break;
      case 'step/start':
        openStep = stepOf(event) === null ? '__open__' : stepOf(event);
        break;
      case 'step/end':
        openStep = null;
        // A committed step closes the tool obligations scoped to it only
        // when their results were recorded; unrecorded results stay open
        // (they are reported as tool blockers below, never dropped here).
        break;
      case 'assistant/message': {
        const ids = toolCallIdsOfAssistantEvent(event);
        for (const id of ids) {
          if (!pendingCalls.has(id)) {
            pendingCalls.set(id, { requestedSeq: event.seq, callSeq: null, turn: turnOf(event), step: stepOf(event) });
          }
        }
        // A committed assistant message closes the chunk run for its
        // (turn, step): streaming for that scope is complete.
        openChunkRuns.delete(chunkKeyOf(turnOf(event), stepOf(event)));
        break;
      }
      case 'assistant/chunk': {
        const key = chunkKeyOf(turnOf(event), stepOf(event));
        if (!openChunkRuns.has(key)) openChunkRuns.set(key, { turn: turnOf(event), step: stepOf(event), firstSeq: event.seq });
        break;
      }
      case 'tool/call': {
        const data = event.data && typeof event.data === 'object' ? event.data : {};
        const callId = typeof data.callId === 'string' && data.callId !== '' ? data.callId : null;
        if (callId !== null && pendingCalls.has(callId)) pendingCalls.get(callId).callSeq = event.seq;
        break;
      }
      case 'tool/result': {
        const callId = toolResultCallIdOf(event);
        if (callId !== null) pendingCalls.delete(callId);
        break;
      }
      default:
        break;
    }
  }
  return { openTurn, openStep, pendingCalls, openChunkRuns };
}

function lastSurfaceEvent(sessionEvents) {
  for (let index = sessionEvents.length - 1; index >= 0; index -= 1) {
    if (SURFACE_EVENT_TYPES.includes(sessionEvents[index].type)) return sessionEvents[index];
  }
  return null;
}

// ---- authoritative detection ----

function detectSafePointV2(input) {
  const state = normalizeInput(input);
  const events = state.sessionEvents;
  // Pinned-host sequence contract, Outcome A, proven against
  // DSH session 0.1.1-rc.2 source: append assigns seq equal to log
  // length; the restore constructor rejects any seed whose persisted seq
  // differs from its index; the surface fold rejects non-contiguous seq;
  // the storage codec carries the ordinal explicitly as chunk-row seq0
  // with members at seq0 plus k. Position and persisted field agree by
  // host contract, and validateSessionEvents already proved contiguity,
  // so absent or malformed seqs fail closed there and never default to a
  // position.
  let boundaryEvent = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type !== SEED_MARKER_TYPE) { boundaryEvent = events[index]; break; }
  }
  const candidateSeq = boundaryEvent === null ? null : boundaryEvent.seq;
  const blockers = [];
  const block = (code, detail) => {
    blockers.push(Object.freeze({ code, detail: detail === undefined || detail === null ? null : String(detail) }));
  };

  if (events.length === 0) {
    block('safe-point-boundary-unavailable', 'session log is empty');
  }

  const edges = foldExecutionEdges(events);
  const lastSurface = events.length === 0 ? null : lastSurfaceEvent(events);
  if (events.length > 0 && lastSurface === null) {
    block('safe-point-boundary-unavailable', 'no message-producing boundary in the log');
  }

  // Streaming: an assistant/chunk run with no closing assistant/message
  // for its (turn, step). Never inferred from text length or timing.
  if (edges.openChunkRuns.size > 0) {
    const scopes = Array.from(edges.openChunkRuns.values())
      .map((run) => 'turn=' + String(run.turn === null ? '?' : run.turn) + ' step=' + String(run.step === null ? '?' : run.step))
      .sort();
    block('safe-point-assistant-stream-open', 'streaming response incomplete (' + scopes.join(', ') + ')');
  }

  // Tool protocol: a request without a result is an open edge. Distinguish
  // "harness never recorded the start" (call-open) from "started but no
  // result committed" (result-pending): production state CAN tell them
  // apart via tool/call presence, so the codes stay separate.
  if (edges.pendingCalls.size > 0) {
    const callOpen = [];
    const resultPending = [];
    for (const [callId, record] of edges.pendingCalls) {
      if (record.callSeq === null || record.callSeq === undefined) callOpen.push(callId);
      else resultPending.push(callId);
    }
    callOpen.sort();
    resultPending.sort();
    if (callOpen.length > 0) block('safe-point-tool-call-open', 'tool request without recorded start: ' + callOpen.join(', '));
    if (resultPending.length > 0) {
      block('safe-point-tool-result-pending', 'tool result not committed: ' + resultPending.join(', '));
    }
  }

  // Tool transaction: an open step scopes in-flight tool execution.
  if (edges.openStep !== null) {
    block('safe-point-tool-transaction-open', 'execution step still open');
  }

  // Controller mutation: TaskController state mid-transition, including a
  // completion that was requested but never committed.
  if (state.controller.transitionOpen) {
    block('safe-point-controller-transition-open', 'controller mutation in progress');
  }
  if (String(state.controller.taskStatus).toLowerCase() === 'complete' && !state.controller.completionCommitted) {
    block('safe-point-controller-transition-open', 'completion transition not committed');
  }

  // Session durability: the boundary must be durably established, never
  // merely present in memory. The host durability barrier is the real DSH
  // SessionStore.flush() participation observed as flushedSeq.
  if (candidateSeq !== null) {
    if (!state.sessionDurable.flushParticipated) {
      block('safe-point-session-not-durable', 'no participating durability barrier for boundary seq ' + candidateSeq);
    } else if (state.sessionDurable.flushedSeq === null || state.sessionDurable.flushedSeq === undefined) {
      block('safe-point-session-not-durable', 'durable seq unobserved for boundary seq ' + candidateSeq);
    } else if (state.sessionDurable.flushedSeq < candidateSeq) {
      block('safe-point-session-not-durable', 'boundary seq ' + candidateSeq + ' beyond durable seq ' + state.sessionDurable.flushedSeq);
    }
  }

  // Runtime projection: host-owned runtime state in transition means the
  // current applicable runtime snapshot cannot be determined consistently.
  if (state.runtime.transitionOpen) {
    block('safe-point-runtime-transition', 'runtime projection transition in progress');
  }

  // Protocol balance: the DSH turn/step/tool lifecycle must be balanced
  // (the interruptedTurnClosers rule: an open turn needs synthetic
  // closers, so it is never a safe boundary). Reported separately from
  // the specific stream/tool legs so a bare open turn still blocks.
  if (edges.openTurn !== null) {
    block('safe-point-protocol-unbalanced', 'execution turn still open');
  }

  // Deterministic order: stable code-ascending order, never log order.
  blockers.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const inspectedRevision = Object.freeze({
    taskRevision: state.controller.taskRevision === null || state.controller.taskRevision === undefined
      ? String(state.controller.taskStatus)
      : String(state.controller.taskRevision),
    sessionRevision: Number.isInteger(state.sessionDurable.flushedSeq)
      ? Number(state.sessionDurable.flushedSeq)
      : (candidateSeq === null ? 0 : candidateSeq),
    runtimeSnapshotId: deriveRuntimeSnapshotId(state.runtime.currentSnapshotSeq),
  });

  if (blockers.length > 0) {
    return Object.freeze({
      schemaVersion: SAFEPOINT_SCHEMA_VERSION,
      safe: false,
      boundarySeq: null,
      boundaryKind: null,
      blockers: Object.freeze(blockers.slice()),
      inspectedRevision,
    });
  }

  // Safe: classify the exact durable boundary: the authoritative host seq
  // of the last execution event (durably flushed per the leg above; the
  // host seed-boundary marker is transparent and never the boundary). The
  // kind names the last message-producing event, with step tails and
  // committed completion taking precedence.
  const tail = boundaryEvent;
  let boundaryKind = null;
  const taskComplete = String(state.controller.taskStatus).toLowerCase() === 'complete' && state.controller.completionCommitted;
  if (taskComplete) {
    boundaryKind = 'task-complete';
  } else if (tail.type === 'step/end') {
    boundaryKind = 'controller-step-committed';
  } else if (lastSurface.type === 'tool/result') {
    boundaryKind = 'tool-result-committed';
  } else if (lastSurface.type === 'assistant/message') {
    boundaryKind = 'assistant-turn-committed';
  } else {
    boundaryKind = 'user-turn-committed';
  }

  return Object.freeze({
    schemaVersion: SAFEPOINT_SCHEMA_VERSION,
    safe: true,
    boundarySeq: candidateSeq,
    boundaryKind,
    blockers: Object.freeze([]),
    inspectedRevision,
  });
}

// ---- closed-world decision validation ----

function validateSafePointDecision(decision) {
  const fail = (reason) => ({ valid: false, reason });
  if (!decision || typeof decision !== 'object') return fail('safepoint-decision-missing');
  if (unknownKeyOf(decision, SAFEPOINT_DECISION_EXACT_KEYS) !== null) return fail('safepoint-decision-schema-mismatch');
  if (Number(decision.schemaVersion) !== SAFEPOINT_SCHEMA_VERSION) return fail('safepoint-decision-schema-mismatch');
  if (typeof decision.safe !== 'boolean') return fail('safepoint-decision-schema-mismatch');
  if (!Array.isArray(decision.blockers)) return fail('safepoint-decision-schema-mismatch');
  for (const blocker of decision.blockers) {
    if (!blocker || typeof blocker !== 'object') return fail('safepoint-decision-schema-mismatch');
    if (unknownKeyOf(blocker, SAFEPOINT_BLOCKER_EXACT_KEYS) !== null) return fail('safepoint-decision-schema-mismatch');
    if (!SAFEPOINT_BLOCKER_CODES.includes(blocker.code)) return fail('safepoint-decision-schema-mismatch');
    if (blocker.detail !== null && blocker.detail !== undefined && typeof blocker.detail !== 'string') {
      return fail('safepoint-decision-schema-mismatch');
    }
    if (typeof blocker.detail === 'string' && blocker.detail.length > SAFEPOINT_BOUNDS.detail) {
      return fail('safepoint-decision-schema-mismatch');
    }
  }
  const revision = decision.inspectedRevision;
  if (!revision || typeof revision !== 'object') return fail('safepoint-decision-schema-mismatch');
  if (unknownKeyOf(revision, SAFEPOINT_REVISION_EXACT_KEYS) !== null) return fail('safepoint-decision-schema-mismatch');
  if (decision.safe) {
    if (decision.blockers.length !== 0) return fail('safepoint-safe-with-blockers');
    if (!Number.isInteger(decision.boundarySeq) || decision.boundarySeq < 0) return fail('safepoint-safe-without-boundary');
    if (!SAFEPOINT_BOUNDARY_KINDS.includes(decision.boundaryKind)) return fail('safepoint-safe-without-boundary');
  } else {
    if (decision.blockers.length === 0) return fail('safepoint-unsafe-without-blocker');
    if (decision.boundarySeq !== null && decision.boundarySeq !== undefined) return fail('safepoint-unsafe-with-boundary');
    if (decision.boundaryKind !== null && decision.boundaryKind !== undefined) return fail('safepoint-unsafe-with-boundary');
  }
  return { valid: true, reason: null };
}

// ---- A05 capture-race binding ----
// A SAFE decision never authorizes a later capture by itself: the
// capture-time revision MUST equal the decision revision. Any movement
// (session append, task mutation, runtime change) -> BLOCK with
// safe-point-state-changed; callers retry (re-detect, then capture).
function assertSafePointFresh(decision, currentInput) {
  const block = (reason) => ({ ok: false, reason });
  const check = validateSafePointDecision(decision);
  if (!check.valid) return block(check.reason);
  if (!decision.safe) return block('safe-point-state-changed');
  let current = null;
  try {
    current = detectSafePointV2(currentInput);
  } catch (error) {
    return block('safe-point-state-changed');
  }
  const before = decision.inspectedRevision;
  const after = current.inspectedRevision;
  if (before.taskRevision !== after.taskRevision) return block('safe-point-state-changed');
  if (before.sessionRevision !== after.sessionRevision) return block('safe-point-state-changed');
  if (before.runtimeSnapshotId !== after.runtimeSnapshotId) return block('safe-point-state-changed');
  if (!current.safe) return block('safe-point-state-changed');
  if (current.boundarySeq !== decision.boundarySeq) return block('safe-point-state-changed');
  return { ok: true, reason: null };
}

// ---- A03 checkpoint binding ----
// checkpoint.safePointBoundarySeq MUST come from the exact A06 decision
// used for the snapshot capture. Consumes plain checkpoint-like objects
// ({ safePointBoundarySeq }) so the check works against the real A03
// checkpoint shape without importing builder authority here.
function assertCheckpointBindsSafePoint(checkpoint, decision) {
  const block = (reason) => ({ ok: false, reason });
  const check = validateSafePointDecision(decision);
  if (!check.valid) return block(check.reason);
  if (!decision.safe) return block('safe-point-boundary-mismatch');
  if (!checkpoint || typeof checkpoint !== 'object') return block('safe-point-boundary-mismatch');
  if (!Number.isInteger(checkpoint.safePointBoundarySeq)) return block('safe-point-boundary-mismatch');
  if (checkpoint.safePointBoundarySeq !== decision.boundarySeq) return block('safe-point-boundary-mismatch');
  return { ok: true, reason: null };
}

module.exports = {
  SAFEPOINT_SCHEMA_VERSION,
  SAFEPOINT_BOUNDARY_KINDS,
  SAFEPOINT_BLOCKER_CODES,
  SAFEPOINT_BOUNDS,
  SAFEPOINT_INPUT_EXACT_KEYS,
  SAFEPOINT_DURABLE_EXACT_KEYS,
  SAFEPOINT_CONTROLLER_EXACT_KEYS,
  SAFEPOINT_RUNTIME_EXACT_KEYS,
  SAFEPOINT_DECISION_EXACT_KEYS,
  SAFEPOINT_BLOCKER_EXACT_KEYS,
  SAFEPOINT_REVISION_EXACT_KEYS,
  SEED_MARKER_TYPE,
  detectSafePointV2,
  validateSafePointDecision,
  assertSafePointFresh,
  assertCheckpointBindsSafePoint,
  deriveRuntimeSnapshotId,
};
