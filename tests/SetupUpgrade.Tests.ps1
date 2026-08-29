[CmdletBinding()]
param([string]$InstallRoot = 'C:\AI-Harness')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$setupPath = Join-Path $InstallRoot 'scripts\Setup.ps1'
if (-not (Test-Path -LiteralPath $setupPath)) {
    throw "Setup script missing at $setupPath"
}

$setupText = Get-Content -Raw -Encoding UTF8 -LiteralPath $setupPath
$managedPatchCopyIndex = $setupText.LastIndexOf("home.cordis.patch.yml")
$nexusPatchIndex = $setupText.IndexOf("Patch-NexusUi.ps1")

if ($managedPatchCopyIndex -lt 0) {
    throw 'FAIL: Setup.ps1 no longer syncs the managed home.cordis.patch.yml into data.'
}
if ($nexusPatchIndex -lt 0) {
    throw 'FAIL: Setup.ps1 no longer invokes Patch-NexusUi.ps1.'
}
if ($managedPatchCopyIndex -gt $nexusPatchIndex) {
    throw 'FAIL: managed cordis.patch.yml must be synced before Patch-NexusUi.ps1 so upgrades from stale installs can migrate safely.'
}

Write-Host 'PASS: managed cordis.patch.yml is synced before Nexus UI migration'
