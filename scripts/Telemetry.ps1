Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'TaskController.ps1')

function Write-AihTaskTelemetry {
    # executionClass ALWAYS reflects the task's real routing execution class.
    # Orthogonal verification capabilities (e.g. visual-review) must NOT be
    # persisted here as if they were execution classes; they are represented
    # through the optional -Capability / -Role parameters instead.
    # MODEL != ROLE != EXECUTION CLASS != PROVIDER != CAPABILITY
    param([string]$Workspace,[string]$TaskId,[hashtable]$Metrics,[string]$TaskInstanceId,$Capability=$null,$Role=$null,$Trigger=$null,$VisualIteration=$null,$VisualVerdict=$null,$VisualScore=$null,$AcceptedFindings=$null,$RejectedFindings=$null)
    $layout=Initialize-AihTaskLedger $Workspace;$task=Get-AihTask $Workspace $TaskId -TaskInstanceId $TaskInstanceId
    function Metric([string]$Name,$Default){if($Metrics.ContainsKey($Name)-and $null-ne $Metrics[$Name]){$Metrics[$Name]}else{$Default}}
    $record=[ordered]@{schemaVersion=1;taskId=$TaskId;taskInstanceId=$task.taskInstanceId;timestampUtc=[DateTime]::UtcNow.ToString('o');executionClass=(Metric executionClass $task.executionClass);model=(Metric model $null);provider=(Metric provider $null);modelCalls=[int](Metric modelCalls 0);usageAvailable=[bool](Metric usageAvailable $false);inputTokens=[int](Metric inputTokens 0);cachedTokens=[int](Metric cachedTokens 0);outputTokens=[int](Metric outputTokens 0);costProxy=(Metric costProxy $null);contextSize=[int](Metric contextSize 0);filesSupplied=[int](Metric filesSupplied 0);filesModified=[int](Metric filesModified 0);diffLines=[int](Metric diffLines 0);attempts=[int]$task.attempt;failureSignatures=@($task.failureSignatures);verificationOutcomes=@($task.verification.outcomes);codexCalls=[int]$task.codexCalls;codexFindings=@(Metric codexFindings @());finalResult=(Metric finalResult $null);elapsedSeconds=(Metric elapsedSeconds $null);configuration=(Metric configuration $null)}
    if($null-ne$Capability){$record.capability=$Capability}
    if($null-ne$Role){$record.role=$Role}
    if($null-ne$Trigger){$record.trigger=$Trigger}
    if($null-ne$VisualIteration){$record.visualIteration=$VisualIteration}
    if($null-ne$VisualVerdict){$record.visualVerdict=$VisualVerdict}
    if($null-ne$VisualScore){$record.visualScore=$VisualScore}
    if($null-ne$AcceptedFindings){$record.acceptedFindings=$AcceptedFindings}
    if($null-ne$RejectedFindings){$record.rejectedFindings=$RejectedFindings}
    Write-AihAtomicJson (Join-Path (Join-Path $layout.Runs $TaskId) 'telemetry.json') $record
    [pscustomobject]$record
}

function New-AihEvaluationResult {
    param([string]$Workspace,[string]$TaskId,[ValidateSet('current','deepseek-only','deepseek-codex-review','future')][string]$Configuration,[string]$Result)
    [pscustomobject]@{schemaVersion=1;taskId=$TaskId;configuration=$Configuration;result=$Result;recordedAtUtc=[DateTime]::UtcNow.ToString('o')}
}
