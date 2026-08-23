Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

function Get-AihLedgerLayout {
    param([Parameter(Mandatory = $true)][string]$Workspace)
    $workspacePath = [IO.Path]::GetFullPath($Workspace)
    $root = Join-Path $workspacePath '.ai-harness'
    [pscustomobject]@{
        Workspace = $workspacePath; Root = $root; State = Join-Path $root 'state'; Runs = Join-Path $root 'runs'
        Objective = Join-Path $root 'state\objective.json'; Tasks = Join-Path $root 'state\tasks.json'
        Decisions = Join-Path $root 'state\decisions.jsonl'; Learnings = Join-Path $root 'state\learnings.jsonl'
    }
}

function Initialize-AihTaskLedger {
    param([Parameter(Mandatory = $true)][string]$Workspace)
    $layout = Get-AihLedgerLayout $Workspace
    New-Item -ItemType Directory -Force -Path $layout.State, $layout.Runs | Out-Null
    if (-not (Test-Path -LiteralPath $layout.Tasks)) {
        Write-AihAtomicJson $layout.Tasks ([ordered]@{ schemaVersion = 1; nextSequence = 1; tasks = @() })
    }
    return $layout
}

function Get-AihLedgerMutexName {
    param([string]$Workspace)
    $bytes=[Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Workspace).ToLowerInvariant());$sha=[Security.Cryptography.SHA256]::Create()
    try{$suffix=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').Substring(0,24)}finally{$sha.Dispose()}
    "AIHarnessLedger-$suffix"
}

function Read-AihTaskLedger {
    param([Parameter(Mandatory = $true)][string]$Workspace)
    $layout = Initialize-AihTaskLedger $Workspace
    try { $document = Get-Content -Raw -LiteralPath $layout.Tasks | ConvertFrom-Json }
    catch { throw "Task ledger is invalid: $($layout.Tasks)" }
    if ([int]$document.schemaVersion -ne 1) { throw 'Task ledger schemaVersion must be 1.' }
    return $document
}

function New-AihObjective {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$Description, [string[]]$AcceptanceCriteria = @())
    $layout = Initialize-AihTaskLedger $Workspace
    $objective = [ordered]@{ schemaVersion = 1; objectiveId = 'OBJ-' + [guid]::NewGuid().ToString('N').Substring(0, 12).ToUpperInvariant(); description = $Description; status = 'active'; acceptanceCriteria = @($AcceptanceCriteria); createdAtUtc = [DateTime]::UtcNow.ToString('o'); updatedAtUtc = [DateTime]::UtcNow.ToString('o') }
    Write-AihAtomicJson $layout.Objective $objective
    Add-AihJsonLine $layout.Decisions ([ordered]@{ timestampUtc = [DateTime]::UtcNow.ToString('o'); kind = 'objective-created'; objectiveId = $objective.objectiveId })
    [pscustomobject]$objective
}

function Get-AihTask {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $ledger = Read-AihTaskLedger $Workspace
    $task = @($ledger.tasks | Where-Object taskId -eq $TaskId | Select-Object -First 1)
    if ($task.Count -eq 0) { throw "Task was not found: $TaskId" }
    return $task[0]
}

function New-AihTask {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$Description,
        [string[]]$AcceptanceCriteria = @(), [string[]]$DependsOn = @(),
        [ValidateSet('low','normal','high','critical')][string]$Risk = 'normal', [string]$BaseCommit,
        [switch]$ReviewRequested,
        [ValidateSet('deterministic','deepseek_normal','deepseek_deep','codex_review','codex_solve')][string]$ExecutionClassOverride
    )
    $layout = Initialize-AihTaskLedger $Workspace
    $mutex=[Threading.Mutex]::new($false,(Get-AihLedgerMutexName $Workspace));$taken=$false
    try{try{$taken=$mutex.WaitOne(30000)}catch [Threading.AbandonedMutexException]{$taken=$true};if(-not$taken){throw 'Timed out waiting for the task-ledger lock.'}
    $ledger = Read-AihTaskLedger $Workspace
    foreach ($dependency in $DependsOn) { if (-not @($ledger.tasks | Where-Object taskId -eq $dependency).Count) { throw "Unknown task dependency: $dependency" } }
    if ([string]::IsNullOrWhiteSpace($BaseCommit)) {
        try { $BaseCommit = (& git -C $layout.Workspace rev-parse HEAD 2>$null | Select-Object -First 1).Trim() } catch { $BaseCommit = $null }
    }
    $taskId = 'TASK-{0:D4}' -f [int]$ledger.nextSequence
    $initialExecutionClass = if (-not [string]::IsNullOrWhiteSpace($ExecutionClassOverride)) { $ExecutionClassOverride } else { 'deepseek_normal' }
    $task = [ordered]@{
        schemaVersion = 1; taskId = $taskId; description = $Description; status = 'ready'; dependencies = @($DependsOn)
        baseCommit = $BaseCommit; executionClass = $initialExecutionClass; executor = $initialExecutionClass; attempt = 0; maxAttempts = 3
        risk = $Risk; acceptanceCriteria = @($AcceptanceCriteria); verification = [ordered]@{ required = @(); outcomes = @() }
        reviewRequested = [bool]$ReviewRequested; executionClassOverride = $ExecutionClassOverride
        worktree = $null; failureSignatures = @(); codexCalls = 0; completionAuthority = 'controller'
        createdAtUtc = [DateTime]::UtcNow.ToString('o'); updatedAtUtc = [DateTime]::UtcNow.ToString('o'); completedAtUtc = $null
    }
    $ledger.tasks = @($ledger.tasks) + @([pscustomobject]$task)
    $ledger.nextSequence = [int]$ledger.nextSequence + 1
    Write-AihAtomicJson $layout.Tasks $ledger
    $run = Join-Path $layout.Runs $taskId
    New-Item -ItemType Directory -Force -Path $run | Out-Null
    Write-AihAtomicJson (Join-Path $run 'manifest.json') $task
    Add-AihJsonLine $layout.Decisions ([ordered]@{ timestampUtc = [DateTime]::UtcNow.ToString('o'); kind = 'task-created'; taskId = $taskId; dependencies = @($DependsOn) })
    [pscustomobject]$task
    }finally{if($taken){$mutex.ReleaseMutex()};$mutex.Dispose()}
}

