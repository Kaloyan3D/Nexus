[CmdletBinding()]param([string]$InstallRoot)
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
# Platform-aware child host: Windows keeps powershell.exe; POSIX uses the pinned Nexus pwsh.
if (-not (Get-Command Test-AihIsWindows -ErrorAction SilentlyContinue)) { . (Join-Path $InstallRoot 'scripts/Platform.ps1') }; $aihPsHost = Get-AihPowerShellHost -InstallRoot $InstallRoot
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Routing.ps1')
. (Join-Path $InstallRoot 'scripts/TaskController.ps1')
. (Join-Path $InstallRoot 'scripts/ContextEngine.ps1')
. (Join-Path $InstallRoot 'scripts/OutputDigest.ps1')
. (Join-Path $InstallRoot 'scripts/CodexReview.ps1')
. (Join-Path $InstallRoot 'scripts/WorktreeManager.ps1')
. (Join-Path $InstallRoot 'scripts/ArchitectureRules.ps1')
. (Join-Path $InstallRoot 'scripts/Telemetry.ps1')
. (Join-Path $InstallRoot 'scripts/Completion.ps1')
. (Join-Path $InstallRoot 'scripts/ControlRoom.ps1')
. (Join-Path $InstallRoot 'tests/TestHelpers.ps1')

