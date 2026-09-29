Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

# ── Phase 2: canonical execution classes ────────────────────────────────────
# Execution classes describe SEMANTICS, not model identity:
#   deterministic | engineer_normal | engineer_deep | reviewer | solver
# Legacy names (deepseek_normal / deepseek_deep / codex_review / codex_solve)
# remain valid INPUTS so old callers and persisted records keep working; every
# write is normalized to the canonical name. Readers stay tolerant of legacy
# names in historical records (they are never rewritten).
$AihExecutionClassAliases = @{
    'deepseek_normal' = 'engineer_normal'
    'deepseek_deep'   = 'engineer_deep'
    'codex_review'    = 'reviewer'
    'codex_solve'     = 'solver'
}

function ConvertTo-AihCanonicalExecutionClass {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $key = $Value.Trim().ToLowerInvariant()
    if ($AihExecutionClassAliases.ContainsKey($key)) { return $AihExecutionClassAliases[$key] }
    return $key
}


# ── TASK-0005: immutable task lifecycle identity ────────────────────────────
# TASK DISPLAY IDENTITY != TASK LIFECYCLE IDENTITY.
#
#   taskId          ('TASK-NNNN') is the human-facing LOCAL SEQUENCE label:
#                   UI, logs, local ordering. It is NOT sufficient for durable
#                   identity: a restored workspace can regress nextSequence and
#                   re-allocate a display id that an earlier task generation
#                   already used.
#   taskInstanceId  ('task_<32 hex>') is the IMMUTABLE LIFECYCLE IDENTITY of
#                   exactly one task generation. It is generated once at task
#                   creation and NEVER reused, so two tasks may share
#                   taskId=TASK-0004 while never sharing a taskInstanceId.
#                   Every controller-owned lifecycle join (routing state,
#                   routing decisions, session bindings, attempts, evidence,
#                   review, telemetry, gates, completion) keys on it.

function New-AihTaskInstanceId {
    # UUID/GUID-based globally unique instance identity; never reused.
    return 'task_' + [guid]::NewGuid().ToString('N')
}

function Get-AihLedgerLayout {
    param([Parameter(Mandatory = $true)][string]$Workspace)
    $workspacePath = [IO.Path]::GetFullPath($Workspace)
    $root = Join-Path $workspacePath '.ai-harness'
    [pscustomobject]@{
        Workspace = $workspacePath; Root = $root; State = Join-Path $root 'state'; Runs = Join-Path $root 'runs'
        Objective = Join-Path $root 'state/objective.json'; Tasks = Join-Path $root 'state/tasks.json'
        Decisions = Join-Path $root 'state/decisions.jsonl'; Learnings = Join-Path $root 'state/learnings.jsonl'
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
    try { $document = Get-Content -Raw -Encoding UTF8 -LiteralPath $layout.Tasks | ConvertFrom-Json }
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
    param(
        [Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId,
        # TASK-0005: optional lifecycle-instance guard. When supplied, the task
        # is returned ONLY when its immutable taskInstanceId matches; any
        # mismatch fails closed instead of silently targeting another
        # generation that merely shares the display id.
        [string]$TaskInstanceId
    )
    $ledger = Read-AihTaskLedger $Workspace
    $task = @($ledger.tasks | Where-Object taskId -eq $TaskId | Select-Object -First 1)
    if ($task.Count -eq 0) { throw "Task was not found: $TaskId" }
    $found = $task[0]
    if (-not [string]::IsNullOrWhiteSpace($TaskInstanceId)) {
        $actual = $null
        if ($null -ne $found.PSObject.Properties['taskInstanceId']) { $actual = [string]$found.taskInstanceId }
        if ([string]::IsNullOrWhiteSpace($actual) -or $actual -ne $TaskInstanceId) {
            throw "Task identity mismatch: task $TaskId holds taskInstanceId '$actual' but the operation expected '$TaskInstanceId'. The display id is a label, not an identity."
        }
    }
    return $found
}

# TASK-0005 Part 5: deterministic identity lookup. NEVER throws for a missing
# task — 'exists=false' means ONLY that the authoritative ledger was
# successfully read and the task is not present. A malformed ledger, a
# permission error, a timeout or any other validation-infrastructure failure
# still THROWS, so callers can never mistake 'unable to validate' for
# 'confirmed absent'.
function Test-AihTaskIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId,
        [string]$TaskInstanceId
    )
    $ledger = Read-AihTaskLedger $Workspace
    $task = @($ledger.tasks | Where-Object taskId -eq $TaskId | Select-Object -First 1)
    if ($task.Count -eq 0) {
        return [pscustomobject]@{
            exists = $false; taskId = $TaskId; taskInstanceId = $null; boundEngine = $null
            instanceMatches = $false; expectedTaskInstanceId = $TaskInstanceId
        }
    }
    $found = $task[0]
    $actualInstanceId = $null
    if ($null -ne $found.PSObject.Properties['taskInstanceId']) { $actualInstanceId = [string]$found.taskInstanceId }
    if ([string]::IsNullOrWhiteSpace($actualInstanceId)) { $actualInstanceId = $null }
    $isMatch = $null
    if (-not [string]::IsNullOrWhiteSpace($TaskInstanceId)) { $isMatch = ($actualInstanceId -eq $TaskInstanceId) }
    return [pscustomobject]@{
        exists = $true; taskId = [string]$found.taskId; taskInstanceId = $actualInstanceId
        boundEngine = if ($null -ne $found.PSObject.Properties['boundEngine']) { [string]$found.boundEngine } else { $null }
        instanceMatches = $isMatch; expectedTaskInstanceId = $TaskInstanceId
    }
}

