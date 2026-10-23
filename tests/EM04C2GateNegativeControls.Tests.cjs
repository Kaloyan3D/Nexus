'use strict'
// EM-04C2 S10 (RG-2/3/4/5/6): negative controls for the release gate. Each check feeds the gate a
// defective input and requires it to FAIL (exit 1), be INCOMPLETE (exit 2) or be UNVERIFIED - never
// to pass. Offline, no cargo, no network.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const lib = require('../scripts/lib/em04c2-gate-lib.cjs')
const { compareDirs, TIMING_DEPENDENT_TESTS } = require('../scripts/EM04C2-CompareBodies.cjs')

const repo = path.resolve(__dirname, '..')
let passed = 0
function check(label, fn) {
  fn()
  passed++
  console.log('PASS: ' + label)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-nc-'))
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

// ---------------------------------------------------------------------------- RG-2: the scanner
check('the scanner finds every test-only symbol and nothing in a clean binary', () => {
  const filler = Buffer.alloc(100 * 1024, 0x41)
  for (const sym of lib.TEST_ONLY_SYMBOLS) {
    const f = path.join(tmp, 'leak-' + sym.replace(/\W/g, '_'))
    fs.writeFileSync(f, Buffer.concat([filler, Buffer.from(sym), filler]))
    const r = lib.scanFile(f)
    assert.equal(r.status, 'FAIL', sym)
    assert.deepEqual(r.found, [sym])
  }
  const clean = path.join(tmp, 'clean')
  fs.writeFileSync(clean, filler)
  assert.equal(lib.scanFile(clean).status, 'PASS')
})
check('an unreadable, missing or implausibly small executable is UNVERIFIED, never a pass (the missing-`strings` hole)', () => {
  assert.equal(lib.scanFile(path.join(tmp, 'does-not-exist')).status, 'UNVERIFIED')
  const tiny = path.join(tmp, 'tiny')
  fs.writeFileSync(tiny, 'x')
  assert.equal(lib.scanFile(tiny).status, 'UNVERIFIED')
  const empty = path.join(tmp, 'empty')
  fs.writeFileSync(empty, '')
  assert.equal(lib.scanFile(empty).status, 'UNVERIFIED')
  assert.equal(lib.combineScans([]), 'UNVERIFIED', 'no artifact at all proves nothing')
  assert.equal(lib.combineScans([{ status: 'PASS' }, { status: 'UNVERIFIED' }]), 'UNVERIFIED')
  assert.equal(lib.combineScans([{ status: 'PASS' }, { status: 'FAIL' }, { status: 'UNVERIFIED' }]), 'FAIL')
  assert.equal(lib.combineScans([{ status: 'PASS' }]), 'PASS')
  assert.throws(() => lib.scanBytes('not a buffer'))
})

// ---------------------------------------------------------------------------- RG-3: overall verdict
check('a skipped, unverified or empty run is INCOMPLETE (exit 2) and never PASS', () => {
  const pass = (name) => ({ name, status: 'PASS' })
  assert.deepEqual(lib.overall([pass('a'), pass('b')]).verdict, 'PASS')
  assert.equal(lib.overall([pass('a'), pass('b')]).exit, 0)
  for (const st of ['SKIPPED', 'UNVERIFIED']) {
    const o = lib.overall([pass('a'), { name: 'b', status: st }])
    assert.equal(o.verdict, 'INCOMPLETE', st)
    assert.equal(o.exit, 2)
    assert.equal(o.acceptance, false)
  }
  assert.equal(lib.overall([]).exit, 2)
  assert.equal(lib.overall(undefined).exit, 2)
  assert.equal(lib.overall([pass('a'), { name: 'b', status: 'FAIL' }, { name: 'c', status: 'SKIPPED' }]).exit, 1, 'a failure dominates')
  assert.equal(lib.overall([pass('a'), { name: 'b', status: 'something-else' }]).exit, 2, 'an unknown status is never a pass')
})
check('an explicit --allow-skip passes but is never an acceptance run; it allows only the named section', () => {
  const s = [{ name: 'a', status: 'PASS' }, { name: 'bodies', status: 'SKIPPED' }]
  const o = lib.overall(s, ['bodies'])
  assert.equal(o.verdict, 'PASS')
  assert.equal(o.acceptance, false)
  assert.equal(lib.overall(s, ['e2e']).exit, 2, 'another section name does not excuse it')
})

// ---------------------------------------------------------------------------- RG-5: counts
check('a filter that matches nothing, a failing command or too few tests fails', () => {
  const c = (p, f = 0) => ({ passed: p, failed: f, ignored: 0, binaries: 1 })
  assert.equal(lib.judgeCounts('x', 0, c(6), 6).status, 'PASS')
  assert.equal(lib.judgeCounts('x', 0, c(0), 6).status, 'FAIL', 'matches nothing')
  assert.equal(lib.judgeCounts('x', 0, c(5), 6).status, 'FAIL', 'a renamed test')
  assert.equal(lib.judgeCounts('x', 101, c(9), 6).status, 'FAIL', 'non-zero exit')
  assert.equal(lib.judgeCounts('x', 0, c(9, 1), 6).status, 'FAIL', 'a failed test')
  const parsed = lib.parseCounts('test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured\ntest result: FAILED. 2 passed; 1 failed; 0 ignored')
  assert.deepEqual(parsed, { passed: 5, failed: 1, ignored: 1, binaries: 2 })
})

// ---------------------------------------------------------------------------- RG-4: body comparison
function dump(dir, tests) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, bodies] of Object.entries(tests)) fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(bodies))
}
const body = (n, extra) => ({ model: 'm', stream: true, tools: [], reasoning: { effort: 'low' }, input: [{ type: 'message', role: 'user', content: 'hello ' + n }], ...extra })
const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, [body(i), body(i + 1000)]]))
const NO_MIN = { minTests: 1, minBodies: 1 }

