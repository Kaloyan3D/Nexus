// DSH 0.2.x durable-writer ownership probe (CCv2 feasibility evidence).
//
// Exercises the REAL installed @deepseek-ai/dsh-session-persistence-jsonl write
// handle (kernel flock lease) against the questions in the DSH 0.2.x migration
// report: can an external, expiring Nexus lease fence a stale/suspended DSH
// writer? This is a feasibility probe, NOT a CCv2 safety test: it never enables
// durable CCv2 writers and asserts nothing about Nexus controller state.
//
// Usage: node tests/diagnostics/Dsh02OwnershipProbe.mjs <runtimeRoot> [evidence.json]
//   <runtimeRoot> contains app/node_modules (an installed DSH 0.2.x tree).
// POSIX only (SIGSTOP/SIGCONT/flock). Exit code 0 = probe ran to completion;
// the JSON verdicts are observations, not pass/fail assertions.

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const HOLDER_FLAG = '--holder'
const isHolder = argv[0] === HOLDER_FLAG
const runtimeRoot = resolve(isHolder ? argv[1] : argv[0] ?? '')
if (!runtimeRoot || runtimeRoot === process.cwd() && !argv[0]) {
  console.error('usage: Dsh02OwnershipProbe.mjs <runtimeRoot> [evidence.json]')
  process.exit(2)
}
const appRequire = createRequire(join(runtimeRoot, 'app', 'package.json'))
const load = async (name) => import(pathToFileURL(appRequire.resolve(name)).href)

const { Context } = await load('@deepseek-ai/cordis')
const session = await load('@deepseek-ai/dsh-session')
const Jsonl = await load('@deepseek-ai/dsh-session-persistence-jsonl')

const header = (id) => ({ version: session.SESSION_FORMAT_VERSION, id, createdAt: 1000, cwd: '/work', isSeeded: false })
const ev = (seq, turn) => ({ type: seq % 2 === 0 ? 'turn/start' : 'turn/end', seq, time: seq + 1,
  data: seq % 2 === 0 ? { turn } : { turn, reason: { kind: 'completed' } } })
async function mount(root) {
  const ctx = new Context()
  await ctx.plugin(Jsonl, { root, compression: 'none' })
  return { ctx, store: ctx.sessionPersistence }
}

