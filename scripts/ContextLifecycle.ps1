Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# ContextLifecycle.ps1 - Context Compaction V1 controller-owned context lifecycle.
#
# ONE authority for context-lifecycle decisions. TaskController.ps1 remains the
# ONLY task lifecycle state machine; this module NEVER mutates task status and
# NEVER overrides routing. It owns: the compaction threshold constant,
# per-task root pressure telemetry, the checkpoint schema plus writer, the
# eligibility state machine, and the telemetry record. The model-facing
# projection change itself is applied by the controller bridge
# (config/AihController.cjs) through the supported DSH session surface seam
# (surfaceOp replace); this module only prepares durable state for it.
#
# Fail-closed everywhere: any ambiguity keeps the existing context (KEEP).
# Historical tasks without context-lifecycle fields keep loading: every reader
# below treats missing fields as inactive or absent, never as corrupt.

# V1 threshold authority. ONE constant; no magic numbers elsewhere.
$AihContextCompactionThresholdTokens = 120000

# Checkpoint schema version (persisted in every checkpoint plus state record).
$AihContextCheckpointSchemaVersion = 1

# Frozen compaction-operation schema version. Bumped independently of the
# checkpoint content version so old checkpoint-ready states without a frozen
# operation are never reinterpreted as new ones (see F2/F5 repair).
$AihContextOperationSchemaVersion = 1

# Context-lifecycle state machine states.
# apply-pending  = frozen operation persisted, replacement not yet appended.
# awaiting-durability = replacement appended in memory, durability unconfirmed.
$AihContextLifecycleStates = @('inactive', 'eligible', 'checkpoint-ready', 'apply-pending', 'awaiting-durability', 'applied', 'blocked')
function Get-AihContextLifecycleThreshold {
    param([int]$Override = -1)
    if ($Override -ge 0) {
        if ($Override -lt 1) { throw 'Context compaction threshold must be a positive token count. (KEEP: invalid configuration fails closed.)' }
        return [int]$Override
    }
    return [int]$AihContextCompactionThresholdTokens
}

function Get-AihContextLifecyclePaths {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $layout = Get-AihLedgerLayout $Workspace
    $run = Join-Path $layout.Runs $TaskId
    return [pscustomobject]@{
        Run = $run
        Checkpoint = Join-Path $run 'context-checkpoint.json'
        Lifecycle = Join-Path $run 'context-lifecycle.json'
        Pressure = Join-Path $run 'context-pressure.json'
        Operation = Join-Path $run 'context-compaction-operation.json'
    }
}

function Read-AihContextLifecycleState {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    if (-not (Test-Path -LiteralPath $paths.Lifecycle)) { return $null }
    try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $paths.Lifecycle | ConvertFrom-Json }
    catch { return $null }
}

function Write-AihContextLifecycleState {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId, [Parameter(Mandatory = $true)]$State)
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    Write-AihAtomicJson $paths.Lifecycle $State
    return $State
}
function Read-AihContextPressure {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    if (-not (Test-Path -LiteralPath $paths.Pressure)) { return $null }
    try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $paths.Pressure | ConvertFrom-Json }
    catch { return $null }
}

