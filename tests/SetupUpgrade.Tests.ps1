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
    'api.agentPresets.select',
    'modelDirectories.directoryFor',
    'api.settings.update',
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

# TASK-0033: the Windows ROOT setup.ps1 exit-semantics contract. Every
# invocation in setup.ps1 targets a PowerShell .ps1 script (Setup.ps1,
# Set-DeepSeekKey.ps1, Set-OpenAiOAuth.ps1, Doctor.ps1, Test-Harness.ps1) and
# none targets a native executable, so the file must contain NO $LASTEXITCODE
# read at all: after a .ps1 invocation that variable is either unset (a
# terminating StrictMode RuntimeException that killed SUCCESSFUL installs on
# a fresh process) or stale from an unrelated earlier native command - never
# the invoked script's result. Failures still propagate without the read: the
# child scripts throw under Set-StrictMode/$ErrorActionPreference='Stop', and
# Doctor.ps1/Test-Harness.ps1 terminate the process themselves via `exit` on
# a failing local check. setup.ps1 is a Windows-only entry point (it throws on
# non-Windows), so this whole contract is Windows-gated.
if ($runningOnWindows) {
    $rootSetupLines = @($rootSetupText -split "\r?\n")
    foreach ($rootLine in $rootSetupLines) {
        $rootTrimmed = $rootLine.Trim()
        if ($rootTrimmed.Length -gt 0 -and -not $rootTrimmed.StartsWith('#') -and $rootTrimmed.Contains('$LASTEXITCODE')) {
            throw ('FAIL: root setup.ps1 reads the native exit code; it invokes only PowerShell .ps1 scripts and script failures must be terminating errors (TASK-0033): ' + $rootTrimmed)
        }
    }
    foreach ($rootAnchor in @(
        '& $installer -InstallRoot $InstallRoot -SkipPathUpdate:$SkipPathUpdate',
        'scripts/Set-DeepSeekKey.ps1',
        'scripts/Set-OpenAiOAuth.ps1',
        'scripts/Doctor.ps1',
        'scripts/Test-Harness.ps1'
    )) {
        if (-not $rootSetupText.Contains($rootAnchor)) {
            throw ('FAIL: root setup.ps1 lost its PowerShell .ps1 invocation anchor, so the exit-semantics contract above is vacuous (TASK-0033): ' + $rootAnchor)
        }
    }

    function New-AihRootSetupExitSandbox {
        param([string]$ProbeRoot)
        $probeSource = Join-Path $ProbeRoot 'source'
        $probeInstall = Join-Path $ProbeRoot 'install'
        foreach ($probeDirectory in @($probeSource, (Join-Path $probeSource 'scripts'), $probeInstall, (Join-Path $probeInstall 'scripts'))) {
            New-Item -ItemType Directory -Force -Path $probeDirectory | Out-Null
        }
        # The REAL Windows root entry point runs unchanged in the sandbox.
        Copy-Item -LiteralPath (Join-Path $InstallRoot 'setup.ps1') -Destination (Join-Path $probeSource 'setup.ps1') -Force
        # The stub .ps1 scripts SUCCEED without running any native command, so
        # any post-invocation $LASTEXITCODE read reproduces the fresh-process
        # defect deterministically (unset under StrictMode, stale otherwise).
        $stubInstaller = @'
param(
    [string]$InstallRoot,
    [switch]$SkipPathUpdate
)
if ($env:AIH_ROOT_SETUP_EXIT_RECORDER) {
    [System.IO.File]::AppendAllLines($env:AIH_ROOT_SETUP_EXIT_RECORDER, [string[]]@('installer=ok; skippathupdate=' + [bool]$SkipPathUpdate))
}
if ($env:AIH_ROOT_SETUP_FAIL_MODE -eq 'installer-throws') { throw 'probe: harness installation failed deterministically' }
'@
        [IO.File]::WriteAllText((Join-Path $probeSource 'scripts/Setup.ps1'), $stubInstaller, [Text.UTF8Encoding]::new($false))
        $stubDeepSeekKey = @'
param([string]$InstallRoot)
if ($env:AIH_ROOT_SETUP_EXIT_RECORDER) {
    [System.IO.File]::AppendAllLines($env:AIH_ROOT_SETUP_EXIT_RECORDER, [string[]]@('deepseek=ok'))
}
'@
        [IO.File]::WriteAllText((Join-Path $probeInstall 'scripts/Set-DeepSeekKey.ps1'), $stubDeepSeekKey, [Text.UTF8Encoding]::new($false))
        $stubOpenAiOAuth = @'
param([string]$InstallRoot)
if ($env:AIH_ROOT_SETUP_EXIT_RECORDER) {
    [System.IO.File]::AppendAllLines($env:AIH_ROOT_SETUP_EXIT_RECORDER, [string[]]@('openai=ok'))
}
'@
        [IO.File]::WriteAllText((Join-Path $probeInstall 'scripts/Set-OpenAiOAuth.ps1'), $stubOpenAiOAuth, [Text.UTF8Encoding]::new($false))
        # Credential presence is environment-switchable so the probe covers BOTH
        # local-check branches (Doctor.ps1 and Test-Harness.ps1).
        $stubCommon = @'
function Get-AihDeepSeekKey {
    param([string]$InstallRoot)
    if ($env:AIH_ROOT_SETUP_PROBE_CREDENTIAL) { return 'probe-credential' }
    return $null
}
'@
        [IO.File]::WriteAllText((Join-Path $probeInstall 'scripts/Common.ps1'), $stubCommon, [Text.UTF8Encoding]::new($false))
        $stubDoctor = @'
param(
    [string]$InstallRoot,
    [string]$Preset,
    [switch]$Offline
)
if ($env:AIH_ROOT_SETUP_EXIT_RECORDER) {
    [System.IO.File]::AppendAllLines($env:AIH_ROOT_SETUP_EXIT_RECORDER, [string[]]@('doctor=ok; preset=' + $Preset))
}
'@
        [IO.File]::WriteAllText((Join-Path $probeInstall 'scripts/Doctor.ps1'), $stubDoctor, [Text.UTF8Encoding]::new($false))
        $stubTestHarness = @'
param([string]$InstallRoot)
if ($env:AIH_ROOT_SETUP_EXIT_RECORDER) {
    [System.IO.File]::AppendAllLines($env:AIH_ROOT_SETUP_EXIT_RECORDER, [string[]]@('testharness=ok'))
}
'@
        [IO.File]::WriteAllText((Join-Path $probeInstall 'scripts/Test-Harness.ps1'), $stubTestHarness, [Text.UTF8Encoding]::new($false))
    }

    function Invoke-AihRootSetupExitProbe {
        param([string]$ProbeRoot, [string]$RecorderPath, [string]$FailMode, [switch]$WithCredential)
        [IO.File]::WriteAllText($RecorderPath, '')
        $savedProbeRecorder = $env:AIH_ROOT_SETUP_EXIT_RECORDER
        $savedProbeFailMode = $env:AIH_ROOT_SETUP_FAIL_MODE
        $savedProbeCredential = $env:AIH_ROOT_SETUP_PROBE_CREDENTIAL
        $savedProbePreference = $ErrorActionPreference
        try {
            Set-Item Env:AIH_ROOT_SETUP_EXIT_RECORDER -Value $RecorderPath
            if ([string]::IsNullOrEmpty($FailMode)) { Remove-Item Env:AIH_ROOT_SETUP_FAIL_MODE -ErrorAction SilentlyContinue } else { Set-Item Env:AIH_ROOT_SETUP_FAIL_MODE -Value $FailMode }
            if ($WithCredential) { Set-Item Env:AIH_ROOT_SETUP_PROBE_CREDENTIAL -Value '1' } else { Remove-Item Env:AIH_ROOT_SETUP_PROBE_CREDENTIAL -ErrorAction SilentlyContinue }
            $ErrorActionPreference = 'Continue'
            # Child hosts are resolved through the shared abstraction
            # (Get-AihPowerShellHost), never spawned bare.
            $rootSetupProbeHost = Get-AihPowerShellHost -InstallRoot $InstallRoot
            & $rootSetupProbeHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path (Join-Path $ProbeRoot 'source') 'setup.ps1') -InstallRoot (Join-Path $ProbeRoot 'install') 2>&1 | ForEach-Object { [string]$_ }
        }
        finally {
            $ErrorActionPreference = $savedProbePreference
            if ($null -eq $savedProbeRecorder) { Remove-Item Env:AIH_ROOT_SETUP_EXIT_RECORDER -ErrorAction SilentlyContinue } else { Set-Item Env:AIH_ROOT_SETUP_EXIT_RECORDER -Value $savedProbeRecorder }
            if ($null -eq $savedProbeFailMode) { Remove-Item Env:AIH_ROOT_SETUP_FAIL_MODE -ErrorAction SilentlyContinue } else { Set-Item Env:AIH_ROOT_SETUP_FAIL_MODE -Value $savedProbeFailMode }
            if ($null -eq $savedProbeCredential) { Remove-Item Env:AIH_ROOT_SETUP_PROBE_CREDENTIAL -ErrorAction SilentlyContinue } else { Set-Item Env:AIH_ROOT_SETUP_PROBE_CREDENTIAL -Value $savedProbeCredential }
        }
    }

    $rootSetupProbeRoot = Join-Path ([IO.Path]::GetTempPath()) ('aih-rootsetup-exit-' + [guid]::NewGuid().ToString('N'))
    try {
        New-AihRootSetupExitSandbox -ProbeRoot $rootSetupProbeRoot
        $credRecorderPath = Join-Path $rootSetupProbeRoot 'recorder-credential.txt'
        $noCredRecorderPath = Join-Path $rootSetupProbeRoot 'recorder-nocredential.txt'
        $failRecorderPath = Join-Path $rootSetupProbeRoot 'recorder-failure.txt'

        # Behavioral regression 1/3: with a DeepSeek credential configured, root
        # setup.ps1 must COMPLETE through the Doctor.ps1 local-check branch. The
        # pre-fix defect read the native exit code after every .ps1 invocation;
        # the stubs run no native command, so that read was a terminating
        # StrictMode RuntimeException that killed a fully successful setup.
        $credProbeOutput = Invoke-AihRootSetupExitProbe -ProbeRoot $rootSetupProbeRoot -RecorderPath $credRecorderPath -WithCredential
        $credProbeExit = $LASTEXITCODE
        if ($credProbeExit -ne 0) {
            throw ('FAIL: root setup.ps1 must complete after succeeding .ps1 invocations (Doctor branch, exit ' + $credProbeExit + '): ' + (@($credProbeOutput) -join ' '))
        }
        $credRecorded = @(Get-Content -LiteralPath $credRecorderPath)
        foreach ($credMarker in @('installer=ok', 'deepseek=ok', 'openai=ok', 'doctor=ok')) {
            if (@($credRecorded | Where-Object { $_.StartsWith($credMarker) }).Count -ne 1) {
                throw ('FAIL: root setup.ps1 did not run exactly one ' + $credMarker + ' step (recorder: ' + ($credRecorded -join ' | ') + ')')
            }
        }
        $credProbeText = (@($credProbeOutput) -join ' ')
        if (-not $credProbeText.Contains('Setup complete')) {
            throw ('FAIL: root setup.ps1 did not reach its completion line (Doctor branch): ' + $credProbeText)
        }

        # Behavioral regression 2/3: without a credential the local-check branch
        # is Test-Harness.ps1 - the same no-native-exit-code contract applies.
        $noCredProbeOutput = Invoke-AihRootSetupExitProbe -ProbeRoot $rootSetupProbeRoot -RecorderPath $noCredRecorderPath
        $noCredProbeExit = $LASTEXITCODE
        if ($noCredProbeExit -ne 0) {
            throw ('FAIL: root setup.ps1 must complete after succeeding .ps1 invocations (Test-Harness branch, exit ' + $noCredProbeExit + '): ' + (@($noCredProbeOutput) -join ' '))
        }
        $noCredRecorded = @(Get-Content -LiteralPath $noCredRecorderPath)
        foreach ($noCredMarker in @('installer=ok', 'deepseek=ok', 'openai=ok', 'testharness=ok')) {
            if (@($noCredRecorded | Where-Object { $_.StartsWith($noCredMarker) }).Count -ne 1) {
                throw ('FAIL: root setup.ps1 did not run exactly one ' + $noCredMarker + ' step (recorder: ' + ($noCredRecorded -join ' | ') + ')')
            }
        }
        $noCredProbeText = (@($noCredProbeOutput) -join ' ')
        if (-not $noCredProbeText.Contains('Setup complete')) {
            throw ('FAIL: root setup.ps1 did not reach its completion line (Test-Harness branch): ' + $noCredProbeText)
        }

        # Behavioral regression 3/3: removing the reads must not swallow real
        # failures - a terminating error in an invoked .ps1 must still surface
        # as a non-zero process exit with the error message visible.
        $failProbeOutput = Invoke-AihRootSetupExitProbe -ProbeRoot $rootSetupProbeRoot -RecorderPath $failRecorderPath -FailMode 'installer-throws'
        $failProbeExit = $LASTEXITCODE
        $failProbeText = (@($failProbeOutput) -join ' ')
        if ($failProbeExit -eq 0) {
            throw ('FAIL: root setup.ps1 must exit non-zero when an invoked .ps1 raises a terminating error (TASK-0033): ' + $failProbeText)
        }
        if (-not $failProbeText.Contains('probe: harness installation failed deterministically')) {
            throw ('FAIL: the failing .ps1 terminating error did not propagate out of root setup.ps1 (TASK-0033): ' + $failProbeText)
        }
    }
    finally {
        if (Test-Path -LiteralPath $rootSetupProbeRoot) { Remove-Item -LiteralPath $rootSetupProbeRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }

    Write-Host 'PASS: root setup.ps1 invokes only .ps1 scripts and reads no exit code after them (TASK-0033)'
    Write-Host 'PASS: root setup.ps1 completes both local-check branches after succeeding .ps1 invocations (TASK-0033)'
    Write-Host 'PASS: root setup.ps1 propagates a failing .ps1 invocation as a non-zero terminating error (TASK-0033)'
}
else {
    Write-Host 'NOTE: root setup.ps1 exit-semantics contract (TASK-0033) is Windows-gated; setup.ps1 is a Windows-only entry point.'
}

