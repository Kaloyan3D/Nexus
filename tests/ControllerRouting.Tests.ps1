[CmdletBinding()]param([string]$InstallRoot='C:\AI-Harness')
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
. (Join-Path $InstallRoot 'scripts\Common.ps1')
. (Join-Path $InstallRoot 'scripts\Routing.ps1')
. (Join-Path $InstallRoot 'scripts\TaskController.ps1')
. (Join-Path $InstallRoot 'scripts\CodexReview.ps1')
. (Join-Path $InstallRoot 'scripts\Telemetry.ps1')

$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not$Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}
function New-Fixture([string]$Name){$path=Join-Path ([IO.Path]::GetTempPath()) ("aih-$Name-"+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $path|Out-Null;$path}

$layout=Get-AihLayout $InstallRoot;$policy=Get-AihRoutingPolicy $layout.RoutingPolicy

# ── 1. NORMAL ENGINEERING: GUI task without review metadata stays on DeepSeek, Codex calls = 0 ──
$normalRoot=New-Fixture normal
try{
 $task=New-AihTask $normalRoot 'implement ordinary change' @() @() 'normal'
 Assert-Aih ($task.executionClass -eq 'deepseek_normal') 'normal GUI task starts on DeepSeek normal'
 Assert-Aih (-not $task.reviewRequested) 'normal GUI task has reviewRequested=false'
 $decision=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $normalRoot $task.taskId 'aih-engineering'
 Assert-Aih ($decision.executionClass -eq 'deepseek_normal') 'normal task routes to deepseek_normal'
 Assert-Aih (-not $decision.reviewRequired) 'normal task does not require review'
 Assert-Aih ([int]$task.codexCalls -eq 0) 'normal task records codexCalls=0'
 $completion=Test-AihTaskCompletion $normalRoot $task.taskId
 Assert-Aih ($completion.codexRequired -eq $false) 'normal task completion does not require Codex'
}finally{if(Test-Path $normalRoot){Remove-Item -LiteralPath $normalRoot -Recurse -Force}}

# ── 2. EXPLICIT REVIEW: reviewRequested metadata -> codex_review, exactly one bounded call ──
$reviewRoot=New-Fixture review
try{
 $task=New-AihTask $reviewRoot 'audit the isolation boundary' @() @() 'normal' $null -ReviewRequested
 Assert-Aih ([bool]$task.reviewRequested) 'explicit task records reviewRequested=true'
 $decision=Invoke-AihRoutingDecision -Description 'audit the isolation boundary' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $reviewRoot -TaskId $task.taskId -Preset 'aih-engineering' -ReviewRequested
 Assert-Aih ($decision.executionClass -eq 'codex_review') 'explicit review request selects codex_review'
 Assert-Aih ([bool]$decision.reviewRequired) 'explicit review request marks reviewRequired'
 Assert-Aih (-not $decision.writable) 'codex_review is read-only'
 $packet=New-AihReviewPacket $reviewRoot $task.taskId 'audit the isolation boundary' @() 'diff: ok' @([pscustomobject]@{path='src/a.ts';content='const a=1'}) @() '' $policy
 Assert-Aih ([bool]$packet.enforcement.allowed) 'small explicit review packet is allowed'
 $call=Register-AihCodexReviewCall $reviewRoot $task.taskId $packet
 Assert-Aih ($call.completionAuthority -eq $false) 'registered review call has no completion authority'
 $after=Get-AihTask $reviewRoot $task.taskId
 Assert-Aih ([int]$after.codexCalls -eq 1) 'explicit review registers exactly one call'
 $blocked=$false;try{Register-AihCodexReviewCall $reviewRoot $task.taskId $packet}catch{$blocked=$true}
 Assert-Aih $blocked 'second Codex call for the same task is blocked (max 1 per task)'
 $telemetry=Write-AihTaskTelemetry $reviewRoot $task.taskId @{executionClass='codex_review';model='gpt-5.6-sol';provider='sol-local';modelCalls=1;codexFindings=@();finalResult='pass';configuration='deepseek-codex-review'}
 Assert-Aih ($telemetry.executionClass -eq 'codex_review') 'review telemetry records executionClass=codex_review'
 Assert-Aih ($telemetry.provider -eq 'sol-local' -and $telemetry.model -eq 'gpt-5.6-sol') 'review telemetry records Codex provider/model'
 Assert-Aih ([int]$telemetry.codexCalls -eq 1) 'review telemetry records call count'
 Assert-Aih ($telemetry.configuration -eq 'deepseek-codex-review') 'review telemetry records configuration'
}finally{if(Test-Path $reviewRoot){Remove-Item -LiteralPath $reviewRoot -Recurse -Force}}

# ── 3. BUDGET REJECTION: oversized review -> Codex NOT called, structured result ──
$budgetRoot=New-Fixture budget
try{
 $task=New-AihTask $budgetRoot 'oversized review' @() @() 'normal' $null -ReviewRequested
 $hugeFiles=@()
 for($i=0;$i -lt 12;$i++){ $hugeFiles += [pscustomobject]@{path="src/f$i.ts";content=('x'*1000)} }
 $packet=New-AihReviewPacket $budgetRoot $task.taskId 'oversized review' @() 'diff' $hugeFiles @() '' $policy
 Assert-Aih (-not [bool]$packet.enforcement.allowed) 'oversized packet is rejected by budget enforcement'
 Assert-Aih (@($packet.enforcement.violations | Where-Object { $_ -match 'file limit exceeded' }).Count -eq 1) 'packet rejection names the file-limit violation'
 $blocked=$false;try{Register-AihCodexReviewCall $budgetRoot $task.taskId $packet}catch{$blocked=$true}
 Assert-Aih $blocked 'DO NOT CALL CODEX when the packet exceeds the budget'
 $after=Get-AihTask $budgetRoot $task.taskId
 Assert-Aih ([int]$after.codexCalls -eq 0) 'no Codex call is registered for an oversized review'
}finally{if(Test-Path $budgetRoot){Remove-Item -LiteralPath $budgetRoot -Recurse -Force}}

# ── 4. REPEATED FAILURE ESCALATION: same normalized failure -> deep -> codex_review ──
$escalationRoot=New-Fixture escalation
try{
 $task=New-AihTask $escalationRoot 'implement ordinary change'
 $d1=Invoke-AihRoutingDecision -Description 'implement ordinary change' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $escalationRoot -TaskId $task.taskId -Preset 'aih-engineering' -Signal 'attempt-failure' -FailureReason 'same test expected 1 actual 2'
 $d2=Invoke-AihRoutingDecision -Description 'implement ordinary change' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $escalationRoot -TaskId $task.taskId -Preset 'aih-engineering' -Signal 'attempt-failure' -FailureReason 'same test expected 1 actual 2'
 Assert-Aih ($d2.executionClass -eq 'deepseek_deep') 'repeated identical failure escalates to DeepSeek deep'
 $d3=Invoke-AihRoutingDecision -Description 'implement ordinary change' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $escalationRoot -TaskId $task.taskId -Preset 'aih-engineering' -Signal 'attempt-failure' -FailureReason 'same test expected 1 actual 2'
 $d4=Invoke-AihRoutingDecision -Description 'implement ordinary change' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $escalationRoot -TaskId $task.taskId -Preset 'aih-engineering' -Signal 'verification-failure' -FailureReason 'same test expected 1 actual 2'
 Assert-Aih ($d4.executionClass -eq 'codex_review') 'threshold reached: same normalized failure escalates to codex_review'
 Assert-Aih (-not $d4.writable) 'automatic escalation stays read-only'
}finally{if(Test-Path $escalationRoot){Remove-Item -LiteralPath $escalationRoot -Recurse -Force}}

# ── 5. NO FREE DELEGATION: the model cannot invoke unrestricted Codex ──
$engineeringPreset=Join-Path $layout.Data '.agent-presets\aih-engineering\agent.cordis.yml'
$deepseekPreset=Join-Path $layout.Data '.agent-presets\aih-deepseek\agent.cordis.yml'
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
$solveBlocked=$false;try{Invoke-AihRoutingDecision 'solve' $InstallRoot $layout.RoutingPolicy $escalationRoot 'solve-task' 'aih-engineering' '' 'codex_solve'}catch{$solveBlocked=$true}
Assert-Aih $solveBlocked 'codex_solve requires explicit user approval and is never auto-selected'
$solveApproved=Invoke-AihRoutingDecision -Description 'solve' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $escalationRoot -TaskId 'solve-task' -Preset 'aih-engineering' -ForceClass 'codex_solve' -UserApprovedCodexSolve
Assert-Aih ($solveApproved.executionClass -eq 'codex_solve' -and $solveApproved.writable) 'codex_solve is writable only with explicit approval'

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

# ── 7. CLI WIRING: aih-task create-task honors the metadata; aih-route records it ──
$cliRoot=New-Fixture cli
try{
 $taskJson=& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $layout.Scripts 'Task.ps1') -Action create-task -Workspace $cliRoot -Description 'audit the boundary' -ReviewRequested
 $task=$taskJson|ConvertFrom-Json
 Assert-Aih ($task.reviewRequested -eq $true) 'aih-task create-task -ReviewRequested stores the metadata'
 $decisionJson=& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $layout.Scripts 'Route.ps1') -Workspace $cliRoot -TaskId $task.taskId -Description 'audit the boundary' -ReviewRequested
 $decision=$decisionJson|ConvertFrom-Json
 Assert-Aih ($decision.executionClass -eq 'codex_review') 'aih-route -ReviewRequested selects codex_review'
 Assert-Aih ($decision.reviewRequested -eq $true) 'routing decision record carries reviewRequested=true'
 $statePath=Get-AihRoutingStatePath $layout.RoutingData $cliRoot $task.taskId
 $state=Read-AihRoutingState $statePath
 Assert-Aih ($state.executionClass -eq 'codex_review') 'routing state persists the codex_review execution class'
}finally{if(Test-Path $cliRoot){Remove-Item -LiteralPath $cliRoot -Recurse -Force}}

