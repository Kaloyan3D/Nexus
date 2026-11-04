#!/usr/bin/env node
'use strict'
// EM-04C2 S8/S9: provider request-body comparison between two builds.
//
// Each build runs the `code_a56` end-to-end suite with NEXUS_BODY_DUMP_DIR=<dir>; at the end of each
// test the mock provider writes every request body it received, in arrival order, to
// <dir>/<test name>.json. This tool compares two such directories test by test and body by body.
//
//   node scripts/EM04C2-CompareBodies.cjs <baseDir> <newDir> [--report <file.json>] [--tests <regex>]
//
// Categories (per body): identical | tool-output-timing-only | order-only (concurrent arrival;
// the multiset of bodies is equal) | polling-count-only (ONE named test, see TIMING_DEPENDENT_TESTS;
// never counted as identical) | UNEXPLAINED. Any UNEXPLAINED body makes the exit status 1.
//
// S10 (RG-4) fail-closed rules: exit 1 when no test or no body was compared, when a baseline test is
// missing from the new run (or its dump was never written), when fewer than --min-tests (default 116,
// the recorded baseline) tests or --min-bodies (default 1000) bodies were compared, when a dump file
// is unreadable, or when a request count differs (unequal counts are never "identical"). Exit 2 when
// a directory does not exist (UNVERIFIED).
// The report holds digests, counts and JSON paths only: never a request body, never a credential.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  return JSON.stringify(v)
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const digest = (v) => sha(canon(v))

// the body without the text of tool results
// Volatile wall-clock tokens inside a tool result (cargo's "finished ... in 0.80s", "wallMs":123) are the
// (and the order of parallel test-harness lines) are the only differences tolerated, and only as their own category; any other change of a tool result is UNEXPLAINED.
// cargo's test harness runs the fixture crate's tests on parallel threads: the ORDER of the
// "test <name> ... ok|FAILED" lines is nondeterministic, so a run of such lines is sorted.
function sortTestLines(text) {
  return text.replace(/(?:test [\w:]+ \.\.\. (?:ok|FAILED|ignored)(?:\\n|\n))+/g, (run) => {
    const sep = run.includes('\\n') ? '\\n' : '\n'
    const lines = run.split(sep).filter(Boolean).sort()
    return lines.join(sep) + sep
  })
}
// A cargo test run with several tests prints per-test sections in thread-completion order and names
// threads by a running id: for such outputs only the MULTISET of lines is compared (weaker, documented).
function harnessLines(text) {
  // only output that has the cargo test-harness grammar (a `running N tests` header AND a `test result:` footer)
  if (!/running \d+ tests?/.test(text) || !/test result:/.test(text)) return text
  const sep = text.includes('\\n') ? '\\n' : '\n'
  return text.replace(/\((\d+)\)/g, '(<id>)').split(sep).sort().join(sep)
}
function normalizeTiming(text) {
  return harnessLines(sortTestLines(String(text))
    .replace(/\bin \d+(\.\d+)?s\b/g, 'in <t>s')
    .replace(/"(wallMs|durationMs|elapsedMs)":\d+/g, '"$1":<t>')
    .replace(/\b(finished|elapsed|took) in \d+(\.\d+)?\s?(ms|s)\b/gi, '$1 in <t>'))
}
function timingNormalized(body) {
  const b = JSON.parse(JSON.stringify(body))
  if (Array.isArray(b.input)) {
    for (const item of b.input) if (item && item.type === 'function_call_output') item.output = normalizeTiming(item.output)
  }
  return b
}
function skeleton(body) {
  const b = JSON.parse(JSON.stringify(body))
  if (Array.isArray(b.input)) {
    for (const item of b.input) if (item && item.type === 'function_call_output') item.output = '<tool-output>'
  }
  return b
}