if (isHolder) {
  // Child: hold the write handle forever; parent SIGSTOPs/SIGCONTs/SIGKILLs it.
  const [, , root, id] = argv
  const { store } = await mount(root)
  const handle = await store.create(header(id))
  await handle.append([ev(0, 1), ev(1, 1)])
  await handle.flush()
  process.stdout.write('holding\n')
  process.stdin.on('data', async (chunk) => {
    // Parent sends "append <seq>" after SIGCONT to test a resumed stale writer.
    const [cmd, seq] = String(chunk).trim().split(' ')
    if (cmd !== 'append') return
    try {
      await handle.append([ev(Number(seq), 2)])
      await handle.flush()
      process.stdout.write(`append-ok ${seq}\n`)
    } catch (error) {
      process.stdout.write(`append-error ${error?.name ?? 'Error'}\n`)
    }
  })
  setInterval(() => {}, 1000)
} else {
  const evidence = { dshVersion: appRequire('@deepseek-ai/dsh/package.json').version, node: process.version,
    platform: process.platform, experiments: {} }
  const me = fileURLToPath(import.meta.url)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // E1: suspended writer keeps ownership (no expiry) and resumes unfenced.
  {
    const root = await mkdtemp(join(tmpdir(), 'dsh02-own-e1-'))
    const out = { observations: [] }
    const child = spawn(process.execPath, [me, HOLDER_FLAG, runtimeRoot, root, 'e1'], { stdio: ['pipe', 'pipe', 'inherit'] })
    try {
      await once(child.stdout, 'data')
      const { store } = await mount(root)
      const tryOpen = async () => {
        try { (await store.open(session.SessionId('e1'), 'write')).close?.(); return 'acquired' }
        catch (error) { return error?.name ?? 'Error' }
      }
      out.observations.push({ step: 'live holder', successorWriteOpen: await tryOpen() })
      child.kill('SIGSTOP')
      await sleep(4000)
      out.observations.push({ step: 'holder SIGSTOP + 4s (any short Nexus lease would have expired)', successorWriteOpen: await tryOpen() })
      child.kill('SIGCONT')
      const reply = once(child.stdout, 'data')
      child.stdin.write('append 2\n')
      out.observations.push({ step: 'holder SIGCONT, resumed append of seq 2 (no external fence supplied)',
        holderResult: String((await reply)[0]).trim() })
      child.kill('SIGKILL')
      await once(child, 'exit')
      out.observations.push({ step: 'holder SIGKILL', successorWriteOpen: await tryOpen() })
    } finally { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
    evidence.experiments.E1_suspended_holder = out
  }

  // E2: after the documented lock-file forfeit, does a stale handle get refused?
  {
    const root = await mkdtemp(join(tmpdir(), 'dsh02-own-e2-'))
    const out = { observations: [] }
    const a = await mount(root), b = await mount(root)
    const stale = await a.store.create(header('e2'))
    await stale.append([ev(0, 1), ev(1, 1)])
    await stale.flush()
    const lockFiles = (await readdir(join(root, ...(await findLockDir(root))))).filter((f) => f === 'session.lock')
    out.lockFilePresent = lockFiles.length === 1
    await rm(await findLockPath(root))
    const successor = await b.store.open(session.SessionId('e2'), 'write')
    await successor.append([ev(2, 2)])
    await successor.flush()
    const attempt = async (label, fn) => {
      try { await fn(); out.observations.push({ step: label, result: 'accepted' }) }
      catch (error) { out.observations.push({ step: label, result: error?.name ?? 'Error', message: String(error?.message).slice(0, 160) }) }
    }
    await attempt('stale handle append seq 2 (conflicts with successor seq 2)', () => stale.append([ev(2, 9)]))
    await attempt('stale handle flush', () => stale.flush())
    await attempt('successor append seq 3 after stale attempts', async () => { await successor.append([ev(3, 2)]); await successor.flush() })
    // The persistence contract package is bundled into the jsonl backend; count references to the declared-but-unused error.
    out.ownershipLostReferencesInJsonlBackend = (await readFile(appRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl'), 'utf8')).split('SessionOwnershipLostError').length - 1
    try {
      const all = (await (await b.store.open(session.SessionId('e2'), 'read')).read(0)).events
      out.finalSeqs = all.map((e) => e.seq)
      out.logAfterStaleWrites = 'readable'
    } catch (error) {
      // A stale write that the backend accepted tore the durable log: later opens refuse it.
      out.logAfterStaleWrites = error?.name ?? 'Error'
      out.logAfterStaleWritesMessage = String(error?.message).slice(0, 220)
    }
    await stale.close().catch(() => {}); await successor.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
    evidence.experiments.E2_forfeited_lock_stale_handle = out
  }

  // E3: API surface — is there any place to supply or verify an external fence?
  {
    const root = await mkdtemp(join(tmpdir(), 'dsh02-own-e3-'))
    const { store } = await mount(root)
    const handle = await store.create(header('e3'))
    const names = new Set()
    for (let o = handle; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) Object.getOwnPropertyNames(o).forEach((n) => names.add(n))
    evidence.experiments.E3_api_surface = {
      handleMembers: [...names].filter((n) => n !== 'constructor').sort(),
      appendArity: handle.append.length, flushArity: handle.flush.length,
      // Names only: `lease`/`ensureLease` are private implementation members, not a public fencing API.
      // The public contract is append(events, { signal }) / flush({ signal }); neither accepts an owner token.
      fenceLikeMemberNames: [...names].filter((n) => /fence|token|lease|owner|epoch|generation/i.test(n)).sort(),
      persistenceStoreMembers: Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter((n) => n !== 'constructor').sort(),
    }
    await handle.close(); await rm(root, { recursive: true, force: true })
  }

  const outPath = argv[1]
  const text = JSON.stringify(evidence, null, 2)
  if (outPath) await writeFile(outPath, text + '\n')
  console.log(text)
}

async function findLockPath(root) {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(p)
      else if (entry.name === 'session.lock') return p
    }
  }
  throw new Error('session.lock not found')
}
async function findLockDir(root) {
  const p = await findLockPath(root)
  return p.slice(root.length + 1).split('/').slice(0, -1)
}