function Add-AihContextRootUsage {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][ValidateSet('muse_main', 'engineer_normal', 'engineer_deep')][string]$EngineRole,
        [Parameter(Mandatory = $true)][string]$Engine,
        [int]$UncachedInputTokens = 0,
        [int]$CacheReadTokens = 0,
        [int]$OutputTokens = 0,
        [bool]$UsageAvailable = $false,
        [string]$Model = '',
        [string]$Provider = '',
        [string]$StepId = '',
        [string]$SessionId = ''
    )
    if (-not [string]::IsNullOrWhiteSpace($TaskInstanceId)) {
        $identity = Test-AihTaskIdentity -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
        if (-not [bool]$identity.exists) { throw "Context lifecycle rejected: task was not found in the authoritative ledger: $TaskId" }
        if (-not [bool]$identity.instanceMatches) { throw "Context lifecycle rejected: task $TaskId no longer holds taskInstanceId '$TaskInstanceId'. (KEEP: generation mismatch.)" }
    }
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $actualInstance = $null
    if ($null -ne $task.PSObject.Properties['taskInstanceId']) { $actualInstance = [string]$task.taskInstanceId }
    $pressure = Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId
    $isFreshInstance = ($null -eq $pressure) -or ([string]$pressure.taskInstanceId -ne [string]$actualInstance)
    if ($isFreshInstance) {
        $pressure = [pscustomobject][ordered]@{
            schemaVersion = 1; taskId = $TaskId; taskInstanceId = $actualInstance
            latestEffectiveInputTokens = 0; peakEffectiveInputTokens = 0
            cumulativeUncachedInputTokens = 0; cumulativeCacheReadTokens = 0
            cumulativeOutputTokens = 0; rootModelCallCount = 0
            callsByEngine = [pscustomobject][ordered]@{ muse = 0; dual = 0 }
            callsByRole = [pscustomobject][ordered]@{ muse_main = 0; engineer_normal = 0; engineer_deep = 0 }
            lastCallAtUtc = $null; lastModel = $null; lastProvider = $null
        }
    }
    $seenSteps = @()
    if ($null -ne $pressure.PSObject.Properties['seenStepIds']) { $seenSteps = @($pressure.seenStepIds) }
    if ((-not [string]::IsNullOrWhiteSpace($StepId)) -and (@($seenSteps | Where-Object { [string]$_ -eq $StepId }).Count -gt 0)) {
        return [pscustomobject]$pressure
    }
    $effective = 0
    if ([bool]$UsageAvailable) { $effective = [int]$UncachedInputTokens + [int]$CacheReadTokens }
    if ($effective -lt 0) { $effective = 0 }
    $pressure.latestEffectiveInputTokens = [int]$effective
    if ([int]$effective -gt [int]$pressure.peakEffectiveInputTokens) { $pressure.peakEffectiveInputTokens = [int]$effective }
    if ([bool]$UsageAvailable) {
        $pressure.cumulativeUncachedInputTokens = [int]$pressure.cumulativeUncachedInputTokens + [int]$UncachedInputTokens
        $pressure.cumulativeCacheReadTokens = [int]$pressure.cumulativeCacheReadTokens + [int]$CacheReadTokens
        $pressure.cumulativeOutputTokens = [int]$pressure.cumulativeOutputTokens + [int]$OutputTokens
    }
    $pressure.rootModelCallCount = [int]$pressure.rootModelCallCount + 1
    if ($Engine -eq 'muse') { $pressure.callsByEngine.muse = [int]$pressure.callsByEngine.muse + 1 }
    else { $pressure.callsByEngine.dual = [int]$pressure.callsByEngine.dual + 1 }
    $roleKey = [string]$EngineRole
    if ($roleKey -eq 'muse_main') { $pressure.callsByRole.muse_main = [int]$pressure.callsByRole.muse_main + 1 }
    elseif ($roleKey -eq 'engineer_normal') { $pressure.callsByRole.engineer_normal = [int]$pressure.callsByRole.engineer_normal + 1 }
    elseif ($roleKey -eq 'engineer_deep') { $pressure.callsByRole.engineer_deep = [int]$pressure.callsByRole.engineer_deep + 1 }
    $pressure.lastCallAtUtc = [DateTime]::UtcNow.ToString('o')
    if (-not [string]::IsNullOrWhiteSpace($Model)) { $pressure.lastModel = [string]$Model }
    if (-not [string]::IsNullOrWhiteSpace($Provider)) { $pressure.lastProvider = [string]$Provider }
    if (-not [string]::IsNullOrWhiteSpace($StepId)) {
        $pressure | Add-Member -NotePropertyName 'seenStepIds' -NotePropertyValue (@($seenSteps) + @($StepId)) -Force
    }
    if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
        $pressure | Add-Member -NotePropertyName 'lastSessionId' -NotePropertyValue ([string]$SessionId) -Force
    }
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    Write-AihAtomicJson $paths.Pressure $pressure
    return [pscustomobject]$pressure
}
function Test-AihContextCompactionEligibility {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [string]$TaskInstanceId,
        [string]$SessionId = '',
        [int]$ThresholdOverride = -1
    )
    $threshold = Get-AihContextLifecycleThreshold -Override $ThresholdOverride
    $failDecision = {
        param([string]$Reason, $PressureDoc, $TaskDoc)
        $record = [ordered]@{
            schemaVersion = 1; taskId = $TaskId
            taskInstanceId = $(if ($null -ne $TaskDoc -and $null -ne $TaskDoc.PSObject.Properties['taskInstanceId']) { [string]$TaskDoc.taskInstanceId } else { $TaskInstanceId })
            sessionId = [string]$SessionId; engine = $(if ($null -ne $TaskDoc -and $null -ne $TaskDoc.PSObject.Properties['boundEngine']) { [string]$TaskDoc.boundEngine } else { $null })
            thresholdTokens = [int]$threshold
            latestEffectiveInputTokens = $(if ($null -ne $PressureDoc) { [int]$PressureDoc.latestEffectiveInputTokens } else { 0 })
            peakEffectiveInputTokens = $(if ($null -ne $PressureDoc) { [int]$PressureDoc.peakEffectiveInputTokens } else { 0 })
            cumulativeUncachedInputTokens = $(if ($null -ne $PressureDoc) { [int]$PressureDoc.cumulativeUncachedInputTokens } else { 0 })
            cumulativeCacheReadTokens = $(if ($null -ne $PressureDoc) { [int]$PressureDoc.cumulativeCacheReadTokens } else { 0 })
            cumulativeOutputTokens = $(if ($null -ne $PressureDoc) { [int]$PressureDoc.cumulativeOutputTokens } else { 0 })
            rootModelCallCount = $(if ($null -ne $PressureDoc) { [int]$PressureDoc.rootModelCallCount } else { 0 })
            eligibilityDecision = 'keep'; eligibilityReason = [string]$Reason
            checkpointPath = $null; checkpointSizeBytes = $null; checkpointApplied = $false
            appliedAtUtc = $null; blockedReason = $null; recordedAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        return [pscustomobject]$record
    }
    $task = $null
    try { $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    catch { return (& $failDecision ('task-identity-unproven: ' + [string]$_.Exception.Message) $null $null) }
    if ([string]$task.status -ne 'complete') {
        return (& $failDecision ('task-not-complete: status is "' + [string]$task.status + '". KEEP.') (Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId) $task)
    }
    if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) {
        return (& $failDecision 'task-instance-unproven: no taskInstanceId supplied. KEEP.' (Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId) $task)
    }
    $actualInstance = [string]$task.taskInstanceId
    if ([string]::IsNullOrWhiteSpace($actualInstance) -or ($actualInstance -ne $TaskInstanceId)) {
        return (& $failDecision ('task-instance-mismatch: ledger holds "' + $actualInstance + '". KEEP.') (Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId) $task)
    }
    $pressure = Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId
    if (($null -eq $pressure) -or ([string]$pressure.taskInstanceId -ne [string]$actualInstance)) {
        return (& $failDecision 'pressure-unproven: no root pressure for this lifecycle generation. KEEP.' $pressure $task)
    }
    if ([int]$pressure.rootModelCallCount -lt 1) {
        return (& $failDecision 'pressure-unproven: no root model calls recorded. KEEP.' $pressure $task)
    }
    $signal = [int]$pressure.latestEffectiveInputTokens
    if ($signal -ge [int]$threshold) {
        $record = [ordered]@{
            schemaVersion = 1; taskId = $TaskId; taskInstanceId = [string]$actualInstance
            sessionId = [string]$SessionId; engine = [string]$task.boundEngine
            thresholdTokens = [int]$threshold
            latestEffectiveInputTokens = [int]$pressure.latestEffectiveInputTokens
            peakEffectiveInputTokens = [int]$pressure.peakEffectiveInputTokens
            cumulativeUncachedInputTokens = [int]$pressure.cumulativeUncachedInputTokens
            cumulativeCacheReadTokens = [int]$pressure.cumulativeCacheReadTokens
            cumulativeOutputTokens = [int]$pressure.cumulativeOutputTokens
            rootModelCallCount = [int]$pressure.rootModelCallCount
            eligibilityDecision = 'eligible'; eligibilityReason = 'controller-complete plus latest root effective input at or above threshold.'
            checkpointPath = $null; checkpointSizeBytes = $null; checkpointApplied = $false
            appliedAtUtc = $null; blockedReason = $null; recordedAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        return [pscustomobject]$record
    }
    return (& $failDecision ('below-threshold: latest root effective input ' + [string]$signal + ' is below ' + [string]$threshold + '. KEEP.') $pressure $task)
}
function Get-AihContextGitFacts {
    param([Parameter(Mandatory = $true)][string]$Workspace)
    $facts = [ordered]@{ baseCommit = $null; headCommit = $null; worktreeClean = $null; changedFiles = @() }
    try {
        $head = (& git -C $Workspace rev-parse HEAD 2>$null | Select-Object -First 1)
        if ($null -ne $head) { $facts.headCommit = ([string]$head).Trim() }
    } catch { }
    try {
        $porcelain = @(& git -C $Workspace status --porcelain=v1 --untracked-files=normal 2>$null)
        $entries = @()
        foreach ($line in $porcelain) {
            $text = ([string]$line)
            if ($text.Length -lt 4) { continue }
            $staged = $text.Substring(0, 1); $unstaged = $text.Substring(1, 1)
            $pathPart = $text.Substring(3)
            $state = 'modified'
            if (($staged -eq 'A') -or ($unstaged -eq 'A')) { $state = 'added' }
            elseif (($staged -eq 'D') -or ($unstaged -eq 'D')) { $state = 'deleted' }
            elseif (($staged -eq 'R') -or ($unstaged -eq 'R')) { $state = 'renamed' }
            elseif ($unstaged -eq '?') { $state = 'untracked' }
            $entries += [ordered]@{ path = $pathPart; status = $state; staged = ($staged -ne ' ' -and $staged -ne '?' -and $staged -ne '!'); unstaged = ($unstaged -ne ' ') }
            if (@($entries).Count -ge 200) { break }
        }
        $facts.changedFiles = @($entries)
        $facts.worktreeClean = (@($entries).Count -eq 0)
    } catch { }
    return [pscustomobject]$facts
}

function ConvertTo-AihContextRedactedText {
    param([string]$Text, [int]$MaxChars = 4000)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $redacted = [string]$Text
    $redacted = [regex]::Replace($redacted, '(?i)\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}', '$1<redacted>')
    $redacted = [regex]::Replace($redacted, '\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b', '<redacted>')
    $redacted = [regex]::Replace($redacted, '(?i)((?:MODEL_API_KEY|API[_-]?KEY|ACCESS[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD|AUTHORIZATION)\s*[:=]\s*)([^\s,;]+)', '$1<redacted>')
    $redacted = [regex]::Replace($redacted, '(?i)("(?:apiKey|api_key|accessToken|access_token|clientSecret|client_secret|password|authorization)"\s*:\s*")[^"]*(")', '$1<redacted>$2')
    $redacted = $redacted.Trim()
    if ($redacted.Length -gt $MaxChars) { $redacted = $redacted.Substring(0, $MaxChars) + '...<truncated>' }
    return $redacted
}
function New-AihContextCheckpoint {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [string]$ContinuityUserText = '',
        [string]$ContinuityAssistantText = '',
        [string]$PreviousUserText = '',
        [string]$PreviousAssistantText = ''
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ([string]$task.status -ne 'complete') { throw "Checkpoint refused: task $TaskId status is '$($task.status)', not complete. (KEEP.)" }
    $layout = Get-AihLedgerLayout $Workspace
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    $evidence = $null
    $evidencePath = Join-Path (Join-Path $layout.Runs $TaskId) 'evidence.json'
    if (Test-Path -LiteralPath $evidencePath) {
        try { $evidence = Get-Content -Raw -Encoding UTF8 -LiteralPath $evidencePath | ConvertFrom-Json } catch { $evidence = $null }
    }
    $evidenceInstance = $null
    if (($null -ne $evidence) -and ($null -ne $evidence.PSObject.Properties['taskInstanceId'])) { $evidenceInstance = [string]$evidence.taskInstanceId }
    $verificationOutcomes = @()
    if (($null -ne $evidence) -and ($null -ne $evidence.PSObject.Properties['verification'])) {
        foreach ($check in @($evidence.verification)) {
            if ($null -eq $check) { continue }
            $verificationOutcomes += [ordered]@{
                name = [string]$check.name; kind = [string]$check.kind
                status = ([string]$check.status).ToUpperInvariant()
                exitCode = $(if ($null -ne $check.PSObject.Properties['exitCode']) { $check.exitCode } else { $null })
                attempt = $(if ($null -ne $check.PSObject.Properties['attempt']) { [int]$check.attempt } else { $null })
            }
        }
    }
    $criteriaEvidence = @()
    if (($null -ne $evidence) -and ($null -ne $evidence.PSObject.Properties['acceptanceCriteria'])) {
        foreach ($item in @($evidence.acceptanceCriteria)) {
            if ($null -eq $item) { continue }
            $criterionText = ConvertTo-AihContextRedactedText -Text ([string]$item.criterion) -MaxChars 500
            $itemEvidence = ConvertTo-AihContextRedactedText -Text ([string]$item.evidence) -MaxChars 500
            $criteriaEvidence += [ordered]@{ criterion = $criterionText; status = [string]$item.status; evidence = $itemEvidence }
        }
    }
    $attempts = @()
    $attemptsPath = Join-Path (Join-Path $layout.Runs $TaskId) 'attempts.jsonl'
    if (Test-Path -LiteralPath $attemptsPath) {
        foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $attemptsPath) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try { $record = $line | ConvertFrom-Json } catch { continue }
            if (($null -eq $record) -or ([string]$record.taskId -ne $TaskId)) { continue }
            $attempts += [ordered]@{
                sequence = [int]$record.sequence; status = [string]$record.status
                timestampUtc = $(if ($null -ne $record.PSObject.Properties['timestampUtc']) { [string]$record.timestampUtc } elseif ($null -ne $record.PSObject.Properties['startedAtUtc']) { [string]$record.startedAtUtc } else { $null })
            }
        }
    }
    $gitFacts = Get-AihContextGitFacts -Workspace $Workspace
    $pressure = Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId
    $boundEngine = $null
    if ($null -ne $task.PSObject.Properties['boundEngine']) { $boundEngine = [string]$task.boundEngine }
    $checkpoint = [ordered]@{
        schemaVersion = [int]$AihContextCheckpointSchemaVersion
        taskId = [string]$task.taskId; taskInstanceId = [string]$task.taskInstanceId
        checkpointOf = [string]$task.taskInstanceId
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
        workspace = [ordered]@{
            executionRoot = [string]$Workspace
            workspaceId = $(if ($null -ne $task.PSObject.Properties['workspaceId']) { [string]$task.workspaceId } else { $null })
            repositoryId = $null; checkoutId = $null
        }
        engine = $boundEngine
        preset = $null
        executionClass = [string]$task.executionClass
        task = [ordered]@{
            description = (ConvertTo-AihContextRedactedText -Text ([string]$task.description) -MaxChars 4000)
            acceptanceCriteria = @($task.acceptanceCriteria)
            status = [string]$task.status
            createdAtUtc = [string]$task.createdAtUtc; completedAtUtc = [string]$task.completedAtUtc
        }
        execution = [ordered]@{
            attempts = [int]$task.attempt
            attemptTimeline = @($attempts)
            risk = [string]$task.risk
            reviewRequested = [bool]$task.reviewRequested
            completionAuthority = 'deterministic-controller'
        }
        repositoryState = [ordered]@{
            baseCommit = $(if ($null -ne $task.PSObject.Properties['baseCommit']) { [string]$task.baseCommit } else { $null })
            headCommit = [string]$gitFacts.headCommit
            worktreeClean = $gitFacts.worktreeClean
            changedFiles = @($gitFacts.changedFiles)
        }
        verification = [ordered]@{
            outcomes = @($verificationOutcomes)
            acceptanceEvidence = @($criteriaEvidence)
            evidenceTaskInstanceId = $evidenceInstance
            scopePass = $(if (($null -ne $evidence) -and ($null -ne $evidence.PSObject.Properties['scopePass'])) { [bool]$evidence.scopePass } else { $null })
        }
        routingProvenance = [ordered]@{
            executionClass = [string]$task.executionClass
            engine = $boundEngine
            note = 'Context only. This checkpoint MUST NOT override future authoritative routing or model selection.'
        }
        pressure = $(if ($null -ne $pressure) {
            [ordered]@{
                latestEffectiveInputTokens = [int]$pressure.latestEffectiveInputTokens
                peakEffectiveInputTokens = [int]$pressure.peakEffectiveInputTokens
                rootModelCallCount = [int]$pressure.rootModelCallCount
            }
        } else { $null })
        continuity = [ordered]@{
            finalUserRequest = (ConvertTo-AihContextRedactedText -Text ([string]$ContinuityUserText) -MaxChars 2000)
            finalAssistantReport = (ConvertTo-AihContextRedactedText -Text ([string]$ContinuityAssistantText) -MaxChars 4000)
            previousUserText = (ConvertTo-AihContextRedactedText -Text ([string]$PreviousUserText) -MaxChars 1000)
            previousAssistantText = (ConvertTo-AihContextRedactedText -Text ([string]$PreviousAssistantText) -MaxChars 1000)
            note = 'Historical context only. Not controller truth. No tool transcripts, no shell output, no hidden reasoning.'
        }
    }
    if (($null -ne $evidence) -and (-not [string]::IsNullOrWhiteSpace($evidenceInstance)) -and ($evidenceInstance -ne [string]$task.taskInstanceId)) {
        $checkpoint.verification = [ordered]@{
            outcomes = @(); acceptanceEvidence = @(); evidenceTaskInstanceId = $evidenceInstance
            scopePass = $null; note = 'Evidence belongs to another lifecycle generation; excluded from this checkpoint. KEEP semantics preserved.'
        }
    }
    $json = ConvertTo-Json -InputObject (ConvertTo-AihJsonSafe $checkpoint) -Depth 20
    $bytes = [Text.Encoding]::UTF8.GetByteCount($json)
    if ($bytes -gt 65536) { throw "Checkpoint refused: serialized size $bytes exceeds the 64KiB V1 bound. (KEEP: checkpoint must stay compact.)" }
    Write-AihAtomicJson $paths.Checkpoint $checkpoint
    $actual = Get-Content -Raw -Encoding UTF8 -LiteralPath $paths.Checkpoint | ConvertFrom-Json
    if (($null -eq $actual) -or ([string]$actual.taskInstanceId -ne [string]$task.taskInstanceId) -or ([int]$actual.schemaVersion -ne [int]$AihContextCheckpointSchemaVersion)) {
        throw 'Checkpoint refused: read-back validation failed after atomic write. (KEEP.)'
    }
    return [pscustomobject]@{ path = $paths.Checkpoint; sizeBytes = $bytes; taskId = $TaskId; taskInstanceId = [string]$task.taskInstanceId }
}
function Read-AihContextCheckpoint {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId, [string]$ExpectedTaskInstanceId = '')
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    if (-not (Test-Path -LiteralPath $paths.Checkpoint)) { return $null }
    try { $checkpoint = Get-Content -Raw -Encoding UTF8 -LiteralPath $paths.Checkpoint | ConvertFrom-Json }
    catch { throw "Checkpoint blocked: context-checkpoint.json is malformed. (KEEP: old context retained.)" }
    if (($null -eq $checkpoint) -or ($null -eq $checkpoint.PSObject.Properties['schemaVersion']) -or ($null -eq $checkpoint.PSObject.Properties['taskId']) -or ($null -eq $checkpoint.PSObject.Properties['taskInstanceId'])) {
        throw 'Checkpoint blocked: required identity fields are missing. (KEEP: old context retained.)'
    }
    if ([int]$checkpoint.schemaVersion -ne [int]$AihContextCheckpointSchemaVersion) {
        throw ('Checkpoint blocked: schemaVersion ' + [string]$checkpoint.schemaVersion + ' is not V1. (KEEP.)')
    }
    if ([string]$checkpoint.taskId -ne $TaskId) {
        throw 'Checkpoint blocked: taskId mismatch. (KEEP: old context retained.)'
    }
    if ((-not [string]::IsNullOrWhiteSpace($ExpectedTaskInstanceId)) -and ([string]$checkpoint.taskInstanceId -ne $ExpectedTaskInstanceId)) {
        throw 'Checkpoint blocked: taskInstanceId mismatch. (KEEP: old context retained.)'
    }
    return $checkpoint
}

