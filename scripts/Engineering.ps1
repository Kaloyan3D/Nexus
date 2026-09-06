[CmdletBinding()]
# Phase 3.2.5: Engineering Mode CLI - the single deterministic surface for
# the Engineering Mode hardening modules (scripts/Engineering/*). Task-local,
# controller-owned, identity-guarded. User-derived text travels through the
# UTF-8 payload file, never the command line (see Task.ps1/Route.ps1).
param(
    [ValidateSet('lifecycle-init','working-set-init','working-set-update-instruction','working-set-milestone','working-set-fact','working-set-retrieve','working-set-invalidate','working-set-hypothesis','working-set-changed-files','working-set-snapshot',
                 'requirements-init','requirements-add','requirements-status','requirements-snapshot',
                 'uncertainty-create','uncertainty-evidence','uncertainty-status','epistemic-select','epistemic-step','epistemic-complete','epistemic-hypothesis','epistemic-probe','epistemic-snapshot',
                 'select-step','complete-deep','step-routing-snapshot',
                 'classify-failure','failure-snapshot','request-retry','retry-snapshot',
                 'evidence-gate','record-decision','decision-snapshot',
                 'invoke-tool','tool-snapshot',
                 'plan-verification','complete-verification','verification-snapshot',
                 'record-model-usage','set-compactions','telemetry-snapshot')]
    [string]$Action='telemetry-snapshot',
    [string]$Workspace=(Get-Location).Path,
    [string]$TaskId,[string]$TaskInstanceId,[string]$MilestoneId,[string]$StepKind,
    [string]$EscalationReason='none',[string]$Question,[string]$Hypothesis,[string]$ArtifactRef,[string]$Summary,
    [string]$UncertaintyId,[string]$UncertaintyKind='mixed',[string]$Subject,[string]$DecisionImpact='medium',[string[]]$CandidateActions=@(),
    [bool]$ProbeAvailable=$false,[string]$ProbeCost='low',[string]$ProbeRisk='safe',[string]$ExpectedInformationGain='medium',[string]$DecisionRelevance='medium',[bool]$RepositoryAvailable=$true,
    [AllowNull()][object]$ObservedValue,[string]$EvidenceHash,[string]$CurrentEvidenceHash,[bool]$Authoritative=$true,[bool]$Current=$true,[bool]$ResolveConflict=$false,
    [bool]$ImplementationReady=$false,[bool]$VerificationRequired=$false,[string]$ActionId,[string]$ActionResult='succeeded',[string]$Purpose,[string]$Target,[string]$ExpectedObservation,
    [string]$Text,[string]$Source,[bool]$Required=$true,[string]$Notes,[string]$RequirementId,[string]$Status,
    [string]$ImplementationEvidence,[string]$VerificationEvidence,[string]$VerificationId,
    [string]$Query,[int]$MaxResults=20,[string]$Bucket,[string[]]$Dimensions=@(),[string[]]$FileRefs=@(),[string]$FactSource,[string]$Detail,
    [string]$NextAction,[string]$NextVerification,[string]$DiffSummary,
    [ValidateSet('none','run_command','run_powershell','run_test')][string]$ToolOperation='none',
    [string]$Executable,[string[]]$Argv=@(),[string]$Cwd,[string]$Script,[string]$ScriptPath,[int]$TimeoutMs=120000,[string]$TestTarget,
    [ValidateSet('local-change','milestone','cross-cutting','final')][string]$VerificationScope='local-change',[string]$Reason,
    [string[]]$RequirementIds=@(),[object[]]$Commands=@(),
    [string]$FailureSignature,[string]$Classification,[string]$EvidenceText,[string]$Investigation,[string]$ActionSummary,
    [ValidateSet('engineer_normal','engineer_deep','reviewer')][string]$Role='engineer_normal',
    [int]$InputTokens=0,[int]$UncachedInputTokens=0,[int]$CacheReadTokens=0,[int]$OutputTokens=0,[bool]$UsageAvailable=$false,[string]$Model,[string]$Provider,[double]$EstimatedCost=-1,
    [int]$Compactions=-1,
    [string[]]$Paths=@(),
    [string]$Preset='aih-engineering',
    [string]$PayloadFile
)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'TaskController.ps1')
. (Join-Path $PSScriptRoot 'Routing.ps1')
. (Join-Path $PSScriptRoot 'Engineering/Shared.ps1')
. (Join-Path $PSScriptRoot 'Engineering/WorkingSet.ps1')
. (Join-Path $PSScriptRoot 'Engineering/Requirements.ps1')
. (Join-Path $PSScriptRoot 'Engineering/StepRouting.ps1')
. (Join-Path $PSScriptRoot 'Engineering/Failures.ps1')
. (Join-Path $PSScriptRoot 'Engineering/RetryPolicy.ps1')
. (Join-Path $PSScriptRoot 'Engineering/EvidenceGate.ps1')
. (Join-Path $PSScriptRoot 'Engineering/Execution.ps1')
. (Join-Path $PSScriptRoot 'Engineering/EpistemicPolicy.ps1')
. (Join-Path $PSScriptRoot 'Engineering/Verification.ps1')
. (Join-Path $PSScriptRoot 'Engineering/Telemetry.ps1')

