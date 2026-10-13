'use strict';
/**
 * ContextActiveApplyLockClientV2.cjs - CCV2-A10H Node client for the frozen
 * cross-process compaction apply lock.
 *
 * This module invents NO lock protocol. The single cross-process mutation
 * serialization authority is the existing PowerShell implementation in
 * scripts/ContextLifecycle.ps1:
 *
 *   Get-AihCompactionApplyLockPath  - lock file scope (ledger runs/<TaskId>)
 *   Invoke-AihCompactionApplyLockAcquire - atomic O_EXCL create + lease
 *   Invoke-AihCompactionApplyLockRenew   - owner-token-guarded renewal
 *   Invoke-AihCompactionApplyLockRelease - owner-checked release
 *
 * exposed to other processes through scripts/ContextLifecycleCli.ps1
 * (acquire-apply-lock / renew-apply-lock / release-apply-lock). This client
 * only invokes those exact CLI actions from Node and parses their JSON
 * results, following the established precedent of
 * tests/ContextCompactionXProc.Worker.cjs. Lock path, file format, lease
 * semantics, owner fencing, and takeover rules all live in PowerShell;
 * nothing here redefines, mirrors, or caches them.
 *
 * The client is the production serialization seam for
 * config/ContextActiveApplyV2.cjs, which treats it as MANDATORY: no client
 * (or a client that cannot acquire) means REFUSE, never silent proceed.
 *
 * Determinism: no clock, no randomness here (owner ids are minted by the
 * CLI authority). Spawning the CLI is process I/O, never model or network
 * I/O. Secrets never flow through lock payloads (ids only).
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOCK_CLI_RELATIVE = path.join('scripts', 'ContextLifecycleCli.ps1');
const DEFAULT_TIMEOUT_MS = 120000;

function failLock(message) {
  throw new Error('ccv2-active-apply-lock-v2: ' + message);
}

function resolveInstallRoot(hint) {
  if (typeof hint === 'string' && hint !== '') return hint;
  return path.resolve(__dirname, '..');
}

function invokeCli(pwshPath, cliPath, action, taskId, payload, timeoutMs) {
  if (typeof taskId !== 'string' || taskId === '') failLock('taskId is required');
  if (!payload || typeof payload !== 'object') failLock('payload is required');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccv2-a10h-lock-'));
  const payloadFile = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  try {
    const out = execFileSync(
      pwshPath,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', cliPath, '-Action', action, '-TaskId', taskId, '-PayloadFile', payloadFile],
      { encoding: 'utf8', timeout: timeoutMs }
    );
    const text = String(out || '').trim();
    if (text === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      failLock('CLI returned non-JSON output (' + action + ')');
    }
  } finally {
    try { fs.unlinkSync(payloadFile); } catch { /* best effort */ }
    try { fs.rmdirSync(dir); } catch { /* best effort */ }
  }
  return null;
}

function normalizeLeaseSeconds(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1 && n <= 600) return Math.trunc(n);
  return 60;
}

