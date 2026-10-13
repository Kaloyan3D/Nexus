'use strict';
// Manual adversarial authority regressions, no production source patching.
// Real mutex owner barriers and a PowerShell debugger breakpoint at release's
// unlink model suspension after verification. Safety assertions fail on the unchanged integration baseline.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(process.env.CCV2_TEST_ROOT || path.join(__dirname, '..'));
const pwsh = process.env.AIH_TEST_PWSH || 'pwsh';
const { createCliApplyLockClient } = require(path.join(root, 'config/ContextActiveApplyLockClientV2.cjs'));
const area = fs.mkdtempSync(path.join(os.tmpdir(), 'ccv2-authority-races-'));
const checks = [], observations = [];
const children = [];
function check(pass, name) { checks.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS: ' : 'FAIL: ') + name); }
async function until(predicate, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!predicate()) { assert(Date.now() < end, message); await new Promise(resolve => setTimeout(resolve, 25)); }
}
function launch(name, source, args) {
  const file = path.join(area, name + '.ps1');
  fs.writeFileSync(file, source);
  const child = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-File', file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(name + ' deadline exceeded')); }, 40000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  done.catch(() => {});
  return { child, done };
}
async function mutexTimeout() {
  const held = path.join(area, 'mutex-held'), resume = path.join(area, 'mutex-release'), entered = path.join(area, 'mutex-entered');
  const session = 'race-' + path.basename(area), operation = 'op';
  const holder = launch('mutex-holder', `param($Root,$Session,$Operation,$Held,$Resume)
. (Join-Path $Root 'scripts/Platform.ps1')
$name = ConvertTo-AihSafeSyncName ('AIHarness.ContextCompaction.LockFile.' + $Session + '.' + $Operation)
$mutex = [Threading.Mutex]::new($false,$name)
$taken = $mutex.WaitOne(1000)
if (-not $taken) { throw 'fixture mutex acquisition failed' }
try {
 [IO.File]::WriteAllText($Held,'held')
 while (-not [IO.File]::Exists($Resume)) { Start-Sleep -Milliseconds 25 }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
`, [root, session, operation, held, resume]);
  await until(() => fs.existsSync(held) || holder.child.exitCode !== null, 'mutex holder ready');
  assert(fs.existsSync(held), 'real mutex acquired');
  const contender = launch('mutex-contender', `param($Root,$Session,$Operation,$Entered)
. (Join-Path $Root 'scripts/Platform.ps1')
. (Join-Path $Root 'scripts/ContextLifecycle.ps1')
Use-AihCompactionLockMutex -SessionId $Session -OperationId $Operation { [IO.File]::WriteAllText($Entered,'action ran') }
`, [root, session, operation, entered]);
  const completion = await contender.done;
  observations.push({ name: 'mutex-timeout', holderAlive: holder.child.exitCode === null, contender: completion, actionEnteredWhileHeld: fs.existsSync(entered) });
  check(holder.child.exitCode === null, 'fixture keeps real mutex held until explicit release');
  check(!fs.existsSync(entered) && completion.code !== 0 && completion.stderr.includes('refusing unlocked action'), 'timeout must fail closed without executing critical section');
  fs.writeFileSync(resume, 'release');
  assert.equal((await holder.done).code, 0, 'mutex holder exits cleanly');
}
async function unavailableMutex() {
  const entered = path.join(area, 'unavailable-mutex-entered');
  const contender = launch('unavailable-mutex', `param($Root,$Entered)
. (Join-Path $Root 'scripts/Platform.ps1')
. (Join-Path $Root 'scripts/ContextLifecycle.ps1')
Use-AihCompactionLockMutex -SessionId ('x' * 4096) -OperationId 'op' { [IO.File]::WriteAllText($Entered,'action ran') }
`, [root, entered]);
  const completion = await contender.done;
  observations.push({ name: 'mutex-construction-failure', contender: completion, actionEntered: fs.existsSync(entered) });
  check(!fs.existsSync(entered) && completion.code !== 0 && completion.stderr.includes('refusing unlocked action'), 'mutex construction failure must fail closed');
}
async function releaseRace() {
  const payload = path.join(area, 'task.json');
  fs.writeFileSync(payload, JSON.stringify({ workspace: area, description: 'synthetic release race', reviewRequested: false, engine: 'dual' }));
  const task = JSON.parse(execFileSync(pwsh, ['-NoProfile', '-File', path.join(root, 'scripts/Task.ps1'), '-Action', 'create-task', '-PayloadFile', payload], { encoding: 'utf8', timeout: 60000 }));
  const client = createCliApplyLockClient({ installRoot: root, workspace: area, pwshPath: pwsh, leaseSeconds: 4 });
  const call = { taskId: task.taskId, taskInstanceId: task.taskInstanceId, sessionId: 'race-release', operationId: 'race-release-op', leaseSeconds: 4 };
  const owner = await client.acquire(call);
  assert.equal(owner.acquired, true);
  const lockPath = path.join(area, '.ai-harness/runs', task.taskId, 'context-compaction-apply.lock');
  const old = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const releasePayload = path.join(area, 'release.json');
  fs.writeFileSync(releasePayload, JSON.stringify({ workspace: area, lockOwnerId: owner.ownerId }));
  const marker = path.join(area, 'release-checked'), resume = path.join(area, 'release-resume');
  const lines = fs.readFileSync(path.join(root, 'scripts/ContextLifecycle.ps1'), 'utf8').split('\n');
  const start = lines.findIndex(line => line.startsWith('function Invoke-AihCompactionApplyLockRelease'));
  const offset = lines.slice(start).findIndex(line => line.trim() === 'Remove-Item -LiteralPath $lockPath -Force');
  assert(start >= 0 && offset >= 0, 'exact release mutation located');
  const line = start + offset + 1;
  const releaser = launch('release-paused', `param($Root,$TaskId,$Payload,$Marker,$Resume,[int]$ReleaseLine)
$global:ccv2RaceMarker = $Marker
$global:ccv2RaceResume = $Resume
$null = Set-PSBreakpoint -Script (Join-Path $Root 'scripts/ContextLifecycle.ps1') -Line $ReleaseLine -Action {
 [IO.File]::WriteAllText($global:ccv2RaceMarker,'owner verified; before unlink')
 while (-not [IO.File]::Exists($global:ccv2RaceResume)) { Start-Sleep -Milliseconds 25 }
}
& (Join-Path $Root 'scripts/ContextLifecycleCli.ps1') -Action release-apply-lock -TaskId $TaskId -PayloadFile $Payload
`, [root, task.taskId, releasePayload, marker, resume, String(line)]);
  await until(() => fs.existsSync(marker) || releaser.child.exitCode !== null, 'release reaches owner-checked unlink');
  assert(fs.existsSync(marker), 'debugger reached real release unlink: not a fixture error');
  await until(() => Date.now() > Date.parse(old.expiresAtUtc), 'authoritative lease expires');
  let successor, blocked = false;
  try { successor = await client.acquire({ ...call, leaseSeconds: 60 }); }
  catch (error) {
    assert(String(error.message).includes('Compaction lock mutex busy'), 'only explicit mutex refusal is an acceptable contender failure');
    blocked = true;
  }
  if (!blocked) assert.equal(successor.acquired, true, 'legitimate successor acquired after expiry');
  fs.writeFileSync(resume, 'resume');
  const completion = await releaser.done;
  assert.equal(completion.code, 0, completion.stderr);
  if (blocked) {
    assert(!fs.existsSync(lockPath), 'authorized release finished before the new acquisition');
    successor = await client.acquire({ ...call, leaseSeconds: 60 });
    assert.equal(successor.acquired, true, 'successor acquires after the mutation critical section exits');
  }
  const survived = fs.existsSync(lockPath) && JSON.parse(fs.readFileSync(lockPath, 'utf8')).ownerId === successor.ownerId;
  observations.push({ name: 'release-after-check', takeoverBlockedDuringRelease: blocked, releaseLine: line, predecessor: owner.ownerId, successor: successor.ownerId, successorSurvived: survived, releaser: completion });
  check(survived, 'stale release cannot unlink successor after takeover');
  if (survived) await client.release({ taskId: task.taskId, ownerId: successor.ownerId });
}
async function main() { await mutexTimeout(); await unavailableMutex(); await releaseRace(); if (checks.some(row => !row.pass)) process.exitCode = 1; }
main().catch(error => { observations.push({ error: error.stack }); console.error(error.stack); process.exitCode = 2; }).finally(() => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify({ checks, observations }, null, 2) + '\n');
  fs.rmSync(area, { recursive: true, force: true });
});
