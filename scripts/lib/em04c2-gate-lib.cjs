'use strict'
// EM-04C2 S10: the small, testable decision functions behind scripts/EM04C2-ReleaseGate.cjs.
//
// Every verdict is one of PASS | FAIL | UNVERIFIED | SKIPPED. The rules the gate relies on live HERE
// (not inside the orchestration script) so tests/EM04C2GateNegativeControls.Tests.cjs can attack them
// directly: a gate that cannot fail is not a gate.
//
//   * UNVERIFIED  the check could not be performed (missing tool, unreadable artifact, empty input).
//                 It is NEVER a pass.
//   * SKIPPED     the section was not run. It is never a pass either; it makes the run INCOMPLETE
//                 unless the operator names the section in --allow-skip (and even then the run is
//                 not an acceptance run).
//   overall       FAIL (exit 1) if any section FAILED; else INCOMPLETE (exit 2) if any section is
//                 UNVERIFIED or SKIPPED; else PASS (exit 0). A run with no sections is INCOMPLETE.
const crypto = require('node:crypto')
const fs = require('node:fs')

/** Symbols that only the test-only modules contain (fault hooks, test engine, fixture key marker). */
const TEST_ONLY_SYMBOLS = Object.freeze([
  'armed_for_task',
  'EffortTestState',
  'EFFORT_TEST_V0',
  'fail_persist',
  'injected crash at',
  'TEST-ONLY-throwaway',
])

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Which of `symbols` occur in `buf` (byte search; no external `strings` tool). */
function scanBytes(buf, symbols = TEST_ONLY_SYMBOLS) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('scanBytes needs a Buffer')
  return symbols.filter((s) => buf.includes(s))
}

/**
 * Scan one executable. UNVERIFIED when it cannot be read or is implausibly small (a truncated or
 * empty file proves nothing); FAIL when a test-only symbol is present; PASS otherwise.
 */
function scanFile(file, symbols = TEST_ONLY_SYMBOLS, minBytes = 64 * 1024) {
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch (e) {
    return { file, status: 'UNVERIFIED', found: [], reason: `cannot read: ${e.code || e.message}` }
  }
  if (buf.length < minBytes) return { file, status: 'UNVERIFIED', found: [], reason: `only ${buf.length} bytes: not a plausible executable` }
  const found = scanBytes(buf, symbols)
  return { file, status: found.length ? 'FAIL' : 'PASS', found, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }
}

/** Combine the verdict of a list of scans: any FAIL fails; any UNVERIFIED (or an empty list) is UNVERIFIED. */
function combineScans(scans) {
  if (!Array.isArray(scans) || scans.length === 0) return 'UNVERIFIED'
  if (scans.some((s) => s.status === 'FAIL')) return 'FAIL'
  if (scans.some((s) => s.status !== 'PASS')) return 'UNVERIFIED'
  return 'PASS'
}

/** `test result:` lines of cargo test output, summed; `binaries` = number of result lines. */
function parseCounts(text) {
  const t = { passed: 0, failed: 0, ignored: 0, binaries: 0 }
  for (const m of String(text).matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)) {
    t.passed += +m[1]
    t.failed += +m[2]
    t.ignored += +m[3]
    t.binaries++
  }
  return t
}

/**
 * One cargo invocation's verdict against its recorded minimum. A command that exited non-zero, failed
 * any test, or ran fewer tests than the minimum (a renamed filter matching nothing) does not pass.
 */
function judgeCounts(label, status, counts, minPassed) {
  const problems = []
  if (status !== 0) problems.push(`exit ${status}`)
  if (counts.failed > 0) problems.push(`${counts.failed} failed`)
  if (counts.passed < minPassed) problems.push(`${counts.passed} passed < required minimum ${minPassed}`)
  return { label, status: problems.length ? 'FAIL' : 'PASS', counts, minPassed, problems }
}

/**
 * The overall verdict of a gate run. `sections` = [{name, status, ...}]; `allowSkip` = names the
 * operator explicitly allowed to be skipped.
 */
