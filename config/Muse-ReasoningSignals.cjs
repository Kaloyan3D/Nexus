'use strict';

/**
 * Muse-ReasoningSignals.cjs -- Phase 2.1 (TASK-0049) model-facing
 * reasoning-state signals for the Muse engine (agent preset aih-muse).
 *
 * Muse-only preset row (aih-muse-reasoning-signals): contributes ONE tool,
 * muse_update_reasoning_state, to the Muse session's tool registry via the
 * standard DSH mechanism (ctx.tools.register + defineTool, the same pattern
 * as first-party tools such as tool-todo). Dual/GLM/Codex presets never
 * include this row, so no other engine gains the action.
 *
 * Trust boundary (model input is untrusted):
 * - Task identity comes ONLY from the tool execution context
 *   (exec.agent.session.id -> session binding -> taskInstanceId). Model
 *   arguments never supply workspace, task, routing-state path, provider,
 *   model, or capabilities.
 * - The schema carries structured STATE ONLY -- phase, established findings,
 *   failure events, conflicting evidence. There is deliberately NO effort
 *   field (no effort/reasoningEffort/reasoning_effort, no raw counters, no
 *   currentEffort, no state replacement): Muse reports reality, Nexus
 *   allocates compute through the Governor.
 * - Counters are event-based (recordHypothesisFailure/recordImplementation-
 *   Failure each mean counter+1 by Nexus); established/conflicting flags are
 *   monotonic (false -> true only); unknown fields are rejected fail-closed.
 * - Model-facing MAX request is intentionally NOT exposed: requestMax is
 *   sticky trusted-plane state and would be an escalation vector with no
 *   model-visible off switch. MAX stays available through the trusted
 *   requestMuseMaxReasoning API only.
 *
 * Timing: a signal affects FUTURE requests only. The tool executes after the
 * current request's effort was already resolved; the next agent/request
 * resolves against the updated state.
 *
 * Retries: the tool pipeline may redeliver a call. Failure-event signals
 * deduplicate on the trusted dispatch identity (rootCallId + token + signal
 * hash, bounded FIFO in state); a redelivered identical signal returns the
 * current ack with duplicate:true and mutates nothing. Distinct calls always
 * apply.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const governor = require('./Muse-ReasoningGovernor.cjs');
const profiles = require('./Engineering-Profiles.cjs');
const runtime = require('./Muse-ReasoningRuntime.cjs');

const MUSE_AGENT_PRESET = 'aih-muse';
const SIGNAL_TOOL_NAME = 'muse_update_reasoning_state';

const SIGNAL_DESCRIPTION = [
  'Report a structured reasoning-state change for the current Muse engineering task.',
  'Call when the trajectory meaningfully changes cognitive phase or when strong evidence is established:',
  'starting investigation (discover), resolving root cause (diagnose), choosing a technical approach (design),',
  'executing an established solution (implement), checking a result (verify), responding to an unexpected',
  'failure (recover), or critically inspecting a candidate result (review).',
  'Also report a confirmed root cause, a confirmed solution, a ruled-out hypothesis, a failed implementation',
  'attempt, or conflicting observations.',
  'Report implement before beginning established implementation work, verify before checking a candidate',
  'implementation, and recover when an unexpected failure turns the task into failure investigation.',
  'Do not call before every ordinary read, edit, or test -- only on meaningful transitions.',
  'Fields are events, not settings: recordHypothesisFailure and recordImplementationFailure each record ONE',
  'event (Nexus counts them). You cannot select reasoning effort and there is no effort field; Nexus validates',
  'every signal and allocates compute from the resulting state.',
].join(' ');

// Fields Muse may send. Everything else -- including any effort, counter,
// identity, provider, or state-replacement field -- is rejected fail-closed.
const SIGNAL_FIELDS = Object.freeze([
  'phase',
  'markRootCauseEstablished',
  'invalidateRootCause',
  'markSolutionEstablished',
  'invalidateSolution',
  'recordHypothesisFailure',
  'recordImplementationFailure',
  'conflictingEvidence',
  'resolveConflictingEvidence',
]);
const SIGNAL_FIELD_SET = new Set(SIGNAL_FIELDS);

// Explicitly forbidden: effort selectors, raw counters/state, identity and
// provider metadata. Listed so the rejection message stays specific without
// revealing policy mechanics.
const FORBIDDEN_SIGNAL_FIELDS = Object.freeze([
  'effort',
  'reasoningEffort',
  'reasoning_effort',
  'medium',
  'high',
  'xhigh',
  'max',
  'failedHypotheses',
  'failedImplementationAttempts',
  'currentEffort',
  'lastResolution',
  'state',
  'requestMax',
  'workspace',
  'taskId',
  'taskInstanceId',
  'sessionId',
  'provider',
  'model',
  'capabilities',
  'routingState',
]);

function signalError(code, message) {
  const error = new Error('Muse reasoning signal rejected (' + code + '): ' + message);
  error.code = code;
  return error;
}

function stableSignalHash(signal) {
  const canonical = {};
  for (const field of SIGNAL_FIELDS) {
    if (signal[field] !== undefined) canonical[field] = signal[field];
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex').slice(0, 32);
}

/**
 * Strict signal validation. Returns the normalized application plan
 * { phase|null, rootCause, solution, hypothesisFailures, implementationFailures,
 *   conflicting, applied[] } or throws fail-closed. Unknown fields, effort
 * fields, raw counters, and non-boolean values are all rejected; explicit
 * false is a no-op (never a reset -- flags are monotonic).
 */
