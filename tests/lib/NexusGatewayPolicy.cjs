'use strict'

/**
 * TEST-ONLY Nexus listener for the PROPOSED DSH `gateway/authorize` hook
 * (P2-B2A prototype). Not used by the product. It enforces Controller
 * authority over Nexus-managed sessions (and their subagent lineage) for owner
 * and non-owner principals alike, and leaves ordinary sessions untouched.
 *
 * Contract of the hook: return `undefined` to abstain, `{ kind: 'deny', reason }`
 * to refuse. The first refusal wins whatever the listener order; a throw or
 * any other value refuses. A listener can never allow what DSH's own
 * non-owner decision denied (that decision runs first).
 *
 * Policy:
 *   - Controller unavailable or closed -> every non-read operation refused.
 *   - Read operations (lists, pages, follows, observations, catalogs) abstain.
 *   - Any operation attributed (session resource, agentId, child/parent
 *     session ids) to a managed session or its subagent lineage -> refused.
 *   - Workspace-scoped mutations that can remove a managed session's
 *     authorization (workspace delete/rename) -> refused while that workspace
 *     contains a managed session. Ordering/pinning abstain (cosmetic).
 *   - Terminal mutations on ANY session whose cwd is a managed session's cwd ->
 *     refused (a PTY can rewrite the managed task's source snapshot).
 *   - Host-level mutations that can change task authority, routes, credentials,
 *     loaded plugins or run host code -> refused while any managed session is
 *     registered; abstain otherwise (ordinary owner maintenance unchanged).
 *   - Unattributable mutations (resources undefined) -> refused while any
 *     managed session is registered; a missing resource is never permission.
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
const HOST_PROTECTED_PREFIXES = ['pluginManager/', 'settings/', 'credentials/', 'dynamicCordisRunner/', 'schedule/', 'job/', 'llm/', 'goals/']

function createNexusGatewayPolicy(options) {
  const getController = options.getController
  const sessionOf = options.sessionOf // id -> live session (header) or undefined
  const managedIds = options.managedIds // () -> string[]
  const decisions = []
  const record = (request, verdict) => { decisions.push({ action: request.action, principal: request.principal && request.principal.kind, transport: request.transport, resources: request.resources === undefined ? null : request.resources, verdict: verdict ? verdict.reason : 'abstain' }); return verdict }
  const deny = (request, reason) => record(request, { kind: 'deny', reason })

  return {
    decisions,
    listener(request) {
      const controller = getController()
      const read = READ_ACTIONS.has(request.action)
      if (!controller || controller.closed) return read ? record(request, undefined) : deny(request, 'nexus-controller-unavailable')
      if (read) return record(request, undefined)
      const admission = controller.admission
      const anyManaged = managedIds().length > 0
      if (request.resources === undefined) return anyManaged ? deny(request, 'nexus-unattributed-while-managed') : record(request, undefined)
      const args = request.args && typeof request.args === 'object' ? request.args : {}
      const sessionIds = new Set()
      for (const resource of request.resources) if (resource.kind === 'session') sessionIds.add(resource.id)
      for (const key of ['agentId', 'childSessionId', 'parentSessionId']) if (typeof args[key] === 'string') sessionIds.add(args[key])
      for (const id of sessionIds) {
        const session = sessionOf(id)
        if (admission.isManaged(session ? { id, header: session.header || {} } : id)) return deny(request, 'nexus-managed-session')
      }
      for (const resource of request.resources) {
        if (resource.kind === 'workspace' && WORKSPACE_AUTHORITY.has(request.action) && options.workspaceHasManaged(resource.id)) return deny(request, 'nexus-managed-workspace')
      }
      if (request.action.startsWith('terminal/')) {
        const managedCwds = new Set(managedIds().map((id) => { const s = sessionOf(id); return s && s.header ? s.header.cwd : null }).filter(Boolean))
        for (const id of sessionIds) { const s = sessionOf(id); if (s && s.header && managedCwds.has(s.header.cwd)) return deny(request, 'nexus-managed-workspace') }
        if (sessionIds.size === 0 && anyManaged) return deny(request, 'nexus-unattributed-while-managed')
      }
      if (anyManaged && HOST_PROTECTED_PREFIXES.some((prefix) => request.action.startsWith(prefix))) return deny(request, 'nexus-host-protected-while-managed')
      if (request.action === '$events/result' && request.resources.length === 1 && request.resources[0].kind === 'global' && anyManaged) return deny(request, 'nexus-unattributed-while-managed')
      return record(request, undefined)
    },
  }
}

module.exports = { createNexusGatewayPolicy, READ_ACTIONS }
