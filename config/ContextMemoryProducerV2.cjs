'use strict';
/**
 * ContextMemoryProducerV2.cjs - CCV2-M01 production durable-memory producer.
 *
 * The ONE producer between a real Nexus session and CCv2 durable memory:
 *
 *   canonical session events (DSH surface: user/message, assistant/message,
 *   tool/call, tool/result, turn/*, step/*)
 *     -> structure-aware units (frozen B01 24.7 unit rules only):
 *          one user request            = one conversation unit
 *          one balanced tool unit      = one transaction unit
 *                                        (opening assistant message + its
 *                                        call(s) + result(s), the frozen B03
 *                                        balanced-unit proof shape)
 *          one assistant narration     = one narration unit (24.7 "narration
 *                                        for uncaptured task-relevant state")
 *     -> ContextPageV2 per unit (inline exact text, or B02 blob + exactBlobRef
 *        when the exact text exceeds the inline bound; never truncated)
 *     -> sealed checkpoint per safe turn boundary (A06 -> A05 -> A07 -> A03 ->
 *        A04 seal -> A07 post-build coverage), task state from the controller
 *        authority only (ContextTaskAuthorityV2)
 *     -> B04 tier decisions under the R1 requiredness contract
 *     -> staged C07H/C08 layout under <workspace>/.ai-harness/ccv2/<taskId>/
 *
 * Active turn (ACTIVE-TAIL boundary): the DSH turn/start lifecycle opens a
 * turn; its anchor is the first model-visible message appended after it and
 * never moves (plugin context, skill instructions and claimed follow-ups
 * land after it). While the turn is open its units are produced, ledgered
 * and sealable at turn/end, but excluded from the staged historical set;
 * coverage.json carries the durable activeTurn record hosts verify against
 * the live request.
 *
 * Requiredness (R1.8, no recency/size/LRU/embedding/LLM input): a unit is
 * required when it belongs to the unsealed generation (current turn), to
 * the most recently sealed generation (M01A 45.2: only units OLDER than the
 * newly sealed generation may transition), is reachable from an active
 * checkpoint EvidenceRef, or when authority completeness cannot prove it
 * irrelevant (any category not COMPLETE -> retain conservatively). Every
 * other settled unit transitions to historical-evidence -> COLD with
 * transition reason checkpoint-superseded-unreferenced. Balanced tool units
 * move whole; open/unbalanced protocol never becomes a unit.
 *
 * Incremental + replay: the same pure per-event step drives both. Durable
 * writes are idempotent content-addressed B02 records, an append-only unit
 * ledger, atomic state/staging files, and sealed checkpoints whose every
 * timestamp is the recorded session event time. incremental(1..N) ==
 * replay(1..N) byte-for-byte for identity-relevant durable state.
 */

const durablePolicyV2 = require('./ContextDurableMutationPolicyV2.cjs');

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const trustV2 = require('./ContextTrustV2.cjs');
const snapshotV2 = require('./ContextSnapshotV2.cjs');
const safepointV2 = require('./ContextSafePointV2.cjs');
const gate = require('./ContextCheckpointabilityV2.cjs');
const pageV2 = require('./ContextPageV2.cjs');
const storeV2 = require('./ContextPageStoreV2.cjs');
const tierV2 = require('./ContextMemoryTierV2.cjs');
const authorityV2 = require('./ContextTaskAuthorityV2.cjs');

const PRODUCER_SCHEMA_VERSION = 1;
const PRODUCER_REVISION_V1 = 'nexus-ccv2-producer-v1';
const UNIT_RENDER_REVISION_V1 = 'nexus-ccv2-unit-render-v1';
const AIHARNESS_DIRNAME = '.ai-harness';
const CCV2_DIRNAME = 'ccv2';
const CHECKPOINTS_DIRNAME = 'checkpoints';
const PAGES_DIRNAME = 'pages';
const PRODUCER_DIRNAME = 'producer';
const STATE_FILENAME = 'state.json';
const LEDGER_FILENAME = 'units.jsonl';
const DECISIONS_FILENAME = 'tier-decisions.json';
const TOOL_TX_FILENAME = 'tool-transactions.json';
const STAGED_FILENAME = 'staged.json';
const COVERAGE_FILENAME = 'coverage.json';
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,200}$/;
const SEAL_FAILURES_KEPT = 16;
const UNIT_KINDS = Object.freeze(['conversation', 'tool-transaction', 'narration']);
const SURFACE_TYPES = Object.freeze(['user/message', 'assistant/message', 'tool/result']);

function failProducer(code, detail) {
  throw new Error('context-producer-' + code + (detail === undefined ? '' : ': ' + detail) + ' (KEEP)');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256HexUtf8(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ---- layout ----

function memoryDirForV2(workspace, taskId) {
  if (typeof workspace !== 'string' || workspace === '') failProducer('invalid', 'workspace is required');
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) failProducer('invalid', 'taskId is invalid');
  return path.join(path.resolve(workspace), AIHARNESS_DIRNAME, CCV2_DIRNAME, taskId);
}

function layoutOf(workspace, taskId) {
  const memoryDir = memoryDirForV2(workspace, taskId);
  return Object.freeze({
    memoryDir,
    checkpointsDir: path.join(memoryDir, CHECKPOINTS_DIRNAME),
    pagesDir: path.join(memoryDir, PAGES_DIRNAME),
    producerDir: path.join(memoryDir, PRODUCER_DIRNAME),
    statePath: path.join(memoryDir, PRODUCER_DIRNAME, STATE_FILENAME),
    ledgerPath: path.join(memoryDir, PRODUCER_DIRNAME, LEDGER_FILENAME),
    decisionsPath: path.join(memoryDir, DECISIONS_FILENAME),
    toolTxPath: path.join(memoryDir, TOOL_TX_FILENAME),
    stagedPath: path.join(memoryDir, STAGED_FILENAME),
    coveragePath: path.join(memoryDir, COVERAGE_FILENAME),
    contextRoot: storeV2.contextRootForV2(path.resolve(workspace), taskId),
  });
}

function atomicWriteText(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    try {
      if (fs.readFileSync(target, 'utf8') === text) return false;
    } catch (ignored) { void ignored; }
  }
  const tmp = target + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
  return true;
}

