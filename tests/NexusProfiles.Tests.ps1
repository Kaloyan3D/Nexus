[CmdletBinding()]
param([string]$InstallRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if([string]::IsNullOrWhiteSpace($InstallRoot)){$InstallRoot=Split-Path -Parent $PSScriptRoot}
$InstallRoot=[IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $InstallRoot 'scripts/Routing.ps1')
. (Join-Path $InstallRoot 'scripts/NexusProfiles.ps1')

$script:passed=0
function Assert-AihTrue {param([bool]$Condition,[string]$Name)if(-not$Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}
function Assert-AihEqual {param($Actual,$Expected,[string]$Name)if("$Actual"-ne"$Expected"){throw "FAIL: $Name (actual='$Actual', expected='$Expected')"};$script:passed++;Write-Host "PASS: $Name"}

function Copy-AihConfigFile {param([string]$Name,[string]$TargetRoot)New-Item -ItemType Directory -Force -Path (Join-Path $TargetRoot 'config')|Out-Null;Copy-Item -LiteralPath (Join-Path $InstallRoot "config/$Name") -Destination (Join-Path $TargetRoot "config/$Name") -Force}

$savedDsh=$env:DSH_AIH_PROFILE
$savedActive=$env:AIH_ACTIVE_PROFILE
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('nexus-profiles-'+[guid]::NewGuid().ToString('N'))
try{
    $catalog=Get-AihNexusProfileCatalog (Join-Path $InstallRoot 'config/nexus-profiles.json')
    Assert-AihEqual @($catalog.profiles).Count 3 'controller plane loads three immutable top-level profile entries'

    $deep=Resolve-AihNexusProfile -InstallRoot $InstallRoot -ProfileId 'deepseek-codex'
    Assert-AihEqual $deep.Engine 'dual' 'DeepSeek + Codex resolves to Dual engine on controller plane'
    Assert-AihTrue ($null-ne$deep.Config.roles.primaryEngineer) 'Dual resolution delegates role configuration to Engineering Profiles'

    $glm=Resolve-AihNexusProfile -InstallRoot $InstallRoot -ProfileId 'GLM-CODEX'
    Assert-AihEqual $glm.Engine 'dual' 'GLM profile ids resolve case-insensitively'
    Assert-AihTrue ([bool]$glm.Runnable) 'existing Dual profiles remain runnable'

    $muse=Resolve-AihNexusProfile -InstallRoot $InstallRoot -ProfileId 'muse-spark-1.3'
    Assert-AihEqual $muse.Engine 'muse' 'Muse resolves to a separate agent engine on controller plane'
    Assert-AihTrue (-not[bool]$muse.Selectable) 'Muse stays non-selectable during M1'
    Assert-AihTrue (-not[bool]$muse.Runnable) 'Muse stays non-runnable during M1'
    Assert-AihEqual $muse.Config.reasoning.default 'xhigh' 'Muse registry carries engine-specific reasoning metadata'

    $unknown=Resolve-AihNexusProfile -InstallRoot $InstallRoot -ProfileId 'unknown-profile'
    Assert-AihTrue ($null-eq$unknown) 'unknown Nexus profile fails closed without engine fallback'

    foreach($name in @('routing-policy.json','engineering-profiles.json','model-registry.json','nexus-profiles.json','muse-profiles.json')){Copy-AihConfigFile $name $fixture}
    New-Item -ItemType Directory -Force -Path (Join-Path $fixture 'data')|Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'data/settings.yaml'),"engineering-profile: glm-codex`n",[Text.UTF8Encoding]::new($false))
    $custom=[ordered]@{
        schemaVersion=1;profileId='custom';displayName='Custom';roles=[ordered]@{
            primaryEngineer=[ordered]@{model='glm-5.3-flash';reasoning='high'}
            deepEngineer=[ordered]@{model='glm-5.3-flash';reasoning='max'}
            reviewer=[ordered]@{model='gpt-5.6-sol';reasoning='medium'}
            solver=[ordered]@{model='gpt-5.6-sol';reasoning='high'}
            fallback=[ordered]@{model='glm-5.3';reasoning='max'}
        }
    }
    $custom|ConvertTo-Json -Depth 10|Set-Content -Encoding UTF8 -LiteralPath (Join-Path $fixture 'data/custom-engineering-profile.json')
    $customResolved=Resolve-AihNexusProfile -InstallRoot $fixture -ProfileId 'custom'
    Assert-AihEqual $customResolved.Engine 'dual' 'operator Custom profile is dynamically classified as Dual'

    $env:DSH_AIH_PROFILE=$null;$env:AIH_ACTIVE_PROFILE=$null
    $active=Resolve-AihActiveNexusProfile -InstallRoot $fixture -Preset 'aih-engineering'
    Assert-AihEqual $active.Id 'glm-codex' 'settings preferred profile participates in Nexus engine resolution'

    $env:AIH_ACTIVE_PROFILE='deepseek-codex'
    $active=Resolve-AihActiveNexusProfile -InstallRoot $fixture -Preset 'aih-engineering'
    Assert-AihEqual $active.Id 'deepseek-codex' 'AIH_ACTIVE_PROFILE preserves existing precedence'

    $env:DSH_AIH_PROFILE='muse-spark-1.3'
    $active=Resolve-AihActiveNexusProfile -InstallRoot $fixture -Preset 'aih-engineering'
    Assert-AihEqual $active.Engine 'muse' 'DSH_AIH_PROFILE can identify Muse without Dual fallback'
    Assert-AihTrue (-not[bool]$active.Runnable) 'active Muse metadata still exposes the M1 execution gate'

    $active=Resolve-AihActiveNexusProfile -InstallRoot $fixture -Preset 'aih-deepseek'
    Assert-AihEqual $active.Id 'deepseek-codex' 'DeepSeek-only preset remains locked against engine override'

    $env:DSH_AIH_PROFILE='does-not-exist'
    $active=Resolve-AihActiveNexusProfile -InstallRoot $fixture -Preset 'aih-engineering'
    Assert-AihTrue ($null-eq$active) 'invalid active profile fails closed instead of selecting another engine'

    # ── Phase M1 integration: the Engineering Profile editor backend is
    #    Nexus-profile-aware (GET classification + deterministic select
    #    gate) while Dual selection and the Custom workflow stay untouched.
    $stateScript=& (Join-Path $InstallRoot 'scripts/EngineeringProfile.ps1') -Action get -InstallRoot $fixture
    $editorState=$stateScript|ConvertFrom-Json
    $nexusIds=@($editorState.nexusProfiles|ForEach-Object{$_.id})
    Assert-AihTrue (($nexusIds -contains 'deepseek-codex')-and($nexusIds -contains 'glm-codex')-and($nexusIds -contains 'muse-spark-1.3')-and($nexusIds -contains 'custom')) 'editor GET exposes the top-level Nexus profile catalog incl. dynamic Custom'
    $glmEntry=@($editorState.nexusProfiles|Where-Object{$_.id -eq 'glm-codex'})[0]
    Assert-AihEqual $glmEntry.engine 'dual' 'GLM + Codex is classified dual in editor state'
    Assert-AihTrue ([bool]$glmEntry.selectable) 'GLM + Codex stays selectable in editor state'
    Assert-AihEqual $glmEntry.roles.primaryEngineer.model 'glm-5.3-flash' 'Dual entries keep delegating role bindings to Engineering Profiles'
    Assert-AihTrue ($null-eq$glmEntry.muse) 'Dual entries carry no Muse metadata'
    $customEntry=@($editorState.nexusProfiles|Where-Object{$_.id -eq 'custom'})[0]
    Assert-AihEqual $customEntry.engine 'dual' 'operator Custom profile is classified dual in editor state'
    Assert-AihEqual $customEntry.builtin $false 'dynamic Custom entry is marked non-builtin'
    $museEntry=@($editorState.nexusProfiles|Where-Object{$_.id -eq 'muse-spark-1.3'})[0]
    Assert-AihEqual $museEntry.engine 'muse' 'Muse Spark 1.3 is classified muse in editor state'
    Assert-AihTrue (-not[bool]$museEntry.selectable) 'Muse stays selectable=false in editor state'
    Assert-AihTrue (-not[bool]$museEntry.runnable) 'Muse stays runnable=false in editor state'
    Assert-AihEqual $museEntry.availability 'foundation' 'Muse availability=foundation in editor state'
    Assert-AihTrue ($null-eq$museEntry.roles) 'Muse entry is NOT coerced into Dual roles'
    Assert-AihEqual $museEntry.muse.reasoning.default 'xhigh' 'Muse metadata exposes reasoning.default=xhigh'
    Assert-AihEqual $museEntry.muse.reasoning.escalation 'max' 'Muse metadata exposes reasoning.escalation=max'
    Assert-AihEqual $museEntry.muse.subagents.enabled $false 'Muse metadata exposes subagents.enabled=false'
    Assert-AihEqual $museEntry.muse.review.independent $false 'Muse metadata exposes review.independent=false'
    Assert-AihEqual $museEntry.muse.contributorProtection.required $true 'Muse metadata exposes contributorProtection.required=true'
    Assert-AihEqual $museEntry.muse.status 'foundation' 'Muse metadata exposes status=foundation'

    # Muse selection is rejected deterministically BEFORE the settings key moves
    $settingsBefore=Get-Content -Raw (Join-Path $fixture 'data/settings.yaml')
    $museSelectRaw=& (Join-Path $InstallRoot 'scripts/EngineeringProfile.ps1') -Action select -InstallRoot $fixture -ProfileId 'muse-spark-1.3'
    $museSelect=$museSelectRaw|ConvertFrom-Json
    Assert-AihEqual $museSelect.ok $false 'select Muse returns ok=false'
    Assert-AihEqual $museSelect.error 'profile-not-selectable' 'select Muse fails deterministically with profile-not-selectable'
    Assert-AihEqual $museSelect.engine 'muse' 'select Muse rejection identifies the blocked engine'
    Assert-AihTrue ((Get-Content -Raw (Join-Path $fixture 'data/settings.yaml')) -eq $settingsBefore) 'rejected Muse selection never writes the settings key'

    # Unknown ids still fail closed (unchanged Dual-era behavior)
    $threw=$false
    try{& (Join-Path $InstallRoot 'scripts/EngineeringProfile.ps1') -Action select -InstallRoot $fixture -ProfileId 'bogus-profile'|Out-Null}catch{$threw=$true}
    Assert-AihTrue $threw 'select of an unknown profile still fails closed'

    # Dual built-ins remain selectable through the same Nexus gate
    $dualSelectRaw=& (Join-Path $InstallRoot 'scripts/EngineeringProfile.ps1') -Action select -InstallRoot $fixture -ProfileId 'deepseek-codex'
    $dualSelect=$dualSelectRaw|ConvertFrom-Json
    Assert-AihTrue ([bool]$dualSelect.ok -and $dualSelect.profileId -eq 'deepseek-codex') 'Dual built-ins remain selectable'
    $settingsAfterDualSelect=Get-Content -Raw (Join-Path $fixture 'data/settings.yaml')
    Assert-AihTrue ([regex]::IsMatch($settingsAfterDualSelect,'(?m)^engineering-profile:\s*deepseek-codex')) 'Dual selection still writes the settings key'

    # save-custom workflow unchanged: role-based, engine dual, never touching Muse
    $customPayloadPath=Join-Path $fixture 'custom-payload.json'
    @{roles=[ordered]@{
        primaryEngineer=[ordered]@{model='glm-5.3-flash';reasoning='high'}
        deepEngineer=[ordered]@{model='glm-5.3-flash';reasoning='max'}
        reviewer=[ordered]@{model='gpt-5.6-sol';reasoning='medium'}
        solver=[ordered]@{model='gpt-5.6-sol';reasoning='high'}
        fallback=[ordered]@{model='glm-5.3';reasoning='max'}
    }}|ConvertTo-Json -Depth 10|Set-Content -Encoding UTF8 -LiteralPath $customPayloadPath
    $savedCustomRaw=& (Join-Path $InstallRoot 'scripts/EngineeringProfile.ps1') -Action save-custom -InstallRoot $fixture -PayloadFile $customPayloadPath
    $savedCustom=$savedCustomRaw|ConvertFrom-Json
    Assert-AihTrue ($null-ne$savedCustom.roles -and $savedCustom.roles.primaryEngineer.model -eq 'glm-5.3-flash') 'save-custom still persists operator role bindings'
    $settingsAfterCustomSave=Get-Content -Raw (Join-Path $fixture 'data/settings.yaml')
    Assert-AihTrue ([regex]::IsMatch($settingsAfterCustomSave,'(?m)^engineering-profile:\s*custom')) 'save-custom still sets the preferred profile to custom'
    $stateScript2=& (Join-Path $InstallRoot 'scripts/EngineeringProfile.ps1') -Action get -InstallRoot $fixture
    $editorState2=$stateScript2|ConvertFrom-Json
    $customEntry2=@($editorState2.nexusProfiles|Where-Object{$_.id -eq 'custom'})[0]
    $museEntry2=@($editorState2.nexusProfiles|Where-Object{$_.id -eq 'muse-spark-1.3'})[0]
    Assert-AihEqual $customEntry2.engine 'dual' 'saved Custom profile remains engine dual (Muse is never rewritten into Custom)'
    Assert-AihTrue (-not[bool]$museEntry2.selectable) 'save-custom leaves Muse non-selectable'
    Assert-AihEqual $museEntry2.availability 'foundation' 'save-custom leaves Muse availability=foundation'

    Write-Host "Nexus controller profile foundation tests passed: $script:passed"
}finally{
    $env:DSH_AIH_PROFILE=$savedDsh
    $env:AIH_ACTIVE_PROFILE=$savedActive
    if(Test-Path -LiteralPath $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}
}