function validateReasoningSignal(signal) {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) {
    throw signalError('invalid-signal', 'signal must be an object.');
  }
  for (const key of Object.keys(signal)) {
    if (FORBIDDEN_SIGNAL_FIELDS.includes(key)) {
      throw signalError('forbidden-field', 'field ' + JSON.stringify(key) + ' cannot be set by the model.');
    }
    if (!SIGNAL_FIELD_SET.has(key)) {
      throw signalError('unknown-field', 'unknown field ' + JSON.stringify(key) + '.');
    }
  }
  const plan = {
    phase: null,
    rootCause: false,
    unrootCause: false,
    solution: false,
    unsolution: false,
    hypothesisFailures: 0,
    implementationFailures: 0,
    conflicting: false,
    resolveConflict: false,
    applied: [],
  };
  if (signal.phase !== undefined) {
    if (typeof signal.phase !== 'string') {
      throw signalError('invalid-phase', 'phase must be a string.');
    }
    const phase = signal.phase.trim().toLowerCase();
    if (!governor.MUSE_REASONING_PHASES.includes(phase)) {
      throw signalError('invalid-phase', 'unknown phase ' + JSON.stringify(signal.phase) + '.');
    }
    plan.phase = phase;
    plan.applied.push('phase');
  }
  const flag = (field, event) => {
    if (signal[field] === undefined || signal[field] === false) return;
    if (signal[field] !== true) {
      throw signalError('invalid-field', 'field ' + field + ' must be true when present.');
    }
    plan[event] = event === 'hypothesisFailures' || event === 'implementationFailures' ? 1 : true;
    plan.applied.push(field);
  };
  flag('markRootCauseEstablished', 'rootCause');
  flag('invalidateRootCause', 'unrootCause');
  flag('markSolutionEstablished', 'solution');
  flag('invalidateSolution', 'unsolution');
  flag('recordHypothesisFailure', 'hypothesisFailures');
  flag('recordImplementationFailure', 'implementationFailures');
  flag('conflictingEvidence', 'conflicting');
  flag('resolveConflictingEvidence', 'resolveConflict');
  return plan;
}

