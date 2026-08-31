[CmdletBinding()]
param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$rootSetupPath = Join-Path $InstallRoot 'setup.ps1'
if (-not (Test-Path -LiteralPath $rootSetupPath)) {
    throw "Root setup script missing at $rootSetupPath"
}
$rootSetupText = Get-Content -Raw -Encoding UTF8 -LiteralPath $rootSetupPath
if (-not $rootSetupText.Contains('[string]$InstallRoot = $PSScriptRoot')) {
    throw 'FAIL: root setup.ps1 must default InstallRoot to the checkout root.'
}
if ($rootSetupText.Contains("[string]`$InstallRoot = 'C:\AI-Harness'")) {
    throw 'FAIL: root setup.ps1 regressed to the legacy C:\AI-Harness default.'
}

$updatePath = Join-Path $InstallRoot 'scripts\Update.ps1'
$updateText = Get-Content -Raw -Encoding UTF8 -LiteralPath $updatePath
if ($updateText.Contains("[string]`$InstallRoot = 'C:\AI-Harness'")) {
    throw 'FAIL: Update.ps1 regressed to the legacy C:\AI-Harness default.'
}

$launcherRoot = Join-Path $InstallRoot 'bin'
foreach ($launcher in Get-ChildItem -LiteralPath $launcherRoot -Filter '*.cmd' -File) {
    $launcherText = Get-Content -Raw -Encoding UTF8 -LiteralPath $launcher.FullName
    if ($launcherText.Contains('C:\AI-Harness')) {
        throw "FAIL: launcher $($launcher.Name) contains a hard-coded C:\AI-Harness root."
    }
}
$mainLauncher = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $launcherRoot 'aih.cmd')
if (-not $mainLauncher.Contains('%~dp0..') -or -not $mainLauncher.Contains('-InstallRoot "%AIH_ROOT%"')) {
    throw 'FAIL: aih.cmd must resolve and pass the checkout root explicitly.'
}

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

foreach ($managedModule in @('Engineering-Isolation.cjs', 'AihController.cjs')) {
    $managedModulePath = Join-Path $InstallRoot "config\$managedModule"
    if (-not (Test-Path -LiteralPath $managedModulePath)) {
        throw "FAIL: Setup.ps1 did not install required managed config module: $managedModule"
    }
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

Write-Host 'PASS: repo-local setup/update/launchers are portable and checkout-relative'
Write-Host 'PASS: managed cordis.patch.yml is synced before Nexus UI migration'
Write-Host 'PASS: required engineering config modules are installed on fresh setup'
Write-Host 'PASS: Control Room mode lifecycle is Nexus-owned and no longer patches compiled upstream UI'
Write-Host 'PASS: mode-selector installer avoids PowerShell automatic-variable collisions'
