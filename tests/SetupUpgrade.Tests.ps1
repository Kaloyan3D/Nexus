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

# TASK-0032: returns the first CODE line (non-blank, non-comment) at or after
# $StartIndex, or $null. Comment lines are documentation, not semantics: the
# exit-semantics contract below binds to executable statements only.
function Get-AihNextCodeLine {
    param([string[]]$Lines, [int]$StartIndex)
    for ($i = $StartIndex; $i -lt $Lines.Count; $i++) {
        $trimmed = $Lines[$i].Trim()
        if ($trimmed.Length -gt 0 -and -not $trimmed.StartsWith('#')) { return $Lines[$i] }
    }
    return $null
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

# TASK-0032: PowerShell exit-semantics contract for the installer and updater.
# $LASTEXITCODE is defined only by NATIVE executable invocations; after a
# PowerShell .ps1 invocation it is either unset (a terminating RuntimeException
# under the StrictMode these scripts run under) or a stale value left by an
# unrelated earlier native command - never the invoked script's result. Script
# failures already surface as terminating errors (every script in this chain
# runs Set-StrictMode and $ErrorActionPreference = 'Stop' and throws), so a
# .ps1 invocation is followed by NO exit-code check, while every NATIVE
# invocation (npm ci here, bash in Update.ps1) keeps its explicit check.
$updateLines = @($updateText -split "\r?\n")
$windowsBranchStart = -1
for ($i = 0; $i -lt $updateLines.Count; $i++) {
    if ($updateLines[$i].Contains('if (Test-AihIsWindows) {')) { $windowsBranchStart = $i; break }
}
$posixBranchStart = -1
for ($i = $windowsBranchStart + 1; $i -lt $updateLines.Count; $i++) {
    if ($updateLines[$i].Trim() -eq 'else {') { $posixBranchStart = $i; break }
}
if ($windowsBranchStart -lt 0 -or $posixBranchStart -lt 0) {
    throw 'FAIL: Update.ps1 platform branch structure (if (Test-AihIsWindows) / else) not found.'
}
foreach ($branchLine in $updateLines[$windowsBranchStart..($posixBranchStart - 1)]) {
    $trimmed = $branchLine.Trim()
    if ($trimmed.Length -gt 0 -and -not $trimmed.StartsWith('#') -and $trimmed.Contains('$LASTEXITCODE')) {
        throw ('FAIL: Update.ps1 Windows branch reads the native exit code after the Setup.ps1 script invocation; script failures must be terminating errors (TASK-0032): ' + $trimmed)
    }
}
$windowsBranchText = $updateLines[$windowsBranchStart..($posixBranchStart - 1)] -join [Environment]::NewLine
if (-not $windowsBranchText.Contains('& $setup -InstallRoot $InstallRoot')) {
    throw 'FAIL: Update.ps1 Windows branch must keep delegating to scripts/Setup.ps1 with -InstallRoot.'
}
$bashIndex = -1
for ($i = $posixBranchStart; $i -lt $updateLines.Count; $i++) {
    if ($updateLines[$i].Contains("& 'bash'")) { $bashIndex = $i; break }
}
if ($bashIndex -lt 0) { throw 'FAIL: Update.ps1 POSIX branch native bash invocation not found.' }
$posixCheckLine = Get-AihNextCodeLine -Lines $updateLines -StartIndex ($bashIndex + 1)
if ($null -eq $posixCheckLine -or -not $posixCheckLine.Contains('$LASTEXITCODE')) {
    throw 'FAIL: Update.ps1 POSIX branch must keep the native bash exit-code check (LASTEXITCODE after & bash).'
}
$setupLines = @($setupText -split "\r?\n")
$npmCheckFound = $false
for ($i = 0; $i -lt $setupLines.Count; $i++) {
    $trimmed = $setupLines[$i].Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) { continue }
    if ($setupLines[$i].Contains('& $layout.Npm ci')) {
        $nextCode = Get-AihNextCodeLine -Lines $setupLines -StartIndex ($i + 1)
        if ($null -eq $nextCode -or -not $nextCode.Contains('$LASTEXITCODE')) {
            throw 'FAIL: Setup.ps1 must keep the native npm ci exit-code check (LASTEXITCODE after & npm).'
        }
        $npmCheckFound = $true
    }
    elseif ($setupLines[$i].Contains("Complete-Install.ps1') -InstallRoot") -or $setupLines[$i].Contains("Install-NexusSkills.ps1') -InstallRoot")) {
        $nextCode = Get-AihNextCodeLine -Lines $setupLines -StartIndex ($i + 1)
        if ($null -ne $nextCode -and $nextCode.Contains('$LASTEXITCODE')) {
            throw ('FAIL: Setup.ps1 reads the native exit code after a PowerShell .ps1 invocation; script failures must be terminating errors (TASK-0032): ' + $nextCode.Trim())
        }
    }
}
if (-not $npmCheckFound) { throw 'FAIL: Setup.ps1 native npm ci invocation not found.' }

