#!/usr/bin/env node
'use strict';
// A5.4: BILLABLE Registry route verification for the OpenCode Go native route.
// Sends exactly: 1 GET models, then 4 POST responses (text, stream, synthetic
// tool emission, tool-result continuation). The Registry role muse_main requires
// toolCalling, so the route must prove it; the native acceptance run itself
// sends NO tools. Refuses to touch
// the network without a single-use operator authorization record.
//
//   authorize: node scripts/Verify-NativeOpenCodeGoRoute.cjs authorize --data-root D --acknowledge-billable [--expires-in-secs 900] [--adaptive]
//   verify:    node scripts/Verify-NativeOpenCodeGoRoute.cjs verify --data-root D --credentials FILE [--adaptive [--save-adaptive-config]]
//
// `--adaptive` (S10): verifies the separate Nexus Adaptive route instead (same provider, same five requests).
// The record names the route, so a record for one route cannot verify the other. Verification never saves
// an operator configuration by itself: `--save-adaptive-config` is the explicit, authorized save.
//
// The credential file is the same issuer-owned 0600 JSON the executor uses
// ({ "<credentialRef>": "<key>" }); the key is read only here, only after the
// authorization record is consumed, and is never printed.
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const ROUTE_ID = 'opencode-go-native/muse';
const ADAPTIVE_ROUTE_ID = 'opencode-go-native/muse-adaptive';
const routeOf = (argv) => (argv.includes('--adaptive') ? ADAPTIVE_ROUTE_ID : ROUTE_ID);
// The Registry probes EVERY declared reasoning level with one text request, so a route declaring four
// levels costs 1 GET + 4 text + stream + tool + continuation = 8 requests. The authorization record states
// the exact list, per route, so what is authorized equals what is sent.
const ADAPTIVE_LEVELS = ['low', 'medium', 'high', 'xhigh'];
function expectedFor(routeId) {
  if (routeId !== ADAPTIVE_ROUTE_ID) return EXPECTED;
  const post = 'POST https://opencode.ai/inference/go/openai/v1/responses';
  return [
    EXPECTED[0],
    ...ADAPTIVE_LEVELS.map((l) => post + '  text probe, reasoning.effort=' + l + ', max_output_tokens=4096'),
    post + '  same body + stream=true',
    post + '  synthetic tool probe (probe_echo), max_output_tokens=4096',
    post + '  stateless tool-result continuation, max_output_tokens=4096',
  ];
}
const PROVIDER_ID = 'opencode-go-native';
const CRED_REF = 'credential://connections/conn-opencode-go-native';
const EXPECTED = [
  'GET  https://opencode.ai/inference/go/v1/models   (authorization, x-opencode-session)',
  'POST https://opencode.ai/inference/go/openai/v1/responses  text probe, reasoning.effort=low, max_output_tokens=4096',
  'POST https://opencode.ai/inference/go/openai/v1/responses  same body + stream=true',
  'POST https://opencode.ai/inference/go/openai/v1/responses  synthetic tool probe (probe_echo), max_output_tokens=4096',
  'POST https://opencode.ai/inference/go/openai/v1/responses  stateless tool-result continuation, max_output_tokens=4096',
];
const RECORD = 'route-verification-authorization.json';

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

function authorize(argv, log) {
  const root = arg(argv, '--data-root');
  if (!root) { log('--data-root is required'); return 2; }
  const expected = expectedFor(routeOf(argv));
  if (!argv.includes('--acknowledge-billable')) { log('--acknowledge-billable is required: this sends ' + expected.length + ' billable requests'); return 2; }
  const ttl = Number(arg(argv, '--expires-in-secs') || 900);
  if (!(ttl > 0 && ttl <= 3600)) { log('--expires-in-secs must be 1..3600'); return 2; }
  const rec = { providerId: PROVIDER_ID, routeId: routeOf(argv), maxRequests: expected.length, expected, expiresAtMs: Date.now() + ttl * 1000 };
  try {
    fs.writeFileSync(path.join(path.resolve(root), RECORD), JSON.stringify(rec, null, 2), { flag: 'wx', mode: 0o600 });
  } catch (e) { log('cannot create authorization record: ' + e.code); return 1; }
  log('authorized ONE route verification (' + expected.length + ' requests):');
  expected.forEach((l) => log('  ' + l));
  return 0;
}

function consume(root, routeId = ROUTE_ID) {
  const file = path.join(path.resolve(root), RECORD);
  let st;
  try { st = fs.lstatSync(file); } catch { return { ok: false, why: 'no route-verification authorization record' }; }
  if (!st.isFile() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid()) return { ok: false, why: 'authorization record is not a private file owned by this user' };
  const used = file.replace(/\.json$/, '.consumed-' + Date.now() + '.json');
  try { fs.renameSync(file, used); } catch { return { ok: false, why: 'authorization record was consumed concurrently' }; }
  let rec;
  try { rec = JSON.parse(fs.readFileSync(used, 'utf8')); } catch { return { ok: false, why: 'authorization record is malformed' }; }
  if (rec.providerId !== PROVIDER_ID || rec.routeId !== routeId || rec.maxRequests !== expectedFor(routeId).length) return { ok: false, why: 'authorization names a different provider/route/budget' };
  if (!(Date.now() <= rec.expiresAtMs)) return { ok: false, why: 'authorization expired' };
  return { ok: true };
}

