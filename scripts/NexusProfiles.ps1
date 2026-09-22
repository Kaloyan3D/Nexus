Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Phase M1: top-level Nexus profile -> agent-engine resolution for the
# deterministic PowerShell plane. Existing Engineering Profiles remain the
# complete authority for Dual role bindings; Muse uses its own registry and is
# intentionally not shaped into Dual roles.

function Get-AihNexusProfileCatalog {
    param([Parameter(Mandatory=$true)][string]$Path)
    if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw "Nexus profile catalog is missing: $Path"}
    $catalog=Get-Content -Raw -Encoding UTF8 -LiteralPath $Path|ConvertFrom-Json
    if([int]$catalog.schemaVersion -ne 1){throw 'Nexus profile catalog schemaVersion must be 1.'}
    if($null-eq$catalog.PSObject.Properties['profiles']-or@($catalog.profiles).Count-eq0){throw 'Nexus profile catalog must declare at least one profile.'}
    $seen=@{}
    # NOTE: never name the loop variable '$profile' — that is a PowerShell
    # automatic variable; the portability audit gate fails on it.
    foreach($catalogProfile in @($catalog.profiles)){
        $id=([string]$catalogProfile.id).Trim().ToLowerInvariant()
        if([string]::IsNullOrWhiteSpace($id)){throw 'Nexus profile is missing an id.'}
        if($seen.ContainsKey($id)){throw "Nexus profile id '$id' is duplicated."}
        $seen[$id]=$true
        $engine=([string]$catalogProfile.engine).Trim().ToLowerInvariant()
        if($engine -notin @('dual','muse')){throw "Nexus profile '$id' has unsupported engine '$engine'."}
        if($null-eq$catalogProfile.PSObject.Properties['source']){throw "Nexus profile '$id' is missing source."}
        $expectedKind=if($engine-eq'dual'){'engineering-profile'}else{'muse-profile'}
        if([string]$catalogProfile.source.kind -ne $expectedKind){throw "Nexus profile '$id' source kind must be '$expectedKind' for engine '$engine'."}
        if([string]::IsNullOrWhiteSpace([string]$catalogProfile.source.profileId)){throw "Nexus profile '$id' is missing source.profileId."}
    }
    # Phase M3: an engine entry MAY bind the INTERNAL agent preset that runs
    # the engine's agent plane (muse -> 'aih-muse'). The binding is optional,
    # and it is internal infrastructure — never a user-facing mode. A present
    # but malformed binding fails closed here (the id grammar is the pinned
    # DSH agent-preset grammar).
    if($null-ne$catalog.PSObject.Properties['engines']-and$null-ne$catalog.engines){
        foreach($engineEntry in @($catalog.engines.PSObject.Properties)){
            if($null-eq$engineEntry.Value){continue}
            if(-not$engineEntry.Value.PSObject.Properties['agentPreset']){continue}
            $agentPreset=[string]$engineEntry.Value.agentPreset
            if([string]::IsNullOrWhiteSpace($agentPreset)){throw "Nexus engine '$($engineEntry.Name)' agentPreset is empty."}
            if($agentPreset -notmatch '^[a-z0-9][a-z0-9-]*$'){throw "Nexus engine '$($engineEntry.Name)' agentPreset '$agentPreset' is not a valid agent-preset id."}
        }
    }
    $catalog
}

