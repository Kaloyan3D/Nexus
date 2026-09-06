[CmdletBinding()]
param([string]$InstallRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

# TASK-0030: the updater root-resolution contract, guarded permanently.
#
# Reproduction (CachyOS): 'aih-update -SourceRoot <checkout>' on an installed
# POSIX Nexus printed "Nexus install root: <checkout>" and setup.sh died with
# "cp: '...' and '...' are the same file". scripts/Update.ps1 resolved a
# missing -InstallRoot to the RESOLVED SOURCE root, so an explicit -SourceRoot
# silently retargeted the installation root, and the AIH_INSTALL_ROOT value
# the installed POSIX launcher exports was ignored. The same defect made a
# plain no-argument aih-update on an installed tree target the installed copy
# as its own update source.
#
# Contract asserted here (single authoritative precedence):
#   InstallRoot: explicit -InstallRoot > $env:AIH_INSTALL_ROOT > the tree
#                scripts/Update.ps1 itself belongs to (structural fallback).
#   SourceRoot:  explicit -SourceRoot > persisted installation source
#                metadata (<installRoot>/data/install-source-root, written by
#                the installers) > the structural tree ONLY when it is
#                positively identified as a Nexus source checkout.
#   Same-root:   SourceRoot == InstallRoot fails closed unless that tree is
#                positively identified as a legitimate source plane (the
#                Windows checkout layout and an in-place checkout update).
#   Invocation:  the POSIX branch runs <sourceRoot>/setup.sh with
#                --install-root <installRoot>.
#
# Every probe is a brand-new, profile-less process (or a fresh in-process
# call against the foundation helpers in Platform.ps1) with the probe
# environment explicitly staged and restored; nothing is mocked into any
# session and nothing leaks between scenarios.

. (Join-Path $InstallRoot 'scripts/Platform.ps1')

$passed = 0
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }

$runningOnWindows = Test-AihIsWindows
$pathComparison = [StringComparison]::Ordinal
if ($runningOnWindows) { $pathComparison = [StringComparison]::OrdinalIgnoreCase }

function Assert-AihSamePath([string]$Actual, [string]$Expected, [string]$Name) {
    $actualFull = [System.IO.Path]::GetFullPath($Actual)
    $expectedFull = [System.IO.Path]::GetFullPath($Expected)
    Assert-Aih ([System.String]::Equals($actualFull, $expectedFull, $pathComparison)) ($Name + ' (actual: ' + $actualFull + ', expected: ' + $expectedFull + ')')
}

function Clear-AihProbeEnvironment {
    Remove-Item Env:AIH_INSTALL_ROOT -ErrorAction SilentlyContinue
    Remove-Item Env:AIH_RECORDER_FILE -ErrorAction SilentlyContinue
}

# TASK-0033: POSIX shell fixture writing. This suite file itself is checked
# out with CRLF (*.ps1 text eol=crlf), so every here-string in it carries
# CRLF at parse time, and .gitattributes cannot normalize a GENERATED file
# that never passes through Git. Those CR bytes made Linux /bin/sh die on
# the generated fixture setup.sh with "$'{\r': command not found" and
# "syntax error near unexpected token `}'". Every generated shell script is
# therefore written explicitly UTF-8 without BOM and LF-only: CRLF becomes
# LF first, then any lone CR becomes LF - independent of the line endings
# the host checkout gave this file.
function ConvertTo-AihPosixShellText {
    param([Parameter(Mandatory = $true)][string]$Text)
    return $Text.Replace("`r`n", "`n").Replace("`r", "`n")
}

function Write-AihPosixShellScript {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )
    [IO.File]::WriteAllText($Path, (ConvertTo-AihPosixShellText -Text $Text), [Text.UTF8Encoding]::new($false))
}

