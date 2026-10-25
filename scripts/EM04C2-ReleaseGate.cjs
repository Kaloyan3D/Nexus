#!/usr/bin/env node
'use strict'
// EM-04C2 S9/S10: one reproducible command that verifies the release-readiness properties of the
// adaptive Muse engine WHILE it is still inaccessible. Offline; no provider; no credentials.
//
//   node scripts/EM04C2-ReleaseGate.cjs --bodies <baseDumpDir> <newDumpDir> [--report <file.json>]
//        [--allow-skip <section>]... [--no-e2e] [--no-prodgate] [--prodgate-target <dir>] [--bins-target <dir>]
//
// Verdicts (scripts/lib/em04c2-gate-lib.cjs): every section is PASS | FAIL | UNVERIFIED | SKIPPED.
//   overall FAIL       (exit 1)  any section FAILED
//   overall INCOMPLETE (exit 2)  no FAIL, but a section is UNVERIFIED or SKIPPED (a missing tool, an
//                                absent --bodies, --no-e2e ...). Never a pass.
//   overall PASS       (exit 0)  every section PASSED. `--allow-skip <name>` lets a named section be
//                                SKIPPED without INCOMPLETE; the run is then reported as NOT an
//                                acceptance run. The S10 acceptance run uses no --allow-skip.
//
// Sections (each prints counts, never request bodies or secrets):
//   registry-js       Registry mode/engine constraints, sealed budget, opt-in (active) adaptive definition, closure,
//                     controller preset installation
//   engines           production/test engine separation, catalog identity, EM-03 compatibility,
//                     Policy V1/V2, engine state (cargo, `nexus-broker` lib); per-filter minimum counts
//   e2e               sealed budgets, closed mode table, legacy request-body stability, SEC-1
//                     continuation integrity, crash injection (cargo, `code_a56`, whole workspace so
//                     features unify; needs the sandbox); per-filter minimum counts
//   production        functional release-mode gates of a build WITHOUT test-engines (tools/prodgate),
//                     a byte scan of its test binaries, and TWO negative controls (the selftest-leak
//                     build must FAIL the same gates and must be detected by the scanner)
//   release-binaries  the real shipped executables: `cargo build --release` of nexus-broker, nexusd
//                     and nexus with default features; `cargo tree` has no test feature; each
//                     executable is scanned; `nexus-broker engines` is asked what it registers; the
//                     bundled Registry definitions are read; paths, sizes, sha256 and profile recorded
//   desktop-binary    the Tauri executable, when it can be built here (else UNVERIFIED, stated)
//   bodies            request-body comparison against a baseline dump (mandatory)
// The Tauri tests, the JS environment (scripts/EM04C2-JsEnvironment.cjs) and the full workspace
// battery are separate commands (docs/EM-04C2-PRODUCTION-GATE-RESULTS.md lists them).
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const lib = require('./lib/em04c2-gate-lib.cjs')
const { compareDirs } = require('./EM04C2-CompareBodies.cjs')

const args = process.argv.slice(2)
const has = (n) => args.includes(n)
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const repo = path.resolve(__dirname, '..')
const native = path.join(repo, 'native')
const reportPath = val('--report')
const allowSkip = args.flatMap((a, i) => (a === '--allow-skip' ? [args[i + 1]] : []))
const report = { startedAt: new Date().toISOString(), sections: {}, overall: null }
const sections = []

function run(cmd, a, o = {}) {
  return cp.spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...o })
}
/** A tool that cannot even start is UNVERIFIED, never "no findings". */
function toolMissing(r) {
  return !!(r && r.error)
}
function section(name, fn, skip) {
  const t0 = Date.now()
  let r
  if (skip) r = { status: 'SKIPPED', note: skip }
  else {
    try {
      r = fn()
    } catch (e) {
      r = { status: 'FAIL', note: `gate error: ${String(e && e.message).slice(0, 200)}` }
    }
  }
  r.name = name
  r.seconds = +((Date.now() - t0) / 1000).toFixed(1)
  report.sections[name] = r
  sections.push(r)
  const c = r.counts ? ` ${r.counts.passed} passed, ${r.counts.failed} failed, ${r.counts.ignored} ignored` : r.suites ? ` ${r.suites.pass}/${r.suites.total} suites` : ''
  console.log(`${r.status.padEnd(10)} ${name}${c}  (${r.seconds}s)${r.note ? '  ' + r.note : ''}`)
  for (const f of (r.failures || []).slice(0, 10)) console.log('      ' + f)
}
const sumCounts = (list) => list.reduce((t, c) => ({ passed: t.passed + c.passed, failed: t.failed + c.failed, ignored: t.ignored + c.ignored, binaries: t.binaries + c.binaries }), { passed: 0, failed: 0, ignored: 0, binaries: 0 })

