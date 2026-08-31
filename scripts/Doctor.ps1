[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$Preset,
    [switch]$Offline
)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Routing.ps1')
. (Join-Path $PSScriptRoot 'Completion.ps1')
. (Join-Path $PSScriptRoot 'Startup.ps1')
$layout = Get-AihLayout $InstallRoot
$versions = Get-AihVersions $InstallRoot
$routingPolicy = Get-AihRoutingPolicy $layout.RoutingPolicy
$resolvedPreset = Resolve-AihPreset $routingPolicy $Preset
$deepSeekOnly = $resolvedPreset.Id -eq 'aih-deepseek'
$results = [System.Collections.Generic.List[object]]::new()

function Add-Check([string]$Name, [bool]$Pass, [string]$Detail) {
    $results.Add([pscustomobject]@{ Check = $Name; Status = if ($Pass) { 'PASS' } else { 'FAIL' }; Detail = $Detail })
}

Add-Check 'install root' (Test-Path -LiteralPath $layout.Root) $layout.Root
Add-Check 'portable Node' (Test-Path -LiteralPath $layout.Node) $versions.NodeVersion
Add-Check 'DeepSeek Harness' (Test-Path -LiteralPath $layout.Dsh) $versions.HarnessVersion
Add-Check 'openai-oauth (optional review)' $true $(if (Test-Path -LiteralPath $layout.OAuth) { "installed $($versions.OpenAiOAuthVersion); not required for ordinary tasks" } else { 'not installed; bounded Codex review unavailable' })
Add-Check 'settings' (Test-Path -LiteralPath $layout.Settings) $layout.Settings
Add-Check 'Normal preset' (Test-Path -LiteralPath (Join-Path $layout.Data '.agent-presets\aih-engineering\agent.cordis.yml')) 'aih-engineering / Normal Engineering'
Add-Check 'DeepSeek-only preset' (Test-Path -LiteralPath (Join-Path $layout.Data '.agent-presets\aih-deepseek\agent.cordis.yml')) 'aih-deepseek / DeepSeek Only'
Add-Check 'active preset' $true "$($resolvedPreset.Id) / $($resolvedPreset.Config.displayName)"
$routingPolicyValid = $false
$routingPolicyDetail = ''
try { $routingPolicy = Get-AihRoutingPolicy $layout.RoutingPolicy; $routingPolicyValid = $null -ne $routingPolicy } catch { $routingPolicyDetail = $_.Exception.Message }
if ($routingPolicyValid) { $routingPolicyDetail = "version $($routingPolicy.version); ordered rules $(@($routingPolicy.initialRules).Count)" }
Add-Check 'routing policy' $routingPolicyValid $routingPolicyDetail
if ($routingPolicyValid) {
    $routineProbe = Get-AihRoutingInitialDecision 'Locate a repository symbol.' $routingPolicy
    $securityProbe = Get-AihRoutingInitialDecision 'Design authentication architecture.' $routingPolicy
    Add-Check 'routing engine' ($routineProbe.ExecutionClass -eq 'engineer_normal' -and $securityProbe.ExecutionClass -eq 'engineer_deep' -and $securityProbe.ReviewRequired) 'deterministic engineer normal/critical probes'
}
else { Add-Check 'routing engine' $false 'policy unavailable' }
Add-Check 'routing CLI' (Test-Path -LiteralPath (Join-Path $layout.Bin 'aih-route.cmd')) (Join-Path $layout.Bin 'aih-route.cmd')
Add-Check 'routing state' (Test-Path -LiteralPath (Join-Path $layout.RoutingData 'states') -PathType Container) $layout.RoutingData
Add-Check 'completion CLI' (Test-Path -LiteralPath (Join-Path $layout.Bin 'aih-complete.cmd')) (Join-Path $layout.Bin 'aih-complete.cmd')
Add-Check 'completion records' (Test-Path -LiteralPath (Join-Path $layout.CompletionData 'records') -PathType Container) $layout.CompletionData
$gateProbe = New-AihCompletionDecision (Get-AihDeterministicAssessment ([pscustomobject]@{ Failed = 0; Results = @([pscustomobject]@{ Name = 'probe'; Status = 'PASS' }) })) (Get-AihAcceptanceAssessment @([pscustomobject]@{ id = 'probe'; criterion = 'probe'; status = 'met'; evidence = 'probe' })) (ConvertFrom-AihSemanticVerifierOutput '{"status":"PASS","summary":"probe","concreteReasons":[],"missingRequirements":[],"boundedFixes":[]}')
Add-Check 'completion engine' ($gateProbe.Status -eq 'PASS' -and $gateProbe.Complete) 'controller-owned verification + criteria decision'
Add-Check 'launcher state engine' (Test-Path -LiteralPath (Join-Path $layout.Scripts 'Startup.ps1')) 'STARTING / READY / FAILED readiness state machine'
Add-Check 'aih-stop CLI' (Test-Path -LiteralPath (Join-Path $layout.Bin 'aih-stop.cmd')) (Join-Path $layout.Bin 'aih-stop.cmd')
if (Test-Path -LiteralPath $layout.State) {
    try {
        $launcherState = Get-Content -Raw -LiteralPath $layout.State | ConvertFrom-Json
        $knownStatus = @('STARTING', 'READY', 'FAILED', 'STOPPED') -contains [string]$launcherState.Status
        Add-Check 'launcher state record' $knownStatus "status $($launcherState.Status); PID $($launcherState.Pid)"
    }
    catch { Add-Check 'launcher state record' $false $_.Exception.Message }
}
else { Add-Check 'launcher state record' $true 'no instance has been launched yet' }
$keyPresent = -not [string]::IsNullOrWhiteSpace((Get-AihDeepSeekKey $InstallRoot))
Add-Check 'DeepSeek credential' $keyPresent $(if ($keyPresent) { 'configured' } else { 'run aih-key' })

