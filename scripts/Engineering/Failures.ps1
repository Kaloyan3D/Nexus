Set-StrictMode -Version Latest

# Engineering.Failures - Phase 3.2.5 deterministic failure classifier.
#
# Normalizes operational failures into stable deterministic classes and
# stable signatures. Equivalent failures (same missing executable / same
# missing path / same failing test) normalize to the SAME signature despite
# insignificant stderr formatting differences. Task-local only: no
# cross-task learning, no persistent memory.

function Get-AihFailuresPath {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId)
    $run = Get-AihEngineeringRunPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    return (Join-Path $run 'failures.json')
}

function Get-AihFailureIdentityText {
    # The CLASS-SPECIFIC identity of a failure. Only details that CHANGE the
    # meaning of the failure participate in the signature; incidental
    # formatting (numbers, whitespace, casing, paths' temp prefixes) does not.
    param([string]$Class,[string]$Executable,[string]$Detail)
    $identity = ''
    switch ($Class) {
        'executable-not-found' { $identity = (Get-AihEngineeringNormalizedKey $Executable) }
        'path-not-found'       { $identity = Get-AihEngineeringNormalizedPathIdentity $Detail }
        'permission'           { $identity = (Get-AihEngineeringNormalizedKey $Detail) }
        'syntax-parse'         { $identity = Get-AihEngineeringNormalizedPathIdentity $Detail }
        'patch-target-not-found' { $identity = Get-AihEngineeringNormalizedPathIdentity $Detail }
        'patch-ambiguous'      { $identity = Get-AihEngineeringNormalizedPathIdentity $Detail }
        'file-changed-since-read' { $identity = Get-AihEngineeringNormalizedPathIdentity $Detail }
        'timeout'              { $identity = (Get-AihEngineeringNormalizedKey $Executable) }
        'test-failure'         { $identity = Get-AihEngineeringNormalizedPathIdentity $Detail }
        'build-failure'        { $identity = (Get-AihEngineeringNormalizedKey $Detail) }
        'dependency-environment' { $identity = (Get-AihEngineeringNormalizedKey $Detail) }
        'provider-capacity'    { $identity = (Get-AihEngineeringNormalizedKey $Detail) }
        'provider-response-shape' { $identity = (Get-AihEngineeringNormalizedKey $Detail) }
        'controller-infrastructure' { $identity = (Get-AihEngineeringNormalizedKey $Detail) }
        'review-context-quality' { $identity = (Get-AihEngineeringNormalizedKey $Detail) }
        default                { $identity = (Get-AihEngineeringNormalizedKey $Detail) }
    }
    if ([string]::IsNullOrEmpty($identity)) { $identity = 'unspecified' }
    return $class + ':' + $identity
}

function Get-AihEngineeringNormalizedPathIdentity {
    # Path/answer identity: strip digits (attempt counts, durations, line
    # numbers), collapse whitespace, strip machine-specific temp roots.
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
    $identity = $Text.ToLowerInvariant()
    $tempRootPattern = '[a-z]:' + [string][char]92 + 'users' + [string][char]92 + '[a-z0-9_ -]+' + [string][char]92 + 'appdata' + [string][char]92 + 'local' + [string][char]92 + 'temp' + [string][char]92 + '[a-z0-9_.-]+'
    $identity = [regex]::Replace($identity, $tempRootPattern, '<tmp>')
    $identity = [regex]::Replace($identity, 'd+', '#')
    $identity = Get-AihEngineeringNormalizedKey $identity
    if ($identity.Length -gt 400) { $identity = $identity.Substring(0, 400) }
    return $identity
}

function Get-AihFailureSignature {
    param([string]$Class,[string]$Executable,[string]$Detail)
    $identity = Get-AihFailureIdentityText -Class $Class -Executable $Executable -Detail $Detail
    return (Get-AihEngineeringSha256 $identity).Substring(0, 32)
}

function Classify-AihFailure {
    # Deterministic classification from the structured execution facts.
    param(
        [int]$ExitCode = -1,[bool]$TimedOut = $false,
        [string]$StdErr = '',[string]$StdOut = '',[string]$CommandText = '',
        [bool]$ExecutableResolved = $true,[string]$MissingPath = '',[string]$OperationKind = 'run_command'
    )
    $haystack = ($StdErr + ' ' + $StdOut + ' ' + $CommandText)
    if (-not $ExecutableResolved) { return 'executable-not-found' }
    if ($TimedOut) { return 'timeout' }
    if (-not [string]::IsNullOrWhiteSpace($MissingPath) -or $haystack -match '(?i)(no such file or directory|path not found|cannot find path|does not exist)') {
        return 'path-not-found'
    }
    if ($haystack -match '(?i)(access is denied|unauthorized|forbidden|eperm|permission denied)') { return 'permission' }
    if ($OperationKind -in @('apply_patch','patch')) {
        if ($haystack -match '(?i)(no lines? match|patch target not found|context mismatch|hunk failed)') { return 'patch-target-not-found' }
        if ($haystack -match '(?i)(ambiguous|matched more than once)') { return 'patch-ambiguous' }
    }
    if ($haystack -match '(?i)(file (has|was) (been )?modified since|file-changed-since-read)') { return 'file-changed-since-read' }
    if ($haystack -match '(?i)(syntax error|parse error|unexpected token|invalid argument body|parser error)') { return 'syntax-parse' }
    if ($haystack -match '(?i)(npm |pnpm |yarn )?(install|module not found|cannot find module|ENOTFOUND|ETIMEDOUT|registry)') { return 'dependency-environment' }
    if ($haystack -match '(?i)(build failed|compilation (failed|error)|error (MSB|CS|TS)d+)') { return 'build-failure' }
    if ($haystack -match '(?i)(provider (capacity|overloaded)|rate limit|429|context window|packet.too.large|quota)') { return 'provider-capacity' }
    if ($haystack -match '(?i)(malformed provider response|unexpected provider (shape|format)|missing usage)') { return 'provider-response-shape' }
    if ($haystack -match '(?i)(spawn|launch|timed out waiting|controller infrastructure)') { return 'controller-infrastructure' }
    if ($OperationKind -in @('run_test','test')) { return 'test-failure' }
    if ($ExitCode -ne 0) { return 'unknown' }
    return 'unknown'
}

