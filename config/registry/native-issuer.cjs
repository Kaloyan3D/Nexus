'use strict';

/**
 * A1.2 trusted Registry issuer — real Registry bridge using the existing
 * JavaScript Registry only.
 *
 * Supported scope in A1.2: mode 'engineering-v2', role 'muse_main'.
 * Every other mode/role returns { ok:false, code:'registry-unsupported-scope' }
 * explicitly — never silently mapped to Muse.
 *
 * Real-source pipeline (no hand-built model targets):
 *   registryService.createService({ installRoot, dataRoot })
 *     -> getModeConfiguration('engineering-v2')
 *     -> compilePreview(config)                      (real resolver)
 *     -> select ONLY the authorized role binding
 *     -> carry the complete real target identity
 *     -> snapshotDigest  = sha256(canonical(resolvedSnapshot))
 *     -> targetDigest    = sha256(canonical(roleTarget))
 *     -> modeConfigDigest = sha256(canonical(effectiveModeConfig))
 *     -> issuanceId      = sha256(canonical(sealContent))  — matches the
 *        Rust RegistryResolutionV1::issuance_id_of byte-for-byte, so the
 *        kernel can verify sealed provenance issued for THIS task generation.
 *
 * The legacy resolutionId is compatibility metadata only: source identity is
 * (snapshotDigest, targetDigest, modeConfigDigest, issuanceId). A numeric
 * mode revision alone cannot prove the definition and assignments are
 * unchanged, so the effective mode-configuration digest travels in the
 * shadow intent payload and the issuance binds the full snapshot bytes.
 *
 * The Controller can never select an arbitrary executable target: the target
 * is compiled from trusted Nexus configuration, and only the authorized
 * role binding for the pinned mode is ever issued.
 */

const crypto = require('node:crypto');
const resolver = require('./resolver.cjs');
const serviceModule = require('./service.cjs');

const ISSUER_SCHEMA_VERSION = 1;
const ISSUER_ID = 'nexus-registry-bridge/1';
const SUPPORTED_MODE_ID = 'engineering-v2';
const SUPPORTED_ROLE = 'muse_main';

/**
 * EM-04C2 S4: the CLOSED, reviewed table of the Engineering Modes the Native issuance path may
 * issue, with the orchestration engine each one MUST declare. Adding a mode here is a code
 * change that is reviewed like any other; nothing (no selection, no configuration, no model) can
 * add an entry. `engineering-v2` is the default and keeps its engine `muse-v0`. The adaptive mode
 * maps to `muse-v1` and additionally requires an operator-SAVED ModeConfiguration: no preview,
 * no adoption from a legacy profile, nothing is created on the operator's behalf.
 */
const NATIVE_SCOPES = Object.freeze({
  'engineering-v2': Object.freeze({
    engineId: 'muse-v0',
    // The deterministic EXPERIMENTAL engines of the Rust runtime (compiled only into `test-engines`
    // builds; a production runtime answers `engine-unavailable` for each). Fixture install roots
    // name them in the default mode to drive them end to end, exactly as before this table existed.
    // The adaptive production engine `muse-v1` is NOT among them: it can never be issued here.
    experimentalEngineIds: Object.freeze(['effort-test-v0', 'muse-v1-shadow', 'muse-v1-signals']),
    role: SUPPORTED_ROLE,
    requiresSavedConfiguration: false,
  }),
  'engineering-v2-adaptive': Object.freeze({
    engineId: 'muse-v1',
    experimentalEngineIds: Object.freeze([]),
    role: SUPPORTED_ROLE,
    requiresSavedConfiguration: true,
  }),
});

/** Whether `engineId` is an engine the reviewed table allows for the scope. */
function engineAllowed(scope, engineId) {
  return !!scope && typeof engineId === 'string' && (engineId === scope.engineId || scope.experimentalEngineIds.indexOf(engineId) !== -1);
}

