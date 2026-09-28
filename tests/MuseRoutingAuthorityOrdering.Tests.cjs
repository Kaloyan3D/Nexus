'use strict'

/**
 * MuseRoutingAuthorityOrdering.Tests.cjs — controller routing authority vs
 * DSH `agent/request` waterfall ordering, against the REAL installed cordis
 * EventsService and the REAL DSH installModelSelection guard.
 *
 * The host is modelled the way dsh-host-apiproxy + dsh-agent-presets compose
 * it: each agent gets its own scope, installModelSelection runs in agent
 * setup, and a preset's rows are applied ONCE, when that preset's standing
 * mount is first created; every later session of the preset joins it. Agent
 * events are dispatched with a scope filter (root + joined preset + agent).
 *
 * The defect reproduced here: the first session of a preset composes
 * model-selection OUTSIDE the isolation row, but every later session composes
 * it INSIDE, so a controller route applied after `next()` reached DSH too late
 * and the default seed route tripped "route differs from its declared routing
 * authority".
 *
 * Every case runs under two model-selection semantics:
 *   installed - the vendored dsh-agent build (runtime/vendor). It exempts an
 *               authority declared BEFORE model-selection runs from the route
 *               comparison, so the pre-fix pattern passed there only because
 *               DSH did not validate the later sessions at all.
 *   strict    - the earlier nexus.1 build that was live when the defect was
 *               reported (always compares). Kept verbatim as a fixture so the
 *               production failure stays reproducible.
 * The fixed boundary must hold, with DSH validation actually running, under
 * both.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const repoRoot = path.resolve(__dirname, '..')
const profiles = require(path.join(repoRoot, 'config', 'Engineering-Profiles.cjs'))
const muse = require(path.join(repoRoot, 'config', 'Muse-Isolation.cjs'))
const engineering = require(path.join(repoRoot, 'config', 'Engineering-Isolation.cjs'))
const reasoningRuntime = require(path.join(repoRoot, 'config', 'Muse-ReasoningRuntime.cjs'))

const DSH_ROUTE_MISMATCH = (error) => error.message === 'agent/request route differs from its declared routing authority'
const DSH_LOWER_AUTHORITY = /lower routing authority cannot replace a higher route/
const DSH_SAME_AUTHORITY = /conflicting routing targets at the same authority/

const FLASH = { provider: 'flash-max-direct', model: 'deepseek-v4-flash' }
const MUSE_OPENCODE = { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }
const MUSE_META = { provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' }

let passed = 0
let modeLabel = ''
function pass(name) {
  passed += 1
  console.log(`PASS [${modeLabel}]: ${name}`)
}

function route(request) {
  return { provider: request.provider, model: request.model }
}

async function loadDsh() {
  const runtimeRoot = process.env.NEXUS_RUNTIME_ROOT || path.join(os.homedir(), '.local', 'share', 'nexus')
  const scope = path.join(runtimeRoot, 'app', 'node_modules', '@deepseek-ai')
  const { Context } = await import(pathToFileURL(path.join(scope, 'cordis', 'lib', 'index.js')).href)
  const { installModelSelection } = await import(pathToFileURL(path.join(scope, 'dsh-agent', 'lib', 'index.js')).href)
  return { Context, installModelSelection }
}

// ── controller fixture ──────────────────────────────────────────────────────

function makeInstallRoot() {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-route-order-'))
  fs.mkdirSync(path.join(installRoot, 'config'), { recursive: true })
  fs.copyFileSync(path.join(repoRoot, 'config', 'model-registry.json'), path.join(installRoot, 'config', 'model-registry.json'))
  return installRoot
}

function bindSession(installRoot, sessionId, engine, state) {
  const binding = {
    workspace: path.join(installRoot, 'workspace'),
    taskId: 'TASK-' + sessionId,
    taskInstanceId: 'instance-' + sessionId,
    preset: engine === 'muse' ? 'aih-muse' : 'aih-engineering',
    engine,
  }
  const bindingsFile = path.join(installRoot, 'data', 'routing', 'session-bindings.json')
  fs.mkdirSync(path.dirname(bindingsFile), { recursive: true })
  const document = fs.existsSync(bindingsFile)
    ? JSON.parse(fs.readFileSync(bindingsFile, 'utf8'))
    : { schemaVersion: 1, bindings: {} }
  document.bindings[sessionId] = binding
  fs.writeFileSync(bindingsFile, JSON.stringify(document))
  const statePath = profiles.routingStatePath(installRoot, binding)
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify({ ...binding, ...state }))
  return binding
}

function museState(target, profile) {
  return {
    profile,
    executionClass: 'muse_main',
    ...target,
    reasoning: 'xhigh',
    dataUseTier: 'contributor',
  }
}

// ── host model: agent scopes + standing preset mounts ───────────────────────

function createHost(dsh, plugins) {
  const root = new dsh.Context()
  const standing = new Map()

  function mountPreset(agent, presetId) {
    let mount = standing.get(presetId)
    if (mount === undefined) {
      const presetCtx = root.extend({})
      const pluginCtx = {
        on: (name, listener, options) => presetCtx.on(name, listener, options),
        shellEnv: { register() {} },
      }
      for (const plugin of plugins[presetId] || []) plugin(pluginCtx)
      mount = { presetCtx }
      standing.set(presetId, mount)
    }
    agent.preset = mount
  }

  /** agents.create: setup = installSelection, then presets.mount (dsh-host-apiproxy composeAgent). */
  function createAgent({ sessionId, presetId, selected, beforeMount }) {
    const agentCtx = root.extend({})
    const header = { agentPreset: presetId }
    const agent = { id: sessionId, ctx: agentCtx, session: { id: sessionId, header, events: [] }, preset: undefined }
    dsh.installModelSelection(agentCtx, { current: selected, assembled: undefined })
    if (beforeMount) beforeMount(agent)
    mountPreset(agent, presetId)
    agent.carrier = {
      [dsh.Context.filter]: (hookCtx) => hookCtx === root || hookCtx === agentCtx
        || (agent.preset !== undefined && hookCtx === agent.preset.presetCtx),
    }
    return agent
  }

  /** One loop step: prompt assembly, pre-step, then the agent/request waterfall over the seed. */
  async function step(agent, seed, options) {
    await root.waterfall(agent.carrier, 'system-prompt/assemble', {}, {}, async () => ({ variables: {} }))
    if (!(options && options.skipPreStep)) {
      await root.waterfall(agent.carrier, 'agent/pre-step', { agent, turn: 1, step: 1 },
        () => Promise.resolve({ kind: 'enter', messages: [] }))
    }
    return root.waterfall(agent.carrier, 'agent/request', { agent, turn: 1, step: 1 },
      () => Promise.resolve(Object.freeze({ ...seed })))
  }

  return { root, createAgent, step, standing }
}

