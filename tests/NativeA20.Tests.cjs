'use strict';

/**
 * A2.0 dispatch-safety adversarial tests — real daemon, real Registry shapes.
 *
 * Covers rollback, replay, forged issuer authority, capability theft,
 * recovery posture, read-only readiness, and the dispatch-disabled guard
 * through the real `nexusd` binary over real Unix sockets. Temporary
 * DataRoots/sockets only; DSH untouched; no inference; no execution.
 * Run: node tests/NativeA20.Tests.cjs
 */

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const shadow = require('../config/registry/native-shadow.cjs');
const daemonBridge = require('../config/registry/native-shadow-daemon.cjs');

const results = [];
function check(name, cond, extra) {
  results.push({ name: name, pass: !!cond, extra: extra || '' });
  if (!cond) console.log('FAIL ' + name + (extra ? ' :: ' + extra : ''));
}

function nexusdBin() {
  if (process.env.NEXUSD_BIN && process.env.NEXUSD_BIN !== '') return process.env.NEXUSD_BIN;
  return path.join(REPO_ROOT, 'native', 'target', 'debug', 'nexusd');
}

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sleepMs(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function rawFrame(socketPath, text, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const socket = net.createConnection({ path: socketPath });
    let buffer = '';
    const timer = setTimeout(function () { try { socket.destroy(); } catch {} reject(new Error('raw frame timeout')); }, timeoutMs || 10000);
    socket.setEncoding('utf8');
    socket.on('error', function (e) { clearTimeout(timer); reject(e); });
    socket.on('connect', function () { socket.write(text + '\n', 'utf8'); });
    socket.on('data', function (chunk) {
      buffer += String(chunk);
      const idx = buffer.indexOf('\n');
      if (idx >= 0) {
        clearTimeout(timer);
        try { socket.destroy(); } catch {}
        try { resolve(JSON.parse(buffer.slice(0, idx))); }
        catch (e) { reject(e); }
      }
    });
  });
}

async function spawnDaemon(trustMode, withWitness) {
  const dir = mkTemp('a20-nexusd-');
  const handle = {
    dir: dir,
    db: path.join(dir, 'k.db'),
    witness: path.join(dir, 'k.witness.db'),
    socket: path.join(dir, 'n.sock'),
    cap: path.join(dir, 'issuer.cap'),
    trust: trustMode,
    withWitness: withWitness,
    proc: null,
  };
  startDaemon(handle);
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const resp = await rawFrame(handle.socket, '{"protocol":1,"id":"ready-poll","cmd":"health","params":{}}', 1000);
      if (resp && resp.ok === true) break;
    } catch {}
    if (Date.now() > deadline) {
      try { handle.proc.kill('SIGKILL'); } catch {}
      throw new Error('nexusd never became ready');
    }
    if (handle.proc.exitCode !== null) throw new Error('nexusd exited early with ' + handle.proc.exitCode);
    await sleepMs(25);
  }
  return handle;
}

function startDaemon(handle) {
  const args = ['--db', handle.db, '--socket', handle.socket, '--cap', handle.cap, '--trust-mode', handle.trust];
  if (handle.withWitness) args.push('--witness', handle.witness);
  handle.proc = childProcess.spawn(nexusdBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function stopDaemon(handle, signal) {
  if (!handle.proc || handle.proc.exitCode !== null) return;
  try { handle.proc.kill(signal || 'SIGTERM'); } catch {}
  const deadline = Date.now() + 10000;
  while (handle.proc.exitCode === null && Date.now() < deadline) await sleepMs(25);
  try { handle.proc.kill('SIGKILL'); } catch {}
}

async function restartDaemon(handle) {
  startDaemon(handle);
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const resp = await rawFrame(handle.socket, '{"protocol":1,"id":"ready-poll","cmd":"health","params":{}}', 1000);
      if (resp && resp.ok === true) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('restarted nexusd never became ready');
    await sleepMs(25);
  }
}

function writeTaskLedger(workspace, task) {
  const stateDir = path.join(workspace, '.ai-harness', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'tasks.json'), JSON.stringify({ schemaVersion: 1, nextSequence: 2, tasks: [task] }), 'utf8');
  fs.mkdirSync(path.join(workspace, '.ai-harness', 'runs', task.taskId), { recursive: true });
}

