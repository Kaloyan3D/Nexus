[CmdletBinding()]param([string]$InstallRoot= (Split-Path -Parent $PSScriptRoot))
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
# Platform-aware child host: Windows keeps powershell.exe; POSIX uses the pinned Nexus pwsh.
if (-not (Get-Command Test-AihIsWindows -ErrorAction SilentlyContinue)) { . (Join-Path $InstallRoot 'scripts/Platform.ps1') }; $aihPsHost = Get-AihPowerShellHost -InstallRoot $InstallRoot
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Routing.ps1')
. (Join-Path $InstallRoot 'scripts/TaskController.ps1')
. (Join-Path $InstallRoot 'scripts/Telemetry.ps1')
. (Join-Path $InstallRoot 'scripts/CodexReview.ps1')

$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not$Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}
function New-Fixture([string]$Name){$path=Join-Path ([IO.Path]::GetTempPath()) ("aih-visual-"+$Name+"-"+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $path|Out-Null;$path}

$liveLayout=Get-AihLayout $InstallRoot
# Deterministic node resolution for fixture install roots (the fixture has no
# runtime node; the controller service falls back to PATH, so we prepend the
# pinned runtime BEFORE the system PATH).
$env:PATH=(Split-Path -Parent $liveLayout.Node)+';'+$env:PATH

# ── fixture install root (isolated copies of config + scripts + live settings) ──
$fixture=New-Fixture 'install'
$workspace=New-Fixture 'ws'
try{
    New-Item -ItemType Directory -Path (Join-Path $fixture 'config') -Force|Out-Null
    Copy-Item (Join-Path $liveLayout.Root 'config/routing-policy.json') (Join-Path $fixture 'config/routing-policy.json')
    Copy-Item (Join-Path $liveLayout.Root 'config/engineering-profiles.json') (Join-Path $fixture 'config/engineering-profiles.json')
    Copy-Item (Join-Path $liveLayout.Root 'config/model-registry.json') (Join-Path $fixture 'config/model-registry.json')
    New-Item -ItemType Directory -Path (Join-Path $fixture 'scripts') -Force|Out-Null
    foreach($script in @('Platform.ps1','Common.ps1','Routing.ps1','TaskController.ps1','Telemetry.ps1','VisualPacketIntegrity.ps1','VisualReview.ps1','Invoke-VisualReview.mjs','CodexReview.ps1')){
        Copy-Item (Join-Path $liveLayout.Root ('scripts/'+$script)) (Join-Path $fixture ('scripts/'+$script))
    }
    New-Item -ItemType Directory -Path (Join-Path $fixture 'data') -Force|Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'data/routing') -Force|Out-Null
    $fixtureLayout=Get-AihLayout $fixture
    $env:AIH_VISUAL_TEST_KEY='fixture-key'
    @'
engineering-profile: deepseek-codex
llm-pi-ai:
  providers:
    deepseek-vision-direct:
      displayName: DeepSeek V4 Flash Vision (direct)
      apiKeyEnv: AIH_VISUAL_TEST_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:9
      reasoning: high
      models:
        - id: deepseek-v4-flash-vision-exp
          name: DeepSeek V4 Flash Vision (Exp)
'@|Set-Content -Path $fixtureLayout.Settings -Encoding UTF8

    $visualReviewScript=Join-Path $fixture 'scripts/VisualReview.ps1'
    $testPng=Join-Path $workspace 'shot-source.png'
    # Deterministic PNG-magic evidence bytes (the service validates the
    # extension + size only; the magic check lives in the capture script).
    [byte[]]$pngBytes=0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52
    [IO.File]::WriteAllBytes($testPng,$pngBytes)

    function Invoke-AihVisual {
        param([string[]]$Screenshots,[string[]]$References,[switch]$Execute,[string]$MockResponseFile,[string]$PreviousResultPath,[string]$PayloadFile,[string]$Trigger)
        $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$visualReviewScript,'-InstallRoot',$fixture,'-Workspace',$workspace,'-TaskId',$script:taskId,'-Question','review the home screen')
        foreach($shot in @($Screenshots)){$arguments+=@('-Screenshots',$shot)}
        foreach($reference in @($References)){$arguments+=@('-References',$reference)}
        if($Execute){$arguments+='-Execute'}
        if($MockResponseFile){$arguments+=@('-MockResponseFile',$MockResponseFile)}
        if($PreviousResultPath){$arguments+=@('-PreviousResultPath',$PreviousResultPath)}
        if($PayloadFile){$arguments+=@('-PayloadFile',$PayloadFile)}
        if($Trigger){$arguments+=@('-Trigger',$Trigger)}
        $output=& 'powershell.exe' $arguments 2>&1|ForEach-Object{[string]$_}
        [pscustomobject]@{exitCode=$LASTEXITCODE;text=($output-join [Environment]::NewLine)}
    }
    function Set-AihFixtureSettings {
        # Pipeline-aware: here-strings are piped in, so the content MUST be
        # captured from the pipeline, never from a positional argument.
        param([Parameter(ValueFromPipeline=$true)][string]$Content)
        begin{$chunks=@()}
        process{$chunks+=$Content}
        end{(($_-join "`n"))|Set-Content -Path $fixtureLayout.Settings -Encoding UTF8}
    }

    # ── 1. MODEL REGISTRY VISION CAPABILITY ──────────────────────────────────
    $registry=Get-AihModelRegistry $fixtureLayout.ModelRegistry
    $visionEntry=$null
    foreach($model in @($registry.models)){if($model.id -eq 'deepseek-v4-flash-vision-exp'){$visionEntry=$model}}
    Assert-Aih ($null-ne$visionEntry) '1: deepseek-v4-flash-vision-exp is registered'
    Assert-Aih ([bool]$visionEntry.supportsVision) '1: vision model declares supportsVision=true'
    Assert-Aih ([bool]$visionEntry.readOnlyDefault) '1: vision model declares readOnlyDefault=true'
    Assert-Aih ([bool]$visionEntry.enabled) '1: vision model is enabled'
    $profilesDoc=Get-AihEngineeringProfiles $fixtureLayout.EngineeringProfiles $fixtureLayout.CustomEngineeringProfile
    $policy=Get-AihRoutingPolicy $fixtureLayout.RoutingPolicy
    $deepseekProfile=$null;$glmProfile=$null
    foreach($profile in @($profilesDoc.profiles)){if($profile.id -eq 'deepseek-codex'){$deepseekProfile=$profile};if($profile.id -eq 'glm-codex'){$glmProfile=$profile}}
    Assert-Aih ($deepseekProfile.roles.visualReviewer.model -eq 'deepseek-v4-flash-vision-exp' -and $deepseekProfile.roles.visualReviewer.reasoning -eq 'high') '1: deepseek-codex binds visualReviewer to the vision model / high'
    Assert-Aih ($glmProfile.roles.visualReviewer.model -eq 'deepseek-v4-flash-vision-exp' -and $glmProfile.roles.visualReviewer.reasoning -eq 'high') '1: glm-codex binds visualReviewer to the vision model / high'
    $target=Resolve-AihModelTarget $registry ([pscustomobject]@{Id='deepseek-codex';DisplayName='x';Config=$deepseekProfile}) 'visualReviewer'
    Assert-Aih ($target.Provider -eq 'deepseek-vision-direct' -and $target.Reasoning -eq 'high' -and $target.Model -eq 'deepseek-v4-flash-vision-exp') '1: visualReviewer resolves provider deepseek-vision-direct / high'

    # ── 2. ROLE REQUIREMENTS + NON-VISION REJECTION ──────────────────────────
    $req=Get-AihRoleRequirements 'visualReviewer'
    Assert-Aih (-not$req.writable -and -not$req.requiresTools -and -not$req.requiresSolLocal -and [bool]$req.requiresReasoning -and [bool]$req.requiresVision) '2: visualReviewer requirements are read-only/no-tools/reasoning/vision'
    $reviewerReq=Get-AihRoleRequirements 'reviewer'
    Assert-Aih ([bool]$reviewerReq.requiresSolLocal -and -not$reviewerReq.requiresVision) '2: existing reviewer requirements unchanged (sol-local, no vision)'
    Assert-Aih (Test-AihModelRoleCompatible $visionEntry 'visualReviewer' 'high') '2: vision model is compatible with visualReviewer'
    $flashEntry=$null
    foreach($model in @($registry.models)){if($model.id -eq 'deepseek-v4-flash'){$flashEntry=$model}}
    Assert-Aih (-not(Test-AihModelRoleCompatible $flashEntry 'visualReviewer' 'high')) '2: non-vision model (deepseek-v4-flash) rejected for visualReviewer'
    $noDeclarationEntry=[pscustomobject]@{id='no-vision-declaration';displayName='x';enabled=$true;model='no-vision-declaration';providers=@{default='deepseek-vision-direct'};supportedReasoningLevels=@('off','high');supportsTools=$false;supportsReasoning=$true}
    Assert-Aih (-not(Test-AihModelRoleCompatible $noDeclarationEntry 'visualReviewer' 'high')) '2: a MISSING vision declaration fails closed (never treated as vision-capable)'
    $compatible=@(Get-AihCompatibleModelsForRole $registry 'visualReviewer')
    Assert-Aih ($compatible-contains'deepseek-v4-flash-vision-exp' -and $compatible-notcontains'deepseek-v4-flash') '2: compatible-models list contains only vision-capable models'

    # ── 3. EDITOR STATE EXPOSES THE OPTIONAL ROLE ────────────────────────────
    $editorStateRaw=& 'powershell.exe' -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $liveLayout.Root 'scripts/EngineeringProfile.ps1') -Action get -InstallRoot $fixture 2>&1
    $editorState=(($editorStateRaw|ForEach-Object{[string]$_})-join '')|ConvertFrom-Json
    Assert-Aih ([bool]$editorState.roleRequirements.visualReviewer.requiresVision -and -not[bool]$editorState.roleRequirements.visualReviewer.writable) '3: editor state exposes visualReviewer requirements'
    Assert-Aih (@($editorState.roleModels.visualReviewer)-contains'deepseek-v4-flash-vision-exp') '3: editor state lists the vision model as visualReviewer-compatible'

    # ── 4. MISSING SCREENSHOT (fail closed before any transport) ─────────────
    $task=New-AihTask $workspace 'visual review smoke task'
    $script:taskId=$task.taskId
    $missing=Invoke-AihVisual -Screenshots @() -Execute
    $missingJson=$missing.text|ConvertFrom-Json
    Assert-Aih ($missing.exitCode -eq 3 -and $missingJson.ok -eq $false -and $missingJson.errorKind -eq 'visual-review-packet-rejected') '4: missing screenshot fails closed with a structured rejection (exit 3)'
    Assert-Aih ((@($missingJson.violations)|Where-Object{$_-match'no screenshot'}|Measure-Object).Count -ge 1) '4: the rejection names the missing screenshot violation'

    # ── 5. INVALID IMAGE PATH ─────────────────────────────────────────────────
    $invalid=Invoke-AihVisual -Screenshots @('C:\definitely-not-here\shot.png') -Execute
    $invalidJson=$invalid.text|ConvertFrom-Json
    Assert-Aih ($invalid.exitCode -eq 3 -and $invalidJson.errorKind -eq 'visual-review-packet-rejected') '5: invalid image path fails closed (exit 3)'
    Assert-Aih ((@($invalidJson.violations)|Where-Object{$_-match'image path does not exist'}|Measure-Object).Count -ge 1) '5: the rejection names the invalid image path'

    # ── 6. PACKET-ONLY MODE: bounded packet + evidence persistence ────────────
    $packetRun1=Invoke-AihVisual -Screenshots @($testPng)
    $packet1=$packetRun1.text|ConvertFrom-Json
    Assert-Aih ($packetRun1.exitCode -eq 0 -and $packet1.kind -eq 'visual-review-packet') '6: packet-only mode returns the packet (exit 0, no transport)'
    $iterationDir1=Join-Path (Join-Path (Join-Path $workspace '.ai-harness/runs') $task.taskId) 'visual/iteration-01'
    Assert-Aih (Test-Path (Join-Path $iterationDir1 'packet.json')) '6: packet.json persisted under .ai-harness/runs/<TASK>/visual/iteration-01'
    $packetDoc=Get-Content (Join-Path $iterationDir1 'packet.json') -Raw|ConvertFrom-Json
    Assert-Aih ($packetDoc.model.provider -eq 'deepseek-vision-direct' -and $packetDoc.model.supportsVision -eq $true) '6: packet records the resolved vision model/provider'
    Assert-Aih ($packetDoc.enforcement.readOnly -eq $true -and $packetDoc.enforcement.completionAuthority -eq $false) '6: packet enforcement carries read-only + no completion authority'
    Assert-Aih (@($packetDoc.images).Count -eq 1 -and [string]$packetDoc.images[0].sha256 -match'^[0-9a-f]{64}$') '6: evidence image copied with sha256'
    Assert-Aih ((Test-Path -LiteralPath $packetDoc.images[0].storedPath)-and$packetDoc.images[0].fileName-match'^subject-iteration-00-01-shot-source-[0-9a-f]{12}\.png$') '6: the screenshot persists under its collision-proof packet-local name'
    $packetRun2=Invoke-AihVisual -Screenshots @($testPng)
    $packet2=$packetRun2.text|ConvertFrom-Json
    Assert-Aih ($packet2.iteration -eq 2) '6: next invocation allocates iteration-02 deterministically'

    # ── 6b. PACKET EVIDENCE INTEGRITY FAILS BEFORE TRANSPORT ────────────────
    $badShaPayload=Join-Path $workspace 'bad-sha-payload.json'
    @{Workspace=$workspace;Question='must not reach provider';Screenshots=@($testPng);ScreenshotEvidence=@(@{path=$testPng;expectedSha256=('0'*64);sourceIteration=2;originalSourcePath=$testPng})}|ConvertTo-Json -Depth 8|Set-Content $badShaPayload -Encoding UTF8
    $badShaRun=Invoke-AihVisual -Screenshots @() -Execute -PayloadFile $badShaPayload
    $badShaJson=$badShaRun.text|ConvertFrom-Json
    Assert-Aih ($badShaRun.exitCode-eq3-and$badShaJson.errorKind-eq'visual-review-packet-integrity-failed') '6b: declared/source SHA mismatch fails closed before provider invocation'
    $badShaDir=Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness/runs') $task.taskId) 'visual') ('iteration-{0:D2}'-f[int]$badShaJson.iteration)
    $badShaFailure=Get-Content (Join-Path $badShaDir 'packet-integrity-failure.json') -Raw|ConvertFrom-Json
    $badShaTelemetry=Get-Content (Join-Path (Join-Path (Join-Path $workspace '.ai-harness/runs') $task.taskId) 'telemetry.json') -Raw|ConvertFrom-Json
    Assert-Aih ($badShaFailure.providerCalls-eq0-and$badShaTelemetry.modelCalls-eq0-and-not(Test-Path (Join-Path $badShaDir 'result.json'))) '6b: SHA integrity failure consumes zero provider calls and writes no review result'

    $duplicatePayload=Join-Path $workspace 'duplicate-payload.json'
    @{Workspace=$workspace;Question='must not reach provider';Screenshots=@($testPng,$testPng)}|ConvertTo-Json -Depth 8|Set-Content $duplicatePayload -Encoding UTF8
    $duplicateRun=Invoke-AihVisual -Screenshots @() -Execute -PayloadFile $duplicatePayload
    $duplicateJson=$duplicateRun.text|ConvertFrom-Json
    Assert-Aih ($duplicateRun.exitCode-eq3-and$duplicateJson.errorKind-eq'visual-review-packet-integrity-failed'-and@($duplicateJson.violations|Where-Object{$_-match'duplicate intended image entry'}).Count-ge1) '6b: duplicate intended packet image fails closed before provider invocation'

    # ── 7. PROVIDER FAILURE (mocked transport) ────────────────────────────────
    $mockDir=Join-Path $fixture 'mock'
    New-Item -ItemType Directory -Path $mockDir -Force|Out-Null
    $providerErrorMock=Join-Path $mockDir 'provider-error.json'
    @'
{ "status": 500, "body": { "error": { "message": "upstream provider exploded", "type": "server_error", "code": "500" } } }
'@|Set-Content -Path $providerErrorMock -Encoding UTF8
    $providerFail=Invoke-AihVisual -Screenshots @($testPng) -Execute -MockResponseFile $providerErrorMock
    $providerFailJson=$providerFail.text|ConvertFrom-Json
    Assert-Aih ($providerFail.exitCode -eq 3 -and $providerFailJson.ok -eq $false -and $providerFailJson.errorKind -eq 'visual-review-provider-error') '7: provider failure fails closed with a structured provider error'
    $failIterationDir=Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness/runs') $task.taskId) 'visual') ('iteration-{0:D2}'-f[int]$providerFailJson.iteration)
    Assert-Aih (Test-Path (Join-Path $failIterationDir 'transport-error.json')) '7: the transport failure is persisted as transport-error.json'
    $failDoc=Get-Content (Join-Path $failIterationDir 'transport-error.json') -Raw|ConvertFrom-Json
    Assert-Aih ([int]$failDoc.attemptCount -eq 2 -and @($failDoc.attempts).Count -eq 2) '7: a transient 5xx is retried exactly once and both attempts are persisted'
    Assert-Aih ([int]$failDoc.attempts[0].attempt -eq 1 -and [int]$failDoc.attempts[1].attempt -eq 2) '7: both attempt records carry their attempt index'
    Assert-Aih (-not(Test-Path (Join-Path $failIterationDir 'result.json'))) '7: no result.json is written when the provider fails'

    # ── 7b. TRANSIENT RETRY THEN SUCCESS (exactly one retry, max 2 calls) ──────
    # The mock response document may be a JSON ARRAY of {status, body} entries:
    # attempt 1 consumes entry 1, the single retry consumes entry 2.
    $retryMock=Join-Path $mockDir 'retry-then-success.json'
    $retryReview=@{verdict='BLOCK';score=3;dimensions=@{hierarchy=4;spacing=3;density=4;typography=5;alignment=4;colorDiscipline=4;interactionClarity=3;brandFidelity=4;platformQuality=3};findings=@(@{id='R1';severity='blocker';category='hierarchy';area='nav';observation='x';whyItMatters='y';recommendation='z';confidence='high'});strengths=@('a');summary='b'}|ConvertTo-Json -Depth 6
    $retryFence=[string][char]96+[char]96+[char]96
    $retryBody=@{model='deepseek-v4-flash-vision-exp';choices=@(@{message=@{content=$retryFence+'json'+$retryReview+$retryFence}});usage=@{prompt_tokens=90;completion_tokens=40}}
    @(
        @{status=503;body=@{error=@{message='upstream temporarily unavailable'}}},
        @{status=200;body=$retryBody}
    )|ConvertTo-Json -Depth 8|Set-Content -Path $retryMock -Encoding UTF8
    $retryRun=Invoke-AihVisual -Screenshots @($testPng) -Execute -MockResponseFile $retryMock
    $retryJson=$retryRun.text|ConvertFrom-Json
    Assert-Aih ($retryRun.exitCode -eq 0 -and $retryJson.ok -eq $true -and $retryJson.verdict -eq 'BLOCK') '7b: a transient failure followed by success completes (verdict BLOCK)'
    $retryIterationDir=Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness/runs') $task.taskId) 'visual') ('iteration-{0:D2}'-f[int]$retryJson.iteration)
    Assert-Aih (Test-Path (Join-Path $retryIterationDir 'transport-retry.json')) '7b: the retry evidence is persisted as transport-retry.json'
    $retryDoc=Get-Content (Join-Path $retryIterationDir 'transport-retry.json') -Raw|ConvertFrom-Json
    Assert-Aih ([int]$retryDoc.attemptCount -eq 2 -and @($retryDoc.attempts).Count -eq 2) '7b: transport-retry.json records both provider calls (max 2)'
    $retryResultDoc=Get-Content (Join-Path $retryIterationDir 'result.json') -Raw|ConvertFrom-Json
    Assert-Aih ([int]$retryResultDoc.transport.attemptCount -eq 2) '7b: result.json records the two transport attempts'

    # ── 8. MALFORMED MODEL JSON ────────────────────────────────────────────────
    $garbageMock=Join-Path $mockDir 'garbage.json'
    @'
{ "status": 200, "body": { "model": "deepseek-v4-flash-vision-exp", "choices": [ { "message": { "content": "this is not json at all" } } ] } }
'@|Set-Content -Path $garbageMock -Encoding UTF8
    $garbage=Invoke-AihVisual -Screenshots @($testPng) -Execute -MockResponseFile $garbageMock
    $garbageJson=$garbage.text|ConvertFrom-Json
    Assert-Aih ($garbage.exitCode -eq 3 -and $garbageJson.errorKind -eq 'visual-review-schema-invalid') '8: malformed model JSON fails closed with a schema error (exit 3)'
    $garbageIterationDir=Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness/runs') $task.taskId) 'visual') ('iteration-{0:D2}'-f[int]$garbageJson.iteration)
    $garbageDoc=Get-Content (Join-Path $garbageIterationDir 'transport-error.json') -Raw|ConvertFrom-Json
    Assert-Aih ([int]$garbageDoc.attemptCount -eq 1) '8: a deterministic schema failure never burns a second provider call'

    # ── 8b. STRUCTURED OUTPUT CONTRACT (V1.1 hardening) ──────────────────────
    # Provider constrained output (response_format json_object) does NOT
    # replace Nexus validation: prose, arrays, and schema-invalid objects
    # must still fail closed; markdown-fenced JSON stays parseable.
    $arrayMock=Join-Path $mockDir 'array.json'
    @{status=200;body=@{model='deepseek-v4-flash-vision-exp';choices=@(@{message=@{content='[{"verdict":"PASS"}]'}})}}|ConvertTo-Json -Depth 8|Set-Content -Path $arrayMock -Encoding UTF8
    $arrayRun=Invoke-AihVisual -Screenshots @($testPng) -Execute -MockResponseFile $arrayMock
    $arrayJson=$arrayRun.text|ConvertFrom-Json
    Assert-Aih ($arrayRun.exitCode -eq 3 -and $arrayJson.errorKind -eq 'visual-review-schema-invalid') '8b: a JSON array instead of an object fails closed'
    Assert-Aih ((@($arrayJson.violations)|Where-Object{$_-match'not a JSON object'}|Measure-Object).Count -ge 1) '8b: the rejection names the array-vs-object violation'
    $proseMock=Join-Path $mockDir 'prose.json'
    @{status=200;body=@{model='deepseek-v4-flash-vision-exp';choices=@(@{message=@{content='Here is the review: the layout looks good overall.'}})}}|ConvertTo-Json -Depth 8|Set-Content -Path $proseMock -Encoding UTF8
    $proseRun=Invoke-AihVisual -Screenshots @($testPng) -Execute -MockResponseFile $proseMock
    $proseJson=$proseRun.text|ConvertFrom-Json
    Assert-Aih ($proseRun.exitCode -eq 3 -and $proseJson.errorKind -eq 'visual-review-schema-invalid') '8b: prose instead of JSON fails closed (never accepted)'

    # ── 8c. PREVIOUS-FINDING COVERAGE CONTRACT (V2) ───────────────────────────
    # When a previous result is packed, previousReview must classify EVERY
    # previous finding id; omissions and invented ids fail closed.
    $previousResultFile=Join-Path $mockDir 'previous-result.json'
    @{result=@{verdict='REVISE';score=6;findings=@(@{id='P1';severity='medium';category='c';area='a';observation='o';whyItMatters='w';recommendation='r';confidence='medium'},@{id='P2';severity='low';category='c';area='a';observation='o';whyItMatters='w';recommendation='r';confidence='low'})}}|ConvertTo-Json -Depth 8|Set-Content -Path $previousResultFile -Encoding UTF8
    $dims=@{hierarchy=8;spacing=8;density=8;typography=8;alignment=8;colorDiscipline=8;interactionClarity=8;brandFidelity=8;platformQuality=8}
    $findingOne=@(@{id='N1';severity='low';category='c';area='a';observation='o';whyItMatters='w';recommendation='r';confidence='low'})
    $missingMock=Join-Path $mockDir 'cov-missing.json'
    @{status=200;body=@{model='deepseek-v4-flash-vision-exp';choices=@(@{message=@{content=(@{verdict='REVISE';score=7;dimensions=$dims;findings=$findingOne;strengths=@('ok');summary='s'}|ConvertTo-Json -Depth 8)}})}}|ConvertTo-Json -Depth 8|Set-Content -Path $missingMock -Encoding UTF8
    $missingRun=Invoke-AihVisual -Screenshots @($testPng) -Execute -MockResponseFile $missingMock -PreviousResultPath $previousResultFile
    $missingJson=$missingRun.text|ConvertFrom-Json
    Assert-Aih ($missingRun.exitCode -eq 3 -and $missingJson.errorKind -eq 'visual-review-schema-invalid') '8c: omitted previousReview classifications fail closed'
    Assert-Aih ((@($missingJson.violations)|Where-Object{$_-match"missing a classification for previous finding id 'P1'"}|Measure-Object).Count -ge 1) '8c: the rejection names the missing previous finding id'
    $coveredReview=@{verdict='REVISE';score=7;dimensions=$dims;findings=$findingOne;previousReview=@(@{id='P1';status='unchanged';note='same' },@{id='P2';status='improved';note='better' });strengths=@('ok');summary='s'}
    $coveredMock=Join-Path $mockDir 'cov-covered.json'
    @{status=200;body=@{model='deepseek-v4-flash-vision-exp';choices=@(@{message=@{content=($coveredReview|ConvertTo-Json -Depth 8)}})}}|ConvertTo-Json -Depth 8|Set-Content -Path $coveredMock -Encoding UTF8
    $coveredRun=Invoke-AihVisual -Screenshots @($testPng) -Execute -MockResponseFile $coveredMock -PreviousResultPath $previousResultFile
    Assert-Aih ($coveredRun.exitCode -eq 0) '8c: full previous finding coverage is accepted'
    $inventedMock=Join-Path $mockDir 'cov-invented.json'
    $inventedReview=@{verdict='REVISE';score=7;dimensions=$dims;findings=$findingOne;previousReview=@(@{id='P1';status='unchanged';note='same' },@{id='PX';status='resolved';note='made up' });strengths=@('ok');summary='s'}
    @{status=200;body=@{model='deepseek-v4-flash-vision-exp';choices=@(@{message=@{content=($inventedReview|ConvertTo-Json -Depth 8)}})}}|ConvertTo-Json -Depth 8|Set-Content -Path $inventedMock -Encoding UTF8
    $inventedRun=Invoke-AihVisual -Screenshots @($testPng) -Execute -MockResponseFile $inventedMock -PreviousResultPath $previousResultFile
    $inventedJson=$inventedRun.text|ConvertFrom-Json
    Assert-Aih ($inventedRun.exitCode -eq 3 -and $inventedJson.errorKind -eq 'visual-review-schema-invalid') '8c: an invented previous finding id fails closed'
    $manualOkMock=Join-Path $mockDir 'cov-manual-ok.json'
    $manualReview=@{verdict='PASS';score=9;dimensions=$dims;findings=@();previousReview=@(@{id='PX';status='unchanged';note='no previous result packed' });strengths=@('ok');summary='s'}
    @{status=200;body=@{model='deepseek-v4-flash-vision-exp';choices=@(@{message=@{content=($manualReview|ConvertTo-Json -Depth 8)}})}}|ConvertTo-Json -Depth 8|Set-Content -Path $manualOkMock -Encoding UTF8
    $manualOkRun=Invoke-AihVisual -Screenshots @($testPng) -Execute -MockResponseFile $manualOkMock
    Assert-Aih ($manualOkRun.exitCode -eq 0) '8c: without a previous result the coverage contract is not applied'

    # ── 9. FORBIDDEN OUTPUT KEYS (no source edits / code patches) ─────────────
    $patchMock=Join-Path $mockDir 'patch.json'
    $reviewWithPatch=@{verdict='PASS';score=9;dimensions=@{hierarchy=9;spacing=9;density=9;typography=9;alignment=9;colorDiscipline=9;interactionClarity=9;brandFidelity=9;platformQuality=9};findings=@();strengths=@('clean');summary='great';patch='--- a/file'}|ConvertTo-Json -Depth 6
    @{status=200;body=@{model='deepseek-v4-flash-vision-exp';choices=@(@{message=@{content=$reviewWithPatch}})};}|ConvertTo-Json -Depth 8|Set-Content -Path $patchMock -Encoding UTF8
    $patched=Invoke-AihVisual -Screenshots @($testPng) -Execute -MockResponseFile $patchMock
    $patchedJson=$patched.text|ConvertFrom-Json
    Assert-Aih ($patched.exitCode -eq 3 -and $patchedJson.errorKind -eq 'visual-review-schema-invalid') '9: a result carrying a patch key fails closed (visual reviewer must not return source edits)'
    Assert-Aih ((@($patchedJson.violations)|Where-Object{$_-match'forbidden'}|Measure-Object).Count -ge 1) '9: the schema error names the forbidden key'

    # ── 10. VALID REVIEW END-TO-END (mocked transport) ─────────────────────────
    $validReview=@{
        verdict='REVISE';score=6.5
        dimensions=@{hierarchy=7;spacing=5;density=6;typography=8;alignment=7;colorDiscipline=6;interactionClarity=5;brandFidelity=7;platformQuality=6}
        findings=@(@{id='F1';severity='high';category='spacing';area='top bar';observation='controls crowd the edge';whyItMatters='touch targets need separation';recommendation='add 12dp margin';confidence='high'})
        strengths=@('clear hierarchy');summary='solid layout, spacing needs work'
    }|ConvertTo-Json -Depth 6
    # Build the JSON fence WITHOUT literal backtick characters in this script
    # (a trailing backtick before a quote would escape it and break parsing).
    $visualFence=[string][char]96+[char]96+[char]96
    $visualNewline=[string][char]10
    $fencedContent=$visualFence+'json'+$visualNewline+$validReview+$visualNewline+$visualFence
    $validMock=Join-Path $mockDir 'valid.json'
    @{status=200;body=@{model='deepseek-v4-flash-vision-exp';choices=@(@{message=@{content=$fencedContent}});usage=@{prompt_tokens=120;completion_tokens=80}};}|ConvertTo-Json -Depth 8|Set-Content -Path $validMock -Encoding UTF8
    $valid=Invoke-AihVisual -Screenshots @($testPng) -Execute -MockResponseFile $validMock
    $validJson=$valid.text|ConvertFrom-Json
    Assert-Aih ($valid.exitCode -eq 0 -and $validJson.ok -eq $true -and $validJson.kind -eq 'visual-review') '10: valid visual review completes (exit 0)'
    Assert-Aih ($validJson.verdict -eq 'REVISE' -and $validJson.score -eq 6.5) '10: verdict + score are validated and normalized'
    Assert-Aih (@($validJson.findings).Count -eq 1 -and $validJson.findings[0].id -eq 'F1' -and $validJson.findings[0].severity -eq 'high' -and $validJson.findings[0].confidence -eq 'high') '10: findings carry the strict field contract'
    $iterationDir3=Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness/runs') $task.taskId) 'visual') ('iteration-{0:D2}'-f[int]$validJson.iteration)
    $resultDoc=Get-Content (Join-Path $iterationDir3 'result.json') -Raw|ConvertFrom-Json
    Assert-Aih ($resultDoc.kind -eq 'visual-review-result' -and $resultDoc.result.verdict -eq 'REVISE') '10: result.json persisted with the validated critique'
    Assert-Aih ($resultDoc.readOnly -eq $true -and $resultDoc.completionAuthority -eq $false -and $resultDoc.humanAcceptance -eq $false) '10: result carries read-only + no-human-acceptance + no-completion-authority'
    Assert-Aih ($resultDoc.model.provider -eq 'deepseek-vision-direct' -and $resultDoc.model.reasoning -eq 'high') '10: result records the resolved provider/model identity'
    Assert-Aih ([int]$resultDoc.transport.attemptCount -eq 1 -and @($resultDoc.transport.attempts).Count -eq 1) '10: a schema-valid result is never retried (exactly one provider call)'
    Assert-Aih (-not(Test-Path (Join-Path $iterationDir3 'transport-retry.json'))) '10: no retry evidence is written when no retry occurred'
    $telemetryPath=Join-Path (Join-Path $workspace '.ai-harness/runs') ($task.taskId+'/telemetry.json')
    $telemetryDoc=Get-Content $telemetryPath -Raw|ConvertFrom-Json
    Assert-Aih ($telemetryDoc.executionClass -eq $task.executionClass) '10: telemetry PRESERVES the real task execution class (visual review is not an execution class)'
    Assert-Aih ($telemetryDoc.capability -eq 'visual-review' -and $telemetryDoc.role -eq 'visualReviewer') '10: telemetry represents visual review as capability/role, not execution class'
    Assert-Aih ($telemetryDoc.finalResult -eq 'REVISE' -and [int]$telemetryDoc.modelCalls -eq 1) '10: telemetry records the visual review capability call'
    $taskAfter=Get-AihTask $workspace $task.taskId
    Assert-Aih ($taskAfter.status -eq 'ready' -and [int]$taskAfter.attempt -eq 0) '10: the visual reviewer never alters task state'

    # ── 11. BACKWARD COMPATIBILITY ─────────────────────────────────────────────
    $normalDecision=Invoke-AihRoutingDecision 'implement ordinary change' $fixture $fixtureLayout.RoutingPolicy (Join-Path $fixture 'data/routing') 'visual-backcompat-1' 'aih-engineering' -DryRun -SettingsPath $fixtureLayout.Settings
    Assert-Aih ($normalDecision.executionClass -eq 'engineer_normal' -and $normalDecision.role -eq 'primaryEngineer') '11: engineering routing is unchanged by the visual role'
    Assert-Aih ($normalDecision.provider -eq 'flash-high-direct' -and $normalDecision.model -eq 'deepseek-v4-flash') '11: primaryEngineer resolution unchanged (flash-high-direct / deepseek-v4-flash)'
    $reviewDecision=Invoke-AihRoutingDecision 'review the boundary' $fixture $fixtureLayout.RoutingPolicy (Join-Path $fixture 'data/routing') 'visual-backcompat-2' 'aih-engineering' -DryRun -SettingsPath $fixtureLayout.Settings -ReviewRequested
    Assert-Aih ($reviewDecision.executionClass -eq 'reviewer' -and $reviewDecision.model -eq 'gpt-5.6-sol' -and $reviewDecision.provider -eq 'sol-local') '11: independent reviewer resolution unchanged (sol-local / gpt-5.6-sol)'

    # custom profile WITHOUT visualReviewer stays valid (optional role)
    @'
{
  "schemaVersion": 1,
  "roles": {
    "primaryEngineer": { "model": "glm-5.3", "reasoning": "high" },
    "deepEngineer": { "model": "glm-5.3", "reasoning": "max" },
    "reviewer": { "model": "gpt-5.6-sol", "reasoning": "medium" },
    "solver": { "model": "gpt-5.6-sol", "reasoning": "high" },
    "fallback": { "model": "deepseek-v4-flash", "reasoning": "max" }
  }
}
'@|Set-Content -Path $fixtureLayout.CustomEngineeringProfile -Encoding UTF8
    @'