function New-AihSourceCheckoutFixture {
    # A minimal but POSITIVELY IDENTIFIABLE Nexus source checkout: the
    # checkout-only marker (bin/linux POSIX twin templates, absent from every
    # installed layout) plus the completeness markers the installers gate on.
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$RecorderFile
    )
    New-Item -ItemType Directory -Force -Path (Join-Path $Root 'bin/linux'), (Join-Path $Root 'config'), (Join-Path $Root 'scripts') | Out-Null
    Write-AihPosixShellScript -Path (Join-Path $Root 'bin/linux/aih-update.sh') -Text ('#!/bin/sh' + "`n")
    [IO.File]::WriteAllText((Join-Path $Root 'bin/aih-update.cmd'), "@echo off" + [Environment]::NewLine)
    [IO.File]::WriteAllText((Join-Path $Root 'config/versions.json'), "{}" + [Environment]::NewLine)
    [IO.File]::WriteAllText((Join-Path $Root 'scripts/Common.ps1'), "# probe marker" + [Environment]::NewLine)
    # The POSIX recorder records the exact setup.sh invocation Update.ps1 makes.
    $posixRecorder = @'
#!/bin/sh
# TASK-0030 probe: record the exact setup.sh invocation Update.ps1 makes.
{
  printf '%s
' "$0"
  for _arg in "$@"; do printf '%s
' "$_arg"; done
} > "$AIH_RECORDER_FILE"
'@
    Write-AihPosixShellScript -Path (Join-Path $Root 'setup.sh') -Text $posixRecorder
    # TASK-0033 regression: the generated POSIX setup.sh must contain NO CR
    # (0x0D) bytes and no UTF-8 BOM. The check is byte-level and asserted on
    # every OS, so a CRLF-carrying checkout of this suite can never
    # reintroduce the Linux "$'{\r': command not found" fixture failure.
    $generatedSetupShBytes = [IO.File]::ReadAllBytes((Join-Path $Root 'setup.sh'))
    $generatedSetupShCrCount = 0
    foreach ($generatedSetupShByte in $generatedSetupShBytes) { if ($generatedSetupShByte -eq 13) { $generatedSetupShCrCount++ } }
    Assert-Aih ($generatedSetupShCrCount -eq 0) ('the generated POSIX setup.sh fixture is LF-only - no 0x0D bytes (' + $generatedSetupShBytes.Length + ' bytes inspected, TASK-0033)')
    $generatedSetupShHasBom = ($generatedSetupShBytes.Length -ge 3 -and $generatedSetupShBytes[0] -eq 239 -and $generatedSetupShBytes[1] -eq 187 -and $generatedSetupShBytes[2] -eq 191)
    Assert-Aih (-not $generatedSetupShHasBom) 'the generated POSIX setup.sh fixture is UTF-8 without BOM (TASK-0033)'
    # The Windows recorder records the Setup.ps1 delegation contract.
    $windowsRecorder = @'
param([string]$InstallRoot)
$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add('script=' + $PSCommandPath)
$lines.Add('installroot=' + $InstallRoot)
if ($env:AIH_RECORDER_FILE) { [System.IO.File]::WriteAllLines($env:AIH_RECORDER_FILE, $lines) }
'@
    [IO.File]::WriteAllText((Join-Path $Root 'scripts/Setup.ps1'), $windowsRecorder, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $RecorderFile) { Remove-Item -LiteralPath $RecorderFile -Force }
    [IO.File]::WriteAllText($RecorderFile, '')
}

