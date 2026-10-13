'use strict'

/**
 * Registry R2.4 - deterministic resolution parity harness.
 *
 * Compares canonical Registry compilation against the ACTUAL legacy
 * resolution behavior (used as oracle). The caller produces oracle values
 * with the real legacy resolvers (Engineering-Profiles, Nexus-Profiles);
 * every function here is a pure function of (oracle, binding, policy) so
 * the harness itself stays runtime-independent: no fs, no process.env,
 * no DSH/PowerShell/Rust imports, no network, no credentials.
 *
 * For every supported profile and internal role it compares: logical model
 * mapping and historical alias, remote model id, provider id, reasoning
 * level, route availability and connection eligibility, effective execution
 * kind, reviewer/solver authorization, engine compatibility, and data-use
 * restrictions. Expected canonical id changes (Muse alias unification) are
 * distinguished from actual execution-target mismatches.
 */

const PARITY_SCHEMA_VERSION = 1
const EXPECTED_EXECUTION_KIND = 'raw-model'

function mismatch(code, detail) {
  return { code, detail: String(detail) }
}

/**
 * Compare one role execution target. oracle: { modelId, model, provider,
 * reasoning, dataUseTier }. binding: compiled RuntimeModelBinding.
 * expectedCanonicalModelId: when set, a logical-id change from the legacy
 * alias to that canonical id is EXPECTED and reported separately.
 */
function compareExecutionTarget(oracle, binding, expectedCanonicalModelId) {
  const mismatches = []
  const canonicalChanges = []
  if (!oracle || typeof oracle !== 'object') return { match: false, canonicalIdChangeOnly: false, mismatches: [mismatch('parity-missing-oracle', 'no legacy oracle value')], canonicalChanges: [] }
  if (!binding || typeof binding !== 'object') return { match: false, canonicalIdChangeOnly: false, mismatches: [mismatch('parity-missing-binding', 'no registry binding')], canonicalChanges: [] }
  if (oracle.model !== binding.remoteModelId) {
    mismatches.push(mismatch('parity-remote-model-mismatch', 'legacy remote ' + oracle.model + ' != registry ' + binding.remoteModelId))
  }
  if (oracle.provider !== binding.providerId) {
    mismatches.push(mismatch('parity-provider-mismatch', 'legacy provider ' + oracle.provider + ' != registry ' + binding.providerId))
  }
  if (oracle.reasoning !== binding.reasoning) {
    mismatches.push(mismatch('parity-reasoning-mismatch', 'legacy reasoning ' + oracle.reasoning + ' != registry ' + binding.reasoning))
  }
  if (expectedCanonicalModelId) {
    if (binding.logicalModelId !== expectedCanonicalModelId) {
      mismatches.push(mismatch('parity-canonical-model-mismatch', 'expected canonical ' + expectedCanonicalModelId + ' got ' + binding.logicalModelId))
    } else if (oracle.modelId !== expectedCanonicalModelId) {
      canonicalChanges.push(mismatch('parity-canonical-id-change', 'legacy model id ' + oracle.modelId + ' -> canonical ' + binding.logicalModelId + ' (execution target unchanged)'))
    }
  } else if (oracle.modelId !== binding.logicalModelId) {
    mismatches.push(mismatch('parity-model-id-mismatch', 'legacy modelId ' + oracle.modelId + ' != registry ' + binding.logicalModelId))
  }
  if (binding.executionKind !== EXPECTED_EXECUTION_KIND) {
    mismatches.push(mismatch('parity-execution-kind-mismatch', 'expected ' + EXPECTED_EXECUTION_KIND + ' got ' + binding.executionKind))
  }
  const oracleTier = oracle.dataUseTier === undefined ? null : oracle.dataUseTier
  const bindingTier = binding.dataUseTier === undefined ? null : binding.dataUseTier
  if (oracleTier !== bindingTier) {
    mismatches.push(mismatch('parity-data-use-mismatch', 'legacy tier ' + String(oracleTier) + ' != registry ' + String(bindingTier)))
  }
  const match = mismatches.length === 0
  return { match, canonicalIdChangeOnly: match && canonicalChanges.length > 0, mismatches, canonicalChanges }
}

