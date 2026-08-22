Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Routing.ps1')

function Read-AihAcceptanceCriteria {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Acceptance criteria file is missing: $Path" }
    $document = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    if ($document -is [array]) { $criteria = @($document) }
    elseif ($null -ne $document.PSObject.Properties['criteria']) { $criteria = @($document.criteria) }
    else { throw 'Acceptance criteria JSON must be an array or contain a criteria array.' }
    $criteria = @($criteria)
    if ($criteria.Count -eq 0) { throw 'At least one acceptance criterion is required.' }
    return $criteria
}

function Get-AihAcceptanceAssessment {
    param([Parameter(Mandatory = $true)][object[]]$Criteria)
    $reasons = [System.Collections.Generic.List[string]]::new()
    $normalized = [System.Collections.Generic.List[object]]::new()
    $ids = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    for ($index = 0; $index -lt $Criteria.Count; $index++) {
        $entry = $Criteria[$index]
        $id = [string](Get-AihPropertyValue $entry 'id' '')
        $criterion = [string](Get-AihPropertyValue $entry 'criterion' '')
        $status = ([string](Get-AihPropertyValue $entry 'status' '')).ToLowerInvariant()
        $evidence = [string](Get-AihPropertyValue $entry 'evidence' '')
        if ([string]::IsNullOrWhiteSpace($id)) { $reasons.Add("Acceptance criterion at index $index has no id.") }
        elseif (-not $ids.Add($id)) { $reasons.Add("Acceptance criterion id is duplicated: $id") }
        if ([string]::IsNullOrWhiteSpace($criterion)) { $reasons.Add("Acceptance criterion '$id' has no criterion text.") }
        if ($status -notin @('met', 'unmet')) { $reasons.Add("Acceptance criterion '$id' status must be met or unmet.") }
        elseif ($status -eq 'unmet') { $reasons.Add("Acceptance criterion '$id' is unmet: $criterion") }
        if ([string]::IsNullOrWhiteSpace($evidence)) { $reasons.Add("Acceptance criterion '$id' has no evidence.") }
        $normalized.Add([pscustomobject]@{ id = $id; criterion = $criterion; status = $status; evidence = $evidence })
    }
    [pscustomobject]@{ Pass = $reasons.Count -eq 0; Criteria = @($normalized); Reasons = @($reasons) }
}

