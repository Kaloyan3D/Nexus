[CmdletBinding()]
param()

# ── Nexus Intelligence: Repository Foundation (Phase 3.1) ────────────────────
# Aggregator. Dot-source this single script to load the complete Phase 3.1
# foundation in dependency order. Later phases (code/graph/live/retrieval/
# memory/context) must NOT be added here before their phases exist.

. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'intelligence\Intelligence.Common.ps1')
. (Join-Path $PSScriptRoot 'intelligence\Intelligence.Store.ps1')
. (Join-Path $PSScriptRoot 'intelligence\Intelligence.Events.ps1')
. (Join-Path $PSScriptRoot 'intelligence\Intelligence.Git.ps1')
. (Join-Path $PSScriptRoot 'intelligence\Intelligence.Registry.ps1')
. (Join-Path $PSScriptRoot 'intelligence\Intelligence.Scanning.ps1')
. (Join-Path $PSScriptRoot 'intelligence\Intelligence.Modules.ps1')
. (Join-Path $PSScriptRoot 'intelligence\Intelligence.Snapshots.ps1')
. (Join-Path $PSScriptRoot 'intelligence\Intelligence.Services.ps1')
