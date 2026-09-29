'use strict';
/**
 * ContextCompilerShadowAdapterV2.cjs - CCV2-C07 thin host adapter.
 *
 * The SMALLEST repository-consistent integration at the proven request
 * boundary. This adapter owns NO compiler policy: it captures the
 * authoritative live projection metadata, snapshots the outgoing
 * provider request, invokes the real C01->C06 candidate pipeline plus
 * the pure shadow comparator from config/ContextCompilerShadowV2.cjs,
 * and emits sanitized telemetry. It must never become a second
 * compiler authority.
 *
 * Proven seam (see docs/architecture/context-compaction-v2.md section
 * 38 and the C07 report):
 *   A. The authoritative live prompt/projection becomes final inside
 *      the DSH agent/request waterfall: the isolation finalize step
 *      (Muse-Isolation.cjs / Engineering-Isolation.cjs via
 *      Controller-RequestBoundary.cjs) returns the frozen proposed
 *      request, DSH model-selection validates it, and the final
 *      immutable assertion runs at llm/stream (Routing-Integrity.cjs).
 *   B. CCv2 inputs are captured consistently from the same session
 *      binding + checkpoint/snapshot revision the controller owns.
 *   C. The provider request becomes immutable/final for inference at
 *      the llm/stream global-prepend assertion; the agent/request
 *      finalize already returns it Object.freeze-d.
 *
 * Non-interference contract (enforced, not promised):
 *   - The adapter receives the live request object and NEVER mutates
 *     it: observation uses a read-only canonical snapshot (clone for
 *     comparison only). The SAME reference is returned to the caller.
 *   - After shadow work completes, the canonical snapshot is recomputed
 *     and deep-compared (canonical/deep structural comparison, never
 *     object identity alone) across provider, model, reasoning effort,
 *     max tokens, messages, system content, tool definitions, routing
 *     authority, and request metadata relevant to inference. Any drift
 *     is reported as requestMutated:true (the request itself still
 *     proceeds; the shadow outcome is discarded).
 *   - ANY shadow failure (compiler, retrieval, packing, compression,
 *     layout, comparison, report validation, telemetry sink, stale
 *     snapshot, namespace mismatch) discards the shadow candidate or
 *     report and continues the existing prompt UNCHANGED. This
 *     fail-open rule applies ONLY to the shadow subsystem; C01-C06
 *     keep failing closed internally.
 *
 * No new safe-point authority: the adapter pauses nothing, blocks no
 * checkpoint lifecycle, acquires no active-compaction mutation
 * authority, and changes no projection. Coherence is decided by the
 * existing snapshot/revision validation (capture vs complete
 * snapshot revision); movement yields STATE_CHANGED and discards the
 * comparison.
 *
 * Durable truth: shadow reports are observability. They are never
 * written into checkpoints, ContextPages, EvidenceRefs, tier
 * decisions, task state, continuation state, or decision state. When
 * a telemetry sink is supplied it receives the sanitized report plus
 * a NON-AUTHORITATIVE runtime envelope (durations); sink failures
 * never fail the request.
 */

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const shadowV2 = require('./ContextCompilerShadowV2.cjs');