if (-not $Offline -and -not $deepSeekOnly -and (Test-Path -LiteralPath (Get-AihCodexAuthFile))) {
    $oauthReady = Test-AihEndpoint -Uri "$($versions.OAuthBaseUrl)/models" -TimeoutSec 3
    Add-Check 'OAuth endpoint' $oauthReady $versions.OAuthBaseUrl
    if ($oauthReady) {
        try {
            $models = Invoke-RestMethod -Uri "$($versions.OAuthBaseUrl)/models" -TimeoutSec 5
            $hasSol = @($models.data | ForEach-Object { $_.id }) -contains 'gpt-5.6-sol'
            Add-Check 'gpt-5.6-sol' $hasSol $(if ($hasSol) { 'available' } else { 'not listed' })
        }
        catch { Add-Check 'gpt-5.6-sol' $false $_.Exception.Message }
    }
}
if (-not $Offline -and $keyPresent) {
    try {
        $key = Get-AihDeepSeekKey $InstallRoot
        $headers = @{ Authorization = "Bearer $key" }
        $models = Invoke-RestMethod -Uri 'https://api.deepseek.com/models' -Headers $headers -TimeoutSec 20
        $ids = @($models.data | ForEach-Object id)
        Add-Check 'DeepSeek Flash' ($ids -contains 'deepseek-v4-flash') 'deepseek-v4-flash'
    }
    catch {
        Add-Check 'DeepSeek Flash' $false $_.Exception.Message
    }
    finally { $key = $null; $headers = $null }
}

