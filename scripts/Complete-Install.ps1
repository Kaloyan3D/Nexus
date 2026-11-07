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

# DSH 0.2.x: the DSH settings plugin imports and RENAMES `$DSH_HOME/settings.yaml`
# the first time it boots (and writes its sections into profile patches). The
# Nexus-owned settings document therefore lives in `data/nexus-settings.yaml`.
# An install upgraded from DSH 0.1.x still has the old name: move it (no copy,
# no content change) so DSH never sees it, preserving every user value. When
# both exist the Nexus document wins and the legacy file is parked, never
# deleted, under a name DSH does not read.
if (Test-Path -LiteralPath $layout.LegacySettings -PathType Leaf) {
    if (-not (Test-Path -LiteralPath $layout.Settings)) {
        Move-Item -LiteralPath $layout.LegacySettings -Destination $layout.Settings
        Write-Host 'Migrated data/settings.yaml to data/nexus-settings.yaml (DSH 0.2.x would rename the old name).'
    }
    else {
        $parked = $layout.LegacySettings + '.pre-dsh-0.2.' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
        Move-Item -LiteralPath $layout.LegacySettings -Destination $parked
        Write-Host "Parked the legacy data/settings.yaml as $([IO.Path]::GetFileName($parked))."
    }
}

# Initialize managed settings before any UI patcher reads them. Fresh installs
# have an empty data directory, so the Nexus UI/preset installers must never run before
# nexus-settings.yaml exists. Existing user settings are preserved unless the caller
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

# TASK-0009 (DSH 0.2.x): the OpenCode Go x-opencode-session header is supplied by
# the repo-owned config/OpenCode-SessionHeader.cjs plugin on the supported
# `llm-pi-ai/request-headers` waterfall (data/cordis.patch.yml row
# nexus-opencode-session-header). No provider-adapter bundle is edited; any
# legacy in-place substrate edit disappears with the replaced node_modules.

# data/cordis.patch.yml is managed by the installer. Seed the static Nexus
# composition and its plugin modules first (Install-NexusPresets.ps1 below
# regenerates the complete layer and verifies it on the real DSH runtime).
# Relative plugin names in the home patch resolve against $DSH_HOME.
Copy-Item -LiteralPath (Join-Path $layout.Config 'home.cordis.patch.yml') -Destination (Join-Path $layout.Data 'cordis.patch.yml') -Force
Copy-Item -LiteralPath (Join-Path $layout.Config 'Routing-Integrity.cjs') -Destination (Join-Path $layout.Data 'Routing-Integrity.cjs') -Force
Copy-Item -LiteralPath (Join-Path $layout.Config 'OpenCode-SessionHeader.cjs') -Destination (Join-Path $layout.Data 'OpenCode-SessionHeader.cjs') -Force

# Supported-plugin Nexus UI (no upstream bundle patching on DSH 0.2.x).
& (Join-Path $layout.Scripts 'Install-NexusUi.ps1') -InstallRoot $InstallRoot -SourceRoot $InstallRoot

# The three Nexus agent planes (engineering, deepseek, muse): closures, the
# generated home patch, and verification against the real DSH composition.
& (Join-Path $layout.Scripts 'Install-NexusPresets.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { throw 'The Nexus agent planes could not be installed.' }

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $layout.Credentials) | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $layout.RoutingData 'states') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $layout.CompletionData 'records') | Out-Null
New-Item -ItemType Directory -Force -Path $layout.EvaluationData | Out-Null
# Restrictive permissions on the private state tree: Windows ACL behavior is
# unchanged; Linux applies the deterministic 0700/0600 plan.
Protect-AihPrivatePath -Path $layout.Data
