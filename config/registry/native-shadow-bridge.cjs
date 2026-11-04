'use strict';

/**
 * A1.2 JS -> Rust bridge transport: local CLI subprocess adapter.
 *
 * A local CLI subprocess is acceptable for A1.2. This is NOT a
 * production-grade IPC channel and MUST NOT be mistaken for one: there is
 * no daemon, no listener, no authentication — the OS process boundary is
 * the trust mechanism, and the prototype operates in an isolated trusted
 * test boundary (see native/A1.2-EVIDENCE.md).
 *
 * Guarantees at this layer:
 * - Bounded JSON request/response sizes (1 MiB request cap enforced by
 *   Rust; responses additionally capped here at 4 MiB).
 * - Strict response schema validation: { protocol: 1, ok: boolean, ... }.
 * - Explicit error codes (kebab-case, shared with the Rust vocabulary).
 * - No shell interpolation: execFile with an argv array only.
 * - Deterministic command identity: request bytes are derived from the
 *   Controller attempt + sealed issuance, never random per call.
 * - Restart-safe idempotent handling: identical envelopes replay the
 *   original receipt; conflicts preserve prior authority.
 * - No raw API keys or secrets in logs: only ids, digests and codes are
 *   ever logged; secret-shaped values are redacted before logging.
 * - No arbitrary executable path in payloads: the request vocabulary has
 *   no such field; the binary path resolves from explicit configuration
 *   (NEXUS_KERNEL_BIN) or the in-tree debug build only.
 * - No model execution or tool invocation capability exists on this path.
 */

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const resolver = require('./resolver.cjs');

const BRIDGE_PROTOCOL_VERSION = 1;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const KERNEL_BACKEND = 'native';

function canonicalSha256(value) {
  return crypto.createHash('sha256').update(resolver.canonicalize(value), 'utf8').digest('hex');
}

function defaultKernelBin(repoRoot) {
  const root = repoRoot || process.cwd();
  return path.join(String(root), 'native', 'target', 'debug', 'nexus-kernel');
}

function resolveKernelBin(options) {
  const o = options || {};
  if (typeof o.kernelBin === 'string' && o.kernelBin !== '') return o.kernelBin;
  if (typeof process.env.NEXUS_KERNEL_BIN === 'string' && process.env.NEXUS_KERNEL_BIN !== '') {
    return process.env.NEXUS_KERNEL_BIN;
  }
  return defaultKernelBin(o.repoRoot);
}

