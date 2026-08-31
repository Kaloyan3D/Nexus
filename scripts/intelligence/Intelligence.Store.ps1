Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Intelligence storage layer ───────────────────────────────────────────────
# Mutable JSON snapshots are written atomically; histories are JSONL. Domain
# services must go through these functions (or their sibling domain functions)
# and never construct store paths themselves. This module is internal to the
# Repository Foundation and is not part of the public Phase 3.1 API.

function New-AihIntWorkspacesDocument {
    [pscustomobject]@{ schemaVersion = 1; workspaces = @(); links = @() }
}

function New-AihIntRepositoriesDocument {
    # repositories: logical repositories. configs: repository_configs rows, one
    # per repository (effective Phase 3.1 configuration; array survives JSON
    # round-trips under StrictMode).
    [pscustomobject]@{ schemaVersion = 1; repositories = @(); configs = @() }
}

function Get-AihIntRepositoryConfig {
    param([Parameter(Mandatory = $true)]$Document, [Parameter(Mandatory = $true)][string]$RepositoryId)
    return @($Document.configs | Where-Object { "$($_.repositoryId)" -eq $RepositoryId } | Select-Object -First 1)
}

function Set-AihIntRepositoryConfig {
    param(
        [Parameter(Mandatory = $true)]$Document,
        [Parameter(Mandatory = $true)][string]$RepositoryId,
        [Parameter(Mandatory = $true)]$Config
    )
    $rows = @($Document.configs | Where-Object { "$($_.repositoryId)" -ne $RepositoryId })
    $Document.configs = @($rows) + @($Config)
}

function New-AihIntCheckoutsDocument {
    [pscustomobject]@{ schemaVersion = 1; checkouts = @() }
}

function New-AihIntFileObjectsDocument {
    # file_objects: content-addressed identity registry (hash -> metadata).
    # Source bytes are intentionally not stored here.
    [pscustomobject]@{ schemaVersion = 1; objects = @() }
}

function Read-AihIntStoreJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][scriptblock]$Factory
    )
    if (-not (Test-Path -LiteralPath $Path)) { return & $Factory }
    try {
        $document = Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json
    } catch {
        throw "Intelligence store document is invalid: $Path"
    }
    if ($null -eq $document) { throw "Intelligence store document is invalid: $Path" }
    if (-not ($document.PSObject.Properties['schemaVersion'])) { throw "Intelligence store document is missing schemaVersion: $Path" }
    if ([int]$document.schemaVersion -ne 1) { throw "Unsupported intelligence store schemaVersion in $Path" }
    return $document
}

function Save-AihIntStoreJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Document
    )
    Write-AihAtomicJson -Path $Path -Value $Document -Depth 40
}

function Get-AihIntRepositoryDocument {
    param([Parameter(Mandatory = $true)][string]$StoreRoot)
    $layout = Get-AihIntelligenceLayout $StoreRoot
    return Read-AihIntStoreJson -Path $layout.Repositories -Factory { New-AihIntRepositoriesDocument }
}

function Save-AihIntRepositoryDocument {
    param([Parameter(Mandatory = $true)][string]$StoreRoot, [Parameter(Mandatory = $true)]$Document)
    $layout = Get-AihIntelligenceLayout $StoreRoot
    Save-AihIntStoreJson -Path $layout.Repositories -Document $Document
}

function Get-AihIntCheckoutDocument {
    param([Parameter(Mandatory = $true)][string]$StoreRoot)
    $layout = Get-AihIntelligenceLayout $StoreRoot
    return Read-AihIntStoreJson -Path $layout.Checkouts -Factory { New-AihIntCheckoutsDocument }
}

function Save-AihIntCheckoutDocument {
    param([Parameter(Mandatory = $true)][string]$StoreRoot, [Parameter(Mandatory = $true)]$Document)
    $layout = Get-AihIntelligenceLayout $StoreRoot
    Save-AihIntStoreJson -Path $layout.Checkouts -Document $Document
}

function Get-AihIntWorkspaceDocument {
    param([Parameter(Mandatory = $true)][string]$StoreRoot)
    $layout = Get-AihIntelligenceLayout $StoreRoot
    return Read-AihIntStoreJson -Path $layout.Workspaces -Factory { New-AihIntWorkspacesDocument }
}

function Save-AihIntWorkspaceDocument {
    param([Parameter(Mandatory = $true)][string]$StoreRoot, [Parameter(Mandatory = $true)]$Document)
    $layout = Get-AihIntelligenceLayout $StoreRoot
    Save-AihIntStoreJson -Path $layout.Workspaces -Document $Document
}

function Get-AihIntFileObjectIndex {
    # Returns a mutable state bag: contentHash -> { hash, size, firstSeenUtc }.
    param([Parameter(Mandatory = $true)][string]$StoreRoot)
    $layout = Get-AihIntelligenceLayout $StoreRoot
    $document = Read-AihIntStoreJson -Path $layout.FileObjects -Factory { New-AihIntFileObjectsDocument }
    $index = @{}
    foreach ($entry in @($document.objects)) { $index[$entry.hash] = $entry }
    return @{
        Layout  = $layout
        Index   = $index
        Persist = {
            param([hashtable]$State)
            $objects = @()
            foreach ($key in @($State.Index.Keys)) { $objects = @($objects) + @($State.Index[$key]) }
            $objects = @($objects | Sort-Object { $_.hash })
            Save-AihIntStoreJson -Path $State.Layout.FileObjects -Document ([pscustomobject]@{ schemaVersion = 1; objects = $objects })
        }
    }
}

function Add-AihIntFileObject {
    # Upserts a content-addressed object identity. Same content hash in many
    # snapshots reuses the same content identity (Phase 3.2 reuse seam).
    param(
        [Parameter(Mandatory = $true)][hashtable]$IndexState,
        [Parameter(Mandatory = $true)][string]$Hash,
        [Parameter(Mandatory = $true)][long]$Size
    )
    if (-not $IndexState.Index.ContainsKey($Hash)) {
        $IndexState.Index[$Hash] = [pscustomobject]@{ hash = $Hash; size = $Size; firstSeenUtc = [DateTime]::UtcNow.ToString('o') }
        return $true
    }
    return $false
}
