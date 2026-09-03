Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Get-AihPropertyValue { param([object]$Object,[string]$Name,$Default=$null) if($null-ne $Object-and$null-ne $Object.PSObject.Properties[$Name]){return $Object.$Name};$Default }

# ── Phase 2: generalized execution model ───────────────────────────────────
# Execution classes describe EXECUTION SEMANTICS, never model identity:
#   engineer_normal -> the primaryEngineer role of the ACTIVE engineering profile
#   engineer_deep   -> the deepEngineer role
#   reviewer        -> the reviewer role (read-only, controller-owned)
#   solver          -> the solver role (writable only under explicit approval)
# The active Engineering Profile (config/engineering-profiles.json) binds each
# role to a model-registry entry (config/model-registry.json) which resolves
# the provider configuration identifier. Routing selects the class; the
# profile decides WHICH model fulfills it. Legacy execution class names
# (deepseek_normal / deepseek_deep / codex_review / codex_solve) remain
# readable compatibility aliases everywhere records are consumed.

function Get-AihEngineeringProfiles {
    param([Parameter(Mandatory=$true)][string]$Path,[string]$CustomProfilePath)
    if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw "Engineering profiles are missing: $Path"}
    $profiles=Get-Content -Raw -Encoding UTF8 -LiteralPath $Path|ConvertFrom-Json
    if([int]$profiles.schemaVersion -ne 1){throw 'Engineering profiles schemaVersion must be 1.'}
    if($null-eq$profiles.PSObject.Properties['profiles']-or@($profiles.profiles).Count-eq0){throw 'Engineering profiles must declare at least one profile.'}
    # Phase 2.1: the operator-defined CUSTOM profile (data/custom-engineering-profile.json)
    # is merged into the profile list as id 'custom'. Built-in registry files are
    # never mutated; the custom file is validated with the SAME per-profile rules.
    $customList=@()
    if(-not[string]::IsNullOrWhiteSpace($CustomProfilePath)-and(Test-Path -LiteralPath $CustomProfilePath -PathType Leaf)){
        $custom=Get-Content -Raw -Encoding UTF8 -LiteralPath $CustomProfilePath|ConvertFrom-Json
        if([int]$custom.schemaVersion -ne 1){throw 'Custom engineering profile schemaVersion must be 1.'}
        $customProfile=[ordered]@{id='custom';displayName='Custom';description='Operator-defined engineering profile (Phase 2.1 editor).'}
        if($null-eq$custom.PSObject.Properties['roles']){throw 'Custom engineering profile is missing roles.'}
        $customProfile.roles=$custom.roles
        $customList=@([pscustomobject]$customProfile)
    }
    foreach($profile in @($profiles.profiles)+@($customList)){
        if([string]::IsNullOrWhiteSpace([string]$profile.id)){throw 'Engineering profile is missing an id.'}
        if($null-eq$profile.PSObject.Properties['roles']){throw "Engineering profile $($profile.id) is missing roles."}
        foreach($role in @('primaryEngineer','deepEngineer','reviewer','solver','fallback')){
            if($null-eq$profile.roles.PSObject.Properties[$role]){throw "Engineering profile $($profile.id) is missing role $role."}
            if([string]::IsNullOrWhiteSpace([string]$profile.roles.$role.model)){throw "Engineering profile $($profile.id) role $role has no model binding."}
            if($null-eq$profile.roles.$role.PSObject.Properties['reasoning']-or[string]::IsNullOrWhiteSpace([string]$profile.roles.$role.reasoning)){throw "Engineering profile $($profile.id) role $role has no reasoning binding."}
        }
    }
    $profiles.profiles=@($profiles.profiles)+@($customList)
    $profiles
}

