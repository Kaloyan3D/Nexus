[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$Workspace,
 [Parameter(Mandatory=$true)][string]$TaskId,
 [string]$TaskInstanceId,
 [ValidateSet('detect','iterate','status','record-manual')][string]$Action='iterate',
 [string]$PolicyPath,
 [string]$ScenarioPath,
 [int]$MaxIterations=3,
 [string]$MockResponseFile,
 [string]$AdbPath,
 [string]$InstallRoot,
 [string]$Trigger='automatic',
 [string]$ResultPath
)
# ── Phase V2: Visual Loop Service (controller-owned automatic verification) ──
# Visual Review is an ORTHOGONAL CAPABILITY - never a new execution class,
# never the independent code reviewer, never completion authority, never human
# acceptance. This service owns the bounded automatic loop:
#   deterministic verification (already passed upstream) -> runtime capture ->
#   visual review (V1/V1.1 service) -> deterministic adjudication ->
#   controller verdict -> repair handoff OR convergence.
# Visual iteration identity is SEPARATE from the engineering attempt identity:
# attempt, executionClass and reviewerCalls are never overloaded with visual
# iteration semantics. MODEL != ROLE != EXECUTION CLASS != PROVIDER != CAPABILITY.
# The transport retry policy has exactly ONE owner: Invoke-VisualReview (V1.1).
# This service never retries the provider.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if([string]::IsNullOrWhiteSpace($InstallRoot)){$InstallRoot=Split-Path -Parent $PSScriptRoot}
$InstallRoot=[System.IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Routing.ps1')
. (Join-Path $PSScriptRoot 'TaskController.ps1')
. (Join-Path $PSScriptRoot 'Telemetry.ps1')
. (Join-Path $PSScriptRoot 'VisualRequirement.ps1')

$script:AihVisualLoopStatuses=@('pending','reviewing','revise','pass','exhausted','unavailable')
$script:AihVisualMaxCaptures=5

function Write-AihVisualLoopFailure {
    param([string]$ErrorKind,[string]$Message,[string]$TaskId,[string]$TaskInstanceId,$State=$null)
    $failure=[ordered]@{
        ok=$false; kind='visual-loop-failed'; errorKind=$ErrorKind; error=$Message
        taskId=$TaskId; taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId}
        role='visualReviewer'; capability='visual-review'; trigger='automatic'
        state=$State
        readOnly=$true; completionAuthority=$false; humanAcceptance=$false
        timestampUtc=[DateTime]::UtcNow.ToString('o')
    }
    $failure|ConvertTo-Json -Depth 20
    exit 3
}

function Get-AihVisualLoopLayout {
    param([string]$Workspace,[string]$TaskId)
    $layout=Initialize-AihTaskLedger $Workspace
    return [ordered]@{
        Workspace=$Workspace
        Runs=$layout.Runs
        VisualRoot=(Join-Path (Join-Path $layout.Runs $TaskId) 'visual')
        StatePath=(Join-Path (Join-Path (Join-Path $layout.Runs $TaskId) 'visual') 'state.json')
        DetectionPath=(Join-Path (Join-Path (Join-Path $layout.Runs $TaskId) 'visual') 'detection.json')
    }
}

function Get-AihVisualState {
    param([string]$StatePath)
    if(Test-Path -LiteralPath $StatePath){
        try{ return Get-Content -Raw -Encoding UTF8 -LiteralPath $StatePath | ConvertFrom-Json }catch { return $null }
    }
    return $null
}

function Save-AihVisualState {
    param([string]$StatePath,$State)
    $State.updatedAtUtc=[DateTime]::UtcNow.ToString('o')
    Write-AihAtomicJson -Path $StatePath -Value $State
}

function Get-AihVisualScenario {
    # Minimal extensible scenario contract (V2). Default: one viewport capture
    # of the current screen. Projects may supply .ai-harness/visual-scenarios.json
    # with either a single scenario document or a {defaultScenario, scenarios[]} set.
    param([string]$Workspace,[string]$ScenarioPath,$Policy)
    $doc=$null
    if(-not[string]::IsNullOrWhiteSpace([string]$ScenarioPath)){
        if(-not(Test-Path -LiteralPath $ScenarioPath)){ Write-AihVisualLoopFailure -ErrorKind 'visual-review-scenario-unreadable' -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Message ('Scenario file not found: '+$ScenarioPath) }
        $doc=Get-Content -Raw -Encoding UTF8 -LiteralPath $ScenarioPath | ConvertFrom-Json
    }else{
        $defaultPath=Join-Path (Join-Path $Workspace '.ai-harness') 'visual-scenarios.json'
        if(Test-Path -LiteralPath $defaultPath){ $doc=Get-Content -Raw -Encoding UTF8 -LiteralPath $defaultPath | ConvertFrom-Json }
    }
    if($null-ne$doc){
        if($null-ne$doc.PSObject.Properties['scenarios']){
            $wanted='current-screen'
            if($null-ne$doc.PSObject.Properties['defaultScenario']){ $wanted=[string]$doc.defaultScenario }
            foreach($candidate in @($doc.scenarios)){
                if($null-ne$candidate-and[string]$candidate.id-eq$wanted){ return $candidate }
            }
            Write-AihVisualLoopFailure -ErrorKind 'visual-review-scenario-unreadable' -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Message ('visual-scenarios.json does not contain the default scenario "'+$wanted+'"')
        }
        return $doc
    }
    return [pscustomobject]@{
        id='current-screen'
        platform='android'
        captures=@([pscustomobject]@{ name='current'; mode='viewport' })
    }
}

