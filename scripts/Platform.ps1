Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Platform abstraction for Nexus.
#
# Every OS-dependent decision in the PowerShell plane lives here so callers
# never branch on $IsWindows themselves. $IsWindows is UNDEFINED in Windows
# PowerShell 5.1 (it would silently evaluate as $false there), so platform
# detection always goes through the .NET RuntimeInformation API, which behaves
# identically under 5.1 and PowerShell 7+ on every supported OS.

function Test-AihIsWindows {
    # Windows PowerShell 5.1 does not define $IsWindows; PowerShell 7+ does.
    # RuntimeInformation is available in both and is authoritative.
    return [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)
}

function Get-AihPlatformName {
    if (Test-AihIsWindows) { return 'windows' }
    if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Linux)) { return 'linux' }
    if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::OSX)) { return 'macos' }
    return 'unknown'
}

function Get-AihLauncherExtension {
    # CLI launchers ship as .cmd batch files on Windows and as extensionless
    # POSIX executables on Linux. Doctor-style checks resolve names through
    # this helper instead of hard-coding either form.
    if (Test-AihIsWindows) { return '.cmd' }
    return ''
}

function Get-AihLayoutLauncherPath {
    param(
        [Parameter(Mandatory = $true)]$Layout,
        [Parameter(Mandatory = $true)][string]$Name
    )

    return Join-Path $Layout.Bin ($Name + (Get-AihLauncherExtension))
}

function Get-AihPowerShellHost {
    param([string]$InstallRoot)

    # The PowerShell host used to run the shared controller plane. Windows
    # keeps Windows PowerShell 5.1 (existing behavior, unchanged). Linux uses
    # the Nexus-managed pinned PowerShell runtime installed by setup.sh, then
    # a system pwsh as fallback, and fails closed with guidance when neither
    # exists.
    if (Test-AihIsWindows) { return 'powershell.exe' }

    if (-not [string]::IsNullOrWhiteSpace($env:AIH_PWSH_HOST)) {
        return $env:AIH_PWSH_HOST
    }
    if (-not [string]::IsNullOrWhiteSpace($InstallRoot)) {
        $pinned = Join-Path (Join-Path (Join-Path (Get-AihInstallRoot $InstallRoot) 'runtime') 'pwsh') 'pwsh'
        if (Test-Path -LiteralPath $pinned -PathType Leaf) { return $pinned }
    }
    $system = Get-Command 'pwsh' -ErrorAction SilentlyContinue
    if ($null -ne $system) { return $system.Source }
    throw 'Nexus requires a PowerShell 7 runtime (pwsh). Run the Nexus installer (./setup.sh) to install the pinned runtime, or install pwsh and re-run it.'
}

function Get-AihNodeArchiveName {
    param(
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][ValidateSet('win-x64', 'win-arm64', 'linux-x64', 'linux-arm64')][string]$Target
    )

    # Single source of truth for pinned Node artifact selection per platform.
    # Windows keeps the ZIP layout, Linux uses the .tar.xz distribution; both
    # are covered by the same SHASUMS256.txt manifest published with the
    # release.
    $extension = if ($Target -like 'win-*') { 'zip' } else { 'tar.xz' }
    return "node-v" + $Version + "-" + $Target + "." + $extension
}

function Get-AihNodeRelativeExecutable {
    # Path of the node executable inside the extracted distribution, relative
    # to the runtime node directory.
    if (Test-AihIsWindows) { return 'node.exe' }
    return Join-Path 'bin' 'node'
}

function ConvertTo-AihSafeSyncName {
    param([Parameter(Mandatory = $true)][string]$Name)

    # Cross-process mutex names must be valid on every platform. Windows
    # session-namespace names ('Local/...') keep working unchanged; on other
    # platforms the name is hex-encoded so it never contains reserved or
    # path-like characters.
    if (Test-AihIsWindows) { return $Name }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Name)
    $builder = [System.Text.StringBuilder]::new()
    foreach ($byte in $bytes) { $null = $builder.Append($byte.ToString('x2')) }
    return $builder.ToString()
}

