'use strict';
// SPIKE-02 throwaway prototype — NOT production code.
// ControllerIntentV1 durable store. Reuses the existing Controller persistence
// architecture from config/AihController.cjs::persistBindings:
// temp-write + fsync(file) + rename + fsync(dir). Single authoritative record
// per commandId. Projection/delivery state is derived, never a second writer.
//
// Hardening (F-03/F-05): creation uses tmp-write + link(2) exclusive-publish
// so concurrent writers cannot overwrite each other — exactly one wins; losers re-read and
// get idempotent-vs-conflict semantics. attachLease is serialized with a
// mkdir mutex. Identity is the canonical intentDigest (see lib/envelope.cjs);
// issuedAtUtc and lease are mutable/attached state, never identity.
//
// Isolated to a caller-supplied dataRoot (tests use fs.mkdtempSync(os.tmpdir())).
// No production task/session mutation: this store never touches the real
// Controller bindings path.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const envelope = require('./envelope.cjs');
const flock = require('./file-lock.cjs');

const SCHEMA_VERSION = 1;
const KIND = 'ControllerIntentV1';

function canonicalize(value) {
  return envelope.canonicalize(value);
}

function sha256Hex(text) {
  return envelope.sha256Hex(text);
}

function payloadDigestOf(intentPayload) {
  return envelope.payloadDigestOf(intentPayload);
}

function intentDir(dataRoot) {
  return path.join(dataRoot, 'controller-intent');
}

function intentPath(dataRoot, commandId) {
  return path.join(intentDir(dataRoot), commandId + '.json');
}

function atomicWriteJson(targetPath, doc) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporary = targetPath + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(doc, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, targetPath);
  if (process.platform !== 'win32') {
    const dir = fs.openSync(path.dirname(targetPath), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
}

function validateIds({ taskInstanceId, attemptId, commandId }) {
  for (const [name, value] of [['taskInstanceId', taskInstanceId], ['attemptId', attemptId], ['commandId', commandId]]) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\\/]/.test(value)) {
      const error = new Error('invalid ' + name);
      error.code = 'intent-invalid-id';
      throw error;
    }
  }
}

function buildDoc(fields, payloadDigest, intentDigest) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    taskInstanceId: fields.taskInstanceId,
    attemptId: fields.attemptId,
    commandId: fields.commandId,
    backend: fields.backend,
    controllerRevision: fields.controllerRevision || 0,
    role: fields.role,
    modeId: fields.modeId,
    modeConfigRevision: fields.modeConfigRevision === undefined ? null : fields.modeConfigRevision,
    payloadDigest,
    intentDigest,
    intentPayload: fields.intentPayload,
    lease: fields.lease === undefined ? null : fields.lease,
    status: 'committed',
    issuedAtUtc: new Date().toISOString(),
  };
}

function sameImmutableEnvelope(existing, candidateFields, payloadDigest, intentDigest) {
  return existing.intentDigest === intentDigest
    && existing.taskInstanceId === candidateFields.taskInstanceId
    && existing.attemptId === candidateFields.attemptId
    && existing.commandId === candidateFields.commandId;
}

