'use strict'

/**
 * Registry R2.5 - reversible offline migration planning interface.
 *
 * Minimal dry-run surface for future Registry adoption. Capabilities:
 * detect supported legacy formats, propose a deterministic canonical
 * configuration, record explicit old-ID to new-ID aliases, report
 * incompatibilities without destructive changes, provide a
 * machine-readable preview/diff, preserve enough legacy source for
 * lossless restoration/rollback, stay idempotent across repeated imports,
 * and support injected install roots plus isolated temporary fixtures.
 *
 * R2 performs NO production persistence cutover. Planning operates on
 * fixtures, in-memory data, or explicitly isolated temporary copies. It
 * never overwrites operator-edited settings.yaml, custom profiles,
 * provider configurations, credentials, routing ledgers, or session data.
 *
 * Reads via injected install roots only. No process.env, no DSH imports,
 * no PowerShell, no network. Writes ONLY to caller-provided isolated
 * directories (applyPlanToIsolatedRoot refuses to target the source root).
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const legacyImport = require('./legacy-import.cjs')
const profileCompat = require('./profile-compat.cjs')
const museCanonical = require('./muse-canonical.cjs')

const MIGRATION_SCHEMA_VERSION = 1

const KNOWN_LEGACY_FILES = Object.freeze([
  'config/nexus-profiles.json',
  'config/engineering-profiles.json',
  'config/muse-profiles.json',
  'config/model-registry.json',
  'config/routing-policy.json',
])

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function sha256Of(value) {
  const text = JSON.stringify(value)
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Detect which supported legacy configuration formats are present. */
function detectLegacyFormats(installRoot) {
  const formats = []
  const missing = []
  const malformed = []
  for (const rel of KNOWN_LEGACY_FILES) {
    const doc = readJson(path.join(installRoot, rel))
    if (doc === null) {
      missing.push(rel)
      continue
    }
    const version = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : (typeof doc.version === 'number' ? doc.version : null)
    if (version === null) malformed.push(rel + ':missing-schemaVersion')
    else formats.push({ file: rel, schemaVersion: version })
  }
  let settingsProfile = null
  let settingsPresent = false
  try {
    const text = fs.readFileSync(path.join(installRoot, 'data', 'settings.yaml'), 'utf8')
    settingsPresent = true
    const match = /^engineering-profile:\s*([^\s#\r\n]+)/m.exec(text)
    if (match) settingsProfile = match[1].trim().replace(/^['\"]|['\"]$/g, '')
  } catch {
    settingsPresent = false
  }
  const customDoc = readJson(path.join(installRoot, 'data', 'custom-engineering-profile.json'))
  const hasCustom = !!(customDoc && customDoc.schemaVersion === 1 && customDoc.roles && typeof customDoc.roles === 'object')
  return { schemaVersion: MIGRATION_SCHEMA_VERSION, formats, missing, malformed, settingsProfile, settingsPresent, hasCustom }
}

/**
 * Produce a deterministic proposed canonical configuration (dry run).
 * Returns { preview, errors }: preview is machine-readable and contains
 * the full alias map, per-profile diffs, incompatibilities, the legacy
 * source snapshot for rollback, and a deterministic plan hash.
 */
function planMigration(installRoot) {
  const detection = detectLegacyFormats(installRoot)
  const built = legacyImport.buildRegistrySnapshot(installRoot)
  const errors = built.errors.slice()
  if (!built.snapshot) {
    return { preview: null, errors: errors.concat(['migration-snapshot-unavailable']) }
  }
  const normalized = museCanonical.normalizeMuseSnapshot(built.snapshot)
  if (!normalized.snapshot) {
    return { preview: null, errors: errors.concat(normalized.errors.map((e) => 'migration:' + e)) }
  }
  const compat = profileCompat.importCompatibleProfiles(installRoot, built.snapshot, normalized.aliases)
  errors.push.apply(errors, compat.errors)
  // Legacy (pre-canonical) configs for the machine-readable before/after
  // diff; the proposed state carries canonical Muse identity.
  const legacyRaw = legacyImport.importLegacyProfiles(installRoot, built.snapshot);
  const proposedConfigs = {}
  const diffs = []
  for (const profileId of Object.keys(compat.configs)) {
    const canonical = compat.configs[profileId]
    if (profileCompat.profileModeOf(profileId) === 'engineering-v2') {
      const before = legacyRaw.configs[profileId] || null
      proposedConfigs[profileId] = canonical
      diffs.push({ profileId, modeId: 'engineering-v2', changes: museDiffOf(before, canonical) })
    } else {
      proposedConfigs[profileId] = canonical
      diffs.push({ profileId, modeId: 'engineering-v1', changes: dualDiffOf(profileId, canonical) })
    }
  }
  const legacySource = captureLegacySource(installRoot)
  const preview = {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    detection,
    aliases: normalized.aliases,
    profileMeta: compat.profileMeta,
    proposedConfigs,
    diffs,
    incompatibilities: errors.slice(),
    legacySource,
    planHash: '',
  }
  preview.planHash = sha256Of({ aliases: preview.aliases, proposedConfigs, diffs, legacyProfileIds: Object.keys(compat.profileMeta).sort() })
  return { preview, errors }
}

function museDiffOf(legacyConfig, canonicalConfig) {
  const changes = []
  const after = (canonicalConfig && canonicalConfig.slots && canonicalConfig.slots.main) || {}
  if (!legacyConfig || !legacyConfig.slots || !legacyConfig.slots.main) {
    changes.push({ field: 'slots.main', before: null, after, kind: 'unresolvable-legacy' })
    return changes
  }
  const before = legacyConfig.slots.main
  if (before.logicalModelId !== after.logicalModelId) {
    changes.push({ field: 'slots.main.logicalModelId', before: before.logicalModelId, after: after.logicalModelId, kind: 'canonical-id-change' })
  }
  if (before.routeId !== after.routeId) {
    changes.push({ field: 'slots.main.routeId', before: before.routeId, after: after.routeId, kind: 'canonical-id-change' })
  }
  if (before.reasoning !== after.reasoning) {
    changes.push({ field: 'slots.main.reasoning', before: before.reasoning, after: after.reasoning, kind: 'execution-target-change' })
  }
  return changes
}

function dualDiffOf(profileId, config) {
  const changes = []
  for (const slotId of Object.keys((config && config.slots) || {})) {
    const slot = config.slots[slotId]
    changes.push({ field: 'slots.' + slotId, before: null, after: { logicalModelId: slot.logicalModelId, routeId: slot.routeId, reasoning: slot.reasoning }, kind: 'adopted-verbatim' })
  }
  void profileId
  return changes
}

/** Capture enough legacy source for lossless restoration/rollback. */
function captureLegacySource(installRoot) {
  const files = {}
  for (const rel of KNOWN_LEGACY_FILES) {
    const doc = readJson(path.join(installRoot, rel))
    files[rel] = doc === null ? null : doc
  }
  let settingsYaml = null
  try {
    settingsYaml = fs.readFileSync(path.join(installRoot, 'data', 'settings.yaml'), 'utf8')
  } catch {
    settingsYaml = null
  }
  const customDoc = readJson(path.join(installRoot, 'data', 'custom-engineering-profile.json'))
  return { files, settingsYaml, customProfile: customDoc === null ? null : customDoc }
}

/**
 * Restore a captured legacy source into an isolated directory (rollback
 * demonstration). Never touches the source install root. Returns { restored, errors }.
 */
function restoreLegacySource(legacySource, targetRoot) {
  const errors = []
  if (!legacySource || typeof legacySource !== 'object') return { restored: false, errors: ['migration-invalid-legacy-source'] }
  if (!targetRoot || typeof targetRoot !== 'string' || targetRoot === '') {
    return { restored: false, errors: ['migration-invalid-target-root'] }
  }
  try {
    for (const rel of Object.keys(legacySource.files || {})) {
      const doc = legacySource.files[rel]
      if (doc === null || doc === undefined) continue
      const dest = path.join(targetRoot, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    }
    if (typeof legacySource.settingsYaml === 'string') {
      const dest = path.join(targetRoot, 'data', 'settings.yaml')
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, legacySource.settingsYaml, 'utf8')
    }
    if (legacySource.customProfile !== null && legacySource.customProfile !== undefined) {
      const dest = path.join(targetRoot, 'data', 'custom-engineering-profile.json')
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, JSON.stringify(legacySource.customProfile, null, 2) + '\n', 'utf8')
    }
  } catch (err) {
    return { restored: false, errors: ['migration-restore-failed:' + String((err && err.message) || err)] }
  }
  return { restored: true, errors }
}

/**
 * Materialize a migration preview into an ISOLATED directory for review.
 * Refuses to target the source install root (production cutover guard).
 */
function applyPlanToIsolatedRoot(preview, sourceRoot, targetRoot) {
  if (!preview || typeof preview !== 'object') return { applied: false, errors: ['migration-invalid-preview'] }
  if (!targetRoot || typeof targetRoot !== 'string' || targetRoot === '') {
    return { applied: false, errors: ['migration-invalid-target-root'] }
  }
  const resolvedSource = path.resolve(sourceRoot || '')
  const resolvedTarget = path.resolve(targetRoot)
  if (resolvedTarget === resolvedSource) {
    return { applied: false, errors: ['migration-refuses-production-target:isolated copies only'] }
  }
  try {
    fs.mkdirSync(resolvedTarget, { recursive: true })
    fs.writeFileSync(path.join(resolvedTarget, 'migration-preview.json'), JSON.stringify(preview, null, 2) + '\n', 'utf8')
  } catch (err) {
    return { applied: false, errors: ['migration-apply-failed:' + String((err && err.message) || err)] }
  }
  return { applied: true, errors: [] }
}

/** Re-run planning and verify byte-identical determinism (idempotency). */
function verifyPlanIdempotent(installRoot) {
  const first = planMigration(installRoot)
  const second = planMigration(installRoot)
  if (!first.preview || !second.preview) {
    return { idempotent: false, errors: ['migration-plan-unavailable'] }
  }
  const a = JSON.stringify(first.preview)
  const b = JSON.stringify(second.preview)
  if (a !== b) return { idempotent: false, errors: ['migration-not-idempotent'] }
  return { idempotent: true, errors: [] }
}

module.exports = {
  MIGRATION_SCHEMA_VERSION,
  KNOWN_LEGACY_FILES,
  detectLegacyFormats,
  planMigration,
  captureLegacySource,
  restoreLegacySource,
  applyPlanToIsolatedRoot,
  verifyPlanIdempotent,
}