# Thin deterministic existence probe (same fail-closed contract). Used by
# Route.ps1 so 'task absent' is an authoritative READ, never an exception-
# string parse of a PowerShell error message.
function Test-AihTaskExists {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $identity = Test-AihTaskIdentity -Workspace $Workspace -TaskId $TaskId
    return [bool]$identity.exists
}

# ── TASK-0005 Part 3: hardened display-sequence allocation ──────────────────
# nextSequence is a HINT, not the truth. Before allocating TASK-NNNN the
# controller inspects surviving authoritative evidence (the current ledger AND
# existing .ai-harness/runs/TASK-* directories) and advances until it finds an
# unused display id, so a restored/regressed nextSequence can never collide
# with a surviving task generation. taskInstanceId remains the actual
# correctness boundary; this is defense-in-depth for display identity.
function Get-AihUsedTaskDisplayIds {
    param([Parameter(Mandatory = $true)][string]$Workspace, $Ledger)
    $layout = Get-AihLedgerLayout $Workspace
    $used = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($task in @($Ledger.tasks)) {
        $id = [string]$task.taskId
        if (-not [string]::IsNullOrWhiteSpace($id)) { [void]$used.Add($id) }
    }
    if (Test-Path -LiteralPath $layout.Runs) {
        foreach ($item in @(Get-ChildItem -LiteralPath $layout.Runs -Directory -ErrorAction SilentlyContinue)) {
            if ($item.Name -match '^TASK-[0-9]{4,}$') { [void]$used.Add($item.Name) }
        }
    }
    # NOTE: the leading comma prevents PowerShell from UNROLLING the set into
    # the pipeline — an empty HashSet would otherwise return $null.
    return ,$used
}

function Resolve-AihNextTaskId {
    param([Parameter(Mandatory = $true)][string]$Workspace, $Ledger)
    $layout = Get-AihLedgerLayout $Workspace
    $used = Get-AihUsedTaskDisplayIds $Workspace $Ledger
    $sequence = 1
    if ($null -ne $Ledger.PSObject.Properties['nextSequence']) { $sequence = [int]$Ledger.nextSequence }
    if ($sequence -lt 1) { $sequence = 1 }
    $taskId = 'TASK-{0:D4}' -f $sequence
    while ($used.Contains($taskId) -or (Test-Path -LiteralPath (Join-Path $layout.Runs $taskId))) {
        $sequence++
        $taskId = 'TASK-{0:D4}' -f $sequence
    }
    return $taskId
}

