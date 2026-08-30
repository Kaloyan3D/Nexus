[CmdletBinding()]param([string]$InstallRoot='C:\AI-Harness')
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
. (Join-Path $InstallRoot 'scripts\Common.ps1')
. (Join-Path $InstallRoot 'scripts\Routing.ps1')
. (Join-Path $InstallRoot 'scripts\TaskController.ps1')
. (Join-Path $InstallRoot 'scripts\ContextEngine.ps1')
. (Join-Path $InstallRoot 'scripts\OutputDigest.ps1')
. (Join-Path $InstallRoot 'scripts\CodexReview.ps1')
. (Join-Path $InstallRoot 'scripts\WorktreeManager.ps1')
. (Join-Path $InstallRoot 'scripts\ArchitectureRules.ps1')
. (Join-Path $InstallRoot 'scripts\Telemetry.ps1')
. (Join-Path $InstallRoot 'scripts\Completion.ps1')
. (Join-Path $InstallRoot 'scripts\ControlRoom.ps1')

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
 Assert-Aih ((Test-Path (Join-Path $fixture ".ai-harness\runs\$($task.taskId)\attempts.jsonl"))) 'attempt journal persists independently of conversation'
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
 [IO.File]::WriteAllText((Join-Path $fixture 'src\widget.ts'),"export interface Widget { id: string }`nexport function findWidget(id: string) { return id }",[Text.UTF8Encoding]::new($false))
 [IO.File]::WriteAllText((Join-Path $fixture 'README.md'),'Widget lookup documentation',[Text.UTF8Encoding]::new($false))
 $map=New-AihRepositoryMap $fixture
 Assert-Aih (@(Find-AihSymbol $map 'findWidget').Count-eq1) 'context engine retrieves relevant symbols'
 Assert-Aih (@(Search-AihCode $fixture 'widget lookup').Count-gt0) 'lexical retrieval ranks matching code and docs'
 $context=New-AihContextBundle $fixture $task2.taskId 'fix findWidget lookup' @('works') 500 2
 Assert-Aih ($context.manifest.budget.estimatedTokens-le500-and@($context.fileSlices).Count-le2) 'context budget is enforced'
 Assert-Aih (-not$context.manifest.repositoryMap.fullRepositoryIncluded) 'context engine never marks automatic full-repo content ingestion'
 $savedManifest=Get-Content -Raw (Join-Path $fixture ".ai-harness\runs\$($task2.taskId)\context-manifest.json")|ConvertFrom-Json
 Assert-Aih ($savedManifest.taskId-eq$task2.taskId-and$savedManifest.budget.maxFiles-eq2) 'stable machine-readable context manifest is persisted'

 $raw=(1..1000|ForEach-Object{"noise line $_"})-join"`n";$raw+="`nFAIL tests/widget.test.ts:18 Expected: 1 Actual: 2"
 $digest=New-AihOutputDigest $fixture $task2.taskId test $raw 1 1000
 Assert-Aih ($digest.summaryCharacters-le1020-and$digest.summary-match'Expected: 1 Actual: 2') 'large logs become bounded summaries preserving failure'
 Assert-Aih ((Get-Content -Raw $digest.rawPath).Length-eq$raw.Length) 'raw output remains accessible as an artifact'

 $slice=[pscustomobject]@{path='src/widget.ts';content='export function findWidget() {}'}
 $packet=New-AihReviewPacket $fixture $task2.taskId 'Is lookup safe?' @('no duplicate execution') 'one line diff' @($slice) @() 'DeepSeek is uncertain' $policy
 Assert-Aih ($packet.enforcement.allowed-and$packet.enforcement.readOnly-and$packet.enforcement.freshContext-and-not$packet.enforcement.completionAuthority) 'review packet is bounded fresh read-only and has no completion authority'
 $oversized=New-AihReviewPacket $fixture $task2.taskId 'review' @() ((1..2600|ForEach-Object{'x'})-join"`n") @($slice) @() '' $policy
 Assert-Aih (-not$oversized.enforcement.allowed-and$oversized.enforcement.violations-match'diff line limit') 'automatic Codex review is rejected over hard diff limit'
 $call=Register-AihCodexReviewCall $fixture $task2.taskId $packet
 Assert-Aih ($call.executionClass-eq'reviewer'-and-not$call.completionAuthority) 'bounded review call registration cannot own completion'
 $secondBlocked=$false;try{Register-AihCodexReviewCall $fixture $task2.taskId $packet|Out-Null}catch{$secondBlocked=$_.Exception.Message-match'DO NOT CALL CODEX'}
 Assert-Aih $secondBlocked 'hard per-task Codex call limit cannot be bypassed by prompting'
 $telemetry=Write-AihTaskTelemetry $fixture $critical.taskId @{model='deepseek-v4-flash';provider='flash-max-direct';inputTokens=100;outputTokens=20;contextSize=400;filesSupplied=2;filesModified=1;diffLines=5;finalResult='complete';configuration='deepseek-only'}
 Assert-Aih ($telemetry.codexCalls-eq0-and$telemetry.model-eq'deepseek-v4-flash') 'cost regression telemetry records normal zero-Codex execution'
 $learning=Add-AihLearning $fixture $task2.taskId static-rule 'prevent duplicate execution'
 Assert-Aih (-not$learning.approvedForAutomation) 'model learnings cannot automatically change policy'
}finally{Remove-Item -LiteralPath $fixture -Recurse -Force}

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
$nexusUiPackage = Join-Path $layout.Data 'profiles\node_modules\@nexus\ui-brand\package.json'
Assert-Aih (Test-Path -LiteralPath $nexusUiPackage) 'Nexus UI package installed into the profile module fallback'
$homePatch = Join-Path $layout.Data 'cordis.patch.yml'
$homePatchText = Get-Content -Raw -Encoding UTF8 -LiteralPath $homePatch
Assert-Aih ($homePatchText.Contains('nexus-ui-brand') -and $homePatchText.Contains('ui-brand-official') -and $homePatchText.Contains('disabled: true')) 'home patch composes Nexus brand and disables the official DeepSeek brand'
$distDir = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-web-frontend\dist'
Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $distDir 'index.html')).Contains('<title>Nexus</title>')) 'dist index title is Nexus'
Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $distDir 'favicon.svg')).Contains('#7C5CFF')) 'dist favicon is the Nexus mark'
$distManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $distDir 'manifest.webmanifest') | ConvertFrom-Json
Assert-Aih ([string]$distManifest.name -eq 'Nexus' -and [string]$distManifest.short_name -eq 'Nexus') 'PWA manifest identity is Nexus'
$rendererBundle = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-client-ui-renderer\lib\client.js'
Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath $rendererBundle).Contains('const productTitle = "Nexus"')) 'runtime document title is Nexus'
Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-client-ui-layout\lib\client.js')).Contains('panels.sidebar === 0 ? 288 : panels.sidebar')) 'expanded sidebar default is 288px'
$liveConversation = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\client.js')
Assert-Aih ($liveConversation.Contains('background:var(--dsw-alias-button-primary-fill);color:#fff')) 'composer send button uses violet primary'
Assert-Aih ($liveConversation.Contains('#7C5CFF') -and -not $liveConversation.Contains('#6187D8')) 'hero glow tinted violet'
Assert-Aih ((Test-Path -LiteralPath (Join-Path $distDir 'assets\nexus-logo.png')) -and (Test-Path -LiteralPath (Join-Path $distDir 'assets\nexus-mark.png'))) 'Nexus brand assets served from dist'

