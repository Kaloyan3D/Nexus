#!/usr/bin/env node
'use strict'
// EM-04C2 S10-A / R3 readiness: an OFFLINE rehearsal of the operator workflow that precedes the first
// real OpenCode Go validation. Everything happens in a DISPOSABLE install/data root (the operator's
// saved selections are never read or written). No network, no provider call, no capability probe, no
// credential is read, nothing is printed that could be a secret.
//
//   node scripts/EM04C2-R3-Preflight.cjs [--json] [--keep]
//
// Exit 0 = every check passed. The ONE step it cannot do (and must not fake) is the live capability
// probe `verifyProviderRoute`; it prints the exact operator document and action for it.
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const MODEL_ID = 'operator/muse-spark-1.3-contributor-adaptive'
const ROUTE_ID = 'opencode-go/operator/muse-spark-1.3-contributor-adaptive'
const BASE_MODEL = 'meta/muse-spark-1.3-contributor'
const BASE_ROUTE = 'opencode-go/meta/muse-spark-1.3-contributor'
const ADAPTIVE = 'engineering-v2-adaptive'
const LADDER = ['low', 'medium', 'high', 'xhigh']

const results = []
function check(label, fn) {
  try {
    const detail = fn()
    results.push({ label, ok: true, detail: detail === undefined ? null : detail })
  } catch (e) {
    results.push({ label, ok: false, detail: String((e && e.message) || e).slice(0, 400) })
  }
}
function assert(c, m) { if (!c) throw new Error(m) }
const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)

const tmp = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'r3-preflight-'))
const root = path.join(tmp, 'inst')
const data = path.join(tmp, 'data')
const cfg = path.join(root, 'config')
fs.mkdirSync(cfg, { recursive: true })
fs.mkdirSync(data, { recursive: true })
fs.cpSync(path.join(repo, 'config', 'registry'), path.join(cfg, 'registry'), { recursive: true })
for (const f of ['model-registry.json', 'engineering-profiles.json', 'muse-profiles.json']) fs.copyFileSync(path.join(repo, 'config', f), path.join(cfg, f))
const svc = require(path.join(cfg, 'registry', 'service.cjs')).createService({ installRoot: root, dataRoot: data })
const v2 = require(path.join(cfg, 'registry', 'native-target-v2.cjs'))
const issuer = require(path.join(cfg, 'registry', 'native-issuer.cjs'))
const resolver = require(path.join(cfg, 'registry', 'resolver.cjs'))

const snap0 = svc.effectiveSnapshot().snapshot
const builtinModel = snap0.models.find((m) => m.id === BASE_MODEL)
const builtinRoute = snap0.routes.find((r) => r.id === BASE_ROUTE)
const builtinDigest = digest({ models: snap0.models, routes: snap0.routes })

