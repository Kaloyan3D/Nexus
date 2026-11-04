'use strict';
// SPIKE-02 throwaway prototype — NOT production code.
// Mocked Kernel inbox with durable, idempotent command receipts and
// Kernel-owned generation fencing (lease epochs).
//
// Hardening (F-01/F-02/F-03/F-04/F-05):
// - F-01: deliverCommand honors ONLY bridge-sealed issuances (trust.cjs).
//   Issuer strings and caller-supplied digests grant nothing by themselves.
// - F-04: the full intent→resolution→receipt relationship is validated
//   (taskInstanceId, attemptId binding, commandId, modeId, modeConfigRevision,
//   role, backend, target identity + sealed provenance, current lease).
// - F-05: payload digests are RECOMPUTED from actual payloads; commandId reuse
//   with any differing immutable authorization field fails closed via the
//   canonical commandDigest (see lib/envelope.cjs). Timestamps stay mutable.
// - F-03: lease acquisition and delivery are mutex-serialized; receipt
//   creation is O_EXCL winner-takes-all with re-read-and-classify losers.
// - F-02: with options.witnessRoot, delivery rejects rolled-back leases with
//   'rollback-detected' and acquisition fences above the witness max.
//   Without a witness, rollback detection is UNSUPPORTED (documented).
//
// - Kernel owns a persistent store incarnation id (created once per kernelRoot).
// - AcquireGeneration(taskInstanceId, backend) monotonically advances the lease
//   epoch for that generation and persists it atomically.
// - Restore of a stale kernel DB without a witness fails OPEN to the old
//   counter by construction — that is why the witness exists. Never claim
//   stale-backup protection from a counter restored together with its DB.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const envelope = require('./envelope.cjs');
const flock = require('./file-lock.cjs');
const trust = require('./trust.cjs');

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
function generationKey(taskInstanceId, backend) { return taskInstanceId + '|' + backend; }

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
// Serialized with a mutex; with witnessRoot the next epoch is fenced above
// the witness max so a restored DB can never re-issue a fenced epoch.
function acquireGeneration(kernelRoot, { taskInstanceId, backend }, options) {
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
  const witnessRoot = options && options.witnessRoot;
  return flock.withLock(kernelRoot, 'kernel-leases', () => {
    const identity = ensureIdentity(kernelRoot);
    const leases = loadLeases(kernelRoot);
    const key = generationKey(taskInstanceId, backend);
    const entry = leases[key];
    // Finding 3: a witness-protected generation stays protected. Omitting the
    // witness is a downgrade attempt; a lost witness needs explicit recovery.
    if (entry && entry.witnessProtected && !witnessRoot) {
      fail('witness-required', 'generation is witness-protected; witnessRoot must not be omitted');
    }
    let witness = null;
    if (witnessRoot) {
      // Fail-closed on corrupt witness; null only when never initialized.
      witness = trust.readWitness(witnessRoot, key);
      if (!witness && entry && entry.witnessProtected) {
        fail('reconciliation-required', 'witness record lost after protection was established');
      }
    }
    let nextEpoch = ((entry && entry.epoch) || 0) + 1;
    if (witness && typeof witness.maxEpoch === 'number' && witness.maxEpoch >= nextEpoch) {
      nextEpoch = witness.maxEpoch + 1;
    }
    leases[key] = {
      epoch: nextEpoch,
      storeIncarnation: identity.storeIncarnation,
      acquiredAtUtc: new Date().toISOString(),
      ...(witnessRoot ? { witnessProtected: true } : {}),
    };
    atomicWriteJson(leasesPath(kernelRoot), { schemaVersion: 1, leases });
    if (witnessRoot) trust.noteEpoch(witnessRoot, key, nextEpoch, identity.storeIncarnation);
    return { leaseEpoch: nextEpoch, storeIncarnation: identity.storeIncarnation };
  });
}

