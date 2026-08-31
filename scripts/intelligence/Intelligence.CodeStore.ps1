Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Phase 3.2A: CodeIntelligenceStore abstraction (hardening Fix 1) ──────────
# High-cardinality intelligence data (file intelligence, symbols, occurrences,
# imports, exports, snapshot mappings) MUST NOT live in whole-document JSON
# files that get rewritten on every change. The default implementation is a
# content-addressed store:
#   file-intelligence/<ab>/<fileIntelligenceId>.json   one immutable doc per
#       (contentHash, provider, providerVersion, schema) — changing one source
#       file writes exactly one new document; nothing else is rewritten.
#   snapshots/<repoId>/<snapId>/mapping.jsonl          append-only rows
#   snapshots/<repoId>/<snapId>/symbol-index.jsonl     append-only rows
#   snapshots/<repoId>/<snapId>/ref-index.jsonl        append-only rows
#   snapshots/<repoId>/<snapId>/state.json             atomic activation state
# Deletion by snapshot scope = delete the snapshot directory. Iteration =
# streaming over JSONL. The store is replaceable via Set-AihCodeIntelligenceStore.

$script:AihCodeIntelligenceStore = $null                # explicit override (DI seam)
$script:AihCodeIntelligenceStoresByRoot = @{}           # per-store-root cache

function Get-AihCodeIntelligenceId {
    # Identity-derived: (contentHash, provider, providerVersion, schema).
    param(
        [Parameter(Mandatory = $true)][string]$ContentHash,
        [Parameter(Mandatory = $true)][string]$ProviderId,
        [Parameter(Mandatory = $true)][string]$ProviderVersion
    )
    return New-AihDeterministicId 'cfi' ("v1|" + $ContentHash + "|" + $ProviderId + "|" + $ProviderVersion)
}

