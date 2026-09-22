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
 * Required coverage (task section 9, plus Phase 1-F1 fail-closed semantics):
 * phase defaults 1-7, escalation 8-10, non-escalation 11-12, de-escalation
 * 13, capability handling 14-16, plus malformed/unsupported combinations.
 *
 * Phase 1-F1: capability resolution is strictly fail-closed. Every resolver
 * call in this suite passes EXPLICIT capabilities; unknown / missing / empty
 * capability data, or no supported level at-or-below the request, throws
 * MuseReasoningCapabilityError (code
 * 'nexus-muse-reasoning-capability-unavailable') instead of resolving.
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
    capabilities: capabilities === undefined ? fullSupport() : capabilities,
  }).effort;
}

function assertCapabilityRefused(fn, expectedRequested, label) {
  assert.throws(
    fn,
    (error) => (
      error instanceof governor.MuseReasoningCapabilityError &&
      error.name === 'MuseReasoningCapabilityError' &&
      error.code === 'nexus-muse-reasoning-capability-unavailable' &&
      error.requested === expectedRequested &&
      Array.isArray(error.supported)
    ),
    label,
  );
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

  // -- Valid downward-clamp table (F1 cases 1-4) --
  // Exact supported effort resolves unchanged (F1 case 1 is covered by 14).
  assert.equal(
    governor.resolveMuseReasoningEffort({
      state: stateFor('diagnose'),
      capabilities: { supportedEfforts: ['medium', 'high', 'xhigh'] },
    }).effort,
    'high',
  );
  pass('F1-1: exact supported effort resolves unchanged');

  // max -> xhigh when max unsupported but xhigh supported (F1 case 2 = 16).
  // xhigh -> high when only medium/high supported (F1 case 3).
  assert.equal(
    governor.resolveMuseReasoningEffort({
      state: stateFor('diagnose', { conflictingEvidence: true }),
      capabilities: { supportedEfforts: ['medium', 'high'] },
    }).effort,
    'high',
  );
  pass('F1-3: xhigh requested + only medium/high supported -> high');

  // high -> medium when only medium supported (F1 case 4).
  assert.equal(
    governor.resolveMuseReasoningEffort({
      state: stateFor('diagnose'),
      capabilities: { supportedEfforts: ['medium'] },
    }).effort,
    'medium',
  );
  pass('F1-4: high requested + only medium supported -> medium');

  // -- Fail-closed capability cases (F1 cases 5-9) --
  // Empty supported set refuses, even for a max request (F1 case 5).
  assertCapabilityRefused(
    () => governor.resolveMuseReasoningEffort({
      state: stateFor('design', { requestMax: true }),
      capabilities: { supportedEfforts: [] },
    }),
    'max',
    'empty capabilities must refuse',
  );
  pass('19: empty capabilities + max request -> fail closed (no invented xhigh)');

  // Missing capabilities argument refuses (F1 case 6a).
  assertCapabilityRefused(
    () => governor.resolveMuseReasoningEffort({ state: stateFor('diagnose') }),
    'high',
    'missing capabilities must refuse',
  );
  pass('20a: missing capabilities argument fails closed');

  // Malformed capabilities object (no array) refuses (F1 case 6b).
  assertCapabilityRefused(
    () => governor.resolveMuseReasoningEffort({
      state: stateFor('diagnose'),
      capabilities: {},
    }),
    'high',
    'malformed capabilities must refuse',
  );
  pass('20: malformed capabilities object (no array) fails closed');

  // Null registry entry through the Phase-2 seam refuses (F1 case 6c).
  assertCapabilityRefused(
    () => governor.resolveMuseReasoningEffortForRequest({
      state: stateFor('diagnose'),
      registryEntry: null,
    }),
    'high',
    'null registry entry must refuse',
  );
  pass('20c: null registry entry fails closed through the request seam');

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

  // Narrow support (medium/high): escalation clamps DOWN to high.
  assert.equal(
    governor.resolveMuseReasoningEffort({
      state: stateFor('diagnose', { conflictingEvidence: true }),
      capabilities: { supportedEfforts: ['medium', 'high'] },
    }).effort,
    'high',
  );
  pass('23: xhigh requested but unsupported clamps down to high (never up, never max)');

  // No supported level at-or-below requested: fail closed, never upward.
  // medium requested + only [high] supported (F1 case 7).
  assertCapabilityRefused(
    () => governor.resolveMuseReasoningEffort({
      state: stateFor('discover'),
      capabilities: { supportedEfforts: ['high'] },
    }),
    'medium',
    'medium requested with only high supported must refuse',
  );
  pass('F1-7: requested medium + supported [high] -> fail closed');

  // medium requested + only [xhigh, max] supported (F1 case 8).
  // Previously this resolved UP to max; now it refuses.
  assertCapabilityRefused(
    () => governor.resolveMuseReasoningEffort({
      state: stateFor('discover'),
      capabilities: { supportedEfforts: ['xhigh', 'max'] },
    }),
    'medium',
    'medium requested with only xhigh/max supported must refuse',
  );
  pass('F1-8: requested medium + supported [xhigh,max] -> fail closed');

  // high requested + only [xhigh, max] supported (F1 case 9).
  assertCapabilityRefused(
    () => governor.resolveMuseReasoningEffort({
      state: stateFor('diagnose'),
      capabilities: { supportedEfforts: ['xhigh', 'max'] },
    }),
    'high',
    'high requested with only xhigh/max supported must refuse',
  );
  pass('F1-9: requested high + supported [xhigh,max] -> fail closed');

  // medium requested + only [max] supported: the old upward-escalation case.
  assertCapabilityRefused(
    () => governor.resolveMuseReasoningEffort({
      state: stateFor('discover'),
      capabilities: { supportedEfforts: ['max'] },
    }),
    'medium',
    'medium requested with only max supported must refuse',
  );
  pass('24: below-floor request fails closed (upward resolution removed)');

  // Ladder invariant (F1 case 10): for every successful resolution over a
  // meaningful requested x supported matrix, resolved index <= requested.
  const ladder = governor.MUSE_REASONING_EFFORTS;
  const ladderIndexOf = (effort) => ladder.indexOf(effort);
  const supportedSubsets = [
    ['medium'],
    ['high'],
    ['medium', 'high'],
    ['medium', 'high', 'xhigh'],
    ['medium', 'high', 'xhigh', 'max'],
    ['xhigh', 'max'],
    ['max'],
  ];
  let matrixSuccesses = 0;
  for (const requested of ladder) {
    const phaseForRequest = requested === 'medium' ? 'discover' : 'diagnose';
    for (const supported of supportedSubsets) {
      const caps = { supportedEfforts: supported };
      let outcome = null;
      let refused = false;
      try {
        outcome = governor.resolveMuseReasoningEffort({
          state: stateFor(phaseForRequest),
          capabilities: caps,
        });
      } catch (error) {
        assert.ok(
          error instanceof governor.MuseReasoningCapabilityError,
          'only the typed capability error may reject: ' + requested + ' vs [' + supported.join(',') + ']',
        );
        refused = true;
      }
      if (!refused) {
        matrixSuccesses += 1;
        assert.ok(
          ladderIndexOf(outcome.effort) <= ladderIndexOf(requested),
          'resolved ' + outcome.effort + ' must not exceed requested ' + requested,
        );
      }
    }
  }
  assert.ok(matrixSuccesses > 0, 'matrix must contain successful resolutions');
  pass('F1-10: ladder invariant holds over the requested x supported matrix (' + matrixSuccesses + ' successes)');

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

  // Missing entry (null) stays null (unknown); a malformed entry derives an
  // empty set. Both refuse at resolve time -- neither invents support.
  assert.equal(governor.capabilitiesFromRegistryEntry(null), null);
  assert.deepEqual(governor.capabilitiesFromRegistryEntry({}).supportedEfforts, []);
  pass('28: null registry entry is unknown; malformed entry derives empty (both refuse at resolve)');

  // A registry entry whose levels contain no canonical Muse effort derives an
  // empty set and refuses at resolve (never guesses from the model id).
  assert.deepEqual(
    governor.capabilitiesFromRegistryEntry({ supportedReasoningLevels: ['minimal', 'low'] }).supportedEfforts,
    [],
  );
  assertCapabilityRefused(
    () => governor.resolveMuseReasoningEffortForRequest({
      state: stateFor('diagnose'),
      registryEntry: { supportedReasoningLevels: ['minimal', 'low'] },
    }),
    'high',
    'entry with no canonical Muse levels must refuse',
  );
  pass('28b: registry entry without canonical Muse levels fails closed');

  // -- Phase 2.1-F1: historical totals are inert diagnostics --
  // Totals default to zero and validate as non-negative integers.
  const freshTotals = stateFor('discover');
  assert.equal(freshTotals.totalFailedHypotheses, 0);
  assert.equal(freshTotals.totalFailedImplementationAttempts, 0);
  assert.throws(() => stateFor('discover', { totalFailedHypotheses: -1 }), TypeError);
  assert.throws(() => stateFor('discover', { totalFailedImplementationAttempts: 1.5 }), TypeError);
  pass('F1-G1: totals default to zero and validate as non-negative integers');

  // Historical totals NEVER escalate on their own.
  assert.equal(
    governor.resolveMuseReasoningEffort({
      state: stateFor('diagnose', { totalFailedHypotheses: 99, totalFailedImplementationAttempts: 99 }),
      capabilities: contributorSupport(),
    }).effort,
    'high',
  );
  pass('F1-G2: huge historical totals alone resolve the phase default (never xhigh)');

  // A cleared active window with established solution de-escalates even when
  // history is large -- the governor reads active values only.
  assert.equal(
    governor.resolveMuseReasoningEffort({
      state: stateFor('implement', {
        rootCauseEstablished: true,
        solutionEstablished: true,
        failedHypotheses: 0,
        failedImplementationAttempts: 0,
        conflictingEvidence: false,
        totalFailedHypotheses: 4,
        totalFailedImplementationAttempts: 3,
      }),
      capabilities: contributorSupport(),
    }).effort,
    'medium',
  );
  pass('F1-G3: cleared active window de-escalates despite large history');

  // Totals flow through patches independently of active counters.
  // (Progress resets live in the runtime transition layer, not here.)
  const withTotals = governor.updateMuseReasoningState(stateFor('discover'), { totalFailedHypotheses: 2 });
  assert.equal(withTotals.totalFailedHypotheses, 2);
  assert.equal(withTotals.failedHypotheses, 0);
  pass('F1-G4: totals patch independently of active counters');

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

