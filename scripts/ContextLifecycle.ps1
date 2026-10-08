Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# ContextLifecycle.ps1 - Context Compaction V1 controller-owned context lifecycle.
#
# ONE authority for context-lifecycle decisions. TaskController.ps1 remains the
# ONLY task lifecycle state machine; this module NEVER mutates task status and
# NEVER overrides routing. It owns: the compaction threshold constant,
# per-task root pressure telemetry, the checkpoint schema plus writer, the
# eligibility state machine, and the telemetry record. The model-facing
# projection change itself is applied by the controller bridge
# (config/AihController.cjs) through the supported DSH session surface seam
# (surfaceOp replace); this module only prepares durable state for it.
#
# Fail-closed everywhere: any ambiguity keeps the existing context (KEEP).
# Historical tasks without context-lifecycle fields keep loading: every reader
# below treats missing fields as inactive or absent, never as corrupt.

# V1 threshold authority. ONE constant; no magic numbers elsewhere.
$AihContextCompactionThresholdTokens = 120000

# Checkpoint schema version (persisted in every checkpoint plus state record).
$AihContextCheckpointSchemaVersion = 1
# F10: ONE authoritative checkpoint resource contract shared by builder AND
# reader (never separate magic numbers that can drift). Bytes are UTF-8
# serialized JSON bytes (no BOM, no trailing newline -- exactly what
# Write-AihAtomicJson persists), so raw file bytes and payload bytes agree.
$AihContextCheckpointMaxBytes = 65536
$AihContextCheckpointMaxChangedFiles = 200

# Frozen compaction-operation schema version. Bumped independently of the
# checkpoint content version so old checkpoint-ready states without a frozen
# operation are never reinterpreted as new ones (see F2/F5 repair).
$AihContextOperationSchemaVersion = 1

# Context-lifecycle state machine states.
# apply-pending  = frozen operation persisted, replacement not yet appended.
# awaiting-durability = replacement appended in memory, durability unconfirmed.
$AihContextLifecycleStates = @('inactive', 'eligible', 'checkpoint-ready', 'apply-pending', 'awaiting-durability', 'applied', 'blocked')
function Get-AihContextLifecycleThreshold {
    param([int]$Override = -1)
    if ($Override -ge 0) {
        if ($Override -lt 1) { throw 'Context compaction threshold must be a positive token count. (KEEP: invalid configuration fails closed.)' }
        return [int]$Override
    }
    return [int]$AihContextCompactionThresholdTokens
}

function Get-AihContextLifecyclePaths {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $layout = Get-AihLedgerLayout $Workspace
    $run = Join-Path $layout.Runs $TaskId
    return [pscustomobject]@{
        Run = $run
        Checkpoint = Join-Path $run 'context-checkpoint.json'
        Lifecycle = Join-Path $run 'context-lifecycle.json'
        Pressure = Join-Path $run 'context-pressure.json'
        Operation = Join-Path $run 'context-compaction-operation.json'
    }
}

function Read-AihContextLifecycleState {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    if (-not (Test-Path -LiteralPath $paths.Lifecycle)) { return $null }
    try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $paths.Lifecycle | ConvertFrom-Json }
    catch { return $null }
}

function Write-AihContextLifecycleState {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId, [Parameter(Mandatory = $true)]$State)
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    Write-AihAtomicJson $paths.Lifecycle $State
    return $State
}
function Read-AihContextPressure {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    if (-not (Test-Path -LiteralPath $paths.Pressure)) { return $null }
    try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $paths.Pressure | ConvertFrom-Json }
    catch { return $null }
}