function New-AihInstalledPosixFixture {
    # Mirrors the layout setup.sh publishes on POSIX: extensionless launchers
    # in bin/, copied scripts, NO bin/linux twin directory, and the installer
    # runtime anchored through the pinned pwsh of the RUNNING Nexus tree.
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string]$SourceMetadata
    )
    New-Item -ItemType Directory -Force -Path (Join-Path $Root 'bin'), (Join-Path $Root 'scripts'), (Join-Path $Root 'data') | Out-Null
    Copy-Item -LiteralPath (Join-Path $InstallRoot 'scripts/Update.ps1') -Destination (Join-Path $Root 'scripts/Update.ps1') -Force
    Copy-Item -LiteralPath (Join-Path $InstallRoot 'scripts/Platform.ps1') -Destination (Join-Path $Root 'scripts/Platform.ps1') -Force
    [IO.File]::WriteAllText((Join-Path $Root 'bin/aih'), '# installed-posix launcher marker' + [Environment]::NewLine)
    if ($runningOnWindows) {
        Copy-Item -LiteralPath (Join-Path $InstallRoot 'bin/aih-update.cmd') -Destination (Join-Path $Root 'bin/aih-update.cmd') -Force
    }
    else {
        # The aih-update launcher template lives in the SOURCE plane only
        # (<sourceRoot>/bin/linux/aih-update.sh); an INSTALLED POSIX tree
        # publishes the canonical extensionless <installRoot>/bin/aih-update
        # and never carries bin/linux. Resolve through the layout-plane
        # abstraction so the fixture stages the launcher from whichever plane
        # the suite itself runs on (real installed-tree closure loop).
        $hostTreeLayout = Get-AihLauncherLayout -InstallRoot $InstallRoot
        $launcherTemplate = if ($hostTreeLayout.Kind -eq 'source') { Join-Path $hostTreeLayout.PosixTwinDirectory 'aih-update.sh' } else { Join-Path $hostTreeLayout.Bin 'aih-update' }
        if (-not (Test-Path -LiteralPath $launcherTemplate -PathType Leaf)) {
            throw "FAIL: the running tree exposes no aih-update launcher template on its own layout plane (kind '$($hostTreeLayout.Kind)': $launcherTemplate)."
        }
        Copy-Item -LiteralPath $launcherTemplate -Destination (Join-Path $Root 'bin/aih-update') -Force
        $probeHost = Get-AihPowerShellHost -InstallRoot $InstallRoot
        try {
            New-Item -ItemType Directory -Force -Path (Join-Path $Root 'runtime') | Out-Null
            New-Item -ItemType SymbolicLink -Path (Join-Path $Root 'runtime/pwsh') -Target (Split-Path -Parent $probeHost) -ErrorAction Stop | Out-Null
        }
        catch {
            # A runtime anchor is a convenience: the POSIX launcher falls back
            # to the system pwsh on PATH when runtime/pwsh/pwsh is absent.
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($SourceMetadata)) {
        [IO.File]::WriteAllText((Join-Path $Root 'data/install-source-root'), $SourceMetadata + [Environment]::NewLine)
    }
}

function Read-AihRecorderLines([Parameter(Mandatory = $true)][string]$RecorderFile) {
    return @(Get-Content -LiteralPath $RecorderFile | ForEach-Object { [string]$_ })
}

function Get-AihRecordedInvocationShape([string[]]$Recorded) {
    # TASK-0032: the recorder stub is plane-specific. On POSIX the recorded
    # setup.sh prints three lines ('<setup.sh>', '--install-root',
    # '<installRoot>'); on Windows the recorded Setup.ps1 prints
    # 'script=<path>' and 'installroot=<path>'. The asserted contract is the
    # same on both planes: the install composition is invoked from the
    # resolved SOURCE root with the resolved INSTALL root.
    if ($runningOnWindows) {
        $scriptLine = @($Recorded | Where-Object { $_.StartsWith('script=') })
        $installLine = @($Recorded | Where-Object { $_.StartsWith('installroot=') })
        if ($scriptLine.Count -ne 1 -or $installLine.Count -ne 1) {
            throw ('FAIL: the Windows Setup.ps1 recorder stub captured an unexpected invocation shape: ' + (@($Recorded) -join ' | '))
        }
        return [pscustomobject]@{
            Source = $scriptLine[0].Substring('script='.Length)
            InstallRoot = $installLine[0].Substring('installroot='.Length)
            ArgumentCount = $Recorded.Count
        }
    }
    if ($Recorded.Count -lt 3) {
        throw ('FAIL: the recording setup.sh captured an unexpected invocation shape: ' + (@($Recorded) -join ' | '))
    }
    return [pscustomobject]@{
        Source = $Recorded[0]
        InstallRoot = $Recorded[2]
        ArgumentCount = $Recorded.Count
    }
}

