'use strict';
/**
 * ContextActivationPressureV2.cjs - CCv2 RC1.1 Layer A: context-pressure
 * activation gate for the certified OpenCode Muse projection.
 *
 * Answers ONE question per root request: does the native request carry
 * enough context pressure that the compiled (reasoningReplay:none)
 * projection is justified? It never compiles, counts, reads checkpoints or
 * decides anything else. ContextCompilerActiveOpencodeHostV2 is the single
 * caller and the single owner of the LEGACY vs CCV2_COMPILED decision.
 *
 * Signal: provider-reported DSH TokenUsage recorded durably on every
 * assistant/message event. It is the only authority that measures the
 * native request: the Meta counter refuses OpenCode-issued encrypted
 * reasoning and OpenCode exposes no count endpoint. The sum is DSH's own
 * usageTokens (input + cacheRead + cacheWrite + output; reasoningTokens is
 * an output subdivision and is never added again).
 *
 *   anchor         = latest assistant/message with valid usage (epoch)
 *   deltaBound     = sum over request messages after the anchor message of
 *                    utf8Bytes(JSON(content)) + MESSAGE_FRAMING_ALLOWANCE
 *   pressureTokens = sample(anchor) + deltaBound
 *   latchTokens    = max sample over the current surface epoch
 *
 * deltaBound is conservative: an upper bound for a byte-level tokenizer (a
 * token covers at least one byte; JSON structure plus the per-message
 * allowance covers framing). The Muse tokenizer is not public; the bound is
 * verified against provider usage by scripts/CCv2-ActivationReplay.cjs.
 *
 * Threshold: the basis depends on whether a compiled request on the route
 * can carry the open turn's provider reasoning (the wire reasoningReplay
 * capability). Every term is authoritative or documented.
 *
 *   reasoningReplay native  -> basis 'before-dsh-compaction':
 *     dshThreshold     = floor(window x DSH_COMPACTION_THRESHOLD_RATIO_V1)
 *     activationTokens = dshThreshold - maxOutput - STEP_GROWTH_RESERVE
 *                        - providerSafetyMargin(dshThreshold)
 *     Compiled requests lose nothing, so CCv2 takes over one whole step
 *     before DSH's lossy step-pressure summary would run.
 *
 *   reasoningReplay none    -> basis 'native-unsendable':
 *     activationTokens = window - maxOutput - providerSafetyMargin(window)
 *     A compiled request must drop the open turn's reasoning, and the
 *     controlled B/C/D replay showed nothing deterministic restores it (a
 *     reasoning-stripped request re-inspected 5/5 at a mature planning
 *     state, with or without a recorded-state capsule). In-turn continuity
 *     is therefore never traded for compaction while the native request can
 *     still be sent: DSH compaction (which keeps the open turn native) stays
 *     the pressure relief, and CCv2 compiles only when the native request
 *     itself would no longer fit the window (overflow safety net).
 *
 * Hysteresis: native context never shrinks inside a DSH surface epoch, so
 * activation is a monotone latch over the durable samples of the epoch.
 * Compiled requests report smaller usage than native; the latch keeps them
 * from flipping the session back. A surface replacement starts a new epoch.
 *
 * Fail closed: anything unmeasurable or invalid is NATIVE (the original
 * request, sent verbatim). No model output, heuristic score or timer takes
 * part in the decision. Pure and deterministic over its inputs.
 */
const opencodeV2 = require('./ContextCompilerActiveOpencodeV2.cjs');