function Get-AihModelRegistry {
    param([Parameter(Mandatory=$true)][string]$Path)
    if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw "Model registry is missing: $Path"}
    $registry=Get-Content -Raw -Encoding UTF8 -LiteralPath $Path|ConvertFrom-Json
    if([int]$registry.schemaVersion -ne 1){throw 'Model registry schemaVersion must be 1.'}
    if($null-eq$registry.PSObject.Properties['models']-or@($registry.models).Count-eq0){throw 'Model registry must declare at least one model.'}
    foreach($model in @($registry.models)){
        if([string]::IsNullOrWhiteSpace([string]$model.id)){throw 'Model registry entry is missing an id.'}
        if([string]::IsNullOrWhiteSpace([string]$model.displayName)){throw "Model registry entry $($model.id) is missing displayName."}
        if($null-eq$model.PSObject.Properties['enabled']){throw "Model registry entry $($model.id) is missing enabled."}
    }
    $registry
}

function Get-AihRoutingPolicy {
    param([Parameter(Mandatory=$true)][string]$Path)
    if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw "Routing policy is missing: $Path"}
    $policy=Get-Content -Raw -LiteralPath $Path|ConvertFrom-Json
    if([int]$policy.version -ne 3){throw 'Routing policy version must be 3.'}
    foreach($name in @('deterministic','engineer_normal','engineer_deep','reviewer','solver')){if($null-eq $policy.executionClasses.PSObject.Properties[$name]){throw "Routing policy is missing execution class $name."}}
    foreach($name in @('deepseek_normal','deepseek_deep','codex_review','codex_solve')){if($null-eq $policy.executionClassAliases.PSObject.Properties[$name]){throw "Routing policy is missing compatibility alias $name."}}
    if([string]::IsNullOrWhiteSpace([string]$policy.defaultProfile)){throw 'Routing policy defaultProfile is required.'}
    if($null-eq $policy.presets.PSObject.Properties[[string]$policy.defaultPreset]){throw 'Routing policy defaultPreset is invalid.'}
    foreach($presetName in @($policy.presets.PSObject.Properties.Name)){
        $preset=$policy.presets.$presetName
        if([string]::IsNullOrWhiteSpace([string]$preset.profile)){throw "Routing policy preset $presetName is missing a profile binding."}
    }
    foreach($rule in @($policy.initialRules)){
        $canonical=ConvertTo-AihExecutionClass ([string]$rule.executionClass) $policy
        if($null-eq$policy.executionClasses.PSObject.Properties[$canonical]){throw "Invalid initial-rule execution class in $($rule.id): $($rule.executionClass)"}
        foreach($pattern in @($rule.patterns)){try{[void][regex]::new($pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)}catch{throw "Invalid routing regex in $($rule.id): $pattern"}}
    }
    $policy
}

function Resolve-AihPreset {
    param([object]$Policy,[string]$Preset)
    $requested=if(-not[string]::IsNullOrWhiteSpace($Preset)){$Preset.Trim().ToLowerInvariant()}elseif(-not[string]::IsNullOrWhiteSpace($env:DSH_AIH_PRESET)){$env:DSH_AIH_PRESET.Trim().ToLowerInvariant()}elseif(-not[string]::IsNullOrWhiteSpace($env:AIH_ACTIVE_PRESET)){$env:AIH_ACTIVE_PRESET.Trim().ToLowerInvariant()}else{[string]$Policy.defaultPreset}
    switch($requested){'normal'{$requested='aih-engineering'}'engineering'{$requested='aih-engineering'}'deepseek'{$requested='aih-deepseek'}}
    $property=$Policy.presets.PSObject.Properties[$requested];if($null-eq $property){throw "Unknown preset '$Preset'."}
    [pscustomobject]@{Id=$requested;Config=$property.Value}
}