function Get-AihVisualIterationFocus {
    # Iteration 1 COMPOSITION / 2 REFINEMENT / 3 POLISH-VERIFY priorities.
    param([int]$Iteration)
    switch($Iteration){
        1 { return 'Composition pass: prioritize hierarchy, information priority, card proportions, major spacing, density, navigation, CTA prominence, and gross layout errors.' }
        2 { return 'Refinement pass: prioritize alignment, spacing rhythm, typography, component consistency, and surface discipline.' }
        default { return 'Polish/verify pass: prioritize unresolved previous findings, meaningful remaining defects, and regressions. Do not chase trivial pixel changes.' }
    }
}

function Copy-AihLoopCaptureFile {
    # Deterministic capture seam: validate + persist an existing PNG as
    # iteration evidence (used by deterministic tests and pre-captured flows).
    param([string]$SourcePath,[string]$DestinationDirectory,[string]$Name)
    if(-not(Test-Path -LiteralPath $SourcePath)){ throw ('capture source file does not exist: '+$SourcePath) }
    $bytes=[IO.File]::ReadAllBytes($SourcePath)
    if($bytes.Length-lt 8){ throw ('capture source is not a valid PNG (too small): '+$SourcePath) }
    $magic=[byte[]]($bytes[0..7])
    $expected=[byte[]](0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A)
    for($i=0;$i-lt 8;$i++){ if($magic[$i]-ne$expected[$i]){ throw ('capture source is not a PNG (bad magic): '+$SourcePath) } }
    $fileName=($Name+'-'+[IO.Path]::GetFileName($SourcePath))
    $destination=Join-Path $DestinationDirectory $fileName
    $counter=2
    while(Test-Path -LiteralPath $destination){ $destination=Join-Path $DestinationDirectory (($Name+'-'+$counter+'-'+[IO.Path]::GetFileName($SourcePath))); $counter++ }
    Copy-Item -LiteralPath $SourcePath -Destination $destination -Force
    $sha=[System.Security.Cryptography.SHA256]::Create()
    try{ $hash=([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($destination)))-replace '-','').ToLowerInvariant() }finally{ $sha.Dispose() }
    return [ordered]@{ name=$Name; storedPath=$destination; originalPath=([IO.Path]::GetFullPath($SourcePath)); bytes=$bytes.Length; sha256=$hash; mediaType='image/png'; mode='file' }
}