$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not$Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}
function New-Fixture([string]$Name){$path=Join-Path ([IO.Path]::GetTempPath()) ("aih-$Name-"+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $path|Out-Null;$path}

$layout=Get-AihLayout $InstallRoot;$policy=Get-AihRoutingPolicy $layout.RoutingPolicy
Assert-Aih ($policy.version-eq3) 'routing policy v3 loads (Phase 2 generalized classes)'
Assert-Aih ($policy.defaultExecutionClass-eq'engineer_normal') 'engineer_normal is the default execution class'
$normal=Resolve-AihPreset $policy normal;$deep=Resolve-AihPreset $policy deepseek
Assert-Aih ($normal.Config.rootExecutor.model-eq'deepseek-v4-flash') 'normal GUI mode has DeepSeek Flash root'
Assert-Aih ($deep.Config.rootExecutor.model-eq'deepseek-v4-flash') 'DeepSeek-only GUI mode has DeepSeek Flash root'
$normalMode=Get-AihControlRoomMode $policy normal
Assert-Aih ($normalMode.Provider-eq'flash-max-direct'-and-not$normalMode.RequiresOpenAI) 'Control Room root selection no longer requires permanent Sol'

$routingRoot=New-Fixture routing
try{
 $r1=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $routingRoot 'normal-task'
 Assert-Aih ($r1.executionClass-eq'engineer_normal'-and$r1.model-eq'deepseek-v4-flash') 'normal task routes to engineer_normal'
 $f1=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $routingRoot 'normal-task' '' '' '' 'attempt-failure' 'same test expected 1 actual 2'
 Assert-Aih ($f1.executionClass-eq'engineer_normal') 'initial meaningful failure remains engineer_normal'
 $f2=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $routingRoot 'normal-task' '' '' '' 'attempt-failure' 'same test expected 9 actual 8'
 Assert-Aih ($f2.executionClass-eq'engineer_deep') 'repeated normalized failure escalates to engineer_deep'
 $f3=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $routingRoot 'normal-task' '' '' '' 'verification-failure' 'same test expected 1 actual 2'
 $f4=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $routingRoot 'normal-task' '' '' '' 'verification-failure' 'same test expected 3 actual 4'
 Assert-Aih ($f4.executionClass-eq'reviewer'-and-not$f4.writable) 'repeated deep failure may reach read-only reviewer'
 $repair=Invoke-AihRoutingDecision 'implement bounded review finding' $InstallRoot $layout.RoutingPolicy $routingRoot 'normal-task' '' '' '' 'review-findings'
 Assert-Aih ($repair.executionClass-eq'engineer_deep'-and$repair.escalatedFrom-eq'reviewer') 'bounded review findings return to deep-engineer repair'
 $forced=Invoke-AihRoutingDecision 'ordinary' $InstallRoot $layout.RoutingPolicy $routingRoot 'forced-task' '' '' 'engineer_deep'
 Assert-Aih ($forced.manualOverride-and$forced.executionClass-eq'engineer_deep') 'explicit user execution-class override works'
 $legacy=Invoke-AihRoutingDecision 'ordinary' $InstallRoot $layout.RoutingPolicy $routingRoot 'legacy-task' '' 'tier3'
 Assert-Aih ($legacy.executionClass-eq'engineer_normal'-and$legacy.legacyTierDeprecated) 'legacy tier3 maps compatibly to engineer_normal'
 $solveBlocked=$false;try{Invoke-AihRoutingDecision -Description 'solve' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $routingRoot -TaskId 'solve-task' -ForceClass solver|Out-Null}catch{$solveBlocked=$_.Exception.Message-match'UserApprovedCodexSolve'}
 Assert-Aih $solveBlocked 'writable solver requires explicit operator approval flag'
 $solve=Invoke-AihRoutingDecision -Description 'solve' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $routingRoot -TaskId 'solve-task-approved' -ForceClass solver -UserApprovedCodexSolve
 Assert-Aih ($solve.executionClass-eq'solver'-and$solve.writable) 'explicit operator approval enables exceptional solve'
}finally{Remove-Item -LiteralPath $routingRoot -Recurse -Force}

$fixture=New-Fixture controller
try{
 $objective=New-AihObjective $fixture 'persistent objective' @('criterion one')
 $task=New-AihTask $fixture 'bounded task' @('criterion one')
 $attempt=Start-AihTaskAttempt $fixture $task.taskId deepseek_normal
 $reloaded=Read-AihTaskLedger $fixture
 Assert-Aih (@($reloaded.tasks).Count-eq1-and$reloaded.tasks[0].attempt-eq1) 'controller state and attempts survive restart'
 Assert-Aih ((Test-Path (Join-Path $fixture ".ai-harness/runs/$($task.taskId)/attempts.jsonl"))) 'attempt journal persists independently of conversation'
 Add-AihTaskFailure $fixture $task.taskId 'failure-a' 'evidence'|Out-Null
 Start-AihTaskAttempt $fixture $task.taskId deepseek_deep|Out-Null;Add-AihTaskFailure $fixture $task.taskId 'failure-a' 'evidence'|Out-Null
 Start-AihTaskAttempt $fixture $task.taskId deepseek_deep|Out-Null;Add-AihTaskFailure $fixture $task.taskId 'failure-a' 'evidence'|Out-Null
 $bounded=$false;try{Start-AihTaskAttempt $fixture $task.taskId|Out-Null}catch{$bounded=$_.Exception.Message-match'Bounded retry'}
 Assert-Aih $bounded 'controller enforces bounded retries'
 $task2=New-AihTask $fixture 'completion task' @('works')
 Start-AihTaskAttempt $fixture $task2.taskId|Out-Null
 $blocked=Test-AihTaskCompletion $fixture $task2.taskId
 Assert-Aih (-not$blocked.complete) 'missing verification blocks completion'
 Set-AihTaskEvidence $fixture $task2.taskId ([pscustomobject]@{acceptanceCriteria=@([pscustomobject]@{criterion='works';status='met';evidence='test'});verification=@([pscustomobject]@{status='PASS'});scopePass=$true})
 $complete=Test-AihTaskCompletion $fixture $task2.taskId
 Assert-Aih ($complete.complete-and$complete.authority-eq'deterministic-controller') 'ordinary deterministic evidence completes without Sol'
 $critical=New-AihTask $fixture 'critical task' @('safe') @() critical
 Start-AihTaskAttempt $fixture $critical.taskId|Out-Null
 Set-AihTaskEvidence $fixture $critical.taskId ([pscustomobject]@{acceptanceCriteria=@([pscustomobject]@{criterion='safe';status='met';evidence='test'});verification=@([pscustomobject]@{status='PASS'});scopePass=$true})
 Assert-Aih (-not(Test-AihTaskCompletion $fixture $critical.taskId).complete) 'critical policy requires bounded review'
 Assert-Aih ((Test-AihTaskCompletion $fixture $critical.taskId -CodexReviewPassed).complete) 'passing configured critical review permits completion'

 # ── TASK-0004 attempt lifecycle (producer level) ──────────────────────────
 $lc=New-AihTask $fixture 'lifecycle task' @('ok')
 $a1=Start-AihTaskAttempt $fixture $lc.taskId deepseek_normal -SessionId 'session-x' -StartedByTurn '7'
 Assert-Aih ($a1.sequence-eq1-and$a1.status-eq'started'-and$a1.sessionId-eq'session-x'-and$a1.startedByTurn-eq'7') 'first GUI execution creates attempt 1 with runtime identity'
 $dupRejected=$false;try{Start-AihTaskAttempt $fixture $lc.taskId deepseek_normal -RequireNoOpenAttempt|Out-Null}catch{$dupRejected=$_.Exception.Message-match'duplicate start'}
 Assert-Aih $dupRejected 'duplicate start event while attempt open is rejected (attempt stays 1)'
 $a1reload=Get-AihLatestAttempt $fixture $lc.taskId
 Assert-Aih ($a1reload.sequence-eq1-and$a1reload.status-eq'started') 'reload/reconnect observes the same open attempt'
 Add-AihAttemptEvent $fixture $lc.taskId verifying|Out-Null
 $nowVerifying=Get-AihLatestAttempt $fixture $lc.taskId
 Assert-Aih ($nowVerifying.status-eq'verifying'-and$nowVerifying.timestampUtc) 'verification start records a producer timestamp'
 $reverifyRejected=$false;try{Add-AihAttemptEvent $fixture $lc.taskId verifying|Out-Null}catch{$reverifyRejected=$_.Exception.Message-match're-enter verifying'}
 Assert-Aih $reverifyRejected 'verifying cannot re-enter verifying'
 Add-AihAttemptEvent $fixture $lc.taskId passed|Out-Null
 Assert-Aih ((Get-AihLatestAttempt $fixture $lc.taskId).status-eq'passed') 'verification pass closes the attempt as passed'
 $closedRejected=$false;try{Add-AihAttemptEvent $fixture $lc.taskId interrupted|Out-Null}catch{$closedRejected=$_.Exception.Message-match'already closed'}
 Assert-Aih $closedRejected 'events against a closed attempt fail closed'
 $a2=Start-AihTaskAttempt $fixture $lc.taskId deepseek_normal -RequireNoOpenAttempt -SessionId 'session-x' -StartedByTurn '19'
 Assert-Aih ($a2.sequence-eq2) 'a real retry after the attempt closed creates attempt 2'
 $lc2=New-AihTask $fixture 'interrupt task' @('ok')
 Start-AihTaskAttempt $fixture $lc2.taskId|Out-Null
 Add-AihAttemptEvent $fixture $lc2.taskId interrupted -Reason 'user-abort'|Out-Null
 Assert-Aih ((Get-AihLatestAttempt $fixture $lc2.taskId).status-eq'interrupted') 'user abort records interrupted'
 $failNoOpen=$false;try{Add-AihTaskFailure $fixture $lc2.taskId 'late-failure' 'evidence'|Out-Null}catch{$failNoOpen=$_.Exception.Message-match'No open attempt'}
 Assert-Aih $failNoOpen 'failure without an open attempt fails closed'
 $lc3=New-AihTask $fixture 'pass-guard task' @('ok')
 Start-AihTaskAttempt $fixture $lc3.taskId|Out-Null
 $passNoVerify=$false;try{Add-AihAttemptEvent $fixture $lc3.taskId passed|Out-Null}catch{$passNoVerify=$_.Exception.Message-match'without a verifying'}
 Assert-Aih $passNoVerify 'passing without a verifying record fails closed'

 New-Item -ItemType Directory -Path (Join-Path $fixture 'src')|Out-Null
 [IO.File]::WriteAllText((Join-Path $fixture 'src/widget.ts'),"export interface Widget { id: string }`nexport function findWidget(id: string) { return id }",[Text.UTF8Encoding]::new($false))
 [IO.File]::WriteAllText((Join-Path $fixture 'README.md'),'Widget lookup documentation',[Text.UTF8Encoding]::new($false))
 $map=New-AihRepositoryMap $fixture
 Assert-Aih (@(Find-AihSymbol $map 'findWidget').Count-eq1) 'context engine retrieves relevant symbols'
 Assert-Aih (@(Search-AihCode $fixture 'widget lookup').Count-gt0) 'lexical retrieval ranks matching code and docs'
 $context=New-AihContextBundle $fixture $task2.taskId 'fix findWidget lookup' @('works') 500 2
 Assert-Aih ($context.manifest.budget.estimatedTokens-le500-and@($context.fileSlices).Count-le2) 'context budget is enforced'
 Assert-Aih (-not$context.manifest.repositoryMap.fullRepositoryIncluded) 'context engine never marks automatic full-repo content ingestion'
 $savedManifest=Get-Content -Raw (Join-Path $fixture ".ai-harness/runs/$($task2.taskId)/context-manifest.json")|ConvertFrom-Json
 Assert-Aih ($savedManifest.taskId-eq$task2.taskId-and$savedManifest.budget.maxFiles-eq2) 'stable machine-readable context manifest is persisted'

 $raw=(1..1000|ForEach-Object{"noise line $_"})-join"`n";$raw+="`nFAIL tests/widget.test.ts:18 Expected: 1 Actual: 2"
 $digest=New-AihOutputDigest $fixture $task2.taskId test $raw 1 1000
 Assert-Aih ($digest.summaryCharacters-le1020-and$digest.summary-match'Expected: 1 Actual: 2') 'large logs become bounded summaries preserving failure'
 Assert-Aih ((Get-Content -Raw $digest.rawPath).Length-eq$raw.Length) 'raw output remains accessible as an artifact'

 # TASK-0007: unlimited context mode (0 = unlimited, explicit semantic).
 # TASK-0009: the extra src files are GENUINELY relevant to the query (findWidget
 # + lookup in path and content), so the unlimited-count assertion exercises
 # relevance selection, not weak incidental matches; weak matches stay out.
 $largeContent=('findWidget large lookup logic '*300)
 [IO.File]::WriteAllText((Join-Path $fixture 'src/large.ts'),$largeContent,[Text.UTF8Encoding]::new($false))
 for($i=1;$i -le 14;$i++){ [IO.File]::WriteAllText((Join-Path $fixture ('src/lookup{0:d2}.ts' -f $i)),('findWidget lookup widget case {0}' -f $i),[Text.UTF8Encoding]::new($false)) }
 for($i=1;$i -le 14;$i++){ [IO.File]::WriteAllText((Join-Path $fixture ('src/gen{0:d2}.ts' -f $i)),(('generated lookup logic {0}' -f $i)+"`n")*3,[Text.UTF8Encoding]::new($false)) }
 $unl=New-AihContextBundle $fixture $task2.taskId 'fix findWidget lookup' @('works') 0 0
 Assert-Aih ($unl.manifest.budget.maxContextTokens-eq0-and$unl.manifest.budget.maxFiles-eq0) 'context bundle records 0 = unlimited explicitly'
 Assert-Aih ($unl.manifest.budget.enforceLimits-eq$false) 'unlimited context bundle reports enforceLimits=false'
 Assert-Aih (@($unl.fileSlices|Where-Object{$_.truncated}).Count-eq0) 'unlimited bundle never truncates matched slices'
 $largeSlice=@($unl.fileSlices|Where-Object{$_.path-eq'src/large.ts'})[0]
 Assert-Aih ($null-ne$largeSlice-and$largeSlice.content.Length-eq$largeContent.Length) 'unlimited bundle includes the whole matched file'
 Assert-Aih (@($unl.fileSlices).Count-gt12) 'unlimited bundle is not capped at the old 12-file default'
 Assert-Aih (-not$unl.manifest.repositoryMap.fullRepositoryIncluded) 'unlimited mode still never claims full-repository ingestion'
 $negBlocked=$false;try{New-AihContextBundle $fixture $task2.taskId 'x' @() -5 0|Out-Null}catch{$negBlocked=$true}
 Assert-Aih $negBlocked 'negative context budgets stay invalid (0 is the only unlimited value)'

 $slice=[pscustomobject]@{path='src/widget.ts';content='export function findWidget() {}'}
 $packet=New-AihReviewPacket $fixture $task2.taskId 'Is lookup safe?' @('no duplicate execution') 'one line diff' @($slice) @() 'DeepSeek is uncertain' $policy
 Assert-Aih ($packet.enforcement.allowed-and$packet.enforcement.readOnly-and$packet.enforcement.freshContext-and-not$packet.enforcement.completionAuthority) 'review packet is fresh read-only and has no completion authority'
 # TASK-0007: enforcement disabled (shipped default) -> the legacy diff-line ceiling is inert.
 $oversized=New-AihReviewPacket $fixture $task2.taskId 'review' @() ((1..2600|ForEach-Object{'x'})-join"`n") @($slice) @() '' $policy
 Assert-Aih ([bool]$oversized.enforcement.allowed) '2600-line diff is allowed while review budget enforcement is disabled'
 # enforceLimits=true keeps the legacy hard diff limit.
 $enforcedPolicy=$policy|ConvertTo-Json -Depth 20|ConvertFrom-Json
 $enforcedPolicy.codex.automaticReview.enforceLimits=$true
 $enforcedOversized=New-AihReviewPacket $fixture $task2.taskId 'review' @() ((1..2600|ForEach-Object{'x'})-join"`n") @($slice) @() '' $enforcedPolicy
 Assert-Aih (-not$enforcedOversized.enforcement.allowed-and$enforcedOversized.enforcement.violations-match'diff line limit') 'enforceLimits=true still rejects over the hard diff limit'
 $call=Register-AihCodexReviewCall $fixture $task2.taskId $packet
 Assert-Aih ($call.executionClass-eq'reviewer'-and-not$call.completionAuthority) 'review call registration cannot own completion'
 # TASK-0007: repeated review calls register while enforcement is disabled.
 Register-AihCodexReviewCall $fixture $task2.taskId $packet|Out-Null
 $callsAfterTwo=(Get-AihTask $fixture $task2.taskId).codexCalls
 Assert-Aih ([int]$callsAfterTwo-ge2) 'repeated /review calls on one task register while budget enforcement is disabled'
 # enforceLimits=true keeps the hard per-task Codex call limit.
 $enforcedSmall=New-AihReviewPacket $fixture $task2.taskId 'Is lookup safe?' @('no duplicate execution') 'one line diff' @($slice) @() 'DeepSeek is uncertain' $enforcedPolicy
 $secondBlocked=$false;try{Register-AihCodexReviewCall $fixture $task2.taskId $enforcedSmall|Out-Null}catch{$secondBlocked=$_.Exception.Message-match'call limit exceeded'}
 Assert-Aih $secondBlocked 'hard per-task Codex call limit cannot be bypassed when enforceLimits=true'
 $telemetry=Write-AihTaskTelemetry $fixture $critical.taskId @{model='deepseek-v4-flash';provider='flash-max-direct';inputTokens=100;outputTokens=20;contextSize=400;filesSupplied=2;filesModified=1;diffLines=5;finalResult='complete';configuration='deepseek-only'}
 Assert-Aih ($telemetry.codexCalls-eq0-and$telemetry.model-eq'deepseek-v4-flash') 'cost regression telemetry records normal zero-Codex execution'
 $learning=Add-AihLearning $fixture $task2.taskId static-rule 'prevent duplicate execution'
 Assert-Aih (-not$learning.approvedForAutomation) 'model learnings cannot automatically change policy'
}finally{Remove-Item -LiteralPath $fixture -Recurse -Force}

# ── TASK-0009: review context retrieval quality ──────────────────────────────
# Deterministic regressions for repository-review context: eligibility (runtime/
# generated/state exclusion with reasons), weighted lexical ranking (idf + tf
# saturation + path/identifier boosts), evidence classification, relevance floor,
# unlimited-budget semantics, context-quality guard and manifest provenance.
$ctxFixture=New-Fixture 'ctxq'
try{
 $ctxDirs=@('scripts/intelligence','tests','data/routing','data/fixtures','third-party-generated','blocked-artifacts','artifacts','src','docs/architecture','gen')
 foreach($d in $ctxDirs){New-Item -ItemType Directory -Force -Path (Join-Path $ctxFixture $d)|Out-Null}
 $ctxWrite={param($rel,$content)[IO.File]::WriteAllText((Join-Path $ctxFixture $rel),$content,[Text.UTF8Encoding]::new($false))}
 & $ctxWrite 'scripts/intelligence/Intelligence.CodeStore.ps1' "function New-AihCodeIntelligenceStore {`n    # CodeIntelligenceStore implements the Phase 3.2 deterministic code intelligence snapshot store.`n}"
 & $ctxWrite 'tests/Intelligence.CodeFoundation.Tests.ps1' "Describe 'CodeIntelligenceStore' {`n    It 'activates Phase 3.2 code intelligence snapshots' { }`n}"
 & $ctxWrite 'docs/architecture/code-intelligence.md' '# Deterministic Code Intelligence (Phase 3.2)'
 & $ctxWrite 'config.json' '{"codeIntelligence":{"snapshotStore":"content-addressed-v1"}}'
 & $ctxWrite 'data/fixtures/expected.json' '{"expected":["CodeIntelligenceStore"]}'
 & $ctxWrite 'src/CodeIntelligenceStore.ps1' '# CodeIntelligenceStore identifier lives here once for the repetition test.'
 & $ctxWrite 'third-party-generated/stuff.json' '{"generated":true}'
 & $ctxWrite 'blocked-artifacts/leak.ps1' 'Write-Output leak'
 & $ctxWrite '.env' 'SECRET=placeholder'
 & $ctxWrite 'gen/bundle.min.js' 'function codeIntelligenceStoreMinified(){}'
 $reviewPrompt='{"prompt": "Review the complete Phase 3.2 Deterministic Code Intelligence implementation as the quality gate before Phase 3.3."}'
 & $ctxWrite 'data/routing/decisions.jsonl' ((1..300|ForEach-Object{$reviewPrompt}) -join [Environment]::NewLine)
 & $ctxWrite 'artifacts/review.log' ((1..1000|ForEach-Object{"review entry $_"}) -join [Environment]::NewLine)
 & $ctxWrite 'data/routing/keep-manual.md' '# manually kept runtime note about review gates'
 $nexusYaml="context:`n  exclude_globs:`n    - 'third-party-generated/**'`n    - '!data/routing/keep-manual.md'`n    - '!blocked-artifacts/leak.ps1'`nsecurity:`n  blocked_globs:`n    - 'blocked-artifacts/**'`n"
 [IO.File]::WriteAllText((Join-Path $ctxFixture '.nexus.yml'),$nexusYaml,[Text.UTF8Encoding]::new($false))
 $ctxTask=New-AihTask $ctxFixture 'review context quality task' @('evidence')
 $ctxQuery='Review the complete Phase 3.2 Deterministic Code Intelligence implementation as the quality gate before Phase 3.3.'

 # A. eligibility: runtime/state is excluded with a reason; config can shape it
 $elig=Get-AihContextEligibleFiles $ctxFixture
 $decElig=@($elig|Where-Object{$_.path -eq 'data/routing/decisions.jsonl'})[0]
 Assert-Aih ($null-ne$decElig-and-not$decElig.eligible-and"$($decElig.exclusionReason)"-match'nexus-runtime-defaults'-and$decElig.evidenceClass-eq'runtime-state') 'routing runtime state is ineligible review evidence with a recorded reason'
 $keepElig=@($elig|Where-Object{$_.path -eq 'data/routing/keep-manual.md'})[0]
 Assert-Aih ($keepElig.eligible-and$keepElig.evidenceClass-eq'runtime-state') 'config negation re-includes a runtime file as deprioritized runtime-state evidence'
 $fixElig=@($elig|Where-Object{$_.path -eq 'data/fixtures/expected.json'})[0]
 Assert-Aih ($fixElig.eligible-and$fixElig.evidenceClass-eq'config') 'legitimate data fixtures under data/ stay eligible (data is not globally banned)'
 $cfgExcl=@($elig|Where-Object{$_.path -eq 'third-party-generated/stuff.json'})[0]
 Assert-Aih (-not$cfgExcl.eligible-and"$($cfgExcl.exclusionReason)"-match'nexus-context-config') 'context exclusions are repository-configurable via .nexus.yml'
 $blockedElig=@($elig|Where-Object{$_.path -eq 'blocked-artifacts/leak.ps1'})[0]
 Assert-Aih (-not$blockedElig.eligible-and"$($blockedElig.exclusionReason)"-match'sensitivity') 'config negation cannot re-include security-blocked files'
 $envElig=@($elig|Where-Object{$_.path -eq '.env'})[0]
 Assert-Aih (-not$envElig.eligible-and"$($envElig.exclusionReason)"-match'sensitivity') 'sensitive files never enter review context'
 Assert-Aih ((@($elig|Where-Object{$_.path -eq 'scripts/intelligence/Intelligence.CodeStore.ps1'})[0]).evidenceClass-eq'source') 'source evidence classification is deterministic'
 Assert-Aih ((@($elig|Where-Object{$_.path -eq 'tests/Intelligence.CodeFoundation.Tests.ps1'})[0]).evidenceClass-eq'test') 'test evidence classification is deterministic'
 Assert-Aih ((@($elig|Where-Object{$_.path -eq 'docs/architecture/code-intelligence.md'})[0]).evidenceClass-eq'docs') 'docs evidence classification is deterministic'
 Assert-Aih ((@($elig|Where-Object{$_.path -eq 'config.json'})[0]).evidenceClass-eq'config') 'config evidence classification is deterministic'
 Assert-Aih ((@($elig|Where-Object{$_.path -eq 'gen/bundle.min.js'})[0]).evidenceClass-eq'generated') 'generated evidence classification is deterministic'

 # C. the runtime log cannot outrank or displace the real implementation/tests
 $ranked=@(Search-AihCode $ctxFixture $ctxQuery 0)
 Assert-Aih (@($ranked|Where-Object{$_.file -match 'data/routing/decisions\.jsonl'}).Count-eq0) 'decisions.jsonl no longer enters review retrieval at all'
 $firstSource=@($ranked|Where-Object{$_.evidenceClass -eq 'source'}|Select-Object -First 1)
 Assert-Aih ($null-ne$firstSource-and$firstSource.file-eq'scripts/intelligence/Intelligence.CodeStore.ps1') 'the specific implementation outranks every other candidate for the phase query'
 Assert-Aih (@($ranked|Where-Object{$_.file -eq 'tests/Intelligence.CodeFoundation.Tests.ps1'}).Count-eq1) 'the matching test file is retrieved as strong test evidence'

 # C2. repeating a generic word 1000x cannot dominate a specific identifier
 $repSearch=@(Search-AihCode $ctxFixture 'CodeIntelligenceStore review' 0)
 $repTop=$repSearch|Select-Object -First 1
 $logHits=@($repSearch|Where-Object{$_.file -eq 'artifacts/review.log'})
 Assert-Aih ($repTop.file-eq'src/CodeIntelligenceStore.ps1'-and@($logHits).Count-eq1-and$logHits[0].score-lt$repTop.score) '1000x word repetition stays far below a specific identifier match'

 # C3. stopword-only queries must not cause broad repository inclusion
 Assert-Aih (@(Search-AihCode $ctxFixture 'the and of to is was' 0).Count-eq0) 'stopword-only queries retrieve nothing'
 $stopBundle=New-AihContextBundle $ctxFixture $ctxTask.taskId 'the and of to is was' @() 0 0
 Assert-Aih (@($stopBundle.fileSlices).Count-eq0-and@($stopBundle.manifest.selection.meaningfulTerms).Count-eq0) 'stopword-only bundle stays empty with no meaningful terms'

 # C4. filename/path exact matches receive deterministic preference
 & $ctxWrite 'src/widget.service.ts' 'widget'
 & $ctxWrite 'docs/notes.md' (('widget content ' * 60))
 $pathSearch=@(Search-AihCode $ctxFixture 'widget' 0)
 $svc=@($pathSearch|Where-Object{$_.file -eq 'src/widget.service.ts'})[0]
 $notes=@($pathSearch|Where-Object{$_.file -eq 'docs/notes.md'})[0]
 Assert-Aih ($null-ne$svc-and$null-ne$notes-and$svc.score-gt$notes.score) 'exact filename/path matches outrank raw repetition'

 # D/E/G/H. unlimited bundle: relevance stays, budgets do not; manifest provenance
 $ctxBundle=New-AihContextBundle $ctxFixture $ctxTask.taskId $ctxQuery @() 0 0
 Assert-Aih ($ctxBundle.manifest.budget.maxContextTokens-eq0-and$ctxBundle.manifest.budget.maxFiles-eq0-and$ctxBundle.manifest.budget.enforceLimits-eq$false) 'unlimited bundle keeps explicit 0=unlimited budget semantics'
 Assert-Aih (@($ctxBundle.fileSlices|Where-Object{$_.truncated}).Count-eq0) 'unlimited bundle never truncates selected files solely for a budget'
 $bundlePaths=@($ctxBundle.fileSlices|ForEach-Object{$_.path})
 Assert-Aih (@($bundlePaths|Where-Object{$_ -match 'decisions\.jsonl'}).Count-eq0) 'bundle never selects routing runtime state as evidence'
 Assert-Aih (@($bundlePaths|Where-Object{$_ -eq 'scripts/intelligence/Intelligence.CodeStore.ps1'}).Count-eq1) 'bundle includes the real implementation'
 Assert-Aih (@($bundlePaths|Where-Object{$_ -eq 'tests/Intelligence.CodeFoundation.Tests.ps1'}).Count-eq1) 'bundle includes the real tests'
 Assert-Aih (@($bundlePaths|Where-Object{$_ -eq 'docs/architecture/code-intelligence.md'}).Count-eq1) 'docs-specific evidence remains retrievable'
 $implSlice=@($ctxBundle.fileSlices|Where-Object{$_.path -eq 'scripts/intelligence/Intelligence.CodeStore.ps1'})[0]
 Assert-Aih ($implSlice.score-gt0-and$implSlice.evidenceClass-eq'source'-and@($implSlice.matchedTerms).Count-gt0-and@($implSlice.pathMatches).Count-gt0) 'selected slices carry score/evidenceClass/matchedTerms/pathMatches provenance'
 $savedCtx=Get-Content -Raw (Join-Path $ctxFixture ".ai-harness/runs/$($ctxTask.taskId)/context-manifest.json")|ConvertFrom-Json
 Assert-Aih ($savedCtx.schemaVersion-eq3-and$savedCtx.taskId-eq$ctxTask.taskId) 'context manifest v3 persists with task identity (TASK-0012 extends provenance, never replaces it)'
 $ev0=@($savedCtx.selection.evidence)[0]
 Assert-Aih ($null-ne$ev0-and$ev0.path-and$null-ne$ev0.score-and$ev0.evidenceClass-and$null-ne$ev0.matchedTerms-and$null-ne$ev0.eligibility-and$ev0.reason) 'context manifest records per-file selection provenance'
 Assert-Aih ($null-ne$ev0.retrievalScore-and$null-ne$ev0.normalizedScore-and$null-ne$ev0.specificScore-and$null-ne$ev0.selectionReason-and$ev0.selectedByRelevance-eq$true-and$null-ne$ev0.matchedPhrases-and$null-ne$ev0.coverageContribution) 'TASK-0012: manifest carries retrievalScore/normalizedScore/specificScore/matchedPhrases/coverageContribution/selectionReason provenance'
 Assert-Aih ($null-ne$savedCtx.selection.concentration-and$savedCtx.selection.concentration.candidateCount-ge$savedCtx.selection.selectedEvidenceCount-and$savedCtx.selection.concentration.selectedCount-ge1-and$savedCtx.selection.selectedEvidenceCount-ge1) 'TASK-0012: manifest records the concentration decision (candidates vs selected)'
 Assert-Aih ($savedCtx.selection.nonSelectedTotal-ge0-and$null-ne$savedCtx.selection.nonSelectedEvidence) 'TASK-0012: manifest records non-selected floor-passing candidates with reasons'
 Assert-Aih ($savedCtx.selection.excludedByReason.'context-excluded:nexus-runtime-defaults:data/routing/**' -ge 1) 'context manifest records exclusion reasons with counts'
 Assert-Aih (@($savedCtx.selection.meaningfulTerms) -contains 'intelligence'-and@($savedCtx.selection.stoppedTerms) -contains 'the') 'manifest records meaningful and stopped query terms'
 Assert-Aih ($savedCtx.contextQuality.status-eq'pass'-and@($savedCtx.contextQuality.meaningfulEvidenceClasses).Count-gt0) 'context quality guard passes with meaningful evidence'

 # F. context-quality guard: no meaningful evidence -> structured failure, not garbage
 $guardFixture=New-Fixture 'ctxguard'
 try{
  New-Item -ItemType Directory -Force -Path (Join-Path $guardFixture 'data/routing')|Out-Null
  [IO.File]::WriteAllText((Join-Path $guardFixture 'data/routing/decisions.jsonl'),(('{"prompt":"review the routing decision"}')+"`n")*20,[Text.UTF8Encoding]::new($false))
  $guardTask=New-AihTask $guardFixture 'guard task' @('evidence')
  $guardBundle=New-AihContextBundle $guardFixture $guardTask.taskId 'review the routing decision' @() 0 0
  Assert-Aih (@($guardBundle.fileSlices).Count-eq0) 'context-quality failure produces an empty bundle instead of garbage'
  Assert-Aih ($guardBundle.manifest.contextQuality.status-eq'fail'-and$guardBundle.manifest.contextQuality.broadenRetryUsed-eq$true) 'context-quality guard fails closed after one deterministic broaden retry'
 }finally{Remove-Item -LiteralPath $guardFixture -Recurse -Force}
}finally{Remove-Item -LiteralPath $ctxFixture -Recurse -Force}

# ── TASK-0025 Class E: enumeration/materialization race degrades deterministically ──
# A candidate whose file vanishes between ranking and slice materialization
# must skip THAT slice with an honest provenance record, never abort the
# whole context build. Driven directly against Select-AihBundleSlices so the
# race is deterministic (no real deletion timing involved).
$raceFixture=New-Fixture 'ctxrace'
try{
 New-Item -ItemType Directory -Force -Path (Join-Path $raceFixture 'src')|Out-Null
 [IO.File]::WriteAllText((Join-Path $raceFixture 'src/keeper.ts'),'flux capacitor calibration keeper content',[Text.UTF8Encoding]::new($false))
 $ranked=[ordered]@{
  query='flux capacitor calibration';meaningfulTerms=@('flux','capacitor');stoppedTerms=@()
  relevanceFloor=0.05;scannedFiles=2;eligibleFiles=2;excludedFiles=0;excludedByReason=[ordered]@{}
  weakTerms=@();phrases=@();termImportance=[ordered]@{};concentration=[ordered]@{method='relative-confidence+coverage-saturation';strongConfidence=0.8;marginalCoverage=0.4;coverageConfidence=0.2;anchorScore=1.0;anchorSpecificScore=1.0;candidateCount=2;selectedCount=2;genericQuery=$false}
  candidates=@(
   [pscustomobject]@{file='src/vanished.ts';score=2.0;evidenceClass='source';classification='source';matchedTerms=@('flux','capacitor');matchedPhrases=@();pathMatches=@();selectedByRelevance=$true;selectionReason='race fixture';coverageContribution=$null;normalizedScore=1.0;specificScore=1.0},
   [pscustomobject]@{file='src/keeper.ts';score=1.5;evidenceClass='source';classification='source';matchedTerms=@('flux');matchedPhrases=@();pathMatches=@();selectedByRelevance=$true;selectionReason='race fixture';coverageContribution=$null;normalizedScore=0.75;specificScore=0.5}
  )
 }
 $raceSelection=Select-AihBundleSlices -Retrieval ([pscustomobject]$ranked) -WorkspaceRoot $raceFixture -UnlimitedTokens:$true -UnlimitedFiles:$true -MaxFiles 10 -MaxContextTokens 1000
 Assert-Aih (@($raceSelection.slices).Count-eq1-and$raceSelection.slices[0].path-eq'src/keeper.ts') 'vanished candidate is skipped deterministically; surviving candidate still selected'
 Assert-Aih ($raceSelection.used-gt0) 'skipped slice consumes no budget'
 Assert-Aih (@($raceSelection.materializationSkipped).Count-eq1-and$raceSelection.materializationSkipped[0].path-eq'src/vanished.ts'-and$raceSelection.materializationSkipped[0].reason-eq'file-removed-between-enumeration-and-materialization') 'materialization skip is recorded with an honest provenance reason'
}finally{Remove-Item -LiteralPath $raceFixture -Recurse -Force}

# ── TASK-0012: review-context concentration + provider diagnostics ───────────
# Deterministic regressions for the second-stage relevance concentration
# (query-term importance, phrase/compound evidence, relative/coverage
# selection, no fixed top-N) and for provider capacity packing + structured
# provider response diagnostics. Nexus budget semantics (0 = unlimited, null
# ceilings) stay exactly as TASK-0007/TASK-0009 left them.
$concFixture=New-Fixture 'conc'
try{
 $concDirs=@('src','tests','docs/architecture','config','ui','notes')
 foreach($d in $concDirs){New-Item -ItemType Directory -Force -Path (Join-Path $concFixture $d)|Out-Null}
 $concWrite={param($rel,$content)[IO.File]::WriteAllText((Join-Path $concFixture $rel),$content,[Text.UTF8Encoding]::new($false))}
 # domain-specific source, tests and docs
 & $concWrite 'src/FluxCapacitorStore.ts' "export class FluxCapacitorStore {`n  // FluxCapacitorStore implements the flux capacitor calibration store.`n  calibrate() { return 'flux capacitor calibration complete' }`n}"
 & $concWrite 'tests/FluxCapacitorStore.Tests.ts' "describe('FluxCapacitorStore', () => { it('validates flux capacitor calibration', () => {}) })"
 & $concWrite 'docs/architecture/flux-capacitor.md' ('# Flux Capacitor Calibration architecture' + "`n`n" + 'The flux capacitor calibration routine aligns the phase matrix.')
 # a scattered match: the same specific terms, far apart, NO compound evidence
 & $concWrite 'ui/scattered.ts' ('flux in one place.' + "`n" + 'capacitor in another.' + "`n" + 'calibration somewhere else.' + "`n" + (('review complete implementation quality gate tests code review complete ')*20))
 # generic controller/UI review vocabulary (no domain terms at all)
 $genericControllerText=(('review the complete implementation quality gate checks tests code review ')*40)
 & $concWrite 'config/ReviewController.cjs' $genericControllerText
 & $concWrite 'ui/ReviewPanel.cjs' $genericControllerText
 # generic fillers so the generic review vocabulary is genuinely BROAD in this corpus
 for($i=1;$i -le 12;$i++){ & $concWrite ('notes/note{0:d2}.md' -f $i) ("review note {0}: the complete implementation quality gate checks tests and code" -f $i) }
 $concTask=New-AihTask $concFixture 'concentration task' @('evidence')
 $concQuery='Review the complete flux capacitor calibration implementation and tests as the quality gate before release.'
 $concDomainFiles=@('src/FluxCapacitorStore.ts','tests/FluxCapacitorStore.Tests.ts','docs/architecture/flux-capacitor.md')
 $concGenericFiles=@('config/ReviewController.cjs','ui/ReviewPanel.cjs')

 # 1. domain-specific evidence outranks generic review/controller evidence
 $concRanked=@(Search-AihCode $concFixture $concQuery 0)
 $concDomainScores=@($concRanked|Where-Object{$concDomainFiles -contains $_.file})
 $concGenericScores=@($concRanked|Where-Object{$concGenericFiles -contains $_.file})
 $concMinDomain=($concDomainScores|Measure-Object -Property score -Minimum).Minimum
 $concMaxGeneric=($concGenericScores|Measure-Object -Property score -Maximum).Maximum
 Assert-Aih (@($concDomainScores).Count-eq3-and$null-ne$concMinDomain-and$null-ne$concMaxGeneric-and$concMinDomain-gt$concMaxGeneric) 'TASK-0012: domain-specific source/tests/docs outrank generic controller review vocabulary for a domain query'
 $concBundle=New-AihContextBundle $concFixture $concTask.taskId $concQuery @() 0 0
 $concPaths=@($concBundle.fileSlices|ForEach-Object{$_.path})
 Assert-Aih (@($concDomainFiles|Where-Object{$concPaths -contains $_}).Count-eq3) 'TASK-0012: concentrated bundle keeps implementation, tests and docs for the domain query'
 Assert-Aih (@($concGenericFiles|Where-Object{$concPaths -contains $_}).Count-eq0) 'TASK-0012: generic controller/UI files never enter the packet merely via generic review terminology'
 $concClasses=@($concBundle.fileSlices|Group-Object evidenceClass|ForEach-Object{$_.Name})
 Assert-Aih (($concClasses -contains 'source')-and($concClasses -contains 'test')-and($concClasses -contains 'docs')) 'TASK-0012: broad implementation review preserves source + test (+ docs) evidence coverage'

 # 2. a generic word appearing broadly cannot select nearly every eligible file
 $genericBundle=New-AihContextBundle $concFixture $concTask.taskId 'review' @() 0 0
 $genericEligible=$genericBundle.manifest.selection.eligibleFiles
 Assert-Aih (@($genericBundle.fileSlices).Count-le3-and$genericEligible-ge15) 'TASK-0012: a broadly-appearing generic word cannot cause nearly every eligible file to be selected'

 # 3. exact/compound domain terms outweigh independent generic matches
 $phraseFile=@($concRanked|Where-Object{$_.file -eq 'src/FluxCapacitorStore.ts'})[0]
 $scatteredFile=@($concRanked|Where-Object{$_.file -eq 'ui/scattered.ts'})[0]
 Assert-Aih ($null-ne$phraseFile-and$null-ne$scatteredFile-and$phraseFile.score-gt$scatteredFile.score) 'TASK-0012: compound/adjacent domain terms (flux capacitor calibration) outweigh independent generic matches'
 Assert-Aih ((@($phraseFile.matchedPhrases)-contains 'flux capacitor')-and(@($phraseFile.matchedPhrases)-contains 'flux capacitor calibration')) 'TASK-0012: phrase/compound query evidence is recorded as matchedPhrases'
 Assert-Aih (@($scatteredFile.matchedPhrases).Count-eq0) 'TASK-0012: scattered independent terms produce no phrase evidence'
 Assert-Aih (($concPaths -contains 'ui/scattered.ts')-eq$false) 'TASK-0012: a scattered generic-heavy file stays out of the concentrated packet'

 # 4/10. relative/coverage selection never uses a fixed top-N rule
 $concSliceCount=@($concBundle.fileSlices).Count
 Assert-Aih ($concSliceCount-lt$genericEligible-and$concSliceCount-ge3) 'TASK-0012: selection size follows relevance shape, not a fixed file count'

 # 5. adding 100 weakly related files does not materially enlarge the packet
 for($i=1;$i -le 100;$i++){ & $concWrite ('notes/weak{0:d3}.md' -f $i) ("review note {0} about generic engineering concerns" -f $i) }
 $concBundleAfterWeak=New-AihContextBundle $concFixture $concTask.taskId $concQuery @() 0 0
 $concPathsAfterWeak=@($concBundleAfterWeak.fileSlices|ForEach-Object{$_.path})
 Assert-Aih (@($concBundleAfterWeak.fileSlices).Count-le($concSliceCount+1)) 'TASK-0012: adding 100 weakly related files does not materially enlarge a focused review packet'

 # 6. a newly strongly relevant implementation file IS included
 & $concWrite 'src/FluxCapacitorIndex.ts' "export class FluxCapacitorIndex {`n  // flux capacitor calibration index for the phase matrix`n}"
 $concBundleAfterStrong=New-AihContextBundle $concFixture $concTask.taskId $concQuery @() 0 0
 $concPathsAfterStrong=@($concBundleAfterStrong.fileSlices|ForEach-Object{$_.path})
 Assert-Aih ($concPathsAfterStrong-contains'src/FluxCapacitorIndex.ts') 'TASK-0012: adding another strongly relevant implementation file includes it even with many files already selected'

 # 9. enforceLimits=false still exposes null Nexus budget ceilings (no 8/30000 replacement)
 $concPacket=New-AihReviewPacket $concFixture $concTask.taskId $concQuery @() '' @($concBundle.fileSlices) @() '' $policy -ContextMode 'bundle'
 Assert-Aih ($concPacket.budget.enforceLimits-eq$false-and$null-eq$concPacket.budget.maxFiles-and$null-eq$concPacket.budget.maxContextTokens-and$null-eq$concPacket.budget.maxDiffLines-and$null-eq$concPacket.budget.maxCallsPerTask-and$null-eq$concPacket.budget.maxOutputTokens) 'TASK-0012: enforceLimits=false still reports null Nexus ceilings (no disguised replacement budget)'
}finally{Remove-Item -LiteralPath $concFixture -Recurse -Force}

# 4/10. no fixed top-N: every strongly relevant file is selected (30 > any 8/12/20 cap)
$strongFixture=New-Fixture 'strong'
try{
 New-Item -ItemType Directory -Force -Path (Join-Path $strongFixture 'src'),(Join-Path $strongFixture 'notes')|Out-Null
 $strongWrite={param($rel,$content)[IO.File]::WriteAllText((Join-Path $strongFixture $rel),$content,[Text.UTF8Encoding]::new($false))}
 for($i=1;$i -le 30;$i++){ & $strongWrite ('src/module{0:d2}.ts' -f $i) ("flux capacitor calibration module {0} aligns the phase matrix deterministically" -f $i) }
 for($i=1;$i -le 5;$i++){ & $strongWrite ('notes/generic{0:d2}.md' -f $i) "review note $i about the complete implementation quality gate" }
 $strongTask=New-AihTask $strongFixture 'strong task' @('evidence')
 $strongBundle=New-AihContextBundle $strongFixture $strongTask.taskId 'Review the complete flux capacitor calibration implementation and tests as the quality gate before release.' @() 0 0
 $strongPaths=@($strongBundle.fileSlices|ForEach-Object{$_.path})
 Assert-Aih (@($strongBundle.fileSlices).Count-eq30-and@($strongBundle.fileSlices).Count-gt20) 'TASK-0012: 30 strongly relevant files are ALL selected (no 8/12/20 top-N replacement budget)'
 Assert-Aih (@($strongPaths|Where-Object{$_-like'notes/*'}).Count-eq0) 'TASK-0012: weak generic notes stay out even when 30 strong files are selected'
}finally{Remove-Item -LiteralPath $strongFixture -Recurse -Force}

# 8. documentation-specific query emphasizes docs without forced source/test quotas
$docsFixture=New-Fixture 'docsq'
try{
 New-Item -ItemType Directory -Force -Path (Join-Path $docsFixture 'docs/architecture'),(Join-Path $docsFixture 'src'),(Join-Path $docsFixture 'tests')|Out-Null
 $docsWrite={param($rel,$content)[IO.File]::WriteAllText((Join-Path $docsFixture $rel),$content,[Text.UTF8Encoding]::new($false))}
 & $docsWrite 'docs/architecture/orbital-telemetry.md' ('# Orbital Telemetry architecture' + "`n`n" + 'The orbital telemetry documentation covers the antenna calibration, downlink scheduling and the orbital telemetry data model.')
 & $docsWrite 'src/collector.ts' "export const orbitalTelemetryCollector = () => 'orbital telemetry samples'"
 & $docsWrite 'tests/placeholder.test.ts' "it('review the complete implementation quality gate', () => {})"
 $docsTask=New-AihTask $docsFixture 'docs query task' @('evidence')
 $docsBundle=New-AihContextBundle $docsFixture $docsTask.taskId 'Review the orbital telemetry architecture documentation.' @() 0 0
 $docsPaths=@($docsBundle.fileSlices|ForEach-Object{$_.path})
 Assert-Aih ($docsPaths-contains'docs/architecture/orbital-telemetry.md'-and@($docsBundle.fileSlices)[0].path-eq'docs/architecture/orbital-telemetry.md') 'TASK-0012: documentation-specific query prioritizes the documentation evidence first'
 Assert-Aih (($docsPaths -contains 'tests/placeholder.test.ts')-eq$false) 'TASK-0012: docs query applies no forced source/test quota (generic test file stays out)'
}finally{Remove-Item -LiteralPath $docsFixture -Recurse -Force}

# ── TASK-0012: provider capacity discovery + packing (unit level) ────────────
$capDir=New-Fixture 'cap'
try{
 # provider /models metadata that declares capacity wins
 $capFromModels=Get-AihReviewerModelCapacity -ModelId 'test-model' -ModelsDocument ([pscustomobject]@{data=@([pscustomobject]@{id='test-model';context_window=12345;max_output_tokens=777})}) -ModelRegistryPath ''
 Assert-Aih ($capFromModels.known-and$capFromModels.contextCapacity-eq12345-and$capFromModels.maxOutputTokens-eq777-and$capFromModels.source-eq'provider-models-metadata') 'TASK-0012: provider /models capacity metadata is honored when declared'
 # deterministic model-registry capability entry is the fallback source
 $testRegistryPath=Join-Path $capDir 'model-registry.json'
 [IO.File]::WriteAllText($testRegistryPath,'{"schemaVersion":1,"models":[{"id":"reg-model","contextWindow":4321,"maxOutputTokens":222}]}',[Text.UTF8Encoding]::new($false))
 $capFromRegistry=Get-AihReviewerModelCapacity -ModelId 'reg-model' -ModelsDocument $null -ModelRegistryPath $testRegistryPath
 Assert-Aih ($capFromRegistry.known-and$capFromRegistry.contextCapacity-eq4321-and$capFromRegistry.maxOutputTokens-eq222-and$capFromRegistry.source-eq'model-registry') 'TASK-0012: model-registry capability entry resolves provider capacity deterministically'
 # no source declares capacity => unknown, never fabricated
 [IO.File]::WriteAllText($testRegistryPath,'{"schemaVersion":1,"models":[{"id":"no-window"}]}',[Text.UTF8Encoding]::new($false))
 $capUnknown=Get-AihReviewerModelCapacity -ModelId 'no-window' -ModelsDocument ([pscustomobject]@{data=@([pscustomobject]@{id='no-window'})}) -ModelRegistryPath $testRegistryPath
 Assert-Aih ((-not$capUnknown.known)-and$null-eq$capUnknown.contextCapacity-and$capUnknown.source-eq'unknown') 'TASK-0012: unknown provider capacity is never fabricated'
 # provider metadata capacity beats the registry
 $capMixed=Get-AihReviewerModelCapacity -ModelId 'reg-model' -ModelsDocument ([pscustomobject]@{data=@([pscustomobject]@{id='reg-model';context_window=9999})}) -ModelRegistryPath $testRegistryPath
 Assert-Aih ($capMixed.known-and$capMixed.contextCapacity-eq9999-and$capMixed.source-eq'provider-models-metadata') 'TASK-0012: provider metadata is authoritative over the registry fallback'

 $packQuestion='Review the flux capacitor calibration implementation.'
 $packFiles=@(
  [pscustomobject]@{path='src/high.ts';score=10;evidenceClass='source';content=('x'*4000)},
  [pscustomobject]@{path='tests/high.test.ts';score=9;evidenceClass='test';content=('y'*4000)},
  [pscustomobject]@{path='src/low.ts';score=2;evidenceClass='source';content=('z'*4000)}
 )
 $packPacket=[pscustomobject][ordered]@{question=$packQuestion;invariants=@();diff='';relevantFiles=$packFiles;budget=[ordered]@{enforceLimits=$false;maxOutputTokens=$null}}
 # 11/12/13. known capacity packs deterministically, prefers stronger evidence, preserves coverage, records omissions
 $capKnown=[pscustomobject]@{known=$true;contextCapacity=[int64]3000;maxOutputTokens=[int64]100;source='test'}
 $packed=Invoke-AihProviderCapacityPacking -Packet $packPacket -Capacity $capKnown
 Assert-Aih ($packed.providerCapacityPacking-eq'applied'-and$packed.budgetEnforcement-eq'disabled'-and$packed.packedFileCount-eq2-and$packed.selectedFileCount-eq3) 'TASK-0012: known provider capacity deterministically packs the highest-value selected evidence'
 Assert-Aih (($packed.packedPaths-contains'src/high.ts')-and($packed.packedPaths-contains'tests/high.test.ts')-and(-not($packed.packedPaths-contains'src/low.ts'))) 'TASK-0012: packing prefers stronger evidence and preserves source+test coverage'
 Assert-Aih (@($packed.omittedForProviderCapacity).Count-eq1-and$packed.omittedForProviderCapacity[0].path-eq'src/low.ts'-and$packed.omittedForProviderCapacity[0].reason-eq'provider-capacity') 'TASK-0012: packing records every omitted file with its reason'
 Assert-Aih ($packed.providerCapacityKnown-and$packed.providerContextCapacity-eq3000-and$packed.reservedTokens-gt0-and$packed.packedTokens-gt0-and$packed.estimatedRequestTokens-ge$packed.packedTokens) 'TASK-0012: packing records capacity/reserved/packed/estimated token accounting'
 Assert-Aih ($packed.quality.status-eq'pass') 'TASK-0012: packing that preserves source and test evidence passes the post-packing quality check'
 # 14. unknown capacity: no packing, no invented context size
 $packedUnknown=Invoke-AihProviderCapacityPacking -Packet $packPacket -Capacity $capUnknown
 Assert-Aih ($packedUnknown.providerCapacityPacking-eq'unknown-capacity'-and$packedUnknown.packedFileCount-eq3-and$packedUnknown.providerContextCapacity-eq$null-and@($packedUnknown.omittedForProviderCapacity).Count-eq0) 'TASK-0012: unknown capacity packs nothing and invents no context size'
 # 19. packing that removes required evidence fails closed BEFORE the reviewer is called
 $packFilesFail=@(
  [pscustomobject]@{path='src/s1.ts';score=10;evidenceClass='source';content=('a'*4000)},
  [pscustomobject]@{path='src/s2.ts';score=9;evidenceClass='source';content=('b'*4000)},
  [pscustomobject]@{path='tests/t1.ts';score=8;evidenceClass='test';content=('c'*4000)},
  [pscustomobject]@{path='tests/t2.ts';score=7;evidenceClass='test';content=('d'*4000)}
 )
 $packPacketFail=[pscustomobject][ordered]@{question=$packQuestion;invariants=@();diff='';relevantFiles=$packFilesFail;budget=[ordered]@{enforceLimits=$false;maxOutputTokens=$null}}
 $packedFail=Invoke-AihProviderCapacityPacking -Packet $packPacketFail -Capacity $capKnown
 Assert-Aih ($packedFail.quality.status-eq'fail'-and$packedFail.quality.failureKind-eq'provider-capacity-insufficient-for-required-evidence') 'TASK-0012: packing that drops ALL test evidence fails as provider-capacity-insufficient-for-required-evidence'
 $capTiny=[pscustomobject]@{known=$true;contextCapacity=[int64]400;maxOutputTokens=[int64]100;source='test'}
 $packedTiny=Invoke-AihProviderCapacityPacking -Packet $packPacket -Capacity $capTiny
 Assert-Aih ($packedTiny.quality.status-eq'fail'-and$packedTiny.quality.failureKind-eq'provider-capacity-too-small-for-request') 'TASK-0012: capacity smaller than the reserved request fails structurally'
}finally{Remove-Item -LiteralPath $capDir -Recurse -Force}

# ── TASK-0012: structured provider response inspection ──────────────────────
$incompleteResponse='{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}'|ConvertFrom-Json
$incompleteKind=$false
try{Resolve-AihReviewOutputText $incompleteResponse|Out-Null}catch{$incompleteKind=$_.Exception.Message-match'provider-capacity-incomplete'-and$_.Exception.Message-match'max_output_tokens'}
Assert-Aih $incompleteKind 'TASK-0012: provider incomplete response without output_text becomes an explicit provider-capacity/incomplete error'
$shapeResponse='{"status":"completed","output":[{"type":"reasoning","content":[{"type":"reasoning_text","text":"thinking"}]}]}'|ConvertFrom-Json
$shapeKind=$false
try{Resolve-AihReviewOutputText $shapeResponse|Out-Null}catch{$shapeKind=$_.Exception.Message-match'provider-response-shape'-and$_.Exception.Message-match'reasoning_text'}
Assert-Aih $shapeKind 'TASK-0012: completed response with unexpected shape becomes a structured provider-response-shape error'
$providerErrorResponse='{"status":"failed","error":{"message":"quota exceeded","type":"rate_limit","code":"429"}}'|ConvertFrom-Json
$providerErrorKind=$false
try{Resolve-AihReviewOutputText $providerErrorResponse|Out-Null}catch{$providerErrorKind=$_.Exception.Message-match'provider-error'-and$_.Exception.Message-match'rate_limit'-and$_.Exception.Message-match'429'}
Assert-Aih $providerErrorKind 'TASK-0012: explicit provider errors surface their message/type/code'
Assert-Aih ((Resolve-AihReviewOutputText ('{"output_text":"direct text"}'|ConvertFrom-Json))-eq'direct text') 'TASK-0012: valid direct output_text responses still parse exactly as before'
$nestedResponse='{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"part1"},{"type":"output_text","text":"part2"}]}]}'|ConvertFrom-Json
Assert-Aih ((Resolve-AihReviewOutputText $nestedResponse)-eq("part1`npart2")) 'TASK-0012: valid nested output_text responses still parse exactly as before'
$shapeInspect=Get-AihReviewResponseShape $nestedResponse
Assert-Aih ($shapeInspect.status-eq'completed'-and($shapeInspect.outputTypes-contains'message')-and($shapeInspect.contentTypes-contains'output_text')) 'TASK-0012: response shape inspection records status/output types/content types'

# ── TASK-0012: safe review transport diagnostics ─────────────────────────────
$diagFixture=New-Fixture 'diag'
try{
 $diagTask=New-AihTask $diagFixture 'diagnostic task' @('evidence')
 $diagShape=Get-AihReviewResponseShape $providerErrorResponse
 Write-AihReviewTransportDiagnostic -Workspace $diagFixture -TaskId $diagTask.taskId -TaskInstanceId $diagTask.taskInstanceId -Provider 'sol-local' -Model 'gpt-5.6-sol' -Shape $diagShape -ErrorText 'Authorization: Bearer supersecret123 plus sk-abcdef123456 leaked' -EstimatedPacketTokens 12345 -SelectedFileCount 19 -ProviderCapacityKnown $true -ProviderCapacityPacking 'not-needed'
 $diagPath=Join-Path $diagFixture ".ai-harness/runs/$($diagTask.taskId)/review-transport-diagnostic.json"
 Assert-Aih (Test-Path -LiteralPath $diagPath) 'TASK-0012: failed review transport persists a diagnostic artifact in the task run directory'
 $diagRaw=Get-Content -Raw -LiteralPath $diagPath
 Assert-Aih (($diagRaw-notmatch'supersecret123')-and($diagRaw-notmatch'sk-abcdef123456')-and($diagRaw-notmatch'Bearer ')) 'TASK-0012: no credentials are ever written to diagnostics'
 $diagDoc=$diagRaw|ConvertFrom-Json
 Assert-Aih ($diagDoc.taskId-eq$diagTask.taskId-and$diagDoc.taskInstanceId-eq$diagTask.taskInstanceId-and$diagDoc.provider-eq'sol-local'-and$diagDoc.model-eq'gpt-5.6-sol'-and$diagDoc.responseStatus-eq'failed'-and$diagDoc.providerError.type-eq'rate_limit'-and$diagDoc.estimatedPacketTokens-eq12345-and$diagDoc.selectedFileCount-eq19-and$diagDoc.providerCapacityKnown-and$diagDoc.timestamp) 'TASK-0012: diagnostic carries taskId/instance/provider/model/status/error/usage-fields/capacity state'
 # manifest packing annotations: budgetEnforcement vs providerCapacityPacking distinction
 $manifestPath=Join-Path $diagFixture ".ai-harness/runs/$($diagTask.taskId)/context-manifest.json"
 Write-AihAtomicJson $manifestPath ([ordered]@{schemaVersion=3;taskId=$diagTask.taskId;selection=[ordered]@{evidence=@(
   [ordered]@{path='src/a.ts';retrievalScore=10;evidenceClass='source'},
   [ordered]@{path='tests/a.test.ts';retrievalScore=9;evidenceClass='test'},
   [ordered]@{path='src/b.ts';retrievalScore=2;evidenceClass='source'}
 )}})
 $diagPacking=[pscustomobject]@{providerCapacityKnown=$true;providerContextCapacity=[int64]100000;capacitySource='model-registry';budgetEnforcement='disabled';providerCapacityPacking='applied';estimatedRequestTokens=[int64]50000;reservedTokens=[int64]6000;packedTokens=[int64]44000;packedFileCount=2;packedPaths=@('src/a.ts','tests/a.test.ts');omittedForProviderCapacity=@([ordered]@{path='src/b.ts';reason='provider-capacity'})}
 Update-AihContextManifestProviderPacking -Workspace $diagFixture -TaskId $diagTask.taskId -Packing $diagPacking
 $manifestUpdated=Get-Content -Raw -LiteralPath $manifestPath|ConvertFrom-Json
 Assert-Aih ($manifestUpdated.providerPacking.budgetEnforcement-eq'disabled'-and$manifestUpdated.providerPacking.providerCapacityPacking-eq'applied'-and$manifestUpdated.providerPacking.providerContextCapacity-eq100000) 'TASK-0012: manifest distinguishes disabled Nexus budget enforcement from applied provider capacity packing'
 $manifestA=@($manifestUpdated.selection.evidence|Where-Object{$_.path-eq'src/a.ts'})[0]
 $manifestB=@($manifestUpdated.selection.evidence|Where-Object{$_.path-eq'src/b.ts'})[0]
 Assert-Aih ($manifestA.includedInProviderPacket-and$null-eq$manifestA.providerOmissionReason-and(-not$manifestB.includedInProviderPacket)-and$manifestB.providerOmissionReason-eq'provider-capacity') 'TASK-0012: manifest evidence entries record includedInProviderPacket/providerOmissionReason packing provenance'
}finally{Remove-Item -LiteralPath $diagFixture -Recurse -Force}

$conflicts=Test-AihTaskWriteConflict @([pscustomobject]@{taskId='A';writePaths=@('x.ts')},[pscustomobject]@{taskId='B';writePaths=@('x.ts','y.ts')})
Assert-Aih ($conflicts.hasConflicts-and$conflicts.conflicts[0].paths-eq'x.ts') 'overlapping parallel writes are detected'

$worktreeFixture=New-Fixture worktree
$worktreeRoot=New-Fixture worktree_root
try{
 & git -C $worktreeFixture init -q;& git -C $worktreeFixture config user.email test@example.invalid;& git -C $worktreeFixture config user.name 'AIH Test';[IO.File]::WriteAllText((Join-Path $worktreeFixture 'file.txt'),'base',[Text.UTF8Encoding]::new($false));& git -C $worktreeFixture add file.txt;& git -C $worktreeFixture commit -qm base
 $wtTask=New-AihTask $worktreeFixture 'isolated task' @('isolated');$wt=New-AihTaskWorktree $worktreeFixture $wtTask.taskId $worktreeRoot
 Assert-Aih ($wt.baseCommit-eq$wtTask.baseCommit-and(Test-Path (Join-Path $wt.worktreePath 'file.txt'))) 'worktree uses exact recorded base commit and isolates task'
 & git -C $worktreeFixture worktree remove --force $wt.worktreePath|Out-Null
}finally{if(Test-Path $worktreeFixture){Remove-Item -LiteralPath $worktreeFixture -Recurse -Force};if(Test-Path $worktreeRoot){Remove-Item -LiteralPath $worktreeRoot -Recurse -Force}}


# --- Nexus UI customization -------------------------------------------------
$nexusUiPackage = Join-Path $layout.Data 'profiles/node_modules/@nexus/ui-brand/package.json'
Assert-Aih (Test-Path -LiteralPath $nexusUiPackage) 'Nexus UI package installed into the profile module fallback'
$homePatch = Join-Path $layout.Data 'cordis.patch.yml'
$homePatchText = Get-Content -Raw -Encoding UTF8 -LiteralPath $homePatch
Assert-Aih ($homePatchText.Contains('nexus-ui-brand') -and $homePatchText.Contains('ui-brand-official') -and $homePatchText.Contains('disabled: true')) 'home patch composes Nexus brand and disables the official DeepSeek brand'
$distDir = Join-Path $layout.App 'node_modules/@deepseek-ai/dsh-web-frontend/dist'
Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $distDir 'index.html')).Contains('<title>Nexus</title>')) 'dist index title is Nexus'
Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $distDir 'favicon.svg')).Contains('#7C5CFF')) 'dist favicon is the Nexus mark'
$distManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $distDir 'manifest.webmanifest') | ConvertFrom-Json
Assert-Aih ([string]$distManifest.name -eq 'Nexus' -and [string]$distManifest.short_name -eq 'Nexus') 'PWA manifest identity is Nexus'
$rendererBundle = Join-Path $layout.App 'node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js'
Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath $rendererBundle).Contains('const productTitle = "Nexus"')) 'runtime document title is Nexus'
Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $layout.App 'node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js')).Contains('panels.sidebar === 0 ? 288 : panels.sidebar')) 'expanded sidebar default is 288px'
$liveConversation = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $layout.App 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js')
Assert-Aih ($liveConversation.Contains('background:var(--dsw-alias-button-primary-fill);color:#fff')) 'composer send button uses violet primary'
Assert-Aih ($liveConversation.Contains('#7C5CFF') -and -not $liveConversation.Contains('#6187D8')) 'hero glow tinted violet'
Assert-Aih ($liveConversation.Contains('const inert = pendingWorkspaceId !== void 0 || sessionId === void 0 || hero && chipTitle === void 0;')) 'live UI blocks old-session submission during workspace transition'
Assert-Aih ((Test-Path -LiteralPath (Join-Path $distDir 'assets/nexus-logo.png')) -and (Test-Path -LiteralPath (Join-Path $distDir 'assets/nexus-mark.png'))) 'Nexus brand assets served from dist'

