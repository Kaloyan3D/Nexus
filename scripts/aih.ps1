[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\AI-Harness',
    [Alias('Mode')][string]$Preset = 'aih-engineering',
    [switch]$Open,
    [switch]$EnableCodexSubagent,
    [switch]$Restart
)

. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Project.ps1')
. (Join-Path $PSScriptRoot 'Startup.ps1')
. (Join-Path $PSScriptRoot 'Routing.ps1')
$layout = Get-AihLayout $InstallRoot
$versions = Get-AihVersions $InstallRoot
$routingPolicy = Get-AihRoutingPolicy $layout.RoutingPolicy
$resolvedPreset = Resolve-AihPreset $routingPolicy $Preset
$Preset = $resolvedPreset.Id
$deepSeekOnly = $Preset -eq 'aih-deepseek'
$workspace = [System.IO.Path]::GetFullPath((Get-Location).Path)
$projectProfile = Get-AihProjectProfile -Workspace $workspace -InstallRoot $InstallRoot
$projectContext = Format-AihProjectContext -Profile $projectProfile
$webUrl = $versions.HarnessUrl
$oauthModelsUrl = "$($versions.OAuthBaseUrl)/models"

$requiredPaths = @($layout.Node, $layout.Dsh, $layout.Settings)
if (-not $deepSeekOnly) { $requiredPaths += $layout.OAuth }
foreach ($required in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "AI Harness is incomplete; missing $required. Run Setup.ps1 again."
    }
}

if (-not $deepSeekOnly -and -not (Test-AihEndpoint -Uri $oauthModelsUrl -TimeoutSec 2)) {
    $authFile = Get-AihCodexAuthFile
    if (-not (Test-Path -LiteralPath $authFile)) {
        throw "OpenAI OAuth login is required. Run: $($layout.Bin)\aih-auth.cmd"
    }
    $oauthArguments = @($layout.OAuth, '--detach', '--no-open')
    $oauthProcess = Start-Process -FilePath $layout.Node -ArgumentList $oauthArguments -WindowStyle Hidden -Wait -PassThru
    if ($oauthProcess.ExitCode -ne 0 -or -not (Wait-AihEndpoint -Uri $oauthModelsUrl -TimeoutSec 20)) {
        throw "openai-oauth did not start. Run interactively: $($layout.Bin)\aih-auth.cmd"
    }
}

if (-not $deepSeekOnly) {
    $modelResponse = Invoke-RestMethod -Uri $oauthModelsUrl -TimeoutSec 10
    $modelIds = @($modelResponse.data | ForEach-Object { $_.id })
    if ($modelIds -notcontains 'gpt-5.6-sol') {
        throw "The local OpenAI OAuth endpoint is running but gpt-5.6-sol is unavailable for this account."
    }
}

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
if ($deepSeekOnly -and @($deepSeekModels.data | ForEach-Object { $_.id }) -notcontains 'deepseek-v4-pro') {
    throw 'DeepSeek-only Tier 1 unavailable. deepseek-v4-pro is not listed for this credential.'
}
$deepSeekKey = $null
$deepSeekHeaders = $null

$settingsText = Get-Content -Raw -LiteralPath $layout.Settings
$modelBlock = if ($deepSeekOnly) { "agent-default-model:`n  provider: deepseek-pro-direct`n  model: deepseek-v4-pro`n  reasoningEffort: max`n" } else { "agent-default-model:`n  provider: sol-local`n  model: gpt-5.6-sol`n  reasoningEffort: xhigh`n" }
$settingsText = [regex]::Replace($settingsText, '(?m)^agent-default-model:\r?\n(?:  [^\r\n]*\r?\n)+', $modelBlock)
$settingsText = [regex]::Replace($settingsText, '(?m)^agent-presets:\r?\n  default: [^\r\n]+', "agent-presets:`n  default: $Preset")
[System.IO.File]::WriteAllText($layout.Settings, $settingsText, [Text.UTF8Encoding]::new($false))

