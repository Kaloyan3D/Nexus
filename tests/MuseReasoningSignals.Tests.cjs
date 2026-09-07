'use strict';

/**
 * MuseReasoningSignals.Tests.cjs -- Phase 2.1 (TASK-0049) suite for the
 * model-facing reasoning-state signal (config/Muse-ReasoningSignals.cjs).
 *
 * Fully OFFLINE. The key trajectory test drives the REAL tool definition
 * captured from the production preset row (apply with a stub tools registry)
 * interleaved with the REAL Muse request boundary (Muse-Isolation.cjs
 * agent/request handler) -- never the runtime transition functions
 * directly. All other cases drive the same captured definition or the same
 * applyReasoningSignal core the row executes.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const isolation = require(path.join(repoRoot, 'config', 'Muse-Isolation.cjs'));
const runtime = require(path.join(repoRoot, 'config', 'Muse-ReasoningRuntime.cjs'));
const signals = require(path.join(repoRoot, 'config', 'Muse-ReasoningSignals.cjs'));
const governor = require(path.join(repoRoot, 'config', 'Muse-ReasoningGovernor.cjs'));

let passed = 0;
function pass(name) {
  passed += 1;
  console.log('PASS: ' + name);
}

// The REAL production tool definition, captured exactly as the preset row
// registers it (stub registry only captures; the definition is unmodified).
let signalTool = null;
{
  let captured = null;
  const returned = signals.apply({ tools: { register: (d) => { captured = d; } } });
  assert.ok(captured, 'row registers exactly one tool');
  assert.equal(captured, returned);
  signalTool = captured;
}

function makeInstallRoot(registryOverride) {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-sig-'));
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

function testBinding(installRoot, taskId, instanceId) {
  return { workspace: path.join(installRoot, 'ws'), taskId, taskInstanceId: instanceId, preset: 'aih-muse' };
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
    reasoning: 'xhigh', dataUseTier: 'contributor', contributorProtectionRequired: true,
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
  document.bindings[sessionId] = binding;
  fs.writeFileSync(bindingsPath, JSON.stringify(document), 'utf8');
}

function museSession(id) {
  return { id, events: [{ type: 'agent-preset/selected', data: { agentPreset: 'aih-muse' } }], header: {} };
}

function makeRequestCtx() {
  const handlers = {};
  return { handlers, on: (n, h) => { handlers[n] = h; }, shellEnv: { register: () => {} } };
}

// Model-facing invocation through the REAL tool definition: identity comes
// from the trusted exec context (agent session), never from arguments.
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

async function main() {
  const previousHome = process.env.DSH_HOME;
  const previousInstallRoot = process.env.AIH_INSTALL_ROOT;
  try {
    pass('0: production tool definition captured from the preset row (' + signalTool.name + ')');

    // -- Tool shape: Muse cannot see or set effort --
    assert.equal(signalTool.name, 'muse_update_reasoning_state');
    const paramNames = Object.keys(signalTool.parameters.properties || {});
    for (const forbidden of ['effort', 'reasoningEffort', 'reasoning_effort', 'failedHypotheses', 'failedImplementationAttempts', 'currentEffort', 'requestMax', 'workspace', 'taskInstanceId']) {
      assert.ok(!paramNames.includes(forbidden), 'schema exposes no ' + forbidden);
    }
    assert.deepEqual(signalTool.parameters.properties.phase.enum, ['discover', 'diagnose', 'design', 'implement', 'verify', 'recover', 'review']);
    pass('S: schema exposes state-only fields with a closed phase enum');
    assert.ok(signals.SIGNAL_DESCRIPTION.indexOf('HIGH') < 0 && signals.SIGNAL_DESCRIPTION.indexOf('xhigh') < 0);
    assert.ok(signals.SIGNAL_DESCRIPTION.indexOf('medium') < 0);
    pass('S2: tool instructions reveal no effort mechanics');

    console.log('PART-SHAPE-OK');

    // -- KEY ACCEPTANCE: real trajectory through the model-facing handler --
    // Every transition below passes through signalTool.execute (the exact
    // definition production Muse calls); every request passes through the
    // real isolation agent/request handler. Runtime functions are never
    // called directly in this test.
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-6001', 'inst-traj');
      writeState(installRoot, binding, museState('TASK-6001', 'inst-traj'));
      writeBindings(installRoot, 'sess-traj', binding);
      const requestCtx = makeRequestCtx();
      isolation.apply(requestCtx);
      const requestHandler = requestCtx.handlers['agent/request'];
      const session = museSession('sess-traj');
      let callSeq = 0;
      const signal = (s) => {
        callSeq += 1;
        return modelSignal(s, 'sess-traj', { rootCallId: 'traj-root-' + callSeq, callId: 'traj-call-' + callSeq, token: Symbol('traj-' + callSeq) });
      };
      const request = async () => {
        const enforced = await requestHandler(
          { agent: { session } },
          async () => ({ provider: 'x', model: 'y', reasoningEffort: 'xhigh' }),
        );
        return enforced.reasoningEffort;
      };

      // Request 1: no previous signal -> discover -> MEDIUM.
      const wireEfforts = [await request()];
      // Muse sends: phase = diagnose.
      await signal({ phase: 'diagnose' });
      // Request 2: diagnose -> HIGH.
      wireEfforts.push(await request());
      // Muse sends: rootCause + solution established, phase = implement.
      await signal({ markRootCauseEstablished: true, markSolutionEstablished: true, phase: 'implement' });
      // Request 3: implement with established solution -> MEDIUM.
      wireEfforts.push(await request());
      // Muse reports: implementation failure, phase = recover.
      await signal({ recordImplementationFailure: true, phase: 'recover' });
      // Request 4: recover -> HIGH.
      wireEfforts.push(await request());
      // Muse reports a second implementation failure.
      await signal({ recordImplementationFailure: true });
      // Request 5: failedImplementationAttempts = 2 -> XHIGH.
      wireEfforts.push(await request());

      assert.deepEqual(wireEfforts, ['medium', 'high', 'medium', 'high', 'xhigh']);
      pass('TRAJ: model-facing trajectory resolves medium/high/medium/high/xhigh on real requests');
    }

    console.log('PART-TRAJ-OK');

    // -- Validation 1-6 (all through the real tool definition) --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-6100', 'inst-v');
      writeState(installRoot, binding, museState('TASK-6100', 'inst-v'));
      writeBindings(installRoot, 'sess-v', binding);
      let seq = 100;
      const once = (s) => {
        seq += 1;
        return modelSignal(s, 'sess-v', { rootCallId: 'v-root-' + seq, callId: 'v-call-' + seq, token: Symbol('v' + seq) });
      };

      const okAck = await once({ phase: 'review' });
      assert.equal(okAck.ok, true);
      assert.equal(okAck.phase, 'review');
      pass('1: valid phase accepted');

      // Invalid enum members are rejected by the definition's own argument
      // validation (ToolArgsError) before execute runs; anything reaching
      // execute is re-checked as invalid-phase. Either way state is untouched.
      await assert.rejects(() => once({ phase: 'planning' }));
      assert.equal(readState(installRoot, binding).museReasoning.phase, 'review');
      pass('2: invalid phase rejected, state untouched');

      await assert.rejects(() => once({ phase: 'diagnose', bogusField: 1 }), /unknown-field/);
      pass('3: unknown signal fields rejected');

      await assert.rejects(() => once({ reasoningEffort: 'xhigh' }), /forbidden-field/);
      await assert.rejects(() => once({ reasoning_effort: 'high' }), /forbidden-field/);
      await assert.rejects(() => once({ effort: 'max' }), /forbidden-field/);
      pass('4: direct reasoningEffort field rejected');

      await assert.rejects(() => once({ failedImplementationAttempts: 100 }), /forbidden-field/);
      await assert.rejects(() => once({ failedHypotheses: 5 }), /forbidden-field/);
      pass('5: raw counter overwrite rejected');

      await assert.rejects(() => once({ currentEffort: 'xhigh' }), /forbidden-field/);
      pass('6: attempt to mutate currentEffort rejected');

      await assert.rejects(() => once({ requestMax: true }), /forbidden-field/);
      pass('6b: model-facing requestMax deferred (trusted API only)');
    }

    console.log('PART-VALIDATION-OK');

    // -- Monotonic signals 7-11 --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-6200', 'inst-m');
      writeState(installRoot, binding, museState('TASK-6200', 'inst-m'));
      writeBindings(installRoot, 'sess-m', binding);
      let seq = 200;
      const once = (s) => {
        seq += 1;
        return modelSignal(s, 'sess-m', { rootCallId: 'm-root-' + seq, callId: 'm-call-' + seq, token: Symbol('m' + seq) });
      };

      await once({ markRootCauseEstablished: true });
      assert.equal(readState(installRoot, binding).museReasoning.rootCauseEstablished, true);
      pass('7: root cause false -> true');

      // Explicit false is a no-op, never a revert.
      await once({ markRootCauseEstablished: false });
      assert.equal(readState(installRoot, binding).museReasoning.rootCauseEstablished, true);
      pass('8: model cannot casually revert root cause true -> false');

      await once({ markSolutionEstablished: true });
      await once({ markSolutionEstablished: false });
      assert.equal(readState(installRoot, binding).museReasoning.solutionEstablished, true);
      pass('9: solution established monotonic');

      const h1 = await once({ recordHypothesisFailure: true });
      assert.equal(h1.failedHypotheses, 1);
      const h2 = await once({ recordHypothesisFailure: true });
      assert.equal(h2.failedHypotheses, 2);
      const i1 = await once({ recordImplementationFailure: true });
      assert.equal(i1.failedImplementationAttempts, 1);
      pass('10: failure events increment by exactly one');

      await once({ conflictingEvidence: true });
      assert.equal(readState(installRoot, binding).museReasoning.conflictingEvidence, true);
      await once({ conflictingEvidence: false });
      assert.equal(readState(installRoot, binding).museReasoning.conflictingEvidence, true);
      pass('11: conflicting evidence is monotonic (no toggle spam)');
    }

    console.log('PART-MONOTONIC-OK');

    // -- Runtime 12-15 --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-6300', 'inst-r');
      writeState(installRoot, binding, museState('TASK-6300', 'inst-r'));
      writeBindings(installRoot, 'sess-r', binding);
      const requestCtx = makeRequestCtx();
      isolation.apply(requestCtx);
      const requestHandler = requestCtx.handlers['agent/request'];
      const session = museSession('sess-r');
      let seq = 300;
      const signal = (s) => {
        seq += 1;
        return modelSignal(s, 'sess-r', { rootCallId: 'r-root-' + seq, callId: 'r-call-' + seq, token: Symbol('r' + seq) });
      };
      const request = () => requestHandler(
        { agent: { session } },
        async () => ({ provider: 'x', model: 'y', reasoningEffort: 'xhigh' }),
      ).then((enforced) => enforced.reasoningEffort);

      // 12: a signal affects the NEXT request, never the in-flight one.
      const inFlight = await request();
      assert.equal(inFlight, 'medium');
      await signal({ phase: 'diagnose' });
      // The already-returned request is unchanged by the later signal...
      assert.equal(inFlight, 'medium');
      // ...while the next request resolves against the updated state.
      assert.equal(await request(), 'high');
      pass('12: signal affects next request, not the current request');

      // 13: profile xhigh still cannot override the Governor via signals.
      const stored = readState(installRoot, binding);
      assert.equal(stored.reasoning, 'high');
      pass('13: signal-driven Governor result owns state.reasoning over profile xhigh');

      // 15: currentEffort reflects the actual successful outbound effort.
      assert.equal(stored.museReasoning.currentEffort, 'high');
      pass('15: currentEffort reflects actual successful outbound effort');
    }

    // 14: capability failure still prevents the provider request.
    {
      const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'model-registry.json'), 'utf8'));
      const broken = JSON.parse(JSON.stringify(registry));
      broken.models.find((e) => e && e.id === 'muse-spark-1.3-contributor').supportedReasoningLevels = ['minimal'];
      const installRoot = makeInstallRoot(broken);
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = testBinding(installRoot, 'TASK-6301', 'inst-r2');
      writeState(installRoot, binding, museState('TASK-6301', 'inst-r2'));
      writeBindings(installRoot, 'sess-r2', binding);
      // The signal itself is accepted (state updates)...
      const ack = await modelSignal({ phase: 'diagnose' }, 'sess-r2', { rootCallId: 'r2-1', callId: 'r2-c1', token: Symbol('r2') });
      assert.equal(ack.phase, 'diagnose');
      // ...but the next provider request fails closed with the typed error.
      const requestCtx = makeRequestCtx();
      isolation.apply(requestCtx);
      let nextCalls = 0;
      await assert.rejects(
        () => requestCtx.handlers['agent/request'](
          { agent: { session: museSession('sess-r2') } },
          async () => { nextCalls += 1; return { provider: 'x', model: 'y' }; },
        ),
        (error) => error.code === 'nexus-muse-reasoning-capability-unavailable',
      );
      assert.equal(nextCalls, 0);
      pass('14: capability failure still prevents the provider request');
    }

    console.log('PART-RUNTIME-OK');

    // -- Isolation 16-17, duplicates 18, Muse-only 22 --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const bindingA = testBinding(installRoot, 'TASK-6400', 'inst-a');
      const bindingB = testBinding(installRoot, 'TASK-6401', 'inst-b');
      writeState(installRoot, bindingA, museState('TASK-6400', 'inst-a'));
      writeState(installRoot, bindingB, museState('TASK-6401', 'inst-b'));
      writeBindings(installRoot, 'sess-ia', bindingA);
      const bindingsPath = path.join(installRoot, 'data', 'routing', 'session-bindings.json');
      const doc = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'));
      doc.bindings['sess-ib'] = bindingB;
      fs.writeFileSync(bindingsPath, JSON.stringify(doc), 'utf8');

      await modelSignal({ phase: 'diagnose', recordHypothesisFailure: true }, 'sess-ia', { rootCallId: 'iso-1', callId: 'iso-c1', token: Symbol('iso1') });
      const stateB = readState(installRoot, bindingB);
      assert.equal(stateB.museReasoning, undefined);
      assert.equal(readState(installRoot, bindingA).museReasoning.phase, 'diagnose');
      pass('16: task A signal does not affect task B');

      // 17: a new task begins at discover/medium through the signal seam.
      const freshBinding = testBinding(installRoot, 'TASK-6402', 'inst-fresh');
      writeState(installRoot, freshBinding, museState('TASK-6402', 'inst-fresh'));
      writeBindings(installRoot, 'sess-fresh-tmp', freshBinding);
      const freshAck = await modelSignal({}, 'sess-fresh-tmp', { rootCallId: 'iso-f', callId: 'iso-cf', token: Symbol('isof') });
      assert.equal(freshAck.phase, 'discover');
      const requestCtx = makeRequestCtx();
      isolation.apply(requestCtx);
      const enforced = await requestCtx.handlers['agent/request'](
        { agent: { session: museSession('sess-fresh-tmp') } },
        async () => ({ provider: 'x', model: 'y', reasoningEffort: 'xhigh' }),
      );
      assert.equal(enforced.reasoningEffort, 'medium');
      pass('17: new task begins at discover/medium without any signal');

      // 18: redelivered identical failure events apply exactly once.
      const dupIds = { rootCallId: 'dup-root', callId: 'dup-call', token: Symbol('dup') };
      const first = await modelSignal({ recordImplementationFailure: true }, 'sess-ia', dupIds);
      assert.equal(first.duplicate, false);
      assert.equal(first.failedImplementationAttempts, 1);
      const second = await modelSignal({ recordImplementationFailure: true }, 'sess-ia', dupIds);
      assert.equal(second.duplicate, true);
      assert.equal(second.failedImplementationAttempts, 1);
      assert.equal(readState(installRoot, bindingA).museReasoning.failedImplementationAttempts, 1);
      pass('18: duplicate delivery of a failure event increments exactly once');

      // Dedup history survives intervening requests (resolution write-back
      // preserves processedSignalIds): the same redelivery still dedupes.
      const requestCtx18 = makeRequestCtx();
      isolation.apply(requestCtx18);
      await requestCtx18.handlers['agent/request'](
        { agent: { session: museSession('sess-ia') } },
        async () => ({ provider: 'x', model: 'y', reasoningEffort: 'xhigh' }),
      );
      const third = await modelSignal({ recordImplementationFailure: true }, 'sess-ia', dupIds);
      assert.equal(third.duplicate, true);
      assert.equal(readState(installRoot, bindingA).museReasoning.failedImplementationAttempts, 1);
      pass('18b: dedup history survives request resolution write-back');
    }

    // 22 + installation surface: the row exists only in the Muse preset.
    {
      const installerText = fs.readFileSync(path.join(repoRoot, 'scripts', 'Install-MusePreset.ps1'), 'utf8');
      assert.ok(installerText.includes("name: './Muse-ReasoningSignals.cjs'"));
      assert.ok(installerText.includes('aih-muse-reasoning-signals'));
      pass('22a: installer stages the signals row into the aih-muse preset');

      const composition = fs.readFileSync(path.join(repoRoot, 'data', '.agent-presets', 'aih-engineering', 'agent.cordis.yml'), 'utf8');
      assert.ok(!composition.includes('Muse-ReasoningSignals.cjs'));
      assert.ok(!composition.includes('muse_update_reasoning_state'));
      pass('22b: Dual preset carries no reasoning-signal surface');

      // Defense in depth: the core refuses unknown sessions and non-muse
      // bindings even if the tool were ever reached from the wrong plane.
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      writeBindings(installRoot, 'sess-dual-x', { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-6500', taskInstanceId: 'inst-dual', preset: 'aih-engineering' });
      await assert.rejects(
        () => modelSignal({ phase: 'diagnose' }, 'sess-dual-x', { rootCallId: 'dual-1', callId: 'dual-c1', token: Symbol('dual') }),
        (error) => error.code === 'nexus-muse-engine-mismatch',
      );
      await assert.rejects(
        () => modelSignal({ phase: 'diagnose' }, 'sess-ghost', { rootCallId: 'ghost-1', callId: 'ghost-c1', token: Symbol('ghost') }),
        (error) => error.code === 'nexus-execution-target-unavailable',
      );
      pass('22c: signals from wrong-plane or unbound sessions fail closed');
    }

    console.log('RESULT: ' + passed + ' MuseReasoningSignals assertions passed.');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    if (previousInstallRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = previousInstallRoot;
  }
}

main().then(
  () => {},
  (error) => {
    console.error('FAIL: MuseReasoningSignals suite failed: ' + String(error && error.stack ? error.stack : error));
    process.exit(1);
  },
);