function appendAttempt(workspace, taskId, record) {
  const dir = path.join(workspace, '.ai-harness', 'runs', taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'attempts.jsonl'), JSON.stringify(record) + '\n', 'utf8');
}

function makeTask(taskId, instanceId) {
  return {
    schemaVersion: 1, taskId: taskId, taskInstanceId: instanceId, boundEngine: 'muse',
    description: 'synthetic A2.0 fixture (never executed)', status: 'implementing', dependencies: [],
    baseCommit: null, executionClass: 'muse_main', executor: 'muse_main', attempt: 1, maxAttempts: 3,
    risk: 'normal', acceptanceCriteria: [], verification: { required: [], outcomes: [] },
    reviewRequested: false, worktree: null, failureSignatures: [], codexCalls: 0,
    completionAuthority: 'controller', createdAtUtc: new Date().toISOString(),
    updatedAtUtc: new Date().toISOString(), completedAtUtc: null,
  };
}

function makeAttempt(taskId, instanceId, seq) {
  return {
    attemptId: taskId + '-A' + seq, taskId: taskId, taskInstanceId: instanceId,
    sequence: seq, executionClass: 'muse_main', status: 'started',
    sessionId: 'sess-' + seq, startedByTurn: 'turn-' + seq,
    timestampUtc: new Date().toISOString(),
  };
}

function daemonOpts(workspace, handle, extra) {
  return Object.assign({
    workspace: workspace,
    installRoot: REPO_ROOT,
    dataRoot: REPO_ROOT,
    repoRoot: REPO_ROOT,
    dbPath: handle.db,
    witnessPath: handle.witness,
    daemonSocket: handle.socket,
    daemonCapPath: handle.cap,
    env: { NEXUS_NATIVE_SHADOW: '1' },
  }, extra || {});
}

function copyMainStore(dbPath, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = dbPath + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, path.basename(src)));
  }
}

function restoreMainStore(dbPath, backupDir) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
  for (const name of fs.readdirSync(backupDir)) {
    fs.copyFileSync(path.join(backupDir, name), path.join(path.dirname(dbPath), name));
  }
}

async function authed(handle, cmd, params, id) {
  return daemonBridge.invokeDaemonBridge(cmd, params, { daemonSocket: handle.socket, daemonCapPath: handle.cap });
}

