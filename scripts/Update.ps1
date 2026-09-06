[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$SourceRoot
)

# Platform-aware update driver.
#
# Windows: delegates to scripts/Setup.ps1 (historical behavior, unchanged).
# Linux:   delegates to the native POSIX installer setup.sh at the source
#          root. setup.sh re-provisions the pinned per-platform runtimes when
#          the pins moved, re-copies the source tree, and runs the SHARED
#          install composition (Complete-Install.ps1), which preserves user
#          settings, credentials, and controller state.

# Directly-invoked CLI entrypoint (aih-update): a fresh PowerShell process
# preloads NO Nexus functions, so the platform abstraction is dot-sourced
# HERE, from this script's own directory, before the first platform-owned
# call. Platform.ps1 - not Common.ps1 - keeps this entrypoint dependency-
# minimal and independently executable (TASK-0027 aih-update regression).
. (Join-Path $PSScriptRoot 'Platform.ps1')

# TASK-0030 root-resolution contract: InstallRoot is explicit -InstallRoot >
# AIH_INSTALL_ROOT (exported by the installed launchers) > the tree this
# script belongs to; SourceRoot is explicit -SourceRoot > persisted
# installation source metadata > this tree ONLY when it is positively
# identified as a Nexus source checkout. An explicit -SourceRoot therefore
# NEVER retargets the installation root, and a same-root resolution fails
# closed unless the tree is a legitimate source plane.
$updateRoots = Resolve-AihUpdateRoots -InstallRoot $InstallRoot -SourceRoot $SourceRoot `
    -StructuralRoot ([System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)))
$SourceRoot = $updateRoots.SourceRoot
$InstallRoot = $updateRoots.InstallRoot
Write-Host ("Nexus update source: " + $SourceRoot)
Write-Host ("Nexus install root: " + $InstallRoot)

if (Test-AihIsWindows) {
    $setup = Join-Path $SourceRoot 'scripts/Setup.ps1'
    if (-not (Test-Path -LiteralPath $setup)) {
        throw "Update source does not contain scripts\\Setup.ps1: $SourceRoot"
    }
    # Setup.ps1 is a PowerShell script, not a native executable: it defines
    # no process exit code, and its failures are terminating errors that
    # propagate to this caller (it runs under Set-StrictMode with
    # $ErrorActionPreference = 'Stop' and throws on every failure path).
    # TASK-0032: the old native-exit-code read after this invocation was
    # undefined (or stale from an unrelated earlier native command) and
    # aborted successful updates.
    & $setup -InstallRoot $InstallRoot
}
else {
    $setup = Join-Path $SourceRoot 'setup.sh'
    if (-not (Test-Path -LiteralPath $setup)) {
        throw "Update source does not contain setup.sh: $SourceRoot"
    }
    & 'bash' $setup --install-root $InstallRoot --skip-deepseek-login --skip-openai-login --skip-path-check
    if ($LASTEXITCODE -ne 0) { throw 'Nexus update failed.' }
}
