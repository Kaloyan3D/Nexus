param([string]$InstallRoot)
$ErrorActionPreference='Stop'; if([string]::IsNullOrWhiteSpace($InstallRoot)){$InstallRoot=Split-Path -Parent $PSScriptRoot}; $InstallRoot=[IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $InstallRoot 'scripts/Common.ps1'); . (Join-Path $InstallRoot 'scripts/TaskController.ps1'); . (Join-Path $InstallRoot 'scripts/Routing.ps1')
foreach($name in @('Shared','WorkingSet','Requirements','StepRouting','Failures','RetryPolicy','EvidenceGate','Execution','EpistemicPolicy','Verification','Telemetry')){. (Join-Path $InstallRoot ('scripts/Engineering/'+$name+'.ps1'))}
$script:pass=0; function Assert-Aih($condition,[string]$message){if(-not $condition){Write-Host "FAIL: $message";throw $message};$script:pass++;Write-Host "PASS: $message"}
function New-TestTask([string]$root,[string]$description='epistemic policy task'){$task=New-AihTask -Workspace $root -Description $description; New-AihWorkingSet -Workspace $root -TaskId $task.taskId -TaskInstanceId $task.taskInstanceId -Objective $description|Out-Null; Initialize-AihEpistemicState -Workspace $root -TaskId $task.taskId -TaskInstanceId $task.taskInstanceId|Out-Null;return $task}
function New-U($root,$task,$question,$kind,$subject='subject',$probe=$false,$risk='safe',$cost='low',$gain='high',$relevance='high',$repo=$true){return New-AihUncertainty -Workspace $root -TaskId $task.taskId -TaskInstanceId $task.taskInstanceId -Question $question -Kind $kind -Subject $subject -ProbeAvailable:$probe -ProbeRisk $risk -ProbeCost $cost -ExpectedInformationGain $gain -DecisionRelevance $relevance -RepositoryAvailable:$repo}