function Get-AihContextUsageLockPath {
    # F6: cross-process short-transaction lock for per-generation root-usage
    # accounting. Scoped to exactly one task run dir (the pressure document
    # identity); the generation (taskInstanceId) is validated INSIDE the
    # transaction. Separate FILE from context-compaction-apply.lock: apply
    # ownership and usage accounting are different resources and must never
    # share owner state.
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $layout = Get-AihLedgerLayout $Workspace
    return (Join-Path (Join-Path $layout.Runs $TaskId) 'context-pressure.lock')
}
function Compare-AihContextStepOrder {
    # F6: authoritative usage-event order is the producer StepId 'turn:step'
    # (AihController candidate.stepId). Returns 1/0/-1 or $null when either
    # side has no parseable order (step-less events keep write order).
    param([string]$A, [string]$B)
    $aTurn = 0; $aStep = 0; $bTurn = 0; $bStep = 0
    if ([string]::IsNullOrWhiteSpace($A) -or [string]::IsNullOrWhiteSpace($B)) { return $null }
    $aParts = ([string]$A).Split(':'); $bParts = ([string]$B).Split(':')
    if ($aParts.Count -ne 2 -or $bParts.Count -ne 2) { return $null }
    if (-not [int]::TryParse($aParts[0], [ref]$aTurn)) { return $null }
    if (-not [int]::TryParse($aParts[1], [ref]$aStep)) { return $null }
    if (-not [int]::TryParse($bParts[0], [ref]$bTurn)) { return $null }
    if (-not [int]::TryParse($bParts[1], [ref]$bStep)) { return $null }
    if ($aTurn -ne $bTurn) { if ($aTurn -gt $bTurn) { return 1 } else { return -1 } }
    if ($aStep -ne $bStep) { if ($aStep -gt $bStep) { return 1 } else { return -1 } }
    return 0
}
function Invoke-AihContextUsageTransaction {
    # F6: serialize the SHORT per-generation pressure read/modify/write
    # transaction across OS processes. Acquire: atomic CreateNew spin with a
    # bounded wait (~15s); a stale lock (age > 30s AND owner not provably
    # live) may be taken over. Release: ownerId match only. Acquisition
    # failure THROWS so a writer never reports success while dropping its
    # record. The critical section covers ONLY local pressure state IO.
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [int]$TimeoutMs = 15000,
        [int]$StaleSeconds = 30
    )
    $lockPath = Get-AihContextUsageLockPath -Workspace $Workspace -TaskId $TaskId
    $directory = Split-Path -Parent ([System.IO.Path]::GetFullPath($lockPath))
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $ownerId = [guid]::NewGuid().ToString('N')
    $ownerPid = 0
    try { $ownerPid = [int]$PID } catch { $ownerPid = 0 }
    $ownerStart = $null
    try { $ownerStart = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { $ownerStart = $null }
    $payload = ConvertTo-Json -InputObject ([ordered]@{ ownerId = $ownerId; ownerPid = $ownerPid; ownerProcessStartUtc = $ownerStart; acquiredAtUtc = ([DateTime]::UtcNow.ToString('o')) }) -Depth 5
    $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(1000, [int]$TimeoutMs))
    $acquired = $false
    while (-not $acquired) {
        try {
            $stream = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush()
            } finally { $stream.Dispose() }
            $acquired = $true
        } catch [IO.IOException] {
            $takeover = $false
            try {
                $age = [DateTime]::UtcNow - (Get-Item -LiteralPath $lockPath -ErrorAction Stop).LastWriteTimeUtc
                if ($age.TotalSeconds -gt [Math]::Max(5, [int]$StaleSeconds)) {
                    $existing = $null
                    try { $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $lockPath | ConvertFrom-Json } catch { $existing = $null }
                    $ownerAlive = $false
                    if (($null -ne $existing) -and ($null -ne $existing.PSObject.Properties['ownerPid'])) {
                        $ePid = 0
                        if ([int]::TryParse([string]$existing.ownerPid, [ref]$ePid) -and ($ePid -gt 0)) {
                            try {
                                $proc = Get-Process -Id $ePid -ErrorAction Stop
                                $started = $proc.StartTime.ToUniversalTime().ToString('o')
                                $recorded = $null
                                if ($null -ne $existing.PSObject.Properties['ownerProcessStartUtc']) { $recorded = [string]$existing.ownerProcessStartUtc }
                                $ownerAlive = ([string]::IsNullOrWhiteSpace($recorded) -or ($started -eq $recorded))
                            } catch { $ownerAlive = $false }
                        }
                    }
                    if (-not $ownerAlive) { $takeover = $true }
                }
            } catch { $takeover = $false }
            if ($takeover) {
                try { Remove-Item -LiteralPath $lockPath -Force; continue } catch { }
            }
            if ([DateTime]::UtcNow -ge $deadline) { throw "Context usage transaction refused: pressure lock busy for task $TaskId (KEEP: record not accepted, caller must surface failure, never silent drop.)" }
            Start-Sleep -Milliseconds 25
        }
    }
    try {
        return (& $Action)
    } finally {
        try {
            if (Test-Path -LiteralPath $lockPath) {
                $current = $null
                try { $current = Get-Content -Raw -Encoding UTF8 -LiteralPath $lockPath | ConvertFrom-Json } catch { $current = $null }
                if (($null -eq $current) -or ($null -eq $current.PSObject.Properties['ownerId']) -or ([string]$current.ownerId -eq [string]$ownerId)) {
                    Remove-Item -LiteralPath $lockPath -Force
                }
            }
        } catch { }
    }
}
function Add-AihContextRootUsage {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][ValidateSet('muse_main', 'engineer_normal', 'engineer_deep')][string]$EngineRole,
        [Parameter(Mandatory = $true)][string]$Engine,
        [int]$UncachedInputTokens = 0,
        [int]$CacheReadTokens = 0,
        [int]$OutputTokens = 0,
        [bool]$UsageAvailable = $false,
        [string]$Model = '',
        [string]$Provider = '',
        [string]$StepId = '',
        [string]$SessionId = ''
    )
    if (-not [string]::IsNullOrWhiteSpace($TaskInstanceId)) {
        $identity = Test-AihTaskIdentity -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
        if (-not [bool]$identity.exists) { throw "Context lifecycle rejected: task was not found in the authoritative ledger: $TaskId" }
        if (-not [bool]$identity.instanceMatches) { throw "Context lifecycle rejected: task $TaskId no longer holds taskInstanceId '$TaskInstanceId'. (KEEP: generation mismatch.)" }
    }
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $actualInstance = $null
    if ($null -ne $task.PSObject.Properties['taskInstanceId']) { $actualInstance = [string]$task.taskInstanceId }
    # F6: the identity reads above are ledger-only (no mutation) and stay
    # outside the lock. The critical section below is EXACTLY: read pressure,
    # generation check, dedupe decision, StepId-ordered latest/peak/counter
    # update, atomic write. No Git, model, DSH, checkpoint, telemetry, or
    # compaction work occurs inside Invoke-AihContextUsageTransaction.
    return (Invoke-AihContextUsageTransaction -Workspace $Workspace -TaskId $TaskId -Action {
        $pressure = Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId
        $isFreshInstance = ($null -eq $pressure) -or ([string]$pressure.taskInstanceId -ne [string]$actualInstance)
        if ($isFreshInstance) {
            $pressure = [pscustomobject][ordered]@{
                schemaVersion = 1; taskId = $TaskId; taskInstanceId = $actualInstance
                latestEffectiveInputTokens = 0; peakEffectiveInputTokens = 0
                cumulativeUncachedInputTokens = 0; cumulativeCacheReadTokens = 0
                cumulativeOutputTokens = 0; rootModelCallCount = 0
                callsByEngine = [pscustomobject][ordered]@{ muse = 0; dual = 0 }
                callsByRole = [pscustomobject][ordered]@{ muse_main = 0; engineer_normal = 0; engineer_deep = 0 }
                lastCallAtUtc = $null; lastModel = $null; lastProvider = $null
                lastStepId = $null; lastSessionId = $null
            }
        }
        $seenSteps = @()
        if ($null -ne $pressure.PSObject.Properties['seenStepIds']) { $seenSteps = @($pressure.seenStepIds) }
        if ((-not [string]::IsNullOrWhiteSpace($StepId)) -and (@($seenSteps | Where-Object { [string]$_ -eq $StepId }).Count -gt 0)) {
            return [pscustomobject]$pressure
        }
        $effective = 0
        if ([bool]$UsageAvailable) { $effective = [int]$UncachedInputTokens + [int]$CacheReadTokens }
        if ($effective -lt 0) { $effective = 0 }
        # F6 authoritative order: lock acquisition order is NOT usage-event
        # order. `latest` (+ last model/provider/session/time) follows the
        # producer StepId 'turn:step'; step-less events keep write order.
        $storedOrder = $null
        if ($null -ne $pressure.PSObject.Properties['lastStepId']) { $storedOrder = [string]$pressure.lastStepId }
        $orderCmp = Compare-AihContextStepOrder -A ([string]$StepId) -B $storedOrder
        if (($null -eq $orderCmp) -or ($orderCmp -ge 0)) {
            $pressure.latestEffectiveInputTokens = [int]$effective
            $pressure.lastCallAtUtc = [DateTime]::UtcNow.ToString('o')
            if (-not [string]::IsNullOrWhiteSpace($Model)) { $pressure.lastModel = [string]$Model }
            if (-not [string]::IsNullOrWhiteSpace($Provider)) { $pressure.lastProvider = [string]$Provider }
            if (-not [string]::IsNullOrWhiteSpace($StepId)) {
                $pressure | Add-Member -NotePropertyName 'lastStepId' -NotePropertyValue ([string]$StepId) -Force
            }
            if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
                $pressure | Add-Member -NotePropertyName 'lastSessionId' -NotePropertyValue ([string]$SessionId) -Force
            }
        }
        if ([int]$effective -gt [int]$pressure.peakEffectiveInputTokens) { $pressure.peakEffectiveInputTokens = [int]$effective }
        if ([bool]$UsageAvailable) {
            $pressure.cumulativeUncachedInputTokens = [int]$pressure.cumulativeUncachedInputTokens + [int]$UncachedInputTokens
            $pressure.cumulativeCacheReadTokens = [int]$pressure.cumulativeCacheReadTokens + [int]$CacheReadTokens
            $pressure.cumulativeOutputTokens = [int]$pressure.cumulativeOutputTokens + [int]$OutputTokens
        }
        $pressure.rootModelCallCount = [int]$pressure.rootModelCallCount + 1
        if ($Engine -eq 'muse') { $pressure.callsByEngine.muse = [int]$pressure.callsByEngine.muse + 1 }
        else { $pressure.callsByEngine.dual = [int]$pressure.callsByEngine.dual + 1 }
        $roleKey = [string]$EngineRole
        if ($roleKey -eq 'muse_main') { $pressure.callsByRole.muse_main = [int]$pressure.callsByRole.muse_main + 1 }
        elseif ($roleKey -eq 'engineer_normal') { $pressure.callsByRole.engineer_normal = [int]$pressure.callsByRole.engineer_normal + 1 }
        elseif ($roleKey -eq 'engineer_deep') { $pressure.callsByRole.engineer_deep = [int]$pressure.callsByRole.engineer_deep + 1 }
        if (-not [string]::IsNullOrWhiteSpace($StepId)) {
            $pressure | Add-Member -NotePropertyName 'seenStepIds' -NotePropertyValue (@($seenSteps) + @($StepId)) -Force
        }
        $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
        Write-AihAtomicJson $paths.Pressure $pressure
        return [pscustomobject]$pressure
    })
}
function Test-AihContextCompactionEligibility {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [string]$TaskInstanceId,
        [string]$SessionId = '',
        [int]$ThresholdOverride = -1
    )
    $threshold = Get-AihContextLifecycleThreshold -Override $ThresholdOverride
    $failDecision = {
        param([string]$Reason, $PressureDoc, $TaskDoc)
        $record = [ordered]@{
            schemaVersion = 1; taskId = $TaskId
            taskInstanceId = $(if ($null -ne $TaskDoc -and $null -ne $TaskDoc.PSObject.Properties['taskInstanceId']) { [string]$TaskDoc.taskInstanceId } else { $TaskInstanceId })
            sessionId = [string]$SessionId; engine = $(if ($null -ne $TaskDoc -and $null -ne $TaskDoc.PSObject.Properties['boundEngine']) { [string]$TaskDoc.boundEngine } else { $null })
            thresholdTokens = [int]$threshold
            latestEffectiveInputTokens = $(if ($null -ne $PressureDoc) { [int]$PressureDoc.latestEffectiveInputTokens } else { 0 })
            peakEffectiveInputTokens = $(if ($null -ne $PressureDoc) { [int]$PressureDoc.peakEffectiveInputTokens } else { 0 })
            cumulativeUncachedInputTokens = $(if ($null -ne $PressureDoc) { [int]$PressureDoc.cumulativeUncachedInputTokens } else { 0 })
            cumulativeCacheReadTokens = $(if ($null -ne $PressureDoc) { [int]$PressureDoc.cumulativeCacheReadTokens } else { 0 })
            cumulativeOutputTokens = $(if ($null -ne $PressureDoc) { [int]$PressureDoc.cumulativeOutputTokens } else { 0 })
            rootModelCallCount = $(if ($null -ne $PressureDoc) { [int]$PressureDoc.rootModelCallCount } else { 0 })
            eligibilityDecision = 'keep'; eligibilityReason = [string]$Reason
            checkpointPath = $null; checkpointSizeBytes = $null; checkpointApplied = $false
            appliedAtUtc = $null; blockedReason = $null; recordedAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        return [pscustomobject]$record
    }
    $task = $null
    try { $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    catch { return (& $failDecision ('task-identity-unproven: ' + [string]$_.Exception.Message) $null $null) }
    if ([string]$task.status -ne 'complete') {
        return (& $failDecision ('task-not-complete: status is "' + [string]$task.status + '". KEEP.') (Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId) $task)
    }
    if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) {
        return (& $failDecision 'task-instance-unproven: no taskInstanceId supplied. KEEP.' (Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId) $task)
    }
    $actualInstance = [string]$task.taskInstanceId
    if ([string]::IsNullOrWhiteSpace($actualInstance) -or ($actualInstance -ne $TaskInstanceId)) {
        return (& $failDecision ('task-instance-mismatch: ledger holds "' + $actualInstance + '". KEEP.') (Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId) $task)
    }
    $pressure = Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId
    if (($null -eq $pressure) -or ([string]$pressure.taskInstanceId -ne [string]$actualInstance)) {
        return (& $failDecision 'pressure-unproven: no root pressure for this lifecycle generation. KEEP.' $pressure $task)
    }
    if ([int]$pressure.rootModelCallCount -lt 1) {
        return (& $failDecision 'pressure-unproven: no root model calls recorded. KEEP.' $pressure $task)
    }
    $signal = [int]$pressure.latestEffectiveInputTokens
    if ($signal -ge [int]$threshold) {
        $record = [ordered]@{
            schemaVersion = 1; taskId = $TaskId; taskInstanceId = [string]$actualInstance
            sessionId = [string]$SessionId; engine = [string]$task.boundEngine
            thresholdTokens = [int]$threshold
            latestEffectiveInputTokens = [int]$pressure.latestEffectiveInputTokens
            peakEffectiveInputTokens = [int]$pressure.peakEffectiveInputTokens
            cumulativeUncachedInputTokens = [int]$pressure.cumulativeUncachedInputTokens
            cumulativeCacheReadTokens = [int]$pressure.cumulativeCacheReadTokens
            cumulativeOutputTokens = [int]$pressure.cumulativeOutputTokens
            rootModelCallCount = [int]$pressure.rootModelCallCount
            eligibilityDecision = 'eligible'; eligibilityReason = 'controller-complete plus latest root effective input at or above threshold.'
            checkpointPath = $null; checkpointSizeBytes = $null; checkpointApplied = $false
            appliedAtUtc = $null; blockedReason = $null; recordedAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        return [pscustomobject]$record
    }
    return (& $failDecision ('below-threshold: latest root effective input ' + [string]$signal + ' is below ' + [string]$threshold + '. KEEP.') $pressure $task)
}
function Get-AihContextGitFacts {
    # F8: failure to establish repository truth yields UNKNOWN/KEEP, never a
    # clean fact. BOTH required commands must exit 0 AND HEAD must be
    # non-empty; otherwise gitKnown=$false with a machine-safe reason code.
    # Empty stdout from a FAILED command is never cleanliness.
    param([Parameter(Mandatory = $true)][string]$Workspace)
    $facts = [ordered]@{ baseCommit = $null; headCommit = $null; worktreeClean = $null; changedFiles = @(); gitKnown = $false; gitReason = $null }
    $headOk = $false
    try {
        # NOTE: no terminating pipe (Select-Object -First) between the native
        # call and $LASTEXITCODE: a short-circuiting pipeline does not
        # populate the exit variable, and StrictMode reads would throw.
        $headLines = @(& git -C $Workspace rev-parse HEAD 2>$null)
        $headCode = [int](Get-Variable -Name LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue)
        $head = $(if (@($headLines).Count -gt 0) { $headLines[0] } else { $null })
        if (($headCode -eq 0) -and ($null -ne $head) -and (-not [string]::IsNullOrWhiteSpace([string]$head))) {
            $facts.headCommit = ([string]$head).Trim()
            $headOk = $true
        } else { $facts.gitReason = 'rev-parse-failed' }
    } catch { $facts.gitReason = 'rev-parse-failed' }
    if (-not $headOk) { return [pscustomobject]$facts }
    try {
        $porcelain = @(& git -C $Workspace status --porcelain=v1 --untracked-files=normal 2>$null)
        $statusCode = [int](Get-Variable -Name LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue)
        if ($statusCode -ne 0) { $facts.gitReason = 'status-failed'; return [pscustomobject]$facts }
        $entries = @()
        foreach ($line in $porcelain) {
            $text = ([string]$line)
            if ($text.Length -lt 4) { continue }
            $staged = $text.Substring(0, 1); $unstaged = $text.Substring(1, 1)
            $pathPart = $text.Substring(3)
            $state = 'modified'
            if (($staged -eq 'A') -or ($unstaged -eq 'A')) { $state = 'added' }
            elseif (($staged -eq 'D') -or ($unstaged -eq 'D')) { $state = 'deleted' }
            elseif (($staged -eq 'R') -or ($unstaged -eq 'R')) { $state = 'renamed' }
            elseif ($unstaged -eq '?') { $state = 'untracked' }
            $entries += [ordered]@{ path = $pathPart; status = $state; staged = ($staged -ne ' ' -and $staged -ne '?' -and $staged -ne '!'); unstaged = ($unstaged -ne ' ') }
            if (@($entries).Count -ge $AihContextCheckpointMaxChangedFiles) { break }
        }
        $facts.changedFiles = @($entries)
        $facts.worktreeClean = (@($entries).Count -eq 0)
        $facts.gitKnown = $true
        $facts.gitReason = $null
    } catch { $facts.gitReason = 'status-failed' }
    return [pscustomobject]$facts
}

function ConvertTo-AihContextRedactedText {
    param([string]$Text, [int]$MaxChars = 4000)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $redacted = [string]$Text
    # F4 checkpoint persistence boundary: secret material must never land in
    # checkpoint storage. Order matters: PEM blocks first (multi-line), then
    # URL credentials, then bearer/key formats, then key=value assignments,
    # then JSON-style assignments. Every replacement emits the stable
    # <redacted> marker; the matched secret value is never logged/persisted.
    # PEM/private-key blocks (incl. RSA variant), DOTALL so embedded newlines match.
    $redacted = [regex]::Replace($redacted, '(?si)-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----.*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----', '<redacted>')
    # URL userinfo credentials: scheme://user:password@host -> scheme://<redacted>@host.
    $redacted = [regex]::Replace($redacted, '([a-zA-Z][a-zA-Z0-9+.-]*://)[^\s/@]+:[^\s/@]+@', '$1<redacted>@')
    # URL query credentials: ?token=.. &access_token=.. (also ; and # fragments).
    $redacted = [regex]::Replace($redacted, '(?i)([?&#;](?:token|access_token|api[_-]?key|client_secret|password|secret|auth)\s*=\s*)([^\s&#;]+)', '$1<redacted>')
    $redacted = [regex]::Replace($redacted, '(?i)\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}', '$1<redacted>')
    $redacted = [regex]::Replace($redacted, '\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[bpas]-[A-Za-z0-9-]{8,})\b', '<redacted>')
    # Key/value assignments incl. env-style names (AWS_SECRET_ACCESS_KEY,
    # GITHUB_TOKEN, OPENAI_API_KEY, DEEPSEEK_API_KEY, SERVICE_TOKEN,
    # DB_PASSWORD, ...). Quoted values keep their quotes via $3/$5.
    $redacted = [regex]::Replace($redacted, '(?i)\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token)[A-Za-z0-9_.-]*\s*[:=]\s*)(["\u0027]?)([^\s,;"\u0027]+)(["\u0027]?)', '$1$2<redacted>$4')
    $redacted = [regex]::Replace($redacted, '(?i)("(?:apiKey|api_key|accessToken|access_token|clientSecret|client_secret|password|authorization|token|secret)"\s*:\s*")[^"]*(")', '$1<redacted>$2')
    $redacted = $redacted.Trim()
    if ($redacted.Length -gt $MaxChars) { $redacted = $redacted.Substring(0, $MaxChars) + '...<truncated>' }
    return $redacted
}
# F4: ONE authoritative checkpoint-safe projection boundary. Recurses through
# strings, arrays, ordered dictionaries, and PSCustomObjects WITHOUT mutating
# the caller source; non-string scalars pass through unchanged; output is
# deterministic. Structural sanitization happens BEFORE serialization (never
# JSON.stringify(...).replace(...) as the primary sanitizer).
function ConvertTo-AihContextSafeCheckpointValue {
    param($Value, [int]$MaxChars = 4000)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) { return (ConvertTo-AihContextRedactedText -Text ([string]$Value) -MaxChars $MaxChars) }
    if ($Value -is [System.Collections.IDictionary]) {
        $safe = [ordered]@{}
        foreach ($key in @($Value.Keys)) { $safe[[string]$key] = ConvertTo-AihContextSafeCheckpointValue -Value $Value[$key] -MaxChars $MaxChars }
        return $safe
    }
    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [byte[]])) {
        $items = @()
        foreach ($entry in @($Value)) { $items += @(ConvertTo-AihContextSafeCheckpointValue -Value $entry -MaxChars $MaxChars) }
        return $items
    }
    if ($null -ne $Value.PSObject -and ($Value -is [psobject]) -and ($Value.PSObject.Properties.Count -gt 0) -and -not ($Value -is [ValueType])) {
        $safe = [ordered]@{}
        foreach ($prop in @($Value.PSObject.Properties)) { $safe[[string]$prop.Name] = ConvertTo-AihContextSafeCheckpointValue -Value $prop.Value -MaxChars $MaxChars }
        return $safe
    }
    return $Value
}
# F4: bounded per-item checkpoint string projection (minimize-then-redact).
function ConvertTo-AihContextCheckpointField {
    param([string]$Text, [int]$MaxChars = 500)
    return (ConvertTo-AihContextRedactedText -Text ([string]$Text) -MaxChars $MaxChars)
}
function New-AihContextCheckpoint {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [string]$ContinuityUserText = '',
        [string]$ContinuityAssistantText = '',
        [string]$PreviousUserText = '',
        [string]$PreviousAssistantText = ''
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ([string]$task.status -ne 'complete') { throw "Checkpoint refused: task $TaskId status is '$($task.status)', not complete. (KEEP.)" }
    $layout = Get-AihLedgerLayout $Workspace
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    $evidence = $null
    $evidencePath = Join-Path (Join-Path $layout.Runs $TaskId) 'evidence.json'
    if (Test-Path -LiteralPath $evidencePath) {
        try { $evidence = Get-Content -Raw -Encoding UTF8 -LiteralPath $evidencePath | ConvertFrom-Json } catch { $evidence = $null }
    }
    $evidenceInstance = $null
    if (($null -ne $evidence) -and ($null -ne $evidence.PSObject.Properties['taskInstanceId'])) { $evidenceInstance = [string]$evidence.taskInstanceId }
    $verificationOutcomes = @()
    if (($null -ne $evidence) -and ($null -ne $evidence.PSObject.Properties['verification'])) {
        foreach ($check in @($evidence.verification)) {
            if ($null -eq $check) { continue }
            $verificationOutcomes += [ordered]@{
                name = (ConvertTo-AihContextCheckpointField -Text ([string]$check.name) -MaxChars 500); kind = [string]$check.kind
                status = ([string]$check.status).ToUpperInvariant()
                exitCode = $(if ($null -ne $check.PSObject.Properties['exitCode']) { $check.exitCode } else { $null })
                attempt = $(if ($null -ne $check.PSObject.Properties['attempt']) { [int]$check.attempt } else { $null })
            }
        }
    }
    $criteriaEvidence = @()
    if (($null -ne $evidence) -and ($null -ne $evidence.PSObject.Properties['acceptanceCriteria'])) {
        foreach ($item in @($evidence.acceptanceCriteria)) {
            if ($null -eq $item) { continue }
            $criterionText = ConvertTo-AihContextRedactedText -Text ([string]$item.criterion) -MaxChars 500
            $itemEvidence = ConvertTo-AihContextRedactedText -Text ([string]$item.evidence) -MaxChars 500
            $criteriaEvidence += [ordered]@{ criterion = $criterionText; status = [string]$item.status; evidence = $itemEvidence }
        }
    }
    $attempts = @()
    $attemptsPath = Join-Path (Join-Path $layout.Runs $TaskId) 'attempts.jsonl'
    if (Test-Path -LiteralPath $attemptsPath) {
        foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $attemptsPath) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try { $record = $line | ConvertFrom-Json } catch { continue }
            if (($null -eq $record) -or ([string]$record.taskId -ne $TaskId)) { continue }
            $attempts += [ordered]@{
                sequence = [int]$record.sequence; status = [string]$record.status
                timestampUtc = $(if ($null -ne $record.PSObject.Properties['timestampUtc']) { [string]$record.timestampUtc } elseif ($null -ne $record.PSObject.Properties['startedAtUtc']) { [string]$record.startedAtUtc } else { $null })
            }
        }
    }
    $gitFacts = Get-AihContextGitFacts -Workspace $Workspace
    # F8: UNKNOWN repository truth blocks checkpoint preparation (KEEP).
    # No READY/APPLYABLE operation may be created from unknown state;
    # the controller evaluate path logs and keeps the live session.
    if (-not [bool]$gitFacts.gitKnown) {
        throw ("Checkpoint refused: repository truth is unknown (" + [string]$gitFacts.gitReason + "). (KEEP: ordinary session continues; no clean-worktree claim persisted.)")
    }
    $pressure = Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId
    $boundEngine = $null
    if ($null -ne $task.PSObject.Properties['boundEngine']) { $boundEngine = [string]$task.boundEngine }
    $checkpoint = [ordered]@{
        schemaVersion = [int]$AihContextCheckpointSchemaVersion
        taskId = [string]$task.taskId; taskInstanceId = [string]$task.taskInstanceId
        checkpointOf = [string]$task.taskInstanceId
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
        workspace = [ordered]@{
            executionRoot = [string]$Workspace
            workspaceId = $(if ($null -ne $task.PSObject.Properties['workspaceId']) { [string]$task.workspaceId } else { $null })
            repositoryId = $null; checkoutId = $null
        }
        engine = $boundEngine
        preset = $null
        executionClass = [string]$task.executionClass
        task = [ordered]@{
            description = (ConvertTo-AihContextRedactedText -Text ([string]$task.description) -MaxChars 4000)
            acceptanceCriteria = @(@($task.acceptanceCriteria) | ForEach-Object { ConvertTo-AihContextCheckpointField -Text ([string]$PSItem) -MaxChars 500 })
            status = [string]$task.status
            createdAtUtc = [string]$task.createdAtUtc; completedAtUtc = [string]$task.completedAtUtc
        }
        execution = [ordered]@{
            attempts = [int]$task.attempt
            attemptTimeline = @($attempts)
            risk = [string]$task.risk
            reviewRequested = [bool]$task.reviewRequested
            completionAuthority = 'deterministic-controller'
        }
        repositoryState = [ordered]@{
            baseCommit = $(if ($null -ne $task.PSObject.Properties['baseCommit']) { [string]$task.baseCommit } else { $null })
            headCommit = [string]$gitFacts.headCommit
            worktreeClean = $gitFacts.worktreeClean
            changedFiles = @(ConvertTo-AihContextSafeCheckpointValue -Value @($gitFacts.changedFiles) -MaxChars 500)
        }
        verification = [ordered]@{
            outcomes = @($verificationOutcomes)
            acceptanceEvidence = @($criteriaEvidence)
            evidenceTaskInstanceId = $evidenceInstance
            scopePass = $(if (($null -ne $evidence) -and ($null -ne $evidence.PSObject.Properties['scopePass'])) { [bool]$evidence.scopePass } else { $null })
        }
        routingProvenance = [ordered]@{
            executionClass = [string]$task.executionClass
            engine = $boundEngine
            note = 'Context only. This checkpoint MUST NOT override future authoritative routing or model selection.'
        }
        pressure = $(if ($null -ne $pressure) {
            [ordered]@{
                latestEffectiveInputTokens = [int]$pressure.latestEffectiveInputTokens
                peakEffectiveInputTokens = [int]$pressure.peakEffectiveInputTokens
                rootModelCallCount = [int]$pressure.rootModelCallCount
            }
        } else { $null })
        continuity = [ordered]@{
            finalUserRequest = (ConvertTo-AihContextRedactedText -Text ([string]$ContinuityUserText) -MaxChars 2000)
            finalAssistantReport = (ConvertTo-AihContextRedactedText -Text ([string]$ContinuityAssistantText) -MaxChars 4000)
            previousUserText = (ConvertTo-AihContextRedactedText -Text ([string]$PreviousUserText) -MaxChars 1000)
            previousAssistantText = (ConvertTo-AihContextRedactedText -Text ([string]$PreviousAssistantText) -MaxChars 1000)
            note = 'Historical context only. Not controller truth. No tool transcripts, no shell output, no hidden reasoning.'
        }
    }
    if (($null -ne $evidence) -and (-not [string]::IsNullOrWhiteSpace($evidenceInstance)) -and ($evidenceInstance -ne [string]$task.taskInstanceId)) {
        $checkpoint.verification = [ordered]@{
            outcomes = @(); acceptanceEvidence = @(); evidenceTaskInstanceId = $evidenceInstance
            scopePass = $null; note = 'Evidence belongs to another lifecycle generation; excluded from this checkpoint. KEEP semantics preserved.'
        }
    }
    $json = ConvertTo-Json -InputObject (ConvertTo-AihJsonSafe $checkpoint) -Depth 20
    $bytes = [Text.Encoding]::UTF8.GetByteCount($json)
    if ($bytes -gt $AihContextCheckpointMaxBytes) { throw "Checkpoint refused: serialized size $bytes exceeds the 64KiB V1 bound. (KEEP: checkpoint must stay compact.)" }
    Write-AihAtomicJson $paths.Checkpoint $checkpoint
    $actual = Get-Content -Raw -Encoding UTF8 -LiteralPath $paths.Checkpoint | ConvertFrom-Json
    if (($null -eq $actual) -or ([string]$actual.taskInstanceId -ne [string]$task.taskInstanceId) -or ([int]$actual.schemaVersion -ne [int]$AihContextCheckpointSchemaVersion)) {
        throw 'Checkpoint refused: read-back validation failed after atomic write. (KEEP.)'
    }
    return [pscustomobject]@{ path = $paths.Checkpoint; sizeBytes = $bytes; taskId = $TaskId; taskInstanceId = [string]$task.taskInstanceId }
}
function Read-AihContextCheckpoint {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId, [string]$ExpectedTaskInstanceId = '')
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    if (-not (Test-Path -LiteralPath $paths.Checkpoint)) { return $null }
    # F10: fail closed on checkpoints the builder would refuse to create.
    # Cheap stat pre-check first (early refusal, no trust), then the
    # authoritative decision on the ACTUAL loaded bytes (TOCTOU-safe: the
    # stat value is never the acceptance criterion). No truncation, repair,
    # or rewrite of the persisted artifact -- reject and KEEP/BLOCK.
    try {
        $statBytes = (Get-Item -LiteralPath $paths.Checkpoint -ErrorAction Stop).Length
        if ([long]$statBytes -gt [long]$AihContextCheckpointMaxBytes) {
            throw ("Checkpoint blocked: context-checkpoint.json is " + [string]$statBytes + " bytes, exceeding the " + [string]$AihContextCheckpointMaxBytes + "-byte V1 bound (checkpoint-too-large). (KEEP: old context retained.)")
        }
    } catch {
        if ([string]$_.Exception.Message -like '*checkpoint-too-large*') { throw }
    }
    try { $rawText = Get-Content -Raw -Encoding UTF8 -LiteralPath $paths.Checkpoint }
    catch { throw "Checkpoint blocked: context-checkpoint.json is unreadable. (KEEP: old context retained.)" }
    $loadedBytes = [Text.Encoding]::UTF8.GetByteCount([string]$rawText)
    if ($loadedBytes -gt $AihContextCheckpointMaxBytes) {
        throw ("Checkpoint blocked: context-checkpoint.json is " + [string]$loadedBytes + " bytes, exceeding the " + [string]$AihContextCheckpointMaxBytes + "-byte V1 bound (checkpoint-too-large). (KEEP: old context retained.)")
    }
    try { $checkpoint = [string]$rawText | ConvertFrom-Json }
    catch { throw "Checkpoint blocked: context-checkpoint.json is malformed. (KEEP: old context retained.)" }
    if (($null -eq $checkpoint) -or ($null -eq $checkpoint.PSObject.Properties['schemaVersion']) -or ($null -eq $checkpoint.PSObject.Properties['taskId']) -or ($null -eq $checkpoint.PSObject.Properties['taskInstanceId'])) {
        throw 'Checkpoint blocked: required identity fields are missing. (KEEP: old context retained.)'
    }
    if ([int]$checkpoint.schemaVersion -ne [int]$AihContextCheckpointSchemaVersion) {
        throw ('Checkpoint blocked: schemaVersion ' + [string]$checkpoint.schemaVersion + ' is not V1. (KEEP.)')
    }
    if ([string]$checkpoint.taskId -ne $TaskId) {
        throw 'Checkpoint blocked: taskId mismatch. (KEEP: old context retained.)'
    }
    if ((-not [string]::IsNullOrWhiteSpace($ExpectedTaskInstanceId)) -and ([string]$checkpoint.taskInstanceId -ne $ExpectedTaskInstanceId)) {
        throw 'Checkpoint blocked: taskInstanceId mismatch. (KEEP: old context retained.)'
    }
    $changedFilesNode = $null
    if (($null -ne $checkpoint.PSObject.Properties['repositoryState']) -and ($null -ne $checkpoint.repositoryState) -and ($null -ne $checkpoint.repositoryState.PSObject.Properties['changedFiles'])) {
        $changedFilesNode = $checkpoint.repositoryState.changedFiles
    }
    if ($null -ne $changedFilesNode) {
        if ($changedFilesNode -isnot [System.Collections.IEnumerable] -or ($changedFilesNode -is [string])) {
            throw 'Checkpoint blocked: repositoryState.changedFiles is not an array. (KEEP: old context retained.)'
        }
        $changedCount = @($changedFilesNode).Count
        if ($changedCount -gt $AihContextCheckpointMaxChangedFiles) {
            throw ('Checkpoint blocked: repositoryState.changedFiles holds ' + [string]$changedCount + ' entries, exceeding the ' + [string]$AihContextCheckpointMaxChangedFiles + '-entry V1 bound (too-many-changed-files). (KEEP: old context retained.)')
        }
    }
    return $checkpoint
}

