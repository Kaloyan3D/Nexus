[CmdletBinding()]param([string]$InstallRoot='C:\AI-Harness')
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Routing.ps1')
. (Join-Path $InstallRoot 'scripts/TaskController.ps1')
. (Join-Path $InstallRoot 'scripts/CodexReview.ps1')
. (Join-Path $InstallRoot 'scripts/Telemetry.ps1')
. (Join-Path $InstallRoot 'scripts/ControlRoom.ps1')
. (Join-Path $InstallRoot 'tests/TestHelpers.ps1')

$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not$Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}
function New-Fixture([string]$Name){$path=Join-Path ([IO.Path]::GetTempPath()) ("aih-$Name-"+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $path|Out-Null;$path}
function With-AihProfile {param([string]$Id,[scriptblock]$Body)$saved=$env:DSH_AIH_PROFILE;try{$env:DSH_AIH_PROFILE=$Id;& $Body}finally{if($null-eq$saved){Remove-Item Env:DSH_AIH_PROFILE -ErrorAction SilentlyContinue}else{$env:DSH_AIH_PROFILE=$saved}}}

$layout=Get-AihLayout $InstallRoot;$policy=Get-AihRoutingPolicy $layout.RoutingPolicy
Assert-Aih ([int]$policy.version -eq 3) 'routing policy v3 loads (Phase 2 generalized classes)'
Assert-Aih ($policy.defaultExecutionClass -eq 'engineer_normal') 'default execution class is engineer_normal'
Assert-Aih ($policy.executionClassAliases.deepseek_normal -eq 'engineer_normal') 'deepseek_normal alias maps to engineer_normal'
Assert-Aih ($policy.executionClassAliases.deepseek_deep -eq 'engineer_deep') 'deepseek_deep alias maps to engineer_deep'
Assert-Aih ($policy.executionClassAliases.codex_review -eq 'reviewer') 'codex_review alias maps to reviewer'
Assert-Aih ($policy.executionClassAliases.codex_solve -eq 'solver') 'codex_solve alias maps to solver'
Assert-Aih ($policy.executionClasses.engineer_normal.role -eq 'primaryEngineer') 'engineer_normal maps to the primaryEngineer role'
Assert-Aih ($policy.executionClasses.engineer_deep.role -eq 'deepEngineer') 'engineer_deep maps to the deepEngineer role'
Assert-Aih ($policy.executionClasses.reviewer.role -eq 'reviewer' -and -not $policy.executionClasses.reviewer.writable) 'reviewer role is read-only by default'
Assert-Aih ($policy.executionClasses.solver.requiresUserApproval -eq $true) 'solver requires explicit user approval'
$profiles=Get-AihEngineeringProfiles (Join-Path (Split-Path -Parent $layout.RoutingPolicy) 'engineering-profiles.json')
$registry=Get-AihModelRegistry (Join-Path (Split-Path -Parent $layout.RoutingPolicy) 'model-registry.json')
$defaultExpected=Resolve-AihExpectedProfileTargets -Policy $policy -Profiles $profiles -Registry $registry -Roles @('primaryEngineer','deepEngineer','reviewer','solver')
Assert-Aih (@($profiles.profiles|Where-Object id -eq 'deepseek-codex').Count -eq 1) 'DeepSeek + Codex profile is registered'
Assert-Aih (@($profiles.profiles|Where-Object id -eq 'glm-codex').Count -eq 1) 'GLM + Codex profile is registered'
Assert-Aih (@($registry.models|Where-Object id -eq 'glm-5.3-flash').Count -eq 1) 'GLM-5.3-Flash is registered'
Assert-Aih (@($registry.models|Where-Object id -eq 'glm-5.3').Count -eq 1) 'GLM-5.3 is registered'

# -- 1. DEFAULT PROFILE (DeepSeek + Codex), NORMAL ENGINEERING ------------
$normalRoot=New-Fixture engnormal
try{
 $d=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $normalRoot 'task-normal' 'aih-engineering'
 Assert-Aih ($d.executionClass -eq 'engineer_normal') '1: normal task routes to engineer_normal'
 Assert-Aih ($d.role -eq 'primaryEngineer') '1: engineer_normal maps to role primaryEngineer'
 Assert-Aih ($d.profile -eq $defaultExpected.Profile.Id -and $d.profileDisplayName -eq $defaultExpected.Profile.DisplayName) '1: active profile comes from current settings/preset resolution'
 Assert-Aih ($d.provider -eq $defaultExpected.Targets.primaryEngineer.Provider -and $d.model -eq $defaultExpected.Targets.primaryEngineer.Model -and $d.reasoning -eq $defaultExpected.Targets.primaryEngineer.Reasoning) '1: primaryEngineer resolves through the active profile'
 Assert-Aih ($d.modelDisplayName -eq $defaultExpected.Targets.primaryEngineer.ModelDisplayName -and $d.vendor -eq $defaultExpected.Targets.primaryEngineer.Vendor) '1: registry display name/vendor reported'
 Assert-Aih (-not $d.reviewRequired) '1: normal task does not require review'
 $task=New-AihTask $normalRoot 'implement ordinary change' @() @() 'normal'
 Assert-Aih ($task.executionClass -eq 'engineer_normal') '1: new task records canonical engineer_normal'
 $attempt=Start-AihTaskAttempt $normalRoot $task.taskId 'engineer_normal'
 Assert-Aih ($attempt.executionClass -eq 'engineer_normal') '1: attempt records canonical engineer_normal'
}finally{if(Test-Path $normalRoot){Remove-Item -LiteralPath $normalRoot -Recurse -Force}}

# -- 2. DEFAULT PROFILE, DEEP EXECUTION -----------------------------------
$deepRoot=New-Fixture engdeep
try{
 $d=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $deepRoot 'task-deep' 'aih-engineering' '' 'engineer_deep'
 Assert-Aih ($d.executionClass -eq 'engineer_deep') '2: forced engineer_deep routes to engineer_deep'
 Assert-Aih ($d.role -eq 'deepEngineer') '2: engineer_deep maps to role deepEngineer'
 Assert-Aih ($d.provider -eq $defaultExpected.Targets.deepEngineer.Provider -and $d.model -eq $defaultExpected.Targets.deepEngineer.Model -and $d.reasoning -eq $defaultExpected.Targets.deepEngineer.Reasoning) '2: deepEngineer resolves through the active profile'
}finally{if(Test-Path $deepRoot){Remove-Item -LiteralPath $deepRoot -Recurse -Force}}

# -- 3. CRITICAL WORK STILL MARKS REVIEW REQUIRED -------------------------
$critRoot=New-Fixture engcrit
try{
 $d=Invoke-AihRoutingDecision 'design authentication architecture' $InstallRoot $layout.RoutingPolicy $critRoot 'task-crit' 'aih-engineering'
 Assert-Aih ($d.executionClass -eq 'engineer_deep') '3: critical boundary starts in engineer_deep'
 Assert-Aih ([bool]$d.reviewRequired) '3: critical work still marks review required'
 Assert-Aih ($d.role -eq 'deepEngineer') '3: critical work uses the deepEngineer role'
}finally{if(Test-Path $critRoot){Remove-Item -LiteralPath $critRoot -Recurse -Force}}

# -- 4. REPEATED IDENTICAL FAILURE: engineer_normal -> engineer_deep ------
$escRoot=New-Fixture engesc
try{
 $f1=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $escRoot 'task-esc' 'aih-engineering' '' '' 'attempt-failure' 'same test expected 1 actual 2'
 Assert-Aih ($f1.executionClass -eq 'engineer_normal') '4: first meaningful failure remains engineer_normal'
 $f2=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $escRoot 'task-esc' 'aih-engineering' '' '' 'attempt-failure' 'same test expected 9 actual 8'
 Assert-Aih ($f2.executionClass -eq 'engineer_deep') '4: repeated identical failure escalates engineer_normal -> engineer_deep'
 Assert-Aih ($f2.escalatedFrom -eq 'engineer_normal') '4: escalation records engineer_normal as origin'
 Assert-Aih ($f2.role -eq 'deepEngineer') '4: escalated execution uses the deepEngineer role'
}finally{if(Test-Path $escRoot){Remove-Item -LiteralPath $escRoot -Recurse -Force}}

# -- 5. FURTHER ESCALATION: engineer_deep -> reviewer ---------------------
$revRoot=New-Fixture engrev
try{
 Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $revRoot 'task-rev' 'aih-engineering' '' '' 'attempt-failure' 'same esc expected 1 actual 2'|Out-Null
 Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $revRoot 'task-rev' 'aih-engineering' '' '' 'attempt-failure' 'same esc expected 3 actual 4'|Out-Null
 Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $revRoot 'task-rev' 'aih-engineering' '' '' 'verification-failure' 'same esc expected 5 actual 6'|Out-Null
 $d=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $revRoot 'task-rev' 'aih-engineering' '' '' 'verification-failure' 'same esc expected 7 actual 8'
 Assert-Aih ($d.executionClass -eq 'reviewer') '5: repeated deep failure may escalate engineer_deep -> reviewer'
 Assert-Aih ($d.role -eq 'reviewer') '5: review execution uses the reviewer role'
 Assert-Aih (-not $d.writable) '5: reviewer execution is read-only'
 $d2=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $revRoot 'task-rev' 'aih-engineering' '' '' 'verification-failure' 'same esc expected 7 actual 8'
 Assert-Aih ($d2.executionClass -eq 'reviewer') '5: reviewer state persists for the bounded review turn'
}finally{if(Test-Path $revRoot){Remove-Item -LiteralPath $revRoot -Recurse -Force}}

# -- 6. REVIEW FINDINGS RETURN TO THE DEEP ENGINEER -----------------------
$repairRoot=New-Fixture engrepair
try{
 $d=Invoke-AihRoutingDecision 'audit the isolation boundary' $InstallRoot $layout.RoutingPolicy $repairRoot 'task-repair' 'aih-engineering' -ReviewRequested
 Assert-Aih ($d.executionClass -eq 'reviewer') '6: explicit review request selects reviewer'
 $r=Invoke-AihRoutingDecision 'implement bounded review finding' $InstallRoot $layout.RoutingPolicy $repairRoot 'task-repair' 'aih-engineering' '' '' 'review-findings'
 Assert-Aih ($r.executionClass -eq 'engineer_deep') '6: review findings route to engineer_deep repair'
 Assert-Aih ($r.role -eq 'deepEngineer') '6: repair uses the deepEngineer role'
 Assert-Aih ($r.escalatedFrom -eq 'reviewer') '6: repair records the reviewer as origin (reviewer does not remain the parent)'
 Assert-Aih ($r.provider -eq $defaultExpected.Targets.deepEngineer.Provider -and $r.model -eq $defaultExpected.Targets.deepEngineer.Model -and $r.reasoning -eq $defaultExpected.Targets.deepEngineer.Reasoning) '6: repair resolves through the active profile deepEngineer role'
}finally{if(Test-Path $repairRoot){Remove-Item -LiteralPath $repairRoot -Recurse -Force}}

# -- 7. REVIEWER CANNOT GAIN GLOBAL COMPLETION AUTHORITY ------------------
$authRoot=New-Fixture engauth
try{
 $task=New-AihTask $authRoot 'audit the isolation boundary' @('scope ok') @() 'critical' $null -ReviewRequested
 $decision=Invoke-AihRoutingDecision 'audit the isolation boundary' $InstallRoot $layout.RoutingPolicy $authRoot $task.taskId 'aih-engineering' -ReviewRequested
 Assert-Aih (-not $decision.completionAuthority) '7: review routing decision carries no completion authority'
 $packet=New-AihReviewPacket $authRoot $task.taskId 'audit the isolation boundary' @() 'diff: ok' @([pscustomobject]@{path='src/a.ts';content='const a=1'}) @() '' $policy
 $call=Register-AihCodexReviewCall $authRoot $task.taskId $packet
 Assert-Aih (-not $call.completionAuthority) '7: registered review call has no completion authority'
 $validated=Test-AihReviewResult ([pscustomobject]@{verdict='pass';findings=@()})
 Assert-Aih (-not $validated.completionAuthority) '7: validated review result has no completion authority'
 $incomplete=Test-AihTaskCompletion $authRoot $task.taskId
 Assert-Aih (-not $incomplete.complete) '7: task stays incomplete while review is outstanding'
 Assert-Aih ($incomplete.authority -eq 'deterministic-controller') '7: completion authority remains the deterministic controller'
}finally{if(Test-Path $authRoot){Remove-Item -LiteralPath $authRoot -Recurse -Force}}

# -- 8. SOLVER STILL REQUIRES EXPLICIT USER APPROVAL ----------------------
$solRoot=New-Fixture engsol
try{
 $blocked=$false;try{Invoke-AihRoutingDecision 'ordinary' $InstallRoot $layout.RoutingPolicy $solRoot 'task-sol' 'aih-engineering' '' 'solver'}catch{$blocked=$true}
 Assert-Aih $blocked '8: solver without explicit approval fails closed'
 $d=Invoke-AihRoutingDecision 'ordinary' $InstallRoot $layout.RoutingPolicy $solRoot 'task-sol' 'aih-engineering' '' 'solver' '' '' -UserApprovedCodexSolve
 Assert-Aih ($d.executionClass -eq 'solver' -and $d.writable) '8: solver with explicit approval is writable'
 Assert-Aih ($d.role -eq 'solver') '8: solver execution uses the solver role'
 Assert-Aih ($d.provider -eq $defaultExpected.Targets.solver.Provider -and $d.model -eq $defaultExpected.Targets.solver.Model -and $d.reasoning -eq $defaultExpected.Targets.solver.Reasoning) '8: solver resolves through the active profile solver role'
}finally{if(Test-Path $solRoot){Remove-Item -LiteralPath $solRoot -Recurse -Force}}

# -- 9/10/11. GLM + CODEX PROFILE -----------------------------------------
$glmRoot=New-Fixture glmp
try{
 With-AihProfile 'glm-codex' {
  # Phase 3.2.5: the expected role targets are DERIVED from the ACTIVE
  # profile (pinned here through the documented env override) + the model
  # registry, so the suite validates active-profile resolution and encodes
  # no model identity of its own.
  $glmExpected=Resolve-AihExpectedProfileTargets -Policy $policy -Profiles $profiles -Registry $registry
  $glmActive=$glmExpected.Profile
  Assert-Aih ([string]$glmActive.Id -eq 'glm-codex') '9: fixture pin resolves the GLM + Codex active profile'
  $glmNormal=$glmExpected.Targets.primaryEngineer
  $glmDeep=$glmExpected.Targets.deepEngineer
  $glmReviewer=$glmExpected.Targets.reviewer
  $n=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $glmRoot 'glm-normal' 'aih-engineering'
  Assert-Aih ($n.executionClass -eq 'engineer_normal' -and $n.role -eq 'primaryEngineer') '9: GLM profile normal routes engineer_normal -> primaryEngineer'
  Assert-Aih ($n.profile -eq $glmActive.Id -and $n.profileDisplayName -eq $glmActive.DisplayName) '9: active profile is GLM + Codex'
  Assert-Aih ($n.provider -eq $glmNormal.Provider -and $n.model -eq $glmNormal.Model -and $n.reasoning -eq $glmNormal.Reasoning) '9: primaryEngineer binds through the ACTIVE profile'
  Assert-Aih ($n.modelDisplayName -eq $glmNormal.ModelDisplayName -and $n.vendor -eq $glmNormal.Vendor) '9: registry display name/vendor reported'
  $g=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $glmRoot 'glm-deep' 'aih-engineering' '' 'engineer_deep'
  Assert-Aih ($g.role -eq 'deepEngineer' -and $g.profile -eq $glmActive.Id) '10: GLM deep execution uses the deepEngineer role of the active profile'
  Assert-Aih ($g.provider -eq $glmDeep.Provider -and $g.model -eq $glmDeep.Model -and $g.reasoning -eq $glmDeep.Reasoning) '10: GLM deep model binds through the ACTIVE profile deepEngineer role (no hardcoded model identity)'
  $r=Invoke-AihRoutingDecision 'audit the isolation boundary' $InstallRoot $layout.RoutingPolicy $glmRoot 'glm-review' 'aih-engineering' -ReviewRequested
  Assert-Aih ($r.executionClass -eq 'reviewer' -and $r.role -eq 'reviewer') '11: GLM profile review uses the reviewer role'
  Assert-Aih ($r.provider -eq $glmReviewer.Provider -and $r.model -eq $glmReviewer.Model -and $r.reasoning -eq $glmReviewer.Reasoning) '11: GLM profile reviewer binds through the ACTIVE profile'
 }
}finally{if(Test-Path $glmRoot){Remove-Item -LiteralPath $glmRoot -Recurse -Force}}

# settings.yaml engineering-profile key also selects the profile
$settingsRoot=New-Fixture setprof
try{
 $settingsPath=Join-Path $settingsRoot 'settings.yaml'
 [IO.File]::WriteAllText($settingsPath,"engineering-profile: glm-codex" + [char]13 + [char]10,[Text.UTF8Encoding]::new($false))
 $settingsExpected=Resolve-AihExpectedProfileTargets -Policy $policy -Profiles $profiles -Registry $registry -SettingsPath $settingsPath -Roles @('primaryEngineer')
 $d=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $settingsRoot 'set-task' 'aih-engineering' -SettingsPath $settingsPath
 Assert-Aih ($d.profile -eq $settingsExpected.Profile.Id -and $d.provider -eq $settingsExpected.Targets.primaryEngineer.Provider -and $d.model -eq $settingsExpected.Targets.primaryEngineer.Model -and $d.reasoning -eq $settingsExpected.Targets.primaryEngineer.Reasoning) 'settings engineering-profile key drives the active primaryEngineer target'
}finally{if(Test-Path $settingsRoot){Remove-Item -LiteralPath $settingsRoot -Recurse -Force}}

# -- 12. SWITCHING PROFILE DOES NOT CHANGE TASK LIFECYCLE SEMANTICS -------
$lifeRoot=New-Fixture life
try{
 $savedProfile=$env:DSH_AIH_PROFILE
 try{
  $env:DSH_AIH_PROFILE='deepseek-codex'
  $taskA=New-AihTask $lifeRoot 'implement ordinary change' @('criterion one') @() 'normal'
  $attA=Start-AihTaskAttempt $lifeRoot $taskA.taskId 'engineer_normal'
  $evA=[ordered]@{acceptanceCriteria=@([ordered]@{criterion='criterion one';status='met';evidence='test result A'});verification=@([ordered]@{name='typecheck';status='PASS';evidence='tsc'});scopePass=$true}
  Set-AihTaskEvidence $lifeRoot $taskA.taskId $evA
  $doneA=Test-AihTaskCompletion $lifeRoot $taskA.taskId
  $env:DSH_AIH_PROFILE='glm-codex'
  $taskB=New-AihTask $lifeRoot 'implement ordinary change' @('criterion one') @() 'normal'
  $attB=Start-AihTaskAttempt $lifeRoot $taskB.taskId 'engineer_normal'
  $evB=[ordered]@{acceptanceCriteria=@([ordered]@{criterion='criterion one';status='met';evidence='test result B'});verification=@([ordered]@{name='typecheck';status='PASS';evidence='tsc'});scopePass=$true}
  Set-AihTaskEvidence $lifeRoot $taskB.taskId $evB
  $doneB=Test-AihTaskCompletion $lifeRoot $taskB.taskId
 }finally{if($null-eq$savedProfile){Remove-Item Env:DSH_AIH_PROFILE -ErrorAction SilentlyContinue}else{$env:DSH_AIH_PROFILE=$savedProfile}}
 Assert-Aih ($taskA.taskId -match '^TASK-\d{4}$' -and $taskB.taskId -match '^TASK-\d{4}$') '12: task identity semantics unchanged across profiles'
 Assert-Aih ($attA.sequence -eq 1 -and $attB.sequence -eq 1 -and $attA.executionClass -eq 'engineer_normal' -and $attB.executionClass -eq 'engineer_normal') '12: attempt semantics unchanged across profiles'
 Assert-Aih ($doneA.complete -and $doneB.complete) '12: deterministic completion works under both profiles'
 Assert-Aih ($doneA.authority -eq 'deterministic-controller' -and $doneB.authority -eq 'deterministic-controller') '12: completion authority unchanged across profiles'
 Assert-Aih ($taskA.completionAuthority -eq 'controller' -and $taskB.completionAuthority -eq 'controller') '12: gate/completion authority field unchanged'
}finally{if(Test-Path $lifeRoot){Remove-Item -LiteralPath $lifeRoot -Recurse -Force}}

# -- 13/14/15. LEGACY RECORDS REMAIN READABLE -----------------------------
$legacyRoot=New-Fixture legacy
try{
 Assert-Aih ((ConvertTo-AihExecutionClass 'deepseek_normal' $policy) -eq 'engineer_normal') '13: deepseek_normal converts to engineer_normal'
 Assert-Aih ((ConvertTo-AihExecutionClass 'deepseek_deep' $policy) -eq 'engineer_deep') '14: deepseek_deep converts to engineer_deep'
 Assert-Aih ((ConvertTo-AihExecutionClass 'codex_review' $policy) -eq 'reviewer') '15: codex_review converts to reviewer'
 Assert-Aih ((ConvertTo-AihExecutionClass 'codex_solve' $policy) -eq 'solver') '15: codex_solve converts to solver'
 $statePath=Get-AihRoutingStatePath $legacyRoot $InstallRoot 'legacy-task' 'aih-engineering'
 New-Item -ItemType Directory -Force -Path (Split-Path -Parent $statePath)|Out-Null
 $legacySig=Get-AihFailureSignature 'same legacy expected 1 actual 2'
 Write-AihAtomicJson $statePath ([ordered]@{taskId='legacy-task';workspace=$InstallRoot;preset='aih-engineering';executionClass='deepseek_normal';selectedTier=3;risk='normal';reviewRequired=$false;lastFailureSignature=$legacySig;sameFailureCount=1;updatedAtUtc=[DateTime]::UtcNow.ToString('o')})
 $legacy=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $legacyRoot 'legacy-task' 'aih-engineering' '' '' 'attempt-failure' 'same legacy expected 1 actual 2'
 Assert-Aih ($legacy.executionClass -eq 'engineer_deep') '13: legacy deepseek_normal state still escalates to engineer_deep'
 Assert-Aih ($legacy.escalatedFrom -eq 'engineer_normal') '13: legacy escalation records the canonical origin'
 $legacyTask=New-AihTask $legacyRoot 'legacy review task' @('criterion x') @() 'normal' $null -ExecutionClassOverride 'codex_review'
 Assert-Aih ((ConvertTo-AihCanonicalExecutionClass ([string]$legacyTask.executionClassOverride)) -eq 'reviewer') '15: legacy codex_review override normalizes to reviewer'
 $legacyAttempt=Start-AihTaskAttempt $legacyRoot $legacyTask.taskId 'deepseek_normal'
 Assert-Aih ($legacyAttempt.executionClass -eq 'engineer_normal') '13: legacy deepseek_normal attempt input normalizes to engineer_normal'
 $taskAfter=Get-AihTask $legacyRoot $legacyTask.taskId
 Assert-Aih ($taskAfter.executionClass -eq 'engineer_normal') '13: task ledger stores the canonical class'
 $evL=[ordered]@{acceptanceCriteria=@([ordered]@{criterion='criterion x';status='met';evidence='ok'});verification=@([ordered]@{name='typecheck';status='PASS';evidence='tsc'});scopePass=$true}
 Set-AihTaskEvidence $legacyRoot $legacyTask.taskId $evL
 Assert-Aih (-not (Test-AihTaskCompletion $legacyRoot $legacyTask.taskId).complete) '15: legacy codex_review override still blocks completion without review'
 Assert-Aih ((Test-AihTaskCompletion $legacyRoot $legacyTask.taskId -CodexReviewPassed).complete) '15: legacy codex_review override completes after a passing review'
}finally{if(Test-Path $legacyRoot){Remove-Item -LiteralPath $legacyRoot -Recurse -Force}}

# -- 16. RECORDS CARRY EXECUTION CLASS / ROLE / PROFILE / PROVIDER / MODEL --
$recordRoot=New-Fixture records
try{
 $d=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $recordRoot 'record-task' 'aih-engineering'
 foreach($field in @('executionClass','role','profile','profileDisplayName','provider','model','modelDisplayName','reasoning')){Assert-Aih ($null-ne $d.PSObject.Properties[$field]) "16: routing record carries field $field"}
 Assert-Aih ($d.executionClass -eq 'engineer_normal' -and $d.role -eq 'primaryEngineer' -and $d.provider -eq 'flash-high-direct' -and $d.model -eq 'deepseek-v4-flash') '16: record reports actual execution class, role, provider, model'
 $statePath=Get-AihRoutingStatePath $recordRoot $InstallRoot 'record-task' 'aih-engineering'
 $state=Read-AihRoutingState $statePath
 Assert-Aih ($state.executionClass -eq 'engineer_normal' -and $state.role -eq 'primaryEngineer' -and $state.profile -eq 'deepseek-codex' -and $state.provider -eq 'flash-high-direct') '16: persisted routing state reports class/role/profile/provider'
}finally{if(Test-Path $recordRoot){Remove-Item -LiteralPath $recordRoot -Recurse -Force}}

# -- 17. DEEPSEEK-ONLY FAILS CLOSED WHEN REVIEW IS UNAVAILABLE ------------
$dsRoot=New-Fixture deepseekonly
try{
 $blocked=$false;try{Invoke-AihRoutingDecision 'audit the boundary' $InstallRoot $layout.RoutingPolicy $dsRoot 'ds-review' 'aih-deepseek' -ReviewRequested}catch{$blocked=$true}
 Assert-Aih $blocked '17: DeepSeek-only preset fails closed on explicit review'
 $blocked=$false;try{Invoke-AihRoutingDecision 'ordinary' $InstallRoot $layout.RoutingPolicy $dsRoot 'ds-user' 'aih-deepseek' '' '' 'user-codex'}catch{$blocked=$true}
 Assert-Aih $blocked '17: DeepSeek-only preset fails closed on user-codex signal'
 With-AihProfile 'glm-codex' {
  $d=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $dsRoot 'ds-lock' 'aih-deepseek'
  Assert-Aih ($d.profile -eq 'deepseek-codex' -and $d.model -eq 'deepseek-v4-flash') '17: DeepSeek-only preset is profile-locked (override ignored)'
 }
 Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $dsRoot 'ds-esc' 'aih-deepseek' '' '' 'attempt-failure' 'same ds expected 1 actual 2'|Out-Null
 $d2=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $dsRoot 'ds-esc' 'aih-deepseek' '' '' 'attempt-failure' 'same ds expected 3 actual 4'
 Assert-Aih ($d2.executionClass -eq 'engineer_deep') '17: DeepSeek-only repeated failure stays in engineer_deep (no reviewer fallback)'
}finally{if(Test-Path $dsRoot){Remove-Item -LiteralPath $dsRoot -Recurse -Force}}

# -- 18. VERIFICATION / ATTEMPT / EVIDENCE BEHAVIOR UNCHANGED -------------
$verifyRoot=New-Fixture verif
try{
 $task=New-AihTask $verifyRoot 'implement ordinary change' @('c1','c2') @() 'normal'
 Start-AihTaskAttempt $verifyRoot $task.taskId 'engineer_normal'|Out-Null
 Add-AihTaskFailure $verifyRoot $task.taskId 'sig-x' 'evidence text'
 $mid=Get-AihTask $verifyRoot $task.taskId
 Assert-Aih ([int]$mid.attempt -eq 1 -and @($mid.failureSignatures).Count -eq 1) '18: attempt and failure ledger unchanged'
 $ev=[ordered]@{acceptanceCriteria=@([ordered]@{criterion='c1';status='met';evidence='e1'},[ordered]@{criterion='c2';status='met';evidence='e2'});verification=@([ordered]@{name='lint';status='PASS';evidence='eslint'});scopePass=$true}
 Set-AihTaskEvidence $verifyRoot $task.taskId $ev|Out-Null
 $afterEv=Get-AihTask $verifyRoot $task.taskId
 Assert-Aih (@($afterEv.verification.outcomes|Where-Object status -ne 'PASS').Count -eq 0) '18: evidence semantics unchanged'
 Assert-Aih ((Test-AihTaskCompletion $verifyRoot $task.taskId).complete) '18: deterministic completion unchanged'
}finally{if(Test-Path $verifyRoot){Remove-Item -LiteralPath $verifyRoot -Recurse -Force}}

# -- 19. SUBAGENT / DELEGATION CONFIGURATION IS UNTOUCHED -----------------
$delegationPath=Join-Path $InstallRoot 'config/delegation-block.yml'
$delegation=Get-Content -Raw -Encoding UTF8 -LiteralPath $delegationPath
Assert-Aih ($delegation -match 'toolName: deepseek_normal') '19: deepseek_normal subagent tool registration unchanged (compat alias)'
Assert-Aih ($delegation -match 'toolName: deepseek_deep') '19: deepseek_deep subagent tool registration unchanged (compat alias)'
Assert-Aih ($delegation -match 'tool-subagent-codex[\s\S]*?disabled: true') '19: Codex subagent remains disabled by default'
$engPreset=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'data/.agent-presets/aih-engineering/agent.cordis.yml')
Assert-Aih ($engPreset -match '- id: tool-subagent-codex[\s\S]*?disabled: true') '19: engineering preset keeps the Codex subagent disabled'
Assert-Aih ($engPreset -match '- id: aih-engineering-isolation') '19: engineering preset keeps its isolation plugin'
Assert-Aih ($engPreset -match '- id: aih-controller') '19: engineering preset keeps the controller bridge'

