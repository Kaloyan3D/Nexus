[CmdletBinding()]
param([string]$InstallRoot)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')
$null = Get-AihLayout $InstallRoot

# Disconnects the Claude subscription by asking the CLI to clear its OWN
# session (native auth logout). Nexus never touches credential storage
# itself and never clears anything beyond the CLI-owned session.
$claudeExe = Get-AihClaudeExecutable
if ([string]::IsNullOrWhiteSpace($claudeExe)) {
    Write-Warning 'Claude Code CLI is not installed; nothing to disconnect.'
    exit 0
}
& $claudeExe auth logout
if ($LASTEXITCODE -ne 0) {
    throw 'Claude logout did not complete successfully.'
}
Write-Host 'Claude subscription session cleared via native CLI logout.'