function Get-AihContextCheckpointText {
    param([Parameter(Mandatory = $true)]$Checkpoint, [int]$MaxChars = 6000)
    $lines = [Collections.Generic.List[string]]::new()
    [void]$lines.Add(('<nexus-context-checkpoint task="' + [string]$Checkpoint.taskId + '" instance="' + [string]$Checkpoint.taskInstanceId + '" schema="' + [string]$Checkpoint.schemaVersion + '">'))
    [void]$lines.Add(('Task: ' + (ConvertTo-AihContextRedactedText -Text ([string]$Checkpoint.task.description) -MaxChars 4000)))
    [void]$lines.Add(('Status: ' + [string]$Checkpoint.task.status + ' · authority: deterministic-controller · engine: ' + [string]$Checkpoint.engine + ' · execution: ' + [string]$Checkpoint.executionClass))
    if ($null -ne $Checkpoint.task.acceptanceCriteria) {
        foreach ($criterion in @($Checkpoint.task.acceptanceCriteria)) { [void]$lines.Add(('Criterion: ' + (ConvertTo-AihContextRedactedText -Text ([string]$criterion) -MaxChars 500))) }
    }
    foreach ($outcome in @($Checkpoint.verification.outcomes)) {
        if ($null -eq $outcome) { continue }
        [void]$lines.Add(('Verify: ' + (ConvertTo-AihContextRedactedText -Text ([string]$outcome.name) -MaxChars 500) + ' [' + [string]$outcome.status + ']'))
    }
    foreach ($item in @($Checkpoint.verification.acceptanceEvidence)) {
        if ($null -eq $item) { continue }
        [void]$lines.Add(('Evidence: ' + (ConvertTo-AihContextRedactedText -Text ([string]$item.criterion) -MaxChars 500) + ' => ' + [string]$item.status))
    }
    if ($null -ne $Checkpoint.repositoryState.headCommit) { [void]$lines.Add(('HEAD: ' + [string]$Checkpoint.repositoryState.headCommit + ' · worktreeClean: ' + [string]$Checkpoint.repositoryState.worktreeClean)) }
    else { [void]$lines.Add('Repository: unknown (Git inspection unavailable · KEEP)') }
    foreach ($file in @($Checkpoint.repositoryState.changedFiles)) {
        if ($null -eq $file) { continue }
        [void]$lines.Add(('File: ' + (ConvertTo-AihContextRedactedText -Text ([string]$file.path) -MaxChars 500) + ' (' + [string]$file.status + ')'))
    }
    if ($null -ne $Checkpoint.continuity -and -not [string]::IsNullOrWhiteSpace([string]$Checkpoint.continuity.finalAssistantReport)) {
        [void]$lines.Add(('Final report: ' + (ConvertTo-AihContextRedactedText -Text ([string]$Checkpoint.continuity.finalAssistantReport) -MaxChars 4000)))
    }
    if ($null -ne $Checkpoint.continuity -and -not [string]::IsNullOrWhiteSpace([string]$Checkpoint.continuity.finalUserRequest)) {
        [void]$lines.Add(('Final request: ' + (ConvertTo-AihContextRedactedText -Text ([string]$Checkpoint.continuity.finalUserRequest) -MaxChars 2000)))
    }
    [void]$lines.Add('</nexus-context-checkpoint>')
    $text = [string]::Join("`n", $lines)
    if ($text.Length -gt $MaxChars) { $text = $text.Substring(0, $MaxChars) + '...<truncated>' }
    return $text
}