function firstDiff(a, b, p = '$') {
  if (canon(a) === canon(b)) return null
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${p}.length ${a.length} != ${b.length}`
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${p}[${i}]`)
      if (d) return d
    }
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${p}.${k}`)
      if (d) return d
    }
  }
  return p
}


// The ONE test whose request set legitimately depends on wall-clock timing: it re-sends a follow-up
// until the broker's 30 s catalogue cache expires, and every rejected poll becomes a "### Run N"
// entry of the conversation working memory the next request carries. Measured on the SAME tree
// (docs/EM-04C2-S10-PREFLIGHT-FIXES.md section 6): 6 or 7 such entries across 14 runs. For this test
// ONLY, and ONLY in input[0].content, consecutive rejected-poll entries are collapsed and run numbers
// masked; everything else in the body (and every non-input field) must still be byte-equal, and the
// bodies are reported as `polling-count-only`, never as identical.
const TIMING_DEPENDENT_TESTS = Object.freeze({
  rn2_a_conversation_whose_target_is_no_longer_issued_is_refused_before_any_run_and_never_falls_back: 'rejected-poll-runs',
})
function pollingNormalized(name, body) {
  if (!Object.prototype.hasOwnProperty.call(TIMING_DEPENDENT_TESTS, name)) return null
  const b = timingNormalized(body)
  if (Array.isArray(b.input) && b.input[0] && typeof b.input[0].content === 'string') {
    b.input[0].content = b.input[0].content
      .replace(/### Run \d+ \(may change files\)\nUser request: RN2-FOLLOW: still there\?\n[^\n]*\nNote: This run ended as rejected:[^\n]*\nRuntime record:[^\n]*\n\n?/g, '<rejected-poll-run>\n')
      .replace(/(?:<rejected-poll-run>\n)+/g, '<rejected-poll-runs>\n')
      .replace(/### Run \d+/g, '### Run <n>')
  }
  return b
}

function list(d) {
  return new Set(fs.readdirSync(d).filter((f) => f.endsWith('.json')))
}
function load(file) {
  const v = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(v)) throw new Error('not an array of request bodies')
  return v
}

/** Compare two dump directories. Never throws for bad input: it reports `status`/`problems`. */
function compareDirs(baseDir, newDir, { only = null, minTests = 116, minBodies = 1000 } = {}) {
  for (const d of [baseDir, newDir]) {
    if (!d || !fs.existsSync(d) || !fs.statSync(d).isDirectory()) return { status: 'UNVERIFIED', problems: [`not a directory: ${d}`], totals: null, report: null }
  }
  const baseTests = list(baseDir)
  const newTests = list(newDir)
  const rx = only ? new RegExp(only) : null
  const report = { baseDir: path.basename(baseDir), newDir: path.basename(newDir), tests: {}, totals: {} }
  const totals = { tests: 0, bodies: 0, identical: 0, toolOutputOnly: 0, orderOnly: 0, pollingCountOnly: 0, unexplained: 0, nonInputFieldsIdentical: 0, testsOnlyInBase: [], testsOnlyInNew: 0, unreadable: [], testsWithoutBodies: 0 }
  for (const f of [...baseTests].sort()) {
    const name = f.replace(/\.json$/, '')
    if (rx && !rx.test(name)) continue
    if (!newTests.has(f)) {
      totals.testsOnlyInBase.push(name)
      continue
    }
    let a, b
    try {
      a = load(path.join(baseDir, f))
      b = load(path.join(newDir, f))
    } catch (e) {
      totals.unreadable.push(`${name}: ${String(e.message).slice(0, 80)}`)
      continue
    }
    const t = { bodies: [a.length, b.length], identical: 0, toolOutputOnly: 0, orderOnly: 0, pollingCountOnly: 0, unexplained: [] }
    totals.tests++
    if (a.length === 0 && b.length === 0) totals.testsWithoutBodies++
    if (a.length !== b.length) {
      // unequal request counts are never identity: every body of the longer side is unexplained
      const n = Math.max(a.length, b.length)
      t.unexplained.push(`request count ${a.length} != ${b.length}`)
      totals.bodies += n
      totals.unexplained += n
      totals.nonInputFieldsIdentical += n // not judged; the unexplained count already fails the run
    } else {
      totals.bodies += a.length
      const sameMultiset = (x, y) => canon(x.map(digest).sort()) === canon(y.map(digest).sort())
      const skMultiset = (x, y) => canon(x.map((v) => digest(timingNormalized(v))).sort()) === canon(y.map((v) => digest(timingNormalized(v))).sort())
      for (let i = 0; i < a.length; i++) {
        const { input: _ia, ...restA } = a[i]
        const { input: _ib, ...restB } = b[i]
        if (canon(restA) === canon(restB)) totals.nonInputFieldsIdentical++
        const pa = pollingNormalized(name, a[i])
        const pb = pollingNormalized(name, b[i])
        if (canon(a[i]) === canon(b[i])) {
          t.identical++
          totals.identical++
        } else if (canon(timingNormalized(a[i])) === canon(timingNormalized(b[i]))) {
          t.toolOutputOnly++
          totals.toolOutputOnly++
        } else if (pa && pb && canon(pa) === canon(pb)) {
          t.pollingCountOnly++
          totals.pollingCountOnly++
        } else {
          t.unexplained.push(`#${i}: ${firstDiff(timingNormalized(a[i]), timingNormalized(b[i]))}`)
        }
      }
      if (t.unexplained.length) {
        // concurrent runs may interleave their requests differently; only then is order explained
        if (sameMultiset(a, b) || skMultiset(a, b)) {
          t.orderOnly = t.unexplained.length
          totals.orderOnly += t.unexplained.length
          t.unexplained = []
          t.note = 'same multiset of bodies in another arrival order (concurrent runs)'
        } else {
          totals.unexplained += t.unexplained.length
        }
      }
      if (t.pollingCountOnly) t.note = `${TIMING_DEPENDENT_TESTS[name]}: the number of rejected-poll entries in the conversation memory differs; everything else is byte-equal`
    }
    report.tests[name] = t
  }
  for (const f of newTests) if (!baseTests.has(f)) totals.testsOnlyInNew++
  report.totals = totals
  const problems = []
  if (!(totals.tests > 0)) problems.push('no test was compared')
  if (!(totals.bodies > 0)) problems.push('no request body was compared')
  if (!rx && totals.tests < minTests) problems.push(`only ${totals.tests} tests compared; the recorded baseline has ${minTests}`)
  if (!rx && totals.bodies < minBodies) problems.push(`only ${totals.bodies} bodies compared; the recorded corpus has at least ${minBodies}`)
  if (totals.testsOnlyInBase.length) problems.push(`tests present only in the base run (new dump missing): ${totals.testsOnlyInBase.slice(0, 6).join(', ')}`)
  if (totals.unreadable.length) problems.push(`unreadable dumps: ${totals.unreadable.slice(0, 3).join('; ')}`)
  if (totals.unexplained) problems.push(`${totals.unexplained} unexplained bodies`)
  if (totals.nonInputFieldsIdentical !== totals.bodies) problems.push(`non-input fields identical in only ${totals.nonInputFieldsIdentical} of ${totals.bodies} bodies`)
  return { status: problems.length ? 'FAIL' : 'PASS', problems, totals, report }
}