const ACTIVATION_POLICY_REVISION_V1 = 'ccv2-pressure-activation-v2-continuity-basis';
const ACTIVATION_MODE_PRESSURE = 'pressure';
const ACTIVATION_MODE_ALWAYS = 'always';
const ACTIVATION_MODES = Object.freeze([ACTIVATION_MODE_PRESSURE, ACTIVATION_MODE_ALWAYS]);
// Pinned @deepseek-ai/dsh-compaction-basic 0.1.1-rc.2 DEFAULT_THRESHOLD_RATIO.
// The aih-muse preset configures no override (asserted by the suite).
const DSH_COMPACTION_THRESHOLD_RATIO_V1 = 0.8;
// Evidence (frozen Legacy OpenRank run, 451 steps): per-step tool growth p99
// 3,617 / max 11,792 tokens; largest single tool result 52,444 bytes, i.e.
// <= 52,444 tokens under the byte bound. 2^16 covers every observed step.
const STEP_GROWTH_RESERVE_TOKENS_V1 = 65536;
const MESSAGE_FRAMING_ALLOWANCE_TOKENS_V1 = 32;
const BASIS_BEFORE_DSH_COMPACTION = 'before-dsh-compaction';
const BASIS_NATIVE_UNSENDABLE = 'native-unsendable';
const ACTIVATION_BASES = Object.freeze([BASIS_BEFORE_DSH_COMPACTION, BASIS_NATIVE_UNSENDABLE]);
const DECISION_NATIVE = 'NATIVE';
const DECISION_ACTIVATE = 'ACTIVATE';
const ACTIVATION_REASONS = Object.freeze([
  'activation-policy-invalid',
  'activation-forced-by-policy',
  'pressure-unmeasured',
  'pressure-below-threshold',
  'pressure-at-or-above-threshold',
  'pressure-latched',
]);
const UNMEASURED_DETAILS = Object.freeze(['session-unavailable', 'no-usage-sample', 'anchor-unmatched']);
const USAGE_KEYS = Object.freeze(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']);
const SURFACE_TYPES = Object.freeze(['user/message', 'assistant/message', 'tool/result']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * contextCompiler.activation from routing-policy.json (single config
 * authority, next to contextCompiler.mode). Absent = 'pressure'. Unknown
 * values are invalid (the gate then fails closed to NATIVE).
 */
function resolveActivationModeV2(config) {
  const section = isPlainObject(config) && isPlainObject(config.contextCompiler) ? config.contextCompiler : null;
  if (section === null || section.activation === undefined || section.activation === null) {
    return Object.freeze({ mode: ACTIVATION_MODE_PRESSURE, valid: true, origin: 'default' });
  }
  if (typeof section.activation !== 'string' || ACTIVATION_MODES.indexOf(section.activation) === -1) {
    return Object.freeze({ mode: null, valid: false, origin: 'config' });
  }
  return Object.freeze({ mode: section.activation, valid: true, origin: 'config' });
}

/**
 * Thresholds from the route capability (window, output ceiling and the
 * reasoningReplay mode of the wire route). Invalid (never guessed) when the
 * window or the output ceiling is not a positive integer, when the window
 * is not the counting window the OpenCode authority is certified for, when
 * the replay mode is unknown, or when an activation point is not positive.
 */
function deriveActivationThresholdsV2(route) {
  const invalid = Object.freeze({ valid: false });
  if (!isPlainObject(route)) return invalid;
  const windowTokens = route.contextWindow;
  const maxOutputTokens = route.maxTokens;
  if (!Number.isInteger(windowTokens) || windowTokens <= 0 || windowTokens !== opencodeV2.COUNT_WINDOW_V1) return invalid;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens >= windowTokens) return invalid;
  if (route.reasoningReplay !== 'native' && route.reasoningReplay !== 'none') return invalid;
  const dshThresholdTokens = Math.floor(windowTokens * DSH_COMPACTION_THRESHOLD_RATIO_V1);
  const beforeDshTokens = dshThresholdTokens - maxOutputTokens - STEP_GROWTH_RESERVE_TOKENS_V1 - opencodeV2.providerSafetyMarginV2(dshThresholdTokens);
  const nativeUnsendableTokens = windowTokens - maxOutputTokens - opencodeV2.providerSafetyMarginV2(windowTokens);
  if (!Number.isInteger(beforeDshTokens) || beforeDshTokens <= 0 || !Number.isInteger(nativeUnsendableTokens) || nativeUnsendableTokens <= 0) return invalid;
  const basis = route.reasoningReplay === 'native' ? BASIS_BEFORE_DSH_COMPACTION : BASIS_NATIVE_UNSENDABLE;
  return Object.freeze({
    valid: true,
    basis,
    reasoningReplay: route.reasoningReplay,
    windowTokens,
    dshThresholdTokens,
    maxOutputTokens,
    stepGrowthReserveTokens: STEP_GROWTH_RESERVE_TOKENS_V1,
    beforeDshTokens,
    nativeUnsendableTokens,
    activationTokens: basis === BASIS_BEFORE_DSH_COMPACTION ? beforeDshTokens : nativeUnsendableTokens,
  });
}

// DSH TokenUsage (dsh-llm types.d.ts), closed world. null = no sample.
function sampleTokensOfV2(usage) {
  if (!isPlainObject(usage)) return null;
  for (const key of Object.keys(usage)) if (USAGE_KEYS.indexOf(key) === -1) return null;
  if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return null;
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (usage[key] !== undefined && !isCount(usage[key])) return null;
  }
  return usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) + usage.outputTokens;
}

