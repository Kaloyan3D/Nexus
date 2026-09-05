[CmdletBinding()]
param([string]$InstallRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

# Platform awareness comes from the shared abstraction, never from path
# string heuristics: the same Test-AihIsWindows/Get-AihLauncherExtension the
# installer plane uses decides which launcher contract this suite asserts.
. (Join-Path $InstallRoot 'scripts/Platform.ps1')
$runningOnWindows = Test-AihIsWindows
$launcherExtension = Get-AihLauncherExtension

function Assert-PosixLauncherContract {
    param([string]$Text, [string]$What)
    if (-not $Text.Contains('#!/bin/sh')) {
        throw "FAIL: $What must be a POSIX sh launcher (#!/bin/sh shebang missing)."
    }
    if (-not $Text.Contains('AIH_BAKED_ROOT') -or -not $Text.Contains('dirname')) {
        throw "FAIL: $What must resolve the install root (baked root or launcher-relative dirname)."
    }
    if (-not $Text.Contains('"$@"')) {
        throw "FAIL: $What must forward arguments without shell-string reconstruction."
    }
    if ($Text.Contains('eval ')) {
        throw "FAIL: $What must not use eval."
    }
    if (-not $Text.Contains('scripts/aih.ps1') -or -not $Text.Contains('-InstallRoot "$AIH_ROOT"')) {
        throw "FAIL: $What must invoke the Nexus PowerShell entrypoint with the explicit install root."
    }
    if (-not $Text.Contains('runtime/pwsh/pwsh')) {
        throw "FAIL: $What must prefer the Nexus-pinned PowerShell runtime."
    }
    foreach ($cmdSyntax in @('%~dp0', '%AIH_ROOT%', '%*')) {
        if ($Text.Contains($cmdSyntax)) {
            throw "FAIL: $What must not require Windows cmd syntax ($cmdSyntax)."
        }
    }
    if ($Text.Contains('C:\AI-Harness')) {
        throw "FAIL: $What contains a hard-coded legacy C:\AI-Harness path."
    }
}

$rootSetupPath = Join-Path $InstallRoot 'setup.ps1'
if (-not (Test-Path -LiteralPath $rootSetupPath)) {
    throw "Root setup script missing at $rootSetupPath"
}
$rootSetupText = Get-Content -Raw -Encoding UTF8 -LiteralPath $rootSetupPath
if ($rootSetupText.Contains("[string]`$InstallRoot = 'C:\AI-Harness'")) {
    throw 'FAIL: root setup.ps1 regressed to the legacy C:\AI-Harness default.'
}
if (-not $rootSetupText.Contains('if ([string]::IsNullOrWhiteSpace($InstallRoot))') -or -not $rootSetupText.Contains('$InstallRoot = $sourceRoot')) {
    throw 'FAIL: root setup.ps1 must resolve an omitted InstallRoot to the checkout root in the script body.'
}

$updatePath = Join-Path $InstallRoot 'scripts/Update.ps1'
$updateText = Get-Content -Raw -Encoding UTF8 -LiteralPath $updatePath
if ($updateText.Contains("[string]`$InstallRoot = 'C:\AI-Harness'")) {
    throw 'FAIL: Update.ps1 regressed to the legacy C:\AI-Harness default.'
}

$launcherRoot = Join-Path $InstallRoot 'bin'
# The main launcher name follows the platform contract: aih.cmd on Windows,
# extensionless aih on Linux. Nothing invents platform artifacts it merely
# wishes existed.
$mainLauncherName = "aih$launcherExtension"
$mainLauncherPath = Join-Path $launcherRoot $mainLauncherName
if (-not (Test-Path -LiteralPath $mainLauncherPath -PathType Leaf)) {
    throw "FAIL: platform main launcher missing: $mainLauncherPath (expected for this OS)"
}
$mainLauncher = Get-Content -Raw -Encoding UTF8 -LiteralPath $mainLauncherPath

if ($runningOnWindows) {
    # Windows .cmd contracts (batch-specific; asserted only on Windows).
    foreach ($launcher in Get-ChildItem -LiteralPath $launcherRoot -Filter '*.cmd' -File) {
        $launcherText = Get-Content -Raw -Encoding UTF8 -LiteralPath $launcher.FullName
        if ($launcherText.Contains('C:\AI-Harness')) {
            throw "FAIL: launcher $($launcher.Name) contains a hard-coded C:\AI-Harness root."
        }
    }
    if (-not $mainLauncher.Contains('%~dp0..') -or -not $mainLauncher.Contains('-InstallRoot "%AIH_ROOT%"')) {
        throw 'FAIL: aih.cmd must resolve and pass the checkout root explicitly.'
    }
    # The POSIX launcher source must keep its contract even while this suite
    # runs on Windows, so Linux launcher regressions surface on Windows too.
    $posixSource = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'bin/linux/aih.sh')
    Assert-PosixLauncherContract $posixSource 'bin/linux/aih.sh'
} else {
    # Linux: the extensionless POSIX launcher is the real installed artifact.
    if ($launcherExtension -ne '') {
        throw 'FAIL: Linux launcher extension must be empty (extensionless aih).'
    }
    $mode = (Get-Item -LiteralPath $mainLauncherPath).UnixFileMode
    if (-not [bool]($mode -band [System.IO.UnixFileMode]::UserExecute)) {
        throw "FAIL: installed launcher $mainLauncherName is not executable (mode: $mode)."
    }
    Assert-PosixLauncherContract $mainLauncher "bin/$mainLauncherName"
}

