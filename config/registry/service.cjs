'use strict'

/**
 * Registry R3 — host-independent Registry service.
 *
 * The single Nexus-owned configuration authority for the R3 UI. Pure
 * orchestration over Registry Core (schemas / resolver / legacy-import /
 * muse-canonical / profile-compat) plus the file-backed config-store. Takes
 * explicit installRoot + dataRoot; never reads process.env, never imports
 * DSH, PowerShell, network or session state. The host adapter
 * (ui/nexus-controller/lib/registry.cjs) adds transport concerns (HTTP,
 * payload caps, same-origin checks); this module owns canonical logic only.
 *
 * Operations:
 *
 * - listModes() — ModeDefinitions with saved-revision + executability.
 * - getSnapshot() — canonical (Muse-unified) snapshot or actionable errors.
 * - getModeConfiguration(modeId, { adopt }) — saved config, else a
 *   reviewable legacy-adoption preview (persisted:false). Never auto-saves.
 * - listEligible(modeId, slotId) / listIneligible(modeId, slotId) — resolver
 *   data enriched for display (model/provider/reasoning/connection/capacity).
 * - validate(config) — authoritative error list (schema + compile).
 * - compilePreview(config) — non-secret compiled snapshot or errors.
 * - save(modeId, config, expectedRevision, { source, adoptedFrom }) —
 *   validate + compile + atomic persisted write.
 */

const legacyImport = require('./legacy-import.cjs')
const museCanonical = require('./muse-canonical.cjs')
const profileCompat = require('./profile-compat.cjs')
const resolver = require('./resolver.cjs')
const schemas = require('./schemas.cjs')
const configStore = require('./config-store.cjs')
const catalog = require('./operator-catalog.cjs')
const probes = require('./probes.cjs')
const runtimeProjection = require('./runtime-projection.cjs')
const subscriptions = require('./subscription-connections.cjs')

const SERVICE_SCHEMA_VERSION = 1
const SUPPORTED_MODES = ['engineering-v1', 'engineering-v2', 'engineering-v3']

// Default legacy profile seeding each mode preview. Alternatives remain
// adoptable via getModeConfiguration(modeId, { adopt: <profileId> }).
const DEFAULT_ADOPT_PROFILE = {
  'engineering-v1': 'deepseek-codex',
  'engineering-v2': 'muse-spark-1.3-contributor',
}
const ADOPTABLE_PROFILES = {
  'engineering-v1': ['deepseek-codex', 'glm-codex', 'custom'],
  'engineering-v2': ['muse-spark-1.3-contributor', 'muse-spark-1.3-contributor-opencode'],
}

function err(code, p, message) {
  return { code, path: p, message }
}