check('two empty dump directories, a missing directory and a missing baseline test are not a pass', () => {
  const a = path.join(tmp, 'e1')
  const b = path.join(tmp, 'e2')
  fs.mkdirSync(a)
  fs.mkdirSync(b)
  const r = compareDirs(a, b)
  assert.equal(r.status, 'FAIL')
  assert.ok(r.problems.some((p) => /no test was compared/.test(p)) && r.problems.some((p) => /no request body/.test(p)))
  assert.equal(compareDirs(a, path.join(tmp, 'nope')).status, 'UNVERIFIED')
  assert.equal(compareDirs(undefined, undefined).status, 'UNVERIFIED')
  // a baseline test whose dump the new run never wrote
  dump(path.join(tmp, 'm1'), { t0: [body(0)], t1: [body(1)] })
  dump(path.join(tmp, 'm2'), { t0: [body(0)] })
  const m = compareDirs(path.join(tmp, 'm1'), path.join(tmp, 'm2'), NO_MIN)
  assert.equal(m.status, 'FAIL')
  assert.deepEqual(m.totals.testsOnlyInBase, ['t1'])
})
check('fewer compared tests or bodies than the recorded baseline fails (default: 116 tests, 1000 bodies)', () => {
  dump(path.join(tmp, 'f1'), many(10))
  dump(path.join(tmp, 'f2'), many(10))
  const r = compareDirs(path.join(tmp, 'f1'), path.join(tmp, 'f2'))
  assert.equal(r.status, 'FAIL')
  assert.ok(r.problems.some((p) => /only 10 tests compared/.test(p)))
  assert.equal(compareDirs(path.join(tmp, 'f1'), path.join(tmp, 'f2'), NO_MIN).status, 'PASS', 'the same corpus passes once the minimum is lowered on purpose')
  dump(path.join(tmp, 'g1'), many(120))
  dump(path.join(tmp, 'g2'), many(120))
  assert.equal(compareDirs(path.join(tmp, 'g1'), path.join(tmp, 'g2'), { minTests: 116, minBodies: 200 }).status, 'PASS')
})
check('unequal request counts are never identical; an unreadable dump and a changed non-input field fail', () => {
  dump(path.join(tmp, 'u1'), { t0: [body(0), body(1)] })
  dump(path.join(tmp, 'u2'), { t0: [body(0)] })
  const u = compareDirs(path.join(tmp, 'u1'), path.join(tmp, 'u2'), NO_MIN)
  assert.equal(u.status, 'FAIL')
  assert.equal(u.totals.identical, 0, 'a different count is not byte identity')
  assert.ok(u.totals.unexplained >= 2)
  dump(path.join(tmp, 'v1'), { t0: [body(0)] })
  fs.mkdirSync(path.join(tmp, 'v2'))
  fs.writeFileSync(path.join(tmp, 'v2', 't0.json'), '{not json')
  const v = compareDirs(path.join(tmp, 'v1'), path.join(tmp, 'v2'), NO_MIN)
  assert.equal(v.status, 'FAIL')
  assert.equal(v.totals.unreadable.length, 1)
  dump(path.join(tmp, 'w1'), { t0: [body(0)] })
  dump(path.join(tmp, 'w2'), { t0: [body(0, { reasoning: { effort: 'xhigh' } })] })
  const w = compareDirs(path.join(tmp, 'w1'), path.join(tmp, 'w2'), NO_MIN)
  assert.equal(w.status, 'FAIL')
  assert.equal(w.totals.unexplained, 1)
})
check('the polling-count rule applies to ONE named test and nothing else, and is never "identical"', () => {
  const name = Object.keys(TIMING_DEPENDENT_TESTS)[0]
  const run = (n, text) => `### Run ${n} (may change files)\nUser request: RN2-FOLLOW: still there?\nYour answer then: (none)\nNote: This run ended as rejected: x\nRuntime record: this run changed no file; ended: rejected (x).\n\n`
  const mk = (polls) => ({ ...body(0), input: [{ type: 'message', role: 'user', content: 'head\n' + Array.from({ length: polls }, (_, i) => run(i + 2)).join('') + '### Run 99 (may change files)\nUser request: other\n' }] })
  dump(path.join(tmp, 'p1'), { [name]: [mk(4)], other_test: [mk(4)] })
  dump(path.join(tmp, 'p2'), { [name]: [mk(6)], other_test: [mk(4)] })
  const same = compareDirs(path.join(tmp, 'p1'), path.join(tmp, 'p2'), NO_MIN)
  assert.equal(same.status, 'PASS', JSON.stringify(same.problems))
  assert.equal(same.totals.pollingCountOnly, 1)
  assert.equal(same.totals.identical, 1, 'only the unchanged test is identical')
  // the SAME difference in any other test is unexplained
  dump(path.join(tmp, 'p3'), { other_test: [mk(4)] })
  dump(path.join(tmp, 'p4'), { other_test: [mk(6)] })
  const other = compareDirs(path.join(tmp, 'p3'), path.join(tmp, 'p4'), NO_MIN)
  assert.equal(other.status, 'FAIL')
  // a difference in the named test OUTSIDE the rejected-poll entries is still unexplained
  const tampered = mk(6)
  tampered.input[0].content += 'EXTRA'
  dump(path.join(tmp, 'p5'), { [name]: [mk(4)] })
  dump(path.join(tmp, 'p6'), { [name]: [tampered] })
  assert.equal(compareDirs(path.join(tmp, 'p5'), path.join(tmp, 'p6'), NO_MIN).status, 'FAIL')
})
check('judgeBodies refuses an inconsistent or partial summary', () => {
  const ok = { tests: 116, bodies: 1170, identical: 1078, toolOutputOnly: 88, orderOnly: 4, pollingCountOnly: 0, unexplained: 0, nonInputFieldsIdentical: 1170, testsOnlyInBase: [] }
  assert.equal(lib.judgeBodies(ok).status, 'PASS')
  for (const bad of [{ tests: 0 }, { bodies: 0 }, { tests: 115 }, { unexplained: 1 }, { testsOnlyInBase: ['x'] }, { nonInputFieldsIdentical: 1169 }, { identical: 1077 }]) {
    assert.equal(lib.judgeBodies({ ...ok, ...bad }).status, 'FAIL', JSON.stringify(bad))
  }
  assert.equal(lib.judgeBodies(null).status, 'UNVERIFIED')
})

