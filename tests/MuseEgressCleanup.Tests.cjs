'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const cleanup = require(path.resolve(__dirname, '..', 'scripts', 'Remove-MuseContributorEgressPatch.cjs'))

const eol = '\n'
const indent = '\t\t\t\t\t'
const source = [
  'async function streamSimple(options) {',
  `${indent}signal: watchdog.signal,`,
  `${indent}headers: requestHeaders(profile.headers),`,
  `${indent}${cleanup.MARKER}`,
  `${indent}onPayload: (payload, providerModel) => {`,
  `${indent}\tif (options.provider !== "meta-model-api" || options.model !== "muse-spark-1.3-contributor") return void 0;`,
  `${indent}\tconst guard = globalThis[Symbol.for("nexus.museContributorPayloadGuard.v1")];`,
  `${indent}\tif (typeof guard !== "function") {`,
  `${indent}\t\tconst error = new Error("unavailable");`,
  `${indent}\t\terror.code = "nexus-muse-contributor-guard-unavailable";`,
  `${indent}\t\tthrow error;`,
  `${indent}\t}`,
  `${indent}\tconst mismatch = "nexus-muse-contributor-target-mismatch";`,
  `${indent}\treturn guard(payload, providerModel);`,
  `${indent}}`,
  '}',
].join(eol)

const result = cleanup.removeContributorEgressPatch(source)
assert.equal(result.removed, true)
assert.equal(result.source.includes(cleanup.MARKER), false)
assert.equal(result.source.includes('onPayload'), false)
assert.ok(result.source.includes(`${indent}headers: requestHeaders(profile.headers)${eol}`))
assert.deepEqual(cleanup.removeContributorEgressPatch(result.source), { source: result.source, removed: false })

assert.throws(
  () => cleanup.removeContributorEgressPatch(source.replace('nexus-muse-contributor-guard-unavailable', 'unexpected-code')),
  /missing expected content/,
)

console.log('SUITE RESULT: PASS 2 | FAIL 0 | total 2')
