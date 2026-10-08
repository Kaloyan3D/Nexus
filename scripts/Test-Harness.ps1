[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$ReportPath,
    # TASK-0024 audit mode: run EVERY suite even after failures, then exit
    # non-zero if any suite failed. Default behavior stays fail-fast.
    [switch]$ContinueOnFailure,
    # TASK-0024 test-only lane override: run the PowerShell suites under an
    # explicit host executable (e.g. the PowerShell 7 lane on Windows).
    # Production resolution (Get-AihPowerShellHost: powershell.exe on Windows,
    # pinned pwsh on POSIX) is untouched when this is omitted.
    [string]$PowerShellExecutable
)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/TestHarness.Reporting.ps1')

$layout = Get-AihLayout $InstallRoot
# Platform-aware PowerShell host: Windows keeps powershell.exe; POSIX uses the
# setup.sh-pinned runtime/pwsh/pwsh (with the same fallback chain as
# Get-AihPowerShellHost).
$powershell = Get-AihPowerShellHost $InstallRoot
if (-not [string]::IsNullOrWhiteSpace($PowerShellExecutable)) {
    if (-not (Test-Path -LiteralPath $PowerShellExecutable -PathType Leaf)) {
        throw "PowerShell executable override not found: $PowerShellExecutable"
    }
    $powershell = [System.IO.Path]::GetFullPath($PowerShellExecutable)
}
$suites = @(
    [ordered]@{ name='SetupUpgrade'; script='tests/SetupUpgrade.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='UpdateRootResolution'; script='tests/UpdateRootResolution.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='SourceCredentialGuard'; script='tests/SourceCredentialGuard.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Harness'; script='tests/Harness.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='TestHarness.Reporting'; script='tests/TestHarness.Reporting.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='JsonSerialization'; script='tests/JsonSerialization.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='EpistemicPolicy'; script='tests/EpistemicPolicy.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='EngineeringTelemetry'; script='tests/EngineeringTelemetry.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='ContextCompaction'; script='tests/ContextCompaction.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='ControllerRouting'; script='tests/ControllerRouting.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='TaskIdentity'; script='tests/TaskIdentity.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='EngineeringProfiles'; script='tests/EngineeringProfiles.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='EngineeringProfileEditor'; script='tests/EngineeringProfileEditor.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='NexusProfiles'; script='tests/NexusProfiles.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='MuseProvider'; script='tests/MuseProvider.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='MuseAgentPlane'; script='tests/MuseAgentPlane.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='MuseInstall'; script='tests/MuseInstall.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='VisualReview'; script='tests/VisualReview.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='VisualLoop'; script='tests/VisualLoop.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='NexusWorkspace'; script='tests/NexusWorkspace.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.Concurrency'; script='tests/Intelligence.Concurrency.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='NexusSkills'; script='tests/NexusSkills.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.Registry'; script='tests/Intelligence.Registry.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.Scanning'; script='tests/Intelligence.Scanning.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.Snapshots'; script='tests/Intelligence.Snapshots.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.EndToEnd'; script='tests/Intelligence.EndToEnd.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.IgnoreRegression'; script='tests/Intelligence.IgnoreRegression.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.SnapshotModules'; script='tests/Intelligence.SnapshotModules.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.CodeFoundation'; script='tests/Intelligence.CodeFoundation.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.CodeParsing'; script='tests/Intelligence.CodeParsing.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.CodeIntelligence'; script='tests/Intelligence.CodeIntelligence.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.CodeScale'; script='tests/Intelligence.CodeScale.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='AihController'; script='tests/AihController.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='VisualControllerLifecycle'; script='tests/VisualControllerLifecycle.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='VisualReviewBridge'; script='tests/VisualReviewBridge.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='VisualStructuredOutput'; script='tests/VisualStructuredOutput.Tests.mjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='NexusSkillsRuntime'; script='tests/NexusSkills.Runtime.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='NexusProfilesRuntime'; script='tests/NexusProfiles.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='MuseProviderRuntime'; script='tests/MuseProvider.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='MuseReasoningGovernor'; script='tests/MuseReasoningGovernor.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='MuseReasoningRuntime'; script='tests/MuseReasoningRuntime.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='MuseReasoningSignals'; script='tests/MuseReasoningSignals.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='MuseReasoningActivity'; script='tests/MuseReasoningActivity.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='MuseIsolation'; script='tests/MuseIsolation.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='ContextCompactionBridge'; script='tests/ContextCompactionBridge.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='ContextCompactionAcceptance'; script='tests/ContextCompactionAcceptance.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='ContextCompactionCrash'; script='tests/ContextCompactionCrash.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='ContextCompactionF1Loop'; script='tests/ContextCompactionF1Loop.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='ContextCompactionF2Prod'; script='tests/ContextCompactionF2Prod.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='ContextCompactionF5Prod'; script='tests/ContextCompactionF5Prod.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='ContextCompactionXProc'; script='tests/ContextCompactionXProc.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='ContextCompactionF1Loop'; script='tests/ContextCompactionF1Loop.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='ContextCompactionPartial'; script='tests/ContextCompactionPartial.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='ContextCompactionF5Slow'; script='tests/ContextCompactionF5Slow.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='MuseEgressCleanup'; script='tests/MuseEgressCleanup.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='NexusEngineContract'; script='tests/NexusEngineContract.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='EpistemicProductionHardening'; script='tests/EpistemicProductionHardening.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='AihControllerIdentity'; script='tests/AihControllerIdentity.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='NexusControllerPanel'; script='tests/NexusControllerPanel.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='PlatformSupport'; script='tests/PlatformSupport.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='StartupProviderIsolation'; script='tests/StartupProviderIsolation.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='PowerShellPortability'; script='tests/PowerShellPortability.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='AihControllerHost'; script='tests/AihControllerHost.Tests.cjs'; executable=$layout.Node; kind='node' }
)

