Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-AihPropertyValue {
    param([object]$Object, [string]$Name, $Default = $null)
    if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $Default
}

function Get-AihRoutingPolicy {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Routing policy is missing: $Path" }
    $policy = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    if ($policy.version -ne 1) { throw 'Routing policy version must be 1.' }
    if ([int]$policy.defaultTier -notin @(1, 2, 3)) { throw 'Routing policy defaultTier must be 1, 2, or 3.' }
    foreach ($tier in 1..3) {
        if ($null -eq $policy.tiers.PSObject.Properties[[string]$tier]) { throw "Routing policy is missing tier $tier." }
    }
    if ([string]::IsNullOrWhiteSpace([string]$policy.defaultPreset) -or $null -eq $policy.presets.PSObject.Properties[[string]$policy.defaultPreset]) {
        throw 'Routing policy must name an available defaultPreset.'
    }
    foreach ($presetProperty in @($policy.presets.PSObject.Properties)) {
        $preset = $presetProperty.Value
        foreach ($tier in 1..3) {
            $route = $preset.tiers.PSObject.Properties[[string]$tier].Value
            if ($null -eq $route -or [string]::IsNullOrWhiteSpace([string]$route.provider) -or [string]::IsNullOrWhiteSpace([string]$route.model)) {
                throw "Routing preset '$($presetProperty.Name)' is missing a valid tier $tier route."
            }
        }
        if ($null -eq $preset.semanticVerifier -or [string]::IsNullOrWhiteSpace([string]$preset.semanticVerifier.provider)) {
            throw "Routing preset '$($presetProperty.Name)' is missing its semantic verifier."
        }
    }
    foreach ($rule in @($policy.initialRules)) {
        if ([string]::IsNullOrWhiteSpace([string]$rule.id) -or [int]$rule.tier -notin @(1, 2, 3) -or @($rule.patterns).Count -eq 0) {
            throw 'Every initial routing rule requires an id, tier, and patterns.'
        }
        foreach ($pattern in @($rule.patterns)) { try { [void][regex]::new($pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase) } catch { throw "Invalid routing regex in $($rule.id): $pattern" } }
    }
    return $policy
}

function Resolve-AihPreset {
    param([object]$Policy, [string]$Preset)
    $requested = if (-not [string]::IsNullOrWhiteSpace($Preset)) { $Preset.Trim().ToLowerInvariant() }
        elseif (-not [string]::IsNullOrWhiteSpace($env:DSH_AIH_PRESET)) { $env:DSH_AIH_PRESET.Trim().ToLowerInvariant() }
        elseif (-not [string]::IsNullOrWhiteSpace($env:AIH_ACTIVE_PRESET)) { $env:AIH_ACTIVE_PRESET.Trim().ToLowerInvariant() }
        else { [string]$Policy.defaultPreset }
    switch ($requested) {
        'normal' { $requested = 'aih-engineering' }
        'engineering' { $requested = 'aih-engineering' }
        'deepseek' { $requested = 'aih-deepseek' }
    }
    $property = $Policy.presets.PSObject.Properties[$requested]
    if ($null -eq $property) { throw "Unknown preset '$Preset'. Available presets: $(@($Policy.presets.PSObject.Properties.Name) -join ', ')" }
    [pscustomobject]@{ Id = $requested; Config = $property.Value }
}

function ConvertTo-AihTierNumber {
    param([string]$Tier)
    if ([string]::IsNullOrWhiteSpace($Tier)) { return $null }
    switch ($Tier.ToLowerInvariant()) {
        '1' { return 1 }
        'tier1' { return 1 }
        '2' { return 2 }
        'tier2' { return 2 }
        '3' { return 3 }
        'tier3' { return 3 }
        default { throw "Tier override must be tier1, tier2, or tier3: $Tier" }
    }
}

function Get-AihRoutingInitialDecision {
    param([Parameter(Mandatory = $true)][string]$Description, [Parameter(Mandatory = $true)][object]$Policy)
    foreach ($rule in @($Policy.initialRules)) {
        $matchedPatterns = @($rule.patterns | Where-Object { $Description -match $_ })
        if ($matchedPatterns.Count) {
            return [pscustomobject]@{ Tier = [int]$rule.tier; Complexity = [string]$rule.complexity; Risk = [string]$rule.risk; RuleId = [string]$rule.id; Reason = [string]$rule.reason; MatchedPatterns = $matchedPatterns }
        }
    }
    [pscustomobject]@{ Tier = [int]$Policy.defaultTier; Complexity = 'low'; Risk = 'low'; RuleId = 'default-tier3'; Reason = 'No higher-tier rule matched; routine work defaults to Tier 3.'; MatchedPatterns = @() }
}

