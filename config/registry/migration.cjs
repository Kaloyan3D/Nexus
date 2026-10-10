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
 * no PowerShell, no network. Previews are secret-free by construction (they
 * carry digests, never file bytes); raw bytes live only behind the explicit
 * createLegacyBackup operation with restrictive file permissions. Writes go
 * ONLY to guarded isolated destinations: protected roots, symlink aliases,
 * path traversal, unexpected files, and unsafe overwrites are refused.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
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

const BACKUP_SCHEMA_VERSION = 1
const BACKUP_FILE_ALLOWLIST = Object.freeze(KNOWN_LEGACY_FILES.concat(['data/settings.yaml', 'data/custom-engineering-profile.json']))
const PREVIEW_FILE_NAME = 'migration-preview.json'
const RESTRICTED_FILE_MODE = 384
const RESTRICTED_DIR_MODE = 448

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

/** sha256 over raw file text (byte-exact integrity, not a JSON digest). */
function sha256Text(text) {
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
 * the full alias map, per-profile diffs, incompatibilities, a redacted
 * legacy digest (no file bytes, safe to persist and share), and a
 * deterministic plan hash. Rollback bytes come only from createLegacyBackup.
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
  const legacyDigest = describeLegacyFiles(installRoot)
  const preview = {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    detection,
    aliases: normalized.aliases,
    profileMeta: compat.profileMeta,
    proposedConfigs,
    diffs,
    incompatibilities: errors.slice(),
    legacyDigest,
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

/** Redacted structural digest of legacy inputs for public previews.
 *
 * Carries ZERO file bytes: presence flags, sha256 integrity evidence for
 * readable inputs, and the installed profile pointer. Secret-bearing
 * content (settings.yaml bodies, credentials) never enters a preview, so
 * preview artifacts are safe to write, log, and attach to diagnostics.
 * Raw bytes live exclusively behind the explicit createLegacyBackup op.
 */
function describeLegacyFiles(installRoot) {
  const files = {}
  for (const rel of KNOWN_LEGACY_FILES) {
    let raw = null
    try {
      raw = fs.readFileSync(path.join(installRoot, rel), 'utf8')
    } catch {
      raw = null
    }
    if (raw === null) {
      files[rel] = { present: false }
      continue
    }
    let version = null
    try {
      const doc = JSON.parse(raw)
      if (doc && typeof doc.schemaVersion === 'number') version = doc.schemaVersion
      else if (doc && typeof doc.version === 'number') version = doc.version
    } catch {
      version = null
    }
    files[rel] = { present: true, sha256: sha256Text(raw), schemaVersion: version, malformed: version === null }
  }
  let customRaw = null
  try {
    customRaw = fs.readFileSync(path.join(installRoot, 'data', 'custom-engineering-profile.json'), 'utf8')
  } catch {
    customRaw = null
  }
  return {
    files,
    settings: describeSettingsPointer(installRoot),
    customProfile: customRaw === null ? { present: false } : { present: true, sha256: sha256Text(customRaw) },
  }
}

/** Installed settings pointer without file bytes: presence plus the
 * engineering-profile value only. Credential-bearing content never enters
 * a preview beyond this single non-secret pointer.
 */
function describeSettingsPointer(installRoot) {
  let text = null
  try {
    text = fs.readFileSync(path.join(installRoot, 'data', 'settings.yaml'), 'utf8')
  } catch {
    return { present: false, engineeringProfile: null }
  }
  const newline = String.fromCharCode(10)
  const singleQuote = String.fromCharCode(39)
  const doubleQuote = String.fromCharCode(34)
  let profile = null
  const lines = text.split(newline)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.indexOf('engineering-profile:') === 0) {
      let value = trimmed.slice('engineering-profile:'.length).trim()
      if (value.length >= 2) {
        const first = value[0]
        const last = value[value.length - 1]
        if ((first === singleQuote || first === doubleQuote) && first === last) value = value.slice(1, -1)
      }
      const hashAt = value.indexOf(String.fromCharCode(35))
      if (hashAt !== -1) value = value.slice(0, hashAt).trim()
      profile = value
    }
  }
  return { present: true, engineeringProfile: profile }
}

