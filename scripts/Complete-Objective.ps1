[CmdletBinding()]
param(
    [string]$Objective,
    [string]$AcceptanceCriteriaPath,
    [string]$Workspace = (Get-Location).Path,
    [string]$InstallRoot,
    [string]$Preset,
    [string]$DiffPath,
    [string]$WorkerReportsPath,
    [switch]$Override,
    [string]$OverrideReason,
    [string]$OverrideOperator,
    [switch]$History,
    [string]$GateId
    ,[string]$TaskId
    ,[switch]$RequireCodexReview
    ,[string]$ReviewResultPath
)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Routing.ps1')
. (Join-Path $PSScriptRoot 'Completion.ps1')
. (Join-Path $PSScriptRoot 'TaskController.ps1')
$layout = Get-AihLayout $InstallRoot
$policy = Get-AihRoutingPolicy $layout.RoutingPolicy
$resolvedPreset = Resolve-AihPreset $policy $Preset

function Get-AihBoundedText {
    param([string]$Text, [int]$MaxCharacters)
    if ([string]::IsNullOrEmpty($Text) -or $Text.Length -le $MaxCharacters) { return $Text }
    return $Text.Substring(0, $MaxCharacters) + "`n[truncated by AI Harness]"
}

function Get-AihCompletionDiff {
    param([string]$WorkspacePath, [string]$ProvidedPath)
    if (-not [string]::IsNullOrWhiteSpace($ProvidedPath)) {
        if (-not (Test-Path -LiteralPath $ProvidedPath -PathType Leaf)) { throw "Diff evidence file is missing: $ProvidedPath" }
        return Get-AihBoundedText (Get-Content -Raw -Encoding UTF8 -LiteralPath $ProvidedPath) 50000
    }
    try {
        $status = (& git -C $WorkspacePath status --short 2>$null | Out-String).TrimEnd()
        $diff = (& git -C $WorkspacePath diff --no-ext-diff HEAD -- 2>$null | Out-String).TrimEnd()
        return Get-AihBoundedText ("Git status:`n$status`n`nDiff against HEAD:`n$diff") 50000
    }
    catch { return 'No Git diff evidence was available.' }
}

if ($History) {
    if (-not [string]::IsNullOrWhiteSpace($GateId)) {
        $recordPath = Join-Path (Join-Path $layout.CompletionData 'records') "$GateId.json"
        if (-not (Test-Path -LiteralPath $recordPath)) { throw "Completion gate record was not found: $GateId" }
        Get-Content -Raw -Encoding UTF8 -LiteralPath $recordPath
        exit 0
    }
    $historyPath = Join-Path $layout.CompletionData 'history.jsonl'
    if (-not (Test-Path -LiteralPath $historyPath)) { @(); exit 0 }
    Get-Content -Encoding UTF8 -LiteralPath $historyPath | ForEach-Object { $_ | ConvertFrom-Json } | ConvertTo-Json -Depth 10
    exit 0
}

if ([string]::IsNullOrWhiteSpace($Objective)) { throw '-Objective is required.' }
if ([string]::IsNullOrWhiteSpace($AcceptanceCriteriaPath)) { throw '-AcceptanceCriteriaPath is required.' }
$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
$criteria = @(Read-AihAcceptanceCriteria $AcceptanceCriteriaPath)
$acceptance = Get-AihAcceptanceAssessment $criteria

