'use strict'

// Apply-OpenCodeSessionPatch.cjs -- TASK-0008 (TASK-0006 acceptance).
//
// The pinned dsh-llm-pi-ai substrate forwards the DSH loop per-request
// sessionId to pi-ai, which maps it to session_id / x-client-request-id
// (format "openai") or x-client-request-id only ("openai-nosession").
// pi-ai knows no x-opencode-session header, so OpenCode Go requests through
// the DSH path fail with HTTP 400 MissingSessionID (live-proven 2026-09-23:
// no header -> 400 MissingSessionID; opaque header -> 200).
//
// This applier makes ONE surgical, idempotent edit to the INSTALLED
// substrate entry (app/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js).
// Semantics (nothing else changes): value is the DSH session id the agent
// loop already stamps on every request (session ownership unchanged;
// opaque, carrying no workspace path, username, key, or prompt content);
// stable per conversation (same session -> same header on every turn and
// every loop-level retry), isolated across conversations, and scoped to
// provider id opencode-go ONLY (meta-model-api resolves the extra to
// void 0: byte-for-byte old behavior). Engine semantics, provider
// selection, reasoning governor, fallback behavior, session ownership, and
// the Go endpoint/model id are untouched.
//
// The raw header value is NEVER logged by this patch. Acceptance
// observation uses an external test-only relay harness that prints only
// sha256(header).slice(0, 12) fingerprints (tmp/, removed after the run).
//
// Usage:
//   node scripts/Apply-OpenCodeSessionPatch.cjs <InstallRoot> [apply|remove|status]

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const MARKER = '/* nexus-opencode-session-v1 */'

const OLD_FN = 'function requestHeaders(headers) {'
const NEW_FN = 'function requestHeaders(headers, extra) {'
const OLD_MERGE = '\t\t...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),\n\t\t...attribution'
const NEW_MERGE = '\t\t...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),\n\t\t...Object.fromEntries(Object.entries(extra ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),\n\t\t...attribution'
const OLD_CALL = 'headers: requestHeaders(profile.headers)'
const NEW_CALL = 'headers: requestHeaders(profile.headers,\n\t\t\t\t\toptions.provider === \'opencode-go\' && options.sessionId !== void 0\n\t\t\t\t\t\t? { \'x-opencode-session\': String(options.sessionId) }\n\t\t\t\t\t\t: void 0) ' + MARKER

function entryFor(installRoot) {
  return path.join(path.resolve(installRoot), 'app', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js')
}

function statusOf(source) {
  const hasMarker = source.includes(MARKER)
  const hasNewFn = source.includes(NEW_FN)
  if (hasMarker && hasNewFn) return 'applied'
  if (!hasMarker && !hasNewFn) return 'absent'
  return 'partial'
}

function applyPatch(source) {
  const status = statusOf(source)
  if (status === 'applied') return { source, changed: false }
  if (status === 'partial') throw new Error('substrate carries a partial opencode-session edit; refusing to proceed')
  if (!source.includes(OLD_FN) || !source.includes(OLD_MERGE)) throw new Error('requestHeaders block did not match; upstream substrate may have changed')
  if (source.split(OLD_CALL).length - 1 !== 1) throw new Error('expected exactly one requestHeaders(profile.headers) call site')
  const next = source.replace(OLD_FN, NEW_FN).replace(OLD_MERGE, NEW_MERGE).replace(OLD_CALL, NEW_CALL)
  if (statusOf(next) !== 'applied') throw new Error('patch application failed self-check')
  return { source: next, changed: true }
}

function removePatch(source) {
  const status = statusOf(source)
  if (status === 'absent') return { source, changed: false }
  if (status === 'partial') throw new Error('substrate carries a partial opencode-session edit; refusing to proceed')
  const next = source.replace(NEW_FN, OLD_FN).replace(NEW_MERGE, OLD_MERGE).replace(NEW_CALL, OLD_CALL)
  if (statusOf(next) !== 'absent') throw new Error('patch removal failed self-check')
  if (next.includes(MARKER)) throw new Error('marker remains after removal')
  return { source: next, changed: true }
}

function writeChecked(entry, original, next) {
  try {
    fs.writeFileSync(entry, next, 'utf8')
    const check = spawnSync(process.execPath, ['--check', entry], { encoding: 'utf8' })
    if (check.status !== 0) throw new Error(check.stderr || check.stdout || 'node --check failed')
  } catch (error) {
    fs.writeFileSync(entry, original, 'utf8')
    throw error
  }
}

function main() {
  const installRoot = process.argv[2]
  const mode = process.argv[3] || 'apply'
  if (!installRoot) throw new Error('InstallRoot argument is required')
  if (['apply', 'remove', 'status'].indexOf(mode) === -1) throw new Error('mode must be apply|remove|status')
  const entry = entryFor(installRoot)
  if (!fs.existsSync(entry)) throw new Error('provider adapter entry is missing: ' + entry)
  const original = fs.readFileSync(entry, 'utf8')
  if (mode === 'status') {
    console.log('opencode-session patch status: ' + statusOf(original))
    return
  }
  const result = mode === 'apply' ? applyPatch(original) : removePatch(original)
  if (!result.changed) {
    console.log(mode === 'apply' ? 'opencode-session patch is already applied.' : 'opencode-session patch is not installed.')
    return
  }
  writeChecked(entry, original, result.source)
  console.log(mode === 'apply' ? 'opencode-session patch applied (x-opencode-session for opencode-go only).' : 'opencode-session patch removed.')
}

module.exports = { MARKER, applyPatch, removePatch, statusOf }

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n')
    process.exit(1)
  }
}
