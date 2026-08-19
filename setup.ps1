[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\AI-Harness',
    [switch]$SkipPathUpdate,
    [switch]$SkipDeepSeekLogin,
    [switch]$SkipOpenAiLogin
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
    throw 'AI Harness currently supports Windows only.'
}

$sourceRoot = $PSScriptRoot
$installer = Join-Path $sourceRoot 'scripts\Setup.ps1'

Write-Host '1/4 Installing the pinned AI Harness runtime...'
& $installer -InstallRoot $InstallRoot -SkipPathUpdate:$SkipPathUpdate
if ($LASTEXITCODE -ne 0) { throw 'Harness installation failed.' }

if (-not $SkipDeepSeekLogin) {
    Write-Host '2/4 Configuring DeepSeek (the key input is hidden)...'
    & (Join-Path $InstallRoot 'scripts\Set-DeepSeekKey.ps1') -InstallRoot $InstallRoot
}
else {
    Write-Host '2/4 Skipping DeepSeek credential setup.'
}

if (-not $SkipOpenAiLogin) {
    Write-Host '3/4 Starting the ChatGPT/Codex sign-in flow...'
    & (Join-Path $InstallRoot 'scripts\Set-OpenAiOAuth.ps1') -InstallRoot $InstallRoot
}
else {
    Write-Host '3/4 Skipping ChatGPT/Codex sign-in.'
}

Write-Host '4/4 Running local checks...'
. (Join-Path $InstallRoot 'scripts\Common.ps1')
$hasDeepSeekCredential = -not [string]::IsNullOrWhiteSpace((Get-AihDeepSeekKey -InstallRoot $InstallRoot))
if ($hasDeepSeekCredential) {
    & (Join-Path $InstallRoot 'scripts\Doctor.ps1') -InstallRoot $InstallRoot -Preset $(if ($SkipOpenAiLogin) { 'deepseek' } else { 'normal' }) -Offline
}
else {
    Write-Host 'DeepSeek is not configured yet; running credential-free deterministic tests instead.'
    & (Join-Path $InstallRoot 'scripts\Test-Harness.ps1') -InstallRoot $InstallRoot
}
if ($LASTEXITCODE -ne 0) {
    throw "Setup completed, but local checks failed. Run: $InstallRoot\bin\aih-doctor.cmd -Offline"
}

Write-Host ''
Write-Host 'Setup complete. Open a new terminal, enter a project directory, and run: aih'
Write-Host 'DeepSeek-only mode: aih -Preset deepseek'