// the operator documents (derived field-by-field from the built-in OpenCode Go entries; ONLY the scope,
// id and availability differ; nothing is invented)
const modelDoc = { ...builtinModel, id: MODEL_ID, displayName: 'Muse Spark 1.3 Contributor (OpenCode Go, adaptive, operator-scoped)', engines: ['nexus-adaptive-v1'] }
const routeDoc = { ...builtinRoute, id: ROUTE_ID, logicalModelId: MODEL_ID, availability: 'probe-required', reasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'] }
delete routeDoc.provenance

check('the built-in OpenCode Go Muse Spark entries exist and are what the plan assumes', () => {
  assert(builtinModel && builtinRoute, 'built-in entries missing')
  assert(builtinRoute.providerId === 'opencode-go' && builtinRoute.connectionId === 'conn-opencode-go', 'provider/connection identity')
  assert(builtinRoute.compatibility.transport === 'openai-responses', 'transport')
  assert(builtinRoute.executionKind === 'raw-model' && builtinRoute.remoteModelId === 'muse-spark-1.3-contributor', 'route identity')
  assert(builtinModel.capabilities.toolCalling === true && builtinModel.capabilities.reasoning === true, 'capabilities')
  assert(builtinModel.dataUseTier === 'contributor', 'tier')
  return { remoteModelId: builtinRoute.remoteModelId, transport: builtinRoute.compatibility.transport, tier: builtinModel.dataUseTier, builtinScope: builtinModel.engines }
})

check('the operator model is saved through the supported workflow, scoped ONLY to nexus-adaptive-v1', () => {
  const r = svc.saveModel(modelDoc, {})
  assert(r.ok === true, JSON.stringify(r.errors || r))
  const saved = svc.effectiveSnapshot().snapshot.models.find((m) => m.id === MODEL_ID)
  assert(JSON.stringify(saved.engines) === '["nexus-adaptive-v1"]', JSON.stringify(saved.engines))
  assert(saved.dataUseTier === 'contributor' && saved.capabilities.toolCalling && saved.capabilities.reasoning, 'capabilities/tier carried over')
})

check('a route cannot be saved as verified: there is no way to bypass the live probe', () => {
  const r = svc.saveRoute({ ...routeDoc, availability: 'verified' }, {})
  assert(r.ok === false && r.errors.some((e) => e.code === 'route-not-verified'), JSON.stringify(r))
})

check('the operator route is saved as probe-required (the state the live probe will upgrade)', () => {
  const r = svc.saveRoute(routeDoc, {})
  assert(r.ok === true, JSON.stringify(r.errors || r))
  const saved = svc.effectiveSnapshot().snapshot.routes.find((x) => x.id === ROUTE_ID)
  assert(saved.availability === 'probe-required', saved.availability)
  assert(saved.providerId === 'opencode-go' && saved.compatibility.transport === 'openai-responses' && saved.remoteModelId === 'muse-spark-1.3-contributor', 'identity')
})

check('the built-in catalog (including the historical Muse Spark entry) is untouched', () => {
  const s = svc.effectiveSnapshot().snapshot
  const b = s.models.find((m) => m.id === BASE_MODEL)
  assert(JSON.stringify(b.engines) === JSON.stringify(builtinModel.engines), 'built-in scope changed')
  const bi = digest({ models: s.models.filter((m) => m.id !== MODEL_ID), routes: s.routes.filter((r) => r.id !== ROUTE_ID) })
  assert(bi === builtinDigest, 'built-in models/routes changed')
})

const config = (over) => ({ schemaVersion: 1, modeId: ADAPTIVE, revision: 0, slots: { main: Object.assign({ logicalModelId: MODEL_ID, routeId: ROUTE_ID, reasoning: 'low', allowedReasoning: LADDER }, over || {}) }, roleOverrides: {} })

check('the adaptive configuration for the UNVERIFIED route is refused by the Registry and nothing is persisted', () => {
  const before = fs.readdirSync(data, { recursive: true }).sort().join('|')
  const r = svc.save(ADAPTIVE, config(), undefined, {})
  assert(r.ok === false, 'an unverified route was accepted')
  const codes = (r.errors || []).map((e) => e.code)
  assert(codes.length > 0, 'no refusal code')
  const after = fs.readdirSync(data, { recursive: true }).sort().join('|')
  assert(before === after, 'a refused save wrote something')
  return { refusal: codes }
})

check('adaptive needs an explicit mode AND a saved configuration: an issuance request without one is refused', () => {
  const out = v2.issueExecutionTargetV2({ installRoot: root, dataRoot: data, taskInstanceId: 'task-r3', sessionId: 'session-r3', selection: { modeId: ADAPTIVE, logicalModelId: MODEL_ID, routeId: ROUTE_ID } }, {})
  assert(out.ok === false, 'issued without a saved configuration / verified route')
  return { code: out.code }
})

check('no task can dispatch through the unverified route (selection refused before any issuance)', () => {
  const out = v2.issueExecutionTargetV2({ installRoot: root, dataRoot: data, taskInstanceId: 'task-r3b', sessionId: 'session-r3b', selection: { logicalModelId: MODEL_ID, routeId: ROUTE_ID } }, {})
  assert(out.ok === false && !out.target, 'unverified route issued under the default mode')
  return { code: out.code }
})

check('the default engineering-v2 is unchanged: it resolves to muse-v0 and compiles without any adaptive state', () => {
  const dflt = JSON.parse(fs.readFileSync(path.join(cfg, 'registry', 'modes', 'engineering-v2.json'), 'utf8'))
  assert(dflt.orchestrationEngineId === 'muse-v0' && dflt.status === 'active-legacy', 'default mode definition')
  assert(issuer.scopeOf('engineering-v2').engineId === 'muse-v0', 'issuer scope')
  const staged = svc.getModeConfiguration('engineering-v2', {})
  assert(staged.result && staged.result.config, 'no default preview')
  const prev = svc.compilePreview(staged.result.config)
  assert(prev.ok === true, JSON.stringify(prev.errors || prev))
  // the operator's adaptive model is not eligible for the default mode (scope), and nothing was saved for it
  assert(svc.listModes().modes.find((m) => m.id === ADAPTIVE).persisted === false, 'an adaptive configuration exists')
})

check('unsupported model/route combinations fail closed (chat-completions route, unscoped built-in, other providers)', () => {
  const snap = JSON.parse(JSON.stringify(svc.effectiveSnapshot().snapshot))
  const compile = (modelId, routeId) => resolver.compileModeConfig(config({ logicalModelId: modelId, routeId }), snap, null)
  const tried = []
  for (const [m, r] of [[BASE_MODEL, BASE_ROUTE], ['meta/muse-spark-1.3-contributor', 'meta-model-api/meta/muse-spark-1.3-contributor'], ['glm-5.3', 'zai-direct/glm-5.3'], ['gpt-5.6-sol', 'sol-local/gpt-5.6-sol'], ['deepseek-v4-pro', 'deepseek-pro-direct/deepseek-v4-pro']]) {
    const out = compile(m, r)
    assert(out.ok === false, m + ' / ' + r + ' was accepted for the adaptive mode')
    tried.push(m + ' via ' + r + ': ' + (out.errors || []).map((e) => e.code).join(','))
  }
  return tried
})

check('the transport and contract restrictions are those of S10-A (Responses only, closed contract table)', () => {
  assert(JSON.stringify(Object.keys(resolver.ADAPTIVE_CONTRACTS).sort()) === JSON.stringify(['muse-v0', 'nexus-adaptive-v1']), 'contract table')
  const rt = (transport) => resolver.checkAdaptiveContract('nexus-adaptive-v1', {}, 'muse_main', { id: 'm', dataUseTier: 'contributor', capabilities: { toolCalling: true, reasoning: true } }, { id: 'r', executionKind: 'raw-model', compatibility: { transport } }, {}).length
  assert(rt('openai-responses') === 0, 'responses refused')
  for (const t of ['openai-chat-completions', 'anthropic-messages', 'gemini-generate-content', 'local-openai-compatible']) assert(rt(t) > 0, t + ' accepted')
})

check('no historical muse-v1 alias exists', () => {
  for (const id of ['muse-v1', 'MUSE-V1', 'muse-v1 ']) assert(issuer.engineAllowed(issuer.scopeOf(ADAPTIVE), id) === false, id)
  assert(resolver.checkAdaptiveContract('muse-v1', {}, 'muse_main', {}, {}, {}).length === 1, 'former contract id accepted')
})

check('the same workflow with a route that WERE verified compiles (rehearsal on an in-memory copy, no receipt faked on disk)', () => {
  // the only difference between this and the real flow is the probe's effect on `availability`; this
  // proves the operator documents are otherwise acceptable to the adaptive contract. Disk state is
  // untouched and nothing here is evidence of provider behavior.
  const snap = JSON.parse(JSON.stringify(svc.effectiveSnapshot().snapshot))
  const route = snap.routes.find((r) => r.id === ROUTE_ID)
  route.availability = 'verified'
  const out = resolver.compileModeConfig(config(), snap, null)
  assert(out.ok === true, JSON.stringify(out.errors || out))
  const binding = Object.values(out.snapshot.roles)[0]
  assert(binding.slotRequirements.adaptiveReasoningContract === 'nexus-adaptive-v1', 'contract not sealed in the binding')
  assert(JSON.stringify(binding.allowedReasoning) === JSON.stringify(['high', 'low', 'medium', 'xhigh']), 'ladder')
  return { sealedEngine: out.snapshot.orchestrationEngineId, defaultReasoning: binding.reasoning, allowedReasoning: binding.allowedReasoning }
})

const livePacket = { saveModel: modelDoc, saveRoute: { ...routeDoc }, liveProbeAction: `service.verifyProviderRoute('${ROUTE_ID}') — a REAL request to opencode.ai (needs the owner's authorization and the stored OpenCode Go credential); then save the adaptive ModeConfiguration:`, saveMode: config() }
const failed = results.filter((r) => !r.ok)
const report = { preflight: 'EM-04C2-S10A-R3', disposableRoot: '(removed unless --keep)', checks: results, operatorPacket: livePacket, ok: failed.length === 0 }
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.detail ? '\n       ' + JSON.stringify(r.detail).slice(0, 300) : ''))
  console.log(failed.length ? `R3 PREFLIGHT: ${failed.length} FAILED` : 'R3 PREFLIGHT: all offline checks passed (the live probe has NOT been run)')
}
if (!process.argv.includes('--keep')) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