$setupPath = Join-Path $InstallRoot 'scripts/Setup.ps1'
if (-not (Test-Path -LiteralPath $setupPath)) {
    throw "Setup script missing at $setupPath"
}

# TASK-0023: the post-provision composition (settings init, managed patch
# sync, UI patchers, preset composition, data dirs, private-path protection)
# moved into scripts/Complete-Install.ps1 so Windows and Linux installers run
# the SAME single source of truth. Setup.ps1 must delegate to it and keep the
# Windows-only provisioning (pinned Node zip, npm ci, PATH) local.
$setupText = Get-Content -Raw -Encoding UTF8 -LiteralPath $setupPath
if (-not $setupText.Contains('Complete-Install.ps1')) {
    throw 'FAIL: Setup.ps1 must delegate the shared install composition to Complete-Install.ps1.'
}
if (-not $setupText.Contains('-ResetManagedSettings:$ResetManagedSettings')) {
    throw 'FAIL: Setup.ps1 must forward -ResetManagedSettings to the shared composition.'
}
$completeInstallPath = Join-Path $InstallRoot 'scripts/Complete-Install.ps1'
if (-not (Test-Path -LiteralPath $completeInstallPath)) {
    throw "Shared install composition missing at $completeInstallPath"
}
$compositionText = Get-Content -Raw -Encoding UTF8 -LiteralPath $completeInstallPath
$settingsInitIndex = $compositionText.IndexOf("if (`$ResetManagedSettings -or -not (Test-Path -LiteralPath `$layout.Settings))")
$managedPatchCopyIndex = $compositionText.LastIndexOf("home.cordis.patch.yml")
$modeInstallerIndex = $compositionText.IndexOf("Patch-ControlRoomUi.ps1")
$nexusPatchIndex = $compositionText.IndexOf("Patch-NexusUi.ps1")

if ($settingsInitIndex -lt 0) {
    throw 'FAIL: the shared install composition no longer initializes data\settings.yaml.'
}
if ($managedPatchCopyIndex -lt 0) {
    throw 'FAIL: the shared install composition no longer syncs the managed home.cordis.patch.yml into data.'
}
if ($modeInstallerIndex -lt 0) {
    throw 'FAIL: the shared install composition no longer invokes the Nexus mode-selector compatibility installer.'
}
if ($nexusPatchIndex -lt 0) {
    throw 'FAIL: the shared install composition no longer invokes Patch-NexusUi.ps1.'
}
if ($settingsInitIndex -gt $modeInstallerIndex -or $settingsInitIndex -gt $nexusPatchIndex) {
    throw 'FAIL: data\settings.yaml must exist before UI patchers run on a fresh install.'
}
if ($managedPatchCopyIndex -gt $modeInstallerIndex -or $managedPatchCopyIndex -gt $nexusPatchIndex) {
    throw 'FAIL: managed cordis.patch.yml must be synced before Nexus UI installers so upgrades from stale installs can migrate safely.'
}

foreach ($managedModule in @('Engineering-Isolation.cjs', 'AihController.cjs')) {
    $managedModulePath = Join-Path $InstallRoot "config/$managedModule"
    if (-not (Test-Path -LiteralPath $managedModulePath)) {
        throw "FAIL: Setup.ps1 did not install required managed config module: $managedModule"
    }
}

$modeInstallerPath = Join-Path $InstallRoot 'scripts/Patch-ControlRoomUi.ps1'
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

$managedPatchPath = Join-Path $InstallRoot 'config/home.cordis.patch.yml'
$managedPatch = Get-Content -Raw -Encoding UTF8 -LiteralPath $managedPatchPath
if (-not $managedPatch.Contains("name: '@nexus/mode-selector'")) {
    throw 'FAIL: managed composition no longer carries @nexus/mode-selector.'
}

$nexusPatch = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'scripts/Patch-NexusUi.ps1')
if (-not $nexusPatch.Contains('pendingWorkspaceId !== void 0')) {
    throw 'FAIL: Nexus UI patch no longer blocks composer submission during an optimistic workspace transition.'
}

$modeClientPath = Join-Path $InstallRoot 'ui/nexus-mode-selector/lib/client.js'
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

$platformNote = if ($runningOnWindows) { 'aih.cmd %~dp0/AIH_ROOT contracts' } else { 'extensionless POSIX aih contracts (native, executable)' }
Write-Host "PASS: platform launcher contract asserted: $platformNote"
Write-Host 'PASS: repo-local setup/update/launchers are portable and checkout-relative'
Write-Host 'PASS: fresh install creates settings before Nexus UI patchers run'
Write-Host 'PASS: managed cordis.patch.yml is synced before Nexus UI migration'
Write-Host 'PASS: required engineering config modules are installed on fresh setup'
Write-Host 'PASS: Control Room mode lifecycle is Nexus-owned and no longer patches compiled upstream UI'
Write-Host 'PASS: mode-selector installer avoids PowerShell automatic-variable collisions'
Write-Host 'PASS: workspace transition blocks old-session submission until the selected workspace is current'