async function verify(argv, log, hooks) {
  const root = arg(argv, '--data-root');
  const credFile = arg(argv, '--credentials');
  if (!root || !credFile) { log('--data-root and --credentials are required'); return 2; }
  const routeId = routeOf(argv);
  const auth = consume(root, routeId);
  if (!auth.ok) { log('REFUSED, nothing sent: ' + auth.why); return 3; }
  let bearer;
  try {
    const st = fs.statSync(credFile);
    if ((st.mode & 0o077) !== 0 || st.uid !== process.getuid()) throw new Error('mode/owner');
    bearer = JSON.parse(fs.readFileSync(credFile, 'utf8'))[CRED_REF];
    if (typeof bearer !== 'string' || bearer === '') throw new Error('missing');
  } catch { log('REFUSED, nothing sent: credential file is not a private file holding ' + CRED_REF); return 3; }
  const svc = require(path.join(REPO, 'config', 'registry', 'service.cjs')).createService({ installRoot: REPO, dataRoot: path.resolve(root) });
  // Safe pre-flight diagnostics (never a value): which store the key came from, which reference was
  // selected, and whether an Authorization header WILL be attached.
  log('credential_present=true credential_selected=' + CRED_REF + ' credentials_file=' + (path.basename(credFile) === credFile ? credFile : path.basename(path.dirname(credFile)) + '/' + path.basename(credFile)) + ' authorization_header_present=true (attached to every probe; value never printed)');
  // The connection status is part of the verification fingerprint, so the
  // operator attestation (authorization record consumed, credential present)
  // is applied BEFORE probing. If the probes fail it is restored to what it WAS (S10-A fix): the old code
  // forced 'not-connected', which invalidated every route already verified on this connection.
  const priorConn = (svc.effectiveSnapshot().snapshot.connections || []).find((c) => c.id === 'conn-opencode-go-native');
  const priorStatus = priorConn && typeof priorConn.status === 'string' ? priorConn.status : 'not-connected';
  const restorePrior = () => svc.setConnectionStatus('conn-opencode-go-native', priorStatus, priorStatus === 'connected' ? { attested: true } : {});
  const pre = svc.setConnectionStatus('conn-opencode-go-native', 'connected', { attested: true });
  if (!pre.ok) { log('connection attestation refused: ' + JSON.stringify((pre.errors || []).map((e) => e.code))); return 1; }
  const r = await svc.verifyProviderRoute(routeId, Object.assign({ testBearer: bearer }, (hooks && hooks.opts) || {}));
  (r.checks || []).forEach((c) => log((c.ok ? 'PASS ' : 'FAIL ') + c.name + ' - ' + c.detail));
  if (!r.ok) { restorePrior(); log('route NOT verified: ' + JSON.stringify((r.errors || []).map((e) => e.code))); return 1; }
  log('route verified');
  if (routeId === ADAPTIVE_ROUTE_ID) {
    if (!argv.includes('--save-adaptive-config')) { log('adaptive route verified; no ModeConfiguration was saved (pass --save-adaptive-config to save it explicitly)'); return 0; }
    const fresh = require(path.join(REPO, 'config', 'registry', 'service.cjs')).createService({ installRoot: REPO, dataRoot: path.resolve(root) });
    const cfg = { schemaVersion: 1, modeId: 'engineering-v2-adaptive', revision: 0, slots: { main: { logicalModelId: 'meta/muse-spark-1.3-contributor-adaptive', routeId: ADAPTIVE_ROUTE_ID, reasoning: 'low', allowedReasoning: ['low', 'medium', 'high', 'xhigh'] } }, roleOverrides: {} };
    const have = fresh.getModeConfiguration('engineering-v2-adaptive', {});
    const m = fresh.save('engineering-v2-adaptive', cfg, have && have.result && have.result.persisted ? have.result.config.revision : undefined, {});
    if (!m.ok) { log('adaptive mode binding refused: ' + JSON.stringify((m.errors || []).map((e) => e.code + ':' + e.message))); return 1; }
    log('engineering-v2-adaptive bound to ' + ADAPTIVE_ROUTE_ID + ' (default low; authorized low, medium, high, xhigh)');
    return 0;
  }
  // Local, no network: bind the engineering-v2 mode in THIS isolated data root.
  const fresh = require(path.join(REPO, 'config', 'registry', 'service.cjs')).createService({ installRoot: REPO, dataRoot: path.resolve(root) });
  const m = fresh.save('engineering-v2', { schemaVersion: 1, modeId: 'engineering-v2', revision: 0, slots: { main: { logicalModelId: 'meta/muse-spark-1.3-contributor-native', routeId: ROUTE_ID, reasoning: 'low' } }, roleOverrides: {} }, null, {});
  if (!m.ok) { log('mode binding refused: ' + JSON.stringify((m.errors || []).map((e) => e.code + ':' + e.message))); return 1; }
  log('engineering-v2 bound to ' + ROUTE_ID);
  return 0;
}

module.exports = { EXPECTED, ADAPTIVE_ROUTE_ID, authorize, consume, verify };
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const log = console.log;
  if (cmd === 'authorize') process.exit(authorize(rest, log));
  else if (cmd === 'verify') verify(rest, log).then((c) => process.exit(c));
  else { log('usage: authorize|verify (see header)'); process.exit(2); }
}
