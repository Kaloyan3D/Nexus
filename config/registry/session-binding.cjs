'use strict';
/** R6.3 (+R6.3.1 lockdown) reversible Registry session binding. Flag env-only, default OFF. */
const resolver = require('./resolver.cjs');
const BINDING_FLAG = 'NEXUS_REGISTRY_BINDING';
const BINDING_SCHEMA_VERSION = 1;
const CONNECTION_EVIDENCE_MAX_AGE_MS = 5 * 60 * 1000;
function isRegistryBindingEnabled(env) { const e = env || {}; try { return e[BINDING_FLAG] === '1'; } catch { return false; } }
function errObj(code, message) { return { code: code, message: message }; }
function decisionRoleOf(decision) { const d = decision || {}; if (d.engine === 'muse') return 'muse_main'; return typeof d.role === 'string' && d.role !== '' ? d.role : null; }
function mapEntryFor(pin, role) {
  const map = pin && pin.roleTargets && typeof pin.roleTargets === 'object' ? pin.roleTargets : null;
  if (map && map[role] && typeof map[role] === 'object') return map[role];
  if (pin && pin.roleTarget && pin.role === role) return { available: true, target: pin.roleTarget };
  return null;
}
function compareTarget(t, legacy, mismatches, prefix) {
  function eq(field, a, b, code) { if (a !== b) mismatches.push({ code: code, field: field, message: (prefix || '') + field + ' mismatch: pinned ' + JSON.stringify(b) + ' vs current ' + JSON.stringify(a) }); }
  eq('provider', legacy.provider, t.provider, 'registry-pin-mismatch');
  eq('model', legacy.model, t.model, 'registry-pin-mismatch');
  eq('reasoning', legacy.reasoning, t.reasoning, 'registry-pin-mismatch');
  if (legacy.dataUseTier != null || t.dataUseTier != null) eq('dataUseTier', legacy.dataUseTier ?? null, t.dataUseTier ?? null, 'registry-pin-mismatch');
}
function pinOf(shadowOut, decision, opts) {
  const o = opts || {};
  const stamp = typeof o.nowUtc === 'function' ? o.nowUtc() : new Date().toISOString();
  const bt = o.bindTask || {}; const d = decision || {}; const p = shadowOut.projected || {};
  return { schemaVersion: BINDING_SCHEMA_VERSION, authority: 'registry', modeId: shadowOut.modeId,
    resolutionId: shadowOut.resolutionId, configRevision: shadowOut.configRevision,
    stagedSource: shadowOut.staged ? shadowOut.staged.source : null,
    taskId: bt.taskId !== undefined ? bt.taskId : (d.taskId ?? null),
    taskInstanceId: bt.taskInstanceId !== undefined ? bt.taskInstanceId : (d.taskInstanceId ?? null),
    preset: shadowOut.preset, engine: shadowOut.engine, role: shadowOut.role,
    lockedPreset: shadowOut.lockedPreset === true,
    roleTarget: { provider: p.provider ?? null, model: p.model ?? null, reasoning: p.reasoning ?? null, modelId: p.modelId ?? null, logicalModelId: p.logicalModelId ?? null, routeId: p.routeId ?? null, connectionId: p.connectionId ?? null, executionKind: p.executionKind ?? null, accessType: p.accessType ?? null, dataUseTier: p.dataUseTier ?? null },
    roleTargets: JSON.parse(JSON.stringify(shadowOut.roleTargets || {})),
    legacyDecision: { provider: d.provider ?? null, model: d.model ?? null, reasoning: d.reasoning ?? null, writable: d.writable ?? null },
    authorization: null, connectionLiveCheck: 'snapshot-status-only', boundAtUtc: stamp };
}
function checkEvidence(evidence, nowMs) {
  if (!evidence) return { ok: true, note: 'snapshot-status-only' };
  const status = typeof evidence.status === 'string' ? evidence.status : null;
  if (status === 'revoked') return { ok: false, code: 'registry-connection-revoked', message: 'connection ' + String(evidence.connectionId || 'unknown') + ' is revoked; bind refused' };
  if (status === 'expired' || status === 'not-connected') return { ok: false, code: 'registry-connection-unavailable', message: 'connection ' + String(evidence.connectionId || 'unknown') + ' reports ' + status + '; bind refused' };
  const checked = Date.parse(evidence.checkedAtUtc || '');
  if (Number.isNaN(checked)) return { ok: false, code: 'registry-evidence-stale', message: 'connection evidence carries no parseable checkedAtUtc; bind refused' };
  if (nowMs - checked > CONNECTION_EVIDENCE_MAX_AGE_MS || checked > nowMs + 60000) return { ok: false, code: 'registry-evidence-stale', message: 'connection evidence is stale (checked ' + String(evidence.checkedAtUtc) + '); bind refused' };
  return { ok: true, note: 'evidence-fresh' };
}
function evaluateRegistryBinding(decision, shadowOut, opts) {
  const o = opts || {}; const nowMs = typeof o.nowMs === 'number' ? o.nowMs : Date.now();
  if (!decision || typeof decision !== 'object') return { ok: false, code: 'registry-binding-invalid-decision', errors: [errObj('registry-binding-invalid-decision', 'legacy decision missing')] };
  if (!shadowOut || typeof shadowOut !== 'object') return { ok: false, code: 'registry-binding-unavailable', errors: [errObj('registry-binding-unavailable', 'no shadow diagnostics; refusing to bind')] };
  if (shadowOut.shadowOk !== true) return { ok: false, code: 'registry-binding-unavailable', errors: (shadowOut.errors || []).map((e) => ({ code: String(e.code || 'unknown'), message: String(e.message || e) })) };
  if (shadowOut.parity !== true) return { ok: false, code: 'registry-binding-mismatch', mismatches: shadowOut.mismatches || [], errors: (shadowOut.mismatches || []).map((m) => ({ code: String(m.code), message: String(m.message) })) };
  if (!shadowOut.resolutionId || typeof shadowOut.configRevision !== 'number') return { ok: false, code: 'registry-binding-unpinned', errors: [errObj('registry-binding-unpinned', 'compiled snapshot lacks resolution identity; refusing to bind')] };
  let roleTargets = shadowOut.roleTargets && typeof shadowOut.roleTargets === 'object' ? shadowOut.roleTargets : null;
  if (!roleTargets || Object.keys(roleTargets).length === 0) {
    const role = decisionRoleOf(decision); const p = shadowOut.projected || {};
    if (!role || !p.provider) return { ok: false, code: 'registry-binding-unpinned', errors: [errObj('registry-binding-unpinned', 'no role-target map and no narrow fallback; refusing to bind')] };
    const t = {}; t[role] = { available: true, target: { provider: p.provider ?? null, model: p.model ?? null, reasoning: p.reasoning ?? null, modelId: p.modelId ?? null, logicalModelId: p.logicalModelId ?? null, routeId: p.routeId ?? null, connectionId: p.connectionId ?? null, executionKind: p.executionKind ?? null, accessType: p.accessType ?? null, dataUseTier: p.dataUseTier ?? null } };
    roleTargets = t;
  }
  const ev = checkEvidence(o.connectionEvidence || null, nowMs);
  if (!ev.ok) return { ok: false, code: ev.code, errors: [errObj(ev.code, ev.message)] };
  const pin = pinOf(shadowOut, decision, o); pin.roleTargets = JSON.parse(JSON.stringify(roleTargets));
  const conn = shadowOut.connection || null; const cev = o.connectionEvidence || null;
  const status = cev && typeof cev.status === 'string' ? cev.status : (conn && typeof conn.status === 'string' ? conn.status : 'unknown');
  pin.authorization = { connectionId: (cev && cev.connectionId) || (conn && conn.id) || pin.roleTarget.connectionId, status: status, provenance: (conn && conn.provenance) || null, verifiedAtBind: status === 'connected', evidenceCheckedAtUtc: (cev && cev.checkedAtUtc) || null, note: cev ? 'operator evidence evaluated at bind' : 'snapshot status only; no live probe at bind; re-requests require current entitlement (unchecked here)' };
  pin.connectionLiveCheck = ev.note;
  return { ok: true, code: 'registry-bound', pin: pin, errors: [] };
}
function verifyTransitionTarget(decision, pin) {
  if (!pin || typeof pin !== 'object') return { ok: false, code: 'registry-pin-invalid', mismatches: [], errors: [errObj('registry-pin-invalid', 'no well-formed registry pin')] };
  if (!decision || typeof decision !== 'object') return { ok: false, code: 'registry-pin-invalid', mismatches: [], errors: [errObj('registry-pin-invalid', 'legacy decision missing for verification')] };
  const role = decisionRoleOf(decision);
  if (!role) return { ok: false, code: 'registry-role-unmapped', mismatches: [{ code: 'registry-role-unmapped', field: 'role', message: 'decision carries no role and engine is not muse' }], errors: [errObj('registry-role-unmapped', 'decision carries no role')] };
  if (pin.taskInstanceId != null && decision.taskInstanceId != null && pin.taskInstanceId !== decision.taskInstanceId) {
    const m = { code: 'registry-generation-mismatch', field: 'taskInstanceId', message: 'pin belongs to generation ' + JSON.stringify(pin.taskInstanceId) + ', decision to ' + JSON.stringify(decision.taskInstanceId) };
    return { ok: false, code: 'registry-generation-mismatch', mismatches: [m], errors: [{ code: m.code, message: m.message }] };
  }
  const entry = mapEntryFor(pin, role);
  if (!entry) { const m = { code: 'registry-role-unpinned', field: 'role', message: 'no pinned target for role ' + role + '; transition refused' }; return { ok: false, code: 'registry-role-unpinned', mismatches: [m], errors: [{ code: m.code, message: m.message }] }; }
  if (entry.available !== true) { const m = { code: 'registry-role-unavailable', field: 'role', message: 'pinned target for role ' + role + ' is unavailable (' + String(entry.code || 'unknown') + ')' }; return { ok: false, code: 'registry-role-unavailable', mismatches: [m], errors: [{ code: m.code, message: m.message }] }; }
  const mismatches = []; const t = entry.target || {};
  compareTarget(t, { provider: decision.provider ?? null, model: decision.model ?? null, reasoning: decision.reasoning ?? null, dataUseTier: decision.dataUseTier ?? null }, mismatches, '');
  if (mismatches.length > 0) return { ok: false, code: 'registry-pin-mismatch', mismatches: mismatches, errors: mismatches.map((m) => ({ code: m.code, message: m.message })) };
  return { ok: true, code: 'registry-transition-verified', mismatches: [], errors: [] };
}
function verifyPinnedBinding(decision, pin) {
  if (pin && pin.roleTargets && typeof pin.roleTargets === 'object' && Object.keys(pin.roleTargets).length > 0) return verifyTransitionTarget(decision, pin);
  if (!pin || typeof pin !== 'object' || !pin.roleTarget) return { ok: false, code: 'registry-pin-invalid', mismatches: [], errors: [errObj('registry-pin-invalid', 'binding carries no well-formed registry pin')] };
  if (!decision || typeof decision !== 'object') return { ok: false, code: 'registry-pin-invalid', mismatches: [], errors: [errObj('registry-pin-invalid', 'legacy decision missing for pin verification')] };
  const mismatches = []; const t = pin.roleTarget;
  compareTarget(t, { provider: decision.provider ?? null, model: decision.model ?? null, reasoning: decision.reasoning ?? null }, mismatches, '');
  const role = decisionRoleOf(decision);
  if (role !== pin.role) mismatches.push({ code: 'registry-pin-mismatch', field: 'role', message: 'role drifted: pinned ' + JSON.stringify(pin.role) + ' vs current ' + JSON.stringify(role) });
  if ((decision.engine ?? null) !== pin.engine) mismatches.push({ code: 'registry-pin-mismatch', field: 'engine', message: 'engine drifted' });
  if (mismatches.length > 0) return { ok: false, code: 'registry-pin-mismatch', mismatches: mismatches, errors: mismatches.map((m) => ({ code: m.code, message: m.message })) };
  return { ok: true, code: 'registry-pin-verified', mismatches: [], errors: [] };
}
function rollbackPinnedBinding(decision, pin) {
  const checked = verifyPinnedBinding(decision, pin);
  if (!checked.ok) return checked;
  const next = JSON.parse(JSON.stringify(pin));
  next.authority = 'legacy-rollback';
  return { ok: true, code: 'registry-rollback', pin: next, mismatches: [], errors: [] };
}
function authorizationForTransition(conn) {
  if (!conn || typeof conn !== 'object') return { ok: false, code: 'registry-authorization-unverifiable', errors: [errObj('registry-authorization-unverifiable', 'no current connection state; refusing transition')] };
  let ineligible = null;
  try { ineligible = resolver.connectionEligibility({ id: conn.id, status: conn.status, provenance: conn.provenance, providerId: conn.providerId, connectionKind: conn.connectionKind }); }
  catch (e) { return { ok: false, code: 'registry-authorization-unverifiable', errors: [errObj('registry-authorization-unverifiable', 'eligibility check failed: ' + String((e && e.message) || e))] }; }
  if (!ineligible) return { ok: true, code: 'registry-authorization-verified', errors: [] };
  const code = conn.status === 'revoked' ? 'registry-authorization-revoked' : 'registry-authorization-unavailable';
  return { ok: false, code: code, errors: [{ code: code, message: String(ineligible.message || ineligible.code) }] };
}
function validateStepTarget(pin, role, roleTarget) {
  if (!pin || typeof pin !== 'object') return { ok: false, code: 'registry-pin-invalid', errors: [errObj('registry-pin-invalid', 'no well-formed registry pin')] };
  if (typeof role !== 'string' || role === '') return { ok: false, code: 'registry-role-unmapped', errors: [errObj('registry-role-unmapped', 'step carries no role')] };
  if (!roleTarget || typeof roleTarget !== 'object') return { ok: false, code: 'registry-step-target-invalid', errors: [errObj('registry-step-target-invalid', 'step carries no role target')] };
  const entry = mapEntryFor(pin, role);
  if (!entry) return { ok: false, code: 'registry-role-unpinned', errors: [errObj('registry-role-unpinned', 'no pinned target for step role ' + role)] };
  if (entry.available !== true) return { ok: false, code: 'registry-role-unavailable', errors: [errObj('registry-role-unavailable', 'pinned step target for ' + role + ' unavailable')] };
  const mismatches = []; const t = entry.target || {};
  function eq(field, a, b) { if (a !== b) mismatches.push({ code: 'registry-step-target-mismatch', field: field, message: 'step ' + field + ' mismatch: pinned ' + JSON.stringify(b) + ' vs step ' + JSON.stringify(a) }); }
  eq('provider', roleTarget.provider ?? null, t.provider ?? null); eq('model', roleTarget.model ?? null, t.model ?? null); eq('reasoning', roleTarget.reasoning ?? null, t.reasoning ?? null);
  if (mismatches.length > 0) return { ok: false, code: 'registry-step-target-mismatch', mismatches: mismatches, errors: mismatches.map((m) => ({ code: m.code, message: m.message })) };
  return { ok: true, code: 'registry-step-target-verified', errors: [] };
}
function classifyRegistryState(binding) {
  const b = binding || {};
  // A malformed marker is evidence of unverified authority, not absence of
  // Registry authority. Request readers operate independently of pre-step.
  const malformed = ['registryPin', 'registryRefused'].some(field => Object.prototype.hasOwnProperty.call(b, field) &&
    (!b[field] || typeof b[field] !== 'object' || Array.isArray(b[field]))) ||
    (b.bindingAuthority === 'registry' && !b.registryPin);
  if (malformed) return { state: 'refused', pin: null, refusal: { code: 'registry-authority-unverifiable' }, invalid: true };
  const pin = b.registryPin && typeof b.registryPin === 'object' ? b.registryPin : null;
  const refusal = b.registryRefused && typeof b.registryRefused === 'object' ? b.registryRefused : null;
  if (pin) return { state: 'pinned', pin: pin, refusal: refusal };
  if (refusal) return { state: refusal.code === 'registry-pending' ? 'pending' : 'refused', pin: null, refusal: refusal };
  return { state: 'legacy', pin: null, refusal: null };
}
function planTransition(input) {
  const o = input || {}; const b = o.binding || {}; const d = o.decision || {}; const flagOn = o.flagOn === true;
  const pin = b.registryPin && typeof b.registryPin === 'object' ? b.registryPin : null;
  const refusal = b.registryRefused && typeof b.registryRefused === 'object' ? b.registryRefused : null;
  function genMatch() {
    if (!pin) return false;
    if (pin.taskInstanceId == null || d.taskInstanceId == null) return true;
    return pin.taskInstanceId === d.taskInstanceId;
  }
  if (pin && genMatch()) return { action: 'verify', reason: 'pinned-generation' };
  if (pin && !genMatch()) return flagOn ? { action: 'evaluate-fresh', reason: 'new-generation' } : { action: 'rollback-pinned', reason: 'new-generation-flag-off' };
  if (refusal && flagOn) return { action: 'evaluate-fresh', reason: 'retry-refused' };
  if (refusal && !flagOn) return { action: 'rollback-refused', reason: 'rollback' };
  if (flagOn && o.isInitialBind === true) return { action: 'evaluate-fresh', reason: 'fresh-bind' };
  return { action: 'proceed-legacy', reason: 'legacy' };
}
module.exports = { BINDING_FLAG: BINDING_FLAG, mapEntryFor: mapEntryFor, checkTurnEntry: checkTurnEntry, checkExecutionTarget: checkExecutionTarget, rollbackPinnedBinding: rollbackPinnedBinding, BINDING_SCHEMA_VERSION: BINDING_SCHEMA_VERSION, CONNECTION_EVIDENCE_MAX_AGE_MS: CONNECTION_EVIDENCE_MAX_AGE_MS, isRegistryBindingEnabled: isRegistryBindingEnabled, evaluateRegistryBinding: evaluateRegistryBinding, verifyPinnedBinding: verifyPinnedBinding, verifyTransitionTarget: verifyTransitionTarget, authorizationForTransition: authorizationForTransition, validateStepTarget: validateStepTarget, classifyRegistryState: classifyRegistryState, planTransition: planTransition };
function checkTurnEntry(input) {
  const o = input || {};
  const cls = classifyRegistryState(o.binding);
  if (cls.state === 'legacy') return { ok: true, code: 'registry-legacy', mode: 'legacy' };
  if (cls.state === 'refused' || cls.state === 'pending') {
    if (o.flagOn === true) {
      const code = (cls.refusal && cls.refusal.code) || 'registry-refused';
      return { ok: false, code: code, mode: 'refused' };
    }
    return { ok: true, code: 'registry-rollback', mode: 'rollback' };
  }
  const binding = o.binding || {}; const pin = cls.pin;
  if (pin.taskInstanceId != null && binding.taskInstanceId != null && pin.taskInstanceId !== binding.taskInstanceId) return { ok: false, code: 'registry-generation-mismatch', mode: 'pinned' };
  const role = o.role || null;
  if (!role) return { ok: false, code: 'registry-role-unmapped', mode: 'pinned' };
  const entry = mapEntryFor(pin, role);
  if (!entry) return { ok: false, code: 'registry-role-unpinned', mode: 'pinned' };
  if (entry.available !== true) return { ok: false, code: 'registry-role-unavailable', mode: 'pinned' };
  const az = authorizationForTransition(o.connection !== undefined ? o.connection : null);
  if (!az.ok) return { ok: false, code: az.code, mode: 'pinned' };
  return { ok: true, code: 'registry-execution-allowed', mode: 'pinned' };
}

// R7.5A: common pure execution verdict used at pre-step AND actual request.
// Markers may execute through legacy only after a durable explicit rollback.
function checkExecutionTarget(input) {
  const o = input || {}; const b = o.binding || {}; const cls = classifyRegistryState(b);
  if (cls.state === 'legacy') return { ok: true, code: 'registry-legacy' };
  if (cls.state !== 'pinned') {
    if (!cls.invalid && !o.flagOn && b.bindingAuthority === 'legacy-rollback') return { ok: true, code: 'registry-rollback' };
    return { ok: false, code: cls.refusal.code || 'registry-refused' };
  }
  const target = o.target || {};
  if (!b.taskInstanceId || !cls.pin.taskInstanceId || cls.pin.taskInstanceId !== b.taskInstanceId ||
      !target.state || target.state.taskInstanceId !== b.taskInstanceId) {
    return { ok: false, code: 'registry-generation-mismatch' };
  }
  const role = b.engine === 'muse' ? 'muse_main' : target.role;
  const verified = verifyTransitionTarget({ ...target, engine: b.engine, role, taskInstanceId: b.taskInstanceId }, cls.pin);
  return verified.ok ? checkTurnEntry({ binding: b, role, connection: o.connection, flagOn: o.flagOn }) : verified;
}
