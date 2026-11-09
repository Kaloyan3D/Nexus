'use strict'

/**
 * nexus/strategies/legacy-dual — EMv1 Dual compatibility strategy (P1).
 *
 * Dual is NOT migrated to a new implementation. This descriptor only states
 * the existing Dual policy through the shared strategy boundary so the
 * Controller needs no `engine === 'muse'` branches:
 *   - the root turn runs through the existing Dual epistemic step router
 *     (Engineering.ps1 uncertainty-create / epistemic-step), stepRouting true;
 *   - an explicit /review dispatches the existing legacy independent review
 *     path (Review.ps1 through the Controller), unchanged;
 *   - an inconclusive binding validation keeps the historical legacy
 *     degradation for unmarked sessions (registry-marked sessions are rejected
 *     by the Controller before the strategy is consulted);
 *   - routing failures carry no extra notice.
 * Worker composition, delegation block, legacy role aliases and the operator
 * gate are untouched (they live in the preset rows and PowerShell modules).
 */

const LEGACY_DUAL_STRATEGY_ID = 'nexus.legacy-dual'

const descriptor = Object.freeze({
  id: LEGACY_DUAL_STRATEGY_ID,
  contractMajor: 1,
  build: 'nexus-p1-legacy-dual-1',
  label: 'EMv1 Dual (legacy compatibility)',
  engines: ['dual'],
  roles: ['engineer_normal', 'engineer_deep', 'reviewer'],
  planes: ['aih-engineering', 'aih-deepseek'],
  mandatory: true,
  capabilities: { independentReview: true, delegation: true, workers: true, fallback: false },
})

function decide(view, event) {
  switch (event && event.type) {
    case 'explicit-review':
      return [{ kind: 'runReview' }]
    case 'engineering-turn':
      return [{ kind: 'runRoot', stepRouting: true, executionLabel: ' · step-routed' }]
    case 'routing-failure':
      return [{ kind: 'refuse', code: 'controller-routing-failed', noticeSuffix: '' }]
    case 'binding-inconclusive':
      return [{ kind: 'degradeLegacy' }]
    default:
      return [{ kind: 'refuse', code: 'strategy-event-unsupported' }]
  }
}

function readiness() { return { ready: true, reason: null } }

function create() { return Object.freeze({ decide, readiness }) }

module.exports = { descriptor, create, decide, readiness, LEGACY_DUAL_STRATEGY_ID }
