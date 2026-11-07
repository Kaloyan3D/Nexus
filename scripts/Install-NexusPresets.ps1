[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$InstallRoot)

# Nexus agent planes for DSH 0.2.x (replaces Install-ControllerPresets.ps1 and
# Install-MusePreset.ps1, which wrote `.agent-presets/<name>/agent.cordis.yml`
# directories that DSH 0.2.x no longer scans).
#
#   1. Publish each plane's dependency closure (controller, isolation and
#      Muse modules plus pinned assets) to data/.agent-presets/<plane>/
#      atomically, with rollback.
#   2. Regenerate data/cordis.patch.yml (Build-NexusHomePatch.cjs): Nexus
#      plugin rows, provider routes, and the three preset rows.
#   3. Boot the REAL composed profile in-process (Verify-NexusComposition.mjs)
#      and require every plane to mount and no stock preset to exist.
# Any failure restores the previous closures and home patch.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts/Common.ps1')
$layout = Get-AihLayout $InstallRoot
$parent = Join-Path $layout.Data '.agent-presets'
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$closureTool = Join-Path $layout.Scripts 'MusePresetDependencyClosure.cjs'
$token = [guid]::NewGuid().ToString('N')
$planes = @(
    @{ Name = 'aih-engineering'; Profile = 'engineering' },
    @{ Name = 'aih-deepseek';    Profile = 'deepseek' },
    @{ Name = 'aih-muse';        Profile = 'muse' }
)

# The source checkout is the only closure-manifest authority. Installed trees
# consume the manifests that setup staged; a source tree re-prepares them.
if (Test-Path -LiteralPath (Join-Path $InstallRoot '.git')) {
    foreach ($closureProfile in @('', 'engineering', 'deepseek')) {
        $arguments = @($closureTool, 'prepare', $InstallRoot, $InstallRoot)
        if ($closureProfile) { $arguments += $closureProfile }
        & $layout.Node @arguments | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Nexus plane dependency closure preparation failed ($closureProfile)." }
    }
}

$patchPath = Join-Path $layout.Data 'cordis.patch.yml'
$patchBackup = if (Test-Path -LiteralPath $patchPath -PathType Leaf) { [IO.File]::ReadAllBytes($patchPath) } else { $null }
$published = @()
$backedUp = @()
try {
    foreach ($plane in $planes) {
        $stage = Join-Path $parent (".$($plane.Name).stage.$token")
        $plane.Stage = $stage
        $plane.Target = Join-Path $parent $plane.Name
        $plane.Backup = Join-Path $parent (".$($plane.Name).backup.$token")
        New-Item -ItemType Directory -Path $stage | Out-Null
        & $layout.Node $closureTool copy $InstallRoot $stage $plane.Profile | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Dependency closure copy failed for $($plane.Name)." }
    }
    foreach ($plane in $planes) {
        if (Test-Path -LiteralPath $plane.Target) { Move-Item -LiteralPath $plane.Target -Destination $plane.Backup; $backedUp += $plane }
        Move-Item -LiteralPath $plane.Stage -Destination $plane.Target
        $published += $plane
    }
    & $layout.Node (Join-Path $layout.Scripts 'Build-NexusHomePatch.cjs') $InstallRoot
    if ($LASTEXITCODE -ne 0) { throw 'The Nexus home patch could not be generated.' }
    & $layout.Node (Join-Path $layout.Scripts 'Verify-NexusComposition.mjs') $InstallRoot
    if ($LASTEXITCODE -ne 0) { throw 'The composed DSH profile failed verification: a Nexus plane did not mount, or a stock preset is selectable.' }
    foreach ($plane in $backedUp) { Remove-Item -LiteralPath $plane.Backup -Recurse -Force -ErrorAction SilentlyContinue }
    $backedUp = @()
}
catch {
    foreach ($plane in $published) { if (Test-Path -LiteralPath $plane.Target) { Remove-Item -LiteralPath $plane.Target -Recurse -Force } }
    foreach ($plane in $backedUp) { if (Test-Path -LiteralPath $plane.Backup) { Move-Item -LiteralPath $plane.Backup -Destination $plane.Target } }
    if ($null -ne $patchBackup) { [IO.File]::WriteAllBytes($patchPath, $patchBackup) }
    elseif (Test-Path -LiteralPath $patchPath) { Remove-Item -LiteralPath $patchPath -Force }
    throw
}
finally {
    foreach ($plane in $planes) { if ($plane.ContainsKey('Stage') -and (Test-Path -LiteralPath $plane.Stage)) { Remove-Item -LiteralPath $plane.Stage -Recurse -Force -ErrorAction SilentlyContinue } }
}
Write-Host 'Nexus agent planes installed atomically and verified on the real DSH composition.'
