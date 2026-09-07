'use strict';

/**
 * Muse-ReasoningGovernor.cjs -- Phase 1 (TASK-0049) adaptive reasoning-effort
 * core for the dedicated Muse Spark 1.3 engine (agent preset aih-muse).
 *
 * Muse-specific. Not a Nexus-wide reasoning framework: Dual/GLM/Codex planes
 * never require this module and no generic routing code depends on it.
 *
 * Concepts:
 * - Canonical Muse efforts: medium | high | xhigh | max.
 * - Closed Muse phases: discover | diagnose | design | implement | verify
 *   | recover | review.
 * - Task-local Muse reasoning STATE (control signals only -- phase, counters,
 *   booleans, one explicit max-request flag). No confidence scores, no ML,
 *   no hidden chain-of-thought; this module persists nothing.
 * - Capabilities derived from existing registry metadata
 *   (supportedReasoningLevels). Never invented.
 * - One pure deterministic resolver. No network, no model calls, no
 *   classifier, no subagents.
 *
 * Precedence inside resolveMuseReasoningEffort (the single site):
 * 1. phase default, 2. strong escalation to xhigh, 3. implement
 * de-escalation carve-out, 4. explicit max request, 5. capability clamp.
 *
 * Step 5 is strictly fail-closed (Phase 1-F1): it resolves only to a
 * capability explicitly known to be supported AND at or below the requested
 * effort. Unknown / missing / empty capability data, or no supported level
 * at-or-below the request, THROWS MuseReasoningCapabilityError -- a Phase 2
 * caller can never accidentally send a guessed or upward-clamped effort.
 * Downward clamps (max -> xhigh, xhigh -> high) remain valid.
 */
const MUSE_REASONING_EFFORTS = Object.freeze(['medium', 'high', 'xhigh', 'max']);
const MUSE_REASONING_EFFORT_SET = new Set(MUSE_REASONING_EFFORTS);
const MUSE_REASONING_PHASES = Object.freeze([
  'discover',
  'diagnose',
  'design',
  'implement',
  'verify',
  'recover',
  'review',
]);
const MUSE_REASONING_PHASE_SET = new Set(MUSE_REASONING_PHASES);
const MUSE_REASONING_MODE = 'adaptive';
const DEFAULT_MUSE_PHASE_EFFORT = Object.freeze({
  discover: 'medium',
  diagnose: 'high',
  design: 'high',
  implement: 'medium',
  verify: 'medium',
  recover: 'high',
  review: 'high',
});
const DEFAULT_MUSE_REASONING_POLICY = Object.freeze({
  mode: MUSE_REASONING_MODE,
  phaseEffort: DEFAULT_MUSE_PHASE_EFFORT,
});
const MUSE_ESCALATION_FAILURE_THRESHOLD = 2;

/**
 * Typed fail-closed capability error. Thrown by step 5 when no explicitly
 * supported effort exists at or below the requested effort (unknown, missing,
 * empty, or floor-mismatched capability data). Carries code
 * 'nexus-muse-reasoning-capability-unavailable' plus the requested effort and
 * the normalized supported set, so a Phase 2 caller can log the refusal
 * without ever placing a guessed effort on the wire. An instanceof check is
 * the supported discriminator (error.name === 'MuseReasoningCapabilityError').
 */
