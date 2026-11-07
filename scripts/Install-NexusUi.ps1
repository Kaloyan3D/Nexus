[CmdletBinding()]
param([string]$InstallRoot, [string]$SourceRoot)

# Nexus UI for DSH 0.2.x: supported plugin extension points only.
#
# DSH 0.1.x needed string patches against compiled upstream client bundles
# (Patch-NexusUi.ps1, Patch-NexusComposer.ps1). Those cannot be carried to
# 0.2.x: the bundles are different artifacts, and a string patch on a build
# output is unsupported. This installer publishes only the three Nexus-owned
# plugin packages into the profile module fallback that DSH resolves plugins
# from, and never writes inside node_modules/@deepseek-ai:
#   ui/nexus-ui              -> @nexus/ui-brand      (brand client plugin)
#   ui/nexus-controller      -> @nexus/controller    (host status route + Controller panel)
#   ui/nexus-mode-selector   -> @nexus/mode-selector (new-session mode lifecycle)
# The rows that mount them live in config/home.cordis.patch.yml.
#
# NOT PORTED (cosmetic string patches without a supported equivalent; see the
# migration report): page title/favicon/manifest, runtime brand copy, hero
# headline, sidebar width, primary-action colour, model-badge guard, models
# notice, and the composer preference seat (nexusComposerPreference).

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
if ([string]::IsNullOrWhiteSpace($SourceRoot)) { $SourceRoot = $InstallRoot }
. (Join-Path $PSScriptRoot 'Common.ps1')
$layout = Get-AihLayout $InstallRoot

$packages = @(
    @{ Source = 'ui/nexus-ui';            Name = 'ui-brand';      Required = @('package.json', 'lib/index.js', 'lib/client.js') },
    @{ Source = 'ui/nexus-controller';    Name = 'controller';    Required = @('package.json', 'lib/index.js', 'lib/client.js', 'lib/status.cjs') },
    @{ Source = 'ui/nexus-mode-selector'; Name = 'mode-selector'; Required = @('package.json', 'lib/index.js', 'lib/client.js') }
)
$scope = Join-Path $layout.Data 'profiles/node_modules/@nexus'
New-Item -ItemType Directory -Force -Path $scope | Out-Null
foreach ($package in $packages) {
    $source = Join-Path $SourceRoot $package.Source
    foreach ($required in $package.Required) {
        if (-not (Test-Path -LiteralPath (Join-Path $source $required))) { throw "Nexus UI source is missing: $($package.Source)/$required" }
    }
    $target = Join-Path $scope $package.Name
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
    foreach ($required in $package.Required) {
        if (-not (Test-Path -LiteralPath (Join-Path $target $required))) { throw "Failed to install @nexus/$($package.Name): $required" }
    }
}
Write-Host 'Installed Nexus UI plugins (@nexus/ui-brand, @nexus/controller, @nexus/mode-selector); no upstream bundle was modified.'