engineering-profile: custom
llm-pi-ai:
  providers:
    deepseek-vision-direct:
      displayName: DeepSeek V4 Flash Vision (direct)
      apiKeyEnv: AIH_VISUAL_TEST_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:9
      reasoning: high
      models:
        - id: deepseek-v4-flash-vision-exp
          name: DeepSeek V4 Flash Vision (Exp)
'@|Set-AihFixtureSettings
    $customDecision=Invoke-AihRoutingDecision 'implement ordinary change' $fixture $fixtureLayout.RoutingPolicy (Join-Path $fixture 'data/routing') 'visual-backcompat-3' 'aih-engineering' -DryRun -SettingsPath $fixtureLayout.Settings -CustomProfilePath $fixtureLayout.CustomEngineeringProfile
    Assert-Aih ($customDecision.executionClass -eq 'engineer_normal' -and $customDecision.profile -eq 'custom') '11: custom profile WITHOUT visualReviewer still resolves engineering roles'
    $unbound=Invoke-AihVisual -Screenshots @($testPng) -Execute -MockResponseFile $validMock
    $unboundJson=$unbound.text|ConvertFrom-Json
    Assert-Aih ($unbound.exitCode -eq 3 -and $unboundJson.errorKind -eq 'visual-review-role-unbound') '11: visual review fails closed (structured) when the active profile does not bind visualReviewer'
    # restore the built-in profile for remaining assertions
    @'