function Start-AihDetachedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory,
        [string]$RedirectStandardOutput,
        [string]$RedirectStandardError,
        [switch]$Wait
    )

    # Detached child spawn with optional per-stream log redirection and an
    # optional blocking wait. -WindowStyle is a Windows-only UI concept and is
    # rejected by Start-Process on Linux; every other parameter behaves
    # identically, so the Windows invocation is preserved exactly. Argument
    # arrays are passed as arrays so arguments containing spaces stay intact.
    if (Test-AihIsWindows) {
        if ($RedirectStandardOutput -and $RedirectStandardError) {
            return Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $RedirectStandardOutput -RedirectStandardError $RedirectStandardError -Wait:$Wait -PassThru
        }
        return Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -Wait:$Wait -PassThru
    }
    if ($RedirectStandardOutput -and $RedirectStandardError) {
        return Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $RedirectStandardOutput -RedirectStandardError $RedirectStandardError -Wait:$Wait -PassThru
    }
    return Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -Wait:$Wait -PassThru
}

function Open-AihUrlInBrowser {
    param([Parameter(Mandatory = $true)][string]$Url)

    if (Test-AihIsWindows) {
        Start-Process $Url | Out-Null
        return
    }
    $xdgOpen = Get-Command 'xdg-open' -ErrorAction SilentlyContinue
    if ($null -ne $xdgOpen) {
        Start-Process -FilePath $xdgOpen.Source -ArgumentList @($Url) | Out-Null
        return
    }
    # Fail soft: the URL is always printed by the caller, so a headless or
    # unusual desktop environment just needs to copy it manually.
    Write-Warning "No browser opener found (xdg-open missing). Open this URL manually: " + $Url
}

function Get-AihUnixPermissionPlan {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Mode = 'private-tree'
    )

    # Deterministic permission plan for sensitive Nexus state on Linux.
    # Directories become 0700, files 0600. Returned as a plan (path + octal
    # mode) so it can be asserted in tests on any OS; applying the plan is a
    # separate, narrow operation. The target is always a Nexus-owned data
    # path passed by Nexus code, never a user-chosen recursive target.
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    $item = Get-Item -LiteralPath $Path -Force
    $plan = [System.Collections.Generic.List[object]]::new()
    if ($item -isnot [System.IO.DirectoryInfo]) {
        $plan.Add([pscustomobject]@{ Path = $item.FullName; Mode = '600' })
        return ,$plan.ToArray()
    }
    $plan.Add([pscustomobject]@{ Path = $item.FullName; Mode = '700' })
    $stack = [System.Collections.Generic.Stack[System.IO.FileSystemInfo]]::new()
    $stack.Push($item)
    while ($stack.Count -gt 0) {
        $directory = $stack.Pop()
        foreach ($child in $directory.EnumerateFileSystemInfos()) {
            if ($child -is [System.IO.DirectoryInfo]) {
                $plan.Add([pscustomobject]@{ Path = $child.FullName; Mode = '700' })
                $stack.Push($child)
            }
            else {
                $plan.Add([pscustomobject]@{ Path = $child.FullName; Mode = '600' })
            }
        }
    }
    return ,$plan.ToArray()
}

function Protect-AihPrivatePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    # Restrict a sensitive Nexus path to the current user.
    # Windows: unchanged ACL behavior (inheritance stripped, only the current
    # identity keeps access), applied through icacls exactly as before.
    # Linux: deterministic 0700/0600 permission plan applied with chmod.
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    if (Test-AihIsWindows) {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $item = Get-Item -LiteralPath $Path
        if ($item -is [System.IO.DirectoryInfo]) {
            & icacls.exe $Path '/inheritance:r' "/grant:r" ($identity + ':(OI)(CI)F') | Out-Null
        }
        else {
            & icacls.exe $Path '/inheritance:r' "/grant:r" ($identity + ':F') | Out-Null
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to restrict permissions on " + $Path
        }
        return
    }
    $plan = Get-AihUnixPermissionPlan -Path $Path
    if ($plan.Count -eq 0) { return }
    foreach ($entry in $plan) {
        & chmod $entry.Mode $entry.Path 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to restrict permissions on " + $entry.Path
        }
    }
}

