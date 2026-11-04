'use strict';
// EM-04C1: the persistent, stateless host of the Native bridge to the historical Muse modules.
//
// Run as `node -e <this file>` by the broker's supervisor (`worker_bridge.rs`), which owns the
// process: it spawns, restarts and kills it. This script never spawns anything, opens no file or
// socket, has no environment and reads nothing but its stdin.
//
// WHAT IT IS: the one-shot bridge (`muse_bridge.cjs`) with the Node start-up cost paid once. For
// EVERY request the unchanged bridge source is executed again in a fresh closure with the
// historical sources re-instantiated, a fresh in-memory virtual store and a fresh fixed clock, so
// the worker keeps no reasoning ledger, no routing state and no module state between requests.
// The Broker (engine state) stays the only owner of every task's state: a request carries the
// complete state it needs and the response carries the complete result.
//
// WIRE FORMAT (version 1): frames of a 4-byte big-endian length followed by that many bytes of
// UTF-8 JSON, in both directions. Strictly request/response, ONE request in flight.
//   -> hello    { v:1, type:'hello', sources:{governor,runtime,activity,signals}, bridge }
//   <- ready    { v:1, type:'ready', digests:{governor,runtime,activity,signals,bridge}, node }
//   -> request  { v:1, type:'request', id, scope, op, args }        id = previous id + 1, from 1
//   <- response { v:1, type:'response', id, scope, bridge:{ ok, result | code, message } }
//   <- fatal    { v:1, type:'fatal', code }                         then the process exits
// EM-04C2 S1: the supervisor starts the process with Node's deny-all permission mode
// (`--permission`, no `--allow-*`), and `ready` carries the proof that it is in force: the
// permission API reports every scope denied AND four harmless canary operations (read, write,
// child process, native addon) fail with the permission error. A worker that cannot prove it
// exits with `fatal permission-not-enforced` and never answers a request. The permission mode is
// a safeguard against accidents and bugs in the pinned modules, NOT an OS sandbox: it does not
// restrict network access.
//
// A violation (oversized or malformed frame, wrong order, a replayed or skipped id, a second
// hello, unknown fields) ends the process: the supervisor sees the exit and starts a clean one.
// EOF on stdin (the broker is gone or closed the pipe) ends the process too.

const crypto = require('node:crypto');
const path = require('node:path');
const vm = require('node:vm');

const PROTOCOL = 1;
const MAX_HELLO_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 640 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_SCOPE = 128;

const REQUEST_KEYS = ['v', 'type', 'id', 'scope', 'op', 'args'];
const SOURCE_KEYS = ['governor', 'runtime', 'activity', 'signals'];

let bridgeFn = null;
let sources = null;
let lastId = 0;
let chunks = [];
let have = 0;

function sha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function writeFrame(obj) {
  let body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > MAX_RESPONSE_BYTES) {
    body = Buffer.from(
      JSON.stringify({
        v: PROTOCOL,
        type: 'response',
        id: obj.id,
        scope: obj.scope,
        bridge: { ok: false, code: 'bridge-output-too-large', message: 'bridge output exceeds its bound' },
      }),
      'utf8'
    );
  }
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

function fatal(code, status) {
  try {
    writeFrame({ v: PROTOCOL, type: 'fatal', code });
  } finally {
    process.exit(status || 3);
  }
}

const EXIT = Object.freeze({ exit: true });

// Executes the UNCHANGED one-shot bridge once, against `text` as its stdin, with a stand-in for
// the process object that only offers what the bridge uses. Returns what it wrote to stdout.
function runBridge(text) {
  let out = '';
  let exited = false;
  const handlers = {};
  const fakeProcess = Object.freeze({
    stdin: Object.freeze({
      setEncoding() {},
      on(ev, cb) {
        handlers[ev] = cb;
      },
    }),
    stdout: Object.freeze({
      write(s) {
        out += String(s);
        return true;
      },
    }),
    exit() {
      exited = true;
      throw EXIT;
    },
  });
  const requireShim = (id) => {
    if (id === 'node:vm') return vm;
    if (id === 'node:path') return path;
    if (id === 'node:crypto') return crypto;
    throw new Error('the bridge refuses require(' + JSON.stringify(id) + ')');
  };
  bridgeFn(requireShim, fakeProcess);
  try {
    handlers.data(text);
    if (!exited) handlers.end();
  } catch (e) {
    if (e !== EXIT) throw e;
  }
  return out;
}

