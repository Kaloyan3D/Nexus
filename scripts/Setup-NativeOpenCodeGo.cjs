#!/usr/bin/env node
'use strict';
// A5.4: declare the OpenCode Go provider for the Nexus Native pilot in an
// ISOLATED Registry data root. Offline only: it writes operator records and
// performs no network call, no probe and no credential read. It never saves
// a mode binding: route verification (probes) is a billable live action that
// needs its own explicit operator authorization, so the route is left
// `probe-required` and the mode stays unbound until that happens.
//
//   node scripts/Setup-NativeOpenCodeGo.cjs --data-root DIR            # dry run
//   node scripts/Setup-NativeOpenCodeGo.cjs --data-root DIR --apply    # write records
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const PLAN = {
  provider: {
    id: 'opencode-go-native',
    name: 'OpenCode Go (native pilot)',
    transportId: 'openai-responses',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    authType: 'api-key',
    metadata: { billingTier: 'opencode-go-plan', wireProfile: 'opencode-go-responses' },
  },
  model: {
    id: 'meta/muse-spark-1.3-contributor-native', vendor: 'Meta', displayName: 'Muse Spark 1.3 Contributor',
    checkpoint: 'muse-spark-1.3-contributor',
    capabilities: { textInput: true, imageInput: false, toolCalling: true, streaming: true, reasoning: true },
    dataUseTier: 'contributor', contextWindow: 1048576, maxOutputTokens: 131072, enabled: true, engines: ['muse-v0'],
  },
  connection: {
    id: 'conn-opencode-go-native', providerId: 'opencode-go-native', connectionKind: 'api-key',
    authMethod: 'api-key (operator credential file)',
    credentialRef: 'credential://connections/conn-opencode-go-native', status: 'not-connected',
  },
  route: {
    id: 'opencode-go-native/muse', providerId: 'opencode-go-native',
    logicalModelId: 'meta/muse-spark-1.3-contributor-native', remoteModelId: 'muse-spark-1.3-contributor',
    connectionId: 'conn-opencode-go-native', reasoningLevels: ['low'], availability: 'probe-required',
    executionKind: 'raw-model', accessType: 'api-key', compatibility: { transport: 'openai-responses' },
  },
  // S10-A/B: the explicit first-party onboarding of Nexus Adaptive (`--adaptive`). A DISTINCT model identity
  // scoped ONLY to `nexus-adaptive-v1` (the historical Muse Spark entries stay scoped to `muse-v0`), on the
  // same provider/connection/remote model/transport, with the effort ladder the adaptive contract allows.
  // Saved `probe-required`: it becomes usable only through the real route verification.
  adaptiveModel: {
    id: 'meta/muse-spark-1.3-contributor-adaptive', vendor: 'Meta', displayName: 'Muse Spark 1.3 Contributor (Nexus Adaptive)',
    checkpoint: 'muse-spark-1.3-contributor',
    capabilities: { textInput: true, imageInput: false, toolCalling: true, streaming: true, reasoning: true },
    dataUseTier: 'contributor', contextWindow: 1048576, maxOutputTokens: 131072, enabled: true, engines: ['nexus-adaptive-v1'],
  },
  adaptiveRoute: {
    id: 'opencode-go-native/muse-adaptive', providerId: 'opencode-go-native',
    logicalModelId: 'meta/muse-spark-1.3-contributor-adaptive', remoteModelId: 'muse-spark-1.3-contributor',
    connectionId: 'conn-opencode-go-native', reasoningLevels: ['low', 'medium', 'high', 'xhigh'], availability: 'probe-required',
    executionKind: 'raw-model', accessType: 'api-key', compatibility: { transport: 'openai-responses' },
  },
};

function run(argv, out) {
  const log = out || console.log;
  const at = argv.indexOf('--data-root');
  const dataRoot = at >= 0 ? argv[at + 1] : '';
  const apply = argv.includes('--apply');
  if (!dataRoot) { log('--data-root is required (use an isolated dev instance, never production-v1)'); return 2; }
  log('plan: provider ' + PLAN.provider.id + ' -> ' + PLAN.provider.baseUrl + ' (wireProfile ' + PLAN.provider.metadata.wireProfile + ')');
  log('      model ' + PLAN.route.remoteModelId + ', credentialRef ' + PLAN.connection.credentialRef + ' (value never read)');
  log('      route left probe-required; no mode binding; no network' + (argv.includes('--adaptive') ? '; + adaptive model/route (' + PLAN.adaptiveRoute.id + ', scoped to nexus-adaptive-v1)' : ''));
  if (!apply) { log('dry run: nothing written (pass --apply)'); return 0; }
  const svc = require(path.join(REPO, 'config', 'registry', 'service.cjs')).createService({ installRoot: REPO, dataRoot: path.resolve(dataRoot) });
  const adaptive = argv.includes('--adaptive');
  const steps = [['provider', 'saveProvider'], ['model', 'saveModel'], ['connection', 'saveConnection'], ['route', 'saveRoute']];
  if (adaptive) steps.push(['adaptiveModel', 'saveModel'], ['adaptiveRoute', 'saveRoute']);
  const present = (key) => {
    // idempotent: an identical record that already exists is left alone (no duplicate, no new revision)
    const snap = svc.effectiveSnapshot().snapshot;
    const doc = PLAN[key];
    const coll = { provider: snap.providers, model: snap.models, connection: snap.connections, route: snap.routes, adaptiveModel: snap.models, adaptiveRoute: snap.routes }[key];
    return (coll || []).some((x) => x.id === doc.id);
  };
  for (const [key, fn] of steps) {
    if (present(key)) { log(key + ' already present (left unchanged)'); continue; }
    const r = svc[fn](PLAN[key], {});
    if (!r.ok) { log(key + ' refused: ' + JSON.stringify(r.errors || []).slice(0, 300)); return 1; }
    log(key + ' saved');
  }
  return 0;
}

module.exports = { PLAN, run };
if (require.main === module) process.exit(run(process.argv.slice(2)));
