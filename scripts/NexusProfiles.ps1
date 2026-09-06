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
    }
    $profiles
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
