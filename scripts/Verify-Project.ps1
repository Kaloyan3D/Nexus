[CmdletBinding()]
param(
    [string]$Workspace = (Get-Location).Path,
    [string]$InstallRoot = 'C:\AI-Harness',
    [ValidateSet('all', 'build', 'test', 'typecheck', 'lint', 'integration', 'verify', 'other')]
    [string]$Kind = 'all',
    [switch]$ContinueOnFailure,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Project.ps1')

function ConvertTo-AihArgument {
    param([string]$Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ([regex]::Replace($Value, '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Get-AihExecutableLaunch {
    param([string]$Executable, [string]$WorkingDirectory)

    # Resolve an executable into a launch specification that Process.Start can
    # actually start on Windows. Bare command names (e.g. npm) may resolve to
    # script wrappers (npm.ps1 / npm.cmd) that CreateProcess cannot launch
    # directly with UseShellExecute=false, so script sources are wrapped with
    # their host executable (cmd.exe /c for .cmd/.bat, powershell.exe -File for
    # .ps1). Project-local shims (e.g. node_modules\.bin\*.cmd on PATH) are
    # skipped in favor of the real command source. Returns $null when the
    # executable cannot be resolved to a launchable file.
    $resolvedPath = $null
    if ($Executable -match '[\\/]') {
        $candidate = [System.IO.Path]::GetFullPath((Join-Path $WorkingDirectory $Executable))
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $resolvedPath = $candidate }
    }
    else {
        $workspacePrefix = $WorkingDirectory.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
        $candidates = @(Get-Command $Executable -All -ErrorAction SilentlyContinue | Where-Object { $_.Source })
        $candidates = @($candidates | Where-Object { -not $_.Source.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase) })
        $ranked = @($candidates | Sort-Object @{ Expression = {
            $source = $_.Source
            if ($source -match '\.exe$') { 0 }
            elseif ($source -match '\.(cmd|bat)$') { 1 }
            elseif ($source -match '\.ps1$') { 2 }
            else { 3 }
        } })
        if ($ranked.Count -gt 0) { $resolvedPath = $ranked[0].Source }
    }
    if ([string]::IsNullOrWhiteSpace($resolvedPath)) { return $null }
    if ($resolvedPath -match '\.(cmd|bat)$') {
        return [pscustomobject]@{
            FileName = (Join-Path $env:SystemRoot 'System32\cmd.exe')
            PrefixArguments = @('/d', '/s', '/c')
            Command = $resolvedPath
            WrapCommand = $true
        }
    }
    if ($resolvedPath -match '\.ps1$') {
        return [pscustomobject]@{
            FileName = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
            PrefixArguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $resolvedPath)
            Command = $resolvedPath
            WrapCommand = $false
        }
    }
    return [pscustomobject]@{
        FileName = $resolvedPath
        PrefixArguments = @()
        Command = $resolvedPath
        WrapCommand = $false
    }
}

function Invoke-AihVerificationCommand {
    param([object]$Command)

    $started = [DateTime]::UtcNow
    if (-not $Command.Available) {
        return [pscustomobject]@{ Name = $Command.Name; Kind = $Command.Kind; Status = if ($Command.Required) { 'FAIL' } else { 'SKIP' }; ExitCode = $null; DurationSeconds = 0; Command = $Command.Display; Error = 'Required executable is unavailable.' }
    }
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    if (-not [string]::IsNullOrWhiteSpace($Command.ShellCommand)) {
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command.ShellCommand))
        $info.FileName = 'powershell.exe'
        $info.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
    }
    else {
        $launch = Get-AihExecutableLaunch -Executable $Command.Executable -WorkingDirectory $Command.WorkingDirectory
        if ($null -eq $launch) { throw "Could not resolve executable for launch: $($Command.Executable)" }
        $info.FileName = $launch.FileName
        $quotedArguments = @($Command.Arguments | ForEach-Object { ConvertTo-AihArgument $_ })
        if ($launch.WrapCommand) {
            $inner = ((@('"' + $launch.Command + '"')) + $quotedArguments) -join ' '
            $info.Arguments = '/d /s /c "' + $inner + '"'
        }
        else {
            $info.Arguments = (@($launch.PrefixArguments) + $quotedArguments) -join ' '
        }
    }
    $info.WorkingDirectory = $Command.WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($Command.TimeoutSeconds * 1000)) {
            try { $process.Kill() } catch {}
            $process.WaitForExit()
            $status = 'FAIL'
            $exitCode = $null
            $errorText = "Timed out after $($Command.TimeoutSeconds) seconds."
        }
        else {
            $exitCode = $process.ExitCode
            $status = if ($exitCode -eq 0) { 'PASS' } elseif ($Command.Required) { 'FAIL' } else { 'SKIP' }
            $errorText = $null
        }
        $stdout = $stdoutTask.Result.TrimEnd()
        $stderr = $stderrTask.Result.TrimEnd()
    }
    catch {
        $status = if ($Command.Required) { 'FAIL' } else { 'SKIP' }
        $exitCode = $null
        $stdout = ''
        $stderr = ''
        $errorText = $_.Exception.Message
    }
    finally { $process.Dispose() }
    [pscustomobject]@{
        Name = $Command.Name
        Kind = $Command.Kind
        Status = $status
        ExitCode = $exitCode
        DurationSeconds = [Math]::Round(([DateTime]::UtcNow - $started).TotalSeconds, 3)
        Command = $Command.Display
        WorkingDirectory = $Command.WorkingDirectory
        StandardOutput = $stdout
        StandardError = $stderr
        Error = $errorText
    }
}

$profile = Get-AihProjectProfile -Workspace $Workspace -InstallRoot $InstallRoot
$commands = @($profile.VerificationCommands | Where-Object { $Kind -eq 'all' -or $_.Kind -eq $Kind })
if ($commands.Count -eq 0) { throw "No deterministic verification commands were found for kind '$Kind'. Run aih-detect for details." }
$results = [System.Collections.Generic.List[object]]::new()
foreach ($command in $commands) {
    if (-not $Json) { Write-Host "RUN  [$($command.Kind)] $($command.Name): $($command.Display)" }
    $result = Invoke-AihVerificationCommand $command
    $results.Add($result)
    if (-not $Json) {
        Write-Host "$($result.Status) $($result.Name) ($($result.DurationSeconds)s)"
        if ($result.StandardOutput) { Write-Host $result.StandardOutput }
        if ($result.StandardError) { Write-Host $result.StandardError }
        if ($result.Error) { Write-Host $result.Error }
    }
    if ($result.Status -eq 'FAIL' -and -not $ContinueOnFailure) { break }
}
$failed = @($results | Where-Object Status -eq 'FAIL').Count
$summary = [pscustomobject]@{ Workspace = $profile.Workspace; Kind = $Kind; Passed = @($results | Where-Object Status -eq 'PASS').Count; Failed = $failed; Skipped = @($results | Where-Object Status -eq 'SKIP').Count; Results = @($results) }
if ($Json) { $summary | ConvertTo-Json -Depth 8 }
if ($failed) { exit 1 }
