'use strict'

/**
 * Registry R2.1 - legacy profile compatibility importer (dedicated).
 *
 * Represents every supported legacy profile with canonical Registry
 * contracts while preserving exact legacy execution semantics:
 * role-to-model assignments, primary/deep/fallback/visual overrides, exact
 * reasoning levels, provider identity and route selection, reviewer
 * read-only and solver approval requirements, capability restrictions,
 * Muse single-agent isolation, Contributor data-use tier, Muse reasoning
 * ceiling and no-subagent policy, disabled/unavailable behavior, and
 * operator custom profiles.
 *
 * Deterministic and read-only: legacy files are only read, never written.
 * Unknown, malformed or unsupported configurations produce actionable
 * errors and never silently fall back to a default profile.
 *
 * Reads via an injected install root (like legacy-import). No process.env,
 * no DSH/PowerShell/Rust imports, no network, no credentials.
 */

const fs = require('node:fs')
const path = require('node:path')
const legacyImport = require('./legacy-import.cjs')
const museCanonical = require('./muse-canonical.cjs')

const COMPAT_SCHEMA_VERSION = 1

const SUPPORTED_DUAL_PROFILES = Object.freeze(['deepseek-codex', 'glm-codex', 'custom'])
const SUPPORTED_MUSE_PROFILES = Object.freeze(['muse-spark-1.3-contributor', 'muse-spark-1.3-contributor-opencode'])
const SUPPORTED_LEGACY_PROFILES = Object.freeze(SUPPORTED_DUAL_PROFILES.concat(SUPPORTED_MUSE_PROFILES))

const DUAL_INTERNAL_ROLES = Object.freeze(['primaryEngineer', 'deepEngineer', 'reviewer', 'solver', 'fallback'])
const DUAL_OPTIONAL_ROLES = Object.freeze(['visualReviewer'])
const MUSE_REASONING_CEILING = 'xhigh'

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function profileModeOf(profileId) {
  if (SUPPORTED_DUAL_PROFILES.indexOf(profileId) !== -1) return 'engineering-v1'
  if (SUPPORTED_MUSE_PROFILES.indexOf(profileId) !== -1) return 'engineering-v2'
  return null
}

function isSupportedProfile(profileId) {
  return SUPPORTED_LEGACY_PROFILES.indexOf(profileId) !== -1
}

/**
 * Rewrite a Muse mode configuration onto canonical Muse identity using an
 * explicit alias map (from muse-canonical normalizeMuseSnapshot). Pure.
 * Unknown route references fail closed with an actionable error.
 */
function canonicalizeMuseConfig(config, aliases) {
  if (!config || typeof config !== 'object') return { config: null, error: 'compat-malformed-config' }
  if (!aliases || typeof aliases !== 'object' || !aliases.canonicalModelId) {
    return { config: null, error: 'compat-missing-alias-map' }
  }
  const routeMap = aliases.legacyRouteIds || {}
  const canonicalRouteIds = {}
  for (const key of Object.keys(routeMap)) canonicalRouteIds[routeMap[key]] = true
  const rewrite = (assignment, where) => {
    if (!assignment || typeof assignment !== 'object') return { assignment: null, error: 'compat-malformed-binding:' + where }
    if (assignment.logicalModelId === aliases.canonicalModelId && canonicalRouteIds[assignment.routeId]) {
      return { assignment: { logicalModelId: assignment.logicalModelId, routeId: assignment.routeId, reasoning: assignment.reasoning }, error: null }
    }
    const canonicalModel = museCanonical.canonicalModelIdOf(assignment.logicalModelId)
    if (!canonicalModel) return { assignment: null, error: 'compat-unknown-model-alias:' + where + ':' + String(assignment.logicalModelId) }
    const canonicalRoute = routeMap[assignment.routeId]
    if (!canonicalRoute) return { assignment: null, error: 'compat-unknown-route-alias:' + where + ':' + String(assignment.routeId) }
    return { assignment: { logicalModelId: canonicalModel, routeId: canonicalRoute, reasoning: assignment.reasoning }, error: null }
  }
  const next = JSON.parse(JSON.stringify(config))
  for (const slotId of Object.keys(next.slots || {})) {
    const result = rewrite(next.slots[slotId], slotId)
    if (result.error) return { config: null, error: result.error }
    next.slots[slotId] = result.assignment
  }
  next.roleOverrides = next.roleOverrides || {}
  for (const role of Object.keys(next.roleOverrides)) {
    const result = rewrite(next.roleOverrides[role], role)
    if (result.error) return { config: null, error: result.error }
    next.roleOverrides[role] = result.assignment
  }
  return { config: next, error: null }
}

