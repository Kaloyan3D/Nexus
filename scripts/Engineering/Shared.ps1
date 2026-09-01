Set-StrictMode -Version Latest

# Windows PowerShell 5.1 ConvertTo-Json serializes OrderedDictionary/IDictionary
# values as the type-name STRING. Normalize every dictionary to a pscustomobject
# (recursively) before JSON emission so the CLI always emits real JSON.
function ConvertTo-AihEngineeringSerializable {
    # Thin wrapper: the canonical implementation lives in Common.ps1 so every
    # JSON writer (atomic files, JSONL lines, CLI output) shares it.
    param([object]$Value)
    return ConvertTo-AihJsonSafe $Value
}

# Engineering Mode (Phase 3.2.5) shared helpers. Deterministic, task-local.
# Every artifact is stored under <workspace>/.ai-harness/runs/<taskId>/ and
# carries the immutable taskInstanceId. An artifact whose taskInstanceId does
# not match the caller's expected instance is STALE (never merged across
# lifecycle generations).

$EngineeringEscalationReasons = @(
    'architecture-decision','conflicting-evidence','repeated-failure-new-hypothesis',
    'security-sensitive','high-risk-refactor','migration-design','cross-system-contract',
    'ambiguous-requirements','complex-debugging','provider-runtime-boundary',
    'unknown-high-impact-behavior','incompatible-invariants','uncertain-persistence-semantics'
)

$EngineeringFailureClasses = @(
    'executable-not-found','path-not-found','permission','syntax-parse',
    'patch-target-not-found','patch-ambiguous','file-changed-since-read','timeout',
    'test-failure','build-failure','dependency-environment','provider-capacity',
    'provider-response-shape','controller-infrastructure','review-context-quality','unknown'
)

$EngineeringRequirementStatuses = @('pending','implementing','implemented','verified','blocked','not-applicable')

function Get-AihEngineeringRunPath {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId)
    # Resolve the run directory for the task and fail closed on identity
    # mismatch when an expected taskInstanceId is supplied (TASK-0005 guard).
    $layout = Get-AihLedgerLayout $Workspace
    $run = Join-Path $layout.Runs $TaskId
    if (-not [string]::IsNullOrWhiteSpace($TaskInstanceId)) {
        $identity = Test-AihTaskIdentity -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
        if (-not [bool]$identity.exists) { throw "Engineering rejected: task was not found in the authoritative ledger: $TaskId" }
        if (-not [bool]$identity.instanceMatches) { throw "Engineering rejected: task $TaskId no longer holds taskInstanceId '$TaskInstanceId' (generation mismatch)." }
    }
    elseif (Test-Path -LiteralPath (Join-Path $layout.State 'tasks.json')) {
        # No instance supplied: require that the task exists at all so task-
        # scoped artifacts are never created for unknown ids.
        if (-not (Test-AihTaskExists -Workspace $Workspace -TaskId $TaskId)) { throw "Engineering rejected: task was not found in the authoritative ledger: $TaskId" }
    }
    if (-not (Test-Path -LiteralPath $run)) { New-Item -ItemType Directory -Force -Path $run | Out-Null }
    return $run
}

function Test-AihEngineeringArtifactIdentity {
    # Returns $true when the artifact is usable for the expected instance.
    # Artifacts without a taskInstanceId (never produced by this module) are
    # treated as stale for instance-aware callers and valid for legacy ones.
    param($Artifact,[string]$TaskInstanceId)
    if ($null -eq $Artifact) { return $false }
    $artifactInstance = $null
    if ($null -ne $Artifact.PSObject.Properties['taskInstanceId']) { $artifactInstance = [string]$Artifact.taskInstanceId }
    if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) { return $true }
    return (-not [string]::IsNullOrWhiteSpace($artifactInstance) -and $artifactInstance -eq $TaskInstanceId)
}

function Get-AihEngineeringSha256 {
    param([Parameter(Mandatory=$true)][string]$Text)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-AihEngineeringFileHash {
    # Deterministic content hash for invalidation; $null when unreadable.
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $stream = [IO.File]::OpenRead($Path)
            try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
            finally { $stream.Dispose() }
        } finally { $sha.Dispose() }
    } catch { return $null }
}

