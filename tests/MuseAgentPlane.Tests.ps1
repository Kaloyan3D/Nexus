[CmdletBinding()]
param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot))

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
try{[Console]::OutputEncoding=[Text.Encoding]::UTF8}catch{}

# Phase M3 suite (TASK-0040): the Muse Agent Plane V0 ROUTING plane.
# Fully OFFLINE and deterministic. One engine dispatch seam, one target
# authority, no fallback, no Dual role semantics on the muse plane, and the
# Dual path byte-compatibly unchanged.

. (Join-Path $PSScriptRoot 'TestHelpers.ps1')
. (Join-Path (Join-Path $InstallRoot 'scripts') 'Common.ps1')
. (Join-Path (Join-Path $InstallRoot 'scripts') 'Routing.ps1')
. (Join-Path (Join-Path $InstallRoot 'scripts') 'NexusProfiles.ps1')
. (Join-Path (Join-Path $InstallRoot 'scripts') 'TaskController.ps1')

$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not$Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}

function Copy-AihConfigFile([string]$Name,[string]$FixtureRoot){
    $target=Join-Path $FixtureRoot ('config/'+$Name)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target)|Out-Null
    Copy-Item (Join-Path $InstallRoot ('config/'+$Name)) $target
}

# A fixture install root whose ONLY difference from production is that the
# Muse profile is runnable/selectable: production stays contributor-locked.
function New-AihMuseRoutingFixture{
    $fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('aih-muse-routing-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path (Join-Path $fixtureRoot 'data')|Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $fixtureRoot 'ws')|Out-Null
    foreach($name in @('routing-policy.json','engineering-profiles.json','model-registry.json','nexus-profiles.json','muse-profiles.json')){
        Copy-AihConfigFile $name $fixtureRoot
    }
    $catalogPath=Join-Path $fixtureRoot 'config/nexus-profiles.json'
    $catalogText=[IO.File]::ReadAllText($catalogPath).Replace('"selectable": false','"selectable": true').Replace('"runnable": false','"runnable": true')
    [IO.File]::WriteAllText($catalogPath,$catalogText,[Text.UTF8Encoding]::new($false))
    $settings=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'config/settings.yaml')
    $settingsPath=Join-Path (Join-Path $fixtureRoot 'data') 'settings.yaml'
    [IO.File]::WriteAllText($settingsPath,($settings+"muse-contributor-execution:`r`n  acknowledgement: accepted-v1`r`n"),[Text.UTF8Encoding]::new($false))
    $noConsentPath=Join-Path (Join-Path $fixtureRoot 'data') 'settings-no-consent.yaml'
    [IO.File]::WriteAllText($noConsentPath,$settings,[Text.UTF8Encoding]::new($false))
    [pscustomobject]@{ Root=$fixtureRoot; Settings=$settingsPath; NoConsent=$noConsentPath; Workspace=(Join-Path $fixtureRoot 'ws'); Policy=(Join-Path $fixtureRoot 'config/routing-policy.json'); Catalog=(Join-Path $fixtureRoot 'config/nexus-profiles.json'); Registry=(Join-Path $fixtureRoot 'config/model-registry.json'); MuseProfiles=(Join-Path $fixtureRoot 'config/muse-profiles.json') }
}

