'use strict';

/**
 * Muse-ReasoningActivity.cjs -- Phase 2.2 (TASK-0049) trusted operational
 * evidence for the Muse adaptive reasoning governor (agent preset aih-muse).
 *
 * Muse-specific trusted-plane module. Dual/GLM/Codex planes never require
 * it. Pure CommonJS: no DSH runtime dependency, so deterministic tests drive
 * it against plain values and fixture roots.
 *
 * Authority boundary (the core principle of this phase):
 *
 *   SEMANTIC state -- things only the engineering agent can report:
 *     cognitive phase, established diagnosis/solution, disproven hypothesis,
 *     failed implementation approach, conflicting evidence. Written ONLY by
 *     the validated model-facing signal path (Muse-ReasoningSignals.cjs).
 *
 *   OPERATIONAL evidence -- things Nexus knows objectively from execution:
 *     a real mutation succeeded, verification started/passed/failed, and the
 *     ordering of those events against semantic transitions. Written ONLY by
 *     the trusted observer below (observeToolOutcome), which reads the frozen
 *     tool execution/result the DSH pipeline publishes -- never model prose,
 *     todo text, tool descriptions, or claimed activity.
 *
 * The Governor consumes NEITHER directly. A deterministic reducer
 * (reduceEffectiveState) derives the EFFECTIVE compute state from both, and
 * the existing Governor policy maps that effective state to effort. The
 * reducer never rewrites semantic.phase: an experimental edit during
 * diagnosis records activity, not a phase change.
 *
 * Effective compute states:
 *   - semantic -- no trusted activity overrides the semantic phase.
 *   - implementation-active -- a trusted mutation succeeded after the latest
 *     explicit semantic transition, so the trajectory is operationally in
 *     implementation even when Muse forgot to report phase=implement.
 *   - verification-passed -- recognized verification succeeded; stays on the
 *     normal verify compute path (informational, no escalation).
 *   - recovery-needed -- recognized verification failed; the next request
 *     receives the existing recover policy even when Muse forgot recover.
 *
 * Ordering: every semantic transition and every operational milestone carries
 * a strictly increasing sequence number (one counter per task block). A newer
 * explicit semantic transition supersedes older operational evidence; newer
 * trusted activity supersedes the older semantic baseline. No monotonic FSM
 * is assumed: trajectories may legitimately cycle
 * discover -> design -> implement -> verify -> recover -> diagnose -> ...
 *
 * Anti-thrash: operational milestones fire ONCE per active period. Twenty
 * more edits after the first implementation-active transition remain
 * implementation-active; repeated mutations never churn state.
 */

const MUSE_ACTIVITY_SCHEMA_VERSION = 1;

/** Tool executions that count as strong, objective mutation evidence. */
const MUTATION_TOOL_NAMES = Object.freeze(['write', 'edit']);

/** Tool executions that are read-only observation, never implementation. */
const READONLY_TOOL_NAMES = Object.freeze(['read', 'read_image', 'glob', 'grep']);

/** Shell tools whose foreground command text is eligible for verification classification. */
const SHELL_TOOL_NAMES = Object.freeze(['pwsh', 'bash']);

/**
 * Conservative recognized-verification matchers over shell command text.
 * Case-insensitive substring search: deterministic, auditable, narrow.
 * Anything not matched here (git status, listings, ad-hoc scripts) is NOT verification.
 */
const VERIFICATION_MATCHERS = Object.freeze([
  { family: 'node-test', pattern: 'npm test' },
  { family: 'node-test', pattern: 'npm run test' },
  { family: 'node-test', pattern: 'npx jest' },
  { family: 'node-test', pattern: 'npx vitest' },
  { family: 'node-test', pattern: 'node --test' },
  { family: 'dotnet-test', pattern: 'dotnet test' },
  { family: 'python-test', pattern: 'pytest' },
  { family: 'python-test', pattern: 'python -m pytest' },
  { family: 'python-test', pattern: 'python -m unittest' },
  { family: 'go-test', pattern: 'go test' },
  { family: 'rust-test', pattern: 'cargo test' },
  { family: 'typecheck', pattern: 'tsc --noemit' },
  { family: 'typecheck', pattern: 'tsc -p' },
  { family: 'lint', pattern: 'eslint' },
  { family: 'build', pattern: 'npm run build' },
  { family: 'dotnet-build', pattern: 'dotnet build' },
  { family: 'rust-build', pattern: 'cargo build' },
  { family: 'verify-script', pattern: 'verify' },
]);

