[CmdletBinding()]
param([string]$InstallRoot = 'C:\AI-Harness')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$setupPath = Join-Path $InstallRoot 'scripts\Setup.ps1'
if (-not (Test-Path -LiteralPath $setupPath)) {
    throw "Setup script missing at $setupPath"
}

$setupText = Get-Content -Raw -Encoding UTF8 -LiteralPath $setupPath
$managedPatchCopyIndex = $setupText.LastIndexOf("home.cordis.patch.yml")
$modeInstallerIndex = $setupText.IndexOf("Patch-ControlRoomUi.ps1")
$nexusPatchIndex = $setupText.IndexOf("Patch-NexusUi.ps1")

if ($managedPatchCopyIndex -lt 0) {
    throw 'FAIL: Setup.ps1 no longer syncs the managed home.cordis.patch.yml into data.'
}
if ($modeInstallerIndex -lt 0) {
    throw 'FAIL: Setup.ps1 no longer invokes the Nexus mode-selector compatibility installer.'
}
if ($nexusPatchIndex -lt 0) {
    throw 'FAIL: Setup.ps1 no longer invokes Patch-NexusUi.ps1.'
}
if ($managedPatchCopyIndex -gt $modeInstallerIndex -or $managedPatchCopyIndex -gt $nexusPatchIndex) {
    throw 'FAIL: managed cordis.patch.yml must be synced before Nexus UI installers so upgrades from stale installs can migrate safely.'
}

$modeInstallerPath = Join-Path $InstallRoot 'scripts\Patch-ControlRoomUi.ps1'
$modeInstaller = Get-Content -Raw -Encoding UTF8 -LiteralPath $modeInstallerPath
if ($modeInstaller.Contains('AIH_CONTROL_ROOM_MODE_MODEL_SYNC') -or $modeInstaller.Contains('$clientPath') -or $modeInstaller.Contains('.Replace($old')) {
    throw 'FAIL: Patch-ControlRoomUi.ps1 regressed to compiled upstream bundle monkey-patching.'
}
if ($modeInstaller -match '(?im)^\s*\$host\s*=') {
    throw 'FAIL: Patch-ControlRoomUi.ps1 shadows the read-only PowerShell $Host automatic variable.'
}
if (-not $modeInstaller.Contains("'@nexus/mode-selector'")) {
    throw 'FAIL: Patch-ControlRoomUi.ps1 no longer installs the Nexus-owned mode-selector plugin.'
}

$managedPatchPath = Join-Path $InstallRoot 'config\home.cordis.patch.yml'
$managedPatch = Get-Content -Raw -Encoding UTF8 -LiteralPath $managedPatchPath
if (-not $managedPatch.Contains("name: '@nexus/mode-selector'")) {
    throw 'FAIL: managed composition no longer carries @nexus/mode-selector.'
}

$modeClientPath = Join-Path $InstallRoot 'ui\nexus-mode-selector\lib\client.js'
if (-not (Test-Path -LiteralPath $modeClientPath)) {
    throw "FAIL: Nexus mode-selector client source missing at $modeClientPath"
}
$modeClient = Get-Content -Raw -Encoding UTF8 -LiteralPath $modeClientPath
foreach ($contract in @(
    'priority: -100',
    'remote.agentPresets.select',
    'modelDirectories.directoryFor',
    'remote.settings.update',
    'if (!session.blank)'
)) {
    if (-not $modeClient.Contains($contract)) {
        throw "FAIL: Nexus mode-selector is missing permanent bridge contract: $contract"
    }
}

Write-Host 'PASS: managed cordis.patch.yml is synced before Nexus UI migration'
Write-Host 'PASS: Control Room mode lifecycle is Nexus-owned and no longer patches compiled upstream UI'
Write-Host 'PASS: mode-selector installer avoids PowerShell automatic-variable collisions'