/** Explicit operator backup holding raw file bytes for byte-exact rollback.
 *
 * Separate from previews by design: a backup may contain secret-bearing
 * content, so it must be stored with restrictive permissions, never logged,
 * and never attached to diagnostics. Restored files are written with mode
 * 0600 and hash-verified against the manifest. Absent files stay absent.
 */
function createLegacyBackup(installRoot) {
  if (!installRoot || typeof installRoot !== 'string' || installRoot === '') {
    return { backup: null, errors: ['migration-invalid-install-root'] }
  }
  const resolved = path.resolve(installRoot)
  const files = {}
  for (const rel of BACKUP_FILE_ALLOWLIST) {
    let raw = null
    let present = false
    try {
      raw = fs.readFileSync(path.join(resolved, rel), 'utf8')
      present = true
    } catch {
      present = false
    }
    if (present) {
      files[rel] = { present: true, sha256: sha256Text(raw), bytes: Buffer.byteLength(raw, 'utf8'), content: raw }
    } else {
      files[rel] = { present: false }
    }
  }
  return { backup: { schemaVersion: BACKUP_SCHEMA_VERSION, sourceRoot: resolved, files }, errors: [] }
}

function isWithinDir(child, parent) {
  return child === parent || child.startsWith(parent + path.sep)
}

function realpathOfNearestExisting(resolved) {
  let cur = resolved
  for (;;) {
    try {
      return { real: fs.realpathSync(cur), suffix: path.relative(cur, resolved) }
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return { real: null, suffix: null }
      cur = parent
    }
  }
}

/** Guard an isolated write destination. Refuses protected roots (and nested
 * paths inside them), symlink aliases resolving into protected locations,
 * destinations outside the caller's authorized roots (default: the OS temp
 * area unless options.allowNonTmp is explicitly true). Never writes; only
 * resolves and reports.
 */
function assertIsolatedTarget(targetRoot, options) {
  const opts = options || {}
  if (!targetRoot || typeof targetRoot !== 'string' || targetRoot === '') {
    return { resolved: null, errors: ['migration-invalid-target-root'] }
  }
  const resolved = path.resolve(targetRoot)
  const protectedRoots = []
  const pushRoot = (r) => {
    if (typeof r === 'string' && r !== '') {
      const p = path.resolve(r)
      if (protectedRoots.indexOf(p) === -1) protectedRoots.push(p)
    }
  }
  for (const r of opts.protectedRoots || []) pushRoot(r)
  for (const p of protectedRoots) {
    if (isWithinDir(resolved, p)) return { resolved: null, errors: ['migration-refuses-production-target:' + p] }
  }
  const near = realpathOfNearestExisting(resolved)
  if (near.real) {
    const effective = path.join(near.real, near.suffix)
    for (const p of protectedRoots) {
      if (isWithinDir(effective, p)) return { resolved: null, errors: ['migration-symlink-alias-refused:' + p] }
    }
  }
  if (Array.isArray(opts.authorizedRoots)) {
    const authorized = opts.authorizedRoots.map((r) => path.resolve(r))
    if (!authorized.some((a) => isWithinDir(resolved, a))) return { resolved: null, errors: ['migration-unauthorized-destination'] }
  } else if (opts.allowNonTmp !== true) {
    const tmp = path.resolve(os.tmpdir())
    if (!isWithinDir(resolved, tmp)) return { resolved: null, errors: ['migration-outside-isolated-tmp'] }
  }
  return { resolved, errors: [] }
}

function safeDestination(resolvedTarget, rel) {
  if (typeof rel !== 'string' || rel === '') return null
  if (path.isAbsolute(rel)) return null
  const norm = path.normalize(rel)
  if (norm.split(path.sep).indexOf('..') !== -1) return null
  if (BACKUP_FILE_ALLOWLIST.indexOf(norm) === -1 && norm !== PREVIEW_FILE_NAME) return null
  const dest = path.join(resolvedTarget, norm)
  if (!isWithinDir(dest, resolvedTarget)) return null
  return dest
}