function Get-AihRoutingStatePath {
    param([string]$DataRoot, [string]$Workspace, [string]$TaskId, [string]$Preset = 'aih-engineering')
    $bytes = [Text.Encoding]::UTF8.GetBytes(([System.IO.Path]::GetFullPath($Workspace).ToLowerInvariant() + "`n" + $Preset.ToLowerInvariant() + "`n" + $TaskId))
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $name = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() + '.json' } finally { $sha.Dispose() }
    Join-Path (Join-Path $DataRoot 'states') $name
}

function Read-AihRoutingState {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json } catch { throw "Routing state is invalid: $Path" }
}

function Get-AihRoutingMutexName {
    param([string]$DataRoot)
    $bytes = [Text.Encoding]::UTF8.GetBytes([System.IO.Path]::GetFullPath($DataRoot).ToLowerInvariant())
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $suffix = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').Substring(0, 24) } finally { $sha.Dispose() }
    return "AIHarnessRouting-$suffix"
}

function Get-AihEscalationResult {
    param([int]$CurrentTier, [string]$Signal, [string]$FailureReason, [object]$State, [object]$Policy)
    $attemptFailures = [int](Get-AihPropertyValue $State 'attemptFailures' 0)
    $verificationFailures = [int](Get-AihPropertyValue $State 'verificationFailures' 0)
    $lastVerificationReason = [string](Get-AihPropertyValue $State 'lastVerificationReason' '')
    $shouldEscalate = $false
    $reason = $null
    switch ($Signal) {
        'progress' { $attemptFailures = 0; $verificationFailures = 0; $lastVerificationReason = '' }
        'minor-error' { $reason = 'A single minor error is explicitly non-escalating.' }
        'attempt-failure' {
            $attemptFailures++
            if ($attemptFailures -ge [int]$Policy.escalation.repeatedAttemptThreshold) {
                $shouldEscalate = $true
                $reason = "Relevant failure persisted across $attemptFailures attempts."
                $attemptFailures = 0
            }
            else { $reason = "Recorded attempt failure $attemptFailures; escalation threshold is $($Policy.escalation.repeatedAttemptThreshold)." }
        }
        'verification-failure' {
            if ([string]::IsNullOrWhiteSpace($FailureReason)) { throw '-FailureReason is required for verification-failure.' }
            if ($lastVerificationReason -eq $FailureReason) { $verificationFailures++ } else { $verificationFailures = 1; $lastVerificationReason = $FailureReason }
            if ($verificationFailures -ge [int]$Policy.escalation.repeatedVerificationThreshold) {
                $shouldEscalate = $true
                $reason = "Deterministic verification repeatedly failed for the same reason: $FailureReason"
                $verificationFailures = 0
            }
            else { $reason = "Recorded verification failure; another failure with the same reason is required before escalation." }
        }
        default {
            if (@($Policy.escalation.immediateSignals) -contains $Signal) { $shouldEscalate = $true; $reason = "Escalation signal reported: $Signal." }
        }
    }
    $selected = if ($shouldEscalate -and $CurrentTier -gt 1) { $CurrentTier - 1 } else { $CurrentTier }
    if ($shouldEscalate -and $CurrentTier -eq 1) { $reason = 'Tier 1 is already the highest tier; the escalation signal was recorded without further escalation.' }
    [pscustomobject]@{ SelectedTier = $selected; EscalatedFrom = if ($selected -ne $CurrentTier) { $CurrentTier } else { $null }; AttemptFailures = $attemptFailures; VerificationFailures = $verificationFailures; LastVerificationReason = $lastVerificationReason; Reason = $reason }
}

