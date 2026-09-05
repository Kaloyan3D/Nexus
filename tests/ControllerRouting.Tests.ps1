[CmdletBinding()]param([string]$InstallRoot)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
if([string]::IsNullOrWhiteSpace($InstallRoot)){$InstallRoot=Split-Path -Parent $PSScriptRoot}
# Platform-aware child host: Windows keeps powershell.exe; POSIX uses the pinned Nexus pwsh.
if (-not (Get-Command Test-AihIsWindows -ErrorAction SilentlyContinue)) { . (Join-Path $InstallRoot 'scripts/Platform.ps1') }; $aihPsHost = Get-AihPowerShellHost -InstallRoot $InstallRoot
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Routing.ps1')
. (Join-Path $InstallRoot 'scripts/TaskController.ps1')
. (Join-Path $InstallRoot 'scripts/CodexReview.ps1')
. (Join-Path $InstallRoot 'scripts/Telemetry.ps1')

$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not$Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}
function New-Fixture([string]$Name){$path=Join-Path ([IO.Path]::GetTempPath()) ("aih-$Name-"+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $path|Out-Null;$path}
function New-InstallFixture([object]$SourceLayout,[string]$Name){
 $root=New-Fixture $Name
 Copy-Item -LiteralPath $SourceLayout.Scripts -Destination (Join-Path $root 'scripts') -Recurse
 Copy-Item -LiteralPath $SourceLayout.Config -Destination (Join-Path $root 'config') -Recurse
 New-Item -ItemType Directory -Path (Join-Path $root 'data/routing') -Force|Out-Null
 if(Test-Path -LiteralPath $SourceLayout.Settings){Copy-Item -LiteralPath $SourceLayout.Settings -Destination (Join-Path $root 'data/settings.yaml')}
 return $root
}
# TASK-0007: a policy clone with the LEGACY hard budgets re-enabled, used to
# prove the old rejection behavior still works behind enforceLimits=true.
function Copy-AihPolicyEnforced([object]$Policy){$clone=$Policy|ConvertTo-Json -Depth 20|ConvertFrom-Json;$clone.codex.automaticReview.enforceLimits=$true;return $clone}

$layout=Get-AihLayout $InstallRoot;$policy=Get-AihRoutingPolicy $layout.RoutingPolicy

# ── 1. NORMAL ENGINEERING: GUI task without review metadata stays on DeepSeek, Codex calls = 0 ──
$normalRoot=New-Fixture normal
try{
 $task=New-AihTask $normalRoot 'implement ordinary change' @() @() 'normal'
 Assert-Aih ($task.executionClass -eq 'engineer_normal') 'normal GUI task starts with engineer_normal'
 Assert-Aih (-not $task.reviewRequested) 'normal GUI task has reviewRequested=false'
 $decision=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $normalRoot $task.taskId 'aih-engineering'
 Assert-Aih ($decision.executionClass -eq 'engineer_normal') 'normal task routes to engineer_normal'
 Assert-Aih (-not $decision.reviewRequired) 'normal task does not require review'
 Assert-Aih ([int]$task.codexCalls -eq 0) 'normal task records codexCalls=0'
 $completion=Test-AihTaskCompletion $normalRoot $task.taskId
 Assert-Aih ($completion.codexRequired -eq $false) 'normal task completion does not require Codex'
}finally{if(Test-Path $normalRoot){Remove-Item -LiteralPath $normalRoot -Recurse -Force}}

# ── 2. EXPLICIT REVIEW: reviewRequested metadata -> codex_review, zero engineer calls; budget enforcement disabled by default ──
$reviewRoot=New-Fixture review
try{
 $task=New-AihTask $reviewRoot 'audit the isolation boundary' @() @() 'normal' $null -ReviewRequested
 Assert-Aih ([bool]$task.reviewRequested) 'explicit task records reviewRequested=true'
 $decision=Invoke-AihRoutingDecision -Description 'audit the isolation boundary' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $reviewRoot -TaskId $task.taskId -Preset 'aih-engineering' -ReviewRequested
 Assert-Aih ($decision.executionClass -eq 'reviewer') 'explicit review request selects reviewer'
 Assert-Aih ([bool]$decision.reviewRequired) 'explicit review request marks reviewRequired'
 Assert-Aih (-not $decision.writable) 'reviewer is read-only'
 $packet=New-AihReviewPacket $reviewRoot $task.taskId 'audit the isolation boundary' @() 'diff: ok' @([pscustomobject]@{path='src/a.ts';content='const a=1'}) @() '' $policy
 Assert-Aih ([bool]$packet.enforcement.allowed) 'small explicit review packet is allowed'
 $call=Register-AihCodexReviewCall $reviewRoot $task.taskId $packet
 Assert-Aih ($call.completionAuthority -eq $false) 'registered review call has no completion authority'
 $after=Get-AihTask $reviewRoot $task.taskId
 Assert-Aih ([int]$after.codexCalls -eq 1) 'explicit review registers the first reviewer call'
 # TASK-0007: with budget enforcement disabled (shipped default) multiple
 # /review calls on one task are allowed; the reviewer stays read-only.
 $second=Register-AihCodexReviewCall $reviewRoot $task.taskId $packet
 Assert-Aih ($second.executionClass -eq 'reviewer' -and -not $second.completionAuthority) 'second review call is allowed while budget enforcement is disabled'
 Assert-Aih ($null -eq $second.maxOutputTokens) 'unlimited review call carries no Nexus maxOutputTokens budget'
 $afterTwo=Get-AihTask $reviewRoot $task.taskId
 Assert-Aih ([int]$afterTwo.codexCalls -eq 2) 'multiple /review calls on one task register (enforceLimits=false)'
 # enforceLimits=true keeps the legacy maxCallsPerTask hard limit.
 $enforcedPolicy=Copy-AihPolicyEnforced $policy
 $enforcedPacket=New-AihReviewPacket $reviewRoot $task.taskId 'audit the isolation boundary' @() 'diff: ok' @([pscustomobject]@{path='src/a.ts';content='const a=1'}) @() '' $enforcedPolicy
 Assert-Aih ([bool]$enforcedPacket.budget.enforceLimits) 'enforced packet records enforceLimits=true'
 $blocked=$false;try{Register-AihCodexReviewCall $reviewRoot $task.taskId $enforcedPacket}catch{$blocked=$_.Exception.Message-match'call limit exceeded'}
 Assert-Aih $blocked 'enforceLimits=true keeps the hard maxCallsPerTask limit'
 $telemetry=Write-AihTaskTelemetry $reviewRoot $task.taskId @{executionClass='reviewer';model='gpt-5.6-sol';provider='sol-local';modelCalls=1;codexFindings=@();finalResult='pass';configuration='deepseek-codex'}
 Assert-Aih ($telemetry.executionClass -eq 'reviewer') 'review telemetry records executionClass=reviewer'
 Assert-Aih ($telemetry.provider -eq 'sol-local' -and $telemetry.model -eq 'gpt-5.6-sol') 'review telemetry records Codex provider/model'
 Assert-Aih ([int]$telemetry.codexCalls -eq 2) 'review telemetry records the call count'
 Assert-Aih ($telemetry.configuration -eq 'deepseek-codex') 'review telemetry records the engineering profile'
}finally{if(Test-Path $reviewRoot){Remove-Item -LiteralPath $reviewRoot -Recurse -Force}}

# ── 3. BUDGET REJECTION (enforceLimits=true): oversized review -> Codex NOT called, structured result ──
$budgetRoot=New-Fixture budget
try{
 $enforcedPolicy=Copy-AihPolicyEnforced $policy
 $task=New-AihTask $budgetRoot 'oversized review' @() @() 'normal' $null -ReviewRequested
 $hugeFiles=@()
 for($i=0;$i -lt 12;$i++){ $hugeFiles += [pscustomobject]@{path="src/f$i.ts";content=('x'*1000)} }
 $packet=New-AihReviewPacket $budgetRoot $task.taskId 'oversized review' @() 'diff' $hugeFiles @() '' $enforcedPolicy
 Assert-Aih (-not [bool]$packet.enforcement.allowed) 'enforceLimits=true rejects the oversized packet'
 Assert-Aih (@($packet.enforcement.violations | Where-Object { $_ -match 'file limit exceeded' }).Count -eq 1) 'packet rejection names the file-limit violation'
 $blocked=$false;try{Register-AihCodexReviewCall $budgetRoot $task.taskId $packet}catch{$blocked=$true}
 Assert-Aih $blocked 'DO NOT CALL CODEX when the packet exceeds the enforced budget'
 $after=Get-AihTask $budgetRoot $task.taskId
 Assert-Aih ([int]$after.codexCalls -eq 0) 'no Codex call is registered for an oversized review'
}finally{if(Test-Path $budgetRoot){Remove-Item -LiteralPath $budgetRoot -Recurse -Force}}

# ── 3b. UNLIMITED REVIEW (TASK-0007): shipped default enforceLimits=false never rejects for budgets ──
# The legacy limit VALUES stay present in the policy; they are simply inert.
$unlimitedRoot=New-Fixture unlimited
try{
 $task=New-AihTask $unlimitedRoot 'large independent review' @() @() 'normal' $null -ReviewRequested
 Assert-Aih ([int]$policy.codex.automaticReview.maxContextTokens -eq 30000) 'legacy 30000 token value is still present in policy'
 Assert-Aih (-not [bool]$policy.codex.automaticReview.enforceLimits) 'shipped policy disables review budget enforcement'
 # 1. 31,270+ estimated tokens with the old 30,000 value present -> allowed.
 $bigDiff='x'*125120
 $bigFiles=@([pscustomobject]@{path='src/big.ts';content=('y'*1000)})
 $bigPacket=New-AihReviewPacket $unlimitedRoot $task.taskId 'review the large change' @() $bigDiff $bigFiles @() '' $policy
 Assert-Aih ([int]$bigPacket.enforcement.estimatedContextTokens -ge 31270) "measured context exceeds the legacy ceiling ($([int]$bigPacket.enforcement.estimatedContextTokens) est. tokens)"
 Assert-Aih ([bool]$bigPacket.enforcement.allowed) '31k-token review is allowed while budget enforcement is disabled'
 Assert-Aih (-not [bool]$bigPacket.budget.enforceLimits) 'unlimited packet records enforceLimits=false'
 Assert-Aih ($null -eq $bigPacket.budget.maxContextTokens) 'unlimited packet carries null context budget (0/null = unlimited, no magic number)'
 # 2. More than 8 files -> allowed.
 $many=@()
 for($i=0;$i -lt 12;$i++){ $many += [pscustomobject]@{path="src/f$i.ts";content='const a=1'} }
 $manyPacket=New-AihReviewPacket $unlimitedRoot $task.taskId 'review many files' @() 'diff' $many @() '' $policy
 Assert-Aih (@($manyPacket.relevantFiles).Count -gt 8) 'packet carries more than 8 files'
 Assert-Aih ([bool]$manyPacket.enforcement.allowed) '12-file review is allowed while budget enforcement is disabled'
 # 3. More than 2500 diff lines -> allowed.
 $longDiff=(1..2600|ForEach-Object{"line $_"})-join"`n"
 $longPacket=New-AihReviewPacket $unlimitedRoot $task.taskId 'review long diff' @() $longDiff @([pscustomobject]@{path='src/diff.ts';content='const d=1'}) @() '' $policy
 Assert-Aih ([int]$longPacket.enforcement.diffLines -gt 2500) 'measured diff lines exceed the legacy ceiling'
 Assert-Aih ([bool]$longPacket.enforcement.allowed) '2600-line diff review is allowed while budget enforcement is disabled'
 Assert-Aih (@($longPacket.enforcement.violations).Count -eq 0) 'no budget violations are recorded under unlimited mode'
 # 4. The unlimited review stays read-only / fresh / without completion authority.
 Assert-Aih ([bool]$longPacket.enforcement.readOnly -and [bool]$longPacket.enforcement.freshContext -and -not [bool]$longPacket.enforcement.completionAuthority) 'unlimited review packet stays read-only fresh and completion-authority-free'
 $call=Register-AihCodexReviewCall $unlimitedRoot $task.taskId $longPacket
 Assert-Aih ([bool]$call.readOnly -and -not [bool]$call.completionAuthority) 'unlimited review call registration cannot own completion'
 Assert-Aih (-not [string]::IsNullOrWhiteSpace([string]$call.taskInstanceId)) 'unlimited review call is taskInstanceId scoped'
}finally{if(Test-Path $unlimitedRoot){Remove-Item -LiteralPath $unlimitedRoot -Recurse -Force}}

# ── 4. REPEATED FAILURE ESCALATION: same normalized failure -> deep -> codex_review ──
$escalationRoot=New-Fixture escalation
try{
 $task=New-AihTask $escalationRoot 'implement ordinary change'
 $d1=Invoke-AihRoutingDecision -Description 'implement ordinary change' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $escalationRoot -TaskId $task.taskId -Preset 'aih-engineering' -Signal 'attempt-failure' -FailureReason 'same test expected 1 actual 2'
 $d2=Invoke-AihRoutingDecision -Description 'implement ordinary change' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $escalationRoot -TaskId $task.taskId -Preset 'aih-engineering' -Signal 'attempt-failure' -FailureReason 'same test expected 1 actual 2'
 Assert-Aih ($d2.executionClass -eq 'engineer_deep') 'repeated identical failure escalates to engineer_deep'
 $d3=Invoke-AihRoutingDecision -Description 'implement ordinary change' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $escalationRoot -TaskId $task.taskId -Preset 'aih-engineering' -Signal 'attempt-failure' -FailureReason 'same test expected 1 actual 2'
 $d4=Invoke-AihRoutingDecision -Description 'implement ordinary change' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $escalationRoot -TaskId $task.taskId -Preset 'aih-engineering' -Signal 'verification-failure' -FailureReason 'same test expected 1 actual 2'
 Assert-Aih ($d4.executionClass -eq 'reviewer') 'threshold reached: same normalized failure escalates to reviewer'
 Assert-Aih (-not $d4.writable) 'automatic escalation stays read-only'
}finally{if(Test-Path $escalationRoot){Remove-Item -LiteralPath $escalationRoot -Recurse -Force}}

# ── 5. NO FREE DELEGATION: the model cannot invoke unrestricted Codex ──
$engineeringPreset=Join-Path $layout.Data '.agent-presets/aih-engineering/agent.cordis.yml'
$deepseekPreset=Join-Path $layout.Data '.agent-presets/aih-deepseek/agent.cordis.yml'
foreach($preset in @($engineeringPreset,$deepseekPreset)){
 $presetName=Split-Path (Split-Path $preset -Parent) -Leaf
 $presetLines=@(Get-Content -LiteralPath $preset)
 $codexIndex=-1
 for($i=0;$i -lt $presetLines.Count;$i++){ if($presetLines[$i] -match '^\s*- id: tool-subagent-codex\s*$'){ $codexIndex=$i;break } }
 if($presetName -eq 'aih-engineering'){
  Assert-Aih ($codexIndex -ge 0) "preset $presetName declares tool-subagent-codex"
  $blockEnd=[Math]::Min($codexIndex+4,$presetLines.Count-1)
  $codexBlock=($presetLines[$codexIndex..$blockEnd] -join [string][char]10)
  Assert-Aih ($codexBlock -match 'disabled:\s*true') "preset $presetName keeps subagent_codex disabled"
 }else{
  Assert-Aih ($codexIndex -lt 0) "preset $presetName removes subagent_codex entirely"
 }
}
$solveBlocked=$false;try{Invoke-AihRoutingDecision 'solve' $InstallRoot $layout.RoutingPolicy $escalationRoot 'solve-task' 'aih-engineering' '' 'solver'}catch{$solveBlocked=$true}
Assert-Aih $solveBlocked 'solver requires explicit user approval and is never auto-selected'
$solveApproved=Invoke-AihRoutingDecision -Description 'solve' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $escalationRoot -TaskId 'solve-task' -Preset 'aih-engineering' -ForceClass 'solver' -UserApprovedCodexSolve
Assert-Aih ($solveApproved.executionClass -eq 'solver' -and $solveApproved.writable) 'solver is writable only with explicit approval'

# ── 6. COMPLETION: reviewer cannot complete; controller decides ──
$completionRoot=New-Fixture completion
try{
 $task=New-AihTask $completionRoot 'audit the isolation boundary' @('review passes') @() 'normal' $null -ReviewRequested
 Set-AihTaskEvidence $completionRoot $task.taskId ([ordered]@{acceptanceCriteria=@([ordered]@{criterion='review passes';status='met';evidence='verified by smoke'});verification=@([ordered]@{name='npm test';status='PASS'});scopePass=$true})
 $incomplete=Test-AihTaskCompletion $completionRoot $task.taskId
 Assert-Aih (-not $incomplete.complete) 'review-required task stays INCOMPLETE without a review result'
 Assert-Aih ($incomplete.codexRequired -eq $true) 'completion gate reports Codex required'
 $invalid=$false;try{[void](Test-AihReviewResult ([pscustomobject]@{verdict='complete';findings=@()}))}catch{$invalid=$true}
 Assert-Aih $invalid 'reviewer cannot emit a completion verdict'
 $result=Test-AihReviewResult ([pscustomobject]@{verdict='pass';findings=@()})
 Assert-Aih (-not $result.completionAuthority) 'validated review result has no completion authority'
 $complete=Test-AihTaskCompletion $completionRoot $task.taskId -CodexReviewPassed
 Assert-Aih ($complete.complete -and $complete.codexDisposition -eq 'pass') 'controller completes only after a passing review result'
}finally{if(Test-Path $completionRoot){Remove-Item -LiteralPath $completionRoot -Recurse -Force}}

# ── 7. CLI WIRING: default install-root routing remains production-real but hermetic ──
$cliRoot=New-Fixture cli
$cliInstallRoot=New-InstallFixture $layout cli-install
try{
 # Copy the real scripts/config into an isolated INSTALL ROOT. Route.ps1 still
 # derives <install root> -> data/routing through Get-AihLayout; only the root
 # is disposable. No production-only branch or DataRoot override is used.
 $cliLayout=Get-AihLayout $cliInstallRoot
 $taskJson=& $aihPsHost -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $cliLayout.Scripts 'Task.ps1') -Action create-task -Workspace $cliRoot -Description 'audit the boundary' -ReviewRequested
 $task=$taskJson|ConvertFrom-Json
 Assert-Aih ($task.reviewRequested -eq $true) 'aih-task create-task -ReviewRequested stores the metadata'
 $liveStatePath=Get-AihRoutingStatePath $layout.RoutingData $cliRoot $task.taskId
 Assert-Aih (-not(Test-Path -LiteralPath $liveStatePath)) 'fixture identity has no pre-existing live routing state'
 $decisionJson=& $aihPsHost -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $cliLayout.Scripts 'Route.ps1') -Workspace $cliRoot -InstallRoot $cliInstallRoot -TaskId $task.taskId -Description 'audit the boundary' -ReviewRequested
 $decision=$decisionJson|ConvertFrom-Json
 Assert-Aih ($decision.executionClass -eq 'reviewer') 'aih-route -ReviewRequested selects reviewer'
 Assert-Aih ($decision.reviewRequested -eq $true) 'routing decision record carries reviewRequested=true'
 $statePath=Get-AihRoutingStatePath $cliLayout.RoutingData $cliRoot $task.taskId
 $state=Read-AihRoutingState $statePath
 Assert-Aih ($state.executionClass -eq 'reviewer') 'routing state persists the reviewer execution class'
 Assert-Aih ($statePath.StartsWith($cliLayout.RoutingData,[StringComparison]::OrdinalIgnoreCase)) 'default layout resolves state beneath the isolated install root data/routing'
 Assert-Aih (-not(Test-Path -LiteralPath $liveStatePath)) 'default-layout CLI routing never writes the corresponding live routing state'
}finally{
 if(Test-Path $cliRoot){Remove-Item -LiteralPath $cliRoot -Recurse -Force}
 if(Test-Path $cliInstallRoot){Remove-Item -LiteralPath $cliInstallRoot -Recurse -Force}
}
Assert-Aih (-not(Test-Path -LiteralPath $cliInstallRoot)) 'isolated install fixture is cleaned after the default-layout test'