function sessionIdOf(exec) {
  try {
    const agent = exec && exec.agent;
    const session = agent && agent.session;
    const id = session && session.id;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

function dispatchKeyOf(exec, signal) {
  try {
    const rootCallId = exec && exec.rootCallId !== undefined && exec.rootCallId !== null
      ? String(exec.rootCallId)
      : '';
    const callId = exec && exec.callId !== undefined && exec.callId !== null ? String(exec.callId) : '';
    if (rootCallId === '' && callId === '') return null;
    return rootCallId + '|' + callId + '|' + stableSignalHash(signal || {});
  } catch {
    return null;
  }
}
function ackOf(state, duplicate, applied, activityState) {
  const safeActivity = typeof activityState === 'string' ? activityState : 'none';
  return {
    ok: true,
    duplicate: duplicate === true,
    applied: Array.from(applied || []),
    phase: state.phase,
    activityState: safeActivity,
    rootCauseEstablished: state.rootCauseEstablished,
    solutionEstablished: state.solutionEstablished,
    failedHypotheses: state.failedHypotheses,
    failedImplementationAttempts: state.failedImplementationAttempts,
    totalFailedHypotheses: state.totalFailedHypotheses,
    totalFailedImplementationAttempts: state.totalFailedImplementationAttempts,
    conflictingEvidence: state.conflictingEvidence,
  };
}

/**
 * Apply one validated model-facing signal to the task-local reasoning state
 * addressed by the session binding. Trusted-plane core shared by the tool
 * row and deterministic tests: validates the signal, resolves trusted
 * identity, dedupes redelivered failure events, and persists EXACTLY one
 * atomic transition. Returns the model-facing acknowledgement (no effort
 * values -- effort stays Nexus-owned and unobservable-by-design here).
 *
 * Concurrency: the tool pipeline schedules non-concurrency-safe tools
 * exclusively (this tool declares no isConcurrencySafe), so duplicate
 * deliveries serialize through the check-then-write below within one
 * process; the single atomic transition write is the linearization point.
 */
function applyReasoningSignal({ installRoot, binding, signal, dispatchKey } = {}) {
  if (typeof installRoot !== 'string' || installRoot === '') {
    throw new TypeError('applyReasoningSignal requires installRoot.');
  }
  if (!binding || typeof binding !== 'object') {
    const error = new Error('Muse reasoning signal rejected (unbound-session): no controller task binding.');
    error.code = 'nexus-execution-target-unavailable';
    throw error;
  }
  if (binding.preset !== MUSE_AGENT_PRESET) {
    const error = new Error('Muse reasoning signal rejected (wrong-engine): signals apply to aih-muse sessions only.');
    error.code = 'nexus-muse-engine-mismatch';
    throw error;
  }
  const plan = validateReasoningSignal(signal);
  const key = typeof dispatchKey === 'string' && dispatchKey !== '' ? dispatchKey : null;

  const readState = () => {
    const statePath = profiles.routingStatePath(installRoot, binding);
    const text = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(text);
  };

  if (key !== null) {
    const stored = readState();
    const block = stored && stored.museReasoning;
    const seen = runtime.processedSignalIdsOf(block);
    if (seen.includes(key)) {
      return ackOf(runtime.museReasoningStateOf(stored), true, [], runtime.effectiveMuseStateOf(stored).activityState);
    }
  }

  const nextState = runtime.transitionMuseReasoningState({
    installRoot,
    binding,
    recordSignalId: key === null ? undefined : key,
    mutate: (current) => {
      const patch = {};
      if (plan.phase !== null) patch.phase = plan.phase;
      // Monotonic marks: established/conflicting flags only move false ->
      // true here. Explicit invalidation events below are the ONLY path back
      // to false, so casual resets stay impossible while disproven
      // conclusions remain explicitly revocable.
      if (plan.rootCause && !current.rootCauseEstablished) patch.rootCauseEstablished = true;
      if (plan.solution && !current.solutionEstablished) patch.solutionEstablished = true;
      if (plan.conflicting && !current.conflictingEvidence) patch.conflictingEvidence = true;
      if (plan.unrootCause) {
        patch.rootCauseEstablished = false;
        patch.solutionEstablished = false;
      }
      if (plan.unsolution) patch.solutionEstablished = false;
      if (plan.resolveConflict) patch.conflictingEvidence = false;
      if (plan.hypothesisFailures > 0) {
        patch.failedHypotheses = current.failedHypotheses + 1;
        patch.totalFailedHypotheses = current.totalFailedHypotheses + 1;
      }
      if (plan.implementationFailures > 0) {
        patch.failedImplementationAttempts = current.failedImplementationAttempts + 1;
        patch.totalFailedImplementationAttempts = current.totalFailedImplementationAttempts + 1;
      }
      return patch;
    },
  });
  // Phase 2.2: report the deterministic effective activity derived from
  // semantic + trusted operational evidence. Safe by design: a phase label,
  // never effort. Lets Muse see that its implementation work was observed
  // even when it forgot to report phase=implement.
  const stored = readState();
  return ackOf(nextState, false, plan.applied, runtime.effectiveMuseStateOf(stored).activityState);
}

function defineReasoningSignalTool(defineTool) {
  return defineTool({
    name: SIGNAL_TOOL_NAME,
    description: SIGNAL_DESCRIPTION,
    parameters: {
      phase: {
        type: 'string',
        enum: Array.from(governor.MUSE_REASONING_PHASES),
        description: 'New cognitive phase: discover, diagnose, design, implement, verify, recover, or review.',
      },
      markRootCauseEstablished: {
        type: 'boolean',
        description: 'The root cause is confirmed. Event: true records it and opens a fresh diagnosis window; omit or false for no change.',
      },
      invalidateRootCause: {
        type: 'boolean',
        description: 'Later evidence disproved the diagnosis. Event: true clears both the root cause and the solution; omit or false for no change.',
      },
      markSolutionEstablished: {
        type: 'boolean',
        description: 'The technical solution is confirmed. Event: true records it and opens a fresh implementation window; omit or false for no change.',
      },
      invalidateSolution: {
        type: 'boolean',
        description: 'Implementation evidence disproved the chosen approach (diagnosis still holds). Event: true clears the solution only; omit or false for no change.',
      },
      recordHypothesisFailure: {
        type: 'boolean',
        description: 'One ruled-out hypothesis. Event: true records exactly one failure; Nexus counts.',
      },
      recordImplementationFailure: {
        type: 'boolean',
        description: 'One failed implementation attempt. Event: true records exactly one failure; Nexus counts.',
      },
      conflictingEvidence: {
        type: 'boolean',
        description: 'Observations genuinely conflict. Event: true records it; omit or false for no change.',
      },
      resolveConflictingEvidence: {
        type: 'boolean',
        description: 'New evidence reconciled the conflict. Event: true clears it; omit or false for no change.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          duplicate: { type: 'boolean' },
          applied: { type: 'array', items: { type: 'string' } },
          phase: { type: 'string' },
          rootCauseEstablished: { type: 'boolean' },
          solutionEstablished: { type: 'boolean' },
          failedHypotheses: { type: 'integer' },
          failedImplementationAttempts: { type: 'integer' },
          totalFailedHypotheses: { type: 'integer' },
          totalFailedImplementationAttempts: { type: 'integer' },
          conflictingEvidence: { type: 'boolean' },
          activityState: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderAck(value) }],
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === null) {
        throw new Error('Muse reasoning signal rejected (no-agent-session): the call has no owning agent session.');
      }
      const installRoot = profiles.installRootOf();
      const binding = runtime.bindingForSession(installRoot, sessionId);
      return applyReasoningSignal({
        installRoot,
        binding,
        signal: args,
        dispatchKey: dispatchKeyOf(exec, args),
      });
    },
  });
}

