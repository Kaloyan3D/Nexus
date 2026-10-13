'use strict';
/**
 * ContextTokenCounterV2.cjs - CCV2-C04 token-counting contract production authority.
 *
 * ONE authority for the provider-neutral token-counting contract consumed by
 * the C04 budgeted packer (config/ContextBudgetAllocatorV2.cjs). A budget
 * claim requires an explicit counting authority: C04 never divides
 * characters, multiplies words, reads model names, or consults historical
 * averages. Without a valid counter, certified packing is impossible and
 * the packer fails closed with context-budget-tokenizer-unavailable.
 *
 * Contract (frozen):
 *
 *   ContextTokenCounterV2 = {
 *     tokenizerFingerprint: string,  // exact tokenization contract identity
 *     countText(text: string): number // deterministic non-negative integer
 *   }
 *
 * The core never hard-codes provider or model families. Real provider
 * tokenizers are NOT integrated here: the generic production interface
 * below plus the deterministic reference test adapter are frozen, but no
 * real-model hard-budget safety may be claimed until a runtime supplies a
 * counter whose fingerprint matches that model's tokenization contract
 * (see C08 production enablement boundary in the architecture record).
 *
 * Test adapter: createCodepointTestCounterV2 counts one token per Unicode
 * code point. It is TEST ONLY, never a model tokenizer, and never a
 * production fallback. Its fingerprint is test-codepoint-v1.
 *
 * Cross-process reconstruction: counters carrying function closures cannot
 * be serialized. createTokenCounterFromFingerprintV2 rebuilds ONLY the
 * deterministic test adapter from its fingerprint string; every other
 * fingerprint fails closed, so XProc packing stays byte-identical without
 * smuggling closures across processes.
 *
 * Purity: every export is deterministic and read-only. No clocks, no
 * randomness, no filesystem reads, no mutation of caller state.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (C04 freeze record). A/B/C01/C02/C03 semantics are consumed verbatim.
 *
 * Explicitly NOT implemented here (unsupported dimensions named once so
 * the boundary is auditable): hand-picked passages, structural
 * re-representation, machine-written digests, similarity search, vector
 * stores, learned rankers, decision-provider scoring, self-reported
 * certainty values, and cache-aware layout. No such dependency exists
 * in this module.
 */

const TEST_CODEPOINT_FINGERPRINT_V2 = 'test-codepoint-v1';
const TOKENIZER_FINGERPRINT_MAX_CHARS = 128;

function failCounter(reason, detail) {
  throw new Error('context-budget-' + reason + (detail === undefined ? '' : ': ' + detail));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a caller-supplied token counter WITHOUT calling it. Returns
 * { valid:true, fingerprint } or { valid:false, reason }. A missing
 * counter is not a guessable default: callers must treat an invalid
 * counter as context-budget-tokenizer-unavailable and fail closed.
 */
function validateContextTokenCounterV2(counter) {
  if (counter === null || counter === undefined) {
    return { valid: false, reason: 'context-budget-tokenizer-unavailable' };
  }
  if (!isPlainObject(counter)) {
    return { valid: false, reason: 'context-budget-tokenizer-unavailable' };
  }
  const fingerprint = counter.tokenizerFingerprint;
  if (typeof fingerprint !== 'string' || fingerprint === ''
    || fingerprint.length > TOKENIZER_FINGERPRINT_MAX_CHARS) {
    return { valid: false, reason: 'context-budget-tokenizer-unavailable' };
  }
  if (typeof counter.countText !== 'function') {
    return { valid: false, reason: 'context-budget-tokenizer-unavailable' };
  }
  return { valid: true, reason: null, fingerprint };
}

function assertValidCount(count, what) {
  if (typeof count !== 'number' || !Number.isFinite(count)
    || !Number.isInteger(count) || count < 0) {
    failCounter('counter-invalid', what + ' returned a non-certifiable count');
  }
  return count;
}

/**
 * Count text through a validated counter with determinism verification.
 * Calls countText twice for the same input and fails closed on any
 * disagreement (malicious or flaky counters cannot silently corrupt
 * packing). Tokenizer exceptions propagate as
 * context-budget-counter-failed; no heuristic fallback is attempted.
 * The exact caller-supplied text is passed through byte-for-byte: no
 * case folding, no transliteration, no Unicode normalization is applied
 * here (retrieval normalization never leaks into token accounting).
 */
function countTextVerifiedV2(counter, text) {
  const check = validateContextTokenCounterV2(counter);
  if (!check.valid) failCounter('tokenizer-unavailable', 'no valid token-counting authority');
  if (typeof text !== 'string') failCounter('counter-invalid', 'counted text must be a string');
  let first = null;
  let second = null;
  try {
    first = counter.countText(text);
  } catch (e) {
    failCounter('counter-failed', String((e && e.message) || e).slice(0, 200));
  }
  try {
    second = counter.countText(text);
  } catch (e) {
    failCounter('counter-failed', String((e && e.message) || e).slice(0, 200));
  }
  assertValidCount(first, 'countText(first)');
  assertValidCount(second, 'countText(second)');
  if (first !== second) {
    failCounter('counter-nondeterministic', 'same text counted differently within one operation');
  }
  return first;
}

/**
 * Deterministic reference adapter for tests only. Counts one token per
 * Unicode code point (code-point iteration, never UTF-16 length, so
 * astral-plane characters count once). TEST ONLY: not a model tokenizer,
 * never a production fallback, never used unless explicitly supplied.
 */
function createCodepointTestCounterV2() {
  const counter = {
    tokenizerFingerprint: TEST_CODEPOINT_FINGERPRINT_V2,
    countText(text) {
      if (typeof text !== 'string') {
        throw new Error('context-budget-counter-invalid: test adapter requires a string');
      }
      return Array.from(text).length;
    },
  };
  return Object.freeze(counter);
}

/**
 * Rebuild a counter from a fingerprint string for cross-process packing.
 * Only the deterministic test adapter is reconstructable. Any other
 * fingerprint fails closed: production tokenizer closures are never
 * serialized, and XProc callers must supply a natively reconstructable
 * authority instead.
 */
function createTokenCounterFromFingerprintV2(fingerprint) {
  if (fingerprint === TEST_CODEPOINT_FINGERPRINT_V2) {
    return createCodepointTestCounterV2();
  }
  failCounter('tokenizer-unavailable',
    'fingerprint ' + String(fingerprint).slice(0, 64) + ' is not reconstructable cross-process');
  return null;
}

module.exports = {
  TEST_CODEPOINT_FINGERPRINT_V2,
  TOKENIZER_FINGERPRINT_MAX_CHARS,
  validateContextTokenCounterV2,
  countTextVerifiedV2,
  createCodepointTestCounterV2,
  createTokenCounterFromFingerprintV2,
};