# -- 20. DEFAULT BEHAVIOR AFTER MIGRATION IS FUNCTIONALLY EQUIVALENT ------
$equivRoot=New-Fixture equiv
try{
 $d=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $equivRoot 'eq-normal' 'aih-engineering'
 Assert-Aih ($d.provider -eq 'flash-high-direct' -and $d.model -eq 'deepseek-v4-flash' -and $d.reasoning -eq 'high') '20: normal execution equivalent (DeepSeek V4 Flash HIGH)'
 $dd=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $equivRoot 'eq-deep' 'aih-engineering' '' 'engineer_deep'
 Assert-Aih ($dd.provider -eq 'flash-max-direct' -and $dd.model -eq 'deepseek-v4-flash' -and $dd.reasoning -eq 'max') '20: deep execution equivalent (DeepSeek V4 Flash MAX)'
 $r=Invoke-AihRoutingDecision 'audit the boundary' $InstallRoot $layout.RoutingPolicy $equivRoot 'eq-review' 'aih-engineering' -ReviewRequested
 Assert-Aih ($r.provider -eq 'sol-local' -and $r.model -eq 'gpt-5.6-sol' -and $r.reasoning -eq 'medium' -and -not $r.writable) '20: review execution equivalent (Codex, read-only, medium)'
 # Hermetic: the mode resolves the preferred profile from the settings key
 # when no env override is present — an operator who switches profiles (Phase
 # 2.1 editor / composer selector) must not flip this suite. Pin the
 # migration default via the documented top-priority env override.
 With-AihProfile 'deepseek-codex' {
  $mode=Get-AihControlRoomMode $policy 'aih-engineering' (Join-Path (Split-Path -Parent $layout.RoutingPolicy) 'engineering-profiles.json') $layout.Settings
  Assert-Aih ($mode.Profile -eq 'deepseek-codex' -and $mode.ProfileDisplayName -eq 'DeepSeek + Codex') '20: Control Room reports the preferred profile'
  Assert-Aih ($mode.Provider -eq 'flash-max-direct' -and $mode.Model -eq 'deepseek-v4-flash') '20: Control Room preferred root executor unchanged'
 }
}finally{if(Test-Path $equivRoot){Remove-Item -LiteralPath $equivRoot -Recurse -Force}}

Write-Host "RESULT: $passed Phase-2 engineering-profile assertions passed."
