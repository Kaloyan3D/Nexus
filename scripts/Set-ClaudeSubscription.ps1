[CmdletBinding()]
param([string]$InstallRoot)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')
$layout = Get-AihLayout $InstallRoot

# The official Claude Code CLI owns the entire login lifecycle. Nexus never
# receives, stores, or forwards any Claude OAuth token: the CLI writes its
# Pro/Max session under the user profile directory itself.
$claudeExe = Get-AihClaudeExecutable
if ([string]::IsNullOrWhiteSpace($claudeExe)) {
    throw 'Claude Code CLI is not installed. Install the official Claude Code CLI first (your package manager or the official installer), verify `claude --version`, then rerun this script.'
}

$apiKey = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY')
if (-not [string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Warning 'ANTHROPIC_API_KEY is set in this environment. The subscription adapter refuses silent API billing: unset it before connecting, or pass an explicit per-call opt-in at execution time.'
}

Write-Host 'Sign in with your own Claude Pro/Max account in the browser session started below.'
Write-Host 'The repository never receives or stores your Claude token.'
Write-Host 'The official Claude Code CLI writes its session under your user profile directory.'
& $claudeExe login
if ($LASTEXITCODE -ne 0) {
    throw 'Claude subscription login did not complete successfully.'
}

$session = Get-AihClaudeSessionMeta
if (($null -eq $session) -or ($session.SizeBytes -le 0)) {
    throw 'Login completed without creating the expected Claude CLI session file.'
}
Write-Host 'Claude Pro/Max subscription is connected for this user account (session metadata observed; no token handled).'