/**
 * Verify reviewer/solver authorization requirements on a compiled binding
 * against the legacy routing-policy execution classes. policy: the parsed
 * routing-policy.json executionClasses map (or equivalent).
 */
function checkRoleAuthorization(role, binding, executionClasses) {
  const mismatches = []
  const classes = (executionClasses && typeof executionClasses === 'object') ? executionClasses : {}
  if (role === 'reviewer') {
    const policy = classes.reviewer || {}
    if (policy.writable !== false) mismatches.push(mismatch('parity-policy-drift', 'legacy reviewer execution class must stay read-only'))
    const caps = (binding && Array.isArray(binding.requiredCapabilities)) ? binding.requiredCapabilities : []
    if (caps.indexOf('readOnlyEnforced') === -1) {
      mismatches.push(mismatch('parity-reviewer-not-readonly', 'reviewer binding lacks readOnlyEnforced'))
    }
  }
  if (role === 'solver') {
    const policy = classes.solver || {}
    if (policy.requiresUserApproval !== true) mismatches.push(mismatch('parity-policy-drift', 'legacy solver execution class must stay approval-gated'))
    const caps = (binding && Array.isArray(binding.requiredCapabilities)) ? binding.requiredCapabilities : []
    if (caps.indexOf('writeRequiresApproval') === -1) {
      mismatches.push(mismatch('parity-solver-not-gated', 'solver binding lacks writeRequiresApproval'))
    }
  }
  return mismatches
}

/**
 * Strict engine isolation on explicit orchestration-engine identities.
 *
 * Only the two known engine ids pass: 'dual-v1' and 'muse-v0'. Any other
 * expectation (legacy aliases, typos, empty, null, case variants) fails
 * closed, and any binding whose engine id is not exactly the expected one
 * fails closed. Substring matching is deliberately not used: an arbitrary
 * engine id must never satisfy Dual/Muse isolation.
 */
const KNOWN_ORCHESTRATION_ENGINES = Object.freeze(['dual-v1', 'muse-v0']);
function checkEngineIsolation(expectedEngine, binding) {
  if (expectedEngine !== 'dual-v1' && expectedEngine !== 'muse-v0') {
    return [mismatch('parity-unknown-engine', 'unknown expected engine: ' + String(expectedEngine) + '; isolation fails closed')]
  }
  if (!binding || typeof binding !== 'object') return [mismatch('parity-missing-binding', 'no binding for engine check')]
  const actual = binding.orchestrationEngineId
  if (actual !== expectedEngine) {
    return [mismatch('parity-engine-crossover', 'expected orchestration engine ' + expectedEngine + ' but binding carries ' + String(actual))]
  }
  return []
}

/**
 * Failure parity: an unresolvable legacy oracle (null) must correspond to
 * a failed registry compilation, and vice versa. Never a silent substitute.
 */
function compareFailure(oracleNull, registryOk, label) {
  const legacyFails = oracleNull === null || oracleNull === undefined
  if (legacyFails && registryOk) {
    return { match: false, detail: mismatch('parity-failure-divergence', String(label) + ': legacy fails closed but registry compiled (silent substitution risk)') }
  }
  if (!legacyFails && !registryOk) {
    return { match: false, detail: mismatch('parity-failure-divergence', String(label) + ': legacy resolves but registry fails closed') }
  }
  return { match: true, detail: null }
}

/** Summarize a list of per-role results into a parity matrix. */
function summarizeComparisons(results) {
  const summary = { schemaVersion: PARITY_SCHEMA_VERSION, total: results.length, matched: 0, canonicalIdChangeOnly: 0, mismatched: 0, failures: [] }
  for (const result of results) {
    if (result && result.match) {
      summary.matched += 1
      if (result.canonicalIdChangeOnly) summary.canonicalIdChangeOnly += 1
    } else {
      summary.mismatched += 1
      summary.failures.push(result)
    }
  }
  return summary
}

module.exports = {
  PARITY_SCHEMA_VERSION,
  EXPECTED_EXECUTION_KIND,
  KNOWN_ORCHESTRATION_ENGINES,
  compareExecutionTarget,
  checkRoleAuthorization,
  checkEngineIsolation,
  compareFailure,
  summarizeComparisons,
}
