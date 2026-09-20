'use strict';
/**
 * ContextCompactionF10ReaderBounds.Tests.cjs - F10 reader resource bounds.
 *
 * REAL persisted context-checkpoint.json + REAL Read-AihContextCheckpoint.
 * Builder and reader share $AihContextCheckpointMaxBytes (65536) and
 * $AihContextCheckpointMaxChangedFiles (200): byte metric is UTF-8
 * serialized bytes == raw file bytes (no BOM, no trailing newline).
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
  const f = path.join(os.tmpdir(), 'f10t-' + Date.now().toString(36) + Math.random().toString(16).slice(2) + '.ps1');
  fs.writeFileSync(f, script);
  return execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8', timeout: 120000 });
}
const HDR = [
  `. '${path.join(repoRoot, 'scripts', 'Common.ps1')}'`,
  `. '${path.join(repoRoot, 'scripts', 'TaskController.ps1')}'`,
  `. '${path.join(repoRoot, 'scripts', 'ContextLifecycle.ps1')}'`,
].join('\n');
function fixture() {
  const out = runPs(HDR + '\n' + [
    `$ws = Join-Path ([IO.Path]::GetTempPath()) ("f10fx-" + [guid]::NewGuid().ToString("N"))`,
    'New-Item -ItemType Directory -Path $ws | Out-Null',
    '& git init -q $ws | Out-Null',
    '& git -C $ws config user.email f10@example.invalid | Out-Null',
    '& git -C $ws config user.name f10 | Out-Null',
    'Set-Content -LiteralPath (Join-Path $ws ".f10base") -Value "b" | Out-Null',
    '& git -C $ws add .f10base | Out-Null',
    '& git -C $ws commit -qm base | Out-Null',
    `$t = New-AihTask -Workspace $ws -Description 'f10' -AcceptanceCriteria @('c1') -Engine 'dual'`,
    '$TID = $t.taskId; $INST = [string]$t.taskInstanceId',
    '[void](Add-AihContextRootUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -EngineRole engineer_normal -Engine dual -UncachedInputTokens 130000 -CacheReadTokens 10000 -OutputTokens 10 -UsageAvailable $true -StepId "1:1" -SessionId s)',
    '$run = Join-Path (Join-Path $ws ".ai-harness/runs") $TID',
    '$ev = [ordered]@{ schemaVersion = 2; attempt = 1; taskInstanceId = $INST; acceptanceCriteria = @([ordered]@{ criterion = "c1"; status = "met"; evidence = "fixture evidence for c1" }); verification = @([ordered]@{ name = "v"; kind = "verify"; status = "PASS"; exitCode = 0; attempt = 1 }); scopePass = $true }',
    'Write-AihAtomicJson (Join-Path $run "evidence.json") $ev',
    '[void](Test-AihTaskCompletion -Workspace $ws -TaskId $TID -TaskInstanceId $INST)',
    '$cp = New-AihContextCheckpoint -Workspace $ws -TaskId $TID -TaskInstanceId $INST -ContinuityUserText "u" -ContinuityAssistantText "a"',
    'Write-Output ("WS=" + $ws)',
    'Write-Output ("TASK=" + $TID)',
    'Write-Output ("INST=" + $INST)',
    'Write-Output ("CP=" + $cp.path)',
    'Write-Output ("SIZE=" + $cp.sizeBytes)',
  ].join('\n'));
  const got = {};
  for (const line of out.trim().split(/\r?\n/)) { const m = /^(WS|TASK|INST|CP|SIZE)=(.*)$/.exec(line); if (m) got[m[1]] = m[2]; }
  return got;
}
function readCase(fx, mutateJs) {
  // mutateJs: PowerShell lines transforming $doc then Write-AihAtomicJson back.
  const script = HDR + '\n' + [
    `$ws = '${fx.WS}'`, `$TID = '${fx.TASK}'`, `$INST = '${fx.INST}'`, `$cpp = '${fx.CP}'`,
    '$doc = Get-Content -Raw -Encoding UTF8 -LiteralPath $cpp | ConvertFrom-Json',
    ...mutateJs,
    '$bytes = (Get-Item -LiteralPath $cpp).Length',
    'Write-Output ("BYTES=" + $bytes)',
    '$threw = $false; $msg = ""',
    'try { $r = Read-AihContextCheckpoint -Workspace $ws -TaskId $TID -ExpectedTaskInstanceId $INST; Write-Output ("ACCEPTED=True") } catch { $threw = $true; $msg = $_.Exception.Message }',
    'Write-Output ("THREW=" + $threw)',
    'Write-Output ("MSG=" + ($msg -replace "`r?`n", " ").Substring(0, [Math]::Min(220, $msg.Length)))',
    'Write-Output ("BODY-ECHOED=" + ($msg.Length -gt 2000))',
  ].join('\n');
  const out = runPs(script);
  const got = {};
  for (const line of out.trim().split(/\r?\n/)) { const m = /^(BYTES|ACCEPTED|THREW|MSG|BODY-ECHOED)=(.*)$/.exec(line); if (m) got[m[1]] = m[2]; }
  return got;
}
const fx = fixture();
check(Number(fx.SIZE) < 65536, 'F10-1: builder-produced checkpoint valid (' + fx.SIZE + ' bytes)');
// 1. normal valid round-trip.
{
  const out = runPs(HDR + '\n' + [
    `$ws = '${fx.WS}'`, `$TID = '${fx.TASK}'`, `$INST = '${fx.INST}'`, `$cpp = '${fx.CP}'`,
    '$r = Read-AihContextCheckpoint -Workspace $ws -TaskId $TID -ExpectedTaskInstanceId $INST',
    'Write-Output ("RT-INST=" + [string]$r.taskInstanceId)',
    'Write-Output ("RT-TEXT=" + ((Get-AihContextCheckpointText -Checkpoint $r).Contains("<nexus-context-checkpoint")))',
  ].join('\n'));
  check(/RT-INST=task_/.test(out), 'F10-1: valid checkpoint restores with identity');
  check(/RT-TEXT=True/.test(out), 'F10-1: valid checkpoint renders');
}
// Size boundaries via padded finalAssistantReport (ASCII) + non-ASCII probe.
function padCase(targetBytes, nonAscii) {
  const padChar = nonAscii ? '\u00e9' : 'x';
  return readCase(fx, [
    `$doc.continuity.finalAssistantReport = ("P-" + ("${padChar}" * ${targetBytes}))`,
    'Write-AihAtomicJson $cpp $doc',
  ]);
}
// Calibrate: find pad length landing exactly at 65535/65536/65537 file bytes.
function fileBytesFor(padLen, nonAscii) {
  const out = runPs(HDR + '\n' + [
    `$cpp = '${fx.CP}'`,
    '$doc = Get-Content -Raw -Encoding UTF8 -LiteralPath $cpp | ConvertFrom-Json',
    nonAscii ? `$doc.continuity.finalAssistantReport = ("P-" + ("\u00e9" * ${padLen}))` : `$doc.continuity.finalAssistantReport = ("P-" + ("x" * ${padLen}))`,
    'Write-AihAtomicJson $cpp $doc',
    'Write-Output ("B=" + (Get-Item -LiteralPath $cpp).Length)',
  ].join('\n'));
  const m = /B=(\d+)/.exec(out);
  return Number(m[1]);
}
const baseBytes = fileBytesFor(0, false);
const need35 = 65535 - baseBytes, need36 = 65536 - baseBytes, need37 = 65537 - baseBytes;
const r35 = readCase(fx, [`$doc.continuity.finalAssistantReport = ("P-" + ("x" * ${need35}))`, 'Write-AihAtomicJson $cpp $doc']);
check(r35.BYTES === '65535' && r35.THREW === 'False', 'F10-2: 65535 bytes accepted (got ' + r35.BYTES + ')');
const r36 = readCase(fx, [`$doc.continuity.finalAssistantReport = ("P-" + ("x" * ${need36}))`, 'Write-AihAtomicJson $cpp $doc']);
check(r36.BYTES === '65536' && r36.THREW === 'False', 'F10-3: exact 65536 allowed (builder uses -gt; got ' + r36.BYTES + ')');
const r37 = readCase(fx, [`$doc.continuity.finalAssistantReport = ("P-" + ("x" * ${need37}))`, 'Write-AihAtomicJson $cpp $doc']);
check(r37.BYTES === '65537' && r37.THREW === 'True', 'F10-4: 65537 rejected');
check(/checkpoint-too-large/.test(r37.MSG), 'F10-4: machine-safe reason, bounded message');
check(r37['BODY-ECHOED'] === 'False', 'F10-4: no checkpoint body echoed');
// Non-ASCII byte semantics: e-acute is 2 bytes in UTF-8; overshoot by chars must still reject.
{
  const padLen = need36; // same char count as the 65536-char case
  const out = runPs(HDR + '\n' + [
    `$cpp = '${fx.CP}'`,
    '$doc = Get-Content -Raw -Encoding UTF8 -LiteralPath $cpp | ConvertFrom-Json',
    `$doc.continuity.finalAssistantReport = ("P-" + ("\u00e9" * ${padLen}))`,
    'Write-AihAtomicJson $cpp $doc',
    'Write-Output ("B=" + (Get-Item -LiteralPath $cpp).Length)',
    '$threw = $false; try { [void](Read-AihContextCheckpoint -Workspace \'' + fx.WS + '\' -TaskId \'' + fx.TASK + '\' -ExpectedTaskInstanceId \'' + fx.INST + '\') } catch { $threw = $true }',
    'Write-Output ("THREW=" + $threw)',
  ].join('\n'));
  const bm = /B=(\d+)/.exec(out);
  check(Number(bm[1]) > 65536 && /THREW=True/.test(out), 'F10-5: non-ASCII bytes (not chars) enforced (file ' + bm[1] + ' bytes)');
}
// 100 KiB+ and 1 MiB early refusal.
{
  const big = readCase(fx, [`$doc.continuity.finalAssistantReport = ("P-" + ("x" * 100000))`, 'Write-AihAtomicJson $cpp $doc']);
  check(Number(big.BYTES) > 65536 && big.THREW === 'True', 'F10-6: 100 KiB+ rejected (' + big.BYTES + ')');
  const mib = runPs(HDR + '\n' + [
    `$cpp = '${fx.CP}'`,
    `$doc = Get-Content -Raw -Encoding UTF8 -LiteralPath $cpp | ConvertFrom-Json`,
    `$doc.continuity.finalAssistantReport = ("P-" + ("x" * 1048576))`,
    'Write-AihAtomicJson $cpp $doc',
    'Write-Output ("B=" + (Get-Item -LiteralPath $cpp).Length)',
    '$before = (Get-Item -LiteralPath $cpp).Length',
    '$threw = $false; try { [void](Read-AihContextCheckpoint -Workspace \'' + fx.WS + '\' -TaskId \'' + fx.TASK + '\' -ExpectedTaskInstanceId \'' + fx.INST + '\') } catch { $threw = $true }',
    'Write-Output ("THREW=" + $threw)',
    'Write-Output ("UNCHANGED=" + ((Get-Item -LiteralPath $cpp).Length -eq $before))',
  ].join('\n'));
  check(/THREW=True/.test(mib), 'F10-7: 1 MiB rejected without render/apply');
  check(/UNCHANGED=True/.test(mib), 'F10-7: oversized artifact not truncated/rewritten');
}
// changedFiles 199/200/201 + malformed.
function filesCase(n) {
  return readCase(fx, [
    '$files = @(); for ($i = 0; $i -lt ' + n + '; $i++) { $files += [ordered]@{ path = ("src/f" + $i + ".ts"); status = "modified"; staged = $false; unstaged = $true } }',
    '$doc.repositoryState.changedFiles = @($files)',
    '$doc.continuity.finalAssistantReport = "short"',
    'Write-AihAtomicJson $cpp $doc',
  ]);
}
const f199 = filesCase(199);
check(f199.THREW === 'False', 'F10-8: 199 changedFiles accepted');
const f200 = filesCase(200);
check(f200.THREW === 'False', 'F10-8: 200 changedFiles accepted');
const f201 = filesCase(201);
check(f201.THREW === 'True', 'F10-8: 201 changedFiles rejected');
check(/too-many-changed-files/.test(f201.MSG), 'F10-8: machine-safe count reason');
{
  const badShape = readCase(fx, ['$doc.repositoryState.changedFiles = "not-an-array"', '$doc.continuity.finalAssistantReport = "short"', 'Write-AihAtomicJson $cpp $doc']);
  check(badShape.THREW === 'True', 'F10-9: non-array changedFiles rejected (schema intact)');
  const badEntry = readCase(fx, ['$doc.repositoryState.changedFiles = @([ordered]@{ path = 12345; status = "modified" })', '$doc.continuity.finalAssistantReport = "short"', 'Write-AihAtomicJson $cpp $doc']);
  check(badEntry.THREW === 'False', 'F10-9: odd-but-tolerated entry shape still renders (no over-validation)');
}
// Fail-closed lifecycle: rejected checkpoint yields no applyable continuation.
{
  const out = runPs(HDR + '\n' + [
    `$ws = '${fx.WS}'`, `$TID = '${fx.TASK}'`, `$INST = '${fx.INST}'`, `$cpp = '${fx.CP}'`,
    '$doc = Get-Content -Raw -Encoding UTF8 -LiteralPath $cpp | ConvertFrom-Json',
    '$doc.continuity.finalAssistantReport = ("P-" + ("x" * 90000))',
    'Write-AihAtomicJson $cpp $doc',
    '$threw = $false; try { [void](Read-AihContextCheckpoint -Workspace $ws -TaskId $TID -ExpectedTaskInstanceId $INST) } catch { $threw = $true }',
    'Write-Output ("GATED=" + $threw)',
    '$snap = Get-AihContextLifecycleSnapshot -Workspace $ws -TaskId $TID -TaskInstanceId $INST',
    'Write-Output ("STATE=" + [string]$snap.state)',
  ].join('\n'));
  check(/GATED=True/.test(out), 'F10-10: invalid checkpoint gated at reader');
}
// Parity: builder-produced max-size checkpoint round-trips; an externally
// padded same-shape artifact is rejected for the same bound reason.
{
  const out = runPs(HDR + '\n' + [
    `$ws = '${fx.WS}'`, `$TID = '${fx.TASK}'`, `$INST = '${fx.INST}'`,
    '$probe = "z" * 60000',
    '$cp2 = New-AihContextCheckpoint -Workspace $ws -TaskId $TID -TaskInstanceId $INST -ContinuityUserText "u" -ContinuityAssistantText $probe',
    'Write-Output ("PSIZE=" + $cp2.sizeBytes)',
    '$rt = Read-AihContextCheckpoint -Workspace $ws -TaskId $TID -ExpectedTaskInstanceId $INST',
    'Write-Output ("ROUNDTRIP=" + ($null -ne $rt))',
    '$raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $cp2.path | ConvertFrom-Json',
    '$raw.continuity.finalAssistantReport = ("Q-" + ("x" * 70000))',
    'Write-AihAtomicJson $cp2.path $raw',
    '$threw = $false; try { [void](Read-AihContextCheckpoint -Workspace $ws -TaskId $TID -ExpectedTaskInstanceId $INST) } catch { $threw = $true }',
    'Write-Output ("PADDED-REJECTED=" + $threw)',
  ].join('\n'));
  check(/ROUNDTRIP=True/.test(out), 'F10-parity: builder-accepted checkpoint is reader-accepted');
  check(/PADDED-REJECTED=True/.test(out), 'F10-parity: externally oversized same-shape artifact rejected');
}
console.log('RESULT: ' + passed + ' F10 reader-bounds assertions passed.');
