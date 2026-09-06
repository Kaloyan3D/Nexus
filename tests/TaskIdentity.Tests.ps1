[CmdletBinding()]param([string]$InstallRoot= (Split-Path -Parent $PSScriptRoot))
# Platform-aware child host: Windows keeps powershell.exe; POSIX uses the pinned Nexus pwsh.
if (-not (Get-Command Test-AihIsWindows -ErrorAction SilentlyContinue)) { . (Join-Path $InstallRoot 'scripts/Platform.ps1') }; $aihPsHost = Get-AihPowerShellHost -InstallRoot $InstallRoot
# TASK-0005: controller identity hardening - deterministic PowerShell-plane
# regression suite.
#
# Covers:
#   Part 1  immutable taskInstanceId on every new task (never reused)
#   Part 3  hardened display-sequence allocation (nextSequence is a hint)
#   Part 4  existing run directories are never overwritten
#   Part 5  Test-AihTaskIdentity contract (exists/instanceMatches; malformed
#           ledger THROWS instead of reporting the task missing)
#   Part 6  fail-closed mutation guards on the lifecycle boundaries
#   Part 14 routing state keyed by taskInstanceId for instance-aware tasks
#   Part 15 routing decision records carry taskInstanceId
#   Part 16 routing requests are instance-guarded (fail closed)
#   Part 20 legacy records stay readable
#   Part 23 generation-collision regression (reviewer records of generation A
#           never influence generation B; Phase 3.2.5: the expected deep and
#           reviewer targets are DERIVED from the ACTIVE Engineering Profile
#           the fixture selects, never hardcoded)
#   Part 25 sequence regression (nextSequence=4 with TASK-0004/0005 surviving
#           allocates TASK-0006, never overwrites either run)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Routing.ps1')
. (Join-Path $InstallRoot 'scripts/TaskController.ps1')
. (Join-Path $InstallRoot 'tests/TestHelpers.ps1')

$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not$Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}
function New-Fixture([string]$Name){$path=Join-Path ([IO.Path]::GetTempPath()) ("aih-identity-$Name-"+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $path|Out-Null;$path}
$layout=Get-AihLayout $InstallRoot

# == 1. IMMUTABLE INSTANCE IDENTITY (Part 1) ==================================
$root1=New-Fixture immutable
try{
 $a=New-AihTask $root1 'generation A of the work'
 Assert-Aih ($a.taskInstanceId -match '^task_[0-9a-f]{32}$') 'new task carries taskInstanceId task_<32 hex>'
 $b=New-AihTask $root1 'generation B of the work'
 Assert-Aih ($a.taskInstanceId -ne $b.taskInstanceId) 'two tasks never share a taskInstanceId'
 Assert-Aih ($a.taskId -ne $b.taskId) 'normal allocation still advances the display sequence'
 $manifest=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path (Join-Path (Join-Path $root1 '.ai-harness/runs') $a.taskId) 'manifest.json') | ConvertFrom-Json
 Assert-Aih ([string]$manifest.taskInstanceId -eq [string]$a.taskInstanceId) 'run manifest carries the same taskInstanceId as the ledger'
}catch{throw}finally{if(Test-Path $root1){Remove-Item -LiteralPath $root1 -Recurse -Force}}

