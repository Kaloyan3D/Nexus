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

# Non-interactive connection check. Reads metadata only, emits no secrets.
# Exit code 0 = connected, 1 = not connected (see the status lines).
$status = Get-AihClaudeStatus
Write-Host ("Claude Code CLI installed: $($status.Installed)" + $(if ($status.Installed) { " ($($status.Version))" } else { ' (install the official CLI, then run Set-ClaudeSubscription.ps1)' }))
Write-Host "Claude subscription session present: $($status.SessionPresent)"
if ($status.ApiBillingRisk) {
    Write-Warning 'ANTHROPIC_API_KEY is set: subscription-agent execution would refuse to run without an explicit per-call API-billing opt-in.'
}
if ($status.Connected) {
    Write-Host 'Claude Pro/Max subscription is CONNECTED (native CLI session; subscription billing, never API billing by default).'
    exit 0
}
Write-Warning 'Claude Pro/Max subscription is NOT connected. Connect with: powershell -File scripts/Set-ClaudeSubscription.ps1  (or `claude login` directly).'
exit 1