function main() {
  const args = process.argv.slice(2)
  const flag = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args.splice(i, 2)[1] : null
  }
  const reportPath = flag('--report')
  const only = flag('--tests')
  const minTests = flag('--min-tests')
  const minBodies = flag('--min-bodies')
  const [baseDir, newDir] = args
  if (!baseDir || !newDir) {
    console.error('usage: EM04C2-CompareBodies.cjs <baseDir> <newDir> [--report file] [--tests regex] [--min-tests N] [--min-bodies N]')
    process.exit(2)
  }
  const r = compareDirs(baseDir, newDir, { only, minTests: minTests === null ? 116 : +minTests, minBodies: minBodies === null ? 1000 : +minBodies })
  if (r.status === 'UNVERIFIED') {
    console.log('UNVERIFIED: ' + r.problems.join('; '))
    process.exit(2)
  }
  const { totals, report } = r
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify({ ...report, status: r.status, problems: r.problems }, null, 2) + '\n')
  console.log(`tests compared: ${totals.tests}  (only in base: ${totals.testsOnlyInBase.length}, only in new: ${totals.testsOnlyInNew})`)
  console.log(`bodies compared: ${totals.bodies}`)
  console.log(`  identical:               ${totals.identical}`)
  console.log(`  tool-output volatile only: ${totals.toolOutputOnly}  (cargo/wall-clock durations, parallel test-line order)`)
  console.log(`  order-only (concurrent): ${totals.orderOnly}`)
  console.log(`  polling-count-only:      ${totals.pollingCountOnly}  (one named timing-dependent test; NOT identical)`)
  console.log(`  UNEXPLAINED:             ${totals.unexplained}`)
  console.log(`non-input fields (model, tools, tool_choice, stream, limits, reasoning, ...) identical: ${totals.nonInputFieldsIdentical} of ${totals.bodies}`)
  for (const [name, t] of Object.entries(report.tests)) {
    if (t.unexplained.length) console.log(`UNEXPLAINED ${name}: ${t.unexplained.slice(0, 3).join('; ')}`)
    else if (t.note || t.toolOutputOnly) console.log(`explained ${name}: tool-output-only ${t.toolOutputOnly}${t.note ? '; ' + t.note : ''}`)
  }
  if (totals.testsOnlyInBase.length) console.log('tests present only in the base run: ' + totals.testsOnlyInBase.join(', '))
  console.log(`COMPARISON: ${r.status}${r.problems.length ? ' - ' + r.problems.join(' | ') : ''}`)
  process.exit(r.status === 'PASS' ? 0 : 1)
}

module.exports = { compareDirs, TIMING_DEPENDENT_TESTS }
if (require.main === module) main()
