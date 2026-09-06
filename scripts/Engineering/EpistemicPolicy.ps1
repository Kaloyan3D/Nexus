Set-StrictMode -Version Latest

# Engineering.EpistemicPolicy - task-local Epistemic Action Policy v0.
#
# This deterministic layer chooses WHAT kind of action should reduce the
# current uncertainty. StepRouting remains the sole authority for WHICH
# engineering role performs model work. The policy does not inspect reasoning
# text and does not call a model.

$AihEpistemicActions = @('reuse','retrieve','probe','reason','execute','verify')
$AihUncertaintyKinds = @('empirical','repository','judgment','verification','mixed')
$AihProbeRisks = @('safe','mutating','external','dangerous')
$AihProbeCosts = @('trivial','low','medium','high')
$AihInformationLevels = @('low','medium','high')

function Get-AihEpistemicStatePath {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    return (Join-Path (Get-AihEngineeringRunPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) 'epistemic-state.json')
}

function Get-AihEpistemicActionsPath {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    return (Join-Path (Get-AihEngineeringRunPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) 'epistemic-actions.jsonl')
}

function New-AihEpistemicStateBase {
    param([string]$TaskId,[string]$TaskInstanceId)
    return [ordered]@{
        schemaVersion = 1
        kind = 'engineering-epistemic-state'
        taskId = $TaskId
        taskInstanceId = if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) { $null } else { $TaskInstanceId }
        nextUncertaintySequence = 1
        uncertainties = @()
        hypotheses = @()
        updatedAtUtc = Get-AihEngineeringUtcNow
    }
}

function Get-AihEpistemicState {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $path = Get-AihEpistemicStatePath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $state = Read-AihEngineeringJson -Path $path -Default $null
    if ($null -eq $state) { return $null }
    if (-not (Test-AihEngineeringArtifactIdentity -Artifact $state -TaskInstanceId $TaskInstanceId)) { return $null }
    return $state
}

function Save-AihEpistemicState {
    param([object]$State,[string]$Path)
    Set-AihEngineeringProperty -Object $State -Name 'updatedAtUtc' -Value (Get-AihEngineeringUtcNow)
    Write-AihAtomicJson -Path $Path -Value $State
}

function Initialize-AihEpistemicState {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $state = Get-AihEpistemicState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -ne $state) { return $state }
    $path = Get-AihEpistemicStatePath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    Write-AihAtomicJson -Path $path -Value (New-AihEpistemicStateBase -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    return (Get-AihEpistemicState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
}

function Get-AihEpistemicUncertainty {
    param([object]$State,[string]$UncertaintyId)
    foreach ($item in @($State.uncertainties)) { if ([string]$item.id -eq $UncertaintyId) { return $item } }
    return $null
}

function Set-AihUncertaintyStatus {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[string]$UncertaintyId,[ValidateSet('open','resolving','resolved','blocked','superseded')][string]$Status,[string]$Reason='')
    $state=Get-AihEpistemicState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if($null -eq $state){throw 'Epistemic state is not initialized.'}
    $uncertainty=Get-AihEpistemicUncertainty -State $state -UncertaintyId $UncertaintyId
    if($null -eq $uncertainty){throw "Unknown uncertainty: $UncertaintyId"}
    $uncertainty.status=$Status;$uncertainty.updatedAtUtc=Get-AihEngineeringUtcNow
    if(-not[string]::IsNullOrWhiteSpace($Reason)){Set-AihEngineeringProperty -Object $uncertainty -Name 'statusReason' -Value (ConvertTo-AihEngineeringSafeText $Reason 500)}
    Save-AihEpistemicState -State $state -Path (Get-AihEpistemicStatePath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    $record=[ordered]@{recordVersion=1;event='uncertainty-status';timestampUtc=Get-AihEngineeringUtcNow;taskId=$TaskId;taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId};uncertaintyId=$UncertaintyId;status=$Status;reason=ConvertTo-AihEngineeringSafeText $Reason 500}
    Add-AihJsonLine -Path (Get-AihEpistemicActionsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) -Value $record
    Set-AihWorkingSetEpistemicState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Uncertainty $uncertainty -Action $null|Out-Null
    return $uncertainty
}

