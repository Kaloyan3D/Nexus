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

function Get-AihInstallRoot {
    # Foundation-layer install-root resolver. Lives in Platform.ps1 (NOT
    # Common.ps1) so Platform.ps1 is independently sourceable: the pinned
    # POSIX PowerShell host resolution below needs this resolver, and a
    # Platform -> Common reference would be an illegal reverse dependency
    # (Common.ps1 sources Platform.ps1 first). Resolution precedence is the
    # single authoritative contract: explicit argument > AIH_INSTALL_ROOT >
    # DSH_HOME > parent of this script's directory.
    param([string]$InstallRoot)

    if (-not [string]::IsNullOrWhiteSpace($InstallRoot)) {
        return [System.IO.Path]::GetFullPath($InstallRoot)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:AIH_INSTALL_ROOT)) {
        return [System.IO.Path]::GetFullPath($env:AIH_INSTALL_ROOT)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
        return [System.IO.Path]::GetFullPath((Split-Path -Parent $env:DSH_HOME))
    }
    return [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
}

function Get-AihPersistedSourceRoot {
    # TASK-0030: reads the installation source metadata the installers persist
    # (data/install-source-root) so an installed tree remembers WHERE its
    # source checkout lives. Returns $null when the metadata is absent or
    # blank; validity (positive checkout identification) is the caller's
    # contract, enforced by Resolve-AihUpdateRoots.
    param([Parameter(Mandatory = $true)][string]$InstallRoot)

    $metadataPath = Join-Path $InstallRoot 'data/install-source-root'
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { return $null }
    $value = [string](Get-Content -Raw -LiteralPath $metadataPath)
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    return $value.Trim()
}

function Test-AihNexusSourceCheckout {
    # TASK-0030: POSITIVE identification of a Nexus source checkout, required
    # before the updater may treat a tree as its own update source (and before
    # a same-root resolution may proceed). A checkout is identified by TREE
    # CONTENT, never by OS or path shape: the bin/linux POSIX twin templates
    # exist in every checkout and in NO installed layout (Get-AihLauncherLayout
    # calls that plane 'source'), and the completeness markers both installers
    # gate on are present.
    param([string]$Root)

    if ([string]::IsNullOrWhiteSpace($Root)) { return $false }
    $fullRoot = $null
    try { $fullRoot = [System.IO.Path]::GetFullPath($Root) } catch { return $false }
    if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) { return $false }
    $layout = Get-AihLauncherLayout -InstallRoot $fullRoot
    if ($layout.Kind -ne 'source') { return $false }
    foreach ($marker in @('setup.sh', 'config/versions.json', 'scripts/Common.ps1', 'scripts/Setup.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $fullRoot $marker) -PathType Leaf)) { return $false }
    }
    return $true
}