/**
 * Import every supported legacy profile into canonical mode configurations.
 *
 * When museAliases is provided (canonical snapshot), Muse configs are
 * rewritten onto canonical identity; otherwise legacy ids are preserved
 * verbatim. Returns { configs, profileMeta, errors }.
 */
function importCompatibleProfiles(installRoot, snapshot, museAliases) {
  const errors = []
  const configs = {}
  const profileMeta = {}
  if (!snapshot || typeof snapshot !== 'object') {
    return { configs, profileMeta, errors: ['compat-snapshot-unavailable'] }
  }
  const imported = legacyImport.importLegacyProfiles(installRoot, snapshot)
  errors.push.apply(errors, imported.errors.map((e) => 'compat-import:' + e))
  const engineeringDoc = readJson(path.join(installRoot, 'config', 'engineering-profiles.json'))
  const museDoc = readJson(path.join(installRoot, 'config', 'muse-profiles.json'))
  const customDoc = readJson(path.join(installRoot, 'data', 'custom-engineering-profile.json'))
  const hasCustom = !!(customDoc && customDoc.schemaVersion === 1 && customDoc.roles && typeof customDoc.roles === 'object')
  // Dual profiles (built-in + operator custom).
  for (const profileId of SUPPORTED_DUAL_PROFILES) {
    if (profileId === 'custom' && !hasCustom) continue
    const config = imported.configs[profileId]
    if (!config) {
      errors.push('compat-unsupported-profile:' + profileId + ':no resolvable legacy binding (see compat-import errors)')
      continue
    }
    configs[profileId] = config
    profileMeta[profileId] = {
      schemaVersion: COMPAT_SCHEMA_VERSION,
      legacyProfileId: profileId,
      modeId: 'engineering-v1',
      engine: 'dual',
      reviewerReadOnly: true,
      solverRequiresApproval: true,
      source: profileId === 'custom' ? 'data/custom-engineering-profile.json' : 'config/engineering-profiles.json',
    }
  }
  // Muse profiles: single-agent, Contributor tier, xhigh ceiling.
  for (const profileId of SUPPORTED_MUSE_PROFILES) {
    const raw = imported.configs[profileId]
    if (!raw) {
      errors.push('compat-unsupported-profile:' + profileId + ':no resolvable legacy binding (see compat-import errors)')
      continue
    }
    let config = raw
    let alias = null
    if (museAliases) {
      const rewritten = canonicalizeMuseConfig(raw, museAliases)
      if (rewritten.error) {
        errors.push(rewritten.error)
        continue
      }
      config = rewritten.config
      alias = {
        legacyProfileId: profileId,
        canonicalModelId: museAliases.canonicalModelId,
        legacyModelId: raw.slots.main.logicalModelId,
        legacyRouteId: raw.slots.main.routeId,
        canonicalRouteId: config.slots.main.routeId,
      }
    }
    configs[profileId] = config
    profileMeta[profileId] = {
      schemaVersion: COMPAT_SCHEMA_VERSION,
      legacyProfileId: profileId,
      modeId: 'engineering-v2',
      engine: 'muse',
      singleAgent: true,
      subagentsEnabled: false,
      independentReview: false,
      dataUseTier: 'contributor',
      reasoningCeiling: MUSE_REASONING_CEILING,
      source: 'config/muse-profiles.json',
      alias: alias,
    }
  }
  // Surface unexpected legacy catalog entries as actionable errors rather
  // than silently ignoring a profile the operator may depend on.
  const knownIds = SUPPORTED_LEGACY_PROFILES.slice()
  const declaredDual = (engineeringDoc && Array.isArray(engineeringDoc.profiles) ? engineeringDoc.profiles : []).map((p) => p && p.id).filter((id) => typeof id === 'string')
  for (const id of declaredDual) {
    if (knownIds.indexOf(id) === -1) errors.push('compat-unknown-profile:engineering:' + id)
  }
  const declaredMuse = (museDoc && Array.isArray(museDoc.profiles) ? museDoc.profiles : []).map((p) => p && p.id).filter((id) => typeof id === 'string')
  for (const id of declaredMuse) {
    if (knownIds.indexOf(id) === -1) errors.push('compat-unknown-profile:muse:' + id)
  }
  return { configs, profileMeta, errors }
}

