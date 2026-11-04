'use strict';

/**
 * A1.2 native shadow intent — Controller-owned shadow intent adapter.
 *
 * Additive and read-only with respect to the Controller: this module NEVER
 * calls begin-attempt and NEVER mutates task, attempt, verification or
 * completion state. It derives a deterministic, restart-stable shadow
 * command identity from an ACTUAL committed Controller task/attempt record
 * (TaskController Task.ps1 lifecycle + attempts.jsonl ledger).
 *
 * Identities (all Controller-owned, never invented here):
 *   taskId          human-facing display identity (a label, not authority)
 *   taskInstanceId  immutable task generation identity (the authority)
 *   attemptId       '<taskId>-A<sequence>' committed by begin-attempt
 *   sessionId       session binding recorded at begin-attempt
 *   startedByTurn   durable turn identity recorded at begin-attempt
 *   commandId       'shadow-<sha256(taskInstanceId/attemptId)>' — derived,
 *                   stable across retry/restart for the same attempt.
 *
 * There is NO atomic Controller-attempt + shadow-outbox commit: the
 * Controller JSONL ledger and the SQLite shadow store cannot share a
 * transaction. Reconciliation (native-shadow.cjs) therefore discovers
 * already-committed attempts and fills missing shadow records without
 * ever creating new attempts.
 *
 * Privacy: the intent payload carries references and digests only
 * (taskId, sequence, executionClass, digested session/turn references,
 * mode-config digest). No prompt text, no credentials, no raw user content.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SHADOW_INTENT_SCHEMA_VERSION = 1;
const SHADOW_BACKEND = 'native';
const SHADOW_COMMAND_PREFIX = 'shadow-';

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v !== '';
}

/**
 * Deterministic command identity for one Controller attempt. Pure:
 * the same (taskInstanceId, attemptId) always yields the same commandId,
 * so retry/restart reuses it and never allocates a second attempt.
 */
function deriveCommandId(taskInstanceId, attemptId) {
  if (!isNonEmptyString(taskInstanceId) || !isNonEmptyString(attemptId)) return null;
  return SHADOW_COMMAND_PREFIX + sha256Hex(taskInstanceId + '/' + attemptId);
}

function defaultReader() {
  return {
    readTaskRecord: function (workspace, taskId) {
      // Authoritative task record: <workspace>/.ai-harness/state/tasks.json
      // ({ schemaVersion: 1, nextSequence, tasks: [...] }), written by
      // TaskController.ps1 Initialize-AihTaskLedger / New-AihTask. The entry
      // holds taskId + taskInstanceId + the attempt counter.
      const ledgerPath = path.join(String(workspace), '.ai-harness', 'state', 'tasks.json');
      const raw = fs.readFileSync(ledgerPath, 'utf8');
      const ledger = JSON.parse(raw);
      const items = ledger && Array.isArray(ledger.tasks) ? ledger.tasks : null;
      if (!items) return null;
      for (const item of items) {
        if (item && item.taskId === taskId) return item;
      }
      return null;
    },
    readAttemptRecords: function (workspace, taskId) {
      const filePath = path.join(String(workspace), '.ai-harness', 'runs', String(taskId), 'attempts.jsonl');
      const records = [];
      let raw;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
        throw e;
      }
      for (const line of String(raw).split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          records.push(JSON.parse(trimmed));
        } catch {
          // Skip corrupt lines exactly like the Controller reader does.
        }
      }
      return records;
    },
  };
}

function fail(code, message) {
  return { ok: false, code: code, message: message, intent: null };
}

/**
 * Resolve a committed Controller attempt to a shadow intent.
 *
 * options: { workspace, taskId, taskInstanceId?, attemptId? }
 *   taskInstanceId (the caller's generation binding) is REQUIRED: a legacy
 *   binding without one can never prove its generation and is refused.
 *   attemptId is optional: when omitted the latest committed attempt record
 *   for the generation is used — but only when it unambiguously belongs to
 *   the bound generation.
 * deps: { reader? } — injected file readers (tests inject synthetic ledgers
 *   shaped exactly like the real TaskController files).
 */
