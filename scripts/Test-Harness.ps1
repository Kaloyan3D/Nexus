[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$ReportPath
)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $InstallRoot 'scripts\Common.ps1')
. (Join-Path $InstallRoot 'scripts\TestHarness.Reporting.ps1')

$layout = Get-AihLayout $InstallRoot
$powershell = 'powershell.exe'
$suites = @(
    [ordered]@{ name='SetupUpgrade'; script='tests\SetupUpgrade.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Harness'; script='tests\Harness.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='TestHarness.Reporting'; script='tests\TestHarness.Reporting.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='JsonSerialization'; script='tests\JsonSerialization.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='EpistemicPolicy'; script='tests\EpistemicPolicy.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='ControllerRouting'; script='tests\ControllerRouting.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='TaskIdentity'; script='tests\TaskIdentity.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='EngineeringProfiles'; script='tests\EngineeringProfiles.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='EngineeringProfileEditor'; script='tests\EngineeringProfileEditor.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.Registry'; script='tests\Intelligence.Registry.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.Scanning'; script='tests\Intelligence.Scanning.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.Snapshots'; script='tests\Intelligence.Snapshots.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.EndToEnd'; script='tests\Intelligence.EndToEnd.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.IgnoreRegression'; script='tests\Intelligence.IgnoreRegression.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.SnapshotModules'; script='tests\Intelligence.SnapshotModules.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.CodeFoundation'; script='tests\Intelligence.CodeFoundation.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.CodeParsing'; script='tests\Intelligence.CodeParsing.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.CodeIntelligence'; script='tests\Intelligence.CodeIntelligence.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='Intelligence.CodeScale'; script='tests\Intelligence.CodeScale.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='AihController'; script='tests\AihController.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='AihControllerIdentity'; script='tests\AihControllerIdentity.Tests.cjs'; executable=$layout.Node; kind='node' }
)

$started = [DateTime]::UtcNow
$suiteResults = [Collections.Generic.List[object]]::new()
$rawLines = [Collections.Generic.List[string]]::new()
$harnessExitCode = 0
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
    if ($suiteExitCode -ne 0) { $harnessExitCode = $suiteExitCode; break }
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
