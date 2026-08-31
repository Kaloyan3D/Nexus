[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Description,
    [string]$Workspace = (Get-Location).Path,
    [string]$InstallRoot,
    [string]$TaskId,
    [string]$Preset,
    [Alias('force')][string]$ForceTier,
    [string]$ForceClass,
    [ValidateSet('none', 'progress', 'minor-error', 'attempt-failure', 'verification-failure', 'critical-security-boundary', 'concurrency-uncertainty', 'migration-safety', 'auth-permission-architecture', 'user-codex', 'review-findings')]
    [string]$Signal = 'none',
    [string]$FailureReason,
    [switch]$UserApprovedCodexSolve,
    [switch]$ReviewRequested,
    [Alias('dry-run')][switch]$DryRun,
    [switch]$History,
    [string]$PayloadFile
)
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

# User-derived free text must not travel on the command line (ANSI codepage
# mangling + unescaped control characters in ConvertTo-Json break the
# controller bridge's strict JSON parse). The bridge writes a UTF-8 payload
# file and names it here.
if ($PayloadFile) {
    if (-not (Test-Path -LiteralPath $PayloadFile)) { throw "Payload file not found: $PayloadFile" }
    $__aihPayload = Get-Content -Raw -Encoding UTF8 -LiteralPath $PayloadFile | ConvertFrom-Json
    if ($null -ne $__aihPayload.PSObject.Properties['Workspace']) { $Workspace = [string]$__aihPayload.Workspace }
    if ($null -ne $__aihPayload.PSObject.Properties['Description']) { $Description = [string]$__aihPayload.Description }
    if ($null -ne $__aihPayload.PSObject.Properties['ReviewRequested']) { $ReviewRequested = [bool]$__aihPayload.ReviewRequested }
    if ($null -ne $__aihPayload.PSObject.Properties['Signal']) { $Signal = [string]$__aihPayload.Signal }
    if ($null -ne $__aihPayload.PSObject.Properties['FailureReason']) { $FailureReason = [string]$__aihPayload.FailureReason }
}

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Routing.ps1')
. (Join-Path $PSScriptRoot 'TaskController.ps1')
$layout = Get-AihLayout $InstallRoot
$historyPath = Join-Path $layout.RoutingData 'decisions.jsonl'
if ($History) {
    if (-not (Test-Path -LiteralPath $historyPath)) { @(); exit 0 }
    Get-Content -Encoding UTF8 -LiteralPath $historyPath | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { [string]::IsNullOrWhiteSpace($TaskId) -or $_.taskId -eq $TaskId } | ConvertTo-Json -Depth 8
    exit 0
}
if ([string]::IsNullOrWhiteSpace($Description)) { throw 'A task description is required unless -History is used.' }
$decision = Invoke-AihRoutingDecision -Description $Description -Workspace $Workspace -PolicyPath $layout.RoutingPolicy -DataRoot $layout.RoutingData -TaskId $TaskId -Preset $Preset -ForceTier $ForceTier -ForceClass $ForceClass -Signal $Signal -FailureReason $FailureReason -UserApprovedCodexSolve:$UserApprovedCodexSolve -ReviewRequested:$ReviewRequested -DryRun:$DryRun -SettingsPath $layout.Settings -CustomProfilePath $layout.CustomEngineeringProfile
if (-not $DryRun -and (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetFullPath($Workspace)) '.ai-harness\state\tasks.json'))) {
    try { Set-AihTaskExecutionClass -Workspace $Workspace -TaskId $decision.taskId -ExecutionClass $decision.executionClass -Reason $decision.reason | Out-Null }
    catch { if ($_.Exception.Message -notmatch 'Task was not found') { throw } }
}
$decision | ConvertTo-Json -Depth 8
