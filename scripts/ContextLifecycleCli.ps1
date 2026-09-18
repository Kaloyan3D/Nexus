[CmdletBinding()]
# ContextLifecycle CLI - deterministic controller surface for Context Compaction V1.
# Every action is task-scoped and identity-guarded (TaskId plus TaskInstanceId).
# User-derived free text travels through the UTF-8 payload file, never argv.
param(
    [ValidateSet('record-root-usage','eligibility','build-checkpoint','read-checkpoint','checkpoint-text','transition','snapshot','write-telemetry','mark-applied','record-post-compaction-usage','threshold','freeze-operation','read-operation','reconcile','acquire-apply-lock','release-apply-lock')][string]$Action = 'snapshot',
    [string]$Workspace = (Get-Location).Path,
    [string]$TaskId,
    [string]$TaskInstanceId,
    [string]$SessionId = '',
    [string]$Engine = '',
    [string]$EngineRole = '',
    [int]$ThresholdOverride = -1,
    [string]$To = '',
    [string]$Reason = '',
    [int]$UncachedInputTokens = 0,
    [int]$CacheReadTokens = 0,
    [int]$OutputTokens = 0,
    [bool]$UsageAvailable = $false,
    [string]$Model = '',
    [string]$Provider = '',
    [string]$StepId = '',
    [string]$ContinuityUserText = '',
    [string]$ContinuityAssistantText = '',
    [string]$PreviousUserText = '',
    [string]$PreviousAssistantText = '',
    [int]$ReplacementStart = -1,
    [int]$ReplacementEnd = -1,
    [int[]]$SourceEventSeqs = @(),
    [int[]]$LiveSurfaceSeqs = @(),
    [int]$LandedReplacementSeq = -1,
    [bool]$DurablyVerified = $false,
    [int]$CompletionBoundarySeq = -1,
    [string]$RepositoryId = $null,
    [string]$CheckoutId = $null,
    [string]$OperationLockId = $null,
    [string]$LockOwnerId = $null,
    [int]$LockTimeoutMs = 15000,
    [int]$LockLeaseSeconds = 60,
    [object[]]$Segments = @(),
    [string]$CheckpointPath = $null,
    [object]$CheckpointSizeBytes = $null,
    [bool]$CheckpointApplied = $false,
    [string]$AppliedAtUtc = $null,
    [string]$BlockedReason = $null,
    [int]$PostCompactionEffectiveInputTokens = 0,
    [string]$PayloadFile
)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'TaskController.ps1')
. (Join-Path $PSScriptRoot 'ContextLifecycle.ps1')

if ($PayloadFile) {
    if (-not (Test-Path -LiteralPath $PayloadFile)) { throw "Payload file not found: $PayloadFile" }
    $__aihPayload = Get-Content -Raw -Encoding UTF8 -LiteralPath $PayloadFile | ConvertFrom-Json
    $__aihPayloadMap = @{}
    foreach ($property in @($__aihPayload.PSObject.Properties)) {
        if ($null -ne $property) { $__aihPayloadMap[[string]$property.Name.ToLowerInvariant()] = $property.Value }
    }
    foreach ($name in @('Workspace','TaskId','TaskInstanceId','SessionId','Engine','EngineRole','To','Reason')) {
        $key = $name.ToLowerInvariant()
        if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name $name -Value ([string]$__aihPayloadMap[$key]) }
    }
    foreach ($name in @('ThresholdOverride','UncachedInputTokens','CacheReadTokens','OutputTokens','PostCompactionEffectiveInputTokens','ReplacementStart','ReplacementEnd')) {
        $key = $name.ToLowerInvariant()
        if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name $name -Value ([int]$__aihPayloadMap[$key]) }
    }
    $key = 'sourceeventseqs'
    if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name 'SourceEventSeqs' -Value ([int[]]@($__aihPayloadMap[$key])) }
    $key = 'livesurfaceseqs'
    if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name 'LiveSurfaceSeqs' -Value ([int[]]@($__aihPayloadMap[$key])) }
    $key = 'landedreplacementseq'
    if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name 'LandedReplacementSeq' -Value ([int]$__aihPayloadMap[$key]) }
    $key = 'segments'
    if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name 'Segments' -Value ([object[]]@($__aihPayloadMap[$key])) }
    foreach ($name in @('DurablyVerified')) {
        $key = $name.ToLowerInvariant()
        if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name $name -Value ([bool]$__aihPayloadMap[$key]) }
    }
    foreach ($name in @('CompletionBoundarySeq')) {
        $key = $name.ToLowerInvariant()
        if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name $name -Value ([int]$__aihPayloadMap[$key]) }
    }
    foreach ($name in @('RepositoryId','CheckoutId','OperationLockId','LockOwnerId')) {
        $key = $name.ToLowerInvariant()
        if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name $name -Value ([string]$__aihPayloadMap[$key]) }
    }
    foreach ($name in @('LockTimeoutMs','LockLeaseSeconds')) {
        $key = $name.ToLowerInvariant()
        if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name $name -Value ([int]$__aihPayloadMap[$key]) }
    }
    foreach ($name in @('UsageAvailable')) {
        $key = $name.ToLowerInvariant()
        if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name $name -Value ([bool]$__aihPayloadMap[$key]) }
    }
    foreach ($name in @('ContinuityUserText','ContinuityAssistantText','PreviousUserText','PreviousAssistantText','Model','Provider','StepId','CheckpointPath','BlockedReason','AppliedAtUtc')) {
        $key = $name.ToLowerInvariant()
        if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name $name -Value ([string]$__aihPayloadMap[$key]) }
    }
    foreach ($name in @('CheckpointSizeBytes')) {
        $key = $name.ToLowerInvariant()
        if ($__aihPayloadMap.ContainsKey($key)) {
            if ($null -eq $__aihPayloadMap[$key]) { Set-Variable -Name $name -Value $null }
            else { Set-Variable -Name $name -Value ([int]$__aihPayloadMap[$key]) }
        }
    }
    foreach ($name in @('CheckpointApplied')) {
        $key = $name.ToLowerInvariant()
        if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name $name -Value ([bool]$__aihPayloadMap[$key]) }
    }
}
if ([string]::IsNullOrWhiteSpace($TaskId) -and ($Action -ne 'threshold')) { throw 'Context lifecycle actions require -TaskId.' }

