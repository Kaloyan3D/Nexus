'use strict';
/**
 * ContextCompilerActiveV2.cjs - CCV2-C08 active projection authority (pure).
 *
 * The ONE pure authority that decides, for a single already-routed
 * request, whether a validated CCv2-compiled projection may reach the
 * root model. It performs exactly one C01->C06 candidate execution
 * (reusing the frozen shadow pipeline builder, never a second
 * compiler), one physical render, and the full eligibility gate:
 *
 *   verified model capability + verified production tokenizer
 *   valid max context + coherent snapshot/binding
 *   valid ContextView + valid compression + valid layout
 *   valid physical render + valid final token count
 *   mandatory coverage + current-turn exactly-once + tool validity
 *   request binding still current
 *
 * Failure of ANY item -> { eligible:false, mode:'LEGACY',
 * fallbackReason } (deterministic outer fallback to the proven
 * legacy/current projection). Compiler internals stay fail-closed:
 * an invalid candidate is rejected completely, never stripped and
 * partially sent (fail-open means projection fallback, never
 * invariant weakening).
 *
 * This module never touches task truth, checkpoint truth, routing,
 * provider/model selection, tool lifecycle, or the live request: it
 * returns a decision + disposable artifacts. Projection replacement
 * (immutable derived request) lives in
 * config/ContextCompilerActiveHostV2.cjs.
 *
 * No content branching: every gate reads typed metadata (ids,
 * hashes, counts, revisions, fingerprints). Prompt-injected text in
 * exactText/turn text cannot alter activation, budget, routing, or
 * rendering policy.
 *
 * Determinism: no clocks, no randomness, no PIDs, no I/O. Identical
 * inputs -> byte-identical decisions and digests.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (C08 record).
 */

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const viewV2 = require('./ContextViewV2.cjs');
const shadowV2 = require('./ContextCompilerShadowV2.cjs');
const counterV2 = require('./ContextTokenCounterV2.cjs');
const capabilityV2 = require('./ContextModelCapabilityV2.cjs');
const rendererV2 = require('./ContextPromptRendererV2.cjs');

// Single unified rollout authority (conceptually
// contextCompiler.mode). Closed world: off | observe | active.
//   off     -> legacy only, zero C07/C08 work
//   observe -> C07 candidate only, legacy request
//   active  -> attempt validated C08 compiled request + fallback
const COMPILER_MODES = Object.freeze(['off', 'observe', 'active']);
const COMPILER_MODE_ENV_VAR = 'NEXUS_CCV2_COMPILER_MODE';
const ACTIVE_POLICY_REVISION_V1 = 'context-compiler-active-v1';

// Exactly one active projection mode per request (typed diagnostics).
const PROJECTION_MODES = Object.freeze(['LEGACY', 'CCV2_COMPILED']);

// Stable closed-world fallback reasons (C08 contract wording).
const FALLBACK_REASONS = Object.freeze([
  'active-tokenizer-unavailable',
  'active-model-capability-unknown',
  'active-budget-unrepresentable',
  'active-snapshot-stale',
  'active-compiler-failed',
  'active-render-invalid',
  'active-render-over-budget',
  'active-mandatory-coverage-failed',
  'active-current-turn-invalid',
  'active-tool-protocol-invalid',
  'active-request-binding-changed',
]);