function Update-AihTaskRecord {
    param([string]$Workspace, [string]$TaskId, [scriptblock]$Update)
    $layout = Initialize-AihTaskLedger $Workspace
    $mutex=[Threading.Mutex]::new($false,(Get-AihLedgerMutexName $Workspace));$taken=$false
    try{try{$taken=$mutex.WaitOne(30000)}catch [Threading.AbandonedMutexException]{$taken=$true};if(-not$taken){throw 'Timed out waiting for the task-ledger lock.'}
    $ledger = Read-AihTaskLedger $Workspace
    $index = -1
    for ($i = 0; $i -lt @($ledger.tasks).Count; $i++) { if ($ledger.tasks[$i].taskId -eq $TaskId) { $index = $i; break } }
    if ($index -lt 0) { throw "Task was not found: $TaskId" }
    $task = $ledger.tasks[$index]
    & $Update $task
    $task.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
    $ledger.tasks[$index] = $task
    Write-AihAtomicJson $layout.Tasks $ledger
    Write-AihAtomicJson (Join-Path (Join-Path $layout.Runs $TaskId) 'manifest.json') $task
    return $task
    }finally{if($taken){$mutex.ReleaseMutex()};$mutex.Dispose()}
}

function Start-AihTaskAttempt {
    param([string]$Workspace, [string]$TaskId, [ValidateSet('deterministic','deepseek_normal','deepseek_deep','codex_review','codex_solve')][string]$ExecutionClass = 'deepseek_normal')
    $layout = Initialize-AihTaskLedger $Workspace
    $task = Update-AihTaskRecord $Workspace $TaskId {
        param($item)
        foreach ($dependency in @($item.dependencies)) { if ((Get-AihTask $Workspace $dependency).status -ne 'complete') { throw "Dependency $dependency is not complete." } }
        if ($item.status -in @('complete','cancelled')) { throw "Cannot begin an attempt for task in state '$($item.status)'." }
        if ([int]$item.attempt -ge [int]$item.maxAttempts) { throw 'Bounded retry limit has been reached.' }
        $item.attempt = [int]$item.attempt + 1; $item.status = 'implementing'; $item.executionClass = $ExecutionClass; $item.executor = $ExecutionClass
    }
    $attempt = [ordered]@{ attemptId = "$TaskId-A$($task.attempt)"; taskId = $TaskId; sequence = [int]$task.attempt; executionClass = $ExecutionClass; status = 'started'; startedAtUtc = [DateTime]::UtcNow.ToString('o') }
    Add-AihJsonLine (Join-Path (Join-Path $layout.Runs $TaskId) 'attempts.jsonl') $attempt
    [pscustomobject]$attempt
}

function Add-AihTaskFailure {
    param([string]$Workspace, [string]$TaskId, [Parameter(Mandatory = $true)][string]$Signature, [string]$Evidence)
    $layout = Initialize-AihTaskLedger $Workspace
    $task = Update-AihTaskRecord $Workspace $TaskId {
        param($item)
        $item.status = 'failed'; $item.failureSignatures = @($item.failureSignatures) + @($Signature)
    }
    Add-AihJsonLine (Join-Path (Join-Path $layout.Runs $TaskId) 'attempts.jsonl') ([ordered]@{ taskId = $TaskId; sequence = [int]$task.attempt; status = 'failed'; failureSignature = $Signature; evidence = $Evidence; timestampUtc = [DateTime]::UtcNow.ToString('o') })
    return $task
}

