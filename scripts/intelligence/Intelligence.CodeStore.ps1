Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Phase 3.2A: CodeIntelligenceStore abstraction (hardening Fix 1) ──────────
# High-cardinality intelligence data (file intelligence, symbols, occurrences,
# imports, exports, snapshot mappings) MUST NOT live in whole-document JSON
# files that get rewritten on every change. The default implementation is a
# content-addressed store:
#   file-intelligence/<ab>/<fileIntelligenceId>.json   one immutable doc per
#       (contentHash, provider, providerVersion, schema) - changing one source
#       file writes exactly one new document; nothing else is rewritten.
#
# Snapshot rows (Phase 3.2 quality-gate remediation) are generational so that
# crash recovery and re-indexing are transactional and readers never observe
# partial or inactive snapshots:
#   snapshots/<repoId>/<snapId>/state.json             atomic activation header
#       (written last; names the activated generation)
#   snapshots/<repoId>/<snapId>/generations/<genId>/   immutable activated rows
#       mapping.jsonl / symbol-index.jsonl / ref-index.jsonl
#   snapshots/<repoId>/<snapId>/staging/<genId>/       in-flight rows, never read
# A retry reconciles abandoned staging data and unreferenced generations
# instead of appending duplicate rows; a -Force rebuild swaps activation only
# after the replacement generation is complete and retains the previously
# activated generation on any failure. Legacy layouts (rows beside an
# activated state.json) remain readable through the same activation gate.
# Every persisted path is validated (prefixed ids, file-name allowlist, root
# containment) before any read or write. Deletion by snapshot scope = delete
# the snapshot directory. The store is replaceable via
# Set-AihCodeIntelligenceStore.

$script:AihCodeIntelligenceStore = $null                # explicit override (DI seam)
$script:AihCodeIntelligenceStoresByRoot = @{}           # per-store-root cache
$script:AihCodeSnapshotRowFiles = @('mapping.jsonl', 'symbol-index.jsonl', 'ref-index.jsonl')
$script:AihCodeStoreSegmentPattern = '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
$script:AihCodeStoreFileIntelligenceIdPattern = '^cfi_[0-9a-f]{24}$'

function Get-AihCodeIntelligenceId {
    # Identity-derived: (contentHash, provider, providerVersion, schema).
    param(
        [Parameter(Mandatory = $true)][string]$ContentHash,
        [Parameter(Mandatory = $true)][string]$ProviderId,
        [Parameter(Mandatory = $true)][string]$ProviderVersion
    )
    return New-AihDeterministicId 'cfi' ("v1|" + $ContentHash + "|" + $ProviderId + "|" + $ProviderVersion)
}