async function main() {
  check('nexusd binary exists', fs.existsSync(nexusdBin()), nexusdBin());

  // ---- R1. Rollback: full main-store restore, intact witness -------------
  const hR = await spawnDaemon('shadow-test', true);
  const wsR = mkTemp('a20-controller-');
  const instR = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsR, makeTask('TASK-R1', instR));
  appendAttempt(wsR, 'TASK-R1', makeAttempt('TASK-R1', instR, 1));
  const rOpts = daemonOpts(wsR, hR, { taskId: 'TASK-R1', taskInstanceId: instR });
  const backupDir = path.join(hR.dir, 'main-backup');
  copyMainStore(hR.db, backupDir);
  const r1 = await shadow.observeCommittedAttempt(rOpts, {});
  check('R1 delivery succeeds before restore', r1.outcome === 'delivered', JSON.stringify(r1).slice(0, 200));
  const cmdR = r1.commandId;
  await stopDaemon(hR);
  restoreMainStore(hR.db, backupDir);
  await restartDaemon(hR);
  const rReplay = await shadow.observeCommittedAttempt(rOpts, {});
  const rCode = rReplay.code || '';
  check('R1 replay after full main-store restore is refused, never duplicated',
    (rReplay.outcome === 'refused' || rReplay.outcome === 'uncertain') &&
    (rCode === 'reconciliation-required' || rCode === 'rollback-detected'),
    rReplay.outcome + '/' + rCode);
  const stR = await daemonBridge.invokeDaemonBridge('status', {}, { daemonSocket: hR.socket });
  check('R1 no duplicate receipt was invented by the restore',
    stR.ok && stR.status === 'ok' && stR.response.acceptedCommands === 0,
    JSON.stringify(stR.response && stR.response.acceptedCommands));
  const recR = await daemonBridge.invokeDaemonBridge('receipt', { commandId: cmdR }, { daemonSocket: hR.socket });
  check('R1 lost receipt stays lost (outcome explicitly unknown)',
    recR.ok && recR.status === 'ok' && (recR.response.receipt === null || recR.response.receipt === undefined),
    JSON.stringify(recR).slice(0, 160));
  await stopDaemon(hR);

  // ---- R2. Replay converges, never duplicates ----------------------------
  const hP = await spawnDaemon('shadow-test', true);
  const wsP = mkTemp('a20-controller-');
  const instP = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsP, makeTask('TASK-R2', instP));
  appendAttempt(wsP, 'TASK-R2', makeAttempt('TASK-R2', instP, 1));
  const pOpts = daemonOpts(wsP, hP, { taskId: 'TASK-R2', taskInstanceId: instP });
  const p1 = await shadow.observeCommittedAttempt(pOpts, {});
  const p2 = await shadow.observeCommittedAttempt(pOpts, {});
  check('R2 identical redelivery replays the durable receipt',
    p1.outcome === 'delivered' && p2.outcome === 'replayed' && p1.commandId === p2.commandId,
    p1.outcome + '/' + p2.outcome);
  const stP = await daemonBridge.invokeDaemonBridge('status', {}, { daemonSocket: hP.socket });
  check('R2 exactly one authoritative receipt exists after replay',
    stP.ok && stP.response.acceptedCommands === 1,
    String(stP.response && stP.response.acceptedCommands));
  check('R2 replayed receipt stays dispatch-disabled',
    p2.status === 'accepted-reserved-dispatch-disabled', String(p2.status));

  // ---- R3. Forged issuer authority is refused -----------------------------
  const acq = await authed(hP, 'acquire', { taskInstanceId: 'task-forge', backend: 'native' });
  check('R3 setup acquire succeeds', acq.ok && acq.status === 'ok', JSON.stringify(acq).slice(0, 160));
  const forgedResolution = {
    schemaVersion: 1, issuer: 'self-declared-forgery', taskInstanceId: 'task-forge',
    role: 'muse_main',
    target: { schemaVersion: 1, role: 'muse_main', modeId: 'engineering-v2', modeConfigRevision: 3, transport: 'forged-pipe', endpoint: 'evil' },
    provenance: {
      issuer: 'self-declared-forgery', resolutionIdCompat: 'compat',
      registrySnapshotDigest: '00'.repeat(32), targetDigest: '11'.repeat(32),
      modeConfigRevision: 3, issuanceId: '22'.repeat(32),
    },
  };
  const unauthSeal = await daemonBridge.invokeDaemonBridge('seal', { resolution: forgedResolution }, { daemonSocket: hP.socket });
  check('R3 unauthenticated forged seal is refused before kernel semantics',
    unauthSeal.ok && unauthSeal.status === 'refused' && unauthSeal.code === 'issuer-untrusted',
    unauthSeal.code + '/' + unauthSeal.status);
  const authSeal = await authed(hP, 'seal', { resolution: forgedResolution }, 'forge-1');
  check('R3 authenticated forged bytes fail kernel seal verification (never trusted by schema)',
    authSeal.ok && authSeal.status === 'refused' &&
    (authSeal.code === 'delivery-invalid' || authSeal.code === 'forged-issuer' || authSeal.code === 'target-incomplete' || authSeal.code === 'bad-request'),
    authSeal.code + '/' + authSeal.status);
  await stopDaemon(hP);

  // ---- R4. Same-UID capability theft still succeeds (HARD BLOCKER) --------
  const hT = await spawnDaemon('shadow-test', true);
  let capMode = 0;
  try { capMode = fs.statSync(hT.cap).mode & 0o777; } catch {}
  check('R4 capability file is owner-only on disk (0600)', capMode === 0o600, 'mode=' + capMode.toString(8));
  const stolenKey = fs.readFileSync(hT.cap, 'utf8').trim();
  check('R4 same-UID process can read the capability file', stolenKey.length === 64, 'len=' + stolenKey.length);
  const theftParams = { taskInstanceId: 'task-same-uid-a20', backend: 'native' };
  const theftId = 'theft-a20-1';
  const theftNonce = crypto.randomBytes(16).toString('hex');
  const theftTs = Date.now();
  const theftTag = daemonBridge.hmacTag(stolenKey, daemonBridge.authBytesOf('acquire', theftId, theftParams, theftNonce, theftTs));
  const theft = await rawFrame(hT.socket, JSON.stringify({ protocol: 1, id: theftId, cmd: 'acquire', params: theftParams, auth: { nonce: theftNonce, ts: theftTs, tag: theftTag } }));
  check('R4 stolen capability impersonates the trusted issuer (BLOCKER: same-UID isolation absent)',
    theft.ok === true, JSON.stringify(theft).slice(0, 160));
  await stopDaemon(hT);

  // ---- R5. Read-only readiness: NOT_READY, never authorization -----------
  const hV = await spawnDaemon('shadow-test', true);
  const ready0 = await daemonBridge.invokeDaemonBridge('readiness', {}, { daemonSocket: hV.socket });
  const dims0 = (ready0.ok && ready0.response.readiness && ready0.response.readiness.dimensions) || [];
  const names0 = dims0.map(function (d) { return d.name; }).sort();
  check('R5 readiness reports NOT_READY with no authorization token',
    ready0.ok && ready0.status === 'ok' && ready0.response.readiness.verdict === 'NOT_READY' &&
    ready0.response.readiness.ready === false && ready0.response.readiness.dispatch_enabled === false,
    JSON.stringify(ready0).slice(0, 200));
  check('R5 all nine blocker dimensions are individually evaluated',
    ['controller-durable-authority', 'dispatch-disabled', 'dispatch-reservation', 'generation-lease', 'pinned-target', 'reconciliation-state', 'recovery-attestation', 'trusted-issuer-identity', 'witness-health'].every(function (n) { return names0.indexOf(n) >= 0; }),
    names0.join(','));
  check('R5 mandatory proofs are absent without a command (issuer/authority/reservation)',
    dims0.filter(function (d) { return d.name === 'trusted-issuer-identity' || d.name === 'controller-durable-authority' || d.name === 'dispatch-reservation'; }).every(function (d) { return d.ready === false; }));
  const wsV = mkTemp('a20-controller-');
  const instV = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsV, makeTask('TASK-R5', instV));
  appendAttempt(wsV, 'TASK-R5', makeAttempt('TASK-R5', instV, 1));
  const vOpts = daemonOpts(wsV, hV, { taskId: 'TASK-R5', taskInstanceId: instV });
  const v1 = await shadow.observeCommittedAttempt(vOpts, {});
  const ready1 = await daemonBridge.invokeDaemonBridge('readiness', { commandId: v1.commandId }, { daemonSocket: hV.socket });
  const dims1 = (ready1.ok && ready1.response.readiness && ready1.response.readiness.dimensions) || [];
  function dimReady(dims, name) {
    const found = dims.filter(function (d) { return d.name === name; })[0];
    return found && found.ready;
  }
  check('R5 per-command readiness pins target, lease and acknowledged reservation',
    ready1.ok && dimReady(dims1, 'pinned-target') === true && dimReady(dims1, 'generation-lease') === true &&
    dimReady(dims1, 'dispatch-reservation') === true && dimReady(dims1, 'witness-health') === true,
    JSON.stringify(dims1.map(function (d) { return d.name + '=' + d.ready; })));
  check('R5 verdict stays NOT_READY even for a fully acknowledged command (dispatch disabled)',
    ready1.ok && ready1.response.readiness.verdict === 'NOT_READY' && ready1.response.readiness.ready === false,
    ready1.response.readiness.verdict);
  const stV0 = await daemonBridge.invokeDaemonBridge('status', {}, { daemonSocket: hV.socket });
  await daemonBridge.invokeDaemonBridge('readiness', { commandId: v1.commandId }, { daemonSocket: hV.socket });
  await daemonBridge.invokeDaemonBridge('readiness', {}, { daemonSocket: hV.socket });
  const stV1 = await daemonBridge.invokeDaemonBridge('status', {}, { daemonSocket: hV.socket });
  check('R5 readiness assessments mutate no state (read-only proof)',
    stV0.response.acceptedCommands === stV1.response.acceptedCommands &&
    stV0.response.eventCount === stV1.response.eventCount,
    stV0.response.acceptedCommands + '/' + stV1.response.acceptedCommands);
  const dispCmd = await rawFrame(hV.socket, JSON.stringify({ protocol: 1, id: 'dx', cmd: 'dispatch', params: {} }));
  check('R5 no dispatch command exists (unknown-command, never authorized)',
    dispCmd.ok === false && dispCmd.code === 'unknown-command', dispCmd.code);
  await stopDaemon(hV);

  // ---- R6. Witnessless posture fails closed --------------------------------
  const hW = await spawnDaemon('shadow-test', false);
  const readyW = await daemonBridge.invokeDaemonBridge('readiness', {}, { daemonSocket: hW.socket });
  const dimsW = (readyW.ok && readyW.response.readiness && readyW.response.readiness.dimensions) || [];
  check('R6 witnessless readiness flags witness-health NOT_READY',
    readyW.ok && dimsW.filter(function (d) { return d.name === 'witness-health'; })[0].ready === false &&
    readyW.response.readiness.verdict === 'NOT_READY',
    JSON.stringify(dimsW.filter(function (d) { return d.name === 'witness-health'; })));
  await stopDaemon(hW);

  // ---- R7. Readonly daemon: readiness serves, privilege refused -----------
  const hO = await spawnDaemon('readonly', true);
  const readyO = await daemonBridge.invokeDaemonBridge('readiness', {}, { daemonSocket: hO.socket });
  check('R7 readiness is unauthenticated read-only surface (serves in readonly mode)',
    readyO.ok && readyO.status === 'ok' && readyO.response.readiness.verdict === 'NOT_READY',
    readyO.code || readyO.status);
  const roAcquire = await daemonBridge.invokeDaemonBridge('acquire',
    { taskInstanceId: 't', backend: 'native' },
    { daemonSocket: hO.socket, daemonCapPath: path.join(hO.dir, 'dummy.cap') });
  fs.writeFileSync(path.join(hO.dir, 'dummy.cap'), 'ab'.repeat(32), 'utf8');
  const roAcquire2 = await daemonBridge.invokeDaemonBridge('acquire',
    { taskInstanceId: 't', backend: 'native' },
    { daemonSocket: hO.socket, daemonCapPath: path.join(hO.dir, 'dummy.cap') });
  check('R7 readonly privilege stays refused (no credential enables it)',
    roAcquire2.ok && roAcquire2.status === 'refused' && roAcquire2.code === 'privileged-disabled',
    roAcquire2.code + '/' + roAcquire2.status);
  await stopDaemon(hO);

  const failed = results.filter(function (r) { return !r.pass; });
  console.log('\nA2.0: ' + (results.length - failed.length) + '/' + results.length + ' PASS' + (failed.length ? ' -- FAILING: ' + failed.map(function (r) { return r.name; }).join('; ') : ''));
  if (failed.length) process.exitCode = 1;
}

main().catch(function (e) {
  console.log('FATAL ' + (e && e.stack || e));
  process.exitCode = 1;
});
