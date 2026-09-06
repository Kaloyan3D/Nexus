Set-StrictMode -Version Latest

function Get-AihHarnessAssertionCount {
    param([string[]]$Lines, [string]$Prefix)
    if ($null -eq $Lines) { return 0 }
    return @($Lines | Where-Object { [string]$_ -match ('^' + [regex]::Escape($Prefix)) }).Count
}

function New-AihHarnessReport {
    param(
        [Parameter(Mandatory=$true)][DateTime]$StartedAtUtc,
        [Parameter(Mandatory=$true)][DateTime]$FinishedAtUtc,
        [Parameter(Mandatory=$true)][int]$ExitCode,
        [Parameter(Mandatory=$true)][object[]]$Suites,
        [string]$RawLogPath
    )
    $passed = 0
    $failed = 0
    foreach ($suite in @($Suites)) {
        if ($null -ne $suite.passed) { $passed += [int]$suite.passed }
        if ($null -ne $suite.failed) { $failed += [int]$suite.failed }
    }
    return [ordered]@{
        schemaVersion = 1
        startedAtUtc = $StartedAtUtc.ToString('o')
        finishedAtUtc = $FinishedAtUtc.ToString('o')
        durationMs = [Math]::Max(0, [int64]($FinishedAtUtc - $StartedAtUtc).TotalMilliseconds)
        result = if ($ExitCode -eq 0) { 'PASS' } else { 'FAIL' }
        exitCode = $ExitCode
        totalPassed = $passed
        totalFailed = $failed
        suiteCount = @($Suites).Count
        rawLogPath = if ([string]::IsNullOrWhiteSpace($RawLogPath)) { $null } else { [IO.Path]::GetFullPath($RawLogPath) }
        suites = @($Suites)
    }
}

function Write-AihHarnessArtifacts {
    param(
        [Parameter(Mandatory=$true)][string]$ReportPath,
        [Parameter(Mandatory=$true)]$Report,
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$RawLog
    )
    $fullReportPath = [IO.Path]::GetFullPath($ReportPath)
    if (Test-Path -LiteralPath $fullReportPath -PathType Container) { throw "Harness report path names a directory, not a file: $fullReportPath" }
    $rawLogPath = [IO.Path]::ChangeExtension($fullReportPath, '.log')
    $Report.rawLogPath = $rawLogPath
    Write-AihAtomicText -Path $rawLogPath -Content $RawLog
    Write-AihAtomicJson -Path $fullReportPath -Value $Report -Depth 30
    return [pscustomobject]@{ reportPath = $fullReportPath; rawLogPath = $rawLogPath }
}