// Commit ONE authoritative intent. Idempotent on identical immutable envelope
// (returns { intent, created: false }); conflicting envelope under the same
// commandId fails closed with code 'intent-conflict' and never allocates a
// second attempt. Creation is O_EXCL: concurrent identical commits yield one
// winner and idempotent losers; concurrent conflicting commits yield one
// winner and conflict losers — never an overwrite. Fault injection
// (crashPoint) is test-only:
//   'before-commit' — throw before any tmp file is renamed (nothing committed)
//   'during-commit' — leave an orphan *.tmp then throw (nothing committed)
//   'after-commit'  — commit, then throw to simulate a lost ACK (one intent committed)
function commitIntent(dataRoot, fields, options) {
  const opts = options || {};
  const { taskInstanceId, attemptId, commandId, backend, role, modeId } = fields;
  validateIds({ taskInstanceId, attemptId, commandId });
  if (backend !== 'native') {
    const error = new Error('only backend=native participates in this spike');
    error.code = 'intent-backend-refused';
    throw error;
  }
  if (typeof role !== 'string' || role === '' || typeof modeId !== 'string' || modeId === '') {
    const error = new Error('role and modeId are required');
    error.code = 'intent-invalid-id';
    throw error;
  }
  const payloadDigest = payloadDigestOf(fields.intentPayload);
  const intentDigest = envelope.intentDigestOf({ ...fields, payloadDigest });
  const dir = intentDir(dataRoot);
  const target = intentPath(dataRoot, commandId);
  fs.mkdirSync(dir, { recursive: true });

  if (opts.crashPoint === 'before-commit') {
    const error = new Error('injected crash before intent commit');
    error.code = 'injected-crash';
    throw error;
  }

  if (opts.crashPoint === 'during-commit') {
    // Simulate a kill between tmp write and rename: orphan tmp, no commit.
    const orphan = target + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(orphan, JSON.stringify(buildDoc(fields, payloadDigest, intentDigest), null, 2));
    const error = new Error('injected crash during intent commit');
    error.code = 'injected-crash';
    throw error;
  }

  const created = flock.exclusivePublishJson(target, buildDoc(fields, payloadDigest, intentDigest));
  if (created.created) {
    if (opts.crashPoint === 'after-commit') {
      const error = new Error('injected crash after intent commit (ACK lost)');
      error.code = 'injected-crash';
      throw error;
    }
    return { intent: readIntent(dataRoot, commandId), created: true };
  }
  // Lost the exclusive race (or a replay): re-read and classify.
  const existing = readIntent(dataRoot, commandId);
  if (existing && sameImmutableEnvelope(existing, fields, payloadDigest, intentDigest)) {
    return { intent: existing, created: false };
  }
  const error = new Error('conflicting payload under existing commandId; refusing second attempt');
  error.code = 'intent-conflict';
  throw error;
}

// Attach the Kernel-issued lease to an already-committed intent (set-once from
// null, or idempotent when identical). Serialized with a mutex so concurrent
// attachers cannot interleave read-modify-write. Any swap fails closed.
function attachLease(dataRoot, commandId, lease) {
  return flock.withLock(dataRoot, 'controller-intent', () => {
    const existing = readIntent(dataRoot, commandId);
    if (!existing) {
      const error = new Error('no such intent');
      error.code = 'intent-not-found';
      throw error;
    }
    if (!lease || typeof lease.epoch !== 'number' || typeof lease.storeIncarnation !== 'string') {
      const error = new Error('invalid lease');
      error.code = 'stale-lease';
      throw error;
    }
    const same = existing.lease && existing.lease.epoch === lease.epoch && existing.lease.storeIncarnation === lease.storeIncarnation;
    if (same) return { intent: existing, updated: false };
    if (existing.lease !== null) {
      const error = new Error('lease already attached; refusing swap');
      error.code = 'intent-conflict';
      throw error;
    }
    const updated = { ...existing, lease };
    atomicWriteJson(intentPath(dataRoot, commandId), updated);
    return { intent: updated, updated: true };
  });
}

function readIntent(dataRoot, commandId) {
  const target = intentPath(dataRoot, commandId);
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

// Query by commandId after a timeout: returns the single committed intent or
// null. Never allocates anything.
function queryByCommandId(dataRoot, commandId) {
  return readIntent(dataRoot, commandId);
}

function countIntents(dataRoot) {
  const dir = intentDir(dataRoot);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length;
}

module.exports = {
  SCHEMA_VERSION,
  KIND,
  canonicalize,
  sha256Hex,
  payloadDigestOf,
  commitIntent,
  attachLease,
  readIntent,
  queryByCommandId,
  countIntents,
  intentPath,
};