function Set-AihContextLifecycleTransition {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][ValidateSet('inactive', 'eligible', 'checkpoint-ready', 'apply-pending', 'awaiting-durability', 'applied', 'blocked')][string]$To,
        [string]$Reason = '',
        [string]$SessionId = '',
        [string]$CheckpointPath = $null
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $actualInstance = [string]$task.taskInstanceId
    $current = Read-AihContextLifecycleState -Workspace $Workspace -TaskId $TaskId
    $from = 'inactive'
    if (($null -ne $current) -and ($null -ne $current.PSObject.Properties['state'])) { $from = [string]$current.state }
    if (($null -ne $current) -and ($null -ne $current.PSObject.Properties['taskInstanceId']) -and (-not [string]::IsNullOrWhiteSpace([string]$current.taskInstanceId)) -and ([string]$current.taskInstanceId -ne $actualInstance)) {
        throw "Lifecycle refused: persisted state belongs to another generation. (KEEP.)"
    }
    # Legacy checkpoint-ready states (de34d52) carry NO frozen operation.
    # They must never flow into the new apply path: fail safe and require a
    # fresh freeze instead of reinterpreting them. The operation is read
    # lazily ONLY for apply-path targets: the blocked sink must stay
    # reachable even when the operation file is missing or corrupt.
    $operation = $null
    $hasFrozenOperation = $false
    if (($To -eq 'apply-pending') -or ($To -eq 'awaiting-durability') -or ($To -eq 'applied')) {
        try { $operation = Read-AihContextCompactionOperation -Workspace $Workspace -TaskId $TaskId } catch { throw }
        $hasFrozenOperation = ($null -ne $operation) -and ([string]$operation.taskInstanceId -eq $actualInstance)
    }
    $allowed = @{
        'inactive'            = @('eligible', 'blocked')
        'eligible'            = @('checkpoint-ready', 'blocked', 'eligible')
        'checkpoint-ready'    = @('apply-pending', 'blocked', 'checkpoint-ready')
        'apply-pending'       = @('awaiting-durability', 'blocked', 'apply-pending')
        'awaiting-durability' = @('applied', 'blocked', 'awaiting-durability')
        'applied'             = @('applied')
        'blocked'             = @('eligible', 'blocked')
    }
    if (-not (@($allowed[$from]) -contains $To)) {
        throw "Lifecycle refused: transition $from -> $To is not allowed. (KEEP.)"
    }
    if (($from -eq $To) -and (($To -eq 'eligible') -or ($To -eq 'checkpoint-ready') -or ($To -eq 'apply-pending') -or ($To -eq 'awaiting-durability') -or ($To -eq 'applied'))) {
        return [pscustomobject]$current
    }
    if (($To -eq 'eligible') -and ([string]$task.status -ne 'complete')) {
        throw "Lifecycle refused: task $TaskId is not controller-complete. (KEEP.)"
    }
    if ($To -eq 'checkpoint-ready') {
        $checkpoint = Read-AihContextCheckpoint -Workspace $Workspace -TaskId $TaskId -ExpectedTaskInstanceId $actualInstance
        if ($null -eq $checkpoint) { throw 'Lifecycle refused: valid checkpoint is required before checkpoint-ready. (KEEP.)' }
    }
    if (($To -eq 'apply-pending') -or ($To -eq 'awaiting-durability') -or ($To -eq 'applied')) {
        $checkpoint = Read-AihContextCheckpoint -Workspace $Workspace -TaskId $TaskId -ExpectedTaskInstanceId $actualInstance
        if ($null -eq $checkpoint) { throw 'Lifecycle refused: valid checkpoint is required before apply. (KEEP.)' }
        if (-not $hasFrozenOperation) {
            throw 'Lifecycle refused: checkpoint-ready without a frozen compaction operation cannot enter the apply path (legacy state). BLOCK/KEEP; require fresh freeze. (KEEP.)'
        }
        if ([string]$operation.sessionId -ne [string]$SessionId -and -not [string]::IsNullOrWhiteSpace([string]$SessionId)) {
            throw 'Lifecycle refused: frozen operation belongs to another session. (KEEP.)'
        }
    }
    $state = [ordered]@{
        schemaVersion = 1; taskId = $TaskId; taskInstanceId = $actualInstance
        state = [string]$To; previousState = [string]$from; reason = [string]$Reason
        sessionId = [string]$SessionId
        checkpointPath = $(if ($null -ne $CheckpointPath) { [string]$CheckpointPath } elseif (($null -ne $current) -and ($null -ne $current.PSObject.Properties['checkpointPath'])) { [string]$current.checkpointPath } else { $null })
        updatedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    Write-AihContextLifecycleState -Workspace $Workspace -TaskId $TaskId -State $state | Out-Null
    return [pscustomobject]$state
}

$AihContextOperationIdDomain = 'nexus/context-compaction-operation/v1'

function New-AihContextCompactionOperationId {
    # CANONICAL deterministic operation identity (the ONE derivation
    # authority; the JS helper mirrors it byte-for-byte, proven by the
    # parity test). Serialization: domain separator plus taskId plus
    # taskInstanceId plus sessionId, joined by LF, UTF-8, SHA-256 hex,
    # first 32 chars prefixed ccop_. Stable across retries/restarts.
    param([Parameter(Mandatory = $true)][string]$TaskId, [Parameter(Mandatory = $true)][string]$TaskInstanceId, [Parameter(Mandatory = $true)][string]$SessionId)
    $joined = [string]$AihContextOperationIdDomain + "`n" + [string]$TaskId + "`n" + [string]$TaskInstanceId + "`n" + [string]$SessionId
    $bytes = [Text.Encoding]::UTF8.GetBytes($joined)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return ('ccop_' + $digest.Substring(0, 32))
}

# ══════════════════════════════════════════════════════════════════════
# CCV2-A02 — durable multi-generation operation foundation (V2, PS authority).
#
# V1 functions above are UNCHANGED. V2 lives in an explicit separate domain:
# schemaVersion 2, operation-ID domain .../v2, and a separate persistence
# file (context-compaction-operation-v2.json). V1 stored operations are never
# reinterpreted as V2 (schema branching).
# ══════════════════════════════════════════════════════════════════════

$AihContextOperationIdDomainV2 = 'nexus/context-compaction-operation/v2'
$AihContextOperationV2SchemaVersion = 2
$AihContextOperationV2FileName = 'context-compaction-operation-v2.json'

function New-AihContextCompactionOperationIdV2 {
    # CANONICAL generation-aware V2 operation identity (derivation authority;
    # the JS twin deriveCanonicalOperationIdV2 mirrors it byte-for-byte,
    # proven by parity test). Serialization: domain LF taskId LF
    # taskInstanceId LF sessionId LF generation LF checkpointId, UTF-8,
    # SHA-256 hex, first 32 chars, ccop_ prefix.
    param([Parameter(Mandatory = $true)][string]$TaskId, [Parameter(Mandatory = $true)][string]$TaskInstanceId, [Parameter(Mandatory = $true)][string]$SessionId, [Parameter(Mandatory = $true)][int]$Generation, [Parameter(Mandatory = $true)][string]$CheckpointId)
    if ([int]$Generation -lt 1) { throw 'V2 operation identity refused: generation must be a positive integer. (KEEP.)' }
    if ([string]::IsNullOrWhiteSpace($CheckpointId)) { throw 'V2 operation identity refused: checkpointId is required. (KEEP.)' }
    $joined = [string]$AihContextOperationIdDomainV2 + "`n" + [string]$TaskId + "`n" + [string]$TaskInstanceId + "`n" + [string]$SessionId + "`n" + [string][int]$Generation + "`n" + [string]$CheckpointId
    $bytes = [Text.Encoding]::UTF8.GetBytes($joined)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return ('ccop_' + $digest.Substring(0, 32))
}

function New-AihContextContinuationAnchor {
    # Bounded identity-only continuation anchor (no payload of any kind).
    param([Parameter(Mandatory = $true)][string]$OperationId, [Parameter(Mandatory = $true)][int]$Generation, [Parameter(Mandatory = $true)][int]$SegmentIndex, [Parameter(Mandatory = $true)][int]$SegmentCount)
    if ([string]::IsNullOrWhiteSpace($OperationId) -or ($OperationId -match '["<>]')) { throw 'Continuation anchor refused: operationId must be a bounded identity token. (KEEP.)' }
    if (([int]$SegmentIndex -lt 0) -or ([int]$SegmentIndex -ge [int]$SegmentCount) -or ([int]$SegmentCount -lt 1)) { throw 'Continuation anchor refused: segment index out of range. (KEEP.)' }
    $oneBased = [int]$SegmentIndex + 1
    return ('<nexus-context-continuation operation="' + [string]$OperationId + '" generation="' + [string][int]$Generation + '" segment="' + [string]$oneBased + '/' + [string][int]$SegmentCount + '"/>')
}

function Get-AihContextOperationV2Path {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $layout = Get-AihLedgerLayout $Workspace
    return (Join-Path (Join-Path $layout.Runs $TaskId) $AihContextOperationV2FileName)
}

function Read-AihContextCompactionOperationV2 {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $opPath = Get-AihContextOperationV2Path -Workspace $Workspace -TaskId $TaskId
    if (-not (Test-Path -LiteralPath $opPath)) { return $null }
    try { $parsed = Get-Content -Raw -Encoding UTF8 -LiteralPath $opPath | ConvertFrom-Json }
    catch { throw 'Compaction operation V2 blocked: context-compaction-operation-v2.json is malformed. (KEEP: old context retained.)' }
    if (($null -eq $parsed) -or ([int]$parsed.schemaVersion -ne [int]$AihContextOperationV2SchemaVersion)) {
        throw 'Compaction operation V2 blocked: stored record is not a V2 operation. (KEEP: old context retained.)'
    }
    return $parsed
}

function Test-AihContextCompactionOperationV2 {
    # Closed-world V2 validation (JS twin: validateCompactionOperationV2).
    # Any failure returns valid=false (BLOCK/KEEP) before any mutation.
    param(
        [Parameter(Mandatory = $true)]$Operation,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][string]$Workspace,
        [string]$CheckpointId = $null,
        [int]$CheckpointGeneration = -1,
        [string]$RepositoryId = $null,
        [string]$CheckoutId = $null
    )
    $fail = { param([string]$Reason) return [pscustomobject][ordered]@{ valid = $false; reason = $Reason } }
    if ($null -eq $Operation) { return (& $fail 'operation-missing') }
    # A05H H1: exact-key validation (JS twin: OPERATION_V2_EXACT_KEYS).
    # Unknown protocol fields FAIL CLOSED here, before any value check, so a
    # recomputed operationId can never legalize an unknown schema field.
    # Handles both pscustomobject (post-read-back) and Hashtable
    # (pre-persist draft): Hashtables do not expose entries through
    # PSObject.Properties.
    $operationV2Keys = @('schemaVersion','operationId','attemptId','taskId','taskInstanceId','sessionId','workspace','repositoryId','checkoutId','checkpointGeneration','checkpointId','checkpointContentDigest','checkpointPath','snapshotTokenId','safePointBoundarySeq','sourceEventSeqs','segments','lifecycle','createdAtUtc')
    $operationKeyNames = @()
    if ($Operation -is [Collections.IDictionary]) { $operationKeyNames = @($Operation.Keys | ForEach-Object { [string]$_ }) }
    else { $operationKeyNames = @($Operation.PSObject.Properties | ForEach-Object { $_.Name }) }
    foreach ($operationKeyName in $operationKeyNames) {
        if ($operationV2Keys -notcontains $operationKeyName) { return (& $fail 'operation-schema-mismatch') }
    }
    if ([int]$Operation.schemaVersion -ne [int]$AihContextOperationV2SchemaVersion) { return (& $fail 'operation-schema-mismatch') }
    if ([string]::IsNullOrWhiteSpace([string]$Operation.operationId)) { return (& $fail 'operation-id-missing') }
    if ([string]::IsNullOrWhiteSpace([string]$Operation.attemptId)) { return (& $fail 'attempt-id-missing') }
    if ([string]$Operation.taskId -ne [string]$TaskId) { return (& $fail 'task-id-mismatch') }
    if ([string]::IsNullOrWhiteSpace([string]$Operation.taskInstanceId) -or ([string]$Operation.taskInstanceId -ne [string]$TaskInstanceId)) { return (& $fail 'task-instance-mismatch') }
    if ([string]::IsNullOrWhiteSpace([string]$Operation.sessionId) -or ([string]$Operation.sessionId -ne [string]$SessionId)) { return (& $fail 'session-id-mismatch') }
    if ([string]::IsNullOrWhiteSpace([string]$Operation.workspace) -or ([string]$Operation.workspace -ne [string]$Workspace)) { return (& $fail 'workspace-mismatch') }
    if ((-not [string]::IsNullOrWhiteSpace($RepositoryId)) -and ([string]$Operation.repositoryId -ne [string]$RepositoryId)) { return (& $fail 'repository-id-mismatch') }
    if ((-not [string]::IsNullOrWhiteSpace($CheckoutId)) -and ([string]$Operation.checkoutId -ne [string]$CheckoutId)) { return (& $fail 'checkout-id-mismatch') }
    if ([int]$Operation.checkpointGeneration -lt 1) { return (& $fail 'checkpoint-generation-invalid') }
    if ([string]::IsNullOrWhiteSpace([string]$Operation.checkpointId)) { return (& $fail 'checkpoint-identity-missing') }
    if (([int]$CheckpointGeneration -ge 1) -and ([int]$Operation.checkpointGeneration -ne [int]$CheckpointGeneration)) { return (& $fail 'checkpoint-generation-mismatch') }
    if ((-not [string]::IsNullOrWhiteSpace($CheckpointId)) -and ([string]$Operation.checkpointId -ne [string]$CheckpointId)) { return (& $fail 'checkpoint-identity-mismatch') }
    $expectedId = $null
    try { $expectedId = New-AihContextCompactionOperationIdV2 -TaskId $TaskId -TaskInstanceId ([string]$Operation.taskInstanceId) -SessionId $SessionId -Generation ([int]$Operation.checkpointGeneration) -CheckpointId ([string]$Operation.checkpointId) }
    catch { return (& $fail 'operation-id-derivation-failed') }
    if ([string]$Operation.operationId -ne [string]$expectedId) { return (& $fail 'operation-id-mismatch') }
    if (($null -ne $Operation.PSObject.Properties['snapshotTokenId']) -and ($null -ne $Operation.snapshotTokenId) -and ([string]::IsNullOrWhiteSpace([string]$Operation.snapshotTokenId))) { return (& $fail 'snapshot-token-invalid') }
    if ([int]$Operation.safePointBoundarySeq -lt 0) { return (& $fail 'safe-point-boundary-missing') }
    $seqs = @($Operation.sourceEventSeqs)
    if ($seqs.Count -eq 0) { return (& $fail 'source-seqs-missing') }
    $seen = [Collections.Generic.HashSet[int]]::new()
    $prev = -1
    foreach ($seq in $seqs) {
        if ([int]$seq -lt 0) { return (& $fail 'source-seq-malformed') }
        if (-not $seen.Add([int]$seq)) { return (& $fail 'source-seqs-duplicate') }
        if ([int]$seq -le $prev) { return (& $fail 'source-seqs-unordered') }
        if ([int]$seq -gt [int]$Operation.safePointBoundarySeq) { return (& $fail 'source-seq-beyond-safe-point-boundary') }
        $prev = [int]$seq
    }
    $segments = @($Operation.segments)
    if ($segments.Count -eq 0) { return (& $fail 'segments-missing') }
    $payloadCount = 0
    $flat = [Collections.Generic.List[int]]::new()
    foreach ($segment in $segments) {
        if ($null -eq $segment) { return (& $fail 'segment-malformed') }
        # A05H H1: segments are exact-key validated (JS twin:
        # OPERATION_V2_SEGMENT_EXACT_KEYS). Unknown segment fields FAIL CLOSED.
        $segmentV2Keys = @('start','end','sourceEventSeqs','role')
        $segmentKeyNames = @()
        if ($segment -is [Collections.IDictionary]) { $segmentKeyNames = @($segment.Keys | ForEach-Object { [string]$_ }) }
        else { $segmentKeyNames = @($segment.PSObject.Properties | ForEach-Object { $_.Name }) }
        foreach ($segmentKeyName in $segmentKeyNames) {
            if ($segmentV2Keys -notcontains $segmentKeyName) { return (& $fail 'operation-schema-mismatch') }
        }
        # Role presence must work for both pscustomobject (post-read-back)
        # and Hashtable (pre-persist draft): Hashtables do not expose entries
        # through PSObject.Properties.
        $rolePresent = $false
        if ($segment -is [Collections.IDictionary]) { $rolePresent = $segment.Contains('role') }
        else { $rolePresent = ($null -ne $segment.PSObject.Properties['role']) }
        if (-not $rolePresent) { return (& $fail 'segment-role-missing') }
        if (($null -eq $segment.start) -or ($null -eq $segment.end) -or ($null -eq $segment.sourceEventSeqs)) {
            return (& $fail 'segment-malformed')
        }
        if ([string]$segment.role -ne 'payload' -and [string]$segment.role -ne 'continuation') { return (& $fail 'segment-role-unknown') }
        if ([string]$segment.role -eq 'payload') { $payloadCount++ }
        $sseqs = @($segment.sourceEventSeqs)
        if ($sseqs.Count -eq 0) { return (& $fail 'segment-seqs-missing') }
        if (([int]$segment.start -ne [int]$sseqs[0]) -or ([int]$segment.end -ne [int]$sseqs[-1])) { return (& $fail 'segment-endpoint-mismatch') }
        foreach ($seq in $sseqs) {
            if ([int]$seq -lt 0) { return (& $fail 'segment-seq-malformed') }
            [void]$flat.Add([int]$seq)
        }
    }
    if ([int]$payloadCount -eq 0) { return (& $fail 'payload-segment-missing') }
    if ([int]$payloadCount -gt 1) { return (& $fail 'payload-segment-duplicate') }
    # Canonical segment order: strictly ascending by start seq (deterministic
    # frozen form; multi-generation surfaces interleave seqs, so segments are
    # surface-application runs listed in start order). JS twin:
    # validateCompactionOperationV2.
    $previousStart = -1
    foreach ($segment in $segments) {
        if ([int]$segment.start -le $previousStart) { return (& $fail 'segments-unordered') }
        $previousStart = [int]$segment.start
    }
    # Non-overlap: segment source sets are pairwise disjoint (set partition).
    $seen = [Collections.Generic.HashSet[int]]::new()
    foreach ($segment in $segments) {
        foreach ($seq in @($segment.sourceEventSeqs)) {
            if (-not $seen.Add([int]$seq)) { return (& $fail 'segment-overlap') }
        }
    }
    # Exact coverage: the union multiset, ascending-sorted, equals the frozen
    # sourceEventSeqs.
    $sortedUnion = @([int[]]$flat.ToArray() | Sort-Object)
    if ([int]$sortedUnion.Count -ne $seqs.Count) { return (& $fail 'segment-union-mismatch') }
    for ($i = 0; $i -lt $seqs.Count; $i++) { if ([int]$sortedUnion[$i] -ne [int]$seqs[$i]) { return (& $fail 'segment-union-mismatch') } }
    foreach ($segment in $segments) {
        foreach ($seq in @($segment.sourceEventSeqs)) {
            if ([int]$seq -gt [int]$Operation.safePointBoundarySeq) { return (& $fail 'source-seq-beyond-safe-point-boundary') }
        }
    }
    $lifecycle = [string]$Operation.lifecycle
    if ($lifecycle -ne 'frozen' -and $lifecycle -ne 'applying' -and $lifecycle -ne 'awaiting-durability' -and $lifecycle -ne 'applied' -and $lifecycle -ne 'blocked') { return (& $fail 'lifecycle-invalid') }
    return [pscustomobject][ordered]@{ valid = $true; reason = $null }
}

