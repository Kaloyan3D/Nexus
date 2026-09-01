Set-StrictMode -Version Latest

# Engineering.Execution - Phase 3.2.5 thin structured operation layer.
#
# A thin structured layer over the EXISTING sandbox/tool infrastructure. It
# does NOT replace it. Conceptual primitives:
#
#   run_command    { executable, argv[], cwd, timeoutMs }
#   run_powershell { script | scriptPath, argv[], cwd, timeoutMs }
#   run_test       { executable, argv[], cwd, timeoutMs, testTarget }
#
# run_powershell avoids unnecessary chains such as JavaScript string -> shell
# string -> PowerShell parser -> nested quoting -> command when a structured
# representation is possible: the script body is transported as an encoded
# command (UTF-16LE base64), argv is passed through the file payload, never
# re-quoted through shell string layers.
#
# Every execution preserves a structured record: taskId/taskInstanceId,
# attempt, operation, executable, argv, cwd, startedAt/finishedAt/duration,
# exitCode, stdout, stderr, timedOut, failureClassification,
# failureSignature. Credentials are never persisted (redaction).

function Get-AihToolExecutionsPath {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId)
    $run = Get-AihEngineeringRunPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    return (Join-Path $run 'tool-executions.jsonl')
}

function Get-AihTaskAttemptNumber {
    param([string]$Workspace,[string]$TaskId)
    $latest = Get-AihLatestAttempt -Workspace $Workspace -TaskId $TaskId
    if ($null -ne $latest -and $null -ne $latest.PSObject.Properties['sequence']) { return [int]$latest.sequence }
    return 0
}

function ConvertTo-AihWin32Argument {
    # Regex-free Windows command-line argument quoting (canonical algorithm:
    # interior quotes get their preceding backslash run doubled plus one more;
    # trailing backslash runs are doubled). No shell string chains.
    param([string]$Value)
    $quoteChar = [char]34
    $slashChar = [char]92
    if (-not ($Value.Contains(' ') -or $Value.Contains([string]$quoteChar) -or $Value.Contains([string][char]9))) { return $Value }
    $slashRun = 0
    $builder = [Text.StringBuilder]::new()
    foreach ($char in $Value.ToCharArray()) {
        if ($char -eq $slashChar) { $slashRun++; [void]$builder.Append([string]$char); continue }
        if ($char -eq $quoteChar) {
            [void]$builder.Append(([string]$slashChar) * ($slashRun * 2 + 1))
            [void]$builder.Append([string]$char)
            $slashRun = 0
            continue
        }
        $slashRun = 0
        [void]$builder.Append([string]$char)
    }
    if ($slashRun -gt 0) { [void]$builder.Append(([string]$slashChar) * $slashRun) }
    return [string]$quoteChar + $builder.ToString() + [string]$quoteChar
}