function Get-AihLinuxProcessIdentity {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    # Linux process identity read directly from procfs. Get-Process does not
    # reliably populate .Path for processes it did not spawn on Linux, so the
    # tracked-process identity gate reads /proc/<pid>/exe (executable identity)
    # and /proc/<pid>/stat field 22 (start time in clock ticks since boot)
    # instead. Returns $null when the process does not exist or procfs is
    # unavailable.
    $exeLink = '/proc/' + $ProcessId + '/exe'
    $statPath = '/proc/' + $ProcessId + '/stat'
    if (-not (Test-Path -LiteralPath $exeLink) -or -not (Test-Path -LiteralPath $statPath)) { return $null }
    # /proc/<pid>/exe is a symlink to the executable; read its TARGET (never
    # the file content) with readlink, which is part of coreutils on every
    # supported distribution.
    $exeTarget = $null
    try {
        $readlink = (& readlink $exeLink 2>$null)
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($readlink)) { return $null }
        $exeTarget = ([string]$readlink).Trim()
    } catch { return $null }
    # The kernel appends ' (deleted)' to the exe target for unlinked binaries.
    if ($exeTarget.EndsWith(' (deleted)')) {
        $exeTarget = $exeTarget.Substring(0, $exeTarget.Length - ' (deleted)'.Length)
    }
    $stat = $null
    try { $stat = [System.IO.File]::ReadAllText($statPath) } catch { return $null }
    # Field 22 (1-based) is starttime. The comm field (field 2) may contain
    # spaces and parentheses, so parse after the LAST ')'.
    $afterComm = $stat.Substring($stat.LastIndexOf(')') + 1).Trim()
    $fields = $afterComm -split '\s+'
    # Fields after comm start at field 3; starttime is field 22 -> index 19.
    if ($fields.Count -lt 20) { return $null }
    $startTicks = 0
    if (-not [long]::TryParse($fields[19], [ref]$startTicks)) { return $null }
    return [pscustomobject]@{
        Executable = $exeTarget
        StartTimeTicks = $startTicks
    }
}

function Invoke-AihPwshScriptFile {
    # POSIX child-script transport: run a PowerShell script with EXACT argv
    # (ProcessStartInfo.ArgumentList, no shell parsing anywhere) and capture
    # stdout/stderr into files - the same file contract the cmd.exe transport
    # provides on Windows, so callers parse identical artifacts. Windows
    # callers keep their existing cmd.exe transport unchanged.
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$ScriptArguments = @(),
        [Parameter(Mandatory = $true)][string]$StdoutPath,
        [Parameter(Mandatory = $true)][string]$StderrPath,
        [string]$InstallRoot
    )
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = (Get-AihPowerShellHost $InstallRoot)
    foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + @($ScriptArguments)) {
        [void]$info.ArgumentList.Add([string]$argument)
    }
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    [void]$process.WaitForExit()
    [System.IO.File]::WriteAllText($StdoutPath, $stdoutTask.Result, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($StderrPath, $stderrTask.Result, [System.Text.UTF8Encoding]::new($false))
    return $process.ExitCode
}

function Test-AihUnixPathUnderRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Root
    )

    # Platform-correct "is this path inside this root" check using canonical
    # separators and OS-appropriate case sensitivity. Used by verification
    # workspace escape guards so subdirectory working directories resolve on
    # both platforms.
    $separator = [System.IO.Path]::DirectorySeparatorChar
    $normalizedCandidate = $Candidate.Replace([System.IO.Path]::AltDirectorySeparatorChar, $separator).TrimEnd($separator)
    $normalizedRoot = $Root.Replace([System.IO.Path]::AltDirectorySeparatorChar, $separator).TrimEnd($separator)
    if (Test-AihIsWindows) {
        return $normalizedCandidate.StartsWith($normalizedRoot + $separator, [System.StringComparison]::OrdinalIgnoreCase)
    }
    return $normalizedCandidate.StartsWith($normalizedRoot + $separator, [System.StringComparison]::Ordinal)
}