/** The scope of a mode id, or null. Own properties only: `__proto__`, `constructor` etc. are not modes. */
function scopeOf(modeId) {
  if (typeof modeId !== 'string' || !Object.prototype.hasOwnProperty.call(NATIVE_SCOPES, modeId)) return null;
  return NATIVE_SCOPES[modeId];
}
const EXPECTED_EXECUTION_KIND = 'raw-model';

function canonicalSha256(value) {
  return crypto.createHash('sha256').update(resolver.canonicalize(value), 'utf8').digest('hex');
}

function fail(code, message) {
  return { ok: false, code: code, message: message, issuance: null };
}

/**
 * Resolve the effective mode configuration and compile it through the real
 * Registry. Returns the compiled snapshot plus the effective config.
 * deps: { service? } — an existing registry service may be injected
 * (tests); otherwise one is created from installRoot/dataRoot.
 */
function compileTrustedMode(options, deps) {
  const o = options || {};
  const installRoot = typeof o.installRoot === 'string' ? o.installRoot : '';
  const dataRoot = typeof o.dataRoot === 'string' ? o.dataRoot : '';
  const modeId = typeof o.modeId === 'string' ? o.modeId : SUPPORTED_MODE_ID;
  const scope = scopeOf(modeId);
  if (!scope) {
    return { ok: false, code: 'registry-unsupported-scope', message: 'the Native issuance path does not issue mode ' + String(modeId).slice(0, 64) + '; it is explicitly unsupported/skipped', issuance: null };
  }
  const role = typeof o.role === 'string' ? o.role : scope.role;
  if (role !== scope.role) {
    return { ok: false, code: 'registry-unsupported-scope', message: 'mode ' + modeId + ' issues only role ' + scope.role + '; ' + String(role).slice(0, 64) + ' is explicitly unsupported/skipped', issuance: null };
  }
  if (installRoot === '' || dataRoot === '') return fail('registry-host-missing', 'installRoot and dataRoot are required');
  const d = deps || {};
  let service = d.service || null;
  try {
    if (!service) service = serviceModule.createService({ installRoot: installRoot, dataRoot: dataRoot });
  } catch (e) {
    return fail('registry-unavailable', 'registry service could not be created: ' + String((e && e.message) || e));
  }
  let staged = null;
  try {
    staged = service.getModeConfiguration(modeId, {});
  } catch (e) {
    return fail('registry-unavailable', 'effective mode configuration is unreadable: ' + String((e && e.message) || e));
  }
  if (scope.requiresSavedConfiguration && (!staged || !staged.result || staged.result.persisted !== true)) {
    return fail('registry-mode-configuration-required', 'mode ' + modeId + ' runs only from a ModeConfiguration the operator has saved; none is created or adopted for it');
  }
  if (!staged || !staged.result || !staged.result.config) {
    const codes = ((staged && staged.errors) || []).map(function (e) { return e && e.code; }).join(',');
    return fail('registry-unresolved', 'effective mode configuration for ' + modeId + ' is unresolved (' + codes + '); refusing to manufacture a target');
  }
  const modeConfig = staged.result.config;
  let compiled = null;
  try {
    compiled = service.compilePreview(modeConfig);
  } catch (e) {
    return fail('registry-unavailable', 'registry compilation failed: ' + String((e && e.message) || e));
  }
  if (!compiled || compiled.ok !== true || !compiled.snapshot) {
    const codes = ((compiled && compiled.errors) || []).map(function (e) { return e && e.code; }).join(',');
    return fail('registry-unresolved', 'mode configuration does not compile (' + codes + '); refusing to issue');
  }
  const snapshot = compiled.snapshot;
  // the shipped definition must declare exactly the engine the reviewed table maps this mode to
  if (!engineAllowed(scope, snapshot.orchestrationEngineId)) {
    return { ok: false, code: 'registry-unsupported-scope', message: 'mode ' + modeId + ' declares orchestration engine ' + String(snapshot.orchestrationEngineId).slice(0, 64) + ', not the reviewed ' + scope.engineId + ' (or a listed experimental engine); refusing to issue', issuance: null };
  }
  const binding = snapshot.roles && snapshot.roles[role];
  if (!binding || typeof binding !== 'object') {
    return fail('registry-role-unauthorized', 'role ' + role + ' has no compiled binding in mode ' + modeId + '; refusing to issue');
  }
  return { ok: true, code: null, message: null, issuance: null, snapshot: snapshot, binding: binding, modeConfig: modeConfig, persisted: staged.result.persisted === true, configRevision: staged.result.revision != null ? staged.result.revision : modeConfig.revision };
}

