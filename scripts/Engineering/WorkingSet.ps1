Set-StrictMode -Version Latest

# Engineering.WorkingSet - Phase 3.2.5 Working Set v0.
#
# A compact, AUTHORITATIVE, TASK-LOCAL current-state representation designed
# to stop the growing conversation transcript from becoming the effective
# engineering state. It is NOT persistent memory, NOT Phase 3.6, NOT the
# Phase 3.7 Context Planner, NOT embeddings/vector search.
#
# Repository evidence is retrieved THROUGH the existing TASK-0009/TASK-0012
# ContextEngine (Invoke-AihContextRetrieval). No second filesystem walker,
# no second lexical ranking, no second relevance selector exists here. Full
# retrieval provenance (score, normalizedScore, evidenceClass, matchedTerms,
# matchedPhrases, pathMatches, coverageContribution, selectionReason,
# classification, eligibility, reason) is retained.
#
# Authority order: user instruction > working tree > deterministic repository
# facts > human architecture decision > validated Working Set fact > LLM
# inference. Stale facts are invalidated, never silently kept.

function Get-AihWorkingSetPath {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId)
    $run = Get-AihEngineeringRunPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    return (Join-Path $run 'working-set.json')
}

function New-AihWorkingSet {
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [string]$Objective = '',[string[]]$Constraints = @(),[string[]]$Invariants = @()
    )
    $path = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $existing = Read-AihEngineeringJson -Path $path -Default $null
    if ($null -ne $existing -and (Test-AihEngineeringArtifactIdentity -Artifact $existing -TaskInstanceId $TaskInstanceId)) { return $existing }
    if ([string]::IsNullOrWhiteSpace($Objective)) {
        $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId
        if ($null -ne $task -and $null -ne $task.PSObject.Properties['description']) { $Objective = [string]$task.description }
    }
    $workingSet = [ordered]@{
        schemaVersion = 1
        kind = 'engineering-working-set'
        taskId = $TaskId
        taskInstanceId = if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) { $null } else { $TaskInstanceId }
        objective = $Objective
        currentMilestone = $null
        requirementsRef = 'requirements.json'
        constraints = @($Constraints)
        invariants = @($Invariants)
        evidence = [ordered]@{
            files = @(); symbols = @(); architectureFacts = @(); testFacts = @(); runtimeFacts = @()
        }
        decisions = @()
        changedFiles = @()
        currentDiffSummary = $null
        currentFailure = $null
        failureHistory = @()
        currentHypothesis = $null
        hypothesisKey = $null
        nextAction = $null
        nextVerification = $null
        execution = [ordered]@{
            currentRole = $null; previousRole = $null
            lastEscalationReason = $null; lastEscalationSignature = $null; lastDeepArtifact = $null
        }
        epistemic = [ordered]@{
            stateRef = 'epistemic-state.json'; actionsRef = 'epistemic-actions.jsonl'
            currentUncertaintyId = $null; currentActionId = $null; currentAction = $null
            uncertaintyStatus = $null; evidenceConflict = $false; lastSelectionReason = $null
        }
        evidenceVersion = '0'
        retrieval = [ordered]@{ lastQuery = $null; retrievedFileCount = 0; retrievedEvidenceCount = 0; lastRetrievedAtUtc = $null }
        updatedAtUtc = Get-AihEngineeringUtcNow
    }
    Write-AihAtomicJson -Path $path -Value $workingSet
    return (Read-AihEngineeringJson -Path $path -Default $null)
}

function Get-AihWorkingSet {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $path = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSet = Read-AihEngineeringJson -Path $path -Default $null
    if ($null -eq $workingSet) { return $null }
    if (-not (Test-AihEngineeringArtifactIdentity -Artifact $workingSet -TaskInstanceId $TaskInstanceId)) {
        # A Working Set from another lifecycle generation is STALE: the new
        # generation starts fresh instead of inheriting cross-generation state.
        return $null
    }
    return $workingSet
}

function Save-AihWorkingSet {
    param([Parameter(Mandatory=$true)]$WorkingSet,[Parameter(Mandatory=$true)][string]$Path)
    $WorkingSet.updatedAtUtc = Get-AihEngineeringUtcNow
    Write-AihAtomicJson -Path $Path -Value $WorkingSet
}

