'use strict';
// SPIKE-02 throwaway prototype — NOT production code.
// Mocked Kernel inbox with durable, idempotent command receipts and
// Kernel-owned generation fencing (lease epochs).
//
// - Kernel owns a persistent store incarnation id (created once per kernelRoot).
// - AcquireGeneration(taskInstanceId, backend) monotonically advances the lease
//   epoch for that generation and persists it atomically (tmp+fsync+rename).
// - deliverCommand verifies issuer/provenance/lease binding plus commandId
//   uniqueness, then persists the receipt atomically. Replay of the identical
//   command returns the existing receipt (no second attempt). A different
//   payload under the same commandId fails closed ('command-conflict').
// - Restore of a stale kernel DB (older epoch map / other incarnation) fails
//   closed: callers must re-acquire; the inbox never silently resets epochs.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

function identityPath(kernelRoot) { return path.join(kernelRoot, 'store-identity.json'); }
function leasesPath(kernelRoot) { return path.join(kernelRoot, 'leases.json'); }
function receiptPath(kernelRoot, commandId) { return path.join(kernelRoot, 'inbox', commandId + '.json'); }

function loadIdentity(kernelRoot) {
  const p = identityPath(kernelRoot);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function ensureIdentity(kernelRoot) {
  let identity = loadIdentity(kernelRoot);
  if (!identity) {
    identity = { schemaVersion: 1, storeIncarnation: crypto.randomUUID(), createdAtUtc: new Date().toISOString() };
    atomicWriteJson(identityPath(kernelRoot), identity);
  }
  return identity;
}

function loadLeases(kernelRoot) {
  const p = leasesPath(kernelRoot);
  if (!fs.existsSync(p)) return {};
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  return (doc && doc.leases) || {};
}

// Kernel-issued fencing lease. One generation (taskInstanceId+backend) has at
// most one active epoch; each acquisition supersedes (fences) the previous.
function acquireGeneration(kernelRoot, { taskInstanceId, backend }) {
  if (!taskInstanceId || typeof taskInstanceId !== 'string') {
    const error = new Error('taskInstanceId is required');
    error.code = 'lease-invalid';
    throw error;
  }
  if (backend !== 'native') {
    const error = new Error('only backend=native participates in this spike');
    error.code = 'lease-backend-refused';
    throw error;
  }
  const identity = ensureIdentity(kernelRoot);
  const leases = loadLeases(kernelRoot);
  const key = taskInstanceId + '|' + backend;
  const nextEpoch = ((leases[key] && leases[key].epoch) || 0) + 1;
  leases[key] = { epoch: nextEpoch, storeIncarnation: identity.storeIncarnation, acquiredAtUtc: new Date().toISOString() };
  atomicWriteJson(leasesPath(kernelRoot), { schemaVersion: 1, leases });
  return { leaseEpoch: nextEpoch, storeIncarnation: identity.storeIncarnation };
}

function currentLease(kernelRoot, taskInstanceId, backend) {
  const leases = loadLeases(kernelRoot);
  return leases[taskInstanceId + '|' + backend] || null;
}

function readReceipt(kernelRoot, commandId) {
  const p = receiptPath(kernelRoot, commandId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// crashPoint (test-only): 'before-commit' | 'during-commit' | 'after-commit-before-ack'
function deliverCommand(kernelRoot, { intent, issued, expectedSnapshotDigest }, options) {
  const opts = options || {};
  if (!intent || !issued) {
    const error = new Error('intent and issued resolution are required');
    error.code = 'delivery-invalid';
    throw error;
  }
  if (issued.issuer !== 'registry-bridge' || !issued.provenance || issued.provenance.issuer !== 'registry-bridge') {
    const error = new Error('forged target: untrusted issuer');
    error.code = 'forged-issuer';
    throw error;
  }
  if (intent.backend !== 'native') {
    const error = new Error('backend mismatch');
    error.code = 'backend-mismatch';
    throw error;
  }
  if (issued.taskInstanceId !== intent.taskInstanceId) {
    const error = new Error('generation mismatch between intent and issued target');
    error.code = 'generation-mismatch';
    throw error;
  }
  if (expectedSnapshotDigest !== undefined && issued.provenance.registrySnapshotDigest !== expectedSnapshotDigest) {
    const error = new Error('inconsistent Registry snapshot digest');
    error.code = 'snapshot-mismatch';
    throw error;
  }
  // Lease check: Kernel-owned epoch must be current and incarnation must match.
  const lease = intent.lease;
  const current = currentLease(kernelRoot, intent.taskInstanceId, intent.backend);
  const identity = ensureIdentity(kernelRoot);
  if (!lease || typeof lease.epoch !== 'number') {
    const error = new Error('missing lease authorization');
    error.code = 'stale-lease';
    throw error;
  }
  if (!current || lease.epoch !== current.epoch || lease.storeIncarnation !== current.storeIncarnation || current.storeIncarnation !== identity.storeIncarnation) {
    const error = new Error('stale or superseded lease epoch');
    error.code = 'stale-lease';
    throw error;
  }
  if (opts.crashPoint === 'before-commit') {
    const error = new Error('injected crash before inbox commit');
    error.code = 'injected-crash';
    throw error;
  }
  const existing = readReceipt(kernelRoot, intent.commandId);
  const candidate = {
    schemaVersion: 1,
    kind: 'KernelReceiptV1',
    commandId: intent.commandId,
    attemptId: intent.attemptId,
    taskInstanceId: intent.taskInstanceId,
    leaseEpoch: lease.epoch,
    storeIncarnation: lease.storeIncarnation,
    payloadDigest: intent.payloadDigest,
    targetDigest: issued.provenance.targetDigest,
    snapshotDigest: issued.provenance.registrySnapshotDigest,
    status: 'accepted',
    receivedAtUtc: new Date().toISOString(),
  };
  if (existing) {
    if (existing.payloadDigest !== candidate.payloadDigest || existing.targetDigest !== candidate.targetDigest || existing.snapshotDigest !== candidate.snapshotDigest || existing.attemptId !== candidate.attemptId) {
      const error = new Error('conflicting command payload under existing commandId');
      error.code = 'command-conflict';
      throw error;
    }
    return { receipt: existing, created: false };
  }
  if (opts.crashPoint === 'during-commit') {
    const orphan = receiptPath(kernelRoot, intent.commandId) + '.' + crypto.randomUUID() + '.tmp';
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, JSON.stringify(candidate, null, 2));
    const error = new Error('injected crash during inbox commit');
    error.code = 'injected-crash';
    throw error;
  }
  atomicWriteJson(receiptPath(kernelRoot, intent.commandId), candidate);
  if (opts.crashPoint === 'after-commit-before-ack') {
    const error = new Error('injected crash after inbox commit (ACK lost)');
    error.code = 'injected-crash';
    throw error;
  }
  return { receipt: candidate, created: true };
}

function countReceipts(kernelRoot) {
  const dir = path.join(kernelRoot, 'inbox');
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length;
}

module.exports = {
  acquireGeneration,
  currentLease,
  deliverCommand,
  readReceipt,
  countReceipts,
  ensureIdentity,
  loadIdentity,
};