function ConvertFrom-AihSemanticVerifierOutput {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [string]$Provider = 'sol-local',
        [string]$Model = 'gpt-5.6-sol',
        [string]$Reasoning = 'medium'
    )
    $candidate = $Text.Trim()
    if ($candidate -match '(?s)^```(?:json)?\s*(\{.*\})\s*```$') { $candidate = $Matches[1] }
    try { $result = $candidate | ConvertFrom-Json } catch { throw "Bounded completion assessment did not return valid JSON: $($_.Exception.Message)" }
    $status = ([string](Get-AihPropertyValue $result 'status' '')).ToUpperInvariant()
    if ($status -notin @('PASS', 'FAIL')) { throw 'Bounded completion assessment status must be PASS or FAIL.' }
    $summary = [string](Get-AihPropertyValue $result 'summary' '')
    if ([string]::IsNullOrWhiteSpace($summary)) { throw 'Bounded completion assessment must provide a summary.' }
    $reasons = @((Get-AihPropertyValue $result 'concreteReasons' @()) | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $missing = @((Get-AihPropertyValue $result 'missingRequirements' @()) | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $fixes = @((Get-AihPropertyValue $result 'boundedFixes' @()) | ForEach-Object {
        [pscustomobject]@{ description = [string](Get-AihPropertyValue $_ 'description' ''); acceptanceCriteria = @((Get-AihPropertyValue $_ 'acceptanceCriteria' @()) | ForEach-Object { [string]$_ }) }
    } | Where-Object { -not [string]::IsNullOrWhiteSpace($_.description) })
    if ($status -eq 'FAIL' -and $reasons.Count -eq 0) { throw 'Bounded completion assessment FAIL must include concreteReasons.' }
    [pscustomobject]@{ status = $status; summary = $summary; concreteReasons = $reasons; missingRequirements = $missing; boundedFixes = $fixes; tier = 1; provider = $Provider; model = $Model; reasoning = $Reasoning }
}

function Get-AihResponsesOutputText {
    param([Parameter(Mandatory = $true)][object]$Response)
    $direct = [string](Get-AihPropertyValue $Response 'output_text' '')
    if (-not [string]::IsNullOrWhiteSpace($direct)) { return $direct }
    $parts = [System.Collections.Generic.List[string]]::new()
    foreach ($item in @((Get-AihPropertyValue $Response 'output' @()))) {
        foreach ($content in @((Get-AihPropertyValue $item 'content' @()))) {
            if (([string](Get-AihPropertyValue $content 'type' '')) -eq 'output_text') {
                $text = [string](Get-AihPropertyValue $content 'text' '')
                if (-not [string]::IsNullOrWhiteSpace($text)) { $parts.Add($text) }
            }
        }
    }
    if ($parts.Count -eq 0) { throw 'Bounded assessment response contained no output_text.' }
    return $parts -join "`n"
}

function Get-AihDeterministicAssessment {
    param([Parameter(Mandatory = $true)][object]$Verification)
    $failed = [int](Get-AihPropertyValue $Verification 'Failed' 1)
    $results = @((Get-AihPropertyValue $Verification 'Results' @()))
    $reasons = @($results | Where-Object { $_.Status -eq 'FAIL' } | ForEach-Object {
        $detail = @($_.Error, $_.StandardError, $_.StandardOutput | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) -join ' '
        "Deterministic check '$($_.Name)' failed$(if ($detail) { ": $($detail.Trim())" } else { '.' })"
    })
    if ($failed -gt 0 -and $reasons.Count -eq 0) { $reasons = @("Deterministic verification reported $failed failure(s).") }
    if ($results.Count -eq 0) { $reasons = @($reasons) + @('Deterministic verification returned no check results.') }
    [pscustomobject]@{ Pass = $failed -eq 0 -and $results.Count -gt 0; Reasons = $reasons; Summary = $Verification }
}

function Get-AihBoundedFixes {
    param([object]$Deterministic, [object]$Acceptance, [object]$Semantic)
    $fixes = [System.Collections.Generic.List[object]]::new()
    foreach ($result in @($Deterministic.Summary.Results | Where-Object Status -eq 'FAIL')) {
        $fixes.Add([pscustomobject]@{ source = 'deterministic-verification'; description = "Fix deterministic check '$($result.Name)': $($result.Command)"; acceptanceCriteria = @("$($result.Name) passes with exit code 0.") })
    }
    if (-not $Deterministic.Pass -and @($Deterministic.Summary.Results | Where-Object Status -eq 'FAIL').Count -eq 0) {
        $fixes.Add([pscustomobject]@{ source = 'deterministic-verification'; description = 'Configure and run at least one applicable deterministic verification check.'; acceptanceCriteria = @('Deterministic verification returns one or more check results and all required checks pass.') })
    }
    foreach ($criterion in @($Acceptance.Criteria | Where-Object { $_.status -ne 'met' -or [string]::IsNullOrWhiteSpace($_.evidence) })) {
        $fixes.Add([pscustomobject]@{ source = 'acceptance-criteria'; description = "Satisfy and evidence acceptance criterion '$($criterion.id)': $($criterion.criterion)"; acceptanceCriteria = @($criterion.criterion, 'Provide concrete evidence.') })
    }
    foreach ($reason in @($Acceptance.Reasons)) {
        $fixes.Add([pscustomobject]@{ source = 'acceptance-criteria'; description = "Correct acceptance-criteria accounting: $reason"; acceptanceCriteria = @('Every acceptance criterion has a unique id, nonempty text, met status, and concrete evidence.') })
    }
    if ($null -ne $Semantic -and $Semantic.status -eq 'FAIL') {
        foreach ($fix in @($Semantic.boundedFixes)) { $fixes.Add([pscustomobject]@{ source = 'bounded-review'; description = $fix.description; acceptanceCriteria = @($fix.acceptanceCriteria) }) }
        if (@($Semantic.boundedFixes).Count -eq 0) {
            foreach ($reason in @($Semantic.concreteReasons)) { $fixes.Add([pscustomobject]@{ source = 'bounded-review'; description = "Address bounded review failure: $reason"; acceptanceCriteria = @('The bounded review finding is resolved with deterministic evidence.') }) }
        }
    }
    @($fixes)
}

function New-AihCompletionDecision {
    param(
        [Parameter(Mandatory = $true)][object]$Deterministic,
        [Parameter(Mandatory = $true)][object]$Acceptance,
        [object]$Semantic,
        [switch]$Override,
        [string]$OverrideReason,
        [string]$OverrideOperator
    )
    $reasons = [System.Collections.Generic.List[string]]::new()
    foreach ($reason in @($Deterministic.Reasons)) { $reasons.Add($reason) }
    foreach ($reason in @($Acceptance.Reasons)) { $reasons.Add($reason) }
    if ($null -eq $Semantic -or $Semantic.status -ne 'PASS') {
        if ($null -eq $Semantic) { $reasons.Add('Controller completion assessment was not produced because a prerequisite gate failed.') }
        else { foreach ($reason in @($Semantic.concreteReasons)) { $reasons.Add("Completion assessment: $reason") } }
    }
    $basePass = $Deterministic.Pass -and $Acceptance.Pass -and $null -ne $Semantic -and $Semantic.status -eq 'PASS'
    if ($Override) {
        if ($basePass) { throw 'Completion override is not permitted when every gate already passes.' }
        if ([string]::IsNullOrWhiteSpace($OverrideOperator)) { throw '-OverrideOperator is required for an override.' }
        if ([string]::IsNullOrWhiteSpace($OverrideReason) -or $OverrideReason.Trim().Length -lt 20) { throw '-OverrideReason must contain at least 20 characters.' }
        return [pscustomobject]@{ Status = 'OVERRIDDEN'; Complete = $true; GatePass = $false; Reasons = @($reasons); Override = [pscustomobject]@{ Applied = $true; Operator = $OverrideOperator; Reason = $OverrideReason; TimestampUtc = [DateTime]::UtcNow.ToString('o') } }
    }
    [pscustomobject]@{ Status = if ($basePass) { 'PASS' } else { 'FAIL' }; Complete = $basePass; GatePass = $basePass; Reasons = @($reasons); Override = [pscustomobject]@{ Applied = $false; Operator = $null; Reason = $null; TimestampUtc = $null } }
}

function Invoke-AihCompletionFixRouting {
    param([object[]]$Fixes, [string]$GateId, [string]$Workspace, [string]$PolicyPath, [string]$RoutingData, [string]$Preset)
    $records = [System.Collections.Generic.List[object]]::new()
    $fallbackPreset = Resolve-AihPreset (Get-AihRoutingPolicy $PolicyPath) $Preset
    $fallbackRoute = (Get-AihRoutingPolicy $PolicyPath).executionClasses.deepseek_deep
    for ($index = 0; $index -lt $Fixes.Count; $index++) {
        $taskId = "$GateId-fix-$('{0:d3}' -f ($index + 1))"
        try {
            $record = Invoke-AihRoutingDecision -Description $Fixes[$index].description -Workspace $Workspace -PolicyPath $PolicyPath -DataRoot $RoutingData -TaskId $taskId -Preset $Preset
            $records.Add([pscustomobject]@{ fix = $Fixes[$index]; dispatchStatus = 'routed'; routingError = $null; routingDecision = $record })
        }
        catch {
            $fallback = [pscustomobject]@{ recordVersion = 3; taskId = $taskId; workspace = $Workspace; preset = $fallbackPreset.Id; description = $Fixes[$index].description; executionClass = 'deepseek_deep'; selectedExecutionClass = 'deepseek_deep'; provider = [string]$fallbackRoute.provider; model = [string]$fallbackRoute.model; reasoning = [string]$fallbackRoute.reasoning; reason = "Automatic routing failed; explicit controller repair dispatch is required: $($_.Exception.Message)"; risk = 'high'; escalatedFrom = $null; manualOverride = $false; signal = 'routing-error'; dryRun = $false; completionAuthority = $false }
            $records.Add([pscustomobject]@{ fix = $Fixes[$index]; dispatchStatus = 'operator-required'; routingError = $_.Exception.Message; routingDecision = $fallback })
        }
    }
    @($records)
}

function Write-AihCompletionRecord {
    param([Parameter(Mandatory = $true)][object]$Record, [Parameter(Mandatory = $true)][string]$DataRoot)
    $recordsRoot = Join-Path $DataRoot 'records'
    New-Item -ItemType Directory -Force -Path $recordsRoot | Out-Null
    $path = Join-Path $recordsRoot ("$($Record.gateId).json")
    $stream = [System.IO.FileStream]::new($path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    try {
        $writer = [System.IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
        try { $writer.Write(($Record | ConvertTo-Json -Depth 20)) } finally { $writer.Dispose() }
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    $summary = [ordered]@{ gateId = $Record.gateId; timestampUtc = $Record.timestampUtc; workspace = $Record.workspace; preset = $Record.preset; semanticVerifier = $Record.semanticVerifier; objective = $Record.objective; status = $Record.status; complete = $Record.complete; gatePass = $Record.gatePass; override = $Record.override; recordPath = $path }
    [System.IO.File]::AppendAllText((Join-Path $DataRoot 'history.jsonl'), (($summary | ConvertTo-Json -Depth 8 -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    return $path
}