# == 2. SEQUENCE HARDENING (Parts 3/4/25) =====================================
$root2=New-Fixture sequence
try{
 $state=Join-Path $root2 '.ai-harness/state';$runs=Join-Path $root2 '.ai-harness/runs'
 New-Item -ItemType Directory -Force -Path $state,$runs | Out-Null
 Write-AihAtomicJson (Join-Path $state 'tasks.json') ([ordered]@{schemaVersion=1;nextSequence=4;tasks=@()})
 foreach($id in @('TASK-0004','TASK-0005')){
  New-Item -ItemType Directory -Force -Path (Join-Path $runs $id) | Out-Null
  Write-AihAtomicJson (Join-Path (Join-Path $runs $id) 'manifest.json') ([ordered]@{taskId=$id;taskInstanceId=('task_'+[guid]::NewGuid().ToString('N'));description='surviving generation'})
 }
 $survivorBefore=[IO.File]::ReadAllText((Join-Path (Join-Path $runs 'TASK-0004') 'manifest.json'),[Text.UTF8Encoding]::new($false))
 $t=New-AihTask $root2 'fresh engineering work'
 Assert-Aih ($t.taskId -eq 'TASK-0006') 'nextSequence=4 with TASK-0004/0005 surviving allocates TASK-0006'
 $survivorAfter=[IO.File]::ReadAllText((Join-Path (Join-Path $runs 'TASK-0004') 'manifest.json'),[Text.UTF8Encoding]::new($false))
 Assert-Aih ($survivorBefore -eq $survivorAfter) 'surviving TASK-0004 manifest is untouched'
 Assert-Aih (Test-Path (Join-Path $runs 'TASK-0005')) 'surviving TASK-0005 run is untouched'
 $root2b=New-Fixture sequenceledger
 try{
  $null=New-AihTask $root2b 'one';$null=New-AihTask $root2b 'two'
  $ledgerPath=Join-Path $root2b '.ai-harness/state/tasks.json'
  $doc=Get-Content -Raw -LiteralPath $ledgerPath|ConvertFrom-Json
  $doc.nextSequence=1
  Write-AihAtomicJson $ledgerPath $doc
  $next=New-AihTask $root2b 'regressed next'
  Assert-Aih ($next.taskId -eq 'TASK-0003') 'regressed nextSequence never re-allocates a ledger taskId'
 }finally{if(Test-Path $root2b){Remove-Item -LiteralPath $root2b -Recurse -Force}}
}catch{throw}finally{if(Test-Path $root2){Remove-Item -LiteralPath $root2 -Recurse -Force}}

# == 3. IDENTITY LOOKUP CONTRACT (Part 5) =====================================
$root3=New-Fixture lookup
try{
 $t=New-AihTask $root3 'identity target'
 $r1=Test-AihTaskIdentity $root3 $t.taskId -TaskInstanceId ([string]$t.taskInstanceId)
 Assert-Aih ([bool]$r1.exists -and [bool]$r1.instanceMatches) 'exact instance lookup matches (exists=true, instanceMatches=true)'
 Assert-Aih ([string]$r1.taskInstanceId -eq [string]$t.taskInstanceId) 'lookup returns the authoritative taskInstanceId'
 $r2=Test-AihTaskIdentity $root3 'TASK-9999'
 Assert-Aih ((-not [bool]$r2.exists) -and ($null -eq $r2.taskInstanceId)) 'missing task reports exists=false (and nothing else)'
 $foreign=('task_f'+('0'*31))
 $r3=Test-AihTaskIdentity $root3 $t.taskId -TaskInstanceId $foreign
 Assert-Aih ([bool]$r3.exists -and (-not [bool]$r3.instanceMatches)) 'same display id with a foreign instance reports instanceMatches=false'
 $r4=Test-AihTaskIdentity $root3 $t.taskId
 Assert-Aih ([bool]$r4.exists -and $null -eq $r4.instanceMatches) 'no expected instance leaves instanceMatches indeterminate'
 Assert-Aih (Test-AihTaskExists $root3 $t.taskId) 'Test-AihTaskExists true for a real task'
 Assert-Aih (-not (Test-AihTaskExists $root3 'TASK-9999')) 'Test-AihTaskExists false only for a verified-absent task'
 $ledgerPath=Join-Path $root3 '.ai-harness/state/tasks.json'
 $validLedger=[IO.File]::ReadAllText($ledgerPath,[Text.UTF8Encoding]::new($false))
 Set-Content -LiteralPath $ledgerPath -Value '{ this is not json' -Encoding UTF8
 $threw=$false;try{Test-AihTaskIdentity $root3 $t.taskId | Out-Null}catch{$threw=$true}
 Assert-Aih $threw 'malformed ledger THROWS instead of reporting the task missing'
 $threw=$false;try{Test-AihTaskExists $root3 $t.taskId | Out-Null}catch{$threw=$true}
 Assert-Aih $threw 'existence probe also fails closed on a malformed ledger'
 Write-AihAtomicText $ledgerPath $validLedger
 $ok=Test-AihTaskIdentity $root3 $t.taskId
 Assert-Aih ([bool]$ok.exists) 'identity lookup works again after the ledger is restored'
}catch{throw}finally{if(Test-Path $root3){Remove-Item -LiteralPath $root3 -Recurse -Force}}