# ── 8. PAYLOAD FILE BRIDGE: hostile user text round-trips byte-exact ──
# Regression for session-85b96a59: a real /codex-review prompt (quotes, CRLF,
# Unicode arrows, control characters) was passed on the command line; Windows
# PowerShell 5.1 mangled it (U+2192 -> raw 0x1A) and ConvertTo-Json emitted
# JSON the controller bridge could not parse, so the plugin failed open and
# DeepSeek received the review. User text must now travel in a UTF-8 payload
# file and the CLI stdout must round-trip byte-exact.
$payloadRoot=New-Fixture payload
$payloadInstallRoot=New-InstallFixture $layout payload-install
try{
 $payloadLayout=Get-AihLayout $payloadInstallRoot
 $hostile='Verify only the ARTHUR Phase 2 remediation for findings F1, F2 and F3.' + [char]13 + [char]10 +
   'Repository: D:' + [char]92 + 'A.R.T.H.U.R ' + [char]0x2192 + ' arrows ' + [char]0x2014 + ' emdash ' + [char]0xE0 + ' accented 中文' + [char]13 + [char]10 +
   'Quotes: "double" and ''single'' and backslash: C:' + [char]92 + 'path' + [char]92 + 'to' + [char]92 + 'x' + [char]13 + [char]10 +
   'Control: ' + [char]0x1A + [char]0x01 + [char]13 + [char]10 +
   'F2 - replay after forget' + [char]13 + [char]10 + '- remember ' + [char]0x1A + ' forget again'
 $payloadPath=Join-Path $payloadRoot 'payload.json'
 @{Workspace=$payloadRoot;Description=$hostile;ReviewRequested=$true}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $payloadPath -Encoding UTF8
 $taskJson=& $aihPsHost -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $payloadLayout.Scripts 'Task.ps1') -Action create-task -PayloadFile $payloadPath
 Assert-Aih (-not [string]::IsNullOrWhiteSpace($taskJson)) 'payload create-task emits output'
 $task=$taskJson|ConvertFrom-Json
 Assert-Aih ($task.description -eq $hostile) 'hostile description round-trips byte-exact through Task.ps1 payload'
 Assert-Aih ($task.reviewRequested -eq $true) 'payload reviewRequested reaches New-AihTask'
 $payloadLiveStatePath=Get-AihRoutingStatePath $layout.RoutingData $payloadRoot $task.taskId
 $decisionJson=& $aihPsHost -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $payloadLayout.Scripts 'Route.ps1') -Workspace $payloadRoot -InstallRoot $payloadInstallRoot -TaskId $task.taskId -PayloadFile $payloadPath
 $decision=$decisionJson|ConvertFrom-Json
 Assert-Aih ($decision.executionClass -eq 'reviewer') 'payload routing selects reviewer for the hostile prompt'
 Assert-Aih ($decision.reviewRequested -eq $true) 'payload routing decision carries reviewRequested=true'
 Assert-Aih (-not(Test-Path -LiteralPath $payloadLiveStatePath)) 'payload bridge routing does not write live routing state'
 $srJson=& $aihPsHost -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $payloadLayout.Scripts 'Task.ps1') -Action set-review-requested -TaskId $task.taskId -PayloadFile $payloadPath
 Assert-Aih (-not [string]::IsNullOrWhiteSpace($srJson)) 'payload set-review-requested action is accepted'
 $srTask=$srJson|ConvertFrom-Json
 Assert-Aih ($srTask.taskId -eq $task.taskId) 'set-review-requested returns the updated task'
 $qPayloadPath=Join-Path $payloadRoot 'qpayload.json'
 @{Workspace=$payloadRoot;Question='Review this function for correctness only: function divide(a,b){ return a/b }'}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $qPayloadPath -Encoding UTF8
 $packetJson=& $aihPsHost -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $payloadLayout.Scripts 'Review.ps1') -Workspace $payloadRoot -InstallRoot $payloadInstallRoot -TaskId $task.taskId -PayloadFile $qPayloadPath
 $packetOut=$packetJson|ConvertFrom-Json
 Assert-Aih ($packetOut.question -eq 'Review this function for correctness only: function divide(a,b){ return a/b }') 'Review.ps1 payload question reaches the review packet'
}finally{
 if(Test-Path $payloadRoot){Remove-Item -LiteralPath $payloadRoot -Recurse -Force}
 if(Test-Path $payloadInstallRoot){Remove-Item -LiteralPath $payloadInstallRoot -Recurse -Force}
}


