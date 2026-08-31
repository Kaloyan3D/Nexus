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
    $mutex=[Threading.Mutex]::new($false,'Local\AIHarness.EngineeringProfile')
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

function Get-AihEditorState {
    param([object]$Layout,[object]$Policy)
    $profiles=Get-AihEngineeringProfiles $Layout.EngineeringProfiles $Layout.CustomEngineeringProfile
    $registry=Get-AihModelRegistry $Layout.ModelRegistry
    $preferredId=Get-AihPreferredProfileId $Layout.Settings
    $preferredDisplayName=$preferredId
    if(-not[string]::IsNullOrWhiteSpace($preferredId)){
        foreach($profile in @($profiles.profiles)){ if([string]$profile.id -eq $preferredId){$preferredDisplayName=[string]$profile.displayName;break} }
    }
    $customRoles=$null
    if(Test-Path -LiteralPath $Layout.CustomEngineeringProfile -PathType Leaf){
        $custom=Get-Content -Raw -Encoding UTF8 -LiteralPath $Layout.CustomEngineeringProfile|ConvertFrom-Json
        $customRoles=$custom.roles
    }
    $roleModels=[ordered]@{}
    foreach($role in @('primaryEngineer','deepEngineer','reviewer','solver','fallback')){
        $roleModels[$role]=@(Get-AihCompatibleModelsForRole $registry $role)
    }
    [pscustomobject]@{
        schemaVersion=1
        generatedAtUtc=[DateTime]::UtcNow.ToString('o')
        profiles=@($profiles.profiles)
        registry=$registry.models
        preferredProfile=if([string]::IsNullOrWhiteSpace($preferredId)){$null}else{[pscustomobject]@{id=$preferredId;displayName=$preferredDisplayName}}
        customRoles=$customRoles
        roleRequirements=[ordered]@{
            primaryEngineer=Get-AihRoleRequirements 'primaryEngineer'
            deepEngineer=Get-AihRoleRequirements 'deepEngineer'
            reviewer=Get-AihRoleRequirements 'reviewer'
            solver=Get-AihRoleRequirements 'solver'
            fallback=Get-AihRoleRequirements 'fallback'
        }
        roleModels=$roleModels
    }
}

function Save-AihCustomProfile {
    param([object]$Layout,[object]$Payload)
    if($null-eq$Payload-or$null-eq$Payload.PSObject.Properties['roles']){throw 'save-custom requires a roles object.'}
    $roles=$Payload.roles
    $missing=@();foreach($role in @('primaryEngineer','deepEngineer','reviewer','solver','fallback')){if($null-eq$roles.PSObject.Properties[$role]){$missing+=$role}}
    if($missing.Count-gt0){throw "Custom profile is missing role binding(s): $($missing -join ', ')"}
    $registry=Get-AihModelRegistry $Layout.ModelRegistry
    $candidate=[ordered]@{id='custom';displayName='Custom';roles=[ordered]@{}}
    foreach($role in @('primaryEngineer','deepEngineer','reviewer','solver','fallback')){
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
        $profiles=Get-AihEngineeringProfiles $layout.EngineeringProfiles $layout.CustomEngineeringProfile
        $known=@($profiles.profiles|Where-Object{$_.id -eq $ProfileId.Trim().ToLowerInvariant()})
        if($known.Count-eq0){throw "Unknown engineering profile '$ProfileId'."}
        Set-AihEngineeringProfileKey $layout.Settings ($ProfileId.Trim().ToLowerInvariant())
        [pscustomobject]@{ok=$true;profileId=$ProfileId.Trim().ToLowerInvariant()}
    }
    'save-custom'{Save-AihCustomProfile $layout $payload}
})|ConvertTo-Json -Depth 20
