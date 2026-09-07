'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const DSH_NAME = '@deepseek-ai/dsh-llm-pi-ai'
const DSH_VERSION = '0.1.1-rc.2'
const DSH_MAIN = 'lib/index.js'
const DSH_PRISTINE_SHA256 =
  'E183A9CDDE703B47485410BD68D247C8BECDB277C390F0F91C6DD28718D350E2'

const PI_NAME = '@earendil-works/pi-ai'
const PI_VERSION = '0.82.1'

const MARKER = '/* nexus-muse-contributor-egress-v1 */'
const GUARD_SYMBOL = 'nexus.museContributorPayloadGuard.v1'
const MUSE_PROVIDER = 'meta-model-api'
const MUSE_MODEL = 'muse-spark-1.3-contributor'

function fail(message) {
  const error = new Error(
    'Nexus M5 contributor-egress patch refused: ' + message
  )
  error.code = 'nexus-muse-contributor-egress-patch-refused'
  throw error
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex')
    .toUpperCase()
}

const installRootArg = process.argv[2]

if (!installRootArg) {
  fail('InstallRoot argument is required')
}

const installRoot = path.resolve(installRootArg)

const dshRoot = path.join(
  installRoot,
  'app',
  'node_modules',
  '@deepseek-ai',
  'dsh-llm-pi-ai'
)

const dshManifestPath = path.join(dshRoot, 'package.json')

if (!fs.existsSync(dshManifestPath)) {
  fail('dsh-llm-pi-ai package is missing')
}

const dshManifest = readJson(dshManifestPath)

if (
  dshManifest.name !== DSH_NAME ||
  dshManifest.version !== DSH_VERSION ||
  dshManifest.main !== DSH_MAIN
) {
  fail(
    `unsupported DSH adapter identity: ` +
      `${dshManifest.name}@${dshManifest.version} main=${dshManifest.main}`
  )
}

// Verify the exact pi-ai capability this patch depends on.
const piRoot = path.join(
  installRoot,
  'app',
  'node_modules',
  '@earendil-works',
  'pi-ai'
)

const piManifestPath = path.join(piRoot, 'package.json')

if (!fs.existsSync(piManifestPath)) {
  fail('pi-ai package is missing')
}

const piManifest = readJson(piManifestPath)

if (
  piManifest.name !== PI_NAME ||
  piManifest.version !== PI_VERSION
) {
  fail(
    `unsupported pi-ai identity: ` +
      `${piManifest.name}@${piManifest.version}`
  )
}

const piTypesPath = path.join(piRoot, 'dist', 'types.d.ts')
const piOpenAiPath = path.join(
  piRoot,
  'dist',
  'api',
  'openai-completions.js'
)

if (
  !fs.existsSync(piTypesPath) ||
  !fs.existsSync(piOpenAiPath)
) {
  fail('pi-ai onPayload capability files are missing')
}

const piTypes = fs.readFileSync(piTypesPath, 'utf8')
const piOpenAi = fs.readFileSync(piOpenAiPath, 'utf8')

if (!/\bonPayload\?\s*:/.test(piTypes)) {
  fail('pi-ai types do not expose onPayload')
}

if (!/\bonPayload\b/.test(piOpenAi)) {
  fail('pi-ai openai-completions does not consume onPayload')
}

const entry = path.join(dshRoot, DSH_MAIN)

if (!fs.existsSync(entry)) {
  fail('DSH adapter entry is missing: ' + entry)
}

const originalBytes = fs.readFileSync(entry)
let text = originalBytes.toString('utf8')