$fixture = New-Fixture 'nexus-ui'
try {
    $fixtureApp = Join-Path $fixture 'app/node_modules/@deepseek-ai'
    $fixtureFrontend = Join-Path $fixtureApp 'dsh-web-frontend'
    $fixtureDist = Join-Path $fixtureFrontend 'dist'
    New-Item -ItemType Directory -Force -Path $fixtureDist | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixtureFrontend 'package.json'), '{"name":"@deepseek-ai/dsh-web-frontend","version":"0.1.1-rc.2"}', [Text.UTF8Encoding]::new($false))
    # Non-ASCII copy strings are read from patch-copy.json (explicit UTF-8) —
    # never inlined as literals — because a BOM-less script file is decoded with
    # the system ANSI codepage by Windows PowerShell 5.1, which would corrupt
    # the fixture on non-UTF-8 codepages. The fixture must mirror the pinned
    # bundle byte-for-byte on every machine.
    $fixtureCopy = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'ui/nexus-ui/patch-copy.json') | ConvertFrom-Json
    # Fixture files deliberately use CRLF line endings to prove the patch is line-ending tolerant.
    [IO.File]::WriteAllText((Join-Path $fixtureDist 'index.html'), "<!doctype html>`r`n<html><head><title>DeepSeek Harness</title></head><body></body></html>", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureDist 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureDist 'manifest.webmanifest'), '{"id":"/","name":"DeepSeek Harness","short_name":"DSH","display":"fullscreen"}', [Text.UTF8Encoding]::new($false))
    $fixtureRenderer = Join-Path $fixtureApp 'dsh-client-ui-renderer/lib'
    New-Item -ItemType Directory -Force -Path $fixtureRenderer | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixtureRenderer 'client.js'), "const productTitle = ""DeepSeek Harness"";`r`n", [Text.UTF8Encoding]::new($false))
    $fixtureConversation = Join-Path $fixtureApp 'dsh-client-ui-conversation/lib'
    New-Item -ItemType Directory -Force -Path $fixtureConversation | Out-Null
    $conversationFixture = $fixtureCopy.heroHeadline[0].from + ",`r`n" + $fixtureCopy.heroHeadline[1].from + "`r`nconst inert = sessionId === void 0 || hero && chipTitle === void 0;`r`nbackground:var(--dsw-alias-button-info-fill);color:#fff`r`nvar(--dsw-alias-button-info-hover)`r`n#6187D8`r`n"
    [IO.File]::WriteAllText((Join-Path $fixtureConversation 'client.js'), $conversationFixture, [Text.UTF8Encoding]::new($false))
    $fixtureLayout = Join-Path $fixtureApp 'dsh-client-ui-layout/lib'
    New-Item -ItemType Directory -Force -Path $fixtureLayout | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixtureLayout 'client.js'), "const w = { sidebar: 280, details: 0 };`r`nd.sidebar = d.sidebar === 0 ? 280 : 0;`r`nconst w = panels.sidebar === 0 ? 280 : panels.sidebar;`r`n", [Text.UTF8Encoding]::new($false))
    $fixtureModelSel = Join-Path $fixtureApp 'dsh-client-ui-model-selection/lib'
    New-Item -ItemType Directory -Force -Path $fixtureModelSel | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixtureModelSel 'client.js'), "const x = effortLabel !== void 0 && (0, react_jsx_runtime.jsx)(`"span`", {`r`n", [Text.UTF8Encoding]::new($false))
    $composerContract = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'ui/nexus-ui/composer-contract.json') | ConvertFrom-Json
    foreach ($composerPatch in $composerContract.patches) {
        $composerPackage = Join-Path $fixtureApp $composerPatch.package
        [IO.File]::WriteAllText((Join-Path $composerPackage 'package.json'), '{"version":"0.1.1-rc.2"}', [Text.UTF8Encoding]::new($false))
        [IO.File]::AppendAllText((Join-Path $composerPackage 'lib/client.js'), "`r`n" + $composerPatch.before.Replace("`n", "`r`n"), [Text.UTF8Encoding]::new($false))
    }
    $fixtureModels = Join-Path $fixtureApp 'dsh-client-ui-settings-models/lib'
    New-Item -ItemType Directory -Force -Path $fixtureModels | Out-Null
    # Build the welcome-notice block from the exact copy strings in patch-copy.json so the
    # fixture mirrors the pinned bundle byte-for-byte (including the literal backslash-n sequences).
    # The zh continue label is composed from codepoints so the fixture stays
    # byte-faithful on any ANSI codepage (patch-copy.json carries no key for it
    # and the patcher never rewrites it).
    $zhContinue = '"' + [string][char]0x7EE7 + [string][char]0x7EED + '"'
    $noticeBlock = "const WELCOME_NOTICE_COPY = {`r`n`t`t`tzh: {`r`n`t`t`t`ttitle: " + $fixtureCopy.welcomeNotice.titleZh.from + ",`r`n`t`t`t`tbody: " + $fixtureCopy.welcomeNotice.bodyZh.from + "`r`n`t`t`t`tcontinueLabel: " + $zhContinue + "`r`n`t`t`t},`r`n`t`t`ten: {`r`n`t`t`t`ttitle: " + $fixtureCopy.welcomeNotice.titleEn.from + ",`r`n`t`t`t`tbody: " + $fixtureCopy.welcomeNotice.bodyEn.from + "`r`n`t`t`t`tcontinueLabel: ""Continue""`r`n`t`t`t}`r`n`t`t};"
    [IO.File]::WriteAllText((Join-Path $fixtureModels 'client.js'), $noticeBlock, [Text.UTF8Encoding]::new($false))
    $fixtureData = Join-Path $fixture 'data'
    New-Item -ItemType Directory -Force -Path (Join-Path $fixtureData 'profiles/node_modules') | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixtureData 'settings.yaml'), "agent-default-model:`r`n  provider: flash-max-direct`r`n", [Text.UTF8Encoding]::new($false))

    & (Join-Path $InstallRoot 'scripts/Patch-NexusUi.ps1') -InstallRoot $fixture -SourceRoot $InstallRoot
    if ($LASTEXITCODE -ne 0) { throw 'Nexus UI patch failed on the fixture' }
    Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureDist 'index.html')).Contains('<title>Nexus</title>')) 'fixture: dist title patched'
    Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureDist 'favicon.svg')).Contains('#7C5CFF')) 'fixture: favicon replaced with Nexus mark'
    $fixtureManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureDist 'manifest.webmanifest') | ConvertFrom-Json
    Assert-Aih ([string]$fixtureManifest.name -eq 'Nexus') 'fixture: manifest name patched'
    Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureRenderer 'client.js')).Contains('const productTitle = "Nexus"')) 'fixture: renderer title patched'
    $fixtureConversationText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureConversation 'client.js')
    Assert-Aih ($fixtureConversationText.Contains($fixtureCopy.heroHeadline[0].to) -and $fixtureConversationText.Contains($fixtureCopy.heroHeadline[1].to)) 'fixture: hero headlines patched (en + zh)'
    Assert-Aih ($fixtureConversationText.Contains('const inert = pendingWorkspaceId !== void 0 || sessionId === void 0 || hero && chipTitle === void 0;')) 'fixture: workspace transition blocks submission to the previous session'
    $fixtureLayoutText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureLayout 'client.js')
    Assert-Aih ($fixtureLayoutText.Contains('sidebar: 288,') -and $fixtureLayoutText.Contains('d.sidebar === 0 ? 288 : 0')) 'fixture: sidebar default width patched to 288'
    Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureModelSel 'client.js')).Contains('!modelLabel.toUpperCase().endsWith(effortLabel.toUpperCase())')) 'fixture: model effort dedupe patched'
    Assert-Aih ($fixtureConversationText.Contains('background:var(--dsw-alias-button-primary-fill);color:#fff') -and $fixtureConversationText.Contains('var(--dsw-alias-button-primary-hover)') -and $fixtureConversationText.Contains('#7C5CFF') -and -not $fixtureConversationText.Contains('#6187D8')) 'fixture: send button violet + glow tinted'
    Assert-Aih ((Test-Path -LiteralPath (Join-Path $fixtureDist 'assets/nexus-logo.png')) -and (Test-Path -LiteralPath (Join-Path $fixtureDist 'assets/nexus-mark.png'))) 'fixture: brand assets copied to dist'
    $fixtureModelsText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureModels 'client.js')
    Assert-Aih ($fixtureModelsText.Contains('About Nexus') -and $fixtureModelsText.Contains($fixtureCopy.welcomeNotice.titleZh.to) -and -not $fixtureModelsText.Contains('Internal Testing Notice')) 'fixture: welcome notice patched'
    Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureData 'settings.yaml')).Contains('preference: dark')) 'fixture: dark theme default added'
    Assert-Aih (Test-Path -LiteralPath (Join-Path $fixtureData 'profiles/node_modules/@nexus/ui-brand/package.json')) 'fixture: Nexus package installed'

    $firstIndex = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureDist 'index.html')
    $firstModels = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureModels 'client.js')
    $firstRenderer = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureRenderer 'client.js')
    $firstConversation = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureConversation 'client.js')
    $firstLayout = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureLayout 'client.js')
    & (Join-Path $InstallRoot 'scripts/Patch-NexusUi.ps1') -InstallRoot $fixture -SourceRoot $InstallRoot
    if ($LASTEXITCODE -ne 0) { throw 'Nexus UI patch failed on the second run' }
    $secondIndex = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureDist 'index.html')
    $secondModels = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureModels 'client.js')
    $secondRenderer = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureRenderer 'client.js')
    $secondConversation = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureConversation 'client.js')
    $secondLayout = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureLayout 'client.js')
    Assert-Aih ($firstIndex.Hash -eq $secondIndex.Hash -and $firstModels.Hash -eq $secondModels.Hash -and $firstRenderer.Hash -eq $secondRenderer.Hash -and $firstConversation.Hash -eq $secondConversation.Hash -and $firstLayout.Hash -eq $secondLayout.Hash) 'fixture: Nexus patch is idempotent (second run changes nothing)'

    $modelSeatPath = Join-Path $fixtureModelSel 'client.js'
    $modelSeatText = Get-Content -Raw -Encoding UTF8 -LiteralPath $modelSeatPath
    $modelSeatContract = $composerContract.patches | Where-Object { $_.package -eq 'dsh-client-ui-model-selection' }
    foreach ($invalidSeat in @('changed', 'duplicate', 'mixed')) {
        $brokenSeat = switch ($invalidSeat) {
            'changed' { $modelSeatText.Replace('}, NexusModelPreference));', '}, UnexpectedPreference));') }
            'duplicate' { $modelSeatText + "`n" + $modelSeatContract.after }
            'mixed' { $modelSeatText + "`n" + $modelSeatContract.before }
        }
        [IO.File]::WriteAllText($modelSeatPath, $brokenSeat, [Text.UTF8Encoding]::new($false))
        $rejectedSeat = $false
        try { & (Join-Path $InstallRoot 'scripts/Patch-NexusComposer.ps1') -InstallRoot $fixture -SourceRoot $InstallRoot }
        catch { $rejectedSeat = $true }
        Assert-Aih $rejectedSeat "fixture: composer patch rejects $invalidSeat upstream contract"
        Assert-Aih ((Get-FileHash -LiteralPath (Join-Path $fixtureConversation 'client.js')).Hash -eq $secondConversation.Hash) 'fixture: failed composer preflight leaves conversation bundle unchanged'
    }
    [IO.File]::WriteAllText($modelSeatPath, $modelSeatText, [Text.UTF8Encoding]::new($false))
    $modelSeatManifest = Join-Path (Split-Path -Parent $fixtureModelSel) 'package.json'
    [IO.File]::WriteAllText($modelSeatManifest, '{"version":"0.1.2"}', [Text.UTF8Encoding]::new($false))
    $rejectedVersion = $false
    try { & (Join-Path $InstallRoot 'scripts/Patch-NexusComposer.ps1') -InstallRoot $fixture -SourceRoot $InstallRoot }
    catch { $rejectedVersion = $true }
    Assert-Aih $rejectedVersion 'fixture: composer patch rejects an unpinned package version'
    [IO.File]::WriteAllText($modelSeatManifest, '{"version":"0.1.1-rc.2"}', [Text.UTF8Encoding]::new($false))

    # Fail-closed: when the pinned upstream structure changes, the patch must refuse.
    [IO.File]::WriteAllText((Join-Path $fixtureRenderer 'client.js'), "const productTitle = ""Something Else"";`r`n", [Text.UTF8Encoding]::new($false))
    $refused = $false
    try {
        & (Join-Path $InstallRoot 'scripts/Patch-NexusUi.ps1') -InstallRoot $fixture -SourceRoot $InstallRoot
    }
    catch { $refused = $true }
    Assert-Aih $refused 'fixture: Nexus patch fails closed on changed upstream structure'
}
finally {
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}