function Read-AihFailureLedger {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $path = Get-AihFailuresPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $ledger = Read-AihEngineeringJson -Path $path -Default $null
    if ($null -eq $ledger) { return $null }
    if (-not (Test-AihEngineeringArtifactIdentity -Artifact $ledger -TaskInstanceId $TaskInstanceId)) { return $null }
    return $ledger
}

function Record-AihFailure {
    # Classify + record one failure occurrence (task-local ledger).
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [string]$Classification = '',[string]$Signature = '',[string]$Executable = '',[string]$Detail = '',
        [string]$EvidenceText = '',[string]$Operation = '',[string]$Hypothesis = ''
    )
    $path = Get-AihFailuresPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $ledger = Read-AihFailureLedger -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $ledger) {
        $ledger = [ordered]@{
            schemaVersion = 1
            taskId = $TaskId
            taskInstanceId = if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) { $null } else { $TaskInstanceId }
            failures = [ordered]@{}
        }
    }
    $now = Get-AihEngineeringUtcNow
    $safeEvidence = Redact-AihEngineeringSecrets (ConvertTo-AihEngineeringSafeText $EvidenceText 800)
    if ([string]::IsNullOrWhiteSpace($Classification)) {
        # No class supplied: classify deterministically from the raw evidence
        # text so equivalent failures normalize to one stable signature.
        $Classification = Classify-AihFailure -ExitCode -1 -StdErr $EvidenceText -StdOut '' -CommandText $Operation
    }
    if ([string]::IsNullOrWhiteSpace($Signature)) {
        $Signature = Get-AihFailureSignature -Class $Classification -Executable $Executable -Detail $Detail
    }
    $occurrence = [ordered]@{ at = $now; operation = (ConvertTo-AihEngineeringSafeText $Operation 200); hypothesisKey = (Get-AihEngineeringHypothesisKey $Hypothesis) }
    $existing = Get-AihFailureEntry -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Signature $Signature
    if ($null -ne $existing) {
        $existing.count = ([int]$existing.count + 1)
        $existing.lastSeen = $now
        $existing.occurrences = @($existing.occurrences) + @($occurrence)
    }
    # Rebuild the ledger DIRECTLY on the output object: an intermediate
    # hashtable keyed by the signature silently failed to hold assignments
    # inside this function's scope (PowerShell 5.1 adapter quirk), so the
    # authoritative ledger object is assembled in one pass instead.
    $rebuilt = [ordered]@{ schemaVersion = 1; taskId = $TaskId; taskInstanceId = if ($null -eq $ledger) { $null } else { $ledger.taskInstanceId }; failures = [ordered]@{} }
    # Copy prior entries ONLY from a PARSED ledger (pscustomobject). When the
    # ledger was just created in memory ([ordered]), .PSObject.Properties on
    # the dictionary yields .NET reflection members (Count, Keys, Values,
    # SyncRoot, ...) — copying those would corrupt the ledger with garbage
    # entries that lack 'count' and break every downstream aggregation.
    if ($ledger -is [pscustomobject]) {
        foreach ($property in @($ledger.failures.PSObject.Properties)) {
            if ([string]$property.Name -eq $Signature) { continue }
            $rebuilt.failures[$property.Name] = $property.Value
        }
    }
    if ($null -ne $existing) { $rebuilt.failures[$Signature] = $existing }
    else {
        $rebuilt.failures[$Signature] = [ordered]@{
            classification = $Classification
            signature = $Signature
            evidence = $safeEvidence
            firstSeen = $now
            lastSeen = $now
            count = 1
            occurrences = @($occurrence)
        }
    }
    Write-AihAtomicJson -Path $path -Value $rebuilt

    Set-AihWorkingSetFailure -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Signature $Signature -Classification $Classification -EvidenceText $safeEvidence | Out-Null
    return $rebuilt.failures[$Signature]
}

function Get-AihFailureEntry {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[string]$Signature)
    $ledger = Read-AihFailureLedger -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if ($null -eq $ledger) { return $null }
    foreach ($property in @($ledger.failures.PSObject.Properties)) {
        if ($property.Name -eq $Signature) { return $property.Value }
    }
    return $null
}

function Get-AihFailureSnapshot {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $ledger = Read-AihFailureLedger -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $entries = @()
    if ($null -ne $ledger) {
        foreach ($property in @($ledger.failures.PSObject.Properties)) { $entries += $property.Value }
    }
    return [ordered]@{
        distinctSignatures = $entries.Count
        totalOccurrences = (@($entries | ForEach-Object { [int]$_.count } | Measure-Object -Sum).Sum)
        entries = @($entries)
    }
}