const BINDING_EXACT_KEYS = Object.freeze([
  'taskId',
  'taskInstanceId',
  'sessionId',
  'checkpointGeneration',
  'checkpointId',
  'snapshotRevision',
  'turnId',
  'turnTextHash',
  'turnRevision',
  'provider',
  'model',
  'maxTokens',
  'outputReserveTokens',
  'tokenizerFingerprint',
  'capabilityRevision',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256HexUtf8(text) {
  return checkpointV2.sha256HexUtf8(String(text));
}

function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ineligible(reason) {
  return Object.freeze({
    eligible: false,
    mode: 'LEGACY',
    fallbackReason: reason,
    view: null,
    layout: null,
    render: null,
    tokenAccounting: null,
    coverage: null,
    binding: null,
    compilerExecutions: 1,
    telemetry: Object.freeze({
      projectionMode: 'LEGACY',
      fallbackReason: reason,
      compilerExecutions: 1,
    }),
  });
}

/**
 * Resolve the unified compiler mode from one authority:
 * explicit mode > config.contextCompiler.mode > legacy
 * config.contextCompiler.shadowMode (off|observe honored; 'active'
 * via the legacy key is rejected) > NEXUS_CCV2_COMPILER_MODE env >
 * 'off'. Unknown values resolve to off with valid:false (never
 * throws, never activates). An upgrade with old configuration can
 * therefore never silently switch to active.
 */
function resolveCompilerModeV2(input) {
  const source = isPlainObject(input) ? input : {};
  let raw = source.mode;
  let origin = 'explicit';
  if (raw === undefined || raw === null) {
    const cfg = source.config;
    const section = isPlainObject(cfg) && isPlainObject(cfg.contextCompiler) ? cfg.contextCompiler : null;
    if (section !== null && section.mode !== undefined && section.mode !== null) {
      raw = section.mode;
      origin = 'config';
    } else if (section !== null && section.shadowMode !== undefined && section.shadowMode !== null) {
      raw = section.shadowMode;
      origin = 'config-shadowMode';
    } else {
      const env = isPlainObject(source.env) ? source.env : null;
      const envValue = env !== null && env[COMPILER_MODE_ENV_VAR] !== undefined
        ? env[COMPILER_MODE_ENV_VAR]
        : (typeof process !== 'undefined' && process.env ? process.env[COMPILER_MODE_ENV_VAR] : undefined);
      if (envValue !== undefined && envValue !== null && String(envValue) !== '') {
        raw = String(envValue);
        origin = 'env';
      } else {
        raw = 'off';
        origin = 'default';
      }
    }
  }
  const mode = String(raw);
  if (COMPILER_MODES.indexOf(mode) === -1) {
    return Object.freeze({ mode: 'off', valid: false, origin, reason: 'context-compiler-mode-unknown' });
  }
  if (origin === 'config-shadowMode' && mode === 'active') {
    return Object.freeze({ mode: 'off', valid: false, origin, reason: 'context-compiler-mode-unknown' });
  }
  return Object.freeze({ mode, valid: true, origin, reason: null });
}

/**
 * Derive the deterministic CCv2 input budget from authoritative
 * counts. Conceptually:
 *   modelMax - hostPrefix - toolSchema - framing - reservedOutput
 *     - safetyReserve = ccv2HardMax
 * Every term must be a non-negative integer; a negative or
 * unrepresentable hardMax (below 1 token) is invalid (fallback, not
 * a guessed reserve). No hidden percentage reserves exist.
 */
function deriveActiveBudgetV2(input) {
  const invalid = (reason) => ({ valid: false, reason, budget: null });
  if (!isPlainObject(input)) return invalid('active-budget-unrepresentable');
  for (const key of Object.keys(input)) {
    if (['modelMax', 'hostPrefixTokens', 'toolSchemaTokens', 'framingTokens', 'reservedOutputTokens', 'safetyReserveTokens', 'requestedTarget'].indexOf(key) === -1) {
      return invalid('active-budget-unrepresentable');
    }
  }
  const terms = ['modelMax', 'hostPrefixTokens', 'toolSchemaTokens', 'framingTokens', 'reservedOutputTokens'];
  for (const term of terms) {
    if (!Number.isInteger(input[term]) || input[term] < 0) return invalid('active-budget-unrepresentable');
  }
  const safety = input.safetyReserveTokens === undefined || input.safetyReserveTokens === null ? 0 : input.safetyReserveTokens;
  if (!Number.isInteger(safety) || safety < 0) return invalid('active-budget-unrepresentable');
  if (!Number.isInteger(input.modelMax) || input.modelMax <= 0) return invalid('active-budget-unrepresentable');
  const hardMax = input.modelMax - input.hostPrefixTokens - input.toolSchemaTokens
    - input.framingTokens - input.reservedOutputTokens - safety;
  if (!Number.isInteger(hardMax) || hardMax < 1) return invalid('active-budget-unrepresentable');
  let target = hardMax;
  if (input.requestedTarget !== undefined && input.requestedTarget !== null) {
    if (!Number.isInteger(input.requestedTarget) || input.requestedTarget < 1) return invalid('active-budget-unrepresentable');
    target = Math.min(input.requestedTarget, hardMax);
  }
  return {
    valid: true,
    reason: null,
    budget: Object.freeze({
      modelMax: input.modelMax,
      hostPrefixTokens: input.hostPrefixTokens,
      toolSchemaTokens: input.toolSchemaTokens,
      framingTokens: input.framingTokens,
      reservedOutputTokens: input.reservedOutputTokens,
      safetyReserveTokens: safety,
      ccv2HardMax: hardMax,
      ccv2Target: target,
    }),
  };
}

function checkBindingShape(binding) {
  if (!isPlainObject(binding)) return false;
  for (const key of Object.keys(binding)) {
    if (BINDING_EXACT_KEYS.indexOf(key) === -1) return false;
  }
  for (const key of BINDING_EXACT_KEYS) {
    if (binding[key] === undefined) return false;
  }
  return true;
}

function mapRenderErrorV2(message) {
  const text = String(message || '');
  if (text.indexOf('context-render-current-turn-invalid') !== -1) return 'active-current-turn-invalid';
  if (text.indexOf('context-render-tool-protocol-invalid') !== -1) return 'active-tool-protocol-invalid';
  if (text.indexOf('context-render-mandatory-missing') !== -1) return 'active-mandatory-coverage-failed';
  if (text.indexOf('context-render-mandatory-invalid') !== -1) return 'active-mandatory-coverage-failed';
  return 'active-render-invalid';
}

/**
 * Attempt one validated active projection. Input exact keys:
 *   compileInput (frozen C02 input), pages (array), capability
 *   (ModelContextCapabilityV2), ccv2Budget { hardMax, target },
 *   hostPrefixTokens, toolSchemaTokens, framingTokens,
 *   reservedOutputTokens, modelMax (authoritative counts),
 *   binding (request binding snapshot, BINDING_EXACT_KEYS),
 *   retrievalRequest?, compressionPolicyRevision?,
 *   packingPolicyRevision?, layoutPolicyRevision?
 *
 * Never throws for pipeline reasons: every failure mode returns an
 * ineligible LEGACY decision with a closed-world fallback reason.
 */
function attemptCompilerActiveV2(input) {
  try {
    if (!isPlainObject(input)) return ineligible('active-compiler-failed');
    for (const key of Object.keys(input)) {
      if (['compileInput', 'pages', 'capability', 'ccv2Budget', 'hostPrefixTokens',
        'toolSchemaTokens', 'framingTokens', 'reservedOutputTokens', 'modelMax',
        'binding', 'retrievalRequest', 'compressionPolicyRevision',
        'packingPolicyRevision', 'layoutPolicyRevision'].indexOf(key) === -1) {
        return ineligible('active-compiler-failed');
      }
    }
    const capCheck = capabilityV2.validateModelCapabilityV2(input.capability);
    if (!capCheck.valid) {
      return ineligible(capCheck.reason === 'active-tokenizer-unavailable'
        ? 'active-tokenizer-unavailable' : 'active-model-capability-unknown');
    }
    const capability = capCheck.capability;
    const counter = capability.tokenCounter;
    if (!Array.isArray(input.pages)) return ineligible('active-compiler-failed');
    const ccv2Budget = input.ccv2Budget;
    if (!isPlainObject(ccv2Budget) || !Number.isInteger(ccv2Budget.hardMax) || ccv2Budget.hardMax < 1
      || !Number.isInteger(ccv2Budget.target) || ccv2Budget.target < 1
      || ccv2Budget.target > ccv2Budget.hardMax) {
      return ineligible('active-budget-unrepresentable');
    }
    for (const term of ['hostPrefixTokens', 'toolSchemaTokens', 'framingTokens', 'reservedOutputTokens', 'modelMax']) {
      if (!Number.isInteger(input[term]) || input[term] < 0) return ineligible('active-budget-unrepresentable');
    }
    if (!checkBindingShape(input.binding)) return ineligible('active-request-binding-changed');
    const binding = input.binding;
    // Binding must already agree with the capability it claims: route,
    // tokenizer, revision, and model window. Anything else is stale.
    if (binding.provider !== capability.provider || binding.model !== capability.model) {
      return ineligible('active-request-binding-changed');
    }
    if (binding.tokenizerFingerprint !== capability.tokenizerFingerprint) {
      return ineligible('active-request-binding-changed');
    }
    if (binding.capabilityRevision !== capability.capabilityRevision) {
      return ineligible('active-request-binding-changed');
    }
    if (binding.model !== undefined && input.modelMax !== capability.maxContextTokens) {
      return ineligible('active-request-binding-changed');
    }

    // Exactly one C01->C06 candidate execution (frozen pipeline).
    let candidate = null;
    try {
      candidate = shadowV2.buildCandidateV2({
        compileInput: input.compileInput,
        pages: input.pages,
        budget: { hardMax: ccv2Budget.hardMax, target: ccv2Budget.target },
        counter,
        retrievalRequest: input.retrievalRequest === undefined ? null : input.retrievalRequest,
        compressionPolicyRevision: input.compressionPolicyRevision,
        packingPolicyRevision: input.packingPolicyRevision,
        layoutPolicyRevision: input.layoutPolicyRevision,
      });
    } catch {
      return ineligible('active-compiler-failed');
    }
    const view = candidate.view;
    const layout = candidate.layout;

    // Binding coherence against the compiled truth: namespace triple,
    // checkpoint generation/id, snapshot revision, current-turn
    // identity. Movement since capture discards the candidate.
    const viewNamespace = view.namespace;
    if (viewNamespace.taskId !== binding.taskId
      || viewNamespace.taskInstanceId !== binding.taskInstanceId
      || viewNamespace.sessionId !== binding.sessionId) {
      return ineligible('active-request-binding-changed');
    }
    if (view.checkpointBinding.checkpointGeneration !== binding.checkpointGeneration
      || view.checkpointBinding.checkpointId !== binding.checkpointId) {
      return ineligible('active-snapshot-stale');
    }
    if (view.checkpointBinding.snapshotRevision !== binding.snapshotRevision) {
      return ineligible('active-snapshot-stale');
    }
    if (view.turnRef.turnId !== binding.turnId) return ineligible('active-current-turn-invalid');

    // One physical render (fail-closed internally, fallback outside).
    let render = null;
    try {
      render = rendererV2.renderContextPromptV2({ view, layout, counter });
    } catch (error) {
      return ineligible(mapRenderErrorV2(error && error.message));
    }

    // Budget honesty: the physical render (segments + framing
    // overhead) must fit the CCv2 hardMax, and the full model input
    // plus the output reserve must fit the model window. No
    // post-compilation truncation exists: overflow falls back.
    if (render.renderedTokens > ccv2Budget.hardMax) return ineligible('active-render-over-budget');
    const finalInputTokens = input.hostPrefixTokens + render.renderedTokens
      + input.toolSchemaTokens + input.framingTokens;
    if (finalInputTokens + input.reservedOutputTokens > input.modelMax) {
      return ineligible('active-render-over-budget');
    }

    // Coverage accounting (renderer already proved presence; the
    // counts below are the auditable record).
    let balancedToolCount = 0;
    for (const section of viewV2.VIEW_SECTIONS) {
      for (const entry of view[section]) {
        if (entry.toolTransaction !== null && entry.toolTransaction !== undefined) {
          if (entry.toolTransaction.callPresent !== true || entry.toolTransaction.resultPresent !== true) {
            return ineligible('active-tool-protocol-invalid');
          }
          balancedToolCount += 1;
        }
      }
    }
    const coverage = Object.freeze({
      mandatoryTotal: view.mandatoryRefs.length,
      mandatoryCovered: view.mandatoryRefs.length,
      currentTurnCovered: true,
      balancedToolTransactions: balancedToolCount,
    });

    const tokenAccounting = Object.freeze({
      modelMax: input.modelMax,
      hostPrefixTokens: input.hostPrefixTokens,
      ccv2Tokens: render.renderedTokens,
      ccv2SegmentTokens: render.segmentTokens,
      ccv2OverheadTokens: render.separatorOverheadTokens,
      ccv2ReferenceMarkerTokens: render.referenceMarkerTokens,
      toolSchemaTokens: input.toolSchemaTokens,
      framingTokens: input.framingTokens,
      outputReserveTokens: input.reservedOutputTokens,
      finalInputTokens,
    });

    const renderSummary = rendererV2.describeContextRenderV2(render);
    const telemetry = Object.freeze({
      projectionMode: 'CCV2_COMPILED',
      fallbackReason: null,
      candidateViewId: view.id,
      viewDigest: view.viewDigest,
      layoutDigest: layout.layoutDigest,
      renderDigest: render.renderDigest,
      tokenizerFingerprint: capability.tokenizerFingerprint,
      capabilityRevision: capability.capabilityRevision,
      modelMax: input.modelMax,
      hostPrefixTokens: input.hostPrefixTokens,
      ccv2Tokens: render.renderedTokens,
      toolSchemaTokens: input.toolSchemaTokens,
      outputReserveTokens: input.reservedOutputTokens,
      finalInputTokens,
      compilerExecutions: 1,
      mandatoryTotal: coverage.mandatoryTotal,
      balancedToolTransactions: coverage.balancedToolTransactions,
      renderValid: renderSummary.valid === true,
    });

    return Object.freeze({
      eligible: true,
      mode: 'CCV2_COMPILED',
      fallbackReason: null,
      view,
      layout,
      render,
      tokenAccounting,
      coverage,
      binding: Object.freeze(deepClone(binding)),
      compilerExecutions: 1,
      telemetry,
    });
  } catch {
    return ineligible('active-compiler-failed');
  }
}

/**
 * Final send-boundary revalidation: the stored binding captured at
 * compile time must still equal the live binding on every field.
 * Any drift discards the compiled render (outer fallback). Pure and
 * total: never throws.
 */
function revalidateActiveRenderV2(input) {
  try {
    if (!isPlainObject(input) || !isPlainObject(input.decision) || !isPlainObject(input.liveBinding)) {
      return Object.freeze({ current: false, fallbackReason: 'active-request-binding-changed' });
    }
    const decision = input.decision;
    if (decision.eligible !== true || decision.mode !== 'CCV2_COMPILED') {
      return Object.freeze({ current: false, fallbackReason: 'active-compiler-failed' });
    }
    const stored = decision.binding;
    const live = input.liveBinding;
    if (!checkBindingShape(stored) || !checkBindingShape(live)) {
      return Object.freeze({ current: false, fallbackReason: 'active-request-binding-changed' });
    }
    for (const key of BINDING_EXACT_KEYS) {
      if (canonicalJsonOf(stored[key]) !== canonicalJsonOf(live[key])) {
        const reason = (key === 'snapshotRevision' || key === 'checkpointGeneration' || key === 'checkpointId')
          ? 'active-snapshot-stale'
          : (key === 'turnId' || key === 'turnTextHash' || key === 'turnRevision')
            ? 'active-current-turn-invalid'
            : 'active-request-binding-changed';
        return Object.freeze({ current: false, fallbackReason: reason });
      }
    }
    const renderCheck = rendererV2.validateContextRenderV2(decision.render);
    if (!renderCheck.valid) return Object.freeze({ current: false, fallbackReason: 'active-render-invalid' });
    if (decision.render.renderDigest !== input.decision.render.renderDigest) {
      return Object.freeze({ current: false, fallbackReason: 'active-render-invalid' });
    }
    return Object.freeze({ current: true, fallbackReason: null });
  } catch {
    return Object.freeze({ current: false, fallbackReason: 'active-request-binding-changed' });
  }
}

/**
 * Secret-safe decision summary (diagnostics only): modes, reasons,
 * ids, digests, counts, tokens. Never prompt text.
 */
function describeActiveDecisionV2(decision) {
  try {
    if (!isPlainObject(decision)) return Object.freeze({ mode: 'LEGACY', eligible: false, fallbackReason: 'active-compiler-failed' });
    if (decision.eligible !== true) {
      const reason = typeof decision.fallbackReason === 'string'
        && FALLBACK_REASONS.indexOf(decision.fallbackReason) !== -1
        ? decision.fallbackReason : 'active-compiler-failed';
      return Object.freeze({
        mode: 'LEGACY',
        eligible: false,
        fallbackReason: reason,
        compilerExecutions: decision.compilerExecutions === 1 ? 1 : 0,
      });
    }
    return Object.freeze(deepClone(decision.telemetry));
  } catch {
    return Object.freeze({ mode: 'LEGACY', eligible: false, fallbackReason: 'active-compiler-failed' });
  }
}

module.exports = {
  COMPILER_MODES,
  COMPILER_MODE_ENV_VAR,
  ACTIVE_POLICY_REVISION_V1,
  PROJECTION_MODES,
  FALLBACK_REASONS,
  BINDING_EXACT_KEYS,
  resolveCompilerModeV2,
  deriveActiveBudgetV2,
  attemptCompilerActiveV2,
  revalidateActiveRenderV2,
  describeActiveDecisionV2,
};
