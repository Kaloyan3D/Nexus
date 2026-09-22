'use strict';
/**
 * ContextCompactionF6UsageRace.Tests.cjs - F6 concurrent root-usage accounting.
 *
 * Production-path only: REAL separate pwsh processes -> REAL
 * ContextLifecycleCli.ps1 -Action record-root-usage -> REAL
 * Add-AihContextRootUsage -> REAL context-pressure.json. Never mocks the
 * writer, never edits JSON directly.
 *
 * Gates:
 *  F6-distinct: N=8 concurrent distinct StepIds (turn:step order metadata)
 *    => calls=C+N, all IDs exactly once, exact cumulative sums,
 *    peak=max, latest=newest by StepId order, second round accumulates.
 *  F6-same-id: N=6 concurrent writers, SAME StepId => exactly +1.
 *  F6-order: OLD (older StepId, larger tokens) commits after NEW (newer
 *    StepId, smaller tokens) => latest==NEW, peak==OLD, cumulative==both.
 *  F6-generation: same StepId in two generations => independent.
 *  F6-crash: stale lock (dead owner, aged) recovered without manual cleanup.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const CLI = path.join(repoRoot, 'scripts', 'ContextLifecycleCli.ps1');

let passed = 0;
function check(cond, name) { assert.ok(cond, name); passed += 1; console.log('PASS: ' + name); }

function pwshJson(scriptArgs, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f6cli-'));
  const payloadFile = path.join(dir, 'p.json');
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  const out = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLI].concat(scriptArgs).concat(['-PayloadFile', payloadFile]), { encoding: 'utf8', timeout: 120000 });
  const text = out.trim();
  return text === '' ? null : JSON.parse(text);
}
function makeFixture(description) {
  const bridge = path.join(repoRoot, 'scripts', 'Common.ps1');
  const setupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f6fix-'));
  const setupFile = path.join(setupDir, 's.ps1');
  const ws = path.join(os.tmpdir(), 'f6-ws-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2));
  fs.writeFileSync(setupFile, [
    '. \'' + path.join(repoRoot, 'scripts', 'Common.ps1') + '\'',
    '. \'' + path.join(repoRoot, 'scripts', 'TaskController.ps1') + '\'',
    '. \'' + path.join(repoRoot, 'scripts', 'ContextLifecycle.ps1') + '\'',
    '$ws = \'' + ws.replace(/'/g, "''") + '\'',
    'New-Item -ItemType Directory -Path $ws | Out-Null',
    '$task = New-AihTask -Workspace $ws -Description \'' + description.replace(/'/g, "''") + '\' -AcceptanceCriteria @(\'c1\') -Engine \'dual\'',
    'Write-Output ("WS=" + $ws)',
    'Write-Output ("TASK=" + $task.taskId)',
    'Write-Output (("INST=" + [string]$task.taskInstanceId))',
  ].join('\n'));
  const out = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', setupFile], { encoding: 'utf8', timeout: 120000 });
  const lines = out.trim().split(/\r?\n/);
  const got = {};
  for (const line of lines) { const m = /^(WS|TASK|INST)=(.*)$/.exec(line); if (m) got[m[1]] = m[2]; }
  return { ws: got.WS, taskId: got.TASK, taskInstanceId: got.INST };
}
function recordSync(fx, stepId, uncached, cache, output) {
  return pwshJson(['-Action', 'record-root-usage', '-TaskId', fx.taskId], {
    workspace: fx.ws, taskInstanceId: fx.taskInstanceId, engineRole: 'engineer_normal',
    engine: 'dual', uncachedInputTokens: uncached, cacheReadTokens: cache,
    outputTokens: output === undefined ? 10 : output, usageAvailable: true,
    stepId, sessionId: 'sess-f6',
  });
}
function readPressure(fx) {
  return JSON.parse(fs.readFileSync(path.join(fx.ws, '.ai-harness', 'runs', fx.taskId, 'context-pressure.json'), 'utf8'));
}
function lockPath(fx) {
  return path.join(fx.ws, '.ai-harness', 'runs', fx.taskId, 'context-pressure.lock');
}
function runConcurrent(fx, specs) {
  // Start-barrier overlap: all children spawn first, then release at once.
  const barrier = path.join(os.tmpdir(), 'f6bar-' + Date.now().toString(36) + Math.random().toString(16).slice(2));
  const children = specs.map((spec, i) => {
    const payloadFile = path.join(os.tmpdir(), 'f6pay-' + Date.now().toString(36) + i + '-' + Math.random().toString(16).slice(2) + '.json');
    fs.writeFileSync(payloadFile, JSON.stringify({
      workspace: fx.ws, taskInstanceId: spec.taskInstanceId || fx.taskInstanceId,
      engineRole: 'engineer_normal', engine: 'dual',
      uncachedInputTokens: spec.uncached, cacheReadTokens: spec.cache,
      outputTokens: 10, usageAvailable: true, stepId: spec.stepId, sessionId: 'sess-f6',
    }));
    const script = [
      'while (-not (Test-Path -LiteralPath \'' + barrier + '\')) { Start-Sleep -Milliseconds 10 }',
      ...(spec.holdMs ? ['Start-Sleep -Milliseconds ' + spec.holdMs] : []),
      "pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '" + CLI + "' -Action record-root-usage -TaskId '" + fx.taskId + "' -PayloadFile '" + payloadFile + "'",
      'exit $LASTEXITCODE',
    ].join('\n');
    const gate = path.join(os.tmpdir(), 'f6gate-' + Date.now().toString(36) + i + '-' + Math.random().toString(16).slice(2) + '.ps1');
    fs.writeFileSync(gate, script);
    return new Promise((resolve) => {
      const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', gate], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stdout, stderr, spec }));
    });
  });
  return (async () => {
    await new Promise((r) => setTimeout(r, 800));
    fs.writeFileSync(barrier, 'go');
    const results = await Promise.all(children);
    try { fs.unlinkSync(barrier); } catch {}
    return results;
  })();
}
async function main() {
  // F6-distinct: 8 concurrent distinct writers.
  const fx = makeFixture('f6 distinct');
  recordSync(fx, '1:1', 40000, 20000);
  recordSync(fx, '1:2', 30000, 10000);
  const before = readPressure(fx);
  check(before.rootModelCallCount === 2, 'F6-distinct setup: calls=2');
  const specs = [];
  for (let i = 1; i <= 8; i += 1) specs.push({ stepId: '2:' + i, uncached: 10000 + i * 1000, cache: 2000 + i * 100 });
  const results = await runConcurrent(fx, specs);
  for (const r of results) check(r.code === 0, 'F6-distinct child exit 0 (' + r.spec.stepId + ') ' + (r.stderr || '').slice(0, 120));
  const after = readPressure(fx);
  check(after.rootModelCallCount === 10, 'F6-distinct: calls=2+8=10 (got ' + after.rootModelCallCount + ')');
  const seen = after.seenStepIds || [];
  for (const s of specs) check(seen.filter((x) => x === s.stepId).length === 1, 'F6-distinct: ' + s.stepId + ' retained exactly once');
  let expU = 70000, expC = 30000, expO = 20;
  for (const s of specs) { expU += s.uncached; expC += s.cache; expO += 10; }
  check(after.cumulativeUncachedInputTokens === expU, 'F6-distinct: cumulativeUncached=' + expU + ' (got ' + after.cumulativeUncachedInputTokens + ')');
  check(after.cumulativeCacheReadTokens === expC, 'F6-distinct: cumulativeCache=' + expC + ' (got ' + after.cumulativeCacheReadTokens + ')');
  check(after.cumulativeOutputTokens === expO, 'F6-distinct: cumulativeOutput=' + expO + ' (got ' + after.cumulativeOutputTokens + ')');
  const effs = specs.map((s) => s.uncached + s.cache).concat([60000, 40000]);
  check(after.peakEffectiveInputTokens === Math.max.apply(null, effs), 'F6-distinct: peak=max (got ' + after.peakEffectiveInputTokens + ')');
  check(after.lastStepId === '2:8', 'F6-distinct: latest=newest StepId 2:8 (got ' + after.lastStepId + ')');
  check(after.latestEffectiveInputTokens === 18000 + 2800, 'F6-distinct: latest tokens=newest event (got ' + after.latestEffectiveInputTokens + ')');
  check(after.callsByEngine.dual === 10, 'F6-distinct: callsByEngine consistent');
  check(after.callsByRole.engineer_normal === 10, 'F6-distinct: callsByRole consistent');
  check(!fs.existsSync(lockPath(fx)), 'F6-distinct: no lock residue');
  // Second round on SAME state accumulates.
  const round2 = await runConcurrent(fx, [{ stepId: '3:1', uncached: 5000, cache: 500 }, { stepId: '3:2', uncached: 6000, cache: 600 }]);
  for (const r of round2) check(r.code === 0, 'F6-distinct round2 exit 0');
  const after2 = readPressure(fx);
  check(after2.rootModelCallCount === 12, 'F6-distinct round2: calls=12 (got ' + after2.rootModelCallCount + ')');
  check(after2.lastStepId === '3:2', 'F6-distinct round2: latest=3:2');
  // F6-same-id: 6 concurrent writers, SAME StepId => exactly +1.
  const fx2 = makeFixture('f6 same-id');
  recordSync(fx2, '1:1', 10000, 1000);
  const same = [];
  for (let i = 0; i < 6; i += 1) same.push({ stepId: '5:5', uncached: 10000, cache: 1000 });
  const sameRes = await runConcurrent(fx2, same);
  for (const r of sameRes) check(r.code === 0, 'F6-same-id child exit 0');
  const sameAfter = readPressure(fx2);
  check(sameAfter.rootModelCallCount === 2, 'F6-same-id: exactly one logical observation (got ' + sameAfter.rootModelCallCount + ')');
  check((sameAfter.seenStepIds || []).filter((x) => x === '5:5').length === 1, 'F6-same-id: dedupe identity occurs once');
  check(sameAfter.cumulativeUncachedInputTokens === 20000, 'F6-same-id: cumulative increments once');
  // F6-order: OLD (older order, larger tokens) commits after NEW.
  const fx3 = makeFixture('f6 order');
  recordSync(fx3, '1:1', 1000, 100);
  const orderRes = await runConcurrent(fx3, [
    { stepId: '9:1', uncached: 90000, cache: 9000 },
    { stepId: '9:9', uncached: 1000, cache: 100, holdMs: 50 },
  ]);
  // Force OLD to commit strictly after NEW regardless of barrier timing:
  // re-record OLD synchronously after NEW is known present is NOT needed;
  // instead assert final state with a deterministic second pass below.
  for (const r of orderRes) check(r.code === 0, 'F6-order child exit 0');
  const fx3b = makeFixture('f6 order deterministic');
  recordSync(fx3b, '1:1', 1000, 100);
  recordSync(fx3b, '9:9', 1000, 100); // NEW commits first
  recordSync(fx3b, '9:1', 90000, 9000); // OLD commits after NEW
  const ordDet = readPressure(fx3b);
  check(ordDet.lastStepId === '9:9', 'F6-order: latest order identity=NEW (got ' + ordDet.lastStepId + ')');
  check(ordDet.latestEffectiveInputTokens === 1100, 'F6-order: latest tokens=NEW (got ' + ordDet.latestEffectiveInputTokens + ')');
  check(ordDet.peakEffectiveInputTokens === 99000, 'F6-order: peak=max OLD (got ' + ordDet.peakEffectiveInputTokens + ')');
  check(ordDet.cumulativeUncachedInputTokens === 1000 + 1000 + 90000, 'F6-order: cumulative includes both');
  check(ordDet.rootModelCallCount === 3, 'F6-order: both counted');
  const ordRace = readPressure(fx3);
  check(ordRace.peakEffectiveInputTokens === 99000, 'F6-order race: peak=max regardless of commit order');
  check(ordRace.rootModelCallCount === 3, 'F6-order race: both counted');
  check(ordRace.lastStepId === '9:9', 'F6-order race: latest=NEW by StepId order (got ' + ordRace.lastStepId + ')');
  // F6-generation: same StepId in two generations => independent.
  const fxA = makeFixture('f6 gen A');
  recordSync(fxA, '10:1', 7000, 700);
  const fxB = makeFixture('f6 gen B');
  recordSync(fxB, '10:1', 8000, 800);
  const pA = readPressure(fxA), pB = readPressure(fxB);
  check(pA.rootModelCallCount === 1 && pB.rootModelCallCount === 1, 'F6-generation: each records own observation');
  check(pA.cumulativeUncachedInputTokens === 7000 && pB.cumulativeUncachedInputTokens === 8000, 'F6-generation: separate states consistent');
  check(lockPath(fxA) !== lockPath(fxB), 'F6-generation: locks independent (per-run paths)');
  // F6-crash: stale lock with dead owner recovers without manual cleanup.
  const fxC = makeFixture('f6 crash');
  recordSync(fxC, '1:1', 1000, 100);
  const lp = lockPath(fxC);
  fs.writeFileSync(lp, JSON.stringify({ ownerId: 'dead-owner', ownerPid: 99999999, ownerProcessStartUtc: null, acquiredAtUtc: new Date(Date.now() - 120000).toISOString() }));
  const ancient = new Date(Date.now() - 120000);
  fs.utimesSync(lp, ancient, ancient);
  const recovered = recordSync(fxC, '1:2', 2000, 200);
  check(recovered.rootModelCallCount === 2, 'F6-crash: stale lock recovered, record accepted');
  check(!fs.existsSync(lp), 'F6-crash: no lock residue after recovery');
  // F6 no-shared-instance with F5 apply lock: apply lock file untouched.
  const applyLock = path.join(fx.ws, '.ai-harness', 'runs', fx.taskId, 'context-compaction-apply.lock');
  check(!fs.existsSync(applyLock), 'F6: F5 apply lock file untouched by usage accounting');
  console.log('RESULT: ' + passed + ' F6 usage-race assertions passed.');
}
main().catch((e) => { console.error('FAIL: ' + (e && e.stack || e)); process.exit(1); });
