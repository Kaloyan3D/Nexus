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
Assert-Aih ($policy.version-eq2) 'routing policy v2 loads'
Assert-Aih ($policy.defaultExecutionClass-eq'deepseek_normal') 'DeepSeek normal is the default execution class'
$normal=Resolve-AihPreset $policy normal;$deep=Resolve-AihPreset $policy deepseek
Assert-Aih ($normal.Config.rootExecutor.model-eq'deepseek-v4-flash') 'normal GUI mode has DeepSeek Flash root'
Assert-Aih ($deep.Config.rootExecutor.model-eq'deepseek-v4-flash') 'DeepSeek-only GUI mode has DeepSeek Flash root'
$normalMode=Get-AihControlRoomMode $policy normal
Assert-Aih ($normalMode.Provider-eq'flash-max-direct'-and-not$normalMode.RequiresOpenAI) 'Control Room root selection no longer requires permanent Sol'

$routingRoot=New-Fixture routing
try{
 $r1=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $routingRoot 'normal-task'
 Assert-Aih ($r1.executionClass-eq'deepseek_normal'-and$r1.model-eq'deepseek-v4-flash') 'normal task routes to DeepSeek'
 $f1=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $routingRoot 'normal-task' '' '' '' 'attempt-failure' 'same test expected 1 actual 2'
 Assert-Aih ($f1.executionClass-eq'deepseek_normal') 'initial meaningful failure remains DeepSeek normal'
 $f2=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $routingRoot 'normal-task' '' '' '' 'attempt-failure' 'same test expected 9 actual 8'
 Assert-Aih ($f2.executionClass-eq'deepseek_deep') 'repeated normalized failure escalates to DeepSeek deep'
 $f3=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $routingRoot 'normal-task' '' '' '' 'verification-failure' 'same test expected 1 actual 2'
 $f4=Invoke-AihRoutingDecision 'implement ordinary change' $InstallRoot $layout.RoutingPolicy $routingRoot 'normal-task' '' '' '' 'verification-failure' 'same test expected 3 actual 4'
 Assert-Aih ($f4.executionClass-eq'codex_review'-and-not$f4.writable) 'repeated deep failure may reach read-only Codex review'
 $repair=Invoke-AihRoutingDecision 'implement bounded review finding' $InstallRoot $layout.RoutingPolicy $routingRoot 'normal-task' '' '' '' 'review-findings'
 Assert-Aih ($repair.executionClass-eq'deepseek_deep'-and$repair.escalatedFrom-eq'codex_review') 'bounded Codex findings return to DeepSeek repair'
 $forced=Invoke-AihRoutingDecision 'ordinary' $InstallRoot $layout.RoutingPolicy $routingRoot 'forced-task' '' '' 'deepseek_deep'
 Assert-Aih ($forced.manualOverride-and$forced.executionClass-eq'deepseek_deep') 'explicit user execution-class override works'
 $legacy=Invoke-AihRoutingDecision 'ordinary' $InstallRoot $layout.RoutingPolicy $routingRoot 'legacy-task' '' 'tier3'
 Assert-Aih ($legacy.executionClass-eq'deepseek_normal'-and$legacy.legacyTierDeprecated) 'legacy tier3 maps compatibly to DeepSeek normal'
 $solveBlocked=$false;try{Invoke-AihRoutingDecision -Description 'solve' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $routingRoot -TaskId 'solve-task' -ForceClass codex_solve|Out-Null}catch{$solveBlocked=$_.Exception.Message-match'UserApprovedCodexSolve'}
 Assert-Aih $solveBlocked 'writable Codex solve requires explicit operator approval flag'
 $solve=Invoke-AihRoutingDecision -Description 'solve' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $routingRoot -TaskId 'solve-task-approved' -ForceClass codex_solve -UserApprovedCodexSolve
 Assert-Aih ($solve.executionClass-eq'codex_solve'-and$solve.writable) 'explicit operator approval enables exceptional Codex solve'
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
 Assert-Aih ($call.executionClass-eq'codex_review'-and-not$call.completionAuthority) 'bounded review call registration cannot own completion'
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
    [IO.File]::WriteAllText((Join-Path $fixtureConversation 'client.js'), """hero.headline"": ""Into the Unknown"",`r`n""hero.headline"": ""探索未至之境""`r`n", [Text.UTF8Encoding]::new($false))
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
    $fixtureModelsText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureModels 'client.js')
    Assert-Aih ($fixtureModelsText.Contains('About Nexus') -and $fixtureModelsText.Contains('关于 Nexus') -and -not $fixtureModelsText.Contains('Internal Testing Notice')) 'fixture: welcome notice patched'
    Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixtureData 'settings.yaml')).Contains('preference: dark')) 'fixture: dark theme default added'
    Assert-Aih (Test-Path -LiteralPath (Join-Path $fixtureData 'profiles\node_modules\@nexus\ui-brand\package.json')) 'fixture: Nexus package installed'

    $firstIndex = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureDist 'index.html')
    $firstModels = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureModels 'client.js')
    $firstRenderer = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureRenderer 'client.js')
    & (Join-Path $InstallRoot 'scripts\Patch-NexusUi.ps1') -InstallRoot $fixture -SourceRoot $InstallRoot
    if ($LASTEXITCODE -ne 0) { throw 'Nexus UI patch failed on the second run' }
    $secondIndex = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureDist 'index.html')
    $secondModels = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureModels 'client.js')
    $secondRenderer = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fixtureRenderer 'client.js')
    Assert-Aih ($firstIndex.Hash -eq $secondIndex.Hash -and $firstModels.Hash -eq $secondModels.Hash -and $firstRenderer.Hash -eq $secondRenderer.Hash) 'fixture: Nexus patch is idempotent (second run changes nothing)'

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

$sourceFiles=Get-ChildItem -LiteralPath $InstallRoot -Recurse -File|Where-Object{$_.FullName-notmatch'\\(\.git|app|runtime|data|logs)\\'}
$secretLeak=$sourceFiles|Select-String -Pattern '(?i)(sk-[A-Za-z0-9_-]{16,}|DEEPSEEK_API_KEY\s*:\s*[^\s''"]+)'|Select-Object -First 1
Assert-Aih ($null-eq$secretLeak) 'source contains no credential values'
foreach($script in Get-ChildItem (Join-Path $InstallRoot 'scripts') -Filter '*.ps1'){[void][scriptblock]::Create((Get-Content -Raw $script.FullName))}
Assert-Aih $true 'all PowerShell scripts parse'
& $layout.Node (Join-Path $InstallRoot 'tests\DeepSeekIsolation.Tests.cjs');Assert-Aih ($LASTEXITCODE-eq0) 'runtime isolation tests pass'
Write-Host "RESULT: $passed deterministic assertions passed."
