'use strict';
/**
 * ContextTaskAuthorityV2.cjs - CCV2-M01 controller task-state authority.
 *
 * The ONE mapping from Nexus controller records to the CCv2 task state
 * that A07 evaluates and A03 checkpoints (M01A 45.3). The controller is the
 * sole authoritative owner; this module never reads assistant prose, never
 * summarizes, and never infers a category the controller did not record.
 *
 *   LEGACY_BOOTSTRAP (pre-M01 task: no native authority record)
 *     objective    <- manifest.description (verbatim when it fits the A03
 *                     bound; otherwise an exact durable reference to the
 *                     session event carrying the byte-identical text)
 *     requirements <- manifest.acceptanceCriteria (COMPLETE, possibly [])
 *     progress     <- manifest.status (milestones never recorded:
 *                     UNRECORDED_LEGACY)
 *     failures     <- COMPLETE only when manifest.failureSignatures is
 *                     empty (bare signature strings carry no exact active/
 *                     resolved semantics: otherwise UNRECORDED_LEGACY)
 *     verification <- manifest.verification.outcomes when exactly mappable
 *                     (COMPLETE), otherwise UNRECORDED_LEGACY
 *     constraints / decisions / continuation <- UNRECORDED_LEGACY ([])
 *
 *   NATIVE (task created with a native authority record, R1.3)
 *     every category COMPLETE from inception, mutated only through typed
 *     controller operations carrying provenance (applyTaskAuthority
 *     MutationV2); a category the record cannot supply exactly FAILS the
 *     derivation (never degrades to UNRECORDED_LEGACY).
 *
 * Determinism: no clock reads (every timestamp is an explicit input or a
 * recorded session event time), no randomness, canonical JSON only.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const snapshotV2 = require('./ContextSnapshotV2.cjs');
const trustV2 = require('./ContextTrustV2.cjs');

const TASK_AUTHORITY_SCHEMA_VERSION = 1;
const TASK_AUTHORITY_FILENAME = 'ccv2-authority.json';
const TASK_AUTHORITY_REVISION_V1 = 'nexus-ccv2-task-authority-v1';
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,200}$/;
const MUTATIONS_MAX = 4096;

const RECORD_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'origin', 'taskId', 'taskInstanceId', 'createdAtUtc', 'revision',
  'constraints', 'decisions', 'progress', 'continuation', 'failures', 'verification',
  'mutations',
]);
const MUTATION_KINDS = Object.freeze([
  'constraint-add', 'constraint-remove',
  'decision-record', 'decision-supersede',
  'progress-set', 'continuation-set',
  'failure-record', 'failure-resolve',
  'verification-record',
]);
// Typed mutation provenance: the controller accepts proposals; explicit user
// instructions may arrive as sourceKind user through the controller path.
const MUTATION_SOURCE_KINDS = Object.freeze(['controller', 'user', 'verification']);

function failAuthority(code, detail) {
  throw new Error('context-task-authority-' + code + (detail === undefined ? '' : ': ' + detail) + ' (KEEP)');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownKeyOf(value, allowed) {
  if (!isPlainObject(value)) return null;
  for (const key of Object.keys(value)) if (!allowed.includes(key)) return key;
  return null;
}

function sha256HexUtf8(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isIsoUtc(value) {
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value));
}

function boundedText(value, max, what) {
  if (typeof value !== 'string' || value === '') failAuthority('invalid', what + ' must be a non-empty string');
  if (value.length > max) failAuthority('unrepresentable', what + ' exceeds the A03 bound (' + max + ')');
  if (checkpointV2.redactCheckpointTextV2(value, checkpointV2.BOUNDS.redactMaxChars) !== value.trim()) {
    failAuthority('unrepresentable', what + ' is not redaction-stable');
  }
  return value;
}

// ---- native authority record (created at task inception) ----

function authorityRecordPathV2(workspace, taskId) {
  if (typeof workspace !== 'string' || workspace === '') failAuthority('invalid', 'workspace is required');
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) failAuthority('invalid', 'taskId is invalid');
  return path.join(path.resolve(workspace), '.ai-harness', 'runs', taskId, TASK_AUTHORITY_FILENAME);
}

function createNativeAuthorityRecordV2(input) {
  if (!isPlainObject(input)) failAuthority('invalid', 'input is required');
  if (typeof input.taskId !== 'string' || !TASK_ID_PATTERN.test(input.taskId)) failAuthority('invalid', 'taskId is invalid');
  if (typeof input.taskInstanceId !== 'string' || input.taskInstanceId === '') failAuthority('invalid', 'taskInstanceId is required');
  if (!isIsoUtc(input.createdAtUtc)) failAuthority('invalid', 'createdAtUtc must be explicit ISO-8601 input');
  return {
    schemaVersion: TASK_AUTHORITY_SCHEMA_VERSION,
    origin: 'NATIVE',
    taskId: input.taskId,
    taskInstanceId: input.taskInstanceId,
    createdAtUtc: input.createdAtUtc,
    revision: 0,
    constraints: [],
    decisions: [],
    progress: { completedMilestones: [], currentMilestone: null, remainingMilestones: [] },
    continuation: { nextAction: null, unresolvedQuestions: [], recentUserIntent: null },
    failures: { activeFailures: [], rejectedHypotheses: [] },
    verification: { outcomes: [] },
    mutations: [],
  };
}

function validateTaskAuthorityRecordV2(record) {
  const fail = (reason) => ({ valid: false, reason });
  if (!isPlainObject(record)) return fail('record-invalid');
  if (unknownKeyOf(record, RECORD_EXACT_KEYS) !== null) return fail('record-unknown-field');
  if (record.schemaVersion !== TASK_AUTHORITY_SCHEMA_VERSION) return fail('record-schema');
  if (record.origin !== 'NATIVE') return fail('record-origin');
  if (typeof record.taskId !== 'string' || !TASK_ID_PATTERN.test(record.taskId)) return fail('record-task');
  if (typeof record.taskInstanceId !== 'string' || record.taskInstanceId === '') return fail('record-task');
  if (!isIsoUtc(record.createdAtUtc)) return fail('record-created');
  if (!Number.isInteger(record.revision) || record.revision < 0) return fail('record-revision');
  if (!Array.isArray(record.constraints) || !Array.isArray(record.decisions)) return fail('record-shape');
  if (!isPlainObject(record.progress) || !isPlainObject(record.continuation)
    || !isPlainObject(record.failures) || !isPlainObject(record.verification)) return fail('record-shape');
  if (!Array.isArray(record.mutations) || record.mutations.length > MUTATIONS_MAX) return fail('record-mutations');
  if (record.mutations.length !== record.revision) return fail('record-revision');
  // Replaying the typed mutation log over a fresh record must reproduce the
  // current categories exactly: no category may be edited outside the log.
  let replayed = createNativeAuthorityRecordV2(record);
  try {
    for (const mutation of record.mutations) replayed = applyTaskAuthorityMutationV2(replayed, mutation);
  } catch (error) {
    return fail('record-mutation-invalid');
  }
  for (const key of ['constraints', 'decisions', 'progress', 'continuation', 'failures', 'verification']) {
    if (canonicalJsonOf(replayed[key]) !== canonicalJsonOf(record[key])) return fail('record-category-drift');
  }
  return { valid: true, reason: null };
}

function refsOf(mutation) {
  if (!Array.isArray(mutation.sourceRefs) || mutation.sourceRefs.length === 0 || mutation.sourceRefs.length > 8) {
    failAuthority('invalid', 'mutation.sourceRefs must hold 1..8 refs');
  }
  for (const ref of mutation.sourceRefs) {
    if (typeof ref !== 'string' || ref === '' || ref.length > 256) failAuthority('invalid', 'mutation.sourceRefs entries must be bounded');
  }
  return mutation.sourceRefs.slice();
}

/**
 * Pure typed controller mutation. Returns a NEW record (revision + 1) with
 * the mutation appended to the log. Model proposals become authoritative
 * only through this path (sourceKind controller after acceptance).
 */
