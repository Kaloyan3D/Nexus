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

$projectProfile = Get-AihProjectProfile -Workspace $Workspace -InstallRoot $InstallRoot
if ($Json) {
    $projectProfile | ConvertTo-Json -Depth 8
    exit 0
}

Write-Host "Project: $($projectProfile.Name)"
Write-Host "Workspace: $($projectProfile.Workspace)"
Write-Host "Git repository: $($projectProfile.IsGitRepository)"
Write-Host "Stacks: $(if ($projectProfile.Stacks.Count) { $projectProfile.Stacks -join ', ' } else { 'none detected' })"
Write-Host "Verification mode: $($projectProfile.LocalVerificationMode)"
if ($projectProfile.VerificationCommands.Count) {
    Write-Host 'Deterministic verification:'
    foreach ($command in $projectProfile.VerificationCommands) {
        $availability = if ($command.Available) { 'ready' } else { 'tool missing' }
        Write-Host "  [$($command.Kind)] $($command.Name): $($command.Display) ($availability)"
    }
}
else { Write-Host 'Deterministic verification: no commands discovered' }
if ($projectProfile.Recommendations.Count) {
    Write-Host 'Recommendations:'
    foreach ($recommendation in $projectProfile.Recommendations) { Write-Host "  - $recommendation" }
}
