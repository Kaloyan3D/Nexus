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
function New-CompactionFixture([string]$Name) { $path = Join-Path ([IO.Path]::GetTempPath()) ("aih-compaction-$Name-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $path | Out-Null; $path }
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
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'applied' -Reason 'fixture')
    $reapplied = Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'applied' -Reason 'replay'
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
    [void](Set-AihContextLifecycleTransition -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -To 'applied' -Reason 'fixture')
    [void](Set-AihContextCompactionApplied -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -AppliedAtUtc ([DateTime]::UtcNow.ToString('o')) -SessionId 'sess-25')
    $post = Add-AihContextPostCompactionUsage -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -PostCompactionEffectiveInputTokens 60000 -SessionId 'sess-25'
    Assert-Aih ([int]$post.postCompactionEffectiveInputTokens -eq 60000) 'post-compaction input recorded'
    Assert-Aih ([int]$post.firstCallTokenReduction -eq 90000) 'token reduction is pre minus post (150000 - 60000)'
    Assert-Aih ([string]$post.taskInstanceId -eq [string]$task.taskInstanceId) 'post-compaction telemetry keys on the compacted generation'
    $replay = Add-AihContextPostCompactionUsage -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -PostCompactionEffectiveInputTokens 60000 -SessionId 'sess-25'
    Assert-Aih ([int]$replay.firstCallTokenReduction -eq 90000) 'post-compaction replay is idempotent'
    $wrongThrown = $false
    try { [void](Add-AihContextPostCompactionUsage -Workspace $root -TaskId $task.taskId -TaskInstanceId ('task_' + ('8' * 32)) -PostCompactionEffectiveInputTokens 10 -SessionId 'sess-x') } catch { $wrongThrown = $true }
    Assert-Aih $wrongThrown 'post-compaction telemetry for another generation throws'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }

# == 26. THRESHOLD VALIDATION FAILS CLOSED =====================================
$invalid = $false
try { [void](Get-AihContextLifecycleThreshold -Override 0) } catch { $invalid = $true }
Assert-Aih $invalid 'zero threshold override throws'
$threshold = Get-AihContextLifecycleThreshold
Assert-Aih ([int]$threshold -eq 120000) 'default threshold reads from the single authority'

Write-Host ("RESULT: $passed context compaction assertions passed.")

