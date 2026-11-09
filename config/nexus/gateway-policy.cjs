'use strict'

/**
 * nexus/gateway-policy — product Nexus policy for the PROPOSED DSH
 * `gateway/authorize` hook, plus the Connection fetch-route guard and the
 * Nexus-route guard (P2-B2B). Fail closed. A separately testable component:
 * on pinned DSH 0.2.2 the hook does not exist, so the gateway listener is
 * never invoked; the fetch-route and Nexus-route guards use seams that exist
 * today and only ever affect Nexus-managed sessions.
 *
 * Hook contract: return `undefined` to abstain, `{ kind: 'deny', reason }` to
 * refuse. Listeners cannot allow; DSH's own non-owner decision runs first.
 *
 * Owner maintenance that stays ALLOWED: every read; every operation on
 * unmanaged sessions in workspaces without an active managed task; workspace
 * ordering/pinning of unmanaged sessions; and, when no managed task is active,
 * every host-level operation (settings, credentials, plugins, schedules,
 * jobs, host runner).
 * Operations REFUSED (reason codes):
 *   nexus-controller-unavailable     Controller absent/closed: every mutation.
 *   nexus-managed-session            any mutation attributed (session resource,
 *                                    agentId, child/parent session, waiting
 *                                    agent of an event answer) to a managed
 *                                    session or its subagent lineage — the
 *                                    Controller task API is the only mediator
 *                                    (submit/cancel/respond).
 *   nexus-managed-workspace          workspace delete/rename of a workspace
 *                                    holding a managed session; terminal
 *                                    mutations in an active managed task's cwd.
 *   nexus-host-protected-while-active host-level mutations that can change
 *                                    routes, credentials, loaded plugins,
 *                                    schedules/jobs or run host code while a
 *                                    managed task is active.
 *   nexus-unattributed-while-active  any unattributable mutation while a
 *                                    managed task is active (a missing resource
 *                                    is never permission).
 * The gateway hook is NOT a filesystem sandbox: agent tools of an ordinary
 * session write files without crossing the gateway. Cross-session workspace
 * writes are prevented separately by the Controller's workspace exclusivity
 * gate at agent/pre-step (see controller.cjs).
 */

const READ_ACTIONS = new Set([
  '$events',
  'account/getBalance', 'account/getProfile', 'account/getState', 'account/getUnnotifiedBonuses', 'account/hasRunningAccountTasks', 'account/watch', 'account/watchExpiry',
  'agentPresets/list', 'agentPresets/read', 'commands/list', 'credentials/describe', 'directoryPicker/list',
  'dynamicCordisRunner/inventory', 'fileReferences/list', 'goals/get', 'job/follow', 'job/list',
  'llm/listConfigurableProviders', 'llm/listProviders', 'messageFeedback/list', 'officeToPdf/generation', 'permissionPresets/catalog', 'pluginInventory/list',
  'pluginManager/inspect', 'pluginManager/listBundles', 'pluginManager/listPlugins', 'pluginManager/listVersionExemptions', 'pluginManager/listVersions', 'pluginManager/readBundleDetail', 'pluginManager/registries', 'pluginManager/waitForInstall',
  'pluginRegistryProbe/fastest', 'remoteAccess/follow', 'schedule/catalog', 'schedule/deliveryLimits', 'schedule/history', 'schedule/list', 'schedule/view',
  'session/canOpenWorkspacePath', 'session/control', 'session/events', 'session/follow', 'session/list', 'session/modelCatalog', 'session/observeEvent', 'session/observeProjections', 'session/observeState',
  'session/page', 'session/projections', 'session/search', 'session/state', 'session/wait', 'session/workspacePathApplications', 'session/attachment',
  'sessionReferenceResolver/candidates', 'settings/describe', 'skills/list', 'terminal/environment', 'terminal/list', 'terminal/shells', 'terminal/retain', 'toolResults/watch',
  'userQuestions/attachWait', 'workspace/follow', 'workspaceFiles/changes', 'workspaceFiles/list', 'workspaceFiles/read', 'workspaceFiles/readBytes', 'workspaceFiles/stat',
])
const WORKSPACE_AUTHORITY = new Set(['workspace/delete', 'workspace/rename'])
const HOST_PROTECTED_PREFIXES = Object.freeze(['pluginManager/', 'settings/', 'credentials/', 'dynamicCordisRunner/', 'schedule/', 'job/', 'llm/', 'goals/'])
const SESSION_ARG_KEYS = Object.freeze(['agentId', 'childSessionId', 'parentSessionId', 'sessionId'])
// Nexus routes that change routing/profile/registry authority of live tasks.
const HOST_PROTECTED_ROUTES = Object.freeze(['/nexus/registry/v1/', '/nexus/engineering-profile-action.json', '/nexus/mode-default.json'])
const MUTATING_FETCH_ROUTES = Object.freeze({ '/api/session/uploadFileBinary': 'sessionId' })