function Assert-AihCcv2DurableMutationAllowed {
    # Fixed source-level restriction; no environment or payload opt-in.
    throw 'ccv2-durable-mutation-disabled: active durable CCv2 is unavailable until mutation-time fencing is verified'
}

function New-AihContextCompactionOperationV2 {
    # Freeze ONE immutable V2 application plan: construct → validate → atomic
    # persist → read-back proof. Retry reuses the frozen plan verbatim (never
    # re-plans/widens). Any failure throws (KEEP) before any mutation.
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][int]$CheckpointGeneration,
        [Parameter(Mandatory = $true)][string]$CheckpointId,
        [Parameter(Mandatory = $true)][string]$AttemptId,
        [Parameter(Mandatory = $true)][int]$SafePointBoundarySeq,
        [Parameter(Mandatory = $true)][int[]]$SourceEventSeqs,
        [Parameter(Mandatory = $true)][object[]]$Segments,
        [Parameter(Mandatory = $true)][string]$CheckpointContentDigest,
        [Parameter(Mandatory = $true)][string]$Lifecycle,
        [string]$CheckpointPath = $null,
        [string]$SnapshotTokenId = $null,
        [string]$RepositoryId = $null,
        [string]$CheckoutId = $null
    )
    Assert-AihCcv2DurableMutationAllowed
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ([string]$task.status -ne 'complete') { throw "Operation V2 refused: task $TaskId status is '$($task.status)', not complete. (KEEP.)" }
    $operationId = New-AihContextCompactionOperationIdV2 -TaskId $TaskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId $SessionId -Generation ([int]$CheckpointGeneration) -CheckpointId $CheckpointId
    $existing = $null
    try { $existing = Read-AihContextCompactionOperationV2 -Workspace $Workspace -TaskId $TaskId } catch { throw }
    if (($null -ne $existing) -and ([string]$existing.taskInstanceId -eq [string]$task.taskInstanceId) -and ([string]$existing.operationId -eq [string]$operationId)) {
        return [pscustomobject]$existing
    }
    if (($null -ne $existing) -and ([string]$existing.taskInstanceId -eq [string]$task.taskInstanceId) -and ([string]$existing.operationId -ne [string]$operationId)) {
        throw 'Operation V2 refused: a different frozen operation already owns this generation. (KEEP: never adopt or widen.)'
    }
    $segmentRecords = @()
    foreach ($segment in @($Segments)) {
        if (($null -eq $segment) -or ($null -eq $segment.start) -or ($null -eq $segment.end) -or ($null -eq $segment.sourceEventSeqs) -or ($null -eq $segment.role)) {
            throw 'Operation V2 refused: malformed frozen segment (role is required). (KEEP.)'
        }
        if ([string]$segment.role -ne 'payload' -and [string]$segment.role -ne 'continuation') {
            throw 'Operation V2 refused: unknown frozen segment role. (KEEP.)'
        }
        $segmentRecords += [ordered]@{ start = [int]$segment.start; end = [int]$segment.end; sourceEventSeqs = @([int[]]$segment.sourceEventSeqs); role = [string]$segment.role }
    }
    $operation = [ordered]@{
        schemaVersion = [int]$AihContextOperationV2SchemaVersion
        operationId = [string]$operationId
        attemptId = [string]$AttemptId
        taskId = [string]$TaskId
        taskInstanceId = [string]$task.taskInstanceId
        sessionId = [string]$SessionId
        checkpointId = [string]$CheckpointId
        checkpointGeneration = [int]$CheckpointGeneration
        checkpointContentDigest = [string]$CheckpointContentDigest
        checkpointPath = $(if ([string]::IsNullOrWhiteSpace($CheckpointPath)) { $null } else { [string]$CheckpointPath })
        snapshotTokenId = $(if ([string]::IsNullOrWhiteSpace($SnapshotTokenId)) { $null } else { [string]$SnapshotTokenId })
        safePointBoundarySeq = [int]$SafePointBoundarySeq
        sourceEventSeqs = @([int[]]$SourceEventSeqs)
        segments = @($segmentRecords)
        lifecycle = [string]$Lifecycle
        workspace = [string]$Workspace
        repositoryId = $(if ([string]::IsNullOrWhiteSpace($RepositoryId)) { $null } else { [string]$RepositoryId })
        checkoutId = $(if ([string]::IsNullOrWhiteSpace($CheckoutId)) { $null } else { [string]$CheckoutId })
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    $check = Test-AihContextCompactionOperationV2 -Operation ([pscustomobject]$operation) -TaskId $TaskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId $SessionId -Workspace $Workspace -CheckpointId $CheckpointId -CheckpointGeneration ([int]$CheckpointGeneration) -RepositoryId $RepositoryId -CheckoutId $CheckoutId
    if (-not [bool]$check.valid) { throw ('Operation V2 refused: ' + [string]$check.reason + '. (KEEP.)') }
    $opPath = Get-AihContextOperationV2Path -Workspace $Workspace -TaskId $TaskId
    Write-AihAtomicJson $opPath $operation
    $readBack = Read-AihContextCompactionOperationV2 -Workspace $Workspace -TaskId $TaskId
    if (($null -eq $readBack) -or ([string]$readBack.operationId -ne [string]$operationId)) {
        throw 'Operation V2 refused: read-back validation failed after atomic write. (KEEP.)'
    }
    $recheck = Test-AihContextCompactionOperationV2 -Operation $readBack -TaskId $TaskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId $SessionId -Workspace $Workspace -CheckpointId $CheckpointId -CheckpointGeneration ([int]$CheckpointGeneration) -RepositoryId $RepositoryId -CheckoutId $CheckoutId
    if (-not [bool]$recheck.valid) { throw ('Operation V2 refused: read-back invalid (' + [string]$recheck.reason + '). (KEEP.)') }
    return [pscustomobject]$readBack
}

# ══════════════════════════════════════════════════════════════════════
# CCV2-A03 — Checkpoint Schema V2 identity parity (PS authority).
#
# V1 checkpoint files (context-checkpoint.json, schemaVersion 1) are
# UNCHANGED. V2 checkpoints persist separately under
# context-checkpoints/cp-NNNNNN.json with schemaVersion 2 and are never
# reinterpreted as V1 (explicit schema branching).
#
# Canonical formulas (JS twins in config/ContextCheckpointV2.cjs;
# proven byte-for-byte by the A03 parity test):
#   contentDigest = sha256Hex(UTF-8(canonical payload bytes))
#   checkpointId  = 'ccp_' + sha256Hex(domain LF taskId LF taskInstanceId
#                   LF sessionId LF generation LF contentDigest)[0..32)
# ══════════════════════════════════════════════════════════════════════

$AihContextCheckpointV2SchemaVersion = 2
$AihContextCheckpointIdDomainV2 = 'nexus/context-checkpoint/v2'
$AihContextCheckpointV2DirName = 'context-checkpoints'
$AihContextCheckpointV2FilePrefix = 'cp-'

function Get-AihContextCheckpointDigestV2 {
    # SHA-256 hex (lowercase) over the exact UTF-8 bytes of the supplied
    # canonical payload text. JS twin: sha256HexUtf8.
    param([Parameter(Mandatory = $true)][string]$Text)
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$Text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return $digest
}

function New-AihContextCheckpointIdV2 {
    # Canonical deterministic V2 checkpoint identity (derivation authority;
    # the JS twin deriveCheckpointIdV2 mirrors it byte-for-byte).
    param(
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][int]$Generation,
        [Parameter(Mandatory = $true)][string]$ContentDigest
    )
    if ([int]$Generation -lt 1) { throw 'V2 checkpoint identity refused: generation must be a positive integer. (KEEP.)' }
    if ([string]$ContentDigest -notmatch '^[0-9a-f]{64}$') { throw 'V2 checkpoint identity refused: contentDigest must be sha256 hex. (KEEP.)' }
    $joined = [string]$AihContextCheckpointIdDomainV2 + "`n" + [string]$TaskId + "`n" + [string]$TaskInstanceId + "`n" + [string]$SessionId + "`n" + [string][int]$Generation + "`n" + [string]$ContentDigest
    $bytes = [Text.Encoding]::UTF8.GetBytes($joined)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return ('ccp_' + $digest.Substring(0, 32))
}

function Get-AihContextCheckpointV2FileName {
    param([Parameter(Mandatory = $true)][int]$Generation)
    if ([int]$Generation -lt 1) { throw 'V2 checkpoint path refused: generation must be a positive integer. (KEEP.)' }
    return ($AihContextCheckpointV2FilePrefix + ([string][int]$Generation).PadLeft(6, '0') + '.json')
}

function Get-AihContextCheckpointV2Path {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId, [Parameter(Mandatory = $true)][int]$Generation)
    $layout = Get-AihLedgerLayout $Workspace
    return (Join-Path (Join-Path (Join-Path $layout.Runs $TaskId) $AihContextCheckpointV2DirName) (Get-AihContextCheckpointV2FileName -Generation ([int]$Generation)))
}

# CCV2-A04 — Trust Provenance & Content Seal parity (PS authority).
#
# V1 checkpoint/operation functions above are UNCHANGED. Trust derivation
# (sourceKind -> trust class) lives in config/ContextTrustV2.cjs (JS
# authority); the PS twins below cover seal construction + validation
# (field binding AND the A04R seal-record digest).
# Canonical seal shape (JS twin: sealCheckpoint in config/ContextTrustV2.cjs):
#   { schemaVersion: 1, checkpointId, checkpointContentDigest (sha256 hex),
#     generation, taskId, taskInstanceId, sessionId, sealedAtUtc (ISO UTC),
#     algorithm: 'sha256', sealDigest (sha256 hex) }
# Frozen seal-record digest (JS twin: deriveSealDigestV1):
#   sealDigest = sha256Hex(UTF-8('nexus/context-content-seal/v1' LF
#                                canonicalJson(seal excluding sealDigest)))
# where canonicalJson sorts object keys ordinally (recursive) and keeps
# array order — byte-identical to the JS repository canonicalizer.
# ══════════════════════════════════════════════════════════════════════

$AihContextContentSealSchemaVersion = 1
$AihContextContentSealAlgorithm = 'sha256'
$AihContextContentSealDigestDomainV1 = 'nexus/context-content-seal/v1'

function ConvertTo-AihJsonEscapedString {
    # JSON string escaping with JS JSON.stringify semantics: quote,
    # backslash, \b \f \n \r \t, and \u00XX (lowercase hex) for other
    # controls below 0x20. All other characters (including non-ASCII and
    # surrogate pairs) pass through verbatim in UTF-8.
    param([Parameter(Mandatory = $true)][string]$Text)
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in ([string]$Text).ToCharArray()) {
        $code = [int]$ch
        if ($code -eq 34) { [void]$sb.Append('\"'); }
        elseif ($code -eq 92) { [void]$sb.Append('\\'); }
        elseif ($code -eq 8) { [void]$sb.Append('\b'); }
        elseif ($code -eq 12) { [void]$sb.Append('\f'); }
        elseif ($code -eq 10) { [void]$sb.Append('\n'); }
        elseif ($code -eq 13) { [void]$sb.Append('\r'); }
        elseif ($code -eq 9) { [void]$sb.Append('\t'); }
        elseif ($code -lt 32) { [void]$sb.Append(('\u{0:x4}' -f $code)); }
        else { [void]$sb.Append($ch); }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function ConvertTo-AihCanonicalJson {
    # Deterministic canonical JSON (JS twin: canonicalize +
    # JSON.stringify in config/ContextCheckpointV2.cjs): plain objects and
    # dictionaries serialize with ordinally sorted keys (recursive); arrays
    # keep author order; no whitespace.
    param($Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [string]) { return (ConvertTo-AihJsonEscapedString -Text ([string]$Value)) }
    if ($Value -is [datetime]) {
        # ConvertFrom-Json parses ISO-8601 timestamps into DateTime objects
        # (whose .Date/.TimeOfDay graph would recurse forever). Sealed
        # timestamps use canonical millisecond-precision UTC form, so format
        # back to that exact lexical shape (JS twin hashes the raw string).
        $utc = ([datetime]$Value).ToUniversalTime()
        return (ConvertTo-AihJsonEscapedString -Text ($utc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)))
    }
    if ($Value -is [bool]) {
        if ([bool]$Value) { return 'true' }
        return 'false'
    }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) {
        return ([string]$Value.ToString([Globalization.CultureInfo]::InvariantCulture))
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $keys = @($Value.Keys | ForEach-Object { [string]$_ })
        $sorted = New-Object 'System.Collections.Generic.List[string]'
        foreach ($k in $keys) { [void]$sorted.Add($k) }
        $sorted.Sort([StringComparer]::Ordinal)
        $parts = @()
        foreach ($k in $sorted) { $parts += @((ConvertTo-AihJsonEscapedString -Text $k) + ':' + (ConvertTo-AihCanonicalJson -Value $Value[$k])) }
        return ('{' + ($parts -join ',') + '}')
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $parts = @()
        foreach ($entry in $Value) { $parts += @(ConvertTo-AihCanonicalJson -Value $entry) }
        return ('[' + ($parts -join ',') + ']')
    }
    $props = @($Value.PSObject.Properties | Where-Object { $null -ne $_.Name } | ForEach-Object { [string]$_.Name })
    $sorted = New-Object 'System.Collections.Generic.List[string]'
    foreach ($k in $props) { [void]$sorted.Add($k) }
    $sorted.Sort([StringComparer]::Ordinal)
    $parts = @()
    foreach ($k in $sorted) { $parts += @((ConvertTo-AihJsonEscapedString -Text $k) + ':' + (ConvertTo-AihCanonicalJson -Value $Value.$k)) }
    return ('{' + ($parts -join ',') + '}')
}

