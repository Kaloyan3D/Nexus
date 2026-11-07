[CmdletBinding()]
param([string]$InstallRoot)

# MuseInstall.Tests.ps1 — installation of the Nexus agent planes on DSH 0.2.x.
#
# The 0.1.x suite exercised Install-MusePreset.ps1, which staged
# `.agent-presets/aih-muse/agent.cordis.yml`; DSH 0.2.x no longer scans that
# directory. The same guarantees are asserted for Install-NexusPresets.ps1 on
# a DISPOSABLE install root (never the real one): the app/runtime trees are
# linked, everything Nexus writes lands in the disposable data directory.
#   - a fresh install publishes complete closures and a home patch that the
#     REAL composed DSH profile accepts (every plane mounts, no stock preset)
#   - the Muse plane has the required rows and no forbidden delegation/review surface
#   - a plane whose local module cannot load is rejected by the real composition
#   - an incomplete closure fails the install closed and rolls everything back
#   - repeated installs are byte-idempotent; stale mixed-version closure bytes are repaired

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $InstallRoot 'scripts/Common.ps1')
$layout = Get-AihLayout $InstallRoot
$probeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('aih-muse-install-' + [System.Guid]::NewGuid().ToString('N'))
$passed = 0
function Pass([string]$Name) { $script:passed++; Write-Host ('PASS: ' + $Name) }
function Snapshot-Hashes([string]$Root) {
    return (@(Get-ChildItem -LiteralPath $Root -File -Recurse | Sort-Object FullName | ForEach-Object {
        $_.FullName.Substring($Root.Length) + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }) -join "`n")
}
function Link-Directory([string]$Link, [string]$Target) {
    if (Test-AihIsWindows) { New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null }
    else { New-Item -ItemType SymbolicLink -Path $Link -Target $Target | Out-Null }
}
function Test-SameBytes([string]$Path, [byte[]]$Expected) {
    $actual = [IO.File]::ReadAllBytes($Path)
    if ($actual.Length -ne $Expected.Length) { return $false }
    for ($i = 0; $i -lt $actual.Length; $i++) { if ($actual[$i] -ne $Expected[$i]) { return $false } }
    return $true
}

