Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Get-AihPropertyValue { param([object]$Object,[string]$Name,$Default=$null) if($null-ne $Object-and$null-ne $Object.PSObject.Properties[$Name]){return $Object.$Name};$Default }

function Get-AihRoutingPolicy {
    param([Parameter(Mandatory=$true)][string]$Path)
    if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw "Routing policy is missing: $Path"}
    $policy=Get-Content -Raw -LiteralPath $Path|ConvertFrom-Json
    if([int]$policy.version -ne 2){throw 'Routing policy version must be 2.'}
    foreach($name in @('deterministic','deepseek_normal','deepseek_deep','codex_review','codex_solve')){if($null-eq $policy.executionClasses.PSObject.Properties[$name]){throw "Routing policy is missing execution class $name."}}
    if($null-eq $policy.presets.PSObject.Properties[[string]$policy.defaultPreset]){throw 'Routing policy defaultPreset is invalid.'}
    foreach($rule in @($policy.initialRules)){foreach($pattern in @($rule.patterns)){try{[void][regex]::new($pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)}catch{throw "Invalid routing regex in $($rule.id): $pattern"}}}
    $policy
}

function Resolve-AihPreset {
    param([object]$Policy,[string]$Preset)
    $requested=if(-not[string]::IsNullOrWhiteSpace($Preset)){$Preset.Trim().ToLowerInvariant()}elseif(-not[string]::IsNullOrWhiteSpace($env:DSH_AIH_PRESET)){$env:DSH_AIH_PRESET.Trim().ToLowerInvariant()}elseif(-not[string]::IsNullOrWhiteSpace($env:AIH_ACTIVE_PRESET)){$env:AIH_ACTIVE_PRESET.Trim().ToLowerInvariant()}else{[string]$Policy.defaultPreset}
    switch($requested){'normal'{$requested='aih-engineering'}'engineering'{$requested='aih-engineering'}'deepseek'{$requested='aih-deepseek'}}
    $property=$Policy.presets.PSObject.Properties[$requested];if($null-eq $property){throw "Unknown preset '$Preset'."}
    [pscustomobject]@{Id=$requested;Config=$property.Value}
}

function ConvertTo-AihExecutionClass {
    param([string]$Value,[object]$Policy)
    if([string]::IsNullOrWhiteSpace($Value)){return $null}
    $key=$Value.Trim().ToLowerInvariant();if($key-match'^[123]$'){$key='tier'+$key}
    if($null-ne $Policy.legacyTierMap.PSObject.Properties[$key]){return [string]$Policy.legacyTierMap.$key}
    if($null-ne $Policy.executionClasses.PSObject.Properties[$key]){return $key}
    throw "Invalid execution class or legacy tier: $Value"
}