// ---------------------------------------------------------------------------------------------
section('registry-js', () => {
  const suites = [
    'RegistryAdaptiveMode', // closed table, adaptive contract table (SEC-2), dormant definition, sealed budget
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
    'ControllerPresetCleanInstall', // exact asset list of the controller preset (RG-7)
    'ControllerSessionBootstrap',
    'AihControllerHost',
    'EM04C2GateNegativeControls', // the gate's own negative controls (S10 RG-2/3/4/5)
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
    if (toolMissing(r)) return { status: 'UNVERIFIED', note: `node cannot run: ${r.error.code}` }
    if (r.status === 0) pass++
    else failures.push(`${s}: ${((r.stdout || '') + (r.stderr || '')).split('\n').find((l) => /FAIL|Error/.test(l)) || 'exit ' + r.status}`.slice(0, 220))
  }
  return { status: failures.length ? 'FAIL' : 'PASS', suites: { pass, total: suites.length }, failures }
})

// ---------------------------------------------------------------------------------------------
// minimum numbers of tests each filter must RUN (the numbers observed on the S10 tree); a renamed or
// deleted test makes its filter match less and fails the gate instead of being absorbed by a sum
const ENGINE_FILTERS = {
  'engine::catalog_tests': 5,
  'engine::tests::the_registry_selected_mode': 1,
  'engine::tests::the_adaptive_identity_resolves': 1, // S9.5: former id and near misses resolve nowhere
  'attempt_target::identity_tests': 5, // S9.5: sealed digest pins before/after the rename
  'engine::muse_v1_active_tests': 24,
  'engine::effort_limiter': 39,
  'engine::muse_v1_tests': 11,
  'engine::governor_parity': 9,
  'engine::signals_parity': 9,
  'engine::signals_tests': 11,
  em03_records_compatibility: 5,
  the_published_fixture_key_is_refused_by_a_production_build: 1,
  'engine::anti_thrash_review': 10,
  'engine_state::': 16,
}
section('engines', () => {
  const per = []
  const failures = []
  for (const [f, min] of Object.entries(ENGINE_FILTERS)) {
    const r = run('cargo', ['test', '-p', 'nexus-broker', '--lib', f], { cwd: native })
    if (toolMissing(r)) return { status: 'UNVERIFIED', note: `cargo cannot run: ${r.error.code}` }
    const c = lib.parseCounts((r.stdout || '') + (r.stderr || ''))
    const j = lib.judgeCounts(f, r.status, c, min)
    per.push(c)
    if (j.status !== 'PASS') failures.push(`${f}: ${j.problems.join(', ')}`)
  }
  return { status: failures.length ? 'FAIL' : 'PASS', counts: sumCounts(per), failures }
})

// ---------------------------------------------------------------------------------------------
const E2E_FILTERS = {
  s4_: 5, // closed mode table, saved configuration, runtime gates
  s6_: 7, // active engine, durable selections, crash recovery
  s7_: 6, // sealed adaptive budget: A614 with the real engine, tighten-only, compaction, forged budgets
  s8_: 4, // recovery/stress matrix
  s95_: 3, // former-identity predecessor refusals (S9.5)
  s10_: 5, // SEC-1 continuation integrity, SEC-3 budget bound
  a56_crash_after_: 2, // crash injection: needs the feature-unified workspace build
  em04c1_muse_v0_requests_are_byte_identical: 1,
  em04c1_the_wire_catalog_is_the_frozen_identity_of_the_sealed_engine: 1,
  em04c1_a_registry_sealed_budget_bounds_every_request_without_any_broker_flag: 1,
  em01_the_engine_boundary_adds_no_request_field_and_no_tool_schema: 1,
}
section('e2e', () => {
  const per = []
  const failures = []
  for (const [f, min] of Object.entries(E2E_FILTERS)) {
    // `--workspace` so that cargo's feature unification builds nexusd/test targets the way the full
    // battery does (the crash-injection tests fail with "crash point never fired" otherwise)
    const r = run('cargo', ['test', '--workspace', '--test', 'code_a56', f], { cwd: native, env: { ...process.env, NEXUS_REQUIRE_SANDBOX: '1' } })
    if (toolMissing(r)) return { status: 'UNVERIFIED', note: `cargo cannot run: ${r.error.code}` }
    const c = lib.parseCounts((r.stdout || '') + (r.stderr || ''))
    per.push(c)
    const j = lib.judgeCounts(f, r.status, c, min)
    if (j.status !== 'PASS') failures.push(`${f}: ${j.problems.join(', ')}`)
  }
  return { status: failures.length ? 'FAIL' : 'PASS', counts: sumCounts(per), failures, note: 'sandbox required' }
}, has('--no-e2e') ? '--no-e2e given' : null)