function redactForLog(value) {
  // Never log secret-shaped material even if a future field carried it.
  try {
    const text = JSON.stringify(value);
    return String(text).replace(/(sk-(live|proj)-[A-Za-z0-9._-]+|xox[bap]-[A-Za-z0-9-]+|ghp_[A-Za-z0-9]+|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g, '[REDACTED]');
  } catch {
    return '[unloggable]';
  }
}

/**
 * Build the kernel ControllerIntentV1 wire object for one shadow command.
 * Digest computation MUST match Rust ControllerIntentV1::build byte-for-byte:
 *   payloadDigest = sha256(canonical(intentPayload))
 *   intentDigest  = sha256(canonical({ attemptId, backend, commandId,
 *     controllerRevision, modeConfigRevision, modeId, payloadDigest, role,
 *     taskInstanceId }))
 * The payload carries references/digests only — no prompt text, no
 * credentials, no raw user content — and only IMMUTABLE attempt fields, so
 * the identity is stable across retry/restart.
 */
function buildKernelIntent(shadowIntent, issuance, extras) {
  if (!shadowIntent || typeof shadowIntent !== 'object') return { ok: false, code: 'shadow-intent-invalid', message: 'shadow intent is required', intent: null };
  if (!issuance || typeof issuance !== 'object') return { ok: false, code: 'registry-issuance-missing', message: 'trusted issuance is required', intent: null };
  for (const field of ['taskInstanceId', 'attemptId', 'commandId']) {
    if (typeof shadowIntent[field] !== 'string' || shadowIntent[field] === '') {
      return { ok: false, code: 'shadow-intent-invalid', message: 'shadow intent lacks ' + field, intent: null };
    }
  }
  if (!Number.isInteger(shadowIntent.controllerRevision) || shadowIntent.controllerRevision <= 0) {
    return { ok: false, code: 'shadow-intent-invalid', message: 'shadow intent lacks a valid Controller revision', intent: null };
  }
  const payload = {
    taskId: shadowIntent.taskId,
    sequence: shadowIntent.sequence,
    executionClass: shadowIntent.executionClass,
    sessionIdDigest: shadowIntent.sessionIdDigest,
    startedByTurnDigest: shadowIntent.startedByTurnDigest,
    modeConfigDigest: issuance.modeConfigDigest,
  };
  // A5.5: a repo-inspect command commits to its workspace in the
  // Controller-authored intent payload. The Kernel refuses to bind any
  // other root to this command (bind_workspace). Absent for every other
  // intent, so pre-existing payload digests are unchanged.
  if (extras && extras.workspaceRootDigest !== undefined) {
    if (typeof extras.workspaceRootDigest !== 'string' || !/^[0-9a-f]{64}$/.test(extras.workspaceRootDigest)) {
      return { ok: false, code: 'shadow-intent-invalid', message: 'workspaceRootDigest must be 64 lowercase hex', intent: null };
    }
    payload.workspaceRootDigest = extras.workspaceRootDigest;
  }
  const payloadDigest = canonicalSha256(payload);
  const modeConfigRevision = issuance.modeConfigRevision;
  const digestInput = {
    attemptId: shadowIntent.attemptId,
    backend: KERNEL_BACKEND,
    commandId: shadowIntent.commandId,
    controllerRevision: shadowIntent.controllerRevision,
    modeConfigRevision: modeConfigRevision,
    modeId: issuance.modeId,
    payloadDigest: payloadDigest,
    role: issuance.role,
    taskInstanceId: shadowIntent.taskInstanceId,
  };
  const intentDigest = canonicalSha256(digestInput);
  return {
    ok: true,
    code: null,
    message: null,
    intent: {
      schemaVersion: 1,
      taskInstanceId: shadowIntent.taskInstanceId,
      attemptId: shadowIntent.attemptId,
      commandId: shadowIntent.commandId,
      backend: KERNEL_BACKEND,
      controllerRevision: shadowIntent.controllerRevision,
      role: issuance.role,
      modeId: issuance.modeId,
      modeConfigRevision: modeConfigRevision,
      intentPayload: payload,
      payloadDigest: payloadDigest,
      intentDigest: intentDigest,
      lease: null,
    },
  };
}

/**
 * Invoke one versioned bridge subcommand. Synchronous (execFileSync) so
 * callers stay deterministic in tests; the kernel does the durable work.
 * Returns { ok, status, response?, code?, message? } — transport failures
 * are explicit and NEVER reported as kernel success.
 */
function invokeBridge(subcommand, request, options) {
  const o = options || {};
  const kernelBin = resolveKernelBin(o);
  const dbPath = typeof o.dbPath === 'string' && o.dbPath !== '' ? o.dbPath : null;
  const witnessPath = typeof o.witnessPath === 'string' && o.witnessPath !== '' ? o.witnessPath : null;
  const timeoutMs = Number.isInteger(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  const allowed = { acquire: true, seal: true, accept: true, receipt: true, journal: true, digest: true };
  if (!allowed[subcommand]) return { ok: false, status: 'transport-error', code: 'bad-subcommand', message: 'unknown bridge subcommand' };
  if (subcommand !== 'digest' && !dbPath) return { ok: false, status: 'transport-error', code: 'bridge-misconfigured', message: 'dbPath is required' };
  let envelope;
  try {
    envelope = Object.assign({ protocol: BRIDGE_PROTOCOL_VERSION }, request);
    const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    if (bytes > 1024 * 1024) return { ok: false, status: 'transport-error', code: 'too-large', message: 'bridge request exceeds 1 MiB' };
  } catch (e) {
    return { ok: false, status: 'transport-error', code: 'bad-request', message: 'request is not JSON-representable' };
  }
  let workDir = null;
  try {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-shadow-bridge-'));
    const inputPath = path.join(workDir, 'request.json');
    fs.writeFileSync(inputPath, JSON.stringify(envelope), 'utf8');
    // argv array only — no shell, no interpolation, no executable path from
    // the payload (the binary path is operator configuration, not data).
    const argv = [subcommand];
    if (subcommand !== 'digest') { argv.push('--db', dbPath); if (witnessPath) { argv.push('--witness', witnessPath); } }
    argv.push('--input', inputPath);
    let stdout;
    try {
      stdout = childProcess.execFileSync(kernelBin, argv, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_RESPONSE_BYTES, windowsHide: true });
    } catch (e) {
      const stderr = e && e.stderr ? String(e.stderr).slice(0, 500) : '';
      return { ok: false, status: 'transport-error', code: 'kernel-unavailable', message: 'kernel subprocess failed: ' + (stderr || String((e && e.message) || e)).slice(0, 300) };
    }
    if (Buffer.byteLength(stdout, 'utf8') > MAX_RESPONSE_BYTES) {
      return { ok: false, status: 'transport-error', code: 'too-large', message: 'bridge response exceeds cap' };
    }
    let response;
    try {
      response = JSON.parse(stdout);
    } catch {
      return { ok: false, status: 'transport-error', code: 'bad-response', message: 'kernel returned non-JSON' };
    }
    if (!response || typeof response !== 'object' || response.protocol !== BRIDGE_PROTOCOL_VERSION || typeof response.ok !== 'boolean') {
      return { ok: false, status: 'transport-error', code: 'bad-response', message: 'kernel response violates the versioned envelope' };
    }
    if (response.ok !== true) {
      return { ok: true, status: 'refused', response: response, code: response.code || 'unknown', message: response.message || 'refused' };
    }
    return { ok: true, status: 'ok', response: response };
  } catch (e) {
    return { ok: false, status: 'transport-error', code: 'bridge-error', message: String((e && e.message) || e).slice(0, 300) };
  } finally {
    if (workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

// In-process per-command serialization: concurrent identical shadow
// submissions in one process share ONE delivery so they replay one receipt
// instead of racing generations. Cross-process races still resolve to one
// authoritative receipt via kernel command-conflict (never overwritten).
const commandLocks = new Map();

function withCommandLock(commandId, work) {
  const prior = commandLocks.get(commandId) || Promise.resolve();
  let releaseTail;
  const tail = new Promise(function (resolve) { releaseTail = resolve; });
  const run = prior.catch(function () {}).then(work);
  commandLocks.set(commandId, tail);
  function settle() {
    if (commandLocks.get(commandId) === tail) commandLocks.delete(commandId);
    releaseTail();
  }
  return run.then(function (value) { settle(); return value; }, function (err) { settle(); throw err; });
}

module.exports = {
  BRIDGE_PROTOCOL_VERSION: BRIDGE_PROTOCOL_VERSION,
  KERNEL_BACKEND: KERNEL_BACKEND,
  canonicalSha256: canonicalSha256,
  resolveKernelBin: resolveKernelBin,
  redactForLog: redactForLog,
  buildKernelIntent: buildKernelIntent,
  invokeBridge: invokeBridge,
  withCommandLock: withCommandLock,
};
