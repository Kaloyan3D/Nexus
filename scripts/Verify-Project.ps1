[CmdletBinding()]
param(
    [string]$Workspace = (Get-Location).Path,
    [string]$InstallRoot,
    [ValidateSet('all', 'build', 'test', 'typecheck', 'lint', 'integration', 'verify', 'other')]
    [string]$Kind = 'all',
    [switch]$ContinueOnFailure,
    [switch]$Json
    ,[string]$TaskId
)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Project.ps1')
. (Join-Path $PSScriptRoot 'OutputDigest.ps1')
. (Join-Path $PSScriptRoot 'ArchitectureRules.ps1')

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
        # Skip project-local shims (e.g. node_modules/.bin). Path comparison
        # case sensitivity follows the platform filesystem.
        $comparison = if (Test-AihIsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
        $candidates = @($candidates | Where-Object { -not $_.Source.StartsWith($workspacePrefix, $comparison) })
        $ranked = @($candidates | Sort-Object @{ Expression = {
            $source = $_.Source
            # Extensionless executables are directly launchable on Linux, so
            # they rank first there; on Windows they remain last.
            if ($source -match '\.exe$') { 0 }
            elseif (-not (Test-AihIsWindows) -and $source -notmatch '\.[a-zA-Z]+$') { 1 }
            elseif ($source -match '\.(cmd|bat)$') { if (Test-AihIsWindows) { 1 } else { 4 } }
            elseif ($source -match '\.ps1$') { 2 }
            else { 3 }
        } })
        if ($ranked.Count -gt 0) { $resolvedPath = $ranked[0].Source }
    }
    if ([string]::IsNullOrWhiteSpace($resolvedPath)) { return $null }
    if ($resolvedPath -match '\.(cmd|bat)$') {
        # Windows-only: batch files need the cmd.exe host. On Linux a .cmd/.bat
        # file is not executable, so resolution should never land here.
        if (-not (Test-AihIsWindows)) { return $null }
        return [pscustomobject]@{
            FileName = (Join-Path $env:SystemRoot 'System32\cmd.exe')
            PrefixArguments = @('/d', '/s', '/c')
            Command = $resolvedPath
            WrapCommand = $true
        }
    }
    if ($resolvedPath -match '\.ps1$') {
        # PowerShell scripts launch through the platform PowerShell host:
        # Windows PowerShell 5.1 at its fixed location on Windows, the Nexus
        # managed (or system) pwsh elsewhere.
        if (Test-AihIsWindows) {
            return [pscustomobject]@{
                FileName = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
                PrefixArguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $resolvedPath)
                Command = $resolvedPath
                WrapCommand = $false
            }
        }
        return [pscustomobject]@{
            FileName = (Get-AihPowerShellHost $InstallRoot)
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
        # TASK-0025 RC5: EVERY result carries the SAME schema. Consumers
        # (the controller bridge, JSON reports) read StandardOutput,
        # StandardError, and WorkingDirectory unconditionally, so an
        # unavailable command must never return an abbreviated object.
        return [pscustomobject]@{
            Name = $Command.Name
            Kind = $Command.Kind
            Status = if ($Command.Required) { 'FAIL' } else { 'SKIP' }
            ExitCode = $null
            DurationSeconds = 0
            StartedAtUtc = $started.ToString('o')
            FinishedAtUtc = [DateTime]::UtcNow.ToString('o')
            Command = $Command.Display
            WorkingDirectory = $Command.WorkingDirectory
            StandardOutput = ''
            StandardError = ''
            Error = 'Required executable is unavailable.'
        }
    }
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    if (-not [string]::IsNullOrWhiteSpace($Command.ShellCommand)) {
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command.ShellCommand))
        # Shell verification commands run through the platform PowerShell host
        # (Windows PowerShell 5.1 on Windows, the Nexus pinned pwsh elsewhere).
        $info.FileName = (Get-AihPowerShellHost $InstallRoot)
        $info.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
    }
    else {
        $launch = Get-AihExecutableLaunch -Executable $Command.Executable -WorkingDirectory $Command.WorkingDirectory
        if ($null -eq $launch) { throw "Could not resolve executable for launch: $($Command.Executable)" }
        $info.FileName = $launch.FileName
        if (Test-AihIsWindows) {
            # Windows: CreateProcess argument-string semantics with
            # CreateProcess quoting rules (unchanged behavior).
            $quotedArguments = @($Command.Arguments | ForEach-Object { ConvertTo-AihArgument $_ })
            if ($launch.WrapCommand) {
                $inner = ((@('"' + $launch.Command + '"')) + $quotedArguments) -join ' '
                $info.Arguments = '/d /s /c "' + $inner + '"'
            }
            else {
                $info.Arguments = (@($launch.PrefixArguments) + $quotedArguments) -join ' '
            }
        }
        else {
            # Linux: argv is passed directly through ArgumentList, so spaces
            # and quotes inside arguments are preserved exactly without any
            # shell-level quoting.
            foreach ($argument in @($launch.PrefixArguments) + @($Command.Arguments)) {
                $info.ArgumentList.Add([string]$argument)
            }
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
        StartedAtUtc = $started.ToString('o')
        FinishedAtUtc = [DateTime]::UtcNow.ToString('o')
        Command = $Command.Display
        WorkingDirectory = $Command.WorkingDirectory
        StandardOutput = $stdout
        StandardError = $stderr
        Error = $errorText
    }
}

