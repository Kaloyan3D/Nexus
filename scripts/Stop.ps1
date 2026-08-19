[CmdletBinding()]
param([string]$InstallRoot = 'C:\AI-Harness')

. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Startup.ps1')
$layout = Get-AihLayout $InstallRoot

if (-not (Test-Path -LiteralPath $layout.State)) {
    Write-Host 'AI Harness status: STOPPED (no tracked instance)'
    exit 0
}

try { $stateObject = Get-Content -Raw -LiteralPath $layout.State | ConvertFrom-Json }
catch { throw "AI Harness state is unreadable: $($_.Exception.Message)" }
$state = [ordered]@{}
foreach ($property in $stateObject.PSObject.Properties) { $state[$property.Name] = $property.Value }

if ($null -eq $stateObject.Pid) {
    Write-Host 'AI Harness status: STOPPED (state has no tracked PID)'
    exit 0
}

$process = Get-Process -Id ([int]$stateObject.Pid) -ErrorAction SilentlyContinue
if ($null -eq $process) {
    $state['Status'] = 'STOPPED'
    $state['StoppedAtUtc'] = [DateTime]::UtcNow.ToString('o')
    $state['UpdatedAtUtc'] = [DateTime]::UtcNow.ToString('o')
    $state['StopReason'] = 'Tracked process was already absent.'
    Write-AihState -Path $layout.State -State $state
    Write-Host "AI Harness status: STOPPED (tracked PID $($stateObject.Pid) was already absent)"
    exit 0
}

if (-not (Test-AihTrackedProcessIdentity -Process $process -State $stateObject -ExpectedExecutable $layout.Node)) {
    throw "Refusing to stop PID $($stateObject.Pid): it does not match the tracked executable and process start time."
}

Stop-Process -Id $process.Id -Force
$process.WaitForExit(10000) | Out-Null
if (-not $process.HasExited) { throw "Timed out stopping tracked AI Harness PID $($process.Id)." }

$state['Status'] = 'STOPPED'
$state['StoppedAtUtc'] = [DateTime]::UtcNow.ToString('o')
$state['UpdatedAtUtc'] = [DateTime]::UtcNow.ToString('o')
$state['StopReason'] = 'Stopped by aih-stop.'
Write-AihState -Path $layout.State -State $state
Write-Host "AI Harness status: STOPPED (PID $($process.Id))"
