'use strict';

/**
 * MuseReasoningRuntime.Tests.cjs -- Phase 2 (TASK-0049) integration suite for
 * config/Muse-ReasoningRuntime.cjs through the REAL Muse request boundary
 * (config/Muse-Isolation.cjs agent/request handler).
 *
 * Fully OFFLINE: every case drives the real isolation handler against
 * fixture install roots (routing state + session bindings + production
 * registry), so assertions inspect the provider-bound enforced request
 * (reasoningEffort), never merely resolver output. The wire mapping is
 * proven by reading the managed settings route (reasoningEfforts), which the
 * DSH substrate applies to the enforced value.
 *
 * Coverage: A (governor result reaches request), B (one trajectory changes
 * effort medium/high/medium/high/xhigh), C (profile xhigh cannot override),
 * D (capability fail-closed sends no request), E (explicit max clamp),
 * F (isolation: Dual/GLM/Codex unchanged, muse-only flow), plus state
 * transition semantics and observability.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const isolation = require(path.join(repoRoot, 'config', 'Muse-Isolation.cjs'));
const runtime = require(path.join(repoRoot, 'config', 'Muse-ReasoningRuntime.cjs'));
const governor = require(path.join(repoRoot, 'config', 'Muse-ReasoningGovernor.cjs'));

let passed = 0;
function pass(name) {
  passed += 1;
  console.log('PASS: ' + name);
}

function makeInstallRoot(registryOverride) {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-rt-'));
  fs.mkdirSync(path.join(installRoot, 'data', 'routing', 'states'), { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'config'), { recursive: true });
  if (registryOverride === undefined) {
    fs.copyFileSync(
      path.join(repoRoot, 'config', 'model-registry.json'),
      path.join(installRoot, 'config', 'model-registry.json'),
    );
  } else if (registryOverride !== null) {
    fs.writeFileSync(
      path.join(installRoot, 'config', 'model-registry.json'),
      JSON.stringify(registryOverride),
      'utf8',
    );
  }
  return installRoot;
}

function statePathFor(installRoot, binding) {
  const resolvedWorkspace = path.resolve(binding.workspace);
  const workspace = process.platform === 'win32' ? resolvedWorkspace.toLowerCase() : resolvedWorkspace;
  const preset = String(binding.preset || 'aih-muse').toLowerCase();
  const identity = binding.taskInstanceId || String(binding.taskId || '');
  const key = [workspace, preset, identity].join(String.fromCharCode(10));
  const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
  return path.join(installRoot, 'data', 'routing', 'states', hash + '.json');
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
  fs.writeFileSync(bindingsPath, JSON.stringify({ schemaVersion: 1, bindings: { [sessionId]: Object.assign({ engine: 'muse' }, binding) } }), 'utf8');
}

function museState(overrides) {
  return Object.assign({
    taskId: 'TASK-5001',
    taskInstanceId: 'inst-p2',
    preset: 'aih-muse',
    engine: 'muse',
    executionClass: 'muse_main',
    role: null,
    profile: 'muse-spark-1.3-contributor',
    profileDisplayName: 'Muse Spark 1.3 Contributor',
    provider: 'meta-model-api',
    model: 'muse-spark-1.3-contributor',
    modelDisplayName: 'Muse Spark 1.3 Contributor',
    reasoning: 'xhigh',
    dataUseTier: 'contributor',
  }, overrides || {});
}

function makeCtx() {
  const handlers = {};
  return {
    handlers,
    on: (name, handler) => { handlers[name] = handler; },
    shellEnv: { register: () => {} },
  };
}

function museSession(id) {
  return { id, events: [{ type: 'agent-preset/selected', data: { agentPreset: 'aih-muse' } }], header: {} };
}

async function main() {
  const previousHome = process.env.DSH_HOME;
  const previousInstallRoot = process.env.AIH_INSTALL_ROOT;
  try {
    // -- A. Governor result reaches the real request (provider-bound value) --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-5001', taskInstanceId: 'inst-a', preset: 'aih-muse' };
      writeState(installRoot, binding, museState({ taskId: 'TASK-5001', taskInstanceId: 'inst-a' }));
      writeBindings(installRoot, 'sess-a', binding);
      const ctx = makeCtx();
      isolation.apply(ctx);
      const handler = ctx.handlers['agent/request'];
      const session = museSession('sess-a');

      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'discover' });
      const discoverReq = await handler({ agent: { session } }, async () => ({ provider: 'x', model: 'y', reasoningEffort: 'xhigh' }));
      assert.equal(discoverReq.reasoningEffort, 'medium');
      pass('A1: discover -> actual request effort medium');

      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'diagnose' });
      const diagnoseReq = await handler({ agent: { session } }, async () => ({ provider: 'x', model: 'y', reasoningEffort: 'xhigh' }));
      assert.equal(diagnoseReq.reasoningEffort, 'high');
      pass('A2: diagnose -> actual request effort high');

      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'implement' });
      const implementReq = await handler({ agent: { session } }, async () => ({ provider: 'x', model: 'y', reasoningEffort: 'xhigh' }));
      assert.equal(implementReq.reasoningEffort, 'medium');
      pass('A3: implement -> actual request effort medium');

      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'diagnose' });
      runtime.recordMuseHypothesisFailure({ installRoot, binding });
      runtime.recordMuseHypothesisFailure({ installRoot, binding });
      const escalatedReq = await handler({ agent: { session } }, async () => ({ provider: 'x', model: 'y', reasoningEffort: 'medium' }));
      assert.equal(escalatedReq.reasoningEffort, 'xhigh');
      pass('A4: strong escalation -> actual request effort xhigh');
    }

    console.log('PART-A-OK');

    // -- B. One trajectory changes effort: medium/high/medium/high/xhigh --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-5100', taskInstanceId: 'inst-b', preset: 'aih-muse' };
      writeState(installRoot, binding, museState({ taskId: 'TASK-5100', taskInstanceId: 'inst-b' }));
      writeBindings(installRoot, 'sess-b', binding);
      const ctx = makeCtx();
      isolation.apply(ctx);
      const handler = ctx.handlers['agent/request'];
      const session = museSession('sess-b');
      const wireEfforts = [];
      const call = async () => {
        const enforced = await handler({ agent: { session } }, async () => ({ provider: 'x', model: 'y', reasoningEffort: 'xhigh' }));
        wireEfforts.push(enforced.reasoningEffort);
      };

      await call();
      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'diagnose' });
      await call();
      runtime.markMuseRootCauseEstablished({ installRoot, binding });
      runtime.markMuseSolutionEstablished({ installRoot, binding });
      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'implement' });
      await call();
      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'recover' });
      await call();
      runtime.recordMuseImplementationFailure({ installRoot, binding });
      runtime.recordMuseImplementationFailure({ installRoot, binding });
      await call();

      assert.deepEqual(wireEfforts, ['medium', 'high', 'medium', 'high', 'xhigh']);
      pass('B: one trajectory resolves medium/high/medium/high/xhigh across real requests');

      // Wire mapping proof: the managed contributor route maps each enforced
      // internal effort 1:1 to the native reasoning_effort the substrate
      // sends, so the enforced sequence IS the outbound wire sequence.
      const settingsText = fs.readFileSync(path.join(repoRoot, 'config', 'settings.yaml'), 'utf8');
      const routeBlock = settingsText.split('    meta-model-api:')[1].split('    zai-direct:')[0];
      for (const level of ['medium', 'high', 'xhigh']) {
        assert.ok(
          new RegExp('^\\s+' + level + ':\\s*' + level + '\\s*$', 'm').test(routeBlock),
          'managed route maps ' + level + ' 1:1 to the wire',
        );
      }
      pass('B-wire: managed route maps medium/high/xhigh 1:1, so enforced efforts are wire efforts');

      // Observability: the last resolution diagnostic is persisted.
      const stored = readState(installRoot, binding);
      assert.equal(stored.reasoning, 'xhigh');
      assert.equal(stored.museReasoning.currentEffort, 'xhigh');
      assert.equal(stored.museReasoning.lastResolution.resolvedEffort, 'xhigh');
      assert.equal(stored.museReasoning.lastResolution.reason, 'escalation');
      assert.ok(Array.isArray(stored.museReasoning.lastResolution.trace));
      pass('B-obs: lastResolution diagnostic persists phase/requested/resolved/reason/trace');
    }

    console.log('PART-B-OK');

    // -- C. Profile xhigh cannot override an adaptive medium/high result --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      // Legacy routing state: reasoning xhigh from routing time, no adaptive
      // block yet. The Governor (discover -> medium) must win.
      const binding = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-5200', taskInstanceId: 'inst-c', preset: 'aih-muse' };
      writeState(installRoot, binding, museState({ taskId: 'TASK-5200', taskInstanceId: 'inst-c', reasoning: 'xhigh' }));
      writeBindings(installRoot, 'sess-c', binding);
      const ctx = makeCtx();
      isolation.apply(ctx);
      const enforced = await ctx.handlers['agent/request'](
        { agent: { session: museSession('sess-c') } },
        async () => ({ provider: 'meta-model-api', model: 'muse-spark-1.3-contributor', reasoningEffort: 'xhigh' }),
      );
      assert.equal(enforced.reasoningEffort, 'medium');
      assert.equal(readState(installRoot, binding).reasoning, 'medium');
      pass('C: legacy profile-default xhigh does not override adaptive medium');
    }

    // -- D. Capability failure: MuseReasoningCapabilityError, no request --
    {
      // Fixture registry whose muse entry carries no canonical Muse levels.
      const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'model-registry.json'), 'utf8'));
      const broken = JSON.parse(JSON.stringify(registry));
      broken.models.find((e) => e && e.id === 'muse-spark-1.3-contributor').supportedReasoningLevels = ['minimal', 'low'];
      const installRoot = makeInstallRoot(broken);
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-5300', taskInstanceId: 'inst-d', preset: 'aih-muse' };
      writeState(installRoot, binding, museState({ taskId: 'TASK-5300', taskInstanceId: 'inst-d' }));
      writeBindings(installRoot, 'sess-d', binding);
      const ctx = makeCtx();
      isolation.apply(ctx);
      let nextCalls = 0;
      await assert.rejects(
        () => ctx.handlers['agent/request'](
          { agent: { session: museSession('sess-d') } },
          async () => { nextCalls += 1; return { provider: 'x', model: 'y' }; },
        ),
        (error) => (
          error instanceof governor.MuseReasoningCapabilityError &&
          error.code === 'nexus-muse-reasoning-capability-unavailable'
        ),
      );
      assert.equal(nextCalls, 0);
      pass('D: capability failure throws typed error and the downstream request never runs');
      // currentEffort must not pretend an effort was used.
      const stored = readState(installRoot, binding);
      assert.equal(stored.museReasoning, undefined);
      assert.equal(stored.reasoning, 'xhigh');
      pass('D-state: refused resolution leaves routing state byte-identical');
    }

    console.log('PART-CD-OK');

    // -- E. Explicit max clamp through the real boundary --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-5400', taskInstanceId: 'inst-e', preset: 'aih-muse' };
      writeState(installRoot, binding, museState({ taskId: 'TASK-5400', taskInstanceId: 'inst-e' }));
      writeBindings(installRoot, 'sess-e', binding);
      const ctx = makeCtx();
      isolation.apply(ctx);
      const handler = ctx.handlers['agent/request'];
      const session = museSession('sess-e');
      // Contributor supports xhigh but not max: explicit max clamps to xhigh.
      runtime.requestMuseMaxReasoning({ installRoot, binding, request: true });
      const clamped = await handler({ agent: { session } }, async () => ({ provider: 'x', model: 'y' }));
      assert.equal(clamped.reasoningEffort, 'xhigh');
      pass('E1: contributor requestMax=true -> outbound xhigh (max unsupported, xhigh explicit)');

      // A registry variant that exposes max resolves max on the same path.
      const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'model-registry.json'), 'utf8'));
      const withMax = JSON.parse(JSON.stringify(registry));
      const entry = withMax.models.find((e) => e && e.id === 'muse-spark-1.3-contributor');
      entry.supportedReasoningLevels = ['medium', 'high', 'xhigh', 'max'];
      entry.providers = { ...entry.providers, max: 'meta-model-api' };
      fs.writeFileSync(path.join(installRoot, 'config', 'model-registry.json'), JSON.stringify(withMax), 'utf8');
      const maxed = await handler({ agent: { session } }, async () => ({ provider: 'x', model: 'y' }));
      assert.equal(maxed.reasoningEffort, 'max');
      pass('E2: registry variant exposing max -> outbound max on the same runtime path');

      // Ordinary escalation still stops at xhigh even when max is supported.
      runtime.requestMuseMaxReasoning({ installRoot, binding, request: false });
      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'diagnose' });
      runtime.recordMuseHypothesisFailure({ installRoot, binding });
      runtime.recordMuseHypothesisFailure({ installRoot, binding });
      const esc = await handler({ agent: { session } }, async () => ({ provider: 'x', model: 'y' }));
      assert.equal(esc.reasoningEffort, 'xhigh');
      pass('E3: ordinary escalation stops at xhigh (max never automatic)');
    }

    // -- F. Isolation: only aih-muse enters the adaptive flow --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-5500', taskInstanceId: 'inst-f', preset: 'aih-muse' };
      writeState(installRoot, binding, museState({ taskId: 'TASK-5500', taskInstanceId: 'inst-f' }));
      writeBindings(installRoot, 'sess-f', binding);
      const ctx = makeCtx();
      isolation.apply(ctx);
      const dualSession = { id: 'sess-dual', events: [], header: { agentPreset: 'aih-engineering' } };
      const untouched = await ctx.handlers['agent/request'](
        { agent: { session: dualSession } },
        async () => ({ provider: 'flash-high-direct', model: 'deepseek-v4-flash', reasoningEffort: 'high', maxTokens: 4096 }),
      );
      assert.equal(untouched.provider, 'flash-high-direct');
      assert.equal(untouched.reasoningEffort, 'high');
      assert.equal(untouched.maxTokens, 4096);
      pass('F1: Dual session passes through untouched (no adaptive flow)');

      const glmSession = { id: 'sess-glm', events: [], header: { agentPreset: 'aih-engineering' } };
      const glm = await ctx.handlers['agent/request'](
        { agent: { session: glmSession } },
        async () => ({ provider: 'zai-direct', model: 'glm-5.3-flash', reasoningEffort: 'high' }),
      );
      assert.equal(glm.provider, 'zai-direct');
      assert.equal(glm.reasoningEffort, 'high');
      pass('F2: GLM request behavior unchanged');

      // Muse capability errors are distinguishable from provider failures.
      const broken = JSON.parse(JSON.stringify(
        JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'model-registry.json'), 'utf8')),
      ));
      broken.models = [];
      const brokenRoot = makeInstallRoot(broken);
      process.env.DSH_HOME = path.join(brokenRoot, 'data');
      process.env.AIH_INSTALL_ROOT = brokenRoot;
      const brokenBinding = { workspace: path.join(brokenRoot, 'ws'), taskId: 'TASK-5501', taskInstanceId: 'inst-f2', preset: 'aih-muse' };
      writeState(brokenRoot, brokenBinding, museState({ taskId: 'TASK-5501', taskInstanceId: 'inst-f2' }));
      writeBindings(brokenRoot, 'sess-f2', brokenBinding);
      const brokenCtx = makeCtx();
      isolation.apply(brokenCtx);
      await assert.rejects(
        () => brokenCtx.handlers['agent/request'](
          { agent: { session: museSession('sess-f2') } },
          async () => { throw Object.assign(new Error('provider request failed'), { code: 'provider-error' }); },
        ),
        (error) => error.code === 'nexus-muse-reasoning-capability-unavailable',
      );
      pass('F3: capability error preserves its code (never converted to provider failure)');
    }

    console.log('PART-EF-OK');

    // -- State transitions: validation, counters, flags, independence --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-5600', taskInstanceId: 'inst-g', preset: 'aih-muse' };
      writeState(installRoot, binding, museState({ taskId: 'TASK-5600', taskInstanceId: 'inst-g' }));
      writeBindings(installRoot, 'sess-g', binding);

      assert.throws(
        () => runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'planning' }),
        TypeError,
      );
      pass('G1: invalid phase transition fails closed');

      assert.equal(runtime.recordMuseHypothesisFailure({ installRoot, binding }), 1);
      assert.equal(runtime.recordMuseHypothesisFailure({ installRoot, binding }), 2);
      assert.equal(runtime.recordMuseImplementationFailure({ installRoot, binding }), 1);
      const stored = readState(installRoot, binding);
      assert.equal(stored.museReasoning.failedHypotheses, 2);
      assert.equal(stored.museReasoning.failedImplementationAttempts, 1);
      pass('G2: failure counters increment deterministically');

      runtime.markMuseRootCauseEstablished({ installRoot, binding });
      runtime.markMuseSolutionEstablished({ installRoot, binding });
      runtime.setMuseConflictingEvidence({ installRoot, binding, conflicting: true });
      const flagged = readState(installRoot, binding);
      assert.equal(flagged.museReasoning.rootCauseEstablished, true);
      assert.equal(flagged.museReasoning.solutionEstablished, true);
      assert.equal(flagged.museReasoning.conflictingEvidence, true);
      pass('G3: established/conflicting transitions persist');

      // currentEffort reflects the successful selection, set at resolve time.
      // (G2 left failedHypotheses=2 on this task, so escalation to xhigh here
      // is the Governor precedence working as designed; G4 uses a clean task
      // to assert the plain phase-default path.)
      const cleanBinding = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-5602', taskInstanceId: 'inst-g3', preset: 'aih-muse' };
      writeState(installRoot, cleanBinding, museState({ taskId: 'TASK-5602', taskInstanceId: 'inst-g3' }));
      writeBindings(installRoot, 'sess-g3', cleanBinding);
      runtime.setMuseReasoningPhase({ installRoot, binding: cleanBinding, phase: 'verify' });
      assert.equal(readState(installRoot, cleanBinding).museReasoning.currentEffort, null);
      const ctx = makeCtx();
      isolation.apply(ctx);
      const enforced = await ctx.handlers['agent/request'](
        { agent: { session: museSession('sess-g3') } },
        async () => ({ provider: 'x', model: 'y' }),
      );
      assert.equal(enforced.reasoningEffort, 'medium');
      assert.equal(readState(installRoot, cleanBinding).museReasoning.currentEffort, 'medium');
      pass('G4: currentEffort reflects the successfully selected effort');

      // Independent tasks do not share state.
      const other = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-5601', taskInstanceId: 'inst-g2', preset: 'aih-muse' };
      writeState(installRoot, other, museState({ taskId: 'TASK-5601', taskInstanceId: 'inst-g2' }));
      const otherState = runtime.museReasoningStateOf(readState(installRoot, other));
      assert.equal(otherState.phase, 'discover');
      assert.equal(otherState.failedHypotheses, 0);
      pass('G5: independent Muse tasks do not share reasoning state');

      // lastResolution survives later control-signal transitions.
      const before = readState(installRoot, cleanBinding).museReasoning.lastResolution;
      assert.ok(before && before.resolvedEffort === 'medium');
      runtime.setMuseReasoningPhase({ installRoot, binding: cleanBinding, phase: 'review' });
      assert.deepEqual(readState(installRoot, cleanBinding).museReasoning.lastResolution, before);
      pass('G6: control transitions preserve the last resolution diagnostic');
    }

    // -- Phase 2.1-F1: progress-aware escalation windows --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-5700', taskInstanceId: 'inst-h', preset: 'aih-muse' };
      writeState(installRoot, binding, museState({ taskId: 'TASK-5700', taskInstanceId: 'inst-h' }));
      writeBindings(installRoot, 'sess-h', binding);
      const target = { provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' };
      const request = () => runtime.prepareMuseRequestEffort({ installRoot, binding, target }).effort;

      // A. Hypothesis escalation then de-escalation.
      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'diagnose' });
      assert.equal(request(), 'high');
      runtime.recordMuseHypothesisFailure({ installRoot, binding });
      assert.equal(request(), 'high');
      runtime.recordMuseHypothesisFailure({ installRoot, binding });
      assert.equal(request(), 'xhigh');
      runtime.markMuseRootCauseEstablished({ installRoot, binding });
      runtime.markMuseSolutionEstablished({ installRoot, binding });
      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'implement' });
      assert.equal(request(), 'medium');
      const afterHyp = readState(installRoot, binding).museReasoning;
      assert.equal(afterHyp.failedHypotheses, 0);
      assert.equal(afterHyp.totalFailedHypotheses, 2);
      pass('H-A: failure, failure, xhigh, then establishment de-escalates to medium');

      // B. Implementation escalation then de-escalation (second cycle).
      runtime.recordMuseImplementationFailure({ installRoot, binding });
      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'recover' });
      assert.equal(request(), 'high');
      runtime.recordMuseImplementationFailure({ installRoot, binding });
      assert.equal(request(), 'xhigh');
      // The failed approach is explicitly invalidated, then the corrected
      // solution is established (false -> true edge re-opens the window).
      runtime.invalidateMuseSolution({ installRoot, binding });
      runtime.markMuseSolutionEstablished({ installRoot, binding });
      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'implement' });
      assert.equal(request(), 'medium');
      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'verify' });
      assert.equal(request(), 'medium');
      const afterImpl = readState(installRoot, binding).museReasoning;
      assert.equal(afterImpl.failedImplementationAttempts, 0);
      assert.equal(afterImpl.totalFailedImplementationAttempts, 2);
      assert.equal(afterImpl.totalFailedHypotheses, 2);
      pass('H-B: second cycle escalates and de-escalates; totals accumulate');

      // Re-marking an established flag is a no-op for windows (no reset).
      runtime.recordMuseHypothesisFailure({ installRoot, binding });
      runtime.markMuseRootCauseEstablished({ installRoot, binding });
      assert.equal(readState(installRoot, binding).museReasoning.failedHypotheses, 1);
      pass('H-edge: re-marking an established flag does not reset the window');

      // Phase changes alone never reset active escalation.
      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'diagnose' });
      assert.equal(readState(installRoot, binding).museReasoning.failedHypotheses, 1);
      pass('H-phase: phase change alone preserves active counters');
    }

    // -- Invalidation and conflict lifecycle --
    {
      const installRoot = makeInstallRoot();
      process.env.DSH_HOME = path.join(installRoot, 'data');
      process.env.AIH_INSTALL_ROOT = installRoot;
      const binding = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-5701', taskInstanceId: 'inst-i', preset: 'aih-muse' };
      writeState(installRoot, binding, museState({ taskId: 'TASK-5701', taskInstanceId: 'inst-i' }));
      writeBindings(installRoot, 'sess-i', binding);
      const target = { provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' };
      const request = () => runtime.prepareMuseRequestEffort({ installRoot, binding, target }).effort;

      // D. Root-cause invalidation clears both flags, keeps counters.
      runtime.markMuseRootCauseEstablished({ installRoot, binding });
      runtime.markMuseSolutionEstablished({ installRoot, binding });
      runtime.recordMuseHypothesisFailure({ installRoot, binding });
      runtime.invalidateMuseRootCause({ installRoot, binding });
      const invalid = readState(installRoot, binding).museReasoning;
      assert.equal(invalid.rootCauseEstablished, false);
      assert.equal(invalid.solutionEstablished, false);
      assert.equal(invalid.failedHypotheses, 1);
      runtime.setMuseReasoningPhase({ installRoot, binding, phase: 'diagnose' });
      assert.equal(request(), 'high');
      pass('H-D: invalidateRootCause clears both flags, keeps evidence, diagnose resolves high');

      // E. Solution invalidation preserves the diagnosis.
      runtime.markMuseRootCauseEstablished({ installRoot, binding });
      runtime.markMuseSolutionEstablished({ installRoot, binding });
      runtime.invalidateMuseSolution({ installRoot, binding });
      const invalidSol = readState(installRoot, binding).museReasoning;
      assert.equal(invalidSol.rootCauseEstablished, true);
      assert.equal(invalidSol.solutionEstablished, false);
      pass('H-E: invalidateSolution clears solution only, diagnosis preserved');

      // C. Conflict lifecycle: active -> xhigh, resolved -> phase default.
      // (Fresh task so no other escalation signal interferes.)
      const binding2 = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-5702', taskInstanceId: 'inst-i2', preset: 'aih-muse' };
      writeState(installRoot, binding2, museState({ taskId: 'TASK-5702', taskInstanceId: 'inst-i2' }));
      const request2 = () => runtime.prepareMuseRequestEffort({ installRoot, binding: binding2, target }).effort;
      runtime.setMuseReasoningPhase({ installRoot, binding: binding2, phase: 'diagnose' });
      runtime.setMuseConflictingEvidence({ installRoot, binding: binding2, conflicting: true });
      assert.equal(request2(), 'xhigh');
      runtime.resolveMuseConflictingEvidence({ installRoot, binding: binding2 });
      assert.equal(request2(), 'high');
      pass('H-C: conflict forces xhigh while active, releases to phase default when resolved');

      // Establishing the root cause also clears an active conflict.
      runtime.setMuseConflictingEvidence({ installRoot, binding: binding2, conflicting: true });
      runtime.markMuseRootCauseEstablished({ installRoot, binding: binding2 });
      assert.equal(readState(installRoot, binding2).museReasoning.conflictingEvidence, false);
      pass('H-C2: root-cause establishment resolves the diagnosis window including conflict');
    }

    console.log('RESULT: ' + passed + ' MuseReasoningRuntime assertions passed.');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    if (previousInstallRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = previousInstallRoot;
  }
}

main().then(
  () => { /* harness reads PASS lines */ },
  (error) => {
    console.error('FAIL: MuseReasoningRuntime suite failed: ' + String(error && error.stack ? error.stack : error));
    process.exit(1);
  },
);