// ---- namespace ----

const NAMESPACE_KEYS = Object.freeze(['taskId', 'taskInstanceId', 'sessionId', 'workspaceId', 'repositoryId', 'checkoutId']);

function normalizeNamespace(ns) {
  if (!isPlainObject(ns)) failProducer('invalid', 'namespace is required');
  for (const key of ['taskId', 'taskInstanceId', 'sessionId', 'workspaceId']) {
    if (typeof ns[key] !== 'string' || ns[key] === '') failProducer('invalid', 'namespace.' + key + ' is required');
  }
  if (!TASK_ID_PATTERN.test(ns.taskId)) failProducer('invalid', 'namespace.taskId is invalid');
  const out = {};
  for (const key of NAMESPACE_KEYS) out[key] = ns[key] === undefined || ns[key] === '' ? null : ns[key];
  return Object.freeze(out);
}

// ---- unit rendering (pure, deterministic, lossless over model content) ----

function renderContentBlocks(content) {
  const parts = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!isPlainObject(block)) continue;
    // Reasoning is never task evidence (A03/B01 forbid reasoning stores).
    if (block.type === 'reasoning') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type !== 'tool-call') parts.push(canonicalJsonOf(block));
  }
  return parts.join('\n');
}

function sourceLabelOf(source) {
  if (!isPlainObject(source) || typeof source.kind !== 'string') return 'unknown';
  if (source.kind === 'user') return 'user';
  const detail = typeof source.plugin === 'string' ? source.plugin : (typeof source.form === 'string' ? source.form : null);
  return detail === null ? source.kind : source.kind + ':' + detail;
}

function renderConversationUnitV2(event) {
  const data = event.data;
  const body = renderContentBlocks(data.content);
  return '[user-message source=' + sourceLabelOf(data.source) + ']\n' + body;
}

function renderNarrationUnitV2(event) {
  return '[assistant]\n' + renderContentBlocks(event.data.message.content);
}

function toolCallsOfAssistant(event) {
  const content = event && event.data && event.data.message && Array.isArray(event.data.message.content)
    ? event.data.message.content : [];
  return content.filter((block) => isPlainObject(block) && block.type === 'tool-call'
    && typeof block.id === 'string' && block.id !== '');
}

function resultCallIdOf(event) {
  const data = event && event.data;
  const message = isPlainObject(data) ? data.message : null;
  if (isPlainObject(message) && isPlainObject(message.source) && typeof message.source.callId === 'string' && message.source.callId !== '') {
    return message.source.callId;
  }
  const content = isPlainObject(message) && Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (isPlainObject(block) && typeof block.toolCallId === 'string' && block.toolCallId !== '') return block.toolCallId;
  }
  return null;
}

// The exact model-visible message a surface event projects to (the DSH
// deriveEventMessage rule): user/message -> data, assistant/message and
// tool/result -> data.message. Its canonical hash is the lossless-
// replacement coverage identity a C08 host compares live messages against.
function surfaceMessageOf(event) {
  if (event.type === 'user/message') return event.data;
  return event.data.message;
}

function surfaceMessageHashV2(event) {
  return sha256HexUtf8(canonicalJsonOf(surfaceMessageOf(event)));
}

function renderToolTransactionUnitV2(assistantEvent, resultEventsByCallId) {
  const lines = [];
  const narration = renderContentBlocks(assistantEvent.data.message.content);
  if (narration !== '') lines.push('[assistant]\n' + narration);
  for (const call of toolCallsOfAssistant(assistantEvent)) {
    const args = typeof call.arguments === 'string' ? call.arguments : canonicalJsonOf(call.arguments === undefined ? null : call.arguments);
    lines.push('[tool-call ' + String(call.name) + ' id=' + call.id + ']\n' + args);
    const resultEvent = resultEventsByCallId[call.id];
    const blocks = resultEvent.data.message.content;
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (!isPlainObject(block) || block.type !== 'tool-result') continue;
      lines.push('[tool-result id=' + call.id + ' error=' + (block.isError === true ? 'true' : 'false') + ']\n'
        + renderContentBlocks(block.content));
    }
  }
  return lines.join('\n');
}

// ---- page materialization (inline exact or B02 blob; never truncated) ----

function isSizeFailure(error) {
  const message = String(error && error.message);
  return message.indexOf('context-page-exact-too-large') !== -1 || message.indexOf('context-page-size-exceeded') !== -1;
}

