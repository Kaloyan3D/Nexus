[CmdletBinding()]
param(
    [string]$InstallRoot,
    [switch]$SkipPathUpdate,
    [switch]$SkipDeepSeekLogin,
    [switch]$SkipOpenAiLogin
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
    throw 'This PowerShell entry point installs the Windows runtime only. On Linux, install Nexus natively with: ./setup.sh'
}

# Windows PowerShell 5.1 can evaluate parameter default expressions before
# $PSScriptRoot is populated. Resolve the checkout root in the script body
# instead of using $PSScriptRoot as a parameter default.
$sourceRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = $sourceRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$installer = Join-Path $sourceRoot 'scripts/Setup.ps1'

Write-Host "Nexus source: $sourceRoot"
Write-Host "Nexus install root: $InstallRoot"
Write-Host '1/4 Installing the pinned AI Harness runtime...'
# Setup.ps1 is a PowerShell script, not a native executable: it defines no
# process exit code, and its failures are terminating errors that propagate
# to this caller (it runs under Set-StrictMode with
# $ErrorActionPreference = 'Stop' and throws on every failure path).
# TASK-0033: the old native-exit-code read after this invocation was unset
# (a terminating StrictMode RuntimeException on a fresh process) or stale
# from an unrelated earlier native command - never the invoked script's result.
& $installer -InstallRoot $InstallRoot -SkipPathUpdate:$SkipPathUpdate

if (-not $SkipDeepSeekLogin) {
    Write-Host '2/4 Configuring DeepSeek (the key input is hidden)...'
    & (Join-Path $InstallRoot 'scripts/Set-DeepSeekKey.ps1') -InstallRoot $InstallRoot
}
else {
    Write-Host '2/4 Skipping DeepSeek credential setup.'
}

if (-not $SkipOpenAiLogin) {
    Write-Host '3/4 Starting the ChatGPT/Codex sign-in flow...'
    & (Join-Path $InstallRoot 'scripts/Set-OpenAiOAuth.ps1') -InstallRoot $InstallRoot
}
else {
    Write-Host '3/4 Skipping ChatGPT/Codex sign-in.'
}

Write-Host '4/4 Running local checks...'
# Doctor.ps1 and Test-Harness.ps1 are PowerShell scripts, not native
# executables: a failing local check terminates this process through their
# own `exit` on failure (or a propagating terminating error), so no
# exit-code read is defined here either. TASK-0033: the old $LASTEXITCODE
# read after these .ps1 invocations was unset (StrictMode
# RuntimeException) or stale - never the invoked script's result.
. (Join-Path $InstallRoot 'scripts/Common.ps1')
$hasDeepSeekCredential = -not [string]::IsNullOrWhiteSpace((Get-AihDeepSeekKey -InstallRoot $InstallRoot))
if ($hasDeepSeekCredential) {
    & (Join-Path $InstallRoot 'scripts/Doctor.ps1') -InstallRoot $InstallRoot -Preset $(if ($SkipOpenAiLogin) { 'deepseek' } else { 'normal' }) -Offline
}
else {
    Write-Host 'DeepSeek is not configured yet; running credential-free deterministic tests instead.'
    & (Join-Path $InstallRoot 'scripts/Test-Harness.ps1') -InstallRoot $InstallRoot
}

Write-Host ''
Write-Host 'Setup complete. Nexus is installed in this repository by default.'
Write-Host 'Open a new terminal, enter any project directory, and run: aih'
Write-Host 'DeepSeek-only mode: aih -Preset deepseek'
