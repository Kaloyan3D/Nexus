'use strict';
// SPIKE-02 throwaway prototype — NOT production code.
// Prototype trust boundary (F-01, F-02).
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
//
// F-02 — rollback witness (prototype, separate failure domain):
//   Lease counters live inside the Kernel DB, so a full-DB restore also
//   restores the counter and a same-disk counter CANNOT detect rollback on its
//   own. The witness is a minimal monotonic-max record kept OUTSIDE the
//   restored database (separate witnessRoot = separate failure domain in
//   tests; production needs an independent store or hardware monotonic
//   counter). Every acquire and every accepted delivery advances the witness;
//   delivery rejects with 'rollback-detected' when the witness max epoch for
//   a generation exceeds the presented lease epoch or the incarnation differs.
//   Without a witnessRoot the rollback check is SKIPPED (documented as
//   unsupported — see EVIDENCE.md residual risks).
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

// Seal an issued resolution into the Kernel's trusted-issuance store.
// Idempotent for the identical issuance; conflicting content under the same
// issuanceId (targetDigest) fails closed.
function sealIssuance(kernelRoot, issued) {
  if (!issued || !issued.provenance || typeof issued.provenance.targetDigest !== 'string') {
    const error = new Error('sealable issuance with targetDigest is required');
    error.code = 'delivery-invalid';
    throw error;
  }
  const key = initIssuanceKey(kernelRoot);
  const seal = hmacSeal(key.secret, issued);
  const record = { schemaVersion: 1, issuanceId: issued.provenance.targetDigest, issued, seal };
  const target = issuancePath(kernelRoot, record.issuanceId);
  const result = flock.exclusivePublishJson(target, record);
  if (result.created) return record;
  const existing = flock.readJsonIfExists(target);
  if (existing && existing.seal === seal && envelope.canonicalize(existing.issued) === envelope.canonicalize(issued)) {
    return existing;
  }
  const error = new Error('conflicting sealed issuance under the same target digest');
  error.code = 'command-conflict';
  throw error;
}

function verifySealed(kernelRoot, issued) {
  try {
    if (!issued || !issued.provenance || typeof issued.provenance.targetDigest !== 'string') return false;
    const record = flock.readJsonIfExists(issuancePath(kernelRoot, issued.provenance.targetDigest));
    if (!record || !record.seal) return false;
    if (envelope.canonicalize(record.issued) !== envelope.canonicalize(issued)) return false;
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

function readWitness(witnessRoot, generationKey) {
  if (!witnessRoot) return null;
  return flock.readJsonIfExists(witnessPath(witnessRoot, generationKey));
}

// Monotonic-max advance. Must be called holding no conflicting lock; uses its
// own witness lock so concurrent advancers cannot lose an update.
function noteEpoch(witnessRoot, generationKey, epoch, storeIncarnation) {
  if (!witnessRoot) return null;
  return flock.withLock(witnessRoot, 'witness-' + sanitizeKey(generationKey), () => {
    const target = witnessPath(witnessRoot, generationKey);
    const existing = flock.readJsonIfExists(target);
    const maxEpoch = Math.max((existing && existing.maxEpoch) || 0, epoch);
    const doc = {
      schemaVersion: 1,
      generationKey,
      maxEpoch,
      storeIncarnation: (existing && existing.storeIncarnation) || storeIncarnation,
      updatedAtUtc: new Date().toISOString(),
    };
    // Witness rewrite is monotonic: last-writer-wins is safe because content
    // is max() of all observed epochs. Recompute under lock to avoid lost max.
    const fresh = flock.readJsonIfExists(target);
    doc.maxEpoch = Math.max((fresh && fresh.maxEpoch) || 0, epoch);
    doc.storeIncarnation = (fresh && fresh.storeIncarnation) || storeIncarnation;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmpDoc = target + '.tmp';
    fs.writeFileSync(tmpDoc, JSON.stringify(doc, null, 2));
    fs.renameSync(tmpDoc, target);
    return doc;
  });
}

module.exports = {
  initIssuanceKey,
  sealIssuance,
  verifySealed,
  issuancePath,
  readWitness,
  noteEpoch,
  witnessPath,
};
