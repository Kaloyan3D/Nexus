[CmdletBinding()]
param(
    [string]$Workspace = (Get-Location).Path,
    [string]$InstallRoot,
    [switch]$Json
)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Project.ps1')

$profile = Get-AihProjectProfile -Workspace $Workspace -InstallRoot $InstallRoot
if ($Json) {
    $profile | ConvertTo-Json -Depth 8
    exit 0
}

Write-Host "Project: $($profile.Name)"
Write-Host "Workspace: $($profile.Workspace)"
Write-Host "Git repository: $($profile.IsGitRepository)"
Write-Host "Stacks: $(if ($profile.Stacks.Count) { $profile.Stacks -join ', ' } else { 'none detected' })"
Write-Host "Verification mode: $($profile.LocalVerificationMode)"
if ($profile.VerificationCommands.Count) {
    Write-Host 'Deterministic verification:'
    foreach ($command in $profile.VerificationCommands) {
        $availability = if ($command.Available) { 'ready' } else { 'tool missing' }
        Write-Host "  [$($command.Kind)] $($command.Name): $($command.Display) ($availability)"
    }
}
else { Write-Host 'Deterministic verification: no commands discovered' }
if ($profile.Recommendations.Count) {
    Write-Host 'Recommendations:'
    foreach ($recommendation in $profile.Recommendations) { Write-Host "  - $recommendation" }
}