function Update-AihWorkingSetFromInstruction {
    # Current explicit user instruction overrides stale Working Set state.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [Parameter(Mandatory=$true)][string]$Instruction
    )
    $path = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $workingSet) { $workingSet = New-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    $workingSet.objective = $Instruction
    # A new instruction supersedes the previous hypothesis chain.
    $workingSet.currentHypothesis = $null
    $workingSet.hypothesisKey = $null
    Save-AihWorkingSet -WorkingSet $workingSet -Path $path
    # TASK-0016: a materially new user instruction supersedes unresolved
    # task-local uncertainties. This calls the already-loaded policy module
    # when available; legacy callers that source WorkingSet alone remain safe.
    if ($null -ne (Get-Command Supersede-AihOpenUncertainties -ErrorAction SilentlyContinue)) {
        Supersede-AihOpenUncertainties -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Reason 'current user instruction changed' | Out-Null
    }
    return $workingSet
}

function Set-AihWorkingSetMilestone {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,[string]$MilestoneId,[string]$NextAction = '')
    $path = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $workingSet) { $workingSet = New-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    $workingSet.currentMilestone = $MilestoneId
    if (-not [string]::IsNullOrEmpty($NextAction)) { $workingSet.nextAction = $NextAction }
    Save-AihWorkingSet -WorkingSet $workingSet -Path $path
    return $workingSet
}

function Add-AihWorkingSetFact {
    # Record a validated task-local fact into a structured evidence bucket.
    # Dimension tags feed the Evidence Gate. fileRefs carry the content hash
    # observed NOW so later file changes invalidate the fact.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [Parameter(Mandatory=$true)][ValidateSet('files','symbols','architectureFacts','testFacts','runtimeFacts')][string]$Bucket,
        [Parameter(Mandatory=$true)][string]$Fact,
        [string[]]$Dimensions = @(),[string[]]$FileRefs = @(),[string]$Source = 'deterministic-repository',[string]$Detail = ''
    )
    $path = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $workingSet) { $workingSet = New-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    $fileProof = @()
    foreach ($fileRef in @($FileRefs)) {
        $absolute = if ([IO.Path]::IsPathRooted($fileRef)) { $fileRef } else { Join-Path ([IO.Path]::GetFullPath($Workspace)) $fileRef }
        $fileProof += [ordered]@{ path = ($fileRef.Replace([string][char]92, '/')); contentHash = (Get-AihEngineeringFileHash $absolute) }
    }
    # NOTE: the record variable MUST NOT be named $fact — it would collide
    # case-insensitively with the [string]$Fact parameter, and assigning a
    # dictionary to a typed parameter variable re-applies the [string]
    # constraint, silently stringifying the record.
    $factRecord = [ordered]@{
        factId = 'F-' + (Get-AihEngineeringSha256 ($Bucket + '|' + $Fact)).Substring(0,12)
        fact = (ConvertTo-AihEngineeringSafeText $Fact 1000)
        dimensions = @($Dimensions)
        source = $Source
        detail = (ConvertTo-AihEngineeringSafeText $Detail 500)
        fileProof = @($fileProof)
        recordedAtUtc = Get-AihEngineeringUtcNow
        invalidated = $false
    }
    $workingSet.evidence.$Bucket = @($workingSet.evidence.$Bucket) + @($factRecord)
    $workingSet.evidenceVersion = ([int64]$workingSet.evidenceVersion + 1).ToString()
    Save-AihWorkingSet -WorkingSet $workingSet -Path $path
    return $factRecord
}

