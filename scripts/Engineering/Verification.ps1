Set-StrictMode -Version Latest

# Engineering.Verification - Phase 3.2.5 Verification Strategy v0.
#
# Deterministic verification-scope heuristics ONLY (no Test Impact Analysis;
# that belongs after the Knowledge Graph capability exists):
#
#   local-change   -> direct/targeted relevant verification
#   milestone      -> relevant regression group
#   cross-cutting  -> broader regression suite
#   final          -> required project/full harness verification
#
# Every verification records WHY it was selected and which requirement ids it
# evidences. Dependency relationships Nexus cannot deterministically prove
# are never fabricated: the reason is recorded, heuristics stay explicit.
# The full harness is NOT run after every trivial edit.

$EngineeringVerificationScopes = @('local-change','milestone','cross-cutting','final')

function Get-AihVerificationLogPath {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId)
    $run = Get-AihEngineeringRunPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    return (Join-Path $run 'verification-log.jsonl')
}

function Get-AihVerificationRecords {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $path = Get-AihVerificationLogPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $records = @()
    if (-not (Test-Path -LiteralPath $path)) { return $records }
    foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $path) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $record = $line | ConvertFrom-Json } catch { continue }
        if ($null -eq $record) { continue }
        if (-not (Test-AihEngineeringArtifactIdentity -Artifact $record -TaskInstanceId $TaskInstanceId)) { continue }
        $records += $record
    }
    return $records
}

function Test-AihVerificationScopeAllowed {
    # Scope heuristics: a scope is justified by the recorded change shape,
    # not invented. local-change targets recorded changed files; milestone
    # requires a milestone context; cross-cutting requires facts recorded as
    # cross-cutting; final is always allowed. The heuristic is deliberately
    # conservative: it NEVER forbids a broader scope, it only records whether
    # the chosen scope matches the deterministic change shape.
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[string]$Scope)
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $changedFiles = 0
    if ($null -ne $workingSet) { $changedFiles = @($workingSet.changedFiles).Count }
    $result = [ordered]@{ scope = $Scope; changedFiles = $changedFiles; matchesChangeShape = $true; note = '' }
    switch ($Scope) {
        'local-change' {
            if ($changedFiles -eq 0) { $result.matchesChangeShape = $false; $result.note = 'no changed files recorded: targeted verification cannot be tied to a local change.' }
        }
        'milestone' {
            if ($null -eq $workingSet -or [string]::IsNullOrEmpty([string]$workingSet.currentMilestone)) {
                $result.matchesChangeShape = $false
                $result.note = 'no current milestone recorded.'
            }
        }
        'cross-cutting' {
            if ($null -eq $workingSet) { $result.matchesChangeShape = $false; $result.note = 'no working set.' }
        }
        'final' { }
    }
    return $result
}

function New-AihVerificationPlan {
    # Records a verification plan: command(s), scope, reason, requirementIds.
    # Commands are recorded verbatim; Nexus never fabricates dependency
    # relationships it cannot prove.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [Parameter(Mandatory=$true)][ValidateSet('local-change','milestone','cross-cutting','final')][string]$Scope,
        [Parameter(Mandatory=$true)][string]$Reason,
        [string[]]$RequirementIds = @(),
        [Parameter(Mandatory=$true)][object[]]$Commands
    )
    if (@($Commands).Count -eq 0) { throw 'A verification plan requires at least one command.' }
    $scopeCheck = Test-AihVerificationScopeAllowed -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Scope $Scope
    $records = @(Get-AihVerificationRecords -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    $verificationId = 'VER-{0:D3}' -f ($records.Count + 1)
    $normalizedCommands = @()
    foreach ($command in @($Commands)) {
        $normalizedCommands += [ordered]@{
            name = [string]$command.name
            executable = [string]$command.executable
            argv = @($command.argv)
            cwd = if ($null -eq $command.PSObject.Properties['cwd'] -or [string]::IsNullOrWhiteSpace([string]$command.cwd)) { [IO.Path]::GetFullPath($Workspace) } else { [string]$command.cwd }
            timeoutMs = if ($null -ne $command.PSObject.Properties['timeoutMs']) { [int]$command.timeoutMs } else { 600000 }
        }
    }
    $plan = [ordered]@{
        timestampUtc = Get-AihEngineeringUtcNow
        taskId = $TaskId
        taskInstanceId = if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) { $null } else { $TaskInstanceId }
        verificationId = $verificationId
        scope = $Scope
        reason = (ConvertTo-AihEngineeringSafeText $Reason 500)
        requirementIds = @($RequirementIds)
        commands = $normalizedCommands
        scopeCheck = $scopeCheck
        result = 'not-run'
        startedAtUtc = $null
        finishedAtUtc = $null
    }
    Add-AihJsonLine -Path (Get-AihVerificationLogPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) -Value $plan

    $path = Get-AihWorkingSetPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $workingSet = Get-AihWorkingSet -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -ne $workingSet) {
        $workingSet.nextVerification = [ordered]@{ verificationId = $verificationId; scope = $Scope; reason = $plan.reason }
        Save-AihWorkingSet -WorkingSet $workingSet -Path $path
    }
    return $plan
}