# ── 8. PAYLOAD FILE BRIDGE: hostile user text round-trips byte-exact ──
# Regression for session-85b96a59: a real /codex-review prompt (quotes, CRLF,
# Unicode arrows, control characters) was passed on the command line; Windows
# PowerShell 5.1 mangled it (U+2192 -> raw 0x1A) and ConvertTo-Json emitted
# JSON the controller bridge could not parse, so the plugin failed open and
# DeepSeek received the review. User text must now travel in a UTF-8 payload
# file and the CLI stdout must round-trip byte-exact.
$payloadRoot=New-Fixture payload
try{
 $hostile='Verify only the ARTHUR Phase 2 remediation for findings F1, F2 and F3.' + [char]13 + [char]10 +
   'Repository: D:' + [char]92 + 'A.R.T.H.U.R ' + [char]0x2192 + ' arrows ' + [char]0x2014 + ' emdash ' + [char]0xE0 + ' accented 中文' + [char]13 + [char]10 +
   'Quotes: "double" and ''single'' and backslash: C:' + [char]92 + 'path' + [char]92 + 'to' + [char]92 + 'x' + [char]13 + [char]10 +
   'Control: ' + [char]0x1A + [char]0x01 + [char]13 + [char]10 +
   'F2 - replay after forget' + [char]13 + [char]10 + '- remember ' + [char]0x1A + ' forget again'
 $payloadPath=Join-Path $payloadRoot 'payload.json'
 @{Workspace=$payloadRoot;Description=$hostile;ReviewRequested=$true}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $payloadPath -Encoding UTF8
 $taskJson=& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $layout.Scripts 'Task.ps1') -Action create-task -PayloadFile $payloadPath
 Assert-Aih (-not [string]::IsNullOrWhiteSpace($taskJson)) 'payload create-task emits output'
 $task=$taskJson|ConvertFrom-Json
 Assert-Aih ($task.description -eq $hostile) 'hostile description round-trips byte-exact through Task.ps1 payload'
 Assert-Aih ($task.reviewRequested -eq $true) 'payload reviewRequested reaches New-AihTask'
 $decisionJson=& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $layout.Scripts 'Route.ps1') -Workspace $payloadRoot -TaskId $task.taskId -PayloadFile $payloadPath
 $decision=$decisionJson|ConvertFrom-Json
 Assert-Aih ($decision.executionClass -eq 'codex_review') 'payload routing selects codex_review for the hostile prompt'
 Assert-Aih ($decision.reviewRequested -eq $true) 'payload routing decision carries reviewRequested=true'
 $srJson=& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $layout.Scripts 'Task.ps1') -Action set-review-requested -TaskId $task.taskId -PayloadFile $payloadPath
 Assert-Aih (-not [string]::IsNullOrWhiteSpace($srJson)) 'payload set-review-requested action is accepted'
 $srTask=$srJson|ConvertFrom-Json
 Assert-Aih ($srTask.taskId -eq $task.taskId) 'set-review-requested returns the updated task'
 $qPayloadPath=Join-Path $payloadRoot 'qpayload.json'
 @{Workspace=$payloadRoot;Question='Review this function for correctness only: function divide(a,b){ return a/b }'}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $qPayloadPath -Encoding UTF8
 $packetJson=& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $layout.Scripts 'Review.ps1') -Workspace $payloadRoot -TaskId $task.taskId -PayloadFile $qPayloadPath
 $packetOut=$packetJson|ConvertFrom-Json
 Assert-Aih ($packetOut.question -eq 'Review this function for correctness only: function divide(a,b){ return a/b }') 'Review.ps1 payload question reaches the review packet'
}finally{if(Test-Path $payloadRoot){Remove-Item -LiteralPath $payloadRoot -Recurse -Force}}

Write-Host "RESULT: $passed deterministic controller-routing assertions passed."