function Invoke-AihWorkingSetRetrieval {
    # Working Set evidence retrieval THROUGH the existing ContextEngine.
    # Reuses canonical context eligibility, the Phase 3.1 walker/classification
    # and the TASK-0009 ranking + TASK-0012 concentration provenance.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [Parameter(Mandatory=$true)][string]$Query,[int]$MaxResults = 20
    )
    . (Join-Path $PSScriptRoot ('..' + [IO.Path]::DirectorySeparatorChar + 'ContextEngine.ps1'))
    $path = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $workingSet) { $workingSet = New-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    $retrieval = Invoke-AihContextRetrieval -Workspace ([IO.Path]::GetFullPath($Workspace)) -Query $Query -MaxResults $MaxResults
    $candidates = @()
    if ($null -ne $retrieval -and $null -ne $retrieval.PSObject.Properties['candidates']) { $candidates = @($retrieval.candidates) }
    $existingByPath = @{}
    foreach ($known in @($workingSet.evidence.files)) { $existingByPath[[string]$known.path] = $known }
    $freshCount = 0
    foreach ($candidate in $candidates) {
        $relativePath = [string]$candidate.file
        $absolute = Join-Path ([IO.Path]::GetFullPath($Workspace)) ($relativePath.Replace('/', [string][char]92))
        $entry = [ordered]@{
            path = $relativePath
            score = $candidate.score
            normalizedScore = if ($null -ne $candidate.PSObject.Properties['normalizedScore']) { $candidate.normalizedScore } else { $null }
            evidenceClass = $candidate.evidenceClass
            classification = $candidate.classification
            matchedTerms = @($candidate.matchedTerms)
            matchedPhrases = if ($null -ne $candidate.PSObject.Properties['matchedPhrases']) { @($candidate.matchedPhrases) } else { @() }
            pathMatches = @($candidate.pathMatches)
            coverageContribution = if ($null -ne $candidate.PSObject.Properties['coverageContribution']) { $candidate.coverageContribution } else { $null }
            selectionReason = if ($null -ne $candidate.PSObject.Properties['selectionReason']) { $candidate.selectionReason } else { $null }
            eligibility = 'eligible'
            reason = if ($null -ne $candidate.PSObject.Properties['selectionReason']) { $candidate.selectionReason } else { 'context-engine retrieval' }
            contentVersion = (Get-AihEngineeringFileHash $absolute)
            retrievedAtUtc = Get-AihEngineeringUtcNow
            repeatedRetrieval = $existingByPath.ContainsKey($relativePath)
        }
        $existingByPath[$relativePath] = $entry
        $freshCount++
    }
    $merged = @($existingByPath.Values)
    $workingSet.evidence.files = $merged
    $workingSet.retrieval.lastQuery = $Query
    $workingSet.retrieval.retrievedFileCount = $candidates.Count
    $workingSet.retrieval.retrievedEvidenceCount = (@($candidates | ForEach-Object { @($_.matchedTerms).Count } | Measure-Object -Sum).Sum)
    $workingSet.retrieval.lastRetrievedAtUtc = Get-AihEngineeringUtcNow
    $workingSet.evidenceVersion = ([int64]$workingSet.evidenceVersion + 1).ToString()
    Save-AihWorkingSet -WorkingSet $workingSet -Path $path
    return [ordered]@{ retrieved = $freshCount; candidates = $candidates; workingSet = $workingSet }
}

function Update-AihWorkingSetInvalidation {
    # Deterministic invalidation: any fact whose file proof no longer matches
    # the current file content hash is invalidated (stale facts are never
    # silently kept). Returns the invalidated fact ids.
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId)
    $path = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $workingSet) { return @() }
    $invalidated = @()
    $changed = $false
    foreach ($bucketName in @('files','symbols','architectureFacts','testFacts','runtimeFacts')) {
        foreach ($fact in @($workingSet.evidence.$bucketName)) {
            if ($null -eq $fact.PSObject.Properties['invalidated'] -or -not [bool]$fact.invalidated) {
                # Retrieval-derived file entries carry no invalidation proof;
                # they are re-validated through their contentVersion below.
                if ($null -eq $fact.PSObject.Properties['fileProof']) { continue }
            }
            foreach ($proof in @($fact.fileProof)) {
                $relative = ([string]$proof.path).Replace('/', [string][char]92)
                $absolute = if ([IO.Path]::IsPathRooted($relative)) { $relative } else { Join-Path ([IO.Path]::GetFullPath($Workspace)) $relative }
                $currentHash = Get-AihEngineeringFileHash $absolute
                $recordedHash = [string]$proof.contentHash
                $missing = $null -eq $currentHash
                if ($missing -or ($null -ne $recordedHash -and $recordedHash -ne '' -and $currentHash -ne $recordedHash)) {
                    Set-AihEngineeringProperty -Object $fact -Name 'invalidated' -Value $true
                    Set-AihEngineeringProperty -Object $fact -Name 'invalidatedAtUtc' -Value (Get-AihEngineeringUtcNow)
                    Set-AihEngineeringProperty -Object $fact -Name 'invalidationReason' -Value $(if ($missing) { 'file removed' } else { 'file content changed' })
                    $invalidated += [string]$fact.factId
                    $changed = $true
                    break
                }
            }
        }
    }
    # A failing test contradicts a stored assumption: the hypothesis chain is
    # no longer valid until re-established (record-failure clears it too).
    if ($changed) { $workingSet.evidenceVersion = ([int64]$workingSet.evidenceVersion + 1).ToString() }
    Save-AihWorkingSet -WorkingSet $workingSet -Path $path
    return $invalidated
}

