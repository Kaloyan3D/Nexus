Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Phase M2: Meta Model API provider plane for the Muse agent engine.
#
# ARCHITECTURAL BOUNDARY (docs/architecture/nexus-profiles.md):
#   Nexus Profile (engine: muse)
#     -> Muse Profile (config/muse-profiles.json, model.primary)
#       -> Model Registry (config/model-registry.json, provider id)
#         -> DSH provider configuration (settings.yaml llm-pi-ai.providers)
#           -> Meta Model API (OpenAI-compatible transport)
#
# This module is TRANSPORT/CONFIGURATION only. It resolves the configured
# provider route, maps Nexus reasoning levels to the provider-native wire
# values at the provider boundary, and runs the bounded capability probe.
# It NEVER dispatches engineering execution, NEVER implements the Muse agent
# loop, and NEVER routes Dual-plane traffic. Provider-specific code exists
# here only where the Meta contract is genuinely provider-specific (the
# reasoning wire mapping); the transport itself is generic OpenAI-compatible.

. (Join-Path $PSScriptRoot 'Common.ps1')

# The default provider route id for the Meta Model API. The route key is a
# settings.yaml llm-pi-ai.providers configuration identifier — never a URL
# and never a credential.
$script:MuseDefaultProviderId = 'meta-model-api'