const REQUIRED_TARGET_FIELDS = ['modeId', 'roleId', 'logicalModelId', 'routeId', 'providerId', 'remoteModelId', 'connectionId', 'executionKind'];

/**
 * Build the sealed issuance for an exact Controller task generation.
 * compiled: result of compileTrustedMode. taskInstanceId: authoritative
 * generation identity (never a display label).
 */
function issueForGeneration(compiled, taskInstanceId) {
  if (!compiled || compiled.ok !== true) return fail('registry-unresolved', 'no trusted compilation to issue from');
  if (typeof taskInstanceId !== 'string' || taskInstanceId === '') return fail('registry-binding-invalid', 'a task generation identity is required to bind the issuance');
  const binding = compiled.binding;
  for (const field of REQUIRED_TARGET_FIELDS) {
    if (typeof binding[field] !== 'string' || binding[field].trim() === '') {
      return fail('registry-target-incomplete', 'compiled binding is missing mandatory target field ' + field + '; refusing to issue');
    }
  }
  if (typeof binding.orchestrationEngineId !== 'string' || binding.orchestrationEngineId.trim() === '') {
    return fail('registry-target-incomplete', 'compiled binding is missing orchestrationEngineId; refusing to issue');
  }
  if (binding.executionKind !== EXPECTED_EXECUTION_KIND) {
    return fail('registry-target-unauthorized', 'compiled binding executionKind ' + binding.executionKind + ' is not the authorized raw-model target; refusing to issue');
  }
  const scope = scopeOf(binding.modeId);
  if (!scope || binding.roleId !== scope.role || !engineAllowed(scope, binding.orchestrationEngineId)) {
    return fail('registry-role-unauthorized', 'compiled binding is not an authorized (mode, engine, role) of the reviewed Native scope table; refusing to issue');
  }
  // Complete real target identity — field-for-field the Rust
  // ExecutionTargetCoreV1 (camelCase). No invented endpoint, billing,
  // session or credential metadata exists here by construction.
  const target = {
    schemaVersion: 1,
    resolutionId: binding.resolutionId,
    modeId: binding.modeId,
    orchestrationEngineId: binding.orchestrationEngineId,
    modeConfigRevision: binding.modeConfigRevision,
    roleId: binding.roleId,
    logicalModelId: binding.logicalModelId,
    routeId: binding.routeId,
    providerId: binding.providerId,
    remoteModelId: binding.remoteModelId,
    connectionId: binding.connectionId,
    executionKind: binding.executionKind,
    accessType: binding.accessType,
    protocolId: binding.protocolId,
    reasoning: binding.reasoning,
    // EM-02: the operator-authorized reasoning levels of this slot (route-checked by the
    // resolver), sealed with the target. Emitted only when configured, so every target without a
    // policy is byte-for-byte unchanged.
    ...(Array.isArray(binding.allowedReasoning) ? { allowedReasoning: binding.allowedReasoning.slice() } : {}),
    // EM-04C1: the mode's serialized-request budget, sealed with the target. Emitted only when
    // the mode declares one, so every target without a budget is byte-for-byte unchanged.
    ...(Number.isInteger(binding.requestBudgetBytes) ? { requestBudgetBytes: binding.requestBudgetBytes } : {}),
    requiredCapabilities: binding.requiredCapabilities,
    slotRequirements: binding.slotRequirements,
    dataUseTier: binding.dataUseTier != null ? binding.dataUseTier : null,
  };
  const snapshot = compiled.snapshot;
  const modeConfig = compiled.modeConfig;
  const snapshotDigest = canonicalSha256(snapshot);
  const targetDigest = canonicalSha256(target);
  const modeConfigDigest = canonicalSha256(modeConfig);
  // Seal content MUST match Rust RegistryResolutionV1::seal_content exactly:
  // { issuer, taskInstanceId, role, target, provenance: { issuer,
  //   resolutionIdCompat, registrySnapshotDigest, targetDigest,
  //   modeConfigRevision } }. issuanceId is its canonical digest, so two
  // tasks with the same model obtain DISTINCT issuances (taskInstanceId is
  // part of the sealed bytes) while re-issuance for the same generation is
  // content-stable.
  const provenanceWithoutId = {
    issuer: ISSUER_ID,
    resolutionIdCompat: binding.resolutionId,
    registrySnapshotDigest: snapshotDigest,
    targetDigest: targetDigest,
    modeConfigRevision: binding.modeConfigRevision,
  };
  const sealContent = {
    issuer: ISSUER_ID,
    taskInstanceId: taskInstanceId,
    role: SUPPORTED_ROLE,
    target: target,
    provenance: provenanceWithoutId,
  };
  const issuanceId = canonicalSha256(sealContent);
  const resolution = {
    schemaVersion: 1,
    issuer: ISSUER_ID,
    taskInstanceId: taskInstanceId,
    role: SUPPORTED_ROLE,
    target: target,
    provenance: {
      issuer: ISSUER_ID,
      resolutionIdCompat: binding.resolutionId,
      registrySnapshotDigest: snapshotDigest,
      targetDigest: targetDigest,
      modeConfigRevision: binding.modeConfigRevision,
      issuanceId: issuanceId,
    },
  };
  // Self-verify before returning: the issuance identity must be derivable
  // from the sealed bytes we will hand to Rust.
  const verify = canonicalSha256({
    issuer: resolution.issuer,
    taskInstanceId: resolution.taskInstanceId,
    role: resolution.role,
    target: resolution.target,
    provenance: {
      issuer: resolution.provenance.issuer,
      resolutionIdCompat: resolution.provenance.resolutionIdCompat,
      registrySnapshotDigest: resolution.provenance.registrySnapshotDigest,
      targetDigest: resolution.provenance.targetDigest,
      modeConfigRevision: resolution.provenance.modeConfigRevision,
    },
  });
  if (verify !== issuanceId) return fail('registry-issuance-corrupt', 'issuance identity failed self-verification; refusing to issue');
  return {
    ok: true,
    code: null,
    message: null,
    issuance: {
      schemaVersion: ISSUER_SCHEMA_VERSION,
      issuer: ISSUER_ID,
      modeId: binding.modeId,
      role: SUPPORTED_ROLE,
      taskInstanceId: taskInstanceId,
      target: target,
      resolution: resolution,
      snapshot: snapshot,
      modeConfig: modeConfig,
      snapshotDigest: snapshotDigest,
      targetDigest: targetDigest,
      modeConfigDigest: modeConfigDigest,
      issuanceId: issuanceId,
      resolutionIdCompat: binding.resolutionId,
      modeConfigRevision: binding.modeConfigRevision,
      persisted: compiled.persisted === true,
    },
  };
}

/**
 * One-step trusted issuance: compile the real Registry and bind it to the
 * exact Controller task generation.
 */
function issueTrustedResolution(options, deps) {
  const o = options || {};
  const compiled = compileTrustedMode(o, deps);
  if (!compiled.ok) return { ok: false, code: compiled.code, message: compiled.message, issuance: null };
  return issueForGeneration(compiled, o.taskInstanceId);
}

module.exports = {
  ISSUER_SCHEMA_VERSION: ISSUER_SCHEMA_VERSION,
  ISSUER_ID: ISSUER_ID,
  SUPPORTED_MODE_ID: SUPPORTED_MODE_ID,
  NATIVE_SCOPES: NATIVE_SCOPES,
  scopeOf: scopeOf,
  engineAllowed: engineAllowed,
  SUPPORTED_ROLE: SUPPORTED_ROLE,
  canonicalSha256: canonicalSha256,
  compileTrustedMode: compileTrustedMode,
  issueForGeneration: issueForGeneration,
  issueTrustedResolution: issueTrustedResolution,
};
