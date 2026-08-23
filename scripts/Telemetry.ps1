Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'TaskController.ps1')

function Write-AihTaskTelemetry {
    param([string]$Workspace,[string]$TaskId,[hashtable]$Metrics)
    $layout=Initialize-AihTaskLedger $Workspace;$task=Get-AihTask $Workspace $TaskId
    function Metric([string]$Name,$Default){if($Metrics.ContainsKey($Name)-and $null-ne $Metrics[$Name]){$Metrics[$Name]}else{$Default}}
    $record=[ordered]@{schemaVersion=1;taskId=$TaskId;timestampUtc=[DateTime]::UtcNow.ToString('o');executionClass=(Metric executionClass $task.executionClass);model=(Metric model $null);provider=(Metric provider $null);modelCalls=[int](Metric modelCalls 0);usageAvailable=[bool](Metric usageAvailable $false);inputTokens=[int](Metric inputTokens 0);cachedTokens=[int](Metric cachedTokens 0);outputTokens=[int](Metric outputTokens 0);costProxy=(Metric costProxy $null);contextSize=[int](Metric contextSize 0);filesSupplied=[int](Metric filesSupplied 0);filesModified=[int](Metric filesModified 0);diffLines=[int](Metric diffLines 0);attempts=[int]$task.attempt;failureSignatures=@($task.failureSignatures);verificationOutcomes=@($task.verification.outcomes);codexCalls=[int]$task.codexCalls;codexFindings=@(Metric codexFindings @());finalResult=(Metric finalResult $null);elapsedSeconds=(Metric elapsedSeconds $null);configuration=(Metric configuration $null)}
    Write-AihAtomicJson (Join-Path (Join-Path $layout.Runs $TaskId) 'telemetry.json') $record
    [pscustomobject]$record
}

function New-AihEvaluationResult {
    param([string]$Workspace,[string]$TaskId,[ValidateSet('current','deepseek-only','deepseek-codex-review','future')][string]$Configuration,[string]$Result)
    [pscustomobject]@{schemaVersion=1;taskId=$TaskId;configuration=$Configuration;result=$Result;recordedAtUtc=[DateTime]::UtcNow.ToString('o')}
}