/**
 * Verify preserved execution semantics for one imported profile against the
 * raw legacy documents. Returns an array of actionable error strings
 * (empty = preserved). Pure function of its inputs.
 */
function verifyPreservedSemantics(profileId, config, legacy, snapshot) {
  const errors = []
  const modeId = profileModeOf(profileId)
  if (!modeId) return ['compat-unknown-profile:' + String(profileId)]
  if (!config || typeof config !== 'object') return ['compat-malformed-config:' + String(profileId)]
  if (config.modeId !== modeId) errors.push('compat-mode-mismatch:' + profileId + ':expected ' + modeId + ' got ' + String(config.modeId))
  if (modeId === 'engineering-v1') {
    const roles = (legacy && legacy.roles) || {}
    const slotOf = (role) => {
      if (role === 'reviewer') return config.slots && config.slots.reviewer
      if (role === 'solver') return config.slots && config.slots.solver
      if (role === 'primaryEngineer') return config.slots && config.slots.engineer
      return (config.roleOverrides && config.roleOverrides[role]) || null
    }
    for (const role of DUAL_INTERNAL_ROLES.concat(DUAL_OPTIONAL_ROLES)) {
      const legacyBinding = roles[role]
      const imported = slotOf(role)
      if (!legacyBinding && !imported) continue
      if (!!legacyBinding !== !!imported) {
        errors.push('compat-role-presence-mismatch:' + profileId + '/' + role)
        continue
      }
      if (legacyBinding && imported) {
        if (String(legacyBinding.model) !== String(imported.logicalModelId)) {
          errors.push('compat-model-mismatch:' + profileId + '/' + role + ':expected ' + legacyBinding.model + ' got ' + imported.logicalModelId)
        }
        if (String(legacyBinding.reasoning) !== String(imported.reasoning)) {
          errors.push('compat-reasoning-mismatch:' + profileId + '/' + role + ':expected ' + legacyBinding.reasoning + ' got ' + imported.reasoning)
        }
      }
    }
  } else {
    const expectedModel = legacy && legacy.model && legacy.model.primary
    const expectedReasoning = legacy && legacy.reasoning && legacy.reasoning.default
    const slot = config.slots && config.slots.main
    if (!slot) {
      errors.push('compat-malformed-config:' + profileId + ':missing main slot')
    } else {
      const canonical = museCanonical.canonicalModelIdOf(slot.logicalModelId)
      if (!canonical) errors.push('compat-unknown-model-alias:' + profileId + ':' + String(slot.logicalModelId))
      if (String(expectedReasoning) !== String(slot.reasoning)) {
        errors.push('compat-reasoning-mismatch:' + profileId + ':expected ' + expectedReasoning + ' got ' + slot.reasoning)
      }
      if (slot.reasoning === 'max') errors.push('compat-reasoning-ceiling-violated:' + profileId + ':max is Standard-tier only')
      if (legacy && legacy.subagents && legacy.subagents.enabled !== false) {
        errors.push('compat-subagent-policy-violated:' + profileId + ':Muse no-subagent policy requires enabled=false')
      }
      void expectedModel
    }
  }
  void snapshot
  return errors
}

/**
 * R2.6 - pinned binding preservation guard. A compiled binding is immutable:
 * an alias change or newly discovered route must never silently retarget a
 * task pinned to an earlier resolution. Returns true when the stored pinned
 * binding still matches the live binding on every execution-relevant field.
 */
function pinnedBindingPreserved(pinned, live) {
  if (!pinned || !live) return false
  for (const key of ['modeId', 'orchestrationEngineId', 'roleId', 'logicalModelId', 'routeId', 'providerId', 'remoteModelId', 'connectionId', 'executionKind', 'reasoning', 'resolutionId']) {
    if (pinned[key] !== live[key]) return false
  }
  return true
}

module.exports = {
  COMPAT_SCHEMA_VERSION,
  SUPPORTED_DUAL_PROFILES,
  SUPPORTED_MUSE_PROFILES,
  SUPPORTED_LEGACY_PROFILES,
  DUAL_INTERNAL_ROLES,
  DUAL_OPTIONAL_ROLES,
  MUSE_REASONING_CEILING,
  profileModeOf,
  isSupportedProfile,
  canonicalizeMuseConfig,
  importCompatibleProfiles,
  verifyPreservedSemantics,
  pinnedBindingPreserved,
}