function Test-AihCodeStoreSegment {
    # One path segment inside the content-addressed store. Segments that could
    # traverse (empty, '.', '..', separators, drive letters) never validate.
    param([Parameter(Mandatory = $true)][AllowNull()]$Value)
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return $false }
    if ($text.Contains('/') -or $text.Contains('\') -or $text.Contains(':')) { return $false }
    if ($text.Contains('..')) { return $false }
    return ($text -match $script:AihCodeStoreSegmentPattern)
}

function Test-AihCodeStorePrefixedId {
    # Prefixed, identity-shaped store id (repo_/snap_). The body must be a
    # plain identifier segment; traversal-shaped input is rejected.
    param([Parameter(Mandatory = $true)][AllowNull()]$Value, [Parameter(Mandatory = $true)][ValidateSet('repo_', 'snap_')][string]$Prefix)
    $text = [string]$Value
    if (-not $text.StartsWith($Prefix, [StringComparison]::Ordinal)) { return $false }
    $body = $text.Substring($Prefix.Length)
    if ([string]::IsNullOrWhiteSpace($body)) { return $false }
    if ($body -match '[/\\:]') { return $false }
    if ($body -match '\.\.') { return $false }
    return ($body -match '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
}

function Test-AihCodeStoreFileIntelligenceId {
    # File intelligence ids are content-derived ('cfi_' + 24 hex).
    param([Parameter(Mandatory = $true)][AllowNull()]$Value)
    return ([string]$Value -match $script:AihCodeStoreFileIntelligenceIdPattern)
}

function Resolve-AihCodeStoreSnapshotDirectory {
    # Containment-enforced snapshot directory. Throws on traversal-shaped ids.
    param(
        [Parameter(Mandatory = $true)][string]$SnapDir,
        [Parameter(Mandatory = $true)][AllowNull()]$RepositoryId,
        [Parameter(Mandatory = $true)][AllowNull()]$SnapshotId
    )
    $repo = [string]$RepositoryId
    $snap = [string]$SnapshotId
    if (-not (Test-AihCodeStorePrefixedId -Value $repo -Prefix 'repo_')) { throw "Repository id rejected by the code intelligence store: '$repo'" }
    if (-not (Test-AihCodeStorePrefixedId -Value $snap -Prefix 'snap_')) { throw "Snapshot id rejected by the code intelligence store: '$snap'" }
    $root = [IO.Path]::GetFullPath($SnapDir)
    $dir = [IO.Path]::GetFullPath((Join-Path (Join-Path $root $repo) $snap))
    if (-not (Test-AihPathInsideRoot -Root $root -FullPath $dir)) { throw "Snapshot path escapes the code intelligence store: $dir" }
    return $dir
}

function Resolve-AihCodeStoreSnapshotFile {
    # Containment-enforced file path under a directory, optionally restricted
    # to an explicit allowlist of store-owned file names.
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][AllowNull()]$FileName,
        [string[]]$AllowList = $null
    )
    $name = [string]$FileName
    if ($null -ne $AllowList -and $name -notin $AllowList) { throw "File name rejected by the code intelligence store: '$name'" }
    if (-not (Test-AihCodeStoreSegment -Value $name)) { throw "Path segment rejected by the code intelligence store: '$name'" }
    $base = [IO.Path]::GetFullPath($Directory)
    $path = [IO.Path]::GetFullPath((Join-Path $base $name))
    if (-not (Test-AihPathInsideRoot -Root $base -FullPath $path)) { throw "Store path escapes its snapshot directory: $path" }
    return $path
}

function Resolve-AihCodeStoreSubDirectory {
    # Containment-enforced subdirectory (staging/generations/genId) path.
    param([Parameter(Mandatory = $true)][string]$Directory, [Parameter(Mandatory = $true)][AllowNull()]$Name)
    return (Resolve-AihCodeStoreSnapshotFile -Directory $Directory -FileName ([string]$Name))
}

function Reconcile-AihCodeStoreSnapshotStaging {
    # Crash recovery: staging data and generations that no activated state
    # refers to are discarded, never read and never appended to. Activated
    # generations are always preserved.
    param([Parameter(Mandatory = $true)][string]$SnapPath)
    $stagingRoot = Join-Path $SnapPath 'staging'
    if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
    $statePath = Join-Path $SnapPath 'state.json'
    $active = $null
    if (Test-Path -LiteralPath $statePath) {
        try {
            $state = Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json
            if ($null -ne $state -and $state.PSObject.Properties['activeGeneration']) { $active = [string]$state.activeGeneration }
        } catch { $active = $null }
    }
    $generationsRoot = Join-Path $SnapPath 'generations'
    if (Test-Path -LiteralPath $generationsRoot) {
        foreach ($generationDir in @(Get-ChildItem -LiteralPath $generationsRoot -Directory)) {
            if ([string]$generationDir.Name -ne $active) { Remove-Item -LiteralPath $generationDir.FullName -Recurse -Force }
        }
    }
}