$started = [DateTime]::UtcNow
$suiteResults = [Collections.Generic.List[object]]::new()
$rawLines = [Collections.Generic.List[string]]::new()
$harnessExitCode = 0
# TASK-0026: every suite child (PowerShell and Node) inherits the TOOLCHAIN
# anchor - the tree that owns runtime/ - so fixture-scoped scenarios whose
# logical InstallRoot carries no runtime still resolve the real pinned Node
# and PowerShell runtimes. Process-scoped; never persisted, never a shell
# profile change, and the pre-existing PATH stays behind the pinned prefix.
$env:AIH_TOOLCHAIN_ROOT = $InstallRoot
foreach ($suite in $suites) {
    $suiteStarted = [DateTime]::UtcNow
    $scriptPath = Join-Path $InstallRoot $suite.script
    # Materialize the property before call-operator use. In Windows
    # PowerShell, `& $suite.executable` is parsed as invoking `$suite` with a
    # member-like argument and can truncate a drive-qualified path to `C`.
    $executable = [string]$suite.executable
    $arguments = if ($suite.kind -eq 'powershell') { @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$scriptPath,'-InstallRoot',$InstallRoot) } else { @($scriptPath) }
    # An if-expression unwraps a one-item array in Windows PowerShell 5.1.
    # Re-wrap it before splatting or the Node script path is enumerated into
    # characters and Node receives only the drive letter (`C`) as argv[1].
    $arguments = @($arguments)
    $commandText = '"' + $executable + '" ' + (($arguments | ForEach-Object { '"' + ([string]$_).Replace('"','\"') + '"' }) -join ' ')
    $rawLines.Add(('===== SUITE {0} =====' -f $suite.name)); $rawLines.Add($commandText)
    Write-Host ('===== SUITE {0} =====' -f $suite.name)
    $savedPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $output = @(& $executable @arguments 2>&1 | ForEach-Object { [string]$_ }); $suiteExitCode = [int]$LASTEXITCODE }
    catch { $output = @([string]$_); $suiteExitCode = 1 }
    finally { $ErrorActionPreference = $savedPreference }
    foreach ($line in $output) { Write-Host $line; $rawLines.Add($line) }
    $suiteFinished = [DateTime]::UtcNow
    $suitePassed = Get-AihHarnessAssertionCount -Lines $output -Prefix 'PASS:'
    $explicitFailed = Get-AihHarnessAssertionCount -Lines $output -Prefix 'FAIL:'
    $suiteFailed = if ($suiteExitCode -eq 0) { $explicitFailed } else { [Math]::Max(1, $explicitFailed) }
    $suiteResults.Add([ordered]@{name=$suite.name;command=$commandText;script=$suite.script.Replace('\','/');startedAtUtc=$suiteStarted.ToString('o');finishedAtUtc=$suiteFinished.ToString('o');durationMs=[Math]::Max(0,[int64]($suiteFinished-$suiteStarted).TotalMilliseconds);exitCode=$suiteExitCode;passed=$suitePassed;failed=$suiteFailed;result=if($suiteExitCode-eq 0){'PASS'}else{'FAIL'}})
    $rawLines.Add(('===== RESULT {0}: {1} (exit {2}) =====' -f $suite.name, $(if ($suiteExitCode -eq 0) { 'PASS' } else { 'FAIL' }), $suiteExitCode))
    if ($suiteExitCode -ne 0) {
        if ($harnessExitCode -eq 0) { $harnessExitCode = $suiteExitCode }
        if (-not $ContinueOnFailure) { break }
    }
}

if ($ContinueOnFailure) {
    $failedSuites = @($suiteResults | Where-Object { $_.result -eq 'FAIL' })
    if ($failedSuites.Count -gt 0) {
        Write-Host ('AUDIT FAILURES ({0}): {1}' -f $failedSuites.Count, (($failedSuites | ForEach-Object { '{0} (exit={1})' -f $_.name, $_.exitCode }) -join ', '))
    } else {
        Write-Host 'AUDIT FAILURES: none (all suites ran to completion)'
    }
}

if ($suiteResults.Count -lt $suites.Count) {
    foreach ($suite in $suites[$suiteResults.Count..($suites.Count-1)]) {
        $suiteResults.Add([ordered]@{name=$suite.name;command=$null;script=$suite.script.Replace('\','/');startedAtUtc=$null;finishedAtUtc=$null;durationMs=$null;exitCode=$null;passed=$null;failed=$null;result='NOT_RUN'})
    }
}
$finished = [DateTime]::UtcNow
$rawLogPath = if ([string]::IsNullOrWhiteSpace($ReportPath)) { $null } else { [IO.Path]::ChangeExtension([IO.Path]::GetFullPath($ReportPath), '.log') }
$report = New-AihHarnessReport -StartedAtUtc $started -FinishedAtUtc $finished -ExitCode $harnessExitCode -Suites @($suiteResults) -RawLogPath $rawLogPath
if (-not [string]::IsNullOrWhiteSpace($ReportPath)) {
    try {
        $artifacts = Write-AihHarnessArtifacts -ReportPath $ReportPath -Report $report -RawLog (($rawLines -join [Environment]::NewLine)+[Environment]::NewLine)
        Write-Host ('HARNESS REPORT: '+$artifacts.reportPath); Write-Host ('HARNESS RAW LOG: '+$artifacts.rawLogPath)
    } catch { Write-Error ('Requested harness report could not be produced: '+$_.Exception.Message); if($harnessExitCode-eq 0){$harnessExitCode=1} }
}
Write-Host ('HARNESS RESULT: {0} | PASS {1} | FAIL {2} | suites {3} | {4} ms' -f $(if($harnessExitCode-eq 0){'PASS'}else{'FAIL'}),$report.totalPassed,$report.totalFailed,$report.suiteCount,$report.durationMs)
exit $harnessExitCode
