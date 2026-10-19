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
 *   task-create <workspace> [repo-inspect|repo-code]        allocate task + attempt + session
 *   attempt-add <workspace> <taskId> <taskInstanceId>   next attempt of the same task (one per model turn)
 *   target-info <repoRoot> <dataRoot> [selectionJson]   Registry-selected target (no side effects)
 *   issue <repoRoot> <dataRoot> <taskInstanceId> <sessionId> [selectionJson]
 *   catalog <repoRoot> <dataRoot>   read-only Registry target catalog (no side effects)
 *   shadow <workspace> <taskId> <attemptId> <taskInstanceId>
 *   kernel-intent        (stdin {shadowIntent, issuance})
 *   publish              (stdin; scope and initiator are FIXED here)
 *   publish-inspect      (stdin; same, scope FIXED to repo-inspect)
 *   publish-code         (stdin; same, scope FIXED to repo-code)
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
  const KINDS = ['model-only-intent', 'repo-inspect-intent', 'repo-code-intent'];
  if (doc.tasks.some(function (t) { return !t || KINDS.indexOf(t.kind) === -1; })) {
    return failOut('ledger-foreign', 'tasks.json holds records that are not native intents; refusing to write into it');
  }
  const kind = args[1] === 'repo-inspect' ? 'repo-inspect-intent' : args[1] === 'repo-code' ? 'repo-code-intent' : 'model-only-intent';
  if (args[1] !== undefined && args[1] !== 'repo-inspect' && args[1] !== 'repo-code') return failOut('bad-args', 'unknown task kind');
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
  doc.tasks.push({ taskId: taskId, taskInstanceId: taskInstanceId, attemptCount: 1, kind: kind });
  doc.nextSequence = seq + 1;
  atomicWrite(tasksFile, JSON.stringify(doc));
  emit({ ok: true, taskId: taskId, taskInstanceId: taskInstanceId, attemptId: attemptId, sessionId: sessionId });
}

// A5.5: each model turn of a repo-inspect run is its own Controller attempt
// of the SAME task, so every provider request has its own command identity,
// request digest and single-use sealed grant. Append-only: attempts are never
// rewritten, and the next sequence is derived from the committed ledger.
// Was 96 (A5.5, when a run had 12 turns). A long self-development task reached it at turn 92 plus
// four recoveries and failed with nothing to show for it; runs may now take up to 2000 turns.
const MAX_ATTEMPTS = 5000;

function cmdAttemptAdd(args) {
  const workspace = args[0];
  const taskId = args[1];
  const taskInstanceId = args[2];
  if (!workspace || !path.isAbsolute(workspace)) return failOut('bad-args', 'absolute workspace required');
  if (!SAFE_ID.test(taskId || '') || !SAFE_ID.test(taskInstanceId || '')) return failOut('bad-args', 'invalid task id');
  const state = path.join(workspace, '.ai-harness', 'state');
  const tasksFile = path.join(state, 'tasks.json');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); } catch (e) { return failOut('ledger-unreadable', 'intent ledger tasks.json is unreadable'); }
  const task = (doc.tasks || []).find(function (t) { return t && t.taskId === taskId; });
  if (!task || task.taskInstanceId !== taskInstanceId || (task.kind !== 'repo-inspect-intent' && task.kind !== 'repo-code-intent')) return failOut('unknown-task', 'no repo-inspect task with this identity');
  const runs = path.join(workspace, '.ai-harness', 'runs', taskId);
  const file = path.join(runs, 'attempts.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(function (l) { return l.trim() !== ''; }).map(function (l) { return JSON.parse(l); });
  const first = lines.find(function (r) { return r.status === 'started'; });
  if (!first) return failOut('ledger-unreadable', 'task has no started attempt');
  const seq = lines.filter(function (r) { return r.status === 'started'; }).length + 1;
  // One attempt per provider request (model turns AND re-asked recoveries). The bound only has to
  // stop a runaway ledger; the run's own turn/time limits end a task long before it.
  if (seq > MAX_ATTEMPTS) return failOut('too-many-attempts', 'attempt limit reached (' + MAX_ATTEMPTS + ' provider requests in one task)');
  const attemptId = taskId + '-A' + seq;
  const attempt = { taskId: taskId, taskInstanceId: taskInstanceId, attemptId: attemptId, sequence: seq, status: 'started', executionClass: first.executionClass, sessionId: first.sessionId, startedByTurn: 'turn-' + seq };
  atomicWrite(file, lines.map(function (r) { return JSON.stringify(r); }).concat([JSON.stringify(attempt)]).join('\n') + '\n');
  task.attemptCount = seq;
  atomicWrite(tasksFile, JSON.stringify(doc));
  emit({ ok: true, attemptId: attemptId, sequence: seq });
}