function applyTaskAuthorityMutationV2(record, mutation) {
  if (!isPlainObject(record) || record.origin !== 'NATIVE') failAuthority('invalid', 'a native authority record is required');
  if (!isPlainObject(mutation)) failAuthority('invalid', 'mutation is required');
  if (!MUTATION_KINDS.includes(mutation.kind)) failAuthority('invalid', 'unknown mutation kind ' + String(mutation.kind));
  if (!MUTATION_SOURCE_KINDS.includes(mutation.sourceKind)) failAuthority('invalid', 'mutation sourceKind must be controller/user/verification');
  const sourceRefs = refsOf(mutation);
  const next = clone(record);
  const B = checkpointV2.BOUNDS;
  switch (mutation.kind) {
    case 'constraint-add': {
      if (mutation.sourceKind === 'verification') failAuthority('invalid', 'constraints come from controller/user');
      const type = boundedText(mutation.type, B.constraintType, 'constraint.type');
      const text = boundedText(mutation.text, B.constraintText, 'constraint.text');
      if (next.constraints.length >= B.constraintsMax) failAuthority('unrepresentable', 'constraint bound reached');
      next.constraints.push({ type, text, sourceKind: mutation.sourceKind, sourceRefs });
      break;
    }
    case 'constraint-remove': {
      if (!Number.isInteger(mutation.index) || mutation.index < 0 || mutation.index >= next.constraints.length) {
        failAuthority('invalid', 'constraint index out of range');
      }
      next.constraints.splice(mutation.index, 1);
      break;
    }
    case 'decision-record': {
      const id = boundedText(mutation.id, B.decisionId, 'decision.id');
      if (next.decisions.some((entry) => entry.id === id)) failAuthority('invalid', 'decision id already recorded');
      const statement = boundedText(mutation.statement, B.decisionStatement, 'decision.statement');
      if (!checkpointV2.DECISION_AUTHORITIES.includes(mutation.authority) || mutation.authority === 'agent-proposed') {
        failAuthority('invalid', 'decision authority must be an accepted (non-proposal) authority');
      }
      if (next.decisions.length >= B.decisionsMax) failAuthority('unrepresentable', 'decision bound reached');
      try {
        trustV2.normalizeField({
          fieldPath: 'decisions.authority', fieldKind: 'decision-authority', value: mutation.authority,
          sourceKind: mutation.sourceKind, sourceRefs, authorityScope: null, decisionValue: mutation.authority,
        });
      } catch (error) {
        failAuthority('invalid', 'decision authority is not establishable by ' + mutation.sourceKind);
      }
      next.decisions.push({ id, statement, authority: mutation.authority, status: 'active', sourceKind: mutation.sourceKind, sourceRefs });
      break;
    }
    case 'decision-supersede': {
      const found = next.decisions.find((entry) => entry.id === mutation.id);
      if (!found || found.status !== 'active') failAuthority('invalid', 'no active decision ' + String(mutation.id));
      found.status = 'superseded';
      break;
    }
    case 'progress-set': {
      const list = (value, what) => {
        if (!Array.isArray(value) || value.length > B.milestonesMax) failAuthority('invalid', what + ' must be a bounded array');
        return value.map((entry, index) => boundedText(entry, B.milestoneText, what + '.' + index));
      };
      next.progress = {
        completedMilestones: list(mutation.completedMilestones, 'progress.completedMilestones'),
        currentMilestone: mutation.currentMilestone === null || mutation.currentMilestone === undefined
          ? null : boundedText(mutation.currentMilestone, B.milestoneText, 'progress.currentMilestone'),
        remainingMilestones: list(mutation.remainingMilestones, 'progress.remainingMilestones'),
      };
      break;
    }
    case 'continuation-set': {
      const questions = mutation.unresolvedQuestions === undefined ? [] : mutation.unresolvedQuestions;
      if (!Array.isArray(questions) || questions.length > B.unresolvedMax) failAuthority('invalid', 'unresolvedQuestions must be bounded');
      next.continuation = {
        nextAction: mutation.nextAction === null || mutation.nextAction === undefined
          ? null : boundedText(mutation.nextAction, B.nextAction, 'continuation.nextAction'),
        unresolvedQuestions: questions.map((entry, index) => boundedText(entry, B.unresolvedText, 'continuation.unresolvedQuestions.' + index)),
        recentUserIntent: mutation.recentUserIntent === null || mutation.recentUserIntent === undefined
          ? null : boundedText(mutation.recentUserIntent, B.recentUserIntent, 'continuation.recentUserIntent'),
      };
      break;
    }
    case 'failure-record': {
      const id = boundedText(mutation.id, B.failureId, 'failure.id');
      if (next.failures.activeFailures.some((entry) => entry.id === id)) failAuthority('invalid', 'failure id already active');
      next.failures.activeFailures.push({
        id,
        status: 'open',
        detail: mutation.detail === null || mutation.detail === undefined ? null : boundedText(mutation.detail, B.failureDetail, 'failure.detail'),
      });
      break;
    }
    case 'failure-resolve': {
      const index = next.failures.activeFailures.findIndex((entry) => entry.id === mutation.id);
      if (index === -1) failAuthority('invalid', 'no active failure ' + String(mutation.id));
      next.failures.activeFailures.splice(index, 1);
      if (mutation.rejectedHypothesis !== undefined && mutation.rejectedHypothesis !== null) {
        next.failures.rejectedHypotheses.push(boundedText(mutation.rejectedHypothesis, B.hypothesisText, 'failure.rejectedHypothesis'));
      }
      break;
    }
    case 'verification-record': {
      if (mutation.sourceKind !== 'verification' && mutation.sourceKind !== 'controller') {
        failAuthority('invalid', 'verification outcomes come from verification/controller');
      }
      const scope = boundedText(mutation.scope, B.verificationScope, 'verification.scope');
      if (!checkpointV2.VERIFICATION_STATUSES.includes(mutation.status)) failAuthority('invalid', 'unknown verification status');
      const outcome = {
        scope,
        status: mutation.status,
        detail: mutation.detail === null || mutation.detail === undefined ? null : boundedText(mutation.detail, B.verificationDetail, 'verification.detail'),
      };
      const existing = next.verification.outcomes.findIndex((entry) => entry.scope === scope);
      if (existing === -1) next.verification.outcomes.push(outcome);
      else next.verification.outcomes[existing] = outcome;
      break;
    }
    default:
      failAuthority('invalid', 'unhandled mutation kind');
  }
  next.revision = record.revision + 1;
  next.mutations = record.mutations.concat([clone(mutation)]);
  return next;
}

