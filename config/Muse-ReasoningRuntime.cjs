'use strict';

/**
 * Muse-ReasoningRuntime.cjs -- Phase 2 (TASK-0049) runtime wiring for the
 * Muse adaptive reasoning governor (agent preset aih-muse).
 *
 * Muse-specific trusted-plane module. Dual/GLM/Codex planes never require
 * it. It requires only the Phase 1 governor (pure policy) and
 * Engineering-Profiles.cjs (routing-state path computation). No DSH runtime
 * dependency, so deterministic tests drive it against fixture roots.
 *
 * Task-local state home: the EXISTING routing-state file the Muse request
 * boundary already reads (controller-produced state contract). The runtime
 * owns one block inside it:
 *
 *   museReasoning: {
 *     phase, currentEffort,
 *     rootCauseEstablished, solutionEstablished,
 *     failedHypotheses, failedImplementationAttempts,
 *     conflictingEvidence, requestMax,
 *     lastResolution: { phase, requestedEffort, resolvedEffort,
 *                       reason, trace, atUtc } | null
 *   }
 *
 * Ownership and lifecycle:
 * - One block per task lifecycle generation (the state file is already keyed
 *   by workspace + preset + taskInstanceId), so concurrent Muse tasks never
 *   share state. No global mutable state exists in this module.
 * - Only the validated transition functions below write control signals;
 *   only prepareMuseRequestEffort writes resolution results. Nothing here
 *   persists hidden reasoning -- control signals only.
 * - The model may supply structured control signals through these functions
 *   (a future observation handler calls the same API); Nexus validates every
 *   transition and the Governor alone chooses the effort. There is no path
 *   for model output to set reasoningEffort directly.
 *
 * Per-call effort precedence (adaptive Muse runtime):
 *   1. task-local museReasoning state (initialized to the discover phase
 *      when a legacy state predates this block);
 *   2. Governor resolution against the ACTUAL resolved registry entry
 *      (capabilitiesFromRegistryEntry -- never hardcoded);
 *   3. the resolved effort is written back to state.reasoning AND enforced
 *      on the outbound request by Muse-Isolation.cjs, overriding the static
 *      profile-default reasoning carried in older routing states.
 * The profile transport default (xhigh) remains as configuration but NEVER
 * overrides an adaptive Governor result at request time.
 *
 * Failure semantics: MuseReasoningCapabilityError propagates unchanged (the
 * request must not be sent); malformed stored state fails closed with
 * TypeError; a missing registry entry fails closed through the same
 * capability error. currentEffort is written only after successful
 * resolution -- a refused request leaves state exactly as it was.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const governor = require('./Muse-ReasoningGovernor.cjs');
const profiles = require('./Engineering-Profiles.cjs');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomicJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = filePath + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

function registryEntryFor(installRoot, target) {
  const registryPath = path.join(installRoot, 'config', 'model-registry.json');
  const registry = readJson(registryPath);
  if (!registry || !Array.isArray(registry.models)) return null;
  const wanted = [];
  if (target) {
    if (typeof target.model === 'string' && target.model !== '') wanted.push(target.model);
    if (typeof target.Model === 'string' && target.Model !== '') wanted.push(target.Model);
    if (typeof target.modelId === 'string' && target.modelId !== '') wanted.push(target.modelId);
    if (typeof target.ModelId === 'string' && target.ModelId !== '') wanted.push(target.ModelId);
  }
  for (const entry of registry.models) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of ['id', 'model']) {
      if (typeof entry[key] === 'string' && wanted.includes(entry[key])) return entry;
    }
  }
  return null;
}

function stateBlockOf(routingState) {
  if (!routingState || typeof routingState !== 'object') return null;
  const block = routingState.museReasoning;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  return block;
}

/**
 * Read the validated task-local Muse reasoning state from a routing state
 * document. A missing block initializes to the discover phase (legacy states
 * predate adaptive reasoning); a present-but-malformed block throws
 * fail-closed rather than guessing.
 */
function museReasoningStateOf(routingState) {
  const block = stateBlockOf(routingState);
  if (!block) return governor.createMuseReasoningState('discover');
  return governor.normalizeMuseReasoningState({
    phase: block.phase,
    currentEffort: block.currentEffort === undefined ? null : block.currentEffort,
    rootCauseEstablished: block.rootCauseEstablished,
    solutionEstablished: block.solutionEstablished,
    failedHypotheses: block.failedHypotheses,
    failedImplementationAttempts: block.failedImplementationAttempts,
    conflictingEvidence: block.conflictingEvidence,
    requestMax: block.requestMax === undefined ? false : block.requestMax,
  });
}

/**
 * Extract the pre-capability requested effort from a governor trace.
 * Validated against the known phase and the canonical ladder; any format
 * drift falls back to the resolved effort rather than guessing.
 */
