'use strict'

/**
 * Registry R2.3 - DSH anti-corruption adapter (adapter-private).
 *
 * All DSH-specific identifiers live HERE and nowhere else: installed legacy
 * DSH provider keys, internal agent-preset mapping, legacy target shape,
 * and legacy alias tables. Registry Core (schemas, resolver, canonical
 * snapshots) never imports this module; the dependency points from this
 * volatile adapter toward the stable Core, never the reverse.
 *
 * Pure and testable offline: no DSH module imports, no PowerShell, no
 * session initialization, no writes to settings.yaml, no live preset
 * mutation, no inference or network access, no routing decisions, and no
 * credential or token material (credential references are opaque).
 */

const ADAPTER_SCHEMA_VERSION = 1

// Canonical providerId -> installed legacy DSH provider key.
// Today the installed keys equal the canonical ids; the map stays explicit
// so a future key rename cannot silently retarget execution.
const PROVIDER_TO_DSH_KEY = Object.freeze({
  'flash-max-direct': 'flash-max-direct',
  'flash-high-direct': 'flash-high-direct',
  'deepseek-pro-direct': 'deepseek-pro-direct',
  'sol-local': 'sol-local',
  'zai-direct': 'zai-direct',
  'deepseek-vision-direct': 'deepseek-vision-direct',
  'meta-model-api': 'meta-model-api',
  'opencode-go': 'opencode-go',
})

// Canonical modeId -> applicable legacy internal preset mapping.
// Presets are DSH-internal infrastructure, never user-facing mode ids.
const MODE_TO_DSH_PRESET = Object.freeze({
  'engineering-v1': 'aih-engineering',
  'engineering-v2': 'aih-muse',
})

// Locked DSH preset -> pinned legacy profile (informational; the adapter
// never weakens the lock, it only reports it).
const LOCKED_DSH_PRESETS = Object.freeze({
  'aih-deepseek': Object.freeze({ profileId: 'deepseek-codex', modeId: 'engineering-v1' }),
})

// Legacy profile/model aliases -> canonical Registry identities.
const LEGACY_PROFILE_TO_MODE = Object.freeze({
  'deepseek-codex': 'engineering-v1',
  'glm-codex': 'engineering-v1',
  'custom': 'engineering-v1',
  'muse-spark-1.3-contributor': 'engineering-v2',
  'muse-spark-1.3-contributor-opencode': 'engineering-v2',
})

function dshProviderKeyOf(providerId) {
  if (typeof providerId !== 'string' || providerId === '') return null
  const mapped = PROVIDER_TO_DSH_KEY[providerId]
  return typeof mapped === 'string' ? mapped : null
}

function dshPresetOfMode(modeId) {
  if (typeof modeId !== 'string' || modeId === '') return null
  const mapped = MODE_TO_DSH_PRESET[modeId]
  return typeof mapped === 'string' ? mapped : null
}

function canonicalModeOfLegacyProfile(profileId) {
  if (typeof profileId !== 'string' || profileId === '') return null
  const mapped = LEGACY_PROFILE_TO_MODE[profileId]
  return typeof mapped === 'string' ? mapped : null
}

function isLockedDshPreset(presetId) {
  return typeof presetId === 'string' && Object.prototype.hasOwnProperty.call(LOCKED_DSH_PRESETS, presetId)
}

/**
 * Project a canonical RuntimeModelBinding onto the legacy target
 * representation ({ modelId, model, provider, reasoning, dataUseTier }).
 * Pure: returns a fresh object, never mutates the binding, never decides
 * routing. Returns { target, error }: unknown provider/mode surfaces an
 * actionable error instead of a guessed target.
 */
function bindingToLegacyTarget(binding) {
  if (!binding || typeof binding !== 'object') return { target: null, error: 'dsh-adapter-invalid-binding' }
  const providerKey = dshProviderKeyOf(binding.providerId)
  if (!providerKey) return { target: null, error: 'dsh-adapter-unknown-provider:' + String(binding.providerId) }
  if (typeof binding.remoteModelId !== 'string' || binding.remoteModelId === '') {
    return { target: null, error: 'dsh-adapter-missing-remote-model' }
  }
  if (typeof binding.reasoning !== 'string' || binding.reasoning === '') {
    return { target: null, error: 'dsh-adapter-missing-reasoning' }
  }
  const target = {
    modelId: typeof binding.logicalModelId === 'string' ? binding.logicalModelId : null,
    model: binding.remoteModelId,
    provider: providerKey,
    reasoning: binding.reasoning,
  }
  if (binding.dataUseTier !== undefined && binding.dataUseTier !== null) target.dataUseTier = binding.dataUseTier
  return { target, error: null }
}

/**
 * Project a canonical provider id onto its installed DSH settings key.
 * Returns { key, error } without touching settings.yaml.
 */
function providerToDshKey(providerId) {
  const key = dshProviderKeyOf(providerId)
  if (!key) return { key: null, error: 'dsh-adapter-unknown-provider:' + String(providerId) }
  return { key, error: null }
}

// Secret-material scan: snapshots must carry only opaque credential://
// references, never raw keys or tokens.
const SECRET_PATTERNS = [/sk-live-[A-Za-z0-9]+/, /sk-ant-[A-Za-z0-9-]+/, /AIza[A-Za-z0-9_-]+/, /xox[bap]-[A-Za-z0-9-]+/, /ghp_[A-Za-z0-9]+/]

function snapshotHasSecrets(value) {
  const text = JSON.stringify(value)
  if (/(\"credentialRef\"\s*:\s*\"(?!credential:\/\/)[^\"]+\")/.test(text)) return true
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) return true
  }
  if (/\"apiKey\"\s*:/.test(text)) return true
  if (/\"token\"\s*:\s*\"(?!credential:\/\/)/.test(text)) return true
  return false
}

function adapterDescriptor() {
  return {
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    providers: Object.assign({}, PROVIDER_TO_DSH_KEY),
    modes: Object.assign({}, MODE_TO_DSH_PRESET),
    lockedPresets: JSON.parse(JSON.stringify(LOCKED_DSH_PRESETS)),
    legacyProfiles: Object.assign({}, LEGACY_PROFILE_TO_MODE),
  }
}

module.exports = {
  ADAPTER_SCHEMA_VERSION,
  PROVIDER_TO_DSH_KEY,
  MODE_TO_DSH_PRESET,
  LOCKED_DSH_PRESETS,
  LEGACY_PROFILE_TO_MODE,
  dshProviderKeyOf,
  dshPresetOfMode,
  canonicalModeOfLegacyProfile,
  isLockedDshPreset,
  bindingToLegacyTarget,
  providerToDshKey,
  snapshotHasSecrets,
  adapterDescriptor,
}
