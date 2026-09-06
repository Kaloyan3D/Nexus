Set-StrictMode -Version Latest

function Resolve-AihExpectedProfileTargets {
    # Test-only composition helper; every resolution primitive below is the
    # production Routing.ps1 implementation. This centralizes composition,
    # not model/provider semantics.
    param(
        [Parameter(Mandatory=$true)]$Policy,
        [Parameter(Mandatory=$true)]$Profiles,
        [Parameter(Mandatory=$true)]$Registry,
        [string]$Preset='aih-engineering',
        [string]$SettingsPath,
        [string[]]$Roles=@('primaryEngineer','deepEngineer','reviewer')
    )
    $resolvedPreset=Resolve-AihPreset $Policy $Preset
    $activeProfile=Resolve-AihProfile $Policy $resolvedPreset $Profiles $SettingsPath
    $targets=[ordered]@{}
    foreach($role in $Roles){$targets[$role]=Resolve-AihModelTarget $Registry $activeProfile $role}
    return [pscustomobject]@{Preset=$resolvedPreset;Profile=$activeProfile;Targets=[pscustomobject]$targets}
}

# TASK-0026: SOURCE-credential-scan path classification, shared and
# platform-neutral. The runtime directories that may legitimately embed
# credential-shaped text (task descriptions, prompts, evidence) are
# excluded by PATH COMPONENT, never by a separator-specific regex:
# 'data/routing/x.json' and 'data\\routing\\x.json' classify identically
# on Windows and Linux, while real source trees stay inside the scan.
$script:AihSourceScanExcludedComponents = @('.git', 'app', 'runtime', 'data', 'logs', 'nx-chrome-profile', '.ai-harness')

function Test-AihSourceScanPathExcluded {
    param([string]$RelativePath)
    if ([string]::IsNullOrWhiteSpace($RelativePath)) { return $false }
    $components = @($RelativePath -split '[\\/]' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($component in $components) {
        if ($script:AihSourceScanExcludedComponents -contains $component) { return $true }
    }
    return $false
}

function Get-AihSourceScanFiles {
    # Enumerates the SOURCE files of a tree for the credential scan: the
    # same set on both path separator styles (the component test is
    # separator-agnostic), with runtime/state trees and lock metadata
    # excluded and every real source file included.
    param([Parameter(Mandatory = $true)][string]$Root)
    $rootFull = [System.IO.Path]::GetFullPath($Root)
    if (-not $rootFull.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $rootFull += [System.IO.Path]::DirectorySeparatorChar }
    Get-ChildItem -LiteralPath $Root -Recurse -File | Where-Object {
        $relative = $_.FullName
        if ($relative.Length -ge $rootFull.Length -and $relative.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            $relative = $relative.Substring($rootFull.Length)
        }
        -not (Test-AihSourceScanPathExcluded $relative) -and
        $_.Name -notmatch '^(lockfile|LOCK|SingletonLock)$'
    }
}

function Invoke-AihTestFreshProcess {
    # Shared fresh-process test transport (TASK-0025 Class A closure).
    #
    # Runs a PowerShell expression in a NEW PowerShell child process against
    # the ACTIVE Nexus install root. The generated child bootstrap derives the
    # root from AIH_INSTALL_ROOT - the authoritative runtime contract - so a
    # generated executable script body never embeds a literal install root
    # (no legacy C:\AI-Harness assumption) and behaves identically in a
    # source checkout and in the installed tree on any OS. Because no path is
    # interpolated into the script text, spaces and quotes in the install
    # root stay safe. Transport contract: -EncodedCommand (UTF-16LE base64)
    # with a fixed argument vector - no shell string, no Invoke-Expression,
    # exact argument boundaries by construction.
    # The environment change is process-scoped: the parent's AIH_INSTALL_ROOT
    # is restored in the finally block; nothing is persisted anywhere.
    param(
        [Parameter(Mandatory = $true)][string]$PowerShellHost,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$Script
    )
    $bootstrap = ". (Join-Path " + '$env:AIH_INSTALL_ROOT' + " 'scripts/Intelligence.ps1')"
    $scriptText = $bootstrap + '; ' + $Script
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($scriptText))
    $previousRoot = $env:AIH_INSTALL_ROOT
    try {
        $env:AIH_INSTALL_ROOT = [System.IO.Path]::GetFullPath($InstallRoot)
        $output = & $PowerShellHost -NoProfile -NonInteractive -EncodedCommand $encoded
        if ($LASTEXITCODE -ne 0) { throw ("fresh-process check failed: " + ($output -join ' ')) }
        return ($output -join [Environment]::NewLine)
    }
    finally {
        if ($null -eq $previousRoot) { Remove-Item Env:AIH_INSTALL_ROOT -ErrorAction SilentlyContinue }
        else { $env:AIH_INSTALL_ROOT = $previousRoot }
    }
}
