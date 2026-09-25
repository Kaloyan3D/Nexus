[CmdletBinding()]
param(
 [ValidateSet('get','select','save-custom')][string]$Action='get',
 [string]$InstallRoot,
 [string]$ProfileId,
 [string]$PayloadFile
)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if([string]::IsNullOrWhiteSpace($InstallRoot)){$InstallRoot=Split-Path -Parent $PSScriptRoot}
$InstallRoot=[System.IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Routing.ps1')
# Phase M1: the user-facing profile list is the top-level Nexus Profile
# catalog (config/nexus-profiles.json). NexusProfiles.ps1 owns that
# classification; Dual role details stay in Routing.ps1's Engineering
# Profiles registry and Muse details stay in the Muse profile registry.
. (Join-Path $PSScriptRoot 'NexusProfiles.ps1')

# ── Phase 2.1: Engineering Profile editor backend contract ────────────────
# The browser NEVER edits config files or ledgers directly. Every read/write
# for the editor goes through this controller boundary:
#   get         — read-only editor state (profiles, registry, preferred,
#                 custom bindings, role requirements, compatible models)
#   select      — set the PREFERRED profile (built-in or custom) by writing
#                 the engineering-profile: key into the live settings
#   save-custom — validate + atomically persist the operator's custom role
#                 bindings to data/custom-engineering-profile.json and set
#                 the preferred profile to custom
# Validation is fail-closed and atomic: an invalid payload never partially
# writes; the last valid configuration is preserved.

function Get-AihPreferredProfileId {
    param([string]$SettingsPath)
    if([string]::IsNullOrWhiteSpace($SettingsPath)-or-not(Test-Path -LiteralPath $SettingsPath)){return $null}
    $text=Get-Content -Raw -Encoding UTF8 -LiteralPath $SettingsPath
    $match=[regex]::Match($text,'(?m)^engineering-profile:\s*([^\s#\r\n]+)')
    if(-not$match.Success){return $null}
    $value=$match.Groups[1].Value.Trim().Trim('''','"')
    if([string]::IsNullOrWhiteSpace($value)){return $null}
    $value
}

function Set-AihEngineeringProfileKey {
    param([Parameter(Mandatory=$true)][string]$SettingsPath,[Parameter(Mandatory=$true)][string]$ProfileId)
    $mutex=[Threading.Mutex]::new($false,(ConvertTo-AihSafeSyncName 'Local\AIHarness.EngineeringProfile'))
    $locked=$false
    try{
        $locked=$mutex.WaitOne([TimeSpan]::FromSeconds(10))
        if(-not$locked){throw 'Timed out waiting to update engineering profile settings.'}
        $text=Get-Content -Raw -Encoding UTF8 -LiteralPath $SettingsPath
        $newline=if($text-match"\r\n"){"\r\n"}else{"\n"}
        $pattern='(?m)^engineering-profile:\s*([^\r\n]*)'
        if([regex]::IsMatch($text,$pattern)){ $text=[regex]::Replace($text,$pattern,"engineering-profile: $ProfileId",1) }
        else { $text="engineering-profile: $ProfileId"+$newline+$newline+$text.TrimStart() }
        $directory=Split-Path -Parent $SettingsPath
        $temporary=Join-Path $directory ('.settings-{0}.tmp'-f[guid]::NewGuid().ToString('N'))
        try{
            [IO.File]::WriteAllText($temporary,$text,[Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $temporary -Destination $SettingsPath -Force
        }finally{ if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force} }
    }finally{ if($locked){$mutex.ReleaseMutex()};$mutex.Dispose() }
}

# Phase M1: resolve every top-level Nexus Profile catalog entry to its
# engine-specific configuration for the editor. Dual entries keep their
# Engineering Profile role bindings; Muse entries carry Muse registry
# metadata ONLY (never Dual roles). A missing or invalid catalog degrades
# to an EMPTY list — the state never guesses an engine classification.
function Get-AihNexusEditorProfiles {
    param([object]$Layout)
    try{
        $catalogPath=Join-Path $Layout.Root 'config/nexus-profiles.json'
        $entries=Get-AihNexusProfiles -CatalogPath $catalogPath -EngineeringProfilesPath $Layout.EngineeringProfiles -CustomEngineeringProfilePath $Layout.CustomEngineeringProfile
        $resolved=@()
        foreach($entry in @($entries)){
            # NOTE: never name this '$profile' — that is a PowerShell automatic variable.
            # M1.1 parity: per-entry resolution — an engine-specific source that
            # cannot be resolved (e.g. missing muse-profiles.json) skips ONLY that
            # entry; a partially-resolved entry is never exposed.
            $resolvedProfile=$null
            try{$resolvedProfile=Resolve-AihNexusProfile -InstallRoot $Layout.Root -ProfileId ([string]$entry.id)}catch{$resolvedProfile=$null}
            if($null-eq$resolvedProfile){continue}
            $isDual=[string]$resolvedProfile.Engine -eq 'dual'
            $resolved+=[pscustomobject][ordered]@{
                id=[string]$resolvedProfile.Id
                displayName=[string]$resolvedProfile.DisplayName
                engine=[string]$resolvedProfile.Engine
                selectable=[bool]$resolvedProfile.Selectable
                runnable=[bool]$resolvedProfile.Runnable
                availability=[string]$resolvedProfile.Availability
                source=$resolvedProfile.Source
                builtin=if($null-ne$entry.PSObject.Properties['builtin']){[bool]$entry.builtin}else{$true}
                roles=if($isDual){$resolvedProfile.Config.roles}else{$null}
                muse=if(-not$isDual){$resolvedProfile.Config}else{$null}
            }
        }
        @($resolved)
    }catch{ @() }
}

function Get-AihEditorState {
    param([object]$Layout,[object]$Policy)
    $profiles=Get-AihEngineeringProfiles $Layout.EngineeringProfiles $Layout.CustomEngineeringProfile
    $registry=Get-AihModelRegistry $Layout.ModelRegistry
    $preferredId=Get-AihPreferredProfileId $Layout.Settings
    $preferredDisplayName=$preferredId
    $preferredEngine=$null
    $preferredRoute=$null
    if(-not[string]::IsNullOrWhiteSpace($preferredId)){
        try{
            $preferredNexus=Resolve-AihNexusProfile -InstallRoot $Layout.Root -ProfileId $preferredId
            if($null-ne$preferredNexus){$preferredEngine=[string]$preferredNexus.Engine}
            if($null-ne$preferredNexus-and[string]$preferredNexus.Engine-eq'muse'){
                $resolvedRoute=Resolve-AihMuseRoutingTarget -InstallRoot $Layout.Root -PresetId 'aih-muse' -SettingsPath $Layout.Settings -ProfileId $preferredId
                if([string]$resolvedRoute.ProfileId -eq $preferredId){$preferredRoute=[pscustomobject]@{profileId=[string]$resolvedRoute.ProfileId;engine='muse';provider=[string]$resolvedRoute.Provider;model=[string]$resolvedRoute.Model}}
            }
        }catch{$preferredRoute=$null}
    }
    $catalog=Get-AihNexusProfileCatalog (Join-Path $Layout.Config 'nexus-profiles.json')
    $engineAgentPresets=[ordered]@{}
    if($null-ne$catalog.PSObject.Properties['engines']){
        foreach($engineEntry in @($catalog.engines.PSObject.Properties)){
            if($null-ne$engineEntry.Value-and$null-ne$engineEntry.Value.PSObject.Properties['agentPreset']){$engineAgentPresets[$engineEntry.Name]=[string]$engineEntry.Value.agentPreset}
        }
    }
    if(-not[string]::IsNullOrWhiteSpace($preferredId)){
        foreach($profileEntry in @($profiles.profiles)){ if([string]$profileEntry.id -eq $preferredId){$preferredDisplayName=[string]$profileEntry.displayName;break} }
    }
    $customRoles=$null
    if(Test-Path -LiteralPath $Layout.CustomEngineeringProfile -PathType Leaf){
        $custom=Get-Content -Raw -Encoding UTF8 -LiteralPath $Layout.CustomEngineeringProfile|ConvertFrom-Json
        $customRoles=$custom.roles
    }
    $roleModels=[ordered]@{}
    # visualReviewer is an OPTIONAL role: exposed to the editor (requirements +
    # compatible models) but never part of the mandatory satisfiability set.
    foreach($role in @('primaryEngineer','deepEngineer','reviewer','solver','fallback','visualReviewer')){
        $roleModels[$role]=@(Get-AihCompatibleModelsForRole $registry $role)
    }
    [pscustomobject]@{
        schemaVersion=1
        generatedAtUtc=[DateTime]::UtcNow.ToString('o')
        profiles=@($profiles.profiles)
        nexusProfiles=Get-AihNexusEditorProfiles $Layout
        engineAgentPresets=$engineAgentPresets
        registry=$registry.models
        preferredProfile=if([string]::IsNullOrWhiteSpace($preferredId)){$null}else{[pscustomobject]@{id=$preferredId;displayName=$preferredDisplayName}}
        preferredEngine=$preferredEngine
        preferredRoute=$preferredRoute
        customRoles=$customRoles
        roleRequirements=[ordered]@{
            primaryEngineer=Get-AihRoleRequirements 'primaryEngineer'
            deepEngineer=Get-AihRoleRequirements 'deepEngineer'
            reviewer=Get-AihRoleRequirements 'reviewer'
            solver=Get-AihRoleRequirements 'solver'
            fallback=Get-AihRoleRequirements 'fallback'
            visualReviewer=Get-AihRoleRequirements 'visualReviewer'
        }
        roleModels=$roleModels
    }
}

function Save-AihCustomProfile {
    param([object]$Layout,[object]$Payload)
    if($null-eq$Payload-or$null-eq$Payload.PSObject.Properties['roles']){throw 'save-custom requires a roles object.'}
    $roles=$Payload.roles
    # CORE roles are mandatory; OPTIONAL roles (visualReviewer) are validated
    # only when the operator actually declares them, so legacy/custom profiles
    # without a visual binding stay valid (Phase V0/V1 backward compatibility).
    $missing=@();foreach($role in @('primaryEngineer','deepEngineer','reviewer','solver','fallback')){if($null-eq$roles.PSObject.Properties[$role]){$missing+=$role}}
    if($missing.Count-gt0){throw "Custom profile is missing role binding(s): $($missing -join ', ')"}
    $registry=Get-AihModelRegistry $Layout.ModelRegistry
    $candidate=[ordered]@{id='custom';displayName='Custom';roles=[ordered]@{}}
    $coreRoles=@('primaryEngineer','deepEngineer','reviewer','solver','fallback')
    $optionalRoles=@('visualReviewer')
    foreach($role in $coreRoles){
        $binding=$roles.$role
        $modelId=[string]$binding.model
        $reasoning=[string]$binding.reasoning
        if([string]::IsNullOrWhiteSpace($modelId)){throw "Custom profile role $role has no model."}
        if([string]::IsNullOrWhiteSpace($reasoning)){throw "Custom profile role $role has no reasoning level."}
        $entry=$null
        foreach($candidateEntry in @($registry.models)){if([string]$candidateEntry.id -eq $modelId){$entry=$candidateEntry;break}}
        if($null-eq$entry){throw "Custom profile role $role references unknown model id '$modelId'."}
        if(-not(Test-AihModelRoleCompatible $entry $role $reasoning)){throw "Custom profile role $role is incompatible with model '$modelId' (reasoning '$reasoning')." }
        $candidate.roles[$role]=[ordered]@{model=$modelId;reasoning=$reasoning}
    }
    foreach($role in $optionalRoles){
        if($null-eq$roles.PSObject.Properties[$role]-or$null-eq$roles.$role){continue}
        $binding=$roles.$role
        $modelId=[string]$binding.model
        $reasoning=[string]$binding.reasoning
        if([string]::IsNullOrWhiteSpace($modelId)){throw "Custom profile role $role has no model."}
        if([string]::IsNullOrWhiteSpace($reasoning)){throw "Custom profile role $role has no reasoning level."}
        $entry=$null
        foreach($candidateEntry in @($registry.models)){if([string]$candidateEntry.id -eq $modelId){$entry=$candidateEntry;break}}
        if($null-eq$entry){throw "Custom profile role $role references unknown model id '$modelId'."}
        if(-not(Test-AihModelRoleCompatible $entry $role $reasoning)){throw "Custom profile role $role is incompatible with model '$modelId' (reasoning '$reasoning')." }
        $candidate.roles[$role]=[ordered]@{model=$modelId;reasoning=$reasoning}
    }
    $document=[ordered]@{schemaVersion=1;profileId='custom';displayName='Custom';roles=$candidate.roles}
    Write-AihAtomicJson -Path $Layout.CustomEngineeringProfile -Value $document
    Set-AihEngineeringProfileKey $Layout.Settings 'custom'
    $document
}

$layout=Get-AihLayout $InstallRoot
$policy=Get-AihRoutingPolicy $layout.RoutingPolicy
$payload=$null
if($PayloadFile){
    if(-not(Test-Path -LiteralPath $PayloadFile)){throw "Payload file not found: $PayloadFile"}
    $payload=Get-Content -Raw -Encoding UTF8 -LiteralPath $PayloadFile|ConvertFrom-Json
}
$(switch($Action){
    'get'{Get-AihEditorState $layout $policy}
    'select'{
        if([string]::IsNullOrWhiteSpace($ProfileId)){throw 'select requires -ProfileId.'}
        $selectId=$ProfileId.Trim().ToLowerInvariant()
        # Phase M1.2: the top-level Nexus catalog is authoritative for this
        # current backend. Selection permission depends on `selectable` only,
        # but a missing/corrupt catalog must NEVER silently fall back to the
        # legacy Dual registry. Engine-specific resolution failures also fail
        # closed without writing the preferred-profile settings key.
        $catalogPath=Join-Path $InstallRoot 'config/nexus-profiles.json'
        $catalogAvailable=$true
        try{$null=Get-AihNexusProfileCatalog $catalogPath}catch{$catalogAvailable=$false}
        if(-not$catalogAvailable){
            [pscustomobject][ordered]@{ok=$false;error='nexus-profile-catalog-unavailable';profileId=$selectId}
        }
        else{
            $resolvedNexus=$null
            $resolutionAvailable=$true
            try{$resolvedNexus=Resolve-AihNexusProfile -InstallRoot $InstallRoot -ProfileId $selectId}catch{$resolutionAvailable=$false}
            if(-not$resolutionAvailable){
                [pscustomobject][ordered]@{ok=$false;error='nexus-profile-resolution-unavailable';profileId=$selectId}
            }
            elseif($null-ne$resolvedNexus -and [bool]$resolvedNexus.Selectable){
                Set-AihEngineeringProfileKey $layout.Settings $selectId
                [pscustomobject]@{ok=$true;profileId=$selectId}
            }
            elseif($null-ne$resolvedNexus){
                [pscustomobject][ordered]@{ok=$false;error='profile-not-selectable';profileId=$selectId;engine=[string]$resolvedNexus.Engine}
            }
            else{
                throw "Unknown Nexus profile '$ProfileId'."
            }
        }
    }
    'save-custom'{Save-AihCustomProfile $layout $payload}
})|ConvertTo-Json -Depth 20
