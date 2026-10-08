'use strict';

/**
 * MuseReasoningActivity.Tests.cjs -- Phase 2.2 (TASK-0049) suite for
 * trusted event-aware adaptive state (config/Muse-ReasoningActivity.cjs).
 *
 * Fully OFFLINE. The key trajectory tests drive the REAL tool definition
 * (muse_update_reasoning_state via signals.apply with a stub registry)
 * interleaved with the REAL Muse request boundary (Muse-Isolation.cjs
 * agent/request handler) and the TRUSTED observer path
 * (runtime.recordMuseToolOutcome with frozen pipeline-style exec/result
 * facts) -- never model prose, todo text, or descriptions. Governor policy
 * (phase mappings, xhigh thresholds, MAX, clamping) is never retuned here;
 * the suite asserts the quality of state ENTERING the Governor.
 *
 * Coverage (task §Required tests + §Benchmark regression):
 *  1. discover -> medium. 2. design -> high. 3. read/search during design
 *  leaves effective state semantic. 4. trusted mutation after design ->
 *  implementation-active. 5. next request uses implement policy -> medium.
 *  6. repeated mutations do not churn. 7. later semantic design supersedes
 *  earlier activity. 8. later mutation opens a new active period. 9.
 *  recognized verification -> operational state. 10. passed verification
 *  stays on verify path. 11. failed verification -> recovery-needed ->
 *  recover policy high. 12. arbitrary shell/tool failures imply no
 *  recovery. 13. tool failures never increment counters. 14. two real
 *  semantic failures still escalate per Governor. 15. activity never
 *  exposes effort. 16. retry/dedup correct. 17. persistence deterministic.
 *  18. Dual/GLM/Codex unchanged. 19. existing suites pass (harness-level).
 *  20. benchmark pattern: design -> mutations -> many requests -> verify
 *  cannot pin high.
 *
 * Phase 2.2-F1 hardening: recency-correct reduction (failed verification
 *  vs newer fix mutation, pairwise ordering, semantic supersede), a
 *  boundary-aware verification classifier (positives per family plus
 *  false-positive guards incl. look-alike nonzero exits), and bounded
 *  redacted observer-failure diagnostics that never break tool execution.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const { createPresetCtx } = require('./lib/AgentRequestComposition.cjs');
const isolation = require(path.join(repoRoot, 'config', 'Muse-Isolation.cjs'));
const runtime = require(path.join(repoRoot, 'config', 'Muse-ReasoningRuntime.cjs'));
const signals = require(path.join(repoRoot, 'config', 'Muse-ReasoningSignals.cjs'));
const activity = require(path.join(repoRoot, 'config', 'Muse-ReasoningActivity.cjs'));
const governor = require(path.join(repoRoot, 'config', 'Muse-ReasoningGovernor.cjs'));

let passed = 0;
function pass(name) {
  passed += 1;
  console.log('PASS: ' + name);
}

let signalTool = null;
{
  let captured = null;
  const returned = signals.apply({ tools: { register: (d) => { captured = d; } } });
  assert.ok(captured, 'row registers exactly one tool');
  assert.equal(captured, returned);
  signalTool = captured;
}

function makeInstallRoot(registryOverride) {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-act-'));
  fs.mkdirSync(path.join(installRoot, 'data', 'routing', 'states'), { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'config'), { recursive: true });
  if (registryOverride === undefined) {
    fs.copyFileSync(
      path.join(repoRoot, 'config', 'model-registry.json'),
      path.join(installRoot, 'config', 'model-registry.json'),
    );
  } else if (registryOverride !== null) {
    fs.writeFileSync(path.join(installRoot, 'config', 'model-registry.json'), JSON.stringify(registryOverride), 'utf8');
  }
  return installRoot;
}

function testBinding(installRoot, taskId, instanceId, preset) {
  return { workspace: path.join(installRoot, 'ws'), taskId, taskInstanceId: instanceId, preset: preset || 'aih-muse' };
}

function statePathFor(installRoot, binding) {
  const resolvedWorkspace = path.resolve(binding.workspace);
  const workspace = process.platform === 'win32' ? resolvedWorkspace.toLowerCase() : resolvedWorkspace;
  const key = [workspace, 'aih-muse', binding.taskInstanceId].join(String.fromCharCode(10));
  return path.join(installRoot, 'data', 'routing', 'states', crypto.createHash('sha256').update(key, 'utf8').digest('hex') + '.json');
}

function museState(taskId, instanceId, overrides) {
  return Object.assign({
    taskId, taskInstanceId: instanceId,
    preset: 'aih-muse', engine: 'muse', executionClass: 'engineer_normal', role: null,
    profile: 'muse-spark-1.3-contributor', profileDisplayName: 'Muse Spark 1.3 Contributor',
    provider: 'meta-model-api', model: 'muse-spark-1.3-contributor', modelDisplayName: 'Muse Spark 1.3 Contributor',
    reasoning: 'xhigh', dataUseTier: 'contributor',
  }, overrides || {});
}

function writeState(installRoot, binding, state) {
  fs.writeFileSync(statePathFor(installRoot, binding), JSON.stringify(state), 'utf8');
}

function readState(installRoot, binding) {
  return JSON.parse(fs.readFileSync(statePathFor(installRoot, binding), 'utf8'));
}

function writeBindings(installRoot, sessionId, binding) {
  const bindingsPath = path.join(installRoot, 'data', 'routing', 'session-bindings.json');
  fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
  let document = { schemaVersion: 1, bindings: {} };
  try { document = JSON.parse(fs.readFileSync(bindingsPath, 'utf8')); } catch { /* fresh fixture */ }
  document.bindings = document.bindings || {};
  document.bindings[sessionId] = Object.assign({ engine: 'muse' }, binding);
  fs.writeFileSync(bindingsPath, JSON.stringify(document), 'utf8');
}

