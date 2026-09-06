Set-StrictMode -Version Latest

# Engineering.RetryPolicy - Phase 3.2.5 deterministic two-strike discipline.
#
# For the SAME normalized failure signature under the SAME hypothesis:
#   1st occurrence: ONE direct corrective retry MAY be allowed.
#   2nd occurrence: a blind direct retry is FORBIDDEN. Continuing requires a
#       recorded investigation, an explicit CHANGED hypothesis (normalized key
#       differs), and a materially different action.
# Whitespace, quoting style, irrelevant command spelling or superficial
# rewording does NOT change the hypothesis key. Different failure signatures
# remain independent.
#
# A second-strike failure that SURVIVES a genuinely changed hypothesis is a
# deterministic repeated-failure-new-hypothesis escalation candidate.

function Get-AihRetryLogPath {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId)
    $run = Get-AihEngineeringRunPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    return (Join-Path $run 'retry-log.jsonl')
}

function Get-AihRetryRecords {
    # Only records carrying the expected lifecycle instance join.
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[string]$Signature = '')
    $path = Get-AihRetryLogPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $records = @()
    if (-not (Test-Path -LiteralPath $path)) { return $records }
    foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $path) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $record = $line | ConvertFrom-Json } catch { continue }
        if ($null -eq $record) { continue }
        if (-not (Test-AihEngineeringArtifactIdentity -Artifact $record -TaskInstanceId $TaskInstanceId)) { continue }
        if (-not [string]::IsNullOrWhiteSpace($Signature) -and [string]$record.failureSignature -ne $Signature) { continue }
        $records += $record
    }
    return $records
}

function Request-AihRetryDecision {
    # Deterministic retry gate. Called BEFORE re-running a failed operation.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [Parameter(Mandatory=$true)][string]$FailureSignature,
        [Parameter(Mandatory=$true)][string]$Hypothesis,
        [string]$ActionSummary = '',[string]$Investigation = ''
    )
    $entry = Get-AihFailureEntry -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Signature $FailureSignature
    if ($null -eq $entry) { throw "Unknown failure signature for this task: $FailureSignature" }
    $occurrence = [int]$entry.count
    $records = @(Get-AihRetryRecords -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Signature $FailureSignature)
    $hypothesisKey = Get-AihEngineeringHypothesisKey $Hypothesis
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $evidenceVersion = if ($null -eq $workingSet) { '0' } else { [string]$workingSet.evidenceVersion }

    $priorKeys = @{}
    foreach ($record in $records) {
        $key = [string]$record.hypothesisKey
        if (-not [string]::IsNullOrEmpty($key)) { $priorKeys[$key] = $true }
    }

    $retryAllowed = $false
    $retryBlocked = $false
    $blockedReason = $null
    $escalationRecommended = $false
    $requirement = 'direct corrective retry permitted (first occurrence).'

    if ($null -ne $records -and $records.Count -gt 0) {
        $lastRecord = $records[$records.Count - 1]
        $lastAllowed = [bool]$lastRecord.retryAllowed
        $lastHypothesisKey = [string]$lastRecord.hypothesisKey
        if (-not $lastAllowed) {
            # A previous request for this signature was already blocked; the
            # caller must have recorded a changed hypothesis AND investigation.
            $hypothesisChanged = (-not [string]::IsNullOrEmpty($hypothesisKey)) -and (-not $priorKeys.ContainsKey($hypothesisKey) -or $hypothesisKey -ne $lastHypothesisKey)
            $lastEvidenceVersion = if ($null -ne $lastRecord.PSObject.Properties['evidenceVersion']) { [string]$lastRecord.evidenceVersion } else { '0' }
            $evidenceChanged = ($evidenceVersion -ne $lastEvidenceVersion)
            $investigated = -not [string]::IsNullOrWhiteSpace($Investigation)
            if (-not $investigated) {
                $retryBlocked = $true
                $blockedReason = 'investigation-required: record what was investigated before another execution.'
            } elseif (-not $hypothesisChanged -and -not $evidenceChanged) {
                $retryBlocked = $true
                $blockedReason = 'new-evidence-or-changed-hypothesis-required: whitespace/quoting/superficial rewording and investigation without a new observation do not count as progress.'
            } elseif ([string]::IsNullOrWhiteSpace($ActionSummary)) {
                $retryBlocked = $true
                $blockedReason = 'materially-different-action-required: describe the materially different corrective action.'
            } else {
                $retryAllowed = $true
                $requirement = if ($evidenceChanged) { 'retry allowed after new task-local evidence and a materially different action.' } else { 'retry allowed under a changed hypothesis and materially different action.' }
                if ([int]$entry.count -ge 2) { $escalationRecommended = $true }
            }
        } else {
            # The first corrective retry already ran and the SAME signature
            # occurred again: two strikes - blind retry is forbidden.
            $retryBlocked = $true
            $blockedReason = 'second-strike: the same normalized failure occurred again under the same hypothesis; blind direct retry is forbidden. Investigate, form a materially changed hypothesis, and take a materially different action.'
            if ([int]$entry.count -ge 2) { $escalationRecommended = $true }
        }
    } else {
        $retryAllowed = $true
    }

    $record = [ordered]@{
        timestampUtc = Get-AihEngineeringUtcNow
        taskId = $TaskId
        taskInstanceId = if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) { $null } else { $TaskInstanceId }
        failureSignature = $FailureSignature
        classification = [string]$entry.classification
        occurrence = $occurrence
        hypothesis = (ConvertTo-AihEngineeringSafeText $Hypothesis 500)
        hypothesisKey = $hypothesisKey
        evidenceVersion = $evidenceVersion
        actionSummary = (ConvertTo-AihEngineeringSafeText $ActionSummary 300)
        investigation = (ConvertTo-AihEngineeringSafeText $Investigation 800)
        retryAllowed = [bool]$retryAllowed
        retryBlocked = [bool]$retryBlocked
        blockedReason = $blockedReason
        requirement = $requirement
        escalationRecommended = [bool]$escalationRecommended
        escalationReason = if ($escalationRecommended) { 'repeated-failure-new-hypothesis' } else { $null }
    }
    Add-AihJsonLine -Path (Get-AihRetryLogPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) -Value $record

    # Mirror into the Working Set: the hypothesis chain for the next step.
    if ($retryAllowed -and -not [string]::IsNullOrWhiteSpace($Hypothesis)) {
        Set-AihWorkingSetHypothesis -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Hypothesis $Hypothesis -NextAction $ActionSummary | Out-Null
    }
    return $record
}

function Get-AihRetrySnapshot {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $records = @(Get-AihRetryRecords -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    return [ordered]@{
        retryRequests = $records.Count
        allowed = @($records | Where-Object { [bool]$_.retryAllowed }).Count
        blocked = @($records | Where-Object { [bool]$_.retryBlocked }).Count
        blockedReasons = @($records | Where-Object { [bool]$_.retryBlocked } | ForEach-Object { $_.blockedReason })
        escalationRecommended = @($records | Where-Object { [bool]$_.escalationRecommended }).Count
    }
}
