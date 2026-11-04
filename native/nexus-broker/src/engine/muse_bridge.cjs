'use strict';
// EM-04A: the Native bridge to the historical Muse reasoning modules.
//
// Run as `node -e <this file>`; ONE JSON document on stdin:
//   { sources: { governor, runtime, activity }, op: 'evaluate', args: {...} }
// ONE JSON document on stdout. Nothing else is read or written.
//
// The three historical CommonJS sources (config/Muse-Reasoning{Governor,Runtime,Activity}.cjs,
// embedded byte for byte in the broker) are evaluated UNCHANGED. Their DSH hooks are replaced by
// Native adapters - and only these three exist (traced: the modules require nothing else):
//   node:fs                     -> an in-memory store holding ONE virtual routing-state document
//                                  (built from the EM-03 engine payload) and ONE virtual model
//                                  registry entry (the task binding's authorized levels). The real
//                                  filesystem is never touched; writes elsewhere are refused.
//   ./Engineering-Profiles.cjs  -> { routingStatePath } naming that virtual document.
//   Date                        -> a fixed clock, so decision evidence is deterministic.
//   node:module (Signals only)  -> createRequire refuses: the DSH tool registration path
//                                  (`apply`) is never used; only `applyReasoningSignal` is.
// Any other require is refused. The Governor policy, the Runtime transitions (progress-window
// resets, signal bookkeeping) and the Activity reducer are the historical code paths.

const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = '/nexus-native-virtual';
const STATE = ROOT + '/routing-state.json';
const REGISTRY = path.join(ROOT, 'config', 'model-registry.json');
const SLOT_MODEL = 'native-slot';
const BINDING = Object.freeze({ preset: 'aih-muse', workspace: 'native', taskInstanceId: 'native' });

function fail(code, message) {
  const e = new Error(message);
  e.bridgeCode = code;
  return e;
}

const files = new Map();
const vfs = Object.freeze({
  readFileSync(p) {
    if (!files.has(p)) {
      const e = new Error('ENOENT: ' + p);
      e.code = 'ENOENT';
      throw e;
    }
    return files.get(p);
  },
  writeFileSync(p, data) {
    if (typeof p !== 'string' || p.indexOf(STATE + '.') !== 0) throw fail('vfs-refused', 'write refused: ' + p);
    files.set(p, String(data));
  },
  renameSync(from, to) {
    if (to !== STATE || !files.has(from)) throw fail('vfs-refused', 'rename refused: ' + to);
    files.set(to, files.get(from));
    files.delete(from);
  },
  rmSync(p) {
    if (p !== STATE) files.delete(p);
  },
  mkdirSync() {},
});

const profilesAdapter = Object.freeze({
  routingStatePath() {
    return STATE;
  },
});

const moduleAdapter = Object.freeze({
  createRequire() {
    throw fail('require-refused', 'the DSH tool registration path is not available in the bridge');
  },
});

class FixedDate extends Date {
  constructor(...a) {
    if (a.length === 0) super(0);
    else super(...a);
  }
  static now() {
    return 0;
  }
}

function load(name, source, deps) {
  const module = { exports: {} };
  const fn = vm.compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname', 'Date'], {
    filename: name,
  });
  const req = (id) => {
    if (Object.prototype.hasOwnProperty.call(deps, id)) return deps[id];
    throw fail('require-refused', 'the bridge refuses require(' + JSON.stringify(id) + ') from ' + name);
  };
  fn(module.exports, req, module, ROOT + '/' + name, ROOT, FixedDate);
  return module.exports;
}

