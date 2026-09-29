'use strict';
/**
 * ContextModelCapabilityV2.Tests.cjs - CCV2-C08 capability/tokenizer proof.
 *
 * Proves against the REAL production authority
 * (config/ContextModelCapabilityV2.cjs + config/model-registry.json):
 * stub registration resolves a verified capability; real registry
 * routes resolve tokenizer-unavailable (capacity known, never
 * guessed); unknown routes resolve capability-unknown; test/logical
 * fingerprints can never authorize production counting; no
 * provider/model name-sniffing exists (exact-pair lookup only);
 * vectors verify byte-for-byte across the module and a fresh process.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const child = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const cap = require(path.join(repoRoot, 'config', 'ContextModelCapabilityV2.cjs'));
const counterMod = require(path.join(repoRoot, 'config', 'ContextTokenCounterV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log(String.fromCharCode(10) + title); }

section('C08-CAP-1 STUB TOKENIZER VECTORS (exact UTF-8 bytes)');
{
  const ctr = cap.createStubTokenizerCounterV2();
  check(ctr.tokenizerFingerprint === 'nexus-stub-tokenizer-v1', 'stub fingerprint versioned');
  for (const vec of cap.STUB_TOKEN_VECTORS_V1) {
    const first = ctr.countText(vec.text);
    const second = ctr.countText(vec.text);
    check(first === vec.tokens && second === vec.tokens, 'vector ' + JSON.stringify(vec.text) + ' -> ' + vec.tokens, 'got ' + first);
  }
  check(counterMod.validateContextTokenCounterV2(ctr).valid === true, 'stub counter passes the frozen C04 validator');
  check(counterMod.countTextVerifiedV2(ctr, 'h\u00e9llo \uD83D\uDE00') === 11, 'mixed multibyte recounts deterministically');
}

section('C08-CAP-2 CROSS-PROCESS VECTOR STABILITY');
{
  const script = "const c=require(" + JSON.stringify(path.join(repoRoot, 'config', 'ContextModelCapabilityV2.cjs')) + ");" +
    "const ctr=c.createProductionCounterFromFingerprintV2('nexus-stub-tokenizer-v1');" +
    "console.log(JSON.stringify(c.STUB_TOKEN_VECTORS_V1.map((v)=>ctr.countText(v.text))));";
  const out = child.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  const counts = JSON.parse(out);
  const expected = cap.STUB_TOKEN_VECTORS_V1.map((v) => v.tokens);
  check(JSON.stringify(counts) === JSON.stringify(expected), 'fresh process reproduces every vector', out.slice(0, 200));
}

section('C08-CAP-3 PRODUCTION FINGERPRINT REJECTION');
{
  for (const fp of ['test-codepoint-v1', 'logical-codepoint-v1']) {
    let threw = false;
    try { cap.createProductionCounterFromFingerprintV2(fp); } catch (e) {
      threw = String((e && e.message) || e).indexOf('not-production') !== -1 || String((e && e.message) || e).indexOf('model-capability') !== -1;
    }
    check(threw === true, 'fingerprint ' + fp + ' can never authorize production counting');
  }
  let threwUnknown = false;
  try { cap.createProductionCounterFromFingerprintV2('gpt-4-tokenizer'); } catch (e) { threwUnknown = true; }
  check(threwUnknown === true, 'foreign model tokenizer rejected without inspection');
  // A test/logical counter presented AS a capability fails validation.
  const forged = {
    schemaVersion: 1, provider: 'stub-test', model: 'stub-model-v1',
    maxContextTokens: 20000, maxOutputTokens: null,
    tokenizerFingerprint: 'test-codepoint-v1',
    tokenCounter: counterMod.createCodepointTestCounterV2(),
    source: 'stub-verified', verified: true, capabilityRevision: 'model-context-capability-v1',
  };
  const checkForged = cap.validateModelCapabilityV2(forged);
  check(checkForged.valid === false && checkForged.reason === 'active-tokenizer-unavailable', 'test counter smuggled as capability rejected');
}

section('C08-CAP-4 STUB REGISTRATION (exact pairs only)');
{
  const good = cap.createStubTestCapabilityV2({ provider: 'stub-test', model: 'stub-model-v1', maxContextTokens: 20000 });
  check(good.verified === true && good.source === 'stub-verified', 'stub capability verified + sourced');
  check(good.maxContextTokens === 20000 && good.capabilityRevision === 'model-context-capability-v1', 'window + revision bound');
  check(Object.isFrozen(good) === true, 'capability frozen (immutable for the request)');
  const resolved = cap.resolveModelCapabilityV2({
    provider: 'stub-test', model: 'stub-model-v1',
    supportedRoutes: [{ provider: 'stub-test', model: 'stub-model-v1', maxContextTokens: 20000 }],
  });
  check(resolved.valid === true && resolved.capability.maxContextTokens === 20000, 'exact registered pair resolves');
  // Near-miss pairs must NOT resolve (no prefix/substring/family matching).
  const misses = [
    { provider: 'stub-test', model: 'stub-model-v1-evil' },
    { provider: 'stub-test-evil', model: 'stub-model-v1' },
    { provider: 'STUB-TEST', model: 'stub-model-v1' },
    { provider: 'stub-test ', model: 'stub-model-v1' },
    { provider: 'stub-test', model: 'stub-model' },
  ];
  for (const miss of misses) {
    const r = cap.resolveModelCapabilityV2({
      provider: miss.provider, model: miss.model,
      supportedRoutes: [{ provider: 'stub-test', model: 'stub-model-v1', maxContextTokens: 20000 }],
    });
    check(r.valid === false && r.reason === 'active-model-capability-unknown', 'near-miss ' + miss.provider + '/' + miss.model + ' unknown');
  }
  // Model-name sniffing would resolve these; exact lookup must not.
  for (const probe of [
    { provider: 'openai', model: 'gpt-5.6-sol-injected' },
    { provider: 'claude-direct', model: 'claude-opus' },
    { provider: 'meta-model-api', model: 'muse-spark' },
  ]) {
    const r = cap.resolveModelCapabilityV2({
      provider: probe.provider, model: probe.model,
      supportedRoutes: [{ provider: 'stub-test', model: 'stub-model-v1', maxContextTokens: 20000 }],
    });
    check(r.valid === false, 'vendor-named probe ' + probe.provider + '/' + probe.model + ' not sniffed');
  }
}

section('C08-CAP-5 PRODUCTION REGISTRY (registered v4-flash eligible, all else fallback)');
{
  for (const route of [{ provider: 'flash-max-direct', model: 'deepseek-v4-flash' }, { provider: 'flash-high-direct', model: 'deepseek-v4-flash' }]) {
    const e = cap.resolveModelCapabilityV2({ provider: route.provider, model: route.model, installRoot: repoRoot });
    check(e.valid === true && e.capability.tokenizerFingerprint === 'deepseek-v4-official-bpe-r1-89085f12ef79', route.provider + '/' + route.model + ' production-eligible');
    check(e.capability.maxContextTokens === 131072 && e.capability.maxOutputTokens === 8192, route.model + ' window bound to the same route');
    check(e.capability.framing !== null && e.capability.framing.revision === 'deepseek-v4-chat-template-r1', route.model + ' framing bound');
  }
  const cases = [
    { provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' },
    { provider: 'deepseek-pro-direct', model: 'deepseek-v4-pro' },
    { provider: 'sol-local', model: 'gpt-5.6-sol' },
  ];
  for (const route of cases) {
    const r = cap.resolveModelCapabilityV2({ provider: route.provider, model: route.model, installRoot: repoRoot });
    check(r.valid === false && r.reason === 'active-tokenizer-unavailable', route.provider + '/' + route.model + ' tokenizer-unavailable');
    check(r.windowKnown === true && Number.isInteger(r.maxContextTokens) && r.maxContextTokens > 0, route.model + ' window still authoritative (' + r.maxContextTokens + ')');
  }
  const unknown = cap.resolveModelCapabilityV2({ provider: 'nope-direct', model: 'nope-model', installRoot: repoRoot });
  check(unknown.valid === false && unknown.reason === 'active-model-capability-unknown', 'unregistered route capability-unknown');
  const noRoot = cap.resolveModelCapabilityV2({ provider: 'meta-model-api', model: 'muse-spark-1.3-contributor', installRoot: '/nonexistent-root-xyz' });
  check(noRoot.valid === false, 'unreadable registry fails closed (no guess)');
}

section('C08-CAP-6 CAPABILITY VALIDATION HARDENING');
{
  const base = cap.createStubTestCapabilityV2({ provider: 'stub-test', model: 'stub-model-v1', maxContextTokens: 20000 });
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const withCounter = (o) => Object.assign(clone(o), { tokenCounter: base.tokenCounter });
  check(cap.validateModelCapabilityV2(base).valid === true, 'round-trip valid');
  const tamperedWindow = withCounter(Object.assign(clone(base), { maxContextTokens: -5 }));
  check(cap.validateModelCapabilityV2(tamperedWindow).valid === false, 'negative window rejected');
  const tamperedFp = withCounter(Object.assign(clone(base), { tokenizerFingerprint: 'nexus-stub-tokenizer-v9' }));
  check(cap.validateModelCapabilityV2(tamperedFp).valid === false, 'wrong fingerprint rejected (counter mismatch)');
  const unverified = withCounter(Object.assign(clone(base), { verified: false }));
  check(cap.validateModelCapabilityV2(unverified).valid === false, 'unverified capability rejected');
  const flaky = withCounter(Object.assign(clone(base), {}));
  flaky.tokenCounter = { tokenizerFingerprint: 'nexus-stub-tokenizer-v1', countText: () => 42 };
  // 42 for the probe is self-consistent here, but double-count agrees; use a truly flaky counter.
  let n = 0;
  flaky.tokenCounter = { tokenizerFingerprint: 'nexus-stub-tokenizer-v1', countText: () => { n += 1; return n; } };
  check(cap.validateModelCapabilityV2(flaky).valid === false, 'nondeterministic counter rejected by liveness probe');
  void tamperedWindow;
  const described = cap.describeModelCapabilityV2(base);
  check(described.valid === true && described.tokenizerFingerprint === 'nexus-stub-tokenizer-v1', 'secret-safe summary binds fingerprint');
  check(JSON.stringify(described).indexOf('countText') === -1, 'summary carries no counter closure');
}

section('C08-CAP-7 DETERMINISM');
{
  const a = cap.createStubTestCapabilityV2({ provider: 'stub-test', model: 'stub-model-v1', maxContextTokens: 20000 });
  const b = cap.createStubTestCapabilityV2({ provider: 'stub-test', model: 'stub-model-v1', maxContextTokens: 20000 });
  const canon = (o) => JSON.stringify(Object.assign({}, o, { tokenCounter: '[counter]' }));
  check(canon(a) === canon(b), 'identical inputs reproduce the capability');
}

console.log('\nContextModelCapabilityV2 suite: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
