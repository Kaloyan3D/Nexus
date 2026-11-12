// NexusManagedHost.mjs — one REAL DSH `web` host (port 0) for the P2-B2B
// managed-task real-host tests. The parent supplies DSH_HOME, AIH_INSTALL_ROOT,
// AIH_HOST_APP, blocked egress and a placeholder key.
//
// Test-only instrumentation (never product code):
//   - a synthetic `llm/stream` transport: every model request is answered
//     locally with a short text reply and counted per session; no network;
//   - optional hold: `hold\n` makes conversation replies wait until `release\n`;
//   - NEXUS_TEST_CRASH_AT=delivering|accepted|turn-delivering|turn-accepted SIGKILLs this process at an intake
//     crash boundary by observing the atomic rename of the intake record:
//       delivering -> right AFTER the durable delivery intent (before DSH write)
//       accepted   -> right BEFORE the acceptance record replaces the intent
//                     (DSH message already flushed, client never acked).
// stdin commands: `report\n` prints one JSON line; `approve <sessionId>\n`
// raises a real DSH approval request for that agent; `exit\n` shuts down.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const crashAt = process.env.NEXUS_TEST_CRASH_AT || ''
if (crashAt) {
  const rename = fs.renameSync
  fs.renameSync = function patchedRename(from, to) {
    if (String(to).includes(path.join('nexus', 'intake')) && String(to).endsWith('.json')) {
      let state = null
      let turnState = null
      try { const record = JSON.parse(fs.readFileSync(from, 'utf8')); state = record.state; const turns = record.continuations || []; turnState = turns.length ? turns[turns.length - 1].state : null } catch { /* not a record */ }
      if (crashAt === 'accepted' && state === 'accepted' && turnState === null) process.kill(process.pid, 'SIGKILL')
      // P2-B2E continuation boundaries: before the turn's acceptance commit
      // (message already in DSH) / right after its delivery intent is durable.
      if (crashAt === 'turn-accepted' && turnState === 'accepted') process.kill(process.pid, 'SIGKILL')
      const result = rename.call(fs, from, to)
      if (crashAt === 'delivering' && state === 'delivering') process.kill(process.pid, 'SIGKILL')
      if (crashAt === 'turn-delivering' && turnState === 'delivering') process.kill(process.pid, 'SIGKILL')
      return result
    }
    return rename.call(fs, from, to)
  }
}

const appDir = process.env.AIH_HOST_APP
const appRequire = createRequire(path.join(appDir, 'package.json'))
const load = (name) => import(pathToFileURL(appRequire.resolve(name)).href)
const { runProfile } = await import(pathToFileURL(appRequire.resolve('@deepseek-ai/dsh/profile-boot')).href)
const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment')
const booted = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]), profile: 'web', patchFiles: [], args: ['--no-open', '--port', '0'] })
const ctx = booted.ctx