$projectProfile = Get-AihProjectProfile -Workspace $Workspace -InstallRoot $InstallRoot
$commands = @($projectProfile.VerificationCommands | Where-Object { $Kind -eq 'all' -or $_.Kind -eq $Kind })
if ($commands.Count -eq 0) { throw "No deterministic verification commands were found for kind '$Kind'. Run aih-detect for details." }
$results = [System.Collections.Generic.List[object]]::new()
foreach ($command in $commands) {
    if (-not $Json) { Write-Host "RUN  [$($command.Kind)] $($command.Name): $($command.Display)" }
    $result = Invoke-AihVerificationCommand $command
    if (-not [string]::IsNullOrWhiteSpace($TaskId) -and (($result.StandardOutput.Length + $result.StandardError.Length) -gt 8000)) {
        $raw = @($result.StandardOutput, $result.StandardError) -join [Environment]::NewLine
        $digestKind = if ($result.Kind -in @('test','build','typecheck','lint')) { $result.Kind } else { 'other' }
        $digest = New-AihOutputDigest -Workspace $projectProfile.Workspace -TaskId $TaskId -Kind $digestKind -RawOutput $raw -ExitCode $(if ($result.Status -eq 'PASS') { 0 } else { 1 })
        $result.StandardOutput = $digest.summary
        $result.StandardError = ''
        $result | Add-Member -NotePropertyName RawOutputPath -NotePropertyValue $digest.rawPath
    }
    $results.Add($result)
    if (-not $Json) {
        Write-Host "$($result.Status) $($result.Name) ($($result.DurationSeconds)s)"
        if ($result.StandardOutput) { Write-Host $result.StandardOutput }
        if ($result.StandardError) { Write-Host $result.StandardError }
        if ($result.Error) { Write-Host $result.Error }
    }
    if ($result.Status -eq 'FAIL' -and -not $ContinueOnFailure) { break }
}
$architecture = Invoke-AihArchitectureRules $projectProfile.Workspace
if ($Kind -in @('all','verify')) {
    $archStarted = [DateTime]::UtcNow
    $results.Add([pscustomobject]@{ Name='architecture:rules'; Kind='verify'; Status=$architecture.status; ExitCode=if($architecture.status -eq 'PASS'){0}else{1}; DurationSeconds=0; StartedAtUtc=$archStarted.ToString('o'); FinishedAtUtc=[DateTime]::UtcNow.ToString('o'); Command='aih-rules'; WorkingDirectory=$projectProfile.Workspace; StandardOutput=($architecture | ConvertTo-Json -Depth 8 -Compress); StandardError=''; Error=$null })
}
$failed = @($results | Where-Object Status -eq 'FAIL').Count
$summary = [pscustomobject]@{ Workspace = $projectProfile.Workspace; Kind = $Kind; Passed = @($results | Where-Object Status -eq 'PASS').Count; Failed = $failed; Skipped = @($results | Where-Object Status -eq 'SKIP').Count; Results = @($results) }
if ($Json) { $summary | ConvertTo-Json -Depth 8 }
if ($failed) { exit 1 }