$updateProbeHost = if ($runningOnWindows) { 'powershell.exe' } else { Get-AihPowerShellHost -InstallRoot $InstallRoot }
$savedInstallRootEnv = $env:AIH_INSTALL_ROOT
$savedRecorderEnv = $env:AIH_RECORDER_FILE
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('aih-update-roots-' + [guid]::NewGuid().ToString('N'))
try {
    # -- fixtures --
    $checkoutFixture = Join-Path $tempRoot 'nexus source checkout'   # SPACE: exercises spaced paths end-to-end
    $recorderFile = Join-Path $tempRoot 'recorder.txt'
    New-AihSourceCheckoutFixture -Root $checkoutFixture -RecorderFile $recorderFile
    $installFixture = Join-Path $tempRoot 'installed nexus'
    New-AihInstalledPosixFixture -Root $installFixture -SourceMetadata $checkoutFixture
    $installNoMetaFixture = Join-Path $tempRoot 'installed-nexus-no-metadata'
    New-AihInstalledPosixFixture -Root $installNoMetaFixture -SourceMetadata $null
    $secondInstall = Join-Path $tempRoot 'second install root'
    $staleMetaFixture = Join-Path $tempRoot 'installed-nexus-stale-metadata'
    New-AihInstalledPosixFixture -Root $staleMetaFixture -SourceMetadata (Join-Path $tempRoot 'deleted-checkout')

    # ==== Section 1: fresh-process end-to-end probes through the REAL launcher ====
    # The staged installed fixture carries REAL copies of scripts/Update.ps1
    # and scripts/Platform.ps1 exactly like setup.sh publishes them, so every
    # probe below exercises the production root-resolution path.

    # Regression 1 + 2 + 4 + 6 + 8: installed Linux launcher + explicit
    # -SourceRoot. The launcher exports AIH_INSTALL_ROOT=<install>; the
    # explicit source must NOT retarget it, and the recording setup.sh proves
    # the exact invocation contract.
    Clear-AihProbeEnvironment
    Set-Item Env:AIH_RECORDER_FILE -Value $recorderFile
    $launcherPath = Join-Path $installFixture 'bin/aih-update'
    if ($runningOnWindows) { $launcherPath = Join-Path $installFixture 'bin/aih-update.cmd' }
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        if ($runningOnWindows) {
            $probeOutput = & $launcherPath -SourceRoot $checkoutFixture 2>&1 | ForEach-Object { [string]$_ }
        }
        else {
            $probeOutput = & 'sh' $launcherPath -SourceRoot $checkoutFixture 2>&1 | ForEach-Object { [string]$_ }
        }
        $probeExit = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    $probeText = (@($probeOutput) -join ' ')
    Assert-Aih ($probeExit -eq 0) ('aih-update -SourceRoot succeeds on an installed POSIX layout (exit ' + $probeExit + '): ' + $probeText)
    # TASK-0032: the recorder stub is plane-specific (POSIX setup.sh prints
    # '$0', '--install-root', <installRoot>; Windows Setup.ps1 prints
    # 'script=<path>', 'installroot=<path>'), but the asserted contract is the
    # SAME on both planes: the install composition is invoked from the
    # resolved SOURCE root with the resolved INSTALL root, and an explicit
    # -SourceRoot never retargets the install root.
    $expectedComposition = if ($runningOnWindows) { Join-Path $checkoutFixture 'scripts/Setup.ps1' } else { Join-Path $checkoutFixture 'setup.sh' }
    $recorded = Read-AihRecorderLines -RecorderFile $recorderFile
    $invocation = Get-AihRecordedInvocationShape -Recorded $recorded
    if ($runningOnWindows) {
        Assert-Aih ($recorded.Count -ge 2) ('the recording Setup.ps1 captured the invocation (' + $recorded.Count + ' lines)')
    }
    else {
        Assert-Aih ($invocation.ArgumentCount -ge 3) ('the recording setup.sh captured the invocation (' + $invocation.ArgumentCount + ' lines)')
        Assert-Aih ($recorded[1] -eq '--install-root') 'setup.sh receives --install-root as the first argument'
    }
    Assert-AihSamePath -Actual $invocation.Source -Expected $expectedComposition 'the install composition is invoked from the SOURCE root (spaced path honored end-to-end)'
    Assert-AihSamePath -Actual $invocation.InstallRoot -Expected $installFixture 'explicit -SourceRoot does not retarget the install root: the install root stays AIH_INSTALL_ROOT (regressions 1, 2, 4)'

    # Regression: the metadata layer drives a plain no-argument aih-update.
    Clear-AihProbeEnvironment
    Set-Item Env:AIH_RECORDER_FILE -Value $recorderFile
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        if ($runningOnWindows) {
            $probeOutput = & $launcherPath 2>&1 | ForEach-Object { [string]$_ }
        }
        else {
            $probeOutput = & 'sh' $launcherPath 2>&1 | ForEach-Object { [string]$_ }
        }
        $probeExit = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    $probeText = (@($probeOutput) -join ' ')
    Assert-Aih ($probeExit -eq 0) ('plain aih-update (no arguments) succeeds on an installed POSIX layout through the persisted source metadata (exit ' + $probeExit + '): ' + $probeText)
    $recorded = Read-AihRecorderLines -RecorderFile $recorderFile
    $invocation = Get-AihRecordedInvocationShape -Recorded $recorded
    if ($runningOnWindows) {
        Assert-Aih ($recorded.Count -ge 2) 'the no-argument run reached the install composition (the old self-directory fallback never did)'
    }
    else {
        Assert-Aih ($invocation.ArgumentCount -ge 3) 'the no-argument run reached setup.sh (the old self-directory fallback never did)'
    }
    Assert-AihSamePath -Actual $invocation.Source -Expected $expectedComposition 'no-argument aih-update sources from the persisted installation source metadata checkout'
    Assert-AihSamePath -Actual $invocation.InstallRoot -Expected $installFixture 'no-argument aih-update installs into the launcher-resolved install root'

    # Regression 3: explicit -InstallRoot overrides AIH_INSTALL_ROOT.
    Clear-AihProbeEnvironment
    Set-Item Env:AIH_RECORDER_FILE -Value $recorderFile
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        if ($runningOnWindows) {
            $probeOutput = & $launcherPath -SourceRoot $checkoutFixture -InstallRoot $secondInstall 2>&1 | ForEach-Object { [string]$_ }
        }
        else {
            $probeOutput = & 'sh' $launcherPath -SourceRoot $checkoutFixture -InstallRoot $secondInstall 2>&1 | ForEach-Object { [string]$_ }
        }
        $probeExit = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    $probeText = (@($probeOutput) -join ' ')
    Assert-Aih ($probeExit -eq 0) ('aih-update -SourceRoot -InstallRoot succeeds (exit ' + $probeExit + '): ' + $probeText)
    $recorded = Read-AihRecorderLines -RecorderFile $recorderFile
    $invocation = Get-AihRecordedInvocationShape -Recorded $recorded
    if ($runningOnWindows) {
        Assert-Aih ($recorded.Count -ge 2) 'the -InstallRoot override run reached the install composition'
    }
    else {
        Assert-Aih ($invocation.ArgumentCount -ge 3) 'the -InstallRoot override run reached setup.sh'
    }
    Assert-AihSamePath -Actual $invocation.InstallRoot -Expected $secondInstall 'explicit -InstallRoot overrides the launcher-exported AIH_INSTALL_ROOT (regression 3)'

    # Regression 5 (end-to-end): SourceRoot == InstallRoot on an installed
    # POSIX tree fails closed with the positive-identification message, not
    # with a mid-install copy error.
    Clear-AihProbeEnvironment
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $probeOutput = & $updateProbeHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $installNoMetaFixture 'scripts/Update.ps1') -SourceRoot $installNoMetaFixture 2>&1 | ForEach-Object { [string]$_ }
        $probeExit = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    $probeText = (@($probeOutput) -join ' ')
    Assert-Aih ($probeExit -ne 0) 'same-root update on an installed POSIX tree fails closed (regression 5)'
    Assert-Aih ($probeText -like '*not positively identified*') ('the same-root failure names the positive-identification contract, not a copy error: ' + $probeText)

    # ==== Section 2: the resolution contract, in-process ====

    # The REAL running tree satisfies the identification contract of its own
    # layout plane: a checkout plane is positively identified as a source
    # checkout; an installed plane is NOT (the bin/linux marker is decisive on
    # the real install too) and its persisted source metadata - when the new
    # installers have written it - must name a positively identified checkout.
    $runningTreeLayout = Get-AihLauncherLayout -InstallRoot $InstallRoot
    $persistedRealSource = Get-AihPersistedSourceRoot -InstallRoot $InstallRoot
    if ($runningTreeLayout.Kind -eq 'source') {
        Assert-Aih (Test-AihNexusSourceCheckout -Root $InstallRoot) 'the real running checkout is positively identified as a source checkout'
    }
    else {
        Assert-Aih (-not (Test-AihNexusSourceCheckout -Root $InstallRoot)) 'the real running installed tree is NOT identified as a source checkout'
        if (-not [string]::IsNullOrWhiteSpace($persistedRealSource)) {
            Assert-Aih (Test-AihNexusSourceCheckout -Root $persistedRealSource) ('the real install persisted metadata names a positively identified source checkout: ' + $persistedRealSource)
        }
    }
    Assert-Aih (-not (Test-AihNexusSourceCheckout -Root $installFixture)) 'an installed POSIX layout is NOT identified as a source checkout (bin/linux twin marker is decisive)'

    # Regression 2 (function level): AIH_INSTALL_ROOT is honored.
    Clear-AihProbeEnvironment
    Set-Item Env:AIH_INSTALL_ROOT -Value $installFixture
    $resolved = Resolve-AihUpdateRoots -SourceRoot $checkoutFixture -StructuralRoot $installNoMetaFixture
    Assert-AihSamePath -Actual $resolved.InstallRoot -Expected $installFixture 'AIH_INSTALL_ROOT is honored when no explicit -InstallRoot is passed'
    Assert-Aih ($resolved.InstallRootOrigin -eq 'environment') 'the install root origin reports the environment layer'
    Assert-AihSamePath -Actual $resolved.SourceRoot -Expected $checkoutFixture 'the explicit source root survives environment resolution'

    # Regression 3 (function level): explicit -InstallRoot overrides the env.
    Clear-AihProbeEnvironment
    Set-Item Env:AIH_INSTALL_ROOT -Value $installFixture
    $resolved = Resolve-AihUpdateRoots -InstallRoot $secondInstall -SourceRoot $checkoutFixture -StructuralRoot $installNoMetaFixture
    Assert-AihSamePath -Actual $resolved.InstallRoot -Expected $secondInstall 'explicit -InstallRoot overrides AIH_INSTALL_ROOT'
    Assert-Aih ($resolved.InstallRootOrigin -eq 'explicit') 'the install root origin reports the explicit layer'

    # Regression 4 (function level): an explicit SourceRoot never implicitly
    # changes a separately known InstallRoot.
    Clear-AihProbeEnvironment
    Set-Item Env:AIH_INSTALL_ROOT -Value $installFixture
    $resolved = Resolve-AihUpdateRoots -SourceRoot $checkoutFixture -StructuralRoot $installNoMetaFixture
    Assert-Aih (-not [System.String]::Equals([IO.Path]::GetFullPath($resolved.SourceRoot), [IO.Path]::GetFullPath($resolved.InstallRoot), $pathComparison)) 'explicit -SourceRoot and the environment install root resolve to two DIFFERENT trees'
    Clear-AihProbeEnvironment
    $resolved = Resolve-AihUpdateRoots -SourceRoot $checkoutFixture -StructuralRoot $installNoMetaFixture
    Assert-AihSamePath -Actual $resolved.InstallRoot -Expected $installNoMetaFixture 'with no env and no explicit install root, the structural fallback is the tree Update.ps1 belongs to'
    Assert-Aih ($resolved.InstallRootOrigin -eq 'structural') 'the structural fallback is the last install-root layer'

    # Metadata layer (function level): persisted source metadata wins over
    # the structural self-directory.
    Clear-AihProbeEnvironment
    $resolved = Resolve-AihUpdateRoots -StructuralRoot $installFixture
    Assert-AihSamePath -Actual $resolved.SourceRoot -Expected $checkoutFixture 'persisted installation source metadata resolves the update source'
    Assert-Aih ($resolved.SourceRootOrigin -eq 'metadata') 'the source root origin reports the metadata layer'
    Assert-AihSamePath -Actual $resolved.InstallRoot -Expected $installFixture 'the metadata read is keyed by the RESOLVED install root'

    Clear-AihProbeEnvironment
    $threw = $false
    try { Resolve-AihUpdateRoots -StructuralRoot $staleMetaFixture | Out-Null } catch { $threw = $true }
    Assert-Aih $threw 'stale persisted metadata (source gone) fails closed instead of silently updating from another layer'

    Clear-AihProbeEnvironment
    $threw = $false
    try { Resolve-AihUpdateRoots -StructuralRoot $installNoMetaFixture | Out-Null } catch { $threw = $true }
    Assert-Aih $threw 'no explicit source, no metadata, and a non-checkout structural tree fails closed with guidance'

    Clear-AihProbeEnvironment
    $threw = $false
    try { Resolve-AihUpdateRoots -SourceRoot $installNoMetaFixture -StructuralRoot $installNoMetaFixture | Out-Null } catch { $threw = $true }
    Assert-Aih $threw 'an explicit same-root source on a non-checkout tree fails closed (regression 5, function level)'

    # Regression 5 + 7: same-root is ALLOWED exactly when the tree is a
    # positively identified source plane (the Windows checkout layout and an
    # in-place checkout update share this path).
    Clear-AihProbeEnvironment
    $resolved = Resolve-AihUpdateRoots -StructuralRoot $checkoutFixture
    Assert-AihSamePath -Actual $resolved.SourceRoot -Expected $checkoutFixture 'a positively identified checkout resolves itself as the source'
    Assert-Aih ($resolved.SourceRootOrigin -eq 'structural') 'the checkout self-directory is used ONLY after positive identification'
    Assert-AihSamePath -Actual $resolved.InstallRoot -Expected $checkoutFixture 'same-root checkout resolution keeps the checkout as the install root (the Windows layout)'
    Assert-AihSamePath -Actual $resolved.SourceRoot -Expected $resolved.InstallRoot 'same-root is legitimate when positively identified as a source plane (regressions 5 + 7)'

    # Regression 6 (function level): spaced paths round-trip through the
    # full-path normalization unchanged.
    Clear-AihProbeEnvironment
    $resolved = Resolve-AihUpdateRoots -InstallRoot $installFixture -SourceRoot $checkoutFixture -StructuralRoot $installNoMetaFixture
    Assert-AihSamePath -Actual $resolved.SourceRoot -Expected $checkoutFixture 'spaced source path round-trips the resolver'
    Assert-AihSamePath -Actual $resolved.InstallRoot -Expected $installFixture 'spaced install path round-trips the resolver'

    # ==== Section 3: plane delegation contracts ====

    $updateText = [System.IO.File]::ReadAllText((Join-Path $InstallRoot 'scripts/Update.ps1'))
    Assert-Aih ($updateText.Contains(". (Join-Path `$PSScriptRoot 'Platform.ps1')")) 'Update.ps1 still self-loads the platform abstraction before any platform-owned call (TASK-0027 contract)'
    Assert-Aih ($updateText.Contains("Join-Path `$SourceRoot 'setup.sh'")) 'Update.ps1 still delegates the POSIX update to <sourceRoot>/setup.sh'
    Assert-Aih ($updateText.Contains('& $setup -InstallRoot $InstallRoot')) 'Update.ps1 still delegates the Windows update to scripts/Setup.ps1 with -InstallRoot'
    Assert-Aih (-not $updateText.Contains('$InstallRoot = $SourceRoot')) 'Update.ps1 no longer aliases InstallRoot to SourceRoot (the reported defect)'

    if ($runningOnWindows) {
        # Regression 7 (Windows live): from a checkout, the structural install
        # root IS the checkout (same-root layout), and the Windows branch
        # delegates to the SOURCE checkout's Setup.ps1 with that root.
        Clear-AihProbeEnvironment
        Set-Item Env:AIH_RECORDER_FILE -Value $recorderFile
        $savedPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $probeOutput = & $updateProbeHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts/Update.ps1') -SourceRoot $checkoutFixture 2>&1 | ForEach-Object { [string]$_ }
            $probeExit = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = $savedPreference }
        $probeText = (@($probeOutput) -join ' ')
        # TASK-0032: a SUCCEEDING Setup.ps1 must complete the update. Setup.ps1
        # is a PowerShell script, so it defines no process exit code; the old
        # defect read the native LASTEXITCODE after this invocation, which was
        # undefined here and aborted a successful update under StrictMode.
        Assert-Aih ($probeExit -eq 0) ('Windows same-root checkout update via the real Update.ps1 succeeds; a succeeding Setup.ps1 must not be failed by a native-exit-code read (exit ' + $probeExit + ', TASK-0032): ' + $probeText)
        $recorded = Read-AihRecorderLines -RecorderFile $recorderFile
        $liveInvocation = Get-AihRecordedInvocationShape -Recorded $recorded
        Assert-AihSamePath -Actual $liveInvocation.Source -Expected (Join-Path $checkoutFixture 'scripts/Setup.ps1') 'the Windows branch invokes the SOURCE checkout Setup.ps1'
        Assert-AihSamePath -Actual $liveInvocation.InstallRoot -Expected $InstallRoot 'the Windows structural fallback targets the checkout itself (same-root install layout)'

        # TASK-0032: a FAILING Setup.ps1 must still fail the update. Its
        # terminating error propagates through the call operator as the
        # update's own failure - removing the meaningless exit-code read never
        # weakens failure detection.
        $failingFixture = Join-Path $tempRoot 'nexus source checkout failing setup'
        New-AihSourceCheckoutFixture -Root $failingFixture -RecorderFile $recorderFile
        $failingSetup = @'