function New-AihTask {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$Description,
        [string[]]$AcceptanceCriteria = @(), [string[]]$DependsOn = @(),
        [ValidateSet('low','normal','high','critical')][string]$Risk = 'normal', [string]$BaseCommit,
        [switch]$ReviewRequested,
        [ValidateSet('dual','muse')][string]$Engine = 'dual',
        [ValidateSet('deterministic','muse_main','engineer_normal','engineer_deep','reviewer','solver','deepseek_normal','deepseek_deep','codex_review','codex_solve')][string]$ExecutionClassOverride
    )
    $layout = Initialize-AihTaskLedger $Workspace
    $mutex=[Threading.Mutex]::new($false,(Get-AihLedgerMutexName $Workspace));$taken=$false
    try{try{$taken=$mutex.WaitOne(30000)}catch [Threading.AbandonedMutexException]{$taken=$true};if(-not$taken){throw 'Timed out waiting for the task-ledger lock.'}
    $ledger = Read-AihTaskLedger $Workspace
    foreach ($dependency in $DependsOn) { if (-not @($ledger.tasks | Where-Object taskId -eq $dependency).Count) { throw "Unknown task dependency: $dependency" } }
    if ([string]::IsNullOrWhiteSpace($BaseCommit)) {
        try { $BaseCommit = (& git -C $layout.Workspace rev-parse HEAD 2>$null | Select-Object -First 1).Trim() } catch { $BaseCommit = $null }
    }
    # TASK-0005: hardened allocation. nextSequence may have regressed (a
    # workspace restored to an older Git state); surviving evidence decides.
    $taskId = Resolve-AihNextTaskId $Workspace $ledger
    $taskInstanceId = New-AihTaskInstanceId
    $initialExecutionClass = if (-not [string]::IsNullOrWhiteSpace($ExecutionClassOverride)) { ConvertTo-AihCanonicalExecutionClass $ExecutionClassOverride } else { 'engineer_normal' }
    $task = [ordered]@{
        schemaVersion = 1; taskId = $taskId; taskInstanceId = $taskInstanceId; boundEngine = $Engine; description = $Description; status = 'ready'; dependencies = @($DependsOn)
        baseCommit = $BaseCommit; executionClass = $initialExecutionClass; executor = $initialExecutionClass; attempt = 0; maxAttempts = 3
        risk = $Risk; acceptanceCriteria = @($AcceptanceCriteria); verification = [ordered]@{ required = @(); outcomes = @() }
        reviewRequested = [bool]$ReviewRequested; executionClassOverride = $ExecutionClassOverride
        worktree = $null; failureSignatures = @(); codexCalls = 0; completionAuthority = 'controller'
        createdAtUtc = [DateTime]::UtcNow.ToString('o'); updatedAtUtc = [DateTime]::UtcNow.ToString('o'); completedAtUtc = $null
    }
    $ledger.tasks = @($ledger.tasks) + @([pscustomobject]$task)
    $ledger.nextSequence = [int]($taskId -replace '^TASK-', '') + 1
    Write-AihAtomicJson $layout.Tasks $ledger
    $run = Join-Path $layout.Runs $taskId
    # TASK-0005 Part 4: never overwrite a surviving run directory — it may
    # belong to another (older) lifecycle generation of the same display id.
    # Resolve-AihNextTaskId already skips occupied display ids; this guard
    # fails closed rather than silently replacing a surviving manifest.
    if (Test-Path -LiteralPath $run) {
        if (Test-Path -LiteralPath (Join-Path $run 'manifest.json')) { throw "Run directory already holds another task generation manifest; refusing to overwrite: $run" }
    } else {
        New-Item -ItemType Directory -Force -Path $run | Out-Null
    }
    Write-AihAtomicJson (Join-Path $run 'manifest.json') $task
    # CCV2-M01 (R1.3): a task created by this controller is NATIVE from
    # inception. Its CCv2 authority record starts with every category
    # authoritative-and-empty (COMPLETE) and changes only through typed
    # controller mutations (config/ContextTaskAuthorityV2.cjs). Tasks without
    # this record are pre-M01 and bootstrap as LEGACY_BOOTSTRAP.
    $ccv2Authority = [ordered]@{
        schemaVersion = 1; origin = 'NATIVE'; taskId = $taskId; taskInstanceId = $taskInstanceId
        createdAtUtc = $task.createdAtUtc; revision = 0; constraints = @(); decisions = @()
        progress = [ordered]@{ completedMilestones = @(); currentMilestone = $null; remainingMilestones = @() }
        continuation = [ordered]@{ nextAction = $null; unresolvedQuestions = @(); recentUserIntent = $null }
        failures = [ordered]@{ activeFailures = @(); rejectedHypotheses = @() }
        verification = [ordered]@{ outcomes = @() }; mutations = @()
    }
    Write-AihAtomicJson (Join-Path $run 'ccv2-authority.json') $ccv2Authority
    Add-AihJsonLine $layout.Decisions ([ordered]@{ timestampUtc = [DateTime]::UtcNow.ToString('o'); kind = 'task-created'; taskId = $taskId; taskInstanceId = $taskInstanceId; boundEngine = $Engine; dependencies = @($DependsOn) })
    [pscustomobject]$task
    }finally{if($taken){$mutex.ReleaseMutex()};$mutex.Dispose()}
}

