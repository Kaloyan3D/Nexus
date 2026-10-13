[CmdletBinding()]
param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot))

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
try{[Console]::OutputEncoding=[Text.Encoding]::UTF8}catch{}

# TASK-0006 suite: OpenCode Go provider route for the Muse engine.
# Fully OFFLINE and deterministic: no network access and no real key are
# required. Transport behavior is exercised through the real probe transport
# (scripts/Invoke-MetaProbe.mjs via the pinned Node) with mock fixtures.

. (Join-Path $PSScriptRoot 'TestHelpers.ps1')
. (Join-Path (Join-Path $InstallRoot 'scripts') 'Common.ps1')
. (Join-Path (Join-Path $InstallRoot 'scripts') 'Routing.ps1')
. (Join-Path (Join-Path $InstallRoot 'scripts') 'NexusProfiles.ps1')
. (Join-Path (Join-Path $InstallRoot 'scripts') 'MuseProvider.ps1')
. (Join-Path (Join-Path $InstallRoot 'scripts') 'SettingsMigration.ps1')

$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not$Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}
function New-AihOpenCodeFixture{
    $fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('aih-muse-oc-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path (Join-Path $fixtureRoot 'data')|Out-Null
    foreach($name in @('routing-policy.json','engineering-profiles.json','model-registry.json','nexus-profiles.json','muse-profiles.json')){
        $target=Join-Path $fixtureRoot ('config/'+$name)
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target)|Out-Null
        Copy-Item (Join-Path $InstallRoot ('config/'+$name)) $target
    }
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
        '            xhigh: xhigh',
        '    opencode-go:',
        '      displayName: OpenCode Go (Muse Spark 1.3 Contributor over Responses)',
        '      apiKeyEnv: OPENCODE_API_KEY',
        '      api: openai-responses',
        '      baseURL: https://opencode.ai/zen/go/v1',
        '      reasoning: xhigh',
        '      compat:',
        '        supportsDeveloperRole: true',
        '        maxTokensField: max_completion_tokens',
        '      models:',
        '        - id: muse-spark-1.3-contributor',
        '          name: Muse Spark 1.3 Contributor (OpenCode Go)',
        '          contextWindow: 1048576',
        '          maxTokens: 131072',
        '          reasoningEfforts:',
        '            minimal: minimal',
        '            low: low',
        '            medium: medium',
        '            high: high',
        '            xhigh: xhigh'
    )
    $settingsWithMuseKey=@('engineering-profile: muse-spark-1.3-contributor') + $settings
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'data/settings.yaml'),(($settingsWithMuseKey -join [Environment]::NewLine)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
    return $fixtureRoot
}
Write-Host "===== SUITE MuseOpenCodeGo ===="
$fixture=$null
$savedKey=$env:OPENCODE_API_KEY
$savedMetaKey=$env:MODEL_API_KEY
$savedLiveGate=$env:NEXUS_META_LIVE_TEST
try{
    $fixture=New-AihOpenCodeFixture
    $layout=Get-AihLayout $fixture
    $registry=Get-AihModelRegistry $layout.ModelRegistry

    $ocEntry=$null
    foreach($candidate in @($registry.models)){if([string]$candidate.id -eq 'muse-spark-1.3-contributor-opencode'){$ocEntry=$candidate;break}}
    Assert-Aih ($null-ne$ocEntry) 'OC-1.1: muse-spark-1.3-contributor-opencode is registered'
    Assert-Aih ([string]$ocEntry.vendor -eq 'Meta') 'OC-1.2: vendor stays Meta (same model family, different transport)'
    Assert-Aih ([string]$ocEntry.provider -eq 'opencode-go') 'OC-1.3: default provider route is opencode-go'
    Assert-Aih ([string]$ocEntry.providers.default -eq 'opencode-go') 'OC-1.4: providers.default is opencode-go'
    Assert-Aih ([string]$ocEntry.model -eq 'muse-spark-1.3-contributor') 'OC-1.5: remote model is the Go-verified muse-spark-1.3-contributor'
    Assert-Aih ([bool]$ocEntry.enabled) 'OC-1.6: entry is enabled'
    Assert-Aih ([bool]$ocEntry.supportsTools -and [bool]$ocEntry.supportsStreaming) 'OC-1.7: tools+streaming declared for transport parity'
    Assert-Aih ((@($ocEntry.agentEngines)-contains'muse')-and(@($ocEntry.agentEngines).Count -eq 1)) 'OC-1.8: entry is EXCLUSIVELY muse-scoped'
    foreach($role in @('primaryEngineer','deepEngineer','reviewer','solver','fallback','visualReviewer')){
        Assert-Aih (-not(@(Get-AihCompatibleModelsForRole $registry $role)-contains'muse-spark-1.3-contributor-opencode')) ("OC-1.9 "+$role+": opencode entry never serves Dual roles")
    }

    $ocConfig=Resolve-AihMuseProviderConfig -SettingsPath $layout.Settings -ProviderId 'opencode-go'
    Assert-Aih ($null-ne$ocConfig) 'OC-2.1: opencode-go provider route resolves from settings.yaml'
    Assert-Aih ([string]$ocConfig.baseURL -eq 'https://opencode.ai/zen/go/v1') 'OC-2.2: base URL is the Go endpoint https://opencode.ai/zen/go/v1'
    Assert-Aih ([string]$ocConfig.apiKeyEnv -eq 'OPENCODE_API_KEY') 'OC-2.3: credential reference is OPENCODE_API_KEY (never a secret)'
    Assert-Aih ([string]$ocConfig.api -eq 'openai-responses') 'OC-2.4: wire protocol is openai-responses'
    Assert-Aih ([string]$ocConfig.models[0].id -eq 'muse-spark-1.3-contributor') 'OC-2.5: provider route serves muse-spark-1.3-contributor'
    $metaConfig=Resolve-AihMuseProviderConfig -SettingsPath $layout.Settings -ProviderId 'meta-model-api'
    Assert-Aih (($null-ne$metaConfig)-and([string]$metaConfig.baseURL -eq 'https://api.meta.ai/v1')) 'OC-2.6: Meta Direct route is untouched alongside OpenCode Go'

    $ocResolved=Resolve-AihNexusProfile -InstallRoot $fixture -ProfileId 'muse-spark-1.3-contributor-opencode'
    Assert-Aih (($null-ne$ocResolved)-and([string]$ocResolved.Engine -eq 'muse')) 'OC-3.1: OpenCode Nexus profile resolves with engine=muse'
    Assert-Aih ([bool]$ocResolved.Selectable -and [bool]$ocResolved.Runnable) 'OC-3.2: OpenCode profile is selectable+runnable'
    $ocBinding=Resolve-AihMuseProfileModel -MuseProfile $ocResolved.Config -Registry $registry
    Assert-Aih (($null-ne$ocBinding)-and([string]$ocBinding.Provider -eq 'opencode-go')) 'OC-3.3: binding chain reaches opencode-go only'
    Assert-Aih ([string]$ocBinding.Model -eq 'muse-spark-1.3-contributor') 'OC-3.4: binding chain resolves the Go Contributor model id'
    Assert-Aih ([string]$ocBinding.Reasoning -eq 'xhigh') 'OC-3.5: default reasoning is xhigh (same policy as Meta)'
    Assert-Aih ($null-eq(Resolve-AihMuseProfileModel -MuseProfile $ocResolved.Config -Registry $registry -Reasoning 'max')) 'OC-3.6: max fails closed on the OpenCode route (same as Meta)'
    Assert-Aih ($null-eq(Resolve-AihMuseProfileModel -MuseProfile $ocResolved.Config -Registry $registry -Reasoning 'off')) 'OC-3.7: off fails closed on the OpenCode route (same as Meta)'
    $metaResolved=Resolve-AihNexusProfile -InstallRoot $fixture -ProfileId 'muse-spark-1.3-contributor'
    $metaBinding=Resolve-AihMuseProfileModel -MuseProfile $metaResolved.Config -Registry $registry
    Assert-Aih ([string]$metaBinding.Provider -eq 'meta-model-api') 'OC-3.8: Meta profile still resolves to meta-model-api'

    $presetDoc=Resolve-AihPreset (Get-AihRoutingPolicy (Join-Path $fixture 'config/routing-policy.json')) 'aih-muse'
    Remove-Item Env:DSH_AIH_PROFILE -ErrorAction SilentlyContinue
    Remove-Item Env:AIH_ACTIVE_PROFILE -ErrorAction SilentlyContinue
    Assert-Aih ([bool]$presetDoc.Config.profileOverrideAllowed) 'OC-4.1: aih-muse allows manual Meta/OpenCode Go selection'
    Assert-Aih ([string]$presetDoc.Config.profile -eq 'muse-spark-1.3-contributor') 'OC-4.2: aih-muse default stays the Meta profile'
    $env:DSH_AIH_PROFILE='muse-spark-1.3-contributor-opencode'
    try{
        $ocTarget=Resolve-AihMuseRoutingTarget -InstallRoot $fixture -PresetId 'aih-muse' -SettingsPath $layout.Settings
        Assert-Aih (($null-ne$ocTarget)-and([string]$ocTarget.Provider -eq 'opencode-go')-and([string]$ocTarget.Model -eq 'muse-spark-1.3-contributor')-and([string]$ocTarget.ProfileId -eq 'muse-spark-1.3-contributor-opencode')) 'OC-4.3: routing target honors the manual OpenCode Go selection'
    }
    finally{ Remove-Item Env:DSH_AIH_PROFILE -ErrorAction SilentlyContinue }
    $metaTarget=Resolve-AihMuseRoutingTarget -InstallRoot $fixture -PresetId 'aih-muse' -SettingsPath $layout.Settings
    Assert-Aih ([string]$metaTarget.Provider -eq 'meta-model-api') 'OC-4.4: default routing target stays Meta Direct'

    $noRoute=Join-Path $fixture 'data/settings-no-oc.yaml'
    [IO.File]::WriteAllText($noRoute,((Get-Content -Raw $layout.Settings).Replace('opencode-go:','opencode-go-renamed:')),[Text.UTF8Encoding]::new($false))
    $env:DSH_AIH_PROFILE='muse-spark-1.3-contributor-opencode'
    try{
        $threwRoute=$false
        try{ Resolve-AihMuseRoutingTarget -InstallRoot $fixture -PresetId 'aih-muse' -SettingsPath $noRoute | Out-Null }catch{ $threwRoute=($_.Exception.Message -like '*provider route*') }
        Assert-Aih $threwRoute 'OC-5.1: missing opencode-go route fails closed (no Meta fallback)'
    }
    finally{ Remove-Item Env:DSH_AIH_PROFILE -ErrorAction SilentlyContinue }

    $env:OPENCODE_API_KEY='aih-muse-oc-suite-offline-value'
    try{
        $probe=Invoke-AihMuseProviderProbe -InstallRoot $fixture -ProviderId 'opencode-go' -Raw
        Assert-Aih ([string]$probe.provider -eq 'opencode-go') 'OC-6.1: probe resolves the opencode-go route'
        Assert-Aih ([string]$probe.baseURL -eq 'https://opencode.ai/zen/go/v1') 'OC-6.2: probe reports the Go base URL'
        Assert-Aih ([string]$probe.apiKeyEnv -eq 'OPENCODE_API_KEY') 'OC-6.3: probe reports the OPENCODE_API_KEY reference'
        Assert-Aih ([string]$probe.status -eq 'ready') 'OC-6.4: offline probe status is ready'
        Assert-Aih (-not([string]($probe|ConvertTo-Json -Depth 10)).Contains('aih-muse-oc-suite-offline-value')) 'OC-6.5: probe record never contains credential material'
        $checks=@{};foreach($check in @($probe.checks)){$checks[[string]$check.Name]=[bool]$check.Ok}
        foreach($required in @('probe-text','probe-usage','probe-stream','probe-tool','probe-error-401','probe-error-429','probe-error-500','secret-hygiene')){
            Assert-Aih ($checks.ContainsKey($required)-and$checks[$required]) ('OC-6.6 '+$required+': offline transport check passes on the OpenCode route')
        }
        $wire=Get-AihMuseReasoningWireValue -ProviderConfig $ocConfig -Level 'xhigh'
        Assert-Aih ([string]$wire -eq 'xhigh') 'OC-6.7: resolved xhigh effort maps on the OpenCode route'
    }
    finally{ if($null-eq$savedKey){Remove-Item Env:OPENCODE_API_KEY -ErrorAction SilentlyContinue}else{$env:OPENCODE_API_KEY=$savedKey} }

    $committedFiles=@((Join-Path $InstallRoot 'config/settings.yaml'),(Join-Path $InstallRoot 'config/model-registry.json'),(Join-Path $InstallRoot 'config/muse-profiles.json'),(Join-Path $InstallRoot 'config/nexus-profiles.json'),(Join-Path $InstallRoot '.env.example'))
    $secretLeaks=@()
    foreach($file in $committedFiles){
        if(-not(Test-Path -LiteralPath $file)){continue}
        $hits=Select-String -LiteralPath $file -Pattern '(sk-[A-Za-z0-9_-]{16,}|LLM\|[0-9]+\|)'
        if($null-ne$hits){$secretLeaks+=$file}
    }
    Assert-Aih (@($secretLeaks).Count -eq 0) 'OC-7.1: no committed config contains key material'
    Assert-Aih ((Get-Content -Raw (Join-Path $InstallRoot '.env.example')) -match '(?m)^OPENCODE_API_KEY=$') 'OC-7.2: .env.example carries the OPENCODE_API_KEY name reference with an empty value'

    $staleOcPath=Join-Path $fixture 'data/settings-stale-oc.yaml'
    $staleOcLines=@(
        'engineering-profile: muse-spark-1.3-contributor',
        'llm-pi-ai:',
        '  providers:',
        '    my-user-route:',
        '      displayName: Mine',
        '      apiKeyEnv: MY_KEY',
        '      api: openai-completions',
        '      baseURL: https://example.invalid/v1',
        '      models:',
        '        - id: my-model',
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
        '          input: [text, image]',
        '          contextWindow: 1048576',
        '          maxTokens: 131072',
        '          reasoningEfforts:',
        '            minimal: minimal',
        '            low: low',
        '            medium: medium',
        '            high: high',
        '            xhigh: xhigh',
        '    opencode-go:',
        '      displayName: OpenCode Go (Muse Spark 1.3 Contributor over Responses)',
        '      apiKeyEnv: OPENCODE_API_KEY',
        '      api: openai-responses',
        '      baseURL: https://opencode.ai/zen/go/v1',
        '      reasoning: xhigh',
        '      compat:',
        '        supportsDeveloperRole: true',
        '        maxTokensField: max_completion_tokens',
        '      models:',
        '        - id: muse-spark-1.3-contributor',
        '          name: Muse Spark 1.3 Contributor (OpenCode Go)',
        '          input: [text, image]',
        '          contextWindow: 1048576',
        '          maxTokens: 131072',
        '          reasoningEfforts:',
        '            minimal: minimal',
        '            low: low',
        '            medium: medium',
        '            high: high',
        '            xhigh: xhigh'
    )
    [IO.File]::WriteAllText($staleOcPath,(($staleOcLines -join [Environment]::NewLine)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
    $staleMig=Sync-AihManagedSettings -TemplatePath (Join-Path $InstallRoot 'config/settings.yaml') -SettingsPath $staleOcPath -ModelRegistryPath (Join-Path $InstallRoot 'config/model-registry.json')
    Assert-Aih ((@($staleMig.UpgradedRoutes) -contains 'opencode-go')) 'OC-8.1: stale opencode-go with maxTokensField upgrades instead of staying invalid'
    $staleAfter=Get-Content -Raw -Encoding UTF8 -LiteralPath $staleOcPath
    $ocBlock=[regex]::Match($staleAfter,'(?ms)^    opencode-go:.*?(?=^    \S|^\S|\z)').Value
    Assert-Aih (-not [regex]::IsMatch($ocBlock,'(?m)^\s+maxTokensField:')) 'OC-8.2: migrated opencode-go no longer carries the invalid maxTokensField key'
    Assert-Aih ($ocBlock.Contains('https://opencode.ai/zen/go/v1') -and $ocBlock.Contains('OPENCODE_API_KEY')) 'OC-8.3: migrated opencode-go keeps the Go endpoint and credential reference'
    Assert-Aih ($staleAfter.Contains('my-user-route:') -and $staleAfter.Contains('engineering-profile: muse-spark-1.3-contributor')) 'OC-8.4: user routes and settings preserved through the upgrade'
    $metaBlock=[regex]::Match($staleAfter,'(?ms)^    meta-model-api:.*?(?=^    \S|^\S|\z)').Value
    Assert-Aih ($metaBlock.Contains('maxTokensField: max_completion_tokens')) 'OC-8.5: Meta keeps its valid completions maxTokensField (untouched)'
}
finally{
    if($null-eq$savedKey){Remove-Item Env:OPENCODE_API_KEY -ErrorAction SilentlyContinue}else{$env:OPENCODE_API_KEY=$savedKey}
    if($null-eq$savedMetaKey){Remove-Item Env:MODEL_API_KEY -ErrorAction SilentlyContinue}else{$env:MODEL_API_KEY=$savedMetaKey}
    if($null-eq$savedLiveGate){Remove-Item Env:NEXUS_META_LIVE_TEST -ErrorAction SilentlyContinue}else{$env:NEXUS_META_LIVE_TEST=$savedLiveGate}
    Remove-Item Env:DSH_AIH_PROFILE -ErrorAction SilentlyContinue
    if($null-ne$fixture-and(Test-Path -LiteralPath $fixture)){Remove-Item -LiteralPath $fixture -Recurse -Force}
}
Write-Host "RESULT: $passed MuseOpenCodeGo assertions passed."