function verifyPatchedSource(candidate) {
  const markerCount = candidate.split(MARKER).length - 1

  if (markerCount !== 1) {
    fail(`expected exactly one M5 marker; found ${markerCount}`)
  }

  const required = [
    'onPayload: (payload, providerModel) => {',
    `"${MUSE_PROVIDER}"`,
    `"${MUSE_MODEL}"`,
    `Symbol.for("${GUARD_SYMBOL}")`,
    'guard.nexusMuseContributorGuardVersion !== 1',
    'nexus-muse-contributor-guard-unavailable',
    'nexus-muse-contributor-target-mismatch',
  ]

  for (const needle of required) {
    if (!candidate.includes(needle)) {
      fail('patched adapter is missing required contract: ' + needle)
    }
  }
}

// Idempotent path.
if (text.includes(MARKER)) {
  verifyPatchedSource(text)
  console.log(
    'M5 contributor-egress patch already installed and verified.'
  )
  process.exit(0)
}

const currentHash = sha256(originalBytes)

if (currentHash !== DSH_PRISTINE_SHA256) {
  fail(
    `unexpected pristine adapter SHA256: ${currentHash}; ` +
      `expected ${DSH_PRISTINE_SHA256}`
  )
}

/*
 * Exact seam immediately before pi-ai creates the provider request.
 * We require ONE structural match even after the byte hash has matched.
 */
const seam =
  /^([ \t]+)signal: watchdog\.signal,\r?\n\1headers: requestHeaders\(profile\.headers\)$/gm

const matches = [...text.matchAll(seam)]

if (matches.length !== 1) {
  fail(
    `expected exactly one streamSimple options seam; found ${matches.length}`
  )
}

const indent = matches[0][1]
const eol = text.includes('\r\n') ? '\r\n' : '\n'

const replacement = [
  `${indent}signal: watchdog.signal,`,
  `${indent}headers: requestHeaders(profile.headers),`,
  `${indent}${MARKER}`,
  `${indent}onPayload: (payload, providerModel) => {`,
  `${indent}\tif (options.provider !== "${MUSE_PROVIDER}" || options.model !== "${MUSE_MODEL}") return void 0;`,
  `${indent}\tif (!providerModel || providerModel.provider !== options.provider || providerModel.id !== options.model) {`,
  `${indent}\t\tconst error = new Error("Nexus Muse contributor protection detected a provider/model identity mismatch at network egress");`,
  `${indent}\t\terror.code = "nexus-muse-contributor-target-mismatch";`,
  `${indent}\t\tthrow error;`,
  `${indent}\t}`,
  `${indent}\tconst guard = globalThis[Symbol.for("${GUARD_SYMBOL}")];`,
  `${indent}\tif (typeof guard !== "function" || guard.nexusMuseContributorGuardVersion !== 1) {`,
  `${indent}\t\tconst error = new Error("Nexus Muse contributor protection guard v1 is unavailable at network egress");`,
  `${indent}\t\terror.code = "nexus-muse-contributor-guard-unavailable";`,
  `${indent}\t\tthrow error;`,
  `${indent}\t}`,
  `${indent}\tconst sanitized = guard(payload, providerModel);`,
  `${indent}\tif (sanitized === void 0) {`,
  `${indent}\t\tconst error = new Error("Nexus Muse contributor protection refused the provider/model identity at network egress");`,
  `${indent}\t\terror.code = "nexus-muse-contributor-target-mismatch";`,
  `${indent}\t\tthrow error;`,
  `${indent}\t}`,
  `${indent}\treturn sanitized;`,
  `${indent}}`,
].join(eol)

text = text.replace(seam, replacement)

verifyPatchedSource(text)

try {
  fs.writeFileSync(entry, text, 'utf8')

  const check = spawnSync(
    process.execPath,
    ['--check', entry],
    { encoding: 'utf8' }
  )

  if (check.status !== 0) {
    throw new Error(
      check.stderr || check.stdout || 'node --check failed'
    )
  }
} catch (error) {
  // Never leave a half-valid provider adapter installed.
  fs.writeFileSync(entry, originalBytes)

  fail(
    'patched adapter failed validation and was restored: ' +
      (error && error.message ? error.message : String(error))
  )
}

console.log('M5 contributor-egress patch installed successfully.')