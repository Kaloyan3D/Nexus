[CmdletBinding()]
param(
    [string]$InstallRoot,
    [switch]$SkipPathUpdate,
    [switch]$ResetManagedSettings,
    [switch]$SkipDependencyInstall,
    [switch]$SkipSkillsInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = $sourceRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $PSScriptRoot 'Common.ps1')
$layout = Get-AihLayout $InstallRoot
$sourceVersions = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'config/versions.json') | ConvertFrom-Json

function Copy-AihSourceFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $resolvedSource = [System.IO.Path]::GetFullPath($Source)
    $destinationPath = if (Test-Path -LiteralPath $Destination -PathType Container) {
        Join-Path $Destination ([System.IO.Path]::GetFileName($Source))
    }
    else { $Destination }
    $resolvedDestination = [System.IO.Path]::GetFullPath($destinationPath)
    if ($resolvedSource -eq $resolvedDestination) { return }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

foreach ($directory in @($layout.Root, $layout.App, $layout.Bin, $layout.Config, $layout.Data, $layout.Logs, $layout.Runtime, $layout.Scripts)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

# Persist the installation source root (TASK-0030 updater root-resolution
# contract): Update.ps1 resolves its update source from this metadata when
# no explicit -SourceRoot is passed and the running tree is not itself a
# source checkout.
[System.IO.File]::WriteAllText((Join-Path $layout.Data 'install-source-root'), $sourceRoot + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

foreach ($name in @('setup.ps1', 'README.md', 'SECURITY.md', '.gitignore', '.gitattributes', '.env.example')) {
    Copy-AihSourceFile -Source (Join-Path $sourceRoot $name) -Destination (Join-Path $layout.Root $name)
}
New-Item -ItemType Directory -Force -Path (Join-Path $layout.Root 'docs') | Out-Null
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'docs') -File -ErrorAction SilentlyContinue) {
    Copy-AihSourceFile -Source $file.FullName -Destination (Join-Path $layout.Root 'docs')
}

foreach ($name in @('versions.json', 'settings.yaml', 'home.cordis.patch.yml', 'delegation-block.yml', 'preset.yml', 'preset-deepseek.yml', 'preset-muse.yml', 'DeepSeek-Isolation.cjs', 'Engineering-Isolation.cjs', 'Muse-Isolation.cjs', 'Muse-ReasoningGovernor.cjs', 'Muse-ReasoningRuntime.cjs', 'Muse-ReasoningSignals.cjs', 'Muse-ReasoningActivity.cjs', 'Controller-RequestBoundary.cjs', 'Routing-Integrity.cjs', 'AihController.cjs', 'ContextCompaction.cjs', 'deepseek-agent.cordis.yml', 'routing-policy.json', 'engineering-profiles.json', 'nexus-profiles.json', 'muse-profiles.json', 'model-registry.json', 'Engineering-Profiles.cjs')) {
    Copy-AihSourceFile -Source (Join-Path $sourceRoot "config\$name") -Destination (Join-Path $layout.Config $name)
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'scripts') -File | Where-Object Extension -in @('.ps1', '.mjs', '.cjs')) {
    Copy-AihSourceFile -Source $file.FullName -Destination $layout.Scripts
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'bin') -Filter '*.cmd' -File) {
    Copy-AihSourceFile -Source $file.FullName -Destination $layout.Bin
}
New-Item -ItemType Directory -Force -Path (Join-Path $layout.Root 'tests') | Out-Null
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'tests') -File | Where-Object Extension -in @('.ps1', '.cjs')) {
    Copy-AihSourceFile -Source $file.FullName -Destination (Join-Path $layout.Root 'tests')
}
New-Item -ItemType Directory -Force -Path (Join-Path $layout.Root 'ui') | Out-Null
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'ui') -Recurse -File) {
    $relative = $file.FullName.Substring((Join-Path $sourceRoot 'ui').Length).TrimStart([IO.Path]::DirectorySeparatorChar)
    $target = Join-Path (Join-Path $layout.Root 'ui') $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-AihSourceFile -Source $file.FullName -Destination $target
}
# The canonical global engineering skill pack ships with the install so the
# skill installer below (and re-runs) always have a version-controlled source.
if (Test-Path -LiteralPath (Join-Path $sourceRoot 'skills')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $layout.Root 'skills') | Out-Null
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'skills') -Recurse -File) {
        $relative = $file.FullName.Substring((Join-Path $sourceRoot 'skills').Length).TrimStart([IO.Path]::DirectorySeparatorChar)
        $target = Join-Path (Join-Path $layout.Root 'skills') $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-AihSourceFile -Source $file.FullName -Destination $target
    }
}
Copy-AihSourceFile -Source (Join-Path $sourceRoot 'runtime/package.json') -Destination (Join-Path $layout.Runtime 'package.json')
Copy-AihSourceFile -Source (Join-Path $sourceRoot 'runtime/package-lock.json') -Destination (Join-Path $layout.Runtime 'package-lock.json')
if (Test-Path -LiteralPath (Join-Path $sourceRoot 'runtime/vendor')) {
    $vendorDirectory = Join-Path $layout.Runtime 'vendor'

    New-Item -ItemType Directory -Force -Path $vendorDirectory | Out-Null

    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'runtime/vendor') -File) {
        Copy-AihSourceFile `
            -Source $file.FullName `
            -Destination (Join-Path $vendorDirectory $file.Name)
    }
}