# == 4. MUTATION GUARDS (Part 6) ==============================================
$root4=New-Fixture mutation
try{
 $t=New-AihTask $root4 'guarded task'
 $instance=[string]$t.taskInstanceId
 $foreign=('task_e'+('0'*31))
 $mismatch='identity mismatch'
 $threw=$false;try{Set-AihTaskReviewRequested $root4 $t.taskId -TaskInstanceId $foreign}catch{if($_.Exception.Message -notmatch $mismatch){throw};$threw=$true}
 Assert-Aih $threw 'set-review-requested fails closed on a foreign taskInstanceId'
 $threw=$false;try{Start-AihTaskAttempt $root4 $t.taskId 'engineer_normal' -TaskInstanceId $foreign}catch{if($_.Exception.Message -notmatch $mismatch){throw};$threw=$true}
 Assert-Aih $threw 'begin-attempt fails closed on a foreign taskInstanceId'
 $null=Start-AihTaskAttempt $root4 $t.taskId 'engineer_normal' -TaskInstanceId $instance
 $after=Get-AihTask $root4 $t.taskId
 Assert-Aih ([int]$after.attempt -eq 1) 'begin-attempt with the exact instance succeeds'
 $attempts=Get-Content -Encoding UTF8 -LiteralPath (Join-Path (Join-Path (Join-Path $root4 '.ai-harness/runs') $t.taskId) 'attempts.jsonl')
 $attemptRecord=$attempts | Select-Object -Last 1 | ConvertFrom-Json
 Assert-Aih ([string]$attemptRecord.taskInstanceId -eq $instance) 'attempt records carry the taskInstanceId'
 $threw=$false;try{Add-AihAttemptEvent $root4 $t.taskId 'verifying' -TaskInstanceId $foreign}catch{if($_.Exception.Message -notmatch $mismatch){throw};$threw=$true}
 Assert-Aih $threw 'attempt-event fails closed on a foreign taskInstanceId'
 $null=Add-AihAttemptEvent $root4 $t.taskId 'verifying' -TaskInstanceId $instance
 $null=Set-AihTaskEvidence $root4 $t.taskId ([ordered]@{acceptanceCriteria=@();verification=@([ordered]@{name='probe';status='PASS'});scopePass=$true}) -TaskInstanceId $instance
 Assert-Aih ([string](Get-AihTask $root4 $t.taskId).status -eq 'verifying') 'evidence with the exact instance succeeds'
 $threw=$false;try{Add-AihTaskFailure $root4 $t.taskId 'sig' 'evidence' -TaskInstanceId $foreign}catch{if($_.Exception.Message -notmatch $mismatch){throw};$threw=$true}
 Assert-Aih $threw 'failure fails closed on a foreign taskInstanceId'
 $threw=$false;try{Test-AihTaskCompletion $root4 $t.taskId -TaskInstanceId $foreign|Out-Null}catch{if($_.Exception.Message -notmatch $mismatch){throw};$threw=$true}
 Assert-Aih $threw 'complete fails closed on a foreign taskInstanceId'
 $legacy=New-AihTask $root4 'legacy-generation task'
 $ledgerPath=Join-Path $root4 '.ai-harness/state/tasks.json'
 $doc=Get-Content -Raw -LiteralPath $ledgerPath|ConvertFrom-Json
 for($i=0;$i -lt @($doc.tasks).Count;$i++){ if($doc.tasks[$i].taskId -eq $legacy.taskId){ $doc.tasks[$i].PSObject.Properties.Remove('taskInstanceId') } }
 Write-AihAtomicJson $ledgerPath $doc
 $threw=$false;try{Set-AihTaskReviewRequested $root4 $legacy.taskId -TaskInstanceId $foreign}catch{if($_.Exception.Message -notmatch $mismatch){throw};$threw=$true}
 Assert-Aih $threw 'a legacy task without taskInstanceId never matches a claimed instance (fail closed)'
 $stillLegacy=Get-AihTask $root4 $legacy.taskId
 Assert-Aih ($null -eq $stillLegacy.PSObject.Properties['taskInstanceId'] -or [string]::IsNullOrWhiteSpace([string]$stillLegacy.taskInstanceId)) 'legacy task remains readable without a taskInstanceId (Part 20)'
}catch{throw}finally{if(Test-Path $root4){Remove-Item -LiteralPath $root4 -Recurse -Force}}

