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
// the multiset of bodies is equal) | UNEXPLAINED. Any UNEXPLAINED body makes the exit status 1.
// The report holds digests, counts and JSON paths only: never a request body, never a credential.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : null
}
const reportPath = flag('--report')
const only = flag('--tests')
const [baseDir, newDir] = args
if (!baseDir || !newDir) {
  console.error('usage: EM04C2-CompareBodies.cjs <baseDir> <newDir> [--report file] [--tests regex]')
  process.exit(2)
}

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
  if (!/running \d+ tests?/.test(text)) return text
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

const list = (d) => new Set(fs.readdirSync(d).filter((f) => f.endsWith('.json')))
const baseTests = list(baseDir)
const newTests = list(newDir)
const rx = only ? new RegExp(only) : null
const report = { baseDir: path.basename(baseDir), newDir: path.basename(newDir), tests: {}, totals: {} }
const totals = { tests: 0, bodies: 0, identical: 0, toolOutputOnly: 0, orderOnly: 0, unexplained: 0, nonInputFieldsIdentical: 0, testsOnlyInBase: [], testsOnlyInNew: 0 }

for (const f of [...baseTests].sort()) {
  const name = f.replace(/\.json$/, '')
  if (rx && !rx.test(name)) continue
  if (!newTests.has(f)) {
    totals.testsOnlyInBase.push(name)
    continue
  }
  const a = JSON.parse(fs.readFileSync(path.join(baseDir, f), 'utf8'))
  const b = JSON.parse(fs.readFileSync(path.join(newDir, f), 'utf8'))
  const t = { bodies: [a.length, b.length], identical: 0, toolOutputOnly: 0, orderOnly: 0, unexplained: [] }
  totals.tests++
  if (a.length !== b.length) {
    t.unexplained.push(`request count ${a.length} != ${b.length}`)
    totals.unexplained++
  } else {
    totals.bodies += a.length
    const sameMultiset = (x, y) => canon(x.map(digest).sort()) === canon(y.map(digest).sort())
    const skMultiset = (x, y) => canon(x.map((v) => digest(timingNormalized(v))).sort()) === canon(y.map((v) => digest(timingNormalized(v))).sort())
    for (let i = 0; i < a.length; i++) {
      const { input: _ia, ...restA } = a[i]
      const { input: _ib, ...restB } = b[i]
      if (canon(restA) === canon(restB)) totals.nonInputFieldsIdentical++
      if (canon(a[i]) === canon(b[i])) {
        t.identical++
        totals.identical++
      } else if (canon(timingNormalized(a[i])) === canon(timingNormalized(b[i]))) {
        t.toolOutputOnly++
        totals.toolOutputOnly++
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
  }
  report.tests[name] = t
}
for (const f of newTests) if (!baseTests.has(f)) totals.testsOnlyInNew++
report.totals = totals
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')

console.log(`tests compared: ${totals.tests}  (only in base: ${totals.testsOnlyInBase.length}, only in new: ${totals.testsOnlyInNew})`)
console.log(`bodies compared: ${totals.bodies}`)
console.log(`  identical:               ${totals.identical}`)
console.log(`  tool-output volatile only: ${totals.toolOutputOnly}  (cargo/wall-clock durations, parallel test-line order)`)
console.log(`  order-only (concurrent): ${totals.orderOnly}`)
console.log(`  UNEXPLAINED:             ${totals.unexplained}`)
console.log(`non-input fields (model, tools, tool_choice, stream, limits, reasoning, ...) identical: ${totals.nonInputFieldsIdentical} of ${totals.bodies}`)
for (const [name, t] of Object.entries(report.tests)) {
  if (t.unexplained.length) console.log(`UNEXPLAINED ${name}: ${t.unexplained.slice(0, 3).join('; ')}`)
  else if (t.note || t.toolOutputOnly) console.log(`explained ${name}: tool-output-only ${t.toolOutputOnly}${t.note ? '; ' + t.note : ''}`)
}
if (totals.testsOnlyInBase.length) console.log('tests present only in the base run: ' + totals.testsOnlyInBase.join(', '))
process.exit(totals.unexplained ? 1 : 0)