function Invoke-AihLoopCapture {
    param($Scenario,[string]$IterationDirectory,[string]$Workspace)
    $captures=@($Scenario.captures)
    if(@($captures).Count-eq 0){ throw 'the visual scenario defines no captures' }
    if(@($captures).Count-gt $script:AihVisualMaxCaptures){ $captures=@($captures | Select-Object -First $script:AihVisualMaxCaptures) }
    $evidence=[Collections.Generic.List[object]]::new()
    foreach($capture in $captures){
        $name=[string]$capture.name
        if([string]::IsNullOrWhiteSpace($name)){ $name='capture' }
        $mode='viewport'
        if($null-ne$capture.PSObject.Properties['mode']){ $mode=[string]$capture.mode }
        if($mode-eq'file'){
            $source=[string]$capture.sourceFile
            if([string]::IsNullOrWhiteSpace($source)){ throw ('scenario capture "'+$name+'" uses mode file without a sourceFile') }
            $evidence.Add((Copy-AihLoopCaptureFile -SourcePath $source -DestinationDirectory $IterationDirectory -Name $name))
            continue
        }
        # mode viewport (default): live ADB capture via Capture-VisualEvidence.ps1.
        $outputPath=Join-Path $IterationDirectory ($name+'.png')
        # -Force: the loop owns the iteration directory and wants a fresh capture per attempt
        $args=@('-OutputPath',$outputPath,'-Force')
        if(-not[string]::IsNullOrWhiteSpace([string]$AdbPath)){ $args+=@('-AdbPath',$AdbPath) }
        if(-not[string]::IsNullOrWhiteSpace([string]$InstallRoot)){ $args+=@('-InstallRoot',$InstallRoot) }
        $capOutFile=Join-Path $iterationDir ($name+'-capture-stdout.txt')
        $capErrFile=Join-Path $iterationDir ($name+'-capture-stderr.txt')
        $capCmd=('powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'Capture-VisualEvidence.ps1')+'" '+($args|ForEach-Object{ if($_ -match '[\s"]'){ '"'+($_ -replace '"','\"')+'"' } else { $_ } })-join ' ')+(' > "'+$capOutFile+'" 2> "'+$capErrFile+'"')
        cmd /c $capCmd
        $captureExit=$LASTEXITCODE
        # Parse the structured capture result from the stdout file; stderr
        # (adb progress lines) never participates in JSON parsing.
        $captureDoc=$null
        $capStdoutText=[string](Get-Content -LiteralPath $capOutFile -Raw -ErrorAction SilentlyContinue)
        if(-not[string]::IsNullOrWhiteSpace($capStdoutText)){
            try{ $captureDoc=$capStdoutText|ConvertFrom-Json }catch { $captureDoc=$null }
        }
        if($captureExit-ne 0){
            $reason='ADB capture failed with exit code '+$captureExit
            if($null-ne$captureDoc-and$null-ne$captureDoc.error){ $reason=[string]$captureDoc.error }
            throw $reason
        }
        if($null-eq$captureDoc-or-not[bool]$captureDoc.ok){ throw 'ADB capture did not return a valid structured result' }
        $evidence.Add([ordered]@{ name=$name; storedPath=[string]$captureDoc.outputPath; originalPath=[string]$captureDoc.outputPath; bytes=[int]$captureDoc.bytes; sha256=[string]$captureDoc.sha256; mediaType=[string]$captureDoc.mediaType; mode='viewport'; deviceSerial=[string]$captureDoc.deviceSerial })
    }
    return @($evidence)
}

function Test-AihVisualFindingAdjudication {
    # Deterministic/policy adjudication: the visual reviewer is ADVISORY.
    # Findings that conflict with frozen invariants, authoritative project
    # rules, or deterministic facts (debug tooling, invented elements,
    # semantic scope) are rejected or downgraded with a persisted reason.
    param($Result,$Policy)
    $invariants=@()
    $tooling=@()
    $downgrades=@()
    if($null-ne$Policy){
        if($null-ne$Policy.PSObject.Properties['invariants']){ $invariants=@($Policy.invariants) }
        if($null-ne$Policy.PSObject.Properties['toolingFindings']){ $tooling=@($Policy.toolingFindings) }
        if($null-ne$Policy.PSObject.Properties['downgradeFindings']){ $downgrades=@($Policy.downgradeFindings) }
    }
    $adjudicated=[Collections.Generic.List[object]]::new()
    foreach($finding in @($Result.findings)){
        $text=(($finding.observation)+' '+($finding.whyItMatters)+' '+($finding.recommendation)+' '+($finding.area)+' '+($finding.category))
        $status='accepted'; $reason='accepted: no policy conflict'; $severity=[string]$finding.severity
        foreach($invariant in $invariants){
            $pattern=[string]$invariant.pattern
            if($text-match$pattern){
                $status='rejected'
                $reason=('rejected: conflicts with frozen product invariant "'+[string]$invariant.id+'" - '+[string]$invariant.reason)
                break
            }
        }
        if($status-eq'accepted'){
            foreach($tool in $tooling){
                $toolPattern=[string]$tool.pattern
                if($text-match$toolPattern){
                    $status='rejected'
                    $reason=('rejected: deterministic evidence identifies debug/emulator tooling, not product UI - '+[string]$tool.reason)
                    break
                }
            }
        }
        if($status-eq'accepted'){
            foreach($downgrade in $downgrades){
                $downgradePattern=[string]$downgrade.pattern
                if($text-match$downgradePattern){
                    $status='partially-accepted'
                    $severity='low'
                    $reason=('partially accepted: downgraded by policy - '+[string]$downgrade.reason)
                    break
                }
            }
        }
        $adjudicated.Add([ordered]@{
            id=[string]$finding.id; severity=$severity; adjudication=$status; reason=$reason
            category=[string]$finding.category; area=[string]$finding.area
            observation=[string]$finding.observation; recommendation=[string]$finding.recommendation
        })
    }
    return @($adjudicated)
}

