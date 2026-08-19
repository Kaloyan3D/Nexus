[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Description,
    [string]$Workspace = (Get-Location).Path,
    [string]$InstallRoot = 'C:\AI-Harness',
    [string]$TaskId,
    [string]$Preset,
    [Alias('force')][string]$ForceTier,
    [ValidateSet('none', 'progress', 'minor-error', 'attempt-failure', 'verification-failure', 'blocker', 'serious-uncertainty', 'architecture-required', 'acceptance-unmet', 'broad-unrelated-changes', 'tier2-failed')]
    [string]$Signal = 'none',
    [string]$FailureReason,
    [Alias('dry-run')][switch]$DryRun,
    [switch]$History
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Routing.ps1')
$layout = Get-AihLayout $InstallRoot
$historyPath = Join-Path $layout.RoutingData 'decisions.jsonl'
if ($History) {
    if (-not (Test-Path -LiteralPath $historyPath)) { @(); exit 0 }
    Get-Content -LiteralPath $historyPath | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { [string]::IsNullOrWhiteSpace($TaskId) -or $_.taskId -eq $TaskId } | ConvertTo-Json -Depth 8
    exit 0
}
if ([string]::IsNullOrWhiteSpace($Description)) { throw 'A task description is required unless -History is used.' }
$decision = Invoke-AihRoutingDecision -Description $Description -Workspace $Workspace -PolicyPath $layout.RoutingPolicy -DataRoot $layout.RoutingData -TaskId $TaskId -Preset $Preset -ForceTier $ForceTier -Signal $Signal -FailureReason $FailureReason -DryRun:$DryRun
$decision | ConvertTo-Json -Depth 8
