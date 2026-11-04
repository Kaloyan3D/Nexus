'use strict';
// EM-04A TEST-ONLY: the DSH reference side of the Governor parity tests.
//
// Drives the ORIGINAL Muse modules from the repository's config/ directory through their public
// DSH API, with a REAL install root (temporary routing-state file and model registry on disk),
// DSH-shaped tool executions/results for the observer, and a module reload for "restart".
// stdin: { configDir, capabilities, steps: [ {t:'sem', op, value} | {t:'tool', exec, result} |
//                                            {t:'resolve'} | {t:'restart'} ] }
// stdout: { ok, resolutions: [...], final: { museReasoning, museActivity } }

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function load(configDir) {
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf(configDir) === 0) delete require.cache[k];
  }
  return {
    runtime: require(path.join(configDir, 'Muse-ReasoningRuntime.cjs')),
    governor: require(path.join(configDir, 'Muse-ReasoningGovernor.cjs')),
    profiles: require(path.join(configDir, 'Engineering-Profiles.cjs')),
    signals: require(path.join(configDir, 'Muse-ReasoningSignals.cjs')),
  };
}

function run(input) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em04a-dsh-'));
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'config', 'model-registry.json'),
      JSON.stringify({ models: [{ id: 'parity-model', supportedReasoningLevels: input.capabilities }] }),
    );
    const binding = { workspace: path.join(root, 'ws'), preset: 'aih-muse', taskInstanceId: 'parity-1' };
    let m = load(input.configDir);
    const statePath = m.profiles.routingStatePath(root, binding);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{}');
    const call = { installRoot: root, binding };
    const resolutions = [];
    const acks = [];
    for (const s of input.steps) {
      if (s.t === 'sem') {
        const f = {
          setPhase: () => m.runtime.setMuseReasoningPhase({ ...call, phase: s.value }),
          markRootCauseEstablished: () => m.runtime.markMuseRootCauseEstablished(call),
          markSolutionEstablished: () => m.runtime.markMuseSolutionEstablished(call),
          invalidateRootCause: () => m.runtime.invalidateMuseRootCause(call),
          invalidateSolution: () => m.runtime.invalidateMuseSolution(call),
          recordHypothesisFailure: () => m.runtime.recordMuseHypothesisFailure(call),
          recordImplementationFailure: () => m.runtime.recordMuseImplementationFailure(call),
          setConflictingEvidence: () => m.runtime.setMuseConflictingEvidence(call),
          resolveConflictingEvidence: () => m.runtime.resolveMuseConflictingEvidence(call),
          requestMax: () => m.runtime.requestMuseMaxReasoning({ ...call, request: s.value !== false }),
        }[s.op];
        f();
      } else if (s.t === 'tool') {
        m.runtime.recordMuseToolOutcome({ ...call, exec: s.exec, result: s.result });
      } else if (s.t === 'signal') {
        // the historical model-facing path (the DSH tool's execute() calls exactly this)
        try {
          acks.push(m.signals.applyReasoningSignal({ ...call, signal: s.signal, dispatchKey: s.dispatchKey }));
        } catch (e) {
          if (e && typeof e.code === 'string' && /signal rejected/.test(String(e.message))) {
            acks.push({ refused: e.code });
          } else {
            throw e;
          }
        }
      } else if (s.t === 'restart') {
        m = load(input.configDir);
      } else if (s.t === 'resolve') {
        try {
          const r = m.runtime.prepareMuseRequestEffort({ ...call, target: { model: 'parity-model' } });
          resolutions.push({
            outcome: 'resolved', effort: r.effort, requested: r.requested, reason: r.reason,
            trace: Array.from(r.trace), effectivePhase: r.effectivePhase,
            effectiveSource: r.effectiveSource, activityState: r.activityState,
          });
        } catch (e) {
          if (e instanceof m.governor.MuseReasoningCapabilityError) {
            resolutions.push({ outcome: 'capability-unavailable', code: e.code, requested: e.requested, supported: Array.from(e.supported) });
          } else {
            throw e;
          }
        }
      }
    }
    const doc = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return { ok: true, resolutions, acks, final: { museReasoning: doc.museReasoning || null, museActivity: doc.museActivity || null } };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { text += c; });
process.stdin.on('end', () => {
  try {
    process.stdout.write(JSON.stringify(run(JSON.parse(text))));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, message: String(e && e.stack || e) }));
  }
});