function Update-AihTaskRecord {
    # TASK-0005 Part 6: centralized lifecycle-instance guard. Every controller
    # mutation flows through this lookup/update path; when an expected
    # taskInstanceId is supplied it is validated HERE, so no caller needs to
    # duplicate the check and no operation can silently target another task
    # generation that merely shares the display id. Fail closed on mismatch.
    # NOTE: $TaskInstanceId stays AFTER $Update so existing positional callers
    # (Update-AihTaskRecord $ws $id { ... }) keep binding the scriptblock
    # correctly; new callers pass it by name.
    param([string]$Workspace, [string]$TaskId, [scriptblock]$Update, [string]$TaskInstanceId)
    $layout = Initialize-AihTaskLedger $Workspace
    $mutex=[Threading.Mutex]::new($false,(Get-AihLedgerMutexName $Workspace));$taken=$false
    try{try{$taken=$mutex.WaitOne(30000)}catch [Threading.AbandonedMutexException]{$taken=$true};if(-not$taken){throw 'Timed out waiting for the task-ledger lock.'}
    $ledger = Read-AihTaskLedger $Workspace
    $index = -1
    for ($i = 0; $i -lt @($ledger.tasks).Count; $i++) { if ($ledger.tasks[$i].taskId -eq $TaskId) { $index = $i; break } }
    if ($index -lt 0) { throw "Task was not found: $TaskId" }
    $task = $ledger.tasks[$index]
    if (-not [string]::IsNullOrWhiteSpace($TaskInstanceId)) {
        $actual = $null
        if ($null -ne $task.PSObject.Properties['taskInstanceId']) { $actual = [string]$task.taskInstanceId }
        if ([string]::IsNullOrWhiteSpace($actual) -or $actual -ne $TaskInstanceId) {
            throw "Task identity mismatch: task $TaskId holds taskInstanceId '$actual' but the mutation expected '$TaskInstanceId'. Fail closed."
        }
    }
    & $Update $task
    $task.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
    $ledger.tasks[$index] = $task
    Write-AihAtomicJson $layout.Tasks $ledger
    Write-AihAtomicJson (Join-Path (Join-Path $layout.Runs $TaskId) 'manifest.json') $task
    return $task
    }finally{if($taken){$mutex.ReleaseMutex()};$mutex.Dispose()}
}

# An attempt is OPEN while its latest attempts.jsonl record is one of these
# statuses; only an open attempt can be extended or closed. This is the
# authoritative guard against duplicate start events (TASK-0004).
$AihOpenAttemptStatuses = @('started', 'verifying')

