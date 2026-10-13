'use strict';
// SPIKE-02 throwaway prototype — NOT production code.
// Prototype trust boundary (F-01, F-02, G-fixes).
//
// F-01 — sealed issuance (prototype, NOT production IPC authentication):
//   The Kernel accepts a resolution ONLY if its exact bytes were sealed by the
//   trusted bridge through sealIssuance() and the seal verifies. The seal is
//   HMAC-SHA256 over the canonical issued object with a per-kernelRoot random
//   256-bit issuance key (0600 file, created once). An attacker holding the
//   correct issuer string and self-recomputed matching digests still has no
//   sealed record, so deliverCommand rejects them with 'forged-issuer'.
//   PROTOTYPE ASSUMPTION (explicitly NOT a production claim): the attacker
//   cannot write to <kernelRoot>/trusted-issuances/ and cannot read
//   <kernelRoot>/issuance-key.json. Any same-UID process with that access
//   breaks this boundary. Production A1 needs real IPC peer authentication
//   (service identity / SCM_CREDENTIALS-class peer proof), NOT a file-shared
//   key and NOT an issuer string. No same-UID isolation is claimed.
// F-02/G — rollback witness (prototype, separate failure domain):
//   The witness is a per-generation record kept OUTSIDE the restored database:
//   { maxEpoch, storeIncarnation, accepted: { commandId: { commandDigest, leaseEpoch } } }.
//   - maxEpoch detects cross-epoch rollback (stale lease reuse).
//   - accepted[] detects same-lease receipt loss (Finding 1): a replayed command
//     whose acceptance the restored DB lost fails closed with
//     'reconciliation-required' instead of being silently re-accepted.
//   - Witness records are written AFTER the kernel receipt is durable. Crash
//     order is receipt-then-witness, so a crash between them leaves a receipt
//     without a witness entry; the next identical replay is idempotent AND
//     heals the witness. The unsafe order (witness-first) is never used.
//   - A missing witness for a witness-protected generation, or a corrupted
//     witness file, fails closed with 'reconciliation-required' — never skip.
//   - Omitting witnessRoot for a protected generation is a downgrade attempt
//     and fails closed with 'witness-required' (enforced kernel-side via the
//     witnessProtected marker on the lease entry).
//   - Recovery is explicit only: fenceForRecovery() with operator attestation
//     fences the epoch above every known max and starts a fresh baseline; old
//     leases stay dead. Without a witnessRoot the rollback check is SKIPPED
//     (documented as unsupported — see EVIDENCE.md residual risks).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const envelope = require('./envelope.cjs');
const flock = require('./file-lock.cjs');

function keyPath(kernelRoot) { return path.join(kernelRoot, 'issuance-key.json'); }
function issuancesDir(kernelRoot) { return path.join(kernelRoot, 'trusted-issuances'); }
function issuancePath(kernelRoot, issuanceId) { return path.join(issuancesDir(kernelRoot), issuanceId + '.json'); }

function initIssuanceKey(kernelRoot) {
  const target = keyPath(kernelRoot);
  const existing = flock.readJsonIfExists(target);
  if (existing && typeof existing.secret === 'string') return existing;
  const candidate = { schemaVersion: 1, secret: crypto.randomBytes(32).toString('hex') };
  const result = flock.exclusivePublishJson(target, candidate);
  if (result.created) {
    try { fs.chmodSync(target, 0o600); } catch { /* best-effort on Windows */ }
    return candidate;
  }
  return flock.readJsonIfExists(target);
}

function hmacSeal(secretHex, issued) {
  return crypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(envelope.canonicalize(issued), 'utf8').digest('hex');
}

// Finding 2: issuance identity is the hash of the COMPLETE immutable issuance
// content (task binding included), NOT the model-target digest. Two tasks may
// share one model target (same targetDigest) yet hold distinct issuances.
// targetDigest remains the identity of the model target only.
function sealContentOf(issued) {
  const provenance = (issued && issued.provenance) || {};
  return {
    issuer: issued && issued.issuer,
    taskInstanceId: issued && issued.taskInstanceId,
    role: issued && issued.role,
    target: issued && issued.target,
    provenance: {
      issuer: provenance.issuer,
      resolutionIdCompat: provenance.resolutionIdCompat,
      registrySnapshotDigest: provenance.registrySnapshotDigest,
      targetDigest: provenance.targetDigest,
      modeConfigRevision: provenance.modeConfigRevision,
    },
  };
}

function issuanceIdentityOf(sealContent) {
  return envelope.sha256Hex(envelope.canonicalize(sealContent));
}

// Seal an issued resolution into the Kernel's trusted-issuance store.
// Idempotent for the identical issuance; a mismatched issuanceId fails closed.
function sealIssuance(kernelRoot, issued) {
  if (!issued || !issued.provenance || typeof issued.provenance.targetDigest !== 'string') {
    const error = new Error('sealable issuance with targetDigest is required');
    error.code = 'delivery-invalid';
    throw error;
  }
  if (typeof issued.provenance.issuanceId !== 'string' || issued.provenance.issuanceId === '') {
    const error = new Error('sealable issuance requires a bridge-assigned issuanceId');
    error.code = 'delivery-invalid';
    throw error;
  }
  if (issuanceIdentityOf(sealContentOf(issued)) !== issued.provenance.issuanceId) {
    const error = new Error('issuanceId does not match issuance content');
    error.code = 'delivery-invalid';
    throw error;
  }
  const key = initIssuanceKey(kernelRoot);
  const seal = hmacSeal(key.secret, issued);
  const record = { schemaVersion: 1, issuanceId: issued.provenance.issuanceId, issued, seal };
  const target = issuancePath(kernelRoot, record.issuanceId);
  const result = flock.exclusivePublishJson(target, record);
  if (result.created) return record;
  const existing = flock.readJsonIfExists(target);
  if (existing && existing.seal === seal && envelope.canonicalize(existing.issued) === envelope.canonicalize(issued)) {
    return existing;
  }
  const error = new Error('conflicting sealed issuance under the same issuance identity');
  error.code = 'issuance-conflict';
  throw error;
}