function Complete-AihVerification {
    # Records the result and updates requirement verification status. A PASS
    # moves the linked requirements to verified; a FAIL does not (and marks
    # the failure in the failure ledger through the caller's execution).
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [Parameter(Mandatory=$true)][string]$VerificationId,
        [Parameter(Mandatory=$true)][ValidateSet('pass','fail')][string]$Result,
        [string]$Summary = ''
    )
    $path = Get-AihVerificationLogPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $records = @(Get-AihVerificationRecords -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    $target = $null
    foreach ($record in $records) { if ([string]$record.verificationId -eq $VerificationId) { $target = $record } }
    if ($null -eq $target) { throw "Unknown verification id for this task: $VerificationId" }
    Set-AihEngineeringProperty -Object $target -Name 'result' -Value $Result
    Set-AihEngineeringProperty -Object $target -Name 'finishedAtUtc' -Value (Get-AihEngineeringUtcNow)
    if (-not [string]::IsNullOrEmpty($Summary)) { Set-AihEngineeringProperty -Object $target -Name 'summary' -Value (ConvertTo-AihEngineeringSafeText $Summary 800) }
    # Rewrite the log deterministically (few records; one authoritative line
    # per verification).
    $lines = [Collections.Generic.List[string]]::new()
    foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $path) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try {
            $candidate = $line | ConvertFrom-Json
            if ($null -ne $candidate -and (Test-AihEngineeringArtifactIdentity -Artifact $candidate -TaskInstanceId $TaskInstanceId) -and [string]$candidate.verificationId -eq $VerificationId) {
                $lines.Add(($target | ConvertTo-Json -Depth 12 -Compress))
            } else { $lines.Add($line) }
        } catch { $lines.Add($line) }
    }
    [IO.File]::WriteAllText($path, (($lines -join [Environment]::NewLine) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))

    $updated = @()
    if (@($target.requirementIds).Count -gt 0) {
        $requirementsDocument = Read-AihEngineeringJson -Path (Get-AihRequirementsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) -Default $null
        if ($null -ne $requirementsDocument) {
            $updated = Update-AihRequirementVerification -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -RequirementIds @($target.requirementIds) -Result $Result -VerificationId $VerificationId
        }
    }
    return [ordered]@{ verification = $target; updatedRequirements = @($updated) }
}

function Get-AihVerificationSnapshot {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $records = @(Get-AihVerificationRecords -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId)
    return [ordered]@{
        verifications = $records.Count
        passed = @($records | Where-Object { $_.result -eq 'pass' }).Count
        failed = @($records | Where-Object { $_.result -eq 'fail' }).Count
        notRun = @($records | Where-Object { $_.result -eq 'not-run' }).Count
        fullHarnessRuns = @($records | Where-Object { $_.scope -eq 'final' }).Count
        records = @($records)
    }
}