function Set-AihWorkingSetExecutionState {
    # Step routing writes the current execution state here (mirrors the
    # routing state) so the Working Set remains the compact current-state view.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [string]$CurrentRole,[string]$PreviousRole,[string]$LastEscalationReason,[string]$LastEscalationSignature,[string]$LastDeepArtifact
    )
    $path = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $workingSet) { $workingSet = New-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    if (-not [string]::IsNullOrEmpty($CurrentRole)) { $workingSet.execution.currentRole = $CurrentRole }
    if (-not [string]::IsNullOrEmpty($PreviousRole)) { $workingSet.execution.previousRole = $PreviousRole }
    if (-not [string]::IsNullOrEmpty($LastEscalationReason)) { $workingSet.execution.lastEscalationReason = $LastEscalationReason }
    if (-not [string]::IsNullOrEmpty($LastEscalationSignature)) { $workingSet.execution.lastEscalationSignature = $LastEscalationSignature }
    if (-not [string]::IsNullOrEmpty($LastDeepArtifact)) { $workingSet.execution.lastDeepArtifact = $LastDeepArtifact }
    Save-AihWorkingSet -WorkingSet $workingSet -Path $path
    return $workingSet
}

function Set-AihWorkingSetHypothesis {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,[string]$Hypothesis,[string]$NextAction = '',[string]$NextVerification = '')
    $path = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $workingSet) { $workingSet = New-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    $workingSet.currentHypothesis = if ([string]::IsNullOrEmpty($Hypothesis)) { $null } else { (ConvertTo-AihEngineeringSafeText $Hypothesis 1000) }
    $workingSet.hypothesisKey = if ([string]::IsNullOrEmpty($Hypothesis)) { $null } else { (Get-AihEngineeringHypothesisKey $Hypothesis) }
    if (-not [string]::IsNullOrEmpty($NextAction)) { $workingSet.nextAction = $NextAction }
    if (-not [string]::IsNullOrEmpty($NextVerification)) { $workingSet.nextVerification = $NextVerification }
    Save-AihWorkingSet -WorkingSet $workingSet -Path $path
    return $workingSet
}

function Set-AihWorkingSetFailure {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,[string]$Signature,[string]$Classification,[string]$EvidenceText)
    $path = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $workingSet) { $workingSet = New-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    $workingSet.currentFailure = [ordered]@{ signature = $Signature; classification = $Classification; at = Get-AihEngineeringUtcNow; evidence = (ConvertTo-AihEngineeringSafeText $EvidenceText 500) }
    $workingSet.failureHistory = @($workingSet.failureHistory) + @($workingSet.currentFailure)
    # A failure contradicts the current hypothesis chain until a new
    # hypothesis is recorded (tests can invalidate assumptions).
    $workingSet.currentHypothesis = $null
    $workingSet.hypothesisKey = $null
    Save-AihWorkingSet -WorkingSet $workingSet -Path $path
    return $workingSet
}

function Set-AihWorkingSetChangedFiles {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,[string[]]$Paths,[string]$DiffSummary = '')
    $path = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $workingSet) { $workingSet = New-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    $known = @{}
    foreach ($knownEntry in @($workingSet.changedFiles)) { $known[[string]$knownEntry.path] = $knownEntry }
    foreach ($changedPath in @($Paths)) {
        $normalized = ($changedPath.Replace([string][char]92, '/'))
        $known[$normalized] = [ordered]@{ path = $normalized; recordedAtUtc = Get-AihEngineeringUtcNow; contentHash = (Get-AihEngineeringFileHash (Join-Path ([IO.Path]::GetFullPath($Workspace)) $changedPath)) }
    }
    $workingSet.changedFiles = @($known.Values)
    if (-not [string]::IsNullOrEmpty($DiffSummary)) { $workingSet.currentDiffSummary = (ConvertTo-AihEngineeringSafeText $DiffSummary 1000) }
    Save-AihWorkingSet -WorkingSet $workingSet -Path $path
    return $workingSet
}

function Get-AihWorkingSetSize {
    # Size telemetry: bytes + deterministic token estimate.
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $path = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if (-not (Test-Path -LiteralPath $path)) { return [ordered]@{ bytes = 0; estimatedTokens = 0; exists = $false } }
    $text = Get-Content -Raw -Encoding UTF8 -LiteralPath $path
    return [ordered]@{ bytes = [Text.Encoding]::UTF8.GetByteCount($text); estimatedTokens = (Get-AihEngineeringEstimatedTokens $text); exists = $true }
}

function Get-AihWorkingSetSnapshot {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $size = Get-AihWorkingSetSize -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $workingSet) { return [ordered]@{ exists = $false; size = $size; workingSet = $null } }
    return [ordered]@{ exists = $true; size = $size; workingSet = $workingSet }
}
