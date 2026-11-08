param([Parameter(Mandatory)][string]$ReportPath)

$ErrorActionPreference = 'Stop'
$summary = @("### Nexus DSH harness — $([IO.Path]::GetFileNameWithoutExtension($ReportPath))")
if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) {
    $summary | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding UTF8
    'Harness report unavailable. See the preceding steps for install, test, or timeout errors.' |
        Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding UTF8
    throw 'Expected harness report is missing'
}

$report = Get-Content -Raw -LiteralPath $ReportPath | ConvertFrom-Json
$suites = @($report.suites | Where-Object { $null -ne $_ })
$incomplete = @($suites | Where-Object { $_.result -ne 'PASS' -or $null -eq $_.exitCode -or $_.exitCode -ne 0 })
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
    $report.totalPassed -le 0 -or $report.totalFailed -ne 0) {
    throw 'Harness report contains failures or is incomplete'
}
