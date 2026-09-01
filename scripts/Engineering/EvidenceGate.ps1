Set-StrictMode -Version Latest

# Engineering.EvidenceGate - Phase 3.2.5 evidence-before-architecture gate.
#
# A significant architecture decision requires RELEVANT repository/task
# evidence BEFORE it is made. Dimensions are declared per decision (never a
# mechanical checklist of every dimension for every decision):
#
#   existingImplementation, interfaces, tests, persistence, constraints,
#   integrationPoints, alternatives, security, runtimeBehavior
#
# The gate is satisfied deterministically from the task-local Working Set
# evidence (facts tagged with the requested dimension, from deterministic
# repository tools - NOT from an extra LLM call proving evidence exists).
# When evidence is missing the gate blocks with concrete requiredActions
# pointing at deterministic repository operations.
#
# A Deep / Flash MAX call frequently terminates by producing exactly the
# decision artifact this module stores; after the artifact exists, routine
# implementation de-escalates to Engineer Normal.

$EngineeringEvidenceDimensions = @(
    'existingImplementation','interfaces','tests','persistence','constraints',
    'integrationPoints','alternatives','security','runtimeBehavior'
)

function Get-AihDecisionsDirectory {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId)
    $run = Get-AihEngineeringRunPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $directory = Join-Path $run 'decisions'
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    return $directory
}

function Test-AihEvidenceGate {
    # Deterministic gate check. Satisfied only when EVERY declared dimension
    # has at least one non-invalidated Working Set fact carrying it.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [Parameter(Mandatory=$true)][string[]]$Dimensions
    )
    foreach ($dimension in $Dimensions) {
        if (-not ($EngineeringEvidenceDimensions -contains $dimension)) { throw "Unknown evidence dimension: $dimension" }
    }
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $missing = @()
    $satisfied = @()
    $requiredActions = @()
    if ($null -eq $workingSet) {
        return [ordered]@{ satisfied = $false; missing = @($Dimensions); satisfiedDimensions = @(); requiredActions = @('initialize-working-set','retrieve-context','record-facts') }
    }
    foreach ($dimension in $Dimensions) {
        $found = $false
        foreach ($bucketName in @('files','symbols','architectureFacts','testFacts','runtimeFacts')) {
            foreach ($fact in @($workingSet.evidence.$bucketName)) {
                # Only tagged FACTS carry dimensions; retrieval file entries
                # have no 'invalidated'/'dimensions' properties at all.
                if ($null -eq $fact.PSObject.Properties['dimensions']) { continue }
                if ($null -ne $fact.PSObject.Properties['invalidated'] -and [bool]$fact.invalidated) { continue }
                if (@($fact.dimensions) -contains $dimension) { $found = $true; break }
            }
            if ($found) { break }
        }
        if ($found) { $satisfied += $dimension } else { $missing += $dimension }
    }
    foreach ($dimension in $missing) {
        switch ($dimension) {
            'existingImplementation' { $requiredActions += 'retrieve/inspect the current implementation (Context.ps1 search_code / file inspection), then record an architectureFacts fact.' }
            'interfaces'             { $requiredActions += 'resolve the relevant interfaces/symbols (Context.ps1 find_symbol) and record a symbols fact.' }
            'tests'                  { $requiredActions += 'locate the relevant tests and record a testFacts fact (or record not-applicable evidence explicitly).' }
            'persistence'            { $requiredActions += 'establish the persistence semantics involved and record a runtimeFacts/architectureFacts fact.' }
            'constraints'            { $requiredActions += 'record the applicable constraints as working-set constraints.' }
            'integrationPoints'      { $requiredActions += 'record the integration points involved as architectureFacts facts.' }
            'alternatives'           { $requiredActions += 'enumerate at least one meaningful alternative approach in the decision request.' }
            'security'               { $requiredActions += 'record the security-relevant facts/constraints for this decision.' }
            'runtimeBehavior'        { $requiredActions += 'record observed runtime behavior facts (logs/runs) for this decision.' }
        }
    }
    return [ordered]@{
        satisfied = ($missing.Count -eq 0)
        missing = @($missing)
        satisfiedDimensions = @($satisfied)
        requiredActions = @($requiredActions)
    }
}

