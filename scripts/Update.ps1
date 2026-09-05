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

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $SourceRoot = Split-Path -Parent $PSScriptRoot
}
$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = $SourceRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

if (Test-AihIsWindows) {
    $setup = Join-Path $SourceRoot 'scripts/Setup.ps1'
    if (-not (Test-Path -LiteralPath $setup)) {
        throw "Update source does not contain scripts\\Setup.ps1: $SourceRoot"
    }
    & $setup -InstallRoot $InstallRoot
    if ($LASTEXITCODE -ne 0) { throw 'Nexus update failed.' }
}
else {
    $setup = Join-Path $SourceRoot 'setup.sh'
    if (-not (Test-Path -LiteralPath $setup)) {
        throw "Update source does not contain setup.sh: $SourceRoot"
    }
    & 'bash' $setup --install-root $InstallRoot --skip-deepseek-login --skip-openai-login --skip-path-check
    if ($LASTEXITCODE -ne 0) { throw 'Nexus update failed.' }
}
