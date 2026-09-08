Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
# Phase M3: the catalog-level Nexus profile resolver (engine classification).
# Loaded here so the ONE engine dispatch seam below can classify the active
# profile without duplicating catalog validation. NexusProfiles.ps1 only
# defines functions at load time; its Routing.ps1 calls happen at runtime,
# after this file finished loading, in every real load order.
. (Join-Path $PSScriptRoot 'NexusProfiles.ps1')

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
    foreach($resolvedProfile in @($profiles.profiles)+@($customList)){
        if([string]::IsNullOrWhiteSpace([string]$resolvedProfile.id)){throw 'Engineering profile is missing an id.'}
        if($null-eq$resolvedProfile.PSObject.Properties['roles']){throw "Engineering profile $($resolvedProfile.id) is missing roles."}
        foreach($role in @('primaryEngineer','deepEngineer','reviewer','solver','fallback')){
            if($null-eq$resolvedProfile.roles.PSObject.Properties[$role]){throw "Engineering profile $($resolvedProfile.id) is missing role $role."}
            if([string]::IsNullOrWhiteSpace([string]$resolvedProfile.roles.$role.model)){throw "Engineering profile $($resolvedProfile.id) role $role has no model binding."}
            if($null-eq$resolvedProfile.roles.$role.PSObject.Properties['reasoning']-or[string]::IsNullOrWhiteSpace([string]$resolvedProfile.roles.$role.reasoning)){throw "Engineering profile $($resolvedProfile.id) role $role has no reasoning binding."}
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
    $resolvedProfile=$null
    foreach($candidate in @($Profiles.profiles)){if([string]$candidate.id -eq $requested){$resolvedProfile=$candidate;break}}
    if($null-eq $resolvedProfile){throw "Unknown engineering profile '$requested'."}
    [pscustomobject]@{Id=[string]$resolvedProfile.id;DisplayName=[string]$resolvedProfile.displayName;Config=$resolvedProfile}
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
    param([object]$Registry,[object]$ProfileDoc,[string]$Role)
    $roles=$ProfileDoc.Config.roles
    if($null-eq $roles.PSObject.Properties[$Role]){throw "Engineering profile $($ProfileDoc.Id) has no binding for role $Role."}
    $binding=$roles.$Role
    $modelId=[string]$binding.model
    $reasoning=[string]$binding.reasoning
    $entry=$null
    foreach($candidate in @($Registry.models)){if([string]$candidate.id -eq $modelId){$entry=$candidate;break}}
    if($null-eq $entry){throw "Model registry has no entry for '$modelId' (profile $($ProfileDoc.Id), role $Role)."}
    if(-not[bool]$entry.enabled){throw "Model '$modelId' is disabled in the registry (profile $($ProfileDoc.Id), role $Role)."}
    # Phase M2.1 engine scope: the Dual role architecture never resolves a
    # Muse-scoped model. Absence of agentEngines stays backward compatible;
    # a declaration without 'dual' fails closed here.
    if(-not(Test-AihModelEngineCompatible $entry 'dual')){throw "Model '$modelId' is not scoped to the dual agent engine (profile $($ProfileDoc.Id), role $Role)."}
    $provider=$null
    $providerMap=if($null-ne $entry.PSObject.Properties['providers']){$entry.providers}else{$null}
    if($null-ne $providerMap){
        if($null-ne $providerMap.PSObject.Properties[$reasoning]){$provider=[string]$providerMap.$reasoning}
        elseif($null-ne $providerMap.PSObject.Properties['default']){$provider=[string]$providerMap.default}
    }
    if([string]::IsNullOrWhiteSpace($provider)-and$null-ne $entry.PSObject.Properties['provider']){$provider=[string]$entry.provider}
    if([string]::IsNullOrWhiteSpace($provider)){throw "Model '$modelId' has no provider resolution (profile $($ProfileDoc.Id), role $Role)."}
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

function Test-AihModelEngineCompatible {
    # Phase M2.1 engine-scope contract (TASK-0037): a registry entry MAY declare
    # `agentEngines`. The semantics are ASYMMETRIC and both directions fail
    # closed:
    #   - 'dual': absence of the declaration keeps every pre-M2 registry entry
    #     eligible for the Dual role architecture (backward compatible); a
    #     declaration must list 'dual'.
    #   - 'muse': the Muse engine plane requires an EXPLICIT muse scope —
    #     absence of `agentEngines` (or a declaration without 'muse') is never
    #     eligible, so a Muse profile can never resolve through an unscoped or
    #     Dual-only model entry.
    # Unknown engine names fail closed: nothing is compatible with an engine
    # the registry contract does not define. The filter is metadata driven —
    # there is no model-id conditional anywhere.
    param([object]$Entry,[string]$Engine)
    if($null-eq$Entry){return $false}
    if([string]::IsNullOrWhiteSpace($Engine)){return $false}
    $declaredEngines=$null
    if($null-ne$Entry.PSObject.Properties['agentEngines']){$declaredEngines=@($Entry.agentEngines)}
    if($Engine -eq 'dual'){
        if($null-eq$declaredEngines){return $true}
        return @($declaredEngines|Where-Object{$_-eq'dual'}).Count-gt0
    }
    if($Engine -eq 'muse'){
        if($null-eq$declaredEngines){return $false}
        return @($declaredEngines|Where-Object{$_-eq'muse'}).Count-gt0
    }
    return $false
}

function Test-AihModelRoleCompatible {
    param([object]$Entry,[string]$Role,[string]$Reasoning)
    if($null-eq$Entry){return $false}
    if($null-ne$Entry.PSObject.Properties['enabled']-and-not[bool]$Entry.enabled){return $false}
    # Engine scope (Phase M2.1): the Dual role architecture never claims a
    # Muse-scoped model. Delegates to the shared asymmetric engine contract.
    if(-not(Test-AihModelEngineCompatible $Entry 'dual')){return $false}
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
    param([object]$Registry,[object]$ProfileDoc,[string]$Role,[string]$Reasoning)
    # Validate a role binding WITHOUT throwing; returns $null when invalid.
    $roles=$ProfileDoc.roles
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
    param([object]$Registry,[object]$ProfileDoc)
    # Returns @{ok;error} — never throws. All five CORE roles must bind a known,
    # enabled, capability-compatible model with a supported reasoning level.
    # visualReviewer is an OPTIONAL role: its absence never invalidates a
    # (legacy/custom) profile, but when a binding IS present it must satisfy
    # the same capability rules (checked where the visual review resolves it).
    foreach($role in @('primaryEngineer','deepEngineer','reviewer','solver','fallback')){
        $target=Get-AihRoleBindingTarget $Registry $ProfileDoc $role
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
function Get-AihRoutingStatePath {param([string]$DataRoot,[string]$Workspace,[string]$TaskId,[string]$Preset='aih-engineering',[string]$TaskInstanceId)$identity=if(-not[string]::IsNullOrWhiteSpace($TaskInstanceId)){$TaskInstanceId}else{$TaskId};$workspacePath=[IO.Path]::GetFullPath($Workspace);$workspaceKey=if(Test-AihIsWindows){$workspacePath.ToLowerInvariant()}else{$workspacePath};$bytes=[Text.Encoding]::UTF8.GetBytes(($workspaceKey+"`n"+$Preset.ToLowerInvariant()+"`n"+$identity));$sha=[Security.Cryptography.SHA256]::Create();try{$name=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()+'.json'}finally{$sha.Dispose()};Join-Path (Join-Path $DataRoot 'states') $name}
function Read-AihRoutingState {param([string]$Path)if(-not(Test-Path -LiteralPath $Path)){return $null};try{Get-Content -Raw -LiteralPath $Path|ConvertFrom-Json}catch{throw "Routing state is invalid: $Path"}}
function Get-AihRoutingMutexName {param([string]$DataRoot)$bytes=[Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($DataRoot).ToLowerInvariant());$sha=[Security.Cryptography.SHA256]::Create();try{$suffix=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').Substring(0,24)}finally{$sha.Dispose()};"AIHarnessRouting-$suffix"}

function Get-AihRoutingInitialDecision {
    param([string]$Description,[object]$Policy)
    foreach($rule in @($Policy.initialRules)){$matched=@($rule.patterns|Where-Object{$Description-match$_});if($matched.Count){return [pscustomobject]@{ExecutionClass=ConvertTo-AihExecutionClass ([string]$rule.executionClass) $Policy;Risk=[string]$rule.risk;ReviewRequired=[bool]$rule.reviewRequired;RuleId=[string]$rule.id;Reason=[string]$rule.reason;MatchedPatterns=$matched}}}
    [pscustomobject]@{ExecutionClass=ConvertTo-AihExecutionClass ([string]$Policy.defaultExecutionClass) $Policy;Risk='normal';ReviewRequired=$false;RuleId='default-engineering';Reason='Ordinary engineering work defaults to the primary engineer role of the active engineering profile.';MatchedPatterns=@()}
}

function Get-AihFailureSignature {param([string]$FailureReason)if([string]::IsNullOrWhiteSpace($FailureReason)){return ''};$normalized=($FailureReason.ToLowerInvariant()-replace '\b\d+\b','#'-replace '\s+',' ').Trim();$bytes=[Text.Encoding]::UTF8.GetBytes($normalized);$sha=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').Substring(0,16).ToLowerInvariant()}finally{$sha.Dispose()}}

function Get-AihEngineForPreset {
    param([Parameter(Mandatory=$true)][string]$PresetId)
    if($PresetId-eq'aih-muse'){return 'muse'}
    return 'dual'
}

function Assert-AihEngineBinding {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId,[string]$PresetId,[string]$RequestedEngine)
    $presetEngine=Get-AihEngineForPreset $PresetId
    $requested=if([string]::IsNullOrWhiteSpace($RequestedEngine)){$presetEngine}else{$RequestedEngine.Trim().ToLowerInvariant()}
    if($requested-notin@('dual','muse')-or$requested-ne$presetEngine){throw "engine-binding-violation: requested engine '$requested' does not match preset '$PresetId' engine '$presetEngine'."}
    $ledgerPath=Join-Path ([IO.Path]::GetFullPath($Workspace)) '.ai-harness/state/tasks.json'
    # Instance-aware requests are authoritative bound-task operations. Legacy
    # standalone callers without a lifecycle instance retain compatibility
    # and do not claim an immutable session binding.
    if(-not[string]::IsNullOrWhiteSpace($TaskId)-and-not[string]::IsNullOrWhiteSpace($TaskInstanceId)-and(Test-Path -LiteralPath $ledgerPath)){
        $task=Get-AihTask -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
        $bound=if($null-ne$task.PSObject.Properties['boundEngine']){([string]$task.boundEngine).Trim().ToLowerInvariant()}else{''}
        if($bound-notin@('dual','muse')){throw "engine-binding-violation: authoritative task '$TaskId' has no valid boundEngine."}
        if($requested-ne$bound){throw "engine-binding-violation: task '$TaskId' is bound to '$bound' but routing requested '$requested'."}
    }
    return $requested
}

function Get-AihMuseRoutingSignals {
    param([string]$Description,[string]$Signal='none')
    $patterns=@('\b(auth|authentication|authorization|permission architecture|credential boundary|security boundary|cryptograph|encryption|database migration|migration safety|concurrency correctness)\b')
    $matched=@($patterns|Where-Object{$Description-match$_})
    $criticalSignals=@('critical-security-boundary','concurrency-uncertainty','migration-safety','auth-permission-architecture')
    $critical=($matched.Count-gt0-or$Signal-in$criticalSignals)
    [pscustomobject]@{
        Risk=if($critical){'critical'}else{'normal'}
        RuleId=if($critical){'muse-critical-signals'}else{'muse-default'}
        MatchedPatterns=$matched
        Reason=if($critical){'Muse-native security, migration, authentication, or concurrency signals recorded as risk metadata on the same Muse main-agent plane.'}else{'Muse-native routing selected the single Muse main-agent plane.'}
    }
}

# ── Phase M3: Muse engine plane (routing-plane target authority) ────────────
# Muse is a REAL engine, never a Dual profile. The controller resolves the
# Muse target ONCE, on this deterministic plane, through the same chained
# authorities the M2 transport established:
#
#   Nexus Profile (engine: muse)
#     -> Muse profile (config/muse-profiles.json)
#       -> Model Registry (config/model-registry.json, agentEngines: [muse])
#         -> provider route (settings.yaml llm-pi-ai.providers)
#
# The DSH request boundary (config/Muse-Isolation.cjs) only ENFORCES the
# controller-produced target; it never re-resolves it. There is NO fallback
# provider/model/reasoning, NO Dual role semantics, and NO reviewer: every
# incomplete or unavailable input fails closed with a stable reason.

# The versioned operator acknowledgement that satisfies
# contributorProtection.required in M3. Contributor outbound sanitization is
# Phase M5; until it exists, executing the Contributor checkpoint requires
# this EXPLICIT operator consent in the live settings document. Nexus never
# writes this key itself and the shipped template never contains it.
$script:MuseContributorAcknowledgement = 'accepted-v1'

function Test-AihMuseContributorAcknowledgement {
    # Fail closed: $false unless the live settings document carries the exact
    # versioned acknowledgement. Never reads or logs any credential value.
    param([string]$SettingsPath)
    if([string]::IsNullOrWhiteSpace($SettingsPath)-or-not(Test-Path -LiteralPath $SettingsPath)){return $false}
    $settingsText=Get-Content -Raw -Encoding UTF8 -LiteralPath $SettingsPath
    $match=[regex]::Match($settingsText,'(?m)^muse-contributor-execution:[\t]*\r?\n[ \t]+acknowledgement:[ \t]*([^\s#\r\n]+)')
    return ($match.Success -and $match.Groups[1].Value.Trim() -eq $script:MuseContributorAcknowledgement)
}

function Test-AihMuseProviderRouteConfigured {
    # Text-level structural check that the provider route exists as a
    # settings.yaml llm-pi-ai.providers entry (a column-4 key inside the
    # managed block). Never reads credential values; the route declares a
    # credential REFERENCE (apiKeyEnv), never a key.
    param([string]$SettingsPath,[Parameter(Mandatory=$true)][string]$ProviderId)
    if([string]::IsNullOrWhiteSpace($SettingsPath)-or-not(Test-Path -LiteralPath $SettingsPath)){return $false}
    $settingsText=Get-Content -Raw -Encoding UTF8 -LiteralPath $SettingsPath
    $pattern='(?ms)^llm-pi-ai:\s*$.*?^ {2}providers:\s*$.*?^ {4}'+([regex]::Escape($ProviderId))+':\s*$'
    return [bool][regex]::IsMatch($settingsText,$pattern)
}

function Resolve-AihMuseRoutingTarget {
    # Muse-native target resolution for the ROUTING plane (the one place Muse
    # model identity is resolved). Fails CLOSED with a stable reason on every
    # incomplete/unavailable input. Returns the complete target plus the
    # Contributor metadata the routing record must carry end to end.
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [Parameter(Mandatory=$true)][string]$PresetId,
        [string]$SettingsPath
    )
    $root=[IO.Path]::GetFullPath($InstallRoot)
    # 1. The active Nexus profile (the muse preset locks its own binding).
    $active=Resolve-AihActiveNexusProfile -InstallRoot $root -Preset $PresetId
    if($null-eq$active){throw "Muse routing rejected: the active Nexus profile could not be resolved (preset '$PresetId')."}
    if([string]$active.Engine -ne 'muse'){throw "Muse routing rejected: active profile '$($active.Id)' is not a muse-engine profile."}
    if(-not[bool]$active.Runnable){throw "Muse routing rejected: profile '$($active.Id)' is not runnable (runnable=false)."}
    # 2. Contributor activation gate (M3 truth: protection is NOT implemented
    #    in M3 — Phase M5 owns outbound sanitization — so execution requires
    #    the explicit operator acknowledgement while contributorProtection
    #    stays REQUIRED. The metadata is consumed, never erased or weakened).
    $protectionRequired=$true
    if($null-ne$active.Config-and$null-ne$active.Config.PSObject.Properties['contributorProtection']-and$null-ne$active.Config.contributorProtection.PSObject.Properties['required']){$protectionRequired=[bool]$active.Config.contributorProtection.required}
    if($protectionRequired-and-not(Test-AihMuseContributorAcknowledgement -SettingsPath $SettingsPath)){
        throw 'Muse routing rejected: contributorProtection.required is set and no operator acknowledgement exists (add the versioned muse-contributor-execution acknowledgement to data/settings.yaml). Contributor terms permit Meta to train on prompts and completions; outbound sanitization is Phase M5.'
    }
    # 3. Registry resolution: engine-scoped model, supported reasoning level.
    $registryPath=Join-Path $root 'config/model-registry.json'
    $registry=Get-AihModelRegistry $registryPath
    $target=Resolve-AihMuseProfileModel -MuseProfile $active.Config -Registry $registry
    if($null-eq$target){throw "Muse routing rejected: the Muse profile '$($active.Id)' target chain is incomplete (profile -> model registry -> provider)."}
    # 4. Reasoning bound: the profile's escalation ceiling must itself be a
    #    level the model supports (fail closed at resolution time, never at
    #    escalation time). V0 performs no dynamic escalation: the resolved
    #    reasoning IS the profile default, bounded by this ceiling.
    if($null-ne$active.Config.PSObject.Properties['reasoning']-and$null-ne$active.Config.reasoning.PSObject.Properties['escalation']){
        $escalation=[string]$active.Config.reasoning.escalation
        if(-not[string]::IsNullOrWhiteSpace($escalation)){
            $entry=$null
            foreach($candidate in @($registry.models)){if([string]$candidate.id -eq [string]$target.ModelId){$entry=$candidate;break}}
            $levels=@()
            if($null-ne$entry-and$null-ne$entry.PSObject.Properties['supportedReasoningLevels']){$levels=@($entry.supportedReasoningLevels)}
            if(@($levels|Where-Object{$_-eq$escalation}).Count-eq0){throw "Muse routing rejected: profile escalation reasoning '$escalation' is not supported by model '$($target.ModelId)'."}
        }
    }
    # 5. The provider route must be configured in the live settings document.
    if(-not(Test-AihMuseProviderRouteConfigured -SettingsPath $SettingsPath -ProviderId ([string]$target.Provider))){
        throw "Muse routing rejected: provider route '$($target.Provider)' is not configured in settings.yaml llm-pi-ai.providers."
    }
    [pscustomobject][ordered]@{
        ProfileId=[string]$active.Id
        ProfileDisplayName=[string]$active.DisplayName
        ModelId=[string]$target.ModelId
        Model=[string]$target.Model
        ModelDisplayName=[string]$target.ModelDisplayName
        Vendor=[string]$target.Vendor
        Provider=[string]$target.Provider
        Reasoning=if([string]::IsNullOrWhiteSpace([string]$target.Reasoning)){$null}else{[string]$target.Reasoning}
        DataUseTier=$target.DataUseTier
        ContributorProtectionRequired=$protectionRequired
    }
}

function Invoke-AihMuseRoutingDecision {
    # Phase M3: the Muse engine routing branch. Exactly ONE Muse main
    # engineering agent; NO Dual roles, NO reviewer, NO provider/model
    # fallback, NO manual class/tier override. Bounded controller retries may
    # re-select the SAME muse target; unresolved failures terminate
    # truthfully. Shares the identity guard, the routing mutex, and the
    # record/state persistence with the Dual path (one controller plane).
    param([Parameter(Mandatory=$true)][string]$Description,[Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$PolicyPath,[Parameter(Mandatory=$true)][string]$DataRoot,[string]$TaskId,[string]$Preset,[string]$ForceTier,[string]$ForceClass,[string]$Signal='none',[string]$FailureReason,[switch]$UserApprovedCodexSolve,[switch]$ReviewRequested,[switch]$DryRun,[string]$SettingsPath,[string]$CustomProfilePath,[string]$TaskInstanceId,[string]$RequestedEngine)
    $policy=Get-AihRoutingPolicy $PolicyPath
    $resolved=Resolve-AihPreset $policy $Preset
    if($resolved.Id -ne 'aih-muse'){throw "Muse routing requires the aih-muse agent plane (got '$($resolved.Id)')."}
    [void](Assert-AihEngineBinding -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -PresetId $resolved.Id -RequestedEngine $RequestedEngine)
    if(-not[string]::IsNullOrWhiteSpace($ForceClass)-or-not[string]::IsNullOrWhiteSpace($ForceTier)){throw 'Muse routing rejected: manual execution-class/tier overrides are Dual role semantics and are not available for the Muse engine.'}
    if($ReviewRequested){throw 'Muse routing rejected: independent review is not available for the Muse engine (review.independent=false); Codex is never invoked from Muse.'}
    if($Signal-eq'user-codex'){throw "Muse routing rejected: independent review is not available for the Muse engine (signal '$Signal' requests reviewer escalation)."}
    if($Signal-eq'review-findings'){throw 'Muse routing rejected: independent review findings cannot return to a Muse task (no Muse reviewer exists).'}
    $workspacePath=[IO.Path]::GetFullPath($Workspace)
    if([string]::IsNullOrWhiteSpace($TaskId)){$TaskId=[guid]::NewGuid().ToString('N')};if($TaskId-notmatch'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'){throw 'TaskId is invalid.'}
    $mutex=$null;$taken=$false;if(-not $DryRun){$mutex=[Threading.Mutex]::new($false,(Get-AihRoutingMutexName $DataRoot));try{$taken=$mutex.WaitOne(30000)}catch [Threading.AbandonedMutexException]{$taken=$true};if(-not $taken){throw 'Timed out waiting for routing lock.'}}
    try{
        # TASK-0005 identity guard: exactly the Dual path's instance semantics —
        # one controller plane, one lifecycle identity contract.
        if(-not[string]::IsNullOrWhiteSpace($TaskInstanceId)-and(Test-Path -LiteralPath (Join-Path $workspacePath '.ai-harness/state/tasks.json'))){
            $identity=Test-AihTaskIdentity -Workspace $workspacePath -TaskId $TaskId -TaskInstanceId $TaskInstanceId
            if(-not [bool]$identity.exists){throw "Routing rejected: task was not found in the authoritative ledger: $TaskId"}
            if(-not [bool]$identity.instanceMatches){throw "Routing rejected: task $TaskId no longer holds the expected taskInstanceId '$TaskInstanceId' (generation mismatch)."}
        }
        $initial=Get-AihMuseRoutingSignals -Description $Description -Signal $Signal
        $current='muse_main'
        $statePath=Get-AihRoutingStatePath $DataRoot $workspacePath $TaskId $resolved.Id $TaskInstanceId;$state=Read-AihRoutingState $statePath
        $signature=Get-AihFailureSignature $FailureReason;$sameCount=if($null-ne$state-and$state.lastFailureSignature-eq$signature-and-not[string]::IsNullOrWhiteSpace($signature)){[int]$state.sameFailureCount}else{0}
        if($Signal-in@('attempt-failure','verification-failure')){if([string]::IsNullOrWhiteSpace($FailureReason)){throw '-FailureReason is required for failure signals.'};$sameCount++}elseif($Signal-eq'progress'){$sameCount=0;$signature=''}
        $reason=[string]$initial.Reason;$risk=[string]$initial.Risk
        if($null-ne$state-and$null-ne$state.PSObject.Properties['risk']-and[string]$state.risk-ne'normal'){$risk=[string]$state.risk}
        # Bounded retry: the same failure at the configured threshold NEVER
        # escalates and NEVER changes engine/provider/model. The controller may
        # retry the same single Muse main agent; unresolved failure terminates.
        if($sameCount-ge[int]$policy.escalation.sameFailureThreshold){$reason="The same meaningful failure repeated $($sameCount)x; the Muse engine retries the same single main agent (no escalation, no provider/model change)."}
        # The Muse agent plane runs its one main agent for every supported
        # engineering turn; no Dual execution-class decision is consulted.
        $installRoot=Split-Path -Parent (Split-Path -Parent $PolicyPath)
        $target=Resolve-AihMuseRoutingTarget -InstallRoot $installRoot -PresetId $resolved.Id -SettingsPath $SettingsPath
        $record=[ordered]@{recordVersion=4;recordId=[guid]::NewGuid().ToString('N');timestampUtc=[DateTime]::UtcNow.ToString('o');taskId=$TaskId;taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId};workspace=$workspacePath;description=$Description;preset=$resolved.Id;engine='muse';selectedExecutionClass=$current;executionClass=$current;role=$null;profile=$target.ProfileId;profileDisplayName=$target.ProfileDisplayName;provider=$target.Provider;model=$target.Model;modelDisplayName=$target.ModelDisplayName;vendor=$target.Vendor;reasoning=$target.Reasoning;dataUseTier=$target.DataUseTier;contributorProtectionRequired=[bool]$target.ContributorProtectionRequired;writable=$true;risk=$risk;reviewRequired=$false;reviewRequested=[bool]$ReviewRequested;reason=$reason;escalatedFrom=$null;manualOverride=$false;signal=$Signal;failureSignature=$signature;sameFailureCount=$sameCount;matchedRule=$initial.RuleId;matchedPatterns=@($initial.MatchedPatterns);freshSession=$true;completionAuthority=$false;selectedTier=$null;legacyTierDeprecated=$true;dryRun=[bool]$DryRun}
        if(-not$DryRun){
            New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot 'states')|Out-Null
            $newState=[ordered]@{taskId=$TaskId;taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId};workspace=$workspacePath;preset=$resolved.Id;engine='muse';executionClass=$current;selectedTier=$null;role=$null;profile=$target.ProfileId;profileDisplayName=$target.ProfileDisplayName;provider=$target.Provider;model=$target.Model;modelDisplayName=$target.ModelDisplayName;reasoning=$target.Reasoning;dataUseTier=$target.DataUseTier;contributorProtectionRequired=[bool]$target.ContributorProtectionRequired;risk=$risk;reviewRequired=$false;reviewRequested=[bool]$ReviewRequested;lastFailureSignature=$signature;sameFailureCount=$sameCount;updatedAtUtc=[DateTime]::UtcNow.ToString('o')}
            Write-AihAtomicJson $statePath $newState
            Add-AihJsonLine (Join-Path $DataRoot 'decisions.jsonl') $record
        }
        [pscustomobject]$record
    }finally{if($taken){$mutex.ReleaseMutex()};if($null-ne$mutex){$mutex.Dispose()}}
}

function Invoke-AihRoutingDecision {
    # TASK-0005 Part 16: when -TaskInstanceId is supplied the routing request
    # is instance-guarded (fail closed on mismatch against the authoritative
    # ledger) and the durable state/decision records carry the lifecycle
    # identity (Part 15). Legacy callers that omit it keep the exact old
    # behavior (explicit compatibility path).
    param([Parameter(Mandatory=$true)][string]$Description,[Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$PolicyPath,[Parameter(Mandatory=$true)][string]$DataRoot,[string]$TaskId,[string]$Preset,[string]$ForceTier,[string]$ForceClass,[string]$Signal='none',[string]$FailureReason,[switch]$UserApprovedCodexSolve,[switch]$ReviewRequested,[switch]$DryRun,[string]$SettingsPath,[string]$CustomProfilePath,[string]$TaskInstanceId,[string]$RequestedEngine)
    $policy=Get-AihRoutingPolicy $PolicyPath
    $resolved=Resolve-AihPreset $policy $Preset
    [void](Assert-AihEngineBinding -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -PresetId $resolved.Id -RequestedEngine $RequestedEngine)
    # ── Phase M3: THE engine dispatch seam (one authority) ──────────────────
    # The session's agent-preset id selects the engine plane:
    #   'aih-muse'      -> Muse V0 branch (Invoke-AihMuseRoutingDecision)
    #   everything else -> the existing Dual semantic path
    # There is exactly ONE seam; no other system branches on the engine.
    if($resolved.Id-eq'aih-muse'){return (Invoke-AihMuseRoutingDecision @PSBoundParameters)}
    $profilesPath=Join-Path (Split-Path -Parent $PolicyPath) 'engineering-profiles.json';$registryPath=Join-Path (Split-Path -Parent $PolicyPath) 'model-registry.json'
    $profiles=Get-AihEngineeringProfiles $profilesPath $CustomProfilePath;$registry=Get-AihModelRegistry $registryPath
    # Dual-side guard (fail closed, additive): the active Nexus profile must
    # not select the muse engine while the session still runs a Dual agent
    # plane — the Dual preset carries Dual delegation tooling, so that
    # combination can never execute a Muse task truthfully. A missing or
    # invalid catalog keeps the exact pre-M3 Dual behavior (the downstream
    # profile resolver still fails closed on unknown ids).
    $museEngineOnDualPreset=$false;$museGuardProfileId=$null
    try{
        $requestedNexusId=Get-AihRequestedNexusProfileId $policy $resolved $SettingsPath
        if(-not[string]::IsNullOrWhiteSpace($requestedNexusId)){
            $catalog=Get-AihNexusProfileCatalog (Join-Path (Split-Path -Parent $PolicyPath) 'nexus-profiles.json')
            foreach($catalogProfile in @($catalog.profiles)){
                if(([string]$catalogProfile.id).Trim().ToLowerInvariant()-eq$requestedNexusId){
                    if(([string]$catalogProfile.engine).Trim().ToLowerInvariant()-eq'muse'){$museEngineOnDualPreset=$true;$museGuardProfileId=$requestedNexusId}
                    break
                }
            }
        }
    }catch{$museEngineOnDualPreset=$false}
    if($museEngineOnDualPreset){throw "Muse routing rejected: the active profile '$museGuardProfileId' selects the muse engine but the session runs the '$($resolved.Id)' agent plane. Start the session on the aih-muse agent plane (Normal Engineering + Muse profile)."}
    $resolvedProfile=Resolve-AihProfile $policy $resolved $profiles $SettingsPath
    $workspacePath=[IO.Path]::GetFullPath($Workspace)
    if([string]::IsNullOrWhiteSpace($TaskId)){$TaskId=[guid]::NewGuid().ToString('N')};if($TaskId-notmatch'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'){throw 'TaskId is invalid.'}
    $mutex=$null;$taken=$false;if(-not $DryRun){$mutex=[Threading.Mutex]::new($false,(Get-AihRoutingMutexName $DataRoot));try{$taken=$mutex.WaitOne(30000)}catch [Threading.AbandonedMutexException]{$taken=$true};if(-not $taken){throw 'Timed out waiting for routing lock.'}}
    try{
        # TASK-0005: instance guard. A request carrying taskInstanceId must
        # never route a different lifecycle generation that merely shares the
        # display task id. The guard runs only when an authoritative ledger
        # exists (standalone routing against a synthetic TaskId is unchanged).
        if(-not[string]::IsNullOrWhiteSpace($TaskInstanceId)-and(Test-Path -LiteralPath (Join-Path $workspacePath '.ai-harness/state/tasks.json'))){
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
        $target=$null;if(-not[string]::IsNullOrWhiteSpace($role)){$target=Resolve-AihModelTarget $registry $resolvedProfile $role}
        $provider=if($null-ne$target){$target.Provider}else{$null};$model=if($null-ne$target){$target.Model}else{$null};$modelDisplayName=if($null-ne$target){$target.ModelDisplayName}else{$null};$vendor=if($null-ne$target){$target.Vendor}else{$null};$reasoning=if($null-ne$target){$target.Reasoning}else{$null}
        $record=[ordered]@{recordVersion=4;recordId=[guid]::NewGuid().ToString('N');timestampUtc=[DateTime]::UtcNow.ToString('o');taskId=$TaskId;taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId};workspace=$workspacePath;description=$Description;preset=$resolved.Id;engine='dual';selectedExecutionClass=$current;executionClass=$current;role=$role;profile=$resolvedProfile.Id;profileDisplayName=$resolvedProfile.DisplayName;provider=$provider;model=$model;modelDisplayName=$modelDisplayName;vendor=$vendor;reasoning=$reasoning;writable=[bool]$route.writable;risk=$risk;reviewRequired=$reviewRequired;reviewRequested=[bool]$ReviewRequested;reason=$reason;escalatedFrom=$escalatedFrom;manualOverride=$null-ne$forced;signal=$Signal;failureSignature=$signature;sameFailureCount=$sameCount;matchedRule=$initial.RuleId;matchedPatterns=@($initial.MatchedPatterns);freshSession=$true;completionAuthority=$false;selectedTier=(Get-AihLegacyTier $current);legacyTierDeprecated=$true;dryRun=[bool]$DryRun}
        if(-not$DryRun){New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot 'states')|Out-Null;$newState=[ordered]@{taskId=$TaskId;taskInstanceId=if([string]::IsNullOrWhiteSpace($TaskInstanceId)){$null}else{$TaskInstanceId};workspace=$workspacePath;preset=$resolved.Id;engine='dual';executionClass=$current;selectedTier=(Get-AihLegacyTier $current);role=$role;profile=$resolvedProfile.Id;profileDisplayName=$resolvedProfile.DisplayName;provider=$provider;model=$model;modelDisplayName=$modelDisplayName;reasoning=$reasoning;risk=$risk;reviewRequired=$reviewRequired;reviewRequested=[bool]$ReviewRequested;lastFailureSignature=$signature;sameFailureCount=$sameCount;updatedAtUtc=[DateTime]::UtcNow.ToString('o')};Write-AihAtomicJson $statePath $newState;Add-AihJsonLine (Join-Path $DataRoot 'decisions.jsonl') $record}
        [pscustomobject]$record
    }finally{if($taken){$mutex.ReleaseMutex()};if($null-ne$mutex){$mutex.Dispose()}}
}
