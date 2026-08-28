// @nexus/controller — host half: read-only controller-state adapter.
//
// Registers ONE exact HTTP route on the official webServer registry:
//
//   GET /nexus/controller.json?session=<sessionId>
//
// The handler reads REAL Nexus controller state (task ledger, session
// bindings, routing state, routing decisions, launcher state, git) through
// the pure adapter in status.cjs and returns a small normalized JSON
// snapshot. It is strictly read-only: no route writes anything, no state is
// mutated, and every read is fail-closed (missing/corrupt sources degrade to
// null rather than erroring).
//
// Profiles without a webServer (tui, headless) load this row harmlessly:
// the route half is bound through Cordis lifecycle injection, so it only
// ever activates once the webServer service is available — and if the
// service arrives AFTER this plugin starts (composition ordering), the
// injection resolves then, instead of being lost to a one-time lookup.
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import status from './status.cjs'
import detail from './detail.cjs'

const name = 'nexus-controller'

const GIT_TTL_MS = 10000
const SETTINGS_TTL_MS = 10000

function apply(ctx) {
  // Cordis lifecycle injection: starts this callback once the webServer
  // service is available (immediately, or later when the service appears).
  // Without the service the callback never runs — the plugin stays inert.
  ctx.inject(['webServer'], (webCtx) => {
    const installRoot = process.env.DSH_HOME ? dirname(process.env.DSH_HOME) : 'C:\\AI-Harness'
    const dataRoot = process.env.DSH_HOME ? process.env.DSH_HOME : join(installRoot, 'data')
    const settingsPath = join(dataRoot, 'settings.yaml')
    const statePath = join(dataRoot, 'aih-state.json')

  // js-yaml resolves through the app closure (the same pattern
  // scripts/Read-Verification.mjs uses); absent it, model display names fall
  // back to prettified model ids. Fail-closed either way.
  let loadYaml = null
  try {
    const requireFromApp = createRequire(join(installRoot, 'app', 'package.json'))
    loadYaml = requireFromApp('js-yaml')
  } catch {
    loadYaml = null
  }

  const gitCache = new Map()
  const gitFilesCache = new Map()
  const settingsCache = { at: 0, value: null }
  const detailCache = new Map() // sessionId -> { key, at, value } (mtime-keyed)


  function execGit(command, args, options) {
    return new Promise((resolve, reject) => {
      execFile(command, args, options, (error, stdout) => {
        if (error) reject(error)
        else resolve({ stdout })
      })
    })
  }

  /** Read-only git summary, cached per workspace (GIT_TTL_MS). */
  async function gitSummary(workspace) {
    if (!workspace) return null
    const now = Date.now()
    const cached = gitCache.get(workspace)
    if (cached && now - cached.at < GIT_TTL_MS) return cached.value
    const value = await status.collectGitSummary(workspace, execGit)
    gitCache.set(workspace, { at: now, value })
    return value
  }

  /** Read-only per-file git detail, cached per workspace (GIT_TTL_MS). */
  async function gitFiles(workspace) {
    if (!workspace) return null
    const now = Date.now()
    const cached = gitFilesCache.get(workspace)
    if (cached && now - cached.at < GIT_TTL_MS) return cached.value
    const value = await detail.collectGitFiles(workspace, execGit)
    gitFilesCache.set(workspace, { at: now, value })
    return value
  }

  /** Model display-name map from data/settings.yaml, cached. */
  function modelNames() {
    const now = Date.now()
    if (settingsCache.value !== null && now - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value
    const map = {}
    if (loadYaml) {
      try {
        const document = loadYaml.load(readFileSync(settingsPath, 'utf8'))
        const providers = document && document['llm-pi-ai'] && document['llm-pi-ai'].providers
        if (providers && typeof providers === 'object') {
          for (const [providerId, provider] of Object.entries(providers)) {
            if (!provider || typeof provider !== 'object' || !Array.isArray(provider.models)) continue
            for (const model of provider.models) {
              if (model && typeof model.id === 'string' && typeof model.name === 'string') {
                map[providerId + '/' + model.id] = model.name
              }
            }
          }
        }
      } catch {
        /* corrupt settings: fall back to prettified ids */
      }
    }
    settingsCache.value = map
    settingsCache.at = now
    return map
  }

  const handler = async (req, res) => {
    const generatedAtUtc = new Date().toISOString()
    let body
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const sessionId = (url.searchParams.get('session') || '').trim()
      const snapshot = await status.buildControllerSnapshot({
        dataRoot,
        sessionId,
        settingsPath,
        statePath,
        modelNames: modelNames(),
        gitSummary,
        nowUtc: () => generatedAtUtc,
      })
      body = JSON.stringify(snapshot)
    } catch {
      body = JSON.stringify({
        schemaVersion: 1,
        generatedAtUtc,
        state: 'idle',
        binding: null,
        task: null,
        execution: null,
        review: null,
        controller: null,
        git: null,
        error: 'controller-state-unavailable',
      })
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  // Files that feed the detail snapshot, per bound session. mtime-keyed so
  // the (immutable-history) snapshot is only recomputed when a source changes.
  function detailSourceKey(workspace, taskId, sessionId) {
    const paths = [
      join(dataRoot, 'routing', 'session-bindings.json'),
      join(dataRoot, 'routing', 'decisions.jsonl'),
      join(dataRoot, 'routing', 'states', status.routingStateFileName(workspace, bindingOf(sessionId)?.preset || 'aih-engineering', taskId)),
      join(workspace, '.ai-harness', 'state', 'tasks.json'),
      join(workspace, '.ai-harness', 'state', 'decisions.jsonl'),
      join(workspace, '.ai-harness', 'runs', taskId, 'attempts.jsonl'),
      join(workspace, '.ai-harness', 'runs', taskId, 'evidence.json'),
      join(workspace, '.ai-harness', 'runs', taskId, 'review-packet.json'),
      join(workspace, '.ai-harness', 'runs', taskId, 'review-result.json'),
      statePath,
    ]
    let key = sessionId
    for (const filePath of paths) {
      try {
        key += '|' + filePath + ':' + statSync(filePath).mtimeMs
      } catch {
        key += '|' + filePath + ':missing'
      }
    }
    return key
  }

  function bindingOf(sessionId) {
    const document = readJsonSafeSync(join(dataRoot, 'routing', 'session-bindings.json'))
    if (!document) return null
    return status.bindingsOf(document)[String(sessionId || '')] || null
  }

  function readJsonSafeSync(filePath) {
    try {
      const text = readFileSync(filePath, 'utf8')
      return text.trim() === '' ? null : JSON.parse(text)
    } catch {
      return null
    }
  }

  const detailHandler = async (req, res) => {
    const generatedAtUtc = new Date().toISOString()
    let body
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const sessionId = (url.searchParams.get('session') || '').trim()
      const binding = bindingOf(sessionId)
      if (!binding || !binding.workspace || !binding.taskId) {
        body = JSON.stringify({
          schemaVersion: 1,
          generatedAtUtc,
          state: 'idle',
          binding: null,
          task: null,
          execution: null,
          routingHistory: [],
          lifecycle: [],
          attempts: [],
          verification: { status: 'not-run', passed: 0, failed: 0, skipped: 0, total: 0, checks: [], artifactPath: null, artifactPresent: false, source: null },
          failures: { current: null, signatures: [], sameFailureCount: null },
          reviews: { codexCalls: 0, reviewRequired: false, decisions: [], result: null, packet: null },
          git: { summary: null, files: null },
          controller: null,
        })
      } else {
        const workspace = String(binding.workspace)
        const taskId = String(binding.taskId)
        const key = detailSourceKey(workspace, taskId, sessionId)
        const cached = detailCache.get(sessionId)
        const now = Date.now()
        if (cached && cached.key === key && now - cached.at < 60000) {
          body = JSON.stringify(cached.value)
        } else {
          const snapshot = await detail.buildDetailSnapshot({
            dataRoot,
            sessionId,
            statePath,
            modelNames: modelNames(),
            gitSummary: await gitSummary(workspace),
            gitFiles: await gitFiles(workspace),
            nowUtc: () => generatedAtUtc,
          })
          if (!snapshot) {
            body = JSON.stringify({
              schemaVersion: 1,
              generatedAtUtc,
              state: 'idle',
              binding: null,
              task: null,
              execution: null,
              routingHistory: [],
              lifecycle: [],
              attempts: [],
              verification: { status: 'not-run', passed: 0, failed: 0, skipped: 0, total: 0, checks: [], artifactPath: null, artifactPresent: false, source: null },
              failures: { current: null, signatures: [], sameFailureCount: null },
              reviews: { codexCalls: 0, reviewRequired: false, decisions: [], result: null, packet: null },
              git: { summary: null, files: null },
              controller: null,
            })
          } else {
            detailCache.set(sessionId, { key, at: now, value: snapshot })
            body = JSON.stringify(snapshot)
          }
        }
      }
    } catch {
      body = JSON.stringify({
        schemaVersion: 1,
        generatedAtUtc,
        error: 'control-room-unavailable',
      })
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: '/nexus/controller.json', handler }),
      'nexus-controller: read-only state route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: '/nexus/control-room.json', handler: detailHandler }),
      'nexus-controller: read-only control-room route',
    )
  })
}

export { apply, name }