# == 5. TASK.PS1 test-task CLI (bridge boundary of Part 5) ====================
$root5=New-Fixture cli
try{
 $taskJson=& $aihPsHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $layout.Scripts 'Task.ps1') -Action create-task -Workspace $root5 -Description 'cli identity probe'
 $task=$taskJson|ConvertFrom-Json
 Assert-Aih ($task.taskInstanceId -match '^task_[0-9a-f]{32}$') 'Task.ps1 create-task returns taskInstanceId'
 $hitJson=& $aihPsHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $layout.Scripts 'Task.ps1') -Action test-task -Workspace $root5 -TaskId $task.taskId -TaskInstanceId $task.taskInstanceId
 $hit=$hitJson|ConvertFrom-Json
 Assert-Aih ([bool]$hit.exists -and [bool]$hit.instanceMatches) 'test-task reports exists=true + instanceMatches=true for the exact instance'
 $missJson=& $aihPsHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $layout.Scripts 'Task.ps1') -Action test-task -Workspace $root5 -TaskId 'TASK-9999'
 $miss=$missJson|ConvertFrom-Json
 Assert-Aih (-not [bool]$miss.exists) 'test-task reports exists=false for a verified-absent task'
 Set-Content -LiteralPath (Join-Path $root5 '.ai-harness/state/tasks.json') -Value 'not json at all' -Encoding UTF8
 $previousErrorAction=$ErrorActionPreference
 try{
  $ErrorActionPreference='Continue'
  $null=& $aihPsHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $layout.Scripts 'Task.ps1') -Action test-task -Workspace $root5 -TaskId $task.taskId 2>$null
 }finally{ $ErrorActionPreference=$previousErrorAction }
 Assert-Aih ($LASTEXITCODE -ne 0) 'test-task exits non-zero on a malformed ledger (validation infrastructure failure)'
}catch{throw}finally{if(Test-Path $root5){Remove-Item -LiteralPath $root5 -Recurse -Force}}