function Get-AihContextCheckpointText {
    param([Parameter(Mandatory = $true)]$Checkpoint, [int]$MaxChars = 6000)
    $lines = [Collections.Generic.List[string]]::new()
    [void]$lines.Add(('<nexus-context-checkpoint task="' + [string]$Checkpoint.taskId + '" instance="' + [string]$Checkpoint.taskInstanceId + '" schema="' + [string]$Checkpoint.schemaVersion + '">'))
    [void]$lines.Add(('Task: ' + [string]$Checkpoint.task.description))
    [void]$lines.Add(('Status: ' + [string]$Checkpoint.task.status + ' · authority: deterministic-controller · engine: ' + [string]$Checkpoint.engine + ' · execution: ' + [string]$Checkpoint.executionClass))
    if ($null -ne $Checkpoint.task.acceptanceCriteria) {
        foreach ($criterion in @($Checkpoint.task.acceptanceCriteria)) { [void]$lines.Add(('Criterion: ' + [string]$criterion)) }
    }
    foreach ($outcome in @($Checkpoint.verification.outcomes)) {
        if ($null -eq $outcome) { continue }
        [void]$lines.Add(('Verify: ' + [string]$outcome.name + ' [' + [string]$outcome.status + ']'))
    }
    foreach ($item in @($Checkpoint.verification.acceptanceEvidence)) {
        if ($null -eq $item) { continue }
        [void]$lines.Add(('Evidence: ' + [string]$item.criterion + ' => ' + [string]$item.status))
    }
    if ($null -ne $Checkpoint.repositoryState.headCommit) { [void]$lines.Add(('HEAD: ' + [string]$Checkpoint.repositoryState.headCommit + ' · worktreeClean: ' + [string]$Checkpoint.repositoryState.worktreeClean)) }
    foreach ($file in @($Checkpoint.repositoryState.changedFiles)) {
        if ($null -eq $file) { continue }
        [void]$lines.Add(('File: ' + [string]$file.path + ' (' + [string]$file.status + ')'))
    }
    if ($null -ne $Checkpoint.continuity -and -not [string]::IsNullOrWhiteSpace([string]$Checkpoint.continuity.finalAssistantReport)) {
        [void]$lines.Add(('Final report: ' + [string]$Checkpoint.continuity.finalAssistantReport))
    }
    if ($null -ne $Checkpoint.continuity -and -not [string]::IsNullOrWhiteSpace([string]$Checkpoint.continuity.finalUserRequest)) {
        [void]$lines.Add(('Final request: ' + [string]$Checkpoint.continuity.finalUserRequest))
    }
    [void]$lines.Add('</nexus-context-checkpoint>')
    $text = [string]::Join("`n", $lines)
    if ($text.Length -gt $MaxChars) { $text = $text.Substring(0, $MaxChars) + '...<truncated>' }
    return $text
}

