'use strict';
/**
 * ContextCompleteTaskV2XProc.Tests.cjs - A13 true cross-process proof.
 *
 * Independent OS processes (this parent + worker children) drive the SAME
 * task identity through the REAL production lock authority
 * (ContextActiveApplyLockClientV2 CLI client against a real ledger
 * workspace). No in-process doubles stand in for exclusion. Proves the
 * real integration cannot reserve competing generations, apply competing
 * projections, fork committed lineage, or finalize while unresolved
 * mutation remains.
 *
 * ENVIRONMENTAL skip (never faked): pwsh absent (the CLI lock authority
 * shells to pwsh) or the worker contract broken.
 */
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runtime = require(path.join(repoRoot, 'config', 'ContextGenerationRuntimeV2.cjs'));
const shadow = require(path.join(repoRoot, 'config', 'ContextShadowV2.cjs'));
const builders = require(path.join(__dirname, 'ContextActiveApplyV2.Tests.cjs'));

const WORKER = path.join(__dirname, 'ContextCompleteTaskV2XProc.Worker.cjs');
const INTEGRATION_ACTION_SET = ['none', 'blocked', 'compacted', 'recovered', 'failed'];
const TASK_CLI = path.join(repoRoot, 'scripts', 'Task.ps1');
const SESSION_ID = 'sess-a13x';
const HIGH_TOK = 100000;

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(t) { console.log(''); console.log('--- ' + t + ' ---'); }
const clone = (o) => JSON.parse(JSON.stringify(o));

function pwshAvailable() {
  try {
    execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8', timeout: 60000 });
    return true;
  } catch (e) { return false; }
}
function gitAvailable() {
  try { execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 30000 }); return true; }
  catch (e) { return false; }
}
function pwsh(script, args, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a13xpw-'));
  const payloadFile = path.join(dir, 'p.json');
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  try {
    const cliArgs = ['TaskId', 'ExecutionClass', 'Status'];
    const full = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script].concat(args).concat(['-PayloadFile', payloadFile]);
    for (const key of cliArgs) {
      if (payload && typeof payload[key] === 'string' && payload[key] !== '') full.push('-' + key, payload[key]);
    }
    const out = execFileSync('pwsh', full, { encoding: 'utf8', timeout: 120000 });
    const text = out.trim();
    return text === '' ? null : JSON.parse(text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// The CLI lock authority scopes by ledger task: bootstrap a real task in
// the lock workspace and use its allocated lifecycle identity end to end.
function bootstrapLedgerTask(lockWorkspace) {
  execFileSync('git', ['init', '-q', lockWorkspace]);
  execFileSync('git', ['-C', lockWorkspace, 'config', 'user.email', 'a13x@example.invalid']);
  execFileSync('git', ['-C', lockWorkspace, 'config', 'user.name', 'a13x']);
  fs.writeFileSync(path.join(lockWorkspace, '.a13xbaseline'), 'baseline');
  execFileSync('git', ['-C', lockWorkspace, 'add', '.a13xbaseline']);
  execFileSync('git', ['-C', lockWorkspace, 'commit', '-qm', 'baseline']);
  const task = pwsh(TASK_CLI, ['-Action', 'create-task'], { workspace: lockWorkspace, description: 'a13x fixture', reviewRequested: false, engine: 'dual' });
  assert.ok(task && task.taskId && task.taskInstanceId, 'ledger task exists for the lock scope');
  return { taskId: task.taskId, taskInstanceId: task.taskInstanceId };
}
function makeEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a13x-'));
  return {
    base,
    runtimeDir: path.join(base, 'runtime'),
    checkpointDir: path.join(base, 'checkpoints'),
    operationRoot: path.join(base, 'operations'),
    lockWorkspace: path.join(base, 'ledger'),
  };
}
let evCounter = 0;
function evUser(text) {
  evCounter += 1;
  return { type: 'user/message', data: { id: 'msg-a13x-' + evCounter, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } };
}
function evAssistant(text) {
  evCounter += 1;
  return { type: 'assistant/message', data: { turn: 't1', step: 's1', message: { id: 'msg-a13x-' + evCounter, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } } };
}
function seqify(events) { return events.map((e, i) => Object.assign({}, e, { seq: i })); }
function seedEvents() {
  evCounter = 0;
  return seqify([evUser('A13X-u0'), evAssistant('A13X-a1'), evUser('A13X-u2'), evAssistant('A13X-a3'), evUser('A13X-u4'), evAssistant('A13X-a5'), evUser('A13X-u6-current')]);
}
function fixtureFor(taskId, taskInstanceId, session, generation) {
  const last = session.events.length - 1;
  const U = builders.U;
  const units = [
    U('u-hist', 0, Math.max(0, last - 3), { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 6000, method: 'provider-tokenizer', exact: true } }),
    U('u-new', Math.max(0, last - 2), Math.max(0, last - 1), { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }),
    U('u-user', last, last, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } }),
  ];
  const over = { taskId, taskInstanceId, sessionId: SESSION_ID, workspaceId: '/tmp/nexus-a13x', generation };
  const ts0 = builders.draftTaskState(last, last, over);
  ts0.evidenceRefs = ts0.evidenceRefs.map((e) => Object.assign({}, e, { taskInstanceId }));
  return { ts: builders.finalizeTs(ts0), units };
}
function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v)); }
function runWorker(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a13xw-'));
  const specFile = path.join(dir, 'spec.json');
  writeJson(specFile, spec);
  const out = spawnSync(process.execPath, [WORKER, specFile], { encoding: 'utf8', timeout: 300000 });
  const text = String(out.stdout || '').trim().split('\n').filter((l) => l !== '').pop() || '';
  if (text === '') throw new Error('worker produced no output (status=' + out.status + ' stderr=' + String(out.stderr || '').slice(0, 300) + ')');
  return JSON.parse(text);
}
function headOf(env, ids) {
  return runtime.inspectGenerationRuntimeV2({
    schemaVersion: 1, taskId: ids.taskId, taskInstanceId: ids.taskInstanceId, sessionId: SESSION_ID,
    runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot, session: null,
  });
}