function renderAck(value) {
  if (!value || typeof value !== 'object') return 'Reasoning state signal recorded.';
  const lines = [
    'Reasoning state updated' + (value.duplicate === true ? ' (duplicate delivery ignored)' : '') + ':',
    'phase: ' + String(value.phase),
    'rootCauseEstablished: ' + String(value.rootCauseEstablished),
    'solutionEstablished: ' + String(value.solutionEstablished),
    'failedHypotheses: ' + String(value.failedHypotheses),
    'failedImplementationAttempts: ' + String(value.failedImplementationAttempts),
    'totalFailedHypotheses: ' + String(value.totalFailedHypotheses),
    'totalFailedImplementationAttempts: ' + String(value.totalFailedImplementationAttempts),
    'conflictingEvidence: ' + String(value.conflictingEvidence),
    'activityState: ' + String(value.activityState === undefined ? 'none' : value.activityState),
  ];
  if (Array.isArray(value.applied)) lines.push('applied: ' + (value.applied.length ? value.applied.join(', ') : '(none)'));
  return lines.join('\n');
}

/**
 * Resolve the Muse session binding for a frozen tool execution. Returns the
 * binding when the owning session is bound to preset aih-muse, else null
 * (unbound sessions and Dual/GLM/Codex sessions never produce observations).
 */
