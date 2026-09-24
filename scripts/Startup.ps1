Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-AihState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$State
    )

    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) {
        $null = New-Item -ItemType Directory -Path $directory -Force
    }
    $temporary = Join-Path $directory ('.aih-state-{0}.tmp' -f [Guid]::NewGuid().ToString('N'))
    try {
        [System.IO.File]::WriteAllText($temporary, ($State | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Get-AihLogTail {
    param([string]$Path, [int]$Lines = 30)

    if (-not (Test-Path -LiteralPath $Path)) { return '(log file was not created)' }
    $content = @(Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue)
    if ($content.Count -eq 0) { return '(log is empty)' }
    return ($content -join [Environment]::NewLine)
}

function Get-AihWebProbe {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [string]$StdoutLog,
        [datetime]$NotBeforeUtc = [datetime]::MinValue,
        [int]$TcpTimeoutMilliseconds = 250,
        [int]$HttpTimeoutSec = 2
    )

    $target = [Uri]$Uri
    $tcpReady = $false
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.BeginConnect($target.Host, $target.Port, $null, $null)
        if ($connect.AsyncWaitHandle.WaitOne($TcpTimeoutMilliseconds)) {
            $client.EndConnect($connect)
            $tcpReady = $client.Connected
        }
    }
    catch { $tcpReady = $false }
    finally { $client.Dispose() }

    $httpReady = $false
    $httpStatus = $null
    $httpError = $null
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec $HttpTimeoutSec
        $httpStatus = [int]$response.StatusCode
        $httpReady = $httpStatus -ge 200 -and $httpStatus -lt 400
    }
    catch {
        $httpError = $_.Exception.Message
        $responseProperty = $_.Exception.PSObject.Properties['Response']
        if ($null -ne $responseProperty -and $null -ne $responseProperty.Value) {
            try { $httpStatus = [int]$responseProperty.Value.StatusCode } catch { }
        }
    }

    $stdoutMarker = $false
    if (-not [string]::IsNullOrWhiteSpace($StdoutLog) -and (Test-Path -LiteralPath $StdoutLog)) {
        $log = Get-Item -LiteralPath $StdoutLog
        if ($log.LastWriteTimeUtc -ge $NotBeforeUtc.AddSeconds(-1)) {
            $stdoutMarker = (@(Get-Content -LiteralPath $StdoutLog -Tail 50 -ErrorAction SilentlyContinue) -match 'dsh web:\s+https?://').Count -gt 0
        }
    }

    [pscustomobject]@{
        TcpReachable = $tcpReady
        HttpReady = $httpReady
        HttpStatus = $httpStatus
        HttpError = $httpError
        StdoutMarker = $stdoutMarker
    }
}

function Wait-AihWebStartup {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$ChildStatusProbe,
        [Parameter(Mandatory = $true)][scriptblock]$ReadinessProbe,
        [int]$InitialWindowMilliseconds = 30000,
        [int]$GraceMilliseconds = 90000,
        [int]$PollMilliseconds = 500,
        [scriptblock]$OnStarting
    )

    $timer = [Diagnostics.Stopwatch]::StartNew()
    $startingReported = $false
    $lastProbe = $null
    while ($true) {
        $child = & $ChildStatusProbe
        $lastProbe = & $ReadinessProbe

        # The server may exit while the HTTP request is in flight. Recheck the
        # tracked child before accepting the response from the port.
        $child = & $ChildStatusProbe
        if (-not $child.Alive) {
            return [pscustomobject]@{ Status = 'FAILED'; ElapsedMilliseconds = $timer.ElapsedMilliseconds; ExitCode = $child.ExitCode; Probe = $lastProbe; Reason = 'The DSH child process exited during readiness probing.' }
        }
        if ($lastProbe.HttpReady) {
            return [pscustomobject]@{
                Status = 'READY'; ElapsedMilliseconds = $timer.ElapsedMilliseconds
                ExitCode = $null; Probe = $lastProbe
                Reason = if ($lastProbe.HttpReady) { 'HTTP endpoint returned a successful status.' } else { 'TCP listener is reachable.' }
            }
        }
        if (-not $child.Alive) {
            return [pscustomobject]@{
                Status = 'FAILED'; ElapsedMilliseconds = $timer.ElapsedMilliseconds
                ExitCode = $child.ExitCode; Probe = $lastProbe
                Reason = 'The DSH child process exited before becoming ready.'
            }
        }
        if (-not $startingReported -and $timer.ElapsedMilliseconds -ge $InitialWindowMilliseconds) {
            $startingReported = $true
            if ($null -ne $OnStarting) { & $OnStarting $timer.ElapsedMilliseconds $lastProbe }
        }
        if ($timer.ElapsedMilliseconds -ge ($InitialWindowMilliseconds + $GraceMilliseconds)) {
            return [pscustomobject]@{
                Status = 'STARTING'; ElapsedMilliseconds = $timer.ElapsedMilliseconds
                ExitCode = $null; Probe = $lastProbe
                Reason = 'The child is still alive but TCP/HTTP readiness was not reached within the bounded startup grace period.'
            }
        }
        Start-Sleep -Milliseconds ([Math]::Max(1, $PollMilliseconds))
    }
}