function materializeUnitPageV2(ctx, unit, text) {
  const base = {
    kind: unit.pageKind,
    namespace: clone(ctx.namespace),
    sourceKind: unit.sourceKind,
    sourceRefs: unit.sourceRefs.slice(),
    mutability: 'immutable',
    sourceSeqs: unit.seqs.slice(),
    createdAtGeneration: unit.createdAtGeneration,
  };
  let page = null;
  let blobRef = null;
  const redacted = checkpointV2.redactCheckpointTextV2(text, text.length * 2 + 4096);
  if (redacted.length <= pageV2.PAGE_BOUNDS.exactTextMaxChars) {
    try {
      page = pageV2.createContextPageV2(Object.assign({}, base, { exactText: text }));
    } catch (error) {
      if (!isSizeFailure(error)) throw error;
      page = null;
    }
  }
  if (page === null) {
    // Large exact material travels the real B02 blob route (A03 redaction,
    // content-addressed, read-back verified). Long-run text fails closed.
    const put = storeV2.putBlobV2(ctx.layout.contextRoot, text);
    blobRef = put.blobRef;
    page = pageV2.createContextPageV2(Object.assign({}, base, { exactBlobRef: put.blobRef, contentHash: put.digest }));
  }
  storeV2.putContextPageV2(ctx.layout.contextRoot, page, { expectedNamespace: clone(ctx.namespace) });
  return { page, blobRef };
}

// ---- state ----

function initialStateV2(namespace) {
  return {
    schemaVersion: PRODUCER_SCHEMA_VERSION,
    producerRevision: PRODUCER_REVISION_V1,
    unitRenderRevision: UNIT_RENDER_REVISION_V1,
    namespace: clone(namespace),
    processedThroughSeq: -1,
    sealedGeneration: 0,
    sealedCheckpointId: null,
    openGroups: {},
    latestUserMessageSeq: null,
    currentTurn: null,
    openTurn: null,
    unitCount: 0,
    blocker: null,
    sealFailures: [],
  };
}

function validateStateV2(state, namespace) {
  if (!isPlainObject(state) || state.schemaVersion !== PRODUCER_SCHEMA_VERSION) failProducer('state-corrupt', 'schema');
  if (state.producerRevision !== PRODUCER_REVISION_V1 || state.unitRenderRevision !== UNIT_RENDER_REVISION_V1) {
    failProducer('state-revision', 'producer revision changed; rebuild through replay');
  }
  if (canonicalJsonOf(state.namespace) !== canonicalJsonOf(namespace)) {
    failProducer('namespace-mismatch', 'memory belongs to another session namespace');
  }
  // State written before the active-turn boundary existed carries no
  // openTurn: it resumes as "no open turn known" (hosts fail closed until
  // the next DSH turn/start re-anchors), never as a guessed boundary.
  if (state.openTurn === undefined) state.openTurn = null;
  if (state.openTurn !== null && !validOpenTurnV2(state.openTurn)) failProducer('state-corrupt', 'openTurn');
  return state;
}

// ---- active turn (DSH turn/start lifecycle; never "latest user text") ----

function validOpenTurnV2(openTurn) {
  if (!isPlainObject(openTurn) || !Number.isInteger(openTurn.turnStartSeq) || openTurn.turnStartSeq < 0) return false;
  if (openTurn.turn !== null && !Number.isInteger(openTurn.turn)) return false;
  if (openTurn.anchorSeq === null) return openTurn.anchorMessageHash === null;
  return Number.isInteger(openTurn.anchorSeq) && openTurn.anchorSeq > openTurn.turnStartSeq
    && typeof openTurn.anchorMessageHash === 'string' && /^[0-9a-f]{64}$/.test(openTurn.anchorMessageHash);
}

// A unit belongs to the open turn when it starts after that turn's
// turn/start event (seq order is the canonical log order).
function unitInOpenTurnV2(state, unit) {
  return state.openTurn !== null && unit.firstSeq > state.openTurn.turnStartSeq;
}

/**
 * Durable active-turn identity: the anchor is the FIRST model-visible
 * message appended after the DSH turn/start of the open turn. Later
 * user-role injections (plugin context, skill instructions, human
 * follow-ups claimed mid-turn) never move it. null when no turn is open.
 */
function activeTurnRecordV2(state) {
  if (state.openTurn === null) return null;
  return {
    turn: state.openTurn.turn,
    turnStartSeq: state.openTurn.turnStartSeq,
    anchorSeq: state.openTurn.anchorSeq,
    anchorMessageHash: state.openTurn.anchorMessageHash,
    processedThroughSeq: state.processedThroughSeq,
  };
}

// ---- tier decisions (R1 requiredness) ----

function requiredSeqsOf(checkpoint) {
  const seqs = new Set();
  if (!checkpoint) return seqs;
  for (const ref of checkpoint.evidenceRefs || []) {
    if (ref && ref.kind === 'event' && /^[0-9]+$/.test(String(ref.locator))) seqs.add(Number(ref.locator));
  }
  return seqs;
}

function authorityFullyCompleteV2(checkpoint) {
  if (!checkpoint) return false;
  for (const category of checkpointV2.AUTHORITY_CATEGORIES) {
    if (!checkpointV2.authorityCategoryCompleteV2(checkpoint, category)) return false;
  }
  return true;
}

/**
 * Pure R1 tier decision for one unit page relative to the latest sealed
 * checkpoint (or none). No clock, size, recency, access, or prose input.
 */