function requestedEffortOfTrace(trace, phase, fallback) {
  const validEfforts = new Set(governor.MUSE_REASONING_EFFORTS);
  if (Array.isArray(trace) && trace.length > 0) {
    const first = String(trace[0]);
    const prefix = 'phase:' + String(phase) + '->';
    if (first.indexOf(prefix) === 0) {
      const candidate = first.slice(prefix.length);
      if (validEfforts.has(candidate)) return candidate;
    }
  }
  return fallback;
}

function blockFromState(state, lastResolution, processedSignalIds) {
  return {
    phase: state.phase,
    currentEffort: state.currentEffort,
    rootCauseEstablished: state.rootCauseEstablished,
    solutionEstablished: state.solutionEstablished,
    failedHypotheses: state.failedHypotheses,
    failedImplementationAttempts: state.failedImplementationAttempts,
    conflictingEvidence: state.conflictingEvidence,
    requestMax: state.requestMax,
    lastResolution: lastResolution === undefined ? null : lastResolution,
    processedSignalIds: processedSignalIds === undefined ? [] : processedSignalIds,
  };
}

/** Read the persisted session binding (workspace/taskId/preset) for a session. */
function bindingForSession(installRoot, sessionId) {
  try {
    const document = JSON.parse(
      fs.readFileSync(path.join(installRoot, 'data', 'routing', 'session-bindings.json'), 'utf8'),
    );
    if (document && document.schemaVersion === 1 && document.bindings && typeof document.bindings === 'object') {
      return document.bindings[sessionId] || null;
    }
  } catch {
    /* callers fail closed */
  }
  return null;
}

const MAX_PROCESSED_SIGNAL_IDS = 100;

function processedSignalIdsOf(block) {
  if (!block || !Array.isArray(block.processedSignalIds)) return [];
  return block.processedSignalIds.filter((id) => typeof id === 'string').slice(-MAX_PROCESSED_SIGNAL_IDS);
}
/**
 * THE per-call adaptive resolution (Phase 2 seam). Reads task-local
 * reasoning state from the routing-state file addressed by the binding,
 * resolves through the Governor against the actual registry entry, and on
 * success atomically writes back state.reasoning (= resolved effort),
 * museReasoning.currentEffort, and the lastResolution diagnostic. Returns
 * { effort, reason, trace, requested } for the request boundary to enforce.
 *
 * Throws MuseReasoningCapabilityError when no explicitly supported effort
 * exists at-or-below the request (the caller must NOT send the request and
 * must NOT fall back to the profile default). On throw, routing state is
 * left byte-identical -- currentEffort never pretends an effort was used.
 * Pure policy lives only in the governor; this function performs no policy
 * of its own (no phase mapping, no thresholds, no ladder logic).
 */
function prepareMuseRequestEffort({ installRoot, binding, target } = {}) {
  if (typeof installRoot !== 'string' || installRoot === '') {
    throw new TypeError('prepareMuseRequestEffort requires installRoot.');
  }
  if (!binding || typeof binding !== 'object') {
    throw new TypeError('prepareMuseRequestEffort requires binding.');
  }
  const statePath = profiles.routingStatePath(installRoot, binding);
  if (!statePath) throw new TypeError('prepareMuseRequestEffort cannot address routing state.');
  const routingState = readJson(statePath);
  if (!routingState) {
    const error = new Error('Muse adaptive reasoning refused: routing state is missing.');
    error.code = 'nexus-execution-target-unavailable';
    throw error;
  }
  const reasoningState = museReasoningStateOf(routingState);
  const registryEntry = registryEntryFor(installRoot, target || routingState);
  const resolved = governor.resolveMuseReasoningEffortForRequest({
    state: reasoningState,
    registryEntry,
  });
  // The requested effort is the Governor trace's first step (always
  // 'phase:<phase>-><effort>' by the governor's contract). Parsed with
  // validation -- never duplicated policy: the runtime re-derives no phase
  // mapping, threshold, or ladder logic of its own.
  const requested = requestedEffortOfTrace(resolved.trace, reasoningState.phase, resolved.effort);
  const nowUtc = new Date().toISOString();
  const next = {
    ...routingState,
    reasoning: resolved.effort,
    museReasoning: blockFromState(
      { ...reasoningState, currentEffort: resolved.effort },
      {
        phase: reasoningState.phase,
        requestedEffort: requested,
        resolvedEffort: resolved.effort,
        reason: resolved.reason,
        trace: Array.from(resolved.trace),
        atUtc: nowUtc,
      },
      // Resolution never clears signal history: dedup survives requests.
      processedSignalIdsOf(stateBlockOf(routingState)),
    ),
  };
  writeAtomicJson(statePath, next);
  return {
    effort: resolved.effort,
    reason: resolved.reason,
    trace: resolved.trace,
    requested,
  };
}

