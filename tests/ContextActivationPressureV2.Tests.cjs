'use strict';
// CCv2 RC1.1 Layer A: context-pressure activation gate (pure module).
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const repoRoot = path.resolve(__dirname, '..');
const gate = require(path.join(repoRoot, 'config', 'ContextActivationPressureV2.cjs'));
const wire = require(path.join(repoRoot, 'config', 'ContextWireProjectorResponsesV2.cjs'));
const opencode = require(path.join(repoRoot, 'config', 'ContextCompilerActiveOpencodeV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log(String.fromCharCode(10) + title); }
const clone = (o) => JSON.parse(JSON.stringify(o));
const ROUTE = wire.readResponsesRouteFromSettingsV2(fs.readFileSync(path.join(repoRoot, 'config', 'settings.yaml'), 'utf8'), 'opencode-go', 'muse-spark-1.3-contributor');
const PRESSURE = gate.resolveActivationModeV2({ contextCompiler: { mode: 'active' } });
const ALWAYS = gate.resolveActivationModeV2({ contextCompiler: { mode: 'active', activation: 'always' } });
const T = gate.deriveActivationThresholdsV2(ROUTE);
const NATIVE_ROUTE = Object.assign({}, ROUTE, { reasoningReplay: 'native' });
const TN = gate.deriveActivationThresholdsV2(NATIVE_ROUTE);

// Session log builder: one assistant/message per sample, each followed by a
// tool result message. Messages carry ids the gate matches on.
function sessionOf(samples, opts) {
  const o = opts || {};
  const events = [];
  const messages = [{ id: 'u0', role: 'user', content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }];
  const push = (type, data, extra) => events.push(Object.assign({ seq: events.length, type, data }, extra || {}));
  push('turn/start', { turn: 1 });
  push('user/message', clone(messages[0]));
  samples.forEach((usage, index) => {
    const step = index + 1;
    push('step/start', { turn: 1, step });
    const assistant = { id: 'a' + step, role: 'assistant', content: [{ type: 'tool-call', id: 'c' + step, name: 'run_code', arguments: '{}' }], source: { kind: 'model' } };
    push('assistant/message', Object.assign({ turn: 1, step, message: clone(assistant) }, usage === undefined ? {} : { usage }));
    const result = { id: 'r' + step, role: 'user', content: [{ type: 'tool-result', toolCallId: 'c' + step, content: [{ type: 'text', text: o.resultText || 'ok' }], isError: false }], source: { kind: 'tool', callId: 'c' + step } };
    push('tool/result', { turn: 1, step, message: clone(result) });
    push('step/end', { turn: 1, step });
    messages.push(assistant, result);
  });
  push('step/start', { turn: 1, step: samples.length + 1 });
  return { events, messages };
}
const usageOf = (prompt, output) => ({ inputTokens: prompt, outputTokens: output === undefined ? 0 : output });
const deltaOf = (messages, after) => messages.slice(after + 1).reduce((sum, m) => sum + gate.messageBoundTokensV2(m), 0);

section('RC1.1-A1 THRESHOLD DERIVATION (every term authoritative or documented; basis from the replay capability)');
check(ROUTE !== null && ROUTE.contextWindow === 1048576 && ROUTE.maxTokens === 131072 && ROUTE.reasoningReplay === 'none',
  'production opencode-go route: window 1,048,576, max output 131,072, reasoningReplay none');
check(T.valid === true && T.windowTokens === 1048576 && T.dshThresholdTokens === 838860, 'DSH compaction threshold = floor(window x 0.8) = 838,860');
check(T.stepGrowthReserveTokens === 65536 && gate.STEP_GROWTH_RESERVE_TOKENS_V1 === 65536, 'step growth reserve 65,536 (documented evidence bound)');
check(T.beforeDshTokens === 838860 - 131072 - 65536 - opencode.providerSafetyMarginV2(838860) && T.beforeDshTokens === 633863,
  'before-DSH point = 838,860 - 131,072 - 65,536 - 8,389 (RC1 margin) = 633,863');
check(T.nativeUnsendableTokens === 1048576 - 131072 - opencode.providerSafetyMarginV2(1048576) && T.nativeUnsendableTokens === 907018,
  'native-unsendable point = 1,048,576 - 131,072 - 10,486 (RC1 margin of the window) = 907,018');
check(T.basis === 'native-unsendable' && T.activationTokens === 907018,
  'reasoningReplay none (compiled requests must drop in-turn reasoning): activate only when native is unsendable');
check(TN.valid === true && TN.basis === 'before-dsh-compaction' && TN.activationTokens === 633863,
  'reasoningReplay native (compiled requests lose nothing): activate one step before DSH compaction');
check(TN.activationTokens + TN.maxOutputTokens + TN.stepGrowthReserveTokens + opencode.providerSafetyMarginV2(838860) === TN.dshThresholdTokens,
  'native-replay basis: one full step (max output + reserve + margin) separates activation from DSH compaction');
check(T.activationTokens > T.dshThresholdTokens, 'replay-none basis: DSH compaction (keeps the open turn native) always gets the first chance');
check(T.activationTokens + T.maxOutputTokens + opencode.providerSafetyMarginV2(1048576) === T.windowTokens, 'replay-none basis: the native request plus its output still fits the window at the threshold');
check(Math.min(T.activationTokens, TN.activationTokens) > 505050, 'the frozen Legacy OpenRank peak (505,050) stays below both bases');
check(gate.deriveActivationThresholdsV2(Object.assign({}, ROUTE, { reasoningReplay: 'partial' })).valid === false
  && gate.deriveActivationThresholdsV2(Object.assign({}, ROUTE, { reasoningReplay: undefined })).valid === false, 'an unknown replay capability is invalid (never guessed)');
check(gate.deriveActivationThresholdsV2(Object.assign({}, ROUTE, { contextWindow: 2000000 })).valid === false, 'a window other than the certified counting window is invalid (never guessed)');
check(gate.deriveActivationThresholdsV2(Object.assign({}, ROUTE, { maxTokens: 1048576 })).valid === false, 'output ceiling >= window is invalid');
check(gate.deriveActivationThresholdsV2(Object.assign({}, ROUTE, { maxTokens: 1.5 })).valid === false
  && gate.deriveActivationThresholdsV2(null).valid === false && gate.deriveActivationThresholdsV2({}).valid === false, 'non-integer / absent capability is invalid');
check(gate.deriveActivationThresholdsV2(Object.assign({}, ROUTE, { maxTokens: 800000 })).valid === false, 'a non-positive activation point is invalid');

section('RC1.1-A2 DSH PIN (the 0.8 ratio is the pinned default and Nexus overrides nothing)');
{
  const appRoot = path.join(process.env.NEXUS_RUNTIME_ROOT || path.join(os.homedir(), '.local', 'share', 'nexus'), 'app', 'node_modules', '@deepseek-ai');
  const basic = path.join(appRoot, 'dsh-compaction-basic', 'lib', 'index.js');
  const preset = path.join(appRoot, 'dsh', 'config', 'agent-presets', 'code', 'agent.cordis.yml');
  if (fs.existsSync(basic) && fs.existsSync(preset)) {
    const source = fs.readFileSync(basic, 'utf8');
    check(/const DEFAULT_THRESHOLD_RATIO = \.8;/.test(source) && gate.DSH_COMPACTION_THRESHOLD_RATIO_V1 === 0.8, 'pinned dsh-compaction-basic DEFAULT_THRESHOLD_RATIO is 0.8');
    const yml = fs.readFileSync(preset, 'utf8');
    const at = yml.indexOf("name: '@deepseek-ai/dsh-compaction-basic'");
    const block = at === -1 ? '' : yml.slice(at, yml.indexOf('- id:', at + 1) === -1 ? undefined : yml.indexOf('- id:', at + 1));
    check(at !== -1 && block.indexOf('thresholdRatio') === -1 && block.indexOf('modelPolicies') === -1, 'the shipped code preset (aih-muse base) configures no threshold override');
  } else {
    console.log('SKIP: pinned DSH app tree absent; the DSH ratio pin is checked against an installed runtime only (never faked).');
  }
  const offenders = [];
  for (const dir of ['config', 'scripts']) {
    for (const name of fs.readdirSync(path.join(repoRoot, dir))) {
      if (!/\.(yml|yaml|json|ps1)$/.test(name)) continue;
      if (/thresholdRatio|retainRatio/.test(fs.readFileSync(path.join(repoRoot, dir, name), 'utf8'))) offenders.push(name);
    }
  }
  check(offenders.length === 0, 'no Nexus configuration overrides the DSH compaction ratio', offenders.join(','));
}

section('RC1.1-A3 POLICY RESOLUTION (single config authority, closed world)');
check(PRESSURE.valid && PRESSURE.mode === 'pressure' && PRESSURE.origin === 'default', 'absent activation -> pressure (default)');
check(ALWAYS.valid && ALWAYS.mode === 'always' && ALWAYS.origin === 'config', "explicit 'always' (canaries) is honoured");
check(gate.resolveActivationModeV2({ contextCompiler: { activation: 'pressure' } }).mode === 'pressure', "explicit 'pressure'");
for (const bad of ['Always', 'never', '', 1, true, {}, []]) {
  check(gate.resolveActivationModeV2({ contextCompiler: { activation: bad } }).valid === false, 'unknown activation value ' + JSON.stringify(bad) + ' is invalid');
}
check(gate.resolveActivationModeV2(null).mode === 'pressure' && gate.resolveActivationModeV2({}).mode === 'pressure', 'no config -> pressure');

section('RC1.1-A4 USAGE SAMPLES (DSH TokenUsage, closed world)');
check(gate.sampleTokensOfV2({ inputTokens: 10, outputTokens: 5 }) === 15, 'input + output');
check(gate.sampleTokensOfV2({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 7 }) === 122, 'cache read/write are added (disjoint buckets)');
check(gate.sampleTokensOfV2({ inputTokens: 10, outputTokens: 5, reasoningTokens: 4 }) === 15, 'reasoningTokens is an output subdivision, never added again');
for (const bad of [null, {}, { inputTokens: 1 }, { inputTokens: -1, outputTokens: 0 }, { inputTokens: 1.5, outputTokens: 0 },
  { inputTokens: 1, outputTokens: 0, cacheReadTokens: -2 }, { inputTokens: 1, outputTokens: 0, totalTokens: 1 }, { inputTokens: '1', outputTokens: 0 }]) {
  check(gate.sampleTokensOfV2(bad) === null, 'malformed usage ' + JSON.stringify(bad) + ' is no sample');
}
check(gate.messageBoundTokensV2({ content: [{ type: 'text', text: 'abc' }] }) === Buffer.byteLength(JSON.stringify([{ type: 'text', text: 'abc' }])) + 32,
  'delta bound = UTF-8 bytes of the JSON content + 32 framing tokens');
check(gate.messageBoundTokensV2({ content: [{ type: 'text', text: String.fromCodePoint(128512).repeat(10) }] }) > 40, 'multi-byte text is bounded by bytes, never by characters');

section('RC1.1-A5 BOUNDARY (below / exactly at / above)');
{
  const decideAt = (anchorPrompt) => {
    const s = sessionOf([usageOf(anchorPrompt, 0)]);
    const delta = deltaOf(s.messages, 1);
    return { d: gate.decideActivationV2({ mode: PRESSURE, route: ROUTE, events: s.events, messages: s.messages }), delta };
  };
  const probe = decideAt(1000);
  const exact = T.activationTokens - probe.delta;
  const below = decideAt(exact - 1);
  const at = decideAt(exact);
  const above = decideAt(exact + 1);
  check(probe.d.pressureTokens === 1000 + probe.delta && probe.d.anchorTokens === 1000 && probe.d.deltaBoundTokens === probe.delta, 'pressure = anchor sample + delta bound of the messages after it');
  check(below.d.decision === 'NATIVE' && below.d.reason === 'pressure-below-threshold' && below.d.pressureTokens === T.activationTokens - 1, 'activationTokens - 1 -> NATIVE (below threshold)');
  check(at.d.decision === 'ACTIVATE' && at.d.reason === 'pressure-at-or-above-threshold' && at.d.pressureTokens === T.activationTokens, 'exactly activationTokens -> ACTIVATE');
  check(above.d.decision === 'ACTIVATE' && above.d.reason === 'pressure-at-or-above-threshold', 'activationTokens + 1 -> ACTIVATE');
  const small = decideAt(77000);
  check(small.d.decision === 'NATIVE' && small.d.reason === 'pressure-below-threshold', 'the RC1 OpenRank turn-2 size (~77k) stays NATIVE (the regression class)');
  const legacyPeak = decideAt(505050);
  check(legacyPeak.d.decision === 'NATIVE', 'the frozen Legacy peak (505,050) stays NATIVE');
  // The band between the two bases: same pressure, different capability.
  const s = sessionOf([usageOf(750000, 0)]);
  const none = gate.decideActivationV2({ mode: PRESSURE, route: ROUTE, events: s.events, messages: s.messages });
  const nat = gate.decideActivationV2({ mode: PRESSURE, route: NATIVE_ROUTE, events: s.events, messages: s.messages });
  check(none.decision === 'NATIVE' && none.basis === 'native-unsendable' && nat.decision === 'ACTIVATE' && nat.basis === 'before-dsh-compaction',
    '750k: replay-none route stays native (continuity kept, DSH compaction preferred); a replay-native route activates');
  const nb = sessionOf([usageOf(1000, 0)]);
  const nDelta = deltaOf(nb.messages, 1);
  const tnBelow = sessionOf([usageOf(TN.activationTokens - nDelta - 1, 0)]);
  const tnAt = sessionOf([usageOf(TN.activationTokens - nDelta, 0)]);
  check(gate.decideActivationV2({ mode: PRESSURE, route: NATIVE_ROUTE, events: tnBelow.events, messages: tnBelow.messages }).decision === 'NATIVE'
    && gate.decideActivationV2({ mode: PRESSURE, route: NATIVE_ROUTE, events: tnAt.events, messages: tnAt.messages }).decision === 'ACTIVATE',
    'replay-native basis boundary: 633,862 NATIVE, 633,863 ACTIVATE');
}

section('RC1.1-A6 LATCH / HYSTERESIS / TRANSITIONS');
{
  const hi = T.activationTokens + 10;
  // Native growth -> crossing -> compiled usage (smaller) afterwards.
  const s = sessionOf([usageOf(400000, 1000), usageOf(500000, 1000), usageOf(hi, 0), usageOf(300000, 500), usageOf(310000, 500)]);
  const d = gate.decideActivationV2({ mode: PRESSURE, route: ROUTE, events: s.events, messages: s.messages });
  check(d.decision === 'ACTIVATE' && d.reason === 'pressure-latched' && d.latchTokens === hi && d.pressureTokens < T.activationTokens,
    'compiled usage below the threshold after a crossing stays ACTIVATE (latched, no thrash)');
  // Prefix replay: decisions never go ACTIVATE -> NATIVE inside an epoch.
  const seq = [100000, 300000, 600000, hi, 200000, 210000, 220000];
  let seen = false;
  let thrash = false;
  for (let n = 1; n <= seq.length; n += 1) {
    const p = sessionOf(seq.slice(0, n).map((x) => usageOf(x, 0)));
    const out = gate.decideActivationV2({ mode: PRESSURE, route: ROUTE, events: p.events, messages: p.messages });
    if (out.decision === 'ACTIVATE') seen = true; else if (seen) thrash = true;
  }
  check(seen && !thrash, 'monotone within an epoch: once activated, never NATIVE again (transition sequence)');
  // Restart: the latch is a pure function of the durable log.
  const restored = JSON.parse(JSON.stringify(s));
  const fresh = gate.decideActivationV2({ mode: PRESSURE, route: ROUTE, events: restored.events, messages: restored.messages });
  check(JSON.stringify(fresh) === JSON.stringify(d), 'restart: the restored log reproduces the identical latched decision');
  // Epoch reset: a DSH surface replacement starts a new epoch.
  const r = sessionOf([usageOf(hi, 0)]);
  r.events.push({ seq: r.events.length, type: 'assistant/message', surfaceOp: 'replace', data: { turn: 1, step: 9, message: { id: 'summary', role: 'assistant', content: [] } } });
  r.events.push({ seq: r.events.length, type: 'assistant/message', data: { turn: 1, step: 10, message: { id: 'a-new', role: 'assistant', content: [] }, usage: usageOf(150000, 10) } });
  const rm = [{ id: 'summary' }, { id: 'a-new', role: 'assistant', content: [] }];
  const rd = gate.decideActivationV2({ mode: PRESSURE, route: ROUTE, events: r.events, messages: rm });
  check(rd.decision === 'NATIVE' && rd.latchTokens === 150010, 'a DSH surface replacement starts a new epoch (latch released by real shrink only)');
}

section('RC1.1-A7 FAIL CLOSED (unmeasurable -> NATIVE)');
{
  const s = sessionOf([usageOf(1000, 0)]);
  const none = gate.decideActivationV2({ mode: PRESSURE, route: ROUTE, events: null, messages: s.messages });
  check(none.decision === 'NATIVE' && none.reason === 'pressure-unmeasured' && none.detail === 'session-unavailable', 'no live session -> NATIVE pressure-unmeasured/session-unavailable');
  const noSample = sessionOf([undefined]);
  const ns = gate.decideActivationV2({ mode: PRESSURE, route: ROUTE, events: noSample.events, messages: noSample.messages });
  check(ns.decision === 'NATIVE' && ns.detail === 'no-usage-sample', 'no usage sample yet (first request) -> NATIVE');
  const malformed = sessionOf([{ inputTokens: 'x', outputTokens: 1 }]);
  const md = gate.decideActivationV2({ mode: PRESSURE, route: ROUTE, events: malformed.events, messages: malformed.messages });
  check(md.decision === 'NATIVE' && md.detail === 'no-usage-sample', 'malformed usage is no sample -> NATIVE');
  const mixed = sessionOf([usageOf(2000, 0), { inputTokens: -5, outputTokens: 0 }]);
  const mx = gate.decideActivationV2({ mode: PRESSURE, route: ROUTE, events: mixed.events, messages: mixed.messages });
  check(mx.decision === 'NATIVE' && mx.anchorTokens === 2000 && mx.deltaBoundTokens === deltaOf(mixed.messages, 1),
    'a malformed latest sample anchors on the last valid one (its message then counts as unmeasured delta: still an upper bound)');
  const unmatched = gate.decideActivationV2({ mode: PRESSURE, route: ROUTE, events: s.events, messages: s.messages.filter((m) => m.id !== 'a1') });
  check(unmatched.decision === 'NATIVE' && unmatched.detail === 'anchor-unmatched', 'anchor message absent from the request -> NATIVE anchor-unmatched');
  const latchedUnmatched = sessionOf([usageOf(T.activationTokens, 0)]);
  const lu = gate.decideActivationV2({ mode: PRESSURE, route: ROUTE, events: latchedUnmatched.events, messages: [] });
  check(lu.decision === 'ACTIVATE' && lu.reason === 'pressure-latched', 'latched epoch stays ACTIVATE even when the anchor cannot be matched');
  check(gate.decideActivationV2({ mode: { mode: 'never', valid: true }, route: ROUTE, events: s.events, messages: s.messages }).reason === 'activation-policy-invalid'
    && gate.decideActivationV2({ mode: gate.resolveActivationModeV2({ contextCompiler: { activation: 'bogus' } }), route: ROUTE, events: s.events, messages: s.messages }).decision === 'NATIVE',
    'invalid activation policy -> NATIVE activation-policy-invalid');
  const hiS = sessionOf([usageOf(900000, 0)]);
  check(gate.decideActivationV2({ mode: PRESSURE, route: null, events: hiS.events, messages: hiS.messages }).reason === 'activation-policy-invalid',
    'unknown route capability under pressure policy -> NATIVE (never guessed, even at high pressure)');
  check(gate.decideActivationV2(null).decision === 'NATIVE' && gate.decideActivationV2(undefined).decision === 'NATIVE', 'garbage input -> NATIVE, never throws');
  const forced = gate.decideActivationV2({ mode: ALWAYS, route: null, events: null, messages: [] });
  check(forced.decision === 'ACTIVATE' && forced.reason === 'activation-forced-by-policy', "'always' activates without consulting pressure (RC1 later gates still apply)");
}

section('RC1.1-A8 DETERMINISM + CONTENT-FREE TELEMETRY');
{
  const secret = 'TOP-SECRET-PROMPT-TEXT sk-abcdefghijklmnop';
  const s = sessionOf([usageOf(123456, 789)], { resultText: secret });
  const a = gate.decideActivationV2({ mode: PRESSURE, route: ROUTE, events: s.events, messages: s.messages });
  const b = gate.decideActivationV2({ mode: PRESSURE, route: ROUTE, events: clone(s.events), messages: clone(s.messages) });
  check(JSON.stringify(a) === JSON.stringify(b) && Object.isFrozen(a), 'same durable inputs -> identical frozen decision');
  const t = gate.activationTelemetryV2(a);
  check(JSON.stringify(t).indexOf('TOP-SECRET') === -1 && JSON.stringify(t).indexOf('sk-') === -1, 'telemetry carries no content');
  check(['activationDecision', 'activationReason', 'activationDetail', 'activationMode', 'activationPolicyRevision', 'activationBasis', 'activationTokens', 'pressureTokens',
    'pressureAnchorTokens', 'pressureDeltaBoundTokens', 'pressureLatchTokens', 'pressureUsageSamples'].every((k) => Object.prototype.hasOwnProperty.call(t, k))
    && t.activationPolicyRevision === 'ccv2-pressure-activation-v2-continuity-basis' && t.activationBasis === 'native-unsendable', 'telemetry fields are the closed set, policy revision and basis bound');
  check(gate.ACTIVATION_REASONS.indexOf(a.reason) !== -1, 'reason is in the closed reason set');
}

section('RC1.1-A9 FORENSIC REPLAY TOOL (scripts/CCv2-ActivationReplay.cjs)');
{
  const tool = require(path.join(repoRoot, 'scripts', 'CCv2-ActivationReplay.cjs'));
  // Native growth (prompt_k = prompt_k-1 + output_k-1 + small tool result),
  // then a compiled-size sample (900) followed by a native request (1300):
  // exactly the RC1 mixed-mode sequence the replay of real logs flagged.
  const s = sessionOf([usageOf(1000, 50), usageOf(1060, 70), usageOf(1140, 0), usageOf(900, 0), usageOf(1300, 0)], { resultText: 'SENTINEL-TOOL-OUTPUT' });
  const rows = tool.replayActivationV2(s.events, ROUTE, PRESSURE);
  check(rows.length === 5 && rows[0].reason === 'pressure-unmeasured' && rows.slice(1).every((r) => r.decision === 'NATIVE'),
    'replays one decision per root request at the request point', JSON.stringify(rows.map((r) => [r.decision, r.reason])));
  check(rows[1].actualPrompt === 1060 && rows[1].pressureTokens === 1050 + gate.messageBoundTokensV2(s.messages[2]) && rows[1].boundHolds === true
    && rows[2].boundHolds === true && rows[3].boundHolds === true, 'the pressure bound covers the provider prompt of the same request under native growth');
  const summary = tool.summarize(rows, T);
  check(summary.requests === 5 && summary.activate === 0 && summary.boundViolations.length === 1 && summary.boundViolations[0].step === 5,
    'a compiled-size anchor followed by a native request is reported as a violation (RC1 mixed mode; RC1.1 compiles only once latched)');
  check(JSON.stringify(summary).indexOf('SENTINEL') === -1 && JSON.stringify(rows).indexOf('SENTINEL') === -1, 'rows and summary are content-free');
  const latched = tool.replayActivationV2(sessionOf([usageOf(T.activationTokens + 1, 0), usageOf(300000, 0), usageOf(310000, 0)]).events, ROUTE, PRESSURE);
  check(latched[1].reason === 'pressure-at-or-above-threshold' && latched[2].reason === 'pressure-latched', 'crossing then compiled-size samples: at-or-above, then latched');
}

console.log(String.fromCharCode(10) + 'ContextActivationPressureV2: ' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed === 0 ? 0 : 1;
