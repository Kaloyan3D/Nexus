[CmdletBinding()]
param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot))

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
try{[Console]::OutputEncoding=[Text.Encoding]::UTF8}catch{}

# Phase M2 suite: Meta Model API provider transport for the Muse engine.
# Fully OFFLINE and deterministic: no network access and no real key are
# required. Transport behavior is exercised through the real probe transport
# (scripts/Invoke-MetaProbe.mjs via the pinned Node) with mock fixtures.

. (Join-Path $PSScriptRoot 'TestHelpers.ps1')
. (Join-Path (Join-Path $InstallRoot 'scripts') 'Common.ps1')
. (Join-Path (Join-Path $InstallRoot 'scripts') 'Routing.ps1')
. (Join-Path (Join-Path $InstallRoot 'scripts') 'NexusProfiles.ps1')
. (Join-Path (Join-Path $InstallRoot 'scripts') 'MuseProvider.ps1')

$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not$Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}

function Copy-AihConfigFile([string]$Name,[string]$FixtureRoot){
    $target=Join-Path $FixtureRoot ('config/'+$Name)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target)|Out-Null
    Copy-Item (Join-Path $InstallRoot ('config/'+$Name)) $target
}

function New-AihMuseFixture{
    $fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('aih-muse-suite-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path (Join-Path $fixtureRoot 'data')|Out-Null
    foreach($name in @('routing-policy.json','engineering-profiles.json','model-registry.json','nexus-profiles.json','muse-profiles.json')){
        Copy-AihConfigFile $name $fixtureRoot
    }
    # Minimal live settings with the Meta provider route. The baseURL is the
    # verified official value; offline probe checks never open a connection.
    $settings=@(
        'engineering-profile: glm-codex',
        'llm-pi-ai:',
        '  providers:',
        '    meta-model-api:',
        '      displayName: Meta Model API (Muse Spark 1.3 Contributor, direct)',
        '      apiKeyEnv: MODEL_API_KEY',
        '      api: openai-completions',
        '      baseURL: https://api.meta.ai/v1',
        '      reasoning: xhigh',
        '      compat:',
        '        thinkingFormat: openai',
        '        supportsReasoningEffort: true',
        '        supportsUsageInStreaming: true',
        '        supportsDeveloperRole: true',
        '        maxTokensField: max_completion_tokens',
        '      models:',
        '        - id: muse-spark-1.3-contributor',
        '          name: Muse Spark 1.3 Contributor',
        '          contextWindow: 1048576',
        '          maxTokens: 131072',
        '          reasoningEfforts:',
        '            minimal: minimal',
        '            low: low',
        '            medium: medium',
        '            high: high',
        '            xhigh: xhigh'
    )
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'data/settings.yaml'),(($settings -join [Environment]::NewLine)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
    return $fixtureRoot
}

Write-Host "===== SUITE MuseProvider ====="
$fixture=$null
$savedKey=$env:MODEL_API_KEY
$savedLiveGate=$env:NEXUS_META_LIVE_TEST
try{
    $fixture=New-AihMuseFixture
    $layout=Get-AihLayout $fixture
    $registry=Get-AihModelRegistry $layout.ModelRegistry

    # -- 1. Registry entry resolves to the Meta provider ----------------------
    $museEntry=$null
    foreach($candidate in @($registry.models)){if([string]$candidate.id -eq 'muse-spark-1.3-contributor'){$museEntry=$candidate;break}}
    Assert-Aih ($null-ne$museEntry) '1.1: muse-spark-1.3-contributor is registered'
    Assert-Aih ([string]$museEntry.vendor -eq 'Meta') '1.2: vendor is Meta'
    Assert-Aih ([string]$museEntry.provider -eq 'meta-model-api') '1.3: registry maps muse-spark-1.3-contributor to the meta-model-api provider route'
    Assert-Aih ([string]$museEntry.providers.default -eq 'meta-model-api') '1.4: providers.default resolves to meta-model-api'
    Assert-Aih ([string]$museEntry.model -eq 'muse-spark-1.3-contributor') '1.5: registry model id is muse-spark-1.3-contributor'
    Assert-Aih ([bool]$museEntry.enabled) '1.6: entry is enabled'
    Assert-Aih ([int]$museEntry.contextWindow -eq 1048576) '1.7: contextWindow is the verified 1,048,576-token window'
    Assert-Aih ([int]$museEntry.maxOutputTokens -eq 131072) '1.8: maxOutputTokens is the vendor-verified hard output ceiling (131072), never a Nexus safety/default cap'
    Assert-Aih ([bool]$museEntry.supportsTools) '1.9: supportsTools=true'
    Assert-Aih ([bool]$museEntry.supportsReasoning) '1.10: supportsReasoning=true'
    Assert-Aih ([bool]$museEntry.supportsStreaming) '1.11: supportsStreaming=true'
    Assert-Aih ([bool]$museEntry.supportsVision) '1.12: supportsVision=true (official vision recipe)'
    $museLevels=@($museEntry.supportedReasoningLevels)
    Assert-Aih (($museLevels-contains'minimal')-and($museLevels-contains'low')-and($museLevels-contains'medium')-and($museLevels-contains'high')-and($museLevels-contains'xhigh')) '1.13: every verified official Contributor reasoning level (minimal..xhigh) is supported'
    Assert-Aih ((-not($museLevels-contains'off'))-and(-not($museLevels-contains'max'))) '1.14: off and max are ABSENT (off returns HTTP 400 on Meta; max is Standard-tier only)'
    Assert-Aih ([string]$museEntry.dataUseTier -eq 'contributor') '1.15: dataUseTier=contributor (Contributor-tier data terms, contributorProtection required)'
    Assert-Aih ((@($museEntry.agentEngines)-contains'muse')-and(@($museEntry.agentEngines).Count -eq 1)) '1.16: the entry is EXPLICITLY and EXCLUSIVELY scoped to the muse engine'

    # -- 2. Engine scope keeps Muse out of every Dual role list ---------------
    foreach($role in @('primaryEngineer','deepEngineer','reviewer','solver','fallback','visualReviewer')){
        $compatible=@(Get-AihCompatibleModelsForRole $registry $role)
        Assert-Aih (-not(@($compatible)-contains'muse-spark-1.3-contributor')) ("2."+[string](@($compatible).Count)+"."+$role+": muse-spark-1.3-contributor is NOT role-compatible with $role despite supportsTools=true")
    }
    Assert-Aih (-not(Test-AihModelRoleCompatible $museEntry 'primaryEngineer' 'xhigh')) '2.10: Test-AihModelRoleCompatible fails closed for the muse entry'
    Assert-Aih (-not(Test-AihModelRoleCompatible $museEntry 'fallback' '')) '2.11: Test-AihModelRoleCompatible fails closed without a reasoning argument'

    # -- 3. Engine-scope metadata semantics are additive ---------------------
    $dualEntry=$null
    foreach($candidate in @($registry.models)){if([string]$candidate.id -eq 'glm-5.3'){$dualEntry=$candidate;break}}
    Assert-Aih ($null-ne$dualEntry) '3.1: pre-M2 registry entry present'
    Assert-Aih ($null-eq$dualEntry.PSObject.Properties['agentEngines']) '3.2: pre-M2 entries carry no agentEngines property'
    Assert-Aih (@(Get-AihCompatibleModelsForRole $registry 'primaryEngineer') -contains 'glm-5.3') '3.3: pre-M2 entry without agentEngines keeps Dual role eligibility (unchanged behavior)'
    $scopedRegistry=[pscustomobject]@{schemaVersion=1;models=@(
        [pscustomobject]@{id='explicit-dual';displayName='Explicit Dual';enabled=$true;supportsTools=$true;supportsReasoning=$true;supportedReasoningLevels=@('high');providers=[pscustomobject]@{default='p'};agentEngines=@('dual')},
        [pscustomobject]@{id='muse-only';displayName='Muse Only';enabled=$true;supportsTools=$true;supportsReasoning=$true;supportedReasoningLevels=@('xhigh');providers=[pscustomobject]@{default='p'};agentEngines=@('muse')},
        [pscustomobject]@{id='multi-engine';displayName='Multi';enabled=$true;supportsTools=$true;supportsReasoning=$true;supportedReasoningLevels=@('high');providers=[pscustomobject]@{default='p'};agentEngines=@('dual','muse')}
    )}
    $dualIds=@(Get-AihCompatibleModelsForRole $scopedRegistry 'primaryEngineer')
    Assert-Aih (@($dualIds)-contains'explicit-dual') '3.4: explicit agentEngines=[dual] stays Dual-eligible'
    Assert-Aih (-not(@($dualIds)-contains'muse-only')) '3.5: agentEngines=[muse] is excluded from Dual roles'
    Assert-Aih (@($dualIds)-contains'multi-engine') '3.6: agentEngines listing dual among others stays Dual-eligible'
    # M2.1: the engine-scope contract is ASYMMETRIC (Test-AihModelEngineCompatible).
    # The muse plane requires an EXPLICIT muse scope — absence fails closed —
    # while the dual plane tolerates absence for every pre-M2 entry.
    Assert-Aih (-not(Test-AihModelEngineCompatible $dualEntry 'muse')) '3.7: a pre-M2 entry WITHOUT agentEngines is NOT muse-eligible (Muse fails closed on absence)'
    Assert-Aih (Test-AihModelEngineCompatible $museEntry 'muse') '3.8: the explicitly muse-scoped contributor entry is muse-eligible'
    $unscopedEntry=[pscustomobject]@{id='unscoped';displayName='U';enabled=$true}
    Assert-Aih (-not(Test-AihModelEngineCompatible $unscopedEntry 'muse')) '3.9: an unscoped registry entry fails closed for the muse engine'
    Assert-Aih (Test-AihModelEngineCompatible $unscopedEntry 'dual') '3.10: an unscoped registry entry stays dual-eligible (backward compatible)'
    Assert-Aih (-not(Test-AihModelEngineCompatible $museEntry 'dual')) '3.11: the muse-scoped entry is never dual-eligible'
    Assert-Aih (-not(Test-AihModelEngineCompatible $dualEntry 'quantum')) '3.12: an unknown engine name fails closed'

    # -- 4. Provider configuration resolution --------------------------------
    $providerConfig=Resolve-AihMuseProviderConfig -SettingsPath $layout.Settings
    Assert-Aih ($null-ne$providerConfig) '4.1: meta-model-api provider route resolves from settings.yaml'
    Assert-Aih ([string]$providerConfig.baseURL -eq 'https://api.meta.ai/v1') '4.2: base URL is the official https://api.meta.ai/v1'
    Assert-Aih ([string]$providerConfig.apiKeyEnv -eq 'MODEL_API_KEY') '4.3: credential reference is the official MODEL_API_KEY variable'
    Assert-Aih ([string]$providerConfig.api -eq 'openai-completions') '4.4: wire protocol is the generic OpenAI-compatible completions API (no custom HTTP stack)'
    Assert-Aih ([string]$providerConfig.models[0].id -eq 'muse-spark-1.3-contributor') '4.5: provider route serves muse-spark-1.3-contributor'
    Assert-Aih ([int64]$providerConfig.models[0].contextWindow -eq 1048576) '4.6: provider route model context matches the registry'
    Assert-Aih ([int64]$providerConfig.models[0].maxTokens -eq 131072) '4.6b: provider route maxTokens is the verified 131072 output ceiling'
    $unresolved=Resolve-AihMuseProviderConfig -SettingsPath $layout.Settings -ProviderId 'no-such-provider'
    Assert-Aih ($null-eq$unresolved) '4.7: unknown provider route fails closed (returns null)'

    # -- 5. Credentials: reference only, nothing committed -------------------
    $committedFiles=@(
        (Join-Path $InstallRoot 'config/settings.yaml'),
        (Join-Path $InstallRoot 'config/model-registry.json'),
        (Join-Path $InstallRoot 'config/muse-profiles.json'),
        (Join-Path $InstallRoot 'config/nexus-profiles.json'),
        (Join-Path $InstallRoot '.env.example')
    )
    $secretLeaks=@()
    foreach($file in $committedFiles){
        if(-not(Test-Path -LiteralPath $file)){continue}
        $hits=Select-String -LiteralPath $file -Pattern '(sk-[A-Za-z0-9_-]{16,}|LLM\|[0-9]+\|)'
        if($null-ne$hits){$secretLeaks+=$file}
    }
    Assert-Aih (@($secretLeaks).Count -eq 0) '5.1: no committed config contains key material'
    $envExample=Get-Content -Raw (Join-Path $InstallRoot '.env.example')
    Assert-Aih ($envExample -match '(?m)^MODEL_API_KEY=s*$') '5.2: .env.example carries the MODEL_API_KEY name reference with an empty value'
    $museDoc=Get-Content -Raw -Encoding UTF8 (Join-Path $InstallRoot 'config/muse-profiles.json')|ConvertFrom-Json
    $museText=$museDoc|ConvertTo-Json -Depth 10
    Assert-Aih (-not$museText.Contains('apiKeyEnv')-and-not$museText.Contains('baseURL')) '5.3: muse-profiles.json carries no provider truth (no apiKeyEnv, no baseURL — provider config stays in settings.yaml)'
    $missingKey=Get-AihProviderApiKey -ApiKeyEnv 'MODEL_API_KEY' -InstallRoot $fixture
    Assert-Aih ($null-eq$missingKey) '5.4: missing credential resolves to null (Muse provider unavailable, not an error)'
    $env:MODEL_API_KEY='aih-muse-suite-reference-value'
    try{
        $envKey=Get-AihProviderApiKey -ApiKeyEnv 'MODEL_API_KEY' -InstallRoot $fixture
        Assert-Aih ([string]$envKey -eq 'aih-muse-suite-reference-value') '5.5: environment credential is preferred by the generic accessor'
    }
    finally{ if($null-eq$savedKey){Remove-Item Env:MODEL_API_KEY -ErrorAction SilentlyContinue}else{$env:MODEL_API_KEY=$savedKey} }

    # -- 6. Reasoning contract: mapping validated, fail closed ---------------
    # M2.1 verified official Meta contract: minimal/low/medium/high/xhigh map
    # 1:1 to the official reasoning_effort spelling; 'off' is not representable
    # (none returns HTTP 400, omission still reasons) and 'max' is Standard-
    # tier only — the Contributor route refuses both instead of silently
    # sending a lower effort or omitting the parameter (no omission-as-off).
    foreach($pair in @(@('minimal','minimal'),@('low','low'),@('medium','medium'),@('high','high'),@('xhigh','xhigh'))){
        $wire=Get-AihMuseReasoningWireValue -ProviderConfig $providerConfig -Level $pair[0]
        Assert-Aih ($null-ne$wire-and[string]$wire-eq[string]$pair[1]) ('6.'+@('minimal','low','medium','high','xhigh').IndexOf($pair[0])+': Nexus '+$pair[0]+' maps 1:1 to the official reasoning_effort spelling')
    }
    foreach($refusedLevel in @('off','max','ultra')){
        Assert-Aih ($null-eq(Get-AihMuseReasoningWireValue -ProviderConfig $providerConfig -Level $refusedLevel)) ('6.5 '+$refusedLevel+': a level the Contributor route does not offer fails closed (null, never a silent lower effort)')
    }

    # -- 7. Full offline probe battery ---------------------------------------
    $env:MODEL_API_KEY='aih-muse-suite-offline-probe-value'
    try{
        $probe=Invoke-AihMuseProviderProbe -InstallRoot $fixture -Raw
        Assert-Aih ([string]$probe.provider -eq 'meta-model-api') '7.1: probe resolves the meta-model-api route'
        Assert-Aih ([string]$probe.baseURL -eq 'https://api.meta.ai/v1') '7.2: probe reports the official base URL'
        Assert-Aih ([string]$probe.status -eq 'ready') '7.3: offline probe status is ready'
        Assert-Aih (-not([string]($probe|ConvertTo-Json -Depth 10)).Contains('aih-muse-suite-offline-probe-value')) '7.4: the probe record never contains the credential value'
        $probeChecks=@{}
        foreach($check in @($probe.checks)){$probeChecks[[string]$check.Name]=[bool]$check.Ok}
        foreach($required in @('probe-text','probe-usage','probe-stream','probe-stream-malformed','probe-stream-interrupted','probe-tool','reasoning-mapping-minimal','reasoning-mapping-low','reasoning-mapping-medium','reasoning-mapping-high','reasoning-mapping-xhigh','probe-reasoning-minimal','probe-reasoning-low','probe-reasoning-medium','probe-reasoning-high','probe-reasoning-xhigh','reasoning-mapping-fail-closed-off','reasoning-mapping-fail-closed-max','reasoning-mapping-fail-closed-ultra','probe-error-401','probe-error-429','probe-error-500','secret-hygiene')){
            Assert-Aih ($probeChecks.ContainsKey($required)-and$probeChecks[$required]) ('7.5 '+$required+': probe check passes')
        }
    }
    finally{ if($null-eq$savedKey){Remove-Item Env:MODEL_API_KEY -ErrorAction SilentlyContinue}else{$env:MODEL_API_KEY=$savedKey} }

    # -- 8. Missing credential behavior: provider unavailable, install valid --
    $probeNoKey=Invoke-AihMuseProviderProbe -InstallRoot $fixture -Raw
    Assert-Aih (-not[bool]$probeNoKey.credentialsDetected) '8.1: without a Meta key the probe reports credentialsDetected=false'
    Assert-Aih ([string]$probeNoKey.status -eq 'ready') '8.2: the offline transport battery still validates without a key'
    $noKeyLiveRan=$null-ne$probeNoKey.live-and[bool]$probeNoKey.live.ran
    Assert-Aih (-not$noKeyLiveRan) '8.3: live smoke did not run'

    # -- 9. Live gate: opt-in only --------------------------------------------
    Remove-Item Env:MODEL_API_KEY -ErrorAction SilentlyContinue
    $env:NEXUS_META_LIVE_TEST='1'
    try{
        $probeGated=Invoke-AihMuseProviderProbe -InstallRoot $fixture -Live -Raw
        Assert-Aih ([string]$probeGated.mode -eq 'live') '9.1: -Live requests the live battery'
        Assert-Aih ([bool]$probeGated.live.gateOpen) '9.2: NEXUS_META_LIVE_TEST=1 opens the gate'
        Assert-Aih (-not[bool]$probeGated.live.ran) '9.3: live battery still refuses to run without a credential'
        Assert-Aih ($null-ne$probeGated.live.reason) '9.4: a reason is recorded for the skipped live battery'
    }
    finally{ Remove-Item Env:NEXUS_META_LIVE_TEST -ErrorAction SilentlyContinue }

    # -- 10. Muse profile stays contributor-gated (M3 activation gate) --------
    $resolved=Resolve-AihNexusProfile -InstallRoot $fixture -ProfileId 'muse-spark-1.3-contributor'
    Assert-Aih ($null-ne$resolved) '10.1: muse-spark-1.3-contributor resolves from the production catalog'
    Assert-Aih ([bool]$resolved.Selectable -eq $false) '10.2: production Muse profile remains selectable=false'
    Assert-Aih ([bool]$resolved.Runnable -eq $false) '10.3: production Muse profile remains runnable=false'
    Assert-Aih ([string]$resolved.Availability -eq 'contributor-gated') '10.4: production Muse availability remains contributor-gated'
    Assert-Aih ([string]$resolved.Engine -eq 'muse') '10.5: engine remains muse'

    # -- 11. Muse profile -> model registry -> provider chain ------------------
    Assert-Aih ([string]$resolved.Config.model.primary -eq 'muse-spark-1.3-contributor') '11.1: Muse profile references the model REGISTRY id, not a provider id'
    $modelBinding=Resolve-AihMuseProfileModel -MuseProfile $resolved.Config -Registry $registry
    Assert-Aih ($null-ne$modelBinding) '11.2: the muse model binding resolves'
    Assert-Aih ([string]$modelBinding.Provider -eq 'meta-model-api') '11.3: binding chain reaches the meta-model-api provider route'
    Assert-Aih ([string]$modelBinding.Model -eq 'muse-spark-1.3-contributor') '11.4: binding chain resolves the Meta contributor model id'
    Assert-Aih ([string]$modelBinding.Reasoning -eq 'xhigh') '11.5: default reasoning comes from the Muse profile (xhigh, the Contributor ceiling)'
    Assert-Aih ([string]$modelBinding.DataUseTier -eq 'contributor') '11.6: dataUseTier=contributor travels on the binding for the later security phase'
    # M2.1: requested reasoning levels outside the verified Contributor set
    # fail closed (max is Standard-tier only; off is not representable on the
    # direct Meta contract); the valid escalation level still resolves.
    $maxBinding=Resolve-AihMuseProfileModel -MuseProfile $resolved.Config -Registry $registry -Reasoning 'max'
    Assert-Aih ($null-eq$maxBinding) '11.7: reasoning max (Standard-tier only) fails closed on the contributor route'
    $offBinding=Resolve-AihMuseProfileModel -MuseProfile $resolved.Config -Registry $registry -Reasoning 'off'
    Assert-Aih ($null-eq$offBinding) '11.8: reasoning off (HTTP 400 on Meta, omission still reasons) fails closed on the contributor route'
    $xhighBinding=Resolve-AihMuseProfileModel -MuseProfile $resolved.Config -Registry $registry -Reasoning 'xhigh'
    Assert-Aih ($null-ne$xhighBinding-and[string]$xhighBinding.Provider -eq 'meta-model-api') '11.9: explicit xhigh escalation resolves through the same route'
    # M2.1: a registry entry WITHOUT agentEngines fails closed on the muse
    # plane — an unscoped (Dual-legacy) entry can never serve the Muse transport.
    $unscopedRegistry=[pscustomobject]@{schemaVersion=1;models=@([pscustomobject]@{id='unscoped-model';displayName='U';enabled=$true;supportedReasoningLevels=@('xhigh');provider='meta-model-api'})}
    $unscopedMuse=[pscustomobject]@{id='unscoped';displayName='U';model=[pscustomobject]@{primary='unscoped-model'};reasoning=[pscustomobject]@{default='xhigh'}}
    Assert-Aih ($null-eq(Resolve-AihMuseProfileModel -MuseProfile $unscopedMuse -Registry $unscopedRegistry)) '11.10: a registry entry WITHOUT agentEngines fails closed on the muse plane'

    # -- 12. Malformed model binding fails closed ------------------------------
    $brokenMusePath=Join-Path $fixture 'config/muse-profiles.json'
    $brokenDoc=Get-Content -Raw -Encoding UTF8 $brokenMusePath|ConvertFrom-Json
    $brokenDoc.profiles[0].model.primary=''
    [IO.File]::WriteAllText($brokenMusePath,($brokenDoc|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    $threwBroken=$false
    try{ Get-AihMuseProfiles $brokenMusePath | Out-Null }catch{ $threwBroken=$true }
    Assert-Aih $threwBroken '12.1: an empty model.primary fails closed at load time'

    # -- 13. CLI surface: probe exit codes ------------------------------------
    # The child host is resolved by the platform-aware PowerShell host resolver
    # (never a hardcoded Windows-only executable).
    $powerShellHost=Get-AihPowerShellHost -InstallRoot $InstallRoot
    $cliOutput=@(& $powerShellHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ". '$InstallRoot/scripts/MuseProvider.ps1'; exit 0" 2>&1)
    Assert-Aih ($LASTEXITCODE -eq 0) '13.1: dot-sourcing the provider plane is side-effect free'
    $cliOutput=@(& $powerShellHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts/MuseProvider.ps1') -Action resolve -InstallRoot $fixture 2>&1)
    Assert-Aih ($LASTEXITCODE -eq 0-and(($cliOutput|ForEach-Object{[string]$_}) -join ' ') -match 'resolved meta-model-api') '13.2: resolve action resolves the provider route'
    $cliOutput=@(& $powerShellHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts/MuseProvider.ps1') -Action probe -InstallRoot $fixture 2>&1)
    Assert-Aih ($LASTEXITCODE -eq 0) '13.3: offline probe action exits 0 when every check passes'
    Assert-Aih ((($cliOutput|ForEach-Object{[string]$_}) -join ' ') -match 'PROBE ready') '13.4: probe action reports ready'
}
finally{
    if($null-eq$savedKey){Remove-Item Env:MODEL_API_KEY -ErrorAction SilentlyContinue}else{$env:MODEL_API_KEY=$savedKey}
    if($null-eq$savedLiveGate){Remove-Item Env:NEXUS_META_LIVE_TEST -ErrorAction SilentlyContinue}else{$env:NEXUS_META_LIVE_TEST=$savedLiveGate}
    if($null-ne$fixture-and(Test-Path -LiteralPath $fixture)){Remove-Item -LiteralPath $fixture -Recurse -Force}
}
Write-Host "RESULT: $passed MuseProvider assertions passed."