/** Restore an explicit backup byte-exact into an isolated directory.
 *
 * Guards: the backup source root and any caller-protected roots are refused
 * (including symlink aliases resolving into them); file keys outside the
 * allowlist, absolute paths, and parent traversal are refused; existing files
 * are never overwritten unless options.overwrite is true; every restored file
 * is hash-verified and written with restrictive permissions. Absent files
 * stay absent. Returns { restored, errors }.
 */
function restoreLegacySource(backup, targetRoot, options) {
  const opts = options || {}
  if (!backup || typeof backup !== 'object' || backup.schemaVersion !== BACKUP_SCHEMA_VERSION || !backup.files || typeof backup.files !== 'object') {
    return { restored: false, errors: ['migration-invalid-legacy-source'] }
  }
  const protectedRoots = Array.isArray(opts.protectedRoots) ? opts.protectedRoots.slice() : []
  if (typeof backup.sourceRoot === 'string' && backup.sourceRoot !== '') protectedRoots.push(backup.sourceRoot)
  const gate = assertIsolatedTarget(targetRoot, { protectedRoots, authorizedRoots: opts.authorizedRoots, allowNonTmp: opts.allowNonTmp })
  if (gate.errors.length > 0) return { restored: false, errors: gate.errors }
  const overwrite = opts.overwrite === true
  try {
    for (const rel of Object.keys(backup.files)) {
      const dest = safeDestination(gate.resolved, rel)
      if (!dest) return { restored: false, errors: ['migration-unexpected-file:' + String(rel)] }
      const entry = backup.files[rel]
      if (!entry || entry.present !== true) continue
      if (typeof entry.content !== 'string' || typeof entry.sha256 !== 'string') {
        return { restored: false, errors: ['migration-backup-entry-invalid:' + rel] }
      }
      let existing = null
      try {
        existing = fs.readFileSync(dest, 'utf8')
      } catch {
        existing = null
      }
      if (existing !== null && existing !== entry.content && !overwrite) {
        return { restored: false, errors: ['migration-refuses-overwrite:' + rel] }
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: RESTRICTED_DIR_MODE })
      fs.writeFileSync(dest, entry.content, { encoding: 'utf8', mode: RESTRICTED_FILE_MODE })
      const written = fs.readFileSync(dest, 'utf8')
      if (sha256Text(written) !== entry.sha256) return { restored: false, errors: ['migration-restore-verify-failed:' + rel] }
    }
  } catch (err) {
    return { restored: false, errors: ['migration-restore-failed:' + String((err && err.message) || err)] }
  }
  return { restored: true, errors: [] }
}

/** Materialize a secret-free preview into an isolated directory for review.
 *
 * Previews carry no file bytes, but the destination guard still applies:
 * protected roots, symlink aliases, traversal, unexpected files, and unsafe
 * overwrites are refused. Returns { applied, errors }.
 */
function applyPlanToIsolatedRoot(preview, sourceRoot, targetRoot, options) {
  const opts = options || {}
  if (!preview || typeof preview !== 'object') return { applied: false, errors: ['migration-invalid-preview'] }
  const gate = assertIsolatedTarget(targetRoot, { protectedRoots: [sourceRoot], authorizedRoots: opts.authorizedRoots, allowNonTmp: opts.allowNonTmp })
  if (gate.errors.length > 0) return { applied: false, errors: gate.errors }
  const dest = safeDestination(gate.resolved, PREVIEW_FILE_NAME)
  if (!dest) return { applied: false, errors: ['migration-unexpected-file:' + PREVIEW_FILE_NAME] }
  try {
    let existing = null
    try {
      existing = fs.readFileSync(dest, 'utf8')
    } catch {
      existing = null
    }
    const body = JSON.stringify(preview, null, 2) + String.fromCharCode(10)
    if (existing !== null && existing !== body && opts.overwrite !== true) {
      return { applied: false, errors: ['migration-refuses-overwrite:' + PREVIEW_FILE_NAME] }
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, body, 'utf8')
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
  describeLegacyFiles,
  createLegacyBackup,
  restoreLegacySource,
  applyPlanToIsolatedRoot,
  verifyPlanIdempotent,
}