try {
    $disposable = Join-Path $probeRoot 'root'
    New-Item -ItemType Directory -Path $disposable | Out-Null
    foreach ($directory in @('config', 'scripts', 'ui')) { Copy-Item -LiteralPath (Join-Path $InstallRoot $directory) -Destination (Join-Path $disposable $directory) -Recurse }
    New-Item -ItemType Directory -Path (Join-Path $disposable 'data') | Out-Null
    Copy-Item -LiteralPath (Join-Path $InstallRoot 'config/settings.yaml') -Destination (Join-Path $disposable 'data/nexus-settings.yaml')
    Link-Directory (Join-Path $disposable 'app') $layout.App
    Link-Directory (Join-Path $disposable 'runtime') $layout.Runtime
    $installer = Join-Path $disposable 'scripts/Install-NexusPresets.ps1'
    $verifier = Join-Path $disposable 'scripts/Verify-NexusComposition.mjs'

    & $installer -InstallRoot $disposable
    if ($LASTEXITCODE -ne 0) { throw 'FAIL: first plane install failed.' }
    Pass 'fresh plane install publishes closures and a home patch the real DSH composition accepts'

    $patchPath = Join-Path $disposable 'data/cordis.patch.yml'
    $patch = Get-Content -Raw -Encoding UTF8 -LiteralPath $patchPath
    foreach ($plane in @('aih-engineering', 'aih-deepseek', 'aih-muse')) {
        if (-not (Test-Path -LiteralPath (Join-Path $disposable "data/.agent-presets/$plane/AihController.cjs"))) { throw "FAIL: closure for $plane is missing the controller." }
        if (-not $patch.Contains("id: preset-$plane")) { throw "FAIL: home patch does not declare $plane." }
    }
    Pass 'every plane has a published closure and a declared preset row'

    $museMatch = [regex]::Match($patch, '(?ms)^[ \t]*- id: preset-aih-muse[ \t]*$(.*?)(?=^[ \t]*- id: preset-aih-|^# ---- END NEXUS GENERATED|\z)')
    if (-not $museMatch.Success) { throw 'FAIL: Muse preset block not found.' }
    $muse = $museMatch.Groups[1].Value
    foreach ($required in @('aih-muse-isolation', 'aih-muse-reasoning-signals', 'aih-controller', 'AIH_PERSONA_MUSE', 'muse_update_reasoning_state')) {
        if (-not $muse.Contains($required)) { throw "FAIL: Muse plane lacks required content: $required" }
    }
    foreach ($forbidden in @('id: delegation', 'tool-subagent', 'workflow', 'ContributorProtection')) {
        if ($muse.Contains($forbidden)) { throw "FAIL: Muse plane carries forbidden content: $forbidden" }
    }
    if (@(Get-ChildItem -LiteralPath (Join-Path $disposable 'data/.agent-presets/aih-muse') -File | Select-String -SimpleMatch 'ContributorProtection').Count -ne 0) {
        throw 'FAIL: Muse closure files still reference ContributorProtection.'
    }
    Pass 'Muse plane has the required rows and no delegation, review or Contributor Protection surface'

    # The real composition rejects a plane whose local module cannot load.
    $goodPatch = [IO.File]::ReadAllBytes($patchPath)
    $brokenPatch = $patch.Replace("          - id: aih-muse-isolation", "          - id: missing-local-module-probe`n            name: 'file:///nonexistent/Muse-Missing-Module.cjs'`n          - id: aih-muse-isolation")
    if ($brokenPatch -eq $patch) { throw 'FAIL: could not construct the broken-module probe.' }
    [IO.File]::WriteAllText($patchPath, $brokenPatch, [Text.UTF8Encoding]::new($false))
    $verifyExit = 0
    try { & $layout.Node $verifier $disposable 2>&1 | Out-Null; $verifyExit = $LASTEXITCODE } catch { $verifyExit = 1 }
    [IO.File]::WriteAllBytes($patchPath, $goodPatch)
    if ($verifyExit -eq 0) { throw 'FAIL: the real composition accepted a Muse plane whose local module cannot load.' }
    & $layout.Node $verifier $disposable 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'FAIL: restoring the good home patch did not restore a passing composition.' }
    Pass 'the real DSH composition rejects a plane whose local module cannot load'

    $firstClosures = Snapshot-Hashes (Join-Path $disposable 'data/.agent-presets')
    & $installer -InstallRoot $disposable
    if ($LASTEXITCODE -ne 0) { throw 'FAIL: repeated plane install failed.' }
    if (-not (Test-SameBytes $patchPath $goodPatch)) { throw 'FAIL: repeated install changed the generated home patch.' }
    if ($firstClosures -ne (Snapshot-Hashes (Join-Path $disposable 'data/.agent-presets'))) { throw 'FAIL: repeated install changed closure bytes.' }
    Pass 'repeated plane install is byte-idempotent (home patch and closures)'

    [System.IO.File]::AppendAllText((Join-Path $disposable 'data/.agent-presets/aih-muse/AihController.cjs'), "`n// stale mixed-version probe`n")
    & $installer -InstallRoot $disposable
    if ($LASTEXITCODE -ne 0) { throw 'FAIL: stale-closure repair install failed.' }
    if ((Get-FileHash (Join-Path $disposable 'data/.agent-presets/aih-muse/AihController.cjs') -Algorithm SHA256).Hash -ne (Get-FileHash (Join-Path $disposable 'config/AihController.cjs') -Algorithm SHA256).Hash) {
        throw 'FAIL: stale runtime controller survived canonical install.'
    }
    Pass 'canonical install removes stale mixed-version closure bytes'

    # An incomplete closure fails the install closed and leaves the previous state intact.
    $before = Snapshot-Hashes (Join-Path $disposable 'data/.agent-presets')
    Remove-Item -LiteralPath (Join-Path $disposable 'config/Muse-ReasoningSignals.cjs') -Force
    $failed = $false
    $savedErrorActionPreference = $ErrorActionPreference
    try { $ErrorActionPreference = 'Stop'; & $installer -InstallRoot $disposable 2>&1 | Out-Null; $failed = ($LASTEXITCODE -ne 0) }
    catch { $failed = $true }
    finally { $ErrorActionPreference = $savedErrorActionPreference }
    if (-not $failed) { throw 'FAIL: installer accepted an incomplete Muse closure.' }
    if (-not (Test-SameBytes $patchPath $goodPatch)) { throw 'FAIL: failed install did not leave the previous home patch.' }
    if ($before -ne (Snapshot-Hashes (Join-Path $disposable 'data/.agent-presets'))) { throw 'FAIL: failed install did not leave the previous closures.' }
    Pass 'an incomplete closure fails the install closed and leaves the previous home patch and closures intact'
}
finally {
    if (Test-Path -LiteralPath $probeRoot) { Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ('SUITE RESULT: PASS ' + $passed + ' | FAIL 0 | total ' + $passed)