function Set-AihContextLifecycleTransition {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][ValidateSet('inactive', 'eligible', 'checkpoint-ready', 'apply-pending', 'awaiting-durability', 'applied', 'blocked')][string]$To,
        [string]$Reason = '',
        [string]$SessionId = '',
        [string]$CheckpointPath = $null
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $actualInstance = [string]$task.taskInstanceId
    $current = Read-AihContextLifecycleState -Workspace $Workspace -TaskId $TaskId
    $from = 'inactive'
    if (($null -ne $current) -and ($null -ne $current.PSObject.Properties['state'])) { $from = [string]$current.state }
    if (($null -ne $current) -and ($null -ne $current.PSObject.Properties['taskInstanceId']) -and (-not [string]::IsNullOrWhiteSpace([string]$current.taskInstanceId)) -and ([string]$current.taskInstanceId -ne $actualInstance)) {
        throw "Lifecycle refused: persisted state belongs to another generation. (KEEP.)"
    }
    # Legacy checkpoint-ready states (de34d52) carry NO frozen operation.
    # They must never flow into the new apply path: fail safe and require a
    # fresh freeze instead of reinterpreting them. The operation is read
    # lazily ONLY for apply-path targets: the blocked sink must stay
    # reachable even when the operation file is missing or corrupt.
    $operation = $null
    $hasFrozenOperation = $false
    if (($To -eq 'apply-pending') -or ($To -eq 'awaiting-durability') -or ($To -eq 'applied')) {
        try { $operation = Read-AihContextCompactionOperation -Workspace $Workspace -TaskId $TaskId } catch { throw }
        $hasFrozenOperation = ($null -ne $operation) -and ([string]$operation.taskInstanceId -eq $actualInstance)
    }
    $allowed = @{
        'inactive'            = @('eligible', 'blocked')
        'eligible'            = @('checkpoint-ready', 'blocked', 'eligible')
        'checkpoint-ready'    = @('apply-pending', 'blocked', 'checkpoint-ready')
        'apply-pending'       = @('awaiting-durability', 'blocked', 'apply-pending')
        'awaiting-durability' = @('applied', 'blocked', 'awaiting-durability')
        'applied'             = @('applied')
        'blocked'             = @('eligible', 'blocked')
    }
    if (-not (@($allowed[$from]) -contains $To)) {
        throw "Lifecycle refused: transition $from -> $To is not allowed. (KEEP.)"
    }
    if (($from -eq $To) -and (($To -eq 'eligible') -or ($To -eq 'checkpoint-ready') -or ($To -eq 'apply-pending') -or ($To -eq 'awaiting-durability') -or ($To -eq 'applied'))) {
        return [pscustomobject]$current
    }
    if (($To -eq 'eligible') -and ([string]$task.status -ne 'complete')) {
        throw "Lifecycle refused: task $TaskId is not controller-complete. (KEEP.)"
    }
    if ($To -eq 'checkpoint-ready') {
        $checkpoint = Read-AihContextCheckpoint -Workspace $Workspace -TaskId $TaskId -ExpectedTaskInstanceId $actualInstance
        if ($null -eq $checkpoint) { throw 'Lifecycle refused: valid checkpoint is required before checkpoint-ready. (KEEP.)' }
    }
    if (($To -eq 'apply-pending') -or ($To -eq 'awaiting-durability') -or ($To -eq 'applied')) {
        $checkpoint = Read-AihContextCheckpoint -Workspace $Workspace -TaskId $TaskId -ExpectedTaskInstanceId $actualInstance
        if ($null -eq $checkpoint) { throw 'Lifecycle refused: valid checkpoint is required before apply. (KEEP.)' }
        if (-not $hasFrozenOperation) {
            throw 'Lifecycle refused: checkpoint-ready without a frozen compaction operation cannot enter the apply path (legacy state). BLOCK/KEEP; require fresh freeze. (KEEP.)'
        }
        if ([string]$operation.sessionId -ne [string]$SessionId -and -not [string]::IsNullOrWhiteSpace([string]$SessionId)) {
            throw 'Lifecycle refused: frozen operation belongs to another session. (KEEP.)'
        }
    }
    $state = [ordered]@{
        schemaVersion = 1; taskId = $TaskId; taskInstanceId = $actualInstance
        state = [string]$To; previousState = [string]$from; reason = [string]$Reason
        sessionId = [string]$SessionId
        checkpointPath = $(if ($null -ne $CheckpointPath) { [string]$CheckpointPath } elseif (($null -ne $current) -and ($null -ne $current.PSObject.Properties['checkpointPath'])) { [string]$current.checkpointPath } else { $null })
        updatedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    Write-AihContextLifecycleState -Workspace $Workspace -TaskId $TaskId -State $state | Out-Null
    return [pscustomobject]$state
}