function New-AihDecisionArtifact {
    # Records the structured decision artifact (the typical Deep output) and
    # resolves the open escalation. alternatives are mandatory when more than
    # one meaningful approach existed.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [Parameter(Mandatory=$true)][string]$Question,
        [string[]]$Dimensions = @(),
        [Parameter(Mandatory=$true)][string]$SelectedApproach,
        [Parameter(Mandatory=$true)][string]$Reason,
        [string[]]$Alternatives = @(),[string[]]$RejectedAlternatives = @(),
        [string]$Risk = '',[string]$Confidence = '',[string]$Source = 'deep-artifact'
    )
    $gate = Test-AihEvidenceGate -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Dimensions $Dimensions
    if (-not [bool]$gate.satisfied) {
        return [ordered]@{ recorded = $false; gate = $gate; decision = $null }
    }
    if ($Dimensions -contains 'alternatives' -and @($Alternatives).Count -eq 0) {
        return [ordered]@{ recorded = $false; gate = $gate; decision = $null; error = 'alternatives dimension declared: at least one meaningful alternative is required.' }
    }
    $directory = Get-AihDecisionsDirectory -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $existing = @(Get-ChildItem -LiteralPath $directory -Filter 'DEC-*.json' -ErrorAction SilentlyContinue)
    $number = $existing.Count + 1
    $decisionId = 'DEC-{0:D3}' -f $number
    $artifact = [ordered]@{
        schemaVersion = 1
        decisionId = $decisionId
        taskId = $TaskId
        taskInstanceId = if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) { $null } else { $TaskInstanceId }
        question = (ConvertTo-AihEngineeringSafeText $Question 1000)
        dimensions = @($Dimensions)
        evidence = [ordered]@{
            gate = $gate
            workingSetEvidenceVersion = $null
        }
        alternatives = @($Alternatives)
        selectedApproach = (ConvertTo-AihEngineeringSafeText $SelectedApproach 1000)
        reason = (ConvertTo-AihEngineeringSafeText $Reason 1000)
        rejectedAlternatives = @($RejectedAlternatives)
        risk = $Risk
        confidence = $Confidence
        source = $Source
        createdAtUtc = Get-AihEngineeringUtcNow
    }
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -ne $workingSet) { $artifact.evidence.workingSetEvidenceVersion = [string]$workingSet.evidenceVersion }
    Write-AihAtomicJson -Path (Join-Path $directory ($decisionId + '.json')) -Value $artifact

    # The decision supersedes the hypothesis it answered; the Working Set
    # carries the reusable decision reference.
    $path = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $ws = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -ne $ws) {
        $ws.decisions = @($ws.decisions) + @([ordered]@{ decisionId = $decisionId; question = $artifact.question; selectedApproach = $artifact.selectedApproach; at = $artifact.createdAtUtc })
        $ws.currentHypothesis = $null
        $ws.hypothesisKey = $null
        Save-AihWorkingSet -WorkingSet $ws -Path $path
    }
    $open = Get-AihOpenEscalation -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -ne $open) {
        Complete-AihDeepEscalation -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -ArtifactRef ("decisions/" + $decisionId + ".json") -Summary $artifact.selectedApproach | Out-Null
    }
    return [ordered]@{ recorded = $true; gate = $gate; decision = $artifact }
}

function Get-AihDecisionArtifact {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[string]$DecisionId)
    $directory = Get-AihDecisionsDirectory -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $path = Join-Path $directory ($DecisionId + '.json')
    $artifact = Read-AihEngineeringJson -Path $path -Default $null
    if ($null -eq $artifact) { return $null }
    if (-not (Test-AihEngineeringArtifactIdentity -Artifact $artifact -TaskInstanceId $TaskInstanceId)) { return $null }
    return $artifact
}

function Get-AihDecisionSnapshot {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $directory = Get-AihDecisionsDirectory -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $decisions = @()
    foreach ($file in @(Get-ChildItem -LiteralPath $directory -Filter 'DEC-*.json' -ErrorAction SilentlyContinue)) {
        $artifact = Read-AihEngineeringJson -Path $file.FullName -Default $null
        if ($null -ne $artifact -and (Test-AihEngineeringArtifactIdentity -Artifact $artifact -TaskInstanceId $TaskInstanceId)) { $decisions += $artifact }
    }
    return [ordered]@{ count = $decisions.Count; decisions = @($decisions) }
}