function Get-AihMuseProfiles {
    param([Parameter(Mandatory=$true)][string]$Path)
    if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw "Muse profiles are missing: $Path"}
    $profiles=Get-Content -Raw -Encoding UTF8 -LiteralPath $Path|ConvertFrom-Json
    if([int]$profiles.schemaVersion -ne 1){throw 'Muse profiles schemaVersion must be 1.'}
    if($null-eq$profiles.PSObject.Properties['profiles']-or@($profiles.profiles).Count-eq0){throw 'Muse profiles must declare at least one profile.'}
    $seen=@{}
    foreach($museProfile in @($profiles.profiles)){
        $id=([string]$museProfile.id).Trim().ToLowerInvariant()
        if([string]::IsNullOrWhiteSpace($id)){throw 'Muse profile is missing an id.'}
        if($seen.ContainsKey($id)){throw "Muse profile id '$id' is duplicated."}
        $seen[$id]=$true
        # Phase M2: the optional model binding must reference a MODEL REGISTRY
        # id (never a provider id). A declared but malformed binding fails
        # closed here instead of resolving to nothing at transport time.
        if($null-ne$museProfile.PSObject.Properties['model']-and$null-ne$museProfile.model){
            if($null-eq$museProfile.model.PSObject.Properties['primary']){throw "Muse profile '$id' model binding is missing model.primary."}
            if([string]::IsNullOrWhiteSpace([string]$museProfile.model.primary)){throw "Muse profile '$id' model.primary is empty."}
        }
    }
    $profiles
}

function Resolve-AihMuseProfileModel {
    # Phase M2 transport chain: Muse Profile -> model registry entry ->
    # provider configuration identifier. This is RESOLUTION ONLY — it never
    # dispatches execution, and the returned provider id is a settings.yaml
    # llm-pi-ai.providers route, not a URL or credential. Returns $null when
    # the chain cannot be satisfied (unknown/disabled/engine-scoped-away model,
    # missing binding, or unsupported reasoning level); callers fail closed.
    param(
        [Parameter(Mandatory=$true)][object]$MuseProfile,
        [Parameter(Mandatory=$true)][object]$Registry,
        [string]$Reasoning
    )
    if($null-eq$MuseProfile-or$null-eq$Registry){return $null}
    if($null-eq$MuseProfile.PSObject.Properties['model']-or$null-eq$MuseProfile.model){return $null}
    if($null-eq$MuseProfile.model.PSObject.Properties['primary']){return $null}
    $modelId=([string]$MuseProfile.model.primary).Trim()
    if([string]::IsNullOrWhiteSpace($modelId)){return $null}
    $entry=$null
    foreach($candidate in @($Registry.models)){if([string]$candidate.id -eq $modelId){$entry=$candidate;break}}
    if($null-eq$entry){return $null}
    if($null-ne$entry.PSObject.Properties['enabled']-and-not[bool]$entry.enabled){return $null}
    # Phase M2.1 defense in depth: the binding may only resolve to a model
    # EXPLICITLY scoped to the muse engine (Test-AihModelEngineCompatible's
    # asymmetric contract — loaded with Routing.ps1 in every real load order).
    # Absence of `agentEngines` fails closed on the Muse plane: an unscoped or
    # Dual-only entry is a configuration error and must not silently serve the
    # Muse transport.
    if(-not(Test-AihModelEngineCompatible $entry 'muse')){return $null}
    $requested=if(-not[string]::IsNullOrWhiteSpace($Reasoning)){$Reasoning}
        elseif($null-ne$MuseProfile.PSObject.Properties['reasoning']-and$null-ne$MuseProfile.reasoning.PSObject.Properties['default']){[string]$MuseProfile.reasoning.default}
        else{''}
    if(-not[string]::IsNullOrWhiteSpace($requested)){
        $levels=@();if($null-ne$entry.PSObject.Properties['supportedReasoningLevels']){$levels=@($entry.supportedReasoningLevels)}
        if(@($levels|Where-Object{$_-eq$requested}).Count-eq0){return $null}
    }
    $provider=if($null-ne$entry.PSObject.Properties['providers']){$entry.providers}else{$null}
    $resolvedProvider=$null
    if($null-ne$provider){
        if(-not[string]::IsNullOrWhiteSpace($requested)-and$null-ne$provider.PSObject.Properties[$requested]){$resolvedProvider=[string]$provider.$requested}
        elseif($null-ne$provider.PSObject.Properties['default']){$resolvedProvider=[string]$provider.default}
    }
    if([string]::IsNullOrWhiteSpace($resolvedProvider)-and$null-ne$entry.PSObject.Properties['provider']){$resolvedProvider=[string]$entry.provider}
    if([string]::IsNullOrWhiteSpace($resolvedProvider)){return $null}
    [pscustomobject][ordered]@{
        ModelId=$modelId
        Model=if($null-ne$entry.PSObject.Properties['model']-and-not[string]::IsNullOrWhiteSpace([string]$entry.model)){[string]$entry.model}else{$modelId}
        ModelDisplayName=[string]$entry.displayName
        Vendor=[string]$entry.vendor
        Provider=$resolvedProvider
        Reasoning=$requested
        DataUseTier=if($null-ne$entry.PSObject.Properties['dataUseTier']){[string]$entry.dataUseTier}else{$null}
    }
}