// Checks the permission mode from the inside. The canaries cannot do harm when enforcement is
// absent: the read is an access check of the node binary, the write targets a directory that does
// not exist, the child is `node -v`, the addon is a file that does not exist.
function permissionReport() {
  const fs = require('node:fs');
  const cp = require('node:child_process');
  const p = process.permission;
  const api = typeof p === 'object' && p !== null && typeof p.has === 'function';
  const scopes = {};
  if (api) {
    for (const sc of ['fs.read', 'fs.write', 'child', 'worker', 'addon']) {
      try {
        scopes[sc] = p.has(sc, sc.indexOf('fs.') === 0 ? '/' : undefined) === true;
      } catch {
        scopes[sc] = true;
      }
    }
  }
  const code = (f) => {
    try {
      const r = f();
      if (r && r.error) return (r.error && r.error.code) || 'error';
      return 'allowed';
    } catch (e) {
      return (e && e.code) || 'error';
    }
  };
  const root = path.parse(process.execPath).root;
  const missing = path.join(root, 'nexus-permission-canary-nonexistent');
  const canaries = {
    read: code(() => fs.accessSync(process.execPath)),
    write: code(() => fs.openSync(path.join(missing, 'x'), 'w')),
    child: code(() => cp.spawnSync(process.execPath, ['-v'], { stdio: 'ignore', timeout: 2000 })),
    addon: code(() => process.dlopen({ exports: {} }, missing + '.node')),
  };
  const denied = (c) => c === 'ERR_ACCESS_DENIED';
  const enforced =
    api &&
    Object.keys(scopes).length === 5 &&
    Object.keys(scopes).every((k) => scopes[k] === false) &&
    denied(canaries.read) &&
    denied(canaries.write) &&
    denied(canaries.child) &&
    (canaries.addon === 'ERR_DLOPEN_DISABLED' || denied(canaries.addon));
  return { enforced, scopes, canaries };
}

function onHello(body) {
  let msg;
  try {
    msg = JSON.parse(body.toString('utf8'));
  } catch {
    return fatal('hello-invalid');
  }
  if (!msg || msg.v !== PROTOCOL || msg.type !== 'hello' || typeof msg.bridge !== 'string' || !msg.sources) {
    return fatal('hello-invalid');
  }
  for (const k of SOURCE_KEYS) {
    if (typeof msg.sources[k] !== 'string') return fatal('hello-invalid');
  }
  sources = Object.freeze({
    governor: msg.sources.governor,
    runtime: msg.sources.runtime,
    activity: msg.sources.activity,
    signals: msg.sources.signals,
  });
  try {
    bridgeFn = vm.compileFunction(msg.bridge, ['require', 'process'], { filename: 'muse_bridge.cjs' });
  } catch {
    return fatal('bridge-uncompilable');
  }
  const digests = {};
  for (const k of SOURCE_KEYS) digests[k] = sha(sources[k]);
  digests.bridge = sha(msg.bridge);
  const permission = permissionReport();
  if (!permission.enforced) return fatal('permission-not-enforced');
  writeFrame({ v: PROTOCOL, type: 'ready', digests, node: process.version, permission });
}

function onRequest(body) {
  let msg;
  try {
    msg = JSON.parse(body.toString('utf8'));
  } catch {
    return fatal('request-invalid');
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fatal('request-invalid');
  for (const k of Object.keys(msg)) {
    if (REQUEST_KEYS.indexOf(k) === -1) return fatal('request-invalid');
  }
  if (msg.v !== PROTOCOL || msg.type !== 'request') return fatal('request-invalid');
  if (!Number.isSafeInteger(msg.id) || msg.id !== lastId + 1) return fatal('request-out-of-sequence');
  if (typeof msg.scope !== 'string' || msg.scope.length === 0 || msg.scope.length > MAX_SCOPE) return fatal('request-invalid');
  if (typeof msg.op !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(msg.op)) return fatal('request-invalid');
  if (msg.args === null || typeof msg.args !== 'object' || Array.isArray(msg.args)) return fatal('request-invalid');
  lastId = msg.id;
  let bridge;
  try {
    const out = runBridge(JSON.stringify({ sources, op: msg.op, args: msg.args }));
    bridge = JSON.parse(out);
  } catch (e) {
    bridge = { ok: false, code: 'bridge-error', message: String((e && e.message) || e).slice(0, 300) };
  }
  writeFrame({ v: PROTOCOL, type: 'response', id: msg.id, scope: msg.scope, bridge });
}

function onFrame(body) {
  if (bridgeFn === null) return onHello(body);
  return onRequest(body);
}

function pump() {
  for (;;) {
    if (have < 4) return;
    const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    chunks = [all];
    const n = all.readUInt32BE(0);
    const limit = bridgeFn === null ? MAX_HELLO_BYTES : MAX_REQUEST_BYTES;
    if (n === 0 || n > limit) return fatal('frame-too-large');
    if (all.length < 4 + n) return;
    const body = all.subarray(4, 4 + n);
    const rest = all.subarray(4 + n);
    chunks = rest.length ? [rest] : [];
    have = rest.length;
    onFrame(body);
  }
}

process.stdin.on('data', (c) => {
  chunks.push(c);
  have += c.length;
  pump();
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