/**
 * @param {object} ports
 * @param {() => object|null} ports.controller live host Controller (or null)
 * @param {(id: string) => object|undefined} ports.sessionOf live DSH session (header) by id
 * @param {(workspaceId: string) => string[]} ports.workspaceSessions session ids of a workspace
 */
function createGatewayPolicy(ports) {
  const metrics = { decisions: 0, denials: 0, byReason: Object.create(null) }
  const deny = (reason) => { metrics.denials += 1; metrics.byReason[reason] = (metrics.byReason[reason] || 0) + 1; return { kind: 'deny', reason } }

  function cwdOf(id) { const s = ports.sessionOf(id); return s && s.header ? s.header.cwd : null }

  function decide(request) {
    metrics.decisions += 1
    const controller = ports.controller()
    const read = READ_ACTIONS.has(request.action)
    if (!controller || controller.closed) return read ? undefined : deny('nexus-controller-unavailable')
    if (read) return undefined
    const admission = controller.admission
    const active = admission.activeManagedSessions()
    if (request.resources === undefined) return active.length ? deny('nexus-unattributed-while-active') : undefined
    const args = request.args && typeof request.args === 'object' ? request.args : {}
    const ids = new Set()
    for (const resource of request.resources) if (resource.kind === 'session') ids.add(resource.id)
    for (const key of SESSION_ARG_KEYS) if (typeof args[key] === 'string') ids.add(args[key])
    for (const value of Object.values(args)) if (value && typeof value === 'object' && typeof value.sessionId === 'string') ids.add(value.sessionId)
    for (const id of ids) {
      const session = ports.sessionOf(id)
      if (admission.isManaged(session ? { id, header: session.header || {} } : id)) return deny('nexus-managed-session')
    }
    for (const resource of request.resources) {
      if (resource.kind === 'workspace' && WORKSPACE_AUTHORITY.has(request.action) && ports.workspaceSessions(resource.id).some((id) => admission.isManaged(id))) return deny('nexus-managed-workspace')
    }
    if (request.action.startsWith('terminal/')) {
      const activeCwds = new Set(active.map(cwdOf).filter(Boolean))
      for (const id of ids) if (activeCwds.has(cwdOf(id))) return deny('nexus-managed-workspace')
      if (ids.size === 0 && active.length) return deny('nexus-unattributed-while-active')
    }
    if (active.length && HOST_PROTECTED_PREFIXES.some((prefix) => request.action.startsWith(prefix))) return deny('nexus-host-protected-while-active')
    if (request.action === '$events/result' && ids.size === 0 && active.length) return deny('nexus-unattributed-while-active')
    return undefined
  }

  /** Connection fetch-route guard (existing `connection/request` seam). */
  function fetchRouteVerdict(method, url) {
    const field = MUTATING_FETCH_ROUTES[url.pathname]
    if (!field) return undefined
    const controller = ports.controller()
    if (!controller || controller.closed) return deny('nexus-controller-unavailable')
    const id = url.searchParams.get(field) || ''
    return controller.admission.isManaged(id) ? deny('nexus-managed-session') : undefined
  }

  return Object.freeze({ decide, fetchRouteVerdict, metrics: () => ({ ...metrics, byReason: { ...metrics.byReason } }) })
}

/**
 * Nexus-owned `/nexus/*` mutation routes (the UI host plugin calls this before
 * mutating). Managed sessions are operated only through the task API; host
 * registry mutations are refused while a managed task is active.
 */
function nexusRouteVerdict(controller, route, input = {}) {
  if (!controller || controller.closed) return { allowed: false, reason: 'nexus-controller-unavailable' }
  const admission = controller.admission
  if (typeof input.sessionId === 'string' && admission.isManaged(input.sessionId)) return { allowed: false, reason: 'nexus-managed-session' }
  if (typeof input.taskInstanceId === 'string' && admission.isManagedTaskInstance(input.taskInstanceId)) return { allowed: false, reason: 'nexus-managed-session' }
  if (HOST_PROTECTED_ROUTES.some((prefix) => route.startsWith(prefix)) && admission.activeManagedSessions().length) return { allowed: false, reason: 'nexus-host-protected-while-active' }
  return { allowed: true, reason: null }
}

module.exports = { createGatewayPolicy, nexusRouteVerdict, READ_ACTIONS, HOST_PROTECTED_PREFIXES, HOST_PROTECTED_ROUTES, MUTATING_FETCH_ROUTES }