function Resolve-AihCodeStoreRowsPath {
    # Row-segment resolution under the activation gate: rows are readable ONLY
    # from the generation named by an activated state.json (or from the legacy
    # beside-state layout for stores activated before generations existed).
    # Unactivated snapshots expose no rows at all.
    param(
        [Parameter(Mandatory = $true)][string]$SnapPath,
        [Parameter(Mandatory = $true)][AllowNull()]$FileName
    )
    $fileName = [string]$FileName
    if ($fileName -notin $script:AihCodeSnapshotRowFiles) { throw "File name rejected by the code intelligence store: '$fileName'" }
    $statePath = Join-Path $SnapPath 'state.json'
    if (-not (Test-Path -LiteralPath $statePath)) { return $null }
    $state = Read-AihIntStoreJson -Path $statePath -Factory { [pscustomobject]@{ schemaVersion = 1 } }
    $generation = $null
    if ($state.PSObject.Properties['activeGeneration']) { $generation = [string]$state.activeGeneration }
    if (-not [string]::IsNullOrWhiteSpace($generation)) {
        if (-not (Test-AihCodeStoreSegment -Value $generation)) { throw "Activated generation id rejected by the code intelligence store: '$generation'" }
        $generationsRoot = Resolve-AihCodeStoreSubDirectory -Directory $SnapPath -Name 'generations'
        $generationDir = Resolve-AihCodeStoreSubDirectory -Directory $generationsRoot -Name $generation
        return (Resolve-AihCodeStoreSnapshotFile -Directory $generationDir -FileName $fileName -AllowList $script:AihCodeSnapshotRowFiles)
    }
    return (Resolve-AihCodeStoreSnapshotFile -Directory $SnapPath -FileName $fileName -AllowList $script:AihCodeSnapshotRowFiles)
}