param([string]$InstallRoot)
throw 'SETUP-STUB-TERMINATING-FAILURE'
'@
        [IO.File]::WriteAllText((Join-Path $failingFixture 'scripts/Setup.ps1'), $failingSetup, [Text.UTF8Encoding]::new($false))
        Clear-AihProbeEnvironment
        $savedPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $probeOutput = & $updateProbeHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts/Update.ps1') -SourceRoot $failingFixture 2>&1 | ForEach-Object { [string]$_ }
            $probeExit = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = $savedPreference }
        $failingProbeText = (@($probeOutput) -join ' ')
        Assert-Aih ($probeExit -ne 0) 'a failing Setup.ps1 fails the update as a terminating error (exit != 0, TASK-0032)'
        Assert-Aih ($failingProbeText.Contains('SETUP-STUB-TERMINATING-FAILURE')) ('the terminating Setup.ps1 failure propagates as the update failure itself: ' + $failingProbeText)
    }
    else {
        Write-Host 'NOTE: Windows live same-root probe runs on the Windows plane only; the plane-agnostic same-root contract is asserted above.'
    }
}
finally {
    Clear-AihProbeEnvironment
    if ($null -eq $savedInstallRootEnv) { Remove-Item Env:AIH_INSTALL_ROOT -ErrorAction SilentlyContinue } else { Set-Item Env:AIH_INSTALL_ROOT -Value $savedInstallRootEnv }
    if ($null -eq $savedRecorderEnv) { Remove-Item Env:AIH_RECORDER_FILE -ErrorAction SilentlyContinue } else { Set-Item Env:AIH_RECORDER_FILE -Value $savedRecorderEnv }
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ("RESULT: $passed root-resolution contract assertions passed.")
