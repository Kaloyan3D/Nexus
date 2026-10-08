'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const checkpointV2 = require('./ContextCheckpointV2.cjs');
const CERT_SCHEMA_VERSION = 1;
const CERT_STATUS_CERTIFIED = 'CERTIFIED';
const CERT_STATUS_REVOKED = 'REVOKED';
const CERT_FILE_NAME = 'opencode-muse-certification.json';
const CERT_MAX_BYTES = 8192;
const CERT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STRING_BOUNDS = Object.freeze({ provider: 128, baseUrl: 256, model: 256, fingerprint: 256, revision: 256, digest: 128 });
const CERT_EXACT_KEYS = Object.freeze(['schemaVersion', 'authorityKind', 'inferenceProvider', 'inferenceBaseUrl', 'inferenceModel', 'counterProvider', 'counterBaseUrl', 'counterModel', 'counterFingerprint', 'contextWindow', 'safetyMarginPolicyRevision', 'outputReservePolicyRevision', 'requestShapeRevision', 'canarySuiteRevision', 'canaryEvidenceDigest', 'certifiedAtUtc', 'expiresAtUtc', 'status', 'revokedAtUtc', 'revokeReason']);
function failCert(code, detail) {
  throw new Error('authority-certification-' + code + (detail === undefined ? '' : ': ' + detail) + ' (DISCARDABLE)');
}
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function boundedString(value, bound) {
  return typeof value === 'string' && value !== '' && value.length <= bound;
}
function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}
function nowMs(clock) {
  if (clock !== undefined && clock !== null) {
    if (typeof clock.now === 'function') {
      const value = clock.now();
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    failCert('clock-invalid', 'clock must expose now()');
  }
  return Date.now();
}
function certFilePathV2(storeRoot) {
  if (typeof storeRoot !== 'string' || storeRoot === '') failCert('store-invalid', 'store root is required');
  return path.join(path.resolve(String(storeRoot)), CERT_FILE_NAME);
}
function validateCertificationV2(raw) {
  const invalid = (reason) => ({ valid: false, reason });
  try {
    if (!isPlainObject(raw)) return invalid('malformed');
    for (const key of Object.keys(raw)) {
      if (CERT_EXACT_KEYS.indexOf(key) === -1) return invalid('malformed');
    }
    for (const key of CERT_EXACT_KEYS) {
      if (raw[key] === undefined) return invalid('malformed');
    }
    if (raw.schemaVersion !== CERT_SCHEMA_VERSION) return invalid('malformed');
    if (raw.authorityKind !== 'REMOTE_MUSE_PRECOUNT') return invalid('malformed');
    for (const field of ['inferenceProvider', 'counterProvider']) {
      if (!boundedString(raw[field], STRING_BOUNDS.provider)) return invalid('malformed');
    }
    for (const field of ['inferenceBaseUrl', 'counterBaseUrl']) {
      if (!boundedString(raw[field], STRING_BOUNDS.baseUrl)) return invalid('malformed');
    }
    if (!boundedString(raw.inferenceModel, STRING_BOUNDS.model)) return invalid('malformed');
    if (!boundedString(raw.counterModel, STRING_BOUNDS.model)) return invalid('malformed');
    if (!boundedString(raw.counterFingerprint, STRING_BOUNDS.fingerprint)) return invalid('malformed');
    if (!Number.isInteger(raw.contextWindow) || raw.contextWindow <= 0) return invalid('malformed');
    for (const field of ['safetyMarginPolicyRevision', 'outputReservePolicyRevision', 'requestShapeRevision', 'canarySuiteRevision']) {
      if (!boundedString(raw[field], STRING_BOUNDS.revision)) return invalid('malformed');
    }
    if (typeof raw.canaryEvidenceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.canaryEvidenceDigest)) return invalid('malformed');
    if (typeof raw.certifiedAtUtc !== 'string' || Number.isNaN(Date.parse(raw.certifiedAtUtc))) return invalid('malformed');
    if (typeof raw.expiresAtUtc !== 'string' || Number.isNaN(Date.parse(raw.expiresAtUtc))) return invalid('malformed');
    if (raw.status !== CERT_STATUS_CERTIFIED && raw.status !== CERT_STATUS_REVOKED) return invalid('malformed');
    if (raw.status === CERT_STATUS_REVOKED) {
      if (typeof raw.revokedAtUtc !== 'string' || Number.isNaN(Date.parse(raw.revokedAtUtc))) return invalid('malformed');
      if (typeof raw.revokeReason !== 'string' || raw.revokeReason === '') return invalid('malformed');
    } else {
      if (raw.revokedAtUtc !== null || raw.revokeReason !== null) return invalid('malformed');
    }
    return { valid: true, reason: null };
  } catch (error) {
    void error;
    return invalid('malformed');
  }
}
function readCertificationFileV2(storeRoot) {
  const target = certFilePathV2(storeRoot);
  let rawText = null;
  try {
    rawText = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { present: false };
    throw error;
  }
  if (Buffer.byteLength(rawText, 'utf8') > CERT_MAX_BYTES) failCert('certification-oversize', 'certification exceeds bounds');
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    void error;
    return { present: true, certification: null, state: 'malformed' };
  }
  const check = validateCertificationV2(parsed);
  if (!check.valid) return { present: true, certification: null, state: 'malformed' };
  return { present: true, certification: Object.freeze(parsed), state: null };
}
function writeCertificationFileV2(storeRoot, certification) {
  const check = validateCertificationV2(certification);
  if (!check.valid) failCert('certification-invalid', 'refusing to persist an invalid record');
  const dir = path.resolve(String(storeRoot));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, CERT_FILE_NAME);
  const serialized = canonicalJsonOf(certification);
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(tmp, Buffer.from(serialized, 'utf8'));
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (ignored) { void ignored; }
    failCert('certification-persist-failed', 'atomic rename failed');
  }
  const reread = readCertificationFileV2(storeRoot);
  if (reread.present !== true || reread.certification === null
    || canonicalJsonOf(reread.certification) !== serialized) {
    failCert('certification-persist-failed', 'read-back mismatch after atomic write');
  }
  return reread.certification;
}
function buildCertificationV2(input, clock) {
  if (!isPlainObject(input)) failCert('certification-input-invalid', 'input must be an object');
  const required = ['authorityKind', 'inferenceProvider', 'inferenceBaseUrl', 'inferenceModel', 'counterProvider', 'counterBaseUrl', 'counterModel', 'counterFingerprint', 'contextWindow', 'safetyMarginPolicyRevision', 'outputReservePolicyRevision', 'requestShapeRevision', 'canarySuiteRevision', 'canaryEvidenceDigest'];
  for (const key of required) {
    if (input[key] === undefined) failCert('certification-input-invalid', 'missing ' + key);
  }
  const at = nowMs(clock);
  const built = {
    schemaVersion: CERT_SCHEMA_VERSION,
    authorityKind: input.authorityKind,
    inferenceProvider: input.inferenceProvider,
    inferenceBaseUrl: input.inferenceBaseUrl,
    inferenceModel: input.inferenceModel,
    counterProvider: input.counterProvider,
    counterBaseUrl: input.counterBaseUrl,
    counterModel: input.counterModel,
    counterFingerprint: input.counterFingerprint,
    contextWindow: input.contextWindow,
    safetyMarginPolicyRevision: input.safetyMarginPolicyRevision,
    outputReservePolicyRevision: input.outputReservePolicyRevision,
    requestShapeRevision: input.requestShapeRevision,
    canarySuiteRevision: input.canarySuiteRevision,
    canaryEvidenceDigest: input.canaryEvidenceDigest,
    certifiedAtUtc: new Date(at).toISOString(),
    expiresAtUtc: new Date(at + CERT_TTL_MS).toISOString(),
    status: CERT_STATUS_CERTIFIED,
    revokedAtUtc: null,
    revokeReason: null,
  };
  const check = validateCertificationV2(built);
  if (!check.valid) failCert('certification-input-invalid', check.reason);
  return Object.freeze(built);
}
function escapeRegExpV2(text) {
  return String(text).replace(/[^A-Za-z0-9]/g, (ch) => ('^$.|?*+()[]{}').indexOf(ch) === -1 && ch !== '\\' ? ch : '\\' + ch);
}
function readProviderBaseUrlV2(settingsText, providerId) {
  try {
    if (typeof settingsText !== 'string' || typeof providerId !== 'string' || providerId === '') return null;
    const pattern = new RegExp('^ {4}' + escapeRegExpV2(providerId) + ':\\n((?: {6}[^\\n]*\\n)*?) {6}baseURL:\\s*(\\S+)', 'm');
    const match = pattern.exec(settingsText);
    if (match === null) return null;
    const url = match[match.length - 1];
    if (url.length > STRING_BOUNDS.baseUrl) return null;
    return url;
  } catch (error) {
    void error;
    return null;
  }
}
function readModelWindowV2(registryDocument, provider, model) {
  try {
    if (!isPlainObject(registryDocument) || !Array.isArray(registryDocument.models)) return null;
    for (const entry of registryDocument.models) {
      if (!isPlainObject(entry)) continue;
      if (model !== entry.model && model !== entry.id) continue;
      let compatible = entry.provider === provider;
      if (isPlainObject(entry.providers)) {
        for (const key of Object.keys(entry.providers)) {
          if (entry.providers[key] === provider) compatible = true;
        }
      }
      if (compatible !== true) continue;
      if (Number.isInteger(entry.contextWindow) && entry.contextWindow > 0) return entry.contextWindow;
      return null;
    }
    return null;
  } catch (error) {
    void error;
    return null;
  }
}
function currentIdentityV2(input) {
  if (!isPlainObject(input)) failCert('identity-input-invalid', 'input must be an object');
  const settingsText = input.settingsText;
  const registryDocument = input.registryDocument;
  const inferenceBaseUrl = readProviderBaseUrlV2(settingsText, input.inferenceProvider);
  const counterBaseUrl = readProviderBaseUrlV2(settingsText, input.counterProvider);
  const contextWindow = readModelWindowV2(registryDocument, input.inferenceProvider, input.inferenceModel);
  if (typeof inferenceBaseUrl !== 'string' || typeof counterBaseUrl !== 'string' || !Number.isInteger(contextWindow)) {
    return { known: false, identity: null };
  }
  return {
    known: true,
    identity: Object.freeze({
      inferenceProvider: input.inferenceProvider,
      inferenceBaseUrl,
      inferenceModel: input.inferenceModel,
      counterProvider: input.counterProvider,
      counterBaseUrl,
      counterModel: input.counterModel,
      counterFingerprint: input.counterFingerprint,
      contextWindow,
      safetyMarginPolicyRevision: input.safetyMarginPolicyRevision,
      outputReservePolicyRevision: input.outputReservePolicyRevision,
      requestShapeRevision: input.requestShapeRevision,
      canarySuiteRevision: input.canarySuiteRevision,
    }),
  };
}
function certifyOpencodeV2(storeRoot, identityFields, canaryEvidenceDigest, clock) {
  if (!isPlainObject(identityFields)) failCert('certification-input-invalid', 'identity fields required');
  if (typeof canaryEvidenceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(canaryEvidenceDigest)) {
    failCert('certification-input-invalid', 'canary evidence digest required');
  }
  const built = buildCertificationV2({
    authorityKind: 'REMOTE_MUSE_PRECOUNT',
    inferenceProvider: identityFields.inferenceProvider,
    inferenceBaseUrl: identityFields.inferenceBaseUrl,
    inferenceModel: identityFields.inferenceModel,
    counterProvider: identityFields.counterProvider,
    counterBaseUrl: identityFields.counterBaseUrl,
    counterModel: identityFields.counterModel,
    counterFingerprint: identityFields.counterFingerprint,
    contextWindow: identityFields.contextWindow,
    safetyMarginPolicyRevision: identityFields.safetyMarginPolicyRevision,
    outputReservePolicyRevision: identityFields.outputReservePolicyRevision,
    requestShapeRevision: identityFields.requestShapeRevision,
    canarySuiteRevision: identityFields.canarySuiteRevision,
    canaryEvidenceDigest,
  }, clock);
  return writeCertificationFileV2(storeRoot, built);
}
function revokeCertificationV2(storeRoot, reason, clock) {
  const found = readCertificationFileV2(storeRoot);
  if (found.present !== true || found.certification === null) {
    return { revoked: false, state: 'missing' };
  }
  const at = nowMs(clock);
  const revoked = {};
  for (const key of CERT_EXACT_KEYS) revoked[key] = found.certification[key];
  revoked.status = CERT_STATUS_REVOKED;
  revoked.revokedAtUtc = new Date(at).toISOString();
  revoked.revokeReason = typeof reason === 'string' && reason !== '' ? reason.slice(0, 128) : 'unspecified';
  const check = validateCertificationV2(revoked);
  if (!check.valid) failCert('certification-invalid', 'revocation record invalid');
  writeCertificationFileV2(storeRoot, revoked);
  return { revoked: true, state: 'revoked' };
}
function identityMatchesV2(certification, expected) {
  if (!isPlainObject(expected)) return false;
  const fields = ['inferenceProvider', 'inferenceBaseUrl', 'inferenceModel', 'counterProvider', 'counterBaseUrl', 'counterModel', 'counterFingerprint', 'contextWindow', 'safetyMarginPolicyRevision', 'outputReservePolicyRevision', 'requestShapeRevision', 'canarySuiteRevision'];
  for (const field of fields) {
    if (canonicalJsonOf(certification[field]) !== canonicalJsonOf(expected[field])) return false;
  }
  return true;
}
function loadCertificationV2(input) {
  const idle = (state) => Object.freeze({ state, certification: null, health: 'QUARANTINED' });
  try {
    if (!isPlainObject(input) || typeof input.storeRoot !== 'string') return idle('missing');
    const found = readCertificationFileV2(input.storeRoot);
    if (found.present !== true) return idle('missing');
    if (found.certification === null) return idle('malformed');
    const certification = found.certification;
    if (certification.status === CERT_STATUS_REVOKED) {
      return Object.freeze({ state: 'revoked', certification, health: 'QUARANTINED' });
    }
    if (isPlainObject(input.expectedIdentity) && identityMatchesV2(certification, input.expectedIdentity) !== true) {
      return Object.freeze({ state: 'identity-mismatch', certification, health: 'QUARANTINED' });
    }
    let now = null;
    try {
      now = nowMs(input.clock === undefined ? null : input.clock);
    } catch (error) {
      void error;
      return idle('malformed');
    }
    if (Date.parse(certification.expiresAtUtc) <= now) {
      return Object.freeze({ state: 'expired', certification, health: 'QUARANTINED' });
    }
    return Object.freeze({ state: 'valid', certification, health: 'HEALTHY' });
  } catch (error) {
    void error;
    return idle('malformed');
  }
}
module.exports = {
  CERT_SCHEMA_VERSION,
  CERT_STATUS_CERTIFIED,
  CERT_STATUS_REVOKED,
  CERT_FILE_NAME,
  CERT_MAX_BYTES,
  CERT_TTL_MS,
  CERT_EXACT_KEYS,
  certFilePathV2,
  validateCertificationV2,
  readCertificationFileV2,
  writeCertificationFileV2,
  buildCertificationV2,
  certifyOpencodeV2,
  revokeCertificationV2,
  identityMatchesV2,
  currentIdentityV2,
  readProviderBaseUrlV2,
  readModelWindowV2,
  loadCertificationV2,
};
