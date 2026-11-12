'use strict'

/**
 * nexus/strategies/muse — EMv2 Muse through the strategy boundary (P1, C03).
 *
 * EMv2 = Muse (one main agent `muse_main`), not Dual. This adapter encodes the
 * Muse execution policy the Controller previously hardcoded as
 * `engine === 'muse'` branches, and reuses the existing Muse modules rather
 * than reimplementing them:
 *
 *   - Adaptive Reasoning Governor (`Muse-ReasoningGovernor.cjs`, pure) and
 *     trusted tool-activity reduction (`Muse-ReasoningActivity.cjs`, pure) are
 *     referenced here for readiness; their runtime behavior stays where it is
 *     (Muse-Isolation + Controller-RequestBoundary select the route and effort
 *     before request capture; Muse-ReasoningSignals owns the phase tool and the
 *     `tools/result` observer). Nothing in the request/model-selection
 *     ordering moves.
 *   - No independent reviewer, no delegation, no workers, no fallback: an
 *     explicit review is refused with the exact historical notice, routing
 *     failures say no Muse fallback was attempted, and an inconclusive binding
 *     validation rejects (Muse never degrades into an uncontrolled turn).
 *   - The root turn runs without the Dual epistemic step router (stepRouting
 *     false); the attempt runs on the task-level execution class (muse_main)
 *     resolved by the existing routing CLI.
 *
 * The strategy holds no model mapping and no write authority. It cannot
 * complete a task: contract major 1 has no completion decision.
 */

const governor = require('../../Muse-ReasoningGovernor.cjs')
const activity = require('../../Muse-ReasoningActivity.cjs')

const MUSE_STRATEGY_ID = 'nexus.muse'

// Exact historical notice (AihController pre-step, Phase M3).
const MUSE_REVIEW_UNAVAILABLE_NOTICE =
  'Controller: independent review is not available for the Muse engine (engine=muse, review.independent=false).\n' +
  'The Muse plane never invokes Codex as reviewer, fallback, repair agent, or worker, and no Muse reviewer exists in V0.\n' +
  'Route the task through a Dual profile (Normal Engineering + GLM/Codex or DeepSeek/Codex) for independent review. No files were modified.'

const descriptor = Object.freeze({
  id: MUSE_STRATEGY_ID,
  contractMajor: 1,
  build: 'nexus-p1-muse-1',
  label: 'EMv2 Muse',
  engines: ['muse'],
  roles: ['muse_main'],
  planes: ['aih-muse'],
  mandatory: true,
  capabilities: { independentReview: false, delegation: false, workers: false, fallback: false },
})

const REQUIRED_GOVERNOR_API = ['resolveMuseReasoningEffort', 'resolveMuseReasoningEffortForRequest', 'updateMuseReasoningState', 'clampMuseEffortToCapabilities']
const REQUIRED_ACTIVITY_API = ['observeToolOutcome', 'classifyToolOutcome', 'reduceEffectiveState']

function readiness(context) {
  const missingGovernor = REQUIRED_GOVERNOR_API.filter((name) => typeof governor[name] !== 'function')
  if (missingGovernor.length) return { ready: false, reason: 'muse-governor-api-missing: ' + missingGovernor.join(',') }
  const missingActivity = REQUIRED_ACTIVITY_API.filter((name) => typeof activity[name] !== 'function')
  if (missingActivity.length) return { ready: false, reason: 'muse-activity-api-missing: ' + missingActivity.join(',') }
  if (context && context.requirePlanes) {
    const attached = new Set(context.attachedPlanes || [])
    if (!attached.has('aih-muse')) return { ready: false, reason: 'muse-plane-bridge-not-attached' }
  }
  return { ready: true, reason: null }
}

/**
 * decide(view, event) -> Decision[]
 *   event.type: 'explicit-review' | 'engineering-turn' | 'routing-failure' | 'binding-inconclusive'
 */
function decide(view, event) {
  switch (event && event.type) {
    case 'explicit-review':
      return [{ kind: 'refuse', code: 'muse-review-unavailable', notice: MUSE_REVIEW_UNAVAILABLE_NOTICE, noticeForm: 'muse-review-unavailable' }]
    case 'engineering-turn':
      return [{ kind: 'runRoot', stepRouting: false, executionLabel: ' · engine=muse' }]
    case 'routing-failure':
      return [{ kind: 'refuse', code: 'controller-routing-failed', noticeSuffix: '\nNo Muse fallback was attempted.' }]
    case 'binding-inconclusive':
      return [{ kind: 'refuse', code: 'binding-validation-inconclusive' }]
    default:
      return [{ kind: 'refuse', code: 'strategy-event-unsupported' }]
  }
}

function create() {
  return Object.freeze({ decide, readiness, reasoning: Object.freeze({ governor, activity }) })
}

module.exports = { descriptor, create, decide, readiness, MUSE_STRATEGY_ID, MUSE_REVIEW_UNAVAILABLE_NOTICE }
