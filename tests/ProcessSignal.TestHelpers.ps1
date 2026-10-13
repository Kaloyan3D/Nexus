# Test-only, process-shared manual-reset signals. Named EventWaitHandle is
# unavailable on POSIX; an exclusively created marker supplies the same
# one-way publication contract on both platforms. The fixture owner cleans up
# only after children exit. Opening/disposing a signal never resets it.
function Open-AihTestProcessSignal {
    param([Parameter(Mandatory = $true)][string]$Path)
    $signal = [pscustomobject]@{ Path = [IO.Path]::GetFullPath($Path) }
    $signal | Add-Member ScriptMethod Set {
        try {
            $stream = [IO.File]::Open($this.Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
            $stream.Dispose()
        } catch [IO.IOException] {
            if (-not [IO.File]::Exists($this.Path)) { throw }
        }
        return $true
    }
    $signal | Add-Member ScriptMethod WaitOne {
        param([int]$TimeoutMilliseconds = -1)
        $boundedTimeout = if ($TimeoutMilliseconds -lt 0) { 120000 } else { $TimeoutMilliseconds }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while (-not [IO.File]::Exists($this.Path)) {
            if ($clock.ElapsedMilliseconds -ge $boundedTimeout) {
                if ($TimeoutMilliseconds -lt 0) { throw "Test process signal timed out: $($this.Path)" }
                return $false
            }
            [Threading.Thread]::Sleep([Math]::Min(10, [Math]::Max(1, $boundedTimeout - [int]$clock.ElapsedMilliseconds)))
        }
        return $true
    }
    $signal | Add-Member ScriptMethod Dispose { }
    return $signal
}
