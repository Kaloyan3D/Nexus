'use strict';
// SPIKE-02 throwaway prototype — NOT production code.
// Trusted Registry-issuer bridge. The ONLY model-routing authority is the real
// Nexus JS Registry resolver (config/registry/resolver.cjs). The Controller
// submits task/role intent; it MUST NOT supply an executable target object.
// The bridge resolves from an issuer-controlled snapshot and returns a
// complete candidate target plus provenance. No fallback, no substitution,
// no invented authority fields: every target field is copied from the real
// resolver binding; digests are computed locally and kept separate from the
// legacy resolutionId (compatibility identifier only).

const crypto = require('node:crypto');
const resolver = require('../../../config/registry/resolver.cjs');
const trust = require('./trust.cjs');

function canonicalize(value) {
  return resolver.canonicalize(value);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function snapshotDigestOf(snapshot) {
  return sha256Hex(canonicalize(snapshot));
}

function targetDigestOf(binding) {
  return sha256Hex(canonicalize(binding));
}

// intent: { taskInstanceId, role, modeId } — role intent only, no target.
// modeConfig: a ModeConfiguration for modeId (issuer-validated).
// snapshot: issuer-controlled Registry snapshot (frozen by caller).
// options.kernelRoot (optional): when provided, the bridge seals the issuance
//   into that Kernel's trusted-issuance store and returns { ok, issued,
//   issuanceId }. The Kernel ONLY honors sealed issuances (see trust.cjs).
//   Without kernelRoot the issuance is UNSEALED (test-negative-path use only).
// Returns { ok: true, issued[, issuanceId] } or { ok: false, errors } where
// errors carry the real resolver codes; callers map !ok to 'target-incomplete'.
function issueForIntent(intent, modeConfig, snapshot, options) {
  if (!intent || typeof intent.role !== 'string' || intent.role === '') {
    return { ok: false, errors: [{ code: 'intent-invalid', path: 'intent.role', message: 'role intent is required' }] };
  }
  if (!intent.taskInstanceId || typeof intent.taskInstanceId !== 'string') {
    return { ok: false, errors: [{ code: 'intent-invalid', path: 'intent.taskInstanceId', message: 'taskInstanceId is required' }] };
  }
  if (!snapshot || snapshot.schemaVersion !== 1) {
    return { ok: false, errors: [{ code: 'snapshot-invalid', path: 'snapshot', message: 'issuer snapshot is required' }] };
  }
  const frozen = resolver.deepFreeze(JSON.parse(JSON.stringify(snapshot)));
  const result = resolver.compileModeConfig(modeConfig, frozen, (options && options.resolverOptions) || {});
  if (!result.ok) return { ok: false, errors: result.errors };
  const binding = result.snapshot.roles[intent.role];
  if (!binding) {
    return { ok: false, errors: [{ code: 'target-incomplete', path: 'roles.' + intent.role, message: 'role ' + intent.role + ' has no binding in mode ' + modeConfig.modeId }] };
  }
  // Copy ONLY real resolver binding fields — never invent endpoint/billing/session fields.
  const {
    schemaVersion, resolutionId, modeId, orchestrationEngineId, modeConfigRevision,
    roleId, logicalModelId, routeId, providerId, remoteModelId, connectionId,
    executionKind, accessType, protocolId, reasoning,
    requiredCapabilities, slotRequirements, dataUseTier,
  } = binding;
  const target = {
    schemaVersion, resolutionId, modeId, orchestrationEngineId, modeConfigRevision,
    roleId, logicalModelId, routeId, providerId, remoteModelId, connectionId,
    executionKind, accessType, protocolId, reasoning,
    requiredCapabilities, slotRequirements, dataUseTier,
  };
  const registrySnapshotDigest = snapshotDigestOf(frozen);
  const targetDigest = targetDigestOf(target);
  const issued = {
    issuer: 'registry-bridge',
    taskInstanceId: intent.taskInstanceId,
    role: intent.role,
    target,
    provenance: {
      issuer: 'registry-bridge',
      resolutionIdCompat: resolutionId,
      registrySnapshotDigest,
      targetDigest,
      modeConfigRevision,
    },
  };
  const sealed = resolver.deepFreeze(issued);
  if (options && options.kernelRoot) {
    const record = trust.sealIssuance(options.kernelRoot, JSON.parse(JSON.stringify(sealed)));
    return { ok: true, issued: sealed, issuanceId: record.issuanceId };
  }
  return { ok: true, issued: sealed };
}

module.exports = {
  issueForIntent,
  snapshotDigestOf,
  targetDigestOf,
};
