'use strict';
// R7.4: real pre-step middleware, canonical TaskController tasks, atomic
// binding snapshots and a fresh process for EVERY turn. next() is the model
// pipeline boundary; no inference, credentials or running host is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const execFile = promisify(cp.execFile);
const repo = path.resolve(__dirname, '..');
const registry = require('../config/registry/index.cjs');
const profiles = require('../config/Engineering-Profiles.cjs');
const bindingApi = require('../config/registry/session-binding.cjs');
const TURN = 'Fix null handling in workspace resolver';
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function attemptRows(workspace) {
  const runs = path.join(workspace, '.ai-harness', 'runs');
  if (!fs.existsSync(runs)) return [];
  return fs.readdirSync(runs).sort().flatMap((id) => readLines(path.join(runs, id, 'attempts.jsonl')));
}
function fixtureEnv(root, flag) {
  // Bound .NET worker sizing in these concurrent isolated PowerShell hosts.
  const toolchain = path.resolve(path.dirname(process.execPath), '../../..');
  const env = { ...process.env, DOTNET_PROCESSOR_COUNT: process.env.DOTNET_PROCESSOR_COUNT || '2', AIH_TOOLCHAIN_ROOT: toolchain, AIH_INSTALL_ROOT: root, DSH_HOME: path.join(root, 'data') };
  for (const key of Object.keys(env)) {
    if (/^(DSH_AIH_|AIH_ACTIVE_)/.test(key) || /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/.test(key)) delete env[key];
  }
  delete env.NEXUS_REGISTRY_BINDING;
  if (flag) env.NEXUS_REGISTRY_BINDING = '1';
  return env;
}
async function childMain() {
  const [, , , root, sid, text, flag, preset, step] = process.argv;
  Object.assign(process.env, fixtureEnv(root, flag === '1'));
  if (flag !== '1') delete process.env.NEXUS_REGISTRY_BINDING;
  const workspace = path.join(root, 'workspace');
  const logFile = path.join(root, 'data', 'logs', 'aih-controller.log');
  const before = attemptRows(workspace);
  const logStart = readLines(logFile).length;
  const handlers = {};
  require(path.join(root, 'config', 'AihController.cjs')).apply({
    on(event, fn) { handlers[event] = fn; }, shellEnv: { list() { return [] }, register() {} },
  });
  const session = { id: sid, header: { cwd: workspace, agentPreset: preset }, messages: [], append(k, m) { this.messages.push(m); } };
  if (step === 'request-worker') session.header.origin = 'subagent';
  if (step === 'request-no-header') delete session.header;
  let nextCount = 0;
  let errorCode = null;
  let errorMessage = null; // diagnostic only, never asserted on: lets a code-less rejection be explained
  let request = null;
  let result;
  if (step === 'request' || step === 'request-worker' || step === 'request-no-header') {
    const requestHandlers = {}; const scoped = {};
    const agent = { session, ctx: { on(event, fn) { scoped[event] = fn; } } };
    require(path.join(root, 'config', preset === 'aih-muse' ? 'Muse-Isolation.cjs' : 'Engineering-Isolation.cjs')).apply({
      on(event, fn) { requestHandlers[event] = fn; }, shellEnv: { list() { return [] }, register() {} },
    });
    const payload = { agent };
    try {
      // Arming may already refuse malformed authority; report that structured
      // denial too, with the same zero-next/zero-attempt expectations.
      requestHandlers['agent/pre-step']({ agent }, () => {});
      request = await requestHandlers['agent/request'](payload, () => scoped['agent/request'](payload, () => { nextCount++; return { provider: 'seed', model: 'seed' }; }));
      result = 'next';
    } catch (e) { result = { kind: 'reject' }; errorCode = e.code; errorMessage = String((e && e.stack) || e).slice(0, 600); }
  } else result = await handlers['agent/pre-step']({ agent: { session }, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }], step: Number(step || 1), turn: 'r74-turn' }, () => { nextCount++; return 'next'; });
  await new Promise((resolve) => process.stdout.write('TURN-RESULT ' + JSON.stringify({ kind: typeof result === 'string' ? result : result && result.kind, nextCount,
    errorCode, errorMessage, request, attemptsDelta: attemptRows(workspace).length - before.length,
    logs: readLines(logFile).slice(logStart), messages: session.messages.map((m) => m.source && m.source.form),
  }) + '\n', resolve));
}
async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-r74-'));
  let passed = 0; const failures = [];
  function fixture(name, engine = 'dual') {
    const root = path.join(scratch, name);
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    for (const dir of ['scripts', 'config']) fs.cpSync(path.join(process.env.NEXUS_R75_BASELINE_ROOT || repo, dir), path.join(root, dir), { recursive: true });
    fs.mkdirSync(path.join(root, 'ui', 'nexus-controller', 'lib'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'ui', 'nexus-controller', 'lib', 'gate.cjs'), path.join(root, 'ui', 'nexus-controller', 'lib', 'gate.cjs'));
    let settings = fs.readFileSync(path.join(root, 'config', 'settings.yaml'), 'utf8');
    if (engine === 'muse') settings = settings.replace('engineering-profile: deepseek-codex', 'engineering-profile: muse-spark-1.3-contributor');
    fs.writeFileSync(path.join(root, 'data', 'settings.yaml'), settings);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'resolver.js'), 'module.exports = (value) => value ?? "";\n');
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ private: true }));
    return { root, workspace, engine, sid: name, preset: engine === 'muse' ? 'aih-muse' : 'aih-engineering',
      bindingsPath: path.join(root, 'data', 'routing', 'session-bindings.json'),
      ledgerPath: path.join(workspace, '.ai-harness', 'state', 'tasks.json') };
  }
  function service(f) { return registry.service.createService({ installRoot: f.root, dataRoot: path.join(f.root, 'data') }); }
  function binding(f) { return readJson(f.bindingsPath).bindings[f.sid]; }
  function writeBinding(f, b) {
    fs.mkdirSync(path.dirname(f.bindingsPath), { recursive: true });
    fs.writeFileSync(f.bindingsPath, JSON.stringify({ schemaVersion: 1, bindings: { [f.sid]: b } }));
  }
  async function cli(f, script, args) {
    const result = await execFile('pwsh', ['-NoLogo', '-NoProfile', '-File', path.join(f.root, 'scripts', script), ...args],
      { cwd: f.workspace, env: fixtureEnv(f.root, true), timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  }
  async function createTask(f) {
    return cli(f, 'Task.ps1', ['-Action', 'create-task', '-Workspace', f.workspace, '-Description', TURN, '-Engine', f.engine,
      '-ExecutionClass', f.engine === 'muse' ? 'muse_main' : 'engineer_normal']);
  }
  async function seed(f, state = 'pending') {
    const task = await createTask(f);
    // Snapshot of the real pre-route persistence boundary; all lifecycle data
    // and run artifacts are allocated by TaskController, never handwritten.
    const b = { sessionId: f.sid, taskId: task.taskId, taskInstanceId: task.taskInstanceId, workspace: f.workspace,
      preset: f.preset, engine: f.engine, description: task.description, executionClass: task.executionClass,
      reviewRequired: false, needsRouteCheck: true, boundAtUtc: task.createdAtUtc };
    if (state === 'pending') b.registryRefused = { code: 'registry-pending', generation: identity(b), atUtc: task.createdAtUtc, reasons: [] };
    writeBinding(f, b);
    return b;
  }
  async function turn(f, flag = true, text = TURN, preset = f.preset, step = 1) {
    const r = await execFile(process.execPath, [__filename, '--turn', f.root, f.sid, text, flag ? '1' : '0', preset, String(step)],
      { cwd: f.workspace, env: fixtureEnv(f.root, flag), timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
    const line = r.stdout.split('\n').find((l) => l.startsWith('TURN-RESULT '));
    assert.ok(line, 'fresh controller emits its result: ' + r.stderr);
    return JSON.parse(line.slice('TURN-RESULT '.length));
  }
  function identity(b) { return { taskId: b.taskId, taskInstanceId: b.taskInstanceId }; }
  function assertIdentity(f, expected) { assert.deepEqual(identity(binding(f)), identity(expected)); }
  function taskCount(f) { return readJson(f.ledgerPath).tasks.length; }
  function diagnostic(r, code) {
    assert.ok(r.logs.some((e) => e.code === code || (e.event === code)), 'structured diagnostic ' + code + ': ' + JSON.stringify(r.logs));
  }
  function blocked(r, code) {
    assert.equal(r.kind, 'reject'); assert.equal(r.nextCount, 0); assert.equal(r.attemptsDelta, 0);
    if (code) diagnostic(r, code);
  }
  function allowed(r, delta) { assert.equal(r.kind, 'next', JSON.stringify(r)); assert.equal(r.nextCount, 1); assert.equal(r.attemptsDelta, delta); }
  function stageDrift(f) {
    const svc = service(f); const state = svc.getModeConfiguration('engineering-v1', {});
    const config = JSON.parse(JSON.stringify(state.result.config));
    config.slots.engineer = { logicalModelId: 'deepseek-v4-flash', routeId: 'flash-max-direct/deepseek-v4-flash', reasoning: 'max' };
    config.slots.reviewer = { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'low' };
    assert.equal(svc.save('engineering-v1', config, state.result.persisted ? config.revision : undefined, {}).ok, true);
  }
  function stageMatch(f) {
    const svc = service(f); const state = svc.getModeConfiguration('engineering-v1', {});
    const config = JSON.parse(JSON.stringify(state.result.config));
    config.slots.engineer = { logicalModelId: 'deepseek-v4-flash', routeId: 'flash-high-direct/deepseek-v4-flash', reasoning: 'high' };
    assert.equal(svc.save('engineering-v1', config, state.result.persisted ? config.revision : undefined, {}).ok, true);
  }
  async function pinned(f) {
    const original = await seed(f);
    allowed(await turn(f), 1);
    const b = binding(f);
    assert.equal(b.bindingAuthority, 'registry'); assertIdentity(f, original);
    assert.equal(bindingApi.classifyRegistryState(b).state, 'pinned');
    assert.equal(b.registryPin.taskInstanceId, b.taskInstanceId);
    return b;
  }
  async function refused(f) {
    const original = await seed(f); stageDrift(f);
    blocked(await turn(f), 'registry-binding-mismatch');
    assertIdentity(f, original); assert.equal(taskCount(f), 1); assert.ok(!binding(f).registryPin);
    return binding(f);
  }
  async function close(f) {
    const b = binding(f);
    await cli(f, 'Task.ps1', ['-Action', 'attempt-event', '-Workspace', f.workspace, '-TaskId', b.taskId,
      '-TaskInstanceId', b.taskInstanceId, '-Status', 'interrupted', '-Reason', 'r74-isolated-interruption']);
  }
  function removeGeneration(f) {
    // Authoritative ledger restore removes A; its immutable run evidence is
    // retained. Recovery must allocate B through TaskController, never reuse A.
    const ledger = readJson(f.ledgerPath); ledger.tasks = []; fs.writeFileSync(f.ledgerPath, JSON.stringify(ledger));
  }
  function statePath(f) { return profiles.routingStatePath(f.root, binding(f)); }
  function mutateTarget(f, field) {
    const b = binding(f); const state = readJson(statePath(f));
    const file = path.join(f.workspace, '.ai-harness', 'runs', b.taskId, 'step-routing.jsonl');
    if (f.engine === 'dual' && state.stepRole) {
      const rows = readLines(file); assert.ok(rows.length);
      rows.at(-1).roleTarget[field] = field === 'reasoning' ? 'max' : 'r74-unverified-' + field;
      fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } else {
      state[field] = field === 'reasoning' ? 'max' : 'r74-unverified-' + field;
      fs.writeFileSync(statePath(f), JSON.stringify(state));
    }
    // Prove that the changed value is the real downstream execution target.
    const isolation = require(path.join(f.root, 'config', f.engine === 'muse' ? 'Muse-Isolation.cjs' : 'Engineering-Isolation.cjs'));
    assert.equal(isolation.controllerTargetFor(f.root, b)[field], field === 'reasoning' ? 'max' : 'r74-unverified-' + field);
  }
  const tests = [];
  function check(label, fn) { tests.push({ label, fn }); }
  check('A refused generation survives ordinary/command retries and restart; fresh evaluation is the only ON recovery', async () => {
    const f = fixture('refused-on'); const original = await refused(f);
    for (const text of [TURN, '/verify', '/visual-review']) {
      blocked(await turn(f, true, text), 'registry-binding-mismatch');
      assertIdentity(f, original); assert.equal(taskCount(f), 1); assert.ok(binding(f).registryRefused); assert.ok(!binding(f).registryPin);
    }
    stageMatch(f); allowed(await turn(f), 1); assertIdentity(f, original); assert.equal(taskCount(f), 1); assert.ok(!binding(f).registryRefused);
  });
  check('B refused ordinary rollback persists authority/history and resumes once without duplicate task or attempt', async () => {
    const f = fixture('rollback-prompt'); const original = await refused(f);
    const history = original.registryRefused;
    const r = await turn(f, false); allowed(r, 1); diagnostic(r, 'registry-rollback');
    assertIdentity(f, original); assert.equal(binding(f).bindingAuthority, 'legacy-rollback');
    assert.deepEqual(binding(f).registryRefused, history); assert.ok(!binding(f).registryPin);
    allowed(await turn(f, false), 0); assert.equal(taskCount(f), 1);
    // Re-enabling does not turn rollback history into an unmarked legacy grant.
    blocked(await turn(f, true), 'registry-binding-mismatch'); assertIdentity(f, original);
  });
  for (const [name, text, message] of [['verify', '/verify', 'controller-verify-error'], ['visual', '/visual-review', 'visual-review-missing-screenshot']]) {
    check('B refused ' + name + ' command rolls back at its own boundary without transport or attempt', async () => {
      const f = fixture('rollback-' + name); const original = await refused(f);
      const r = await turn(f, false, text); blocked(r); diagnostic(r, 'registry-rollback');
      assert.ok(r.messages.includes(message), 'authorized command machinery reached safely');
      assertIdentity(f, original); assert.equal(binding(f).bindingAuthority, 'legacy-rollback');
      assert.deepEqual(binding(f).registryRefused, original.registryRefused); assert.ok(!binding(f).registryPin); assert.equal(taskCount(f), 1);
      allowed(await turn(f, false), 1); allowed(await turn(f, false), 0); assertIdentity(f, original); assert.equal(taskCount(f), 1);
    });
  }
  for (const engine of ['dual', 'muse']) {
    check('C/D ' + engine + ' pin survives ON/OFF restart; revocation and unavailable authorization never fall back', async () => {
      const f = fixture('pin-' + engine, engine); const original = await pinned(f);
      for (const flag of [true, false]) {
        allowed(await turn(f, flag), 0); assertIdentity(f, original);
        assert.deepEqual(binding(f).registryPin, original.registryPin); assert.equal(binding(f).bindingAuthority, 'registry'); assert.equal(taskCount(f), 1);
      }
      await close(f);
      const role = engine === 'muse' ? 'muse_main' : 'primaryEngineer';
      const connectionId = bindingApi.mapEntryFor(original.registryPin, role).target.connectionId;
      assert.ok(connectionId);
      for (const [status, code] of [['revoked', 'registry-authorization-revoked'], ['not-connected', 'registry-authorization-unavailable']]) {
        assert.equal(service(f).setBuiltInConnectionStatus(connectionId, status, {}).ok, true);
        for (const flag of [true, false]) for (const text of [TURN, '/verify', '/visual-review']) {
          const before = attemptRows(f.workspace); blocked(await turn(f, flag, text), code);
          assert.deepEqual(attemptRows(f.workspace), before); assertIdentity(f, original); assert.deepEqual(binding(f).registryPin, original.registryPin);
        }
      }
      console.log('PIN-RESTART-EVIDENCE ' + JSON.stringify({ engine, ...identity(original), resolutionId: original.registryPin.resolutionId, connectionId }));
    });
  }
  for (const field of ['provider', 'model', 'reasoning']) {
    check('C persisted ' + field + ' drift is rejected with an open attempt after flag-OFF restart', async () => {
      const f = fixture('target-' + field); const original = await pinned(f); mutateTarget(f, field);
      for (const flag of [false, true]) {
        blocked(await turn(f, flag), 'registry-pin-mismatch'); assertIdentity(f, original); assert.equal(taskCount(f), 1);
        assert.deepEqual(binding(f).registryPin, original.registryPin);
      }
      const parked = binding(f); parked.needsRouteCheck = true; writeBinding(f, parked);
      blocked(await turn(f, false, '/visual-review'), 'registry-pin-mismatch');
      assertIdentity(f, original);
    });
  }
  check('E stale ON recovery binds a fresh generation and never reuses the old pin', async () => {
    const f = fixture('stale-on'); const a = await pinned(f); removeGeneration(f);
    const r = await turn(f); allowed(r, 1); diagnostic(r, 'stale-binding-detected');
    const b = binding(f); assert.notEqual(b.taskInstanceId, a.taskInstanceId); assert.notEqual(b.taskId, a.taskId);
    assert.equal(b.registryPin.taskInstanceId, b.taskInstanceId); assert.equal(b.bindingAuthority, 'registry'); assert.equal(taskCount(f), 1);
    allowed(await turn(f), 0); assertIdentity(f, b); assert.deepEqual(binding(f).registryPin, b.registryPin); assert.equal(taskCount(f), 1);
  });
  check('E stale ON mismatch stays refused, then re-evaluates the same replacement generation', async () => {
    const f = fixture('stale-mismatch'); const a = await pinned(f); removeGeneration(f); stageDrift(f);
    blocked(await turn(f), 'registry-binding-mismatch'); const b = binding(f);
    assert.notEqual(b.taskInstanceId, a.taskInstanceId); assert.ok(!b.registryPin, 'old pin must not shadow the new refusal');
    assert.deepEqual(b.registryRefused.generation, identity(b)); assert.equal(taskCount(f), 1);
    blocked(await turn(f), 'registry-binding-mismatch'); assertIdentity(f, b);
    stageMatch(f); allowed(await turn(f), 1); assertIdentity(f, b); assert.equal(taskCount(f), 1); assert.equal(binding(f).registryPin.taskInstanceId, b.taskInstanceId);
  });
  check('E stale OFF rollback retires old authority and resumes the replacement generation without a contradictory pin', async () => {
    const f = fixture('stale-off'); const a = await pinned(f); removeGeneration(f); stageDrift(f);
    const r = await turn(f, false); allowed(r, 1); diagnostic(r, 'registry-rollback');
    const b = binding(f); assert.notEqual(b.taskInstanceId, a.taskInstanceId); assert.equal(b.bindingAuthority, 'legacy-rollback');
    assert.ok(!b.registryPin); assert.equal(bindingApi.classifyRegistryState(b).state, 'pending'); assert.equal(taskCount(f), 1);
    allowed(await turn(f, false), 0); assertIdentity(f, b); assert.equal(taskCount(f), 1);
    blocked(await turn(f, true), 'registry-binding-mismatch'); assertIdentity(f, b);
    console.log('STALE-ROLLBACK-EVIDENCE ' + JSON.stringify({ retired: identity(a), current: identity(b), authority: b.bindingAuthority, pin: !!b.registryPin }));
  });
  for (const flag of [true, false]) {
    check('E/F interrupted stale-pin carry resumes safely with flag ' + (flag ? 'ON' : 'OFF'), async () => {
      const f = fixture('interrupted-stale-' + flag); const a = await pinned(f); const task = await createTask(f);
      // Actual shape written by bindSession before routing during recovery.
      const b = { ...a, ...identity(task), needsRouteCheck: true };
      writeBinding(f, b);
      allowed(await turn(f, flag), 1); const recovered = binding(f);
      assertIdentity(f, task); assert.equal(taskCount(f), 2);
      if (flag) assert.equal(recovered.registryPin.taskInstanceId, task.taskInstanceId);
      else { assert.equal(recovered.bindingAuthority, 'legacy-rollback'); assert.ok(!recovered.registryPin); }
      allowed(await turn(f, flag), 0); assertIdentity(f, task); assert.equal(taskCount(f), 2);
    });
  }
  for (const engine of ['dual', 'muse']) {
    check('E stale ' + engine + ' recovery cannot switch engines with either flag', async () => {
      const f = fixture('engine-' + engine, engine); const a = await pinned(f); removeGeneration(f);
      for (const flag of [true, false]) {
        const r = await turn(f, flag, TURN, engine === 'dual' ? 'aih-muse' : 'aih-engineering'); blocked(r);
        assert.ok(r.logs.some((e) => e.event === 'pre-step-error' && e.error.includes('engine-binding-violation')));
        assert.deepEqual(binding(f), a); assert.equal(taskCount(f), 0);
      }
    });
  }
  check('F pending snapshot without route completion remains refused ON and recovers in place after interruption', async () => {
    const f = fixture('pending-crash'); const b = await seed(f); stageDrift(f);
    // needsRouteCheck can lag the marker at an interrupted persistence boundary.
    b.needsRouteCheck = false; writeBinding(f, b);
    blocked(await turn(f), 'registry-binding-mismatch'); assertIdentity(f, b); assert.equal(taskCount(f), 1);
    blocked(await turn(f), 'registry-binding-mismatch'); assertIdentity(f, b);
    stageMatch(f); allowed(await turn(f), 1); assertIdentity(f, b); assert.equal(taskCount(f), 1);
  });
  check('F successful pin and rollback snapshots before attempt creation resume exactly one attempt', async () => {
    for (const flag of [true, false]) {
      const f = fixture('before-attempt-' + flag); const b = await seed(f);
      // Resolve the actual task route without starting an attempt; this models
      // the durable pin/rollback write immediately before the attempt boundary.
      const d = await cli(f, 'Route.ps1', ['-Workspace', f.workspace, '-TaskId', b.taskId, '-TaskInstanceId', b.taskInstanceId,
        '-Description', TURN, '-InstallRoot', f.root, '-Preset', f.preset]);
      b.needsRouteCheck = false;
      if (flag) {
        const shadow = require(path.join(f.root, 'config', 'registry', 'shadow-binding.cjs')).runShadowComparison(d, { installRoot: f.root, dataRoot: path.join(f.root, 'data') });
        const evaluation = bindingApi.evaluateRegistryBinding(d, shadow, { bindTask: b }); assert.equal(evaluation.ok, true);
        b.registryPin = evaluation.pin; b.bindingAuthority = 'registry'; delete b.registryRefused;
      } else b.bindingAuthority = 'legacy-rollback';
      writeBinding(f, b);
      allowed(await turn(f, flag), 1); assertIdentity(f, b);
      allowed(await turn(f, flag), 0); assertIdentity(f, b); assert.equal(taskCount(f), 1);
    }
  });
  check('F inconclusive task identity preserves Registry state and rejects with either flag', async () => {
    const f = fixture('identity-inconclusive'); const b = await pinned(f);
    fs.writeFileSync(f.ledgerPath, '{interrupted-ledger');
    for (const flag of [true, false]) {
      blocked(await turn(f, flag), 'binding-validation-inconclusive'); assert.deepEqual(binding(f), b);
    }
  });
  check('F missing persisted execution target never authorizes a pinned continuation', async () => {
    const f = fixture('missing-target'); const b = await pinned(f);
    fs.rmSync(statePath(f));
    for (const flag of [true, false]) {
      blocked(await turn(f, flag), 'registry-execution-target-unavailable'); assertIdentity(f, b);
      assert.deepEqual(binding(f).registryPin, b.registryPin); assert.equal(taskCount(f), 1);
    }
  });
  check('G genuine legacy stays compatible across OFF/ON restarts without fabricated Registry authority', async () => {
    const f = fixture('legacy'); const b = await seed(f, 'legacy');
    allowed(await turn(f, false), 1);
    for (const flag of [false, true]) {
      allowed(await turn(f, flag), 0); assertIdentity(f, b); assert.equal(taskCount(f), 1);
      assert.equal(bindingApi.classifyRegistryState(binding(f)).state, 'legacy'); assert.ok(!binding(f).bindingAuthority);
    }
  });
  check('R75A later loop steps reject persisted drift and current revocation', async () => {
    for (const engine of ['dual', 'muse']) {
      const f = fixture('later-step-' + engine, engine); const b = await pinned(f);
      mutateTarget(f, 'provider');
      blocked(await turn(f, false, TURN, f.preset, 2), 'registry-pin-mismatch');
      assertIdentity(f, b);
    }
  });
  check('R75A later loop steps consult current authorization', async () => {
    const f = fixture('later-revoked'); const b = await pinned(f);
    const id = bindingApi.mapEntryFor(b.registryPin, 'primaryEngineer').target.connectionId;
    assert.equal(service(f).setBuiltInConnectionStatus(id, 'revoked', {}).ok, true);
    blocked(await turn(f, false, TURN, f.preset, 2), 'registry-authorization-revoked');
    assertIdentity(f, b);
  });
  check('R75A corrupt current entitlement is unverifiable rather than connected by default', async () => {
    const f = fixture('corrupt-status'); const b = await pinned(f);
    const id = bindingApi.mapEntryFor(b.registryPin, 'primaryEngineer').target.connectionId;
    assert.equal(service(f).setBuiltInConnectionStatus(id, 'revoked', {}).ok, true);
    fs.writeFileSync(path.join(f.root, 'data', 'registry', 'connection-status.json'), '{interrupted-status');
    for (const flag of [false, true]) blocked(await turn(f, flag), 'registry-authorization-unverifiable');
    assert.deepEqual(binding(f).registryPin, b.registryPin);
  });
  check('R75A corrupt durable bindings cannot restart as fresh flag-OFF legacy', async () => {
    const f = fixture('corrupt-binding'); await pinned(f);
    fs.writeFileSync(f.bindingsPath, '{interrupted-bindings');
    blocked(await turn(f, false), 'bindings-unverifiable');
    assert.equal(fs.readFileSync(f.bindingsPath, 'utf8'), '{interrupted-bindings');
    assert.equal(taskCount(f), 1);
  });
  for (const mode of ['drift', 'revoked']) {
    check('R75A actual request boundary rejects ' + mode + ' after pre-step', async () => {
      for (const engine of ['dual', 'muse']) {
        const f = fixture('request-' + mode + '-' + engine, engine); const b = await pinned(f);
        if (mode === 'drift') mutateTarget(f, 'provider');
        else {
          const id = bindingApi.mapEntryFor(b.registryPin, engine === 'muse' ? 'muse_main' : 'primaryEngineer').target.connectionId;
          assert.equal(service(f).setBuiltInConnectionStatus(id, 'revoked', {}).ok, true);
        }
        const r = await turn(f, false, TURN, f.preset, 'request'); blocked(r);
        assert.equal(r.errorCode, mode === 'drift' ? 'registry-pin-mismatch' : 'registry-authorization-revoked');
        assertIdentity(f, b); assert.deepEqual(binding(f).registryPin, b.registryPin);
      }
    });
  }
  check('R75A explicit indeterminate entitlement and disabled status fail closed', async () => {
    const f = fixture('indeterminate-status'); const b = await pinned(f);
    const id = bindingApi.mapEntryFor(b.registryPin, 'primaryEngineer').target.connectionId;
    for (const status of ['unknown', 'disabled', 'not-connected']) {
      assert.equal(service(f).setBuiltInConnectionStatus(id, status, {}).ok, true);
      for (const flag of [false, true]) for (const step of [1, 2, 'request']) {
        const r = await turn(f, flag, TURN, f.preset, step); blocked(r);
        assertIdentity(f, b);
      }
    }
  });
  check('R75A malformed binding entries cannot erase Registry authority', async () => {
    for (const engine of ['dual', 'muse']) {
      const f = fixture('malformed-binding-' + engine, engine); const b = await pinned(f);
      const { registryPin, ...missingPin } = b;
      for (const invalid of [null, { ...b, registryPin: 'interrupted' }, { ...b, registryPin: null }, missingPin]) {
        writeBinding(f, invalid);
        blocked(await turn(f, false), 'bindings-unverifiable');
        blocked(await turn(f, false, TURN, f.preset, 'request'));
        assert.equal(taskCount(f), 1);
        assert.deepEqual(readJson(f.bindingsPath).bindings[f.sid], invalid);
      }
    }
  });
  check('R75A current routing generation is verified at pre-step and actual request', async () => {
    const f = fixture('route-generation'); const b = await pinned(f);
    const state = readJson(statePath(f)); state.taskInstanceId = 'task_another_generation';
    fs.writeFileSync(statePath(f), JSON.stringify(state));
    for (const step of [1, 2, 'request']) blocked(await turn(f, false, TURN, f.preset, step));
    assertIdentity(f, b);
  });
  check('R75A valid pinned requests and later steps continue without additional attempts', async () => {
    for (const engine of ['dual', 'muse']) {
      const f = fixture('valid-request-' + engine, engine); const b = await pinned(f);
      for (const flag of [false, true]) for (const step of [2, 'request']) {
        const result = await turn(f, flag, TURN, f.preset, step);
        allowed(result, 0);
        if (step === 'request') assert.equal(result.request.reasoningEffort, bindingApi.mapEntryFor(b.registryPin, engine === 'muse' ? 'muse_main' : 'primaryEngineer').target.reasoning);
        assertIdentity(f, b); assert.deepEqual(binding(f).registryPin, b.registryPin);
      }
    }
  });
  check('R75A actual request fails closed when authoritative identity becomes unavailable', async () => {
    for (const engine of ['dual', 'muse']) {
      const f = fixture('request-identity-' + engine, engine); const b = await pinned(f);
      fs.writeFileSync(f.ledgerPath, '{interrupted');
      blocked(await turn(f, false, TURN, f.preset, 'request'));
      assertIdentity(f, b);
    }
  });
  check('R75A marked parent binding cannot bypass request enforcement as a worker', async () => {
    for (const engine of ['dual', 'muse']) {
      const f = fixture('worker-authority-' + engine, engine); await pinned(f);
      mutateTarget(f, 'provider');
      blocked(await turn(f, false, TURN, f.preset, 'request-worker'));
    }
  });
  check('R75A request workers refuse corrupt or malformed durable authority', async () => {
    for (const engine of ['dual', 'muse']) {
      const f = fixture('worker-corruption-' + engine, engine); const b = await pinned(f);
      for (const invalid of [null, { ...b, registryPin: null, bindingAuthority: undefined }]) {
        writeBinding(f, invalid);
        blocked(await turn(f, false, TURN, f.preset, 'request-worker'));
      }
      fs.writeFileSync(f.bindingsPath, '{interrupted');
      blocked(await turn(f, false, TURN, f.preset, 'request-worker'));
    }
  });
  check('R75A marked request cannot bypass enforcement by omitting its header', async () => {
    for (const engine of ['dual', 'muse']) {
      const f = fixture('header-corruption-' + engine, engine); await pinned(f);
      blocked(await turn(f, false, TURN, f.preset, 'request-no-header'));
      fs.writeFileSync(f.bindingsPath, '{interrupted');
      blocked(await turn(f, false, TURN, f.preset, 'request-no-header'));
    }
  });
  check('R75A invalid status-overlay collection cannot restore legacy entitlement', async () => {
    const f = fixture('overlay-array'); await pinned(f);
    fs.mkdirSync(path.join(f.root, 'data/registry'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'data/registry/connection-status.json'), JSON.stringify({ schemaVersion: 1, statuses: [] }));
    blocked(await turn(f, false));
  });
  const selected = tests.filter((t) => !process.env.NEXUS_R74_FILTER || t.label.includes(process.env.NEXUS_R74_FILTER));
  assert.ok(selected.length, 'R7.4 filter selects at least one scenario');
  try {
    // Independent fixtures run in bounded batches; no roots or status overlays
    // are shared, and each scenario's dependent turns remain sequential.
    for (let i = 0; i < selected.length; i += 2) {
      await Promise.all(selected.slice(i, i + 2).map(async ({ label, fn }) => {
        try { await fn(); passed++; console.log('PASS: R7.4 ' + label); }
        catch (e) { failures.push(label + ' :: ' + (e.stack || e)); console.log('FAIL: R7.4 ' + label + ' :: ' + e.message); }
      }));
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failures.length + ' | total ' + selected.length);
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
}
if (process.argv[2] === '--turn') childMain().then(() => process.exit(0), (e) => { console.error(e.stack || e); process.exit(1); });
else main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