function Supersede-AihOpenUncertainties {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[string]$Reason='user instruction changed')
    $state=Get-AihEpistemicState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if($null -eq $state){return @()};$changed=@()
    foreach($uncertainty in @($state.uncertainties)){if([string]$uncertainty.status -in @('open','resolving','blocked')){$uncertainty.status='superseded';$uncertainty.updatedAtUtc=Get-AihEngineeringUtcNow;Set-AihEngineeringProperty -Object $uncertainty -Name 'statusReason' -Value (ConvertTo-AihEngineeringSafeText $Reason 500);$changed+=@([string]$uncertainty.id)}}
    if($changed.Count -gt 0){Save-AihEpistemicState -State $state -Path (Get-AihEpistemicStatePath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)}
    return $changed
}

function Set-AihWorkingSetEpistemicState {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[object]$Uncertainty,[object]$Action)
    $workingSetPath = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $workingSet) { $workingSet = New-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    if ($null -eq $workingSet.PSObject.Properties['epistemic']) {
        Set-AihEngineeringProperty -Object $workingSet -Name 'epistemic' -Value ([ordered]@{
            stateRef = 'epistemic-state.json'; actionsRef = 'epistemic-actions.jsonl'
            currentUncertaintyId = $null; currentActionId = $null; currentAction = $null
            uncertaintyStatus = $null; evidenceConflict = $false; lastSelectionReason = $null
        })
    }
    if ($null -ne $Uncertainty) {
        $workingSet.epistemic.currentUncertaintyId = [string]$Uncertainty.id
        $workingSet.epistemic.uncertaintyStatus = [string]$Uncertainty.status
        $workingSet.epistemic.evidenceConflict = [bool]$Uncertainty.evidenceConflict
    }
    if ($null -ne $Action) {
        $workingSet.epistemic.currentActionId = [string]$Action.actionId
        $workingSet.epistemic.currentAction = [string]$Action.selectedAction
        $workingSet.epistemic.lastSelectionReason = [string]$Action.selectionReason
        $workingSet.nextAction = [string]$Action.selectedAction
    }
    Save-AihWorkingSet -WorkingSet $workingSet -Path $workingSetPath
    return $workingSet
}

