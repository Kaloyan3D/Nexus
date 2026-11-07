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
# DSH 0.2.x: planes are preset rows in data/cordis.patch.yml (verified below) -- not .agent-presets/<name>/agent.cordis.yml files.
$doctorHomePatch = Join-Path $layout.Data 'cordis.patch.yml'
$doctorHomePatchText = if (Test-Path -LiteralPath $doctorHomePatch) { Get-Content -Raw -Encoding UTF8 -LiteralPath $doctorHomePatch } else { '' }
Add-Check 'Normal preset' $doctorHomePatchText.Contains('id: preset-aih-engineering') 'aih-engineering / Normal Engineering'
Add-Check 'DeepSeek-only preset' $doctorHomePatchText.Contains('id: preset-aih-deepseek') 'aih-deepseek / DeepSeek Only'
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
$routeCli = Get-AihLayoutLauncherPath -Layout $layout -Name 'aih-route'
$completeCli = Get-AihLayoutLauncherPath -Layout $layout -Name 'aih-complete'
$stopCli = Get-AihLayoutLauncherPath -Layout $layout -Name 'aih-stop'
Add-Check 'routing CLI' (Test-Path -LiteralPath $routeCli) $routeCli
Add-Check 'routing state' (Test-Path -LiteralPath (Join-Path $layout.RoutingData 'states') -PathType Container) $layout.RoutingData
Add-Check 'completion CLI' (Test-Path -LiteralPath $completeCli) $completeCli
Add-Check 'completion records' (Test-Path -LiteralPath (Join-Path $layout.CompletionData 'records') -PathType Container) $layout.CompletionData
$gateProbe = New-AihCompletionDecision (Get-AihDeterministicAssessment ([pscustomobject]@{ Failed = 0; Results = @([pscustomobject]@{ Name = 'probe'; Status = 'PASS' }) })) (Get-AihAcceptanceAssessment @([pscustomobject]@{ id = 'probe'; criterion = 'probe'; status = 'met'; evidence = 'probe' })) (ConvertFrom-AihSemanticVerifierOutput '{"status":"PASS","summary":"probe","concreteReasons":[],"missingRequirements":[],"boundedFixes":[]}')
Add-Check 'completion engine' ($gateProbe.Status -eq 'PASS' -and $gateProbe.Complete) 'controller-owned verification + criteria decision'
Add-Check 'launcher state engine' (Test-Path -LiteralPath (Join-Path $layout.Scripts 'Startup.ps1')) 'STARTING / READY / FAILED readiness state machine'
Add-Check 'aih-stop CLI' (Test-Path -LiteralPath $stopCli) $stopCli
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