function atomicWriteJsonV2(target, value, exclusive) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const text = canonicalJsonOf(value);
  if (exclusive && fs.existsSync(target)) failAuthority('exists', 'authority record already exists');
  const tmp = target + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(tmp, text);
  if (exclusive) {
    try {
      fs.linkSync(tmp, target);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch (ignored) { void ignored; }
      failAuthority('exists', 'authority record already exists');
    }
    fs.unlinkSync(tmp);
  } else {
    fs.renameSync(tmp, target);
  }
  return text;
}

/** Called by the controller at task creation: the task is NATIVE from inception. */
function initializeNativeTaskAuthorityV2(input) {
  const record = createNativeAuthorityRecordV2(input);
  atomicWriteJsonV2(authorityRecordPathV2(input.workspace, input.taskId), record, true);
  return record;
}

/** Returns the validated native record, or null for a legacy (pre-M01) task. */
function readTaskAuthorityRecordV2(workspace, taskId, taskInstanceId) {
  const target = authorityRecordPathV2(workspace, taskId);
  if (!fs.existsSync(target)) return null;
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    failAuthority('corrupt', 'authority record is malformed');
  }
  const check = validateTaskAuthorityRecordV2(record);
  if (!check.valid) failAuthority('corrupt', check.reason);
  if (typeof taskInstanceId === 'string' && record.taskInstanceId !== taskInstanceId) {
    failAuthority('namespace-mismatch', 'authority record belongs to another task instance');
  }
  return record;
}

