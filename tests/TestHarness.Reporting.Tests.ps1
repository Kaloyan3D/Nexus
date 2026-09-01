[CmdletBinding()]param([string]$InstallRoot)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot=Split-Path -Parent $PSScriptRoot }
. (Join-Path $InstallRoot 'scripts\Common.ps1')
. (Join-Path $InstallRoot 'scripts\TestHarness.Reporting.ps1')
$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not$Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}
$root=Join-Path ([IO.Path]::GetTempPath()) ('aih-harness-report-'+[guid]::NewGuid().ToString('N'))
try {
 New-Item -ItemType Directory -Path $root|Out-Null
 $start=[DateTime]::Parse('2026-09-01T10:00:00Z').ToUniversalTime();$finish=$start.AddMilliseconds(1250)
 $suites=@(
  [ordered]@{name='one';command='one';script='tests/one.ps1';startedAtUtc=$start.ToString('o');finishedAtUtc=$finish.ToString('o');durationMs=1250;exitCode=0;passed=3;failed=0;result='PASS'},
  [ordered]@{name='two';command='two';script='tests/two.ps1';startedAtUtc=$start.ToString('o');finishedAtUtc=$finish.ToString('o');durationMs=1250;exitCode=1;passed=2;failed=1;result='FAIL'}
 )
 $report=New-AihHarnessReport -StartedAtUtc $start -FinishedAtUtc $finish -ExitCode 1 -Suites $suites
 Assert-Aih ($report.schemaVersion-eq1-and$report.result-eq'FAIL'-and$report.exitCode-eq1) 'report records schema, result, and process outcome'
 Assert-Aih ($report.totalPassed-eq5-and$report.totalFailed-eq1-and$report.suiteCount-eq2) 'report aggregates assertion totals and suite count'
 Assert-Aih ($report.durationMs-eq1250-and$report.suites[0].durationMs-eq1250) 'report records harness and suite durations'
 Assert-Aih ((Get-AihHarnessAssertionCount @('PASS: a','noise','PASS: b') 'PASS:')-eq2) 'PASS aggregation uses explicit assertion lines'
 $path=Join-Path $root 'alternate\result.json';$written=Write-AihHarnessArtifacts -ReportPath $path -Report $report -RawLog "owned log`n"
 Assert-Aih (Test-Path -LiteralPath $written.reportPath) 'report writes to an explicitly supplied alternate location'
 Assert-Aih (Test-Path -LiteralPath $written.rawLogPath) 'raw textual log is stored next to the report'
 $roundTrip=Get-Content -Raw -Encoding UTF8 -LiteralPath $written.reportPath|ConvertFrom-Json
 Assert-Aih ($roundTrip.exitCode-eq1-and$roundTrip.totalPassed-eq5-and@($roundTrip.suites).Count-eq2) 'machine-readable report round-trips with exit, totals, and suites'
 Assert-Aih ([string]$roundTrip.rawLogPath-eq[string]$written.rawLogPath) 'structured report links its durable raw log'
 $failureWasExplicit=$false;try{Write-AihHarnessArtifacts -ReportPath $root -Report $report -RawLog 'x'|Out-Null}catch{$failureWasExplicit=$true}
 Assert-Aih $failureWasExplicit 'an invalid report target fails explicitly'
}finally{if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}}
Write-Host "RESULT: $passed structured harness-report assertions passed."
