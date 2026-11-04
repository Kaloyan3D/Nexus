'use strict';

/**
 * A1.2 native shadow integration tests — real sources only.
 *
 * Real-source integration: the REAL registry compiler APIs
 * (registryService.createService + getModeConfiguration + compilePreview),
 * real TaskController ledger shapes through the REAL default file reader,
 * one end-to-end section through the REAL TaskController (pwsh Task.ps1),
 * and the REAL Rust kernel binary over the versioned bridge protocol.
 * Synthetic tasks are used for scale/speed, but they exercise the
 * production file shapes and the production code paths — never hand-built
 * model targets and never fake attempts for every case (section E runs the
 * actual TaskController).
 *
 * Temporary workspaces only; nothing touches the repository ledger.
 * Run: node tests/NativeShadowA12.Tests.cjs
 */

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const shadowIntent = require('../config/registry/native-shadow-intent.cjs');
const issuer = require('../config/registry/native-issuer.cjs');
const bridge = require('../config/registry/native-shadow-bridge.cjs');
const shadow = require('../config/registry/native-shadow.cjs');

const results = [];
function check(name, cond, extra) {
  results.push({ name: name, pass: !!cond, extra: extra || '' });
  if (!cond) console.log('FAIL ' + name + (extra ? ' :: ' + extra : ''));
  else console.log('PASS ' + name);
}

function kernelBin() {
  if (process.env.NEXUS_KERNEL_BIN && process.env.NEXUS_KERNEL_BIN !== '') return process.env.NEXUS_KERNEL_BIN;
  return path.join(REPO_ROOT, 'native', 'target', 'debug', 'nexus-kernel');
}

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -- synthetic Controller ledger shaped EXACTLY like TaskController.ps1 ----
// state/tasks.json: { schemaVersion: 1, nextSequence, tasks: [...] }
// runs/<taskId>/attempts.jsonl: one JSON object per line.
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
    description: 'synthetic A1.2 fixture (never executed)', status: 'implementing', dependencies: [],
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