function decideUnitTierV2(input) {
  const unit = input.unit;
  const page = input.page;
  const sealed = input.sealed === undefined ? null : input.sealed;
  const sealedGeneration = sealed === null ? 0 : sealed.generation;
  const inCurrentGeneration = unit.createdAtGeneration > sealedGeneration;
  const inLatestSealedGeneration = sealed !== null && unit.createdAtGeneration === sealedGeneration;
  const reachable = unit.seqs.some((seq) => input.requiredSeqs.has(seq));
  const provablyIrrelevant = sealed !== null && !inCurrentGeneration && !inLatestSealedGeneration
    && !reachable && input.authorityComplete === true;
  if (unit.kind === 'tool-transaction') {
    if (inCurrentGeneration) {
      return tierV2.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page, immediateRelevance: true, retentionRequired: true });
    }
    if (!provablyIrrelevant) {
      return tierV2.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page, retentionRequired: true });
    }
  } else if (!provablyIrrelevant) {
    return tierV2.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page, retentionRequired: true });
  }
  return tierV2.classifyMemoryTierV2({
    subjectKind: 'historical-evidence',
    page,
    historicalTransition: { reason: 'checkpoint-superseded-unreferenced', supersededByGeneration: sealedGeneration },
  });
}

function stateDecisionsForV2(checkpoint) {
  const out = [
    tierV2.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint }),
    tierV2.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint, exactPreservationRequired: true }),
  ];
  const activeReq = checkpoint.requirements.find((req) => req.status === 'active');
  if (activeReq) out.push(tierV2.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint, elementRef: { section: 'requirement', id: activeReq.id } }));
  if (checkpoint.constraints.length > 0) {
    out.push(tierV2.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint, elementRef: { section: 'constraint', text: checkpoint.constraints[0].text } }));
  }
  if (checkpoint.continuation.unresolvedQuestions.length > 0) out.push(tierV2.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint }));
  if (checkpoint.failures.activeFailures.length > 0) {
    out.push(tierV2.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint, elementRef: { section: 'failure', id: checkpoint.failures.activeFailures[0].id } }));
  }
  const activeDecision = checkpoint.decisions.find((entry) => entry.status === 'active');
  if (activeDecision) out.push(tierV2.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint, elementRef: { section: 'decision', id: activeDecision.id } }));
  if (checkpoint.verification.outcomes.length > 0) out.push(tierV2.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint }));
  if (checkpoint.failures.rejectedHypotheses.length > 0 || (checkpoint.failures.retryState !== null && checkpoint.failures.retryState !== undefined)) {
    out.push(tierV2.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint }));
  }
  return out;
}

// ---- sealing (A06 -> A05 -> A07 -> A03/A04 -> A07 coverage) ----

function isoOfEvent(event) {
  if (!event || !Number.isFinite(event.time)) failProducer('invalid', 'boundary event carries no recorded time');
  return new Date(event.time).toISOString();
}

function trySealBoundaryV2(ctx, state, boundaryEvent, eventsThrough, durability) {
  const authority = ctx.controllerAuthority();
  if (!isPlainObject(authority) || !isPlainObject(authority.manifest)) failProducer('authority-unavailable', 'controller manifest is required');
  const events = eventsThrough(boundaryEvent.seq);
  const generation = state.sealedGeneration + 1;
  const boundarySeq = boundaryEvent.seq;
  const atUtc = isoOfEvent(boundaryEvent);
  const objectiveEvent = authorityV2.findObjectiveEvidenceEventV2(authority.manifest.description, events);
  const derived = authorityV2.deriveControllerTaskStateV2({
    manifest: authority.manifest,
    authorityRecord: authority.authorityRecord === undefined ? null : authority.authorityRecord,
    namespace: ctx.namespace,
    boundary: { generation, safePointBoundarySeq: boundarySeq, sessionRevision: boundarySeq },
    objectiveEvent,
  });
  const taskState = derived.taskState;
  const taskStatus = taskState.progress.taskStatus;
  const safe = safepointV2.detectSafePointV2({
    schemaVersion: 1,
    taskId: ctx.namespace.taskId,
    taskInstanceId: ctx.namespace.taskInstanceId,
    sessionId: ctx.namespace.sessionId,
    sessionEvents: events,
    sessionDurable: { flushedSeq: durability.flushedSeq, flushParticipated: durability.flushParticipated === true },
    controller: {
      taskStatus,
      transitionOpen: false,
      completionCommitted: taskStatus.toLowerCase() === 'complete',
      taskRevision: taskState.taskRevision,
    },
    runtime: { currentSnapshotSeq: null, transitionOpen: false },
  });
  if (!safe.safe || safe.boundarySeq !== boundarySeq) {
    return { sealed: false, blockers: safe.blockers.map((entry) => entry.code).concat(safe.safe ? ['boundary-mismatch'] : []) };
  }
  const token = snapshotV2.capture({
    taskId: ctx.namespace.taskId,
    taskInstanceId: ctx.namespace.taskInstanceId,
    sessionId: ctx.namespace.sessionId,
    workspaceId: ctx.namespace.workspaceId,
    repositoryId: ctx.namespace.repositoryId,
    checkoutId: ctx.namespace.checkoutId,
    generation,
    safePointBoundarySeq: boundarySeq,
    sessionRevision: boundarySeq,
    taskRevision: taskState.taskRevision,
    repositoryRevision: { headCommit: null, indexDigest: null, worktreeDigest: null },
    runtimeRevision: null,
  }, atUtc);
  const decision = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState, safePointDecision: safe, snapshotToken: token });
  if (!decision.checkpointable) return { sealed: false, blockers: decision.blockers.map((entry) => entry.code) };
  const checkpointInput = Object.assign({
    taskId: ctx.namespace.taskId,
    taskInstanceId: ctx.namespace.taskInstanceId,
    sessionId: ctx.namespace.sessionId,
    workspaceId: ctx.namespace.workspaceId,
    repositoryId: ctx.namespace.repositoryId,
    checkoutId: ctx.namespace.checkoutId,
    generation,
    kind: taskStatus.toLowerCase() === 'complete' ? 'complete' : 'active',
    parentCheckpointId: generation === 1 ? null : state.sealedCheckpointId,
    safePointBoundarySeq: boundarySeq,
    safePointStepId: null,
    createdAtUtc: atUtc,
    snapshotToken: token,
    pressure: null,
  }, clone(derived.checkpointFields));
  const built = trustV2.buildSealedCheckpointV2(checkpointInput, derived.provenanceInputs, { sealedAtUtc: atUtc });
  const coverage = gate.assertCheckpointCoverageV2({
    schemaVersion: 1, taskState, checkpoint: built.checkpoint, snapshotToken: token, safePointDecision: safe,
  });
  if (!coverage.ok) return { sealed: false, blockers: ['checkpointability-checkpoint-coverage-mismatch'] };
  const stored = trustV2.persistSealedCheckpointV2(ctx.layout.checkpointsDir, built);
  return { sealed: true, checkpoint: stored.checkpoint };
}