# --- TASK-0004: Verify-Project.ps1 exit-code contract ------------------------
# Verify-Project.ps1 reports FAILED CHECKS by exiting non-zero while still
# emitting the complete structured JSON on stdout. The controller bridge
# consumes that JSON as a VALID failed-verification result (never an
# infrastructure exception); the exit-code contract is pinned here.
$verifyFixture = New-Fixture 'verify-exit'
try {
    $verifyWorkspace = Join-Path $verifyFixture 'ws'
    New-Item -ItemType Directory -Force -Path (Join-Path $verifyWorkspace '.ai-harness') | Out-Null
    [IO.File]::WriteAllText((Join-Path $verifyWorkspace '.ai-harness/verification.yml'), "version: 1`nmode: replace`ncommands:`n  - name: pass-check`n    kind: test`n    workingDirectory: .`n    command: node -v`n    required: true`n    timeoutSeconds: 60`n", [Text.UTF8Encoding]::new($false))
    $verifyOut = & $aihPsHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts/Verify-Project.ps1') -Workspace $verifyWorkspace -InstallRoot $InstallRoot -TaskId TASK-FIXTURE -Kind all -ContinueOnFailure -Json 2>$null | Out-String
    $verifyExit = $LASTEXITCODE
    $verifyJson = $verifyOut | ConvertFrom-Json
    Assert-Aih ($verifyExit -eq 0) 'Verify-Project.ps1 exits 0 when all checks pass'
    Assert-Aih ($verifyJson.Passed -ge 1 -and $verifyJson.Failed -eq 0) 'passing workspace reports Passed>=1, Failed=0'
    Assert-Aih ($null -ne $verifyJson.Results) 'passing JSON carries the Results rows'
    [IO.File]::WriteAllText((Join-Path $verifyWorkspace '.ai-harness/verification.yml'), "version: 1`nmode: replace`ncommands:`n  - name: fail-check`n    kind: test`n    workingDirectory: .`n    command: cmd /c exit 3`n    required: true`n    timeoutSeconds: 60`n", [Text.UTF8Encoding]::new($false))
    $verifyOut2 = & $aihPsHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts/Verify-Project.ps1') -Workspace $verifyWorkspace -InstallRoot $InstallRoot -TaskId TASK-FIXTURE -Kind all -ContinueOnFailure -Json 2>$null | Out-String
    $verifyExit2 = $LASTEXITCODE
    $verifyJson2 = $verifyOut2 | ConvertFrom-Json
    Assert-Aih ($verifyExit2 -eq 1) 'Verify-Project.ps1 exits 1 when checks fail'
    Assert-Aih ($verifyJson2.Failed -ge 1) 'failing workspace reports Failed>=1'
    Assert-Aih (@($verifyJson2.Results | Where-Object { $_.Status -eq 'FAIL' }).Count -ge 1) 'failing JSON carries the FAIL result rows'
    Assert-Aih ($verifyJson2.Results | Where-Object { $_.Status -eq 'FAIL' } | Select-Object -First 1).ExitCode -eq 3 'failing row keeps the real exit code'

    # ── RC5 schema invariant (TASK-0025): EVERY Invoke-AihVerificationCommand
    # result carries the SAME shape. Consumers (the controller bridge, JSON
    # reports) read StandardOutput/StandardError/WorkingDirectory
    # unconditionally; the unavailable branch used to return an abbreviated
    # object and crashed the real Linux controller run.
    $vpText = [IO.File]::ReadAllText((Join-Path $InstallRoot 'scripts/Verify-Project.ps1'))
    $vpParseErrors = $null
    $vpAst = [System.Management.Automation.Language.Parser]::ParseInput($vpText, [ref]$null, [ref]$vpParseErrors)
    $vpFns = @('ConvertTo-AihArgument', 'Get-AihExecutableLaunch', 'Invoke-AihVerificationCommand')
    $extracted = New-Object Text.StringBuilder
    foreach ($fn in $vpAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $vpFns -contains $a.Name }, $true)) {
        [void]$extracted.AppendLine($fn.Extent.Text)
    }
    Assert-Aih ($vpParseErrors.Count -eq 0 -and $extracted.Length -gt 0) 'Verify-Project functions extract cleanly for schema probing'
    Invoke-Expression ($extracted.ToString())
    $schemaKeys = @('Name','Kind','Status','ExitCode','DurationSeconds','StartedAtUtc','FinishedAtUtc','Command','WorkingDirectory','StandardOutput','StandardError','Error')
    foreach ($scenario in @(
        @{ name='PASS'; command=[pscustomobject]@{ Name='schema-pass'; Kind='test'; Required=$true; Available=$true; Display='exit 0'; ShellCommand='exit 0'; Executable=''; Arguments=@(); WorkingDirectory=$InstallRoot; TimeoutSeconds=30 } },
        @{ name='FAIL'; command=[pscustomobject]@{ Name='schema-fail'; Kind='test'; Required=$true; Available=$true; Display='exit 3'; ShellCommand='exit 3'; Executable=''; Arguments=@(); WorkingDirectory=$InstallRoot; TimeoutSeconds=30 } },
        @{ name='SKIP/unavailable'; command=[pscustomobject]@{ Name='schema-skip'; Kind='test'; Required=$false; Available=$false; Display='missing-tool'; ShellCommand=''; Executable=''; Arguments=@(); WorkingDirectory=$InstallRoot; TimeoutSeconds=30 } },
        @{ name='timeout'; command=[pscustomobject]@{ Name='schema-timeout'; Kind='test'; Required=$true; Available=$true; Display='sleep'; ShellCommand='Start-Sleep -Seconds 8'; Executable=''; Arguments=@(); WorkingDirectory=$InstallRoot; TimeoutSeconds=1 } },
        @{ name='process-start error'; command=[pscustomobject]@{ Name='schema-start-error'; Kind='test'; Required=$true; Available=$true; Display='bad cwd'; ShellCommand='exit 0'; Executable=''; Arguments=@(); WorkingDirectory=(Join-Path $InstallRoot 'definitely/missing/dir'); TimeoutSeconds=30 } }
    )) {
        $schemaResult = Invoke-AihVerificationCommand $scenario.command
        foreach ($schemaKey in $schemaKeys) {
            Assert-Aih ($null -ne $schemaResult.PSObject.Properties[$schemaKey]) ('verification result (' + $scenario.name + ') carries ' + $schemaKey)
        }
    }
    $skipResult = Invoke-AihVerificationCommand ([pscustomobject]@{ Name='schema-skip2'; Kind='test'; Required=$false; Available=$false; Display='missing-tool'; ShellCommand=''; Executable=''; Arguments=@(); WorkingDirectory=$InstallRoot; TimeoutSeconds=30 })
    Assert-Aih ($skipResult.Status -eq 'SKIP' -and $skipResult.StandardOutput -eq '' -and $skipResult.StandardError -eq '' -and -not [string]::IsNullOrEmpty($skipResult.WorkingDirectory) -and -not [string]::IsNullOrEmpty($skipResult.Error)) 'SKIP result carries empty stdout/stderr plus WorkingDirectory and Error'
    $passResult = Invoke-AihVerificationCommand ([pscustomobject]@{ Name='schema-pass2'; Kind='test'; Required=$true; Available=$true; Display='exit 0'; ShellCommand='exit 0'; Executable=''; Arguments=@(); WorkingDirectory=$InstallRoot; TimeoutSeconds=30 })
    Assert-Aih ($passResult.Status -eq 'PASS' -and $passResult.ExitCode -eq 0) 'PASS result keeps status and exit code'
    $failResult = Invoke-AihVerificationCommand ([pscustomobject]@{ Name='schema-fail2'; Kind='test'; Required=$true; Available=$true; Display='exit 3'; ShellCommand='exit 3'; Executable=''; Arguments=@(); WorkingDirectory=$InstallRoot; TimeoutSeconds=30 })
    Assert-Aih ($failResult.Status -eq 'FAIL' -and $failResult.ExitCode -eq 3) 'FAIL result keeps status and exit code'
    $timeoutResult = Invoke-AihVerificationCommand ([pscustomobject]@{ Name='schema-timeout2'; Kind='test'; Required=$true; Available=$true; Display='sleep'; ShellCommand='Start-Sleep -Seconds 8'; Executable=''; Arguments=@(); WorkingDirectory=$InstallRoot; TimeoutSeconds=1 })
    Assert-Aih ($timeoutResult.Status -eq 'FAIL' -and $timeoutResult.Error -match 'Timed out') 'timeout result fails with a timeout error'
    $startErrorResult = Invoke-AihVerificationCommand ([pscustomobject]@{ Name='schema-start-error2'; Kind='test'; Required=$true; Available=$true; Display='bad cwd'; ShellCommand='exit 0'; Executable=''; Arguments=@(); WorkingDirectory=(Join-Path $InstallRoot 'definitely/missing/dir'); TimeoutSeconds=30 })
    Assert-Aih ($startErrorResult.Status -eq 'FAIL' -and -not [string]::IsNullOrEmpty($startErrorResult.Error)) 'process-start error result fails with the error text'
}
finally {
    if (Test-Path -LiteralPath $verifyFixture) { Remove-Item -LiteralPath $verifyFixture -Recurse -Force }
}
# --- SEC001 placeholder policy + scoped data/tmp exclusion --------------------
# SEC001 recognizes ONLY explicit placeholder forms in DEEPSEEK_API_KEY values
# ($env:NAME, $var, braced interpolation, <YOUR_KEY>, <REPLACE_...>); the
# data/tmp exclusion is scoped to SEC001 alone (no loop-level continue), so
# later rules keep operating on runtime/scratch files. Fixture content is
# assembled at runtime so the test source itself never contains a
# secret-shaped literal.
$secFixture = New-Fixture 'sec001'
try {
    $secWs = Join-Path $secFixture 'ws'
    New-Item -ItemType Directory -Force -Path (Join-Path $secWs 'src') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $secWs 'data') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $secWs 'tmp') | Out-Null
    $sq = [char]39
    $secWrite = { param($rel, $content) [IO.File]::WriteAllText((Join-Path $secWs $rel), $content, [Text.UTF8Encoding]::new($false)) }
    $keyLine = { param($value, $sep) ('{0}{1}{2}{3}{2}' -f 'DEEPSEEK_API_KEY', $sep, $sq, $value) }
    & $secWrite 'src/real-key.ps1'   ((& $keyLine 'abcdef1234567890abcdef1234567890' '=') + [Environment]::NewLine)
    & $secWrite 'src/real-sk.ps1'    ((& $keyLine ('sk-' + 'abcdefghijklmnop1234') '=') + [Environment]::NewLine)
    & $secWrite 'src/sk-token.txt'   (('export TOKEN=' + ('sk-' + '0123456789abcdef0123456789')) + [Environment]::NewLine)
    & $secWrite 'src/env-ph.ps1'     ((& $keyLine ('$env:AIH_DEEPSEEK_API_KEY') '=') + [Environment]::NewLine)
    & $secWrite 'src/braced-ph.ps1'  ((& $keyLine ('${DEEPSEEK_API_KEY}') '=') + [Environment]::NewLine)
    & $secWrite 'src/your-ph.ps1'    ((& $keyLine '<YOUR_KEY>' '=') + [Environment]::NewLine)
    & $secWrite 'src/replace-ph.ps1' ((& $keyLine '<REPLACE_WITH_YOUR_KEY>' '=') + [Environment]::NewLine)
    & $secWrite 'src/suspicious.ps1' ((& $keyLine 'not-a-placeholder' '=') + [Environment]::NewLine)
    & $secWrite 'src/angle-susp.ps1' ((& $keyLine '<secret>' '=') + [Environment]::NewLine)
    & $secWrite 'data/creds.yaml'    ((& $keyLine ('sk-' + 'abcdefghijklmnop1234') (':' + ' ')) + [Environment]::NewLine)
    & $secWrite 'tmp/scratch.txt'    ((& $keyLine ('sk-' + 'abcdefghijklmnop1234') (':' + ' ')) + [Environment]::NewLine)
    $secResult = Invoke-AihArchitectureRules $secWs
    $secFindings = @($secResult.findings | Where-Object { $_.ruleId -eq 'SEC001' })
    Assert-Aih ($secResult.status -eq 'FAIL') 'SEC001 fixture workspace reports FAIL'
    # Finding file values carry platform separators (Get-AihWorkspaceFiles);
    # normalize before comparing so the assertions hold on Windows AND POSIX.
    $secNorm = { param($f) ($f -replace '\\', '/') }
    Assert-Aih (@($secFindings | Where-Object { (& $secNorm $_.file) -eq 'src/real-key.ps1' }).Count -eq 1) 'SEC001 blocks a real DeepSeek key assignment'
    Assert-Aih (@($secFindings | Where-Object { (& $secNorm $_.file) -eq 'src/real-sk.ps1' }).Count -eq 1) 'SEC001 blocks sk-* material in a key assignment'
    Assert-Aih (@($secFindings | Where-Object { (& $secNorm $_.file) -eq 'src/sk-token.txt' }).Count -eq 1) 'SEC001 blocks standalone sk-* tokens'
    Assert-Aih (@($secFindings | Where-Object { (& $secNorm $_.file) -eq 'src/env-ph.ps1' }).Count -eq 0) 'SEC001 allows $env:NAME placeholders'
    Assert-Aih (@($secFindings | Where-Object { (& $secNorm $_.file) -eq 'src/braced-ph.ps1' }).Count -eq 0) 'SEC001 allows braced interpolation placeholders'
    Assert-Aih (@($secFindings | Where-Object { (& $secNorm $_.file) -eq 'src/your-ph.ps1' }).Count -eq 0) 'SEC001 allows <YOUR_KEY> placeholders'
    Assert-Aih (@($secFindings | Where-Object { (& $secNorm $_.file) -eq 'src/replace-ph.ps1' }).Count -eq 0) 'SEC001 allows <REPLACE_...> placeholders'
    Assert-Aih (@($secFindings | Where-Object { (& $secNorm $_.file) -eq 'src/suspicious.ps1' }).Count -eq 1) 'SEC001 blocks a suspicious non-placeholder value'
    Assert-Aih (@($secFindings | Where-Object { (& $secNorm $_.file) -eq 'src/angle-susp.ps1' }).Count -eq 1) 'SEC001 blocks unrecognized angle-bracket values'
    Assert-Aih (@($secFindings | Where-Object { (& $secNorm $_.file) -like 'data/*' -or (& $secNorm $_.file) -like 'tmp/*' }).Count -eq 0) 'SEC001 data/tmp exclusion still suppresses runtime scratch state'
    $arSource = [IO.File]::ReadAllText((Join-Path $InstallRoot 'scripts/ArchitectureRules.ps1'))
    Assert-Aih (-not $arSource.Contains('{continue}')) 'no loop-level continue exempts data/tmp from later rules'
    Assert-Aih ($arSource.Contains('^(data|tmp)[\\/]')) 'SEC001-scoped runtime/scratch exclusion present'
    Assert-Aih (($secResult.rules -join ',') -eq 'SEC001,MIG001') 'both architecture rules still reported'
}
finally {
    if (Test-Path -LiteralPath $secFixture) { Remove-Item -LiteralPath $secFixture -Recurse -Force }
}
# TASK-0005: .ai-harness is controller-owned RUNTIME state (ledger, run
# manifests, bindings). Task descriptions legitimately embed user prompt text
# (recovery format specs can name stale reasons like 'task' + '-instance' +
# '-mismatch', which the credential pattern reads as a sk- prefixed token), so
# runtime state is excluded from the SOURCE credential scan like data/logs are.
# TASK-0026: the runtime-state exclusion is PATH-COMPONENT based and
# separator-agnostic (the previous FullName regex required backslashes
# around every excluded component, so on Linux NO tree was ever excluded
# and runtime state with credential-shaped task text entered the scan).
$sourceFiles=Get-AihSourceScanFiles -Root $InstallRoot
$secretLeak=$sourceFiles|Select-String -Pattern '(?i)(sk-[A-Za-z0-9_-]{16,}|DEEPSEEK_API_KEY\s*:\s*[^\s''"]+)'|Select-Object -First 1
Assert-Aih ($null-eq$secretLeak) 'source contains no credential values'

