'use strict';
/**
 * Ccv2LiveHostGate.cjs - CCV2-A05H H4 strict live-host gate (tests-owned).
 *
 * This file implements NO production behavior. It owns the single release
 * rule shared by the two live-host proofs (A01 DSH generation proof, A02
 * operation proof):
 *
 *   host available                                        -> EXECUTED
 *   host unavailable + NEXUS_REQUIRE_CCV2_LIVE_HOST unset -> SKIPPED (exit 0,
 *     developer-friendly lightweight runs)
 *   host unavailable + NEXUS_REQUIRE_CCV2_LIVE_HOST=1     -> REQUIRED-MISSING
 *     (FAIL, non-zero exit: the release gate must never report green on a
 *     skipped proof)
 *
 * Strict values: '1', 'true', 'yes' (case-insensitive, trimmed). Every
 * other value (including '0'/'false'/empty/unset) means optional mode.
 */

const STRICT_ENV = 'NEXUS_REQUIRE_CCV2_LIVE_HOST';

function isStrictRequired(env) {
  const source = env && typeof env === 'object' ? env : {};
  const raw = String(source[STRICT_ENV] === undefined || source[STRICT_ENV] === null ? '' : source[STRICT_ENV]).trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function decideLiveHostGate(hostFound, env) {
  if (hostFound) return 'EXECUTED';
  return isStrictRequired(env) ? 'REQUIRED-MISSING' : 'SKIPPED';
}

// Prints the stable gate line and enforces the exit contract. Returns the
// decision for the EXECUTED/SKIPPED paths; exits non-zero for
// REQUIRED-MISSING (never returns).
function reportLiveHostGate(tag, decision) {
  const line = String(tag) + ' LIVE HOST PROOF: ' + String(decision);
  console.log(line);
  if (decision === 'REQUIRED-MISSING') {
    console.log('FAIL: pinned DSH host is absent but ' + STRICT_ENV + '=1 requires the live proof (never faked).');
    process.exit(1);
  }
  return decision;
}

module.exports = {
  STRICT_ENV,
  isStrictRequired,
  decideLiveHostGate,
  reportLiveHostGate,
};
