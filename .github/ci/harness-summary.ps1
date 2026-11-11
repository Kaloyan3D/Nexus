param(
    [Parameter(Mandatory)][string]$ReportPath,
    [ValidateSet('production', 'ccv2-lab')][string]$Lane = 'production',
    [ValidateSet('full', 'general', 'boundary')][string]$ProductionShard = 'full'
)

$ErrorActionPreference = 'Stop'
$summary = @("### Nexus DSH harness — $([IO.Path]::GetFileNameWithoutExtension($ReportPath))")
if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) {
    $summary | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding UTF8
    'Harness report unavailable. See the preceding steps for install, test, or timeout errors.' |
        Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding UTF8
    throw 'Expected harness report is missing'
}

$inventoryJson = & node (Join-Path $PSScriptRoot 'harness-inventory.cjs') $Lane $ProductionShard
if ($LASTEXITCODE -ne 0) { throw 'Could not read the required suite inventory' }
$inventory = @($inventoryJson | ConvertFrom-Json)
$rawPath = [IO.Path]::ChangeExtension([IO.Path]::GetFullPath($ReportPath), '.log')
if (-not (Test-Path -LiteralPath $rawPath -PathType Leaf)) { throw 'Required raw harness log is missing' }
$rawLines = @(Get-Content -LiteralPath $rawPath -Encoding UTF8)
$report = Get-Content -Raw -LiteralPath $ReportPath | ConvertFrom-Json
$suites = @($report.suites | Where-Object { $null -ne $_ })
$incomplete = @($suites | Where-Object {
    $_.result -cne 'PASS' -or $null -eq $_.exitCode -or $_.exitCode -ne 0 -or
    $null -eq $_.failed -or $_.failed -ne 0 -or $_.completionVerified -ne $true -or
    @($_.skipEvidence | Where-Object { $_ }).Count -ne 0 -or
    -not $_.command -or -not $_.startedAtUtc -or -not $_.finishedAtUtc -or
    $null -eq $_.durationMs -or $_.durationMs -lt 0
})
$summary += @(
    ''
    "Suites completed successfully: $($suites.Count - $incomplete.Count)/$($report.suiteCount)"
    "Reported assertions: $($report.totalPassed) passed, $($report.totalFailed) failed"
)
foreach ($suite in $incomplete) {
    $summary += "- $($suite.name) ($($suite.result))"
}
$summary | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding UTF8
if ($report.schemaVersion -ne 1 -or $report.result -ne 'PASS' -or $null -eq $report.exitCode -or $report.exitCode -ne 0 -or
    $suites.Count -eq 0 -or $suites.Count -ne $report.suiteCount -or $incomplete.Count -ne 0 -or
    $null -eq $report.totalFailed -or $report.totalFailed -ne 0 -or
    $report.statusCounts.PASS -ne $suites.Count -or
    @('FAIL','SKIP','NOT_RUN','INCOMPLETE').Where({ $null -eq $report.statusCounts.$_ -or $report.statusCounts.$_ -ne 0 }).Count -ne 0 -or
    $inventory.Count -ne $suites.Count) {
    throw 'Harness report contains failures or is incomplete'
}

$rawVerdicts = @($rawLines -cmatch '^===== RESULT ')
if ($rawVerdicts.Count -ne $inventory.Count) { throw 'Raw harness log has an incomplete suite inventory' }
for ($i = 0; $i -lt $inventory.Count; $i++) {
    $expected = $inventory[$i]
    if ($suites[$i].name -cne $expected.name -or $suites[$i].script -cne $expected.script) {
        throw "Harness suite inventory mismatch at row $($i + 1)"
    }
    if ($rawVerdicts[$i] -cne ('===== RESULT {0}: PASS (exit 0) =====' -f $expected.name)) {
        throw "Raw harness verdict mismatch: $($expected.name)"
    }
    if ($expected.completionMarker -and @($rawLines -ceq $expected.completionMarker).Count -ne 1) {
        throw "Required execution proof missing or duplicated: $($expected.name)"
    }
}
$cleanLines = @($rawLines | ForEach-Object { ($_ -replace '\x1b\[[0-?]*[ -/]*[@-~]', '').Trim() })
if ($cleanLines -match '^(?:(?:SKIP(?:PED)?|FAIL):|(?:SUITE RESULT|RESULT):.*\bFAIL [1-9][0-9]*\b)') {
    throw 'Raw harness log contains explicit skip or failure evidence'
}