function Resolve-AihUpdateRoots {
    # TASK-0030: the single authoritative updater root-resolution contract.
    #   InstallRoot: explicit argument > AIH_INSTALL_ROOT (the value the
    #                installed launchers export) > StructuralRoot (the tree
    #                the invoking Update.ps1 itself belongs to).
    #   SourceRoot:  explicit argument > persisted installation source
    #                metadata under the RESOLVED install root > StructuralRoot,
    #                ONLY when positively identified as a Nexus source
    #                checkout. An explicit -SourceRoot therefore NEVER
    #                retargets the installation root.
    #   Same-root:   SourceRoot == InstallRoot fails closed unless that tree
    #                is a positively identified source plane (the Windows
    #                checkout layout and an in-place checkout update). This is
    #                what keeps 'aih-update -SourceRoot <install>' from
    #                reinstalling a Nexus installation onto itself.
    param(
        [string]$InstallRoot,
        [string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$StructuralRoot
    )

    $installOrigin = 'structural'
    $resolvedInstall = [System.IO.Path]::GetFullPath($StructuralRoot)
    if (-not [string]::IsNullOrWhiteSpace($InstallRoot)) {
        $resolvedInstall = [System.IO.Path]::GetFullPath($InstallRoot)
        $installOrigin = 'explicit'
    }
    elseif (-not [string]::IsNullOrWhiteSpace($env:AIH_INSTALL_ROOT)) {
        $resolvedInstall = [System.IO.Path]::GetFullPath($env:AIH_INSTALL_ROOT)
        $installOrigin = 'environment'
    }

    $resolvedSource = $null
    $sourceOrigin = $null
    if (-not [string]::IsNullOrWhiteSpace($SourceRoot)) {
        $resolvedSource = [System.IO.Path]::GetFullPath($SourceRoot)
        $sourceOrigin = 'explicit'
    }
    else {
        $persistedSource = Get-AihPersistedSourceRoot -InstallRoot $resolvedInstall
        if (-not [string]::IsNullOrWhiteSpace($persistedSource)) {
            if (-not (Test-AihNexusSourceCheckout -Root $persistedSource)) {
                throw ("Nexus update: the persisted install source metadata under '" + $resolvedInstall + "/data/install-source-root' points at '" + $persistedSource + "', which is not a positively identified Nexus source checkout. Re-run the Nexus installer from the source checkout, or pass -SourceRoot explicitly.")
            }
            $resolvedSource = [System.IO.Path]::GetFullPath($persistedSource)
            $sourceOrigin = 'metadata'
        }
        elseif (Test-AihNexusSourceCheckout -Root $StructuralRoot) {
            $resolvedSource = [System.IO.Path]::GetFullPath($StructuralRoot)
            $sourceOrigin = 'structural'
        }
        else {
            throw ("Nexus update: cannot determine the update source root. No -SourceRoot was passed, no valid persisted install source metadata exists under '" + $resolvedInstall + "', and '" + $StructuralRoot + "' is not positively identified as a Nexus source checkout. Re-run the Nexus installer from the source checkout, or pass -SourceRoot explicitly.")
        }
    }

    $rootComparison = [System.StringComparison]::Ordinal
    if (Test-AihIsWindows) { $rootComparison = [System.StringComparison]::OrdinalIgnoreCase }
    if ([System.String]::Equals($resolvedSource, $resolvedInstall, $rootComparison)) {
        if (-not (Test-AihNexusSourceCheckout -Root $resolvedSource)) {
            throw ("Nexus update: the source root and the install root both resolve to '" + $resolvedSource + "', which is not positively identified as a Nexus source checkout. Updating a Nexus installation from its own installed tree is refused; pass -SourceRoot pointing at a Nexus source checkout.")
        }
    }

    return [pscustomobject]@{
        SourceRoot        = $resolvedSource
        SourceRootOrigin  = $sourceOrigin
        InstallRoot       = $resolvedInstall
        InstallRootOrigin = $installOrigin
    }
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

function Get-AihLauncherLayout {
    # Explicit launcher-layout abstraction (TASK-0025 Class C).
    #
    # Distinguishes the two layout planes by TREE CONTENT, never by OS alone:
    #   source            - a checkout: bin/*.cmd launchers plus the bin/linux
    #                       POSIX twin templates they mirror. Windows and Linux
    #                       checkouts both look like this.
    #   installed-posix   - a POSIX installation: extensionless executables in
    #                       bin/ and NO bin/linux twin directory (setup.sh
    #                       installs the twins as canonical extensionless
    #                       launchers; a copy with a baked root lands in
    #                       ~/.local/bin).
    #   installed-windows - a Windows installation: bin/*.cmd launchers and no
    #                       bin/linux twin directory.
    #   unknown           - neither plane detected (empty or broken tree).
    # Consumers assert the contract of the plane they actually run against;
    # the Windows checkout keeps its full .cmd -> POSIX twin parity coverage,
    # and an installed POSIX tree is asserted by its OWN launcher contract.
    param([string]$InstallRoot)
    $root = Get-AihInstallRoot $InstallRoot
    $bin = Join-Path $root 'bin'
    $posixTwinDirectory = Join-Path $bin 'linux'
    $hasPosixTwinTemplates = $false
    if (Test-Path -LiteralPath $posixTwinDirectory -PathType Container) {
        $hasPosixTwinTemplates = @(Get-ChildItem -LiteralPath $posixTwinDirectory -Filter '*.sh' -File -ErrorAction SilentlyContinue).Count -gt 0
    }
    $cmdLaunchers = @(Get-ChildItem -LiteralPath $bin -Filter '*.cmd' -File -ErrorAction SilentlyContinue)
    $hasExtensionlessLaunchers = Test-Path -LiteralPath (Join-Path $bin 'aih') -PathType Leaf
    $kind = 'unknown'
    if ($hasPosixTwinTemplates) { $kind = 'source' }
    elseif ($hasExtensionlessLaunchers) { $kind = 'installed-posix' }
    elseif ($cmdLaunchers.Count -gt 0) { $kind = 'installed-windows' }
    return [pscustomobject]@{
        Kind                      = $kind
        Bin                       = $bin
        PosixTwinDirectory        = $posixTwinDirectory
        HasPosixTwinTemplates     = $hasPosixTwinTemplates
        WindowsLauncherCount      = $cmdLaunchers.Count
        HasExtensionlessLaunchers = $hasExtensionlessLaunchers
    }
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
    # The pinned-runtime probe resolves through the FULL install-root chain
    # (explicit argument > AIH_INSTALL_ROOT > DSH_HOME > parent of this
    # script's directory), so every Nexus-owned POSIX process prefers the
    # setup.sh-installed runtime even when the caller has no explicit root
    # (TASK-0025 Class B: Engineering/Execution.ps1 passes no root). An
    # explicit AIH_PWSH_HOST still wins, and a system pwsh remains the last
    # fallback before failing closed.
    # TASK-0026: the pinned pwsh probe resolves through the TOOLCHAIN root so
    # a fixture InstallRoot still finds the real Nexus PowerShell runtime.
    $pinned = Join-Path (Join-Path (Join-Path (Get-AihNexusToolchainRoot -InstallRoot $InstallRoot) 'runtime') 'pwsh') 'pwsh'
    if (Test-Path -LiteralPath $pinned -PathType Leaf) { return $pinned }
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

function Get-AihNexusToolchainRoot {
    # TASK-0026: the Nexus TOOLCHAIN root (the tree that owns runtime/ - the
    # pinned Node and PowerShell distributions) is formally distinct from the
    # LOGICAL InstallRoot (the tree that owns config/data/scripts identity).
    # Isolated test fixtures legitimately model config/data-only InstallRoots
    # with no runtime at all, and on a machine without a system Node the
    # Nexus-owned nested children of such a fixture must still resolve the
    # REAL pinned runtime of the Nexus installation that is actually running.
    # Resolution order: the AIH_TOOLCHAIN_ROOT environment anchor (set
    # process-scoped by the harness driver and the controller bridge for the
    # children they spawn), then the tree this file itself is part of (true
    # for both source checkouts and installed trees), then the logical
    # InstallRoot chain. A candidate only wins when its runtime/node
    # directory actually exists; the logical chain is the fallback so
    # callers keep their existing fail-closed behavior.
    param([string]$InstallRoot)
    $candidates = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($env:AIH_TOOLCHAIN_ROOT)) {
        try { $candidates.Add([System.IO.Path]::GetFullPath($env:AIH_TOOLCHAIN_ROOT)) } catch { }
    }
    try { $candidates.Add((Split-Path -Parent $PSScriptRoot)) } catch { }
    try { $candidates.Add((Get-AihInstallRoot $InstallRoot)) } catch { }
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        if (Test-Path -LiteralPath (Join-Path (Join-Path $candidate 'runtime') 'node') -PathType Container) { return $candidate }
    }
    return (Get-AihInstallRoot $InstallRoot)
}

function Get-AihNodeExecutable {
    # Resolves the Node EXECUTABLE Nexus-owned children should run. The
    # TOOLCHAIN root's pinned distribution wins whenever it exists (so a
    # fixture InstallRoot never silently downgrades to ambient tool
    # resolution), the logical layout's pinned path is probed second, and
    # PATH is the last resort before returning $null (callers fail closed).
    param([string]$InstallRoot)
    $relative = Get-AihNodeRelativeExecutable
    $logicalRoot = $null
    try { $logicalRoot = (Get-AihInstallRoot $InstallRoot) } catch { }
    $roots = @((Get-AihNexusToolchainRoot -InstallRoot $InstallRoot), $logicalRoot)
    foreach ($root in $roots) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $candidate = Join-Path (Join-Path (Join-Path $root 'runtime') 'node') $relative
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $name = if (Test-AihIsWindows) { 'node.exe' } else { 'node' }
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
    return $null
}

function Get-AihPinnedNodeDirectory {
    # Directory that contains the Nexus-pinned node executable for THIS
    # platform: the Windows ZIP layout keeps node.exe at the runtime root,
    # the POSIX .tar.xz layout keeps node under bin/. This is the single
    # resolution point for "the Node runtime Nexus owns" (TASK-0025 Class B);
    # callers prepend it to PATH so Nexus-owned children resolve the pinned
    # runtime ahead of any system Node.
    param([string]$InstallRoot)
    # The pinned runtime belongs to the TOOLCHAIN root, never to a logical
    # fixture InstallRoot (TASK-0026): an isolated config/data-only fixture
    # must resolve the real Nexus runtime, never a silent no-op PATH.
    $root = Get-AihNexusToolchainRoot -InstallRoot $InstallRoot
    $runtimeNode = Join-Path (Join-Path $root 'runtime') 'node'
    if (Test-AihIsWindows) { return $runtimeNode }
    return Join-Path $runtimeNode 'bin'
}

function Add-AihPinnedNodeToPath {
    # Nexus-owned child execution environment (TASK-0025 Class B).
    #
    # Prepends the Nexus-pinned Node runtime directory to THIS process's PATH
    # with the platform path separator ([IO.Path]::PathSeparator), so every
    # child this process spawns (node, npm, project verification runners, and
    # their nested children) resolves the pinned runtime first while the
    # pre-existing PATH stays intact behind it. The modification is strictly
    # process-scoped: it is inherited by children, never persisted, and never
    # written to any shell profile. No system Node dependency is introduced:
    # when no pinned runtime is installed at the resolved root the call is a
    # no-op so source checkouts keep their ambient tool resolution.
    param([string]$InstallRoot)
    $pinnedBin = Get-AihPinnedNodeDirectory -InstallRoot $InstallRoot
    if ([string]::IsNullOrWhiteSpace($pinnedBin) -or -not (Test-Path -LiteralPath $pinnedBin -PathType Container)) { return $false }
    $env:PATH = $pinnedBin + [IO.Path]::PathSeparator + $env:PATH
    return $true
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

    if (-not (Test-AihIsWindows)) {
        $helper = Join-Path $PSScriptRoot 'DetachedProcess.js'
        $node = Get-AihNodeExecutable
        if ([string]::IsNullOrWhiteSpace($node)) { throw 'Nexus Node runtime is unavailable for Linux process detachment.' }
        $request = @{
            file = $FilePath
            args = @($ArgumentList)
            wait = [bool]$Wait
            cwd = if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) { $null } else { $WorkingDirectory }
            stdout = if ([string]::IsNullOrWhiteSpace($RedirectStandardOutput)) { $null } else { $RedirectStandardOutput }
            stderr = if ([string]::IsNullOrWhiteSpace($RedirectStandardError)) { $null } else { $RedirectStandardError }
        }
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Compress -Depth 4)))
        $output = & $node $helper $encoded
        $lines = @($output)
        if ($LASTEXITCODE -ne 0 -or $lines.Count -ne 1) {
            throw "Linux detached process launch failed: $($output -join ' ')"
        }
        if ($Wait) {
            $result = $lines[0] | ConvertFrom-Json
            return [pscustomobject]@{ Id = [int]$result.pid; HasExited = $true; ExitCode = [int]$result.exitCode }
        }
        if ([string]$lines[0] -notmatch '^[0-9]+$') { throw "Linux detached process launch returned an invalid PID: $($lines[0])" }
        return [Diagnostics.Process]::GetProcessById([int]$lines[0])
    }

    # Windows retains the existing Start-Process parameter contract.
    $startParams = @{
        FilePath     = $FilePath
        ArgumentList = $ArgumentList
        PassThru     = $true
    }
    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $startParams.WorkingDirectory = $WorkingDirectory
    }
    if (-not [string]::IsNullOrWhiteSpace($RedirectStandardOutput)) {
        $startParams.RedirectStandardOutput = $RedirectStandardOutput
    }
    if (-not [string]::IsNullOrWhiteSpace($RedirectStandardError)) {
        $startParams.RedirectStandardError = $RedirectStandardError
    }
    if ($Wait) {
        $startParams.Wait = $true
    }
    if (Test-AihIsWindows) {
        $startParams.WindowStyle = 'Hidden'
    }
    return Start-Process @startParams
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
    # Dependency fallback links are consumers of app files, not private data.
    # chmod follows links, so neither a linked root nor linked children may
    # enter this ownership-scoped plan (also prevents cycles and repeat walks).
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return @() }
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
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
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
