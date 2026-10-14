'use strict';

/**
 * A2.3 durable Controller execution-intent bundle builder (pure).
 *
 * Binds, for one Controller attempt, everything the kernel dispatch gate
 * revalidates: generation/lease identity, role, sealed Registry digests
 * (V1 issuance plus V2 extension), the exact prepared request identity,
 * the Controller session, and the mock-e2e execution scope. Emits canonical
 * bundle bytes for the authenticated daemon intent-publish channel; the
 * kernel seals and persists them and trusts only its sealed store row.
 *
 * A caller-supplied object is never authority by itself: without the
 * daemon-issued seal and a live lease it authorizes nothing.
 */

const INTENT_BUNDLE_VERSION = 1;
const SCOPE_MOCK_E2E = 'mock-e2e';

function fail(code, message) {
  return { ok: false, code: code, message: message, bundle: null };
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v !== '';
}

function isHex64(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/**
 * Build the canonical intent bundle.
 *
 * options: {
 *   shadowIntent (resolveShadowIntent intent: taskInstanceId, attemptId,
 *     commandId), lease: { epoch, storeIncarnation }, role,
 *   issuance: native-issuer issuance (resolution + provenance digests),
 *   extensionDigest (sha256 hex of the V2 extension),
 *   requestDigest (sha256 hex of the exact prepared request bytes),
 *   sessionId (raw Controller attempt session, non-empty),
 *   scope (must be 'mock-e2e' in A2.3)
 * }
 */
function buildDispatchIntent(options) {
  const o = options || {};
  const shadow = o.shadowIntent || null;
  const lease = o.lease || null;
  const issuance = o.issuance || null;
  if (!shadow || typeof shadow !== 'object') return fail('intent-invalid', 'a resolved Controller shadow intent is required');
  if (!issuance || typeof issuance !== 'object' || !issuance.resolution || !issuance.resolution.provenance) {
    return fail('intent-invalid', 'a sealed Registry issuance is required');
  }
  const commandId = isNonEmptyString(shadow.commandId) ? shadow.commandId : '';
  const taskInstanceId = isNonEmptyString(shadow.taskInstanceId) ? shadow.taskInstanceId : '';
  const attemptId = isNonEmptyString(shadow.attemptId) ? shadow.attemptId : '';
  if (commandId === '' || taskInstanceId === '' || attemptId === '') {
    return fail('intent-invalid', 'shadow intent lacks task/attempt/command binding');
  }
  const epoch = lease && Number.isInteger(lease.epoch) && lease.epoch > 0 ? lease.epoch : 0;
  const incarnation = lease && isNonEmptyString(lease.storeIncarnation) ? lease.storeIncarnation : '';
  if (epoch === 0 || incarnation === '') return fail('intent-invalid', 'a current generation lease (epoch + incarnation) is required');
  const role = isNonEmptyString(o.role) ? o.role : '';
  if (role === '') return fail('intent-invalid', 'an authorized role is required');
  const prov = issuance.resolution.provenance;
  for (const k of ['targetDigest', 'registrySnapshotDigest', 'issuanceId']) {
    if (!isHex64(prov[k])) return fail('intent-invalid', 'issuance provenance lacks ' + k);
  }
  const extensionDigest = isHex64(o.extensionDigest) ? o.extensionDigest : '';
  const requestDigest = isHex64(o.requestDigest) ? o.requestDigest : '';
  if (extensionDigest === '') return fail('intent-invalid', 'a V2 extension digest is required');
  if (requestDigest === '') return fail('intent-invalid', 'a prepared request digest is required');
  const sessionId = isNonEmptyString(o.sessionId) ? o.sessionId : '';
  if (sessionId === '') return fail('intent-invalid', 'a Controller attempt session is required');
  if (o.scope !== SCOPE_MOCK_E2E) return fail('intent-scope-refused', 'only the mock-e2e scope is issuable in A2.3');
  if (issuance.taskInstanceId !== taskInstanceId) {
    return fail('intent-generation-mismatch', 'issuance task generation differs from the intent generation');
  }
  const bundle = {
    schemaVersion: INTENT_BUNDLE_VERSION,
    commandId: commandId,
    taskInstanceId: taskInstanceId,
    attemptId: attemptId,
    leaseEpoch: epoch,
    storeIncarnation: incarnation,
    role: role,
    targetDigest: prov.targetDigest,
    snapshotDigest: prov.registrySnapshotDigest,
    issuanceId: prov.issuanceId,
    extensionDigest: extensionDigest,
    requestDigest: requestDigest,
    sessionId: sessionId,
    scope: SCOPE_MOCK_E2E,
  };
  return { ok: true, code: null, message: null, bundle: bundle };
}

module.exports = {
  INTENT_BUNDLE_VERSION: INTENT_BUNDLE_VERSION,
  SCOPE_MOCK_E2E: SCOPE_MOCK_E2E,
  buildDispatchIntent: buildDispatchIntent,
};