function Get-AihVisualControllerVerdict {
    # Controller verdict policy (default, conservative; project policy may
    # override the score threshold later):
    #   BLOCK  - reviewer verdict BLOCK or any ACCEPTED blocker finding
    #   REVISE - any accepted high finding or reviewer verdict REVISE
    #   PASS   - reviewer verdict PASS and no accepted blocker/high findings
    param($Adjudicated,[string]$ReviewerVerdict,$Policy)
    $minPassScore=6.0
    if($null-ne$Policy-and$null-ne$Policy.PSObject.Properties['minPassScore']){ $minPassScore=[double]$Policy.minPassScore }
    $accepted=@($Adjudicated | Where-Object { $_.adjudication -ne 'rejected' })
    $acceptedBlocker=@($accepted | Where-Object { $_.severity -eq 'blocker' })
    $acceptedHigh=@($accepted | Where-Object { $_.severity -eq 'high' })
    if([string]$ReviewerVerdict -eq 'BLOCK'-or@($acceptedBlocker).Count-gt 0){ return 'BLOCK' }
    if([string]$ReviewerVerdict -eq 'REVISE'-or@($acceptedHigh).Count-gt 0){ return 'REVISE' }
    if([string]$ReviewerVerdict -eq 'PASS'-and$acceptedHigh.Count-eq 0-and$acceptedBlocker.Count-eq 0){ return 'PASS' }
    return 'REVISE'
}

function Build-AihVisualRepairPacket {
    # Compact structured repair handoff for the engineering session. Never the
    # full visual-review essay; the visual reviewer NEVER edits files.
    param([int]$Iteration,[string]$ControllerVerdict,$Score,$Adjudicated)
    $accepted=@($Adjudicated | Where-Object { $_.adjudication -ne 'rejected' } | Sort-Object @{Expression={ switch($_.severity){ 'blocker'{0} 'high'{1} 'medium'{2} default{3} } }})
    $rejected=@($Adjudicated | Where-Object { $_.adjudication -eq 'rejected' })
    $lines=[Collections.Generic.List[string]]::new()
    $lines.Add(('VISUAL REVIEW - ITERATION '+$Iteration+' (verdict '+$ControllerVerdict+', score '+$Score+')'))
    foreach($finding in $accepted){
        $lines.Add('')
        $lines.Add(($finding.severity.ToUpperInvariant()))
        $lines.Add(($finding.area+':'))
        $lines.Add([string]$finding.observation)
        $lines.Add(('Action: '+[string]$finding.recommendation))
    }
    if(@($rejected).Count-gt 0){
        $lines.Add('')
        $lines.Add('IGNORED')
        foreach($finding in $rejected){ $lines.Add(([string]$finding.area+': '+[string]$finding.reason)) }
    }
    return ($lines -join [Environment]::NewLine)
}

function Register-AihVisualManualReview {
    # Manual /visual-review results are recorded as trigger=manual and never
    # advance or corrupt the automatic iteration state.
    param([string]$StatePath,[string]$TaskId,[string]$TaskInstanceId,[string]$ResultPath,[string]$Workspace)
    $state=Get-AihVisualState -StatePath $StatePath
    if($null-eq$state){ return }
    if($null-eq$state.PSObject.Properties['manualReviews']){ $state | Add-Member -NotePropertyName manualReviews -NotePropertyValue @() }
    $entry=[ordered]@{ trigger='manual'; resultPath=$ResultPath; taskId=$TaskId; atUtc=[DateTime]::UtcNow.ToString('o') }
    $state.manualReviews=@($state.manualReviews)+@($entry)
    Save-AihVisualState -StatePath $StatePath -State $state
}

# ── main ─────────────────────────────────────────────────────────────────────
$loop=Get-AihVisualLoopLayout -Workspace $Workspace -TaskId $TaskId
$effectiveInstanceId=$TaskInstanceId
if([string]::IsNullOrWhiteSpace($effectiveInstanceId)){
    try{ $taskRecord=Get-AihTask $Workspace $TaskId; $effectiveInstanceId=[string]$taskRecord.taskInstanceId }catch { $effectiveInstanceId=$null }
}

if($Action-eq'status'){
    $state=Get-AihVisualState -StatePath $loop.StatePath
    [ordered]@{ ok=$true; kind='visual-loop-status'; taskId=$TaskId; capability='visual-review'; role='visualReviewer'; state=$state }|ConvertTo-Json -Depth 20
    exit 0
}

if($Action-eq'record-manual'){
    Register-AihVisualManualReview -StatePath $loop.StatePath -TaskId $TaskId -TaskInstanceId $effectiveInstanceId -ResultPath $ResultPath -Workspace $Workspace
    [ordered]@{ ok=$true; kind='visual-loop-manual-record'; taskId=$TaskId; capability='visual-review'; role='visualReviewer'; trigger='manual' }|ConvertTo-Json -Depth 10
    exit 0
}