function New-AihUncertainty {
    param(
        [string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[Parameter(Mandatory=$true)][string]$Question,
        [ValidateSet('empirical','repository','judgment','verification','mixed')][string]$Kind='mixed',
        [string]$Subject='',[ValidateSet('low','medium','high')][string]$DecisionImpact='medium',
        [string[]]$CandidateActions=@(),[bool]$ProbeAvailable=$false,
        [ValidateSet('trivial','low','medium','high')][string]$ProbeCost='low',
        [ValidateSet('safe','mutating','external','dangerous')][string]$ProbeRisk='safe',
        [ValidateSet('low','medium','high')][string]$ExpectedInformationGain='medium',
        [ValidateSet('low','medium','high')][string]$DecisionRelevance='medium',
        [bool]$RepositoryAvailable=$true,[string]$ParentEscalationSignature=''
    )
    $state = Initialize-AihEpistemicState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $questionKey = Get-AihEngineeringNormalizedKey $Question
    foreach ($existing in @($state.uncertainties)) {
        if ([string]$existing.questionKey -eq $questionKey -and [string]$existing.status -ne 'superseded') { return $existing }
    }
    $candidates = if (@($CandidateActions).Count -eq 0) { @($AihEpistemicActions) } else { @($CandidateActions) }
    foreach ($candidate in $candidates) { if ($candidate -notin $AihEpistemicActions) { throw "Unknown epistemic action: $candidate" } }
    $sequence = [int]$state.nextUncertaintySequence
    $uncertainty = [ordered]@{
        id = ('UNC-{0:d3}' -f $sequence)
        taskId = $TaskId
        taskInstanceId = if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) { $null } else { $TaskInstanceId }
        question = ConvertTo-AihEngineeringSafeText $Question 1000
        questionKey = $questionKey
        subject = if ([string]::IsNullOrWhiteSpace($Subject)) { $questionKey } else { (Get-AihEngineeringNormalizedKey $Subject) }
        kind = $Kind
        status = 'open'
        decisionImpact = $DecisionImpact
        decisionRelevance = $DecisionRelevance
        knownEvidence = @()
        evidenceConflict = $false
        candidateActions = @($candidates)
        selectedAction = $null
        selectionReason = $null
        probe = [ordered]@{ available=[bool]$ProbeAvailable; cost=$ProbeCost; costTier=$(if($ProbeCost -eq 'trivial'){'P2'}elseif($ProbeCost -eq 'low'){'P2'}elseif($ProbeCost -eq 'medium'){'P3'}else{'P4'}); risk=$ProbeRisk; expectedInformationGain=$ExpectedInformationGain }
        repositoryAvailable = [bool]$RepositoryAvailable
        parentEscalationSignature = if ([string]::IsNullOrWhiteSpace($ParentEscalationSignature)) { $null } else { $ParentEscalationSignature }
        resolution = $null
        createdAtUtc = Get-AihEngineeringUtcNow
        updatedAtUtc = Get-AihEngineeringUtcNow
    }
    $state.uncertainties = @($state.uncertainties) + @($uncertainty)
    $state.nextUncertaintySequence = $sequence + 1
    Save-AihEpistemicState -State $state -Path (Get-AihEpistemicStatePath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    Set-AihWorkingSetEpistemicState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Uncertainty $uncertainty -Action $null | Out-Null
    return $uncertainty
}

function ConvertTo-AihEpistemicValueKey {
    param([AllowNull()][object]$Value)
    $json = ConvertTo-Json -InputObject (ConvertTo-AihEngineeringSerializable $Value) -Depth 20 -Compress
    return Get-AihEngineeringSha256 ([string]$json)
}

function Add-AihUncertaintyEvidence {
    param(
        [string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[string]$UncertaintyId,
        [string]$Subject,[AllowNull()][object]$Value,[string]$Source='observation',[string]$EvidenceHash='',
        [bool]$Authoritative=$true,[bool]$Current=$true,[bool]$ResolveConflict=$false,[string]$ProbeId=''
    )
    $state = Get-AihEpistemicState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $state) { throw 'Epistemic state is not initialized.' }
    $uncertainty = Get-AihEpistemicUncertainty -State $state -UncertaintyId $UncertaintyId
    if ($null -eq $uncertainty) { throw "Unknown uncertainty: $UncertaintyId" }
    $subjectKey = if ([string]::IsNullOrWhiteSpace($Subject)) { [string]$uncertainty.subject } else { (Get-AihEngineeringNormalizedKey $Subject) }
    $valueKey = ConvertTo-AihEpistemicValueKey $Value
    if ([string]::IsNullOrWhiteSpace($EvidenceHash)) { $EvidenceHash = $valueKey }
    $evidence = [ordered]@{
        evidenceId = 'E-' + [guid]::NewGuid().ToString('N').Substring(0,12)
        subject = $subjectKey
        value = $Value
        normalizedValueHash = $valueKey
        source = $Source
        evidenceHash = $EvidenceHash
        authoritative = [bool]$Authoritative
        current = [bool]$Current
        invalidated = $false
        probeId = if ([string]::IsNullOrWhiteSpace($ProbeId)) { $null } else { $ProbeId }
        observedAtUtc = Get-AihEngineeringUtcNow
        resolvesConflict = [bool]$ResolveConflict
    }
    $uncertainty.knownEvidence = @($uncertainty.knownEvidence) + @($evidence)
    $distinct = @(@($uncertainty.knownEvidence) | Where-Object { [bool]$_.authoritative -and [bool]$_.current -and -not [bool]$_.invalidated -and [string]$_.subject -eq $subjectKey } | ForEach-Object { [string]$_.normalizedValueHash } | Select-Object -Unique)
    $conflict = ($distinct.Count -gt 1)
    if ($ResolveConflict) {
        $uncertainty.status = 'resolved'
        $uncertainty.resolution = [ordered]@{ value=$Value; source=$Source; evidenceHash=$EvidenceHash; evidenceId=$evidence.evidenceId; probeId=$evidence.probeId; resolvedAtUtc=Get-AihEngineeringUtcNow }
        $conflict = $false
    }
    $uncertainty.evidenceConflict = [bool]$conflict
    $uncertainty.updatedAtUtc = Get-AihEngineeringUtcNow
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -ne $workingSet) { $workingSet.evidenceVersion = ([int64]$workingSet.evidenceVersion + 1).ToString(); Save-AihWorkingSet -WorkingSet $workingSet -Path (Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) }
    Save-AihEpistemicState -State $state -Path (Get-AihEpistemicStatePath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    Set-AihWorkingSetEpistemicState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Uncertainty $uncertainty -Action $null | Out-Null
    return $evidence
}

function Test-AihEpistemicFreshResolution {
    param([object]$Uncertainty,[string]$CurrentEvidenceHash='')
    if ($null -eq $Uncertainty.resolution) { return $false }
    if ([string]::IsNullOrWhiteSpace($CurrentEvidenceHash)) { return $true }
    return ([string]$Uncertainty.resolution.evidenceHash -eq $CurrentEvidenceHash)
}

function Select-AihEpistemicAction {
    param(
        [string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[string]$UncertaintyId,
        [string]$CurrentEvidenceHash='',[bool]$ImplementationReady=$false,[bool]$VerificationRequired=$false
    )
    $state = Get-AihEpistemicState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $state) { throw 'Epistemic state is not initialized.' }
    $uncertainty = Get-AihEpistemicUncertainty -State $state -UncertaintyId $UncertaintyId
    if ($null -eq $uncertainty) { throw "Unknown uncertainty: $UncertaintyId" }
    $selected = 'reason'; $reason = 'The missing information is not cheaply observable; model judgment is required.'; $costTier = 'P5'; $reasoningAvoided = $false
    $fresh = Test-AihEpistemicFreshResolution -Uncertainty $uncertainty -CurrentEvidenceHash $CurrentEvidenceHash
    $safeCheapProbe = [bool]$uncertainty.probe.available -and [string]$uncertainty.probe.risk -eq 'safe' -and [string]$uncertainty.probe.cost -in @('trivial','low') -and [string]$uncertainty.probe.expectedInformationGain -in @('medium','high') -and [string]$uncertainty.decisionRelevance -in @('medium','high')
    if ($VerificationRequired -or [string]$uncertainty.kind -eq 'verification') {
        $selected='verify'; $reason='Correctness evidence is now required; use Verification Strategy v0.'; $costTier='P3'; $reasoningAvoided=$true
    } elseif ($ImplementationReady) {
        $selected='execute'; $reason='The decision is sufficiently resolved and the known implementation step should execute.'; $costTier='P2'; $reasoningAvoided=$true
    } elseif ($fresh) {
        $selected='reuse'; $reason='Fresh authoritative task-local evidence already resolves the same question.'; $costTier='P0'; $reasoningAvoided=$true
    } elseif ([bool]$uncertainty.evidenceConflict -and $safeCheapProbe) {
        $selected='probe'; $reason='Current structured evidence conflicts; a safe low-cost deterministic probe can discriminate the values.'; $costTier=[string]$uncertainty.probe.costTier; $reasoningAvoided=$true
    } elseif ([string]$uncertainty.kind -eq 'repository' -and [bool]$uncertainty.repositoryAvailable) {
        $selected='retrieve'; $reason='Current repository/code intelligence can answer the question without architecture reasoning.'; $costTier='P1'; $reasoningAvoided=$true
    } elseif ([string]$uncertainty.kind -in @('empirical','mixed') -and $safeCheapProbe) {
        $selected='probe'; $reason='A safe low-cost deterministic probe has material expected information gain and decision relevance.'; $costTier=[string]$uncertainty.probe.costTier; $reasoningAvoided=$true
    } elseif ([string]$uncertainty.kind -eq 'empirical' -and [bool]$uncertainty.probe.available -and [string]$uncertainty.probe.risk -ne 'safe') {
        $selected='reason'; $reason='The available probe is ' + [string]$uncertainty.probe.risk + ' and is not eligible for automatic execution; safety authority remains outside the model.'; $costTier='P5'
    } elseif ([string]$uncertainty.kind -eq 'repository' -and -not [bool]$uncertainty.repositoryAvailable) {
        $selected='reason'; $reason='Repository retrieval is unavailable and no fresh evidence resolves the question.'; $costTier='P5'
    }
    if ($selected -notin @($uncertainty.candidateActions)) {
        throw "Policy-selected action '$selected' is not allowed by the uncertainty candidateActions contract."
    }
    $action = [ordered]@{
        recordVersion=1; event='action-selected'; actionId=('ACT-'+[guid]::NewGuid().ToString('N'))
        timestampUtc=Get-AihEngineeringUtcNow; taskId=$TaskId; taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId}
        uncertaintyId=$UncertaintyId; uncertaintyKind=[string]$uncertainty.kind; selectedAction=$selected; selectionReason=$reason
        costTier=$costTier; probeRisk=[string]$uncertainty.probe.risk; reasoningAvoided=[bool]$reasoningAvoided
        evidenceConflict=[bool]$uncertainty.evidenceConflict; evidenceStateHash=$CurrentEvidenceHash; status='selected'; selectedRole=$null
    }
    $uncertainty.selectedAction=$selected; $uncertainty.selectionReason=$reason; $uncertainty.status=$(if($selected -eq 'reuse'){'resolved'}else{'resolving'}); $uncertainty.updatedAtUtc=Get-AihEngineeringUtcNow
    Save-AihEpistemicState -State $state -Path (Get-AihEpistemicStatePath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    Add-AihJsonLine -Path (Get-AihEpistemicActionsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) -Value $action
    Set-AihWorkingSetEpistemicState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Uncertainty $uncertainty -Action $action | Out-Null
    return $action
}

function Set-AihEpistemicActionRole {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[object]$Action,[object]$StepDecision)
    $link = [ordered]@{
        recordVersion=1; event='action-routed'; actionId=[string]$Action.actionId; timestampUtc=Get-AihEngineeringUtcNow
        taskId=$TaskId; taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId}
        uncertaintyId=[string]$Action.uncertaintyId; selectedAction=[string]$Action.selectedAction
        selectedRole=[string]$StepDecision.selectedRole; previousRole=[string]$StepDecision.previousRole; stepId=[string]$StepDecision.stepId
        deescalated=[bool]$StepDecision.deescalated; escalationSignature=$StepDecision.escalationSignature
    }
    Add-AihJsonLine -Path (Get-AihEpistemicActionsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) -Value $link
    return $link
}

