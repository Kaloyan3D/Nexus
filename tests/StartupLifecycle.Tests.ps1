$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/Common.ps1')
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/Startup.ps1')
$script:checks = 0
$child = { $script:checks++; if ($script:checks -eq 1) { [pscustomobject]@{ Alive = $true; ExitCode = $null } } else { [pscustomobject]@{ Alive = $false; ExitCode = 9 } } }
$ready = { [pscustomobject]@{ HttpReady = $true; TcpReachable = $true; HttpStatus = 200 } }
$result = Wait-AihWebStartup -ChildStatusProbe $child -ReadinessProbe $ready -PollMilliseconds 1
if ($result.Status -ne 'FAILED' -or $result.ExitCode -ne 9) { throw 'Exited child must not become READY during successful HTTP probe.' }
Write-Host 'PASS: process death during HTTP readiness stays FAILED.'
if (-not (Test-AihIsWindows)) {
    $node = Get-AihNodeExecutable
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('aih-identity-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $scriptPath = Join-Path $tmp 'child.js'
    [IO.File]::WriteAllText($scriptPath, 'setInterval(() => {}, 1000)')
    $process = $null
    try {
        $process = Start-AihDetachedProcess -FilePath $node -ArgumentList @($scriptPath)
        $state = [pscustomobject]@{ Pid = $process.Id; ProcessStartedAtUtc = $process.StartTime.ToUniversalTime().ToString('o') }
        if (-not (Test-AihTrackedProcessIdentity -Process $process -State $state -ExpectedExecutable $node)) { throw 'Original process identity rejected.' }
        $state.ProcessStartedAtUtc = $process.StartTime.ToUniversalTime().AddMinutes(-5).ToString('o')
        if (Test-AihTrackedProcessIdentity -Process $process -State $state -ExpectedExecutable $node) { throw 'Stale start time was accepted as original process.' }
        Write-Host 'PASS: PID reuse with a different process start time is rejected.'
    }
    finally {
        if ($null -ne $process) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
        Remove-Item $tmp -Recurse -Force
    }
}
