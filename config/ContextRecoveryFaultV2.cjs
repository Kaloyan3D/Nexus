'use strict';
/**
 * ContextRecoveryFaultV2.cjs - CCV2-A12 deterministic fault-injection authority.
 *
 * TEST-ONLY injection registry around existing durable-transition authorities.
 * Production semantic identities are NEVER polluted: every fault point
 * defaults to OFF, and injection fires only when a test explicitly arms it
 * in-process via armFaultV2(). No clock, no randomness, no timing sleeps:
 * faults fire at precise named boundaries (before/after/throw/
 * return-failure/simulated-process-loss).
 *
 * Supported modes:
 *   'throw'                  - throw Error('ccv2-fault-injected:<point>')
 *   'return-failure'         - return { injected: true } sentinel where the
 *                              owning layer supports it (currently unused by
 *                              fail-closed persistence; kept for API parity)
 *   'simulated-process-loss' - throw ProcessLostV2 (a crash that performs no
 *                              cleanup, modelling kill -9 between two
 *                              durable steps; temp files are left behind)
 *
 * Determinism: armed faults fire exactly once by default (single-shot) so a
 * retry/recovery pass observes clean state. Pass { persistent: true } to arm
 * a sticky fault for churn/convergence tests.
 *
 * Security: fault names and errors carry ids/digests only, never task
 * content, credentials, or tool output.
 */

const ARMED = new Map(); // point -> { mode, persistent, fired }

class ProcessLostV2 extends Error {
  constructor(point) {
    super('ccv2-process-lost:' + point);
    this.name = 'ProcessLostV2';
    this.code = 'ccv2-process-lost';
    this.faultPoint = point;
  }
}

function normalizePoint(point) {
  if (typeof point !== 'string' || point === '') throw new Error('ccv2-fault: point is required');
  return point;
}

// Frozen named fault-point vocabulary (A12 §4). Points are namespaced by
// durable transition so a crash matrix can address each boundary precisely.
const FAULT_POINTS = Object.freeze([
  // Generation reservation persistence
  'reservation:before-temp-write',
  'reservation:after-temp-write',
  'reservation:before-rename',
  'reservation:after-rename',
  'reservation:before-read-back',
  'reservation:after-read-back-before-return',
  // Commit-head persistence
  'head:before-temp-write',
  'head:after-temp-write',
  'head:before-rename',
  'head:after-rename',
  'head:before-read-back',
  'head:after-read-back-before-return',
  // Supersession persistence
  'supersession:before-temp-write',
  'supersession:after-temp-write',
  'supersession:before-rename',
  'supersession:after-rename',
  'supersession:before-read-back',
  'supersession:after-read-back-before-return',
  // Checkpoint / operation persistence (observed via artifact corruption in
  // tests; registry points exist so helpers can simulate caller death)
  'checkpoint:before-persist',
  'checkpoint:after-persist-before-return',
  'operation:before-persist',
  'operation:after-persist-before-return',
  // Lock lifecycle
  'lock:after-acquire',
  'lock:during-validation',
  'lock:before-renew',
  'lock:renew-lost',
  'lock:after-renew',
  'lock:before-mutation',
  'lock:during-mutation',
  'lock:before-release',
  'lock:release-failure',
  // Segment application / flush / post-verify
  'segment:before-first-landing',
  'segment:after-payload-landing',
  'segment:between-anchors',
  'segment:after-final-segment',
  'flush:before-flush',
  'flush:after-flush-before-return',
  'post-verify:before-verification',
  'post-verify:during-verification',
  'post-verify:after-verification-before-return',
]);

function armFaultV2(point, mode, options) {
  const name = normalizePoint(point);
  if (FAULT_POINTS.indexOf(name) === -1) throw new Error('ccv2-fault: unknown point ' + name);
  if (mode !== 'throw' && mode !== 'return-failure' && mode !== 'simulated-process-loss' && mode !== 'off') {
    throw new Error('ccv2-fault: unknown mode ' + String(mode));
  }
  if (mode === 'off') { ARMED.delete(name); return { point: name, mode: 'off' }; }
  const opts = options && typeof options === 'object' ? options : {};
  ARMED.set(name, { mode, persistent: opts.persistent === true, fired: 0 });
  return { point: name, mode };
}

function disarmFaultV2(point) {
  ARMED.delete(normalizePoint(point));
}

function disarmAllFaultsV2() { ARMED.clear(); }

function armedFaultsV2() {
  return Object.freeze(Array.from(ARMED.entries()).map(([point, spec]) => ({ point, mode: spec.mode, fired: spec.fired })));
}

// maybeFaultV2 is called by owning layers at the exact named boundary. When
// no fault is armed it returns null (zero production behavior change).
// When armed it either throws (throw / simulated-process-loss) or returns
// the { injected: true } sentinel (return-failure).
function maybeFaultV2(point) {
  const spec = ARMED.get(point);
  if (!spec) return null;
  if (!spec.persistent && spec.fired >= 1) return null;
  spec.fired += 1;
  if (spec.mode === 'return-failure') return { injected: true };
  if (spec.mode === 'simulated-process-loss') throw new ProcessLostV2(point);
  throw new Error('ccv2-fault-injected:' + point);
}

function isProcessLostV2(error) {
  return Boolean(error && (error instanceof ProcessLostV2 || error.code === 'ccv2-process-lost' || String((error && error.message) || '').indexOf('ccv2-process-lost:') === 0));
}

function isFaultInjectedV2(error) {
  const message = String((error && error.message) || error || '');
  return message.indexOf('ccv2-fault-injected:') === 0 || isProcessLostV2(error);
}

module.exports = {
  FAULT_POINTS,
  ProcessLostV2,
  armFaultV2,
  disarmFaultV2,
  disarmAllFaultsV2,
  armedFaultsV2,
  maybeFaultV2,
  isProcessLostV2,
  isFaultInjectedV2,
};