function loadService(repoRoot, dataRoot) {
  const serviceModule = require(path.join(REPO, 'config', 'registry', 'service.cjs'));
  return serviceModule.createService({ installRoot: repoRoot, dataRoot: dataRoot });
}

function parseSelectionJson(text) {
  if (text === undefined || text === null || text === '') return { ok: true, selection: null };
  let sel = null;
  try {
    sel = JSON.parse(String(text));
  } catch (e) {
    return { ok: false, selection: null };
  }
  if (sel === null || typeof sel !== 'object' || Array.isArray(sel)) return { ok: false, selection: null };
  const keys = Object.keys(sel);
  if (keys.length !== 2 || keys.indexOf('logicalModelId') === -1 || keys.indexOf('routeId') === -1) return { ok: false, selection: null };
  if (typeof sel.logicalModelId !== 'string' || typeof sel.routeId !== 'string') return { ok: false, selection: null };
  return { ok: true, selection: { logicalModelId: sel.logicalModelId, routeId: sel.routeId } };
}

function issueFor(repoRoot, dataRoot, taskInstanceId, sessionId, selection) {
  const v2 = require(path.join(REPO, 'config', 'registry', 'native-target-v2.cjs'));
  const service = loadService(repoRoot, dataRoot);
  return v2.issueExecutionTargetV2({ installRoot: repoRoot, dataRoot: dataRoot, taskInstanceId: taskInstanceId, sessionId: sessionId, selection: selection === undefined ? null : selection }, { service: service });
}

function cmdCatalog(args) {
  const service = loadService(args[0], args[1]);
  const catalog = require(path.join(REPO, 'config', 'registry', 'native-registry-catalog.cjs'));
  const out = catalog.listRegistryTargets(service);
  if (!out.ok) return failOut(out.code, out.message);
  emit({ ok: true, targets: out.targets });
}

function cmdTargetInfo(args) {
  const parsed = parseSelectionJson(args[2]);
  if (!parsed.ok) return failOut('bad-args', 'invalid selection');
  const out = issueFor(args[0], args[1], 'task-target-info', 'session-target-info', parsed.selection);
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
  const parsed = parseSelectionJson(args[4]);
  if (!parsed.ok) return failOut('bad-args', 'invalid selection');
  const out = issueFor(args[0], args[1], args[2], args[3], parsed.selection);
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
  const extras = input.workspaceRootDigest === undefined ? undefined : { workspaceRootDigest: input.workspaceRootDigest };
  const out = bridge.buildKernelIntent(input.shadowIntent, input.issuance, extras);
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

function cmdPublishInspect(text) {
  const input = JSON.parse(text);
  const dispatchIntent = require(path.join(REPO, 'config', 'registry', 'native-dispatch-intent.cjs'));
  const opts = Object.assign({}, input, { scope: dispatchIntent.SCOPE_REPO_INSPECT, initiator: dispatchIntent.INITIATOR_USER_EXPLICIT });
  const out = dispatchIntent.buildDispatchIntent(opts);
  if (!out.ok) return failOut(out.code, out.message);
  emit({ ok: true, bundle: out.bundle });
}

function cmdPublishCode(text) {
  const input = JSON.parse(text);
  const dispatchIntent = require(path.join(REPO, 'config', 'registry', 'native-dispatch-intent.cjs'));
  const opts = Object.assign({}, input, { scope: dispatchIntent.SCOPE_REPO_CODE, initiator: dispatchIntent.INITIATOR_USER_EXPLICIT });
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
      case 'attempt-add': return cmdAttemptAdd(args);
      case 'catalog': return cmdCatalog(args);
      case 'target-info': return cmdTargetInfo(args);
      case 'issue':
        if (!SAFE_ID.test(args[2] || '') || !SAFE_ID.test(args[3] || '')) return failOut('bad-args', 'invalid task/session id');
        return cmdIssue(args);
      case 'shadow': return cmdShadow(args);
      case 'kernel-intent': return readStdin(function (t) { try { cmdKernelIntent(t); } catch (e) { failOut('bridge-error', String((e && e.message) || e).slice(0, 200)); } });
      case 'publish': return readStdin(function (t) { try { cmdPublish(t); } catch (e) { failOut('bridge-error', String((e && e.message) || e).slice(0, 200)); } });
      case 'publish-code': return readStdin(function (t) { try { cmdPublishCode(t); } catch (e) { failOut('bridge-error', String((e && e.message) || e).slice(0, 200)); } });
      case 'publish-inspect': return readStdin(function (t) { try { cmdPublishInspect(t); } catch (e) { failOut('bridge-error', String((e && e.message) || e).slice(0, 200)); } });
      default: return failOut('bad-subcommand', 'unknown bridge subcommand');
    }
  } catch (e) {
    return failOut('bridge-error', String((e && e.message) || e).slice(0, 200));
  }
}

main();