function verifySealed(kernelRoot, issued) {
  try {
    if (!issued || !issued.provenance || typeof issued.provenance.issuanceId !== 'string') return false;
    const record = flock.readJsonIfExists(issuancePath(kernelRoot, issued.provenance.issuanceId));
    if (!record || !record.seal) return false;
    if (envelope.canonicalize(record.issued) !== envelope.canonicalize(issued)) return false;
    if (issuanceIdentityOf(sealContentOf(issued)) !== issued.provenance.issuanceId) return false;
    const key = flock.readJsonIfExists(keyPath(kernelRoot));
    if (!key || typeof key.secret !== 'string') return false;
    const expected = hmacSeal(key.secret, issued);
    if (expected.length !== record.seal.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(record.seal, 'hex'));
  } catch {
    return false;
  }
}

// ── Rollback witness ────────────────────────────────────────────────
function sanitizeKey(key) {
  return String(key).replace(/[^A-Za-z0-9_.=-]/g, '_').slice(0, 200);
}

function witnessPath(witnessRoot, generationKey) {
  return path.join(witnessRoot, sanitizeKey(generationKey) + '.witness.json');
}

function reconcileFail(message) {
  const error = new Error(message);
  error.code = 'reconciliation-required';
  throw error;
}

// Fail-closed witness read: missing → null (caller decides init vs loss);
// present-but-unparseable → reconciliation-required, NEVER a raw SyntaxError
// and NEVER a silent skip.
function readWitness(witnessRoot, generationKey) {
  if (!witnessRoot) return null;
  const target = witnessPath(witnessRoot, generationKey);
  if (!fs.existsSync(target)) return null;
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    reconcileFail('witness record is corrupted; rollback protection cannot be verified');
  }
  if (!doc || typeof doc !== 'object' || typeof doc.maxEpoch !== 'number') {
    reconcileFail('witness record is malformed; rollback protection cannot be verified');
  }
  return doc;
}

// Monotonic-max advance preserving accepted-command progress and baseline
// history. Uses its own witness lock so concurrent advancers cannot lose an
// update. A corrupted existing record fails closed (never overwritten blindly).
function noteEpoch(witnessRoot, generationKey, epoch, storeIncarnation, acceptedEntry) {
  if (!witnessRoot) return null;
  return flock.withLock(witnessRoot, 'witness-' + sanitizeKey(generationKey), () => {
    const target = witnessPath(witnessRoot, generationKey);
    const existing = readWitness(witnessRoot, generationKey);
    const accepted = { ...((existing && existing.accepted) || {}) };
    if (acceptedEntry && typeof acceptedEntry.commandId === 'string') {
      accepted[acceptedEntry.commandId] = { commandDigest: acceptedEntry.commandDigest, leaseEpoch: acceptedEntry.leaseEpoch };
    }
    const doc = {
      schemaVersion: 1,
      generationKey,
      maxEpoch: Math.max((existing && existing.maxEpoch) || 0, epoch),
      storeIncarnation: (existing && existing.storeIncarnation) || storeIncarnation,
      accepted,
      ...(existing && existing.baseline ? { baseline: existing.baseline } : {}),
      updatedAtUtc: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmpDoc = target + '.tmp';
    fs.writeFileSync(tmpDoc, JSON.stringify(doc, null, 2));
    fs.renameSync(tmpDoc, target);
    return doc;
  });
}

// Explicit recovery baseline (operator-authorized): overwrites a missing or
// corrupted witness with a fresh baseline recording the fencing event. Safe
// ONLY together with the epoch fence in fenceForRecovery (kernel-inbox-mock):
// old leases can never deliver again, so forgotten acceptances cannot recur.
function writeRecoveryBaseline(witnessRoot, generationKey, baseline) {
  return flock.withLock(witnessRoot, 'witness-' + sanitizeKey(generationKey), () => {
    const target = witnessPath(witnessRoot, generationKey);
    const doc = {
      schemaVersion: 1,
      generationKey,
      maxEpoch: baseline.maxEpoch,
      storeIncarnation: baseline.storeIncarnation,
      accepted: {},
      baseline: {
        recoveredAtUtc: new Date().toISOString(),
        attestedMaxEpoch: baseline.attestedMaxEpoch,
        operatorAttestation: baseline.operatorAttestation,
      },
      updatedAtUtc: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmpDoc = target + '.tmp';
    fs.writeFileSync(tmpDoc, JSON.stringify(doc, null, 2));
    fs.renameSync(tmpDoc, target);
    return doc;
  });
}

module.exports = {
  initIssuanceKey,
  sealContentOf,
  issuanceIdentityOf,
  sealIssuance,
  verifySealed,
  issuancePath,
  readWitness,
  noteEpoch,
  writeRecoveryBaseline,
  witnessPath,
};
