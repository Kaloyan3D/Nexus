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
$sourceVersions = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'config\versions.json') | ConvertFrom-Json

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

foreach ($name in @('setup.ps1', 'README.md', 'SECURITY.md', '.gitignore', '.gitattributes', '.env.example')) {
    Copy-AihSourceFile -Source (Join-Path $sourceRoot $name) -Destination (Join-Path $layout.Root $name)
}
New-Item -ItemType Directory -Force -Path (Join-Path $layout.Root 'docs') | Out-Null
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'docs') -File -ErrorAction SilentlyContinue) {
    Copy-AihSourceFile -Source $file.FullName -Destination (Join-Path $layout.Root 'docs')
}

foreach ($name in @('versions.json', 'settings.yaml', 'home.cordis.patch.yml', 'delegation-block.yml', 'preset.yml', 'preset-deepseek.yml', 'DeepSeek-Isolation.cjs', 'Engineering-Isolation.cjs', 'AihController.cjs', 'deepseek-agent.cordis.yml', 'routing-policy.json', 'engineering-profiles.json', 'model-registry.json', 'Engineering-Profiles.cjs')) {
    Copy-AihSourceFile -Source (Join-Path $sourceRoot "config\$name") -Destination (Join-Path $layout.Config $name)
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'scripts') -File | Where-Object Extension -in @('.ps1', '.mjs')) {
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
Copy-AihSourceFile -Source (Join-Path $sourceRoot 'runtime\package.json') -Destination (Join-Path $layout.Runtime 'package.json')
Copy-AihSourceFile -Source (Join-Path $sourceRoot 'runtime\package-lock.json') -Destination (Join-Path $layout.Runtime 'package-lock.json')

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

# Initialize managed settings before any UI patcher reads them. Fresh repo-local
# installs have an empty data directory, so Patch-NexusUi must never run before
# data\settings.yaml exists. Existing user settings are preserved unless the
# caller explicitly requests -ResetManagedSettings.
if ($ResetManagedSettings -or -not (Test-Path -LiteralPath $layout.Settings)) {
    Copy-Item -LiteralPath (Join-Path $layout.Config 'settings.yaml') -Destination $layout.Settings
}

# data\cordis.patch.yml is managed by this installer. Sync it before the Nexus
# patcher inspects composition so upgrades from pre-controller installs see the
# current nexus-controller row instead of failing against stale managed state.
Copy-Item -LiteralPath (Join-Path $layout.Config 'home.cordis.patch.yml') -Destination (Join-Path $layout.Data 'cordis.patch.yml') -Force
& (Join-Path $layout.Scripts 'Patch-ControlRoomUi.ps1') -InstallRoot $InstallRoot
& (Join-Path $layout.Scripts 'Patch-NexusUi.ps1') -InstallRoot $InstallRoot

$shippedPreset = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh\config\agent-presets\code'
$targetPreset = Join-Path $layout.Data '.agent-presets\aih-engineering'
if (-not (Test-Path -LiteralPath (Join-Path $shippedPreset 'agent.cordis.yml'))) {
    throw "Pinned Harness does not contain the expected Code Mode preset: $shippedPreset"
}
New-Item -ItemType Directory -Force -Path $targetPreset | Out-Null
$presetText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $shippedPreset 'agent.cordis.yml')
$personaPattern = '(?ms)^- id: persona\r?\n.*?(?=^- id: agent-instructions)'
$personaReplacement = @'
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: !!js process.env.AIH_PERSONA ?? 'You are the DeepSeek implementation agent. Complete the supplied bounded task using repository-local instructions and relevant context. Use targeted verification and return structured evidence. The deterministic controller owns routing, retries, budgets, escalation, completion, and automatic Visual Review. Never discover or invoke Visual Review through the skill catalog. If blocked, return one scoped escalation with a stable failure signature.'