# Separator-agnostic exclusion regression: runtime/state components are
# excluded under BOTH separator styles while real source stays scanned.
Assert-Aih (Test-AihSourceScanPathExcluded 'data\routing\decisions.jsonl') 'source scan excludes data by backslash relative path'
Assert-Aih (Test-AihSourceScanPathExcluded 'data/routing/decisions.jsonl') 'source scan excludes data by slash relative path'
Assert-Aih (Test-AihSourceScanPathExcluded '.ai-harness\state\tasks.json') 'source scan excludes .ai-harness by backslash relative path'
Assert-Aih (Test-AihSourceScanPathExcluded '.ai-harness/state/decisions.jsonl') 'source scan excludes .ai-harness by slash relative path'
Assert-Aih (Test-AihSourceScanPathExcluded 'runtime\node\lib\x.js') 'source scan excludes runtime by backslash relative path'
Assert-Aih (Test-AihSourceScanPathExcluded 'runtime/node/bin/node') 'source scan excludes runtime by slash relative path'
Assert-Aih (-not (Test-AihSourceScanPathExcluded 'src\real-key.ps1')) 'source scan keeps real source (backslash style)'
Assert-Aih (-not (Test-AihSourceScanPathExcluded 'src/real-key.ps1')) 'source scan keeps real source (slash style)'
Assert-Aih (-not (Test-AihSourceScanPathExcluded 'src/appended/x.ps1')) 'source scan matches whole components only'
$scanFixture=Join-Path ([IO.Path]::GetTempPath()) ('aih-scan-'+[guid]::NewGuid().ToString('N'))
try{
 New-Item -ItemType Directory -Force -Path (Join-Path $scanFixture 'src'),(Join-Path $scanFixture 'data/routing'),(Join-Path $scanFixture '.ai-harness/state')|Out-Null
 # Benign bytes: the regression proves ENUMERATION scope (which files the
 # scan sees), not content matching - the suite source itself must never
 # embed credential-shaped strings.
 [IO.File]::WriteAllText((Join-Path $scanFixture 'src/keeper.ps1'),'kept source file',[Text.UTF8Encoding]::new($false))
 [IO.File]::WriteAllText((Join-Path $scanFixture 'data/routing/decisions.jsonl'),'{"prompt":"runtime state record"}',[Text.UTF8Encoding]::new($false))
 [IO.File]::WriteAllText((Join-Path $scanFixture '.ai-harness/state/tasks.json'),'{"description":"task state record"}',[Text.UTF8Encoding]::new($false))
 $scanned=@(Get-AihSourceScanFiles -Root $scanFixture)
 Assert-Aih ($scanned.Count-eq1-and$scanned[0].Name-eq'keeper.ps1') 'enumerated source scan excludes runtime/state trees on this filesystem'
}finally{Remove-Item -LiteralPath $scanFixture -Recurse -Force}
foreach($script in Get-ChildItem (Join-Path $InstallRoot 'scripts') -Filter '*.ps1'){[void][scriptblock]::Create((Get-Content -Raw $script.FullName))}
Assert-Aih $true 'all PowerShell scripts parse'
& $layout.Node (Join-Path $InstallRoot 'tests/DeepSeekIsolation.Tests.cjs');Assert-Aih ($LASTEXITCODE-eq0) 'runtime isolation tests pass'
Write-Host "RESULT: $passed deterministic assertions passed."
