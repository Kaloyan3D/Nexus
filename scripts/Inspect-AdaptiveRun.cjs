#!/usr/bin/env node
'use strict'
// Read-only inspection of a Nexus run from its DURABLE records (never the model's narrative): the run
// record, the HMAC'd engine-state record (engine, mode, attempts, efforts, selection events, limiter
// state, lineage) and the outcome. Prints no secret (neither record contains one).
//
//   NEXUS_HOME=~/.nexus-interactive-dev node scripts/Inspect-AdaptiveRun.cjs <run-id|latest> [--json]
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const home = process.env.NEXUS_HOME || path.join(os.homedir(), '.local', 'share', 'nexus')
const broker = path.join(home, 'broker')
const arg = process.argv[2]
if (!arg) { console.error('usage: Inspect-AdaptiveRun.cjs <run-id|latest> [--json]'); process.exit(2) }
const runsDir = path.join(broker, 'runs')
let file
if (arg === 'latest') {
  const all = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).map((f) => ({ f, t: fs.statSync(path.join(runsDir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
  file = all[0] && path.join(runsDir, all[0].f)
} else file = path.join(runsDir, arg.replace(/\.json$/, '') + '.json')
if (!file || !fs.existsSync(file)) { console.error('no such run record'); process.exit(1) }
const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
const run = rec.run || {}
const out = {
  run: { runId: run.runId, state: run.state, errorCode: run.errorCode || null, turns: run.turn || 0, toolCalls: run.toolCalls || 0, edits: run.editsUsed || 0, tests: run.testsUsed || 0, recoveries: run.recoveries || 0, compactions: run.contextCompactions || 0, tokensIn: run.usageInputTokens || null, tokensOut: run.usageOutputTokens || null, continuationOf: run.continuationOf || null, continuedAs: run.continuedAs || null, provider: run.providerId, remoteModel: run.remoteModelId, route: run.routeId },
  bound: { engineId: rec.engineId, modeId: rec.engineModeId, toolCatalogDigest: rec.toolCatalogDigest, engineStateStarted: rec.engineStateStarted },
  coding: run.codingOutcome ? { verification: run.codingOutcome.verification, change: run.codingOutcome.change, testsExecuted: run.codingOutcome.testsExecuted, lastExitCode: run.codingOutcome.lastExitCode } : null,
}
const sp = run.taskInstanceId && path.join(broker, 'engine', run.taskInstanceId + '.json')
if (sp && fs.existsSync(sp)) {
  const st = JSON.parse(fs.readFileSync(sp, 'utf8'))
  const eff = (st.attempts || []).map((a) => a.effort)
  out.engineState = {
    engineId: st.engineId, modeId: st.modeId, defaultEffort: st.defaultEffort, revision: st.revision,
    lineage: st.lineage || null,
    attempts: (st.attempts || []).map((a) => ({ ordinal: a.ordinal, effort: a.effort, state: a.state })),
    distinctEfforts: [...new Set(eff)],
    transitions: (st.events || []).filter((e) => e.kind === 'effort-selected' || e.kind === 'effort-reset-continuation').map((e) => ({ kind: e.kind, attempt: e.attempt, effort: e.effort, detail: e.detail })),
    ended: (st.events || []).filter((e) => e.kind === 'run-ended').map((e) => e.detail),
    limiter: st.payload && st.payload.adaptive ? st.payload.adaptive.limiter : null,
    history: ((st.payload && st.payload.history) || []).length,
  }
}
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2))
else {
  const r = out.run
  console.log(`run ${r.runId}: ${r.state}${r.errorCode ? ' (' + r.errorCode + ')' : ''}  turns ${r.turns}, tools ${r.toolCalls}, edits ${r.edits}, tests ${r.tests}, recoveries ${r.recoveries}, compactions ${r.compactions}, tokens in/out ${r.tokensIn}/${r.tokensOut}`)
  console.log(`bound: engine ${out.bound.engineId}  mode ${out.bound.modeId}  route ${r.route}  catalog ${String(out.bound.toolCatalogDigest).slice(0, 8)}`)
  if (out.coding) console.log(`outcome: verification=${out.coding.verification} change=${out.coding.change} testsExecuted=${out.coding.testsExecuted} lastExit=${out.coding.lastExitCode}`)
  const e = out.engineState
  if (e) {
    console.log(`engine state (authenticated record, revision ${e.revision}): default effort ${e.defaultEffort}; efforts used ${JSON.stringify(e.distinctEfforts)}; lineage ${e.lineage ? e.lineage.rule : 'none (first generation)'}`)
    console.log('attempts: ' + e.attempts.map((a) => `#${a.ordinal}:${a.effort}/${a.state}`).join(' '))
    console.log('effort events: ' + (e.transitions.length ? e.transitions.map((t) => `${t.kind}@${t.attempt == null ? '-' : t.attempt}→${t.effort}${t.detail ? ' (' + t.detail + ')' : ''}`).join('; ') : 'none'))
    console.log('limiter: ' + JSON.stringify(e.limiter) + '; run ended: ' + JSON.stringify(e.ended))
  } else console.log('no engine-state record (a run that never reached its engine)')
}
