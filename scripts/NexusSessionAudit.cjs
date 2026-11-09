'use strict'

/**
 * NexusSessionAudit.cjs — READ-ONLY DSH 0.2 session durability audit (P2-B2C).
 *
 *   node scripts/NexusSessionAudit.cjs --data <DSH_HOME> --app <app dir> [--json]
 *
 * For every stored session log under <DSH_HOME>/sessions it:
 *   1. copies the session directory to a private temporary root (the live file
 *      is never opened for writing, never renamed, never truncated);
 *   2. asks the pinned DSH JSONL persistence backend to open and read the COPY
 *      (the real cold-restore reader, format v4 admission included);
 *   3. classifies the raw events to explain a refusal.
 *
 * Classes:
 *   valid                         DSH reads it; no latent defect.
 *   latent-notice-before-head     DSH reads it today, but a surface user/message
 *                                 precedes any system/message: DSH will refuse
 *                                 the log as soon as a system/message is appended.
 *   invalid-retired-source-kind   DSH refuses: a message carries source.kind "plugin".
 *   invalid-notice-before-head    DSH refuses: a surface message precedes the
 *                                 first system/message (pre-P2-B2C first-turn notice).
 *   partial-tail                  the final physical line is torn (crash mid-write);
 *                                 DSH's reader decides whether the prefix is usable.
 *   unreadable-other              DSH refuses for another reason (reported verbatim).
 *
 * Policy (no rewrite): DSH offers no documented lossless rewrite for a refused
 * log, so refused sessions are HELD — reported here with their diagnostic and
 * left untouched. Exit code 0 = every session valid, 3 = at least one held or
 * latent session, 2 = usage error.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const messageSource = require('../config/Nexus-MessageSource.cjs')

const SURFACE = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])

function parseArgs(argv) {
  const out = { json: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') out.json = true
    else if (argv[i] === '--data') out.data = argv[++i]
    else if (argv[i] === '--app') out.app = argv[++i]
    else throw new Error('unknown argument ' + argv[i])
  }
  if (!out.data || !out.app) throw new Error('--data and --app are required')
  return out
}

function findLogs(root) {
  const found = []
  const walk = (dir) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (/^session\.v4\.jsonl(\.zstd)?$/.test(entry.name)) found.push(file)
    }
  }
  walk(root)
  return found
}

/** Raw rows of one log (zstd frames or plain JSONL); torn tail detected. */
function rawRows(file) {
  const bytes = fs.readFileSync(file)
  let text
  if (file.endsWith('.zstd')) {
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const starts = []
    for (let at = bytes.indexOf(magic); at >= 0; at = bytes.indexOf(magic, at + 4)) starts.push(at)
    let torn = false
    text = starts.map((start, i) => { try { return zlib.zstdDecompressSync(bytes.subarray(start, starts[i + 1] ?? bytes.length)).toString('utf8') } catch { torn = true; return '' } }).join('')
    if (torn) text += '\u0000TORN'
  } else text = bytes.toString('utf8')
  const lines = text.split('\n')
  const rows = []
  let tornTail = text.endsWith('\u0000TORN')
  lines.forEach((line, index) => {
    if (!line.trim() || line === '\u0000TORN') return
    try { rows.push(JSON.parse(line)) } catch { if (index === lines.length - 1) tornTail = true; else rows.push({ unparsable: true }) }
  })
  return { header: rows.find((row) => row && row.type === 'session') || null, events: rows.filter((row) => row && row.type !== 'session'), tornTail }
}

function messagesOf(event) {
  const data = event && event.data
  if (!data || typeof data !== 'object') return []
  if (event.type === 'user/message') return [data]
  if (event.type === 'agent/inbox/spliced') return Array.isArray(data.inserted) ? data.inserted : []
  if (['system/message', 'assistant/message', 'tool/result'].includes(event.type)) return data.message ? [data.message] : []
  return []
}