engineering-profile: deepseek-codex
llm-pi-ai:
  providers:
    deepseek-vision-direct:
      displayName: DeepSeek V4 Flash Vision (direct)
      apiKeyEnv: AIH_VISUAL_TEST_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:9
      reasoning: high
      models:
        - id: deepseek-v4-flash-vision-exp
          name: DeepSeek V4 Flash Vision (Exp)
'@|Set-AihFixtureSettings

    # ── 12. EXISTING REVIEWER / CODEX BEHAVIOR UNCHANGED ───────────────────────
    $reviewTask=New-AihTask $workspace 'independent review compatibility task'
    $reviewPacket=New-AihReviewPacket $workspace $reviewTask.taskId 'audit the boundary' @() 'diff: ok' @([pscustomobject]@{path='src/a.ts';content='const a=1'}) @() '' $policy
    Assert-Aih ($null-ne$reviewPacket.enforcement -and [bool]$reviewPacket.enforcement.readOnly) '12: review packet behavior unchanged (read-only enforcement)'
    $validatedReview=Test-AihReviewResult ([pscustomobject]@{verdict='pass';findings=@()})
    Assert-Aih ($validatedReview.result.verdict -eq 'pass' -and -not[bool]$validatedReview.completionAuthority) '12: review result validation unchanged (verdict pass, no completion authority)'
    Assert-Aih (@(Get-AihCompatibleModelsForRole $registry 'reviewer') -contains 'gpt-5.6-sol') '12: reviewer-compatible models remain sol-local only'


    # ── 13. UNCAPPED PROVIDER REQUEST (end-to-end wire proof, V1.2) ───────────
    # A loopback provider captures the REAL generated chat-completions request
    # for BOTH triggers: no max_tokens / max_completion_tokens /
    # max_output_tokens may be present, manual and automatic stay on the SAME
    # uncapped transport path, finishReason is persisted, and the response's
    # reasoning_content is never persisted anywhere.
    $tcpListener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)
    $tcpListener.Start()
    $wirePort=([System.Net.IPEndPoint]$tcpListener.LocalEndpoint).Port
    $tcpListener.Stop()
    $wireServer=Join-Path $workspace 'wire-capture-server.cjs'
    @'