// ---------------------------------------------------------------------------- JS environment classes
check('only a crashed PowerShell host is classified as environmental; real assertion failures and a lock-file mismatch stay REAL', () => {
  const crash = 'FAIL: R7.4 F ... structured diagnostic registry-binding-mismatch: [{"event":"binding-validation-inconclusive","error":"task identity could not be validated: aih-controller: Task.ps1 failed (exit unknown): Unhandled exception. System.IO.FileLoadException: The given assembly name was invalid."}]'
  assert.equal(lib.classifyJsFailure(crash), 'env:pwsh-host-runtime-fault')
  assert.equal(lib.classifyJsFailure("AssertionError: Expected values to be strictly equal:\n'0.35.3' !== '0.35.5'"), null, 'a lock-file mismatch is REAL')
  assert.equal(lib.classifyJsFailure('FAIL: R7.4 R75A actual request boundary rejects drift :: {"kind":"allowed","nextCount":1}'), null, 'an authorization outcome is never environmental')
  assert.equal(lib.classifyJsFailure('registry-pin-mismatch expected, got registry-authorization-revoked'), null)
  assert.equal(lib.classifyJsFailure(''), null)
})

// ---------------------------------------------------------------------------- the real CLI, end to end
function gate(extra, env) {
  return cp.spawnSync(process.execPath, [path.join(repo, 'scripts', 'EM04C2-ReleaseGate.cjs'), ...extra], { encoding: 'utf8', env, timeout: 120000 })
}
check('the real gate CLI: with no tool on PATH and no --bodies the verdict is INCOMPLETE (exit 2), never PASS', () => {
  const r = gate(['--no-e2e', '--no-prodgate'], { PATH: path.join(tmp, 'no-such-bin') })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stdout, /RELEASE GATE: INCOMPLETE/)
  assert.doesNotMatch(r.stdout, /PASS(ED)?\s*$|ALL SECTIONS PASSED/m)
  assert.match(r.stdout, /SKIPPED\s+bodies/)
  assert.match(r.stdout, /UNVERIFIED\s+release-binaries/)
})
check('the real gate CLI: empty body dumps make the verdict FAIL (exit 1)', () => {
  fs.mkdirSync(path.join(tmp, 'x1'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'x2'), { recursive: true })
  const r = gate(['--no-e2e', '--no-prodgate', '--bodies', path.join(tmp, 'x1'), path.join(tmp, 'x2')], { PATH: path.join(tmp, 'no-such-bin') })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /RELEASE GATE: FAIL/)
})
check('the real gate CLI: --allow-skip bodies is accepted but the run is not an acceptance run', () => {
  const r = gate(['--no-e2e', '--no-prodgate', '--allow-skip', 'bodies', '--allow-skip', 'e2e', '--allow-skip', 'production'], { PATH: path.join(tmp, 'no-such-bin') })
  // the unverified sections still keep it INCOMPLETE: allowing a skip never excuses a tool that is missing
  assert.equal(r.status, 2, r.stdout)
})

console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