function museSession(id) {
  return { id, events: [{ type: 'agent-preset/selected', data: { agentPreset: 'aih-muse' } }], header: {} };
}

function makeRequestCtx() {
  return createPresetCtx();
}

function modelSignal(signal, sessionId, callIds) {
  const ids = callIds || {};
  const exec = {
    agent: { session: { id: sessionId } },
    rootCallId: ids.rootCallId !== undefined ? ids.rootCallId : 'root-' + Math.random().toString(36).slice(2),
    callId: ids.callId !== undefined ? ids.callId : 'call-' + Math.random().toString(36).slice(2),
    token: ids.token !== undefined ? ids.token : Symbol('test-token'),
    signal: undefined,
  };
  return signalTool.execute(signal, exec);
}

// Frozen pipeline-style facts for the trusted observer path.
function toolExec(name, args) {
  return { name, arguments: args || {}, agent: { session: { id: 'sess-x' } }, callId: 'c1', token: Symbol('t') };
}
function okResult(value) {
  return { isError: false, value: value === undefined ? { ok: true } : value, content: [{ type: 'text', text: 'ok' }] };
}
function errResult() {
  return { isError: true, error: { message: 'boom' }, content: [{ type: 'text', text: 'Error: boom' }] };
}
function fgResult(exitCode) {
  return { isError: false, value: { kind: 'foreground', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }, content: [{ type: 'text', text: 'done' }] };
}
async function main() {
  const previousHome = process.env.DSH_HOME;
  const previousInstallRoot = process.env.AIH_INSTALL_ROOT;
  try {
    // -- 1+2: initial discover -> medium; semantic design -> high --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-7001', 'inst-12');
      writeState(installRoot, binding, museState('TASK-7001', 'inst-12'));
      writeBindings(installRoot, 'sess-12', binding);
      const requestCtx = makeRequestCtx();
      isolation.apply(requestCtx);
      const handler = requestCtx.handlers['agent/request'];
      const session = museSession('sess-12');
      const request = () => handler({ agent: { session } }, async () => ({ provider: 'x', model: 'y' })).then((r) => r.reasoningEffort);
      assert.equal(await request(), 'medium');
      pass('1: initial discover resolves medium');
      let seq = 0;
      const signal = (s) => { seq += 1; return modelSignal(s, 'sess-12', { rootCallId: 's12-' + seq, callId: 's12c-' + seq, token: Symbol('s12' + seq) }); };
      await signal({ phase: 'design' });
      assert.equal(readState(installRoot, binding).museReasoning.phase, 'design');
      assert.equal(await request(), 'high');
      pass('2: semantic design resolves high');

      // -- 3: read/search activity during design does not alter effective state --
      const before = JSON.stringify(readState(installRoot, binding).museActivity || null);
      for (const outcome of [
        runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('read', { file_path: 'a.ts' }), result: okResult() }),
        runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('grep', { pattern: 'x' }), result: okResult() }),
        runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('glob', { pattern: '**/*.ts' }), result: okResult() }),
        runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('pwsh', { command: 'git status', description: 'Show working tree status' }), result: fgResult(0) }),
      ]) {
        assert.equal(outcome.classification.kind, 'ignored');
        assert.equal(outcome.activity, null);
      }
      assert.equal(JSON.stringify(readState(installRoot, binding).museActivity || null), before);
      assert.equal(await request(), 'high');
      const eff3 = runtime.effectiveMuseStateOf(readState(installRoot, binding));
      assert.equal(eff3.source, 'semantic');
      assert.equal(eff3.effectivePhase, 'design');
      pass('3: read/search/generic-shell during design leaves effective state semantic');

      // -- 4+5: trusted mutation after design -> implementation-active -> medium --
      const mut = runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('edit', { file_path: 'a.ts' }), result: okResult() });
      assert.equal(mut.classification.kind, 'mutation');
      assert.equal(readState(installRoot, binding).museReasoning.phase, 'design');
      pass('4a: successful mutation does NOT rewrite semantic.phase');
      const eff4 = runtime.effectiveMuseStateOf(readState(installRoot, binding));
      assert.equal(eff4.source, 'implementation-active');
      assert.equal(eff4.effectivePhase, 'implement');
      pass('4b: trusted mutation after design yields implementation-active');
      assert.equal(await request(), 'medium');
      pass('5: next request resolves via existing implement policy to medium');

      // -- 6: repeated mutations do not churn --
      const revBefore = readState(installRoot, binding).museActivity.revision;
      const lastMutBefore = readState(installRoot, binding).museActivity.lastMutationRevision;
      for (let i = 0; i < 20; i += 1) {
        runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('edit', { file_path: 'a.ts' }), result: okResult() });
      }
      const afterRep = readState(installRoot, binding).museActivity;
      assert.equal(afterRep.lastMutationRevision, lastMutBefore);
      assert.equal(afterRep.revision, revBefore);
      assert.equal(afterRep.mutationCount, 21);
      assert.equal(await request(), 'medium');
      pass('6: twenty more edits stay implementation-active without milestone churn');

      // -- 7+8: later semantic design supersedes; later mutation re-opens --
      await signal({ phase: 'design' });
      const eff7 = runtime.effectiveMuseStateOf(readState(installRoot, binding));
      assert.equal(eff7.source, 'semantic');
      assert.equal(await request(), 'high');
      pass('7: later explicit design supersedes earlier implementation activity');
      runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('write', { file_path: 'b.ts' }), result: okResult() });
      const eff8 = runtime.effectiveMuseStateOf(readState(installRoot, binding));
      assert.equal(eff8.source, 'implementation-active');
      assert.equal(await request(), 'medium');
      pass('8: later trusted mutation establishes a new implementation-active period');
    }

    console.log('PART-IMPL-OK');

    // -- 9+10+11: verification lifecycle --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-7010', 'inst-v');
      writeState(installRoot, binding, museState('TASK-7010', 'inst-v'));
      writeBindings(installRoot, 'sess-v', binding);
      const requestCtx = makeRequestCtx();
      isolation.apply(requestCtx);
      const handler = requestCtx.handlers['agent/request'];
      const session = museSession('sess-v');
      const request = () => handler({ agent: { session } }, async () => ({ provider: 'x', model: 'y' })).then((r) => r.reasoningEffort);
      let seq = 0;
      const signal = (s) => { seq += 1; return modelSignal(s, 'sess-v', { rootCallId: 'sv-' + seq, callId: 'svc-' + seq, token: Symbol('sv' + seq) }); };
      await signal({ phase: 'verify' });
      const started = runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('pwsh', { command: 'npm test', description: 'Run test suite' }), result: { isError: false, value: { kind: 'background', jobId: 'j1' }, content: [{ type: 'text', text: 'started' }] } });
      assert.equal(started.classification.kind, 'verification');
      assert.equal(started.classification.outcome, 'started');
      const effS = runtime.effectiveMuseStateOf(readState(installRoot, binding));
      assert.equal(effS.effectivePhase, 'verify');
      pass('9: recognized verification activity produces verification operational state');
      runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('pwsh', { command: 'npm test', description: 'Run test suite' }), result: fgResult(0) });
      const effP = runtime.effectiveMuseStateOf(readState(installRoot, binding));
      assert.equal(effP.source, 'verification-passed');
      assert.equal(await request(), 'medium');
      pass('10: successful verification remains on the normal verify path (medium)');
      await signal({ phase: 'implement' });
      runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('write', { file_path: 'c.ts' }), result: okResult() });
      await signal({ phase: 'verify' });
      runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('pwsh', { command: 'npm test', description: 'Run test suite' }), result: fgResult(1) });
      const effF = runtime.effectiveMuseStateOf(readState(installRoot, binding));
      assert.equal(effF.source, 'recovery-needed');
      assert.equal(effF.effectivePhase, 'recover');
      assert.equal(readState(installRoot, binding).museReasoning.phase, 'verify');
      assert.equal(await request(), 'high');
      pass('11: failed verification -> recovery-needed -> existing recover policy high, semantic phase untouched');
    }

    console.log('PART-VERIFY-OK');
    // -- 12+13: arbitrary failures imply nothing --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-7020', 'inst-f');
      writeState(installRoot, binding, museState('TASK-7020', 'inst-f'));
      writeBindings(installRoot, 'sess-f', binding);
      let seq = 0;
      const signal = (s) => { seq += 1; return modelSignal(s, 'sess-f', { rootCallId: 'sf-' + seq, callId: 'sfc-' + seq, token: Symbol('sf' + seq) }); };
      await signal({ phase: 'design' });
      const requestCtx = makeRequestCtx();
      isolation.apply(requestCtx);
      const handler = requestCtx.handlers['agent/request'];
      const session = museSession('sess-f');
      const request = () => handler({ agent: { session } }, async () => ({ provider: 'x', model: 'y' })).then((r) => r.reasoningEffort);
      const outcomes = [
        runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('edit', { file_path: 'x.ts' }), result: errResult() }),
        runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('pwsh', { command: 'git status', description: 'Show working tree status' }), result: fgResult(1) }),
        runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('pwsh', { command: 'node test.js', description: 'Run ad-hoc script' }), result: fgResult(1) }),
        runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('pwsh', { command: 'npm test', description: 'Run test suite' }), result: errResult() }),
        runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('read', { file_path: 'x.ts' }), result: errResult() }),
      ];
      for (const o of outcomes) assert.equal(o.classification.kind, 'ignored');
      const st = readState(installRoot, binding);
      assert.equal(runtime.effectiveMuseStateOf(st).source, 'semantic');
      assert.equal(st.museReasoning.failedHypotheses, 0);
      assert.equal(st.museReasoning.failedImplementationAttempts, 0);
      assert.equal(await request(), 'high');
      pass('12: arbitrary failed shell/tool operations do not imply recovery');
      pass('13: arbitrary tool failures never increment hypothesis/implementation counters');

      // -- 14: two real semantic failures still escalate --
      await signal({ phase: 'diagnose' });
      await signal({ recordHypothesisFailure: true });
      await signal({ recordHypothesisFailure: true });
      assert.equal(await request(), 'xhigh');
      pass('14: two real semantic failure events still escalate per Governor (xhigh)');
    }

    console.log('PART-NOISE-OK');

    // -- 15: activity never exposes effort; ack carries safe labels only --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-7030', 'inst-ack');
      writeState(installRoot, binding, museState('TASK-7030', 'inst-ack'));
      writeBindings(installRoot, 'sess-ack', binding);
      const ack = await modelSignal({ phase: 'design' }, 'sess-ack', { rootCallId: 'ack-1', callId: 'ack-c1', token: Symbol('ack') });
      assert.ok(!Object.keys(ack).includes('effort'));
      assert.ok(!Object.keys(ack).includes('reasoningEffort'));
      assert.ok(!Object.keys(ack).includes('reasoning_effort'));
      assert.ok(!Object.keys(ack).includes('currentEffort'));
      assert.ok(!Object.keys(ack).includes('lastResolution'));
      assert.ok(['none', 'implementation-active', 'verification-passed', 'recovery-needed'].includes(ack.activityState));
      assert.ok(JSON.stringify(ack).indexOf('xhigh') < 0 && JSON.stringify(ack).indexOf('medium') < 0);
      runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('edit', { file_path: 'z.ts' }), result: okResult() });
      const ack2 = await modelSignal({ phase: 'design' }, 'sess-ack', { rootCallId: 'ack-2', callId: 'ack-c2', token: Symbol('ack2') });
      assert.equal(ack2.activityState, 'none');
      runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('edit', { file_path: 'z.ts' }), result: okResult() });
      const stored = readState(installRoot, binding);
      assert.equal(runtime.effectiveMuseStateOf(stored).activityState, 'implementation-active');
      pass('15: activity-derived state never exposes reasoning effort to Muse');
    }

    // -- 16: retry/dedup remains correct --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-7040', 'inst-dedup');
      writeState(installRoot, binding, museState('TASK-7040', 'inst-dedup'));
      writeBindings(installRoot, 'sess-dedup', binding);
      const ids = { rootCallId: 'dd-root', callId: 'dd-call', token: Symbol('dd') };
      const first = await modelSignal({ recordImplementationFailure: true }, 'sess-dedup', ids);
      assert.equal(first.duplicate, false);
      const second = await modelSignal({ recordImplementationFailure: true }, 'sess-dedup', ids);
      assert.equal(second.duplicate, true);
      assert.equal(readState(installRoot, binding).museReasoning.failedImplementationAttempts, 1);
      runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('edit', { file_path: 'd.ts' }), result: okResult() });
      const third = await modelSignal({ recordImplementationFailure: true }, 'sess-dedup', ids);
      assert.equal(third.duplicate, true);
      pass('16: retry/deduplication remains correct alongside activity writes');
    }

    // -- 17: persistence and restart/reload deterministic --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-7050', 'inst-persist');
      writeState(installRoot, binding, museState('TASK-7050', 'inst-persist'));
      writeBindings(installRoot, 'sess-persist', binding);
      let seq = 0;
      const signal = (s) => { seq += 1; return modelSignal(s, 'sess-persist', { rootCallId: 'sp-' + seq, callId: 'spc-' + seq, token: Symbol('sp' + seq) }); };
      await signal({ phase: 'design' });
      runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('edit', { file_path: 'p.ts' }), result: okResult() });
      const snapA = JSON.stringify(readState(installRoot, binding).museActivity);
      const effA = JSON.stringify(runtime.effectiveMuseStateOf(readState(installRoot, binding)));
      delete require.cache[require.resolve(path.join(repoRoot, 'config', 'Muse-ReasoningRuntime.cjs'))];
      delete require.cache[require.resolve(path.join(repoRoot, 'config', 'Muse-ReasoningActivity.cjs'))];
      const runtime2 = require(path.join(repoRoot, 'config', 'Muse-ReasoningRuntime.cjs'));
      const snapB = JSON.stringify(runtime2.museActivityStateOf(readState(installRoot, binding)));
      const effB = JSON.stringify(runtime2.effectiveMuseStateOf(readState(installRoot, binding)));
      assert.equal(snapB, snapA);
      assert.equal(effB, effA);
      assert.throws(() => runtime2.museActivityStateOf({ museActivity: { schemaVersion: 999, revision: 0, semanticRevision: 0, lastMutationRevision: 0, mutationCount: 0, verification: { status: 'none', revision: 0, family: null } } }), /schemaVersion/);
      pass('17: state persistence and restart/reload behavior are deterministic');
    }

    // -- 18: Dual/GLM/Codex unchanged --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const dualBinding = testBinding(installRoot, 'TASK-7060', 'inst-dual', 'aih-engineering');
      writeState(installRoot, dualBinding, museState('TASK-7060', 'inst-dual'));
      writeBindings(installRoot, 'sess-dual', dualBinding);
      await assert.rejects(
        () => modelSignal({ phase: 'diagnose' }, 'sess-dual', { rootCallId: 'dual-1', callId: 'dual-c1', token: Symbol('dual') }),
        (error) => error.code === 'nexus-muse-engine-mismatch',
      );
      assert.throws(
        () => runtime.recordMuseToolOutcome({ installRoot, binding: dualBinding, exec: toolExec('edit', { file_path: 'q.ts' }), result: okResult() }),
        (error) => error.code === 'nexus-muse-engine-mismatch',
      );
      const dualDoc = JSON.parse(fs.readFileSync(statePathFor(installRoot, testBinding(installRoot, 'TASK-7060', 'inst-dual')), 'utf8'));
      assert.equal(dualDoc.museActivity, undefined);
      const composition = fs.readFileSync(path.join(repoRoot, 'data', '.agent-presets', 'aih-engineering', 'agent.cordis.yml'), 'utf8');
      assert.ok(!composition.includes('Muse-ReasoningActivity.cjs'));
      assert.ok(!composition.includes('muse_update_reasoning_state'));
      assert.deepEqual(governor.DEFAULT_MUSE_PHASE_EFFORT, { discover: 'medium', diagnose: 'high', design: 'high', implement: 'medium', verify: 'medium', recover: 'high', review: 'high' });
      assert.equal(governor.MUSE_ESCALATION_FAILURE_THRESHOLD, 2);
      pass('18: Dual/GLM/Codex behavior remains unchanged; Governor policy untouched');
    }

    console.log('PART-EDGE-OK');
    // -- 20 (benchmark regression): design -> mutations -> many requests -> verify --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-7100', 'inst-bench');
      writeState(installRoot, binding, museState('TASK-7100', 'inst-bench'));
      writeBindings(installRoot, 'sess-bench', binding);
      const requestCtx = makeRequestCtx();
      isolation.apply(requestCtx);
      const handler = requestCtx.handlers['agent/request'];
      const session = museSession('sess-bench');
      const request = () => handler({ agent: { session } }, async () => ({ provider: 'x', model: 'y' })).then((r) => r.reasoningEffort);
      let seq = 0;
      const signal = (s) => { seq += 1; return modelSignal(s, 'sess-bench', { rootCallId: 'sb-' + seq, callId: 'sbc-' + seq, token: Symbol('sb' + seq) }); };
      const wireEfforts = [await request()];
      await signal({ phase: 'design' });
      wireEfforts.push(await request());
      runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('write', { file_path: 'impl-a.ts' }), result: okResult() });
      for (let i = 0; i < 30; i += 1) {
        runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('edit', { file_path: 'impl-a.ts' }), result: okResult() });
        wireEfforts.push(await request());
      }
      await signal({ phase: 'verify' });
      wireEfforts.push(await request());
      assert.equal(wireEfforts[0], 'medium');
      assert.equal(wireEfforts[1], 'high');
      assert.ok(wireEfforts.slice(2, 32).every((e) => e === 'medium'), 'implementation period must not run under design/high');
      assert.equal(wireEfforts[32], 'medium');
      const semanticPhase = readState(installRoot, binding).museReasoning.phase;
      assert.equal(semanticPhase, 'verify');
      pass('20: benchmark pattern cannot pin design/high across implementation (medium throughout)');
    }


    console.log('PART-BENCH-OK');

    // -- F1-RECENCY: verify -> fail -> recover -> fix mutation -> implement -> fail -> recover -> diagnose --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-7200', 'inst-recency');
      writeState(installRoot, binding, museState('TASK-7200', 'inst-recency'));
      writeBindings(installRoot, 'sess-recency', binding);
      const requestCtx = makeRequestCtx();
      isolation.apply(requestCtx);
      const handler = requestCtx.handlers['agent/request'];
      const session = museSession('sess-recency');
      const request = () => handler({ agent: { session } }, async () => ({ provider: 'x', model: 'y' })).then((r) => r.reasoningEffort);
      let seq = 0;
      const signal = (s) => { seq += 1; return modelSignal(s, 'sess-recency', { rootCallId: 'sr-' + seq, callId: 'src-' + seq, token: Symbol('sr' + seq) }); };
      const verFail = () => runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('pwsh', { command: 'npm test', description: 'Run test suite' }), result: fgResult(1) });
      const fixMut = () => runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('edit', { file_path: 'fix.ts' }), result: okResult() });
      await signal({ phase: 'verify' });
      assert.equal(await request(), 'medium');
      pass('F1-R1: semantic verify resolves medium');
      const vf = verFail();
      assert.equal(vf.classification.kind, 'verification');
      assert.equal(vf.classification.outcome, 'failed');
      let eff = runtime.effectiveMuseStateOf(readState(installRoot, binding));
      assert.equal(eff.source, 'recovery-needed');
      assert.equal(eff.effectivePhase, 'recover');
      assert.equal(await request(), 'high');
      pass('F1-R2: failed verification -> recover -> existing recover policy high');
      const fm = fixMut();
      assert.equal(fm.classification.kind, 'mutation');
      eff = runtime.effectiveMuseStateOf(readState(installRoot, binding));
      assert.equal(eff.source, 'implementation-active');
      assert.equal(eff.effectivePhase, 'implement');
      assert.equal(readState(installRoot, binding).museReasoning.phase, 'verify');
      assert.equal(await request(), 'medium');
      pass('F1-R3: newer fix mutation supersedes older failure -> implement/medium, semantic untouched');
      verFail();
      eff = runtime.effectiveMuseStateOf(readState(installRoot, binding));
      assert.equal(eff.source, 'recovery-needed');
      assert.equal(await request(), 'high');
      pass('F1-R4: newer verification failure wins again -> recover/high');
      await signal({ phase: 'diagnose' });
      eff = runtime.effectiveMuseStateOf(readState(installRoot, binding));
      assert.equal(eff.source, 'semantic');
      assert.equal(eff.effectivePhase, 'diagnose');
      assert.equal(await request(), 'high');
      pass('F1-R5: explicit diagnose after both supersedes all activity');
    }

    console.log('PART-F1-RECENCY-OK');

    // -- F1-ORDER: pairwise revision ordering without requests --
    {
      let a = activity.markSemanticTransition(activity.createMuseActivityState(), 'verify');
      a = activity.applyClassification(a, { kind: 'mutation' });
      a = activity.applyClassification(a, { kind: 'verification', family: 'node-test', outcome: 'failed' });
      assert.equal(activity.reduceEffectiveState({ phase: 'verify', activity: a }).source, 'recovery-needed');
      pass('F1-O1: older mutation + newer failure -> recover');
      let b = activity.markSemanticTransition(activity.createMuseActivityState(), 'verify');
      b = activity.applyClassification(b, { kind: 'verification', family: 'node-test', outcome: 'failed' });
      b = activity.applyClassification(b, { kind: 'mutation' });
      const rb = activity.reduceEffectiveState({ phase: 'verify', activity: b });
      assert.equal(rb.source, 'implementation-active');
      assert.equal(rb.effectivePhase, 'implement');
      pass('F1-O2: older failure + newer mutation -> implement');
      const c = activity.markSemanticTransition(b, 'diagnose');
      const rc = activity.reduceEffectiveState({ phase: 'diagnose', activity: c });
      assert.equal(rc.source, 'semantic');
      assert.equal(rc.effectivePhase, 'diagnose');
      pass('F1-O3: new semantic transition after both -> semantic wins');
    }

    console.log('PART-F1-ORDER-OK');

    // -- F1-CLASSIFIER positives: every supported family --
    {
      const positives = [
        ['npm test', 'node-test'],
        ['npm run typecheck', 'typecheck'],
        ['npm run verify', 'verify-script'],
        ['pnpm test', 'node-test'],
        ['pnpm run lint', 'lint'],
        ['pnpm --filter @scope/pkg typecheck', 'typecheck'],
        ['pnpm --filter ./apps/mobile build', 'build'],
        ['pnpm --filter @openrank/mobile typecheck', 'typecheck'],
        ['yarn test', 'node-test'],
        ['yarn lint', 'lint'],
        ['bun test', 'node-test'],
        ['bun run build', 'build'],
        ['npx vitest', 'node-test'],
        ['npx jest', 'node-test'],
        ['tsc --noEmit', 'typecheck'],
        ['pytest', 'python-test'],
        ['python -m pytest', 'python-test'],
        ['python -m unittest discover', 'python-test'],
        ['dotnet test', 'dotnet-test'],
        ['dotnet build Foo.sln', 'dotnet-build'],
        ['cargo test', 'rust-test'],
        ['cargo build --release', 'rust-build'],
        ['go test ./...', 'go-test'],
      ];
      for (const pair of positives) {
        const got = activity.classifyVerificationCommand(pair[0]);
        assert.equal(got, pair[1], 'positive: ' + pair[0]);
      }
      pass('F1-C1: representative supported verification forms recognized');
    }

    // -- F1-CLASSIFIER negatives: false-positive guards --
    {
      const negatives = [
        'git grep Verify',
        'git diff -- Verify-Project.ps1',
        'Get-Content Verify-Project.ps1',
        'rg test src',
        'git status',
        'echo run tests later',
        'node scripts/build-manifest.js',
        'node test.js',
        'npm install',
        'pnpm add foo',
        'npm run tests',
        'node scripts/verify-manifest.js',
      ];
      for (const cmd of negatives) {
        assert.equal(activity.classifyVerificationCommand(cmd), null, 'negative: ' + cmd);
      }
      // A nonzero exit from a look-alike command must NOT imply recovery.
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-7210', 'inst-falsepos');
      writeState(installRoot, binding, museState('TASK-7210', 'inst-falsepos'));
      writeBindings(installRoot, 'sess-falsepos', binding);
      let seq = 0;
      const signal = (s) => { seq += 1; return modelSignal(s, 'sess-falsepos', { rootCallId: 'sfp-' + seq, callId: 'sfpc-' + seq, token: Symbol('sfp' + seq) }); };
      await signal({ phase: 'verify' });
      const requestCtx = makeRequestCtx();
      isolation.apply(requestCtx);
      const handler = requestCtx.handlers['agent/request'];
      const session = museSession('sess-falsepos');
      const request = () => handler({ agent: { session } }, async () => ({ provider: 'x', model: 'y' })).then((r) => r.reasoningEffort);
      for (const cmd of negatives) {
        const o = runtime.recordMuseToolOutcome({ installRoot, binding, exec: toolExec('pwsh', { command: cmd, description: 'Probe command' }), result: fgResult(1) });
        assert.equal(o.classification.kind, 'ignored', 'pipeline-ignore: ' + cmd);
      }
      assert.equal(runtime.effectiveMuseStateOf(readState(installRoot, binding)).source, 'semantic');
      assert.equal(await request(), 'medium');
      pass('F1-C2: look-alike failures never imply recovery (stays verify/medium)');
    }

    console.log('PART-F1-CLASSIFIER-OK');

    // -- F1-DIAGNOSTIC: observer failures are visible but never break tools --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-7220', 'inst-diag');
      writeState(installRoot, binding, museState('TASK-7220', 'inst-diag'));
      writeBindings(installRoot, 'sess-diag', binding);
      const warnings = [];
      const diagCtx = { tools: { register: () => {} }, on: () => {}, logger: { warn: (m) => warnings.push(String(m)) } };
      const execM = { name: 'edit', arguments: { file_path: 'secret-plan.ts' }, agent: { session: { id: 'sess-diag' } }, callId: 'c9', token: Symbol('diag') };
      const resOk = { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'ok' }] };
      const execR = { name: 'read', arguments: { file_path: 'notes.md' }, agent: { session: { id: 'sess-diag' } }, callId: 'c10', token: Symbol('diag2') };
      const realRecord = runtime.recordMuseToolOutcome;
      let calls = 0;
      runtime.recordMuseToolOutcome = function (args) { calls += 1; throw new Error('simulated persistence failure with TOP-SECRET payload'); };
      let hook = null;
      try {
        const out = signals.observeMuseToolResult({ installRoot, binding, exec: execM, result: resOk, onObserverFailure: (d) => { hook = d; } });
        assert.equal(out, null);
      } finally { runtime.recordMuseToolOutcome = realRecord; }
      assert.equal(calls, 1);
      assert.ok(hook && hook.code === signals.MUSE_ACTIVITY_OBSERVER_DIAG_CODE);
      pass('F1-D1: persistence failure returns null without throwing (tool outcome untouched)');
      const emitted = signals.emitObserverDiagnostic(diagCtx, execM, signals.MUSE_ACTIVITY_OBSERVER_DIAG_CODE);
      assert.equal(emitted, true);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].indexOf('nexus-muse-activity-observe-failed') >= 0);
      assert.ok(warnings[0].indexOf('tool=edit') >= 0);
      assert.ok(warnings[0].indexOf('secret-plan.ts') < 0);
      assert.ok(warnings[0].indexOf('TOP-SECRET') < 0);
      pass('F1-D2: diagnostic is bounded, carries stable code + tool name, leaks no payload');
      const w2 = [];
      const silentCtx = { tools: { register: () => {} }, on: () => {}, logger: { warn: (m) => w2.push(String(m)) } };
      const ignored = signals.observeMuseToolResult({ installRoot, binding, exec: execR, result: resOk });
      assert.ok(ignored === null || ignored.classification.kind === 'ignored');
      const okOut = signals.observeMuseToolResult({ installRoot, binding, exec: execM, result: resOk });
      assert.equal(okOut.classification.kind, 'mutation');
      assert.equal(w2.length, 0);
      pass('F1-D3: ignored tools and successful observations emit no warning');
    }

    console.log('PART-F1-DIAGNOSTIC-OK');
    console.log('RESULT: ' + passed + ' MuseReasoningActivity assertions passed.');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    if (previousInstallRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = previousInstallRoot;
  }
}

main().then(
  () => { /* harness reads PASS lines */ },
  (error) => {
    console.error('FAIL: MuseReasoningActivity suite failed: ' + String(error && error.stack ? error.stack : error));
    process.exit(1);
  },
);