# TASK-0037 (Phase M2.1): additive managed provider settings migration.
# config/settings.yaml is the managed template; data/settings.yaml is the
# operator-owned runtime document. Complete-Install must migrate managed
# provider routes additively and idempotently without ever touching user
# values. These tests exercise the real migration function against temp
# fixture documents; the live data/settings.yaml is never touched.
. (Join-Path $InstallRoot 'scripts/SettingsMigration.ps1')
$migrationTemplatePath = Join-Path $InstallRoot 'config/settings.yaml'
$migrationTemplateText = [System.IO.File]::ReadAllText($migrationTemplatePath)
$migrationFixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('aih-migration-' + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $migrationFixtureRoot | Out-Null
try {
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    # Scenario 1: fresh-install state (template copied wholesale) is a
    # verified no-op.
    $freshPath = Join-Path $migrationFixtureRoot 'fresh.yaml'
    [System.IO.File]::WriteAllText($freshPath, $migrationTemplateText, $utf8NoBom)
    $freshBefore = [System.IO.File]::ReadAllText($freshPath)
    $freshResult = Sync-AihManagedSettings -TemplatePath $migrationTemplatePath -SettingsPath $freshPath
    if ($freshResult.Changed) { throw 'FAIL: a fresh template copy must migrate as a verified no-op.' }
    if ((@($freshResult.AddedRoutes).Count -ne 0) -or (@($freshResult.UpgradedRoutes).Count -ne 0)) { throw 'FAIL: a fresh template copy must not add or upgrade routes.' }
    Write-Host 'PASS: fresh-install template copy migrates as a verified no-op (M2.1)'

    # Scenario 2: pre-M2 install without the managed meta route gains it
    # verbatim while every user byte (values, comments, order) is preserved,
    # and the document's CRLF newline style survives the migration.
    $preM2Path = Join-Path $migrationFixtureRoot 'pre-m2.yaml'
    $preM2User = @(
        'agent-default-model:',
        '  provider: zai-direct',
        '  model: glm-5.3-flash',
        '  reasoningEffort: high',
        '',
        'engineering-profile: glm-codex',
        '',
        '# user comment that must survive migration',
        'llm-pi-ai:',
        '  providers:',
        '    zai-direct:',
        '      displayName: Z.ai GLM (direct)',
        '      apiKeyEnv: ZAI_API_KEY',
        '      api: openai-completions',
        '      baseURL: https://api.z.ai/api/paas/v4',
        '      models:',
        '        - id: glm-5.3-flash',
        '          name: GLM-5.3-Flash',
        '',
        'ui-theme:',
        '  preference: dark'
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($preM2Path, $preM2User + "`r`n", $utf8NoBom)
    $preM2Result = Sync-AihManagedSettings -TemplatePath $migrationTemplatePath -SettingsPath $preM2Path
    if (-not $preM2Result.Changed) { throw 'FAIL: a pre-M2 document missing the managed routes must change.' }
    $preM2After = [System.IO.File]::ReadAllText($preM2Path)
    if (-not $preM2After.Contains('muse-spark-1.3-contributor')) { throw 'FAIL: the managed meta route was not migrated into the existing document.' }
    if ($preM2After -notmatch [regex]::Escape('reasoningEfforts:')) { throw 'FAIL: migrated route lost its reasoningEfforts map.' }
    foreach ($userByte in @('# user comment that must survive migration', 'glm-5.3-flash', 'preference: dark', 'reasoningEffort: high')) {
        if (-not $preM2After.Contains($userByte)) { throw ('FAIL: migration lost user content: ' + $userByte) }
    }
    if (-not $preM2After.Contains("`r`n")) { throw 'FAIL: migration must preserve the document CRLF newline style.' }
    Write-Host 'PASS: existing install gains managed provider routes additively with user bytes preserved (M2.1)'

    # Scenario 3: the migration is idempotent - a second run is a byte no-op.
    $idempotentBefore = [System.IO.File]::ReadAllText($preM2Path)
    $secondResult = Sync-AihManagedSettings -TemplatePath $migrationTemplatePath -SettingsPath $preM2Path
    $idempotentAfter = [System.IO.File]::ReadAllText($preM2Path)
    if ($secondResult.Changed -or ($idempotentBefore -ne $idempotentAfter)) { throw 'FAIL: the managed settings migration must be idempotent.' }
    Write-Host 'PASS: managed settings migration is idempotent (M2.1)'

    # Scenario 4: a stale Phase M2 managed meta route (standard
    # muse-spark-1.3, off/max reasoning map) upgrades deterministically to the
    # Phase M2.1 contributor route without duplicating either route.
    $stalePath = Join-Path $migrationFixtureRoot 'stale-m2.yaml'
    $staleLines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in ($migrationTemplateText -replace "`r`n", "`n") -split "`n") { $staleLines.Add($line) }
    $templateRoutes = Get-AihSettingsProviderRouteBlocks -Lines $staleLines
    $metaRoute = $null
    foreach ($route in $templateRoutes) { if ($route.Id -eq 'meta-model-api') { $metaRoute = $route; break } }
    if ($null -eq $metaRoute) { throw 'FAIL: test setup could not find the managed meta-model-api route in the template.' }
    $priorState = $script:ManagedRoutePriorStates['meta-model-api'][0]
    if ([string]::IsNullOrWhiteSpace($priorState)) { throw 'FAIL: the M2 prior managed state must stay embedded in SettingsMigration.ps1.' }
    $staleLines.RemoveRange($metaRoute.StartIndex, ($metaRoute.EndIndex - $metaRoute.StartIndex + 1))
    $staleLines.InsertRange($metaRoute.StartIndex, (@($priorState -replace "`r`n", "`n") -split "`n"))
    [System.IO.File]::WriteAllText($stalePath, (($staleLines -join "`r`n") + "`r`n"), $utf8NoBom)
    $staleResult = Sync-AihManagedSettings -TemplatePath $migrationTemplatePath -SettingsPath $stalePath
    $staleAfter = [System.IO.File]::ReadAllText($stalePath)
    if (@($staleResult.UpgradedRoutes) -notcontains 'meta-model-api') { throw 'FAIL: the stale M2 managed route must be reported as upgraded.' }
    if (-not $staleAfter.Contains('muse-spark-1.3-contributor')) { throw 'FAIL: the M2 managed route did not upgrade to the M2.1 contributor route.' }
    # Exact-match guard: 'muse-spark-1.3' is a PREFIX of 'muse-spark-1.3-contributor',
    # so the stale standard id is asserted with a negative lookahead, not a substring test.
    if ([regex]::IsMatch($staleAfter, [regex]::Escape('- id: muse-spark-1.3') + '(?!-contributor)')) { throw 'FAIL: the stale standard muse-spark-1.3 model entry must not survive the upgrade.' }
    $metaRouteCount = ([regex]::Matches($staleAfter, [regex]::Escape('    meta-model-api:'))).Count
    if ($metaRouteCount -ne 1) { throw ('FAIL: the managed meta route must appear exactly once after upgrade, found: ' + $metaRouteCount) }
    if (-not $staleAfter.Contains('zai-direct') -and -not $migrationTemplateText.Contains('zai-direct')) { throw 'FAIL: unrelated managed routes must survive the upgrade.' }
    Write-Host 'PASS: stale Phase M2 managed route upgrades deterministically to the contributor route (M2.1)'

    # Scenario 5: a user-modified but structurally valid managed route is
    # user-owned: the migration never rewrites, reorders, or duplicates it.
    $userOwnedPath = Join-Path $migrationFixtureRoot 'user-owned.yaml'
    $userOwnedLines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $staleLines) { $userOwnedLines.Add($line) }
    $userOwnedLines[($userOwnedLines.IndexOf('    meta-model-api:') + 1)] = '      displayName: My custom Meta route'
    [System.IO.File]::WriteAllText($userOwnedPath, (($userOwnedLines -join "`r`n") + "`r`n"), $utf8NoBom)
    $userOwnedBefore = [System.IO.File]::ReadAllText($userOwnedPath)
    $userOwnedResult = Sync-AihManagedSettings -TemplatePath $migrationTemplatePath -SettingsPath $userOwnedPath
    $userOwnedAfter = [System.IO.File]::ReadAllText($userOwnedPath)
    if (@($userOwnedResult.SkippedUserRoutes) -notcontains 'meta-model-api') { throw 'FAIL: a user-modified managed route must be reported as user-preserved.' }
    if ($userOwnedBefore -ne $userOwnedAfter) { throw 'FAIL: a user-modified managed route must survive the migration byte-identical.' }
    Write-Host 'PASS: user-modified managed routes are never rewritten by the migration (M2.1)'

    # Scenario 6: a structurally invalid Nexus-managed route fails the
    # migration closed (clear error, file untouched on disk).
    $invalidPath = Join-Path $migrationFixtureRoot 'invalid.yaml'
    $invalidLines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $userOwnedLines) { $invalidLines.Add($line) }
    $invalidLines[($invalidLines.IndexOf('    meta-model-api:') + 2)] = '      apiKeyEnv: # emptied by the user'
    [System.IO.File]::WriteAllText($invalidPath, (($invalidLines -join "`r`n") + "`r`n"), $utf8NoBom)
    $invalidBefore = [System.IO.File]::ReadAllText($invalidPath)
    $invalidThrew = $false
    try { Sync-AihManagedSettings -TemplatePath $migrationTemplatePath -SettingsPath $invalidPath | Out-Null } catch { $invalidThrew = $true }
    $invalidAfter = [System.IO.File]::ReadAllText($invalidPath)
    if (-not $invalidThrew) { throw 'FAIL: a structurally invalid managed route must fail the migration closed.' }
    if ($invalidBefore -ne $invalidAfter) { throw 'FAIL: a failed migration must leave the document untouched on disk.' }
    Write-Host 'PASS: structurally invalid managed routes fail the migration closed with the file untouched (M2.1)'

    # Scenario 7: Complete-Install runs the migration between settings init
    # and the managed patch sync, and the migration module is side-effect
    # free when dot-sourced.
    $migrationHookIndex = $compositionText.IndexOf('Sync-AihManagedSettings -TemplatePath')
    if ($migrationHookIndex -lt 0) { throw 'FAIL: Complete-Install.ps1 must invoke the managed settings migration.' }
    if ($migrationHookIndex -lt $settingsInitIndex -or $migrationHookIndex -gt $managedPatchCopyIndex) { throw 'FAIL: the settings migration must run after settings init and before the managed patch sync.' }
    if (-not $compositionText.Contains("SettingsMigration.ps1'")) { throw 'FAIL: Complete-Install.ps1 must dot-source SettingsMigration.ps1.' }
    Write-Host 'PASS: Complete-Install migrates managed settings after settings init and before patch sync (M2.1)'
}
finally {
    if (Test-Path -LiteralPath $migrationFixtureRoot) { Remove-Item -LiteralPath $migrationFixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
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