$AihContextOperationIdDomain = 'nexus/context-compaction-operation/v1'

function New-AihContextCompactionOperationId {
    # CANONICAL deterministic operation identity (the ONE derivation
    # authority; the JS helper mirrors it byte-for-byte, proven by the
    # parity test). Serialization: domain separator plus taskId plus
    # taskInstanceId plus sessionId, joined by LF, UTF-8, SHA-256 hex,
    # first 32 chars prefixed ccop_. Stable across retries/restarts.
    param([Parameter(Mandatory = $true)][string]$TaskId, [Parameter(Mandatory = $true)][string]$TaskInstanceId, [Parameter(Mandatory = $true)][string]$SessionId)
    $joined = [string]$AihContextOperationIdDomain + "`n" + [string]$TaskId + "`n" + [string]$TaskInstanceId + "`n" + [string]$SessionId
    $bytes = [Text.Encoding]::UTF8.GetBytes($joined)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return ('ccop_' + $digest.Substring(0, 32))
}

function Read-AihContextCompactionOperation {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    if (-not (Test-Path -LiteralPath $paths.Operation)) { return $null }
    try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $paths.Operation | ConvertFrom-Json }
    catch { throw 'Compaction operation blocked: context-compaction-operation.json is malformed. (KEEP: old context retained.)' }
}

function New-AihContextCompactionOperation {
    # Freeze ONE immutable application plan for the completed generation.
    # The caller supplies the ALREADY-VALIDATED balanced cut (computed once
    # from the completion-time surface); this function persists it verbatim
    # and NEVER widens it. Retry reuses the frozen boundary exactly.
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][int]$ReplacementStart,
        [Parameter(Mandatory = $true)][int[]]$SourceEventSeqs,
        [Parameter(Mandatory = $true)][int]$ReplacementEnd,
        [string]$CheckpointPath = $null,
        [object[]]$Segments = @(),
        [int]$CompletionBoundarySeq = -1,
        [string]$RepositoryId = $null,
        [string]$CheckoutId = $null
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ([string]$task.status -ne 'complete') { throw "Operation refused: task $TaskId status is '$($task.status)', not complete. (KEEP.)" }
    $operationId = New-AihContextCompactionOperationId -TaskId $TaskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId $SessionId
    $existing = $null
    try { $existing = Read-AihContextCompactionOperation -Workspace $Workspace -TaskId $TaskId } catch { throw }
    if (($null -ne $existing) -and ([string]$existing.taskInstanceId -eq [string]$task.taskInstanceId) -and ([string]$existing.operationId -eq $operationId)) {
        # Idempotent retry: the frozen boundary is returned verbatim even when
        # the caller recomputed a wider candidate range. Retry never widens.
        return [pscustomobject]$existing
    }
    if ((@($SourceEventSeqs).Count -eq 0) -or ([int]$ReplacementStart -lt 0) -or ([int]$ReplacementEnd -lt 0)) {
        throw 'Operation refused: empty replacement boundary. (KEEP.)'
    }
    if ([int]$SourceEventSeqs[0] -ne [int]$ReplacementStart -or [int]$SourceEventSeqs[-1] -ne [int]$ReplacementEnd) {
        throw 'Operation refused: range must match the first and last source seqs. (KEEP.)'
    }
    if ([int]$CompletionBoundarySeq -lt 0) {
        throw 'Operation refused: completionBoundarySeq is required (Task A ownership cap). (KEEP.)'
    }
    $sortedCheck = @([int[]]$SourceEventSeqs | Sort-Object -Unique)
    if ([int]$sortedCheck.Count -ne [int]@($SourceEventSeqs).Count) {
        throw 'Operation refused: duplicate sourceEventSeqs. (KEEP.)'
    }
    foreach ($seq in @($SourceEventSeqs)) {
        if ([int]$seq -gt [int]$CompletionBoundarySeq) {
            throw 'Operation refused: source seq newer than completionBoundarySeq (Task B adoption). (KEEP.)'
        }
    }
    if (($null -ne $existing) -and ([string]$existing.taskInstanceId -eq [string]$task.taskInstanceId) -and ([string]$existing.operationId -ne $operationId)) {
        throw 'Operation refused: a different frozen operation already owns this generation. (KEEP: never adopt or widen.)'
    }
    $segmentRecords = @()
    if (@($Segments).Count -gt 0) {
        $flatCheck = [Collections.Generic.List[int]]::new()
        foreach ($segment in @($Segments)) {
            if (($null -eq $segment) -or ($null -eq $segment.start) -or ($null -eq $segment.end) -or ($null -eq $segment.sourceEventSeqs) -or (@($segment.sourceEventSeqs).Count -eq 0)) {
                throw 'Operation refused: malformed frozen segment. (KEEP.)'
            }
            if ([int]$segment.sourceEventSeqs[0] -ne [int]$segment.start -or [int]$segment.sourceEventSeqs[-1] -ne [int]$segment.end) {
                throw 'Operation refused: frozen segment range must match its seqs. (KEEP.)'
            }
            foreach ($seq in @($segment.sourceEventSeqs)) { [void]$flatCheck.Add([int]$seq) }
            $segmentRecords += [ordered]@{ start = [int]$segment.start; end = [int]$segment.end; sourceEventSeqs = @([int[]]$segment.sourceEventSeqs) }
        }
        $expected = @([int[]]$SourceEventSeqs)
        if ([int]$flatCheck.Count -ne [int]$expected.Count) { throw 'Operation refused: frozen segments must cover exactly the source seqs. (KEEP.)' }
        for ($i = 0; $i -lt $expected.Count; $i++) {
            if ([int]$flatCheck[$i] -ne [int]$expected[$i]) { throw 'Operation refused: frozen segments must cover exactly the source seqs. (KEEP.)' }
        }
    }
    $operation = [ordered]@{
        schemaVersion = [int]$AihContextOperationSchemaVersion
        operationId = [string]$operationId
        taskId = [string]$TaskId
        taskInstanceId = [string]$task.taskInstanceId
        sessionId = [string]$SessionId
        workspace = [string]$Workspace
        checkpointPath = $(if ($null -ne $CheckpointPath) { [string]$CheckpointPath } else { $null })
        replacementStart = [int]$ReplacementStart
        replacementEnd = [int]$ReplacementEnd
        sourceEventSeqs = @([int[]]$SourceEventSeqs)
        segments = @($segmentRecords)
        completionBoundarySeq = [int]$CompletionBoundarySeq
        repositoryId = $(if ($null -ne $RepositoryId) { [string]$RepositoryId } else { $null })
        checkoutId = $(if ($null -ne $CheckoutId) { [string]$CheckoutId } else { $null })
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    if (@($segmentRecords).Count -eq 0) {
        throw 'Operation refused: the exact validated segment plan must be persisted (no silent single-span fallback). (KEEP.)'
    }
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    Write-AihAtomicJson $paths.Operation $operation
    $readBack = Read-AihContextCompactionOperation -Workspace $Workspace -TaskId $TaskId
    if (($null -eq $readBack) -or ([string]$readBack.operationId -ne [string]$operationId)) {
        throw 'Operation refused: read-back validation failed after atomic write. (KEEP.)'
    }
    return [pscustomobject]$readBack
}

