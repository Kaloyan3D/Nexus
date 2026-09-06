'use strict'

/**
 * MuseProvider.Tests.cjs — Phase M2 runtime-plane coverage for the Meta
 * Model API provider transport (Muse engine).
 *
 * Fully OFFLINE: the HTTP-level scenarios run against a local 127.0.0.1 mock
 * provider, so no network access and no real key are ever required.
 *
 * Layers covered:
 *   - config/Nexus-Profiles.cjs   Muse profile -> model registry -> provider
 *   - ui/nexus-controller/lib/engineering.cjs  engine-scoped role filtering
 *   - scripts/Invoke-MetaProbe.mjs  transport contract (unit + real wire)
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const repoRoot = path.resolve(__dirname, '..')
const nexusProfiles = require(path.join(repoRoot, 'config', 'Nexus-Profiles.cjs'))
const engineering = require(path.join(repoRoot, 'ui', 'nexus-controller', 'lib', 'engineering.cjs'))

const TEST_KEY = 'aih-muse-runtime-suite-not-a-real-secret-0123456789'
let passed = 0
function pass(name) { passed++; console.log('PASS: ' + name) }

async function loadProbe() {
  return import(pathToFileURL(path.join(repoRoot, 'scripts', 'Invoke-MetaProbe.mjs')).href)
}

function loadRegistry() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'model-registry.json'), 'utf8'))
}

function registryEntry(registry, id) {
  for (const entry of registry.models || []) {
    if (entry && String(entry.id) === id) return entry
  }
  return null
}

/** One local OpenAI-compatible mock provider for wire-level scenarios. */
function startMockProvider(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' }))
  })
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(raw)) } catch { resolve(null) }
    })
  })
}

function sse(res, blocks, { end = true, delayMs = 5 } = {}) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  let index = 0
  const timer = setInterval(() => {
    if (index >= blocks.length) {
      clearInterval(timer)
      if (end) res.end()
      return
    }
    res.write(blocks[index] + '\n\n')
    index++
  }, delayMs)
  return timer
}

