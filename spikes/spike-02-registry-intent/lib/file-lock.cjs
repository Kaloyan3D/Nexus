'use strict';
// SPIKE-02 throwaway prototype — NOT production code.
// Minimal cross-process file primitives (F-03).
//
// - exclusivePublishJson: tmp-write + fsync + link(2) winner-takes-all.
//   Concurrent publishers of the same path: exactly one wins; losers get
//   EEXIST and MUST re-read and compare (idempotent vs conflict) instead of
//   overwriting. Readers never observe torn files. This is the atomicity
//   mechanism.
// - withLock: mkdir-based mutex (mkdir is atomic on POSIX) serializing
//   read-modify-write sequences (attachLease, acquireGeneration, delivery)
//   across processes. Poll 5ms, default deadline 15s, throws 'lock-timeout'.
//   PROTOTYPE LIMIT: no stale-lock recovery and no fcntl; a killed holder
//   can wedge the lock until the directory is cleaned. Production A1 must
//   use fcntl/transactional storage, not this.
const fs = require('node:fs');
const path = require('node:path');

function locksDir(root) {
  return path.join(root, '.locks');
}

function withLock(root, name, fn, options) {
  const deadlineMs = (options && options.timeoutMs) || 15000;
  const dir = locksDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, name + '.lock');
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;
      if (Date.now() - start > deadlineMs) {
        const timeout = new Error('lock timeout for ' + name);
        timeout.code = 'lock-timeout';
        throw timeout;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(lockPath); } catch { /* holder cleanup best-effort */ }
  }
}

// Atomically publish doc at targetPath with winner-takes-all uniqueness.
// Write to a unique tmp file, fsync it, then link(2) it to the target name:
// link fails with EEXIST when a winner already published, and readers NEVER
// observe a torn file (a killed writer leaves only an orphan *.tmp, never a
// partial target). Returns { created: true } for the winner, { created: false }
// for losers (target untouched). This supersedes naive O_EXCL-direct-write,
// which can leave a 0-byte torn target under SIGKILL (found by F-06 testing).
function exclusivePublishJson(targetPath, doc) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporary = targetPath + '.' + process.pid + '.' + Date.now() + '.tmp';
  const fd = fs.openSync(temporary, 'w', 0o644);
  try {
    fs.writeFileSync(fd, JSON.stringify(doc, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temporary, targetPath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* orphan cleanup best-effort */ }
    if (error && error.code === 'EEXIST') return { created: false };
    throw error;
  }
  try { fs.unlinkSync(temporary); } catch { /* unlink best-effort */ }
  if (process.platform !== 'win32') {
    const dir = fs.openSync(path.dirname(targetPath), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  return { created: true };
}

function readJsonIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) return null;
  return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
}

module.exports = { withLock, exclusivePublishJson, readJsonIfExists };