function createService(options) {
  const installRoot = options && options.installRoot ? String(options.installRoot) : ''
  const dataRoot = options && options.dataRoot ? String(options.dataRoot) : ''
  const nowUtc = options && typeof options.nowUtc === 'function' ? options.nowUtc : () => new Date().toISOString()
  const fsHooks = options && options.fsHooks ? options.fsHooks : undefined
  if (installRoot === '' || dataRoot === '') throw new Error('registry-service: installRoot and dataRoot are required')

  function buildCanonical() {
    const built = legacyImport.buildRegistrySnapshot(installRoot)
    if (!built.snapshot) {
      return { snapshot: null, aliases: null, errors: built.errors.map((e) => err('snapshot-unavailable', 'registry', String(e))) }
    }
    const normalized = museCanonical.normalizeMuseSnapshot(built.snapshot)
    if (!normalized.snapshot) {
      return { snapshot: null, aliases: null, errors: built.errors.map((e) => err('snapshot-note', 'registry', String(e))).concat(normalized.errors.map((e) => err('snapshot-unavailable', 'registry', String(e)))) }
    }
    const withClaude = subscriptions.appendClaudeBuiltins(normalized.snapshot)
    const snapshotErrors = withClaude.added.length === 4 ? [] : [err('snapshot-note', 'registry', 'claude subscription built-ins already present; merge skipped duplicates')]
    return { snapshot: withClaude.snapshot, aliases: normalized.aliases, errors: snapshotErrors }
  }

  function modeById(snapshot, modeId) {
    for (const mode of (snapshot && snapshot.modes) || []) {
      if (mode && mode.id === modeId) return mode
    }
    return null
  }

  function executableOf(mode) {
    if (!mode) return { executable: false, reason: 'unknown-mode' }
    if (mode.runnable === false || mode.status === 'planned') {
      return { executable: false, reason: 'mode-not-runnable: ' + mode.id + ' is planned/preview and cannot be executed' }
    }
    return { executable: true, reason: null }
  }

  function listModes() {
    const built = buildCanonical()
    const store = configStore.loadStore(dataRoot, fsHooks)
    // Fall back to the on-disk manifests when the snapshot cannot build, so
    // the selector still renders honestly (all non-executable) instead of
    // vanishing. Manifests are git-managed Registry-owned data.
    let defs = built.snapshot ? built.snapshot.modes : []
    if (defs.length === 0) {
      try {
        const fs = require('node:fs')
        const p = require('node:path')
        defs = []
        for (const f of ['engineering-v1.json', 'engineering-v2.json', 'engineering-v3.json']) {
          try { defs.push(JSON.parse(fs.readFileSync(p.join(installRoot, 'config', 'registry', 'modes', f), 'utf8'))) } catch { /* skip; reported below */ }
        }
      } catch { /* handled below */ }
    }
    const out = []
    for (const modeId of SUPPORTED_MODES) {
      const mode = defs.find((m) => m && m.id === modeId) || null
      if (!mode) {
        out.push({ id: modeId, present: false, executable: false, reason: 'mode-definition-missing', savedRevision: null, savedValid: false, savedErrors: [] })
        continue
      }
      const exec = executableOf(mode)
      const entry = store.store ? store.store.modes[modeId] || null : null
      let savedValid = false
      let savedErrors = []
      if (entry && built.snapshot) {
        savedErrors = resolver.validateModeConfig(entry.config, built.snapshot)
        savedValid = savedErrors.length === 0
      } else if (!store.store) {
        savedErrors = store.errors
      }
      out.push({
        id: mode.id,
        present: true,
        displayName: mode.displayName,
        status: mode.status,
        selectable: mode.selectable !== false,
        runnable: mode.runnable !== false,
        executable: exec.executable,
        executableReason: exec.reason,
        orchestrationEngineId: mode.orchestrationEngineId,
        slots: (mode.slots || []).map((s) => ({ id: s.id, label: s.label, required: s.required === true, internalRoles: (s.internalRoles || []).slice(), requirements: Object.assign({}, s.requirements || {}) })),
        internalRoles: (mode.internalRoles || []).slice(),
        optionalCapabilities: (mode.optionalCapabilities || []).slice(),
        savedRevision: entry ? entry.revision : null,
        savedValid,
        savedErrors,
        persisted: !!entry,
      })
    }
    const errors = built.errors.concat(store.store ? [] : store.errors)
    return { modes: out, errors }
  }

  function compatConfigs(canonical) {
    // Canonical Muse identity when aliases exist; legacy ids otherwise.
    const imported = profileCompat.importCompatibleProfiles(installRoot, legacyImport.buildRegistrySnapshot(installRoot).snapshot || canonical.snapshot, canonical.aliases || undefined)
    return imported
  }

  function previewFor(modeId, adoptProfileId) {
    const canonical = buildCanonical()
    if (!canonical.snapshot) return { preview: null, errors: canonical.errors }
    const compat = compatConfigs(canonical)
    if (modeId === 'engineering-v3') {
      return { preview: { modeId, persisted: false, runnable: false, reason: 'mode-not-runnable: engineering-v3 is planned/preview; orchestration is not implemented in R3', slotsManifest: (modeById(canonical.snapshot, modeId) || {}).slots || [] }, errors: [] }
    }
    const adoptable = ADOPTABLE_PROFILES[modeId] || []
    const wanted = adoptProfileId || DEFAULT_ADOPT_PROFILE[modeId] || null
    if (wanted && adoptable.indexOf(wanted) === -1) {
      return { preview: null, errors: [err('unknown-profile', 'adopt', 'profile ' + wanted + ' cannot seed mode ' + modeId)] }
    }
    // Prefer the canonical compat config; fall back to the raw legacy import
    // (legacy ids) when canonical aliases are unavailable.
    let config = (compat.configs && compat.configs[wanted]) || null
    let canonicalIds = true
    if (!config) {
      const raw = legacyImport.importLegacyProfiles(installRoot, legacyImport.buildRegistrySnapshot(installRoot).snapshot || canonical.snapshot)
      config = raw.configs[wanted] || null
      canonicalIds = false
    }
    if (!config) {
      return { preview: null, errors: [err('legacy-profile-unavailable', 'adopt', 'legacy profile ' + wanted + ' cannot be imported here')] }
    }
    const eff = effectiveSnapshot()
    const validation = resolver.validateModeConfig(config, (eff.snapshot || canonical.snapshot))
    return { preview: { modeId, persisted: false, source: 'legacy-preview', adoptedFrom: wanted, canonicalIds, config, validation, adoptable }, errors: [] }
  }

  function getModeConfiguration(modeId, opts) {
    if (SUPPORTED_MODES.indexOf(modeId) === -1) {
      return { result: null, errors: [err('unknown-mode', 'modeId', 'unknown mode: ' + modeId)] }
    }
    const loaded = configStore.loadStore(dataRoot, fsHooks)
    if (!loaded.store) return { result: null, errors: loaded.errors }
    const entry = loaded.store.modes[modeId] || null
    if (entry) {
      const eff = snapshotOrErrors()
      const validation = eff.snapshot ? resolver.validateModeConfig(entry.config, eff.snapshot) : eff.errors
      return { result: { modeId, persisted: true, revision: entry.revision, source: entry.source, adoptedFrom: entry.adoptedFrom, savedAtUtc: entry.savedAtUtc, config: entry.config, validation }, errors: [] }
    }
    const adopt = opts && opts.adopt ? String(opts.adopt) : null
    const previewed = previewFor(modeId, adopt)
    if (previewed.preview) return { result: previewed.preview, errors: [] }
    return { result: null, errors: previewed.errors }
  }

  // R5: built-in connection status overlay (non-secret persistence).
  // Built-in connections are immutable records, but their live STATUS must
  // persist across restarts without storing credentials. statuses live in
  // <dataRoot>/registry/connection-status.json as { status, updatedAtUtc,
  // provenance } per built-in id. Only the five schema statuses are kept;
  // anything else fails closed. Operator connections keep the R4 path.
  const CONNECTION_STATUS_FILE = 'connection-status.json';
  const OVERLAY_STATUSES = ['connected', 'not-connected', 'unknown', 'revoked', 'disabled'];

  function statusOverlayPath() {
    const path = require('node:path');
    return path.join(String(dataRoot), 'registry', CONNECTION_STATUS_FILE);
  }

  function defaultFileHooks() {
    if (fsHooks) return fsHooks;
    const fs = require('node:fs');
    return {
      readFileSync: (f, enc) => fs.readFileSync(f, enc),
      writeFileSync: (f, data, opts) => fs.writeFileSync(f, data, opts),
      renameSync: (a, b) => fs.renameSync(a, b),
      mkdirSync: (f, opts) => fs.mkdirSync(f, opts),
      unlinkSync: (f) => fs.unlinkSync(f),
      statSync: (f) => fs.statSync(f),
    };
  }

  function loadStatusOverlay() {
    const hooks = defaultFileHooks();
    try {
      const raw = hooks.readFileSync(statusOverlayPath(), 'utf8');
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.schemaVersion !== 1 || !doc.statuses || typeof doc.statuses !== 'object' || Array.isArray(doc.statuses)) {
        return { statuses: {}, errors: [err('registry-authorization-unverifiable', 'registry.connection-status', 'connection status overlay is unreadable; current entitlement cannot be proven')] };
      }
      const clean = {};
      for (const id of Object.keys(doc.statuses)) {
        const entry = doc.statuses[id];
        if (!entry || typeof entry !== 'object' || OVERLAY_STATUSES.indexOf(entry.status) === -1) return { statuses: {}, errors: [err('registry-authorization-unverifiable', 'registry.connection-status', 'connection status overlay contains an invalid status')] };
        clean[id] = { status: entry.status, updatedAtUtc: entry.updatedAtUtc || null, provenance: entry.provenance || null };
      }
      return { statuses: clean, errors: [] };
    } catch (e) {
      if (e && (e.code === 'ENOENT' || (e.message && e.message.indexOf('ENOENT') !== -1))) return { statuses: {}, errors: [] };
      return { statuses: {}, errors: [err('registry-authorization-unverifiable', 'registry.connection-status', 'connection status overlay is unreadable; current entitlement cannot be proven')] };
    }
  }

  function writeStatusOverlay(statuses) {
    const hooks = defaultFileHooks();
    const path = require('node:path');
    const target = statusOverlayPath();
    try { hooks.mkdirSync(path.dirname(target), { recursive: true }); } catch (e) {}
    const doc = { schemaVersion: 1, updatedAtUtc: nowUtc(), statuses };
    let text = null;
    try { text = JSON.stringify(doc, null, 2) + '\n'; } catch (e) {
      return { ok: false, errors: [err('registry-store-unwritable', 'registry.connection-status', 'connection status overlay cannot be serialized')] };
    }
    const tmp = target + '.tmp-' + process.pid + '-' + Date.now().toString(36);
    try {
      hooks.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
      hooks.renameSync(tmp, target);
    } catch (e) {
      try { hooks.unlinkSync(tmp); } catch (e2) {}
      return { ok: false, errors: [err('registry-store-unwritable', 'registry.connection-status', 'connection status overlay cannot be written')] };
    }
    return { ok: true };
  }

  function builtInIdsOf(snapshot) {
    const idsOf = (items) => (items || []).map((e) => e && e.id).filter((id) => typeof id === 'string')
    return {
      providers: idsOf(snapshot.providers),
      models: idsOf(snapshot.models),
      routes: idsOf(snapshot.routes),
      connections: idsOf(snapshot.connections),
    }
  }

  // R4.1: effective snapshot = built-ins (immutable, derived) + operator
  // overlays. Operator records that collide with built-in ids are excluded
  // with an actionable duplicate-id note; built-in disable overlays flip
  // status without mutating built-in identity.
  function effectiveSnapshot() {
    const canonical = buildCanonical()
    if (!canonical.snapshot) return { snapshot: null, aliases: null, errors: canonical.errors }
    const op = catalog.loadOperatorDocs(dataRoot, fsHooks)
    if (!op.docs) return { snapshot: null, aliases: canonical.aliases, errors: canonical.errors.concat(op.errors) }
    const snap = JSON.parse(JSON.stringify(canonical.snapshot))
    const notes = []
    function addItems(kind, key) {
      const items = op.docs[kind].items
      for (const id of Object.keys(items)) {
        if (snap[key].some((e) => e && e.id === id)) {
          notes.push(err('duplicate-id', 'catalog.' + kind + '.' + id, 'operator ' + kind.slice(0, -1) + ' ' + id + ' collides with a built-in record and is excluded; built-in identity is preserved'))
          continue
        }
        snap[key].push(items[id].record)
      }
    }
    addItems('providers', 'providers')
    addItems('models', 'models')
    addItems('routes', 'routes')
    addItems('connections', 'connections')
    function findById(list, id) {
      for (const e of list) if (e && e.id === id) return e
      return null
    }
    for (const id of Object.keys(op.docs.providers.disabledBuiltins)) {
      const p = findById(snap.providers, id)
      if (p) p.status = 'disabled'
    }
    for (const id of Object.keys(op.docs.models.disabledBuiltins)) {
      const m = findById(snap.models, id)
      if (m) m.enabled = false
    }
    for (const id of Object.keys(op.docs.routes.disabledBuiltins)) {
      const r = findById(snap.routes, id)
      if (r) { r.availability = 'disabled'; r.enabled = false }
    }
    for (const id of Object.keys(op.docs.connections.disabledBuiltins)) {
      const c = findById(snap.connections, id)
      if (c) c.status = 'disabled'
    }
    // R5: apply the non-secret live-status overlay to built-in connections
    // only (operator connections keep their stored status). Unknown overlay
    // ids are ignored so a stale overlay can never invent a connection.
    try {
      const overlay = loadStatusOverlay()
      if (overlay.errors.length) return { snapshot: null, aliases: canonical.aliases, errors: overlay.errors }
      const disabledConns = op.docs.connections.disabledBuiltins || {}
      for (const id of Object.keys(overlay.statuses)) {
        if (Object.prototype.hasOwnProperty.call(disabledConns, id)) continue
        const c = findById(snap.connections, id)
        if (c) {
          c.status = overlay.statuses[id].status
          // An explicit indeterminate live check is not an offline legacy descriptor.
          if (c.status === 'unknown') c.provenance = 'registry-status-unverifiable'
        }
      }
      for (const e of overlay.errors) notes.push(e)
    } catch (e) {
      return { snapshot: null, aliases: canonical.aliases, errors: [err('registry-authorization-unverifiable', 'registry.connection-status', 'connection status overlay merge failed')] }
    }
    const ev = catalog.loadEvidence(dataRoot, fsHooks)
    // H3/R4.2: an operator route whose stored availability says 'verified'
    // is executable-eligible ONLY while its current evidence still binds
    // the exact verified tuple (endpoint, transport, model/checkpoint,
    // remote model, route, connection identity/status, capabilities,
    // declared plus VERIFIED reasoning levels, probe contract). Anything
    // else demotes the EFFECTIVE copy to probe-required — fail closed,
    // without rewriting history. Eligibility is further restricted to the
    // verified level subset: the effective copy carries only checked
    // levels, so unchecked reasoning never compiles. Built-in shipped
    // state is never touched here.
    const operatorRouteIds = Object.keys(op.docs.routes.items)
    if (ev.evidence) {
      for (const id of operatorRouteIds) {
        const r = findById(snap.routes, id)
        if (!r || r.availability !== 'verified') continue
        const current = catalog.currentEvidence(ev.evidence[id])
        const provider = findById(snap.providers, r.providerId) || null
        const model = findById(snap.models, r.logicalModelId) || null
        const connection = r.connectionId ? findById(snap.connections, r.connectionId) || null : null
        let cause = null
        if (!current) cause = 'no verification evidence is stored for this route'
        else if (current.failed === true) cause = 'the latest verification attempt failed'
        else if (current.contractVersion !== probes.PROBE_CONTRACT_VERSION) cause = 'evidence uses probe contract v' + String(current.contractVersion) + '; v' + String(probes.PROBE_CONTRACT_VERSION) + ' is required'
        else if (!provider || !model) cause = 'the verified provider or model is missing'
        else if (!connection || connection.status === 'revoked' || connection.status === 'disabled') cause = 'the verified connection is not authorized'
        else if (!Array.isArray(current.levelsVerified)) cause = 'evidence predates per-level verification; re-verify to restore eligibility'
        else {
          const recomputed = probes.fingerprintOf(probes.fingerprintInputOf({ provider, model, route: r, connection, verifiedLevels: current.levelsVerified }))
          if (current.fingerprint !== recomputed) cause = 'a security-relevant field changed since verification (endpoint, transport, model, remote model, connection, reasoning levels or verified set)'
        }
        if (cause) {
          r.availability = 'probe-required'
          notes.push(err('evidence-stale', 'catalog.routes.' + id, 'route ' + id + ' is not executable-eligible: ' + cause + '; re-verify to restore eligibility'))
        } else {
          r.reasoningLevels = current.levelsVerified.slice()
        }
      }
    }
    return { snapshot: snap, aliases: canonical.aliases, errors: canonical.errors.concat(notes), evidence: ev.evidence || {} }
  }

  function snapshotOrErrors() {
    const eff = effectiveSnapshot()
    if (!eff.snapshot) return { snapshot: null, errors: eff.errors }
    return { snapshot: eff.snapshot, errors: eff.errors }
  }

  // R4.2: no platform-fetch default. Callers pass their injected fetchImpl
  // or null; null selects the pinned IP-bound transport in the probe layer
  // (DNS resolved once, validated, then connected without re-resolution,
  // with SNI/TLS intact). An injected fetchImpl is a test seam only and
  // carries no binding guarantee — production UI calls never inject one.

  // References held by saved mode configurations (dependency guard input).
  function savedRefsOf(effective) {
    const refs = { routeIds: new Set(), modelIds: new Set(), providerIds: new Set(), connectionIds: new Set(), routeProviders: {} }
    const loaded = configStore.loadStore(dataRoot, fsHooks)
    if (!loaded.store) return refs
    const routesById = new Map((effective.routes || []).map((r) => [r && r.id, r]))
    function absorb(a) {
      if (!a || typeof a !== 'object') return
      if (typeof a.routeId === 'string') refs.routeIds.add(a.routeId)
      if (typeof a.logicalModelId === 'string') refs.modelIds.add(a.logicalModelId)
      const r = routesById.get(a.routeId)
      if (r) {
        refs.providerIds.add(r.providerId)
        refs.modelIds.add(r.logicalModelId)
        if (r.connectionId) refs.connectionIds.add(r.connectionId)
        refs.routeProviders[r.providerId] = (refs.routeProviders[r.providerId] || []).concat(r.id)
      }
    }
    for (const modeId of Object.keys(loaded.store.modes)) {
      const cfg = loaded.store.modes[modeId] && loaded.store.modes[modeId].config
      if (!cfg) continue
      for (const s of Object.values(cfg.slots || {})) absorb(s)
      for (const o of Object.values(cfg.roleOverrides || {})) absorb(o)
    }
    return refs
  }

  // Built-in identity comes from the CANONICAL snapshot only: the
  // effective snapshot already contains operator records, so deriving
  // built-in ids from it would misclassify operator work as built-in
  // (blocking verification/deletion of operator-owned records).
  function catalogOptions(effective, extra) {
    const canonical = buildCanonical()
    const ids = canonical.snapshot ? builtInIdsOf(canonical.snapshot) : builtInIdsOf(effective)
    return Object.assign({
      fsHooks,
      nowUtc,
      builtInIds: ids,
      savedRefs: savedRefsOf(effective),
    }, extra || {})
  }

  // R4.6 listing: effective catalog with display names, provenance,
  // verification evidence, connection state and compatibility explanations.
  function getCatalog() {
    const eff = effectiveSnapshot()
    if (!eff.snapshot) return { catalog: null, errors: eff.errors }
    const op = catalog.loadOperatorDocs(dataRoot, fsHooks)
    const opDocs = op.docs || { providers: { revision: 0, items: {} }, models: { revision: 0, items: {} }, routes: { revision: 0, items: {} }, connections: { revision: 0, items: {} } }
    const evidence = eff.evidence || {}
    const providersById = new Map(eff.snapshot.providers.map((p) => [p.id, p]))
    const modelsById = new Map(eff.snapshot.models.map((m) => [m.id, m]))
    const connectionsById = new Map(eff.snapshot.connections.map((c) => [c.id, c]))
    const routes = eff.snapshot.routes.map((r) => {
      const provider = providersById.get(r.providerId) || null
      const model = modelsById.get(r.logicalModelId) || null
      const connection = r.connectionId ? connectionsById.get(r.connectionId) || null : null
      const gate = resolver.routeEligibility(r)
      return {
        routeId: r.id,
        providerId: r.providerId,
        providerName: provider ? (provider.name || provider.id) : r.providerId,
        logicalModelId: r.logicalModelId,
        modelDisplayName: model ? (model.displayName || model.id) : r.logicalModelId,
        remoteModelId: r.remoteModelId,
        executionKind: r.executionKind,
        availability: r.availability,
        enabled: r.enabled !== false,
        reasoningLevels: (r.reasoningLevels || []).slice(),
        transport: (r.compatibility && r.compatibility.transport) || 'unknown',
        connectionId: r.connectionId || null,
        connectionStatus: connection ? connection.status : 'missing',
        provenance: opDocs.routes.items[r.id] ? 'operator' : 'built-in',
        runnable: !gate,
        runnableReason: gate ? gate.code + ': ' + gate.message : 'verified route with an authorized connection',
        evidence: evidence[r.id] ? catalog.currentEvidence(evidence[r.id]) : null,
      }
    })
    const providers = eff.snapshot.providers.map((p) => ({
      id: p.id,
      name: p.name || p.id,
      transportId: p.transportId,
      baseUrl: p.baseUrl || null,
      authType: p.authType || null,
      status: p.status,
      provenance: opDocs.providers.items[p.id] ? 'operator' : 'built-in',
      recordVersion: opDocs.providers.items[p.id] ? opDocs.providers.items[p.id].recordVersion : null,
    }))
    const models = eff.snapshot.models.map((m) => ({
      id: m.id,
      displayName: m.displayName || m.id,
      vendor: m.vendor,
      checkpoint: m.checkpoint,
      capabilities: Object.assign({}, m.capabilities),
      dataUseTier: m.dataUseTier || null,
      enabled: m.enabled !== false,
      engines: (m.engines || []).slice(),
      provenance: opDocs.models.items[m.id] ? 'operator' : 'built-in',
    }))
    const connections = eff.snapshot.connections.map((c) => ({
      id: c.id,
      providerId: c.providerId,
      connectionKind: c.connectionKind,
      authMethod: c.authMethod || null,
      credentialRef: c.credentialRef || null,
      status: c.status,
      provenance: opDocs.connections.items[c.id] ? 'operator' : 'built-in',
    }))
    return {
      catalog: {
        providers,
        models,
        routes,
        connections,
        revisions: {
          providers: opDocs.providers.revision,
          models: opDocs.models.revision,
          routes: opDocs.routes.revision,
          connections: opDocs.connections.revision,
        },
      },
      errors: eff.errors,
    }
  }

  function findIn(effective, key, id) {
    for (const e of effective[key] || []) if (e && e.id === id) return e
    return null
  }

  // R4.1 provider save: canonical record only (no DSH ids, no secrets).
  function saveProvider(input, opts) {
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { ok: false, errors: eff.errors }
    const src = input || {}
    const record = {
      schemaVersion: 1,
      id: src.id,
      name: src.name,
      transportId: src.transportId,
      baseUrl: src.baseUrl,
      discovery: { strategy: 'provider-models-endpoint' },
      status: src.status || 'enabled',
    }
    if (src.authType === 'subscription-agent' || src.authType === 'subscription-delegated') {
      return { ok: false, errors: [err('provider-invalid', 'provider.authType', 'subscription lifecycles are native built-ins (Claude CLI session, Codex OAuth); operator manual providers use api-key, local-server or manual-unknown')] }
    }
    if (src.authType !== undefined) record.authType = src.authType
    if (src.metadata !== undefined) record.metadata = src.metadata
    return catalog.saveRecord(dataRoot, 'providers', record, catalogOptions(eff.snapshot, opts))
  }

  function saveModel(input, opts) {
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { ok: false, errors: eff.errors }
    const src = input || {}
    const record = {
      schemaVersion: 1,
      id: src.id,
      vendor: src.vendor,
      displayName: src.displayName,
      checkpoint: src.checkpoint,
      capabilities: src.capabilities,
      enabled: src.enabled !== undefined ? src.enabled : true,
      engines: src.engines,
    }
    for (const k of ['dataUseTier', 'contextWindow', 'maxOutputTokens', 'capacityProvenance', 'readOnlyDefault']) {
      if (src[k] !== undefined) record[k] = src[k]
    }
    if (Array.isArray(record.engines) && record.engines.length === 0) {
      return { ok: false, errors: [err('model-invalid', 'model.engines', 'engines must scope the model to at least one orchestration engine (dual-v1 and/or muse-v0); an empty scope is eligible nowhere')] }
    }
    return catalog.saveRecord(dataRoot, 'models', record, catalogOptions(eff.snapshot, opts))
  }

  // R4.1 route save: raw-model manual routes only (agent-sdk belongs to R5);
  // availability can only start as discovered/probe-required — 'verified' is
  // granted exclusively by verifyRoute after successful probes.
  function saveRoute(input, opts) {
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { ok: false, errors: eff.errors }
    const src = input || {}
    if (src.executionKind !== undefined && src.executionKind !== 'raw-model') {
      return { ok: false, errors: [err('route-invalid', 'route.executionKind', 'R4 manual routes are raw-model execution only (agent-sdk/agent-tool onboarding belongs to R5); failing closed')] }
    }
    if (src.availability !== undefined && src.availability !== 'discovered' && src.availability !== 'probe-required') {
      return { ok: false, errors: [err('route-not-verified', 'route.availability', 'routes become verified only through capability probes; save as discovered or probe-required first')] }
    }
    if (!findIn(eff.snapshot, 'providers', src.providerId)) {
      return { ok: false, errors: [err('unknown-reference', 'route.providerId', 'unknown provider: ' + String(src.providerId))] }
    }
    if (!findIn(eff.snapshot, 'models', src.logicalModelId)) {
      return { ok: false, errors: [err('unknown-reference', 'route.logicalModelId', 'unknown logical model: ' + String(src.logicalModelId))] }
    }
    if (src.connectionId !== undefined && src.connectionId !== null && !findIn(eff.snapshot, 'connections', src.connectionId)) {
      return { ok: false, errors: [err('unknown-reference', 'route.connectionId', 'unknown connection: ' + String(src.connectionId))] }
    }
    const provider = findIn(eff.snapshot, 'providers', src.providerId)
    const record = {
      schemaVersion: 1,
      id: src.id,
      providerId: src.providerId,
      logicalModelId: src.logicalModelId,
      remoteModelId: src.remoteModelId,
      accessType: src.accessType || 'api-key',
      connectionId: src.connectionId === undefined ? null : src.connectionId,
      executionKind: 'raw-model',
      reasoningLevels: src.reasoningLevels,
      compatibility: { transport: provider ? provider.transportId : 'unknown' },
      availability: src.availability || 'probe-required',
      enabled: src.enabled !== undefined ? src.enabled : true,
      provenance: 'operator-manual',
    }
    const conn = src.connectionId ? findIn(eff.snapshot, 'connections', src.connectionId) : null
    if (conn && conn.providerId !== src.providerId) {
      return { ok: false, errors: [err('connection-provider-mismatch', 'route.connectionId', 'connection ' + conn.id + ' belongs to provider ' + conn.providerId + ', not ' + src.providerId)] }
    }
    return catalog.saveRecord(dataRoot, 'routes', record, catalogOptions(eff.snapshot, opts))
  }

  // R4.3: credential references only. Initial status is never 'connected':
  // the operator transitions explicitly via setConnectionStatus (attested)
  // until the R5 authenticated credential boundary exists.
  function saveConnection(input, opts) {
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { ok: false, errors: eff.errors }
    const src = input || {}
    if (!findIn(eff.snapshot, 'providers', src.providerId)) {
      return { ok: false, errors: [err('unknown-reference', 'connection.providerId', 'unknown provider: ' + String(src.providerId))] }
    }
    if (src.status !== undefined && src.status !== 'not-connected' && src.status !== 'unknown') {
      return { ok: false, errors: [err('connection-invalid', 'connection.status', 'new connections start as not-connected (or unknown); transition to connected explicitly via attestation')] }
    }
    const record = {
      schemaVersion: 1,
      id: src.id,
      providerId: src.providerId,
      connectionKind: src.connectionKind || 'api-key',
      credentialRef: src.credentialRef,
      status: src.status || 'not-connected',
      provenance: 'operator-manual',
    }
    if (src.authMethod !== undefined) record.authMethod = src.authMethod
    return catalog.saveRecord(dataRoot, 'connections', record, catalogOptions(eff.snapshot, opts))
  }

  function setConnectionStatus(id, status, opts) {
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { ok: false, errors: eff.errors }
    const allowed = ['connected', 'not-connected', 'revoked', 'disabled', 'unknown']
    if (allowed.indexOf(status) === -1) {
      return { ok: false, errors: [err('connection-invalid', 'connection.status', 'status must be one of ' + allowed.join(', '))] }
    }
    if (status === 'connected' && !(opts && opts.attested === true)) {
      return { ok: false, errors: [err('connection-auth-required', 'connection.status', 'marking a connection connected requires explicit operator attestation (the host provides no authenticated credential-write boundary in R4; see R4.3 blocker)')] }
    }
    const current = findIn(eff.snapshot, 'connections', id)
    if (!current) return { ok: false, errors: [err('unknown-reference', 'connection.id', 'unknown connection: ' + String(id))] }
    const canonForConn = buildCanonical()
    const builtinConns = canonForConn.snapshot ? builtInIdsOf(canonForConn.snapshot).connections : []
    if (builtinConns.indexOf(id) !== -1) {
      return { ok: false, errors: [err('dependency-blocked', 'connection.' + id, 'built-in connections are immutable; create an operator connection for the custom provider instead')] }
    }
    const updated = JSON.parse(JSON.stringify(current))
    updated.status = status
    const saved = catalog.saveRecord(dataRoot, 'connections', updated, catalogOptions(eff.snapshot, opts))
    if (!saved.ok) return saved
    return { ok: true, revision: saved.revision, attested: status === 'connected' ? true : undefined }
  }

  function disableCatalogRecord(kind, id, opts) {
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { ok: false, errors: eff.errors }
    return catalog.disableRecord(dataRoot, kind, id, catalogOptions(eff.snapshot, opts))
  }

  function deleteCatalogRecord(kind, id, opts) {
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { ok: false, errors: eff.errors }
    const out = catalog.deleteRecord(dataRoot, kind, id, catalogOptions(eff.snapshot, opts))
    return out
  }

  function providerConnectionOf(effective, providerId, connectionId) {
    if (connectionId) return findIn(effective, 'connections', connectionId) || null
    for (const c of effective.connections || []) {
      if (c && c.providerId === providerId) return c
    }
    return null
  }

  // R4.1: probe option threading. fetchImpl/lookup/timeoutMs/signal are
  // injectable (tests use fakes; production uses the pinned transport +
  // node:dns). There is intentionally no test-only eligibility shortcut:
  // R4.2 removed skipStreaming, so every declared capability is checked on
  // the promotion path.
  // testBearer is accepted ONLY at this service layer (offline calls and
  // credential-gated tests) — the HTTP host boundary never forwards secret
  // values (see R4.3). endpointOptions carries the explicit trusted-local
  // policy without widening remote-provider access.
  function probeOptions(opts) {
    const o = opts || {}
    const out = {}
    if (o.fetchImpl) out.fetchImpl = o.fetchImpl
    if (o.lookup) out.lookup = o.lookup
    if (typeof o.timeoutMs === 'number') out.timeoutMs = o.timeoutMs
    if (o.signal) out.signal = o.signal
    if (o.endpointOptions && typeof o.endpointOptions === 'object') {
      out.endpointOptions = {
        trustedPrivateNetwork: o.endpointOptions.trustedPrivateNetwork === true,
        allowPrivateLocal: o.endpointOptions.allowPrivateLocal === true,
      }
    }
    return out
  }
  function connectionForProbes(connection, opts) {
    const bearer = opts && typeof opts.testBearer === 'string' && opts.testBearer !== '' ? opts.testBearer : null
    if (!connection) return bearer ? { testBearer: bearer } : null
    if (!bearer) return connection
    return Object.assign({}, connection, { testBearer: bearer })
  }

  // R4.4: explicit user-triggered probes. Server-side fetch carries NO
  // secret values (see R4.3 blocker); outcomes are honest reachability/auth
  // evidence. fetchImpl/timeoutMs are injectable for credential-gated tests.
  async function testProviderConnection(providerId, opts) {
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { ok: false, errors: eff.errors }
    const provider = findIn(eff.snapshot, 'providers', providerId)
    if (!provider) return { ok: false, errors: [err('unknown-reference', 'provider.id', 'unknown provider: ' + String(providerId))] }
    const connection = providerConnectionOf(eff.snapshot, providerId, opts && opts.connectionId)
    const fetchImpl = (opts && opts.fetchImpl) || null
    return probes.testConnection(provider, connectionForProbes(connection, opts), fetchImpl, probeOptions(opts))
  }

  async function discoverProviderModels(providerId, opts) {
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { ok: false, advertised: [], errors: eff.errors }
    const provider = findIn(eff.snapshot, 'providers', providerId)
    if (!provider) return { ok: false, advertised: [], errors: [err('unknown-reference', 'provider.id', 'unknown provider: ' + String(providerId))] }
    if (provider.status !== 'enabled') {
      return { ok: false, advertised: [], errors: [err('provider-disabled', 'provider.id', 'provider is not enabled: ' + providerId)] }
    }
    const connection = providerConnectionOf(eff.snapshot, providerId, opts && opts.connectionId)
    const fetchImpl = (opts && opts.fetchImpl) || null
    return probes.discoverModels(provider, connectionForProbes(connection, opts), fetchImpl, probeOptions(opts))
  }

  async function verifyProviderRoute(routeId, opts) {
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { ok: false, errors: eff.errors }
    const route = findIn(eff.snapshot, 'routes', routeId)
    if (!route) return { ok: false, errors: [err('unknown-reference', 'route.id', 'unknown route: ' + String(routeId))] }
    const canonForVerify = buildCanonical()
    const builtinRoutes = canonForVerify.snapshot ? builtInIdsOf(canonForVerify.snapshot).routes : []
    if (builtinRoutes.indexOf(routeId) !== -1) {
      return { ok: false, errors: [err('dependency-blocked', 'route.' + routeId, 'built-in routes keep their shipped verification state; verify operator routes instead')] }
    }
    const provider = findIn(eff.snapshot, 'providers', route.providerId)
    const model = findIn(eff.snapshot, 'models', route.logicalModelId)
    const connection = route.connectionId ? findIn(eff.snapshot, 'connections', route.connectionId) : null
    if (!provider || !model) {
      return { ok: false, errors: [err('unknown-reference', 'route', 'route references a missing provider or model')] }
    }
    const fetchImpl = (opts && opts.fetchImpl) || null
    const result = await probes.verifyRoute(provider, model, route, connectionForProbes(connection, opts), fetchImpl, probeOptions(opts))
    // Persist redacted evidence either way (history-preserving); promote to
    // verified ONLY when every required probe passed. A model-list response
    // alone never lands here (verifyRoute always runs the synthetic
    // round-trips).
    const failedEvidence = {
      kind: 'capability-verification',
      contractVersion: probes.PROBE_CONTRACT_VERSION,
      routeId, providerId: provider.id, transport: provider.transportId,
      checks: result.checks, verifiedAtUtc: new Date().toISOString(),
      levelsChecked: [], levelsVerified: [],
      fingerprint: probes.fingerprintOf(probes.fingerprintInputOf({ provider, model, route, connection, verifiedLevels: [] })),
      note: 'verification FAILED; route stays unverified', failed: true,
    }
    const toStore = result.evidence || failedEvidence
    const stored = catalog.saveEvidence(dataRoot, routeId, toStore, { fsHooks, nowUtc })
    if (!stored.ok) return { ok: false, checks: result.checks, errors: stored.errors }
    if (!result.ok) {
      // H3: a failed re-probe must not leave a previously verified operator
      // route eligible on its old availability field — demote the stored
      // record (history keeps the earlier pass for diagnostics).
      if (route.availability === 'verified') {
        const demoted = JSON.parse(JSON.stringify(route))
        demoted.availability = 'probe-required'
        const rolled = catalog.saveRecord(dataRoot, 'routes', demoted, catalogOptions(eff.snapshot, opts))
        if (!rolled.ok) return { ok: false, checks: result.checks, errors: result.errors.concat(rolled.errors) }
      }
      return { ok: false, checks: result.checks, errors: result.errors }
    }
    const updated = JSON.parse(JSON.stringify(route))
    updated.availability = 'verified'
    const saved = catalog.saveRecord(dataRoot, 'routes', updated, catalogOptions(eff.snapshot, opts))
    if (!saved.ok) return { ok: false, checks: result.checks, errors: saved.errors }
    return { ok: true, checks: result.checks, evidence: result.evidence, errors: [] }
  }

  function getRouteEvidence(routeId) {
    const loaded = catalog.loadEvidence(dataRoot, fsHooks)
    if (!loaded.evidence) return { evidence: null, attempts: [], errors: loaded.errors }
    const envelope = loaded.evidence[routeId]
    if (!envelope) return { evidence: null, attempts: [], errors: [] }
    return { evidence: catalog.currentEvidence(envelope), attempts: catalog.evidenceAttempts(envelope), errors: [] }
  }

  // R4.5: future runtime projection without executing anything.
  function projectRoute(routeId, runtime) {
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { ok: false, errors: eff.errors }
    const route = findIn(eff.snapshot, 'routes', routeId)
    if (!route) return { ok: false, errors: [err('unknown-reference', 'route.id', 'unknown route: ' + String(routeId))] }
    const provider = findIn(eff.snapshot, 'providers', route.providerId)
    if (!provider) return { ok: false, errors: [err('unknown-reference', 'route.providerId', 'unknown provider: ' + String(route.providerId))] }
    return runtimeProjection.prepareProjection(route, provider, runtime || null)
  }

  // R5: unified Connections surface (non-secret).
  // getConnections enriches every connection with billing source, execution
  // kinds and connect/disconnect guidance. checkConnection / discoverModels
  // run the native-lifecycle checks for the built-in subscription
  // connections (Codex OAuth, Claude CLI session); other ids fail closed
  // toward the R4 probe endpoints (credential-gated, offline only).

  function readOAuthBaseUrl() {
    try {
      const path = require('node:path')
      const fs = require('node:fs')
      const doc = JSON.parse(fs.readFileSync(path.join(String(installRoot), 'config', 'versions.json'), 'utf8'))
      if (doc && typeof doc.OAuthBaseUrl === 'string' && doc.OAuthBaseUrl !== '') return doc.OAuthBaseUrl
    } catch (e) {}
    return 'http://127.0.0.1:10531/v1'
  }

  function setBuiltInConnectionStatus(id, status, opts) {
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { ok: false, errors: eff.errors }
    if (OVERLAY_STATUSES.indexOf(status) === -1) {
      return { ok: false, errors: [err('connection-invalid', 'connection.status', 'status must be one of ' + OVERLAY_STATUSES.join(', '))] }
    }
    const canon = buildCanonical()
    const builtinConns = canon.snapshot ? builtInIdsOf(canon.snapshot).connections : []
    if (builtinConns.indexOf(id) === -1) {
      return { ok: false, errors: [err('unknown-reference', 'connection.' + String(id), 'built-in connection overlay applies to built-in connections only: ' + String(id))] }
    }
    const overlay = loadStatusOverlay()
    const next = Object.assign({}, overlay.statuses)
    next[id] = { status, updatedAtUtc: nowUtc(), provenance: (opts && opts.provenance) || 'operator-attested' }
    const written = writeStatusOverlay(next)
    if (!written.ok) return written
    return { ok: true, status }
  }

  function getConnections() {
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { connections: null, errors: eff.errors }
    const providersById = new Map(eff.snapshot.providers.map((x) => [x.id, x]))
    const routesByConn = new Map()
    for (const r of eff.snapshot.routes || []) {
      if (!r || !r.connectionId) continue
      if (!routesByConn.has(r.connectionId)) routesByConn.set(r.connectionId, [])
      routesByConn.get(r.connectionId).push(r.id)
    }
    const out = eff.snapshot.connections.map((c) => {
      const described = subscriptions.describeConnection(c.id)
      const provider = providersById.get(c.providerId) || null
      return {
        id: c.id,
        providerId: c.providerId,
        providerName: provider ? (provider.name || provider.id) : c.providerId,
        connectionKind: c.connectionKind,
        authMethod: c.authMethod || null,
        credentialRef: c.credentialRef || null,
        status: c.status,
        provenance: c.provenance || null,
        billingSource: described.billingSource,
        executionKinds: described.executionKinds,
        accountSource: described.accountSource,
        connectKind: described.connectKind,
        connectCommand: described.connectCommand,
        disconnectCommand: described.disconnectCommand,
        supportsCheck: described.supportsCheck,
        supportsDiscover: described.supportsDiscover,
        capabilitiesNote: described.capabilitiesNote,
        routes: routesByConn.get(c.id) || [],
      }
    })
    return { connections: out, errors: eff.errors }
  }

  async function checkConnection(id, opts) {
    const o = opts || {}
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { ok: false, errors: eff.errors }
    const conn = findIn(eff.snapshot, 'connections', id)
    if (!conn) return { ok: false, errors: [err('unknown-reference', 'connection.id', 'unknown connection: ' + String(id))] }
    const hooks = o.hooks || subscriptions.defaultHooks()
    if (id === subscriptions.CODEX_CONNECTION_ID) {
      const out = await subscriptions.checkCodexConnection({ hooks, userHome: o.userHome, env: o.env, oauthBaseUrl: o.oauthBaseUrl || readOAuthBaseUrl(), timeoutMs: o.timeoutMs, signal: o.signal })
      setBuiltInConnectionStatus(id, out.status, { provenance: 'live-check' })
      return out
    }
    if (id === subscriptions.CLAUDE_CONNECTION_ID) {
      const out = await subscriptions.checkClaudeConnection({ hooks, userHome: o.userHome, claudeBin: o.claudeBin, timeoutMs: o.timeoutMs, signal: o.signal })
      setBuiltInConnectionStatus(id, out.status, { provenance: 'live-check' })
      return out
    }
    return { ok: false, errors: [err('connection-check-unsupported', 'connection.' + String(id), 'live checks cover the native subscription connections (conn-sol-local, conn-claude-code-subscription); probe api-key providers through the Models and Providers endpoints with an explicit credential')] }
  }

  async function discoverConnectionModels(id, opts) {
    const o = opts || {}
    const eff = snapshotOrErrors()
    if (!eff.snapshot) return { ok: false, errors: eff.errors }
    const conn = findIn(eff.snapshot, 'connections', id)
    if (!conn) return { ok: false, errors: [err('unknown-reference', 'connection.id', 'unknown connection: ' + String(id))] }
    const hooks = o.hooks || subscriptions.defaultHooks()
    if (id === subscriptions.CODEX_CONNECTION_ID) {
      const checked = await subscriptions.checkCodexConnection({ hooks, userHome: o.userHome, env: o.env, oauthBaseUrl: o.oauthBaseUrl || readOAuthBaseUrl(), timeoutMs: o.timeoutMs, signal: o.signal })
      setBuiltInConnectionStatus(id, checked.status, { provenance: 'live-check' })
      return { ok: checked.ok, advertised: checked.detail.models, errors: checked.errors }
    }
    if (id === subscriptions.CLAUDE_CONNECTION_ID) {
      return subscriptions.discoverClaudeCapabilities({ hooks, claudeBin: o.claudeBin, timeoutMs: o.timeoutMs, signal: o.signal })
    }
    return { ok: false, errors: [err('connection-check-unsupported', 'connection.' + String(id), 'model discovery covers the native subscription connections; probe api-key providers through the Models and Providers endpoints with an explicit credential')] }
  }


  function enrichRoute(snapshot, route) {
    const models = new Map((snapshot.models || []).map((m) => [m && m.id, m]))
    const providers = new Map((snapshot.providers || []).map((p) => [p && p.id, p]))
    const connections = new Map((snapshot.connections || []).map((c) => [c && c.id, c]))
    const model = models.get(route.logicalModelId) || null
    const provider = providers.get(route.providerId) || null
    const connection = route.connectionId ? connections.get(route.connectionId) || null : null
    return {
      routeId: route.id,
      providerId: route.providerId,
      providerName: provider ? (provider.name || provider.id) : route.providerId,
      logicalModelId: route.logicalModelId,
      modelDisplayName: model ? (model.displayName || model.id) : route.logicalModelId,
      checkpoint: model ? model.checkpoint : null,
      reasoningLevels: (route.reasoningLevels || []).slice(),
      availability: route.availability,
      enabled: route.enabled !== false,
      connectionId: route.connectionId || null,
      connectionStatus: connection ? connection.status : 'missing',
      connectionKind: connection ? connection.connectionKind : null,
      dataUseTier: model ? model.dataUseTier || null : null,
      contextWindow: model && model.contextWindow !== undefined ? { value: model.contextWindow, provenance: model.capacityProvenance || 'declared' } : { value: null, provenance: 'unknown' },
      maxOutputTokens: model && model.maxOutputTokens !== undefined ? { value: model.maxOutputTokens, provenance: model.capacityProvenance || 'declared' } : { value: null, provenance: 'unknown' },
      capabilities: model ? Object.assign({}, model.capabilities) : {},
      remoteModelId: route.remoteModelId,
      executionKind: route.executionKind,
      accessType: route.accessType,
      transport: (route.compatibility && route.compatibility.transport) || 'unknown',
    }
  }

  function listEligible(modeId, slotId) {
    const built = snapshotOrErrors()
    if (!built.snapshot) return { routes: [], errors: built.errors }
    const mode = modeById(built.snapshot, modeId)
    if (!mode) return { routes: [], errors: [err('unknown-mode', 'modeId', 'unknown mode: ' + modeId)] }
    if (!mode.slots.some((s) => s && s.id === slotId)) return { routes: [], errors: [err('unknown-slot', 'slotId', 'slot ' + slotId + ' is not declared by mode ' + modeId)] }
    const routes = resolver.listEligibleRoutes(modeId, slotId, built.snapshot)
    return { routes: routes.map((r) => enrichRoute(built.snapshot, r)), errors: [] }
  }

  function listIneligible(modeId, slotId) {
    // Explain every non-eligible route for the slot: same iteration the
    // resolver performs, first failing gate reported as the reason.
    const built = snapshotOrErrors()
    if (!built.snapshot) return { routes: [], errors: built.errors }
    const mode = modeById(built.snapshot, modeId)
    if (!mode) return { routes: [], errors: [err('unknown-mode', 'modeId', 'unknown mode: ' + modeId)] }
    const slot = mode.slots.find((s) => s && s.id === slotId)
    if (!slot) return { routes: [], errors: [err('unknown-slot', 'slotId', 'slot ' + slotId + ' is not declared by mode ' + modeId)] }
    const eligibleIds = new Set(resolver.listEligibleRoutes(modeId, slotId, built.snapshot).map((r) => r.id))
    const out = []
    for (const route of built.snapshot.routes || []) {
      if (!route || eligibleIds.has(route.id)) continue
      const models = new Map((built.snapshot.models || []).map((m) => [m && m.id, m]))
      const model = models.get(route.logicalModelId) || null
      let reason = null
      const gate = resolver.routeEligibility(route)
      if (gate) reason = gate.code + ': ' + gate.message
      else if (!model || model.enabled === false) reason = 'model-disabled: logical model ' + route.logicalModelId + ' is disabled or missing'
      if (!reason) {
        // Capability/engine/connection gates share the resolver verdict; mark
        // the route unavailable for this slot without inventing a new code.
        reason = 'slot-ineligible: route ' + route.id + ' does not satisfy slot ' + slotId + ' requirements'
      }
      out.push(Object.assign(enrichRoute(built.snapshot, route), { ineligibleReason: reason }))
    }
    return { routes: out, errors: [] }
  }

  function validate(config) {
    const built = snapshotOrErrors()
    if (!built.snapshot) return { errors: built.errors }
    return { errors: resolver.validateModeConfig(config, built.snapshot) }
  }

  function compilePreview(config) {
    const built = snapshotOrErrors()
    if (!built.snapshot) return { ok: false, errors: built.errors }
    const result = resolver.compileModeConfig(config, built.snapshot)
    if (!result.ok) return result
    // Snapshots are non-secret by construction (opaque connection ids only);
    // assert before returning so a future field can never leak credentials.
    const probe = JSON.stringify(result.snapshot)
    if (/sk-(live|proj)-|xox[bap]-|ghp_|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(probe)) {
      return { ok: false, errors: [err('secret-material-rejected', 'resolved', 'compiled preview contains secret-shaped material and is withheld')] }
    }
    return result
  }

  function save(modeId, config, expectedRevision, opts) {
    if (SUPPORTED_MODES.indexOf(modeId) === -1) {
      return { ok: false, errors: [err('unknown-mode', 'modeId', 'unknown mode: ' + modeId)] }
    }
    if (!config || config.modeId !== modeId) {
      return { ok: false, errors: [err('mode-mismatch', 'modeConfiguration.modeId', 'config modeId does not match target mode ' + modeId)] }
    }
    const compiled = compilePreview(config)
    if (!compiled.ok) return { ok: false, errors: compiled.errors }
    const stored = configStore.saveModeConfig(dataRoot, modeId, config, expectedRevision, {
      fsHooks,
      nowUtc,
      source: (opts && opts.source) || 'operator-save',
      adoptedFrom: opts && Object.prototype.hasOwnProperty.call(opts, 'adoptedFrom') ? opts.adoptedFrom : null,
    })
    if (!stored.ok) return stored
    return { ok: true, revision: stored.revision, resolutionId: compiled.snapshot.resolutionId }
  }

  return {
    schemaVersion: SERVICE_SCHEMA_VERSION,
    installRoot,
    dataRoot,
    listModes,
    getModeConfiguration,
    listEligible,
    listIneligible,
    validate,
    compilePreview,
    save,
    buildCanonical,
    effectiveSnapshot,
    getCatalog,
    saveProvider,
    saveModel,
    saveRoute,
    saveConnection,
    setConnectionStatus,
    disableCatalogRecord,
    deleteCatalogRecord,
    testProviderConnection,
    discoverProviderModels,
    verifyProviderRoute,
    getRouteEvidence,
    projectRoute,
    getConnections,
    checkConnection,
    discoverConnectionModels,
    setBuiltInConnectionStatus,
  }
}

module.exports = { createService, SUPPORTED_MODES, DEFAULT_ADOPT_PROFILE, ADOPTABLE_PROFILES }