const http = require('http')
const fs = require('fs')
const port = Number(process.argv[2])
const out = process.argv[3]
const total = Number(process.argv[4] || 2)
const REVIEW = { verdict: 'REVISE', score: 6.5, dimensions: { hierarchy: 7, spacing: 5, density: 6, typography: 8, alignment: 7, colorDiscipline: 6, interactionClarity: 5, brandFidelity: 7, platformQuality: 6 }, findings: [ { id: 'F1', severity: 'high', category: 'spacing', area: 'top bar', observation: 'crowded', whyItMatters: 'touch targets', recommendation: 'add margin', confidence: 'high' } ], strengths: ['clear hierarchy'], summary: 'solid layout, spacing needs work' }
const RESPONSE = { model: 'deepseek-v4-flash-vision-exp', choices: [ { message: { content: JSON.stringify(REVIEW), reasoning_content: 'REASONING-SENTINEL-WIRE' }, finish_reason: 'stop' } ], usage: { prompt_tokens: 100, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 50 } } }
const captured = []
const server = http.createServer((req, res) => {
  let data = ''
  req.on('data', (c) => { data += c })
  req.on('end', () => {
    try { captured.push(JSON.parse(data)) } catch (e) { captured.push({ unparseable: true }) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(RESPONSE))
    fs.writeFileSync(out, JSON.stringify({ requests: captured }, null, 2))
    if (captured.length >= total) setTimeout(() => process.exit(0), 100)
  })
})
server.listen(port, '127.0.0.1')
setTimeout(() => process.exit(0), 60000)
'@|Set-Content -Path $wireServer -Encoding ASCII
    $wireOut=Join-Path $workspace 'wire-captured-requests.json'
    if(Test-Path $wireOut){Remove-Item $wireOut -Force}
    $nodeExe=(Get-Command node.exe).Source
    $wireProc=Start-Process -FilePath $nodeExe -ArgumentList @($wireServer,[string]$wirePort,$wireOut,'2') -PassThru -WindowStyle Hidden
    $wireReady=$false
    foreach($i in 1..80){ try{ $probe=New-Object Net.Sockets.TcpClient; $probe.Connect('127.0.0.1',$wirePort); $probe.Close(); $wireReady=$true; break }catch{ Start-Sleep -Milliseconds 100 } }
    Assert-Aih $wireReady '13: the loopback wire-capture provider is reachable'
    $wireSettingsTemplate=@'