$fixture = New-Fixture 'nexus-ui'
try {
    $fixtureApp = Join-Path $fixture 'app\node_modules\@deepseek-ai'
    $fixtureFrontend = Join-Path $fixtureApp 'dsh-web-frontend'
    $fixtureDist = Join-Path $fixtureFrontend 'dist'
    New-Item -ItemType Directory -Force -Path $fixtureDist | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixtureFrontend 'package.json'), '{"name":"@deepseek-ai/dsh-web-frontend","version":"0.1.1-rc.2"}', [Text.UTF8Encoding]::new($false))
    # Fixture files deliberately use CRLF line endings to prove the patch is line-ending tolerant.
    [IO.File]::WriteAllText((Join-Path $fixtureDist 'index.html'), "<!doctype html>`r`n<html><head><title>DeepSeek Harness</title></head><body></body></html>", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureDist 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureDist 'manifest.webmanifest'), '{"id":"/","name":"DeepSeek Harness","short_name":"DSH","display":"fullscreen"}', [Text.UTF8Encoding]::new($false))
    $fixtureRenderer = Join-Path $fixtureApp 'dsh-client-ui-renderer\lib'
    New-Item -ItemType Directory -Force -Path $fixtureRenderer | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixtureRenderer 'client.js'), "const productTitle = ""DeepSeek Harness"";`r`n", [Text.UTF8Encoding]::new($false))
    $fixtureConversation = Join-Path $fixtureApp 'dsh-client-ui-conversation\lib'
    New-Item -ItemType Directory -Force -Path $fixtureConversation | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixtureConversation 'client.js'), """hero.headline"": ""Into the Unknown"",`r`n""hero.headline"": ""探索未至之境""`r`nbackground:var(--dsw-alias-button-info-fill);color:#fff`r`nvar(--dsw-alias-button-info-hover)`r`n#6187D8`r`n", [Text.UTF8Encoding]::new($false))
    $fixtureLayout = Join-Path $fixtureApp 'dsh-client-ui-layout\lib'
    New-Item -ItemType Directory -Force -Path $fixtureLayout | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixtureLayout 'client.js'), "const w = { sidebar: 280, details: 0 };`r`nd.sidebar = d.sidebar === 0 ? 280 : 0;`r`nconst w = panels.sidebar === 0 ? 280 : panels.sidebar;`r`n", [Text.UTF8Encoding]::new($false))
    $fixtureModelSel = Join-Path $fixtureApp 'dsh-client-ui-model-selection\lib'
    New-Item -ItemType Directory -Force -Path $fixtureModelSel | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixtureModelSel 'client.js'), "const x = effortLabel !== void 0 && (0, react_jsx_runtime.jsx)(`"span`", {`r`n", [Text.UTF8Encoding]::new($false))
    $fixtureModels = Join-Path $fixtureApp 'dsh-client-ui-settings-models\lib'
    New-Item -ItemType Directory -Force -Path $fixtureModels | Out-Null
    # Build the welcome-notice block from the exact copy strings in patch-copy.json so the
    # fixture mirrors the pinned bundle byte-for-byte (including the literal backslash-n sequences).
    $fixtureCopy = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'ui\nexus-ui\patch-copy.json') | ConvertFrom-Json
    $noticeBlock = "const WELCOME_NOTICE_COPY = {`r`n`t`t`tzh: {`r`n`t`t`t`ttitle: " + $fixtureCopy.welcomeNotice.titleZh.from + ",`r`n`t`t`t`tbody: " + $fixtureCopy.welcomeNotice.bodyZh.from + "`r`n`t`t`t`tcontinueLabel: `"继续`"`r`n`t`t`t},`r`n`t`t`ten: {`r`n`t`t`t`ttitle: " + $fixtureCopy.welcomeNotice.titleEn.from + ",`r`n`t`t`t`tbody: " + $fixtureCopy.welcomeNotice.bodyEn.from + "`r`n`t`t`t`tcontinueLabel: `"Continue`"`r`n`t`t`t}`r`n`t`t};"
    [IO.File]::WriteAllText((Join-Path $fixtureModels 'client.js'), $noticeBlock, [Text.UTF8Encoding]::new($false))
    $fixtureData = Join-Path $fixture 'data'
    New-Item -ItemType Directory -Force -Path (Join-Path $fixtureData 'profiles\node_modules') | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixtureData 'settings.yaml'), "agent-default-model:`r`n  provider: flash-max-direct`r`n", [Text.UTF8Encoding]::new($false))

    & (Join-Path $InstallRoot 'scripts\Patch-NexusUi.ps1') -InstallRoot $fixture -SourceRoot $InstallRoot
    if ($LASTEXITCODE -ne 0) { throw 'Nexus UI patch failed on the fixture' }
    Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureDist 'index.html')).Contains('<title>Nexus</title>')) 'fixture: dist title patched'
    Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureDist 'favicon.svg')).Contains('#7C5CFF')) 'fixture: favicon replaced with Nexus mark'
    $fixtureManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureDist 'manifest.webmanifest') | ConvertFrom-Json
    Assert-Aih ([string]$fixtureManifest.name -eq 'Nexus') 'fixture: manifest name patched'
    Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureRenderer 'client.js')).Contains('const productTitle = "Nexus"')) 'fixture: renderer title patched'
    $fixtureConversationText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureConversation 'client.js')
    Assert-Aih ($fixtureConversationText.Contains('Nexus — deterministic AI engineering') -and $fixtureConversationText.Contains('Nexus — 确定性 AI 工程')) 'fixture: hero headlines patched (en + zh)'
    $fixtureLayoutText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureLayout 'client.js')
    Assert-Aih ($fixtureLayoutText.Contains('sidebar: 288,') -and $fixtureLayoutText.Contains('d.sidebar === 0 ? 288 : 0')) 'fixture: sidebar default width patched to 288'
    Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureModelSel 'client.js')).Contains('!modelLabel.toUpperCase().endsWith(effortLabel.toUpperCase())')) 'fixture: model effort dedupe patched'
    Assert-Aih ($fixtureConversationText.Contains('background:var(--dsw-alias-button-primary-fill);color:#fff') -and $fixtureConversationText.Contains('var(--dsw-alias-button-primary-hover)') -and $fixtureConversationText.Contains('#7C5CFF') -and -not $fixtureConversationText.Contains('#6187D8')) 'fixture: send button violet + glow tinted'
    Assert-Aih ((Test-Path -LiteralPath (Join-Path $fixtureDist 'assets\nexus-logo.png')) -and (Test-Path -LiteralPath (Join-Path $fixtureDist 'assets\nexus-mark.png'))) 'fixture: brand assets copied to dist'
    $fixtureModelsText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureModels 'client.js')
    Assert-Aih ($fixtureModelsText.Contains('About Nexus') -and $fixtureModelsText.Contains('关于 Nexus') -and -not $fixtureModelsText.Contains('Internal Testing Notice')) 'fixture: welcome notice patched'
    Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureData 'settings.yaml')).Contains('preference: dark')) 'fixture: dark theme default added'
    Assert-Aih (Test-Path -LiteralPath (Join-Path $fixtureData 'profiles\node_modules\@nexus\ui-brand\package.json')) 'fixture: Nexus package installed'

    $firstIndex = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureDist 'index.html')
    $firstModels = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureModels 'client.js')
    $firstRenderer = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureRenderer 'client.js')
    $firstConversation = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureConversation 'client.js')
    $firstLayout = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureLayout 'client.js')
    & (Join-Path $InstallRoot 'scripts\Patch-NexusUi.ps1') -InstallRoot $fixture -SourceRoot $InstallRoot
    if ($LASTEXITCODE -ne 0) { throw 'Nexus UI patch failed on the second run' }
    $secondIndex = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureDist 'index.html')
    $secondModels = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureModels 'client.js')
    $secondRenderer = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureRenderer 'client.js')
    $secondConversation = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureConversation 'client.js')
    $secondLayout = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureLayout 'client.js')
    Assert-Aih ($firstIndex.Hash -eq $secondIndex.Hash -and $firstModels.Hash -eq $secondModels.Hash -and $firstRenderer.Hash -eq $secondRenderer.Hash -and $firstConversation.Hash -eq $secondConversation.Hash -and $firstLayout.Hash -eq $secondLayout.Hash) 'fixture: Nexus patch is idempotent (second run changes nothing)'

    # Fail-closed: when the pinned upstream structure changes, the patch must refuse.
    [IO.File]::WriteAllText((Join-Path $fixtureRenderer 'client.js'), "const productTitle = ""Something Else"";`r`n", [Text.UTF8Encoding]::new($false))
    $refused = $false
    try {
        & (Join-Path $InstallRoot 'scripts\Patch-NexusUi.ps1') -InstallRoot $fixture -SourceRoot $InstallRoot
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
    [IO.File]::WriteAllText((Join-Path $verifyWorkspace '.ai-harness\verification.yml'), "version: 1`nmode: replace`ncommands:`n  - name: pass-check`n    kind: test`n    workingDirectory: .`n    command: node -v`n    required: true`n    timeoutSeconds: 60`n", [Text.UTF8Encoding]::new($false))
    $verifyOut = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\Verify-Project.ps1') -Workspace $verifyWorkspace -InstallRoot $InstallRoot -TaskId TASK-FIXTURE -Kind all -ContinueOnFailure -Json 2>$null | Out-String
    $verifyExit = $LASTEXITCODE
    $verifyJson = $verifyOut | ConvertFrom-Json
    Assert-Aih ($verifyExit -eq 0) 'Verify-Project.ps1 exits 0 when all checks pass'
    Assert-Aih ($verifyJson.Passed -ge 1 -and $verifyJson.Failed -eq 0) 'passing workspace reports Passed>=1, Failed=0'
    Assert-Aih ($null -ne $verifyJson.Results) 'passing JSON carries the Results rows'
    [IO.File]::WriteAllText((Join-Path $verifyWorkspace '.ai-harness\verification.yml'), "version: 1`nmode: replace`ncommands:`n  - name: fail-check`n    kind: test`n    workingDirectory: .`n    command: cmd /c exit 3`n    required: true`n    timeoutSeconds: 60`n", [Text.UTF8Encoding]::new($false))
    $verifyOut2 = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\Verify-Project.ps1') -Workspace $verifyWorkspace -InstallRoot $InstallRoot -TaskId TASK-FIXTURE -Kind all -ContinueOnFailure -Json 2>$null | Out-String
    $verifyExit2 = $LASTEXITCODE
    $verifyJson2 = $verifyOut2 | ConvertFrom-Json
    Assert-Aih ($verifyExit2 -eq 1) 'Verify-Project.ps1 exits 1 when checks fail'
    Assert-Aih ($verifyJson2.Failed -ge 1) 'failing workspace reports Failed>=1'
    Assert-Aih (@($verifyJson2.Results | Where-Object { $_.Status -eq 'FAIL' }).Count -ge 1) 'failing JSON carries the FAIL result rows'
    Assert-Aih ($verifyJson2.Results | Where-Object { $_.Status -eq 'FAIL' } | Select-Object -First 1).ExitCode -eq 3 'failing row keeps the real exit code'
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
    & $secWrite 'src\real-key.ps1'   ((& $keyLine 'abcdef1234567890abcdef1234567890' '=') + [Environment]::NewLine)
    & $secWrite 'src\real-sk.ps1'    ((& $keyLine ('sk-' + 'abcdefghijklmnop1234') '=') + [Environment]::NewLine)
    & $secWrite 'src\sk-token.txt'   (('export TOKEN=' + ('sk-' + '0123456789abcdef0123456789')) + [Environment]::NewLine)
    & $secWrite 'src\env-ph.ps1'     ((& $keyLine ('$env:AIH_DEEPSEEK_API_KEY') '=') + [Environment]::NewLine)
    & $secWrite 'src\braced-ph.ps1'  ((& $keyLine ('${DEEPSEEK_API_KEY}') '=') + [Environment]::NewLine)
    & $secWrite 'src\your-ph.ps1'    ((& $keyLine '<YOUR_KEY>' '=') + [Environment]::NewLine)
    & $secWrite 'src\replace-ph.ps1' ((& $keyLine '<REPLACE_WITH_YOUR_KEY>' '=') + [Environment]::NewLine)
    & $secWrite 'src\suspicious.ps1' ((& $keyLine 'not-a-placeholder' '=') + [Environment]::NewLine)
    & $secWrite 'src\angle-susp.ps1' ((& $keyLine '<secret>' '=') + [Environment]::NewLine)
    & $secWrite 'data\creds.yaml'    ((& $keyLine ('sk-' + 'abcdefghijklmnop1234') (':' + ' ')) + [Environment]::NewLine)
    & $secWrite 'tmp\scratch.txt'    ((& $keyLine ('sk-' + 'abcdefghijklmnop1234') (':' + ' ')) + [Environment]::NewLine)
    $secResult = Invoke-AihArchitectureRules $secWs
    $secFindings = @($secResult.findings | Where-Object { $_.ruleId -eq 'SEC001' })
    Assert-Aih ($secResult.status -eq 'FAIL') 'SEC001 fixture workspace reports FAIL'
    Assert-Aih (@($secFindings | Where-Object { $_.file -eq 'src\real-key.ps1' }).Count -eq 1) 'SEC001 blocks a real DeepSeek key assignment'
    Assert-Aih (@($secFindings | Where-Object { $_.file -eq 'src\real-sk.ps1' }).Count -eq 1) 'SEC001 blocks sk-* material in a key assignment'
    Assert-Aih (@($secFindings | Where-Object { $_.file -eq 'src\sk-token.txt' }).Count -eq 1) 'SEC001 blocks standalone sk-* tokens'
    Assert-Aih (@($secFindings | Where-Object { $_.file -eq 'src\env-ph.ps1' }).Count -eq 0) 'SEC001 allows $env:NAME placeholders'
    Assert-Aih (@($secFindings | Where-Object { $_.file -eq 'src\braced-ph.ps1' }).Count -eq 0) 'SEC001 allows braced interpolation placeholders'
    Assert-Aih (@($secFindings | Where-Object { $_.file -eq 'src\your-ph.ps1' }).Count -eq 0) 'SEC001 allows <YOUR_KEY> placeholders'
    Assert-Aih (@($secFindings | Where-Object { $_.file -eq 'src\replace-ph.ps1' }).Count -eq 0) 'SEC001 allows <REPLACE_...> placeholders'
    Assert-Aih (@($secFindings | Where-Object { $_.file -eq 'src\suspicious.ps1' }).Count -eq 1) 'SEC001 blocks a suspicious non-placeholder value'
    Assert-Aih (@($secFindings | Where-Object { $_.file -eq 'src\angle-susp.ps1' }).Count -eq 1) 'SEC001 blocks unrecognized angle-bracket values'
    Assert-Aih (@($secFindings | Where-Object { $_.file -like 'data\*' -or $_.file -like 'tmp\*' }).Count -eq 0) 'SEC001 data/tmp exclusion still suppresses runtime scratch state'
    $arSource = [IO.File]::ReadAllText((Join-Path $InstallRoot 'scripts\ArchitectureRules.ps1'))
    Assert-Aih (-not $arSource.Contains('{continue}')) 'no loop-level continue exempts data/tmp from later rules'
    Assert-Aih ($arSource.Contains('^(data|tmp)[\\/]')) 'SEC001-scoped runtime/scratch exclusion present'
    Assert-Aih (($secResult.rules -join ',') -eq 'SEC001,MIG001') 'both architecture rules still reported'
}
finally {
    if (Test-Path -LiteralPath $secFixture) { Remove-Item -LiteralPath $secFixture -Recurse -Force }
}
$sourceFiles=Get-ChildItem -LiteralPath $InstallRoot -Recurse -File|Where-Object{$_.FullName-notmatch'\\(\.git|app|runtime|data|logs|nx-chrome-profile)\\' -and $_.Name-notmatch'^(lockfile|LOCK|SingletonLock)$'}
$secretLeak=$sourceFiles|Select-String -Pattern '(?i)(sk-[A-Za-z0-9_-]{16,}|DEEPSEEK_API_KEY\s*:\s*[^\s''"]+)'|Select-Object -First 1
Assert-Aih ($null-eq$secretLeak) 'source contains no credential values'
foreach($script in Get-ChildItem (Join-Path $InstallRoot 'scripts') -Filter '*.ps1'){[void][scriptblock]::Create((Get-Content -Raw $script.FullName))}
Assert-Aih $true 'all PowerShell scripts parse'
& $layout.Node (Join-Path $InstallRoot 'tests\DeepSeekIsolation.Tests.cjs');Assert-Aih ($LASTEXITCODE-eq0) 'runtime isolation tests pass'
Write-Host "RESULT: $passed deterministic assertions passed."
