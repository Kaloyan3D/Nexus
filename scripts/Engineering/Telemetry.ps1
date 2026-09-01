Set-StrictMode -Version Latest

# Engineering.Telemetry - Phase 3.2.5 observability and cost telemetry.
#
# Engineering efficiency must become MEASURABLE per task and per role:
#   modelCalls/normal/deep/reviewer, escalation counts+reasons+signatures,
#   de-escalations, failure signatures, blocked retries, tool calls/failures,
#   Working Set size, retrieved evidence counts, repeated file reads,
#   verification commands, full harness runs, requirement coverage,
#   compactions, wall-clock runtime.
#
# Token/cost telemetry is recorded ONLY when reliable provider/runtime data
# exists (usageAvailable). Missing token telemetry is NEVER fatal and dollar
# values are NEVER invented.

function Get-AihEngineeringMetricsPath {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId)
    $run = Get-AihEngineeringRunPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    return (Join-Path $run 'engineering-metrics.json')
}

function Add-AihModelUsage {
    # Optional per-step usage record. Provider data only; nothing invented.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [Parameter(Mandatory=$true)][ValidateSet('engineer_normal','engineer_deep','reviewer')][string]$Role,
        [string]$StepId = '',[int]$InputTokens = 0,[int]$UncachedInputTokens = 0,[int]$CacheReadTokens = 0,[int]$OutputTokens = 0,
        [bool]$UsageAvailable = $false,[string]$Model = '',[string]$Provider = '',[double]$EstimatedCost = -1,[string]$StartedAtUtc = '',[string]$FinishedAtUtc = ''
    )
    $path = Get-AihEngineeringMetricsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $metrics = Read-AihEngineeringJson -Path $path -Default $null
    if ($null -eq $metrics -or -not (Test-AihEngineeringArtifactIdentity -Artifact $metrics -TaskInstanceId $TaskInstanceId)) {
        $metrics = New-AihEngineeringMetricsBase -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    }
    $usageEntry = [ordered]@{
        timestampUtc = Get-AihEngineeringUtcNow
        role = $Role
        stepId = $StepId
        model = $Model
        provider = $Provider
        usageAvailable = [bool]$UsageAvailable
        inputTokens = [int]$InputTokens
        uncachedInputTokens = [int]$UncachedInputTokens
        cacheReadTokens = [int]$CacheReadTokens
        outputTokens = [int]$OutputTokens
    }
    if ($EstimatedCost -ge 0) { $usageEntry.estimatedCost = $EstimatedCost }
    if (-not [string]::IsNullOrWhiteSpace($StartedAtUtc)) { $usageEntry.startedAtUtc = $StartedAtUtc }
    if (-not [string]::IsNullOrWhiteSpace($FinishedAtUtc)) { $usageEntry.finishedAtUtc = $FinishedAtUtc }
    $metrics.usageRecords = @($metrics.usageRecords) + @($usageEntry)
    Write-AihAtomicJson -Path $path -Value $metrics
    return $usageEntry
}

function New-AihEngineeringMetricsBase {
    param([string]$TaskId,[string]$TaskInstanceId)
    return [ordered]@{
        schemaVersion = 1
        taskId = $TaskId
        taskInstanceId = if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) { $null } else { $TaskInstanceId }
        usageRecords = @()
        compactions = 0
        startedAtUtc = Get-AihEngineeringUtcNow
    }
}

function Set-AihEngineeringCompactions {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[int]$Count)
    $path = Get-AihEngineeringMetricsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $metrics = Read-AihEngineeringJson -Path $path -Default $null
    if ($null -eq $metrics -or -not (Test-AihEngineeringArtifactIdentity -Artifact $metrics -TaskInstanceId $TaskInstanceId)) {
        $metrics = New-AihEngineeringMetricsBase -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    }
    $metrics.compactions = [int]$Count
    Write-AihAtomicJson -Path $path -Value $metrics
    return $metrics
}