if ($PayloadFile) {
    if (-not (Test-Path -LiteralPath $PayloadFile)) { throw "Payload file not found: $PayloadFile" }
    $__aihPayload = Get-Content -Raw -Encoding UTF8 -LiteralPath $PayloadFile | ConvertFrom-Json
    # CASE-INSENSITIVE payload mapping: producers use camelCase JSON keys
    # (taskInstanceId, evidenceText, ...). Member resolution is
    # case-insensitive in PowerShell, but the PSObject.Properties INDEXER is
    # not, so build an explicit lowercase map and resolve through it.
    $__aihPayloadMap = @{}
    foreach ($property in @($__aihPayload.PSObject.Properties)) {
        if ($null -ne $property) { $__aihPayloadMap[[string]$property.Name.ToLowerInvariant()] = $property.Value }
    }
    foreach ($name in @('Workspace','TaskId','TaskInstanceId','MilestoneId','StepKind','EscalationReason','Question','Hypothesis','ArtifactRef','Summary','Text','Source','Notes','RequirementId','Status','ImplementationEvidence','VerificationEvidence','VerificationId','Query','Bucket','Detail','NextAction','NextVerification','DiffSummary','ToolOperation','Executable','Cwd','Script','ScriptPath','TestTarget','VerificationScope','Reason','FailureSignature','Classification','EvidenceText','Investigation','ActionSummary','Role','Model','Provider','Preset','EstimatedCost','UncertaintyId','UncertaintyKind','Subject','DecisionImpact','ProbeCost','ProbeRisk','ExpectedInformationGain','DecisionRelevance','EvidenceHash','CurrentEvidenceHash','ActionId','ActionResult','Purpose','Target','ExpectedObservation')) {
        $key = $name.ToLowerInvariant()
        if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name $name -Value ([string]$__aihPayloadMap[$key]) }
    }
    foreach ($name in @('Required','UsageAvailable','ProbeAvailable','RepositoryAvailable','Authoritative','Current','ResolveConflict','ImplementationReady','VerificationRequired')) {
        $key = $name.ToLowerInvariant()
        if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name $name -Value ([bool]$__aihPayloadMap[$key]) }
    }
    foreach ($name in @('MaxResults','TimeoutMs','InputTokens','UncachedInputTokens','CacheReadTokens','OutputTokens','Compactions')) {
        $key = $name.ToLowerInvariant()
        if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name $name -Value ([int]$__aihPayloadMap[$key]) }
    }
    $key = 'estimatedCost'
    if ($__aihPayloadMap.ContainsKey($key)) { $EstimatedCost = [double]$__aihPayloadMap[$key] }
    foreach ($name in @('Dimensions','FileRefs','RequirementIds','Argv','Paths','Commands','CandidateActions')) {
        $key = $name.ToLowerInvariant()
        if ($__aihPayloadMap.ContainsKey($key)) { Set-Variable -Name $name -Value @($__aihPayloadMap[$key]) }
    }
    if ($__aihPayloadMap.ContainsKey('observedvalue')) { $ObservedValue = $__aihPayloadMap['observedvalue'] }
}

# Every action is task-scoped and identity-guarded: TaskId + TaskInstanceId
# are validated against the authoritative ledger (fail closed on mismatch).
if ([string]::IsNullOrWhiteSpace($TaskId)) { throw 'Engineering actions require -TaskId.' }

