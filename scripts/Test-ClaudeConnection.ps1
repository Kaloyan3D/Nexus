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

# Non-interactive connection check against the native auth status.
# Reads metadata and status labels only, emits no secrets.
# Exit code 0 = subscription connected, 1 = anything else.
$status = Get-AihClaudeStatus
Write-Host ("Claude Code CLI installed: $($status.Installed)" + $(if ($status.Installed) { " ($($status.Version))" } else { ' (install the official CLI, then run Set-ClaudeSubscription.ps1)' }))
Write-Host "Claude auth state (native): $($status.AuthState)"
if ($status.ApiBillingRisk) {
    Write-Warning 'Key or endpoint overrides are set (ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL): subscription-agent execution refuses to run without an explicit per-call opt-in.'
}
if ($status.AlternateProvider) {
    Write-Warning 'Cloud-provider routing overrides are set (Bedrock/Vertex): subscription billing is not established without an explicit per-call opt-in.'
}
if ($status.Connected) {
    Write-Host 'Claude Pro/Max subscription is CONNECTED (verified via native CLI auth status; subscription billing, never API billing by default).'
    exit 0
}
Write-Warning ("Claude Pro/Max subscription is NOT connected (state: $($status.AuthState)). Connect with: powershell -File scripts/Set-ClaudeSubscription.ps1  (or 'claude auth login' directly).")
exit 1