// ---- per-event step ----

function unitOfConversation(state, event) {
  const source = event.data && event.data.source;
  const sourceKind = isPlainObject(source) && source.kind === 'user' ? 'user' : 'controller';
  return {
    kind: 'conversation',
    pageKind: 'conversation',
    sourceKind,
    sourceRefs: ['session-event:' + event.seq],
    seqs: [event.seq],
    firstSeq: event.seq,
    turn: state.currentTurn,
    createdAtGeneration: state.sealedGeneration + 1,
    callIds: [],
    callSeq: null,
    resultSeq: null,
    messageHashes: [surfaceMessageHashV2(event)],
  };
}

function step(ctx, state, event, sink) {
  if (state.blocker !== null) return;
  if (!isPlainObject(event) || !Number.isInteger(event.seq)) {
    state.blocker = { code: 'producer-event-invalid', atSeq: state.processedThroughSeq + 1 };
    return;
  }
  if (SURFACE_TYPES.includes(event.type) && event.surfaceOp !== undefined && event.surfaceOp !== 'append') {
    // A surface replacement rewrites model-visible history; the producer
    // never guesses the new unit boundaries. Fail closed durably.
    state.blocker = { code: 'producer-surface-replacement-unsupported', atSeq: event.seq };
    return;
  }
  if (SURFACE_TYPES.includes(event.type) && state.openTurn !== null && state.openTurn.anchorSeq === null) {
    state.openTurn.anchorSeq = event.seq;
    state.openTurn.anchorMessageHash = surfaceMessageHashV2(event);
    sink.turnMoved();
  }
  switch (event.type) {
    case 'turn/start':
      state.currentTurn = Number.isInteger(event.data && event.data.turn) ? event.data.turn : null;
      state.openTurn = { turn: state.currentTurn, turnStartSeq: event.seq, anchorSeq: null, anchorMessageHash: null };
      sink.turnMoved();
      return;
    case 'user/message': {
      const unit = unitOfConversation(state, event);
      sink.addUnit(unit, renderConversationUnitV2(event));
      if (renderContentBlocks(event.data.content) !== '') state.latestUserMessageSeq = event.seq;
      return;
    }
    case 'assistant/message': {
      const message = event.data && event.data.message;
      if (!isPlainObject(message) || !Array.isArray(message.content) || message.content.length === 0) return;
      const calls = toolCallsOfAssistant(event);
      if (calls.length === 0) {
        if (renderContentBlocks(message.content) === '') return;
        sink.addUnit({
          kind: 'narration', pageKind: 'other', sourceKind: 'agent',
          sourceRefs: ['session-event:' + event.seq], seqs: [event.seq], firstSeq: event.seq,
          turn: state.currentTurn, createdAtGeneration: state.sealedGeneration + 1,
          callIds: [], callSeq: null, resultSeq: null,
          messageHashes: [surfaceMessageHashV2(event)],
        }, renderNarrationUnitV2(event));
        return;
      }
      if (calls.length > 8) {
        state.blocker = { code: 'producer-tool-unit-too-wide', atSeq: event.seq };
        return;
      }
      state.openGroups[String(event.seq)] = {
        assistantSeq: event.seq,
        turn: state.currentTurn,
        callIds: calls.map((call) => call.id),
        callSeqs: {},
        resultSeqs: {},
      };
      return;
    }
    case 'tool/call': {
      const callId = event.data && typeof event.data.callId === 'string' ? event.data.callId : null;
      for (const key of Object.keys(state.openGroups)) {
        const group = state.openGroups[key];
        if (callId !== null && group.callIds.indexOf(callId) !== -1 && group.callSeqs[callId] === undefined) {
          group.callSeqs[callId] = event.seq;
          return;
        }
      }
      return;
    }
    case 'tool/result': {
      const callId = resultCallIdOf(event);
      for (const key of Object.keys(state.openGroups)) {
        const group = state.openGroups[key];
        if (callId === null || group.callIds.indexOf(callId) === -1 || group.resultSeqs[callId] !== undefined) continue;
        group.resultSeqs[callId] = event.seq;
        const complete = group.callIds.every((id) => group.resultSeqs[id] !== undefined && group.callSeqs[id] !== undefined);
        if (!complete) return;
        const assistantEvent = sink.eventAt(group.assistantSeq);
        const resultEvents = {};
        for (const id of group.callIds) resultEvents[id] = sink.eventAt(group.resultSeqs[id]);
        const seqs = [group.assistantSeq]
          .concat(group.callIds.map((id) => group.callSeqs[id]))
          .concat(group.callIds.map((id) => group.resultSeqs[id]))
          .sort((a, b) => a - b);
        const first = group.callIds[0];
        sink.addUnit({
          kind: 'tool-transaction', pageKind: 'tool-result', sourceKind: 'tool',
          sourceRefs: group.callIds.map((id) => 'tool-event:' + id),
          seqs, firstSeq: group.assistantSeq, turn: group.turn,
          createdAtGeneration: state.sealedGeneration + 1,
          callIds: group.callIds.slice(), callSeq: group.callSeqs[first], resultSeq: group.resultSeqs[first],
          messageHashes: [surfaceMessageHashV2(assistantEvent)]
            .concat(group.callIds.map((id) => surfaceMessageHashV2(resultEvents[id]))),
        }, renderToolTransactionUnitV2(assistantEvent, resultEvents));
        delete state.openGroups[key];
        return;
      }
      return;
    }
    case 'turn/end':
      sink.boundary(event);
      // Sealed or not, the turn is closed: its units join the historical set.
      state.openTurn = null;
      sink.turnMoved();
      return;
    default:
      return;
  }
}

