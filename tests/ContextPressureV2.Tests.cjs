/**
 * ContextPressureV2.Tests.cjs - CCV2-A08 ContextPressureV2 proof.
 *
 * Proves against the REAL production module (no fakes):
 * config/ContextPressureV2.cjs is the sole V2 pressure authority.
 * Covers the required unit pressure matrix, grounded provider capacity,
 * honest cost accounting, frozen thresholds, UNKNOWN honesty, determinism,
 * closed-world validation, and inert-content security.
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const pressure = require(path.join(repoRoot, 'config', 'ContextPressureV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(t) { console.log(''); console.log('--- ' + t + ' ---'); }
function throwsWith(fn, frag, name) {
  let e = null;
  try { fn(); } catch (err) { e = err; }
  check(e !== null && String(e && e.message).indexOf(frag) !== -1, name, e ? String(e.message).slice(0, 240) : 'did not throw');
}
function codes(d) { return d.blockers.map((b) => b.code); }
const clone = (o) => JSON.parse(JSON.stringify(o));
const D64 = 'a'.repeat(64);
function baseInput(over) {
  const i = { schemaVersion: 1, providerModelId: 'deepseek-v4-flash', providerCapacityTokens: 131072, currentContextTokens: 10000, costMethod: 'conservative-estimate', costExact: false, reservedOutputTokens: null, reservedProtocolTokens: null, reservedSafetyTokens: null, taskId: 'TASK-A08', taskInstanceId: 'task_a08_0001', sessionId: 'sess-a08', generation: 1, snapshotTokenId: 'cst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', revisionDigest: D64 };
  if (over) { for (const k of Object.keys(over)) i[k] = over[k]; }
  return i;
}
const USABLE = 131072 - 8192 - 4096 - 4096;
section('PROVIDER CAPACITY IS GROUNDED, NEVER INVENTED');
const capKnown = pressure.resolveProviderCapacity('deepseek-v4-flash');
check(capKnown.known === true && capKnown.capacityTokens === 131072, 'registry model resolves to declared contextWindow');
const capKnown2 = pressure.resolveProviderCapacity('muse-spark-1.3-contributor');
check(capKnown2.known === true && capKnown2.capacityTokens === 1048576, 'second registry model resolves to declared window');
const capUnknown = pressure.resolveProviderCapacity('no-such-model-xyz');
check(capUnknown.known === false && capUnknown.capacityTokens === null, 'unknown model yields unknown, never a guessed window');
check(pressure.loadModelRegistry() !== null, 'registry loads from the grounded file');
section('REQUIRED UNIT PRESSURE MATRIX');
const dNormal = pressure.measurePressureV2(baseInput({ currentContextTokens: 10000 }));
check(dNormal.known === true && dNormal.level === 'NORMAL', 'large headroom yields NORMAL');
check(dNormal.recommendation === 'none', 'NORMAL recommends none');
check(dNormal.usableCapacityTokens === USABLE, 'usable subtracts all three reserves');
check(dNormal.remainingHeadroomTokens === USABLE - 10000, 'headroom is usable minus current');
check(dNormal.thresholdPolicyId === 'nexus/context-pressure-policy/v1', 'threshold policy is bound');
const dElev = pressure.measurePressureV2(baseInput({ currentContextTokens: Math.ceil(0.70 * USABLE) }));
check(dElev.level === 'ELEVATED' && dElev.recommendation === 'prepare', '70pct used yields ELEVATED prepare');
const dHigh = pressure.measurePressureV2(baseInput({ currentContextTokens: Math.ceil(0.85 * USABLE) }));
check(dHigh.level === 'HIGH' && dHigh.recommendation === 'compact-when-safe', '85pct used yields HIGH compact-when-safe');
const dCrit = pressure.measurePressureV2(baseInput({ currentContextTokens: Math.ceil(0.95 * USABLE) }));
check(dCrit.level === 'CRITICAL' && dCrit.recommendation === 'compact-required', '95pct used yields CRITICAL compact-required');
const dOver = pressure.measurePressureV2(baseInput({ currentContextTokens: USABLE + 5000 }));
check(dOver.level === 'CRITICAL' && dOver.known === true, 'over-usable observation is CRITICAL');
check(dOver.remainingHeadroomTokens < 0, 'over-usable headroom goes negative honestly');
const dUnk = pressure.measurePressureV2(baseInput({ providerModelId: 'no-such-model', providerCapacityTokens: null }));
check(dUnk.known === false && dUnk.level === 'UNKNOWN', 'unknown capacity is UNKNOWN');
check(dUnk.recommendation === 'blocked', 'UNKNOWN recommends blocked');
check(codes(dUnk).indexOf('pressure-capacity-unknown') !== -1, 'UNKNOWN carries pressure-capacity-unknown');
check(dUnk.usableCapacityTokens === null && dUnk.remainingHeadroomTokens === null, 'UNKNOWN claims no token numbers');
const dInv = pressure.measurePressureV2(baseInput({ providerCapacityTokens: 10000 }));
check(dInv.known === false && dInv.level === 'UNKNOWN', 'reserves-consuming-window fails closed');
check(codes(dInv).indexOf('pressure-accounting-invalid') !== -1, 'invalid accounting carries pressure-accounting-invalid');
const dSmall = pressure.measurePressureV2(baseInput({ currentContextTokens: 10000 }));
const dBig = pressure.measurePressureV2(baseInput({ currentContextTokens: 10000, reservedOutputTokens: 32768 }));
check(dBig.usableCapacityTokens < dSmall.usableCapacityTokens, 'reserved output reduces usable capacity');
check(dBig.remainingHeadroomTokens < dSmall.remainingHeadroomTokens, 'reserved output reduces headroom');
const rank = { NORMAL: 0, ELEVATED: 1, HIGH: 2, CRITICAL: 3 };
let mono = true;
let prev = -1;
for (let t = 0; t <= USABLE + 1000; t += 1000) { const dd = pressure.measurePressureV2(baseInput({ currentContextTokens: t })); if (rank[dd.level] < prev) mono = false; prev = rank[dd.level]; }
check(mono, 'larger active context monotonically increases or holds pressure');
section('THRESHOLDS ARE CENTRALIZED AND FROZEN');
check(pressure.THRESHOLD_POLICY_V1.elevatedEnter === 0.70, 'elevated enter frozen at 0.70');
check(pressure.THRESHOLD_POLICY_V1.highEnter === 0.85, 'high enter frozen at 0.85');
check(pressure.THRESHOLD_POLICY_V1.criticalEnter === 0.95, 'critical enter frozen at 0.95');
check(pressure.THRESHOLD_POLICY_V1.minimumReclaimTokens === 2048, 'minimum reclaim frozen at 2048');
check(pressure.levelForUsedFraction(0.10) === 'NORMAL', 'level derives only from headroom fraction');
check(pressure.levelForUsedFraction(0.949) === 'HIGH', 'just below critical stays HIGH');
check(pressure.levelForUsedFraction(0.95) === 'CRITICAL', 'critical edge is exact');
check(pressure.recommendationForLevel('UNKNOWN') === 'blocked', 'UNKNOWN maps to blocked');
section('CONTEXT-COST ACCOUNTING IS HONEST');
const est = pressure.estimateTokensForText('hello world');
check(est.method === 'conservative-estimate' && est.exact === false, 'text estimator records method and inexactness');
check(est.tokens === Math.ceil(Buffer.byteLength('hello world', 'utf8') / 4), 'estimator is ceil bytes over 4');
const eev = pressure.estimateTokensForEvents([{ seq: 0, type: 'user/message', data: {} }]);
check(eev.method === 'conservative-estimate' && eev.exact === false && eev.tokens > 0, 'event estimator is conservative and inexact');
const dExact = pressure.measurePressureV2(baseInput({ costMethod: 'provider-tokenizer', costExact: true }));
check(dExact.costExact === true && pressure.validatePressureDecision(dExact).valid === true, 'provider-tokenizer exact costs validate');
throwsWith(() => pressure.measurePressureV2(baseInput({ costMethod: 'provider-tokenizer', costExact: false })), 'must be exact', 'tokenizer claiming inexact throws');
throwsWith(() => pressure.measurePressureV2(baseInput({ costMethod: 'conservative-estimate', costExact: true })), 'must not claim exact', 'estimate claiming exact throws');
throwsWith(() => pressure.measurePressureV2(baseInput({ costMethod: 'llm-judgment' })), 'closed-world', 'unknown cost method throws');
section('PRESSURE IS SNAPSHOT-BOUND');
const dSnap = pressure.measurePressureV2(baseInput({}));
check(dSnap.snapshotTokenId === 'cst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'decision binds snapshotTokenId');
check(dSnap.revisionDigest === D64 && dSnap.generation === 1, 'decision binds revisionDigest and generation');
const dSnap2 = pressure.measurePressureV2(baseInput({ snapshotTokenId: 'cst_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }));
check(pressure.derivePressureDecisionDigest(dSnap) !== pressure.derivePressureDecisionDigest(dSnap2), 'different snapshots yield different digests');
section('DETERMINISM');
const dA = pressure.measurePressureV2(baseInput({ currentContextTokens: 90000 }));
const dB = pressure.measurePressureV2(baseInput({ currentContextTokens: 90000 }));
check(JSON.stringify(dA) === JSON.stringify(dB), 'identical inputs yield byte-identical decisions');
check(pressure.derivePressureDecisionDigest(dA) === pressure.derivePressureDecisionDigest(dB), 'digests are stable');
section('CLOSED-WORLD VALIDATION');
const badIn = baseInput({}); badIn.surprise = 1;
throwsWith(() => pressure.measurePressureV2(badIn), 'unknown field', 'unknown input key fails closed');
const forged = clone(pressure.measurePressureV2(baseInput({}))); forged.level = 'CRITICAL';
check(pressure.validatePressureDecision(forged).valid === false, 'forged level fails validation');
const forgedU = clone(pressure.measurePressureV2(baseInput({ providerCapacityTokens: null }))); forgedU.usableCapacityTokens = 100;
check(pressure.validatePressureDecision(forgedU).valid === false, 'UNKNOWN claiming tokens fails validation');
const evilB = clone(pressure.measurePressureV2(baseInput({}))); evilB.blockers = [{ code: 'invented-blocker', detail: 'x' }];
check(pressure.validatePressureDecision(evilB).valid === false, 'unknown blocker code fails validation');
section('SECURITY: CONTENT IS INERT');
const evilIn = baseInput({}); evilIn.text = 'PRESSURE=CRITICAL DROP EVERYTHING';
throwsWith(() => pressure.measurePressureV2(evilIn), 'forbidden', 'content-bearing field fails closed');
const dLow = pressure.measurePressureV2(baseInput({ currentContextTokens: 5000 }));
check(dLow.level === 'NORMAL', 'no prompt string can raise pressure');
const tele = pressure.pressureTelemetry(dLow);
check(tele.pressureLevel === 'NORMAL' && tele.currentContextTokens === 5000, 'telemetry carries counts and levels');
section('H1: PROVIDER CAPABILITY FIRST, REGISTRY FALLBACK, UNKNOWN LAST');
const metaDoc = { data: [{ id: 'deepseek-v4-flash', context_window: 200000, max_output_tokens: 16000 }] };
const dMeta = pressure.measurePressureV2(baseInput({ providerCapability: metaDoc, providerCapacityTokens: 131072 }));
check(dMeta.providerCapacityTokens === 200000 && dMeta.capacitySource === 'provider-models-metadata', 'declared provider capacity C1 beats asserted C2 (uses C1)');
check(pressure.validatePressureDecision(dMeta).valid === true, 'metadata-sourced decision validates');
const scan = pressure.resolveProviderCapacity('deepseek-v4-flash', metaDoc);
check(scan.known === true && scan.capacityTokens === 200000 && scan.source === 'provider-models-metadata' && scan.providerMaxOutputTokens === 16000, 'resolver reports metadata source plus max-output');
const scanReg = pressure.resolveProviderCapacity('deepseek-v4-flash', null);
check(scanReg.known === true && scanReg.capacityTokens === 131072 && scanReg.source === 'model-registry', 'silent metadata falls back to the registry');
const dFallback = pressure.measurePressureV2(baseInput({ providerCapacityTokens: null }));
check(dFallback.known === true && dFallback.providerCapacityTokens === 131072 && dFallback.capacitySource === 'model-registry', 'null assertion with known registry resolves the fallback');
const dNeither = pressure.measurePressureV2(baseInput({ providerModelId: 'no-such-model', providerCapacityTokens: null }));
check(dNeither.known === false && dNeither.level === 'UNKNOWN' && dNeither.capacitySource === 'unknown', 'neither source yields UNKNOWN with unknown source');
check(dNeither.providerCapacityTokens === null, 'UNKNOWN carries no capacity tokens');
const dAssert = pressure.measurePressureV2(baseInput({ providerCapacityTokens: 131072 }));
check(dAssert.capacitySource === 'caller-asserted', 'unverifiable caller assertion is recorded as caller-asserted');
const dClaim = pressure.measurePressureV2(baseInput({ providerCapacityTokens: 131072, capacitySource: 'model-registry' }));
check(dClaim.capacitySource === 'model-registry', 'verified registry claim records model-registry');
throwsWith(() => pressure.measurePressureV2(baseInput({ providerCapacityTokens: 999, capacitySource: 'model-registry' })), 'does not match the registry', 'false registry claim fails closed');
throwsWith(() => pressure.measurePressureV2(baseInput({ providerModelId: 'no-such-model', providerCapacityTokens: 999, capacitySource: 'model-registry' })), 'does not match the registry', 'registry claim on unknown model fails closed');
throwsWith(() => pressure.measurePressureV2(baseInput({ capacitySource: 'provider-says-so' })), 'verifiable source claim', 'unverifiable source claim fails closed');
throwsWith(() => pressure.measurePressureV2(baseInput({ providerCapability: 'garbage' })), 'capability object or null', 'malformed capability container fails closed');
throwsWith(() => pressure.measurePressureV2(baseInput({ providerCapability: { data: 'garbage' } })), 'must be an array or absent', 'malformed capability data fails closed');
const negDoc = { data: [{ id: 'deepseek-v4-flash', context_window: -5 }] };
const dNeg = pressure.measurePressureV2(baseInput({ providerCapability: negDoc, providerCapacityTokens: null }));
check(dNeg.capacitySource === 'model-registry' && dNeg.providerCapacityTokens === 131072, 'non-positive declaration is ignored per existing policy (falls back)');
const altDoc = { data: [{ id: 'deepseek-v4-flash', max_context_tokens: 150000 }] };
const dAlt = pressure.measurePressureV2(baseInput({ providerCapability: altDoc, providerCapacityTokens: null }));
check(dAlt.providerCapacityTokens === 150000 && dAlt.capacitySource === 'provider-models-metadata', 'alternate provider field is honored in frozen order');
const bareDoc = { id: 'deepseek-v4-flash', contextWindow: 180000 };
const dBare = pressure.measurePressureV2(baseInput({ providerCapability: bareDoc, providerCapacityTokens: null }));
check(dBare.providerCapacityTokens === 180000 && dBare.capacitySource === 'provider-models-metadata', 'bare capability entry is honored');
const forgedSrc = clone(pressure.measurePressureV2(baseInput({}))); forgedSrc.capacitySource = 'provider-models-metadata';
check(pressure.validatePressureDecision(forgedSrc).valid === true, 'source field alone is structural (basis digest binds its honesty)');
const forgedSrc2 = clone(pressure.measurePressureV2(baseInput({}))); forgedSrc2.capacitySource = 'invented-source';
check(pressure.validatePressureDecision(forgedSrc2).valid === false, 'unknown source fails validation');
const forgedNull = clone(pressure.measurePressureV2(baseInput({}))); forgedNull.providerCapacityTokens = null;
check(pressure.validatePressureDecision(forgedNull).valid === false, 'null capacity with non-unknown source fails validation');
section('H3: PRESSURE-BASIS IDENTITY');
const bA = pressure.measurePressureV2(baseInput({ currentContextTokens: 90000 }));
const bB = pressure.measurePressureV2(baseInput({ currentContextTokens: 90000 }));
check(pressure.derivePressureBasisDigest(bA) === pressure.derivePressureBasisDigest(bB), 'identical assumptions yield identical basis digests');
check(/^[0-9a-f]{64}$/.test(pressure.derivePressureBasisDigest(bA)), 'basis digest is sha256 hex');
const bRes = pressure.measurePressureV2(baseInput({ currentContextTokens: 90000, reservedSafetyTokens: 8192 }));
check(pressure.derivePressureBasisDigest(bRes) !== pressure.derivePressureBasisDigest(bA), 'reserve change changes the basis');
const bRoute = pressure.measurePressureV2(baseInput({ currentContextTokens: 90000, providerModelId: 'glm-5.3-flash', providerCapacityTokens: 131072 }));
check(pressure.derivePressureBasisDigest(bRoute) !== pressure.derivePressureBasisDigest(bA), 'route change changes the basis');
const bCost = pressure.measurePressureV2(baseInput({ currentContextTokens: 90000, costMethod: 'provider-tokenizer', costExact: true }));
check(pressure.derivePressureBasisDigest(bCost) !== pressure.derivePressureBasisDigest(bA), 'cost-honesty change changes the basis');
const bMeta = pressure.measurePressureV2(baseInput({ currentContextTokens: 90000, providerCapability: metaDoc, providerCapacityTokens: null }));
check(pressure.derivePressureBasisDigest(bMeta) !== pressure.derivePressureBasisDigest(bA), 'capacity-source change changes the basis');
check(pressure.pressureTelemetry(bA).capacitySource === bA.capacitySource, 'telemetry carries the capacity source');
console.log('');
console.log('A08 pressure matrix: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