function New-AihContentAddressedCodeStore {
    param([Parameter(Mandatory = $true)][string]$StoreRoot)
    $root = Join-Path $StoreRoot 'code-intelligence'
    $fiDir = Join-Path $root 'file-intelligence'
    $snapDir = Join-Path $root 'snapshots'

    $self = [pscustomobject][ordered]@{
        Name          = 'content-addressed-v1'
        StoreRoot     = $StoreRoot
        Root          = $root
    }

    $self | Add-Member -NotePropertyName GetFileIntelligence -NotePropertyValue {
        param($contentHash, $providerId, $providerVersion)
        $id = Get-AihCodeIntelligenceId -ContentHash $contentHash -ProviderId $providerId -ProviderVersion $providerVersion
        # shard on the hash body (after the 'cfi_' prefix), not the constant prefix
        $path = Join-Path $fiDir ($id.Substring(4, 2))
        $path = Join-Path $path ($id + '.json')
        if (-not (Test-Path -LiteralPath $path)) { return $null }
        return (Read-AihIntStoreJson -Path $path -Factory { [pscustomobject]@{ schemaVersion = 1 } })
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName ContainsFileIntelligence -NotePropertyValue {
        param($fileIntelligenceId)
        $path = Join-Path $fiDir ($fileIntelligenceId.Substring(4, 2))
        return (Test-Path -LiteralPath (Join-Path $path ($fileIntelligenceId + '.json')))
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName GetFileIntelligenceById -NotePropertyValue {
        param($fileIntelligenceId)
        $path = Join-Path $fiDir ($fileIntelligenceId.Substring(4, 2))
        $path = Join-Path $path ($fileIntelligenceId + '.json')
        if (-not (Test-Path -LiteralPath $path)) { return $null }
        return (Read-AihIntStoreJson -Path $path -Factory { [pscustomobject]@{ schemaVersion = 1 } })
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName PutFileIntelligence -NotePropertyValue {
        # Writes exactly ONE document. No other intelligence record is touched.
        param($document)
        $id = $document.fileIntelligenceId
        $dir = Join-Path $fiDir ($id.Substring(4, 2))
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Save-AihIntStoreJson -Path (Join-Path $dir ($id + '.json')) -Document $document
        return $document
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName CountFileIntelligence -NotePropertyValue {
        if (-not (Test-Path -LiteralPath $fiDir)) { return 0 }
        return @(Get-ChildItem -LiteralPath $fiDir -Recurse -File -Filter '*.json').Count
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName DeleteSnapshotIntelligence -NotePropertyValue {
        param($repositoryId, $snapshotId)
        $dir = Join-Path (Join-Path $snapDir $repositoryId) $snapshotId
        if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force; return $true }
        return $false
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName PutSnapshotState -NotePropertyValue {
        # Atomic activation of the snapshot intelligence state (last write).
        param($repositoryId, $snapshotId, $state)
        $dir = Join-Path (Join-Path $snapDir $repositoryId) $snapshotId
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Save-AihIntStoreJson -Path (Join-Path $dir 'state.json') -Document $state
        return $state
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName GetSnapshotState -NotePropertyValue {
        param($repositoryId, $snapshotId)
        $path = Join-Path (Join-Path (Join-Path $snapDir $repositoryId) $snapshotId) 'state.json'
        if (-not (Test-Path -LiteralPath $path)) { return $null }
        return (Read-AihIntStoreJson -Path $path -Factory { [pscustomobject]@{ schemaVersion = 1 } })
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName AppendSnapshotRows -NotePropertyValue {
        # Incremental append (JSONL): never rewrites previously written rows.
        param($repositoryId, $snapshotId, $fileName, $rows)
        $dir = Join-Path (Join-Path $snapDir $repositoryId) $snapshotId
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        foreach ($row in @($rows)) {
            Add-AihJsonLine -Path (Join-Path $dir $fileName) -Value $row
        }
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName ReadSnapshotRows -NotePropertyValue {
        # Streaming-friendly reader over one JSONL segment; corrupt lines skipped.
        param($repositoryId, $snapshotId, $fileName)
        $path = Join-Path (Join-Path (Join-Path $snapDir $repositoryId) $snapshotId) $fileName
        if (-not (Test-Path -LiteralPath $path)) { return @() }
        $rows = @()
        foreach ($line in (Get-Content -Encoding UTF8 -LiteralPath $path)) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try { $parsed = $line | ConvertFrom-Json } catch { continue }
            if ($null -ne $parsed) { $rows = @($rows) + @($parsed) }
        }
        return $rows
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName SnapshotIntelligenceDir -NotePropertyValue {
        param($repositoryId, $snapshotId)
        return (Join-Path (Join-Path $snapDir $repositoryId) $snapshotId)
    }.GetNewClosure()

    return $self
}

function Get-AihCodeIntelligenceStore {
    # Returns the store for one intelligence store root (isolated per root),
    # unless an explicit store was installed via Set-AihCodeIntelligenceStore.
    param([string]$StoreRoot)
    if ($null -ne $script:AihCodeIntelligenceStore) { return $script:AihCodeIntelligenceStore }
    $root = Get-AihIntelligenceStoreRoot $StoreRoot
    if (-not $script:AihCodeIntelligenceStoresByRoot.ContainsKey($root)) {
        $script:AihCodeIntelligenceStoresByRoot[$root] = New-AihContentAddressedCodeStore -StoreRoot $root
    }
    return $script:AihCodeIntelligenceStoresByRoot[$root]
}

function Set-AihCodeIntelligenceStore {
    # Replaceable storage seam (tests / future SQLite-backed implementation).
    param([Parameter(Mandatory = $true)]$Store)
    $script:AihCodeIntelligenceStore = $Store
}

function Reset-AihCodeIntelligenceStore {
    $script:AihCodeIntelligenceStore = $null
    $script:AihCodeIntelligenceStoresByRoot = @{}
}

# ── FileIntelligence model ──────────────────────────────────────────────────

function New-AihFileIntelligenceDocument {
    param(
        [Parameter(Mandatory = $true)][string]$ContentHash,
        [Parameter(Mandatory = $true)][string]$Language,
        [Parameter(Mandatory = $true)][string]$ProviderId,
        [Parameter(Mandatory = $true)][string]$ProviderVersion,
        [Parameter(Mandatory = $true)][ValidateSet('ready', 'failed', 'unsupported')][string]$Status,
        $Symbols = @(),
        $Imports = @(),
        $Exports = @(),
        $Occurrences = @(),
        $Diagnostics = @()
    )
    $id = Get-AihCodeIntelligenceId -ContentHash $ContentHash -ProviderId $ProviderId -ProviderVersion $ProviderVersion
    return [pscustomobject][ordered]@{
        schemaVersion       = 1
        fileIntelligenceId  = $id
        contentHash         = $ContentHash
        language            = $Language
        providerId          = $ProviderId
        providerVersion     = $ProviderVersion
        status              = $Status
        createdAt           = [DateTime]::UtcNow.ToString('o')
        symbols             = @($Symbols)
        imports             = @($Imports)
        exports             = @($Exports)
        occurrences         = @($Occurrences)
        diagnostics         = @($Diagnostics)
    }
}

function New-AihParsedSymbol {
    # Parsed symbol record identity: identity-derived from the immutable
    # content (fileIntelligenceId) + kind + qualifiedName + signature +
    # container. Never line-number-only, never repository-global.
    param(
        [Parameter(Mandatory = $true)][string]$FileIntelligenceId,
        [Parameter(Mandatory = $true)][string]$Kind,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$QualifiedName,
        [string]$Signature = '',
        [string]$Container = '',
        [int]$StartLine = 0,
        [int]$StartColumn = 0,
        [int]$EndLine = 0,
        [int]$EndColumn = 0,
        [string]$Visibility = '',
        [bool]$Exported = $false
    )
    $sid = New-AihDeterministicId 'sym' ($FileIntelligenceId + '|' + $Kind + '|' + $QualifiedName + '|' + $Signature + '|' + $Container)
    return [pscustomobject][ordered]@{
        sid           = $sid
        kind          = $Kind
        name          = $Name
        qualifiedName = $QualifiedName
        signature     = $Signature
        container     = $Container
        startLine     = $StartLine
        startColumn   = $StartColumn
        endLine       = $EndLine
        endColumn     = $EndColumn
        visibility    = $Visibility
        exported      = $Exported
    }
}

function New-AihParsedOccurrence {
    param(
        [Parameter(Mandatory = $true)][string]$FileIntelligenceId,
        [Parameter(Mandatory = $true)][ValidateSet('definition', 'reference', 'call', 'import', 'export')][string]$Role,
        [Parameter(Mandatory = $true)][string]$Name,
        [int]$Line = 0,
        [int]$Column = 0,
        [string]$Resolution = 'unresolved',
        [string]$ResolvedTargetId = ''
    )
    $oid = New-AihDeterministicId 'occ' ($FileIntelligenceId + '|' + $Role + '|' + $Line + '|' + $Column + '|' + $Name)
    return [pscustomobject][ordered]@{
        oid              = $oid
        role             = $Role
        name             = $Name
        line             = $Line
        column           = $Column
        resolution       = $Resolution
        resolvedTargetId = $ResolvedTargetId
    }
}