# detect / iterate share requirement resolution.
$Policy=$null
if(-not[string]::IsNullOrWhiteSpace([string]$PolicyPath)){
    if(-not(Test-Path -LiteralPath $PolicyPath)){ Write-AihVisualLoopFailure -ErrorKind 'visual-review-policy-unreadable' -TaskId $TaskId -TaskInstanceId $effectiveInstanceId -Message ('visual policy file not found: '+$PolicyPath) }
    $Policy=Get-Content -Raw -Encoding UTF8 -LiteralPath $PolicyPath | ConvertFrom-Json
}else{
    $Policy=Get-AihVisualPolicy -Workspace $Workspace
}

$state=Get-AihVisualState -StatePath $loop.StatePath
if($null-eq$state){
    $detection=Get-AihVisualRequirement -Workspace $Workspace -TaskId $TaskId -Policy $Policy
    Write-AihAtomicJson -Path $loop.DetectionPath -Value $detection
    $required=([string]$detection.requirement -eq 'required')
    $initialStatus='pending'
    if(-not$required){ $initialStatus='none' }
    $state=[ordered]@{
        schemaVersion=1
        kind='visual-state'
        taskId=$TaskId
        taskInstanceId=$effectiveInstanceId
        requirement=[string]$detection.requirement
        required=$required
        status=$initialStatus
        iteration=0
        maxIterations=$MaxIterations
        latestVerdict=$null
        latestScore=$null
        humanAcceptance=$false
        trigger='automatic'
        repairPending=$false
        repairBaselineAttempt=0
        lastVerificationAttempt=0
        history=@()
        manualReviews=@()
        detectionPath=$loop.DetectionPath
        reasons=@($detection.reasons)
    }
    Save-AihVisualState -StatePath $loop.StatePath -State $state
    if($Action-eq'detect'){
        [ordered]@{ ok=$true; kind='visual-loop-detection'; taskId=$TaskId; capability='visual-review'; role='visualReviewer'; requirement=[string]$detection.requirement; required=$required; reasons=@($detection.reasons); state=$state }|ConvertTo-Json -Depth 20
        exit 0
    }
}else{
    $detectionPath=$loop.DetectionPath
    if(-not(Test-Path -LiteralPath $detectionPath)){
        $detection=Get-AihVisualRequirement -Workspace $Workspace -TaskId $TaskId -Policy $Policy
        Write-AihAtomicJson -Path $detectionPath -Value $detection
    }
    if($Action-eq'detect'){
        $detection=Get-Content -Raw -Encoding UTF8 -LiteralPath $loop.DetectionPath | ConvertFrom-Json
        [ordered]@{ ok=$true; kind='visual-loop-detection'; taskId=$TaskId; capability='visual-review'; role='visualReviewer'; requirement=[string]$detection.requirement; required=[bool]$state.required; reasons=@($detection.reasons); state=$state }|ConvertTo-Json -Depth 20
        exit 0
    }
}

if(-not[bool]$state.required){
    # Not required (none/recommended): no automatic visual work, no vision call.
    [ordered]@{ ok=$true; kind='visual-loop'; taskId=$TaskId; capability='visual-review'; role='visualReviewer'; trigger='automatic'; visualWorkRequired=$false; requirement=[string]$state.requirement; state=$state; reason=('visual requirement is '+[string]$state.requirement+'; no automatic visual review') }|ConvertTo-Json -Depth 20
    exit 0
}

if($state.status-eq'pass'){
    [ordered]@{ ok=$true; kind='visual-loop'; taskId=$TaskId; capability='visual-review'; role='visualReviewer'; trigger='automatic'; visualWorkRequired=$true; iteration=[int]$state.iteration; maxIterations=[int]$state.maxIterations; state=$state; reason='visual verification already passed; awaiting external human acceptance' }|ConvertTo-Json -Depth 20
    exit 0
}
if($state.status-eq'exhausted'){
    [ordered]@{ ok=$true; kind='visual-loop'; taskId=$TaskId; capability='visual-review'; role='visualReviewer'; trigger='automatic'; visualWorkRequired=$true; iteration=[int]$state.iteration; maxIterations=[int]$state.maxIterations; state=$state; reason='visual iteration budget exhausted; operator attention required' }|ConvertTo-Json -Depth 20
    exit 0
}