// ---------------------------------------------------------------------------------------------
function artifactsOf(cargoJson, wanted) {
  return (cargoJson || '')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((m) => m && m.reason === 'compiler-artifact' && m.executable && m.target && wanted(m))
    .map((m) => ({ executable: m.executable, name: m.target.name, kind: m.target.kind, optLevel: m.profile && m.profile.opt_level, debug: m.profile && m.profile.debuginfo, features: m.features }))
}

section('production', () => {
  const target = val('--prodgate-target') || path.join(native, 'target', 'prodgate')
  const env = { ...process.env, CARGO_TARGET_DIR: target }
  const manifest = path.join(native, 'tools', 'prodgate', 'Cargo.toml')
  const r = run('cargo', ['test', '--release', '--manifest-path', manifest], { cwd: native, env })
  if (toolMissing(r)) return { status: 'UNVERIFIED', note: `cargo cannot run: ${r.error.code}` }
  const c = lib.parseCounts((r.stdout || '') + (r.stderr || ''))
  const failures = []
  const j = lib.judgeCounts('prodgate', r.status, c, 14)
  if (j.status !== 'PASS') failures.push(`prodgate: ${j.problems.join(', ')}`)
  if (c.binaries < 2) failures.push(`prodgate: only ${c.binaries} test binaries ran`)
  // second, weaker line: the test binaries cargo just built for THIS feature set carry no test-only symbol
  const built = run('cargo', ['test', '--release', '--no-run', '--message-format=json', '--manifest-path', manifest], { cwd: native, env })
  const bins = artifactsOf(built.stdout, (m) => m.target.kind.includes('test'))
  const scans = bins.map((b) => lib.scanFile(b.executable))
  if (bins.length < 2) failures.push('the production test binaries could not be located')
  if (lib.combineScans(scans) !== 'PASS') failures.push(`symbol scan: ${scans.filter((s) => s.status !== 'PASS').map((s) => `${path.basename(s.file)}: ${s.status} ${s.found.join(',') || s.reason}`).join('; ')}`)
  // NEGATIVE CONTROL: a build WITH test-engines must fail the same gates and must trip the scanner
  const ctl = run('cargo', ['test', '--release', '--features', 'selftest-leak', '--manifest-path', manifest, '--test', 'production_gate'], { cwd: native, env })
  const cc = lib.parseCounts((ctl.stdout || '') + (ctl.stderr || ''))
  let control
  if (toolMissing(ctl) || (cc.binaries === 0 && /error(\[|:)/.test((ctl.stderr || '') + ''))) control = 'UNVERIFIED'
  else control = ctl.status !== 0 && cc.failed >= 4 ? 'PASS' : 'FAIL'
  const ctlBuilt = run('cargo', ['test', '--release', '--features', 'selftest-leak', '--no-run', '--message-format=json', '--manifest-path', manifest, '--test', 'production_gate'], { cwd: native, env })
  const ctlBins = artifactsOf(ctlBuilt.stdout, (m) => m.target.kind.includes('test'))
  const ctlScans = ctlBins.map((b) => lib.scanFile(b.executable))
  const scannerSees = ctlScans.length > 0 && ctlScans.every((s) => s.status === 'FAIL')
  if (control === 'FAIL') failures.push(`negative control: the selftest-leak build was NOT rejected (exit ${ctl.status}, ${cc.failed} failed)`)
  if (!scannerSees && ctlScans.length > 0 && ctlScans.every((s) => s.status === 'PASS')) failures.push('negative control: the symbol scanner did not see the leak in the selftest-leak build')
  let status = failures.length ? 'FAIL' : 'PASS'
  if (!failures.length && (control === 'UNVERIFIED' || ctlScans.length === 0)) status = 'UNVERIFIED'
  return { status, counts: c, failures, negativeControl: { gatesRejectedLeak: control, failedTests: cc.failed, scannerDetectedLeak: scannerSees }, binaries: scans.map((s) => ({ file: path.basename(s.file), status: s.status, sha256: s.sha256 })), note: status === 'PASS' ? 'no test-only symbols; negative control rejected and detected' : '' }
}, has('--no-prodgate') ? '--no-prodgate given' : null)

// ---------------------------------------------------------------------------------------------
section('release-binaries', () => {
  const target = val('--bins-target') || path.join(native, 'target', 'release-gate-bins')
  const env = { ...process.env, CARGO_TARGET_DIR: target }
  const failures = []
  // 1. the feature set cargo resolves for the shipped crate (no dev-dependencies)
  const tree = run('cargo', ['tree', '-p', 'nexus-broker', '-e', 'normal,build,features'], { cwd: native, env })
  if (toolMissing(tree)) return { status: 'UNVERIFIED', note: `cargo cannot run: ${tree.error.code}` }
  if (tree.status !== 0) return { status: 'UNVERIFIED', note: 'cargo tree failed: ' + String(tree.stderr).slice(0, 120) }
  for (const f of ['test-engines', 'test-fixtures']) if ((tree.stdout || '').includes(f)) failures.push(`cargo tree: the shipped crate resolves feature ${f}`)
  // 2. build the real executables with default features
  const build = run('cargo', ['build', '--release', '--offline', '-p', 'nexus-broker', '-p', 'nexus-daemon', '-p', 'nexus-cli', '-p', 'nexus-tools', '--bins', '--message-format=json'], { cwd: native, env })
  if (build.status !== 0) return { status: 'FAIL', note: 'release build failed', failures: [String(build.stderr).split('\n').filter((l) => /^error/.test(l)).slice(0, 3).join(' | ')] }
  const exes = artifactsOf(build.stdout, (m) => m.target.kind.includes('bin') && ['nexus-broker', 'nexusd', 'nexus', 'nexus-confine'].includes(m.target.name))
  const names = exes.map((e) => e.name).sort()
  for (const need of ['nexus', 'nexus-broker', 'nexusd', 'nexus-confine']) if (!names.includes(need)) failures.push(`the executable ${need} was not produced`)
  const artifacts = []
  const scans = []
  for (const e of exes) {
    const s = lib.scanFile(e.executable)
    scans.push(s)
    const profile = e.optLevel === '3' ? 'release' : `opt-level ${e.optLevel}`
    artifacts.push({ name: e.name, path: e.executable, bytes: s.bytes, sha256: s.sha256, profile, features: e.features, scan: s.status })
    if (e.optLevel !== '3') failures.push(`${e.name}: not a release-profile artifact`)
    if ((e.features || []).some((f) => /test-engines|test-fixtures/.test(f))) failures.push(`${e.name}: built with feature ${e.features.join(',')}`)
  }
  const verdict = lib.combineScans(scans)
  if (verdict === 'FAIL') failures.push(`symbol scan: ${scans.filter((s) => s.status === 'FAIL').map((s) => `${path.basename(s.file)}: ${s.found.join(',')}`).join('; ')}`)
  if (verdict === 'UNVERIFIED') failures.push('symbol scan: unverified (' + (scans.find((s) => s.status === 'UNVERIFIED') || { reason: 'no artifact' }).reason + ')')
  // 3. functional, on THE shipped executable: what does it register and what resolves?
  const broker = exes.find((e) => e.name === 'nexus-broker')
  let engines = null
  if (broker) {
    const r = run(broker.executable, ['engines'], { timeout: 30000, env: { PATH: process.env.PATH } })
    try { engines = JSON.parse(r.stdout) } catch { failures.push('nexus-broker engines: no JSON answer') }
    if (engines) {
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
      // S10-A: exactly the default engine and the opt-in adaptive engine, each in its own mode
      if (!same(engines.registered, ['muse-v0', 'nexus-adaptive-v1'])) failures.push(`registered engines: ${JSON.stringify(engines.registered)}`)
      if (!same(engines.resolvable, [['engineering-v2', 'muse-v0'], ['engineering-v2-adaptive', 'nexus-adaptive-v1']])) failures.push(`resolvable (mode, engine) pairs: ${JSON.stringify(engines.resolvable)}`)
      if (engines.testEnginesFeature !== false || engines.testFixturesFeature !== false) failures.push('the executable reports a test feature')
      if (engines.adaptiveProductionEnabled !== true) failures.push('the adaptive activation gate is not open (S10-A expects the opt-in beta registered)')
    }
  }
  // 4. the bundled Registry definitions
  const modes = path.join(repo, 'config', 'registry', 'modes')
  const defs = {}
  try {
    for (const f of ['engineering-v2.json', 'engineering-v2-adaptive.json']) defs[f] = JSON.parse(fs.readFileSync(path.join(modes, f), 'utf8'))
    const d2 = defs['engineering-v2.json']
    const ad = defs['engineering-v2-adaptive.json']
    if (!(d2.orchestrationEngineId === 'muse-v0' && d2.selectable === true && d2.runnable === true && d2.status === 'active-legacy')) failures.push('engineering-v2 is not the selectable muse-v0 default')
    if (!(ad.status === 'active' && ad.selectable === true && ad.runnable === true && ad.orchestrationEngineId === 'nexus-adaptive-v1')) failures.push('the adaptive definition is not the active opt-in beta')
    if (ad.requestBudgetBytes !== 440000) failures.push('the adaptive definition does not seal 440000 bytes')
  } catch (e) {
    failures.push('bundled definitions unreadable: ' + String(e.message).slice(0, 80))
  }
  return { status: failures.length ? 'FAIL' : 'PASS', failures, artifacts, engines, buildProfile: 'release (opt-level 3), default features, --offline', targetDir: target, note: failures.length ? '' : `${artifacts.length} executables, none carries a test-only symbol` }
})

section('desktop-binary', () => {
  const manifest = path.join(repo, 'apps', 'nexus-desktop', 'src-tauri', 'Cargo.toml')
  // the desktop crate must not even depend on the broker (and so cannot contain an engine)
  const inv = run('cargo', ['tree', '--manifest-path', manifest, '--offline', '-i', 'nexus-broker'], { cwd: path.dirname(manifest) })
  if (toolMissing(inv)) return { status: 'UNVERIFIED', note: `cargo cannot run: ${inv.error.code}` }
  const dependsOnBroker = inv.status === 0
  if (dependsOnBroker) return { status: 'FAIL', failures: ['the desktop crate links nexus-broker'] }
  const targetDir = val('--desktop-target') || path.join(repo, 'apps', 'nexus-desktop', 'src-tauri', 'target')
  const exe = path.join(targetDir, 'release', 'nexus-desktop')
  if (!fs.existsSync(exe)) return { status: 'UNVERIFIED', note: 'dependency proof PASS (the crate does not link nexus-broker); the release executable was not built in this environment, so it was not scanned' }
  const s = lib.scanFile(exe)
  return { status: s.status, failures: s.found.map((f) => `symbol ${f}`), artifacts: [{ name: 'nexus-desktop', path: exe, bytes: s.bytes, sha256: s.sha256 }] }
})

// ---------------------------------------------------------------------------------------------
section('bodies', () => {
  const i = args.indexOf('--bodies')
  const r = compareDirs(args[i + 1], args[i + 2])
  if (r.status === 'UNVERIFIED') return { status: 'UNVERIFIED', note: r.problems.join('; ') }
  const t = r.totals
  return { status: r.status, failures: r.problems, totals: t, note: `tests ${t.tests}, bodies ${t.bodies}, identical ${t.identical}, volatile-tool-output ${t.toolOutputOnly}, order-only ${t.orderOnly}, polling-count-only ${t.pollingCountOnly}, unexplained ${t.unexplained}` }
}, has('--bodies') ? null : allowSkip.includes('bodies') ? 'no --bodies given (explicitly allowed)' : 'no --bodies given: the legacy request-body parity proof was not run')

const o = lib.overall(sections, allowSkip)
report.overall = o
report.finishedAt = new Date().toISOString()
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log(`RELEASE GATE: ${o.verdict}${o.verdict === 'PASS' ? (o.acceptance ? ' (acceptance run)' : ' (NOT an acceptance run: explicit skips)') : ''}${o.reasons.length ? '  [' + o.reasons.join('; ') + ']' : ''}`)
process.exit(o.exit)