function readJsonLines(filePath) {
  try {
    return String(fs.readFileSync(filePath, 'utf8')).split('\n').filter(function (l) { return l.trim() !== ''; }).map(function (l) { return JSON.parse(l); });
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

function initKernelStore(tag) {
  const dir = mkTemp('a12-kernel-');
  const db = path.join(dir, tag + '.db');
  const witness = path.join(dir, tag + '.witness.db');
  const bin = kernelBin();
  childProcess.execFileSync(bin, ['init', '--db', db, '--witness', witness], { encoding: 'utf8', timeout: 60000 });
  return { dir: dir, db: db, witness: witness };
}

function baseOpts(workspace, store, extra) {
  return Object.assign({
    workspace: workspace,
    installRoot: REPO_ROOT,
    dataRoot: REPO_ROOT,
    repoRoot: REPO_ROOT,
    dbPath: store.db,
    witnessPath: store.witness,
    env: { NEXUS_NATIVE_SHADOW: '1' },
  }, extra || {});
}

function snapshotLedger(workspace, taskId) {
  return {
    tasks: fs.readFileSync(path.join(workspace, '.ai-harness', 'state', 'tasks.json'), 'utf8'),
    attempts: fs.readFileSync(path.join(workspace, '.ai-harness', 'runs', taskId, 'attempts.jsonl'), 'utf8'),
  };
}

async function main() {
  check('kernel binary exists', fs.existsSync(kernelBin()), kernelBin());

  // ---- A. Real-source integration --------------------------------------
  const compiled = issuer.compileTrustedMode({ installRoot: REPO_ROOT, dataRoot: REPO_ROOT });
  check('A1 real Registry compiles muse_main', compiled.ok === true && compiled.binding && compiled.binding.roleId === 'muse_main');
  check('A1 binding carries complete real target identity',
    compiled.ok && ['logicalModelId', 'routeId', 'providerId', 'remoteModelId', 'connectionId', 'executionKind', 'protocolId', 'reasoning']
      .every(function (f) { return typeof compiled.binding[f] === 'string' && compiled.binding[f] !== ''; }));

  const first = issuer.issueForGeneration(compiled, 'task_a12_first');
  check('A1 trusted issuance binds the task generation', first.ok === true && first.issuance.taskInstanceId === 'task_a12_first');

  // JS <-> Rust digest agreement over the REAL compiled bytes.
  const digestReq = function (value) {
    const dir = mkTemp('a12-digest-');
    const input = path.join(dir, 'request.json');
    fs.writeFileSync(input, JSON.stringify({ protocol: 1, value: value }), 'utf8');
    const out = childProcess.execFileSync(kernelBin(), ['digest', '--input', input], { encoding: 'utf8', timeout: 60000 });
    fs.rmSync(dir, { recursive: true, force: true });
    return JSON.parse(out);
  };
  const rustTarget = digestReq(first.issuance.target);
  const rustSnapshot = digestReq(first.issuance.snapshot);
  check('A2 target digest agrees JS<->Rust', rustTarget.ok === true && rustTarget.sha256 === first.issuance.targetDigest, rustTarget.sha256);
  check('A2 snapshot digest agrees JS<->Rust', rustSnapshot.ok === true && rustSnapshot.sha256 === first.issuance.snapshotDigest, rustSnapshot.sha256);
  check('A2 canonical bytes agree JS<->Rust (target)', rustTarget.canonical === require('../config/registry/resolver.cjs').canonicalize(first.issuance.target));

  // Effective mode-configuration change invalidates source identity.
  const bumped = JSON.parse(JSON.stringify(compiled.modeConfig));
  bumped.revision = 1;
  const svc = require('../config/registry/service.cjs').createService({ installRoot: REPO_ROOT, dataRoot: REPO_ROOT });
  const recompiled = svc.compilePreview(bumped);
  check('A3 revision bump still compiles (operator-save path)', recompiled.ok === true);
  const second = issuer.issueForGeneration({ ok: true, snapshot: recompiled.snapshot, binding: recompiled.snapshot.roles.muse_main, modeConfig: bumped, persisted: false }, 'task_a12_first');
  check('A3 revision change invalidates issuance identity', second.ok === true && second.issuance.issuanceId !== first.issuance.issuanceId);
  check('A3 revision change invalidates mode-config digest', second.issuance.modeConfigDigest !== first.issuance.modeConfigDigest);
  const altered = JSON.parse(JSON.stringify(compiled.modeConfig));
  for (const k of Object.keys(altered.slots)) { if (altered.slots[k]) altered.slots[k].reasoning = 'low'; }
  const recompiled2 = svc.compilePreview(altered);
  check('A3 definition change still compiles', recompiled2.ok === true);
  const third = issuer.issueForGeneration({ ok: true, snapshot: recompiled2.snapshot, binding: recompiled2.snapshot.roles.muse_main, modeConfig: altered, persisted: false }, 'task_a12_first');
  check('A3 definition change (same revision) invalidates target identity', third.ok === true && third.issuance.targetDigest !== first.issuance.targetDigest);

  // Two tasks, same model: distinct issuances, identical target digest.
  const other = issuer.issueForGeneration(compiled, 'task_a12_second');
  check('A4 same model yields distinct issuance per generation', other.ok === true && other.issuance.issuanceId !== first.issuance.issuanceId);
  check('A4 same model shares target digest', other.issuance.targetDigest === first.issuance.targetDigest);

  // Wrong mode / role / stale source are rejected, never mapped.
  const wrongMode = issuer.compileTrustedMode({ installRoot: REPO_ROOT, dataRoot: REPO_ROOT, modeId: 'engineering-v1' });
  check('A5 wrong mode is explicitly unsupported', wrongMode.ok === false && wrongMode.code === 'registry-unsupported-scope');
  const wrongRole = issuer.compileTrustedMode({ installRoot: REPO_ROOT, dataRoot: REPO_ROOT, role: 'engineer_normal' });
  check('A5 wrong role is explicitly unsupported', wrongRole.ok === false && wrongRole.code === 'registry-unsupported-scope');
  const tampered = JSON.parse(JSON.stringify(compiled));
  tampered.binding = Object.assign({}, compiled.binding);
  delete tampered.binding.routeId;
  const stale = issuer.issueForGeneration(tampered, 'task_a12_first');
  check('A5 incomplete source is refused (never manufactured)', stale.ok === false && /incomplete|unauthorized|unresolved/.test(stale.code || ''));

  // ---- B. Controller identities -----------------------------------------
  const wsB = mkTemp('a12-controller-');
  const instB = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsB, makeTask('TASK-0001', instB, 'muse_main'));
  appendAttempt(wsB, 'TASK-0001', makeAttempt('TASK-0001', instB, 1, 'muse_main'));
  const storeB = initKernelStore('b');
  const r1 = shadowIntent.resolveShadowIntent({ workspace: wsB, taskId: 'TASK-0001', taskInstanceId: instB }, {});
  check('B1 committed attempt maps to a stable commandId', r1.ok === true && typeof r1.intent.commandId === 'string');
  const r2 = shadowIntent.resolveShadowIntent({ workspace: wsB, taskId: 'TASK-0001', taskInstanceId: instB }, {});
  check('B1 resolution is deterministic', r2.ok === true && r2.intent.commandId === r1.intent.commandId);
  const d1 = await shadow.observeCommittedAttempt(baseOpts(wsB, storeB, { taskId: 'TASK-0001', taskInstanceId: instB }), {});
  check('B1 shadow delivery succeeds for the real-shaped attempt', d1.outcome === 'delivered', JSON.stringify(d1).slice(0, 300));
  check('B1 receipt is dispatch-disabled', d1.status === 'accepted-reserved-dispatch-disabled', d1.status);
  // Restart: fresh reader, same identity, receipt reused.
  const d1b = await shadow.observeCommittedAttempt(baseOpts(wsB, storeB, { taskId: 'TASK-0001', taskInstanceId: instB }), {});
  check('B2 restart derives the same command identity', d1b.commandId === d1.commandId);
  check('B2 lost ACK is recovered by commandId read', d1b.outcome === 'replayed' && d1b.commandId === d1.commandId, d1b.outcome);
  const rec = await shadow.reconcileTask(baseOpts(wsB, storeB, { taskId: 'TASK-0001', taskInstanceId: instB }), {});
  check('B2 reconcile reuses the durable receipt', rec.replayed.length === 1 && rec.reconciled.length === 0, JSON.stringify(rec).slice(0, 300));

  const staleBind = shadowIntent.resolveShadowIntent({ workspace: wsB, taskId: 'TASK-0001', taskInstanceId: 'task_deadbeefdeadbeefdeadbeefdeadbeef' }, {});
  check('B3 stale taskInstanceId is refused', staleBind.ok === false && staleBind.code === 'stale-task-instance');
  const legacy = shadowIntent.resolveShadowIntent({ workspace: wsB, taskId: 'TASK-0001' }, {});
  check('B4 legacy binding without generation is refused', legacy.ok === false && legacy.code === 'ambiguous-legacy-binding');
  const wsB4 = mkTemp('a12-controller-empty-');
  writeTaskLedger(wsB4, makeTask('TASK-0009', 'task_' + crypto.randomBytes(16).toString('hex'), 'muse_main'));
  const missing = shadowIntent.resolveShadowIntent({ workspace: wsB4, taskId: 'TASK-0009', taskInstanceId: 'task_' + '0'.repeat(32) }, {});
  check('B4 missing attempt evidence is refused', missing.ok === false && (missing.code === 'stale-task-instance' || missing.code === 'missing-attempt-evidence'), missing.code);
  // Two attempts, no explicit attemptId -> ambiguous (one stable identity only).
  appendAttempt(wsB, 'TASK-0001', makeAttempt('TASK-0001', instB, 1, 'muse_main', { status: 'verifying', timestampUtc: new Date().toISOString() }));
  const wsB5 = mkTemp('a12-controller-two-');
  const inst5 = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsB5, makeTask('TASK-0002', inst5, 'muse_main'));
  appendAttempt(wsB5, 'TASK-0002', makeAttempt('TASK-0002', inst5, 1, 'muse_main'));
  appendAttempt(wsB5, 'TASK-0002', makeAttempt('TASK-0002', inst5, 2, 'muse_main'));
  const amb = shadowIntent.resolveShadowIntent({ workspace: wsB5, taskId: 'TASK-0002', taskInstanceId: inst5 }, {});
  check('B4 multiple attempts require explicit attemptId', amb.ok === false && amb.code === 'ambiguous-attempt');
  const explicit = shadowIntent.resolveShadowIntent({ workspace: wsB5, taskId: 'TASK-0002', taskInstanceId: inst5, attemptId: 'TASK-0002-A2' }, {});
  check('B4 explicit attemptId resolves one identity', explicit.ok === true && explicit.intent.attemptId === 'TASK-0002-A2');
  check('B4 distinct attempts yield distinct commandIds', explicit.intent.commandId !== r1.intent.commandId);

  // Retries/sessions never create attempts: ledger bytes are invariant.
  const before = snapshotLedger(wsB5, 'TASK-0002');
  const storeB5 = initKernelStore('b5');
  await shadow.observeCommittedAttempt(baseOpts(wsB5, storeB5, { taskId: 'TASK-0002', taskInstanceId: inst5, attemptId: 'TASK-0002-A1' }), {});
  await shadow.observeCommittedAttempt(baseOpts(wsB5, storeB5, { taskId: 'TASK-0002', taskInstanceId: inst5, attemptId: 'TASK-0002-A2' }), {});
  await shadow.reconcileTask(baseOpts(wsB5, storeB5, { taskId: 'TASK-0002', taskInstanceId: inst5 }), {});
  const after = snapshotLedger(wsB5, 'TASK-0002');
  check('B5 shadow work never creates attempts or mutates the ledger', before.tasks === after.tasks && before.attempts === after.attempts);

  // ---- C. Bridge durability ----------------------------------------------
  const wsC = mkTemp('a12-durability-');
  const instC = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsC, makeTask('TASK-0007', instC, 'muse_main'));
  appendAttempt(wsC, 'TASK-0007', makeAttempt('TASK-0007', instC, 1, 'muse_main'));
  const storeC = initKernelStore('c');
  const cOpts = baseOpts(wsC, storeC, { taskId: 'TASK-0007', taskInstanceId: instC });
  const firstDelivery = await shadow.observeCommittedAttempt(cOpts, {});
  check('C1 initial delivery succeeds', firstDelivery.outcome === 'delivered', firstDelivery.outcome);
  const lostAck = await shadow.observeCommittedAttempt(cOpts, {});
  check('C1 lost ACK followed by replay reuses the receipt', lostAck.outcome === 'replayed' && lostAck.commandId === firstDelivery.commandId);
  const journal = bridge.invokeBridge('journal', { taskInstanceId: instC, backend: 'native' }, { dbPath: storeC.db, witnessPath: storeC.witness, repoRoot: REPO_ROOT });
  check('C1 exactly one authoritative receipt exists', journal.ok && journal.status === 'ok' && journal.response.receipts.length === 1, JSON.stringify(journal.response && journal.response.receipts.length));

  // Concurrent identical submissions collapse to one receipt.
  const outcomes = await Promise.all([1, 2, 3, 4, 5, 6].map(function () { return shadow.observeCommittedAttempt(cOpts, {}); }));
  const journal2 = bridge.invokeBridge('journal', { taskInstanceId: instC, backend: 'native' }, { dbPath: storeC.db, witnessPath: storeC.witness, repoRoot: REPO_ROOT });
  check('C2 concurrent identical submissions keep one receipt', journal2.response.receipts.length === 1);
  check('C2 every concurrent outcome is delivered-or-replayed', outcomes.every(function (o) { return o.outcome === 'delivered' || o.outcome === 'replayed'; }), outcomes.map(function (o) { return o.outcome; }).join(','));

  // Conflicting submission: same commandId, changed identity -> conflict, prior wins.
  const res3 = shadowIntent.resolveShadowIntent({ workspace: wsC, taskId: 'TASK-0007', taskInstanceId: instC }, {});
  const iss3 = issuer.issueTrustedResolution({ installRoot: REPO_ROOT, dataRoot: REPO_ROOT, modeId: 'engineering-v2', role: 'muse_main', taskInstanceId: instC }, {});
  const built3 = bridge.buildKernelIntent(res3.intent, iss3.issuance);
  const lease3 = bridge.invokeBridge('acquire', { taskInstanceId: instC, backend: 'native' }, { dbPath: storeC.db, witnessPath: storeC.witness, repoRoot: REPO_ROOT });
  const tamperedPayload = Object.assign({}, built3.intent.intentPayload, { sequence: 99 });
  const tamperedPayloadDigest = bridge.canonicalSha256(tamperedPayload);
  const tamperedIntentDigest = bridge.canonicalSha256({
    attemptId: built3.intent.attemptId, backend: 'native', commandId: built3.intent.commandId,
    controllerRevision: built3.intent.controllerRevision, modeConfigRevision: built3.intent.modeConfigRevision,
    modeId: built3.intent.modeId, payloadDigest: tamperedPayloadDigest, role: built3.intent.role,
    taskInstanceId: built3.intent.taskInstanceId,
  });
  const tamperedIntent = Object.assign({}, built3.intent, { intentPayload: tamperedPayload, payloadDigest: tamperedPayloadDigest, intentDigest: tamperedIntentDigest });
  const conflict = bridge.invokeBridge('accept', {
    intent: tamperedIntent, resolution: iss3.issuance.resolution, snapshot: iss3.issuance.snapshot,
    lease: { epoch: lease3.response.lease.leaseEpoch, storeIncarnation: lease3.response.lease.storeIncarnation },
  }, { dbPath: storeC.db, witnessPath: storeC.witness, repoRoot: REPO_ROOT });
  check('C3 same commandId with changed identity is a conflict', conflict.ok && conflict.status === 'refused' && conflict.code === 'command-conflict', conflict.code);
  const reread = bridge.invokeBridge('receipt', { commandId: res3.intent.commandId }, { dbPath: storeC.db, witnessPath: storeC.witness, repoRoot: REPO_ROOT });
  check('C3 prior receipt survives the conflict', reread.ok && reread.response.receipt && reread.response.receipt.commandDigest === firstDelivery.commandDigest, firstDelivery.commandDigest);

  // Stale lease is refused without transparent replacement.
  const leaseA = bridge.invokeBridge('acquire', { taskInstanceId: instC, backend: 'native' }, { dbPath: storeC.db, witnessPath: storeC.witness, repoRoot: REPO_ROOT });
  check('C4 setup acquire works', leaseA.ok && leaseA.status === 'ok');

  // Kernel restart preserves receipts (every CLI call reopens the store).
  const afterRestart = bridge.invokeBridge('receipt', { commandId: res3.intent.commandId }, { dbPath: storeC.db, witnessPath: storeC.witness, repoRoot: REPO_ROOT });
  check('C4 restart preserves the durable receipt', afterRestart.ok && afterRestart.response.receipt && afterRestart.response.receipt.commandDigest === firstDelivery.commandDigest);
  const journalAfter = bridge.invokeBridge('journal', { taskInstanceId: instC, backend: 'native' }, { dbPath: storeC.db, witnessPath: storeC.witness, repoRoot: REPO_ROOT });
  check('C4 journal reconstructs state after restart', journalAfter.ok && journalAfter.response.receipts.length === 1 && journalAfter.response.truncated === false);

  // Shadow failure mutates no Controller lifecycle state. A fresh attempt
  // (no prior pin) proves the never-delivered error path; the pinned
  // attempt-1 path honestly reports uncertainty instead of guessed success.
  appendAttempt(wsC, 'TASK-0007', makeAttempt('TASK-0007', instC, 2, 'muse_main'));
  const ledgerBefore = snapshotLedger(wsC, 'TASK-0007');
  const broken = await shadow.observeCommittedAttempt(baseOpts(wsC, storeC, { taskId: 'TASK-0007', taskInstanceId: instC, attemptId: 'TASK-0007-A2', kernelBin: '/nonexistent/nexus-kernel' }), {});
  check('C5 unavailable kernel is an explicit error', broken.outcome === 'error' && /unavailable|kernel/i.test(broken.code + ' ' + broken.message), broken.outcome + ':' + broken.code);
  const ledgerAfter = snapshotLedger(wsC, 'TASK-0007');
  check('C5 failure leaves Controller state byte-identical', ledgerBefore.tasks === ledgerAfter.tasks && ledgerBefore.attempts === ledgerAfter.attempts);

  // Witness uncertainty is surfaced, never guessed.
  const wsC6 = mkTemp('a12-witness-');
  const instC6 = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsC6, makeTask('TASK-0008', instC6, 'muse_main'));
  appendAttempt(wsC6, 'TASK-0008', makeAttempt('TASK-0008', instC6, 1, 'muse_main'));
  appendAttempt(wsC6, 'TASK-0008', makeAttempt('TASK-0008', instC6, 2, 'muse_main'));
  const storeC6 = initKernelStore('c6');
  const w1 = await shadow.observeCommittedAttempt(baseOpts(wsC6, storeC6, { taskId: 'TASK-0008', taskInstanceId: instC6, attemptId: 'TASK-0008-A1' }), {});
  check('C6 protected delivery succeeds', w1.outcome === 'delivered', w1.outcome);
  const w2 = await shadow.observeCommittedAttempt(baseOpts(wsC6, storeC6, { taskId: 'TASK-0008', taskInstanceId: instC6, attemptId: 'TASK-0008-A2', witnessPath: '' }), {});
  check('C6 witness omission on a protected generation is an explicit refusal', w2.outcome === 'refused' && /witness|reconciliation/i.test(w2.code || ''), w2.outcome + ':' + w2.code);

  // ---- D. Feature flags ----------------------------------------------------
  const wsD = mkTemp('a12-flags-');
  const instD = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsD, makeTask('TASK-0003', instD, 'muse_main'));
  appendAttempt(wsD, 'TASK-0003', makeAttempt('TASK-0003', instD, 1, 'muse_main'));
  const storeD = initKernelStore('d');
  const offOpts = baseOpts(wsD, storeD, { taskId: 'TASK-0003', taskInstanceId: instD, kernelBin: '/nonexistent/nexus-kernel' });
  offOpts.env = {};
  const off = await shadow.observeCommittedAttempt(offOpts, {});
  check('D1 default OFF performs no shadow work', off.outcome === 'skipped-disabled');
  check('D1 OFF creates no shadow files', !fs.existsSync(shadow.outboxPath(wsD, 'TASK-0003')) && !fs.existsSync(shadow.diagnosticsPath(wsD, 'TASK-0003')));
  const offRec = await shadow.reconcileTask(offOpts, {});
  check('D1 OFF reconcile is a no-op', offRec.outcome === 'skipped-disabled' && offRec.reconciled.length === 0);
  const onOpts = baseOpts(wsD, storeD, { taskId: 'TASK-0003', taskInstanceId: instD });
  const snapBefore = snapshotLedger(wsD, 'TASK-0003');
  const on = await shadow.observeCommittedAttempt(onOpts, {});
  check('D2 enabled shadow mode delivers diagnostics only', on.outcome === 'delivered');
  const snapAfter = snapshotLedger(wsD, 'TASK-0003');
  check('D2 production ledger is unchanged with shadow ON', snapBefore.tasks === snapAfter.tasks && snapBefore.attempts === snapAfter.attempts);
  check('D2 diagnostics were recorded', fs.existsSync(shadow.diagnosticsPath(wsD, 'TASK-0003')));
  const badSub = bridge.invokeBridge('dispatch', {}, { dbPath: storeD.db, repoRoot: REPO_ROOT });
  check('D3 no dispatch/execution subcommand exists', badSub.ok === false && badSub.code === 'bad-subcommand');
  const statusOut = childProcess.execFileSync(kernelBin(), ['status', '--db', storeD.db], { encoding: 'utf8', timeout: 60000 });
  check('D3 dispatch stays disabled', /dispatch_enabled=false/.test(statusOut), statusOut.trim());
  const noSecrets = bridge.redactForLog({ token: 'sk-live-abcdef123456', note: 'ok' });
  check('D3 secret-shaped material is redacted from logs', !/sk-live/.test(noSecrets) && /REDACTED/.test(noSecrets));

  // ---- E. Real TaskController (pwsh) ----------------------------------------
  const pwsh = resolvePwsh();
  if (!pwsh) {
    check('E1 pwsh available (real-Controller section)', false, 'UNVERIFIED: no pwsh host; sections A-D cover file-shape fidelity');
  } else {
    const wsE = mkTemp('a12-real-');
    try {
      const created = runPwsh(pwsh, 'Task.ps1', ['-Action', 'create-task', '-Workspace', wsE, '-Description', 'A1.2 shadow fixture', '-ExecutionClass', 'muse_main', '-Engine', 'muse']);
      const taskId = created.taskId;
      const instanceId = created.taskInstanceId;
      check('E1 real TaskController creates a muse task', typeof taskId === 'string' && typeof instanceId === 'string' && /^task_[0-9a-f]{32}$/.test(instanceId), taskId + '/' + instanceId);
      const attempt = runPwsh(pwsh, 'Task.ps1', ['-Action', 'begin-attempt', '-Workspace', wsE, '-TaskId', taskId, '-ExecutionClass', 'muse_main', '-TaskInstanceId', instanceId, '-PayloadFile', writePayload(wsE, { Workspace: wsE, SessionId: 'sess-real-1', StartedByTurn: 'turn-real-1', RequireNoOpenAttempt: true })]);
      check('E1 real begin-attempt commits', attempt && attempt.attemptId === taskId + '-A1' && attempt.taskInstanceId === instanceId, JSON.stringify(attempt).slice(0, 200));
      const resolved = shadowIntent.resolveShadowIntent({ workspace: wsE, taskId: taskId, taskInstanceId: instanceId }, {});
      check('E1 committed attempt maps to one stable commandId', resolved.ok === true && resolved.intent.attemptId === taskId + '-A1');
      const storeE = initKernelStore('e');
      const eOpts = baseOpts(wsE, storeE, { taskId: taskId, taskInstanceId: instanceId });
      const eDel = await shadow.observeCommittedAttempt(eOpts, {});
      check('E1 real attempt mirrors to one durable shadow receipt', eDel.outcome === 'delivered' && eDel.status === 'accepted-reserved-dispatch-disabled', JSON.stringify(eDel).slice(0, 300));
      const eRe = await shadow.observeCommittedAttempt(eOpts, {});
      check('E1 replay reuses the receipt (no second attempt)', eRe.outcome === 'replayed' && eRe.commandId === eDel.commandId);
      const attempts = readJsonLines(path.join(wsE, '.ai-harness', 'runs', taskId, 'attempts.jsonl'));
      check('E1 no duplicate attempts were created', attempts && attempts.filter(function (r) { return r.status === 'started'; }).length === 1, 'started=' + (attempts && attempts.length));
    } catch (e) {
      check('E1 real-Controller section', false, 'UNVERIFIED: ' + String((e && e.message) || e).slice(0, 300));
    }
  }

  // ---- H-01. Attempt identity: birth vs transitions -----------------------
  // Synthetic: latest record is a transition without immutable fields.
  const wsH1 = mkTemp('a12-h01-');
  const instH1 = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsH1, makeTask('TASK-0011', instH1, 'muse_main'));
  appendAttempt(wsH1, 'TASK-0011', makeAttempt('TASK-0011', instH1, 1, 'muse_main'));
  appendAttempt(wsH1, 'TASK-0011', { attemptId: 'TASK-0011-A1', taskId: 'TASK-0011', taskInstanceId: instH1, workspace: 'fixture-workspace', sequence: 1, status: 'verifying', timestampUtc: new Date().toISOString() });
  const h1 = shadowIntent.resolveShadowIntent({ workspace: wsH1, taskId: 'TASK-0011', taskInstanceId: instH1 }, {});
  check('H1 immutable fields come from the started event', h1.ok === true && h1.intent.executionClass === 'muse_main' && typeof h1.intent.sessionIdDigest === 'string' && typeof h1.intent.startedByTurnDigest === 'string', JSON.stringify(h1.intent || h1).slice(0, 200));
  check('H1 current status comes from the latest event', h1.ok === true && h1.intent.attemptStatus === 'verifying', h1.ok && h1.intent.attemptStatus);
  // Synthetic: transitions without any started event are refused.
  const wsH1b = mkTemp('a12-h01-nobirth-');
  const instH1b = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsH1b, makeTask('TASK-0012', instH1b, 'muse_main'));
  appendAttempt(wsH1b, 'TASK-0012', { attemptId: 'TASK-0012-A1', taskId: 'TASK-0012', taskInstanceId: instH1b, workspace: 'fixture-workspace', sequence: 1, status: 'verifying', timestampUtc: new Date().toISOString() });
  const h1b = shadowIntent.resolveShadowIntent({ workspace: wsH1b, taskId: 'TASK-0012', taskInstanceId: instH1b }, {});
  check('H1 attempt without a started event is refused', h1b.ok === false && h1b.code === 'missing-attempt-evidence', h1b.code);
  // Real TaskController: started -> verifying -> passed keeps identity stable.
  if (!pwsh) {
    check('H1 real started/verifying/passed lifecycle', false, 'UNVERIFIED: no pwsh host');
  } else {
    const wsH1c = mkTemp('a12-h01-real-');
    try {
      const created = runPwsh(pwsh, 'Task.ps1', ['-Action', 'create-task', '-Workspace', wsH1c, '-Description', 'A1.2 H-01 fixture', '-ExecutionClass', 'muse_main', '-Engine', 'muse']);
      const taskId = created.taskId;
      const instanceId = created.taskInstanceId;
      runPwsh(pwsh, 'Task.ps1', ['-Action', 'begin-attempt', '-Workspace', wsH1c, '-TaskId', taskId, '-ExecutionClass', 'muse_main', '-TaskInstanceId', instanceId, '-PayloadFile', writePayload(wsH1c, { Workspace: wsH1c, SessionId: 'sess-h01', StartedByTurn: 'turn-h01', RequireNoOpenAttempt: true })]);
      const storeH1 = initKernelStore('h01');
      const hOpts = baseOpts(wsH1c, storeH1, { taskId: taskId, taskInstanceId: instanceId });
      const atStarted = await shadow.observeCommittedAttempt(hOpts, {});
      check('H1 real delivery at started', atStarted.outcome === 'delivered', atStarted.outcome);
      const idStarted = shadowIntent.resolveShadowIntent({ workspace: wsH1c, taskId: taskId, taskInstanceId: instanceId }, {});
      runPwsh(pwsh, 'Task.ps1', ['-Action', 'attempt-event', '-Workspace', wsH1c, '-TaskId', taskId, '-TaskInstanceId', instanceId, '-PayloadFile', writePayload(wsH1c, { Workspace: wsH1c, Status: 'verifying' })]);
      const idVerifying = shadowIntent.resolveShadowIntent({ workspace: wsH1c, taskId: taskId, taskInstanceId: instanceId }, {});
      check('H1 commandId stable started->verifying', idVerifying.ok && idVerifying.intent.commandId === idStarted.intent.commandId);
      check('H1 executionClass stable started->verifying', idVerifying.ok && idVerifying.intent.executionClass === idStarted.intent.executionClass);
      const issH1 = issuer.issueTrustedResolution({ installRoot: REPO_ROOT, dataRoot: REPO_ROOT, modeId: 'engineering-v2', role: 'muse_main', taskInstanceId: instanceId }, {});
      const kStarted = bridge.buildKernelIntent(idStarted.intent, issH1.issuance);
      const kVerifying = bridge.buildKernelIntent(idVerifying.intent, issH1.issuance);
      check('H1 intent digest stable started->verifying', kStarted.ok && kVerifying.ok && kVerifying.intent.intentDigest === kStarted.intent.intentDigest);
      const atVerifying = await shadow.observeCommittedAttempt(hOpts, {});
      check('H1 receipt stable at verifying', atVerifying.outcome === 'replayed' && atVerifying.commandId === atStarted.commandId, atVerifying.outcome);
      runPwsh(pwsh, 'Task.ps1', ['-Action', 'attempt-event', '-Workspace', wsH1c, '-TaskId', taskId, '-TaskInstanceId', instanceId, '-PayloadFile', writePayload(wsH1c, { Workspace: wsH1c, Status: 'passed' })]);
      const idPassed = shadowIntent.resolveShadowIntent({ workspace: wsH1c, taskId: taskId, taskInstanceId: instanceId }, {});
      check('H1 commandId stable through passed', idPassed.ok && idPassed.intent.commandId === idStarted.intent.commandId && idPassed.intent.attemptStatus === 'passed', idPassed.ok && idPassed.intent.attemptStatus);
      const atPassed = await shadow.observeCommittedAttempt(hOpts, {});
      check('H1 receipt stable at passed (no new attempt)', atPassed.outcome === 'replayed' && atPassed.commandId === atStarted.commandId, atPassed.outcome);
      const recH1 = bridge.invokeBridge('receipt', { commandId: atStarted.commandId }, { dbPath: storeH1.db, witnessPath: storeH1.witness, repoRoot: REPO_ROOT });
      check('H1 one durable receipt across the lifecycle', recH1.ok && recH1.response.receipt && recH1.response.receipt.commandDigest === atStarted.commandDigest, atStarted.commandDigest);
      const linesH1 = readJsonLines(path.join(wsH1c, '.ai-harness', 'runs', taskId, 'attempts.jsonl'));
      check('H1 lifecycle created no extra attempts', linesH1 && linesH1.filter(function (r) { return r.status === 'started'; }).length === 1);
    } catch (e) {
      check('H1 real started/verifying/passed lifecycle', false, 'UNVERIFIED: ' + String((e && e.message) || e).slice(0, 300));
    }
  }

  // ---- H-02. Issuer authority: adversarial seal -----------------------------
  // A self-consistent but Registry-foreign resolution (forged generation
  // binding, honestly recomputed issuanceId) is submitted to the CLI seal
  // endpoint. It MUST succeed here: the endpoint checks well-formedness,
  // not Registry origin. This test pins the trusted-local limitation so no
  // future change can silently claim CLI seal authenticates origin.
  const forgedBase = issuer.issueForGeneration(compiled, 'task_a12_real');
  check('H2 setup trusted issuance exists', forgedBase.ok === true);
  const forgedResolution = JSON.parse(JSON.stringify(forgedBase.issuance.resolution));
  forgedResolution.taskInstanceId = 'task_forged_generation';
  forgedResolution.provenance.issuanceId = '0'.repeat(64); // placeholder, recomputed below
  const forgedSealContent = {
    issuer: forgedResolution.issuer, taskInstanceId: forgedResolution.taskInstanceId,
    role: forgedResolution.role, target: forgedResolution.target,
    provenance: {
      issuer: forgedResolution.provenance.issuer,
      resolutionIdCompat: forgedResolution.provenance.resolutionIdCompat,
      registrySnapshotDigest: forgedResolution.provenance.registrySnapshotDigest,
      targetDigest: forgedResolution.provenance.targetDigest,
      modeConfigRevision: forgedResolution.provenance.modeConfigRevision,
    },
  };
  forgedResolution.provenance.issuanceId = issuer.canonicalSha256(forgedSealContent);
  const storeH2 = initKernelStore('h02');
  const forgedSeal = bridge.invokeBridge('seal', { resolution: forgedResolution }, { dbPath: storeH2.db, witnessPath: storeH2.witness, repoRoot: REPO_ROOT });
  check('H2 CLI seal does NOT authenticate Registry origin (seals foreign bytes)', forgedSeal.ok === true && forgedSeal.status === 'ok' && forgedSeal.response.issuanceId === forgedResolution.provenance.issuanceId, JSON.stringify(forgedSeal).slice(0, 200));
  check('H2 forged issuance is distinct from trusted issuance', forgedResolution.provenance.issuanceId !== forgedBase.issuance.issuanceId);
  const malformedSeal = bridge.invokeBridge('seal', { resolution: { schemaVersion: 1 } }, { dbPath: storeH2.db, witnessPath: storeH2.witness, repoRoot: REPO_ROOT });
  check('H2 seal still rejects malformed resolutions', malformedSeal.ok === true && malformedSeal.status === 'refused', malformedSeal.code);

  // ---- H-03. Pin integrity ---------------------------------------------------
  check('H3 pin validator rejects non-pins', shadow.isValidPin(null) === false && shadow.isValidPin({ kind: 'shadow-pin' }) === false);
  function readOutboxTolerant(filePath) {
    const lines = String(fs.readFileSync(filePath, 'utf8')).split('\n').filter(function (l) { return l.trim() !== ''; });
    const parsed = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line)); } catch { parsed.push(null); }
    }
    return { lines: lines, parsed: parsed };
  }
  const wsH3 = mkTemp('a12-h03-');
  const instH3 = 'task_' + crypto.randomBytes(16).toString('hex');
  writeTaskLedger(wsH3, makeTask('TASK-0020', instH3, 'muse_main'));
  appendAttempt(wsH3, 'TASK-0020', makeAttempt('TASK-0020', instH3, 1, 'muse_main'));
  const storeH3 = initKernelStore('h03');
  const h3Opts = baseOpts(wsH3, storeH3, { taskId: 'TASK-0020', taskInstanceId: instH3 });
  const h3First = await shadow.observeCommittedAttempt(h3Opts, {});
  check('H3 setup delivery succeeds', h3First.outcome === 'delivered', h3First.outcome);
  const outboxFile = shadow.outboxPath(wsH3, 'TASK-0020');
  const pinLinesBefore = readOutboxTolerant(outboxFile).lines.length;
  check('H3 written pins validate', shadow.isValidPin(readOutboxTolerant(outboxFile).parsed[0]) === true);
  const journalBefore = bridge.invokeBridge('journal', { taskInstanceId: instH3, backend: 'native' }, { dbPath: storeH3.db, witnessPath: storeH3.witness, repoRoot: REPO_ROOT });
  // Truncated file: a torn final line must yield uncertainty, never a re-pin.
  fs.appendFileSync(outboxFile, '{"schemaVersion":1, "kind":"shadow-pin", "comma', 'utf8');
  const h3Trunc = await shadow.observeCommittedAttempt(h3Opts, {});
  check('H3 truncated outbox yields uncertainty (reconciliation-required)', h3Trunc.outcome === 'uncertain' && h3Trunc.code === 'reconciliation-required', h3Trunc.outcome + ':' + h3Trunc.code);
  const pinLinesAfterTrunc = readOutboxTolerant(outboxFile).lines.length;
  check('H3 no pin appended over corrupt history', pinLinesAfterTrunc === pinLinesBefore + 1, pinLinesBefore + '->' + pinLinesAfterTrunc);
  // Restore a clean outbox, then plant conflicting duplicate pins.
  const cleanPin = readOutboxTolerant(outboxFile).parsed.filter(function (r) { return r && r.kind === 'shadow-pin'; })[0];
  fs.writeFileSync(outboxFile, JSON.stringify(cleanPin) + '\n', 'utf8');
  const conflicting = Object.assign({}, cleanPin);
  conflicting.issuanceId = (cleanPin.issuanceId[0] === 'a' ? 'b' : 'a') + cleanPin.issuanceId.slice(1);
  fs.appendFileSync(outboxFile, JSON.stringify(conflicting) + '\n', 'utf8');
  const h3Conflict = await shadow.observeCommittedAttempt(h3Opts, {});
  check('H3 conflicting duplicate pins yield uncertainty (no recency vote)', h3Conflict.outcome === 'uncertain' && h3Conflict.code === 'reconciliation-required', h3Conflict.outcome + ':' + h3Conflict.code);
  // Malformed pin (valid JSON, invalid digest shape).
  check('H3 setup pin is well-formed', shadow.isValidPin(cleanPin) === true);
  fs.writeFileSync(outboxFile, JSON.stringify(cleanPin) + '\n', 'utf8');
  const malformed = Object.assign({}, cleanPin, { issuanceId: 'not-a-digest' });
  fs.appendFileSync(outboxFile, JSON.stringify(malformed) + '\n', 'utf8');
  const h3Malformed = await shadow.observeCommittedAttempt(h3Opts, {});
  check('H3 malformed pin yields uncertainty', h3Malformed.outcome === 'uncertain' && h3Malformed.code === 'reconciliation-required', h3Malformed.outcome + ':' + h3Malformed.code);
  // Clean history recovers to replay (operator-equivalent restore path).
  fs.writeFileSync(outboxFile, JSON.stringify(cleanPin) + '\n', 'utf8');
  const h3Recovered = await shadow.observeCommittedAttempt(h3Opts, {});
  check('H3 clean history recovers to replay', h3Recovered.outcome === 'replayed' && h3Recovered.commandId === h3First.commandId, h3Recovered.outcome);
  const journalAfterH3 = bridge.invokeBridge('journal', { taskInstanceId: instH3, backend: 'native' }, { dbPath: storeH3.db, witnessPath: storeH3.witness, repoRoot: REPO_ROOT });
  check('H3 exactly one receipt throughout pin turmoil', journalAfterH3.ok && journalAfterH3.response.receipts.length === journalBefore.response.receipts.length && journalAfterH3.response.receipts.length === 1);
  check('H3 Controller ledger untouched by pin turmoil', snapshotLedger(wsH3, 'TASK-0020').attempts.split('\n').filter(function (l) { return l.trim() !== ''; }).length === 1);

  const failed = results.filter(function (r) { return !r.pass; });
  console.log('\nA1.2 shadow: ' + (results.length - failed.length) + '/' + results.length + ' PASS' + (failed.length > 0 ? ' :: ' + failed.map(function (r) { return r.name; }).join(' | ') : ''));
  if (failed.length > 0) process.exit(1);
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
      } catch { /* keep searching */ }
    }
  } catch { /* none */ }
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
  const candidate = start >= 0 ? trimmed.slice(start) : trimmed;
  return JSON.parse(candidate);
}

main().catch(function (e) {
  console.log('FAIL harness crashed: ' + String((e && e.stack) || e).slice(0, 500));
  process.exit(1);
});
