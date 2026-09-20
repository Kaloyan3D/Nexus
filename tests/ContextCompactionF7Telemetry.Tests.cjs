'use strict';
/**
 * ContextCompactionF7Telemetry.Tests.cjs - F7 telemetry baseline preservation.
 *
 * Production-path only: REAL pwsh lifecycle functions / CLI actions against
 * isolated workspaces. No direct object mutation of telemetry, no synthetic
 * projection estimates as AFTER telemetry.
 *
 * Primary: 150000 baseline -> complete/checkpoint -> 5000 pre-apply -> apply
 * => baseline 150000 + size preserved; post 60000 => reduction 90000; ISO UTC.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
let passed = 0;
function check(cond, name) { assert.ok(cond, name); passed += 1; console.log('PASS: ' + name); }
function runPs(script) {
  const f = path.join(os.tmpdir(), 'f7t-' + Date.now().toString(36) + Math.random().toString(16).slice(2) + '.ps1');
  fs.writeFileSync(f, script);
  return execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8', timeout: 120000 });
}
const HDR = [
  `. '${path.join(repoRoot, 'scripts', 'Common.ps1')}'`,
  `. '${path.join(repoRoot, 'scripts', 'TaskController.ps1')}'`,
  `. '${path.join(repoRoot, 'scripts', 'ContextLifecycle.ps1')}'`,
].join('\n');
function scenario() {
  const out = runPs(HDR + '\n' + [
    `$ws = Join-Path ([IO.Path]::GetTempPath()) ("f7prim-" + [guid]::NewGuid().ToString("N"))`,
    'New-Item -ItemType Directory -Path $ws | Out-Null',
    `$t = New-AihTask -Workspace $ws -Description 'f7 primary' -AcceptanceCriteria @('c1') -Engine 'dual'`,
    '$TID = $t.taskId; $INST = [string]$t.taskInstanceId',
    '[void](Add-AihContextRootUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -EngineRole engineer_normal -Engine dual -UncachedInputTokens 140000 -CacheReadTokens 10000 -OutputTokens 10 -UsageAvailable $true -StepId "1:1" -SessionId s)',
    '$run = Join-Path (Join-Path $ws ".ai-harness/runs") $TID',
    '$ev = [ordered]@{ schemaVersion = 2; attempt = 1; taskInstanceId = $INST; acceptanceCriteria = @([ordered]@{ criterion = "c1"; status = "met"; evidence = "fixture evidence for c1" }); verification = @([ordered]@{ name = "v"; kind = "verify"; status = "PASS"; exitCode = 0; attempt = 1 }); scopePass = $true }',
    'Write-AihAtomicJson (Join-Path $run "evidence.json") $ev',
    '[void](Test-AihTaskCompletion -Workspace $ws -TaskId $TID -TaskInstanceId $INST)',
    '$elig = Test-AihContextCompactionEligibility -Workspace $ws -TaskId $TID -TaskInstanceId $INST',
    '$cp = New-AihContextCheckpoint -Workspace $ws -TaskId $TID -TaskInstanceId $INST -ContinuityUserText "u" -ContinuityAssistantText "a"',
    '$tel = Write-AihContextCompactionTelemetry -Workspace $ws -TaskId $TID -TaskInstanceId $INST -Eligibility $elig -CheckpointPath $cp.path -CheckpointSizeBytes $cp.sizeBytes',
    'Write-Output ("BASE=" + $tel.latestEffectiveInputTokens)',
    'Write-Output ("SIZE=" + $tel.checkpointSizeBytes)',
    '[void](Add-AihContextRootUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -EngineRole engineer_normal -Engine dual -UncachedInputTokens 4000 -CacheReadTokens 1000 -OutputTokens 10 -UsageAvailable $true -StepId "1:2" -SessionId s)',
    '$elig2 = Test-AihContextCompactionEligibility -Workspace $ws -TaskId $TID -TaskInstanceId $INST',
    // REAL apply path: write-telemetry WITHOUT size (controller line 2070), then mark-applied.
    '$tel2 = Write-AihContextCompactionTelemetry -Workspace $ws -TaskId $TID -TaskInstanceId $INST -Eligibility $elig2 -SessionId "s"',
    'Write-Output ("ABASE=" + $tel2.latestEffectiveInputTokens)',
    'Write-Output (("ASIZE=" + $tel2.checkpointSizeBytes))',
    '[void](Set-AihContextLifecycleTransition -Workspace $ws -TaskId $TID -TaskInstanceId $INST -To eligible -Reason f7)',
    '[void](Set-AihContextLifecycleTransition -Workspace $ws -TaskId $TID -TaskInstanceId $INST -To checkpoint-ready -Reason f7 -CheckpointPath $cp.path)',
    '$op = New-AihContextCompactionOperation -Workspace $ws -TaskId $TID -TaskInstanceId $INST -SessionId s -ReplacementStart 0 -ReplacementEnd 0 -SourceEventSeqs @(0) -CheckpointPath $cp.path -Segments @([ordered]@{ start = 0; end = 0; sourceEventSeqs = @(0) }) -CompletionBoundarySeq 5',
    '[void](Set-AihContextLifecycleTransition -Workspace $ws -TaskId $TID -TaskInstanceId $INST -To apply-pending -Reason f7 -SessionId s)',
    '$st = Read-AihContextLifecycleState -Workspace $ws -TaskId $TID; $st.state = "applied"',
    'Write-AihContextLifecycleState -Workspace $ws -TaskId $TID -State $st | Out-Null',
    // NOTE: assertions read RAW FILE BYTES ($rawDisk): PowerShell rehydrates
    // ISO strings as DateTime and implicit string conversion renders locale
    // text, so only the persisted representation proves the UTC contract.
    '[void](Set-AihContextCompactionApplied -Workspace $ws -TaskId $TID -TaskInstanceId $INST -AppliedAtUtc "2026-09-17T20:52:00+03:00" -SessionId s)',
    '[void](Set-AihContextCompactionApplied -Workspace $ws -TaskId $TID -TaskInstanceId $INST -AppliedAtUtc "2026-09-17T18:52:00.000Z" -SessionId s)',
    '$rawDisk = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $run "context-compaction-telemetry.json")',
    '$dm = [regex]::Match($rawDisk, \'"appliedAtUtc":\\s*"([^"]*)"\')',
    'Write-Output ("APPLIED=" + $dm.Groups[1].Value)',
    'Write-Output ("REAPPLIED=" + $dm.Groups[1].Value)',
    '$post = Add-AihContextPostCompactionUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -PostCompactionEffectiveInputTokens 60000 -SessionId s -PostCompactionStepId "2:1"',
    'Write-Output ("AFTER=" + $post.postCompactionEffectiveInputTokens)',
    'Write-Output ("REDUCTION=" + $post.firstCallTokenReduction)',
    'Write-Output ("PSTEP=" + $post.postCompactionStepId)',
    'Write-Output ("WS=" + $ws)',
  ].join('\n'));
  const got = {};
  for (const line of out.trim().split(/\r?\n/)) { const m = /^(BASE|SIZE|ABASE|ASIZE|APPLIED|REAPPLIED|AFTER|REDUCTION|PSTEP|WS)=(.*)$/.exec(line); if (m) got[m[1]] = m[2]; }
  return got;
}
function main() {
  const g = scenario();
  check(g.BASE === '150000', 'F7: completion baseline 150000 (got ' + g.BASE + ')');
  check(Number(g.SIZE) > 0, 'F7: completion checkpoint size non-null (got ' + g.SIZE + ')');
  check(g.ABASE === '150000', 'F7: baseline preserved after apply despite 5000 pre-apply (got ' + g.ABASE + ')');
  check(g.ASIZE === g.SIZE, 'F7: checkpoint size unchanged after apply (' + g.ASIZE + ' vs ' + g.SIZE + ')');
  check(g.AFTER === '60000', 'F7: correlated after=60000 (got ' + g.AFTER + ')');
  check(g.REDUCTION === '90000', 'F7: reduction=150000-60000=90000 (got ' + g.REDUCTION + ')');
  check(g.PSTEP === '2:1', 'F7: post-observation carries StepId correlation (got ' + g.PSTEP + ')');
  check(/^2026-09-17T17:52:00.*Z$/.test(g.APPLIED), 'F7: +03:00 offset normalized to canonical UTC (got ' + g.APPLIED + ')');
  check(!/\//.test(g.APPLIED), 'F7: no locale slashes in persisted timestamp');
  check(g.REAPPLIED === g.APPLIED, 'F7: retry keeps first application instant (idempotent)');
  // Locale-independence through the CLI path.
  const cli = path.join(repoRoot, 'scripts', 'ContextLifecycleCli.ps1');
  const out2 = runPs(HDR + '\n' + [
    `$ws = Join-Path ([IO.Path]::GetTempPath()) ("f7loc-" + [guid]::NewGuid().ToString("N"))`,
    'New-Item -ItemType Directory -Path $ws | Out-Null',
    `$t = New-AihTask -Workspace $ws -Description 'f7 locale' -AcceptanceCriteria @('c1') -Engine 'dual'`,
    '$TID = $t.taskId; $INST = [string]$t.taskInstanceId',
    '[void](Add-AihContextRootUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -EngineRole engineer_normal -Engine dual -UncachedInputTokens 130000 -CacheReadTokens 10000 -OutputTokens 10 -UsageAvailable $true -StepId "1:1" -SessionId s)',
    '$run = Join-Path (Join-Path $ws ".ai-harness/runs") $TID',
    '$ev = [ordered]@{ schemaVersion = 2; attempt = 1; taskInstanceId = $INST; acceptanceCriteria = @([ordered]@{ criterion = "c1"; status = "met"; evidence = "fixture evidence for c1" }); verification = @([ordered]@{ name = "v"; kind = "verify"; status = "PASS"; exitCode = 0; attempt = 1 }); scopePass = $true }',
    'Write-AihAtomicJson (Join-Path $run "evidence.json") $ev',
    '[void](Test-AihTaskCompletion -Workspace $ws -TaskId $TID -TaskInstanceId $INST)',
    '$elig = Test-AihContextCompactionEligibility -Workspace $ws -TaskId $TID -TaskInstanceId $INST',
    '$cp = New-AihContextCheckpoint -Workspace $ws -TaskId $TID -TaskInstanceId $INST',
    '[void](Write-AihContextCompactionTelemetry -Workspace $ws -TaskId $TID -TaskInstanceId $INST -Eligibility $elig -CheckpointPath $cp.path -CheckpointSizeBytes $cp.sizeBytes)',
    '[void](Set-AihContextLifecycleTransition -Workspace $ws -TaskId $TID -TaskInstanceId $INST -To eligible -Reason f7)',
    '[void](Set-AihContextLifecycleTransition -Workspace $ws -TaskId $TID -TaskInstanceId $INST -To checkpoint-ready -Reason f7 -CheckpointPath $cp.path)',
    '$op = New-AihContextCompactionOperation -Workspace $ws -TaskId $TID -TaskInstanceId $INST -SessionId s -ReplacementStart 0 -ReplacementEnd 0 -SourceEventSeqs @(0) -CheckpointPath $cp.path -Segments @([ordered]@{ start = 0; end = 0; sourceEventSeqs = @(0) }) -CompletionBoundarySeq 5',
    '[void](Set-AihContextLifecycleTransition -Workspace $ws -TaskId $TID -TaskInstanceId $INST -To apply-pending -Reason f7 -SessionId s)',
    '$st = Read-AihContextLifecycleState -Workspace $ws -TaskId $TID; $st.state = "applied"',
    'Write-AihContextLifecycleState -Workspace $ws -TaskId $TID -State $st | Out-Null',
    `$pf = Join-Path ([IO.Path]::GetTempPath()) ("f7lpay-" + [guid]::NewGuid().ToString("N") + ".json")`,
    '[IO.File]::WriteAllText($pf, (@{ workspace = $ws; taskInstanceId = $INST; sessionId = "s"; appliedAtUtc = "09/17/2026 17:52:00" } | ConvertTo-Json -Depth 5))',
    `$mraw = pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '${cli}' -Action mark-applied -TaskId $TID -PayloadFile $pf`,
    '$lmraw = [regex]::Match($mraw, \'"appliedAtUtc":\\s*"([^"]*)"\')',
    'Write-Output ("LOC=" + $lmraw.Groups[1].Value)',
    'Remove-Item -LiteralPath $ws -Recurse -Force',
  ].join('\n'));
  const lm = /^LOC=(.*)$/m.exec(out2);
  check(lm !== null && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/.test(lm[1].trim()) && lm[1].indexOf('/') < 0, 'F7: locale input normalized to canonical ISO UTC (got ' + (lm && lm[1]) + ')');
  // Generation isolation + malformed behavior.
  const out3 = runPs(HDR + '\n' + [
    `$ws = Join-Path ([IO.Path]::GetTempPath()) ("f7iso-" + [guid]::NewGuid().ToString("N"))`,
    'New-Item -ItemType Directory -Path $ws | Out-Null',
    `$tA = New-AihTask -Workspace $ws -Description 'f7 iso A' -AcceptanceCriteria @('c1') -Engine 'dual'`,
    '$AID = $tA.taskId; $AINST = [string]$tA.taskInstanceId',
    '[void](Add-AihContextRootUsage -Workspace $ws -TaskId $AID -TaskInstanceId $AINST -EngineRole engineer_normal -Engine dual -UncachedInputTokens 140000 -CacheReadTokens 10000 -OutputTokens 10 -UsageAvailable $true -StepId "1:1" -SessionId s)',
    '$runA = Join-Path (Join-Path $ws ".ai-harness/runs") $AID',
    '$evA = [ordered]@{ schemaVersion = 2; attempt = 1; taskInstanceId = $AINST; acceptanceCriteria = @([ordered]@{ criterion = "c1"; status = "met"; evidence = "fixture evidence for c1" }); verification = @([ordered]@{ name = "v"; kind = "verify"; status = "PASS"; exitCode = 0; attempt = 1 }); scopePass = $true }',
    'Write-AihAtomicJson (Join-Path $runA "evidence.json") $evA',
    '[void](Test-AihTaskCompletion -Workspace $ws -TaskId $AID -TaskInstanceId $AINST)',
    '$eligA = Test-AihContextCompactionEligibility -Workspace $ws -TaskId $AID -TaskInstanceId $AINST',
    '$cpA = New-AihContextCheckpoint -Workspace $ws -TaskId $AID -TaskInstanceId $AINST',
    '[void](Write-AihContextCompactionTelemetry -Workspace $ws -TaskId $AID -TaskInstanceId $AINST -Eligibility $eligA -CheckpointPath $cpA.path -CheckpointSizeBytes $cpA.sizeBytes)',
    // Same TASK id, foreign generation: plant a stale-instance telemetry doc,
    // then write with the live instance -> must fail closed (per-task run
    // dirs already isolate distinct TASK ids; the generation guard is what
    // this probes). Task B proves a second task is unaffected.
    '$staleDoc = [ordered]@{ schemaVersion = 1; taskId = $AID; taskInstanceId = "task_ffffffffffffffffffffffffffffffff"; latestEffectiveInputTokens = 1; sessionId = "stale" }',
    'Write-AihAtomicJson (Join-Path $runA "context-compaction-telemetry.json") $staleDoc',
    '$threw = $false',
    'try { [void](Write-AihContextCompactionTelemetry -Workspace $ws -TaskId $AID -TaskInstanceId $AINST -Eligibility $eligA -SessionId "x") } catch { $threw = $true }',
    'Write-Output ("MISMATCH-THREW=" + $threw)',
    'Remove-Item -LiteralPath (Join-Path $runA "context-compaction-telemetry.json") -Force',
    '[void](Write-AihContextCompactionTelemetry -Workspace $ws -TaskId $AID -TaskInstanceId $AINST -Eligibility $eligA -CheckpointPath $cpA.path -CheckpointSizeBytes $cpA.sizeBytes)',
    `$tB = New-AihTask -Workspace $ws -Description 'f7 iso B' -AcceptanceCriteria @('c1') -Engine 'dual'`,
    '$BID = $tB.taskId; $BINST = [string]$tB.taskInstanceId',
    '[void](Add-AihContextRootUsage -Workspace $ws -TaskId $BID -TaskInstanceId $BINST -EngineRole engineer_normal -Engine dual -UncachedInputTokens 9000 -CacheReadTokens 900 -OutputTokens 10 -UsageAvailable $true -StepId "1:1" -SessionId s)',
    '$eligB = Test-AihContextCompactionEligibility -Workspace $ws -TaskId $BID -TaskInstanceId $BINST',
    '[void](Write-AihContextCompactionTelemetry -Workspace $ws -TaskId $BID -TaskInstanceId $BINST -Eligibility $eligB)',
    '$telB = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path (Join-Path $ws (".ai-harness/runs/" + $BID)) "context-compaction-telemetry.json") | ConvertFrom-Json',
    'Write-Output ("B-BASE=" + $telB.latestEffectiveInputTokens)',
    '$telA = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $runA "context-compaction-telemetry.json") | ConvertFrom-Json',
    'Write-Output ("A-BASE=" + $telA.latestEffectiveInputTokens)',
    'Write-Output ("A-SIZE=" + $telA.checkpointSizeBytes)',
    'Remove-Item -LiteralPath $ws -Recurse -Force',
  ].join('\n'));
  check(/MISMATCH-THREW=True/.test(out3), 'F7: stale-generation telemetry write fails closed');
  check(/A-BASE=150000/.test(out3), 'F7: generation A baseline restored after stale plant');
  check(/B-BASE=9900/.test(out3), 'F7: task B has its own baseline (no A inheritance)');
  check(/A-SIZE=\d+/.test(out3) && !/A-SIZE=\s*$/m.test(out3), 'F7: generation A size intact');
  // Malformed telemetry fails closed, never regenerated from pressure.
  const out4 = runPs(HDR + '\n' + [
    `$ws = Join-Path ([IO.Path]::GetTempPath()) ("f7mal-" + [guid]::NewGuid().ToString("N"))`,
    'New-Item -ItemType Directory -Path $ws | Out-Null',
    `$t = New-AihTask -Workspace $ws -Description 'f7 mal' -AcceptanceCriteria @('c1') -Engine 'dual'`,
    '$TID = $t.taskId; $INST = [string]$t.taskInstanceId',
    '[void](Add-AihContextRootUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -EngineRole engineer_normal -Engine dual -UncachedInputTokens 130000 -CacheReadTokens 10000 -OutputTokens 10 -UsageAvailable $true -StepId "1:1" -SessionId s)',
    '$run = Join-Path (Join-Path $ws ".ai-harness/runs") $TID',
    '$elig = Test-AihContextCompactionEligibility -Workspace $ws -TaskId $TID -TaskInstanceId $INST',
    '[void](Write-AihContextCompactionTelemetry -Workspace $ws -TaskId $TID -TaskInstanceId $INST -Eligibility $elig)',
    'Set-Content -Encoding UTF8 -LiteralPath (Join-Path $run "context-compaction-telemetry.json") -Value "{not json"',
    '$threw = $false',
    'try { [void](Write-AihContextCompactionTelemetry -Workspace $ws -TaskId $TID -TaskInstanceId $INST -Eligibility $elig) } catch { $threw = $true }',
    'Write-Output ("MALFORMED-THREW=" + $threw)',
    'Remove-Item -LiteralPath $ws -Recurse -Force',
  ].join('\n'));
  check(/MALFORMED-THREW=True/.test(out4), 'F7: malformed telemetry fails closed (no regen from pressure)');
  // Correlation gate: OLD produced pre-apply, delivered post-apply, then NEW.
  const out5 = runPs(HDR + '\n' + [
    `$ws = Join-Path ([IO.Path]::GetTempPath()) ("f7corr-" + [guid]::NewGuid().ToString("N"))`,
    'New-Item -ItemType Directory -Path $ws | Out-Null',
    `$t = New-AihTask -Workspace $ws -Description 'f7 corr' -AcceptanceCriteria @('c1') -Engine 'dual'`,
    '$TID = $t.taskId; $INST = [string]$t.taskInstanceId',
    '[void](Add-AihContextRootUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -EngineRole engineer_normal -Engine dual -UncachedInputTokens 140000 -CacheReadTokens 10000 -OutputTokens 10 -UsageAvailable $true -StepId "1:1" -SessionId s)',
    '$run = Join-Path (Join-Path $ws ".ai-harness/runs") $TID',
    '$ev = [ordered]@{ schemaVersion = 2; attempt = 1; taskInstanceId = $INST; acceptanceCriteria = @([ordered]@{ criterion = "c1"; status = "met"; evidence = "fixture evidence for c1" }); verification = @([ordered]@{ name = "v"; kind = "verify"; status = "PASS"; exitCode = 0; attempt = 1 }); scopePass = $true }',
    'Write-AihAtomicJson (Join-Path $run "evidence.json") $ev',
    '[void](Test-AihTaskCompletion -Workspace $ws -TaskId $TID -TaskInstanceId $INST)',
    '$elig = Test-AihContextCompactionEligibility -Workspace $ws -TaskId $TID -TaskInstanceId $INST',
    '$cp = New-AihContextCheckpoint -Workspace $ws -TaskId $TID -TaskInstanceId $INST',
    '[void](Write-AihContextCompactionTelemetry -Workspace $ws -TaskId $TID -TaskInstanceId $INST -Eligibility $elig -CheckpointPath $cp.path -CheckpointSizeBytes $cp.sizeBytes)',
    '[void](Set-AihContextLifecycleTransition -Workspace $ws -TaskId $TID -TaskInstanceId $INST -To eligible -Reason c)',
    '[void](Set-AihContextLifecycleTransition -Workspace $ws -TaskId $TID -TaskInstanceId $INST -To checkpoint-ready -Reason c -CheckpointPath $cp.path)',
    '$op = New-AihContextCompactionOperation -Workspace $ws -TaskId $TID -TaskInstanceId $INST -SessionId s -ReplacementStart 0 -ReplacementEnd 0 -SourceEventSeqs @(0) -CheckpointPath $cp.path -Segments @([ordered]@{ start = 0; end = 0; sourceEventSeqs = @(0) }) -CompletionBoundarySeq 5',
    '[void](Set-AihContextLifecycleTransition -Workspace $ws -TaskId $TID -TaskInstanceId $INST -To apply-pending -Reason c -SessionId s)',
    '$st = Read-AihContextLifecycleState -Workspace $ws -TaskId $TID; $st.state = "applied"',
    'Write-AihContextLifecycleState -Workspace $ws -TaskId $TID -State $st | Out-Null',
    '[void](Set-AihContextCompactionApplied -Workspace $ws -TaskId $TID -TaskInstanceId $INST -AppliedAtUtc "2026-09-17T17:52:00.000Z" -SessionId s)',
    '$bt = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $run "context-compaction-telemetry.json") | ConvertFrom-Json',
    'Write-Output ("BOUNDARY=" + $bt.appliedAfterStepId)',
    // APPLY, then OLD (1:1, pre-apply event-time) delivered, then NEW (2:1).
    '$oldThrew = $false',
    'try { [void](Add-AihContextPostCompactionUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -PostCompactionEffectiveInputTokens 140000 -SessionId s -PostCompactionStepId "1:1") } catch { $oldThrew = $true }',
    'Write-Output ("OLD-THREW=" + $oldThrew)',
    // Step-less and cross-session probes run BEFORE any valid AFTER exists
    // (first-valid-AFTER immutability would otherwise mask the gate). Step-less
    // and cross-session candidates fail closed.
    '$slThrew = $false',
    'try { [void](Add-AihContextPostCompactionUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -PostCompactionEffectiveInputTokens 59000 -SessionId s -PostCompactionStepId "") } catch { $slThrew = $true }',
    'Write-Output ("STEPLESS-THREW=" + $slThrew)',
    '$xsThrew = $false',
    'try { [void](Add-AihContextPostCompactionUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -PostCompactionEffectiveInputTokens 59000 -SessionId other -PostCompactionStepId "9:9") } catch { $xsThrew = $true }',
    'Write-Output ("XSESS-THREW=" + $xsThrew)',
    '$np = Add-AihContextPostCompactionUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -PostCompactionEffectiveInputTokens 59000 -SessionId s -PostCompactionStepId "2:1"',
    'Write-Output ("AFTER2=" + $np.postCompactionEffectiveInputTokens)',
    'Write-Output ("PSTEP2=" + $np.postCompactionStepId)',
    'Write-Output ("RED2=" + $np.firstCallTokenReduction)',
    // NEW then OLD: OLD cannot overwrite.
    '$st2 = Add-AihContextPostCompactionUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -PostCompactionEffectiveInputTokens 140000 -SessionId s -PostCompactionStepId "1:1"',
    'Write-Output ("STABLE-STEP=" + $st2.postCompactionStepId)',
    'Remove-Item -LiteralPath $ws -Recurse -Force',
  ].join('\n'));
  check(/BOUNDARY=1:1/.test(out5), 'F7-corr: apply boundary is max StepId at apply');
  check(/OLD-THREW=True/.test(out5), 'F7-corr: delayed pre-apply OLD rejected for AFTER');
  check(/PSTEP2=2:1/.test(out5), 'F7-corr: genuine NEW accepted with NEW identity');
  check(/AFTER2=59000/.test(out5), 'F7-corr: AFTER is NEW usage');
  check(/RED2=91000/.test(out5), 'F7-corr: reduction=150000-59000=91000');
  check(/STABLE-STEP=2:1/.test(out5), 'F7-corr: NEW-then-OLD keeps NEW authoritative');
  check(/STEPLESS-THREW=True/.test(out5), 'F7-corr: step-less candidate fails closed');
  check(/XSESS-THREW=True/.test(out5), 'F7-corr: cross-session candidate fails closed');
  // Event-time race: live session produced 1:3 but pressure persisted only
  // through 1:2 when apply captured the boundary. Controller passes the
  // live max; delayed 1:3 must be rejected, genuine 2:1 accepted.
  const out6 = runPs(HDR + '\n' + [
    `$ws = Join-Path ([IO.Path]::GetTempPath()) ("f7race-" + [guid]::NewGuid().ToString("N"))`,
    'New-Item -ItemType Directory -Path $ws | Out-Null',
    `$t = New-AihTask -Workspace $ws -Description 'f7 race' -AcceptanceCriteria @('c1') -Engine 'dual'`,
    '$TID = $t.taskId; $INST = [string]$t.taskInstanceId',
    '[void](Add-AihContextRootUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -EngineRole engineer_normal -Engine dual -UncachedInputTokens 140000 -CacheReadTokens 10000 -OutputTokens 10 -UsageAvailable $true -StepId "1:1" -SessionId s)',
    '[void](Add-AihContextRootUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -EngineRole engineer_normal -Engine dual -UncachedInputTokens 4000 -CacheReadTokens 1000 -OutputTokens 10 -UsageAvailable $true -StepId "1:2" -SessionId s)',
    '$run = Join-Path (Join-Path $ws ".ai-harness/runs") $TID',
    '$ev = [ordered]@{ schemaVersion = 2; attempt = 1; taskInstanceId = $INST; acceptanceCriteria = @([ordered]@{ criterion = "c1"; status = "met"; evidence = "fixture evidence for c1" }); verification = @([ordered]@{ name = "v"; kind = "verify"; status = "PASS"; exitCode = 0; attempt = 1 }); scopePass = $true }',
    'Write-AihAtomicJson (Join-Path $run "evidence.json") $ev',
    '[void](Test-AihTaskCompletion -Workspace $ws -TaskId $TID -TaskInstanceId $INST)',
    '$elig = Test-AihContextCompactionEligibility -Workspace $ws -TaskId $TID -TaskInstanceId $INST',
    '$cp = New-AihContextCheckpoint -Workspace $ws -TaskId $TID -TaskInstanceId $INST',
    '[void](Write-AihContextCompactionTelemetry -Workspace $ws -TaskId $TID -TaskInstanceId $INST -Eligibility $elig -CheckpointPath $cp.path -CheckpointSizeBytes $cp.sizeBytes)',
    '[void](Set-AihContextLifecycleTransition -Workspace $ws -TaskId $TID -TaskInstanceId $INST -To eligible -Reason r)',
    '[void](Set-AihContextLifecycleTransition -Workspace $ws -TaskId $TID -TaskInstanceId $INST -To checkpoint-ready -Reason r -CheckpointPath $cp.path)',
    '$op = New-AihContextCompactionOperation -Workspace $ws -TaskId $TID -TaskInstanceId $INST -SessionId s -ReplacementStart 0 -ReplacementEnd 0 -SourceEventSeqs @(0) -CheckpointPath $cp.path -Segments @([ordered]@{ start = 0; end = 0; sourceEventSeqs = @(0) }) -CompletionBoundarySeq 5',
    '[void](Set-AihContextLifecycleTransition -Workspace $ws -TaskId $TID -TaskInstanceId $INST -To apply-pending -Reason r -SessionId s)',
    '$st = Read-AihContextLifecycleState -Workspace $ws -TaskId $TID; $st.state = "applied"',
    'Write-AihContextLifecycleState -Workspace $ws -TaskId $TID -State $st | Out-Null',
    '[void](Set-AihContextCompactionApplied -Workspace $ws -TaskId $TID -TaskInstanceId $INST -AppliedAtUtc "2026-09-17T17:52:00.000Z" -SessionId s -AppliedAfterStepId "1:3")',
    '$bt6 = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $run "context-compaction-telemetry.json") | ConvertFrom-Json',
    'Write-Output ("RBOUND=" + $bt6.appliedAfterStepId)',
    '[void](Add-AihContextRootUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -EngineRole engineer_normal -Engine dual -UncachedInputTokens 45000 -CacheReadTokens 5000 -OutputTokens 10 -UsageAvailable $true -StepId "1:3" -SessionId s)',
    '$r13 = $false',
    'try { [void](Add-AihContextPostCompactionUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -PostCompactionEffectiveInputTokens 50000 -SessionId s -PostCompactionStepId "1:3") } catch { $r13 = $true }',
    'Write-Output ("R13-REJECTED=" + $r13)',
    '$rnew = Add-AihContextPostCompactionUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -PostCompactionEffectiveInputTokens 60000 -SessionId s -PostCompactionStepId "2:1"',
    'Write-Output ("RNEW-STEP=" + $rnew.postCompactionStepId)',
    '[void](Add-AihContextRootUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -EngineRole engineer_normal -Engine dual -UncachedInputTokens 1000 -CacheReadTokens 100 -OutputTokens 10 -UsageAvailable $true -StepId "2:2" -SessionId s)',
    '[void](Set-AihContextCompactionApplied -Workspace $ws -TaskId $TID -TaskInstanceId $INST -AppliedAtUtc "2026-09-17T18:00:00.000Z" -SessionId s -AppliedAfterStepId "2:2")',
    '$bt6b = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $run "context-compaction-telemetry.json") | ConvertFrom-Json',
    'Write-Output ("RRETRY=" + $bt6b.appliedAfterStepId)',
    'Remove-Item -LiteralPath $ws -Recurse -Force',
  ].join('\n'));
  check(/RBOUND=1:3/.test(out6), 'F7-race: boundary is live max, not pressure');
  check(/R13-REJECTED=True/.test(out6), 'F7-race: delayed unpersisted 1:3 rejected');
  check(/RNEW-STEP=2:1/.test(out6), 'F7-race: genuine 2:1 accepted');
  check(/RRETRY=1:3/.test(out6), 'F7-race: retry preserves original boundary');
  console.log('RESULT: ' + passed + ' F7 telemetry assertions passed.');
}
main();