$__aihLifecycleResult = $(switch ($Action) {
    'threshold' { [ordered]@{ thresholdTokens = (Get-AihContextLifecycleThreshold -Override $ThresholdOverride) } }
    'record-root-usage' {
        if ([string]::IsNullOrWhiteSpace($EngineRole)) { throw 'record-root-usage requires EngineRole (muse_main, engineer_normal, engineer_deep).' }
        if ([string]::IsNullOrWhiteSpace($Engine)) { throw 'record-root-usage requires Engine (muse or dual).' }
        Add-AihContextRootUsage -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -EngineRole $EngineRole -Engine $Engine -UncachedInputTokens $UncachedInputTokens -CacheReadTokens $CacheReadTokens -OutputTokens $OutputTokens -UsageAvailable $UsageAvailable -Model $Model -Provider $Provider -StepId $StepId -SessionId $SessionId
    }
    'eligibility' { Test-AihContextCompactionEligibility -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -SessionId $SessionId -ThresholdOverride $ThresholdOverride }
    'build-checkpoint' { New-AihContextCheckpoint -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -ContinuityUserText $ContinuityUserText -ContinuityAssistantText $ContinuityAssistantText -PreviousUserText $PreviousUserText -PreviousAssistantText $PreviousAssistantText }
    'read-checkpoint' { Read-AihContextCheckpoint -Workspace $Workspace -TaskId $TaskId -ExpectedTaskInstanceId $TaskInstanceId }
    'checkpoint-text' {
        $checkpoint = Read-AihContextCheckpoint -Workspace $Workspace -TaskId $TaskId -ExpectedTaskInstanceId $TaskInstanceId
        [ordered]@{ taskId = $TaskId; taskInstanceId = [string]$checkpoint.taskInstanceId; text = (Get-AihContextCheckpointText -Checkpoint $checkpoint) }
    }
    'transition' {
        if ([string]::IsNullOrWhiteSpace($To)) { throw 'transition requires -To (inactive, eligible, checkpoint-ready, applied, blocked).' }
        Set-AihContextLifecycleTransition -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -To $To -Reason $Reason -SessionId $SessionId -CheckpointPath $CheckpointPath
    }
    'snapshot' { Get-AihContextLifecycleSnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    'write-telemetry' {
        $eligibility = Test-AihContextCompactionEligibility -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -SessionId $SessionId -ThresholdOverride $ThresholdOverride
        Write-AihContextCompactionTelemetry -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Eligibility $eligibility -SessionId $SessionId -CheckpointPath $CheckpointPath -CheckpointSizeBytes $CheckpointSizeBytes -CheckpointApplied $CheckpointApplied -AppliedAtUtc $AppliedAtUtc -BlockedReason $BlockedReason
    }
    'mark-applied' { Set-AihContextCompactionApplied -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -AppliedAtUtc $AppliedAtUtc -SessionId $SessionId }
    'freeze-operation' { New-AihContextCompactionOperation -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -SessionId $SessionId -ReplacementStart $ReplacementStart -ReplacementEnd $ReplacementEnd -SourceEventSeqs $SourceEventSeqs -CheckpointPath $CheckpointPath -Segments $Segments -CompletionBoundarySeq $CompletionBoundarySeq -RepositoryId $RepositoryId -CheckoutId $CheckoutId }
    'read-operation' { Read-AihContextCompactionOperation -Workspace $Workspace -TaskId $TaskId }
    'reconcile' { Test-AihContextOperationReconcile -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -LiveSurfaceSeqs $LiveSurfaceSeqs -LandedReplacementSeq $LandedReplacementSeq -SessionId $SessionId -DurablyVerified $DurablyVerified }
    'acquire-apply-lock' { Invoke-AihCompactionApplyLockAcquire -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -SessionId $SessionId -OperationId $OperationLockId -LeaseSeconds $LockLeaseSeconds }
    'release-apply-lock' { Invoke-AihCompactionApplyLockRelease -Workspace $Workspace -TaskId $TaskId -OwnerId $LockOwnerId }
    'record-post-compaction-usage' { Add-AihContextPostCompactionUsage -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -PostCompactionEffectiveInputTokens $PostCompactionEffectiveInputTokens -SessionId $SessionId }
})
if ($null -ne $__aihLifecycleResult) { ConvertTo-Json -InputObject (ConvertTo-AihJsonSafe $__aihLifecycleResult) -Depth 20 }
