'use strict';
// Generates cross-language canonicalization vectors from the REAL JS resolver.
// Run: node scripts/gen-canonical-vectors.cjs
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const resolver = require('../config/registry/resolver.cjs');
const outPath = path.join(__dirname, '..', 'native', 'test-vectors', 'canonical-vectors.json');
function entry(name, input) {
  const canonical = resolver.canonicalize(input);
  const sha256 = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return { name, input, canonical, sha256 };
}
const vectors = [
  entry('empty-object', {}),
  entry('sorted-keys', { b: 1, a: [3, 2, { y: 'q', x: 1 }], c: { d2: 1, d1: 2 } }),
  entry('scalars', { n: null, t: true, f: false, i: -2, fl: 1.5, s: 'x', empty: '' }),
  entry('unicode-escapes', { s: 'hllo "q" backslash: \\ newline:\n ctrl:\u0001' }),
  entry('intent-digest-fields', { taskInstanceId: 't-1', attemptId: 'a-1', commandId: 'c-1', backend: 'native', controllerRevision: 1, role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: 3, payloadDigest: 'ab'.repeat(32) }),
  entry('command-digest-fields', { intentDigest: 'aa'.repeat(32), leaseEpoch: 7, snapshotDigest: 'bb'.repeat(32), storeIncarnation: 'incarn-1', targetDigest: 'cc'.repeat(32) }),
  entry('realistic-target', { accessType: 'managed', connectionId: 'conn-1', dataUseTier: 'contributor', executionKind: 'raw-model', logicalModelId: 'model-1', modeConfigRevision: 3, modeId: 'engineering-v2', orchestrationEngineId: 'muse', protocolId: 'https', providerId: 'prov-1', reasoning: 'low', remoteModelId: 'rm-1', requiredCapabilities: ['toolCalling'], resolutionId: 'compat', roleId: 'muse_main', routeId: 'route-1', schemaVersion: 1, slotRequirements: { toolCalling: true } }),
  entry('nested-arrays', { roles: ['b', 'a'], matrix: [[2, 1], [0, null]] }),
];
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(vectors, null, 2) + '\n');
console.log('wrote ' + vectors.length + ' vectors to ' + outPath);