function classify(raw) {
  const retired = raw.events.filter((event) => messagesOf(event).some((message) => message && message.source && message.source.kind === messageSource.RETIRED_SOURCE_KIND))
  const surface = raw.events.filter((event) => SURFACE.has(event.type) && event.surfaceOp !== undefined)
  const firstSurface = surface[0]
  const hasSystem = surface.some((event) => event.type === 'system/message')
  const beforeHead = firstSurface && firstSurface.type !== 'system/message'
  return {
    retiredSourceSeqs: retired.map((event) => event.seq),
    noticeBeforeHead: Boolean(beforeHead && hasSystem),
    latentNoticeBeforeHead: Boolean(beforeHead && !hasSystem),
    firstSurface: firstSurface ? { seq: firstSurface.seq, type: firstSurface.type, source: messagesOf(firstSurface)[0] && messagesOf(firstSurface)[0].source ? messagesOf(firstSurface)[0].source.kind : null } : null,
    tornTail: raw.tornTail,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const appRequire = createRequire(path.join(path.resolve(args.app), 'package.json'))
  const load = (name) => import(pathToFileURL(appRequire.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const Jsonl = await load('@deepseek-ai/dsh-session-persistence-jsonl')
  const sessionsRoot = path.join(path.resolve(args.data), 'sessions')
  const results = []
  for (const file of findLogs(sessionsRoot)) {
    const sessionDir = path.dirname(file)
    const sessionId = path.basename(sessionDir)
    const relative = path.relative(sessionsRoot, sessionDir)
    const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-session-audit-'))
    let verdict
    try {
      fs.cpSync(sessionDir, path.join(copyRoot, relative), { recursive: true })
      const raw = rawRows(file)
      const facts = classify(raw)
      let readable = true
      let readError = null
      const ctx = new Context()
      try {
        await ctx.plugin(Jsonl, { root: copyRoot, compression: file.endsWith('.zstd') ? 'zstd' : 'none' })
        const handle = await ctx.get('sessionPersistence').open(sessionId, 'read')
        try { await handle.read(0) } finally { await handle.close() }
      } catch (error) { readable = false; readError = String(error && error.message ? error.message : error).slice(0, 400) } finally { try { await ctx.fiber.dispose() } catch { /* best effort */ } }
      const klass = readable
        ? (facts.latentNoticeBeforeHead ? 'latent-notice-before-head' : facts.tornTail ? 'partial-tail' : 'valid')
        : /producer-owned source kind/.test(readError) ? 'invalid-retired-source-kind'
          : /protected first surface head/.test(readError) ? 'invalid-notice-before-head'
            : facts.tornTail ? 'partial-tail' : 'unreadable-other'
      verdict = { sessionId, file: path.relative(path.resolve(args.data), file), class: klass, held: !readable, dshReadable: readable, dshError: readError, ...facts }
    } catch (error) {
      verdict = { sessionId, file: path.relative(path.resolve(args.data), file), class: 'unreadable-other', held: true, dshReadable: false, dshError: String(error && error.message ? error.message : error).slice(0, 400) }
    } finally { fs.rmSync(copyRoot, { recursive: true, force: true }) }
    results.push(verdict)
  }
  const summary = results.reduce((acc, r) => { acc[r.class] = (acc[r.class] || 0) + 1; return acc }, {})
  if (args.json) process.stdout.write(JSON.stringify({ schemaVersion: 1, sessions: results, summary }, null, 2) + '\n')
  else {
    for (const r of results) process.stdout.write(`${r.class}\t${r.sessionId}${r.dshError ? '\t' + r.dshError : ''}\n`)
    process.stdout.write('summary ' + JSON.stringify(summary) + '\n')
  }
  process.exitCode = results.every((r) => r.class === 'valid') ? 0 : 3
}

if (require.main === module) main().catch((error) => { process.stderr.write('nexus-session-audit: ' + (error && error.message ? error.message : error) + '\n'); process.exitCode = 2 })

module.exports = { rawRows, classify, messagesOf }