function Get-AihEngineeringTelemetry {
    # Aggregate one authoritative telemetry snapshot from the task-local
    # engineering artifacts. Every metric is derived from real records;
    # token totals are reported only via usageAvailable.
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId
    $routing = Get-AihStepRoutingSnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $failures = Get-AihFailureSnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $retries = Get-AihRetrySnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $tools = Get-AihToolExecutionSnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $verifications = Get-AihVerificationSnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $requirements = Get-AihRequirementCoverage -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSetSize = Get-AihWorkingSetSize -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $epistemic = Get-AihEpistemicSnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId

    $metricsPath = Get-AihEngineeringMetricsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $metrics = Read-AihEngineeringJson -Path $metricsPath -Default $null
    $usageRecords = @()
    $compactions = 0
    $startedAtUtc = $null
    if ($null -ne $metrics -and (Test-AihEngineeringArtifactIdentity -Artifact $metrics -TaskInstanceId $TaskInstanceId)) {
        $usageRecords = @($metrics.usageRecords)
        $compactions = [int]$metrics.compactions
        $startedAtUtc = [string]$metrics.startedAtUtc
    }

    $byRole = [ordered]@{ engineer_normal = 0; engineer_deep = 0; reviewer = 0 }
    $usageAvailable = (@($usageRecords | Where-Object { [bool]$_.usageAvailable }).Count -gt 0)
    $inputTokens = 0; $uncachedInputTokens = 0; $cacheReadTokens = 0; $outputTokens = 0
    $estimatedCost = $null
    $timeByRole = [ordered]@{ engineer_normal = 0; engineer_deep = 0; reviewer = 0 }
    foreach ($usage in $usageRecords) {
        if ($null -ne $byRole.PSObject.Properties[[string]$usage.role]) { $byRole[[string]$usage.role] = [int]$byRole[[string]$usage.role] + 1 }
        if ([bool]$usage.usageAvailable) {
            $inputTokens += [int]$usage.inputTokens
            $uncachedInputTokens += [int]$usage.uncachedInputTokens
            $cacheReadTokens += [int]$usage.cacheReadTokens
            $outputTokens += [int]$usage.outputTokens
        }
        if ($null -ne $usage.PSObject.Properties['estimatedCost']) { $estimatedCost = ($estimatedCost + [double]$usage.estimatedCost) }
        if ($null -ne $usage.PSObject.Properties['startedAtUtc'] -and $null -ne $usage.PSObject.Properties['finishedAtUtc']) {
            $from = [DateTime]::MinValue; $to = [DateTime]::MinValue
            if ([DateTime]::TryParse($usage.startedAtUtc, [ref]$from) -and [DateTime]::TryParse($usage.finishedAtUtc, [ref]$to) -and $to -ge $from) {
                if ($null -ne $timeByRole.PSObject.Properties[[string]$usage.role]) { $timeByRole[[string]$usage.role] = [int]$timeByRole[[string]$usage.role] + [int]($to - $from).TotalMilliseconds }
            }
        }
    }

    $repeatedFileReads = 0
    if ($null -ne $workingSet) {
        $repeatedFileReads = @(@($workingSet.evidence.files) | Where-Object { $null -ne $_.PSObject.Properties['repeatedRetrieval'] -and [bool]$_.repeatedRetrieval }).Count
    }

    $createdAtUtc = if ($null -ne $task -and $null -ne $task.PSObject.Properties['createdAtUtc']) { [string]$task.createdAtUtc } else { $null }
    $wallClockSeconds = $null
    if (-not [string]::IsNullOrEmpty($createdAtUtc)) {
        $from = [DateTime]::MinValue
        if ([DateTime]::TryParse($createdAtUtc, [ref]$from)) { $wallClockSeconds = [int](([DateTime]::UtcNow) - $from).TotalSeconds }
    }

    $failureSignatureBlocks = @()
    foreach ($entry in @($failures.entries)) {
        $failureSignatureBlocks += [ordered]@{ signature = [string]$entry.signature; classification = [string]$entry.classification; count = [int]$entry.count }
    }

    return [ordered]@{
        schemaVersion = 1
        taskId = $TaskId
        taskInstanceId = if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) { $null } else { $TaskInstanceId }
        generatedAtUtc = Get-AihEngineeringUtcNow
        totalModelCalls = $routing.steps
        modelCallsNormal = $routing.normalSteps
        modelCallsDeep = $routing.deepSteps
        modelCallsReviewer = [int]$byRole['reviewer']
        usageRecordedCalls = @($usageRecords).Count
        escalationCount = $routing.escalationCount
        deescalationCount = $routing.deescalationCount
        escalationReasons = @($routing.escalationReasons)
        escalationSignatures = @($routing.escalationSignatures)
        blockedEscalations = $routing.blockedEscalations
        inputTokens = $(if ($usageAvailable) { $inputTokens } else { $null })
        uncachedInputTokens = $(if ($usageAvailable) { $uncachedInputTokens } else { $null })
        cacheReadTokens = $(if ($usageAvailable) { $cacheReadTokens } else { $null })
        outputTokens = $(if ($usageAvailable) { $outputTokens } else { $null })
        usageAvailable = [bool]$usageAvailable
        estimatedCost = $estimatedCost
        toolCalls = [int]$tools.executions
        toolFailures = [int]$tools.failures
        workingSetBytes = [int]$workingSetSize.bytes
        workingSetEstimatedTokens = [int]$workingSetSize.estimatedTokens
        retrievedEvidenceCount = $(if ($null -ne $workingSet) { [int]$workingSet.retrieval.retrievedEvidenceCount } else { 0 })
        retrievedFileCount = $(if ($null -ne $workingSet) { [int]$workingSet.retrieval.retrievedFileCount } else { 0 })
        repeatedFileReads = $repeatedFileReads
        distinctFailureSignatures = [int]$failures.distinctSignatures
        totalFailureOccurrences = [int]$failures.totalOccurrences
        failureSignatures = @($failureSignatureBlocks)
        blockedRetries = [int]$retries.blocked
        verificationCommands = (@($verifications.records | ForEach-Object { foreach ($command in @($_.commands)) { [string]$command.name } }))
        fullHarnessRuns = [int]$verifications.fullHarnessRuns
        requirementCoverage = $requirements
        compactions = $compactions
        wallClockRuntimeSeconds = $wallClockSeconds
        timeSpentNormalMs = [int]$timeByRole['engineer_normal']
        timeSpentDeepMs = [int]$timeByRole['engineer_deep']
        epistemicActions = $epistemic.actionCounts
        uncertainties = $epistemic.uncertainties
        probes = $epistemic.probes
        reasoningAvoidance = [ordered]@{ cheapEvidencePreferredOverReason = [int]$epistemic.reasoningAvoided }
        epistemicRouting = $epistemic.routing
    }
}
