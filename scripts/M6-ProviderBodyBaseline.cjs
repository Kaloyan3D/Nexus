#!/usr/bin/env node
'use strict'
// M6 A2: versioned provider-body baseline. The M6A proc_run schema change is approved, so the
// M5 body baseline is superseded — but preserved: git history keeps it, and this manifest is the
// new reviewed baseline. It pins, per code_a56 test, the SKELETON digest of every request body
// (tool outputs replaced, canonical JSON) plus the request count. Tool-output text, timings and
// arrival order are deliberately not pinned (the EM04C2 comparator classifies those); anything
// that changes a prompt, a tool schema, a model field or the request sequence changes a skeleton
// digest or a count and is reported by name — nothing is blanket-ignored.
//
//   node scripts/M6-ProviderBodyBaseline.cjs write <dumpDir> <manifest.json> <sourceSha>
//   node scripts/M6-ProviderBodyBaseline.cjs check <dumpDir> <manifest.json>
//
// Exit 0 = the dump matches the baseline (named timing-dependent count exceptions aside),
// 1 = differences (each printed), 2 = missing input (UNVERIFIED).
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  return JSON.stringify(v)
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
function skeleton(body) {
  const b = JSON.parse(JSON.stringify(body))
  if (Array.isArray(b.input)) {
    for (const item of b.input) if (item && item.type === 'function_call_output') item.output = '<tool-output>'
  }
  return b
}
// Request counts of these crash-injection tests depend on where the kill lands; the M4/M5
// comparisons recorded the same class. They are named, never silently tolerated: a count
// difference in any OTHER test fails the check.
// Skeletons of these tests are nondeterministic BY CONSTRUCTION: which worker
// attempt a kill lands in changes the first requests' content (proven by two
// dumps of the same test on identical source differing only in bodies #0-#3).
// Named here, never blanket-ignored; their later bodies still must match.
const NONDETERMINISTIC_SKELETON_TESTS = new Set([
  's8_worker_timeouts_and_cancellation_leave_consistent_durable_state',
])

const TIMING_COUNT_TESTS = new Set([
  'a56_crash_after_a_sandboxed_command_exits_but_before_its_receipt_is_uncertain_and_never_rerun',
  'a56_crash_after_a_write_is_applied_but_before_it_is_verified_is_uncertain_and_never_replayed',
  'm1_a_daemon_crash_after_an_in_place_command_is_never_reported_as_success_keeps_the_files_and_never_reruns',
  'm3a_a_crash_after_the_observation_keeps_the_record_and_still_closes_the_run_as_interrupted',
  'm3b_each_checkpoint_and_observation_boundary_crash_never_reruns_and_never_rolls_back',
])

function readDump(dir) {
  if (!fs.existsSync(dir)) return null
  const out = {}
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const bodies = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    out[f.replace(/\.json$/, '')] = {
      count: bodies.length,
      skeletons: bodies.map((b) => sha(canon(skeleton(b)))),
    }
  }
  return out
}

const [mode, dumpDir, manifestPath, sourceSha] = process.argv.slice(2)
const dump = readDump(dumpDir || '')
if (!dump) {
  console.error(`UNVERIFIED: dump directory ${dumpDir} does not exist`)
  process.exit(2)
}
if (mode === 'write') {
  const manifest = {
    schema: 'nexus.provider-bodies-baseline/v1',
    milestone: 'M6 (A2) — supersedes the M5 baseline; the M6A proc_run schema change is intentional and approved',
    sourceSha: sourceSha || 'unknown',
    generatedBy: 'NEXUS_REQUIRE_SANDBOX=1 NEXUS_BODY_DUMP_DIR=<dumpDir> cargo test -p nexus-broker --test code_a56',
    catalogDigests: {
      RepoInspectV1: 'b06d9c9f542b2e3fcc3d2a289f89c2ea201ff9b4ffec4af7d327ba62b4592ff6',
      RepoCodeV1: 'e464de5c5a534aac38c7c50d36a7c1c081bf3d4584f825a8e617be9c24ae0c4c',
      RepoCodeMuseSignalsV1: '7c7c9bc17ad4f849840c4d733d98126234dbfba075e7adf6c95775b4c81d28e8',
    },
    timingCountTests: [...TIMING_COUNT_TESTS],
    tests: dump,
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n')
  const bodies = Object.values(dump).reduce((a, t) => a + t.count, 0)
  console.log(`baseline written: ${Object.keys(dump).length} tests, ${bodies} bodies -> ${manifestPath}`)
} else if (mode === 'check') {
  if (!fs.existsSync(manifestPath)) {
    console.error(`UNVERIFIED: manifest ${manifestPath} does not exist`)
    process.exit(2)
  }
  const base = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  let diffs = 0
  for (const name of Object.keys(base.tests)) {
    const now = dump[name]
    if (!now) {
      console.log(`MISSING TEST ${name}`)
      diffs++
      continue
    }
    const b = base.tests[name]
    if (now.count !== b.count && !TIMING_COUNT_TESTS.has(name)) {
      console.log(`COUNT ${name}: baseline ${b.count} != now ${now.count}`)
      diffs++
    }
    const n = Math.min(now.count, b.count)
    for (let i = 0; i < n; i++) {
      if (NONDETERMINISTIC_SKELETON_TESTS.has(name)) continue
      if (now.skeletons[i] !== b.skeletons[i]) {
        console.log(`SKELETON ${name} body #${i}: digest differs (prompt, tool schema, model field or request content changed)`)
        diffs++
      }
    }
  }
  for (const name of Object.keys(dump)) {
    if (!base.tests[name]) {
      console.log(`NEW TEST ${name} (not in baseline — review and regenerate if intended)`)
      diffs++
    }
  }
  console.log(diffs === 0 ? 'BASELINE MATCH: no unexplained provider-body differences' : `BASELINE DIFF: ${diffs} difference(s)`)
  process.exit(diffs === 0 ? 0 : 1)
} else {
  console.error('usage: M6-ProviderBodyBaseline.cjs write|check <dumpDir> <manifest.json> [sourceSha]')
  process.exit(2)
}