function Get-AihContextContentSealDigestV2 {
    # Domain-separated seal-record digest over the seal body (the seal
    # excluding sealDigest). JS twin: deriveSealDigestV1.
    param([Parameter(Mandatory = $true)]$SealBody)
    $body = @{}
    foreach ($prop in @($SealBody.PSObject.Properties)) {
        if ([string]$prop.Name -eq 'sealDigest') { continue }
        $body[[string]$prop.Name] = $prop.Value
    }
    if ($SealBody -is [System.Collections.IDictionary]) {
        $body = @{}
        foreach ($key in @($SealBody.Keys)) {
            if ([string]$key -eq 'sealDigest') { continue }
            $body[[string]$key] = $SealBody[$key]
        }
    }
    $bodyJson = ConvertTo-AihCanonicalJson -Value $body
    $joined = [string]$AihContextContentSealDigestDomainV1 + "`n" + $bodyJson
    $bytes = [Text.Encoding]::UTF8.GetBytes($joined)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return $digest
}


function New-AihContextContentSealV2 {
    # Mint the authoritative seal for one finalized checkpoint. sealedAtUtc is
    # an explicit caller input (determinism: no clock reads inside).
    # JS twin: sealCheckpoint.
    param(
        [Parameter(Mandatory = $true)][string]$CheckpointId,
        [Parameter(Mandatory = $true)][string]$ContentDigest,
        [Parameter(Mandatory = $true)][int]$Generation,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][string]$SealedAtUtc
    )
    if ([string]::IsNullOrWhiteSpace($CheckpointId)) { throw 'V2 content seal refused: checkpointId is required. (KEEP.)' }
    if ([string]$ContentDigest -notmatch '^[0-9a-f]{64}$') { throw 'V2 content seal refused: contentDigest must be sha256 hex. (KEEP.)' }
    if ([int]$Generation -lt 1) { throw 'V2 content seal refused: generation must be a positive integer. (KEEP.)' }
    if ([string]::IsNullOrWhiteSpace($TaskId)) { throw 'V2 content seal refused: taskId is required. (KEEP.)' }
    if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) { throw 'V2 content seal refused: taskInstanceId is required. (KEEP.)' }
    if ([string]::IsNullOrWhiteSpace($SessionId)) { throw 'V2 content seal refused: sessionId is required. (KEEP.)' }
    try { $null = [DateTime]::Parse([string]$SealedAtUtc) } catch { throw 'V2 content seal refused: sealedAtUtc must be explicit ISO-8601 UTC input. (KEEP.)' }
    $body = [pscustomobject]@{
        schemaVersion           = [int]$AihContextContentSealSchemaVersion
        checkpointId            = [string]$CheckpointId
        checkpointContentDigest = [string]$ContentDigest
        generation              = [int]$Generation
        taskId                  = [string]$TaskId
        taskInstanceId          = [string]$TaskInstanceId
        sessionId               = [string]$SessionId
        sealedAtUtc             = [string]$SealedAtUtc
        algorithm               = [string]$AihContextContentSealAlgorithm
    }
    $sealDigest = Get-AihContextContentSealDigestV2 -SealBody $body
    return [pscustomobject]@{
        schemaVersion           = [int]$body.schemaVersion
        checkpointId            = [string]$body.checkpointId
        checkpointContentDigest = [string]$body.checkpointContentDigest
        generation              = [int]$body.generation
        taskId                  = [string]$body.taskId
        taskInstanceId          = [string]$body.taskInstanceId
        sessionId               = [string]$body.sessionId
        sealedAtUtc             = [string]$body.sealedAtUtc
        algorithm               = [string]$body.algorithm
        sealDigest              = [string]$sealDigest
    }
}

function Test-AihContextContentSealV2 {
    # Validate one seal against its checkpoint identity legs. Any mismatch
    # BLOCKS with a stable reason code (JS twin: validateContentSeal).
    param(
        [Parameter(Mandatory = $true)]$Seal,
        [Parameter(Mandatory = $true)][string]$CheckpointId,
        [Parameter(Mandatory = $true)][string]$ContentDigest,
        [Parameter(Mandatory = $true)][int]$Generation,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][string]$SessionId
    )
    $fail = { param($reason) return @{ valid = $false; reason = [string]$reason } }
    if ($null -eq $Seal) { return (& $fail 'checkpoint-seal-missing') }
    if ([int]$Seal.schemaVersion -ne [int]$AihContextContentSealSchemaVersion) { return (& $fail 'checkpoint-seal-invalid') }
    if ([string]$Seal.algorithm -ne [string]$AihContextContentSealAlgorithm) { return (& $fail 'checkpoint-seal-invalid') }
    try { $null = [DateTime]::Parse([string]$Seal.sealedAtUtc) } catch { return (& $fail 'checkpoint-seal-invalid') }
    if ([string]$Seal.sealDigest -notmatch '^[0-9a-f]{64}$') { return (& $fail 'checkpoint-seal-invalid') }
    if ([string]$Seal.checkpointId -ne [string]$CheckpointId) { return (& $fail 'checkpoint-seal-id-mismatch') }
    if ([string]$Seal.checkpointContentDigest -ne [string]$ContentDigest) { return (& $fail 'checkpoint-seal-digest-mismatch') }
    if ([int]$Seal.generation -ne [int]$Generation) { return (& $fail 'checkpoint-seal-generation-mismatch') }
    if ([string]$Seal.taskId -ne [string]$TaskId) { return (& $fail 'checkpoint-seal-invalid') }
    if ([string]$Seal.taskInstanceId -ne [string]$TaskInstanceId) { return (& $fail 'checkpoint-seal-invalid') }
    if ([string]$Seal.sessionId -ne [string]$SessionId) { return (& $fail 'checkpoint-seal-invalid') }
    $expected = Get-AihContextContentSealDigestV2 -SealBody $Seal
    if ([string]$Seal.sealDigest -ne [string]$expected) { return (& $fail 'checkpoint-seal-record-digest-mismatch') }
    return @{ valid = $true; reason = $null }
}

# ══════════════════════════════════════════════════════════════════════
# CCV2-A05 — ContextSnapshotToken identity parity (PS authority).
#
# SnapshotManager (config/ContextSnapshotV2.cjs) owns capture/derivation/
# revalidation in JS. The PS twins below cover ONLY the two duplicated
# identity formulas; PS never mints tokens (no capture/validation here).
# Canonical formulas (JS twins: deriveRevisionDigest / deriveSnapshotTokenId):
#   revisionDigest = sha256Hex(UTF-8('nexus/context-snapshot-revision/v1' LF
#                              canonicalJson(revisionBody)))
#   snapshotTokenId = 'cst_' + sha256Hex(UTF-8(
#                       'nexus/context-snapshot-token/v1' LF taskId LF
#                       taskInstanceId LF sessionId LF generation LF
#                       revisionDigest))[0..32)
# canonicalJson is ConvertTo-AihCanonicalJson (ordinally sorted keys,
# recursive; arrays keep order) — byte-identical to the JS canonicalizer.
# ══════════════════════════════════════════════════════════════════════

$AihContextSnapshotRevisionDigestDomainV1 = 'nexus/context-snapshot-revision/v1'
$AihContextSnapshotTokenIdDomainV1 = 'nexus/context-snapshot-token/v1'

function Get-AihContextSnapshotRevisionDigestV2 {
    # Domain-separated revision digest over canonical revision-body bytes.
    # Pass the canonical JSON text (preferred: built with
    # ConvertTo-AihCanonicalJson -Value $RevisionBody) so the hash input is
    # byte-exact. JS twin: deriveRevisionDigest.
    param([Parameter(Mandatory = $true)][string]$RevisionBodyJson)
    $joined = [string]$AihContextSnapshotRevisionDigestDomainV1 + "`n" + [string]$RevisionBodyJson
    $bytes = [Text.Encoding]::UTF8.GetBytes($joined)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return $digest
}

function New-AihContextSnapshotTokenIdV2 {
    # Deterministic generation-bound token identity. JS twin:
    # deriveSnapshotTokenId in config/ContextSnapshotV2.cjs.
    param(
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][int]$Generation,
        [Parameter(Mandatory = $true)][string]$RevisionDigest
    )
    if ([int]$Generation -lt 1) { throw 'V2 snapshot token refused: generation must be a positive integer. (KEEP.)' }
    if ([string]$RevisionDigest -notmatch '^[0-9a-f]{64}$') { throw 'V2 snapshot token refused: revisionDigest must be sha256 hex. (KEEP.)' }
    $joined = [string]$AihContextSnapshotTokenIdDomainV1 + "`n" + [string]$TaskId + "`n" + [string]$TaskInstanceId + "`n" + [string]$SessionId + "`n" + [string][int]$Generation + "`n" + [string]$RevisionDigest
    $bytes = [Text.Encoding]::UTF8.GetBytes($joined)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return ('cst_' + $digest.Substring(0, 32))
}

function Read-AihContextCompactionOperation {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    if (-not (Test-Path -LiteralPath $paths.Operation)) { return $null }
    try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $paths.Operation | ConvertFrom-Json }
    catch { throw 'Compaction operation blocked: context-compaction-operation.json is malformed. (KEEP: old context retained.)' }
}

function New-AihContextCompactionOperation {
    # Freeze ONE immutable application plan for the completed generation.
    # The caller supplies the ALREADY-VALIDATED balanced cut (computed once
    # from the completion-time surface); this function persists it verbatim
    # and NEVER widens it. Retry reuses the frozen boundary exactly.
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][int]$ReplacementStart,
        [Parameter(Mandatory = $true)][int[]]$SourceEventSeqs,
        [Parameter(Mandatory = $true)][int]$ReplacementEnd,
        [string]$CheckpointPath = $null,
        [object[]]$Segments = @(),
        [int]$CompletionBoundarySeq = -1,
        [string]$RepositoryId = $null,
        [string]$CheckoutId = $null
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ([string]$task.status -ne 'complete') { throw "Operation refused: task $TaskId status is '$($task.status)', not complete. (KEEP.)" }
    $operationId = New-AihContextCompactionOperationId -TaskId $TaskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId $SessionId
    $existing = $null
    try { $existing = Read-AihContextCompactionOperation -Workspace $Workspace -TaskId $TaskId } catch { throw }
    if (($null -ne $existing) -and ([string]$existing.taskInstanceId -eq [string]$task.taskInstanceId) -and ([string]$existing.operationId -eq $operationId)) {
        # Idempotent retry: the frozen boundary is returned verbatim even when
        # the caller recomputed a wider candidate range. Retry never widens.
        return [pscustomobject]$existing
    }
    if ((@($SourceEventSeqs).Count -eq 0) -or ([int]$ReplacementStart -lt 0) -or ([int]$ReplacementEnd -lt 0)) {
        throw 'Operation refused: empty replacement boundary. (KEEP.)'
    }
    if ([int]$SourceEventSeqs[0] -ne [int]$ReplacementStart -or [int]$SourceEventSeqs[-1] -ne [int]$ReplacementEnd) {
        throw 'Operation refused: range must match the first and last source seqs. (KEEP.)'
    }
    if ([int]$CompletionBoundarySeq -lt 0) {
        throw 'Operation refused: completionBoundarySeq is required (Task A ownership cap). (KEEP.)'
    }
    $sortedCheck = @([int[]]$SourceEventSeqs | Sort-Object -Unique)
    if ([int]$sortedCheck.Count -ne [int]@($SourceEventSeqs).Count) {
        throw 'Operation refused: duplicate sourceEventSeqs. (KEEP.)'
    }
    foreach ($seq in @($SourceEventSeqs)) {
        if ([int]$seq -gt [int]$CompletionBoundarySeq) {
            throw 'Operation refused: source seq newer than completionBoundarySeq (Task B adoption). (KEEP.)'
        }
    }
    if (($null -ne $existing) -and ([string]$existing.taskInstanceId -eq [string]$task.taskInstanceId) -and ([string]$existing.operationId -ne $operationId)) {
        throw 'Operation refused: a different frozen operation already owns this generation. (KEEP: never adopt or widen.)'
    }
    $segmentRecords = @()
    if (@($Segments).Count -gt 0) {
        $flatCheck = [Collections.Generic.List[int]]::new()
        foreach ($segment in @($Segments)) {
            if (($null -eq $segment) -or ($null -eq $segment.start) -or ($null -eq $segment.end) -or ($null -eq $segment.sourceEventSeqs) -or (@($segment.sourceEventSeqs).Count -eq 0)) {
                throw 'Operation refused: malformed frozen segment. (KEEP.)'
            }
            if ([int]$segment.sourceEventSeqs[0] -ne [int]$segment.start -or [int]$segment.sourceEventSeqs[-1] -ne [int]$segment.end) {
                throw 'Operation refused: frozen segment range must match its seqs. (KEEP.)'
            }
            foreach ($seq in @($segment.sourceEventSeqs)) { [void]$flatCheck.Add([int]$seq) }
            $segmentRecords += [ordered]@{ start = [int]$segment.start; end = [int]$segment.end; sourceEventSeqs = @([int[]]$segment.sourceEventSeqs) }
        }
        $expected = @([int[]]$SourceEventSeqs)
        if ([int]$flatCheck.Count -ne [int]$expected.Count) { throw 'Operation refused: frozen segments must cover exactly the source seqs. (KEEP.)' }
        for ($i = 0; $i -lt $expected.Count; $i++) {
            if ([int]$flatCheck[$i] -ne [int]$expected[$i]) { throw 'Operation refused: frozen segments must cover exactly the source seqs. (KEEP.)' }
        }
    }
    $operation = [ordered]@{
        schemaVersion = [int]$AihContextOperationSchemaVersion
        operationId = [string]$operationId
        taskId = [string]$TaskId
        taskInstanceId = [string]$task.taskInstanceId
        sessionId = [string]$SessionId
        workspace = [string]$Workspace
        checkpointPath = $(if ($null -ne $CheckpointPath) { [string]$CheckpointPath } else { $null })
        replacementStart = [int]$ReplacementStart
        replacementEnd = [int]$ReplacementEnd
        sourceEventSeqs = @([int[]]$SourceEventSeqs)
        segments = @($segmentRecords)
        completionBoundarySeq = [int]$CompletionBoundarySeq
        repositoryId = $(if ($null -ne $RepositoryId) { [string]$RepositoryId } else { $null })
        checkoutId = $(if ($null -ne $CheckoutId) { [string]$CheckoutId } else { $null })
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    if (@($segmentRecords).Count -eq 0) {
        throw 'Operation refused: the exact validated segment plan must be persisted (no silent single-span fallback). (KEEP.)'
    }
    $paths = Get-AihContextLifecyclePaths -Workspace $Workspace -TaskId $TaskId
    Write-AihAtomicJson $paths.Operation $operation
    $readBack = Read-AihContextCompactionOperation -Workspace $Workspace -TaskId $TaskId
    if (($null -eq $readBack) -or ([string]$readBack.operationId -ne [string]$operationId)) {
        throw 'Operation refused: read-back validation failed after atomic write. (KEEP.)'
    }
    return [pscustomobject]$readBack
}