$nodeVersion = $sourceVersions.NodeVersion
$nodeDir = Join-Path $layout.Runtime 'node'
$installedNodeVersion = $null
if (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe')) {
    $installedNodeVersion = (& (Join-Path $nodeDir 'node.exe') --version).TrimStart('v')
}
if ($installedNodeVersion -ne $nodeVersion) {
    $architecture = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
    $archiveName = "node-v$nodeVersion-win-$architecture.zip"
    $releaseBase = "https://nodejs.org/download/release/v$nodeVersion"
    $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("aih-node-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
    try {
        $archivePath = Join-Path $temporaryRoot $archiveName
        $checksumsPath = Join-Path $temporaryRoot 'SHASUMS256.txt'
        Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$archiveName" -OutFile $archivePath
        Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/SHASUMS256.txt" -OutFile $checksumsPath
        $checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match "\s$([regex]::Escape($archiveName))$" } | Select-Object -First 1
        if ($null -eq $checksumLine) {
            throw "Node checksum manifest does not contain $archiveName"
        }
        $expectedHash = ($checksumLine -split '\s+')[0].ToUpperInvariant()
        $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToUpperInvariant()
        if ($actualHash -ne $expectedHash) {
            throw "Node archive checksum mismatch for $archiveName"
        }
        $expanded = Join-Path $temporaryRoot 'expanded'
        Expand-Archive -LiteralPath $archivePath -DestinationPath $expanded
        $payload = Get-ChildItem -LiteralPath $expanded -Directory | Select-Object -First 1
        if ($null -eq $payload -or -not (Test-Path -LiteralPath (Join-Path $payload.FullName 'node.exe'))) {
            throw 'Downloaded Node archive does not contain node.exe'
        }
        if (Test-Path -LiteralPath $nodeDir) {
            Remove-Item -LiteralPath $nodeDir -Recurse -Force
        }
        Move-Item -LiteralPath $payload.FullName -Destination $nodeDir
    }
    finally {
        if (Test-Path -LiteralPath $temporaryRoot) {
            Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
        }
    }
}

Copy-Item -LiteralPath (Join-Path $layout.Runtime 'package.json') -Destination (Join-Path $layout.App 'package.json') -Force
Copy-Item -LiteralPath (Join-Path $layout.Runtime 'package-lock.json') -Destination (Join-Path $layout.App 'package-lock.json') -Force
if (-not $SkipDependencyInstall) {
    & $layout.Npm ci --omit=dev --legacy-peer-deps --prefix $layout.App
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed while installing the pinned Harness runtime.' }
}
elseif (-not (Test-Path -LiteralPath $layout.Dsh)) {
    throw '-SkipDependencyInstall requires an existing installed DSH runtime.'
}

# Complete-Install.ps1 is a PowerShell script, not a native executable: it
& $layout.Node (Join-Path $layout.Scripts 'MusePresetDependencyClosure.cjs') prepare $sourceRoot $InstallRoot | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Muse preset source dependency closure failed.' }

# Complete-Install.ps1 is a PowerShell script, not a native executable: it
# defines no process exit code, and its failures are terminating errors that
# propagate to this caller and abort Setup.ps1. TASK-0032: the old
# native-exit-code read after this invocation was undefined on
# -SkipDependencyInstall runs and stale from the npm call otherwise.
& (Join-Path $layout.Scripts 'Complete-Install.ps1') -InstallRoot $InstallRoot -ResetManagedSettings:$ResetManagedSettings

# Publish the canonical global engineering skills into the user's native
# Agent Skills root (~.agentsskills). Deterministic, idempotent, and
# non-destructive (unrelated skills are preserved; same-name non-Nexus
# skills refuse to be overwritten). -SkipSkillsInstall opts out.
if (-not $SkipSkillsInstall) {
    # Install-NexusSkills.ps1 is a PowerShell script: its failures are
    # terminating errors that propagate to this caller (TASK-0032).
    & (Join-Path $layout.Scripts 'Install-NexusSkills.ps1') -InstallRoot $InstallRoot
}

if (-not $SkipPathUpdate) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($parts -notcontains $layout.Bin) {
        [Environment]::SetEnvironmentVariable('Path', (($parts + $layout.Bin) -join ';'), 'User')
    }
}

Write-Host "AI Harness installed at $($layout.Root)"
Write-Host "Next: $($layout.Bin)\aih-key.cmd"
Write-Host "Then open a new terminal in any repository and run: aih"
