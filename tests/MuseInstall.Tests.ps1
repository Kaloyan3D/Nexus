[CmdletBinding()]
param([string]$InstallRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $InstallRoot 'scripts/Common.ps1')
$layout = Get-AihLayout $InstallRoot
$probeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('aih-muse-install-' + [System.Guid]::NewGuid().ToString('N'))
$target = Join-Path $probeRoot 'aih-muse'
$passed = 0
function Pass([string]$Name) { $script:passed++; Write-Host ('PASS: ' + $Name) }
function Snapshot-Hashes([string]$Root) {
    return (@(Get-ChildItem -LiteralPath $Root -File | Sort-Object Name | ForEach-Object {
        $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }) -join "`n")
}

try {
    & (Join-Path $InstallRoot 'scripts/Install-MusePreset.ps1') -InstallRoot $InstallRoot -TargetPresetPath $target
    if ($LASTEXITCODE -ne 0) { throw 'FAIL: first staged install failed.' }
    Pass 'fresh Muse preset install publishes a complete validated directory'

    & $layout.Node (Join-Path $InstallRoot 'scripts/Validate-MusePreset.cjs') $InstallRoot $target | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'FAIL: installed preset did not parse in the DSH YAML dialect.' }
    Pass 'generated Muse YAML parses with the installed DSH !!js schema and required/forbidden row checks'

    if (Test-Path -LiteralPath (Join-Path $target 'Muse-ContributorProtection.cjs')) {
        throw 'FAIL: obsolete Contributor Protection module remains in the Muse preset.'
    }
    Pass 'generated Muse preset contains no Contributor Protection module'

    $composition = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $target 'agent.cordis.yml')
    if (-not $composition.Contains('text: !!js >-')) { throw 'FAIL: Muse persona is not encoded as a YAML block scalar.' }
    Pass 'Muse persona uses a robust folded YAML scalar'

    $first = Snapshot-Hashes $target
    & (Join-Path $InstallRoot 'scripts/Install-MusePreset.ps1') -InstallRoot $InstallRoot -TargetPresetPath $target
    if ($LASTEXITCODE -ne 0) { throw 'FAIL: repeated staged install failed.' }
    $second = Snapshot-Hashes $target
    if ($first -ne $second) { throw 'FAIL: repeated Muse install changed managed bytes.' }
    Pass 'repeated Muse install is byte-idempotent'

    [System.IO.File]::AppendAllText((Join-Path $target 'AihController.cjs'), "`n// stale mixed-version probe`n")
    & (Join-Path $InstallRoot 'scripts/Install-MusePreset.ps1') -InstallRoot $InstallRoot -TargetPresetPath $target
    if ($LASTEXITCODE -ne 0) { throw 'FAIL: stale-runtime repair install failed.' }
    if ((Get-FileHash (Join-Path $target 'AihController.cjs') -Algorithm SHA256).Hash -ne (Get-FileHash (Join-Path $InstallRoot 'config/AihController.cjs') -Algorithm SHA256).Hash) {
        throw 'FAIL: stale runtime controller survived canonical install.'
    }
    Pass 'canonical install removes stale mixed-version runtime bytes'
}
finally {
    if (Test-Path -LiteralPath $probeRoot) { Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ('SUITE RESULT: PASS ' + $passed + ' | FAIL 0 | total ' + $passed)