function Invoke-AihRoutingDecision {
    param(
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$PolicyPath,
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [string]$TaskId,
        [string]$Preset,
        [string]$ForceTier,
        [ValidateSet('none', 'progress', 'minor-error', 'attempt-failure', 'verification-failure', 'blocker', 'serious-uncertainty', 'architecture-required', 'acceptance-unmet', 'broad-unrelated-changes', 'tier2-failed')]
        [string]$Signal = 'none',
        [string]$FailureReason,
        [switch]$DryRun
    )
    $policy = Get-AihRoutingPolicy $PolicyPath
    $resolvedPreset = Resolve-AihPreset $policy $Preset
    $workspacePath = [System.IO.Path]::GetFullPath($Workspace)
    if ([string]::IsNullOrWhiteSpace($TaskId)) { $TaskId = [guid]::NewGuid().ToString('N') }
    if ($TaskId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw 'TaskId must use 1-128 letters, numbers, dots, underscores, or hyphens.' }
    $mutex = $null
    $lockTaken = $false
    if (-not $DryRun) {
        $mutex = [Threading.Mutex]::new($false, (Get-AihRoutingMutexName $DataRoot))
        try { $lockTaken = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $lockTaken = $true }
        if (-not $lockTaken) { $mutex.Dispose(); throw 'Timed out waiting for the routing decision-record lock.' }
    }
    try {
    $statePath = Get-AihRoutingStatePath $DataRoot $workspacePath $TaskId $resolvedPreset.Id
    $state = Read-AihRoutingState $statePath
    $initial = Get-AihRoutingInitialDecision $Description $policy
    $forced = ConvertTo-AihTierNumber $ForceTier
    $previousTier = if ($null -ne $state) { [int]$state.selectedTier } else { $null }
    $baseTier = if ($null -ne $forced) { $forced } elseif ($null -ne $previousTier) { [Math]::Min($previousTier, [int]$initial.Tier) } else { [int]$initial.Tier }
    $effectiveSignal = if ($null -ne $forced) { 'none' } else { $Signal }
    $escalation = Get-AihEscalationResult $baseTier $effectiveSignal $FailureReason $state $policy
    $selectedTier = [int]$escalation.SelectedTier
    $complexity = if ($selectedTier -eq 1) { 'high' } elseif ($selectedTier -eq 2 -and $initial.Complexity -eq 'low') { 'medium' } else { $initial.Complexity }
    $risk = if ($selectedTier -eq 1) { 'high' } elseif ($selectedTier -eq 2 -and $initial.Risk -eq 'low') { 'medium' } else { $initial.Risk }
    $reasonParts = [System.Collections.Generic.List[string]]::new()
    if ($null -ne $forced) {
        $reasonParts.Add("Manual operator override selected Tier $forced.")
        if ($Signal -ne 'none') { $reasonParts.Add("Signal '$Signal' was recorded but cannot supersede a manual override.") }
    }
    else { $reasonParts.Add($initial.Reason) }
    if (-not [string]::IsNullOrWhiteSpace($escalation.Reason)) { $reasonParts.Add($escalation.Reason) }
    $tierConfig = $resolvedPreset.Config.tiers.PSObject.Properties[[string]$selectedTier].Value
    $record = [ordered]@{
        recordVersion = 2
        recordId = [guid]::NewGuid().ToString('N')
        timestampUtc = [DateTime]::UtcNow.ToString('o')
        taskId = $TaskId
        workspace = $workspacePath
        description = $Description
        preset = $resolvedPreset.Id
        presetDisplayName = [string]$resolvedPreset.Config.displayName
        selectedTier = $selectedTier
        selectedRoute = [string]$tierConfig.name
        provider = [string]$tierConfig.provider
        model = [string]$tierConfig.model
        reasoning = [string]$tierConfig.reasoning
        reason = $reasonParts -join ' '
        complexity = $complexity
        risk = $risk
        escalatedFrom = $escalation.EscalatedFrom
        manualOverride = $null -ne $forced
        signal = $Signal
        matchedRule = $initial.RuleId
        matchedPatterns = @($initial.MatchedPatterns)
        dryRun = [bool]$DryRun
        completionAuthority = $false
    }
    if (-not $DryRun) {
        $routingRoot = [System.IO.Path]::GetFullPath($DataRoot)
        $statesRoot = Join-Path $routingRoot 'states'
        New-Item -ItemType Directory -Force -Path $statesRoot | Out-Null
        $newState = [ordered]@{ taskId = $TaskId; workspace = $workspacePath; preset = $resolvedPreset.Id; selectedTier = $selectedTier; provider = [string]$tierConfig.provider; model = [string]$tierConfig.model; attemptFailures = $escalation.AttemptFailures; verificationFailures = $escalation.VerificationFailures; lastVerificationReason = $escalation.LastVerificationReason; updatedAtUtc = [DateTime]::UtcNow.ToString('o') }
        [System.IO.File]::WriteAllText($statePath, ($newState | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        $historyPath = Join-Path $routingRoot 'decisions.jsonl'
        [System.IO.File]::AppendAllText($historyPath, (($record | ConvertTo-Json -Depth 8 -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    }
    [pscustomobject]$record
    }
    finally {
        if ($lockTaken) { $mutex.ReleaseMutex() }
        if ($null -ne $mutex) { $mutex.Dispose() }
    }
}
