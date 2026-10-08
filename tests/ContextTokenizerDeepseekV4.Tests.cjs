'use strict';
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const reg = require(path.join(repoRoot, 'config', 'ContextTokenizerRegistryV2.cjs'));
const NL = String.fromCharCode(10);
const chr = (c) => String.fromCharCode(c);
const BG = [1047, 1076, 1088, 1072, 1074, 1077, 1081, 44, 32, 1082, 1086, 1083, 1077, 1075, 1072, 33, 32, 1041, 1098, 1083, 1075, 1072, 1088, 1080, 1103, 32, 1077, 32, 1090, 1091, 1082].map(chr).join('');
const EL = [917, 955, 955, 951, 957, 953, 954, 940, 32, 947, 961, 940, 956, 956, 945, 964, 945].map(chr).join('');
const CJK = [20013, 25991, 27979, 35797, 20998, 35789].map(chr).join('');
const EMOJI = String.fromCodePoint(128512) + String.fromCodePoint(127881) + String.fromCodePoint(128640);
const ACC = 'h' + chr(233) + 'llo ' + chr(231) + 'a ' + chr(241);
const FW = chr(0xFF5C);
const LS = chr(0x2581);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const CTR = () => reg.createDeepseekV4CounterV2();
const capMod = require(path.join(repoRoot, 'config', 'ContextModelCapabilityV2.cjs'));
const counterMod = require(path.join(repoRoot, 'config', 'ContextTokenCounterV2.cjs'));
const fs = require('node:fs');
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log(String.fromCharCode(10) + title); }
section('C08H-TOK-1 ARTIFACT PINNING');
{
  check(reg.TOKENIZER_FINGERPRINT_V1 === 'deepseek-v4-official-bpe-r1-89085f12ef79', 'fingerprint pinned with artifact hash');
  check(reg.PINNED_JSON_SHA256 === '89085f12ef79460ac5f66d1119325ddfc694b4ab209d80bbd81d35f081dc9614', 'json sha pinned');
  const bytes = fs.readFileSync(path.join(repoRoot, 'config', 'tokenizers', 'deepseek-v4-tokenizer.json'));
  const crypto = require('node:crypto');
  check(crypto.createHash('sha256').update(bytes).digest('hex') === reg.PINNED_JSON_SHA256, 'vendored bytes match the pin');
  const model = reg.loadDeepseekV4ModelV2();
  check(model.fileDigest === reg.PINNED_JSON_SHA256, 'loader verifies artifact sha');
  check(typeof model.configDigest === 'string' && model.configDigest === reg.templateConfigDigestV2(), 'template digest stable');
  check(reg.ENGINE_REVISION_V1 === 'deepseek-v4-bpe-engine-r1', 'engine revision bound');
  check(reg.FRAMING_REVISION_V1 === 'deepseek-v4-chat-template-r1', 'framing revision bound');
}
section('C08H-TOK-2 KNOWN VECTORS (ground-truth counts)');
{
  const ctr = CTR();
  const cases = [
    ['', 0], ['hello', 1], ['Ship C08H now.', 6], [ACC, 4], [BG, 15], [EL, 7], [CJK, 3], [EMOJI, 6],
    ['def f(x):' + NL + '    return x' + NL, 8],
    ['line1' + NL + NL + 'line2' + CR + NL + 'line3', 9],
    ['abc '.repeat(200), 201],
    ['Historical host note. '.repeat(30), 121],
    [' '.repeat(17), 1], [TAB + 'tabbed' + TAB, 4],
    ['Mix: ' + BG + ' + ' + CJK + ' + ' + EMOJI + ' end.', 31],
  ];
  for (const pair of cases) {
    const got = ctr.countText(pair[0]);
    check(got === pair[1], 'count ' + pair[0].length + ' chars -> ' + pair[1], 'got ' + got);
  }
  check(ctr.countText('hello') === ctr.countText('hello'), 'deterministic recount');
  const idsHello = reg.encodeDeepseekV4V2('hello');
  check(idsHello.length === 1 && idsHello[0] === 33310, 'hello id exact');
  check(JSON.stringify(Array.from(reg.encodeDeepseekV4V2('Ship C08H now.'))) === JSON.stringify([84292, 345, 3019, 42, 1928, 16]), 'id array exact');
  check(JSON.stringify(Array.from(reg.encodeDeepseekV4V2('h' + chr(233) + 'llo'))) === JSON.stringify([61538, 61547]), 'accented ids exact');
  const markers = [[reg.MARKER_BOS, 0], [reg.MARKER_USER, 128803], [reg.MARKER_ASSISTANT, 128804], [reg.MARKER_EOS, 1]];
  for (const pair of markers) {
    const ids = reg.encodeDeepseekV4V2(pair[0]);
    check(ids.length === 1 && ids[0] === pair[1], 'marker single id ' + pair[1]);
  }
}
section('C08H-TOK-3 NO NORMALIZATION + ROBUSTNESS');
{
  const pre = chr(233);
  const decomp = 'e' + chr(769);
  check(JSON.stringify(Array.from(reg.encodeDeepseekV4V2(pre))) === JSON.stringify([619]), 'precomposed ids exact');
  check(JSON.stringify(Array.from(reg.encodeDeepseekV4V2(decomp))) === JSON.stringify([71, 17793]), 'decomposed ids exact');
  check(CTR().countText(pre) !== CTR().countText(decomp), 'precomposed vs decomposed differ (no NFC)');
  const lone = chr(0xD83D) + '-alone';
  const once = reg.encodeDeepseekV4V2(lone);
  const twice = reg.encodeDeepseekV4V2(lone);
  check(JSON.stringify(Array.from(once)) === JSON.stringify(Array.from(twice)) && once.length > 0, 'lone surrogate deterministic, no throw');
  let threw = false;
  try { CTR().countText(42); } catch (error) { threw = true; }
  check(threw === true, 'non-string rejected');
  check(counterMod.validateContextTokenCounterV2(CTR()).valid === true, 'passes the frozen C04 validator');
  const big = 'word '.repeat(20000);
  const start = Date.now();
  const bigCount = CTR().countText(big);
  check(Date.now() - start < 5000 && bigCount === 20001, '100KB text counts fast (' + bigCount + ')');
}
section('C08H-TOK-4 FRAMING (official template, string + ids)');
{
  const cases = [
    { systems: ['You are helpful.'], turn: 'Hello turn', prime: true, tokens: 9, ids: [0, 3476, 477, 11502, 16, 128803, 19923, 2859, 128804] },
    { systems: ['You are helpful.'], turn: 'Hello turn', prime: false, tokens: 8, ids: [0, 3476, 477, 11502, 16, 128803, 19923, 2859] },
    { systems: ['First contract.', 'Second contract.'], turn: 'Go', prime: true, tokens: 10, ids: [0, 10318, 6085, 339, 18653, 6085, 16, 128803, 5188, 128804] },
    { systems: [], turn: 'Lonely turn', prime: true, tokens: 7, ids: [0, 128803, 46, 265, 891, 2859, 128804] },
  ];
  for (const item of cases) {
    const f = reg.frameDeepseekChatV2({ systemTexts: item.systems, turnText: item.turn, generationPrime: item.prime });
    check(f.tokens === item.tokens, 'framed tokens ' + item.tokens);
    check(JSON.stringify(Array.from(f.ids)) === JSON.stringify(item.ids), 'framed ids exact');
    check(f.tokenizerFingerprint === reg.TOKENIZER_FINGERPRINT_V1, 'framing binds the tokenizer fingerprint');
    check(f.framingRevision === reg.FRAMING_REVISION_V1, 'framing revision bound');
  }
  const primed = reg.frameDeepseekChatV2({ systemTexts: ['S.'], turnText: 'T', generationPrime: true });
  const unprimed = reg.frameDeepseekChatV2({ systemTexts: ['S.'], turnText: 'T', generationPrime: false });
  check(primed.tokens === unprimed.tokens + 1, 'generation priming counted as one input token');
  check(primed.framedText.length > unprimed.framedText.length, 'priming present in framed bytes');
}
section('C08H-TOK-5 REGISTRY EXACTNESS (no fuzzy matching)');
{
  for (const pair of [{ provider: 'flash-max-direct', model: 'deepseek-v4-flash' }, { provider: 'flash-high-direct', model: 'deepseek-v4-flash' }]) {
    const d = reg.resolveProductionTokenizerV2(pair);
    check(d !== null && d.verified === true && d.tokenizerFingerprint === reg.TOKENIZER_FINGERPRINT_V1, pair.provider + '/' + pair.model + ' resolved verified');
  }
  const misses = [
    { provider: 'flash-max-direct', model: 'deepseek-v4-flash-evil' },
    { provider: 'flash-max-direct', model: 'deepseek-v4-pro' },
    { provider: 'deepseek-pro-direct', model: 'deepseek-v4-pro' },
    { provider: 'flash', model: 'deepseek-v4-flash' },
    { provider: 'FLASH-MAX-DIRECT', model: 'deepseek-v4-flash' },
    { provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' },
    { provider: '', model: '' },
  ];
  for (const miss of misses) {
    check(reg.resolveProductionTokenizerV2(miss) === null, 'no match for ' + miss.provider + '/' + miss.model);
  }
  const summary = reg.describeProductionTokenizerV2(reg.resolveProductionTokenizerV2({ provider: 'flash-max-direct', model: 'deepseek-v4-flash' }));
  check(summary.valid === true && summary.source === 'deepseek-official-tokenizer', 'secret-safe summary sourced');
}
section('C08H-TOK-6 CAPABILITY BINDING (same exact route)');
{
  const r = capMod.resolveModelCapabilityV2({ provider: 'flash-max-direct', model: 'deepseek-v4-flash', installRoot: repoRoot });
  check(r.valid === true, 'real route capability valid');
  check(r.capability.maxContextTokens === 131072 && r.capability.maxOutputTokens === 8192, 'window + output bound to the route');
  check(r.capability.source === 'deepseek-official-tokenizer', 'production source (never stub)');
  check(r.capability.framing !== null && r.capability.framing.templateDigest === reg.templateConfigDigestV2(), 'framing digest pinned');
  const rebuilt = capMod.createProductionCounterFromFingerprintV2(r.capability.tokenizerFingerprint);
  check(rebuilt.countText('hello') === 1, 'XProc-style counter rebuild counts');
  const pro = capMod.resolveModelCapabilityV2({ provider: 'deepseek-pro-direct', model: 'deepseek-v4-pro', installRoot: repoRoot });
  check(pro.valid === false && pro.reason === 'active-tokenizer-unavailable', 'same provider, unregistered model stays fallback');
}
console.log(String.fromCharCode(10) + 'ContextTokenizerDeepseekV4 suite: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