const ADAPTER_EXACT_KEYS = Object.freeze([
  'mode', 'config', 'env', 'request', 'actual', 'candidateFactory',
  'getCurrentRevision', 'telemetrySink', 'clock',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowMs(clock) {
  try {
    if (isPlainObject(clock) && typeof clock.now === 'function') {
      const value = clock.now();
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
  } catch {
    // Clock failures are observational only; fall through to Date.now.
  }
  return Date.now();
}

/**
 * Read-only canonical snapshot of the outgoing authoritative request.
 * Used for before/after structural comparison only; never emitted to
 * telemetry, never persisted. Throws on non-serializable requests so
 * the caller can treat the shadow as unobservable (request proceeds).
 */
function snapshotRequestV2(request) {
  return canonicalJsonOf(request);
}

/**
 * Observe one request in strict passive shadow mode.
 *
 * Input (exact keys):
 *   mode | config | env  - enablement (see resolveCompilerShadowModeV2);
 *                          default 'off'.
 *   request              - the live provider-request object (never mutated,
 *                          same reference returned).
 *   actual               - typed actual-side observation descriptor
 *                          (see observeActualV2).
 *   candidateFactory     - { compileInput, pages, budget, counter,
 *                          retrievalRequest? } for buildCandidateV2.
 *                          NEVER invoked when mode is off.
 *   getCurrentRevision?  - () -> snapshotRevision string observed at
 *                          completion (state-consistency rule).
 *   telemetrySink?       - (report, envelope) -> void; failures swallowed.
 *   clock?               - { now() } for the observational runtime
 *                          envelope only (never enters digests).
 *
 * Returns (never throws for shadow reasons):
 *   { mode, shadowPerformed, request, report, envelope,
 *     requestUnchanged, inputsUnchanged, telemetryDelivered, shadowError }
 */
function observeCompilerShadowV2(input) {
  if (!isPlainObject(input)) {
    return {
      mode: 'off', shadowPerformed: false, request: undefined, report: null,
      envelope: null, requestUnchanged: true, inputsUnchanged: true,
      telemetryDelivered: false, shadowError: 'adapter-input-invalid',
    };
  }
  const unknown = (() => {
    for (const key of Object.keys(input)) {
      if (ADAPTER_EXACT_KEYS.indexOf(key) === -1) return key;
    }
    return null;
  })();
  const request = input.request === undefined ? null : input.request;
  const base = {
    mode: 'off', shadowPerformed: false, request, report: null,
    envelope: null, requestUnchanged: true, inputsUnchanged: true,
    telemetryDelivered: false, shadowError: null,
  };
  if (unknown !== null) {
    base.shadowError = 'adapter-input-unknown-key';
    return base;
  }

  let resolved = null;
  try {
    resolved = shadowV2.resolveCompilerShadowModeV2({ mode: input.mode, config: input.config, env: input.env });
  } catch {
    resolved = { mode: 'off', valid: false, origin: 'resolver-failed', reason: 'adapter-mode-unresolvable' };
  }
  base.mode = resolved.mode;

  if (resolved.mode === 'off') {
    // Disabled-mode proof surface: no candidate work, no telemetry, no
    // report, same request reference back. candidateFactory untouched.
    return base;
  }

  const startedMs = nowMs(input.clock);
  let before = null;
  try {
    before = snapshotRequestV2(request);
  } catch {
    base.shadowError = 'request-unsnapshotable';
    return base;
  }

  let factoryBefore = null;
  try {
    factoryBefore = canonicalJsonOf({
      compileInput: input.candidateFactory ? input.candidateFactory.compileInput : null,
      pages: input.candidateFactory ? input.candidateFactory.pages : null,
    });
  } catch {
    factoryBefore = null;
  }

  let report = null;
  let shadowError = null;
  let candidateMs = null;
  let comparisonMs = null;
  try {
    if (!isPlainObject(input.actual)) throw new Error('context-compiler-shadow-actual-invalid: actual observation is required (DISCARDABLE)');
    if (!isPlainObject(input.candidateFactory)) throw new Error('context-compiler-shadow-candidate-input-invalid: candidateFactory is required (DISCARDABLE)');
    const actual = shadowV2.observeActualV2(input.actual);
    const candidateStart = nowMs(input.clock);
    const candidateResult = shadowV2.buildCandidateV2(input.candidateFactory);
    candidateMs = nowMs(input.clock) - candidateStart;

    let completeRevision = actual.checkpointBinding.snapshotRevision;
    if (typeof input.getCurrentRevision === 'function') {
      try {
        const observed = input.getCurrentRevision();
        if (typeof observed === 'string' && observed !== '') completeRevision = observed;
      } catch {
        // A broken freshness probe invalidates the comparison rather
        // than trusting a possibly stale candidate.
        completeRevision = 'shadow-freshness-probe-failed';
      }
    }

    const comparisonStart = nowMs(input.clock);
    const comparison = shadowV2.compareShadowV2({
      actual,
      candidate: candidateResult.candidateObservation,
      captureSnapshotRevision: actual.checkpointBinding.snapshotRevision,
      completeSnapshotRevision: completeRevision,
    });
    comparisonMs = nowMs(input.clock) - comparisonStart;
    report = shadowV2.buildShadowReportV2({
      actual,
      candidateResult,
      comparison,
      tokenizerFingerprint: candidateResult.candidateObservation.tokenizerFingerprint,
    });
  } catch (error) {
    shadowError = String((error && error.message) || error).slice(0, 300);
    try {
      const ns = isPlainObject(input.actual) && isPlainObject(input.actual.namespace)
        ? input.actual.namespace : { taskId: '?', taskInstanceId: '?', sessionId: '?' };
      const binding = isPlainObject(input.actual) && isPlainObject(input.actual.checkpointBinding)
        ? input.actual.checkpointBinding : {};
      report = shadowV2.buildFailedShadowReportV2({
        namespace: ns,
        reason: shadowError,
        captureSnapshotRevision: typeof binding.snapshotRevision === 'string' ? binding.snapshotRevision : 'unknown',
        completeSnapshotRevision: (() => {
          try {
            if (typeof input.getCurrentRevision === 'function') {
              const observed = input.getCurrentRevision();
              if (typeof observed === 'string' && observed !== '') return observed;
            }
          } catch { /* keep capture revision */ }
          return typeof binding.snapshotRevision === 'string' ? binding.snapshotRevision : 'unknown';
        })(),
        checkpointGeneration: binding.checkpointGeneration,
        checkpointId: binding.checkpointId,
      });
      shadowError = null;
    } catch {
      report = null;
    }
  }

  let after = null;
  let requestUnchanged = false;
  try {
    after = snapshotRequestV2(request);
    requestUnchanged = after === before;
  } catch {
    requestUnchanged = false;
  }

  let inputsUnchanged = true;
  try {
    if (factoryBefore !== null) {
      const factoryAfter = canonicalJsonOf({
        compileInput: input.candidateFactory ? input.candidateFactory.compileInput : null,
        pages: input.candidateFactory ? input.candidateFactory.pages : null,
      });
      inputsUnchanged = factoryAfter === factoryBefore;
    }
  } catch {
    inputsUnchanged = false;
  }

  const totalMs = nowMs(input.clock) - startedMs;
  // Runtime envelope: observational only, NEVER part of any digest.
  const envelope = {
    candidateMs, comparisonMs, totalMs,
    requestUnchanged, inputsUnchanged,
    shadowPolicyRevision: shadowV2.SHADOW_POLICY_REVISION_V2,
    authoritative: false,
  };

  let telemetryDelivered = false;
  if (report !== null && typeof input.telemetrySink === 'function') {
    try {
      input.telemetrySink(report, deepClone(envelope));
      telemetryDelivered = true;
    } catch {
      // Telemetry is never an availability dependency.
      telemetryDelivered = false;
    }
  }

  if (report !== null && requestUnchanged !== true) {
    // The integration contract makes request mutation impossible; if a
    // future caller ever shares a writable alias, the shadow outcome is
    // discarded rather than trusted.
    report = null;
    shadowError = 'request-mutated-during-shadow';
  }

  return {
    mode: resolved.mode,
    shadowPerformed: report !== null || shadowError !== null,
    request,
    report,
    envelope,
    requestUnchanged,
    inputsUnchanged,
    telemetryDelivered,
    shadowError,
  };
}

module.exports = {
  ADAPTER_EXACT_KEYS,
  snapshotRequestV2,
  observeCompilerShadowV2,
};