const EFFECTIVE_STATES = Object.freeze([
  'semantic',
  'implementation-active',
  'verification-passed',
  'recovery-needed',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRevision(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Create the initial activity block for a task lifecycle. */
function createMuseActivityState() {
  return {
    schemaVersion: MUSE_ACTIVITY_SCHEMA_VERSION,
    revision: 0,
    semanticRevision: 0,
    lastMutationRevision: 0,
    mutationCount: 0,
    verification: { status: 'none', revision: 0, family: null },
  };
}

/**
 * Normalize a persisted activity block. Missing -> empty state (legacy
 * states predate activity); present-but-malformed -> throw fail-closed.
 */
function normalizeMuseActivityState(block) {
  if (block === undefined || block === null) return createMuseActivityState();
  if (!isPlainObject(block)) {
    throw new TypeError('Muse activity state must be a plain object.');
  }
  if (block.schemaVersion !== MUSE_ACTIVITY_SCHEMA_VERSION) {
    throw new TypeError('Muse activity state schemaVersion must be 1.');
  }
  const revision = normalizeRevision(block.revision);
  const semanticRevision = normalizeRevision(block.semanticRevision);
  const lastMutationRevision = normalizeRevision(block.lastMutationRevision);
  const mutationCount = normalizeRevision(block.mutationCount);
  const verification = block.verification;
  const status = verification && typeof verification.status === 'string' ? verification.status : null;
  if (status !== 'none' && status !== 'started' && status !== 'passed' && status !== 'failed') {
    throw new TypeError('Muse activity verification.status must be none|started|passed|failed.');
  }
  if (verification && verification.family !== null && verification.family !== undefined && typeof verification.family !== 'string') {
    throw new TypeError('Muse activity verification.family must be a string or null.');
  }
  const verificationRevision = verification ? normalizeRevision(verification.revision) : 0;
  const family = verification && typeof verification.family === 'string' ? verification.family : null;
  return {
    schemaVersion: MUSE_ACTIVITY_SCHEMA_VERSION,
    revision,
    semanticRevision,
    lastMutationRevision,
    mutationCount,
    verification: { status, revision: verificationRevision, family },
  };
}

/**
 * Mark an explicit semantic transition. Bumps the shared revision and
 * re-baselines the semantic frontier so older activity no longer overrides
 * the new phase. Pure -- the caller persists the result.
 */
function markSemanticTransition(activity, phase) {
  const current = normalizeMuseActivityState(activity);
  if (typeof phase !== 'string' || phase.trim() === '') {
    throw new TypeError('markSemanticTransition requires a phase string.');
  }
  const revision = current.revision + 1;
  return {
    ...current,
    revision,
    semanticRevision: revision,
  };
}

function commandTextOf(exec) {
  try {
    const args = exec && exec.arguments;
    if (!isPlainObject(args)) return '';
    const command = args.command;
    return typeof command === 'string' ? command : '';
  } catch {
    return '';
  }
}

function exitCodeOf(value) {
  try {
    if (!isPlainObject(value)) return null;
    const exitCode = value.exitCode;
    if (exitCode === null) return null;
    return typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode : null;
  } catch {
    return null;
  }
}

/**
 * Classify a shell execution as recognized verification from command text.
 * Returns the matcher family or null. Conservative: only listed families qualify.
 */
function classifyVerificationCommand(commandText) {
  if (typeof commandText !== 'string' || commandText === '') return null;
  const lowered = commandText.toLowerCase();
  for (const matcher of VERIFICATION_MATCHERS) {
    if (lowered.indexOf(matcher.pattern) >= 0) return matcher.family;
  }
  return null;
}

/**
 * Interpret one frozen tool outcome as trusted operational evidence.
 * Reads ONLY pipeline facts (exec.name/arguments, result.isError/value).
 * Failed outcomes NEVER produce milestones. Never touches failure counters.
 */
function classifyToolOutcome(exec, result) {
  if (!isPlainObject(exec) || typeof exec.name !== 'string') {
    return { kind: 'ignored', reason: 'malformed-exec' };
  }
  if (!isPlainObject(result)) {
    return { kind: 'ignored', reason: 'malformed-result' };
  }
  const name = exec.name;
  if (name === 'run_code') {
    return { kind: 'ignored', reason: 'composite-transport' };
  }
  if (READONLY_TOOL_NAMES.includes(name)) {
    return { kind: 'ignored', reason: 'readonly-observation' };
  }
  if (MUTATION_TOOL_NAMES.includes(name)) {
    if (result.isError === true) {
      return { kind: 'ignored', reason: 'failed-mutation' };
    }
    return { kind: 'mutation' };
  }
  if (SHELL_TOOL_NAMES.includes(name)) {
    const family = classifyVerificationCommand(commandTextOf(exec));
    if (family === null) {
      return { kind: 'ignored', reason: 'unrecognized-shell' };
    }
    if (result.isError === true) {
      return { kind: 'ignored', reason: 'shell-infrastructure-error' };
    }
    const value = result.value;
    if (!isPlainObject(value)) {
      return { kind: 'verification', family, outcome: 'started' };
    }
    if (value.kind === 'background') {
      return { kind: 'verification', family, outcome: 'started' };
    }
    const exitCode = exitCodeOf(value);
    if (exitCode === null) {
      return { kind: 'verification', family, outcome: 'started' };
    }
    return { kind: 'verification', family, outcome: exitCode === 0 ? 'passed' : 'failed' };
  }
  return { kind: 'ignored', reason: 'unrecognized-tool' };
}

/**
 * Fold one classification into the activity block. Pure.
 * Mutation milestone fires once per active period (anti-thrash).
 * Verification records a fresh revision only when the outcome changes.
 */
function applyClassification(activity, classification) {
  const current = normalizeMuseActivityState(activity);
  if (!isPlainObject(classification) || typeof classification.kind !== 'string') {
    throw new TypeError('applyClassification requires a classification object.');
  }
  if (classification.kind === 'ignored') {
    return current;
  }
  if (classification.kind === 'mutation') {
    const firstAfterFrontier = !(current.lastMutationRevision > current.semanticRevision);
    const revision = firstAfterFrontier ? current.revision + 1 : current.revision;
    const lastMutationRevision = firstAfterFrontier ? revision : current.lastMutationRevision;
    return {
      ...current,
      revision,
      lastMutationRevision,
      mutationCount: current.mutationCount + 1,
    };
  }
  if (classification.kind === 'verification') {
    const status = classification.outcome;
    if (status !== 'started' && status !== 'passed' && status !== 'failed') {
      throw new TypeError('verification classification outcome must be started|passed|failed.');
    }
    const family = typeof classification.family === 'string' ? classification.family : null;
    if (status === current.verification.status) {
      return {
        ...current,
        verification: { status, revision: current.verification.revision, family },
      };
    }
    const revision = current.revision + 1;
    return {
      ...current,
      revision,
      verification: { status, revision, family },
    };
  }
  throw new TypeError('Unknown activity classification kind: ' + classification.kind + '.');
}

/**
 * Observe one frozen tool outcome for a Muse session. Classifies and persists
 * EXACTLY one atomic activity write (or no write when ignored). Muse-only
 * (preset aih-muse re-checked fail-closed). Returns { classification, activity }.
 */
function observeToolOutcome({ installRoot, binding, exec, result, transition } = {}) {
  if (typeof installRoot !== 'string' || installRoot === '') {
    throw new TypeError('observeToolOutcome requires installRoot.');
  }
  if (!binding || typeof binding !== 'object') {
    const error = new Error('Muse activity observation rejected (unbound-session): no controller task binding.');
    error.code = 'nexus-execution-target-unavailable';
    throw error;
  }
  if (binding.preset !== 'aih-muse') {
    const error = new Error('Muse activity observation rejected (wrong-engine): observations apply to aih-muse sessions only.');
    error.code = 'nexus-muse-engine-mismatch';
    throw error;
  }
  if (typeof transition !== 'function') {
    throw new TypeError('observeToolOutcome requires a transition function.');
  }
  const classification = classifyToolOutcome(exec, result);
  if (classification.kind === 'ignored') {
    return { classification, activity: null };
  }
  const activity = transition((current) => applyClassification(current, classification));
  return { classification, activity };
}

/**
 * Deterministic reducer: effective compute state from semantic + activity.
 * Rules: failed-fresh-verification -> recover; fresh-mutation -> implement;
 * passed-verification while semantic=verify -> verify; else semantic phase.
 * Never rewrites semantic.phase; never selects effort (Governor owns that).
 */
function reduceEffectiveState({ phase, activity } = {}) {
  if (typeof phase !== 'string' || phase.trim() === '') {
    throw new TypeError('reduceEffectiveState requires a semantic phase string.');
  }
  const semanticPhase = phase.trim().toLowerCase();
  const normalized = normalizeMuseActivityState(activity);
  const verification = normalized.verification;
  const verificationFresh = verification.status !== 'none' && verification.revision > normalized.semanticRevision;
  const mutationFresh = normalized.lastMutationRevision > normalized.semanticRevision;
  if (verificationFresh && verification.status === 'failed') {
    return { effectivePhase: 'recover', source: 'recovery-needed', activityState: 'recovery-needed' };
  }
  if (mutationFresh) {
    return { effectivePhase: 'implement', source: 'implementation-active', activityState: 'implementation-active' };
  }
  if (verificationFresh && verification.status === 'passed' && semanticPhase === 'verify') {
    return { effectivePhase: 'verify', source: 'verification-passed', activityState: 'verification-passed' };
  }
  return { effectivePhase: semanticPhase, source: 'semantic', activityState: 'none' };
}

module.exports = {
  name: 'aih-muse-reasoning-activity',
  MUSE_ACTIVITY_SCHEMA_VERSION,
  MUTATION_TOOL_NAMES,
  READONLY_TOOL_NAMES,
  SHELL_TOOL_NAMES,
  VERIFICATION_MATCHERS,
  EFFECTIVE_STATES,
  createMuseActivityState,
  normalizeMuseActivityState,
  markSemanticTransition,
  classifyVerificationCommand,
  classifyToolOutcome,
  applyClassification,
  observeToolOutcome,
  reduceEffectiveState,
};