# Resolve the ACTIVE engineering profile for a routing decision.
# Priority: DSH_AIH_PROFILE env -> AIH_ACTIVE_PROFILE env -> settings.yaml
# `engineering-profile:` key -> the preset's own profile binding -> policy
# defaultProfile. Presets that declare profileOverrideAllowed:false (the
# DeepSeek-only preset) are locked to their own binding and ignore the
# global overrides, so DeepSeek-only can never silently route engineer roles
# to another vendor.
function Resolve-AihProfile {
    param([object]$Policy,[object]$Preset,[object]$Profiles,[string]$SettingsPath)
    $overrideAllowed=$true
    if($null-ne $Preset-and$null-ne $Preset.Config.PSObject.Properties['profileOverrideAllowed']){$overrideAllowed=[bool]$Preset.Config.profileOverrideAllowed}
    $requested=$null
    if($overrideAllowed){
        if(-not[string]::IsNullOrWhiteSpace($env:DSH_AIH_PROFILE)){$requested=$env:DSH_AIH_PROFILE.Trim().ToLowerInvariant()}
        elseif(-not[string]::IsNullOrWhiteSpace($env:AIH_ACTIVE_PROFILE)){$requested=$env:AIH_ACTIVE_PROFILE.Trim().ToLowerInvariant()}
        elseif(-not[string]::IsNullOrWhiteSpace($SettingsPath)-and(Test-Path -LiteralPath $SettingsPath)){
            $settingsText=Get-Content -Raw -Encoding UTF8 -LiteralPath $SettingsPath
            $match=[regex]::Match($settingsText,'(?m)^engineering-profile:\s*([^\s#\r\n]+)')
            if($match.Success){$requested=$match.Groups[1].Value.Trim().Trim('''','"').ToLowerInvariant()}
        }
    }
    if([string]::IsNullOrWhiteSpace($requested)-and$null-ne $Preset-and$null-ne $Preset.Config.PSObject.Properties['profile']){$requested=[string]$Preset.Config.profile}
    if([string]::IsNullOrWhiteSpace($requested)){$requested=[string]$Policy.defaultProfile}
    $requested=$requested.Trim().ToLowerInvariant()
    $profile=$null
    foreach($candidate in @($Profiles.profiles)){if([string]$candidate.id -eq $requested){$profile=$candidate;break}}
    if($null-eq $profile){throw "Unknown engineering profile '$requested'."}
    [pscustomobject]@{Id=[string]$profile.id;DisplayName=[string]$profile.displayName;Config=$profile}
}

function ConvertTo-AihExecutionClass {
    param([string]$Value,[object]$Policy)
    if([string]::IsNullOrWhiteSpace($Value)){return $null}
    $key=$Value.Trim().ToLowerInvariant();if($key-match'^[123]$'){$key='tier'+$key}
    if($null-ne $Policy.executionClasses.PSObject.Properties[$key]){return $key}
    if($null-ne $Policy.executionClassAliases.PSObject.Properties[$key]){return [string]$Policy.executionClassAliases.$key}
    if($null-ne $Policy.legacyTierMap.PSObject.Properties[$key]){return [string]$Policy.legacyTierMap.$key}
    throw "Invalid execution class or legacy tier: $Value"
}

function Get-AihRoleForExecutionClass {param([object]$Policy,[string]$ExecutionClass)$canonical=ConvertTo-AihExecutionClass $ExecutionClass $Policy;$def=$Policy.executionClasses.PSObject.Properties[$canonical].Value;if($null-ne $def-and$null-ne $def.PSObject.Properties['role']-and-not[string]::IsNullOrWhiteSpace([string]$def.role)){[string]$def.role}else{$null}}

# Resolve provider/model/reasoning for one role through the ACTIVE profile and
# the MODEL REGISTRY. This is the only place routing touches model identity:
# routing selects semantics (the class), the profile binds the role, and the
# registry maps the model to a provider configuration identifier. No vendor
# conditionals exist here or anywhere in the controller.
function Resolve-AihModelTarget {
    param([object]$Registry,[object]$Profile,[string]$Role)
    $roles=$Profile.Config.roles
    if($null-eq $roles.PSObject.Properties[$Role]){throw "Engineering profile $($Profile.Id) has no binding for role $Role."}
    $binding=$roles.$Role
    $modelId=[string]$binding.model
    $reasoning=[string]$binding.reasoning
    $entry=$null
    foreach($candidate in @($Registry.models)){if([string]$candidate.id -eq $modelId){$entry=$candidate;break}}
    if($null-eq $entry){throw "Model registry has no entry for '$modelId' (profile $($Profile.Id), role $Role)."}
    if(-not[bool]$entry.enabled){throw "Model '$modelId' is disabled in the registry (profile $($Profile.Id), role $Role)."}
    $provider=$null
    $providerMap=if($null-ne $entry.PSObject.Properties['providers']){$entry.providers}else{$null}
    if($null-ne $providerMap){
        if($null-ne $providerMap.PSObject.Properties[$reasoning]){$provider=[string]$providerMap.$reasoning}
        elseif($null-ne $providerMap.PSObject.Properties['default']){$provider=[string]$providerMap.default}
    }
    if([string]::IsNullOrWhiteSpace($provider)-and$null-ne $entry.PSObject.Properties['provider']){$provider=[string]$entry.provider}
    if([string]::IsNullOrWhiteSpace($provider)){throw "Model '$modelId' has no provider resolution (profile $($Profile.Id), role $Role)."}
    [pscustomobject]@{ModelId=$modelId;Model=if($null-ne $entry.PSObject.Properties['model']-and-not[string]::IsNullOrWhiteSpace([string]$entry.model)){[string]$entry.model}else{$modelId};ModelDisplayName=[string]$entry.displayName;Vendor=[string]$entry.vendor;Provider=$provider;Reasoning=$reasoning}
}

# ── Phase 2.1: Engineering Profile editor — capability validation ─────────
# The editor exposes role -> model bindings from the Model Registry. These
# rules are the BACKEND contract: a model may be assigned to a role only when
# the registry entry supports the capabilities that role needs in the current
# runtime. The UI mirrors these rules for dropdown filtering; the controller
# re-validates on every save (fail closed, atomic, never partial).

function Get-AihRoleRequirements {
    param([string]$Role)
    # Phase V0/V1 (visual review): visualReviewer is an OPTIONAL logical role —
    # orthogonal verification capability, NOT a new execution class. It is
    # read-only, needs no tools and no sol-local transport, and is the only
    # role that REQUIRES vision. Absence from a (legacy/custom) profile is
    # valid everywhere bindings are checked.
    switch($Role){
        'primaryEngineer' { [pscustomobject]@{writable=$true;requiresTools=$true;requiresSolLocal=$false;requiresReasoning=$true;requiresVision=$false} }
        'deepEngineer'    { [pscustomobject]@{writable=$true;requiresTools=$true;requiresSolLocal=$false;requiresReasoning=$true;requiresVision=$false} }
        'fallback'        { [pscustomobject]@{writable=$true;requiresTools=$true;requiresSolLocal=$false;requiresReasoning=$true;requiresVision=$false} }
        'reviewer'        { [pscustomobject]@{writable=$false;requiresTools=$false;requiresSolLocal=$true;requiresReasoning=$true;requiresVision=$false} }
        'solver'          { [pscustomobject]@{writable=$true;requiresTools=$false;requiresSolLocal=$false;requiresReasoning=$true;requiresVision=$false} }
        'visualReviewer'  { [pscustomobject]@{writable=$false;requiresTools=$false;requiresSolLocal=$false;requiresReasoning=$true;requiresVision=$true} }
        default { throw "Unknown engineering role: $Role" }
    }
}

function Get-AihModelResolvedProvider {
    param([object]$Entry,[string]$Reasoning)
    $providerMap=if($null-ne$Entry.PSObject.Properties['providers']){$Entry.providers}else{$null}
    if($null-ne$providerMap){
        if(-not[string]::IsNullOrWhiteSpace($Reasoning)-and$null-ne$providerMap.PSObject.Properties[$Reasoning]){return [string]$providerMap.$Reasoning}
        if($null-ne$providerMap.PSObject.Properties['default']){return [string]$providerMap.default}
    }
    if($null-ne$Entry.PSObject.Properties['provider']-and-not[string]::IsNullOrWhiteSpace([string]$Entry.provider)){return [string]$Entry.provider}
    return $null
}

function Test-AihModelRoleCompatible {
    param([object]$Entry,[string]$Role,[string]$Reasoning)
    if($null-eq$Entry){return $false}
    if($null-ne$Entry.PSObject.Properties['enabled']-and-not[bool]$Entry.enabled){return $false}
    $req=Get-AihRoleRequirements $Role
    if($req.requiresReasoning-and$null-ne$Entry.PSObject.Properties['supportsReasoning']-and-not[bool]$Entry.supportsReasoning){return $false}
    if($req.requiresTools-and$null-ne$Entry.PSObject.Properties['supportsTools']-and-not[bool]$Entry.supportsTools){return $false}
    # A vision role fails closed unless the registry entry EXPLICITLY declares
    # supportsVision=true — a missing capability declaration is never treated
    # as vision-capable.
    if($req.requiresVision){
        if($null-eq$Entry.PSObject.Properties['supportsVision']){return $false}
        if(-not[bool]$Entry.supportsVision){return $false}
    }
    if($req.requiresSolLocal){
        $resolved=Get-AihModelResolvedProvider $Entry $Reasoning
        if($resolved-ne'sol-local'){return $false}
    }
    if(-not[string]::IsNullOrWhiteSpace($Reasoning)){
        $levels=@();if($null-ne$Entry.PSObject.Properties['supportedReasoningLevels']){$levels=@($Entry.supportedReasoningLevels)}
        if(@($levels|Where-Object{$_-eq$Reasoning}).Count-eq0){return $false}
        $resolved=Get-AihModelResolvedProvider $Entry $Reasoning
        if([string]::IsNullOrWhiteSpace($resolved)){return $false}
    }
    return $true
}

function Get-AihCompatibleModelsForRole {
    param([object]$Registry,[string]$Role,[string]$Reasoning='')
    foreach($entry in @($Registry.models)){
        if(Test-AihModelRoleCompatible $entry $Role $Reasoning){Write-Output ([string]$entry.id)}
    }
}

function Get-AihRoleBindingTarget {
    param([object]$Registry,[object]$Profile,[string]$Role,[string]$Reasoning)
    # Validate a role binding WITHOUT throwing; returns $null when invalid.
    $roles=$Profile.roles
    if($null-eq$roles.PSObject.Properties[$Role]){return $null}
    $binding=$roles.$Role
    $modelId=[string]$binding.model
    if([string]::IsNullOrWhiteSpace($modelId)){return $null}
    $reasoning=if([string]::IsNullOrWhiteSpace($Reasoning)){[string]$binding.reasoning}else{$Reasoning}
    $entry=$null
    foreach($candidate in @($Registry.models)){if([string]$candidate.id -eq $modelId){$entry=$candidate;break}}
    if($null-eq$entry){return $null}
    if(-not(Test-AihModelRoleCompatible $entry $Role $reasoning)){return $null}
    $provider=Get-AihModelResolvedProvider $entry $reasoning
    if([string]::IsNullOrWhiteSpace($provider)){return $null}
    [pscustomobject]@{ModelId=$modelId;Model=[string]$entry.model;ModelDisplayName=[string]$entry.displayName;Vendor=[string]$entry.vendor;Provider=$provider;Reasoning=$reasoning}
}

function Test-AihEngineeringProfileBindings {
    param([object]$Registry,[object]$Profile)
    # Returns @{ok;error} — never throws. All five CORE roles must bind a known,
    # enabled, capability-compatible model with a supported reasoning level.
    # visualReviewer is an OPTIONAL role: its absence never invalidates a
    # (legacy/custom) profile, but when a binding IS present it must satisfy
    # the same capability rules (checked where the visual review resolves it).
    foreach($role in @('primaryEngineer','deepEngineer','reviewer','solver','fallback')){
        $target=Get-AihRoleBindingTarget $Registry $Profile $role
        if($null-eq$target){return @{ok=$false;error="role '$role' is not satisfied by any compatible enabled model"}}
    }
    @{ok=$true;error=$null}
}

function Get-AihLegacyTier {param([string]$ExecutionClass)switch($ExecutionClass){'reviewer'{1}'codex_review'{1}'solver'{1}'codex_solve'{1}'engineer_deep'{2}'deepseek_deep'{2}default{3}}}
# TASK-0005 Part 14: durable routing-state identity.
# For tasks with an immutable taskInstanceId the state file is keyed by
#   normalized workspace + preset + taskInstanceId
# so two lifecycle generations of one display id (TASK-0004 gen A vs gen B)
# can never share routing state. taskId remains the key ONLY for legacy tasks
# created before instance identity existed (explicit compatibility path). The
# third key component IS the instance when one is supplied, so an
# instance-aware state file can never collide with a legacy taskId-only file.
function Get-AihRoutingStatePath {param([string]$DataRoot,[string]$Workspace,[string]$TaskId,[string]$Preset='aih-engineering',[string]$TaskInstanceId)$identity=if(-not[string]::IsNullOrWhiteSpace($TaskInstanceId)){$TaskInstanceId}else{$TaskId};$bytes=[Text.Encoding]::UTF8.GetBytes(([IO.Path]::GetFullPath($Workspace).ToLowerInvariant()+"`n"+$Preset.ToLowerInvariant()+"`n"+$identity));$sha=[Security.Cryptography.SHA256]::Create();try{$name=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()+'.json'}finally{$sha.Dispose()};Join-Path (Join-Path $DataRoot 'states') $name}
function Read-AihRoutingState {param([string]$Path)if(-not(Test-Path -LiteralPath $Path)){return $null};try{Get-Content -Raw -LiteralPath $Path|ConvertFrom-Json}catch{throw "Routing state is invalid: $Path"}}
function Get-AihRoutingMutexName {param([string]$DataRoot)$bytes=[Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($DataRoot).ToLowerInvariant());$sha=[Security.Cryptography.SHA256]::Create();try{$suffix=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').Substring(0,24)}finally{$sha.Dispose()};"AIHarnessRouting-$suffix"}

function Get-AihRoutingInitialDecision {
    param([string]$Description,[object]$Policy)
    foreach($rule in @($Policy.initialRules)){$matched=@($rule.patterns|Where-Object{$Description-match$_});if($matched.Count){return [pscustomobject]@{ExecutionClass=ConvertTo-AihExecutionClass ([string]$rule.executionClass) $Policy;Risk=[string]$rule.risk;ReviewRequired=[bool]$rule.reviewRequired;RuleId=[string]$rule.id;Reason=[string]$rule.reason;MatchedPatterns=$matched}}}
    [pscustomobject]@{ExecutionClass=ConvertTo-AihExecutionClass ([string]$Policy.defaultExecutionClass) $Policy;Risk='normal';ReviewRequired=$false;RuleId='default-engineering';Reason='Ordinary engineering work defaults to the primary engineer role of the active engineering profile.';MatchedPatterns=@()}
}

function Get-AihFailureSignature {param([string]$FailureReason)if([string]::IsNullOrWhiteSpace($FailureReason)){return ''};$normalized=($FailureReason.ToLowerInvariant()-replace '\b\d+\b','#'-replace '\s+',' ').Trim();$bytes=[Text.Encoding]::UTF8.GetBytes($normalized);$sha=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').Substring(0,16).ToLowerInvariant()}finally{$sha.Dispose()}}

function Invoke-AihRoutingDecision {
    # TASK-0005 Part 16: when -TaskInstanceId is supplied the routing request
    # is instance-guarded (fail closed on mismatch against the authoritative
    # ledger) and the durable state/decision records carry the lifecycle
    # identity (Part 15). Legacy callers that omit it keep the exact old
    # behavior (explicit compatibility path).
    param([Parameter(Mandatory=$true)][string]$Description,[Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$PolicyPath,[Parameter(Mandatory=$true)][string]$DataRoot,[string]$TaskId,[string]$Preset,[string]$ForceTier,[string]$ForceClass,[string]$Signal='none',[string]$FailureReason,[switch]$UserApprovedCodexSolve,[switch]$ReviewRequested,[switch]$DryRun,[string]$SettingsPath,[string]$CustomProfilePath,[string]$TaskInstanceId)
    $policy=Get-AihRoutingPolicy $PolicyPath;$profilesPath=Join-Path (Split-Path -Parent $PolicyPath) 'engineering-profiles.json';$registryPath=Join-Path (Split-Path -Parent $PolicyPath) 'model-registry.json'
    $profiles=Get-AihEngineeringProfiles $profilesPath $CustomProfilePath;$registry=Get-AihModelRegistry $registryPath
    $resolved=Resolve-AihPreset $policy $Preset;$profile=Resolve-AihProfile $policy $resolved $profiles $SettingsPath
    $workspacePath=[IO.Path]::GetFullPath($Workspace)
    if([string]::IsNullOrWhiteSpace($TaskId)){$TaskId=[guid]::NewGuid().ToString('N')};if($TaskId-notmatch'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'){throw 'TaskId is invalid.'}
    $mutex=$null;$taken=$false;if(-not $DryRun){$mutex=[Threading.Mutex]::new($false,(Get-AihRoutingMutexName $DataRoot));try{$taken=$mutex.WaitOne(30000)}catch [Threading.AbandonedMutexException]{$taken=$true};if(-not $taken){throw 'Timed out waiting for routing lock.'}}
    try{
        # TASK-0005: instance guard. A request carrying taskInstanceId must
        # never route a different lifecycle generation that merely shares the
        # display task id. The guard runs only when an authoritative ledger
        # exists (standalone routing against a synthetic TaskId is unchanged).
        if(-not[string]::IsNullOrWhiteSpace($TaskInstanceId)-and(Test-Path -LiteralPath (Join-Path $workspacePath '.ai-harness\state\tasks.json'))){
            $identity=Test-AihTaskIdentity -Workspace $workspacePath -TaskId $TaskId -TaskInstanceId $TaskInstanceId
            if(-not [bool]$identity.exists){throw "Routing rejected: task was not found in the authoritative ledger: $TaskId"}
            if(-not [bool]$identity.instanceMatches){throw "Routing rejected: task $TaskId no longer holds the expected taskInstanceId '$TaskInstanceId' (generation mismatch)."}
        }
        $statePath=Get-AihRoutingStatePath $DataRoot $workspacePath $TaskId $resolved.Id $TaskInstanceId;$state=Read-AihRoutingState $statePath;$initial=Get-AihRoutingInitialDecision $Description $policy
        $overrideValue=if(-not[string]::IsNullOrWhiteSpace($ForceClass)){$ForceClass}else{$ForceTier};$forced=ConvertTo-AihExecutionClass $overrideValue $policy
        $current=if($null-ne$forced){$forced}elseif($null-ne$state){ConvertTo-AihExecutionClass ([string]$state.executionClass) $policy}else{$initial.ExecutionClass}
        $signature=Get-AihFailureSignature $FailureReason;$sameCount=if($null-ne$state-and$state.lastFailureSignature-eq$signature-and-not[string]::IsNullOrWhiteSpace($signature)){[int]$state.sameFailureCount}else{0}
        if($Signal-in@('attempt-failure','verification-failure')){if([string]::IsNullOrWhiteSpace($FailureReason)){throw '-FailureReason is required for failure signals.'};$sameCount++}elseif($Signal-eq'progress'){$sameCount=0;$signature=''}
        $reason=[string]$initial.Reason;$escalatedFrom=$null;$reviewRequired=[bool]$initial.ReviewRequired;$risk=[string]$initial.Risk
        if($null -ne $state){if($null -ne $state.PSObject.Properties['reviewRequired']){$reviewRequired=$reviewRequired -or [bool]$state.reviewRequired};if($null -ne $state.PSObject.Properties['risk'] -and [string]$state.risk -ne 'normal'){$risk=[string]$state.risk}}
        if($null-ne$forced){$reason="Manual operator override selected $current."}
        elseif($ReviewRequested -and $resolved.Id -eq 'aih-deepseek'){throw 'Codex is disabled by the DeepSeek-only preset.'}
        elseif($ReviewRequested){$escalatedFrom=$current;$current='reviewer';$reviewRequired=$true;$reason='Explicit user-requested independent review (reviewRequested metadata; controller-owned, fresh, read-only).'}
        elseif($Signal-eq'review-findings'-and$current-eq'reviewer'){$escalatedFrom='reviewer';$current='engineer_deep';$sameCount=0;$reason='Independent review findings return to the deep engineer for implementation; the reviewer does not remain the parent.'}
        elseif($resolved.Id-eq'aih-deepseek'-and$Signal-eq'user-codex'){throw 'Codex is disabled by the DeepSeek-only preset.'}
        elseif(@($policy.escalation.immediateReviewSignals)-contains$Signal){$escalatedFrom=$current;$current='reviewer';$reviewRequired=$true;$reason="Evidence-based independent review signal: $Signal."}
        elseif($sameCount-ge[int]$policy.escalation.sameFailureThreshold){$escalatedFrom=$current;if($current-eq'engineer_normal'){$current='engineer_deep'}elseif($current-eq'engineer_deep'){$current=if($resolved.Config.allowCodexSubagent){'reviewer'}else{'engineer_deep'}};$sameCount=0;$reason='The same meaningful failure repeated at the configured threshold; escalation is scoped to that failure.'}
        $route=$policy.executionClasses.PSObject.Properties[$current].Value;if($current-eq'solver'-and-not$UserApprovedCodexSolve){throw 'solver requires the explicit -UserApprovedCodexSolve operator flag.'}
        $role=Get-AihRoleForExecutionClass $policy $current
        $target=$null;if(-not[string]::IsNullOrWhiteSpace($role)){$target=Resolve-AihModelTarget $registry $profile $role}
        $provider=if($null-ne$target){$target.Provider}else{$null};$model=if($null-ne$target){$target.Model}else{$null};$modelDisplayName=if($null-ne$target){$target.ModelDisplayName}else{$null};$vendor=if($null-ne$target){$target.Vendor}else{$null};$reasoning=if($null-ne$target){$target.Reasoning}else{$null}
        $record=[ordered]@{recordVersion=4;recordId=[guid]::NewGuid().ToString('N');timestampUtc=[DateTime]::UtcNow.ToString('o');taskId=$TaskId;taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId};workspace=$workspacePath;description=$Description;preset=$resolved.Id;selectedExecutionClass=$current;executionClass=$current;role=$role;profile=$profile.Id;profileDisplayName=$profile.DisplayName;provider=$provider;model=$model;modelDisplayName=$modelDisplayName;vendor=$vendor;reasoning=$reasoning;writable=[bool]$route.writable;risk=$risk;reviewRequired=$reviewRequired;reviewRequested=[bool]$ReviewRequested;reason=$reason;escalatedFrom=$escalatedFrom;manualOverride=$null-ne$forced;signal=$Signal;failureSignature=$signature;sameFailureCount=$sameCount;matchedRule=$initial.RuleId;matchedPatterns=@($initial.MatchedPatterns);freshSession=$true;completionAuthority=$false;selectedTier=(Get-AihLegacyTier $current);legacyTierDeprecated=$true;dryRun=[bool]$DryRun}
        if(-not$DryRun){New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot 'states')|Out-Null;$newState=[ordered]@{taskId=$TaskId;taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId};workspace=$workspacePath;preset=$resolved.Id;executionClass=$current;selectedTier=(Get-AihLegacyTier $current);role=$role;profile=$profile.Id;profileDisplayName=$profile.DisplayName;provider=$provider;model=$model;modelDisplayName=$modelDisplayName;reasoning=$reasoning;risk=$risk;reviewRequired=$reviewRequired;reviewRequested=[bool]$ReviewRequested;lastFailureSignature=$signature;sameFailureCount=$sameCount;updatedAtUtc=[DateTime]::UtcNow.ToString('o')};Write-AihAtomicJson $statePath $newState;Add-AihJsonLine (Join-Path $DataRoot 'decisions.jsonl') $record}
        [pscustomobject]$record
    }finally{if($taken){$mutex.ReleaseMutex()};if($null-ne$mutex){$mutex.Dispose()}}
}