function resolveShadowIntent(options, deps) {
  const o = options || {};
  const workspace = isNonEmptyString(o.workspace) ? o.workspace : '';
  const taskId = isNonEmptyString(o.taskId) ? o.taskId : '';
  const bindingInstance = isNonEmptyString(o.taskInstanceId) ? o.taskInstanceId : '';
  const wantedAttempt = isNonEmptyString(o.attemptId) ? o.attemptId : null;
  if (workspace === '' || taskId === '') return fail('shadow-intent-invalid', 'workspace and taskId are required');
  if (bindingInstance === '') {
    return fail('ambiguous-legacy-binding', 'binding carries no taskInstanceId; the generation cannot be proven and no shadow identity is derived');
  }
  const reader = (deps && deps.reader) || defaultReader();
  let taskRecord = null;
  try {
    taskRecord = reader.readTaskRecord(workspace, taskId);
  } catch (e) {
    return fail('controller-unreadable', 'authoritative task record is unreadable: ' + String((e && e.message) || e));
  }
  if (!taskRecord) return fail('unknown-task', 'task ' + taskId + ' has no authoritative Controller record');
  const authoritativeInstance = isNonEmptyString(taskRecord.taskInstanceId) ? taskRecord.taskInstanceId : '';
  if (authoritativeInstance === '') return fail('controller-unreadable', 'authoritative task record carries no taskInstanceId; refusing to infer generation');
  if (authoritativeInstance !== bindingInstance) {
    return fail('stale-task-instance', 'binding taskInstanceId does not own task ' + taskId + ' anymore; the display id was re-allocated to a new generation');
  }
  let records = null;
  try {
    records = reader.readAttemptRecords(workspace, taskId);
  } catch (e) {
    return fail('controller-unreadable', 'attempt ledger is unreadable: ' + String((e && e.message) || e));
  }
  if (records === null || records.length === 0) {
    return fail('missing-attempt-evidence', 'no committed attempt evidence exists for task ' + taskId + '; the bridge never invents attempts');
  }
  const owned = records.filter(function (r) {
    return r && r.taskId === taskId && r.taskInstanceId === authoritativeInstance && isNonEmptyString(r.attemptId);
  });
  if (owned.length === 0) {
    return fail('missing-attempt-evidence', 'no committed attempt belongs to generation ' + authoritativeInstance + '; refusing to bridge a foreign or stale attempt');
  }
  // H-01: one attempt's timeline is birth + transitions. Immutable identity
  // fields (sequence, executionClass, session/turn binding) are reconstructed
  // from the ACTUAL 'started' event written by begin-attempt; only the
  // CURRENT status is read from the latest event. A later transition record
  // can never rewrite what the attempt was born with.
  function birthOf(matches) {
    for (const r of matches) {
      if (r && r.status === 'started') return r;
    }
    return null;
  }
  let matches = null;
  if (wantedAttempt !== null) {
    matches = owned.filter(function (r) { return r.attemptId === wantedAttempt; });
    if (matches.length === 0) {
      return fail('missing-attempt-evidence', 'attempt ' + wantedAttempt + ' is not a committed attempt of generation ' + authoritativeInstance);
    }
  } else {
    const latestByAttempt = new Map();
    for (const r of owned) latestByAttempt.set(r.attemptId, r);
    if (latestByAttempt.size !== 1) {
      return fail('ambiguous-attempt', 'multiple committed attempts exist for this generation; an explicit attemptId is required to derive one stable shadow identity');
    }
    matches = owned;
  }
  const birth = birthOf(matches);
  if (!birth) {
    return fail('missing-attempt-evidence', 'attempt ' + matches[0].attemptId + ' has no committed started event; immutable attempt identity cannot be reconstructed and is never inferred from transitions');
  }
  const latest = matches[matches.length - 1];
  const sequence = Number(birth.sequence);
  if (!Number.isInteger(sequence) || sequence <= 0) {
    return fail('controller-unreadable', 'committed started event carries no valid sequence; refusing to infer Controller revision');
  }
  if (!isNonEmptyString(birth.executionClass)) {
    return fail('controller-unreadable', 'committed started event carries no executionClass; role identity cannot be proven and is never inferred');
  }
  const commandId = deriveCommandId(authoritativeInstance, birth.attemptId);
  if (!commandId) return fail('shadow-intent-invalid', 'shadow command identity could not be derived');
  // controllerRevision is the Controller's committed attempt counter — the
  // only monotonic Controller revision available in the JSONL ledger,
  // taken from the birth event so later transitions cannot move it.
  const controllerRevision = sequence;
  const sessionId = isNonEmptyString(birth.sessionId) ? birth.sessionId : null;
  const startedByTurn = isNonEmptyString(birth.startedByTurn) ? birth.startedByTurn : null;
  const intent = {
    schemaVersion: SHADOW_INTENT_SCHEMA_VERSION,
    taskId: taskId,
    taskInstanceId: authoritativeInstance,
    attemptId: birth.attemptId,
    sequence: sequence,
    commandId: commandId,
    backend: SHADOW_BACKEND,
    controllerRevision: controllerRevision,
    executionClass: birth.executionClass,
    sessionIdDigest: sessionId ? sha256Hex('session:' + sessionId) : null,
    startedByTurnDigest: startedByTurn ? sha256Hex('turn:' + startedByTurn) : null,
    attemptStatus: isNonEmptyString(latest.status) ? latest.status : null,
  };
  return { ok: true, code: null, message: null, intent: intent };
}

module.exports = {
  SHADOW_INTENT_SCHEMA_VERSION: SHADOW_INTENT_SCHEMA_VERSION,
  SHADOW_BACKEND: SHADOW_BACKEND,
  deriveCommandId: deriveCommandId,
  resolveShadowIntent: resolveShadowIntent,
  defaultReader: defaultReader,
};