function Set-AihTaskExecutionClass {
    param([string]$Workspace,[string]$TaskId,[ValidateSet('deterministic','deepseek_normal','deepseek_deep','codex_review','codex_solve')][string]$ExecutionClass,[string]$Reason)
    $layout=Initialize-AihTaskLedger $Workspace
    $task=Update-AihTaskRecord $Workspace $TaskId {param($item);$item.executionClass=$ExecutionClass;$item.executor=$ExecutionClass}
    Add-AihJsonLine $layout.Decisions ([ordered]@{timestampUtc=[DateTime]::UtcNow.ToString('o');kind='execution-class-selected';taskId=$TaskId;executionClass=$ExecutionClass;reason=$Reason;completionAuthority=$false})
    $task
}

function Set-AihTaskReviewRequested {
    param([string]$Workspace, [string]$TaskId)
    $task = Update-AihTaskRecord $Workspace $TaskId { param($item) $item.reviewRequested = $true }
    $task
}

function Set-AihTaskEvidence {
    param([string]$Workspace, [string]$TaskId, [Parameter(Mandatory = $true)]$Evidence)
    $layout = Initialize-AihTaskLedger $Workspace
    Write-AihAtomicJson (Join-Path (Join-Path $layout.Runs $TaskId) 'evidence.json') $Evidence
    Update-AihTaskRecord $Workspace $TaskId { param($item); $item.status = 'verifying'; $item.verification.outcomes = @($Evidence.verification) } | Out-Null
}

function Test-AihTaskCompletion {
    param([string]$Workspace, [string]$TaskId, [switch]$CodexReviewPassed, [switch]$CodexFindingsResolved)
    $task = Get-AihTask $Workspace $TaskId
    $layout = Get-AihLedgerLayout $Workspace
    $evidencePath = Join-Path (Join-Path $layout.Runs $TaskId) 'evidence.json'
    $reasons = [Collections.Generic.List[string]]::new()
    if (-not (Test-Path -LiteralPath $evidencePath)) { $reasons.Add('Required evidence.json is missing.') }
    else {
        $evidence = Get-Content -Raw -LiteralPath $evidencePath | ConvertFrom-Json
        foreach ($criterion in @($task.acceptanceCriteria)) {
            if (-not @($evidence.acceptanceCriteria | Where-Object { $_.criterion -eq $criterion -and $_.status -eq 'met' -and -not [string]::IsNullOrWhiteSpace([string]$_.evidence) }).Count) { $reasons.Add("Acceptance criterion is not evidenced: $criterion") }
        }
        if (@($evidence.verification).Count -eq 0 -or @($evidence.verification | Where-Object status -ne 'PASS').Count) { $reasons.Add('Required deterministic verification did not pass.') }
        if ($null -ne $evidence.PSObject.Properties['scopePass'] -and -not [bool]$evidence.scopePass) { $reasons.Add('Scope constraints did not pass.') }
    }
    $reviewRequired = $task.risk -eq 'critical'
    if ($null -ne $task.PSObject.Properties['reviewRequested'] -and [bool]$task.reviewRequested) { $reviewRequired = $true }
    if ($null -ne $task.PSObject.Properties['executionClassOverride'] -and [string]$task.executionClassOverride -eq 'codex_review') { $reviewRequired = $true }
    if ($reviewRequired -and -not ($CodexReviewPassed -or $CodexFindingsResolved)) { $reasons.Add('This task requires a passing bounded Codex review or deterministic evidence that its findings were resolved (critical policy, explicit review request, or execution-class override).') }
    $complete = $reasons.Count -eq 0
    if ($complete) {
        Update-AihTaskRecord $Workspace $TaskId { param($item); $item.status = 'complete'; $item.completedAtUtc = [DateTime]::UtcNow.ToString('o') } | Out-Null
        $summary = "# $TaskId`n`nStatus: COMPLETE`n`nExecution class: $($task.executionClass)`n`nAttempts: $($task.attempt)`n`nCodex disposition: $(if($CodexReviewPassed){'pass'}elseif($CodexFindingsResolved){'findings resolved'}else{'not required'})`n`nCompletion authority: deterministic controller`n"
        Write-AihAtomicText (Join-Path (Join-Path $layout.Runs $TaskId) 'summary.md') $summary
    }
    [pscustomobject]@{ taskId = $TaskId; status = if ($complete) { 'COMPLETE' } else { 'INCOMPLETE' }; complete = $complete; reasons = @($reasons); authority = 'deterministic-controller'; codexRequired = $reviewRequired; codexDisposition = if($CodexReviewPassed){'pass'}elseif($CodexFindingsResolved){'findings-resolved'}else{'none'} }
}

function Add-AihLearning {
    param([string]$Workspace, [string]$TaskId, [ValidateSet('test','static-rule','tool-improvement','documentation','routing-policy')][string]$Classification, [string]$Finding, [switch]$Approved)
    $layout = Initialize-AihTaskLedger $Workspace
    $record = [ordered]@{ learningId = 'LRN-' + [guid]::NewGuid().ToString('N').Substring(0, 12); taskId = $TaskId; classification = $Classification; finding = $Finding; approvedForAutomation = [bool]$Approved; timestampUtc = [DateTime]::UtcNow.ToString('o') }
    Add-AihJsonLine $layout.Learnings $record
    [pscustomobject]$record
}