/** The pre-fix Muse-Isolation request shape: declare, next(), rewrite afterwards. */
function legacyDeclareThenRewrite(target) {
  return (ctx) => {
    ctx.on('agent/request', async (payload, next) => {
      payload.routingAuthority = { source: 'controller', target }
      const proposed = await next()
      return Object.freeze({ ...proposed, ...target })
    })
  }
}

/**
 * Strict model-selection request listener, verbatim from the earlier
 * dsh-agent 0.1.1-rc.2-nexus.1 build (lib/types/model-selection.js before the
 * vendored `declared` exemption): the route is ALWAYS compared.
 */
function strictInstallModelSelection(agentCtx, selection) {
  const ROUTING_RANK = { default: 0, session: 1, preset: 2, controller: 3 }
  function validateAuthority(authority) {
    if (!authority || !Object.hasOwn(ROUTING_RANK, authority.source)
      || !authority.target || !authority.target.provider || !authority.target.model) {
      throw new Error('agent/request routing authority is invalid')
    }
  }
  function protectRoutingAuthority(payload) {
    let current = payload.routingAuthority
    if (current !== undefined) validateAuthority(current)
    Object.defineProperty(payload, 'routingAuthority', {
      enumerable: true,
      configurable: false,
      get: () => current,
      set: (candidate) => {
        validateAuthority(candidate)
        if (current !== undefined) {
          const oldRank = ROUTING_RANK[current.source]
          const newRank = ROUTING_RANK[candidate.source]
          const sameTarget = current.target.provider === candidate.target.provider
            && current.target.model === candidate.target.model
          if (newRank < oldRank) {
            if (!sameTarget) throw new Error('agent/request lower routing authority cannot replace a higher route')
            return
          }
          if (newRank === oldRank && !sameTarget) {
            throw new Error('agent/request conflicting routing targets at the same authority')
          }
        }
        current = candidate
      },
    })
  }
  agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } }
  })
  agentCtx.on('agent/request', async (payload, next) => {
    protectRoutingAuthority(payload)
    const resolved = await next()
    const authority = payload.routingAuthority
    if (authority !== undefined) {
      const { source, target } = authority
      if (resolved.provider !== target.provider || resolved.model !== target.model) {
        throw new Error('agent/request route differs from its declared routing authority')
      }
      if (source === 'controller' || source === 'preset') return resolved
    }
    const selected = selection.assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      provider: selected.provider,
      model: selected.model,
      ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort },
    }
  })
}