function Find-AihProfileById {
    param([object[]]$Profiles,[string]$ProfileId)
    $wanted=if([string]::IsNullOrWhiteSpace($ProfileId)){''}else{$ProfileId.Trim().ToLowerInvariant()}
    foreach($candidate in @($Profiles)){
        if(([string]$candidate.id).Trim().ToLowerInvariant()-eq$wanted){return $candidate}
    }
    $null
}

function Get-AihNexusProfiles {
    param(
        [Parameter(Mandatory=$true)][string]$CatalogPath,
        [Parameter(Mandatory=$true)][string]$EngineeringProfilesPath,
        [string]$CustomEngineeringProfilePath
    )
    $catalog=Get-AihNexusProfileCatalog $CatalogPath
    $entries=@($catalog.profiles)
    # The current Routing.ps1 helper owns Dual profile validation and merges
    # operator Custom when present. Never duplicate its role semantics here.
    $engineeringProfiles=Get-AihEngineeringProfiles $EngineeringProfilesPath $CustomEngineeringProfilePath
    $custom=Find-AihProfileById @($engineeringProfiles.profiles) 'custom'
    $catalogCustom=Find-AihProfileById $entries 'custom'
    if($null-ne$custom-and$null-eq$catalogCustom){
        $entries+=@([pscustomobject][ordered]@{
            id='custom';displayName=if([string]::IsNullOrWhiteSpace([string]$custom.displayName)){'Custom'}else{[string]$custom.displayName}
            engine='dual';source=[pscustomobject]@{kind='engineering-profile';profileId='custom'}
            selectable=$true;runnable=$true;builtin=$false
        })
    }
    @($entries)
}

