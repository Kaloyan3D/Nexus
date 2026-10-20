'use strict';

/**
 * EM-02 Registry authority for per-attempt reasoning.
 *
 * buildTaskBinding  — once per task generation, from the task's own V2 issuance and the bound
 *                     route's declared reasoning levels: the immutable task binding (everything
 *                     of the issued target/extension except the effort, plus the default effort
 *                     and the supported levels). Byte-compatible with Rust TaskBindingV1.
 * authorizeAttemptTarget — for one model attempt: a Registry issuance identical to the task's
 *                     except for target.reasoning / extension.reasoningEffort, authorized ONLY
 *                     against the sealed binding (never against the live Registry configuration,
 *                     so a configuration change mid-run cannot redirect the task). The requested
 *                     effort must be one of the binding's supported levels; it is never
 *                     escalated, downgraded or defaulted.
 *
 * The projection removes exactly target.reasoning and extension.reasoningEffort, and every digest
 * is sha256(canonical(value)), like the Rust nexus_contracts::task_binding module.
 */

const issuer = require('./native-issuer.cjs');

const TASK_BINDING_SCHEMA_VERSION = 1;
const MAX_REASONING_LEVELS = 16;
const LEVEL = /^[\x21-\x7E]{1,32}$/;

function fail(code, message) {
  return { ok: false, code: code, message: message };
}

function without(obj, key) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (k !== key) out[k] = obj[k];
  }
  return out;
}

function projectTarget(target) { return without(target, 'reasoning'); }
function projectExtension(extension) { return without(extension, 'reasoningEffort'); }

function bindingDigest(binding) { return issuer.canonicalSha256(binding); }

function sealContentOf(resolution) {
  return {
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
  };
}

/** A resolution is self-consistent when its digests derive from its own content. */
function selfConsistent(resolution) {
  if (!resolution || typeof resolution !== 'object' || !resolution.target || !resolution.provenance) return false;
  if (issuer.canonicalSha256(resolution.target) !== resolution.provenance.targetDigest) return false;
  return issuer.canonicalSha256(sealContentOf(resolution)) === resolution.provenance.issuanceId;
}

function validLevels(levels) {
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > MAX_REASONING_LEVELS) return null;
  const out = [];
  for (const l of levels) {
    if (typeof l !== 'string' || !LEVEL.test(l)) return null;
    if (out.indexOf(l) === -1) out.push(l);
  }
  return out.sort();
}

/**
 * The levels a sealed target authorizes: the slot's operator policy carried IN the target
 * (`allowedReasoning`, set by the resolver only when the operator configured one), else the
 * target's own effort alone. The route's declared capability never authorizes a level by itself.
 * Identical to Rust `nexus_contracts::task_binding::authorized_levels`.
 */
function authorizedLevels(target) {
  if (target && target.allowedReasoning !== undefined) return validLevels(target.allowedReasoning);
  return target && typeof target.reasoning === 'string' && LEVEL.test(target.reasoning) ? [target.reasoning] : null;
}

/**
 * The task binding for a freshly issued task target (native-target-v2 output) and the route
 * record it was compiled from.
 */
function buildTaskBinding(target, route) {
  if (!target || !target.issuance || !target.issuance.resolution || !target.extension) {
    return fail('registry-target-incomplete', 'no issued task target to bind');
  }
  const resolution = target.issuance.resolution;
  if (!selfConsistent(resolution)) return fail('registry-issuance-corrupt', 'task issuance is not self-consistent; refusing to bind');
  if (!route || route.id !== resolution.target.routeId) return fail('registry-target-incomplete', 'the bound route record is unavailable; refusing to bind');
  const levels = authorizedLevels(resolution.target);
  if (!levels) return fail('registry-target-incomplete', 'the issued target carries no valid reasoning policy; refusing to bind');
  const def = resolution.target.reasoning;
  if (levels.indexOf(def) === -1) return fail('reasoning-level-not-supported', 'the default effort is outside the slot policy; never downshifted');
  // defense in depth: the resolver already required every authorized level to be route-declared
  const declared = Array.isArray(route.reasoningLevels) ? route.reasoningLevels : [];
  if (levels.some(function (l) { return declared.indexOf(l) === -1; })) return fail('reasoning-level-not-supported', 'the slot policy names a level route ' + route.id + ' does not declare; refusing to bind');
  if (target.extension.reasoningEffort !== def) return fail('registry-target-unauthorized', 'extension effort drifts from the task issuance');
  const binding = {
    schemaVersion: TASK_BINDING_SCHEMA_VERSION,
    taskInstanceId: resolution.taskInstanceId,
    role: resolution.role,
    issuer: resolution.issuer,
    registrySnapshotDigest: resolution.provenance.registrySnapshotDigest,
    modeConfigRevision: resolution.provenance.modeConfigRevision,
    target: projectTarget(resolution.target),
    extension: projectExtension(target.extension),
    defaultReasoning: def,
    supportedReasoning: levels,
  };
  return { ok: true, binding: binding, bindingDigest: bindingDigest(binding) };
}

