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
import { readFileSync, statSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import status from './status.cjs'
import detail from './detail.cjs'
import gate from './gate.cjs'
import engineering from './engineering.cjs'

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
        profilesPath: join(installRoot, 'config', 'engineering-profiles.json'),
        customProfilesPath: join(dataRoot, 'custom-engineering-profile.json'),
        policyPath: join(installRoot, 'config', 'routing-policy.json'),
        registryPath: join(installRoot, 'config', 'model-registry.json'),
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
      join(dataRoot, 'completion', 'gates.jsonl'),
      join(dataRoot, 'completion', 'gate-actions.jsonl'),
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
            profilesPath: join(installRoot, 'config', 'engineering-profiles.json'),
            customProfilesPath: join(dataRoot, 'custom-engineering-profile.json'),
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

    // ── operator gate action (TASK-0004) ────────────────────────────────
    // The browser NEVER mutates controller state directly: it sends
    // identifiers only ({sessionId, gateId, actionId, requestId}) and the
    // server validates the gate is current, the action is advertised, and
    // the requestId is not a replay. Duplicate submissions can therefore
    // never double-transition a gate (requestId idempotency + open-status
    // guard). Serialized through one in-process promise chain.
    let gateMutationChain = Promise.resolve()
    function withGateMutex(task) {
      const run = gateMutationChain.then(task, task)
      gateMutationChain = run.catch(() => {})
      return run
    }

    function readJsonBody(req) {
      return new Promise((resolve) => {
        let text = ''
        req.on('data', (chunk) => { text += chunk })
        req.on('end', () => {
          try { resolve(JSON.parse(text)) } catch { resolve(null) }
        })
        req.on('error', () => resolve(null))
      })
    }

    function execPowerShell(args) {
      return new Promise((resolve) => {
        execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(installRoot, 'scripts', 'Task.ps1'), ...args], { timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
          if (error) { resolve(null); return }
          try { resolve(JSON.parse((stdout || '').trim())) } catch { resolve(null) }
        })
      })
    }

    /** Exec the EngineeringProfile.ps1 controller CLI (same shape as
     *  execPowerShell; free-form payloads travel via a UTF-8 payload file,
     *  never argv — identical to the Task.ps1 contract). */
    function execEngineeringProfile(args) {
      return new Promise((resolve) => {
        execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(installRoot, 'scripts', 'EngineeringProfile.ps1'), ...args], { timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
          if (error) { resolve(null); return }
          try { resolve(JSON.parse((stdout || '').trim())) } catch { resolve(null) }
        })
      })
    }

    function writePayloadFile(payload) {
      mkdirSync(join(dataRoot, 'tmp'), { recursive: true })
      const payloadPath = join(dataRoot, 'tmp', 'aih-engineering-payload-' + randomUUID() + '.json')
      writeFileSync(payloadPath, JSON.stringify(payload), 'utf8')
      return payloadPath
    }

    /** GET  /nexus/engineering-profile.json — read-only editor state. */
    const engineeringHandler = async (req, res) => {
      const respond = (statusCode, body) => {
        res.writeHead(statusCode, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(body))
      }
      if (req.method !== 'GET') {
        respond(405, { ok: false, error: 'method-not-allowed' })
        return
      }
      try {
        const state = engineering.buildEngineeringProfileState({
          installRoot,
          dataRoot,
          settingsPath,
          profilesPath: join(installRoot, 'config', 'engineering-profiles.json'),
          registryPath: join(installRoot, 'config', 'model-registry.json'),
          customProfilePath: join(dataRoot, 'custom-engineering-profile.json'),
          nowUtc: () => new Date().toISOString(),
        })
        respond(200, state)
      } catch {
        respond(500, { ok: false, error: 'engineering-state-failed' })
      }
    }

    /** POST /nexus/engineering-profile.json — validated editor actions.
     *  Only two bounded actions: select (preferred profile) and save-custom
     *  (persist operator role bindings). The browser sends identifiers +
     *  bindings; the controller validates authoritatively and writes
     *  atomically. Never edits config files or ledgers in the browser. */
    const engineeringActionHandler = async (req, res) => {
      const respond = (statusCode, body) => {
        res.writeHead(statusCode, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(body))
      }
      if (req.method !== 'POST') {
        respond(405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const request = await readJsonBody(req)
      if (!request) {
        respond(400, { ok: false, error: 'invalid-json-body' })
        return
      }
      const action = String(request.action || '')
      if (action !== 'select' && action !== 'save-custom') {
        respond(422, { ok: false, error: 'unknown-action' })
        return
      }
      let payloadPath = null
      try {
        let result
        if (action === 'select') {
          const profileId = String(request.profileId || '').trim()
          if (profileId === '') {
            respond(422, { ok: false, error: 'missing-profile-id' })
            return
          }
          result = await execEngineeringProfile(['-Action', 'select', '-ProfileId', profileId])
        } else {
          const roles = request.roles
          const shapeError = engineering.validateSaveCustomPayload(roles, null)
          if (shapeError) {
            respond(422, { ok: false, error: shapeError })
            return
          }
          payloadPath = writePayloadFile({ roles })
          result = await execEngineeringProfile(['-Action', 'save-custom', '-PayloadFile', payloadPath])
        }
        if (!result) {
          respond(500, { ok: false, error: action === 'select' ? 'select-failed' : 'save-custom-failed' })
          return
        }
        if (result.ok === false) {
          respond(422, { ok: false, error: String(result.error || 'controller-rejected') })
          return
        }
        respond(200, result)
      } catch {
        respond(500, { ok: false, error: 'engineering-action-failed' })
      } finally {
        if (payloadPath) { try { unlinkSync(payloadPath) } catch { /* best-effort cleanup */ } }
      }
    }

        const gateHandler = async (req, res) => {
      const respond = (statusCode, body) => {
        res.writeHead(statusCode, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(body))
      }
      if (req.method !== 'POST') {
        respond(405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const request = await readJsonBody(req)
      if (!request) {
        respond(400, { ok: false, error: 'invalid-json-body' })
        return
      }
      const sessionId = String(request.sessionId || '')
      const gateId = String(request.gateId || '')
      const actionId = String(request.actionId || '')
      const requestId = String(request.requestId || '')
      if (!sessionId || !gateId || !actionId || !requestId) {
        respond(400, { ok: false, error: 'missing-identifier' })
        return
      }
      const binding = bindingOf(sessionId)
      try {
        const outcome = await withGateMutex(() => {
          const validation = gate.validateGateAction(dataRoot, binding, { sessionId, gateId, actionId, requestId })
          if (!validation.ok) {
            if (validation.replay) return { kind: 'replay' }
            const statusCode = validation.error === 'gate-stale' || validation.error === 'gate-not-waiting' ? 409 : (validation.error === 'action-not-allowed' || validation.error === 'action-not-advertised' ? 422 : 404)
            return { kind: 'error', statusCode, error: validation.error }
          }
          const resolved = gate.resolveGate(dataRoot, binding, validation.gate, actionId, requestId)
          let completion = null
          if (actionId === 'approve') {
            // The ONLY bounded controller transition for approval: attempt
            // completion with the review passed (fails closed when
            // verification or criteria are not met).
            completion = execPowerShell(['-Action', 'complete', '-TaskId', String(binding.taskId), '-CodexReviewPassed'])
          }
          return { kind: 'ok', gate: status.normalizeGateRecord(resolved), completion }
        })
        if (outcome.kind === 'ok') {
          respond(200, {
            ok: true,
            gate: outcome.gate,
            completion: outcome.completion,
          })
        } else if (outcome.kind === 'replay') {
          respond(200, { ok: false, error: 'request-replay', replay: true })
        } else {
          respond(outcome.statusCode, { ok: false, error: outcome.error })
        }
      } catch (error) {
        respond(500, { ok: false, error: 'gate-action-failed' })
      }
    }

    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: '/nexus/controller.json', handler }),
      'nexus-controller: read-only state route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: '/nexus/control-room.json', handler: detailHandler }),
      'nexus-controller: read-only control-room route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: '/nexus/gate-action.json', handler: gateHandler }),
      'nexus-controller: operator gate action route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: '/nexus/engineering-profile.json', handler: engineeringHandler }),
      'nexus-controller: engineering profile read route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: '/nexus/engineering-profile-action.json', handler: engineeringActionHandler }),
      'nexus-controller: engineering profile action route',
    )
  })
}

export { apply, name }