# TASK-0032 behavioral regression (Windows installer semantics): Setup.ps1
# must COMPLETE after a succeeding PowerShell .ps1 composition invocation.
# The defect read the native exit code after '& Complete-Install.ps1'; with no
# native command having run (fresh process, -SkipDependencyInstall) that read
# was a terminating StrictMode RuntimeException and killed a successful
# install. The stub composition below deliberately runs no native command, so
# the pre-fix defect reproduces deterministically. On the POSIX plane
# setup.sh owns the installer flow; the static contract above is asserted
# on every OS.
if ($runningOnWindows) {
    $exitProbeRoot = Join-Path ([IO.Path]::GetTempPath()) ('aih-setup-exit-' + [guid]::NewGuid().ToString('N'))
    try {
        $probeSource = Join-Path $exitProbeRoot 'source'
        $probeInstall = Join-Path $exitProbeRoot 'install'
        foreach ($probeDirectory in @(
            (Join-Path $probeSource 'config'), (Join-Path $probeSource 'runtime'), (Join-Path $probeSource 'scripts'),
            (Join-Path $probeSource 'bin'), (Join-Path $probeSource 'tests'), (Join-Path $probeSource 'ui'),
            (Join-Path $probeInstall 'app/node_modules/@deepseek-ai/dsh/lib'))) {
            New-Item -ItemType Directory -Force -Path $probeDirectory | Out-Null
        }
        foreach ($probeFile in @('setup.ps1', 'README.md', 'SECURITY.md', '.gitignore', '.gitattributes', '.env.example')) {
            [IO.File]::WriteAllText((Join-Path $probeSource $probeFile), 'TASK-0032 probe fixture' + [Environment]::NewLine)
        }
        # NodeVersion explicitly null: the pinned-runtime block must be a no-op
        # (nothing installed, nothing to compare) so the probe never touches the network.
        [IO.File]::WriteAllText((Join-Path $probeSource 'config/versions.json'), '{"NodeVersion": null}' + [Environment]::NewLine)
        foreach ($probeFile in @('settings.yaml', 'home.cordis.patch.yml', 'delegation-block.yml', 'preset.yml', 'preset-deepseek.yml', 'DeepSeek-Isolation.cjs', 'Engineering-Isolation.cjs', 'AihController.cjs', 'deepseek-agent.cordis.yml', 'routing-policy.json', 'engineering-profiles.json', 'model-registry.json', 'Engineering-Profiles.cjs')) {
            [IO.File]::WriteAllText((Join-Path $probeSource ('config/' + $probeFile)), 'TASK-0032 probe fixture' + [Environment]::NewLine)
        }
        foreach ($probeFile in @('package.json', 'package-lock.json')) {
            [IO.File]::WriteAllText((Join-Path $probeSource ('runtime/' + $probeFile)), '{}' + [Environment]::NewLine)
        }
        [IO.File]::WriteAllText((Join-Path $probeInstall 'app/node_modules/@deepseek-ai/dsh/lib/bin.js'), '// probe marker' + [Environment]::NewLine)
        Copy-Item -LiteralPath (Join-Path $InstallRoot 'scripts/Common.ps1') -Destination (Join-Path $probeSource 'scripts/Common.ps1') -Force
        Copy-Item -LiteralPath (Join-Path $InstallRoot 'scripts/Platform.ps1') -Destination (Join-Path $probeSource 'scripts/Platform.ps1') -Force
        Copy-Item -LiteralPath (Join-Path $InstallRoot 'scripts/Setup.ps1') -Destination (Join-Path $probeSource 'scripts/Setup.ps1') -Force
        # The probe stub replaces the REAL shared composition: it records the
        # invocation and SUCCEEDS without running any native command.
        $stubCompleteInstall = @'
param(
    [string]$InstallRoot,
    [switch]$ResetManagedSettings
)
$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add('completeinstall=' + $PSCommandPath)
$lines.Add('installroot=' + $InstallRoot)
if ($env:AIH_SETUP_EXIT_RECORDER) { [System.IO.File]::WriteAllLines($env:AIH_SETUP_EXIT_RECORDER, $lines) }
'@
        [IO.File]::WriteAllText((Join-Path $probeSource 'scripts/Complete-Install.ps1'), $stubCompleteInstall, [Text.UTF8Encoding]::new($false))
        $exitRecorderFile = Join-Path $exitProbeRoot 'recorder.txt'
        [IO.File]::WriteAllText($exitRecorderFile, '')
        $savedExitRecorder = $env:AIH_SETUP_EXIT_RECORDER
        $savedPreference = $ErrorActionPreference
        try {
            Set-Item Env:AIH_SETUP_EXIT_RECORDER -Value $exitRecorderFile
            $ErrorActionPreference = 'Continue'
            # Child hosts are resolved through the shared abstraction
            # (Get-AihPowerShellHost), never spawned bare.
            $setupExitProbeHost = Get-AihPowerShellHost -InstallRoot $InstallRoot
            $probeOutput = & $setupExitProbeHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $probeSource 'scripts/Setup.ps1') -InstallRoot $probeInstall -SkipDependencyInstall -SkipSkillsInstall -SkipPathUpdate 2>&1 | ForEach-Object { [string]$_ }
            $probeExit = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $savedPreference
            if ($null -eq $savedExitRecorder) { Remove-Item Env:AIH_SETUP_EXIT_RECORDER -ErrorAction SilentlyContinue } else { Set-Item Env:AIH_SETUP_EXIT_RECORDER -Value $savedExitRecorder }
        }
        $probeText = (@($probeOutput) -join ' ')
        if ($probeExit -ne 0) {
            throw ('FAIL: Setup.ps1 must complete after a succeeding PowerShell .ps1 composition invocation (exit ' + $probeExit + '): ' + $probeText)
        }
        $exitRecorded = @(Get-Content -LiteralPath $exitRecorderFile)
        if ($exitRecorded.Count -lt 2) { throw 'FAIL: the stub install composition did not run (recorder empty).' }
        if (-not $probeText.Contains('AI Harness installed at')) { throw ('FAIL: Setup.ps1 did not reach its completion line: ' + $probeText) }
    }
    finally {
        if (Test-Path -LiteralPath $exitProbeRoot) { Remove-Item -LiteralPath $exitProbeRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Write-Host 'PASS: setup/update exit semantics keep native npm/bash checks and read no exit code after .ps1 invocations (TASK-0032)'
if ($runningOnWindows) {
    Write-Host 'PASS: Setup.ps1 completes after a succeeding .ps1 composition invocation (no native-exit-code read; TASK-0032)'
}
else {
    Write-Host 'NOTE: Setup.ps1 completion probe runs on the Windows plane only; the exit-semantics text contract is asserted on every OS.'
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