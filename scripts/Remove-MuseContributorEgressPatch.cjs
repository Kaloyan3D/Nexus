'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const MARKER = '/* nexus-muse-contributor-egress-v1 */'

function removeContributorEgressPatch(source) {
  const markerCount = source.split(MARKER).length - 1
  if (markerCount === 0) return { source, removed: false }
  if (markerCount !== 1) {
    throw new Error(`expected one retired Muse egress marker; found ${markerCount}`)
  }

  const patchedBlock = /^([ \t]+)signal: watchdog\.signal,\r?\n\1headers: requestHeaders\(profile\.headers\),\r?\n\1\/\* nexus-muse-contributor-egress-v1 \*\/\r?\n\1onPayload: \(payload, providerModel\) => \{\r?\n[\s\S]*?^\1\}$/gm
  const matches = [...source.matchAll(patchedBlock)]
  if (matches.length !== 1) {
    throw new Error(`retired Muse egress block did not match exactly once; found ${matches.length}`)
  }

  const block = matches[0][0]
  for (const required of [
    'Symbol.for("nexus.museContributorPayloadGuard.v1")',
    'nexus-muse-contributor-guard-unavailable',
    'nexus-muse-contributor-target-mismatch',
  ]) {
    if (!block.includes(required)) {
      throw new Error(`retired Muse egress block is missing expected content: ${required}`)
    }
  }

  const indent = matches[0][1]
  const eol = block.includes('\r\n') ? '\r\n' : '\n'
  const replacement = [
    `${indent}signal: watchdog.signal,`,
    `${indent}headers: requestHeaders(profile.headers)`,
  ].join(eol)
  const cleaned = source.replace(patchedBlock, replacement)
  if (cleaned.includes(MARKER) || cleaned.includes('nexus.museContributorPayloadGuard.v1')) {
    throw new Error('retired Muse egress hook remains after cleanup')
  }
  return { source: cleaned, removed: true }
}

function main() {
  const installRootArg = process.argv[2]
  if (!installRootArg) throw new Error('InstallRoot argument is required')

  const entry = path.join(
    path.resolve(installRootArg),
    'app',
    'node_modules',
    '@deepseek-ai',
    'dsh-llm-pi-ai',
    'lib',
    'index.js',
  )
  if (!fs.existsSync(entry)) throw new Error(`provider adapter entry is missing: ${entry}`)

  const original = fs.readFileSync(entry, 'utf8')
  const result = removeContributorEgressPatch(original)
  if (!result.removed) {
    console.log('Retired Muse contributor-egress hook is not installed.')
    return
  }

  try {
    fs.writeFileSync(entry, result.source, 'utf8')
    const check = spawnSync(process.execPath, ['--check', entry], { encoding: 'utf8' })
    if (check.status !== 0) throw new Error(check.stderr || check.stdout || 'node --check failed')
  } catch (error) {
    fs.writeFileSync(entry, original, 'utf8')
    throw error
  }
  console.log('Retired Muse contributor-egress hook removed.')
}

module.exports = { MARKER, removeContributorEgressPatch }

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n')
    process.exit(1)
  }
}
