Set-StrictMode -Version Latest

# Engineering.StepRouting - Phase 3.2.5 P0 step/milestone-level role routing.
#
# The task-level Normal/Deep classification remains for initial planning, UI
# presentation and routing metadata, but it NEVER permanently pins every
# model invocation. Every engineering step selects its role deterministically:
#
#   engineer_normal  is the DEFAULT (repository inspection, straightforward
#                    implementation, local edits, tests from explicit criteria,
#                    git inspection, deterministic verification, applying a
#                    plan already established by Deep, reruns after a known
#                    corrective action, obvious follow-up corrections).
#   engineer_deep    is TEMPORARY and requires a deterministic escalation
#                    reason backed by task-local structured state, and it must
#                    produce a reusable artifact before routine work returns
#                    to engineer_normal.
#
# NO task stickiness: the selected role describes the CURRENT reasoning
# requirement, not the historic difficulty of the task. Task length, prompt
# length, many requirements, many files, a previous Deep call, or a "hard
# sounding" task name are NEVER escalation signals.
#
# NO escalation oscillation: an open Deep escalation is keyed by a stable
# escalation signature (task + milestone + normalized question + hypothesis +
# evidence state). The same signature cannot escalate twice; only materially
# new evidence, a changed hypothesis/requirement, a changed risk boundary, a
# changed failure classification or a materially different decision question
# produce a new signature. Recording the Deep artifact closes (resolves) the
# escalation and the next step de-escalates to engineer_normal.
#
# The REVIEWER is outside this mechanism entirely.

function Get-AihStepRoutingPath {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId)
    $run = Get-AihEngineeringRunPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    return (Join-Path $run 'step-routing.jsonl')
}

function Get-AihStepRoutingRecords {
    # Only records carrying the expected lifecycle instance join (identity).
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $path = Get-AihStepRoutingPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $records = @()
    if (-not (Test-Path -LiteralPath $path)) { return $records }
    foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $path) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $record = $line | ConvertFrom-Json } catch { continue }
        if ($null -eq $record) { continue }
        if (-not (Test-AihEngineeringArtifactIdentity -Artifact $record -TaskInstanceId $TaskInstanceId)) { continue }
        $records += $record
    }
    return $records
}

