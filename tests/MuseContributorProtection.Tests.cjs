'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const protection = require(
  path.resolve(__dirname, '..', 'config', 'Muse-ContributorProtection.cjs')
)

let passed = 0
function pass(name) {
  passed += 1
  console.log('PASS: ' + name)
}

function main() {
  assert.equal(protection.isSecretFieldName('apiKey'), true)
  assert.equal(protection.isSecretFieldName('client_secret'), true)
  assert.equal(protection.isSecretFieldName('accessToken'), true)
  assert.equal(protection.isSecretFieldName('password'), true)

  assert.equal(protection.isSecretFieldName('apiKeyEnv'), false)
  assert.equal(protection.isSecretFieldName('maxTokens'), false)
  assert.equal(protection.isSecretFieldName('reasoningTokens'), false)
  assert.equal(protection.isSecretFieldName('token_budget'), false)

  pass('1: secret field classification avoids token-accounting false positives')

  const source = {
    model: 'muse-spark-1.3-contributor',
    max_tokens: 32768,
    reasoning_tokens: 123,
    messages: [
      {
        role: 'user',
        content: [
          'DATABASE_PASSWORD=correct-horse-battery-staple',
          'API_KEY=' + ['sk', 'abcdefghijklmnopqrstuvwxyz012345'].join('-'),
          'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
          'url=https://user:super-secret@example.com/v1',
          'endpoint=https://example.com/?access_token=very-secret-value',
        ].join('\n'),
      },
    ],
    nested: {
      api_key: 'plain-structured-secret',
      clientSecret: 'another-secret',
      token_budget: 4096,
    },
  }

  const original = JSON.parse(JSON.stringify(source))
  const sanitized = protection.sanitizeContributorPayload(source)

  assert.deepEqual(source, original, 'sanitizer must never mutate source payload')
  assert.equal(sanitized.max_tokens, 32768)
  assert.equal(sanitized.reasoning_tokens, 123)
  assert.equal(sanitized.nested.token_budget, 4096)
  assert.equal(sanitized.nested.api_key, protection.REDACTION)
  assert.equal(sanitized.nested.clientSecret, protection.REDACTION)

  const serialized = JSON.stringify(sanitized)

  assert.equal(serialized.includes('correct-horse-battery-staple'), false)
  assert.equal(serialized.includes('abcdefghijklmnopqrstuvwxyz012345'), false)
  assert.equal(serialized.includes('plain-structured-secret'), false)
  assert.equal(serialized.includes('another-secret'), false)
  assert.equal(serialized.includes('super-secret'), false)
  assert.equal(serialized.includes('very-secret-value'), false)

  pass('2: structured and embedded credentials are removed without mutating the durable source')

  const privateKey =
    'before\n' +
    '-----BEGIN PRIVATE KEY-----\n' +
    'THIS_IS_PRIVATE_MATERIAL_123456789\n' +
    '-----END PRIVATE KEY-----\n' +
    'after'

  const privateKeyResult = protection.sanitizeContributorText(privateKey)

  assert.equal(privateKeyResult.includes('THIS_IS_PRIVATE_MATERIAL'), false)
  assert.ok(privateKeyResult.includes(protection.REDACTION))

  pass('3: PEM private-key material is removed')

  const knownTokens = [
    ['sk', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-'),
    'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
    'AKIAABCDEFGHIJKLMNOP',
    'AIzaabcdefghijklmnopqrstuvwxyz1234567890',
    'xoxb-1234567890-abcdefghijklmnop',
    'npm_abcdefghijklmnopqrstuvwxyz123456',
    'hf_abcdefghijklmnopqrstuvwxyz123456',
    'glpat-abcdefghijklmnopqrstuvwxyz123456',
    'eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop',
  ]

  for (const secret of knownTokens) {
    const result = protection.sanitizeContributorText('secret=' + secret)
    assert.equal(result.includes(secret), false, 'secret survived: ' + secret)
  }

  pass('4: common provider/token credential formats are redacted')

  const exactTarget = {
    provider: 'meta-model-api',
    id: 'muse-spark-1.3-contributor',
  }

  const guarded = protection.payloadGuard(
    {
      messages: [{ role: 'user', content: 'PASSWORD=do-not-send-this' }],
    },
    exactTarget
  )

  assert.ok(guarded)
  assert.equal(JSON.stringify(guarded).includes('do-not-send-this'), false)

  assert.equal(
    protection.payloadGuard(
      { messages: [] },
      { provider: 'zai-direct', id: 'glm-5.3-flash' }
    ),
    undefined
  )

  assert.equal(
    protection.payloadGuard(
      { messages: [] },
      { provider: 'meta-model-api', id: 'some-other-model' }
    ),
    undefined
  )

  pass('5: the guard is scoped only to the exact Muse Contributor target')

  const cyclic = {}
  cyclic.self = cyclic

  assert.throws(
    () => protection.sanitizeContributorPayload(cyclic),
    (error) => error.code === 'nexus-muse-contributor-cyclic-payload'
  )

  assert.throws(
    () =>
      protection.sanitizeContributorPayload({
        messages: [{ role: 'user', content: Buffer.from('secret') }],
      }),
    (error) => error.code === 'nexus-muse-contributor-opaque-payload'
  )

  assert.throws(
    () =>
      protection.sanitizeContributorPayload({
        messages: [
          {
            role: 'user',
            content: 'data:image/png;base64,AAAA',
          },
        ],
      }),
    (error) => error.code === 'nexus-muse-contributor-opaque-payload'
  )

  pass('6: cyclic, binary, and opaque base64 payloads fail closed')

  const omitted = Symbol('omitted')
  const jsonCompatibleSource = {
    keep: 'value',
    missing: undefined,
    callback() {},
    marker: omitted,
    nonFinite: Number.NaN,
    positiveInfinity: Number.POSITIVE_INFINITY,
    negativeInfinity: Number.NEGATIVE_INFINITY,
    array: [undefined, function nope() {}, omitted, Number.NaN, 'tail'],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: undefined,
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
        },
      },
    ],
  }

  const normalized = protection.sanitizeContributorPayload(jsonCompatibleSource)
  assert.equal(Object.hasOwn(normalized, 'missing'), false)
  assert.equal(Object.hasOwn(normalized, 'callback'), false)
  assert.equal(Object.hasOwn(normalized, 'marker'), false)
  assert.equal(normalized.nonFinite, null)
  assert.equal(normalized.positiveInfinity, null)
  assert.equal(normalized.negativeInfinity, null)
  assert.deepEqual(normalized.array, [null, null, null, null, 'tail'])
  assert.equal(Object.hasOwn(normalized.tools[0].function, 'description'), false)
  assert.deepEqual(jsonCompatibleSource.array.slice(0, 4), [undefined, jsonCompatibleSource.array[1], omitted, Number.NaN])
  assert.equal(normalized.tools[0].function.parameters.properties.path.type, 'string')

  pass('7: provider-native tool payloads use JSON-compatible omission/null normalization without source mutation')

  assert.throws(
    () => protection.sanitizeContributorPayload({ value: 1n }),
    (error) => error.code === 'nexus-muse-contributor-invalid-payload'
  )
  assert.throws(
    () => protection.sanitizeContributorPayload({ value: new Uint8Array([1, 2]) }),
    (error) => error.code === 'nexus-muse-contributor-opaque-payload'
  )
  assert.throws(
    () => protection.sanitizeContributorPayload({ value: new Date(0) }),
    (error) => error.code === 'nexus-muse-contributor-invalid-payload'
  )

  pass('8: unsupported BigInt, typed-array, and custom-prototype values fail closed')

  const first = protection.installPayloadGuard()
  const second = protection.installPayloadGuard()

  assert.equal(first.installed, true)
  assert.equal(second.installed, true)
  assert.equal(second.reused, true)
  assert.equal(
    globalThis[protection.GUARD_SYMBOL],
    protection.payloadGuard
  )


  pass('9: provider-egress guard installation is deterministic and idempotent')

  const installRoot = path.resolve(__dirname, '..')

  const isolationText = fs.readFileSync(
    path.join(installRoot, 'config', 'Muse-Isolation.cjs'),
    'utf8'
  )

  assert.ok(
    isolationText.includes(
      "require('./Muse-ContributorProtection.cjs')"
    )
  )

  assert.ok(
    isolationText.includes(
      'contributorProtection.installPayloadGuard()'
    )
  )

  assert.ok(
    isolationText.includes(
      "target.dataUseTier !== 'contributor'"
    )
  )

  assert.ok(
    isolationText.includes(
      'target.contributorProtectionRequired !== true'
    )
  )

  pass('10: Muse isolation installs the guard and requires Contributor metadata')

  const installerText = fs.readFileSync(
    path.join(installRoot, 'scripts', 'Complete-Install.ps1'),
    'utf8'
  )
  const museInstallerText = fs.readFileSync(
    path.join(installRoot, 'scripts', 'Install-MusePreset.ps1'),
    'utf8'
  )

  assert.ok(
    installerText.includes('Install-MusePreset.ps1')
  )

  assert.ok(
    installerText.includes('Patch-MuseContributorEgress.cjs')
  )

  assert.ok(
    museInstallerText.includes('Muse-ContributorProtection.cjs')
  )

  pass('11: the shared installer installs both the wire patch and Muse guard module')

  const patcherPath = path.join(
    installRoot,
    'scripts',
    'Patch-MuseContributorEgress.cjs'
  )

  const patcherText = fs.readFileSync(patcherPath, 'utf8')

  assert.ok(patcherText.includes('0.1.1-rc.2'))
  assert.ok(patcherText.includes('0.82.1'))
  assert.ok(
    patcherText.includes(
      'E183A9CDDE703B47485410BD68D247C8BECDB277C390F0F91C6DD28718D350E2'
    )
  )
  assert.ok(
    patcherText.includes(
      'nexus-muse-contributor-egress-v1'
    )
  )
  assert.ok(
    patcherText.includes(
      'nexus.museContributorPayloadGuard.v1'
    )
  )

  pass('12: the egress patch is pinned to the verified DSH/pi-ai build and pristine hash')

  const dshManifest = JSON.parse(
    fs.readFileSync(
      path.join(
        installRoot,
        'app',
        'node_modules',
        '@deepseek-ai',
        'dsh-llm-pi-ai',
        'package.json'
      ),
      'utf8'
    )
  )

  const dshEntry = path.join(
    installRoot,
    'app',
    'node_modules',
    '@deepseek-ai',
    'dsh-llm-pi-ai',
    dshManifest.main
  )

  const installedText = fs.readFileSync(dshEntry, 'utf8')

  assert.equal(
    installedText.split(
      '/* nexus-muse-contributor-egress-v1 */'
    ).length - 1,
    1
  )

  assert.ok(
    installedText.includes(
      'Symbol.for("nexus.museContributorPayloadGuard.v1")'
    )
  )

  assert.ok(
    installedText.includes(
      'nexus-muse-contributor-guard-unavailable'
    )
  )

  assert.ok(
    installedText.includes(
      'nexus-muse-contributor-target-mismatch'
    )
  )

  pass('13: the installed provider adapter contains exactly one fail-closed Muse egress boundary')

  function digest(filePath) {
    return crypto
      .createHash('sha256')
      .update(fs.readFileSync(filePath))
      .digest('hex')
  }

  const before = digest(dshEntry)

  const rerun = spawnSync(
    process.execPath,
    [patcherPath, installRoot],
    { encoding: 'utf8' }
  )

  assert.equal(
    rerun.status,
    0,
    rerun.stderr || rerun.stdout
  )

  const after = digest(dshEntry)

  assert.equal(after, before)

  pass('14: rerunning the M5 provider-egress patch is byte-idempotent')

  const driftRoot = fs.mkdtempSync(
    path.join(require('node:os').tmpdir(), 'muse-egress-drift-')
  )

  try {
    const driftDshRoot = path.join(
      driftRoot,
      'app',
      'node_modules',
      '@deepseek-ai',
      'dsh-llm-pi-ai'
    )
    const driftPiRoot = path.join(
      driftRoot,
      'app',
      'node_modules',
      '@earendil-works',
      'pi-ai'
    )
    const driftEntry = path.join(driftDshRoot, 'lib', 'index.js')

    fs.mkdirSync(path.dirname(driftEntry), { recursive: true })
    fs.mkdirSync(path.join(driftPiRoot, 'dist', 'api'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(driftDshRoot, 'package.json'),
      JSON.stringify({
        name: '@deepseek-ai/dsh-llm-pi-ai',
        version: '0.1.1-rc.2',
        main: 'lib/index.js',
      })
    )
    fs.writeFileSync(
      path.join(driftPiRoot, 'package.json'),
      JSON.stringify({
        name: '@earendil-works/pi-ai',
        version: '0.82.1',
      })
    )
    fs.writeFileSync(
      path.join(driftPiRoot, 'dist', 'types.d.ts'),
      'onPayload?: (payload: unknown) => unknown\n'
    )
    fs.writeFileSync(
      path.join(driftPiRoot, 'dist', 'api', 'openai-completions.js'),
      'const onPayload = true\n'
    )
    fs.writeFileSync(driftEntry, 'module.exports = "unexpected drift"\n')

    const driftBefore = fs.readFileSync(driftEntry)
    const driftRun = spawnSync(
      process.execPath,
      [patcherPath, driftRoot],
      { encoding: 'utf8' }
    )

    assert.notEqual(driftRun.status, 0)
    assert.match(
      driftRun.stderr + driftRun.stdout,
      /unexpected pristine adapter SHA256/
    )
    assert.deepEqual(fs.readFileSync(driftEntry), driftBefore)
  } finally {
    fs.rmSync(driftRoot, { recursive: true, force: true })
  }

  pass('15: an unsupported adapter hash fails closed without changing installed bytes')

  console.log(
    'SUITE RESULT: PASS ' +
      passed +
      ' | FAIL 0 | total ' +
      passed
  )
}

try {
  main()
} catch (error) {
  console.error(
    'SUITE RESULT: PASS ' +
      passed +
      ' | FAIL 1 | total ' +
      (passed + 1)
  )
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
}
