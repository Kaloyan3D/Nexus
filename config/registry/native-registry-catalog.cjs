'use strict';
/**
 * R-NATIVE-1 registry-native adapter: read-only catalog over the
 * authoritative Registry. No new authority, no catalog data copied into
 * Rust, no credential values/refs/paths ever emitted.
 */
const v2 = require('./native-target-v2.cjs');

function isStr(v) { return typeof v === 'string' && v !== ''; }

function listRegistryTargets(service) {
  let eff = null;
  try {
    eff = service.effectiveSnapshot();
  } catch (e) {
    return { ok: false, code: 'registry-unavailable', message: 'effective snapshot is unreadable', targets: null };
  }
  if (!eff || !eff.snapshot) {
    return { ok: false, code: 'registry-unresolved', message: 'effective snapshot is unresolved', targets: null };
  }
  const snap = eff.snapshot;
  const byId = (list) => {
    const m = new Map();
    for (const e of list || []) if (e && typeof e.id === 'string') m.set(e.id, e);
    return m;
  };
  const providers = byId(snap.providers);
  const models = byId(snap.models);
  const connections = byId(snap.connections);
  const targets = [];
  const routes = (snap.routes || []).slice().sort((a, b) => (String(a && a.id) < String(b && b.id) ? -1 : 1));
  for (const route of routes) {
    if (!route || typeof route.id !== 'string') continue;
    const model = models.get(route.logicalModelId) || null;
    const provider = providers.get(route.providerId) || null;
    const connection = route.connectionId ? (connections.get(route.connectionId) || null) : null;
    const gate = v2.catalogIssuability({ route, model, provider, connection });
    const routeMax = route.capacityConstraints && route.capacityConstraints.maxOutputTokens;
    const output = v2.positiveInt(routeMax) || (model ? v2.positiveInt(model.maxOutputTokens) : 0);
    targets.push({
      providerId: route.providerId || '',
      logicalModelId: route.logicalModelId || '',
      remoteModelId: route.remoteModelId || '',
      routeId: route.id,
      connectionId: route.connectionId || null,
      connectionStatus: connection ? (connection.status || 'unknown') : 'missing',
      protocol: (route.compatibility && route.compatibility.transport) || 'unknown',
      contextLimitTokens: model ? v2.positiveInt(model.contextWindow) : 0,
      outputLimitTokens: output,
      billingTier: (provider && connection) ? v2.billingTierOf(provider, connection) : (provider ? v2.billingTierOf(provider, null) : ''),
      dataUse: (model && typeof model.dataUseTier === 'string') ? model.dataUseTier : null,
      issuable: gate.issuable === true,
      reason: gate.issuable === true ? null : (gate.reason || 'not-issuable'),
    });
  }
  return { ok: true, code: null, message: null, targets: targets };
}

function findSelection(targets, sel) {
  if (!sel || typeof sel !== 'object') return null;
  if (!isStr(sel.logicalModelId) || !isStr(sel.routeId)) return null;
  for (const t of targets) {
    if (t && t.logicalModelId === sel.logicalModelId && t.routeId === sel.routeId) return t;
  }
  return null;
}

module.exports = {
  listRegistryTargets: listRegistryTargets,
  findSelection: findSelection,
};