function mutateTaskAuthorityV2(input) {
  if (!isPlainObject(input)) failAuthority('invalid', 'input is required');
  const current = readTaskAuthorityRecordV2(input.workspace, input.taskId, input.taskInstanceId);
  if (current === null) failAuthority('legacy', 'legacy tasks carry no native authority record');
  const next = applyTaskAuthorityMutationV2(current, input.mutation);
  atomicWriteJsonV2(authorityRecordPathV2(input.workspace, input.taskId), next, false);
  return next;
}

// ---- controller -> CCv2 task state ----

function textOfUserMessageEvent(event) {
  const data = event && event.data;
  if (!isPlainObject(data) || !Array.isArray(data.content)) return null;
  const texts = data.content.filter((block) => isPlainObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
  return texts.length === 0 ? null : texts.join('\n');
}

/**
 * Locate the session event whose user text is byte-identical to the
 * controller objective (the controller-injected task prompt). Structural
 * equality only; returns null when the objective never entered the session.
 */
function findObjectiveEvidenceEventV2(description, events) {
  if (typeof description !== 'string' || description === '' || !Array.isArray(events)) return null;
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue;
    if (textOfUserMessageEvent(event) === description) return event;
  }
  return null;
}

function isoOfEventTime(event) {
  if (!event || !Number.isFinite(event.time)) failAuthority('invalid', 'session event carries no recorded time');
  return new Date(event.time).toISOString();
}

