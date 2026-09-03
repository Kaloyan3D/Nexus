[CmdletBinding()]param([string]$InstallRoot='C:\AI-Harness')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $InstallRoot 'scripts\Common.ps1')
. (Join-Path $InstallRoot 'scripts\Routing.ps1')
. (Join-Path $InstallRoot 'scripts\TaskController.ps1')
. (Join-Path $InstallRoot 'scripts\Telemetry.ps1')
. (Join-Path $InstallRoot 'scripts\CodexReview.ps1')
. (Join-Path $InstallRoot 'scripts\VisualRequirement.ps1')

$script:passed=0
function Assert-Aih {param([bool]$Condition,[string]$Name) if(-not$Condition){throw ("FAIL: "+$Name)}; $script:passed++; Write-Host ("PASS: "+$Name)}

# ── fixture: temp install root + temp workspace ────────────────────────────
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('aih-visual-loop-'+[guid]::NewGuid().ToString('N'))
$workspace=Join-Path ([IO.Path]::GetTempPath()) ('aih-visual-loop-ws-'+[guid]::NewGuid().ToString('N'))
$env:AIH_VISUAL_LOOP_TEST_KEY='loop-test-key-not-real'
New-Item -ItemType Directory -Path $workspace -Force|Out-Null
try{
    $liveLayout=Get-AihLayout $InstallRoot
    New-Item -ItemType Directory -Path (Join-Path $fixture 'config') -Force|Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'scripts') -Force|Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'data') -Force|Out-Null
    foreach($name in @('routing-policy.json','engineering-profiles.json','model-registry.json')){Copy-Item (Join-Path $liveLayout.Root ('config\'+$name)) (Join-Path $fixture ('config\'+$name))}
    foreach($name in @('Common.ps1','Routing.ps1','TaskController.ps1','Telemetry.ps1','VisualReview.ps1','VisualLoop.ps1','VisualRequirement.ps1','Invoke-VisualReview.mjs','Capture-VisualEvidence.ps1')){Copy-Item (Join-Path $liveLayout.Root ('scripts\'+$name)) (Join-Path $fixture ('scripts\'+$name))}
    @'
engineering-profile: deepseek-codex
llm-pi-ai:
  providers:
    deepseek-vision-direct:
      apiKeyEnv: AIH_VISUAL_LOOP_TEST_KEY
      baseURL: http://127.0.0.1:9
      api: openai-completions
      reasoning: high
      compat:
        thinkingFormat: deepseek
'@|Set-Content -Path (Join-Path $fixture 'data\settings.yaml') -Encoding UTF8
    # git repo in the workspace (detector reads changed files via git)
    Push-Location $workspace
    try{ git init | Out-Null; git config user.email t@t.local; git config user.name t; New-Item -ItemType Directory -Path (Join-Path $workspace 'apps') -Force|Out-Null; 'base' | Set-Content (Join-Path $workspace 'apps\README.md'); git add -A; git commit -m base | Out-Null }finally{ Pop-Location }
    $task=New-AihTask $workspace 'build a new mobile home screen with card layout'
    $mockDir=Join-Path $fixture 'mock'
    New-Item -ItemType Directory -Path $mockDir -Force|Out-Null
    $pngPath=Join-Path $workspace 'shot-source.png'
    # A real rendered-looking PNG (deterministic colored bars) so the
    # preflight geometry/pixel-variance checks operate on valid input.
    Add-Type -AssemblyName System.Drawing
    $shotBmp=New-Object System.Drawing.Bitmap(400,800)
    try{
        for($bar=0;$bar-lt 40;$bar++){
            $brush=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,(($bar*37)%256),(($bar*71)%256),(($bar*113)%256)))
            try{ $g=[System.Drawing.Graphics]::FromImage($shotBmp); $g.FillRectangle($brush,0,($bar*20),400,20); $g.Dispose() }finally{ $brush.Dispose() }
        }
        $shotBmp.Save($pngPath,[System.Drawing.Imaging.ImageFormat]::Png)
    }finally{ $shotBmp.Dispose() }

    $script:loopSeq=0
    function Invoke-AihLoop {
        param([string]$Action='iterate',[string]$MockResponseFile,[string]$ScenarioPath,[string]$PolicyPath,[string]$AdbPath,[int]$MaxIterations=3,[string]$LoopTaskId)
        $script:loopSeq++
        $targetTaskId=$task.taskId
        if(-not[string]::IsNullOrWhiteSpace($LoopTaskId)){ $targetTaskId=$LoopTaskId }
        $outFile=Join-Path $fixture ('loop-out-'+$script:loopSeq+'.txt')
        $errFile=Join-Path $fixture ('loop-err-'+$script:loopSeq+'.txt')
        $cmd='powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $fixture 'scripts\VisualLoop.ps1')+'" -InstallRoot "'+$fixture+'" -Workspace "'+$workspace+'" -TaskId '+$targetTaskId+' -Action '+$Action+' -MaxIterations '+[string]$MaxIterations
        if($MockResponseFile){$cmd+=(' -MockResponseFile "'+$MockResponseFile+'"')}
        if($ScenarioPath){$cmd+=(' -ScenarioPath "'+$ScenarioPath+'"')}
        if($PolicyPath){$cmd+=(' -PolicyPath "'+$PolicyPath+'"')}
        if($AdbPath){$cmd+=(' -AdbPath "'+$AdbPath+'"')}
        $cmd+=(' > "'+$outFile+'" 2> "'+$errFile+'"')
        cmd /c $cmd
        $exit=$LASTEXITCODE
        $output=@(Get-Content -LiteralPath $outFile -ErrorAction SilentlyContinue)+@(Get-Content -LiteralPath $errFile -ErrorAction SilentlyContinue)
        $doc=$null
        for($i=@($output).Count-1;$i-ge 0;$i--){
            $t=$output[$i].Trim()
            if($t.StartsWith('{')){
                $candidateText=@($output[$i..(@($output).Count-1)])-join [Environment]::NewLine
                try{$doc=$candidateText|ConvertFrom-Json}catch{$doc=$null}
                if($null-ne$doc){break}
            }
        }
        [pscustomobject]@{exitCode=$exit;text=($output-join [Environment]::NewLine);json=$doc}
    }

    function New-AihMock {
        # -PreviousIds: emits the previousReview classification entries now
        # required by the coverage contract when a previous result is packed.
        param([string]$Name,$Findings,[string]$Verdict='REVISE',[double]$Score=6.0,$PreviousIds=@())
        $previousEntries=@($PreviousIds | ForEach-Object { [ordered]@{ id=$_; status='unchanged'; note='not changed since last capture' } })
        $review=[ordered]@{verdict=$Verdict;score=$Score;dimensions=[ordered]@{hierarchy=7;spacing=6;density=6;typography=7;alignment=6;colorDiscipline=7;interactionClarity=6;brandFidelity=7;platformQuality=6};findings=@($Findings);previousReview=$previousEntries;strengths=@('ok');summary='summary'}
        @{status=200;body=@{model='deepseek-v4-flash-vision-exp';choices=@(@{message=@{content=($review|ConvertTo-Json -Depth 8)}});usage=@{prompt_tokens=50;completion_tokens=40}}}|ConvertTo-Json -Depth 8|Set-Content -Path (Join-Path $mockDir $Name) -Encoding UTF8
        return Join-Path $mockDir $Name
    }

    # ── 1. VISUAL REQUIREMENT DETECTOR ────────────────────────────────────────
    Push-Location $workspace
    try{
        New-Item -ItemType Directory -Path (Join-Path $workspace 'apps\mobile\src\app') -Force|Out-Null
        'export default function Home(){return null}' | Set-Content (Join-Path $workspace 'apps\mobile\src\app\index.tsx')
        git add -A; git commit -m 'ui change' | Out-Null
    }finally{ Pop-Location }
    $detection=Invoke-AihLoop -Action 'detect'
    Assert-Aih ($detection.exitCode -eq 0 -and $detection.json.ok -eq $true -and $detection.json.kind -eq 'visual-loop-detection') '1: detection returns structured result'
    Assert-Aih ($detection.json.requirement -eq 'required') '1: RN screen/layout diff classifies REQUIRED'
    Assert-Aih (@($detection.json.reasons)|Where-Object{$_-match'visual style/layout surface'}|Measure-Object).Count -ge 1 '1: detection evidence explains WHY'
    $detPath=Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness\runs') $task.taskId) 'visual') 'detection.json'
    Assert-Aih (Test-Path $detPath) '1: the detection decision is persisted'

    # backend-only diff -> none (task created AFTER the ui commit: its diff is backend only)
    Push-Location $workspace
    try{
        New-Item -ItemType Directory -Path (Join-Path $workspace 'server\db') -Force|Out-Null
        'SELECT 1' | Set-Content (Join-Path $workspace 'server\db\migrate.sql')
        git add -A; git commit -m 'backend change' | Out-Null
    }finally{ Pop-Location }
    $taskBackend=New-AihTask $workspace 'backend migration task'
    Push-Location $workspace
    try{ New-Item -ItemType Directory -Path (Join-Path $workspace 'server\db2') -Force|Out-Null; 'SELECT 2' | Set-Content (Join-Path $workspace 'server\db2\seed.sql'); git add -A; git commit -m 'more backend' | Out-Null }finally{ Pop-Location }
    $backendDetection=Get-AihVisualRequirement -Workspace $workspace -TaskId $taskBackend.taskId
    Assert-Aih ($backendDetection.requirement -eq 'none') '1: backend-only diff classifies NONE'

    # project policy elevates to required (nonePatterns on server/, requirePatterns on apps/)
    $policyPath=Join-Path $fixture 'visual-policy.json'
    @{schemaVersion=1;requirement='auto';requirePatterns=@('apps/');invariants=@(@{id='strength-rows';pattern='7 (strength )?rows';reason='OpenRank has exactly 6 strength groups'});toolingFindings=@(@{id='expo-gear';pattern='(?i)(expo (dev|debug)|dev-client tools gear)';reason='Expo dev-client tooling, not product UI'})}|ConvertTo-Json -Depth 6|Set-Content -Path $policyPath -Encoding UTF8
    $policyDetection=Get-AihVisualRequirement -Workspace $workspace -TaskId $task.taskId -Policy (Get-Content -Raw $policyPath|ConvertFrom-Json)
    Assert-Aih ($policyDetection.requirement -eq 'required' -and @($policyDetection.signals.policyRequiredMatches).Count -ge 1) '1: project policy elevates to REQUIRED'

    # minor visual diff -> recommended (icon asset; task created AFTER backend commits)
    Push-Location $workspace
    try{ New-Item -ItemType Directory -Path (Join-Path $workspace 'assets\icons') -Force|Out-Null; 'icon' | Set-Content (Join-Path $workspace 'assets\icons\home.svg'); git add -A; git commit -m 'icon change' | Out-Null }finally{ Pop-Location }
    $taskMinor=New-AihTask $workspace 'minor icon task'
    Push-Location $workspace
    try{ 'icon2' | Set-Content (Join-Path $workspace 'assets\icons\settings.svg'); git add -A; git commit -m 'second icon' | Out-Null }finally{ Pop-Location }
    $minorDetection=Get-AihVisualRequirement -Workspace $workspace -TaskId $taskMinor.taskId
    Assert-Aih ($minorDetection.requirement -eq 'recommended') '1: minor visual diff (icon asset) classifies RECOMMENDED'

    # ── 2. AUTOMATIC LOOP: required -> capture -> review (mocked transport) ───
    $scenarioPath=Join-Path $fixture 'scenario.json'
    @{id='current-screen';platform='android';captures=@(@{name='current';mode='file';sourceFile=$pngPath})}|ConvertTo-Json -Depth 5|Set-Content -Path $scenarioPath -Encoding UTF8
    $reviseMock=New-AihMock 'revise1.json' @(@{id='F1';severity='high';category='spacing';area='hero card';observation='too much vertical whitespace';whyItMatters='density';recommendation='tighten grouping';confidence='high'},@{id='F2';severity='medium';category='layout';area='strength rows';observation='fit 7 strength rows in the card';whyItMatters='completeness';recommendation='add a 7th row';confidence='medium'},@{id='F3';severity='low';category='tooling';area='dev tools gear';observation='the Expo dev-client tools gear floats over content';whyItMatters='cleanliness';recommendation='remove the gear';confidence='high'})
    $run1=Invoke-AihLoop -Action 'iterate' -MockResponseFile $reviseMock -ScenarioPath $scenarioPath -PolicyPath $policyPath
    Assert-Aih ($run1.exitCode -eq 0 -and $run1.json.ok -eq $true -and $run1.json.kind -eq 'visual-loop') '2: automatic loop iteration 1 completes'
    Assert-Aih ($run1.json.iteration -eq 1 -and $run1.json.controllerVerdict -eq 'REVISE') '2: iteration 1 with accepted high findings yields REVISE'
    Assert-Aih ($run1.json.acceptedFindings -eq 1 -and $run1.json.rejectedFindings -eq 2) '2: adjudication accepts 1 finding and rejects invariant-conflict + tooling findings'
    Assert-Aih ($null-ne$run1.json.repairPacket -and $run1.json.repairPacket -match 'VISUAL REVIEW - ITERATION 1') '2: a compact repair packet is produced'
    Assert-Aih ($run1.json.repairPacket -match 'IGNORED' -and $run1.json.repairPacket -match 'frozen product invariant') '2: the packet lists rejected findings with policy reasons'
    $state1=Get-Content (Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness\runs') $task.taskId) 'visual') 'state.json') -Raw|ConvertFrom-Json
    Assert-Aih ($state1.status -eq 'revise' -and [int]$state1.iteration -eq 1 -and [int]$state1.maxIterations -eq 3 -and $state1.humanAcceptance -eq $false) '2: visual state records revise/iteration-1/3 with humanAcceptance=false'
    Assert-Aih ([bool]$state1.repairPending -eq $true) '2: state marks repairPending after the handoff'
    $iter1Dir=Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness\runs') $task.taskId) 'visual') 'iteration-01'
    Assert-Aih ((Test-Path (Join-Path $iter1Dir 'packet.json')) -and (Test-Path (Join-Path $iter1Dir 'result.json')) -and (Test-Path (Join-Path $iter1Dir 'adjudication.json'))) '2: iteration 1 persists packet/result/adjudication'
    $tel1=Get-Content (Join-Path (Join-Path (Join-Path $workspace '.ai-harness\runs') $task.taskId) 'telemetry.json') -Raw|ConvertFrom-Json
    Assert-Aih ($tel1.executionClass -eq $task.executionClass -and $tel1.capability -eq 'visual-review' -and $tel1.trigger -eq 'automatic' -and [int]$tel1.visualIteration -eq 1 -and $tel1.visualVerdict -eq 'REVISE') '2: telemetry preserves executionClass and records capability/trigger/visualIteration'

    # ── 3. RE-VERIFICATION GATE ───────────────────────────────────────────────
    $runGate=Invoke-AihLoop -Action 'iterate' -MockResponseFile $reviseMock -ScenarioPath $scenarioPath -PolicyPath $policyPath
    Assert-Aih ($runGate.exitCode -eq 3 -and $runGate.json.errorKind -eq 'visual-review-reverification-required') '3: iterating without fresh deterministic verification fails closed'

    # fresh deterministic verification (new evidence attempt) unblocks iteration 2
    Start-AihTaskAttempt $workspace $task.taskId 'engineer_normal'|Out-Null
    # evidence attempt must be NEWER than the repair baseline attempt
    Set-AihTaskEvidence $workspace $task.taskId ([ordered]@{acceptanceCriteria=@();verification=@([ordered]@{name='pnpm test';status='PASS'});scopePass=$true;attempt=2})
    $passMock=New-AihMock 'pass2.json' @() -Verdict 'PASS' -Score 8.5 -PreviousIds @('F1','F2','F3')
    $run2=Invoke-AihLoop -Action 'iterate' -MockResponseFile $passMock -ScenarioPath $scenarioPath -PolicyPath $policyPath
    Assert-Aih ($run2.exitCode -eq 0 -and $run2.json.iteration -eq 2 -and $run2.json.controllerVerdict -eq 'PASS') '3: fresh verification admits iteration 2 which PASSes'
    $state2=Get-Content (Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness\runs') $task.taskId) 'visual') 'state.json') -Raw|ConvertFrom-Json
    Assert-Aih ($state2.status -eq 'pass' -and $state2.humanAcceptance -eq $false) '3: visual status pass with humanAcceptance still false'

    # ── 4. COMPLETION GATE ────────────────────────────────────────────────────
    Set-AihTaskEvidence $workspace $task.taskId ([ordered]@{acceptanceCriteria=@();verification=@([ordered]@{name='pnpm test';status='PASS'});scopePass=$true;attempt=2})
    $completion=Test-AihTaskCompletion $workspace $task.taskId
    Assert-Aih ($completion.complete -eq $true) '4: visual PASS satisfies the visual completion requirement'

    # revise blocks completion (taskB gets its own UI diff)
    Push-Location $workspace
    try{ New-Item -ItemType Directory -Path (Join-Path $workspace 'apps\mobile\src\components') -Force|Out-Null; 'export const Card=()=>null' | Set-Content (Join-Path $workspace 'apps\mobile\src\components\Card.tsx'); git add -A; git commit -m 'second ui change' | Out-Null }finally{ Pop-Location }
    $taskB=New-AihTask $workspace 'second visual task'
    Push-Location $workspace
    try{ 'export const Tab=()=>null' | Set-Content (Join-Path $workspace 'apps\mobile\src\components\Tab.tsx'); git add -A; git commit -m 'third ui change' | Out-Null }finally{ Pop-Location }
    $reviseMockB=New-AihMock 'reviseB.json' @(@{id='G1';severity='high';category='alignment';area='nav';observation='misaligned';whyItMatters='rhythm';recommendation='align';confidence='high'})
    $runB1=Invoke-AihLoop -Action 'iterate' -MockResponseFile $reviseMockB -ScenarioPath $scenarioPath -PolicyPath $policyPath -MaxIterations 2 -LoopTaskId $taskB.taskId
    Assert-Aih ($runB1.json.state.status -eq 'revise') '4: second task reaches revise'
    Set-AihTaskEvidence $workspace $taskB.taskId ([ordered]@{acceptanceCriteria=@();verification=@([ordered]@{name='pnpm test';status='PASS'});scopePass=$true;attempt=1})
    $blocked=Test-AihTaskCompletion $workspace $taskB.taskId
    Assert-Aih (($blocked.complete -eq $false) -and ((@($blocked.reasons)|Where-Object{$_-match'Visual verification is required'}|Measure-Object).Count -ge 1)) '4: visual REVISE blocks completion with a structured reason'
    # exhausted blocks completion (maxIterations 2 -> iteration 2 still revise -> exhausted)
    Start-AihTaskAttempt $workspace $taskB.taskId 'engineer_normal'|Out-Null
    Set-AihTaskEvidence $workspace $taskB.taskId ([ordered]@{acceptanceCriteria=@();verification=@([ordered]@{name='pnpm test';status='PASS'});scopePass=$true;attempt=2})
    # iteration 2's mock classifies the previous finding (coverage contract)
    $reviseMockB2=New-AihMock 'reviseB2.json' @(@{id='G1';severity='high';category='alignment';area='nav';observation='misaligned';whyItMatters='alignment';recommendation='align the row';confidence='high'}) -Verdict 'REVISE' -Score 5.5 -PreviousIds @('G1')
    $runB2=Invoke-AihLoop -Action 'iterate' -MockResponseFile $reviseMockB2 -ScenarioPath $scenarioPath -PolicyPath $policyPath -MaxIterations 2 -LoopTaskId $taskB.taskId
    Assert-Aih ($runB2.json.state.status -eq 'exhausted' -and $runB2.json.iteration -eq 2) '4: hitting maxIterations yields exhausted'
    $runB3=Invoke-AihLoop -Action 'iterate' -MockResponseFile $reviseMockB -ScenarioPath $scenarioPath -PolicyPath $policyPath -MaxIterations 2 -LoopTaskId $taskB.taskId
    Assert-Aih ($runB3.json.state.status -eq 'exhausted' -and $runB3.json.iteration -eq 2) '4: NEVER iteration 4 (budget stays exhausted at 2/2)'
    $blockedB=Test-AihTaskCompletion $workspace $taskB.taskId
    Assert-Aih ($blockedB.complete -eq $false) '4: exhausted visual status blocks completion'

    # ── 5. FAILURE PATHS ──────────────────────────────────────────────────────
    # adb unavailable (viewport scenario with an impossible adb path)
    Push-Location $workspace
    try{ 'export const Hero=()=>null' | Set-Content (Join-Path $workspace 'apps\mobile\src\components\Hero.tsx'); git add -A; git commit -m 'hero ui change' | Out-Null }finally{ Pop-Location }
    $taskC=New-AihTask $workspace 'third visual task'
    Push-Location $workspace
    try{ 'export const Hero2=()=>null' | Set-Content (Join-Path $workspace 'apps\mobile\src\components\Hero2.tsx'); git add -A; git commit -m 'hero2 ui change' | Out-Null }finally{ Pop-Location }
    $viewportScenario=Join-Path $fixture 'scenario-viewport.json'
    @{id='current-screen';platform='android';captures=@(@{name='current';mode='viewport'})}|ConvertTo-Json -Depth 5|Set-Content -Path $viewportScenario -Encoding UTF8
    $runC=Invoke-AihLoop -Action 'iterate' -MockResponseFile $reviseMock -ScenarioPath $viewportScenario -PolicyPath $policyPath -AdbPath 'C:\definitely-missing\adb.exe' -LoopTaskId $taskC.taskId
    Assert-Aih ($runC.exitCode -eq 3 -and $runC.json.errorKind -eq 'visual-review-capture-unavailable') '5: adb unavailable -> capture-unavailable (no fabricated PASS)'
    $stateC=Get-Content (Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness\runs') $taskC.taskId) 'visual') 'state.json') -Raw|ConvertFrom-Json
    Assert-Aih ($stateC.status -eq 'unavailable' -and [int]$stateC.iteration -eq 0) '5: unavailable status recorded without burning an iteration'
    # provider permanent failure (HTTP 400 -> non-transient)
    $failMock=Join-Path $mockDir 'permfail.json'
    @{status=400;body=@{error=@{message='bad request'}}}|ConvertTo-Json -Depth 5|Set-Content -Path $failMock -Encoding UTF8
    Start-AihTaskAttempt $workspace $taskC.taskId 'engineer_normal'|Out-Null
    Set-AihTaskEvidence $workspace $taskC.taskId ([ordered]@{acceptanceCriteria=@();verification=@([ordered]@{name='pnpm test';status='PASS'});scopePass=$true;attempt=2})
    $runC2=Invoke-AihLoop -Action 'iterate' -MockResponseFile $failMock -ScenarioPath $scenarioPath -PolicyPath $policyPath -LoopTaskId $taskC.taskId
    Assert-Aih ($runC2.exitCode -eq 3 -and $runC2.json.errorKind -eq 'visual-review-provider-error') '5: provider permanent failure surfaces structured provider error'
    # malformed visual result -> schema-invalid, iteration NOT burned
    Push-Location $workspace
    try{ 'export const Grid=()=>null' | Set-Content (Join-Path $workspace 'apps\mobile\src\components\Grid.tsx'); git add -A; git commit -m 'grid ui change' | Out-Null }finally{ Pop-Location }
    $taskD=New-AihTask $workspace 'fourth visual task'
    Push-Location $workspace
    try{ 'export const Grid2=()=>null' | Set-Content (Join-Path $workspace 'apps\mobile\src\components\Grid2.tsx'); git add -A; git commit -m 'grid2 ui change' | Out-Null }finally{ Pop-Location }
    $garbageLoopMock=Join-Path $mockDir 'garbage-loop.json'
    @{status=200;body=@{model='deepseek-v4-flash-vision-exp';choices=@(@{message=@{content='prose not json'}})}}|ConvertTo-Json -Depth 6|Set-Content -Path $garbageLoopMock -Encoding UTF8
    $runD=Invoke-AihLoop -Action 'iterate' -MockResponseFile $garbageLoopMock -ScenarioPath $scenarioPath -PolicyPath $policyPath -LoopTaskId $taskD.taskId
    Assert-Aih ($runD.exitCode -eq 3 -and $runD.json.errorKind -eq 'visual-review-schema-invalid') '5: malformed visual result fails closed with schema error'
    $stateD=Get-Content (Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness\runs') $taskD.taskId) 'visual') 'state.json') -Raw|ConvertFrom-Json
    Assert-Aih ([int]$stateD.iteration -eq 0) '5: a failed review does not consume visual iteration budget'

    # ── 5b. RETRY OWNERSHIP: transport exhaustion is terminal for the loop ────
    # Invoke-VisualReview owns the bounded retry (max 2 provider HTTP attempts).
    # When it exhausts them the controller must NOT silently re-invoke the
    # reviewer: fail closed, mark unavailable, never burn the iteration.
    $taskR=New-AihTask $workspace 'empty content task'
    Push-Location $workspace
    try{ 'export const Retry=()=>null' | Set-Content (Join-Path $workspace 'apps\mobile\src\components\Retry.tsx'); git add -A; git commit -m 'retry ui change' | Out-Null }finally{ Pop-Location }
    $emptyMock=Join-Path $mockDir 'empty-loop.json'
    @{status=200;body=@{choices=@(@{message=@{content=''}})}}|ConvertTo-Json -Depth 6|Set-Content -Path $emptyMock -Encoding UTF8
    $runE=Invoke-AihLoop -Action 'iterate' -MockResponseFile $emptyMock -ScenarioPath $scenarioPath -PolicyPath $policyPath -LoopTaskId $taskR.taskId
    Assert-Aih ($runE.exitCode -eq 3 -and $runE.json.errorKind -eq 'visual-review-empty-content') '5b: exhausted transport fails closed with empty-content'
    $stateE=Get-Content (Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness\runs') $taskR.taskId) 'visual') 'state.json') -Raw|ConvertFrom-Json
    Assert-Aih ($stateE.status -eq 'unavailable') '5b: exhausted transport marks the reviewer unavailable'
    Assert-Aih ([int]$stateE.iteration -eq 0) '5b: exhausted transport does not burn the iteration'
    Assert-Aih ((@($stateE.reasons)|Where-Object{$_-match'reviewer not invoked: visual-review-empty-content'}|Measure-Object).Count -ge 1) '5b: the unavailable reason names the exhausted transport'
    $terr=Get-Content (Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness\runs') $taskR.taskId) 'visual\iteration-01') 'transport-error.json') -Raw|ConvertFrom-Json
    Assert-Aih ([int]$terr.attemptCount -eq 2 -and @($terr.attempts).Count -eq 2 -and @($terr.attempts|Where-Object{$_.kind -eq 'empty-content'}).Count -eq 2) '5b: the transport owned exactly 2 provider HTTP attempts'

    # ── 6b. VISUAL PREFLIGHT (deterministic; complements, never replaces) ─────
    $taskP=New-AihTask $workspace 'preflight probe task'
    Push-Location $workspace
    try{ New-Item -ItemType Directory -Path (Join-Path $workspace 'apps\mobile\src\components') -Force|Out-Null; 'export const Chip=()=>null' | Set-Content (Join-Path $workspace 'apps\mobile\src\components\Chip.tsx'); git add -A; git commit -m 'chip ui' | Out-Null }finally{ Pop-Location }
    $runP=Invoke-AihLoop -Action 'preflight' -MockResponseFile $passMock -ScenarioPath $scenarioPath -PolicyPath $policyPath -LoopTaskId $taskP.taskId
    Assert-Aih ($runP.exitCode -eq 0 -and $runP.json.kind -eq 'visual-preflight-run') '6b: preflight action runs deterministically'
    Assert-Aih ($runP.json.visualPreflight.status -eq 'pass') '6b: preflight passes on a real capture'
    Assert-Aih ($null-ne$runP.json.visualPreflight.checks -and @($runP.json.visualPreflight.checks | Where-Object { $_.name -like 'pixel-variance:*' }).Count -ge 1) '6b: pixel-variance check ran'
    Assert-Aih ($runP.json.note -match 'NOT a visual-review PASS') '6b: preflight output states it is not a visual-review PASS'
    $stateP=Get-Content (Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness\runs') $taskP.taskId) 'visual') 'state.json') -Raw|ConvertFrom-Json
    Assert-Aih ($stateP.status -eq 'pending' -and [int]$stateP.iteration -eq 0) '6b: preflight does not advance iteration or set a verdict'
    Assert-Aih ($stateP.visualPreflight.status -eq 'pass') '6b: preflight result persisted in visual state'
    $telPathP=Join-Path (Join-Path (Join-Path $workspace '.ai-harness\runs') $taskP.taskId) 'telemetry.json'
    $telZero=$true
    if(Test-Path $telPathP){ $telP=Get-Content $telPathP -Raw|ConvertFrom-Json; $telZero=((@($telP.PSObject.Properties|Where-Object{$_.Name -eq 'modelCalls'})|Measure-Object).Count -eq 0 -or [int]$telP.modelCalls -eq 0) }
    Assert-Aih $telZero '6b: preflight made zero provider calls'
    $blockedP=Test-AihTaskCompletion $workspace $taskP.taskId
    Assert-Aih (($blockedP.complete -eq $false) -and ((@($blockedP.reasons)|Where-Object{$_-match'Visual verification is required'}|Measure-Object).Count -ge 1)) '6b: preflight PASS alone never satisfies the visual completion gate'

    # blank/tiny screenshot fails preflight; reviewer not invoked; no iteration burn
    $blankPng=Join-Path $mockDir 'blank.png'
    Add-Type -AssemblyName System.Drawing
    $bmp=New-Object System.Drawing.Bitmap(4,4)
    try{ $bmp.Save($blankPng,[System.Drawing.Imaging.ImageFormat]::Png) }finally{ $bmp.Dispose() }
    $blankScenario=Join-Path $mockDir 'scenario-blank.json'
    @{schemaVersion=1;kind='visual-review-scenarios';defaultScenario='blank';scenarios=@(@{id='blank';platform='android';captures=@(@{name='blank';mode='file';sourceFile=$blankPng})})}|ConvertTo-Json -Depth 6|Set-Content -Path $blankScenario -Encoding UTF8
    $runPB=Invoke-AihLoop -Action 'iterate' -MockResponseFile $passMock -ScenarioPath $blankScenario -PolicyPath $policyPath -LoopTaskId $taskP.taskId
    Assert-Aih ($runPB.exitCode -eq 3 -and $runPB.json.errorKind -eq 'visual-preflight-failed') '6b: blank screenshot fails preflight and the reviewer is not invoked'
    $statePB=Get-Content (Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness\runs') $taskP.taskId) 'visual') 'state.json') -Raw|ConvertFrom-Json
    Assert-Aih ($statePB.status -eq 'unavailable' -and [int]$statePB.iteration -eq 0) '6b: preflight failure marks unavailable without burning iteration'
    Assert-Aih ((@($statePB.reasons)|Where-Object{$_-match'reviewer not invoked'}|Measure-Object).Count -ge 1) '6b: the unavailable reason is recorded in state'

    # ── 6. NON-VISUAL TASKS NEVER INVOKE VISION ───────────────────────────────
    Push-Location $workspace
    try{ New-Item -ItemType Directory -Path (Join-Path $workspace 'services') -Force|Out-Null; 'export const rank=1' | Set-Content (Join-Path $workspace 'services\ranking.ts'); git add -A; git commit -m 'backend only' | Out-Null }finally{ Pop-Location }
    $taskE=New-AihTask $workspace 'pure backend ranking task'
    $runE=Invoke-AihLoop -Action 'iterate' -MockResponseFile $passMock -ScenarioPath $scenarioPath -PolicyPath $policyPath -LoopTaskId $taskE.taskId
    Assert-Aih ($runE.exitCode -eq 0 -and $runE.json.visualWorkRequired -eq $false) '6: non-visual task never invokes vision'

    # ── 7. MANUAL OVERRIDE COMPATIBILITY ──────────────────────────────────────
    $manualArgs=@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $fixture 'scripts\VisualReview.ps1'),'-InstallRoot',$fixture,'-Workspace',$workspace,'-TaskId',$task.taskId,'-Execute','-Trigger','manual','-Screenshots',$pngPath,'-Question','manual operator check','-MockResponseFile',$passMock)
    $manualOutput=& 'powershell.exe' $manualArgs 2>&1|ForEach-Object{[string]$_}
    $manualExit=$LASTEXITCODE
    $manualDoc=$null
    for($i=@($manualOutput).Count-1;$i-ge 0;$i--){
        $t=$manualOutput[$i].Trim()
        if($t.StartsWith('{')){
            $candidateText=@($manualOutput[$i..(@($manualOutput).Count-1)])-join [Environment]::NewLine
            try{$manualDoc=$candidateText|ConvertFrom-Json}catch{$manualDoc=$null}
            if($null-ne$manualDoc){break}
        }
    }
    Assert-Aih ($manualExit -eq 0 -and $manualDoc.trigger -eq 'manual') '7: /visual-review manual path still works and records trigger=manual'
    $stateAfterManual=Get-Content (Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness\runs') $task.taskId) 'visual') 'state.json') -Raw|ConvertFrom-Json
    Assert-Aih ($stateAfterManual.status -eq 'pass' -and [int]$stateAfterManual.iteration -eq 2 -and @($stateAfterManual.history | Where-Object { $_.trigger -eq 'manual' }).Count -eq 0) '7: a manual result never masquerades as an automatic iteration'

    # ── 8. REGRESSION: reviewer/solver/routing unchanged ─────────────────────
    Assert-Aih ((@(Get-AihCompatibleModelsForRole (Get-AihModelRegistry (Join-Path $fixture 'config\model-registry.json')) 'reviewer')) -contains 'gpt-5.6-sol') '8: independent reviewer unchanged'
    $routingDecision=Invoke-AihRoutingDecision 'implement ordinary change' $fixture $liveLayout.RoutingPolicy (Join-Path $fixture 'data\routing') 'loop-routing-1' 'aih-engineering' -DryRun -SettingsPath $liveLayout.Settings
    Assert-Aih ($routingDecision.executionClass -eq 'engineer_normal') '8: routing unchanged by the visual capability'

    Write-Host "RESULT: $passed visual-loop assertions passed."
}finally{
    Remove-Item Env:AIH_VISUAL_LOOP_TEST_KEY -ErrorAction SilentlyContinue
    if($env:AIH_KEEP_LOOP_FIXTURE -ne '1'){
        if(Test-Path $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}
        if(Test-Path $workspace){Remove-Item -LiteralPath $workspace -Recurse -Force}
    } else { Write-Host ("FIXTURE KEPT: "+$fixture+" | "+$workspace) }
}
