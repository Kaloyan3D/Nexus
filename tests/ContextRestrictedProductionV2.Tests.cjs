'use strict';
// These are production-policy tests: NEVER load the research fixture policy.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const code = 'ccv2-durable-mutation-disabled';
let passed = 0, failed = 0;
function check(ok, name) { console.log((ok ? 'PASS: ' : 'FAIL: ') + name); if (ok) passed++; else failed++; }
async function blocked(fn, name) {
  let error, result;
  try { result = await fn(); } catch (e) { error = e; }
  check(error && error.code === code && !result, name + ' refuses with the production disabled code');
}
const area = fs.mkdtempSync(path.join(os.tmpdir(), 'ccv2-restricted-'));
async function main() {
  const active = require('../config/ContextActiveApplyV2.cjs');
  const compaction = require('../config/ContextCompaction.cjs');
  const runtime = require('../config/ContextGenerationRuntimeV2.cjs');
  const integration = require('../config/ContextCompleteTaskV2.cjs');
  const memory = require('../config/ContextMemoryProducerV2.cjs');
  const host = require('../config/ContextMemoryProducerHostV2.cjs');
  const checkpoint = require('../config/ContextCheckpointV2.cjs');
  const trust = require('../config/ContextTrustV2.cjs');
  // Synthetic persisted intent survives every attempted mutation/restart verbatim.
  const sentinel = path.join(area, 'preserved-operation.json');
  const bytes = '{"schemaVersion":2,"lifecycle":"awaiting-durability","sentinel":"synthetic"}\n';
  fs.writeFileSync(sentinel, bytes);
  let sideEffects = 0;
  const poison = new Proxy({}, { get() { sideEffects++; throw new Error('input/callback must not be touched'); } });
  const writers = [
    ['A10 apply', () => active.applyActiveCompactionV2(poison)],
    ['A02 append', () => compaction.applyCompactionOperationV2(poison, poison, 'synthetic', poison)],
    ['A02 retry', () => compaction.retryMissingSegmentsV2(poison, poison, 'synthetic', poison, [0])],
    ['A02 intent persist', () => compaction.persistCompactionOperationV2(area, poison)],
    ['A02 intent freeze', () => compaction.freezeCompactionOperationV2(area, poison, poison)],
    ['A02 attempt persist', () => compaction.persistCompactionAttemptV2(area, poison)],
    ['A03 checkpoint persist', () => checkpoint.persistCheckpointV2(area, poison)],
    ['A04 sealed persist', () => trust.persistSealedCheckpointV2(area, poison)],
    ['A11 reserve', () => runtime.reserveNextGenerationV2(poison)],
    ['A11 commit', () => runtime.commitGenerationV2(poison)],
    ['A11 supersede', () => runtime.supersedeGenerationV2(poison)],
    ['A11 apply current', () => runtime.applyCurrentGenerationV2(poison)],
    ['A11 default head repair', () => runtime.reconstructGenerationRuntimeV2({})],
    ['A11 explicit head repair', () => runtime.reconstructGenerationRuntimeV2({ repairHead: true })],
    ['A13 recovery', () => integration.recoverUnresolvedGeneration(poison)],
    ['A13 resume', () => integration.resumeTask(poison)],
    ['M01 open writer', () => memory.openMemoryProducerV2(poison)],
    ['M01 replay', () => memory.replaySessionV2(poison)],
  ];
  for (const [name, fn] of writers) await blocked(fn, name);
  check(sideEffects === 0, 'refusal precedes input getters/callbacks and IO');
  check(fs.readFileSync(sentinel, 'utf8') === bytes, 'persisted intent remains byte-identical');
  check(fs.readdirSync(area).join() === 'preserved-operation.json', 'no writer creates or repairs artifacts');

  // An actually valid A10 request must also refuse, not just malformed input.
  const file = path.join(__dirname, 'ContextActiveApplyV2.Tests.cjs');
  const text = fs.readFileSync(file, 'utf8');
  const offset = text.indexOf('async function main() {');
  const fixture = new Module(file); fixture.filename = file; fixture.paths = Module._nodeModulePaths(path.dirname(file));
  fixture._compile(text.slice(0, offset) + '\nmodule.exports={buildHappy,applyInputFor};', file);
  const fx = fixture.exports.buildHappy('single');
  let callbacks = 0;
  const input = fixture.exports.applyInputFor(fx, {
    checkpointDir: path.join(area, 'checkpoint'), operationDir: path.join(area, 'operation'),
    serialization: { async acquire() { callbacks++; return { acquired: true, ownerId: 'synthetic', leaseSeconds: 60 }; }, async renew() { callbacks++; return { renewed: true }; }, async release() { callbacks++; return { released: true }; } },
    async flushFn() { callbacks++; return true; },
  });
  const before = JSON.stringify(input.session.events);
  await blocked(() => active.applyActiveCompactionV2(input), 'valid A10 request');
  check(JSON.stringify(input.session.events) === before && callbacks === 0, 'valid A10 refusal cannot append, flush or acquire a lock');

  const child = spawnSync(process.execPath, ['-e', `
    const assert=require('node:assert/strict');
    const i=require('./config/ContextCompleteTaskV2.cjs');
    const r=require('./config/ContextGenerationRuntimeV2.cjs');
    Promise.all([i.resumeTask({}),i.recoverUnresolvedGeneration({}),i.evaluateBoundary({})].map(p=>p.then(()=>{throw Error('false success')},e=>assert.equal(e.code,'ccv2-durable-mutation-disabled'))))
      .then(()=>{assert.throws(()=>r.reconstructGenerationRuntimeV2({}),e=>e.code==='ccv2-durable-mutation-disabled');console.log('restart blocked')})
      .catch(e=>{console.error(e);process.exitCode=1});
  `], { cwd: root, encoding: 'utf8', env: { ...process.env, NEXUS_CONTEXT_COMPACTION_V2: 'v2', NEXUS_CCV2_PRODUCER: 'on' } });
  check(child.status === 0 && child.stdout.includes('restart blocked'), 'fresh process recovery/resume/finalization and env flags cannot bypass guards');
  const ps = spawnSync(process.env.AIH_TEST_PWSH || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh'), ['-NoProfile', '-Command', `
    . './scripts/ContextLifecycle.ps1'
    try {
      New-AihContextCompactionOperationV2 -Workspace '${area.replace(/'/g, "''")}' -TaskId TASK-SAFE -TaskInstanceId task_safe -SessionId sess-safe -CheckpointGeneration 1 -CheckpointId checkpoint -AttemptId attempt -SafePointBoundarySeq 2 -SourceEventSeqs @(0) -Segments @(@{synthetic=1}) -CheckpointContentDigest digest -Lifecycle awaiting-durability
      exit 2
    } catch {
      if ($_.Exception.Message -like 'ccv2-durable-mutation-disabled:*') { Write-Output 'PS writer blocked'; exit 0 }
      Write-Error $_; exit 3
    }
  `], { cwd: root, encoding: 'utf8' });
  check(ps.status === 0 && ps.stdout.includes('PS writer blocked'), 'direct PowerShell V2 writer fails closed before task/file access');
  check(fs.readFileSync(sentinel, 'utf8') === bytes, 'restart and PowerShell attempts preserve stored artifact');
  check(compaction.validateOperationForApply({ schemaVersion: 2 }, {}).reason === 'operation-schema-mismatch', 'v1 mutation cannot adopt a persisted v2 operation');
  const a13file = path.join(__dirname, 'ContextCompleteTaskV2.Tests.cjs');
  const a13source = fs.readFileSync(a13file, 'utf8');
  const a13fixture = new Module(a13file); a13fixture.filename = a13file; a13fixture.paths = Module._nodeModulePaths(path.dirname(a13file));
  a13fixture._compile(a13source.slice(0, a13source.indexOf('async function main() {')) + '\nmodule.exports={baseInput,buildGenFixture,seedSingle};', a13file);
  const a13 = a13fixture.exports;
  const a13session = require('./ContextActiveApplyV2.Tests.cjs').makeSessionDouble(a13.seedSingle(), a13.seedSingle().map(e => e.seq));
  const v1 = await integration.evaluateBoundary(a13.baseInput({runtimeDir:area,checkpointDir:area,operationRoot:area,lockWorkspace:area}, {}, a13session, a13.buildGenFixture(a13session, 1), 100000, {compactionVersion:'v1'}));
  check(v1.evaluated === false && v1.action === 'none' && v1.taskMayContinue === true, 'A13 explicit v1 retains no-op delegation to existing DSH path');

  // Create authentic old durable intent only in a private laboratory. The
  // shipped readers brand that persisted record, but every writer still refuses.
  const lab = require('./Ccv2ResearchRunner.cjs').createLaboratory();
  let oldEnv;
  try {
    const file = path.join(lab.area, 'tests/ContextGenerationRuntimeV2.Tests.cjs');
    const source = fs.readFileSync(file, 'utf8');
    const old = new Module(file); old.filename = file; old.paths = Module._nodeModulePaths(path.dirname(file));
    old._compile(source.slice(0, source.indexOf('async function main() {')) + '\nmodule.exports={makeEnv,bind,freezeIntentOnly,buildChainedFixture,a10builders,runtime};', file);
    const f = old.exports; oldEnv = f.makeEnv();
    const initial = f.a10builders.buildHappy('single');
    const oldSession = f.a10builders.makeSessionDouble(initial.events, initial.events.map(e=>e.seq));
    const happy = f.buildChainedFixture(oldSession,1,null,'restricted-old-intent');
    const oldBinding = f.bind(oldEnv);
    await f.runtime.reserveNextGenerationV2({...oldBinding,revisionDigest:happy.token.revisionDigest,snapshotTokenId:happy.token.snapshotTokenId,safePointBoundarySeq:happy.safe.boundarySeq});
    f.freezeIntentOnly(oldEnv, happy, 1);
    const op = compaction.readCompactionOperationV2(runtime.operationDirForGenerationV2(oldEnv.operationRoot,1));
    check(!!op && !!checkpoint.readCheckpointV2(oldEnv.checkpointDir,1), 'production readers accept authentic old checkpoint and branded durable intent');
    function digestTree(dir) {
      return fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).map(e=>[e.name,e.isDirectory()?digestTree(path.join(dir,e.name)):fs.readFileSync(path.join(dir,e.name)).toString('base64')]);
    }
    const snapshot = JSON.stringify(digestTree(oldEnv.base));
    await blocked(()=>compaction.applyCompactionOperationV2(oldSession,op,'synthetic',op), 'persisted branded operation append');
    await blocked(()=>runtime.commitGenerationV2({...oldBinding,applyResult:{status:'recovered'},generation:1}), 'persisted generation finalization');
    await blocked(()=>integration.resumeTask({...oldBinding,session:oldSession}), 'persisted generation resume');
    await blocked(()=>integration.recoverUnresolvedGeneration({...oldBinding,session:oldSession}), 'persisted generation recovery');
    check(JSON.stringify(digestTree(oldEnv.base)) === snapshot, 'authentic old reservation/checkpoint/operation/head bytes preserved without false success');
  } finally {
    if(oldEnv) fs.rmSync(oldEnv.base,{recursive:true,force:true});
    fs.rmSync(lab.area,{recursive:true,force:true});
  }

  const priorVersion = process.env.NEXUS_CONTEXT_COMPACTION_V2;
  for (const value of ['v2', '1', 'true', 'yes']) {
    process.env.NEXUS_CONTEXT_COMPACTION_V2 = value;
    await blocked(() => integration.evaluateBoundary({}), 'A13 environment selection ' + value);
  }
  if (priorVersion === undefined) delete process.env.NEXUS_CONTEXT_COMPACTION_V2; else process.env.NEXUS_CONTEXT_COMPACTION_V2 = priorVersion;
  await blocked(() => integration.evaluateBoundary({ compactionVersion: 'v2' }), 'A13 explicit v2 selection');

  const binding = { schemaVersion: 1, taskId: 'TASK-SAFE', taskInstanceId: 'task_safe', sessionId: 'sess-safe', runtimeDir: path.join(area, 'runtime'), checkpointDir: path.join(area, 'checkpoints'), operationRoot: path.join(area, 'operations') };
  try { runtime.inspectGenerationRuntimeV2(binding); check(true, 'read-only generation inspection remains callable'); }
  catch (error) { check(false, 'read-only inspection: ' + error.message); }
  check(!fs.existsSync(binding.runtimeDir), 'read-only inspect does not initialize a head');
  for (const env of [{}, { NEXUS_CCV2_PRODUCER: 'on' }, { NEXUS_CCV2_PRODUCER: 'true' }]) check(host.producerEnabledV2(env) === false, 'producer flag cannot enable production writes: ' + JSON.stringify(env));

  const listeners = [];
  const installed = host.installMemoryProducer({ on(event, listener) { listeners.push({ event, listener }); } }, {
    bindingFor: () => ({ workspace: area, taskId: 'TASK-SAFE', taskInstanceId: 'task_safe' }),
    async flush() { callbacks++; return true; }, env: { NEXUS_CCV2_PRODUCER: 'on' },
  });
  check(installed.installed && installed.reason === 'ccv2-read-only-session-observer', 'controller installs read-only session observer');
  const session = { id: 'sess-safe', events: [{ seq: 0, type: 'turn/end', data: {} }] };
  for (const row of listeners) if (row.event === 'session/event') row.listener(session, session.events[0]);
  if (installed.registry) await installed.registry.idle(session.id);
  check(callbacks === 0 && !fs.existsSync(path.join(area, '.ai-harness')), 'event/restart observer never flushes or writes memory');
  check(installed.registry && installed.registry.liveSessionFor(session.id) && installed.registry.liveSessionFor(session.id).events().length === 1, 'live pressure/projection reader remains available');
  check(installed.registry && installed.registry.describe(session.id) === null, 'read-only observer does not claim a producer/checkpoint');
  // Module policy is immutable and ignores all caller/environment opt-ins.
  try {
    const policy = require('../config/ContextDurableMutationPolicyV2.cjs');
    check(Object.isFrozen(policy) && policy.durableMutationEnabledV2() === false, 'shipped policy is frozen and disabled');
  } catch { check(false, 'shipped policy exists'); }
}
main().catch(error => { console.error(error.stack); failed++; }).finally(() => {
  fs.rmSync(area, { recursive: true, force: true });
  console.log('Restricted production: passed=' + passed + ' failed=' + failed);
  if (failed) process.exitCode = 1;
});