function Get-AihEngineeringNormalizedKey {
    # Normalized key text: materially different content produces a different
    # key; whitespace, quoting style, casing and punctuation-only rewording
    # do NOT (two-strike discipline + anti-oscillation).
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
    $normalized = $Text.ToLowerInvariant()
    $normalized = [regex]::Replace($normalized, '[^a-z0-9]+', ' ')
    $normalized = [regex]::Replace($normalized, '\s+', ' ').Trim()
    return $normalized
}

function Get-AihEngineeringHypothesisKey {
    param([string]$Hypothesis)
    $normalized = Get-AihEngineeringNormalizedKey $Hypothesis
    if ([string]::IsNullOrEmpty($normalized)) { return '' }
    return Get-AihEngineeringSha256 $normalized
}

function Get-AihEngineeringEscalationSignature {
    # Stable escalation signature: equivalent escalation requests under the
    # same task + milestone + unresolved question + hypothesis + evidence
    # state normalize to the SAME signature (anti-oscillation).
    param([string]$TaskInstanceId,[string]$MilestoneId,[string]$Question,[string]$HypothesisKey,[string]$EvidenceVersion)
    $normalizedQuestion = Get-AihEngineeringNormalizedKey $Question
    $parts = @([string]$TaskInstanceId,[string]$MilestoneId,$normalizedQuestion,[string]$HypothesisKey,[string]$EvidenceVersion)
    $joined = [string]::Join([string][char]1, $parts)
    return Get-AihEngineeringSha256 $joined
}

function ConvertTo-AihEngineeringSafeText {
    # Collapse any text into a bounded single-line record-safe string.
    param([string]$Text,[int]$MaxChars = 2000)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $single = [regex]::Replace($Text, '\r?\n', ' | ')
    if ($single.Length -gt $MaxChars) { $single = $single.Substring(0,$MaxChars) + '...' }
    return $single
}

function Redact-AihEngineeringSecrets {
    # Never persist credentials: mask common token shapes in text destined
    # for durable records. Structured diagnostics stay useful; secret values
    # do not survive.
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $patterns = @(
        '(?i)(api[-_]?key|token|secret|password|authorization)(\s*[=:]\s*)(\S{6,})',
        '\b(sk|pk)-[A-Za-z0-9_-]{8,}',
        '\bBearer\s+[A-Za-z0-9._-]{8,}',
        '\bghp_[A-Za-z0-9]{8,}',
        '\bey[J][-A-Za-z0-9_]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}'
    )
    $redacted = $Text
    foreach ($pattern in $patterns) {
        $redacted = [regex]::Replace($redacted, $pattern, { param($m)
            $value = $m.Value
            if ($value.Length -le 8) { return '[REDACTED]' }
            return $value.Substring(0,[Math]::Min(4,$value.Length)) + '...[REDACTED]'
        })
    }
    return $redacted
}

function Read-AihEngineeringJson {
    param([string]$Path,$Default)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $Default }
    try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json } catch { return $Default }
}

function Get-AihEngineeringEstimatedTokens {
    param([Parameter(Mandatory=$true)][string]$Text)
    # Deterministic estimate only; never presented as a provider metric.
    return [int][Math]::Ceiling($Text.Length / 4.0)
}

function Get-AihEngineeringUtcNow { return [DateTime]::UtcNow.ToString('o') }

function Set-AihEngineeringProperty {
    # StrictMode-safe property set: under Set-StrictMode -Version Latest,
    # assigning a property that a PSCustomObject (e.g. a parsed JSON document)
    # does not yet carry is a terminating error. This setter adds or
    # overwrites the property on any object shape (dictionaries included).
    param([Parameter(Mandatory=$true)][object]$Object,[Parameter(Mandatory=$true)][string]$Name,[AllowNull()][object]$Value)
    if ($Object -is [Collections.IDictionary]) { $Object[$Name] = $Value; return }
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}
