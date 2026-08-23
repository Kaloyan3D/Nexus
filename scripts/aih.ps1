[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\AI-Harness',
    [Alias('Mode')][string]$Preset,
    [switch]$Open,
    [switch]$EnableCodexSubagent,
    [switch]$Restart
)

. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Project.ps1')
. (Join-Path $PSScriptRoot 'Startup.ps1')
. (Join-Path $PSScriptRoot 'Routing.ps1')
. (Join-Path $PSScriptRoot 'ControlRoom.ps1')
$layout = Get-AihLayout $InstallRoot
$versions = Get-AihVersions $InstallRoot
$routingPolicy = Get-AihRoutingPolicy $layout.RoutingPolicy
$presetSource = 'command line'
if ([string]::IsNullOrWhiteSpace($Preset)) {
    $presetSource = 'saved UI selection'
    $Preset = Get-AihSavedControlRoomPreset -SettingsPath $layout.Settings -Fallback ([string]$routingPolicy.defaultPreset)
}
$mode = Get-AihControlRoomMode -RoutingPolicy $routingPolicy -Preset $Preset
$Preset = $mode.Id
$workspace = [System.IO.Path]::GetFullPath((Get-Location).Path)
$userProfile = [System.IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile'))
if ($workspace.Equals($userProfile, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "AI Harness must be launched from a project directory, not your user profile. Change directory first, for example: cd C:\path\to\your-project; aih -Open" -ForegroundColor Red
    exit 2
}
Write-Host "AI Harness: scanning workspace $workspace ..."
$projectProfile = Get-AihProjectProfile -Workspace $workspace -InstallRoot $InstallRoot
$projectContext = Format-AihProjectContext -Profile $projectProfile
Write-Host "AI Harness: workspace scan complete (stacks: $(if ($projectProfile.Stacks.Count) { $projectProfile.Stacks -join ', ' } else { 'none detected' }))."
$webUrl = $versions.HarnessUrl
$oauthModelsUrl = "$($versions.OAuthBaseUrl)/models"

$requiredPaths = @($layout.Node, $layout.Dsh, $layout.Settings)
foreach ($required in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "AI Harness is incomplete; missing $required. Run Setup.ps1 again."
    }
}

$authFile = Get-AihCodexAuthFile
$oauthAvailable = Test-AihEndpoint -Uri $oauthModelsUrl -TimeoutSec 2
if (-not $oauthAvailable -and (Test-Path -LiteralPath $authFile) -and (Test-Path -LiteralPath $layout.OAuth)) {
    Write-Host 'AI Harness: starting the local OpenAI OAuth service for live mode switching ...'
    $oauthArguments = @($layout.OAuth, '--detach', '--no-open')
    $oauthProcess = Start-Process -FilePath $layout.Node -ArgumentList $oauthArguments -WindowStyle Hidden -PassThru
    $oauthAvailable = Wait-AihEndpoint -Uri $oauthModelsUrl -TimeoutSec 20
    if (-not $oauthAvailable -and -not $oauthProcess.HasExited) {
        Stop-Process -Id $oauthProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
if ($mode.RequiresOpenAI -and -not $oauthAvailable) {
    throw "Normal Engineering requires OpenAI OAuth. Run: $($layout.Bin)\aih-auth.cmd"
}
if ($oauthAvailable) {
    $modelResponse = Invoke-RestMethod -Uri $oauthModelsUrl -TimeoutSec 10
    $modelIds = @($modelResponse.data | ForEach-Object { $_.id })
    if ($modelIds -notcontains 'gpt-5.6-sol') {
        if ($mode.RequiresOpenAI) { throw 'The local OpenAI OAuth endpoint is running but gpt-5.6-sol is unavailable for this account.' }
        $oauthAvailable = $false
    }
}
if (-not $oauthAvailable) { Write-Warning 'Normal Engineering is unavailable in this Control Room process until ChatGPT/Codex OAuth is configured.' }

Write-Host 'AI Harness: checking DeepSeek API (timeout: 20 seconds) ...'
$deepSeekKey = Get-AihDeepSeekKey $InstallRoot
if ([string]::IsNullOrWhiteSpace($deepSeekKey)) {
    throw "DeepSeek API key is not configured. Run: $($layout.Bin)\aih-key.cmd"
}
$deepSeekHeaders = @{ Authorization = "Bearer $deepSeekKey" }
try {
    $deepSeekModels = Invoke-RestMethod -Uri 'https://api.deepseek.com/models' -Headers $deepSeekHeaders -TimeoutSec 20
}
catch {
    throw "Direct DeepSeek connectivity check failed: $($_.Exception.Message)"
}
if (@($deepSeekModels.data | ForEach-Object { $_.id }) -notcontains 'deepseek-v4-flash') {
    throw 'Direct DeepSeek API is reachable, but deepseek-v4-flash is not listed for this credential.'
}
$deepSeekHeaders = $null
Write-Host 'AI Harness: provider checks passed; preparing Web UI ...'

Set-AihControlRoomDefault -SettingsPath $layout.Settings -Mode $mode

$runningState = $null
$process = $null
$resumingStartup = $false
if (Test-Path -LiteralPath $layout.State) {
    try { $runningState = Get-Content -Raw -LiteralPath $layout.State | ConvertFrom-Json } catch { $runningState = $null }
}
if ($null -ne $runningState -and $null -ne $runningState.Pid) {
    $controlRoomSchema = if ($null -ne $runningState.PSObject.Properties['SchemaVersion']) { [int]$runningState.SchemaVersion } else { 1 }
    $existing = Get-Process -Id ([int]$runningState.Pid) -ErrorAction SilentlyContinue
    $existingIdentityMatches = $null -ne $existing -and (Test-AihTrackedProcessIdentity -Process $existing -State $runningState -ExpectedExecutable $layout.Node)
    if ($null -ne $existing -and -not $existingIdentityMatches) {
        throw "Refusing to reuse or stop PID $($runningState.Pid): the saved process identity is stale or does not match DSH."
    }
    if ($null -ne $existing -and (Test-AihEndpoint -Uri $webUrl -TimeoutSec 2)) {
        if ($runningState.Workspace -eq $workspace -and $controlRoomSchema -ge 3 -and -not $Restart) {
            $runningState.Status = 'READY'
            $runningState.Preset = $Preset
            $runningState.DefaultMode = $Preset
            $runningState.UpdatedAtUtc = [DateTime]::UtcNow.ToString('o')
            $runningState.ModeCapabilities = [ordered]@{ NormalEngineering = $oauthAvailable; DeepSeekOnly = $true }
            $runningState | Add-Member -NotePropertyName ReadyAtUtc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
            $runningState | Add-Member -NotePropertyName ReadinessEvidence -NotePropertyValue ([ordered]@{ TcpReachable = $true; HttpReady = $true; HttpStatus = 200; StdoutMarker = $true }) -Force
            Write-AihState -Path $layout.State -State $runningState
            Write-Host "AI Harness status: READY (already running for $workspace)"
            Write-Host "Default mode for new sessions: $($mode.DisplayName) (source: $presetSource)"
            Write-Host $webUrl
            if ($Open) { Start-Process $webUrl | Out-Null }
            exit 0
        }
        Stop-Process -Id $existing.Id -Force
        $existing.WaitForExit(10000) | Out-Null
    }
    elseif ($null -ne $existing -and $runningState.Workspace -eq $workspace -and $controlRoomSchema -ge 3 -and -not $Restart) {
        $process = $existing
        $resumingStartup = $true
        Write-Host "AI Harness status: STARTING (resuming readiness checks for PID $($process.Id))"
    }
    elseif ($null -ne $existing) {
        Stop-Process -Id $existing.Id -Force
        $existing.WaitForExit(10000) | Out-Null
    }
}
elseif ((Test-AihEndpoint -Uri $webUrl -TimeoutSec 2) -and -not $Restart) {
    throw "$webUrl is already in use by an untracked process. Stop it or rerun with -Restart after confirming ownership."
}

$projectName = Split-Path -Leaf $workspace
$env:DSH_HOME = $layout.Data
$env:AIH_LOCAL_OAUTH_KEY = if ($oauthAvailable) { 'local-oauth-no-secret' } else { $null }
$env:DEEPSEEK_API_KEY = $deepSeekKey
$env:AIH_ACTIVE_PRESET = $null
$env:AIH_ENABLE_CODEX_SUBAGENT = '0'
if ($EnableCodexSubagent) { Write-Warning '-EnableCodexSubagent is deprecated; Codex is now available only through the bounded review service.' }
$env:AIH_PERSONA = @"
You are the DeepSeek implementation agent for workspace $workspace. Complete the supplied bounded task. Use repository-local instructions and relevant context. Respect scope, use targeted verification, and return structured evidence. The deterministic controller owns task state, routing, retries, budgets, escalation, and completion. If blocked, return one scoped escalation with a stable failure signature.

$projectContext
"@
$env:AIH_PERSONA_DEEPSEEK = @"
You are the DeepSeek implementation agent for workspace $workspace. Complete the supplied bounded task. Use repository-local instructions and relevant context. Respect scope, use targeted verification, and return structured evidence. The deterministic controller owns task state, routing, retries, budgets, escalation, and completion. Codex is unavailable in this preset. If blocked, return one scoped escalation with a stable failure signature.

$projectContext
"@

$stdoutLog = Join-Path $layout.Logs 'dsh.out.log'
$stderrLog = Join-Path $layout.Logs 'dsh.err.log'
$launchTime = [DateTime]::UtcNow
if (-not $resumingStartup) {
    $arguments = @($layout.Dsh, 'web', '--port', '3080')
    $process = Start-Process -FilePath $layout.Node -ArgumentList $arguments -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
    $process.Refresh()
    $launchTime = $process.StartTime.ToUniversalTime()
    $state = [ordered]@{
        SchemaVersion = 3
        Status = 'STARTING'
        Pid = $process.Id
        ProcessStartedAtUtc = $launchTime.ToString('o')
        Workspace = $workspace
        Preset = $Preset
        DefaultMode = $Preset
        ModeCapabilities = [ordered]@{ NormalEngineering = $oauthAvailable; DeepSeekOnly = $true }
        Url = $webUrl
        StartedAtUtc = [DateTime]::UtcNow.ToString('o')
        UpdatedAtUtc = [DateTime]::UtcNow.ToString('o')
        StdoutLog = $stdoutLog
        StderrLog = $stderrLog
        CodexSubagent = [bool]$EnableCodexSubagent
    }
    Write-AihState -Path $layout.State -State $state
    $env:DEEPSEEK_API_KEY = $null
    Write-Host "AI Harness status: STARTING (PID $($process.Id); provisional state saved)"
}
else {
    $state = [ordered]@{}
    foreach ($property in $runningState.PSObject.Properties) { $state[$property.Name] = $property.Value }
    if ($state.Contains('ProcessStartedAtUtc')) { $launchTime = ([datetime]$state.ProcessStartedAtUtc).ToUniversalTime() }
}
$deepSeekKey = $null
$env:DEEPSEEK_API_KEY = $null

$childStatusProbe = {
    $process.Refresh()
    if ($process.HasExited) { [pscustomobject]@{ Alive = $false; ExitCode = $process.ExitCode } }
    else { [pscustomobject]@{ Alive = $true; ExitCode = $null } }
}
$readinessProbe = { Get-AihWebProbe -Uri $webUrl -StdoutLog $stdoutLog -NotBeforeUtc $launchTime }
$onStarting = {
    param($elapsed, $probe)
    $state['Status'] = 'STARTING'
    $state['UpdatedAtUtc'] = [DateTime]::UtcNow.ToString('o')
    $state['StartupEvidence'] = [ordered]@{ TcpReachable = $probe.TcpReachable; HttpReady = $probe.HttpReady; StdoutMarker = $probe.StdoutMarker }
    Write-AihState -Path $layout.State -State $state
    Write-Host "AI Harness status: STARTING (initial 30-second window elapsed; child PID $($process.Id) is alive, continuing bounded initialization grace)"
}
$startup = Wait-AihWebStartup -ChildStatusProbe $childStatusProbe -ReadinessProbe $readinessProbe -InitialWindowMilliseconds 30000 -GraceMilliseconds 90000 -PollMilliseconds 500 -OnStarting $onStarting

if ($startup.Status -eq 'FAILED') {
    $state['Status'] = 'FAILED'
    $state['ExitCode'] = $startup.ExitCode
    $state['UpdatedAtUtc'] = [DateTime]::UtcNow.ToString('o')
    $state['FailureReason'] = $startup.Reason
    Write-AihState -Path $layout.State -State $state
    $stderrTail = Get-AihLogTail -Path $stderrLog
    $stdoutTail = Get-AihLogTail -Path $stdoutLog
    throw "DeepSeek Harness Web UI FAILED for $projectName.`nChild exit code: $($startup.ExitCode)`nStderr tail:`n$stderrTail`nStdout tail:`n$stdoutTail"
}
if ($startup.Status -eq 'STARTING') {
    $state['Status'] = 'STARTING'
    $state['UpdatedAtUtc'] = [DateTime]::UtcNow.ToString('o')
    $state['StartupEvidence'] = [ordered]@{ TcpReachable = $startup.Probe.TcpReachable; HttpReady = $startup.Probe.HttpReady; StdoutMarker = $startup.Probe.StdoutMarker }
    Write-AihState -Path $layout.State -State $state
    Write-Host "AI Harness status: STARTING (PID $($process.Id) remains alive after the bounded grace period)"
    Write-Host "Run aih again to resume readiness checks. Logs: $stdoutLog and $stderrLog"
    Write-Host $webUrl
    exit 0
}

$state['Status'] = 'READY'
$state['ReadyAtUtc'] = [DateTime]::UtcNow.ToString('o')
$state['UpdatedAtUtc'] = [DateTime]::UtcNow.ToString('o')
$state['ReadinessReason'] = $startup.Reason
$state['StartupEvidence'] = [ordered]@{ TcpReachable = $startup.Probe.TcpReachable; HttpReady = $startup.Probe.HttpReady; HttpStatus = $startup.Probe.HttpStatus; StdoutMarker = $startup.Probe.StdoutMarker }
Write-AihState -Path $layout.State -State $state

Write-Host "AI Harness status: READY for $workspace"
Write-Host "Default mode for new sessions: $Preset ($($mode.DisplayName); source: $presetSource)"
Write-Host "Detected stacks: $(if ($projectProfile.Stacks.Count) { $projectProfile.Stacks -join ', ' } else { 'none' }); verification commands: $($projectProfile.VerificationCommands.Count)"
Write-Host $webUrl
if ($Open) { Start-Process $webUrl | Out-Null }