# ── 9. UTF-8 LEDGER BOUNDARY: read-modify-write preserves non-ASCII ──
$utf8Root = New-Fixture utf8
try {
    $utf8Desc = '# TASK ' + [string][char]0x2014 + ' Nexus UI Phase 2 - ' + [string][char]0x4E2D + [string][char]0x6587 + ' ok'
    $utf8Task = New-AihTask $utf8Root $utf8Desc @() @() 'normal'
    $utf8LedgerPath = Join-Path (Join-Path $utf8Root '.ai-harness/state') 'tasks.json'
    $utf8Text = [IO.File]::ReadAllText($utf8LedgerPath, [Text.UTF8Encoding]::new($false))
    Assert-Aih ($utf8Text.Contains([string][char]0x2014)) 'ledger file stores the real em dash as UTF-8'
    Assert-Aih (-not $utf8Text.Contains([string][char]0xFFFD)) 'ledger file carries no replacement characters'
    # a read-modify-write cycle must not corrupt non-ASCII (regression for the
    # ANSI Get-Content default that mangled the live TASK-0002 description)
    $null = Update-AihTaskRecord $utf8Root $utf8Task.taskId { param($item) $item.status = 'ready' }
    $utf8After = [IO.File]::ReadAllText($utf8LedgerPath, [Text.UTF8Encoding]::new($false))
    Assert-Aih ($utf8After.Contains([string][char]0x2014) -and -not $utf8After.Contains([string][char]0x00E2 + [string][char]0x20AC)) 'read-modify-write round-trip preserves the em dash'
    $utf8Read = Read-AihTaskLedger $utf8Root
    $utf8Round = @($utf8Read.tasks | Where-Object taskId -eq $utf8Task.taskId)[0]
    Assert-Aih ([string]$utf8Round.description -eq $utf8Desc) 'ledger read returns the intact description'
} finally { if (Test-Path $utf8Root) { Remove-Item -LiteralPath $utf8Root -Recurse -Force } }

