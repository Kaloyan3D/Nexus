'use strict';

/**
 * Registry R6.2 - read-only shadow parity at the controller binding boundary.
 * Compares the AUTHORITATIVE legacy routing decision (the real Route.ps1
 * record consumed at bind time) against the staged Registry mode
 * configuration compiled through resolver.compileModeConfig and projected
 * through dsh-adapter.bindingToLegacyTarget.
 * Read-only: no writes, never throws. Every failure is diagnostics.
 * Callers MUST NOT branch production behavior on parity.
 */
const fs = require('node:fs');
const path = require('node:path');
const resolver = require('./resolver.cjs');
const dshAdapter = require('./dsh-adapter.cjs');
const serviceModule = require('./service.cjs');
// R7.1.1: mode definition assets are managed files (config/registry/modes/*.json)
// pinned by the preset dependency closure. legacy-import.cjs reads them via
// __dirname-relative fs access, so a preset copy without them compiles every
// known mode to unknown-mode. Detect that deployment defect explicitly so it
// is never confused with an unrecognized mode id, an invalid saved config,
// or a genuine legacy/Registry routing mismatch. All branches stay fail-closed.
const KNOWN_MODE_IDS = Object.freeze(['engineering-v1', 'engineering-v2', 'engineering-v3']);
const MODE_DEFINITION_FILES = Object.freeze(['engineering-v1.json', 'engineering-v2.json', 'engineering-v3.json']);
function missingModeDefinitions(installRoot) {
  const missing = [];
  for (const file of MODE_DEFINITION_FILES) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(String(installRoot), 'config', 'registry', 'modes', file), 'utf8'));
      if (!doc || doc.id !== file.replace(/\.json$/, '')) missing.push(file);
    } catch { missing.push(file); }
  }
  return missing;
}
function compileErrorsSignalMissingModes(errs, modeId) {
  const codes = (errs || []).map((e) => String((e && e.code) || ''));
  if (codes.indexOf('registry-mode-definitions-incomplete') !== -1) return true;
  if (codes.indexOf('snapshot-unavailable') !== -1) return true;
  if (codes.indexOf('unknown-mode') !== -1 && KNOWN_MODE_IDS.indexOf(modeId) !== -1) return true;
  return false;
}
const SHADOW_SCHEMA_VERSION = 1;
const PRESET_TO_MODE = Object.freeze({ 'aih-engineering': 'engineering-v1', 'aih-deepseek': 'engineering-v1', 'aih-muse': 'engineering-v2' });
const LOCKED_PRESETS = Object.freeze({ 'aih-deepseek': true });
const MODE_TO_ENGINE = Object.freeze({ 'engineering-v1': 'dual', 'engineering-v2': 'muse' });
const EXPECTED_EXECUTION_KIND = 'raw-model';
function diag(code, path, message) { return { code: code, path: path, message: message }; }
function isNonEmptyString(v) { return typeof v === 'string' && v !== ''; }
function fail(code, message, partial) {
  const p = partial || {};
  return { shadowOk: false, parity: false, code: code, message: message,
    preset: p.preset || null, engine: p.engine || null, role: p.role || null, modeId: p.modeId || null,
    lockedPreset: p.lockedPreset || false, staged: p.staged || null, resolutionId: null, configRevision: null,
    projected: null, legacy: p.legacy || null, comparisons: [], mismatches: [], errors: [diag(code, 'shadow', message)] };
}
function legacyTargetOf(d) {
  return { provider: d.provider ?? null, model: d.model ?? null, reasoning: d.reasoning ?? null,
    role: d.role ?? null, engine: d.engine ?? null, profile: d.profile ?? null, preset: d.preset ?? null,
    writable: d.writable ?? null, dataUseTier: d.dataUseTier ?? null, executionClass: d.executionClass ?? null };
}
function runShadowComparison(decision, deps) {
  try {
    const partial = {};
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return fail('shadow-decision-invalid', 'legacy decision is missing or malformed; refusing to infer parity');
    const preset = typeof decision.preset === 'string' ? decision.preset : null;
    const engine = typeof decision.engine === 'string' ? decision.engine : null;
    const executionClass = typeof decision.executionClass === 'string' ? decision.executionClass : null;
    partial.preset = preset; partial.engine = engine; partial.role = decision.role ?? null; partial.legacy = legacyTargetOf(decision);
    if (!isNonEmptyString(preset) || !isNonEmptyString(engine) || !isNonEmptyString(executionClass)) return fail('shadow-decision-invalid', 'legacy decision lacks preset, engine, or executionClass; refusing to infer parity', partial);
    const modeId = PRESET_TO_MODE[preset] || null;
    partial.modeId = modeId; partial.lockedPreset = LOCKED_PRESETS[preset] === true;
    if (!modeId) return fail('shadow-preset-unmapped', 'legacy preset ' + preset + ' maps to no Registry mode; refusing to infer parity', partial);
    const expectedEngine = MODE_TO_ENGINE[modeId] || null;
    if (engine !== expectedEngine) {
      const out = fail('shadow-engine-mismatch', 'legacy engine ' + engine + ' disagrees with mode ' + modeId, partial);
      out.mismatches.push({ code: 'engine-mismatch', field: 'engine', message: out.message });
      return out;
    }
    const d = deps || {}; const installRoot = typeof d.installRoot === 'string' ? d.installRoot : ''; const dataRoot = typeof d.dataRoot === 'string' ? d.dataRoot : '';
    if (installRoot === '' || dataRoot === '') return fail('shadow-host-missing', 'installRoot and dataRoot are required', partial);
    let service = d.service || null;
    if (!service) service = serviceModule.createService({ installRoot: installRoot, dataRoot: dataRoot });
    let staged = null;
    try { staged = service.getModeConfiguration(modeId, {}); } catch (e) { return fail('shadow-staged-unreadable', 'staged config unreadable: ' + String((e && e.message) || e), partial); }
    if (!staged || !staged.result || !staged.result.config) {
      const missing = missingModeDefinitions(installRoot);
      if (missing.length > 0) {
        const out = fail('shadow-mode-definitions-missing', 'Registry mode definition assets missing (' + missing.join(', ') + '); reinstall the preset closure without bypassing validation; legacy continues unchanged', partial);
        out.errors = [{ code: 'registry-mode-definitions-missing', path: 'config/registry/modes', message: 'missing mode definition assets: ' + missing.join(', ') }];
        return out;
      }
      return fail('shadow-staged-missing', 'no staged Registry configuration for mode ' + modeId + '; refusing to fabricate parity', partial);
    }
    const stagedInfo = { persisted: Boolean(staged.result.persisted), source: staged.result.source || null, adoptedFrom: staged.result.adoptedFrom || null, revision: typeof staged.result.config.revision === 'number' ? staged.result.config.revision : null };
    partial.staged = stagedInfo;
    let compiled = null;
    try { compiled = service.compilePreview(staged.result.config); } catch (e) { return fail('shadow-compile-threw', 'compilation threw: ' + String((e && e.message) || e), partial); }
    if (!compiled || compiled.ok !== true || !compiled.snapshot) {
      const errs = (compiled && Array.isArray(compiled.errors) && compiled.errors.length > 0) ? compiled.errors : [diag('unknown', 'staged', 'compilation failed')];
      // Missing-asset defect first: a known mode that compiles to unknown-mode
      // (or an unavailable snapshot) with absent mode files is a broken preset
      // closure, not an unrecognized mode id or an invalid saved config.
      if (compileErrorsSignalMissingModes(errs, modeId)) {
        const missing = missingModeDefinitions(installRoot);
        if (missing.length > 0) {
          const out = fail('shadow-mode-definitions-missing', 'Registry mode definition assets missing (' + missing.join(', ') + '); reinstall the preset closure without bypassing validation; legacy continues unchanged', partial);
          out.errors = [{ code: 'registry-mode-definitions-missing', path: 'config/registry/modes', message: 'missing mode definition assets: ' + missing.join(', ') }].concat(errs.map((e) => ({ code: String(e.code || 'unknown'), path: String(e.path || 'staged'), message: String(e.message || e) })));
          return out;
        }
      }
      const out = fail('shadow-compile-failed', 'staged config does not compile (' + errs.map((e) => e.code).join(', ') + '); legacy continues unchanged', partial);
      out.errors = errs.map((e) => ({ code: String(e.code || 'unknown'), path: String(e.path || 'staged'), message: String(e.message || e) }));
      return out;
    }
    const snapshot = compiled.snapshot;
    const role = engine === 'muse' ? 'muse_main' : (typeof decision.role === 'string' ? decision.role : null);
    if (!isNonEmptyString(role)) return fail('shadow-role-unmapped', 'decision carries no role and engine is not muse', partial);
    const binding = snapshot.roles && snapshot.roles[role];
    if (!binding) {
      const out = fail('shadow-role-unmapped', 'compiled config has no binding for role ' + role + '; refusing to fabricate parity', partial);
      out.resolutionId = snapshot.resolutionId || null;
      return out;
    }
    const projected = dshAdapter.bindingToLegacyTarget(binding);
    if (!projected || projected.error || !projected.target) {
      const out = fail('shadow-projection-failed', 'binding for role ' + role + ' does not project (' + String(projected && projected.error) + '); refusing to guess', partial);
      out.resolutionId = binding.resolutionId || snapshot.resolutionId || null;
      return out;
    }
    const target = projected.target;
    const comparisons = []; const mismatches = []; const legacy = partial.legacy;
    function compare(field, legacyValue, registryValue, code) {
      const match = legacyValue === registryValue;
      comparisons.push({ field: field, legacy: legacyValue, registry: registryValue, match: match });
      if (!match) mismatches.push({ code: code, field: field, message: field + ' mismatch: legacy ' + JSON.stringify(legacyValue) + ' vs registry ' + JSON.stringify(registryValue) });
    }
    compare('provider', legacy.provider, target.provider || null, 'provider-mismatch');
    compare('model', legacy.model, target.model || null, 'model-mismatch');
    compare('reasoning', legacy.reasoning, target.reasoning || null, 'reasoning-mismatch');
    compare('role', engine === 'muse' ? 'muse_main' : legacy.role, binding.roleId || null, 'role-mismatch');
    compare('engine', engine, MODE_TO_ENGINE[binding.modeId] || expectedEngine, 'engine-mismatch');
    if (role === 'reviewer') {
      const ro = Boolean(binding.slotRequirements && binding.slotRequirements.readOnlyEnforced);
      const match = ro === true && legacy.writable === false;
      comparisons.push({ field: 'writable', legacy: legacy.writable, registry: ro ? 'read-only' : 'writable', match: match });
      if (!match) mismatches.push({ code: 'reviewer-not-readonly', field: 'writable', message: 'reviewer not read-only on both planes' });
    }
    if (binding.executionKind !== EXPECTED_EXECUTION_KIND) {
      comparisons.push({ field: 'executionKind', legacy: EXPECTED_EXECUTION_KIND, registry: binding.executionKind || null, match: false });
      mismatches.push({ code: 'execution-kind-mismatch', field: 'executionKind', message: 'role ' + role + ' compiled to ' + String(binding.executionKind) + '; v1/v2 require ' + EXPECTED_EXECUTION_KIND });
    } else { comparisons.push({ field: 'executionKind', legacy: EXPECTED_EXECUTION_KIND, registry: binding.executionKind, match: true }); }
    if (target.dataUseTier != null || legacy.dataUseTier != null) compare('dataUseTier', legacy.dataUseTier, target.dataUseTier || null, 'data-use-tier-mismatch');
    const projectedOut = { modelId: target.modelId || null, model: target.model || null, provider: target.provider || null, reasoning: target.reasoning || null, dataUseTier: target.dataUseTier || null, logicalModelId: binding.logicalModelId || null, routeId: binding.routeId || null, connectionId: binding.connectionId || null, executionKind: binding.executionKind || null, accessType: binding.accessType || null };
    // R6.3.1: project EVERY compiled role into the generation map so later
    // transitions validate against their own immutable assignment. Roles that
    // cannot project are recorded explicitly, never skipped silently.
    const roleTargets = {};
    for (const rn of Object.keys(snapshot.roles || {})) {
      const b = snapshot.roles[rn];
      const pr = dshAdapter.bindingToLegacyTarget(b);
      if (pr && !pr.error && pr.target) {
        const t = pr.target;
        roleTargets[rn] = { available: true, target: { modelId: t.modelId || null, model: t.model || null, provider: t.provider || null, reasoning: t.reasoning || null, dataUseTier: t.dataUseTier || null, logicalModelId: b.logicalModelId || null, routeId: b.routeId || null, connectionId: b.connectionId || null, executionKind: b.executionKind || null, accessType: b.accessType || null } };
      } else {
        roleTargets[rn] = { available: false, code: 'shadow-role-unprojectable', reason: String(pr && pr.error) };
      }
    }
    // R6.3.1: current effective connection state for the bound role (overlay-
    // merged snapshot read; no live probe). Missing services yield explicit
    // unknown, never an assumed status.
    let connectionOut = null;
    try {
      if (service && typeof service.getConnections === 'function') {
        const conns = service.getConnections();
        const list = conns && Array.isArray(conns.connections) ? conns.connections : [];
        const hit = list.find((c) => c && c.id === (binding.connectionId || null));
        if (hit) connectionOut = { id: hit.id, status: hit.status || null, provenance: hit.provenance || null };
        else if (binding.connectionId) connectionOut = { id: binding.connectionId, status: 'unknown', provenance: null };
      } else if (binding.connectionId) connectionOut = { id: binding.connectionId, status: 'unknown', provenance: null };
    } catch (e2) { connectionOut = binding.connectionId ? { id: binding.connectionId, status: 'unknown', provenance: null } : null; }
    return { shadowOk: true, parity: mismatches.length === 0, code: mismatches.length === 0 ? 'shadow-parity' : 'shadow-mismatch',
      message: mismatches.length === 0 ? 'legacy decision and Registry projection agree on every compared field' : 'legacy and Registry disagree (' + mismatches.map((m) => m.code).join(', ') + '); legacy continues unchanged',
      preset: preset, engine: engine, role: role, modeId: modeId, lockedPreset: partial.lockedPreset, staged: stagedInfo,
      resolutionId: snapshot.resolutionId || null, configRevision: typeof snapshot.configurationRevision === 'number' ? snapshot.configurationRevision : stagedInfo.revision,
      projected: projectedOut, roleTargets: roleTargets, connection: connectionOut, legacy: legacy, comparisons: comparisons, mismatches: mismatches, errors: [] };
  } catch (e) { return fail('shadow-internal', 'shadow failed without interrupting legacy: ' + String((e && e.message) || e)); }
}
module.exports = { SHADOW_SCHEMA_VERSION: SHADOW_SCHEMA_VERSION, PRESET_TO_MODE: PRESET_TO_MODE, LOCKED_PRESETS: LOCKED_PRESETS, MODE_TO_ENGINE: MODE_TO_ENGINE, EXPECTED_EXECUTION_KIND: EXPECTED_EXECUTION_KIND, runShadowComparison: runShadowComparison };