function Get-AihLinuxProcessStartEpoch {
    # Linux: convert a procfs process start time (clock ticks since boot,
    # /proc/<pid>/stat field 22) into a UTC DateTime using the kernel boot
    # time (btime from /proc/stat) and the userspace clock tick rate.
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    $identity = Get-AihLinuxProcessIdentity -ProcessId $ProcessId
    if ($null -eq $identity) { return $null }
    $clkTck = 100  # USER_HZ default on Linux
    try {
        $conf = (& getconf CLK_TCK 2>$null)
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($conf)) { $clkTck = [long]$conf }
    } catch { }
    $btime = $null
    try {
        foreach ($line in [System.IO.File]::ReadAllLines('/proc/stat')) {
            if ($line.StartsWith('btime ')) { $btime = [long]$line.Substring(6).Trim(); break }
        }
    } catch { return $null }
    if ($null -eq $btime -or $clkTck -le 0) { return $null }
    $seconds = [long][Math]::Floor($identity.StartTimeTicks / $clkTck)
    return [DateTimeOffset]::FromUnixTimeSeconds($btime + $seconds).UtcDateTime
}

function Test-AihTrackedProcessIdentity {
    param(
        [Parameter(Mandatory = $true)]$Process,
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutable
    )

    try {
        if ([int]$Process.Id -ne [int]$State.Pid) { return $false }
        if ($null -eq $State.ProcessStartedAtUtc -or [string]::IsNullOrWhiteSpace([string]$State.ProcessStartedAtUtc)) { return $false }
        $expectedStart = ([datetime]$State.ProcessStartedAtUtc).ToUniversalTime()
        if (Test-AihIsWindows) {
            if ([System.IO.Path]::GetFullPath($Process.Path) -ne [System.IO.Path]::GetFullPath($ExpectedExecutable)) { return $false }
            $actualStart = $Process.StartTime.ToUniversalTime()
            return [Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -lt 2
        }
        # Linux: Get-Process does not reliably expose .Path for processes it
        # did not spawn, so executable identity comes from /proc/<pid>/exe and
        # start identity from /proc/<pid>/stat (+ btime). Guarantees stay the
        # same: PID + exact executable + start-time match within tolerance.
        $identity = Get-AihLinuxProcessIdentity -ProcessId $Process.Id
        if ($null -eq $identity) { return $false }
        if ($identity.Executable -ne [System.IO.Path]::GetFullPath($ExpectedExecutable)) { return $false }
        $actualStart = Get-AihLinuxProcessStartEpoch -ProcessId $Process.Id
        if ($null -eq $actualStart) { return $false }
        return [Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -lt 2
    }
    catch { return $false }
}

function Stop-AihTrackedProcess {
    # Platform-aware tracked-process stop for a process Nexus owns.
    # Windows keeps the existing forceful termination unchanged. Linux sends
    # SIGTERM first (clean shutdown for the DSH server and its children) and
    # escalates to SIGKILL only when the process ignores it within the
    # bounded wait. Never used for processes Nexus does not track: callers
    # gate on Test-AihTrackedProcessIdentity first.
    param(
        [Parameter(Mandatory = $true)]$Process,
        [int]$WaitMilliseconds = 10000
    )

    Stop-Process -Id $Process.Id -Force
    if ($Process.WaitForExit($WaitMilliseconds)) { return $true }
    if (-not (Test-AihIsWindows)) {
        try { & kill -9 $Process.Id 2>$null } catch { }
        return [bool]$Process.WaitForExit(5000)
    }
    return $false
}
