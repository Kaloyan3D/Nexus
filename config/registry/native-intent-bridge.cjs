'use strict';
/**
 * A5.3 Controller bridge for user intents (one-shot, JSON in/out).
 *
 * Invoked ONLY by the issuer-identity intent broker with fixed arguments;
 * it is not a network service and takes no client-supplied paths. Every
 * subcommand prints exactly one JSON line. It reuses the existing authority
 * modules (Registry service/issuer, native-target-v2, shadow intent, dispatch
 * intent builder) and adds nothing of its own except Controller-ledger task
 * creation for intent tasks.
 *
 * Ledger honesty: the PowerShell TaskController is not part of the native
 * path. Intent tasks are therefore recorded in a DEDICATED intent ledger
 * (workspace/.ai-harness/state/tasks.json + runs/<task>/attempts.jsonl) in the
 * TaskController file shape, so native-shadow-intent reads them exactly as it
 * reads real Controller records. Real Controller ledgers are never touched.
 *
 * Subcommands:
 *   task-create <workspace>                       allocate task + attempt + session
 *   target-info <repoRoot> <dataRoot>             Registry-selected target (no side effects)
 *   issue <repoRoot> <dataRoot> <taskInstanceId> <sessionId>
 *   shadow <workspace> <taskId> <attemptId> <taskInstanceId>
 *   kernel-intent        (stdin {shadowIntent, issuance})
 *   publish              (stdin; scope and initiator are FIXED here)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..', '..');
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function failOut(code, message) {
  emit({ ok: false, code: code, message: message });
  process.exitCode = 1;
}

function readStdin(cb) {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (c) { text += c; });
  process.stdin.on('end', function () { cb(text); });
}

function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function cmdTaskCreate(args) {
  const workspace = args[0];
  if (!workspace || !path.isAbsolute(workspace)) return failOut('bad-args', 'absolute workspace required');
  const state = path.join(workspace, '.ai-harness', 'state');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const tasksFile = path.join(state, 'tasks.json');
  let doc = { schemaVersion: 1, nextSequence: 1, tasks: [] };
  if (fs.existsSync(tasksFile)) {
    try {
      doc = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    } catch (e) {
      return failOut('ledger-unreadable', 'intent ledger tasks.json is unreadable; refusing to overwrite');
    }
    if (!doc || doc.schemaVersion !== 1 || !Array.isArray(doc.tasks) || !Number.isInteger(doc.nextSequence)) {
      return failOut('ledger-unreadable', 'intent ledger tasks.json has an unexpected shape; refusing to overwrite');
    }
  }
  // This ledger is exclusively for native model-only intents. A ledger that
  // holds anything else (a real Controller ledger pointed at by mistake) is
  // never appended to or overwritten.
  if (doc.tasks.some(function (t) { return !t || t.kind !== 'model-only-intent'; })) {
    return failOut('ledger-foreign', 'tasks.json holds records that are not native model-only intents; refusing to write into it');
  }
  let seq = doc.nextSequence;
  // An orphan attempt directory (a crash between the two writes below)
  // is never reused: skip past it. A task record that already owns the id
  // means the ledger is inconsistent and is refused.
  let taskId = 'INTENT-' + String(seq).padStart(5, '0');
  for (let tries = 0; tries < 1000; tries++) {
    if (doc.tasks.some(function (t) { return t.taskId === taskId; })) {
      return failOut('ledger-collision', 'task id ' + taskId + ' already exists; refusing to overwrite it');
    }
    if (!fs.existsSync(path.join(workspace, '.ai-harness', 'runs', taskId))) break;
    seq += 1;
    taskId = 'INTENT-' + String(seq).padStart(5, '0');
  }
  const taskInstanceId = 'task-' + crypto.randomBytes(12).toString('hex');
  const attemptId = taskId + '-A1';
  const sessionId = 'session-' + crypto.randomBytes(12).toString('hex');
  const runs = path.join(workspace, '.ai-harness', 'runs', taskId);
  if (fs.existsSync(runs)) return failOut('ledger-collision', 'attempt directory for ' + taskId + ' appeared concurrently; refusing to reuse it');
  fs.mkdirSync(runs, { recursive: true, mode: 0o700 });
  // Attempt evidence first, task record second: a crash between the two
  // leaves an unreferenced attempt file, never a task without evidence.
  const attempt = { taskId: taskId, taskInstanceId: taskInstanceId, attemptId: attemptId, sequence: 1, status: 'started', executionClass: 'muse_main', sessionId: sessionId, startedByTurn: 'turn-1' };
  atomicWrite(path.join(runs, 'attempts.jsonl'), JSON.stringify(attempt) + '\n');
  doc.tasks.push({ taskId: taskId, taskInstanceId: taskInstanceId, attemptCount: 1, kind: 'model-only-intent' });
  doc.nextSequence = seq + 1;
  atomicWrite(tasksFile, JSON.stringify(doc));
  emit({ ok: true, taskId: taskId, taskInstanceId: taskInstanceId, attemptId: attemptId, sessionId: sessionId });
}

function loadService(repoRoot, dataRoot) {
  const serviceModule = require(path.join(REPO, 'config', 'registry', 'service.cjs'));
  return serviceModule.createService({ installRoot: repoRoot, dataRoot: dataRoot });
}

function issueFor(repoRoot, dataRoot, taskInstanceId, sessionId) {
  const v2 = require(path.join(REPO, 'config', 'registry', 'native-target-v2.cjs'));
  const service = loadService(repoRoot, dataRoot);
  return v2.issueExecutionTargetV2({ installRoot: repoRoot, dataRoot: dataRoot, taskInstanceId: taskInstanceId, sessionId: sessionId }, { service: service });
}

function cmdTargetInfo(args) {
  const out = issueFor(args[0], args[1], 'task-target-info', 'session-target-info');
  if (!out.ok) return failOut(out.code, out.message);
  const ep = out.target.extension.endpoint;
  emit({
    ok: true,
    providerId: out.target.core.providerId,
    remoteModelId: out.target.core.remoteModelId,
    logicalModelId: out.target.core.logicalModelId,
    endpointOrigin: ep.origin,
    endpointProtocol: ep.protocol,
    outputLimitTokens: out.target.extension.outputLimitTokens,
    contextLimitTokens: out.target.extension.contextLimitTokens,
    billingTier: out.target.extension.billing.tier,
  });
}

function cmdIssue(args) {
  const out = issueFor(args[0], args[1], args[2], args[3]);
  if (!out.ok) return failOut(out.code, out.message);
  emit({ ok: true, resolution: out.target.issuance.resolution, snapshot: out.target.issuance.snapshot, core: out.target.core, extension: out.target.extension, extensionDigest: out.target.extensionDigest, issuanceId: out.target.issuance.issuanceId, modeId: out.target.issuance.modeId, role: out.target.issuance.role, modeConfigRevision: out.target.issuance.modeConfigRevision, modeConfigDigest: out.target.issuance.modeConfigDigest });
}

function cmdShadow(args) {
  const shadowIntent = require(path.join(REPO, 'config', 'registry', 'native-shadow-intent.cjs'));
  const out = shadowIntent.resolveShadowIntent({ workspace: args[0], taskId: args[1], attemptId: args[2], taskInstanceId: args[3] });
  if (!out.ok) return failOut(out.code, out.message);
  emit({ ok: true, intent: out.intent });
}

function cmdKernelIntent(text) {
  const input = JSON.parse(text);
  const bridge = require(path.join(REPO, 'config', 'registry', 'native-shadow-bridge.cjs'));
  const out = bridge.buildKernelIntent(input.shadowIntent, input.issuance);
  if (!out.ok) return failOut(out.code, out.message);
  emit({ ok: true, intent: out.intent });
}

function cmdPublish(text) {
  const input = JSON.parse(text);
  const dispatchIntent = require(path.join(REPO, 'config', 'registry', 'native-dispatch-intent.cjs'));
  // The scope and initiator are not inputs: this bridge only ever produces
  // user-initiated model-only bundles.
  const opts = Object.assign({}, input, { scope: dispatchIntent.SCOPE_MODEL_ONLY, initiator: dispatchIntent.INITIATOR_USER_EXPLICIT });
  const out = dispatchIntent.buildDispatchIntent(opts);
  if (!out.ok) return failOut(out.code, out.message);
  emit({ ok: true, bundle: out.bundle });
}

function main() {
  const sub = process.argv[2];
  const args = process.argv.slice(3);
  for (const a of args) {
    if (typeof a !== 'string' || a.indexOf('\0') !== -1) return failOut('bad-args', 'invalid argument');
  }
  try {
    switch (sub) {
      case 'task-create': return cmdTaskCreate(args);
      case 'target-info': return cmdTargetInfo(args);
      case 'issue':
        if (!SAFE_ID.test(args[2] || '') || !SAFE_ID.test(args[3] || '')) return failOut('bad-args', 'invalid task/session id');
        return cmdIssue(args);
      case 'shadow': return cmdShadow(args);
      case 'kernel-intent': return readStdin(function (t) { try { cmdKernelIntent(t); } catch (e) { failOut('bridge-error', String((e && e.message) || e).slice(0, 200)); } });
      case 'publish': return readStdin(function (t) { try { cmdPublish(t); } catch (e) { failOut('bridge-error', String((e && e.message) || e).slice(0, 200)); } });
      default: return failOut('bad-subcommand', 'unknown bridge subcommand');
    }
  } catch (e) {
    return failOut('bridge-error', String((e && e.message) || e).slice(0, 200));
  }
}

main();