const llm = { conversation: {}, auxiliary: 0, held: false, waiters: [] }
const toolCalled = new Set()
ctx.on('llm/stream', function synthetic(options) {
  const sessionId = String(options.sessionId || 'none')
  if (options.purpose) llm.auxiliary += 1
  else llm.conversation[sessionId] = (llm.conversation[sessionId] || 0) + 1
  const conversational = !options.purpose
  return (async function* reply() {
    if (conversational && llm.held) await new Promise((resolve) => { llm.waiters.push(resolve); options.signal && options.signal.addEventListener('abort', resolve, { once: true }) })
    if (options.signal && options.signal.aborted) { yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }; return }
    // Opt-in (NEXUS_TEST_TOOL_CALL=1): the first conversational request of a
    // session asks for one read-only tool, so histories carry a real
    // tool-call/tool-result pair; the follow-up request answers with text.
    if (conversational && process.env.NEXUS_TEST_TOOL_CALL === '1' && !toolCalled.has(sessionId)) {
      toolCalled.add(sessionId)
      const id = 'call_' + crypto.randomBytes(6).toString('hex')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'working_directory', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'working_directory', arguments: '{}' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    // Opt-in (NEXUS_TEST_ECHO_TURNS=1): the reply names every `[turn-N]` marker
    // found in the request's user messages, proving which conversation history
    // the model actually received for this turn.
    let text = options.purpose ? 'Synthetic title' : 'Synthetic reply.'
    if (conversational && process.env.NEXUS_TEST_ECHO_TURNS === '1') {
      const textOf = (m) => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ') : '')
      const markers = (Array.isArray(options.messages) ? options.messages : []).filter((m) => m && m.role === 'user').flatMap((m) => textOf(m).match(/\[turn-\d+\]/g) || [])
      text = 'Synthetic reply. Seen: ' + (markers.length ? markers.join(',') : 'none')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}, { prepend: true })

const core = ctx.get('nexusController')
for (let i = 0; i < 600 && core && (core.ownership.state === 'not-acquired' || (core.ownership.state === 'held' && core.managedTasks && !core.managedTasks.reconciled)); i += 1) await new Promise((r) => setTimeout(r, 10))
for (let i = 0; i < 300 && core && core.managedGates && core.managedGates.routeGuards === 0; i += 1) await new Promise((r) => setTimeout(r, 10))
const approvals = []

// Raw durable bytes of one session log (test-side reader, independent of DSH's
// format-v4 admission so a log DSH refuses to cold-read can still be audited).
function rawDurableEvents(sessionId) {
  const zlib = createRequire(import.meta.url)('node:zlib')
  const found = []
  const walk = (dir) => { for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.startsWith('session.v4.jsonl') && path.basename(path.dirname(file)) === sessionId) found.push(file) } }
  walk(path.join(process.env.DSH_HOME, 'sessions'))
  if (found.length !== 1) throw new Error('raw log not found for ' + sessionId)
  let bytes = fs.readFileSync(found[0])
  let text
  if (found[0].endsWith('.zstd')) {
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const starts = []
    for (let at = bytes.indexOf(magic); at >= 0; at = bytes.indexOf(magic, at + 4)) starts.push(at)
    text = starts.map((start, i) => { try { return zlib.zstdDecompressSync(bytes.subarray(start, starts[i + 1] ?? bytes.length)).toString('utf8') } catch { return '' } }).join('')
  } else text = bytes.toString('utf8')
  return text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter((event) => event && event.type !== 'session')
}

async function report() {
  const persistence = ctx.get('sessionPersistence')
  const durable = {}
  if (core && core.intake) {
    for (const record of core.intake.list()) {
      try {
        try { await ctx.get('sessions').flush(ctx.get('sessions').get(record.sessionId)) } catch { /* not live */ }
        let readable = true
        let readError = null
        try { const handle = await persistence.open(record.sessionId, 'read'); try { await handle.read(0) } finally { await handle.close() } } catch (error) { readable = false; readError = String(error && error.message ? error.message : error).slice(0, 200) }
        {
          const events = rawDurableEvents(record.sessionId)
          const rpc = (m) => m && m.source && m.source.rpcId
          durable[record.taskId] = {
            inserted: events.filter((e) => e.type === 'agent/inbox/spliced').reduce((n, e) => n + (e.data.inserted || []).filter((m) => rpc(m) === record.requestId).length, 0),
            claimed: events.filter((e) => e.type === 'user/message' && rpc(e.data) === record.requestId).length,
            userMessages: events.filter((e) => e.type === 'user/message' && e.data && e.data.source && e.data.source.kind === 'user').length,
            turnEnds: events.filter((e) => e.type === 'turn/end').map((e) => e.data && e.data.reason && e.data.reason.kind),
            events: events.length,
            dshReadable: readable,
            dshReadError: readError,
          }
        }
      } catch (error) { durable[record.taskId] = { error: String(error && error.message ? error.message : error) } }
    }
  }
  return {
    pid: process.pid,
    port: ctx.get('webServer').port,
    authUrl: ctx.get('connection').authenticatedUrl(`http://127.0.0.1:${ctx.get('webServer').port}/`),
    ownership: core ? core.ownership.state : 'no-controller',
    activation: core ? core.activation() : null,
    gates: core ? core.managedGates : null,
    intake: core && core.intake ? core.intake.list().map((r) => ({ idempotencyKey: r.idempotencyKey, taskId: r.taskId, sessionId: r.sessionId, state: r.state, hold: r.hold ? r.hold.reason : null, holdDetail: r.hold || null, failure: r.failure || null, acceptedAt: r.acceptedAt || null, executionStartedAt: r.executionStartedAt || null, cancelledAt: r.cancelledAt || null, requestId: r.requestId })) : [],
    managedLive: core && core.managedTasks ? core.managedTasks.activeSessionIds() : [],
    llm: { conversation: llm.conversation, auxiliary: llm.auxiliary },
    metrics: core ? { managedTasks: core.metrics().managedTasks, broker: core.metrics().broker } : null,
    policy: null,
    durable,
    approvals,
  }
}

// P2-B2C: durable view of ANY session (ordinary or managed).
async function inspectSession(sessionId) {
  try { const live = ctx.get('sessions').get(sessionId); if (live) await ctx.get('sessions').flush(live) } catch { /* not live */ }
  let readable = true
  let readError = null
  let dshEvents = null
  try {
    const handle = await ctx.get('sessionPersistence').open(sessionId, 'read')
    try { const result = await handle.read(0); dshEvents = (Array.isArray(result) ? result : result.events).length } finally { await handle.close() }
  } catch (error) { readable = false; readError = String(error && error.message ? error.message : error).slice(0, 300) }
  let events = []
  try { events = rawDurableEvents(sessionId) } catch (error) { return { sessionId, readable, readError, raw: String(error.message) } }
  const surface = events.filter((e) => ['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'].includes(e.type) && e.surfaceOp !== undefined)
  const messages = (e) => e.type === 'user/message' ? [e.data] : e.type === 'agent/inbox/spliced' ? (e.data.inserted || []) : (e.data && e.data.message ? [e.data.message] : [])
  return {
    sessionId,
    readable,
    readError,
    dshEvents,
    rawEvents: events.length,
    firstSurface: surface[0] ? { seq: surface[0].seq, type: surface[0].type } : null,
    surfaceOrder: surface.slice(0, 6).map((e) => e.seq + ':' + e.type + (e.type === 'user/message' ? ':' + (e.data.source && e.data.source.kind) : '')),
    retiredSourceSeqs: events.filter((e) => messages(e).some((m) => m && m.source && m.source.kind === 'plugin')).map((e) => e.seq),
    userPrompts: events.filter((e) => e.type === 'user/message' && e.data.source && e.data.source.kind === 'user').map((e) => e.data.content && e.data.content[0] && e.data.content[0].text),
    controllerNotices: events.filter((e) => e.type === 'user/message' && e.data.source && e.data.source.kind === 'aih-controller').map((e) => e.seq + ':' + e.data.source.form),
    turnEnds: events.filter((e) => e.type === 'turn/end').map((e) => e.data && e.data.reason && e.data.reason.kind),
    toolCalls: events.filter((e) => e.type === 'assistant/message').flatMap((e) => ((e.data.message && e.data.message.content) || []).filter((b) => b.type === 'tool-call').map((b) => b.id)),
    toolResults: events.filter((e) => e.type === 'tool/result').map((e) => e.data && e.data.message && e.data.message.toolCallId),
    modelSelections: events.filter((e) => e.type === 'model/selection').map((e) => e.data && (e.data.provider + '/' + e.data.model)),
    llmCalls: llm.conversation[sessionId] || 0,
  }
}

process.stdout.write(JSON.stringify({ type: 'ready', ...(await report()) }) + '\n')
let buffer = ''
process.stdin.on('data', async (chunk) => {
  buffer += String(chunk)
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === 'report') process.stdout.write(JSON.stringify({ type: 'report', ...(await report()) }) + '\n')
    else if (line.startsWith('inspect ')) process.stdout.write(JSON.stringify({ type: 'inspect', ...(await inspectSession(line.slice(8))) }) + '\n')
    else if (line.startsWith('inject ')) {
      // Test-only: reproduce what pre-P2-B2C Nexus writers left in DSH 0.2 logs.
      //   latent  -> a surface Controller notice before any system message
      //   retired -> a surface notice carrying the retired `plugin` source kind
      const [, kind, sessionId] = line.split(' ')
      let ok = false
      let error = null
      try {
        const live = ctx.get('sessions').get(sessionId)
        const source = kind === 'retired' ? { kind: 'plugin', plugin: 'aih-controller', form: 'notice' } : { kind: 'aih-controller', plugin: 'aih-controller', form: 'controller-binding' }
        live.append('user/message', { id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: 'Controller: legacy notice (' + kind + ')' }], source }, { surfaceOp: 'append' })
        await ctx.get('sessions').flush(live)
        ok = true
      } catch (err) { error = String(err && err.message ? err.message : err) }
      process.stdout.write(JSON.stringify({ type: 'injected', kind, sessionId, ok, error }) + '\n')
    }
    else if (line === 'hold') { llm.held = true; process.stdout.write(JSON.stringify({ type: 'ack', line }) + '\n') }
    else if (line === 'release') { llm.held = false; for (const resolve of llm.waiters.splice(0)) resolve(); process.stdout.write(JSON.stringify({ type: 'ack', line }) + '\n') }
    else if (line.startsWith('approve ')) {
      const sessionId = line.slice(8)
      const agent = ctx.get('agents').get(sessionId)
      const id = crypto.randomUUID()
      process.stdout.write(JSON.stringify({ type: 'ack', line, agent: Boolean(agent) }) + '\n')
      if (agent) {
        ctx.get('approval').request({ agent, toolName: 'bash', reason: 'synthetic approval ' + id }).then((outcome) => {
          approvals.push({ id, sessionId, outcome })
          process.stdout.write(JSON.stringify({ type: 'approval', id, sessionId, outcome }) + '\n')
        }, (error) => { approvals.push({ id, sessionId, error: String(error && error.message) }) })
      }
    } else if (line === 'exit') {
      try { await booted.shutdown.shutdown(0) } catch { /* bounded */ }
      process.exit(0)
    }
  }
})
