[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [switch]$ResetManagedSettings
)

# Shared post-provision install composition used by BOTH platform installers
# (scripts/Setup.ps1 on Windows, setup.sh on Linux). Platform installers own
# OS-specific provisioning (runtime download/extraction, npm ci, PATH) and
# then delegate this single source of truth for:
#   - managed settings initialization (preserving user settings on update),
#   - the managed cordis patch sync,
#   - Nexus UI patchers,
#   - agent preset composition from the pinned DSH Code Mode preset,
#   - data directory scaffolding and private-path permissions.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')
$layout = Get-AihLayout $InstallRoot

# Initialize managed settings before any UI patcher reads them. Fresh installs
# have an empty data directory, so Patch-NexusUi must never run before
# settings.yaml exists. Existing user settings are preserved unless the caller
# explicitly requests -ResetManagedSettings.
if ($ResetManagedSettings -or -not (Test-Path -LiteralPath $layout.Settings)) {
    Copy-Item -LiteralPath (Join-Path $layout.Config 'settings.yaml') -Destination $layout.Settings
}
# Phase M2.1 (TASK-0037): migrate additive managed provider configuration into
# the runtime settings document. Fresh installs copied the template above, so
# this is a verified no-op for them; an EXISTING install keeps every user
# value and gains the managed provider routes it is missing (e.g. the Phase M2
# meta-model-api route), and stale Nexus-managed routes upgrade deterministically
# (the M2 standard muse-spark-1.3 route becomes the M2.1
# muse-spark-1.3-contributor route). A structurally invalid Nexus-managed route
# fails the install closed.
. (Join-Path $layout.Scripts 'SettingsMigration.ps1')
$managedSettingsMigration = Sync-AihManagedSettings -TemplatePath (Join-Path $layout.Config 'settings.yaml') -SettingsPath $layout.Settings -ModelRegistryPath $layout.ModelRegistry

# Remove the retired Muse Contributor egress hook from installations upgraded
# from versions that patched the provider adapter in place.
& $layout.Node (Join-Path $layout.Scripts 'Remove-MuseContributorEgressPatch.cjs') $InstallRoot
if ($LASTEXITCODE -ne 0) {
    throw "The retired Muse Contributor provider-egress hook could not be removed."
}

# data/cordis.patch.yml is managed by the installer. Sync it before the Nexus
# patcher inspects composition so upgrades from pre-controller installs see the
# current nexus-controller row instead of failing against stale managed state.
Copy-Item -LiteralPath (Join-Path $layout.Config 'home.cordis.patch.yml') -Destination (Join-Path $layout.Data 'cordis.patch.yml') -Force
Copy-Item -LiteralPath (Join-Path $layout.Config 'Routing-Integrity.cjs') -Destination (Join-Path $layout.Data 'Routing-Integrity.cjs') -Force
& (Join-Path $layout.Scripts 'Patch-ControlRoomUi.ps1') -InstallRoot $InstallRoot
& (Join-Path $layout.Scripts 'Patch-NexusUi.ps1') -InstallRoot $InstallRoot
& $layout.Node (Join-Path $layout.Scripts 'Verify-RoutingIntegrityComposition.mjs') $InstallRoot
if ($LASTEXITCODE -ne 0) { throw 'The composed Web routing-integrity plugin could not be imported.' }

& (Join-Path $layout.Scripts 'Install-ControllerPresets.ps1') -InstallRoot $InstallRoot

# Build every managed Muse file in a staging directory, validate the generated
# composition with DSH's actual !!js YAML schema, then swap the complete preset
# into place with rollback. A failed update therefore cannot publish a mixed-
# version Muse plane.
& (Join-Path $layout.Scripts 'Install-MusePreset.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { throw 'The managed Muse preset could not be installed.' }

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $layout.Credentials) | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $layout.RoutingData 'states') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $layout.CompletionData 'records') | Out-Null
New-Item -ItemType Directory -Force -Path $layout.EvaluationData | Out-Null
# Restrictive permissions on the private state tree: Windows ACL behavior is
# unchanged; Linux applies the deterministic 0700/0600 plan.
Protect-AihPrivatePath -Path $layout.Data