engineering-profile: deepseek-codex
llm-pi-ai:
  providers:
    deepseek-vision-direct:
      displayName: DeepSeek V4 Flash Vision (direct)
      apiKeyEnv: AIH_VISUAL_TEST_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:__WIREPORT__
      reasoning: high
      models:
        - id: deepseek-v4-flash-vision-exp
          name: DeepSeek V4 Flash Vision (Exp)
'@
    ($wireSettingsTemplate -replace '__WIREPORT__',[string]$wirePort)|Set-AihFixtureSettings
    $wireManual=Invoke-AihVisual -Screenshots @($testPng) -Execute -Trigger manual
    $wireAuto=Invoke-AihVisual -Screenshots @($testPng) -Execute -Trigger automatic
    Assert-Aih ($wireManual.exitCode -eq 0 -and $wireAuto.exitCode -eq 0) '13: manual and automatic visual review complete on the SAME uncapped transport path'
    if(-not$wireProc.WaitForExit(20000)){try{$wireProc.Kill()}catch{ }}
    $capturedDoc=Get-Content $wireOut -Raw|ConvertFrom-Json
    Assert-Aih (@($capturedDoc.requests).Count -eq 2) '13: both generated provider requests were captured'
    foreach($req in @($capturedDoc.requests)){
        Assert-Aih ($null -eq $req.PSObject.Properties['max_tokens'] -and $null -eq $req.PSObject.Properties['max_completion_tokens'] -and $null -eq $req.PSObject.Properties['max_output_tokens']) '13: the generated provider request carries NO explicit output-token cap'
    }
    Assert-Aih ($capturedDoc.requests[0].model -eq 'deepseek-v4-flash-vision-exp') '13: the request targets the resolved vision model'
    Assert-Aih ($capturedDoc.requests[0].response_format.type -eq 'json_object') '13: provider-level structured output is unchanged'
    $wireManualJson=$wireManual.text|ConvertFrom-Json
    $wireIterManual=Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness/runs') $task.taskId) 'visual') ('iteration-{0:D2}'-f[int]$wireManualJson.iteration)
    $wireResultRaw=Get-Content (Join-Path $wireIterManual 'result.json') -Raw
    Assert-Aih ((($wireResultRaw|ConvertFrom-Json).transport.finishReason) -eq 'stop') '13: result.json records transport.finishReason metadata'
    Assert-Aih (-not($wireResultRaw -match 'REASONING-SENTINEL-WIRE')) '13: reasoning_content is never persisted in result.json'
    $wireRunDir=Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness/runs') $task.taskId) 'visual') ('iteration-{0:D2}'-f[int]$wireManualJson.iteration)
    Assert-Aih (-not(((Get-ChildItem $wireRunDir -Filter '*.json'|ForEach-Object{Get-Content $_.FullName -Raw})-join '') -match 'REASONING-SENTINEL-WIRE')) '13: reasoning_content is never persisted anywhere in the iteration'
    # restore the discard-endpoint settings for the remaining assertions
    @'