function Select-AihEpistemicStep {
    param(
        [string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[string]$UncertaintyId,[string]$MilestoneId='',
        [string]$CurrentEvidenceHash='',[bool]$ImplementationReady=$false,[bool]$VerificationRequired=$false,
        [string]$EscalationReason='none',[string]$Question='',[string]$Hypothesis='',[string[]]$EvidenceRefs=@(),[string]$StepKind='routine',[string]$Preset='aih-engineering'
    )
    $action = Select-AihEpistemicAction -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -UncertaintyId $UncertaintyId -CurrentEvidenceHash $CurrentEvidenceHash -ImplementationReady:$ImplementationReady -VerificationRequired:$VerificationRequired
    $routingReason = if ([string]$action.selectedAction -eq 'reason') { $EscalationReason } else { 'none' }
    $step = Select-AihStepRole -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -MilestoneId $MilestoneId -EscalationReason $routingReason -Question $Question -Hypothesis $Hypothesis -EvidenceRefs $EvidenceRefs -StepKind $StepKind -Preset $Preset -EpistemicAction ([string]$action.selectedAction)
    $link = Set-AihEpistemicActionRole -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Action $action -StepDecision $step
    return [ordered]@{ action=$action; step=$step; selectedAction=$action.selectedAction; selectedRole=$step.selectedRole; actionId=$action.actionId; uncertaintyId=$UncertaintyId; selectionReason=$action.selectionReason; roleTarget=$step.roleTarget }
}

function Complete-AihEpistemicAction {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[string]$ActionId,[ValidateSet('succeeded','failed','interrupted','blocked')][string]$Result,[string]$Summary='',[string]$FailureSignature='')
    $record=[ordered]@{recordVersion=1;event='action-completed';actionId=$ActionId;timestampUtc=Get-AihEngineeringUtcNow;taskId=$TaskId;taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId};result=$Result;summary=ConvertTo-AihEngineeringSafeText $Summary 500;failureSignature=if([string]::IsNullOrWhiteSpace($FailureSignature)){$null}else{$FailureSignature}}
    Add-AihJsonLine -Path (Get-AihEpistemicActionsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) -Value $record
    return $record
}

