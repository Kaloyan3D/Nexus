'use strict';
// Failing safety regressions: real CLI + real pinned DSH, independent OS writer
// suspended at observable boundaries. No live provider calls. Linux SIGSTOP
// campaign is explicit; this does not claim native Windows verification.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const { createCliApplyLockClient } = require('../config/ContextActiveApplyLockClientV2.cjs');
const pwsh = process.env.AIH_TEST_PWSH || 'pwsh';
const evidence = { platform: process.platform, sourceHashes: {}, cases: [], checks: [] };
for (const name of ['config/ContextActiveApplyV2.cjs', 'config/ContextActiveApplyLockClientV2.cjs', 'config/ContextCompaction.cjs', 'config/ContextGenerationRuntimeV2.cjs', 'config/ContextCompleteTaskV2.cjs', 'scripts/ContextLifecycle.ps1']) {
  evidence.sourceHashes[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
}
function check(condition, name) {
  evidence.checks.push({ name, pass: Boolean(condition) });
  console.log((condition ? 'PASS: ' : 'FAIL: ') + name);
}
async function until(predicate, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < end, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
function runWorker(spec) {
  const file = path.join(spec.area, 'spec.json');
  fs.writeFileSync(file, JSON.stringify(spec));
  const child = spawn(process.execPath, [path.join(__dirname, 'ContextLeaseFencing.Worker.cjs'), file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', data => { out += data; });
  child.stderr.on('data', data => { err += data; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGCONT'); child.kill('SIGKILL'); reject(new Error('worker deadline exceeded')); }, 60000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
  // Parent may be waiting on stop/expiry first; still observe early failure.
  done.catch(() => {});
  return { child, done };
}
async function scenario(boundary, multi = false) {
  const area = fs.mkdtempSync(path.join(os.tmpdir(), 'ccv2-fencing-'));
  let run;
  let successor;
  let task;
  const client = createCliApplyLockClient({ installRoot: root, workspace: area, pwshPath: pwsh, leaseSeconds: 4 });
  try {
    const payload = path.join(area, 'task.json');
    fs.writeFileSync(payload, JSON.stringify({ workspace: area, description: 'synthetic lease fencing test', reviewRequested: false, engine: 'dual' }));
    task = JSON.parse(execFileSync(pwsh, ['-NoProfile', '-File', path.join(root, 'scripts/Task.ps1'), '-Action', 'create-task', '-PayloadFile', payload], { encoding: 'utf8', timeout: 60000 }));
    const spec = { area, task, pwsh, boundary, multi, marker: path.join(area, 'stopped.json'), resultFile: path.join(area, 'result.json'), durableFile: path.join(area, 'durable.json') };
    run = runWorker(spec);
    let marker;
    if (boundary !== 'valid-owner') {
      await until(() => fs.existsSync(spec.marker) || run.child.exitCode !== null, 'worker reaches boundary');
      assert(fs.existsSync(spec.marker), 'worker reached boundary, not a fixture error');
      marker = JSON.parse(fs.readFileSync(spec.marker, 'utf8'));
      await until(() => /State:\s+T/.test(fs.readFileSync('/proc/' + run.child.pid + '/status', 'utf8')), 'OS confirms stopped writer');
      assert.equal(marker.pid, run.child.pid);
      const expiry = Date.parse(marker.lock.expiresAtUtc);
      assert(Number.isFinite(expiry), 'real lease expiry exists');
      await until(() => Date.now() > expiry, 'real lease expires');
      successor = await client.acquire({ ...marker.call, leaseSeconds: 60 });
      assert.equal(successor.acquired, true, 'independent successor legitimately acquires');
      check((await client.renew(marker.call)).renewed === false, boundary + ': stale renewal refuses');
      check((await client.release({ taskId: task.taskId, ownerId: marker.call.ownerId })).released === false, boundary + ': sequential stale release refuses');
      run.child.kill('SIGCONT');
    }
    const completion = await run.done;
    assert.equal(completion.code, 0, 'worker completed production path: ' + completion.err);
    const result = JSON.parse(fs.readFileSync(spec.resultFile, 'utf8'));
    if (marker) {
      const lockPath = path.join(area, '.ai-harness/runs', task.taskId, 'context-compaction-apply.lock');
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      check(current.ownerId === successor.ownerId, boundary + ': successor token survives A10 finally');
      check(result.countAfter === marker.countAtStop, boundary + ': no append after takeover');
      check(result.writes === marker.writesAtStop, boundary + ': no durable write after takeover');
      check(!['committed', 'recovered'].includes(result.status), boundary + ': no stale successful commit');
      evidence.cases.push({ boundary, multi, stoppedWriterPid: marker.pid, predecessor: marker.lock.ownerId, successor: successor.ownerId, expiresAtUtc: marker.lock.expiresAtUtc, countAtStop: marker.countAtStop, writesAtStop: marker.writesAtStop, result });
      await client.release({ taskId: task.taskId, ownerId: successor.ownerId });
      successor = null;
      // Authority recovery after expiry: a fresh owner can acquire/release,
      // without reviving or changing the predecessor's token.
      const recovered = await client.acquire({ ...marker.call, leaseSeconds: 4 });
      check(recovered.acquired === true && recovered.ownerId !== marker.call.ownerId, boundary + ': fresh ownership recovery');
      check((await client.release({ taskId: task.taskId, ownerId: recovered.ownerId })).released === true, boundary + ': recovered owner releases');
    } else {
      check(result.status === 'committed' && result.applicationDurable === true && result.writes === 1, 'valid owner still commits on real DSH');
      evidence.cases.push({ boundary, result });
    }
  } finally {
    if (run && run.child.exitCode === null) { run.child.kill('SIGCONT'); run.child.kill('SIGKILL'); await run.done.catch(() => {}); }
    if (successor) await client.release({ taskId: task.taskId, ownerId: successor.ownerId });
    fs.rmSync(area, { recursive: true, force: true });
  }
}
async function main() {
  assert.equal(process.platform, 'linux', 'SIGSTOP campaign requires native Linux; Windows is UNVERIFIED');
  await scenario('valid-owner');
  for (const boundary of ['after-renew', 'before-first-append', 'before-second-append', 'before-flush', 'after-flush']) {
    await scenario(boundary, boundary === 'before-second-append');
  }
  const failed = evidence.checks.filter(check => !check.pass).length;
  console.log('Safety checks: ' + (evidence.checks.length - failed) + ' PASS, ' + failed + ' FAIL');
  if (failed) process.exitCode = 1;
}
main().catch(error => { evidence.error = error.stack; console.error(error.stack); process.exitCode = 2; }).finally(() => {
  if (process.env.CCV2_FENCING_EVIDENCE) fs.writeFileSync(process.env.CCV2_FENCING_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
});