# Bounded re-verification gate: after a repair handoff the loop must observe a
# FRESH deterministic verification (newer evidence attempt) before recapture.
if([bool]$state.repairPending){
    $evidencePath=Join-Path (Join-Path $loop.Runs $TaskId) 'evidence.json'
    $evidenceAttempt=0
    $evidenceVerified=$false
    if(Test-Path -LiteralPath $evidencePath){
        try{
            $evidence=Get-Content -Raw -Encoding UTF8 -LiteralPath $evidencePath | ConvertFrom-Json
            $evidenceAttempt=[int]$evidence.attempt
            $checks=@($evidence.verification)
            $evidenceVerified=(@($checks).Count-gt 0-and@($checks | Where-Object { [string]$_.status -ne 'PASS' }).Count-eq 0)
        }catch { $evidenceVerified=$false }
    }
    if(-not$evidenceVerified-or$evidenceAttempt-le [int]$state.repairBaselineAttempt){
        [ordered]@{ ok=$false; kind='visual-loop'; taskId=$TaskId; capability='visual-review'; role='visualReviewer'; trigger='automatic'; errorKind='visual-review-reverification-required'; error='A visual repair was handed off; fresh deterministic verification (newer evidence attempt) is required before the next visual review.'; state=$state }|ConvertTo-Json -Depth 20
        exit 3
    }
    $state.repairPending=$false
    $state.lastVerificationAttempt=$evidenceAttempt
}

# Convergence guard: never iteration 4.
$nextIteration=[int]$state.iteration+1
if($nextIteration-gt [int]$state.maxIterations){
    $state.status='exhausted'
    Save-AihVisualState -StatePath $loop.StatePath -State $state
    [ordered]@{ ok=$true; kind='visual-loop'; taskId=$TaskId; capability='visual-review'; role='visualReviewer'; trigger='automatic'; visualWorkRequired=$true; state=$state; reason='visual iteration budget exhausted; operator attention required' }|ConvertTo-Json -Depth 20
    exit 0
}

# status 'reviewing' is observability only; the iteration counter advances
# ONLY after a validated review (failures never burn the budget).
$state.status='reviewing'
$state.trigger='automatic'
Save-AihVisualState -StatePath $loop.StatePath -State $state

$iterationDir=Join-Path $loop.VisualRoot ('iteration-{0:D2}'-f$nextIteration)
New-Item -ItemType Directory -Path $iterationDir -Force|Out-Null

# 1. runtime capture (reuse Capture-VisualEvidence.ps1; never duplicate ADB).
try{
    $scenario=Get-AihVisualScenario -Workspace $Workspace -ScenarioPath $ScenarioPath -Policy $Policy
    $captures=@(Invoke-AihLoopCapture -Scenario $scenario -IterationDirectory $iterationDir -Workspace $Workspace)
}catch{
    $state.status='unavailable'
    Save-AihVisualState -StatePath $loop.StatePath -State $state
    Write-AihVisualLoopFailure -ErrorKind 'visual-review-capture-unavailable' -TaskId $TaskId -TaskInstanceId $effectiveInstanceId -Message ('runtime capture failed: '+$_.Exception.Message) -State $state
}
if(@($captures).Count-eq 0){
    $state.status='unavailable'
    Save-AihVisualState -StatePath $loop.StatePath -State $state
    Write-AihVisualLoopFailure -ErrorKind 'visual-review-capture-unavailable' -TaskId $TaskId -TaskInstanceId $effectiveInstanceId -Message 'the visual scenario produced no captures' -State $state
}

# 2. previous-review packing (iteration >= 2): previous screenshots + result.
$previousResultPath=$null
$previousScreens=@()
if($nextIteration-ge 2){
    foreach($entry in @($state.history)){
        if($null-eq$entry.PSObject.Properties['screenshots']){ continue }
        foreach($shot in @($entry.screenshots)){ $previousScreens+=([string]$shot.storedPath) }
    }
    foreach($entry in @($state.history)){
        if($null-ne$entry.PSObject.Properties['resultPath']){
            $candidateResultPath=[string]$entry.resultPath
            # The history stores the iteration directory; the reviewer needs the
            # structured result FILE inside it.
            if(Test-Path -LiteralPath $candidateResultPath -PathType Container){
                $candidateResultPath=Join-Path $candidateResultPath 'result.json'
            }
            $previousResultPath=$candidateResultPath
        }
    }
    if(@($previousScreens).Count-gt 4){ $previousScreens=@($previousScreens | Select-Object -Last 4) }
}