# --- Nexus UI customization ------------------------------------------------
$nexusPackage = Join-Path $layout.Data 'profiles\node_modules\@nexus\ui-brand\package.json'
Add-Check 'Nexus UI package' (Test-Path -LiteralPath $nexusPackage) 'installed @nexus/ui-brand (profile module fallback)'
$homePatch = Join-Path $layout.Data 'cordis.patch.yml'
if (Test-Path -LiteralPath $homePatch) {
    $patchText = Get-Content -Raw -Encoding UTF8 -LiteralPath $homePatch
    Add-Check 'Nexus composition' ($patchText.Contains('nexus-ui-brand') -and $patchText.Contains('ui-brand-official') -and $patchText.Contains('disabled: true')) 'home patch rows: nexus-ui-brand + ui-brand-official disabled'
}
else { Add-Check 'Nexus composition' $false 'home cordis patch missing' }
$distIndex = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-web-frontend\dist\index.html'
$distFavicon = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-web-frontend\dist\favicon.svg'
$distManifest = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-web-frontend\dist\manifest.webmanifest'
if (Test-Path -LiteralPath $distIndex) {
    Add-Check 'Nexus app title' ((Get-Content -Raw -Encoding UTF8 -LiteralPath $distIndex).Contains('<title>Nexus</title>')) 'dist index.html'
}
else { Add-Check 'Nexus app title' $false 'dist index.html missing' }
if (Test-Path -LiteralPath $distFavicon) {
    Add-Check 'Nexus favicon' ((Get-Content -Raw -Encoding UTF8 -LiteralPath $distFavicon).Contains('#7C5CFF')) 'geometric Nexus mark, no DeepSeek whale'
}
else { Add-Check 'Nexus favicon' $false 'dist favicon.svg missing' }
if (Test-Path -LiteralPath $distManifest) {
    try {
        $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $distManifest | ConvertFrom-Json
        Add-Check 'Nexus PWA identity' ([string]$manifest.name -eq 'Nexus' -and [string]$manifest.short_name -eq 'Nexus') 'manifest name/short_name'
    }
    catch { Add-Check 'Nexus PWA identity' $false $_.Exception.Message }
}
else { Add-Check 'Nexus PWA identity' $false 'dist manifest missing' }
$rendererBundle = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-client-ui-renderer\lib\client.js'
if (Test-Path -LiteralPath $rendererBundle) {
    Add-Check 'Nexus runtime title' ((Get-Content -Raw -Encoding UTF8 -LiteralPath $rendererBundle).Contains('const productTitle = "Nexus"')) 'document title owner patched'
}
else { Add-Check 'Nexus runtime title' $false 'renderer client bundle missing' }
if (Test-Path -LiteralPath $layout.Settings) {
    Add-Check 'Nexus dark default' ([regex]::IsMatch((Get-Content -Raw -Encoding UTF8 -LiteralPath $layout.Settings), '(?m)^ui-theme:\s*\r?\n\s+preference:\s*dark')) 'settings ui-theme preference'
}
else { Add-Check 'Nexus dark default' $false 'settings missing' }
$frontendDist = Split-Path -Parent $distIndex
$nexusAssets = Join-Path $frontendDist 'assets'
if (Test-Path -LiteralPath (Join-Path $nexusAssets 'nexus-logo.png')) {
    Add-Check 'Nexus brand assets' ((Test-Path -LiteralPath (Join-Path $nexusAssets 'nexus-logo.png')) -and (Test-Path -LiteralPath (Join-Path $nexusAssets 'nexus-mark.png'))) 'dist assets: logo lockup + icon mark'
}
else { Add-Check 'Nexus brand assets' $false 'dist assets missing' }
$layoutBundle = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-client-ui-layout\lib\client.js'
if (Test-Path -LiteralPath $layoutBundle) {
    $layoutBundleText = Get-Content -Raw -Encoding UTF8 -LiteralPath $layoutBundle
    Add-Check 'Nexus sidebar width' ($layoutBundleText.Contains('sidebar: 288,') -and $layoutBundleText.Contains('d.sidebar === 0 ? 288 : 0')) 'expanded sidebar default 288px'
}
else { Add-Check 'Nexus sidebar width' $false 'layout client bundle missing' }
$conversationBundle = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\client.js'
if (Test-Path -LiteralPath $conversationBundle) {
    $conversationText = Get-Content -Raw -Encoding UTF8 -LiteralPath $conversationBundle
    Add-Check 'Nexus primary action' ($conversationText.Contains('background:var(--dsw-alias-button-primary-fill);color:#fff')) 'send button violet'
    Add-Check 'Nexus hero glow' ($conversationText.Contains('#7C5CFF') -and -not $conversationText.Contains('#6187D8')) 'hero glow tinted violet'
}
else { Add-Check 'Nexus primary action' $false 'conversation client bundle missing' }
$modelSelBundle = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-client-ui-model-selection\lib\client.js'
if (Test-Path -LiteralPath $modelSelBundle) {
    Add-Check 'Nexus model chip' ((Get-Content -Raw -Encoding UTF8 -LiteralPath $modelSelBundle).Contains('!modelLabel.toUpperCase().endsWith(effortLabel.toUpperCase())')) 'reasoning badge deduped'
}
else { Add-Check 'Nexus model chip' $false 'model-selection client bundle missing' }

# --- Nexus Controller panel --------------------------------------------------
$controllerPackage = Join-Path $layout.Data 'profiles\node_modules\@nexus\controller\package.json'
Add-Check 'Nexus controller package' (Test-Path -LiteralPath $controllerPackage) 'installed @nexus/controller (profile module fallback)'
$controllerHost = Join-Path $layout.Data 'profiles\node_modules\@nexus\controller\lib\index.js'
$controllerClient = Join-Path $layout.Data 'profiles\node_modules\@nexus\controller\lib\client.js'
$controllerAdapter = Join-Path $layout.Data 'profiles\node_modules\@nexus\controller\lib\status.cjs'
Add-Check 'Nexus controller files' ((Test-Path -LiteralPath $controllerHost) -and (Test-Path -LiteralPath $controllerClient) -and (Test-Path -LiteralPath $controllerAdapter)) 'host route + client panel + state adapter'
if (Test-Path -LiteralPath $homePatch) {
    $patchText = Get-Content -Raw -Encoding UTF8 -LiteralPath $homePatch
    Add-Check 'Nexus controller row' ($patchText.Contains('nexus-controller') -and $patchText.Contains("'@nexus/controller'")) 'home patch row: nexus-controller'
    # The row must be ENABLED — the invalid details-seat registration previously
    # forced the live composition to disable it. A disabled controller row is a
    # FAIL (the client boots without the panel otherwise).
    $controllerRowDisabled = $patchText -match '(?m)^    - id: nexus-controller\r?\n      name: ''@nexus/controller''\r?\n      disabled: true\r?\n'
    Add-Check 'Nexus controller enabled' (-not $controllerRowDisabled) 'nexus-controller row must not carry disabled: true'
}
else { Add-Check 'Nexus controller row' $false 'home cordis patch missing' }
if (Test-Path -LiteralPath $controllerHost) {
    $controllerHostText = Get-Content -Raw -Encoding UTF8 -LiteralPath $controllerHost
    Add-Check 'Nexus controller route' ($controllerHostText.Contains('/nexus/controller.json')) 'read-only status route registered on the webServer registry'
}
else { Add-Check 'Nexus controller route' $false 'controller host bundle missing' }

$results | Format-Table -AutoSize
if (@($results | Where-Object Status -eq 'FAIL').Count -gt 0) { exit 1 }
