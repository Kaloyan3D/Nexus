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

        if ($lastProbe.HttpReady -or $lastProbe.TcpReachable) {
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

function Test-AihTrackedProcessIdentity {
    param(
        [Parameter(Mandatory = $true)]$Process,
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutable
    )

    try {
        if ([int]$Process.Id -ne [int]$State.Pid) { return $false }
        if ([System.IO.Path]::GetFullPath($Process.Path) -ne [System.IO.Path]::GetFullPath($ExpectedExecutable)) { return $false }
        if ($null -eq $State.ProcessStartedAtUtc -or [string]::IsNullOrWhiteSpace([string]$State.ProcessStartedAtUtc)) { return $false }
        $expectedStart = ([datetime]$State.ProcessStartedAtUtc).ToUniversalTime()
        $actualStart = $Process.StartTime.ToUniversalTime()
        return [Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -lt 2
    }
    catch { return $false }
}