function Get-AihLatestAttempt {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $layout = Get-AihLedgerLayout $Workspace
    $path = Join-Path (Join-Path $layout.Runs $TaskId) 'attempts.jsonl'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $latest = $null
    foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $path) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $record = $line | ConvertFrom-Json } catch { continue }
        if ($null -ne $record -and [string]$record.taskId -eq $TaskId) { $latest = $record }
    }
    return $latest
}

function Start-AihTaskAttempt {
    param([string]$Workspace, [string]$TaskId, [ValidateSet('deterministic','muse_main','engineer_normal','engineer_deep','reviewer','solver','deepseek_normal','deepseek_deep','codex_review','codex_solve')][string]$ExecutionClass = 'engineer_normal', [switch]$RequireNoOpenAttempt, [string]$SessionId, [string]$StartedByTurn, [string]$TaskInstanceId)
    $layout = Initialize-AihTaskLedger $Workspace
    $task = Update-AihTaskRecord $Workspace $TaskId -TaskInstanceId $TaskInstanceId {
        param($item)
        foreach ($dependency in @($item.dependencies)) { if ((Get-AihTask $Workspace $dependency).status -ne 'complete') { throw "Dependency $dependency is not complete." } }
        if ($item.status -in @('complete','cancelled')) { throw "Cannot begin an attempt for task in state '$($item.status)'." }
        if ([int]$item.attempt -ge [int]$item.maxAttempts) { throw 'Bounded retry limit has been reached.' }
        if ($RequireNoOpenAttempt) {
            $latest = Get-AihLatestAttempt $Workspace $TaskId
            if ($null -ne $latest -and [string]$latest.status -in $AihOpenAttemptStatuses) {
                throw "An attempt is already open for task $TaskId (status $($latest.status)); duplicate start is rejected."
            }
        }
        $item.attempt = [int]$item.attempt + 1; $item.status = 'implementing'; $item.executionClass = (ConvertTo-AihCanonicalExecutionClass $ExecutionClass); $item.executor = (ConvertTo-AihCanonicalExecutionClass $ExecutionClass)
    }
    $attempt = [ordered]@{ attemptId = "$TaskId-A$($task.attempt)"; taskId = $TaskId; taskInstanceId = $task.taskInstanceId; workspace = $Workspace; sequence = [int]$task.attempt; executionClass = (ConvertTo-AihCanonicalExecutionClass $ExecutionClass); status = 'started'; startedAtUtc = [DateTime]::UtcNow.ToString('o') }
    if (-not [string]::IsNullOrWhiteSpace($SessionId)) { $attempt['sessionId'] = $SessionId }
    if (-not [string]::IsNullOrWhiteSpace($StartedByTurn)) { $attempt['startedByTurn'] = $StartedByTurn }
    Add-AihJsonLine (Join-Path (Join-Path $layout.Runs $TaskId) 'attempts.jsonl') $attempt
    [pscustomobject]$attempt
}

