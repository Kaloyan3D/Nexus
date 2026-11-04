'use strict';

/**
 * A1.3 daemon shadow integration tests — real sources only.
 *
 * Real `nexusd` binary as a subprocess over a real Unix socket, the REAL
 * Registry compiler, real TaskController ledger shapes (synthetic ledgers
 * plus one real-Controller section through pwsh Task.ps1), and the REAL
 * shadow adapter with the daemon transport selected.
 *
 * Temporary DataRoots and sockets only; nothing touches the repository
 * ledger or live task data. Shadow stays OFF by default; DSH authority is
 * untouched (no DSH module is even loaded here).
 * Run: node tests/NativeShadowA13.Tests.cjs
 */

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const shadowIntent = require('../config/registry/native-shadow-intent.cjs');
const issuer = require('../config/registry/native-issuer.cjs');
const bridge = require('../config/registry/native-shadow-bridge.cjs');
const shadow = require('../config/registry/native-shadow.cjs');
const daemonBridge = require('../config/registry/native-shadow-daemon.cjs');

const results = [];
function check(name, cond, extra) {
  results.push({ name: name, pass: !!cond, extra: extra || '' });
  if (!cond) console.log('FAIL ' + name + (extra ? ' :: ' + extra : ''));
  else console.log('PASS ' + name);
}

function nexusdBin() {
  if (process.env.NEXUSD_BIN && process.env.NEXUSD_BIN !== '') return process.env.NEXUSD_BIN;
  return path.join(REPO_ROOT, 'native', 'target', 'debug', 'nexusd');
}

function kernelBin() {
  if (process.env.NEXUS_KERNEL_BIN && process.env.NEXUS_KERNEL_BIN !== '') return process.env.NEXUS_KERNEL_BIN;
  return path.join(REPO_ROOT, 'native', 'target', 'debug', 'nexus-kernel');
}

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function makeTask(taskId, instanceId, executionClass) {
  return {
    schemaVersion: 1, taskId: taskId, taskInstanceId: instanceId, boundEngine: 'muse',
    description: 'synthetic A1.3 fixture (never executed)', status: 'implementing', dependencies: [],
    baseCommit: null, executionClass: executionClass, executor: executionClass, attempt: 1, maxAttempts: 3,
    risk: 'normal', acceptanceCriteria: [], verification: { required: [], outcomes: [] },
    reviewRequested: false, worktree: null, failureSignatures: [], codexCalls: 0,
    completionAuthority: 'controller', createdAtUtc: new Date().toISOString(),
    updatedAtUtc: new Date().toISOString(), completedAtUtc: null,
  };
}

function makeAttempt(taskId, instanceId, seq, executionClass, extra) {
  return Object.assign({
    attemptId: taskId + '-A' + seq, taskId: taskId, taskInstanceId: instanceId,
    workspace: 'fixture-workspace', sequence: seq, executionClass: executionClass,
    status: 'started', startedAtUtc: new Date().toISOString(),
    sessionId: 'sess-fixture-1', startedByTurn: 'turn-fixture-7',
  }, extra || {});
}