async function runSuite(dsh, mode) {
  modeLabel = mode
  const installRoot = makeInstallRoot()
  const previousHome = process.env.DSH_HOME
  const previousRoot = process.env.AIH_INSTALL_ROOT
  process.env.DSH_HOME = path.join(installRoot, 'data')
  process.env.AIH_INSTALL_ROOT = installRoot
  const plugins = { 'aih-muse': [muse.apply], 'aih-engineering': [engineering.apply] }
  const flashSeed = { ...FLASH, reasoningEffort: 'max', maxTokens: 65536 }

  try {
    // ── 0. Control: what the pre-fix pattern does in the second session ────
    {
      const host = createHost(dsh, { 'aih-muse': [legacyDeclareThenRewrite(MUSE_OPENCODE)] })
      const first = host.createAgent({ sessionId: 'legacy-1', presetId: 'aih-muse', selected: { ...FLASH } })
      assert.deepEqual(route(await host.step(first, flashSeed)), MUSE_OPENCODE)
      if (mode === 'strict') {
        const second = host.createAgent({ sessionId: 'legacy-2', presetId: 'aih-muse', selected: { ...FLASH } })
        await assert.rejects(host.step(second, flashSeed), DSH_ROUTE_MISMATCH)
        pass('control: pre-fix declare-then-rewrite passes the first session and fails every later one with the production DSH mismatch')
      } else {
        // A route change inside model-selection goes unvalidated: DSH exempts the
        // outer declaration and only the outer post-next() rewrite "fixes" it.
        const second = host.createAgent({
          sessionId: 'legacy-2', presetId: 'aih-muse', selected: { ...FLASH },
          beforeMount: (created) => created.ctx.on('agent/request', async (_payload, next) => Object.freeze({ ...(await next()), ...FLASH })),
        })
        assert.deepEqual(route(await host.step(second, flashSeed)), MUSE_OPENCODE)
        pass('control: pre-fix declare-then-rewrite is never route-validated by DSH in later sessions (outer declaration exemption)')
      }
    }

    // ── 1. The production regression: default flash seed, Muse OpenCode ───
    {
      const host = createHost(dsh, plugins)
      const requests = []
      for (const sessionId of ['oc-first', 'oc-second', 'oc-third']) {
        bindSession(installRoot, sessionId, 'muse', museState(MUSE_OPENCODE, 'muse-spark-1.3-contributor-opencode'))
        const agent = host.createAgent({ sessionId, presetId: 'aih-muse', selected: { ...FLASH, reasoningEffort: 'max' } })
        requests.push(await host.step(agent, flashSeed))
      }
      for (const request of requests) assert.deepEqual(route(request), MUSE_OPENCODE)
      assert.equal(host.standing.size, 1)
      pass('regression: default flash-max-direct/deepseek-v4-flash + controller Muse OpenCode -> opencode-go/muse-spark-1.3-contributor for the first AND every later session (no mismatch)')
    }

    // ── 1b. Standing mount created before the first agent (cold transcript read / recompose) ──
    {
      const host = createHost(dsh, plugins)
      const warm = host.createAgent({ sessionId: 'warmup-unbound', presetId: 'aih-muse', selected: { ...FLASH } })
      assert.ok(warm.preset)
      bindSession(installRoot, 'oc-after-warm', 'muse', museState(MUSE_OPENCODE, 'muse-spark-1.3-contributor-opencode'))
      const agent = host.createAgent({ sessionId: 'oc-after-warm', presetId: 'aih-muse', selected: { ...FLASH } })
      const request = await host.step(agent, flashSeed)
      assert.deepEqual(route(request), MUSE_OPENCODE)
      // Second step on the same agent: the rewrite is composed exactly once.
      const again = await host.step(agent, { ...route(request), reasoningEffort: request.reasoningEffort, maxTokens: request.maxTokens })
      assert.deepEqual(route(again), MUSE_OPENCODE)
      assert.equal(host.root.events._hooks['agent/request'].length, 1 + 1 + 1 + 1)
      pass('pre-existing standing mount: effective route is the controller target; rewrite registered once per agent')
    }

    // ── 2. Meta Direct Muse is unchanged ───────────────────────────────────
    {
      const host = createHost(dsh, plugins)
      for (const sessionId of ['meta-first', 'meta-second']) {
        bindSession(installRoot, sessionId, 'muse', museState(MUSE_META, 'muse-spark-1.3-contributor'))
        const agent = host.createAgent({ sessionId, presetId: 'aih-muse', selected: { ...FLASH } })
        assert.deepEqual(route(await host.step(agent, flashSeed)), MUSE_META)
      }
      pass('Meta Muse: meta-model-api/muse-spark-1.3-contributor in both composition orders')
    }

    // ── 3. Dual keeps its controller route; no Muse leak ───────────────────
    {
      const host = createHost(dsh, plugins)
      const dualCases = [
        ['dual-glm-1', { provider: 'zai-direct', model: 'glm-5.3-flash' }, FLASH],
        ['dual-glm-2', { provider: 'zai-direct', model: 'glm-5.3-flash' }, FLASH],
        ['dual-codex', { provider: 'sol-local', model: 'gpt-5.6-sol' }, FLASH],
        ['dual-flash', FLASH, FLASH],
        // Today's live default seed is the Muse OpenCode route: Dual must still get its own.
        ['dual-under-muse-default', FLASH, MUSE_OPENCODE],
      ]
      for (const [sessionId, target, seedRoute] of dualCases) {
        bindSession(installRoot, sessionId, 'dual', { profile: 'glm-codex', executionClass: 'engineer_normal', ...target, reasoning: 'high' })
        const agent = host.createAgent({ sessionId, presetId: 'aih-engineering', selected: { ...seedRoute } })
        const request = await host.step(agent, { ...seedRoute, reasoningEffort: 'max', maxTokens: 65536, temperature: 0 })
        assert.deepEqual(route(request), target, sessionId)
        assert.equal(request.reasoningEffort, 'high')
        assert.equal(request.maxTokens, 65536)
        assert.equal(request.temperature, 0)
      }
      pass('Dual: controller route (GLM, Codex, DeepSeek) wins in both orders, also under a Muse default seed; Dual has no Muse output ceiling')

      // A Muse-bound session can never execute on the Dual plane, and vice versa.
      bindSession(installRoot, 'muse-in-dual', 'muse', museState(MUSE_OPENCODE, 'muse-spark-1.3-contributor-opencode'))
      const museInDual = host.createAgent({ sessionId: 'muse-in-dual', presetId: 'aih-engineering', selected: { ...FLASH } })
      await assert.rejects(host.step(museInDual, flashSeed), (error) => error.code === 'engine-binding-violation')
      bindSession(installRoot, 'dual-in-muse', 'dual', { profile: 'glm-codex', executionClass: 'engineer_normal', ...FLASH, reasoning: 'high' })
      const dualInMuse = host.createAgent({ sessionId: 'dual-in-muse', presetId: 'aih-muse', selected: { ...FLASH } })
      await assert.rejects(host.step(dualInMuse, flashSeed), (error) => error.code === 'engine-binding-violation')
      pass('no Muse profile leaks into Dual and no Dual target runs on the Muse plane (engine-binding-violation)')

      // Workers keep delegation-row routing: no controller authority is declared for them.
      const worker = host.createAgent({ sessionId: 'dual-worker', presetId: 'aih-engineering', selected: { ...FLASH } })
      worker.session.header.origin = 'subagent'
      worker.session.header.delegationDepth = 1
      const workerSeed = { provider: 'deepseek-pro-direct', model: 'deepseek-v4-pro', reasoningEffort: 'high' }
      const workerRequest = await host.step(worker, workerSeed)
      assert.deepEqual(route(workerRequest), FLASH)
      pass('Dual worker: untouched by the controller boundary (DSH session selection applies as before)')
    }

    // ── 4. Deliberate mismatch still fails closed at the DSH guard ─────────
    {
      const host = createHost(dsh, plugins)
      bindSession(installRoot, 'mismatch', 'muse', museState(MUSE_OPENCODE, 'muse-spark-1.3-contributor-opencode'))
      let agentRef
      const agent = host.createAgent({
        sessionId: 'mismatch', presetId: 'aih-muse', selected: { ...FLASH },
        // A rogue agent-scoped listener between model-selection and the rewrite
        // turns the controller-declared request back into the DeepSeek route.
        beforeMount: (created) => {
          agentRef = created
          created.ctx.on('agent/request', async (_payload, next) => Object.freeze({ ...(await next()), ...FLASH }))
        },
      })
      assert.equal(agentRef, agent)
      await assert.rejects(host.step(agent, flashSeed), DSH_ROUTE_MISMATCH)
      pass('deliberate mismatch (first session): controller authority opencode-go/muse vs effective flash-max-direct/deepseek-v4-flash -> DSH guard fires (fail closed)')

      // Same rogue in a LATER session (standing mount already exists): the
      // declaration is still made inside model-selection, so DSH validates.
      bindSession(installRoot, 'mismatch-later', 'muse', museState(MUSE_OPENCODE, 'muse-spark-1.3-contributor-opencode'))
      const later = host.createAgent({
        sessionId: 'mismatch-later', presetId: 'aih-muse', selected: { ...FLASH },
        beforeMount: (created) => created.ctx.on('agent/request', async (_payload, next) => Object.freeze({ ...(await next()), ...FLASH })),
      })
      await assert.rejects(host.step(later, flashSeed), DSH_ROUTE_MISMATCH)
      pass('deliberate mismatch (later session): DSH guard still fires - validation runs in every composition order')

      bindSession(installRoot, 'not-composed', 'muse', museState(MUSE_OPENCODE, 'muse-spark-1.3-contributor-opencode'))
      const bare = host.createAgent({ sessionId: 'not-composed', presetId: 'aih-muse', selected: { ...FLASH } })
      await assert.rejects(host.step(bare, flashSeed, { skipPreStep: true }), /controller-route-rewrite-not-composed/)
      pass('fail closed when the controller rewrite is not composed for the agent (never the default route)')
    }

    // ── 5. Lower authority cannot replace the controller route ─────────────
    {
      const host = createHost(dsh, plugins)
      for (const source of ['preset', 'session', 'default']) {
        const sessionId = 'lower-' + source
        bindSession(installRoot, sessionId, 'muse', museState(MUSE_OPENCODE, 'muse-spark-1.3-contributor-opencode'))
        const agent = host.createAgent({ sessionId, presetId: 'aih-muse', selected: { ...FLASH } })
        assert.deepEqual(route(await host.step(agent, flashSeed)), MUSE_OPENCODE)
        agent.ctx.on('agent/request', async (payload, next) => {
          payload.routingAuthority = { source, target: { ...FLASH } }
          return next()
        })
        await assert.rejects(host.step(agent, flashSeed), DSH_LOWER_AUTHORITY)
      }
      pass('lower authority (preset/session/default) cannot replace the established controller route')
    }

    // ── 6. Same-authority conflict fails closed; no last-writer-wins ───────
    {
      const host = createHost(dsh, plugins)
      bindSession(installRoot, 'same-authority', 'muse', museState(MUSE_OPENCODE, 'muse-spark-1.3-contributor-opencode'))
      const agent = host.createAgent({ sessionId: 'same-authority', presetId: 'aih-muse', selected: { ...FLASH } })
      assert.deepEqual(route(await host.step(agent, flashSeed)), MUSE_OPENCODE)
      const dispose = agent.ctx.on('agent/request', async (payload, next) => {
        payload.routingAuthority = { source: 'controller', target: { ...MUSE_META } }
        return next()
      })
      await assert.rejects(host.step(agent, flashSeed), DSH_SAME_AUTHORITY)
      dispose()
      agent.ctx.on('agent/request', async (payload, next) => {
        payload.routingAuthority = { source: 'controller', target: { ...MUSE_OPENCODE } }
        return next()
      })
      assert.deepEqual(route(await host.step(agent, flashSeed)), MUSE_OPENCODE)
      pass('two controller claims with different targets fail closed; an identical claim is not a conflict')
    }

    // ── 7. Adaptive reasoning is the final effort on the controller route ──
    {
      const host = createHost(dsh, plugins)
      host.createAgent({ sessionId: 'reasoning-warm', presetId: 'aih-muse', selected: { ...FLASH } })
      for (const [target, profile] of [[MUSE_OPENCODE, 'muse-spark-1.3-contributor-opencode'], [MUSE_META, 'muse-spark-1.3-contributor']]) {
        const sessionId = 'reasoning-' + target.provider
        const binding = bindSession(installRoot, sessionId, 'muse', museState(target, profile))
        const agent = host.createAgent({ sessionId, presetId: 'aih-muse', selected: { ...FLASH, reasoningEffort: 'max' } })
        const efforts = []
        reasoningRuntime.setMuseReasoningPhase({ installRoot, binding, phase: 'discover' })
        efforts.push((await host.step(agent, flashSeed)).reasoningEffort)
        reasoningRuntime.setMuseReasoningPhase({ installRoot, binding, phase: 'diagnose' })
        efforts.push((await host.step(agent, flashSeed)).reasoningEffort)
        reasoningRuntime.recordMuseHypothesisFailure({ installRoot, binding })
        reasoningRuntime.recordMuseHypothesisFailure({ installRoot, binding })
        const escalated = await host.step(agent, flashSeed)
        efforts.push(escalated.reasoningEffort)
        assert.deepEqual(efforts, ['medium', 'high', 'xhigh'], target.provider)
        assert.deepEqual(route(escalated), target)
      }
      pass('adaptive reasoning: medium/high/xhigh is the final effort for opencode-go and meta-model-api (DSH session effort max never survives)')
    }

    // ── 8. Output bound and untouched request fields ───────────────────────
    {
      const host = createHost(dsh, plugins)
      host.createAgent({ sessionId: 'bound-warm', presetId: 'aih-muse', selected: { ...FLASH } })
      const cases = [
        [{ maxTokens: 131072 }, muse.MUSE_V0_MAX_OUTPUT_TOKENS],
        [{ maxTokens: 8192 }, 8192],
        [{}, muse.MUSE_V0_MAX_OUTPUT_TOKENS],
      ]
      let index = 0
      for (const [extra, expected] of cases) {
        const sessionId = 'bound-' + (index += 1)
        bindSession(installRoot, sessionId, 'muse', museState(MUSE_OPENCODE, 'muse-spark-1.3-contributor-opencode'))
        const agent = host.createAgent({ sessionId, presetId: 'aih-muse', selected: { ...FLASH } })
        const request = await host.step(agent, { ...FLASH, reasoningEffort: 'max', temperature: 0.2, stop: ['<END>'], ...extra })
        assert.equal(request.maxTokens, expected)
        assert.equal(request.temperature, 0.2)
        assert.deepEqual(request.stop, ['<END>'])
        assert.deepEqual(route(request), MUSE_OPENCODE)
        assert.ok(Object.isFrozen(request))
        assert.equal(agent.session.id, sessionId)
      }
      assert.equal(muse.MUSE_V0_MAX_OUTPUT_TOKENS, 32768)
      pass('MUSE_V0_MAX_OUTPUT_TOKENS (32768) still caps every Muse request; temperature/stop preserved; session identity untouched')
    }

  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    if (previousRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = previousRoot
    fs.rmSync(installRoot, { recursive: true, force: true })
  }
}

async function main() {
  const dsh = await loadDsh()
  await runSuite(dsh, 'installed')
  await runSuite({ ...dsh, installModelSelection: strictInstallModelSelection }, 'strict')
  console.log(`SUITE RESULT: PASS ${passed} | FAIL 0 | total ${passed}`)
}

main().catch((error) => {
  console.error('FAIL: MuseRoutingAuthorityOrdering suite failed:', error)
  process.exitCode = 1
})
