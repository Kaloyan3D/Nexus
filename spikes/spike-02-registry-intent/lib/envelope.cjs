'use strict';
// SPIKE-02 throwaway prototype — NOT production code.
// Immutable command-envelope digests (F-05).
//
// Canonicalization: sorted-key JSON (JCS-like, via the real Registry
// resolver's canonicalize). Documented here because every digest comparison
// depends on it: the same logical envelope MUST always hash identically,
// and any added field changes the digest (fail-closed on mismatch).
//
// Envelope layering (mutable transport state is NEVER part of identity):
//   payloadDigest : sha256(canonical(intentPayload))
//   intentDigest  : sha256(canonical({taskInstanceId, attemptId, commandId,
//                   backend, controllerRevision, role, modeId,
//                   modeConfigRevision, payloadDigest}))
//                   — lease and issuedAtUtc are EXCLUDED (attached/assigned later).
//   commandDigest : sha256(canonical({intentDigest, targetDigest,
//                   snapshotDigest, leaseEpoch, storeIncarnation}))
//                   — binds one controller generation+attempt to one sealed
//                   Registry target under one fencing lease.
const crypto = require('node:crypto');
const resolver = require('../../../config/registry/resolver.cjs');

function canonicalize(value) {
  return resolver.canonicalize(value);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function payloadDigestOf(intentPayload) {
  return sha256Hex(canonicalize(intentPayload === undefined ? null : intentPayload));
}

function intentDigestOf(fields) {
  return sha256Hex(canonicalize({
    taskInstanceId: fields.taskInstanceId,
    attemptId: fields.attemptId,
    commandId: fields.commandId,
    backend: fields.backend,
    controllerRevision: fields.controllerRevision || 0,
    role: fields.role,
    modeId: fields.modeId,
    modeConfigRevision: fields.modeConfigRevision === undefined ? null : fields.modeConfigRevision,
    payloadDigest: fields.payloadDigest,
  }));
}

function commandDigestOf(parts) {
  return sha256Hex(canonicalize({
    intentDigest: parts.intentDigest,
    targetDigest: parts.targetDigest,
    snapshotDigest: parts.snapshotDigest,
    leaseEpoch: parts.leaseEpoch,
    storeIncarnation: parts.storeIncarnation,
  }));
}

module.exports = { canonicalize, sha256Hex, payloadDigestOf, intentDigestOf, commandDigestOf };