class MuseReasoningCapabilityError extends Error {
  constructor(requested, supported) {
    const supportedList = Array.isArray(supported) && supported.length > 0
      ? supported.join(', ')
      : '(none known)';
    super(
      'Muse reasoning capability unavailable: requested effort ' +
        String(requested) +
        ' has no explicitly supported effort at or below it ' +
        '(supported: ' + supportedList + '). ' +
        'Refusing to guess provider capabilities.',
    );
    this.name = 'MuseReasoningCapabilityError';
    this.code = 'nexus-muse-reasoning-capability-unavailable';
    this.requested = requested;
    this.supported = Object.freeze((Array.isArray(supported) ? supported : []).slice());
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEffortToken(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizePhaseToken(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeMuseReasoningState(state) {
  if (!isPlainObject(state)) {
    throw new TypeError('Muse reasoning state must be a plain object.');
  }
  const phase = normalizePhaseToken(state.phase);
  if (!MUSE_REASONING_PHASE_SET.has(phase)) {
    throw new TypeError('Muse reasoning state.phase must be a known phase.');
  }
  const counters = ['failedHypotheses', 'failedImplementationAttempts'];
  for (const field of counters) {
    const value = state[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new TypeError('Muse reasoning state.' + field + ' must be a non-negative integer.');
    }
  }
  const flags = ['rootCauseEstablished', 'solutionEstablished', 'conflictingEvidence'];
  for (const field of flags) {
    if (typeof state[field] !== 'boolean') {
      throw new TypeError('Muse reasoning state.' + field + ' must be a boolean.');
    }
  }
  let requestMax = false;
  if (state.requestMax !== undefined) {
    if (typeof state.requestMax !== 'boolean') {
      throw new TypeError('Muse reasoning state.requestMax must be a boolean when present.');
    }
    requestMax = state.requestMax;
  }
  let currentEffort = null;
  if (state.currentEffort !== undefined && state.currentEffort !== null) {
    const token = normalizeEffortToken(state.currentEffort);
    if (!MUSE_REASONING_EFFORT_SET.has(token)) {
      throw new TypeError('Muse reasoning state.currentEffort must be canonical or omitted.');
    }
    currentEffort = token;
  }
  return {
    phase,
    currentEffort,
    rootCauseEstablished: state.rootCauseEstablished,
    solutionEstablished: state.solutionEstablished,
    failedHypotheses: state.failedHypotheses,
    failedImplementationAttempts: state.failedImplementationAttempts,
    conflictingEvidence: state.conflictingEvidence,
    requestMax,
  };
}

function createMuseReasoningState(phase, overrides) {
  const base = {
    phase,
    currentEffort: null,
    rootCauseEstablished: false,
    solutionEstablished: false,
    failedHypotheses: 0,
    failedImplementationAttempts: 0,
    conflictingEvidence: false,
    requestMax: false,
  };
  const extra = isPlainObject(overrides) ? overrides : {};
  return normalizeMuseReasoningState({ ...base, ...extra });
}

function updateMuseReasoningState(state, patch) {
  const current = normalizeMuseReasoningState(state);
  if (!isPlainObject(patch)) {
    throw new TypeError('Muse reasoning state patch must be a plain object.');
  }
  const allowed = new Set([
    'phase',
    'currentEffort',
    'rootCauseEstablished',
    'solutionEstablished',
    'failedHypotheses',
    'failedImplementationAttempts',
    'conflictingEvidence',
    'requestMax',
  ]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) {
      throw new TypeError('Unknown Muse reasoning state field: ' + key + '.');
    }
  }
  return normalizeMuseReasoningState({ ...current, ...patch });
}
function normalizePolicy(policy) {
  if (policy === undefined || policy === null) return DEFAULT_MUSE_REASONING_POLICY;
  if (!isPlainObject(policy)) {
    throw new TypeError('Muse reasoning policy must be a plain object.');
  }
  const mode = typeof policy.mode === 'string' ? policy.mode.trim().toLowerCase() : 'adaptive';
  if (mode !== 'adaptive') {
    throw new TypeError('Muse reasoning policy.mode must be adaptive in V1.');
  }
  const source = isPlainObject(policy.phaseEffort) ? policy.phaseEffort : {};
  const phaseEffort = {};
  const phases = ['discover', 'diagnose', 'design', 'implement', 'verify', 'recover', 'review'];
  for (const phase of phases) {
    const raw = source[phase] !== undefined ? source[phase] : DEFAULT_MUSE_PHASE_EFFORT[phase];
    const token = normalizeEffortToken(raw);
    if (!MUSE_REASONING_EFFORT_SET.has(token)) {
      throw new TypeError('Muse reasoning policy.phaseEffort.' + phase + ' must be canonical.');
    }
    phaseEffort[phase] = token;
  }
  return { mode, phaseEffort: Object.freeze({ ...phaseEffort }) };
}

function normalizeMuseReasoningCapabilities(capabilities) {
  if (capabilities === undefined || capabilities === null) return null;
  if (!isPlainObject(capabilities)) {
    throw new TypeError('Muse reasoning capabilities must be a plain object when present.');
  }
  const raw = capabilities.supportedEfforts;
  if (!Array.isArray(raw)) return { supportedEfforts: Object.freeze([]) };
  const seen = new Set();
  const supported = [];
  for (const entry of raw) {
    const token = normalizeEffortToken(entry);
    if (!MUSE_REASONING_EFFORT_SET.has(token) || seen.has(token)) continue;
    seen.add(token);
    supported.push(token);
  }
  supported.sort((a, b) => MUSE_REASONING_EFFORTS.indexOf(a) - MUSE_REASONING_EFFORTS.indexOf(b));
  return { supportedEfforts: Object.freeze(supported) };
}

function capabilitiesFromRegistryEntry(entry) {
  if (entry === undefined || entry === null) return null;
  if (!isPlainObject(entry)) {
    throw new TypeError('Model registry entry must be a plain object when present.');
  }
  const levels = entry.supportedReasoningLevels;
  if (!Array.isArray(levels)) return { supportedEfforts: Object.freeze([]) };
  const supported = [];
  for (const effort of MUSE_REASONING_EFFORTS) {
    let found = false;
    for (const level of levels) {
      if (normalizeEffortToken(level) === effort) { found = true; break; }
    }
    if (found) supported.push(effort);
  }
  return { supportedEfforts: Object.freeze(supported) };
}

function hasStrongEscalation(state) {
  return (
    state.failedHypotheses >= MUSE_ESCALATION_FAILURE_THRESHOLD ||
    state.failedImplementationAttempts >= MUSE_ESCALATION_FAILURE_THRESHOLD ||
    state.conflictingEvidence === true
  );
}

function escalationReasonsOf(state) {
  const reasons = [];
  if (state.failedHypotheses >= MUSE_ESCALATION_FAILURE_THRESHOLD) {
    reasons.push('failedHypotheses>=2');
  }
  if (state.failedImplementationAttempts >= MUSE_ESCALATION_FAILURE_THRESHOLD) {
    reasons.push('failedImplementationAttempts>=2');
  }
  if (state.conflictingEvidence === true) reasons.push('conflictingEvidence');
  return reasons;
}

function clampMuseEffortToCapabilities(requested, capabilities) {
  if (!MUSE_REASONING_EFFORT_SET.has(requested)) {
    throw new TypeError('Requested Muse effort must be canonical.');
  }
  const normalized = normalizeMuseReasoningCapabilities(capabilities);
  // Fail closed on unknown capability data: a missing capabilities argument
  // (null/undefined) or a malformed/empty normalized set means the resolver
  // cannot establish support from authoritative metadata, so it must refuse
  // rather than resolve unconstrained or invent a default set.
  if (normalized === null || normalized.supportedEfforts.length === 0) {
    throw new MuseReasoningCapabilityError(
      requested,
      normalized === null ? [] : Array.from(normalized.supportedEfforts),
    );
  }
  const supported = new Set(normalized.supportedEfforts);
  if (supported.has(requested)) {
    return { effort: requested, clamped: false, note: 'supported' };
  }
  // Downward clamp only: the highest supported effort at or below requested.
  // When none exists (request sits below the supported floor), fail closed --
  // resolving upward would silently escalate compute beyond what was asked.
  const ladderIndex = MUSE_REASONING_EFFORTS.indexOf(requested);
  for (let index = ladderIndex - 1; index >= 0; index -= 1) {
    const candidate = MUSE_REASONING_EFFORTS[index];
    if (supported.has(candidate)) {
      return { effort: candidate, clamped: true, note: 'clamped-down-to-' + candidate };
    }
  }
  throw new MuseReasoningCapabilityError(requested, Array.from(normalized.supportedEfforts));
}

function resolveMuseReasoningEffort(input) {
  const args = input === undefined || input === null ? {} : input;
  const normalizedState = normalizeMuseReasoningState(args.state);
  const normalizedPolicy = normalizePolicy(args.policy);
  const trace = [];

  let requested = normalizedPolicy.phaseEffort[normalizedState.phase];
  trace.push('phase:' + normalizedState.phase + '->' + requested);

  const escalated = hasStrongEscalation(normalizedState);
  if (escalated) {
    requested = 'xhigh';
    trace.push('escalation:[' + escalationReasonsOf(normalizedState).join(',') + ']->xhigh');
  }

  if (
    !escalated &&
    normalizedState.phase === 'implement' &&
    normalizedState.rootCauseEstablished === true &&
    normalizedState.solutionEstablished === true
  ) {
    requested = 'medium';
    trace.push('de-escalation:established-solution-in-implement->medium');
  }

  if (normalizedState.requestMax === true) {
    requested = 'max';
    trace.push('explicit-max-request->max');
  }

  const caps = args.capabilities === undefined ? null : args.capabilities;
  const clamped = clampMuseEffortToCapabilities(requested, caps);
  if (clamped.clamped) {
    trace.push('capabilities:' + requested + '->' + clamped.effort + '(' + clamped.note + ')');
  } else {
    trace.push('capabilities:' + requested + '-held(' + clamped.note + ')');
  }

  let reason = 'phase-default';
  if (normalizedState.requestMax === true) {
    reason = clamped.clamped ? 'explicit-max-clamped' : 'explicit-max';
  } else if (escalated) {
    reason = 'escalation';
  } else if (trace.some((step) => step.indexOf('de-escalation') === 0)) {
    reason = 'de-escalation';
  }

  return Object.freeze({
    effort: clamped.effort,
    reason,
    trace: Object.freeze(trace.slice()),
  });
}

function resolveMuseReasoningEffortForRequest(input) {
  const args = input === undefined || input === null ? {} : input;
  const registryEntry = args.registryEntry === undefined ? null : args.registryEntry;
  const capabilities = capabilitiesFromRegistryEntry(registryEntry);
  return resolveMuseReasoningEffort({ state: args.state, capabilities, policy: args.policy });
}

module.exports = {
  MuseReasoningCapabilityError,
  MUSE_REASONING_EFFORTS,
  MUSE_REASONING_PHASES,
  MUSE_REASONING_MODE,
  DEFAULT_MUSE_PHASE_EFFORT,
  DEFAULT_MUSE_REASONING_POLICY,
  MUSE_ESCALATION_FAILURE_THRESHOLD,
  createMuseReasoningState,
  updateMuseReasoningState,
  normalizeMuseReasoningState,
  normalizeMuseReasoningCapabilities,
  capabilitiesFromRegistryEntry,
  clampMuseEffortToCapabilities,
  resolveMuseReasoningEffort,
  resolveMuseReasoningEffortForRequest,
};
