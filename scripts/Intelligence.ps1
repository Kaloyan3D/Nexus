[CmdletBinding()]
param()

# ── Nexus Intelligence: Repository Foundation (Phase 3.1) + ─────────────────
# ── Deterministic Code Intelligence (Phase 3.2) ─────────────────────────────
# Aggregator. Dot-source this single script to load the complete intelligence
# foundation in dependency order. Later phases (graph/live/retrieval/memory/
# context) must NOT be added here before their phases exist.

. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'intelligence/Intelligence.Common.ps1')
. (Join-Path $PSScriptRoot 'intelligence/Intelligence.Store.ps1')
. (Join-Path $PSScriptRoot 'intelligence/Intelligence.Events.ps1')
. (Join-Path $PSScriptRoot 'intelligence/Intelligence.Git.ps1')
. (Join-Path $PSScriptRoot 'intelligence/Intelligence.Registry.ps1')
. (Join-Path $PSScriptRoot 'intelligence/Intelligence.Scanning.ps1')
. (Join-Path $PSScriptRoot 'intelligence/Intelligence.Modules.ps1')
. (Join-Path $PSScriptRoot 'intelligence/Intelligence.Snapshots.ps1')
. (Join-Path $PSScriptRoot 'intelligence/Intelligence.Languages.ps1')
. (Join-Path $PSScriptRoot 'intelligence/Intelligence.CodeStore.ps1')
. (Join-Path $PSScriptRoot 'intelligence/Intelligence.CodeProviders.ps1')
. (Join-Path $PSScriptRoot 'intelligence/Intelligence.CodeIndex.ps1')
. (Join-Path $PSScriptRoot 'intelligence/Intelligence.Services.ps1')