# One bounded attempt transition (TASK-0004): verification starts (verifying),
# verification passes (passed), or the execution was interrupted. Every record
# carries the producer timestampUtc; open-attempt and transition validation
# fail closed so a stale or out-of-order event can never corrupt the timeline.
function Add-AihAttemptEvent {
    param([string]$Workspace, [string]$TaskId, [ValidateSet('verifying','passed','interrupted')][string]$Status, [string]$FailureSignature, [string]$Evidence, [string]$Reason, [string]$TaskInstanceId)
    $layout = Initialize-AihTaskLedger $Workspace
    # TASK-0005: fail closed when the expected lifecycle instance does not own
    # this task any more (the display id may have been re-allocated).
    if (-not [string]::IsNullOrWhiteSpace($TaskInstanceId)) { Get-AihTask $Workspace $TaskId -TaskInstanceId $TaskInstanceId | Out-Null }
    $latest = Get-AihLatestAttempt $Workspace $TaskId
    if ($null -eq $latest) { throw "No attempt is open for task $TaskId." }
    $sequence = [int]$latest.sequence
    if ([string]$latest.status -notin $AihOpenAttemptStatuses) { throw "Attempt $sequence of task $TaskId is already closed ($($latest.status))." }
    if ($Status -eq 'verifying' -and [string]$latest.status -ne 'started') { throw "Attempt $sequence of task $TaskId cannot re-enter verifying (status $($latest.status))." }
    if ($Status -eq 'passed' -and [string]$latest.status -ne 'verifying') { throw "Attempt $sequence of task $TaskId cannot pass without a verifying record (status $($latest.status))." }
    $attemptTask = Get-AihTask $Workspace $TaskId
    $record = [ordered]@{ attemptId = "$TaskId-A$sequence"; taskId = $TaskId; taskInstanceId = $attemptTask.taskInstanceId; workspace = $Workspace; sequence = $sequence; status = $Status; timestampUtc = [DateTime]::UtcNow.ToString('o') }
    if (-not [string]::IsNullOrWhiteSpace($FailureSignature)) { $record['failureSignature'] = $FailureSignature }
    if (-not [string]::IsNullOrWhiteSpace($Evidence)) { $record['evidence'] = $Evidence }
    if (-not [string]::IsNullOrWhiteSpace($Reason)) { $record['reason'] = $Reason }
    Add-AihJsonLine (Join-Path (Join-Path $layout.Runs $TaskId) 'attempts.jsonl') $record
    [pscustomobject]$record
}

function Add-AihTaskFailure {
    param([string]$Workspace, [string]$TaskId, [Parameter(Mandatory = $true)][string]$Signature, [string]$Evidence, [string]$TaskInstanceId)
    $layout = Initialize-AihTaskLedger $Workspace
    $latest = Get-AihLatestAttempt $Workspace $TaskId
    if ($null -eq $latest -or [string]$latest.status -notin $AihOpenAttemptStatuses) { throw "No open attempt to fail for task $TaskId." }
    $task = Update-AihTaskRecord $Workspace $TaskId -TaskInstanceId $TaskInstanceId {
        param($item)
        $item.status = 'failed'; $item.failureSignatures = @($item.failureSignatures) + @($Signature)
    }
    Add-AihJsonLine (Join-Path (Join-Path $layout.Runs $TaskId) 'attempts.jsonl') ([ordered]@{ attemptId = "$TaskId-A$($task.attempt)"; taskId = $TaskId; taskInstanceId = $task.taskInstanceId; workspace = $Workspace; sequence = [int]$task.attempt; status = 'failed'; failureSignature = $Signature; evidence = $Evidence; timestampUtc = [DateTime]::UtcNow.ToString('o') })
    return $task
}

function Set-AihTaskExecutionClass {
    param([string]$Workspace,[string]$TaskId,[ValidateSet('deterministic','muse_main','engineer_normal','engineer_deep','reviewer','solver','deepseek_normal','deepseek_deep','codex_review','codex_solve')][string]$ExecutionClass,[string]$Reason,[string]$TaskInstanceId)
    $layout=Initialize-AihTaskLedger $Workspace
    $task=Update-AihTaskRecord $Workspace $TaskId -TaskInstanceId $TaskInstanceId {param($item);$item.executionClass=(ConvertTo-AihCanonicalExecutionClass $ExecutionClass);$item.executor=(ConvertTo-AihCanonicalExecutionClass $ExecutionClass)}
    Add-AihJsonLine $layout.Decisions ([ordered]@{timestampUtc=[DateTime]::UtcNow.ToString('o');kind='execution-class-selected';taskId=$TaskId;taskInstanceId=$task.taskInstanceId;executionClass=$ExecutionClass;reason=$Reason;completionAuthority=$false})
    $task
}

function Set-AihTaskReviewRequested {
    param([string]$Workspace, [string]$TaskId, [string]$TaskInstanceId)
    $task = Update-AihTaskRecord $Workspace $TaskId -TaskInstanceId $TaskInstanceId { param($item) $item.reviewRequested = $true }
    $task
}