function snapshotLedger(workspace, taskId) {
  return {
    tasks: fs.readFileSync(path.join(workspace, '.ai-harness', 'state', 'tasks.json'), 'utf8'),
    attempts: fs.readFileSync(path.join(workspace, '.ai-harness', 'runs', taskId, 'attempts.jsonl'), 'utf8'),
  };
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
  const dir = mkTemp('a13-nexusd-');
  const handle = {
    dir: dir,
    db: path.join(dir, 'k.db'),
    witness: path.join(dir, 'k.witness.db'),
    socket: path.join(dir, 'n.sock'),
    cap: path.join(dir, 'issuer.cap'),
    proc: null,
  };
  const args = ['--db', handle.db, '--socket', handle.socket, '--cap', handle.cap, '--trust-mode', trustMode];
  if (withWitness) args.push('--witness', handle.witness);
  handle.proc = childProcess.spawn(nexusdBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function stopDaemon(handle, signal) {
  if (!handle.proc || handle.proc.exitCode !== null) return;
  try { handle.proc.kill(signal || 'SIGTERM'); } catch {}
  const deadline = Date.now() + 10000;
  while (handle.proc.exitCode === null && Date.now() < deadline) await sleepMs(25);
  try { handle.proc.kill('SIGKILL'); } catch {}
}

async function restartDaemon(handle) {
  const trust = handle.trust;
  const args = ['--db', handle.db, '--socket', handle.socket, '--cap', handle.cap, '--trust-mode', trust];
  if (handle.withWitness) args.push('--witness', handle.witness);
  handle.proc = childProcess.spawn(nexusdBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

function resolvePwsh() {
  if (process.env.AIH_PWSH_HOST && fs.existsSync(process.env.AIH_PWSH_HOST)) return process.env.AIH_PWSH_HOST;
  const pinned = path.join(REPO_ROOT, 'runtime', 'pwsh', 'pwsh');
  if (fs.existsSync(pinned)) return pinned;
  try {
    const pathDirs = String(process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
      try {
        const candidate = path.join(dir, process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
        if (fs.existsSync(candidate)) return candidate;
      } catch {}
    }
  } catch {}
  return null;
}

function writePayload(workspace, obj) {
  const p = path.join(workspace, 'aih-payload.json');
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

function runPwsh(pwsh, script, args) {
  const full = [pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO_ROOT, 'scripts', script)].concat(args);
  const out = childProcess.execFileSync(full[0], full.slice(1), { encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  const trimmed = String(out).trim();
  const start = trimmed.search(/\{[\s\S]*$/);
  return JSON.parse(start >= 0 ? trimmed.slice(start) : trimmed);
}

async function daemonStatus(handle) {
  return daemonBridge.invokeDaemonBridge('status', {}, { daemonSocket: handle.socket });
}

async function main() {
  check('nexusd binary exists', fs.existsSync(nexusdBin()), nexusdBin());

  // ---- A. Daemon transport: versioned IPC + auth --------------------------
  const hA = await spawnDaemon('shadow-test', true);
  hA.trust = 'shadow-test'; hA.withWitness = true;
  const health = await daemonBridge.invokeDaemonBridge('health', {}, { daemonSocket: hA.socket });
  check('A1 daemon health over IPC', health.ok && health.status === 'ok' && health.response.state === 'ready', JSON.stringify(health).slice(0, 200));
  const status = await daemonStatus(hA);
  check('A1 daemon status is shadow-only with dispatch disabled',
    status.ok && status.status === 'ok' && status.response.shadowMode === 'shadow-only' && status.response.dispatchEnabled === false,
    JSON.stringify(status.response && { m: status.response.shadowMode, d: status.response.dispatchEnabled }));
  check('A1 status carries observability fields',
    status.ok && ['incarnation', 'ipcProtocol', 'trustMode', 'acceptedCommands', 'journalHead', 'witness', 'reconciliationRequired', 'activeClients', 'refusals', 'errors'].every(function (f) { return status.response[f] !== undefined; }));
  // Cross-language HMAC agreement (Node signer <-> Rust verifier) is proven
  // by every authenticated call below succeeding.
  const unauth = await daemonBridge.invokeDaemonBridge('acquire', { taskInstanceId: 't', backend: 'native' }, { daemonSocket: hA.socket });
  check('A2 unauthenticated acquire is refused (no CLI fallback)', unauth.ok && unauth.status === 'refused' && unauth.code === 'issuer-untrusted', unauth.code);
  const authed = await daemonBridge.invokeDaemonBridge('acquire', { taskInstanceId: 't', backend: 'native' }, { daemonSocket: hA.socket, daemonCapPath: hA.cap });
  check('A2 authenticated acquire succeeds (HMAC agrees JS<->Rust)', authed.ok && authed.status === 'ok' && authed.response.lease && authed.response.lease.leaseEpoch === 1, JSON.stringify(authed).slice(0, 200));
  // Tampered tag over the same bytes is refused.
  const capKey = fs.readFileSync(hA.cap, 'utf8').trim();
  const id = 'd-tamper';
  const params = { taskInstanceId: 't', backend: 'native' };
  const nonce = crypto.randomBytes(16).toString('hex');
  const ts = Date.now();
  const goodTag = daemonBridge.hmacTag(capKey, daemonBridge.authBytesOf('acquire', id, params, nonce, ts));
  const badTag = goodTag.slice(0, 63) + (goodTag[63] === '0' ? '1' : '0');
  const tampered = await rawFrame(hA.socket, JSON.stringify({ protocol: 1, id: id, cmd: 'acquire', params: params, auth: { nonce: nonce, ts: ts, tag: badTag } }));
  check('A2 tampered auth tag is refused', tampered.ok === false && tampered.code === 'issuer-untrusted', tampered.code);
  // Exact replay of a valid frame is rejected.
  const rid = 'd-replay-1';
  const rnonce = crypto.randomBytes(16).toString('hex');
  const rts = Date.now();
  const rtag = daemonBridge.hmacTag(capKey, daemonBridge.authBytesOf('acquire', rid, params, rnonce, rts));
  const frame = JSON.stringify({ protocol: 1, id: rid, cmd: 'acquire', params: params, auth: { nonce: rnonce, ts: rts, tag: rtag } });
  const first = await rawFrame(hA.socket, frame);
  const replay = await rawFrame(hA.socket, frame);
  check('A2 replayed authorization is rejected', first.ok === true && replay.ok === false && replay.code === 'replay-rejected', (first.ok ? 'first-ok' : 'first-fail') + '/' + replay.code);
  // Protocol violations over the raw socket.
  const ver = await rawFrame(hA.socket, '{"protocol":99,"id":"vx","cmd":"health","params":{}}');
  check('A3 version mismatch is rejected with id echo', ver.ok === false && ver.code === 'version-mismatch' && ver.id === 'vx', ver.code);
  const unk = await rawFrame(hA.socket, '{"protocol":1,"id":"ux","cmd":"ignite","params":{}}');
  check('A3 unknown command fails closed', unk.ok === false && unk.code === 'unknown-command', unk.code);
  const mal = await rawFrame(hA.socket, 'this is not json');
  check('A3 malformed frame is a refusal, not a crash', mal.ok === false && mal.code === 'bad-request', mal.code);
  const big = await rawFrame(hA.socket, JSON.stringify({ protocol: 1, id: 'big', cmd: 'health', params: { pad: 'x'.repeat(1024 * 1024 + 10) } }));
  check('A3 oversized frame is rejected', big.ok === false && big.code === 'too-large', big.code);
  const after = await daemonBridge.invokeDaemonBridge('health', {}, { daemonSocket: hA.socket });
  check('A3 daemon serves after protocol abuse', after.ok && after.status === 'ok');
  // Capability file hygiene.
  let mode = 0;
  try { mode = fs.statSync(hA.cap).mode & 0o777; } catch {}
  check('A4 capability file is owner-only (0600)', mode === 0o600, 'mode=' + mode.toString(8));
  // Same-UID limitation, proven (not merely asserted): the same-UID test
  // process reads the cap and impersonates the issuer successfully.
  const stolen = fs.readFileSync(hA.cap, 'utf8').trim();
  const theft = await daemonBridge.invokeDaemonBridge('acquire', { taskInstanceId: 'task-same-uid-js', backend: 'native' }, { daemonSocket: hA.socket, daemonCapPath: hA.cap });
  check('A4 same-UID cap read impersonates the issuer (LIMITATION, see evidence)', theft.ok && theft.status === 'ok' && stolen.length === 64, theft.status + '/' + (theft.code || 'ok'));
  await stopDaemon(hA);

  // ---- B. Trust modes + CLI bypass ----------------------------------------
  const hB = await spawnDaemon('readonly', true);
  hB.trust = 'readonly'; hB.withWitness = true;
  const roCapExists = fs.existsSync(hB.cap);
  check('B1 readonly mode creates no capability file', roCapExists === false);
  // A well-formed but meaningless credential still cannot enable readonly
  // mutations: the mode check precedes authentication.
  const dummyCap = path.join(hB.dir, 'dummy.cap');
  fs.writeFileSync(dummyCap, 'ab'.repeat(32), 'utf8');
  const roAcq = await daemonBridge.invokeDaemonBridge('acquire', { taskInstanceId: 't', backend: 'native' }, { daemonSocket: hB.socket, daemonCapPath: dummyCap });
  check('B1 readonly acquire is disabled (no credential enables it)', roAcq.ok && roAcq.status === 'refused' && roAcq.code === 'privileged-disabled', roAcq.code + '/' + roAcq.status);
  const roHealth = await daemonBridge.invokeDaemonBridge('health', {}, { daemonSocket: hB.socket });
  check('B1 readonly health still serves', roHealth.ok && roHealth.status === 'ok');
  // Legacy CLI cannot bypass the live daemon's authorization.
  const cliReq = path.join(hB.dir, 'acq.json');
  fs.writeFileSync(cliReq, '{"protocol":1,"taskInstanceId":"t","backend":"native"}', 'utf8');
  let cliFailed = false;
  let cliStderr = '';
  try {
    childProcess.execFileSync(kernelBin(), ['acquire', '--db', hB.db, '--input', cliReq], { encoding: 'utf8', timeout: 60000 });
  } catch (e) {
    cliFailed = true;
    cliStderr = String((e && e.stderr) || '');
  }
  check('B2 legacy CLI acquire is refused while daemon owns the store', cliFailed && cliStderr.includes('daemon-owns-store'), cliStderr.slice(0, 160));
  await stopDaemon(hB);

  // ---- C. Shadow integration through the daemon ----------------------------
  const hC = await spawnDaemon('shadow-test', true);
  hC.trust = 'shadow-test'; hC.withWitness = true;
  const wsC = mkTemp('a13-controller-');
  const instC = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsC, makeTask('TASK-0001', instC, 'muse_main'));
  appendAttempt(wsC, 'TASK-0001', makeAttempt('TASK-0001', instC, 1, 'muse_main'));
  const cOpts = daemonOpts(wsC, hC, { taskId: 'TASK-0001', taskInstanceId: instC });
  const ledS0 = snapshotLedger(wsC, 'TASK-0001');
  const d1 = await shadow.observeCommittedAttempt(cOpts, {});
  check('C1 daemon delivery succeeds for a real-shaped attempt', d1.outcome === 'delivered', JSON.stringify(d1).slice(0, 300));
  check('C1 daemon receipt is dispatch-disabled (never execution evidence)', d1.status === 'accepted-reserved-dispatch-disabled', d1.status);
  const d1b = await shadow.observeCommittedAttempt(cOpts, {});
  check('C1 lost ACK replays the durable receipt by commandId', d1b.outcome === 'replayed' && d1b.commandId === d1.commandId, d1b.outcome);
  const ledS1 = snapshotLedger(wsC, 'TASK-0001');
  check('C1 shadow delivery mutates no ledger bytes', ledS0.tasks === ledS1.tasks && ledS0.attempts === ledS1.attempts);
  // Pin stability across the attempt lifecycle (verifying -> passed). These
  // transition records are Controller writes; the shadow must then leave
  // the ledger untouched again.
  appendAttempt(wsC, 'TASK-0001', makeAttempt('TASK-0001', instC, 1, 'muse_main', { status: 'verifying', timestampUtc: new Date().toISOString() }));
  appendAttempt(wsC, 'TASK-0001', makeAttempt('TASK-0001', instC, 1, 'muse_main', { status: 'passed', timestampUtc: new Date().toISOString() }));
  const ledS2 = snapshotLedger(wsC, 'TASK-0001');
  const d1c = await shadow.observeCommittedAttempt(cOpts, {});
  check('C2 pin is stable across attempt transitions (no duplicate attempt)', d1c.commandId === d1.commandId && (d1c.outcome === 'replayed' || d1c.outcome === 'delivered'), d1c.outcome);
  const st1 = await daemonStatus(hC);
  check('C2 exactly one authoritative receipt exists', st1.ok && st1.response.acceptedCommands === 1, String(st1.response && st1.response.acceptedCommands));
  const ledS3 = snapshotLedger(wsC, 'TASK-0001');
  check('C2 Controller ledger is byte-invariant under shadow work', ledS2.tasks === ledS3.tasks && ledS2.attempts === ledS3.attempts);
  // Registry change after pin fails closed (never silently re-pins).
  const serviceModule = require('../config/registry/service.cjs');
  const realSvc = serviceModule.createService({ installRoot: REPO_ROOT, dataRoot: REPO_ROOT });
  const staged = realSvc.getModeConfiguration('engineering-v2', {});
  const bumped = JSON.parse(JSON.stringify(staged.result.config));
  bumped.revision = (typeof bumped.revision === 'number' ? bumped.revision : 0) + 1000;
  const stubService = {
    getModeConfiguration: function () { return { result: { config: bumped, persisted: false, revision: bumped.revision } }; },
    compilePreview: function (cfg) { return realSvc.compilePreview(cfg); },
  };
  const dChanged = await shadow.observeCommittedAttempt(cOpts, { service: stubService });
  check('C3 Registry change after pin is refused (no silent re-pin)', dChanged.outcome === 'refused' && dChanged.code === 'registry-changed-after-pin', dChanged.outcome + '/' + dChanged.code);
  // Ambiguous Controller history fails closed through the daemon path.
  const wsAmb = mkTemp('a13-ambiguous-');
  const instAmb = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsAmb, makeTask('TASK-0002', instAmb, 'muse_main'));
  appendAttempt(wsAmb, 'TASK-0002', makeAttempt('TASK-0002', instAmb, 1, 'muse_main'));
  appendAttempt(wsAmb, 'TASK-0002', makeAttempt('TASK-0002', instAmb, 2, 'muse_main'));
  const dAmb = await shadow.observeCommittedAttempt(daemonOpts(wsAmb, hC, { taskId: 'TASK-0002', taskInstanceId: instAmb }), {});
  check('C3 ambiguous attempt history is refused (never inferred)', dAmb.outcome === 'refused' && dAmb.code === 'ambiguous-attempt', dAmb.outcome + '/' + dAmb.code);
  // Concurrent identical submissions collapse to one receipt.
  const outcomes = await Promise.all([1, 2, 3, 4, 5, 6].map(function () { return shadow.observeCommittedAttempt(cOpts, {}); }));
  check('C4 concurrent daemon submissions are delivered-or-replayed', outcomes.every(function (o) { return o.outcome === 'delivered' || o.outcome === 'replayed'; }), outcomes.map(function (o) { return o.outcome; }).join(','));
  const st2 = await daemonStatus(hC);
  check('C4 still exactly one receipt after concurrency', st2.ok && st2.response.acceptedCommands === 1, String(st2.response && st2.response.acceptedCommands));
  // Daemon crash between delivery and observation converges on the receipt.
  const dLost = await shadow.observeCommittedAttempt(cOpts, {});
  check('C5 pre-crash observation replays', dLost.outcome === 'replayed', dLost.outcome);
  try { hC.proc.kill('SIGKILL'); } catch {}
  await sleepMs(300);
  await restartDaemon(hC);
  const dAfter = await shadow.observeCommittedAttempt(cOpts, {});
  check('C5 post-crash observation replays the same receipt', dAfter.outcome === 'replayed' && dAfter.commandId === d1.commandId, dAfter.outcome);
  // Reconcile path reuses durable receipts without creating attempts.
  const ledS4 = snapshotLedger(wsC, 'TASK-0001');
  const rec = await shadow.reconcileTask(cOpts, {});
  check('C5 reconcile reuses the durable receipt', rec.replayed.length === 1 && rec.reconciled.length === 0, JSON.stringify(rec).slice(0, 200));
  const ledS5 = snapshotLedger(wsC, 'TASK-0001');
  check('C5 ledger still invariant after crash and reconcile', ledS4.tasks === ledS5.tasks && ledS4.attempts === ledS5.attempts);
  await stopDaemon(hC);

  // ---- D. OFF by default + no silent fallback ------------------------------
  const hD = await spawnDaemon('shadow-test', true);
  hD.trust = 'shadow-test'; hD.withWitness = true;
  const wsD = mkTemp('a13-off-');
  const instD = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsD, makeTask('TASK-0003', instD, 'muse_main'));
  appendAttempt(wsD, 'TASK-0003', makeAttempt('TASK-0003', instD, 1, 'muse_main'));
  const offOpts = daemonOpts(wsD, hD, { taskId: 'TASK-0003', taskInstanceId: instD, env: {} });
  const off = await shadow.observeCommittedAttempt(offOpts, {});
  check('D1 shadow defaults to OFF (no daemon contact)', off.outcome === 'skipped-disabled' && off.code === 'shadow-disabled', off.outcome);
  const outboxExists = fs.existsSync(shadow.outboxPath(wsD, 'TASK-0003'));
  const diagExists = fs.existsSync(shadow.diagnosticsPath(wsD, 'TASK-0003'));
  check('D1 OFF performs no writes', outboxExists === false && diagExists === false);
  // Readonly daemon: the refusal surfaces, never falls back to the CLI.
  await stopDaemon(hD);
  const hR = await spawnDaemon('readonly', true);
  hR.trust = 'readonly'; hR.withWitness = true;
  const cliDb = path.join(hR.dir, 'cli-fallback.db');
  const wsR = mkTemp('a13-nofallback-');
  const instR = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsR, makeTask('TASK-0004', instR, 'muse_main'));
  appendAttempt(wsR, 'TASK-0004', makeAttempt('TASK-0004', instR, 1, 'muse_main'));
  const rOpts = {
    workspace: wsR, installRoot: REPO_ROOT, dataRoot: REPO_ROOT, repoRoot: REPO_ROOT,
    dbPath: cliDb, witnessPath: cliDb + '.witness',
    daemonSocket: hR.socket, daemonCapPath: '',
    taskId: 'TASK-0004', taskInstanceId: instR, env: { NEXUS_NATIVE_SHADOW: '1' },
  };
  const refused = await shadow.observeCommittedAttempt(rOpts, {});
  check('D2 refused daemon request surfaces as refused', refused.outcome === 'refused' && /issuer-untrusted|privileged-disabled/.test(refused.code || ''), refused.outcome + '/' + refused.code);
  check('D2 no silent fallback to CLI mutation (CLI store untouched)', fs.existsSync(cliDb) === false);
  await stopDaemon(hR);

  // ---- E. A1.2 CLI compatibility path still works --------------------------
  const wsE = mkTemp('a13-cli-compat-');
  const instE = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsE, makeTask('TASK-0005', instE, 'muse_main'));
  appendAttempt(wsE, 'TASK-0005', makeAttempt('TASK-0005', instE, 1, 'muse_main'));
  const cliDir = mkTemp('a13-cli-store-');
  const cliOpts = {
    workspace: wsE, installRoot: REPO_ROOT, dataRoot: REPO_ROOT, repoRoot: REPO_ROOT,
    dbPath: path.join(cliDir, 'c.db'), witnessPath: path.join(cliDir, 'c.witness.db'),
    taskId: 'TASK-0005', taskInstanceId: instE, env: { NEXUS_NATIVE_SHADOW: '1' },
  };
  const compat = await shadow.observeCommittedAttempt(cliOpts, {});
  check('E1 explicit CLI compatibility path still delivers (shadow-only)', compat.outcome === 'delivered' && compat.status === 'accepted-reserved-dispatch-disabled', compat.outcome);

  // ---- F. Real TaskController end-to-end through the daemon -----------------
  const pwsh = resolvePwsh();
  if (!pwsh) {
    check('F1 real-Controller section (pwsh available)', false, 'UNVERIFIED: no pwsh host');
  } else {
    const hF = await spawnDaemon('shadow-test', true);
    hF.trust = 'shadow-test'; hF.withWitness = true;
    const wsF = mkTemp('a13-real-');
    const created = runPwsh(pwsh, 'Task.ps1', ['-Action', 'create-task', '-Workspace', wsF, '-Description', 'A1.3 daemon fixture', '-ExecutionClass', 'muse_main', '-Engine', 'muse']);
    const taskId = created.taskId;
    const instanceId = created.taskInstanceId;
    const attempt = runPwsh(pwsh, 'Task.ps1', ['-Action', 'begin-attempt', '-Workspace', wsF, '-TaskId', taskId, '-ExecutionClass', 'muse_main', '-TaskInstanceId', instanceId, '-PayloadFile', writePayload(wsF, { Workspace: wsF, SessionId: 'sess-real-1', StartedByTurn: 'turn-real-1', RequireNoOpenAttempt: true })]);
    check('F1 real begin-attempt commits', attempt && attempt.attemptId === taskId + '-A1' && attempt.taskInstanceId === instanceId, JSON.stringify(attempt).slice(0, 200));
    const fOpts = daemonOpts(wsF, hF, { taskId: taskId, taskInstanceId: instanceId });
    const f1 = await shadow.observeCommittedAttempt(fOpts, {});
    check('F1 real attempt mirrors into the daemon as one receipt', f1.outcome === 'delivered' && f1.status === 'accepted-reserved-dispatch-disabled', f1.outcome);
    runPwsh(pwsh, 'Task.ps1', ['-Action', 'attempt-event', '-Workspace', wsF, '-TaskId', taskId, '-TaskInstanceId', instanceId, '-PayloadFile', writePayload(wsF, { Workspace: wsF, Status: 'verifying' })]);
    runPwsh(pwsh, 'Task.ps1', ['-Action', 'attempt-event', '-Workspace', wsF, '-TaskId', taskId, '-TaskInstanceId', instanceId, '-PayloadFile', writePayload(wsF, { Workspace: wsF, Status: 'passed' })]);
    // Snapshot AFTER the Controller's own lifecycle writes: only shadow
    // work happens past this point, and it must leave zero bytes changed.
    const ledBefore = snapshotLedger(wsF, taskId);
    const f2 = await shadow.observeCommittedAttempt(fOpts, {});
    check('F1 pin stable across real verifying/passed lifecycle', f2.commandId === f1.commandId && f2.outcome === 'replayed', f2.outcome);
    const ledAfter = snapshotLedger(wsF, taskId);
    check('F1 real Controller ledger untouched by shadow', ledBefore.tasks === ledAfter.tasks && ledBefore.attempts === ledAfter.attempts);
    const fst = await daemonStatus(hF);
    check('F1 daemon holds exactly one receipt for the real attempt', fst.ok && fst.response.acceptedCommands === 1, String(fst.response && fst.response.acceptedCommands));
    await stopDaemon(hF);
  }

  const failed = results.filter(function (r) { return !r.pass; });
  console.log('\nA1.3 shadow: ' + (results.length - failed.length) + '/' + results.length + ' PASS' + (failed.length > 0 ? ' :: ' + failed.map(function (r) { return r.name; }).join(' | ') : ''));
  if (failed.length > 0) process.exit(1);
}

main().catch(function (e) {
  console.log('FAIL harness crashed: ' + String((e && e.stack) || e).slice(0, 500));
  process.exit(1);
});
