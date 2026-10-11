'use strict';
/**
 * Registry R6.3 - reversible Registry session binding (default OFF).
 * The flag is environment-only (NEXUS_REGISTRY_BINDING=1) and is never
 * exposed through the Registry web interface: enabling requires host
 * process environment access, which unauthenticated UI callers lack.
 * With the flag OFF, binds are byte-identical legacy (no new fields).
 * With the flag ON, a NEW session compiles the complete staged config,
 * demands full shadow parity with the authoritative legacy decision,
 * then pins resolution id, config revision, exact role target, and
 * execution contract to the session/task generation. The executed
 * decision is the legacy one, proven equal to the pin: any disagreement
 * fails the bind closed instead of substituting a provider or level.
 * Running sessions never re-resolve: recovery carries the pin forward
 * and re-verifies it. Rollback (flag OFF) keeps enforcing an existing
 * pin under legacy-rollback authority until the generation ends; new
 * sessions bind pure legacy. Pure module: no I/O, no clock except the
 * injected nowUtc seam.
 */
const BINDING_FLAG = 'NEXUS_REGISTRY_BINDING';
const BINDING_SCHEMA_VERSION = 1;
const CONNECTION_EVIDENCE_MAX_AGE_MS = 5 * 60 * 1000;
function isRegistryBindingEnabled(env) {
  const e = env || {};
  try { return e[BINDING_FLAG] === '1'; } catch { return false; }
}
function errObj(code, message) { return { code: code, message: message }; }
function pinOf(shadowOut, decision, nowUtc) {
  const stamp = typeof nowUtc === 'function' ? nowUtc() : new Date().toISOString();
  return {
    schemaVersion: BINDING_SCHEMA_VERSION,
    authority: 'registry',
    modeId: shadowOut.modeId,
    resolutionId: shadowOut.resolutionId,
    configRevision: shadowOut.configRevision,
    stagedSource: shadowOut.staged ? shadowOut.staged.source : null,
    preset: shadowOut.preset,
    engine: shadowOut.engine,
    role: shadowOut.role,
    lockedPreset: shadowOut.lockedPreset === true,
    roleTarget: {
      provider: shadowOut.projected.provider,
      model: shadowOut.projected.model,
      reasoning: shadowOut.projected.reasoning,
      modelId: shadowOut.projected.modelId,
      logicalModelId: shadowOut.projected.logicalModelId,
      routeId: shadowOut.projected.routeId,
      connectionId: shadowOut.projected.connectionId,
      executionKind: shadowOut.projected.executionKind,
      accessType: shadowOut.projected.accessType,
      dataUseTier: shadowOut.projected.dataUseTier,
    },
    legacyDecision: { provider: decision.provider ?? null, model: decision.model ?? null, reasoning: decision.reasoning ?? null, writable: decision.writable ?? null },
    connectionLiveCheck: 'deferred-to-request-time',
    boundAtUtc: stamp,
  };
}
function checkEvidence(evidence, nowMs) {
  if (!evidence) return { ok: true, note: 'deferred-to-request-time' };
  const status = typeof evidence.status === 'string' ? evidence.status : null;
  if (status === 'revoked') return { ok: false, code: 'registry-connection-revoked', message: 'connection ' + String(evidence.connectionId || 'unknown') + ' is revoked; bind refused' };
  if (status === 'expired' || status === 'not-connected') return { ok: false, code: 'registry-connection-unavailable', message: 'connection ' + String(evidence.connectionId || 'unknown') + ' reports ' + status + '; bind refused' };
  const checked = Date.parse(evidence.checkedAtUtc || '');
  if (Number.isNaN(checked)) return { ok: false, code: 'registry-evidence-stale', message: 'connection evidence carries no parseable checkedAtUtc; bind refused' };
  if (nowMs - checked > CONNECTION_EVIDENCE_MAX_AGE_MS || checked > nowMs + 60000) return { ok: false, code: 'registry-evidence-stale', message: 'connection evidence is stale (checked ' + String(evidence.checkedAtUtc) + '); bind refused' };
  return { ok: true, note: 'evidence-fresh' };
}
function evaluateRegistryBinding(decision, shadowOut, opts) {
  const o = opts || {};
  const nowMs = typeof o.nowMs === 'number' ? o.nowMs : Date.now();
  if (!decision || typeof decision !== 'object') return { ok: false, code: 'registry-binding-invalid-decision', errors: [errObj('registry-binding-invalid-decision', 'legacy decision missing')] };
  if (!shadowOut || typeof shadowOut !== 'object') return { ok: false, code: 'registry-binding-unavailable', errors: [errObj('registry-binding-unavailable', 'no shadow diagnostics; refusing to bind')] };
  if (shadowOut.shadowOk !== true) return { ok: false, code: 'registry-binding-unavailable', errors: (shadowOut.errors || []).map((e) => ({ code: String(e.code || 'unknown'), message: String(e.message || e) })) };
  if (shadowOut.parity !== true) return { ok: false, code: 'registry-binding-mismatch', mismatches: shadowOut.mismatches || [], errors: (shadowOut.mismatches || []).map((m) => ({ code: String(m.code), message: String(m.message) })) };
  if (!shadowOut.resolutionId || typeof shadowOut.configRevision !== 'number') return { ok: false, code: 'registry-binding-unpinned', errors: [errObj('registry-binding-unpinned', 'compiled snapshot lacks resolution identity; refusing to bind')] };
  const ev = checkEvidence(o.connectionEvidence || null, nowMs);
  if (!ev.ok) return { ok: false, code: ev.code, errors: [errObj(ev.code, ev.message)] };
  const pin = pinOf(shadowOut, decision, o.nowUtc);
  pin.connectionLiveCheck = ev.note;
  return { ok: true, code: 'registry-bound', pin: pin, errors: [] };
}
function verifyPinnedBinding(decision, pin) {
  if (!pin || typeof pin !== 'object' || !pin.roleTarget) return { ok: false, code: 'registry-pin-invalid', mismatches: [], errors: [errObj('registry-pin-invalid', 'binding carries no well-formed registry pin')] };
  if (!decision || typeof decision !== 'object') return { ok: false, code: 'registry-pin-invalid', mismatches: [], errors: [errObj('registry-pin-invalid', 'legacy decision missing for pin verification')] };
  const mismatches = []; const t = pin.roleTarget;
  function eq(field, a, b, code) { if (a !== b) mismatches.push({ code: code, field: field, message: field + ' drifted: pinned ' + JSON.stringify(b) + ' vs current ' + JSON.stringify(a) }); }
  eq('provider', decision.provider ?? null, t.provider, 'registry-pin-mismatch');
  eq('model', decision.model ?? null, t.model, 'registry-pin-mismatch');
  eq('reasoning', decision.reasoning ?? null, t.reasoning, 'registry-pin-mismatch');
  eq('engine', decision.engine ?? null, pin.engine, 'registry-pin-mismatch');
  const role = (decision.engine === 'muse') ? 'muse_main' : (decision.role ?? null);
  eq('role', role, pin.role, 'registry-pin-mismatch');
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
module.exports = { BINDING_FLAG: BINDING_FLAG, BINDING_SCHEMA_VERSION: BINDING_SCHEMA_VERSION, CONNECTION_EVIDENCE_MAX_AGE_MS: CONNECTION_EVIDENCE_MAX_AGE_MS, isRegistryBindingEnabled: isRegistryBindingEnabled, evaluateRegistryBinding: evaluateRegistryBinding, verifyPinnedBinding: verifyPinnedBinding, rollbackPinnedBinding: rollbackPinnedBinding };