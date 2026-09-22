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
 * Conservative boundary-aware verification recognition over shell text.
 * The command is split into REAL invocations (on ; && || | pipes/newlines),
 * each invocation is tokenized quote-aware, and a KNOWN executable in
 * command position must be followed by a KNOWN verification verb as a
 * separate token. Verbatim token equality only -- never substring, so a
 * filename, path, comment, or unrelated token that merely CONTAINS
 * test/build/verify/lint never matches.
 *
 * Supported (executable first, then verb/script as its own token):
 *   npm test | npm run <test|typecheck|lint|build|verify>
 *   pnpm [--filter <sel>]... <test|run <script>|vitest|jest|<script>>
 *   yarn|bun [run] <test|typecheck|lint|build|verify>
 *   npx <vitest|jest|tsc|eslint> | node --test | vitest | jest
 *   tsc | eslint | pytest | python -m <pytest|unittest>
 *   dotnet <test|build> | cargo <test|build> | go test
 */
const PACKAGE_MANAGER_SCRIPT_NAMES = Object.freeze([String.fromCharCode(116,101,115,116), String.fromCharCode(116,121,112,101,99,104,101,99,107), String.fromCharCode(108,105,110,116), String.fromCharCode(98,117,105,108,100), String.fromCharCode(118,101,114,105,102,121)]);
const PNPM_OPTION_TOKENS = Object.freeze([String.fromCharCode(45,45,102,105,108,116,101,114), String.fromCharCode(45,70), String.fromCharCode(45,45,100,105,114)]);
const PNPM_FLAG_PREFIXES = Object.freeze([String.fromCharCode(45,45,102,105,108,116,101,114,61), String.fromCharCode(45,70,61)]);
const DOTNET_VERBS = Object.freeze([String.fromCharCode(116,101,115,116), String.fromCharCode(98,117,105,108,100)]);
const CARGO_VERBS = Object.freeze([String.fromCharCode(116,101,115,116), String.fromCharCode(98,117,105,108,100)]);