function Add-AihEpistemicHypothesis {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[string]$UncertaintyId,[string]$Text)
    $state=Get-AihEpistemicState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if($null -eq $state){throw 'Epistemic state is not initialized.'}
    $workingSet=Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $evidenceVersion=if($null -eq $workingSet){'0'}else{[string]$workingSet.evidenceVersion}
    $key=Get-AihEngineeringHypothesisKey $Text
    $signature=Get-AihEngineeringSha256 ($UncertaintyId+'|'+$key+'|'+$evidenceVersion)
    foreach($existing in @($state.hypotheses)){if([string]$existing.signature -eq $signature){return [ordered]@{hypothesis=$existing;duplicate=$true;progress=$false}}}
    $entry=[ordered]@{id=('HYP-'+[guid]::NewGuid().ToString('N').Substring(0,12));taskId=$TaskId;taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId};uncertaintyId=$UncertaintyId;text=ConvertTo-AihEngineeringSafeText $Text 1000;hypothesisKey=$key;evidenceVersion=$evidenceVersion;signature=$signature;evidenceFor=@();evidenceAgainst=@();status='active';createdAtUtc=Get-AihEngineeringUtcNow;supersededBy=$null}
    $state.hypotheses=@($state.hypotheses)+@($entry); Save-AihEpistemicState -State $state -Path (Get-AihEpistemicStatePath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    Set-AihWorkingSetHypothesis -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Hypothesis $Text -NextAction 'acquire-evidence' | Out-Null
    return [ordered]@{hypothesis=$entry;duplicate=$false;progress=$true}
}