// ---- staging (pure projection -> files) ----

function computeStagedSetV2(state, units, pagesById, sealed, decisionCache) {
  const requiredSeqs = requiredSeqsOf(sealed);
  const authorityComplete = authorityFullyCompleteV2(sealed);
  const pages = [];
  const decisions = sealed === null ? [] : stateDecisionsForV2(sealed);
  const toolTransactions = [];
  const tiers = { HOT: 0, WARM: 0, COLD: 0 };
  const covered = new Set();
  let currentTurnMessageHash = null;
  let activeTurnUnits = 0;
  for (const unit of units) {
    // The latest user message is the LIVE current turn: the request itself
    // carries it exactly once, so it is never also staged as a page.
    if (unit.kind === 'conversation' && unit.firstSeq === state.latestUserMessageSeq) {
      currentTurnMessageHash = unit.messageHashes[0];
      continue;
    }
    // Open-turn units stay provider-native in the live request: they are
    // produced and ledgered (and seal at turn/end) but never enter the
    // staged historical set active compilation reads.
    if (unitInOpenTurnV2(state, unit)) {
      activeTurnUnits += 1;
      continue;
    }
    for (const hash of unit.messageHashes) covered.add(hash);
    const page = pagesById.get(unit.pageId);
    if (page === undefined) failProducer('state-corrupt', 'unit page missing ' + unit.pageId);
    // Decisions are a pure function of (unit, sealed checkpoint): the cache
    // is keyed by both, so a new seal recomputes every unit.
    const cacheKey = unit.pageId + '|' + (sealed === null ? 'none' : sealed.checkpointId);
    let decision = decisionCache instanceof Map ? decisionCache.get(cacheKey) : undefined;
    if (decision === undefined) {
      decision = decideUnitTierV2({ unit, page, sealed, requiredSeqs, authorityComplete });
      if (decisionCache instanceof Map) decisionCache.set(cacheKey, decision);
    }
    pages.push(page);
    decisions.push(decision);
    tiers[decision.tier] = (tiers[decision.tier] || 0) + 1;
    if (unit.kind === 'tool-transaction') {
      toolTransactions.push({ pageId: page.id, callId: unit.callIds[0], callSeq: unit.callSeq, resultSeq: unit.resultSeq });
    }
  }
  return {
    pages, decisions, toolTransactions, tiers, activeTurnUnits,
    activeTurn: activeTurnRecordV2(state),
    coverage: { hashes: Array.from(covered).sort(), currentTurnMessageHash },
  };
}

function writeStagedV2(layout, state, staged, sealed) {
  fs.mkdirSync(layout.pagesDir, { recursive: true });
  const wanted = new Set(staged.pages.map((page) => page.id + '.json'));
  for (const entry of fs.readdirSync(layout.pagesDir)) {
    if (entry.endsWith('.json') && !wanted.has(entry)) fs.unlinkSync(path.join(layout.pagesDir, entry));
  }
  for (const page of staged.pages) {
    const target = path.join(layout.pagesDir, page.id + '.json');
    if (!fs.existsSync(target)) atomicWriteText(target, canonicalJsonOf(page));
  }
  atomicWriteText(layout.toolTxPath, canonicalJsonOf(staged.toolTransactions));
  if (staged.decisions.length > 0) atomicWriteText(layout.decisionsPath, canonicalJsonOf(staged.decisions));
  // Lossless-replacement coverage: every model-visible message the staged
  // memory represents (C08 hosts prove each non-current live message is
  // covered before replacing the bulk history).
  atomicWriteText(layout.coveragePath, canonicalJsonOf({
    schemaVersion: PRODUCER_SCHEMA_VERSION,
    processedThroughSeq: state.processedThroughSeq,
    sealedCheckpointId: sealed === null ? null : sealed.checkpointId,
    currentTurnMessageHash: staged.coverage.currentTurnMessageHash,
    messageHashes: staged.coverage.hashes,
    activeTurn: staged.activeTurn,
  }));
  atomicWriteText(layout.stagedPath, canonicalJsonOf({
    schemaVersion: PRODUCER_SCHEMA_VERSION,
    producerRevision: PRODUCER_REVISION_V1,
    processedThroughSeq: state.processedThroughSeq,
    sealedGeneration: state.sealedGeneration,
    sealedCheckpointId: sealed === null ? null : sealed.checkpointId,
    stagedPageCount: staged.pages.length,
    toolTransactionCount: staged.toolTransactions.length,
    tierCounts: staged.tiers,
    decisionsDigest: sha256HexUtf8(canonicalJsonOf(staged.decisions)),
    excludedCurrentTurnSeq: state.latestUserMessageSeq,
    activeTurn: staged.activeTurn,
    excludedActiveTurnUnitCount: staged.activeTurnUnits,
    blocker: state.blocker,
  }));
}