$__aihEngineeringResult = $(switch ($Action) {
    # -- Production lifecycle bootstrap --------------------------------------
    'lifecycle-init'                    {
        $workingSet = New-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Objective $Text
        $requirements = New-AihRequirementsDocument -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
        if (@($requirements.requirements).Count -eq 0 -and -not [string]::IsNullOrWhiteSpace($Text)) {
            [void](Add-AihRequirement -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Text $Text -Source 'user' -Required $true)
            $requirements = Read-AihRequirementsDocument -Path (Get-AihRequirementsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
        }
        # Create the metrics envelope without inventing usage. Subsequent
        # telemetry is derived from real step/failure/verification records.
        $metrics = Set-AihEngineeringCompactions -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Count 0
        $epistemic = Initialize-AihEpistemicState -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
        [ordered]@{workingSet=$workingSet;requirements=$requirements;metrics=$metrics;epistemic=$epistemic}
    }
    # -- Working Set ----------------------------------------------------------
    'working-set-init'                  { New-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Objective $Text -Constraints $Paths -Invariants $FileRefs }
    'working-set-update-instruction'    { Update-AihWorkingSetFromInstruction -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Instruction $Text }
    'working-set-milestone'             { Set-AihWorkingSetMilestone -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -MilestoneId $MilestoneId -NextAction $NextAction }
    'working-set-fact'                  { Add-AihWorkingSetFact -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Bucket $Bucket -Fact $Text -Dimensions $Dimensions -FileRefs $FileRefs -Source $(if ([string]::IsNullOrWhiteSpace($FactSource)) { 'deterministic-repository' } else { $FactSource }) -Detail $Detail }
    'working-set-retrieve'              { Invoke-AihWorkingSetRetrieval -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Query $Query -MaxResults $MaxResults }
    'working-set-invalidate'            { Update-AihWorkingSetInvalidation -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    'working-set-hypothesis'            { Set-AihWorkingSetHypothesis -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Hypothesis $Hypothesis -NextAction $NextAction -NextVerification $NextVerification }
    'working-set-changed-files'         { Set-AihWorkingSetChangedFiles -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Paths $Paths -DiffSummary $DiffSummary }
    'working-set-snapshot'              { Get-AihWorkingSetSnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    # -- Epistemic Action Policy v0 ------------------------------------------
    'uncertainty-create'                { New-AihUncertainty -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Question $Question -Kind $UncertaintyKind -Subject $Subject -DecisionImpact $DecisionImpact -CandidateActions $CandidateActions -ProbeAvailable:$ProbeAvailable -ProbeCost $ProbeCost -ProbeRisk $ProbeRisk -ExpectedInformationGain $ExpectedInformationGain -DecisionRelevance $DecisionRelevance -RepositoryAvailable:$RepositoryAvailable }
    'uncertainty-evidence'              { Add-AihUncertaintyEvidence -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -UncertaintyId $UncertaintyId -Subject $Subject -Value $ObservedValue -Source $(if([string]::IsNullOrWhiteSpace($Source)){'observation'}else{$Source}) -EvidenceHash $EvidenceHash -Authoritative:$Authoritative -Current:$Current -ResolveConflict:$ResolveConflict }
    'uncertainty-status'                { Set-AihUncertaintyStatus -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -UncertaintyId $UncertaintyId -Status $Status -Reason $Reason }
    'epistemic-select'                  { Select-AihEpistemicAction -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -UncertaintyId $UncertaintyId -CurrentEvidenceHash $CurrentEvidenceHash -ImplementationReady:$ImplementationReady -VerificationRequired:$VerificationRequired }
    'epistemic-step'                    { Select-AihEpistemicStep -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -UncertaintyId $UncertaintyId -MilestoneId $MilestoneId -CurrentEvidenceHash $CurrentEvidenceHash -ImplementationReady:$ImplementationReady -VerificationRequired:$VerificationRequired -EscalationReason $EscalationReason -Question $Question -Hypothesis $Hypothesis -EvidenceRefs $FileRefs -StepKind $StepKind -Preset $Preset }
    'epistemic-complete'                { Complete-AihEpistemicAction -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -ActionId $ActionId -Result $ActionResult -Summary $Summary -FailureSignature $FailureSignature }
    'epistemic-hypothesis'              { Add-AihEpistemicHypothesis -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -UncertaintyId $UncertaintyId -Text $Hypothesis }
    'epistemic-probe'                   { Invoke-AihEpistemicProbe -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -ActionId $ActionId -UncertaintyId $UncertaintyId -Purpose $Purpose -Operation $ToolOperation -Target $Target -ExpectedObservation $ExpectedObservation -Executable $Executable -Argv $Argv -Cwd $Cwd -Script $Script -ScriptPath $ScriptPath -TimeoutMs $TimeoutMs -TestTarget $TestTarget }
    'epistemic-snapshot'                { Get-AihEpistemicSnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    # -- Requirement Compiler --------------------------------------------------
    'requirements-init'                 { New-AihRequirementsDocument -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    'requirements-add'                  { Add-AihRequirement -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Text $Text -Source $(if ([string]::IsNullOrWhiteSpace($Source)) { 'user' } else { $Source }) -Required $Required -Notes $Notes }
    'requirements-status'               { Set-AihRequirementStatus -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -RequirementId $RequirementId -Status $Status -ImplementationEvidence $ImplementationEvidence -VerificationEvidence $VerificationEvidence -Notes $Notes }
    'requirements-snapshot'             { Get-AihRequirementsSnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    # -- Step routing ------------------------------------------------------------
    'select-step'                       { Select-AihStepRole -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -MilestoneId $MilestoneId -EscalationReason $EscalationReason -Question $Question -Hypothesis $Hypothesis -EvidenceRefs $FileRefs -StepKind $StepKind -Preset $Preset -EpistemicAction 'reason' }
    'complete-deep'                     { Complete-AihDeepEscalation -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -ArtifactRef $ArtifactRef -Summary $Summary }
    'step-routing-snapshot'             { Get-AihStepRoutingSnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    # -- Failure classifier / retry policy ---------------------------------------
    'classify-failure'                  { if (-not [string]::IsNullOrWhiteSpace($Classification) -and -not ($EngineeringFailureClasses -contains $Classification)) { throw "Unknown failure classification: $Classification" }; Record-AihFailure -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Classification $Classification -Signature $FailureSignature -Executable $Executable -Detail $Detail -EvidenceText $EvidenceText -Operation $ActionSummary -Hypothesis $Hypothesis }
    'failure-snapshot'                  { Get-AihFailureSnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    'request-retry'                     { Request-AihRetryDecision -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -FailureSignature $FailureSignature -Hypothesis $Hypothesis -ActionSummary $ActionSummary -Investigation $Investigation }
    'retry-snapshot'                    { Get-AihRetrySnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    # -- Evidence gate / decisions ------------------------------------------------
    'evidence-gate'                     { Test-AihEvidenceGate -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Dimensions $Dimensions }
    'record-decision'                   { New-AihDecisionArtifact -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Question $Question -Dimensions $Dimensions -SelectedApproach $Text -Reason $Reason -Alternatives $FileRefs -RejectedAlternatives $Paths -Risk $Detail -Confidence $Summary -Source $Source }
    'decision-snapshot'                 { Get-AihDecisionSnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    # -- Structured execution ------------------------------------------------------
    'invoke-tool'                       { Invoke-AihStructuredOperation -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Operation $ToolOperation -Executable $Executable -Argv $Argv -Cwd $Cwd -Script $Script -ScriptPath $ScriptPath -TimeoutMs $TimeoutMs -TestTarget $TestTarget }
    'tool-snapshot'                     { Get-AihToolExecutionSnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    # -- Verification Strategy v0 ---------------------------------------------------
    'plan-verification'                 { New-AihVerificationPlan -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Scope $VerificationScope -Reason $Reason -RequirementIds $RequirementIds -Commands $Commands }
    'complete-verification'             { Complete-AihVerification -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -VerificationId $VerificationId -Result $Status -Summary $Summary }
    'verification-snapshot'             { Get-AihVerificationSnapshot -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    # -- Telemetry --------------------------------------------------------------------
    'record-model-usage'                { Add-AihModelUsage -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Role $Role -StepId $MilestoneId -InputTokens $InputTokens -UncachedInputTokens $UncachedInputTokens -CacheReadTokens $CacheReadTokens -OutputTokens $OutputTokens -UsageAvailable $UsageAvailable -Model $Model -Provider $Provider -EstimatedCost $EstimatedCost }
    'set-compactions'                   { Set-AihEngineeringCompactions -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Count ([Math]::Max(0, $Compactions)) }
    'telemetry-snapshot'                { Get-AihEngineeringTelemetry -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
})
# Serialize with -InputObject (NOT the pipeline): piping an OrderedDictionary
# result unrolls it into DictionaryEntry items and corrupts the output JSON.
if ($null -ne $__aihEngineeringResult) { ConvertTo-Json -InputObject (ConvertTo-AihEngineeringSerializable $__aihEngineeringResult) -Depth 20 }