// Upper bound for one message the provider has not measured yet.
function messageBoundTokensV2(message) {
  const content = isPlainObject(message) && message.content !== undefined ? message.content : message;
  let text = '';
  try {
    text = JSON.stringify(content === undefined ? null : content);
  } catch (error) {
    void error;
    return null;
  }
  if (typeof text !== 'string') return null;
  return Buffer.byteLength(text, 'utf8') + MESSAGE_FRAMING_ALLOWANCE_TOKENS_V1;
}

/**
 * Measure the native request from durable session events. Content-free
 * result; never throws.
 */
function measureSessionPressureV2(input) {
  const unmeasured = (detail, latchTokens, samples) => Object.freeze({
    measured: false, detail, anchorTokens: null, deltaBoundTokens: null, pressureTokens: null,
    latchTokens: Number.isInteger(latchTokens) ? latchTokens : null, samples: Number.isInteger(samples) ? samples : 0,
  });
  try {
    const events = isPlainObject(input) && Array.isArray(input.events) ? input.events : null;
    const messages = isPlainObject(input) && Array.isArray(input.messages) ? input.messages : null;
    if (events === null || messages === null) return unmeasured('session-unavailable');
    // Epoch: after the last DSH surface replacement.
    let epochStart = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (isPlainObject(event) && SURFACE_TYPES.indexOf(event.type) !== -1 && event.surfaceOp !== undefined && event.surfaceOp !== 'append') {
        epochStart = index + 1;
        break;
      }
    }
    let anchor = null;
    let latchTokens = 0;
    let samples = 0;
    for (let index = epochStart; index < events.length; index += 1) {
      const event = events[index];
      if (!isPlainObject(event) || event.type !== 'assistant/message' || !isPlainObject(event.data)) continue;
      const tokens = sampleTokensOfV2(event.data.usage);
      if (tokens === null) continue;
      samples += 1;
      if (tokens > latchTokens) latchTokens = tokens;
      const message = event.data.message;
      anchor = { tokens, messageId: isPlainObject(message) && typeof message.id === 'string' && message.id !== '' ? message.id : null };
    }
    if (anchor === null) return unmeasured('no-usage-sample', 0, 0);
    if (anchor.messageId === null) return unmeasured('anchor-unmatched', latchTokens, samples);
    let at = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (isPlainObject(messages[index]) && messages[index].id === anchor.messageId) { at = index; break; }
    }
    if (at === -1) return unmeasured('anchor-unmatched', latchTokens, samples);
    let deltaBoundTokens = 0;
    for (let index = at + 1; index < messages.length; index += 1) {
      const bound = messageBoundTokensV2(messages[index]);
      if (bound === null) return unmeasured('anchor-unmatched', latchTokens, samples);
      deltaBoundTokens += bound;
    }
    return Object.freeze({
      measured: true, detail: null, anchorTokens: anchor.tokens, deltaBoundTokens,
      pressureTokens: anchor.tokens + deltaBoundTokens, latchTokens, samples,
    });
  } catch (error) {
    void error;
    return unmeasured('session-unavailable');
  }
}

function decisionOf(decision, reason, detail, mode, thresholds, measurement) {
  const t = isPlainObject(thresholds) && thresholds.valid === true ? thresholds : null;
  const m = isPlainObject(measurement) ? measurement : null;
  return Object.freeze({
    decision,
    reason,
    detail: detail === undefined ? null : detail,
    mode: mode === undefined ? null : mode,
    policyRevision: ACTIVATION_POLICY_REVISION_V1,
    basis: t === null ? null : t.basis,
    activationTokens: t === null ? null : t.activationTokens,
    dshThresholdTokens: t === null ? null : t.dshThresholdTokens,
    windowTokens: t === null ? null : t.windowTokens,
    pressureTokens: m === null ? null : m.pressureTokens,
    anchorTokens: m === null ? null : m.anchorTokens,
    deltaBoundTokens: m === null ? null : m.deltaBoundTokens,
    latchTokens: m === null ? null : m.latchTokens,
    usageSamples: m === null ? 0 : m.samples,
  });
}