# == 6. ROUTING STATE / DECISION IDENTITY (Parts 14/15/16) ====================
$root6=New-Fixture routing
try{
 $dataA=Join-Path $root6 'dataA';$dataB=Join-Path $root6 'dataB'
 $t=New-AihTask $root6 'routed task'
 $instance=[string]$t.taskInstanceId
 $d1=Invoke-AihRoutingDecision -Description 'implement ordinary change' -Workspace $root6 -PolicyPath $layout.RoutingPolicy -DataRoot $dataA -TaskId $t.taskId -Preset 'aih-engineering' -TaskInstanceId $instance
 Assert-Aih ([string]$d1.taskInstanceId -eq $instance) 'routing decision records carry the taskInstanceId'
 $pInst=Get-AihRoutingStatePath $dataA $root6 $t.taskId 'aih-engineering' $instance
 $pLegacy=Get-AihRoutingStatePath $dataA $root6 $t.taskId 'aih-engineering'
 Assert-Aih ($pInst -ne $pLegacy) 'instance-aware routing state uses a different file than the legacy taskId key'
 Assert-Aih ((Test-Path -LiteralPath $pInst) -and -not (Test-Path -LiteralPath $pLegacy)) 'only the instance-keyed state file was written'
 $state=Read-AihRoutingState $pInst
 Assert-Aih ([string]$state.taskInstanceId -eq $instance) 'routing state persists the taskInstanceId'
 $foreign=('task_d'+('0'*31))
 $threw=$false;try{Invoke-AihRoutingDecision -Description 'implement ordinary change' -Workspace $root6 -PolicyPath $layout.RoutingPolicy -DataRoot $dataB -TaskId $t.taskId -Preset 'aih-engineering' -TaskInstanceId $foreign|Out-Null}catch{$threw=$true}
 Assert-Aih $threw 'routing rejects a request whose taskInstanceId does not match the ledger'
 $threw=$false;try{Invoke-AihRoutingDecision -Description 'implement ordinary change' -Workspace $root6 -PolicyPath $layout.RoutingPolicy -DataRoot $dataB -TaskId 'TASK-9999' -Preset 'aih-engineering' -TaskInstanceId $foreign|Out-Null}catch{$threw=$true}
 Assert-Aih $threw 'routing rejects a request naming a task that does not exist'
}catch{throw}finally{if(Test-Path $root6){Remove-Item -LiteralPath $root6 -Recurse -Force}}

