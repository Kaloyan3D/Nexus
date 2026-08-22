[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\AI-Harness',
    [ValidateSet('all', 'normal', 'deepseek')][string]$Mode = 'all'
)

. (Join-Path $PSScriptRoot 'Common.ps1')
$layout = Get-AihLayout $InstallRoot
$versions = Get-AihVersions $InstallRoot
$oauthModelsUrl = "$($versions.OAuthBaseUrl)/models"

if ($Mode -eq 'normal' -and (Test-Path -LiteralPath (Get-AihCodexAuthFile)) -and -not (Test-AihEndpoint -Uri $oauthModelsUrl -TimeoutSec 2)) {
    $oauthProcess = Start-Process -FilePath $layout.Node -ArgumentList @($layout.OAuth, '--detach', '--no-open') -WindowStyle Hidden -Wait -PassThru
    if ($oauthProcess.ExitCode -ne 0 -or -not (Wait-AihEndpoint -Uri $oauthModelsUrl -TimeoutSec 20)) {
        throw 'openai-oauth is not ready. Run its local login command first.'
    }
}

$deepSeekKey = Get-AihDeepSeekKey $InstallRoot
if ([string]::IsNullOrWhiteSpace($deepSeekKey)) {
    throw "DeepSeek API key is not configured. Run: $($layout.Bin)\aih-key.cmd"
}

$baseSettings = Get-Content -Raw -LiteralPath $layout.Settings
$selectionPattern = '(?m)^agent-default-model:\r?\n(?:  [^\r\n]*\r?\n)+'
if ([regex]::Matches($baseSettings, $selectionPattern).Count -ne 1) {
    throw 'settings.yaml does not contain exactly one agent-default-model block.'
}

$probes = @(
    [pscustomobject]@{ Tier = 'DeepSeek normal'; Provider = 'flash-high-direct'; Model = 'deepseek-v4-flash'; Effort = 'high'; Expected = 'DEEPSEEK_NORMAL_OK' },
    [pscustomobject]@{ Tier = 'DeepSeek deep'; Provider = 'flash-max-direct'; Model = 'deepseek-v4-flash'; Effort = 'max'; Expected = 'DEEPSEEK_DEEP_OK' }
)
if ($Mode -eq 'normal' -and (Test-AihEndpoint -Uri $oauthModelsUrl -TimeoutSec 2)) { $probes += [pscustomobject]@{ Tier = 'Bounded Codex review'; Provider = 'sol-local'; Model = 'gpt-5.6-sol'; Effort = 'medium'; Expected = 'CODEX_REVIEW_OK' } }

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$probeRoot = Join-Path $temporaryBase ("aih-tier-probes-" + [guid]::NewGuid().ToString('N'))
$failedProbes = [System.Collections.Generic.List[string]]::new()
New-Item -ItemType Directory -Path $probeRoot | Out-Null
try {
    $env:AIH_LOCAL_OAUTH_KEY = if ($Mode -eq 'deepseek') { $null } else { 'local-oauth-no-secret' }
    $env:DEEPSEEK_API_KEY = $deepSeekKey
    foreach ($probe in $probes) {
        $probeHome = Join-Path $probeRoot ($probe.Tier -replace '\s+', '-').ToLowerInvariant()
        New-Item -ItemType Directory -Path $probeHome | Out-Null
        $selection = "agent-default-model:`n  provider: $($probe.Provider)`n  model: $($probe.Model)`n  reasoningEffort: $($probe.Effort)`n"
        $settings = [regex]::Replace($baseSettings, $selectionPattern, $selection)
        [System.IO.File]::WriteAllText((Join-Path $probeHome 'settings.yaml'), $settings, [System.Text.UTF8Encoding]::new($false))
        $env:DSH_HOME = $probeHome
        $previousErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $output = (& $layout.Node $layout.Dsh --profile headless "Reply with exactly $($probe.Expected) and nothing else." 2>&1 | Out-String).Trim()
        $probeExitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousErrorAction
        if ($probeExitCode -ne 0) {
            $failedProbes.Add("$($probe.Tier) FAIL ($($probe.Provider)/$($probe.Model), reasoning $($probe.Effort)): $output")
            Write-Host $failedProbes[$failedProbes.Count - 1]
            continue
        }
        if ($output -ne $probe.Expected) {
            $failedProbes.Add("$($probe.Tier) FAIL ($($probe.Provider)/$($probe.Model), reasoning $($probe.Effort)): unexpected output: $output")
            Write-Host $failedProbes[$failedProbes.Count - 1]
            continue
        }
        Write-Host "$($probe.Tier) PASS ($($probe.Provider)/$($probe.Model), reasoning $($probe.Effort))"
    }
}
finally {
    $deepSeekKey = $null
    $env:DEEPSEEK_API_KEY = $null
    $resolvedProbeRoot = [System.IO.Path]::GetFullPath($probeRoot)
    if ($resolvedProbeRoot.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedProbeRoot) -like 'aih-tier-probes-*') {
        Remove-Item -LiteralPath $resolvedProbeRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($failedProbes.Count -gt 0) { exit 1 }
