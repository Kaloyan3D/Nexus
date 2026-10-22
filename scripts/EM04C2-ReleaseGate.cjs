#!/usr/bin/env node
'use strict'
// EM-04C2 S9: one reproducible command that verifies the release-readiness properties of the adaptive
// Muse engine WHILE it is still inaccessible. Offline; no provider; no credentials.
//
//   node scripts/EM04C2-ReleaseGate.cjs [--report <file.json>] [--no-e2e] [--no-prodgate]
//        [--bodies <baseDumpDir> <newDumpDir>] [--prodgate-target <dir>]
//
// Sections (each prints counts, never request bodies or secrets):
//   registry-js   Registry mode/engine constraints, sealed budget, dormant definition, closure
//   engines       production/test engine separation, adaptive catalog identity, EM-03 fixture
//                 compatibility, Policy V1/V2, EM-04A/B parity (cargo, `nexus-broker` lib)
//   e2e           sealed request budgets (A614 with the real adaptive engine), legacy muse-v0
//                 request-body stability, catalog on the wire (cargo, `code_a56`; needs the sandbox)
//   production    functional release-mode gates of a build WITHOUT test-engines (tools/prodgate),
//                 plus a symbol scan of the produced binaries as a second line of evidence
//   bodies        (optional) request-body comparison against a baseline dump
// The Tauri tests, the JS environment (scripts/EM04C2-JsEnvironment.cjs) and the full workspace
// battery are separate commands (docs/EM-04C2-PRODUCTION-GATE-RESULTS.md lists them).
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
const has = (n) => args.includes(n)
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const repo = path.resolve(__dirname, '..')
const native = path.join(repo, 'native')
const reportPath = val('--report')
const report = { sections: {}, ok: true }