$savedProfileEnv=$env:DSH_AIH_PROFILE
$savedActiveProfileEnv=$env:AIH_ACTIVE_PROFILE
$savedPresetEnv=$env:DSH_AIH_PRESET
$savedActivePresetEnv=$env:AIH_ACTIVE_PRESET
$env:DSH_AIH_PROFILE=$null
$env:AIH_ACTIVE_PROFILE=$null
$env:DSH_AIH_PRESET=$null
$env:AIH_ACTIVE_PRESET=$null
$fixture=$null
try{
    $fixture=New-AihMuseRoutingFixture

    # -- 1. Routing policy: the aih-muse agent plane is a REAL preset; version 3 unchanged
    $policy=Get-AihRoutingPolicy $fixture.Policy
    Assert-Aih ([int]$policy.version -eq 3) '1.1: routing policy version stays 3 (Dual contract untouched)'
    $musePreset=$policy.presets.PSObject.Properties['aih-muse'].Value
    Assert-Aih ($null-ne$musePreset) '1.2: the aih-muse agent plane exists in the routing policy'
    Assert-Aih ($musePreset.allowOpenAI -eq $false -and $musePreset.allowCodexSubagent -eq $false) '1.3: the muse plane carries no Codex/OpenAI permissions'
    Assert-Aih ($musePreset.failurePolicy -eq 'fail-closed') '1.4: the muse plane fails closed on failure'
    Assert-Aih ($musePreset.rootExecutor.provider -eq 'meta-model-api' -and $musePreset.rootExecutor.model -eq 'muse-spark-1.3-contributor' -and $musePreset.rootExecutor.reasoning -eq 'xhigh') '1.5: rootExecutor pins the exact Muse target'
    Assert-Aih ($musePreset.profileOverrideAllowed -eq $false) '1.6: the muse preset locks its own profile binding'
    $dualPreset=$policy.presets.PSObject.Properties['aih-engineering'].Value
    Assert-Aih ($dualPreset.allowCodexSubagent -eq $true -and $dualPreset.failurePolicy -ne 'fail-closed') '1.7: the Dual aih-engineering policy remains unchanged'

    # -- 2. THE dispatch seam: muse preset routes through the Muse branch
    $muse=Invoke-AihRoutingDecision -Description 'Ordinary engineering work on the muse plane.' -Workspace $fixture.Workspace -PolicyPath $fixture.Policy -DataRoot (Join-Path $fixture.Root 'data/routing') -Preset 'aih-muse' -DryRun -SettingsPath $fixture.Settings
    Assert-Aih ($muse.engine -eq 'muse') '2.1: the muse preset dispatches the Muse engine branch (engine=muse)'
    Assert-Aih ($muse.preset -eq 'aih-muse') '2.2: the record names the aih-muse agent plane'
    Assert-Aih ($muse.provider -eq 'meta-model-api' -and $muse.model -eq 'muse-spark-1.3-contributor') '2.3: the muse target resolves to the exact registry identity'
    Assert-Aih ($muse.reasoning -eq 'xhigh') '2.4: reasoning is the profile default xhigh'
    Assert-Aih ($muse.profile -eq 'muse-spark-1.3-contributor') '2.5: the record carries the muse Nexus profile id'
    Assert-Aih ($null-eq$muse.role) '2.6: NO Dual role exists on the muse plane (role is null)'
    Assert-Aih ($muse.executionClass -eq 'muse_main') '2.7: Muse owns its execution semantics (muse_main)'
    Assert-Aih ($muse.dataUseTier -eq 'contributor' -and $muse.contributorProtectionRequired -eq $true) '2.8: Contributor metadata survives end to end in the record'
    Assert-Aih ($muse.reviewRequired -eq $false -and $muse.writable -eq $true) '2.9: the muse main agent is the writable executor with no review requirement'
    Assert-Aih ($null-eq$muse.escalatedFrom -and $muse.manualOverride -eq $false) '2.10: no escalation/override semantics exist on the muse plane'

    # -- 3. Dual path unchanged: same call shape, byte-compatible record
    $dual=Invoke-AihRoutingDecision -Description 'Ordinary engineering work on the controller plane.' -Workspace $fixture.Workspace -PolicyPath $fixture.Policy -DataRoot (Join-Path $fixture.Root 'data/routing') -Preset 'aih-engineering' -DryRun -SettingsPath $fixture.Settings
    Assert-Aih ($dual.engine -eq 'dual') '3.1: the Dual record carries its authoritative engine identity'
    Assert-Aih ($null-eq$dual.PSObject.Properties['dataUseTier'] -and $null-eq$dual.PSObject.Properties['contributorProtectionRequired']) '3.2: the Dual record carries no muse-only fields'
    Assert-Aih ($dual.executionClass -eq 'engineer_normal' -and $dual.role -eq 'primaryEngineer') '3.3: the Dual path keeps its role semantics'
    Assert-Aih ($dual.preset -eq 'aih-engineering') '3.4: the Dual record names its own preset'
    $mechanical=Invoke-AihRoutingDecision -Description 'run tests' -Workspace $fixture.Workspace -PolicyPath $fixture.Policy -DataRoot (Join-Path $fixture.Root 'data/routing') -Preset 'aih-engineering' -DryRun -SettingsPath $fixture.Settings
    Assert-Aih ($mechanical.executionClass -eq 'deterministic' -and $mechanical.role -eq $null) '3.5: Dual deterministic routing is unchanged'

    # -- 3b. Critical Muse work stays on the Muse main-agent plane
    $criticalMuse=Invoke-AihRoutingDecision -Description 'Fix the authentication authorization security boundary, database migration, and concurrency correctness defects.' -Workspace $fixture.Workspace -PolicyPath $fixture.Policy -DataRoot (Join-Path $fixture.Root 'data/routing') -Preset 'aih-muse' -DryRun -SettingsPath $fixture.Settings
    Assert-Aih ($criticalMuse.engine -eq 'muse' -and $criticalMuse.executionClass -eq 'muse_main' -and $null-eq$criticalMuse.role) '3.6: critical/security Muse work remains Muse-native with no Dual role'
    Assert-Aih ($criticalMuse.provider -eq 'meta-model-api' -and $criticalMuse.model -eq 'muse-spark-1.3-contributor') '3.7: critical/security Muse work keeps the Muse target'
    Assert-Aih (-not [bool]$criticalMuse.reviewRequired -and $null-eq$criticalMuse.escalatedFrom) '3.8: critical/security Muse work does not request a Dual reviewer or fallback'

    # -- 4. Fail closed: a muse profile active on a Dual agent plane
    $env:DSH_AIH_PROFILE='muse-spark-1.3-contributor'
    $threwMismatch=$false
    try{ Invoke-AihRoutingDecision -Description 'x' -Workspace $fixture.Workspace -PolicyPath $fixture.Policy -DataRoot (Join-Path $fixture.Root 'data/routing') -Preset 'aih-engineering' -DryRun -SettingsPath $fixture.Settings | Out-Null }catch{ $threwMismatch=($_.Exception.Message -like 'Muse routing rejected:*muse engine*') }
    Assert-Aih $threwMismatch '4.1: a muse-engine profile on a Dual preset fails closed (engine/preset coupling)'
    $env:DSH_AIH_PROFILE=$null

    # -- 5. Fail closed: contributor consent is required end to end
    Assert-Aih (-not(Test-AihMuseContributorAcknowledgement -SettingsPath $fixture.NoConsent)) '5.1: no acknowledgement in settings means no consent'
    Assert-Aih (Test-AihMuseContributorAcknowledgement -SettingsPath $fixture.Settings) '5.2: the exact versioned acknowledgement satisfies the gate'
    $wrongConsent=Join-Path $fixture.Root 'data/settings-wrong-consent.yaml'
    $wrongText=((Get-Content -Raw $fixture.Settings).Replace('accepted-v1','accepted-v0'))
    [IO.File]::WriteAllText($wrongConsent,$wrongText,[Text.UTF8Encoding]::new($false))
    Assert-Aih (-not(Test-AihMuseContributorAcknowledgement -SettingsPath $wrongConsent)) '5.3: a stale acknowledgement version fails closed'
    $threwConsent=$false
    try{ Invoke-AihMuseRoutingDecision -Description 'x' -Workspace $fixture.Workspace -PolicyPath $fixture.Policy -DataRoot (Join-Path $fixture.Root 'data/routing') -Preset 'aih-muse' -DryRun -SettingsPath $fixture.NoConsent | Out-Null }catch{ $threwConsent=($_.Exception.Message -like '*contributorProtection.required*') }
    Assert-Aih $threwConsent '5.4: without consent the muse branch fails closed naming the exact gate'

    # -- 6. Fail closed: incomplete target chains never fall back
    $noRoute=Join-Path $fixture.Root 'data/settings-no-route.yaml'
    $noRouteText=[regex]::Replace((Get-Content -Raw $fixture.Settings),'(?ms)^llm-pi-ai:.*?(?=^[a-z#])','')
    [IO.File]::WriteAllText($noRoute,$noRouteText,[Text.UTF8Encoding]::new($false))
    Assert-Aih (-not(Test-AihMuseProviderRouteConfigured -SettingsPath $noRoute -ProviderId 'meta-model-api')) '6.1: a settings document without the provider route is detected'
    Assert-Aih (Test-AihMuseProviderRouteConfigured -SettingsPath $fixture.Settings -ProviderId 'meta-model-api') '6.2: the managed provider route is detected'
    $threwRoute=$false
    try{ Resolve-AihMuseRoutingTarget -InstallRoot $fixture.Root -PresetId 'aih-muse' -SettingsPath $noRoute | Out-Null }catch{ $threwRoute=($_.Exception.Message -like '*provider route*') }
    Assert-Aih $threwRoute '6.3: an unconfigured provider route fails closed at resolution'
    $registry=Get-AihModelRegistry $fixture.Registry
    $noMuseRegistry=[pscustomobject]@{schemaVersion=1;models=@($registry.models|Where-Object{[string]$_.id -ne 'muse-spark-1.3-contributor'})}
    $noMuseRegistryPath=Join-Path $fixture.Root 'config/model-registry-nomuse.json'
    [IO.File]::WriteAllText($noMuseRegistryPath,($noMuseRegistry|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $fixture.Registry -Destination (Join-Path $fixture.Root 'config/model-registry-real.json')
    Move-Item -LiteralPath $noMuseRegistryPath -Destination $fixture.Registry
    $threwChain=$false
    try{ Resolve-AihMuseRoutingTarget -InstallRoot $fixture.Root -PresetId 'aih-muse' -SettingsPath $fixture.Settings | Out-Null }catch{ $threwChain=($_.Exception.Message -like '*target chain is incomplete*') }
    Assert-Aih $threwChain '6.4: a registry without the muse model fails closed (profile -> registry -> provider)'
    Move-Item -LiteralPath $fixture.Registry -Destination $noMuseRegistryPath
    Move-Item -LiteralPath (Join-Path $fixture.Root 'config/model-registry-real.json') -Destination $fixture.Registry

    # -- 7. Fail closed: unsupported reasoning ceiling
    $museProfilesPath=$fixture.MuseProfiles
    $museDoc=Get-Content -Raw -Encoding UTF8 $museProfilesPath|ConvertFrom-Json
    $savedEscalation=$museDoc.profiles[0].reasoning.escalation
    $museDoc.profiles[0].reasoning.escalation='ultra'
    [IO.File]::WriteAllText($museProfilesPath,($museDoc|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    $threwReasoning=$false
    try{ Resolve-AihMuseRoutingTarget -InstallRoot $fixture.Root -PresetId 'aih-muse' -SettingsPath $fixture.Settings | Out-Null }catch{ $threwReasoning=($_.Exception.Message -like '*not supported by model*') }
    Assert-Aih $threwReasoning '7.1: an unsupported escalation reasoning ceiling fails closed at resolution'
    $museDoc.profiles[0].reasoning.escalation=$savedEscalation
    [IO.File]::WriteAllText($museProfilesPath,($museDoc|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))

    # -- 8. Production activation truth after M5
    $readyTarget=Resolve-AihNexusProfile -InstallRoot $InstallRoot -ProfileId 'muse-spark-1.3-contributor'
    Assert-Aih ($readyTarget.runnable -eq $true -and $readyTarget.selectable -eq $true) '8.1: the production Muse profile is explicitly selectable/runnable after M5'
    Assert-Aih ($readyTarget.engine -eq 'muse') '8.2: the ready profile still classifies as the muse engine'
    Assert-Aih ($readyTarget.availability -eq 'ready') '8.3: profile availability agrees with the completed local Contributor gate'
    $productionTarget=Resolve-AihMuseRoutingTarget -InstallRoot $InstallRoot -PresetId 'aih-muse' -SettingsPath (Join-Path $InstallRoot 'data/settings.yaml')
    Assert-Aih ($productionTarget.provider -eq 'meta-model-api' -and $productionTarget.model -eq 'muse-spark-1.3-contributor' -and $productionTarget.reasoning -eq 'xhigh') '8.4: production activation resolves the exact protected Muse target'

    # -- 9. Malformed catalog engine binding fails closed
    $badCatalogPath=Join-Path $fixture.Root 'config/nexus-profiles-bad.json'
    $badText=((Get-Content -Raw $fixture.Catalog).Replace('"agentPreset": "aih-muse"','"agentPreset": "Muse Plane!"'))
    [IO.File]::WriteAllText($badCatalogPath,$badText,[Text.UTF8Encoding]::new($false))
    $threwCatalog=$false
    try{ Get-AihNexusProfileCatalog $badCatalogPath | Out-Null }catch{ $threwCatalog=$true }
    Assert-Aih $threwCatalog '9.1: a malformed engines.agentPreset binding fails closed at catalog load'
    Assert-Aih ((Get-AihNexusProfileCatalog $fixture.Catalog) -ne $null) '9.2: the well-formed catalog with the aih-muse binding loads'
    $emptyPresetCatalog=Join-Path $fixture.Root 'config/nexus-profiles-empty.json'
    $emptyText=((Get-Content -Raw $fixture.Catalog).Replace('"agentPreset": "aih-muse"','"agentPreset": ""'))
    [IO.File]::WriteAllText($emptyPresetCatalog,$emptyText,[Text.UTF8Encoding]::new($false))
    $threwEmpty=$false
    try{ Get-AihNexusProfileCatalog $emptyPresetCatalog | Out-Null }catch{ $threwEmpty=$true }
    Assert-Aih $threwEmpty '9.3: an empty agentPreset binding fails closed'

    # -- 10. Review isolation: Muse never reaches a reviewer
    $reviewScenarios=@(
        @{Name='10.1: explicit review request fails closed on the muse plane';Key='ReviewRequested';Value=$true},
        @{Name='10.3: the user-codex signal fails closed on the muse plane';Key='Signal';Value='user-codex'},
        @{Name='10.4: review findings cannot return to a muse task';Key='Signal';Value='review-findings'},
        @{Name='10.5: manual execution-class overrides are Dual semantics only';Key='ForceClass';Value='engineer_deep'},
        @{Name='10.6: manual tier overrides are Dual semantics only';Key='ForceTier';Value='2'}
    )
    foreach($scenario in $reviewScenarios){
        $scenarioParams=@{Description='x';Workspace=$fixture.Workspace;PolicyPath=$fixture.Policy;DataRoot=(Join-Path $fixture.Root 'data/routing');Preset='aih-muse';DryRun=$true;SettingsPath=$fixture.Settings}
        $scenarioParams[$scenario.Key]=$scenario.Value
        $threw=$false
        try{ Invoke-AihMuseRoutingDecision @scenarioParams | Out-Null }catch{ $threw=($_.Exception.Message -like 'Muse routing rejected:*') }
        Assert-Aih $threw $scenario.Name
    }
    $museEscalation=Invoke-AihMuseRoutingDecision -Description 'Harden this boundary.' -Workspace $fixture.Workspace -PolicyPath $fixture.Policy -DataRoot (Join-Path $fixture.Root 'data/routing') -Preset 'aih-muse' -Signal 'critical-security-boundary' -DryRun -SettingsPath $fixture.Settings
    Assert-Aih ($museEscalation.engine -eq 'muse' -and $museEscalation.executionClass -eq 'muse_main' -and $museEscalation.risk -eq 'critical' -and $null-eq$museEscalation.role) '10.2: Muse risk escalation remains on the Muse main-agent plane'

    # -- 11. Bounded retry: same failure NEVER escalates or changes the target
    $dataRoot=Join-Path $fixture.Root 'data/routing'
    $first=Invoke-AihMuseRoutingDecision -Description 'Bounded retry fixture engineering task.' -Workspace $fixture.Workspace -PolicyPath $fixture.Policy -DataRoot $dataRoot -TaskId 'TASK-4501' -Preset 'aih-muse' -SettingsPath $fixture.Settings
    Assert-Aih ($first.dryRun -eq $false) '11.1: a real muse decision persists controller state'
    $statesDir=Join-Path $dataRoot 'states'
    Assert-Aih (@(Get-ChildItem -LiteralPath $statesDir -Filter *.json).Count -ge 1) '11.2: the routing state file is written'
    $second=Invoke-AihMuseRoutingDecision -Description 'Bounded retry fixture engineering task.' -Workspace $fixture.Workspace -PolicyPath $fixture.Policy -DataRoot $dataRoot -TaskId 'TASK-4501' -Preset 'aih-muse' -Signal 'attempt-failure' -FailureReason 'tool boom 111' -SettingsPath $fixture.Settings
    $third=Invoke-AihMuseRoutingDecision -Description 'Bounded retry fixture engineering task.' -Workspace $fixture.Workspace -PolicyPath $fixture.Policy -DataRoot $dataRoot -TaskId 'TASK-4501' -Preset 'aih-muse' -Signal 'attempt-failure' -FailureReason 'tool boom 222' -SettingsPath $fixture.Settings
    Assert-Aih ($third.sameFailureCount -eq 2) '11.3: the same-failure count is tracked by the deterministic signature'
    Assert-Aih ($third.engine -eq 'muse' -and $third.executionClass -eq 'muse_main' -and $third.provider -eq 'meta-model-api' -and $third.model -eq 'muse-spark-1.3-contributor' -and $third.reasoning -eq 'xhigh') '11.4: after repeated failures the engine and target are UNCHANGED'
    Assert-Aih ($null-eq$third.escalatedFrom -and $null-eq$third.role) '11.5: no escalation and no Dual role ever appear on the muse plane'
    Assert-Aih ($third.reason -like '*retries the same single main agent*') '11.6: the bounded-retry reason is truthful'
    Assert-Aih (Test-Path -LiteralPath (Join-Path $dataRoot 'decisions.jsonl')) '11.7: the decisions ledger records the muse attempts'

    # -- 12. Identity guard parity with the Dual plane
    $tasksDir=Join-Path $fixture.Workspace '.ai-harness/state'
    New-Item -ItemType Directory -Force -Path $tasksDir|Out-Null
    $ledger=@{schemaVersion=1;tasks=@(@{taskId='TASK-4502';taskInstanceId='inst-current';boundEngine='muse';status='active'})}
    [IO.File]::WriteAllText((Join-Path $tasksDir 'tasks.json'),($ledger|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
    $threwIdentity=$false
    try{ Invoke-AihMuseRoutingDecision -Description 'x' -Workspace $fixture.Workspace -PolicyPath $fixture.Policy -DataRoot $dataRoot -TaskId 'TASK-4502' -TaskInstanceId 'inst-stale' -Preset 'aih-muse' -DryRun -SettingsPath $fixture.Settings | Out-Null }catch{ $threwIdentity=($_.Exception.Message -like '*taskInstanceId*') }
    Assert-Aih $threwIdentity '12.1: a stale taskInstanceId fails closed on the muse plane (one identity contract)'
    $bound=Invoke-AihMuseRoutingDecision -Description 'x' -Workspace $fixture.Workspace -PolicyPath $fixture.Policy -DataRoot $dataRoot -TaskId 'TASK-4502' -TaskInstanceId 'inst-current' -Preset 'aih-muse' -DryRun -SettingsPath $fixture.Settings
    Assert-Aih ($bound.engine -eq 'muse' -and $bound.taskInstanceId -eq 'inst-current') '12.2: the correct generation binds normally'

    $bindingWorkspace=Join-Path $fixture.Root 'binding-ws'
    $museTask=New-AihTask -Workspace $bindingWorkspace -Description 'new muse task' -Engine muse
    $dualTask=New-AihTask -Workspace $bindingWorkspace -Description 'new dual task' -Engine dual
    $persistedLedger=Read-AihTaskLedger $bindingWorkspace
    $persistedMuse=@($persistedLedger.tasks|Where-Object taskId -eq $museTask.taskId)[0]
    $persistedDual=@($persistedLedger.tasks|Where-Object taskId -eq $dualTask.taskId)[0]
    Assert-Aih ($museTask.boundEngine -eq 'muse' -and $persistedMuse.boundEngine -eq 'muse') '12.2a: a new Muse task persists boundEngine=muse'
    Assert-Aih ($dualTask.boundEngine -eq 'dual' -and $persistedDual.boundEngine -eq 'dual') '12.2b: a new Dual task persists boundEngine=dual'

    # -- 12b. Authoritative task engine mismatch fails before target resolution
    $ledger.tasks[0].boundEngine='muse'
    [IO.File]::WriteAllText((Join-Path $tasksDir 'tasks.json'),($ledger|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
    $museToDualViolation=$false
    try{ Invoke-AihRoutingDecision -Description 'ordinary' -Workspace $fixture.Workspace -PolicyPath $fixture.Policy -DataRoot $dataRoot -TaskId 'TASK-4502' -TaskInstanceId 'inst-current' -Preset 'aih-engineering' -RequestedEngine 'dual' -DryRun -SettingsPath $fixture.Settings | Out-Null }catch{ $museToDualViolation=($_.Exception.Message -like '*engine-binding-violation*') }
    Assert-Aih $museToDualViolation '12.3: bound=muse requested=dual fails closed with engine-binding-violation'
    $ledger.tasks[0].boundEngine='dual'
    [IO.File]::WriteAllText((Join-Path $tasksDir 'tasks.json'),($ledger|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
    $dualToMuseViolation=$false
    try{ Invoke-AihRoutingDecision -Description 'ordinary' -Workspace $fixture.Workspace -PolicyPath $fixture.Policy -DataRoot $dataRoot -TaskId 'TASK-4502' -TaskInstanceId 'inst-current' -Preset 'aih-muse' -RequestedEngine 'muse' -DryRun -SettingsPath $fixture.NoConsent | Out-Null }catch{ $dualToMuseViolation=($_.Exception.Message -like '*engine-binding-violation*') }
    Assert-Aih $dualToMuseViolation '12.4: bound=dual requested=muse fails before Muse target/consent resolution'

    # -- 13. The dispatch seam is the ONLY branch point (structural check)
    $routingText=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'scripts/Routing.ps1')
    $seamNeedle='if(' + [char]36 + 'resolved.Id-eq' + [char]39 + 'aih-muse' + [char]39 + ')'
    $seamCount=([regex]::Matches($routingText,[regex]::Escape($seamNeedle))).Count
    Assert-Aih ($seamCount -eq 1) '13.1: exactly ONE engine dispatch seam exists in Invoke-AihRoutingDecision'
    Assert-Aih ($routingText -match 'Invoke-AihMuseRoutingDecision @PSBoundParameters') '13.2: the seam delegates to the Muse branch with identical parameters'
    $controllerText=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'config/AihController.cjs')
    $presetAuthorityNeedle="selected === 'aih-engineering' || selected === 'aih-deepseek' || selected === 'aih-muse'"
    Assert-Aih ($controllerText.Contains($presetAuthorityNeedle)) '13.3: latest preset authority recognizes aih-engineering, aih-deepseek, and aih-muse'
    $staleMuseNeedle="if (selected === 'aih-deepseek' || selected === 'aih-muse') return selected"
    Assert-Aih (-not $controllerText.Contains($staleMuseNeedle)) '13.4: controller cannot skip a newer aih-engineering event to resurrect stale Muse state'

    # -- 14. Dual routing under a muse-absent catalog keeps legacy behavior
    $legacyFixture=New-AihMuseRoutingFixture
    Remove-Item -LiteralPath (Join-Path $legacyFixture.Root 'config/nexus-profiles.json') -Force
    $legacy=Invoke-AihRoutingDecision -Description 'Ordinary engineering work.' -Workspace $legacyFixture.Workspace -PolicyPath $legacyFixture.Policy -DataRoot (Join-Path $legacyFixture.Root 'data/routing') -Preset 'aih-engineering' -DryRun -SettingsPath $legacyFixture.Settings
    Assert-Aih ($legacy.engine -eq 'dual' -and $legacy.role -eq 'primaryEngineer') '14.1: a missing catalog keeps Dual behavior with explicit engine identity'
    Remove-Item -LiteralPath $legacyFixture.Root -Recurse -Force
}catch{
    Write-Host $_
    Write-Host ('SUITE RESULT: PASS '+$passed+' | FAIL 1 | total '+($passed+1))
    exit 1
}finally{
    if($null-ne$savedProfileEnv){$env:DSH_AIH_PROFILE=$savedProfileEnv}else{Remove-Item Env:DSH_AIH_PROFILE -ErrorAction SilentlyContinue}
    if($null-ne$savedActiveProfileEnv){$env:AIH_ACTIVE_PROFILE=$savedActiveProfileEnv}else{Remove-Item Env:AIH_ACTIVE_PROFILE -ErrorAction SilentlyContinue}
    if($null-ne$savedPresetEnv){$env:DSH_AIH_PRESET=$savedPresetEnv}else{Remove-Item Env:DSH_AIH_PRESET -ErrorAction SilentlyContinue}
    if($null-ne$savedActivePresetEnv){$env:AIH_ACTIVE_PRESET=$savedActivePresetEnv}else{Remove-Item Env:AIH_ACTIVE_PRESET -ErrorAction SilentlyContinue}
    if($null-ne$fixture-and(Test-Path -LiteralPath $fixture.Root)){Remove-Item -LiteralPath $fixture.Root -Recurse -Force}
}
Write-Host ('SUITE RESULT: PASS '+$passed+' | FAIL 0 | total '+$passed)