# == 7. GENERATION COLLISION (Part 23, data level) ============================
$root7=New-Fixture collision
try{
 $dataRoot=Join-Path $root7 'data'
 $glmSettings=Join-Path $root7 'settings.yaml'
 Set-Content -LiteralPath $glmSettings -Value 'engineering-profile: glm-codex' -Encoding UTF8
 # Phase 3.2.5: routing selects EXECUTION SEMANTICS (the deepEngineer role);
 # the model/provider/reasoning come from the ACTIVE Engineering Profile the
 # fixture selects through settings.yaml. The expected targets below are
 # DERIVED from that active profile via the production resolvers, so this
 # regression validates active-profile resolution and hardcodes no model
 # identity of its own.
 $policy7=Get-AihRoutingPolicy $layout.RoutingPolicy
 $profiles7=Get-AihEngineeringProfiles $layout.EngineeringProfiles
 $registry7=Get-AihModelRegistry $layout.ModelRegistry
 $expected7=Resolve-AihExpectedProfileTargets -Policy $policy7 -Profiles $profiles7 -Registry $registry7 -SettingsPath $glmSettings -Roles @('deepEngineer','reviewer')
 $activeProfile7=$expected7.Profile
 Assert-Aih ([string]$activeProfile7.Id -eq 'glm-codex') 'fixture: settings.yaml selects the GLM + Codex active profile'
 $deepTarget7=$expected7.Targets.deepEngineer
 $reviewerTarget7=$expected7.Targets.reviewer
 $a=New-AihTask $root7 'engineer deep work generation A'
 $aInstance=[string]$a.taskInstanceId
 $reviewA=Invoke-AihRoutingDecision -Description 'review the boundary' -Workspace $root7 -PolicyPath $layout.RoutingPolicy -DataRoot $dataRoot -TaskId $a.taskId -Preset 'aih-engineering' -ReviewRequested -SettingsPath $glmSettings -TaskInstanceId $aInstance
 Assert-Aih ($reviewA.executionClass -eq 'reviewer' -and $reviewA.role -eq 'reviewer') 'generation A produced a reviewer decision'
 Assert-Aih ([string]$reviewA.profile -eq [string]$activeProfile7.Id -and [string]$reviewA.model -eq [string]$reviewerTarget7.Model -and [string]$reviewA.provider -eq [string]$reviewerTarget7.Provider -and [string]$reviewA.reasoning -eq [string]$reviewerTarget7.Reasoning) 'generation A reviewer binds through the ACTIVE profile reviewer role'
 $ledgerPath=Join-Path $root7 '.ai-harness/state/tasks.json'
 Write-AihAtomicJson $ledgerPath ([ordered]@{schemaVersion=1;nextSequence=1;tasks=@()})
 Remove-Item -LiteralPath (Join-Path $root7 '.ai-harness/runs') -Recurse -Force
 $b=New-AihTask $root7 'engineer deep work generation B'
 Assert-Aih ($b.taskId -eq $a.taskId) 'fixture reproduces the display-id collision (same TASK-NNNN)'
 Assert-Aih ([string]$b.taskInstanceId -ne $aInstance) 'the reused display id received a fresh taskInstanceId (B != A)'
 $bInstance=[string]$b.taskInstanceId
 $routeB=Invoke-AihRoutingDecision -Description 'engineer deep work generation B' -Workspace $root7 -PolicyPath $layout.RoutingPolicy -DataRoot $dataRoot -TaskId $b.taskId -Preset 'aih-engineering' -ForceClass 'engineer_deep' -SettingsPath $glmSettings -TaskInstanceId $bInstance
 Assert-Aih ($routeB.executionClass -eq 'engineer_deep') 'generation B routes as engineer_deep'
 Assert-Aih ($routeB.role -eq 'deepEngineer') 'engineer_deep resolves to the semantic deepEngineer role'
 Assert-Aih ([string]$routeB.profile -eq [string]$activeProfile7.Id) 'engineer_deep resolves through the ACTIVE Engineering Profile (fixture settings.yaml)'
 Assert-Aih ([string]$routeB.model -eq [string]$deepTarget7.Model -and [string]$routeB.provider -eq [string]$deepTarget7.Provider -and [string]$routeB.reasoning -eq [string]$deepTarget7.Reasoning) 'engineer_deep model/provider/reasoning bind through the ACTIVE profile deepEngineer role (no hardcoded model identity)'
 $decisions=Get-Content -Encoding UTF8 -LiteralPath (Join-Path $dataRoot 'decisions.jsonl') | ForEach-Object { $_ | ConvertFrom-Json }
 $bRecords=@($decisions | Where-Object { $_.taskId -eq $b.taskId -and $_.taskInstanceId -eq $bInstance })
 $aRecords=@($decisions | Where-Object { $_.taskId -eq $a.taskId -and $_.taskInstanceId -eq $aInstance })
 Assert-Aih (@($bRecords).Count -eq 1 -and [string]$bRecords[0].model -eq [string]$deepTarget7.Model) 'B joins only its own engineer_deep decision'
 Assert-Aih (@($aRecords).Count -eq 1 -and [string]$aRecords[0].model -eq [string]$reviewerTarget7.Model) 'A reviewer record survives untouched under its own instance'
 Assert-Aih (@($decisions | Where-Object { $_.taskId -eq $b.taskId -and $null -eq $_.taskInstanceId }).Count -eq 0) 'no taskId-only (instance-blind) record exists that could join B'
 $joinB=@($decisions | Where-Object { $_.taskId -eq $b.taskId -and $_.taskInstanceId -eq $bInstance -and $_.executionClass -eq 'engineer_deep' })
 Assert-Aih (@($joinB).Count -eq 1 -and [string]$joinB[0].model -eq [string]$deepTarget7.Model) 'an instance-aware join for B resolves ONLY the active-profile deep engineer decision, never the A reviewer decision'
 $legacyDecision=Invoke-AihRoutingDecision -Description 'legacy routing path' -Workspace $root7 -PolicyPath $layout.RoutingPolicy -DataRoot $dataRoot -TaskId 'legacy-cli-task' -Preset 'aih-engineering'
 Assert-Aih ($legacyDecision.executionClass -eq 'engineer_normal') 'legacy taskId-only routing (no instance) still works'
 $legacyState=Read-AihRoutingState (Get-AihRoutingStatePath $dataRoot $root7 'legacy-cli-task' 'aih-engineering')
 Assert-Aih ($legacyState.taskId -eq 'legacy-cli-task') 'legacy state file remains keyed by taskId'
}catch{throw}finally{if(Test-Path $root7){Remove-Item -LiteralPath $root7 -Recurse -Force}}

Write-Host "RESULT: $passed task-identity assertions passed."