function currentLease(kernelRoot, taskInstanceId, backend) {
  const leases = loadLeases(kernelRoot);
  return leases[generationKey(taskInstanceId, backend)] || null;
}

function readReceipt(kernelRoot, commandId) {
  const p = receiptPath(kernelRoot, commandId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

// crashPoint (test-only): 'before-commit' | 'during-commit' |
//   'after-receipt-before-witness' | 'after-commit-before-ack'
// witnessRoot (optional): enables rollback detection (F-02/G).
function deliverCommand(kernelRoot, { intent, issued }, options) {
  const opts = options || {};
  if (!intent || !issued) fail('delivery-invalid', 'intent and issued resolution are required');
  return flock.withLock(kernelRoot, 'kernel-inbox', () => {
    // Finding 3: omitting the witness for a protected generation is a downgrade.
    if (!opts.witnessRoot && intent && intent.taskInstanceId && intent.backend) {
      const entry = (loadLeases(kernelRoot) || {})[generationKey(intent.taskInstanceId, intent.backend)];
      if (entry && entry.witnessProtected) {
        fail('witness-required', 'generation is witness-protected; witnessRoot must not be omitted');
      }
    }
    // F-01: only sealed issuances are honored. String/provenance/digests alone grant nothing.
    if (!trust.verifySealed(kernelRoot, issued)) fail('forged-issuer', 'no verified sealed issuance for this target');
    const target = issued.target || {};
    const provenance = issued.provenance || {};
    // F-05: recompute digests from actual content; never trust caller-supplied digests.
    const recomputedPayloadDigest = envelope.payloadDigestOf(intent.intentPayload);
    if (recomputedPayloadDigest !== intent.payloadDigest) fail('payload-tamper', 'intent payload does not match its digest');
    if (envelope.sha256Hex(envelope.canonicalize(target)) !== provenance.targetDigest) {
      fail('forged-issuer', 'sealed target does not match its provenance digest');
    }
    const recomputedIntentDigest = envelope.intentDigestOf({ ...intent, payloadDigest: recomputedPayloadDigest });
    // F-04: full intent→resolution binding (checked before record-integrity
    // so mismatched identities report as binding mismatches, not tamper).
    if (intent.backend !== 'native') fail('backend-mismatch', 'backend mismatch');
    if (issued.taskInstanceId !== intent.taskInstanceId) fail('generation-mismatch', 'generation mismatch between intent and issued target');
    if (issued.role !== intent.role) fail('binding-mismatch', 'role mismatch between intent and issued target');
    if (target.modeId !== intent.modeId) fail('binding-mismatch', 'mode mismatch between intent and issued target');
    if (target.modeConfigRevision !== intent.modeConfigRevision || provenance.modeConfigRevision !== intent.modeConfigRevision) {
      fail('binding-mismatch', 'mode revision mismatch between intent and issued target');
    }
    if (typeof intent.attemptId !== 'string' || intent.attemptId === '') fail('delivery-invalid', 'attempt binding is required');
    if (typeof intent.commandId !== 'string' || intent.commandId === '') fail('delivery-invalid', 'command binding is required');
    // Controller record integrity: the presented intent must match its own digest.
    if (intent.intentDigest && recomputedIntentDigest !== intent.intentDigest) {
      fail('payload-tamper', 'intent identity does not match its digest');
    }
    // Lease check: Kernel-owned epoch must be current and incarnation must match.
    const lease = intent.lease;
    const current = currentLease(kernelRoot, intent.taskInstanceId, intent.backend);
    const identity = ensureIdentity(kernelRoot);
    if (!lease || typeof lease.epoch !== 'number') fail('stale-lease', 'missing lease authorization');
    if (!current || lease.epoch !== current.epoch || lease.storeIncarnation !== current.storeIncarnation || current.storeIncarnation !== identity.storeIncarnation) {
      fail('stale-lease', 'stale or superseded lease epoch');
    }
    // F-02/G: rollback witness (separate failure domain). Fail-closed on corrupt
    // witness; a lost witness for a protected generation needs explicit recovery.
    let witness = null;
    if (opts.witnessRoot) {
      witness = trust.readWitness(opts.witnessRoot, generationKey(intent.taskInstanceId, intent.backend));
      if (!witness) {
        const entry = (loadLeases(kernelRoot) || {})[generationKey(intent.taskInstanceId, intent.backend)];
        if (entry && entry.witnessProtected) {
          fail('reconciliation-required', 'witness record lost after protection was established');
        }
      } else {
        if (typeof witness.maxEpoch === 'number' && witness.maxEpoch > lease.epoch) {
          fail('rollback-detected', 'witness max epoch exceeds presented lease: kernel DB was restored');
        }
        if (witness.storeIncarnation && witness.storeIncarnation !== lease.storeIncarnation) {
          fail('rollback-detected', 'witness incarnation differs: kernel DB was restored');
        }
      }
    }
    if (opts.crashPoint === 'before-commit') fail('injected-crash', 'injected crash before inbox commit');
    const commandDigest = envelope.commandDigestOf({
      intentDigest: recomputedIntentDigest,
      targetDigest: provenance.targetDigest,
      snapshotDigest: provenance.registrySnapshotDigest,
      leaseEpoch: lease.epoch,
      storeIncarnation: lease.storeIncarnation,
    });
    const candidate = {
      schemaVersion: 1,
      kind: 'KernelReceiptV1',
      commandId: intent.commandId,
      attemptId: intent.attemptId,
      taskInstanceId: intent.taskInstanceId,
      leaseEpoch: lease.epoch,
      storeIncarnation: lease.storeIncarnation,
      payloadDigest: recomputedPayloadDigest,
      intentDigest: recomputedIntentDigest,
      commandDigest,
      targetDigest: provenance.targetDigest,
      snapshotDigest: provenance.registrySnapshotDigest,
      status: 'accepted',
      receivedAtUtc: new Date().toISOString(),
    };
    const existing = readReceipt(kernelRoot, intent.commandId);
    if (existing) {
      // F-05: commandId reuse with ANY differing immutable authorization field fails closed.
      if (existing.commandDigest === commandDigest && existing.attemptId === candidate.attemptId) {
        // Idempotent replay also heals witness progress (receipt-then-witness crash order).
        if (opts.witnessRoot) {
          trust.noteEpoch(opts.witnessRoot, generationKey(intent.taskInstanceId, intent.backend), lease.epoch, lease.storeIncarnation, {
            commandId: intent.commandId, commandDigest, leaseEpoch: lease.epoch,
          });
        }
        return { receipt: existing, created: false };
      }
      fail('command-conflict', 'conflicting command payload under existing commandId');
    }
    // Finding 1: the witness remembers acceptances the restored DB lost. A replay
    // of a previously accepted command is NEVER silently re-accepted — reconcile.
    if (witness && witness.accepted && witness.accepted[intent.commandId]) {
      const prior = witness.accepted[intent.commandId];
      if (prior && prior.commandDigest === commandDigest) {
        fail('reconciliation-required', 'command was previously accepted and its receipt was lost; reconcile instead of re-accepting');
      }
      fail('command-conflict', 'commandId was previously accepted with different content');
    }
    if (opts.crashPoint === 'during-commit') {
      const orphan = receiptPath(kernelRoot, intent.commandId) + '.' + crypto.randomUUID() + '.tmp';
      fs.mkdirSync(path.dirname(orphan), { recursive: true });
      fs.writeFileSync(orphan, JSON.stringify(candidate, null, 2));
      fail('injected-crash', 'injected crash during inbox commit');
    }
    // F-03: O_EXCL winner-takes-all; a loser re-reads and classifies.
    const created = flock.exclusivePublishJson(receiptPath(kernelRoot, intent.commandId), candidate);
    if (!created.created) {
      const raced = readReceipt(kernelRoot, intent.commandId);
      if (raced && raced.commandDigest === commandDigest && raced.attemptId === candidate.attemptId) {
        return { receipt: raced, created: false };
      }
      fail('command-conflict', 'conflicting command payload under existing commandId');
    }
    // Finding 1 crash window (test hook): receipt durable, witness not yet noted.
    if (opts.crashPoint === 'after-receipt-before-witness') fail('injected-crash', 'injected crash after receipt publish before witness note');
    // Receipt-then-witness order: a crash between them heals on idempotent replay.
    if (opts.witnessRoot) {
      trust.noteEpoch(opts.witnessRoot, generationKey(intent.taskInstanceId, intent.backend), lease.epoch, lease.storeIncarnation, {
        commandId: intent.commandId, commandDigest, leaseEpoch: lease.epoch,
      });
    }
    if (opts.crashPoint === 'after-commit-before-ack') fail('injected-crash', 'injected crash after inbox commit (ACK lost)');
    return { receipt: readReceipt(kernelRoot, intent.commandId), created: true };
  });
}

// Finding 3 explicit recovery: fence the generation above every known max and
// start a fresh witness baseline recording the operator attestation. Old leases
// can never deliver again, so forgotten acceptances cannot recur. The caller
// MUST supply attestedMaxEpoch (highest epoch the operator believes was issued)
// plus a non-empty operatorAttestation; both are recorded for audit. Safe
// because the epoch only moves forward past all previously valid leases.
function fenceForRecovery(kernelRoot, witnessRoot, { taskInstanceId, backend, attestedMaxEpoch, operatorAttestation }) {
  if (!witnessRoot) fail('recovery-invalid', 'fenced recovery requires a witnessRoot');
  if (!taskInstanceId || typeof taskInstanceId !== 'string') fail('recovery-invalid', 'taskInstanceId is required');
  if (backend !== 'native') fail('recovery-invalid', 'only backend=native participates in this spike');
  if (!Number.isInteger(attestedMaxEpoch) || attestedMaxEpoch < 0) fail('recovery-invalid', 'attestedMaxEpoch must be a non-negative integer');
  if (typeof operatorAttestation !== 'string' || operatorAttestation === '') fail('recovery-invalid', 'operatorAttestation is required');
  return flock.withLock(kernelRoot, 'kernel-leases', () => {
    const identity = ensureIdentity(kernelRoot);
    const leases = loadLeases(kernelRoot);
    const key = generationKey(taskInstanceId, backend);
    const entry = leases[key];
    let witnessMax = -1;
    try {
      const witness = trust.readWitness(witnessRoot, key);
      if (witness && typeof witness.maxEpoch === 'number') witnessMax = witness.maxEpoch;
    } catch (error) {
      if (!error || error.code !== 'reconciliation-required') throw error;
      // Missing/corrupt witness is exactly why recovery was invoked; proceed
      // with kernel state + operator attestation as the fencing basis.
    }
    const nextEpoch = Math.max((entry && entry.epoch) || 0, witnessMax, attestedMaxEpoch) + 1;
    leases[key] = { epoch: nextEpoch, storeIncarnation: identity.storeIncarnation, acquiredAtUtc: new Date().toISOString(), witnessProtected: true };
    atomicWriteJson(leasesPath(kernelRoot), { schemaVersion: 1, leases });
    trust.writeRecoveryBaseline(witnessRoot, key, {
      maxEpoch: nextEpoch,
      storeIncarnation: identity.storeIncarnation,
      attestedMaxEpoch,
      operatorAttestation,
    });
    return { leaseEpoch: nextEpoch, storeIncarnation: identity.storeIncarnation };
  });
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
  fenceForRecovery,
  readReceipt,
  countReceipts,
  ensureIdentity,
  loadIdentity,
};