function Get-AihLegacyTier {param([string]$ExecutionClass)switch($ExecutionClass){'codex_review'{1}'codex_solve'{1}'deepseek_deep'{2}default{3}}}
function Get-AihRoutingStatePath {param([string]$DataRoot,[string]$Workspace,[string]$TaskId,[string]$Preset='aih-engineering')$bytes=[Text.Encoding]::UTF8.GetBytes(([IO.Path]::GetFullPath($Workspace).ToLowerInvariant()+"`n"+$Preset.ToLowerInvariant()+"`n"+$TaskId));$sha=[Security.Cryptography.SHA256]::Create();try{$name=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()+'.json'}finally{$sha.Dispose()};Join-Path (Join-Path $DataRoot 'states') $name}
function Read-AihRoutingState {param([string]$Path)if(-not(Test-Path -LiteralPath $Path)){return $null};try{Get-Content -Raw -LiteralPath $Path|ConvertFrom-Json}catch{throw "Routing state is invalid: $Path"}}
function Get-AihRoutingMutexName {param([string]$DataRoot)$bytes=[Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($DataRoot).ToLowerInvariant());$sha=[Security.Cryptography.SHA256]::Create();try{$suffix=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').Substring(0,24)}finally{$sha.Dispose()};"AIHarnessRouting-$suffix"}

function Get-AihRoutingInitialDecision {
    param([string]$Description,[object]$Policy)
    foreach($rule in @($Policy.initialRules)){$matched=@($rule.patterns|Where-Object{$Description-match$_});if($matched.Count){return [pscustomobject]@{ExecutionClass=[string]$rule.executionClass;Risk=[string]$rule.risk;ReviewRequired=[bool]$rule.reviewRequired;RuleId=[string]$rule.id;Reason=[string]$rule.reason;MatchedPatterns=$matched}}}
    [pscustomobject]@{ExecutionClass=[string]$Policy.defaultExecutionClass;Risk='normal';ReviewRequired=$false;RuleId='default-deepseek';Reason='Ordinary engineering work defaults to DeepSeek V4 Flash.';MatchedPatterns=@()}
}

function Get-AihFailureSignature {param([string]$FailureReason)if([string]::IsNullOrWhiteSpace($FailureReason)){return ''};$normalized=($FailureReason.ToLowerInvariant()-replace '\b\d+\b','#'-replace '\s+',' ').Trim();$bytes=[Text.Encoding]::UTF8.GetBytes($normalized);$sha=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').Substring(0,16).ToLowerInvariant()}finally{$sha.Dispose()}}

function Invoke-AihRoutingDecision {
    param([Parameter(Mandatory=$true)][string]$Description,[Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$PolicyPath,[Parameter(Mandatory=$true)][string]$DataRoot,[string]$TaskId,[string]$Preset,[string]$ForceTier,[string]$ForceClass,[string]$Signal='none',[string]$FailureReason,[switch]$UserApprovedCodexSolve,[switch]$ReviewRequested,[switch]$DryRun)
    $policy=Get-AihRoutingPolicy $PolicyPath;$resolved=Resolve-AihPreset $policy $Preset;$workspacePath=[IO.Path]::GetFullPath($Workspace)
    if([string]::IsNullOrWhiteSpace($TaskId)){$TaskId=[guid]::NewGuid().ToString('N')};if($TaskId-notmatch'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'){throw 'TaskId is invalid.'}
    $mutex=$null;$taken=$false;if(-not $DryRun){$mutex=[Threading.Mutex]::new($false,(Get-AihRoutingMutexName $DataRoot));try{$taken=$mutex.WaitOne(30000)}catch [Threading.AbandonedMutexException]{$taken=$true};if(-not $taken){throw 'Timed out waiting for routing lock.'}}
    try{
        $statePath=Get-AihRoutingStatePath $DataRoot $workspacePath $TaskId $resolved.Id;$state=Read-AihRoutingState $statePath;$initial=Get-AihRoutingInitialDecision $Description $policy
        $overrideValue=if(-not[string]::IsNullOrWhiteSpace($ForceClass)){$ForceClass}else{$ForceTier};$forced=ConvertTo-AihExecutionClass $overrideValue $policy
        $current=if($null-ne$forced){$forced}elseif($null-ne$state){[string]$state.executionClass}else{[string]$initial.ExecutionClass}
        $signature=Get-AihFailureSignature $FailureReason;$sameCount=if($null-ne$state-and$state.lastFailureSignature-eq$signature-and-not[string]::IsNullOrWhiteSpace($signature)){[int]$state.sameFailureCount}else{0}
        if($Signal-in@('attempt-failure','verification-failure')){if([string]::IsNullOrWhiteSpace($FailureReason)){throw '-FailureReason is required for failure signals.'};$sameCount++}elseif($Signal-eq'progress'){$sameCount=0;$signature=''}
        $reason=[string]$initial.Reason;$escalatedFrom=$null;$reviewRequired=[bool]$initial.ReviewRequired;$risk=[string]$initial.Risk
        if($null -ne $state){if($null -ne $state.PSObject.Properties['reviewRequired']){$reviewRequired=$reviewRequired -or [bool]$state.reviewRequired};if($null -ne $state.PSObject.Properties['risk'] -and [string]$state.risk -ne 'normal'){$risk=[string]$state.risk}}
        if($null-ne$forced){$reason="Manual operator override selected $forced."}
        elseif($ReviewRequested -and $resolved.Id -eq 'aih-deepseek'){throw 'Codex is disabled by the DeepSeek-only preset.'}
        elseif($ReviewRequested){$escalatedFrom=$current;$current='codex_review';$reviewRequired=$true;$reason='Explicit user-requested bounded Codex review (reviewRequested metadata; controller-owned, fresh, read-only).'}
        elseif($Signal-eq'review-findings'-and$current-eq'codex_review'){$escalatedFrom='codex_review';$current='deepseek_deep';$sameCount=0;$reason='Bounded Codex findings return to DeepSeek for implementation; Codex does not remain the parent.'}
        elseif($resolved.Id-eq'aih-deepseek'-and$Signal-eq'user-codex'){throw 'Codex is disabled by the DeepSeek-only preset.'}
        elseif(@($policy.escalation.immediateReviewSignals)-contains$Signal){$escalatedFrom=$current;$current='codex_review';$reviewRequired=$true;$reason="Evidence-based bounded Codex review signal: $Signal."}
        elseif($sameCount-ge[int]$policy.escalation.sameFailureThreshold){$escalatedFrom=$current;if($current-eq'deepseek_normal'){$current='deepseek_deep'}elseif($current-eq'deepseek_deep'){$current=if($resolved.Config.allowCodexSubagent){'codex_review'}else{'deepseek_deep'}};$sameCount=0;$reason='The same meaningful failure repeated at the configured threshold; escalation is scoped to that failure.'}
        $route=$policy.executionClasses.PSObject.Properties[$current].Value;if($current-eq'codex_solve'-and-not$UserApprovedCodexSolve){throw 'codex_solve requires the explicit -UserApprovedCodexSolve operator flag.'}
        $record=[ordered]@{recordVersion=3;recordId=[guid]::NewGuid().ToString('N');timestampUtc=[DateTime]::UtcNow.ToString('o');taskId=$TaskId;workspace=$workspacePath;description=$Description;preset=$resolved.Id;selectedExecutionClass=$current;executionClass=$current;provider=$route.provider;model=$route.model;reasoning=$route.reasoning;writable=[bool]$route.writable;risk=$risk;reviewRequired=$reviewRequired;reviewRequested=[bool]$ReviewRequested;reason=$reason;escalatedFrom=$escalatedFrom;manualOverride=$null-ne$forced;signal=$Signal;failureSignature=$signature;sameFailureCount=$sameCount;matchedRule=$initial.RuleId;matchedPatterns=@($initial.MatchedPatterns);freshSession=$true;completionAuthority=$false;selectedTier=(Get-AihLegacyTier $current);legacyTierDeprecated=$true;dryRun=[bool]$DryRun}
        if(-not$DryRun){New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot 'states')|Out-Null;$newState=[ordered]@{taskId=$TaskId;workspace=$workspacePath;preset=$resolved.Id;executionClass=$current;selectedTier=(Get-AihLegacyTier $current);risk=$risk;reviewRequired=$reviewRequired;reviewRequested=[bool]$ReviewRequested;lastFailureSignature=$signature;sameFailureCount=$sameCount;updatedAtUtc=[DateTime]::UtcNow.ToString('o')};Write-AihAtomicJson $statePath $newState;Add-AihJsonLine (Join-Path $DataRoot 'decisions.jsonl') $record}
        [pscustomobject]$record
    }finally{if($taken){$mutex.ReleaseMutex()};if($null-ne$mutex){$mutex.Dispose()}}
}
