[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\AI-Harness',
    [string]$Preset,
    [switch]$Offline
)

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
    Add-Check 'routing engine' ($routineProbe.ExecutionClass -eq 'deepseek_normal' -and $securityProbe.ExecutionClass -eq 'deepseek_deep' -and $securityProbe.ReviewRequired) 'deterministic DeepSeek normal/critical probes'
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

$results | Format-Table -AutoSize
if (@($results | Where-Object Status -eq 'FAIL').Count -gt 0) { exit 1 }