function overall(sections, allowSkip = []) {
  const allowed = new Set(allowSkip)
  const reasons = []
  let fail = false
  let incomplete = false
  if (!Array.isArray(sections) || sections.length === 0) {
    return { verdict: 'INCOMPLETE', exit: 2, acceptance: false, reasons: ['no section ran'] }
  }
  for (const s of sections) {
    if (s.status === 'FAIL') {
      fail = true
      reasons.push(`${s.name}: FAIL`)
    } else if (s.status === 'PASS') {
      // nothing
    } else if (s.status === 'SKIPPED' && allowed.has(s.name)) {
      reasons.push(`${s.name}: SKIPPED (explicitly allowed)`)
    } else {
      incomplete = true
      reasons.push(`${s.name}: ${s.status}`)
    }
  }
  const skippedAllowed = sections.some((s) => s.status === 'SKIPPED' && allowed.has(s.name))
  if (fail) return { verdict: 'FAIL', exit: 1, acceptance: false, reasons }
  if (incomplete) return { verdict: 'INCOMPLETE', exit: 2, acceptance: false, reasons }
  // PASS; an explicitly allowed skip is reported and means this cannot be the acceptance run
  return { verdict: 'PASS', exit: 0, acceptance: !skippedAllowed, reasons }
}

/**
 * Judge the output of EM04C2-CompareBodies. `totals` is its machine-readable summary.
 * Fail closed: zero bodies, zero tests, a baseline test missing from the new run, fewer compared
 * tests than the recorded baseline, any unexplained body, or an inconsistent summary.
 */
function judgeBodies(totals, { minTests = 116, minBodies = 1000 } = {}) {
  const problems = []
  if (!totals || typeof totals !== 'object') return { status: 'UNVERIFIED', problems: ['no comparison summary'] }
  if (!(totals.tests > 0)) problems.push('no test was compared')
  if (!(totals.bodies > 0)) problems.push('no request body was compared')
  if (totals.tests < minTests) problems.push(`only ${totals.tests} tests compared; the baseline has ${minTests}`)
  if (totals.bodies < minBodies) problems.push(`only ${totals.bodies} bodies compared; the recorded corpus has at least ${minBodies}`)
  if (Array.isArray(totals.testsOnlyInBase) && totals.testsOnlyInBase.length) problems.push(`baseline tests missing from the new run: ${totals.testsOnlyInBase.slice(0, 5).join(', ')}`)
  if (totals.unexplained > 0) problems.push(`${totals.unexplained} unexplained bodies`)
  if (totals.nonInputFieldsIdentical !== totals.bodies) problems.push(`non-input fields identical in ${totals.nonInputFieldsIdentical} of ${totals.bodies} bodies`)
  const classified = (totals.identical || 0) + (totals.toolOutputOnly || 0) + (totals.orderOnly || 0) + (totals.pollingCountOnly || 0) + (totals.unexplained || 0)
  if (classified !== totals.bodies) problems.push(`classification does not add up (${classified} of ${totals.bodies})`)
  return { status: problems.length ? 'FAIL' : 'PASS', problems }
}


/**
 * Classes of non-passing JavaScript suites that are caused by the ENVIRONMENT, not by the code under
 * test. A match makes the suite UNVERIFIED (never PASS, exit 3 of the JS environment script) so it must
 * be re-run; it is never silently retried. There is deliberately NO class for "a dependency version
 * differs from the lock file" (RegistryR751 must PASS against the pinned set).
 *
 * `env:pwsh-host-runtime-fault`: the bundled PowerShell/.NET host itself crashed ("Unhandled exception.
 * System.…", e.g. a FileLoadException with a corrupted assembly name) inside a controller CLI. The Native
 * controller reports that as `binding-validation-inconclusive` and REFUSES (fails closed), so the suite's
 * expected specific refusal code is replaced by an inconclusive refusal. Evidence: docs/EM-04C2-R74-ROOT-CAUSE-REPORT.md.
 */
const JS_ENV_CLASSES = Object.freeze([
  [/Cannot find module '@deepseek-ai\/dsh-tools'/, 'env:dsh-tools-missing'],
  [/spawn pwsh ENOENT|pwsh: command not found|no pwsh host/i, 'env:pwsh-missing'],
  [/nexusd binary exists|kernel binary exists|nexus-kernel/i, 'env:native-binaries-not-built'],
  [/Task\.ps1 failed[^\n]*\n?[^\n]*Unhandled exception\. System\.|Unhandled exception\. System\.IO\.FileLoadException: The given assembly name was invalid/, 'env:pwsh-host-runtime-fault'],
])
function classifyJsFailure(text) {
  const hit = JS_ENV_CLASSES.find(([rx]) => rx.test(String(text)))
  return hit ? hit[1] : null
}

module.exports = { JS_ENV_CLASSES, classifyJsFailure, TEST_ONLY_SYMBOLS, sha256File, scanBytes, scanFile, combineScans, parseCounts, judgeCounts, overall, judgeBodies }
