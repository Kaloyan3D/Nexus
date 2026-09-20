[CmdletBinding()]param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot))
# Platform-aware child host: Windows keeps powershell.exe; POSIX uses the pinned Nexus pwsh.
if (-not (Get-Command Test-AihIsWindows -ErrorAction SilentlyContinue)) { . (Join-Path $InstallRoot 'scripts/Platform.ps1') }; $aihPsHost = Get-AihPowerShellHost -InstallRoot $InstallRoot
# Context Compaction V1 (Phase 1) deterministic PowerShell-plane regression suite.
#
# Every scenario runs the REAL controller functions against isolated temp
# workspaces (no network, no model calls). The suite never creates a second
# task lifecycle state machine: completion always flows through
# Test-AihTaskCompletion (the authoritative controller gate).
Set-StrictMode -Version Latest;$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/TaskController.ps1')
. (Join-Path $InstallRoot 'scripts/ContextLifecycle.ps1')

$passed = 0
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }
function New-CompactionFixture([string]$Name) { $path = Join-Path ([IO.Path]::GetTempPath()) ("aih-compaction-$Name-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $path | Out-Null; & git init -q $path | Out-Null; & git -C $path config user.email f8t@example.invalid | Out-Null; & git -C $path config user.name f8t | Out-Null; Set-Content -LiteralPath (Join-Path $path '.f8baseline') -Value 'baseline' | Out-Null; & git -C $path add .f8baseline | Out-Null; & git -C $path commit -qm baseline | Out-Null; $path }
function New-CompactionTask([string]$Workspace, [string]$Description = 'compaction fixture task', [string[]]$Criteria = @('criterion one'), [string]$Engine = 'dual') {
    New-AihTask -Workspace $Workspace -Description $Description -AcceptanceCriteria $Criteria -Engine $Engine
}
function Complete-CompactionTask([string]$Workspace, $Task) {
    $run = Join-Path (Join-Path $Workspace '.ai-harness/runs') $Task.taskId
    $criteriaEvidence = @()
    foreach ($criterion in @($Task.acceptanceCriteria)) {
        $criteriaEvidence += [ordered]@{ criterion = [string]$criterion; status = 'met'; evidence = 'fixture evidence for ' + [string]$criterion }
    }
    $evidence = [ordered]@{
        schemaVersion = 2; attempt = 1; taskInstanceId = [string]$Task.taskInstanceId
        acceptanceCriteria = @($criteriaEvidence)
        verification = @([ordered]@{ name = 'fixture-verify'; kind = 'verify'; status = 'PASS'; exitCode = 0; attempt = 1 })
        scopePass = $true
    }
    Write-AihAtomicJson (Join-Path $run 'evidence.json') $evidence
    $completion = Test-AihTaskCompletion -Workspace $Workspace -TaskId $Task.taskId -TaskInstanceId ([string]$Task.taskInstanceId)
    if (-not [bool]$completion.complete) { throw ("Fixture completion failed: " + ([string]::Join('; ', @($completion.reasons)))) }
    return $completion
}
function Add-CompactionUsage([string]$Workspace, $Task, [string]$EngineRole, [string]$Engine, [int]$Uncached, [int]$Cache, [string]$StepId) {
    Add-AihContextRootUsage -Workspace $Workspace -TaskId $Task.taskId -TaskInstanceId ([string]$Task.taskInstanceId) -EngineRole $EngineRole -Engine $Engine -UncachedInputTokens $Uncached -CacheReadTokens $Cache -OutputTokens 10 -UsageAvailable $true -StepId $StepId
}
# == 1. INCOMPLETE TASK plus HUGE CONTEXT stays KEEP ========================
$root = New-CompactionFixture 't1'
try {
    $task = New-CompactionTask $root
    [void](Add-CompactionUsage $root $task 'engineer_normal' 'dual' 150000 60000 '1:1')
    $elig = Test-AihContextCompactionEligibility -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    Assert-Aih ($elig.eligibilityDecision -eq 'keep') 'incomplete task with huge context is KEEP'
    Assert-Aih ($elig.eligibilityReason -like 'task-not-complete*') 'KEEP reason names the incomplete status'
    Assert-Aih ([int]$elig.peakEffectiveInputTokens -eq 210000) 'pressure signal is uncached plus cache-read'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 2. COMPLETE TASK BELOW THRESHOLD stays KEEP ==============================
$root = New-CompactionFixture 't2'
try {
    $task = New-CompactionTask $root
    [void](Complete-CompactionTask $root $task)
    [void](Add-CompactionUsage $root $task 'engineer_normal' 'dual' 40000 20000 '1:1')
    $elig = Test-AihContextCompactionEligibility -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    Assert-Aih ($elig.eligibilityDecision -eq 'keep') 'complete task below threshold is KEEP'
    Assert-Aih ($elig.eligibilityReason -like 'below-threshold*') 'KEEP reason names the threshold'
    Assert-Aih ([int]$elig.thresholdTokens -eq 120000) 'threshold authority is the single 120000 constant'
    $snapshot = Get-AihContextLifecycleSnapshot -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    Assert-Aih ($snapshot.state -eq 'inactive') 'below-threshold session lifecycle stays inactive'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 3. COMPLETE TASK ABOVE THRESHOLD is ELIGIBLE =============================
$root = New-CompactionFixture 't3'
try {
    $task = New-CompactionTask $root
    [void](Complete-CompactionTask $root $task)
    [void](Add-CompactionUsage $root $task 'engineer_normal' 'dual' 90000 40000 '1:1')
    $elig = Test-AihContextCompactionEligibility -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    Assert-Aih ($elig.eligibilityDecision -eq 'eligible') 'complete task above threshold is eligible'
    Assert-Aih ([int]$elig.latestEffectiveInputTokens -eq 130000) 'latest root call is the primary pressure signal'
    Assert-Aih ([int]$elig.rootModelCallCount -eq 1) 'root call count is recorded'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
# == 4. COMPLETION plus ELIGIBILITY REQUIRE THE MATCHING INSTANCE ===========
$root = New-CompactionFixture 't4'
try {
    $task = New-CompactionTask $root
    [void](Complete-CompactionTask $root $task)
    [void](Add-CompactionUsage $root $task 'engineer_normal' 'dual' 90000 40000 '1:1')
    $wrongInstance = 'task_' + ('0' * 32)
    if ($wrongInstance -eq [string]$task.taskInstanceId) { $wrongInstance = 'task_' + ('f' * 32) }
    $elig = Test-AihContextCompactionEligibility -Workspace $root -TaskId $task.taskId -TaskInstanceId $wrongInstance
    Assert-Aih ($elig.eligibilityDecision -eq 'keep') 'wrong taskInstanceId is KEEP, never eligible'
    Assert-Aih ($elig.eligibilityReason -like '*mismatch*' -or $elig.eligibilityReason -like 'task-identity-unproven*') 'mismatch reason is explicit'
    $threw = $false
    try { [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId $wrongInstance -To 'eligible' -Reason 'probe') } catch { $threw = $true }
    Assert-Aih $threw 'lifecycle transition with a mismatched instance throws'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 5. STALE GENERATION IS BLOCKED ===========================================
$root = New-CompactionFixture 't5'
try {
    $task = New-CompactionTask $root
    [void](Complete-CompactionTask $root $task)
    [void](Add-CompactionUsage $root $task 'muse_main' 'muse' 100000 30000 '7:1')
    $state = Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'eligible' -Reason 'fixture'
    Assert-Aih ($state.state -eq 'eligible') 'eligible transition lands'
    $checkpoint = New-AihContextCheckpoint -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -ContinuityUserText 'do it' -ContinuityAssistantText 'done report'
    Assert-Aih (Test-Path -LiteralPath $checkpoint.path) 'checkpoint file exists'
    $threw = $false
    try { [void](Read-AihContextCheckpoint -Workspace $root -TaskId $task.taskId -ExpectedTaskInstanceId ('task_' + ('9' * 32))) } catch { $threw = $true }
    Assert-Aih $threw 'stale generation checkpoint read throws (blocked)'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 6. MALFORMED CHECKPOINT BLOCKS, OLD CONTEXT RETAINED =====================
$root = New-CompactionFixture 't6'
try {
    $task = New-CompactionTask $root
    [void](Complete-CompactionTask $root $task)
    [void](Add-CompactionUsage $root $task 'engineer_normal' 'dual' 90000 40000 '1:1')
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'eligible' -Reason 'fixture')
    $paths = Get-AihContextLifecyclePaths -Workspace $root -TaskId $task.taskId
    New-Item -ItemType Directory -Force -Path $paths.Run | Out-Null
    Set-Content -Encoding UTF8 -LiteralPath $paths.Checkpoint -Value '{not valid json'
    $threw = $false
    try { [void](Read-AihContextCheckpoint -Workspace $root -TaskId $task.taskId -ExpectedTaskInstanceId ([string]$task.taskInstanceId)) } catch { $threw = $true }
    Assert-Aih $threw 'malformed checkpoint read throws'
    $threw = $false
    try { [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'checkpoint-ready' -Reason 'probe') } catch { $threw = $true }
    Assert-Aih $threw 'checkpoint-ready without a valid checkpoint throws'
    $snapshot = Get-AihContextLifecycleSnapshot -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    Assert-Aih ($snapshot.state -ne 'applied') 'failed preparation never reaches applied'
    Assert-Aih ($null -ne (Get-AihTask -Workspace $root -TaskId $task.taskId)) 'task record survives checkpoint failure'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
# == 7. CHECKPOINT PERSISTENCE IS ATOMIC =====================================
$root = New-CompactionFixture 't7'
try {
    $task = New-CompactionTask $root
    [void](Complete-CompactionTask $root $task)
    $before = @(Get-ChildItem -LiteralPath (Join-Path (Join-Path $root '.ai-harness/runs') $task.taskId) -File | Where-Object { $_.Name -like '*.tmp' })
    $checkpoint = New-AihContextCheckpoint -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    $after = @(Get-ChildItem -LiteralPath (Join-Path (Join-Path $root '.ai-harness/runs') $task.taskId) -File | Where-Object { $_.Name -like '*.tmp' })
    Assert-Aih (@($before).Count -eq 0 -and @($after).Count -eq 0) 'no temp files survive checkpoint persistence'
    $parsed = Get-Content -Raw -Encoding UTF8 -LiteralPath $checkpoint.path | ConvertFrom-Json
    Assert-Aih ([string]$parsed.taskInstanceId -eq [string]$task.taskInstanceId) 'checkpoint round-trips its lifecycle identity'
    Assert-Aih ([int]$parsed.schemaVersion -eq 1) 'checkpoint carries schema version 1'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 8/9. REPEATED ELIGIBILITY plus APPLY ARE IDEMPOTENT ======================
$root = New-CompactionFixture 't8'
try {
    $task = New-CompactionTask $root
    [void](Complete-CompactionTask $root $task)
    [void](Add-CompactionUsage $root $task 'engineer_normal' 'dual' 90000 40000 '1:1')
    $first = Test-AihContextCompactionEligibility -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    $second = Test-AihContextCompactionEligibility -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    Assert-Aih (($first.eligibilityDecision -eq 'eligible') -and ($second.eligibilityDecision -eq 'eligible')) 'repeated eligibility evaluates identically'
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'eligible' -Reason 'fixture')
    $again = Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'eligible' -Reason 'replay'
    Assert-Aih ($again.state -eq 'eligible') 'repeated eligible transition is idempotent'
    [void](New-AihContextCheckpoint -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId))
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'checkpoint-ready' -Reason 'fixture')
    $legacyApply = $false
    try { [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'applied' -Reason 'legacy direct probe') } catch { $legacyApply = $true }
    Assert-Aih $legacyApply 'legacy checkpoint-ready without a frozen operation cannot jump to applied'
    $operation = New-AihContextCompactionOperation -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId 'sess-8' -ReplacementStart 0 -ReplacementEnd 2 -SourceEventSeqs @(0, 1, 2) -CheckpointPath 'checkpoint.json' -Segments @([ordered]@{ start = 0; end = 2; sourceEventSeqs = @(0, 1, 2) }) -CompletionBoundarySeq 9
    Assert-Aih (-not [string]::IsNullOrWhiteSpace([string]$operation.operationId)) 'frozen operation carries a stable operationId'
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'apply-pending' -Reason 'fixture' -SessionId 'sess-8')
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'awaiting-durability' -Reason 'fixture' -SessionId 'sess-8')
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'applied' -Reason 'fixture' -SessionId 'sess-8')
    $reapplied = Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'applied' -Reason 'replay' -SessionId 'sess-8'
    Assert-Aih ($reapplied.state -eq 'applied') 'repeated apply is idempotent'
    $illegal = $false
    try { [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'eligible' -Reason 'rollback probe') } catch { $illegal = $true }
    Assert-Aih $illegal 'applied never rolls back to eligible'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 10. CRASH BEFORE APPLICATION LEAVES OLD CONTEXT USABLE ===================
$root = New-CompactionFixture 't10'
try {
    $task = New-CompactionTask $root
    [void](Complete-CompactionTask $root $task)
    [void](Add-CompactionUsage $root $task 'engineer_normal' 'dual' 90000 40000 '1:1')
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'eligible' -Reason 'fixture (crash follows)')
    $snapshot = Get-AihContextLifecycleSnapshot -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    Assert-Aih ($snapshot.state -eq 'eligible') 'crash point rests at eligible, not applied'
    $paths = Get-AihContextLifecyclePaths -Workspace $root -TaskId $task.taskId
    Assert-Aih (-not (Test-Path -LiteralPath $paths.Checkpoint)) 'no checkpoint exists before preparation'
    $reloaded = Get-AihContextLifecycleSnapshot -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    Assert-Aih ($reloaded.state -eq 'eligible') 'reload after crash is deterministic'
    $taskAfter = Get-AihTask -Workspace $root -TaskId $task.taskId
    Assert-Aih ([string]$taskAfter.status -eq 'complete') 'task completion survives the crash point'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
# == 11/12. ROOT MUSE plus DUAL USAGE ARE COUNTED ============================
$root = New-CompactionFixture 't11'
try {
    $task = New-CompactionTask $root -Engine 'muse'
    $pressure = Add-CompactionUsage $root $task 'muse_main' 'muse' 100000 30000 '3:1'
    Assert-Aih ([int]$pressure.callsByEngine.muse -eq 1) 'muse root call counted under muse'
    Assert-Aih ([int]$pressure.callsByRole.muse_main -eq 1) 'muse_main role counted'
    Assert-Aih ([int]$pressure.latestEffectiveInputTokens -eq 130000) 'muse effective input is uncached plus cache-read'
    $taskDual = New-CompactionTask $root -Description 'dual counter fixture'
    $pressureDual = Add-CompactionUsage $root $taskDual 'engineer_normal' 'dual' 50000 10000 '1:1'
    $pressureDual = Add-AihContextRootUsage -Workspace $root -TaskId $taskDual.taskId -TaskInstanceId ([string]$taskDual.taskInstanceId) -EngineRole 'engineer_deep' -Engine 'dual' -UncachedInputTokens 20000 -CacheReadTokens 5000 -OutputTokens 5 -UsageAvailable $true -StepId '1:2'
    Assert-Aih ([int]$pressureDual.callsByEngine.dual -eq 2) 'dual normal plus deep calls counted under dual'
    Assert-Aih ([int]$pressureDual.callsByRole.engineer_normal -eq 1) 'engineer_normal role counted'
    Assert-Aih ([int]$pressureDual.callsByRole.engineer_deep -eq 1) 'engineer_deep role counted'
    Assert-Aih ([int]$pressureDual.peakEffectiveInputTokens -eq 60000) 'peak tracks the largest root call'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 13/14. REVIEWER plus UNKNOWN ROLES NEVER ENTER ROOT METRICS =============
$root = New-CompactionFixture 't13'
try {
    $task = New-CompactionTask $root
    $rejected = $false
    try { [void](Add-AihContextRootUsage -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -EngineRole 'reviewer' -Engine 'dual' -UncachedInputTokens 999999 -CacheReadTokens 0 -OutputTokens 0 -UsageAvailable $true -StepId '1:9') } catch { $rejected = $true }
    Assert-Aih $rejected 'reviewer role is rejected at the recorder boundary'
    $rejectedVisual = $false
    try { [void](Add-AihContextRootUsage -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -EngineRole 'visual' -Engine 'dual' -UncachedInputTokens 999999 -CacheReadTokens 0 -OutputTokens 0 -UsageAvailable $true -StepId '1:10') } catch { $rejectedVisual = $true }
    Assert-Aih $rejectedVisual 'unknown (visual-style) role is rejected'
    $pressure = Read-AihContextPressure -Workspace $root -TaskId $task.taskId
    $calls = 0
    if ($null -ne $pressure) { $calls = [int]$pressure.rootModelCallCount }
    Assert-Aih ($calls -eq 0) 'rejected roles leave zero root calls'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 15. REPLAYED STEP IDS DO NOT DOUBLE-COUNT ================================
$root = New-CompactionFixture 't15'
try {
    $task = New-CompactionTask $root
    [void](Add-CompactionUsage $root $task 'engineer_normal' 'dual' 50000 10000 '1:1')
    $replay = Add-CompactionUsage $root $task 'engineer_normal' 'dual' 50000 10000 '1:1'
    Assert-Aih ([int]$replay.rootModelCallCount -eq 1) 'replayed step id is idempotent'
    $second = Add-CompactionUsage $root $task 'engineer_normal' 'dual' 10000 5000 '1:2'
    Assert-Aih ([int]$second.rootModelCallCount -eq 2) 'distinct steps count distinctly'
    Assert-Aih ([int]$second.cumulativeUncachedInputTokens -eq 60000) 'cumulative uncached aggregates'
    Assert-Aih ([int]$second.cumulativeCacheReadTokens -eq 15000) 'cumulative cache-read aggregates'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
# == 19/20. CHECKPOINT PRESERVES RECORDS, NEVER ROUTES ======================
$root = New-CompactionFixture 't19'
try {
    $task = New-CompactionTask $root
    [void](Complete-CompactionTask $root $task)
    $manifestBefore = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path (Join-Path (Join-Path $root '.ai-harness/runs') $task.taskId) 'manifest.json')
    $checkpoint = New-AihContextCheckpoint -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -ContinuityUserText 'ship it' -ContinuityAssistantText 'shipped report'
    $manifestAfter = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path (Join-Path (Join-Path $root '.ai-harness/runs') $task.taskId) 'manifest.json')
    Assert-Aih ($manifestBefore -eq $manifestAfter) 'checkpoint build never rewrites the task manifest'
    $parsed = Get-Content -Raw -Encoding UTF8 -LiteralPath $checkpoint.path | ConvertFrom-Json
    Assert-Aih ([string]$parsed.routingProvenance.note -like '*MUST NOT override*') 'checkpoint disclaims routing authority'
    Assert-Aih ([string]$parsed.executionClass -eq [string]$task.executionClass) 'checkpoint records (never overrides) the execution class'
    Assert-Aih (($null -eq $parsed.routingProvenance.PSObject.Properties['provider']) -and ($null -eq $parsed.routingProvenance.PSObject.Properties['model'])) 'checkpoint carries no model target override'
    $text = Get-AihContextCheckpointText -Checkpoint $parsed
    Assert-Aih ($text -like '*<nexus-context-checkpoint*') 'checkpoint text is framed'
    Assert-Aih ($text -like '*authority: deterministic-controller*') 'checkpoint text names controller authority'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 21. SECRET-LIKE FIXTURES ARE REDACTED ====================================
$root = New-CompactionFixture 't21'
try {
    $secret = 'sk-abcdefghijklmnopqrstuvwx'
    $task = New-CompactionTask $root -Description ('wire the key ' + $secret + ' password=supersecretvalue123')
    [void](Complete-CompactionTask $root $task)
    $checkpoint = New-AihContextCheckpoint -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -ContinuityAssistantText ('used token=abcdef1234567890 done')
    $raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $checkpoint.path
    Assert-Aih (-not $raw.Contains($secret)) 'api-key-shaped secret never lands in the checkpoint'
    Assert-Aih (-not $raw.Contains('supersecretvalue123')) 'password-shaped secret never lands in the checkpoint'
    Assert-Aih ($raw.Contains('<redacted>')) 'redaction marker survives'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 22/23. PATH BEHAVIOR: LINUX plus PLATFORM-NEUTRAL SERIALIZATION ==========
$root = New-CompactionFixture 't22'
try {
    $task = New-CompactionTask $root
    [void](Complete-CompactionTask $root $task)
    $checkpoint = New-AihContextCheckpoint -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    $parsed = Get-Content -Raw -Encoding UTF8 -LiteralPath $checkpoint.path | ConvertFrom-Json
    Assert-Aih (([string]$parsed.workspace.executionRoot).Contains('\') -eq $false) 'linux workspace serializes without backslashes'
    $windowsStyle = 'C:\Nexus\workspace'
    $windowsPaths = Get-AihContextLifecyclePaths -Workspace $windowsStyle -TaskId 'TASK-0004'
    Assert-Aih ([string]$windowsPaths.Checkpoint -like '*context-checkpoint.json') 'lifecycle layout resolves for windows-style roots'
    $roundTrip = @{ workspace = $windowsStyle; taskId = 'TASK-0004' } | ConvertTo-Json -Depth 4 | ConvertFrom-Json
    Assert-Aih ([string]$roundTrip.workspace -eq $windowsStyle) 'windows-style paths round-trip byte-identically through JSON'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
# == 24. RESTART FROM CHECKPOINT-READY IS DETERMINISTIC ======================
$root = New-CompactionFixture 't24'
try {
    $task = New-CompactionTask $root
    [void](Complete-CompactionTask $root $task)
    [void](Add-CompactionUsage $root $task 'engineer_normal' 'dual' 90000 40000 '1:1')
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'eligible' -Reason 'fixture')
    [void](New-AihContextCheckpoint -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId))
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'checkpoint-ready' -Reason 'fixture')
    $first = Get-AihContextLifecycleSnapshot -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    $second = Get-AihContextLifecycleSnapshot -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    Assert-Aih (($first.state -eq 'checkpoint-ready') -and ($second.state -eq 'checkpoint-ready')) 'checkpoint-ready survives reload'
    Assert-Aih ([string]$first.lifecycle.taskInstanceId -eq [string]$task.taskInstanceId) 'reloaded state keeps the lifecycle identity'
    $ready = Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'checkpoint-ready' -Reason 'replay after restart'
    Assert-Aih ($ready.state -eq 'checkpoint-ready') 'checkpoint-ready replay is idempotent'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 25. POST-COMPACTION TELEMETRY CORRELATES TO THE GENERATION ===============
$root = New-CompactionFixture 't25'
try {
    $task = New-CompactionTask $root
    [void](Complete-CompactionTask $root $task)
    [void](Add-CompactionUsage $root $task 'muse_main' 'muse' 100000 50000 '5:1')
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'eligible' -Reason 'fixture')
    $checkpoint = New-AihContextCheckpoint -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'checkpoint-ready' -Reason 'fixture')
    $elig = Test-AihContextCompactionEligibility -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    [void](Write-AihContextCompactionTelemetry -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -Eligibility $elig -SessionId 'sess-25' -CheckpointPath ([string]$checkpoint.path) -CheckpointSizeBytes $checkpoint.sizeBytes)
    [void](New-AihContextCompactionOperation -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId 'sess-25' -ReplacementStart 0 -ReplacementEnd 2 -SourceEventSeqs @(0, 1, 2) -CheckpointPath ([string]$checkpoint.path) -Segments @([ordered]@{ start = 0; end = 2; sourceEventSeqs = @(0, 1, 2) }) -CompletionBoundarySeq 9)
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'apply-pending' -Reason 'fixture' -SessionId 'sess-25')
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'awaiting-durability' -Reason 'fixture' -SessionId 'sess-25')
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'applied' -Reason 'fixture' -SessionId 'sess-25')
    [void](Set-AihContextCompactionApplied -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -AppliedAtUtc ([DateTime]::UtcNow.ToString('o')) -SessionId 'sess-25' -AppliedAfterStepId '5:1')
    $post = Add-AihContextPostCompactionUsage -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -PostCompactionEffectiveInputTokens 60000 -SessionId 'sess-25' -PostCompactionStepId '5:2'
    Assert-Aih ([int]$post.postCompactionEffectiveInputTokens -eq 60000) 'post-compaction input recorded'
    Assert-Aih ([int]$post.firstCallTokenReduction -eq 90000) 'token reduction is pre minus post (150000 - 60000)'
    Assert-Aih ([string]$post.taskInstanceId -eq [string]$task.taskInstanceId) 'post-compaction telemetry keys on the compacted generation'
    $replay = Add-AihContextPostCompactionUsage -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -PostCompactionEffectiveInputTokens 60000 -SessionId 'sess-25' -PostCompactionStepId '5:2'
    Assert-Aih ([int]$replay.firstCallTokenReduction -eq 90000) 'post-compaction replay is idempotent'
    $wrongThrown = $false
    try { [void](Add-AihContextPostCompactionUsage -Workspace $root -TaskId $task.taskId -TaskInstanceId ('task_' + ('8' * 32)) -PostCompactionEffectiveInputTokens 10 -SessionId 'sess-x') } catch { $wrongThrown = $true }
    Assert-Aih $wrongThrown 'post-compaction telemetry for another generation throws'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 26. FROZEN OPERATION IDENTITY plus RECONCILIATION =========================
$root = New-CompactionFixture 't26'
try {
    $task = New-CompactionTask $root
    [void](Complete-CompactionTask $root $task)
    [void](Add-CompactionUsage $root $task 'muse_main' 'muse' 100000 50000 '5:1')
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'eligible' -Reason 'fixture')
    [void](New-AihContextCheckpoint -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId))
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'checkpoint-ready' -Reason 'fixture')
    $segs26 = @([ordered]@{ start = 0; end = 4; sourceEventSeqs = @(0, 1, 2, 3, 4) })
    $first = New-AihContextCompactionOperation -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId 'sess-26' -ReplacementStart 0 -ReplacementEnd 4 -SourceEventSeqs @(0, 1, 2, 3, 4) -CheckpointPath 'cp.json' -Segments $segs26 -CompletionBoundarySeq 9
    $retry = New-AihContextCompactionOperation -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId 'sess-26' -ReplacementStart 0 -ReplacementEnd 99 -SourceEventSeqs @(0, 1, 2, 3, 4, 5, 6) -CheckpointPath 'cp.json' -Segments $segs26 -CompletionBoundarySeq 9
    Assert-Aih ([string]$retry.operationId -eq [string]$first.operationId) 'freeze retry returns the same operationId'
    Assert-Aih ([int]$retry.replacementEnd -eq 4) 'freeze retry never widens the boundary'
    Assert-Aih ([string]$retry.taskInstanceId -eq [string]$task.taskInstanceId) 'frozen operation owns the completed generation'
    $otherSession = $false
    try { [void](New-AihContextCompactionOperation -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId 'sess-other' -ReplacementStart 0 -ReplacementEnd 4 -SourceEventSeqs @(0, 1, 2, 3, 4) -Segments $segs26 -CompletionBoundarySeq 9) } catch { $otherSession = $true }
    Assert-Aih $otherSession 'a second session cannot adopt the generation operation'
    $reconciledMemoryOnly = Test-AihContextOperationReconcile -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -LiveSurfaceSeqs @(5, 6, 7, 8) -LandedReplacementSeq 8 -SessionId 'sess-26'
    Assert-Aih ([string]$reconciledMemoryOnly.decision -eq 'await-durability') 'memory-only landing stays awaiting-durability (never applied)'
    $reconciled = Test-AihContextOperationReconcile -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -LiveSurfaceSeqs @(5, 6, 7, 8) -LandedReplacementSeq 8 -SessionId 'sess-26' -DurablyVerified $true
    Assert-Aih ([string]$reconciled.decision -eq 'reconcile-applied') 'durably verified landing reconciles to applied'
    $retrySame = Test-AihContextOperationReconcile -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -LiveSurfaceSeqs @(0, 1, 2, 3, 4, 9, 10) -LandedReplacementSeq -1 -SessionId 'sess-26'
    Assert-Aih ([string]$retrySame.decision -eq 'retry-same') 'intact frozen range retries the same operation'
    Assert-Aih ([int]$retrySame.replacementEnd -eq 4) 'retry carries the frozen end, never the live tail'
    $blocked = Test-AihContextOperationReconcile -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -LiveSurfaceSeqs @(1, 2, 3, 4, 9, 10) -LandedReplacementSeq -1 -SessionId 'sess-26'
    Assert-Aih ([string]$blocked.decision -eq 'block') 'missing frozen source seq blocks instead of widening'
    $wrongGen = Test-AihContextOperationReconcile -Workspace $root -TaskId $task.taskId -TaskInstanceId ('task_' + ('7' * 32)) -LiveSurfaceSeqs @(0, 1) -LandedReplacementSeq -1
    Assert-Aih ([string]$wrongGen.decision -eq 'block') 'another generation never reconciles this operation'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 27. TAMPER MATRIX: every invalid operation is refused ====================
$root = New-CompactionFixture 't27'
try {
    $task = New-CompactionTask $root
    [void](Complete-CompactionTask $root $task)
    [void](Add-CompactionUsage $root $task 'muse_main' 'muse' 100000 50000 '5:1')
    $instance = [string]$task.taskInstanceId
    $goodSegments = @([ordered]@{ start = 0; end = 1; sourceEventSeqs = @(0, 1) }, [ordered]@{ start = 3; end = 4; sourceEventSeqs = @(3, 4) })
    $tamperCounter = 0
    function New-TamperOperation([hashtable]$Override = @{}) {
        # Fresh sessionId per case: identical operationIds return the frozen
        # record idempotently WITHOUT revalidating the candidate range, so
        # tamper validation only runs for genuinely new operations.
        $script:tamperCounter++
        $params = @{ Workspace = $root; TaskId = $task.taskId; TaskInstanceId = $instance; SessionId = ('sess-t27-' + $script:tamperCounter); ReplacementStart = 0; ReplacementEnd = 4; SourceEventSeqs = @(0, 1, 3, 4); CheckpointPath = 'cp.json'; Segments = $goodSegments; CompletionBoundarySeq = 9 }
        foreach ($key in @($Override.Keys)) { $params[$key] = $Override[$key] }
        New-AihContextCompactionOperation @params
    }
    $valid = New-TamperOperation
    Assert-Aih (-not [string]::IsNullOrWhiteSpace([string]$valid.operationId)) 'valid operation persists'
    foreach ($case in @(
        @{ Name = 'duplicate sourceEventSeqs'; Override = @{ SourceEventSeqs = @(0, 1, 1, 4); Segments = @([ordered]@{ start = 0; end = 1; sourceEventSeqs = @(0, 1) }, [ordered]@{ start = 1; end = 4; sourceEventSeqs = @(1, 4) }) } },
        @{ Name = 'seq beyond completion boundary'; Override = @{ SourceEventSeqs = @(0, 1, 3, 12); Segments = @([ordered]@{ start = 0; end = 1; sourceEventSeqs = @(0, 1) }, [ordered]@{ start = 3; end = 12; sourceEventSeqs = @(3, 12) }) } },
        @{ Name = 'segment union mismatch'; Override = @{ Segments = @([ordered]@{ start = 0; end = 1; sourceEventSeqs = @(0, 1) }, [ordered]@{ start = 3; end = 3; sourceEventSeqs = @(3) }) } },
        @{ Name = 'segment endpoint mismatch'; Override = @{ Segments = @([ordered]@{ start = 0; end = 2; sourceEventSeqs = @(0, 1) }, [ordered]@{ start = 3; end = 4; sourceEventSeqs = @(3, 4) }) } },
        @{ Name = 'missing segments'; Override = @{ Segments = @() } }
    )) {
        $threw = $false
        try { [void](New-TamperOperation $case.Override) } catch { $threw = $true }
        Assert-Aih $threw ('tamper refused: ' + $case.Name)
    }
    $corruptPaths = Get-AihContextLifecyclePaths -Workspace $root -TaskId $task.taskId
    Set-Content -Encoding UTF8 -LiteralPath $corruptPaths.Operation -Value '{corrupt json'
    $threwCorrupt = $false
    try { [void](Read-AihContextCompactionOperation -Workspace $root -TaskId $task.taskId) } catch { $threwCorrupt = $true }
    Assert-Aih $threwCorrupt 'tamper refused: corrupted operation JSON'
    $rec = Test-AihContextOperationReconcile -Workspace $root -TaskId $task.taskId -TaskInstanceId $instance -LiveSurfaceSeqs @(0, 1, 2) -LandedReplacementSeq -1 -SessionId 'sess-t27'
    Assert-Aih ([string]$rec.decision -eq 'block') 'corrupted operation reconciles to block'
    $wrongSession = Test-AihContextOperationReconcile -Workspace $root -TaskId $task.taskId -TaskInstanceId $instance -LiveSurfaceSeqs @(0, 1, 2) -LandedReplacementSeq -1 -SessionId 'sess-other'
    Assert-Aih ([string]$wrongSession.decision -eq 'block') 'wrong sessionId reconciles to block'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 27b. OWNER TOKEN: renew/release fenced by unguessable ownerId =========
$root = New-CompactionFixture 't27b'
try {
    $task = New-CompactionTask $root
    $instance = [string]$task.taskInstanceId
    $a = Invoke-AihCompactionApplyLockAcquire -Workspace $root -TaskId $task.taskId -TaskInstanceId $instance -SessionId 'sess-tok' -OperationId 'ccop_tok' -LeaseSeconds 60
    Assert-Aih ([bool]$a.acquired) 'owner A acquires'
    $stranger = Invoke-AihCompactionApplyLockRenew -Workspace $root -TaskId $task.taskId -TaskInstanceId $instance -SessionId 'sess-tok' -OperationId 'ccop_tok' -OwnerId 'not-the-owner' -LeaseSeconds 60
    Assert-Aih (-not [bool]$stranger.renewed) 'non-owner cannot renew'
    $mine = Invoke-AihCompactionApplyLockRenew -Workspace $root -TaskId $task.taskId -TaskInstanceId $instance -SessionId 'sess-tok' -OperationId 'ccop_tok' -OwnerId ([string]$a.ownerId) -LeaseSeconds 60
    Assert-Aih ([bool]$mine.renewed) 'owner can renew'
    $lockBefore = Get-Content -Raw -Encoding UTF8 -LiteralPath (Get-AihCompactionApplyLockPath -Workspace $root -TaskId $task.taskId) | ConvertFrom-Json
    Start-Sleep -Milliseconds 1100
    $mine2 = Invoke-AihCompactionApplyLockRenew -Workspace $root -TaskId $task.taskId -TaskInstanceId $instance -SessionId 'sess-tok' -OperationId 'ccop_tok' -OwnerId ([string]$a.ownerId) -LeaseSeconds 60
    $lockAfter = Get-Content -Raw -Encoding UTF8 -LiteralPath (Get-AihCompactionApplyLockPath -Workspace $root -TaskId $task.taskId) | ConvertFrom-Json
    Assert-Aih (([bool]$mine2.renewed) -and ([string]$lockAfter.expiresAtUtc -ge [string]$lockBefore.expiresAtUtc)) 'renewal extends expiry'
    $strangerRelease = Invoke-AihCompactionApplyLockRelease -Workspace $root -TaskId $task.taskId -OwnerId 'not-the-owner'
    Assert-Aih (-not [bool]$strangerRelease.released) 'old/non-owner cannot release the lock'
    Assert-Aih (Test-Path -LiteralPath (Get-AihCompactionApplyLockPath -Workspace $root -TaskId $task.taskId)) 'lock survives stranger release'
    $ownRelease = Invoke-AihCompactionApplyLockRelease -Workspace $root -TaskId $task.taskId -OwnerId ([string]$a.ownerId)
    Assert-Aih ([bool]$ownRelease.released) 'owner releases'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 27c. HEARTBEAT FAILURE: holder stops, newcomer recovers safely ==========
$root = New-CompactionFixture 't27c'
try {
    $task = New-CompactionTask $root
    $instance = [string]$task.taskInstanceId
    $a = Invoke-AihCompactionApplyLockAcquire -Workspace $root -TaskId $task.taskId -TaskInstanceId $instance -SessionId 'sess-hb' -OperationId 'ccop_hb' -LeaseSeconds 2
    Assert-Aih ([bool]$a.acquired) 'heartbeat holder acquires short lease'
    Remove-Item -LiteralPath (Get-AihCompactionApplyLockPath -Workspace $root -TaskId $task.taskId) -Force
    $renewGone = Invoke-AihCompactionApplyLockRenew -Workspace $root -TaskId $task.taskId -TaskInstanceId $instance -SessionId 'sess-hb' -OperationId 'ccop_hb' -OwnerId ([string]$a.ownerId) -LeaseSeconds 2
    Assert-Aih (-not [bool]$renewGone.renewed) 'renewal fails when the record is gone (holder must stop)'
    $b = Invoke-AihCompactionApplyLockAcquire -Workspace $root -TaskId $task.taskId -TaskInstanceId $instance -SessionId 'sess-hb' -OperationId 'ccop_hb' -LeaseSeconds 60
    Assert-Aih ([bool]$b.acquired) 'after failure one process can acquire safely'
    Assert-Aih ([string]$b.ownerId -ne [string]$a.ownerId) 'new owner holds a fresh token'
    [void](Invoke-AihCompactionApplyLockRelease -Workspace $root -TaskId $task.taskId -OwnerId ([string]$b.ownerId))
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 28. THRESHOLD VALIDATION FAILS CLOSED =====================================
$invalid = $false
try { [void](Get-AihContextLifecycleThreshold -Override 0) } catch { $invalid = $true }
Assert-Aih $invalid 'zero threshold override throws'
$threshold = Get-AihContextLifecycleThreshold
Assert-Aih ([int]$threshold -eq 120000) 'default threshold reads from the single authority'

Write-Host ("RESULT: $passed context compaction assertions passed.")

