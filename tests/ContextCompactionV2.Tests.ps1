[CmdletBinding()]param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot))
# Context Compaction V2 (CCV2-A02) PowerShell-plane regression suite.
#
# Exercises the REAL PS V2 authority (scripts/ContextLifecycle.ps1) against
# isolated temp workspaces: generation-aware operation identity, closed-world
# V2 validation matrix, continuation anchors, and atomic freeze/read-back
# persistence with idempotent retry. No network, no model calls.
Set-StrictMode -Version Latest;$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/TaskController.ps1')
. (Join-Path $InstallRoot 'scripts/ContextLifecycle.ps1')

$passed = 0
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }
function New-V2Fixture([string]$Name) { $path = Join-Path ([IO.Path]::GetTempPath()) ("aih-ccv2-$Name-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $path | Out-Null; & git init -q $path | Out-Null; & git -C $path config user.email v2t@example.invalid | Out-Null; & git -C $path config user.name v2t | Out-Null; Set-Content -LiteralPath (Join-Path $path '.v2baseline') -Value 'baseline' | Out-Null; & git -C $path add .v2baseline | Out-Null; & git -C $path commit -qm baseline | Out-Null; $path }
function New-V2Task([string]$Workspace) {
    $task = New-AihTask -Workspace $Workspace -Description 'ccv2 fixture task' -AcceptanceCriteria @('criterion one') -Engine 'muse'
    $run = Join-Path (Join-Path $Workspace '.ai-harness/runs') $task.taskId
    $evidence = [ordered]@{
        schemaVersion = 2; attempt = 1; taskInstanceId = [string]$task.taskInstanceId
        acceptanceCriteria = @([ordered]@{ criterion = 'criterion one'; status = 'met'; evidence = 'fixture' })
        verification = @([ordered]@{ name = 'fixture-verify'; kind = 'verify'; status = 'PASS'; exitCode = 0; attempt = 1 })
        scopePass = $true
    }
    Write-AihAtomicJson (Join-Path $run 'evidence.json') $evidence
    $completion = Test-AihTaskCompletion -Workspace $Workspace -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    if (-not [bool]$completion.complete) { throw ("Fixture completion failed: " + ([string]::Join('; ', @($completion.reasons)))) }
    $task
}

# == 1. V2 operation identity: generation-aware, deterministic ================
$id11 = New-AihContextCompactionOperationIdV2 -TaskId 'T' -TaskInstanceId 'TI' -SessionId 'S' -Generation 1 -CheckpointId 'CKPT-A'
$id12 = New-AihContextCompactionOperationIdV2 -TaskId 'T' -TaskInstanceId 'TI' -SessionId 'S' -Generation 2 -CheckpointId 'CKPT-A'
$id1b = New-AihContextCompactionOperationIdV2 -TaskId 'T' -TaskInstanceId 'TI' -SessionId 'S' -Generation 1 -CheckpointId 'CKPT-B'
Assert-Aih ($id11 -like 'ccop_*') 'V2 operationId carries the ccop_ prefix'
Assert-Aih ($id11 -ne $id12) 'same checkpoint: generation 1 != generation 2'
Assert-Aih ($id11 -ne $id1b) 'same generation: checkpoint A != checkpoint B'
Assert-Aih ($id11 -eq (New-AihContextCompactionOperationIdV2 -TaskId 'T' -TaskInstanceId 'TI' -SessionId 'S' -Generation 1 -CheckpointId 'CKPT-A')) 'V2 derivation is deterministic'
$v1 = New-AihContextCompactionOperationId -TaskId 'T' -TaskInstanceId 'TI' -SessionId 'S'
Assert-Aih ($id11 -ne $v1) 'V1 and V2 IDs never collide (separate domain)'
$uni = New-AihContextCompactionOperationIdV2 -TaskId 'Tâsk-✓' -TaskInstanceId 'inst/ané' -SessionId 'sess/✓' -Generation 3 -CheckpointId 'CKPT-✓'
Assert-Aih ($uni -eq (New-AihContextCompactionOperationIdV2 -TaskId 'Tâsk-✓' -TaskInstanceId 'inst/ané' -SessionId 'sess/✓' -Generation 3 -CheckpointId 'CKPT-✓')) 'Unicode/path-like V2 identity is deterministic'

# == 2. Continuation anchors are bounded identity-only nodes ==================
$anchor = New-AihContextContinuationAnchor -OperationId $id11 -Generation 1 -SegmentIndex 1 -SegmentCount 3
Assert-Aih ($anchor -eq ('<nexus-context-continuation operation="' + $id11 + '" generation="1" segment="2/3"/>')) 'anchor binds operation, generation, and segment position'
Assert-Aih (($anchor -notlike '*Status*') -and ($anchor -notlike '*policy*')) 'anchor carries no payload of any kind'

# == 3. V2 validation matrix ===================================================
$root = New-V2Fixture 'matrix'
try {
    $task = New-V2Task $root
    $sessionId = 'sess-ccv2-matrix'
    $opId = New-AihContextCompactionOperationIdV2 -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId $sessionId -Generation 1 -CheckpointId 'CKPT-M'
    function New-V2Draft {
        [pscustomobject][ordered]@{
            schemaVersion = 2; operationId = $opId; attemptId = 'attempt-m-1'
            taskId = $task.taskId; taskInstanceId = [string]$task.taskInstanceId; sessionId = $sessionId
            checkpointId = 'CKPT-M'; checkpointGeneration = 1; checkpointContentDigest = 'd' * 64
            snapshotTokenId = $null; safePointBoundarySeq = 9
            sourceEventSeqs = @(0, 1, 3)
            segments = @(
                [pscustomobject][ordered]@{ start = 0; end = 1; sourceEventSeqs = @(0, 1); role = 'payload' }
                [pscustomobject][ordered]@{ start = 3; end = 3; sourceEventSeqs = @(3); role = 'continuation' }
            )
            lifecycle = 'frozen'; workspace = $root
        }
    }
    function Test-V2Draft($Operation, [string]$ExpectReason) {
        $r = Test-AihContextCompactionOperationV2 -Operation $Operation -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId $sessionId -Workspace $root -CheckpointId 'CKPT-M' -CheckpointGeneration 1
        if ([string]::IsNullOrWhiteSpace($ExpectReason)) { return ([bool]$r.valid) }
        return ((-not [bool]$r.valid) -and ([string]$r.reason -eq $ExpectReason))
    }
    Assert-Aih (Test-V2Draft (New-V2Draft) '') 'PS: 1 payload + 1 continuation is valid'
    $d = New-V2Draft; $d.segments = @([pscustomobject][ordered]@{ start = 0; end = 1; sourceEventSeqs = @(0, 1); role = 'payload' }); $d.sourceEventSeqs = @(0, 1)
    Assert-Aih (Test-V2Draft $d '') 'PS: 1 payload only is valid'
    $d = New-V2Draft; $d.segments[0].role = 'continuation'
    Assert-Aih (Test-V2Draft $d 'payload-segment-missing') 'PS: 0 payload rejected'
    $d = New-V2Draft; $d.segments[1].role = 'payload'
    Assert-Aih (Test-V2Draft $d 'payload-segment-duplicate') 'PS: 2 payloads rejected'
    $d = New-V2Draft; $d.segments[1].role = 'summary'
    Assert-Aih (Test-V2Draft $d 'segment-role-unknown') 'PS: unknown role rejected'
    $d = New-V2Draft; $d.segments = @([pscustomobject][ordered]@{ start = 3; end = 3; sourceEventSeqs = @(3); role = 'continuation' }, [pscustomobject][ordered]@{ start = 0; end = 1; sourceEventSeqs = @(0, 1); role = 'payload' })
    Assert-Aih (Test-V2Draft $d 'segments-unordered') 'PS: unordered segments rejected'
    $d = New-V2Draft; $d.segments = @([pscustomobject][ordered]@{ start = 0; end = 1; sourceEventSeqs = @(0, 1); role = 'payload' }, [pscustomobject][ordered]@{ start = 1; end = 3; sourceEventSeqs = @(1, 3); role = 'continuation' })
    Assert-Aih (Test-V2Draft $d 'segment-overlap') 'PS: overlapping source sets rejected'
    $d = New-V2Draft; $d.safePointBoundarySeq = 2
    Assert-Aih (Test-V2Draft $d 'source-seq-beyond-safe-point-boundary') 'PS: boundary violation rejected'
    $d = New-V2Draft; $d.operationId = 'ccop_wrong_but_nonempty00000000000000'
    Assert-Aih (Test-V2Draft $d 'operation-id-mismatch') 'PS: tampered operationId rejected (derived identity, not free text)'
    $d = New-V2Draft; $d.schemaVersion = 1
    Assert-Aih (Test-V2Draft $d 'operation-schema-mismatch') 'PS: V1 schemaVersion never reinterpreted as V2'
    $d = New-V2Draft; $d.lifecycle = 'landed'
    Assert-Aih (Test-V2Draft $d 'lifecycle-invalid') 'PS: unknown lifecycle rejected'
    $d = New-V2Draft; $d.sessionId = 'other-session'
    Assert-Aih (Test-V2Draft $d 'session-id-mismatch') 'PS: session mismatch rejected'
} finally { Remove-Item -Recurse -Force -LiteralPath $root -ErrorAction SilentlyContinue }

# == 4. Atomic freeze: persist → read-back → idempotent retry ==================
$root = New-V2Fixture 'freeze'
try {
    $task = New-V2Task $root
    $sessionId = 'sess-ccv2-freeze'
    $segments = @(
        [pscustomobject][ordered]@{ start = 0; end = 1; sourceEventSeqs = @(0, 1); role = 'payload' }
        [pscustomobject][ordered]@{ start = 3; end = 3; sourceEventSeqs = @(3); role = 'continuation' }
    )
    $frozen = New-AihContextCompactionOperationV2 -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId $sessionId -CheckpointGeneration 1 -CheckpointId 'CKPT-F1' -AttemptId 'attempt-f1' -SafePointBoundarySeq 9 -SourceEventSeqs @(0, 1, 3) -Segments $segments -CheckpointContentDigest ('f' * 64) -Lifecycle 'frozen'
    Assert-Aih ([int]$frozen.schemaVersion -eq 2) 'PS: frozen operation persists schemaVersion 2'
    Assert-Aih (([string]$frozen.operationId) -eq (New-AihContextCompactionOperationIdV2 -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId $sessionId -Generation 1 -CheckpointId 'CKPT-F1')) 'PS: frozen operationId is the derived identity'
    $readBack = Read-AihContextCompactionOperationV2 -Workspace $root -TaskId $task.taskId
    Assert-Aih (([string]$readBack.operationId) -eq ([string]$frozen.operationId)) 'PS: frozen operation is durably readable (read-back proof)'
    Assert-Aih ((@($readBack.segments).Count -eq 2) -and ([string]$readBack.segments[0].role -eq 'payload')) 'PS: frozen roles persist verbatim'
    # Idempotent retry with a WIDER candidate: the frozen boundary is returned
    # verbatim, never widened.
    $retry = New-AihContextCompactionOperationV2 -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId $sessionId -CheckpointGeneration 1 -CheckpointId 'CKPT-F1' -AttemptId 'attempt-f1' -SafePointBoundarySeq 42 -SourceEventSeqs @(0, 1, 2, 3) -Segments $segments -CheckpointContentDigest ('f' * 64) -Lifecycle 'frozen'
    Assert-Aih (([string]$retry.operationId) -eq ([string]$frozen.operationId)) 'PS: retry reuses the same frozen operation'
    Assert-Aih ((@($retry.sourceEventSeqs) -join ',') -eq '0,1,3') 'PS: retry never widens the frozen source set'
    # A different generation is a different operation and must not adopt the file.
    $failed = $false
    try {
        [void](New-AihContextCompactionOperationV2 -Workspace $root -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -SessionId $sessionId -CheckpointGeneration 2 -CheckpointId 'CKPT-F2' -AttemptId 'attempt-f2' -SafePointBoundarySeq 9 -SourceEventSeqs @(0, 1, 3) -Segments $segments -CheckpointContentDigest ('f' * 64) -Lifecycle 'frozen')
    } catch { $failed = $true }
    Assert-Aih $failed 'PS: a different generation cannot adopt the frozen file (KEEP)'
    # V1 operation file is untouched by V2 persistence.
    $v1path = Join-Path (Join-Path $root ('.ai-harness/runs/' + $task.taskId)) 'context-compaction-operation.json'
    Assert-Aih (-not (Test-Path -LiteralPath $v1path)) 'PS: V2 freeze never writes the V1 operation file'
} finally { Remove-Item -Recurse -Force -LiteralPath $root -ErrorAction SilentlyContinue }

Write-Host ("RESULT: " + $passed + " CCV2-A02 PowerShell assertions passed.")