// createCliApplyLockClient({ installRoot, workspace, pwshPath, timeoutMs,
// leaseSeconds }) -> { acquire, renew, release }.
//
// workspace is the LEDGER workspace that owns .ai-harness/runs/<TaskId>/
// (the lock-file scope). It is intentionally separate from the A02
// operation workspace binding: the client owns ledger paths, A10 owns the
// operation binding. leaseSeconds is the default when a call omits it.
function createCliApplyLockClient(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const installRoot = resolveInstallRoot(opts.installRoot);
  const cliPath = typeof opts.cliPath === 'string' && opts.cliPath !== ''
    ? opts.cliPath
    : path.join(installRoot, LOCK_CLI_RELATIVE);
  const pwshPath = typeof opts.pwshPath === 'string' && opts.pwshPath !== '' ? opts.pwshPath : 'pwsh';
  const workspace = typeof opts.workspace === 'string' && opts.workspace !== '' ? opts.workspace : null;
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0
    ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const defaultLease = normalizeLeaseSeconds(opts.leaseSeconds);
  if (!fs.existsSync(cliPath)) failLock('lock CLI is absent (' + cliPath + ')');

  const leaseOf = (call) => normalizeLeaseSeconds(
    call && call.leaseSeconds !== undefined && call.leaseSeconds !== null ? call.leaseSeconds : defaultLease);

  async function acquire(call) {
    if (!call || typeof call !== 'object') failLock('acquire call is required');
    const ws = typeof call.workspace === 'string' && call.workspace !== '' ? call.workspace : workspace;
    if (typeof ws !== 'string' || ws === '') failLock('ledger workspace is required');
    for (const k of ['taskId', 'taskInstanceId', 'sessionId', 'operationId']) {
      if (typeof call[k] !== 'string' || call[k] === '') failLock(k + ' is required');
    }
    const res = invokeCli(pwshPath, cliPath, 'acquire-apply-lock', call.taskId, {
      workspace: ws,
      taskInstanceId: call.taskInstanceId,
      sessionId: call.sessionId,
      operationLockId: call.operationId,
      lockLeaseSeconds: leaseOf(call),
    }, timeoutMs);
    if (!res || typeof res !== 'object') failLock('acquire returned no result');
    return {
      acquired: res.acquired === true,
      ownerId: typeof res.ownerId === 'string' ? res.ownerId : null,
      leaseSeconds: Number.isFinite(Number(res.leaseSeconds)) ? Number(res.leaseSeconds) : leaseOf(call),
      reason: typeof res.reason === 'string' ? res.reason : null,
    };
  }

  async function renew(call) {
    if (!call || typeof call !== 'object') failLock('renew call is required');
    const ws = typeof call.workspace === 'string' && call.workspace !== '' ? call.workspace : workspace;
    if (typeof ws !== 'string' || ws === '') failLock('ledger workspace is required');
    for (const k of ['taskId', 'taskInstanceId', 'sessionId', 'operationId', 'ownerId']) {
      if (typeof call[k] !== 'string' || call[k] === '') failLock(k + ' is required');
    }
    const res = invokeCli(pwshPath, cliPath, 'renew-apply-lock', call.taskId, {
      workspace: ws,
      taskInstanceId: call.taskInstanceId,
      sessionId: call.sessionId,
      operationLockId: call.operationId,
      lockOwnerId: call.ownerId,
      lockLeaseSeconds: leaseOf(call),
    }, timeoutMs);
    if (!res || typeof res !== 'object') failLock('renew returned no result');
    return {
      renewed: res.renewed === true,
      expiresAtUtc: typeof res.expiresAtUtc === 'string' ? res.expiresAtUtc : null,
      reason: typeof res.reason === 'string' ? res.reason : null,
    };
  }

  async function release(call) {
    if (!call || typeof call !== 'object') failLock('release call is required');
    const ws = typeof call.workspace === 'string' && call.workspace !== '' ? call.workspace : workspace;
    if (typeof ws !== 'string' || ws === '') failLock('ledger workspace is required');
    if (typeof call.taskId !== 'string' || call.taskId === '') failLock('taskId is required');
    if (typeof call.ownerId !== 'string' || call.ownerId === '') failLock('ownerId is required');
    const res = invokeCli(pwshPath, cliPath, 'release-apply-lock', call.taskId, {
      workspace: ws,
      lockOwnerId: call.ownerId,
    }, timeoutMs);
    if (!res || typeof res !== 'object') return { released: false, reason: 'release-no-result' };
    return {
      released: res.released === true,
      reason: typeof res.reason === 'string' ? res.reason : null,
    };
  }

  return Object.freeze({ acquire, renew, release });
}

module.exports = {
  LOCK_CLI_RELATIVE,
  createCliApplyLockClient,
  normalizeLeaseSeconds,
};
