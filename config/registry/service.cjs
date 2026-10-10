'use strict'

/**
 * Registry R3 — host-independent Registry service.
 *
 * The single Nexus-owned configuration authority for the R3 UI. Pure
 * orchestration over Registry Core (schemas / resolver / legacy-import /
 * muse-canonical / profile-compat) plus the file-backed config-store. Takes
 * explicit installRoot + dataRoot; never reads process.env, never imports
 * DSH, PowerShell, network or session state. The host adapter
 * (ui/nexus-controller/lib/registry.cjs) adds transport concerns (HTTP,
 * payload caps, same-origin checks); this module owns canonical logic only.
 *
 * Operations:
 *
 * - listModes() — ModeDefinitions with saved-revision + executability.
 * - getSnapshot() — canonical (Muse-unified) snapshot or actionable errors.
 * - getModeConfiguration(modeId, { adopt }) — saved config, else a
 *   reviewable legacy-adoption preview (persisted:false). Never auto-saves.
 * - listEligible(modeId, slotId) / listIneligible(modeId, slotId) — resolver
 *   data enriched for display (model/provider/reasoning/connection/capacity).
 * - validate(config) — authoritative error list (schema + compile).
 * - compilePreview(config) — non-secret compiled snapshot or errors.
 * - save(modeId, config, expectedRevision, { source, adoptedFrom }) —
 *   validate + compile + atomic persisted write.
 */

const legacyImport = require('./legacy-import.cjs')
const museCanonical = require('./muse-canonical.cjs')
const profileCompat = require('./profile-compat.cjs')
const resolver = require('./resolver.cjs')
const schemas = require('./schemas.cjs')
const configStore = require('./config-store.cjs')

const SERVICE_SCHEMA_VERSION = 1
const SUPPORTED_MODES = ['engineering-v1', 'engineering-v2', 'engineering-v3']

// Default legacy profile seeding each mode preview. Alternatives remain
// adoptable via getModeConfiguration(modeId, { adopt: <profileId> }).
const DEFAULT_ADOPT_PROFILE = {
  'engineering-v1': 'deepseek-codex',
  'engineering-v2': 'muse-spark-1.3-contributor',
}
const ADOPTABLE_PROFILES = {
  'engineering-v1': ['deepseek-codex', 'glm-codex', 'custom'],
  'engineering-v2': ['muse-spark-1.3-contributor', 'muse-spark-1.3-contributor-opencode'],
}

function err(code, p, message) {
  return { code, path: p, message }
}