/**
 * The gate. input: { mode (resolveActivationModeV2 result), route (wire
 * route capability), events (durable session events or null), messages
 * (the live request messages) }.
 */
function decideActivationV2(input) {
  try {
    const source = isPlainObject(input) ? input : {};
    const mode = isPlainObject(source.mode) ? source.mode : null;
    const thresholds = deriveActivationThresholdsV2(source.route);
    if (mode === null || mode.valid !== true || ACTIVATION_MODES.indexOf(mode.mode) === -1) {
      return decisionOf(DECISION_NATIVE, 'activation-policy-invalid', null, null, thresholds, null);
    }
    const measurement = measureSessionPressureV2({ events: source.events, messages: source.messages });
    // Explicit operator/canary policy: activation does not consult pressure
    // (the measurement is still reported). Every later RC1 gate still runs.
    if (mode.mode === ACTIVATION_MODE_ALWAYS) {
      return decisionOf(DECISION_ACTIVATE, 'activation-forced-by-policy', null, mode.mode, thresholds, measurement);
    }
    if (thresholds.valid !== true) return decisionOf(DECISION_NATIVE, 'activation-policy-invalid', null, mode.mode, thresholds, measurement);
    if (measurement.measured === true && measurement.pressureTokens >= thresholds.activationTokens) {
      return decisionOf(DECISION_ACTIVATE, 'pressure-at-or-above-threshold', null, mode.mode, thresholds, measurement);
    }
    // Below the threshold now, but an earlier durable sample of this epoch
    // reached it: the native context has not shrunk, stay activated.
    if (Number.isInteger(measurement.latchTokens) && measurement.latchTokens >= thresholds.activationTokens) {
      return decisionOf(DECISION_ACTIVATE, 'pressure-latched', null, mode.mode, thresholds, measurement);
    }
    if (measurement.measured !== true) {
      return decisionOf(DECISION_NATIVE, 'pressure-unmeasured', UNMEASURED_DETAILS.indexOf(measurement.detail) !== -1 ? measurement.detail : 'session-unavailable',
        mode.mode, thresholds, measurement);
    }
    return decisionOf(DECISION_NATIVE, 'pressure-below-threshold', null, mode.mode, thresholds, measurement);
  } catch (error) {
    void error;
    return decisionOf(DECISION_NATIVE, 'activation-policy-invalid', null, null, null, null);
  }
}

// Content-free decision-line fields (ids, codes and token counts only).
function activationTelemetryV2(decision) {
  const d = isPlainObject(decision) ? decision : null;
  return {
    activationDecision: d === null ? null : d.decision,
    activationReason: d === null ? null : d.reason,
    activationDetail: d === null ? null : d.detail,
    activationMode: d === null ? null : d.mode,
    activationPolicyRevision: ACTIVATION_POLICY_REVISION_V1,
    activationBasis: d === null ? null : d.basis,
    activationTokens: d === null ? null : d.activationTokens,
    pressureTokens: d === null ? null : d.pressureTokens,
    pressureAnchorTokens: d === null ? null : d.anchorTokens,
    pressureDeltaBoundTokens: d === null ? null : d.deltaBoundTokens,
    pressureLatchTokens: d === null ? null : d.latchTokens,
    pressureUsageSamples: d === null ? 0 : d.usageSamples,
  };
}

module.exports = {
  ACTIVATION_POLICY_REVISION_V1,
  ACTIVATION_MODE_PRESSURE,
  ACTIVATION_MODE_ALWAYS,
  ACTIVATION_MODES,
  DSH_COMPACTION_THRESHOLD_RATIO_V1,
  STEP_GROWTH_RESERVE_TOKENS_V1,
  MESSAGE_FRAMING_ALLOWANCE_TOKENS_V1,
  BASIS_BEFORE_DSH_COMPACTION,
  BASIS_NATIVE_UNSENDABLE,
  ACTIVATION_BASES,
  DECISION_NATIVE,
  DECISION_ACTIVATE,
  ACTIVATION_REASONS,
  UNMEASURED_DETAILS,
  resolveActivationModeV2,
  deriveActivationThresholdsV2,
  sampleTokensOfV2,
  messageBoundTokensV2,
  measureSessionPressureV2,
  decideActivationV2,
  activationTelemetryV2,
};