function stripTokenQuotes(token) {
  if (token.length >= 2) {
    const code = token.charCodeAt(0);
    const last = token.charCodeAt(token.length - 1);
    if (code === last && (code === 34 || code === 39 || code === 96)) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function splitInvocations(commandText) {
  const parts = [];
  let current = String.fromCharCode();
  let quote = null;
  for (let i = 0; i < commandText.length; i += 1) {
    const ch = commandText[i];
    const code = commandText.charCodeAt(i);
    if (quote !== null) {
      current += ch;
      if (code === quote) quote = null;
    } else if (code === 34 || code === 39 || code === 96) {
      quote = code;
      current += ch;
    } else if (code === 59 || code === 124 || code === 38 || code === 10) {
      parts.push(current);
      current = String.fromCharCode();
      if ((code === 38 && commandText.charCodeAt(i + 1) === 38) || (code === 124 && commandText.charCodeAt(i + 1) === 124)) i += 1;
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function tokenizeInvocation(invocation) {
  const tokens = [];
  let current = String.fromCharCode();
  let quote = null;
  let inToken = false;
  const flush = () => {
    if (inToken) { tokens.push(stripTokenQuotes(current)); current = String.fromCharCode(); inToken = false; }
  };
  for (let i = 0; i < invocation.length; i += 1) {
    const ch = invocation[i];
    const code = invocation.charCodeAt(i);
    if (quote !== null) {
      if (code === quote) { quote = null; } else { current += ch; }
      inToken = true;
    } else if (code === 34 || code === 39 || code === 96) {
      quote = code;
      inToken = true;
    } else if (code === 32 || code === 9 || code === 13) {
      flush();
    } else {
      current += ch;
      inToken = true;
    }
  }
  flush();
  return tokens.filter((t) => t !== String.fromCharCode());
}

function skipPnpmOptions(tokens, index) {
  let i = index;
  for (;;) {
    const tok = tokens[i];
    if (tok === undefined) return i;
    if (PNPM_OPTION_TOKENS.includes(tok)) { i += 2; continue; }
    let inline = false;
    for (const prefix of PNPM_FLAG_PREFIXES) { if (tok.indexOf(prefix) === 0) { inline = true; break; } }
    if (inline || (tok.charCodeAt(0) === 45 && tok !== String.fromCharCode(45))) { i += 1; continue; }
    return i;
  }
}

function scriptFamilyOf(scriptName) {
  if (scriptName === String.fromCharCode(116,101,115,116)) return String.fromCharCode(110,111,100,101,45,116,101,115,116);
  if (scriptName === String.fromCharCode(116,121,112,101,99,104,101,99,107)) return String.fromCharCode(116,121,112,101,99,104,101,99,107);
  if (scriptName === String.fromCharCode(108,105,110,116)) return String.fromCharCode(108,105,110,116);
  if (scriptName === String.fromCharCode(98,117,105,108,100)) return String.fromCharCode(98,117,105,108,100);
  return String.fromCharCode(118,101,114,105,102,121,45,115,99,114,105,112,116);
}

function lowerAt(tokens, n) {
  const t = tokens[n];
  return t === undefined ? null : String(t).toLowerCase();
}

function matchInvocationTokens(tokens) {
  if (tokens.length === 0) return null;
  const exe = String(tokens[0]).toLowerCase();
  const a1 = lowerAt(tokens, 1);
  const a2 = lowerAt(tokens, 2);
  if (exe === String.fromCharCode(110,112,109)) {
    if (a1 === String.fromCharCode(116,101,115,116) && tokens[2] === undefined) return String.fromCharCode(110,111,100,101,45,116,101,115,116);
    if (a1 === String.fromCharCode(114,117,110) && PACKAGE_MANAGER_SCRIPT_NAMES.includes(a2 || String.fromCharCode())) return scriptFamilyOf(a2);
    return null;
  }
  if (exe === String.fromCharCode(112,110,112,109) || exe === String.fromCharCode(121,97,114,110) || exe === String.fromCharCode(98,117,110)) {
    const vi = skipPnpmOptions(tokens, 1);
    const verb = lowerAt(tokens, vi);
    if (verb === null) return null;
    if (verb === String.fromCharCode(116,101,115,116) && tokens[vi + 1] === undefined) return String.fromCharCode(110,111,100,101,45,116,101,115,116);
    if (verb === String.fromCharCode(114,117,110) && PACKAGE_MANAGER_SCRIPT_NAMES.includes(lowerAt(tokens, vi + 1) || String.fromCharCode())) return scriptFamilyOf(lowerAt(tokens, vi + 1));
    if (PACKAGE_MANAGER_SCRIPT_NAMES.includes(verb)) return scriptFamilyOf(verb);
    if (verb === String.fromCharCode(118,105,116,101,115,116) || verb === String.fromCharCode(106,101,115,116)) return String.fromCharCode(110,111,100,101,45,116,101,115,116);
    return null;
  }
  if (exe === String.fromCharCode(110,112,120)) {
    if (a1 === String.fromCharCode(118,105,116,101,115,116) || a1 === String.fromCharCode(106,101,115,116)) return String.fromCharCode(110,111,100,101,45,116,101,115,116);
    if (a1 === String.fromCharCode(116,115,99)) return String.fromCharCode(116,121,112,101,99,104,101,99,107);
    if (a1 === String.fromCharCode(101,115,108,105,110,116)) return String.fromCharCode(108,105,110,116);
    return null;
  }
  if (exe === String.fromCharCode(110,111,100,101) && a1 === String.fromCharCode(45,45,116,101,115,116)) return String.fromCharCode(110,111,100,101,45,116,101,115,116);
  if (exe === String.fromCharCode(118,105,116,101,115,116) || exe === String.fromCharCode(106,101,115,116)) return String.fromCharCode(110,111,100,101,45,116,101,115,116);
  if (exe === String.fromCharCode(116,115,99)) return String.fromCharCode(116,121,112,101,99,104,101,99,107);
  if (exe === String.fromCharCode(101,115,108,105,110,116)) return String.fromCharCode(108,105,110,116);
  if (exe === String.fromCharCode(112,121,116,101,115,116)) return String.fromCharCode(112,121,116,104,111,110,45,116,101,115,116);
  if (exe === String.fromCharCode(112,121,116,104,111,110) && a1 === String.fromCharCode(45,109) && (a2 === String.fromCharCode(112,121,116,101,115,116) || a2 === String.fromCharCode(117,110,105,116,116,101,115,116))) return String.fromCharCode(112,121,116,104,111,110,45,116,101,115,116);
  if (exe === String.fromCharCode(100,111,116,110,101,116) && DOTNET_VERBS.includes(a1 || String.fromCharCode())) return a1 === String.fromCharCode(116,101,115,116) ? String.fromCharCode(100,111,116,110,101,116,45,116,101,115,116) : String.fromCharCode(100,111,116,110,101,116,45,98,117,105,108,100);
  if (exe === String.fromCharCode(99,97,114,103,111) && CARGO_VERBS.includes(a1 || String.fromCharCode())) return a1 === String.fromCharCode(116,101,115,116) ? String.fromCharCode(114,117,115,116,45,116,101,115,116) : String.fromCharCode(114,117,115,116,45,98,117,105,108,100);
  if (exe === String.fromCharCode(103,111) && a1 === String.fromCharCode(116,101,115,116)) return String.fromCharCode(103,111,45,116,101,115,116);
  return null;
}

function classifyVerificationCommand(commandText) {
  if (typeof commandText !== String.fromCharCode(115,116,114,105,110,103) || commandText === String.fromCharCode()) return null;
  const invocations = splitInvocations(commandText);
  for (const invocation of invocations) {
    const family = matchInvocationTokens(tokenizeInvocation(invocation));
    if (family !== null) return family;
  }
  return null;
}

// Canonical vocabulary audit list. classifyVerificationCommand is the
// single entry point; this table documents intent, not matching logic
// (matching is verbatim token equality in matchInvocationTokens).
const VERIFICATION_MATCHERS = Object.freeze([
  { family: String.fromCharCode(110,111,100,101,45,116,101,115,116), pattern: String.fromCharCode(110,112,109,32,116,101,115,116) },
  { family: String.fromCharCode(110,111,100,101,45,116,101,115,116), pattern: String.fromCharCode(110,112,109,32,114,117,110,32,116,101,115,116) },
  { family: String.fromCharCode(110,111,100,101,45,116,101,115,116), pattern: String.fromCharCode(112,110,112,109,32,116,101,115,116) },
  { family: String.fromCharCode(110,111,100,101,45,116,101,115,116), pattern: String.fromCharCode(121,97,114,110,32,116,101,115,116) },
  { family: String.fromCharCode(110,111,100,101,45,116,101,115,116), pattern: String.fromCharCode(98,117,110,32,116,101,115,116) },
  { family: String.fromCharCode(110,111,100,101,45,116,101,115,116), pattern: String.fromCharCode(110,112,120,32,118,105,116,101,115,116) },
  { family: String.fromCharCode(110,111,100,101,45,116,101,115,116), pattern: String.fromCharCode(110,112,120,32,106,101,115,116) },
  { family: String.fromCharCode(110,111,100,101,45,116,101,115,116), pattern: String.fromCharCode(110,111,100,101,32,45,45,116,101,115,116) },
  { family: String.fromCharCode(110,111,100,101,45,116,101,115,116), pattern: String.fromCharCode(118,105,116,101,115,116) },
  { family: String.fromCharCode(110,111,100,101,45,116,101,115,116), pattern: String.fromCharCode(106,101,115,116) },
  { family: String.fromCharCode(100,111,116,110,101,116,45,116,101,115,116), pattern: String.fromCharCode(100,111,116,110,101,116,32,116,101,115,116) },
  { family: String.fromCharCode(112,121,116,104,111,110,45,116,101,115,116), pattern: String.fromCharCode(112,121,116,101,115,116) },
  { family: String.fromCharCode(112,121,116,104,111,110,45,116,101,115,116), pattern: String.fromCharCode(112,121,116,104,111,110,32,45,109,32,112,121,116,101,115,116) },
  { family: String.fromCharCode(112,121,116,104,111,110,45,116,101,115,116), pattern: String.fromCharCode(112,121,116,104,111,110,32,45,109,32,117,110,105,116,116,101,115,116) },
  { family: String.fromCharCode(103,111,45,116,101,115,116), pattern: String.fromCharCode(103,111,32,116,101,115,116) },
  { family: String.fromCharCode(114,117,115,116,45,116,101,115,116), pattern: String.fromCharCode(99,97,114,103,111,32,116,101,115,116) },
  { family: String.fromCharCode(116,121,112,101,99,104,101,99,107), pattern: String.fromCharCode(116,115,99) },
  { family: String.fromCharCode(108,105,110,116), pattern: String.fromCharCode(101,115,108,105,110,116) },
  { family: String.fromCharCode(98,117,105,108,100), pattern: String.fromCharCode(110,112,109,32,114,117,110,32,98,117,105,108,100) },
  { family: String.fromCharCode(100,111,116,110,101,116,45,98,117,105,108,100), pattern: String.fromCharCode(100,111,116,110,101,116,32,98,117,105,108,100) },
  { family: String.fromCharCode(114,117,115,116,45,98,117,105,108,100), pattern: String.fromCharCode(99,97,114,103,111,32,98,117,105,108,100) },
  { family: String.fromCharCode(116,121,112,101,99,104,101,99,107), pattern: String.fromCharCode(112,110,112,109,32,116,121,112,101,99,104,101,99,107) },
  { family: String.fromCharCode(108,105,110,116), pattern: String.fromCharCode(112,110,112,109,32,114,117,110,32,108,105,110,116) },
  { family: String.fromCharCode(118,101,114,105,102,121,45,115,99,114,105,112,116), pattern: String.fromCharCode(110,112,109,32,114,117,110,32,118,101,114,105,102,121) },
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
      // A repeated verification RUN is still a newer operational event than
      // an intervening mutation: re-stamp the revision so recency comparison
      // sees this outcome as newer than the mutation. Terminal 'failed' and
      // 'passed' verdicts always advance; idempotent 'started' repeats do
      // not churn (a launch restated without progress is not newer evidence).
      if (status === 'started') {
        return {
          ...current,
          verification: { status, revision: current.verification.revision, family },
        };
      }
      const restamped = current.revision + 1;
      return {
        ...current,
        revision: restamped,
        verification: { status, revision: restamped, family },
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
 *
 * Recency rule (Phase 2.2-F1): operational evidence resolves by ORDER on the
 * shared revision counter, not by fixed kind precedence. A fresh failed
 * verification and a fresh mutation are compared by revision -- the NEWER
 * milestone wins:
 *   - failed verification newer than the latest mutation -> recover.
 *   - mutation newer than (or equal to, after a same-revision fold) the
 *     failed verification -> implement (the fix supersedes the failure).
 * Passed-verification while semantic=verify stays informational on the
 * verify path; anything older than the semantic frontier never overrides it.
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
  const failedFresh = verificationFresh && verification.status === 'failed';
  if (failedFresh && !(mutationFresh && normalized.lastMutationRevision >= verification.revision)) {
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