# ── 10. LEDGER ENCODING REPAIR: authoritative restoration, idempotent ──
$repairRoot = New-Fixture repair
try {
    # simulate the historical corruption: the description was mis-decoded as
    # CP1252 and re-encoded UTF-8 (exactly what happened to TASK-0002)
    $corruptDesc = '# TASK ' + [string][char]0x00E2 + [string][char]0x20AC + [string][char]0x201D + ' Nexus'
    $cleanDesc = '# TASK ' + [string][char]0x2014 + ' Nexus'
    $repairTask = New-AihTask $repairRoot $corruptDesc @() @() 'normal'
    # authoritative clean source: a NON-escalation routing decision record
    $decisionDir = Join-Path $repairRoot 'data/routing'
    New-Item -ItemType Directory -Force -Path $decisionDir | Out-Null
    @{ recordVersion = 3; timestampUtc = '2026-08-28T17:28:02.8454102Z'; taskId = $repairTask.taskId; workspace = $repairRoot; description = $cleanDesc; provider = 'flash-max-direct'; model = 'deepseek-v4-flash' } | ConvertTo-Json -Depth 5 -Compress | Add-Content -LiteralPath (Join-Path $decisionDir 'decisions.jsonl') -Encoding UTF8
    # in-process invocation: the suite host cannot capture nested native stdout (sandbox EPERM)
    & (Join-Path $layout.Scripts 'Repair-LedgerEncoding.ps1') -InstallRoot $repairRoot -Workspace $repairRoot | Out-Null
    $repaired = Get-AihTask $repairRoot $repairTask.taskId
    Assert-Aih ([string]$repaired.description -eq $cleanDesc) 'repair restores the authoritative clean description'
    $manifestPath = Join-Path (Join-Path (Join-Path $repairRoot '.ai-harness/runs') $repairTask.taskId) 'manifest.json'
    Assert-Aih ([IO.File]::ReadAllText($manifestPath, [Text.UTF8Encoding]::new($false)).Contains($cleanDesc)) 'repair also restores the run manifest'
    # idempotent: a second run is a no-op
    $repairLedgerPath = Join-Path (Join-Path $repairRoot '.ai-harness/state') 'tasks.json'
    $before = [IO.File]::ReadAllText($repairLedgerPath, [Text.UTF8Encoding]::new($false))
    & (Join-Path $layout.Scripts 'Repair-LedgerEncoding.ps1') -InstallRoot $repairRoot -Workspace $repairRoot | Out-Null
    Assert-Aih ($before -eq [IO.File]::ReadAllText($repairLedgerPath, [Text.UTF8Encoding]::new($false))) 'repair is idempotent'
} finally { if (Test-Path $repairRoot) { Remove-Item -LiteralPath $repairRoot -Recurse -Force } }

