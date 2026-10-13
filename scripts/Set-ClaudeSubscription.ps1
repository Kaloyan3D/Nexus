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

# The official Claude Code CLI owns the entire login lifecycle through its
# native auth commands. Nexus never receives, stores, or forwards any
# Claude credential: the CLI keeps its Pro/Max session itself on every OS.
$claudeExe = Get-AihClaudeExecutable
if ([string]::IsNullOrWhiteSpace($claudeExe)) {
    throw 'Claude Code CLI is not installed. Install the official Claude Code CLI first (your package manager or the official installer), verify `claude --version`, then rerun this script.'
}

foreach ($override in @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX')) {
    if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($override))) {
        Write-Warning ("Environment override is set: $override. The subscription adapter refuses silent non-subscription billing: unset it before connecting, or pass an explicit per-call opt-in at execution time.")
    }
}

Write-Host 'Sign in with your own Claude Pro/Max account in the browser session started below.'
Write-Host 'The repository never receives or stores your Claude credentials.'
Write-Host 'The official Claude Code CLI keeps its session itself (native auth storage on your OS).'
& $claudeExe auth login
if ($LASTEXITCODE -ne 0) {
    throw 'Claude subscription login did not complete successfully.'
}

$status = Get-AihClaudeStatus
if (-not $status.Connected) {
    throw ("Login finished but native auth status does not confirm a subscription (state: $($status.AuthState)). Reconnect with 'claude auth login', or run Test-ClaudeConnection.ps1 for diagnostics.")
}
Write-Host 'Claude Pro/Max subscription is connected for this user account (verified via native auth status; no credentials handled).'