function Test-AihContextOperationReconcile {
    # Restart/retry reconciliation input: given the live surface seqs observed
    # by the bridge plus whether the frozen replacement node is durably
    # present, decide reconcile / retry-same / block. NEVER widens the range.
    # LiveSurfaceSeqs: current session.surface.nodes (numbers, surface order).
    # LandedReplacementSeq: seq of the frozen replacement node when durably
    #   present, else -1.
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [int[]]$LiveSurfaceSeqs = @(),
        [int]$LandedReplacementSeq = -1,
        [string]$SessionId = '',
        [bool]$DurablyVerified = $false
    )
    $task = $null
    try { $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    catch { return [pscustomobject][ordered]@{ decision = 'block'; reason = 'task identity unproven for this generation'; operationId = $null } }
    $operation = $null
    try { $operation = Read-AihContextCompactionOperation -Workspace $Workspace -TaskId $TaskId }
    catch { return [pscustomobject][ordered]@{ decision = 'block'; reason = 'frozen operation unreadable'; operationId = $null } }
    if (($null -eq $operation) -or ([string]$operation.taskInstanceId -ne [string]$task.taskInstanceId)) {
        return [pscustomobject][ordered]@{ decision = 'block'; reason = 'no frozen operation for this generation'; operationId = $null }
    }
    if ([int]$operation.schemaVersion -ne [int]$AihContextOperationSchemaVersion) {
        return [pscustomobject][ordered]@{ decision = 'block'; reason = 'operation schema mismatch'; operationId = [string]$operation.operationId }
    }
    # F2 provenance gate: session + workspace must match BEFORE any other
    # reasoning. Wrong-session or wrong-workspace callers get zero mutation.
    if ([string]$operation.sessionId -ne [string]$SessionId) {
        return [pscustomobject][ordered]@{ decision = 'block'; reason = 'operation belongs to another session'; operationId = [string]$operation.operationId }
    }
    if ([string]$operation.workspace -ne [string]$Workspace) {
        return [pscustomobject][ordered]@{ decision = 'block'; reason = 'operation belongs to another workspace'; operationId = [string]$operation.operationId }
    }
    $liveSet = [Collections.Generic.HashSet[int]]::new()
    foreach ($seq in @($LiveSurfaceSeqs)) { [void]$liveSet.Add([int]$seq) }
    if ([int]$LandedReplacementSeq -ge 0) {
        if (-not $liveSet.Contains([int]$LandedReplacementSeq)) {
            return [pscustomobject][ordered]@{ decision = 'block'; reason = 'landed replacement not on live surface'; operationId = [string]$operation.operationId }
        }
        # Contract A (partial-segment restart): every frozen segment must be
        # EITHER fully live (still to append) OR fully shadowed (landed). A
        # partially shadowed segment can never be safely re-appended.
        $missingSegments = 0
        foreach ($segment in @($operation.segments)) {
            $liveCount = 0
            foreach ($seq in @($segment.sourceEventSeqs)) { if ($liveSet.Contains([int]$seq)) { $liveCount++ } }
            if ($liveCount -eq 0) { continue }
            if ($liveCount -eq @($segment.sourceEventSeqs).Count) { $missingSegments++ ; continue }
            return [pscustomobject][ordered]@{ decision = 'block'; reason = 'partially shadowed segment cannot be safely re-appended'; operationId = [string]$operation.operationId }
        }
        if ([int]$missingSegments -eq 0) {
            # F5 MANDATORY: memory presence is not durability.
            # reconcile-applied requires the caller to have verified the
            # replacement from DURABLE persistence (flush + restore/proof),
            # not merely the live object.
            if (-not [bool]$DurablyVerified) {
                return [pscustomobject][ordered]@{ decision = 'await-durability'; reason = 'landed in memory only; durable proof required'; operationId = [string]$operation.operationId }
            }
            return [pscustomobject][ordered]@{ decision = 'reconcile-applied'; reason = 'frozen replacement durably verified'; operationId = [string]$operation.operationId }
        }
        return [pscustomobject][ordered]@{
            decision = 'retry-same'; reason = 'partial landing: only exact missing segments remain'
            operationId = [string]$operation.operationId
            replacementStart = [int]$operation.replacementStart; replacementEnd = [int]$operation.replacementEnd
            sourceEventSeqs = @($operation.sourceEventSeqs)
            segments = @($operation.segments)
        }
    }
    foreach ($seq in @($operation.sourceEventSeqs)) {
        if (-not $liveSet.Contains([int]$seq)) {
            return [pscustomobject][ordered]@{ decision = 'block'; reason = 'frozen source seq missing from live surface'; operationId = [string]$operation.operationId }
        }
    }
    if ($null -eq $operation.PSObject.Properties['segments'] -or @($operation.segments).Count -eq 0) {
        return [pscustomobject][ordered]@{ decision = 'block'; reason = 'frozen segment plan missing; refusing single-span fallback'; operationId = [string]$operation.operationId }
    }
    return [pscustomobject][ordered]@{
        decision = 'retry-same'; reason = 'exact frozen boundary still valid'
        operationId = [string]$operation.operationId
        replacementStart = [int]$operation.replacementStart; replacementEnd = [int]$operation.replacementEnd
        sourceEventSeqs = @($operation.sourceEventSeqs)
        segments = @($operation.segments)
    }
}

function Get-AihCompactionApplyLockPath {
    # Cross-process application lock file, scoped to exactly one task run
    # dir plus one operation. A lock FILE (not a Mutex handle) is used
    # because acquire and release span separate CLI processes: exclusivity
    # comes from atomic create-new (O_EXCL equivalent), abandonment recovery
    # from a bounded lease. Never held across Git/model/checkpoint work --
    # only the caller-guarded append/flush/verify section.
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $layout = Get-AihLedgerLayout $Workspace
    return (Join-Path (Join-Path $layout.Runs $TaskId) 'context-compaction-apply.lock')
}

