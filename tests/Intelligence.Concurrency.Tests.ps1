[CmdletBinding()]param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot))
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Workspace.ps1')
. (Join-Path $InstallRoot 'tests/ProcessSignal.TestHelpers.ps1')

$passed = 0
function Assert-Aih([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "FAIL: $Name" }
    $script:passed++
    Write-Host "PASS: $Name"
}
function New-Fixture([string]$Name) {
    $path = Join-Path ([IO.Path]::GetTempPath()) ("aih-concurrency-$Name-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    return $path
}
function Invoke-TestGit([string]$Root, [string[]]$Arguments) {
    & git -C $Root @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw "git failed: $($Arguments -join ' ')" }
}
function Start-ResolveProcess {
    param(
        [string]$PowerShellHost,
        [string]$Root,
        [string]$Store,
        [string]$Repository,
        [string]$StartEvent,
        [string]$ReleaseEvent,
        [string]$ObservationEvent,
        [string]$ObservationLog
    )
    $scriptText = @'
. (Join-Path $env:AIH_TEST_ROOT 'scripts/Workspace.ps1')
. (Join-Path $env:AIH_TEST_ROOT 'tests/ProcessSignal.TestHelpers.ps1')
function Get-AihCheckoutObservation {
    param([string]$CheckoutRoot, [string]$Vcs)
    [IO.File]::AppendAllText($env:AIH_TEST_OBSERVATION_LOG, ([Diagnostics.Process]::GetCurrentProcess().Id.ToString() + [Environment]::NewLine))
    $observation = (Open-AihTestProcessSignal -Path $env:AIH_TEST_OBSERVATION_EVENT)
    try { $null = $observation.Set() } finally { $observation.Dispose() }
    $release = (Open-AihTestProcessSignal -Path $env:AIH_TEST_RELEASE_EVENT)
    try { $null = $release.WaitOne() } finally { $release.Dispose() }
    return [pscustomobject]@{
        branch = 'main'; headSha = 'test-head'; detached = $false; isDirty = $false
        changedCount = 0; observedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
}
$start = (Open-AihTestProcessSignal -Path $env:AIH_TEST_START_EVENT)
try { $null = $start.WaitOne() } finally { $start.Dispose() }
Resolve-AihNexusWorkspaceIdentity -StoreRoot $env:AIH_TEST_STORE -Path $env:AIH_TEST_REPOSITORY | ConvertTo-Json -Depth 8 -Compress
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($scriptText))
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $PowerShellHost
    $info.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables['AIH_TEST_ROOT'] = $Root
    $info.EnvironmentVariables['AIH_TEST_STORE'] = $Store
    $info.EnvironmentVariables['AIH_TEST_REPOSITORY'] = $Repository
    $info.EnvironmentVariables['AIH_TEST_START_EVENT'] = $StartEvent
    $info.EnvironmentVariables['AIH_TEST_RELEASE_EVENT'] = $ReleaseEvent
    $info.EnvironmentVariables['AIH_TEST_OBSERVATION_EVENT'] = $ObservationEvent
    $info.EnvironmentVariables['AIH_TEST_OBSERVATION_LOG'] = $ObservationLog
    return [Diagnostics.Process]::Start($info)
}
function Start-EncodedProcess {
    param([string]$PowerShellHost, [string]$ScriptText, [hashtable]$Environment = @{})
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ScriptText))
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $PowerShellHost
    $info.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($key in $Environment.Keys) { $info.EnvironmentVariables[$key] = [string]$Environment[$key] }
    return [Diagnostics.Process]::Start($info)
}