/**
 * Apply one validated control-signal transition to the task-local reasoning
 * block addressed by the binding. The mutate callback receives the current
 * validated state and must return a patch object; the result is normalized
 * (fail-closed) and persisted with lastResolution preserved. Returns the new
 * validated state. Transitions never set effort directly.
 */
function transitionMuseReasoningState({ installRoot, binding, mutate, recordSignalId } = {}) {
  if (typeof installRoot !== 'string' || installRoot === '') {
    throw new TypeError('Muse reasoning transition requires installRoot.');
  }
  if (!binding || typeof binding !== 'object') {
    throw new TypeError('Muse reasoning transition requires binding.');
  }
  if (typeof mutate !== 'function') {
    throw new TypeError('Muse reasoning transition requires a mutate function.');
  }
  if (recordSignalId !== undefined && (typeof recordSignalId !== 'string' || recordSignalId === '')) {
    throw new TypeError('Muse reasoning recordSignalId must be a non-empty string when present.');
  }
  const statePath = profiles.routingStatePath(installRoot, binding);
  if (!statePath) throw new TypeError('Muse reasoning transition cannot address routing state.');
  const routingState = readJson(statePath);
  if (!routingState) {
    const error = new Error('Muse reasoning transition refused: routing state is missing.');
    error.code = 'nexus-execution-target-unavailable';
    throw error;
  }
  const current = museReasoningStateOf(routingState);
  const patch = mutate(current);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('Muse reasoning transition must produce a patch object.');
  }
  const nextState = governor.updateMuseReasoningState(current, patch);
  const block = stateBlockOf(routingState);
  const preserved = block && block.lastResolution !== undefined ? block.lastResolution : null;
  let signalIds = processedSignalIdsOf(block);
  if (recordSignalId !== undefined) {
    signalIds = signalIds.filter((id) => id !== recordSignalId).concat([recordSignalId]).slice(-MAX_PROCESSED_SIGNAL_IDS);
  }
  const next = {
    ...routingState,
    museReasoning: blockFromState(nextState, preserved, signalIds),
  };
  writeAtomicJson(statePath, next);
  return nextState;
}

function setMuseReasoningPhase({ installRoot, binding, phase } = {}) {
  return transitionMuseReasoningState({
    installRoot,
    binding,
    mutate: () => ({ phase }),
  });
}

function markMuseRootCauseEstablished({ installRoot, binding, established = true } = {}) {
  if (typeof established !== 'boolean') throw new TypeError('established must be boolean.');
  return transitionMuseReasoningState({
    installRoot,
    binding,
    mutate: () => ({ rootCauseEstablished: established }),
  });
}

function markMuseSolutionEstablished({ installRoot, binding, established = true } = {}) {
  if (typeof established !== 'boolean') throw new TypeError('established must be boolean.');
  return transitionMuseReasoningState({
    installRoot,
    binding,
    mutate: () => ({ solutionEstablished: established }),
  });
}

function recordMuseHypothesisFailure({ installRoot, binding } = {}) {
  let observed = 0;
  transitionMuseReasoningState({
    installRoot,
    binding,
    mutate: (current) => {
      observed = current.failedHypotheses + 1;
      return { failedHypotheses: observed };
    },
  });
  return observed;
}

function recordMuseImplementationFailure({ installRoot, binding } = {}) {
  let observed = 0;
  transitionMuseReasoningState({
    installRoot,
    binding,
    mutate: (current) => {
      observed = current.failedImplementationAttempts + 1;
      return { failedImplementationAttempts: observed };
    },
  });
  return observed;
}

function setMuseConflictingEvidence({ installRoot, binding, conflicting = true } = {}) {
  if (typeof conflicting !== 'boolean') throw new TypeError('conflicting must be boolean.');
  return transitionMuseReasoningState({
    installRoot,
    binding,
    mutate: () => ({ conflictingEvidence: conflicting }),
  });
}

function requestMuseMaxReasoning({ installRoot, binding, request = true } = {}) {
  if (typeof request !== 'boolean') throw new TypeError('request must be boolean.');
  return transitionMuseReasoningState({
    installRoot,
    binding,
    mutate: () => ({ requestMax: request }),
  });
}

module.exports = {
  MAX_PROCESSED_SIGNAL_IDS,
  bindingForSession,
  processedSignalIdsOf,
  museReasoningStateOf,
  registryEntryFor,
  prepareMuseRequestEffort,
  transitionMuseReasoningState,
  setMuseReasoningPhase,
  markMuseRootCauseEstablished,
  markMuseSolutionEstablished,
  recordMuseHypothesisFailure,
  recordMuseImplementationFailure,
  setMuseConflictingEvidence,
  requestMuseMaxReasoning,
};