/**
 * Authorize the target of ONE model attempt under a sealed task binding.
 *
 * input: { taskBinding, taskBindingDigest, resolution, extension, requestedEffort }
 *   resolution/extension: the task's own issuance (carries the default effort).
 * Returns the attempt's resolution/extension/digests; for the default effort it returns the
 * task's own issuance unchanged (content-addressed: same ids).
 */
function authorizeAttemptTarget(input) {
  const i = input || {};
  const b = i.taskBinding;
  if (!b || typeof b !== 'object') return fail('registry-binding-invalid', 'no task binding');
  if (bindingDigest(b) !== i.taskBindingDigest) return fail('registry-binding-invalid', 'task binding does not match its digest; refusing to authorize');
  if (b.schemaVersion !== TASK_BINDING_SCHEMA_VERSION) return fail('registry-binding-invalid', 'unsupported task binding schema');
  const levels = Array.isArray(b.supportedReasoning) ? b.supportedReasoning : [];
  if (levels.length === 0 || levels.indexOf(b.defaultReasoning) === -1) return fail('registry-binding-invalid', 'task binding declares no usable levels');
  const resolution = i.resolution;
  const extension = i.extension;
  if (!selfConsistent(resolution) || !extension || typeof extension !== 'object') return fail('registry-issuance-corrupt', 'the task issuance is not self-consistent');
  // the presented issuance must be the task's own (default effort) under this binding
  if (resolution.taskInstanceId !== b.taskInstanceId || resolution.role !== b.role || resolution.issuer !== b.issuer
    || resolution.provenance.registrySnapshotDigest !== b.registrySnapshotDigest
    || issuer.canonicalSha256(projectTarget(resolution.target)) !== issuer.canonicalSha256(b.target)
    || issuer.canonicalSha256(projectExtension(extension)) !== issuer.canonicalSha256(b.extension)
    || resolution.target.reasoning !== b.defaultReasoning || extension.reasoningEffort !== b.defaultReasoning) {
    return fail('registry-binding-mismatch', 'the presented issuance is not the task issuance this binding seals');
  }
  // the binding's levels must be exactly what the sealed task target authorizes
  const derived = authorizedLevels(resolution.target);
  if (!derived || JSON.stringify(derived) !== JSON.stringify(levels)) return fail('registry-binding-mismatch', 'the binding claims other reasoning levels than the task issuance authorizes');
  const effort = i.requestedEffort;
  if (typeof effort !== 'string' || !LEVEL.test(effort)) return fail('registry-effort-invalid', 'requested effort is not a reasoning level');
  if (levels.indexOf(effort) === -1) return fail('reasoning-level-not-supported', 'reasoning ' + JSON.stringify(effort) + ' is not supported by the task route; never escalated or downshifted');
  if (effort === b.defaultReasoning) {
    return { ok: true, attempt: { effort: effort, resolution: resolution, extension: extension, extensionDigest: issuer.canonicalSha256(extension), issuanceId: resolution.provenance.issuanceId, targetDigest: resolution.provenance.targetDigest, taskBindingDigest: i.taskBindingDigest } };
  }
  const target = Object.assign({}, resolution.target, { reasoning: effort });
  const targetDigest = issuer.canonicalSha256(target);
  const provenance = Object.assign({}, resolution.provenance, { targetDigest: targetDigest });
  delete provenance.issuanceId;
  const attemptResolution = {
    schemaVersion: resolution.schemaVersion,
    issuer: resolution.issuer,
    taskInstanceId: resolution.taskInstanceId,
    role: resolution.role,
    target: target,
    provenance: provenance,
  };
  attemptResolution.provenance = Object.assign({}, provenance, { issuanceId: issuer.canonicalSha256(sealContentOf(attemptResolution)) });
  const attemptExtension = Object.assign({}, extension, { reasoningEffort: effort });
  // self-verify: same projection, the requested effort exactly, self-consistent digests
  if (!selfConsistent(attemptResolution)
    || issuer.canonicalSha256(projectTarget(attemptResolution.target)) !== issuer.canonicalSha256(b.target)
    || issuer.canonicalSha256(projectExtension(attemptExtension)) !== issuer.canonicalSha256(b.extension)
    || attemptResolution.target.reasoning !== effort || attemptExtension.reasoningEffort !== effort) {
    return fail('registry-issuance-corrupt', 'attempt target failed self-verification; refusing to issue');
  }
  return { ok: true, attempt: { effort: effort, resolution: attemptResolution, extension: attemptExtension, extensionDigest: issuer.canonicalSha256(attemptExtension), issuanceId: attemptResolution.provenance.issuanceId, targetDigest: targetDigest, taskBindingDigest: i.taskBindingDigest } };
}

module.exports = {
  TASK_BINDING_SCHEMA_VERSION: TASK_BINDING_SCHEMA_VERSION,
  projectTarget: projectTarget,
  projectExtension: projectExtension,
  bindingDigest: bindingDigest,
  buildTaskBinding: buildTaskBinding,
  authorizeAttemptTarget: authorizeAttemptTarget,
  selfConsistent: selfConsistent,
  authorizedLevels: authorizedLevels,
};