async function main() {
  const probe = await loadProbe()
  const registry = loadRegistry()

  // ── 1. Registry / engine scope (JS mirror of the controller rules) ──────
  const museEntry = registryEntry(registry, 'muse-spark-1.3')
  assert.ok(museEntry, 'muse-spark-1.3 is registered')
  assert.equal(museEntry.vendor, 'Meta')
  assert.equal(museEntry.provider, 'meta-model-api')
  pass('1.1: registry entry resolves to Meta / meta-model-api')

  for (const role of ['primaryEngineer', 'deepEngineer', 'reviewer', 'solver', 'fallback', 'visualReviewer']) {
    const ids = engineering.compatibleModelsForRole(registry, role)
    assert.ok(!ids.includes('muse-spark-1.3'), 'muse must not serve Dual role ' + role)
  }
  pass('1.2: muse-spark-1.3 never appears in Dual role model lists (JS plane)')

  assert.ok(engineering.compatibleModelsForRole(registry, 'primaryEngineer').includes('glm-5.3'),
    'pre-M2 entries keep Dual eligibility')
  pass('1.3: pre-M2 registry entries keep their Dual role eligibility')

  const scoped = {
    schemaVersion: 1,
    models: [
      { id: 'explicit-dual', displayName: 'D', enabled: true, supportsTools: true, supportsReasoning: true, supportedReasoningLevels: ['high'], providers: { default: 'p' }, agentEngines: ['dual'] },
      { id: 'muse-only', displayName: 'M', enabled: true, supportsTools: true, supportsReasoning: true, supportedReasoningLevels: ['xhigh'], providers: { default: 'p' }, agentEngines: ['muse'] },
      { id: 'multi', displayName: 'X', enabled: true, supportsTools: true, supportsReasoning: true, supportedReasoningLevels: ['high'], providers: { default: 'p' }, agentEngines: ['dual', 'muse'] },
    ],
  }
  const ids = engineering.compatibleModelsForRole(scoped, 'primaryEngineer')
  assert.ok(ids.includes('explicit-dual') && ids.includes('multi') && !ids.includes('muse-only'))
  pass('1.4: agentEngines scoping is additive and metadata driven')

  const bindingTarget = engineering.roleBindingTarget(
    registry,
    { id: 'muse-leak', displayName: 'x', roles: { primaryEngineer: { model: 'muse-spark-1.3', reasoning: 'xhigh' } } },
    'primaryEngineer',
  )
  assert.equal(bindingTarget, null)
  pass('1.5: a Dual role binding that names the Muse model fails closed')

  // ── 2. Muse profile -> registry -> provider chain ────────────────────────
  const museDoc = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'muse-profiles.json'), 'utf8'))
  const museProfile = museDoc.profiles.find((p) => p && p.id === 'muse-spark-1.3')
  assert.ok(museProfile, 'muse profile present')
  assert.equal(nexusProfiles.museModelBindingOf(museProfile), 'muse-spark-1.3')
  pass('2.1: Muse profile binds the model registry id, never a provider id')

  const resolved = nexusProfiles.resolveMuseProfileModel(repoRoot, 'muse-spark-1.3')
  assert.ok(resolved, 'muse model binding resolves')
  assert.equal(resolved.provider, 'meta-model-api')
  assert.equal(resolved.model, 'muse-spark-1.3')
  assert.equal(resolved.reasoning, 'xhigh')
  assert.equal(resolved.dataUseTier, 'standard')
  pass('2.2: binding chain resolves profile -> registry -> provider with reasoning and dataUseTier')

  const maxResolved = nexusProfiles.resolveMuseProfileModel(repoRoot, 'muse-spark-1.3', 'max')
  assert.ok(maxResolved && maxResolved.provider === 'meta-model-api' && maxResolved.reasoning === 'max')
  pass('2.3: escalation level max resolves through the same provider route')

  assert.equal(nexusProfiles.resolveMuseProfileModel(repoRoot, 'no-such-muse-profile'), null)
  pass('2.4: unknown Muse profile fails closed')

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-runtime-'))
  fs.mkdirSync(path.join(fixtureRoot, 'config'), { recursive: true })
  for (const name of ['routing-policy.json', 'engineering-profiles.json', 'model-registry.json', 'nexus-profiles.json']) {
    fs.copyFileSync(path.join(repoRoot, 'config', name), path.join(fixtureRoot, 'config', name))
  }
  const leakedRegistry = JSON.parse(JSON.stringify(registry))
  const leakedEntry = registryEntry(leakedRegistry, 'muse-spark-1.3')
  leakedEntry.agentEngines = ['dual']
  leakedEntry.enabled = true
  fs.writeFileSync(path.join(fixtureRoot, 'config', 'model-registry.json'), JSON.stringify(leakedRegistry))
  fs.copyFileSync(path.join(repoRoot, 'config', 'muse-profiles.json'), path.join(fixtureRoot, 'config', 'muse-profiles.json'))
  assert.equal(nexusProfiles.resolveMuseProfileModel(fixtureRoot, 'muse-spark-1.3'), null,
    'a muse-bound model that Dual roles could also claim must not serve the Muse plane')
  pass('2.5: a muse profile cannot bind a model scoped away from the muse engine')

  const disabledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-runtime-'))
  fs.mkdirSync(path.join(disabledRoot, 'config'), { recursive: true })
  for (const name of ['routing-policy.json', 'engineering-profiles.json', 'nexus-profiles.json', 'muse-profiles.json']) {
    fs.copyFileSync(path.join(repoRoot, 'config', name), path.join(disabledRoot, 'config', name))
  }
  const disabledRegistry = JSON.parse(JSON.stringify(registry))
  registryEntry(disabledRegistry, 'muse-spark-1.3').enabled = false
  fs.writeFileSync(path.join(disabledRoot, 'config', 'model-registry.json'), JSON.stringify(disabledRegistry))
  assert.equal(nexusProfiles.resolveMuseProfileModel(disabledRoot, 'muse-spark-1.3'), null)
  pass('2.6: a disabled registry model fails closed')

  fs.rmSync(fixtureRoot, { recursive: true, force: true })
  fs.rmSync(disabledRoot, { recursive: true, force: true })

  // ── 3. Probe unit contract ──────────────────────────────────────────────
  const body = probe.buildRequestBody({
    model: 'muse-spark-1.3',
    prompt: 'hi',
    stream: true,
    reasoningEffort: 'high',
    tools: [{ type: 'function', function: { name: 'get_test_temperature', parameters: {} } }],
    toolChoice: 'auto',
    maxCompletionTokens: 64,
  })
  assert.equal(body.model, 'muse-spark-1.3')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.max_completion_tokens, 64)
  assert.ok(Array.isArray(body.tools) && body.tools[0].function.name === 'get_test_temperature')
  pass('3.1: request body carries the verified Meta wire fields')

  const offBody = probe.buildRequestBody({ model: 'muse-spark-1.3', prompt: 'hi', reasoningEffort: '' })
  assert.ok(!('reasoning_effort' in offBody))
  pass('3.2: Nexus off omits reasoning_effort (send nothing)')

  assert.match(probe.validateRequest({ baseUrl: 'not-a-url', model: 'm', apiKeyEnv: 'K', prompt: 'p' }), /baseUrl/)
  assert.match(probe.validateRequest({ baseUrl: 'http://x/v1', model: 'm', apiKeyEnv: 'K', prompt: 'p', toolChoice: 'required' }), /toolChoice/)
  assert.equal(probe.validateRequest({ baseUrl: 'http://x/v1', model: 'm', apiKeyEnv: 'K', prompt: 'p' }), null)
  pass('3.3: request validation fails closed (bad URL, non-auto tool_choice)')

  assert.deepEqual(probe.parseSseBlock('data: {"choices":[{"delta":{"content":"AB"}}]}'), { content: 'AB', toolCallDeltas: null, finishReason: null, usage: null })
  assert.equal(probe.parseSseBlock(': keep-alive').content, null)
  assert.equal(probe.parseSseBlock('data: [DONE]').done, true)
  assert.equal(probe.parseSseBlock('data: {"choices":[],"usage":{"prompt_tokens":3}}').usage.prompt_tokens, 3)
  assert.equal(probe.parseSseBlock('data: {bad').error, 'stream-malformed')
  pass('3.4: SSE block parser handles deltas, keep-alives, DONE, usage-only, malformed')

  assert.equal(probe.redactSecrets('token sk-secret-abcdef and sk-secret-abcdef again', 'sk-secret-abcdef'), 'token <redacted> and <redacted> again')
  pass('3.5: key material is redacted from surfaced text')

  // ── 4. Probe through mocks (deterministic, no server) ───────────────────
  const previousKey = process.env.MODEL_API_KEY
  const previousGate = process.env.NEXUS_META_LIVE_TEST
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-probe-'))
  try {
    delete process.env.NEXUS_META_LIVE_TEST
    const missing = await probe.runProbe({ baseUrl: 'https://api.meta.ai/v1', apiKeyEnv: 'MODEL_API_KEY', model: 'muse-spark-1.3', prompt: 'x' })
    assert.equal(missing.outcome.ok, false)
    assert.equal(missing.outcome.errorKind, 'missing-api-key')
    assert.equal(missing.exitCode, 0)
    pass('4.1: missing credentials are a probe finding, not a crash')

    process.env.MODEL_API_KEY = TEST_KEY
    const mockPath = path.join(tmp, 'mock-echo.json')
    fs.writeFileSync(mockPath, JSON.stringify({ status: 200, body: { model: 'muse-spark-1.3', choices: [{ index: 0, message: { role: 'assistant', content: 'NEXUS' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, completion_tokens_details: { reasoning_tokens: 2 } } }, echoRequest: true }))
    const echoed = await probe.runProbe({ baseUrl: 'https://api.meta.ai/v1', apiKeyEnv: 'MODEL_API_KEY', model: 'muse-spark-1.3', prompt: 'Reply with exactly the word NEXUS.', reasoningEffort: 'high', mockFile: mockPath })
    assert.equal(echoed.outcome.ok, true)
    assert.equal(echoed.outcome.content, 'NEXUS')
    assert.equal(echoed.outcome.usage.reasoningTokens, 2)
    assert.equal(echoed.outcome.resulting.reasoning_effort, 'high')
    pass('4.2: text round trip with usage and the mapped reasoning_effort on the wire')

    const streamPath = path.join(tmp, 'mock-stream.json')
    fs.writeFileSync(streamPath, JSON.stringify([
      'data: {"choices":[{"index":0,"delta":{"content":"NEX"}}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"US"}}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6,"completion_tokens_details":{"reasoning_tokens":2}}}',
      'data: [DONE]',
    ]))
    const streamed = await probe.runProbe({ baseUrl: 'https://api.meta.ai/v1', apiKeyEnv: 'MODEL_API_KEY', model: 'muse-spark-1.3', prompt: 'x', stream: true, mockStreamFile: streamPath })
    assert.equal(streamed.outcome.ok, true)
    assert.equal(streamed.outcome.content, 'NEXUS')
    assert.equal(streamed.outcome.finishReason, 'stop')
    assert.equal(streamed.outcome.usage.reasoningTokens, 2)
    assert.ok(streamed.outcome.ttftMs != null)
    pass('4.3: streaming contract: deltas, termination, final usage, TTFT')

    const cutPath = path.join(tmp, 'mock-cut.json')
    fs.writeFileSync(cutPath, JSON.stringify(['data: {"choices":[{"index":0,"delta":{"content":"PAR"}}]}']))
    const cut = await probe.runProbe({ baseUrl: 'https://api.meta.ai/v1', apiKeyEnv: 'MODEL_API_KEY', model: 'muse-spark-1.3', prompt: 'x', stream: true, mockStreamFile: cutPath })
    assert.equal(cut.outcome.ok, false)
    assert.equal(cut.outcome.errorKind, 'stream-interrupted')
    assert.equal(cut.outcome.content, 'PAR')
    pass('4.4: interrupted stream fails closed but keeps the partial content')
  } finally {
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
    if (previousGate === undefined) delete process.env.NEXUS_META_LIVE_TEST
    else process.env.NEXUS_META_LIVE_TEST = previousGate
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  // ── 5. Probe over the real wire against a local mock provider ───────────
  process.env.MODEL_API_KEY = TEST_KEY
  try {
    // 5.1 normalized 401 with key echo (secret never surfaces)
    const unauthorized = await startMockProvider((req, res) => {
      void readBody(req)
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'bad key ' + (req.headers.authorization || ''), type: 'authentication_error', param: null, code: null } }))
    })
    try {
      const outcome = await probe.runProbe({ baseUrl: unauthorized.baseUrl, apiKeyEnv: 'MODEL_API_KEY', model: 'muse-spark-1.3', prompt: 'x' })
      assert.equal(outcome.outcome.ok, false)
      assert.equal(outcome.outcome.errorKind, 'provider-error')
      assert.equal(outcome.outcome.status, 401)
      const text = JSON.stringify(outcome.outcome)
      assert.ok(!text.includes(TEST_KEY), 'the key must never appear in an error outcome')
      assert.ok(text.includes('<redacted>'), 'echoed key material must be scrubbed')
      pass('5.1: 401 normalized; echoed credential scrubbed from the error')
    } finally { unauthorized.server.close() }

    // 5.2 normalized 429 and 5xx
    for (const status of [429, 500]) {
      const failing = await startMockProvider((req, res) => {
        void readBody(req)
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'synthetic ' + status, type: 'provider_error', param: null, code: null } }))
      })
      try {
        const outcome = await probe.runProbe({ baseUrl: failing.baseUrl, apiKeyEnv: 'MODEL_API_KEY', model: 'muse-spark-1.3', prompt: 'x' })
        assert.equal(outcome.outcome.errorKind, 'provider-error')
        assert.equal(outcome.outcome.status, status)
        assert.ok(!JSON.stringify(outcome.outcome).includes(TEST_KEY))
        pass('5.2.' + status + ': HTTP ' + status + ' normalized without leaking the key')
      } finally { failing.server.close() }
    }

    // 5.3 timeout classification against a server that never answers
    const hanging = await startMockProvider(() => { /* never respond */ })
    try {
      const outcome = await probe.runProbe({ baseUrl: hanging.baseUrl, apiKeyEnv: 'MODEL_API_KEY', model: 'muse-spark-1.3', prompt: 'x', timeoutMs: 400 })
      assert.equal(outcome.outcome.ok, false)
      assert.equal(outcome.outcome.errorKind, 'timeout')
      pass('5.3: timeout is classified and normalized')
    } finally { hanging.server.close() }

    // 5.4 malformed SSE chunk over the real wire
    const malformedStream = await startMockProvider(async (req, res) => {
      await readBody(req)
      sse(res, [
        'data: {"choices":[{"index":0,"delta":{"content":"PAR"}}]}',
        'data: {not-json',
      ])
    })
    try {
      const outcome = await probe.runProbe({ baseUrl: malformedStream.baseUrl, apiKeyEnv: 'MODEL_API_KEY', model: 'muse-spark-1.3', prompt: 'x', stream: true })
      assert.equal(outcome.outcome.errorKind, 'stream-malformed')
      assert.equal(outcome.outcome.content, 'PAR')
      assert.equal(outcome.outcome.interrupted, true)
      pass('5.4: malformed streaming chunk normalized; partial content preserved')
    } finally { malformedStream.server.close() }

    // 5.5 interrupted stream over the real wire (server closes without DONE)
    const interruptedStream = await startMockProvider(async (req, res) => {
      await readBody(req)
      sse(res, ['data: {"choices":[{"index":0,"delta":{"content":"CUT"}}]}'])
    })
    try {
      const outcome = await probe.runProbe({ baseUrl: interruptedStream.baseUrl, apiKeyEnv: 'MODEL_API_KEY', model: 'muse-spark-1.3', prompt: 'x', stream: true })
      assert.equal(outcome.outcome.errorKind, 'stream-interrupted')
      assert.equal(outcome.outcome.content, 'CUT')
      pass('5.5: interrupted stream normalized over the real wire')
    } finally { interruptedStream.server.close() }

    // 5.6 full streaming round trip on the real wire (deltas + usage + tool)
    const good = await startMockProvider(async (req, res) => {
      const bodyDoc = await readBody(req)
      if (!bodyDoc || bodyDoc.stream_options === undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'stream_options.include_usage must be sent', type: 'invalid_request_error' } }))
        return
      }
      if (Array.isArray(bodyDoc.tools)) {
        sse(res, [
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_wire_1","type":"function","function":{"name":"get_test_temperature"}}]}}]}',
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13,"completion_tokens_details":{"reasoning_tokens":1}}}',
          'data: [DONE]',
        ])
        return
      }
      sse(res, [
        'data: {"choices":[{"index":0,"delta":{"content":"NEX"}}]}',
        'data: {"choices":[{"index":0,"delta":{"content":"US"}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6,"completion_tokens_details":{"reasoning_tokens":2}}}',
        'data: [DONE]',
      ])
    })
    try {
      const streamOutcome = await probe.runProbe({ baseUrl: good.baseUrl, apiKeyEnv: 'MODEL_API_KEY', model: 'muse-spark-1.3', prompt: 'x', stream: true })
      assert.equal(streamOutcome.outcome.ok, true)
      assert.equal(streamOutcome.outcome.content, 'NEXUS')
      assert.equal(streamOutcome.outcome.finishReason, 'stop')
      assert.equal(streamOutcome.outcome.usage.reasoningTokens, 2)
      pass('5.6: real-wire streaming: deltas accumulate, usage chunk honored')

      const toolOutcome = await probe.runProbe({
        baseUrl: good.baseUrl,
        apiKeyEnv: 'MODEL_API_KEY',
        model: 'muse-spark-1.3',
        prompt: 'What is the test temperature in Paris?',
        tools: [{ type: 'function', function: { name: 'get_test_temperature', description: 'Recorded test temperature.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
        toolChoice: 'auto',
        stream: true,
      })
      assert.equal(toolOutcome.outcome.ok, true)
      assert.equal(toolOutcome.outcome.mode, 'stream-tool')
      assert.equal(toolOutcome.outcome.toolCalls.length, 1)
      assert.equal(toolOutcome.outcome.toolCalls[0].id, 'call_wire_1')
      assert.equal(toolOutcome.outcome.toolCalls[0].name, 'get_test_temperature')
      assert.deepEqual(JSON.parse(toolOutcome.outcome.toolCalls[0].arguments), { city: 'Paris' })
      pass('5.7: real-wire streaming tool call: id, name, JSON arguments assembled from deltas')
    } finally { good.server.close() }

    // 5.8 non-stream tool call + developer-agnostic request shape on the wire
    const toolServer = await startMockProvider(async (req, res) => {
      const bodyDoc = await readBody(req)
      lastWireBody = bodyDoc
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        model: 'muse-spark-1.3',
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_wire_2', type: 'function', function: { name: 'get_test_temperature', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
      }))
    })
    let lastWireBody = null
    try {
      const outcome = await probe.runProbe({
        baseUrl: toolServer.baseUrl,
        apiKeyEnv: 'MODEL_API_KEY',
        model: 'muse-spark-1.3',
        prompt: 'Use the get_test_temperature tool for Paris.',
        tools: [{ type: 'function', function: { name: 'get_test_temperature', description: 'Recorded test temperature.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
        toolChoice: 'auto',
      })
      assert.equal(outcome.outcome.ok, true)
      assert.equal(outcome.outcome.mode, 'tool')
      assert.equal(outcome.outcome.toolCalls[0].id, 'call_wire_2')
      assert.equal(outcome.outcome.finishReason, 'tool_calls')
      assert.equal(lastWireBody.messages[1].role, 'user')
      assert.equal(lastWireBody.messages[1].content, 'Use the get_test_temperature tool for Paris.')
      pass('5.8: non-stream tool call contract with exact request shape')
    } finally { toolServer.server.close() }
  } finally {
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
  }

  console.log('RESULT: ' + passed + ' MuseProviderRuntime assertions passed.')
}

main().catch((error) => {
  console.error('FAIL: MuseProviderRuntime suite failed: ' + String(error && error.message))
  process.exit(1)
})