function Invoke-AihEpistemicProbe {
    param(
        [string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[string]$ActionId,[string]$UncertaintyId,[string]$Purpose,
        [ValidateSet('run_command','run_powershell','run_test')][string]$Operation,[string]$Target,[string]$ExpectedObservation,
        [string]$Executable='',[string[]]$Argv=@(),[string]$Cwd='',[string]$Script='',[string]$ScriptPath='',[int]$TimeoutMs=120000,[string]$TestTarget=''
    )
    $records=@(Get-AihEpistemicActionRecords -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    $selected=@($records|Where-Object{$_.event -eq 'action-selected' -and $_.actionId -eq $ActionId}|Select-Object -Last 1)
    if($selected.Count -eq 0 -or [string]$selected[0].selectedAction -ne 'probe'){throw 'Probe execution requires a selected PROBE action.'}
    if([string]$selected[0].probeRisk -ne 'safe'){throw 'Only safe probes are eligible for automatic execution.'}
    $probeId='PRB-'+[guid]::NewGuid().ToString('N')
    $started=Get-AihEngineeringUtcNow
    Add-AihJsonLine -Path (Get-AihEpistemicActionsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) -Value ([ordered]@{recordVersion=1;event='probe-started';probeId=$probeId;actionId=$ActionId;taskId=$TaskId;taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId};uncertaintyId=$UncertaintyId;purpose=ConvertTo-AihEngineeringSafeText $Purpose 500;operation=$Operation;target=ConvertTo-AihEngineeringSafeText $Target 500;risk='safe';costTier=[string]$selected[0].costTier;expectedObservation=ConvertTo-AihEngineeringSafeText $ExpectedObservation 500;startedAtUtc=$started})
    $execution=Invoke-AihStructuredOperation -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Operation $Operation -Executable $Executable -Argv $Argv -Cwd $Cwd -Script $Script -ScriptPath $ScriptPath -TimeoutMs $TimeoutMs -TestTarget $TestTarget
    $success=($null -ne $execution.exitCode -and [int]$execution.exitCode -eq 0 -and -not [bool]$execution.timedOut)
    $observed=if($success){([string]$execution.stdout).Trim()}else{([string]$execution.stderr).Trim()}
    $hashInput=if([string]::IsNullOrEmpty($observed)){'<empty-observation>'}else{$observed}
    $evidenceHash=Get-AihEngineeringSha256 $hashInput
    if($success){Add-AihUncertaintyEvidence -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -UncertaintyId $UncertaintyId -Subject $Target -Value $observed -Source 'deterministic-probe' -EvidenceHash $evidenceHash -ResolveConflict:$true -ProbeId $probeId | Out-Null}
    $finished=Get-AihEngineeringUtcNow
    $probe=[ordered]@{recordVersion=1;event='probe-completed';probeId=$probeId;actionId=$ActionId;taskId=$TaskId;taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId};uncertaintyId=$UncertaintyId;purpose=ConvertTo-AihEngineeringSafeText $Purpose 500;operation=$Operation;target=ConvertTo-AihEngineeringSafeText $Target 500;risk='safe';costTier=[string]$selected[0].costTier;expectedObservation=ConvertTo-AihEngineeringSafeText $ExpectedObservation 500;startedAtUtc=$started;finishedAtUtc=$finished;result=if($success){'success'}else{'failure'};exitCode=$execution.exitCode;status=if($success){'passed'}else{'failed'};observedValue=$observed;summary=ConvertTo-AihEngineeringSafeText $observed 500;evidenceHash=$evidenceHash;resolvedQuestion=[bool]$success;failureSignature=$execution.failureSignature}
    Add-AihJsonLine -Path (Get-AihEpistemicActionsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) -Value $probe
    Complete-AihEpistemicAction -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -ActionId $ActionId -Result $(if($success){'succeeded'}else{'failed'}) -Summary $observed -FailureSignature ([string]$execution.failureSignature) | Out-Null
    return [ordered]@{probe=$probe;execution=$execution}
}