# 3. invoke the V1/V1.1 review service (single transport owner, V1.1 retry).
$reviewArgs=@(
    '-InstallRoot',$InstallRoot,'-Workspace',$Workspace,'-TaskId',$TaskId,'-Execute',
    '-Trigger','automatic','-VisualIteration',[string]$nextIteration
)
$taskRecord=$null
try{ $taskRecord=Get-AihTask $Workspace $TaskId }catch { $taskRecord=$null }
$goalText='Review the current visual state of the changed UI for this task.'
if($null-ne$taskRecord){
    # Task descriptions can be very long phase briefs; the packet question
    # budget is bounded, so the goal is summarized deterministically.
    $descriptionText=[string]$taskRecord.description
    if($descriptionText.Length-gt 700){ $descriptionText=$descriptionText.Substring(0,700) }
    $goalText=('Task goal: '+$descriptionText)
}
$focus=Get-AihVisualIterationFocus -Iteration $nextIteration
$detection=Get-Content -Raw -Encoding UTF8 -LiteralPath $loop.DetectionPath | ConvertFrom-Json
$changedVisualAreas=@($detection.signals.requiredPatternMatches)+@($detection.signals.policyRequiredMatches)
$changedText='n/a'
if(@($changedVisualAreas).Count-gt 0){ $changedText=(@($changedVisualAreas | Select-Object -First 6)-join ', ') }
$questionText=($goalText+' Changed visual areas: '+$changedText+'. '+$focus)
if(@($previousScreens).Count-gt 0){
    $questionText+=(' Compare against the previous screenshots and classify every previous finding as resolved, improved, unchanged, regressed, or not-applicable, then report meaningful new defects only.')
}
$allCapturePaths=@($captures | ForEach-Object { [string]$_.storedPath })
# The question/screenshots/references travel in a JSON payload file (never
# on the command line): free text with quotes/unicode would break cmd-level
# argument quoting and silently corrupt the redirect.
$reviewPayload=[ordered]@{
  Workspace=([IO.Path]::GetFullPath($Workspace))
  Question=$questionText
  Screenshots=@($allCapturePaths)
}
if(@($previousScreens).Count-gt 0){ $reviewPayload.References=@($previousScreens) }
if(-not[string]::IsNullOrWhiteSpace([string]$previousResultPath)){ $reviewPayload.PreviousResultPath=[string]$previousResultPath }
if(-not[string]::IsNullOrWhiteSpace([string]$TaskInstanceId)){ $reviewPayload.TaskInstanceId=[string]$TaskInstanceId }
$reviewPayloadPath=Join-Path $iterationDir 'review-payload.json'
Write-AihAtomicJson -Path $reviewPayloadPath -Value $reviewPayload
$reviewArgs+=@('-PayloadFile',$reviewPayloadPath)
if(-not[string]::IsNullOrWhiteSpace([string]$MockResponseFile)){ $reviewArgs+=@('-MockResponseFile',$MockResponseFile) }

# Redirect child streams to files: merged 2>&1 capture interleaves error-record
# wrappers with the structured JSON and breaks deterministic parsing.
$reviewOutFile=Join-Path $iterationDir 'review-stdout.txt'
$reviewErrFile=Join-Path $iterationDir 'review-stderr.txt'
$reviewCmd=('powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'VisualReview.ps1')+'" '+($reviewArgs|ForEach-Object{ if($_ -match '[\s"]'){ '"'+($_ -replace '"','\"')+'"' } else { $_ } })-join ' ')+(' > "'+$reviewOutFile+'" 2> "'+$reviewErrFile+'"')
cmd /c $reviewCmd
$reviewExit=$LASTEXITCODE
$reviewOutput=@(Get-Content -LiteralPath $reviewOutFile -ErrorAction SilentlyContinue)+@(Get-Content -LiteralPath $reviewErrFile -ErrorAction SilentlyContinue)
# Parse the structured review envelope from the stdout file only; stderr
# diagnostics never participate in JSON parsing.
$reviewDoc=$null
$reviewStdoutText=[string](Get-Content -LiteralPath $reviewOutFile -Raw -ErrorAction SilentlyContinue)
if(-not[string]::IsNullOrWhiteSpace($reviewStdoutText)){
    $reviewLines=@($reviewStdoutText -split "`r?`n")
    for($i=$reviewLines.Count-1;$i-ge 0;$i--){
        $trimmed=$reviewLines[$i].Trim()
        if($trimmed.StartsWith('{')){
            $candidateText=@($reviewLines[$i..(@($reviewLines).Count-1)])-join [Environment]::NewLine
            try{ $parsed=$candidateText|ConvertFrom-Json }catch { $parsed=$null }
            if($null-ne$parsed){ $reviewDoc=$parsed; break }
        }
    }
}
if($null-eq$reviewDoc){
    $state.status='unavailable'
    Save-AihVisualState -StatePath $loop.StatePath -State $state
    Write-AihVisualLoopFailure -ErrorKind 'visual-review-unavailable' -TaskId $TaskId -TaskInstanceId $effectiveInstanceId -Message ('visual review service returned no structured result (exit '+$reviewExit+')') -State $state
}
if([bool]$reviewDoc.ok-ne$true){
    # Provider permanent failure, malformed result, schema-invalid: the loop
    # does NOT fabricate PASS and does NOT consume the iteration.
    if([string]$reviewDoc.errorKind -eq 'visual-review-provider-error'){
        $state.status='unavailable'
    }else{
        $state.status=if([bool]$state.repairPending){'revise'}else{'pending'}
    }
    $state.iteration=$nextIteration-1
    Save-AihVisualState -StatePath $loop.StatePath -State $state
    Write-AihVisualLoopFailure -ErrorKind ([string]$reviewDoc.errorKind) -TaskId $TaskId -TaskInstanceId $effectiveInstanceId -Message ([string]$reviewDoc.error) -State $state
}
$state.iteration=$nextIteration