function Invoke-AihCompactionApplyLockAcquire {
    # Acquire the cross-process apply lock via atomic create-new. Lease
    # bounds abandonment: a stale holder (expired lease) may be taken over
    # exactly once per acquire call; a live holder yields acquired=false so
    # the caller KEEPs/BLOCKs instead of launching a second writer.
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [int]$LeaseSeconds = 60
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $lockPath = Get-AihCompactionApplyLockPath -Workspace $Workspace -TaskId $TaskId
    $ownerId = [guid]::NewGuid().ToString('N')
    $now = [DateTime]::UtcNow
    $lease = [Math]::Max(1, [int]$LeaseSeconds)
    $ownerPid = 0
    try { $ownerPid = [int]$PID } catch { $ownerPid = 0 }
    $processStart = $null
    try { $processStart = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { $processStart = $null }
    $payload = [ordered]@{
        schemaVersion = 2; taskId = $TaskId; taskInstanceId = [string]$task.taskInstanceId
        sessionId = [string]$SessionId; operationId = [string]$OperationId
        ownerId = [string]$ownerId; ownerPid = $ownerPid; ownerProcessStartUtc = $processStart
        acquiredAtUtc = $now.ToString('o'); renewedAtUtc = $now.ToString('o')
        expiresAtUtc = $now.AddSeconds($lease).ToString('o')
    }
    $directory = Split-Path -Parent ([System.IO.Path]::GetFullPath($lockPath))
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    # The whole check-and-create sequence runs inside the mutation mutex so
    # two contenders cannot both observe absence and both create.
    return (Use-AihCompactionLockMutex -SessionId $SessionId -OperationId $OperationId {
        if (Test-Path -LiteralPath $lockPath) {
            $existing = $null
            try { $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $lockPath | ConvertFrom-Json } catch { $existing = $null }
            if ($null -ne $existing) {
                if (([string]$existing.taskInstanceId -ne [string]$task.taskInstanceId) -or ([string]$existing.operationId -ne [string]$OperationId) -or ([string]$existing.sessionId -ne [string]$SessionId)) {
                    return [pscustomobject][ordered]@{ acquired = $false; reason = 'held-by-other-operation' }
                }
                $expiry = [DateTime]::MinValue
                if ($null -ne $existing.PSObject.Properties['expiresAtUtc']) { [void][DateTime]::TryParse([string]$existing.expiresAtUtc, [ref]$expiry) }
                if ($expiry -gt [DateTime]::UtcNow) { return [pscustomobject][ordered]@{ acquired = $false; reason = 'held-by-live-owner' } }
                $renewedAt = [DateTime]::MinValue
                if ($null -ne $existing.PSObject.Properties['renewedAtUtc']) { [void][DateTime]::TryParse([string]$existing.renewedAtUtc, [ref]$renewedAt) }
                $ownerPid = 0
                if ($null -ne $existing.PSObject.Properties['ownerPid']) { [void][int]::TryParse([string]$existing.ownerPid, [ref]$ownerPid) }
                $ownerAlive = $false
                if ($ownerPid -gt 0) {
                    try {
                        $proc = Get-Process -Id $ownerPid -ErrorAction Stop
                        $started = $proc.StartTime.ToUniversalTime().ToString('o')
                        $recorded = $null
                        if ($null -ne $existing.PSObject.Properties['ownerProcessStartUtc']) { $recorded = [string]$existing.ownerProcessStartUtc }
                        $ownerAlive = ([string]::IsNullOrWhiteSpace($recorded) -or ($started -eq $recorded))
                    } catch { $ownerAlive = $false }
                }
                # Takeover requires BOTH expiry AND no defensible liveness:
                # a provably live owner process (same PID plus start time)
                # fences takeover even past expiry -- its renew-gate stops it
                # if it truly stalled, and renewal resumes when it wakes.
                # Only a dead/unknown owner may be taken over.
                if ($ownerAlive) { return [pscustomobject][ordered]@{ acquired = $false; reason = 'held-by-live-owner' } }
            }
            try { Remove-Item -LiteralPath $lockPath -Force } catch { return [pscustomobject][ordered]@{ acquired = $false; reason = 'takeover-raced' } }
        }
        try {
            $stream = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject (ConvertTo-AihJsonSafe $payload) -Depth 10))
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush()
            } finally { $stream.Dispose() }
            return [pscustomobject][ordered]@{ acquired = $true; ownerId = [string]$ownerId; leaseSeconds = $lease }
        } catch [IO.IOException] { return [pscustomobject][ordered]@{ acquired = $false; reason = 'takeover-raced' } }
    })
}

function Invoke-AihCompactionApplyLockRenew {
    # Owner-token-guarded renewal: ONLY the current ownerId may extend the
    # lease. A renewal both proves ownership (§14 stage gate) and extends
    # expiry, so a healthy live owner is never evicted by wall-clock expiry.
    # Renewal is a single atomic file replace performed under a short-lived
    # process mutex (see Use-AihCompactionLockMutex); the ownerId check and
    # the write happen inside the same critical section, so a concurrent
    # takeover cannot interleave between check and write.
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][string]$OwnerId,
        [int]$LeaseSeconds = 60
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $lockPath = Get-AihCompactionApplyLockPath -Workspace $Workspace -TaskId $TaskId
    $lease = [Math]::Max(1, [int]$LeaseSeconds)
    return (Use-AihCompactionLockMutex -SessionId $SessionId -OperationId $OperationId {
        if (-not (Test-Path -LiteralPath $lockPath)) { return [pscustomobject][ordered]@{ renewed = $false; reason = 'lock-absent' } }
        $existing = $null
        try { $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $lockPath | ConvertFrom-Json } catch { $existing = $null }
        if ($null -eq $existing) { return [pscustomobject][ordered]@{ renewed = $false; reason = 'lock-unreadable' } }
        if ([string]$existing.taskInstanceId -ne [string]$task.taskInstanceId) { return [pscustomobject][ordered]@{ renewed = $false; reason = 'generation-mismatch' } }
        if ([string]$existing.ownerId -ne [string]$OwnerId) { return [pscustomobject][ordered]@{ renewed = $false; reason = 'not-owner' } }
        $now = [DateTime]::UtcNow
        $existing.renewedAtUtc = $now.ToString('o')
        $existing.expiresAtUtc = $now.AddSeconds($lease).ToString('o')
        Write-AihAtomicJson $lockPath $existing
        return [pscustomobject][ordered]@{ renewed = $true; expiresAtUtc = [string]$existing.expiresAtUtc }
    })
}

function Use-AihCompactionLockMutex {
    # Short-lived cross-process mutex serializing lock-FILE mutations only
    # (acquire/takeover/renew/release decisions). Held for milliseconds,
    # never across append/flush/verify. Abandoned owners are treated as
    # releasable (the file content itself remains the authority).
    param([Parameter(Mandatory = $true)][string]$SessionId, [Parameter(Mandatory = $true)][string]$OperationId, [Parameter(Mandatory = $true)][scriptblock]$Action)
    $name = ConvertTo-AihSafeSyncName ('AIHarness.ContextCompaction.LockFile.' + [string]$SessionId + '.' + [string]$OperationId)
    $mutex = $null
    try { $mutex = [Threading.Mutex]::new($false, $name) }
    catch { return (& $Action) }
    $taken = $false
    try {
        try { $taken = $mutex.WaitOne(5000) }
        catch [Threading.AbandonedMutexException] { $taken = $true }
        catch { return (& $Action) }
        return (& $Action)
    } finally {
        if ($taken) { try { $mutex.ReleaseMutex() } catch { } }
        try { $mutex.Dispose() } catch { }
    }
}