'@
$delegationPattern = '(?ms)^# [^\r\n]*delegation and workflows[^\r\n]*\r?\n.*?(?=^# [^\r\n]*remaining model-facing rows)'
$delegationReplacement = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $layout.Config 'delegation-block.yml')
$personaMatches = [regex]::Matches($presetText, $personaPattern).Count
$delegationMatches = [regex]::Matches($presetText, $delegationPattern).Count
if ($personaMatches -ne 1 -or $delegationMatches -ne 1) {
    throw "Pinned Code Mode preset structure changed (persona matches: $personaMatches; delegation matches: $delegationMatches). Refusing an unsafe transform."
}
$presetText = [regex]::Replace($presetText, $personaPattern, $personaReplacement)
$presetText = [regex]::Replace($presetText, $delegationPattern, $delegationReplacement)
[System.IO.File]::WriteAllText((Join-Path $targetPreset 'agent.cordis.yml'), $presetText, [System.Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $layout.Config 'preset.yml') -Destination (Join-Path $targetPreset 'preset.yml') -Force

$deepSeekPreset = Join-Path $layout.Data '.agent-presets\aih-deepseek'
New-Item -ItemType Directory -Force -Path $deepSeekPreset | Out-Null
& (Join-Path $layout.Scripts 'Build-DeepSeekPreset.ps1') -EngineeringPresetPath (Join-Path $targetPreset 'agent.cordis.yml') -DeepSeekPresetPath (Join-Path $deepSeekPreset 'agent.cordis.yml')
Copy-Item -LiteralPath (Join-Path $layout.Config 'preset-deepseek.yml') -Destination (Join-Path $deepSeekPreset 'preset.yml') -Force
Copy-Item -LiteralPath (Join-Path $layout.Config 'DeepSeek-Isolation.cjs') -Destination (Join-Path $deepSeekPreset 'DeepSeek-Isolation.cjs') -Force
& (Join-Path $layout.Scripts 'Enable-EngineeringIsolation.ps1') -PresetDirectory $targetPreset
Copy-Item -LiteralPath (Join-Path $layout.Config 'Engineering-Isolation.cjs') -Destination (Join-Path $targetPreset 'Engineering-Isolation.cjs') -Force
foreach ($presetDirectory in @($targetPreset, $deepSeekPreset)) {
    Copy-Item -LiteralPath (Join-Path $layout.Config 'AihController.cjs') -Destination (Join-Path $presetDirectory 'AihController.cjs') -Force
    Copy-Item -LiteralPath (Join-Path $layout.Config 'Engineering-Profiles.cjs') -Destination (Join-Path $presetDirectory 'Engineering-Profiles.cjs') -Force
    $presetFile = Join-Path $presetDirectory 'agent.cordis.yml'
    $presetText = Get-Content -Raw -Encoding UTF8 -LiteralPath $presetFile
    if (-not $presetText.Contains('- id: aih-controller')) {
        $controllerRow = @"

- id: aih-controller
  name: './AihController.cjs'
"@
        Add-Content -Path $presetFile -Value $controllerRow -Encoding UTF8
    }
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $layout.Credentials) | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $layout.RoutingData 'states') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $layout.CompletionData 'records') | Out-Null
New-Item -ItemType Directory -Force -Path $layout.EvaluationData | Out-Null
Protect-AihPrivatePath -Path $layout.Data

# Publish the canonical global engineering skills into the user's native
# Agent Skills root (~.agentsskills). Deterministic, idempotent, and
# non-destructive (unrelated skills are preserved; same-name non-Nexus
# skills refuse to be overwritten). -SkipSkillsInstall opts out.
if (-not $SkipSkillsInstall) {
    & (Join-Path $layout.Scripts 'Install-NexusSkills.ps1') -InstallRoot $InstallRoot
    if ($LASTEXITCODE -ne 0) { throw 'Nexus skill installation failed; fix the reported skill source or target conflict and rerun Setup.ps1.' }
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