function Invoke-AihStructuredOperation {
    # One structured execution + record + classification.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [Parameter(Mandatory=$true)][ValidateSet('run_command','run_powershell','run_test')][string]$Operation,
        [string]$Executable = '',[string[]]$Argv = @(),[string]$Cwd = '',
        [string]$Script = '',[string]$ScriptPath = '',[int]$TimeoutMs = 120000,
        [string]$TestTarget = ''
    )
    if ([string]::IsNullOrWhiteSpace($Cwd)) { $Cwd = [IO.Path]::GetFullPath($Workspace) }
    $startedAt = [DateTime]::UtcNow
    $record = [ordered]@{
        recordVersion = 1
        recordId = [guid]::NewGuid().ToString('N')
        timestampUtc = $startedAt.ToString('o')
        taskId = $TaskId
        taskInstanceId = if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) { $null } else { $TaskInstanceId }
        attempt = (Get-AihTaskAttemptNumber -Workspace $Workspace -TaskId $TaskId)
        operation = $Operation
        executable = $Executable
        argv = @($Argv)
        cwd = $Cwd
        timeoutMs = $TimeoutMs
        scriptPath = $ScriptPath
        startedAtUtc = $startedAt.ToString('o')
        finishedAtUtc = $null
        durationMs = $null
        exitCode = $null
        stdout = ''
        stderr = ''
        timedOut = $false
        failureClassification = $null
        failureSignature = $null
    }

    $fileName = $null
    $arguments = ''
    $executableResolved = $true
    $commandTextForClassification = $Executable + ' ' + (@($Argv) -join ' ')
    $missingPath = ''

    if ($Operation -eq 'run_powershell') {
        $body = $Script
        if (-not [string]::IsNullOrWhiteSpace($ScriptPath)) {
            $absoluteScriptPath = if ([IO.Path]::IsPathRooted($ScriptPath)) { $ScriptPath } else { Join-Path $Cwd $ScriptPath }
            if (-not (Test-Path -LiteralPath $absoluteScriptPath -PathType Leaf)) {
                $executableResolved = $false
                $missingPath = $absoluteScriptPath
            } else {
                $body = [IO.File]::ReadAllText($absoluteScriptPath)
            }
        }
        if ($executableResolved) {
            $fileName = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
            if (-not (Test-Path -LiteralPath $fileName)) { $fileName = 'powershell.exe' }
            $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
            $argumentList = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$encoded)
            $arguments = $argumentList
        }
    } else {
        if ([string]::IsNullOrWhiteSpace($Executable)) { throw 'run_command/run_test require an executable.' }
        $resolved = $null
        if ($Executable -match '[\/]') {
            $candidate = [IO.Path]::GetFullPath((Join-Path $Cwd $Executable))
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $resolved = $candidate }
        } else {
            $found = @(Get-Command $Executable -ErrorAction SilentlyContinue | Select-Object -First 1)
            if ($found.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace([string]$found[0].Source)) { $resolved = [string]$found[0].Source }
        }
        if ($null -eq $resolved) {
            $executableResolved = $false
            $missingPath = $Executable
        } else {
            $fileName = $resolved
            $arguments = @($Argv)
        }
    }

    $stdoutText = ''
    $stderrText = ''
    $exitCode = $null
    $timedOut = $false

    if (-not $executableResolved) {
        $record.finishedAtUtc = (Get-AihEngineeringUtcNow)
        $record.durationMs = [int](([DateTime]::UtcNow) - $startedAt).TotalMilliseconds
        $record.exitCode = $null
        $record.stderr = "executable or script not found: $missingPath"
        $record.failureClassification = if ($Operation -eq 'run_powershell' -and -not [string]::IsNullOrWhiteSpace($ScriptPath)) { 'path-not-found' } else { 'executable-not-found' }
        $record.failureSignature = Get-AihFailureSignature -Class $record.failureClassification -Executable $Executable -Detail $missingPath
        Add-AihJsonLine -Path (Get-AihToolExecutionsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) -Value $record
        Record-AihFailure -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Classification $record.failureClassification -Signature $record.failureSignature -Executable $Executable -Detail $missingPath -EvidenceText $record.stderr -Operation $Operation | Out-Null
        return $record
    }

    try {
        $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $processInfo.FileName = $fileName
        if ($arguments -is [string]) { $processInfo.Arguments = $arguments }
        else { $processInfo.Arguments = (@($arguments) | ForEach-Object { ConvertTo-AihWin32Argument $_ }) -join ' ' }
        $processInfo.WorkingDirectory = $Cwd
        $processInfo.UseShellExecute = $false
        $processInfo.CreateNoWindow = $true
        $processInfo.RedirectStandardOutput = $true
        $processInfo.RedirectStandardError = $true
        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $processInfo
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMs)) {
            $timedOut = $true
            try { $process.Kill() } catch { }
        }
        $stdoutText = Redact-AihEngineeringSecrets $stdoutTask.Result
        $stderrText = Redact-AihEngineeringSecrets $stderrTask.Result
        $exitCode = $process.ExitCode
    } catch {
        $stderrText = Redact-AihEngineeringSecrets ([string]$_.Exception.Message)
        $exitCode = $null
    }

    $finishedAt = [DateTime]::UtcNow
    $record.finishedAtUtc = $finishedAt.ToString('o')
    $record.durationMs = [int]($finishedAt - $startedAt).TotalMilliseconds
    $record.exitCode = $exitCode
    $record.stdout = $stdoutText
    $record.stderr = $stderrText
    $record.timedOut = [bool]$timedOut

    if ($timedOut) { $record.failureClassification = 'timeout' }
    elseif ($null -ne $exitCode -and $exitCode -ne 0) {
        $record.failureClassification = Classify-AihFailure -ExitCode $exitCode -TimedOut:$false -StdErr $stderrText -StdOut $stdoutText -CommandText $commandTextForClassification -OperationKind $Operation
    }

    if (-not [string]::IsNullOrEmpty($record.failureClassification)) {
        $record.failureSignature = Get-AihFailureSignature -Class $record.failureClassification -Executable $Executable -Detail $(if ($record.failureClassification -eq 'timeout') { $Executable } else { ($stderrText + ' ' + $stdoutText) })
        Record-AihFailure -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId -Classification $record.failureClassification -Signature $record.failureSignature -Executable $Executable -Detail ($stderrText + ' ' + $stdoutText) -EvidenceText ($stderrText + ' ' + $stdoutText) -Operation $Operation -Hypothesis '' | Out-Null
    }

    Add-AihJsonLine -Path (Get-AihToolExecutionsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) -Value $record
    return $record
}

function Get-AihToolExecutionSnapshot {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $path = Get-AihToolExecutionsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $records = @()
    if (Test-Path -LiteralPath $path) {
        foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $path) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try { $record = $line | ConvertFrom-Json } catch { continue }
            if ($null -eq $record) { continue }
            if (-not (Test-AihEngineeringArtifactIdentity -Artifact $record -TaskInstanceId $TaskInstanceId)) { continue }
            $records += $record
        }
    }
    $failed = @($records | Where-Object { -not [string]::IsNullOrEmpty([string]$_.failureClassification) })
    $byClass = [ordered]@{}
    foreach ($failureRecord in $failed) {
        $class = [string]$failureRecord.failureClassification
        if ($null -ne $byClass.PSObject.Properties[$class]) { $byClass[$class] = [int]$byClass[$class] + 1 }
        else { $byClass[$class] = 1 }
    }
    return [ordered]@{
        executions = $records.Count
        failures = $failed.Count
        byClass = $byClass
        records = @($records)
    }
}