Write-Host "# ── 9. LEGACY TOLERANCE: pre-Phase-2 class names stay readable ──"
$legacyRoot=New-Fixture legacy
try{
 Assert-Aih ((ConvertTo-AihExecutionClass 'deepseek_normal' $policy) -eq 'engineer_normal') 'legacy deepseek_normal normalizes to engineer_normal'
 Assert-Aih ((ConvertTo-AihExecutionClass 'codex_review' $policy) -eq 'reviewer') 'legacy codex_review normalizes to reviewer'
 # legacy class names remain valid CLI inputs and normalize on write
 $legacyTask=New-AihTask $legacyRoot 'legacy task' @('c') @() 'normal'
 $legacyAtt=Start-AihTaskAttempt $legacyRoot $legacyTask.taskId 'deepseek_deep'
 Assert-Aih ($legacyAtt.executionClass -eq 'engineer_deep') 'legacy deepseek_deep attempt input normalizes to engineer_deep'
 # a legacy routing record (class deepseek_normal) stays readable via the CLI
 $legacyDecision=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $legacyRoot 'legacy-cli-task' 'aih-engineering' '' 'codex_solve' '' '' -UserApprovedCodexSolve
 Assert-Aih ($legacyDecision.executionClass -eq 'solver') 'legacy codex_solve force-class normalizes to solver'
}finally{if(Test-Path $legacyRoot){Remove-Item -LiteralPath $legacyRoot -Recurse -Force}}

Write-Host "RESULT: $passed deterministic controller-routing assertions passed."