function Set-AihTaskEvidence {
    param([string]$Workspace, [string]$TaskId, [Parameter(Mandatory = $true)]$Evidence, [string]$TaskInstanceId)
    $layout = Initialize-AihTaskLedger $Workspace
    Write-AihAtomicJson (Join-Path (Join-Path $layout.Runs $TaskId) 'evidence.json') $Evidence
    Update-AihTaskRecord $Workspace $TaskId -TaskInstanceId $TaskInstanceId { param($item); $item.status = 'verifying'; $item.verification.outcomes = @($Evidence.verification) } | Out-Null
}

function Test-AihTaskCompletion {
    param([string]$Workspace, [string]$TaskId, [switch]$CodexReviewPassed, [switch]$CodexFindingsResolved, [string]$TaskInstanceId)
    $task = Get-AihTask $Workspace $TaskId -TaskInstanceId $TaskInstanceId
    $layout = Get-AihLedgerLayout $Workspace
    $evidencePath = Join-Path (Join-Path $layout.Runs $TaskId) 'evidence.json'
    $reasons = [Collections.Generic.List[string]]::new()
    if (-not (Test-Path -LiteralPath $evidencePath)) { $reasons.Add('Required evidence.json is missing.') }
    else {
        $evidence = Get-Content -Raw -Encoding UTF8 -LiteralPath $evidencePath | ConvertFrom-Json
        foreach ($criterion in @($task.acceptanceCriteria)) {
            if (-not @($evidence.acceptanceCriteria | Where-Object { $_.criterion -eq $criterion -and $_.status -eq 'met' -and -not [string]::IsNullOrWhiteSpace([string]$_.evidence) }).Count) { $reasons.Add("Acceptance criterion is not evidenced: $criterion") }
        }
        if (@($evidence.verification).Count -eq 0 -or @($evidence.verification | Where-Object status -ne 'PASS').Count) { $reasons.Add('Required deterministic verification did not pass.') }
        if ($null -ne $evidence.PSObject.Properties['scopePass'] -and -not [bool]$evidence.scopePass) { $reasons.Add('Scope constraints did not pass.') }
    }
    $reviewRequired = $task.risk -eq 'critical'
    if ($null -ne $task.PSObject.Properties['reviewRequested'] -and [bool]$task.reviewRequested) { $reviewRequired = $true }
    if ($null -ne $task.PSObject.Properties['executionClassOverride'] -and (ConvertTo-AihCanonicalExecutionClass ([string]$task.executionClassOverride)) -eq 'reviewer') { $reviewRequired = $true }
    if ($reviewRequired -and -not ($CodexReviewPassed -or $CodexFindingsResolved)) { $reasons.Add('This task requires a passing independent review or deterministic evidence that its findings were resolved (critical policy, explicit review request, or execution-class override).') }
    # Phase 3.2.5 requirement traceability: when the task carries a compiled
    # requirements document, required-unverified requirements block
    # completion where policy requires verification (IMPLEMENTED != VERIFIED).
    # Tasks WITHOUT a requirements document are unaffected (the gate only
    # activates when the Requirement Compiler ran for this task generation).
    $requirementsPath = Join-Path (Join-Path $layout.Runs $TaskId) 'requirements.json'
    if (Test-Path -LiteralPath $requirementsPath) {
        . (Join-Path $PSScriptRoot (Join-Path 'Engineering' 'Shared.ps1'))
        . (Join-Path $PSScriptRoot (Join-Path 'Engineering' 'Requirements.ps1'))
        foreach ($traceabilityReason in @(Test-AihRequirementsCompletionBlock -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)) { $reasons.Add([string]$traceabilityReason) }
    }
    # Phase V2: visual verification gate (orthogonal capability, never an
    # execution class). A visual-REQUIRED task must not complete merely
    # because deterministic verification passed: pending/reviewing/revise/
    # exhausted/unavailable all block completion. Only visual status 'pass'
    # satisfies the visual completion requirement, and the state must never
    # falsely claim human acceptance (human acceptance is external, V3).
    $visualStatePath = Join-Path (Join-Path (Join-Path $layout.Runs $TaskId) 'visual') 'state.json'
    if (Test-Path -LiteralPath $visualStatePath) {
        try { $visualState = Get-Content -Raw -Encoding UTF8 -LiteralPath $visualStatePath | ConvertFrom-Json } catch { $visualState = $null }
        if ($null -ne $visualState -and $visualState.PSObject.Properties['required'] -and [bool]$visualState.required) {
            $visualStatus = if ($visualState.PSObject.Properties['status']) { [string]$visualState.status } else { 'unknown' }
            if ($visualStatus -eq 'pass' -and $visualState.PSObject.Properties['humanAcceptance'] -and [bool]$visualState.humanAcceptance) {
                $reasons.Add('Visual state falsely claims human acceptance; human acceptance is external and must never be auto-recorded.')
            } elseif ($visualStatus -ne 'pass') {
                $visualIteration = if ($visualState.PSObject.Properties['iteration']) { [int]$visualState.iteration } else { 0 }
                $visualMax = if ($visualState.PSObject.Properties['maxIterations']) { [int]$visualState.maxIterations } else { 3 }
                $reasons.Add("Visual verification is required but not satisfied (status: $visualStatus, iteration: $visualIteration/$visualMax). Complete the visual loop or resolve its blocker.")
            }
        }
    }
    $complete = $reasons.Count -eq 0
    if ($complete) {
        Update-AihTaskRecord $Workspace $TaskId -TaskInstanceId $TaskInstanceId { param($item); $item.status = 'complete'; $item.completedAtUtc = [DateTime]::UtcNow.ToString('o') } | Out-Null
        $summary = "# $TaskId`n`nStatus: COMPLETE`n`nExecution class: $($task.executionClass)`n`nAttempts: $($task.attempt)`n`nReview disposition: $(if($CodexReviewPassed){'pass'}elseif($CodexFindingsResolved){'findings resolved'}else{'not required'})`n`nCompletion authority: deterministic controller`n"
        Write-AihAtomicText (Join-Path (Join-Path $layout.Runs $TaskId) 'summary.md') $summary
    }
    [pscustomobject]@{ taskId = $TaskId; status = if ($complete) { 'COMPLETE' } else { 'INCOMPLETE' }; complete = $complete; reasons = @($reasons); authority = 'deterministic-controller'; codexRequired = $reviewRequired; codexDisposition = if($CodexReviewPassed){'pass'}elseif($CodexFindingsResolved){'findings-resolved'}else{'none'} }
}