function Resolve-AihMuseProviderConfig {
    # Deterministic provider-config resolution from the live settings.yaml
    # llm-pi-ai.providers block for ONE provider route. Fails closed (returns
    # $null) when the route is not configured. The parser is indentation
    # aware for exactly the shape the managed settings template emits:
    #   llm-pi-ai:            (col 0)
    #     providers:          (col 2)
    #       <route>:          (col 4)
    #         key: value      (col 6)
    #         models:         (col 6)
    #           - id: m       (col 8)
    #             key: value  (col 10)
    #             reasoningEfforts:      (col 10)
    #               <level>: <native>    (col 12; empty native = send nothing)
    param(
        [Parameter(Mandatory=$true)][string]$SettingsPath,
        [string]$ProviderId = 'meta-model-api'
    )
    if([string]::IsNullOrWhiteSpace($ProviderId)){return $null}
    if(-not(Test-Path -LiteralPath $SettingsPath -PathType Leaf)){return $null}
    $lines=Get-Content -LiteralPath $SettingsPath
    $inProviders=$false
    $current=$null
    $inModels=$false
    $currentModel=$null
    $inEfforts=$false
    foreach($line in $lines){
        if($line -match '^\s{2}providers:\s*$'){$inProviders=$true;$current=$null;$currentModel=$null;$inModels=$false;$inEfforts=$false;continue}
        if(-not$inProviders){continue}
        if($line -match '^\S'){break}
        # col 4: a provider route key ends any current model/effort context.
        if($line -match '^\s{4}([\w.-]+):\s*$'){
            if($null-ne$current-and([string]$current.id)-eq$ProviderId){break}
            $current=[pscustomobject][ordered]@{
                id=$Matches[1];displayName=$null;apiKeyEnv=$null;api=$null;baseURL=$null;reasoning=$null
                models=@()
            }
            $currentModel=$null;$inModels=$false;$inEfforts=$false
            continue
        }
        if($null-eq$current){continue}
        # col 6: provider-level fields, or the models list header.
        if($line -match '^\s{6}models:\s*$'){$inModels=$true;$inEfforts=$false;$currentModel=$null;continue}
        if(-not$inModels){
            if($line -match '^\s{6}displayName:\s*(.+?)\s*$'){$current.displayName=$Matches[1].Trim().Trim('''','"');continue}
            if($line -match '^\s{6}apiKeyEnv:\s*(.+?)\s*$'){$current.apiKeyEnv=$Matches[1].Trim().Trim('''','"');continue}
            if($line -match '^\s{6}api:\s*(.+?)\s*$'){$current.api=$Matches[1].Trim().Trim('''','"');continue}
            if($line -match '^\s{6}baseURL:\s*(.+?)\s*$'){$current.baseURL=$Matches[1].Trim().Trim('''','"');continue}
            if($line -match '^\s{6}reasoning:\s*(.+?)\s*$'){$current.reasoning=$Matches[1].Trim().Trim('''','"');continue}
            continue
        }
        # col 8: a model list entry starts a new model context.
        if($line -match '^\s{8}-\s*id:\s*(.+?)\s*$'){
            $currentModel=[pscustomobject][ordered]@{
                id=$Matches[1].Trim().Trim('''','"');name=$null;contextWindow=$null;maxTokens=$null
                reasoningEfforts=@{}
            }
            $current.models+=@($currentModel)
            $inEfforts=$false
            continue
        }
        if($null-eq$currentModel){continue}
        # col 10: model-level fields, or the reasoningEfforts map header.
        if($line -match '^\s{10}reasoningEfforts:\s*$'){$inEfforts=$true;continue}
        if(-not$inEfforts){
            if($line -match '^\s{10}name:\s*(.+?)\s*$'){$currentModel.name=$Matches[1].Trim().Trim('''','"');continue}
            if($line -match '^\s{10}contextWindow:\s*(.+?)\s*$'){$currentModel.contextWindow=[int64]$Matches[1].Trim();continue}
            if($line -match '^\s{10}maxTokens:\s*(.+?)\s*$'){$currentModel.maxTokens=[int64]$Matches[1].Trim();continue}
            continue
        }
        # col 12: reasoningEfforts entries. An EMPTY native value is meaningful
        # ("supported, send nothing" — the parameter's absence); every other
        # declared level names the wire spelling.
        if($line -match '^\s{12}([\w.-]+):\s*(.*)$'){
            $level=$Matches[1].Trim()
            $native=$Matches[2].Trim().Trim('''','"')
            $currentModel.reasoningEfforts[$level]=$native
            continue
        }
    }
    if($null-eq$current-or([string]$current.id)-ne$ProviderId){return $null}
    if([string]::IsNullOrWhiteSpace($current.apiKeyEnv)-or[string]::IsNullOrWhiteSpace($current.baseURL)){return $null}
    return $current
}

function Get-AihMuseReasoningWireValue {
    # The provider-boundary reasoning mapping: Nexus semantic level ->
    # Meta-native reasoning_effort wire value, read from the provider route's
    # configured reasoningEfforts (the settings.yaml mapping IS the mapping of
    # record). Deterministic and fail closed:
    #   - a level the route does not declare returns $null — the caller MUST
    #     refuse the request rather than silently send a lower effort;
    #   - a declared EMPTY value returns '' — send nothing (generic transport
    #     capability; the managed Muse route declares no such level, see the
    #     verified contract below);
    #   - otherwise the configured native wire value.
    # Official Meta Model API contract (RE-VERIFIED Phase M2.1 against the
    # official dev.meta.ai documentation, /docs/reasoning): the supported
    # levels are minimal < low < medium < high < xhigh, plus max on
    # Standard-tier muse-spark-1.3 ONLY ("Extended reasoning beyond xhigh.
    # Standard-tier muse-spark-1.3 only; not available on Contributor-tier
    # models."). There is NO explicit no-reasoning value: "none" — Disables
    # reasoning. Not supported by Muse Spark: returns HTTP 400 — and omission
    # is not off either ("When you omit the parameter, the model still reasons
    # at a model-determined level."). The managed Contributor route therefore
    # declares only minimal..xhigh; requesting Nexus "off" or "max" for Muse
    # fails closed here ($null), and the empty-value transport capability is
    # reserved for other providers that officially support omission-as-off.
    param(
        [Parameter(Mandatory=$true)][object]$ProviderConfig,
        [Parameter(Mandatory=$true)][string]$Level
    )
    if($null-eq$ProviderConfig-or$null-eq$ProviderConfig.models-or@($ProviderConfig.models).Count-eq0){return $null}
    $model=@($ProviderConfig.models)[0]
    if($null-eq$model-or$null-eq$model.reasoningEfforts){return $null}
    $efforts=$model.reasoningEfforts
    if(-not$efforts.ContainsKey($Level)){return $null}
    return [string]$efforts[$Level]
}

function Get-AihMuseNodeExecutable {
    # The pinned Nexus Node distribution is preferred; PATH is the fallback.
    param([object]$Layout,[string]$InstallRoot)
    $toolchainNode=Get-AihNodeExecutable -InstallRoot $InstallRoot
    if(-not[string]::IsNullOrWhiteSpace([string]$toolchainNode)){return $toolchainNode}
    if($null-ne$Layout-and(Test-Path -LiteralPath $Layout.Node -PathType Leaf)){return $Layout.Node}
    $nodeName=if(Test-AihIsWindows){'node.exe'}else{'node'}
    $command=Get-Command $nodeName -ErrorAction SilentlyContinue
    if($null-ne$command){return $command.Source}
    return $null
}

function New-AihMuseProbeWorkspace {
    param([string]$Name)
    $path=Join-Path ([IO.Path]::GetTempPath()) ('aih-muse-probe-'+$Name+'-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    return $path
}

function Invoke-AihMuseProbeRequest {
    # One probe round trip through the REAL configured provider path: the
    # caller resolves baseUrl/apiKeyEnv/model from configuration; this helper
    # writes the request (never the key), invokes the transport script with
    # the pinned Node, and returns the parsed outcome. The key reaches the
    # child ONLY through the environment and is never written to any file.
    param(
        [Parameter(Mandatory=$true)][string]$NodeExecutable,
        [Parameter(Mandatory=$true)][object]$Request,
        [Parameter(Mandatory=$true)][string]$WorkspacePath,
        [string]$Label
    )
    $requestPath=Join-Path $WorkspacePath ('request-'+$Label+'.json')
    Write-AihAtomicJson -Path $requestPath -Value $Request
    $mjsPath=Join-Path $PSScriptRoot 'Invoke-MetaProbe.mjs'
    $previousConsoleEncoding=[Console]::OutputEncoding
    try{ [Console]::OutputEncoding=[Text.Encoding]::UTF8 }catch { }
    try{
        $stdout=@(& $NodeExecutable $mjsPath --request $requestPath 2>&1|ForEach-Object{[string]$_})
    }finally{
        try{ [Console]::OutputEncoding=$previousConsoleEncoding }catch { }
    }
    $exitCode=[int]$LASTEXITCODE
    $jsonLine=$stdout | Where-Object { $_ -match '^\{' } | Select-Object -First 1
    if([string]::IsNullOrWhiteSpace([string]$jsonLine)){throw "Muse probe transport produced no JSON outcome ($Label, exit $exitCode): $($stdout -join ' | ')"}
    $outcome=$jsonLine|ConvertFrom-Json
    [pscustomobject][ordered]@{Label=$Label;ExitCode=$exitCode;Outcome=$outcome}
}

function New-AihMuseMockDocument {
    param([int]$Status,[object]$Body,[switch]$EchoRequest)
    [ordered]@{status=$Status;body=$Body;echoRequest=[bool]$EchoRequest}
}

function New-AihMuseChatBody {
    # A minimal OpenAI-shaped chat-completions body for mock fixtures.
    param([string]$Content,[string]$FinishReason='stop',[object]$Usage,[object[]]$ToolCalls)
    $message=[ordered]@{role='assistant'}
    if($null-ne$Content){$message.content=$Content}
    if($null-ne$ToolCalls-and$ToolCalls.Count-gt0){$message.tool_calls=$ToolCalls}
    $choice=[ordered]@{index=0;message=[pscustomobject]$message;finish_reason=$FinishReason}
    $body=[ordered]@{id='chatcmpl-muse-probe';object='chat.completion';model='muse-spark-1.3-contributor';choices=@([pscustomobject]$choice)}
    if($null-ne$Usage){$body.usage=$Usage}
    [pscustomobject]$body
}

function Invoke-AihMuseOfflineChecks {
    # Deterministic offline transport-contract checks. Every check drives the
    # REAL probe transport (Invoke-MetaProbe.mjs through the pinned Node) with
    # mock fixtures — no network, no real key. Returns the check records.
    param(
        [Parameter(Mandatory=$true)][object]$Config,
        [Parameter(Mandatory=$true)][string]$ModelId,
        [Parameter(Mandatory=$true)][string]$NodePath,
        [Parameter(Mandatory=$true)][string]$WorkspacePath
    )

    $checks=@()
    $testKey='aih-muse-probe-not-a-real-secret-0123456789'
    $previousKey=[Environment]::GetEnvironmentVariable($Config.apiKeyEnv)
    $keyOwnedByService=$false
    if([string]::IsNullOrWhiteSpace([string]$previousKey)){
        [Environment]::SetEnvironmentVariable($Config.apiKeyEnv,$testKey)
        $keyOwnedByService=$true
    }
    try{
        $baseRequest=[ordered]@{
            baseUrl=$Config.baseURL
            apiKeyEnv=$Config.apiKeyEnv
            model=$ModelId
            timeoutMs=15000
        }
        $usage=[ordered]@{prompt_tokens=12;completion_tokens=9;total_tokens=21;completion_tokens_details=[ordered]@{reasoning_tokens=4}}

        # 1. simple text request + observable usage
        $mockPath=Join-Path $WorkspacePath 'mock-text.json'
        Write-AihAtomicJson -Path $mockPath -Value (New-AihMuseMockDocument -Status 200 -Body (New-AihMuseChatBody -Content 'NEXUS' -Usage ([pscustomobject]$usage)))
        $textRequest=[ordered]@{};$baseRequest.GetEnumerator()|ForEach-Object{$textRequest[$_.Key]=$_.Value}
        $textRequest.prompt='Reply with exactly the word NEXUS.'
        $textRequest.mockFile=$mockPath
        $textResult=Invoke-AihMuseProbeRequest -NodeExecutable $NodePath -Request ([pscustomobject]$textRequest) -WorkspacePath $WorkspacePath -Label 'text'
        $textOutcome=$textResult.Outcome
        $checks+=[pscustomobject][ordered]@{Name='probe-text';Ok=([bool]$textOutcome.ok-and[string]$textOutcome.content-eq'NEXUS');Detail=if([bool]$textOutcome.ok){'text round trip returned assistant content'}else{'text probe failed: '+[string]$textOutcome.errorKind}}
        $usageOk=$null-ne$textOutcome.usage-and[bool]($textOutcome.usage.PSObject.Properties['promptTokens'])-and[int]$textOutcome.usage.promptTokens-eq12-and[int]$textOutcome.usage.reasoningTokens-eq4
        $checks+=[pscustomobject][ordered]@{Name='probe-usage';Ok=$usageOk;Detail=if($usageOk){'usage observed (prompt/completion/reasoning tokens)'}else{'no usable usage object on the outcome'}}

        # 2. streaming: content deltas + termination + final usage chunk
        $mockStreamPath=Join-Path $WorkspacePath 'mock-stream.sse.json'
        $sseBlocks=@(
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"NEX"}}]}',
            'data: {"choices":[{"index":0,"delta":{"content":"US"}}]}',
            ': keep-alive comment',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":9,"total_tokens":21,"completion_tokens_details":{"reasoning_tokens":4}}}',
            'data: [DONE]'
        )
        Write-AihAtomicText -Path $mockStreamPath -Content (ConvertTo-Json -InputObject $sseBlocks -Depth 8)
        $streamRequest=[ordered]@{};$baseRequest.GetEnumerator()|ForEach-Object{$streamRequest[$_.Key]=$_.Value}
        $streamRequest.prompt='Reply with exactly the word NEXUS.'
        $streamRequest.stream=$true
        $streamRequest.mockStreamFile=$mockStreamPath
        $streamResult=Invoke-AihMuseProbeRequest -NodeExecutable $NodePath -Request ([pscustomobject]$streamRequest) -WorkspacePath $WorkspacePath -Label 'stream'
        $streamOutcome=$streamResult.Outcome
        $streamOk=[bool]$streamOutcome.ok-and[string]$streamOutcome.content-eq'NEXUS'-and[string]$streamOutcome.finishReason-eq'stop'-and$null-ne$streamOutcome.usage-and[int]$streamOutcome.usage.reasoningTokens-eq4
        $checks+=[pscustomobject][ordered]@{Name='probe-stream';Ok=$streamOk;Detail=if([bool]$streamOutcome.ok){'streaming deltas accumulated with termination and final usage chunk'}else{'stream probe failed: '+[string]$streamOutcome.errorKind}}

        # 3. malformed streaming chunk normalizes (never crashes, keeps partial)
        $mockBadStreamPath=Join-Path $WorkspacePath 'mock-stream-bad.sse.json'
        $badBlocks=@(
            'data: {"choices":[{"index":0,"delta":{"content":"PAR"}}]}',
            'data: {not-json-here',
            'data: [DONE]'
        )
        Write-AihAtomicText -Path $mockBadStreamPath -Content (ConvertTo-Json -InputObject $badBlocks -Depth 8)
        $badRequest=[ordered]@{};$baseRequest.GetEnumerator()|ForEach-Object{$badRequest[$_.Key]=$_.Value}
        $badRequest.prompt='Reply with exactly the word NEXUS.'
        $badRequest.stream=$true
        $badRequest.mockStreamFile=$mockBadStreamPath
        $badResult=Invoke-AihMuseProbeRequest -NodeExecutable $NodePath -Request ([pscustomobject]$badRequest) -WorkspacePath $WorkspacePath -Label 'stream-bad'
        $badOutcome=$badResult.Outcome
        $badOk=(-not[bool]$badOutcome.ok)-and[string]$badOutcome.errorKind-eq'stream-malformed'-and[string]$badOutcome.content-eq'PAR'
        $checks+=[pscustomobject][ordered]@{Name='probe-stream-malformed';Ok=$badOk;Detail=if([string]$badOutcome.errorKind-eq'stream-malformed'){'malformed chunk normalized; partial content preserved'}else{'unexpected outcome: '+[string]$badOutcome.errorKind}}

        # 4. interrupted stream normalizes
        $mockCutStreamPath=Join-Path $WorkspacePath 'mock-stream-cut.sse.json'
        $cutBlocks=@(
            'data: {"choices":[{"index":0,"delta":{"content":"CUT"}}]}'
        )
        Write-AihAtomicText -Path $mockCutStreamPath -Content (ConvertTo-Json -InputObject $cutBlocks -Depth 8)
        $cutRequest=[ordered]@{};$baseRequest.GetEnumerator()|ForEach-Object{$cutRequest[$_.Key]=$_.Value}
        $cutRequest.prompt='Reply with exactly the word NEXUS.'
        $cutRequest.stream=$true
        $cutRequest.mockStreamFile=$mockCutStreamPath
        $cutResult=Invoke-AihMuseProbeRequest -NodeExecutable $NodePath -Request ([pscustomobject]$cutRequest) -WorkspacePath $WorkspacePath -Label 'stream-cut'
        $cutOutcome=$cutResult.Outcome
        $cutOk=(-not[bool]$cutOutcome.ok)-and[string]$cutOutcome.errorKind-eq'stream-interrupted'-and[string]$cutOutcome.content-eq'CUT'-and[bool]$cutOutcome.interrupted
        $checks+=[pscustomobject][ordered]@{Name='probe-stream-interrupted';Ok=$cutOk;Detail=if([string]$cutOutcome.errorKind-eq'stream-interrupted'){'interrupted stream normalized; partial content preserved'}else{'unexpected outcome: '+[string]$cutOutcome.errorKind}}

        # 5. tool/function call contract
        $mockToolPath=Join-Path $WorkspacePath 'mock-tool.json'
        $toolCall=[ordered]@{id='call_probe_1';type='function';function=[ordered]@{name='get_test_temperature';arguments='{"city":"Paris"}'}}
        Write-AihAtomicJson -Path $mockToolPath -Value (New-AihMuseMockDocument -Status 200 -Body (New-AihMuseChatBody -FinishReason 'tool_calls' -ToolCalls @([pscustomobject]$toolCall)))
        $toolRequest=[ordered]@{};$baseRequest.GetEnumerator()|ForEach-Object{$toolRequest[$_.Key]=$_.Value}
        $toolRequest.prompt='What is the test temperature in Paris? Use the get_test_temperature tool.'
        $toolRequest.tools=@([ordered]@{type='function';function=[ordered]@{name='get_test_temperature';description='Return the recorded test temperature for a city.';parameters=[ordered]@{type='object';properties=[ordered]@{city=[ordered]@{type='string'}};required=@('city')}}})
        $toolRequest.toolChoice='auto'
        $toolRequest.mockFile=$mockToolPath
        $toolResult=Invoke-AihMuseProbeRequest -NodeExecutable $NodePath -Request ([pscustomobject]$toolRequest) -WorkspacePath $WorkspacePath -Label 'tool'
        $toolOutcome=$toolResult.Outcome
        $toolOk=[bool]$toolOutcome.ok-and$null-ne$toolOutcome.toolCalls-and@($toolOutcome.toolCalls).Count-eq1-and[string]$toolOutcome.toolCalls[0].name-eq'get_test_temperature'-and[string]$toolOutcome.toolCalls[0].id-eq'call_probe_1'
        $checks+=[pscustomobject][ordered]@{Name='probe-tool';Ok=$toolOk;Detail=if($toolOk){'tool call contract observed (id, name, JSON arguments)'}else{'tool probe failed: '+[string]$toolOutcome.errorKind}}

        # 6. reasoning mapping: the settings.yaml reasoningEfforts mapping IS
        #    the mapping of record; the probe sends the mapped native value.
        $mockEchoPath=Join-Path $WorkspacePath 'mock-echo.json'
        Write-AihAtomicJson -Path $mockEchoPath -Value (New-AihMuseMockDocument -Status 200 -Body (New-AihMuseChatBody -Content 'ok') -EchoRequest)
        # Exact wire test for EVERY supported level: minimal/low/medium/high/
        # xhigh map 1:1 to the official reasoning_effort spelling and the
        # request must carry exactly that value.
        foreach($pair in @(@('minimal','minimal'),@('low','low'),@('medium','medium'),@('high','high'),@('xhigh','xhigh'))){
            $nexusLevel=$pair[0];$expectedNative=$pair[1]
            $wireValue=Get-AihMuseReasoningWireValue -ProviderConfig $Config -Level $nexusLevel
            $mappingOk=$null-ne$wireValue-and[string]$wireValue-eq[string]$expectedNative
            $nativeLabel=if([string]::IsNullOrWhiteSpace([string]$wireValue)){'<omit>'}else{$wireValue}
            $checks+=[pscustomobject][ordered]@{Name=('reasoning-mapping-'+$nexusLevel);Ok=$mappingOk;Detail=('Nexus '+$nexusLevel+' -> '+$nativeLabel)}
            if($mappingOk){
                $reasonRequest=[ordered]@{};$baseRequest.GetEnumerator()|ForEach-Object{$reasonRequest[$_.Key]=$_.Value}
                $reasonRequest.prompt='Reply with the single word: ok'
                $reasonRequest.reasoningEffort=$wireValue
                $reasonRequest.mockFile=$mockEchoPath
                $reasonResult=Invoke-AihMuseProbeRequest -NodeExecutable $NodePath -Request ([pscustomobject]$reasonRequest) -WorkspacePath $WorkspacePath -Label ('reasoning-'+$nexusLevel)
                $reasonOutcome=$reasonResult.Outcome
                $sent=$null
                if($null-ne$reasonOutcome.resulting-and$null-ne$reasonOutcome.resulting.PSObject.Properties['reasoning_effort']){$sent=$reasonOutcome.resulting.reasoning_effort}
                $wireOk=[string]$sent-eq[string]$expectedNative
                $checks+=[pscustomobject][ordered]@{Name=('probe-reasoning-'+$nexusLevel);Ok=$wireOk;Detail=if($wireOk){'request carried the mapped reasoning_effort value'}else{'request reasoning_effort mismatch'}}
            }
        }
        # fail closed: "off" is NOT representable on the direct Meta contract
        # (reasoning_effort "none" returns HTTP 400; omission still reasons at
        # a model-determined level) and "max" is Standard-tier muse-spark-1.3
        # only — the Contributor route declares neither, so both refuse here
        # instead of silently sending a lower effort or omitting the parameter.
        foreach($refusedLevel in @('off','max','ultra')){
            $refused=Get-AihMuseReasoningWireValue -ProviderConfig $Config -Level $refusedLevel
            $checks+=[pscustomobject][ordered]@{Name=('reasoning-mapping-fail-closed-'+$refusedLevel);Ok=($null-eq$refused);Detail=('Nexus '+$refusedLevel+' is not offered by the Contributor route and fails closed (no silent lower effort, no omission-as-off)')}
        }

        # 7. normalized provider errors (401/429/5xx)
        foreach($statusCase in @(401,429,500)){
            $mockErrorPath=Join-Path $WorkspacePath ('mock-'+$statusCase+'.json')
            Write-AihAtomicJson -Path $mockErrorPath -Value (New-AihMuseMockDocument -Status $statusCase -Body ([pscustomobject][ordered]@{error=[ordered]@{message=('synthetic '+$statusCase);type='provider_error';param=$null;code=$null}}))
            $errorRequest=[ordered]@{};$baseRequest.GetEnumerator()|ForEach-Object{$errorRequest[$_.Key]=$_.Value}
            $errorRequest.prompt='Reply with exactly the word NEXUS.'
            $errorRequest.mockFile=$mockErrorPath
            $errorResult=Invoke-AihMuseProbeRequest -NodeExecutable $NodePath -Request ([pscustomobject]$errorRequest) -WorkspacePath $WorkspacePath -Label ('error-'+$statusCase)
            $errorOutcome=$errorResult.Outcome
            $errorOk=(-not[bool]$errorOutcome.ok)-and[string]$errorOutcome.errorKind-eq'provider-error'-and$null-ne$errorOutcome.status-and[int]$errorOutcome.status-eq$statusCase
            $checks+=[pscustomobject][ordered]@{Name=('probe-error-'+$statusCase);Ok=$errorOk;Detail=('HTTP '+$statusCase+' normalized to provider-error')}
        }

        # 8. secret hygiene: no key material anywhere in the probe records
        $allText=(($checks|ForEach-Object{[string]$_.Detail}) -join ';')+(($checks|ConvertTo-Json -Depth 6))
        $checks+=[pscustomobject][ordered]@{Name='secret-hygiene';Ok=(-not$allText.Contains($testKey));Detail='no probe record contains credential material'}
    }
    finally{
        if($keyOwnedByService){[Environment]::SetEnvironmentVariable($Config.apiKeyEnv,$null)}
        elseif($null-ne$previousKey){[Environment]::SetEnvironmentVariable($Config.apiKeyEnv,[string]$previousKey)}
    }
    return ,$checks
}

function New-AihMuseOutcomeView {
    # Live outcomes are heterogeneous: error paths emit fewer fields than
    # success paths. Normalize tolerantly so the battery records the failure
    # truthfully instead of crashing under StrictMode on a missing field.
    param([object]$Outcome)
    $view=[ordered]@{}
    foreach($name in @('ok','model','status','durationMs','ttftMs','usage','content','finishReason','errorKind','toolCalls','interrupted')){
        $prop=$Outcome.PSObject.Properties[$name]
        $view[$name]=if($null-ne$prop){$prop.Value}else{$null}
    }
    [pscustomobject]$view
}

function Invoke-AihMuseLiveChecks {
    # Opt-in live battery: a handful of tiny synthetic requests. Only harmless
    # synthetic prompts are sent (never repository source, credentials, or
    # project data).
    # Records model/provider/status/TTFT/latency/usage; NEVER the key.
    param(
        [Parameter(Mandatory=$true)][object]$Config,
        [Parameter(Mandatory=$true)][string]$ModelId,
        [Parameter(Mandatory=$true)][string]$NodePath,
        [Parameter(Mandatory=$true)][string]$WorkspacePath,
        [Parameter(Mandatory=$true)][string]$InstallRoot
    )

    # The probe transport child reads the credential from the environment.
    # The credential may live in the managed credential store rather than the
    # process environment, so resolve it once through the SAME helper the
    # credentials check used and expose it to the child for the battery only
    # (never printed, never written to any file; the previous environment is
    # restored in finally).
    $resolvedKey=Get-AihProviderApiKey -ApiKeyEnv $Config.apiKeyEnv -InstallRoot $InstallRoot
    $previousLiveKey=[Environment]::GetEnvironmentVariable($Config.apiKeyEnv)
    $liveKeyOwnedByService=$false
    if(-not[string]::IsNullOrWhiteSpace([string]$resolvedKey)-and[string]::IsNullOrWhiteSpace([string]$previousLiveKey)){
        [Environment]::SetEnvironmentVariable($Config.apiKeyEnv,[string]$resolvedKey)
        $liveKeyOwnedByService=$true
    }
    try{
    $results=@()
    $baseRequest=[ordered]@{
        baseUrl=$Config.baseURL
        apiKeyEnv=$Config.apiKeyEnv
        model=$ModelId
        timeoutMs=45000
        maxCompletionTokens=64
    }

    # TEXT
    $textRequest=[ordered]@{};$baseRequest.GetEnumerator()|ForEach-Object{$textRequest[$_.Key]=$_.Value}
    $textRequest.prompt='Reply with exactly the word NEXUS.'
    $textRun=Invoke-AihMuseProbeRequest -NodeExecutable $NodePath -Request ([pscustomobject]$textRequest) -WorkspacePath $WorkspacePath -Label 'live-text'
    $textOutcome=New-AihMuseOutcomeView $textRun.Outcome
    $results+=[pscustomobject][ordered]@{check='text';ok=[bool]$textOutcome.ok;model=$ModelId;status=$textOutcome.status;ttftMs=$null;durationMs=$textOutcome.durationMs;usage=$textOutcome.usage;errorKind=if([bool]$textOutcome.ok){$null}else{$textOutcome.errorKind}}

    # STREAM
    $streamRequest=[ordered]@{};$baseRequest.GetEnumerator()|ForEach-Object{$streamRequest[$_.Key]=$_.Value}
    $streamRequest.prompt='Reply with exactly the word NEXUS.'
    $streamRequest.stream=$true
    $streamRun=Invoke-AihMuseProbeRequest -NodeExecutable $NodePath -Request ([pscustomobject]$streamRequest) -WorkspacePath $WorkspacePath -Label 'live-stream'
    $streamOutcome=New-AihMuseOutcomeView $streamRun.Outcome
    $results+=[pscustomobject][ordered]@{check='stream';ok=[bool]$streamOutcome.ok;model=$ModelId;status=$streamOutcome.status;ttftMs=$streamOutcome.ttftMs;durationMs=$streamOutcome.durationMs;usage=$streamOutcome.usage;errorKind=if([bool]$streamOutcome.ok){$null}else{$streamOutcome.errorKind}}

    # TOOL CALL (harmless fake tool fixture; the tool is NEVER executed)
    $toolRequest=[ordered]@{};$baseRequest.GetEnumerator()|ForEach-Object{$toolRequest[$_.Key]=$_.Value}
    $toolRequest.prompt='Use the get_test_temperature tool for the city Paris.'
    $toolRequest.tools=@([ordered]@{type='function';function=[ordered]@{name='get_test_temperature';description='Return the recorded test temperature for a city.';parameters=[ordered]@{type='object';properties=[ordered]@{city=[ordered]@{type='string'}};required=@('city')}}})
    $toolRequest.toolChoice='auto'
    $toolRun=Invoke-AihMuseProbeRequest -NodeExecutable $NodePath -Request ([pscustomobject]$toolRequest) -WorkspacePath $WorkspacePath -Label 'live-tool'
    $toolOutcome=New-AihMuseOutcomeView $toolRun.Outcome
    $results+=[pscustomobject][ordered]@{check='tool';ok=([bool]$toolOutcome.ok-and$null-ne$toolOutcome.toolCalls);model=$ModelId;status=$toolOutcome.status;ttftMs=$null;durationMs=$toolOutcome.durationMs;usage=$toolOutcome.usage;errorKind=if([bool]$toolOutcome.ok){$null}else{$toolOutcome.errorKind}}

    # REASONING (mapped Nexus default effort of the Muse profile)
    $mapped=Get-AihMuseReasoningWireValue -ProviderConfig $Config -Level 'xhigh'
    if(-not[string]::IsNullOrWhiteSpace([string]$mapped)){
        $reasonRequest=[ordered]@{};$baseRequest.GetEnumerator()|ForEach-Object{$reasonRequest[$_.Key]=$_.Value}
        $reasonRequest.prompt='Reply with the single word: ok'
        $reasonRequest.reasoningEffort=$mapped
        $reasonRun=Invoke-AihMuseProbeRequest -NodeExecutable $NodePath -Request ([pscustomobject]$reasonRequest) -WorkspacePath $WorkspacePath -Label 'live-reasoning'
        $reasonOutcome=New-AihMuseOutcomeView $reasonRun.Outcome
        $results+=[pscustomobject][ordered]@{check='reasoning';ok=[bool]$reasonOutcome.ok;model=$ModelId;status=$reasonOutcome.status;ttftMs=$null;durationMs=$reasonOutcome.durationMs;usage=$reasonOutcome.usage;errorKind=if([bool]$reasonOutcome.ok){$null}else{$reasonOutcome.errorKind}}
    }
    return ,$results
    }
    finally{
        if($liveKeyOwnedByService){[Environment]::SetEnvironmentVariable($Config.apiKeyEnv,$null)}
        elseif($null-ne$previousLiveKey){[Environment]::SetEnvironmentVariable($Config.apiKeyEnv,[string]$previousLiveKey)}
    }
}

function Invoke-AihMuseProviderProbe {
    # The bounded Phase M2 provider capability probe. Validates TRANSPORT
    # only — this is not the Muse agent loop and never becomes one.
    #
    # Default (offline, deterministic): every check runs against mock
    # fixtures; no network access and no real key are required. The resolved
    # provider configuration and the credential REFERENCE (never the secret)
    # are still validated against the live configuration plane.
    #
    # -Live (opt-in, additionally gated by NEXUS_META_LIVE_TEST=1 and a
    # resolvable MODEL_API_KEY): runs a bounded battery of tiny synthetic
    # requests (text, stream, tool call, reasoning). Only harmless synthetic
    # prompts are sent — never repository source, credentials, or project
    # data. Records model/provider/status/latency/usage; never the key.
    [CmdletBinding()]
    param(
        [string]$InstallRoot,
        [string]$ProviderId = 'meta-model-api',
        [switch]$Live,
        [switch]$Raw
    )

    if([string]::IsNullOrWhiteSpace($InstallRoot)){$InstallRoot=Split-Path -Parent $PSScriptRoot}
    $InstallRoot=[IO.Path]::GetFullPath($InstallRoot)
    $layout=Get-AihLayout $InstallRoot
    $startedAt=[DateTime]::UtcNow

    $probe=[ordered]@{
        schemaVersion=1
        provider=if([string]::IsNullOrWhiteSpace($ProviderId)){$script:MuseDefaultProviderId}else{$ProviderId}
        mode=if($Live){'live'}else{'offline'}
        status='unavailable'
        credentialsDetected=$false
        apiKeyEnv=$null
        baseURL=$null
        checks=@()
        live=if($Live){[ordered]@{requested=$true;gateOpen=$false;ran=$false;reason=$null;results=@()}}else{$null}
        startedAtUtc=$startedAt.ToString('o')
        durationMs=0
    }

    $config=Resolve-AihMuseProviderConfig -SettingsPath $layout.Settings -ProviderId ([string]$probe.provider)
    if($null-eq$config){
        $probe.checks+=[pscustomobject][ordered]@{Name='provider-config';Ok=$false;Detail=('provider route ''' + [string]$probe.provider + ''' is not configured in ' + $layout.Settings + '; Muse provider unavailable (installation remains valid)')}
        $probe.durationMs=[int]([DateTime]::UtcNow-$startedAt).TotalMilliseconds
        $result=[pscustomobject]$probe
        if($Raw){return $result}
        Write-AihAtomicJson -Path (Join-Path ([IO.Path]::GetTempPath()) 'aih-muse-probe-result.json') -Value $result
        return $result
    }
    $probe.apiKeyEnv=$config.apiKeyEnv
    $probe.baseURL=$config.baseURL
    $probe.checks+=[pscustomobject][ordered]@{Name='provider-config';Ok=$true;Detail=('route ''' + $config.id + ''' resolves (api=' + $config.api + ')')}

    $resolvedKey=Get-AihProviderApiKey -ApiKeyEnv $config.apiKeyEnv -InstallRoot $InstallRoot
    if(-not[string]::IsNullOrWhiteSpace([string]$resolvedKey)){$probe.credentialsDetected=$true}
    $credentialDetail=if($probe.credentialsDetected){'credential reference ''' + $config.apiKeyEnv + ''' resolved (the value itself is never read into the probe record)'}else{'credential ''' + $config.apiKeyEnv + ''' not configured; Muse provider unavailable (installation remains valid)'}
    $probe.checks+=[pscustomobject][ordered]@{Name='credentials';Ok=$true;Detail=$credentialDetail}

    $nodePath=Get-AihMuseNodeExecutable -Layout $layout -InstallRoot $InstallRoot
    if([string]::IsNullOrWhiteSpace([string]$nodePath)){
        $probe.checks+=[pscustomobject][ordered]@{Name='transport-runtime';Ok=$false;Detail='no Node.js runtime is available for the probe transport'}
        $probe.durationMs=[int]([DateTime]::UtcNow-$startedAt).TotalMilliseconds
        $result=[pscustomobject]$probe
        if($Raw){return $result}
        Write-AihAtomicJson -Path (Join-Path ([IO.Path]::GetTempPath()) 'aih-muse-probe-result.json') -Value $result
        return $result
    }
    $probe.checks+=[pscustomobject][ordered]@{Name='transport-runtime';Ok=$true;Detail='Node transport available'}

    $workspace=New-AihMuseProbeWorkspace 'run'
    try{
        $modelId=if(@($config.models).Count-gt0){[string]@($config.models)[0].id}else{$null}
        if([string]::IsNullOrWhiteSpace($modelId)){
            $probe.checks+=[pscustomobject][ordered]@{Name='model';Ok=$false;Detail='provider route declares no model entries'}
        }
        else{
            # offline mock checks: transport contract, always run
            $offlineChecks=Invoke-AihMuseOfflineChecks -Config $config -ModelId $modelId -NodePath $nodePath -WorkspacePath $workspace
            $probe.checks+=$offlineChecks

            # live battery: opt-in and gated
            if($Live){
                $gateOpen=($env:NEXUS_META_LIVE_TEST -eq '1')
                $probe.live.gateOpen=$gateOpen
                if(-not$gateOpen){
                    $probe.live.reason='NEXUS_META_LIVE_TEST is not 1; live smoke stays disabled'
                }
                elseif(-not[bool]$probe.credentialsDetected){
                    $probe.live.reason='Meta credential unavailable; live smoke cannot run (this is not an installation failure)'
                }
                else{
                    $probe.live.ran=$true
                    $probe.live.results=Invoke-AihMuseLiveChecks -Config $config -ModelId $modelId -NodePath $nodePath -WorkspacePath $workspace -InstallRoot $InstallRoot
                }
            }
        }
    }
    finally{
        Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
    }
    $failed=@($probe.checks|Where-Object{-not[bool]$_.Ok})
    $probe.status=if($failed.Count-eq0){'ready'}else{'degraded'}
    if($Live-and[bool]$probe.live.ran-and@($probe.live.results|Where-Object{-not[bool]$_.ok}).Count-gt0){$probe.status='degraded'}

    $probe.durationMs=[int]([DateTime]::UtcNow-$startedAt).TotalMilliseconds
    $result=[pscustomobject]$probe
    if($Raw){return $result}
    Write-AihAtomicJson -Path (Join-Path ([IO.Path]::GetTempPath()) 'aih-muse-probe-result.json') -Value $result
    return $result
}

# ── CLI tail (no-op when dot-sourced without arguments) ────────────────────
if($args.Count-gt 0){
    $cliAction=$null
    $cliInstallRoot=$null
    $cliProviderId=$null
    $cliLive=$false
    for($argIndex=0;$argIndex-lt$args.Count;$argIndex++){
        switch($args[$argIndex]){
            '-Action'{if($argIndex+1-lt$args.Count){$cliAction=[string]$args[$argIndex+1];$argIndex++}}
            '-InstallRoot'{if($argIndex+1-lt$args.Count){$cliInstallRoot=[string]$args[$argIndex+1];$argIndex++}}
            '-ProviderId'{if($argIndex+1-lt$args.Count){$cliProviderId=[string]$args[$argIndex+1];$argIndex++}}
            '-Live'{$cliLive=$true}
        }
    }
    switch($cliAction){
        'resolve'{
            if([string]::IsNullOrWhiteSpace($cliInstallRoot)){$cliInstallRoot=Split-Path -Parent $PSScriptRoot}
            $cliLayout=Get-AihLayout ([IO.Path]::GetFullPath($cliInstallRoot))
            $cliConfig=Resolve-AihMuseProviderConfig -SettingsPath $cliLayout.Settings -ProviderId $(if([string]::IsNullOrWhiteSpace($cliProviderId)){$script:MuseDefaultProviderId}else{$cliProviderId})
            if($null-eq$cliConfig){Write-Output 'unresolved';exit 3}
            Write-Output ('resolved ' + $cliConfig.id + ' api=' + $cliConfig.api + ' baseURL=' + $cliConfig.baseURL + ' apiKeyEnv=' + $cliConfig.apiKeyEnv + ' models=' + ((@($cliConfig.models)|ForEach-Object{$_.id}) -join ','))
        }
        'probe'{
            $cliProbe=Invoke-AihMuseProviderProbe -InstallRoot $cliInstallRoot -ProviderId $cliProviderId -Live:$cliLive -Raw
            Write-Output ('PROBE ' + $cliProbe.status + ' | provider=' + $cliProbe.provider + ' | credentials=' + $cliProbe.credentialsDetected + ' | checks=' + @($cliProbe.checks).Count + ' | mode=' + $cliProbe.mode)
            foreach($failedCheck in @($cliProbe.checks|Where-Object{-not[bool]$_.Ok})){Write-Output ('FAILED ' + $failedCheck.Name + ': ' + $failedCheck.Detail)}
            if($null-ne$cliProbe.live-and[bool]$cliProbe.live.ran){
                foreach($liveResult in @($cliProbe.live.results)){Write-Output ('LIVE ' + $liveResult.check + ' ok=' + $liveResult.ok + ' status=' + $liveResult.status + ' durationMs=' + $liveResult.durationMs)}
            }
            exit $(if($cliProbe.status-eq'ready'){0}else{1})
        }
        default{throw "Unknown MuseProvider action: $cliAction"}
    }
}
