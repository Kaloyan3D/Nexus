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

    Write-Host "Nexus controller profile foundation tests passed: $script:passed"
}finally{
    $env:DSH_AIH_PROFILE=$savedDsh
    $env:AIH_ACTIVE_PROFILE=$savedActive
    if(Test-Path -LiteralPath $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}
}