function Test-AihContextOperationReconcile {
    # Restart/retry reconciliation input: given the live surface seqs observed
    # by the bridge plus whether the frozen replacement node is durably
    # present, decide reconcile / retry-same / block. NEVER widens the range.
    # LiveSurfaceSeqs: current session.surface.nodes (numbers, surface order).
    # LandedReplacementSeq: seq of the frozen replacement node when durably
    #   present, else -1.
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [int[]]$LiveSurfaceSeqs = @(),
        [int]$LandedReplacementSeq = -1,
        [string]$SessionId = '',
        [bool]$DurablyVerified = $false
    )
    $task = $null
    try { $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId }
    catch { return [pscustomobject][ordered]@{ decision = 'block'; reason = 'task identity unproven for this generation'; operationId = $null } }
    $operation = $null
    try { $operation = Read-AihContextCompactionOperation -Workspace $Workspace -TaskId $TaskId }
    catch { return [pscustomobject][ordered]@{ decision = 'block'; reason = 'frozen operation unreadable'; operationId = $null } }
    if (($null -eq $operation) -or ([string]$operation.taskInstanceId -ne [string]$task.taskInstanceId)) {
        return [pscustomobject][ordered]@{ decision = 'block'; reason = 'no frozen operation for this generation'; operationId = $null }
    }
    if ([int]$operation.schemaVersion -ne [int]$AihContextOperationSchemaVersion) {
        return [pscustomobject][ordered]@{ decision = 'block'; reason = 'operation schema mismatch'; operationId = [string]$operation.operationId }
    }
    # F2 provenance gate: session + workspace must match BEFORE any other
    # reasoning. Wrong-session or wrong-workspace callers get zero mutation.
    if ([string]$operation.sessionId -ne [string]$SessionId) {
        return [pscustomobject][ordered]@{ decision = 'block'; reason = 'operation belongs to another session'; operationId = [string]$operation.operationId }
    }
    if ([string]$operation.workspace -ne [string]$Workspace) {
        return [pscustomobject][ordered]@{ decision = 'block'; reason = 'operation belongs to another workspace'; operationId = [string]$operation.operationId }
    }
    $liveSet = [Collections.Generic.HashSet[int]]::new()
    foreach ($seq in @($LiveSurfaceSeqs)) { [void]$liveSet.Add([int]$seq) }
    if ([int]$LandedReplacementSeq -ge 0) {
        if (-not $liveSet.Contains([int]$LandedReplacementSeq)) {
            return [pscustomobject][ordered]@{ decision = 'block'; reason = 'landed replacement not on live surface'; operationId = [string]$operation.operationId }
        }
        # Contract A (partial-segment restart): every frozen segment must be
        # EITHER fully live (still to append) OR fully shadowed (landed). A
        # partially shadowed segment can never be safely re-appended.
        $missingSegments = 0
        foreach ($segment in @($operation.segments)) {
            $liveCount = 0
            foreach ($seq in @($segment.sourceEventSeqs)) { if ($liveSet.Contains([int]$seq)) { $liveCount++ } }
            if ($liveCount -eq 0) { continue }
            if ($liveCount -eq @($segment.sourceEventSeqs).Count) { $missingSegments++ ; continue }
            return [pscustomobject][ordered]@{ decision = 'block'; reason = 'partially shadowed segment cannot be safely re-appended'; operationId = [string]$operation.operationId }
        }
        if ([int]$missingSegments -eq 0) {
            # F5 MANDATORY: memory presence is not durability.
            # reconcile-applied requires the caller to have verified the
            # replacement from DURABLE persistence (flush + restore/proof),
            # not merely the live object.
            if (-not [bool]$DurablyVerified) {
                return [pscustomobject][ordered]@{ decision = 'await-durability'; reason = 'landed in memory only; durable proof required'; operationId = [string]$operation.operationId }
            }
            return [pscustomobject][ordered]@{ decision = 'reconcile-applied'; reason = 'frozen replacement durably verified'; operationId = [string]$operation.operationId }
        }
        return [pscustomobject][ordered]@{
            decision = 'retry-same'; reason = 'partial landing: only exact missing segments remain'
            operationId = [string]$operation.operationId
            replacementStart = [int]$operation.replacementStart; replacementEnd = [int]$operation.replacementEnd
            sourceEventSeqs = @($operation.sourceEventSeqs)
            segments = @($operation.segments)
        }
    }
    foreach ($seq in @($operation.sourceEventSeqs)) {
        if (-not $liveSet.Contains([int]$seq)) {
            return [pscustomobject][ordered]@{ decision = 'block'; reason = 'frozen source seq missing from live surface'; operationId = [string]$operation.operationId }
        }
    }
    if ($null -eq $operation.PSObject.Properties['segments'] -or @($operation.segments).Count -eq 0) {
        return [pscustomobject][ordered]@{ decision = 'block'; reason = 'frozen segment plan missing; refusing single-span fallback'; operationId = [string]$operation.operationId }
    }
    return [pscustomobject][ordered]@{
        decision = 'retry-same'; reason = 'exact frozen boundary still valid'
        operationId = [string]$operation.operationId
        replacementStart = [int]$operation.replacementStart; replacementEnd = [int]$operation.replacementEnd
        sourceEventSeqs = @($operation.sourceEventSeqs)
        segments = @($operation.segments)
    }
}

function Get-AihCompactionApplyLockPath {
    # Cross-process application lock file, scoped to exactly one task run
    # dir plus one operation. A lock FILE (not a Mutex handle) is used
    # because acquire and release span separate CLI processes: exclusivity
    # comes from atomic create-new (O_EXCL equivalent), abandonment recovery
    # from a bounded lease. Never held across Git/model/checkpoint work --
    # only the caller-guarded append/flush/verify section.
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId)
    $layout = Get-AihLedgerLayout $Workspace
    return (Join-Path (Join-Path $layout.Runs $TaskId) 'context-compaction-apply.lock')
}

function Invoke-AihCompactionApplyLockAcquire {
    # Acquire the cross-process apply lock via atomic create-new. Lease
    # bounds abandonment: a stale holder (expired lease) may be taken over
    # exactly once per acquire call; a live holder yields acquired=false so
    # the caller KEEPs/BLOCKs instead of launching a second writer.
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [int]$LeaseSeconds = 60
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $lockPath = Get-AihCompactionApplyLockPath -Workspace $Workspace -TaskId $TaskId
    $ownerId = [guid]::NewGuid().ToString('N')
    $now = [DateTime]::UtcNow
    $lease = [Math]::Max(1, [int]$LeaseSeconds)
    $ownerPid = 0
    try { $ownerPid = [int]$PID } catch { $ownerPid = 0 }
    $processStart = $null
    try { $processStart = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { $processStart = $null }
    $payload = [ordered]@{
        schemaVersion = 2; taskId = $TaskId; taskInstanceId = [string]$task.taskInstanceId
        sessionId = [string]$SessionId; operationId = [string]$OperationId
        ownerId = [string]$ownerId; ownerPid = $ownerPid; ownerProcessStartUtc = $processStart
        acquiredAtUtc = $now.ToString('o'); renewedAtUtc = $now.ToString('o')
        expiresAtUtc = $now.AddSeconds($lease).ToString('o')
    }
    $directory = Split-Path -Parent ([System.IO.Path]::GetFullPath($lockPath))
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    # The whole check-and-create sequence runs inside the mutation mutex so
    # two contenders cannot both observe absence and both create.
    return (Use-AihCompactionLockMutex -SessionId $SessionId -OperationId $OperationId {
        if (Test-Path -LiteralPath $lockPath) {
            $existing = $null
            try { $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $lockPath | ConvertFrom-Json } catch { $existing = $null }
            if ($null -ne $existing) {
                if (([string]$existing.taskInstanceId -ne [string]$task.taskInstanceId) -or ([string]$existing.operationId -ne [string]$OperationId) -or ([string]$existing.sessionId -ne [string]$SessionId)) {
                    return [pscustomobject][ordered]@{ acquired = $false; reason = 'held-by-other-operation' }
                }
                $expiry = [DateTime]::MinValue
                if ($null -ne $existing.PSObject.Properties['expiresAtUtc']) { [void][DateTime]::TryParse([string]$existing.expiresAtUtc, [ref]$expiry) }
                if ($expiry -gt [DateTime]::UtcNow) { return [pscustomobject][ordered]@{ acquired = $false; reason = 'held-by-live-owner' } }
                $renewedAt = [DateTime]::MinValue
                if ($null -ne $existing.PSObject.Properties['renewedAtUtc']) { [void][DateTime]::TryParse([string]$existing.renewedAtUtc, [ref]$renewedAt) }
                $ownerPid = 0
                if ($null -ne $existing.PSObject.Properties['ownerPid']) { [void][int]::TryParse([string]$existing.ownerPid, [ref]$ownerPid) }
                $ownerAlive = $false
                if ($ownerPid -gt 0) {
                    try {
                        $proc = Get-Process -Id $ownerPid -ErrorAction Stop
                        $started = $proc.StartTime.ToUniversalTime().ToString('o')
                        $recorded = $null
                        if ($null -ne $existing.PSObject.Properties['ownerProcessStartUtc']) { $recorded = [string]$existing.ownerProcessStartUtc }
                        $ownerAlive = ([string]::IsNullOrWhiteSpace($recorded) -or ($started -eq $recorded))
                    } catch { $ownerAlive = $false }
                }
                # Takeover requires BOTH expiry AND no defensible liveness:
                # a provably live owner process (same PID plus start time)
                # fences takeover even past expiry -- its renew-gate stops it
                # if it truly stalled, and renewal resumes when it wakes.
                # Only a dead/unknown owner may be taken over.
                if ($ownerAlive) { return [pscustomobject][ordered]@{ acquired = $false; reason = 'held-by-live-owner' } }
            }
            try { Remove-Item -LiteralPath $lockPath -Force } catch { return [pscustomobject][ordered]@{ acquired = $false; reason = 'takeover-raced' } }
        }
        try {
            $stream = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject (ConvertTo-AihJsonSafe $payload) -Depth 10))
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush()
            } finally { $stream.Dispose() }
            return [pscustomobject][ordered]@{ acquired = $true; ownerId = [string]$ownerId; leaseSeconds = $lease }
        } catch [IO.IOException] { return [pscustomobject][ordered]@{ acquired = $false; reason = 'takeover-raced' } }
    })
}

function Invoke-AihCompactionApplyLockRenew {
    # Owner-token-guarded renewal: ONLY the current ownerId may extend the
    # lease. A renewal both proves ownership (§14 stage gate) and extends
    # expiry, so a healthy live owner is never evicted by wall-clock expiry.
    # Renewal is a single atomic file replace performed under a short-lived
    # process mutex (see Use-AihCompactionLockMutex); the ownerId check and
    # the write happen inside the same critical section, so a concurrent
    # takeover cannot interleave between check and write.
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][string]$OwnerId,
        [int]$LeaseSeconds = 60
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $lockPath = Get-AihCompactionApplyLockPath -Workspace $Workspace -TaskId $TaskId
    $lease = [Math]::Max(1, [int]$LeaseSeconds)
    return (Use-AihCompactionLockMutex -SessionId $SessionId -OperationId $OperationId {
        if (-not (Test-Path -LiteralPath $lockPath)) { return [pscustomobject][ordered]@{ renewed = $false; reason = 'lock-absent' } }
        $existing = $null
        try { $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $lockPath | ConvertFrom-Json } catch { $existing = $null }
        if ($null -eq $existing) { return [pscustomobject][ordered]@{ renewed = $false; reason = 'lock-unreadable' } }
        if ([string]$existing.taskInstanceId -ne [string]$task.taskInstanceId) { return [pscustomobject][ordered]@{ renewed = $false; reason = 'generation-mismatch' } }
        if ([string]$existing.ownerId -ne [string]$OwnerId) { return [pscustomobject][ordered]@{ renewed = $false; reason = 'not-owner' } }
        $now = [DateTime]::UtcNow
        $existing.renewedAtUtc = $now.ToString('o')
        $existing.expiresAtUtc = $now.AddSeconds($lease).ToString('o')
        Write-AihAtomicJson $lockPath $existing
        return [pscustomobject][ordered]@{ renewed = $true; expiresAtUtc = [string]$existing.expiresAtUtc }
    })
}

function Use-AihCompactionLockMutex {
    # Short-lived cross-process mutex serializing lock-FILE mutations only
    # (acquire/takeover/renew/release decisions). Held for milliseconds,
    # never across append/flush/verify. Abandoned owners are treated as
    # releasable (the file content itself remains the authority).
    param([Parameter(Mandatory = $true)][string]$SessionId, [Parameter(Mandatory = $true)][string]$OperationId, [Parameter(Mandatory = $true)][scriptblock]$Action)
    $name = ConvertTo-AihSafeSyncName ('AIHarness.ContextCompaction.LockFile.' + [string]$SessionId + '.' + [string]$OperationId)
    $mutex = $null
    try { $mutex = [Threading.Mutex]::new($false, $name) }
    catch { throw "Compaction lock mutex unavailable: refusing unlocked action (KEEP)." }
    $taken = $false
    try {
        try { $taken = $mutex.WaitOne(5000) }
        catch [Threading.AbandonedMutexException] { $taken = $true }
        catch { throw "Compaction lock mutex unavailable: refusing unlocked action (KEEP)." }
        if (-not $taken) { throw "Compaction lock mutex busy: refusing unlocked action (KEEP)." }
        return (& $Action)
    } finally {
        if ($taken) { try { $mutex.ReleaseMutex() } catch { } }
        try { $mutex.Dispose() } catch { }
    }
}

