[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Description,
    [string]$Workspace = (Get-Location).Path,
    [string]$InstallRoot = 'C:\AI-Harness',
    [string]$TaskId,
    [string]$Preset,
    [Alias('force')][string]$ForceTier,
    [string]$ForceClass,
    [ValidateSet('none', 'progress', 'minor-error', 'attempt-failure', 'verification-failure', 'critical-security-boundary', 'concurrency-uncertainty', 'migration-safety', 'auth-permission-architecture', 'user-codex', 'review-findings')]
    [string]$Signal = 'none',
    [string]$FailureReason,
    [switch]$UserApprovedCodexSolve,
    [Alias('dry-run')][switch]$DryRun,
    [switch]$History
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Routing.ps1')
. (Join-Path $PSScriptRoot 'TaskController.ps1')
$layout = Get-AihLayout $InstallRoot
$historyPath = Join-Path $layout.RoutingData 'decisions.jsonl'
if ($History) {
    if (-not (Test-Path -LiteralPath $historyPath)) { @(); exit 0 }
    Get-Content -LiteralPath $historyPath | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { [string]::IsNullOrWhiteSpace($TaskId) -or $_.taskId -eq $TaskId } | ConvertTo-Json -Depth 8
    exit 0
}
if ([string]::IsNullOrWhiteSpace($Description)) { throw 'A task description is required unless -History is used.' }
$decision = Invoke-AihRoutingDecision -Description $Description -Workspace $Workspace -PolicyPath $layout.RoutingPolicy -DataRoot $layout.RoutingData -TaskId $TaskId -Preset $Preset -ForceTier $ForceTier -ForceClass $ForceClass -Signal $Signal -FailureReason $FailureReason -UserApprovedCodexSolve:$UserApprovedCodexSolve -DryRun:$DryRun
if (-not $DryRun -and (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetFullPath($Workspace)) '.ai-harness\state\tasks.json'))) {
    try { Set-AihTaskExecutionClass -Workspace $Workspace -TaskId $decision.taskId -ExecutionClass $decision.executionClass -Reason $decision.reason | Out-Null }
    catch { if ($_.Exception.Message -notmatch 'Task was not found') { throw } }
}
$decision | ConvertTo-Json -Depth 8