# --- Platform runtime -------------------------------------------------------
if (-not (Test-AihIsWindows)) {
    # Linux-specific runtime checks. Windows keeps its historical check set.
    $pwshHost = $null
    try { $pwshHost = Get-AihPowerShellHost $InstallRoot } catch { $pwshHost = $null }
    Add-Check 'PowerShell host' ($null -ne $pwshHost) $(if ($pwshHost) { $pwshHost } else { 'pwsh missing; run the Nexus installer (./setup.sh)' })
    $nodeExecutable = Join-Path (Join-Path $layout.Runtime 'node') (Get-AihNodeRelativeExecutable)
    $nodeOk = Test-Path -LiteralPath $nodeExecutable -PathType Leaf
    Add-Check 'Node executable' $nodeOk $(if ($nodeOk) { $nodeExecutable } else { 'missing; run the Nexus installer (./setup.sh)' })
    $pathValue = [string]$env:PATH
    $userHome = if (-not [string]::IsNullOrWhiteSpace($env:HOME)) { $env:HOME } else { [Environment]::GetFolderPath('UserProfile') }
    $launcherDir = if (-not [string]::IsNullOrWhiteSpace($env:AIH_USER_BIN)) { $env:AIH_USER_BIN } else { Join-Path $userHome '.local/bin' }
    $pathHasLauncherDir = ($pathValue -split ':') -contains $launcherDir
    Add-Check 'launcher directory on PATH' $pathHasLauncherDir $(if ($pathHasLauncherDir) { $launcherDir } else { "$launcherDir is not on PATH; add it to your shell profile (see docs/linux.md)" })
    $openerName = Get-AihBrowserOpenerName
    $xdgOpen = Get-Command $openerName -ErrorAction SilentlyContinue
    Add-Check "$openerName (browser)" ($null -ne $xdgOpen) $(if ($null -ne $xdgOpen) { 'present; aih -Open can launch a browser' } else { 'missing; aih -Open prints the URL instead' })
    $rg = Get-Command 'rg' -ErrorAction SilentlyContinue
    Add-Check 'ripgrep (optional context engine)' ($null -ne $rg) $(if ($null -ne $rg) { 'present; reference search enabled' } else { 'not installed; reference search degrades (install ripgrep with your package manager)' })
}

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
$nexusPackage = Join-Path $layout.Data 'profiles/node_modules/@nexus/ui-brand/package.json'
Add-Check 'Nexus UI package' (Test-Path -LiteralPath $nexusPackage) 'installed @nexus/ui-brand (profile module fallback)'
$homePatch = Join-Path $layout.Data 'cordis.patch.yml'
if (Test-Path -LiteralPath $homePatch) {
    $patchText = Get-Content -Raw -Encoding UTF8 -LiteralPath $homePatch
    Add-Check 'Nexus composition' ($patchText.Contains('nexus-ui-brand') -and $patchText.Contains('ui-brand-official') -and $patchText.Contains('disabled: true')) 'home patch rows: nexus-ui-brand + ui-brand-official disabled'
}
else { Add-Check 'Nexus composition' $false 'home cordis patch missing' }
# DSH 0.2.x: the cosmetic client-bundle patches (title, favicon, manifest, brand
# copy, sidebar width, primary-action colour, model badge) are retired because
# string-patching compiled upstream bundles is unsupported; see
# docs/integration/dsh-0.2.x-migration-report.md. Doctor therefore verifies
# the supported composition instead: the Nexus planes, the stock-preset
# lockout, the DSH-safe settings document name, and untouched upstream bundles.
if (Test-Path -LiteralPath $layout.Settings) {
    Add-Check 'Nexus dark default' ([regex]::IsMatch((Get-Content -Raw -Encoding UTF8 -LiteralPath $layout.Settings), '(?m)^ui-theme:\s*\r?\n\s+preference:\s*dark')) 'settings ui-theme preference'
}
else { Add-Check 'Nexus dark default' $false 'nexus-settings.yaml missing' }
Add-Check 'Nexus settings not importable by DSH' (-not (Test-Path -LiteralPath $layout.LegacySettings)) 'data/settings.yaml must not exist (DSH 0.2.x renames it on first boot)'
if (Test-Path -LiteralPath $homePatch) {
    $planeText = Get-Content -Raw -Encoding UTF8 -LiteralPath $homePatch
    $planesOk = $true
    foreach ($plane in @('aih-engineering', 'aih-deepseek', 'aih-muse')) {
        if (-not $planeText.Contains("id: preset-$plane")) { $planesOk = $false }
    }
    Add-Check 'Nexus agent planes declared' $planesOk 'preset-aih-engineering, preset-aih-deepseek, preset-aih-muse'
    $stockLocked = $true
    foreach ($stock in @('preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis')) {
        if (-not [regex]::IsMatch($planeText, "(?m)^- id: $stock\r?\n  disabled: true")) { $stockLocked = $false }
    }
    Add-Check 'Stock agent presets disabled' $stockLocked 'only Nexus controller planes are selectable'
}
else { Add-Check 'Nexus agent planes declared' $false 'home cordis patch missing' }
foreach ($plane in @('aih-engineering', 'aih-deepseek', 'aih-muse')) {
    Add-Check "Plane closure $plane" (Test-Path -LiteralPath (Join-Path $layout.Data ".agent-presets/$plane/AihController.cjs")) 'controller module closure published'
}
$headerPlugin = Join-Path $layout.Data 'OpenCode-SessionHeader.cjs'
Add-Check 'OpenCode session header plugin' (Test-Path -LiteralPath $headerPlugin) 'x-opencode-session via llm-pi-ai/request-headers'

# --- Nexus Controller panel --------------------------------------------------
$controllerPackage = Join-Path $layout.Data 'profiles/node_modules/@nexus/controller/package.json'
Add-Check 'Nexus controller package' (Test-Path -LiteralPath $controllerPackage) 'installed @nexus/controller (profile module fallback)'
$controllerHost = Join-Path $layout.Data 'profiles/node_modules/@nexus/controller/lib/index.js'
$controllerClient = Join-Path $layout.Data 'profiles/node_modules/@nexus/controller/lib/client.js'
$controllerAdapter = Join-Path $layout.Data 'profiles/node_modules/@nexus/controller/lib/status.cjs'
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