function Invoke-AihCompactionApplyLockRelease {
    # Release is serialized with acquire/takeover/renew. The initial read only
    # selects the mutex scope; authorization is re-read under the mutex.
    # Best-effort and idempotent; an unavailable mutex never permits unlink.
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$OwnerId
    )
    $lockPath = Get-AihCompactionApplyLockPath -Workspace $Workspace -TaskId $TaskId
    try {
        if (-not (Test-Path -LiteralPath $lockPath)) { return [pscustomobject][ordered]@{ released = $true; reason = 'already-absent' } }
        $scope = Get-Content -Raw -Encoding UTF8 -LiteralPath $lockPath | ConvertFrom-Json
        if (($null -eq $scope) -or [string]::IsNullOrWhiteSpace([string]$scope.sessionId) -or [string]::IsNullOrWhiteSpace([string]$scope.operationId)) {
            return [pscustomobject][ordered]@{ released = $false; reason = 'lock-unreadable' }
        }
        return (Use-AihCompactionLockMutex -SessionId ([string]$scope.sessionId) -OperationId ([string]$scope.operationId) {
            if (-not (Test-Path -LiteralPath $lockPath)) { return [pscustomobject][ordered]@{ released = $true; reason = 'already-absent' } }
            $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $lockPath | ConvertFrom-Json
            if (($null -eq $existing) -or ($null -eq $existing.PSObject.Properties['ownerId'])) {
                return [pscustomobject][ordered]@{ released = $false; reason = 'lock-unreadable' }
            }
            if ([string]$existing.ownerId -ne [string]$OwnerId) {
                return [pscustomobject][ordered]@{ released = $false; reason = 'not-owner' }
            }
            Remove-Item -LiteralPath $lockPath -Force
            return [pscustomobject][ordered]@{ released = $true }
        })
    } catch { return [pscustomobject][ordered]@{ released = $false; reason = 'release-error' } }
}

function Get-AihContextLifecycleSnapshot {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$TaskId, [string]$TaskInstanceId = '')
    $state = Read-AihContextLifecycleState -Workspace $Workspace -TaskId $TaskId
    $pressure = Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId
    $stateName = 'inactive'
    if (($null -ne $state) -and ($null -ne $state.PSObject.Properties['state'])) { $stateName = [string]$state.state }
    return [pscustomobject][ordered]@{
        schemaVersion = 1; taskId = $TaskId
        taskInstanceId = $(if (-not [string]::IsNullOrWhiteSpace($TaskInstanceId)) { [string]$TaskInstanceId } elseif (($null -ne $state) -and ($null -ne $state.PSObject.Properties['taskInstanceId'])) { [string]$state.taskInstanceId } else { $null })
        state = $stateName; lifecycle = $state; pressure = $pressure
    }
}
function ConvertTo-AihCanonicalUtcIso {
    # F7: canonical ISO 8601 UTC timestamp contract. Parses any reasonable
    # incoming representation (ISO with offset, round-trip 'o', or legacy
    # locale text), normalizes to UTC, and serializes explicitly with the
    # round-trip format. Never relies on implicit DateTime->string
    # conversion, never emits locale-dependent forms like MM/DD/YYYY.
    param([Parameter(Mandatory = $true)][string]$Value)
    $parsed = [DateTime]::MinValue
    $styles = [Globalization.DateTimeStyles]::RoundtripKind
    if (-not [DateTime]::TryParse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
        if (-not [DateTime]::TryParse([string]$Value, [ref]$parsed)) { throw "Timestamp refused: cannot parse '$Value' as a date/time. (KEEP.)" }
    }
    if ($parsed.Kind -eq [DateTimeKind]::Unspecified) { $parsed = [DateTime]::SpecifyKind($parsed, [DateTimeKind]::Utc) }
    return ($parsed.ToUniversalTime().ToString('o'))
}
function Write-AihContextCompactionTelemetry {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)]$Eligibility,
        [string]$SessionId = '',
        [string]$CheckpointPath = $null,
        [object]$CheckpointSizeBytes = $null,
        [bool]$CheckpointApplied = $false,
        [string]$AppliedAtUtc = $null,
        [string]$BlockedReason = $null
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $layout = Get-AihLedgerLayout $Workspace
    $run = Join-Path $layout.Runs $TaskId
    $telemetryPath = Join-Path $run 'context-compaction-telemetry.json'
    # F7 ownership model: completion establishes the immutable BEFORE baseline
    # plus checkpoint metadata; apply/audit transitions MERGE (never
    # reconstruct from current pressure). Read the existing same-generation
    # document first; completion-owned fields are preserved once present.
    $existing = $null
    if (Test-Path -LiteralPath $telemetryPath) {
        try { $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $telemetryPath | ConvertFrom-Json }
        catch { throw 'Telemetry refused: context-compaction-telemetry.json is malformed. (KEEP: history never regenerated from current pressure.)' }
    }
    if (($null -ne $existing) -and ([string]$existing.taskInstanceId -ne [string]$task.taskInstanceId)) {
        throw 'Telemetry refused: existing telemetry belongs to another generation. (KEEP.)'
    }
    $hasBaseline = (($null -ne $existing) -and ($null -ne $existing.PSObject.Properties['latestEffectiveInputTokens']))
    if ($hasBaseline) {
        # Merge: preserve completion baseline + checkpoint metadata; update
        # only transition-owned fields.
        $existing.sessionId = [string]$SessionId
        if (-not [string]::IsNullOrWhiteSpace($BlockedReason)) { $existing.blockedReason = [string]$BlockedReason }
        if ($null -ne $CheckpointPath) { $existing.checkpointPath = [string]$CheckpointPath }
        if ($null -ne $CheckpointSizeBytes) { $existing.checkpointSizeBytes = [int]$CheckpointSizeBytes }
        if ([bool]$CheckpointApplied) {
            $existing.checkpointApplied = $true
            if (-not [string]::IsNullOrWhiteSpace($AppliedAtUtc)) { $existing.appliedAtUtc = (ConvertTo-AihCanonicalUtcIso -Value ([string]$AppliedAtUtc)) }
        }
        Write-AihAtomicJson $telemetryPath $existing
        return [pscustomobject]$existing
    }
    $record = [ordered]@{
        schemaVersion = 1; taskId = $TaskId; taskInstanceId = [string]$task.taskInstanceId
        sessionId = [string]$SessionId
        engine = $(if ($null -ne $task.PSObject.Properties['boundEngine']) { [string]$task.boundEngine } else { $null })
        thresholdTokens = [int]$Eligibility.thresholdTokens
        latestEffectiveInputTokens = [int]$Eligibility.latestEffectiveInputTokens
        peakEffectiveInputTokens = [int]$Eligibility.peakEffectiveInputTokens
        cumulativeUncachedInputTokens = [int]$Eligibility.cumulativeUncachedInputTokens
        cumulativeCacheReadTokens = [int]$Eligibility.cumulativeCacheReadTokens
        cumulativeOutputTokens = [int]$Eligibility.cumulativeOutputTokens
        rootModelCallCount = [int]$Eligibility.rootModelCallCount
        eligibilityDecision = [string]$Eligibility.eligibilityDecision
        eligibilityReason = [string]$Eligibility.eligibilityReason
        checkpointPath = $(if ($null -ne $CheckpointPath) { [string]$CheckpointPath } else { $null })
        checkpointSizeBytes = $CheckpointSizeBytes
        checkpointApplied = [bool]$CheckpointApplied
        appliedAtUtc = $(if (-not [string]::IsNullOrWhiteSpace($AppliedAtUtc)) { ConvertTo-AihCanonicalUtcIso -Value ([string]$AppliedAtUtc) } else { $AppliedAtUtc }); blockedReason = $BlockedReason
        recordedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    Write-AihAtomicJson $telemetryPath $record
    return [pscustomobject]$record
}

function Set-AihContextCompactionApplied {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][string]$AppliedAtUtc,
        [string]$SessionId = '',
        [string]$AppliedAfterStepId = ''
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $lifecycle = Read-AihContextLifecycleState -Workspace $Workspace -TaskId $TaskId
    if (($null -eq $lifecycle) -or ([string]$lifecycle.state -ne 'applied') -or ([string]$lifecycle.taskInstanceId -ne [string]$task.taskInstanceId)) {
        throw 'Mark-applied refused: lifecycle state is not applied for this generation. (KEEP.)'
    }
    $layout = Get-AihLedgerLayout $Workspace
    $run = Join-Path $layout.Runs $TaskId
    $telemetryPath = Join-Path $run 'context-compaction-telemetry.json'
    if (-not (Test-Path -LiteralPath $telemetryPath)) { throw 'Mark-applied refused: no compaction telemetry for this generation. (KEEP.)' }
    $telemetry = Get-Content -Raw -Encoding UTF8 -LiteralPath $telemetryPath | ConvertFrom-Json
    if ([string]$telemetry.taskInstanceId -ne [string]$task.taskInstanceId) { throw 'Mark-applied refused: generation mismatch. (KEEP.)' }
    if ([bool]$telemetry.checkpointApplied) { return [pscustomobject]$telemetry }
    $telemetry.checkpointApplied = $true
    $telemetry.appliedAtUtc = (ConvertTo-AihCanonicalUtcIso -Value ([string]$AppliedAtUtc))
    $telemetry | Add-Member -NotePropertyName 'appliedSessionId' -NotePropertyValue ([string]$SessionId) -Force
    # F7 event-time boundary: the authoritative LIVE session max StepId
    # at apply (supplied by the controller, which holds the session),
    # maxed defensively with pressure lastStepId. Pressure alone is NOT
    # sufficient: a produced-but-unpersisted pre-apply event would slip
    # past. A post-apply candidate is AFTER only if strictly greater in
    # the SAME session. Persisted once; retry never advances it.
    $boundary = $null
    $liveMax = [string]$AppliedAfterStepId
    try {
        $pressureAtApply = Read-AihContextPressure -Workspace $Workspace -TaskId $TaskId
        if (($null -ne $pressureAtApply) -and ([string]$pressureAtApply.taskInstanceId -eq [string]$task.taskInstanceId) -and ($null -ne $pressureAtApply.PSObject.Properties['lastStepId'])) {
            $pressureMax = [string]$pressureAtApply.lastStepId
            if ([string]::IsNullOrWhiteSpace($liveMax)) { $boundary = $pressureMax }
            elseif ([string]::IsNullOrWhiteSpace($pressureMax)) { $boundary = $liveMax }
            else {
                $cmpMax = Compare-AihContextStepOrder -A $liveMax -B $pressureMax
                if ($null -eq $cmpMax) { $boundary = $liveMax }
                elseif ($cmpMax -ge 0) { $boundary = $liveMax }
                else { $boundary = $pressureMax }
            }
        } else { $boundary = $liveMax }
    } catch { if ([string]::IsNullOrWhiteSpace($boundary)) { $boundary = $liveMax } }
    if (-not [string]::IsNullOrWhiteSpace($boundary)) {
        $telemetry | Add-Member -NotePropertyName 'appliedAfterStepId' -NotePropertyValue ([string]$boundary) -Force
    }
    Write-AihAtomicJson $telemetryPath $telemetry
    return [pscustomobject]$telemetry
}

function Add-AihContextPostCompactionUsage {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$TaskInstanceId,
        [Parameter(Mandatory = $true)][int]$PostCompactionEffectiveInputTokens,
        [string]$SessionId = '',
        [string]$PostCompactionStepId = ''
    )
    $task = Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $layout = Get-AihLedgerLayout $Workspace
    $run = Join-Path $layout.Runs $TaskId
    $telemetryPath = Join-Path $run 'context-compaction-telemetry.json'
    if (-not (Test-Path -LiteralPath $telemetryPath)) { throw 'Post-compaction telemetry refused: no compaction telemetry for this generation. (KEEP.)' }
    $telemetry = Get-Content -Raw -Encoding UTF8 -LiteralPath $telemetryPath | ConvertFrom-Json
    if ([string]$telemetry.taskInstanceId -ne [string]$task.taskInstanceId) { throw 'Post-compaction telemetry refused: generation mismatch. (KEEP.)' }
    if (-not [bool]$telemetry.checkpointApplied) { throw 'Post-compaction telemetry refused: checkpoint was not applied. (KEEP.)' }
    if ($null -ne $telemetry.PSObject.Properties['postCompactionEffectiveInputTokens']) { return [pscustomobject]$telemetry }
    # F7 correlation gate: processing-time state (snapshot==applied) is NOT
    # event-time proof. A delayed pre-apply event delivered after apply must
    # never become AFTER. Require: same session as the apply session AND a
    # strictly greater StepId than the persisted apply boundary. Step-less
    # or cross-session candidates fail closed (no safe ordering exists).
    # No wall-clock, no PID/mtime/lock-order inference.
    $appliedSession = $null
    if ($null -ne $telemetry.PSObject.Properties['appliedSessionId']) { $appliedSession = [string]$telemetry.appliedSessionId }
    $appliedBoundary = $null
    if ($null -ne $telemetry.PSObject.Properties['appliedAfterStepId']) { $appliedBoundary = [string]$telemetry.appliedAfterStepId }
    if ([string]::IsNullOrWhiteSpace($PostCompactionStepId) -or [string]::IsNullOrWhiteSpace($appliedBoundary)) {
        throw 'Post-compaction telemetry refused: no provable event-time order (step-less observation). (KEEP: AFTER stays unavailable, never fabricated.)'
    }
    if (-not [string]::IsNullOrWhiteSpace($appliedSession) -and ([string]$SessionId -ne $appliedSession)) {
        throw 'Post-compaction telemetry refused: observation session differs from the apply session (no safe cross-session StepId order). (KEEP.)'
    }
    $orderCmp = Compare-AihContextStepOrder -A ([string]$PostCompactionStepId) -B $appliedBoundary
    if (($null -eq $orderCmp) -or ($orderCmp -le 0)) {
        throw 'Post-compaction telemetry refused: candidate is not provably AFTER the apply boundary. (KEEP: delayed pre-apply event ignored.)'
    }
    # F7: reduction is completion-baseline minus the CORRELATED post-apply
    # root observation (never current-pressure-derived, never a projection
    # byte estimate). The baseline is the preserved completion latest; the
    # after-value arrives only with a real correlated observation carrying
    # the F6 StepId identity. No observation => fields stay absent.
    $pre = [int]$telemetry.latestEffectiveInputTokens
    $reduction = $pre - [int]$PostCompactionEffectiveInputTokens
    $telemetry | Add-Member -NotePropertyName 'postCompactionEffectiveInputTokens' -NotePropertyValue ([int]$PostCompactionEffectiveInputTokens) -Force
    $telemetry | Add-Member -NotePropertyName 'firstCallTokenReduction' -NotePropertyValue ([int]$reduction) -Force
    $telemetry | Add-Member -NotePropertyName 'postCompactionSessionId' -NotePropertyValue ([string]$SessionId) -Force
    if (-not [string]::IsNullOrWhiteSpace($PostCompactionStepId)) {
        $telemetry | Add-Member -NotePropertyName 'postCompactionStepId' -NotePropertyValue ([string]$PostCompactionStepId) -Force
    }
    $telemetry | Add-Member -NotePropertyName 'postCompactionRecordedAtUtc' -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    Write-AihAtomicJson $telemetryPath $telemetry
    return [pscustomobject]$telemetry
}