function Get-AihEpistemicActionRecords {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $path=Get-AihEpistemicActionsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $records=@(); if(-not(Test-Path -LiteralPath $path)){return $records}
    foreach($line in Get-Content -Encoding UTF8 -LiteralPath $path){if([string]::IsNullOrWhiteSpace($line)){continue};try{$record=$line|ConvertFrom-Json}catch{continue};if(Test-AihEngineeringArtifactIdentity -Artifact $record -TaskInstanceId $TaskInstanceId){$records+=$record}}
    return $records
}

function Get-AihEpistemicSnapshot {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $state=Get-AihEpistemicState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $records=@(Get-AihEpistemicActionRecords -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    $selected=@($records|Where-Object{$_.event -eq 'action-selected'}); $probes=@($records|Where-Object{$_.event -eq 'probe-completed'}); $routed=@($records|Where-Object{$_.event -eq 'action-routed'})
    $counts=[ordered]@{reuse=0;retrieve=0;probe=0;reason=0;execute=0;verify=0}; foreach($entry in $selected){$name=[string]$entry.selectedAction;$counts[$name]=[int]$counts[$name]+1}
    # Keep an actual empty array under Windows PowerShell 5.1. Assigning an
    # if-expression whose selected branch emits @() produces $null, and
    # StrictMode then throws when telemetry reads .Count on that value.
    $uncertainties=@()
    if($null -ne $state){$uncertainties=@($state.uncertainties)}
    return [ordered]@{schemaVersion=1;taskId=$TaskId;taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId};actionCounts=$counts;actionsSelected=$selected.Count;reasoningAvoided=@($selected|Where-Object{[bool]$_.reasoningAvoided}).Count;uncertainties=[ordered]@{created=$uncertainties.Count;resolved=@($uncertainties|Where-Object{$_.status -eq 'resolved'}).Count;superseded=@($uncertainties|Where-Object{$_.status -eq 'superseded'}).Count;blocked=@($uncertainties|Where-Object{$_.status -eq 'blocked'}).Count;evidenceConflicts=@($uncertainties|Where-Object{[bool]$_.evidenceConflict}).Count};probes=[ordered]@{count=$probes.Count;success=@($probes|Where-Object{$_.result -eq 'success'}).Count;failure=@($probes|Where-Object{$_.result -eq 'failure'}).Count;resolved=@($probes|Where-Object{[bool]$_.resolvedQuestion}).Count;costTiers=@($probes|ForEach-Object{$_.costTier})};routing=[ordered]@{normalActions=@($routed|Where-Object{$_.selectedRole -eq 'engineer_normal'}).Count;deepActions=@($routed|Where-Object{$_.selectedRole -eq 'engineer_deep'}).Count;deepProbeNormal=@($routed|Where-Object{$_.selectedAction -eq 'probe' -and $_.previousRole -eq 'engineer_deep' -and $_.selectedRole -eq 'engineer_normal'}).Count};records=$records;state=$state}
}