function New-AihContentAddressedCodeStore {
    param([Parameter(Mandatory = $true)][string]$StoreRoot)
    $root = [IO.Path]::GetFullPath((Join-Path $StoreRoot 'code-intelligence'))
    $fiDir = Join-Path $root 'file-intelligence'
    $snapDir = Join-Path $root 'snapshots'
    # Shared mutable map of in-flight staging generations per snapshot. The
    # hashtable instance is captured by every method closure below, so the
    # three AppendSnapshotRows calls of one index run land in ONE generation.
    $stagingBySnapshot = @{}
    # Closure-captured allowlist: GetNewClosure() captures local variables,
    # not $script: scoped ones, so the row-file allowlist must be local here.
    $snapshotRowFiles = $script:AihCodeSnapshotRowFiles

    $self = [pscustomobject][ordered]@{
        Name          = 'content-addressed-v1'
        StoreRoot     = $StoreRoot
        Root          = $root
    }

    $self | Add-Member -NotePropertyName GetFileIntelligence -NotePropertyValue {
        param($contentHash, $providerId, $providerVersion)
        $id = Get-AihCodeIntelligenceId -ContentHash $contentHash -ProviderId $providerId -ProviderVersion $providerVersion
        return (& $self.GetFileIntelligenceById $id)
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName ContainsFileIntelligence -NotePropertyValue {
        param($fileIntelligenceId)
        if (-not (Test-AihCodeStoreFileIntelligenceId -Value $fileIntelligenceId)) { throw "File intelligence id rejected by the code intelligence store: '$fileIntelligenceId'" }
        $path = Resolve-AihCodeStoreSnapshotFile -Directory $fiDir -FileName ([string]$fileIntelligenceId + '.json')
        return (Test-Path -LiteralPath $path)
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName GetFileIntelligenceById -NotePropertyValue {
        param($fileIntelligenceId)
        if (-not (Test-AihCodeStoreFileIntelligenceId -Value $fileIntelligenceId)) { throw "File intelligence id rejected by the code intelligence store: '$fileIntelligenceId'" }
        # shard on the hash body (after the 'cfi_' prefix), not the constant prefix
        $shard = Resolve-AihCodeStoreSnapshotFile -Directory $fiDir -FileName ([string]$fileIntelligenceId.Substring(4, 2))
        $path = Resolve-AihCodeStoreSnapshotFile -Directory $shard -FileName ([string]$fileIntelligenceId + '.json')
        if (-not (Test-Path -LiteralPath $path)) { return $null }
        return (Read-AihIntStoreJson -Path $path -Factory { [pscustomobject]@{ schemaVersion = 1 } })
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName PutFileIntelligence -NotePropertyValue {
        # Writes exactly ONE document. No other intelligence record is touched.
        param($document)
        $id = [string]$document.fileIntelligenceId
        if (-not (Test-AihCodeStoreFileIntelligenceId -Value $id)) { throw "File intelligence id rejected by the code intelligence store: '$id'" }
        $dir = Resolve-AihCodeStoreSnapshotFile -Directory $fiDir -FileName $id.Substring(4, 2)
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $path = Resolve-AihCodeStoreSnapshotFile -Directory $dir -FileName ($id + '.json')
        Save-AihIntStoreJson -Path $path -Document $document
        return $document
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName CountFileIntelligence -NotePropertyValue {
        if (-not (Test-Path -LiteralPath $fiDir)) { return 0 }
        return @(Get-ChildItem -LiteralPath $fiDir -Recurse -File -Filter '*.json').Count
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName DeleteSnapshotIntelligence -NotePropertyValue {
        param($repositoryId, $snapshotId)
        $dir = Resolve-AihCodeStoreSnapshotDirectory -SnapDir $snapDir -RepositoryId $repositoryId -SnapshotId $snapshotId
        if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force; return $true }
        return $false
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName PutSnapshotState -NotePropertyValue {
        # Transactional activation (last write): the staged generation becomes
        # the activated generation BEFORE the atomic state write, so readers
        # resolve only complete rows through the activation header.
        param($repositoryId, $snapshotId, $state)
        $snapPath = Resolve-AihCodeStoreSnapshotDirectory -SnapDir $snapDir -RepositoryId $repositoryId -SnapshotId $snapshotId
        $key = "$repositoryId|$snapshotId"
        $generation = $null
        if ($stagingBySnapshot.ContainsKey($key)) { $generation = [string]$stagingBySnapshot[$key] }
        if (-not [string]::IsNullOrWhiteSpace($generation)) {
            $stagingRoot = Resolve-AihCodeStoreSubDirectory -Directory $snapPath -Name 'staging'
            $stagingDir = Resolve-AihCodeStoreSubDirectory -Directory $stagingRoot -Name $generation
            $generationsRoot = Resolve-AihCodeStoreSubDirectory -Directory $snapPath -Name 'generations'
            New-Item -ItemType Directory -Force -Path $generationsRoot | Out-Null
            $targetDir = Resolve-AihCodeStoreSubDirectory -Directory $generationsRoot -Name $generation
            if (Test-Path -LiteralPath $targetDir) { throw "Activated generation already exists: $generation" }
            if (Test-Path -LiteralPath $stagingDir) { Move-Item -LiteralPath $stagingDir -Destination $targetDir }
            $null = $stagingBySnapshot.Remove($key)
            if (-not ($state.PSObject.Properties['activeGeneration'])) {
                $state | Add-Member -NotePropertyName activeGeneration -NotePropertyValue $generation
            } else {
                $state.activeGeneration = $generation
            }
        }
        # Atomic activation of the snapshot intelligence state (last write).
        $statePath = Resolve-AihCodeStoreSnapshotFile -Directory $snapPath -FileName 'state.json'
        Save-AihIntStoreJson -Path $statePath -Document $state
        return $state
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName GetSnapshotState -NotePropertyValue {
        param($repositoryId, $snapshotId)
        $snapPath = Resolve-AihCodeStoreSnapshotDirectory -SnapDir $snapDir -RepositoryId $repositoryId -SnapshotId $snapshotId
        $path = Join-Path $snapPath 'state.json'
        if (-not (Test-Path -LiteralPath $path)) { return $null }
        return (Read-AihIntStoreJson -Path $path -Factory { [pscustomobject]@{ schemaVersion = 1 } })
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName AppendSnapshotRows -NotePropertyValue {
        # Staged, batched JSONL write: all rows of one call are written in a
        # single pass into the snapshot's open staging generation. Rows become
        # readable only through the later activation. A new staging sequence
        # reconciles (discards) abandoned staging data and unreferenced
        # generations from a crashed run, so a normal retry never appends
        # duplicate rows.
        param($repositoryId, $snapshotId, $fileName, $rows)
        $snapPath = Resolve-AihCodeStoreSnapshotDirectory -SnapDir $snapDir -RepositoryId $repositoryId -SnapshotId $snapshotId
        $name = [string]$fileName
        if ($name -notin $snapshotRowFiles) { throw "File name rejected by the code intelligence store: '$name'" }
        $key = "$repositoryId|$snapshotId"
        if (-not $stagingBySnapshot.ContainsKey($key)) {
            Reconcile-AihCodeStoreSnapshotStaging -SnapPath $snapPath
            $generation = 'gen-' + [guid]::NewGuid().ToString('N')
            $stagingBySnapshot[$key] = $generation
            $stagingRoot = Resolve-AihCodeStoreSubDirectory -Directory $snapPath -Name 'staging'
            New-Item -ItemType Directory -Force -Path (Resolve-AihCodeStoreSubDirectory -Directory $stagingRoot -Name $generation) | Out-Null
        }
        $generation = [string]$stagingBySnapshot[$key]
        $stagingRoot = Resolve-AihCodeStoreSubDirectory -Directory $snapPath -Name 'staging'
        $stagingDir = Resolve-AihCodeStoreSubDirectory -Directory $stagingRoot -Name $generation
        $stagingFile = Resolve-AihCodeStoreSnapshotFile -Directory $stagingDir -FileName $name -AllowList $snapshotRowFiles
        $lines = [System.Collections.Generic.List[string]]::new()
        foreach ($row in @($rows)) {
            if ($null -eq $row) { continue }
            $lines.Add((ConvertTo-Json -InputObject (ConvertTo-AihJsonSafe $row) -Depth 20 -Compress))
        }
        if ($lines.Count -gt 0) {
            New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null
            [IO.File]::WriteAllLines($stagingFile, $lines, [Text.UTF8Encoding]::new($false))
        }
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName ReadSnapshotRows -NotePropertyValue {
        # Activation-gated reader over one JSONL segment; corrupt lines are
        # skipped, corrupt state fails closed. Parsing is a single streaming
        # pass accumulated linearly (never quadratic).
        param($repositoryId, $snapshotId, $fileName)
        $snapPath = Resolve-AihCodeStoreSnapshotDirectory -SnapDir $snapDir -RepositoryId $repositoryId -SnapshotId $snapshotId
        $rowsPath = Resolve-AihCodeStoreRowsPath -SnapPath $snapPath -FileName ([string]$fileName)
        if ($null -eq $rowsPath) { return @() }
        if (-not (Test-Path -LiteralPath $rowsPath)) { return @() }
        $rows = [System.Collections.Generic.List[object]]::new()
        $reader = [IO.StreamReader]::new($rowsPath, [Text.UTF8Encoding]::new($false))
        try {
            while ($true) {
                $line = $reader.ReadLine()
                if ($null -eq $line) { break }
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                try { $parsed = $line | ConvertFrom-Json } catch { continue }
                if ($null -ne $parsed) { $rows.Add($parsed) }
            }
        } finally { $reader.Close() }
        return $rows.ToArray()
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName StreamSnapshotRows -NotePropertyValue {
        # Streaming query path: rows are parsed one at a time and handed to the
        # caller's callback; the caller decides what to keep, so queries never
        # materialize the whole segment. Returns the streamed row count.
        param($repositoryId, $snapshotId, $fileName, $onRow)
        $snapPath = Resolve-AihCodeStoreSnapshotDirectory -SnapDir $snapDir -RepositoryId $repositoryId -SnapshotId $snapshotId
        $rowsPath = Resolve-AihCodeStoreRowsPath -SnapPath $snapPath -FileName ([string]$fileName)
        if ($null -eq $rowsPath) { return 0 }
        if (-not (Test-Path -LiteralPath $rowsPath)) { return 0 }
        $count = 0
        $reader = [IO.StreamReader]::new($rowsPath, [Text.UTF8Encoding]::new($false))
        try {
            while ($true) {
                $line = $reader.ReadLine()
                if ($null -eq $line) { break }
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                try { $parsed = $line | ConvertFrom-Json } catch { continue }
                if ($null -eq $parsed) { continue }
                $count = $count + 1
                & $onRow $parsed
            }
        } finally { $reader.Close() }
        return $count
    }.GetNewClosure()

    $self | Add-Member -NotePropertyName SnapshotIntelligenceDir -NotePropertyValue {
        param($repositoryId, $snapshotId)
        return (Resolve-AihCodeStoreSnapshotDirectory -SnapDir $snapDir -RepositoryId $repositoryId -SnapshotId $snapshotId)
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