async function main() {
  if (!pwshAvailable() || !gitAvailable()) {
    console.log('SKIP: pwsh or git absent (environmental, never faked).');
    console.log('');
    console.log('A13X SUMMARY passed=' + passed + ' failed=' + failed);
    return;
  }
  section('A13X CONCURRENT RACE (two processes, one task identity, one source state)');
  {
    const env = makeEnv();
    const ids = bootstrapLedgerTask(env.lockWorkspace);
    const events = seedEvents();
    const sessionFile = path.join(env.base, 'session.json');
    writeJson(sessionFile, { events, surface: events.map((e) => e.seq) });
    const fx = fixtureFor(ids.taskId, ids.taskInstanceId, { events }, 1);
    const taskStateFile = path.join(env.base, 'ts.json');
    const unitsFile = path.join(env.base, 'units.json');
    writeJson(taskStateFile, fx.ts);
    writeJson(unitsFile, fx.units);
    const controller = { taskStatus: 'active', transitionOpen: false, completionCommitted: false, streamOpen: false, toolEdgeOpen: false, taskRevision: fx.ts.taskRevision };
    const provider = { modelId: 'deepseek-v4-flash', capacityTokens: 131072 };
    const tokenObservation = { currentContextTokens: HIGH_TOK, costMethod: 'conservative-estimate', costExact: false };
    const specFor = (tag, files) => ({
      mode: 'evaluate', ledgerWorkspace: env.lockWorkspace,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
      taskId: ids.taskId, taskInstanceId: ids.taskInstanceId, sessionId: SESSION_ID,
      sessionFile: files.sessionFile, localSessionFile: path.join(env.base, 'session-' + tag + '.json'),
      taskStateFile: files.taskStateFile, unitsFile: files.unitsFile,
      controller: files.controller, provider, tokenObservation,
      resultFile: path.join(env.base, 'result-' + tag + '.json'),
    });
    const files1 = { sessionFile, taskStateFile, unitsFile, controller };
    // Sequential contention first (deterministic): A compacts G1.
    const ra = runWorker(specFor('a', files1));
    check(ra.ok === true && ra.result.action === 'compacted' && ra.result.generation === 1, 'process A compacts G1 (got ' + JSON.stringify(ra).slice(0, 200) + ')');
    // B with a stale view fails closed WITHOUT mutating shared state, then
    // refreshes from the winner and converges on G2 (never a competing G1).
    const rbStale = runWorker(specFor('b-stale', files1));
    check(rbStale.ok === true && rbStale.result.taskMayContinue === false, 'H2 stale-view loser fails closed (no masked corruption)');
    check(headOf(env, ids).highestAllocatedGeneration === 1, 'stale loser reserves no competing generation');
    const freshEvents = JSON.parse(fs.readFileSync(path.join(env.base, 'session-a.json'), 'utf8'));
    const freshSessionFile = path.join(env.base, 'session-fresh.json');
    writeJson(freshSessionFile, freshEvents);
    const fx2 = fixtureFor(ids.taskId, ids.taskInstanceId, freshEvents, 2);
    const taskStateFile2 = path.join(env.base, 'ts2.json');
    const unitsFile2 = path.join(env.base, 'units2.json');
    writeJson(taskStateFile2, fx2.ts);
    writeJson(unitsFile2, fx2.units);
    const controller2 = { taskStatus: 'active', transitionOpen: false, completionCommitted: false, streamOpen: false, toolEdgeOpen: false, taskRevision: fx2.ts.taskRevision };
    const rb = runWorker(specFor('b', { sessionFile: freshSessionFile, taskStateFile: taskStateFile2, unitsFile: unitsFile2, controller: controller2 }));
    check(rb.ok === true && rb.result.action === 'compacted' && rb.result.generation === 2, 'refreshed process B commits G2 (got ' + (rb.result && rb.result.action) + ')');
    const st = headOf(env, ids);
    check(st.latestCommittedGeneration === 2, 'single committed head after contention');
    check(st.generations.filter((g) => g.outcome === 'COMMITTED').map((g) => g.generation).join('->') === '1->2', 'no forked lineage');
  }
  section('A13X TRUE PARALLEL RACE (simultaneous processes, real lock arbitrates)');
  {
    const { spawn } = require('node:child_process');
    const env = makeEnv();
    const ids = bootstrapLedgerTask(env.lockWorkspace);
    const events = seedEvents();
    const sessionFile = path.join(env.base, 'session.json');
    writeJson(sessionFile, { events, surface: events.map((e) => e.seq) });
    const fx = fixtureFor(ids.taskId, ids.taskInstanceId, { events }, 1);
    const taskStateFile = path.join(env.base, 'ts.json');
    const unitsFile = path.join(env.base, 'units.json');
    writeJson(taskStateFile, fx.ts);
    writeJson(unitsFile, fx.units);
    const controller = { taskStatus: 'active', transitionOpen: false, completionCommitted: false, streamOpen: false, toolEdgeOpen: false, taskRevision: fx.ts.taskRevision };
    const provider = { modelId: 'deepseek-v4-flash', capacityTokens: 131072 };
    const tokenObservation = { currentContextTokens: HIGH_TOK, costMethod: 'conservative-estimate', costExact: false };
    const spawnWorkerAsync = (tag) => new Promise((resolve, reject) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a13xwp-'));
      const specFile = path.join(dir, 'spec.json');
      writeJson(specFile, {
        mode: 'evaluate', ledgerWorkspace: env.lockWorkspace,
        runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
        taskId: ids.taskId, taskInstanceId: ids.taskInstanceId, sessionId: SESSION_ID,
        sessionFile, localSessionFile: path.join(env.base, 'session-p-' + tag + '.json'),
        taskStateFile, unitsFile, controller, provider, tokenObservation,
        resultFile: path.join(env.base, 'result-p-' + tag + '.json'),
      });
      const child = spawn(process.execPath, [WORKER, specFile], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', () => {
        try {
          const line = String(out).trim().split('\n').filter((l) => l !== '').pop() || '';
          resolve(JSON.parse(line));
        } catch (e) { reject(new Error('parallel worker unparsable: ' + String(out).slice(0, 300) + ' err=' + String(err).slice(0, 200))); }
      });
    });
    const results = await Promise.all([spawnWorkerAsync('p1'), spawnWorkerAsync('p2')]);
    check(results.length === 2 && results.every((r) => r.ok === true), 'both parallel processes terminate with results');
    const winners = results.filter((r) => r.result && r.result.action === 'compacted');
    check(winners.length >= 1, 'at least one parallel winner compacts (got ' + winners.length + ')');
    check(results.every((r) => r.result && INTEGRATION_ACTION_SET.indexOf(r.result.action) !== -1), 'every parallel process returns a bounded result');
    for (const r of results) {
      if (r.result.taskMayContinue === false) {
        check(r.result.action === 'failed' || r.result.action === 'blocked', 'fail-closed loser carries a blocking action (got ' + r.result.action + ')');
      }
    }
    const st = headOf(env, ids);
    check(st.latestCommittedGeneration === 1, 'parallel race yields one committed head');
    check(st.highestAllocatedGeneration === 1, 'parallel race reserves no competing generation');
    check(st.generations.filter((g) => g.outcome === 'COMMITTED').length === 1, 'parallel race forks no lineage');
  }
  section('A13X H6/H7 cross-process restart recovery (fresh processes, no bundles)');
  {
    const env = makeEnv();
    const ids = bootstrapLedgerTask(env.lockWorkspace);
    const events = seedEvents();
    // Multi-segment seed so the injected crash lands partially.
    events.splice(2, 0, { seq: -1, type: 'user/message', data: { id: 'msg-a13x-rt', role: 'user', content: [{ type: 'text', text: 'A13X-RUNTIME' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' } } });
    events.forEach((e, i) => { e.seq = i; });
    const sessionFile = path.join(env.base, 'session.json');
    writeJson(sessionFile, { events, surface: events.map((e) => e.seq) });
    const fx = fixtureFor(ids.taskId, ids.taskInstanceId, { events }, 1);
    const taskStateFile = path.join(env.base, 'ts.json');
    const unitsFile = path.join(env.base, 'units.json');
    writeJson(taskStateFile, fx.ts);
    writeJson(unitsFile, fx.units);
    const controller = { taskStatus: 'active', transitionOpen: false, completionCommitted: false, streamOpen: false, toolEdgeOpen: false, taskRevision: fx.ts.taskRevision };
    const provider = { modelId: 'deepseek-v4-flash', capacityTokens: 131072 };
    const tokenObservation = { currentContextTokens: HIGH_TOK, costMethod: 'conservative-estimate', costExact: false };
    // H6: process A crashes mid-apply and exits. No shared JS objects,
    // no cached bundles cross the boundary: only durable files survive.
    const ra = runWorker({
      mode: 'evaluate', ledgerWorkspace: env.lockWorkspace,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
      taskId: ids.taskId, taskInstanceId: ids.taskInstanceId, sessionId: SESSION_ID,
      sessionFile, localSessionFile: path.join(env.base, 'session-a.json'),
      taskStateFile, unitsFile, controller, provider, tokenObservation, faultAppends: 2, writeThrough: true,
      resultFile: path.join(env.base, 'result-a.json'),
    });
    check(ra.ok === true && ra.result.taskMayContinue === false, 'crashed process reports blocked progression (got ' + JSON.stringify(ra).slice(0, 200) + ')');
    // A DIFFERENT process observes the same identity: plain evaluation
    // still cannot progress across UNRESOLVED state (no bundle in hand).
    const rb = runWorker({
      mode: 'evaluate', ledgerWorkspace: env.lockWorkspace,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
      taskId: ids.taskId, taskInstanceId: ids.taskInstanceId, sessionId: SESSION_ID,
      sessionFile: path.join(env.base, 'session-a.json'), localSessionFile: path.join(env.base, 'session-b.json'),
      taskStateFile, unitsFile, controller, provider, tokenObservation,
      resultFile: path.join(env.base, 'result-b.json'),
    });
    check(rb.ok === true && rb.result.taskMayContinue === false, 'fresh process cannot progress across UNRESOLVED state');
    const rh = runWorker({
      mode: 'health', ledgerWorkspace: env.lockWorkspace,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
      taskId: ids.taskId, taskInstanceId: ids.taskInstanceId, sessionId: SESSION_ID,
      sessionFile: path.join(env.base, 'session-a.json'),
    });
    check(rh.ok === true && rh.result.healthy === false, 'completion health gate fails while unresolved');
    // H6 principal: a FRESH process resumes from durable artifacts alone
    // (no bundle, no shared closures) and recovers G1.
    const rr = runWorker({
      mode: 'resume', ledgerWorkspace: env.lockWorkspace,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
      taskId: ids.taskId, taskInstanceId: ids.taskInstanceId, sessionId: SESSION_ID,
      sessionFile: path.join(env.base, 'session-a.json'), localSessionFile: path.join(env.base, 'session-r.json'),
    });
    check(rr.ok === true && rr.result.mayResume === true && rr.result.latestCommittedGeneration === 1, 'fresh-process resume recovers G1 from durable state (got ' + JSON.stringify(rr).slice(0, 250) + ')');
    check(rr.result.recoveryAttempted === true, 'fresh-process recovery engaged durable path');
    // The recovered task continues in another fresh process: G2 compacts.
    const recoveredSnap = JSON.parse(fs.readFileSync(path.join(env.base, 'session-r.json'), 'utf8'));
    const fx2 = fixtureFor(ids.taskId, ids.taskInstanceId, recoveredSnap, 2);
    const taskStateFile2 = path.join(env.base, 'ts2.json');
    const unitsFile2 = path.join(env.base, 'units2.json');
    writeJson(taskStateFile2, fx2.ts);
    writeJson(unitsFile2, fx2.units);
    const controller2 = { taskStatus: 'active', transitionOpen: false, completionCommitted: false, streamOpen: false, toolEdgeOpen: false, taskRevision: fx2.ts.taskRevision };
    const rg = runWorker({
      mode: 'evaluate', ledgerWorkspace: env.lockWorkspace,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
      taskId: ids.taskId, taskInstanceId: ids.taskInstanceId, sessionId: SESSION_ID,
      sessionFile: path.join(env.base, 'session-r.json'), localSessionFile: path.join(env.base, 'session-g.json'),
      taskStateFile: taskStateFile2, unitsFile: unitsFile2, controller: controller2, provider, tokenObservation,
      resultFile: path.join(env.base, 'result-g.json'),
    });
    check(rg.ok === true && rg.result.action === 'compacted' && rg.result.generation === 2, 'recovered task continues with G2 (got ' + (rg.result && rg.result.action) + ')');
    // H7: process C resumes again -> steady, no new events, same head.
    const bytesBeforeC = fs.readFileSync(path.join(env.base, 'session-g.json'), 'utf8');
    const rc = runWorker({
      mode: 'resume', ledgerWorkspace: env.lockWorkspace,
      runtimeDir: env.runtimeDir, checkpointDir: env.checkpointDir, operationRoot: env.operationRoot,
      taskId: ids.taskId, taskInstanceId: ids.taskInstanceId, sessionId: SESSION_ID,
      sessionFile: path.join(env.base, 'session-g.json'), localSessionFile: path.join(env.base, 'session-c.json'),
    });
    check(rc.ok === true && rc.result.mayResume === true && rc.result.reconstructionOutcome === 'steady', 'third-process resume is steady');
    const bytesAfterC = fs.readFileSync(path.join(env.base, 'session-c.json'), 'utf8');
    check(bytesAfterC === bytesBeforeC, 'recovery never replays across processes');
    const stx = headOf(env, ids);
    check(stx.latestCommittedGeneration === 2, 'same committed head after every restart');
    check(stx.generations.filter((g) => g.outcome === 'COMMITTED').map((g) => g.generation).join('->') === '1->2', 'cross-process lineage stays valid');
  }
}

main().then(() => {
  console.log('');
  console.log('A13X SUMMARY passed=' + passed + ' failed=' + failed);
  if (failed > 0) process.exitCode = 1;
}, (error) => {
  console.error('A13X FATAL:', error);
  process.exitCode = 1;
});