function plainOrNull(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

const SEMANTIC = Object.freeze({
  setPhase: (rt, ev) => rt.setMuseReasoningPhase({ installRoot: ROOT, binding: BINDING, phase: ev.value }),
  markRootCauseEstablished: (rt) => rt.markMuseRootCauseEstablished({ installRoot: ROOT, binding: BINDING }),
  markSolutionEstablished: (rt) => rt.markMuseSolutionEstablished({ installRoot: ROOT, binding: BINDING }),
  invalidateRootCause: (rt) => rt.invalidateMuseRootCause({ installRoot: ROOT, binding: BINDING }),
  invalidateSolution: (rt) => rt.invalidateMuseSolution({ installRoot: ROOT, binding: BINDING }),
  recordHypothesisFailure: (rt) => rt.recordMuseHypothesisFailure({ installRoot: ROOT, binding: BINDING }),
  recordImplementationFailure: (rt) => rt.recordMuseImplementationFailure({ installRoot: ROOT, binding: BINDING }),
  setConflictingEvidence: (rt) => rt.setMuseConflictingEvidence({ installRoot: ROOT, binding: BINDING }),
  resolveConflictingEvidence: (rt) => rt.resolveMuseConflictingEvidence({ installRoot: ROOT, binding: BINDING }),
  requestMax: (rt, ev) => rt.requestMuseMaxReasoning({ installRoot: ROOT, binding: BINDING, request: ev.value !== false }),
});

// evaluate: fold ordered events (trusted activity classifications and, for parity tests and the
// future signals tool, validated semantic transitions) into the virtual routing state, then - if
// asked - resolve the next request's effort exactly as the historical per-request seam does.
function evaluate(mods, args) {
  const doc = {};
  const reasoning = plainOrNull(args.museReasoning);
  const act = plainOrNull(args.museActivity);
  if (reasoning) doc.museReasoning = reasoning;
  if (act) doc.museActivity = act;
  files.set(STATE, JSON.stringify(doc));
  const levels = Array.isArray(args.capabilities) ? args.capabilities.filter((x) => typeof x === 'string') : [];
  files.set(REGISTRY, JSON.stringify({ models: [{ id: SLOT_MODEL, supportedReasoningLevels: levels }] }));
  const applied = [];
  const acks = [];
  for (const ev of Array.isArray(args.events) ? args.events : []) {
    if (ev && ev.type === 'activity') {
      const current = JSON.parse(files.get(STATE));
      // the historical observer's write path: classification -> applyClassification -> persist.
      // The classification itself comes from the Native receipt (the replaced DSH observer hook).
      const next = mods.activity.applyClassification(mods.runtime.museActivityStateOf(current), ev.classification);
      current.museActivity = next;
      files.set(STATE, JSON.stringify(current));
      applied.push('activity:' + ev.classification.kind);
    } else if (ev && ev.type === 'signal') {
      // EM-04B: the historical model-facing signal path, unchanged: strict validation, trusted
      // dispatch-key deduplication, ONE Runtime transition, the model-facing acknowledgement
      const ack = mods.signals.applyReasoningSignal({
        installRoot: ROOT,
        binding: BINDING,
        signal: ev.signal,
        dispatchKey: ev.dispatchKey,
      });
      acks.push(ack);
      applied.push('signal:' + (ack.duplicate ? 'duplicate' : 'applied'));
    } else if (ev && ev.type === 'semantic' && Object.prototype.hasOwnProperty.call(SEMANTIC, ev.op)) {
      SEMANTIC[ev.op](mods.runtime, ev);
      applied.push('semantic:' + ev.op);
    } else {
      throw fail('event-invalid', 'unknown bridge event');
    }
  }
  let decision = null;
  if (args.resolve === true) {
    try {
      const r = mods.runtime.prepareMuseRequestEffort({ installRoot: ROOT, binding: BINDING, target: { model: SLOT_MODEL } });
      decision = {
        outcome: 'resolved',
        effort: r.effort,
        requested: r.requested,
        reason: r.reason,
        trace: Array.from(r.trace),
        effectivePhase: r.effectivePhase,
        effectiveSource: r.effectiveSource,
        activityState: r.activityState,
      };
    } catch (e) {
      if (e instanceof mods.governor.MuseReasoningCapabilityError) {
        decision = {
          outcome: 'capability-unavailable',
          code: e.code,
          requested: e.requested,
          supported: Array.from(e.supported),
        };
      } else {
        throw e;
      }
    }
  }
  const out = JSON.parse(files.get(STATE));
  return {
    museReasoning: plainOrNull(out.museReasoning),
    museActivity: plainOrNull(out.museActivity),
    effective: mods.runtime.effectiveMuseStateOf(out),
    decision,
    applied,
    acks,
  };
}

function main(text) {
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    return { ok: false, code: 'input-invalid', message: 'stdin is not JSON' };
  }
  const src = (input && input.sources) || {};
  try {
    const governor = load('Muse-ReasoningGovernor.cjs', String(src.governor || ''), {});
    const activity = load('Muse-ReasoningActivity.cjs', String(src.activity || ''), {});
    const runtime = load('Muse-ReasoningRuntime.cjs', String(src.runtime || ''), {
      'node:crypto': crypto,
      'node:fs': vfs,
      'node:path': path,
      './Muse-ReasoningGovernor.cjs': governor,
      './Engineering-Profiles.cjs': profilesAdapter,
      './Muse-ReasoningActivity.cjs': activity,
    });
    const signals = src.signals
      ? load('Muse-ReasoningSignals.cjs', String(src.signals), {
          'node:crypto': crypto,
          'node:fs': vfs,
          'node:path': path,
          'node:module': moduleAdapter,
          './Muse-ReasoningGovernor.cjs': governor,
          './Engineering-Profiles.cjs': profilesAdapter,
          './Muse-ReasoningRuntime.cjs': runtime,
        })
      : null;
    const mods = { governor, activity, runtime, signals };
    if (input.op === 'evaluate') return { ok: true, result: evaluate(mods, input.args || {}) };
    if (input.op === 'ladder') {
      return { ok: true, result: { efforts: Array.from(governor.MUSE_REASONING_EFFORTS), phases: Array.from(governor.MUSE_REASONING_PHASES) } };
    }
    return { ok: false, code: 'op-invalid', message: 'unknown op' };
  } catch (e) {
    // a TypeError from the historical validators = corrupt or forged state: fail closed
    const signalCode =
      e && typeof e.code === 'string' && /^Muse reasoning signal rejected/.test(String(e.message)) ? 'signal-' + e.code : null;
    return {
      ok: false,
      code: e && e.bridgeCode ? e.bridgeCode : signalCode ? signalCode : e instanceof TypeError ? 'state-invalid' : 'bridge-error',
      message: String((e && e.message) || e).slice(0, 300),
    };
  }
}

let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  text += c;
  if (text.length > 1024 * 1024) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'input-too-large', message: 'input exceeds 1 MiB' }));
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify(main(text)));
});