function mapVerificationOutcomes(outcomes) {
  if (!Array.isArray(outcomes)) return null;
  const mapped = [];
  for (const outcome of outcomes) {
    if (!isPlainObject(outcome)) return null;
    const scope = typeof outcome.scope === 'string' ? outcome.scope : null;
    if (scope === null || scope === '' || scope.length > checkpointV2.BOUNDS.verificationScope) return null;
    if (!checkpointV2.VERIFICATION_STATUSES.includes(outcome.status)) return null;
    const detail = outcome.detail === undefined || outcome.detail === null ? null : outcome.detail;
    if (detail !== null && (typeof detail !== 'string' || detail.length > checkpointV2.BOUNDS.verificationDetail)) return null;
    mapped.push({ scope, status: outcome.status, detail, evidenceRefs: [] });
  }
  return mapped;
}

/**
 * Derive the A07 task state, the A03 checkpoint input fields, and the A04
 * provenance inputs for one sealed boundary. Inputs are explicit:
 *   manifest        controller task manifest (runs/<taskId>/manifest.json)
 *   authorityRecord native record or null (legacy)
 *   namespace       { taskId, taskInstanceId, sessionId, workspaceId,
 *                     repositoryId, checkoutId }
 *   boundary        { generation, safePointBoundarySeq, sessionRevision }
 *   objectiveEvent  session event carrying the byte-identical objective,
 *                   or null (see findObjectiveEvidenceEventV2)
 */