# 4. deterministic adjudication (visual reviewer is advisory).
$policyForAdjudication=$Policy
$adjudicated=@(Test-AihVisualFindingAdjudication -Result ([pscustomobject]@{ findings=@($reviewDoc.result.findings) }) -Policy $policyForAdjudication)
$acceptedCount=@($adjudicated | Where-Object { $_.adjudication -ne 'rejected' }).Count
$rejectedCount=@($adjudicated | Where-Object { $_.adjudication -eq 'rejected' }).Count
Write-AihAtomicJson -Path (Join-Path $iterationDir 'adjudication.json') -Value ([ordered]@{
    schemaVersion=1; kind='visual-review-adjudication'; taskId=$TaskId; taskInstanceId=$effectiveInstanceId
    iteration=$nextIteration; acceptedFindings=$acceptedCount; rejectedFindings=$rejectedCount
    findings=$adjudicated; timestampUtc=[DateTime]::UtcNow.ToString('o')
})

# 5. controller verdict policy.
$controllerVerdict=Get-AihVisualControllerVerdict -Adjudicated $adjudicated -ReviewerVerdict ([string]$reviewDoc.verdict) -Policy $policyForAdjudication

# 6. repair handoff or convergence.
$repairPacket=$null
if($controllerVerdict-eq'PASS'){
    $state.status='pass'
    $state.latestVerdict='PASS'
    $state.latestScore=[double]$reviewDoc.score
    $state.humanAcceptance=$false
}elseif($nextIteration-ge [int]$state.maxIterations){
    $state.status='exhausted'
    $state.latestVerdict=$controllerVerdict
    $state.latestScore=[double]$reviewDoc.score
    $state.humanAcceptance=$false
}else{
    $state.status='revise'
    $state.latestVerdict=$controllerVerdict
    $state.latestScore=[double]$reviewDoc.score
    $state.repairPending=$true
    $state.repairBaselineAttempt=0
    try{ $latestAttempt=Get-AihLatestAttempt $Workspace $TaskId; if($null-ne$latestAttempt){ $state.repairBaselineAttempt=[int]$latestAttempt.sequence } }catch { }
    $repairPacket=Build-AihVisualRepairPacket -Iteration $nextIteration -ControllerVerdict $controllerVerdict -Score $reviewDoc.score -Adjudicated $adjudicated
}
$historyEntry=[ordered]@{
    iteration=$nextIteration; trigger='automatic'; reviewerVerdict=[string]$reviewDoc.verdict
    controllerVerdict=$controllerVerdict; score=[double]$reviewDoc.score
    acceptedFindings=$acceptedCount; rejectedFindings=$rejectedCount
    resultPath=[string]$reviewDoc.runDirectory; screenshots=@($captures)
    atUtc=[DateTime]::UtcNow.ToString('o')
}
$state.history=@($state.history)+@($historyEntry)
Save-AihVisualState -StatePath $loop.StatePath -State $state

# 7. telemetry (real execution class preserved; capability/role orthogonal).
$telemetry=Write-AihTaskTelemetry $Workspace $TaskId @{
    model=$reviewDoc.model; provider=$reviewDoc.provider; modelCalls=1
    finalResult=$controllerVerdict
} -TaskInstanceId $effectiveInstanceId -Capability 'visual-review' -Role 'visualReviewer' -Trigger 'automatic' -VisualIteration $nextIteration -VisualVerdict $controllerVerdict -VisualScore ([double]$reviewDoc.score) -AcceptedFindings $acceptedCount -RejectedFindings $rejectedCount

[ordered]@{
    ok=$true; kind='visual-loop'; taskId=$TaskId; taskInstanceId=$effectiveInstanceId
    capability='visual-review'; role='visualReviewer'; trigger='automatic'
    iteration=$nextIteration; maxIterations=[int]$state.maxIterations
    reviewerVerdict=[string]$reviewDoc.verdict; controllerVerdict=$controllerVerdict
    score=[double]$reviewDoc.score
    acceptedFindings=$acceptedCount; rejectedFindings=$rejectedCount
    adjudicationPath=(Join-Path $iterationDir 'adjudication.json')
    resultPath=[string]$reviewDoc.runDirectory
    screenshots=@($captures)
    repairPacket=$repairPacket
    state=$state
    telemetry=$telemetry
    readOnly=$true; freshContext=$true; completionAuthority=$false; humanAcceptance=$false
}|ConvertTo-Json -Depth 20
exit 0