function museBindingForExec(installRoot, exec) {
  try {
    const agent = exec && exec.agent;
    const session = agent && agent.session;
    const sessionId = session && typeof session.id === 'string' && session.id !== '' ? session.id : null;
    if (sessionId === null) return null;
    const binding = runtime.bindingForSession(installRoot, sessionId);
    if (!binding || binding.preset !== MUSE_AGENT_PRESET) return null;
    return binding;
  } catch {
    return null;
  }
}

/**
 * Trusted observer: classify one frozen tool outcome and persist operational
 * evidence. Observe-only by contract: never throws for tool failures or
 * unrecognized tools (those are ignored), never modifies semantic state,
 * never touches failure counters, never influences the in-flight result.
 * Session-file errors are swallowed (best-effort observation must not break
 * tool execution); binding/preset violations fail closed inside the runtime.
 */
function observeMuseToolResult({ installRoot, binding, exec, result } = {}) {
  try {
    if (typeof installRoot !== 'string' || installRoot === '') return null;
    if (!binding || binding.preset !== MUSE_AGENT_PRESET) return null;
    const outcome = runtime.recordMuseToolOutcome({ installRoot, binding, exec, result });
    return outcome;
  } catch {
    return null;
  }
}

function apply(ctx) {
  const tools = ctx && ctx.tools;
  if (!tools || typeof tools.register !== 'function') {
    throw new Error('Muse reasoning signals require the ctx.tools registry.');
  }
  const requireFromApp = createRequire(path.join(profiles.installRootOf(), 'app', 'package.json'));
  const dshTools = requireFromApp('@deepseek-ai/dsh-tools');
  if (!dshTools || typeof dshTools.defineTool !== 'function') {
    throw new Error('Muse reasoning signals require defineTool from @deepseek-ai/dsh-tools.');
  }
  const definition = defineReasoningSignalTool(dshTools.defineTool);
  tools.register(definition);
  // Phase 2.2 trusted observer (Muse-only, observe-only): the DSH pipeline
  // publishes every settled tool outcome as an immutable tools/result event
  // (scoped to this preset's agent layer, like dsh-agent-instructions).
  // Successful write/edit outcomes record implementation activity; recognized
  // verification commands record verification outcomes. Reads, searches,
  // generic shell, failed tools, and non-Muse sessions are ignored.
  if (ctx && typeof ctx.on === 'function') {
    ctx.on('tools/result', (exec, result) => {
      try {
        if (!exec || exec.agent === undefined) return;
        const root = profiles.installRootOf();
        const binding = museBindingForExec(root, exec);
        if (binding === null) return;
        observeMuseToolResult({ installRoot: root, binding, exec, result });
      } catch {
        // Observer errors must never break tool execution.
      }
    });
  }
  return definition;
}

module.exports = {
  name: 'aih-muse-reasoning-signals',
  inject: ['tools'],
  apply,
  SIGNAL_TOOL_NAME,
  SIGNAL_DESCRIPTION,
  SIGNAL_FIELDS,
  FORBIDDEN_SIGNAL_FIELDS,
  validateReasoningSignal,
  applyReasoningSignal,
  defineReasoningSignalTool,
  dispatchKeyOf,
  sessionIdOf,
  museBindingForExec,
  observeMuseToolResult,
};