$runningState = $null
$process = $null
$resumingStartup = $false
if (Test-Path -LiteralPath $layout.State) {
    try { $runningState = Get-Content -Raw -LiteralPath $layout.State | ConvertFrom-Json } catch { $runningState = $null }
}
if ($null -ne $runningState -and $null -ne $runningState.Pid) {
    $runningPreset = if ($null -ne $runningState.PSObject.Properties['Preset']) { [string]$runningState.Preset } else { 'aih-engineering' }
    $existing = Get-Process -Id ([int]$runningState.Pid) -ErrorAction SilentlyContinue
    $existingIdentityMatches = $null -ne $existing -and (Test-AihTrackedProcessIdentity -Process $existing -State $runningState -ExpectedExecutable $layout.Node)
    if ($null -ne $existing -and -not $existingIdentityMatches) {
        throw "Refusing to reuse or stop PID $($runningState.Pid): the saved process identity is stale or does not match DSH."
    }
    if ($null -ne $existing -and (Test-AihEndpoint -Uri $webUrl -TimeoutSec 2)) {
        if ($runningState.Workspace -eq $workspace -and $runningPreset -eq $Preset -and -not $Restart) {
            Write-Host "AI Harness status: READY (already running for $workspace)"
            Write-Host $webUrl
            if ($Open) { Start-Process $webUrl | Out-Null }
            exit 0
        }
        Stop-Process -Id $existing.Id -Force
        $existing.WaitForExit(10000) | Out-Null
    }
    elseif ($null -ne $existing -and $runningState.Workspace -eq $workspace -and $runningPreset -eq $Preset -and -not $Restart) {
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
$env:AIH_LOCAL_OAUTH_KEY = if ($deepSeekOnly) { $null } else { 'local-oauth-no-secret' }
$env:AIH_ACTIVE_PRESET = $Preset
$env:AIH_ENABLE_CODEX_SUBAGENT = if ($EnableCodexSubagent -and -not $deepSeekOnly) { '1' } else { '0' }
$env:AIH_PERSONA = @"
You are the Tier 1 GPT-5.6 Sol lead engineer for workspace $workspace. Sol thinks; Flash works; deterministic tools verify facts. You own architecture, planning, decomposition, acceptance criteria, genuinely difficult debugging, and semantic review. Workers may finish bounded tasks but never have authority to declare the overall user objective complete.

PHASE 4 ROUTING POLICY: For every bounded task that may be delegated, first execute C:\AI-Harness\bin\aih-route.cmd with the task description and retain its JSON decision record. Include its taskId and selected-tier decision in every worker assignment; workers must reject an absent or mismatched record. Dispatch selectedTier 3 through tier3_flash, selectedTier 2 through tier2_flash_max, and selectedTier 1 in this Sol lead. The ordered routing policy is inspectable at C:\AI-Harness\config\routing-policy.json. User overrides tier1, tier2, or tier3 always win through aih-route -ForceTier. Reuse the returned taskId when reporting progress or an escalation signal.

Escalate only through Tier 3 -> Tier 2 -> Tier 1. A minor error never escalates. Record -Signal attempt-failure after a relevant failed attempt; two recorded failures at the same tier escalate. Record verification-failure with -FailureReason; the same deterministic failure must recur before escalation. blocker, serious-uncertainty, architecture-required, acceptance-unmet, broad-unrelated-changes, or tier2-failed may escalate immediately because those signals assert the serious condition already exists. Do not use routing to claim completion: routing records always have completionAuthority=false.

PHASE 5 COMPLETION GATE: Never declare the overall objective complete from a worker report, routing decision, or your own unstructured judgment. Account for every acceptance criterion in a JSON evidence file, then run C:\AI-Harness\bin\aih-complete.cmd with the original objective and that file. Ordinary completion requires deterministic verification PASS, complete acceptance-criteria evidence, and a structured Tier 1 Sol semantic PASS. If the gate returns FAIL, follow its concrete boundedFixCycles and rerun the gate after the fixes; do not silently complete. OVERRIDDEN is an exceptional operator disposition, never a PASS, and requires explicit operator identity and a substantive audited reason.

Parallelize independent read-only research only; never allow uncontrolled parallel writes to overlapping files. Use separate Git worktrees or branches for independent write tasks. Use C:\AI-Harness\bin\aih-verify.cmd to run applicable project-aware deterministic checks and inspect their evidence.

$projectContext
"@
$env:AIH_PERSONA_DEEPSEEK = @"
You are the Tier 1 DeepSeek V4 Pro MAX lead engineer for workspace $workspace. This is strict DeepSeek-only mode: no GPT, OpenAI OAuth, Sol, or Codex subagent inference call is permitted. You own architecture, planning, decomposition, acceptance criteria, escalation resolution, and final semantic review. Use aih-route with -Preset aih-deepseek; Tier 2 is tier2_flash_max and Tier 3 is tier3_flash. Workers have completionAuthority=false.

Never declare overall completion without C:\AI-Harness\bin\aih-complete.cmd -Preset aih-deepseek returning ordinary PASS. The gate requires deterministic verification, every acceptance criterion met with evidence, and DeepSeek V4 Pro MAX semantic PASS. If Tier 1 is unavailable, fail closed with: DeepSeek-only Tier 1 unavailable. Never switch providers or invoke subagent_codex.

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
        SchemaVersion = 2
        Status = 'STARTING'
        Pid = $process.Id
        ProcessStartedAtUtc = $launchTime.ToString('o')
        Workspace = $workspace
        Preset = $Preset
        Url = $webUrl
        StartedAtUtc = [DateTime]::UtcNow.ToString('o')
        UpdatedAtUtc = [DateTime]::UtcNow.ToString('o')
        StdoutLog = $stdoutLog
        StderrLog = $stderrLog
        CodexSubagent = [bool]$EnableCodexSubagent
    }
    Write-AihState -Path $layout.State -State $state
    Write-Host "AI Harness status: STARTING (PID $($process.Id); provisional state saved)"
}
else {
    $state = [ordered]@{}
    foreach ($property in $runningState.PSObject.Properties) { $state[$property.Name] = $property.Value }
    if ($state.Contains('ProcessStartedAtUtc')) { $launchTime = ([datetime]$state.ProcessStartedAtUtc).ToUniversalTime() }
}

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
Write-Host "Agent preset: $Preset ($($resolvedPreset.Config.displayName))"
Write-Host "Detected stacks: $(if ($projectProfile.Stacks.Count) { $projectProfile.Stacks -join ', ' } else { 'none' }); verification commands: $($projectProfile.VerificationCommands.Count)"
Write-Host $webUrl
if ($Open) { Start-Process $webUrl | Out-Null }