engineering-profile: deepseek-codex
llm-pi-ai:
  providers:
    deepseek-vision-direct:
      displayName: DeepSeek V4 Flash Vision (direct)
      apiKeyEnv: AIH_VISUAL_TEST_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:9
      reasoning: high
      models:
        - id: deepseek-v4-flash-vision-exp
          name: DeepSeek V4 Flash Vision (Exp)
'@|Set-AihFixtureSettings

    # ── 14. OUTPUT TRUNCATION FAILS CLOSED (finish_reason=length, V1.2) ──────
    $truncMock=Join-Path $mockDir 'truncated-length.json'
    @{status=200;body=@{model='deepseek-v4-flash-vision-exp';choices=@(@{message=@{content='{"verdict":"REVISE","score":7,"findings":[{"id';reasoning_content='REASONING-SENTINEL-TRUNC'};finish_reason='length'});usage=@{prompt_tokens=1600;completion_tokens=8192;completion_tokens_details=@{reasoning_tokens=7900}}}}|ConvertTo-Json -Depth 8|Set-Content -Path $truncMock -Encoding UTF8
    $trunc=Invoke-AihVisual -Screenshots @($testPng) -Execute -MockResponseFile $truncMock
    $truncJson=$trunc.text|ConvertFrom-Json
    Assert-Aih ($trunc.exitCode -eq 3 -and $truncJson.ok -eq $false -and $truncJson.errorKind -eq 'visual-review-output-truncated') '14: finish_reason=length + truncated JSON fails closed as visual-review-output-truncated'
    $truncIter=Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness/runs') $task.taskId) 'visual') ('iteration-{0:D2}'-f[int]$truncJson.iteration)
    $truncDoc=Get-Content (Join-Path $truncIter 'transport-error.json') -Raw|ConvertFrom-Json
    Assert-Aih ([int]$truncDoc.attemptCount -eq 1) '14: deterministic output truncation is never retried (single provider attempt)'
    Assert-Aih ($truncDoc.errorKind -eq 'visual-review-output-truncated' -and $truncDoc.finishReason -eq 'length') '14: the truncation diagnostic persists finishReason metadata'
    Assert-Aih ([int]$truncDoc.usage.completion_tokens -eq 8192 -and [int]$truncDoc.usage.completion_tokens_details.reasoning_tokens -eq 7900) '14: the truncation diagnostic persists safe token-count metadata only'
    Assert-Aih (-not(((Get-ChildItem $truncIter -Filter '*.json'|ForEach-Object{Get-Content $_.FullName -Raw})-join '') -match 'REASONING-SENTINEL-TRUNC')) '14: reasoning_content is never persisted in the truncation iteration'
    $truncEmptyMock=Join-Path $mockDir 'empty-length.json'
    @{status=200;body=@{model='deepseek-v4-flash-vision-exp';choices=@(@{message=@{content='';reasoning_content='REASONING-SENTINEL-EMPTY-REVIEW'};finish_reason='length'});usage=@{completion_tokens=8192;completion_tokens_details=@{reasoning_tokens=8192}}}}|ConvertTo-Json -Depth 8|Set-Content -Path $truncEmptyMock -Encoding UTF8
    $truncEmpty=Invoke-AihVisual -Screenshots @($testPng) -Execute -MockResponseFile $truncEmptyMock
    $truncEmptyJson=$truncEmpty.text|ConvertFrom-Json
    Assert-Aih ($truncEmpty.exitCode -eq 3 -and $truncEmptyJson.errorKind -eq 'visual-review-output-truncated') '14: finish_reason=length + empty content fails closed as output-truncated'
    $truncEmptyIter=Join-Path (Join-Path (Join-Path (Join-Path $workspace '.ai-harness/runs') $task.taskId) 'visual') ('iteration-{0:D2}'-f[int]$truncEmptyJson.iteration)
    $truncEmptyDoc=Get-Content (Join-Path $truncEmptyIter 'transport-error.json') -Raw|ConvertFrom-Json
    Assert-Aih ([int]$truncEmptyDoc.attemptCount -eq 1 -and $truncEmptyDoc.finishReason -eq 'length') '14: empty-at-limit truncation is deterministic (never retried)'
    # unrelated Nexus roles retain their token configuration
    Assert-Aih ((Get-AihRoutingPolicy $fixtureLayout.RoutingPolicy).codex.automaticReview.maxOutputTokens -eq 2500) '14: unrelated roles keep their token configuration (codex review budget unchanged)'

    Write-Host "RESULT: $passed visual-review assertions passed."
}finally{
    Remove-Item Env:AIH_VISUAL_TEST_KEY -ErrorAction SilentlyContinue
    if(Test-Path $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}
    if(Test-Path $workspace){Remove-Item -LiteralPath $workspace -Recurse -Force}
}
