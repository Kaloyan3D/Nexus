'use strict';

/**
 * MuseReasoningGovernor.Tests.cjs -- Phase 1 (TASK-0049) deterministic suite
 * for config/Muse-ReasoningGovernor.cjs.
 *
 * Fully OFFLINE: the resolver is pure (no network, no model, no I/O), so every
 * case below runs against the REAL resolver with structured inputs. Nothing
 * here duplicates resolver logic in a fake helper; each assertion calls
 * resolveMuseReasoningEffort / resolveMuseReasoningEffortForRequest directly.
 *
 * Required coverage (task section 9):
 * phase defaults 1-7, escalation 8-10, non-escalation 11-12, de-escalation
 * 13, capability handling 14-16, plus malformed/unsupported combinations.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const governor = require(path.join(repoRoot, 'config', 'Muse-ReasoningGovernor.cjs'));

let passed = 0;
function pass(name) {
  passed += 1;
  console.log('PASS: ' + name);
}

function stateFor(phase, overrides) {
  return governor.createMuseReasoningState(phase, overrides || {});
}

function resolveEffort(phase, overrides, capabilities) {
  return governor.resolveMuseReasoningEffort({
    state: stateFor(phase, overrides),
    capabilities: capabilities === undefined ? null : capabilities,
  }).effort;
}

function fullSupport() {
  return { supportedEfforts: ['medium', 'high', 'xhigh', 'max'] };
}

function contributorSupport() {
  // Mirrors the production registry entry muse-spark-1.3-contributor:
  // medium..xhigh, no max (Standard-tier only), no off.
  return { supportedEfforts: ['medium', 'high', 'xhigh'] };
}

function main() {
  // Policy defaults are the task section 8 contract.
  assert.equal(governor.MUSE_REASONING_MODE, 'adaptive');
  assert.deepEqual(governor.DEFAULT_MUSE_PHASE_EFFORT, {
    discover: 'medium',
    diagnose: 'high',
    design: 'high',
    implement: 'medium',
    verify: 'medium',
    recover: 'high',
    review: 'high',
  });
  pass('0: governor policy defaults match the adaptive contract');

  // -- Phase defaults 1-7 (actual resolver, unconstrained capabilities) --
  assert.equal(resolveEffort('discover'), 'medium');
  pass('1: discover -> medium');
  assert.equal(resolveEffort('diagnose'), 'high');
  pass('2: diagnose -> high');
  assert.equal(resolveEffort('design'), 'high');
  pass('3: design -> high');
  assert.equal(resolveEffort('implement'), 'medium');
  pass('4: implement -> medium');
  assert.equal(resolveEffort('verify'), 'medium');
  pass('5: verify -> medium');
  assert.equal(resolveEffort('recover'), 'high');
  pass('6: recover -> high');
  assert.equal(resolveEffort('review'), 'high');
  pass('7: review -> high');

  // -- Escalation 8-10: strong signals override the phase mapping --
  assert.equal(resolveEffort('discover', { failedHypotheses: 2 }), 'xhigh');
  pass('8: failedHypotheses = 2 -> xhigh');
  assert.equal(resolveEffort('verify', { failedImplementationAttempts: 2 }), 'xhigh');
  pass('9: failedImplementationAttempts = 2 -> xhigh');
  assert.equal(resolveEffort('implement', { conflictingEvidence: true }), 'xhigh');
  pass('10: conflictingEvidence = true -> xhigh');

  // -- Non-escalation 11-12: single failures stay on the phase mapping --
  assert.equal(resolveEffort('discover', { failedHypotheses: 1 }), 'medium');
  pass('11: one failed hypothesis alone does not require xhigh');
  assert.equal(resolveEffort('implement', { failedImplementationAttempts: 1 }), 'medium');
  pass('12: one failed implementation attempt alone does not require xhigh');

  // -- De-escalation 13 --
  assert.equal(
    resolveEffort('implement', { rootCauseEstablished: true, solutionEstablished: true }),
    'medium',
  );
  pass('13: established root cause + solution + implement -> medium');

  // Escalation beats de-escalation (precedence proof): even with both causes
  // established, an active strong signal keeps xhigh.
  assert.equal(
    resolveEffort('implement', {
      rootCauseEstablished: true,
      solutionEstablished: true,
      failedHypotheses: 2,
    }),
    'xhigh',
  );
  pass('13b: escalation overrides de-escalation (precedence is ordered)');

  // -- Capability handling 14-16 --
  assert.equal(
    governor.resolveMuseReasoningEffort({
      state: stateFor('diagnose', { failedHypotheses: 2 }),
      capabilities: contributorSupport(),
    }).effort,
    'xhigh',
  );
  pass('14: requested xhigh + xhigh supported -> xhigh');

  assert.equal(
    governor.resolveMuseReasoningEffort({
      state: stateFor('design', { requestMax: true }),
      capabilities: fullSupport(),
    }).effort,
    'max',
  );
  pass('15: requested max + max supported -> max');

  assert.equal(
    governor.resolveMuseReasoningEffort({
      state: stateFor('design', { requestMax: true }),
      capabilities: contributorSupport(),
    }).effort,
    'xhigh',
  );
  pass('16: requested max + max unsupported + xhigh supported -> xhigh');

  console.log('PART1-OK');
  // -- max is never automatic: ordinary failures stop at xhigh --
  const ordinaryMax = governor.resolveMuseReasoningEffort({
    state: stateFor('diagnose', { failedHypotheses: 5, failedImplementationAttempts: 5, conflictingEvidence: true }),
    capabilities: fullSupport(),
  });
  assert.equal(ordinaryMax.effort, 'xhigh');
  pass('17: repeated ordinary failures escalate to xhigh, never automatically to max');

  // max requires the explicit request flag even when supported.
  assert.equal(
    governor.resolveMuseReasoningEffort({ state: stateFor('design'), capabilities: fullSupport() }).effort,
    'high',
  );
  pass('18: no explicit max request means no max, even when max is supported');

  // Explicit max composes after escalation in the trace; the reason names max.
  const maxAfterEscalation = governor.resolveMuseReasoningEffort({
    state: stateFor('diagnose', { failedHypotheses: 3, requestMax: true }),
    capabilities: fullSupport(),
  });
  assert.equal(maxAfterEscalation.effort, 'max');
  assert.equal(maxAfterEscalation.reason, 'explicit-max');
  assert.ok(maxAfterEscalation.trace[1].indexOf('escalation:') === 0);
  assert.ok(maxAfterEscalation.trace[2] === 'explicit-max-request->max');
  pass('18b: explicit max applies after escalation and owns the reason');

  // -- Malformed / unsupported capability combinations --
  // Empty capability set: safe fallback, and max still clamps to xhigh.
  assert.equal(
    governor.resolveMuseReasoningEffort({
      state: stateFor('design', { requestMax: true }),
      capabilities: { supportedEfforts: [] },
    }).effort,
    'xhigh',
  );
  pass('19: empty capabilities + max request -> safe xhigh fallback (never blind max)');

  // Missing supportedEfforts array: same safe fallback, no throw at resolve.
  assert.equal(
    resolveEffort('diagnose', {}, {}),
    'high',
  );
  pass('20: malformed capabilities object (no array) falls back safe, never throws');

  // Unknown level strings are dropped, never invented as support.
  assert.deepEqual(
    governor.normalizeMuseReasoningCapabilities({ supportedEfforts: ['xhigh', 'ultra', ' bogus ', 'medium', 'xhigh'] }),
    { supportedEfforts: ['medium', 'xhigh'] },
  );
  pass('21: capability normalization drops unknown levels, trims case, dedupes');

  // Case-insensitive capability input still satisfies the clamp.
  assert.equal(
    governor.resolveMuseReasoningEffort({
      state: stateFor('recover'),
      capabilities: { supportedEfforts: ['MEDIUM', 'HIGH', 'XHIGH'] },
    }).effort,
    'high',
  );
  pass('22: capability matching is case-insensitive');

  // Narrow floor (only high supported): escalation clamps DOWN to high.
  assert.equal(
    governor.resolveMuseReasoningEffort({
      state: stateFor('diagnose', { conflictingEvidence: true }),
      capabilities: { supportedEfforts: ['medium', 'high'] },
    }).effort,
    'high',
  );
  pass('23: xhigh requested but unsupported clamps down to high (never up, never max)');

  // Only max supported (theoretical): a medium request cannot step down, so it
  // takes the lowest supported level with the clamp recorded in the trace.
  const floorCase = governor.resolveMuseReasoningEffort({
    state: stateFor('discover'),
    capabilities: { supportedEfforts: ['max'] },
  });
  assert.equal(floorCase.effort, 'max');
  assert.ok(floorCase.trace.some((step) => step.indexOf('below-supported-floor') >= 0));
  pass('24: request below the supported floor is explicit in the trace');

  // -- Registry seam: capabilities come from existing metadata, never invented --
  const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'model-registry.json'), 'utf8'));
  const contributor = registry.models.find((entry) => entry && entry.id === 'muse-spark-1.3-contributor');
  assert.ok(contributor, 'production contributor entry present');
  assert.deepEqual(governor.capabilitiesFromRegistryEntry(contributor).supportedEfforts, ['medium', 'high', 'xhigh']);
  pass('25: contributor registry entry derives medium..xhigh (max absent, nothing invented)');

  // The Phase-2 seam resolves against the REAL production entry: max request
  // clamps to the contributor ceiling xhigh.
  assert.equal(
    governor.resolveMuseReasoningEffortForRequest({
      state: stateFor('design', { requestMax: true }),
      registryEntry: contributor,
    }).effort,
    'xhigh',
  );
  pass('26: Phase-2 seam against the production entry clamps max to xhigh');

  // Non-Muse levels in the registry (minimal/low) never enter the governor.
  assert.deepEqual(
    governor.capabilitiesFromRegistryEntry({ supportedReasoningLevels: ['minimal', 'low', 'medium'] }).supportedEfforts,
    ['medium'],
  );
  pass('27: non-governor registry levels (minimal/low) do not enter capabilities');

  // Missing entry (null) means no constraint; malformed entry means safe empty set.
  assert.equal(governor.capabilitiesFromRegistryEntry(null), null);
  assert.deepEqual(governor.capabilitiesFromRegistryEntry({}).supportedEfforts, []);
  pass('28: null registry entry is unconstrained; malformed entry is safely empty');

  // -- State validation fails closed (never resolves a malformed state) --
  assert.throws(() => stateFor('planning'), TypeError);
  pass('29: unknown phase fails closed');
  assert.throws(() => stateFor('discover', { failedHypotheses: -1 }), TypeError);
  pass('30: negative counters fail closed');
  assert.throws(() => stateFor('discover', { conflictingEvidence: 'yes' }), TypeError);
  pass('31: non-boolean flags fail closed');
  assert.throws(() => governor.updateMuseReasoningState(stateFor('discover'), { unknownField: 1 }), TypeError);
  pass('32: unknown state fields fail closed');

  // State transitions are immutable: update returns a new object.
  const before = stateFor('discover');
  const after = governor.updateMuseReasoningState(before, { phase: 'diagnose', failedHypotheses: 1 });
  assert.equal(before.phase, 'discover');
  assert.equal(after.phase, 'diagnose');
  assert.equal(after.failedHypotheses, 1);
  pass('33: state updates are immutable');

  // -- Determinism: same inputs always resolve identically --
  const first = governor.resolveMuseReasoningEffort({
    state: stateFor('recover', { failedImplementationAttempts: 2 }),
    capabilities: contributorSupport(),
  });
  const second = governor.resolveMuseReasoningEffort({
    state: stateFor('recover', { failedImplementationAttempts: 2 }),
    capabilities: contributorSupport(),
  });
  assert.deepEqual(first, second);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.trace));
  pass('34: resolution is deterministic and frozen');

  // -- No Dual/GLM/Codex surface is touched by requiring the governor --
  const dualProbe = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'routing-policy.json'), 'utf8'));
  assert.equal(dualProbe.presets['aih-engineering'].tiers['3'].reasoning, 'high');
  pass('35: Dual routing policy untouched (structural read-back guard)');

  console.log('RESULT: ' + passed + ' MuseReasoningGovernor assertions passed.');
}

main();