$root=Join-Path ([IO.Path]::GetTempPath()) ('aih-epistemic-'+[guid]::NewGuid().ToString('N'));$installFixture=Join-Path $root 'install';$workspace=Join-Path $root 'workspace';New-Item -ItemType Directory -Force -Path $workspace,(Join-Path $installFixture 'config'),(Join-Path $installFixture 'data/routing')|Out-Null
Copy-Item -LiteralPath (Join-Path $InstallRoot 'config/routing-policy.json'),(Join-Path $InstallRoot 'config/engineering-profiles.json'),(Join-Path $InstallRoot 'config/model-registry.json') -Destination (Join-Path $installFixture 'config')
if(Test-Path -LiteralPath (Join-Path $InstallRoot 'data/settings.yaml')){New-Item -ItemType Directory -Force -Path (Join-Path $installFixture 'data')|Out-Null;Copy-Item -LiteralPath (Join-Path $InstallRoot 'data/settings.yaml') -Destination (Join-Path $installFixture 'data/settings.yaml')}
$fixtureSettings=Join-Path $installFixture 'data/settings.yaml'
$fixtureSettingsText=if(Test-Path -LiteralPath $fixtureSettings){Get-Content -Raw -LiteralPath $fixtureSettings}else{''}
if($fixtureSettingsText -match '(?m)^engineering-profile:'){$fixtureSettingsText=[regex]::Replace($fixtureSettingsText,'(?m)^engineering-profile:.*$','engineering-profile: deepseek-codex')}else{$fixtureSettingsText="engineering-profile: deepseek-codex`r`n"+$fixtureSettingsText}
Set-Content -LiteralPath $fixtureSettings -Value $fixtureSettingsText -Encoding UTF8
$oldHome=$env:DSH_HOME;$env:DSH_HOME=(Join-Path $installFixture 'data')
try{
 $task=New-TestTask $workspace
 $instance=$task.taskInstanceId

 # Fresh evidence -> REUSE; stale state hash -> reacquire rather than reuse.
 $reuseU=New-U $workspace $task 'What exact runtime fact was observed?' empirical 'runtime.fact' $true
 Add-AihUncertaintyEvidence -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $reuseU.id -Subject 'runtime.fact' -Value 'answer' -Source 'deterministic-probe' -EvidenceHash 'state-A' -ResolveConflict:$true|Out-Null
 $reuse=Select-AihEpistemicAction -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $reuseU.id -CurrentEvidenceHash 'state-A'
 Assert-Aih ($reuse.selectedAction -eq 'reuse') 'fresh authoritative evidence selects REUSE'
 Assert-Aih ($reuse.costTier -eq 'P0') 'REUSE is the lowest cost tier'
 Assert-Aih ([bool]$reuse.reasoningAvoided) 'REUSE records reasoning avoidance'
 $stale=Select-AihEpistemicAction -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $reuseU.id -CurrentEvidenceHash 'state-B'
 Assert-Aih ($stale.selectedAction -eq 'probe') 'changed evidence hash disables REUSE'
 Assert-Aih ($stale.actionId -ne $reuse.actionId) 'a new lifecycle action is recorded without duplicate tool execution'

 # Repository -> RETRIEVE, then evidence -> REUSE. The recommendation points
 # to the existing ContextEngine/Working Set path rather than another engine.
 Set-Content -LiteralPath (Join-Path $workspace 'policy-target.txt') -Value 'epistemic repository target' -Encoding UTF8
 $repoU=New-U $workspace $task 'Where is the epistemic repository target?' repository 'repository.target' $false 'safe' 'low' 'high' 'high' $true
 $retrieve=Select-AihEpistemicAction -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $repoU.id
 Assert-Aih ($retrieve.selectedAction -eq 'retrieve') 'repository-answerable uncertainty selects RETRIEVE'
 Assert-Aih ($retrieve.costTier -eq 'P1') 'repository retrieval uses P1 cost'
 Assert-Aih ($retrieve.selectionReason -match 'repository/code intelligence') 'RETRIEVE selection records the existing intelligence pathway'
 Add-AihUncertaintyEvidence -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $repoU.id -Subject 'repository.target' -Value 'policy-target.txt' -Source 'context-engine' -EvidenceHash 'repo-state' -ResolveConflict:$true|Out-Null
 $repoReuse=Select-AihEpistemicAction -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $repoU.id -CurrentEvidenceHash 'repo-state'
 Assert-Aih ($repoReuse.selectedAction -eq 'reuse') 'retrieved evidence is subsequently reusable while fresh'
 $repoState=Get-AihEpistemicState -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance
 Assert-Aih (@((Get-AihEpistemicUncertainty $repoState $repoU.id).knownEvidence).Count -eq 1) 'REUSE does not duplicate repository evidence'

 # Serializer-style conflicting empirical observations -> tiny safe probe.
 $probeU=New-U $workspace $task 'What does this value actually serialize to under Windows PowerShell 5.1?' empirical 'powershell.serialization.value' $true 'safe' 'trivial' 'high' 'high'
 Add-AihUncertaintyEvidence -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $probeU.id -Subject 'powershell.serialization.value' -Value '"ts-monorepo"' -Source 'observation-A' -EvidenceHash 'obs-A'|Out-Null
 Add-AihUncertaintyEvidence -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $probeU.id -Subject 'powershell.serialization.value' -Value '{"Length":11}' -Source 'observation-B' -EvidenceHash 'obs-B'|Out-Null
 $probeState=Get-AihEpistemicState -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance;$probeCurrent=Get-AihEpistemicUncertainty $probeState $probeU.id
 Assert-Aih ([bool]$probeCurrent.evidenceConflict) 'same-subject incompatible current values create an evidence conflict'
 Assert-Aih (@($probeCurrent.knownEvidence).Count -eq 2) 'conflicting observations remain auditable'
 $probeStep=Select-AihEpistemicStep -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $probeU.id -Question $probeU.question -StepKind 'probe' -Preset 'aih-engineering'
 Assert-Aih ($probeStep.selectedAction -eq 'probe') 'safe cheap empirical conflict selects PROBE over REASON'
 Assert-Aih ($probeStep.selectedRole -eq 'engineer_normal') 'empirical uncertainty does not escalate beyond Engineer Normal'
 Assert-Aih ($probeStep.action.costTier -eq 'P2') 'tiny deterministic runtime probe uses P2'
 Assert-Aih ($probeStep.action.probeRisk -eq 'safe') 'probe safety is recorded'
 $scriptText='$value = ''ts-monorepo''; [Console]::Out.Write((ConvertTo-Json -InputObject $value -Compress))'
 $probeRun=Invoke-AihEpistemicProbe -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -ActionId $probeStep.actionId -UncertaintyId $probeU.id -Purpose 'Observe exact PowerShell JSON' -Operation run_powershell -Target 'powershell.serialization.value' -ExpectedObservation 'JSON string' -Script $scriptText
 Assert-Aih ($probeRun.probe.result -eq 'success') 'tiny serializer probe succeeds through structured execution'
 Assert-Aih ($probeRun.probe.exitCode -eq 0) 'probe records exact exit code'
 Assert-Aih ($probeRun.probe.observedValue -eq '"ts-monorepo"') 'probe records the exact deterministic observation'
 Assert-Aih ([bool]$probeRun.probe.resolvedQuestion) 'successful probe resolves the empirical uncertainty'
 Assert-Aih (-not [string]::IsNullOrWhiteSpace([string]$probeRun.probe.evidenceHash)) 'probe result records an evidence hash'
 $resolvedProbe=Get-AihEpistemicUncertainty (Get-AihEpistemicState $workspace $task.taskId $instance) $probeU.id
 Assert-Aih ($resolvedProbe.status -eq 'resolved') 'successful observation moves uncertainty to resolved'
 Assert-Aih (-not [bool]$resolvedProbe.evidenceConflict) 'authoritative probe resolves but does not delete conflict history'
 Assert-Aih (@($resolvedProbe.knownEvidence).Count -eq 3) 'old conflict provenance remains after resolution'

 # Failed and unsafe probes.
 $failedU=New-U $workspace $task 'Does the failing probe resolve anything?' empirical 'probe.failure' $true
 $failedStep=Select-AihEpistemicStep -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $failedU.id -Question $failedU.question -StepKind 'probe'
 $failedRun=Invoke-AihEpistemicProbe -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -ActionId $failedStep.actionId -UncertaintyId $failedU.id -Purpose 'Expected failure' -Operation run_powershell -Target 'probe.failure' -ExpectedObservation 'nonzero' -Script 'exit 7'
 Assert-Aih ($failedRun.probe.result -eq 'failure') 'failed probe records failure'
 Assert-Aih (-not [bool]$failedRun.probe.resolvedQuestion) 'failed probe does not fabricate resolution'
 Assert-Aih ($null -ne $failedRun.probe.failureSignature) 'failed probe feeds the existing failure classifier'
 Assert-Aih ((Get-AihEpistemicUncertainty (Get-AihEpistemicState $workspace $task.taskId $instance) $failedU.id).status -ne 'resolved') 'failed uncertainty remains unresolved'
 $dangerU=New-U $workspace $task 'May a dangerous production mutation answer this?' empirical 'danger' $true 'dangerous'
 $danger=Select-AihEpistemicAction -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $dangerU.id
 Assert-Aih ($danger.selectedAction -eq 'reason') 'dangerous probe is never auto-selected'
 Assert-Aih ($danger.selectionReason -match 'not eligible for automatic execution') 'dangerous risk explains the safety override'
 $externalU=New-U $workspace $task 'Would an external probe answer this?' empirical 'external' $true 'external'
 $external=Select-AihEpistemicAction -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $externalU.id
 Assert-Aih ($external.selectedAction -eq 'reason' -and $external.probeRisk -eq 'external') 'external probe risk is recorded and not auto-executed'
 $mutatingU=New-U $workspace $task 'Would a mutating probe answer this?' empirical 'mutating' $true 'mutating'
 $mutating=Select-AihEpistemicAction -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $mutatingU.id
 Assert-Aih ($mutating.selectedAction -eq 'reason' -and $mutating.probeRisk -eq 'mutating') 'mutating probe risk is recorded and not auto-executed'

 # Judgment -> REASON, Normal by default, legitimate structured Deep remains.
 $judgmentU=New-U $workspace $task 'Which persistence contract preserves both invariants?' judgment 'architecture.contract' $false
 $normalReason=Select-AihEpistemicStep -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $judgmentU.id -Question $judgmentU.question -StepKind 'decision'
 Assert-Aih ($normalReason.selectedAction -eq 'reason') 'non-observable architecture judgment selects REASON'
 Assert-Aih ($normalReason.selectedRole -eq 'engineer_normal') 'REASON does not automatically imply Deep'
 $deepU=New-U $workspace $task 'How should incompatible lifecycle contracts be reconciled?' judgment 'architecture.deep' $false
 $deep=Select-AihEpistemicStep -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $deepU.id -Question $deepU.question -EscalationReason 'incompatible-invariants' -EvidenceRefs @('requirements.json') -StepKind 'decision'
 Assert-Aih ($deep.selectedAction -eq 'reason') 'legitimate Deep case remains an epistemic REASON action'
 Assert-Aih ($deep.selectedRole -eq 'engineer_deep') 'existing escalation gate can select Engineer Deep'
 Assert-Aih (-not [string]::IsNullOrWhiteSpace([string]$deep.step.escalationSignature)) 'Deep selection carries the existing stable escalation signature'

 # Deep artifact identifies missing fact -> PROBE -> Normal. Completing Deep
 # closes the old signature; changed evidence can justify a NEW Deep signature.
 Complete-AihDeepEscalation -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -ArtifactRef 'decision:missing-runtime-fact' -Summary 'Need empirical fact X'|Out-Null
 $deU=New-U $workspace $task 'What is runtime fact X?' empirical 'runtime.x' $true 'safe' 'trivial'
 $deProbe=Select-AihEpistemicStep -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $deU.id -Question $deU.question -StepKind 'probe'
 Assert-Aih ($deProbe.selectedAction -eq 'probe') 'Deep-discovered missing empirical fact selects PROBE'
 Assert-Aih ($deProbe.selectedRole -eq 'engineer_normal') 'routine probe returns execution to Engineer Normal'
 Assert-Aih ([bool]$deProbe.step.deescalated) 'Deep to Probe to Normal transition is explicit'
 $deRun=Invoke-AihEpistemicProbe -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -ActionId $deProbe.actionId -UncertaintyId $deU.id -Purpose 'Resolve X' -Operation run_powershell -Target 'runtime.x' -ExpectedObservation '42' -Script '[Console]::Out.Write("42")'
 Assert-Aih ($deRun.probe.observedValue -eq '42') 'de-escalated probe updates task-local evidence'
 $afterProbe=Select-AihEpistemicAction -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $deU.id -CurrentEvidenceHash $deRun.probe.evidenceHash
 Assert-Aih ($afterProbe.selectedAction -eq 'reuse') 'resolved probe avoids automatic return to Deep'
 $deepAgain=Select-AihEpistemicStep -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $deepU.id -Question $deepU.question -EscalationReason 'incompatible-invariants' -EvidenceRefs @('probe:runtime.x') -StepKind 'decision'
 Assert-Aih ($deepAgain.selectedRole -eq 'engineer_deep') 'remaining judgment may re-enter Deep after new evidence'
 Assert-Aih ($deepAgain.step.escalationSignature -ne $deep.step.escalationSignature) 're-entered Deep uses a new evidence-state signature'

 # Hypothesis anti-progress and two-strike integration.
 $h1=Add-AihEpistemicHypothesis -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $failedU.id -Text 'Serializer producer changes the type'
 $h2=Add-AihEpistemicHypothesis -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $failedU.id -Text ' serializer producer changes the type '
 Assert-Aih ([bool]$h1.progress) 'first normalized hypothesis records progress'
 Assert-Aih ([bool]$h2.duplicate -and -not [bool]$h2.progress) 'same hypothesis plus unchanged evidence is not new progress'
 Add-AihUncertaintyEvidence -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $failedU.id -Subject 'probe.failure' -Value 'new observation' -Source 'probe'|Out-Null
 $h3=Add-AihEpistemicHypothesis -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $failedU.id -Text 'Serializer producer changes the type'
 Assert-Aih ([bool]$h3.progress -and $h3.hypothesis.signature -ne $h1.hypothesis.signature) 'materially changed evidence permits hypothesis reconsideration'
 $failure=Record-AihFailure -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -Classification unknown -Executable 'test' -Detail 'same failing test' -EvidenceText 'failed' -Operation test -Hypothesis 'old'
 $retry1=Request-AihRetryDecision -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -FailureSignature $failure.signature -Hypothesis 'old' -ActionSummary 'retry once'
 Record-AihFailure -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -Classification unknown -Signature $failure.signature -Executable test -Detail 'same failing test' -EvidenceText failed -Operation test -Hypothesis old|Out-Null
 $retry2=Request-AihRetryDecision -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -FailureSignature $failure.signature -Hypothesis 'old' -ActionSummary 'retry once'
 Assert-Aih ([bool]$retry1.retryAllowed) 'first direct corrective retry remains allowed'
 Assert-Aih ([bool]$retry2.retryBlocked) 'same failure and hypothesis remains blocked after two strikes'
 Assert-Aih ($retry2.blockedReason -match 'second-strike') 'blind retry is not disguised as a probe'
 Add-AihUncertaintyEvidence -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $failedU.id -Subject 'probe.failure' -Value 'material new probe result' -Source 'deterministic-probe'|Out-Null
 $retry3=Request-AihRetryDecision -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -FailureSignature $failure.signature -Hypothesis 'old' -Investigation 'A new deterministic probe changed the evidence state.' -ActionSummary 'run a different targeted verification'
 Assert-Aih ([bool]$retry3.retryAllowed) 'new probe evidence permits a materially different next action'
 Assert-Aih ($retry3.requirement -match 'new task-local evidence') 'retry provenance identifies evidence progress rather than more speculation'

 # EXECUTE / VERIFY remain distinct from reasoning and from completion.
 $execU=New-U $workspace $task 'Apply the already selected fixture edit' judgment 'implementation.ready' $false
 $execute=Select-AihEpistemicAction -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $execU.id -ImplementationReady:$true
 Assert-Aih ($execute.selectedAction -eq 'execute') 'resolved implementation intent selects EXECUTE'
 Assert-Aih ([bool]$execute.reasoningAvoided) 'EXECUTE does not reopen reasoning'
 $verifyU=New-U $workspace $task 'Did the implementation satisfy the requirement?' verification 'requirement.verify' $false
 $verify=Select-AihEpistemicAction -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $verifyU.id
 Assert-Aih ($verify.selectedAction -eq 'verify') 'correctness uncertainty selects VERIFY'
 Assert-Aih ($verify.selectionReason -match 'Verification Strategy v0') 'VERIFY delegates to the existing verification strategy'
 $requirements=New-AihRequirementsDocument -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance
 $req=Add-AihRequirement -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -Text 'Required behavior' -Required:$true
 Set-AihRequirementStatus -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -RequirementId $req.id -Status implemented -ImplementationEvidence 'edit'|Out-Null
 $coverage=Get-AihRequirementCoverage -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance
 Assert-Aih ($coverage.implemented -eq 1 -and $coverage.verified -eq 0) 'IMPLEMENTED remains distinct from VERIFIED'
 Assert-Aih ($coverage.requiredUnverified -eq 1 -and @(Test-AihRequirementsCompletionBlock -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance).Count -gt 0) 'required unverified requirement blocks completion readiness'

 # Telemetry, Working Set mirror, provenance, and deterministic scope.
 $snap=Get-AihEpistemicSnapshot -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance
 Assert-Aih ($snap.actionCounts.probe -ge 3) 'epistemic telemetry counts PROBE actions'
 Assert-Aih ($snap.actionCounts.reason -ge 3) 'epistemic telemetry counts REASON actions'
 Assert-Aih ($snap.actionCounts.reuse -ge 3) 'epistemic telemetry counts REUSE actions'
 Assert-Aih ($snap.actionCounts.retrieve -eq 1) 'epistemic telemetry counts RETRIEVE actions'
 Assert-Aih ($snap.actionCounts.execute -eq 1) 'epistemic telemetry counts EXECUTE actions'
 Assert-Aih ($snap.actionCounts.verify -eq 1) 'epistemic telemetry counts VERIFY actions'
 Assert-Aih ($snap.probes.success -ge 2 -and $snap.probes.failure -ge 1) 'probe success and failure telemetry is factual'
 Assert-Aih ($snap.routing.deepProbeNormal -ge 1) 'Deep to Probe to Normal transition is measurable'
 Assert-Aih ($snap.reasoningAvoided -ge 1) 'reasoning avoidance counts cheap evidence choices'
 $telemetry=Get-AihEngineeringTelemetry -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance
 Assert-Aih ($telemetry.taskInstanceId -eq $instance) 'engineering telemetry carries exact taskInstanceId'
 Assert-Aih ($telemetry.epistemicActions.probe -eq $snap.actionCounts.probe) 'engineering telemetry integrates epistemic action counts'
 Assert-Aih ($null -eq $telemetry.estimatedCost) 'missing provider cost telemetry never fabricates savings'
 $ws=Get-AihWorkingSet -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance
 Assert-Aih ($ws.epistemic.stateRef -eq 'epistemic-state.json') 'Working Set references the compact epistemic state'
 Assert-Aih (-not [string]::IsNullOrWhiteSpace([string]$ws.epistemic.currentUncertaintyId)) 'Working Set mirrors current uncertainty identity'
 Assert-Aih (@(Get-AihEpistemicActionRecords $workspace $task.taskId $instance|Where-Object{$_.taskInstanceId -ne $instance}).Count -eq 0) 'every action/probe record is exact-instance scoped'
 Assert-Aih (@($AihEpistemicActions).Count -eq 6 -and 'reviewer' -notin $AihEpistemicActions) 'reviewer is not an epistemic action'
 $blockedU=New-U $workspace $task 'Waiting for operator authority' judgment 'blocked.lifecycle' $false
 $blockedState=Set-AihUncertaintyStatus -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -UncertaintyId $blockedU.id -Status blocked -Reason 'external authority required'
 Assert-Aih ($blockedState.status -eq 'blocked') 'uncertainty lifecycle supports an explicit blocked state'
 Update-AihWorkingSetFromInstruction -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instance -Instruction 'A materially new user requirement'|Out-Null
 $supersededState=Get-AihEpistemicUncertainty (Get-AihEpistemicState $workspace $task.taskId $instance) $blockedU.id
 Assert-Aih ($supersededState.status -eq 'superseded') 'a new user instruction supersedes affected unresolved uncertainty'

 # Generation isolation: replace the authoritative lifecycle instance for the
 # same task id; generation B initializes fresh state and filters A actions.
 $ledgerPath=(Get-AihLedgerLayout $workspace).Tasks;$ledger=Get-Content -Raw -LiteralPath $ledgerPath|ConvertFrom-Json;$instanceB='task_'+[guid]::NewGuid().ToString('N');$ledger.tasks[0].taskInstanceId=$instanceB;Write-AihAtomicJson -Path $ledgerPath -Value $ledger
 $stateB=Initialize-AihEpistemicState -Workspace $workspace -TaskId $task.taskId -TaskInstanceId $instanceB
 Assert-Aih ($stateB.taskInstanceId -eq $instanceB) 'generation B initializes an exact-instance epistemic state'
 Assert-Aih (@($stateB.uncertainties).Count -eq 0) 'generation B does not consume generation A uncertainty state'
 Assert-Aih (@(Get-AihEpistemicActionRecords $workspace $task.taskId $instanceB).Count -eq 0) 'generation B filters generation A action provenance'

 # Equivalent structured state is deterministic across tasks.
 $workspace2=Join-Path $root 'workspace2';New-Item -ItemType Directory -Force -Path $workspace2|Out-Null;$task2=New-TestTask $workspace2
 $u2=New-U $workspace2 $task2 'Which file defines this symbol?' repository 'repo.symbol' $false
 $a2=Select-AihEpistemicAction -Workspace $workspace2 -TaskId $task2.taskId -TaskInstanceId $task2.taskInstanceId -UncertaintyId $u2.id
 Assert-Aih ($a2.selectedAction -eq 'retrieve' -and $a2.selectionReason -eq $retrieve.selectionReason) 'equivalent structured state produces the same deterministic recommendation'

 $source=Get-Content -Raw -LiteralPath (Join-Path $InstallRoot 'scripts/Engineering/EpistemicPolicy.ps1')
 Assert-Aih ($source -notmatch '(?i)chain.of.thought|reasoning paragraphs|provider-specific reasoning') 'policy implementation contains no chain-of-thought parser'
 Assert-Aih ($source -notmatch '(?i)invoke.*model|reviewer.*classifier|llm.*call') 'policy introduces no mandatory model classifier call'
 Assert-Aih ($source -notmatch [regex]::Escape('C:\AI-Harness')) 'policy introduces no hardcoded install root'
 Assert-Aih ($source -notmatch '(?i)embedding|vector search|persistent memory|knowledge graph') 'policy stays within the task-local v0 boundary'
 Assert-Aih ($script:pass -ge 70) 'Epistemic Policy suite contains at least 70 deterministic assertions'
 Write-Host "RESULT: $script:pass Epistemic Policy assertions passed."
}finally{$env:DSH_HOME=$oldHome;Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue}