$verifyHost = Get-AihPowerShellHost $InstallRoot
$verifyArguments = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $layout.Scripts 'Verify-Project.ps1'),'-Workspace',$workspacePath,'-InstallRoot',$InstallRoot,'-ContinueOnFailure','-Json')
if (-not [string]::IsNullOrWhiteSpace($TaskId)) { $verifyArguments += @('-TaskId',$TaskId) }
$verifyOutput = (& $verifyHost @verifyArguments 2>&1 | Out-String).Trim()
$verifyExitCode = $LASTEXITCODE
try { $verification = $verifyOutput | ConvertFrom-Json }
catch {
    $verification = [pscustomobject]@{ Workspace = $workspacePath; Kind = 'all'; Passed = 0; Failed = 1; Skipped = 0; Results = @([pscustomobject]@{ Name = 'verification-runner'; Kind = 'verify'; Status = 'FAIL'; Command = 'aih-verify'; StandardOutput = $verifyOutput; StandardError = ''; Error = "Verification output was not valid JSON; process exit code $verifyExitCode." }) }
}
$deterministic = Get-AihDeterministicAssessment $verification
$diff = Get-AihCompletionDiff $workspacePath $DiffPath
$workerReports = if ([string]::IsNullOrWhiteSpace($WorkerReportsPath)) { 'No worker reports were supplied.' } else {
    if (-not (Test-Path -LiteralPath $WorkerReportsPath -PathType Leaf)) { throw "Worker reports file is missing: $WorkerReportsPath" }
    Get-AihBoundedText (Get-Content -Raw -Encoding UTF8 -LiteralPath $WorkerReportsPath) 30000
}
$semantic = $null
if ($deterministic.Pass -and $acceptance.Pass) {
    $evidence = [ordered]@{ objective = $Objective; acceptanceCriteria = $acceptance.Criteria; deterministicVerification = $verification; relevantDiff = $diff; workerReports = $workerReports }
    if ($RequireCodexReview) {
        if ([string]::IsNullOrWhiteSpace($ReviewResultPath) -or -not (Test-Path -LiteralPath $ReviewResultPath -PathType Leaf)) {
            $semantic = [pscustomobject]@{ status = 'FAIL'; summary = 'An independent Codex review is required but no review result was supplied.'; concreteReasons = @('Required review evidence is missing.'); missingRequirements = @('review-result.json'); boundedFixes = @(); provider = 'codex-review-service'; model = 'gpt-5.6-sol'; reasoning = 'bounded' }
        }
        else {
            $review = Get-Content -Raw -Encoding UTF8 -LiteralPath $ReviewResultPath | ConvertFrom-Json
            $reviewPass = [string]$review.verdict -eq 'pass' -and -not @($review.findings | Where-Object severity -in @('blocker','high')).Count
            $semantic = [pscustomobject]@{ status = if ($reviewPass) { 'PASS' } else { 'FAIL' }; summary = 'Independent Codex review result consumed by the deterministic controller.'; concreteReasons = @($review.findings | Where-Object severity -in @('blocker','high') | ForEach-Object problem); missingRequirements = @(); boundedFixes = @(); provider = 'codex-review-service'; model = 'gpt-5.6-sol'; reasoning = 'bounded' }
        }
    }
    else {
        $semantic = [pscustomobject]@{ status = 'PASS'; summary = 'Ordinary completion is controller-owned; no model semantic gate is required.'; concreteReasons = @(); missingRequirements = @(); boundedFixes = @(); provider = 'deterministic-controller'; model = $null; reasoning = $null }
    }
}
$decision = New-AihCompletionDecision -Deterministic $deterministic -Acceptance $acceptance -Semantic $semantic -Override:$Override -OverrideReason $OverrideReason -OverrideOperator $OverrideOperator
$gateIdValue = if ([string]::IsNullOrWhiteSpace($GateId)) { 'gate-' + [guid]::NewGuid().ToString('N') } else { $GateId }
if ($gateIdValue -notmatch '^gate-[A-Za-z0-9][A-Za-z0-9._-]{0,90}$') { throw 'GateId must begin with gate- and use letters, numbers, dots, underscores, or hyphens.' }
$fixes = if ($decision.Status -eq 'FAIL') { @(Get-AihBoundedFixes $deterministic $acceptance $semantic) } else { @() }
$fixCycles = @()
$fixRoutingError = $null
if ($decision.Status -eq 'FAIL') {
    $fixCycles = @(Invoke-AihCompletionFixRouting $fixes $gateIdValue $workspacePath $layout.RoutingPolicy $layout.RoutingData $resolvedPreset.Id)
    $routingErrors = @($fixCycles | Where-Object dispatchStatus -eq 'operator-required' | ForEach-Object routingError)
    if ($routingErrors.Count) {
        $fixRoutingError = $routingErrors -join ' | '
        $decision.Reasons = @($decision.Reasons) + @('Automatic bounded-fix routing failed for one or more cycles; each affected cycle was explicitly assigned to controller-managed DeepSeek repair fallback.')
    }
}
$record = [ordered]@{
    recordVersion = 3
    gateId = $gateIdValue
    timestampUtc = [DateTime]::UtcNow.ToString('o')
    workspace = $workspacePath
    preset = $resolvedPreset.Id
    presetDisplayName = [string]$resolvedPreset.Config.displayName
    objective = $Objective
    status = $decision.Status
    complete = $decision.Complete
    gatePass = $decision.GatePass
    reasons = $decision.Reasons
    deterministicVerification = $deterministic
    acceptanceCriteria = $acceptance
    semanticVerifier = $semantic
    completionAssessment = $semantic
    codexReviewRequired = [bool]$RequireCodexReview
    codexCalls = if ($RequireCodexReview) { 1 } else { 0 }
    boundedFixCycles = $fixCycles
    fixRoutingError = $fixRoutingError
    override = $decision.Override
    authority = 'completion-gate'
}
if (-not [string]::IsNullOrWhiteSpace($TaskId)) {
    $controllerEvidence = [ordered]@{ acceptanceCriteria = @($acceptance.Criteria); verification = @($verification.Results | ForEach-Object { [ordered]@{ name=$_.Name; status=$_.Status; evidence=$_.Command } }); scopePass = $true }
    Set-AihTaskEvidence -Workspace $workspacePath -TaskId $TaskId -Evidence $controllerEvidence
    $record['controllerDecision'] = Test-AihTaskCompletion -Workspace $workspacePath -TaskId $TaskId -CodexReviewPassed:($null -ne $semantic -and $semantic.status -eq 'PASS' -and $RequireCodexReview)
}
$mutex = [Threading.Mutex]::new($false, (Get-AihRoutingMutexName $layout.CompletionData))
$taken = $false
try {
    try { $taken = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $taken = $true }
    if (-not $taken) { throw 'Timed out waiting for the completion audit-record lock.' }
    $recordPath = Write-AihCompletionRecord $record $layout.CompletionData
}
finally { if ($taken) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
$record['recordPath'] = $recordPath
$record | ConvertTo-Json -Depth 20
if ($decision.Status -eq 'FAIL') { exit 1 }