function createService(options) {
  const installRoot = options && options.installRoot ? String(options.installRoot) : ''
  const dataRoot = options && options.dataRoot ? String(options.dataRoot) : ''
  const nowUtc = options && typeof options.nowUtc === 'function' ? options.nowUtc : () => new Date().toISOString()
  const fsHooks = options && options.fsHooks ? options.fsHooks : undefined
  if (installRoot === '' || dataRoot === '') throw new Error('registry-service: installRoot and dataRoot are required')

  function buildCanonical() {
    const built = legacyImport.buildRegistrySnapshot(installRoot)
    if (!built.snapshot) {
      return { snapshot: null, aliases: null, errors: built.errors.map((e) => err('snapshot-unavailable', 'registry', String(e))) }
    }
    const normalized = museCanonical.normalizeMuseSnapshot(built.snapshot)
    if (!normalized.snapshot) {
      return { snapshot: null, aliases: null, errors: built.errors.map((e) => err('snapshot-note', 'registry', String(e))).concat(normalized.errors.map((e) => err('snapshot-unavailable', 'registry', String(e)))) }
    }
    return { snapshot: normalized.snapshot, aliases: normalized.aliases, errors: [] }
  }

  function modeById(snapshot, modeId) {
    for (const mode of (snapshot && snapshot.modes) || []) {
      if (mode && mode.id === modeId) return mode
    }
    return null
  }

  function executableOf(mode) {
    if (!mode) return { executable: false, reason: 'unknown-mode' }
    if (mode.runnable === false || mode.status === 'planned') {
      return { executable: false, reason: 'mode-not-runnable: ' + mode.id + ' is planned/preview and cannot be executed' }
    }
    return { executable: true, reason: null }
  }

  function listModes() {
    const built = buildCanonical()
    const store = configStore.loadStore(dataRoot, fsHooks)
    // Fall back to the on-disk manifests when the snapshot cannot build, so
    // the selector still renders honestly (all non-executable) instead of
    // vanishing. Manifests are git-managed Registry-owned data.
    let defs = built.snapshot ? built.snapshot.modes : []
    if (defs.length === 0) {
      try {
        const fs = require('node:fs')
        const p = require('node:path')
        defs = []
        for (const f of ['engineering-v1.json', 'engineering-v2.json', 'engineering-v3.json']) {
          try { defs.push(JSON.parse(fs.readFileSync(p.join(installRoot, 'config', 'registry', 'modes', f), 'utf8'))) } catch { /* skip; reported below */ }
        }
      } catch { /* handled below */ }
    }
    const out = []
    for (const modeId of SUPPORTED_MODES) {
      const mode = defs.find((m) => m && m.id === modeId) || null
      if (!mode) {
        out.push({ id: modeId, present: false, executable: false, reason: 'mode-definition-missing', savedRevision: null, savedValid: false, savedErrors: [] })
        continue
      }
      const exec = executableOf(mode)
      const entry = store.store ? store.store.modes[modeId] || null : null
      let savedValid = false
      let savedErrors = []
      if (entry && built.snapshot) {
        savedErrors = resolver.validateModeConfig(entry.config, built.snapshot)
        savedValid = savedErrors.length === 0
      } else if (!store.store) {
        savedErrors = store.errors
      }
      out.push({
        id: mode.id,
        present: true,
        displayName: mode.displayName,
        status: mode.status,
        selectable: mode.selectable !== false,
        runnable: mode.runnable !== false,
        executable: exec.executable,
        executableReason: exec.reason,
        orchestrationEngineId: mode.orchestrationEngineId,
        slots: (mode.slots || []).map((s) => ({ id: s.id, label: s.label, required: s.required === true, internalRoles: (s.internalRoles || []).slice(), requirements: Object.assign({}, s.requirements || {}) })),
        internalRoles: (mode.internalRoles || []).slice(),
        optionalCapabilities: (mode.optionalCapabilities || []).slice(),
        savedRevision: entry ? entry.revision : null,
        savedValid,
        savedErrors,
        persisted: !!entry,
      })
    }
    const errors = built.errors.concat(store.store ? [] : store.errors)
    return { modes: out, errors }
  }

  function compatConfigs(canonical) {
    // Canonical Muse identity when aliases exist; legacy ids otherwise.
    const imported = profileCompat.importCompatibleProfiles(installRoot, legacyImport.buildRegistrySnapshot(installRoot).snapshot || canonical.snapshot, canonical.aliases || undefined)
    return imported
  }

  function previewFor(modeId, adoptProfileId) {
    const canonical = buildCanonical()
    if (!canonical.snapshot) return { preview: null, errors: canonical.errors }
    const compat = compatConfigs(canonical)
    if (modeId === 'engineering-v3') {
      return { preview: { modeId, persisted: false, runnable: false, reason: 'mode-not-runnable: engineering-v3 is planned/preview; orchestration is not implemented in R3', slotsManifest: (modeById(canonical.snapshot, modeId) || {}).slots || [] }, errors: [] }
    }
    const adoptable = ADOPTABLE_PROFILES[modeId] || []
    const wanted = adoptProfileId || DEFAULT_ADOPT_PROFILE[modeId] || null
    if (wanted && adoptable.indexOf(wanted) === -1) {
      return { preview: null, errors: [err('unknown-profile', 'adopt', 'profile ' + wanted + ' cannot seed mode ' + modeId)] }
    }
    // Prefer the canonical compat config; fall back to the raw legacy import
    // (legacy ids) when canonical aliases are unavailable.
    let config = (compat.configs && compat.configs[wanted]) || null
    let canonicalIds = true
    if (!config) {
      const raw = legacyImport.importLegacyProfiles(installRoot, legacyImport.buildRegistrySnapshot(installRoot).snapshot || canonical.snapshot)
      config = raw.configs[wanted] || null
      canonicalIds = false
    }
    if (!config) {
      return { preview: null, errors: [err('legacy-profile-unavailable', 'adopt', 'legacy profile ' + wanted + ' cannot be imported here')] }
    }
    const validation = resolver.validateModeConfig(config, canonical.snapshot)
    return { preview: { modeId, persisted: false, source: 'legacy-preview', adoptedFrom: wanted, canonicalIds, config, validation, adoptable }, errors: [] }
  }

  function getModeConfiguration(modeId, opts) {
    if (SUPPORTED_MODES.indexOf(modeId) === -1) {
      return { result: null, errors: [err('unknown-mode', 'modeId', 'unknown mode: ' + modeId)] }
    }
    const loaded = configStore.loadStore(dataRoot, fsHooks)
    if (!loaded.store) return { result: null, errors: loaded.errors }
    const entry = loaded.store.modes[modeId] || null
    if (entry) {
      const canonical = buildCanonical()
      const validation = canonical.snapshot ? resolver.validateModeConfig(entry.config, canonical.snapshot) : canonical.errors
      return { result: { modeId, persisted: true, revision: entry.revision, source: entry.source, adoptedFrom: entry.adoptedFrom, savedAtUtc: entry.savedAtUtc, config: entry.config, validation }, errors: [] }
    }
    const adopt = opts && opts.adopt ? String(opts.adopt) : null
    const previewed = previewFor(modeId, adopt)
    if (previewed.preview) return { result: previewed.preview, errors: [] }
    return { result: null, errors: previewed.errors }
  }

  function snapshotOrErrors() {
    const canonical = buildCanonical()
    if (!canonical.snapshot) return { snapshot: null, errors: canonical.errors }
    return { snapshot: canonical.snapshot, errors: [] }
  }

  function enrichRoute(snapshot, route) {
    const models = new Map((snapshot.models || []).map((m) => [m && m.id, m]))
    const providers = new Map((snapshot.providers || []).map((p) => [p && p.id, p]))
    const connections = new Map((snapshot.connections || []).map((c) => [c && c.id, c]))
    const model = models.get(route.logicalModelId) || null
    const provider = providers.get(route.providerId) || null
    const connection = route.connectionId ? connections.get(route.connectionId) || null : null
    return {
      routeId: route.id,
      providerId: route.providerId,
      providerName: provider ? (provider.name || provider.id) : route.providerId,
      logicalModelId: route.logicalModelId,
      modelDisplayName: model ? (model.displayName || model.id) : route.logicalModelId,
      checkpoint: model ? model.checkpoint : null,
      reasoningLevels: (route.reasoningLevels || []).slice(),
      availability: route.availability,
      enabled: route.enabled !== false,
      connectionId: route.connectionId || null,
      connectionStatus: connection ? connection.status : 'missing',
      connectionKind: connection ? connection.connectionKind : null,
      dataUseTier: model ? model.dataUseTier || null : null,
      contextWindow: model && model.contextWindow !== undefined ? { value: model.contextWindow, provenance: model.capacityProvenance || 'declared' } : { value: null, provenance: 'unknown' },
      maxOutputTokens: model && model.maxOutputTokens !== undefined ? { value: model.maxOutputTokens, provenance: model.capacityProvenance || 'declared' } : { value: null, provenance: 'unknown' },
      capabilities: model ? Object.assign({}, model.capabilities) : {},
      remoteModelId: route.remoteModelId,
      executionKind: route.executionKind,
      accessType: route.accessType,
      transport: (route.compatibility && route.compatibility.transport) || 'unknown',
    }
  }

  function listEligible(modeId, slotId) {
    const built = snapshotOrErrors()
    if (!built.snapshot) return { routes: [], errors: built.errors }
    const mode = modeById(built.snapshot, modeId)
    if (!mode) return { routes: [], errors: [err('unknown-mode', 'modeId', 'unknown mode: ' + modeId)] }
    if (!mode.slots.some((s) => s && s.id === slotId)) return { routes: [], errors: [err('unknown-slot', 'slotId', 'slot ' + slotId + ' is not declared by mode ' + modeId)] }
    const routes = resolver.listEligibleRoutes(modeId, slotId, built.snapshot)
    return { routes: routes.map((r) => enrichRoute(built.snapshot, r)), errors: [] }
  }

  function listIneligible(modeId, slotId) {
    // Explain every non-eligible route for the slot: same iteration the
    // resolver performs, first failing gate reported as the reason.
    const built = snapshotOrErrors()
    if (!built.snapshot) return { routes: [], errors: built.errors }
    const mode = modeById(built.snapshot, modeId)
    if (!mode) return { routes: [], errors: [err('unknown-mode', 'modeId', 'unknown mode: ' + modeId)] }
    const slot = mode.slots.find((s) => s && s.id === slotId)
    if (!slot) return { routes: [], errors: [err('unknown-slot', 'slotId', 'slot ' + slotId + ' is not declared by mode ' + modeId)] }
    const eligibleIds = new Set(resolver.listEligibleRoutes(modeId, slotId, built.snapshot).map((r) => r.id))
    const out = []
    for (const route of built.snapshot.routes || []) {
      if (!route || eligibleIds.has(route.id)) continue
      const models = new Map((built.snapshot.models || []).map((m) => [m && m.id, m]))
      const model = models.get(route.logicalModelId) || null
      let reason = null
      const gate = resolver.routeEligibility(route)
      if (gate) reason = gate.code + ': ' + gate.message
      else if (!model || model.enabled === false) reason = 'model-disabled: logical model ' + route.logicalModelId + ' is disabled or missing'
      if (!reason) {
        // Capability/engine/connection gates share the resolver verdict; mark
        // the route unavailable for this slot without inventing a new code.
        reason = 'slot-ineligible: route ' + route.id + ' does not satisfy slot ' + slotId + ' requirements'
      }
      out.push(Object.assign(enrichRoute(built.snapshot, route), { ineligibleReason: reason }))
    }
    return { routes: out, errors: [] }
  }

  function validate(config) {
    const built = snapshotOrErrors()
    if (!built.snapshot) return { errors: built.errors }
    return { errors: resolver.validateModeConfig(config, built.snapshot) }
  }

  function compilePreview(config) {
    const built = snapshotOrErrors()
    if (!built.snapshot) return { ok: false, errors: built.errors }
    const result = resolver.compileModeConfig(config, built.snapshot)
    if (!result.ok) return result
    // Snapshots are non-secret by construction (opaque connection ids only);
    // assert before returning so a future field can never leak credentials.
    const probe = JSON.stringify(result.snapshot)
    if (/sk-(live|proj)-|xox[bap]-|ghp_|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(probe)) {
      return { ok: false, errors: [err('secret-material-rejected', 'resolved', 'compiled preview contains secret-shaped material and is withheld')] }
    }
    return result
  }

  function save(modeId, config, expectedRevision, opts) {
    if (SUPPORTED_MODES.indexOf(modeId) === -1) {
      return { ok: false, errors: [err('unknown-mode', 'modeId', 'unknown mode: ' + modeId)] }
    }
    if (!config || config.modeId !== modeId) {
      return { ok: false, errors: [err('mode-mismatch', 'modeConfiguration.modeId', 'config modeId does not match target mode ' + modeId)] }
    }
    const compiled = compilePreview(config)
    if (!compiled.ok) return { ok: false, errors: compiled.errors }
    const stored = configStore.saveModeConfig(dataRoot, modeId, config, expectedRevision, {
      fsHooks,
      nowUtc,
      source: (opts && opts.source) || 'operator-save',
      adoptedFrom: opts && Object.prototype.hasOwnProperty.call(opts, 'adoptedFrom') ? opts.adoptedFrom : null,
    })
    if (!stored.ok) return stored
    return { ok: true, revision: stored.revision, resolutionId: compiled.snapshot.resolutionId }
  }

  return {
    schemaVersion: SERVICE_SCHEMA_VERSION,
    installRoot,
    dataRoot,
    listModes,
    getModeConfiguration,
    listEligible,
    listIneligible,
    validate,
    compilePreview,
    save,
    buildCanonical,
  }
}

module.exports = { createService, SUPPORTED_MODES, DEFAULT_ADOPT_PROFILE, ADOPTABLE_PROFILES }