// ---- producer ----

function readLedgerV2(layout, unitCount) {
  if (!fs.existsSync(layout.ledgerPath)) {
    if (unitCount !== 0) failProducer('state-corrupt', 'unit ledger missing');
    return [];
  }
  const lines = fs.readFileSync(layout.ledgerPath, 'utf8').split('\n').filter((line) => line !== '');
  if (lines.length < unitCount) failProducer('state-corrupt', 'unit ledger shorter than committed state');
  if (lines.length > unitCount) {
    // Crash debris past the committed state: deterministic re-derivation
    // re-appends identical lines, so truncate to the committed prefix.
    atomicWriteText(layout.ledgerPath, lines.slice(0, unitCount).map((line) => line + '\n').join(''));
  }
  return lines.slice(0, unitCount).map((line) => JSON.parse(line));
}

function latestSealedCheckpointV2(layout, generation) {
  if (generation === 0) return null;
  const stored = trustV2.readSealedCheckpointV2(layout.checkpointsDir, generation);
  if (stored === null) failProducer('state-corrupt', 'sealed checkpoint ' + generation + ' is missing');
  return stored.checkpoint;
}

/**
 * Open (or resume) the producer for one task/session namespace.
 * deps: { workspace, namespace, controllerAuthority: () => ({ manifest,
 *         authorityRecord }), log? }
 */
function openMemoryProducerV2(deps) {
  durablePolicyV2.assertDurableMutationAllowedV2();
  if (!isPlainObject(deps)) failProducer('invalid', 'deps are required');
  const namespace = normalizeNamespace(deps.namespace);
  if (typeof deps.controllerAuthority !== 'function') failProducer('invalid', 'controllerAuthority is required');
  const layout = layoutOf(deps.workspace, namespace.taskId);
  const ctx = { namespace, layout, controllerAuthority: deps.controllerAuthority };
  let state = null;
  if (fs.existsSync(layout.statePath)) {
    state = validateStateV2(JSON.parse(fs.readFileSync(layout.statePath, 'utf8')), namespace);
  } else {
    if (fs.existsSync(layout.memoryDir) && fs.readdirSync(layout.memoryDir).some((entry) => entry !== PRODUCER_DIRNAME)) {
      failProducer('namespace-mismatch', 'memory dir holds foreign state without a producer cursor');
    }
    state = initialStateV2(namespace);
  }
  const units = readLedgerV2(layout, state.unitCount);
  const pagesById = new Map();
  for (const unit of units) {
    pagesById.set(unit.pageId, storeV2.readContextPageV2(layout.contextRoot, unit.pageId, { expectedNamespace: clone(namespace) }));
  }
  let sealed = latestSealedCheckpointV2(layout, state.sealedGeneration);

  function commit(pendingLines) {
    if (pendingLines.length > 0) {
      fs.mkdirSync(layout.producerDir, { recursive: true });
      fs.appendFileSync(layout.ledgerPath, pendingLines.join(''));
    }
    atomicWriteText(layout.statePath, canonicalJsonOf(state));
  }

  /**
   * Ingest events (any batch shape: one event live, the whole log on
   * replay). eventsThrough(seq) must return the contiguous canonical log
   * [0..seq]; durability names the host durability barrier observation.
   */
  function ingest(events, options) {
    const opts = isPlainObject(options) ? options : {};
    const eventsThrough = typeof opts.eventsThrough === 'function' ? opts.eventsThrough : null;
    if (eventsThrough === null) failProducer('invalid', 'eventsThrough is required');
    const eventAtFn = typeof opts.eventAt === 'function' ? opts.eventAt : (seq) => {
      const found = eventsThrough(seq);
      return found[found.length - 1];
    };
    const durability = isPlainObject(opts.durability) ? opts.durability : { flushedSeq: null, flushParticipated: false };
    const ordered = (Array.isArray(events) ? events : []).slice().sort((a, b) => a.seq - b.seq);
    const pendingLines = [];
    let unitsAdded = 0;
    let sealsAdded = 0;
    let turnMoves = 0;
    const sink = {
      turnMoved() {
        turnMoves += 1;
      },
      eventAt(seq) {
        const event = eventAtFn(seq);
        if (!event || event.seq !== seq) failProducer('source-mismatch', 'event ' + seq + ' is not canonical');
        return event;
      },
      addUnit(unit, text) {
        const materialized = materializeUnitPageV2(ctx, unit, text);
        const record = {
          unitId: 'u:' + unit.firstSeq,
          kind: unit.kind,
          seqs: unit.seqs.slice(),
          firstSeq: unit.firstSeq,
          turn: unit.turn,
          sourceKind: unit.sourceKind,
          createdAtGeneration: unit.createdAtGeneration,
          pageId: materialized.page.id,
          contentHash: materialized.page.contentHash,
          blobRef: materialized.blobRef,
          callIds: unit.callIds.slice(),
          callSeq: unit.callSeq,
          resultSeq: unit.resultSeq,
          messageHashes: unit.messageHashes.slice(),
        };
        units.push(record);
        pagesById.set(record.pageId, materialized.page);
        pendingLines.push(canonicalJsonOf(record) + '\n');
        state.unitCount += 1;
        unitsAdded += 1;
      },
      boundary(event) {
        const result = trySealBoundaryV2(ctx, state, event, eventsThrough, durability);
        if (result.sealed) {
          sealed = result.checkpoint;
          decisionCache.clear();
          state.sealedGeneration = sealed.generation;
          state.sealedCheckpointId = sealed.checkpointId;
          sealsAdded += 1;
        } else {
          state.sealFailures = state.sealFailures.concat([{ atSeq: event.seq, blockers: result.blockers.slice(0, 8) }]).slice(-SEAL_FAILURES_KEPT);
        }
      },
    };
    for (const event of ordered) {
      if (state.blocker !== null) break;
      if (event.seq <= state.processedThroughSeq) continue;
      if (event.seq !== state.processedThroughSeq + 1) {
        state.blocker = { code: 'producer-sequence-gap', atSeq: event.seq };
        break;
      }
      try {
        step(ctx, state, event, sink);
      } catch (error) {
        state.blocker = { code: 'producer-step-failed', atSeq: event.seq, detail: String(error && error.message).slice(0, 240) };
        break;
      }
      if (state.blocker === null) state.processedThroughSeq = event.seq;
    }
    commit(pendingLines);
    // Staging is a pure projection of (units, sealed checkpoint, current
    // turn): rewrite only when one of them moved (or when asked).
    if (opts.stage === true || (opts.stage !== false && (unitsAdded > 0 || sealsAdded > 0 || turnMoves > 0))) stage();
    return Object.freeze({
      unitsAdded,
      sealsAdded,
      processedThroughSeq: state.processedThroughSeq,
      sealedGeneration: state.sealedGeneration,
      blocker: state.blocker,
    });
  }

  const decisionCache = new Map();
  function stage() {
    const staged = computeStagedSetV2(state, units, pagesById, sealed, decisionCache);
    writeStagedV2(layout, state, staged, sealed);
    return staged;
  }

  function describe() {
    const counts = { conversation: 0, 'tool-transaction': 0, narration: 0 };
    let blobs = 0;
    for (const unit of units) {
      counts[unit.kind] += 1;
      if (unit.blobRef !== null) blobs += 1;
    }
    return Object.freeze({
      namespace: clone(namespace),
      processedThroughSeq: state.processedThroughSeq,
      sealedGeneration: state.sealedGeneration,
      sealedCheckpointId: state.sealedCheckpointId,
      unitCount: units.length,
      unitCounts: counts,
      blobCount: blobs,
      openGroups: Object.keys(state.openGroups).length,
      latestUserMessageSeq: state.latestUserMessageSeq,
      activeTurn: activeTurnRecordV2(state),
      blocker: state.blocker,
      sealFailures: clone(state.sealFailures),
    });
  }

  return Object.freeze({
    layout,
    namespace,
    ingest,
    stage,
    describe,
    units: () => units.map((unit) => clone(unit)),
    sealedCheckpoint: () => sealed,
    pageOf: (pageId) => pagesById.get(pageId) || null,
    processedThroughSeq: () => state.processedThroughSeq,
    blocked: () => state.blocker !== null,
  });
}