function Get-AihOpenEscalation {
    # The newest Deep escalation that is not yet resolved by a Deep artifact.
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $records = @(Get-AihStepRoutingRecords -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    for ($i = $records.Count - 1; $i -ge 0; $i--) {
        $record = $records[$i]
        if ([string]$record.selectedRole -eq 'engineer_deep' -and -not [bool]$record.escalationResolved) {
            return $record
        }
    }
    return $null
}

function Resolve-AihStepRoleTarget {
    # Role -> provider/model/reasoning through the ACTIVE engineering profile
    # and the model registry. Controller semantics never branch on model
    # identity; this is the same configuration layer Routing.ps1 uses.
    param([string]$Workspace,[string]$Preset = 'aih-engineering',[string]$TaskInstanceId)
    . (Join-Path $PSScriptRoot ('..' + [IO.Path]::DirectorySeparatorChar + 'Routing.ps1'))
    $installRoot = Get-AihInstallRoot $null
    $layout = Get-AihLayout $installRoot
    $policy = Get-AihRoutingPolicy $layout.RoutingPolicy
    $profiles = Get-AihEngineeringProfiles $layout.EngineeringProfiles $layout.CustomEngineeringProfile
    $registry = Get-AihModelRegistry $layout.ModelRegistry
    $resolved = Resolve-AihPreset $policy $Preset
    $resolvedProfile = Resolve-AihProfile $policy $resolved $profiles $layout.Settings
    $targets = [ordered]@{}
    foreach ($class in @('engineer_normal','engineer_deep','reviewer')) {
        $role = Get-AihRoleForExecutionClass $policy $class
        if ([string]::IsNullOrWhiteSpace($role)) { continue }
        $target = Resolve-AihModelTarget $registry $resolvedProfile $role
        $targets[$class] = [ordered]@{
            role = $role
            profileId = $resolvedProfile.Id
            profileDisplayName = $resolvedProfile.DisplayName
            provider = $target.Provider
            model = $target.Model
            modelDisplayName = $target.ModelDisplayName
            vendor = $target.Vendor
            reasoning = $target.Reasoning
        }
    }
    # The durable routing state path for THIS lifecycle generation (the same
    # key Routing.ps1 uses); the step role is mirrored into it so the
    # enforcement layer resolves the CURRENT step's role.
    $workspacePath = [IO.Path]::GetFullPath($Workspace)
    $statePath = Get-AihRoutingStatePath -DataRoot $layout.RoutingData -Workspace $workspacePath -TaskId '' -Preset $resolved.Id -TaskInstanceId $TaskInstanceId
    return [ordered]@{ targets = $targets; presetId = $resolved.Id; routingDataRoot = $layout.RoutingData; statePath = $statePath }
}

function Get-AihStepPinField {
    # R6.3.2: production step targets are [ordered] hashtables, whose entries
    # are NOT exposed via .PSObject.Properties (that seam only fits the
    # JSON-deserialized pin side). Read dictionaries by indexer so a live
    # target is never misread as empty (which would refuse every pinned step).
    param($Object,[string]$Field)
    if($null-eq$Object-or[string]::IsNullOrWhiteSpace($Field)){return $null}
    if($Object -is [System.Collections.IDictionary]){
        if($Object.Contains($Field)){ $value=$Object[$Field]; if($null-ne$value){return [string]$value} }
        return $null
    }
    $property=$Object.PSObject.Properties[$Field]
    if($null-ne$property-and$null-ne$property.Value){return [string]$property.Value}
    return $null
}
function Assert-AihStepRoleTargetPinned {
    # R6.3.1: pinned-generation step enforcement. When session-bindings.json
    # carries a registry pin for THIS taskInstanceId, the selected step target
    # must equal the pinned map entry for the step role; otherwise fail closed
    # BEFORE any step record is written. No pin (or no bindings file) keeps
    # the exact legacy behavior. R6.3 singular pins (roleTarget) are honored
    # for their one role. Windows PowerShell 5.1 compatible (no ternary).
    param([string]$RoutingDataRoot,[string]$TaskInstanceId,[string]$Role,$Target)
    if([string]::IsNullOrWhiteSpace($TaskInstanceId)){return}
    if([string]::IsNullOrWhiteSpace($Role)-or$null-eq$Target){return}
    $bindingsPath=Join-Path $RoutingDataRoot 'session-bindings.json'
    if(-not(Test-Path -LiteralPath $bindingsPath)){return}
    try{$doc=Get-Content -Raw -Encoding UTF8 -LiteralPath $bindingsPath|ConvertFrom-Json}catch{return}
    if($null-eq$doc-or$null-eq$doc.PSObject.Properties['bindings']){return}
    $pin=$null
    foreach($b in @($doc.bindings.PSObject.Properties.Value)){
        if($null-ne$b-and$null-ne$b.PSObject.Properties['taskInstanceId']-and[string]$b.taskInstanceId-eq$TaskInstanceId-and$null-ne$b.PSObject.Properties['registryPin']){$pin=$b.registryPin;break}
    }
    if($null-eq$pin){return}
    $entry=$null
    if($null-ne$pin.PSObject.Properties['roleTargets']-and$null-ne$pin.roleTargets.PSObject.Properties[$Role]){$entry=$pin.roleTargets.$Role}
    elseif($null-ne$pin.PSObject.Properties['roleTarget']-and$null-ne$pin.PSObject.Properties['role']-and[string]$pin.role-eq$Role){$entry=[pscustomobject]@{available=$true;target=$pin.roleTarget}}
    if($null-eq$entry){throw "registry-role-unpinned: no pinned target for step role '$Role' (taskInstanceId '$TaskInstanceId')."}
    if($null-ne$entry.PSObject.Properties['available']-and-not[bool]$entry.available){throw "registry-role-unavailable: pinned step target for '$Role' is unavailable."}
    if($null-eq$entry.PSObject.Properties['target']-or$null-eq$entry.target){throw "registry-role-unpinned: pinned step target for '$Role' has no target."}
    $expected=$entry.target
    foreach($field in @('provider','model','reasoning')){
        $a=Get-AihStepPinField $Target $field;$e=Get-AihStepPinField $expected $field
        if([string]::IsNullOrWhiteSpace($a)){$a=$null}
        if([string]::IsNullOrWhiteSpace($e)){$e=$null}
        if($a-ne$e){throw "registry-step-target-mismatch: step $field drifted (pinned '$e', current '$a') for role '$Role'."}
    }
}

function Set-AihRoutingStateStepRole {
    # Mirror the selected STEP role into the durable routing state (field
    # 'stepRole'). The task-level executionClass stays untouched (it remains
    # the initial classification for planning/UI metadata); the stepRole
    # describes the CURRENT reasoning requirement only. When no routing state
    # exists yet for this generation, nothing is written (the enforcement
    # layer falls back to engineer_normal, which is the default anyway).
    # Reviewer/solver are NEVER written here: this mechanism selects
    # engineering roles only.
    param([string]$StatePath,[string]$StepRole)
    if ([string]::IsNullOrEmpty($StatePath) -or -not (Test-Path -LiteralPath $StatePath)) { return $false }
    if ($StepRole -notin @('engineer_normal','engineer_deep')) { return $false }
    $dataRoot = Split-Path -Parent (Split-Path -Parent $StatePath)
    $mutex = [Threading.Mutex]::new($false, (Get-AihRoutingMutexName $dataRoot))
    $taken = $false
    try {
        try { $taken = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $taken = $true }
        if (-not $taken) { return $false }
        $state = Get-Content -Raw -Encoding UTF8 -LiteralPath $StatePath | ConvertFrom-Json
        $state | Add-Member -NotePropertyName stepRole -NotePropertyValue $StepRole -Force
        $state | Add-Member -NotePropertyName stepRoleUpdatedAtUtc -NotePropertyValue (Get-AihEngineeringUtcNow) -Force
        Write-AihAtomicJson -Path $StatePath -Value $state
        return $true
    } finally {
        if ($taken) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Select-AihStepRole {
    # THE deterministic step router.
    #
    # Inputs are task-local structured state ONLY:
    #   - the open-escalation ledger (anti-oscillation, de-escalation),
    #   - the requested escalation (reason enum + question + evidence refs),
    #   - the current hypothesis key (a materially NEW hypothesis may escalate),
    #   - the failure ledger (two-strike complex-failure recommendations).
    #
    # Routine work, milestone progression, and "just continue" always select
    # engineer_normal. An unresolved Deep condition keeps engineer_deep until
    # its artifact is recorded (escalationResolved), then de-escalates.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [string]$MilestoneId = '',[ValidateSet('none','architecture-decision','conflicting-evidence','repeated-failure-new-hypothesis','security-sensitive','high-risk-refactor','migration-design','cross-system-contract','ambiguous-requirements','complex-debugging','provider-runtime-boundary','unknown-high-impact-behavior','incompatible-invariants','uncertain-persistence-semantics')][string]$EscalationReason = 'none',
        [string]$Question = '',[string]$Hypothesis = '',[string[]]$EvidenceRefs = @(),[string]$StepKind = 'routine',[string]$Preset = 'aih-engineering',
        [ValidateSet('reuse','retrieve','probe','reason','execute','verify')][string]$EpistemicAction = 'reason'
    )
    $path = Get-AihStepRoutingPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $records = @(Get-AihStepRoutingRecords -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    $last = $null
    if ($records.Count -gt 0) { $last = $records[$records.Count - 1] }
    $previousRole = if ($null -ne $last) { [string]$last.selectedRole } else { 'engineer_normal' }

    $open = Get-AihOpenEscalation -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $evidenceVersion = if ($null -ne $workingSet) { [string]$workingSet.evidenceVersion } else { '0' }
    $recordedHypothesisKey = if ($null -ne $workingSet -and $null -ne $workingSet.PSObject.Properties['hypothesisKey']) { [string]$workingSet.hypothesisKey } else { '' }
    $requestedHypothesisKey = Get-AihEngineeringHypothesisKey $Hypothesis
    if ([string]::IsNullOrEmpty($requestedHypothesisKey)) { $requestedHypothesisKey = $recordedHypothesisKey }

    $selectedRole = 'engineer_normal'
    $selectionReason = 'Routine engineering work defaults to Engineer Normal.'
    $signals = @()
    $escalated = $false
    $deescalated = $false
    $escalationSignature = $null
    $blocked = $false
    $blockedReason = $null

    # Axis A (epistemic action) and Axis B (role strength) stay separate. A
    # retrieval/probe/execution/verification step is routine engineering work
    # and explicitly returns to Normal even when Deep identified the missing
    # fact. Deep is considered only for REASON steps.
    if ($EpistemicAction -ne 'reason') {
        $selectedRole = 'engineer_normal'
        $selectionReason = "Epistemic action '$EpistemicAction' is routine evidence acquisition/execution; Engineer Normal is selected."
        $signals += @('epistemic-action:' + $EpistemicAction)
    }
    elseif ($null -ne $open) {
        # An escalation is open: Deep stays active ONLY for the same unresolved
        # condition; the identical signature can never bounce roles.
        $escalationSignature = [string]$open.escalationSignature
        $sameQuestion = ([string]$open.questionKey -eq (Get-AihEngineeringNormalizedKey $Question))
        if ($EscalationReason -ne 'none' -and -not $sameQuestion -and -not [string]::IsNullOrEmpty($Question)) {
            # A materially different decision question creates a NEW signature;
            # it may escalate once as a new condition.
            $newSignature = Get-AihEngineeringEscalationSignature -TaskInstanceId ([string]$TaskInstanceId) -MilestoneId $MilestoneId -Question $Question -HypothesisKey $requestedHypothesisKey -EvidenceVersion $evidenceVersion
            if ($newSignature -ne $escalationSignature) {
                $escalationSignature = $newSignature
                $selectedRole = 'engineer_deep'
                $escalated = $true
                $selectionReason = "Materially different decision question under an active escalation: $EscalationReason."
                $signals += @('new-escalation-signature')
            } else {
                $selectedRole = 'engineer_normal'
                $blocked = $true
                $blockedReason = 'escalation-signature-active: the same unresolved escalation cannot open a second Deep step without materially new evidence.'
                $selectionReason = $blockedReason
            }
        } else {
            $selectedRole = 'engineer_deep'
            $selectionReason = 'Deep escalation is open and unresolved; the current step continues the escalated condition (signature ' + $escalationSignature.Substring(0,12) + ').'
            $signals += @('open-escalation')
        }
    }
    elseif ($EscalationReason -ne 'none') {
        if (-not ($EngineeringEscalationReasons -contains $EscalationReason)) {
            throw "Unknown escalation reason: $EscalationReason"
        }
        # Fresh escalation: requires task-local structured backing. A question
        # or an explicit hypothesis/evidence context must exist so the
        # escalation is resolvable and auditable (never a bare vibe).
        if ([string]::IsNullOrWhiteSpace($Question) -and @($EvidenceRefs).Count -eq 0) {
            $selectedRole = 'engineer_normal'
            $blocked = $true
            $blockedReason = 'escalation-requires-context: an escalation request needs a decision question or evidence refs.'
            $selectionReason = $blockedReason
        } else {
            $escalationSignature = Get-AihEngineeringEscalationSignature -TaskInstanceId ([string]$TaskInstanceId) -MilestoneId $MilestoneId -Question $Question -HypothesisKey $requestedHypothesisKey -EvidenceVersion $evidenceVersion
            # Anti-oscillation across RESOLVED escalations: the same signature
            # that already produced an artifact cannot escalate again.
            $resolvedSignatures = @{}
            foreach ($record in $records) {
                if ([string]$record.selectedRole -eq 'engineer_deep' -and [bool]$record.escalationResolved -and -not [string]::IsNullOrEmpty([string]$record.escalationSignature)) {
                    $resolvedSignatures[[string]$record.escalationSignature] = $true
                }
            }
            if ($resolvedSignatures.ContainsKey($escalationSignature)) {
                $selectedRole = 'engineer_normal'
                $blocked = $true
                $blockedReason = 'escalation-already-resolved: an identical escalation (same question/hypothesis/evidence state) already produced a Deep artifact; the previous Deep call does not by itself justify another one.'
                $selectionReason = $blockedReason
            } else {
                $selectedRole = 'engineer_deep'
                $escalated = $true
                $selectionReason = "Deterministic escalation reason: $EscalationReason."
                $signals += @("escalation:$EscalationReason")
                if (@($EvidenceRefs).Count -gt 0) { $signals += @('evidence-refs:' + (@($EvidenceRefs) -join ',')) }
            }
        }
    }

    # A de-escalation is the Deep -> Normal transition itself; it does not
    # require an open escalation (the artifact that resolved it is already
    # recorded, which is exactly why the role came back down).
    $deescalated = ($selectedRole -eq 'engineer_normal' -and $previousRole -eq 'engineer_deep' -and -not $escalated -and -not $blocked)

    $resolution = Resolve-AihStepRoleTarget -Workspace $Workspace -Preset $Preset -TaskInstanceId $TaskInstanceId
    $targets = $resolution.targets
    $target = $targets[$selectedRole]
    # R6.3.1: pinned generations fail closed here when the live-resolved step
    # target disagrees with the pinned map (legacy sessions: no pin, no-op).
    Assert-AihStepRoleTargetPinned -RoutingDataRoot $resolution.routingDataRoot -TaskInstanceId $TaskInstanceId -Role ([string]$target.role) -Target $target
    $stepId = [guid]::NewGuid().ToString('N')
    $record = [ordered]@{
        recordVersion = 1
        recordId = [guid]::NewGuid().ToString('N')
        timestampUtc = Get-AihEngineeringUtcNow
        taskId = $TaskId
        taskInstanceId = if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) { $null } else { $TaskInstanceId }
        milestoneId = $MilestoneId
        stepId = $stepId
        stepKind = $StepKind
        epistemicAction = $EpistemicAction
        selectedRole = $selectedRole
        previousRole = $previousRole
        selectionReason = $selectionReason
        signals = @($signals)
        escalated = [bool]$escalated
        deescalated = [bool]$deescalated
        escalationSignature = $escalationSignature
        escalationReason = if ($EscalationReason -ne 'none') { $EscalationReason } else { $null }
        escalationResolved = $false
        questionKey = if ([string]::IsNullOrEmpty($Question)) { $null } else { (Get-AihEngineeringNormalizedKey $Question) }
        question = if ([string]::IsNullOrEmpty($Question)) { $null } else { (ConvertTo-AihEngineeringSafeText $Question 500) }
        evidenceRefs = @($EvidenceRefs)
        hypothesisKey = $requestedHypothesisKey
        evidenceVersion = $evidenceVersion
        blocked = [bool]$blocked
        blockedReason = $blockedReason
        roleTarget = $target
    }
    Add-AihJsonLine -Path $path -Value $record

    # Mirror the step role into the durable routing state (engineering roles
    # only; the reviewer is never part of this mechanism).
    Set-AihRoutingStateStepRole -StatePath $resolution.statePath -StepRole $selectedRole | Out-Null

    # Mirror the execution state into the Working Set (compact current state).
    Set-AihWorkingSetExecutionState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -CurrentRole $selectedRole -PreviousRole $previousRole -LastEscalationReason $(if ($EscalationReason -ne 'none') { $EscalationReason } else { '' }) -LastEscalationSignature $(if ($escalationSignature) { $escalationSignature } else { '' }) | Out-Null

    return [ordered]@{
        stepId = $stepId
        previousRole = $previousRole
        selectedRole = $selectedRole
        escalated = [bool]$escalated
        deescalated = [bool]$deescalated
        blocked = [bool]$blocked
        blockedReason = $blockedReason
        selectionReason = $selectionReason
        escalationSignature = $escalationSignature
        signals = @($signals)
        roleTarget = $target
    }
}

function Complete-AihDeepEscalation {
    # Record the Deep artifact reference and RESOLVE the open escalation.
    # Deep never merely produces another conversational answer: this action
    # requires the artifact path/id that makes the result reusable.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [Parameter(Mandatory=$true)][string]$ArtifactRef,[string]$Summary = ''
    )
    $path = Get-AihStepRoutingPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $open = Get-AihOpenEscalation -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $open) { throw 'No open Deep escalation to resolve.' }
    Set-AihEngineeringProperty -Object $open -Name 'escalationResolved' -Value $true
    Set-AihEngineeringProperty -Object $open -Name 'resolvedAtUtc' -Value (Get-AihEngineeringUtcNow)
    Set-AihEngineeringProperty -Object $open -Name 'deepArtifactRef' -Value $ArtifactRef
    if (-not [string]::IsNullOrEmpty($Summary)) { Set-AihEngineeringProperty -Object $open -Name 'deepArtifactSummary' -Value (ConvertTo-AihEngineeringSafeText $Summary 500) }
    # Rewrite in place. ONE Deep escalation spans MULTIPLE step records
    # (every turn under the open escalation re-emits selectedRole=deep with
    # escalationResolved=$false), so the resolution marks ALL unresolved Deep
    # records resolved - there is exactly one open escalation per task at a
    # time and it is closed as a whole (records are few; a deterministic
    # rewrite keeps one authoritative line per step).
    $lines = [Collections.Generic.List[string]]::new()
    foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $path) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try {
            $candidate = $line | ConvertFrom-Json
            if ($null -ne $candidate -and [string]$candidate.selectedRole -eq 'engineer_deep' -and -not [bool]$candidate.escalationResolved) {
                Set-AihEngineeringProperty -Object $candidate -Name 'escalationResolved' -Value $true
                Set-AihEngineeringProperty -Object $candidate -Name 'resolvedAtUtc' -Value ([string]$open.resolvedAtUtc)
                Set-AihEngineeringProperty -Object $candidate -Name 'deepArtifactRef' -Value ([string]$open.deepArtifactRef)
                $lines.Add(($candidate | ConvertTo-Json -Depth 12 -Compress))
            } else {
                $lines.Add($line)
            }
        } catch { $lines.Add($line) }
    }
    [IO.File]::WriteAllText($path, (($lines -join [Environment]::NewLine) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))

    Set-AihWorkingSetExecutionState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -CurrentRole 'engineer_normal' -PreviousRole 'engineer_deep' -LastDeepArtifact $ArtifactRef | Out-Null
    return $open
}

function Get-AihStepRoutingSnapshot {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $records = @(Get-AihStepRoutingRecords -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    $normal = @($records | Where-Object { $_.selectedRole -eq 'engineer_normal' }).Count
    $deep = @($records | Where-Object { $_.selectedRole -eq 'engineer_deep' }).Count
    $escalations = @($records | Where-Object { [bool]$_.escalated })
    $deescalations = @($records | Where-Object { [bool]$_.deescalated })
    $last = if ($records.Count -gt 0) { $records[$records.Count - 1] } else { $null }
    return [ordered]@{
        steps = $records.Count
        normalSteps = $normal
        deepSteps = $deep
        escalationCount = $escalations.Count
        deescalationCount = $deescalations.Count
        escalationReasons = @($escalations | ForEach-Object { $_.escalationReason })
        escalationSignatures = @($escalations | ForEach-Object { $_.escalationSignature } | Select-Object -Unique)
        blockedEscalations = @($records | Where-Object { [bool]$_.blocked }).Count
        openEscalation = (Get-AihOpenEscalation -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
        lastRole = if ($null -ne $last) { [string]$last.selectedRole } else { $null }
        lastRecord = $last
    }
}
