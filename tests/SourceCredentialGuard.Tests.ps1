[CmdletBinding()]param([string]$InstallRoot)
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'tests/TestHelpers.ps1')
$passed = 0
function Assert-Aih([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "FAIL: $Name" }
    $script:passed++
    Write-Host "PASS: $Name"
}
# Generate synthetic credentials at runtime: the source guard still scans tests.
$key = 'sk-' + 'abcdefghijklmnopqrstuvwx'
foreach ($text in @($key, "'$key'", ('"' + $key + '"'), "TOKEN=$key", "Bearer $key", "($key)", "prefix $key suffix", "label-$key")) {
    Assert-Aih (Test-AihSourceCredentialValue $text) 'standalone synthetic credential is detected'
}
Assert-Aih (Test-AihSourceCredentialValue ('DEEPSEEK_API_KEY: ' + 'synthetic-value')) 'existing unquoted named credential detection is retained'
foreach ($text in @('task-instance-mismatch', 'task-identity-unproven', 'mask-abcdefghijklmnopqrstuvwx')) {
    Assert-Aih (-not (Test-AihSourceCredentialValue $text)) 'ordinary identifier suffix is not a standalone credential'
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('aih-source-guard-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path (Join-Path $fixture 'tests'), (Join-Path $fixture 'src'), (Join-Path $fixture 'data') -Force | Out-Null
    foreach ($relative in @('tests/key.ps1', 'src/key.ps1', 'data/key.ps1')) {
        [IO.File]::WriteAllText((Join-Path $fixture $relative), ('TOKEN=' + $key))
    }
    $leaks = @(Get-AihSourceScanFiles -Root $fixture | Where-Object { Test-AihSourceCredentialValue (Get-Content -Raw -LiteralPath $_.FullName) })
    Assert-Aih ($leaks.Count -eq 2) 'credentials in production and test source are detected; runtime data remains excluded'
    Assert-Aih (@($leaks | Where-Object { $_.Directory.Name -eq 'tests' }).Count -eq 1) 'test source is not exempted from credential detection'
} finally { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host "Source credential guard acceptance: $passed assertions passed."