function Add-AihLearning {
    param([string]$Workspace, [string]$TaskId, [ValidateSet('test','static-rule','tool-improvement','documentation','routing-policy')][string]$Classification, [string]$Finding, [switch]$Approved, [string]$TaskInstanceId)
    $layout = Initialize-AihTaskLedger $Workspace
    $instanceId = $null
    if (-not [string]::IsNullOrWhiteSpace($TaskInstanceId)) { $instanceId = (Get-AihTask $Workspace $TaskId -TaskInstanceId $TaskInstanceId).taskInstanceId }
    else { $task = @((Read-AihTaskLedger $Workspace).tasks | Where-Object taskId -eq $TaskId | Select-Object -First 1); if ($task.Count -gt 0 -and $null -ne $task[0].PSObject.Properties['taskInstanceId']) { $instanceId = [string]$task[0].taskInstanceId } }
    $record = [ordered]@{ learningId = 'LRN-' + [guid]::NewGuid().ToString('N').Substring(0, 12); taskId = $TaskId; taskInstanceId = $instanceId; classification = $Classification; finding = $Finding; approvedForAutomation = [bool]$Approved; timestampUtc = [DateTime]::UtcNow.ToString('o') }
    Add-AihJsonLine $layout.Learnings $record
    [pscustomobject]$record
}