/**
 * Deterministic bootstrap/replay of a (pre-M01) session through the SAME
 * per-event step. The persisted log is durable by construction.
 */
function replaySessionV2(deps) {
  durablePolicyV2.assertDurableMutationAllowedV2();
  if (!isPlainObject(deps) || !Array.isArray(deps.events)) failProducer('invalid', 'events are required');
  const events = deps.events;
  for (let index = 0; index < events.length; index += 1) {
    if (!events[index] || events[index].seq !== index) failProducer('source-mismatch', 'replay log must be contiguous from seq 0');
  }
  const producer = openMemoryProducerV2(deps);
  const lastSeq = events.length - 1;
  const result = producer.ingest(events, {
    eventsThrough: (seq) => events.slice(0, seq + 1),
    eventAt: (seq) => events[seq],
    durability: { flushedSeq: lastSeq, flushParticipated: true },
    stage: true,
  });
  return { producer, result };
}

/**
 * Controller authority reader for the live/replay producer: the task
 * manifest plus the native authority record (null for legacy tasks).
 */
function controllerAuthorityReaderV2(workspace, taskId, taskInstanceId) {
  return function readControllerAuthority() {
    const manifestPath = path.join(path.resolve(workspace), AIHARNESS_DIRNAME, 'runs', taskId, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const authorityRecord = authorityV2.readTaskAuthorityRecordV2(workspace, taskId, taskInstanceId);
    return { manifest, authorityRecord };
  };
}

module.exports = {
  PRODUCER_SCHEMA_VERSION,
  PRODUCER_REVISION_V1,
  UNIT_RENDER_REVISION_V1,
  UNIT_KINDS,
  memoryDirForV2,
  layoutOf,
  renderConversationUnitV2,
  renderNarrationUnitV2,
  renderToolTransactionUnitV2,
  decideUnitTierV2,
  stateDecisionsForV2,
  computeStagedSetV2,
  activeTurnRecordV2,
  openMemoryProducerV2,
  replaySessionV2,
  controllerAuthorityReaderV2,
  surfaceMessageHashV2,
};