function Invoke-AihCompactionApplyLockRelease {
    # Release only when the caller still owns the lock (ownerId match).
    # Best-effort and idempotent; never throws.
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$OwnerId
    )
    $lockPath = Get-AihCompactionApplyLockPath -Workspace $Workspace -TaskId $TaskId
    try {
        if (-not (Test-Path -LiteralPath $lockPath)) { return [pscustomobject][ordered]@{ released = $true; reason = 'already-absent' } }
        $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $lockPath | ConvertFrom-Json
        if (($null -ne $existing) -and ($null -ne $existing.PSObject.Properties['ownerId']) -and ([string]$existing.ownerId -ne [string]$OwnerId)) {
            return [pscustomobject][ordered]@{ released = $false; reason = 'not-owner' }
        }
        Remove-Item -LiteralPath $lockPath -Force
        return [pscustomobject][ordered]@{ released = $true }
    } catch { return [pscustomobject][ordered]@{ released = $false; reason = 'release-error' } }
}

function Get-AihContextLifecycleSnapshot {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId, [string]$TaskInstanceId = '')
    $state = Read-AihContextLifecycleState -Workspace $Workspace -TaskId $TaskId
    $pressure = Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId
    $stateName = 'inactive'
    if (($null -ne $state) -and ($null -ne $state.PSObject.Properties['state'])) { $stateName = [string]$state.state }
    return [pscustomobject][ordered]@{
        schemaVersion = 1; taskId = $TaskId
        taskInstanceId = $(if (-not [string]::IsNullOrWhiteSpace($TaskInstanceId)) { [string]$TaskInstanceId } elseif (($null -ne $state) -and ($null -ne $state.PSObject.Properties['taskInstanceId'])) { [string]$state.taskInstanceId } else { $null })
        state = $stateName; lifecycle = $state; pressure = $pressure
    }
}
function Write-AihContextCompactionTelemetry {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)]$Eligibility,
        [string]$SessionId = '',
        [string]$CheckpointPath = $null,
        [object]$CheckpointSizeBytes = $null,
        [bool]$CheckpointApplied = $false,
        [string]$AppliedAtUtc = $null,
        [string]$BlockedReason = $null
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $layout = Get-AihLedgerLayout $Workspace
    $run = Join-Path $layout.Runs $TaskId
    $record = [ordered]@{
        schemaVersion = 1; taskId = $TaskId; taskInstanceId = [string]$task.taskInstanceId
        sessionId = [string]$SessionId
        engine = $(if ($null -ne $task.PSObject.Properties['boundEngine']) { [string]$task.boundEngine } else { $null })
        thresholdTokens = [int]$Eligibility.thresholdTokens
        latestEffectiveInputTokens = [int]$Eligibility.latestEffectiveInputTokens
        peakEffectiveInputTokens = [int]$Eligibility.peakEffectiveInputTokens
        cumulativeUncachedInputTokens = [int]$Eligibility.cumulativeUncachedInputTokens
        cumulativeCacheReadTokens = [int]$Eligibility.cumulativeCacheReadTokens
        cumulativeOutputTokens = [int]$Eligibility.cumulativeOutputTokens
        rootModelCallCount = [int]$Eligibility.rootModelCallCount
        eligibilityDecision = [string]$Eligibility.eligibilityDecision
        eligibilityReason = [string]$Eligibility.eligibilityReason
        checkpointPath = $(if ($null -ne $CheckpointPath) { [string]$CheckpointPath } else { $null })
        checkpointSizeBytes = $CheckpointSizeBytes
        checkpointApplied = [bool]$CheckpointApplied
        appliedAtUtc = $AppliedAtUtc; blockedReason = $BlockedReason
        recordedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    Write-AihAtomicJson (Join-Path $run 'context-compaction-telemetry.json') $record
    return [pscustomobject]$record
}

function Set-AihContextCompactionApplied {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][string]$AppliedAtUtc,
        [string]$SessionId = ''
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $lifecycle = Read-AihContextLifecycleState -Workspace $Workspace -TaskId $TaskId
    if (($null -eq $lifecycle) -or ([string]$lifecycle.state -ne 'applied') -or ([string]$lifecycle.taskInstanceId -ne [string]$task.taskInstanceId)) {
        throw 'Mark-applied refused: lifecycle state is not applied for this generation. (KEEP.)'
    }
    $layout = Get-AihLedgerLayout $Workspace
    $run = Join-Path $layout.Runs $TaskId
    $telemetryPath = Join-Path $run 'context-compaction-telemetry.json'
    if (-not (Test-Path -LiteralPath $telemetryPath)) { throw 'Mark-applied refused: no compaction telemetry for this generation. (KEEP.)' }
    $telemetry = Get-Content -Raw -Encoding UTF8 -LiteralPath $telemetryPath | ConvertFrom-Json
    if ([string]$telemetry.taskInstanceId -ne [string]$task.taskInstanceId) { throw 'Mark-applied refused: generation mismatch. (KEEP.)' }
    if ([bool]$telemetry.checkpointApplied) { return [pscustomobject]$telemetry }
    $telemetry.checkpointApplied = $true
    $telemetry.appliedAtUtc = [string]$AppliedAtUtc
    $telemetry | Add-Member -NotePropertyName 'appliedSessionId' -NotePropertyValue ([string]$SessionId) -Force
    Write-AihAtomicJson $telemetryPath $telemetry
    return [pscustomobject]$telemetry
}

function Add-AihContextPostCompactionUsage {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][int]$PostCompactionEffectiveInputTokens,
        [string]$SessionId = ''
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $layout = Get-AihLedgerLayout $Workspace
    $run = Join-Path $layout.Runs $TaskId
    $telemetryPath = Join-Path $run 'context-compaction-telemetry.json'
    if (-not (Test-Path -LiteralPath $telemetryPath)) { throw 'Post-compaction telemetry refused: no compaction telemetry for this generation. (KEEP.)' }
    $telemetry = Get-Content -Raw -Encoding UTF8 -LiteralPath $telemetryPath | ConvertFrom-Json
    if ([string]$telemetry.taskInstanceId -ne [string]$task.taskInstanceId) { throw 'Post-compaction telemetry refused: generation mismatch. (KEEP.)' }
    if (-not [bool]$telemetry.checkpointApplied) { throw 'Post-compaction telemetry refused: checkpoint was not applied. (KEEP.)' }
    if ($null -ne $telemetry.PSObject.Properties['postCompactionEffectiveInputTokens']) { return [pscustomobject]$telemetry }
    $pre = [int]$telemetry.latestEffectiveInputTokens
    $reduction = $pre - [int]$PostCompactionEffectiveInputTokens
    $telemetry | Add-Member -NotePropertyName 'postCompactionEffectiveInputTokens' -NotePropertyValue ([int]$PostCompactionEffectiveInputTokens) -Force
    $telemetry | Add-Member -NotePropertyName 'firstCallTokenReduction' -NotePropertyValue ([int]$reduction) -Force
    $telemetry | Add-Member -NotePropertyName 'postCompactionSessionId' -NotePropertyValue ([string]$SessionId) -Force
    $telemetry | Add-Member -NotePropertyName 'postCompactionRecordedAtUtc' -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    Write-AihAtomicJson $telemetryPath $telemetry
    return [pscustomobject]$telemetry
}

