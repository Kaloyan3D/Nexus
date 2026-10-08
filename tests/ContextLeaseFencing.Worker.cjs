'use strict';
// Adversarial test worker only. Uses the accepted real-host builders without
// executing their test main; production modules and pinned DSH stay unchanged.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = path.resolve(__dirname, '..');
const fixtureFile = path.join(__dirname, 'ContextActiveApplyV2LiveHost.Tests.cjs');
const source = fs.readFileSync(fixtureFile, 'utf8');
const offset = source.indexOf('async function main() {');
assert(offset > 0, 'accepted real-host builders exist');
const prefix = source.slice(0, offset)
  .replaceAll("'TASK-A10-LIVE'", JSON.stringify(spec.task.taskId))
  .replaceAll("'task_a10live_0001'", JSON.stringify(spec.task.taskInstanceId));
const fixture = new Module(fixtureFile);
fixture.filename = fixtureFile;
fixture.paths = Module._nodeModulePaths(path.dirname(fixtureFile));
fixture._compile(prefix + '\nmodule.exports = { buildLiveShadowReady, applyInputForLive, host };', fixtureFile);
const { buildLiveShadowReady, applyInputForLive, host } = fixture.exports;
const active = require('../config/ContextActiveApplyV2.cjs');
const { createCliApplyLockClient } = require('../config/ContextActiveApplyLockClientV2.cjs');
const client = createCliApplyLockClient({ installRoot: root, workspace: spec.area, pwshPath: spec.pwsh, leaseSeconds: 4 });
let ownedCall, observedSession, writes = 0, stopped = false;
function suspend(boundary) {
  if (stopped || spec.boundary !== boundary) return;
  stopped = true;
  const lockPath = path.join(spec.area, '.ai-harness/runs', spec.task.taskId, 'context-compaction-apply.lock');
  fs.writeFileSync(spec.marker, JSON.stringify({ boundary, pid: process.pid, call: ownedCall, countAtStop: observedSession.events.length, writesAtStop: writes, lock: JSON.parse(fs.readFileSync(lockPath, 'utf8')) }));
  process.kill(process.pid, 'SIGSTOP'); // parent observes /proc stopped state before takeover
}
async function main() {
  const fx = await buildLiveShadowReady('sess-fencing', spec.multi === true);
  assert(!fx.blocked, 'real host fixture is shadow-ready');
  observedSession = fx.session;
  fx.proc.app.on('session/flush', async session => {
    writes++;
    fs.writeFileSync(spec.durableFile, JSON.stringify({ bytes: JSON.stringify(session.events), header: session.header }));
  });
  const originalAppend = fx.session.append.bind(fx.session);
  let replacements = 0;
  fx.session.append = function(type, data, ...opts) {
    if (opts[0] && opts[0].surfaceOp && opts[0].surfaceOp.op === 'replace') {
      replacements++;
      suspend(replacements === 1 ? 'before-first-append' : 'before-second-append');
    }
    return originalAppend(type, data, ...opts);
  };
  const serialization = {
    acquire: call => client.acquire(call),
    release: call => client.release(call),
    async renew(call) {
      ownedCall = call;
      const result = await client.renew(call);
      assert.equal(result.renewed, true, 'real renewal succeeds');
      suspend('after-renew');
      return result;
    },
  };
  const countBefore = fx.session.events.length;
  const input = applyInputForLive(fx, {
    serialization, lockLeaseSeconds: 4,
    checkpointDir: path.join(spec.area, 'checkpoint'), operationDir: path.join(spec.area, 'operation'),
    async flushFn(session) {
      suspend('before-flush');
      const result = await fx.proc.store.flush(session);
      suspend('after-flush');
      return result === true;
    },
  });
  const result = await active.applyActiveCompactionV2(input);
  fs.writeFileSync(spec.resultFile, JSON.stringify({
    status: result.status, mutated: result.mutated, applicationDurable: result.applicationDurable,
    countBefore, countAfter: fx.session.events.length, writes, replacements,
    segmentCount: fx.artifact.segments.length, stopped, hostVersion: host.version,
  }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 2; });