function deriveControllerTaskStateV2(input) {
  if (!isPlainObject(input)) failAuthority('invalid', 'input is required');
  const manifest = input.manifest;
  const record = input.authorityRecord === undefined ? null : input.authorityRecord;
  const ns = input.namespace;
  const boundary = input.boundary;
  if (!isPlainObject(manifest)) failAuthority('invalid', 'controller manifest is required');
  if (!isPlainObject(ns) || !isPlainObject(boundary)) failAuthority('invalid', 'namespace and boundary are required');
  if (manifest.taskId !== ns.taskId || manifest.taskInstanceId !== ns.taskInstanceId) {
    failAuthority('namespace-mismatch', 'manifest binds another task instance');
  }
  if (record !== null) {
    const check = validateTaskAuthorityRecordV2(record);
    if (!check.valid) failAuthority('corrupt', check.reason);
    if (record.taskId !== ns.taskId || record.taskInstanceId !== ns.taskInstanceId) {
      failAuthority('namespace-mismatch', 'authority record binds another task instance');
    }
  }
  const native = record !== null;
  const B = checkpointV2.BOUNDS;
  const taskStatus = typeof manifest.status === 'string' && manifest.status !== '' ? manifest.status : null;
  if (taskStatus === null || taskStatus.length > B.objectiveStatus) failAuthority('invalid', 'manifest.status is required');
  const description = typeof manifest.description === 'string' ? manifest.description : '';
  if (description === '') failAuthority('unrepresentable', 'manifest.description is empty');

  const provenance = {};
  const provenanceInputs = {};
  const putProvenance = (fieldPath, sourceKind, fieldKind, sourceRefs, decisionValue) => {
    provenance[fieldPath] = { sourceKind, fieldKind, sourceRefs: sourceRefs.slice(), authorityScope: null };
    provenanceInputs[fieldPath] = { sourceKind, fieldKind, sourceRefs: sourceRefs.slice(), authorityScope: null };
    if (decisionValue !== undefined) provenanceInputs[fieldPath].decisionValue = decisionValue;
  };

  // Objective: verbatim when it fits; otherwise an exact durable reference.
  const evidenceRefs = [];
  const objectiveEvent = input.objectiveEvent === undefined ? null : input.objectiveEvent;
  const objectiveRefs = ['controller:manifest:' + ns.taskId];
  let objectiveText = null;
  const verbatimFits = description.length <= B.objectiveText
    && checkpointV2.redactCheckpointTextV2(description, B.redactMaxChars) === description;
  if (objectiveEvent !== null) {
    if (textOfUserMessageEvent(objectiveEvent) !== description) failAuthority('invalid', 'objective event is not byte-identical');
    const sourceKind = isPlainObject(objectiveEvent.data.source) && objectiveEvent.data.source.kind === 'user' ? 'user' : 'controller';
    evidenceRefs.push({
      schemaVersion: 1,
      evidenceId: 'objective:session-event:' + objectiveEvent.seq,
      kind: 'event',
      locator: String(objectiveEvent.seq),
      digest: sha256HexUtf8(description),
      observedAtUtc: isoOfEventTime(objectiveEvent),
      taskInstanceId: ns.taskInstanceId,
      accessible: true,
      sourceKind,
    });
    objectiveRefs.push('session-event:' + objectiveEvent.seq);
  }
  if (verbatimFits) {
    objectiveText = description;
  } else if (objectiveEvent !== null) {
    objectiveText = 'The objective of ' + ns.taskId + ' is the exact controller task description ('
      + description.length + ' chars, sha256 ' + sha256HexUtf8(description) + '), preserved verbatim as durable '
      + 'session evidence event ' + objectiveEvent.seq + ' (EvidenceRef objective:session-event:' + objectiveEvent.seq + ').';
  } else {
    failAuthority('unrepresentable', 'objective exceeds the A03 bound and never entered the session as exact evidence');
  }
  putProvenance('objective.text', 'controller', 'task-objective', objectiveRefs);

  // Requirements: controller acceptance criteria (authoritative, may be []).
  const criteria = Array.isArray(manifest.acceptanceCriteria) ? manifest.acceptanceCriteria : [];
  const requirements = criteria.map((text, index) => {
    const reqText = boundedText(String(text), B.requirementText, 'acceptanceCriteria.' + index);
    return {
      id: 'AC-' + (index + 1),
      text: reqText,
      status: taskStatus.toLowerCase() === 'complete' ? 'satisfied' : 'active',
      evidenceRefs: [],
      sourceKind: 'controller',
    };
  });
  requirements.forEach((req, index) => {
    const refs = ['policy:task-manifest:acceptance:' + (index + 1)];
    putProvenance('requirements.' + index + '.text', 'controller', 'requirement-text', refs);
    putProvenance('requirements.' + index + '.status', 'controller', 'requirement-status', refs);
  });

  const completeness = {
    origin: native ? 'NATIVE' : 'LEGACY_BOOTSTRAP',
    objective: 'COMPLETE',
    requirements: 'COMPLETE',
    constraints: native ? 'COMPLETE' : 'UNRECORDED_LEGACY',
    progress: native ? 'COMPLETE' : 'UNRECORDED_LEGACY',
    decisions: native ? 'COMPLETE' : 'UNRECORDED_LEGACY',
    failures: 'COMPLETE',
    verification: 'COMPLETE',
    continuation: native ? 'COMPLETE' : 'UNRECORDED_LEGACY',
  };

  const constraints = native ? record.constraints.map((entry) => ({ type: entry.type, text: entry.text, sourceKind: entry.sourceKind })) : [];
  constraints.forEach((entry, index) => {
    const refs = record.constraints[index].sourceRefs.slice();
    if (!refs.some((ref) => /user|policy|session-event/i.test(ref))) refs.push('policy:controller-constraint:' + index);
    putProvenance('constraints.' + index + '.text', entry.sourceKind, 'constraint-text', refs.slice(0, 8));
  });

  const progress = native
    ? {
      taskStatus,
      completedMilestones: record.progress.completedMilestones.slice(),
      currentMilestone: record.progress.currentMilestone,
      remainingMilestones: record.progress.remainingMilestones.slice(),
    }
    : { taskStatus, completedMilestones: [], currentMilestone: null, remainingMilestones: [] };

  const decisions = native ? record.decisions.map((entry) => ({
    id: entry.id, statement: entry.statement, authority: entry.authority, status: entry.status,
    evidenceRefs: [], sourceKind: entry.sourceKind === 'user' ? 'user' : 'controller',
  })) : [];
  decisions.forEach((entry, index) => {
    const refs = record.decisions[index].sourceRefs.slice(0, 8);
    putProvenance('decisions.' + index + '.statement', entry.sourceKind, 'decision-statement', refs);
    putProvenance('decisions.' + index + '.authority', entry.sourceKind, 'decision-authority', refs, entry.authority);
    putProvenance('decisions.' + index + '.status', entry.sourceKind, 'decision-status', refs);
  });

  // Failures.
  let activeFailures = [];
  let rejectedHypotheses = [];
  if (native) {
    activeFailures = record.failures.activeFailures.map((entry) => ({ id: entry.id, status: entry.status, detail: entry.detail, attemptCount: null, evidenceRefs: [] }));
    rejectedHypotheses = record.failures.rejectedHypotheses.slice();
  } else {
    const signatures = Array.isArray(manifest.failureSignatures) ? manifest.failureSignatures : [];
    if (signatures.length > 0) completeness.failures = 'UNRECORDED_LEGACY';
  }
  activeFailures.forEach((entry, index) => {
    if (entry.detail !== null) putProvenance('failures.activeFailures.' + index + '.detail', 'controller', 'failure-detail', ['controller:failure-' + entry.id]);
  });

  // Verification: the controller manifest is the verification authority.
  const manifestOutcomes = isPlainObject(manifest.verification) ? manifest.verification.outcomes : [];
  let outcomes = mapVerificationOutcomes(manifestOutcomes === undefined ? [] : manifestOutcomes);
  if (outcomes === null) {
    if (native) failAuthority('unrepresentable', 'controller verification outcomes are not exactly mappable');
    completeness.verification = 'UNRECORDED_LEGACY';
    outcomes = [];
  }
  if (native) {
    for (const outcome of record.verification.outcomes) {
      if (!outcomes.some((entry) => entry.scope === outcome.scope)) outcomes.push({ scope: outcome.scope, status: outcome.status, detail: outcome.detail, evidenceRefs: [] });
    }
  }
  outcomes.forEach((outcome, index) => {
    putProvenance('verification.outcomes.' + index + '.status', 'verification', 'verification-outcome', ['verification:' + outcome.scope]);
    if (outcome.detail !== null) putProvenance('verification.outcomes.' + index + '.detail', 'verification', 'verification-outcome', ['verification:' + outcome.scope]);
  });

  // Continuation. Native: typed record; when the controller has not set a
  // next action, the lifecycle-derived action for an open task is exact
  // controller authority (the controller owns the attempt lifecycle).
  let continuation = { nextAction: null, unresolvedQuestions: [], recentUserIntent: null };
  if (native) {
    const taskComplete = taskStatus.toLowerCase() === 'complete';
    continuation = {
      nextAction: record.continuation.nextAction !== null
        ? record.continuation.nextAction
        : (taskComplete ? null : 'Continue ' + ns.taskId + ' (' + taskStatus + ') toward the recorded objective.'),
      unresolvedQuestions: record.continuation.unresolvedQuestions.slice(),
      recentUserIntent: record.continuation.recentUserIntent,
    };
  }
  if (continuation.nextAction !== null) putProvenance('continuation.nextAction', 'controller', 'next-action', ['controller:continuation']);
  continuation.unresolvedQuestions.forEach((question, index) => {
    void question;
    putProvenance('continuation.unresolvedQuestions.' + index, 'controller', 'unresolved-question', ['controller:continuation']);
  });
  if (continuation.recentUserIntent !== null) {
    putProvenance('continuation.recentUserIntent', 'controller', 'user-intent', ['user:controller-intent']);
  }

  const repository = {
    repositoryId: ns.repositoryId === undefined ? null : ns.repositoryId,
    checkoutId: ns.checkoutId === undefined ? null : ns.checkoutId,
    headCommit: null,
    baseCommit: typeof manifest.baseCommit === 'string' && manifest.baseCommit !== '' ? manifest.baseCommit : null,
    cleanWorktree: null,
    changedFiles: [],
    changedFileCount: 0,
    stagedSummary: null,
    unstagedSummary: null,
  };
  putProvenance('repository', 'repository', 'repository-fact', ['repository:task-manifest-base']);

  // Validate every provenance slot through the frozen A04 normalizer now so
  // an illegal pairing fails at derivation, not inside the sealed build.
  for (const fieldPath of Object.keys(provenanceInputs)) {
    const slot = provenanceInputs[fieldPath];
    trustV2.normalizeField({
      fieldPath, fieldKind: slot.fieldKind, value: null, sourceKind: slot.sourceKind,
      sourceRefs: slot.sourceRefs, authorityScope: null, decisionValue: slot.decisionValue,
    });
  }

  const taskState = {
    schemaVersion: 1,
    taskId: ns.taskId,
    taskInstanceId: ns.taskInstanceId,
    sessionId: ns.sessionId,
    workspaceId: ns.workspaceId,
    repositoryId: ns.repositoryId === undefined ? null : ns.repositoryId,
    checkoutId: ns.checkoutId === undefined ? null : ns.checkoutId,
    generation: boundary.generation,
    safePointBoundarySeq: boundary.safePointBoundarySeq,
    sessionRevision: boundary.sessionRevision,
    taskRevision: 'pending',
    repositoryRevision: { headCommit: null, indexDigest: null, worktreeDigest: null },
    runtimeRevision: { runtimeSnapshotSeq: null },
    objective: { text: objectiveText, status: taskStatus },
    requirements,
    constraints,
    progress,
    decisions,
    repository: {
      repositoryId: repository.repositoryId, checkoutId: repository.checkoutId, headCommit: null,
      baseCommit: repository.baseCommit, cleanWorktree: null, changedFiles: [], changedFileCount: 0,
      stagedSummary: null, unstagedSummary: null,
    },
    evidenceRefs,
    failures: { activeFailures, rejectedHypotheses, retryState: null },
    verification: { outcomes, note: null },
    continuation,
    provenance,
    ephemeralState: [],
    unsupportedState: [],
    reconstructionRefs: [],
    authorityCompleteness: completeness,
  };
  taskState.taskRevision = snapshotV2.deriveTaskRevision(taskState);

  const checkpointFields = {
    objective: clone(taskState.objective),
    requirements: requirements.map((req) => ({ id: req.id, text: req.text, status: req.status, evidenceRefs: [] })),
    constraints: constraints.map((entry) => ({ type: entry.type, text: entry.text })),
    progress: clone(progress),
    decisions: decisions.map((entry) => ({ id: entry.id, statement: entry.statement, authority: entry.authority, status: entry.status, evidenceRefs: [] })),
    repository: clone(repository),
    evidenceRefs: evidenceRefs.map((ref) => ({
      schemaVersion: 1, evidenceId: ref.evidenceId, kind: ref.kind, locator: ref.locator, digest: ref.digest,
      observedAtUtc: ref.observedAtUtc, taskInstanceId: ref.taskInstanceId,
    })),
    failures: { activeFailures: clone(activeFailures), rejectedHypotheses: rejectedHypotheses.slice(), retryState: null },
    verification: { outcomes: clone(outcomes), note: null },
    continuation: clone(continuation),
    authorityCompleteness: clone(completeness),
  };
  return Object.freeze({ taskState, checkpointFields, provenanceInputs, authorityRevision: native ? record.revision : null });
}

module.exports = {
  TASK_AUTHORITY_SCHEMA_VERSION,
  TASK_AUTHORITY_FILENAME,
  TASK_AUTHORITY_REVISION_V1,
  MUTATION_KINDS,
  authorityRecordPathV2,
  createNativeAuthorityRecordV2,
  validateTaskAuthorityRecordV2,
  applyTaskAuthorityMutationV2,
  initializeNativeTaskAuthorityV2,
  readTaskAuthorityRecordV2,
  mutateTaskAuthorityV2,
  findObjectiveEvidenceEventV2,
  deriveControllerTaskStateV2,
};