$fixture = New-Fixture 'resolve'
$processes = @()
$startGate = $null
$releaseGate = $null
$observationGate = $null
try {
    $repository = Join-Path $fixture 'repo'
    $store = Join-Path $fixture 'store'
    $observationLog = Join-Path $fixture 'observations.log'
    New-Item -ItemType Directory -Path $repository -Force | Out-Null
    Invoke-TestGit $repository @('init', '-q')
    [IO.File]::WriteAllText((Join-Path $repository 'readme.txt'), 'concurrency fixture', [Text.UTF8Encoding]::new($false))
    Invoke-TestGit $repository @('add', '.')
    Invoke-TestGit $repository @('-c', 'user.name=nexus-test', '-c', 'user.email=nexus@test.invalid', 'commit', '-q', '-m', 'init')

    # Seed one existing checkout so every concurrent call takes the observed
    # existing-checkout path which exhibited the production lock starvation.
    $seed = Resolve-AihNexusWorkspaceIdentity -StoreRoot $store -Path $repository

    $startEventName = (Join-Path $fixture ('AihConcurrencyStart-' + [guid]::NewGuid().ToString('N')))
    $releaseEventName = (Join-Path $fixture ('AihConcurrencyRelease-' + [guid]::NewGuid().ToString('N')))
    $observationEventName = (Join-Path $fixture ('AihConcurrencyObservation-' + [guid]::NewGuid().ToString('N')))
    $startGate = Open-AihTestProcessSignal -Path $startEventName
    $releaseGate = Open-AihTestProcessSignal -Path $releaseEventName
    $observationGate = Open-AihTestProcessSignal -Path $observationEventName
    $powerShellHost = (Get-Process -Id $PID).Path

    1..6 | ForEach-Object {
        $processes += Start-ResolveProcess -PowerShellHost $powerShellHost -Root $InstallRoot -Store $store -Repository $repository -StartEvent $startEventName -ReleaseEvent $releaseEventName -ObservationEvent $observationEventName -ObservationLog $observationLog
    }
    $holdStopwatch = [Diagnostics.Stopwatch]::StartNew()
    $null = $startGate.Set()

    Assert-Aih ($observationGate.WaitOne(5000)) 'expensive observation starts deterministically'
    $storeProbe = [Diagnostics.Stopwatch]::StartNew()
    $probeResult = Use-AihIntelligenceLock -StoreRoot $store -Script { 'probe-acquired' }
    $storeProbe.Stop()
    Assert-Aih ($probeResult -eq 'probe-acquired' -and $storeProbe.ElapsedMilliseconds -lt 2000) ("store mutation lock stays available during expensive observation (waited $($storeProbe.ElapsedMilliseconds) ms)")

    # Release after the old store mutex's 30-second deadline. Waiting on the
    # synchronization primitive (with a bounded deadline) avoids scheduling
    # assumptions and guarantees that the legacy timeout is crossed.
    $remainingHoldMs = [Math]::Max(0, 32000 - [int]$holdStopwatch.ElapsedMilliseconds)
    $null = $releaseGate.WaitOne($remainingHoldMs)
    $null = $releaseGate.Set()

    $results = @()
    foreach ($process in $processes) {
        if (-not $process.WaitForExit(60000)) { throw "Resolve child did not exit: PID $($process.Id)" }
        $stdout = $process.StandardOutput.ReadToEnd().Trim()
        $stderr = $process.StandardError.ReadToEnd().Trim()
        $results += [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
    }

    $failures = @($results | Where-Object { $_.ExitCode -ne 0 })
    Assert-Aih ($failures.Count -eq 0) 'six same-workspace resolves survive work longer than the legacy store-lock timeout'
    $identities = @($results | ForEach-Object { $_.Stdout | ConvertFrom-Json })
    Assert-Aih (@($identities | Where-Object { $_.checkoutId -eq $seed.checkoutId -and $_.workspaceId -eq $seed.workspaceId }).Count -eq 6) 'all concurrent consumers receive the same correct identity'
    $observationCount = if (Test-Path -LiteralPath $observationLog) { @(Get-Content -LiteralPath $observationLog).Count } else { 0 }
    Assert-Aih ($observationCount -eq 1) 'equivalent concurrent resolves execute the expensive observation once'

    $checkoutDocument = Get-AihIntCheckoutDocument -StoreRoot $store
    $workspaceDocument = Get-AihIntWorkspaceDocument -StoreRoot $store
    Assert-Aih (@($checkoutDocument.checkouts).Count -eq 1) 'concurrent resolve leaves one valid checkout record'
    Assert-Aih (@($workspaceDocument.workspaces).Count -eq 1 -and @($workspaceDocument.links).Count -eq 1) 'concurrent resolve leaves one workspace and one repository link'

    # The original store mutex contract remains intact on exceptional and
    # abandoned owners; these are separate from resolve-flight coordination.
    $exceptionSurfaced = $false
    try { Use-AihIntelligenceLock -StoreRoot $store -Script { throw 'expected-lock-test-error' } | Out-Null } catch { $exceptionSurfaced = $_.Exception.Message -eq 'expected-lock-test-error' }
    Assert-Aih $exceptionSurfaced 'store lock surfaces an exception from its protected operation'
    $postException = Use-AihIntelligenceLock -StoreRoot $store -Script { 'reacquired' }
    Assert-Aih ($postException -eq 'reacquired') 'store lock releases after an exception'

    $abandonedReadyName = (Join-Path $fixture ('AihConcurrencyAbandoned-' + [guid]::NewGuid().ToString('N')))
    $abandonedReady = Open-AihTestProcessSignal -Path $abandonedReadyName
    $abandonScript = @'
. (Join-Path $env:AIH_TEST_ROOT 'scripts/Workspace.ps1')
. (Join-Path $env:AIH_TEST_ROOT 'tests/ProcessSignal.TestHelpers.ps1')
$ready = (Open-AihTestProcessSignal -Path $env:AIH_TEST_ABANDONED_READY)
Use-AihIntelligenceLock -StoreRoot $env:AIH_TEST_STORE -Script {
    $null = $ready.Set()
    [Environment]::Exit(0)
}
'@
    $abandonProcess = Start-EncodedProcess -PowerShellHost $powerShellHost -ScriptText $abandonScript -Environment @{
        AIH_TEST_ROOT = $InstallRoot; AIH_TEST_STORE = $store; AIH_TEST_ABANDONED_READY = $abandonedReadyName
    }
    $processes += $abandonProcess
    Assert-Aih ($abandonedReady.WaitOne(5000)) 'abandoned-mutex test process acquires the store lock'
    Assert-Aih ($abandonProcess.WaitForExit(5000)) 'abandoned store-lock owner exits without cleanup'
    $afterAbandon = Use-AihIntelligenceLock -StoreRoot $store -Script { 'recovered' }
    Assert-Aih ($afterAbandon -eq 'recovered') 'abandoned store mutex is recovered'
    $abandonedReady.Dispose()

    # Two distinct canonical workspace identities in the same store must be
    # able to enter their expensive flight work concurrently.
    $rootA = Join-Path $fixture 'parallel-a'
    $rootB = Join-Path $fixture 'parallel-b'
    New-Item -ItemType Directory -Force -Path $rootA, $rootB | Out-Null
    $parallelStartName = (Join-Path $fixture ('AihConcurrencyParallelStart-' + [guid]::NewGuid().ToString('N')))
    $parallelReleaseName = (Join-Path $fixture ('AihConcurrencyParallelRelease-' + [guid]::NewGuid().ToString('N')))
    $enteredAName = (Join-Path $fixture ('AihConcurrencyEnteredA-' + [guid]::NewGuid().ToString('N')))
    $enteredBName = (Join-Path $fixture ('AihConcurrencyEnteredB-' + [guid]::NewGuid().ToString('N')))
    $parallelStart = Open-AihTestProcessSignal -Path $parallelStartName
    $parallelRelease = Open-AihTestProcessSignal -Path $parallelReleaseName
    $enteredA = Open-AihTestProcessSignal -Path $enteredAName
    $enteredB = Open-AihTestProcessSignal -Path $enteredBName
    $parallelScript = @'
. (Join-Path $env:AIH_TEST_ROOT 'scripts/Workspace.ps1')
. (Join-Path $env:AIH_TEST_ROOT 'tests/ProcessSignal.TestHelpers.ps1')
$start = (Open-AihTestProcessSignal -Path $env:AIH_TEST_PARALLEL_START)
$entered = (Open-AihTestProcessSignal -Path $env:AIH_TEST_PARALLEL_ENTERED)
$release = (Open-AihTestProcessSignal -Path $env:AIH_TEST_PARALLEL_RELEASE)
try {
    $null = $start.WaitOne()
    $requestStarted = [DateTime]::UtcNow
    Use-AihNexusWorkspaceResolveFlight -StoreRoot $env:AIH_TEST_STORE -ExecutionRoot $env:AIH_TEST_EXECUTION_ROOT -RequestStartedAtUtc $requestStarted -Script {
        $null = $entered.Set()
        $null = $release.WaitOne()
        [pscustomobject]@{ workspaceId = $env:AIH_TEST_EXECUTION_ROOT }
    } | ConvertTo-Json -Compress
}
finally { $start.Dispose(); $entered.Dispose(); $release.Dispose() }
'@
    $parallelA = Start-EncodedProcess -PowerShellHost $powerShellHost -ScriptText $parallelScript -Environment @{
        AIH_TEST_ROOT = $InstallRoot; AIH_TEST_STORE = $store; AIH_TEST_EXECUTION_ROOT = $rootA
        AIH_TEST_PARALLEL_START = $parallelStartName; AIH_TEST_PARALLEL_ENTERED = $enteredAName; AIH_TEST_PARALLEL_RELEASE = $parallelReleaseName
    }
    $parallelB = Start-EncodedProcess -PowerShellHost $powerShellHost -ScriptText $parallelScript -Environment @{
        AIH_TEST_ROOT = $InstallRoot; AIH_TEST_STORE = $store; AIH_TEST_EXECUTION_ROOT = $rootB
        AIH_TEST_PARALLEL_START = $parallelStartName; AIH_TEST_PARALLEL_ENTERED = $enteredBName; AIH_TEST_PARALLEL_RELEASE = $parallelReleaseName
    }
    $processes += $parallelA, $parallelB
    $null = $parallelStart.Set()
    $bothEntered = $enteredA.WaitOne(5000) -and $enteredB.WaitOne(5000)
    $null = $parallelRelease.Set()
    Assert-Aih $bothEntered 'different workspace identities are not serialized by resolve single-flight'
    Assert-Aih ($parallelA.WaitForExit(5000) -and $parallelB.WaitForExit(5000) -and $parallelA.ExitCode -eq 0 -and $parallelB.ExitCode -eq 0) 'different-workspace resolve flights complete successfully'
    $parallelStart.Dispose(); $parallelRelease.Dispose(); $enteredA.Dispose(); $enteredB.Dispose()

    $blockedCoordinationRoot = Join-Path $fixture 'not-a-directory'
    [IO.File]::WriteAllText($blockedCoordinationRoot, 'blocks resolve-flights directory creation')
    $derivedFailureResult = Use-AihNexusWorkspaceResolveFlight -StoreRoot $blockedCoordinationRoot -ExecutionRoot $rootA -RequestStartedAtUtc ([DateTime]::UtcNow) -Script {
        [pscustomobject]@{ workspaceId = 'ws_test'; repositoryId = 'repo_test'; checkoutId = 'checkout_test'; executionRoot = $rootA }
    }
    Assert-Aih ($derivedFailureResult.workspaceId -eq 'ws_test') 'derived coordination write failure does not fail an authoritative resolve result'

    Write-Host "Intelligence concurrency acceptance: $passed assertions passed."
}
finally {
    if ($releaseGate) { $null = $releaseGate.Set() }
    foreach ($process in $processes) {
        if (-not $process.HasExited) { try { $process.Kill() } catch { } }
        $process.Dispose()
    }
    if ($startGate) { $startGate.Dispose() }
    if ($releaseGate) { $releaseGate.Dispose() }
    if ($observationGate) { $observationGate.Dispose() }
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}