function Resolve-AihNexusProfile {
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [Parameter(Mandatory=$true)][string]$ProfileId
    )
    $root=[IO.Path]::GetFullPath($InstallRoot)
    $catalogPath=Join-Path $root 'config/nexus-profiles.json'
    $engineeringPath=Join-Path $root 'config/engineering-profiles.json'
    $customPath=Join-Path $root 'data/custom-engineering-profile.json'
    $musePath=Join-Path $root 'config/muse-profiles.json'
    $entries=Get-AihNexusProfiles -CatalogPath $catalogPath -EngineeringProfilesPath $engineeringPath -CustomEngineeringProfilePath $customPath
    $entry=Find-AihProfileById $entries $ProfileId
    if($null-eq$entry){return $null}
    $id=([string]$entry.id).Trim().ToLowerInvariant()
    $engine=([string]$entry.engine).Trim().ToLowerInvariant()
    $sourceId=([string]$entry.source.profileId).Trim().ToLowerInvariant()
    if($engine-eq'dual'){
        $profiles=Get-AihEngineeringProfiles $engineeringPath $customPath
        $config=Find-AihProfileById @($profiles.profiles) $sourceId
        if($null-eq$config){return $null}
        return [pscustomobject][ordered]@{
            Id=$id;DisplayName=if([string]::IsNullOrWhiteSpace([string]$entry.displayName)){[string]$config.displayName}else{[string]$entry.displayName}
            Engine='dual';Selectable=if($null-eq$entry.PSObject.Properties['selectable']){$true}else{[bool]$entry.selectable}
            Runnable=if($null-eq$entry.PSObject.Properties['runnable']){$true}else{[bool]$entry.runnable}
            Availability=if($null-ne$entry.PSObject.Properties['availability']){[string]$entry.availability}else{'ready'}
            Source=$entry.source;Config=$config
        }
    }
    if($engine-eq'muse'){
        $profiles=Get-AihMuseProfiles $musePath
        $config=Find-AihProfileById @($profiles.profiles) $sourceId
        if($null-eq$config){return $null}
        return [pscustomobject][ordered]@{
            Id=$id;DisplayName=if([string]::IsNullOrWhiteSpace([string]$entry.displayName)){[string]$config.displayName}else{[string]$entry.displayName}
            Engine='muse';Selectable=if($null-ne$entry.PSObject.Properties['selectable']){[bool]$entry.selectable}else{$false}
            Runnable=if($null-ne$entry.PSObject.Properties['runnable']){[bool]$entry.runnable}else{$false}
            Availability=if($null-ne$entry.PSObject.Properties['availability']){[string]$entry.availability}elseif($null-ne$config.PSObject.Properties['status']){[string]$config.status}else{'unavailable'}
            Source=$entry.source;Config=$config
        }
    }
    $null
}

function Get-AihRequestedNexusProfileId {
    param([object]$Policy,[object]$Preset,[string]$SettingsPath)
    $overrideAllowed=$true
    if($null-ne$Preset-and$null-ne$Preset.Config.PSObject.Properties['profileOverrideAllowed']){$overrideAllowed=[bool]$Preset.Config.profileOverrideAllowed}
    $requested=$null
    if($overrideAllowed){
        if(-not[string]::IsNullOrWhiteSpace($env:DSH_AIH_PROFILE)){$requested=$env:DSH_AIH_PROFILE}
        elseif(-not[string]::IsNullOrWhiteSpace($env:AIH_ACTIVE_PROFILE)){$requested=$env:AIH_ACTIVE_PROFILE}
        elseif(-not[string]::IsNullOrWhiteSpace($SettingsPath)-and(Test-Path -LiteralPath $SettingsPath)){
            $settingsText=Get-Content -Raw -Encoding UTF8 -LiteralPath $SettingsPath
            $match=[regex]::Match($settingsText,'(?m)^engineering-profile:\s*([^\s#\r\n]+)')
            if($match.Success){$requested=$match.Groups[1].Value.Trim().Trim('''','"')}
        }
    }
    if([string]::IsNullOrWhiteSpace($requested)-and$null-ne$Preset-and$null-ne$Preset.Config.PSObject.Properties['profile']){$requested=[string]$Preset.Config.profile}
    if([string]::IsNullOrWhiteSpace($requested)){$requested=[string]$Policy.defaultProfile}
    if([string]::IsNullOrWhiteSpace($requested)){return $null}
    $requested.Trim().ToLowerInvariant()
}

function Resolve-AihActiveNexusProfile {
    param([Parameter(Mandatory=$true)][string]$InstallRoot,[string]$Preset='aih-engineering')
    $root=[IO.Path]::GetFullPath($InstallRoot)
    $policy=Get-AihRoutingPolicy (Join-Path $root 'config/routing-policy.json')
    $presetDoc=Resolve-AihPreset $policy $Preset
    $requested=Get-AihRequestedNexusProfileId -Policy $policy -Preset $presetDoc -SettingsPath (Join-Path $root 'data/settings.yaml')
    if([string]::IsNullOrWhiteSpace($requested)){return $null}
    # No fallback across engines. Unknown/foundation-only profiles remain
    # explicit and callers decide whether Runnable is acceptable.
    Resolve-AihNexusProfile -InstallRoot $root -ProfileId $requested
}
