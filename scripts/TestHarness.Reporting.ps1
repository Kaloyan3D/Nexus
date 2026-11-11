Set-StrictMode -Version Latest

function Get-AihHarnessAssertionCount {
    param([string[]]$Lines, [string]$Prefix)
    if ($null -eq $Lines) { return 0 }
    return @($Lines | Where-Object { [string]$_ -match ('^' + [regex]::Escape($Prefix)) }).Count
}

function Get-AihHarnessSuiteOutcome {
    param([string[]]$Lines, [Nullable[int]]$ExitCode, [string]$CompletionMarker)

    $clean = @($Lines | ForEach-Object { ([string]$_ -replace '\x1b\[[0-?]*[ -/]*[@-~]', '').Trim() })
    $passed = Get-AihHarnessAssertionCount -Lines $clean -Prefix 'PASS:'
    $failed = Get-AihHarnessAssertionCount -Lines $clean -Prefix 'FAIL:'
    if ($clean -match '^(?:SUITE RESULT|RESULT):.*\bFAIL [1-9][0-9]*\b') { $failed = [Math]::Max(1, $failed) }
    $skips = @($clean -match '^SKIP(?:PED)?:')
    $completionVerified = -not $CompletionMarker -or @($clean -ceq $CompletionMarker).Count -eq 1

    $status = if ($failed -gt 0 -or ($null -ne $ExitCode -and $ExitCode -ne 0)) {
        $failed = [Math]::Max(1, $failed)
        'FAIL'
    } elseif ($null -eq $ExitCode) {
        'INCOMPLETE'
    } elseif ($skips.Count -gt 0) {
        'SKIP'
    } elseif (-not $completionVerified) {
        'INCOMPLETE'
    } else {
        'PASS'
    }
    return @{ result=$status; passed=$passed; failed=$failed; skipEvidence=$skips; completionVerified=$completionVerified }
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
    $statuses = [ordered]@{ PASS=0; FAIL=0; SKIP=0; NOT_RUN=0; INCOMPLETE=0 }
    foreach ($suite in $Suites) { $statuses[$suite.result]++ }
    return [ordered]@{
        schemaVersion = 1
        statusCounts = $statuses
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