function run(cmd, a, o = {}) {
  return cp.spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...o })
}
function counts(text) {
  const t = { passed: 0, failed: 0, ignored: 0, binaries: 0 }
  for (const m of text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)) {
    t.passed += +m[1]
    t.failed += +m[2]
    t.ignored += +m[3]
    t.binaries++
  }
  return t
}
function section(name, fn) {
  const t0 = Date.now()
  let r
  try {
    r = fn()
  } catch (e) {
    r = { ok: false, error: String(e && e.message) }
  }
  r.seconds = +((Date.now() - t0) / 1000).toFixed(1)
  report.sections[name] = r
  if (!r.ok) report.ok = false
  const detail = r.counts ? ` ${r.counts.passed} passed, ${r.counts.failed} failed, ${r.counts.ignored} ignored` : r.suites ? ` ${r.suites.pass}/${r.suites.total} suites` : ''
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name}${detail}  (${r.seconds}s)${r.note ? '  ' + r.note : ''}`)
  if (!r.ok && r.failures) for (const f of r.failures.slice(0, 8)) console.log('      ' + f)
}

// ---------------------------------------------------------------------------------------------
section('registry-js', () => {
  const suites = [
    'RegistryAdaptiveMode', // closed table, dormant definition, sealed budget validation, optional-mode handling
    'RegistryRequestBudget',
    'RegistryCore',
    'RegistryR2Compatibility',
    'RegistryR3UI',
    'RegistryR3Hardening',
    'RegistryLegacyBaseline',
    'RegistryInstalledRuntime',
    'MusePresetRegistryModes',
    'MusePresetDependencyClosure',
    'MusePresetCleanInstall',
    'NativeTargetV2',
    'NativeIntentBridge',
    'NativeTaskBinding',
    'NativeRegistryCatalog',
    'NativeDispatchIntent',
    'MuseReasoningGovernor',
    'MuseReasoningRuntime',
  ]
  const failures = []
  let pass = 0
  for (const s of suites) {
    const r = run('node', [path.join('tests', s + '.Tests.cjs')], { cwd: repo, timeout: 280000 })
    if (r.status === 0) pass++
    else failures.push(`${s}: ${((r.stdout || '') + (r.stderr || '')).split('\n').find((l) => /FAIL|Error/.test(l)) || 'exit ' + r.status}`.slice(0, 220))
  }
  return { ok: failures.length === 0, suites: { pass, total: suites.length }, failures }
})

// ---------------------------------------------------------------------------------------------
section('engines', () => {
  const filters = [
    'engine::catalog_tests',
    'engine::tests::the_registry_selected_mode',
    'engine::muse_v1_active_tests',
    'engine::effort_limiter',
    'engine::muse_v1_tests',
    'engine::governor_parity',
    'engine::signals_parity',
    'engine::signals_tests',
    'em03_records_compatibility',
    'the_published_fixture_key_is_refused_by_a_production_build',
    'engine::anti_thrash_review',
  ]
  const total = { passed: 0, failed: 0, ignored: 0, binaries: 0 }
  const failures = []
  for (const f of filters) {
    const r = run('cargo', ['test', '-p', 'nexus-broker', '--lib', f], { cwd: native })
    const c = counts((r.stdout || '') + (r.stderr || ''))
    for (const k of Object.keys(total)) total[k] += c[k]
    if (r.status !== 0 || c.passed === 0) failures.push(`${f}: ${c.passed} passed, ${c.failed} failed (exit ${r.status})`)
  }
  return { ok: failures.length === 0, counts: total, failures }
})

// ---------------------------------------------------------------------------------------------
if (!has('--no-e2e')) {
  section('e2e', () => {
    const filters = [
      's7_', // sealed adaptive budget: A614 with the real engine/catalog, tighten-only, compaction, forged budgets
      's4_', // closed mode table, saved configuration, runtime gates
      'em04c1_muse_v0_requests_are_byte_identical',
      'em04c1_the_wire_catalog_is_the_frozen_identity_of_the_sealed_engine',
      'em04c1_a_registry_sealed_budget_bounds_every_request_without_any_broker_flag',
      'em01_the_engine_boundary_adds_no_request_field_and_no_tool_schema',
    ]
    const r = run('cargo', ['test', '-p', 'nexus-broker', '--test', 'code_a56', '--', ...filters], { cwd: native, env: { ...process.env, NEXUS_REQUIRE_SANDBOX: '1' } })
    const c = counts((r.stdout || '') + (r.stderr || ''))
    return { ok: r.status === 0 && c.passed > 0 && c.failed === 0, counts: c, note: 'sandbox required' }
  })
}

// ---------------------------------------------------------------------------------------------
if (!has('--no-prodgate')) {
  section('production', () => {
    const target = val('--prodgate-target') || path.join(native, 'target', 'prodgate')
    const env = { ...process.env, CARGO_TARGET_DIR: target }
    const r = run('cargo', ['test', '--release', '--manifest-path', path.join(native, 'tools', 'prodgate', 'Cargo.toml')], { cwd: native, env })
    const c = counts((r.stdout || '') + (r.stderr || ''))
    // second, weaker line of evidence: the test binaries cargo just built for THIS feature set (not
    // any stale artifact in deps/) carry none of the test-only engine symbols
    const built = run('cargo', ['test', '--release', '--no-run', '--message-format=json', '--manifest-path', path.join(native, 'tools', 'prodgate', 'Cargo.toml')], { cwd: native, env })
    const binaries = (built.stdout || '')
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((m) => m && m.reason === 'compiler-artifact' && m.executable && m.target && m.target.kind.includes('test'))
      .map((m) => m.executable)
    const leaks = []
    for (const f of binaries) {
      const s = run('strings', [f], { maxBuffer: 512 * 1024 * 1024 }).stdout || ''
      for (const sym of ['armed_for_task', 'EffortTestState', 'EFFORT_TEST_V0', 'fail_persist']) {
        if (s.includes(sym)) leaks.push(`${path.basename(f)}: ${sym}`)
      }
    }
    if (binaries.length < 2) leaks.push('the test binaries could not be located')
    return { ok: r.status === 0 && c.failed === 0 && c.passed >= 14 && leaks.length === 0, counts: c, failures: leaks, note: leaks.length ? 'test-only symbols present' : 'no test-only symbols in the release test binaries' }
  })
}

// ---------------------------------------------------------------------------------------------
if (has('--bodies')) {
  section('bodies', () => {
    const i = args.indexOf('--bodies')
    const r = run('node', [path.join(__dirname, 'EM04C2-CompareBodies.cjs'), args[i + 1], args[i + 2]], { cwd: repo })
    const line = (re) => ((r.stdout || '').match(re) || [])[1]
    return {
      ok: r.status === 0,
      note: `bodies ${line(/bodies compared: (\d+)/)}, identical ${line(/identical:\s+(\d+)/)}, unexplained ${line(/UNEXPLAINED:\s+(\d+)/)}`,
    }
  })
}

if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log(report.ok ? 'RELEASE GATE: ALL SECTIONS PASSED' : 'RELEASE GATE: FAILED')
process.exit(report.ok ? 0 : 1)
